// Versioned, browser-local saves. One object-store write commits money, containers and world state together.
// No network calls or accounts; IndexedDB data belongs to this browser and website origin.
import * as THREE from 'three';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import type { ItemId } from '../art/items';
import { ITEM_IDS } from '../art/items';
import { removeFromWorld, spawnItem, writeItemMatrix, resetItemRegistry, type ItemLocation, type WorldItem } from './worldItems';
import { spawnVehicle, syncVehicleMesh } from './vehicles';
import { repaintVehicle } from './vehicles';

const DB_NAME = 'open-city-saves';
const STORE = 'worlds';
const VERSION = 1;
const AUTOSAVE_SECONDS = 10;

export interface PersistenceHooks {
  capture?: () => unknown;
  /** Restores active interiors/containers before the saved player transform is applied. */
  restore?: (data: unknown) => void;
}
interface ItemSave {
  id: number; type: ItemId; location: ItemLocation; authoredKey?: string | null;
  position: [number, number, number]; rotation: [number, number, number, number];
  stolen: boolean; illegal: boolean; owner: string | null; price: number; sealed: boolean; reportedTheft: boolean;
}
interface VehicleSave {
  id: number; parkedId: number | null; type: CarTypeName;
  position: [number, number, number]; rotation: [number, number, number, number];
  health: number; owned: boolean; locked: boolean; stolen: boolean; wrecked: boolean;
  owner: number | 'nobody'; ownerLocal: boolean; paint: string;
  forSale: { site: number; slot: number; price: number } | null;
}
export interface SaveRecord {
  version: number; key: string; savedAt: number; seed: number; map: string;
  cash: number; hour: number; day: number; time: number;
  player: { position: [number, number, number]; facing: number; health: number };
  items: ItemSave[]; inventory: (number | null)[]; selected: number;
  vehicles: VehicleSave[];
  npcs: { id: number; relationship: number; memory: unknown; history: unknown; timesTalked: number; mood: number }[];
  police?: { heat: number; loseTimer: number; lastSeenX: number; lastSeenZ: number; lastSeenY: number; trackUntil: number; searchUntil: number };
  extra?: unknown;
}
interface PersistenceState { hooks: PersistenceHooks; timer: number; ready: boolean; chain: Promise<boolean>; db: Promise<IDBDatabase>; lastError: string | null; }
const states = new WeakMap<World, PersistenceState>();

function key(w: World): string { return `${w.city.id}:${w.seed}`; }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}
function fail(w: World, state: PersistenceState, error: unknown): false {
  state.lastError = String(error);
  if (w.hud) {
    w.hud.toast.textContent = 'Save unavailable · browser storage may be blocked or full. Keep this tab open.';
    w.hud.toast.style.opacity = '1'; w.hud.toastUntil = w.time + 7;
  }
  return false;
}

/** Initialize once after deterministic item/interior/job creation, before loading an existing save. */
export function createPersistence(w: World, hooks: PersistenceHooks = {}): void {
  const db = database();
  // Attach a rejection handler immediately; loadGame reports errors to the HUD.
  void db.catch(() => {});
  states.set(w, { hooks, timer: 0, ready: false, chain: Promise.resolve(true), db, lastError: null });
  const save = () => { if (states.get(w)?.ready) void saveGame(w); };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}

export function captureSave(w: World): SaveRecord {
  const state = states.get(w);
  const p = w.player, pos = p.vehicle ? p.vehicle.body.translation() : p.body.translation();
  // Resume on foot beside the car: don't restore a disabled player collider or a partially completed enter/exit.
  const py = p.vehicle ? w.city.heightAt(pos.x + 2, pos.z, pos.y) + TUNING.player.capsuleHalfHeight + TUNING.player.capsuleRadius + 0.08 : pos.y;
  return {
    version: VERSION, key: key(w), savedAt: Date.now(), seed: w.seed, map: w.city.id,
    cash: w.cash, hour: w.dayNight.hour, day: w.dayNight.day, time: w.time,
    player: { position: [pos.x + (p.vehicle ? 2 : 0), py, pos.z], facing: p.facing, health: p.health },
    items: w.itemsState.items.map((it) => {
      const t = it.body.translation(), r = it.body.rotation();
      return { id: it.id, type: it.type, authoredKey: it.authoredKey, location: it.inWorld ? 'world' : it.location, position: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w], stolen: it.stolen, illegal: it.illegal, owner: it.owner, price: it.price, sealed: it.sealed, reportedTheft: it.reportedTheft };
    }),
    inventory: w.inventory.slots.map((it) => it?.id ?? null), selected: w.inventory.selected,
    // Pristine pooled stand-ins are reconstructed by the map; preserve every changed or owned parked vehicle.
    vehicles: w.vehicles.filter((v) => !v.idle && (!v.pooled || v.owned || v.stolen || v.health < v.maxHealth || v.driven)).map((v) => {
      const t = v.body.translation(), r = v.body.rotation();
      return { id: v.id, parkedId: v.parked?.id ?? null, type: v.type, position: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w], health: v.health, owned: v.owned, locked: v.locked, stolen: v.stolen, wrecked: v.wrecked, owner: v.owner, ownerLocal: v.ownerLocal, paint: v.paint.getHexString(), forSale: v.forSale };
    }),
    npcs: w.peds.map(({ id, npc }) => ({ id, relationship: npc.relationship, memory: npc.memory, history: npc.history, timesTalked: npc.timesTalked, mood: npc.mood })),
    police: w.police ? { heat: w.police.heat, loseTimer: w.police.loseTimer, lastSeenX: w.police.lastSeenX, lastSeenZ: w.police.lastSeenZ, lastSeenY: w.police.lastSeenY, trackUntil: w.police.trackUntil, searchUntil: w.police.searchUntil } : undefined,
    extra: state?.hooks.capture?.(),
  };
}

export function saveGame(w: World): Promise<boolean> {
  const state = states.get(w);
  if (!state?.ready) return Promise.resolve(false);
  // Capture synchronously so a later mutation cannot split cash, inventory and property transactions.
  const data = captureSave(w);
  state.chain = state.chain.then(async () => {
    try {
      const db = await state.db;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(data);
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Save write failed'));
      });
      state.lastError = null; return true;
    } catch (error) { return fail(w, state, error); }
  });
  return state.chain;
}

const finiteTuple = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Validate a complete snapshot before mutating a live game. Unsupported versions are retained, never overwritten. */
export function validSave(data: unknown, expectedKey: string): data is SaveRecord {
  if (!data || typeof data !== 'object') return false;
  const s = data as SaveRecord;
  if (s.version !== VERSION || s.key !== expectedKey || !Number.isFinite(s.cash) || s.cash < 0 || !Number.isFinite(s.hour) || !Number.isFinite(s.day) || !Number.isFinite(s.time)) return false;
  if (!s.player || !finiteTuple(s.player.position, 3) || !Number.isFinite(s.player.health) || !Number.isFinite(s.player.facing)) return false;
  if (!Array.isArray(s.items) || !Array.isArray(s.inventory) || !Array.isArray(s.vehicles) || !Array.isArray(s.npcs)) return false;
  const ids = new Set<number>(), authoredKeys = new Set<string>();
  for (const it of s.items) {
    if (!Number.isInteger(it.id) || it.id < 0 || ids.has(it.id) || !ITEM_IDS.includes(it.type) || !['world', 'inventory', 'storage', 'consumed'].includes(it.location) || !finiteTuple(it.position, 3) || !finiteTuple(it.rotation, 4)) return false;
    if (it.authoredKey != null) {
      if (typeof it.authoredKey !== 'string' || !it.authoredKey || it.authoredKey.length > 256 || authoredKeys.has(it.authoredKey)) return false;
      authoredKeys.add(it.authoredKey);
    }
    ids.add(it.id);
  }
  if (s.items.length > 10000 || s.items.some((_, i) => !ids.has(i))) return false;
  const held = s.inventory.filter((id) => id !== null);
  if (held.some((id) => !ids.has(id)) || new Set(held).size !== held.length || s.inventory.length > TUNING.items.hotbarSlots) return false;
  for (const id of held) if (s.items.find((it) => it.id === id)?.location !== 'inventory') return false;
  for (const it of s.items) if (it.location === 'inventory' && !held.includes(it.id)) return false;
  for (const v of s.vehicles) if (!(v.type in TUNING.vehicles.types) || !finiteTuple(v.position, 3) || !finiteTuple(v.rotation, 4) || !Number.isFinite(v.health)) return false;
  return true;
}

export async function loadGame(w: World): Promise<boolean> {
  const state = states.get(w);
  if (!state) throw new Error('Call createPersistence before loadGame');
  try {
    const db = await state.db;
    const data = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key(w));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!data) { state.ready = true; return false; }
    if (!validSave(data, key(w))) {
      fail(w, state, 'Unsupported or invalid save; preserved without overwrite');
      return false; // remain read-only so a future save can recover the existing progress
    }
    restoreSave(w, data);
    state.ready = true;
    return true;
  } catch (error) { fail(w, state, error); return false; }
}

function restoreItem(w: World, it: WorldItem, record: ItemSave): void {
  removeFromWorld(w, it);
  it.authoredKey = record.authoredKey ?? null;
  it.location = record.location; it.inWorld = record.location === 'world';
  it.owner = record.owner ?? null; it.price = Math.max(0, record.price || 0);
  it.sealed = !!record.sealed; it.reportedTheft = !!record.reportedTheft;
  it.stolen = !!record.stolen; it.illegal = !!record.illegal;
  const [x, y, z] = record.position, [rx, ry, rz, rw] = record.rotation;
  it.body.setTranslation({ x, y, z }, false); it.body.setRotation({ x: rx, y: ry, z: rz, w: rw }, false);
  it.body.setLinvel({ x: 0, y: 0, z: 0 }, false); it.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  it.body.setEnabled(it.inWorld); if (it.inWorld) it.body.sleep();
  it.px = x; it.py = y; it.pz = z; writeItemMatrix(w.itemsState, it);
}

export function restoreSave(w: World, s: SaveRecord): void {
  if (!validSave(s, key(w))) throw new Error('Invalid save snapshot');
  // A source/map update may change which ambient spots fit. Save IDs are authoritative: never reinterpret
  // an old can as the new boot's box at that numeric index. Retain new authored goods by stable semantic key.
  const authoredAtBoot = w.itemsState.items.filter(it => it.authoredKey).map(it => {
    const p = it.body.translation(), q = it.body.rotation();
    return { id: it.id, type: it.type, authoredKey: it.authoredKey, location: it.inWorld ? 'world' : it.location,
      position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], owner: it.owner, price: it.price,
      stolen: it.stolen, illegal: it.illegal, sealed: it.sealed, reportedTheft: it.reportedTheft } as ItemSave;
  });
  const mismatchedRegistry = s.items.some(record => {
    const existing = w.itemsState.items[record.id];
    return existing && (existing.type !== record.type || (record.authoredKey != null && existing.authoredKey !== record.authoredKey));
  });
  if (mismatchedRegistry) {
    w.inventory.slots.fill(null);
    resetItemRegistry(w);
  }
  const state = states.get(w);
  w.cash = s.cash; w.time = Math.max(0, s.time);
  w.dayNight.hour = ((s.hour % 24) + 24) % 24; w.dayNight.day = Math.max(1, Math.floor(s.day));
  // Save-only instances (e.g. a delivery spawned after boot) retain their original registry index.
  const saved = new Map(s.items.map((it) => [it.id, it]));
  const maxId = Math.max(-1, ...s.items.map((it) => it.id));
  while (w.itemsState.items.length <= maxId) {
    const next = saved.get(w.itemsState.items.length);
    if (!next || !spawnItem(w, next.type, w.city.spawn.x, w.city.spawn.z, 0)) throw new Error('Item registry no longer matches this save');
  }
  for (const record of s.items) {
    const it = w.itemsState.items[record.id];
    if (!it || it.type !== record.type) throw new Error(`Saved item ${record.id} changed type`);
    restoreItem(w, it, record);
  }
  // Old version-1 saves have no authoredKey. They retain every old object and gain only newly authored content.
  const present = new Set(w.itemsState.items.map(it => it.authoredKey).filter(Boolean));
  for (const record of authoredAtBoot) if (record.authoredKey && !present.has(record.authoredKey)) {
    const it = spawnItem(w, record.type, w.city.spawn.x, w.city.spawn.z, 0);
    if (!it) throw new Error('Cannot append new room object to saved world');
    restoreItem(w, it, record); present.add(record.authoredKey);
  }
  w.inventory.slots.fill(null);
  s.inventory.forEach((id, i) => { if (id !== null) w.inventory.slots[i] = w.itemsState.items[id]; });
  w.inventory.selected = Math.max(0, Math.min(TUNING.items.hotbarSlots - 1, Math.floor(s.selected || 0)));
  w.inventory.shownKey = '';
  for (const record of s.vehicles) {
    let v = record.parkedId !== null ? w.parked.cars[record.parkedId]?.v : w.vehicles.find((candidate) => candidate.id === record.id && !candidate.pooled);
    const parked = record.parkedId !== null ? w.parked.cars[record.parkedId] : null;
    if (!v || v.type !== record.type) {
      const [x, y, z] = record.position;
      v = spawnVehicle(w, record.type, x, z, 0, new THREE.Color(`#${record.paint}`), y);
      if (parked) { v.parked = parked; parked.v = v; }
    }
    // Saved changed parked cars remain individual vehicles, outside the recycling pool.
    v.pooled = false; v.idle = false; v.mesh.visible = true; v.inst = -1;
    v.owned = !!record.owned; v.locked = !!record.locked; v.stolen = !!record.stolen;
    v.owner = record.owner; v.ownerLocal = !!record.ownerLocal; v.forSale = record.forSale;
    v.health = Math.max(0, Math.min(v.maxHealth, record.health)); v.wrecked = !!record.wrecked;
    repaintVehicle(v, new THREE.Color(`#${record.paint}`));
    const [x, y, z] = record.position, [rx, ry, rz, rw] = record.rotation;
    v.body.setEnabled(true); v.body.setTranslation({ x, y, z }, false); v.body.setRotation({ x: rx, y: ry, z: rz, w: rw }, false);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, false); v.body.setAngvel({ x: 0, y: 0, z: 0 }, false); v.body.sleep();
    v.px = x; v.py = y; v.pz = z;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(rx, ry, rz, rw));
    v.heading = Math.atan2(forward.x, forward.z);
    v.speed = 0; v.prevVel.set(0, 0, 0); syncVehicleMesh(v);
  }
  w.parked.dirty = true;
  for (const record of s.npcs) {
    const npc = w.peds[record.id]?.npc;
    if (!npc) continue;
    npc.relationship = Math.max(-100, Math.min(100, record.relationship)); npc.mood = Math.max(-1, Math.min(1, record.mood));
    npc.timesTalked = Math.max(0, record.timesTalked || 0);
    if (Array.isArray(record.memory)) npc.memory = record.memory.slice(-TUNING.npc.memorySize);
    if (Array.isArray(record.history)) npc.history = record.history.slice(-20);
  }
  if (s.police && w.police) {
    Object.assign(w.police, s.police);
    w.police.stars = Math.max(0, Math.min(TUNING.police.maxStars, Math.ceil(s.police.heat / TUNING.police.heatPerStar)));
    w.police.seen = false; w.police.bustTimer = 0;
  }
  state?.hooks.restore?.(s.extra);
  const [x, y, z] = s.player.position;
  w.player.body.setTranslation({ x, y, z }, true);
  w.player.body.setNextKinematicTranslation({ x, y, z });
  w.player.health = Math.max(1, Math.min(100, s.player.health)); w.player.facing = s.player.facing; w.player.vy = 0;
  if (w.cam) w.cam.yaw = w.player.facing + Math.PI;
  w.player.mesh.position.set(x, y - TUNING.player.capsuleHalfHeight - TUNING.player.capsuleRadius, z);
}

export function updatePersistence(w: World, dt: number): void {
  const state = states.get(w);
  if (!state?.ready || !w.started || w.player.dead) return;
  state.timer += dt;
  if (state.timer >= AUTOSAVE_SECONDS) { state.timer = 0; void saveGame(w); }
}

export function persistenceStatus(w: World): { ready: boolean; lastError: string | null } {
  const state = states.get(w);
  return { ready: !!state?.ready, lastError: state?.lastError ?? null };
}
