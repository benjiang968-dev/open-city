// Buildings for the Georgetown world: footprints extruded with a facade generator (storeys, window bays from a texture
// array, doors facing the nearest street, shopfronts with awnings and invented shop names, rowhouse colours, stoops,
// cornices, flat or pitched roofs) plus the landmark shapes (spired hall with clock tower, church steeples, the old
// smokestack, the Car Barn, the Old Stone House, Washington Harbour, the curving-balcony apartment block...).
// Everything is deterministic from the building id; only shop names use the world seed.
import * as THREE from 'three';
import type { GeoDoc, GeoBuilding, Pt } from './geoDoc';
import { centroid, clamp, hashStr, lerp, pointInPoly, project, rand, type SegGrid } from './geoDoc';
import { lin, mixc, shade, type MeshBuf, type PhysChunks, type RenderChunks } from './meshKit';
import type { RoadNet } from './roadNet';
import { B, K, type GeoRaster } from './terrain';
import { TILE } from './facadeTex';
import { POI_NAMES, poiName } from '../../data/poiNames';
import { TUNING } from '../../tuning';
import { facadeColour } from '../render/palette';
import { chooseTemplate, planDoor, recordId, type BuildingRecord, type DoorRec, type WallRec } from '../interiors/records';
import { clipHalf, type P2 } from '../interiors/geom';
import { planInterior } from '../interiors/templates';

// ----------------------------------------------------------------------------------------- art constants
const STOREY = 3.2; // m
const PARAPET = 0.7; // m of wall above the top floor on flat roofs
const WEST_END_X = 380;
const hx = (h: number) => facadeColour(h); // packed linear, tagged with the wall / roof surface (render/palette.ts)
const ROW_COLOURS = [
  [0xad5844, 7], [0xb8664e, 5], [0x9e4c3c, 4], [0xc2735a, 3], // red brick
  [0xead48f, 3], [0xf0e3c4, 3], [0xa9c2d4, 2], [0xa7c4a2, 2], [0xe7b9b4, 2], [0xc9b9d8, 1], [0xf3efe6, 2], [0xe9c79c, 2], [0x9fb4a0, 1], [0xd9a98d, 1],
] as const;
const BRICK = [0xad5844, 0xb8664e, 0x9e4c3c, 0x94503f, 0xbf7a5c, 0xa86b55];
const STONE = [0xc9bfae, 0xd6ccba, 0xb9b09f, 0xa79f92];
const MODERN = [0xd8cdb6, 0xc8c2b5, 0xb8b4ab, 0xe0d8c4, 0x9ea4a6];
const ROOF_FLAT = [0x8d8a84, 0x9a958c, 0x7e7b76, 0xa39c90, 0x8f5a4a, 0x6f7f72, 0xa6aaae];
const ROOF_PITCH = [0x4a4f57, 0x55504b, 0x3f4a52, 0x6b4a3c];
/** Leaf colours of the painted door tiles (facadeTex.ts door()), by tile id. */
const DOOR_COLOURS: Record<number, number> = { [TILE.DOOR_BLACK]: 0x1d2023, [TILE.DOOR_RED]: 0x7b2220, [TILE.DOOR_NAVY]: 0x1f2c47, [TILE.DOOR_GREEN]: 0x1f3f2d };
const AWNINGS = [0x1f5c45, 0x7a2430, 0x23395b, 0x1c1c1f, 0xd8cfb8, 0xb5552e, 0xc79a2e, 0x4f6d3a];
export const SIGN_CATS = /^(amenity=(cafe|restaurant|fast_food|bar|pub|ice_cream|bank|pharmacy|cinema|nightclub)|shop=|tourism=hotel)/;
const AWNING_CATS = /^(amenity=(cafe|restaurant|bar|pub|ice_cream)|shop=(bakery|deli|florist|wine|clothes|shoes|antiques|art|gift|books))/;

/** Landmarks from data/georgetown-spec.json "landmarks" (lat/lon), matched to the nearest footprint of the type. */
const LANDMARKS: { key: string; lat: number; lon: number; type: string; minH?: number; maxArea?: number; minArea?: number }[] = [
  { key: 'healy', lat: 38.9076, lon: -77.0725, type: 'university', minArea: 1200 },
  { key: 'healy-tower', lat: 38.9076, lon: -77.0725, type: 'university', minH: 45 },
  { key: 'carbarn', lat: 38.9056, lon: -77.0699, type: 'commercial', minArea: 1200 },
  { key: 'trinity', lat: 38.9069, lon: -77.0703, type: 'church' },
  { key: 'oldstone', lat: 38.9054, lon: -77.0597, type: 'house', maxArea: 200 },
  { key: 'mall', lat: 38.9047, lon: -77.0638, type: 'retail', minArea: 2500 },
  { key: 'grace', lat: 38.9038, lon: -77.0624, type: 'church' },
  { key: 'stack', lat: 38.90318, lon: -77.06185, type: 'commercial', minH: 32, maxArea: 60 },
  { key: 'harbour', lat: 38.90222, lon: -77.06045, type: 'commercial', minArea: 2000 },
  { key: 'harbour', lat: 38.90212, lon: -77.05945, type: 'commercial', minArea: 2000 },
  { key: 'curvedblock', lat: 38.8995, lon: -77.0553, type: 'apartments', minArea: 2000 },
  { key: 'hospital', lat: 38.9015, lon: -77.0509, type: 'civic', minArea: 1500 },
  { key: 'library', lat: 38.9128, lon: -77.065, type: 'civic' },
  { key: 'mansion', lat: 38.9116, lon: -77.0625, type: 'house', minArea: 300 },
  { key: 'mansion', lat: 38.9135, lon: -77.0632, type: 'civic', minArea: 900 },
  { key: 'boathouse', lat: 38.9002, lon: -77.0575, type: 'warehouse' },
  { key: 'boathouse', lat: 38.90364, lon: -77.0706, type: 'warehouse' },
  { key: 'boathouse', lat: 38.90392, lon: -77.0718, type: 'warehouse' },
  { key: 'boathouse', lat: 38.90411, lon: -77.0728, type: 'warehouse' },
  { key: 'church', lat: 38.9077, lon: -77.0651, type: 'church' },
  { key: 'church', lat: 38.9077, lon: -77.0618, type: 'church' },
  { key: 'church', lat: 38.9069, lon: -77.0584, type: 'church' },
];

// ======================================================================================================
/** Building footprints into the raster (kind BUILDING, terrain mesh skipped under them). */
export function rasterizeBuildings(doc: GeoDoc, ras: GeoRaster, skip: Set<string>) {
  const band = ras.band, k = ras.k;
  for (const b of doc.buildings) {
    if (skip.has(b.id)) continue;
    ras.fillRing(b.pts, (o) => {
      k[o] |= K.BUILDING;
      if (band[o] === B.NONE) band[o] = B.BUILDING;
    });
  }
}

// ======================================================================================================
interface Wall {
  ax: number; az: number; bx: number; bz: number;
  len: number; ux: number; uz: number; nx: number; nz: number;
  party: boolean; street: boolean; front: boolean;
}

export function buildBuildings(doc: GeoDoc, ras: GeoRaster, net: RoadNet, edgeGrid: SegGrid, chunks: RenderChunks, phys: PhysChunks, seed: number, root: THREE.Group, skip: Set<string>) {
  // ---- landmark matching
  const special = new Map<string, string>();
  const used = new Set<string>();
  for (const L of LANDMARKS) {
    const [px, pz] = project(doc, L.lat, L.lon);
    let best: GeoBuilding | null = null, bd = 90;
    for (const b of doc.buildings) {
      if (b.type !== L.type || used.has(b.id)) continue;
      if (L.minH && b.h < L.minH) continue;
      const area = footArea(b.pts);
      if (L.maxArea && area > L.maxArea) continue;
      if (L.minArea && area < L.minArea) continue;
      const c = centroid(b.pts);
      const d = Math.hypot(c[0] - px, c[1] - pz);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) { special.set(best.id, L.key); used.add(best.id); }
  }
  // ---- POIs by building
  const poisBy = new Map<string, GeoDoc['pois']>();
  for (const p of doc.pois) {
    if (!p.b) continue;
    let l = poisBy.get(p.b);
    if (!l) poisBy.set(p.b, (l = []));
    l.push(p);
  }
  // ---- signs (one canvas atlas of unique invented names)
  const signs = new SignAtlas();
  const signBuf = new SignBuf();

  let extraTris = 0;
  /** One record per building drawn (interiors/records.ts): what the interior system builds from. */
  const records: BuildingRecord[] = [];
  const IN = TUNING.interiors;
  const stoopBottoms: number[] = [];
  /** per stoop: door x, z on the wall line, landing height, outward normal x, z, reach of the last step, foot height, steps */
  const stoopInfo: number[] = [];
  for (const b of doc.buildings) {
    if (skip.has(b.id)) continue;
    const key = special.get(b.id) ?? '';
    buildOne(b, key);
  }

  function buildOne(b: GeoBuilding, key: string) {
    chunks.tag('untagged');
    const P = b.pts;
    const n = P.length;
    const [cx, cz] = centroid(P);
    const rnd = rand(hashStr(b.id));
    const fac = chunks.buf('facade', cx, cz);
    const grd = chunks.buf('ground', cx, cz);
    const det = chunks.buf('detail', cx, cz);
    // walls with outward normals; party walls; street-facing walls; the front (nearest road)
    const walls: Wall[] = [];
    for (let i = 0; i < n; i++) {
      const p = P[i], q = P[(i + 1) % n];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.3) continue;
      const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
      let nx = -uz, nz = ux;
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
      // a party wall has a neighbour along most of its length (a small annex or tower doesn't count)
      let touching = 0;
      for (const f of [0.2, 0.5, 0.8]) if (ras.kindAt(p[0] + (q[0] - p[0]) * f + nx * 0.8, p[1] + (q[1] - p[1]) * f + nz * 0.8) & K.BUILDING) touching++;
      const party = touching >= 2;
      let dRoad = Infinity;
      edgeGrid.query(mx + nx * 4, mz + nz * 4, (_s, id, d) => { const e = net.edges[id]; if (!e.deck) dRoad = Math.min(dRoad, d - e.hw); });
      walls.push({ ax: p[0], az: p[1], bx: q[0], bz: q[1], len, ux, uz, nx, nz, party, street: !party && dRoad < 9, front: false });
    }
    if (!walls.length) return;
    let front = walls[0], fd = Infinity;
    for (const w of walls) {
      if (w.party) continue;
      let d = Infinity;
      const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      edgeGrid.query(mx + w.nx * 4, mz + w.nz * 4, (_s, id, dd) => { const e = net.edges[id]; if (!e.deck) d = Math.min(d, dd - e.hw); });
      if (d < fd) { fd = d; front = w; }
    }
    front.front = true;
    // the building's record, and its front door when a template can plan an interior here (interiors/records.ts)
    const myPois = poisBy.get(b.id) ?? [];
    const rec: BuildingRecord = {
      id: recordId(b.id), dataId: b.id, pts: P.map((p) => [p[0], p[1]] as P2), type: b.type, levels: Math.max(1, b.levels), cx, cz,
      yMin: 0, y0: 0, yTop: 0, top: 0, storeys: [], front: walls.indexOf(front), template: key ? null : chooseTemplate(b.id, b.type, myPois.map((p) => p.cat)),
      walls: walls.map((w): WallRec => ({ ax: w.ax, az: w.az, bx: w.bx, bz: w.bz, len: w.len, ux: w.ux, uz: w.uz, nx: w.nx, nz: w.nz, party: w.party, street: w.street, front: w.front, bands: [] })),
      door: null, places: myPois.map((p) => p.id), cats: myPois.map((p) => p.cat), wallColour: 0, plan: null, planErrors: [], core: [], plug: null,
    };
    records.push(rec);
    let door: DoorRec | null = planDoor(rec, 0x1d2023);
    if (!door) rec.template = null;
    rec.door = door;
    // ground levels (an enterable building's floor is set from the pavement at its door, not the wall's middle)
    let yMin = Infinity;
    for (const p of P) yMin = Math.min(yMin, ras.heightAt(p[0] + (cx - p[0]) * 0.05, p[1] + (cz - p[1]) * 0.05));
    const fmx = door ? door.x : (front.ax + front.bx) / 2, fmz = door ? door.z : (front.az + front.bz) / 2;
    const ySide = ras.heightAt(fmx + front.nx * 1.6, fmz + front.nz * 1.6);
    yMin = Math.min(yMin, ySide) - 0.6;
    const t = b.type;
    const westEnd = cx > WEST_END_X;
    const stoop = (t === 'terrace' || t === 'house') && !westEnd ? 0.45 + rnd() * 0.6 : 0.05;
    const y0 = ySide + stoop;
    const levels = Math.max(1, b.levels);
    const ground = t === 'retail' || t === 'warehouse' || (t === 'commercial' && !westEnd) ? 4.2 : t === 'church' ? 0 : STOREY + 0.1;
    let yTop = t === 'church' ? y0 + Math.max(9, b.h * 0.72) : y0 + ground + (levels - 1) * STOREY;
    if (key === 'healy-tower') yTop = y0 + b.h * 0.58;
    if (key === 'healy') yTop = y0 + b.h * 0.72;
    // ---- style
    let col: number;
    let tileUp: number = TILE.ROW_WIN, tileGround: number = TILE.ROW_WIN, tileDoor: number = TILE.DOOR_BLACK, tileSide: number = TILE.ROW_WIN;
    let bay = 2.6;
    let roof: 'flat' | 'hip' | 'gable' | 'steep' = 'flat';
    let cornice = true;
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
    const doors = [TILE.DOOR_BLACK, TILE.DOOR_RED, TILE.DOOR_NAVY, TILE.DOOR_GREEN];
    switch (t) {
      case 'terrace':
      case 'house': {
        col = hx(weighted(ROW_COLOURS, rnd()));
        tileUp = rnd() < 0.65 ? TILE.ROW_SHUT : TILE.ROW_WIN;
        tileGround = tileUp;
        tileDoor = pick(doors);
        bay = t === 'house' ? 3.1 : 2.55;
        if (t === 'house') roof = rnd() < 0.7 ? 'hip' : 'gable';
        if (westEnd) { tileUp = tileGround = TILE.ROW_WIN; }
        break;
      }
      case 'retail':
        col = hx(rnd() < 0.55 ? pick(BRICK) : weighted(ROW_COLOURS, rnd()));
        tileUp = levels > 3 ? TILE.OFFICE : rnd() < 0.5 ? TILE.ROW_WIN : TILE.ROW_SHUT;
        tileGround = TILE.SHOP; tileDoor = TILE.SHOP_DOOR; bay = 3.0;
        break;
      case 'commercial':
        if (westEnd || levels >= 6) { col = hx(pick(MODERN)); tileUp = rnd() < 0.45 ? TILE.CURTAIN : TILE.OFFICE; tileGround = TILE.SHOP; tileDoor = TILE.SHOP_DOOR; bay = 3.0; cornice = false; }
        else { col = hx(pick(BRICK)); tileUp = rnd() < 0.5 ? TILE.ROW_WIN : TILE.ARCH; tileGround = TILE.SHOP; tileDoor = TILE.SHOP_DOOR; bay = 3.0; }
        break;
      case 'apartments':
        col = hx(westEnd ? pick(MODERN) : pick(BRICK)); tileUp = TILE.APT; tileGround = TILE.APT; tileDoor = TILE.SHOP_DOOR; bay = 3.4; cornice = !westEnd;
        break;
      case 'university':
        col = hx(rnd() < 0.6 ? pick(STONE) : pick(BRICK)); tileUp = TILE.UNIV; tileGround = TILE.UNIV; tileDoor = TILE.ARCH; bay = 3.4;
        roof = rnd() < 0.4 ? 'steep' : 'flat';
        break;
      case 'warehouse':
        col = hx(pick(BRICK)); tileUp = TILE.WARE; tileGround = TILE.WARE; tileDoor = TILE.LOADING; bay = 4.6; roof = rnd() < 0.5 ? 'gable' : 'flat'; cornice = false;
        break;
      case 'civic':
        col = hx(rnd() < 0.5 ? pick(STONE) : pick(BRICK)); tileUp = TILE.ARCH; tileGround = TILE.ARCH; tileDoor = TILE.DOOR_BLACK; bay = 3.6;
        break;
      case 'church':
        col = hx(rnd() < 0.5 ? pick(STONE) : pick(BRICK)); tileUp = TILE.CHURCH; tileGround = TILE.CHURCH; tileDoor = TILE.DOOR_RED; bay = 4.2; roof = 'steep'; cornice = false;
        break;
      default:
        col = hx(pick(BRICK));
    }
    // landmark tweaks
    if (key === 'healy' || key === 'healy-tower') { col = hx(0x8f9290); tileUp = tileGround = TILE.ARCH; roof = 'steep'; cornice = false; }
    if (key === 'carbarn') { col = hx(0x9b4a3b); tileUp = TILE.ARCH; tileGround = TILE.ARCH; tileDoor = TILE.ARCH; bay = 3.4; }
    if (key === 'oldstone') { col = hx(0xa89a86); tileUp = tileGround = tileSide = TILE.ROW_WIN; roof = 'gable'; cornice = false; bay = 3.0; }
    if (key === 'mall') { col = hx(0xa1503d); tileUp = TILE.ARCH; }
    if (key === 'harbour') { col = hx(0xe2cda6); tileUp = TILE.OFFICE; tileGround = TILE.SHOP; }
    if (key === 'curvedblock') { col = hx(0xefebe2); tileUp = tileGround = TILE.CURTAIN; cornice = false; }
    if (key === 'hospital') { col = hx(0xe6e1d6); tileUp = TILE.CURTAIN; tileGround = TILE.SHOP_DOOR; cornice = false; }
    if (key === 'library') { col = hx(0x9b4a3b); tileUp = tileGround = TILE.ARCH; }
    if (key === 'mansion') { col = hx(rnd() < 0.5 ? 0xeedfb5 : 0xf0e6cf); tileUp = tileGround = TILE.ROW_SHUT; roof = 'hip'; bay = 3.3; }
    if (key === 'boathouse') { col = hx(pick([0xf1efe6, 0xdfe7da, 0xe8dcc4])); tileUp = TILE.ROW_WIN; tileGround = TILE.BOATDOOR; tileDoor = TILE.BOATDOOR; roof = 'gable'; cornice = false; bay = 4.2; }
    if (key === 'stack') { smokestack(b, cx, cz, yMin, ySide); return; }
    const seedByte = hashStr(b.id) & 255;
    {
      const gH0 = ground || STOREY;
      rec.yMin = yMin; rec.y0 = y0; rec.yTop = yTop; rec.top = yTop + (roof === 'flat' ? PARAPET : 2); rec.wallColour = col;
      for (let f = 0; f < levels; f++) rec.storeys.push(f === 0 ? y0 : y0 + gH0 + (f - 1) * STOREY);
      if (door) {
        door.sill = y0;
        door.colour = door.style === 'shop' ? 0x2b2b2b : DOOR_COLOURS[tileDoor] ?? 0x1d2023;
        // the interior is planned now, before the doorway is cut: a building whose plan fails keeps its solid (and its
        // painted door), and the reasons are kept on the record for the coverage report
        const plan = planInterior(rec);
        if (!plan || plan.errors.length) {
          rec.planErrors = plan ? plan.errors : ['no plan'];
          rec.door = door = null;
          rec.template = null;
        } else rec.plan = plan;
      }
    }
    const plainTile = t === 'civic' || t === 'apartments' || westEnd || t === 'university' ? TILE.SMOOTH : key === 'oldstone' ? TILE.STONE : TILE.PLAIN;
    if (key === 'oldstone') tileSide = TILE.ROW_WIN;
    // ---- walls
    for (const w of walls) {
      const nb = Math.max(1, Math.round(w.len / bay));
      const isFront = w.front;
      const windows = !w.party;
      // plinth from the lowest ground up to the ground floor
      fquad(fac, w, yMin, y0, 0, w.len / 2.2, 0, (y0 - yMin) / 1.6, col, TILE.PLINTH, TILE.PLINTH, 255, seedByte);
      if (t === 'church') {
        fquad(fac, w, y0, yTop, 0, windows ? nb : w.len / 3, 0, windows ? 1 : (yTop - y0) / STOREY, col, windows ? TILE.CHURCH : plainTile, isFront ? TILE.DOOR_RED : TILE.CHURCH, isFront ? Math.floor(nb / 2) : 255, seedByte);
        continue;
      }
      if (!windows) {
        fquad(fac, w, y0, yTop + (roof === 'flat' ? PARAPET : 0), 0, w.len / 3, 0, (yTop - y0) / STOREY, col, plainTile, plainTile, 255, seedByte);
        continue;
      }
      // ground floor
      const doorBay = isFront ? (t === 'terrace' || t === 'house' ? (rnd() < 0.5 ? 0 : nb - 1) : Math.floor(nb / 2)) : 255;
      const gTile = isFront || w.street ? tileGround : t === 'retail' || t === 'commercial' ? tileSide : tileGround === TILE.SHOP ? TILE.ROW_WIN : tileGround;
      const gH = ground || STOREY;
      const wr = rec.walls[walls.indexOf(w)];
      if (door && isFront) doorWall(fac, grd, w, wr, door, nb, bay, y0, gH, col, gTile, plainTile, seedByte);
      else {
        fquad(fac, w, y0, y0 + gH, 0, nb, 0, 1, col, gTile, isFront ? tileDoor : gTile, doorBay, seedByte);
        wr.bands.push({ s0: 0, s1: w.len, y0, y1: y0 + gH, tile: gTile, cols: nb, rows: 1 });
      }
      // upper floors
      if (levels > 1) {
        fquad(fac, w, y0 + gH, yTop, 0, nb, 0, levels - 1, col, tileUp, tileUp, 255, seedByte);
        wr.bands.push({ s0: 0, s1: w.len, y0: y0 + gH, y1: yTop, tile: tileUp, cols: nb, rows: levels - 1 });
      }
      // parapet band
      if (roof === 'flat') fquad(fac, w, yTop, yTop + PARAPET, 0, w.len / 3, 0, PARAPET / STOREY, col, plainTile, plainTile, 255, seedByte);
      // cornice on street walls
      if (cornice && (isFront || w.street) && roof === 'flat') {
        const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
        const cc = t === 'terrace' || t === 'house' || t === 'retail' ? lin(0xf2efe6) : shade(col, 0.82);
        chunks.tag('overhead');
        grd.obox(mx + w.nx * 0.18, yTop + PARAPET - 0.05, mz + w.nz * 0.18, w.len / 2 + 0.08, 0.3, yTop + PARAPET + 0.38, w.ux, w.uz, cc, shade(cc, 0.9), true);
        grd.obox(mx + w.nx * 0.08, yTop - 0.1, mz + w.nz * 0.08, w.len / 2, 0.14, yTop + 0.12, w.ux, w.uz, cc, shade(cc, 0.9), true);
      }
      // near detail: window sills on street walls, stoops at the door
      if (isFront || w.street) {
        const bw = w.len / nb;
        const sillTile = tileUp === TILE.ROW_SHUT || tileUp === TILE.ROW_WIN || tileUp === TILE.UNIV || tileUp === TILE.ARCH;
        if (sillTile) {
          chunks.tag('overhead');
          for (let f = 1; f < levels; f++) {
            const ys = y0 + gH + (f - 1) * STOREY + STOREY * 0.22;
            for (let k = 0; k < nb; k++) {
              const s = (k + 0.5) * bw;
              const px = w.ax + w.ux * s + w.nx * 0.07, pz = w.az + w.uz * s + w.nz * 0.07;
              det.obox(px, ys - 0.1, pz, bw * 0.24, 0.1, ys, w.ux, w.uz, lin(0xe9e4d8), lin(0xcfc9bb), true);
            }
          }
        }
        if (isFront && doorBay !== 255 && stoop > 0.2 && (t === 'terrace' || t === 'house')) {
          const s = door ? door.s : (doorBay + 0.5) * bw;
          const px = w.ax + w.ux * s, pz = w.az + w.uz * s;
          // the flight runs from the door sill down to the pavement in front of THIS door (on a sloping street that
          // differs from the wall's middle, which set the floor height): rise and step count from the ground there
          let gy = ras.heightAt(px + w.nx * 1.8, pz + w.nz * 1.8);
          let rise = y0 - gy;
          let steps = Math.max(2, Math.round(rise / 0.19));
          const outEst = 1.1 + (steps - 1) * 0.3;
          gy = ras.heightAt(px + w.nx * outEst, pz + w.nz * outEst);
          rise = y0 - gy;
          steps = Math.max(2, Math.round(rise / 0.19));
          const stoop = rise; // shadows the building's nominal stoop height below
          const stepH = stoop / steps;
          if (rise >= 0.2 && rise <= 2.4) {
          const sc = lin(0xb8b1a4);
          chunks.tag('stoop');
          det.obox(px + w.nx * 0.55, y0 - 0.25, pz + w.nz * 0.55, 0.75, 0.55, y0, w.ux, w.uz, sc, shade(sc, 0.9));
          for (let k = 1; k < steps; k++) {
            const out = 1.1 + k * 0.3;
            det.obox(px + w.nx * (out - 0.15), y0 - stepH * (k + 1), pz + w.nz * (out - 0.15), 0.7, 0.15, y0 - stepH * k, w.ux, w.uz, shade(sc, 1 - k * 0.03), shade(sc, 0.88));
          }
          // iron rails: a post at each end and a rail following the steps down
          const iron = lin(0x222428);
          const outN = 1.1 + (steps - 1) * 0.3;
          chunks.tag('stoopRail');
          for (const sd of [-1, 1]) {
            const rx = px + w.ux * 0.72 * sd, rz = pz + w.uz * 0.72 * sd;
            det.obox(rx + w.nx * 0.2, y0, rz + w.nz * 0.2, 0.03, 0.03, y0 + 0.95, w.ux, w.uz, iron);
            det.obox(rx + w.nx * outN, y0 - stoop, rz + w.nz * outN, 0.03, 0.03, y0 - stoop + 0.95, w.ux, w.uz, iron);
            const ax = rx + w.nx * 0.2, az = rz + w.nz * 0.2, bx = rx + w.nx * outN, bz = rz + w.nz * outN;
            det.quad(ax - w.ux * 0.03, y0 + 0.95, az - w.uz * 0.03, ax + w.ux * 0.03, y0 + 0.95, az + w.uz * 0.03, bx + w.ux * 0.03, y0 - stoop + 0.95, bz + w.uz * 0.03, bx - w.ux * 0.03, y0 - stoop + 0.95, bz - w.uz * 0.03, iron, 0, 1, 0);
            det.quad(ax, y0 + 0.95, az, bx, y0 - stoop + 0.95, bz, bx, y0 - stoop + 0.89, bz, ax, y0 + 0.89, az, iron, w.ux * sd, 0, w.uz * sd);
          }
          stoopColliders(px, pz, w, y0, stepH, outN, Math.min(gy, yMin) - 0.3);
          stoopBottoms.push(px + w.nx * outN, y0 - stoop, pz + w.nz * outN, 0);
          stoopInfo.push(px, pz, y0, w.nx, w.nz, outN, y0 - stoop, steps);
          }
          // door canopy
          chunks.tag('overhead');
          det.obox(px + w.nx * 0.25, y0 + 2.75, pz + w.nz * 0.25, 0.8, 0.25, y0 + 2.9, w.ux, w.uz, lin(0xf2efe6));
        }
      }
    }
    // ---- roof
    const roofCol = roof === 'flat' ? hx(ROOF_FLAT[hashStr(b.id + 'r') % ROOF_FLAT.length]) : hx(ROOF_PITCH[hashStr(b.id + 'r') % ROOF_PITCH.length]);
    if (roof === 'flat') {
      const yr = yTop + PARAPET - 0.25;
      for (let i = 1; i + 1 < n; i++) froof(fac, P[0], P[i], P[i + 1], yr, roofCol, seedByte);
      // rooftop clutter: chimneys on rowhouses, plant on bigger roofs
      const r2 = rand(hashStr(b.id + 'c'));
      chunks.tag('roof');
      if (t === 'terrace' || t === 'house') {
        const w = walls.find((q) => q.party) ?? walls[1];
        const s = 0.3 + r2() * 0.4;
        const px = lerp(w.ax, w.bx, s) - w.nx * 0.6, pz = lerp(w.az, w.bz, s) - w.nz * 0.6;
        grd.obox(px, yr, pz, 0.45, 0.35, yr + 1.3, w.ux, w.uz, shade(col, 0.85), shade(col, 0.75));
      } else if (footArea(P) > 300) {
        for (let k = 0; k < 2; k++) {
          const px = cx + (r2() - 0.5) * 6, pz = cz + (r2() - 0.5) * 6;
          grd.obox(px, yr, pz, 1.2, 0.9, yr + 1.4, front.ux, front.uz, lin(0x9a9c9e), lin(0x85878a));
        }
      }
    } else {
      chunks.tag('roof');
      pitchedRoof(fac, grd, walls, P, yTop, roof, roofCol, col, plainTile, seedByte, key);
    }
    chunks.tag('roof'); // landmark extras stand on the roofs (arcade and portico tag their own parts)
    // ---- landmark extras
    if (key === 'healy-tower') clockTower(walls, P, cx, cz, yTop, col);
    if (t === 'church' && key !== 'healy') steeple(front, walls, cx, cz, yTop, col, rnd);
    if (key === 'carbarn') {
      const w = front, mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      grd.obox(mx + w.nx * 0.1, yTop + PARAPET, mz + w.nz * 0.1, 7, 0.4, yTop + PARAPET + 3.5, w.ux, w.uz, col, shade(col, 0.9));
      grd.pyramid(mx + w.nx * 0.1, yTop + PARAPET + 3.5, mz + w.nz * 0.1, 0.01, 0.01, w.ux, w.uz, col);
      gableFront(grd, mx + w.nx * 0.3, mz + w.nz * 0.3, w.ux, w.uz, 7.4, yTop + PARAPET + 3.5, 2.6, lin(0xe8e2d4));
    }
    if (key === 'harbour') harbourTiers(walls, P, cx, cz, yTop, col, seedByte);
    if (key === 'curvedblock') balconyBands(walls, y0 + ground, yTop, levels);
    if (key === 'library' || key === 'mansion') cupola(cx, cz, yTop + (roof === 'flat' ? PARAPET : 3), key === 'mansion');
    if (key === 'mansion') portico(front, y0, yTop);
    if (key === 'oldstone') {
      for (const w of walls.filter((q) => q.len < 10)) {
        const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
        grd.obox(mx - w.nx * 0.5, yTop, mz - w.nz * 0.5, 0.6, 0.5, yTop + 4.2, w.ux, w.uz, shade(col, 0.8));
      }
    }
    // ---- shop signs and awnings (invented names; the seed varies them)
    const pois = poisBy.get(b.id) ?? [];
    let k = 0;
    for (const p of pois) {
      if (!SIGN_CATS.test(p.cat)) continue;
      const w = front;
      const tAlong = clamp((p.x - w.ax) * w.ux + (p.z - w.az) * w.uz, 1.6, w.len - 1.6);
      const along = pois.length > 1 ? clamp(tAlong + (k - (pois.length - 1) / 2) * 0.5, 1.6, w.len - 1.6) : w.len > 9 ? clamp(tAlong, 3, w.len - 3) : w.len / 2;
      k++;
      const name = poiName(p.cat, `${p.id}:${seed}`);
      const sw = Math.min(w.len - 0.6, Math.max(3.2, Math.min(6.5, name.length * 0.42)));
      const sx = w.ax + w.ux * along, sz = w.az + w.uz * along;
      const gH = ground || STOREY;
      const ys = y0 + gH - 0.42;
      const slot = signs.slot(name);
      chunks.tag('overhead');
      signBuf.quad(sx + w.nx * 0.07, ys, sz + w.nz * 0.07, w.ux, w.uz, w.nx, w.nz, sw, 0.62, slot, signs);
      grd.obox(sx + w.nx * 0.03, ys - 0.36, sz + w.nz * 0.03, sw / 2 + 0.06, 0.04, ys + 0.36, w.ux, w.uz, lin(0x1f2226));
      if (AWNING_CATS.test(p.cat) && ground >= 4) {
        const ac = hx(AWNINGS[hashStr(name) % AWNINGS.length]);
        const striped = hashStr(name + 's') % 3 === 0;
        awning(grd, sx, sz, w, sw + 0.4, y0 + gH - 0.9, ac, striped);
      }
    }
    // ---- physics: an oriented box when the footprint is (nearly) a rectangle, else a prism of the footprint itself
    // (a box around a skewed quad reaches over the sidewalk: an invisible wall). Nearly = the box adds at most 1.5 %
    // + 2 m2, a sliver of a few cm along the walls; hull colliders cost boot time, so only where it matters.
    const w0 = walls[0];
    let hu = 0, hv = 0;
    for (const p of P) {
      hu = Math.max(hu, Math.abs((p[0] - cx) * w0.ux + (p[1] - cz) * w0.uz));
      hv = Math.max(hv, Math.abs((p[0] - cx) * w0.nx + (p[1] - cz) * w0.nz));
    }
    const top = yTop + (roof === 'flat' ? PARAPET : 2);
    if (door) openCollider(rec, door, P, yMin, y0, top);
    else if (4 * hu * hv <= footArea(P) * 1.015 + 2) phys.box(cx, (yMin + top) / 2, cz, hu, (top - yMin) / 2, hv, w0.ux, w0.uz, 'building');
    else {
      // a prism is a convex hull: over an L- or U-shaped footprint (a third of the real buildings) it filled the notch,
      // an invisible wall across courtyards, driveways and pavements. Concave footprints are cut into convex pieces.
      let made = 0;
      for (const piece of convexPieces(P)) if (phys.prism(piece.flat(), yMin, top, 'building')) made++;
      if (!made) phys.box(cx, (yMin + top) / 2, cz, hu, (top - yMin) / 2, hv, w0.ux, w0.uz, 'building');
    }
  }

  // -------------------------------------------------------------------------------------------- helpers
  /**
   * The front wall of an enterable building, ground floor: a real opening for the door (left, right and above it),
   * the reveal (jambs, head, sill) through the wall's thickness and a door case. Houses: a plain door zone at the
   * door's end of the wall and the window bays beside it; shops: the shopfront tiles across the wall with the door
   * cut out of them. The window bands are recorded for the interior's openings.
   */
  function doorWall(fac: MeshBuf, grd: MeshBuf, w: Wall, wr: WallRec, d: DoorRec, nb: number, bay: number, y0: number, gH: number, col: number, gTile: number, plainTile: number, seedByte: number) {
    const sL = d.s - d.width / 2, sR = d.s + d.width / 2, yH = y0 + d.height, yG = y0 + gH;
    const flip = (w.bz - w.az) * w.nx - (w.bx - w.ax) * w.nz > 0;
    if (d.style === 'house') {
      const z0 = d.atStart ? 0 : Math.max(0, sL - 0.35), z1 = d.atStart ? Math.min(w.len, sR + 0.35) : w.len;
      // the door zone (plain wall round the opening)
      fspan(fac, w, z0, sL, y0, yG, 2.2, 0, 0, 1, col, plainTile, plainTile, 255, seedByte);
      fspan(fac, w, sR, z1, y0, yG, 2.2, 0, 0, 1, col, plainTile, plainTile, 255, seedByte);
      fspan(fac, w, sL, sR, yH, yG, 2.2, 0, (yH - y0) / gH, 1, col, plainTile, plainTile, 255, seedByte);
      // the window bays beside it
      const a = d.atStart ? z1 : 0, b2 = d.atStart ? w.len : z0;
      if (b2 - a > 0.05) {
        const nW = b2 - a < 1.3 ? 0 : Math.max(1, Math.round((b2 - a) / bay));
        const tile = nW ? gTile : plainTile, cols = nW || 1;
        fspan(fac, w, a, b2, y0, yG, (b2 - a) / cols, flip ? b2 : a, 0, 1, col, tile, tile, 255, seedByte);
        if (nW) wr.bands.push({ s0: a, s1: b2, y0, y1: yG, tile: gTile, cols, rows: 1 });
      }
    } else {
      const bw = w.len / nb, ref = flip ? w.len : 0;
      fspan(fac, w, 0, sL, y0, yG, bw, ref, 0, 1, col, gTile, gTile, 255, seedByte);
      fspan(fac, w, sR, w.len, y0, yG, bw, ref, 0, 1, col, gTile, gTile, 255, seedByte);
      fspan(fac, w, sL, sR, yH, yG, bw, ref, (yH - y0) / gH, 1, col, gTile, gTile, 255, seedByte);
      wr.bands.push({ s0: 0, s1: w.len, y0, y1: yG, tile: gTile, cols: nb, rows: 1 });
    }
    // reveal through the wall: jambs, head, sill (painted timber for houses, dark metal for shops)
    const D = IN.outerWall;
    const rc = d.style === 'house' ? lin(0xf2efe6) : lin(0x2f3236);
    const ix = -w.nx, iz = -w.nz;
    const Pw = (s: number, v: number): [number, number] => [w.ax + w.ux * s + ix * v, w.az + w.uz * s + iz * v];
    chunks.tag('decor');
    const [l0x, l0z] = Pw(sL, 0), [l1x, l1z] = Pw(sL, D), [r0x, r0z] = Pw(sR, 0), [r1x, r1z] = Pw(sR, D);
    grd.quad(l0x, y0, l0z, l1x, y0, l1z, l1x, yH, l1z, l0x, yH, l0z, rc, w.ux, 0, w.uz);
    grd.quad(r0x, y0, r0z, r1x, y0, r1z, r1x, yH, r1z, r0x, yH, r0z, rc, -w.ux, 0, -w.uz);
    grd.quad(l0x, yH, l0z, r0x, yH, r0z, r1x, yH, r1z, l1x, yH, l1z, rc, 0, -1, 0);
    const sill = lin(0xb8b1a4);
    grd.quad(l0x, y0 + 0.004, l0z, r0x, y0 + 0.004, r0z, r1x, y0 + 0.004, r1z, l1x, y0 + 0.004, l1z, sill, 0, 1, 0);
    // door case proud of the wall (architrave and head)
    const cw = d.style === 'house' ? 0.14 : 0.07, out = 0.04;
    const [cmx, cmz] = Pw(d.s, -out / 2);
    grd.obox(cmx - w.ux * (d.width / 2 + cw / 2), y0, cmz - w.uz * (d.width / 2 + cw / 2), cw / 2, out / 2, yH + cw, w.ux, w.uz, rc);
    grd.obox(cmx + w.ux * (d.width / 2 + cw / 2), y0, cmz + w.uz * (d.width / 2 + cw / 2), cw / 2, out / 2, yH + cw, w.ux, w.uz, rc);
    grd.obox(cmx, yH, cmz, d.width / 2 + cw, out / 2 + (d.style === 'house' ? 0.03 : 0), yH + cw + (d.style === 'house' ? 0.06 : 0), w.ux, w.uz, rc);
    chunks.tag('untagged');
  }
  /** A facade quad over part of a wall: s from s0 to s1 (from the wall's a end), tile u = (s - sRef) / bw read from the
   * left as seen from outside, v from v0 at y0 to v1 at y1. */
  function fspan(buf: MeshBuf, w: Wall, s0: number, s1: number, y0: number, y1: number, bw: number, sRef: number, v0: number, v1: number, col: number, tileA: number, tileB: number, alt: number, seedByte: number) {
    if (y1 - y0 < 0.02 || s1 - s0 < 0.01) return;
    const flip = (w.bz - w.az) * w.nx - (w.bx - w.ax) * w.nz > 0;
    const sl = flip ? s1 : s0, sr = flip ? s0 : s1;
    const lx = w.ax + w.ux * sl, lz = w.az + w.uz * sl, rx = w.ax + w.ux * sr, rz = w.az + w.uz * sr;
    if (buf.rec) { const k = buf.rec.kind; buf.rec.tag('building'); buf.rec.wall(lx, lz, rx, rz, y0, y1, y0, y1, w.nx, w.nz); buf.rec.kind = k; }
    buf.exA = tileA; buf.exB = tileB; buf.exC = alt; buf.exD = seedByte;
    const tl = (flip ? sRef - sl : sl - sRef) / bw, tr = (flip ? sRef - sr : sr - sRef) / bw;
    const nx = w.nx, nz = w.nz;
    buf.vert(lx, y0, lz, nx, 0, nz, col, tl, v0); buf.vert(rx, y0, rz, nx, 0, nz, col, tr, v0); buf.vert(rx, y1, rz, nx, 0, nz, col, tr, v1);
    buf.vert(lx, y0, lz, nx, 0, nz, col, tl, v0); buf.vert(rx, y1, rz, nx, 0, nz, col, tr, v1); buf.vert(lx, y1, lz, nx, 0, nz, col, tl, v1);
  }
  /**
   * Collision of an enterable building: a permanent plinth up to the ground floor (it is the ground floor's floor),
   * and above it the core, the footprint's convex pieces with the doorway notched out in front of the closed leaf,
   * plus a box where the closed leaf is. The interior system disables the core (record.core) once the interior's
   * walls, floors and door exist, and enables it again before taking the interior down.
   */
  function openCollider(rec: BuildingRecord, d: DoorRec, P: Pt[], yMin: number, y0: number, top: number) {
    const pieces = convexPieces(P);
    for (const piece of pieces) phys.prism(piece.flat(), yMin, y0, 'building');
    const ux = d.ux, uz = d.uz, ix = -d.nx, iz = -d.nz;
    const cu = d.x * ux + d.z * uz, cv = d.x * ix + d.z * iz;
    const uL = cu - d.width / 2, uR = cu + d.width / 2, vLeaf = cv + IN.leafRecess;
    const add = (Q: P2[], ya: number, yb: number) => {
      if (Q.length < 3 || footArea(Q as Pt[]) < 0.01) return;
      const c = phys.prism(Q.flat(), ya, yb, 'building');
      if (c) rec.core.push(c);
    };
    for (const piece of pieces) {
      const back = clipHalf(piece as P2[], ix, iz, vLeaf);
      const front = clipHalf(piece as P2[], -ix, -iz, -vLeaf);
      add(back, y0, top);
      if (front.length < 3) continue;
      add(clipHalf(front, -ux, -uz, -uL), y0, top);
      add(clipHalf(front, ux, uz, uR), y0, top);
      add(clipHalf(clipHalf(front, ux, uz, uL), -ux, -uz, -uR), y0 + d.height, top);
    }
    const t = IN.leafThickness, o = IN.leafRecess + t / 2;
    rec.plug = phys.box(d.x + ix * o, y0 + d.height / 2, d.z + iz * o, d.width / 2, d.height / 2, t / 2, ux, uz, 'door');
    rec.core.push(rec.plug);
  }
  /**
   * A stoop's colliders: one convex ramp under the steps (flat on the landing, then down through the middle of each
   * tread, so feet sink or float at most half a riser; a half-riser lip at the foot that autostep takes), and a thin
   * slab under each iron rail. (px, pz): the door on the wall line; outN: how far the last step reaches out.
   */
  function stoopColliders(px: number, pz: number, w: Wall, y0: number, stepH: number, outN: number, bottom: number) {
    const HW = 0.75; // half width of the landing
    const flat = 0.95; // m out from the wall where the ramp starts down (the first tread's middle line - one tread)
    const yFoot = y0 - stepH * ((outN - flat) / 0.3);
    const prof: [number, number][] = [[-0.05, y0], [flat, y0], [outN, yFoot], [outN, bottom], [-0.05, bottom]];
    const pts: number[] = [];
    for (const sd of [-1, 1]) for (const [o, y] of prof) pts.push(px + w.nx * o + w.ux * HW * sd, y, pz + w.nz * o + w.uz * HW * sd);
    phys.hull(pts, 'stoop');
    // rails: from the post by the door (0.2 m out, rail 0.95 m above the landing) to the post at the foot
    const yB = y0 - stepH * Math.round((outN - 1.1) / 0.3 + 1); // the pavement at the foot
    for (const sd of [-1, 1]) {
      const r: number[] = [];
      const o0 = 0.17, o1 = outN + 0.03; // post to post, posts included
      for (const t of [-0.03, 0.03]) {
        const ox = w.ux * (0.72 * sd + t), oz = w.uz * (0.72 * sd + t);
        r.push(px + w.nx * o0 + ox, y0 + 0.95, pz + w.nz * o0 + oz, px + w.nx * o1 + ox, yB + 0.95, pz + w.nz * o1 + oz);
        r.push(px + w.nx * o1 + ox, yB - 0.1, pz + w.nz * o1 + oz, px + w.nx * o0 + ox, y0 - 0.2, pz + w.nz * o0 + oz);
      }
      phys.hull(r, 'stoopRail');
    }
  }
  function fquad(buf: MeshBuf, w: Wall, y0: number, y1: number, u0: number, u1: number, v0: number, v1: number, col: number, tileA: number, tileB: number, alt: number, seedByte: number) {
    if (y1 - y0 < 0.02) return;
    if (buf.rec) { const k = buf.rec.kind; buf.rec.tag('building'); buf.rec.wall(w.ax, w.az, w.bx, w.bz, y0, y1, y0, y1, w.nx, w.nz); buf.rec.kind = k; }
    buf.exA = tileA; buf.exB = tileB; buf.exC = alt; buf.exD = seedByte;
    const nx = w.nx, nz = w.nz;
    // (b-a) x up = (-dz, 0, dx); start from the end that makes it face outward, so u also runs left to right as seen
    // from outside (doors and signs read the right way round)
    let ax = w.ax, az = w.az, bx = w.bx, bz = w.bz;
    if ((bz - az) * nx - (bx - ax) * nz > 0) { ax = w.bx; az = w.bz; bx = w.ax; bz = w.az; }
    buf.vert(ax, y0, az, nx, 0, nz, col, u0, v0); buf.vert(bx, y0, bz, nx, 0, nz, col, u1, v0); buf.vert(bx, y1, bz, nx, 0, nz, col, u1, v1);
    buf.vert(ax, y0, az, nx, 0, nz, col, u0, v0); buf.vert(bx, y1, bz, nx, 0, nz, col, u1, v1); buf.vert(ax, y1, az, nx, 0, nz, col, u0, v1);
  }
  function froof(buf: MeshBuf, a: Pt, b2: Pt, c: Pt, y: number, col: number, seedByte: number) {
    buf.exA = TILE.ROOF_FLAT; buf.exB = TILE.ROOF_FLAT; buf.exC = 255; buf.exD = seedByte;
    const up = (b2[1] - a[1]) * (c[0] - a[0]) - (b2[0] - a[0]) * (c[1] - a[1]) > 0;
    const V = up ? [a, b2, c] : [a, c, b2];
    for (const p of V) buf.vert(p[0], y, p[1], 0, 1, 0, col, p[0] / 4, p[1] / 4);
  }
  function tri3(buf: MeshBuf, a: number[], b2: number[], c: number[], col: number, tile: number, seedByte: number, hint: number[]) {
    // textured triangle with planar uv (gable ends, roof slopes)
    buf.exA = tile; buf.exB = tile; buf.exC = 255; buf.exD = seedByte;
    const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz2) || 1;
    nx /= L; ny /= L; nz2 /= L;
    let V = [a, b2, c];
    if (nx * hint[0] + ny * hint[1] + nz2 * hint[2] < 0) { V = [a, c, b2]; nx = -nx; ny = -ny; nz2 = -nz2; }
    // uv: horizontal along the face, vertical = y
    const hxv = Math.abs(ny) > 0.95 ? [1, 0] : [-nz2, nx];
    const hl = Math.hypot(hxv[0], hxv[1]) || 1;
    for (const p of V) buf.vert(p[0], p[1], p[2], nx, ny, nz2, col, (p[0] * hxv[0] + p[2] * hxv[1]) / hl / 3, p[1] / 2.6);
  }
  function pitchedRoof(fac: MeshBuf, grd: MeshBuf, walls: Wall[], P: Pt[], yTop: number, kind: string, roofCol: number, col: number, plainTile: number, seedByte: number, key: string) {
    if (P.length !== 4) {
      for (let i = 1; i + 1 < P.length; i++) froof(fac, P[0], P[i], P[i + 1], yTop, roofCol, seedByte);
      return;
    }
    // long axis
    const e0 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), e1 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
    const Q = e0 >= e1 ? P : [P[1], P[2], P[3], P[0]];
    const long = Math.max(e0, e1), short = Math.min(e0, e1);
    const pitch = kind === 'steep' ? 0.85 : kind === 'gable' ? 0.42 : 0.4;
    const ridgeH = Math.min(short * pitch, key === 'healy' ? 14 : 12);
    const mA: Pt = [(Q[0][0] + Q[3][0]) / 2, (Q[0][1] + Q[3][1]) / 2], mB: Pt = [(Q[1][0] + Q[2][0]) / 2, (Q[1][1] + Q[2][1]) / 2];
    const ux = (mB[0] - mA[0]) / long, uz = (mB[1] - mA[1]) / long;
    const inset = kind === 'hip' ? Math.min(short / 2, long / 2 - 0.5) : 0;
    const rA = [mA[0] + ux * inset, yTop + ridgeH, mA[1] + uz * inset], rB = [mB[0] - ux * inset, yTop + ridgeH, mB[1] - uz * inset];
    const c = Q.map((p) => [p[0], yTop, p[1]]);
    const ov = 0.35; // eaves overhang
    const cx = (P[0][0] + P[2][0]) / 2, cz = (P[0][1] + P[2][1]) / 2;
    const out = (p: number[]) => { const dx = p[0] - cx, dz = p[2] - cz; const L = Math.hypot(dx, dz) || 1; return [p[0] + (dx / L) * ov, p[1] - ov * pitch, p[2] + (dz / L) * ov]; };
    const C = c.map(out);
    // slopes (long sides): Q0-Q1 and Q2-Q3
    const slope = (a: number[], b2: number[], ra: number[], rb: number[]) => {
      const hint = [(a[0] + b2[0]) / 2 - cx, 1, (a[2] + b2[2]) / 2 - cz];
      tri3(fac, a, b2, rb, roofCol, TILE.ROOF_SLATE, seedByte, hint);
      tri3(fac, a, rb, ra, roofCol, TILE.ROOF_SLATE, seedByte, hint);
    };
    slope(C[0], C[1], rA, rB);
    slope(C[2], C[3], rB, rA);
    if (kind === 'hip') {
      tri3(fac, C[1], C[2], rB, roofCol, TILE.ROOF_SLATE, seedByte, [ux, 1, uz]);
      tri3(fac, C[3], C[0], rA, roofCol, TILE.ROOF_SLATE, seedByte, [-ux, 1, -uz]);
    } else {
      // gable ends (wall texture), then a small roof lip
      tri3(fac, c[1], c[2], rB, col, plainTile, seedByte, [ux, 0, uz]);
      tri3(fac, c[3], c[0], rA, col, plainTile, seedByte, [-ux, 0, -uz]);
      tri3(fac, C[1], C[2], rB, roofCol, TILE.ROOF_SLATE, seedByte, [ux, 0.2, uz]);
      tri3(fac, C[3], C[0], rA, roofCol, TILE.ROOF_SLATE, seedByte, [-ux, 0.2, -uz]);
    }
    // underside of the eaves
    for (let i = 0; i < 4; i++) {
      const a = C[i], b2 = C[(i + 1) % 4], a2 = c[i], b3 = c[(i + 1) % 4];
      grd.quad(a[0], a[1], a[2], b2[0], b2[1], b2[2], b3[0], b3[1], b3[2], a2[0], a2[1], a2[2], shade(roofCol, 0.7), 0, -1, 0);
    }
    void walls;
  }
  function steeple(front: Wall, walls: Wall[], cx: number, cz: number, yTop: number, col: number, rnd: () => number) {
    // tower at the front end of the long axis
    let ax = front.nx, az = front.nz;
    const long = walls.reduce((m, w) => (w.len > m.len ? w : m), walls[0]);
    if (Math.abs(long.ux * ax + long.uz * az) < 0.5) { ax = long.ux; az = long.uz; if ((front.ax + front.bx) / 2 - cx < 0 === ax > 0 && Math.abs(ax) > 0.3) { ax = -ax; az = -az; } }
    const half = Math.max(...walls.map((w) => Math.abs(((w.ax + w.bx) / 2 - cx) * ax + ((w.az + w.bz) / 2 - cz) * az)));
    const ts = Math.min(3.4, front.len * 0.22 + 1.5);
    // the tower stands on the church's own footprint (it may project a little from the front wall) and off the road:
    // on an irregular (real) outline the end of the long axis could lie outside it, and a tower stood in Q St. Step
    // back toward the middle until it fits.
    const foot: Pt[] = walls.map((w) => [w.ax, w.az]);
    const ux = -az, uz = ax;
    const cornersAt = (x: number, z: number): Pt[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [x + ux * a * ts + ax * b2 * ts, z + uz * a * ts + az * b2 * ts]);
    let along = half - ts * 0.6;
    const fits = (d: number) => pointInPoly(cx + ax * d, cz + az * d, foot) && cornersAt(cx + ax * d, cz + az * d).every((p) => !(ras.kindAt(p[0], p[1]) & K.ROAD));
    while (along > 0 && !fits(along)) along -= 0.5;
    const towerTop = yTop + 7 + rnd() * 5; // (drawn before the fit test result is used: the building's random stream stays the same)
    if (!fits(Math.max(0, along))) return;
    const tx = cx + ax * Math.max(0, along), tz = cz + az * Math.max(0, along);
    const fac = chunks.buf('facade', tx, tz);
    const grd = chunks.buf('ground', tx, tz);
    const sb = hashStr(String(tx)) & 255;
    const yBase = ras.heightAt(tx, tz) - 0.5;
    const corners: Pt[] = cornersAt(tx, tz);
    for (let i = 0; i < 4; i++) {
      const p = corners[i], q = corners[(i + 1) % 4];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const wux = (q[0] - p[0]) / L, wuz = (q[1] - p[1]) / L;
      let nx = -wuz, nz = wux;
      if (((p[0] + q[0]) / 2 - tx) * nx + ((p[1] + q[1]) / 2 - tz) * nz < 0) { nx = -nx; nz = -nz; }
      const w: Wall = { ax: p[0], az: p[1], bx: q[0], bz: q[1], len: L, ux: wux, uz: wuz, nx, nz, party: false, street: true, front: false };
      fquad(fac, w, yBase, towerTop - 3.6, 0, L / 3, 0, (towerTop - 3.6 - yBase) / STOREY, col, TILE.PLAIN, TILE.PLAIN, 255, sb);
      fquad(fac, w, towerTop - 3.6, towerTop, 0, 1, 0, 1, col, TILE.BELFRY, TILE.BELFRY, 255, sb);
    }
    grd.obox(tx, towerTop, tz, ts + 0.25, ts + 0.25, towerTop + 0.5, ax, az, shade(col, 0.8));
    grd.pyramid(tx, towerTop + 0.5, tz, ts + 0.1, 9 + rnd() * 7, ax, az, lin(rnd() < 0.5 ? 0x4a5560 : 0x5f8f7c));
    phys.box(tx, (yBase + towerTop) / 2, tz, ts, (towerTop - yBase) / 2, ts, ax, az, 'tower');
  }
  function clockTower(walls: Wall[], P: Pt[], cx: number, cz: number, yTop: number, col: number) {
    const grd = chunks.buf('ground', cx, cz);
    const w0 = walls[0];
    const hs = Math.min(...walls.map((w) => w.len)) / 2;
    // clock stage
    const y1 = yTop + 4.5;
    grd.obox(cx, yTop, cz, hs + 0.3, hs + 0.3, yTop + 0.5, w0.ux, w0.uz, shade(col, 0.85));
    grd.obox(cx, yTop + 0.5, cz, hs, hs, y1, w0.ux, w0.uz, col, shade(col, 0.92));
    for (const w of walls) {
      const mx = (w.ax + w.bx) / 2 - cx, mz = (w.az + w.bz) / 2 - cz;
      const L = Math.hypot(mx, mz) || 1;
      const fx = cx + (mx / L) * (hs + 0.06), fz = cz + (mz / L) * (hs + 0.06), fy = yTop + 2.6;
      const nx = mx / L, nz = mz / L;
      // white dial (12-gon) + two hands
      const r = Math.min(1.5, hs * 0.75);
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
        const tx = -nz, tz = nx;
        grd.tri(fx, fy, fz, fx + tx * Math.cos(a0) * r, fy + Math.sin(a0) * r, fz + tz * Math.cos(a0) * r, fx + tx * Math.cos(a1) * r, fy + Math.sin(a1) * r, fz + tz * Math.cos(a1) * r, lin(0xf4f1e6), nx, 0, nz);
      }
      const hx2 = fx + nx * 0.03, hz2 = fz + nz * 0.03;
      grd.quad(hx2 - nz * 0.06, fy, hz2 + nx * 0.06, hx2 + nz * 0.06, fy, hz2 - nx * 0.06, hx2 + nz * 0.06, fy + r * 0.8, hz2 - nx * 0.06, hx2 - nz * 0.06, fy + r * 0.8, hz2 + nx * 0.06, lin(0x1a1a1a), nx, 0, nz);
      grd.quad(hx2, fy - 0.05, hz2, hx2, fy + 0.05, hz2, hx2 - nz * r * 0.55, fy + 0.05 + r * 0.25, hz2 + nx * r * 0.55, hx2 - nz * r * 0.55, fy - 0.05 + r * 0.25, hz2 + nx * r * 0.55, lin(0x1a1a1a), nx, 0, nz);
    }
    // belfry, spire and four pinnacles
    grd.obox(cx, y1, cz, hs * 0.85, hs * 0.85, y1 + 3.5, w0.ux, w0.uz, shade(col, 0.95));
    grd.pyramid(cx, y1 + 3.5, cz, hs * 0.9, 17, w0.ux, w0.uz, lin(0x56636a));
    for (const [a, b2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = cx + w0.ux * a * hs + w0.nx * b2 * hs, pz = cz + w0.uz * a * hs + w0.nz * b2 * hs;
      grd.pyramid(px, y1 + 0.5, pz, 0.45, 5, w0.ux, w0.uz, lin(0x6c7275));
    }
    void P;
  }
  function smokestack(b: GeoBuilding, cx: number, cz: number, yMin: number, ySide: number) {
    const grd = chunks.buf('ground', cx, cz);
    const r0 = 2.3, r1 = 1.5, h = Math.max(36, b.h);
    chunks.tag('tower');
    grd.cyl(cx, yMin, cz, r0 + 0.4, r0 + 0.4, ySide - yMin + 1.5, 14, lin(0x8c7f70));
    grd.cyl(cx, ySide + 1.5, cz, r0, r1, h - 3, 14, lin(0x9b5a45));
    grd.cyl(cx, ySide + h - 3.5, cz, r1 + 0.25, r1 + 0.25, 1.2, 14, lin(0x7d4636));
    grd.cyl(cx, ySide + 6, cz, r0 - 0.05, r0 - 0.12, 0.8, 14, lin(0x7d4636), false);
    phys.cylinder(cx, yMin, cz, r0 + 0.4, ySide + 1.5 - yMin, 'tower');
    const ring: number[] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      ring.push(cx + c * r0, ySide + 1.5, cz + sn * r0, cx + c * r1, ySide + h - 1.5, cz + sn * r1);
    }
    phys.hull(ring, 'tower');
  }
  function gableFront(grd: MeshBuf, x: number, z: number, ux: number, uz: number, hw: number, y: number, h: number, c: number) {
    grd.tri(x - ux * hw, y, z - uz * hw, x + ux * hw, y, z + uz * hw, x, y + h, z, c, -uz, 0, ux);
    grd.tri(x - ux * hw, y, z - uz * hw, x + ux * hw, y, z + uz * hw, x, y + h, z, c, uz, 0, -ux);
  }
  function harbourTiers(walls: Wall[], P: Pt[], cx: number, cz: number, yTop: number, col: number, seedByte: number) {
    // a setback upper block and a corner tower with a copper pyramid roof
    const fac = chunks.buf('facade', cx, cz);
    const grd = chunks.buf('ground', cx, cz);
    const w0 = walls[0];
    let hu = 0, hv = 0;
    for (const p of P) { hu = Math.max(hu, Math.abs((p[0] - cx) * w0.ux + (p[1] - cz) * w0.uz)); hv = Math.max(hv, Math.abs((p[0] - cx) * w0.nx + (p[1] - cz) * w0.nz)); }
    const top2 = yTop + PARAPET + 2 * STOREY;
    const iu = hu * 0.62, iv = hv * 0.55;
    const box = (u: number, v: number, hu2: number, hv2: number, y0: number, y1: number, tile: number) => {
      const bx = cx + w0.ux * u + w0.nx * v, bz = cz + w0.uz * u + w0.nz * v;
      const C: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [bx + w0.ux * a * hu2 + w0.nx * b2 * hv2, bz + w0.uz * a * hu2 + w0.nz * b2 * hv2]);
      for (let i = 0; i < 4; i++) {
        const p = C[i], q = C[(i + 1) % 4];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
        let nx = -uz, nz = ux;
        if (((p[0] + q[0]) / 2 - bx) * nx + ((p[1] + q[1]) / 2 - bz) * nz < 0) { nx = -nx; nz = -nz; }
        fquad(fac, { ax: p[0], az: p[1], bx: q[0], bz: q[1], len: L, ux, uz, nx, nz, party: false, street: true, front: false }, y0, y1, 0, Math.max(1, Math.round(L / 3)), 0, (y1 - y0) / STOREY, col, tile, tile, 255, seedByte);
      }
      froof(fac, C[0], C[1], C[2], y1, lin(0x8a857c), seedByte);
      froof(fac, C[0], C[2], C[3], y1, lin(0x8a857c), seedByte);
      phys.box(bx, (y0 + y1) / 2, bz, hu2, (y1 - y0) / 2, hv2, w0.ux, w0.uz, 'building'); // the setback tier on the roof
      return [bx, bz] as Pt;
    };
    box(0, -hv * 0.2, iu, iv, yTop + PARAPET - 0.2, top2, TILE.OFFICE);
    const [tx, tz] = box(hu - 5, hv - 5, 4.5, 4.5, yTop + PARAPET - 0.2, top2 + 2 * STOREY, TILE.ARCH);
    grd.pyramid(tx, top2 + 2 * STOREY, tz, 4.9, 6.5, w0.ux, w0.uz, lin(0x5f9c86));
    // arcade columns along the river side
    const rv = walls.reduce((m, w) => (w.nz > m.nz ? w : m), walls[0]);
    chunks.tag('column');
    for (let s = 2; s < rv.len - 1; s += 4) {
      const px = rv.ax + rv.ux * s + rv.nx * 1.6, pz = rv.az + rv.uz * s + rv.nz * 1.6;
      const y = ras.heightAt(px, pz);
      chunks.buf('ground', px, pz).cyl(px, y, pz, 0.32, 0.3, 4.2, 8, lin(0xe9e1d0));
      phys.cylinder(px, y - 0.3, pz, 0.32, 4.5, 'column');
    }
    const rmx = (rv.ax + rv.bx) / 2, rmz = (rv.az + rv.bz) / 2;
    const ry = ras.heightAt(rmx + rv.nx * 1.6, rmz + rv.nz * 1.6) + 4.2;
    chunks.tag('overhead');
    grd.obox(rmx + rv.nx * 1.0, ry, rmz + rv.nz * 1.0, rv.len / 2, 1.1, ry + 0.45, rv.ux, rv.uz, lin(0xe9e1d0), shade(lin(0xe9e1d0), 0.9), true);
  }
  function balconyBands(walls: Wall[], y0: number, yTop: number, levels: number) {
    // continuous balcony slabs on every floor, toothed on the long sides: the distinctive banded block
    chunks.tag('overhead');
    for (const w of walls) {
      const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      const grd = chunks.buf('ground', mx, mz);
      for (let f = 1; f < levels; f++) {
        const y = y0 + (f - 1) * STOREY;
        if (y > yTop) break;
        const teeth = w.len > 30 ? Math.round(w.len / 4) : 1;
        for (let k = 0; k < teeth; k++) {
          const s0 = (k / teeth) * w.len, s1 = ((k + 1) / teeth) * w.len;
          const depth = teeth > 1 ? (k % 2 ? 1.6 : 1.0) : 1.2;
          const px = w.ax + w.ux * (s0 + s1) / 2 + w.nx * depth / 2, pz = w.az + w.uz * (s0 + s1) / 2 + w.nz * depth / 2;
          grd.obox(px, y - 0.12, pz, (s1 - s0) / 2 + 0.02, depth / 2, y + 0.22, w.ux, w.uz, lin(0xf3f0e8), lin(0xe2ded4), true);
        }
      }
    }
  }
  function cupola(cx: number, cz: number, y: number, dome: boolean) {
    const grd = chunks.buf('ground', cx, cz);
    grd.cyl(cx, y, cz, 1.8, 1.8, 0.4, 8, lin(0xf2efe6));
    grd.cyl(cx, y + 0.4, cz, 1.4, 1.4, 2.4, 8, lin(0xf2efe6));
    if (dome) grd.cyl(cx, y + 2.8, cz, 1.6, 0.2, 1.8, 8, lin(0x6f8f86));
    else grd.cyl(cx, y + 2.8, cz, 1.6, 0, 2.6, 8, lin(0x6f8f86));
  }
  function portico(w: Wall, y0: number, yTop: number) {
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    const grd = chunks.buf('ground', mx, mz);
    const h = Math.min(yTop - y0, 7.5);
    chunks.tag('column');
    for (const s of [-3.6, -1.2, 1.2, 3.6]) {
      const px = mx + w.ux * s + w.nx * 2.4, pz = mz + w.uz * s + w.nz * 2.4;
      grd.cyl(px, y0, pz, 0.33, 0.28, h, 10, lin(0xf4f1ea));
      phys.cylinder(px, y0 - 0.05, pz, 0.33, h + 0.05, 'column');
    }
    chunks.tag('stoop'); // the portico's platform
    grd.obox(mx + w.nx * 1.4, y0 - 0.3, mz + w.nz * 1.4, 4.6, 1.5, y0, w.ux, w.uz, lin(0xd8d2c6));
    phys.box(mx + w.nx * 1.4, y0 - 0.15, mz + w.nz * 1.4, 4.6, 0.15, 1.5, w.ux, w.uz, 'stoop');
    chunks.tag('overhead');
    grd.obox(mx + w.nx * 1.3, y0 + h, mz + w.nz * 1.3, 4.6, 1.5, y0 + h + 0.7, w.ux, w.uz, lin(0xf4f1ea));
    gableFront(grd, mx + w.nx * 2.75, mz + w.nz * 2.75, w.ux, w.uz, 4.6, y0 + h + 0.7, 1.8, lin(0xf4f1ea));
  }
  function awning(grd: MeshBuf, sx: number, sz: number, w: Wall, width: number, y: number, col: number, striped: boolean) {
    const depth = 1.5, drop = 0.7;
    const strips = striped ? Math.max(2, Math.round(width / 0.55)) : 1;
    for (let i = 0; i < strips; i++) {
      const a = -width / 2 + (width * i) / strips, b2 = -width / 2 + (width * (i + 1)) / strips;
      const c = striped && i % 2 ? lin(0xf2efe6) : col;
      const p0x = sx + w.ux * a + w.nx * 0.05, p0z = sz + w.uz * a + w.nz * 0.05;
      const p1x = sx + w.ux * b2 + w.nx * 0.05, p1z = sz + w.uz * b2 + w.nz * 0.05;
      grd.quad(p0x, y, p0z, p1x, y, p1z, p1x + w.nx * depth, y - drop, p1z + w.nz * depth, p0x + w.nx * depth, y - drop, p0z + w.nz * depth, c, w.nx, 1, w.nz);
      grd.quad(p0x, y - 0.02, p0z, p1x, y - 0.02, p1z, p1x + w.nx * depth, y - drop - 0.02, p1z + w.nz * depth, p0x + w.nx * depth, y - drop - 0.02, p0z + w.nz * depth, shade(c, 0.6), -w.nx, -1, -w.nz);
      // valance
      grd.wall(p0x + w.nx * depth, p0z + w.nz * depth, p1x + w.nx * depth, p1z + w.nz * depth, y - drop - 0.28, y - drop, y - drop - 0.28, y - drop, c, w.nx, w.nz);
    }
    for (const s of [-1, 1]) {
      const ex = sx + w.ux * (width / 2) * s, ez = sz + w.uz * (width / 2) * s;
      grd.tri(ex, y, ez, ex + w.nx * depth, y - drop, ez + w.nz * depth, ex + w.nx * depth, y - drop - 0.28, ez + w.nz * depth, col, w.ux * s, 0, w.uz * s);
    }
  }

  // ---- the sign mesh (one draw call, invented names only)
  const signMesh = signBuf.mesh(signs);
  if (signMesh) { root.add(signMesh); extraTris += signBuf.count * 2; }
  return {
    extraTris,
    records,
    stoops: Float32Array.from(stoopBottoms),
    stoopInfo: Float32Array.from(stoopInfo),
    update(_cam: THREE.Vector3, _detail: number) { /* chunk LOD is handled by the world */ },
  };
}

// ======================================================================================================
/**
 * A footprint as convex pieces: itself when convex (within a few cm), else its triangulation with neighbouring
 * triangles merged while the union stays convex (Hertel-Mehlhorn). A footprint the triangulation cannot cover (self-
 * intersecting data) stays whole (its hull, as before).
 */
export function convexPieces(P: Pt[]): Pt[][] {
  const n = P.length;
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area2 = (idx: number[]) => { let a = 0; for (let i = 0; i < idx.length; i++) { const p = P[idx[i]], q = P[idx[(i + 1) % idx.length]]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
  const all = Array.from({ length: n }, (_, i) => i);
  const sgn = Math.sign(area2(all)) || 1;
  // convex enough: no vertex more than TUNING.geo.footprintNotchTol inside the line past it (a bay window or a shallow jog is
  // filled, as the hull did; a courtyard, a driveway notch or an L's inner corner is not)
  const convex = (idx: number[]) => {
    for (let i = 0; i < idx.length; i++) {
      const a = P[idx[(i + idx.length - 1) % idx.length]], b = P[idx[i]], c = P[idx[(i + 1) % idx.length]];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if ((cross(a, b, c) * sgn) / L < -TUNING.geo.footprintNotchTol) return false;
    }
    return true;
  };
  if (convex(all)) return [P];
  if (n > 400) return [P];
  const tris = THREE.ShapeUtils.triangulateShape(P.map((p) => new THREE.Vector2(p[0], p[1])), []);
  let polys = tris.map((t) => (Math.sign(area2(t)) === sgn ? [...t] : [t[0], t[2], t[1]]));
  const total = polys.reduce((s, q) => s + Math.abs(area2(q)), 0);
  if (!polys.length || Math.abs(total - Math.abs(area2(all))) > Math.abs(area2(all)) * 0.02 + 1) return [P];
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < polys.length && !merged; i++) {
      const A = polys[i];
      for (let j = i + 1; j < polys.length && !merged; j++) {
        const B2 = polys[j];
        for (let k = 0; k < A.length && !merged; k++) {
          const a = A[k], b = A[(k + 1) % A.length];
          const m = B2.findIndex((v, q) => v === b && B2[(q + 1) % B2.length] === a);
          if (m < 0) continue;
          // A from b round to a, then B from a round to b (shared edge dropped)
          const ra: number[] = [], rb: number[] = [];
          for (let q = 0; q < A.length; q++) ra.push(A[(k + 1 + q) % A.length]);
          for (let q = 0; q < B2.length; q++) rb.push(B2[(m + 1 + q) % B2.length]);
          const U = [...ra, ...rb.slice(1, -1)];
          if (convex(U)) { polys[i] = U; polys.splice(j, 1); merged = true; }
        }
      }
    }
  }
  return polys.map((q) => q.map((v) => P[v]));
}
function footArea(P: Pt[]) {
  let a = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] - P[i][0]) * (P[j][1] + P[i][1]);
  return Math.abs(a / 2);
}
function weighted(list: readonly (readonly [number, number])[], r: number): number {
  const tot = list.reduce((s, q) => s + q[1], 0);
  let x = r * tot;
  for (const [c, w] of list) { if ((x -= w) <= 0) return c; }
  return list[0][0];
}

/** Canvas atlas of shop names: 256 x 40 px per name, 8 columns. */
class SignAtlas {
  names = new Map<string, number>();
  list: string[] = [];
  slot(name: string) {
    let s = this.names.get(name);
    if (s === undefined) { s = this.list.length; this.list.push(name); this.names.set(name, s); }
    return s;
  }
  cols = 8;
  w = 256;
  h = 40;
  uv(slot: number) {
    const rows = Math.max(1, Math.ceil(this.list.length / this.cols));
    const H = THREE.MathUtils.ceilPowerOfTwo(rows * this.h);
    const c = slot % this.cols, r = Math.floor(slot / this.cols);
    return [c / this.cols, 1 - ((r + 1) * this.h) / H, (c + 1) / this.cols, 1 - (r * this.h) / H];
  }
  texture(): THREE.CanvasTexture {
    const rows = Math.max(1, Math.ceil(this.list.length / this.cols));
    const cv = document.createElement('canvas');
    cv.width = this.cols * this.w;
    cv.height = THREE.MathUtils.ceilPowerOfTwo(rows * this.h);
    const g = cv.getContext('2d')!;
    const bgs = ['#1f3b2f', '#6b1f2a', '#1d2c4a', '#1b1b1e', '#efe6d2', '#7a3b1e', '#2f4f5f', '#4a2f55'];
    this.list.forEach((name, i) => {
      const x = (i % this.cols) * this.w, y = Math.floor(i / this.cols) * this.h;
      const bg = bgs[hashStr(name) % bgs.length];
      g.fillStyle = bg;
      g.fillRect(x, y, this.w, this.h);
      g.strokeStyle = bg === '#efe6d2' ? '#5a4a3a' : '#d9c58f';
      g.lineWidth = 2;
      g.strokeRect(x + 3, y + 3, this.w - 6, this.h - 6);
      g.fillStyle = bg === '#efe6d2' ? '#2a2420' : '#f4ecd6';
      g.font = `${hashStr(name) % 2 ? 'italic ' : ''}bold 24px Georgia, serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, x + this.w / 2, y + this.h / 2 + 1, this.w - 16);
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }
}
class SignBuf {
  pos: number[] = [];
  uv: number[] = [];
  slots: number[] = [];
  count = 0;
  quad(x: number, y: number, z: number, ux: number, uz: number, nx: number, nz: number, w: number, h: number, slot: number, _a: SignAtlas) {
    const hw = w / 2, hh = h / 2;
    // the right hand of someone outside looking at the wall: text reads left to right
    const rx = nz, rz = -nx;
    const bl = [x - rx * hw, y - hh, z - rz * hw], br = [x + rx * hw, y - hh, z + rz * hw];
    const tr = [x + rx * hw, y + hh, z + rz * hw], tl = [x - rx * hw, y + hh, z - rz * hw];
    this.pos.push(...bl, ...br, ...tr, ...bl, ...tr, ...tl);
    this.slots.push(slot);
    this.count++;
    void ux; void uz;
  }
  mesh(atlas: SignAtlas): THREE.Mesh | null {
    if (!this.count) return null;
    for (const s of this.slots) {
      const [u0, v0, u1, v1] = atlas.uv(s);
      this.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: atlas.texture(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    m.name = 'shop-signs';
    m.matrixAutoUpdate = false;
    return m;
  }
}
export { POI_NAMES, mixc };
