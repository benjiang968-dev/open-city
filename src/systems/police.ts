// Police: heat from crimes -> 1..5 stars, patrol cars that chase along roads (direct when close and
// in sight), losing them by breaking line of sight for a while (faster if you switch cars unseen), busting.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { createAiCar, driveAlongPath, stunCheck, syncAi, placeOnEdge, yawQuat, velXZ, type AiCar } from './traffic';
import { exitVehicle } from './player';
import { toast } from './hud';

const P = TUNING.police;

export interface PoliceState {
  heat: number;
  stars: number;
  seen: boolean;
  cars: AiCar[];
  pool: AiCar[]; // parked off-world when not needed
  loseTimer: number;
  bustTimer: number;
  lastSeenX: number;
  lastSeenZ: number;
  sightCheckT: number;
  /** Until this time police know where you are (fresh 911 call) and the escape timer is paused. */
  trackUntil: number;
  /** Police are heading to a reported location (escape timer paused, but they don't know where you are). */
  searchUntil: number;
}

export function createPolice(): PoliceState {
  return { heat: 0, stars: 0, seen: false, cars: [], pool: [], loseTimer: 0, bustTimer: 0, lastSeenX: 0, lastSeenZ: 0, sightCheckT: 0, trackUntil: 0, searchUntil: 0 };
}

export function spawnPolicePool(w: World): void {
  for (let k = 0; k < P.maxCars; k++) {
    const car = createAiCar(w, 'police', 'sedan', new THREE.Color('#f8f9fa'), 0, w.city.nodes[0].nbrs[0], 0);
    car.id = k;
    w.colliderOwner.set(car.collider.handle, { kind: 'police', id: k });
    park(car);
    w.police.pool.push(car);
  }
}

function park(car: AiCar) {
  // far below the world, asleep
  car.body.setTranslation({ x: 0, y: -200 - car.id * 5, z: 0 }, false);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  car.body.setGravityScale(0, false);
  car.body.sleep();
  car.mesh.visible = false;
}

/** A 999 call: heat rises and police are sent to where the crime happened (not to wherever you are now). */
export function dispatchTo(w: World, x: number, z: number, amount: number): void {
  const pol = w.police;
  pol.heat = Math.min(P.maxStars * P.heatPerStar, pol.heat + amount);
  pol.loseTimer = 0;
  pol.lastSeenX = x;
  pol.lastSeenZ = z;
  pol.searchUntil = w.time + TUNING.witness.searchTime;
}

/** Can any active police car see this spot right now? */
export function policeCanSee(w: World, x: number, z: number): boolean {
  const R = w.R;
  for (const c of w.police.cars) {
    const dx = x - c.px, dz = z - c.pz, d = Math.hypot(dx, dz);
    if (d > P.sightRange) continue;
    if (d < 2) return true;
    const ray = new R.Ray({ x: c.px, y: 1.4, z: c.pz }, { x: dx / d, y: -0.4 / d, z: dz / d });
    if (!w.physics.castRay(ray, d - 1, true, R.QueryFilterFlags.ONLY_FIXED)) return true;
  }
  return false;
}

export function addHeat(w: World, amount: number): void {
  const pol = w.police;
  pol.heat = Math.min(P.maxStars * P.heatPerStar, pol.heat + amount);
  pol.loseTimer = 0;
  pol.trackUntil = w.time + P.dispatchTime;
  const pp = w.player.mesh.position;
  pol.lastSeenX = pp.x;
  pol.lastSeenZ = pp.z;
}

function nearestNode(w: World, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (const n of w.city.nodes) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n.id; }
  }
  return best;
}

/** Next node from `from`(arriving at `at`) on the shortest path toward `goal`. */
function bfsNext(w: World, at: number, cameFrom: number, goal: number): number {
  const nodes = w.city.nodes;
  if (at === goal) {
    const o = nodes[at].nbrs.filter((n) => n !== cameFrom);
    return o[Math.floor(Math.random() * o.length)] ?? cameFrom;
  }
  const prev = new Map<number, number>([[at, -1]]);
  const q = [at];
  for (let i = 0; i < q.length; i++) {
    const n = q[i];
    if (n === goal) break;
    for (const m of nodes[n].nbrs) if (!prev.has(m)) { prev.set(m, n); q.push(m); }
  }
  let n = goal;
  while (prev.get(n) !== at && prev.get(n) !== undefined && prev.get(n) !== -1) n = prev.get(n)!;
  return n === at ? nodes[at].nbrs[0] : n;
}

function spawnCar(w: World): void {
  const car = w.police.pool.pop();
  if (!car) return;
  const pp = w.player.mesh.position;
  const cam = w.camera;
  // pick a road edge roughly spawnDistance away, preferably behind the camera
  let best: [number, number] | null = null, bestScore = -Infinity;
  for (const a of w.city.nodes) {
    const d = Math.hypot(a.x - pp.x, a.z - pp.z);
    if (d < P.spawnDistance * 0.6 || d > P.spawnDistance * 1.6) continue;
    const toN = new THREE.Vector3(a.x - cam.position.x, 0, a.z - cam.position.z).normalize();
    const look = new THREE.Vector3();
    cam.getWorldDirection(look);
    const behind = -toN.dot(look.setY(0).normalize());
    const score = behind - Math.abs(d - P.spawnDistance) / 100 + Math.random() * 0.3;
    if (score > bestScore) { bestScore = score; best = [a.id, a.nbrs[Math.floor(Math.random() * a.nbrs.length)]]; }
  }
  if (!best) best = [0, w.city.nodes[0].nbrs[0]];
  car.body.setGravityScale(1, true);
  car.body.wakeUp();
  car.mesh.visible = true;
  placeOnEdge(w, car, best[0], best[1], 5);
  car.chooser = (c) => bfsNext(w, c.to, c.from, nearestNode(w, w.police.lastSeenX, w.police.lastSeenZ));
  w.police.cars.push(car);
}

function hasLineOfSight(w: World, car: AiCar): boolean {
  const t = car.body.translation();
  const pp = w.player.mesh.position;
  const dx = pp.x - t.x, dy = pp.y + 1.0 - (t.y + 1.0), dz = pp.z - t.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > P.sightRange) return false;
  const R = w.R;
  const ray = new R.Ray({ x: t.x, y: t.y + 1.0, z: t.z }, { x: dx / d, y: dy / d, z: dz / d });
  const hit = w.physics.castRay(ray, d - 1.5, true, R.QueryFilterFlags.ONLY_FIXED);
  return !hit;
}

export function updatePolice(w: World, dt: number): void {
  const pol = w.police;
  // ---- crimes raise heat ----
  for (const e of w.events) {
    // crimes reach the police through witnesses (999 calls) or police seeing them: see witness.ts
    if (e.type === 'enterCar' && !e.seen && pol.stars > 0) {
      pol.loseTimer += P.loseSightTime[pol.stars] * P.vehicleSwapBonus;
      toast(w, 'Switched cars unseen', 1.5);
    }
  }
  pol.stars = Math.min(P.maxStars, Math.ceil(pol.heat / P.heatPerStar - 1e-6));

  // ---- line of sight (a few times a second) ----
  pol.sightCheckT -= dt;
  if (pol.sightCheckT <= 0) {
    pol.sightCheckT = 0.2;
    pol.seen = pol.stars > 0 && pol.cars.some((c) => c.stunT <= 0 && hasLineOfSight(w, c));
    if (pol.seen || w.time < pol.trackUntil) {
      const pp = w.player.mesh.position;
      pol.lastSeenX = pp.x;
      pol.lastSeenZ = pp.z;
    }
  }
  if (pol.stars > 0) {
    if (pol.seen || w.time < pol.trackUntil || w.time < pol.searchUntil) pol.loseTimer = Math.max(0, pol.loseTimer - dt * 2);
    else {
      pol.loseTimer += dt;
      if (pol.loseTimer >= P.loseSightTime[pol.stars]) {
        pol.heat = (pol.stars - 1) * P.heatPerStar;
        pol.loseTimer = 0;
        if (pol.heat <= 0) toast(w, '<span style="color:#9be564">Lost the police</span>', 2.5);
      }
    }
  } else {
    pol.loseTimer = 0;
    pol.seen = false;
  }

  // ---- manage the number of cars ----
  const want = pol.stars > 0 ? Math.min(P.maxCars, pol.stars * P.carsPerStar) : 0;
  if (pol.cars.length < want) spawnCar(w);
  if (pol.cars.length > want) {
    // retire cars that are far away or not in view
    for (let k = pol.cars.length - 1; k >= 0 && pol.cars.length > want; k--) {
      const c = pol.cars[k];
      const d = Math.hypot(c.px - w.player.mesh.position.x, c.pz - w.player.mesh.position.z);
      if (d > 70 || pol.stars === 0) {
        pol.cars.splice(k, 1);
        park(c);
        pol.pool.push(c);
      }
    }
  }

  // ---- busted ----
  bustCheck(w, dt);
}

/** Fixed-step driving for every active police car. */
export function drivePolice(w: World, dt: number): void {
  const pol = w.police;
  const pp = w.player.mesh.position;
  const pv = w.player.vehicle;
  const speedCap = P.chaseSpeed[Math.max(1, pol.stars)];
  for (const car of pol.cars) {
    if (stunCheck(car, dt)) continue;
    const t = car.body.translation();
    const dist = Math.hypot(pp.x - t.x, pp.z - t.z);
    if (pol.seen && dist < P.directChaseRange && hasLineOfSight(w, car)) {
      // ram / box in: aim slightly ahead of the player
      const lead = pv ? pv.body.linvel() : { x: 0, z: 0 };
      const tx = pp.x + lead.x * 0.5, tz = pp.z + lead.z * 0.5;
      const desired = Math.atan2(tx - t.x, tz - t.z);
      const dh = Math.atan2(Math.sin(desired - car.heading), Math.cos(desired - car.heading));
      car.heading += THREE.MathUtils.clamp(dh * 3 * dt, -2.6 * dt, 2.6 * dt);
      const want = dist < 9 ? Math.max(2, dist * 0.6) : speedCap;
      car.speed += THREE.MathUtils.clamp(want - car.speed, -TUNING.traffic.brake * dt, P.accel * dt);
      const lv = car.body.linvel();
      car.body.setLinvel(velXZ(Math.sin(car.heading) * car.speed, lv.y, Math.cos(car.heading) * car.speed), true);
      if (Math.abs(car.heading - car.lastSetHeading) > 1e-4) {
        car.lastSetHeading = car.heading;
        car.body.setRotation(yawQuat(car.heading), true);
      }
      car.phase = 'lane';
      car.stuckT = 0;
    } else {
      // rejoin the road network if we left it while chasing
      if (car.stuckT === 0 && car.phase === 'lane') {
        const a = w.city.nodes[car.from], b = w.city.nodes[car.to];
        const off = distToSegment(t.x, t.z, a.x, a.z, b.x, b.z);
        if (off > 10) {
          const n = nearestNode(w, t.x, t.z);
          const next = bfsNext(w, n, -1, nearestNode(w, pol.lastSeenX, pol.lastSeenZ));
          placeOnEdgeQuiet(w, car, n, next);
        }
      }
      car.stuckT += dt;
      if (car.stuckT > 4) car.stuckT = 0;
      let want = speedCap;
      if (car.phase === 'turn') want = Math.min(want, 9);
      driveAlongPath(w, car, want, dt, Math.random, false);
    }
  }

}

function bustCheck(w: World, dt: number): void {
  const pol = w.police;
  const pp = w.player.mesh.position;
  const pv = w.player.vehicle;
  const playerSpeed = pv ? Math.abs(pv.speed) : 0;
  let close = false;
  for (const c of pol.cars) if (Math.hypot(c.px - pp.x, c.pz - pp.z) < P.bustRange) close = true;
  if (pol.stars > 0 && pol.seen && close && playerSpeed < 1.5) {
    pol.bustTimer += dt;
    if (pol.bustTimer > P.bustTime) bust(w);
  } else pol.bustTimer = Math.max(0, pol.bustTimer - dt);
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az;
  const t = THREE.MathUtils.clamp(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/** Rejoin a lane without teleporting: just re-target the path from the current position. */
function placeOnEdgeQuiet(w: World, car: AiCar, from: number, to: number) {
  const t = car.body.translation();
  const h = car.heading, sp = car.speed;
  placeOnEdge(w, car, from, to, 0);
  // keep the car where it is; the path follower will steer it onto the lane
  car.body.setTranslation(t, true);
  car.heading = h;
  car.speed = sp;
  const p0 = car.path[0], p1 = car.path[car.path.length - 1];
  const dx = p1.x - p0.x, dz = p1.y - p0.y, L = Math.hypot(dx, dz);
  car.s = THREE.MathUtils.clamp(((t.x - p0.x) * dx + (t.z - p0.y) * dz) / L, 0, L - 1);
}

function bust(w: World): void {
  const pol = w.police;
  const fine = Math.round(w.cash * P.bustFineFraction);
  w.cash -= fine;
  const pp = w.player.mesh.position;
  emit(w, { type: 'busted', x: pp.x, z: pp.z });
  if (w.player.vehicle) exitVehicle(w);
  pol.heat = 0;
  pol.stars = 0;
  pol.bustTimer = 0;
  pol.loseTimer = 0;
  // released outside the precinct (or the first taxi rank)
  const station = w.city.pois.find((p) => p.kind === 'police') ?? w.city.taxiRanks[0];
  w.player.body.setTranslation({ x: station.x, y: 1.2, z: station.z }, true);
  toast(w, `<span style="color:#ef476f">BUSTED</span><br><span style="font-size:18px">Fined $${fine}</span>`, 3.5);
}

export function syncPolice(w: World): void {
  for (const c of w.police.cars) syncAi(c);
}
