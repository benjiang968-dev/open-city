// Road surfaces for the Georgetown world: carriageways with flat cross-sections, junction plateaus, kerbs with a real
// step, raised sidewalks (Georgetown brick west of Rock Creek, concrete in the West End), skirts that hide the
// terrain under them, lane markings (double yellow, dashed white, edge lines, stop lines, one-way arrows), zebra
// crossings, and the band rasterization that feeds heightAt / isRoad.
import { TUNING } from '../../tuning';
import type { GeoDoc } from './geoDoc';
import { SegGrid, clamp, pointInPoly } from './geoDoc';
import { lin, shade, type MeshBuf, type PhysChunks, type RenderChunks } from './meshKit';
import { pointAtS, type REdge, type RNode, type RoadNet } from './roadNet';
import { B, K, type GeoRaster } from './terrain';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- art constants
const DH = 0.012; // m decals float above the surface (plus polygon offset)
/** m of extra paving from the back of the sidewalk to the building line (the data sets buildings 1 m back). */
export const FRONTAGE = 1.0;
const SKIRT = 0.9; // m skirts reach below sidewalk / road edges
const WEST_END_X = 380; // m: east of this, concrete sidewalks instead of brick
export const COL = {
  asphalt: lin(0x4b4e54),
  asphaltMain: lin(0x45484d),
  asphaltFreeway: lin(0x50535a),
  sett: lin(0x7d7268),
  brickWalk: lin(0xa86a55),
  concreteWalk: lin(0xbcb7ad),
  kerb: lin(0xa3a29c),
  skirt: lin(0x7a7268),
  deck: lin(0xa9a69e),
  deckUnder: lin(0x8e8b84),
  white: lin(0xeeeee6),
  yellow: lin(0xe5b52f),
  rail: lin(0x5b5550),
  pit: lin(0x5a4a3a),
};

export interface Cross {
  s: number;
  x: number;
  z: number;
  rx: number; // mitred right normal
  rz: number;
}

/** Cross-sections from s0 to s1: both ends exact (perpendicular), interior vertices mitred. */
export function sections(e: REdge, s0: number, s1: number): Cross[] {
  const out: Cross[] = [];
  const a = pointAtS(e, s0);
  out.push({ s: s0, x: a.x, z: a.z, rx: -a.uz, rz: a.ux });
  const P = e.pts, c = e.cum;
  for (let k = 1; k < P.length - 1; k++) {
    if (c[k] <= s0 + 0.05 || c[k] >= s1 - 0.05) continue;
    let ux = P[k][0] - P[k - 1][0], uz = P[k][1] - P[k - 1][1];
    let vx = P[k + 1][0] - P[k][0], vz = P[k + 1][1] - P[k][1];
    const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
    ux /= lu; uz /= lu; vx /= lv; vz /= lv;
    let tx = ux + vx, tz = uz + vz;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    const cs = Math.max(0.5, tx * ux + tz * uz);
    out.push({ s: c[k], x: P[k][0], z: P[k][1], rx: -tz / cs, rz: tx / cs });
  }
  const b = pointAtS(e, s1);
  out.push({ s: s1, x: b.x, z: b.z, rx: -b.uz, rz: b.ux });
  return out;
}

const walkCol = (x: number) => (x < WEST_END_X ? COL.brickWalk : COL.concreteWalk);
const roadCol = (e: REdge) => (e.surface === 'sett' ? COL.sett : e.freeway ? COL.asphaltFreeway : e.cls === 'primary' || e.cls === 'secondary' ? COL.asphaltMain : COL.asphalt);
const inRanges = (r: [number, number, number][], side: number, s: number) => r.some((q) => q[0] === side && s >= q[1] && s <= q[2]);

// ======================================================================================================
/** Write road, junction and sidewalk bands (exact heights) into the raster. Decks only set kind flags. */
export function rasterizeNet(net: RoadNet, ras: GeoRaster, lots: { pts: [number, number][] }[]) {
  const h = ras.h!, base = ras.t!, band = ras.band, k = ras.k;
  const kerb = G.kerbHeight;
  for (const e of net.edges) {
    const s0 = e.trimA, s1 = e.L - e.trimB;
    if (s1 - s0 < 0.05) continue;
    const X = sections(e, s0, s1);
    // frontage strip: pave to the building line unless a lot, park or water is there
    for (const side of [-1, 1]) {
      const f = new Uint8Array(X.length);
      for (let i = 1; i < X.length; i++) {
        const p = X[i - 1], q = X[i];
        const o = (e.hw + G.sidewalkWidth + FRONTAGE / 2) * side;
        const x = (p.x + q.x) / 2 + ((p.rx + q.rx) / 2) * o, z = (p.z + q.z) / 2 + ((p.rz + q.rz) / 2) * o;
        const kk = ras.kindAt(x, z);
        // (a building there is fine: it stands on the paving, and without it a sliver of no ground opens between the
        // back of the sidewalk and a facade that is less than FRONTAGE back)
        f[i] = e.deck || kk & (K.WATER | K.PARK) || lots.some((l) => pointInPoly(x, z, l.pts)) ? 0 : 1;
      }
      if (side < 0) e.fillL = f; else e.fillR = f;
    }
    for (let i = 1; i < X.length; i++) {
      const p = X[i - 1], q = X[i];
      const hp = net.profAt(e, p.s), hq = net.profAt(e, q.s);
      const dx = q.x - p.x, dz = q.z - p.z, L2 = dx * dx + dz * dz || 1;
      const hw = e.hw;
      if (e.deck) {
        const W = hw + G.sidewalkWidth;
        // natural ground may not reach the deck's underside (a bridge abutment in a hillside, a bump in the real
        // terrain under a span): it is cut down to below the deck, base and working heights both (blending rebuilds
        // natural cells from the base)
        const th = G.deckThickness + (e.freeway ? 0.3 : 0) + G.deckGroundGap;
        ras.fillQuad(p.x - p.rx * W, p.z - p.rz * W, p.x + p.rx * W, p.z + p.rz * W, q.x + q.rx * W, q.z + q.rz * W, q.x - q.rx * W, q.z - q.rz * W, (o, x, z) => {
          k[o] |= K.DECK | K.ROAD;
          if (band[o] !== B.NONE) return;
          const t = clamp(((x - p.x) * dx + (z - p.z) * dz) / L2, 0, 1);
          const under = hp + (hq - hp) * t - th;
          if (base[o] > under) base[o] = under;
          if (h[o] > under) h[o] = under;
        });
        continue;
      }
      // kerb lines (a real step: sidewalk on that side, kerb not dropped) for the step-distance raster
      const sm = (p.s + q.s) / 2;
      const kerbed = (side: number) => (side < 0 ? e.swL : e.swR) && !inRanges(e.noSw, side, sm) && !inRanges(e.cuts, side, sm);
      const kL = kerbed(-1), kR = kerbed(1);
      const kerbDist = (x: number, z: number, side: number) => segDistN(x, z, p.x + p.rx * hw * side, p.z + p.rz * hw * side, q.x + q.rx * hw * side, q.z + q.rz * hw * side);
      ras.fillQuad(p.x - p.rx * hw, p.z - p.rz * hw, p.x + p.rx * hw, p.z + p.rz * hw, q.x + q.rx * hw, q.z + q.rz * hw, q.x - q.rx * hw, q.z - q.rz * hw, (o, x, z) => {
        const t = clamp(((x - p.x) * dx + (z - p.z) * dz) / L2, 0, 1);
        h[o] = hp + (hq - hp) * t;
        band[o] = B.ROAD;
        k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.ROAD;
        if (kL) ras.markStep(o, -kerbDist(x, z, -1));
        if (kR) ras.markStep(o, -kerbDist(x, z, 1));
      });
      for (const side of [-1, 1]) {
        if (!(side < 0 ? e.swL : e.swR)) continue;
        if (inRanges(e.noSw, side, (p.s + q.s) / 2)) continue;
        const fill = (side < 0 ? e.fillL : e.fillR)![i] ? FRONTAGE : 0;
        const o0 = hw * side, o1 = (hw + G.sidewalkWidth + fill) * side;
        const kd = side < 0 ? kL : kR;
        ras.fillQuad(p.x + p.rx * o0, p.z + p.rz * o0, p.x + p.rx * o1, p.z + p.rz * o1, q.x + q.rx * o1, q.z + q.rz * o1, q.x + q.rx * o0, q.z + q.rz * o0, (o, x, z) => {
          if (band[o] === B.ROAD) return;
          if (kd) ras.markStep(o, kerbDist(x, z, side));
          const t = clamp(((x - p.x) * dx + (z - p.z) * dz) / L2, 0, 1);
          h[o] = hp + (hq - hp) * t + kerb;
          band[o] = B.FLAT;
          k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.WALK;
        });
      }
    }
  }
  for (const n of net.nodes) {
    if (n.outline.length < 6) continue;
    // distance to the nearest sidewalk corner kerb (the steps around this junction)
    const pathDist = (x: number, z: number, P: number[]) => {
      let d = Infinity;
      for (let i = 2; i < P.length; i += 2) d = Math.min(d, segDistN(x, z, P[i - 2], P[i - 1], P[i], P[i + 1]));
      return d;
    };
    ras.fillPoly(n.outline, (o, x, z) => {
      h[o] = n.h;
      band[o] = B.ROAD;
      k[o] = (k[o] & ~(K.WATER | K.PARK | K.WALK)) | K.ROAD;
      for (const c of n.corners) ras.markStep(o, -pathDist(x, z, c.pts));
    });
    for (const c of n.corners) {
      const poly = cornerPoly(c.pts, c.outward, G.sidewalkWidth + FRONTAGE);
      ras.fillPoly(poly, (o, x, z) => {
        if (band[o] === B.ROAD) return;
        ras.markStep(o, pathDist(x, z, c.pts));
        h[o] = n.h + kerb;
        band[o] = B.FLAT;
        k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.WALK;
      });
    }
  }
}

/** Distance from a point to a segment (no allocation: the step raster calls this for every road cell). */
function segDistN(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

function cornerPoly(pts: number[], nrm: number[], w: number): number[] {
  const n = pts.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(pts[i * 2], pts[i * 2 + 1]);
  for (let i = n - 1; i >= 0; i--) out.push(pts[i * 2] + nrm[i * 2] * w, pts[i * 2 + 1] + nrm[i * 2 + 1] * w);
  return out;
}

// ======================================================================================================
export interface NetMeshInfo {
  edgeGrid: SegGrid;
  /** Stop-line s per edge end: [edgeId] -> {a, b} (NaN if none). */
  stops: Map<number, { a: number; b: number }>;
  crossings: { x: number; z: number; ux: number; uz: number; len: number; edge: number }[];
}

export function buildNetMeshes(net: RoadNet, doc: GeoDoc, chunks: RenderChunks, phys: PhysChunks): NetMeshInfo {
  const kerb = G.kerbHeight, sw = G.sidewalkWidth;
  const edgeGrid = new SegGrid(32);
  for (const e of net.edges) edgeGrid.addLine(e.pts, e.id, e.hw + sw + 2);

  // ---------------------------------------------------------------- surfaces
  for (const e of net.edges) {
    const s0 = e.trimA, s1 = e.L - e.trimB;
    if (s1 - s0 < 0.05) continue;
    const X = sections(e, s0, s1);
    const rc = roadCol(e);
    for (let i = 1; i < X.length; i++) {
      const p = X[i - 1], q = X[i];
      const hp = net.profAt(e, p.s), hq = net.profAt(e, q.s);
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      const buf = chunks.buf('ground', mx, mz);
      const pb = phys.ground(mx, mz);
      const hw = e.hw;
      const Lpx = p.x - p.rx * hw, Lpz = p.z - p.rz * hw, Rpx = p.x + p.rx * hw, Rpz = p.z + p.rz * hw;
      const Lqx = q.x - q.rx * hw, Lqz = q.z - q.rz * hw, Rqx = q.x + q.rx * hw, Rqz = q.z + q.rz * hw;
      buf.quad(Lpx, hp, Lpz, Rpx, hp, Rpz, Rqx, hq, Rqz, Lqx, hq, Lqz, rc, 0, 1, 0);
      pb.quad(Lpx, hp, Lpz, Rpx, hp, Rpz, Rqx, hq, Rqz, Lqx, hq, Lqz);
      let outerL = hw, outerR = hw;
      for (const side of [-1, 1]) {
        const has = (side < 0 ? e.swL : e.swR) && !inRanges(e.noSw, side, (p.s + q.s) / 2);
        const ex0 = p.x + p.rx * hw * side, ez0 = p.z + p.rz * hw * side;
        const ex1 = q.x + q.rx * hw * side, ez1 = q.z + q.rz * hw * side;
        const nx = (p.rx + q.rx) * 0.5 * side, nz = (p.rz + q.rz) * 0.5 * side; // outward
        if (has) {
          const dropped = inRanges(e.cuts, side, (p.s + q.s) / 2);
          const fill = !e.deck && (side < 0 ? e.fillL : e.fillR)?.[i] ? FRONTAGE : 0;
          const ox0 = p.x + p.rx * (hw + sw + fill) * side, oz0 = p.z + p.rz * (hw + sw + fill) * side;
          const ox1 = q.x + q.rx * (hw + sw + fill) * side, oz1 = q.z + q.rz * (hw + sw + fill) * side;
          const ik = dropped ? 0.01 : kerb;
          if (!dropped) {
            buf.wall(ex0, ez0, ex1, ez1, hp, hp + kerb, hq, hq + kerb, COL.kerb, -nx, -nz);
            pb.quad(ex0, hp, ez0, ex1, hq, ez1, ex1, hq + kerb, ez1, ex0, hp + kerb, ez0);
          }
          const wc = walkCol(mx);
          buf.quad(ex0, hp + ik, ez0, ox0, hp + kerb, oz0, ox1, hq + kerb, oz1, ex1, hq + ik, ez1, wc, 0, 1, 0);
          pb.quad(ex0, hp + ik, ez0, ox0, hp + kerb, oz0, ox1, hq + kerb, oz1, ex1, hq + ik, ez1);
          if (!e.deck) buf.wall(ox0, oz0, ox1, oz1, hp + kerb - SKIRT, hp + kerb, hq + kerb - SKIRT, hq + kerb, COL.skirt, nx, nz);
          if (side < 0) outerL = hw + sw; else outerR = hw + sw;
        } else if (!e.deck) {
          buf.wall(ex0, ez0, ex1, ez1, hp - SKIRT, hp, hq - SKIRT, hq, COL.skirt, nx, nz);
        }
      }
      if (e.deck) {
        // fascia and underside (the parapets and piers come from bridges.ts)
        const th = e.freeway ? G.deckThickness + 0.3 : G.deckThickness;
        const kL = outerL > hw ? kerb : 0, kR = outerR > hw ? kerb : 0;
        const aLx = p.x - p.rx * outerL, aLz = p.z - p.rz * outerL, bLx = q.x - q.rx * outerL, bLz = q.z - q.rz * outerL;
        const aRx = p.x + p.rx * outerR, aRz = p.z + p.rz * outerR, bRx = q.x + q.rx * outerR, bRz = q.z + q.rz * outerR;
        buf.wall(aLx, aLz, bLx, bLz, hp - th, hp + kL, hq - th, hq + kL, COL.deck, -(p.rx + q.rx) / 2, -(p.rz + q.rz) / 2);
        buf.wall(aRx, aRz, bRx, bRz, hp - th, hp + kR, hq - th, hq + kR, COL.deck, (p.rx + q.rx) / 2, (p.rz + q.rz) / 2);
        buf.quad(aLx, hp - th, aLz, aRx, hp - th, aRz, bRx, hq - th, bRz, bLx, hq - th, bLz, COL.deckUnder, 0, -1, 0);
      }
    }
  }

  // ---------------------------------------------------------------- junctions and corners
  for (const n of net.nodes) {
    if (n.outline.length >= 6) {
      const buf = chunks.buf('ground', n.x, n.z);
      const pb = phys.ground(n.x, n.z);
      const O = n.outline, m = O.length / 2;
      const col = junctionCol(n);
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        buf.tri(n.x, n.h, n.z, O[i * 2], n.h, O[i * 2 + 1], O[j * 2], n.h, O[j * 2 + 1], col, 0, 1, 0);
        pb.tri(n.x, n.h, n.z, O[i * 2], n.h, O[i * 2 + 1], O[j * 2], n.h, O[j * 2 + 1]);
      }
    }
    for (const c of n.corners) cornerMesh(n, c.pts, c.outward, c.armA.edge.deck && c.armB.edge.deck ? sw : sw + FRONTAGE);
    for (const path of n.kerbs) {
      const buf = chunks.buf('ground', n.x, n.z);
      for (let i = 2; i < path.length; i += 2) {
        const ax = path[i - 2], az = path[i - 1], bx = path[i], bz = path[i + 1];
        const mx = (ax + bx) / 2 - n.x, mz = (az + bz) / 2 - n.z;
        buf.wall(ax, az, bx, bz, n.h - SKIRT, n.h, n.h - SKIRT, n.h, COL.skirt, mx, mz);
      }
    }
  }
  function junctionCol(n: RNode) {
    let best = n.arms[0]?.edge;
    for (const a of n.arms) if (a.edge.hw > (best?.hw ?? 0)) best = a.edge;
    return best ? roadCol(best) : COL.asphalt;
  }
  function cornerMesh(n: RNode, P: number[], N: number[], sw: number) {
    const buf = chunks.buf('ground', n.x, n.z);
    const pb = phys.ground(n.x, n.z);
    const y0 = n.h, y1 = n.h + kerb;
    const wc = walkCol(n.x);
    for (let i = 2; i < P.length; i += 2) {
      const ax = P[i - 2], az = P[i - 1], bx = P[i], bz = P[i + 1];
      const anx = N[i - 2], anz = N[i - 1], bnx = N[i], bnz = N[i + 1];
      const aox = ax + anx * sw, aoz = az + anz * sw, box = bx + bnx * sw, boz = bz + bnz * sw;
      const hx = (anx + bnx) / 2, hz = (anz + bnz) / 2;
      buf.wall(ax, az, bx, bz, y0, y1, y0, y1, COL.kerb, -hx, -hz);
      pb.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      buf.quad(ax, y1, az, aox, y1, aoz, box, y1, boz, bx, y1, bz, wc, 0, 1, 0);
      pb.quad(ax, y1, az, aox, y1, aoz, box, y1, boz, bx, y1, bz);
      buf.wall(aox, aoz, box, boz, y1 - SKIRT, y1, y1 - SKIRT, y1, COL.skirt, hx, hz);
    }
  }

  // ---------------------------------------------------------------- crossings (zebras) from the data
  const crossings: NetMeshInfo['crossings'] = [];
  const endCross = new Map<number, { a: number[]; b: number[] }>();
  for (const f of doc.footways) {
    if (f.kind !== 'crossing' || f.pts.length < 2) continue;
    const p0 = f.pts[0], p1 = f.pts[f.pts.length - 1];
    let cx = p1[0] - p0[0], cz = p1[1] - p0[1];
    const len = Math.hypot(cx, cz);
    if (len < 2) continue;
    cx /= len; cz /= len;
    const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
    let best: REdge | null = null, bd = Infinity;
    edgeGrid.query(mx, mz, (_s, id, d) => {
      const e = net.edges[id];
      if (d < e.hw + 3 && d < bd) {
        const pr = net.project(e, mx, mz);
        const q = pointAtS(e, pr.s);
        if (Math.abs(q.ux * cx + q.uz * cz) < 0.6) { bd = d; best = e; }
      }
    });
    if (!best) continue;
    const e: REdge = best;
    const pr = net.project(e, mx, mz);
    const q = pointAtS(e, pr.s);
    crossings.push({ x: mx, z: mz, ux: cx, uz: cz, len, edge: e.id });
    let ec = endCross.get(e.id);
    if (!ec) endCross.set(e.id, (ec = { a: [], b: [] }));
    if (pr.s < e.L / 2) ec.a.push(pr.s); else ec.b.push(pr.s);
    // stripes along the crossing line, only on the carriageway
    const rx = -q.uz, rz = q.ux;
    const dec = chunks.buf('decal', mx, mz);
    const step = 1.15, half = Math.min(len / 2, e.hw + 0.2);
    for (let t = -half + 0.5; t <= half - 0.4; t += step) {
      const sx = mx + cx * t, sz = mz + cz * t;
      const off = (sx - q.x) * rx + (sz - q.z) * rz;
      if (Math.abs(off) > e.hw - 0.35) continue;
      const pr2 = net.project(e, sx, sz);
      const y = net.profAt(e, pr2.s) + DH;
      const ax = q.ux * 1.5, az = q.uz * 1.5, bx = cx * 0.28, bz = cz * 0.28;
      dec.quad(sx - ax - bx, y, sz - az - bz, sx + ax - bx, y, sz + az - bz, sx + ax + bx, y, sz + az + bz, sx - ax + bx, y, sz - az + bz, COL.white, 0, 1, 0);
    }
  }

  // ---------------------------------------------------------------- lane markings
  const stops = new Map<number, { a: number; b: number }>();
  for (const e of net.edges) {
    const s0 = e.trimA, s1 = e.L - e.trimB;
    if (s1 - s0 < 3) continue;
    const ec = endCross.get(e.id);
    const ctrlA = e.a.arms.length >= 3 || e.a.signals || e.a.stop;
    const ctrlB = e.b.arms.length >= 3 || e.b.signals || e.b.stop;
    // stop lines sit just behind a crossing if one is near the junction, else just off the plateau
    let stopA = NaN, stopB = NaN;
    if (ctrlA && e.bwd > 0 && !e.a.roundabout) {
      const c = ec?.a.filter((s) => s < s0 + 12) ?? [];
      stopA = c.length ? Math.max(...c) + 2.3 : s0 + 1.2;
    }
    if (ctrlB && e.fwd > 0 && !e.b.roundabout) {
      const c = ec?.b.filter((s) => s > s1 - 12) ?? [];
      stopB = c.length ? Math.min(...c) - 2.3 : s1 - 1.2;
    }
    if (e.roundabout) stopA = stopB = NaN;
    stops.set(e.id, { a: stopA, b: stopB });
    const lo = Number.isNaN(stopA) ? s0 + 0.8 : stopA + 0.3, hi = Number.isNaN(stopB) ? s1 - 0.8 : stopB - 0.3;
    if (hi - lo < 2) continue;
    const lanes = e.lanes;
    const lw = (2 * e.hw) / lanes.length;
    // centre line(s)
    if (e.fwd > 0 && e.bwd > 0 && lanes.length >= 2 && e.hw * 2 >= 6) {
      const div = -e.hw + e.bwd * lw;
      line(e, div - 0.12, 0.1, lo, hi, COL.yellow);
      line(e, div + 0.12, 0.1, lo, hi, COL.yellow);
    }
    // dashed white between same-direction lanes
    for (let i = 1; i < lanes.length; i++) {
      if (lanes[i].dir !== lanes[i - 1].dir) continue;
      const off = (lanes[i].offset + lanes[i - 1].offset) / 2;
      for (let s = lo + 2; s < hi - 1; s += 12) line(e, off, 0.12, s, Math.min(hi, s + 3), COL.white);
    }
    // edge lines on freeway, bridges and parkway-type roads
    if (e.freeway || (e.deck && e.hw > 5) || e.road.sidewalk === 'no') {
      line(e, -e.hw + 0.35, 0.14, s0 + 0.5, s1 - 0.5, COL.white);
      line(e, e.hw - 0.35, 0.14, s0 + 0.5, s1 - 0.5, COL.white);
    }
    // streetcar rails on the setts of O St
    if (e.surface === 'sett') for (const l of lanes) for (const d of [-0.72, 0.72]) line(e, l.offset + d, 0.07, s0 + 0.5, s1 - 0.5, COL.rail);
    // stop lines across the inbound lanes
    if (!Number.isNaN(stopA)) bar(e, stopA, -e.hw + 0.2, -e.hw + e.bwd * lw - 0.25);
    if (!Number.isNaN(stopB)) bar(e, stopB, e.hw - e.fwd * lw + 0.25, e.hw - 0.2);
    // one-way arrows before the downstream junction
    if (e.fwd === 0 || e.bwd === 0) {
      const dir = e.fwd > 0 ? 1 : -1;
      const end = dir > 0 ? (Number.isNaN(stopB) ? s1 - 2 : stopB) : Number.isNaN(stopA) ? s0 + 2 : stopA;
      for (const at of [end - dir * 9, end - dir * 34]) {
        if (at < s0 + 4 || at > s1 - 4) continue;
        for (const l of lanes) arrow(e, at, l.offset, dir);
      }
    }
  }
  function line(e: REdge, off: number, w: number, sa: number, sb: number, col: number) {
    if (sb - sa < 0.2) return;
    const X = sections(e, sa, sb);
    for (let i = 1; i < X.length; i++) {
      const p = X[i - 1], q = X[i];
      const hp = net.profAt(e, p.s) + DH, hq = net.profAt(e, q.s) + DH;
      const buf = chunks.buf('decal', (p.x + q.x) / 2, (p.z + q.z) / 2);
      const a0 = off - w / 2, a1 = off + w / 2;
      buf.quad(p.x + p.rx * a0, hp, p.z + p.rz * a0, p.x + p.rx * a1, hp, p.z + p.rz * a1, q.x + q.rx * a1, hq, q.z + q.rz * a1, q.x + q.rx * a0, hq, q.z + q.rz * a0, col, 0, 1, 0);
    }
  }
  function bar(e: REdge, s: number, o0: number, o1: number) {
    const q = pointAtS(e, s);
    const y = net.profAt(e, s) + DH;
    const rx = -q.uz, rz = q.ux, ax = q.ux * 0.22, az = q.uz * 0.22;
    const buf = chunks.buf('decal', q.x, q.z);
    buf.quad(q.x + rx * o0 - ax, y, q.z + rz * o0 - az, q.x + rx * o1 - ax, y, q.z + rz * o1 - az, q.x + rx * o1 + ax, y, q.z + rz * o1 + az, q.x + rx * o0 + ax, y, q.z + rz * o0 + az, COL.white, 0, 1, 0);
  }
  function arrow(e: REdge, s: number, off: number, dir: number) {
    const q = pointAtS(e, s);
    const y = net.profAt(e, s) + DH;
    const ux = q.ux * dir, uz = q.uz * dir, rx = -q.uz, rz = q.ux;
    const cx = q.x + rx * off, cz = q.z + rz * off;
    const buf = chunks.buf('decal', cx, cz);
    const P = (a: number, b: number): [number, number] => [cx + ux * a + rx * b, cz + uz * a + rz * b];
    const s0 = P(-2.2, -0.13), s1 = P(-2.2, 0.13), s2 = P(0.6, 0.13), s3 = P(0.6, -0.13);
    buf.quad(s0[0], y, s0[1], s1[0], y, s1[1], s2[0], y, s2[1], s3[0], y, s3[1], COL.white, 0, 1, 0);
    const h0 = P(0.6, -0.5), h1 = P(0.6, 0.5), h2 = P(2.0, 0);
    buf.tri(h0[0], y, h0[1], h1[0], y, h1[1], h2[0], y, h2[1], COL.white, 0, 1, 0);
  }
  return { edgeGrid, stops, crossings };
}

/** Draws a flat ribbon along a polyline (draped on a height function) into a buffer: footpaths, towpath, aprons. */
export function drapeRibbon(buf: (x: number, z: number) => MeshBuf, pts: [number, number][], w: number, heightAt: (x: number, z: number) => number, col: number, lift: number, step = 2.5) {
  // resample
  const P: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) P.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const hw = w / 2;
  let prev: number[] | null = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    const lx = P[i][0] + tz * hw, lz = P[i][1] - tx * hw, rx = P[i][0] - tz * hw, rz = P[i][1] + tx * hw;
    const cur = [lx, heightAt(lx, lz) + lift, lz, rx, heightAt(rx, rz) + lift, rz];
    if (prev) {
      const v = (i * 7919) % 13;
      buf((lx + rx) / 2, (lz + rz) / 2).quad(prev[0], prev[1], prev[2], prev[3], prev[4], prev[5], cur[3], cur[4], cur[5], cur[0], cur[1], cur[2], shade(col, 0.97 + v * 0.005), 0, 1, 0);
    }
    prev = cur;
  }
}
