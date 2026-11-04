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
/** Ways left out of the render (and to be removed from the graph). See the report: the K St underpass. */
export const OMITTED_ROADS = new Set(['K St NW#tunnel']);
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
}

export interface RoadNet {
  nodes: RNode[];
  edges: REdge[];
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
  const roads = doc.roads.filter((r) => !OMITTED_ROADS.has(`${r.name}#${r.tunnel ? 'tunnel' : ''}`));
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

  // ---- roundabout: snap to a true circle
  const ring = roads.find((r) => r.junction === 'roundabout');
  let ringC: { x: number; z: number; r: number } | null = null;
  if (ring) {
    const P = ring.pts.slice(0, -1);
    const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cz = P.reduce((s, p) => s + p[1], 0) / P.length;
    const r = P.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cz), 0) / P.length;
    ringC = { x: cx, z: cz, r };
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
    if (roundabout && ringC) {
      // resample along the circle between the end angles (direction of travel follows the data)
      const a0 = Math.atan2(raw[0][1] - ringC.z, raw[0][0] - ringC.x);
      let a1 = Math.atan2(raw[raw.length - 1][1] - ringC.z, raw[raw.length - 1][0] - ringC.x);
      const mid = Math.atan2(raw[1][1] - ringC.z, raw[1][0] - ringC.x);
      // pick the sweep direction that passes the second point
      const norm = (v: number) => { while (v < 0) v += Math.PI * 2; while (v >= Math.PI * 2) v -= Math.PI * 2; return v; };
      const ccw = norm(mid - a0) < norm(a1 - a0);
      let sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
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
    const freeway = r.highway === 'trunk' && r.layer >= 2;
    if (freeway) pts = shiftFreeway(pts);
    pts = densify(pts, DENSE);
    const lanesN = Math.max(1, r.lanes ?? 2);
    let width = lanesN * G.laneWidth;
    let fwd = 0, bwd = 0;
    if (r.oneway === 1) fwd = lanesN;
    else if (r.oneway === -1) bwd = lanesN;
    else if (lanesN === 1) { fwd = bwd = 1; width = Math.max(width, G.minTwoWayWidth); }
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
      trimA: 0, trimB: 0, swL: sw, swR: sw, cuts: [], noSw: [], surface: r.surface ?? 'asphalt', cls: r.highway, fillL: null, fillR: null,
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
      const dataHw = Math.max(1, e.road.lanes ?? 2) * G.laneWidth / 2;
      let hitL = 0, hitR = 0, tot = 0;
      for (let k = 1; k < e.pts.length - 1; k++) {
        const p = e.pts[k];
        if (e.cum[k] < 12 || e.cum[k] > e.L - 12) continue;
        const q = e.pts[k + 1];
        let ux = q[0] - p[0], uz = q[1] - p[1];
        const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
        const rx = -uz, rz = ux;
        const o = dataHw + 1.5;
        tot++;
        if (near(p[0] - rx * o, p[1] - rz * o, 1.6)) hitL++;
        if (near(p[0] + rx * o, p[1] + rz * o, 1.6)) hitR++;
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

  // ---- junction geometry
  for (const n of nodes) junction(n);
  function junction(n: RNode) {
    const arms = n.arms.sort((p, q) => p.theta - q.theta);
    const m = arms.length;
    if (m === 1) { arms[0].trim = 0; return; }
    const req = new Float64Array(m).fill(m >= 3 ? MIN_TRIM : 0.3);
    type Corner = { kind: 'in' | 'out' | 'straight'; s: number; t: number; d: number; R: number; X?: [number, number] };
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
        const R = delta < 0.6 ? GORE_RADIUS : G.cornerRadius;
        const d = Math.min(30, R / Math.tan(delta / 2));
        corners.push({ kind: 'in', s, t, d, R, X: [P0x + A.ux * s, P0z + A.uz * s] });
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
      let tr = req[k];
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
        const segs = 8;
        if (exact) {
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

  // ---- where the shifted freeway runs beside the K St bridge, that bridge loses its north sidewalk
  for (const e of edges) {
    if (!e.deck || e.freeway || !e.name.startsWith('K St')) continue;
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
  const net: RoadNet = { nodes, edges, profAt, pointAt: (e, s, o) => { const q = pointAtS(e, s); o.x = q.x; o.z = q.z; o.ux = q.ux; o.uz = q.uz; }, project: projectEdge };
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
      const wA = s <= tA ? 1 : cosFall((s - tA) / lamA);
      const wB = s >= e.L - tB ? 1 : cosFall((e.L - tB - s) / lamB);
      e.prof[k] = S[k] + corrA * wA + corrB * wB;
    }
  };
  // pass 1: at-grade
  const ground = new Map<REdge, Float32Array>();
  for (const e of atGrade) { const S = groundProfile(e); ground.set(e, S); shape(e, S); }
  // decks in layer order
  for (const e of decks) {
    deckProfile(e);
  }
  // pass 2: at-grade edges touching raised nodes
  for (const e of atGrade) if (e.a.raised || e.b.raised) shape(e, ground.get(e)!);
  // decks again (their ends may have moved if a later deck raised a shared node)
  for (const e of decks) deckProfile(e);

  function deckProfile(e: REdge) {
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
    if (freeA) e.a.h = hA0;
    if (freeB) e.b.h = hB0;
    const needA = sampleArr(env, c, e.trimA), needB = sampleArr(env, c, e.L - e.trimB);
    if (!freeA && needA > e.a.h + 0.05) { e.a.h = needA; e.a.raised = true; }
    if (!freeB && needB > e.b.h + 0.05) { e.b.h = needB; e.b.raised = true; }
    for (let k = 0; k < n; k++) {
      const s = c[k];
      const u = clamp((s - e.trimA) / Math.max(0.1, e.L - e.trimA - e.trimB), 0, 1);
      const base = lerp(e.a.h, e.b.h, u * u * (3 - 2 * u));
      e.prof[k] = s <= e.trimA ? e.a.h : s >= e.L - e.trimB ? e.b.h : Math.max(base, env[k]);
    }
    // ease the kinks (vertical curves), keep plateaus exact
    const sm = smoothArr(e.prof, c, 12);
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= e.trimA || s >= e.L - e.trimB) continue;
      e.prof[k] = Math.max(sm[k], req[k] === -Infinity ? -Infinity : req[k] - 0.15);
    }
  }
  // roundabout and other loops: nothing special (nodes carry heights)
  void nodes;
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
