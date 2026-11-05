// Bridges and stairs for the Georgetown world: parapets on every deck (solid, part of the ground trimesh), Key Bridge
// arches and river piers, the Whitehurst Freeway's steel columns and cap beams, piers under the Rock Creek bridges,
// lamps on the decks, and walkable stairs (the Exorcist Steps and the canal steps) with smooth ramp colliders.
import { TUNING } from '../../tuning';
import type { GeoDoc, Pt } from './geoDoc';
import { clamp, lerp } from './geoDoc';
import { lin, shade, type PhysChunks, type RenderChunks } from './meshKit';
import { pointAtS, type REdge, type RoadNet } from './roadNet';
import { sections } from './roadMesh';
import { B, K, type GeoRaster } from './terrain';
import type { WaterModel } from './waterworks';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- art constants
const COL = {
  keyBridge: lin(0xd3c8b2),
  keyBridgeDark: lin(0xb6ab95),
  concrete: lin(0xb3afa6),
  concreteDark: lin(0x96928a),
  steel: lin(0x5f6b66),
  steelDark: lin(0x4a5450),
  stone: lin(0x9d9387),
  stoneDark: lin(0x857c71),
  coping: lin(0xc9c3b6),
  step: lin(0xb0a89b),
  rail: lin(0x2b2e31),
};
const PARAPET_T = 0.38; // m thick
const STAIR_RISER = 0.17; // m: drawn riser height on stair flights
const LAMP_SPACING = 32; // m along bridge sidewalks

export interface StairPlan {
  pts: Pt[];
  w: number;
  /** cumulative arc length per point */
  cum: number[];
  L: number;
  /** ramp height at arc length s */
  h: (s: number) => number;
  flights: [number, number][];
  name: string | null;
}

export function buildBridges(net: RoadNet, doc: GeoDoc, ras: GeoRaster, W: WaterModel, chunks: RenderChunks, phys: PhysChunks) {
  const lamps: { x: number; y: number; z: number; ax: number; az: number }[] = [];
  for (const e of net.edges) {
    if (!e.deck) continue;
    const s0 = e.trimA, s1 = e.L - e.trimB;
    if (s1 - s0 < 2) continue;
    const isKey = e.name.includes('Key Bridge');
    const style = isKey ? 'arch' : e.freeway ? 'steel' : /^(P St|Q St|M St)/.test(e.name) && e.L > 60 ? 'arch' : e.L > 40 ? 'columns' : 'short';
    const pCol = isKey ? COL.keyBridge : style === 'steel' ? COL.concrete : style === 'arch' ? COL.stone : COL.concrete;
    // ---- parapets along both outer edges (render + trimesh)
    const X = sections(e, s0, s1);
    for (const side of [-1, 1]) {
      const sw = (side < 0 ? e.swL : e.swR) && !e.noSw.some((r) => r[0] === side);
      const outer = e.hw + (sw ? G.sidewalkWidth : 0) + 0.02;
      const base = sw ? G.kerbHeight : 0;
      for (let i = 1; i < X.length; i++) {
        const p = X[i - 1], q = X[i];
        const hp = net.profAt(e, p.s) + base, hq = net.profAt(e, q.s) + base;
        const ox0 = p.x + p.rx * outer * side, oz0 = p.z + p.rz * outer * side, ox1 = q.x + q.rx * outer * side, oz1 = q.z + q.rz * outer * side;
        const ix0 = p.x + p.rx * (outer - PARAPET_T) * side, iz0 = p.z + p.rz * (outer - PARAPET_T) * side;
        const ix1 = q.x + q.rx * (outer - PARAPET_T) * side, iz1 = q.z + q.rz * (outer - PARAPET_T) * side;
        const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
        const buf = chunks.buf('ground', mx, mz);
        const pb = phys.trimesh(mx, mz, 'parapet');
        const nx = ((p.rx + q.rx) / 2) * side, nz = ((p.rz + q.rz) / 2) * side;
        const H = G.parapetHeight;
        chunks.tag('parapet');
        buf.wall(ix0, iz0, ix1, iz1, hp, hp + H, hq, hq + H, shade(pCol, 0.94), -nx, -nz);
        buf.wall(ox0, oz0, ox1, oz1, hp - 0.2, hp + H, hq - 0.2, hq + H, pCol, nx, nz);
        buf.quad(ix0, hp + H, iz0, ox0, hp + H, oz0, ox1, hq + H, oz1, ix1, hq + H, iz1, COL.coping, 0, 1, 0);
        pb.quad(ix0, hp, iz0, ix1, hq, iz1, ix1, hq + H, iz1, ix0, hp + H, iz0);
        pb.quad(ix0, hp + H, iz0, ox0, hp + H, oz0, ox1, hq + H, oz1, ix1, hq + H, iz1);
        pb.quad(ox0, hp - 0.2, oz0, ox1, hq - 0.2, oz1, ox1, hq + H, oz1, ox0, hp + H, oz0);
        if (style === 'steel') {
          // girder fascia below the deck
          const th = G.deckThickness + 0.3;
          chunks.tag('overhead'); // girder fascia under the freeway deck
          buf.wall(ox0 + nx * 0.05, oz0 + nz * 0.05, ox1 + nx * 0.05, oz1 + nz * 0.05, hp - base - th - 0.5, hp - base - 0.25, hq - base - th - 0.5, hq - base - 0.25, COL.steel, nx, nz);
        }
      }
      // lamps on sidewalks (and along the freeway)
      if (sw || e.freeway) {
        const spacing = e.freeway ? 46 : LAMP_SPACING;
        const off = side > 0 ? 0 : spacing / 2;
        for (let s = s0 + 8 + off; s < s1 - 6; s += spacing) {
          if (e.freeway && side < 0) continue;
          const q = pointAtS(e, s);
          // on a sidewalk, or on top of the freeway's parapet (inside it they stood in the kerbside lane)
          const o = e.freeway ? outer - PARAPET_T / 2 : outer - PARAPET_T - 0.35;
          lamps.push({ x: q.x - q.uz * o * side, y: net.profAt(e, s) + base, z: q.z + q.ux * o * side, ax: q.uz * side, az: -q.ux * side });
        }
      }
    }
    // ---- abutments: close the deck ends down to the ground
    for (const [s, dir] of [[s0, -1], [s1, 1]] as [number, number][]) {
      const q = pointAtS(e, s);
      const y = net.profAt(e, s) - G.deckThickness;
      const W2a = e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0);
      const ax = q.x - q.uz * W2a, az = q.z + q.ux * W2a, bx = q.x + q.uz * W2a, bz = q.z - q.ux * W2a;
      const g = Math.min(ras.heightAt(ax, az), ras.heightAt(bx, bz), ras.heightAt(q.x, q.z)) - 1.5;
      if (y - g < 0.3) continue;
      const buf = chunks.buf('ground', q.x, q.z);
      chunks.tag('bridgePier');
      buf.wall(ax, az, bx, bz, g, y + 0.05, g, y + 0.05, shade(pCol, 0.85), -q.ux * dir, -q.uz * dir);
      buf.wall(ax, az, bx, bz, g, y + 0.05, g, y + 0.05, shade(pCol, 0.85), q.ux * dir, q.uz * dir);
      phys.trimesh(q.x, q.z, 'bridgePier').quad(ax, g, az, bx, g, bz, bx, y + 0.05, bz, ax, y + 0.05, az);
    }
    // ---- supports
    if (style === 'short') continue;
    const th = G.deckThickness + (e.freeway ? 0.3 : 0);
    const W2 = e.hw + (e.swL || e.swR ? G.sidewalkWidth : 0);
    const colOff = W2 - (style === 'steel' ? 1.2 : 1.6); // column pairs stand this far either side of the centre line
    const canPier = (s: number) => {
      const q = pointAtS(e, s);
      const y = net.profAt(e, s);
      for (const o of [-W2 * 0.8, 0, W2 * 0.8]) {
        const x = q.x - q.uz * o, z = q.z + q.ux * o;
        const bd = ras.bandAt(x, z), kd = ras.kindAt(x, z);
        if (bd === B.ROAD || bd === B.HOLE) return false;
        if (style !== 'arch' && (kd & K.WATER)) return false;
        if (y - ras.heightAt(x, z) < 3) return false;
      }
      // a column (and a car's width round it) must not stand in a carriageway below (Water St under the freeway)
      if (style !== 'arch') {
        for (const sd of [-1, 1]) for (const a of [-G.columnRoadClear, 0, G.columnRoadClear]) for (const l of [-G.columnRoadClear, 0, G.columnRoadClear]) {
          const o = colOff * sd + l;
          if (ras.bandAt(q.x - q.uz * o + q.ux * a, q.z + q.ux * o + q.uz * a) === B.ROAD) return false;
        }
      }
      return true;
    };
    const spacing = style === 'arch' ? (isKey ? 52 : 34) : style === 'steel' ? 30 : 32;
    const piers: number[] = [];
    let last = s0 + 4;
    for (let target = s0 + spacing * 0.6; target < s1 - 8; target += spacing) {
      let found = -1;
      for (let d = 0; d < spacing * 0.45; d += 2) {
        if (target + d < s1 - 8 && target + d > last + 12 && canPier(target + d)) { found = target + d; break; }
        if (target - d > last + 12 && canPier(target - d)) { found = target - d; break; }
      }
      if (found > 0) { piers.push(found); last = found; target = found; }
    }
    const groundAt = (x: number, z: number) => {
      const k = ras.kindAt(x, z);
      return k & K.WATER ? Math.min(ras.heightAt(x, z), W.levelAt(x, z) - 1.5) : ras.heightAt(x, z);
    };
    if (style === 'arch') {
      // wall piers + full-width arches between consecutive supports (abutments at the deck ends)
      const sup = [s0 + 1, ...piers, s1 - 1];
      for (const s of piers) {
        const q = pointAtS(e, s);
        const y = net.profAt(e, s) - th;
        const g = Math.min(groundAt(q.x, q.z), groundAt(q.x - q.uz * W2, q.z + q.ux * W2), groundAt(q.x + q.uz * W2, q.z - q.ux * W2)) - 0.6;
        const buf = chunks.buf('ground', q.x, q.z);
        chunks.tag('bridgePier');
        buf.obox(q.x, g, q.z, 2.2, W2 + 0.6, y, q.ux, q.uz, shade(pCol, 0.9), shade(pCol, 0.85));
        // cutwater noses
        buf.obox(q.x, g, q.z, 2.6, W2 + 1.4, Math.min(y, g + 4), q.ux, q.uz, shade(pCol, 0.8));
        phys.box(q.x, (g + y) / 2, q.z, 2.2, (y - g) / 2, W2 + 0.6, q.ux, q.uz, 'bridgePier');
        phys.box(q.x, g + Math.min(y - g, 4) / 2, q.z, 2.6, Math.min(y - g, 4) / 2, W2 + 1.4, q.ux, q.uz, 'bridgePier');
      }
      for (let i = 1; i < sup.length; i++) {
        const sa = sup[i - 1] + (i > 1 ? 2.2 : 0), sb = sup[i] - (i < sup.length - 1 ? 2.2 : 0);
        if (sb - sa < 8) continue;
        const qa = pointAtS(e, sa), qb = pointAtS(e, sb);
        const ya = net.profAt(e, sa) - th, yb = net.profAt(e, sb) - th;
        const ga = groundAt(qa.x, qa.z), gb = groundAt(qb.x, qb.z);
        const spring = Math.max(ga, gb, W.levelAt(qa.x, qa.z)) + 1.2;
        const crown = Math.min(ya, yb) - 0.7;
        if (crown - spring < 1.5) continue;
        const n = 14;
        let prev: number[] | null = null;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const s = lerp(sa, sb, t);
          const q = pointAtS(e, s);
          const deckB = net.profAt(e, s) - th;
          const ya2 = spring + (crown - spring) * Math.pow(Math.sin(Math.PI * t), 0.55);
          const cur = [q.x - q.uz * W2, q.z + q.ux * W2, q.x + q.uz * W2, q.z - q.ux * W2, ya2, deckB, q.x, q.z];
          if (prev) {
            const buf = chunks.buf('ground', (prev[6] + cur[6]) / 2, (prev[7] + cur[7]) / 2);
            chunks.tag('bridgePier');
            // intrados (underside of the arch)
            buf.quad(prev[0], prev[4], prev[1], prev[2], prev[4], prev[3], cur[2], cur[4], cur[3], cur[0], cur[4], cur[1], shade(pCol, 0.78), 0, -1, 0);
            // the arch is solid: its underside and both spandrel faces collide (people walk under Key Bridge)
            const pa = phys.trimesh((prev[6] + cur[6]) / 2, (prev[7] + cur[7]) / 2, 'bridgePier');
            pa.quad(prev[0], prev[4], prev[1], prev[2], prev[4], prev[3], cur[2], cur[4], cur[3], cur[0], cur[4], cur[1]);
            // spandrel walls both sides
            for (const sd of [0, 2]) {
              const nx = sd === 0 ? -q.uz : q.uz, nz = sd === 0 ? q.ux : -q.ux;
              buf.wall(prev[sd], prev[sd + 1], cur[sd], cur[sd + 1], prev[4], prev[5], cur[4], cur[5], pCol, nx, nz);
              pa.quad(prev[sd], prev[4], prev[sd + 1], cur[sd], cur[4], cur[sd + 1], cur[sd], cur[5], cur[sd + 1], prev[sd], prev[5], prev[sd + 1]);
            }
          }
          prev = cur;
        }
      }
      // land-side abutment walls under the ends of arch bridges
    } else {
      // columns (pairs) with a cap beam
      for (const s of piers) {
        const q = pointAtS(e, s);
        const y = net.profAt(e, s) - th;
        const rx = -q.uz, rz = q.ux;
        const off = colOff;
        const cap = style === 'steel' ? COL.steel : COL.concreteDark;
        const buf = chunks.buf('ground', q.x, q.z);
        chunks.tag('column');
        for (const sd of [-1, 1]) {
          const cx = q.x + rx * off * sd, cz = q.z + rz * off * sd;
          const g = groundAt(cx, cz) - 0.4;
          if (style === 'steel') buf.obox(cx, g, cz, 0.45, 0.45, y - 0.9, q.ux, q.uz, COL.steel, COL.steelDark);
          else buf.cyl(cx, g, cz, 0.75, 0.7, y - 0.9 - g, 10, COL.concrete);
          if (style === 'steel') phys.box(cx, (g + y - 0.9) / 2, cz, 0.45, (y - 0.9 - g) / 2, 0.45, q.ux, q.uz, 'column');
          else phys.cylinder(cx, g, cz, 0.75, y - 0.9 - g, 'column');
        }
        chunks.tag('overhead'); // cap beam under the deck
        buf.obox(q.x, y - 1.0, q.z, 0.8, off + 0.9, y, q.ux, q.uz, cap, shade(cap, 0.9));
      }
    }
  }
  return { lamps };
}

// ======================================================================================================
/** Stairs: steep flights with landings (the Exorcist Steps) or a single flight (canal steps); ramp into the raster. */
export function rasterizeStairs(doc: GeoDoc, ras: GeoRaster, streetY: (x: number, z: number) => number): StairPlan[] {
  const plans: StairPlan[] = [];
  for (const f of doc.footways) {
    if (f.kind !== 'steps' || f.pts.length < 2) continue;
    const trim = trimOutOfRoads(f.pts.map((p) => [p[0], p[1]] as Pt), ras);
    if (!trim) continue;
    const pts = trim.pts;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    const big = !!f.name;
    // an end cut back to a sidewalk meets that sidewalk's own surface (the raster blends there)
    const endY = (p: Pt, cut: boolean) => { const y = cut ? streetY(p[0], p[1]) : NaN; return y === y ? y : ras.workAt(p[0], p[1]); };
    const ha = endY(pts[0], trim.cutA), hb = endY(pts[pts.length - 1], trim.cutB);
    // flights: rise at ~32 degrees, starting at the low end (so the steps rise straight from the street)
    const lowFirst = ha <= hb;
    const h0 = Math.min(ha, hb), h1 = Math.max(ha, hb);
    const rise = h1 - h0;
    const slope = 0.62;
    const nFlights = big ? 3 : 1;
    const landing = big ? 2.4 : 0;
    const run = rise / slope;
    const total = Math.min(L - 1, run + landing * (nFlights - 1));
    const startS = big ? 0.6 : Math.max(0.3, (L - total) / 2);
    const flights: [number, number][] = [];
    let s = startS;
    for (let k = 0; k < nFlights; k++) {
      const fr = Math.min(run / nFlights, L - s);
      flights.push([s, s + fr]);
      s += fr + landing;
    }
    // ramp profile measured from the low end. On a flight the ramp runs half a riser above the line through the
    // risers' feet (so it cuts through the middle of each drawn tread: feet sink or float at most half a riser),
    // capped at the flight's top; the half-riser lip at the foot of each flight is under the character's autostep.
    const slopeK = rise / Math.max(0.01, flights.reduce((t, q) => t + q[1] - q[0], 0));
    const lip = STAIR_RISER / 2;
    const hLow = (u: number) => {
      let h = h0;
      for (const [a, b] of flights) {
        if (u <= a) break;
        const top = h + (b - a) * slopeK;
        h += (Math.min(u, b) - a) * slopeK;
        if (u < b) return Math.min(h1, top, h + lip);
      }
      return Math.min(h1, h);
    };
    const hAt = (sv: number) => hLow(lowFirst ? sv : L - sv);
    const plan: StairPlan = { pts, w: big ? 3.6 : 2.2, cum, L, h: hAt, flights: lowFirst ? flights : flights.map(([a, b]) => [L - b, L - a] as [number, number]).reverse(), name: f.name };
    plans.push(plan);
    // raster
    const h = ras.h!, band = ras.band, k = ras.k;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const segL = cum[i] - cum[i - 1];
      ras.forSegment(a[0], a[1], b[0], b[1], plan.w / 2 + (big ? 0.6 : 0.2), (o, _d, t) => {
        if (band[o] === B.ROAD) return;
        h[o] = hAt(cum[i - 1] + t * segL);
        if (band[o] !== B.HOLE) band[o] = B.FLAT;
        k[o] = (k[o] & ~(K.PARK | K.WATER)) | K.WALK;
      });
    }
  }
  return plans;
}

export function buildStairs(plans: StairPlan[], chunks: RenderChunks, phys: PhysChunks) {
  for (const st of plans) {
    const { pts, cum, w } = st;
    const big = !!st.name;
    const hLow = Math.min(st.h(0), st.h(st.L)); // the stair's foot (the towpath for the canal steps)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const segL = cum[i] - cum[i - 1];
      if (segL < 0.05) continue;
      const ux = (b[0] - a[0]) / segL, uz = (b[1] - a[1]) / segL;
      const rx = -uz * (w / 2), rz = ux * (w / 2);
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const buf = chunks.buf('ground', mx, mz);
      const pb = phys.trimesh(mx, mz, 'stair');
      const pw = phys.trimesh(mx, mz, 'stairWall');
      // sample the ramp every 0.5 m: physics = smooth ramp; visuals = steps on flights, flat on landings
      const n = Math.max(1, Math.ceil(segL / 0.5));
      for (let k = 0; k < n; k++) {
        const s0 = cum[i - 1] + (segL * k) / n, s1 = cum[i - 1] + (segL * (k + 1)) / n;
        const p0x = a[0] + ux * (s0 - cum[i - 1]), p0z = a[1] + uz * (s0 - cum[i - 1]);
        const p1x = a[0] + ux * (s1 - cum[i - 1]), p1z = a[1] + uz * (s1 - cum[i - 1]);
        const h0 = st.h(s0), h1 = st.h(s1);
        pb.quad(p0x - rx, h0, p0z - rz, p0x + rx, h0, p0z + rz, p1x + rx, h1, p1z + rz, p1x - rx, h1, p1z - rz);
        // landings and the flat run-in / run-out: paved like the treads (only the flights get steps)
        chunks.tag('stair');
        let f0 = s0;
        for (const [fa, fb] of [...st.flights, [Infinity, Infinity] as [number, number]]) {
          const g0 = f0, g1 = Math.min(s1, fa);
          if (g1 - g0 > 0.01) {
            const q0x = a[0] + ux * (g0 - cum[i - 1]), q0z = a[1] + uz * (g0 - cum[i - 1]);
            const q1x = a[0] + ux * (g1 - cum[i - 1]), q1z = a[1] + uz * (g1 - cum[i - 1]);
            const y0 = st.h(g0), y1 = st.h(g1);
            buf.quad(q0x - rx, y0, q0z - rz, q0x + rx, y0, q0z + rz, q1x + rx, y1, q1z + rz, q1x - rx, y1, q1z - rz, shade(COL.step, 0.97), 0, 1, 0);
          }
          f0 = Math.max(f0, fb);
          if (f0 >= s1) break;
        }
        // side walls (render + physics) keep people on the stair, once it has risen above its foot: on the flat
        // run-in at the bottom they stood across the towpath under every street bridge and blocked it
        if (Math.max(h0, h1) < hLow + G.stairWallFrom) continue;
        chunks.tag('stairWall');
        for (const sd of [-1, 1]) {
          const wx0 = p0x + rx * sd * 1.08, wz0 = p0z + rz * sd * 1.08, wx1 = p1x + rx * sd * 1.08, wz1 = p1z + rz * sd * 1.08;
          const top = big ? 1.1 : 0.9;
          buf.wall(wx0, wz0, wx1, wz1, h0 - 1.6, h0 + top, h1 - 1.6, h1 + top, COL.stone, -rx * sd, -rz * sd);
          buf.wall(wx0 + rx * sd * 0.3, wz0 + rz * sd * 0.3, wx1 + rx * sd * 0.3, wz1 + rz * sd * 0.3, h0 - 1.6, h0 + top, h1 - 1.6, h1 + top, COL.stoneDark, rx * sd, rz * sd);
          buf.quad(wx0, h0 + top, wz0, wx0 + rx * sd * 0.3, h0 + top, wz0 + rz * sd * 0.3, wx1 + rx * sd * 0.3, h1 + top, wz1 + rz * sd * 0.3, wx1, h1 + top, wz1, COL.coping, 0, 1, 0);
          const ox0 = wx0 + rx * sd * 0.3, oz0 = wz0 + rz * sd * 0.3, ox1 = wx1 + rx * sd * 0.3, oz1 = wz1 + rz * sd * 0.3;
          pw.quad(wx0, h0 - 0.5, wz0, wx1, h1 - 0.5, wz1, wx1, h1 + top, wz1, wx0, h0 + top, wz0);
          pw.quad(wx0, h0 + top, wz0, ox0, h0 + top, oz0, ox1, h1 + top, oz1, wx1, h1 + top, wz1);
          pw.quad(ox0, h0 - 1.6, oz0, ox1, h1 - 1.6, oz1, ox1, h1 + top, oz1, ox0, h0 + top, oz0);
        }
      }
      // steps: risers of ~0.17 m on the flights
      for (const [fa, fb] of st.flights) {
        const a0 = Math.max(fa, cum[i - 1]), b0 = Math.min(fb, cum[i]);
        if (b0 - a0 < 0.1) continue;
        const hA = st.h(a0), hB = st.h(b0);
        const nSteps = Math.max(1, Math.round(Math.abs(hB - hA) / STAIR_RISER));
        chunks.tag('stair');
        for (let k = 0; k < nSteps; k++) {
          const t0 = k / nSteps, t1 = (k + 1) / nSteps;
          const s0 = lerp(a0, b0, t0), s1 = lerp(a0, b0, t1);
          const y = hA < hB ? lerp(hA, hB, t1) : lerp(hA, hB, t0);
          const x0 = a[0] + ux * (s0 - cum[i - 1]), z0 = a[1] + uz * (s0 - cum[i - 1]);
          const x1 = a[0] + ux * (s1 - cum[i - 1]), z1 = a[1] + uz * (s1 - cum[i - 1]);
          const c = (k & 1) ? COL.step : shade(COL.step, 0.94);
          buf.quad(x0 - rx, y, z0 - rz, x0 + rx, y, z0 + rz, x1 + rx, y, z1 + rz, x1 - rx, y, z1 - rz, c, 0, 1, 0);
          // riser at the lower edge of the tread
          const ex = hA < hB ? x0 : x1, ez = hA < hB ? z0 : z1;
          const fx = hA < hB ? -ux : ux, fz = hA < hB ? -uz : uz;
          buf.wall(ex - rx, ez - rz, ex + rx, ez + rz, y - 0.19, y, y - 0.19, y, shade(c, 0.8), fx, fz);
        }
        // a hand rail down the middle of the big stair
        if (big) {
          chunks.tag('railing');
          const x0 = a[0] + ux * (a0 - cum[i - 1]), z0 = a[1] + uz * (a0 - cum[i - 1]);
          const x1 = a[0] + ux * (b0 - cum[i - 1]), z1 = a[1] + uz * (b0 - cum[i - 1]);
          buf.quad(x0 - uz * 0.03, hA + 0.95, z0 + ux * 0.03, x0 + uz * 0.03, hA + 0.95, z0 - ux * 0.03, x1 + uz * 0.03, hB + 0.95, z1 - ux * 0.03, x1 - uz * 0.03, hB + 0.95, z1 + ux * 0.03, COL.rail, 0, 1, 0);
          for (const t of [0.02, 0.5, 0.98]) {
            const px = lerp(x0, x1, t), pz = lerp(z0, z1, t), py = lerp(hA, hB, t);
            buf.obox(px, py, pz, 0.04, 0.04, py + 0.95, ux, uz, COL.rail);
          }
          // a thin slab under the rail keeps people to one side of it
          const hr: number[] = [];
          for (const o of [-0.04, 0.04]) hr.push(x0 - uz * o, hA + 0.95, z0 + ux * o, x1 - uz * o, hB + 0.95, z1 + ux * o, x1 - uz * o, hB - 0.2, z1 + ux * o, x0 - uz * o, hA - 0.2, z0 + ux * o);
          phys.hull(hr, 'railing');
        }
      }
    }
  }
  void clamp;
}

/**
 * The part of a stair line outside streets: the map data sometimes runs a stair's end into the street it climbs to,
 * and the carriageway or sidewalk surface (drawn and collided at the street's own height) then covered the top steps
 * (a 1 m ledge over the ramp). The stair now ends where the sidewalk starts. Null if nothing is left.
 */
function trimOutOfRoads(pts: Pt[], ras: GeoRaster): { pts: Pt[]; cutA: boolean; cutB: boolean } | null {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (s: number): Pt => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const road = (s: number) => { const p = at(s); const b = ras.bandAt(p[0], p[1]); return b === B.ROAD || b === B.FLAT; };
  let s0 = 0, s1 = L;
  while (s0 < L && road(s0)) s0 += 0.25;
  while (s1 > s0 && road(s1)) s1 -= 0.25;
  if (s1 - s0 < 2) return null;
  if (s0 === 0 && s1 === L) return { pts, cutA: false, cutB: false };
  const out: Pt[] = [at(s0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(at(s1));
  return { pts: out, cutA: s0 > 0, cutB: s1 < L };
}

export type { REdge };
