// Building interiors at run time: which buildings have their interior built, building them a few milliseconds per
// frame, swapping a building's solid core for the interior's walls, floors, stairs, furniture and doors, and taking it
// down again when you are far away. One entry per building whose record has a valid plan (records.ts, plan.ts).
//
// States: cold (the plinth, the notched core solid and the closed front door's plug collide; the leaf is drawn
// closed) -> building (interiorBuild.ts makes meshes and colliders in slices; the core still encloses them) -> active
// (the core is disabled, the doors are kinematic bodies that open with E, items rest on shelves, windows see through)
// -> cold again. The swap is one frame each way and in the safe order: interior colliders exist before the core goes,
// the core is back before the interior's colliders go. An interior is never taken down while you (or a moving item, or
// a car) are inside its footprint, while one of its doors is swinging, or within retireRadius.
import * as THREE from 'three';
import type { World } from '../../world';
import { TUNING } from '../../tuning';
import type { BuildingRecord } from './records';
import type { Plan, PlanStair } from './plan';
import { buildInterior, disposeInterior, rampAt, type BuiltInterior, type InteriorMats } from './interiorBuild';
import { addDoor, activateDoor, deactivateDoor, doorCentre, type DoorObj } from './doors';
import { pointIn } from './geom';
import { setDormant, spawnLazy, type WorldItem } from '../worldItems';
import { makeWorldMaterial } from '../render/worldMaterial';
import { emit } from '../../world';
import { toast } from '../hud';

const I = TUNING.interiors;

export interface Interior {
  rec: BuildingRecord;
  plan: Plan;
  state: 'cold' | 'building' | 'active';
  gen: Generator<void, BuiltInterior> | null;
  built: BuiltInterior | null;
  front: DoorObj;
  doors: DoorObj[];
  /** see-through slot in the facade material (-1: none) */
  slot: number;
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** horizontal distance from the player to the front door, last frame */
  dist: number;
  /** ms spent building it the last time, and in how many frames */
  buildMs: number; buildFrames: number;
  /** the counter (shops): where you pay */
  counter: { x: number; z: number } | null;
}

export interface InteriorsState {
  list: Interior[];
  byId: Map<string, Interior>;
  mats: InteriorMats;
  root: THREE.Group;
  /** the interior being built now (one at a time) */
  current: Interior | null;
  /** the interior the player stands in (active), or null */
  inside: Interior | null;
  lights: THREE.PointLight[];
  /** facade see-through slots (render/facadeMaterial.ts uOpenA / uOpenB) */
  slots: (Interior | null)[];
  /** the prompt for paying at a shop counter, when you stand at one with unpaid goods */
  pay: { total: number; items: WorldItem[] } | null;
  stats: { builds: number; retires: number; lastBuildMs: number; lastBuildFrames: number; maxSliceMs: number; active: number; planned: number; failed: number };
}

const OPEN_SLOTS = I.openSlots;

export function createInteriors(w: World): InteriorsState {
  const root = new THREE.Group();
  root.name = 'interiors';
  w.scene.add(root);
  const shell = makeWorldMaterial(w.look, { name: 'interior-shell', roughness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xc8d6de, roughness: 0.05, metalness: 0, transparent: true, opacity: I.glassOpacity, depthWrite: false });
  glass.name = 'interior-glass';
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  glow.name = 'interior-glow';
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < I.lightsMax; i++) {
    const l = new THREE.PointLight(0xffe2b8, 0, I.lightRange, 2);
    l.castShadow = false;
    l.position.set(0, -1000, 0);
    w.scene.add(l);
    lights.push(l);
  }
  const S: InteriorsState = {
    list: [], byId: new Map(), mats: { shell, glass, glow }, root, current: null, inside: null, lights,
    slots: Array(OPEN_SLOTS).fill(null), pay: null,
    stats: { builds: 0, retires: 0, lastBuildMs: 0, lastBuildFrames: 0, maxSliceMs: 0, active: 0, planned: 0, failed: 0 },
  };
  for (const rec of w.city.buildingRecords ?? []) {
    if (rec.planErrors.length) S.stats.failed++;
    if (!rec.plan || !rec.door) continue;
    const plan = rec.plan;
    const pd = plan.doors.find((d) => d.front)!;
    const front = addDoor(w, pd, rec.id);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of rec.pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const c = plan.furniture.find((f) => f.def === 'counter');
    const e: Interior = {
      rec, plan, state: 'cold', gen: null, built: null, front, doors: [front], slot: -1, minX, maxX, minZ, maxZ, dist: Infinity, buildMs: 0, buildFrames: 0,
      counter: c ? { x: c.x, z: c.z } : null,
    };
    S.list.push(e);
    S.byId.set(rec.id, e);
    S.stats.planned++;
  }
  setLightCount(S, I.lights[w.settings.quality]);
  // heights indoors: floors, stair ramps and stairwells of built interiors win over the terrain under the footprint
  w.city.interiorFloorAt = (x, z, y) => floorAt(S, x, z, y);
  return S;
}

/** Interior lights in use for a quality preset (the pool size never changes, so no shader recompiles). */
export function setLightCount(S: InteriorsState, n: number): void {
  S.lights.forEach((l, i) => { l.visible = i < n; l.intensity = 0; });
}

/** Is (x, z) inside this building's footprint (expanded by `grow` metres through the bounding box test only)? */
function inFoot(e: Interior, x: number, z: number, grow = 0): boolean {
  if (x < e.minX - grow || x > e.maxX + grow || z < e.minZ - grow || z > e.maxZ + grow) return false;
  return pointIn(x, z, e.rec.pts);
}

/** The interior whose footprint holds (x, z) at height y (any state), or null. */
export function interiorAt(S: InteriorsState, x: number, y: number, z: number): Interior | null {
  for (const e of S.list) if (y > e.rec.yMin - 1 && y < e.rec.top + 1 && inFoot(e, x, z)) return e;
  return null;
}

/** Height of a stair's ramp under (x, z), or NaN when (x, z) is not over the flight. */
function stairAt(st: PlanStair, x: number, z: number): number {
  const dx = x - st.x, dz = z - st.z;
  const a = dx * st.dx + dz * st.dz, c = dx * st.dz - dz * st.dx;
  if (a < -0.02 || a > st.run + 0.1 || Math.abs(c) > st.width / 2) return NaN;
  return st.y + rampAt(st, Math.max(0, a));
}

/**
 * The floor of a built interior under (x, z): with y, the highest floor, landing or stair tread at or below y + a level
 * step (floors over a stairwell do not count); without y, the ground floor. NaN outside every active interior.
 */
function floorAt(S: InteriorsState, x: number, z: number, y?: number): number {
  for (const e of S.list) {
    if (e.state !== 'active' || !inFoot(e, x, z)) continue;
    const L = e.plan.levels;
    if (y === undefined || y !== y) return L[0].y;
    const lim = y + TUNING.map.levelStep;
    let best = -Infinity;
    for (let k = 0; k < L.length; k++) {
      if (L[k].y > lim) break;
      let hole = false;
      for (const h of e.plan.holes) if (h.level === k && pointIn(x, z, h.poly)) { hole = true; break; }
      if (!hole) best = Math.max(best, L[k].y);
    }
    for (const st of e.plan.stairs) {
      const r = stairAt(st, x, z);
      if (r === r && r <= lim) best = Math.max(best, r);
    }
    return best > -Infinity ? best : L[0].y;
  }
  return NaN;
}

// ---------------------------------------------------------------------------------------------- activation
function startBuild(w: World, e: Interior): void {
  e.state = 'building';
  e.gen = buildInterior(w, e.rec, e.plan, w.interiors.mats, w.interiors.root);
  e.buildMs = 0;
  e.buildFrames = 0;
  w.interiors.current = e;
}

/** Run the current build for at most `budgetMs` (Infinity: to the end). */
function stepBuild(w: World, budgetMs: number): void {
  const S = w.interiors;
  const e = S.current;
  if (!e || !e.gen) return;
  const t0 = performance.now();
  let r = e.gen.next();
  while (!r.done && performance.now() - t0 < budgetMs) r = e.gen.next();
  const ms = performance.now() - t0;
  e.buildMs += ms;
  e.buildFrames++;
  if (budgetMs < Infinity) S.stats.maxSliceMs = Math.max(S.stats.maxSliceMs, ms);
  if (r.done) {
    e.built = r.value;
    e.gen = null;
    S.current = null;
    activate(w, e);
  }
}

/** Build an interior now, to the end (the player is at its door or loaded inside it). */
export function buildNow(w: World, e: Interior): void {
  const S = w.interiors;
  if (e.state === 'active') return;
  if (S.current && S.current !== e) {
    // finish whatever was being built first (one generator at a time)
    stepBuild(w, Infinity);
  }
  if (e.state === 'cold') startBuild(w, e);
  stepBuild(w, Infinity);
}

function activate(w: World, e: Interior): void {
  const S = w.interiors;
  const b = e.built!;
  // 1. the doors become kinematic bodies (front door at its saved state, the inner doors drawn now)
  for (const pd of e.plan.doors) {
    const d = pd.front ? e.front : addDoor(w, pd, e.rec.id);
    if (!e.doors.includes(d)) e.doors.push(d);
    activateDoor(w, d);
  }
  // 2. the core solid (and the cold door plug) goes: the interior's walls, floors and doors hold the building now
  for (const c of e.rec.core) c.setEnabled(false);
  // 3. items: the ones that were here come back, the shelves are stocked with the ones never taken
  const IS = w.itemsState;
  for (const it of IS.items) if (it.dormant && it.building === e.rec.id) setDormant(w, it, false);
  const owner = e.rec.template === 'shop' ? `business:${e.rec.id}` : `home:${e.rec.id}`;
  for (const sl of b.slots) {
    if (IS.byUid.has(sl.uid) || IS.gone.has(sl.uid) || w.save.moved.has(sl.uid)) continue;
    spawnLazy(w, sl.type, sl.uid, sl.x, sl.y, sl.z, sl.yaw, owner, e.rec.id);
  }
  // 4. windows see through from outside
  const k = S.slots.indexOf(null);
  if (k >= 0) { S.slots[k] = e; e.slot = k; writeSlot(w, k, e); }
  e.state = 'active';
  S.stats.builds++;
  S.stats.lastBuildMs = +e.buildMs.toFixed(2);
  S.stats.lastBuildFrames = e.buildFrames;
}

/** Can this interior be taken down now? Never with anyone or anything moving inside it, or a door swinging. */
function canRetire(w: World, e: Interior): boolean {
  const p = w.player.body.translation();
  if (inFoot(e, p.x, p.z, 1) && p.y > e.rec.yMin - 2 && p.y < e.rec.top + 2) return false;
  for (const d of e.doors) if (Math.abs(d.target - d.angle) > 1e-3) return false;
  for (const v of w.vehicles) { const t = v.body.translation(); if (inFoot(e, t.x, t.z, 1)) return false; }
  for (const it of w.itemsState.items) {
    if (!it.inWorld || it.dormant || !it.body || it.body.isSleeping()) continue;
    if (inFoot(e, it.px, it.pz, 1)) return false;
  }
  return true;
}

function retire(w: World, e: Interior): void {
  const S = w.interiors;
  // 1. items lying inside are kept as data (no bodies), so the solid never encloses one
  for (const it of w.itemsState.items) {
    if (!it.inWorld || it.dormant) continue;
    if (it.py > e.rec.yMin - 1 && it.py < e.rec.top + 1 && inFoot(e, it.px, it.pz)) { it.building = e.rec.id; setDormant(w, it, true); }
  }
  // 2. the core solid and the door plug come back
  for (const c of e.rec.core) c.setEnabled(true);
  // 3. then the interior's colliders, doors and meshes go
  for (const d of e.doors) deactivateDoor(w, d, !d.pd.front);
  if (e.built) disposeInterior(w, e.built);
  e.built = null;
  if (e.slot >= 0) { S.slots[e.slot] = null; clearSlot(w, e.slot); e.slot = -1; }
  e.state = 'cold';
  S.stats.retires++;
}

// ---------------------------------------------------------------------------------------------- see-through windows
function writeSlot(w: World, k: number, e: Interior): void {
  const u = w.look.uniforms;
  // the footprint's box in the frame of its front wall (centre, axis, half extents), and its height range
  const f = e.plan.frame;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of e.rec.pts) {
    const a = (p[0] - f.ox) * f.ux + (p[1] - f.oz) * f.uz, b = (p[0] - f.ox) * f.vx + (p[1] - f.oz) * f.vz;
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  u.uOpenA.value[k].set(f.ox + f.ux * cu + f.vx * cv, f.oz + f.uz * cu + f.vz * cv, f.ux, f.uz);
  u.uOpenB.value[k].set((u1 - u0) / 2 + 0.06, (v1 - v0) / 2 + 0.06, e.rec.y0 - 0.2, e.rec.top);
}
function clearSlot(w: World, k: number): void {
  w.look.uniforms.uOpenB.value[k].set(0, 0, 0, 0);
}

// ---------------------------------------------------------------------------------------------- per frame
const LIGHT_PICK: { d: number; x: number; y: number; z: number }[] = [];

/** Per frame: choose, build, activate and retire interiors; the lights indoors; shop exits and the counter. */
export function updateInteriors(w: World, _dt: number): void {
  const S = w.interiors;
  if (!S.list.length) return;
  const pl = w.player;
  const veh = pl.vehicle;
  const pos = veh ? veh.body.translation() : pl.body.translation();
  const speed = veh ? Math.abs(veh.speed) : 0;
  const q = w.settings.quality;
  const maxActive = I.maxActive[q];
  // distances, and the interior you are in
  let inside: Interior | null = null;
  for (const e of S.list) {
    e.dist = Math.hypot(e.front.pd.x - pos.x, e.front.pd.z - pos.z);
    if (!veh && e.state === 'active' && inFoot(e, pos.x, pos.z) && pos.y > e.rec.yMin && pos.y < e.rec.top + 1) inside = e;
  }
  if (S.inside !== inside) leftOrEntered(w, S.inside, inside);
  S.inside = inside;
  // wanted: on foot within buildRadius of the door, in a car only when (nearly) stopped close by
  const reach = veh ? (speed < I.carStopSpeed ? I.carBuildRadius : -1) : I.buildRadius;
  let active = 0;
  for (const e of S.list) if (e.state === 'active') active++;
  // retire the far ones first (frees a slot)
  for (const e of S.list) {
    if (e.state !== 'active' || e === inside) continue;
    if (e.dist > I.retireRadius && canRetire(w, e)) { retire(w, e); active--; }
  }
  // start the nearest wanted building when nothing is being built and there is room
  if (!S.current && active < maxActive) {
    let best: Interior | null = null;
    for (const e of S.list) if (e.state === 'cold' && e.dist < reach && (!best || e.dist < best.dist)) best = e;
    if (!best && active >= maxActive) {
      // full: retire the furthest retirable one if a nearer one is wanted (never one you are in)
    }
    if (best) startBuild(w, best);
  }
  if (S.current) stepBuild(w, q === 'low' ? I.lowSliceMs : I.sliceMs);
  S.stats.active = active;
  updateLights(w, S, pos);
  updateCounter(w, S);
}

/** Point lights to the rooms nearest you (the interior you are in first), brighter at night. */
function updateLights(w: World, S: InteriorsState, pos: { x: number; y: number; z: number }): void {
  const n = S.lights.filter((l) => l.visible).length;
  if (!n) return;
  LIGHT_PICK.length = 0;
  const e = S.inside ?? S.list.find((x) => x.state === 'active' && x.dist < 14) ?? null;
  if (e) {
    for (const l of e.plan.lights) {
      const dy = (l.y - 2.2 - pos.y) * 3; // the floor you are on first
      LIGHT_PICK.push({ d: Math.hypot(l.x - pos.x, l.z - pos.z) + Math.abs(dy), x: l.x, y: l.y, z: l.z });
    }
    LIGHT_PICK.sort((a, b) => a.d - b.d);
  }
  const night = w.dayNight.night ?? 0;
  const inten = I.lightIntensityDay + (I.lightIntensityNight - I.lightIntensityDay) * night;
  for (let i = 0; i < n; i++) {
    const l = S.lights[i], p = LIGHT_PICK[i];
    if (!p) { l.intensity = 0; l.position.set(0, -1000, 0); continue; }
    l.position.set(p.x, p.y - 0.25, p.z);
    l.intensity = inten;
  }
}

/** Walking out of a shop with goods you have not paid for: they are stolen, and anyone who saw can call it in. */
function leftOrEntered(w: World, was: Interior | null, now: Interior | null): void {
  w.save.dirty = true;
  if (!was || was.rec.template !== 'shop' || now === was) return;
  const biz = `business:${was.rec.id}`;
  let n = 0;
  for (const it of w.inventory.slots) if (it && it.owner === biz && !it.stolen) { it.stolen = true; n++; }
  if (n) {
    const p = w.player.body.translation();
    emit(w, { type: 'shoplifting', x: p.x, z: p.z, items: n });
    toast(w, `You walked out without paying for ${n} item${n > 1 ? 's' : ''}`, 3);
  }
}

/** At a shop counter with unpaid goods in your hands: "E pay $x". */
function updateCounter(w: World, S: InteriorsState): void {
  S.pay = null;
  const e = S.inside;
  if (!e || !e.counter) return;
  const p = w.player.body.translation();
  if (Math.hypot(p.x - e.counter.x, p.z - e.counter.z) > I.payReach) return;
  const biz = `business:${e.rec.id}`;
  let total = 0;
  const items: WorldItem[] = [];
  for (const it of w.inventory.slots) if (it && it.owner === biz) { total += TUNING.items.defs[it.type].value; items.push(it); }
  if (items.length) S.pay = { total, items };
}

/** Pay for the goods in your hands at the counter (player.ts calls this on E). */
export function payAtCounter(w: World): boolean {
  const S = w.interiors;
  if (!S.pay) return false;
  if (w.cash < S.pay.total) { toast(w, `Not enough cash: $${S.pay.total.toFixed(2)} needed`, 2.5); return true; }
  w.cash -= S.pay.total;
  for (const it of S.pay.items) { it.owner = 'player'; it.stolen = false; it.touched = true; }
  toast(w, `Paid $${S.pay.total.toFixed(2)}`, 2);
  w.itemsState.dirty = true;
  S.pay = null;
  return true;
}

/** E on a door: a cold front door finishes its interior first (never a hole without collision behind it). */
export function useDoor(w: World, d: DoorObj): boolean {
  const e = w.interiors.byId.get(d.building);
  if (!e) return false;
  if (!d.body) buildNow(w, e);
  return !!d.body;
}

/** Tests and the debug overlay: a summary of the interiors near you. */
export function interiorsSummary(w: World): Record<string, unknown> {
  const S = w.interiors;
  return {
    ...S.stats, inside: S.inside?.rec.id ?? null, building: S.current?.rec.id ?? null,
    list: S.list.map((e) => ({ id: e.rec.id, state: e.state, dist: +e.dist.toFixed(1), tris: e.built?.tris ?? 0, colliders: e.built?.colliders.length ?? 0, buildMs: +e.buildMs.toFixed(1), frames: e.buildFrames, door: doorCentre(e.front) })),
  };
}
