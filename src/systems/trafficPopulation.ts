// Traffic population around the player: keeps the graphics preset's number of AI cars driving (traffic.countByQuality,
// the rest parked out of the world), and moves cars that drifted far away (or were shoved off the road, or gridlocked)
// to a lane nearer the player: lanes picked by length x the road class's density (traffic.densityByClass), between
// spawnMinDist and spawnMaxDist from the player, never inside the camera's view, never on top of another car.
// The lane's points carry its height, so a car placed on Key Bridge or the Whitehurst Freeway starts on the deck.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { laneSample, type LanePoint } from './map/cityMap';
import { laneStart, stopLine, isTrafficLane } from './junctions';
import { placeOnEdge, velXZ, type AiCar } from './traffic';

const TT = TUNING.traffic;

export interface TrafficPopulation {
  /** Candidate lanes and the running sum of their weights (lane length x class density). */
  cand: Int32Array;
  cum: Float64Array;
  total: number;
  rr: number;
  // camera this frame (for "in view")
  cx: number;
  cy: number;
  cz: number;
  fx: number;
  fy: number;
  fz: number;
  cosView: number;
  viewDist: number;
}

const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
const DIR = new THREE.Vector3();

export function createTrafficPopulation(w: World): TrafficPopulation {
  const edges = w.city.roads.edges;
  const cand: number[] = [], cum: number[] = [];
  let total = 0;
  for (const e of edges) {
    if (!isTrafficLane(e) || e.roundabout) continue;
    const L = stopLine(e) - laneStart(e);
    if (L < 30) continue;
    const wgt = L * (TT.densityByClass[e.cls] ?? 0.2);
    if (wgt <= 0) continue;
    total += wgt;
    cand.push(e.id);
    cum.push(total);
  }
  return { cand: Int32Array.from(cand), cum: Float64Array.from(cum), total, rr: 0, cx: 0, cy: 0, cz: 0, fx: 0, fy: 0, fz: 1, cosView: 0.5, viewDist: 800 };
}

function refreshCamera(w: World, P: TrafficPopulation): void {
  const cam = w.camera;
  cam.getWorldDirection(DIR);
  P.cx = cam.position.x; P.cy = cam.position.y; P.cz = cam.position.z;
  P.fx = DIR.x; P.fy = DIR.y; P.fz = DIR.z;
  const halfV = THREE.MathUtils.degToRad(cam.fov) / 2;
  const halfH = Math.atan(Math.tan(halfV) * cam.aspect);
  P.cosView = Math.cos(Math.min(Math.PI / 2, Math.max(halfV, halfH) + TT.spawnViewMargin));
  const fog = w.scene.fog as THREE.Fog | null;
  P.viewDist = fog && 'far' in fog ? fog.far : cam.far;
}

/** Could the camera see a car at (x, y, z)? (inside the view cone, nearer than the fog's far end; occlusion ignored) */
export function inView(P: TrafficPopulation, x: number, y: number, z: number): boolean {
  const dx = x - P.cx, dy = y + 1 - P.cy, dz = z - P.cz;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 8) return true;
  if (d > P.viewDist) return false;
  return (dx * P.fx + dy * P.fy + dz * P.fz) / d > P.cosView;
}

function pickLane(P: TrafficPopulation): number {
  const r = Math.random() * P.total;
  let lo = 0, hi = P.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (P.cum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return P.cand[lo];
}

/**
 * Put `car` on a lane near the player, out of view, moving. `boot`: the first placement (anywhere within
 * bootSpawnMaxDist, in view or not). Returns false if no spot was found (the car stays where it is).
 */
export function respawnCar(w: World, car: AiCar, boot = false): boolean {
  const P = w.trafficPop;
  if (!P.cand.length) return false;
  const edges = w.city.roads.edges;
  const pp = w.player.mesh.position;
  for (let tries = 0; tries < 90; tries++) {
    const relax = tries >= 60; // late tries: any distance out of view
    const id = pickLane(P);
    const e = edges[id];
    const a = laneStart(e) + 5, b = stopLine(e) - 10;
    if (b <= a) continue;
    const s = a + Math.random() * (b - a);
    laneSample(e, s, LP);
    const d = Math.hypot(LP.x - pp.x, LP.z - pp.z);
    if (boot) {
      if (d < TT.spawnMinDistFromPlayer || d > TT.bootSpawnMaxDist) continue;
    } else {
      if (d < TT.spawnMinDist * (relax ? 0.7 : 1) || (!relax && d > TT.spawnMaxDist)) continue;
      if (inView(P, LP.x, LP.y, LP.z)) continue;
    }
    if (!clear(w, car, LP.x, LP.y, LP.z)) continue;
    placeOnEdge(w, car, id, s - laneStart(e));
    // already driving at a share of the lane's speed (a car at rest in the road looks broken down)
    const v = e.speed * TT.spawnSpeedFraction;
    car.speed = v;
    car.body.setLinvel(velXZ(Math.sin(car.heading) * v, 0, Math.cos(car.heading) * v), true);
    w.trafficSim.stats.respawned++;
    return true;
  }
  return false;
}

/** No other AI car (traffic or police) within spawnClearance on this level. */
function clear(w: World, car: AiCar, x: number, y: number, z: number): boolean {
  const r2 = TT.spawnClearance * TT.spawnClearance;
  const t = w.traffic;
  for (let i = 0; i < t.length; i++) {
    const o = t[i];
    if (o === car) continue;
    const dx = o.px - x, dz = o.pz - z;
    if (dx * dx + dz * dz < r2 && Math.abs(o.py - 0.62 - y) < TT.levelGap) return false;
  }
  const pc = w.police.cars;
  for (let i = 0; i < pc.length; i++) {
    const o = pc[i];
    const dx = o.px - x, dz = o.pz - z;
    if (dx * dx + dz * dz < r2 && Math.abs(o.py - 0.62 - y) < TT.levelGap) return false;
  }
  return true;
}

function park(car: AiCar): void {
  car.active = false;
  car.body.setTranslation({ x: 0, y: -300 - car.id * 5, z: 0 }, false);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  car.body.setGravityScale(0, false);
  car.body.sleep();
  car.mesh.visible = false;
  car.speed = 0;
  car.px = 0; car.py = -300; car.pz = 0;
}

function unpark(car: AiCar): void {
  car.active = true;
  car.body.setGravityScale(1, true);
  car.body.wakeUp();
  car.mesh.visible = true;
}

/** Boot: place the preset's number of cars around the spawn, park the rest. */
export function placeInitialTraffic(w: World): void {
  w.trafficPop = createTrafficPopulation(w);
  refreshCamera(w, w.trafficPop);
  const want = TT.countByQuality[w.settings.quality];
  const sim = w.trafficSim;
  for (let k = w.traffic.length - 1; k >= want; k--) {
    const car = w.traffic[k];
    w.traffic.splice(k, 1);
    park(car);
    sim.pool.push(car);
  }
  for (const car of w.traffic) {
    if (!respawnCar(w, car, true)) respawnCar(w, car, false);
    car.respawns = 0;
  }
  sim.stats.respawned = 0;
}

/** Per frame: match the preset's car count, and move far-away or stranded cars near the player, out of sight. */
export function updateTrafficPopulation(w: World): void {
  const P = w.trafficPop, sim = w.trafficSim;
  refreshCamera(w, P);
  const want = TT.countByQuality[w.settings.quality];
  // more cars wanted (preset raised): bring one back per frame, out of sight
  if (w.traffic.length < want && sim.pool.length) {
    const car = sim.pool.pop()!;
    unpark(car);
    w.traffic.push(car);
    if (!respawnCar(w, car)) { w.traffic.pop(); park(car); sim.pool.push(car); }
  }
  // fewer wanted: park one far-away car per frame
  if (w.traffic.length > want) {
    const pp = w.player.mesh.position;
    for (let k = w.traffic.length - 1; k >= 0; k--) {
      const c = w.traffic[k];
      if (c.keep || inView(P, c.px, c.py - 0.62, c.pz) || Math.hypot(c.px - pp.x, c.pz - pp.z) < TT.spawnMinDist * 0.5) continue;
      w.traffic.splice(k, 1);
      park(c);
      sim.pool.push(c);
      break;
    }
  }
  // round robin: far away, or stranded and out of sight -> respawn
  const n = w.traffic.length;
  if (!n) return;
  const pp = w.player.mesh.position;
  const R2 = TT.despawnRadius * TT.despawnRadius;
  for (let k = 0; k < TT.populationChecksPerFrame; k++) {
    P.rr = (P.rr + 1) % n;
    const car = w.traffic[P.rr];
    if (car.keep) continue;
    const dx = car.px - pp.x, dz = car.pz - pp.z;
    const far = dx * dx + dz * dz > R2;
    if ((far || car.respawnWanted) && !inView(P, car.px, car.py - 0.62, car.pz)) respawnCar(w, car);
  }
}
