// Junction control for AI traffic: the moves each lane may make at the junction ahead (lane discipline), which of
// those moves cross or merge (conflicts), traffic signal phases, and the rule a car follows before it enters:
//  - signals: phases of approaches (head-on approaches share one), green / amber / all-red, actuated by detectors at
//    the stop lines (AI cars and your car): a phase is called when someone waits on it and held green while traffic
//    keeps coming, up to its longest green; cars stop on red and on amber when they can; left turns on green give way
//    to oncoming traffic (and clear on amber);
//  - stop signs (all-way): a full stop, then first come, first served;
//  - uncontrolled: the lower road class gives way; between equal roads a short pause and first come, first served;
//  - roundabout (Washington Circle): entering cars yield to cars circulating toward their entry; circulating cars never
//    stop at the ring's nodes;
//  - everywhere: never start across the junction while a crossing move is in it, nor when the exit lane is queued.
// Built once per map from the CityMap road graph (any map: the grid has only all-way and priority junctions).
import { TUNING } from '../tuning';
import type { World } from '../world';
import { laneSample, type CityMap, type LaneEdge, type LaneHit, type LanePoint } from './map/cityMap';
import type { AiCar } from './traffic';

const TT = TUNING.traffic;
const SG = TUNING.signals;
/** Segments on a junction curve. */
export const TURN_SEGS = 8;

export const CTL_NONE = 0; // a pass-through node: lanes run on
export const CTL_SIGNALS = 1;
export const CTL_STOP = 2;
export const CTL_PRIORITY = 3; // uncontrolled, roads of different class meet: the lower class gives way
export const CTL_ALLWAY = 4; // uncontrolled, equal roads: pause, then first come, first served
export const CTL_RING = 5;
export const CTL_DEADEND = 6;
export const CTL_NAMES = ['none', 'signals', 'stop', 'priority', 'allway', 'ring', 'deadend'];

export const MOVE_STRAIGHT = 0;
export const MOVE_RIGHT = 1;
export const MOVE_LEFT = 2;
export const MOVE_UTURN = 3;

export const LIGHT_GREEN = 0;
export const LIGHT_AMBER = 1;
export const LIGHT_RED = 2;
export const LIGHT_NONE = 3;

/** Why a car may not enter the junction ahead (HOLD_GO: it may). */
export const HOLD_GO = 0;
export const HOLD_RED = 1;
export const HOLD_STOP = 2;
export const HOLD_YIELD = 3;
export const HOLD_BOX = 4;
export const HOLD_EXIT = 5;
export const HOLD_RING = 6;
export const HOLD_NAMES = ['go', 'red', 'stop', 'yield', 'box', 'exit', 'ring'];

// ------------------------------------------------------------------------------------------- lane geometry
/** Where a lane's drivable part starts (cars leave the junction at `from` here). */
export function laneStart(e: LaneEdge): number {
  return Math.min(e.trimStart, e.len * 0.5);
}
/** Where a lane's drivable part ends: the stop line before the junction at `to`. */
export function stopLine(e: LaneEdge): number {
  return Math.max(laneStart(e), e.len - e.trimEnd);
}
/** Going straight back along the road just driven (its twin, or another lane of the same road). */
export function isUTurn(e: LaneEdge, n: LaneEdge): boolean {
  return n.id === e.twin || (n.to === e.from && n.roadId === e.roadId);
}
/** Traffic may drive this lane: not a parking lane that has another lane going the same way. */
export function isTrafficLane(e: LaneEdge): boolean {
  return !(e.parking && e.lanesSameDir > 1);
}

const LA: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
const LB: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

/**
 * Junction curve from the stop line of `e` to the start of `n` (a quadratic Bezier through the corner where the two
 * lane lines meet; a U-turn bulges forward): TURN_SEGS + 1 points as x,z pairs into P, cumulative lengths into C.
 * Returns its length. Allocation-free.
 */
export function turnCurve(e: LaneEdge, n: LaneEdge, P: Float32Array, C: Float32Array, o = 0): number {
  const a = laneSample(e, stopLine(e), LA), b = laneSample(n, laneStart(n), LB);
  const d1x = Math.sin(a.heading), d1z = Math.cos(a.heading), d2x = Math.sin(b.heading), d2z = Math.cos(b.heading);
  const rx = b.x - a.x, rz = b.z - a.z, gap = Math.hypot(rx, rz);
  const cross = d1x * d2z - d1z * d2x, dot = d1x * d2x + d1z * d2z;
  let cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
  if (dot < -0.5) {
    cx += d1x * (gap * 0.9 + TT.uTurnReach);
    cz += d1z * (gap * 0.9 + TT.uTurnReach);
  } else if (Math.abs(cross) > 0.05) {
    const t = (rx * d2z - rz * d2x) / cross;
    if (t > 0 && t < gap * 2) { cx = a.x + d1x * t; cz = a.z + d1z * t; }
  }
  const oc = o / 2;
  for (let k = 0; k <= TURN_SEGS; k++) {
    const t = k / TURN_SEGS, u = 1 - t;
    P[o + k * 2] = u * u * a.x + 2 * u * t * cx + t * t * b.x;
    P[o + k * 2 + 1] = u * u * a.z + 2 * u * t * cz + t * t * b.z;
    C[oc + k] = k === 0 ? 0 : C[oc + k - 1] + Math.hypot(P[o + k * 2] - P[o + k * 2 - 2], P[o + k * 2 + 1] - P[o + k * 2 - 1]);
  }
  return Math.max(0.01, C[oc + TURN_SEGS]);
}

// ------------------------------------------------------------------------------------------- state
export interface NodeCtl {
  id: number;
  kind: number;
  /** First global move index of this node and the number of moves (conflict is nm x nm, node-local indices). */
  m0: number;
  nm: number;
  conflict: Uint8Array;
  /** Approaches: groups of in-lanes from the same neighbour on the same road. */
  apCount: number;
  apRank: Int8Array;
  apHeading: Float32Array;
  majorRank: number;
  // ---- signals ----
  phases: number;
  /** The last phase is an all-red walk phase (a signal with only one traffic phase). */
  pedPhase: boolean;
  apPhase: Int8Array;
  greens: Float32Array;
  phase: number;
  stage: number; // 0 green, 1 amber, 2 all-red
  t: number; // seconds into the stage
  /** Seconds until the green is checked again (detectors: is anyone else waiting, is traffic still coming?). */
  checkT: number;
}

export interface JunctionState {
  nodes: NodeCtl[];
  // moves (global index): in lane, out lane, type, lane-discipline flag, curve speed, node
  mvIn: Int32Array;
  mvOut: Int32Array;
  mvType: Uint8Array;
  mvOk: Uint8Array;
  mvSpeed: Float32Array;
  mvNode: Int32Array;
  // per lane edge
  /** First move (global index) leaving the junction ahead from this lane, and how many. */
  edgeM0: Int32Array;
  edgeMN: Uint8Array;
  /** Approach index of this lane at its `to` node. */
  edgeAp: Int16Array;
  /** Traffic-lane rank from the kerb (0 = rightmost traffic lane), -1 for a parking lane; and lanes in its group. */
  edgeRank: Int8Array;
  edgeLanes: Int8Array;
  /** Group id (same from, to, road): the rightmost lane's id. */
  edgeGroup: Int32Array;
  /**
   * Metres further back than the stop line a car waiting in this lane stands, so that its body stays clear of the
   * other approaches' junction curves (tight or skewed junctions, where the curves cut past the stop lines).
   */
  edgeStopBack: Float32Array;
  /** Light shown to this lane at its `to` node (LIGHT_*). */
  light: Uint8Array;
  /** Set when any light changed (signalHeads.ts redraws, then clears it). */
  lightsChanged: boolean;
  signalNodes: number[];
  /** The lane the player's car is driving toward a junction on (-1: none) and how far along it: signals detect it too. */
  playerEdge: number;
  playerS: number;
  playerCheck: number;
  /** Per node: a dead end at the edge of the map (a road leaving it): traffic drives off there instead of turning round. */
  mapEdge: Uint8Array;
}

// ------------------------------------------------------------------------------------------- build
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Smallest distance between two polylines (x,z pairs at offsets oa and ob, TURN_SEGS + 1 points each). */
function curveDist(P: Float32Array, oa: number, ob: number): number {
  let best = Infinity;
  for (let i = 0; i < TURN_SEGS; i++) {
    const ax = P[oa + i * 2], az = P[oa + i * 2 + 1], bx = P[oa + i * 2 + 2], bz = P[oa + i * 2 + 3];
    for (let j = 0; j < TURN_SEGS; j++) {
      const cx = P[ob + j * 2], cz = P[ob + j * 2 + 1], dx = P[ob + j * 2 + 2], dz = P[ob + j * 2 + 3];
      const d = segSegDist(ax, az, bx, bz, cx, cz, dx, dz);
      if (d < best) best = d;
    }
  }
  return best;
}

function segSegDist(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  // proper crossing: 0
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(ptSeg(ax, az, cx, cz, dx, dz), ptSeg(bx, bz, cx, cz, dx, dz), ptSeg(cx, cz, ax, az, bx, bz), ptSeg(dx, dz, ax, az, bx, bz));
}
function ptSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
  let t = l2 > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + ex * t - px, az + ez * t - pz);
}

/** Straight on keeps to the lane that carries on where this one stops (nearest start point among traffic lanes of the same road). */
function nearestStraight(edges: LaneEdge[], outs: number[], a: LaneEdge): number {
  laneSample(a, stopLine(a), LA);
  const ax = LA.x, az = LA.z, ha = LA.heading;
  let best = -1, bestD = Infinity, bestRoad = '';
  for (const id of outs) {
    const b = edges[id];
    if (!isTrafficLane(b) || isUTurn(a, b)) continue;
    laneSample(b, laneStart(b), LB);
    if (Math.abs(wrap(LB.heading - ha)) > 0.55) continue;
    // lateral distance from a's stop point to b's lane line
    const lat = Math.abs((ax - LB.x) * Math.cos(LB.heading) - (az - LB.z) * Math.sin(LB.heading));
    // prefer the same road carrying on
    const d = lat + (b.roadId === a.roadId ? 0 : 0.5);
    if (d < bestD || (Math.abs(d - bestD) < 1e-3 && b.roadId === a.roadId && bestRoad !== a.roadId)) { bestD = d; best = id; bestRoad = b.roadId; }
  }
  return best;
}

/** Build the junction tables for a map (once, at boot). */
export function createJunctions(map: CityMap): JunctionState {
  const { nodes, edges } = map.roads;
  const E = edges.length;
  const edgeRank = new Int8Array(E), edgeLanes = new Int8Array(E), edgeGroup = new Int32Array(E), edgeAp = new Int16Array(E).fill(-1);
  // ---- lane groups and ranks ----
  for (const e of edges) {
    let lo = e;
    while (lo.right >= 0) lo = edges[lo.right];
    edgeGroup[e.id] = lo.id;
    let k = 0, rank = -1;
    for (let l: LaneEdge | null = lo; l; l = l.left >= 0 ? edges[l.left] : null) {
      if (!isTrafficLane(l)) continue;
      if (l === e) rank = k;
      k++;
    }
    edgeRank[e.id] = rank;
    edgeLanes[e.id] = Math.max(1, k);
  }
  // ---- moves ----
  const mvIn: number[] = [], mvOut: number[] = [], mvType: number[] = [], mvOk: number[] = [], mvSpeed: number[] = [], mvNode: number[] = [];
  const edgeM0 = new Int32Array(E), edgeMN = new Uint8Array(E), edgeStopBack = new Float32Array(E);
  const ctls: NodeCtl[] = [];
  const P = new Float32Array(2 * (TURN_SEGS + 1)), C = new Float32Array(TURN_SEGS + 1);
  const rankOf = (e: LaneEdge) => TT.classRank[e.cls];
  for (const node of nodes) {
    const m0 = mvIn.length;
    // approaches
    const apKeys: string[] = [];
    const apRankL: number[] = [], apHeadL: number[] = [];
    for (const id of node.in) {
      const e = edges[id];
      const key = `${e.from}|${e.roadId}`;
      let ap = apKeys.indexOf(key);
      if (ap < 0) {
        ap = apKeys.length;
        apKeys.push(key);
        apRankL.push(rankOf(e));
        apHeadL.push(laneSample(e, stopLine(e), LA).heading);
      } else apRankL[ap] = Math.max(apRankL[ap], rankOf(e));
      edgeAp[id] = ap;
    }
    for (const id of node.in) {
      const a = edges[id];
      edgeM0[id] = mvIn.length;
      const traffic = isTrafficLane(a);
      for (const oid of node.out) {
        const b = edges[oid];
        if (!isTrafficLane(b) && traffic) continue;
        const uturn = isUTurn(a, b);
        if (uturn && !node.deadEnd) continue;
        // move type
        let type: number;
        if (a.roundabout && b.roundabout) type = MOVE_STRAIGHT;
        else if (a.roundabout !== b.roundabout) type = MOVE_RIGHT; // joining or leaving the ring
        else if (uturn) type = MOVE_UTURN;
        else {
          const ha = laneSample(a, stopLine(a), LA).heading, hb = laneSample(b, laneStart(b), LB).heading;
          const dh = wrap(hb - ha);
          type = Math.abs(dh) < 0.55 ? MOVE_STRAIGHT : Math.abs(dh) > 2.6 ? MOVE_UTURN : dh < 0 ? MOVE_RIGHT : MOVE_LEFT;
        }
        // lane discipline: right turns from the kerbside lane into the kerbside lane, left turns from the inside lane
        // into the inside lane, straight on keeps its lane (the inside lanes merge where lanes end)
        const ra = edgeRank[a.id], ka = edgeLanes[a.id], rb = edgeRank[b.id], kb = edgeLanes[b.id];
        let ok = false;
        if (ra >= 0 && rb >= 0) {
          if (node.deadEnd) ok = true;
          else if (a.roundabout && b.roundabout) ok = rb === ra;
          else if (b.roundabout) ok = rb === Math.min(ra, kb - 1);
          else if (a.roundabout) ok = ra < kb && rb === ra;
          else if (type === MOVE_STRAIGHT) ok = b.id === nearestStraight(edges, node.out, a);
          else if (type === MOVE_RIGHT) ok = ra === 0 && rb === 0;
          else ok = ra === ka - 1 && rb === kb - 1;
        }
        // curve speed from the heading change over the curve
        const len = turnCurve(a, b, P, C);
        const h0 = Math.atan2(P[2] - P[0], P[3] - P[1]), h1 = Math.atan2(P[TURN_SEGS * 2] - P[TURN_SEGS * 2 - 2], P[TURN_SEGS * 2 + 1] - P[TURN_SEGS * 2 - 1]);
        const bend = Math.abs(wrap(h1 - h0));
        const radius = bend > 0.05 ? len / bend : Infinity;
        const speed = Math.max(TT.turnSpeedMin, Math.min(b.speed, a.speed, Math.sqrt(TT.turnLatAccel * radius)));
        mvIn.push(a.id); mvOut.push(b.id); mvType.push(type); mvOk.push(ok ? 1 : 0); mvSpeed.push(speed); mvNode.push(node.id);
      }
      edgeMN[id] = mvIn.length - edgeM0[id];
    }
    const nm = mvIn.length - m0;
    // ---- conflicts between this node's moves ----
    const curves = new Float32Array(nm * 2 * (TURN_SEGS + 1));
    const cumTmp = new Float32Array(nm * (TURN_SEGS + 1));
    for (let i = 0; i < nm; i++) turnCurve(edges[mvIn[m0 + i]], edges[mvOut[m0 + i]], curves, cumTmp, i * 2 * (TURN_SEGS + 1));
    const conflict = new Uint8Array(nm * nm);
    for (let i = 0; i < nm; i++) {
      for (let j = i + 1; j < nm; j++) {
        let c = 0;
        if (mvIn[m0 + i] === mvIn[m0 + j]) c = 0; // the same lane: one follows the other
        else if (mvOut[m0 + i] === mvOut[m0 + j]) c = 1; // merging into one lane
        else if (curveDist(curves, i * 2 * (TURN_SEGS + 1), j * 2 * (TURN_SEGS + 1)) < TT.conflictDist) c = 1;
        conflict[i * nm + j] = conflict[j * nm + i] = c;
      }
    }
    // ---- where waiting cars stand: back from the line until clear of the other approaches' curves ----
    for (const id of node.in) {
      const a = edges[id];
      if (!isTrafficLane(a) || node.deadEnd) continue;
      const f = laneSample(a, Math.max(laneStart(a), stopLine(a) - TT.stopBehindLine), LA);
      const fx = f.x, fz = f.z, dx = Math.sin(f.heading), dz = Math.cos(f.heading);
      let back = 0;
      for (; back < TT.stopBackMax; back += 0.5) {
        // the front of a waiting car: from its bumper `back` metres behind the line to 4 m further back
        const ax = fx - dx * back, az = fz - dz * back, bx = ax - dx * 4, bz = az - dz * 4;
        let clear = true;
        for (let i = 0; i < nm && clear; i++) {
          if (edgeAp[mvIn[m0 + i]] === edgeAp[id]) continue; // our own approach's moves start beside us
          const o = i * 2 * (TURN_SEGS + 1);
          for (let j = 0; j < TURN_SEGS && clear; j++) {
            if (segSegDist(ax, az, bx, bz, curves[o + j * 2], curves[o + j * 2 + 1], curves[o + j * 2 + 2], curves[o + j * 2 + 3]) < TT.stopClearance) clear = false;
          }
        }
        if (clear) break;
      }
      edgeStopBack[id] = Math.min(back, Math.max(0, stopLine(a) - laneStart(a) - 6));
    }
    // ---- control ----
    const apCount = apKeys.length;
    const apRank = Int8Array.from(apRankL), apHeading = Float32Array.from(apHeadL);
    const majorRank = apCount ? Math.max(...apRankL) : 0;
    let kind = CTL_NONE;
    if (node.roundabout && (node.in.some((i) => edges[i].roundabout) || node.out.some((i) => edges[i].roundabout))) kind = CTL_RING;
    else if (node.deadEnd) kind = CTL_DEADEND;
    else if (!node.junction) kind = CTL_NONE;
    else if (node.signals) kind = CTL_SIGNALS;
    else if (node.stop) kind = CTL_STOP;
    else kind = apRankL.every((r) => r === majorRank) ? CTL_ALLWAY : CTL_PRIORITY;
    // ---- signal phases: approaches that meet head-on share a phase; biggest road first ----
    const apPhase = new Int8Array(apCount).fill(-1);
    let phases = 0, pedPhase = false;
    const greensL: number[] = [];
    if (kind === CTL_SIGNALS) {
      const order = [...Array(apCount).keys()].sort((p, q) => apRankL[q] - apRankL[p]);
      for (const a of order) {
        if (apPhase[a] >= 0) continue;
        const ph = phases++;
        apPhase[a] = ph;
        let best = -1, bestDot = Infinity;
        for (const b of order) {
          if (apPhase[b] >= 0) continue;
          const diff = Math.abs(wrap(apHeadL[a] - apHeadL[b]));
          if (diff > SG.oppositeAngle) { const d = -diff; if (d < bestDot) { bestDot = d; best = b; } }
        }
        if (best >= 0) apPhase[best] = ph;
        greensL.push(apRankL[a] === majorRank && ph === 0 ? SG.green : SG.greenSide);
      }
      if (phases === 1) { pedPhase = true; phases = 2; greensL.push(SG.pedPhase); }
      // a phase carrying the junction's biggest road gets the long green
      for (let p = 0; p < phases; p++) if (!(pedPhase && p === phases - 1) && apRankL.some((r, a) => apPhase[a] === p && r === majorRank)) greensL[p] = SG.green;
    }
    const ctl: NodeCtl = {
      id: node.id, kind, m0, nm, conflict, apCount, apRank, apHeading, majorRank,
      phases, pedPhase, apPhase, greens: Float32Array.from(greensL), phase: 0, stage: 0, t: 0, checkT: 0,
    };
    ctls.push(ctl);
  }
  const J: JunctionState = {
    nodes: ctls,
    mvIn: Int32Array.from(mvIn), mvOut: Int32Array.from(mvOut), mvType: Uint8Array.from(mvType), mvOk: Uint8Array.from(mvOk),
    mvSpeed: Float32Array.from(mvSpeed), mvNode: Int32Array.from(mvNode),
    edgeM0, edgeMN, edgeAp, edgeRank, edgeLanes, edgeGroup, edgeStopBack,
    light: new Uint8Array(E).fill(LIGHT_NONE), lightsChanged: true, playerEdge: -1, playerS: 0, playerCheck: 0,
    signalNodes: ctls.filter((c) => c.kind === CTL_SIGNALS).map((c) => c.id),
    mapEdge: Uint8Array.from(nodes, (n) => {
      const b = map.bounds, m = TT.mapEdgeRange;
      return n.deadEnd && (n.x < b.minX + m || n.x > b.maxX - m || n.z < b.minZ + m || n.z > b.maxZ - m) ? 1 : 0;
    }),
  };
  // signals start green for their biggest road; fixed-time crossings are staggered (from the id, never the seed)
  for (const id of J.signalNodes) {
    const c = ctls[id];
    let cycle = 0;
    for (let p = 0; p < c.phases; p++) cycle += c.greens[p] + (c.pedPhase && p === c.phases - 1 ? 0 : SG.amber + SG.allRed);
    if (c.pedPhase) advanceFixed(c, ((id * 7919) % 1000) / 1000 * cycle);
    else c.t = ((id * 7919) % 1000) / 1000 * SG.minGreen;
    setLights(J, map, c);
  }
  return J;
}

// ------------------------------------------------------------------------------------------- signals
function stageTime(c: NodeCtl): number {
  const ped = c.pedPhase && c.phase === c.phases - 1;
  return c.stage === 0 ? c.greens[c.phase] : ped ? 0 : c.stage === 1 ? SG.amber : SG.allRed;
}
/** Advance a fixed-time signal's clock (a mid-block crossing: traffic, then the walk phase); true if its stage changed. */
function advanceFixed(c: NodeCtl, dt: number): boolean {
  c.t += dt;
  let changed = false;
  for (let guard = 0; guard < 16 && c.t >= stageTime(c); guard++) {
    c.t -= stageTime(c);
    c.stage++;
    if (c.stage > 2) { c.stage = 0; c.phase = (c.phase + 1) % c.phases; }
    changed = true;
  }
  return changed;
}
function setLights(J: JunctionState, map: CityMap, c: NodeCtl): void {
  const ins = map.roads.nodes[c.id].in;
  const ped = c.pedPhase && c.phase === c.phases - 1;
  for (let i = 0; i < ins.length; i++) {
    const e = ins[i], ap = J.edgeAp[e];
    let L = LIGHT_RED;
    if (!ped && ap >= 0 && c.apPhase[ap] === c.phase) L = c.stage === 0 ? LIGHT_GREEN : c.stage === 1 ? LIGHT_AMBER : LIGHT_RED;
    if (J.light[e] !== L) { J.light[e] = L; J.lightsChanged = true; }
  }
}
/**
 * Is there traffic for this phase: a car on one of its approaches within `near` metres of the stop line (with
 * `moving`: still driving toward it, or already close), or the player's car? (detector loops at the stop lines)
 */
function phaseDemand(w: World, J: JunctionState, c: NodeCtl, phase: number, near: number, moving: boolean): boolean {
  const edges = w.city.roads.edges;
  const t = w.traffic;
  for (let i = 0; i < t.length; i++) {
    const o = t[i];
    if (o.phase === 'turn' || o.respawnWanted) continue;
    const e = edges[o.edge];
    if (e.to !== c.id) continue;
    const ap = J.edgeAp[o.edge];
    if (ap < 0 || c.apPhase[ap] !== phase) continue;
    const rem = stopLine(e) - o.s;
    if (rem > near || (moving && o.speed < 1 && rem > 8)) continue;
    return true;
  }
  if (J.playerEdge >= 0) {
    const e = edges[J.playerEdge], ap = J.edgeAp[J.playerEdge];
    if (e.to === c.id && ap >= 0 && c.apPhase[ap] === phase && stopLine(e) - J.playerS < near) return true;
  }
  return false;
}

/**
 * Actuated signal: green for at least minGreen, then held while traffic keeps coming on it (up to its maximum) or
 * while nobody waits elsewhere; amber; all-red; then the next phase that has traffic waiting (else the main road).
 * Returns true if the lights changed.
 */
function stepSignal(w: World, J: JunctionState, c: NodeCtl, dt: number): boolean {
  if (c.pedPhase) return advanceFixed(c, dt);
  c.t += dt;
  if (c.stage === 0) {
    if (c.t < SG.minGreen) return false;
    c.checkT -= dt;
    if (c.checkT > 0) return false;
    c.checkT = SG.checkEvery;
    let other = false;
    for (let p = 0; p < c.phases && !other; p++) if (p !== c.phase && phaseDemand(w, J, c, p, SG.detectDist, false)) other = true;
    if (!other) return false; // nobody waiting elsewhere: rest in green
    if (c.t < c.greens[c.phase] && phaseDemand(w, J, c, c.phase, SG.passageDist, true)) return false; // traffic still coming
    c.stage = 1;
    c.t = 0;
    return true;
  }
  if (c.stage === 1) {
    if (c.t < SG.amber) return false;
    c.stage = 2;
    c.t = 0;
    return true;
  }
  if (c.t < SG.allRed) return false;
  let next = -1;
  for (let k = 1; k <= c.phases && next < 0; k++) {
    const p = (c.phase + k) % c.phases;
    if (phaseDemand(w, J, c, p, SG.detectDist, false)) next = p;
  }
  c.phase = next >= 0 ? next : 0;
  c.stage = 0;
  c.t = 0;
  c.checkT = 0;
  return true;
}

const PH: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
/** Run the signals (every simulation step). */
export function updateJunctions(w: World, dt: number): void {
  const J = w.junctions;
  // the player's car on the detectors (a few times a second)
  J.playerCheck -= dt;
  if (J.playerCheck <= 0) {
    J.playerCheck = 0.1;
    J.playerEdge = -1;
    const v = w.player.vehicle;
    if (v && w.city.nearestLane(v.px, v.pz, 5, PH, v.py - 0.5) && Math.cos(PH.heading - v.heading) > 0.5) { J.playerEdge = PH.edge; J.playerS = PH.s; }
  }
  const ids = J.signalNodes;
  for (let i = 0; i < ids.length; i++) {
    const c = J.nodes[ids[i]];
    if (stepSignal(w, J, c, dt)) setLights(J, w.city, c);
  }
}
/** Seconds of amber left at this signal (0 if it is not amber). */
export function amberLeft(c: NodeCtl): number {
  return c.kind === CTL_SIGNALS && c.stage === 1 ? Math.max(0, SG.amber - c.t) : 0;
}

// ------------------------------------------------------------------------------------------- queries
/** The move from lane a into lane b at a's `to` node (global index), or -1 if the table has none (U-turn, parking lane). */
export function findMove(J: JunctionState, a: number, b: number): number {
  const m0 = J.edgeM0[a], n = J.edgeMN[a];
  for (let k = m0; k < m0 + n; k++) if (J.mvOut[k] === b) return k;
  return -1;
}
/** Do two moves through node `c` cross or merge? Unknown moves (-1, another node) conflict with everything. */
export function movesConflict(J: JunctionState, c: NodeCtl, m1: number, m2: number): boolean {
  if (m1 < 0 || m2 < 0 || J.mvNode[m1] !== c.id || J.mvNode[m2] !== c.id) return true;
  return c.conflict[(m1 - c.m0) * c.nm + (m2 - c.m0)] === 1;
}

/**
 * Distance (m) along the ring from circulating car `o` to ring node `node` (0: crossing that node now), Infinity if
 * it is not on the ring heading there within the next ring segment.
 */
export function ringDist(w: World, o: AiCar, node: number): number {
  const edges = w.city.roads.edges;
  const oe = edges[o.edge];
  const ne = o.next >= 0 ? edges[o.next] : null;
  if (o.phase === 'turn') {
    if (!ne || !ne.roundabout) return Infinity; // leaving the ring
    if (oe.to === node) return 0; // in the node's box (joining or going round)
    if (ne.to === node) return Math.max(0, o.turnLen - o.s) + stopLine(ne) - laneStart(ne);
    return Infinity;
  }
  if (!oe.roundabout) return Infinity;
  if (oe.to === node) return Math.max(0, stopLine(oe) - o.s);
  if (ne && ne.roundabout && ne.to === node) return Math.max(0, stopLine(oe) - o.s) + oe.trimEnd + ne.trimStart + stopLine(ne) - laneStart(ne);
  return Infinity;
}

const XP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
/** Is there room on the car's exit lane past the junction (no queue standing at its start)? */
export function exitHasSpace(w: World, car: AiCar): boolean {
  if (car.next < 0) return true;
  const n = w.city.roads.edges[car.next];
  const need = laneStart(n) + 2 * car.halfL + TT.exitSpace;
  const lim = TT.exitSpaceSpeed;
  const traffic = w.traffic;
  for (let i = 0; i < traffic.length; i++) {
    const o = traffic[i];
    if (o !== car && o.edge === car.next && o.phase !== 'turn' && o.s - o.halfL < need && o.speed < lim) return false;
  }
  const pol = w.police.cars;
  for (let i = 0; i < pol.length; i++) {
    const o = pol[i];
    if (o.edge === car.next && o.phase !== 'turn' && o.s - o.halfL < need && o.speed < lim) return false;
  }
  // a parked or abandoned drivable car across the exit
  laneSample(n, Math.min(n.len, need * 0.5), XP);
  const vs = w.vehicles, r = need * 0.5 + 1;
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    const dx = v.px - XP.x, dz = v.pz - XP.z;
    if (dx * dx + dz * dz < r * r && Math.abs(v.py - XP.y) < 3 && Math.abs(v.speed) < lim) {
      // only if it stands in the lane (within a car width of its centre line)
      const lat = Math.abs(dx * Math.cos(XP.heading) - dz * Math.sin(XP.heading));
      if (lat < 1.6) return false;
    }
  }
  return true;
}

/** True if `o` is crossing node c (its junction curve) on a move that conflicts with `mv`. */
function inBox(w: World, J: JunctionState, c: NodeCtl, o: AiCar, mv: number): boolean {
  if (o.respawnWanted) return false;
  const e = w.city.roads.edges[o.edge];
  if (e.to !== c.id) return false;
  if (o.phase === 'turn') return movesConflict(J, c, mv, o.move);
  // about to cross: given the go and too close to stop for us
  if (o.phase === 'lane' && o.hold === HOLD_GO && o.next >= 0 && o.speed > 2 && !(c.kind === CTL_RING && e.roundabout)) {
    const rem = stopLine(e) - o.s;
    if (rem < o.speed * TT.boxReserveTime + 1) return movesConflict(J, c, mv, o.move);
  }
  return false;
}

/** Is a car crossing the junction ahead of `car` on a move that conflicts with its own (or has its light turned red)? */
export function boxBlocked(w: World, car: AiCar): boolean {
  const J = w.junctions;
  const c = J.nodes[w.city.roads.edges[car.edge].to];
  if (c.kind === CTL_SIGNALS && J.light[car.edge] === LIGHT_RED && !car.commit) return true;
  const traffic = w.traffic;
  for (let i = 0; i < traffic.length; i++) { const o = traffic[i]; if (o !== car && inBox(w, J, c, o, car.move)) return true; }
  const pol = w.police.cars;
  for (let i = 0; i < pol.length; i++) if (inBox(w, J, c, pol[i], car.move)) return true;
  return false;
}

/**
 * May `car` (traffic, approaching or waiting at the stop line of its lane, with its next lane chosen) enter the
 * junction ahead now? Returns HOLD_GO, or why not. `atLine`: the car is standing at the stop line.
 */
export function junctionHold(w: World, car: AiCar, atLine: boolean): number {
  const J = w.junctions;
  const edges = w.city.roads.edges;
  const e = edges[car.edge];
  const c = J.nodes[e.to];
  const k = c.kind;
  if (k === CTL_NONE || k === CTL_DEADEND) return HOLD_GO;
  if (k === CTL_RING && e.roundabout) return HOLD_GO; // circulating cars never stop at the ring's nodes
  const mv = car.move;
  const myType = mv >= 0 ? J.mvType[mv] : MOVE_LEFT;
  const myAp = J.edgeAp[car.edge];
  // ---- lights ----
  if (k === CTL_SIGNALS) {
    const L = J.light[car.edge];
    if (L === LIGHT_RED && !car.commit) return HOLD_RED;
    if (L === LIGHT_AMBER && !car.commit) {
      const rem = stopLine(e) - car.s;
      // time to the line while easing to the junction curve's speed (never faster than now)
      const vEnd = mv >= 0 ? J.mvSpeed[mv] : TT.turnSpeedMin;
      const reach = rem / Math.max((car.speed + Math.min(vEnd, car.speed)) / 2, 0.5);
      // (it must stop where waiting cars stand: front bumper behind the line, clear of the other approaches' curves)
      const canStop = rem - car.halfL - TT.stopBehindLine - J.edgeStopBack[car.edge] > (car.speed * car.speed) / (2 * TT.brake);
      if (reach < amberLeft(c) - TT.amberMargin || !canStop) car.commit = true;
      else if (atLine && car.waitT > 1 && (myType === MOVE_LEFT || myType === MOVE_UTURN)) car.commit = true; // waited for a gap: clears on amber
      else return HOLD_RED;
    }
  }
  // ---- stop signs / equal roads: stop (or pause), then first come, first served ----
  if (k === CTL_STOP || k === CTL_ALLWAY) {
    if (!atLine || car.stopT < (k === CTL_STOP ? TT.stopSignWait : TT.intersectionWait)) return HOLD_STOP;
    const traffic = w.traffic;
    for (let i = 0; i < traffic.length; i++) {
      const o = traffic[i];
      if (o === car || o.phase !== 'wait' || o.respawnWanted || edges[o.edge].to !== c.id) continue;
      if ((o.arriveT < car.arriveT || (o.arriveT === car.arriveT && o.id < car.id)) && movesConflict(J, c, mv, o.move)) return HOLD_STOP;
    }
  }
  // ---- the box: cars crossing it now on a conflicting move ----
  {
    const traffic = w.traffic;
    for (let i = 0; i < traffic.length; i++) { const o = traffic[i]; if (o !== car && inBox(w, J, c, o, mv)) return HOLD_BOX; }
    const pol = w.police.cars;
    for (let i = 0; i < pol.length; i++) if (inBox(w, J, c, pol[i], mv)) return HOLD_BOX;
  }
  // ---- give way: who has priority over this move ----
  let mode = 0; // 1: yield to straight/right moves of other approaches that may go; 2: (minor road) yield to every bigger road
  if (k === CTL_SIGNALS) mode = myType === MOVE_LEFT || myType === MOVE_UTURN ? 1 : 0;
  else if (k === CTL_PRIORITY) mode = c.apRank[myAp] < c.majorRank ? 2 : myType === MOVE_LEFT || myType === MOVE_UTURN ? 1 : 0;
  if (k === CTL_PRIORITY && mode === 2 && atLine && car.stopT < TT.yieldPause) return HOLD_YIELD;
  if (mode) {
    const patient = !(atLine && car.waitT > TT.maxYieldWait);
    const myRank = c.apRank[myAp];
    if (yieldTo(w, J, c, car, mv, myAp, myRank, myType, mode, patient, w.traffic)) return HOLD_YIELD;
    if (yieldTo(w, J, c, car, mv, myAp, myRank, myType, mode, patient, w.police.cars)) return HOLD_YIELD;
  }
  // ---- roundabout entry: yield to circulating cars heading for this entry ----
  if (k === CTL_RING && ringBlocked(w, J, c, car, mv, TT.ringYieldDist, TT.ringYieldTime, TT.ringYieldNear)) return HOLD_RING;
  // ---- never block the box ----
  if (!exitHasSpace(w, car)) return HOLD_EXIT;
  return HOLD_GO;
}

function yieldTo(w: World, J: JunctionState, c: NodeCtl, car: AiCar, mv: number, myAp: number, myRank: number, myType: number, mode: number, patient: boolean, list: AiCar[]): boolean {
  const edges = w.city.roads.edges;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === car || o.phase !== 'lane' || o.respawnWanted) continue;
    const oe = edges[o.edge];
    if (oe.to !== c.id) continue;
    const ap = J.edgeAp[o.edge];
    if (ap === myAp) continue;
    const oType = o.move >= 0 ? J.mvType[o.move] : MOVE_STRAIGHT;
    let prio: boolean;
    if (c.kind === CTL_SIGNALS) prio = J.light[o.edge] !== LIGHT_RED && o.hold !== HOLD_RED && (oType === MOVE_STRAIGHT || oType === MOVE_RIGHT);
    else if (mode === 2) prio = c.apRank[ap] > myRank || (c.apRank[ap] === myRank && (myType === MOVE_LEFT || myType === MOVE_UTURN) && (oType === MOVE_STRAIGHT || oType === MOVE_RIGHT));
    else prio = c.apRank[ap] >= myRank && (oType === MOVE_STRAIGHT || oType === MOVE_RIGHT);
    if (!prio) continue;
    const d = stopLine(oe) - o.s;
    if (d < -1 || d > TT.gapDist) continue;
    const tta = Math.max(0, d) / Math.max(o.speed, 0.5);
    if (tta > (patient ? TT.gapTime : 1.5)) continue;
    if (movesConflict(J, c, mv, o.move)) return true;
  }
  return false;
}

/**
 * Is a circulating car within the conflict zone of this ring entry (closer than `dist` along the ring and under `time`
 * seconds away, or closer than `near`)? Cars about to leave the ring at this node on a move clear of ours don't count.
 */
export function ringBlocked(w: World, J: JunctionState, c: NodeCtl, car: AiCar, mv: number, dist: number, time: number, near: number): boolean {
  return ringScan(w, J, c, car, mv, dist, time, near, w.traffic) || ringScan(w, J, c, car, mv, dist, time, near, w.police.cars);
}
function ringScan(w: World, J: JunctionState, c: NodeCtl, car: AiCar, mv: number, dist: number, time: number, near: number, list: AiCar[]): boolean {
  const edges = w.city.roads.edges;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === car || o.respawnWanted) continue;
    const d = ringDist(w, o, c.id);
    if (d > dist) continue;
    // leaving here (or crossing here) on a move clear of ours
    const oe = edges[o.edge];
    if (oe.to === c.id && o.move >= 0 && J.mvNode[o.move] === c.id && !movesConflict(J, c, mv, o.move)) continue;
    if (d < near || d / Math.max(o.speed, 0.5) < time) return true;
  }
  return false;
}
