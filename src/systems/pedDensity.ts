// Pedestrian density from the map. Every link of the walk graph gets a busyness score: people per metre from the
// road beside it (sidewalks) or its path kind (towpath, park path, waterfront, plaza), plus the shops, cafes,
// restaurants and bars within TUNING.peds.density.shopRadius, each term following its own day curve (lunch rush
// on shopping streets, evenings at the waterfront, quiet residential nights). Around the player the links in
// range add up to a real-world head count, which is scaled to the quality preset's pedestrian budget.
// pedestrians.ts adds and removes people out of view to follow that target, at spawn points weighted by the
// same scores (dog walkers and joggers weighted towards the towpath and the waterfront).
// Built once per map; every per-frame query is allocation-free.
import { TUNING } from '../tuning';
import type { World } from '../world';
import type { LaneHit, RoadClass, WalkKind } from './map/cityMap';

const D = TUNING.peds.density;
/** Day curves, by zone id. */
const ZONES = ['shops', 'homes', 'waterfront', 'outdoor'] as const;
const Z_SHOPS = 0, Z_HOMES = 1, Z_WATER = 2, Z_OUT = 3;
const CELL = 32; // metres per cell of the link grid (lookup speed only)

export interface PedDensityState {
  n: number; // walk links
  ax: Float32Array; az: Float32Array; bx: Float32Array; bz: Float32Array; ly: Float32Array; // ends, mean height
  len: Float32Array;
  base: Float32Array; // people per metre at the peak of the link's zone curve
  shop: Float32Array; // people per metre from the shops nearby, at the peak of the 'shops' curve
  shops: Uint8Array; // shops within shopRadius (counted, before the cap)
  zone: Uint8Array;
  /** 1: people may appear on this link; 0: a crossing (it lies in the carriageway: people cross it, never appear on it). */
  spawnable: Uint8Array;
  outdoor: Float32Array; // spawn weight factor for dog walkers and joggers
  /** Per walk node: route cost factor for dog walkers and joggers (towpath, waterfront, park paths are cheaper). */
  routeCost: Float32Array;
  /** Walk nodes on the towpath / waterfront / park paths (trip targets for dog walkers and joggers). */
  outdoorNodes: Int32Array;
  // link grid (by midpoint)
  minX: number; minZ: number; cols: number; rows: number; start: Int32Array; items: Int32Array;
  // spawn candidates from the last update (links in range, out of view), with cumulative weights
  cand: Int32Array; cumAll: Float32Array; cumOut: Float32Array; nCand: number;
  curve: Float32Array; // this hour's factor per zone
  timer: number;
  // results (F3 overlay, tests)
  hour: number;
  real: number; // real-world head count around the player
  target: number; // scaled to the budget: what pedestrians.ts aims for
  active: number; // people active right now (set by pedestrians.ts)
  near: number; // active people within `radius` of the player
  added: number; removed: number; relocated: number; // totals since load
}

/** Factor of a day curve (24 hourly values) at `hour`, linear in between. */
function curveAt(c: readonly number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h), t = h - i;
  return c[i] + (c[(i + 1) % 24] - c[i]) * t;
}

const HIT: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };

export function createPedDensity(w: World): PedDensityState {
  const c = w.city, W = c.walk.nodes;
  const B = D.base as Record<string, number>;
  // ---- links (each undirected walk link once) ----
  let n = 0;
  for (const a of W) for (const j of a.nbrs) if (j > a.id) n++;
  const ax = new Float32Array(n), az = new Float32Array(n), bx = new Float32Array(n), bz = new Float32Array(n), ly = new Float32Array(n);
  const len = new Float32Array(n), base = new Float32Array(n), shop = new Float32Array(n), zone = new Uint8Array(n), outdoor = new Float32Array(n);
  const shops = new Uint8Array(n), spawnable = new Uint8Array(n);
  // shops in a coarse grid for the radius counts
  const SC = Math.max(8, D.shopRadius);
  const shopKinds = new Set<string>(D.shopKinds);
  const shopGrid = new Map<number, number[]>();
  const key = (ix: number, iz: number) => ix * 65536 + iz;
  for (const p of c.pois) {
    if (!shopKinds.has(p.kind)) continue;
    const k = key(Math.floor(p.x / SC), Math.floor(p.z / SC));
    let list = shopGrid.get(k);
    if (!list) shopGrid.set(k, (list = []));
    list.push(p.x, p.z);
  }
  const countShops = (x: number, z: number) => {
    const ix = Math.floor(x / SC), iz = Math.floor(z / SC);
    let k = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = shopGrid.get(key(ix + dx, iz + dz));
      if (!list) continue;
      for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - z) <= D.shopRadius) k++;
    }
    return k;
  };
  const linkKind = (a: WalkKind, b: WalkKind): WalkKind => (a === b ? a : a === 'crossing' || b === 'crossing' ? 'crossing' : a === 'sidewalk' ? b : a);
  const OB = D.outdoorBoost as Record<string, number>;
  let i = 0;
  for (const a of W) for (const j of a.nbrs) {
    if (j <= a.id) continue;
    const b = W[j];
    ax[i] = a.x; az[i] = a.z; bx[i] = b.x; bz[i] = b.z; ly[i] = (a.y + b.y) / 2;
    len[i] = Math.hypot(b.x - a.x, b.z - a.z);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const kind = linkKind(a.kind, b.kind);
    const k = countShops(mx, mz);
    shops[i] = Math.min(255, k);
    let shopTerm = D.perShop * Math.min(k, D.shopCap);
    if (kind === 'sidewalk' || kind === 'crossing') {
      let cls: RoadClass = 'residential';
      if (c.nearestLane(mx, mz, D.roadSearch, HIT, ly[i])) cls = c.roads.edges[HIT.edge].cls;
      base[i] = kind === 'crossing' ? B.crossing : B[cls];
      zone[i] = Z_HOMES;
      if (kind === 'crossing') shopTerm *= D.crossingShopShare;
    } else if (kind === 'towpath' || kind === 'path') {
      base[i] = B[kind];
      zone[i] = Z_OUT;
    } else {
      base[i] = B[kind] ?? B.plaza; // waterfront, plaza
      zone[i] = Z_WATER;
    }
    shop[i] = shopTerm;
    spawnable[i] = kind === 'crossing' ? 0 : 1;
    outdoor[i] = OB[kind] ?? 1;
    i++;
  }
  // ---- route costs and trip targets for dog walkers and joggers ----
  const routeCost = new Float32Array(W.length).fill(1);
  const out: number[] = [];
  for (const nd of W) {
    if (nd.kind === 'towpath' || nd.kind === 'waterfront' || nd.kind === 'path') {
      routeCost[nd.id] = D.outdoorRouteCost;
      if (nd.kind !== 'path') out.push(nd.id);
    }
  }
  // ---- link grid by midpoint ----
  const bnd = c.bounds;
  const minX = bnd.minX - 50, minZ = bnd.minZ - 50;
  const cols = Math.max(1, Math.ceil((bnd.maxX - bnd.minX + 100) / CELL)), rows = Math.max(1, Math.ceil((bnd.maxZ - bnd.minZ + 100) / CELL));
  const cellOf = (x: number, z: number) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / CELL))), cz = Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / CELL)));
    return cz * cols + cx;
  };
  const start = new Int32Array(cols * rows + 1);
  for (let k = 0; k < n; k++) start[cellOf((ax[k] + bx[k]) / 2, (az[k] + bz[k]) / 2) + 1]++;
  for (let k = 0; k < cols * rows; k++) start[k + 1] += start[k];
  const fill = start.slice(0, cols * rows);
  const items = new Int32Array(n);
  for (let k = 0; k < n; k++) items[fill[cellOf((ax[k] + bx[k]) / 2, (az[k] + bz[k]) / 2)]++] = k;

  return {
    n, ax, az, bx, bz, ly, len, base, shop, shops, zone, spawnable, outdoor, routeCost, outdoorNodes: Int32Array.from(out),
    minX, minZ, cols, rows, start, items,
    cand: new Int32Array(n), cumAll: new Float32Array(n), cumOut: new Float32Array(n), nCand: 0,
    curve: new Float32Array(ZONES.length), timer: 0,
    hour: 0, real: 0, target: 0, active: 0, near: 0, added: 0, removed: 0, relocated: 0,
  };
}

/** Is (x, z) in front of the camera (roughly inside the view, up to 260 m)? People never pop in or out there. */
export function inCameraView(w: World, x: number, z: number): boolean {
  const cam = w.camera, e = cam.matrixWorld.elements;
  // camera looks down its local -Z: forward = -(column 2)
  const fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1;
  const dx = x - cam.position.x, dz = z - cam.position.z, d = Math.hypot(dx, dz) || 1;
  return (dx * fx + dz * fz) / (d * fl) > 0.35 && d < 260;
}

/** People per metre on link k at the current hour (call after updatePedDensity has set the curve). */
function rho(S: PedDensityState, k: number): number {
  return S.base[k] * S.curve[S.zone[k]] + S.shop[k] * S.curve[Z_SHOPS];
}

/**
 * Recompute the target around the player (every TUNING.peds.density.updateInterval seconds): the real head count on
 * the walk links within `radius`, scaled to the budget, and the weighted spawn candidates (links in range, at least
 * spawnMinDist away and out of view). `force` recomputes now (teleports, tests).
 */
export function updatePedDensity(w: World, dt: number, force = false): void {
  const S = w.pedDensity;
  S.timer -= dt;
  if (S.timer > 0 && !force) return;
  S.timer = D.updateInterval;
  const hour = w.dayNight.hour;
  S.hour = hour;
  const H = D.hours;
  S.curve[Z_SHOPS] = curveAt(H.shops, hour);
  S.curve[Z_HOMES] = curveAt(H.homes, hour);
  S.curve[Z_WATER] = curveAt(H.waterfront, hour);
  S.curve[Z_OUT] = curveAt(H.outdoor, hour);
  const pp = w.player.mesh.position;
  const R = D.radius, R2 = R * R, m2 = D.spawnMinDist * D.spawnMinDist;
  const c0 = Math.max(0, Math.floor((pp.x - R - S.minX) / CELL)), c1 = Math.min(S.cols - 1, Math.floor((pp.x + R - S.minX) / CELL));
  const r0 = Math.max(0, Math.floor((pp.z - R - S.minZ) / CELL)), r1 = Math.min(S.rows - 1, Math.floor((pp.z + R - S.minZ) / CELL));
  let real = 0, nc = 0, cumA = 0, cumO = 0;
  for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
    const ci = r * S.cols + cc;
    for (let q = S.start[ci]; q < S.start[ci + 1]; q++) {
      const k = S.items[q];
      const mx = (S.ax[k] + S.bx[k]) * 0.5, mz = (S.az[k] + S.bz[k]) * 0.5;
      const d2 = (mx - pp.x) * (mx - pp.x) + (mz - pp.z) * (mz - pp.z);
      if (d2 > R2) continue;
      const people = rho(S, k) * S.len[k];
      real += people;
      if (!S.spawnable[k] || d2 < m2 || (w.started && inCameraView(w, mx, mz))) continue;
      cumA += people;
      cumO += people * S.outdoor[k];
      S.cand[nc] = k;
      S.cumAll[nc] = cumA;
      S.cumOut[nc] = cumO;
      nc++;
    }
  }
  S.nCand = nc;
  S.real = real;
  const budget = w.settings.pedBudget;
  const full = D.fullBudgetAt[w.city.id] ?? D.fullBudgetAt.georgetown;
  S.target = Math.min(budget, Math.max(Math.min(D.minActive, budget), Math.round((real * budget) / full)));
}

/**
 * A spawn point for one person: a random point on a candidate link (never a crossing), picked by the links' head
 * counts (dog walkers and joggers: `outdoor`, weighted towards the towpath and the waterfront), and the link's
 * direction. Re-checks the view. Returns false if nothing in range qualifies (the caller keeps the person where they are).
 */
export function pickSpawn(w: World, outdoor: boolean, out: { x: number; y: number; z: number; dx: number; dz: number }): boolean {
  const S = w.pedDensity;
  if (!S.nCand) return false;
  const cum = outdoor ? S.cumOut : S.cumAll;
  const total = cum[S.nCand - 1];
  if (!(total > 0)) return false;
  for (let tries = 0; tries < 6; tries++) {
    const r = Math.random() * total;
    let lo = 0, hi = S.nCand - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const k = S.cand[lo];
    const t = 0.1 + Math.random() * 0.8;
    const x = S.ax[k] + (S.bx[k] - S.ax[k]) * t, z = S.az[k] + (S.bz[k] - S.az[k]) * t;
    if (w.started && inCameraView(w, x, z)) continue;
    out.x = x;
    out.y = S.ly[k];
    out.z = z;
    // the link's direction: a kid or a dog is placed along the pavement, not across it into the road or a wall
    const l = S.len[k] || 1;
    out.dx = (S.bx[k] - S.ax[k]) / l;
    out.dz = (S.bz[k] - S.az[k]) / l;
    return true;
  }
  return false;
}

/** People per metre on the walk links within `r` of (x, z) right now, and the shops counted there (tests, F3). */
export function densityAround(w: World, x: number, z: number, r: number): { perMetre: number; metres: number; people: number; shops: number } {
  const S = w.pedDensity;
  let metres = 0, people = 0, shops = 0;
  for (let k = 0; k < S.n; k++) {
    const mx = (S.ax[k] + S.bx[k]) * 0.5, mz = (S.az[k] + S.bz[k]) * 0.5;
    if (Math.hypot(mx - x, mz - z) > r) continue;
    metres += S.len[k];
    people += rho(S, k) * S.len[k];
    shops = Math.max(shops, S.shops[k]);
  }
  return { perMetre: metres ? people / metres : 0, metres, people, shops };
}
