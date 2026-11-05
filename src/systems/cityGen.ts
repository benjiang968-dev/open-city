// Generates the coastal district from a seed: road grid, blocks, buildings, bay, beach, marina,
// pier, industrial dock, props, and the graphs that traffic and pedestrians use.
// Everything is parameterised by TUNING.world so the generator can scale up later.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import { Rng } from '../rng';
import { POI_TEMPLATES, STREET_WORDS } from '../names';
import { GeoBuilder } from '../art/geo';
import { GROUPS } from '../physicsGroups';
import { PROP_COLLIDERS, PROP_KIND, SolidRecorder, SolidTags, type ColliderPart, type PropColliderName, type SolidKind } from './objects/solidKinds';

const T = TUNING.world;

export interface RoadNode {
  id: number;
  i: number;
  j: number;
  x: number;
  z: number;
  nbrs: number[];
}
export interface SideNode {
  id: number;
  x: number;
  z: number;
  nbrs: number[];
}
export interface Poi {
  id: number;
  name: string;
  kind: string;
  x: number; // on the pavement
  z: number;
  curbX: number; // in the road next to the kerb (where cars stop)
  curbZ: number;
  street: string;
  sideNode: number;
}
export interface ParkingSpot {
  x: number;
  z: number;
  heading: number; // yaw (radians), car forward = +Z rotated by heading
}
export interface Boat {
  mesh: THREE.Object3D;
  baseY: number;
  phase: number;
}

export interface CityData {
  xs: number[]; // x of north-south roads
  zs: number[]; // z of east-west roads
  roadHalfX: number[]; // half width of each north-south road
  roadHalfZ: number[]; // half width of each east-west road
  streetNamesX: string[];
  streetNamesZ: string[];
  nodes: RoadNode[];
  sideNodes: SideNode[];
  pois: Poi[];
  taxiRanks: Poi[];
  parkingSpots: ParkingSpot[];
  coastZ: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  buildingRects: { x0: number; z0: number; x1: number; z1: number; h: number }[];
  parkRects: { x0: number; z0: number; x1: number; z1: number }[];
  pierRect: { x0: number; z0: number; x1: number; z1: number };
  marinaRects: { x0: number; z0: number; x1: number; z1: number }[];
  center: { x: number; z: number };
  // materials the day/night system adjusts
  litWindowMat: THREE.MeshBasicMaterial;
  lampMat: THREE.MeshBasicMaterial;
  lampPoolMat: THREE.MeshBasicMaterial;
  /** Ground + road materials (weather makes them wet or snowy). */
  groundMats: THREE.MeshStandardMaterial[];
  water: THREE.Mesh;
  waterBase: Float32Array;
  boats: Boat[];
  nodeAt(i: number, j: number): RoadNode | undefined;
  /** Collider handle -> solid kind of every static collider. */
  solidTags: SolidTags;
  /** Physics audit mode only: drawn boxes and walls with their kinds (null when off). */
  solidRecorder: SolidRecorder | null;
}

const C = (hex: number | string) => new THREE.Color(hex);
const PALETTE = ['#e8d5b7', '#f2a65a', '#7fb7be', '#d3e4cd', '#f6e3c5', '#c97c5d', '#8e9aaf', '#b8c4bb', '#e9c46a', '#a8dadc', '#f4a261', '#cdb4db', '#ef8a7a', '#9cc5a1'];
const TOWER = ['#6d8ea0', '#8aa1b1', '#a3b7c4', '#56718a', '#b9c6cf', '#7d8b99'];
const COL = {
  grass: C('#7dae5b'),
  park: C('#6fa84f'),
  pavement: C('#c9c4bb'),
  lot: C('#b3ada3'),
  asphalt: C('#4b4e55'),
  marking: C('#f1efe6'),
  yellow: C('#e8c44a'),
  sand: C('#ead7a4'),
  wetSand: C('#cdb886'),
  concrete: C('#a9a9a4'),
  wood: C('#9a6b45'),
  darkWood: C('#6e4a30'),
  seawall: C('#8b8d8a'),
  roof: C('#8c8f96'),
  glassDark: C('#4f6378'),
  windowWarm: C('#fff0c4'),
};

// --------------------------------------------------------------------------------------------
export function generateCity(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number, audit = false): CityData {
  const rng = new Rng(seed ^ 0x51ed);
  const pitch = T.blockSize + T.roadWidth;
  const xs: number[] = [];
  const zs: number[] = [];
  const x0 = -(T.blocksX * pitch) / 2;
  const zWater = 60; // z of the waterfront boulevard centreline
  const z0 = zWater - T.blocksZ * pitch;
  for (let i = 0; i <= T.blocksX; i++) xs.push(x0 + i * pitch);
  for (let j = 0; j <= T.blocksZ; j++) zs.push(z0 + j * pitch);
  const roadHalfX = xs.map(() => T.roadWidth / 2);
  const roadHalfZ = zs.map((_, j) => (j === T.blocksZ ? T.waterfrontRoadWidth / 2 : T.roadWidth / 2));
  const coastZ = zWater + roadHalfZ[T.blocksZ] + T.beachDepth;
  const margin = 30;
  const bounds = { minX: xs[0] - margin, maxX: xs[xs.length - 1] + margin, minZ: z0 - margin, maxZ: coastZ + 420 };
  const center = { x: (xs[0] + xs[xs.length - 1]) / 2, z: (zs[0] + zs[zs.length - 2]) / 2 };

  const streetRng = rng.fork(7);
  const words = [...STREET_WORDS];
  const takeWord = () => words.splice(Math.floor(streetRng.next() * words.length), 1)[0] ?? 'Unnamed';
  const streetNamesX = xs.map(() => `${takeWord()} Ave`);
  const streetNamesZ = zs.map((_, j) => (j === T.blocksZ ? 'Bayfront Blvd' : `${takeWord()} St`));

  // ---------- road graph ----------
  const nodes: RoadNode[] = [];
  const nodeIndex = new Map<string, RoadNode>();
  for (let j = 0; j <= T.blocksZ; j++)
    for (let i = 0; i <= T.blocksX; i++) {
      const n: RoadNode = { id: nodes.length, i, j, x: xs[i], z: zs[j], nbrs: [] };
      nodes.push(n);
      nodeIndex.set(`${i},${j}`, n);
    }
  const nodeAt = (i: number, j: number) => nodeIndex.get(`${i},${j}`);
  for (const n of nodes) {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const m = nodeAt(n.i + di, n.j + dj);
      if (m) n.nbrs.push(m.id);
    }
  }

  // ---------- pedestrian pavement graph (block corners) ----------
  const sideNodes: SideNode[] = [];
  const sideIndex = new Map<string, SideNode>();
  for (const n of nodes)
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const ox = roadHalfX[n.i] + T.sidewalkWidth / 2;
        const oz = roadHalfZ[n.j] + T.sidewalkWidth / 2;
        const s: SideNode = { id: sideNodes.length, x: n.x + sx * ox, z: n.z + sz * oz, nbrs: [] };
        sideNodes.push(s);
        sideIndex.set(`${n.i},${n.j},${sx},${sz}`, s);
      }
  const linkSide = (a?: SideNode, b?: SideNode) => {
    if (!a || !b) return;
    a.nbrs.push(b.id);
    b.nbrs.push(a.id);
  };
  for (const n of nodes) {
    const g = (i: number, j: number, sx: number, sz: number) => sideIndex.get(`${i},${j},${sx},${sz}`);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (sx === 1) linkSide(g(n.i, n.j, 1, sz), g(n.i, n.j, -1, sz)); // crossing
      if (sz === 1) linkSide(g(n.i, n.j, sx, 1), g(n.i, n.j, sx, -1)); // crossing
    }
    for (const sz of [-1, 1]) linkSide(g(n.i, n.j, 1, sz), g(n.i + 1, n.j, -1, sz));
    for (const sx of [-1, 1]) linkSide(g(n.i, n.j, sx, 1), g(n.i, n.j + 1, sx, -1));
  }
  const nearestSide = (x: number, z: number) => {
    let best = 0, bd = Infinity;
    for (const s of sideNodes) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  };

  // ---------- builders ----------
  const rec = audit ? new SolidRecorder() : null;
  const tag = (k: SolidKind) => { if (rec) rec.tag(k); };
  const solidTags = new SolidTags();
  const ground = new GeoBuilder();
  const marks = new GeoBuilder();
  const chunkSize = 200;
  const buildChunks = new Map<string, GeoBuilder>();
  const chunk = (x: number, z: number) => {
    const key = `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`;
    let b = buildChunks.get(key);
    if (!b) { buildChunks.set(key, (b = new GeoBuilder())); b.rec = rec; }
    return b;
  };
  const winLit = new GeoBuilder();
  const winDark = new GeoBuilder();
  const props = new GeoBuilder();
  const signs = new GeoBuilder();
  for (const gb of [ground, marks, winLit, winDark, props, signs]) gb.rec = rec;
  // static colliders are grouped into one fixed body per 120 m area: a single body with ~1500 colliders
  // made continuous collision detection (CCD) on the player's car expensive at impact time
  const staticBodies = new Map<string, RAPIER.RigidBody>();
  const staticAt = (x: number, z: number) => {
    const key = `${Math.floor(x / 120)},${Math.floor(z / 120)}`;
    let b = staticBodies.get(key);
    if (!b) staticBodies.set(key, (b = physics.createRigidBody(R.RigidBodyDesc.fixed())));
    return b;
  };
  const addBoxCollider = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: SolidKind = 'untagged') => {
    const c = physics.createCollider(
      R.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).setFriction(0.6).setCollisionGroups(GROUPS.static),
      staticAt((x0 + x1) / 2, (z0 + z1) / 2),
    );
    solidTags.set(c.handle, kind);
  };
  /** Upright cylinder collider standing on y0. */
  const addCylCollider = (x: number, y0: number, z: number, r: number, h: number, kind: SolidKind) => {
    const c = physics.createCollider(R.ColliderDesc.cylinder(h / 2, r).setTranslation(x, y0 + h / 2, z).setCollisionGroups(GROUPS.static), staticAt(x, z));
    solidTags.set(c.handle, kind);
  };
  /** A prop's colliders from the registry (axis-aligned props: the grid draws them unrotated). */
  const placeProp = (name: PropColliderName, x: number, y: number, z: number) => {
    for (const p of PROP_COLLIDERS[name] as readonly ColliderPart[]) {
      if (p.shape === 'box') addBoxCollider(x + p.c[0] - p.h[0], y + p.c[1] - p.h[1], z + p.c[2] - p.h[2], x + p.c[0] + p.h[0], y + p.c[1] + p.h[1], z + p.c[2] + p.h[2], PROP_KIND[name]);
      else addCylCollider(x + p.c[0], y + p.c[1], z + p.c[2], p.r, p.h, PROP_KIND[name]);
    }
  };

  // land base (grass) and the ground collider
  const landX0 = bounds.minX - 40, landX1 = bounds.maxX + 40, landZ0 = bounds.minZ - 40;
  tag('ground');
  ground.quadY(landX0, landZ0, landX1, coastZ, 0, COL.grass);
  addBoxCollider(landX0, -2, landZ0, landX1, 0, coastZ, 'ground');
  // sea floor and seawall face
  const seaZ1 = bounds.maxZ + 60;
  addBoxCollider(landX0, -T.seaFloorDepth - 2, coastZ, landX1, -T.seaFloorDepth, seaZ1, 'ground');
  const seaFloor = new GeoBuilder();
  seaFloor.quadY(landX0, coastZ, landX1, seaZ1, -T.seaFloorDepth, C('#5f7d73'));
  tag('decor'); // the seawall face below the land's edge (the land box edge collides)
  props.wall((landX0 + landX1) / 2, -T.seaFloorDepth / 2, coastZ, landX1 - landX0, T.seaFloorDepth, 0, 1, COL.seawall);
  tag('ground');

  // ---------- roads ----------
  const xMin = xs[0], xMax = xs[xs.length - 1], zMin = zs[0], zMax = zs[zs.length - 1];
  // outer pavement ring so the edge roads have footpaths
  const pw = T.sidewalkWidth;
  ground.quadY(xMin - roadHalfX[0] - pw, zMin - roadHalfZ[0] - pw, xMax + roadHalfX[0] + pw, zMax + roadHalfZ[T.blocksZ], 0.015, COL.pavement);
  for (let i = 0; i < xs.length; i++) {
    const h = roadHalfX[i];
    ground.quadY(xs[i] - h, zMin - roadHalfZ[0], xs[i] + h, zMax + roadHalfZ[T.blocksZ], 0.03, COL.asphalt);
  }
  for (let j = 0; j < zs.length; j++) {
    const h = roadHalfZ[j];
    ground.quadY(xMin - roadHalfX[0], zs[j] - h, xMax + roadHalfX[0], zs[j] + h, 0.031, COL.asphalt);
  }
  // lane markings: dashed centre lines between intersections, crosswalks at intersections
  for (let j = 0; j < zs.length; j++)
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i] + roadHalfX[i] + 4, b = xs[i + 1] - roadHalfX[i + 1] - 4;
      for (let x = a; x < b; x += 6) marks.quadY(x, zs[j] - 0.12, Math.min(x + 3, b), zs[j] + 0.12, 0.05, j === T.blocksZ ? COL.yellow : COL.marking);
    }
  for (let i = 0; i < xs.length; i++)
    for (let j = 0; j < zs.length - 1; j++) {
      const a = zs[j] + roadHalfZ[j] + 4, b = zs[j + 1] - roadHalfZ[j + 1] - 4;
      for (let z = a; z < b; z += 6) marks.quadY(xs[i] - 0.12, z, xs[i] + 0.12, Math.min(z + 3, b), 0.05, COL.marking);
    }
  for (const n of nodes) {
    const hx = roadHalfX[n.i], hz = roadHalfZ[n.j];
    for (const s of [-1, 1]) {
      // stripes crossing the east-west road (on the west/east side of the junction)
      for (let k = -hz + 0.6; k < hz - 0.6; k += 1.4) {
        marks.quadY(n.x + s * (hx + 0.4), n.z + k, n.x + s * (hx + 2.6), n.z + k + 0.7, 0.05, COL.marking);
      }
      for (let k = -hx + 0.6; k < hx - 0.6; k += 1.4) {
        marks.quadY(n.x + k, n.z + s * (hz + 0.4), n.x + k + 0.7, n.z + s * (hz + 2.6), 0.05, COL.marking);
      }
    }
  }

  // ---------- blocks, buildings, parks ----------
  const buildingRects: CityData['buildingRects'] = [];
  const parkRects: CityData['parkRects'] = [];
  const pois: Poi[] = [];
  const nameUse = new Map<string, number>();
  const kindRng = rng.fork(99);
  const poiName = (kind: string, street: string) => {
    const list = POI_TEMPLATES[kind] ?? [kind];
    const used = nameUse.get(kind) ?? 0;
    nameUse.set(kind, used + 1);
    const base = list[(used + Math.floor(kindRng.next() * list.length)) % list.length];
    return used >= list.length ? `${base} (${street})` : base;
  };
  const maxD = Math.hypot(xMax - center.x, zMax - center.z);
  const isIndustrial = (bi: number, bj: number) => bi >= T.blocksX - 2 && bj >= T.blocksZ - 2;
  const parkForced = new Set([`2,${T.blocksZ - 2}`]);

  type BlockInfo = { bi: number; bj: number; x0: number; z0: number; x1: number; z1: number; kind: 'build' | 'park' | 'industrial' };
  const blocks: BlockInfo[] = [];
  for (let bj = 0; bj < T.blocksZ; bj++)
    for (let bi = 0; bi < T.blocksX; bi++) {
      const bx0 = xs[bi] + roadHalfX[bi], bx1 = xs[bi + 1] - roadHalfX[bi + 1];
      const bz0 = zs[bj] + roadHalfZ[bj], bz1 = zs[bj + 1] - roadHalfZ[bj + 1];
      let kind: BlockInfo['kind'] = isIndustrial(bi, bj) ? 'industrial' : 'build';
      if (kind === 'build' && (parkForced.has(`${bi},${bj}`) || rng.chance(T.parkChance))) kind = 'park';
      blocks.push({ bi, bj, x0: bx0, z0: bz0, x1: bx1, z1: bz1, kind });
    }

  const treeSpots: { x: number; z: number; s: number }[] = [];
  for (const b of blocks) {
    ground.quadY(b.x0, b.z0, b.x1, b.z1, 0.02, COL.pavement);
    const ix0 = b.x0 + pw, iz0 = b.z0 + pw, ix1 = b.x1 - pw, iz1 = b.z1 - pw;
    if (b.kind === 'park') {
      ground.quadY(ix0, iz0, ix1, iz1, 0.04, COL.park);
      parkRects.push({ x0: ix0, z0: iz0, x1: ix1, z1: iz1 });
      // footpaths across the park
      const mx = (ix0 + ix1) / 2, mz = (iz0 + iz1) / 2;
      ground.quadY(mx - 1.5, iz0, mx + 1.5, iz1, 0.05, COL.pavement);
      ground.quadY(ix0, mz - 1.5, ix1, mz + 1.5, 0.05, COL.pavement);
      // fountain
      tag('fountain');
      props.box(mx - 3, 0, mz - 3, mx + 3, 0.7, mz + 3, COL.concrete);
      tag('water');
      props.box(mx - 2.4, 0.7, mz - 2.4, mx + 2.4, 0.72, mz + 2.4, C('#4aa3c8'));
      addBoxCollider(mx - 3, 0, mz - 3, mx + 3, 0.7, mz + 3, 'fountain');
      for (let k = 0; k < T.treesPerPark; k++) {
        const x = rng.range(ix0 + 3, ix1 - 3), z = rng.range(iz0 + 3, iz1 - 3);
        if (Math.abs(x - mx) < 4 || Math.abs(z - mz) < 4) continue;
        treeSpots.push({ x, z, s: rng.range(0.9, 1.5) });
      }
      // benches
      tag('bench');
      for (const [bx, bz] of [[mx + 4, mz - 6], [mx - 4, mz + 6], [mx + 6, mz + 4]]) {
        props.box(bx - 1, 0.4, bz - 0.3, bx + 1, 0.5, bz + 0.3, COL.wood);
        placeProp('gridBench', bx, 0, bz);
      }
      tag('ground');
      const p = addPoi('park', b, rng.pick(['n', 's', 'e', 'w'] as const));
      p.name = poiName('park', p.street);
      continue;
    }
    ground.quadY(ix0, iz0, ix1, iz1, 0.035, COL.lot);
    // split block into lots
    const nx = b.kind === 'industrial' ? rng.int(1, 2) : rng.int(2, 3);
    const nz = b.kind === 'industrial' ? 1 : rng.int(2, 3);
    const lw = (ix1 - ix0) / nx, ld = (iz1 - iz0) / nz;
    for (let a = 0; a < nx; a++)
      for (let c = 0; c < nz; c++) {
        const sb = rng.range(1.0, 4.5);
        let lx0 = ix0 + a * lw + sb, lx1 = ix0 + (a + 1) * lw - sb;
        let lz0 = iz0 + c * ld + sb, lz1 = iz0 + (c + 1) * ld - sb;
        // interior lots (not touching a street) are shrunk so alleys appear
        if (nx === 3 && a === 1 && nz === 3 && c === 1) continue;
        const cx = (lx0 + lx1) / 2, cz = (lz0 + lz1) / 2;
        const d = Math.min(1, Math.hypot(cx - center.x, cz - center.z) / maxD);
        let h: number;
        let col: THREE.Color;
        if (b.kind === 'industrial') {
          h = rng.range(8, 13);
          col = C(rng.pick(['#9aa5a8', '#b8a07e', '#7f8c8d', '#a4846a']));
        } else {
          const tall = Math.pow(1 - d, T.downtownBias);
          h = T.buildingMinH + (T.buildingMaxH - T.buildingMinH) * tall * rng.range(0.35, 1) + rng.range(0, 6);
          if (b.bj === T.blocksZ - 1) h = Math.min(h, rng.range(8, 16)); // low shops facing the bay
          col = h > 32 ? C(rng.pick(TOWER)) : C(rng.pick(PALETTE));
        }
        h = Math.round(h / 3.2) * 3.2 + 0.6;
        addBuilding(lx0, lz0, lx1, lz1, h, col, b.kind === 'industrial');
      }
    // POIs on one or two sides of the block
    const sides = (['n', 's', 'e', 'w'] as const).filter(() => rng.chance(0.5));
    if (sides.length === 0) sides.push('s');
    for (const side of sides.slice(0, 2)) {
      const kind = pickKind(b);
      const p = addPoi(kind, b, side);
      p.name = poiName(kind, p.street);
    }
  }

  function pickKind(b: BlockInfo): string {
    if (b.kind === 'industrial') return kindRng.pick(['garage', 'market', 'shop']);
    if (b.bj === T.blocksZ - 1) return kindRng.pick(['diner', 'bar', 'shop', 'hotel', 'cafe', 'market']);
    const d = Math.hypot((b.x0 + b.x1) / 2 - center.x, (b.z0 + b.z1) / 2 - center.z) / maxD;
    if (d < 0.35) return kindRng.pick(['office', 'office', 'cafe', 'hotel', 'bar', 'clinic', 'gym']);
    return kindRng.pick(['apartment', 'apartment', 'shop', 'cafe', 'diner', 'gym', 'clinic']);
  }

  function addPoi(kind: string, b: BlockInfo, side: 'n' | 's' | 'e' | 'w'): Poi {
    const t = rng.range(0.25, 0.75);
    let x = 0, z = 0, curbX = 0, curbZ = 0, street = '';
    const kerb = T.roadWidth / 2 - 1.6;
    if (side === 'n' || side === 's') {
      x = b.x0 + (b.x1 - b.x0) * t;
      const roadJ = side === 'n' ? b.bj : b.bj + 1;
      z = side === 'n' ? b.z0 + pw / 2 : b.z1 - pw / 2;
      curbX = x;
      curbZ = zs[roadJ] + (side === 'n' ? 1 : -1) * (roadHalfZ[roadJ] - 1.6);
      street = streetNamesZ[roadJ];
    } else {
      z = b.z0 + (b.z1 - b.z0) * t;
      const roadI = side === 'w' ? b.bi : b.bi + 1;
      x = side === 'w' ? b.x0 + pw / 2 : b.x1 - pw / 2;
      curbZ = z;
      curbX = xs[roadI] + (side === 'w' ? 1 : -1) * kerb;
      street = streetNamesX[roadI];
    }
    const p: Poi = { id: pois.length, name: kind, kind, x, z, curbX, curbZ, street, sideNode: nearestSide(x, z) };
    pois.push(p);
    return p;
  }

  function addBuilding(x0: number, z0: number, x1: number, z1: number, h: number, col: THREE.Color, industrial: boolean) {
    const b = chunk((x0 + x1) / 2, (z0 + z1) / 2);
    const side = col.clone().multiplyScalar(0.92);
    tag('building');
    b.box(x0, 0, z0, x1, h, z1, col, side);
    // roof cap and roof clutter
    tag('roof');
    b.box(x0 - 0.15, h, z0 - 0.15, x1 + 0.15, h + 0.5, z1 + 0.15, COL.roof);
    if (!industrial && rng.chance(0.6)) {
      const rx = rng.range(x0 + 1, x1 - 4), rz = rng.range(z0 + 1, z1 - 4);
      b.box(rx, h + 0.5, rz, rx + rng.range(2, 3.5), h + rng.range(1.5, 3), rz + rng.range(2, 3.5), C('#8d9096'));
    }
    tag('decor'); // doors and windows flush with the facades
    if (industrial) {
      // big roller doors instead of windows
      const w = x1 - x0;
      for (let k = 0; k < Math.max(1, Math.floor(w / 9)); k++) {
        const dx = x0 + (k + 0.5) * (w / Math.max(1, Math.floor(w / 9)));
        props.wall(dx, 2.2, z1 + 0.05, 4.5, 4.4, 0, 1, C('#5d6a70'));
        props.wall(dx, 2.2, z0 - 0.05, 4.5, 4.4, 0, -1, C('#5d6a70'));
      }
    } else {
      // window strips: each floor split into segments, some lit at night
      const floors = Math.floor((h - 1.5) / 3.2);
      const faces: [number, number, number, number, number][] = [
        // cx, cz, width, nx, nz
        [(x0 + x1) / 2, z1 + 0.06, x1 - x0, 0, 1],
        [(x0 + x1) / 2, z0 - 0.06, x1 - x0, 0, -1],
        [x1 + 0.06, (z0 + z1) / 2, z1 - z0, 1, 0],
        [x0 - 0.06, (z0 + z1) / 2, z1 - z0, -1, 0],
      ];
      for (const [fx, fz, fw, nx, nz] of faces) {
        const nseg = Math.max(1, Math.round(fw / 5.5));
        const segW = fw / nseg;
        for (let f = 0; f < floors; f++) {
          const y = 2.6 + f * 3.2;
          for (let s = 0; s < nseg; s++) {
            const off = -fw / 2 + (s + 0.5) * segW;
            const cx = fx + nz * off, cz = fz - nx * off;
            const target = rng.chance(0.42) ? winLit : winDark;
            target.wall(cx, y, cz, segW - 1.2, 1.5, nx, nz, target === winLit ? COL.windowWarm : COL.glassDark);
          }
        }
      }
      // ground floor shop awning on some
      if (h < 20 && rng.chance(0.5)) {
        tag('overhead');
        props.box(x0 + 1, 3.0, z1, x1 - 1, 3.25, z1 + 1.6, C(rng.pick(['#d1495b', '#00798c', '#edae49', '#30638e', '#6a994e'])));
      }
    }
    addBoxCollider(x0, 0, z0, x1, h, z1, 'building');
    buildingRects.push({ x0, z0, x1, z1, h });
  }

  // ---------- waterfront: beach, marina, dock, pier ----------
  tag('ground');
  const promZ0 = zMax + roadHalfZ[T.blocksZ];
  const pierX = xs[2] - 10;
  const marinaX0 = xs[4] + 8, marinaX1 = xs[6] - 8;
  const dockX0 = xs[T.blocksX - 2] - 4;
  // promenade pavement along the boulevard
  ground.quadY(landX0, promZ0, landX1, promZ0 + 4, 0.02, COL.pavement);
  // beach west, boardwalk at marina, concrete quay east
  ground.quadY(landX0, promZ0 + 4, marinaX0, coastZ, 0.01, COL.sand);
  ground.quadY(landX0, coastZ - 5, marinaX0, coastZ, 0.012, COL.wetSand);
  ground.quadY(marinaX0, promZ0 + 4, dockX0, coastZ, 0.02, COL.wood);
  for (let x = marinaX0; x < dockX0; x += 1.2) marks.quadY(x, promZ0 + 4, x + 0.08, coastZ, 0.03, COL.darkWood);
  ground.quadY(dockX0, promZ0 + 4, landX1, coastZ, 0.02, COL.concrete);

  // public pier: drivable deck out into the bay
  const pierW = 10;
  const pierRect = { x0: pierX - pierW / 2, z0: coastZ - 2, x1: pierX + pierW / 2, z1: coastZ + T.pierLength };
  tag('pier');
  props.box(pierRect.x0, -0.5, pierRect.z0, pierRect.x1, 0.05, pierRect.z1, COL.wood, COL.darkWood);
  addBoxCollider(pierRect.x0, -0.5, pierRect.z0, pierRect.x1, 0.0, pierRect.z1, 'pier');
  tag('decor'); // piles under the deck, in the water
  for (let z = coastZ + 6; z < pierRect.z1; z += 8)
    for (const x of [pierRect.x0 + 0.4, pierRect.x1 - 0.4]) props.box(x - 0.3, -T.seaFloorDepth, z - 0.3, x + 0.3, -0.5, z + 0.3, COL.darkWood);
  tag('railing');
  for (const x of [pierRect.x0, pierRect.x1 - 0.25]) {
    props.box(x, 0, pierRect.z0 + 4, x + 0.25, 1.0, pierRect.z1, COL.darkWood);
    addBoxCollider(x, 0, pierRect.z0 + 4, x + 0.25, 1.0, pierRect.z1, 'railing');
  }
  props.box(pierRect.x0, 0, pierRect.z1 - 0.25, pierRect.x1, 1.0, pierRect.z1, COL.darkWood);
  addBoxCollider(pierRect.x0, 0, pierRect.z1 - 0.25, pierRect.x1, 1.0, pierRect.z1, 'railing');
  // kiosk at the end of the pier
  tag('kiosk');
  props.box(pierX - 2, 0, pierRect.z1 - 9, pierX + 2, 3, pierRect.z1 - 5, C('#f28482'));
  tag('roof');
  props.box(pierX - 2.5, 3, pierRect.z1 - 9.5, pierX + 2.5, 3.3, pierRect.z1 - 4.5, C('#f6f1d1'));
  addBoxCollider(pierX - 2, 0, pierRect.z1 - 9, pierX + 2, 3, pierRect.z1 - 5, 'kiosk');

  // marina finger piers with moored boats
  const marinaRects: CityData['marinaRects'] = [];
  const boats: Boat[] = [];
  const mSpan = (marinaX1 - marinaX0) / T.marinaPiers;
  const boatColours = ['#ffffff', '#f4f1de', '#e07a5f', '#3d405b', '#81b29a', '#f2cc8f'];
  for (let k = 0; k < T.marinaPiers; k++) {
    const px = marinaX0 + (k + 0.5) * mSpan;
    const r = { x0: px - 1.6, z0: coastZ - 1, x1: px + 1.6, z1: coastZ + 55 };
    marinaRects.push(r);
    tag('pier');
    props.box(r.x0, -0.4, r.z0, r.x1, 0.05, r.z1, COL.wood, COL.darkWood);
    addBoxCollider(r.x0, -0.4, r.z0, r.x1, 0.0, r.z1, 'pier');
    for (let z = coastZ + 8; z < r.z1; z += 11) {
      for (const s of [-1, 1]) {
        if (!rng.chance(0.7)) continue;
        const hull = C(rng.pick(boatColours)); // (draw order unchanged: colour, then length)
        const len = rng.range(7, 11);
        const boat = makeBoat(hull, len);
        boat.position.set(px + s * 5, T.waterLevel + 0.1, z);
        boat.rotation.y = rng.chance(0.5) ? 0 : Math.PI;
        // static colliders at the resting pose (the hull bobs 0.12 m about it): hull and cabin
        {
          const bw = len * 0.32, flip = boat.rotation.y ? -1 : 1, y0 = boat.position.y, bx = boat.position.x;
          addBoxCollider(bx - bw / 2, y0, z - len / 2, bx + bw / 2, y0 + 1.1, z + len / 2, 'boat');
          const c0 = z + flip * (-len / 4), c1 = z + flip * (len / 6);
          addBoxCollider(bx - bw / 2 + 0.5, y0 + 1.1, Math.min(c0, c1), bx + bw / 2 - 0.5, y0 + 2.2, Math.max(c0, c1), 'boat');
          boat.userData.solidKind = 'boat';
        }
        scene.add(boat);
        boats.push({ mesh: boat, baseY: boat.position.y, phase: rng.range(0, Math.PI * 2) });
      }
    }
  }
  // a cross walkway joining the finger piers
  props.box(marinaX0, -0.4, coastZ + 48, marinaX1, 0.05, coastZ + 52, COL.wood, COL.darkWood);
  addBoxCollider(marinaX0, -0.4, coastZ + 48, marinaX1, 0.0, coastZ + 52, 'pier');

  // industrial dock: container stacks + cranes on the quay
  const contCols = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400'];
  for (let x = dockX0 + 20; x < xMax + roadHalfX[0]; x += 14) {
    if (rng.chance(0.25)) continue;
    const stack = rng.int(1, 3);
    const cz0 = promZ0 + 8;
    tag('container');
    for (let s = 0; s < stack; s++) props.box(x, s * 2.6, cz0, x + 6, s * 2.6 + 2.55, cz0 + 12, C(rng.pick(contCols)));
    addBoxCollider(x, 0, cz0, x + 6, stack * 2.6, cz0 + 12, 'container');
  }
  for (const cx of [dockX0 + 40, dockX0 + 110]) {
    const cz = coastZ - 3;
    tag('column');
    for (const [lx, lz] of [[-4, -6], [4, -6], [-4, 0], [4, 0]]) {
      props.box(cx + lx - 0.5, 0, cz + lz - 0.5, cx + lx + 0.5, 22, cz + lz + 0.5, C('#e9b44c'));
      addBoxCollider(cx + lx - 0.5, 0, cz + lz - 0.5, cx + lx + 0.5, 22, cz + lz + 0.5, 'column');
    }
    tag('overhead'); // the crane's beams
    props.box(cx - 5, 22, cz - 7, cx + 5, 24, cz + 1, C('#e9b44c'));
    props.box(cx - 1.2, 22.5, cz - 30, cx + 1.2, 24, cz + 40, C('#d89a2b'));
  }

  // ---------- waterfront POIs ----------
  const wfPoi = (kind: string, name: string, x: number, z: number) => {
    const p: Poi = {
      id: pois.length, name, kind, x, z,
      curbX: x, curbZ: zMax + roadHalfZ[T.blocksZ] - 1.6, street: 'Bayfront Blvd', sideNode: nearestSide(x, promZ0 + 2),
    };
    pois.push(p);
    return p;
  };
  wfPoi('pier', 'Old Pier', pierX, promZ0 + 3);
  wfPoi('marina', 'Saltwind Marina', (marinaX0 + marinaX1) / 2, promZ0 + 3);
  wfPoi('beach', 'Gullwing Beach', xs[1], promZ0 + 3);
  wfPoi('market', 'Dockside Fish Market', dockX0 + 10, promZ0 + 3);

  // ---------- taxi ranks ----------
  const rankBlocks: [number, number, 'n' | 's' | 'e' | 'w'][] = [
    [Math.floor(T.blocksX / 2), Math.floor(T.blocksZ / 2), 'n'],
    [Math.floor(T.blocksX / 2) + 1, T.blocksZ - 1, 's'],
    [2, 0, 'w'],
  ];
  const taxiRanks: Poi[] = [];
  for (const [bi, bj, side] of rankBlocks) {
    const b = blocks.find((q) => q.bi === bi && q.bj === bj)!;
    const p = addPoi('taxiRank', b, side);
    p.name = `Taxi Rank, ${p.street}`;
    taxiRanks.push(p);
  }

  // ---------- police precinct ----------
  {
    const b = blocks.find((q) => q.bi === 1 && q.bj === 1 && q.kind !== 'park') ?? blocks[0];
    const p = addPoi('police', b, 'e');
    p.name = 'Precinct 4';
  }
  // every city gets at least one clinic (you wake up here after being knocked out)
  if (!pois.some((p) => p.kind === 'clinic')) {
    const b = blocks.find((q) => q.bi === T.blocksX - 3 && q.bj === 2 && q.kind !== 'park') ?? blocks[blocks.length - 1];
    const p = addPoi('clinic', b, 's');
    p.name = 'Bayside Clinic';
  }

  // ---------- parking spots along kerbs ----------
  const parkingSpots: ParkingSpot[] = [];
  const kerbOff = T.roadWidth / 2 - 1.3;
  for (let j = 0; j < T.blocksZ; j++) // east-west streets (skip boulevard)
    for (let i = 0; i < xs.length - 1; i++)
      for (let x = xs[i] + roadHalfX[i] + 10; x < xs[i + 1] - roadHalfX[i + 1] - 10; x += 13) {
        parkingSpots.push({ x, z: zs[j] + kerbOff, heading: Math.PI / 2 }); // southern kerb, heading east (drive on the right)
        parkingSpots.push({ x, z: zs[j] - kerbOff, heading: -Math.PI / 2 }); // northern kerb, heading west
      }
  for (let i = 0; i < xs.length; i++)
    for (let j = 0; j < zs.length - 1; j++)
      for (let z = zs[j] + roadHalfZ[j] + 10; z < zs[j + 1] - roadHalfZ[j + 1] - 10; z += 13) {
        parkingSpots.push({ x: xs[i] + kerbOff, z, heading: Math.PI }); // eastern kerb, heading north
        parkingSpots.push({ x: xs[i] - kerbOff, z, heading: 0 }); // western kerb, heading south
      }
  // don't park on taxi rank or POI kerbs
  const clearOf = (s: ParkingSpot) => pois.every((p) => (p.curbX - s.x) ** 2 + (p.curbZ - s.z) ** 2 > 12 * 12);
  for (let k = parkingSpots.length - 1; k >= 0; k--) if (!clearOf(parkingSpots[k])) parkingSpots.splice(k, 1);

  // ---------- street lights and trees along pavements ----------
  const lampSpots: { x: number; z: number; ax: number; az: number }[] = [];
  const addAlong = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    let k = 0;
    for (let s = 8; s < len - 8; s += T.streetLightSpacing / 2, k++) {
      const x = ax + dx * s, z = az + dz * s;
      if (k % 2 === 0) lampSpots.push({ x, z, ax: -nx, az: -nz });
      else if (rng.chance(0.8)) treeSpots.push({ x: x + nx * 0.6, z: z + nz * 0.6, s: rng.range(0.7, 1.0) });
    }
  };
  for (let j = 0; j < zs.length; j++)
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i] + roadHalfX[i], b = xs[i + 1] - roadHalfX[i + 1];
      const h = roadHalfZ[j] + 0.6;
      addAlong(a, zs[j] - h, b, zs[j] - h, 0, -1);
      addAlong(a, zs[j] + h, b, zs[j] + h, 0, 1);
    }
  for (let i = 0; i < xs.length; i++)
    for (let j = 0; j < zs.length - 1; j++) {
      const a = zs[j] + roadHalfZ[j], b = zs[j + 1] - roadHalfZ[j + 1];
      const h = roadHalfX[i] + 0.6;
      addAlong(xs[i] - h, a, xs[i] - h, b, -1, 0);
      addAlong(xs[i] + h, a, xs[i] + h, b, 1, 0);
    }
  // pier lamps
  for (let z = coastZ + 10; z < pierRect.z1; z += 20) lampSpots.push({ x: pierRect.x0 + 0.8, z, ax: 1, az: 0 });

  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4 });
  const lampPoolMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 6, 6).translate(0, 3, 0);
    const armGeo = new THREE.BoxGeometry(0.08, 0.08, 1.6).translate(0, 5.95, 0.75);
    const headGeo = new THREE.BoxGeometry(0.45, 0.14, 0.7).translate(0, 5.85, 1.45);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.6 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampSpots.length);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, lampSpots.length);
    const heads = new THREE.InstancedMesh(headGeo, lampMat, lampSpots.length);
    const m = new THREE.Matrix4();
    lampSpots.forEach((l, k) => {
      const yaw = Math.atan2(l.ax, l.az);
      m.makeRotationY(yaw).setPosition(l.x, 0, l.z);
      poles.setMatrixAt(k, m);
      arms.setMatrixAt(k, m);
      heads.setMatrixAt(k, m);
      addCylCollider(l.x, 0, l.z, 0.14, 6, 'lamp');
    });
    poles.castShadow = true;
    poles.name = 'lamp-poles'; arms.name = 'lamp-arms'; heads.name = 'lamp-heads';
    poles.userData.solidKind = 'lamp'; arms.userData.solidKind = 'overhead'; heads.userData.solidKind = 'overhead';
    // pools of light on the ground under each lamp (additive, faded in at night)
    const tex = document.createElement('canvas');
    tex.width = tex.height = 64;
    const tg = tex.getContext('2d')!;
    const grad = tg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,220,150,1)');
    grad.addColorStop(0.5, 'rgba(255,200,120,0.45)');
    grad.addColorStop(1, 'rgba(255,190,110,0)');
    tg.fillStyle = grad;
    tg.fillRect(0, 0, 64, 64);
    lampPoolMat.map = new THREE.CanvasTexture(tex);
    const poolGeo = new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2).translate(0, 0.07, 1.6);
    const pools = new THREE.InstancedMesh(poolGeo, lampPoolMat, lampSpots.length);
    lampSpots.forEach((l, k) => {
      m.makeRotationY(Math.atan2(l.ax, l.az)).setPosition(l.x, 0, l.z);
      pools.setMatrixAt(k, m);
    });
    pools.renderOrder = 1;
    pools.name = 'lamp-pools';
    pools.userData.solidKind = 'decor';
    pools.computeBoundingSphere();
    scene.add(pools);
    for (const im of [poles, arms, heads]) {
      im.computeBoundingSphere();
      scene.add(im);
    }
  }
  {
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.4, 5).translate(0, 1.2, 0);
    const crownGeo = new THREE.IcosahedronGeometry(1.7, 0).translate(0, 3.6, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true }), treeSpots.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }), treeSpots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const greens = ['#5c9e47', '#4f8a3e', '#76b051', '#3f7a3a', '#88b84b'];
    treeSpots.forEach((t, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.s, t.s * rng.range(0.9, 1.25), t.s));
      trunks.setMatrixAt(k, m);
      crowns.setMatrixAt(k, m);
      crowns.setColorAt(k, C(rng.pick(greens)));
      addCylCollider(t.x, 0, t.z, 0.22 * t.s, 2.4, 'tree');
    });
    trunks.castShadow = crowns.castShadow = true;
    trunks.name = 'trees'; crowns.name = 'tree-crowns';
    trunks.userData.solidKind = 'tree'; crowns.userData.solidKind = 'overhead';
    for (const im of [trunks, crowns]) {
      im.computeBoundingSphere();
      scene.add(im);
    }
  }

  // ---------- signs: one canvas atlas for every street and shop sign ----------
  const signTexts: { text: string; bg: string }[] = [];
  const streetSignIdx = new Map<string, number>();
  for (const n of [...streetNamesX, ...streetNamesZ]) {
    streetSignIdx.set(n, signTexts.length);
    signTexts.push({ text: n, bg: '#1f6f4a' });
  }
  const shopSigns = pois.filter((p) => !['park', 'taxiRank', 'apartment'].includes(p.kind));
  const shopSignIdx = new Map<number, number>();
  const signBgs = ['#d1495b', '#00798c', '#30638e', '#edae49', '#6a4c93', '#2b2d42', '#e76f51'];
  for (const p of shopSigns) {
    shopSignIdx.set(p.id, signTexts.length);
    signTexts.push({ text: p.name, bg: rng.pick(signBgs) });
  }
  for (const r of taxiRanks) {
    shopSignIdx.set(r.id, signTexts.length);
    signTexts.push({ text: 'TAXI', bg: '#f4c430' });
  }
  const rowH = 48;
  const atlas = document.createElement('canvas');
  atlas.width = 512;
  atlas.height = THREE.MathUtils.ceilPowerOfTwo(signTexts.length * rowH);
  const g2 = atlas.getContext('2d')!;
  signTexts.forEach((s, k) => {
    g2.fillStyle = s.bg;
    g2.fillRect(0, k * rowH, 512, rowH);
    g2.fillStyle = s.bg === '#f4c430' ? '#111' : '#fff';
    g2.font = 'bold 30px system-ui, sans-serif';
    g2.textAlign = 'center';
    g2.textBaseline = 'middle';
    g2.fillText(s.text, 256, k * rowH + rowH / 2, 490);
  });
  const atlasTex = new THREE.CanvasTexture(atlas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  const uvRow = (k: number) => {
    const v1 = 1 - (k * rowH) / atlas.height, v0 = 1 - ((k + 1) * rowH) / atlas.height;
    return [0, v0, 1, v1];
  };
  const white = C('#ffffff');
  // street name signs at a corner of every intersection
  for (const n of nodes) {
    const px = n.x + roadHalfX[n.i] + 1.2, pz = n.z + roadHalfZ[n.j] + 1.2;
    tag('signPost');
    props.box(px - 0.05, 0, pz - 0.05, px + 0.05, 3.3, pz + 0.05, C('#4a4e54'));
    placeProp('gridSignPost', px, 0, pz);
    const kz = streetSignIdx.get(streetNamesZ[n.j])!;
    const kx = streetSignIdx.get(streetNamesX[n.i])!;
    tag('overhead');
    signs.wall(px, 3.1, pz - 0.06, 2.4, 0.26, 0, -1, white, uvRow(kz));
    signs.wall(px, 3.1, pz + 0.06, 2.4, 0.26, 0, 1, white, uvRow(kz));
    signs.wall(px + 0.06, 2.75, pz, 2.4, 0.26, 1, 0, white, uvRow(kx));
    signs.wall(px - 0.06, 2.75, pz, 2.4, 0.26, -1, 0, white, uvRow(kx));
  }
  // shop signs above POI doors, facing the street
  for (const p of [...shopSigns, ...taxiRanks]) {
    const k = shopSignIdx.get(p.id)!;
    const nx = Math.sign(p.curbX - p.x) * (Math.abs(p.curbX - p.x) > 0.5 ? 1 : 0);
    const nz = Math.sign(p.curbZ - p.z) * (Math.abs(p.curbZ - p.z) > 0.5 ? 1 : 0);
    if (p.kind === 'taxiRank') {
      tag('signPost');
      props.box(p.x - 0.06, 0, p.z - 0.06, p.x + 0.06, 2.6, p.z + 0.06, C('#4a4e54'));
      placeProp('gridTaxiPost', p.x, 0, p.z);
      tag('overhead');
      signs.wall(p.x + nx * 0.08, 2.75, p.z + nz * 0.08, 1.4, 0.5, nx, nz, white, uvRow(k));
      signs.wall(p.x - nx * 0.08, 2.75, p.z - nz * 0.08, 1.4, 0.5, -nx, -nz, white, uvRow(k));
    } else {
      // on the building face behind the pavement
      const back = pw / 2 + 0.7;
      tag('overhead');
      signs.wall(p.x - nx * back, 4.2, p.z - nz * back, 5.5, 0.55, nx, nz, white, uvRow(k));
    }
  }

  // ---------- boundary walls (low sea-wall / hedge) ----------
  const bw = (x0: number, z0: number, x1: number, z1: number, visible: boolean) => {
    addBoxCollider(x0, -10, z0, x1, 4, z1, 'boundary');
    tag('boundary'); // a 1.4 m hedge drawn, a 4 m wall collides: the map edge
    if (visible) props.box(x0, 0, z0, x1, 1.4, z1, C('#4d7c3a'));
  };
  bw(bounds.minX - 2, bounds.minZ - 2, bounds.maxX + 2, bounds.minZ, true);
  bw(bounds.minX - 2, bounds.minZ, bounds.minX, coastZ, true);
  bw(bounds.maxX, bounds.minZ, bounds.maxX + 2, coastZ, true);
  bw(bounds.minX - 2, coastZ, bounds.minX, bounds.maxZ, false);
  bw(bounds.maxX, coastZ, bounds.maxX + 2, bounds.maxZ, false);
  bw(bounds.minX, bounds.maxZ, bounds.maxX, bounds.maxZ + 2, false);

  // ---------- assemble meshes ----------
  const vc = { vertexColors: true } as const;
  const groundMat = new THREE.MeshStandardMaterial({ ...vc, roughness: 0.95 });
  const groundMesh = new THREE.Mesh(ground.build(), groundMat);
  groundMesh.receiveShadow = true;
  groundMesh.name = 'grid-ground';
  scene.add(groundMesh);
  const marksMat = new THREE.MeshStandardMaterial({ ...vc, roughness: 0.8 });
  const marksMesh = new THREE.Mesh(marks.build(), marksMat);
  marksMesh.receiveShadow = true;
  marksMesh.name = 'grid-marks';
  scene.add(marksMesh);
  const seaMesh = new THREE.Mesh(seaFloor.build(), new THREE.MeshStandardMaterial({ ...vc, roughness: 1 }));
  seaMesh.name = 'grid-seafloor';
  scene.add(seaMesh);
  const bMat = new THREE.MeshStandardMaterial({ ...vc, roughness: 0.85, flatShading: true });
  for (const b of buildChunks.values()) {
    if (b.empty) continue;
    const m = new THREE.Mesh(b.build(), bMat);
    m.castShadow = m.receiveShadow = true;
    m.name = 'grid-buildings';
    scene.add(m);
  }
  const litWindowMat = new THREE.MeshBasicMaterial({ ...vc, color: 0x8899aa });
  scene.add(new THREE.Mesh(winLit.build(), litWindowMat));
  scene.add(new THREE.Mesh(winDark.build(), new THREE.MeshStandardMaterial({ ...vc, roughness: 0.2, metalness: 0.4 })));
  const propsMesh = new THREE.Mesh(props.build(), new THREE.MeshStandardMaterial({ ...vc, roughness: 0.8, flatShading: true }));
  propsMesh.castShadow = propsMesh.receiveShadow = true;
  propsMesh.name = 'grid-props';
  scene.add(propsMesh);
  scene.add(new THREE.Mesh(signs.build(true), new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, side: THREE.DoubleSide })));

  // water surface: low-poly plane animated in updateCity
  const waterGeo = new THREE.PlaneGeometry(landX1 - landX0 + 400, seaZ1 - coastZ + 200, 80, 30);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate((landX0 + landX1) / 2, T.waterLevel, coastZ + (seaZ1 - coastZ + 200) / 2 - 4);
  const water = new THREE.Mesh(
    waterGeo.toNonIndexed(),
    new THREE.MeshStandardMaterial({ color: 0x2f86b8, roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.9, flatShading: true }),
  );
  water.receiveShadow = true;
  water.name = 'grid-water';
  scene.add(water);
  const waterBase = Float32Array.from((water.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);

  return {
    xs, zs, roadHalfX, roadHalfZ, streetNamesX, streetNamesZ, nodes, sideNodes, pois, taxiRanks, parkingSpots,
    coastZ, bounds, buildingRects, parkRects, pierRect, marinaRects, center, litWindowMat, lampMat, lampPoolMat, groundMats: [groundMat, marksMat], water, waterBase, boats,
    nodeAt,
    solidTags, solidRecorder: rec,
  };

  function makeBoat(col: THREE.Color, len: number): THREE.Object3D {
    const b = new GeoBuilder();
    const w = len * 0.32;
    b.box(-w / 2, 0, -len / 2, w / 2, 1.1, len / 2 - 1.2, col, col.clone().multiplyScalar(0.85));
    b.box(-w / 2 + 0.4, 0, len / 2 - 1.2, w / 2 - 0.4, 1.1, len / 2, col, col.clone().multiplyScalar(0.85));
    b.box(-w / 2 + 0.5, 1.1, -len / 4, w / 2 - 0.5, 2.2, len / 6, C('#f0f0f0'));
    b.box(-w / 2 + 0.6, 1.6, len / 6 - 0.02, w / 2 - 0.6, 2.0, len / 6 + 0.02, COL.glassDark);
    const m = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }));
    m.castShadow = true;
    return m;
  }
}

/** Animates water and moored boats. */
export function updateCity(city: CityData, t: number): void {
  const pos = city.water.geometry.getAttribute('position') as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  const b = city.waterBase;
  for (let k = 0; k < a.length; k += 3) {
    const x = b[k], z = b[k + 2];
    a[k + 1] = b[k + 1] + Math.sin(x * 0.07 + t * 1.1) * 0.18 + Math.cos(z * 0.09 + t * 0.8) * 0.14;
  }
  pos.needsUpdate = true; // water is flat-shaded: no normals to recompute
  for (const boat of city.boats) {
    boat.mesh.position.y = boat.baseY + Math.sin(t * 1.3 + boat.phase) * 0.12;
    boat.mesh.rotation.z = Math.sin(t * 0.9 + boat.phase) * 0.04;
  }
}
