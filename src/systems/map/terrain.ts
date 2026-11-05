// Terrain for the Georgetown world: a 1 m height + kind raster (the source of heightAt / isRoad / isBlocked /
// isWater), the band blending that flattens roads and sidewalks into the hillside, and the 5 m terrain mesh
// (grass, earth, river banks, the Rock Creek valley) with matching static physics.
import type { GeoDoc, Pt } from './geoDoc';
import { clamp, pointInPoly } from './geoDoc';
import { lin, mixc, shade, type RenderChunks, type PhysChunks } from './meshKit';
import { SURF, surf } from '../render/surfaces';

/** Kind flags stored per 1 m cell. */
export const K = {
  ROAD: 1, // carriageway or junction at ground level
  WALK: 2, // sidewalk, footway, plaza, towpath, steps
  BUILDING: 4,
  WATER: 8,
  WALL: 16, // canal walls, parapets, fences at ground level
  LOT: 32, // car park surface
  PARK: 64, // park / garden / cemetery grass
  DECK: 128, // a bridge or the freeway passes overhead (still drivable / walkable in 2D)
} as const;

/** Band markers: how the terrain mesh treats a cell. */
export const B = {
  NONE: 0,
  ROAD: 1, // carriageway: terrain mesh dips under it
  FLAT: 2, // sidewalk, lot, plaza, steps: terrain mesh dips under it
  HOLE: 3, // canal corridor: terrain mesh leaves a hole, the corridor has its own geometry
  BUILDING: 4,
} as const;

// ---------------------------------------------------------------------------------------- art constants
const MESH_STEP = 5; // m, terrain mesh grid
const STEP_UNIT = 0.025; // m per unit of the step-distance raster
const STEP_MAX = 126; // units (3.15 m): beyond this a cell is 'far' from any step
const STEP_FAR = 127;
const BAND_DIP = 0.3; // m the terrain mesh sits below road/sidewalk surfaces
const BLEND_CELL = 4; // m, coarse grid used to blend terrain into road bands
const BLEND_RADIUS = 4; // coarse cells (box blur radius, applied twice)
const COL = {
  grass: surf(SURF.TERRAIN, lin(0x7fae5a)),
  grassDry: surf(SURF.TERRAIN, lin(0x9db467)),
  park: surf(SURF.TERRAIN, lin(0x6aa64c)),
  cemetery: surf(SURF.TERRAIN, lin(0x5f9446)),
  yard: surf(SURF.TERRAIN, lin(0x7ea558)),
  earth: surf(SURF.TERRAIN, lin(0x8a7357)),
  mud: surf(SURF.TERRAIN, lin(0x7d7158)),
  sand: surf(SURF.TERRAIN, lin(0xc9b98f)),
  bed: surf(SURF.TERRAIN, lin(0x5d6a55)),
  outer: surf(SURF.TERRAIN, lin(0x6f9650)),
  outerFar: surf(SURF.TERRAIN, lin(0x56794a)),
};

export class GeoRaster {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  /** Final heights in centimetres (Int16): heightAt. */
  hq!: Int16Array;
  /** Working heights (metres) while building; dropped after finish(). */
  h: Float32Array | null;
  /** Base terrain (data heightfield + water cuts), kept for blending; dropped after finish(). */
  t: Float32Array | null;
  k: Uint8Array;
  band: Uint8Array;
  /** 1 where a terrain triangle covers the cell (set by buildTerrainMesh, dropped by bakeAprons). */
  meshed: Uint8Array | null = null;
  constructor(x0: number, z0: number, x1: number, z1: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.nx = Math.ceil(x1 - x0) + 1;
    this.nz = Math.ceil(z1 - z0) + 1;
    const n = this.nx * this.nz;
    this.h = new Float32Array(n);
    this.t = new Float32Array(n);
    this.k = new Uint8Array(n);
    this.band = new Uint8Array(n);
    this.step = new Int8Array(n).fill(STEP_FAR);
  }
  /**
   * Signed distance (STEP_UNIT m) from each cell centre to the nearest height step (a kerb, the canal walls), positive
   * on the high side; STEP_FAR where none is near. heightAt uses it to sample only the cells on the query point's own
   * side of a step, so the 1 m raster gives the exact step instead of smearing it over a metre.
   */
  step: Int8Array;
  /** Record a step distance for a cell (signed: + high side); the nearest step wins. */
  markStep(o: number, signedDist: number) {
    const v = Math.max(-STEP_MAX, Math.min(STEP_MAX, Math.round(signedDist / STEP_UNIT)));
    const cur = this.step[o];
    if (cur === STEP_FAR || Math.abs(v) < Math.abs(cur)) this.step[o] = v;
  }

  /** Fill base terrain from the 10 m data heightfield (bilinear). */
  fillBase(doc: GeoDoc) {
    const H = doc.heights;
    const t = this.t!;
    const d = H.data;
    for (let j = 0; j < this.nz; j++) {
      const fz = clamp((this.z0 + j - H.z0) / H.spacing, 0, H.nz - 1.0001);
      const iz = Math.floor(fz), tz = fz - iz;
      for (let i = 0; i < this.nx; i++) {
        const fx = clamp((this.x0 + i - H.x0) / H.spacing, 0, H.nx - 1.0001);
        const ix = Math.floor(fx), tx = fx - ix;
        const o = iz * H.nx + ix;
        t[j * this.nx + i] = (d[o] * (1 - tx) + d[o + 1] * tx) * (1 - tz) + (d[o + H.nx] * (1 - tx) + d[o + H.nx + 1] * tx) * tz;
      }
    }
  }

  /** Base terrain at a point (bilinear on the working base raster; build time only). */
  baseAt(x: number, z: number): number {
    return this.sample(this.t!, x, z);
  }
  /** Working height at a point (bilinear; build time only). */
  workAt(x: number, z: number): number {
    return this.sample(this.h!, x, z);
  }
  private sample(a: Float32Array, x: number, z: number): number {
    const fx = clamp(x - this.x0, 0, this.nx - 1.001), fz = clamp(z - this.z0, 0, this.nz - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const o = iz * this.nx + ix;
    return (a[o] * (1 - tx) + a[o + 1] * tx) * (1 - tz) + (a[o + this.nx] * (1 - tx) + a[o + this.nx + 1] * tx) * tz;
  }

  /** O(1), no allocation: final ground height (bilinear, 1 m cells). */
  heightAt(x: number, z: number): number {
    let fx = x - this.x0, fz = z - this.z0;
    if (fx < 0) fx = 0; else if (fx > this.nx - 1.001) fx = this.nx - 1.001;
    if (fz < 0) fz = 0; else if (fz > this.nz - 1.001) fz = this.nz - 1.001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const a = this.hq, o = iz * this.nx + ix, nx = this.nx;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    const S = this.step, s00 = S[o], s10 = S[o + 1], s01 = S[o + nx], s11 = S[o + nx + 1];
    if (s00 !== STEP_FAR || s10 !== STEP_FAR || s01 !== STEP_FAR || s11 !== STEP_FAR) {
      // near a kerb or wall: the interpolated signed distance says which side the point is on; average only the
      // cells on that side (cells without a distance count as far on the high side)
      const hi = w00 * s00 + w10 * s10 + w01 * s01 + w11 * s11 >= 0;
      let ws = 0, hs = 0;
      if (s00 >= 0 === hi) { ws += w00; hs += w00 * a[o]; }
      if (s10 >= 0 === hi) { ws += w10; hs += w10 * a[o + 1]; }
      if (s01 >= 0 === hi) { ws += w01; hs += w01 * a[o + nx]; }
      if (s11 >= 0 === hi) { ws += w11; hs += w11 * a[o + nx + 1]; }
      if (ws > 1e-6) return (hs / ws) * 0.01;
    }
    return (a[o] * w00 + a[o + 1] * w10 + a[o + nx] * w01 + a[o + nx + 1] * w11) * 0.01;
  }
  /** O(1): kind flags of the nearest cell (0 outside the map). */
  kindAt(x: number, z: number): number {
    const i = Math.round(x - this.x0), j = Math.round(z - this.z0);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.k[j * this.nx + i];
  }
  bandAt(x: number, z: number): number {
    const i = Math.round(x - this.x0), j = Math.round(z - this.z0);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.band[j * this.nx + i];
  }

  /**
   * Scanline-fill a polygon (even-odd), calling cb(index, x, z) for every cell centre inside. pts are [x, z].
   */
  fillPoly(pts: ArrayLike<number>, cb: (o: number, x: number, z: number) => void) {
    const n = pts.length / 2;
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < n; i++) { const z = pts[i * 2 + 1]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    const j0 = Math.max(0, Math.ceil(zmin - this.z0)), j1 = Math.min(this.nz - 1, Math.floor(zmax - this.z0));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + j;
      xs.length = 0;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const za = pts[a * 2 + 1], zb = pts[b * 2 + 1];
        if (za > z !== zb > z) {
          const xa = pts[a * 2], xb = pts[b * 2];
          xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil(xs[s] - this.x0)), i1 = Math.min(this.nx - 1, Math.floor(xs[s + 1] - this.x0));
        const row = j * this.nx;
        for (let i = i0; i <= i1; i++) cb(row + i, this.x0 + i, z);
      }
    }
  }
  fillRing(pts: Pt[], cb: (o: number, x: number, z: number) => void) {
    const a = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { a[i * 2] = p[0]; a[i * 2 + 1] = p[1]; });
    this.fillPoly(a, cb);
  }
  private q4 = new Float64Array(8);
  fillQuad(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, cb: (o: number, x: number, z: number) => void) {
    const q = this.q4;
    q[0] = ax; q[1] = az; q[2] = bx; q[3] = bz; q[4] = cx; q[5] = cz; q[6] = dx; q[7] = dz;
    this.fillPoly(q, cb);
  }
  /** Cells within r of segment a-b: cb(index, distance, t along the segment, side sign). */
  forSegment(ax: number, az: number, bx: number, bz: number, r: number, cb: (o: number, d: number, t: number, side: number) => void) {
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - this.x0)), i1 = Math.min(this.nx - 1, Math.ceil(Math.max(ax, bx) + r - this.x0));
    const j0 = Math.max(0, Math.floor(Math.min(az, bz) - r - this.z0)), j1 = Math.min(this.nz - 1, Math.ceil(Math.max(az, bz) + r - this.z0));
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + j;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i;
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const d = Math.sqrt(qx * qx + qz * qz);
        if (d <= r) cb(j * this.nx + i, d, t, dx * (z - az) - dz * (x - ax) > 0 ? 1 : -1);
      }
    }
  }

  /**
   * Blend natural terrain (band NONE, not water) toward the heights of nearby bands so roads sit in gentle cuttings
   * and embankments. Coarse grid + double box blur keeps it cheap.
   */
  blendBands() {
    const h = this.h!, t = this.t!, band = this.band, k = this.k;
    const cs = BLEND_CELL;
    const cx = Math.ceil(this.nx / cs) + 1, cz = Math.ceil(this.nz / cs) + 1;
    let A = new Float32Array(cx * cz), W = new Float32Array(cx * cz);
    for (let j = 0; j < this.nz; j++) {
      const row = j * this.nx, cr = Math.floor(j / cs) * cx;
      for (let i = 0; i < this.nx; i++) {
        const o = row + i, b = band[o];
        if (b !== B.ROAD && b !== B.FLAT) continue;
        const c = cr + Math.floor(i / cs);
        A[c] += h[o] - t[o];
        W[c] += 1;
      }
    }
    const inv = 1 / (cs * cs);
    for (let c = 0; c < A.length; c++) { W[c] *= inv; A[c] *= inv; }
    // box blur twice (separable)
    const tmpA = new Float32Array(cx * cz), tmpW = new Float32Array(cx * cz);
    const R = BLEND_RADIUS, norm = 1 / (2 * R + 1);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < cz; j++) {
        let sa = 0, sw = 0;
        for (let i = -R; i <= R; i++) { const ii = clamp(i, 0, cx - 1); sa += A[j * cx + ii]; sw += W[j * cx + ii]; }
        for (let i = 0; i < cx; i++) {
          tmpA[j * cx + i] = sa * norm; tmpW[j * cx + i] = sw * norm;
          const a = clamp(i - R, 0, cx - 1), b = clamp(i + R + 1, 0, cx - 1);
          sa += A[j * cx + b] - A[j * cx + a]; sw += W[j * cx + b] - W[j * cx + a];
        }
      }
      for (let i = 0; i < cx; i++) {
        let sa = 0, sw = 0;
        for (let j = -R; j <= R; j++) { const jj = clamp(j, 0, cz - 1); sa += tmpA[jj * cx + i]; sw += tmpW[jj * cx + i]; }
        for (let j = 0; j < cz; j++) {
          A[j * cx + i] = sa * norm; W[j * cx + i] = sw * norm;
          const a = clamp(j - R, 0, cz - 1), b = clamp(j + R + 1, 0, cz - 1);
          sa += tmpA[b * cx + i] - tmpA[a * cx + i]; sw += tmpW[b * cx + i] - tmpW[a * cx + i];
        }
      }
    }
    for (let j = 0; j < this.nz; j++) {
      const fz = j / cs - 0.5, jz = clamp(Math.floor(fz), 0, cz - 2), tz = clamp(fz - jz, 0, 1);
      const row = j * this.nx;
      for (let i = 0; i < this.nx; i++) {
        const o = row + i;
        if ((band[o] !== B.NONE && band[o] !== B.BUILDING) || (k[o] & K.WATER)) continue;
        const fx = i / cs - 0.5, ix = clamp(Math.floor(fx), 0, cx - 2), tx = clamp(fx - ix, 0, 1);
        const c = jz * cx + ix;
        const w = (W[c] * (1 - tx) + W[c + 1] * tx) * (1 - tz) + (W[c + cx] * (1 - tx) + W[c + cx + 1] * tx) * tz;
        if (w < 0.004) continue;
        const a = (A[c] * (1 - tx) + A[c + 1] * tx) * (1 - tz) + (A[c + cx] * (1 - tx) + A[c + cx + 1] * tx) * tz;
        const f = clamp((w - 0.004) / 0.16, 0, 1);
        h[o] = t[o] + (a / w) * (f * f * (3 - 2 * f));
      }
    }
    A = W = new Float32Array(0);
  }

  /** Freeze the working heights into the compact query raster and drop the build arrays. */
  finish() {
    // step signs follow what each cell finally is (later fills can turn a sidewalk cell into road and back)
    const S = this.step, band = this.band, k = this.k;
    for (let o = 0; o < S.length; o++) {
      const v = S[o];
      if (v === STEP_FAR) continue;
      const b = band[o], m = Math.max(1, Math.abs(v)); // a cell right on the line still has a side
      if (b === B.ROAD) S[o] = -m;
      else if (b === B.FLAT) S[o] = m;
      else if (b === B.HOLE) S[o] = k[o] & K.WATER ? -m : m;
      else S[o] = STEP_FAR;
    }
    const h = this.h!;
    this.hq = new Int16Array(h.length);
    for (let o = 0; o < h.length; o++) this.hq[o] = Math.round(clamp(h[o], -300, 300) * 100);
    this.h = null;
    this.t = null;
  }
}

/** Terrain mesh on a 5 m grid sampled from the raster (dipped under bands, holes in the canal corridor). */
export function buildTerrainMesh(ras: GeoRaster, chunks: RenderChunks, phys: PhysChunks, cemetery: Pt[] | null, waterLevelAt: (x: number, z: number) => number) {
  const st = MESH_STEP;
  const nx = Math.floor((ras.nx - 1) / st) + 1, nz = Math.floor((ras.nz - 1) / st) + 1;
  const n = nx * nz;
  const vy = new Float32Array(n);
  const vb = new Uint8Array(n);
  const vc = new Int32Array(n);
  const hq = ras.hq;
  const at = (i: number, j: number) => j * st * ras.nx + i * st;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const o = at(i, j), v = j * nx + i;
      const b = ras.band[o];
      vb[v] = b;
      vy[v] = hq[o] * 0.01 - (b === B.ROAD || b === B.FLAT || b === B.BUILDING ? BAND_DIP : 0);
    }
  // A natural vertex next to a road / sidewalk vertex may not stand above that band's surface: in a cutting (the
  // Parkway under the Rock Creek banks) the 5 m triangle between them otherwise pokes up to 0.8 m through the
  // carriageway (a ridge cars hit). The bank then starts rising one mesh step further out.
  {
    const cap = new Float32Array(n).fill(Infinity);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const v = j * nx + i;
        if (vb[v] !== B.ROAD && vb[v] !== B.FLAT) continue;
        const top = hq[at(i, j)] * 0.01;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
            const u = jj * nx + ii;
            if (vb[u] === B.NONE && top < cap[u]) cap[u] = top;
          }
      }
    for (let v = 0; v < n; v++) if (vy[v] > cap[v]) vy[v] = cap[v];
  }
  // colours: park/cemetery/yard grass, earth on steep slopes, mud and sand near water
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i, o = at(i, j);
      const x = ras.x0 + i * st, z = ras.z0 + j * st;
      const gx = (vy[j * nx + Math.min(nx - 1, i + 1)] - vy[j * nx + Math.max(0, i - 1)]) / (2 * st);
      const gz = (vy[Math.min(nz - 1, j + 1) * nx + i] - vy[Math.max(0, j - 1) * nx + i]) / (2 * st);
      const slope = Math.sqrt(gx * gx + gz * gz);
      const kind = ras.k[o];
      let c = kind & K.PARK ? (cemetery && pointInPoly(x, z, cemetery) ? COL.cemetery : COL.park) : COL.yard;
      // two octaves of value noise (~40 m patches, ~13 m mottling): the old product of two sine waves read as a
      // regular checkerboard from the air. Fixed hash, so it never depends on the world seed.
      const noise = (valueNoise(x / 40, z / 40) * 0.65 + valueNoise(x / 13 + 17.3, z / 13 - 4.1) * 0.35) * 2 - 1;
      c = mixc(c, COL.grassDry, clamp(0.12 + noise * 0.22, 0, 0.4));
      if (slope > 0.35) c = mixc(c, COL.earth, clamp((slope - 0.35) * 2, 0, 0.8));
      const wl = waterLevelAt(x, z);
      const above = vy[v] - wl;
      if (above < 1.6) c = mixc(c, above < 0.4 ? COL.mud : COL.sand, clamp((1.6 - above) / 1.2, 0, 1));
      vc[v] = shade(c, 0.94 + 0.08 * noise);
    }
  const band = ras.band, kind = ras.k, rnx = ras.nx;
  // raster cells (local indices) inside the triangle that are natural ground (band NONE, not water)
  const coversNatural = (i0: number, j0: number, tri: number, flip: number) => {
    for (let dj = 0; dj <= st; dj++)
      for (let di = 0; di <= st; di++) {
        const u = di / st, v = dj / st;
        const inT = flip ? (tri === 0 ? u <= v : u >= v) : tri === 0 ? u + v <= 1 : u + v >= 1;
        if (!inT) continue;
        const ii = i0 * st + di, jj = j0 * st + dj;
        if (ii >= rnx || jj >= ras.nz) continue;
        const o = jj * rnx + ii;
        if (band[o] === B.NONE && !(kind[o] & K.WATER)) return true;
      }
    return false;
  };
  const keepTri = (a: number, b: number, c: number, i: number, j: number, tri: number, flip: number) => {
    const ba = vb[a], bb = vb[b], bc = vb[c];
    if (ba === B.HOLE || bb === B.HOLE || bc === B.HOLE) return false; // the canal corridor and its aprons cover this
    // deep under the river / canal / creek water (opaque water hides it)
    if (vy[a] < -0.9 && vy[b] < -0.9 && vy[c] < -0.9) return false;
    // fully under roads / sidewalks / buildings: hidden, unless it is the only ground over a strip of natural cells
    // (a gap narrower than the 5 m mesh between a sidewalk and a building, an alley): then keep it (dipped)
    const covered = (q: number) => q === B.ROAD || q === B.FLAT || q === B.BUILDING;
    if (covered(ba) && covered(bb) && covered(bc)) return coversNatural(i, j, tri, flip);
    return true;
  };
  const kept = new Uint8Array((nx - 1) * (nz - 1) * 2);
  let tris = 0;
  for (let j = 0; j + 1 < nz; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const v00 = j * nx + i, v10 = v00 + 1, v01 = v00 + nx, v11 = v01 + 1;
      const x0 = ras.x0 + i * st, z0 = ras.z0 + j * st, x1 = x0 + st, z1 = z0 + st;
      const mx = x0 + st / 2, mz = z0 + st / 2;
      const buf = chunks.buf('ground', mx, mz);
      const pb = phys.ground(mx, mz);
      // alternate the diagonal for a less regular look
      const flip = (i + j) & 1;
      const T = flip ? [[v00, v01, v11, x0, z0, x0, z1, x1, z1], [v00, v11, v10, x0, z0, x1, z1, x1, z0]] : [[v00, v01, v10, x0, z0, x0, z1, x1, z0], [v10, v01, v11, x1, z0, x0, z1, x1, z1]];
      for (let t = 0; t < 2; t++) {
        const [a, b, c, ax, az, bx, bz, cx, cz] = T[t];
        if (!keepTri(a, b, c, i, j, t, flip)) continue;
        kept[(j * (nx - 1) + i) * 2 + t] = 1;
        emitSmooth(buf, ax, vy[a], az, bx, vy[b], bz, cx, vy[c], cz, vc[a], vc[b], vc[c], nx, vy, st, ras.x0, ras.z0);
        pb.tri(ax, vy[a], az, bx, vy[b], bz, cx, vy[c], cz);
        tris++;
      }
    }
  // Bake: natural cells take the height of the terrain triangle over them, so heightAt agrees with what is drawn and
  // collided (the mesh is 5 m and dips under road bands; the 1 m raster alone sits up to 0.3 m above it). Cells with
  // no terrain triangle (beside the canal corridor) are marked for the canal aprons (bakeAprons).
  const meshed = new Uint8Array(ras.nx * ras.nz);
  for (let j = 0; j + 1 < nz; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const q = (j * (nx - 1) + i) * 2, k0 = kept[q], k1 = kept[q + 1];
      if (!k0 && !k1) continue;
      const flip = (i + j) & 1;
      const v00 = j * nx + i, y00 = vy[v00], y10 = vy[v00 + 1], y01 = vy[v00 + nx], y11 = vy[v00 + nx + 1];
      for (let dj = 0; dj < st; dj++) {
        const jj = j * st + dj;
        if (jj >= ras.nz) break;
        const v = dj / st;
        for (let di = 0; di < st; di++) {
          const ii = i * st + di;
          if (ii >= rnx) break;
          const o = jj * rnx + ii;
          if (band[o] !== B.NONE || (kind[o] & K.WATER)) continue;
          const u = di / st;
          const t = flip ? (u <= v ? 0 : 1) : u + v <= 1 ? 0 : 1;
          if (!(t === 0 ? k0 : k1)) continue;
          meshed[o] = 1;
          let y: number;
          if (flip) y = t === 0 ? y00 + (y11 - y01) * u + (y01 - y00) * v : y00 + (y10 - y00) * u + (y11 - y10) * v;
          else y = t === 0 ? y00 + (y10 - y00) * u + (y01 - y00) * v : y11 + (y11 - y01) * (u - 1) + (y11 - y10) * (v - 1);
          hq[o] = Math.round(clamp(y, -300, 300) * 100);
        }
      }
    }
  ras.meshed = meshed;
  return tris;
}

/** Smooth 2D value noise in 0..1 on a unit lattice (deterministic integer hash). */
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = latticeHash(ix, iz), b = latticeHash(ix + 1, iz), c = latticeHash(ix, iz + 1), d = latticeHash(ix + 1, iz + 1);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sz;
}
function latticeHash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Terrain triangle with per-vertex smooth normals from the height grid. */
function emitSmooth(buf: import('./meshKit').MeshBuf, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, ca: number, cb: number, cc: number, nx: number, vy: Float32Array, st: number, x0: number, z0: number) {
  // orient up
  const ux = bx - ax, uz = bz - az, wx = cx - ax, wz = cz - az;
  const up = uz * wx - ux * wz; // y of cross((b-a),(c-a)) with y components ignored for orientation
  const nrm = (x: number, z: number) => {
    const i = Math.round((x - x0) / st), j = Math.round((z - z0) / st);
    const nzc = vy.length / nx;
    const l = vy[j * nx + Math.max(0, i - 1)], r = vy[j * nx + Math.min(nx - 1, i + 1)];
    const d = vy[Math.max(0, j - 1) * nx + i], u = vy[Math.min(nzc - 1, j + 1) * nx + i];
    let gx = (r - l) / (2 * st), gz = (u - d) / (2 * st);
    // cap so dips under roads don't make wild normals
    gx = clamp(gx, -1.2, 1.2); gz = clamp(gz, -1.2, 1.2);
    const L = Math.sqrt(gx * gx + 1 + gz * gz);
    N[0] = -gx / L; N[1] = 1 / L; N[2] = -gz / L;
  };
  const N = [0, 1, 0];
  const emit = (x: number, y: number, z: number, c: number) => { nrm(x, z); buf.vert(x, y, z, N[0], N[1], N[2], c); };
  if (up > 0) { emit(ax, ay, az, ca); emit(bx, by, bz, cb); emit(cx, cy, cz, cc); }
  else { emit(ax, ay, az, ca); emit(cx, cy, cz, cc); emit(bx, by, bz, cb); }
}

/**
 * After the canal aprons are drawn (APRON_DROP below the raster where no terrain triangle covers the ground): natural
 * cells without a terrain triangle take the apron height, so heightAt matches the apron collider there.
 */
export function bakeAprons(ras: GeoRaster, drop: number) {
  const m = ras.meshed;
  if (!m) return;
  const band = ras.band, k = ras.k, hq = ras.hq, d = Math.round(drop * 100);
  for (let o = 0; o < m.length; o++) if (!m[o] && band[o] === B.NONE && !(k[o] & K.WATER)) hq[o] -= d;
  ras.meshed = null;
}

/** A coarse apron of land beyond the map edges so the world doesn't end in a cliff (no physics). */
export function buildOuterLand(ras: GeoRaster, chunks: RenderChunks, bounds: { x0: number; z0: number; x1: number; z1: number }, riverZ: (x: number) => number) {
  const ext = 700, st = 40;
  const X0 = bounds.x0 - ext, X1 = bounds.x1 + ext, Z0 = bounds.z0 - ext, Z1 = bounds.z1 + ext;
  const nx = Math.round((X1 - X0) / st), nz = Math.round((Z1 - Z0) / st);
  const cx0 = (bounds.x0 + bounds.x1) / 2, cz0 = (bounds.z0 + bounds.z1) / 2, hx = (bounds.x1 - bounds.x0) / 2, hz = (bounds.z1 - bounds.z0) / 2;
  const inside = (x: number, z: number) => x > bounds.x0 + 2 && x < bounds.x1 - 2 && z > bounds.z0 + 2 && z < bounds.z1 - 2;
  const vtx = (x: number, z: number): [number, number] => {
    const cxp = clamp(x, bounds.x0, bounds.x1), czp = clamp(z, bounds.z0, bounds.z1);
    const d = Math.max(Math.abs(x - cxp), Math.abs(z - czp));
    let y = ras.heightAt(cxp, czp) + Math.sin(x * 0.01) * Math.cos(z * 0.013) * Math.min(1, d / 300) * 8;
    if (z > bounds.z1 - 5 && z > riverZ(cxp) - 5) y = -3; // the river continues south of the map
    if (inside(x, z)) y -= 3;
    const far = clamp(Math.max(Math.abs(x - cx0) - hx, Math.abs(z - cz0) - hz, 0) / 500, 0, 1);
    const n = 0.92 + 0.08 * Math.sin(x * 0.013 + 1.3) * Math.cos(z * 0.017 - 0.4);
    return [y, shade(mixc(COL.outer, COL.outerFar, far), n)];
  };
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x0 = X0 + i * st, z0 = Z0 + j * st, x1 = x0 + st, z1 = z0 + st;
      if (inside(x0, z0) && inside(x1, z1) && inside(x0, z1) && inside(x1, z0)) continue;
      const buf = chunks.buf('ground', clamp(x0 + st / 2, bounds.x0 - 300, bounds.x1 + 300), clamp(z0 + st / 2, bounds.z0 - 300, bounds.z1 + 300));
      const a = vtx(x0, z0), b = vtx(x1, z0), c = vtx(x1, z1), d = vtx(x0, z1);
      // per-vertex colours (smooth gradients, no checkerboard), normals straight up (it is far away)
      buf.vert(x0, a[0], z0, 0, 1, 0, a[1]); buf.vert(x0, d[0], z1, 0, 1, 0, d[1]); buf.vert(x1, c[0], z1, 0, 1, 0, c[1]);
      buf.vert(x0, a[0], z0, 0, 1, 0, a[1]); buf.vert(x1, c[0], z1, 0, 1, 0, c[1]); buf.vert(x1, b[0], z0, 0, 1, 0, b[1]);
    }
}
