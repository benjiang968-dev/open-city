// Road network for the Georgetown world: splits the data's roads into edges between junction nodes, works out each
// junction's outline (kerb arcs, trims), the lanes, and a height profile per edge (flat across its width, flat
// plateaus at junctions, bridge decks that clear whatever passes beneath). No meshes here: roadMesh.ts and
// bridges.ts draw from this.
import { TUNING } from '../../tuning';
import type { GeoDoc, GeoRoad, Pt } from './geoDoc';
import { clamp, densify, lerp } from './geoDoc';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- layout constants
const DENSE = 4; // m between profile samples along an edge
const SMOOTH = 14; // m half window for smoothing terrain along an edge
const GORE_RADIUS = 1; // m kerb radius where two arms meet at a sharp angle (merges)
const MIN_TRIM = 1.2; // m every arm keeps clear of a junction centre
const PRUNE_PASSES = 6; // tunnel approaches pruned at most this many road pieces deep
/** Ways left out of the render (and to be removed from the graph). See the report: the K St underpass. */
export const OMITTED_ROADS = new Set(['K St NW#tunnel']);
/**
 * Real (imported) data: tunnels and roads below ground level (the K St underpass beneath Washington Circle and its
 * ramps) are left out of the render and the graph; the world has no tunnel geometry yet. Knowledge-based data keeps
 * its own list (OMITTED_ROADS).
 */
function omittedRoad(doc: GeoDoc, r: GeoRoad): boolean {
  if (doc.meta.synthetic) return OMITTED_ROADS.has(`${r.name}#${r.tunnel ? 'tunnel' : ''}`);
  return r.tunnel === 1 || r.layer < 0;
}
const omitCache = new WeakMap<GeoDoc, Set<GeoRoad>>();
/**
 * The roads left out of the world (see omittedRoad) plus, in real data, the approaches that would dead-end at an
 * omitted tunnel: a road whose end only an omitted road continued is pruned, and so on back to the junction where
 * the approach leaves the street (at most PRUNE_PASSES roads deep).
 */
export function omittedRoads(doc: GeoDoc): Set<GeoRoad> {
  const hit = omitCache.get(doc);
  if (hit) return hit;
  const out = new Set(doc.roads.filter((r) => omittedRoad(doc, r)));
  omitCache.set(doc, out);
  if (doc.meta.synthetic) return out;
  const key = (p: Pt) => `${p[0]},${p[1]}`;
  for (let pass = 0; pass < PRUNE_PASSES; pass++) {
    const kept = new Map<string, number>(), gone = new Set<string>();
    for (const r of doc.roads) {
      if (out.has(r)) { for (const p of r.pts) gone.add(key(p)); continue; }
      r.pts.forEach((p, i) => kept.set(key(p), (kept.get(key(p)) ?? 0) + (i === 0 || i === r.pts.length - 1 ? 1 : 2)));
    }
    const prune = doc.roads.filter((r) => !out.has(r) && [r.pts[0], r.pts[r.pts.length - 1]].some((p) => gone.has(key(p)) && kept.get(key(p)) === 1));
    if (!prune.length) break;
    for (const r of prune) out.add(r);
  }
  return out;
}
/** The Whitehurst Freeway's last stretch is moved north so it runs beside (not on top of) the K St bridge. */
const FREEWAY_SHIFT = { x0: 110, x1: 250, x2: 392, dz: -15.6 };

export interface RNode {
  id: number;
  x: number;
  z: number;
  arms: Arm[];
  h: number;
  raised: boolean;
  signals: boolean;
  stop: boolean;
  /** Junction outline (x,z pairs) and its fan centre; empty for dead ends. */
  outline: number[];
  /** Kerb corner paths (for sidewalks): per pair of neighbouring arms with sidewalks on both facing sides. */
  corners: { pts: number[]; outward: number[]; armA: Arm; armB: Arm }[];
  /** Free kerb paths without sidewalk (for kerb faces only). */
  kerbs: number[][];
  roundabout: boolean;
}
export interface Arm {
  edge: REdge;
  atStart: boolean;
  ux: number;
  uz: number;
  hw: number;
  theta: number;
  trim: number;
  /** sidewalk on the arm's n side (toward the next arm, increasing angle) and m side */
  swN: boolean;
  swM: boolean;
  /** A stop sign on this approach only (data 'stop_arm'): it gives way to the junction's other arms. */
  stop?: boolean;
}
export interface Lane {
  dir: 1 | -1; // 1: travels along the edge's pts order
  offset: number; // m right of the centreline (right = +z for an eastward edge)
}
export interface REdge {
  id: number;
  road: GeoRoad;
  name: string;
  a: RNode;
  b: RNode;
  pts: Pt[];
  cum: Float32Array;
  L: number;
  hw: number;
  lanes: Lane[];
  fwd: number;
  bwd: number;
  layer: number;
  deck: boolean;
  freeway: boolean;
  roundabout: boolean;
  prof: Float32Array;
  trimA: number;
  trimB: number;
  swL: boolean;
  swR: boolean;
  /** Ranges along the edge (s0, s1) where a side has a dropped kerb (driveways): [side(-1 L,+1 R), s0, s1] */
  cuts: [number, number, number][];
  /** Ranges where the sidewalk is suppressed on a side (e.g. where the freeway abuts the K St bridge). */
  noSw: [number, number, number][];
  surface: string;
  cls: string;
  /** Per section segment and side (-1 left, +1 right): 1 if the paved frontage strip continues to the building line. */
  fillL: Uint8Array | null;
  fillR: Uint8Array | null;
  /**
   * Per section segment (sections(e, 0, L)): 1 where this at-grade road is not the raster's surface (it
   * passes over or under another road there: a grade separation the data does not mark as a bridge). Those stretches
   * are queried through the deck index instead.
   */
  overlay: Uint8Array | null;
}

export interface RoadNet {
  nodes: RNode[];
  edges: REdge[];
  /** the knowledge-based map (true) or imported real data (false) */
  synthetic: boolean;
  /** Height of an edge's surface at arc length s. */
  profAt(e: REdge, s: number): number;
  /** Point and direction at arc length s. */
  pointAt(e: REdge, s: number, out: { x: number; z: number; ux: number; uz: number }): void;
  /** Project (x,z) onto an edge: arc length, signed lateral offset (+ right), distance. */
  project(e: REdge, x: number, z: number): { s: number; off: number; d: number };
}

/** Features a deck must clear: returns the surface height below (or -Infinity) at a point. */
export interface ClearanceProbe {
  (x: number, z: number, layer: number, self: REdge): number;
}

// ======================================================================================================
export function buildRoadNet(doc: GeoDoc, baseAt: (x: number, z: number) => number): RoadNet {
  const key = (x: number, z: number) => `${x},${z}`;
  // ---- which vertices are nodes
  const synthetic = !!doc.meta.synthetic;
  const omitted = omittedRoads(doc);
  const roads = doc.roads.filter((r) => !omitted.has(r));
  const count = new Map<string, number>();
  const isEnd = new Set<string>();
  for (const r of roads) {
    const seen = new Set<string>();
    r.pts.forEach((p, i) => {
      const k = key(p[0], p[1]);
      if (i === 0 || i === r.pts.length - 1) isEnd.add(k);
      if (!seen.has(k)) { seen.add(k); count.set(k, (count.get(k) ?? 0) + 1); }
    });
  }
  const nodes: RNode[] = [];
  const nodeAt = new Map<string, RNode>();
  const getNode = (p: Pt) => {
    const k = key(p[0], p[1]);
    let n = nodeAt.get(k);
    if (!n) {
      n = { id: nodes.length, x: p[0], z: p[1], arms: [], h: 0, raised: false, signals: false, stop: false, outline: [], corners: [], kerbs: [], roundabout: false };
      nodes.push(n);
      nodeAt.set(k, n);
    }
    return n;
  };
  const isNode = (p: Pt) => { const k = key(p[0], p[1]); return isEnd.has(k) || (count.get(k) ?? 0) > 1; };

  // ---- roundabouts (Washington Circle; real data may hold more than one): snap each ring to a true circle
  const ringOf = new Map<GeoRoad, { x: number; z: number; r: number; sense: number }>();
  for (const ring of roads) {
    if (ring.junction !== 'roundabout') continue;
    const closed = ring.pts.length > 3 && ring.pts[0][0] === ring.pts[ring.pts.length - 1][0] && ring.pts[0][1] === ring.pts[ring.pts.length - 1][1];
    const P = closed ? ring.pts.slice(0, -1) : ring.pts;
    // centre by arc length (the data's vertices bunch where the spokes join)
    let cx = 0, cz = 0, W = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      cx += ((a[0] + b[0]) / 2) * l; cz += ((a[1] + b[1]) / 2) * l; W += l;
    }
    cx /= W || 1; cz /= W || 1;
    const r = P.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cz), 0) / P.length;
    // which way the ring runs: +1 when atan2(z - cz, x - cx) grows along it (shoelace sign in x, z)
    let area = 0;
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area += a[0] * b[1] - b[0] * a[1]; }
    ringOf.set(ring, { x: cx, z: cz, r, sense: area >= 0 ? 1 : -1 });
  }

  // ---- edges
  const edges: REdge[] = [];
  for (const r of roads) {
    let start = 0;
    for (let i = 1; i < r.pts.length; i++) {
      if (!isNode(r.pts[i]) && i < r.pts.length - 1) continue;
      const raw = r.pts.slice(start, i + 1);
      start = i;
      makeEdge(r, raw);
    }
  }
  function makeEdge(r: GeoRoad, raw: Pt[]) {
    const a = getNode(raw[0]), b = getNode(raw[raw.length - 1]);
    let pts: Pt[];
    const roundabout = r.junction === 'roundabout';
    const ringC = ringOf.get(r);
    if (roundabout && ringC) {
      // resample along the circle between the end angles (direction of travel follows the data)
      const a0 = Math.atan2(raw[0][1] - ringC.z, raw[0][0] - ringC.x);
      let a1 = Math.atan2(raw[raw.length - 1][1] - ringC.z, raw[raw.length - 1][0] - ringC.x);
      // sweep the way the whole ring runs (a piece with only its two end points has no second point to tell)
      const norm = (v: number) => { while (v < 0) v += Math.PI * 2; while (v >= Math.PI * 2) v -= Math.PI * 2; return v; };
      let sweep = ringC.sense > 0 ? norm(a1 - a0) : -norm(a0 - a1);
      if (Math.abs(sweep) < 1e-6) sweep = Math.PI * 2;
      a1 = a0 + sweep;
      const n = Math.max(2, Math.ceil((Math.abs(sweep) * ringC.r) / 3));
      pts = [];
      for (let k = 0; k <= n; k++) {
        const ang = a0 + (sweep * k) / n;
        pts.push([ringC.x + Math.cos(ang) * ringC.r, ringC.z + Math.sin(ang) * ringC.r]);
      }
      a.x = pts[0][0]; a.z = pts[0][1];
      b.x = pts[n][0]; b.z = pts[n][1];
      a.roundabout = b.roundabout = true;
    } else pts = raw.map((p) => [p[0], p[1]] as Pt);
    // elevated freeway: the spec's Whitehurst Freeway (trunk, layer 2); in real data any motorway / trunk deck
    const freeway = synthetic ? r.highway === 'trunk' && r.layer >= 2 : /^(motorway|trunk)/.test(r.highway) && (r.bridge === 1 || r.layer > 0);
    if (freeway && synthetic) pts = shiftFreeway(pts);
    pts = densify(pts, DENSE);
    const lanesN = Math.max(1, r.lanes ?? 2);
    // kerb-to-kerb width: the data's (imported maps carry a width estimate per road), else lanes x lane width
    let width = r.width ? Math.max(G.minRoadWidth, r.width) : lanesN * G.laneWidth;
    let fwd = 0, bwd = 0;
    if (r.oneway === 1) fwd = lanesN;
    else if (r.oneway === -1) bwd = lanesN;
    else if (lanesN === 1) { fwd = bwd = 1; if (!r.width) width = Math.max(width, G.minTwoWayWidth); }
    else { fwd = Math.ceil(lanesN / 2); bwd = lanesN - fwd; }
    const hw = width / 2;
    const lw = width / (fwd + bwd);
    const lanes: Lane[] = [];
    for (let k = 0; k < bwd; k++) lanes.push({ dir: -1, offset: -hw + (bwd - k - 0.5) * lw });
    for (let k = 0; k < fwd; k++) lanes.push({ dir: 1, offset: -hw + (bwd + k + 0.5) * lw });
    const cum = new Float32Array(pts.length);
    for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const sw = r.sidewalk !== 'no' && !r.tunnel;
    const e: REdge = {
      id: edges.length, road: r, name: r.name ?? '', a, b, pts, cum, L: cum[cum.length - 1], hw, lanes, fwd, bwd,
      layer: r.layer, deck: r.bridge === 1 || r.layer > 0, freeway, roundabout, prof: new Float32Array(pts.length),
      trimA: 0, trimB: 0, swL: sw, swR: sw, cuts: [], noSw: [], surface: r.surface ?? 'asphalt', cls: r.highway, fillL: null, fillR: null, overlay: null,
    };
    edges.push(e);
  }

  // ---- sidewalk presence per side: confirm with the data's sidewalk lines (kerb + 1.5 m)
  {
    const cell = 20;
    const grid = new Map<number, number[][]>();
    const gk = (i: number, j: number) => (i + 500) * 1000 + (j + 500);
    for (const f of doc.footways) {
      if (f.kind !== 'sidewalk') continue;
      for (let i = 1; i < f.pts.length; i++) {
        const a = f.pts[i - 1], b = f.pts[i];
        const seg = [a[0], a[1], b[0], b[1]];
        const i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
          const k = gk(ii, jj);
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(seg);
        }
      }
    }
    const near = (x: number, z: number, r: number) => {
      const l = grid.get(gk(Math.floor(x / cell), Math.floor(z / cell)));
      if (!l) return false;
      for (const s of l) {
        const dx = s[2] - s[0], dz = s[3] - s[1], L2 = dx * dx + dz * dz || 1;
        const t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / L2, 0, 1);
        if (Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) < r) return true;
      }
      return false;
    };
    for (const e of edges) {
      if (!e.swL && !e.swR) continue;
      // the data's sidewalk lines run along the middle of the sidewalk: the knowledge-based map draws them 1.5 m
      // from the kerb; real (imported) data anywhere from about 1 to 5 m beyond the kerb
      const dataHw = e.road.width ? e.hw : Math.max(1, e.road.lanes ?? 2) * G.laneWidth / 2;
      const offs = doc.meta.synthetic ? [1.5] : [1, 2, 3, 4, 5];
      let hitL = 0, hitR = 0, tot = 0;
      for (let k = 1; k < e.pts.length - 1; k++) {
        const p = e.pts[k];
        if (e.cum[k] < 12 || e.cum[k] > e.L - 12) continue;
        const q = e.pts[k + 1];
        let ux = q[0] - p[0], uz = q[1] - p[1];
        const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
        const rx = -uz, rz = ux;
        tot++;
        if (offs.some((d) => near(p[0] - rx * (dataHw + d), p[1] - rz * (dataHw + d), doc.meta.synthetic ? 1.6 : 0.8))) hitL++;
        if (offs.some((d) => near(p[0] + rx * (dataHw + d), p[1] + rz * (dataHw + d), doc.meta.synthetic ? 1.6 : 0.8))) hitR++;
      }
      if (tot >= 2) { e.swL = hitL / tot > 0.3; e.swR = hitR / tot > 0.3; }
    }
  }

  // ---- arms
  for (const e of edges) {
    for (const atStart of [true, false]) {
      const n = atStart ? e.a : e.b;
      const p0 = atStart ? e.pts[0] : e.pts[e.pts.length - 1];
      // direction from the node toward a point ~6 m along the edge (robust to tiny first segments)
      const sTarget = Math.min(6, e.L / 2);
      const q = pointAtS(e, atStart ? sTarget : e.L - sTarget);
      let ux = q.x - p0[0], uz = q.z - p0[1];
      const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
      // n side = toward increasing angle = edge right if leaving from the start
      const swR = e.swR, swL = e.swL;
      n.arms.push({ edge: e, atStart, ux, uz, hw: e.hw, theta: Math.atan2(uz, ux), trim: 0, swN: atStart ? swR : swL, swM: atStart ? swL : swR });
    }
  }

  // ---- traffic control from props (signals / stop signs sit exactly on nodes)
  for (const p of doc.props) {
    if (p[2] !== 'signals' && p[2] !== 'stop') continue;
    const n = nodeAt.get(key(p[0], p[1]));
    if (!n) continue;
    if (p[2] === 'signals') n.signals = true; else n.stop = true;
  }
  // a stop sign on one approach (where it was mapped): the nearest junction's arm in its direction
  for (const p of doc.props) {
    if (p[2] !== 'stop_arm') continue;
    let best: RNode | null = null, bd = G.stopArmSnap;
    for (const n of nodes) {
      if (n.arms.length < 3) continue;
      const d = Math.hypot(n.x - p[0], n.z - p[1]);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best || best.signals || best.stop || bd < 0.5) continue;
    const dx = (p[0] - best.x) / bd, dz = (p[1] - best.z) / bd;
    let arm: Arm | null = null, dot = -2;
    for (const A of best.arms) { const d = A.ux * dx + A.uz * dz; if (d > dot) { dot = d; arm = A; } }
    if (arm) arm.stop = true;
  }

  // ---- junction geometry
  for (const n of nodes) junction(n);
  function junction(n: RNode) {
    const arms = n.arms.sort((p, q) => p.theta - q.theta);
    const m = arms.length;
    if (m === 1) { arms[0].trim = 0; return; }
    const req = new Float64Array(m).fill(m >= 3 ? MIN_TRIM : 0.3);
    type Corner = { kind: 'in' | 'out' | 'straight'; s: number; t: number; d: number; R: number; X?: [number, number]; sharp?: boolean };
    const corners: Corner[] = [];
    for (let k = 0; k < m; k++) {
      const A = arms[k], Bm = arms[(k + 1) % m];
      let delta = Bm.theta - A.theta;
      if (k === m - 1) delta += Math.PI * 2;
      if (m === 2 && k === 1) delta = Math.PI * 2 - (arms[1].theta - arms[0].theta);
      // kerb lines: A's n side, B's m side
      const anx = -A.uz, anz = A.ux; // n side of A
      const bmx = Bm.uz, bmz = -Bm.ux; // m side of B
      const P0x = n.x + anx * A.hw, P0z = n.z + anz * A.hw;
      const P1x = n.x + bmx * Bm.hw, P1z = n.z + bmz * Bm.hw;
      if (Math.abs(delta - Math.PI) < 0.04) { corners.push({ kind: 'straight', s: 0, t: 0, d: 0, R: 0 }); continue; }
      // solve P0 + s*uA = P1 + t*uB
      const det = A.ux * -Bm.uz - A.uz * -Bm.ux;
      const rx = P1x - P0x, rz = P1z - P0z;
      const s = (rx * -Bm.uz - rz * -Bm.ux) / det;
      const t = (A.ux * rz - A.uz * rx) / det;
      if (delta < Math.PI) {
        const R = delta < 0.6 ? GORE_RADIUS : cornerRadiusFor(A.edge, Bm.edge, synthetic);
        const d = Math.min(30, R / Math.tan(delta / 2));
        corners.push({ kind: 'in', s, t, d, R, X: [P0x + A.ux * s, P0z + A.uz * s], sharp: delta < 0.6 });
        req[k] = Math.max(req[k], Math.max(0, s) + d);
        req[(k + 1) % m] = Math.max(req[(k + 1) % m], Math.max(0, t) + d);
      } else corners.push({ kind: 'out', s, t, d: 0, R: 0, X: [P0x + A.ux * s, P0z + A.uz * s] });
    }
    // width change straight through (e.g. 6 lanes to 2): taper length
    if (m === 2) {
      const dw = Math.abs(arms[0].hw - arms[1].hw);
      if (dw > 0.5) { req[0] = Math.max(req[0], dw * 3); req[1] = Math.max(req[1], dw * 3); }
    }
    for (let k = 0; k < m; k++) {
      const A = arms[k], e = A.edge;
      const other = A.atStart ? e.trimB : e.trimA;
      // real data: two arms meeting at a sharp angle (a slip road peeling off, a bridge splitting into ramps) asked
      // for a 25-30 m plateau whose outline the junction fan could not cover (a hole in the Key Bridge deck); the arms
      // overlap there instead (their surfaces agree: conformOverlaps / the deck plateaus)
      let tr = synthetic ? req[k] : Math.min(req[k], G.maxJunctionTrim);
      const maxT = Math.max(0.3, e.L - other - 2) * (e.a === e.b ? 0.5 : 1);
      tr = Math.min(tr, maxT * (other > 0 ? 1 : 0.6));
      A.trim = tr;
      if (A.atStart) e.trimA = tr; else e.trimB = tr;
    }
    // outline: arm end corners use the edge's own geometry at the trim (identical to the ribbon ends)
    const kerbPt = (A: Arm, s: number, side: number): [number, number] => {
      const e = A.edge;
      const q = pointAtS(e, A.atStart ? s : e.L - s);
      const ux = A.atStart ? q.ux : -q.ux, uz = A.atStart ? q.uz : -q.uz;
      return [q.x - uz * side * A.hw, q.z + ux * side * A.hw];
    };
    const out: number[] = [];
    for (let k = 0; k < m; k++) {
      const A = arms[k], Bm = arms[(k + 1) % m], c = corners[k];
      const anx = -A.uz, anz = A.ux;
      const [Mx, Mz] = kerbPt(A, A.trim, -1);
      const [Nx, Nz] = kerbPt(A, A.trim, 1);
      out.push(Mx, Mz, Nx, Nz);
      const bmx = Bm.uz, bmz = -Bm.ux;
      const [BMx, BMz] = kerbPt(Bm, Bm.trim, -1);
      const path: number[] = [Nx, Nz];
      if (c.kind === 'in' && c.X) {
        // tangent points on each kerb line (clamped to the actual trims)
        const sA = Math.min(A.trim, Math.max(0, c.s) + c.d), sB = Math.min(Bm.trim, Math.max(0, c.t) + c.d);
        const T0x = n.x + anx * A.hw + A.ux * sA, T0z = n.z + anz * A.hw + A.uz * sA;
        const T1x = n.x + bmx * Bm.hw + Bm.ux * sB, T1z = n.z + bmz * Bm.hw + Bm.uz * sB;
        if (sA < A.trim - 0.01) path.push(T0x, T0z);
        // a true circular arc when both tangent points sit where the circle touches; else a curve via X
        const exact = c.s >= 0 && c.t >= 0 && Math.abs(sA - (c.s + c.d)) < 0.01 && Math.abs(sB - (c.t + c.d)) < 0.01;
        // real data, a sharp merge (under 35 degrees) whose kerbs cross beyond the capped trims (L St into Pennsylvania
        // Ave): a curve via the crossing bulged the flat plateau 20 m out over both arms while they still climb to it, a
        // 0.3-0.4 m ridge across the lanes (a car at 50 km/h crashed into it). The outline stops at the trims; beyond them
        // the arms overlap (at wider angles they part: the curve stays, or the chord left holes)
        const beyond = !synthetic && !exact && !!c.sharp && (Math.max(0, c.s) + c.d > A.trim + 0.01 || Math.max(0, c.t) + c.d > Bm.trim + 0.01);
        const segs = 8;
        if (beyond) {
          // straight from one tangent point to the other
        } else if (exact) {
          const Ox = T0x + anx * c.R, Oz = T0z + anz * c.R;
          let a0 = Math.atan2(T0z - Oz, T0x - Ox), a1 = Math.atan2(T1z - Oz, T1x - Ox);
          let sw = a1 - a0;
          while (sw > Math.PI) sw -= Math.PI * 2;
          while (sw < -Math.PI) sw += Math.PI * 2;
          for (let q = 1; q < segs; q++) {
            const ang = a0 + (sw * q) / segs;
            path.push(Ox + Math.cos(ang) * c.R, Oz + Math.sin(ang) * c.R);
          }
          a1 = a0 + sw;
        } else {
          for (let q = 1; q < segs; q++) {
            const u = q / segs;
            path.push((1 - u) * (1 - u) * T0x + 2 * u * (1 - u) * c.X[0] + u * u * T1x, (1 - u) * (1 - u) * T0z + 2 * u * (1 - u) * c.X[1] + u * u * T1z);
          }
        }
        path.push(T1x, T1z);
        if (sB < Bm.trim - 0.01) path.push(BMx, BMz);
      } else if (c.kind === 'out') {
        // arc around the node from N to BM
        const r0 = Math.hypot(Nx - n.x, Nz - n.z), r1 = Math.hypot(BMx - n.x, BMz - n.z);
        const a0 = Math.atan2(Nz - n.z, Nx - n.x);
        let sw = Math.atan2(BMz - n.z, BMx - n.x) - a0;
        while (sw <= 0) sw += Math.PI * 2;
        const segs = Math.max(2, Math.ceil(sw / 0.2));
        for (let q = 1; q < segs; q++) {
          const ang = a0 + (sw * q) / segs, rr = lerp(r0, r1, q / segs);
          path.push(n.x + Math.cos(ang) * rr, n.z + Math.sin(ang) * rr);
        }
        path.push(BMx, BMz);
      } else path.push(BMx, BMz);
      for (let q = 2; q < path.length - 2; q += 2) out.push(path[q], path[q + 1]);
      if (m === 1) break;
      // sidewalk corner if both facing sides have sidewalks (and not a straight continuation with differing sidewalks)
      if (A.swN && Bm.swM) {
        // outward normal for the sidewalk offset: away from the carriageway, toward the block
        n.corners.push({ pts: path, outward: outwardNormals(path, n), armA: A, armB: Bm });
      } else n.kerbs.push(path);
    }
    n.outline = out;
  }
  function outwardNormals(path: number[], n: RNode): number[] {
    // perpendicular to the path, chosen on the side away from the node
    const out: number[] = [];
    const np = path.length / 2;
    for (let i = 0; i < np; i++) {
      const a = Math.max(0, i - 1), b = Math.min(np - 1, i + 1);
      let tx = path[b * 2] - path[a * 2], tz = path[b * 2 + 1] - path[a * 2 + 1];
      const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      let nx = -tz, nz = tx;
      const px = path[i * 2] - n.x, pz = path[i * 2 + 1] - n.z;
      if (nx * px + nz * pz < 0) { nx = -nx; nz = -nz; }
      out.push(nx, nz);
    }
    return out;
  }

  // ---- where the shifted freeway runs beside the K St bridge, that bridge loses its north sidewalk (spec data only)
  for (const e of edges) {
    if (!synthetic || !e.deck || e.freeway || !e.name.startsWith('K St')) continue;
    const fw = edges.find((f) => f.freeway);
    if (!fw) continue;
    const side = -1; // north = left of an eastward edge
    let s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < e.pts.length; k++) {
      const p = e.pts[k];
      const pr = projectEdge(fw, p[0], p[1]);
      if (pr.d < e.hw + fw.hw + G.sidewalkWidth + 0.4) { s0 = Math.min(s0, e.cum[k]); s1 = Math.max(s1, e.cum[k]); }
    }
    if (s1 > s0) e.noSw.push([side, s0 - 2, e.L + 1]);
  }

  // ---- an exact profile sample at each trim: the carriageway then starts at exactly the node height where it meets
  // the flat junction surface (interpolating across a 4 m sample spacing left steps and see-through cracks there,
  // up to ~0.2 m on steep streets)
  for (const e of edges) {
    for (const s of [e.trimA, e.L - e.trimB]) {
      if (s <= 0.05 || s >= e.L - 0.05) continue;
      const c = e.cum;
      let k = 1;
      while (k < c.length - 1 && c[k] < s) k++;
      if (Math.abs(c[k] - s) < 0.02 || Math.abs(c[k - 1] - s) < 0.02) continue;
      const q = pointAtS(e, s);
      e.pts.splice(k, 0, [q.x, q.z]);
      const nc = new Float32Array(c.length + 1);
      nc.set(c.subarray(0, k));
      nc[k] = s;
      nc.set(c.subarray(k), k + 1);
      e.cum = nc;
      e.prof = new Float32Array(e.pts.length);
    }
  }

  // ---- heights
  for (const n of nodes) {
    let s = 0, c = 0;
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2, r = k === 0 ? 0 : 5;
      s += baseAt(n.x + Math.cos(a) * r, n.z + Math.sin(a) * r);
      c++;
    }
    n.h = s / c;
  }
  const net: RoadNet = { nodes, edges, synthetic, profAt, pointAt: (e, s, o) => { const q = pointAtS(e, s); o.x = q.x; o.z = q.z; o.ux = q.ux; o.uz = q.uz; }, project: projectEdge };
  return net;

  function profAt(e: REdge, s: number): number {
    const c = e.cum;
    if (s <= 0) return e.prof[0];
    if (s >= e.L) return e.prof[e.prof.length - 1];
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
    const t = (s - c[lo]) / (c[hi] - c[lo] || 1);
    return e.prof[lo] + (e.prof[hi] - e.prof[lo]) * t;
  }
}

/** Kerb radius at a street corner: the spec map uses one radius; real data has driveways, alleys and tight corners. */
function cornerRadiusFor(a: REdge, b: REdge, synthetic: boolean): number {
  if (synthetic) return G.cornerRadius;
  const minor = (e: REdge) => e.cls === 'service' || e.cls === 'road' || e.cls === 'living_street';
  const local = (e: REdge) => e.cls === 'residential' || e.cls === 'unclassified';
  if (minor(a) || minor(b)) return G.cornerRadiusService;
  if (local(a) || local(b)) return G.cornerRadiusLocal;
  return G.cornerRadius;
}

function shiftFreeway(pts: Pt[]): Pt[] {
  const S = FREEWAY_SHIFT;
  const end = pts[pts.length - 1];
  const dense = densify(pts, 10);
  const out: Pt[] = [];
  for (const p of dense) {
    if (p[0] <= S.x0) { out.push(p); continue; }
    if (p[0] >= S.x2) continue;
    const t = clamp((p[0] - S.x0) / (S.x1 - S.x0), 0, 1);
    const f = t * t * (3 - 2 * t);
    out.push([p[0], p[1] + S.dz * f]);
  }
  out.push([S.x2, end[1] + S.dz]);
  out.push(end);
  return out;
}

export function pointAtS(e: REdge, s: number): { x: number; z: number; ux: number; uz: number } {
  const c = e.cum, P = e.pts;
  s = clamp(s, 0, e.L);
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - c[lo]) / (c[hi] - c[lo] || 1);
  let ux = P[hi][0] - P[lo][0], uz = P[hi][1] - P[lo][1];
  const L = Math.hypot(ux, uz) || 1;
  ux /= L; uz /= L;
  return { x: P[lo][0] + (P[hi][0] - P[lo][0]) * t, z: P[lo][1] + (P[hi][1] - P[lo][1]) * t, ux, uz };
}

export function projectEdge(e: REdge, x: number, z: number): { s: number; off: number; d: number } {
  let best = { s: 0, off: 0, d: Infinity };
  const P = e.pts;
  for (let k = 1; k < P.length; k++) {
    const ax = P[k - 1][0], az = P[k - 1][1], dx = P[k][0] - ax, dz = P[k][1] - az;
    const L2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
    const qx = ax + dx * t, qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      const off = ((x - ax) * -dz + (z - az) * dx) / L; // right = (-uz, ux)
      best = { s: e.cum[k - 1] + t * L, off, d };
    }
  }
  return best;
}

// ======================================================================================================
/**
 * Height profiles. At-grade edges follow smoothed terrain with flat plateaus at junctions; decks span between their
 * end nodes and rise to clear what's beneath (probe), raising their end nodes if the approach would be too steep.
 */
export function solveProfiles(net: RoadNet, baseAt: (x: number, z: number) => number, probe: ClearanceProbe) {
  const { edges, nodes } = net;
  const atGrade = edges.filter((e) => !e.deck);
  const decks = edges.filter((e) => e.deck).sort((p, q) => p.layer - q.layer);
  const groundProfile = (e: REdge) => {
    const n = e.pts.length;
    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const q = pointAtS(e, e.cum[k]);
      const rx = -q.uz * e.hw, rz = q.ux * e.hw;
      raw[k] = (baseAt(q.x, q.z) * 2 + baseAt(q.x + rx, q.z + rz) + baseAt(q.x - rx, q.z - rz)) / 4;
    }
    return smoothArr(raw, e.cum, SMOOTH);
  };
  const shape = (e: REdge, S: Float32Array) => {
    const n = e.pts.length, c = e.cum;
    const tA = e.trimA, tB = e.trimB;
    const sA = sampleArr(S, c, tA), sB = sampleArr(S, c, e.L - tB);
    const corrA = e.a.h - sA, corrB = e.b.h - sB;
    const lamA = clamp(Math.abs(corrA) / (G.maxGrade * 0.7), 10, 400), lamB = clamp(Math.abs(corrB) / (G.maxGrade * 0.7), 10, 400);
    const free = e.L - tA - tB;
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (free < lamA + lamB + 2) {
        // short edge: straight grade between plateaus (eased)
        const u = clamp((s - tA) / Math.max(0.1, free), 0, 1);
        e.prof[k] = lerp(e.a.h, e.b.h, u * u * (3 - 2 * u));
        continue;
      }
      // the plateaus under the junction surfaces are flat at the node height (lanes cross them at that height)
      // (0.01 m tolerance: the trim sample's arc length is stored as a float32)
      if (s <= tA + 0.01) { e.prof[k] = e.a.h; continue; }
      if (s >= e.L - tB - 0.01) { e.prof[k] = e.b.h; continue; }
      const wA = s <= tA ? 1 : cosFall((s - tA) / lamA);
      const wB = s >= e.L - tB ? 1 : cosFall((e.L - tB - s) / lamB);
      e.prof[k] = S[k] + corrA * wA + corrB * wB;
      // leave each flat plateau with zero grade and ease into the street's grade (a vertical curve) instead of
      // kinking at the junction's edge
      if (!net.synthetic) {
        const ease = Math.min(G.plateauEase, free * 0.3);
        e.prof[k] = e.a.h + (e.prof[k] - e.a.h) * smoothStep((s - tA) / ease);
        e.prof[k] = e.b.h + (e.prof[k] - e.b.h) * smoothStep((e.L - tB - s) / ease);
      }
    }
  };
  // real data: node heights come from the terrain around each junction, and two junctions a few metres apart on a
  // steep bank (or beside a bridge abutment the DEM half keeps) could differ by metres: a short street piece between
  // them became a 40 % ramp. Relax: where an at-grade edge's free length cannot take the height difference at the
  // class's grade limit, both ends move toward each other (iterated; long edges are untouched).
  const lim = (e: REdge) => (e.cls === 'service' ? G.relaxGradeService : /^(primary|secondary|trunk|motorway)/.test(e.cls) ? G.relaxGradeMain : G.relaxGrade);
  const insideDeck = (n: RNode) => n.arms.length > 0 && n.arms.every((a) => a.edge.deck);
  if (!net.synthetic) {
    for (let it = 0; it < 60; it++) {
      let worst = 0;
      for (const e of atGrade) {
        if (e.a === e.b || insideDeck(e.a) || insideDeck(e.b)) continue;
        const free = Math.max(1, e.L - e.trimA - e.trimB);
        const ex = Math.abs(e.a.h - e.b.h) - lim(e) * free;
        if (ex <= 0.01) continue;
        worst = Math.max(worst, ex);
        const d = (ex / 2) * Math.sign(e.a.h - e.b.h) * 0.8;
        e.a.h -= d; e.b.h += d;
      }
      if (worst < 0.02) break;
    }
  }
  // nodes inside a bridge (every arm a deck: real data splits a bridge where ramps join or its level changes) do not
  // stand on the ground: the terrain under them is a river, a street below, or a DEM with the deck half removed (a
  // 12 m mound at the Key Bridge abutment). Their heights are interpolated between the bridge's ends on land (a
  // Laplacian over the deck graph, weighted by length; ends at the map edge or dead ends float with their neighbour),
  // then the deck profiles raise them where they must clear what passes beneath.
  {
    const inside = nodes.filter((n) => n.arms.length >= 1 && n.arms.every((a) => a.edge.deck) && n.arms.some((a) => a.edge.a !== a.edge.b));
    if (inside.length) {
      const free = new Set(inside);
      const hasAnchor = new Set<RNode>();
      // a group of inside nodes with no land node at all keeps its terrain heights
      const seen = new Set<RNode>();
      for (const s of inside) {
        if (seen.has(s)) continue;
        const comp: RNode[] = [];
        const st = [s];
        seen.add(s);
        let anchored = false;
        while (st.length) {
          const n = st.pop()!;
          comp.push(n);
          for (const a of n.arms) {
            const m = a.edge.a === n ? a.edge.b : a.edge.a;
            if (!free.has(m)) { anchored = true; continue; }
            if (!seen.has(m)) { seen.add(m); st.push(m); }
          }
        }
        if (anchored) for (const n of comp) hasAnchor.add(n);
      }
      for (let it = 0; it < 400; it++) {
        let change = 0;
        for (const n of inside) {
          if (!hasAnchor.has(n)) continue;
          let s = 0, w = 0;
          for (const a of n.arms) {
            const m = a.edge.a === n ? a.edge.b : a.edge.a;
            if (m === n) continue;
            const ww = 1 / Math.max(1, a.edge.L);
            s += m.h * ww; w += ww;
          }
          if (w > 0) { const v = s / w; change = Math.max(change, Math.abs(v - n.h)); n.h = v; }
        }
        if (change < 0.005) break;
      }
    }
  }
  // pass 1: at-grade
  const ground = new Map<REdge, Float32Array>();
  for (const e of atGrade) { const S = groundProfile(e); ground.set(e, S); shape(e, S); }
  // decks in layer order
  for (const e of decks) {
    deckProfile(e);
  }
  // bridge approaches: an at-grade edge leaving a raised deck end may not be steeper than maxGrade, so its other end
  // is raised too (a few hops at most). Without this the street ramped off the M St bridge over Rock Creek at 20 %
  // with a crest that launches cars. Nodes that carry a deck keep their own height. Real (imported) data: no hops: its
  // bridge ends sit on real embankments, and in an interchange the hops lifted the Rock Creek valley roads by 11 m
  // through a ramp up to the K St bridge.
  for (let hop = 0; hop < (net.synthetic ? 4 : 0); hop++) {
    let changed = false;
    for (const e of atGrade) {
      for (const [R, O] of [[e.a, e.b], [e.b, e.a]] as [RNode, RNode][]) {
        if (!R.raised || O.arms.some((a) => a.edge.deck)) continue;
        const need = R.h - G.maxGrade * Math.max(1, e.L - e.trimA - e.trimB);
        if (need > O.h + 0.3) { O.h = need; O.raised = true; changed = true; }
      }
    }
    if (!changed) break;
  }
  // pass 2: at-grade edges touching raised nodes
  for (const e of atGrade) if (e.a.raised || e.b.raised) shape(e, ground.get(e)!);
  // decks again (their ends may have moved if a later deck raised a shared node)
  for (const e of decks) deckProfile(e);
  if (!net.synthetic) {
    // a deck processed early can end with its plateau at a node height a later deck raised: one more pass with the
    // node heights frozen makes every plateau match its junction (moving nodes again ratchets decks upward)
    for (const e of decks) deckProfile(e, false);
    // a deck end raised for clearance next to a ground junction (K St's bridge over the Rock Creek parkway ends 6 m
    // from 27th St's junction): the short piece between them became a wall. The ground junction rises toward the deck
    // end until the piece is within its grade limit, each node at most G.approachMaxLift above its own height (a
    // bounded cascade: the next pieces relax the same way). Deck ends keep their heights.
    const h0 = new Map<RNode, number>();
    for (const n of nodes) h0.set(n, n.h);
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (const e of atGrade) {
        if (e.a === e.b || insideDeck(e.a) || insideDeck(e.b)) continue;
        const free = Math.max(1, e.L - e.trimA - e.trimB);
        const ex = Math.abs(e.a.h - e.b.h) - lim(e) * free;
        if (ex <= 0.02) continue;
        const lo = e.a.h < e.b.h ? e.a : e.b, hi = lo === e.a ? e.b : e.a;
        if (!hi.raised || lo.arms.some((a) => a.edge.deck)) continue;
        const room = h0.get(lo)! + G.approachMaxLift - lo.h;
        if (room <= 0.02) continue;
        lo.h += Math.min(ex, room);
        lo.raised = true;
        moved = true;
      }
      if (!moved) break;
    }
    for (const e of atGrade) if (e.a.raised || e.b.raised) shape(e, ground.get(e)!);
  }

  function deckProfile(e: REdge, moveNodes = true) {
    const n = e.pts.length, c = e.cum;
    const req = new Float32Array(n).fill(-Infinity);
    for (let k = 0; k < n; k++) {
      const q = pointAtS(e, c[k]);
      let r = -Infinity;
      for (const off of [-e.hw, 0, e.hw]) r = Math.max(r, probe(q.x - q.uz * off, q.z + q.ux * off, e.layer, e));
      req[k] = r;
    }
    // free ends (map edge, deg 1): keep level with the other end
    const freeA = e.a.arms.length === 1, freeB = e.b.arms.length === 1;
    // dilate requirement with the max grade, measured from the plateau edges
    const env = new Float32Array(n).fill(-Infinity);
    for (let k = 0; k < n; k++) {
      if (req[k] === -Infinity) continue;
      for (let q = 0; q < n; q++) env[q] = Math.max(env[q], req[k] - G.maxGrade * 0.85 * Math.max(0, Math.abs(c[q] - c[k]) - 4));
    }
    const hA0 = freeA ? Math.max(e.b.h, sampleArr(env, c, e.trimA)) : e.a.h;
    const hB0 = freeB ? Math.max(e.a.h, sampleArr(env, c, e.L - e.trimB)) : e.b.h;
    if (freeA && moveNodes) e.a.h = hA0;
    if (freeB && moveNodes) e.b.h = hB0;
    const needA = sampleArr(env, c, e.trimA), needB = sampleArr(env, c, e.L - e.trimB);
    if (moveNodes && !freeA && needA > e.a.h + 0.05) { e.a.h = needA; e.a.raised = true; }
    if (moveNodes && !freeB && needB > e.b.h + 0.05) { e.b.h = needB; e.b.raised = true; }
    for (let k = 0; k < n; k++) {
      const s = c[k];
      const u = clamp((s - e.trimA) / Math.max(0.1, e.L - e.trimA - e.trimB), 0, 1);
      const base = lerp(e.a.h, e.b.h, u * u * (3 - 2 * u));
      e.prof[k] = s <= e.trimA + 0.01 ? e.a.h : s >= e.L - e.trimB - 0.01 ? e.b.h : Math.max(base, env[k]);
    }
    // ease the kinks (vertical curves), keep plateaus exact
    const sm = smoothArr(e.prof, c, 12);
    const free = e.L - e.trimA - e.trimB, ease = Math.min(G.plateauEase, free * 0.3);
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= e.trimA + 0.01 || s >= e.L - e.trimB - 0.01) continue;
      let v = sm[k];
      if (!net.synthetic) {
        v = e.a.h + (v - e.a.h) * smoothStep((s - e.trimA) / ease);
        v = e.b.h + (v - e.b.h) * smoothStep((e.L - e.trimB - s) / ease);
      }
      e.prof[k] = Math.max(v, req[k] === -Infinity ? -Infinity : req[k] - 0.15);
    }
  }
  conformOverlaps(net);
  if (!net.synthetic) conformToPlateaus(net);
  // roundabout and other loops: nothing special (nodes carry heights)
  void nodes;
}

/** Rank for overlaps: the bigger road keeps its profile, the smaller one conforms to it. */
const CONFORM_RANK: Record<string, number> = { motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1, road: 1, service: 0 };
const rankOf = (e: REdge) => (e.roundabout ? 8 : CONFORM_RANK[e.cls.replace('_link', '')] ?? 1) - (e.cls.endsWith('_link') ? 0.5 : 0);

/**
 * Real data puts at-grade carriageways on top of each other without a shared node: a slip road or a parking aisle
 * alongside a street, a driveway reaching into it, two roads that cross without a mapped junction, the two halves of
 * a dual carriageway that touch. Each followed its own smoothed terrain, so their surfaces disagree by up to a metre
 * where they overlap (a step a car hits). Where the smaller road's centre line runs on the bigger road's carriageway
 * and the two are within G.gradeSeparation of each other, the smaller road takes the bigger road's height, blended in
 * over G.conformBlend metres. Bigger differences are real grade separations (left as they are: the world keeps both
 * surfaces, see roadMesh / the deck index).
 */
function conformOverlaps(net: RoadNet) {
  const { edges } = net;
  const atGrade = edges.filter((e) => !e.deck);
  const cell = 24;
  const grid = new Map<number, REdge[]>();
  const gk = (i: number, j: number) => (i + 2000) * 4000 + (j + 2000);
  for (const e of atGrade) {
    const seen = new Set<number>();
    for (const p of e.pts) {
      const r = e.hw + 2;
      for (let i = Math.floor((p[0] - r) / cell); i <= Math.floor((p[0] + r) / cell); i++)
        for (let j = Math.floor((p[1] - r) / cell); j <= Math.floor((p[1] + r) / cell); j++) {
          const k = gk(i, j);
          if (seen.has(k)) continue;
          seen.add(k);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
        }
    }
  }
  const order = atGrade.slice().sort((a, b) => rankOf(a) - rankOf(b) || a.id - b.id);
  for (const A of order) {
    const n = A.pts.length, c = A.cum;
    const target = new Float32Array(n).fill(NaN);
    let any = false;
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= A.trimA + 0.01 || s >= A.L - A.trimB - 0.01) continue;
      const p = A.pts[k];
      const list = grid.get(gk(Math.floor(p[0] / cell), Math.floor(p[1] / cell)));
      if (!list) continue;
      let best = NaN, bestRank = -Infinity;
      for (const B of list) {
        if (B === A || rankOf(B) < rankOf(A) || (rankOf(B) === rankOf(A) && B.id < A.id)) continue;
        const pr = projectEdge(B, p[0], p[1]);
        if (pr.d > B.hw - 0.2) continue;
        if (pr.s <= B.trimA || pr.s >= B.L - B.trimB) continue; // on B's junction plateau: the junction joins them
        const hB = net.profAt(B, pr.s);
        if (Math.abs(hB - A.prof[k]) > G.gradeSeparation) continue;
        if (rankOf(B) > bestRank) { bestRank = rankOf(B); best = hB; }
      }
      if (!Number.isNaN(best)) { target[k] = best; any = true; }
    }
    if (!any) continue;
    // nearest target sample within the blend distance, weighted by a cosine fall-off
    const out = Float32Array.from(A.prof);
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= A.trimA + 0.01 || s >= A.L - A.trimB - 0.01) continue;
      let bestD = Infinity, hv = 0;
      for (let q = 0; q < n; q++) {
        if (Number.isNaN(target[q])) continue;
        const d = Math.abs(c[q] - s);
        if (d < bestD) { bestD = d; hv = target[q]; }
      }
      if (bestD > G.conformBlend) continue;
      // fade out toward the flat junction plateaus too (the road must still leave each plateau at its height)
      const ease = Math.max(1, Math.min(G.plateauEase, (A.L - A.trimA - A.trimB) * 0.3));
      const w = (0.5 + 0.5 * Math.cos((Math.PI * bestD) / G.conformBlend)) * plateauFade(A, s, ease);
      out[k] = A.prof[k] + (hv - A.prof[k]) * w;
    }
    A.prof = out;
  }
}

/**
 * A road whose carriageway runs over another junction's flat plateau (not one of its own ends): Washington Circle's
 * arc past the Pennsylvania Ave / K St junction west of the ring, a slip road past a junction it does not join. The
 * plateau is flat at its node's height and the road followed its own smoothed terrain, so the two surfaces met in a
 * 0.36 m step across the carriageway. Within G.gradeSeparation the road takes the plateau's height where its centre
 * or either kerb is inside the plateau outline, blended in over G.conformBlend metres (as conformOverlaps).
 */
function conformToPlateaus(net: RoadNet) {
  const cell = 40;
  const grid = new Map<number, RNode[]>();
  const gk = (i: number, j: number) => (i + 2000) * 4000 + (j + 2000);
  for (const n of net.nodes) {
    if (n.outline.length < 6 || n.raised || n.arms.some((a) => a.edge.deck)) continue;
    let r = 0;
    for (let i = 0; i < n.outline.length; i += 2) r = Math.max(r, Math.hypot(n.outline[i] - n.x, n.outline[i + 1] - n.z));
    for (let i = Math.floor((n.x - r) / cell); i <= Math.floor((n.x + r) / cell); i++)
      for (let j = Math.floor((n.z - r) / cell); j <= Math.floor((n.z + r) / cell); j++) (grid.get(gk(i, j)) ?? grid.set(gk(i, j), []).get(gk(i, j))!).push(n);
  }
  const inOutline = (x: number, z: number, O: number[]) => {
    let ins = false;
    for (let i = 0, j = O.length - 2; i < O.length; j = i, i += 2) {
      const xi = O[i], zi = O[i + 1], xj = O[j], zj = O[j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  for (const A of net.edges) {
    if (A.deck) continue;
    const n = A.pts.length, c = A.cum;
    const target = new Float32Array(n).fill(NaN);
    let any = false;
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= A.trimA + 0.01 || s >= A.L - A.trimB - 0.01) continue;
      const p = A.pts[k];
      const list = grid.get(gk(Math.floor(p[0] / cell), Math.floor(p[1] / cell)));
      if (!list) continue;
      const q = pointAtS(A, s);
      const kx = -q.uz * A.hw, kz = q.ux * A.hw; // to a kerb
      for (const N of list) {
        if (N === A.a || N === A.b || Math.abs(N.h - A.prof[k]) > G.gradeSeparation) continue;
        if (inOutline(p[0], p[1], N.outline) || inOutline(p[0] + kx, p[1] + kz, N.outline) || inOutline(p[0] - kx, p[1] - kz, N.outline)) { target[k] = N.h; any = true; break; }
      }
    }
    if (!any) continue;
    const out = Float32Array.from(A.prof);
    const ease = Math.max(1, Math.min(G.plateauEase, (A.L - A.trimA - A.trimB) * 0.3));
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= A.trimA + 0.01 || s >= A.L - A.trimB - 0.01) continue;
      let bestD = Infinity, hv = 0;
      for (let q = 0; q < n; q++) {
        if (Number.isNaN(target[q])) continue;
        const d = Math.abs(c[q] - s);
        if (d < bestD) { bestD = d; hv = target[q]; }
      }
      if (bestD > G.conformBlend) continue;
      const w = (0.5 + 0.5 * Math.cos((Math.PI * bestD) / G.conformBlend)) * plateauFade(A, s, ease);
      out[k] = A.prof[k] + (hv - A.prof[k]) * w;
    }
    A.prof = out;
  }
}

/** 0 on an edge's junction plateaus, easing to 1 over `ease` metres beyond them. */
export function plateauFade(e: REdge, s: number, ease: number): number {
  return smoothStep((s - e.trimA) / ease) * smoothStep((e.L - e.trimB - s) / ease);
}
function smoothStep(t: number) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}
function cosFall(t: number) {
  return t >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
}
function sampleArr(a: Float32Array, c: Float32Array, s: number): number {
  if (s <= 0) return a[0];
  const n = c.length;
  if (s >= c[n - 1]) return a[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - c[lo]) / (c[hi] - c[lo] || 1);
  const A = a[lo], Bv = a[hi];
  if (A === -Infinity || Bv === -Infinity) return Math.max(A, Bv);
  return A + (Bv - A) * t;
}
function smoothArr(a: Float32Array, c: Float32Array, half: number): Float32Array {
  const n = a.length, out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, w = 0;
    for (let q = k; q >= 0 && c[k] - c[q] <= half; q--) { if (a[q] === -Infinity) continue; const ww = 1 - (c[k] - c[q]) / (half + 1); s += a[q] * ww; w += ww; }
    for (let q = k + 1; q < n && c[q] - c[k] <= half; q++) { if (a[q] === -Infinity) continue; const ww = 1 - (c[q] - c[k]) / (half + 1); s += a[q] * ww; w += ww; }
    out[k] = w > 0 ? s / w : a[k];
  }
  return out;
}
