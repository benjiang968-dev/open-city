// Police: heat from crimes -> 1..5 stars, patrol cars that chase along roads (direct when close and
// in sight), losing them by breaking line of sight for a while (faster if you switch cars unseen), busting.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { createAiCar, driveAlongPath, stunCheck, syncAi, placeOnEdge, yawQuat, velXZ, pickNext, anyLane, laneStart, stopLine, type AiCar } from './traffic';
import { isTrafficLane } from './junctions';
import { visible } from './trafficPopulation';
import { exitVehicle } from './player';
import { toast } from './hud';
import type RAPIER from '@dimforge/rapier3d-compat';
import { roadRouter, projectOnLane, laneSample, type LaneHit, type LanePoint } from './map/cityMap';

const P = TUNING.police;

// scratch for the road lookups (allocation-free)
const HIT: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const ON: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const camLook = new THREE.Vector3();
const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
// one ray for every sight check (a new Ray per check was garbage every step of a chase)
let RAY: RAPIER.Ray | null = null;
function ray(w: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): RAPIER.Ray {
  if (!RAY) RAY = new w.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  RAY.origin.x = ox; RAY.origin.y = oy; RAY.origin.z = oz;
  RAY.dir.x = dx; RAY.dir.y = dy; RAY.dir.z = dz;
  return RAY;
}


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
    const r = ray(w, c.px, y0, c.pz, dx / d, (y1 - y0) / d, dz / d);
    if (!w.physics.castRay(r, d - 1, true, R.QueryFilterFlags.ONLY_FIXED)) return true;
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

/** The lane nearest the last known position of the player (-1 if none near). */
function goalLane(w: World): number {
  return w.city.nearestLane(w.police.lastSeenX, w.police.lastSeenZ, P.goalLaneRange, HIT, w.police.lastSeenY) ? HIT.edge : -1;
}

/**
 * Junction choice for a police car: the next lane on the shortest directed route to the lane where the player
 * was last seen (then round the block past them again); at random if there is no route.
 */
function chaseNext(w: World, car: AiCar): number {
  const { nodes, edges } = w.city.roads;
  const pol = w.police;
  const at = edges[car.edge].to;
  let goal = goalLane(w);
  // searching (they don't know where you are now): once at the last known spot, cruise the streets round it
  const searching = !pol.seen && w.time >= pol.trackUntil;
  if (searching && goal >= 0) {
    let se = car.searchEdge;
    if (reached(w, car, goal)) se = se >= 0 && se !== car.edge ? se : pickSearchLane(w, car);
    if (se >= 0 && reached(w, car, se)) se = pickSearchLane(w, car);
    car.searchEdge = se;
    if (se >= 0) goal = se;
  } else car.searchEdge = -1;
  if (goal >= 0) {
    const out = nodes[at].out;
    const twin = edges[goal].twin;
    for (let i = 0; i < out.length; i++) if (out[i] === goal || out[i] === twin) return out[i];
    // the lane, or the one the other way along the same road, whichever is quicker to reach (the nearest lane to a
    // player on Key Bridge could be the far carriageway: routing only to it sent them round by the Virginia end)
    const router = roadRouter(w.city);
    let first = -1, best = Infinity;
    for (let k = 0; k < 2; k++) {
      const g = k === 0 ? goal : twin;
      if (g < 0) continue;
      if (router.path(at, edges[g].from) > 0 && router.length < best) { best = router.length; first = router.edges[0]; }
    }
    if (first >= 0) return first;
  }
  return pickNext(w, car, Math.random);
}

/** The car is on lane `g` (or its twin), or about to turn into one of them. */
function reached(w: World, car: AiCar, g: number): boolean {
  const edges = w.city.roads.edges, t = edges[g].twin, to = edges[car.edge].to;
  return car.edge === g || car.edge === t || to === edges[g].from || (t >= 0 && to === edges[t].from);
}

/** A lane within police.searchRadius of the last known position, on its level, that this car can drive to. */
function pickSearchLane(w: World, car: AiCar): number {
  const { edges } = w.city.roads;
  const pol = w.police;
  const at = edges[car.edge].to;
  for (let tries = 0; tries < 25; tries++) {
    const a = Math.random() * Math.PI * 2, r = P.searchRadius * (0.3 + Math.random() * 0.7);
    if (!w.city.nearestLane(pol.lastSeenX + Math.cos(a) * r, pol.lastSeenZ + Math.sin(a) * r, 40, HIT, pol.lastSeenY)) continue;
    const e = edges[HIT.edge];
    if (!isTrafficLane(e) || e.id === car.edge) continue;
    if (roadRouter(w.city).path(at, e.from) < 0) continue;
    return e.id;
  }
  return -1;
}

/**
 * Dispatch a police car: onto a traffic lane roughly spawnDistance from the player, preferably behind the camera and
 * never in its view, that has a route (on the directed graph) to the lane of the last known position.
 */
function spawnCar(w: World): void {
  const car = w.police.pool.pop();
  if (!car) return;
  const pp = w.player.mesh.position;
  const cam = w.camera;
  const { nodes, edges } = w.city.roads;
  cam.getWorldDirection(camLook);
  camLook.y = 0;
  camLook.normalize();
  const goal = goalLane(w);
  // score lanes leaving nodes in the distance band (behind the camera, near spawnDistance, clear, out of sight); then
  // for the best few, the route to your last known position: the shortest drive wins. On Georgetown's one-way streets
  // and bridges a lane 200 m away can be a 2 km drive (you were lost before they arrived): if the best drive is longer
  // than spawnMaxDrive, look further out (up to spawnFarFactor x spawnDistance), then accept a spot in view.
  let best = -1, bestDrive = Infinity, fallback = -1, fallbackDrive = Infinity;
  const cand: { e: number; score: number }[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const maxD = P.spawnDistance * (pass === 0 ? 1.6 : P.spawnFarFactor);
    cand.length = 0;
    for (const a of nodes) {
      if (!a.out.length) continue;
      const d = Math.hypot(a.x - pp.x, a.z - pp.z);
      if (d < P.spawnDistance * 0.6 || d > maxD) continue;
      const tx = a.x - cam.position.x, tz = a.z - cam.position.z, tl = Math.hypot(tx, tz) || 1;
      const behind = -(tx * camLook.x + tz * camLook.z) / tl;
      const score = behind - Math.abs(d - P.spawnDistance) / 100 + Math.random() * 0.3;
      for (let i = 0; i < a.out.length; i++) {
        const e = edges[a.out[i]];
        if (!isTrafficLane(e) || stopLine(e) - laneStart(e) < 12) continue;
        laneSample(e, laneStart(e) + 5, LP);
        if (!spotClear(w, LP.x, LP.y, LP.z)) continue; // not on top of another car (two cars dispatched to one lane met in the same spot)
        cand.push({ e: e.id, score });
      }
    }
    cand.sort((p, q) => q.score - p.score);
    let bestScore = -Infinity, checked = 0;
    best = -1;
    for (let k = 0; k < cand.length && k < P.spawnLanesLooked && checked < P.spawnRouteChecks; k++) {
      const e = edges[cand[k].e];
      laneSample(e, laneStart(e) + 5, LP);
      if (pass < 2 && visible(w, LP.x, LP.y, LP.z)) continue; // never appear in sight of the camera (unless nothing else will do)
      checked++;
      const drive = goal >= 0 ? routeLen(w, e.to, goal) : 0;
      if (drive === Infinity) continue; // no way there
      const score = cand[k].score - drive / P.spawnRoutePenalty;
      if (score > bestScore) { bestScore = score; best = e.id; bestDrive = drive; }
    }
    if (best >= 0 && bestDrive <= P.spawnMaxDrive) break;
    if (best >= 0 && bestDrive < fallbackDrive) { fallback = best; fallbackDrive = bestDrive; }
    best = -1;
  }
  if (best < 0) best = fallback;
  if (best < 0) best = anyLane(w);
  car.body.setGravityScale(1, true);
  car.body.wakeUp();
  car.mesh.visible = true;
  placeOnEdge(w, car, best, 5);
  car.chooser = (c) => chaseNext(w, c);
  car.searchEdge = -1;
  w.police.cars.push(car);
}

/** Metres of driving from node `a` onto lane `goal` or its twin (the shorter), Infinity if there is no route. */
function routeLen(w: World, a: number, goal: number): number {
  const edges = w.city.roads.edges, router = roadRouter(w.city), t = edges[goal].twin;
  let best = Infinity;
  for (let k = 0; k < 2; k++) {
    const g = k === 0 ? goal : t;
    if (g < 0) continue;
    if (router.path(a, edges[g].from) >= 0 && router.length < best) best = router.length;
  }
  return best;
}

/** No AI car (traffic or police) or drivable car within traffic.spawnClearance of (x, y, z) on its level. */
function spotClear(w: World, x: number, y: number, z: number): boolean {
  const r2 = TUNING.traffic.spawnClearance * TUNING.traffic.spawnClearance, lg = TUNING.traffic.levelGap;
  const lists = [w.traffic, w.police.cars];
  for (let l = 0; l < 2; l++) {
    const list = lists[l];
    for (let i = 0; i < list.length; i++) {
      const o = list[i], dx = o.px - x, dz = o.pz - z;
      if (dx * dx + dz * dz < r2 && Math.abs(o.py - 0.62 - y) < lg) return false;
    }
  }
  for (let i = 0; i < w.vehicles.length; i++) {
    const v = w.vehicles[i], dx = v.px - x, dz = v.pz - z;
    if (dx * dx + dz * dz < r2 && Math.abs(v.py - y) < lg + 1) return false;
  }
  return true;
}

function hasLineOfSight(w: World, car: AiCar): boolean {
  const pp = w.player.mesh.position;
  const dx = pp.x - car.px, dy = pp.y + 1.0 - (car.py + 1.0), dz = pp.z - car.pz;
  const d = Math.hypot(dx, dy, dz);
  if (d > P.sightRange) return false;
  if (d < 1.6) return true;
  const R = w.R;
  const hit = w.physics.castRay(ray(w, car.px, car.py + 1.0, car.pz, dx / d, dy / d, dz / d), d - 1.5, true, R.QueryFilterFlags.ONLY_FIXED);
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
    // straight at you only on your level (not from the parkway at a player on Key Bridge above)
    if (pol.seen && dist < P.directChaseRange && Math.abs(pp.y - t.y) < P.directChaseLevelGap && hasLineOfSight(w, car)) {
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
  let e = edges[HIT.edge], s = HIT.s;
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
