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
import { clamp, polyArea, SegGrid } from './geoDoc';
import { lin as linHex, PhysChunks, RenderChunks, type Layer } from './meshKit';
import { B, GeoRaster, K, buildOuterLand, buildTerrainMesh } from './terrain';
import { buildRoadNet, omittedRoads, solveProfiles, type REdge, type RNode, type RoadNet } from './roadNet';
import { buildNetMeshes, drapeRibbon, isDeckNode, rasterizeNet, sections } from './roadMesh';
import { buildPlazaAndPiers, buildWater, makeWaterModel, rasterizePlaza, rasterizeWater, type WaterModel } from './waterworks';
import { buildBridges, buildStairs, fitStairEnds, joinStairEnds, rasterizeStairs, stairHoles } from './bridges';
import { buildBuildings, rasterizeBuildings } from './facades';
import { validateBuildingPlacement } from './placement';
import { buildMonuments } from './monuments';
import { buildLots, conformToLots, planLots, rasterizeLots, type GeoLot } from './lots';
import { buildProps } from './props';
import { SurfaceIndex, trianglesNear } from './surfaceIndex';
import { SolidRecorder, type SolidTags } from '../objects/solidKinds';
import { createLook, type Look } from '../render/look';
import { makeWorldMaterial } from '../render/worldMaterial';
import { makeFacadeMaterial } from '../render/facadeMaterial';
import { upgradePropMaterials } from '../render/propMaterials';
import { createTreeLod } from '../render/trees';
import { upgradeWater } from '../render/water';
import { SURF, surf } from '../render/surfaces';

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
  /** Physics audit mode (?physaudit=1): record every drawn box / cylinder / wall with its solid kind. */
  audit?: boolean;
  /** Baked surface maps and shared material uniforms (render/look.ts); a fresh, unbaked one if left out. */
  look?: Look;
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
  /** An all-way stop. */
  stop: boolean;
  /** Road edges (GeoRoadPoly.edge) whose approach alone has a stop sign: they give way to the other arms. */
  stopEdges: number[];
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
  /**
   * Traffic signal heads (one per inbound lane of each signalised arm): 7 floats each: x, y, z of the head's top,
   * yaw (the head's local -z faces the approaching traffic), the junction id, and the arm direction ux, uz (away from
   * the junction). The lenses are drawn unlit; signalHeads.ts lights them from the traffic signal state.
   */
  signalHeads: Float32Array;
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
  /** Review data (optional): footprints cut back from streets / dropped, stoop bottoms (x, y, z, 0 per stoop). */
  audit?: { buildingsClipped: string[]; buildingsDropped: string[]; stoops: Float32Array; stoopInfo: Float32Array };
  /** Data buildings left out of the world (they stood under a deck): no mesh, no collider. */
  droppedBuildings: ReadonlySet<string>;
  stats: { bootMs: number; phases: Record<string, number>; tris: number; meshes: number; colliders: number; trimeshTris: number; surfaceTris: number };
  /** Collider handle -> solid kind of every static collider the world made. */
  solidTags: SolidTags;
  /** Audit mode only: what was drawn, with kinds (null when off). */
  solidRecorder: SolidRecorder | null;
  /** Footbridges over the canal: centre line points and deck heights (tests). */
  footbridges: { pts: Pt[]; h: number[]; hw: number }[];
  /** Stair plans (centre line, width, ramp height profile) for tests and the audit. */
  stairs: { pts: Pt[]; w: number; L: number; name: string | null; h: (s: number) => number; flights: [number, number][] }[];
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
  const look = opts.look ?? createLook(opts.quality);
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
  const probe = makeProbe(net, W, ras, doc, !!doc.meta.synthetic);
  solveProfiles(net, baseAt, probe);
  phase('roads');

  // ---------------------------------------------------------------- bands into the raster, then blend
  const clipped = validateBuildingPlacement(doc, net, baseAt);
  phase('clip');
  const dropped = new Set<string>();
  for (const id of clipped.drop) dropped.add(id);
  rasterizeBuildings(doc, ras, dropped);
  const lotPlans = planLots(doc, ras, net);
  conformToLots(net, lotPlans);
  rasterizeNet(net, ras, doc.parking);
  const lotInfo = rasterizeLots(lotPlans, ras);
  const { plazaH } = rasterizePlaza(doc, ras);
  // the walking surface of the street nearest (x, z): carriageway, or its sidewalk one kerb up (where stairs end)
  const streetY = (x: number, z: number) => {
    let best = NaN, bd = Infinity;
    for (const e of net.edges) {
      if (e.deck) continue;
      const pr = net.project(e, x, z);
      const lim = e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0) + 1;
      if (pr.d > lim || pr.d >= bd) continue;
      bd = pr.d;
      best = net.profAt(e, pr.s) + (pr.d > e.hw ? G.kerbHeight : 0);
    }
    return best;
  };
  const stairs = rasterizeStairs(doc, ras, streetY);
  const holes = stairHoles(stairs); // stairwells: cut out of the terrain and the sidewalks
  ras.blendBands();
  ras.finish();
  phase('raster');

  // ---------------------------------------------------------------- meshes
  const chunks = new RenderChunks(RENDER_CHUNK, b, 760);
  if (opts.audit) chunks.rec = new SolidRecorder();
  const phys = new PhysChunks(R, physics, PHYS_CHUNK);
  phys.keepTriangles('ground', 'stair', 'deck'); // the walking surfaces map.heightAt reads (surfaceIndex.ts)
  const cemetery = doc.parks.find((p) => p.kind === 'landuse=cemetery')?.pts ?? null;
  chunks.tag('ground');
  const terrainTris = buildTerrainMesh(ras, chunks, phys, cemetery, (x, z) => W.levelAt(x, z), holes);
  buildOuterLand(ras, chunks, b, (x) => riverNorthZ(W.river, x));
  phase('terrainMesh');
  const info = buildNetMeshes(net, doc, chunks, phys, holes);
  drawPaths(doc, ras, chunks);
  phase('roadMesh');
  chunks.tag('ground');
  const water = buildWater(doc, W, ras, chunks, phys, root, holes);
  chunks.tag('ground');
  upgradeWater(water.meshes, look);
  const pierDecks = buildPlazaAndPiers(doc, ras, chunks, phys, plazaH, W);
  phase('water');
  chunks.tag('ground');
  const bridges = buildBridges(net, doc, ras, W, chunks, phys);
  chunks.tag('ground');
  const lotStalls = buildLots(lotInfo, ras, chunks, phys);
  {
    // every stair's ends meet the ground as built (terrain mesh, sidewalks, lots, towpath): fitStairEnds
    const ends: number[] = [];
    for (const st of stairs) ends.push(st.pts[0][0], st.pts[0][1], st.pts[st.pts.length - 1][0], st.pts[st.pts.length - 1][1]);
    const near = new SurfaceIndex([trianglesNear(phys.soupsOf('ground'), ends, 4)]);
    for (const st of stairs) fitStairEnds(st, (x, z, ceil) => near.at(x, z, ceil), ras);
    joinStairEnds(stairs);
  }
  buildStairs(stairs, chunks, phys, ras);
  phase('bridges');
  const litWindowMat = new THREE.MeshBasicMaterial({ color: 0x8899aa });
  const facadeMat = makeFacadeMaterial(look, litWindowMat, GEO_QUALITY[opts.quality].anisotropy);
  const bld = buildBuildings(doc, ras, net, info.edgeGrid, chunks, phys, opts.seed, root, dropped);
  chunks.tag('untagged');
  buildMonuments(doc, ras, chunks, phys);
  chunks.tag('untagged');
  phase('buildings');
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4 });
  const lampPoolMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  // props stand on the boardwalk and piers where those cover the ground (benches on the waterfront)
  const deckIdx = buildDeckIndex(net, [...water.walkDecks, ...pierDecks]);
  const standAt = (x: number, z: number) => {
    const g = ras.heightAt(x, z);
    let best = g;
    deckIdx.query(x, z, true, (h) => { if (h > best && h < g + 2.5) best = h; });
    return best;
  };
  const props = buildProps(doc, ras, net, info, bridges.lamps, chunks, phys, root, lampMat, lampPoolMat, standAt);
  upgradePropMaterials(root, look);
  const treeLod = createTreeLod(look, root, TUNING.quality[opts.quality].treeNear);
  phase('props');

  // ---------------------------------------------------------------- materials and chunk meshes
  const groundMat = makeWorldMaterial(look, { name: 'geo-ground', roughness: 0.93 });
  const decalMat = makeWorldMaterial(look, { name: 'geo-decal', roughness: 0.85, decal: true });
  const detailMat = makeWorldMaterial(look, { name: 'geo-detail', roughness: 0.8 });
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
  phys.box((b.x0 + b.x1) / 2, 0, b.z0 - 1, (b.x1 - b.x0) / 2 + 2, wallH, 1, 1, 0, 'boundary');
  phys.box((b.x0 + b.x1) / 2, 0, b.z1 + 1, (b.x1 - b.x0) / 2 + 2, wallH, 1, 1, 0, 'boundary');
  phys.box(b.x0 - 1, 0, (b.z0 + b.z1) / 2, 1, wallH, (b.z1 - b.z0) / 2 + 2, 1, 0, 'boundary');
  phys.box(b.x1 + 1, 0, (b.z0 + b.z1) / 2, 1, wallH, (b.z1 - b.z0) / 2 + 2, 1, 0, 'boundary');
  phys.box((b.x0 + b.x1) / 2, -3.2, (b.z0 + b.z1) / 2, (b.x1 - b.x0) / 2, 1, (b.z1 - b.z0) / 2, 1, 0, 'boundary');
  const trimeshTris = phys.finishTrimeshes();
  // heights from the walking-surface colliders themselves (ground, kerbs, sidewalks, lots, aprons, stair ramps)
  const surf = new SurfaceIndex([...phys.kept.get('ground')!, ...phys.kept.get('stair')!]);
  const deckSurf = new SurfaceIndex(phys.kept.get('deck')!); // bridge and freeway decks, footbridges
  phys.kept.clear();
  const pierIdx = buildDeckIndex(null, pierDecks); // the boardwalk piers (box colliders, not in the triangles)
  phase('physics');

  // ---------------------------------------------------------------- exports for the graph builder
  const roadPolys = net.edges.map((e) => exportEdge(net, e));
  const junctions: GeoJunction[] = net.nodes.map((n) => ({
    id: n.id, x: n.x, z: n.z, y: n.h, degree: n.arms.length, signals: n.signals, stop: n.stop, stopEdges: n.arms.filter((A) => A.stop).map((A) => A.edge.id), roundabout: n.roundabout, outline: Float32Array.from(n.outline),
  }));
  const decks: GeoDeck[] = net.edges.filter((e) => e.deck).map((e) => ({ roadId: e.road.id, edge: e.id, name: e.name, layer: e.layer, centre: centreOf(net, e), halfWidth: e.hw }));
  const omittedSet = omittedRoads(doc);
  const omitted = doc.roads.filter((r) => omittedSet.has(r)).map((r) => ({
    roadId: r.id, name: r.name ?? '', reason: doc.meta.synthetic
      ? 'K St underpass beneath Washington Circle: not rendered (ramps would need >15% grades between the split nodes and the ring); remove from the graph'
      : r.tunnel || r.layer < 0 ? 'tunnel or below-ground road (the K St underpass): the world has no tunnel geometry yet; not rendered, not in the graph' : 'approach to an omitted tunnel (would dead-end at the portal): not rendered, not in the graph',
  }));

  // ---------------------------------------------------------------- queries (no allocation)
  /**
   * The ground (not decks) under (x, z): the highest walking-surface collider there, or with y the highest one at
   * most a level step above y (under a footbridge you stand on the towpath). The raster where no collider covers the
   * point (inside buildings, open water).
   */
  const groundAt = (x: number, z: number, y?: number) => {
    const h = surf.at(x, z, y === undefined ? Infinity : y + TUNING.map.levelStep);
    return h === h ? h : ras.heightAt(x, z);
  };
  const heightAt = (x: number, z: number) => groundAt(x, z);
  const surface = (x: number, z: number, y: number | undefined, walk: boolean) => {
    const g = groundAt(x, z, y);
    let best = g, bd = y === undefined ? -g : Math.abs(g - y);
    deckIdx.query(x, z, walk, (hDeck) => {
      const d = y === undefined ? -hDeck : Math.abs(hDeck - y);
      if (d < bd) { bd = d; best = hDeck; }
    });
    return best;
  };
  const roadSurfaceAt = (x: number, z: number, y?: number) => surface(x, z, y, false);
  /**
   * The walking surface under something at height y (the highest one without y): ground, a deck or a pier, from the
   * colliders themselves where they are triangles (the analytic deck profiles put Key Bridge's carriageway a kerb
   * high and the freeway up to 0.4 m off).
   */
  let pierBest = 0, pierD = 0, pierY: number | undefined;
  const pierVisit = (h: number) => { const d = pierY === undefined ? -h : Math.abs(h - pierY); if (d < pierD) { pierD = d; pierBest = h; } };
  const walkSurfaceAt = (x: number, z: number, y?: number) => {
    const ceil = y === undefined ? Infinity : y + TUNING.map.levelStep;
    const ge = surf.at(x, z, ceil), g = ge === ge ? ge : ras.heightAt(x, z);
    pierBest = g; pierD = y === undefined ? -g : Math.abs(g - y); pierY = y;
    const dk = deckSurf.at(x, z, ceil);
    if (dk === dk) pierVisit(dk);
    // no deck triangle and no ground near the height asked about (Key Bridge running off the map edge over the river):
    // the deck profiles (at a bridge's end at grade the ground is right there, and the profiles are a kerb off)
    if (dk !== dk && (ge !== ge || (y !== undefined && ge < y - TUNING.map.levelStep))) deckIdx.query(x, z, true, pierVisit);
    else pierIdx.query(x, z, true, pierVisit);
    return pierBest;
  };
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
    treeLod.setRadius(TUNING.quality[q].treeNear);
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
    treeLod.update(camPos);
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
    signalHeads: props.signalHeads,
    litWindowMat, lampMat, lampPoolMat, groundMats: [],
    water: { meshes: water.meshes, update: water.update },
    update, setQuality, quality,
    omitted,
    audit: { buildingsClipped: clipped.clipped, buildingsDropped: clipped.drop, stoops: bld.stoops, stoopInfo: bld.stoopInfo },
    droppedBuildings: dropped,
    stats: { bootMs: 0, phases, tris: tris + props.tris + bld.extraTris, meshes: meshCount, colliders: phys.colliders, trimeshTris, surfaceTris: surf.count },
    solidTags: phys.tags,
    solidRecorder: chunks.rec,
    stairs: stairs.map((st) => ({ pts: st.pts, w: st.w, L: st.L, name: st.name, h: st.h, flights: st.flights })),
    footbridges: water.walkDecks.map((d) => ({ pts: d.pts, h: d.h, hw: d.hw })),
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

/** Required deck heights for bridge profiles: what passes beneath + clearance. */
function makeProbe(net: RoadNet, W: WaterModel, ras: GeoRaster, doc: GeoDoc, synthetic: boolean) {
  const grid = new SegGrid(32);
  for (const e of net.edges) grid.addLine(e.pts, e.id, e.hw + 4);
  const paths = new SegGrid(32);
  for (const f of doc.footways) if ((f.kind === 'path' || f.kind === 'cycleway') && !f.towpath) paths.addLine(f.pts, 0, 3); // the towpath is handled with the canal
  const CANAL_HALF = 6;
  /** Nodes one short at-grade piece away from n. */
  const hops = new Map<RNode, Set<RNode>>();
  const hop1 = (n: RNode) => {
    let s = hops.get(n);
    if (!s) {
      s = new Set();
      for (const a of n.arms) if (!a.edge.deck && a.edge.L < G.deckJoinHop) s.add(a.edge.a === n ? a.edge.b : a.edge.a);
      hops.set(n, s);
    }
    return s;
  };
  return (x: number, z: number, layer: number, self: REdge) => {
    const th = G.deckThickness + (self.freeway ? 0.3 : 0);
    let req = -Infinity;
    let ground = ras.baseAt(x, z);
    grid.query(x, z, (_s, id, d) => {
      const e = net.edges[id];
      if (e === self || d > e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0) + 0.6) return;
      if (e.deck && e.layer >= layer) return;
      // real data: the street's own other carriageway is alongside, not beneath (no named road crosses itself on another
      // layer in the data). The Whitehurst Freeway's two halves drop to layer 1 under the Key Bridge 8 m apart, so
      // each half's layer-2 deck "cleared" the other half's layer-1 piece, which then cleared the first: they
      // leapfrogged to 37 m and the Key Bridge, clearing them, to 38 m (M St is at 21 m)
      if (!synthetic && self.name && e.name === self.name) return;
      // a road sharing a node with this deck, or one short piece away (real data: K St's bridge over Rock Creek ends
      // 6 m before the junction its at-grade continuation leaves): ignore it near that node, it is where they join
      const near = (n: RNode) => n === self.a || n === self.b || (!synthetic && (hop1(self.a).has(n) || hop1(self.b).has(n)));
      if (near(e.a) || near(e.b)) {
        const pr0 = net.project(e, x, z);
        if (pr0.s < e.trimA + 25 && near(e.a)) return;
        if (pr0.s > e.L - e.trimB - 25 && near(e.b)) return;
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
    // the spec's freeway runs elevated above K St / Water St (real data: the roads beneath set the clearance)
    if (synthetic && self.freeway && x > -620 && x < 250) req = Math.max(req, ground + G.freewayClearance + th);
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

/**
 * Spatial index over deck surfaces (road decks and walkable structures) for roadSurfaceAt / walkSurfaceAt. Road decks
 * cover the carriageway plus a sidewalk only on the sides that have one (raised by the kerb), so a query beside a
 * deck that has no sidewalk on that side falls through to the ground below.
 */
function buildDeckIndex(net: RoadNet | null, walkDecks: { pts: Pt[]; hw: number; h: number[] }[]) {
  // flat arrays per segment: ax, az, bx, bz, ha, hb, carriageway half width, left extent, right extent, walkOnly
  const N = 10;
  const S: number[] = [];
  const grid = new SegGrid(16);
  const kerb = G.kerbHeight;
  for (const e of net?.edges ?? []) {
    if (!e.deck || !net) continue;
    const X = sections(e, e.trimA, e.L - e.trimB);
    for (let i = 1; i < X.length; i++) {
      const sm = (X[i - 1].s + X[i].s) / 2;
      const sw = (side: number) => (side < 0 ? e.swL : e.swR) && !e.noSw.some((r) => r[0] === side && sm >= r[1] && sm <= r[2]);
      const wl = e.hw + (sw(-1) ? G.sidewalkWidth : 0), wr = e.hw + (sw(1) ? G.sidewalkWidth : 0);
      const id = S.length / N;
      S.push(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, net.profAt(e, X[i - 1].s), net.profAt(e, X[i].s), e.hw, wl, wr, 0);
      grid.add(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, id, Math.max(wl, wr) + 0.5);
    }
    // the deck's own plateaus at its ends (flat at the junction's height, under the junction surface): carriageway only
    for (const [a, b] of [[0, e.trimA], [e.L - e.trimB, e.L]]) {
      if (b - a < 0.05) continue;
      const P = sections(e, a, b);
      for (let i = 1; i < P.length; i++) {
        const id = S.length / N;
        S.push(P[i - 1].x, P[i - 1].z, P[i].x, P[i].z, net.profAt(e, P[i - 1].s), net.profAt(e, P[i].s), e.hw, e.hw, e.hw, 0);
        grid.add(P[i - 1].x, P[i - 1].z, P[i].x, P[i].z, id, e.hw + 0.5);
      }
    }
  }
  // at-grade stretches that pass over or under another road (flagged by rasterizeNet): their own surface, carriageway only
  for (const e of net?.edges ?? []) {
    if (e.deck || !e.overlay || !net) continue;
    const X = sections(e, 0, e.L);
    for (let i = 1; i < X.length; i++) {
      if (!e.overlay[i]) continue;
      const id = S.length / N;
      S.push(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, net.profAt(e, X[i - 1].s), net.profAt(e, X[i].s), e.hw, e.hw, e.hw, 0);
      grid.add(X[i - 1].x, X[i - 1].z, X[i].x, X[i].z, id, e.hw + 0.5);
    }
  }
  // junctions inside a bridge: a flat disc at the node height covering its outline
  for (const n of net?.nodes ?? []) {
    if (n.outline.length < 6 || !isDeckNode(n)) continue;
    let r = 0;
    for (let i = 0; i < n.outline.length; i += 2) r = Math.max(r, Math.hypot(n.outline[i] - n.x, n.outline[i + 1] - n.z));
    const id = S.length / N;
    S.push(n.x, n.z, n.x + 0.01, n.z, n.h, n.h, r, r, r, 0);
    grid.add(n.x, n.z, n.x + 0.01, n.z, id, r + 0.5);
  }
  for (const w of walkDecks) {
    for (let i = 1; i < w.pts.length; i++) {
      const id = S.length / N;
      S.push(w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1], w.h[i - 1], w.h[i], w.hw, w.hw, w.hw, 1);
      grid.add(w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1], id, w.hw);
    }
  }
  let cbRef: ((h: number) => void) | null = null;
  let walkRef = false, qx = 0, qz = 0;
  const visit = (_seg: number, id: number, d: number, t: number) => {
    const o = id * N;
    if (S[o + 9] === 1 && !walkRef) return;
    // side of the query point: + right of travel (as roadMesh sections)
    const right = (qx - S[o]) * -(S[o + 3] - S[o + 1]) + (qz - S[o + 1]) * (S[o + 2] - S[o]) > 0;
    const lim = right ? S[o + 8] : S[o + 7];
    if (d > lim + 0.05) return;
    const h = S[o + 4] + (S[o + 5] - S[o + 4]) * t;
    cbRef!(S[o + 9] === 0 && d > S[o + 6] ? h + kerb : h);
  };
  return {
    query(x: number, z: number, walk: boolean, cb: (h: number) => void) {
      cbRef = cb;
      walkRef = walk;
      qx = x;
      qz = z;
      grid.query(x, z, visit);
      cbRef = null;
    },
  };
}

/** Footpaths, trails, the towpath links and the promenade: draped ribbons on the terrain (decals). */
function drawPaths(doc: GeoDoc, ras: GeoRaster, chunks: RenderChunks) {
  const colOf = (f: GeoDoc['footways'][number]) => {
    if (f.surface === 'gravel') return surf(SURF.GRAVEL, linHex(0xc2ad86));
    if (f.surface === 'asphalt' || f.kind === 'cycleway') return surf(SURF.ASPHALT, linHex(0x6e6d6a));
    if (f.surface === 'paving_stones') return surf(SURF.CONCRETE_SLAB, linHex(0xc9b9a0));
    return surf(SURF.GRAVEL, linHex(0xb9a98e));
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
    const col = colOf(f);
    for (const r of runs) drapeRibbon(buf, r, w, (x, z) => ras.heightAt(x, z), col, 0.035);
  }
}
