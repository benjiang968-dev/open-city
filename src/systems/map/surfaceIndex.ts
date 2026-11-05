// Exact walking-surface heights from the collider triangles themselves. The Georgetown world's ground, kerbs,
// sidewalks, lots, canal aprons and stair ramps are trimesh colliders; map.heightAt reads this index, so the height
// the map reports and the surface the player stands on are the same triangles. (The 1 m height raster alone smoothed
// every kerb, sidewalk edge and fold of the 5 m terrain mesh: 5-20 cm off at about 1.6 % of the walkable ground, and
// up to a metre beside the canal.)
//
// A uniform grid of CELL-metre buckets lists the triangles whose footprint box overlaps each bucket. A query tests
// the bucket's triangles (2D edge functions) and evaluates the plane of each one containing the point. No allocation
// per query; built once at boot from the triangle soups PhysChunks hands over before it builds the trimeshes.

/** Bucket size (m): about 6 triangle references per bucket on Georgetown, a dozen on busy junctions. */
const CELL = 4;
/** Floats per triangle: ax, az, bx, bz, cx, cz (footprint), then the plane y = ay + px * (x - ax) + pz * (z - az) as
 * px, pz, ay (relative to a vertex: no float32 cancellation far from the origin, even on steep slivers). */
const TS = 9;
/** Footprints thinner than this (m^2, twice the area) are walls and kerb faces: nothing stands on them. */
const MIN_AREA2 = 1e-4;
/** Tolerance (m) of the inside test, so a point on the edge shared by two triangles is in at least one. */
const EDGE_EPS = 1e-4;

/**
 * The triangles of `soups` whose footprint box comes within `r` of any of the points (x, z pairs): a small soup for a
 * build-time SurfaceIndex over a few places (stair ends) instead of the whole map.
 */
export function trianglesNear(soups: Float32Array[], points: ArrayLike<number>, r: number): Float32Array {
  const cell = Math.max(4, r * 2);
  const cells = new Set<number>();
  const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (let k = 0; k + 1 < points.length; k += 2) {
    const i0 = Math.floor((points[k] - r) / cell), i1 = Math.floor((points[k] + r) / cell);
    const j0 = Math.floor((points[k + 1] - r) / cell), j1 = Math.floor((points[k + 1] + r) / cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells.add(key(i, j));
  }
  const out: number[] = [];
  for (const s of soups) {
    for (let t = 0; t + 8 < s.length; t += 9) {
      const i0 = Math.floor(Math.min(s[t], s[t + 3], s[t + 6]) / cell), i1 = Math.floor(Math.max(s[t], s[t + 3], s[t + 6]) / cell);
      const j0 = Math.floor(Math.min(s[t + 2], s[t + 5], s[t + 8]) / cell), j1 = Math.floor(Math.max(s[t + 2], s[t + 5], s[t + 8]) / cell);
      let hit = false;
      for (let j = j0; j <= j1 && !hit; j++) for (let i = i0; i <= i1 && !hit; i++) hit = cells.has(key(i, j));
      if (hit) for (let q = 0; q < 9; q++) out.push(s[t + q]);
    }
  }
  return Float32Array.from(out);
}

export class SurfaceIndex {
  private readonly tri: Float32Array;
  private readonly start: Uint32Array;
  private readonly refs: Uint32Array;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;
  /** Triangles indexed. */
  readonly count: number;

  /** soups: Float32Arrays of xyz triples, three vertices per triangle (vertical triangles are skipped). */
  constructor(soups: Float32Array[]) {
    const area2 = (s: Float32Array, i: number) => (s[i + 3] - s[i]) * (s[i + 8] - s[i + 2]) - (s[i + 5] - s[i + 2]) * (s[i + 6] - s[i]);
    let n = 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const s of soups) {
      for (let i = 0; i + 8 < s.length; i += 9) if (Math.abs(area2(s, i)) >= MIN_AREA2) n++;
      for (let i = 0; i < s.length; i += 3) {
        if (s[i] < x0) x0 = s[i];
        if (s[i] > x1) x1 = s[i];
        if (s[i + 2] < z0) z0 = s[i + 2];
        if (s[i + 2] > z1) z1 = s[i + 2];
      }
    }
    if (n === 0) { x0 = z0 = 0; x1 = z1 = 1; }
    this.x0 = x0;
    this.z0 = z0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / CELL) + 1);
    this.nz = Math.max(1, Math.ceil((z1 - z0) / CELL) + 1);
    const T = new Float32Array(n * TS);
    let m = 0;
    for (const s of soups) {
      for (let i = 0; i + 8 < s.length; i += 9) {
        const ax = s[i], ay = s[i + 1], az = s[i + 2], bx = s[i + 3], by = s[i + 4], bz = s[i + 5], cx = s[i + 6], cy = s[i + 7], cz = s[i + 8];
        const a2 = area2(s, i);
        if (Math.abs(a2) < MIN_AREA2) continue;
        const px = ((by - ay) * (cz - az) - (cy - ay) * (bz - az)) / a2;
        const pz = ((cy - ay) * (bx - ax) - (by - ay) * (cx - ax)) / a2;
        const o = m * TS;
        // store counter-clockwise in (x, z) so the inside test is three edge functions >= 0
        if (a2 > 0) { T[o] = ax; T[o + 1] = az; T[o + 2] = bx; T[o + 3] = bz; T[o + 4] = cx; T[o + 5] = cz; }
        else { T[o] = ax; T[o + 1] = az; T[o + 2] = cx; T[o + 3] = cz; T[o + 4] = bx; T[o + 5] = bz; }
        T[o + 6] = px; T[o + 7] = pz; T[o + 8] = ay;
        m++;
      }
    }
    this.count = m;
    this.tri = T;
    // bucket lists (counting pass, then fill)
    const nb = this.nx * this.nz;
    const cnt = new Uint32Array(nb + 1);
    const span = (t: number, f: (b: number) => void) => {
      const o = t * TS;
      const bx0 = Math.floor((Math.min(T[o], T[o + 2], T[o + 4]) - EDGE_EPS - x0) / CELL), bx1 = Math.floor((Math.max(T[o], T[o + 2], T[o + 4]) + EDGE_EPS - x0) / CELL);
      const bz0 = Math.floor((Math.min(T[o + 1], T[o + 3], T[o + 5]) - EDGE_EPS - z0) / CELL), bz1 = Math.floor((Math.max(T[o + 1], T[o + 3], T[o + 5]) + EDGE_EPS - z0) / CELL);
      for (let j = Math.max(0, bz0); j <= Math.min(this.nz - 1, bz1); j++)
        for (let i = Math.max(0, bx0); i <= Math.min(this.nx - 1, bx1); i++) f(j * this.nx + i);
    };
    for (let t = 0; t < m; t++) span(t, (b) => { cnt[b + 1]++; });
    for (let b = 0; b < nb; b++) cnt[b + 1] += cnt[b];
    const refs = new Uint32Array(cnt[nb]);
    const fill = cnt.slice(0, nb);
    for (let t = 0; t < m; t++) span(t, (b) => { refs[fill[b]++] = t; });
    this.start = cnt;
    this.refs = refs;
  }

  /**
   * Height of the walking surface at (x, z). Without `ceil`: the highest triangle there. With it: the highest
   * triangle at most `ceil` (the floor under something at that height), or else the lowest one above it. NaN where
   * no triangle covers the point (inside buildings, open water, off the map).
   */
  at(x: number, z: number, ceil = Infinity): number {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return NaN;
    const b = j * this.nx + i, T = this.tri, R = this.refs;
    let best = -Infinity, above = Infinity;
    for (let k = this.start[b], e = this.start[b + 1]; k < e; k++) {
      const o = R[k] * TS;
      const ax = T[o], az = T[o + 1], bx = T[o + 2], bz = T[o + 3], cx = T[o + 4], cz = T[o + 5];
      if ((bx - ax) * (z - az) - (bz - az) * (x - ax) < -EDGE_EPS) continue;
      if ((cx - bx) * (z - bz) - (cz - bz) * (x - bx) < -EDGE_EPS) continue;
      if ((ax - cx) * (z - cz) - (az - cz) * (x - cx) < -EDGE_EPS) continue;
      const y = T[o + 8] + T[o + 6] * (x - ax) + T[o + 7] * (z - az);
      if (y <= ceil) { if (y > best) best = y; } else if (y < above) above = y;
    }
    return best > -Infinity ? best : above < Infinity ? above : NaN;
  }
}
