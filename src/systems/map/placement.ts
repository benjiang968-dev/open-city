// Exact footprint placement. The previous corner/midpoint probes missed a road through a long wall and could
// never detect one building inside another. All edits happen before raster, render, physics and map queries.
import polygonClipping from 'polygon-clipping';
import * as robustClip from 'polyclip-ts';
// Snap only sub-micrometre noise from independently computed pavement joins. BigNumber-backed predicates prevent
// sweep-line failures at near-coincident real-data boundaries without moving metre-scale geometry.
robustClip.setPrecision(1e-7);
import type { GeoBuilding, GeoDoc, Pt } from './geoDoc';
import { polyArea } from './geoDoc';
import { DEAD_END_CAP, FRONTAGE, sections } from './roadMesh';
import type { RoadNet } from './roadNet';
import { TUNING } from '../../tuning';

type Polygon = Pt[][];
interface Bounds { x0: number; z0: number; x1: number; z1: number }
interface Obstacle { polygon: Polygon; bounds: Bounds; deck?: boolean; underside?: number }
const EPS_AREA = 0.0001; // numerical tolerance in square metres
export const PLACEMENT = {
  wallClearance: 0.55, // m beyond the back of a sidewalk / carriageway: facade and kerb never touch
  pedestrianClearance: 1.5, // m clear walking corridor beside the carriageway, including beside entrance stairs
  minArea: 12, // m²: do not leave unrecognisable slivers after clipping
  minAreaShare: 0.3,
};

const bounds = (P: Pt[]): Bounds => ({ x0: Math.min(...P.map(p => p[0])), z0: Math.min(...P.map(p => p[1])), x1: Math.max(...P.map(p => p[0])), z1: Math.max(...P.map(p => p[1])) });
const touches = (a: Bounds, b: Bounds) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;
export const footprintArea = (P: Polygon) => Math.abs(polyArea(P[0])) - P.slice(1).reduce((s, h) => s + Math.abs(polyArea(h)), 0);
const asPolygon = (b: GeoBuilding): Polygon => [b.pts, ...(b.holes ?? [])];

/** Bounds only select candidates. Narrow phase always uses the real polygon, never an axis-aligned box. */
class FootprintGrid {
  private cells = new Map<string, number[]>();
  readonly obstacles: Obstacle[] = [];
  private keys(b: Bounds): string[] {
    const out: string[] = [];
    for (let x = Math.floor(b.x0 / 64); x <= Math.floor(b.x1 / 64); x++)
      for (let z = Math.floor(b.z0 / 64); z <= Math.floor(b.z1 / 64); z++) out.push(`${x},${z}`);
    return out;
  }
  add(polygon: Polygon, extra: Partial<Obstacle> = {}) {
    const b = bounds(polygon[0]);
    const id = this.obstacles.push({ polygon, bounds: b, ...extra }) - 1;
    for (const k of this.keys(b)) {
      let ids = this.cells.get(k);
      if (!ids) this.cells.set(k, ids = []);
      ids.push(id);
    }
  }
  query(P: Pt[]): Obstacle[] {
    const b = bounds(P), ids = new Set<number>();
    for (const k of this.keys(b)) for (const id of this.cells.get(k) ?? []) ids.add(id);
    return [...ids].map(id => this.obstacles[id]).filter(o => touches(b, o.bounds));
  }
}

/** The same mitred sections and side-specific pavement widths used by roadMesh, plus a small facade clearance. */
export function roadPlacementObstacles(net: RoadNet, includeSidewalk = true, doc?: GeoDoc): FootprintGrid {
  const out = new FootprintGrid();
  for (const e of net.edges) {
    const X = sections(e, 0, e.L);
    for (let i = 1; i < X.length; i++) {
      const p = { ...X[i - 1] }, q = { ...X[i] }, sm = (p.s + q.s) / 2;
      // Meshes add a short cap beyond isolated road ends. Include it in the placement envelope too.
      const dx = q.x - p.x, dz = q.z - p.z, length = Math.hypot(dx, dz) || 1;
      if (!e.deck && i === 1 && e.a?.arms.length === 1) { p.x -= dx / length * (DEAD_END_CAP + PLACEMENT.wallClearance); p.z -= dz / length * (DEAD_END_CAP + PLACEMENT.wallClearance); }
      if (!e.deck && i === X.length - 1 && e.b?.arms.length === 1) { q.x += dx / length * (DEAD_END_CAP + PLACEMENT.wallClearance); q.z += dz / length * (DEAD_END_CAP + PLACEMENT.wallClearance); }
      const width = (side: number) => {
        const sw = (side < 0 ? e.swL : e.swR) && !e.noSw.some(r => r[0] === side && sm >= r[1] && sm <= r[2]);
        return e.hw + (includeSidewalk ? (sw ? TUNING.geo.sidewalkWidth : 0) + PLACEMENT.wallClearance : PLACEMENT.pedestrianClearance);
      };
      const l = width(-1), r = width(1);
      const ring: Pt[] = [[p.x - p.rx * l, p.z - p.rz * l], [p.x + p.rx * r, p.z + p.rz * r], [q.x + q.rx * r, q.z + q.rz * r], [q.x - q.rx * l, q.z - q.rz * l]];
      out.add([ring], { deck: e.deck, underside: Math.min(net.profAt(e, p.s), net.profAt(e, q.s)) - TUNING.geo.deckThickness - 0.5 });
    }
  }
  for (const n of net.nodes) {
    // Use the actual mitred corner-pavement quads, including their frontage fill, rather than relying on a
    // distance-to-centre approximation at acute / rotated junctions.
    for (const c of n.corners ?? []) {
      const deck = c.armA.edge.deck && c.armB.edge.deck;
      const width = includeSidewalk ? TUNING.geo.sidewalkWidth + (deck ? 0 : FRONTAGE) + PLACEMENT.wallClearance : PLACEMENT.pedestrianClearance;
      for (let i = 2; i < c.pts.length; i += 2) {
        const ax = c.pts[i - 2], az = c.pts[i - 1], bx = c.pts[i], bz = c.pts[i + 1];
        out.add([[[ax, az], [ax + c.outward[i - 2] * width, az + c.outward[i - 1] * width], [bx + c.outward[i] * width, bz + c.outward[i + 1] * width], [bx, bz]]], { deck, underside: n.h - TUNING.geo.deckThickness - 0.5 });
      }
    }
    if (n.outline.length < 6) continue;
    const ring: Pt[] = [];
    // Junction polygons are convex; expand out from the node to reserve the pavement around the whole corner.
    const margin = includeSidewalk ? TUNING.geo.sidewalkWidth + PLACEMENT.wallClearance : PLACEMENT.pedestrianClearance;
    for (let i = 0; i < n.outline.length; i += 2) {
      const dx = n.outline[i] - n.x, dz = n.outline[i + 1] - n.z, len = Math.hypot(dx, dz) || 1;
      ring.push([n.outline[i] + dx / len * margin * 1.42, n.outline[i + 1] + dz / len * margin * 1.42]);
    }
    out.add([ring], { deck: n.arms.every(a => a.edge.deck), underside: n.h - TUNING.geo.deckThickness - 0.5 });
  }
  // Paths and steps also need a continuous pedestrian corridor. A path terminating at a facade cuts a small
  // entrance recess; a path crossing an entire footprint remains walkable instead of being hidden by a building.
  for (const f of doc?.footways ?? []) {
    if (f.bridge || f.towpath || f.pts.length < 2) continue;
    if (f.area && f.pts.length >= 3) { out.add([f.pts]); continue; }
    const half = (f.kind === 'path' || f.kind === 'cycleway' ? 1.5 : f.kind === 'sidewalk' ? 1 : 1.1) + PLACEMENT.wallClearance;
    for (let i = 1; i < f.pts.length; i++) {
      const a = f.pts[i - 1], b = f.pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.01) continue;
      const nx = -(b[1] - a[1]) / L * half, nz = (b[0] - a[0]) / L * half;
      out.add([[[a[0]-nx,a[1]-nz],[a[0]+nx,a[1]+nz],[b[0]+nx,b[1]+nz],[b[0]-nx,b[1]-nz]]]);
    }
  }
  return out;
}

export function overlapArea(a: Polygon, b: Polygon): number {
  let result: Polygon[];
  try { result = polygonClipping.intersection(a, b) as Polygon[]; }
  catch { result = robustClip.intersection(a, b) as Polygon[]; }
  const area = result.reduce((s, p) => s + footprintArea(p), 0);
  // Float intersections can invent tiny slivers at coincident clipped boundaries. Verify these with decimal predicates.
  return area > 0 && area < 0.01 ? (robustClip.intersection(a, b) as Polygon[]).reduce((s, p) => s + footprintArea(p), 0) : area;
}

/** Preserve the largest connected component; retain courtyards as holes rather than filling them with a hull. */
function subtract(subject: Polygon, obstacles: Polygon[]): Polygon | null {
  if (!obstacles.length) return subject;
  let result: Polygon[];
  try { result = polygonClipping.difference(subject, ...obstacles) as Polygon[]; }
  catch {
    // The fast float sweep occasionally fails on nearly coincident real pavement joins. Recompute that building
    // with decimal predicates; never silently leave the conflicting footprint in place or fail the whole map load.
    result = robustClip.difference(subject, ...obstacles) as Polygon[];
  }
  // Float sweeps can also complete with a tiny wrong sliver at a near-coincident join. Validate the whole result,
  // including disconnected pieces, and use decimal clipping if any reserved surface survived.
  if (result.some(p => obstacles.some(o => touches(bounds(p[0]), bounds(o[0])) && (robustClip.intersection(p, o) as Polygon[]).reduce((sum, part) => sum + footprintArea(part), 0) > EPS_AREA))) {
    result = robustClip.difference(subject, ...obstacles) as Polygon[];
  }
  result.sort((a, b) => footprintArea(b) - footprintArea(a));
  if (!result.length) return null;
  // polyclip returns closed rings; our triangulator and facade generator take open rings.
  return result[0].map(ring => ring.slice(0, -1));
}

export interface PlacementReport { clipped: string[]; drop: string[]; roadConflicts: number; neighbourConflicts: number }
export function validateBuildingPlacement(doc: GeoDoc, net: RoadNet, baseAt: (x: number, z: number) => number): PlacementReport {
  const streets = roadPlacementObstacles(net, true, doc), accepted = new FootprintGrid();
  const report: PlacementReport = { clipped: [], drop: [], roadConflicts: 0, neighbourConflicts: 0 };
  // Larger footprints win exact duplicates / nested source data; stable id tie-break keeps this seed-independent.
  const ordered = [...doc.buildings].sort((a, b) => footprintArea(asPolygon(b)) - footprintArea(asPolygon(a)) || a.id.localeCompare(b.id));
  for (const b of ordered) {
    const initial = asPolygon(b), area0 = footprintArea(initial);
    const roof = Math.max(...b.pts.map(p => baseAt(...p))) + Math.max(b.h, b.levels * 3.2) + 2;
    const road = streets.query(b.pts).filter(o => !o.deck || roof > o.underside!).map(o => o.polygon);
    let P = subtract(initial, road);
    if (!P || footprintArea(P) < area0 - EPS_AREA) report.roadConflicts++;
    if (P) {
      const neighbours = accepted.query(P[0]).map(o => o.polygon);
      const previous = footprintArea(P);
      P = subtract(P, neighbours);
      if (!P || footprintArea(P) < previous - EPS_AREA) report.neighbourConflicts++;
    }
    if (!P || footprintArea(P) < Math.max(PLACEMENT.minArea, area0 * PLACEMENT.minAreaShare)) {
      report.drop.push(b.id);
      continue;
    }
    if (footprintArea(P) < area0 - EPS_AREA) report.clipped.push(b.id);
    b.pts = P[0];
    b.holes = P.length > 1 ? P.slice(1) : undefined;
    accepted.add(P);
  }
  return report;
}

/** Entrance extensions are tested as oriented footprints against streets and every other standing building. */
export function makeEntranceValidator(doc: GeoDoc, net: RoadNet, skip: Set<string>) {
  const roads = roadPlacementObstacles(net, false);
  const buildings = new FootprintGrid();
  const owners = new Map<Polygon, string>();
  for (const b of doc.buildings) if (!skip.has(b.id)) {
    const P = asPolygon(b); buildings.add(P); owners.set(P, b.id);
  }
  return (owner: string, ring: Pt[]) => {
    const P = [ring];
    for (const o of roads.query(ring)) if (!o.deck && overlapArea(P, o.polygon) > EPS_AREA) return false;
    for (const o of buildings.query(ring)) if (owners.get(o.polygon) !== owner && overlapArea(P, o.polygon) > EPS_AREA) return false;
    return true;
  };
}
