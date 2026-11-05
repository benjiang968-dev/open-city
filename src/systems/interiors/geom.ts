// Small 2D geometry helpers for building interiors (x, z points in metres): half-plane clipping, insets, areas,
// line-in-polygon intervals and a plan frame (u along a building's front wall, v inward). Pure functions, no three.js.
export type P2 = [number, number];

/** Signed area (positive = counter-clockwise in x right, z down... the sign only matters for orientation tests). */
export function signedArea(P: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += P[j][0] * P[i][1] - P[i][0] * P[j][1];
  return a / 2;
}
export function area(P: readonly P2[]): number {
  return Math.abs(signedArea(P));
}
export function pointIn(x: number, z: number, P: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance from (x, z) to the polygon's boundary. */
export function edgeDist(x: number, z: number, P: readonly P2[]): number {
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const ax = P[j][0], az = P[j][1], dx = P[i][0] - ax, dz = P[i][1] - az;
    const l2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
/**
 * The part of polygon P where nx * x + nz * z >= c (Sutherland-Hodgman against one line). Works for concave P (the
 * result may carry zero-width bridges between parts, harmless for areas, triangulation and hulls of convex input).
 */
export function clipHalf(P: readonly P2[], nx: number, nz: number, c: number): P2[] {
  const out: P2[] = [];
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const fa = a[0] * nx + a[1] * nz - c, fb = b[0] * nx + b[1] * nz - c;
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return dedupe(out);
}
function dedupe(P: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of P) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-6 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

/**
 * A plan frame: origin o on a building's front wall line, u along the wall (away from the door's end), v inward.
 * World (x, z) = o + u * U + v * V.
 */
export interface Frame { ox: number; oz: number; ux: number; uz: number; vx: number; vz: number }
export function toWorld(f: Frame, u: number, v: number): P2 {
  return [f.ox + f.ux * u + f.vx * v, f.oz + f.uz * u + f.vz * v];
}
export function toFrame(f: Frame, x: number, z: number): P2 {
  const dx = x - f.ox, dz = z - f.oz;
  return [dx * f.ux + dz * f.uz, dx * f.vx + dz * f.vz];
}
/** Polygon P (world) clipped to the frame box u in [u0, u1], v in [v0, v1] (use +-Infinity for an open side). */
export function clipBox(P: readonly P2[], f: Frame, u0: number, u1: number, v0: number, v1: number): P2[] {
  let Q: P2[] = P.slice() as P2[];
  const cu = f.ox * f.ux + f.oz * f.uz, cv = f.ox * f.vx + f.oz * f.vz;
  if (u0 > -Infinity && Q.length >= 3) Q = clipHalf(Q, f.ux, f.uz, cu + u0);
  if (u1 < Infinity && Q.length >= 3) Q = clipHalf(Q, -f.ux, -f.uz, -(cu + u1));
  if (v0 > -Infinity && Q.length >= 3) Q = clipHalf(Q, f.vx, f.vz, cv + v0);
  if (v1 < Infinity && Q.length >= 3) Q = clipHalf(Q, -f.vx, -f.vz, -(cv + v1));
  return Q.length >= 3 && area(Q) > 1e-4 ? Q : [];
}

/**
 * Inset a simple polygon by a distance per edge (edge i runs from P[i] to P[i+1]): offset lines intersected at each
 * vertex (miter, limited). Orientation is detected, so `d` > 0 always moves inward.
 */
export function insetPoly(P: readonly P2[], d: readonly number[]): P2[] {
  const n = P.length;
  const s = signedArea(P) > 0 ? 1 : -1;
  // inward normal of edge i: rotate the edge direction by +90 deg (or -90 for the other orientation)
  const lines: { px: number; pz: number; dx: number; dz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    // for a CCW polygon (positive signedArea with this formula) the inside is to the left: (-dz, dx)... we test it
    let nx = -dz * s, nz = dx * s;
    const mx = (a[0] + b[0]) / 2 + nx * 0.01, mz = (a[1] + b[1]) / 2 + nz * 0.01;
    if (!pointIn(mx, mz, P)) { nx = -nx; nz = -nz; }
    lines.push({ px: a[0] + nx * d[i], pz: a[1] + nz * d[i], dx, dz });
  }
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i + n - 1) % n], B = lines[i];
    const den = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(den) < 1e-6) { out.push([B.px, B.pz]); continue; }
    const t = ((B.px - A.px) * B.dz - (B.pz - A.pz) * B.dx) / den;
    let x = A.px + A.dx * t, z = A.pz + A.dz * t;
    // limit spikes at very sharp corners
    const ox = P[i][0], oz = P[i][1];
    const dm = Math.hypot(x - ox, z - oz), lim = 3 * Math.max(d[(i + n - 1) % n], d[i]) + 0.01;
    if (dm > lim) { x = ox + ((x - ox) / dm) * lim; z = oz + ((z - oz) / dm) * lim; }
    out.push([x, z]);
  }
  return out;
}

/** Intervals [t0, t1] of the segment a-b (t from 0 to 1) that lie inside polygon P. */
export function segmentInside(P: readonly P2[], ax: number, az: number, bx: number, bz: number): [number, number][] {
  const ts: number[] = [0, 1];
  const n = P.length;
  const dx = bx - ax, dz = bz - az;
  for (let i = 0; i < n; i++) {
    const p = P[i], q = P[(i + 1) % n];
    const ex = q[0] - p[0], ez = q[1] - p[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - ax) * ez - (p[1] - az) * ex) / den;
    const s = ((p[0] - ax) * dz - (p[1] - az) * dx) / den;
    if (t > 0 && t < 1 && s >= 0 && s <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-6) continue;
    const tm = (t0 + t1) / 2;
    if (pointIn(ax + dx * tm, az + dz * tm, P)) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - t0) < 1e-6) last[1] = t1;
      else out.push([t0, t1]);
    }
  }
  return out;
}

/** Bounding box of a polygon in a frame: [u0, u1, v0, v1]. */
export function frameBounds(f: Frame, P: readonly P2[]): [number, number, number, number] {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of P) {
    const [u, v] = toFrame(f, p[0], p[1]);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return [u0, u1, v0, v1];
}

/** Deterministic random stream (mulberry32) for interior contents. */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
