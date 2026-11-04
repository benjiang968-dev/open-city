// Parked cars: the cars along every kerb and in the car parks, matching the street (dense on shopping streets,
// sparse on residential blocks, the waterfront car parks full; TUNING.vehicles.parkedCarsPer100m by map and street
// class). Every one can be entered, stolen or broken into, but a street full of physics vehicles with ~15 meshes
// each would cost far too much, so a parked car has three forms:
//  - far from you: an entry in this list, drawn as one instance of a shared InstancedMesh (two per car type: the
//    paint shell, coloured per instance, and the glass / trim / tyres), with no physics body;
//  - near you (and near where your car is heading): a real drivable Vehicle taken from a pool, still drawn as its
//    instance while untouched, so it costs nothing extra to draw;
//  - driven, damaged or broken into: that Vehicle shows its own meshes (dents, cracks, bumpers) from then on.
// Untouched pooled cars go back to the pool when you leave (keeping where they were pushed to). Every other car
// that is untouched and parked (yours, dealership stock) is drawn as an instance too.
import * as THREE from 'three';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import type { CityMap, ParkingSpot } from './map/cityMap';
import { spawnVehicle, repaintVehicle, rideHeight, syncVehicleMesh, type Vehicle } from './vehicles';
import { buildCarBody, carMaterial } from '../art/car';
import { Rng } from '../rng';

const V = TUNING.vehicles;
const TH = TUNING.theft;
const TYPES = Object.keys(V.types) as CarTypeName[];
const PAINTS = ['#e63946', '#f1faee', '#457b9d', '#2a9d8f', '#e9c46a', '#264653', '#8d99ae', '#ff8fab', '#606c38', '#bc6c25', '#1d1d1f', '#d9d9d9', '#7f1d1d', '#1e3a8a'];
const CELL = 32; // metres per cell of the parked-car grid (lookup speed only)
const FAR = 1e7; // where idle pooled cars are said to be (every distance test skips them)

export interface ParkedCar {
  id: number;
  type: CarTypeName;
  paint: THREE.Color;
  x: number; // ground under the car's centre (its body rides rideHeight above)
  y: number;
  z: number;
  heading: number;
  /** Pose of the body at rest: position and rotation (also the instance matrix, column-major). */
  pos: Float32Array; // x, y, z
  rot: Float32Array; // quaternion x, y, z, w
  mat: Float32Array;
  cls: ParkingSpot['cls'];
  street: string | null;
  lot: number;
  owner: number | 'nobody';
  ownerLocal: boolean;
  locked: boolean;
  /** The drivable car standing in for it now (near you, or driven away / damaged), else null: only drawn. */
  v: Vehicle | null;
}

interface TypeMeshes {
  paint: THREE.InstancedMesh; // body panels: white vertex colours times the instance colour
  detail: THREE.InstancedMesh; // glass, trim, lights, tyres (no instance colour)
  n: number;
  cap: number;
}

export interface ParkedState {
  cars: ParkedCar[];
  /** Idle pooled cars by type, ready to stand in for a parked car. */
  free: Record<CarTypeName, Vehicle[]>;
  meshes: Record<CarTypeName, TypeMeshes>;
  // parked cars in a grid of CELL m cells
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  start: Int32Array;
  items: Int32Array;
  refreshT: number;
  lastX: number;
  lastZ: number;
  dirty: boolean;
  stats: { cars: number; kerb: number; lot: number; byClass: Record<string, number>; live: number; drawn: number; poolGrown: number; promoted: number; released: number; pool: number; waterfrontLots: number[] };
}

// ------------------------------------------------------------------------------------------- instanced meshes
const SENTINEL = new THREE.Color(1, 0, 1); // the builder's paint, found again in the vertex colours
/** One car type's geometry split into the paint shell (vertex colours white / 0.8 grey) and everything else. */
function splitCarGeometry(type: CarTypeName): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const spec = V.types[type];
  const b = buildCarBody(type, SENTINEL);
  // static wheels, as on the AI cars
  const tyre = new THREE.Color('#1d1d1f');
  const r = spec.wheelRadius, wy = spec.wheelY - spec.suspensionRest;
  for (const z of [spec.wheelZFront, spec.wheelZRear])
    for (const s of [-1, 1]) {
      const x = s * spec.wheelX;
      b.box(x - 0.13, wy - r, z - r * 0.85, x + 0.13, wy + r, z + r * 0.85, tyre);
    }
  const g = b.build();
  const P = g.getAttribute('position').array as Float32Array, N = g.getAttribute('normal').array as Float32Array, C = g.getAttribute('color').array as Float32Array;
  const pp: number[] = [], pn: number[] = [], pc: number[] = [], dp: number[] = [], dn: number[] = [], dc: number[] = [];
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  for (let t = 0; t < P.length / 9; t++) {
    const i = t * 9;
    const r0 = C[i], g0 = C[i + 1], b0 = C[i + 2];
    const shade = eq(r0, 1) && eq(g0, 0) && eq(b0, 1) ? 1 : eq(r0, 0.8) && eq(g0, 0) && eq(b0, 0.8) ? 0.8 : 0;
    const [tp, tn, tc] = shade ? [pp, pn, pc] : [dp, dn, dc];
    for (let k = 0; k < 9; k++) {
      tp.push(P[i + k]);
      tn.push(N[i + k]);
      tc.push(shade ? shade : C[i + k]);
    }
  }
  const make = (p: number[], n: number[], c: number[]) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    return out;
  };
  g.dispose();
  return { paint: make(pp, pn, pc), detail: make(dp, dn, dc) };
}

function makeMeshes(w: World, type: CarTypeName, cap: number): TypeMeshes {
  const { paint, detail } = splitCarGeometry(type);
  const pm = new THREE.InstancedMesh(paint, carMaterial, cap);
  pm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  const dm = new THREE.InstancedMesh(detail, carMaterial, cap);
  for (const m of [pm, dm]) {
    m.count = 0;
    m.frustumCulled = false; // spread over the streets around you: one bounding sphere would not cull anything
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    w.scene.add(m);
  }
  pm.castShadow = true; // the shell's shadow covers the wheels and windows
  return { paint: pm, detail: dm, n: 0, cap };
}

// ------------------------------------------------------------------------------------------- creation
const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const p4 = new THREE.Vector3();
const e4 = new THREE.Euler();
const ONE = new THREE.Vector3(1, 1, 1);

/** Set a parked car's resting pose from its ground point and heading (pitched to the slope of the street). */
function setPose(w: World, r: ParkedCar): void {
  const spec = V.types[r.type];
  const hz = spec.halfExtents[2] * 0.8, fx = Math.sin(r.heading), fz = Math.cos(r.heading);
  const hf = w.city.heightAt(r.x + fx * hz, r.z + fz * hz, r.y + 1), hb = w.city.heightAt(r.x - fx * hz, r.z - fz * hz, r.y + 1);
  const pitch = Math.abs(hf - hb) < 1.5 ? -Math.atan2(hf - hb, 2 * hz) : 0; // nose up on an uphill kerb
  e4.set(pitch, r.heading, 0, 'YXZ');
  q4.setFromEuler(e4);
  p4.set(r.x, r.y + rideHeight(spec), r.z);
  r.pos[0] = p4.x; r.pos[1] = p4.y; r.pos[2] = p4.z;
  r.rot[0] = q4.x; r.rot[1] = q4.y; r.rot[2] = q4.z; r.rot[3] = q4.w;
  m4.compose(p4, q4, ONE);
  r.mat.set(m4.elements);
}

/**
 * Car parks by the river: those whose bays' middle is within waterfrontLotRange of the waterfront promenade or a
 * plaza (a Set of car park indices). Shared by the parked-car fill and the dealerships (which leave them alone).
 */
export function waterfrontLots(c: CityMap): Set<number> {
  const sum = new Map<number, { x: number; z: number; n: number }>();
  for (const s of c.parkingSpots) {
    if (s.lot < 0) continue;
    const m = sum.get(s.lot) ?? { x: 0, z: 0, n: 0 };
    m.x += s.x; m.z += s.z; m.n++;
    sum.set(s.lot, m);
  }
  const water = c.walk.nodes.filter((n) => n.kind === 'waterfront' || n.kind === 'plaza');
  const out = new Set<number>();
  for (const [lot, m] of sum) {
    const x = m.x / m.n, z = m.z / m.n;
    if (water.some((n) => Math.hypot(n.x - x, n.z - z) < V.waterfrontLotRange)) out.add(lot);
  }
  return out;
}

/**
 * Fill the map's parking spots: kerbside spots by street class at parkedCarsPer100m (a spot stands for its span of
 * kerb), car park bays at lotFill (waterfront car parks at waterfrontLotFill), clear of `keep` (your starting cars,
 * dealership showrooms) and of the spawn. Then the pool of drivable stand-ins and the instanced meshes.
 */
export function createParkedCars(w: World, keep: readonly { x: number; z: number }[]): ParkedState {
  const c = w.city;
  const rng = w.rng.fork(31);
  const per = V.parkedCarsPer100m[c.id] ?? V.parkedCarsPer100m.grid;
  const lotFill = V.lotFill[c.id] ?? 0;
  const start = c.spawn;
  // car parks by the water fill up
  const wlots = waterfrontLots(c);
  const waterfrontLot = (s: ParkingSpot) => wlots.has(s.lot);
  const weights = V.parkedTypeWeights as Record<CarTypeName, number>;
  const wSum = TYPES.reduce((a, t) => a + weights[t], 0);
  const pickType = () => {
    let r = rng.next() * wSum;
    for (const t of TYPES) if ((r -= weights[t]) <= 0) return t;
    return TYPES[0];
  };
  const cars: ParkedCar[] = [];
  const byClass: Record<string, number> = {};
  let kerb = 0, lot = 0;
  for (const s of c.parkingSpots) {
    const chance = s.cls === 'lot' ? (waterfrontLot(s) ? V.waterfrontLotFill : lotFill) : Math.min(1, (per[s.cls] * (s.span ?? V.kerbSlotSpacing)) / 100);
    if (!(chance > 0) || !rng.chance(chance)) continue;
    if (Math.hypot(s.x - start.x, s.z - start.z) < V.parkedClearOfRank) continue;
    if (keep.some((k) => Math.hypot(k.x - s.x, k.z - s.z) < V.kerbSlotSpacing * 0.5)) continue;
    const r: ParkedCar = {
      id: cars.length, type: pickType(), paint: new THREE.Color(rng.pick(PAINTS)), x: s.x, y: s.y, z: s.z, heading: s.heading,
      pos: new Float32Array(3), rot: new Float32Array(4), mat: new Float32Array(16), cls: s.cls, street: s.street, lot: s.lot,
      owner: 'nobody', ownerLocal: false, locked: false, v: null,
    };
    setPose(w, r);
    cars.push(r);
    byClass[s.cls] = (byClass[s.cls] ?? 0) + 1;
    if (s.cls === 'lot') lot++;
    else kerb++;
  }
  // grid of parked cars
  const b = c.bounds;
  const minX = b.minX - 50, minZ = b.minZ - 50;
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX + 100) / CELL)), rows = Math.max(1, Math.ceil((b.maxZ - b.minZ + 100) / CELL));
  const cellOf = (x: number, z: number) => Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / CELL)));
  const startIdx = new Int32Array(cols * rows + 1);
  for (const r of cars) startIdx[cellOf(r.x, r.z) + 1]++;
  for (let k = 0; k < cols * rows; k++) startIdx[k + 1] += startIdx[k];
  const fill = startIdx.slice(0, cols * rows);
  const items = new Int32Array(cars.length);
  for (const r of cars) items[fill[cellOf(r.x, r.z)]++] = r.id;

  // instanced meshes: room for every parked car and every other drivable car of the type
  const meshes = {} as Record<CarTypeName, TypeMeshes>;
  const free = {} as Record<CarTypeName, Vehicle[]>;
  for (const t of TYPES) {
    const n = cars.filter((r) => r.type === t).length;
    meshes[t] = makeMeshes(w, t, n + 64);
    free[t] = [];
  }
  const S: ParkedState = {
    cars, free, meshes, minX, minZ, cols, rows, start: startIdx, items, refreshT: 0, lastX: Infinity, lastZ: Infinity, dirty: true,
    stats: { cars: cars.length, kerb, lot, byClass, live: 0, drawn: 0, poolGrown: 0, promoted: 0, released: 0, pool: 0, waterfrontLots: [...wlots] },
  };
  w.parked = S;
  // the pool of drivable stand-ins (idle until a parked car near you needs one)
  const pool = V.parkedPool as Record<CarTypeName, number>;
  for (const t of TYPES) for (let k = 0; k < pool[t]; k++) free[t].push(makePooled(w, t));
  return S;
}

const AT = { x: 0, y: 0, z: 0 };
const ROT = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };
/** A new pooled car of this type, idle (hidden, body disabled). */
function makePooled(w: World, type: CarTypeName): Vehicle {
  const v = spawnVehicle(w, type, w.city.spawn.x, w.city.spawn.z, 0, SENTINEL);
  v.pooled = true;
  goIdle(v);
  w.parked.stats.pool++;
  return v;
}

function goIdle(v: Vehicle): void {
  v.idle = true;
  v.parked = null;
  v.body.setEnabled(false);
  v.mesh.visible = false;
  v.inst = -1;
  v.px = v.pz = FAR;
  v.py = -FAR;
  v.owner = 'nobody';
  v.ownerLocal = false;
  v.locked = false;
  v.stolen = false;
  v.alarmUntil = 0;
  v.upsideTimer = 0;
  v.speed = 0;
  v.prevVel.set(0, 0, 0);
}

/** A pooled car takes the place of parked car `r` (asleep, exactly where the parked car stands). */
function assign(w: World, v: Vehicle, r: ParkedCar): void {
  if (!v.paint.equals(r.paint)) repaintVehicle(v, r.paint);
  v.idle = false;
  v.parked = r;
  r.v = v;
  AT.x = r.pos[0]; AT.y = r.pos[1]; AT.z = r.pos[2];
  ROT.x = r.rot[0]; ROT.y = r.rot[1]; ROT.z = r.rot[2]; ROT.w = r.rot[3];
  v.body.setEnabled(true);
  v.body.setTranslation(AT, false);
  v.body.setRotation(ROT, false);
  v.body.setLinvel(ZERO, false);
  v.body.setAngvel(ZERO, false);
  v.body.sleep();
  v.px = AT.x; v.py = AT.y; v.pz = AT.z;
  v.heading = r.heading;
  v.speed = 0;
  v.prevVel.set(0, 0, 0);
  v.lastHitTime = -10;
  syncVehicleMesh(v);
  v.owner = r.owner;
  v.ownerLocal = r.ownerLocal;
  v.locked = r.locked;
  v.stolen = false;
  v.alarmUntil = 0;
  v.spotCls = r.cls;
  w.parked.stats.promoted++;
  w.parked.dirty = true;
}

/** Untouched pooled car back to the pool: the parked car keeps where it now stands and its owner and lock. */
function release(w: World, r: ParkedCar): void {
  const v = r.v!;
  const mp = v.mesh.position;
  if (Math.hypot(mp.x - r.pos[0], mp.z - r.pos[2]) > V.parkedReuseGap || Math.abs(mp.y - r.pos[1]) > V.parkedReuseGap) {
    // pushed: park it where it stands now
    r.pos[0] = mp.x; r.pos[1] = mp.y; r.pos[2] = mp.z;
    const mq = v.mesh.quaternion;
    r.rot[0] = mq.x; r.rot[1] = mq.y; r.rot[2] = mq.z; r.rot[3] = mq.w;
    r.x = mp.x; r.z = mp.z; r.y = mp.y - rideHeight(v.spec);
    r.heading = v.heading;
    m4.compose(mp, mq, ONE);
    r.mat.set(m4.elements);
  }
  r.owner = v.owner;
  r.ownerLocal = v.ownerLocal;
  r.locked = v.locked;
  r.v = null;
  goIdle(v);
  w.parked.free[v.type].push(v);
  w.parked.stats.released++;
  w.parked.dirty = true;
}

/**
 * Owners: every parked car belongs to a local (locked at lockedFraction) or, at abandonedFraction, to nobody
 * (unlocked). Each grown-up of the simulated people owns the parked car nearest their home or work (if within
 * ownerHomeRange and they own no other car), so that owner can notice, chase and remember. Own seeded generator.
 */
export function assignParkedOwners(w: World): void {
  const rng = new Rng(w.seed ^ 0x9a2c);
  const S = w.parked;
  for (const r of S.cars) {
    r.owner = 'nobody';
    if (rng.chance(TH.abandonedFraction)) { r.ownerLocal = false; r.locked = false; continue; }
    r.ownerLocal = true;
    r.locked = rng.chance(TH.lockedFraction);
  }
  const hasCar = new Set<number>();
  for (const v of w.vehicles) if (typeof v.owner === 'number') hasCar.add(v.owner);
  const pois = w.city.pois;
  for (const p of w.peds) {
    if (p.archetype === 'kid' || hasCar.has(p.id)) continue;
    const h = pois[p.npc.homePoi], wk = pois[p.npc.workPoi];
    let best: ParkedCar | null = null, bd: number = TH.ownerHomeRange;
    for (const r of S.cars) {
      if (!r.ownerLocal) continue;
      const d = Math.min(Math.hypot(h.x - r.x, h.z - r.z), Math.hypot(wk.x - r.x, wk.z - r.z));
      if (d < bd) { bd = d; best = r; }
    }
    if (!best) continue;
    best.owner = p.id;
    best.ownerLocal = false;
    hasCar.add(p.id);
  }
}

// ------------------------------------------------------------------------------------------- per frame
/** Untouched and parked: drawn as an instance (no own meshes). */
function pristine(w: World, v: Vehicle): boolean {
  if (v.idle || v.driven || v.wrecked || v.health < v.maxHealth) return false;
  const d = v.dmg;
  if (d.dentTotal > 0 || d.crack.visible || d.sideCrack.visible || d.bumpers[0].state !== 0 || d.bumpers[1].state !== 0 || !d.lights[0].visible || !d.lights[1].visible) return false;
  return !(w.player.breakIn && w.player.breakIn.v === v);
}

/** A pooled car that may go back to the pool (untouched, asleep, nobody's business). */
function releasable(w: World, v: Vehicle): boolean {
  return pristine(w, v) && !v.stolen && !v.owned && !v.forSale && v.alarmUntil <= w.time && w.player.vehicle !== v && v.body.isSleeping();
}

const CAND = new Int32Array(256);
const CAND_D = new Float32Array(256);
/** Parked cars without a stand-in within r of (x, z), nearest first, into CAND (returns the count). */
function gather(S: ParkedState, x: number, z: number, r: number): number {
  let n = 0;
  const c0 = Math.max(0, Math.floor((x - r - S.minX) / CELL)), c1 = Math.min(S.cols - 1, Math.floor((x + r - S.minX) / CELL));
  const r0 = Math.max(0, Math.floor((z - r - S.minZ) / CELL)), r1 = Math.min(S.rows - 1, Math.floor((z + r - S.minZ) / CELL));
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
    const ci = row * S.cols + col;
    for (let q = S.start[ci]; q < S.start[ci + 1] && n < CAND.length; q++) {
      const car = S.cars[S.items[q]];
      if (car.v) continue;
      const d = Math.hypot(car.x - x, car.z - z);
      if (d > r) continue;
      // insertion sort by distance (small lists)
      let k = n++;
      while (k > 0 && CAND_D[k - 1] > d) { CAND[k] = CAND[k - 1]; CAND_D[k] = CAND_D[k - 1]; k--; }
      CAND[k] = car.id;
      CAND_D[k] = d;
    }
  }
  return n;
}

/** Give parked car r a drivable stand-in: a free pooled car, else one released from further away, else (must) a new one. */
function promote(w: World, r: ParkedCar, dist: number, must: boolean): boolean {
  const S = w.parked;
  let v = S.free[r.type].pop();
  if (!v) {
    // take the pooled car of this type standing in furthest from you, if it can go and is further than this one
    const pp = w.player.mesh.position;
    let far: ParkedCar | null = null, fd = dist;
    for (const o of w.vehicles) {
      if (!o.pooled || o.idle || o.type !== r.type || !o.parked || !releasable(w, o)) continue;
      const d = Math.hypot(o.px - pp.x, o.pz - pp.z);
      if (d > fd) { fd = d; far = o.parked; }
    }
    if (far) {
      release(w, far);
      v = S.free[r.type].pop();
    } else if (must) {
      v = makePooled(w, r.type);
      S.stats.poolGrown++;
    }
  }
  if (!v) return false;
  assign(w, v, r);
  return true;
}

const AHEAD = { x: 0, z: 0, on: false };
/** Where your car will be parkedAheadTime from now (when driving faster than walking pace). */
function aheadPoint(w: World): void {
  const pv = w.player.vehicle;
  AHEAD.on = false;
  if (!pv) return;
  const vx = pv.prevVel.x, vz = pv.prevVel.z;
  if (vx * vx + vz * vz < 9) return;
  AHEAD.x = pv.px + vx * V.parkedAheadTime;
  AHEAD.z = pv.pz + vz * V.parkedAheadTime;
  AHEAD.on = true;
}

const PROMOTE_PER_FRAME = 6;
/** Per frame: stand-ins for the parked cars around you (and ahead of your car), releases, and the instance draw lists. */
export function updateParkedCars(w: World, dt: number): void {
  const S = w.parked;
  const pp = w.player.mesh.position;
  aheadPoint(w);
  // 1) parked cars right next to you always get a drivable car (E must work on every one)
  let n = gather(S, pp.x, pp.z, V.parkedMustRadius);
  for (let i = 0; i < n; i++) promote(w, S.cars[CAND[i]], CAND_D[i], true);
  // 2) the rest around you and ahead, nearest first, a few per frame, while the pool lasts
  let budget = PROMOTE_PER_FRAME;
  n = gather(S, pp.x, pp.z, V.parkedLiveRadius);
  for (let i = 0; i < n && budget > 0; i++) if (promote(w, S.cars[CAND[i]], CAND_D[i], false)) budget--;
  if (AHEAD.on && budget > 0) {
    n = gather(S, AHEAD.x, AHEAD.z, V.parkedAheadRadius);
    for (let i = 0; i < n && budget > 0; i++) if (promote(w, S.cars[CAND[i]], Math.hypot(S.cars[CAND[i]].x - pp.x, S.cars[CAND[i]].z - pp.z), false)) budget--;
  }
  // 3) now and then: release untouched stand-ins you left behind, redraw the far ones
  S.refreshT -= dt;
  const moved = Math.hypot(pp.x - S.lastX, pp.z - S.lastZ) > 12;
  if (S.refreshT <= 0 || moved) {
    S.refreshT = V.parkedRefresh;
    const R = V.parkedReleaseRadius;
    for (const v of w.vehicles) {
      if (!v.pooled || v.idle || !v.parked) continue;
      if (Math.hypot(v.px - pp.x, v.pz - pp.z) < R) continue;
      if (AHEAD.on && Math.hypot(v.px - AHEAD.x, v.pz - AHEAD.z) < V.parkedAheadRadius) continue;
      if (releasable(w, v)) release(w, v.parked);
    }
    S.dirty = true;
  }
  // 4) a car that was just driven, dented or broken into shows its own meshes now (and an untouched one stops)
  for (const v of w.vehicles) {
    if (v.idle) continue;
    const p = pristine(w, v);
    if (p ? v.mesh.visible : v.inst >= 0 || !v.mesh.visible) S.dirty = true;
  }
  if (S.dirty) redraw(w);
  else followMovingInstances(w);
}

/** Rebuild the instance lists: parked cars within the draw distance, and untouched drivable cars drawn as instances. */
function redraw(w: World): void {
  const S = w.parked;
  S.dirty = false;
  const pp = w.player.mesh.position;
  S.lastX = pp.x;
  S.lastZ = pp.z;
  const R = (V.parkedDrawDistance as Record<string, number>)[w.settings.quality] ?? V.parkedDrawDistance.medium;
  for (const t of TYPES) S.meshes[t].n = 0;
  let drawn = 0, live = 0;
  for (const r of S.cars) {
    if (r.v) continue;
    if (Math.abs(r.x - pp.x) > R || Math.abs(r.z - pp.z) > R || Math.hypot(r.x - pp.x, r.z - pp.z) > R) continue;
    const M = S.meshes[r.type];
    if (M.n >= M.cap) continue;
    writeInstance(M, M.n++, r.mat, r.paint);
    drawn++;
  }
  for (const v of w.vehicles) {
    if (v.idle) { v.inst = -1; continue; }
    if (v.pooled) live++;
    if (!pristine(w, v)) { v.inst = -1; v.mesh.visible = true; continue; }
    v.mesh.visible = false; // untouched: drawn as an instance (or not at all beyond the draw distance)
    v.inst = -1;
    if (Math.hypot(v.px - pp.x, v.pz - pp.z) > R) continue;
    const M = S.meshes[v.type];
    if (M.n >= M.cap) continue;
    v.inst = M.n++;
    v.mesh.updateMatrix();
    writeInstance(M, v.inst, v.mesh.matrix.elements as unknown as Float32Array, v.paint);
    drawn++;
  }
  for (const t of TYPES) {
    const M = S.meshes[t];
    M.paint.count = M.detail.count = M.n;
    M.paint.instanceMatrix.needsUpdate = M.detail.instanceMatrix.needsUpdate = true;
    if (M.paint.instanceColor) M.paint.instanceColor.needsUpdate = true;
  }
  S.stats.drawn = drawn;
  S.stats.live = live;
}

function writeInstance(M: TypeMeshes, i: number, mat: ArrayLike<number>, paint: THREE.Color): void {
  const a = M.paint.instanceMatrix.array as Float32Array, b = M.detail.instanceMatrix.array as Float32Array;
  for (let k = 0; k < 16; k++) a[i * 16 + k] = b[i * 16 + k] = mat[k];
  const c = M.paint.instanceColor!.array as Float32Array;
  c[i * 3] = paint.r;
  c[i * 3 + 1] = paint.g;
  c[i * 3 + 2] = paint.b;
}

/** Untouched drivable cars that are moving (bumped, rolling) carry their instance with them. */
function followMovingInstances(w: World): void {
  const S = w.parked;
  for (const v of w.vehicles) {
    if (v.inst < 0 || v.idle || v.body.isSleeping()) continue;
    const M = S.meshes[v.type];
    v.mesh.updateMatrix();
    writeInstance(M, v.inst, v.mesh.matrix.elements as unknown as Float32Array, v.paint);
    M.paint.instanceMatrix.needsUpdate = M.detail.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Take an idle pooled car out of the pool for good (dealership restocking), parked at (x, z) facing `heading`,
 * repainted. The pool grows again only if parked cars near you ever need more stand-ins than are left.
 */
export function takePooledCar(w: World, type: CarTypeName, x: number, y: number, z: number, heading: number, paint: THREE.Color): Vehicle {
  const S = w.parked;
  const v = S.free[type].pop() ?? makePooled(w, type);
  if (!v.paint.equals(paint)) repaintVehicle(v, paint);
  v.pooled = false;
  v.idle = false;
  v.parked = null;
  q4.setFromAxisAngle(p4.set(0, 1, 0), heading);
  AT.x = x; AT.y = y + rideHeight(v.spec); AT.z = z;
  ROT.x = q4.x; ROT.y = q4.y; ROT.z = q4.z; ROT.w = q4.w;
  v.body.setEnabled(true);
  v.body.setTranslation(AT, true);
  v.body.setRotation(ROT, true);
  v.body.setLinvel(ZERO, true);
  v.body.setAngvel(ZERO, true);
  v.px = AT.x; v.py = AT.y; v.pz = AT.z;
  v.heading = heading;
  syncVehicleMesh(v);
  S.stats.pool--;
  S.dirty = true;
  return v;
}

/** Parked cars on the minimap / tests: the parked car record a drivable car stands in for, if any. */
export function parkedCarOf(v: Vehicle): ParkedCar | null {
  return v.parked;
}
