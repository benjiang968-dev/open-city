// Traffic audit: counters the traffic system keeps (red-light runs, roundabout entries, lane changes, recycles) and,
// when tests switch `w.trafficSim.measure` on, a per-step check of every AI car: driving against its lane, off its
// lane (beyond the sideways offset of a lane change it is making), on the wrong level (a deck vs the road under it),
// AI cars running into each other, cars standing still for too long, cars stopping on the roundabout ring.
// Read by scripts (window.__oc.trafficSim.stats) and the F3 overlay. Allocation-free per step.
import { TUNING } from '../tuning';
import type { World } from '../world';
import { laneSample, type LanePoint } from './map/cityMap';
import type { AiCar } from './traffic';
import { HOLD_RED } from './junctions';

const TT = TUNING.traffic;

export interface TrafficStats {
  // always counted
  signalCrossings: number;
  redRuns: number;
  lastRedRun: string;
  ringEntries: number;
  yieldFails: number;
  lastYieldFail: string;
  ringGoRound: number;
  laneChanges: number;
  laneChangeAborts: number;
  recycled: number;
  respawned: number;
  // audit (measure on)
  steps: number;
  wrongWay: number;
  lastWrongWay: string;
  offLaneMax: number;
  offLaneOver2: number; // car-steps more than 2 m off their intended path
  offLaneWhere: string;
  wrongLevel: number;
  lastWrongLevel: string;
  aiContacts: number;
  lastContact: string;
  stuck: number; // cars that stood still longer than traffic.stuckReport
  stuckAtRed: number; // ... of which waiting at a red light
  stuckWhere: string[];
  stillMax: number;
  ringStops: number;
  /** Per car id: flags so each episode counts once. */
  wrongFlag: Uint8Array;
  stillT: Float32Array;
  stuckFlag: Uint8Array;
  ringFlag: Uint8Array;
  contact: Uint8Array; // pair matrix (ids)
  levelFlag: Uint8Array;
  n: number;
}

export function createTrafficStats(maxCars: number): TrafficStats {
  const n = maxCars + 8; // traffic ids, then police ids after them
  return {
    signalCrossings: 0, redRuns: 0, lastRedRun: '', ringEntries: 0, yieldFails: 0, lastYieldFail: '', ringGoRound: 0, laneChanges: 0, laneChangeAborts: 0, recycled: 0, respawned: 0,
    steps: 0, wrongWay: 0, lastWrongWay: '', offLaneMax: 0, offLaneOver2: 0, offLaneWhere: '', wrongLevel: 0, lastWrongLevel: '', aiContacts: 0, lastContact: '',
    stuck: 0, stuckAtRed: 0, stuckWhere: [], stillMax: 0, ringStops: 0,
    wrongFlag: new Uint8Array(n), stillT: new Float32Array(n), stuckFlag: new Uint8Array(n), ringFlag: new Uint8Array(n), contact: new Uint8Array(n * n), levelFlag: new Uint8Array(n), n,
  };
}

/** Zero the counters (tests call this when they start measuring). */
export function resetTrafficStats(st: TrafficStats): void {
  st.signalCrossings = st.redRuns = st.ringEntries = st.yieldFails = st.ringGoRound = st.laneChanges = st.laneChangeAborts = st.recycled = st.respawned = 0;
  st.steps = st.wrongWay = st.offLaneMax = st.offLaneOver2 = st.wrongLevel = st.aiContacts = st.stuck = st.stuckAtRed = st.stillMax = st.ringStops = 0;
  st.lastRedRun = st.lastYieldFail = st.lastWrongWay = st.offLaneWhere = st.lastWrongLevel = st.lastContact = '';
  st.stuckWhere.length = 0;
  st.wrongFlag.fill(0); st.stillT.fill(0); st.stuckFlag.fill(0); st.ringFlag.fill(0); st.contact.fill(0); st.levelFlag.fill(0);
}

const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

function slot(w: World, car: AiCar): number {
  return car.kind === 'police' ? w.trafficSim.all.length + car.id : car.id;
}

/** One audit pass over every AI car (after the traffic step). */
export function auditTraffic(w: World, dt: number): void {
  const st = w.trafficSim.stats;
  st.steps++;
  auditList(w, st, w.traffic, dt);
  auditList(w, st, w.police.cars, dt);
  contacts(w, st, w.traffic, w.traffic, true);
  contacts(w, st, w.traffic, w.police.cars, false);
}

function auditList(w: World, st: TrafficStats, list: AiCar[], dt: number): void {
  const edges = w.city.roads.edges;
  for (let i = 0; i < list.length; i++) {
    const car = list[i];
    const id = slot(w, car);
    if (id >= st.n) continue;
    const e = edges[car.edge];
    const police = car.kind === 'police';
    // ---- wrong way, off lane and level: on the lane, not sliding after a knock ----
    if (car.stunT <= 0 && !car.respawnWanted && (car.phase === 'lane' || car.phase === 'wait')) {
      laneSample(e, car.s, LP);
      const lv = car.body.linvel();
      const sp = Math.hypot(lv.x, lv.z);
      const along = (lv.x * Math.sin(LP.heading) + lv.z * Math.cos(LP.heading)) / Math.max(sp, 1e-6);
      if (sp > 1.5 && along < -0.3) {
        if (!st.wrongFlag[id]) { st.wrongFlag[id] = 1; st.wrongWay++; st.lastWrongWay = `${car.kind} ${car.id} on ${e.name ?? e.roadId} (${car.px.toFixed(0)}, ${car.pz.toFixed(0)})`; }
      } else st.wrongFlag[id] = 0;
      if (!police) {
        const lat = (car.px - LP.x) * -Math.cos(LP.heading) + (car.pz - LP.z) * Math.sin(LP.heading);
        const off = Math.abs(lat - car.latOff);
        if (off > st.offLaneMax) { st.offLaneMax = off; st.offLaneWhere = `car ${car.id} on ${e.name ?? e.roadId} lane ${e.id} s ${car.s.toFixed(0)}/${e.len.toFixed(0)} (${car.px.toFixed(0)}, ${car.pz.toFixed(0)})`; }
        if (off > 2) st.offLaneOver2++;
      }
      const dy = car.py - 0.62 - LP.y;
      if (dy > TT.wrongLevelGap || dy < -TT.wrongLevelGap) {
        if (!st.levelFlag[id]) { st.levelFlag[id] = 1; st.wrongLevel++; st.lastWrongLevel = `${car.kind} ${car.id} ${dy.toFixed(1)} m off ${e.name ?? e.roadId}${e.bridge ? ' (deck)' : ''} at (${car.px.toFixed(0)}, ${car.pz.toFixed(0)})`; }
      } else st.levelFlag[id] = 0;
    }
    // ---- stuck (gridlock) ----
    if (!police) {
      if (car.speed < 0.3 && !car.respawnWanted) {
        st.stillT[id] += dt;
        if (st.stillT[id] > st.stillMax) st.stillMax = st.stillT[id];
        if (st.stillT[id] > TT.stuckReport && !st.stuckFlag[id]) {
          st.stuckFlag[id] = 1;
          st.stuck++;
          const red = car.phase === 'wait' && car.hold === HOLD_RED;
          if (red) st.stuckAtRed++;
          if (st.stuckWhere.length < 12) st.stuckWhere.push(`car ${car.id} ${car.phase}${car.phase === 'wait' ? `(hold ${car.hold})` : ''} on ${e.name ?? e.roadId} node ${e.to} (${car.px.toFixed(0)}, ${car.pz.toFixed(0)})`);
        }
      } else { st.stillT[id] = 0; st.stuckFlag[id] = 0; }
      // ---- never stopping on the ring ----
      const onRing = e.roundabout && car.phase !== 'wait';
      if (onRing && car.speed < 0.5 && car.stunT <= 0) { if (!st.ringFlag[id]) { st.ringFlag[id] = 1; st.ringStops++; } }
      else st.ringFlag[id] = 0;
    }
  }
}

/** AI cars whose bodies overlap (2D boxes, 5 cm into each other), counted once per contact. */
function contacts(w: World, st: TrafficStats, A: AiCar[], B: AiCar[], same: boolean): void {
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    const ia = slot(w, a);
    for (let j = same ? i + 1 : 0; j < B.length; j++) {
      const b = B[j];
      const ib = slot(w, b);
      if (ia >= st.n || ib >= st.n) continue;
      const dx = b.px - a.px, dz = b.pz - a.pz;
      const k = ia * st.n + ib;
      const r = a.halfL + b.halfL;
      let hit = false;
      if (dx * dx + dz * dz < r * r && Math.abs(b.py - a.py) < 1.5) hit = obbOverlap(a, b, dx, dz, 0.05);
      if (hit) {
        if (!st.contact[k]) { st.contact[k] = 1; st.aiContacts++; st.lastContact = `${a.kind} ${a.id} / ${b.kind} ${b.id} at (${a.px.toFixed(0)}, ${a.pz.toFixed(0)}) t ${w.time.toFixed(1)}`; }
      } else st.contact[k] = 0;
    }
  }
}

/** Separating-axis test of the two cars' footprints, shrunk by `margin`. */
function obbOverlap(a: AiCar, b: AiCar, dx: number, dz: number, margin: number): boolean {
  const ax = Math.sin(a.heading), az = Math.cos(a.heading), bx = Math.sin(b.heading), bz = Math.cos(b.heading);
  const aw = a.halfW - margin, al = a.halfL - margin, bw = b.halfW - margin, bl = b.halfL - margin;
  // axes: a forward, a side, b forward, b side
  for (let k = 0; k < 4; k++) {
    const ux = k === 0 ? ax : k === 1 ? az : k === 2 ? bx : bz;
    const uz = k === 0 ? az : k === 1 ? -ax : k === 2 ? bz : -bx;
    const ra = al * Math.abs(ax * ux + az * uz) + aw * Math.abs(az * ux - ax * uz);
    const rb = bl * Math.abs(bx * ux + bz * uz) + bw * Math.abs(bz * ux - bx * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}
