// CityMap: the one interface every system uses to read the city. Systems never look at how a map was made
// (procedural grid, OpenStreetMap import); they use the road graph, the walk graph, the lookups and the lists below.
//
// ---------------------------------------------------------------------------------------------------------------
// CONTRACT FOR MAP IMPLEMENTERS (read this before writing a new map, e.g. src/systems/map/georgetownMap.ts)
// ---------------------------------------------------------------------------------------------------------------
// Frame: x east, z SOUTH, y up, metres. Heading/yaw h: forward = (sin h, 0, cos h), so 0 = south (+z), PI/2 = east,
// -PI/2 = west, PI = north. Traffic drives on the RIGHT; the right-hand side of heading h is (-cos h, 0, sin h).
//
// Road graph (roads.nodes / roads.edges):
//  - A RoadNode is a junction, a dead end, a roundabout entry/exit, or a point where a road changes attributes
//    (pass-through). `out`/`in` hold LANE EDGE ids. Ids are array indices.
//  - A LaneEdge is ONE lane in ONE direction between two nodes. A two-way road with 2 lanes each way between nodes A
//    and B gives 4 edges (A->B lane 0 and 1, B->A lane 0 and 1). `pts` run along that lane's centre line from `from`
//    to `to` over the whole segment (node centre to node centre, offset sideways to the lane), as x,y,z triples
//    (y = road surface height, e.g. on Key Bridge). `cum[k]` is the length up to point k; `len` = cum[last].
//  - trimStart / trimEnd: metres of `pts` that lie inside the junction box at each end. Cars stop at
//    `len - trimEnd` (the stop line) and join the next lane at its `trimStart`; traffic builds the turn curve between
//    those two points. Use 0 at a pass-through node (lanes continue seamlessly) and something like
//    "half width of the widest crossing road + a few metres" at a real junction.
//  - junction: cars stop / yield at this node (3+ road segments meet, a corner between two streets, signals).
//    false: traffic flows straight through (shape or attribute split, bend in the same street).
//  - roundabout: the node is on a roundabout ring (Washington Circle). Edges on the ring have roundabout=true;
//    traffic yields when entering the ring and never stops on it.
//  - deadEnd: only one road segment touches the node; traffic U-turns onto the edge's `twin` (or any out edge).
//  - lane: 0 = kerbside (rightmost). lanesSameDir: lanes in this direction on this segment. offset: the lane
//    centre's distance to the RIGHT of the road centre line (the OSM way line); the kerb on this side is at
//    +halfWidth. For a two-way road with one lane each way: offset ~ +3 m, halfWidth ~ 7 m. For a one-way road the
//    lanes spread over the whole width (offsets can be negative for the left lanes).
//  - twin: the opposite-direction edge on the same segment with the same lane index (or the closest one), -1 if
//    one-way. bridge: the lane is on a bridge (its pts carry the deck height).
//  - parking: cars are parked along this lane's kerb (its ParkingSpots carry `edge` = this lane). On a road with two
//    or more lanes each way the kerbside lane IS the parking lane: traffic keeps out of it when another lane goes the
//    same way (RoadRouter also avoids it). On a narrow two-way street with parking on one kerb, the lane pts are
//    already shifted away from the parked cars (so they need not sit on the painted lane line).
//  - speed: cruise m/s from maxspeed, else TUNING.map.classSpeed[cls]. cls: OSM highway class mapped to RoadClass.
//  - Every edge must appear in nodes[from].out and nodes[to].in. validateCityMap() checks all of this.
//
// Walk graph (walk.nodes): undirected; nbrs are symmetric. Sidewalks along both kerbs, crossings at junctions,
//  park paths, plazas, the canal towpath and the waterfront promenade. Must be (nearly) one connected component.
//
// Parking (parkingSpots): kerbside spots stand in the parking lane (edge = that lane, s = distance along it) with the
//  car's centre TUNING.map.parkingBand / 2 from the kerb and heading = the lane's direction; lot stalls have
//  edge = -1 and lot = the car park's index. y = the surface the car stands on (spawnVehicle uses it).
//
// POIs: x,z = the spot on the pavement in front of the door; door = building entrance; curbX/curbZ = the stopping
//  point in the road at the kerb (taxi drop-off), kerbHeading = the heading of a car stopped there (traffic direction
//  of that kerbside lane); walkNode = nearest walk node; street = the street the door faces.
//
// Lookups must be cheap (spatial hashes, see MapIndex below) and allocation-free: systems call them every frame.
//  heightAt(x,z): ground height (terrain; 0 everywhere on the grid). isRoad: inside a carriageway. isWater: river,
//  canal, bay (NOT piers or bridge decks). waterLevelAt: that water's surface (the C&O canal sits metres above the
//  river; one waterLevel is not enough). isBlocked: inside a building, outside the playable bounds, or water.
//  nearestLane / kerbPoint fill a caller-owned result object and return false when nothing is within range.
//
// LEVELS (a bridge or an elevated road over another road, a towpath under a bridge): several surfaces can share one
//  (x, z). Callers that know their own height pass it as the optional `y`:
//  - heightAt(x, z, y): the surface something at height y stands on: the highest deck (bridge, elevated road, its
//    pavements) under (x, z) whose top is at most TUNING.map.levelStep above y, else the terrain. Without y: the
//    terrain. The grid has no decks and ignores y.
//  - nearestLane / kerbPoint / nearestWalk(…, y): prefer lanes / walk nodes within TUNING.map.levelTolerance of y
//    (the deck you are on, not the road under it); if none is in range, any level. Without y (or NaN): any level.
//  Deck surfaces must match the lane pts / walk node y on them, and need their own physics colliders.
//
// Coordinates of everything (spawn, parking, POIs) are on the ground: systems add heightAt(x,z) themselves when they
// place things, so a map only has to get heightAt right.
// ---------------------------------------------------------------------------------------------------------------
import type * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { SolidRecorder, SolidTags } from '../objects/solidKinds';

const M = TUNING.map;

export type RoadClass = 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service' | 'parkway';
export const ROAD_CLASSES: readonly RoadClass[] = ['primary', 'secondary', 'tertiary', 'residential', 'service', 'parkway'];

export interface RoadNode {
  id: number;
  x: number;
  y: number;
  z: number;
  out: number[]; // lane edge ids leaving this node
  in: number[]; // lane edge ids arriving at this node
  roundabout: boolean;
  signals: boolean;
  deadEnd: boolean;
  /** Cars stop or yield here (see the contract above). false = pass-through. */
  junction: boolean;
}

export interface LaneEdge {
  id: number;
  from: number; // node ids, direction of travel
  to: number;
  pts: Float32Array; // x,y,z triples along THIS lane's centre, node to node
  cum: Float32Array; // cumulative length at each point
  len: number;
  /** Metres at the start inside the junction box at `from` (cars join the lane here). */
  trimStart: number;
  /** Metres at the end inside the junction box at `to` (the stop line is at len - trimEnd). */
  trimEnd: number;
  speed: number; // m/s cruise
  cls: RoadClass;
  name: string | null;
  roadId: string;
  lane: number; // 0 = kerbside
  lanesSameDir: number;
  /** Lane centre's distance to the right of the road centre line (m). */
  offset: number;
  oneway: boolean;
  roundabout: boolean;
  bridge: boolean;
  halfWidth: number; // kerb-to-kerb half width of the whole road
  twin: number; // opposite-direction edge on the same segment, -1 if one-way
  /** Cars park along this lane's kerb (see the contract): traffic avoids it when another lane goes the same way. */
  parking: boolean;
}

export type WalkKind = 'sidewalk' | 'path' | 'towpath' | 'waterfront' | 'crossing' | 'plaza';

export interface WalkNode {
  id: number;
  x: number;
  y: number;
  z: number;
  nbrs: number[];
  kind: WalkKind;
  street: string | null;
}

export interface Poi {
  id: number;
  name: string;
  kind: string;
  x: number; // on the pavement in front of the door
  z: number;
  curbX: number; // in the road next to the kerb (where cars stop)
  curbZ: number;
  /** Heading of a car stopped at curbX/curbZ (the kerbside lane's direction of travel). */
  kerbHeading: number;
  door: { x: number; z: number };
  street: string;
  walkNode: number;
  /** The name is painted on the building's sign (real maps): systems that rename places must keep it. */
  signed?: boolean;
}

export interface ParkingSpot {
  x: number;
  y: number;
  z: number;
  heading: number; // yaw of the parked car (forward = (sin, cos))
  cls: RoadClass | 'lot';
  street: string | null;
  lot: number; // car park index, -1 if kerbside
  /** The parking lane this kerbside spot stands in (-1 in a car park), and the distance along it. */
  edge: number;
  s: number;
}

/** A named street for minimap labels: its centre line as x,z pairs. */
export interface StreetLine {
  name: string;
  cls: RoadClass;
  pts: number[];
}

/** A building footprint (closed ring of x,z pairs) with its height and bounding box. */
export interface Building {
  pts: Float32Array;
  h: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Boat {
  mesh: THREE.Object3D;
  baseY: number;
  phase: number;
}

/** Caller-owned result of nearestLane / projectOnLane. */
export interface LaneHit {
  edge: number;
  s: number; // distance along the edge's pts
  x: number;
  y: number;
  z: number;
  heading: number;
  dist: number; // horizontal distance from the query point to the lane centre
}

/** Caller-owned result of kerbPoint: where a car stops at the kerb, facing `heading`. */
export interface KerbHit {
  x: number;
  y: number;
  z: number;
  heading: number;
  edge: number; // the kerbside lane
  s: number;
  dist: number; // from the query point to the lane centre
}

/** Caller-owned result of laneSample. */
export interface LanePoint {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface MinimapDrawOpts {
  scale: number; // pixels per metre
  ox: number; // world x at pixel 0
  oz: number; // world z at pixel 0
  width: number; // canvas size in pixels
  height: number;
}

export type MapId = 'grid' | 'georgetown';

export interface CityMap {
  id: MapId;
  /** Credit line shown (small) in the pause menu, e.g. the OpenStreetMap ODbL notice. */
  attribution: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  center: { x: number; z: number };
  /** Where the player starts (on the pavement), and which way they face. */
  spawn: { x: number; z: number; heading: number };
  /** Height of the main water surface (bay / river): the level of the open water and the waterfront. */
  waterLevel: number;
  roads: { nodes: RoadNode[]; edges: LaneEdge[] };
  walk: { nodes: WalkNode[] };
  streets: StreetLine[];
  buildings: Building[];
  pois: Poi[];
  taxiRanks: Poi[];
  parkingSpots: ParkingSpot[];
  /** Terrain height; with `y`, the deck (bridge, elevated road) under a point at height y if there is one (see LEVELS). */
  heightAt(x: number, z: number, y?: number): number;
  isRoad(x: number, z: number): boolean;
  isBlocked(x: number, z: number): boolean;
  isWater(x: number, z: number): boolean;
  /** Water surface height where isWater(x, z): waterLevel for the river / bay, its own level for a canal or pond. */
  waterLevelAt(x: number, z: number): number;
  /**
   * Nearest lane centre within maxDist; fills `out` and returns true, or false if none. No allocation.
   * `y`: the caller's height: lanes on its level (bridge deck vs the road below) win (see LEVELS).
   */
  nearestLane(x: number, z: number, maxDist: number, out: LaneHit, y?: number): boolean;
  /** Nearest walk node id (always succeeds); `y` prefers nodes on the caller's level. */
  nearestWalk(x: number, z: number, y?: number): number;
  /** Nearest kerbside stopping point (kerbside lane, kerbStopGap from the kerb, outside junction boxes); `y` as nearestLane. */
  kerbPoint(x: number, z: number, out: KerbHit, y?: number): boolean;
  /** Paint the static map (ground, water, parks, buildings, roads, piers) for the minimap. */
  drawMinimapBase(ctx: CanvasRenderingContext2D, opts: MinimapDrawOpts): void;
  // what dayNight / weather / the frame loop drive
  litWindowMat: THREE.MeshBasicMaterial;
  lampMat: THREE.MeshBasicMaterial;
  lampPoolMat: THREE.MeshBasicMaterial;
  groundMats: THREE.MeshStandardMaterial[];
  water: THREE.Mesh;
  boats: Boat[];
  /**
   * Animate water and boats, and (maps with level of detail) show what the camera can see. Called once per rendered
   * frame with the game time in seconds and the render camera.
   */
  update(time: number, camera: THREE.Camera): void;
  /** Optional: the pause menu's graphics quality (draw distance, detail, trees). Called at boot and on every change. */
  setQuality?(q: 'low' | 'medium' | 'high'): void;
  /** Collider handle -> solid kind of every static collider the map made (the physics audit and the F4 view). */
  solidTags: SolidTags;
  /** Physics audit mode only (?physaudit=1): every drawn box, cylinder and wall with its solid kind; else null. */
  solidRecorder: SolidRecorder | null;
}

// =============================================================================================== lane geometry
/** Position and heading at distance `s` along a lane (clamped to its ends). Allocation-free. */
export function laneSample(e: LaneEdge, s: number, out: LanePoint): LanePoint {
  const p = e.pts, c = e.cum, n = c.length;
  if (s <= 0) return segPoint(p, 0, 0, out);
  if (s >= e.len) return segPoint(p, n - 2, 1, out);
  // binary search for the segment holding s
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid;
  }
  const segLen = c[lo + 1] - c[lo];
  return segPoint(p, lo, segLen > 1e-6 ? (s - c[lo]) / segLen : 0, out);
}

function segPoint(p: Float32Array, k: number, t: number, out: LanePoint): LanePoint {
  const a = k * 3, b = a + 3;
  const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
  out.x = p[a] + dx * t;
  out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * t;
  out.z = p[a + 2] + dz * t;
  out.heading = Math.atan2(dx, dz);
  return out;
}

/** Closest point on a lane to (x, z). Fills `out` (edge, s, x, y, z, heading, dist). Allocation-free. */
export function projectOnLane(e: LaneEdge, x: number, z: number, out: LaneHit): LaneHit {
  const p = e.pts, c = e.cum, n = c.length;
  let best = Infinity;
  for (let k = 0; k < n - 1; k++) {
    const a = k * 3;
    const ax = p[a], az = p[a + 2], dx = p[a + 3] - ax, dz = p[a + 5] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 < best) {
      best = d2;
      out.edge = e.id;
      out.s = c[k] + (c[k + 1] - c[k]) * t;
      out.x = qx;
      out.y = p[a + 1] + (p[a + 4] - p[a + 1]) * t;
      out.z = qz;
      out.heading = Math.atan2(dx, dz);
    }
  }
  out.dist = Math.sqrt(best);
  return out;
}

/** Build pts/cum/len for a lane from a flat x,y,z list. */
export function makeLaneGeometry(xyz: number[]): { pts: Float32Array; cum: Float32Array; len: number } {
  const pts = Float32Array.from(xyz);
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    const a = (k - 1) * 3, b = k * 3;
    cum[k] = cum[k - 1] + Math.hypot(pts[b] - pts[a], pts[b + 2] - pts[a + 2]);
  }
  return { pts, cum, len: cum[n - 1] };
}

// =============================================================================================== spatial index
/**
 * Spatial hashes behind nearestLane, kerbPoint, nearestWalk and building tests. Uniform cells over the bounds,
 * stored as flat arrays (cell start offsets + item list), searched ring by ring. A map builds one and forwards its
 * lookups to it. Queries never allocate.
 */
export class MapIndex {
  private readonly edges: LaneEdge[];
  private readonly walk: WalkNode[];
  private readonly buildings: Building[];
  private readonly minX: number;
  private readonly minZ: number;
  // lanes: items are (edge id, segment index) pairs
  private readonly lCell: number;
  private readonly lCols: number;
  private readonly lRows: number;
  private readonly lStart: Int32Array;
  private readonly lItems: Int32Array;
  // walk nodes
  private readonly wCell: number;
  private readonly wCols: number;
  private readonly wRows: number;
  private readonly wStart: Int32Array;
  private readonly wItems: Int32Array;
  // buildings (by bounding box)
  private readonly bCell: number;
  private readonly bCols: number;
  private readonly bRows: number;
  private readonly bStart: Int32Array;
  private readonly bItems: Int32Array;
  private readonly tmpHit: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
  private readonly tmpPt: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

  constructor(bounds: CityMap['bounds'], edges: LaneEdge[], walk: WalkNode[], buildings: Building[]) {
    this.edges = edges;
    this.walk = walk;
    this.buildings = buildings;
    const pad = 50;
    this.minX = bounds.minX - pad;
    this.minZ = bounds.minZ - pad;
    const w = bounds.maxX - bounds.minX + pad * 2, h = bounds.maxZ - bounds.minZ + pad * 2;

    // ---- lanes ----
    this.lCell = M.laneHashCell;
    this.lCols = Math.max(1, Math.ceil(w / this.lCell));
    this.lRows = Math.max(1, Math.ceil(h / this.lCell));
    {
      const cells: number[][] = Array.from({ length: this.lCols * this.lRows }, () => []);
      for (const e of edges) {
        const p = e.pts;
        for (let k = 0; k < p.length / 3 - 1; k++) {
          const a = k * 3;
          this.forCells(this.lCell, this.lCols, this.lRows, Math.min(p[a], p[a + 3]), Math.min(p[a + 2], p[a + 5]), Math.max(p[a], p[a + 3]), Math.max(p[a + 2], p[a + 5]), (ci) => cells[ci].push(e.id, k));
        }
      }
      [this.lStart, this.lItems] = flatten(cells);
    }
    // ---- walk nodes ----
    this.wCell = M.walkHashCell;
    this.wCols = Math.max(1, Math.ceil(w / this.wCell));
    this.wRows = Math.max(1, Math.ceil(h / this.wCell));
    {
      const cells: number[][] = Array.from({ length: this.wCols * this.wRows }, () => []);
      for (const n of walk) cells[this.cellOf(this.wCell, this.wCols, this.wRows, n.x, n.z)].push(n.id);
      [this.wStart, this.wItems] = flatten(cells);
    }
    // ---- buildings ----
    this.bCell = M.buildingHashCell;
    this.bCols = Math.max(1, Math.ceil(w / this.bCell));
    this.bRows = Math.max(1, Math.ceil(h / this.bCell));
    {
      const cells: number[][] = Array.from({ length: this.bCols * this.bRows }, () => []);
      buildings.forEach((b, i) => this.forCells(this.bCell, this.bCols, this.bRows, b.minX, b.minZ, b.maxX, b.maxZ, (ci) => cells[ci].push(i)));
      [this.bStart, this.bItems] = flatten(cells);
    }
  }

  private cellOf(cell: number, cols: number, rows: number, x: number, z: number): number {
    let cx = Math.floor((x - this.minX) / cell), cz = Math.floor((z - this.minZ) / cell);
    cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
    cz = cz < 0 ? 0 : cz >= rows ? rows - 1 : cz;
    return cz * cols + cx;
  }

  private forCells(cell: number, cols: number, rows: number, x0: number, z0: number, x1: number, z1: number, fn: (ci: number) => void) {
    const a = this.cellOf(cell, cols, rows, x0, z0), b = this.cellOf(cell, cols, rows, x1, z1);
    const ax = a % cols, az = (a / cols) | 0, bx = b % cols, bz = (b / cols) | 0;
    for (let cz = az; cz <= bz; cz++) for (let cx = ax; cx <= bx; cx++) fn(cz * cols + cx);
  }

  /**
   * Nearest lane centre (kerbside lanes only if `kerbside`). Returns false if nothing within maxDist. With a finite
   * `y`, lanes within TUNING.map.levelTolerance of that height win; other levels count only if none is in range.
   */
  nearestLane(x: number, z: number, maxDist: number, kerbside: boolean, out: LaneHit, y = NaN): boolean {
    if (y === y && this.searchLane(x, z, maxDist, kerbside, y, out)) return true;
    return this.searchLane(x, z, maxDist, kerbside, NaN, out);
  }

  private searchLane(x: number, z: number, maxDist: number, kerbside: boolean, y: number, out: LaneHit): boolean {
    const level = y === y, tol = M.levelTolerance;
    const cell = this.lCell, cols = this.lCols, rows = this.lRows;
    const ci = this.cellOf(cell, cols, rows, x, z);
    const cx = ci % cols, cz = (ci / cols) | 0;
    let best = Infinity, bestEdge = -1, bestSeg = -1;
    const maxRing = Math.min(Math.max(cols, rows), Math.ceil(maxDist / cell) + 1);
    for (let r = 0; r <= maxRing; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (iz < 0 || iz >= rows) continue;
        const edgeRow = iz === cz - r || iz === cz + r;
        for (let ix = cx - r; ix <= cx + r; ix += edgeRow ? 1 : 2 * r || 1) {
          if (ix < 0 || ix >= cols) continue;
          const c = iz * cols + ix;
          for (let k = this.lStart[c]; k < this.lStart[c + 1]; k += 2) {
            const e = this.edges[this.lItems[k]];
            if (kerbside && e.lane !== 0) continue;
            const seg = this.lItems[k + 1], p = e.pts, a = seg * 3;
            const ax = p[a], az = p[a + 2], dx = p[a + 3] - ax, dz = p[a + 5] - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + dx * t - x, qz = az + dz * t - z;
            const d2 = qx * qx + qz * qz;
            if (d2 >= best) continue;
            if (level) {
              const dy = p[a + 1] + (p[a + 4] - p[a + 1]) * t - y;
              if (dy > tol || dy < -tol) continue; // another level (bridge deck vs the road under it)
            }
            best = d2; bestEdge = e.id; bestSeg = seg;
          }
        }
      }
      // every cell in the next ring is at least r * cell away from the query point
      if (bestEdge >= 0 && Math.sqrt(best) <= r * cell) break;
      if (r * cell > maxDist) break;
    }
    if (bestEdge < 0 || best > maxDist * maxDist) return false;
    // exact point on the winning segment
    const e = this.edges[bestEdge], p = e.pts, a = bestSeg * 3;
    const ax = p[a], az = p[a + 2], dx = p[a + 3] - ax, dz = p[a + 5] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out.edge = bestEdge;
    out.s = e.cum[bestSeg] + (e.cum[bestSeg + 1] - e.cum[bestSeg]) * t;
    out.x = ax + dx * t;
    out.y = p[a + 1] + (p[a + 4] - p[a + 1]) * t;
    out.z = az + dz * t;
    out.heading = Math.atan2(dx, dz);
    out.dist = Math.sqrt(best);
    return true;
  }

  /** Nearest kerbside stopping point: TUNING.map.kerbStopGap in from the kerb, outside the junction boxes. */
  kerbPoint(x: number, z: number, out: KerbHit, y = NaN): boolean {
    const h = this.tmpHit;
    if (!this.nearestLane(x, z, M.kerbSearchRange, true, h, y)) return false;
    const e = this.edges[h.edge];
    const s0 = Math.min(e.trimStart, e.len * 0.5), s1 = Math.max(e.len - e.trimEnd, s0);
    const s = h.s < s0 ? s0 : h.s > s1 ? s1 : h.s;
    const lp = laneSample(e, s, this.tmpPt);
    const shift = e.halfWidth - M.kerbStopGap - e.offset; // from the lane centre to the stop line, to the right
    const rx = -Math.cos(lp.heading), rz = Math.sin(lp.heading);
    out.x = lp.x + rx * shift;
    out.y = lp.y;
    out.z = lp.z + rz * shift;
    out.heading = lp.heading;
    out.edge = e.id;
    out.s = s;
    out.dist = h.dist;
    return true;
  }

  /**
   * Nearest walk node id (searches outward until found). With a finite `y`, nodes within
   * TUNING.map.levelTolerance of that height win (the bridge pavement, not the towpath under it), as nearestLane.
   */
  nearestWalk(x: number, z: number, y = NaN): number {
    if (y === y) {
      const id = this.searchWalk(x, z, y, M.levelSearchRange);
      if (id >= 0) return id;
    }
    return Math.max(0, this.searchWalk(x, z, NaN, Infinity));
  }

  private searchWalk(x: number, z: number, y: number, maxDist: number): number {
    const level = y === y, tol = M.levelTolerance;
    const cell = this.wCell, cols = this.wCols, rows = this.wRows;
    const ci = this.cellOf(cell, cols, rows, x, z);
    const cx = ci % cols, cz = (ci / cols) | 0;
    let best = Infinity, bestId = -1;
    const maxRing = Math.min(Math.max(cols, rows), Math.ceil(maxDist / cell) + 1);
    for (let r = 0; r <= maxRing; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (iz < 0 || iz >= rows) continue;
        const edgeRow = iz === cz - r || iz === cz + r;
        for (let ix = cx - r; ix <= cx + r; ix += edgeRow ? 1 : 2 * r || 1) {
          if (ix < 0 || ix >= cols) continue;
          const c = iz * cols + ix;
          for (let k = this.wStart[c]; k < this.wStart[c + 1]; k++) {
            const n = this.walk[this.wItems[k]];
            const d2 = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
            if (d2 >= best || (level && (n.y - y > tol || y - n.y > tol))) continue;
            best = d2; bestId = n.id;
          }
        }
      }
      if (bestId >= 0 && Math.sqrt(best) <= r * cell) break;
      if (r * cell > maxDist) break;
    }
    return bestId;
  }

  /** Index of the building containing (x, z), or -1. */
  buildingAt(x: number, z: number): number {
    const c = this.cellOf(this.bCell, this.bCols, this.bRows, x, z);
    for (let k = this.bStart[c]; k < this.bStart[c + 1]; k++) {
      const i = this.bItems[k], b = this.buildings[i];
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (pointInRing(b.pts, x, z)) return i;
    }
    return -1;
  }
}

function flatten(cells: number[][]): [Int32Array, Int32Array] {
  const start = new Int32Array(cells.length + 1);
  for (let i = 0; i < cells.length; i++) start[i + 1] = start[i] + cells[i].length;
  const items = new Int32Array(start[cells.length]);
  for (let i = 0; i < cells.length; i++) items.set(cells[i], start[i]);
  return [start, items];
}

/** Even-odd point-in-polygon test on a ring of x,z pairs. */
export function pointInRing(ring: Float32Array | number[], x: number, z: number): boolean {
  let inside = false;
  const n = ring.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// =============================================================================================== routing
/** Min-heap of (key, value) with preallocated storage (grows only if a search needs more room). */
class Heap {
  keys: Float64Array;
  vals: Int32Array;
  n = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(Math.max(16, cap));
    this.vals = new Int32Array(Math.max(16, cap));
  }
  push(k: number, v: number) {
    if (this.n === this.keys.length) {
      const k2 = new Float64Array(this.n * 2), v2 = new Int32Array(this.n * 2);
      k2.set(this.keys);
      v2.set(this.vals);
      this.keys = k2;
      this.vals = v2;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }
  /** Removes the smallest entry; its value is returned and its key left in `top`. */
  top = 0;
  pop(): number {
    const v = this.vals[0];
    this.top = this.keys[0];
    const k = this.keys[--this.n], vl = this.vals[this.n];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = k;
    this.vals[i] = vl;
    return v;
  }
}

/**
 * Directed shortest paths on the road graph (A*, cost = travel time len/speed, x TUNING.map.parkingLaneCost on
 * parking lanes that have another lane going the same way, straight-line heuristic).
 * Reusable buffers: create one per system and keep it. After `path()` the edge ids are in `edges[0..count)`.
 */
export class RoadRouter {
  readonly edges: Int32Array;
  count = 0;
  /** Total length (m) of the last path found. */
  length = 0;
  private readonly g: Float64Array;
  private readonly prev: Int32Array; // edge id that reached each node
  private readonly seen: Int32Array; // search stamp per node
  private readonly done: Int32Array;
  private stamp = 0;
  private readonly heap: Heap;
  private readonly vmax: number;

  constructor(private readonly map: Pick<CityMap, 'roads'>) {
    const n = map.roads.nodes.length;
    this.g = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.done = new Int32Array(n);
    this.edges = new Int32Array(Math.max(1, n));
    this.heap = new Heap(map.roads.edges.length + n);
    let v = 1;
    for (const e of map.roads.edges) v = Math.max(v, e.speed);
    this.vmax = v;
  }

  /** Path from node a to node b: edge count (0 if a === b), or -1 if unreachable. */
  path(a: number, b: number): number {
    const { nodes, edges } = this.map.roads;
    this.count = 0;
    this.length = 0;
    if (a === b) return 0;
    const st = ++this.stamp;
    const gx = nodes[b].x, gz = nodes[b].z, inv = 1 / this.vmax; // heuristic: straight line at top speed
    const heap = this.heap;
    heap.n = 0;
    this.g[a] = 0;
    this.prev[a] = -1;
    this.seen[a] = st;
    heap.push(Math.hypot(nodes[a].x - gx, nodes[a].z - gz) * inv, a);
    let found = false;
    while (heap.n > 0) {
      const n = heap.pop();
      if (this.done[n] === st) continue;
      this.done[n] = st;
      if (n === b) { found = true; break; }
      const out = nodes[n].out;
      for (let i = 0; i < out.length; i++) {
        const e = edges[out[i]];
        const m = e.to;
        if (this.done[m] === st) continue;
        const g = this.g[n] + (e.len / e.speed) * (e.parking && e.lanesSameDir > 1 ? M.parkingLaneCost : 1);
        if (this.seen[m] !== st || g < this.g[m]) {
          this.seen[m] = st;
          this.g[m] = g;
          this.prev[m] = e.id;
          heap.push(g + Math.hypot(nodes[m].x - gx, nodes[m].z - gz) * inv, m);
        }
      }
    }
    if (!found) return -1;
    let c = 0;
    for (let n = b; n !== a; n = edges[this.prev[n]].from) c++;
    let i = c;
    for (let n = b; n !== a; n = edges[this.prev[n]].from) {
      const e = this.prev[n];
      this.edges[--i] = e;
      this.length += edges[e].len;
    }
    this.count = c;
    return c;
  }

  /** First edge on the path from node a to node b, or -1 (unreachable or a === b). */
  firstEdge(a: number, b: number): number {
    return this.path(a, b) > 0 ? this.edges[0] : -1;
  }
}

/** Shortest paths on the walk graph (A*, distance). After `path()` the node ids are in `nodes[0..count)`. */
export class WalkRouter {
  readonly nodes: Int32Array;
  count = 0;
  private readonly g: Float64Array;
  private readonly prev: Int32Array;
  private readonly seen: Int32Array;
  private readonly done: Int32Array;
  private stamp = 0;
  private readonly heap: Heap;

  constructor(private readonly map: Pick<CityMap, 'walk'>) {
    const n = map.walk.nodes.length;
    this.g = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.done = new Int32Array(n);
    this.nodes = new Int32Array(Math.max(1, n));
    this.heap = new Heap(n * 4);
  }

  /** Path from walk node a to b, both included: node count, or -1 if unreachable. */
  path(a: number, b: number): number {
    const nodes = this.map.walk.nodes;
    const st = ++this.stamp;
    const goal = nodes[b];
    const heap = this.heap;
    heap.n = 0;
    this.g[a] = 0;
    this.prev[a] = -1;
    this.seen[a] = st;
    heap.push(Math.hypot(nodes[a].x - goal.x, nodes[a].z - goal.z), a);
    let found = false;
    while (heap.n > 0) {
      const n = heap.pop();
      if (this.done[n] === st) continue;
      this.done[n] = st;
      if (n === b) { found = true; break; }
      const node = nodes[n], nb = node.nbrs;
      for (let i = 0; i < nb.length; i++) {
        const m = nb[i];
        if (this.done[m] === st) continue;
        const o = nodes[m];
        const g = this.g[n] + Math.hypot(o.x - node.x, o.z - node.z);
        if (this.seen[m] !== st || g < this.g[m]) {
          this.seen[m] = st;
          this.g[m] = g;
          this.prev[m] = n;
          heap.push(g + Math.hypot(o.x - goal.x, o.z - goal.z), m);
        }
      }
    }
    this.count = 0;
    if (!found) return -1;
    let c = 0;
    for (let n = b; n !== -1; n = this.prev[n]) c++;
    let i = c;
    for (let n = b; n !== -1; n = this.prev[n]) this.nodes[--i] = n;
    this.count = c;
    return c;
  }
}

// One router of each kind per map, created on first use (they only hold scratch buffers, never game state).
const ROUTERS = new WeakMap<object, { road?: RoadRouter; walk?: WalkRouter }>();
function routersOf(map: object) {
  let r = ROUTERS.get(map);
  if (!r) ROUTERS.set(map, (r = {}));
  return r;
}
/** The shared road router for this map (read its results right away: the next search reuses the buffers). */
export function roadRouter(map: CityMap): RoadRouter {
  const r = routersOf(map);
  return (r.road ??= new RoadRouter(map));
}
/** The shared walk router for this map (read its results right away: the next search reuses the buffers). */
export function walkRouter(map: CityMap): WalkRouter {
  const r = routersOf(map);
  return (r.walk ??= new WalkRouter(map));
}

// =============================================================================================== validation
export interface MapReport {
  ok: boolean;
  id: string;
  errors: string[];
  warnings: string[];
  stats: {
    roadNodes: number;
    laneEdges: number;
    junctions: number;
    deadEnds: number;
    oneWayEdges: number;
    bridgeEdges: number;
    roundaboutEdges: number;
    largestSccEdges: number;
    largestSccShare: number;
    walkNodes: number;
    walkLinks: number;
    largestWalkShare: number;
    heightMismatches: number;
    pois: number;
    taxiRanks: number;
    parkingSpots: number;
    buildings: number;
    streets: number;
    totalLaneKm: number;
  };
}

/** Integrity check of a CityMap (data only; cheap enough to run at load in tests). */
export function validateCityMap(map: CityMap): MapReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (s: string) => { if (errors.length < 40) errors.push(s); };
  const warn = (s: string) => { if (warnings.length < 40) warnings.push(s); };
  const { nodes, edges } = map.roads;
  const fin = (v: number) => Number.isFinite(v);
  let heightBad = 0;
  const heightErr = (what: string, x: number, y: number, z: number, dy: number) => {
    heightBad++;
    err(`${what} at (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) is ${dy.toFixed(2)} m off the surface heightAt reports`);
  };

  nodes.forEach((n, i) => {
    if (n.id !== i) err(`road node ${i} has id ${n.id}`);
    if (!fin(n.x) || !fin(n.y) || !fin(n.z)) err(`road node ${i} has a non-finite position`);
    for (const e of n.out) if (!edges[e] || edges[e].from !== i) err(`node ${i}.out lists edge ${e} which does not start there`);
    for (const e of n.in) if (!edges[e] || edges[e].to !== i) err(`node ${i}.in lists edge ${e} which does not end there`);
  });
  let laneM = 0;
  edges.forEach((e, i) => {
    if (e.id !== i) err(`edge ${i} has id ${e.id}`);
    if (!nodes[e.from] || !nodes[e.to]) { err(`edge ${i} ends at a missing node (${e.from} -> ${e.to})`); return; }
    if (!nodes[e.from].out.includes(i)) err(`edge ${i} missing from nodes[${e.from}].out`);
    if (!nodes[e.to].in.includes(i)) err(`edge ${i} missing from nodes[${e.to}].in`);
    if (e.pts.length < 6 || e.pts.length % 3 !== 0) err(`edge ${i} has ${e.pts.length / 3} points`);
    if (e.cum.length * 3 !== e.pts.length) err(`edge ${i} cum length mismatch`);
    for (let k = 0; k < e.pts.length; k++) if (!fin(e.pts[k])) { err(`edge ${i} has a NaN point`); break; }
    for (let k = 1; k < e.cum.length; k++) if (!(e.cum[k] >= e.cum[k - 1])) { err(`edge ${i} cum not increasing`); break; }
    if (!fin(e.len) || e.len <= 0 || Math.abs(e.len - e.cum[e.cum.length - 1]) > 0.05) err(`edge ${i} len ${e.len} does not match cum`);
    if (!(e.speed > 0)) err(`edge ${i} speed ${e.speed}`);
    if (!(e.trimStart >= 0 && e.trimEnd >= 0)) err(`edge ${i} negative trim`);
    else if (e.trimStart + e.trimEnd >= e.len) warn(`edge ${i} (${e.name ?? e.roadId}) is shorter than its junction boxes (${e.len.toFixed(1)} m)`);
    if (!(e.halfWidth > 0)) err(`edge ${i} halfWidth ${e.halfWidth}`);
    if (e.lane < 0 || e.lane >= e.lanesSameDir) err(`edge ${i} lane ${e.lane} of ${e.lanesSameDir}`);
    if (e.twin >= 0) {
      const t = edges[e.twin];
      if (!t || t.from !== e.to || t.to !== e.from) err(`edge ${i} twin ${e.twin} is not the reverse edge`);
    } else if (!e.oneway) warn(`two-way edge ${i} (${e.name ?? e.roadId}) has no twin`);
    // the lane must actually start and end at its nodes (within the road's width)
    const a = nodes[e.from], b = nodes[e.to], p = e.pts, l = p.length - 3;
    const dA = Math.hypot(p[0] - a.x, p[2] - a.z), dB = Math.hypot(p[l] - b.x, p[l + 2] - b.z);
    if (dA > e.halfWidth + 2 || dB > e.halfWidth + 2) warn(`edge ${i} ends ${Math.max(dA, dB).toFixed(1)} m from its node`);
    laneM += e.len;
    // the lane must lie on the surface the map reports at its height (bridge decks included)
    for (let k = 0; k < p.length; k += 9) {
      const dy = p[k + 1] - map.heightAt(p[k], p[k + 2], p[k + 1]);
      if (Math.abs(dy) > M.heightCheckTolerance) { heightErr(`lane ${i} (${e.name ?? e.roadId})`, p[k], p[k + 1], p[k + 2], dy); break; }
    }
  });

  // ---- strongly connected components (iterative Kosaraju over nodes) ----
  const N = nodes.length;
  const order: number[] = [];
  const vis = new Uint8Array(N);
  const stackN: number[] = [], stackI: number[] = [];
  for (let s = 0; s < N; s++) {
    if (vis[s]) continue;
    vis[s] = 1;
    stackN.push(s); stackI.push(0);
    while (stackN.length) {
      const n = stackN[stackN.length - 1], i = stackI[stackI.length - 1];
      const out = nodes[n].out;
      if (i < out.length) {
        stackI[stackI.length - 1]++;
        const m = edges[out[i]]?.to;
        if (m !== undefined && !vis[m]) { vis[m] = 1; stackN.push(m); stackI.push(0); }
      } else {
        order.push(n);
        stackN.pop(); stackI.pop();
      }
    }
  }
  const comp = new Int32Array(N).fill(-1);
  let nComp = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const s = order[k];
    if (comp[s] >= 0) continue;
    const st = [s];
    comp[s] = nComp;
    while (st.length) {
      const n = st.pop()!;
      for (const e of nodes[n].in) {
        const m = edges[e]?.from;
        if (m !== undefined && comp[m] < 0) { comp[m] = nComp; st.push(m); }
      }
    }
    nComp++;
  }
  const compEdges = new Int32Array(Math.max(1, nComp));
  for (const e of edges) if (comp[e.from] >= 0 && comp[e.from] === comp[e.to]) compEdges[comp[e.from]]++;
  let largest = 0;
  for (let c = 0; c < nComp; c++) largest = Math.max(largest, compEdges[c]);
  const sccShare = edges.length ? largest / edges.length : 0;
  if (sccShare < M.minStrongShare) err(`largest strongly connected road component covers only ${(sccShare * 100).toFixed(1)}% of lane edges`);

  // ---- walk graph ----
  const W = map.walk.nodes;
  let links = 0;
  W.forEach((n, i) => {
    if (n.id !== i) err(`walk node ${i} has id ${n.id}`);
    if (!fin(n.x) || !fin(n.y) || !fin(n.z)) err(`walk node ${i} has a non-finite position`);
    else {
      const dy = n.y - map.heightAt(n.x, n.z, n.y);
      if (Math.abs(dy) > M.heightCheckTolerance) heightErr(`walk node ${i} (${n.kind})`, n.x, n.y, n.z, dy);
    }
    for (const m of n.nbrs) {
      if (!W[m]) { err(`walk node ${i} links to missing node ${m}`); continue; }
      if (!W[m].nbrs.includes(i)) err(`walk link ${i} -> ${m} is one-sided`);
      links++;
    }
  });
  const wcomp = new Int32Array(W.length).fill(-1);
  let bestWalk = 0;
  for (let s = 0, c = 0; s < W.length; s++) {
    if (wcomp[s] >= 0) continue;
    let size = 0;
    const st = [s];
    wcomp[s] = c;
    while (st.length) {
      const n = st.pop()!;
      size++;
      for (const m of W[n].nbrs) if (W[m] && wcomp[m] < 0) { wcomp[m] = c; st.push(m); }
    }
    bestWalk = Math.max(bestWalk, size);
    c++;
  }
  const walkShare = W.length ? bestWalk / W.length : 0;
  if (walkShare < M.minWalkShare) err(`walk graph: largest connected part has only ${(walkShare * 100).toFixed(1)}% of nodes`);
  else if (walkShare < 1) warn(`walk graph: ${W.length - bestWalk} nodes are not connected to the main network`);

  // ---- places ----
  for (const p of map.pois) {
    if (!fin(p.x) || !fin(p.z) || !fin(p.curbX) || !fin(p.curbZ) || !fin(p.kerbHeading)) err(`poi ${p.id} (${p.name}) has a non-finite position`);
    if (!W[p.walkNode]) err(`poi ${p.id} (${p.name}) walkNode ${p.walkNode} missing`);
    if (map.pois[p.id] !== p) err(`poi ${p.id} is not at index ${p.id}`);
  }
  if (!map.taxiRanks.length) err('no taxi ranks');
  for (const r of map.taxiRanks) if (map.pois[r.id] !== r) err(`taxi rank ${r.name} is not one of the pois`);
  if (!map.pois.some((p) => p.kind === 'clinic')) warn('no clinic: knocked-out players wake at a taxi rank');
  for (const s of map.parkingSpots) if (!fin(s.x) || !fin(s.y) || !fin(s.z) || !fin(s.heading)) { err('parking spot with a non-finite position'); break; }
  for (const s of map.parkingSpots) {
    if (s.edge >= 0 && (!edges[s.edge] || !edges[s.edge].parking)) { err(`kerbside parking spot on lane ${s.edge}, which is not a parking lane`); break; }
    const dy = s.y - map.heightAt(s.x, s.z, s.y);
    if (Math.abs(dy) > M.heightCheckTolerance) { heightErr(`parking spot (${s.cls}, ${s.street ?? 'lot'})`, s.x, s.y, s.z, dy); break; }
  }
  if (!fin(map.spawn.x) || !fin(map.spawn.z)) err('spawn is not finite');
  else if (map.isBlocked(map.spawn.x, map.spawn.z)) err('spawn is inside a building or water');
  const hit: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
  if (!map.nearestLane(map.spawn.x, map.spawn.z, 200, hit)) err('no lane within 200 m of the spawn');

  return {
    ok: errors.length === 0,
    id: map.id,
    errors,
    warnings,
    stats: {
      roadNodes: N,
      laneEdges: edges.length,
      junctions: nodes.filter((n) => n.junction).length,
      deadEnds: nodes.filter((n) => n.deadEnd).length,
      oneWayEdges: edges.filter((e) => e.oneway).length,
      bridgeEdges: edges.filter((e) => e.bridge).length,
      roundaboutEdges: edges.filter((e) => e.roundabout).length,
      largestSccEdges: largest,
      largestSccShare: +sccShare.toFixed(4),
      walkNodes: W.length,
      walkLinks: links / 2,
      largestWalkShare: +walkShare.toFixed(4),
      heightMismatches: heightBad,
      pois: map.pois.length,
      taxiRanks: map.taxiRanks.length,
      parkingSpots: map.parkingSpots.length,
      buildings: map.buildings.length,
      streets: map.streets.length,
      totalLaneKm: +(laneM / 1000).toFixed(2),
    },
  };
}
