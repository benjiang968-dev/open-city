// AI traffic on the road graph. Cars are dynamic bodies steered by setting velocity along their lane edge
// (map.roads), so the player can shove them; they stop at junctions, keep a gap, honk at and swerve from the player.
// At a junction a car picks its next lane from the node's outgoing edges (never straight back the way it came,
// unless it is a dead end) and follows a curve from its stop line to the next lane's start.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import { laneSample, type LaneEdge, type LanePoint } from './map/cityMap';
import { makeAiCarGeometry, carMaterial } from '../art/car';
import { GROUPS } from '../physicsGroups';

const TT = TUNING.traffic;
const TURN_SEGS = 8; // segments on a junction curve

export interface AiCar {
  id: number;
  kind: 'traffic' | 'police';
  type: CarTypeName;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Mesh;
  meshYOffset: number;
  halfW: number;
  halfL: number;
  /** Lane edge being driven (while waiting or turning: the edge being left). */
  edge: number;
  /** Lane edge after the coming junction, -1 until chosen. */
  next: number;
  phase: 'lane' | 'wait' | 'turn';
  /** 'lane'/'wait': distance along the edge's pts; 'turn': distance along the junction curve. */
  s: number;
  turnPts: Float32Array; // x,z pairs of the current junction curve (preallocated)
  turnCum: Float32Array;
  turnLen: number;
  speed: number;
  heading: number;
  waitT: number;
  honkCd: number;
  blockedT: number;
  swerve: number;
  swerveT: number;
  stunT: number;
  stuckT: number;
  lastSetHeading: number; // heading last written to the physics body
  px: number; // cached position, refreshed once per physics step (avoids allocating translation() calls)
  pz: number;
  /** Optional route chooser at junctions: returns the next lane edge id (police head for the player). */
  chooser?: (car: AiCar) => number;
}
export type TrafficCar = AiCar;

const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
const LP2: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

// ---------- lane geometry ----------
/** Where a lane's drivable part starts (cars leave the junction at `from` here). */
export function laneStart(e: LaneEdge): number {
  return Math.min(e.trimStart, e.len * 0.5);
}
/** Where a lane's drivable part ends: the stop line before the junction at `to`. */
export function stopLine(e: LaneEdge): number {
  return Math.max(laneStart(e), e.len - e.trimEnd);
}

/** True when the next lane does not continue where this one stops, so a junction curve is needed. */
function needsTurn(e: LaneEdge, n: LaneEdge): boolean {
  laneSample(e, stopLine(e), LP);
  laneSample(n, laneStart(n), LP2);
  const dh = Math.abs(Math.atan2(Math.sin(LP2.heading - LP.heading), Math.cos(LP2.heading - LP.heading)));
  return Math.hypot(LP2.x - LP.x, LP2.z - LP.z) > 0.5 || dh > 0.6;
}

/** Junction curve from the stop line of `car.edge` to the start of `car.next` (a quadratic Bezier). */
function buildTurn(w: World, car: AiCar): void {
  const edges = w.city.roads.edges;
  const e = edges[car.edge], n = edges[car.next];
  const a = laneSample(e, stopLine(e), LP), b = laneSample(n, laneStart(n), LP2);
  const d1x = Math.sin(a.heading), d1z = Math.cos(a.heading), d2x = Math.sin(b.heading), d2z = Math.cos(b.heading);
  const rx = b.x - a.x, rz = b.z - a.z, gap = Math.hypot(rx, rz);
  const cross = d1x * d2z - d1z * d2x, dot = d1x * d2x + d1z * d2z;
  // control point: where the two lane lines meet (the corner); a U-turn bulges forward; straight on: the middle
  let cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
  if (dot < -0.5) {
    cx += d1x * gap * 0.9;
    cz += d1z * gap * 0.9;
  } else if (Math.abs(cross) > 0.05) {
    const t = (rx * d2z - rz * d2x) / cross;
    if (t > 0 && t < gap * 2) { cx = a.x + d1x * t; cz = a.z + d1z * t; }
  }
  const P = car.turnPts, C = car.turnCum;
  for (let k = 0; k <= TURN_SEGS; k++) {
    const t = k / TURN_SEGS, u = 1 - t;
    P[k * 2] = u * u * a.x + 2 * u * t * cx + t * t * b.x;
    P[k * 2 + 1] = u * u * a.z + 2 * u * t * cz + t * t * b.z;
    C[k] = k === 0 ? 0 : C[k - 1] + Math.hypot(P[k * 2] - P[k * 2 - 2], P[k * 2 + 1] - P[k * 2 - 1]);
  }
  car.turnLen = Math.max(0.01, C[TURN_SEGS]);
}

/** Point at distance s along the junction curve (x and z of `out`). */
function turnPoint(car: AiCar, s: number, out: LanePoint): void {
  const P = car.turnPts, C = car.turnCum;
  if (s <= 0) { out.x = P[0]; out.z = P[1]; return; }
  for (let k = 1; k <= TURN_SEGS; k++) {
    if (s <= C[k]) {
      const t = (s - C[k - 1]) / Math.max(1e-6, C[k] - C[k - 1]);
      out.x = P[k * 2 - 2] + (P[k * 2] - P[k * 2 - 2]) * t;
      out.z = P[k * 2 - 1] + (P[k * 2 + 1] - P[k * 2 - 1]) * t;
      return;
    }
  }
  out.x = P[TURN_SEGS * 2];
  out.z = P[TURN_SEGS * 2 + 1];
}

/** Going straight back along the road just driven (its twin, or another lane of the same road). */
export function isUTurn(e: LaneEdge, n: LaneEdge): boolean {
  return n.id === e.twin || (n.to === e.from && n.roadId === e.roadId);
}

/** Random next lane at the end of the car's edge: never back the way it came unless it's a dead end. */
export function pickNext(w: World, car: AiCar, rng: () => number): number {
  const { nodes, edges } = w.city.roads;
  const e = edges[car.edge];
  const out = nodes[e.to].out;
  let n = 0;
  for (let i = 0; i < out.length; i++) if (!isUTurn(e, edges[out[i]])) n++;
  if (n === 0) return e.twin >= 0 ? e.twin : out.length ? out[Math.floor(rng() * out.length)] : -1;
  let k = Math.floor(rng() * n);
  for (let i = 0; i < out.length; i++) {
    if (isUTurn(e, edges[out[i]])) continue;
    if (k-- === 0) return out[i];
  }
  return -1;
}

// ---------- creation ----------
export function createAiCar(w: World, kind: 'traffic' | 'police', type: CarTypeName, paint: THREE.Color, edge: number, s0: number): AiCar {
  const R = w.R;
  const spec = TUNING.vehicles.types[type];
  const [hx, , hz] = spec.halfExtents;
  const halfH = 0.6;
  const rideY = -spec.wheelY + spec.suspensionRest * 0.75 + spec.wheelRadius + 0.02;
  const body = w.physics.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(0, halfH + 0.02, 0).enabledRotations(false, true, false).setLinearDamping(0.4).setAngularDamping(2).setCcdEnabled(false), // AI cars are slow: no CCD
  );
  const collider = w.physics.createCollider(
    R.ColliderDesc.cuboid(hx, halfH, hz).setMass(spec.mass).setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0.1).setCollisionGroups(GROUPS.ai),
    body,
  );
  const geo = makeAiCarGeometry(type, paint, { r: spec.wheelRadius, x: spec.wheelX, zf: spec.wheelZFront, zr: spec.wheelZRear, y: spec.wheelY - spec.suspensionRest * 0.75 }, kind === 'police' ? { police: true } : undefined);
  const mesh = new THREE.Mesh(geo, carMaterial);
  mesh.castShadow = true;
  w.scene.add(mesh);
  const car: AiCar = {
    id: kind === 'police' ? w.police?.cars?.length ?? 0 : w.traffic.length, kind, type, body, collider, mesh, meshYOffset: rideY - halfH, halfW: hx, halfL: hz,
    edge, next: -1, phase: 'lane', s: 0, turnPts: new Float32Array((TURN_SEGS + 1) * 2), turnCum: new Float32Array(TURN_SEGS + 1), turnLen: 0.01,
    speed: 0, heading: 0, waitT: 0, honkCd: 0, blockedT: 0, swerve: 0, swerveT: 0, stunT: 0, stuckT: 0, px: 0, pz: 0, lastSetHeading: NaN,
  };
  placeOnEdge(w, car, edge, s0);
  return car;
}

/** Put the car on a lane, `s0` metres past the lane's start (the previous junction), at rest. */
export function placeOnEdge(w: World, car: AiCar, edge: number, s0: number): void {
  const e = w.city.roads.edges[edge];
  car.edge = edge;
  car.next = -1;
  car.phase = 'lane';
  car.s = Math.max(laneStart(e), Math.min(laneStart(e) + s0, stopLine(e) - 1));
  const p = laneSample(e, car.s, LP);
  car.heading = p.heading;
  car.body.setTranslation({ x: p.x, y: p.y + 0.62, z: p.z }, true);
  car.body.setRotation(yawQuat(car.heading), true);
  car.lastSetHeading = car.heading;
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.px = p.x;
  car.pz = p.z;
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.speed = 0;
  car.stunT = 0;
  car.stuckT = 0;
  car.swerve = 0;
  syncAi(car);
}

/** Random lane placement away from the player (used for spawning and recycling). */
export function placeRandom(w: World, car: AiCar, minDist: number, rng: () => number): void {
  const { nodes, edges } = w.city.roads;
  const pp = w.player.mesh.position;
  for (let tries = 0; tries < 60; tries++) {
    const a = nodes[Math.floor(rng() * nodes.length)];
    if (!a.out.length) continue;
    const e = edges[a.out[Math.floor(rng() * a.out.length)]];
    const laneLen = stopLine(e) - laneStart(e);
    if (laneLen < 20) continue; // too short to start on
    const s0 = 5 + rng() * Math.max(1, laneLen - 15);
    const p = laneSample(e, laneStart(e) + s0, LP);
    const mx = p.x, mz = p.z;
    if (Math.hypot(mx - pp.x, mz - pp.z) < minDist) continue;
    // not on top of another AI car
    let clash = false;
    for (const o of w.traffic) if (o !== car && Math.hypot(o.px - mx, o.pz - mz) < 12) clash = true;
    for (const o of w.police?.cars ?? []) if (o !== car && Math.hypot(o.px - mx, o.pz - mz) < 12) clash = true;
    if (clash) continue;
    placeOnEdge(w, car, e.id, s0);
    return;
  }
}

/** A lane long enough to park a car on before placeRandom moves it (spawning). */
export function anyLane(w: World): number {
  const i = w.city.roads.edges.findIndex((e) => stopLine(e) - laneStart(e) > 2);
  return Math.max(0, i);
}

export function spawnTraffic(w: World): void {
  const rng = w.rng.fork(55);
  const r = () => rng.next();
  const paints = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#2a9d8f', '#e9c46a', '#f4a261', '#8d99ae', '#ffffff', '#3d405b', '#81b29a'];
  const types: CarTypeName[] = ['hatchback', 'sedan', 'sedan', 'pickup'];
  const first = anyLane(w);
  for (let k = 0; k < TT.count; k++) {
    const car = createAiCar(w, 'traffic', rng.pick(types), new THREE.Color(rng.pick(paints)), first, 0);
    car.id = k;
    w.traffic.push(car);
    w.colliderOwner.set(car.collider.handle, { kind: 'traffic', id: k });
    placeRandom(w, car, TT.spawnMinDistFromPlayer, r);
  }
}

// ---------- driving ----------
const fwd = new THREE.Vector2();
const tgt: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

// reusable scratch objects so the per-step code allocates nothing
const ROT = { x: 0, y: 0, z: 0, w: 1 };
const VEL = { x: 0, y: 0, z: 0 };
/** Rotation about Y as a Rapier quaternion (shared object: use immediately). */
export function yawQuat(h: number) {
  ROT.x = 0; ROT.y = Math.sin(h / 2); ROT.z = 0; ROT.w = Math.cos(h / 2);
  return ROT;
}
export function velXZ(x: number, y: number, z: number) {
  VEL.x = x; VEL.y = y; VEL.z = z;
  return VEL;
}
/** Yaw angle of a quaternion. */
export function yawOf(r: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
}

/** Refresh cached positions of AI cars and drivable vehicles once per physics step. */
export function cachePositions(w: World): void {
  for (const c of w.traffic) { const t = c.body.translation(); c.px = t.x; c.pz = t.z; }
  for (const c of w.police.cars ?? []) { const t = c.body.translation(); c.px = t.x; c.pz = t.z; }
}

const OB = { dist: 0, player: false };
/**
 * Distance to the nearest obstacle ahead in this car's lane (Infinity if clear) and whether it is the player.
 * Returns a shared object: read it immediately. Written as flat loops with no helper calls: passing
 * doubles to a non-inlined helper boxes them, which made this the biggest allocator in the game.
 */
export function obstacleAhead(w: World, car: AiCar, look: number): { dist: number; player: boolean } {
  const px = car.px, pz = car.pz, fx = Math.sin(car.heading), fz = Math.cos(car.heading), half = car.halfL;
  let best = Infinity, isPlayer = false;
  const traffic = w.traffic;
  for (let i = 0; i < traffic.length; i++) {
    const o = traffic[i];
    if (o === car) continue;
    const rx = o.px - px, rz = o.pz - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + o.halfL || Math.abs(rx * fz - rz * fx) > 2.3) continue;
    const d = along - o.halfL - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  const police = w.police.cars;
  for (let i = 0; i < police.length; i++) {
    const o = police[i];
    if (o === car) continue;
    const rx = o.px - px, rz = o.pz - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + o.halfL || Math.abs(rx * fz - rz * fx) > 2.3) continue;
    const d = along - o.halfL - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  const vehicles = w.vehicles;
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const hl = v.spec.halfExtents[2];
    const rx = v.px - px, rz = v.pz - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + hl || Math.abs(rx * fz - rz * fx) > 2.4) continue;
    const d = along - hl - half;
    if (d < best) { best = d; isPlayer = v.driven; }
  }
  const peds = w.peds;
  for (let i = 0; i < peds.length; i++) {
    const p = peds[i];
    if (!p.active || p.hidden || p.state === 'down') continue;
    const rx = p.pos.x - px, rz = p.pos.z - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + 0.3 || Math.abs(rx * fz - rz * fx) > 1.7) continue;
    const d = along - 0.3 - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  if (!w.player.vehicle) {
    const pp = w.player.mesh.position;
    const rx = pp.x - px, rz = pp.z - pz, along = rx * fx + rz * fz;
    if (along > 0 && along <= look + 0.3 && Math.abs(rx * fz - rz * fx) <= 1.8) {
      const d = along - 0.3 - half;
      if (d < best) { best = d; isPlayer = true; }
    }
  }
  OB.dist = best;
  OB.player = isPlayer;
  return OB;
}

/** Choose the lane after the coming junction (the chooser if the car has one, else at random). */
function chooseNext(w: World, car: AiCar, rng: () => number): void {
  if (car.next >= 0) return;
  car.next = car.chooser ? car.chooser(car) : pickNext(w, car, rng);
}

/** Leave the junction curve (or a seamless node) onto `car.next`, carrying over `extra` metres. */
function enterNext(w: World, car: AiCar, extra: number): void {
  const n = w.city.roads.edges[car.next];
  car.edge = car.next;
  car.next = -1;
  car.phase = 'lane';
  car.s = laneStart(n) + Math.max(0, extra);
}

/**
 * How long to stop before entering `n` at the end of `e`: -1 = don't stop (police, flowing round a roundabout,
 * a plain bend), 0 = yield only (joining a roundabout), else the junction wait.
 */
function waitBefore(w: World, e: LaneEdge, n: LaneEdge, isTraffic: boolean): number {
  if (!isTraffic || e.roundabout) return -1;
  if (n.roundabout) return 0;
  return w.city.roads.nodes[e.to].junction ? TT.intersectionWait : -1;
}

/** Steers the body along its lane at `want` m/s. Handles lane/junction transitions. */
export function driveAlongPath(w: World, car: AiCar, want: number, dt: number, rng: () => number, isTraffic: boolean): void {
  const edges = w.city.roads.edges;
  const accel = car.kind === 'police' ? TUNING.police.accel : TT.accel;
  if (want > car.speed) car.speed = Math.min(want, car.speed + accel * dt);
  else car.speed = Math.max(want, car.speed - TT.brake * dt);
  car.s += car.speed * dt;
  let e = edges[car.edge];
  if (car.phase === 'lane') {
    const stop = stopLine(e);
    if (car.s >= stop) {
      chooseNext(w, car, rng);
      if (car.next < 0) car.s = stop; // nowhere to go (broken data): stand at the stop line
      else if (!needsTurn(e, edges[car.next])) {
        enterNext(w, car, car.s - stop); // the road just continues
        e = edges[car.edge];
      } else {
        const wait = waitBefore(w, e, edges[car.next], isTraffic);
        if (wait >= 0) {
          car.phase = 'wait';
          car.waitT = wait;
          car.s = stop;
        } else {
          car.phase = 'turn';
          car.s -= stop;
          buildTurn(w, car);
        }
      }
    }
  } else if (car.phase === 'turn' && car.s >= car.turnLen) {
    enterNext(w, car, car.s - car.turnLen);
    e = edges[car.edge];
  }
  // follow a point a little ahead on the path
  const look = car.s + 2.5 + car.speed * 0.25;
  if (car.phase === 'turn') {
    if (look <= car.turnLen) turnPoint(car, look, tgt);
    else laneSample(edges[car.next], laneStart(edges[car.next]) + look - car.turnLen, tgt);
  } else {
    const stop = stopLine(e);
    if (look > stop && car.phase === 'lane') chooseNext(w, car, rng);
    if (look > stop && car.next >= 0 && car.phase === 'lane' && !needsTurn(e, edges[car.next])) {
      laneSample(edges[car.next], laneStart(edges[car.next]) + look - stop, tgt);
    } else laneSample(e, Math.min(look, stop + 0.01), tgt);
  }
  let tx = tgt.x, tz = tgt.z;
  // swerve offset to the right of the path
  if (car.swerve !== 0) {
    const dx = tx - car.px, dz = tz - car.pz, dl = Math.hypot(dx, dz) || 1;
    tx += (-dz / dl) * car.swerve;
    tz += (dx / dl) * car.swerve;
  }
  fwd.set(tx - car.px, tz - car.pz);
  const dist = fwd.length();
  if (dist > 0.01) fwd.multiplyScalar(1 / dist);
  // if we drifted far from our path (e.g. after being shoved) rejoin more aggressively
  const desiredHeading = Math.atan2(fwd.x, fwd.y);
  const dh = Math.atan2(Math.sin(desiredHeading - car.heading), Math.cos(desiredHeading - car.heading));
  const turnRate = car.speed > 0.5 ? Math.min(3.0, 1.5 + car.speed * 0.15) : 0;
  car.heading += THREE.MathUtils.clamp(dh * 4 * dt, -turnRate * dt, turnRate * dt);
  const lv = car.body.linvel();
  car.body.setLinvel(velXZ(Math.sin(car.heading) * car.speed, lv.y, Math.cos(car.heading) * car.speed), true);
  // every Rapier write allocates: only push the rotation when the heading actually changed
  if (Math.abs(car.heading - car.lastSetHeading) > 1e-4) {
    car.lastSetHeading = car.heading;
    car.body.setRotation(yawQuat(car.heading), true);
  }
}

/** Start the junction curve after waiting at a stop line. */
function startTurn(w: World, car: AiCar): void {
  car.phase = 'turn';
  car.s = 0;
  buildTurn(w, car);
}

/** After a collision the car is "stunned": physics moves it freely for a moment. */
export function stunCheck(car: AiCar, dt: number): boolean {
  const lv = car.body.linvel();
  const expected = car.speed;
  const actual = Math.hypot(lv.x, lv.z);
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  const lateral = Math.abs(lv.x * fz - lv.z * fx);
  if (car.stunT <= 0 && (lateral > 2.5 || actual > expected + 3)) {
    car.stunT = 2.5;
  }
  if (car.stunT > 0) {
    car.stunT -= dt;
    const r = car.body.rotation();
    car.heading = yawOf(r);
    car.speed = Math.hypot(lv.x, lv.z) * 0.9;
    // friction substitute: slow down while sliding
    car.body.setLinvel(velXZ(lv.x * (1 - 2.5 * dt), lv.y, lv.z * (1 - 2.5 * dt)), true);
    return true;
  }
  return false;
}

export function updateTraffic(w: World, dt: number): void {
  cachePositions(w);
  const rng = Math.random;
  const pv = w.player.vehicle;
  const pp = w.player.mesh.position;
  const { nodes, edges } = w.city.roads;
  for (const car of w.traffic) {
    car.honkCd -= dt;
    if (stunCheck(car, dt)) {
      if (car.stunT <= 0) {
        // shoved off its lane: recycle somewhere out of sight
        placeRandom(w, car, 90, rng);
      }
      continue;
    }
    const e = edges[car.edge];
    let want = e.speed;
    if (car.phase === 'wait') {
      want = 0;
      car.waitT -= dt;
      // one car at a time through each junction
      const node = e.to;
      let nodeBusy = false;
      for (const o of w.traffic) if (o !== car && o.phase === 'turn' && edges[o.edge].to === node) nodeBusy = true;
      for (const o of w.police.cars ?? []) if (o !== car && o.phase === 'turn' && edges[o.edge].to === node) nodeBusy = true;
      if (car.waitT <= 0 && !nodeBusy) startTurn(w, car);
    } else {
      // slow for turns and when approaching a stop line
      if (car.phase === 'turn') want = Math.min(want, 6.5);
      else {
        // (never on a roundabout ring: cars there flow through every node, see waitBefore)
        const to = nodes[e.to];
        if (!e.roundabout && (to.junction || to.deadEnd || to.roundabout)) {
          const remaining = stopLine(e) - car.s;
          want = Math.min(want, Math.sqrt(2 * TT.brake * 0.6 * Math.max(0, remaining)) + 1);
        }
      }
    }
    const ob = obstacleAhead(w, car, TT.followGap + car.speed * 1.2);
    if (ob.dist < Infinity) want = Math.min(want, Math.max(0, (ob.dist - 2.5) * 0.9));
    // honk at a player who blocks the way
    if (ob.player && car.speed < 1 && ob.dist < TT.honkDistance) {
      car.blockedT += dt;
      if (car.blockedT > 1.2 && car.honkCd <= 0) {
        car.honkCd = TT.honkCooldown;
        w.audio.horn?.(car.px, car.pz);
      }
    } else car.blockedT = 0;
    // swerve away from a player car charging at us
    if (pv) {
      const dx = car.px - pp.x, dz = car.pz - pp.z;
      const d = Math.hypot(dx, dz);
      const plv = pv.body.linvel();
      const closing = (plv.x * dx + plv.z * dz) / Math.max(1, d);
      if (d < TT.swerveDistance && closing > TT.swerveSpeed && car.swerveT <= 0) {
        car.swerveT = 1.4;
        if (car.honkCd <= 0) { car.honkCd = TT.honkCooldown; w.audio.horn?.(car.px, car.pz); }
      }
    }
    if (car.swerveT > 0) {
      car.swerveT -= dt;
      car.swerve += (TT.swerveOffset - car.swerve) * Math.min(1, dt * 5);
      want = Math.min(want, 4);
    } else car.swerve += (0 - car.swerve) * Math.min(1, dt * 2);

    driveAlongPath(w, car, want, dt, rng, true);

    // stuck for ages (e.g. gridlocked behind a parked player car) or nowhere to go: recycle
    if (car.speed < 0.3 && car.phase !== 'wait') car.stuckT += dt;
    else car.stuckT = 0;
    if (car.stuckT > 25) placeRandom(w, car, 90, rng);
  }
}

export function syncAi(car: AiCar): void {
  const t = car.body.translation();
  const r = car.body.rotation();
  car.mesh.position.set(t.x, t.y + car.meshYOffset, t.z);
  car.mesh.quaternion.set(r.x, r.y, r.z, r.w);
}

export function syncTraffic(w: World): void {
  for (const car of w.traffic) syncAi(car);
}
