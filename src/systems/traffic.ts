// AI traffic on the road graph. Cars are dynamic bodies steered by setting velocity along their lane edge
// (map.roads), so the player can shove them; they keep a gap, honk at and swerve from the player.
// On entering a lane a car plans its move at the junction ahead (junctions.ts: lane discipline) and changes lanes
// before it if that move leaves from another lane. Approaching the junction it asks junctionHold whether it may enter
// (lights, stop signs, give way, roundabout yield, room past the junction) and brakes for the stop line if not; then
// it follows a curve from its stop line to the next lane's start. Population around the player: trafficPopulation.ts.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import { laneSample, projectOnLane, type LaneEdge, type LaneHit, type LanePoint } from './map/cityMap';
import { makeAiCarGeometry, carMaterial } from '../art/car';
import { GROUPS } from '../physicsGroups';
import {
  TURN_SEGS, laneStart, stopLine, isUTurn, isTrafficLane, turnCurve, findMove, junctionHold, exitHasSpace, ringBlocked, updateJunctions, boxBlocked,
  holdAhead, ringDist, movesConflict, HOLD_GO, HOLD_BOX, CTL_NONE, CTL_SIGNALS, CTL_RING, LIGHT_RED,
} from './junctions';
import { auditTraffic, type TrafficStats, createTrafficStats } from './trafficAudit';
import { visible } from './trafficPopulation';

export { laneStart, stopLine, isUTurn };

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
  /** Lane edge being driven (while waiting or turning: the edge being left). */
  edge: number;
  /** Lane edge after the coming junction, -1 until chosen. */
  next: number;
  /** The move edge -> next at the junction ahead (junctions.ts global move index), -1 if unknown. */
  move: number;
  phase: 'lane' | 'wait' | 'turn';
  /** 'lane'/'wait': distance along the edge's pts; 'turn': distance along the junction curve. */
  s: number;
  turnPts: Float32Array; // x,z pairs of the current junction curve (preallocated)
  turnCum: Float32Array;
  turnLen: number;
  /** Heading (sin, cos) of the lane the junction curve leads into, at its start (set with the curve). */
  exitSin: number;
  exitCos: number;
  speed: number;
  heading: number;
  /** Seconds waiting at the stop line, and of those standing still (a stop sign needs a full stop). */
  waitT: number;
  stopT: number;
  /** Game time it reached the stop line (first come, first served at stop signs). */
  arriveT: number;
  /** Last junction decision (junctions.ts HOLD_*) and seconds until it is checked again. */
  hold: number;
  holdT: number;
  /** Committed to cross on amber (too close to stop). */
  commit: boolean;
  /** Given the go while waiting short of the line: drives on and crosses unless the junction box is taken. */
  cleared: boolean;
  /** Metres to the right of its lane's centre line the car still is (a lane change in progress); eases to 0. */
  latOff: number;
  /** Lane the car is changing toward before the junction (-1: none) and the move it plans from there. */
  target: number;
  planMove: number;
  lcCool: number;
  honkCd: number;
  blockedT: number;
  swerve: number;
  swerveT: number;
  stunT: number;
  stuckT: number;
  lastSetHeading: number; // heading last written to the physics body
  px: number; // cached position, refreshed once per physics step (avoids allocating translation() calls)
  py: number;
  pz: number;
  /** Optional route chooser at junctions: returns the next lane edge id (police head for the player). */
  chooser?: (car: AiCar) => number;
  /** Police: the lane it is cruising to while searching round your last known position (-1: none). */
  searchEdge: number;
  // ---- population (trafficPopulation.ts) ----
  /** Driving in the world (false: parked in the pool, out of the world). */
  active: boolean;
  /** Wants moving somewhere out of sight (shoved off its lane, or gridlocked); stands still until then. */
  respawnWanted: boolean;
  /** Teleports so far (respawns, recycles): audits do not count these as moves along the road. */
  respawns: number;
  /** Tests: never moved away for being far from the player. */
  keep?: boolean;
}
export type TrafficCar = AiCar;

/** Traffic bookkeeping on the World: the parked pool and the counters the audit reads. */
export interface TrafficSim {
  /** Cars not driving now (quality preset lowered): parked out of the world. */
  pool: AiCar[];
  /** Every traffic car ever made, by id. */
  all: AiCar[];
  stats: TrafficStats;
  /** Tests switch this on for the per-step audit (wrong way, off lane, levels, AI collisions, stuck). */
  measure: boolean;
}

const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
const LP2: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
const HIT: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };

// ---------- lane geometry ----------
/** True when the next lane does not continue where this one stops, so a junction curve is needed. */
function needsTurn(e: LaneEdge, n: LaneEdge): boolean {
  laneSample(e, stopLine(e), LP);
  laneSample(n, laneStart(n), LP2);
  const dh = Math.abs(Math.atan2(Math.sin(LP2.heading - LP.heading), Math.cos(LP2.heading - LP.heading)));
  return Math.hypot(LP2.x - LP.x, LP2.z - LP.z) > 0.5 || dh > 0.6;
}

/** Junction curve from the stop line of `car.edge` to the start of `car.next`. */
function buildTurn(w: World, car: AiCar): void {
  const edges = w.city.roads.edges;
  car.turnLen = turnCurve(edges[car.edge], edges[car.next], car.turnPts, car.turnCum);
  const n = edges[car.next];
  laneSample(n, laneStart(n), LP3);
  car.exitSin = Math.sin(LP3.heading);
  car.exitCos = Math.cos(LP3.heading);
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

/**
 * Random next lane at the end of the car's edge: never back the way it came unless it's a dead end, and not into a
 * parking lane (cars parked along its kerb, another lane going the same way) while another lane leads on. A narrow
 * street's single lane each way is not avoided even when cars park along it: its points already keep clear of them.
 */
export function pickNext(w: World, car: AiCar, rng: () => number): number {
  const { nodes, edges } = w.city.roads;
  const e = edges[car.edge];
  const out = nodes[e.to].out;
  let n = 0, free = 0;
  for (let i = 0; i < out.length; i++) {
    const o = edges[out[i]];
    if (isUTurn(e, o)) continue;
    n++;
    if (isTrafficLane(o)) free++;
  }
  if (n === 0) return e.twin >= 0 ? e.twin : out.length ? out[Math.floor(rng() * out.length)] : -1;
  const skipParking = free > 0;
  let k = Math.floor(rng() * (skipParking ? free : n));
  for (let i = 0; i < out.length; i++) {
    const o = edges[out[i]];
    if (isUTurn(e, o) || (skipParking && !isTrafficLane(o))) continue;
    if (k-- === 0) return out[i];
  }
  return -1;
}

/**
 * Plan the move at the junction ahead (traffic): a random move allowed by lane discipline from any lane of this
 * road; if it leaves from another lane and this lane cannot reach the same road, change lanes first (when there is
 * room before the stop line), else pick a move this lane may make.
 */
function planMove(w: World, car: AiCar, rng: () => number): void {
  const J = w.junctions;
  const edges = w.city.roads.edges;
  const e = edges[car.edge];
  car.target = -1;
  car.planMove = -1;
  car.commit = false;
  // count allowed moves over the lane group (traffic lanes)
  let lo = e;
  while (lo.right >= 0) lo = edges[lo.right];
  // (not into a cul-de-sac while another move is open)
  let total = 0, open = 0;
  for (let l: LaneEdge | null = lo; l; l = l.left >= 0 ? edges[l.left] : null) {
    const m0 = J.edgeM0[l.id], n = J.edgeMN[l.id];
    for (let k = m0; k < m0 + n; k++) if (J.mvOk[k]) { total++; if (!J.culDeSac[J.mvOut[k]]) open++; }
  }
  const skipCul = open > 0;
  if (skipCul) total = open;
  let chosen = -1;
  if (total > 0) {
    let k = Math.floor(rng() * total);
    for (let l: LaneEdge | null = lo; l && chosen < 0; l = l.left >= 0 ? edges[l.left] : null) {
      const m0 = J.edgeM0[l.id], n = J.edgeMN[l.id];
      for (let m = m0; m < m0 + n; m++) if (J.mvOk[m] && !(skipCul && J.culDeSac[J.mvOut[m]]) && k-- === 0) { chosen = m; break; }
    }
  }
  if (chosen >= 0 && J.mvIn[chosen] !== car.edge) {
    // can this lane reach the same road?
    const g = J.edgeGroup[J.mvOut[chosen]];
    const m0 = J.edgeM0[car.edge], n = J.edgeMN[car.edge];
    let own = -1;
    for (let m = m0; m < m0 + n; m++) if (J.mvOk[m] && J.edgeGroup[J.mvOut[m]] === g && !(skipCul && J.culDeSac[J.mvOut[m]])) { own = m; break; }
    if (own >= 0) chosen = own;
    else if (!e.roundabout && stopLine(e) - Math.max(car.s, laneStart(e)) > TT.laneChangeMinRoom + 12) {
      car.target = J.mvIn[chosen];
      car.planMove = chosen;
      car.next = -1;
      car.move = -1;
      return;
    } else chosen = -1;
  }
  if (chosen < 0) chosen = ownMove(w, car, rng);
  if (chosen >= 0) {
    car.next = J.mvOut[chosen];
    car.move = chosen;
  } else {
    car.next = pickNext(w, car, rng);
    car.move = car.next >= 0 ? findMove(J, car.edge, car.next) : -1;
  }
}

/** A random move this lane may make (lane discipline; not into a cul-de-sac if it can help it), else any move from it; -1 if none. */
function ownMove(w: World, car: AiCar, rng: () => number): number {
  const J = w.junctions;
  const m0 = J.edgeM0[car.edge], n = J.edgeMN[car.edge];
  let ok = 0, open = 0;
  for (let m = m0; m < m0 + n; m++) if (J.mvOk[m]) { ok++; if (!J.culDeSac[J.mvOut[m]]) open++; }
  const skipCul = open > 0;
  const pool = skipCul ? open : ok > 0 ? ok : n;
  if (pool === 0) return -1;
  let k = Math.floor(rng() * pool);
  for (let m = m0; m < m0 + n; m++) if ((ok === 0 || J.mvOk[m]) && !(skipCul && J.culDeSac[J.mvOut[m]]) && k-- === 0) return m;
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
    // rounded edges: the body cannot pitch, so on hills and over kerbs a sharp-edged box would dig in and get shoved
    R.ColliderDesc.roundCuboid(hx - TT.bodyRound, halfH - TT.bodyRound, hz - TT.bodyRound, TT.bodyRound).setMass(spec.mass).setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0.1).setCollisionGroups(GROUPS.ai),
    body,
  );
  const geo = makeAiCarGeometry(type, paint, { r: spec.wheelRadius, x: spec.wheelX, zf: spec.wheelZFront, zr: spec.wheelZRear, y: spec.wheelY - spec.suspensionRest * 0.75 }, kind === 'police' ? { police: true } : undefined);
  const mesh = new THREE.Mesh(geo, carMaterial);
  mesh.castShadow = true;
  w.scene.add(mesh);
  const car: AiCar = {
    id: kind === 'police' ? w.police?.cars?.length ?? 0 : w.traffic.length, kind, type, body, collider, mesh, meshYOffset: rideY - halfH, halfW: hx, halfL: hz,
    edge, next: -1, move: -1, phase: 'lane', s: 0, turnPts: new Float32Array((TURN_SEGS + 1) * 2), turnCum: new Float32Array(TURN_SEGS + 1), turnLen: 0.01, exitSin: 0, exitCos: 1,
    speed: 0, heading: 0, waitT: 0, stopT: 0, arriveT: 0, hold: HOLD_GO, holdT: 0, commit: false, cleared: false, latOff: 0, target: -1, planMove: -1, lcCool: 0,
    honkCd: 0, blockedT: 0, swerve: 0, swerveT: 0, stunT: 0, stuckT: 0, px: 0, py: 0, pz: 0, lastSetHeading: NaN,
    active: true, respawnWanted: false, respawns: 0, searchEdge: -1,
  };
  placeOnEdge(w, car, edge, s0);
  return car;
}

/** Put the car on a lane, `s0` metres past the lane's start (the previous junction), at rest. */
export function placeOnEdge(w: World, car: AiCar, edge: number, s0: number): void {
  const e = w.city.roads.edges[edge];
  car.edge = edge;
  car.next = -1;
  car.move = -1;
  car.target = -1;
  car.planMove = -1;
  car.phase = 'lane';
  car.s = Math.max(laneStart(e), Math.min(laneStart(e) + s0, stopLine(e) - 1));
  const p = laneSample(e, car.s, LP);
  car.heading = p.heading;
  car.body.setTranslation({ x: p.x, y: p.y + 0.62, z: p.z }, true);
  car.body.setRotation(yawQuat(car.heading), true);
  car.lastSetHeading = car.heading;
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.px = p.x;
  car.py = p.y + 0.62;
  car.pz = p.z;
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.speed = 0;
  car.stunT = 0;
  car.stuckT = 0;
  car.swerve = 0;
  car.latOff = 0;
  car.hold = HOLD_GO;
  car.holdT = 0;
  car.commit = false;
  car.waitT = 0;
  car.stopT = 0;
  car.respawnWanted = false;
  car.respawns++;
  syncAi(car);
}

/** Random lane placement away from the player (fallback when the population manager finds no spot). */
export function placeRandom(w: World, car: AiCar, minDist: number, rng: () => number): void {
  const { nodes, edges } = w.city.roads;
  const pp = w.player.mesh.position;
  for (let tries = 0; tries < 60; tries++) {
    const a = nodes[Math.floor(rng() * nodes.length)];
    if (!a.out.length) continue;
    const e = edges[a.out[Math.floor(rng() * a.out.length)]];
    if (!isTrafficLane(e)) continue; // parked cars stand in it
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
  const i = w.city.roads.edges.findIndex((e) => isTrafficLane(e) && stopLine(e) - laneStart(e) > 2);
  return Math.max(0, i);
}

/** Make every traffic car the best preset can use; the population manager places them and parks the extras. */
export function spawnTraffic(w: World): void {
  const rng = w.rng.fork(55);
  const paints = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#2a9d8f', '#e9c46a', '#f4a261', '#8d99ae', '#ffffff', '#3d405b', '#81b29a'];
  const types: CarTypeName[] = ['hatchback', 'sedan', 'sedan', 'pickup'];
  const first = anyLane(w);
  const max = Math.max(TT.countByQuality.low, TT.countByQuality.medium, TT.countByQuality.high);
  w.trafficSim = { pool: [], all: [], stats: createTrafficStats(max), measure: false };
  for (let k = 0; k < max; k++) {
    const car = createAiCar(w, 'traffic', rng.pick(types), new THREE.Color(rng.pick(paints)), first, 0);
    car.id = k;
    w.trafficSim.all.push(car);
    w.traffic.push(car);
    w.colliderOwner.set(car.collider.handle, { kind: 'traffic', id: k });
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
  for (const c of w.traffic) { const t = c.body.translation(); c.px = t.x; c.py = t.y; c.pz = t.z; }
  for (const c of w.police.cars ?? []) { const t = c.body.translation(); c.px = t.x; c.py = t.y; c.pz = t.z; }
}

const OB = { dist: 0, player: false };
const PL = new Float64Array(3); // turnPathDist scratch: x, z in; distance out (no doubles through the call)
const LP3: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
/**
 * A turning car: distance from (PL[0], PL[1]) to the rest of its junction curve and, beyond the curve's end, the
 * straight line along the lane it leads into; written to PL[2]. obstacleAhead's straight-ahead cone points across the
 * junction while the car turns, which made cars wait for ones queuing at another approach's stop line that the
 * curve passes clear of (and those waited for the turning car: a 25 s deadlock until it was recycled).
 */
function turnPathDist(w: World, car: AiCar): void {
  const P = car.turnPts, C = car.turnCum, x = PL[0], z = PL[1];
  let best = Infinity, ax = car.px, az = car.pz, k = 1;
  while (k < TURN_SEGS && C[k] <= car.s) k++;
  for (; k <= TURN_SEGS; k++) {
    const bx = P[k * 2], bz = P[k * 2 + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
    let t = L2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + ex * t - x, dz = az + ez * t - z, d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
    ax = bx;
    az = bz;
  }
  if (car.next >= 0) {
    // (the exit lane's heading is cached with the curve: sampling the lane here, once per object ahead of every
    // turning car, made garbage)
    const hx = car.exitSin, hz = car.exitCos, rx = x - ax, rz = z - az;
    if (rx * hx + rz * hz > 0) { const d = Math.abs(rx * hz - rz * hx); if (d < best) best = d; }
  }
  PL[2] = best;
}
/**
 * Distance to the nearest obstacle ahead in this car's lane (Infinity if clear) and whether it is the player.
 * Another car is in the lane when the sides of the two bodies are less than traffic.sideGap apart. Anything more
 * than traffic.levelGap (+ levelGrade x the distance ahead, for hills) above or below is on another level (a car on
 * the Whitehurst Freeway does not brake for one parked on K St underneath).
 * Returns a shared object: read it immediately. Written as flat loops with no helper calls: passing
 * doubles to a non-inlined helper boxes them, which made this the biggest allocator in the game.
 */
export function obstacleAhead(w: World, car: AiCar, look: number): { dist: number; player: boolean } {
  const px = car.px, py = car.py, pz = car.pz, fx = Math.sin(car.heading), fz = Math.cos(car.heading), half = car.halfL, side = car.halfW + TT.sideGap;
  const lg = TT.levelGap, gr = TT.levelGrade, turning = car.phase === 'turn';
  const nudge = turning && car.stuckT > TT.boxNudgeTime; // stuck in the junction: other AI cars no longer hold it back
  let best = Infinity, isPlayer = false;
  const traffic = w.traffic;
  for (let i = 0; i < traffic.length; i++) {
    const o = traffic[i];
    // a car waiting at its line stands clear of the box (unless it waits on our way out: a queue we drive up to); when
    // stuck in the box, only a car on our own way out still holds us
    if (o === car || (turning && ((o.phase === 'wait' && o.edge !== car.next) || (nudge && o.next !== car.next && o.edge !== car.next)))) continue;
    const rx = o.px - px, rz = o.pz - pz, along = rx * fx + rz * fz;
    // straight ahead: within the band of our width; turning: near the rest of our curve (in a tight turn the car ahead
    // on the same curve is off to the side of the straight-ahead band), or in the band and about to touch
    const inBand = Math.abs(rx * fz - rz * fx) <= side + o.halfW;
    if (along <= 0 || along > look + o.halfL || (!turning && !inBand) || Math.abs(o.py - py) > lg + along * gr) continue;
    if (turning && !(inBand && along - o.halfL - half < TT.turnTouchGap)) { PL[0] = o.px; PL[1] = o.pz; turnPathDist(w, car); if (PL[2] > side + o.halfW) continue; } // clear of the curve
    // oncoming in the other lane of a narrow street (lanes 2.3 m apart): passes us if the bodies clear each other
    if (!turning && Math.sin(o.heading) * fx + Math.cos(o.heading) * fz < -0.8 && Math.abs(rx * fz - rz * fx) > car.halfW + o.halfW + TT.passGap) continue;
    const d = along - o.halfL - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  const police = w.police.cars;
  for (let i = 0; i < police.length; i++) {
    const o = police[i];
    if (o === car || (nudge && o.next !== car.next && o.edge !== car.next)) continue;
    const rx = o.px - px, rz = o.pz - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + o.halfL || (!turning && Math.abs(rx * fz - rz * fx) > side + o.halfW) || Math.abs(o.py - py) > lg + along * gr) continue;
    if (turning) { PL[0] = o.px; PL[1] = o.pz; turnPathDist(w, car); if (PL[2] > side + o.halfW) continue; } // clear of the curve
    const d = along - o.halfL - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  const vehicles = w.vehicles;
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const hl = v.spec.halfExtents[2];
    const rx = v.px - px, rz = v.pz - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + hl || (!turning && Math.abs(rx * fz - rz * fx) > side + v.spec.halfExtents[0]) || Math.abs(v.py - py) > lg + along * gr) continue;
    if (turning) { PL[0] = v.px; PL[1] = v.pz; turnPathDist(w, car); if (PL[2] > side + v.spec.halfExtents[0]) continue; }
    const d = along - hl - half;
    if (d < best) { best = d; isPlayer = v.driven; }
  }
  const peds = w.peds;
  for (let i = 0; i < peds.length; i++) {
    const p = peds[i];
    if (!p.active || p.hidden || p.state === 'down') continue;
    const rx = p.pos.x - px, rz = p.pos.z - pz, along = rx * fx + rz * fz;
    if (along <= 0 || along > look + 0.3 || Math.abs(rx * fz - rz * fx) > 1.7 || Math.abs(p.pos.y - py) > lg + along * gr) continue;
    const d = along - 0.3 - half;
    if (d < best) { best = d; isPlayer = false; }
  }
  if (!w.player.vehicle) {
    const pp = w.player.mesh.position;
    const rx = pp.x - px, rz = pp.z - pz, along = rx * fx + rz * fz;
    if (along > 0 && along <= look + 0.3 && Math.abs(rx * fz - rz * fx) <= 1.8 && Math.abs(pp.y - py) <= lg + along * gr) {
      const d = along - 0.3 - half;
      if (d < best) { best = d; isPlayer = true; }
    }
  }
  OB.dist = best;
  OB.player = isPlayer;
  return OB;
}

/** Choose the lane after the coming junction (the chooser if the car has one, else the planned or a random move). */
function chooseNext(w: World, car: AiCar, rng: () => number): void {
  if (car.next >= 0) return;
  if (car.chooser) {
    car.next = car.chooser(car);
    car.move = car.next >= 0 ? findMove(w.junctions, car.edge, car.next) : -1;
    return;
  }
  if (car.target >= 0) { // a lane change that never happened: turn from this lane
    car.target = -1;
    w.trafficSim.stats.laneChangeAborts++;
  }
  const m = ownMove(w, car, rng);
  if (m >= 0) { car.next = w.junctions.mvOut[m]; car.move = m; }
  else { car.next = pickNext(w, car, rng); car.move = car.next >= 0 ? findMove(w.junctions, car.edge, car.next) : -1; }
}

/** Leave the junction curve (or a seamless node) onto `car.next`, carrying over `extra` metres. */
function enterNext(w: World, car: AiCar, extra: number, isTraffic: boolean, rng: () => number): void {
  const n = w.city.roads.edges[car.next];
  car.edge = car.next;
  car.next = -1;
  car.move = -1;
  car.phase = 'lane';
  car.s = laneStart(n) + Math.max(0, extra);
  car.latOff = 0;
  car.hold = HOLD_GO;
  car.holdT = 0;
  car.commit = false;
  car.cleared = false;
  if (isTraffic && !car.chooser) planMove(w, car, rng);
}

/** The car crosses its stop line now (traffic): count red-light runs and roundabout entries that did not yield. */
function crossing(w: World, car: AiCar): void {
  const J = w.junctions, edges = w.city.roads.edges;
  const e = edges[car.edge];
  const c = J.nodes[e.to];
  const st = w.trafficSim.stats;
  if (c.kind === CTL_SIGNALS) {
    st.signalCrossings++;
    if (J.light[car.edge] === LIGHT_RED) { st.redRuns++; st.lastRedRun = `${e.name ?? e.roadId} at node ${e.to}, car ${car.id} ${car.phase} v ${car.speed.toFixed(1)} commit ${car.commit} cleared ${car.cleared} hold ${car.hold} t ${w.time.toFixed(1)}`; }
  }
  if (c.kind === CTL_RING && !e.roundabout && car.next >= 0 && edges[car.next].roundabout) {
    st.ringEntries++;
    if (ringBlocked(w, J, c, car, car.move, TT.ringConflictDist, TT.ringConflictTime, 0)) { st.yieldFails++; st.lastYieldFail = `node ${e.to}, car ${car.id}, t ${w.time.toFixed(1)}`; }
  }
}

/** Start the junction curve (or carry straight on) from the stop line. */
function startCrossing(w: World, car: AiCar, extra: number, isTraffic: boolean, rng: () => number): void {
  const edges = w.city.roads.edges;
  if (isTraffic) crossing(w, car);
  car.latOff = 0;
  if (!needsTurn(edges[car.edge], edges[car.next])) {
    enterNext(w, car, extra, isTraffic, rng);
    return;
  }
  if (w.junctions.nodes[edges[car.edge].to].kind === CTL_NONE) {
    // a pass-through node where the lanes shift sideways (a parking lane starts, lanes are added): drift across like a
    // lane change instead of a sharp curve over no distance
    enterNext(w, car, extra, isTraffic, rng);
    const n = edges[car.edge];
    projectOnLane(n, car.px, car.pz, HIT);
    car.latOff = (car.px - HIT.x) * -Math.cos(HIT.heading) + (car.pz - HIT.z) * Math.sin(HIT.heading);
    return;
  }
  car.phase = 'turn';
  car.s = Math.max(0, extra);
  buildTurn(w, car);
}

/** Stand at the stop line (front bumper at it) and wait for the junction (junctionHold is asked again every 0.1 s). */
function toWait(w: World, car: AiCar): void {
  car.phase = 'wait';
  car.holdT = 0.1;
  car.waitT = 0;
  car.stopT = 0;
  car.arriveT = w.time;
  car.commit = false;
  car.cleared = false;
  car.s = Math.min(car.s, stopLine(w.city.roads.edges[car.edge]));
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
      else {
        // (a car given the go short of the line only checks that the junction box is still clear)
        const hold = !isTraffic ? HOLD_GO : car.cleared ? (boxBlocked(w, car) ? HOLD_BOX : HOLD_GO) : junctionHold(w, car, car.speed < 0.5);
        if (hold !== HOLD_GO && car.cleared) w.trafficSim.stats.clearedHeld++;
        if (hold !== HOLD_GO) {
          car.hold = hold;
          toWait(w, car);
        } else {
          startCrossing(w, car, car.s - stop, isTraffic, rng);
          e = edges[car.edge];
        }
      }
    }
  } else if (car.phase === 'turn' && car.s >= car.turnLen) {
    enterNext(w, car, car.s - car.turnLen, isTraffic, rng);
    e = edges[car.edge];
  }
  // ease out of a lane change
  if (car.latOff !== 0) {
    const step = TT.laneChangeRate * dt * Math.min(1, car.speed / 3);
    car.latOff = Math.abs(car.latOff) <= step ? 0 : car.latOff - Math.sign(car.latOff) * step;
  }
  // follow a point a little ahead on the path
  const look = car.s + 2.5 + car.speed * 0.25;
  let lat = 0;
  if (car.phase === 'turn') {
    if (look <= car.turnLen) turnPoint(car, look, tgt);
    else laneSample(edges[car.next], laneStart(edges[car.next]) + look - car.turnLen, tgt);
  } else {
    const stop = stopLine(e);
    if (look > stop && car.phase === 'lane') chooseNext(w, car, rng);
    if (look > stop && car.next >= 0 && car.phase === 'lane' && !needsTurn(e, edges[car.next])) {
      laneSample(edges[car.next], laneStart(edges[car.next]) + look - stop, tgt);
    } else if (car.phase === 'wait') {
      // straight on, never back to the line (a car that pulled up past the lane's end keeps its heading)
      laneSample(e, Math.min(Math.max(look, stop + 0.01), e.len), tgt);
      const past = look - e.len;
      if (past > 0) { tgt.x += Math.sin(tgt.heading) * past; tgt.z += Math.cos(tgt.heading) * past; }
    }
    else laneSample(e, Math.min(look, stop + 0.01), tgt);
    if (car.latOff !== 0) {
      // the sideways offset the car will still have when it gets to the look-ahead point
      const tLook = (look - car.s) / Math.max(car.speed, 1);
      const left = Math.abs(car.latOff) - TT.laneChangeRate * tLook;
      if (left > 0) lat = Math.sign(car.latOff) * left;
    }
  }
  let tx = tgt.x, tz = tgt.z;
  if (lat !== 0) { tx += -Math.cos(tgt.heading) * lat; tz += Math.sin(tgt.heading) * lat; }
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

// ---------- lane changes ----------
/** Is there room to move into lane L beside the car (other AI cars on it, cars turning into it, drivable cars)? */
function laneGapFree(w: World, car: AiCar, L: number): boolean {
  const edges = w.city.roads.edges;
  const sL = car.s;
  if (!laneGapCars(w, car, L, sL, w.traffic) || !laneGapCars(w, car, L, sL, w.police.cars)) return false;
  // drivable cars (yours, parked, abandoned) standing in or moving along L near us
  const e = edges[L];
  laneSample(e, Math.min(sL, e.len), LP);
  const fx = Math.sin(LP.heading), fz = Math.cos(LP.heading);
  const vs = w.vehicles;
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    const rx = v.px - LP.x, rz = v.pz - LP.z;
    if (rx * rx + rz * rz > 900 || Math.abs(v.py - LP.y) > 3) continue;
    const along = rx * fx + rz * fz, lat = rx * fz - rz * fx;
    if (Math.abs(lat) < 2 && along > -10 && along < 10) return false;
  }
  return true;
}

function laneGapCars(w: World, car: AiCar, L: number, sL: number, list: AiCar[]): boolean {
  const edges = w.city.roads.edges;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === car) continue;
    if (o.phase === 'turn') { if (o.next === L) return false; continue; }
    if (o.edge !== L) {
      // someone beside L changing into it too
      if (o.target >= 0 && o.edge !== car.edge && (edges[o.edge].left === L || edges[o.edge].right === L) && Math.abs(o.s - sL) < car.halfL + o.halfL + 6) return false;
      continue;
    }
    const ds = o.s - sL;
    if (ds >= 0) { if (ds - o.halfL - car.halfL < TT.laneChangeGapAhead + car.speed * 0.6) return false; }
    else if (-ds - o.halfL - car.halfL < TT.laneChangeGapBehind + Math.max(0, o.speed - car.speed) * 1.2 + o.speed * 0.3) return false;
  }
  return true;
}

/** Move the car onto neighbour lane L where it is now; it eases across from its current offset. */
function switchLane(w: World, car: AiCar, L: number): void {
  const e = w.city.roads.edges[L];
  projectOnLane(e, car.px, car.pz, HIT);
  const lat = (car.px - HIT.x) * -Math.cos(HIT.heading) + (car.pz - HIT.z) * Math.sin(HIT.heading);
  car.edge = L;
  car.s = Math.max(laneStart(e), Math.min(HIT.s, stopLine(e) - 0.5));
  car.latOff = lat;
  car.hold = HOLD_GO;
  car.holdT = 0;
}

function laneChangeStep(w: World, car: AiCar, dt: number, rng: () => number): void {
  car.lcCool -= dt;
  if (car.target < 0 || car.phase !== 'lane') return;
  const J = w.junctions, edges = w.city.roads.edges;
  const e = edges[car.edge];
  if (J.edgeGroup[car.target] !== J.edgeGroup[car.edge] || car.planMove < 0 || J.edgeGroup[J.mvIn[car.planMove]] !== J.edgeGroup[car.edge]) {
    car.target = -1; // stale plan (the car was moved): plan again
    car.next = -1;
    planMove(w, car, rng);
    return;
  }
  if (car.target === car.edge) { // already there (placed onto it)
    car.target = -1;
    car.next = J.mvOut[car.planMove];
    car.move = car.planMove;
    return;
  }
  const remaining = stopLine(e) - car.s;
  if (remaining < TT.laneChangeMinRoom) {
    car.target = -1;
    w.trafficSim.stats.laneChangeAborts++;
    chooseNext(w, car, rng);
    return;
  }
  if (car.lcCool > 0 || car.s < laneStart(e) + 2 || Math.abs(car.latOff) > 0.5) return;
  const L = J.edgeRank[car.target] > J.edgeRank[car.edge] ? e.left : e.right;
  if (L < 0 || !isTrafficLane(edges[L])) { car.target = -1; chooseNext(w, car, rng); return; }
  if (!laneGapFree(w, car, L)) { car.lcCool = 0.3; return; }
  switchLane(w, car, L);
  car.lcCool = 1;
  w.trafficSim.stats.laneChanges++;
  if (car.edge === car.target) {
    car.target = -1;
    car.next = J.mvOut[car.planMove];
    car.move = car.planMove;
  }
}

/**
 * A circulating car about to leave the ring goes round again instead (it never stops on the ring) when its exit is
 * queued, when the exit lane is too short to stop on before a light that is not green, or, leaving from an inner lane,
 * when a car in an outer lane is level with it or just behind (its exit would cut across that car).
 */
function ringExitCheck(w: World, car: AiCar): void {
  const J = w.junctions, edges = w.city.roads.edges;
  if (car.move < 0 || edges[car.next].roundabout) return;
  const rem = stopLine(edges[car.edge]) - car.s;
  if (rem < TT.ringExitFreeze) return; // decided: entering cars rely on it now (junctions.ts ringScan)
  const around = !exitHasSpace(w, car) || (J.shortLane[car.next] === 1 && holdAhead(w, J, car) !== HOLD_GO)
    || outerLaneAlongside(w, car, rem, w.traffic) || outerLaneAlongside(w, car, rem, w.police.cars);
  if (!around) return;
  const m0 = J.edgeM0[car.edge], n = J.edgeMN[car.edge];
  for (let m = m0; m < m0 + n; m++) {
    if (J.mvOk[m] && edges[J.mvOut[m]].roundabout) { car.next = J.mvOut[m]; car.move = m; w.trafficSim.stats.ringGoRound++; return; }
  }
}

/**
 * Speed limit for a car crossing a junction into a lane too short to stop on that ends at a roundabout entry (K St at
 * Washington Circle): low enough to pull up at the entry if circulating traffic makes it give way there (it decides
 * once it is on that lane), and down to a stop at the entry while the ring is busy now.
 */
function ringCreep(w: World, car: AiCar): number {
  const J = w.junctions, n = w.city.roads.edges[car.next], c = J.nodes[n.to];
  if (c.kind !== CTL_RING) return Infinity;
  const room = car.turnLen - car.s + stopLine(n) - laneStart(n) - car.halfL - TT.stopBehindLine;
  let mv = -1; // the entry move it will make (the first lane-discipline move onto the ring)
  for (let m = J.edgeM0[n.id]; m < J.edgeM0[n.id] + J.edgeMN[n.id] && mv < 0; m++) if (J.mvOk[m]) mv = m;
  const vEnd = ringBlocked(w, J, c, car, mv, TT.ringYieldDist, TT.ringYieldTime, TT.ringYieldNear) ? 0 : TT.ringEntryCreep;
  return Math.sqrt(vEnd * vEnd + 2 * TT.approachDecel * Math.max(0, room));
}

/**
 * Is a car in a lane outside this one (nearer the ring's outer kerb) heading for the same ring node level with `car`
 * (`rem` metres from it) or up to traffic.ringExitGap behind, on a move its exit crosses?
 */
function outerLaneAlongside(w: World, car: AiCar, rem: number, list: AiCar[]): boolean {
  const J = w.junctions, edges = w.city.roads.edges;
  const node = edges[car.edge].to, c = J.nodes[node], myRank = J.edgeRank[car.edge];
  if (myRank <= 0 || rem >= TT.ringExitDecide) return false;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === car || o.respawnWanted) continue;
    const oe = edges[o.edge];
    if (!oe.roundabout || J.edgeRank[o.edge] >= myRank) continue;
    const d = ringDist(w, o, node);
    if (d < rem - 2 * car.halfL || d > rem + TT.ringExitGap) continue;
    if (oe.to === node && o.move >= 0 && J.mvNode[o.move] === node && !movesConflict(J, c, car.move, o.move)) continue;
    return true;
  }
  return false;
}

// ---------- the per-step update ----------
export function updateTraffic(w: World, dt: number): void {
  updateJunctions(w, dt);
  cachePositions(w);
  const rng = Math.random;
  const pv = w.player.vehicle;
  const pp = w.player.mesh.position;
  const J = w.junctions;
  const { edges } = w.city.roads;
  for (const car of w.traffic) {
    car.honkCd -= dt;
    if (stunCheck(car, dt)) {
      if (car.stunT <= 0) recoverAfterStun(w, car);
      continue;
    }
    if (car.respawnWanted) {
      // shoved off the road, gridlocked or leaving the map: stand still until the population manager moves it
      car.stuckT += dt;
      car.speed = 0;
      const lv = car.body.linvel();
      car.body.setLinvel(velXZ(lv.x * 0.8, lv.y, lv.z * 0.8), true);
      continue;
    }
    if (car.next < 0 && car.target < 0 && car.phase === 'lane') planMove(w, car, rng);
    laneChangeStep(w, car, dt, rng);
    let e = edges[car.edge];
    let want = e.roundabout ? Math.min(e.speed, TT.ringSpeed) : e.speed;
    if (car.phase === 'wait') {
      want = 0;
      car.waitT += dt;
      if (car.speed < 0.3) car.stopT += dt;
      car.holdT -= dt;
      if (car.holdT <= 0) {
        car.holdT = 0.1;
        car.hold = junctionHold(w, car, true);
        if (car.hold === HOLD_GO) {
          const mv = car.move;
          if (stopLine(e) - car.s > 0.5) {
            // standing short of the line (bumper at it): drive up and cross
            car.phase = 'lane';
            car.cleared = true;
            want = mv >= 0 ? J.mvSpeed[mv] : TT.turnSpeedMin;
          } else {
            startCrossing(w, car, 0, true, rng);
            e = edges[car.edge];
            const turning = (car.phase as AiCar['phase']) === 'turn';
            want = turning ? (mv >= 0 ? J.mvSpeed[mv] : TT.turnSpeedMin) : e.speed;
          }
        }
      }
    } else if (car.phase === 'turn') {
      if (car.move >= 0) want = Math.min(want, J.mvSpeed[car.move]);
      else want = Math.min(want, 6.5);
      if (car.next >= 0 && J.shortLane[car.next]) want = Math.min(want, ringCreep(w, car));
    } else {
      // approaching the junction ahead: may we enter? brake for the stop line if not, else for the curve
      const c = J.nodes[e.to];
      if (e.roundabout && car.next >= 0 && stopLine(e) - car.s < 20) ringExitCheck(w, car);
      const rem = stopLine(e) - car.s;
      let vEnd = car.move >= 0 ? J.mvSpeed[car.move] : car.target >= 0 ? e.speed : TT.turnSpeedMin;
      // a roundabout entry: reach the line slowly enough to stop there if a circulating car turns up late
      if (c.kind === CTL_RING && !e.roundabout) vEnd = Math.min(vEnd, TT.ringEntryCreep);
      let remStop = rem;
      if (c.kind !== 0 && car.next >= 0 && !car.cleared) {
        if (rem < (car.speed * car.speed) / (2 * TT.approachDecel) + TT.decideDist) {
          car.holdT -= dt;
          if (car.holdT <= 0) { car.holdT = 0.15; car.hold = junctionHold(w, car, false); }
        } else car.hold = HOLD_GO;
        if (car.hold !== HOLD_GO) { vEnd = 0; remStop = rem - car.halfL - TT.stopBehindLine - J.edgeStopBack[car.edge]; } // front bumper at the line
      }
      // a road leaving the map: the car drives off it (moved near the player again once out of sight)
      if (J.mapEdge[e.to] && rem < 10 && !car.keep && !visible(w, car.px, car.py - 0.62, car.pz)) { car.respawnWanted = true; w.trafficSim.stats.leftMap++; }
      want = Math.min(want, Math.sqrt(vEnd * vEnd + 2 * TT.approachDecel * Math.max(0, remStop)));
      if (car.speed < 0.5) car.commit = false;
      if (car.hold !== HOLD_GO && remStop < 1 && car.speed < 1) toWait(w, car); // pulled up at the line: wait there
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

    // stuck for ages (e.g. gridlocked behind a parked player car) or nowhere to go: move it away out of sight
    if (car.speed < 0.3 && car.phase !== 'wait') car.stuckT += dt;
    else car.stuckT = 0;
    if (car.stuckT > TT.stuckRecycle && !car.keep) { car.respawnWanted = true; w.trafficSim.stats.recycled++; }
  }
  if (w.trafficSim.measure) auditTraffic(w, dt);
}

/** After being shoved: carry on along the lane it is next to (and facing along), else wait to be moved out of sight. */
function recoverAfterStun(w: World, car: AiCar): void {
  const edges = w.city.roads.edges;
  if (w.city.nearestLane(car.px, car.pz, 3, HIT, car.py - 0.62)) {
    const e = edges[HIT.edge];
    const dh = Math.abs(Math.atan2(Math.sin(HIT.heading - car.heading), Math.cos(HIT.heading - car.heading)));
    if (isTrafficLane(e) && dh < 0.9 && HIT.s > laneStart(e) && HIT.s < stopLine(e) - 2) {
      car.edge = e.id;
      car.s = HIT.s;
      car.phase = 'lane';
      car.next = -1;
      car.move = -1;
      car.target = -1;
      car.latOff = 0;
      car.hold = HOLD_GO;
      car.respawns++; // not a move along the road: the audit must not count the jump
      return;
    }
  }
  if (car.keep) { placeRandom(w, car, 90, Math.random); return; }
  car.respawnWanted = true;
  w.trafficSim.stats.recycled++;
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

