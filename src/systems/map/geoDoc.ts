// Types for the Georgetown map data (src/data/georgetown.json, format "open-city-osm-1": see scripts/importOsm.mjs
// and scripts/georgetownFromSpec.mjs) plus small 2D geometry helpers shared by the world generator v2 files.
// Frame: metres, x east, z SOUTH, y up, origin at the crop centre.

export type Pt = [number, number];

export interface GeoRoad {
  id: string;
  name: string | null;
  highway: string;
  lanes: number | null;
  oneway: number; // 1 = along pts, -1 = against pts, 0 = two-way
  bridge: number;
  tunnel: number;
  layer: number;
  junction: string | null;
  maxspeed: number | null;
  /** Kerb-to-kerb width (m); imported data carries an estimate (est: 1) or the mapped width. */
  width?: number;
  est?: number;
  service?: string;
  access?: string;
  sidewalk?: string;
  surface?: string;
  pts: Pt[];
}
export interface GeoFootway {
  id: string;
  kind: string; // sidewalk | crossing | footway | steps | path | cycleway | pedestrian
  name: string | null;
  pts: Pt[];
  holes?: Pt[][];
  area?: number;
  bridge?: number;
  layer?: number;
  surface?: string;
  towpath?: number;
  pier?: number;
}
export interface GeoBuilding {
  id: string;
  h: number;
  type: string;
  levels: number;
  /** height from neighbours or a class default, not the data */
  est?: number;
  /** underside height (m) for buildings over a passage */
  minH?: number;
  roof?: string;
  pts: Pt[];
  holes?: Pt[][];
}
export interface GeoPoi {
  id: string;
  x: number;
  z: number;
  cat: string;
  subcat?: string;
  b?: string;
}
export interface GeoArea {
  id: string;
  kind: string;
  name: string | null;
  pts: Pt[];
  holes?: Pt[][];
  /** Water level (m) per vertex of a waterway line (imported: Rock Creek). */
  levels?: number[];
}
export interface GeoParking {
  id: string;
  type: string;
  capacity: number;
  access?: string;
  pts: Pt[];
}
export interface GeoHeights {
  spacing: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  data: number[];
}
/** [x, z, kind] from the data, or [x, z, kind, 1] when synthesized by the importer. */
export type GeoProp = [number, number, string] | [number, number, string, number];

export interface GeoDoc {
  meta: {
    synthetic?: boolean;
    attribution: string;
    bounds: { x0: number; z0: number; x1: number; z1: number };
    origin: { lat: number; lon: number };
    metresPerDegree: { lat: number; lon: number };
    /** Real data: places and CC BY 4.0 building footprints ship in their own files (own licences), see loadGeoDoc. */
    companions?: { pois: string; buildings: string };
  };
  roads: GeoRoad[];
  footways: GeoFootway[];
  buildings: GeoBuilding[];
  pois: GeoPoi[];
  water: GeoArea[];
  waterways: GeoArea[];
  parks: GeoArea[];
  parking: GeoParking[];
  bridges: { id: string; src: string; name: string | null; layer: number; pts: Pt[] }[];
  landmarks: { canal?: { waterways: string[]; water: string[]; levels?: number[]; locks?: { name: string; x: number; z: number; length: number }[] }; towpath?: string[] } | null;
  props: GeoProp[];
  heights: GeoHeights;
}

/**
 * Fetch the Georgetown map data: src/data/georgetown.json and, for real data, its companion files (licensed apart from
 * the ODbL main file): the places (CDLA-Permissive-2.0) become `pois`, and the Esri Community Maps footprints
 * (CC BY 4.0) join `buildings`. The knowledge-based map (npm run gen-georgetown) is one file with no companions.
 */
export async function loadGeoDoc(): Promise<GeoDoc> {
  const get = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Georgetown map data: HTTP ${res.status} for ${url}`);
    return res.json();
  };
  const doc = (await get(new URL('../../data/georgetown.json', import.meta.url).href)) as GeoDoc;
  if (doc.meta.companions) {
    // (static URLs so the build bundles them; the names match meta.companions written by scripts/importOverture.mjs)
    const [places, ccby] = await Promise.all([
      get(new URL('../../data/georgetown-places.json', import.meta.url).href) as Promise<{ pois: GeoPoi[] }>,
      get(new URL('../../data/georgetown-buildings-ccby.json', import.meta.url).href) as Promise<{ buildings: GeoBuilding[] }>,
    ]);
    doc.pois = places.pois;
    doc.buildings = doc.buildings.concat(ccby.buildings);
  }
  return doc;
}

// ------------------------------------------------------------------------------------------- helpers

/** lat/lon (WGS84) to map metres, using the document's own equirectangular frame. */
export function project(doc: GeoDoc, lat: number, lon: number): Pt {
  const m = doc.meta;
  return [(lon - m.origin.lon) * m.metresPerDegree.lon, -(lat - m.origin.lat) * m.metresPerDegree.lat];
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Small deterministic random stream (mulberry32) seeded from a number. */
export function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pointInPoly(x: number, z: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

export function centroid(pts: Pt[]): Pt {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}

/** Distance from (px,pz) to segment a-b, and the parameter t (0..1) of the closest point. */
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return { d: Math.sqrt(qx * qx + qz * qz), t };
}

export function polyLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Resample a polyline so no segment is longer than `step` (keeps every original vertex). */
export function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Offset a polyline sideways by d (positive = right of travel, i.e. +z for an eastward line), mitred joins. */
export function offsetLine(pts: Pt[], d: number, maxMiter = 3): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx: number, tz: number;
    if (i === 0 || i === n - 1) {
      tx = b[0] - a[0]; tz = b[1] - a[1];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      out.push([p[0] - tz * d, p[1] + tx * d]);
      continue;
    }
    let ux = p[0] - a[0], uz = p[1] - a[1];
    let vx = b[0] - p[0], vz = b[1] - p[1];
    const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
    ux /= lu; uz /= lu; vx /= lv; vz /= lv;
    tx = ux + vx; tz = uz + vz;
    const L = Math.hypot(tx, tz);
    if (L < 1e-6) { tx = ux; tz = uz; } else { tx /= L; tz /= L; }
    // miter scale: 1 / cos(half angle) = 1 / dot(normal_u, normal_t)
    const c = Math.max(1 / maxMiter, tx * ux + tz * uz);
    out.push([p[0] - (tz * d) / c, p[1] + (tx * d) / c]);
  }
  return out;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth01 = (t: number) => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };

/**
 * Uniform grid of line segments for neighbourhood queries (build once, query many). Each segment carries an integer
 * payload. Queries do not allocate.
 */
export class SegGrid {
  readonly cell: number;
  private cells = new Map<number, number[]>();
  /** ax, az, bx, bz, payload per segment */
  segs: number[] = [];
  constructor(cell: number) {
    this.cell = cell;
  }
  private k(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096);
  }
  add(ax: number, az: number, bx: number, bz: number, payload: number, pad = 0) {
    const id = this.segs.length / 5;
    this.segs.push(ax, az, bx, bz, payload);
    const c = this.cell;
    const i0 = Math.floor((Math.min(ax, bx) - pad) / c), i1 = Math.floor((Math.max(ax, bx) + pad) / c);
    const j0 = Math.floor((Math.min(az, bz) - pad) / c), j1 = Math.floor((Math.max(az, bz) + pad) / c);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = this.k(i, j);
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push(id);
      }
  }
  addLine(pts: Pt[], payload: number, pad = 0) {
    for (let i = 1; i < pts.length; i++) this.add(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], payload, pad);
  }
  /** Calls cb(segIndex, payload, distance, t) for segments in the point's cell (pad them by the query radius). */
  query(x: number, z: number, cb: (seg: number, payload: number, d: number, t: number) => void) {
    const l = this.cells.get(this.k(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!l) return;
    const S = this.segs;
    for (let q = 0; q < l.length; q++) {
      const s = l[q] * 5;
      const ax = S[s], az = S[s + 1], dx = S[s + 2] - ax, dz = S[s + 3] - az;
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      cb(l[q], S[s + 4], Math.sqrt(qx * qx + qz * qz), t);
    }
  }
}
