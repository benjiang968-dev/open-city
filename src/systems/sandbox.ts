// Repeatable spatial work, property transactions and storage. All carried goods are existing WorldItem instances.
import * as THREE from 'three';
import type { World } from '../world';
import { emit } from '../world';
import { SANDBOX as S, type SandboxJobId } from '../data/sandbox';
import { TUNING } from '../tuning';
import { freeSlot, selectedItem, takeSelected, transferToInventory } from './inventory';
import { spawnItem, removeFromWorld, placeInWorld, type WorldItem } from './worldItems';
import { toast } from './hud';
import { saveGame } from './persistence';
import type { JobSystem, JobMarker } from './economy/jobManager';
import type { ItemId } from '../art/items';

type Entry = World['interiors']['entries'][number];
interface Property { mode: 'owned' | 'lease'; expiresDay: number; stored: number[] }
interface ActiveWork {
  kind: SandboxJobId;
  run: number;
  startEntryId?: string; // optional for compatibility with existing active shifts
  items: number[];
  delivered: number[];
  repairDone: number[];
  tool: number | null;
}
export interface SandboxSave {
  version: 1;
  serial: number;
  completed: number;
  earned: number;
  active: ActiveWork | null;
  pool: Partial<Record<SandboxJobId, number[]>>;
  properties: Record<string, Property>;
}
export interface SandboxState {
  save: SandboxSave;
  panel: HTMLDivElement;
  open: boolean;
  prompt: string;
  workTime: number;
  lastRepair: number;
  trespassTime: number;
  trespassReported: boolean;
  priorInterior: string | null;
  markers: THREE.Group;
  markerKey: string;
  waypoint: string | null;
}
const emptySave = (): SandboxSave => ({ version: 1, serial: 0, completed: 0, earned: 0, active: null, pool: {}, properties: {} });
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pos = (w: World) => w.player.mesh.position;
const entryKind = (w: World, kind: string): Entry | undefined => w.interiors.entries.find(e => e.kind === kind);
const jobStartEntry = (w: World, kind: string): Entry | undefined => {
  const options = w.interiors.entries.filter(e => e.kind === kind);
  return options.find(e => e.id === w.interiors.active) ?? options.sort((a, b) =>
    Math.hypot(pos(w).x - a.exterior.x, pos(w).z - a.exterior.z) - Math.hypot(pos(w).x - b.exterior.x, pos(w).z - b.exterior.z))[0];
};
const workStart = (w: World, a: ActiveWork): Entry | undefined => w.interiors.entries.find(e => e.id === a.startEntryId) ?? entryKind(w, S.jobs[a.kind].startKind);
const activeEntry = (w: World): Entry | undefined => w.interiors.entries.find(e => e.id === w.interiors.active);
const local = (e: Entry, x: number, z: number) => ({ x: e.origin.x + x, y: e.origin.y, z: e.origin.z + z });
const near = (w: World, p: { x: number; y: number; z: number }, r: number = S.objectiveRange) => Math.hypot(pos(w).x - p.x, pos(w).z - p.z) <= r && Math.abs(pos(w).y - p.y) < 2;
const atBoard = (w: World, e: Entry) => w.interiors.active === e.id || (!w.interiors.active && near(w, e.exterior, S.boardRange));
const totalDay = (w: World) => w.dayNight.day + w.dayNight.hour / 24;

export function apartmentPrices(w: World, id: string): { buy: number; rent: number } {
  const index = w.interiors.entries.filter(e => e.kind === 'apartment').findIndex(e => e.id === id);
  const percent = S.apartmentPricePercentages[index] ?? 100;
  return { buy: Math.round(S.apartmentBuyPrice * percent / 100), rent: Math.round(S.apartmentLeasePrice * percent / 100) };
}

export function hasApartmentAccess(w: World, id: string): boolean {
  const p = w.sandbox.save.properties[id];
  return !!p && (p.mode === 'owned' || p.expiresDay > totalDay(w));
}

export function createSandbox(w: World): SandboxState {
  const panel = document.createElement('div');
  panel.id = 'sandbox-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Neighbourhood work and homes');
  panel.style.cssText = 'display:none;position:fixed;inset:8% 12%;padding:24px;overflow:auto;z-index:35;pointer-events:auto;background:#13212bf5;color:#f4f1e8;border:1px solid #7dabb7;border-radius:14px;font:16px/1.5 system-ui;box-shadow:0 12px 60px #0009';
  document.getElementById('ui')!.appendChild(panel);
  const markers = new THREE.Group();
  w.scene.add(markers);
  const state: SandboxState = { save: emptySave(), panel, open: false, prompt: '', workTime: 0, lastRepair: -1, trespassTime: 0, trespassReported: false, priorInterior: null, markers, markerKey: '', waypoint: null };
  panel.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const action = button.dataset.action!, id = button.dataset.id ?? '';
    if (action === 'close') closeSandbox(w);
    else if (action === 'locate') { state.waypoint = id; closeSandbox(w); toast(w, 'Entrance marked on your minimap · E to enter', 4); }
    else if (action === 'clear-waypoint') { state.waypoint = null; renderPanel(w); }
    else if (action === 'start') { if (startSandboxJob(w, id as SandboxJobId)) closeSandbox(w); }
    else if (action === 'cancel') { cancelSandboxJob(w); renderPanel(w); }
    else if (action === 'rent' || action === 'buy') { transactApartment(w, id, action); renderPanel(w); }
    else if (action === 'store') { storeApartmentItem(w, id); renderPanel(w); }
    else if (action === 'retrieve') { retrieveApartmentItem(w, Number(id)); renderPanel(w); }
    else if (action === 'pay') { payShopItem(w); renderPanel(w); }
  });
  // A modal must be closable while gameplay inputs are blocked or a focused button consumes key events.
  panel.addEventListener('keydown', e => { if (e.code === 'Escape' || e.code === 'KeyJ') { e.preventDefault(); e.stopPropagation(); closeSandbox(w); } });
  w.sandbox = state;
  // Reserve stable instances before persistence restores IDs. Repeated shifts recycle these same props.
  for (const kind of Object.keys(S.jobs) as SandboxJobId[]) {
    const e = entryKind(w, S.jobs[kind].startKind);
    if (!e) continue;
    const ids = taskItems(w, kind, kind === 'repair' ? 1 : S.jobs[kind].count, kind === 'cleaning' ? 'bag' : kind === 'repair' ? 'wrench' : 'box', e);
    for (const id of ids) { const it = w.itemsState.items[id]; removeFromWorld(w, it); it.location = 'consumed'; }
  }
  w.jobs.register(new SandboxJobs());
  return state;
}

export function sandboxKeys(w: World): void {
  if (!w.started || w.paused || w.chat.open || w.player.dead) return;
  if (w.input.pressed.has('KeyJ') && !w.input.blocked) openSandbox(w);
}
export function openSandbox(w: World): void {
  const s = w.sandbox;
  if (s.open || w.input.blocked || w.player.vehicle) return;
  s.open = true;
  w.input.blocked = true;
  w.input.keys.clear(); w.input.pressed.clear(); w.input.mouse0 = false;
  if (document.pointerLockElement) { w.input.expectUnlock = true; document.exitPointerLock(); }
  renderPanel(w);
  s.panel.style.display = 'block';
  s.panel.querySelector<HTMLButtonElement>('button')?.focus();
}
export function closeSandbox(w: World): void {
  w.sandbox.open = false;
  w.sandbox.panel.style.display = 'none';
  w.input.blocked = false;
  w.input.keys.clear(); w.input.pressed.clear();
  w.renderer.domElement.focus();
}
function button(action: string, id: string, label: string, disabled = false) {
  return `<button data-action="${action}" data-id="${esc(id)}" ${disabled ? 'disabled' : ''} style="margin:4px;padding:9px 12px;background:#e8c46a;color:#14222c;border:0;border-radius:6px;cursor:pointer">${esc(label)}</button>`;
}
function renderPanel(w: World): void {
  const s = w.sandbox;
  const current = s.save.active;
  let html = `<div style="display:flex;justify-content:space-between"><h2>Neighbourhood work & homes</h2>${button('close', '', 'Close · J / Esc')}</div><p>Jobs start at marked building doors. Enter with E, then follow the work points inside. The same physical item must reach its destination. Saves stay in this browser.</p>`;
  if (current) html += `<p><b>${esc(S.jobs[current.kind].name)}</b> · ${esc(jobStatus(w))}</p>${button('cancel', '', 'Cancel current shift (no pay)')}`;
  if (s.waypoint) html += button('clear-waypoint', '', 'Clear map destination');
  html += '<h3>Repeatable work</h3>';
  for (const [id, job] of Object.entries(S.jobs)) {
    const e = jobStartEntry(w, job.startKind);
    const distance = e ? Math.round(Math.hypot(pos(w).x - e.exterior.x, pos(w).z - e.exterior.z)) : 0;
    html += `<div style="border-top:1px solid #ffffff25;padding:10px 0"><b>${esc(job.name)} · $${job.pay}</b><br>${esc(job.description)}<br>${e ? `${esc(e.name)} · ${distance} m${atBoard(w, e) ? ' · at start point' : ' · visit the door to start'}` : 'No suitable building in this map'}<br>${button('start', id, `Start ${job.name}`, !!current || !e || !atBoard(w, e))}${e ? button('locate', e.id, 'Show entrance on map') : ''}</div>`;
  }
  for (const apartment of w.interiors.entries.filter(e => e.kind === 'apartment')) {
    const price = apartmentPrices(w, apartment.id);
    const distance = Math.round(Math.hypot(pos(w).x - apartment.exterior.x, pos(w).z - apartment.exterior.z));
    const p = s.save.properties[apartment.id];
    const at = w.interiors.active === apartment.id;
    html += `<h3>${esc(apartment.name)}</h3><p>View the furnished apartment free. View at ${esc(w.city.pois.find(p => p.id === apartment.poiId)?.street ?? 'Georgetown')} · ${distance} m. Buy for $${price.buy}, or prepay $${price.rent} for ${S.apartmentLeaseDays} game days. <b>No automatic renewal or recurring charges.</b> Storage holds ${S.storageSlots} items. After a lease expires you can retrieve stored items, but cannot deposit more.</p>`;
    html += `<p>${p ? p.mode === 'owned' ? 'You own this apartment.' : `Lease ${hasApartmentAccess(w, apartment.id) ? `has ${(p.expiresDay - totalDay(w)).toFixed(1)} game days left` : 'expired'}.` : 'Available to view, buy or lease.'} Visit the apartment inside to transact.</p>`;
    html += button('locate', apartment.id, 'Show apartment on map');
    html += button('rent', apartment.id, `Prepay ${S.apartmentLeaseDays} days · $${price.rent}`, !at || p?.mode === 'owned' || (!!p && hasApartmentAccess(w, apartment.id)));
    html += button('buy', apartment.id, `Buy · $${price.buy}`, !at || p?.mode === 'owned');
    if (p) {
      html += '<p>Storage: ' + p.stored.length + '/' + S.storageSlots + '</p>';
      html += button('store', apartment.id, 'Store selected inventory item', !at || !hasApartmentAccess(w, apartment.id));
      for (const id of p.stored) {
        const it = w.itemsState.items[id];
        if (it) html += button('retrieve', String(id), `Retrieve ${TUNING.items.defs[it.type].name}`, !at);
      }
    }
  }
  const e = activeEntry(w), it = selectedItem(w);
  if (e?.kind === 'shop' || e?.kind === 'cafe') {
    html += '<h3>Shop counter</h3><p>Carry an item to inspect it. Pay here before leaving. Unpaid merchandise is theft; the shopkeeper reports it.</p>';
    if (it?.owner === e.id && it.price > 0) html += button('pay', '', `Pay for selected ${TUNING.items.defs[it.type].name} · $${it.price}`);
  }
  html += `<p>Completed shifts: ${s.save.completed} · work earned: $${s.save.earned}</p>`;
  s.panel.innerHTML = html;
}

function taskItems(w: World, kind: SandboxJobId, count: number, type: ItemId, e: Entry): number[] {
  const old = w.sandbox.save.pool[kind] ?? [];
  const ids: number[] = [];
  for (let k = 0; k < count; k++) {
    const p = local(e, -1 + k, 0);
    let it = old[k] === undefined ? undefined : w.itemsState.items[old[k]];
    if (!it || it.type !== type) it = spawnItem(w, type, p.x, p.z, 0) ?? undefined;
    if (!it) continue;
    // Clear any old reference before reusing a shift prop. Shift props never enter apartment storage.
    for (let n = 0; n < w.inventory.slots.length; n++) if (w.inventory.slots[n]?.id === it.id) w.inventory.slots[n] = null;
    it.owner = null; it.price = 0; it.stolen = false; it.sealed = false;
    placeInWorld(w, it, p.x, p.y + w.itemsState.art[type].restY + 0.05, p.z, 0, 0, 0, 0);
    it.body.setAngvel({ x: 0, y: 0, z: 0 }, true); it.body.sleep();
    ids.push(it.id);
  }
  w.sandbox.save.pool[kind] = ids;
  return ids;
}
export function startSandboxJob(w: World, kind: SandboxJobId): boolean {
  if (!(kind in S.jobs) || w.sandbox.save.active || w.player.vehicle) return false;
  const e = jobStartEntry(w, S.jobs[kind].startKind);
  if (!e || !atBoard(w, e)) return false;
  const ids = taskItems(w, kind, kind === 'repair' ? 1 : S.jobs[kind].count, kind === 'cleaning' ? 'bag' : kind === 'repair' ? 'wrench' : 'box', e);
  if (ids.length !== (kind === 'repair' ? 1 : S.jobs[kind].count)) { toast(w, 'Cannot create shift supplies; no money was charged.'); return false; }
  w.sandbox.save.active = { kind, run: ++w.sandbox.save.serial, startEntryId: e.id, items: ids, delivered: [], repairDone: [], tool: kind === 'repair' ? ids[0] : null };
  w.sandbox.workTime = 0;
  void saveGame(w);
  toast(w, `${S.jobs[kind].name} started · E enter ${esc(e.name)}. J shows instructions.`, 5);
  return true;
}
export function cancelSandboxJob(w: World): void {
  const a = w.sandbox.save.active;
  if (!a) return;
  for (const id of a.items) {
    const it = w.itemsState.items[id];
    if (!it) continue;
    for (let n = 0; n < w.inventory.slots.length; n++) if (w.inventory.slots[n]?.id === id) w.inventory.slots[n] = null;
    removeFromWorld(w, it); it.location = 'consumed';
  }
  w.sandbox.save.active = null;
  w.sandbox.workTime = 0;
  void saveGame(w);
  toast(w, 'Shift cancelled · no payment');
}
function consumeTask(w: World, it: WorldItem) {
  for (let n = 0; n < w.inventory.slots.length; n++) if (w.inventory.slots[n]?.id === it.id) w.inventory.slots[n] = null;
  removeFromWorld(w, it); it.location = 'consumed';
}
function finishJob(w: World): void {
  const a = w.sandbox.save.active;
  if (!a) return;
  // Clear the active transaction before payment; repeated input and resumed frames cannot pay it twice.
  w.sandbox.save.active = null;
  const pay = S.jobs[a.kind].pay;
  w.cash += pay; w.sandbox.save.completed++; w.sandbox.save.earned += pay;
  for (const id of a.items) { const it = w.itemsState.items[id]; if (it) consumeTask(w, it); }
  void saveGame(w);
  toast(w, `${S.jobs[a.kind].name} complete · +$${pay}`, 4);
}
function destination(w: World, a: ActiveWork): Entry | undefined {
  return a.kind === 'delivery' ? entryKind(w, 'cafe') : workStart(w, a);
}
function workPoint(w: World, a: ActiveWork): { e: Entry; p: { x: number; y: number; z: number }; repair: number } | null {
  const e = destination(w, a);
  if (!e) return null;
  if (a.kind !== 'repair') return { e, p: local(e, a.kind === 'delivery' ? 0 : 2, a.kind === 'delivery' ? -2 : 2), repair: -1 };
  let nearest = -1, best = Infinity;
  for (let k = 0; k < 3; k++) {
    if (a.repairDone.includes(k)) continue;
    const p = local(e, -1 + k, -3.6);
    const d = Math.hypot(pos(w).x - p.x, pos(w).z - p.z);
    if (d < best) { best = d; nearest = k; }
  }
  return nearest < 0 ? null : { e, p: local(e, -1 + nearest, -3.6), repair: nearest };
}
/** Call before updatePlayer each fixed step so a deliberate E at a work station is consumed once. */
export function sandboxInteraction(w: World): boolean {
  const s = w.sandbox, a = s.save.active;
  if (!w.started || w.paused || w.input.blocked || w.player.vehicle || !a) return false;
  const t = workPoint(w, a);
  if (!t || w.interiors.active !== t.e.id || !near(w, t.p)) return false;
  const selected = selectedItem(w);
  if (a.kind === 'repair') {
    // Do not let the same key activate a nearby item or conversation while working.
    if (selected && a.items.includes(selected.id)) w.input.pressed.delete('KeyE');
    return false; // held E is integrated once per display frame, not fixed-step count
  }
  if (!selected || !a.items.includes(selected.id) || a.delivered.includes(selected.id)) return false;
  if (!w.input.pressed.has('KeyE')) return false;
  w.input.pressed.delete('KeyE');
  const id = selected.id;
  consumeTask(w, selected);
  a.delivered.push(id);
  if (a.delivered.length >= S.jobs[a.kind].count) finishJob(w);
  else toast(w, `${a.delivered.length}/${S.jobs[a.kind].count} ${a.kind === 'cleaning' ? 'bags disposed' : 'boxes moved'}`);
  return true;
}

export function transactApartment(w: World, id: string, action: 'rent' | 'buy'): boolean {
  const e = w.interiors.entries.find(e => e.id === id && e.kind === 'apartment');
  if (!e || w.interiors.active !== e.id || w.player.vehicle) return false;
  const old = w.sandbox.save.properties[id];
  if (old?.mode === 'owned' || (action === 'rent' && hasApartmentAccess(w, id))) return false;
  const quote = apartmentPrices(w, id);
  const price = action === 'buy' ? quote.buy : quote.rent;
  if (w.cash < price) { toast(w, `You need $${price}. No payment taken.`); return false; }
  w.cash -= price;
  w.sandbox.save.properties[id] = { mode: action === 'buy' ? 'owned' : 'lease', expiresDay: action === 'buy' ? 0 : totalDay(w) + S.apartmentLeaseDays, stored: old?.stored ?? [] };
  void saveGame(w);
  toast(w, action === 'buy' ? 'Apartment purchased · storage is yours' : `Lease prepaid for ${S.apartmentLeaseDays} game days · no automatic renewal`, 4);
  return true;
}
function isTask(w: World, id: number) { return w.sandbox.save.active?.items.includes(id) ?? false; }
export function storeApartmentItem(w: World, id: string): boolean {
  const p = w.sandbox.save.properties[id], it = selectedItem(w);
  if (!p || !it || w.interiors.active !== id || !hasApartmentAccess(w, id) || p.stored.length >= S.storageSlots || isTask(w, it.id) || it.owner) return false;
  if (p.stored.includes(it.id) || it.location !== 'inventory') return false;
  takeSelected(w);
  removeFromWorld(w, it); it.location = 'storage';
  p.stored.push(it.id);
  void saveGame(w);
  toast(w, `Stored ${TUNING.items.defs[it.type].name}`);
  return true;
}
export function retrieveApartmentItem(w: World, id: number): boolean {
  const p = w.sandbox.save.properties[w.interiors.active ?? ''];
  const it = w.itemsState.items[id];
  if (!p || !p.stored.includes(id) || !it || it.location !== 'storage' || freeSlot(w) < 0) return false;
  // Reuse the guarded insertion path for the same item instance; no clone is made.
  if (!transferToInventory(w, it)) return false;
  p.stored = p.stored.filter(x => x !== id);
  void saveGame(w);
  return true;
}
export function payShopItem(w: World): boolean {
  const e = activeEntry(w), it = selectedItem(w);
  if (!e || !['shop', 'cafe'].includes(e.kind) || it?.owner !== e.id || it.price <= 0 || w.cash < it.price) return false;
  // Ownership is changed before the UI can receive another click.
  const price = it.price;
  it.owner = null; it.price = 0; it.stolen = false;
  w.cash -= price;
  void saveGame(w);
  toast(w, `Paid $${price} · the item is yours`);
  return true;
}

function jobStatus(w: World): string {
  const a = w.sandbox.save.active;
  if (!a) {
    const point = w.interiors.entries.find(e => e.id === w.sandbox.waypoint);
    return point ? `${esc(point.name)} · ${Math.round(Math.hypot(pos(w).x - point.exterior.x, pos(w).z - point.exterior.z))} m · J map destination` : '';
  }
  const start = workStart(w, a), target = destination(w, a);
  if (a.kind === 'repair') return `Use the shift wrench at office panels · ${a.repairDone.length}/3 repaired`;
  const carried = selectedItem(w);
  if (carried && a.items.includes(carried.id)) return `${a.kind === 'delivery' ? `Carry parcel to ${target?.name ?? 'café'}` : a.kind === 'cleaning' ? 'Bring bag to shop disposal point' : 'Bring box to loading point'} · ${a.delivered.length}/${S.jobs[a.kind].count}`;
  return `Collect shift ${a.kind === 'cleaning' ? 'bags' : 'boxes'} inside ${start?.name ?? 'workplace'} · ${a.delivered.length}/${S.jobs[a.kind].count}`;
}
class SandboxJobs implements JobSystem {
  id = 'sandbox'; label = 'Neighbourhood work';
  update() {}
  status(w: World) { return jobStatus(w); }
  markers(w: World): JobMarker[] {
    const a = w.sandbox?.save.active;
    if (!a) {
      const point = w.interiors.entries.find(e => e.id === w.sandbox?.waypoint);
      return point ? [{ x: point.exterior.x, z: point.exterior.z, color: '#83dcbe', kind: 'tip' }] : [];
    }
    const e = selectedItem(w) && a.items.includes(selectedItem(w)!.id) ? destination(w, a) : workStart(w, a);
    return e ? [{ x: e.exterior.x, z: e.exterior.z, color: '#83dcbe', kind: 'dropoff' }] : [];
  }
  debug(w: World) { return `${w.sandbox?.save.completed ?? 0} shifts · ${w.sandbox?.save.active?.kind ?? 'idle'}`; }
}

export function updateSandbox(w: World, dt: number): void {
  const s = w.sandbox;
  if (!w.started || w.paused) return;
  s.prompt = '';
  const e = activeEntry(w), a = s.save.active;
  if (e?.id === s.waypoint) s.waypoint = null;
  if (e?.id !== s.priorInterior) { s.priorInterior = e?.id ?? null; s.trespassTime = 0; s.trespassReported = false; }
  if (e?.kind === 'warehouse' && a?.kind !== 'warehouse' && a?.kind !== 'delivery') {
    if (s.trespassTime === 0) toast(w, 'Private warehouse · leave within 10 seconds or start a shift (J). Security will report trespassing.', 7);
    s.trespassTime += dt;
    if (s.trespassTime > S.trespassGraceSeconds && !s.trespassReported) {
      s.trespassReported = true;
      emit(w, { type: 'trespass', x: e.exterior.x, z: e.exterior.z });
      toast(w, 'Warehouse security reported trespassing · police are responding', 5);
    }
  }
  if (a) {
    const t = workPoint(w, a);
    if (t && e?.id === t.e.id && near(w, t.p)) {
      const it = selectedItem(w);
      const has = !!it && a.items.includes(it.id);
      if (a.kind === 'repair') {
        s.prompt = has ? `Hold E  repair panel · ${Math.min(100, Math.round(s.workTime / S.stationHoldSeconds * 100))}%` : 'Select the shift wrench to repair this panel';
        if (!w.input.blocked && has && w.input.keys.has('KeyE')) {
          if (s.lastRepair !== t.repair) s.workTime = 0;
          s.lastRepair = t.repair;
          s.workTime += dt;
          // Prevent holding interaction from opening chat or picking unrelated props.
          w.input.pressed.delete('KeyE');
          if (s.workTime >= S.stationHoldSeconds) {
            a.repairDone.push(t.repair); s.workTime = 0;
            if (a.repairDone.length >= 3) finishJob(w);
            else toast(w, `Panel fixed · ${a.repairDone.length}/3`);
          }
        } else s.workTime = 0;
      } else s.prompt = has ? `E  ${a.kind === 'cleaning' ? 'dispose shift bag' : a.kind === 'delivery' ? 'deliver parcel' : 'place shift box'}` : 'Select a shift item, then E at this work point';
    } else { s.workTime = 0; s.lastRepair = -1; }
  }
  if (!e && !w.player.vehicle) {
    const nearest = w.interiors.entries.find(e => near(w, e.exterior, S.boardRange));
    if (nearest && !s.prompt) s.prompt = `E  enter ${nearest.name} · J work / homes`;
  }
  const target = w.itemsState.target;
  if (a && target && a.items.includes(target.id) && !s.prompt) s.prompt = `E  pick up shift ${a.kind === 'repair' ? 'wrench' : a.kind === 'cleaning' ? 'rubbish bag' : 'parcel'}`;
  if (e && !s.prompt) s.prompt = `${w.player.prompt || 'E exit at the door'} · J work / homes / shop counter`;
  if (s.prompt && !w.chat.open) w.player.prompt = s.prompt;
  updateWorkMarkers(w);
}
function updateWorkMarkers(w: World) {
  const s = w.sandbox, a = s.save.active, e = activeEntry(w);
  const key = `${e?.id}|${a?.kind}|${a?.repairDone.join(',')}`;
  if (key === s.markerKey) return;
  s.markerKey = key;
  for (const child of [...s.markers.children]) {
    s.markers.remove(child);
    const m = child as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material)?.dispose();
  }
  if (!a || !e || destination(w, a)?.id !== e.id) return;
  const points = a.kind === 'repair' ? [0, 1, 2].filter(k => !a.repairDone.includes(k)).map(k => local(e, -1 + k, -3.6)) : [local(e, a.kind === 'delivery' ? 0 : 2, a.kind === 'delivery' ? -2 : 2)];
  for (const p of points) {
    // A small painted work pad on the room floor, never a navigation arrow in the world.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.015, 0.8), new THREE.MeshBasicMaterial({ color: 0x77d8b3 }));
    pad.position.set(p.x, p.y + 0.015, p.z); s.markers.add(pad);
  }
}
export function captureSandbox(w: World): SandboxSave { return JSON.parse(JSON.stringify(w.sandbox.save)); }
export function restoreSandbox(w: World, value: unknown): void {
  if (!value || typeof value !== 'object' || (value as SandboxSave).version !== 1) return;
  const src = value as SandboxSave, out = emptySave();
  out.serial = Math.max(0, Number(src.serial) || 0); out.completed = Math.max(0, Number(src.completed) || 0); out.earned = Math.max(0, Number(src.earned) || 0);
  out.pool = src.pool && typeof src.pool === 'object' ? src.pool : {};
  if (src.active && src.active.kind in S.jobs && Array.isArray(src.active.items) && src.active.items.every(id => w.itemsState.items[id])) out.active = src.active;
  const stored = new Set<number>();
  for (const [id, p] of Object.entries(src.properties ?? {})) {
    if (!w.interiors.entries.some(e => e.id === id) || !p || !['owned', 'lease'].includes(p.mode)) continue;
    const ids = (Array.isArray(p.stored) ? p.stored : []).filter(n => Number.isInteger(n) && !stored.has(n) && w.itemsState.items[n]?.location === 'storage').slice(0, S.storageSlots);
    ids.forEach(n => stored.add(n));
    out.properties[id] = { mode: p.mode, expiresDay: Number(p.expiresDay) || 0, stored: ids };
  }
  w.sandbox.save = out;
  w.sandbox.markerKey = '';
}
