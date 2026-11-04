// Water for the Georgetown world: the Potomac (a big wave-animated plane), the C&O Canal (a stone-walled cut with
// the towpath, stepped pounds and lock gates, footbridges), Rock Creek (cut into its valley), fountains, the
// Washington Harbour plaza, the riverside boardwalk and piers. Also the water levels other files query.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { GeoDoc, Pt } from './geoDoc';
import { clamp, densify, lerp, offsetLine, pointInPoly, SegGrid } from './geoDoc';
import { lin, shade, type MeshBuf, type PhysChunks, type RenderChunks } from './meshKit';
import { B, K, bakeAprons, type GeoRaster } from './terrain';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- layout / art constants
const CANAL_HALF = 6; // m, water half width (matches the data's canal polygon)
const BANK_N = 2.6; // m of stone/grass bank on the north side of the canal
const BANK_S = 5.6; // m on the south (river) side: coping + the towpath
const BANK_ABOVE = 1.1; // m from canal water to the banks
const APRON = 7.5; // m of terrain-coloured apron draped beyond the canal corridor (covers the terrain mesh hole edge)
const APRON_DROP = 0.12; // m the apron sits below natural ground (so terrain triangles that do exist stay on top)
/** Rock Creek water level (m) by z (south), from the spec's levels by latitude. */
const CREEK_LEVELS: [number, number][] = [[-832.6, 11], [-466.3, 8], [-310.8, 6], [133.2, 2], [655, 0.5], [760, 0.2]];
const CREEK_HALF = { north: 7, mouth: 12 };
const COL = {
  water: 0x2f7fa8,
  canalWater: 0x4f7f6c,
  creekWater: 0x3e7f86,
  stone: lin(0xaaa397),
  coping: lin(0xb9b3a6),
  towpath: lin(0xc2ad86),
  grassBank: lin(0x7aa257),
  wood: lin(0x8c6440),
  darkWood: lin(0x5e4128),
  rail: lin(0x2f3236),
  plaza: lin(0xc8bba5),
  plazaDark: lin(0xa89c88),
  granite: lin(0x8e8b86),
  jet: lin(0xe6f2f8),
  boatHull: [lin(0xf4f1e8), lin(0xd94f3d), lin(0x2f5d8a), lin(0x2e7d5b), lin(0xf2c14e)],
};

export interface WaterModel {
  river: Pt[];
  canal: Pt[];
  canalCum: Float32Array;
  creek: Pt[];
  lockX: number[];
  canalLevelAt(x: number): number;
  creekLevelAt(z: number): number;
  creekHalfAt(z: number): number;
  /** Surface level of whichever water body is at (x, z) (river level if none). */
  levelAt(x: number, z: number): number;
  /** Canal corridor query: distance from the canal centre line and side (+1 north, -1 south), or null. */
  canalGrid: SegGrid;
  creekGrid: SegGrid;
}

export function makeWaterModel(doc: GeoDoc): WaterModel {
  const river = doc.water.find((w) => w.kind === 'river')?.pts ?? [];
  const canal = doc.waterways.find((w) => w.kind === 'canal')?.pts ?? [];
  const creek = doc.waterways.find((w) => w.kind === 'stream')?.pts ?? [];
  const gates = doc.props.filter((p) => p[2] === 'lock_gate').map((p) => p[0]).sort((a, b) => a - b);
  const lockX: number[] = [];
  for (let i = 0; i + 1 < gates.length; i += 2) lockX.push((gates[i] + gates[i + 1]) / 2);
  const levels = G.canalLevels;
  const canalLevelAt = (x: number) => {
    let i = 0;
    while (i < lockX.length && x > lockX[i] + 13) i++;
    return levels[Math.min(levels.length - 1, i)];
  };
  const creekLevelAt = (z: number) => {
    const L = CREEK_LEVELS;
    if (z <= L[0][0]) return L[0][1];
    for (let i = 1; i < L.length; i++) if (z <= L[i][0]) return lerp(L[i - 1][1], L[i][1], (z - L[i - 1][0]) / (L[i][0] - L[i - 1][0]));
    return L[L.length - 1][1];
  };
  const zN = creek.length ? Math.min(...creek.map((p) => p[1])) : 0, zS = creek.length ? Math.max(...creek.map((p) => p[1])) : 1;
  const creekHalfAt = (z: number) => lerp(CREEK_HALF.north, CREEK_HALF.mouth, clamp((z - zN) / (zS - zN), 0, 1));
  const canalGrid = new SegGrid(24);
  canalGrid.addLine(canal, 0, CANAL_HALF + BANK_S + APRON + 2);
  const creekGrid = new SegGrid(24);
  creekGrid.addLine(creek, 0, 30);
  const cum = new Float32Array(canal.length);
  for (let i = 1; i < canal.length; i++) cum[i] = cum[i - 1] + Math.hypot(canal[i][0] - canal[i - 1][0], canal[i][1] - canal[i - 1][1]);
  let qd = 0, qz = 0;
  const levelAt = (x: number, z: number) => {
    qd = Infinity;
    canalGrid.query(x, z, (_s, _p, d) => { if (d < qd) qd = d; });
    if (qd < CANAL_HALF + BANK_S + 1) return canalLevelAt(x);
    qd = Infinity;
    creekGrid.query(x, z, (_s, _p, d) => { if (d < qd) qd = d; });
    qz = z;
    if (qd < creekHalfAt(qz) + 15) return Math.max(G.riverLevel, creekLevelAt(z));
    return G.riverLevel;
  };
  return { river, canal, canalCum: cum, creek, lockX, canalLevelAt, creekLevelAt, creekHalfAt, levelAt, canalGrid, creekGrid };
}

// ======================================================================================================
/** Water cuts in the base terrain (before roads): river kind flags, Rock Creek bed and banks, the canal corridor. */
export function rasterizeWater(doc: GeoDoc, W: WaterModel, ras: GeoRaster) {
  const t = ras.t!, h = ras.h!, k = ras.k, band = ras.band;
  // river: flag water below its polygon (heights come from the data: the bed is -2 m)
  if (W.river.length) ras.fillRing(W.river, (o) => { k[o] |= K.WATER; if (t[o] > G.riverLevel - 0.6) t[o] = G.riverLevel - 0.6; });
  // fountains / ponds
  for (const w of doc.water) if (w.kind === 'fountain') ras.fillRing(w.pts, (o) => { k[o] |= K.WATER; });
  // Rock Creek: bed inside, natural banks rising to the valley sides
  const C = W.creek;
  if (C.length > 1) {
    const dist = new Map<number, number>();
    for (let i = 1; i < C.length; i++) {
      const a = C[i - 1], b = C[i];
      const hwMax = W.creekHalfAt(Math.max(a[1], b[1]));
      ras.forSegment(a[0], a[1], b[0], b[1], hwMax + 14, (o, d) => { const pd = dist.get(o); if (pd === undefined || d < pd) dist.set(o, d); });
    }
    for (const [o, d] of dist) {
      const z = ras.z0 + Math.floor(o / ras.nx);
      const lvl = W.creekLevelAt(z), hw = W.creekHalfAt(z);
      if (d < hw) {
        t[o] = Math.min(t[o], lvl - G.creekDepth * (1 - (d / hw) ** 2 * 0.5));
        k[o] |= K.WATER;
      } else {
        const u = (d - hw) / 14;
        const bank = lvl + 0.35 + u * u * 9;
        if (t[o] > bank) t[o] = lerp(bank, t[o], u * u);
      }
    }
  }
  h.set(t);
  // canal corridor: bed, walls, banks; a hole in the terrain mesh. Each cell takes its NEAREST segment of the same
  // densified line the mesh is built from (buildWater), with the mesh's heights: bed = deeper pound of the segment,
  // banks ramp from one pound's level to the next across the segment that holds a lock step.
  const P = densify(W.canal, 4);
  const best = new Map<number, number>(); // cell -> index into seg (nearest segment so far)
  const seg: number[] = []; // per visit: d, t, side, i
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    ras.forSegment(a[0], a[1], b[0], b[1], CANAL_HALF + BANK_S, (o, d, tt, side) => {
      const prev = best.get(o);
      if (prev !== undefined && seg[prev] <= d) return;
      best.set(o, seg.length);
      seg.push(d, tt, side, i);
    });
  }
  for (const [o, q] of best) {
    const d = seg[q], tt = seg[q + 1], side = seg[q + 2], i = seg[q + 3];
    // nothing beyond the two ends of the line: the mesh has no end caps (the canal opens into Rock Creek / the edge)
    if ((i === 1 && tt <= 0) || (i === P.length - 1 && tt >= 1)) continue;
    // forSegment's side +1 is the right of travel; the canal runs east->west, so +1 = north (as offsetLine in buildWater)
    const lim = side > 0 ? CANAL_HALF + BANK_N : CANAL_HALF + BANK_S;
    if (d > lim) continue;
    const lA = W.canalLevelAt(P[i - 1][0]), lC = W.canalLevelAt(P[i][0]);
    if (d <= CANAL_HALF) {
      h[o] = Math.max(lA, lC) - G.canalDepth;
      k[o] = (k[o] & ~K.PARK) | K.WATER | K.WALL;
    } else {
      h[o] = lerp(lA, lC, tt) + BANK_ABOVE;
      k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.WALK;
    }
    band[o] = B.HOLE;
  }
}

// ======================================================================================================
export interface WalkDeck {
  pts: Pt[];
  hw: number;
  h: number[];
}
export interface WaterMeshes {
  meshes: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  update(time: number): void;
  walkDecks: WalkDeck[];
}

function waterMaterial(color: number, waves: number, uTime: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.18, metalness: 0.15, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wpW = modelMatrix * vec4(position, 1.0);
        transformed.y += ${waves.toFixed(3)} * (sin(wpW.x * 0.071 + uTime * 1.1) * 0.6 + cos(wpW.z * 0.093 + uTime * 0.83) * 0.5 + sin((wpW.x + wpW.z) * 0.031 - uTime * 0.6) * 0.4);`);
  };
  return m;
}

export function buildWater(doc: GeoDoc, W: WaterModel, ras: GeoRaster, chunks: RenderChunks, phys: PhysChunks, scene: THREE.Object3D): WaterMeshes {
  const uTime = { value: 0 };
  const riverMat = waterMaterial(COL.water, 0.16, uTime);
  const canalMat = waterMaterial(COL.canalWater, 0.015, uTime);
  const creekMat = waterMaterial(COL.creekWater, 0.03, uTime);
  const meshes: THREE.Mesh[] = [];
  const walkDecks: WalkDeck[] = [];
  const b = doc.meta.bounds;

  // ---- Potomac: one plane from just north of the shore to far south, 25 m facets
  {
    // 30 m facets; inside the map only where the land is low (so the plane never shows through holes inland)
    const zTop = Math.min(...W.river.map((p) => p[1])) - 25;
    const x0 = b.x0 - 1500, x1 = b.x1 + 1500, z1 = b.z1 + 1800, st = 30;
    const rw = new MeshBufLite();
    for (let z = zTop; z < z1; z += st)
      for (let x = x0; x < x1; x += st) {
        const inside = x + st > b.x0 && x < b.x1 && z < b.z1;
        if (inside) {
          let low = false;
          for (let q = 0; q < 9 && !low; q++) {
            const sx = clamp(x + (q % 3) * st * 0.5, b.x0, b.x1), sz = clamp(z + Math.floor(q / 3) * st * 0.5, b.z0, b.z1);
            if (ras.heightAt(sx, sz) < G.riverLevel + 0.9) low = true;
          }
          if (!low) continue;
        }
        rw.quad([x, z], [x + st, z], [x + st, z + st], [x, z + st], G.riverLevel, G.riverLevel, G.riverLevel, G.riverLevel);
      }
    const m = new THREE.Mesh(rw.geometry(), riverMat);
    m.receiveShadow = true;
    m.name = 'river';
    scene.add(m);
    meshes.push(m);
  }

  // ---- canal: water ribbons per pound, walls, banks, towpath, retaining walls, apron
  const canalWater = new MeshBufLite();
  const P = densify(W.canal, 4);
  const n = P.length;
  const dirAt = (i: number) => {
    const a = P[Math.max(0, i - 1)], c = P[Math.min(n - 1, i + 1)];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    return [(c[0] - a[0]) / L, (c[1] - a[1]) / L];
  };
  // right normal of an east->west line points north (z-)
  const north = offsetLine(P, CANAL_HALF), south = offsetLine(P, -CANAL_HALF);
  const northB = offsetLine(P, CANAL_HALF + BANK_N), southB = offsetLine(P, -(CANAL_HALF + BANK_S));
  const northA = offsetLine(P, CANAL_HALF + BANK_N + APRON), southA = offsetLine(P, -(CANAL_HALF + BANK_S + APRON));
  const outsideH = (x: number, z: number, nx: number, nz: number) => ras.heightAt(x + nx * 0.8, z + nz * 0.8);
  for (let i = 1; i < n; i++) {
    const a = P[i - 1], c = P[i];
    const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
    const lA = W.canalLevelAt(a[0]), lC = W.canalLevelAt(c[0]);
    const lvl = Math.max(lA, lC);
    const buf = chunks.buf('ground', mx, mz);
    const pb = phys.ground(mx, mz);
    const bed = lvl - G.canalDepth, bank = lvl + BANK_ABOVE;
    const bankA = lA + BANK_ABOVE, bankC = lC + BANK_ABOVE;
    const [dx, dz] = dirAt(i);
    const nnx = dz, nnz = -dx; // north normal (right of travel = (-dz, dx)? east->west: dx<0 => right = (-dz,dx) = (0,-1))
    void nnx; void nnz;
    // water surface (level steps happen at the downstream lock gate)
    canalWater.quad(north[i - 1], south[i - 1], south[i], north[i], lA, lA, lC, lC);
    // bed
    buf.quad(north[i - 1][0], bed, north[i - 1][1], south[i - 1][0], bed, south[i - 1][1], south[i][0], bed, south[i][1], north[i][0], bed, north[i][1], COL.stone, 0, 1, 0);
    pb.quad(north[i - 1][0], bed, north[i - 1][1], south[i - 1][0], bed, south[i - 1][1], south[i][0], bed, south[i][1], north[i][0], bed, north[i][1]);
    // water-edge walls (face the water)
    const toS = [south[i][0] - north[i][0], south[i][1] - north[i][1]];
    buf.wall(north[i - 1][0], north[i - 1][1], north[i][0], north[i][1], bed, bankA, bed, bankC, COL.stone, toS[0], toS[1]);
    buf.wall(south[i - 1][0], south[i - 1][1], south[i][0], south[i][1], bed, bankA, bed, bankC, COL.stone, -toS[0], -toS[1]);
    pb.quad(north[i - 1][0], bed, north[i - 1][1], north[i][0], bed, north[i][1], north[i][0], bankC, north[i][1], north[i - 1][0], bankA, north[i - 1][1]);
    pb.quad(south[i - 1][0], bed, south[i - 1][1], south[i][0], bed, south[i][1], south[i][0], bankC, south[i][1], south[i - 1][0], bankA, south[i - 1][1]);
    // banks: north stone/grass, south coping + towpath
    const nb0 = northB[i - 1], nb1 = northB[i], sb0 = southB[i - 1], sb1 = southB[i];
    const nc0: Pt = [lerp(north[i - 1][0], nb0[0], 0.25), lerp(north[i - 1][1], nb0[1], 0.25)], nc1: Pt = [lerp(north[i][0], nb1[0], 0.25), lerp(north[i][1], nb1[1], 0.25)];
    buf.quad(north[i - 1][0], bankA, north[i - 1][1], nc0[0], bankA, nc0[1], nc1[0], bankC, nc1[1], north[i][0], bankC, north[i][1], (i & 1) ? COL.coping : shade(COL.coping, 0.95), 0, 1, 0);
    buf.quad(nc0[0], bankA, nc0[1], nb0[0], bankA, nb0[1], nb1[0], bankC, nb1[1], nc1[0], bankC, nc1[1], shade(COL.grassBank, 0.97 + (i % 3) * 0.02), 0, 1, 0);
    pb.quad(north[i - 1][0], bankA, north[i - 1][1], nb0[0], bankA, nb0[1], nb1[0], bankC, nb1[1], north[i][0], bankC, north[i][1]);
    const sc0: Pt = [lerp(south[i - 1][0], sb0[0], 0.12), lerp(south[i - 1][1], sb0[1], 0.12)], sc1: Pt = [lerp(south[i][0], sb1[0], 0.12), lerp(south[i][1], sb1[1], 0.12)];
    buf.quad(south[i - 1][0], bankA, south[i - 1][1], sc0[0], bankA, sc0[1], sc1[0], bankC, sc1[1], south[i][0], bankC, south[i][1], COL.coping, 0, 1, 0);
    buf.quad(sc0[0], bankA, sc0[1], sb0[0], bankA, sb0[1], sb1[0], bankC, sb1[1], sc1[0], bankC, sc1[1], shade(COL.towpath, (i % 3) * 0.02 + 0.97), 0, 1, 0);
    pb.quad(south[i - 1][0], bankA, south[i - 1][1], sb0[0], bankA, sb0[1], sb1[0], bankC, sb1[1], south[i][0], bankC, south[i][1]);
    // retaining walls at the corridor edges up (or down) to the land outside
    for (const [e0, e1, sgn] of [[nb0, nb1, 1], [sb0, sb1, -1]] as [Pt, Pt, number][]) {
      const ox = (e0[0] + e1[0]) / 2 - mx, oz = (e0[1] + e1[1]) / 2 - mz;
      const L = Math.hypot(ox, oz) || 1;
      const ux = ox / L, uz = oz / L;
      const t0 = outsideH(e0[0], e0[1], ux, uz), t1 = outsideH(e1[0], e1[1], ux, uz);
      const k0 = ras.kindAt(e0[0] + ux * 1.5, e0[1] + uz * 1.5);
      if (k0 & K.WATER) continue;
      const up = (t0 + t1) / 2 > bank;
      buf.wall(e0[0], e0[1], e1[0], e1[1], Math.min(bankA, t0) - 0.3, Math.max(bankA, t0) + 0.25, Math.min(bankC, t1) - 0.3, Math.max(bankC, t1) + 0.25, shade(COL.stone, 0.92), up ? -ux : ux, up ? -uz : uz);
      buf.quad(e0[0], Math.max(bankA, t0) + 0.25, e0[1], e1[0], Math.max(bankC, t1) + 0.25, e1[1], e1[0] + ux * 0.45, Math.max(bankC, t1) + 0.25, e1[1] + uz * 0.45, e0[0] + ux * 0.45, Math.max(bankA, t0) + 0.25, e0[1] + uz * 0.45, COL.coping, 0, 1, 0);
      // outer face of the coping, down into the land (closes the gap to the apron)
      buf.wall(e0[0] + ux * 0.45, e0[1] + uz * 0.45, e1[0] + ux * 0.45, e1[1] + uz * 0.45, t0 - 0.4, Math.max(bankA, t0) + 0.25, t1 - 0.4, Math.max(bankC, t1) + 0.25, shade(COL.stone, 0.95), ux, uz);
      pb.quad(e0[0], Math.min(bankA, t0) - 0.3, e0[1], e1[0], Math.min(bankC, t1) - 0.3, e1[1], e1[0], Math.max(bankC, t1) + 0.25, e1[1], e0[0], Math.max(bankA, t0) + 0.25, e0[1]);
      void sgn;
    }
    // aprons under the jagged edge of the terrain mesh hole: ground geometry a little below the surface (so roads,
    // sidewalks and terrain that do exist stay on top), with physics so nothing falls through the gap
    for (const [e0, e1, f0, f1] of [[nb0, nb1, northA[i - 1], northA[i]], [sb0, sb1, southA[i - 1], southA[i]]] as Pt[][]) {
      const steps = 3;
      for (let q = 0; q < steps; q++) {
        const u0 = q / steps, u1 = (q + 1) / steps;
        const A0: Pt = [lerp(e0[0], f0[0], u0), lerp(e0[1], f0[1], u0)], A1: Pt = [lerp(e1[0], f1[0], u0), lerp(e1[1], f1[1], u0)];
        const C0: Pt = [lerp(e0[0], f0[0], u1), lerp(e0[1], f0[1], u1)], C1: Pt = [lerp(e1[0], f1[0], u1), lerp(e1[1], f1[1], u1)];
        const cx = (A0[0] + C1[0]) / 2, cz = (A0[1] + C1[1]) / 2;
        if (ras.kindAt(cx, cz) & K.WATER || ras.bandAt(cx, cz) === B.HOLE) continue;
        const y = (p: Pt) => ras.heightAt(p[0], p[1]) - (ras.bandAt(p[0], p[1]) === B.NONE ? APRON_DROP : 0.36);
        const ya0 = y(A0), yc0 = y(C0), yc1 = y(C1), ya1 = y(A1);
        const g = chunks.buf('ground', cx, cz);
        g.quad(A0[0], ya0, A0[1], C0[0], yc0, C0[1], C1[0], yc1, C1[1], A1[0], ya1, A1[1], shade(COL.grassBank, 0.96 + 0.04 * Math.sin(cx * 0.1)), 0, 1, 0);
        phys.ground(cx, cz).quad(A0[0], ya0, A0[1], C0[0], yc0, C0[1], C1[0], yc1, C1[1], A1[0], ya1, A1[1]);
      }
    }
  }
  bakeAprons(ras, APRON_DROP);
  {
    const m = new THREE.Mesh(canalWater.geometry(), canalMat);
    m.name = 'canal';
    scene.add(m);
    meshes.push(m);
  }

  // ---- lock gates: mitre leaves across the canal + balance beams on the banks
  const gates = doc.props.filter((p) => p[2] === 'lock_gate');
  for (const g of gates) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.hypot(P[i][0] - g[0], P[i][1] - g[1]); if (d < bd) { bd = d; best = i; } }
    const [dx, dz] = dirAt(best);
    const rx = -dz, rz = dx; // right of an east->west line = north
    const c = P[best];
    const lvl = W.canalLevelAt(c[0]) + BANK_ABOVE;
    const buf = chunks.buf('ground', c[0], c[1]);
    for (const s of [-1, 1]) {
      // leaf from the wall to the middle, angled upstream (west = along +d)
      const ax = c[0] + rx * CANAL_HALF * s, az = c[1] + rz * CANAL_HALF * s;
      const bx = c[0] + dx * 1.6, bz = c[1] + dz * 1.6;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const L = Math.hypot(bx - ax, bz - az);
      buf.obox(mx, lvl - G.canalDepth - 1.4, mz, L / 2, 0.22, lvl + 0.35, (bx - ax) / L, (bz - az) / L, COL.darkWood, COL.wood, false);
      // balance beam on the bank
      const px = ax + rx * s * 0.6, pz = az + rz * s * 0.6;
      buf.obox(px - dx * 3, lvl + 0.55, pz - dz * 3, 3.2, 0.18, lvl + 0.85, dx, dz, COL.wood);
      buf.obox(px, lvl, pz, 0.25, 0.25, lvl + 0.6, dx, dz, COL.darkWood);
    }
  }

  // ---- footbridges over the canal (path bridges in the data)
  for (const f of doc.footways) {
    if (!f.bridge || f.kind === 'sidewalk' || f.kind === 'crossing' || f.pts.length < 2) continue;
    const a = f.pts[0], c = f.pts[f.pts.length - 1];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const ux = (c[0] - a[0]) / L, uz = (c[1] - a[1]) / L;
    const ya = ras.heightAt(a[0] - ux * 0.5, a[1] - uz * 0.5), yc = ras.heightAt(c[0] + ux * 0.5, c[1] + uz * 0.5);
    const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
    const buf = chunks.buf('ground', mx, mz);
    const pb = phys.ground(mx, mz);
    const segs = 10, hw = 1.4;
    const rx = -uz, rz = ux;
    let prev: number[] | null = null;
    const wd: WalkDeck = { pts: [], hw, h: [] };
    walkDecks.push(wd);
    for (let q = 0; q <= segs; q++) {
      const u = q / segs;
      const x = a[0] + ux * L * u, z = a[1] + uz * L * u;
      const y = lerp(ya, yc, u) + Math.sin(Math.PI * u) * 1.1 + 0.05;
      wd.pts.push([x, z]);
      wd.h.push(y);
      const cur = [x - rx * hw, y, z - rz * hw, x + rx * hw, y, z + rz * hw];
      if (prev) {
        buf.quad(prev[0], prev[1], prev[2], prev[3], prev[4], prev[5], cur[3], cur[4], cur[5], cur[0], cur[1], cur[2], COL.wood, 0, 1, 0);
        pb.quad(prev[0], prev[1], prev[2], prev[3], prev[4], prev[5], cur[3], cur[4], cur[5], cur[0], cur[1], cur[2]);
        buf.quad(prev[0], prev[1] - 0.35, prev[2], prev[3], prev[4] - 0.35, prev[5], cur[3], cur[4] - 0.35, cur[5], cur[0], cur[1] - 0.35, cur[2], COL.darkWood, 0, -1, 0);
        for (const s of [0, 3]) {
          buf.wall(prev[s], prev[s + 2], cur[s], cur[s + 2], prev[s + 1] - 0.35, prev[s + 1], cur[s + 1] - 0.35, cur[s + 1], COL.darkWood, s ? rx : -rx, s ? rz : -rz);
          // railing: posts + top rail
          buf.obox(prev[s], prev[s + 1], prev[s + 2], 0.06, 0.06, prev[s + 1] + 1.05, ux, uz, COL.rail);
          const tx = (prev[s] + cur[s]) / 2, tz = (prev[s + 2] + cur[s + 2]) / 2;
          const seg = Math.hypot(cur[s] - prev[s], cur[s + 2] - prev[s + 2]);
          buf.obox(tx, (prev[s + 1] + cur[s + 1]) / 2 + 0.95, tz, seg / 2 + 0.05, 0.05, (prev[s + 1] + cur[s + 1]) / 2 + 1.05, ux, uz, COL.rail);
        }
      }
      prev = cur;
    }
    // side rails keep people on: a thin slab per side and segment, following the arch (not one box down the middle)
    for (let q = 1; q < wd.pts.length; q++) {
      const p0 = wd.pts[q - 1], p1 = wd.pts[q], y0 = Math.min(wd.h[q - 1], wd.h[q]), y1 = Math.max(wd.h[q - 1], wd.h[q]);
      const sl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2;
      for (const sd of [-1, 1]) {
        const cx = (p0[0] + p1[0]) / 2 + rx * (hw - 0.05) * sd, cz = (p0[1] + p1[1]) / 2 + rz * (hw - 0.05) * sd;
        phys.box(cx, (y0 + y1 + 1.05) / 2, cz, sl + 0.02, (y1 + 1.05 - y0) / 2, 0.05, ux, uz);
      }
    }
  }

  // ---- Rock Creek water: a sloped ribbon a little wider than the cut (its edges hide under the banks)
  {
    const C = densify(W.creek, 6);
    const cw = new MeshBufLite();
    const L = offsetLine(C, 1), R = offsetLine(C, -1);
    for (let i = 1; i < C.length; i++) {
      const w0 = W.creekHalfAt(C[i - 1][1]) + 2.2, w1 = W.creekHalfAt(C[i][1]) + 2.2;
      const l0: Pt = [C[i - 1][0] + (L[i - 1][0] - C[i - 1][0]) * w0, C[i - 1][1] + (L[i - 1][1] - C[i - 1][1]) * w0];
      const r0: Pt = [C[i - 1][0] + (R[i - 1][0] - C[i - 1][0]) * w0, C[i - 1][1] + (R[i - 1][1] - C[i - 1][1]) * w0];
      const l1: Pt = [C[i][0] + (L[i][0] - C[i][0]) * w1, C[i][1] + (L[i][1] - C[i][1]) * w1];
      const r1: Pt = [C[i][0] + (R[i][0] - C[i][0]) * w1, C[i][1] + (R[i][1] - C[i][1]) * w1];
      const y0 = W.creekLevelAt(C[i - 1][1]), y1 = W.creekLevelAt(C[i][1]);
      cw.quad(l0, r0, r1, l1, y0, y0, y1, y1);
    }
    const m = new THREE.Mesh(cw.geometry(), creekMat);
    m.name = 'creek';
    scene.add(m);
    meshes.push(m);
  }

  // ---- fountains: the waterfront park pad with jets, round basins elsewhere
  const fountainPads = doc.water.filter((w) => w.kind === 'fountain');
  const fw = new MeshBufLite();
  for (const fp of fountainPads) {
    const cx = fp.pts.reduce((s, p) => s + p[0], 0) / fp.pts.length, cz = fp.pts.reduce((s, p) => s + p[1], 0) / fp.pts.length;
    const r = Math.hypot(fp.pts[0][0] - cx, fp.pts[0][1] - cz);
    const y = ras.heightAt(cx + r + 2, cz);
    const buf = chunks.buf('ground', cx, cz);
    // granite pad, a thin water film and a ring of jets
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
      buf.tri(cx, y + 0.06, cz, cx + Math.cos(a0) * (r + 1.5), y + 0.06, cz + Math.sin(a0) * (r + 1.5), cx + Math.cos(a1) * (r + 1.5), y + 0.06, cz + Math.sin(a1) * (r + 1.5), COL.granite, 0, 1, 0);
      fw.tri(cx, y + 0.1, cz, cx + Math.cos(a0) * r, y + 0.1, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y + 0.1, cz + Math.sin(a1) * r);
    }
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, rr = i % 2 ? r * 0.75 : r * 0.4;
      buf.cyl(cx + Math.cos(a) * rr, y + 0.1, cz + Math.sin(a) * rr, 0.16, 0.04, 1.2 + (i % 3) * 0.5, 5, COL.jet, false);
    }
  }
  for (const p of doc.props) {
    if (p[2] !== 'fountain') continue;
    if (fountainPads.some((f) => pointInPoly(p[0], p[1], f.pts))) continue;
    const cx = p[0], cz = p[1];
    const y = ras.heightAt(cx, cz);
    const buf = chunks.buf('ground', cx, cz);
    const r = 4.2;
    buf.cyl(cx, y - 0.2, cz, r + 0.5, r + 0.5, 0.75, 20, COL.granite);
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * Math.PI * 2, a1 = ((i + 1) / 20) * Math.PI * 2;
      fw.tri(cx, y + 0.58, cz, cx + Math.cos(a0) * r, y + 0.58, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y + 0.58, cz + Math.sin(a1) * r);
    }
    buf.cyl(cx, y + 0.5, cz, 0.8, 0.6, 0.9, 10, COL.granite);
    buf.cyl(cx, y + 1.4, cz, 0.35, 0.05, 2.6, 6, COL.jet, false);
    phys.cylinder(cx, y - 0.2, cz, r + 0.5, 0.75);
  }
  {
    const m = new THREE.Mesh(fw.geometry(), creekMat);
    m.name = 'fountains';
    scene.add(m);
    meshes.push(m);
  }

  return {
    meshes,
    walkDecks,
    materials: [riverMat, canalMat, creekMat],
    update(time: number) {
      uTime.value = time;
    },
  };
}

// ======================================================================================================
/** Washington Harbour plaza (pedestrian area with holes), the riverside boardwalk and the piers. */
export function rasterizePlaza(doc: GeoDoc, ras: GeoRaster): { plazaH: (x: number, z: number) => number } {
  const plaza = doc.footways.find((f) => f.kind === 'pedestrian' && f.area);
  let a = 0, bx = 0, bz = 0;
  if (plaza) {
    // plane fit through the corners, kept above the river
    const pts = plaza.pts;
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n, mz = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0, sh = 0;
    for (const p of pts) {
      const x = p[0] - mx, z = p[1] - mz, hh = Math.max(1.5, ras.baseAt(p[0], p[1]));
      sxx += x * x; szz += z * z; sxz += x * z; sxh += x * hh; szh += z * hh; sh += hh;
    }
    const det = sxx * szz - sxz * sxz || 1;
    bx = clamp((sxh * szz - szh * sxz) / det, -0.02, 0.02);
    bz = clamp((szh * sxx - sxh * sxz) / det, -0.02, 0.02);
    a = sh / n - bx * mx - bz * mz;
    const h = ras.h!, band = ras.band, k = ras.k;
    ras.fillRing(pts, (o, x, z) => {
      if (band[o] === B.ROAD || band[o] === B.FLAT) return;
      if (plaza.holes?.some((hole) => pointInPoly(x, z, hole))) return;
      h[o] = Math.max(1.3, a + bx * x + bz * z);
      band[o] = B.FLAT;
      k[o] = (k[o] & ~(K.WATER | K.PARK)) | K.WALK;
    });
  }
  return { plazaH: (x, z) => Math.max(1.3, a + bx * x + bz * z) };
}

export function buildPlazaAndPiers(doc: GeoDoc, ras: GeoRaster, chunks: RenderChunks, phys: PhysChunks, plazaH: (x: number, z: number) => number, W: WaterModel): WalkDeck[] {
  const walkDecks: WalkDeck[] = [];
  const plaza = doc.footways.find((f) => f.kind === 'pedestrian' && f.area);
  if (plaza) {
    const contour = plaza.pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const holes = (plaza.holes ?? []).map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    const all = [...contour, ...holes.flat()];
    // subdivide big triangles a little so the paving pattern shows
    for (const t of tris) {
      const [A, Bv, C] = t.map((i) => all[i]);
      const cx = (A.x + Bv.x + C.x) / 3, cz = (A.y + Bv.y + C.y) / 3;
      const buf = chunks.buf('ground', cx, cz);
      const pb = phys.ground(cx, cz);
      const y = (v: THREE.Vector2) => plazaH(v.x, v.y);
      buf.tri(A.x, y(A), A.y, Bv.x, y(Bv), Bv.y, C.x, y(C), C.y, COL.plaza, 0, 1, 0);
      pb.tri(A.x, y(A), A.y, Bv.x, y(Bv), Bv.y, C.x, y(C), C.y);
    }
    // paving bands (decal stripes) and edges: quay wall on the river side, skirts elsewhere
    const n = plaza.pts.length;
    for (let i = 0; i < n; i++) {
      const p = plaza.pts[i], q = plaza.pts[(i + 1) % n];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      const buf = chunks.buf('ground', mx, mz);
      const cx = plaza.pts.reduce((s, v) => s + v[0], 0) / n, cz = plaza.pts.reduce((s, v) => s + v[1], 0) / n;
      const ox = mx - cx, oz = mz - cz;
      const nearWater = ras.kindAt(mx + ox * 0.08, mz + oz * 0.08) & K.WATER;
      buf.wall(p[0], p[1], q[0], q[1], nearWater ? -2.5 : plazaH(p[0], p[1]) - 1.2, plazaH(p[0], p[1]), nearWater ? -2.5 : plazaH(q[0], q[1]) - 1.2, plazaH(q[0], q[1]), COL.granite, ox, oz);
    }
    const minX = Math.min(...plaza.pts.map((p) => p[0])), maxX = Math.max(...plaza.pts.map((p) => p[0]));
    const minZ = Math.min(...plaza.pts.map((p) => p[1])), maxZ = Math.max(...plaza.pts.map((p) => p[1]));
    for (let x = minX + 6; x < maxX; x += 12)
      for (let z = minZ + 6; z < maxZ; z += 12) {
        if (!pointInPoly(x, z, plaza.pts) || plaza.holes?.some((h) => pointInPoly(x, z, h))) continue;
        if (ras.bandAt(x, z) !== B.FLAT) continue;
        const y = plazaH(x, z) + 0.012;
        chunks.buf('decal', x, z).quad(x - 2.5, y, z - 2.5, x + 2.5, y, z - 2.5, x + 2.5, y, z + 2.5, x - 2.5, y, z + 2.5, COL.plazaDark, 0, 1, 0);
      }
  }
  // boardwalk (wood footways that are not piers) and piers into the river
  for (const f of doc.footways) {
    if (f.surface !== 'wood') continue;
    const isPier = !!f.pier;
    const w = isPier ? 2.6 : 6;
    const pts = densify(f.pts, 6);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], c = pts[i];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 0.2) continue;
      const ux = (c[0] - a[0]) / L, uz = (c[1] - a[1]) / L;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const y = isPier ? 0.95 : Math.max(1.45, Math.min(2.2, ras.heightAt(mx - uz * 4, mz + ux * 4)));
      const buf = chunks.buf('ground', mx, mz);
      walkDecks.push({ pts: [a, c], hw: w / 2, h: [y, y] });
      buf.obox(mx, y - 0.3, mz, L / 2 + 0.05, w / 2, y, ux, uz, COL.wood, COL.darkWood);
      phys.box(mx, y - 0.15, mz, L / 2 + 0.05, 0.15, w / 2, ux, uz);
      // planks
      const dec = chunks.buf('decal', mx, mz);
      for (let s = -L / 2; s < L / 2; s += 1.2) {
        const px = mx + ux * s, pz = mz + uz * s;
        dec.quad(px - uz * w / 2, y + 0.008, pz + ux * w / 2, px + uz * w / 2, y + 0.008, pz - ux * w / 2, px + uz * w / 2 + ux * 0.08, y + 0.008, pz - ux * w / 2 + uz * 0.08, px - uz * w / 2 + ux * 0.08, y + 0.008, pz + ux * w / 2 + uz * 0.08, COL.darkWood, 0, 1, 0);
      }
      // piles
      for (const s of [-1, 1]) {
        const px = mx - uz * (w / 2 - 0.2) * s, pz = mz + ux * (w / 2 - 0.2) * s;
        buf.cyl(px, -2.2, pz, 0.16, 0.16, y + 2.2 - 0.3, 6, COL.darkWood, false);
      }
      // rails on piers and the river side of the boardwalk
      const riverSide = (s: number) => ras.kindAt(mx - uz * (w / 2 + 2) * s, mz + ux * (w / 2 + 2) * s) & K.WATER;
      for (const s of [-1, 1]) {
        if (!isPier && !riverSide(s)) continue;
        const px = mx - uz * (w / 2 - 0.08) * s, pz = mz + ux * (w / 2 - 0.08) * s;
        buf.obox(px, y + 0.95, pz, L / 2, 0.05, y + 1.05, ux, uz, COL.rail);
        buf.obox(px, y, pz, 0.05, 0.05, y + 1.0, ux, uz, COL.rail);
        phys.box(px, y + 0.55, pz, L / 2, 0.5, 0.06, ux, uz);
      }
    }
    // a couple of boats on the piers
    if (isPier && pts.length >= 2) {
      const a = pts[0], c = pts[pts.length - 1];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const ux = (c[0] - a[0]) / L, uz = (c[1] - a[1]) / L;
      const hsh = (Math.abs(Math.round(a[0] * 7 + a[1] * 13)) % 5);
      for (const s of [-1, 1]) {
        if ((hsh + s) % 3 === 0) continue;
        const bx = (a[0] + c[0]) / 2 - uz * 3.2 * s, bz = (a[1] + c[1]) / 2 + ux * 3.2 * s;
        if (!(ras.kindAt(bx, bz) & K.WATER)) continue;
        const buf = chunks.buf('ground', bx, bz);
        const col = COL.boatHull[(hsh + (s > 0 ? 1 : 0)) % COL.boatHull.length];
        const bl = Math.min(L * 0.7, 9) / 2;
        buf.obox(bx, -0.5, bz, bl, 1.3, 0.75, ux, uz, col, shade(col, 0.85), true);
        buf.obox(bx - ux * bl * 0.2, 0.75, bz - uz * bl * 0.2, bl * 0.35, 0.9, 1.7, ux, uz, lin(0xf2f2ee));
      }
    }
  }
  void W;
  return walkDecks;
}

// ------------------------------------------------------------------------------------------------------
/** Minimal position-only builder for water surfaces (they use a plain material with flat shading). */
class MeshBufLite {
  pos: number[] = [];
  quad(a: Pt, b: Pt, c: Pt, d: Pt, ya: number, yb: number, yc: number, yd: number) {
    this.pos.push(a[0], ya, a[1], c[0], yc, c[1], b[0], yb, b[1], a[0], ya, a[1], d[0], yd, d[1], c[0], yc, c[1]);
    // fix winding so the faces point up
    const n = this.pos.length;
    for (const o of [n - 18, n - 9]) {
      const P = this.pos;
      const ux = P[o + 3] - P[o], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vz = P[o + 8] - P[o + 2];
      if (uz * vx - ux * vz < 0) {
        for (let k = 0; k < 3; k++) { const t = P[o + 3 + k]; P[o + 3 + k] = P[o + 6 + k]; P[o + 6 + k] = t; }
      }
    }
  }
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    const ux = bx - ax, uz = bz - az, vx = cx - ax, vz = cz - az;
    if (uz * vx - ux * vz >= 0) this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    else this.pos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
export type { MeshBuf };
