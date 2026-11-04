// World generator v2: builds the Georgetown map (src/data/georgetown.json) into three.js meshes and Rapier colliders,
// and answers the height / road / water queries the gameplay systems need. Entry point: buildGeorgetownWorld().
//
// Pipeline: 1 m height+kind raster (terrain, water cuts) -> road graph with junction outlines and height profiles
// (decks clear what passes beneath) -> road bands rasterized and the terrain blended into them -> meshes merged per
// 240 m chunk and material layer (ground, decals, facades, near detail) -> static physics in one fixed body per
// 120 m chunk (trimesh ground, boxes for buildings, cylinders for posts and trunks).
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../../tuning';
import type { GeoDoc, Pt } from './geoDoc';
import { clamp, SegGrid } from './geoDoc';
import { lin as linHex, PhysChunks, RenderChunks, type Layer } from './meshKit';
import { B, GeoRaster, K, buildOuterLand, buildTerrainMesh } from './terrain';
import { buildRoadNet, OMITTED_ROADS, solveProfiles, type REdge, type RoadNet } from './roadNet';
import { buildNetMeshes, drapeRibbon, rasterizeNet, sections } from './roadMesh';
import { buildPlazaAndPiers, buildWater, makeWaterModel, rasterizePlaza, rasterizeWater, type WaterModel } from './waterworks';
import { buildBridges, buildStairs, rasterizeStairs } from './bridges';
import { buildBuildings, createFacadeMaterial, rasterizeBuildings } from './facades';
import { buildMonuments } from './monuments';
import { buildLots, rasterizeLots, type GeoLot } from './lots';
import { buildProps } from './props';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- render constants
const RENDER_CHUNK = 240; // m: meshes are merged per chunk and material layer
const PHYS_CHUNK = 120; // m: one fixed body per chunk (like the grid city)
/** Per quality: near-detail distance (m), base draw distance (m, grows with camera height), tree share drawn. */
export const GEO_QUALITY = {
  low: { detail: 80, draw: 520, trees: 0.45, anisotropy: 1 },
  medium: { detail: 170, draw: 950, trees: 0.8, anisotropy: 4 },
  high: { detail: 340, draw: 4000, trees: 1, anisotropy: 8 },
} as const;
export type GeoQuality = keyof typeof GEO_QUALITY;

export interface GeoWorldOptions {
  /** World seed: varies shop names only, never the map geometry. */
  seed: number;
  quality: GeoQuality;
}

export interface GeoLane {
  dir: 1 | -1; // 1 = travels in the order of `centre`
  offset: number; // m right of the centre line
  /** x, y, z per point (same count as `centre`), heights included */
  pts: Float32Array;
}
export interface GeoRoadPoly {
  /** Data road id (s<n>); a data road can be split into several edges at junctions. */
  roadId: string;
  edge: number;
  name: string;
  highway: string;
  oneway: number;
  layer: number;
  deck: boolean;
  /** Junction node ids at each end (see GeoWorld.junctions). */
  nodeA: number;
  nodeB: number;
  halfWidth: number;
  /** Arc length of the plateau at each end (the junction surface covers it). */
  trimA: number;
  trimB: number;
  /** Centre line actually used (x, y, z per point; may differ from the data where noted in the report). */
  centre: Float32Array;
  /** Kerb lines (x, y, z), left and right of travel along `centre`. */
  kerbL: Float32Array;
  kerbR: Float32Array;
  /** Carriageway outline (x, z pairs, closed ring): left kerb forward, right kerb back. */
  outline: Float32Array;
  sidewalkL: boolean;
  sidewalkR: boolean;
  lanes: GeoLane[];
  maxspeed: number | null;
}
export interface GeoJunction {
  id: number;
  x: number;
  z: number;
  y: number;
  degree: number;
  signals: boolean;
  stop: boolean;
  roundabout: boolean;
  /** Junction surface outline (x, z pairs). Empty for dead ends / map edges. */
  outline: Float32Array;
}
export interface GeoDeck {
  roadId: string;
  edge: number;
  name: string;
  layer: number;
  /** centre line with deck heights (x, y, z per point) */
  centre: Float32Array;
  halfWidth: number; // carriageway half width; sidewalks (if any) add TUNING.geo.sidewalkWidth
}

export interface GeoWorld {
  bounds: { x0: number; z0: number; x1: number; z1: number };
  /** Ground height (terrain with roads/sidewalks flattened, canal and creek cut). O(1), no allocation. */
  heightAt(x: number, z: number): number;
  /** Drivable surface height: the deck (bridge / freeway) or ground nearest to y; without y, the highest. */
  roadSurfaceAt(x: number, z: number, y?: number): number;
  /** Same, also counting footbridges, piers and the boardwalk (for people). */
  walkSurfaceAt(x: number, z: number, y?: number): number;
  isRoad(x: number, z: number): boolean;
  /** Building, wall or water at ground level, unless a deck passes over it. */
  isBlocked(x: number, z: number): boolean;
  isWater(x: number, z: number): boolean;
  /** Surface level of the water body at (x, z) (river, canal pound, creek). */
  waterLevelAt(x: number, z: number): number;
  /** Raw kind flags (see K in terrain.ts). */
  kindAt(x: number, z: number): number;
  /** Debug: how the terrain mesh treats a cell (B in terrain.ts). */
  bandAt(x: number, z: number): number;
  roadPolys: GeoRoadPoly[];
  junctions: GeoJunction[];
  decks: GeoDeck[];
  lotStalls: GeoLot[];
  /** Street lamp bases: x, y, z per lamp (the lamp head is 4.6 m above). */
  lampPositions: Float32Array;
  litWindowMat: THREE.MeshBasicMaterial;
  lampMat: THREE.MeshBasicMaterial;
  lampPoolMat: THREE.MeshBasicMaterial;
  groundMats: THREE.MeshStandardMaterial[];
  water: { meshes: THREE.Mesh[]; update(time: number): void };
  /** Waves + per-chunk LOD/draw distance. Call every frame; no allocation. */
  update(time: number, camera?: THREE.Camera): void;
  setQuality(q: GeoQuality): void;
  quality: GeoQuality;
  /** Ways left out of the render (to be removed from the graph): data ids with a reason. */
  omitted: { roadId: string; name: string; reason: string }[];
  stats: { bootMs: number; phases: Record<string, number>; tris: number; meshes: number; colliders: number; trimeshTris: number };
  root: THREE.Group;
}

interface ChunkGroup {
  cx: number;
  cz: number;
  r: number;
  ymin: number;
  ymax: number;
  meshes: Partial<Record<Layer, THREE.Mesh>>;
}

// ======================================================================================================
export function buildGeorgetownWorld(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, doc: GeoDoc, opts: GeoWorldOptions): GeoWorld {
  const T0 = performance.now();
  const phases: Record<string, number> = {};
  let tp = T0;
  const phase = (name: string) => { const t = performance.now(); phases[name] = Math.round(t - tp); tp = t; };
  const b = doc.meta.bounds;
  const root = new THREE.Group();
  root.name = 'georgetown';
  scene.add(root);

  // ---------------------------------------------------------------- raster: terrain, parks, water
  const ras = new GeoRaster(b.x0, b.z0, b.x1, b.z1);
  ras.fillBase(doc);
  for (const p of doc.parks) ras.fillRing(p.pts, (o) => { ras.k[o] |= K.PARK; });
  const W = makeWaterModel(doc);
  rasterizeWater(doc, W, ras);
  phase('terrain');

  // ---------------------------------------------------------------- road graph and profiles
  const baseAt = (x: number, z: number) => ras.baseAt(x, z);
  const net = buildRoadNet(doc, baseAt);
  const probe = makeProbe(net, W, ras, doc);
  solveProfiles(net, baseAt, probe);
  phase('roads');

  // ---------------------------------------------------------------- bands into the raster, then blend
  const dropped = buildingsUnderDecks(doc, net, ras);
  rasterizeBuildings(doc, ras, dropped);
  rasterizeNet(net, ras, doc.parking);
  const lotInfo = rasterizeLots(doc, ras, net);
  const { plazaH } = rasterizePlaza(doc, ras);
  const stairs = rasterizeStairs(doc, ras);
  ras.blendBands();
  ras.finish();
  phase('raster');

  // ---------------------------------------------------------------- meshes
  const chunks = new RenderChunks(RENDER_CHUNK, b, 760);
  const phys = new PhysChunks(R, physics, PHYS_CHUNK);
  const cemetery = doc.parks.find((p) => p.kind === 'landuse=cemetery')?.pts ?? null;
  const terrainTris = buildTerrainMesh(ras, chunks, phys, cemetery, (x, z) => W.levelAt(x, z));
  buildOuterLand(ras, chunks, b, (x) => riverNorthZ(W.river, x));
  phase('terrainMesh');
  const info = buildNetMeshes(net, doc, chunks, phys);
  drawPaths(doc, ras, chunks);
  phase('roadMesh');
  const water = buildWater(doc, W, ras, chunks, phys, root);
  const pierDecks = buildPlazaAndPiers(doc, ras, chunks, phys, plazaH, W);
  phase('water');
  const bridges = buildBridges(net, doc, ras, W, chunks, phys);
  buildStairs(stairs, chunks, phys);
  const lotStalls = buildLots(lotInfo, ras, chunks, phys);
  phase('bridges');
  const litWindowMat = new THREE.MeshBasicMaterial({ color: 0x8899aa });
  const facadeMat = createFacadeMaterial(litWindowMat, GEO_QUALITY[opts.quality].anisotropy);
  const bld = buildBuildings(doc, ras, net, info.edgeGrid, chunks, phys, opts.seed, root, dropped);
  buildMonuments(doc, ras, chunks, phys);
  phase('buildings');
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4 });
  const lampPoolMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const props = buildProps(doc, ras, net, info, bridges.lamps, chunks, phys, root, lampMat, lampPoolMat);
  phase('props');

  // ---------------------------------------------------------------- materials and chunk meshes
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93 });
  const decalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  const detailMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const mats: Record<Layer, THREE.Material> = { ground: groundMat, decal: decalMat, facade: facadeMat, detail: detailMat };
  const groups = new Map<number, ChunkGroup>();
  let tris = 0, meshCount = 0;
  for (const [key, buf] of chunks.bufs) {
    if (buf.n === 0) continue;
    const [layer, ck] = key.split(':') as [Layer, string];
    const geo = buf.toGeometry();
    const mesh = new THREE.Mesh(geo, mats[layer]);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = layer === 'facade' || layer === 'detail';
    mesh.receiveShadow = true;
    mesh.name = `geo-${layer}-${ck}`;
    root.add(mesh);
    tris += buf.tris;
    meshCount++;
    const c = Number(ck);
    let g = groups.get(c);
    if (!g) {
      const bb = geo.boundingBox!;
      g = { cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, r: 0, ymin: bb.min.y, ymax: bb.max.y, meshes: {} };
      groups.set(c, g);
    }
    const bb = geo.boundingBox!;
    const ci = c % chunks.nx, cj = Math.floor(c / chunks.nx);
    g.cx = chunks.x0 + (ci + 0.5) * chunks.size;
    g.cz = chunks.z0 + (cj + 0.5) * chunks.size;
    g.r = chunks.size * 0.75;
    g.ymin = Math.min(g.ymin, bb.min.y);
    g.ymax = Math.max(g.ymax, bb.max.y);
    g.meshes[layer] = mesh;
  }
  chunks.bufs.clear();
  const groupList = [...groups.values()];
  phase('meshes');

  // ---------------------------------------------------------------- physics
  // boundary walls (invisible) and a safety floor under everything
  const wallH = 120;
  phys.box((b.x0 + b.x1) / 2, 0, b.z0 - 1, (b.x1 - b.x0) / 2 + 2, wallH, 1);
  phys.box((b.x0 + b.x1) / 2, 0, b.z1 + 1, (b.x1 - b.x0) / 2 + 2, wallH, 1);
  phys.box(b.x0 - 1, 0, (b.z0 + b.z1) / 2, 1, wallH, (b.z1 - b.z0) / 2 + 2);
  phys.box(b.x1 + 1, 0, (b.z0 + b.z1) / 2, 1, wallH, (b.z1 - b.z0) / 2 + 2);
  phys.box((b.x0 + b.x1) / 2, -3.2, (b.z0 + b.z1) / 2, (b.x1 - b.x0) / 2, 1, (b.z1 - b.z0) / 2);
  const trimeshTris = phys.finishTrimeshes();
  phase('physics');

  // ---------------------------------------------------------------- exports for the graph builder
  const roadPolys = net.edges.map((e) => exportEdge(net, e));
  const junctions: GeoJunction[] = net.nodes.map((n) => ({
    id: n.id, x: n.x, z: n.z, y: n.h, degree: n.arms.length, signals: n.signals, stop: n.stop, roundabout: n.roundabout, outline: Float32Array.from(n.outline),
  }));
  const decks: GeoDeck[] = net.edges.filter((e) => e.deck).map((e) => ({ roadId: e.road.id, edge: e.id, name: e.name, layer: e.layer, centre: centreOf(net, e), halfWidth: e.hw }));
  const deckIdx = buildDeckIndex(net, [...water.walkDecks, ...pierDecks]);
  const omitted = doc.roads.filter((r) => OMITTED_ROADS.has(`${r.name}#${r.tunnel ? 'tunnel' : ''}`)).map((r) => ({
    roadId: r.id, name: r.name ?? '', reason: 'K St underpass beneath Washington Circle: not rendered (ramps would need >15% grades between the split nodes and the ring); remove from the graph',
  }));

  // ---------------------------------------------------------------- queries (no allocation)
  const heightAt = (x: number, z: number) => ras.heightAt(x, z);
  const surface = (x: number, z: number, y: number | undefined, walk: boolean) => {
    const g = ras.heightAt(x, z);
    let best = g, bd = y === undefined ? -g : Math.abs(g - y);
    deckIdx.query(x, z, walk, (hDeck) => {
      const d = y === undefined ? -hDeck : Math.abs(hDeck - y);
      if (d < bd) { bd = d; best = hDeck; }
    });
    return best;
  };
  const roadSurfaceAt = (x: number, z: number, y?: number) => surface(x, z, y, false);
  const walkSurfaceAt = (x: number, z: number, y?: number) => surface(x, z, y, true);
  const isRoad = (x: number, z: number) => (ras.kindAt(x, z) & K.ROAD) !== 0;
  const isBlocked = (x: number, z: number) => {
    const k = ras.kindAt(x, z);
    return (k & (K.BUILDING | K.WALL | K.WATER)) !== 0 && (k & K.DECK) === 0;
  };
  const isWater = (x: number, z: number) => (ras.kindAt(x, z) & K.WATER) !== 0;

  // ---------------------------------------------------------------- quality and LOD
  let quality: GeoQuality = opts.quality;
  const setQuality = (q: GeoQuality) => {
    quality = q;
    const Q = GEO_QUALITY[q];
    props.setTreeShare(Q.trees);
    world.quality = q;
  };
  const camPos = new THREE.Vector3();
  const update = (time: number, camera?: THREE.Camera) => {
    water.update(time);
    if (!camera) return;
    camera.getWorldPosition(camPos);
    const Q = GEO_QUALITY[quality];
    const camH = Math.max(0, camPos.y - ras.heightAt(clamp(camPos.x, b.x0, b.x1), clamp(camPos.z, b.z0, b.z1)));
    const draw = Q.draw + camH * 2.2;
    for (let i = 0; i < groupList.length; i++) {
      const g = groupList[i];
      const dx = Math.max(0, Math.abs(camPos.x - g.cx) - g.r * 0.7), dz = Math.max(0, Math.abs(camPos.z - g.cz) - g.r * 0.7);
      const dy = camPos.y > g.ymax ? camPos.y - g.ymax : camPos.y < g.ymin ? g.ymin - camPos.y : 0;
      const dh = Math.sqrt(dx * dx + dz * dz);
      const d3 = Math.sqrt(dh * dh + dy * dy);
      const vis = dh < draw;
      const m = g.meshes;
      if (m.ground) m.ground.visible = vis;
      if (m.decal) m.decal.visible = vis && d3 < draw * 0.6;
      if (m.facade) m.facade.visible = vis;
      if (m.detail) m.detail.visible = vis && d3 < Q.detail;
    }
    props.update(camPos, Q.detail, draw);
    bld.update(camPos, Q.detail);
  };

  const world: GeoWorld = {
    bounds: { ...b },
    heightAt, roadSurfaceAt, walkSurfaceAt, isRoad, isBlocked, isWater,
    waterLevelAt: (x, z) => W.levelAt(x, z),
    kindAt: (x, z) => ras.kindAt(x, z),
    bandAt: (x, z) => ras.bandAt(x, z),
    roadPolys, junctions, decks, lotStalls,
    lampPositions: props.lampPositions,
    litWindowMat, lampMat, lampPoolMat, groundMats: [groundMat, decalMat],
    water: { meshes: water.meshes, update: water.update },
    update, setQuality, quality,
    omitted,
    stats: { bootMs: 0, phases, tris: tris + props.tris + bld.extraTris, meshes: meshCount, colliders: phys.colliders, trimeshTris },
    root,
  };
  setQuality(quality);
  world.stats.bootMs = Math.round(performance.now() - T0);
  void terrainTris;
  return world;
}

// ======================================================================================================
function riverNorthZ(river: Pt[], x: number): number {
  // smallest z of the river polygon edge near x (the north shore)
  let best = Infinity;
  for (let i = 0; i < river.length; i++) {
    const a = river[i], c = river[(i + 1) % river.length];
    if ((a[0] - x) * (c[0] - x) > 0 || a[0] === c[0]) continue;
    const z = a[1] + ((x - a[0]) / (c[0] - a[0])) * (c[1] - a[1]);
    if (z < best) best = z;
  }
  return best === Infinity ? 1e9 : best;
}

/**
 * Buildings a deck runs through (its underside lower than their roofs): the data placed buildings clear of the
 * original freeway line, but its last stretch is moved beside the K St bridge here, so the few in the way go.
 */
function buildingsUnderDecks(doc: GeoDoc, net: RoadNet, ras: GeoRaster): Set<string> {
  const grid = new SegGrid(32);
  for (const e of net.edges) if (e.deck) grid.addLine(e.pts, e.id, e.hw + G.sidewalkWidth + 3);
  const out = new Set<string>();
  for (const b of doc.buildings) {
    const top = ras.baseAt(b.pts[0][0], b.pts[0][1]) + b.levels * 3.2 + 2;
    const probe = [...b.pts, [(b.pts[0][0] + b.pts[2][0]) / 2, (b.pts[0][1] + b.pts[2][1]) / 2]];
    let hit = false;
    for (const p of probe) {
      grid.query(p[0], p[1], (_s, id, d) => {
        const e = net.edges[id];
        if (hit || d > e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0) + 1.2) return;
        const pr = net.project(e, p[0], p[1]);
        if (net.profAt(e, pr.s) - G.deckThickness - 0.5 < top) hit = true;
      });
      if (hit) break;
    }
    if (hit) out.add(b.id);
  }
  return out;
}

/** Required deck heights for bridge profiles: what passes beneath + clearance. */
function makeProbe(net: RoadNet, W: WaterModel, ras: GeoRaster, doc: GeoDoc) {
  const grid = new SegGrid(32);
  for (const e of net.edges) grid.addLine(e.pts, e.id, e.hw + 4);
  const paths = new SegGrid(32);
  for (const f of doc.footways) if ((f.kind === 'path' || f.kind === 'cycleway') && !f.towpath) paths.addLine(f.pts, 0, 3); // the towpath is handled with the canal
  const CANAL_HALF = 6;
  return (x: number, z: number, layer: number, self: REdge) => {
    const th = G.deckThickness + (self.freeway ? 0.3 : 0);
    let req = -Infinity;
    let ground = ras.baseAt(x, z);
    grid.query(x, z, (_s, id, d) => {
      const e = net.edges[id];
      if (e === self || d > e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0) + 0.6) return;
      if (e.deck && e.layer >= layer) return;
      if (e.a === self.a || e.a === self.b || e.b === self.a || e.b === self.b) {
        // a road sharing a node with this deck: ignore near that node (it's where they join)
        const pr0 = net.project(e, x, z);
        if (pr0.s < e.trimA + 25 && (e.a === self.a || e.a === self.b)) return;
        if (pr0.s > e.L - e.trimB - 25 && (e.b === self.a || e.b === self.b)) return;
      }
      const pr = net.project(e, x, z);
      const hh = net.profAt(e, pr.s);
      if (!e.deck) ground = Math.max(ground, hh);
      req = Math.max(req, hh + (e.deck ? G.deckThickness : 0) + G.roadClearance + th);
    });
    let dc = Infinity;
    W.canalGrid.query(x, z, (_s, _p, d) => { if (d < dc) dc = d; });
    const lvl = W.canalLevelAt(x);
    if (dc < CANAL_HALF) req = Math.max(req, lvl + G.waterClearance + th);
    else if (dc < CANAL_HALF + 5.8) req = Math.max(req, lvl + 1.1 + G.pathClearance + th);
    let dk = Infinity;
    W.creekGrid.query(x, z, (_s, _p, d) => { if (d < dk) dk = d; });
    if (dk < W.creekHalfAt(z) + 2) req = Math.max(req, W.creekLevelAt(z) + G.waterClearance + th);
    if ((ras.kindAt(x, z) & K.WATER) && dc > CANAL_HALF + 2 && dk > W.creekHalfAt(z) + 4) req = Math.max(req, G.riverLevel + 10 + th);
    let dp = Infinity;
    paths.query(x, z, (_s, _p, d) => { if (d < dp) dp = d; });
    if (dp < 2.5) req = Math.max(req, ras.baseAt(x, z) + G.pathClearance + th);
    // the freeway runs elevated above K St / Water St
    if (self.freeway && x > -620 && x < 250) req = Math.max(req, ground + G.freewayClearance + th);
    return req;
  };
}

function centreOf(net: RoadNet, e: REdge): Float32Array {
  const out = new Float32Array(e.pts.length * 3);
  e.pts.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = e.prof[i]; out[i * 3 + 2] = p[1]; });
  void net;
  return out;
}

function exportEdge(net: RoadNet, e: REdge): GeoRoadPoly {
  const n = e.pts.length;
  const centre = centreOf(net, e);
  const X = sections(e, 0, e.L);
  const off = (o: number) => {
    const a = new Float32Array(X.length * 3);
    X.forEach((q, i) => { a[i * 3] = q.x + q.rx * o; a[i * 3 + 1] = net.profAt(e, q.s); a[i * 3 + 2] = q.z + q.rz * o; });
    return a;
  };
  const kerbL = off(-e.hw), kerbR = off(e.hw);
  const outline = new Float32Array(X.length * 4);
  X.forEach((q, i) => { outline[i * 2] = kerbL[i * 3]; outline[i * 2 + 1] = kerbL[i * 3 + 2]; });
  X.forEach((q, i) => { const j = X.length - 1 - i; outline[(X.length + i) * 2] = kerbR[j * 3]; outline[(X.length + i) * 2 + 1] = kerbR[j * 3 + 2]; });
  const lanes: GeoLane[] = e.lanes.map((l) => ({ dir: l.dir, offset: l.offset, pts: off(l.offset) }));
  void n;
  return {
    roadId: e.road.id, edge: e.id, name: e.name, highway: e.cls, oneway: e.road.oneway, layer: e.layer, deck: e.deck,
    nodeA: e.a.id, nodeB: e.b.id, halfWidth: e.hw, trimA: e.trimA, trimB: e.trimB, centre, kerbL, kerbR, outline,
    sidewalkL: e.swL, sidewalkR: e.swR, lanes, maxspeed: e.road.maxspeed,
  };
}

/** Spatial index over deck surfaces (road decks and walkable structures) for roadSurfaceAt / walkSurfaceAt. */
function buildDeckIndex(net: RoadNet, walkDecks: { pts: Pt[]; hw: number; h: number[] }[]) {
  // flat arrays: ax, az, bx, bz, ha, hb, hw, walkOnly
  const S: number[] = [];
  const grid = new SegGrid(16);
  for (const e of net.edges) {
    if (!e.deck) continue;
    const X = sections(e, 0, e.L);
    const hw = e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0) + 0.3;
    for (let i = 1; i < X.length; i++) {
      const id = S.length / 8;
      S.push(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, net.profAt(e, X[i - 1].s), net.profAt(e, X[i].s), hw, 0);
      grid.add(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, id, hw);
    }
  }
  for (const w of walkDecks) {
    for (let i = 1; i < w.pts.length; i++) {
      const id = S.length / 8;
      S.push(w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1], w.h[i - 1], w.h[i], w.hw, 1);
      grid.add(w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1], id, w.hw);
    }
  }
  let cbRef: ((h: number) => void) | null = null;
  let walkRef = false;
  const visit = (_seg: number, id: number, d: number, t: number) => {
    const o = id * 8;
    if (d > S[o + 6]) return;
    if (S[o + 7] === 1 && !walkRef) return;
    cbRef!(S[o + 4] + (S[o + 5] - S[o + 4]) * t);
  };
  return {
    query(x: number, z: number, walk: boolean, cb: (h: number) => void) {
      cbRef = cb;
      walkRef = walk;
      grid.query(x, z, visit);
      cbRef = null;
    },
  };
}

/** Footpaths, trails, the towpath links and the promenade: draped ribbons on the terrain (decals). */
function drawPaths(doc: GeoDoc, ras: GeoRaster, chunks: RenderChunks) {
  const colOf = (f: GeoDoc['footways'][number]) => {
    if (f.surface === 'gravel') return 0xc2ad86;
    if (f.surface === 'asphalt' || f.kind === 'cycleway') return 0x6e6d6a;
    if (f.surface === 'paving_stones') return 0xc9b9a0;
    return 0xb9a98e;
  };
  const buf = (x: number, z: number) => chunks.buf('decal', x, z);
  for (const f of doc.footways) {
    if (f.kind === 'sidewalk' || f.kind === 'crossing' || f.kind === 'steps' || f.kind === 'pedestrian' || f.bridge || f.surface === 'wood') continue;
    if (f.towpath) continue; // the canal corridor draws the towpath
    const w = f.surface === 'paving_stones' ? 5 : f.kind === 'cycleway' || f.kind === 'path' ? 3 : 2.2;
    // skip the parts that run over road / sidewalk bands
    const keep: [number, number][] = [];
    const runs: [number, number][][] = [];
    for (const p of f.pts) {
      const bd = ras.bandAt(p[0], p[1]);
      if (bd === B.ROAD || bd === B.HOLE) { if (keep.length > 1) runs.push(keep.splice(0)); else keep.length = 0; continue; }
      keep.push(p);
    }
    if (keep.length > 1) runs.push(keep);
    const col = linHex(colOf(f));
    for (const r of runs) drapeRibbon(buf, r, w, (x, z) => ras.heightAt(x, z), col, 0.035);
  }
}
