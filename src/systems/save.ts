// Saves: the game's state in IndexedDB (database 'open-city', store 'saves', one record per map and seed), versioned
// with migrations. Settings are not here: they stay in localStorage (settings.ts) and work without a save.
//
// What is kept: the player (position, facing, cash, health), the game hour, the hotbar (item uids), every item that
// differs from what the world generates (picked up, moved, dropped, paid for or stolen: its uid, type, owner and
// transform), items used up for good, and door states. Generation then consults the save, so an item has exactly one
// place: an interior shelf never restocks an item whose uid the save knows (interiors.ts), and street items are moved
// to where the save has them. Written a couple of seconds after a pickup, drop or door (TUNING.interiors.saveDebounce),
// at most every autosaveEvery seconds otherwise when something changed, on entering or leaving a building, on pause and
// when the page is hidden. Never in the frame loop's critical path: the write is an async IndexedDB put of a few kB.
//
// ?nosave=1 plays without reading or writing a save (tests that need a fresh world after a reload use it too).
import * as THREE from 'three';
import type { World } from '../world';
import { TUNING } from '../tuning';
import type { ItemId } from '../art/items';
import { ITEM_IDS } from '../art/items';
import { removeFromWorld, restItem, setDormant, spawnLazy, writeItem, type WorldItem } from './worldItems';
import { interiorAt, buildNow } from './interiors/interiors';
import { PLAN_VERSION } from './interiors/plan';
import { toast } from './hud';

const I = TUNING.interiors;
/** Current save schema. Bump it and add a migration whenever the stored shape changes. */
export const SCHEMA = 1;
const DB = 'open-city', STORE = 'saves';

export interface SavedItem {
  type: ItemId;
  /** 'world': lying at the transform; 'inv': in the hotbar */
  where: 'world' | 'inv';
  x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
  owner: string;
  stolen: boolean;
  /** the building it lies in (record id), or null */
  building: string | null;
}

export interface SaveData {
  schema: number;
  savedAt: number;
  map: string;
  seed: number;
  /** the interior plans' version these door ids and slots came from */
  planVersion: number;
  hour: number;
  player: { x: number; y: number; z: number; facing: number; cash: number; health: number; inBuilding: string | null };
  inventory: (string | null)[];
  selected: number;
  items: Record<string, SavedItem>;
  gone: string[];
  doors: Record<string, boolean>;
  nextNew: number;
}

export interface SaveState {
  enabled: boolean;
  key: string;
  db: IDBDatabase | null;
  /** what was loaded at boot (null: a fresh game) */
  loaded: SaveData | null;
  /** item uids whose saved state wins over their generated place */
  moved: Set<string>;
  /** something changed that the next write should keep */
  dirty: boolean;
  /** w.time of the next debounced write (Infinity: none due) */
  writeAt: number;
  lastWrite: number;
  writes: number;
  /** a write in flight (writes never overlap) */
  busy: boolean;
  status: string;
}

/** Schema n -> n + 1. (Schema 1 is the first; nothing to migrate yet.) */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {};

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function getRec(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function putRec(db: IDBDatabase, key: string, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Open the save for this map and seed (before the world is populated). Never throws; a failure plays unsaved. */
export async function openSave(mapId: string, seed: number): Promise<SaveState> {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const S: SaveState = {
    enabled: !params.has('nosave'), key: `auto:${mapId}:${seed}`, db: null, loaded: null, moved: new Set(), dirty: false,
    writeAt: Infinity, lastWrite: 0, writes: 0, busy: false, status: 'fresh',
  };
  if (!S.enabled) { S.status = 'off (?nosave)'; return S; }
  S.db = await openDb();
  if (!S.db) { S.enabled = false; S.status = 'unavailable (no IndexedDB)'; return S; }
  let raw: Record<string, unknown> | null = (await getRec(S.db, S.key)) as Record<string, unknown> | null;
  if (raw && typeof raw.schema === 'number') {
    if (raw.schema > SCHEMA) {
      // from a newer build: never overwrite it; play this session without saving
      S.enabled = false;
      S.status = `kept a save from a newer version (schema ${raw.schema}); playing without saving`;
      return S;
    }
    while (raw && (raw.schema as number) < SCHEMA) {
      const m: ((d: Record<string, unknown>) => Record<string, unknown>) | undefined = MIGRATIONS[raw.schema as number];
      if (!m) { raw = null; break; }
      raw = m(raw);
    }
  }
  if (raw && raw.schema === SCHEMA) {
    S.loaded = raw as unknown as SaveData;
    for (const uid of Object.keys(S.loaded.items)) S.moved.add(uid);
    for (const uid of S.loaded.gone) S.moved.add(uid);
    S.status = 'loaded';
  }
  return S;
}

const q4 = new THREE.Quaternion();
const e4 = new THREE.Euler();

/** After the items, the interiors and the player exist: put everything where the save has it. */
export function applySave(w: World): void {
  const S = w.save, d = S.loaded;
  if (!d) return;
  const IS = w.itemsState;
  for (const uid of d.gone) IS.gone.add(uid);
  IS.nextNew = Math.max(IS.nextNew, d.nextNew);
  // doors: applied when each door's interior is built (doors.ts activateDoor); dropped if the plans changed since
  if (d.planVersion === PLAN_VERSION) for (const [id, open] of Object.entries(d.doors)) w.doors.saved.set(id, open);
  // items
  for (const [uid, si] of Object.entries(d.items)) {
    if (!ITEM_IDS.includes(si.type)) continue;
    let it = IS.byUid.get(uid) ?? null;
    if (!it) {
      e4.set(0, 0, 0);
      it = spawnLazy(w, si.type, uid, si.x, si.y, si.z, 0, si.owner, null);
      if (!it) continue;
    }
    it.owner = si.owner;
    it.stolen = si.stolen;
    it.touched = true;
    if (si.where === 'inv') { if (it.inWorld) removeFromWorld(w, it); continue; }
    // lying in the world: at its transform, resting (street items keep their body, asleep there)
    it.px = si.x; it.py = si.y; it.pz = si.z; it.qx = si.qx; it.qy = si.qy; it.qz = si.qz; it.qw = si.qw;
    if (it.body && !it.lazy) {
      it.body.setTranslation({ x: si.x, y: si.y, z: si.z }, false);
      it.body.setRotation({ x: si.qx, y: si.qy, z: si.qz, w: si.qw }, false);
      it.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      it.body.sleep();
    } else if (it.body) restItem(w, it);
    // inside a building that is not built: kept as data until it is
    const inb = interiorAt(w.interiors, si.x, si.y, si.z);
    it.building = inb ? inb.rec.id : null;
    if (inb && inb.state !== 'active') setDormant(w, it, true);
    writeItem(w, it);
  }
  // the hotbar
  const inv = w.inventory;
  d.inventory.forEach((uid, i) => {
    if (i >= inv.slots.length) return;
    const it = uid ? IS.byUid.get(uid) ?? null : null;
    if (it && !it.inWorld) inv.slots[i] = it;
  });
  inv.selected = Math.min(inv.slots.length - 1, Math.max(0, d.selected | 0));
  // the player: inside a building, its interior is built before the first physics step (the floor exists first)
  const p = d.player;
  w.cash = p.cash;
  w.player.health = p.health > 0 ? p.health : 100;
  w.dayNight.hour = d.hour;
  if (p.inBuilding) { const e = w.interiors.byId.get(p.inBuilding); if (e) buildNow(w, e); }
  w.player.body.setTranslation({ x: p.x, y: p.y + 0.05, z: p.z }, true);
  w.player.body.setNextKinematicTranslation({ x: p.x, y: p.y + 0.05, z: p.z });
  w.player.facing = p.facing;
  w.player.vy = 0;
  void q4;
}

function itemRecord(it: WorldItem): SavedItem {
  if (it.inWorld && it.body) {
    const t = it.body.translation(), r = it.body.rotation();
    it.px = t.x; it.py = t.y; it.pz = t.z; it.qx = r.x; it.qy = r.y; it.qz = r.z; it.qw = r.w;
  }
  return {
    type: it.type, where: it.inWorld ? 'world' : 'inv', x: it.px, y: it.py, z: it.pz, qx: it.qx, qy: it.qy, qz: it.qz, qw: it.qw,
    owner: it.owner, stolen: it.stolen, building: it.building,
  };
}

/** The save record for the world as it is now. */
export function snapshot(w: World): SaveData {
  const IS = w.itemsState;
  const items: Record<string, SavedItem> = {};
  for (const it of IS.items) if (it.touched && !IS.gone.has(it.uid)) items[it.uid] = itemRecord(it);
  const doors: Record<string, boolean> = {};
  for (const [id, open] of w.doors.saved) if (open) doors[id] = true;
  const pl = w.player;
  const t = pl.vehicle ? pl.vehicle.body.translation() : pl.body.translation();
  const feet = pl.vehicle ? t.y + 0.5 : t.y - TUNING.player.capsuleHalfHeight - TUNING.player.capsuleRadius;
  return {
    schema: SCHEMA, savedAt: Date.now(), map: w.save.key.split(':')[1] ?? '', seed: w.seed, planVersion: PLAN_VERSION, hour: w.dayNight.hour,
    player: { x: t.x, y: feet + TUNING.player.capsuleHalfHeight + TUNING.player.capsuleRadius + 0.03, z: t.z, facing: pl.facing, cash: w.cash, health: pl.health, inBuilding: pl.vehicle ? null : w.interiors.inside?.rec.id ?? null },
    inventory: w.inventory.slots.map((s) => (s ? s.uid : null)), selected: w.inventory.selected,
    items, gone: [...IS.gone], doors, nextNew: IS.nextNew,
  };
}

/** Write now (async). Resolves true when IndexedDB has it. */
export async function writeSave(w: World): Promise<boolean> {
  const S = w.save;
  if (!S.enabled || !S.db || S.busy) return false;
  S.busy = true;
  S.dirty = false;
  w.itemsState.dirty = false;
  w.doors.dirty = false;
  S.writeAt = Infinity;
  const ok = await putRec(S.db, S.key, snapshot(w));
  S.busy = false;
  S.lastWrite = w.time;
  if (ok) S.writes++;
  else S.status = 'write failed';
  return ok;
}

/** Per frame: debounce changes into a write; autosave; hook page hide once. */
export function updateSave(w: World): void {
  const S = w.save;
  if (!S.enabled || !w.started) return;
  if (w.itemsState.dirty || w.doors.dirty) {
    // a pickup, drop or door: write a moment later (several changes in a row become one write)
    if (S.writeAt === Infinity) S.writeAt = w.time + I.saveDebounce;
    S.dirty = true;
    w.itemsState.dirty = false;
    w.doors.dirty = false;
  }
  if (S.dirty && S.writeAt === Infinity && w.time - S.lastWrite > I.autosaveEvery) S.writeAt = w.time;
  if (w.time >= S.writeAt) void writeSave(w);
}

/** Save when the page is hidden or closed, and when the game is paused. */
export function hookSaveEvents(w: World): void {
  const now = () => { if (w.started && w.save.enabled) void writeSave(w); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') now(); });
  window.addEventListener('pagehide', now);
}

/** A message for the player about the save at boot (newer save kept, storage unavailable). */
export function saveBootMessage(w: World): void {
  const st = w.save.status;
  if (st.startsWith('kept') || st.startsWith('unavailable')) toast(w, `Save: ${st}`, 5);
}
