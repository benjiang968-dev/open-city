// Adapter: the procedural grid city (cityGen.ts, unchanged visuals) as a CityMap. Everything grid-shaped lives
// here and in cityGen.ts only: straight avenues and streets become two-way lane edges (lanes per direction from
// the road widths), block-corner pavement nodes become the walk graph, the rectangles become the isRoad /
// isBlocked / isWater tests, and the minimap base drawing is the old grid painter.
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../../tuning';
import { generateCity, updateCity } from '../cityGen';
import type { Look } from '../render/look';
import { applyGridLook } from '../render/gridLook';
import {
  MapIndex, makeLaneGeometry, linkLaneNeighbours,
  type Building, type CityMap, type KerbHit, type LaneEdge, type LaneHit, type MinimapDrawOpts, type ParkingSpot,
  type Poi, type RoadClass, type RoadNode, type StreetLine, type WalkNode,
} from './cityMap';

const M = TUNING.map;
const TT = TUNING.traffic;
const V = TUNING.vehicles;

export function createGridMap(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number, audit = false, look?: Look): CityMap {
  const g = generateCity(scene, R, physics, seed, audit, look);
  if (look) applyGridLook(scene, look, g.water); // PBR surfaces on the grid city's meshes (render/gridLook.ts)
  const { xs, zs, roadHalfX, roadHalfZ, streetNamesX, streetNamesZ } = g;
  const lastJ = zs.length - 1;
  const clsOfZ = (j: number): RoadClass => (j === lastJ ? 'secondary' : 'residential'); // the bay boulevard

  // ---------- road graph: one node per grid junction (same ids), lane edges in node.nbrs order ----------
  const nodes: RoadNode[] = g.nodes.map((n) => ({
    id: n.id, x: n.x, y: 0, z: n.z, out: [], in: [], roundabout: false, signals: false, stop: false, deadEnd: n.nbrs.length < 2, junction: true,
  }));
  const edges: LaneEdge[] = [];
  // lanes per direction: the innermost lane centre sits at traffic.laneOffset, then one laneWidth per lane outward,
  // leaving a parking lane at the kerb
  const lanesFor = (half: number) => Math.max(1, Math.floor((half - M.parkingLaneWidth - TT.laneOffset - M.laneWidth / 2) / M.laneWidth) + 1);
  for (const a of g.nodes) {
    for (const bId of a.nbrs) {
      const b = g.nodes[bId];
      const alongX = b.j === a.j; // east-west street
      const half = alongX ? roadHalfZ[a.j] : roadHalfX[a.i];
      const dx = Math.sign(b.x - a.x), dz = Math.sign(b.z - a.z);
      const rx = -dz, rz = dx; // right-hand side
      // the junction box at each end is as wide as the crossing road
      const trimA = (alongX ? roadHalfX[a.i] : roadHalfZ[a.j]) + M.stopLineGap;
      const trimB = (alongX ? roadHalfX[b.i] : roadHalfZ[b.j]) + M.stopLineGap;
      const lanes = lanesFor(half);
      for (let k = lanes - 1; k >= 0; k--) {
        const off = TT.laneOffset + M.laneWidth * (lanes - 1 - k);
        const geo = makeLaneGeometry([a.x + rx * off, 0, a.z + rz * off, b.x + rx * off, 0, b.z + rz * off]);
        const e: LaneEdge = {
          id: edges.length, from: a.id, to: b.id, ...geo, trimStart: trimA, trimEnd: trimB, speed: TT.cruiseSpeed,
          cls: alongX ? clsOfZ(a.j) : 'residential', name: alongX ? streetNamesZ[a.j] : streetNamesX[a.i],
          roadId: alongX ? `ew${a.j}` : `ns${a.i}`, lane: k, lanesSameDir: lanes, offset: off, oneway: false,
          roundabout: false, bridge: false, halfWidth: half, twin: -1, left: -1, right: -1, parking: false, // parked cars stand outside the traffic lanes
        };
        edges.push(e);
        nodes[a.id].out.push(e.id);
        nodes[b.id].in.push(e.id);
      }
    }
  }
  const byEnds = new Map<string, number>();
  for (const e of edges) byEnds.set(`${e.from},${e.to},${e.lane}`, e.id);
  for (const e of edges) e.twin = byEnds.get(`${e.to},${e.from},${e.lane}`) ?? -1;
  linkLaneNeighbours(edges);

  // ---------- walk graph: the pavement corners (same ids and neighbour order) ----------
  const walk: WalkNode[] = g.sideNodes.map((s) => ({ id: s.id, x: s.x, y: 0, z: s.z, nbrs: [...s.nbrs], kind: 'sidewalk', street: null }));

  // ---------- buildings, streets ----------
  const buildings: Building[] = g.buildingRects.map((r) => ({
    pts: Float32Array.from([r.x0, r.z0, r.x1, r.z0, r.x1, r.z1, r.x0, r.z1]), h: r.h, minX: r.x0, minZ: r.z0, maxX: r.x1, maxZ: r.z1,
  }));
  const streets: StreetLine[] = [
    ...xs.map((x, i) => ({ name: streetNamesX[i], cls: 'residential' as RoadClass, pts: [x, zs[0], x, zs[lastJ]] })),
    ...zs.map((z, j) => ({ name: streetNamesZ[j], cls: clsOfZ(j), pts: [xs[0], z, xs[xs.length - 1], z] })),
  ];

  const index = new MapIndex(g.bounds, edges, walk, buildings);

  // ---------- places ----------
  const pw = TUNING.world.sidewalkWidth;
  const pois: Poi[] = g.pois.map((p) => {
    const nx0 = p.curbX - p.x, nz0 = p.curbZ - p.z, nl = Math.hypot(nx0, nz0) || 1;
    const nx = nx0 / nl, nz = nz0 / nl; // from the pavement out into the road
    return {
      id: p.id, name: p.name, kind: p.kind, x: p.x, z: p.z, curbX: p.curbX, curbZ: p.curbZ,
      kerbHeading: Math.atan2(-nz, nx), // the kerbside lane runs with the pavement on its right
      door: { x: p.x - nx * (pw / 2), z: p.z - nz * (pw / 2) }, street: p.street, walkNode: p.sideNode,
      signed: !['park', 'taxiRank', 'apartment'].includes(p.kind), // cityGen paints these names on the shop signs
    };
  });
  const taxiRanks = g.taxiRanks.map((r) => pois[r.id]);

  // ---------- parking: the generator's street spots, plus kerb spots along both sides of the boulevard ----------
  const hit: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
  const streetAt = (x: number, z: number) => (index.nearestLane(x, z, 30, false, hit) ? edges[hit.edge].name : null);
  const parkingSpots: ParkingSpot[] = g.parkingSpots.map((s) => ({ x: s.x, y: 0, z: s.z, heading: s.heading, cls: 'residential', street: streetAt(s.x, s.z), lot: -1, edge: -1, s: 0 }));
  {
    const kerbOff = roadHalfZ[lastJ] - V.parkingKerbGap;
    const clear = V.parkedClearOfPoi;
    for (let i = 0; i < xs.length - 1; i++)
      for (let x = xs[i] + roadHalfX[i] + V.parkingJunctionGap; x < xs[i + 1] - roadHalfX[i + 1] - V.parkingJunctionGap; x += V.kerbSlotSpacing)
        for (const [z, heading] of [[zs[lastJ] - kerbOff, -Math.PI / 2], [zs[lastJ] + kerbOff, Math.PI / 2]]) {
          if (pois.some((p) => (p.curbX - x) ** 2 + (p.curbZ - z) ** 2 < clear * clear)) continue;
          parkingSpots.push({ x, y: 0, z, heading, cls: 'secondary', street: streetNamesZ[lastJ], lot: -1, edge: -1, s: 0 });
        }
  }

  // ---------- area tests ----------
  const b = g.bounds;
  const inRect = (r: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
  const isWater = (x: number, z: number) => {
    if (z <= g.coastZ) return false;
    if (inRect(g.pierRect, x, z)) return false;
    for (let k = 0; k < g.marinaRects.length; k++) if (inRect(g.marinaRects[k], x, z)) return false;
    return true;
  };
  const isRoad = (x: number, z: number) => {
    for (let i = 0; i < xs.length; i++) if (Math.abs(x - xs[i]) < roadHalfX[i]) return true;
    for (let j = 0; j < zs.length; j++) if (Math.abs(z - zs[j]) < roadHalfZ[j]) return true;
    return false;
  };
  const isBlocked = (x: number, z: number) => x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ || isWater(x, z) || index.buildingAt(x, z) >= 0;

  // ---------- minimap ----------
  const drawMinimapBase = (ctx: CanvasRenderingContext2D, o: MinimapDrawOpts) => {
    const s = o.scale;
    const X = (x: number) => (x - o.ox) * s, Z = (z: number) => (z - o.oz) * s;
    ctx.fillStyle = '#7da35a';
    ctx.fillRect(0, 0, o.width, o.height);
    ctx.fillStyle = '#2f7fb3';
    ctx.fillRect(0, Z(g.coastZ), o.width, o.height);
    ctx.fillStyle = '#cfc9bf';
    ctx.fillRect(X(xs[0] - 10), Z(zs[0] - 10), (xs[xs.length - 1] - xs[0] + 20) * s, (zs[lastJ] - zs[0] + 18) * s);
    ctx.fillStyle = '#e9d8a6';
    ctx.fillRect(0, Z(zs[lastJ] + 10), o.width, (g.coastZ - zs[lastJ] - 10) * s);
    ctx.fillStyle = '#6fa84f';
    for (const r of g.parkRects) ctx.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * s, (r.z1 - r.z0) * s);
    ctx.fillStyle = '#9a9aa3';
    for (const r of g.buildingRects) ctx.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * s, (r.z1 - r.z0) * s);
    ctx.fillStyle = '#3b3e45';
    for (let i = 0; i < xs.length; i++) ctx.fillRect(X(xs[i] - roadHalfX[i]), Z(zs[0] - roadHalfZ[0]), roadHalfX[i] * 2 * s, (zs[lastJ] - zs[0] + roadHalfZ[0] + roadHalfZ[lastJ]) * s);
    for (let j = 0; j < zs.length; j++) ctx.fillRect(X(xs[0] - roadHalfX[0]), Z(zs[j] - roadHalfZ[j]), (xs[xs.length - 1] - xs[0] + roadHalfX[0] * 2) * s, roadHalfZ[j] * 2 * s);
    ctx.fillStyle = '#a0754f';
    const pr = g.pierRect;
    ctx.fillRect(X(pr.x0), Z(pr.z0), (pr.x1 - pr.x0) * s, (pr.z1 - pr.z0) * s);
    for (const r of g.marinaRects) ctx.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * s, (r.z1 - r.z0) * s);
  };

  const rank = taxiRanks[0];
  return {
    id: 'grid',
    attribution: 'Procedural grid city, generated in code from the seed',
    bounds: g.bounds,
    center: g.center,
    spawn: { x: rank.x, z: rank.z, heading: 0 },
    waterLevel: TUNING.world.waterLevel,
    roads: { nodes, edges },
    walk: { nodes: walk },
    streets,
    buildings,
    pois,
    taxiRanks,
    parkingSpots,
    heightAt: () => 0,
    isRoad,
    isBlocked,
    isWater,
    waterLevelAt: () => TUNING.world.waterLevel,
    nearestLane: (x: number, z: number, maxDist: number, out: LaneHit, y?: number) => index.nearestLane(x, z, maxDist, false, out, y),
    nearestWalk: (x: number, z: number, y?: number) => index.nearestWalk(x, z, y),
    kerbPoint: (x: number, z: number, out: KerbHit, y?: number) => index.kerbPoint(x, z, out, y),
    drawMinimapBase,
    litWindowMat: g.litWindowMat,
    lampMat: g.lampMat,
    lampPoolMat: g.lampPoolMat,
    groundMats: g.groundMats,
    water: g.water,
    boats: g.boats,
    solidTags: g.solidTags,
    solidRecorder: g.solidRecorder,
    update: (t: number) => updateCity(g, t),
  };
}
