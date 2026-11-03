// AI traffic on the road graph. Cars are dynamic bodies steered by setting velocity along a lane path,
// so the player can shove them; they stop at junctions, keep a gap, honk at and swerve from the player.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import type { RoadNode } from './cityGen';
import { makeAiCarGeometry, carMaterial } from '../art/car';
import { GROUPS } from '../physicsGroups';

const TT = TUNING.traffic;

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
  from: number; // node ids
  to: number;
  next: number;
  phase: 'lane' | 'wait' | 'turn';
  path: THREE.Vector2[];
  cum: number[]; // cumulative lengths along path
  s: number; // distance along path
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
  /** Optional route chooser at junctions (police use BFS toward the player). */
  chooser?: (car: AiCar) => number;
}
export type TrafficCar = AiCar;

const tmpA = new THREE.Vector2();
const tmpB = new THREE.Vector2();

// ---------- lane geometry ----------
function laneEnds(w: World, a: RoadNode, b: RoadNode, offset: number): [THREE.Vector2, THREE.Vector2] {
  const c = w.city;
  const dx = Math.sign(b.x - a.x), dz = Math.sign(b.z - a.z);
  const rx = -dz, rz = dx; // right-hand side
  const stopA = (dx !== 0 ? c.roadHalfX[a.i] : c.roadHalfZ[a.j]) + 3.2;
  const stopB = (dx !== 0 ? c.roadHalfX[b.i] : c.roadHalfZ[b.j]) + 3.2;
  return [
    new THREE.Vector2(a.x + dx * stopA + rx * offset, a.z + dz * stopA + rz * offset),
    new THREE.Vector2(b.x - dx * stopB + rx * offset, b.z - dz * stopB + rz * offset),
  ];
}

function setPath(car: AiCar, pts: THREE.Vector2[]) {
  car.path = pts;
  car.cum = [0];
  for (let k = 1; k < pts.length; k++) car.cum.push(car.cum[k - 1] + pts[k].distanceTo(pts[k - 1]));
  car.s = 0;
}

function lanePath(w: World, car: AiCar) {
  const a = w.city.nodes[car.from], b = w.city.nodes[car.to];
  const [p0, p1] = laneEnds(w, a, b, TT.laneOffset);
  setPath(car, [p0, p1]);
}

function turnPath(w: World, car: AiCar) {
  const n = w.city.nodes;
  const [, p0] = laneEnds(w, n[car.from], n[car.to], TT.laneOffset);
  const [p2] = laneEnds(w, n[car.to], n[car.next], TT.laneOffset);
  const d1 = tmpA.set(Math.sign(n[car.to].x - n[car.from].x), Math.sign(n[car.to].z - n[car.from].z));
  const ctrl = p0.clone().addScaledVector(d1, tmpB.copy(p2).sub(p0).dot(d1));
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8, u = 1 - t;
    pts.push(new THREE.Vector2(u * u * p0.x + 2 * u * t * ctrl.x + t * t * p2.x, u * u * p0.y + 2 * u * t * ctrl.y + t * t * p2.y));
  }
  setPath(car, pts);
}

function pickNext(w: World, car: AiCar, rng: () => number): number {
  const node = w.city.nodes[car.to];
  const opts = node.nbrs.filter((id) => id !== car.from);
  return opts.length ? opts[Math.floor(rng() * opts.length)] : car.from;
}

function pointAt(car: AiCar, s: number, out: THREE.Vector2): THREE.Vector2 {
  const c = car.cum;
  if (s <= 0) return out.copy(car.path[0]);
  for (let k = 1; k < c.length; k++) {
    if (s <= c[k]) {
      const t = (s - c[k - 1]) / Math.max(1e-6, c[k] - c[k - 1]);
      return out.copy(car.path[k - 1]).lerp(car.path[k], t);
    }
  }
  return out.copy(car.path[car.path.length - 1]);
}

// ---------- creation ----------
export function createAiCar(w: World, kind: 'traffic' | 'police', type: CarTypeName, paint: THREE.Color, from: number, to: number, s0: number): AiCar {
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
    from, to, next: -1, phase: 'lane', path: [], cum: [], s: 0, speed: 0, heading: 0, waitT: 0, honkCd: 0, blockedT: 0,
    swerve: 0, swerveT: 0, stunT: 0, stuckT: 0, px: 0, pz: 0, lastSetHeading: NaN,
  };
  placeOnEdge(w, car, from, to, s0);
  return car;
}

export function placeOnEdge(w: World, car: AiCar, from: number, to: number, s0: number): void {
  car.from = from;
  car.to = to;
  car.phase = 'lane';
  lanePath(w, car);
  car.s = Math.min(s0, car.cum[car.cum.length - 1] - 1);
  const p = pointAt(car, car.s, tmpA);
  const d = car.path[1].clone().sub(car.path[0]).normalize();
  car.heading = Math.atan2(d.x, d.y);
  car.body.setTranslation({ x: p.x, y: 0.62, z: p.y }, true);
  car.body.setRotation(yawQuat(car.heading), true);
  car.lastSetHeading = car.heading;
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.px = p.x;
  car.pz = p.y;
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.speed = 0;
  car.stunT = 0;
  car.stuckT = 0;
  car.swerve = 0;
  syncAi(car);
}

/** Random edge placement away from the player (used for spawning and recycling). */
export function placeRandom(w: World, car: AiCar, minDist: number, rng: () => number): void {
  const nodes = w.city.nodes;
  const pp = w.player.mesh.position;
  for (let tries = 0; tries < 60; tries++) {
    const a = nodes[Math.floor(rng() * nodes.length)];
    const b = nodes[a.nbrs[Math.floor(rng() * a.nbrs.length)]];
    const len = Math.hypot(b.x - a.x, b.z - a.z) - 25;
    const s0 = 5 + rng() * Math.max(1, len - 10);
    const mx = a.x + ((b.x - a.x) * (s0 + 12)) / (len + 25), mz = a.z + ((b.z - a.z) * (s0 + 12)) / (len + 25);
    if (Math.hypot(mx - pp.x, mz - pp.z) < minDist) continue;
    // not on top of another AI car
    let clash = false;
    for (const o of w.traffic) if (o !== car && Math.hypot(o.px - mx, o.pz - mz) < 12) clash = true;
    for (const o of w.police?.cars ?? []) if (o !== car && Math.hypot(o.px - mx, o.pz - mz) < 12) clash = true;
    if (clash) continue;
    placeOnEdge(w, car, a.id, b.id, s0);
    return;
  }
}

export function spawnTraffic(w: World): void {
  const rng = w.rng.fork(55);
  const r = () => rng.next();
  const paints = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#2a9d8f', '#e9c46a', '#f4a261', '#8d99ae', '#ffffff', '#3d405b', '#81b29a'];
  const types: CarTypeName[] = ['hatchback', 'sedan', 'sedan', 'pickup'];
  for (let k = 0; k < TT.count; k++) {
    const car = createAiCar(w, 'traffic', rng.pick(types), new THREE.Color(rng.pick(paints)), 0, w.city.nodes[0].nbrs[0], 0);
    car.id = k;
    w.traffic.push(car);
    w.colliderOwner.set(car.collider.handle, { kind: 'traffic', id: k });
    placeRandom(w, car, TT.spawnMinDistFromPlayer, r);
  }
}

// ---------- driving ----------
const fwd = new THREE.Vector2();
const tgt = new THREE.Vector2();
const pos2 = new THREE.Vector2();

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

/** Steers the body along its path at `want` m/s. Handles lane/junction transitions. */
export function driveAlongPath(w: World, car: AiCar, want: number, dt: number, rng: () => number, isTraffic: boolean): void {
  const accel = car.kind === 'police' ? TUNING.police.accel : TT.accel;
  if (want > car.speed) car.speed = Math.min(want, car.speed + accel * dt);
  else car.speed = Math.max(want, car.speed - TT.brake * dt);
  car.s += car.speed * dt;
  const total = car.cum[car.cum.length - 1];
  if (car.s >= total) {
    if (car.phase === 'lane') {
      car.next = car.chooser ? car.chooser(car) : pickNext(w, car, rng);
      if (isTraffic) {
        car.phase = 'wait';
        car.waitT = TT.intersectionWait;
        car.s = total;
      } else {
        car.phase = 'turn';
        turnPath(w, car);
      }
    } else if (car.phase === 'turn') {
      car.from = car.to;
      car.to = car.next;
      car.phase = 'lane';
      lanePath(w, car);
    }
  }
  // follow a point a little ahead on the path
  pos2.set(car.px, car.pz);
  pointAt(car, Math.min(car.s + 2.5 + car.speed * 0.25, car.cum[car.cum.length - 1] + 0.01), tgt);
  // swerve offset to the right of the path
  if (car.swerve !== 0) {
    const dx = tgt.x - pos2.x, dz = tgt.y - pos2.y, dl = Math.hypot(dx, dz) || 1;
    tgt.x += (-dz / dl) * car.swerve;
    tgt.y += (dx / dl) * car.swerve;
  }
  fwd.copy(tgt).sub(pos2);
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
  for (const car of w.traffic) {
    car.honkCd -= dt;
    if (stunCheck(car, dt)) {
      if (car.stunT <= 0) {
        // shoved off its lane: recycle somewhere out of sight
        placeRandom(w, car, 90, rng);
      }
      continue;
    }
    let want = TT.cruiseSpeed;
    if (car.phase === 'wait') {
      want = 0;
      car.waitT -= dt;
      let nodeBusy = false;
      for (const o of w.traffic) if (o !== car && o.phase === 'turn' && o.to === car.to) nodeBusy = true;
      for (const o of w.police.cars ?? []) if (o !== car && o.phase === 'turn' && o.to === car.to) nodeBusy = true;
      if (car.waitT <= 0 && !nodeBusy) {
        car.phase = 'turn';
        turnPath(w, car);
      }
    } else {
      // slow for turns and when approaching the stop line
      if (car.phase === 'turn') want = Math.min(want, 6.5);
      else {
        const remaining = car.cum[car.cum.length - 1] - car.s;
        want = Math.min(want, Math.sqrt(2 * TT.brake * 0.6 * Math.max(0, remaining)) + 1);
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

    // stuck for ages (e.g. gridlocked behind a parked player car): recycle
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
