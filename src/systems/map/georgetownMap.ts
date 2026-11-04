// Georgetown as a CityMap: the world generator v2 (georgetownWorld.ts) builds the meshes, colliders and height /
// road / water queries; this file turns its road polygons and junctions into the lane graph traffic drives on, lays
// the walk graph (sidewalks, crossings, paths, the towpath, the waterfront), names the places (POIs from the data,
// homes, parks, the waterfront), places taxi ranks and parking, and paints the minimap. Contract: map/cityMap.ts.
// The data is a hand-authored approximation (meta.synthetic, see meta.attribution), not OpenStreetMap.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../../tuning';
import { poiName } from '../../data/poiNames';
import type { GeoDoc, Pt } from './geoDoc';
import { hashStr, pointInPoly } from './geoDoc';
import { buildGeorgetownWorld, type GeoQuality, type GeoRoadPoly, type GeoWorld } from './georgetownWorld';
import { SIGN_CATS } from './facades';
import { K } from './terrain';
import {
  MapIndex, laneSample, linkLaneNeighbours,
  type Building, type CityMap, type KerbHit, type LaneEdge, type LaneHit, type LanePoint, type MinimapDrawOpts,
  type ParkingSpot, type Poi, type RoadClass, type RoadNode, type StreetLine, type WalkKind, type WalkNode,
} from './cityMap';

const M = TUNING.map;
const V = TUNING.vehicles;
const G = TUNING.geo;

// ------------------------------------------------------------------------------------------- layout (map data)
/** Player start: on the M St pavement a block east of the Key Bridge landing (past 35th St, where your car is parked on
 * M St itself rather than up a steep side street), facing east. */
const SPAWN = { street: 'M St NW', cross: '35th St NW', along: 54, heading: Math.PI / 2 }; // 54 m: between street trees, so the camera starts clear of them
/**
 * Taxi ranks: on `street`, `along` metres from its junction with `cross` (the direction is whichever way along
 * `street` that is possible), at the kerb of the lane leaving the junction (lane: 1) or arriving at it (-1).
 */
const RANKS: { name: string; street: string; cross: string; along: number; lane: 1 | -1; heading?: number }[] = [
  { name: 'Taxi Rank, M St at Wisconsin Ave', street: 'M St NW', cross: 'Wisconsin Ave NW', along: 45, lane: 1, heading: Math.PI / 2 },
  { name: 'Taxi Rank, Key Bridge', street: 'M St NW', cross: 'Francis Scott Key Bridge', along: 95, lane: -1, heading: -Math.PI / 2 },
  { name: 'Taxi Rank, Waterfront', street: 'K St NW', cross: 'Thomas Jefferson St NW', along: 45, lane: 1, heading: -Math.PI / 2 },
  { name: 'Taxi Rank, Washington Circle', street: 'Pennsylvania Ave NW', cross: 'Washington Circle', along: 70, lane: -1 },
  { name: 'Taxi Rank, Upper Wisconsin', street: 'Wisconsin Ave NW', cross: 'P St NW', along: 45, lane: 1, heading: Math.PI },
];
/** Waterfront places (kind 'pier'): name and a point on the promenade / boardwalk they snap to. */
const WATERFRONT = [
  { name: 'Waterfront Promenade', x: -420, z: 430 },
  { name: 'Harbour Boardwalk', x: 120, z: 585 },
  { name: 'Boathouse Pier', x: 270, z: 700 },
];
/** OSM category -> the game's place kinds (see npc.ts, pedestrians.ts, health.ts, police.ts, dealership.ts). */
const KIND: Record<string, string> = {
  'amenity=cafe': 'cafe', 'shop=bakery': 'cafe', 'amenity=ice_cream': 'cafe', 'shop=deli': 'cafe', 'shop=coffee': 'cafe',
  'amenity=restaurant': 'diner', 'amenity=fast_food': 'diner', 'amenity=food_court': 'diner',
  'amenity=bar': 'bar', 'amenity=pub': 'bar', 'amenity=nightclub': 'bar',
  'tourism=hotel': 'hotel', 'tourism=guest_house': 'hotel',
  'leisure=sports_centre': 'gym', 'leisure=fitness_centre': 'gym',
  'amenity=hospital': 'clinic', 'amenity=clinic': 'clinic', 'amenity=doctors': 'clinic',
  'shop=supermarket': 'market', 'shop=greengrocer': 'market',
  'shop=car': 'garage', 'shop=car_repair': 'garage', 'amenity=fuel': 'garage',
  'leisure=marina': 'marina', 'amenity=boat_rental': 'marina',
  'amenity=police': 'police',
  'amenity=bank': 'office', 'amenity=post_office': 'office', 'amenity=fire_station': 'office',
  'amenity=school': 'school', 'amenity=university': 'school', 'amenity=college': 'school', 'amenity=library': 'school',
  'amenity=place_of_worship': 'church', 'tourism=museum': 'museum', 'tourism=gallery': 'museum', 'amenity=cinema': 'cinema',
  'amenity=theatre': 'cinema', 'amenity=parking': 'parking', 'railway=subway_entrance': 'station', 'historic=memorial': 'monument',
};
const kindOf = (cat: string) => KIND[cat] ?? (cat.startsWith('office=') ? 'office' : cat.startsWith('shop=') ? 'shop' : cat.startsWith('tourism=') ? 'museum' : 'shop');
/** Dealerships (pickDealershipPois takes garages in POI order): real car shops first, then repair shops, then fuel. */
const POI_ORDER = (cat: string) => (cat === 'shop=car' ? 0 : cat === 'shop=car_repair' ? 1 : 2);
const RESIDENTIAL = new Set(['terrace', 'house', 'apartments', 'residential']);

/** Road class from the data's highway tag (parking aisles, driveways and anything unusual drive as 'service'). */
function classOf(highway: string, name: string): RoadClass {
  if (highway === 'motorway' || highway === 'trunk' || /parkway/i.test(name)) return 'parkway';
  if (highway === 'primary' || highway === 'secondary' || highway === 'tertiary') return highway;
  if (highway === 'residential' || highway === 'unclassified' || highway === 'living_street') return 'residential';
  return 'service';
}

/** Fetch the map data (only when this map is picked: loadMap imports this module on demand). */
export async function loadGeorgetownDoc(): Promise<GeoDoc> {
  const res = await fetch(new URL('../../data/georgetown.json', import.meta.url).href);
  if (!res.ok) throw new Error(`Georgetown map data: HTTP ${res.status}`);
  return (await res.json()) as GeoDoc;
}

// ======================================================================================================
export function createGeorgetownMap(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number, doc: GeoDoc, quality: GeoQuality = 'medium'): CityMap {
  const t0 = performance.now();
  const geo = buildGeorgetownWorld(scene, R, physics, doc, { seed, quality });
  const tWorld = performance.now();
  const b = geo.bounds;
  const bounds = { minX: b.x0, maxX: b.x1, minZ: b.z0, maxZ: b.z1 };
  const roadById = new Map(doc.roads.map((r) => [r.id, r]));
  // the buildings that stand in the world (it drops the ones a bridge or the freeway passes over)
  const standing = doc.buildings.filter((bd) => !geo.droppedBuildings.has(bd.id));
  const polys = geo.roadPolys;
  const J = geo.junctions;

  // ------------------------------------------------------------------ road graph
  // a node where two pieces meet is a corner between two streets (cars slow and turn: a junction with its trims)
  // unless it is the same street carrying on roughly straight (a pass-through: no trim, lanes run on seamlessly)
  const cornerAt = new Uint8Array(J.length);
  {
    const ends: { name: string; ux: number; uz: number }[][] = J.map(() => []);
    for (const P of polys) {
      const c = P.centre, n = c.length / 3;
      const dir = (atStart: boolean) => {
        const i0 = atStart ? 0 : n - 1, i1 = atStart ? Math.min(n - 1, 2) : Math.max(0, n - 3);
        const ux = c[i1 * 3] - c[i0 * 3], uz = c[i1 * 3 + 2] - c[i0 * 3 + 2], l = Math.hypot(ux, uz) || 1;
        return { name: P.name, ux: ux / l, uz: uz / l };
      };
      ends[P.nodeA].push(dir(true));
      ends[P.nodeB].push(dir(false));
    }
    ends.forEach((e, i) => {
      if (e.length !== 2) return;
      const straightness = -(e[0].ux * e[1].ux + e[0].uz * e[1].uz); // 1 = straight on, 0 = a right angle
      if (e[0].name !== e[1].name || straightness < Math.cos(M.passThroughMaxBend)) cornerAt[i] = 1;
    });
  }
  const nodes: RoadNode[] = J.map((j) => ({
    id: j.id, x: j.x, y: j.y, z: j.z, out: [], in: [], roundabout: j.roundabout, signals: j.signals, stop: j.stop,
    deadEnd: j.degree <= 1, junction: j.degree >= 3 || ((j.signals || j.stop) && j.degree >= 2) || cornerAt[j.id] === 1,
  }));
  const passThrough = (id: number) => !nodes[id].junction && !nodes[id].deadEnd;
  const edges: LaneEdge[] = [];
  /** per poly: lane edge ids by direction (index = lane, 0 kerbside); parked-car offset per side (pts-right +1 / left -1) */
  const polyLanes: { fwd: number[]; bwd: number[]; parkR: boolean; parkL: boolean; cls: RoadClass }[] = [];
  const band = M.parkingBand;
  polys.forEach((P, pi) => {
    const road = roadById.get(P.roadId);
    const cls = classOf(P.highway, P.name);
    const ring = road?.junction === 'roundabout';
    const hw = P.halfWidth;
    const fwdL = P.lanes.filter((l) => l.dir === 1).sort((a, c) => c.offset - a.offset); // kerbside first
    const bwdL = P.lanes.filter((l) => l.dir === -1).sort((a, c) => a.offset - c.offset);
    const canPark = !P.deck && !ring && cls !== 'parkway' && P.highway !== 'trunk';
    // offsets (m right of the pts direction) where each lane really runs, and which kerbs have parking
    const fwdOff = fwdL.map((l) => l.offset), bwdOff = bwdL.map((l) => l.offset);
    let parkR = false, parkL = false;
    if (canPark) {
      // only along a kerb with a pavement (people get in and out there; Canal Rd and the like have none)
      if (fwdL.length >= 2 && P.sidewalkR) parkR = true; // the kerbside lane is the parking lane
      if (bwdL.length >= 2 && P.sidewalkL) parkL = true;
      if (fwdL.length === 1 && bwdL.length === 1 && hw >= M.parkingMinHalfWidth && (P.sidewalkL || P.sidewalkR)) {
        // narrow two-way street: park on one kerb (the same kerb along the whole street) and move both lanes over
        const pick = hashStr(P.roadId) & 1 ? 1 : -1;
        const side = (pick === 1 ? P.sidewalkR : P.sidewalkL) ? pick : -pick;
        const room = 2 * hw - band, near = hw - band - room / 4, far = hw - band - (room * 3) / 4;
        if (side === 1) { parkR = true; fwdOff[0] = near; bwdOff[0] = far; }
        else { parkL = true; bwdOff[0] = -near; fwdOff[0] = -far; }
      }
    }
    const info = { fwd: [] as number[], bwd: [] as number[], parkR, parkL, cls };
    polyLanes.push(info);
    // trims: none at pass-through nodes; at a dead end (mostly roads leaving the map) room to turn round before it
    const trimAt = (node: number, t: number) => (passThrough(node) ? 0 : nodes[node].deadEnd ? Math.max(t, M.deadEndTurnRoom) : t);
    const tA = trimAt(P.nodeA, P.trimA), tB = trimAt(P.nodeB, P.trimB);
    const speed = P.maxspeed ? P.maxspeed / 3.6 : M.classSpeed[cls];
    // the junction surface is flat at the node's height over the plateau at each end (the exported profile keeps
    // following the terrain there): lane points inside the plateaus take the node height
    const S = sectionS(P), Lp = S[S.length - 1];
    const flatten = (raw: Float32Array) => {
      for (let i = 0; i < S.length; i++) {
        if (S[i] <= P.trimA && !P.deck) raw[i * 3 + 1] = J[P.nodeA].y;
        else if (S[i] >= Lp - P.trimB && !P.deck) raw[i * 3 + 1] = J[P.nodeB].y;
      }
      return raw;
    };
    for (const dir of [1, -1] as const) {
      const offs = dir === 1 ? fwdOff : bwdOff;
      offs.forEach((off, k) => {
        const raw = flatten(atOffset(P, off));
        const pts = dir === 1 ? raw : reverseTriples(raw);
        const cum = cumulative(pts);
        const e: LaneEdge = {
          id: edges.length, from: dir === 1 ? P.nodeA : P.nodeB, to: dir === 1 ? P.nodeB : P.nodeA, pts, cum, len: cum[cum.length - 1],
          trimStart: dir === 1 ? tA : tB, trimEnd: dir === 1 ? tB : tA, speed, cls, name: P.name || null, roadId: P.roadId,
          lane: k, lanesSameDir: offs.length, offset: dir === 1 ? off : -off, oneway: P.oneway !== 0, roundabout: ring,
          bridge: P.deck, halfWidth: hw, twin: -1, left: -1, right: -1,
          parking: k === 0 && (dir === 1 ? parkR : parkL),
        };
        edges.push(e);
        nodes[e.from].out.push(e.id);
        nodes[e.to].in.push(e.id);
        (dir === 1 ? info.fwd : info.bwd).push(e.id);
      });
    }
    for (let k = 0; k < info.fwd.length; k++) if (info.bwd.length) edges[info.fwd[k]].twin = info.bwd[Math.min(k, info.bwd.length - 1)];
    for (let k = 0; k < info.bwd.length; k++) if (info.fwd.length) edges[info.bwd[k]].twin = info.fwd[Math.min(k, info.fwd.length - 1)];
  });
  linkLaneNeighbours(edges);
  const oneWayCheck = checkOneWays(doc, polys, edges, polyLanes);
  const ringCheck = checkRing(polys, roadById, edges, polyLanes);
  const tRoads = performance.now();

  // ------------------------------------------------------------------ walk graph
  const walkBuild = buildWalkGraph(doc, geo, polys, polyLanes);
  const walk = walkBuild.nodes;
  const tWalk = performance.now();

  // ------------------------------------------------------------------ buildings, streets, index
  const buildings: Building[] = standing.map((bd) => {
    const pts = new Float32Array(bd.pts.length * 2);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    bd.pts.forEach((p, i) => { pts[i * 2] = p[0]; pts[i * 2 + 1] = p[1]; x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); });
    return { pts, h: bd.h, minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
  });
  const streets = chainStreets(polys, polyLanes);
  const index = new MapIndex(bounds, edges, walk, buildings);

  // ------------------------------------------------------------------ lookups
  const isBlocked = (x: number, z: number) => x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ || geo.isBlocked(x, z);
  /** Terrain without y; with y, the deck or ground under a point at that height (see LEVELS in cityMap.ts). */
  const heightAt = (x: number, z: number, y?: number) => {
    if (y === undefined || y !== y) return geo.heightAt(x, z);
    const near = geo.walkSurfaceAt(x, z, y);
    return near <= y + M.levelStep ? near : geo.heightAt(x, z); // a deck overhead (falling past it): the ground
  };
  const kerbPoint = (x: number, z: number, out: KerbHit, y?: number) => index.kerbPoint(x, z, out, y);
  const nearestWalk = (x: number, z: number, y?: number) => index.nearestWalk(x, z, y);

  // ------------------------------------------------------------------ places
  const pois: Poi[] = [];
  const KH: KerbHit = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
  const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
  /** A place on the pavement at (x, z) whose door is at (dx, dz): curb point, street and walk node from the map. */
  const addPoi = (name: string, kind: string, x: number, z: number, door: { x: number; z: number }, street?: string): Poi | null => {
    const y = geo.walkSurfaceAt(x, z, geo.heightAt(x, z));
    if (!kerbPoint(x, z, KH, y)) {
      // far from any road (the boardwalk, a pier): the kerb nearest the closest pavement
      let best: WalkNode | null = null, bd = Infinity;
      for (const n of walk) if (n.kind === 'sidewalk') { const d = Math.hypot(n.x - x, n.z - z); if (d < bd) { bd = d; best = n; } }
      if (!best || !kerbPoint(best.x, best.z, KH, best.y)) return null;
    }
    const e = edges[KH.edge];
    const p: Poi = {
      id: pois.length, name, kind, x, z, curbX: KH.x, curbZ: KH.z, kerbHeading: KH.heading, door,
      street: street ?? e.name ?? nearestStreetName(x, z), walkNode: nearestWalk(x, z, y),
    };
    pois.push(p);
    return p;
  };
  const LH: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
  function nearestStreetName(x: number, z: number): string {
    for (const r of [40, 120, 400]) if (index.nearestLane(x, z, r, false, LH) && edges[LH.edge].name) return edges[LH.edge].name!;
    return 'Georgetown';
  }

  // taxi ranks first (ids 0..), so the first fare and the spawn are near rank 1
  const taxiRanks: Poi[] = [];
  for (const r of RANKS) {
    const at = streetSpot(r.street, r.cross, r.along, r.lane, r.heading);
    if (!at) { console.warn(`Georgetown: no taxi rank site for ${r.name}`); continue; }
    const e = edges[at.edge];
    laneSample(e, at.s, LP);
    const rx = -Math.cos(LP.heading), rz = Math.sin(LP.heading);
    const kerbOff = e.halfWidth - e.offset; // lane centre -> kerb, to the right
    const cx = LP.x + rx * (kerbOff - M.kerbStopGap), cz = LP.z + rz * (kerbOff - M.kerbStopGap);
    const px = LP.x + rx * (kerbOff + G.sidewalkWidth / 2), pz = LP.z + rz * (kerbOff + G.sidewalkWidth / 2);
    const y = geo.walkSurfaceAt(px, pz, LP.y);
    const p: Poi = {
      id: pois.length, name: r.name, kind: 'taxiRank', x: px, z: pz, curbX: cx, curbZ: cz, kerbHeading: LP.heading,
      door: { x: LP.x + rx * (kerbOff + G.sidewalkWidth), z: LP.z + rz * (kerbOff + G.sidewalkWidth) }, street: e.name ?? r.street,
      walkNode: nearestWalk(px, pz, y),
    };
    pois.push(p);
    taxiRanks.push(p);
  }

  // places from the data (names invented by category; the same key as the shop signs so they match)
  const bById = new Map(standing.map((bd) => [bd.id, bd]));
  const srcPois = [...doc.pois].sort((p, q) => POI_ORDER(p.cat) - POI_ORDER(q.cat));
  for (const sp of srcPois) {
    const name = poiName(sp.cat, `${sp.id}:${seed}`);
    const kind = kindOf(sp.cat);
    const bd = sp.b ? bById.get(sp.b) : undefined;
    if (sp.b && !bd) continue; // its building was dropped from the world
    const place = bd ? frontOf(bd.pts, sp.x, sp.z) : openSpot(sp.x, sp.z);
    if (!place) continue;
    const poi = addPoi(name, kind, place.x, place.z, place.door);
    if (poi && bd && SIGN_CATS.test(sp.cat)) poi.signed = true; // facades.ts paints this name on the shop front
  }
  // homes: rowhouses and flats, spread over the residential streets (fixed by the map, never the seed)
  {
    const res = standing.filter((bd) => RESIDENTIAL.has(bd.type)).sort((p, q) => hashStr(p.id) - hashStr(q.id));
    let made = 0;
    for (const bd of res) {
      if (made >= M.homePois) break;
      const c = centroid(bd.pts);
      if (pois.some((p) => p.kind === 'apartment' && Math.hypot(p.x - c[0], p.z - c[1]) < 45)) continue;
      const place = frontOf(bd.pts, c[0], c[1]);
      if (!place) continue;
      const st = nearestStreetName(place.x, place.z);
      const no = 1000 + (hashStr(bd.id) % 2400);
      if (addPoi(`${no} ${st}`, 'apartment', place.x, place.z, place.door, st)) made++;
    }
  }
  // parks: one entrance each, on the walk network at the park's edge
  for (const pk of doc.parks) {
    if (!pk.name || pk.kind === 'landuse=cemetery') continue;
    const c = centroid(pk.pts);
    const n = walk[nearestWalk(c[0], c[1])];
    if (Math.hypot(n.x - c[0], n.z - c[1]) > 400) continue;
    addPoi(pk.name, 'park', n.x, n.z, { x: n.x, z: n.z });
  }
  // the waterfront
  for (const wf of WATERFRONT) {
    let best = -1, bd = Infinity;
    for (const n of walk) {
      if (n.kind !== 'waterfront' && n.kind !== 'plaza') continue;
      const d = Math.hypot(n.x - wf.x, n.z - wf.z);
      if (d < bd) { bd = d; best = n.id; }
    }
    if (best >= 0 && bd < 150) addPoi(wf.name, 'pier', walk[best].x, walk[best].z, { x: walk[best].x, z: walk[best].z });
  }

  // ------------------------------------------------------------------ parking
  const parkingSpots = buildParking(doc, geo, polys, polyLanes, edges, taxiRanks, R, physics);

  // ------------------------------------------------------------------ spawn
  let spawn = { x: taxiRanks[0]?.x ?? 0, z: taxiRanks[0]?.z ?? 0, heading: Math.PI / 2 };
  {
    const at = streetSpot(SPAWN.street, SPAWN.cross, SPAWN.along, 1, SPAWN.heading);
    if (at) {
      const e = edges[at.edge];
      laneSample(e, at.s, LP);
      const rx = -Math.cos(LP.heading), rz = Math.sin(LP.heading);
      const off = e.halfWidth - e.offset + G.sidewalkWidth / 2;
      const x = LP.x + rx * off, z = LP.z + rz * off;
      if (!isBlocked(x, z)) spawn = { x, z, heading: LP.heading };
    }
  }

  // ------------------------------------------------------------------ minimap
  const drawMinimapBase = (ctx: CanvasRenderingContext2D, o: MinimapDrawOpts) => paintMinimap(ctx, o, doc, standing, geo, polys, polyLanes);

  const tEnd = performance.now();
  const stats = {
    worldMs: Math.round(tWorld - t0), roadsMs: Math.round(tRoads - tWorld), walkMs: Math.round(tWalk - tRoads), placesMs: Math.round(tEnd - tWalk),
    totalMs: Math.round(tEnd - t0), world: geo.stats, oneWays: oneWayCheck, roundabout: ringCheck, walkDropped: walkBuild.dropped,
  };
  if (oneWayCheck.wrong.length) console.warn(`Georgetown: one-way lanes against the data: ${oneWayCheck.wrong.join(', ')}`);
  if (ringCheck.problem) console.warn(`Georgetown: Washington Circle: ${ringCheck.problem}`);

  const map: CityMap & { geo: GeoWorld; buildStats: typeof stats } = {
    id: 'georgetown',
    attribution: doc.meta.attribution,
    bounds,
    center: { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 },
    spawn,
    waterLevel: G.riverLevel,
    roads: { nodes, edges },
    walk: { nodes: walk },
    streets,
    buildings,
    pois,
    taxiRanks,
    parkingSpots,
    heightAt,
    isRoad: (x, z) => geo.isRoad(x, z),
    isBlocked,
    isWater: (x, z) => geo.isWater(x, z),
    waterLevelAt: (x, z) => geo.waterLevelAt(x, z),
    nearestLane: (x: number, z: number, maxDist: number, out: LaneHit, y?: number) => index.nearestLane(x, z, maxDist, false, out, y),
    nearestWalk,
    kerbPoint,
    drawMinimapBase,
    litWindowMat: geo.litWindowMat,
    lampMat: geo.lampMat,
    lampPoolMat: geo.lampPoolMat,
    groundMats: geo.groundMats,
    water: geo.water.meshes[0] ?? new THREE.Mesh(),
    boats: [],
    update: (time: number, camera: THREE.Camera) => geo.update(time, camera),
    setQuality: (q) => geo.setQuality(q),
    geo,
    buildStats: stats,
  };
  return map;

  // ---------------------------------------------------------------- helpers (closures over the graph)
  /**
   * Kerb lane of `street` at `along` metres from its junction with `cross` (lane leaving it: 1, arriving: -1); with
   * `heading`, the piece of `street` whose lane there points closest to it.
   */
  function streetSpot(street: string, cross: string, along: number, lane: 1 | -1, heading?: number): { edge: number; s: number } | null {
    const node = nodes.find((n) => {
      const names = new Set([...n.in, ...n.out].map((i) => edges[i].name));
      return names.has(street) && names.has(cross);
    });
    if (!node) return null;
    // the poly of `street` leaving that node that is long enough, preferring straight on
    const cand = polys.map((P, pi) => ({ P, pi })).filter(({ P }) => P.name === street && (P.nodeA === node.id || P.nodeB === node.id) && !P.deck);
    let best: { edge: number; s: number } | null = null, bestScore = -Infinity;
    for (const { P, pi } of cand) {
      const atStart = P.nodeA === node.id;
      const L = polyLength(P);
      const sFromNode = Math.min(Math.max(along, 0), L - 8);
      // lane leaving the node: travels away from it
      const leaving = atStart ? polyLanes[pi].fwd : polyLanes[pi].bwd;
      const arriving = atStart ? polyLanes[pi].bwd : polyLanes[pi].fwd;
      const list = lane === 1 ? leaving : arriving;
      if (!list.length) continue;
      const e = edges[list[0]];
      const lo = e.trimStart + 4, hi = e.len - e.trimEnd - 4;
      if (hi < lo) continue; // all junction box
      const s = Math.max(lo, Math.min(hi, lane === 1 ? sFromNode : e.len - sFromNode)); // as close to `along` as fits
      laneSample(e, s, LP);
      const score = heading === undefined ? 0 : Math.cos(LP.heading - heading);
      if (score > bestScore) { bestScore = score; best = { edge: e.id, s }; }
    }
    return best;
  }

  /** The pavement in front of a building's street face nearest (x, z), and the door on that face. */
  function frontOf(ring: Pt[], x: number, z: number): { x: number; z: number; door: { x: number; z: number } } | null {
    const y = geo.heightAt(x, z);
    if (!kerbPoint(x, z, KH, y)) return null;
    // door: the point of the footprint nearest the kerb
    let dx = x, dz = z, bd = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const ex = c[0] - a[0], ez = c[1] - a[1], L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((KH.x - a[0]) * ex + (KH.z - a[1]) * ez) / L2));
      const qx = a[0] + ex * t, qz = a[1] + ez * t, d = Math.hypot(KH.x - qx, KH.z - qz);
      if (d < bd) { bd = d; dx = qx; dz = qz; }
    }
    const ux = (KH.x - dx) / (bd || 1), uz = (KH.z - dz) / (bd || 1);
    // step out of the door onto the pavement (never into the road)
    for (const step of [1.2, 2, 3, 0.6]) {
      if (step > bd - 0.5) continue;
      const px = dx + ux * step, pz = dz + uz * step;
      if (!isBlocked(px, pz) && !geo.isRoad(px, pz)) return { x: px, z: pz, door: { x: dx, z: dz } };
    }
    return openSpot(dx + ux * Math.min(1.2, bd * 0.5), dz + uz * Math.min(1.2, bd * 0.5), { x: dx, z: dz });
  }
  /** (x, z) if people can stand there, else the nearest walk node. */
  function openSpot(x: number, z: number, door?: { x: number; z: number }): { x: number; z: number; door: { x: number; z: number } } {
    if (!isBlocked(x, z) && !geo.isWater(x, z) && !geo.isRoad(x, z)) return { x, z, door: door ?? { x, z } };
    const n = walk[nearestWalk(x, z)];
    return { x: n.x, z: n.z, door: door ?? { x: n.x, z: n.z } };
  }
}

// ======================================================================================================
// geometry helpers

/** Points at lateral offset `o` (m right of the poly's pts direction) at every section: x, y, z triples. */
function atOffset(P: GeoRoadPoly, o: number): Float32Array {
  const L = P.kerbL, R = P.kerbR, t = (o + P.halfWidth) / (2 * P.halfWidth);
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = L[i] + (R[i] - L[i]) * t;
  return out;
}
function reverseTriples(a: Float32Array): Float32Array {
  const n = a.length / 3, out = new Float32Array(a.length);
  for (let i = 0; i < n; i++) { const j = n - 1 - i; out[i * 3] = a[j * 3]; out[i * 3 + 1] = a[j * 3 + 1]; out[i * 3 + 2] = a[j * 3 + 2]; }
  return out;
}
function cumulative(pts: Float32Array): Float32Array {
  const n = pts.length / 3, cum = new Float32Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 2] - pts[k * 3 - 1]);
  return cum;
}
/** Centre-line arc length at each section (the mid-line between the kerbs). */
function sectionS(P: GeoRoadPoly): Float32Array {
  const n = P.kerbL.length / 3, out = new Float32Array(n);
  let px = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    const x = (P.kerbL[i * 3] + P.kerbR[i * 3]) / 2, z = (P.kerbL[i * 3 + 2] + P.kerbR[i * 3 + 2]) / 2;
    if (i > 0) out[i] = out[i - 1] + Math.hypot(x - px, z - pz);
    px = x; pz = z;
  }
  return out;
}
function polyLength(P: GeoRoadPoly): number {
  const s = sectionS(P);
  return s[s.length - 1];
}
/** Sample a triple array at arc length s (given the per-point arc lengths); writes x, y, z into out. */
function sampleAt(pts: Float32Array, S: Float32Array, s: number, out: number[]): number[] {
  const n = S.length;
  if (s <= 0) { out[0] = pts[0]; out[1] = pts[1]; out[2] = pts[2]; return out; }
  if (s >= S[n - 1]) { out[0] = pts[n * 3 - 3]; out[1] = pts[n * 3 - 2]; out[2] = pts[n * 3 - 1]; return out; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - S[lo]) / (S[hi] - S[lo] || 1);
  for (let c = 0; c < 3; c++) out[c] = pts[lo * 3 + c] + (pts[hi * 3 + c] - pts[lo * 3 + c]) * t;
  return out;
}
function centroid(pts: Pt[]): Pt {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}

// ======================================================================================================
// checks against the data

/** Every one-way lane must travel the way the data's way does (oneway 1: along its points, -1: against them). */
function checkOneWays(doc: GeoDoc, polys: GeoRoadPoly[], edges: LaneEdge[], lanes: { fwd: number[]; bwd: number[] }[]) {
  const wrong: string[] = [];
  let checked = 0;
  polys.forEach((P, pi) => {
    const road = doc.roads.find((r) => r.id === P.roadId);
    if (!road || !road.oneway) return;
    for (const id of [...lanes[pi].fwd, ...lanes[pi].bwd]) {
      const e = edges[id];
      // travel direction of the lane vs the data way's direction near the lane's middle
      const k = Math.floor(e.pts.length / 6) * 3;
      const ex = e.pts[k + 3] - e.pts[k], ez = e.pts[k + 5] - e.pts[k + 2];
      const mx = e.pts[k], mz = e.pts[k + 2];
      let best = Infinity, dx = 0, dz = 0;
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1], c = road.pts[i];
        const sx = c[0] - a[0], sz = c[1] - a[1], L2 = sx * sx + sz * sz || 1;
        const t = Math.max(0, Math.min(1, ((mx - a[0]) * sx + (mz - a[1]) * sz) / L2));
        const d = Math.hypot(a[0] + sx * t - mx, a[1] + sz * t - mz);
        if (d < best) { best = d; dx = sx; dz = sz; }
      }
      checked++;
      if ((ex * dx + ez * dz) * road.oneway <= 0 && road.junction !== 'roundabout') wrong.push(`${e.name ?? e.roadId} lane ${e.id}`);
      if (road.junction === 'roundabout' && (ex * dx + ez * dz) * road.oneway <= 0) wrong.push(`ring lane ${e.id}`);
    }
  });
  return { checked, wrong };
}

/** Washington Circle: a one-way ring whose lanes run counter-clockwise seen from above (US right-hand traffic). */
function checkRing(polys: GeoRoadPoly[], roadById: Map<string, GeoDoc['roads'][number]>, edges: LaneEdge[], lanes: { fwd: number[]; bwd: number[] }[]) {
  let cx = 0, cz = 0, n = 0, ccw = 0, cw = 0, ringEdges = 0;
  const ringNodes = new Set<number>();
  polys.forEach((P, pi) => {
    if (roadById.get(P.roadId)?.junction !== 'roundabout') return;
    ringNodes.add(P.nodeA);
    ringNodes.add(P.nodeB);
    for (let i = 0; i < P.centre.length; i += 3) { cx += P.centre[i]; cz += P.centre[i + 2]; n++; }
    ringEdges += lanes[pi].fwd.length + lanes[pi].bwd.length;
  });
  if (!n) return { ringEdges: 0, ringNodes: 0, spokes: 0, ccw: 0, cw: 0, problem: 'no roundabout in the data' };
  cx /= n; cz /= n;
  const spokeRoads = new Set<string>();
  for (const e of edges) {
    if (!e.roundabout) {
      if (ringNodes.has(e.from) || ringNodes.has(e.to)) spokeRoads.add(`${e.roadId}@${ringNodes.has(e.from) ? e.from : e.to}`);
      continue;
    }
    // sign of (point - centre) x travel in a north-up view (x right, north = -z): positive = counter-clockwise
    const k = Math.floor(e.pts.length / 6) * 3;
    const px = e.pts[k] - cx, pn = -(e.pts[k + 2] - cz);
    const tx = e.pts[k + 3] - e.pts[k], tn = -(e.pts[k + 5] - e.pts[k + 2]);
    if (px * tn - pn * tx > 0) ccw++; else cw++;
  }
  const problem = cw > 0 ? `${cw} ring lanes run clockwise` : ringEdges === 0 ? 'ring has no lanes' : '';
  return { ringEdges, ringNodes: ringNodes.size, spokes: spokeRoads.size, ccw, cw, problem };
}

// ======================================================================================================
// walk graph

interface WB {
  nodes: WalkNode[];
  add(x: number, y: number, z: number, kind: WalkKind, street: string | null): number;
  link(a: number, b: number): void;
}
function walkBuilder(): WB {
  const nodes: WalkNode[] = [];
  return {
    nodes,
    add(x, y, z, kind, street) {
      nodes.push({ id: nodes.length, x, y, z, nbrs: [], kind, street });
      return nodes.length - 1;
    },
    link(a, b) {
      if (a < 0 || b < 0 || a === b || nodes[a].nbrs.includes(b)) return;
      nodes[a].nbrs.push(b);
      nodes[b].nbrs.push(a);
    },
  };
}

/** Uniform grid over walk nodes for neighbour searches while building (rebuilt as nodes are added). */
class NodeGrid {
  private cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}
  private key(i: number, j: number) { return (i + 2048) * 4096 + (j + 2048); }
  add(id: number, x: number, z: number) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(id);
  }
  /** Nearest node within r passing `ok`, or -1. */
  nearest(nodes: WalkNode[], x: number, z: number, r: number, ok: (n: WalkNode) => boolean): number {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    let best = -1, bd = r;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.cells.get(this.key(i, j));
      if (!l) continue;
      for (const id of l) {
        const n = nodes[id];
        const d = Math.hypot(n.x - x, n.z - z);
        if (d <= bd && ok(n)) { bd = d; best = id; }
      }
    }
    return best;
  }
}

/** The walk graph; `dropped` lists the pieces cut off from the main network (too far to join) that were left out. */
function buildWalkGraph(doc: GeoDoc, geo: GeoWorld, polys: GeoRoadPoly[], lanes: { cls: RoadClass }[]): { nodes: WalkNode[]; dropped: string[] } {
  const W = walkBuilder();
  const grid = new NodeGrid(16);
  const add = (x: number, y: number, z: number, kind: WalkKind, street: string | null) => {
    const id = W.add(x, y, z, kind, street);
    grid.add(id, x, z);
    return id;
  };
  const SW = G.sidewalkWidth, step = M.walkNodeSpacing, gap = M.walkLevelGap;
  const tmp = [0, 0, 0];
  const blocked = (x: number, z: number) => geo.isBlocked(x, z) || geo.isWater(x, z);
  /** Does the straight link a-b cross a building (at ground level, not under a deck)? */
  const throughBuilding = (a: WalkNode, b: WalkNode) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
    for (let k = 1; k < n; k++) if ((geo.kindAt(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n) & (K.BUILDING | K.DECK)) === K.BUILDING) return true;
    return false;
  };

  // ---- sidewalks along each kerb with one (ends[pi*2 + side] = [node near A, node near B]) ----
  const ends = new Int32Array(polys.length * 4).fill(-1);
  const endIdx = (pi: number, side: number, atB: number) => pi * 4 + (side > 0 ? 2 : 0) + atB;
  polys.forEach((P, pi) => {
    if (lanes[pi].cls === 'parkway') return;
    const S = sectionS(P), L = S[S.length - 1];
    const sA = Math.min(P.trimA, L / 2), sB = Math.max(L - P.trimB, sA);
    const centre = atOffset(P, 0);
    for (const side of [-1, 1]) {
      if (!(side < 0 ? P.sidewalkL : P.sidewalkR)) continue;
      const line = atOffset(P, side * (P.halfWidth + SW / 2));
      const n = Math.max(1, Math.round((sB - sA) / step));
      let prev = -1, first = -1, last = -1;
      for (let k = 0; k <= n; k++) {
        const s = sA + ((sB - sA) * k) / n;
        sampleAt(line, S, s, tmp);
        const x = tmp[0], z = tmp[2];
        const cy = sampleAt(centre, S, s, tmp)[1];
        if (blocked(x, z)) { prev = -1; continue; }
        const id = add(x, geo.walkSurfaceAt(x, z, cy), z, 'sidewalk', P.name || null);
        if (prev >= 0) W.link(prev, id);
        if (first < 0 && k === 0) first = id;
        prev = id;
        if (k === n) last = id;
      }
      ends[endIdx(pi, side, 0)] = first;
      ends[endIdx(pi, side, 1)] = last;
    }
  });

  // ---- junction corners: the sidewalks of neighbouring arms meet round the kerb ----
  type Arm = { pi: number; atStart: boolean; theta: number };
  const arms: Arm[][] = geo.junctions.map(() => []);
  polys.forEach((P, pi) => {
    for (const atStart of [true, false]) {
      const node = atStart ? P.nodeA : P.nodeB;
      const c = P.centre, n = c.length / 3;
      // direction from the node toward a point ~6 m along the road
      let k = atStart ? 0 : n - 1, run = 0;
      const x0 = c[k * 3], z0 = c[k * 3 + 2];
      while (run < 6 && (atStart ? k < n - 1 : k > 0)) { const k2 = atStart ? k + 1 : k - 1; run += Math.hypot(c[k2 * 3] - c[k * 3], c[k2 * 3 + 2] - c[k * 3 + 2]); k = k2; }
      arms[node].push({ pi, atStart, theta: Math.atan2(c[k * 3 + 2] - z0, c[k * 3] - x0) });
    }
  });
  const crossMids: number[] = []; // data crossing midpoints (x, z)
  geo.junctions.forEach((jn, ji) => {
    const A = arms[ji].sort((p, q) => p.theta - q.theta);
    const m = A.length;
    if (m < 2) return;
    const outline = jn.outline;
    for (let k = 0; k < m; k++) {
      const a = A[k], c = A[(k + 1) % m];
      if (m === 2 && k === 1 && a.pi === c.pi) continue;
      const aSide = a.atStart ? 1 : -1, cSide = c.atStart ? -1 : 1; // a's side toward c (n side) and c's side toward a (m side)
      const ea = ends[endIdx(a.pi, aSide, a.atStart ? 0 : 1)], ec = ends[endIdx(c.pi, cSide, c.atStart ? 0 : 1)];
      if (ea < 0 || ec < 0 || ea === ec) continue;
      const na = W.nodes[ea], nc = W.nodes[ec];
      const d = Math.hypot(na.x - nc.x, na.z - nc.z);
      if (d > 60 || Math.abs(na.y - nc.y) > gap * 2) continue;
      if (d < 3 || outline.length < 4) { W.link(ea, ec); continue; }
      // corner node: the kerb outline point nearest the middle, pushed out onto the pavement
      const mx = (na.x + nc.x) / 2, mz = (na.z + nc.z) / 2;
      let bx = 0, bz = 0, bd = Infinity;
      for (let i = 0; i < outline.length; i += 2) {
        const dd = Math.hypot(outline[i] - mx, outline[i + 1] - mz);
        if (dd < bd) { bd = dd; bx = outline[i]; bz = outline[i + 1]; }
      }
      const ox = bx - jn.x, oz = bz - jn.z, ol = Math.hypot(ox, oz) || 1;
      const qx = bx + (ox / ol) * (SW / 2), qz = bz + (oz / ol) * (SW / 2);
      const useCorner = bd < 12 && !blocked(qx, qz) && !geo.isRoad(qx, qz) && Math.hypot(qx - na.x, qz - na.z) < d && Math.hypot(qx - nc.x, qz - nc.z) < d;
      if (!useCorner) { W.link(ea, ec); continue; }
      const q = add(qx, geo.walkSurfaceAt(qx, qz, (na.y + nc.y) / 2), qz, 'sidewalk', polys[a.pi].name || null);
      W.link(ea, q);
      W.link(q, ec);
    }
  });

  // ---- crossings: the data's zebras, joined to the sidewalks at each end ----
  const nameAt = (x: number, z: number) => {
    let best = '', bd = Infinity;
    polys.forEach((P) => {
      if (!P.name) return;
      for (let i = 0; i < P.centre.length; i += 9) {
        const d = Math.hypot(P.centre[i] - x, P.centre[i + 2] - z);
        if (d < bd) { bd = d; best = P.name; }
      }
    });
    return best || null;
  };
  for (const f of doc.footways) {
    if (f.kind !== 'crossing' || f.pts.length < 2) continue;
    const p0 = f.pts[0], p1 = f.pts[f.pts.length - 1];
    const y0 = f.bridge ? geo.walkSurfaceAt(p0[0], p0[1]) : geo.walkSurfaceAt(p0[0], p0[1], geo.heightAt(p0[0], p0[1]));
    const y1 = f.bridge ? geo.walkSurfaceAt(p1[0], p1[1]) : geo.walkSurfaceAt(p1[0], p1[1], geo.heightAt(p1[0], p1[1]));
    const sidewalkOk = (y: number) => (n: WalkNode) => n.kind === 'sidewalk' && Math.abs(n.y - y) <= gap;
    const a = grid.nearest(W.nodes, p0[0], p0[1], M.walkJoinRange, sidewalkOk(y0));
    const c = grid.nearest(W.nodes, p1[0], p1[1], M.walkJoinRange, sidewalkOk(y1));
    if (a < 0 || c < 0 || a === c) continue;
    const name = nameAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
    const x0 = add(p0[0], y0, p0[1], 'crossing', name), x1 = add(p1[0], y1, p1[1], 'crossing', name);
    W.link(a, x0); W.link(x0, x1); W.link(x1, c);
    crossMids.push((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
  }
  // ---- crossings the data lacks: across each arm of a real junction, at its mouth ----
  geo.junctions.forEach((jn, ji) => {
    if (jn.degree < 3 && !jn.signals && !jn.stop) return;
    for (const a of arms[ji]) {
      const P = polys[a.pi];
      if (lanes[a.pi].cls === 'parkway') continue;
      const el = ends[endIdx(a.pi, -1, a.atStart ? 0 : 1)], er = ends[endIdx(a.pi, 1, a.atStart ? 0 : 1)];
      if (el < 0 || er < 0) continue;
      const S = sectionS(P), L = S[S.length - 1];
      const s = a.atStart ? Math.min(P.trimA, L / 2) : Math.max(L - P.trimB, L / 2);
      const mouth = sampleAt(atOffset(P, 0), S, s, [0, 0, 0]);
      let covered = false;
      for (let i = 0; i < crossMids.length && !covered; i += 2) if (Math.hypot(crossMids[i] - mouth[0], crossMids[i + 1] - mouth[2]) < P.halfWidth + 6) covered = true;
      if (covered) continue;
      const kl = sampleAt(atOffset(P, -P.halfWidth + 0.4), S, s, [0, 0, 0]);
      const kr = sampleAt(atOffset(P, P.halfWidth - 0.4), S, s, [0, 0, 0]);
      const xl = add(kl[0], kl[1], kl[2], 'crossing', P.name || null), xr = add(kr[0], kr[1], kr[2], 'crossing', P.name || null);
      W.link(el, xl); W.link(xl, xr); W.link(xr, er);
    }
  });

  // ---- footways, paths, the towpath, the waterfront, steps (shared vertices are shared nodes) ----
  const vkey = new Map<string, number>();
  const pathEnds: number[] = [];
  for (const f of doc.footways) {
    if (f.kind === 'sidewalk' || f.kind === 'crossing' || f.pts.length < 2) continue;
    if (f.kind === 'pedestrian' && f.area) continue; // the plaza (below)
    const kind: WalkKind = f.towpath ? 'towpath' : f.pier || f.surface === 'wood' || f.surface === 'paving_stones' ? 'waterfront' : 'path';
    const deck = !!(f.bridge || f.pier || f.surface === 'wood');
    const yAt = (x: number, z: number) => (deck ? geo.walkSurfaceAt(x, z) : geo.walkSurfaceAt(x, z, geo.heightAt(x, z)));
    // a path on the ground stops at a building in its way (synthesized footprints overlap a few data paths); the
    // pieces either side become path ends, joined to the network below
    const inBuilding = (x: number, z: number) => !deck && (geo.kindAt(x, z) & (K.BUILDING | K.DECK)) === K.BUILDING;
    let prev = -1, cut = false;
    const gapAt = () => { if (prev >= 0) pathEnds.push(prev); prev = -1; cut = true; };
    /** Join the path's last node to `id` unless the stretch between them crosses a building. */
    const step2 = (id: number) => {
      if (prev >= 0 && !deck) {
        const a = W.nodes[prev], c = W.nodes[id], n = Math.ceil(Math.hypot(c.x - a.x, c.z - a.z));
        for (let k = 1; k < n; k++) if (inBuilding(a.x + ((c.x - a.x) * k) / n, a.z + ((c.z - a.z) * k) / n)) { gapAt(); break; }
      }
      if (prev < 0 && cut) pathEnds.push(id);
      W.link(prev, id);
      prev = id;
    };
    for (let i = 0; i < f.pts.length; i++) {
      const p = f.pts[i];
      if (i > 0) {
        const q = f.pts[i - 1], L = Math.hypot(p[0] - q[0], p[1] - q[1]), n = Math.ceil(L / step);
        for (let k = 1; k < n; k++) {
          const x = q[0] + ((p[0] - q[0]) * k) / n, z = q[1] + ((p[1] - q[1]) * k) / n;
          if (inBuilding(x, z)) { gapAt(); continue; }
          step2(add(x, yAt(x, z), z, kind, f.name));
        }
      }
      if (inBuilding(p[0], p[1])) { gapAt(); continue; }
      const key = `${p[0]},${p[1]}`;
      let id = vkey.get(key) ?? -1;
      if (id < 0 || Math.abs(W.nodes[id].y - yAt(p[0], p[1])) > gap) {
        id = add(p[0], yAt(p[0], p[1]), p[1], kind, f.name);
        vkey.set(key, id);
      }
      step2(id);
      if (i === 0 || i === f.pts.length - 1) pathEnds.push(id);
    }
  }
  // the plaza by the harbour: a grid of nodes over the paved area
  for (const f of doc.footways) {
    if (f.kind !== 'pedestrian' || !f.area) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of f.pts) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    const nx = Math.floor((x1 - x0) / step), nz = Math.floor((z1 - z0) / step);
    const ids = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      const x = x0 + step / 2 + i * step, z = z0 + step / 2 + j * step;
      if (!pointInPoly(x, z, f.pts) || (f.holes ?? []).some((h) => pointInPoly(x, z, h)) || blocked(x, z)) continue;
      const id = add(x, geo.walkSurfaceAt(x, z, geo.heightAt(x, z)), z, 'plaza', null);
      ids[i * (nz + 1) + j] = id;
      if (i > 0) W.link(ids[(i - 1) * (nz + 1) + j], id);
      if (j > 0) W.link(ids[i * (nz + 1) + j - 1], id);
    }
    for (let k = 0; k < ids.length; k++) if (ids[k] >= 0 && W.nodes[ids[k]].nbrs.length < 4) pathEnds.push(ids[k]);
  }
  // join path ends (and plaza edges) to the nearest node of another kind or way on their level
  for (const id of pathEnds) {
    const n = W.nodes[id];
    // not back onto its own way: skip itself and anything within two links of it
    const near = (o: WalkNode) => o.id === id || n.nbrs.includes(o.id) || n.nbrs.some((u) => W.nodes[u].nbrs.includes(o.id));
    const j = grid.nearest(W.nodes, n.x, n.z, M.walkJoinRange, (o) => Math.abs(o.y - n.y) <= gap && !near(o) && !throughBuilding(n, o));
    if (j >= 0) W.link(id, j);
  }

  // ---- one network: join cut-off pieces to the main part if close (same level), else drop them ----
  const N = W.nodes.length;
  const comp = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    const c = sizes.length, st = [s];
    comp[s] = c;
    let size = 0;
    while (st.length) { const v = st.pop()!; size++; for (const u of W.nodes[v].nbrs) if (comp[u] < 0) { comp[u] = c; st.push(u); } }
    sizes.push(size);
  }
  let main = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
  const inMain = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (comp[i] === main) inMain[i] = 1;
  const order = sizes.map((_, c) => c).filter((c) => c !== main).sort((p, q) => sizes[q] - sizes[p]);
  const members: number[][] = sizes.map(() => []);
  for (let i = 0; i < N; i++) members[comp[i]].push(i);
  const dropped: string[] = [];
  for (const c of order) {
    let bestA = -1, bestB = -1, bd = Infinity;
    for (const a of members[c]) {
      const n = W.nodes[a];
      const j = grid.nearest(W.nodes, n.x, n.z, M.walkBridgeRange, (o) => inMain[o.id] === 1 && Math.abs(o.y - n.y) <= M.walkBridgeLevelGap && !throughBuilding(n, o));
      if (j >= 0) { const d = Math.hypot(W.nodes[j].x - n.x, W.nodes[j].z - n.z); if (d < bd) { bd = d; bestA = a; bestB = j; } }
    }
    if (bestA < 0) {
      const n0 = W.nodes[members[c][0]];
      dropped.push(`${members[c].length} ${n0.kind} node(s) near (${n0.x.toFixed(0)}, ${n0.z.toFixed(0)})${n0.street ? ` ${n0.street}` : ''}`);
      continue;
    }
    W.link(bestA, bestB);
    for (const a of members[c]) inMain[a] = 1;
  }
  // compact: keep the main network only
  const remap = new Int32Array(N).fill(-1);
  const out: WalkNode[] = [];
  for (let i = 0; i < N; i++) if (inMain[i]) { remap[i] = out.length; out.push(W.nodes[i]); }
  for (const n of out) {
    n.id = remap[n.id];
    n.nbrs = n.nbrs.map((u) => remap[u]).filter((u) => u >= 0);
  }
  return { nodes: out, dropped };
}

// ======================================================================================================
// parking

function buildParking(doc: GeoDoc, geo: GeoWorld, polys: GeoRoadPoly[], lanes: { fwd: number[]; bwd: number[]; parkR: boolean; parkL: boolean; cls: RoadClass }[], edges: LaneEdge[], ranks: Poi[], R: typeof RAPIER, physics: RAPIER.World): ParkingSpot[] {
  const spots: ParkingSpot[] = [];
  // a parked car must not stand in anything solid (a tree or lamp in a car-park bay, a wall or a slope where a lane
  // meets a bridge): the box of the biggest car type, lifted clear of the surface and its slope, against the world
  physics.step(); // only static bodies exist yet: this brings the scene-query tree up to date with the world's colliders
  let hx = 0, hz = 0;
  for (const t of Object.values(V.types)) { hx = Math.max(hx, t.halfExtents[0]); hz = Math.max(hz, t.halfExtents[2]); }
  const box = new R.Cuboid(hx, M.parkingCheckHalfHeight, hz);
  const rot = { x: 0, y: 0, z: 0, w: 1 }, at = { x: 0, y: 0, z: 0 };
  let solidHit = false;
  const onHit = () => { solidHit = true; return false; };
  const solid = (x: number, y: number, z: number, heading: number) => {
    const fx = Math.sin(heading) * hz, fz = Math.cos(heading) * hz;
    const lift = Math.max(Math.abs(geo.roadSurfaceAt(x + fx, z + fz, y) - y), Math.abs(geo.roadSurfaceAt(x - fx, z - fz, y) - y));
    rot.y = Math.sin(heading / 2); rot.w = Math.cos(heading / 2);
    at.x = x; at.y = y + M.parkingCheckClearance + lift + M.parkingCheckHalfHeight; at.z = z;
    solidHit = false;
    physics.intersectionsWithShape(at, rot, box, onHit, R.QueryFilterFlags.ONLY_FIXED);
    return solidHit;
  };
  // things the kerb must keep clear of
  const clear: number[] = []; // x, z, radius
  for (const f of doc.footways) if (f.kind === 'crossing' && f.pts.length >= 2) {
    const a = f.pts[0], c = f.pts[f.pts.length - 1];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    for (let t = 0; t <= 1; t += 1 / Math.max(1, Math.ceil(L / 3))) clear.push(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, M.parkingCrossingGap);
  }
  for (const r of ranks) clear.push(r.curbX, r.curbZ, M.parkingRankGap);
  for (const p of doc.props) if (p[2] === 'bus_stop') clear.push(p[0], p[1], M.parkingBusStopGap);
  const isClear = (x: number, z: number) => {
    for (let i = 0; i < clear.length; i += 3) if (Math.hypot(clear[i] - x, clear[i + 1] - z) < clear[i + 2]) return false;
    return true;
  };
  const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };
  polys.forEach((P, pi) => {
    const info = lanes[pi];
    for (const id of [info.fwd[0], info.bwd[0]]) {
      if (id === undefined) continue;
      const e = edges[id];
      if (!e.parking) continue;
      // the junction boxes at both ends (the real plateaus, also at pass-through nodes)
      const tS = e.from === P.nodeA ? P.trimA : P.trimB, tE = e.from === P.nodeA ? P.trimB : P.trimA;
      const s0 = tS + V.parkingJunctionGap, s1 = e.len - tE - V.parkingJunctionGap;
      const shift = e.halfWidth - M.parkingBand / 2 - e.offset; // lane centre -> parked car centre, to the right
      for (let s = s0 + V.kerbSlotSpacing / 2; s <= s1 - V.kerbSlotSpacing / 2 + 0.01; s += V.kerbSlotSpacing) {
        laneSample(e, s, LP);
        const x = LP.x - Math.cos(LP.heading) * shift, z = LP.z + Math.sin(LP.heading) * shift;
        if (!geo.isRoad(x, z) || geo.isBlocked(x, z) || !isClear(x, z)) continue;
        const y = geo.roadSurfaceAt(x, z, LP.y);
        if (solid(x, y, z, LP.heading)) continue;
        spots.push({ x, y, z, heading: LP.heading, cls: e.cls, street: e.name, lot: -1, edge: e.id, s });
      }
    }
  });
  // car parks: every painted bay
  geo.lotStalls.forEach((lot, li) => {
    const st = lot.stalls;
    for (let i = 0; i < st.length; i += 4) {
      if (solid(st[i], st[i + 1], st[i + 2], st[i + 3])) continue;
      spots.push({ x: st[i], y: st[i + 1], z: st[i + 2], heading: st[i + 3], cls: 'lot', street: null, lot: li, edge: -1, s: 0 });
    }
  });
  return spots;
}

// ======================================================================================================
// minimap streets and painting

/** Named streets as polylines (consecutive pieces of the same name chained through their junctions). */
function chainStreets(polys: GeoRoadPoly[], lanes: { cls: RoadClass }[]): StreetLine[] {
  const used = new Uint8Array(polys.length);
  const byNode = new Map<number, number[]>();
  polys.forEach((P, i) => {
    for (const n of [P.nodeA, P.nodeB]) { let l = byNode.get(n); if (!l) byNode.set(n, (l = [])); l.push(i); }
  });
  const xz = (P: GeoRoadPoly, rev: boolean) => {
    const out: number[] = [], c = P.centre, n = c.length / 3;
    for (let k = 0; k < n; k++) { const i = rev ? n - 1 - k : k; out.push(c[i * 3], c[i * 3 + 2]); }
    return out;
  };
  const lines: StreetLine[] = [];
  polys.forEach((P, i) => {
    if (used[i] || !P.name) return;
    used[i] = 1;
    let pts = xz(P, false);
    // extend forward from nodeB, then backward from nodeA
    for (const forward of [true, false]) {
      let node = forward ? P.nodeB : P.nodeA;
      for (let guard = 0; guard < 200; guard++) {
        const next = (byNode.get(node) ?? []).find((j) => !used[j] && polys[j].name === P.name);
        if (next === undefined) break;
        used[next] = 1;
        const Q = polys[next];
        const fromA = Q.nodeA === node;
        const seg = xz(Q, !fromA);
        pts = forward ? pts.concat(seg.slice(2)) : seg.slice(0, -2).concat(pts);
        node = fromA ? Q.nodeB : Q.nodeA;
      }
    }
    lines.push({ name: P.name, cls: lanes[i].cls, pts });
  });
  return lines;
}

// same palette as the grid city's minimap (land, parks, water, buildings, dark roads), roads a shade lighter by class
const MM = {
  land: '#cfc9bf', park: '#6fa84f', cemetery: '#5f9145', water: '#2f7fb3', canal: '#3d8cc0', plaza: '#ddd2bb',
  lot: '#7c7d82', building: '#9a9aa3', pier: '#a0754f', path: '#e9dfc8', kerb: '#b8b2a7', deckEdge: '#f1ece2',
  road: { primary: '#4d505a', secondary: '#474a53', tertiary: '#3b3e45', residential: '#3b3e45', service: '#45484f', parkway: '#575047' } as Record<RoadClass, string>,
};
const CLASS_RANK: Record<RoadClass, number> = { parkway: 5, primary: 4, secondary: 3, tertiary: 2, residential: 1, service: 0 };

/** Paints the static map once into the minimap's base image (land, parks, water, canal, lots, buildings, roads). */
function paintMinimap(ctx: CanvasRenderingContext2D, o: MinimapDrawOpts, doc: GeoDoc, standing: GeoDoc['buildings'], geo: GeoWorld, polys: GeoRoadPoly[], lanes: { cls: RoadClass }[]): void {
  const s = o.scale;
  const X = (x: number) => (x - o.ox) * s, Z = (z: number) => (z - o.oz) * s;
  const ring = (pts: ArrayLike<number> | Pt[], flat: boolean) => {
    ctx.beginPath();
    if (flat) {
      const p = pts as ArrayLike<number>;
      for (let i = 0; i < p.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[i]), Z(p[i + 1]));
    } else (pts as Pt[]).forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Z(p[1])));
    ctx.closePath();
  };
  const fillArea = (pts: Pt[], holes: Pt[][] | undefined, col: string) => {
    ctx.beginPath();
    for (const r of [pts, ...(holes ?? [])]) r.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Z(p[1])));
    ctx.fillStyle = col;
    ctx.fill('evenodd');
  };
  ctx.fillStyle = MM.land;
  ctx.fillRect(0, 0, o.width, o.height);
  for (const pk of doc.parks) fillArea(pk.pts, pk.holes, pk.kind === 'landuse=cemetery' ? MM.cemetery : MM.park);
  for (const wa of doc.water) fillArea(wa.pts, wa.holes, wa.kind === 'canal' ? MM.canal : MM.water);
  for (const f of doc.footways) if (f.kind === 'pedestrian' && f.area) fillArea(f.pts, f.holes, MM.plaza);
  ctx.fillStyle = MM.lot;
  for (const lt of geo.lotStalls) { ring(lt.outline, false); ctx.fill(); }
  // footpaths, the towpath, boardwalk and piers
  ctx.lineCap = 'round';
  for (const f of doc.footways) {
    if (f.kind === 'sidewalk' || f.kind === 'crossing' || (f.kind === 'pedestrian' && f.area)) continue;
    ctx.strokeStyle = f.pier || f.surface === 'wood' ? MM.pier : MM.path;
    ctx.lineWidth = Math.max(1, (f.pier || f.surface === 'wood' ? 4 : 2) * s);
    ctx.beginPath();
    f.pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Z(p[1])));
    ctx.stroke();
  }
  ctx.fillStyle = MM.building;
  for (const bd of standing) { ring(bd.pts, false); ctx.fill(); }
  // roads: kerb-to-kerb outlines (pavements as a darker rim), junctions, then decks on top in layer order
  const drawRoad = (P: GeoRoadPoly, col: string) => {
    ring(P.outline, true);
    ctx.fillStyle = col;
    ctx.fill();
  };
  ctx.lineJoin = 'round';
  for (const P of polys) {
    if (P.deck) continue;
    ring(P.outline, true);
    ctx.strokeStyle = MM.kerb;
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.stroke();
  }
  polys.forEach((P, i) => { if (!P.deck) drawRoad(P, MM.road[lanes[i].cls]); });
  // junction surfaces in the colour of their biggest road
  const jCls = geo.junctions.map(() => 'service' as RoadClass);
  polys.forEach((P, i) => {
    if (P.deck) return;
    for (const n of [P.nodeA, P.nodeB]) if (CLASS_RANK[lanes[i].cls] > CLASS_RANK[jCls[n]]) jCls[n] = lanes[i].cls;
  });
  for (const j of geo.junctions) {
    if (j.outline.length < 6) continue;
    ring(j.outline, true);
    ctx.fillStyle = MM.road[jCls[j.id]];
    ctx.fill();
  }
  const decks = polys.map((P, i) => ({ P, i })).filter((d) => d.P.deck).sort((a, c) => a.P.layer - c.P.layer);
  for (const { P, i } of decks) {
    ring(P.outline, true);
    ctx.strokeStyle = MM.deckEdge;
    ctx.lineWidth = Math.max(1.5, 2.2 * s);
    ctx.stroke();
    drawRoad(P, MM.road[lanes[i].cls]);
  }
}
