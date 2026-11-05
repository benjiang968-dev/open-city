// Car parks for the Georgetown world: flat (slightly sloped) asphalt with kerbed edges, an entrance with a dropped
// kerb where the lot meets a street, painted bays laid out in double rows, and the stall list (position + heading)
// that parked-car spawning uses.
import { TUNING } from '../../tuning';
import type { GeoDoc, Pt } from './geoDoc';
import { clamp, pointInPoly } from './geoDoc';
import { lin, type PhysChunks, type RenderChunks } from './meshKit';
import { pointAtS, type REdge, type RoadNet } from './roadNet';
import { B, K, type GeoRaster } from './terrain';

const G = TUNING.geo;
const COL = { asphalt: lin(0x55585d), kerb: lin(0xa3a29c), line: lin(0xeeeee6), skirt: lin(0x7a7268) };
const ENTRANCE_W = 7.5; // m

export interface GeoLot {
  id: string;
  capacity: number; // from the map data
  access: string; // 'yes' | 'customers'
  /** x, y, z, heading per bay; heading = yaw with the car's forward = +Z rotated by heading (nose into the bay). */
  stalls: Float32Array;
  entrance: { x: number; z: number; y: number; roadEdge: number };
  outline: Pt[];
}

interface LotPlan {
  lot: GeoDoc['parking'][number];
  /** plane: y = a + bx*x + bz*z */
  a: number;
  bx: number;
  bz: number;
  entrance: { x: number; z: number; y: number; edge: REdge | null; side: number; s: number; polyEdge: number };
  /** m from the street's kerb to the lot edge at the entrance */
  gap: number;
}

/** Plan every car park (surface plane, entrance, dropped kerb on the street) before the road raster is written. */
export function planLots(doc: GeoDoc, ras: GeoRaster, net: RoadNet): LotPlan[] {
  const plans: LotPlan[] = [];
  for (const lot of doc.parking) {
    const P = lot.pts;
    const n = P.length;
    // entrance: the lot side whose midpoint is closest to a street kerb with a sidewalk
    let best: LotPlan['entrance'] | null = null, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const p = P[i], q = P[(i + 1) % n];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      for (const e of net.edges) {
        if (e.deck) continue;
        const pr = net.project(e, mx, mz);
        if (pr.s < e.trimA + 6 || pr.s > e.L - e.trimB - 6) continue;
        const gap = pr.d - e.hw;
        if (gap < bd) {
          bd = gap;
          const side = pr.off > 0 ? 1 : -1;
          const k = pointAtS(e, pr.s);
          const kx = k.x - k.uz * side * (e.hw + G.sidewalkWidth), kz = k.z + k.ux * side * (e.hw + G.sidewalkWidth);
          best = { x: kx, z: kz, y: net.profAt(e, pr.s) + G.kerbHeight, edge: e, side, s: pr.s, polyEdge: i };
        }
      }
    }
    // plane through the terrain, shifted to meet the sidewalk at the entrance
    const mx = P.reduce((s, p) => s + p[0], 0) / n, mz = P.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0, sh = 0;
    for (const p of P) {
      const x = p[0] - mx, z = p[1] - mz, h = ras.baseAt(p[0], p[1]);
      sxx += x * x; szz += z * z; sxz += x * z; sxh += x * h; szh += z * h; sh += h;
    }
    const det = sxx * szz - sxz * sxz || 1;
    const bx = clamp((sxh * szz - szh * sxz) / det, -0.03, 0.03), bz = clamp((szh * sxx - sxh * sxz) / det, -0.03, 0.03);
    let a = sh / n - bx * mx - bz * mz;
    if (best && bd < 12) {
      a += best.y - (a + bx * best.x + bz * best.z);
      if (best.edge) best.edge.cuts.push([best.side, best.s - ENTRANCE_W / 2, best.s + ENTRANCE_W / 2]);
    } else best = { x: mx, z: mz, y: a + bx * mx + bz * mz, edge: null, side: 0, s: 0, polyEdge: -1 };
    const plan: LotPlan = { lot, a, bx, bz, entrance: best, gap: bd };
    plans.push(plan);
  }
  return plans;
}

/**
 * Parking aisles and service roads inside a car park take the car park's surface (the lot is one plane; the aisle
 * followed the terrain and ran up to half a metre above or below it), blended over TUNING.geo.conformBlend outside.
 * Call before the road raster and meshes are built.
 */
export function conformToLots(net: RoadNet, plans: LotPlan[]) {
  if (net.synthetic) return;
  for (const e of net.edges) {
    if (e.deck || (e.cls !== 'service' && e.cls !== 'road')) continue;
    const n = e.pts.length, c = e.cum;
    const target = new Float32Array(n).fill(NaN);
    let any = false;
    for (let k = 0; k < n; k++) {
      const p = e.pts[k];
      for (const pl of plans) {
        if (!pointInPoly(p[0], p[1], pl.lot.pts)) continue;
        target[k] = pl.a + pl.bx * p[0] + pl.bz * p[1];
        any = true;
        break;
      }
    }
    if (!any) continue;
    const out = Float32Array.from(e.prof);
    for (let k = 0; k < n; k++) {
      const s = c[k];
      if (s <= e.trimA + 0.01 || s >= e.L - e.trimB - 0.01) continue;
      let bd = Infinity, hv = 0;
      for (let q = 0; q < n; q++) if (!Number.isNaN(target[q]) && Math.abs(c[q] - s) < bd) { bd = Math.abs(c[q] - s); hv = target[q]; }
      if (bd > G.conformBlend) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * bd) / G.conformBlend);
      out[k] = e.prof[k] + (hv - e.prof[k]) * w;
    }
    e.prof = out;
  }
}

/** Car park surfaces and entrance aprons into the raster (after the road raster: roads keep their cells). */
export function rasterizeLots(plans: LotPlan[], ras: GeoRaster): LotPlan[] {
  for (const plan of plans) {
    const { lot, a, bx, bz } = plan;
    const P = lot.pts;
    const best = plan.entrance;
    const bd = plan.gap;
    const h = ras.h!, band = ras.band, k = ras.k;
    ras.fillRing(P, (o, x, z) => {
      if (band[o] === B.ROAD || band[o] === B.FLAT) return;
      h[o] = a + bx * x + bz * z;
      band[o] = B.FLAT;
      k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.LOT;
    });
    // the apron between the lot edge and the sidewalk at the entrance
    if (best.edge) {
      const e = best.edge;
      const q = pointAtS(e, best.s);
      const rx = -q.uz * best.side, rz = q.ux * best.side;
      const o0 = e.hw + G.sidewalkWidth - 0.2, o1 = o0 + Math.max(1, bd - G.sidewalkWidth + 1.5);
      const ux = q.ux * ENTRANCE_W / 2, uz = q.uz * ENTRANCE_W / 2;
      ras.fillQuad(q.x + rx * o0 - ux, q.z + rz * o0 - uz, q.x + rx * o1 - ux, q.z + rz * o1 - uz, q.x + rx * o1 + ux, q.z + rz * o1 + uz, q.x + rx * o0 + ux, q.z + rz * o0 + uz, (o) => {
        if (band[o] === B.ROAD) return;
        h[o] = best!.y;
        band[o] = B.FLAT;
        k[o] |= K.LOT;
      });
    }
  }
  return plans;
}

export function buildLots(plans: LotPlan[], ras: GeoRaster, chunks: RenderChunks, phys: PhysChunks): GeoLot[] {
  const out: GeoLot[] = [];
  for (const pl of plans) {
    const P = pl.lot.pts;
    const n = P.length;
    const H = (x: number, z: number) => pl.a + pl.bx * x + pl.bz * z;
    const mx = P.reduce((s, p) => s + p[0], 0) / n, mz = P.reduce((s, p) => s + p[1], 0) / n;
    const buf = chunks.buf('ground', mx, mz);
    const dec = chunks.buf('decal', mx, mz);
    const pb = phys.ground(mx, mz);
    // surface (fan from the centre: lots are convex quads)
    for (let i = 0; i < n; i++) {
      const p = P[i], q = P[(i + 1) % n];
      buf.tri(mx, H(mx, mz), mz, p[0], H(p[0], p[1]), p[1], q[0], H(q[0], q[1]), q[1], COL.asphalt, 0, 1, 0);
      pb.tri(mx, H(mx, mz), mz, p[0], H(p[0], p[1]), p[1], q[0], H(q[0], q[1]), q[1]);
    }
    // kerbed edge (0.5 m raised strip) with a gap at the entrance; skirt below
    for (let i = 0; i < n; i++) {
      const p = P[i], q = P[(i + 1) % n];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
      let nx = -uz, nz = ux;
      // inward normal
      const cx = (p[0] + q[0]) / 2, cz = (p[1] + q[1]) / 2;
      if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
      let gap0 = Infinity, gap1 = -Infinity;
      if (i === pl.entrance.polyEdge) {
        const t = (pl.entrance.x - p[0]) * ux + (pl.entrance.z - p[1]) * uz;
        gap0 = t - ENTRANCE_W / 2; gap1 = t + ENTRANCE_W / 2;
      }
      const pieces: [number, number][] = gap1 > gap0 ? [[0, Math.max(0, gap0)], [Math.min(L, gap1), L]] : [[0, L]];
      for (const [t0, t1] of pieces) {
        if (t1 - t0 < 0.3) continue;
        const ax = p[0] + ux * t0, az = p[1] + uz * t0, bx = p[0] + ux * t1, bz = p[1] + uz * t1;
        const ya = H(ax, az), yb = H(bx, bz), kk = G.kerbHeight;
        const iax = ax + nx * 0.5, iaz = az + nz * 0.5, ibx = bx + nx * 0.5, ibz = bz + nz * 0.5;
        buf.quad(ax, ya + kk, az, bx, yb + kk, bz, ibx, yb + kk, ibz, iax, ya + kk, iaz, COL.kerb, 0, 1, 0);
        buf.wall(iax, iaz, ibx, ibz, ya, ya + kk, yb, yb + kk, COL.kerb, nx, nz);
        pb.quad(ax, ya + kk, az, bx, yb + kk, bz, ibx, yb + kk, ibz, iax, ya + kk, iaz);
        pb.quad(iax, ya, iaz, ibx, yb, ibz, ibx, yb + kk, ibz, iax, ya + kk, iaz);
      }
      buf.wall(p[0], p[1], q[0], q[1], H(p[0], p[1]) - 1, H(p[0], p[1]) + G.kerbHeight, H(q[0], q[1]) - 1, H(q[0], q[1]) + G.kerbHeight, COL.skirt, -nx, -nz);
    }
    // entrance apron
    if (pl.entrance.edge) {
      const e = pl.entrance.edge, s = pl.entrance.s, side = pl.entrance.side;
      const q = pointAtS(e, s);
      const rx = -q.uz * side, rz = q.ux * side;
      const o0 = e.hw + G.sidewalkWidth - 0.2;
      let o1 = o0 + 1;
      for (let o = o0; o < o0 + 20; o += 0.5) { if (pointInPoly(q.x + rx * o, q.z + rz * o, P)) { o1 = o + 0.6; break; } }
      const ux = q.ux * ENTRANCE_W / 2, uz = q.uz * ENTRANCE_W / 2, y = pl.entrance.y + 0.005;
      buf.quad(q.x + rx * o0 - ux, y, q.z + rz * o0 - uz, q.x + rx * o1 - ux, y, q.z + rz * o1 - uz, q.x + rx * o1 + ux, y, q.z + rz * o1 + uz, q.x + rx * o0 + ux, y, q.z + rz * o0 + uz, COL.asphalt, 0, 1, 0);
      pb.quad(q.x + rx * o0 - ux, y, q.z + rz * o0 - uz, q.x + rx * o1 - ux, y, q.z + rz * o1 - uz, q.x + rx * o1 + ux, y, q.z + rz * o1 + uz, q.x + rx * o0 + ux, y, q.z + rz * o0 + uz);
    }
    // bays: rows along the longest side
    let li = 0, ll = 0;
    for (let i = 0; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L > ll) { ll = L; li = i; } }
    const ux = (P[(li + 1) % n][0] - P[li][0]) / ll, uz = (P[(li + 1) % n][1] - P[li][1]) / ll;
    const vx = -uz, vz = ux;
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const p of P) {
      const u = (p[0] - mx) * ux + (p[1] - mz) * uz, v = (p[0] - mx) * vx + (p[1] - mz) * vz;
      umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
    }
    const SW = G.stallWidth, SL = G.stallLength, AI = G.lotAisle;
    const stalls: number[] = [];
    const inside = (u: number, v: number) => {
      const x = mx + ux * u + vx * v, z = mz + uz * u + vz * v;
      return pointInPoly(x, z, P);
    };
    const ent = pl.entrance;
    const nearEntrance = (x: number, z: number) => Math.hypot(x - ent.x, z - ent.z) < ENTRANCE_W + 2;
    // pattern across v: [row facing -v][aisle][row facing +v][row facing -v][aisle]...
    let v = vmin + 1.2;
    let facing = -1;
    const rows: { v0: number; dir: number }[] = [];
    while (v + SL <= vmax - 1) {
      rows.push({ v0: v, dir: facing });
      v += SL;
      if (facing === -1) { v += AI; facing = 1; } else facing = -1;
    }
    for (const r of rows) {
      for (let u = umin + 1.5; u + SW <= umax - 1.5; u += SW) {
        const cu = u + SW / 2, cv = r.v0 + SL / 2;
        if (!inside(u, r.v0) || !inside(u + SW, r.v0) || !inside(u, r.v0 + SL) || !inside(u + SW, r.v0 + SL)) continue;
        const x = mx + ux * cu + vx * cv, z = mz + uz * cu + vz * cv;
        if (nearEntrance(x, z)) continue;
        // nose into the bay: forward = from the aisle into the row = -dir * v
        const fx = -r.dir * vx, fz = -r.dir * vz;
        stalls.push(x, H(x, z), z, Math.atan2(fx, fz));
        // painted separators (both sides) and the back line
        for (const uu of [u, u + SW]) {
          const ax = mx + ux * uu + vx * r.v0, az = mz + uz * uu + vz * r.v0;
          const bx = ax + vx * SL, bz = az + vz * SL;
          const y0 = H(ax, az) + 0.012, y1 = H(bx, bz) + 0.012;
          dec.quad(ax - ux * 0.06, y0, az - uz * 0.06, ax + ux * 0.06, y0, az + uz * 0.06, bx + ux * 0.06, y1, bz + uz * 0.06, bx - ux * 0.06, y1, bz - uz * 0.06, COL.line, 0, 1, 0);
        }
      }
    }
    out.push({
      id: pl.lot.id, capacity: pl.lot.capacity, access: pl.lot.access ?? 'yes', stalls: Float32Array.from(stalls),
      entrance: { x: ent.x, z: ent.z, y: ent.y, roadEdge: ent.edge ? ent.edge.id : -1 }, outline: P,
    });
    void ras;
  }
  return out;
}
