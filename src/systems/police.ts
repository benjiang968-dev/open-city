// Police: heat from crimes -> 1..5 stars, patrol cars that chase along roads (direct when close and
// in sight), losing them by breaking line of sight for a while (faster if you switch cars unseen), busting.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { createAiCar, driveAlongPath, stunCheck, syncAi, placeOnEdge, yawQuat, velXZ, pickNext, anyLane, laneStart, stopLine, type AiCar } from './traffic';
import { exitVehicle } from './player';
import { toast } from './hud';
import { roadRouter, projectOnLane, type LaneHit } from './map/cityMap';

const P = TUNING.police;

// scratch for the road lookups (allocation-free)
const HIT: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const ON: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const camLook = new THREE.Vector3();

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
  /** Height of the last known position (NaN if only a reported spot): picks the bridge deck over the road below. */
  lastSeenY: number;
  sightCheckT: number;
  /** Until this time police know where you are (fresh 911 call) and the escape timer is paused. */
  trackUntil: number;
  /** Police are heading to a reported location (escape timer paused, but they don't know where you are). */
  searchUntil: number;
}

export function createPolice(): PoliceState {
  return { heat: 0, stars: 0, seen: false, cars: [], pool: [], loseTimer: 0, bustTimer: 0, lastSeenX: 0, lastSeenZ: 0, lastSeenY: NaN, sightCheckT: 0, trackUntil: 0, searchUntil: 0 };
}

export function spawnPolicePool(w: World): void {
  for (let k = 0; k < P.maxCars; k++) {
    const car = createAiCar(w, 'police', 'sedan', new THREE.Color('#f8f9fa'), anyLane(w), 0);
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
  pol.lastSeenY = NaN;
  pol.searchUntil = w.time + TUNING.witness.searchTime;
}

/**
 * Can any active police car see this spot right now? `y`: the ground (or deck) height at the spot, if known
 * (a crime on Key Bridge vs the towpath under it); default: the terrain there.
 */
export function policeCanSee(w: World, x: number, z: number, y = NaN): boolean {
  const R = w.R;
  for (const c of w.police.cars) {
    const dx = x - c.px, dz = z - c.pz, d = Math.hypot(dx, dz);
    if (d > P.sightRange) continue;
    if (d < 2) return true;
    const y0 = c.py + 0.8, y1 = (y === y ? y : w.city.heightAt(x, z)) + 1.0; // car body centre ~0.6 m up: eyes at ~1.4 m
    const ray = new R.Ray({ x: c.px, y: y0, z: c.pz }, { x: dx / d, y: (y1 - y0) / d, z: dz / d });
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
  pol.lastSeenY = pp.y;
}

/**
 * Never a parking lane (cars parked along its kerb, another lane going the same way) for a police car to aim for,
 * start in or rejoin: the lane beside it on the same segment instead. Away from the player most parked cars are
 * drawn only, with no physics body, so a police car in the parking lane would drive straight through them.
 */
function offParking(w: World, id: number): number {
  const { nodes, edges } = w.city.roads;
  const e = edges[id];
  if (!e || !e.parking || e.lanesSameDir < 2) return id;
  const out = nodes[e.from].out;
  for (let i = 0; i < out.length; i++) {
    const o = edges[out[i]];
    if (o.to === e.to && o.roadId === e.roadId && o.lane === e.lane + 1) return o.id;
  }
  return id;
}

/** The lane nearest the last known position of the player (-1 if none near), never a parking lane. */
function goalLane(w: World): number {
  return w.city.nearestLane(w.police.lastSeenX, w.police.lastSeenZ, P.goalLaneRange, HIT, w.police.lastSeenY) ? offParking(w, HIT.edge) : -1;
}

/**
 * Junction choice for a police car: the next lane on the shortest directed route to the lane where the player
 * was last seen (then round the block past them again); at random if there is no route.
 */
function chaseNext(w: World, car: AiCar): number {
  const { nodes, edges } = w.city.roads;
  const at = edges[car.edge].to;
  const goal = goalLane(w);
  if (goal >= 0) {
    const out = nodes[at].out;
    for (let i = 0; i < out.length; i++) if (out[i] === goal) return goal;
    const first = roadRouter(w.city).firstEdge(at, edges[goal].from);
    if (first >= 0) return first;
  }
  return pickNext(w, car, Math.random);
}

function spawnCar(w: World): void {
  const car = w.police.pool.pop();
  if (!car) return;
  const pp = w.player.mesh.position;
  const cam = w.camera;
  const { nodes } = w.city.roads;
  cam.getWorldDirection(camLook);
  camLook.y = 0;
  camLook.normalize();
  // pick a road edge roughly spawnDistance away, preferably behind the camera
  let best = -1, bestScore = -Infinity;
  for (const a of nodes) {
    if (!a.out.length) continue;
    const d = Math.hypot(a.x - pp.x, a.z - pp.z);
    if (d < P.spawnDistance * 0.6 || d > P.spawnDistance * 1.6) continue;
    const tx = a.x - cam.position.x, tz = a.z - cam.position.z, tl = Math.hypot(tx, tz) || 1;
    const behind = -(tx * camLook.x + tz * camLook.z) / tl;
    const score = behind - Math.abs(d - P.spawnDistance) / 100 + Math.random() * 0.3;
    if (score > bestScore) { bestScore = score; best = offParking(w, a.out[Math.floor(Math.random() * a.out.length)]); }
  }
  if (best < 0) best = anyLane(w);
  car.body.setGravityScale(1, true);
  car.body.wakeUp();
  car.mesh.visible = true;
  placeOnEdge(w, car, best, 5);
  car.chooser = (c) => chaseNext(w, c);
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
      pol.lastSeenY = pp.y;
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
      if (car.phase === 'turn' && car.next >= 0) {
        // was crossing a junction: carry on from the lane it was turning into
        car.edge = car.next;
        car.s = laneStart(w.city.roads.edges[car.edge]);
      }
      car.next = -1;
      car.phase = 'lane';
      car.stuckT = 0;
    } else {
      // rejoin the road network if we left it while chasing
      if (car.stuckT === 0 && car.phase === 'lane') {
        const off = projectOnLane(w.city.roads.edges[car.edge], t.x, t.z, ON).dist;
        if (off > P.offRoadRejoin) rejoinRoad(w, car, t.x, t.y, t.z);
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

/**
 * Rejoin the nearest lane without teleporting: re-target the path from where the car is (the path follower
 * steers it back on). Takes the direction whose far end is nearer the player's last known position.
 */
function rejoinRoad(w: World, car: AiCar, x: number, y: number, z: number): void {
  if (!w.city.nearestLane(x, z, P.rejoinSearch, HIT, y)) return;
  const { nodes, edges } = w.city.roads;
  const lane = offParking(w, HIT.edge);
  let e = edges[lane], s = lane === HIT.edge ? HIT.s : projectOnLane(e, x, z, ON).s;
  if (e.twin >= 0) {
    const t = edges[e.twin], pol = w.police;
    const a = nodes[e.to], b = nodes[t.to];
    if (Math.hypot(b.x - pol.lastSeenX, b.z - pol.lastSeenZ) < Math.hypot(a.x - pol.lastSeenX, a.z - pol.lastSeenZ)) {
      e = t;
      s = projectOnLane(t, x, z, ON).s;
    }
  }
  car.edge = e.id;
  car.next = -1;
  car.phase = 'lane';
  car.s = Math.max(laneStart(e), Math.min(s, stopLine(e) - 1));
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
  w.player.body.setTranslation({ x: station.x, y: w.city.heightAt(station.x, station.z) + 1.2, z: station.z }, true);
  toast(w, `<span style="color:#ef476f">BUSTED</span><br><span style="font-size:18px">Fined $${fine}</span>`, 3.5);
}

export function syncPolice(w: World): void {
  for (const c of w.police.cars) syncAi(c);
}
