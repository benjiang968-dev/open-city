// Monuments of the Georgetown world that are not buildings: the equestrian statue on its plinth in Washington
// Circle, the cemetery gateway and railings on R St, and the metro entrance (an escalator pit under a glass barrel
// canopy and a plain pylon; no transit logo).
import type { GeoDoc } from './geoDoc';
import { clamp, project } from './geoDoc';
import { lin, shade, type PhysChunks, type RenderChunks } from './meshKit';
import { K, type GeoRaster } from './terrain';

export function buildMonuments(doc: GeoDoc, ras: GeoRaster, chunks: RenderChunks, phys: PhysChunks) {
  const at = (lat: number, lon: number) => project(doc, lat, lon);
  // ---- Washington Circle statue (spec landmark position)
  {
    const [x, z] = at(38.9025, -77.0505);
    const y = ras.heightAt(x, z);
    const g = chunks.buf('ground', x, z);
    const granite = lin(0xb8b3a8), marble = lin(0xd9d4c8), bronze = lin(0x4f5f52), bronzeD = lin(0x3c4a40);
    g.box(x - 4.5, y - 0.5, z - 3.2, x + 4.5, y + 0.5, z + 3.2, granite);
    g.box(x - 3.6, y + 0.5, z - 2.4, x + 3.6, y + 1.0, z + 2.4, shade(granite, 1.05));
    g.box(x - 2.8, y + 1.0, z - 1.6, x + 2.8, y + 4.4, z + 1.6, marble);
    g.box(x - 3.1, y + 4.4, z - 1.9, x + 3.1, y + 4.8, z + 1.9, granite);
    phys.box(x, y + 2.4, z, 4.5, 2.4, 3.2);
    const t = y + 4.8;
    // horse facing east: body, legs, neck, head, tail; the rider with a raised arm
    g.box(x - 1.4, t + 1.3, z - 0.45, x + 1.3, t + 2.4, z + 0.45, bronze, bronzeD);
    for (const [lx, lz] of [[-1.1, -0.3], [-1.1, 0.3], [0.95, -0.3], [0.95, 0.3]]) g.box(x + lx - 0.13, t, z + lz - 0.12, x + lx + 0.13, t + 1.4, z + lz + 0.12, bronzeD);
    g.obox(x + 1.55, t + 2.0, z, 0.45, 0.3, t + 3.1, 0.8, 0.6, bronze, bronzeD);
    g.obox(x + 2.05, t + 2.75, z, 0.5, 0.22, t + 3.15, 1, 0, bronze, bronzeD);
    g.obox(x - 1.6, t + 1.2, z, 0.25, 0.12, t + 2.2, 1, 0, bronzeD);
    g.box(x - 0.45, t + 2.4, z - 0.32, x + 0.25, t + 3.55, z + 0.32, bronze, bronzeD);
    g.box(x - 0.3, t + 3.55, z - 0.17, x + 0.05, t + 3.95, z + 0.17, bronze, bronzeD);
    g.box(x - 0.35, t + 3.95, z - 0.22, x + 0.1, t + 4.05, z + 0.22, bronzeD);
    g.box(x - 0.08, t + 3.2, z + 0.3, x + 0.08, t + 4.4, z + 0.45, bronze);
    for (const s of [-1, 1]) g.box(x - 0.35, t + 1.6, z + s * 0.48 - 0.1, x + 0.2, t + 2.6, z + s * 0.48 + 0.1, bronzeD);
  }
  // ---- cemetery gateway and iron railings along the side facing R St
  const cem = doc.parks.find((p) => p.kind === 'landuse=cemetery');
  if (cem) {
    const [gx] = at(38.9131, -77.0592);
    const P = cem.pts;
    let best = 0, bz = -Infinity;
    for (let i = 0; i < P.length; i++) { const q = P[(i + 1) % P.length]; const mz = (P[i][1] + q[1]) / 2; if (mz > bz) { bz = mz; best = i; } }
    const a = P[best], b = P[(best + 1) % P.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    const tGate = clamp((gx - a[0]) * ux + 0, 4, L - 4);
    const iron = lin(0x24272a), stone = lin(0xa69f92);
    for (let s = 0; s < L; s += 2.4) {
      if (Math.abs(s - tGate) < 3.2) continue;
      const x = a[0] + ux * s, z = a[1] + uz * s;
      const y = ras.heightAt(x, z);
      chunks.buf('detail', x, z).obox(x, y, z, 0.04, 0.04, y + 1.8, ux, uz, iron);
      const s1 = Math.min(L, s + 2.4);
      if (Math.abs((s + s1) / 2 - tGate) < 4.4) continue;
      const mx = a[0] + (ux * (s + s1)) / 2, mz = a[1] + (uz * (s + s1)) / 2;
      const ym = ras.heightAt(mx, mz);
      for (const h of [0.35, 1.55]) chunks.buf('detail', mx, mz).obox(mx, ym + h, mz, (s1 - s) / 2, 0.03, ym + h + 0.06, ux, uz, iron);
    }
    for (const [s0, s1] of [[0, tGate - 3.2], [tGate + 3.2, L]]) {
      if (s1 - s0 < 1) continue;
      const mx = a[0] + (ux * (s0 + s1)) / 2, mz = a[1] + (uz * (s0 + s1)) / 2;
      phys.box(mx, ras.heightAt(mx, mz) + 0.9, mz, (s1 - s0) / 2, 0.9, 0.05, ux, uz);
    }
    const x = a[0] + ux * tGate, z = a[1] + uz * tGate, y = ras.heightAt(x, z);
    const g = chunks.buf('ground', x, z);
    for (const sd of [-1, 1]) {
      const px = x + ux * 2.8 * sd, pz = z + uz * 2.8 * sd;
      g.obox(px, y - 0.3, pz, 0.6, 0.6, y + 4.2, ux, uz, stone, shade(stone, 0.9));
      g.pyramid(px, y + 4.2, pz, 0.7, 0.9, ux, uz, shade(stone, 0.85));
      phys.box(px, y + 2, pz, 0.6, 2.2, 0.6, ux, uz);
    }
    g.obox(x, y + 3.5, z, 3.4, 0.45, y + 4.1, ux, uz, stone, shade(stone, 0.9));
    for (const sd of [-1, 1]) {
      const hx = x + ux * 2.2 * sd, hz = z + uz * 2.2 * sd;
      chunks.buf('detail', hx, hz).obox(hx - uz * 1.0, y, hz + ux * 1.0, 0.04, 1.0, y + 2.6, ux, uz, iron);
    }
  }
  // ---- metro entrance: pit, parapets, glass barrel canopy, pylon (long axis north-south, along 23rd St)
  {
    const [x, z] = at(38.90092, -77.05027);
    const y = ras.heightAt(x, z);
    const g = chunks.buf('ground', x, z);
    const dec = chunks.buf('decal', x, z);
    const granite = lin(0x8f8b85), steel = lin(0x5b6166), glass = lin(0x9fb4bf);
    dec.quad(x - 2.4, y + 0.02, z - 6, x + 2.4, y + 0.02, z - 6, x + 2.4, y + 0.02, z + 6, x - 2.4, y + 0.02, z + 6, lin(0x2b2d30), 0, 1, 0);
    for (let k = 0; k < 10; k++) dec.quad(x - 2.2, y + 0.03, z - 5 + k, x + 2.2, y + 0.03, z - 5 + k, x + 2.2, y + 0.03, z - 4.85 + k, x - 2.2, y + 0.03, z - 4.85 + k, lin(0x55585c), 0, 1, 0);
    for (const sd of [-1, 1]) {
      g.box(x + sd * 2.4 - 0.25, y, z - 6, x + sd * 2.4 + 0.25, y + 1.0, z + 6, granite);
      phys.box(x + sd * 2.4, y + 0.5, z, 0.25, 0.5, 6);
    }
    g.box(x - 2.65, y, z + 6, x + 2.65, y + 1.0, z + 6.5, granite);
    phys.box(x, y + 0.5, z + 6.25, 2.65, 0.5, 0.25);
    const n = 8, R = 2.6, top = y + 1.0;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI, a1 = ((k + 1) / n) * Math.PI;
      const x0 = x + Math.cos(a0) * R, y0 = top + Math.sin(a0) * R * 0.9, x1 = x + Math.cos(a1) * R, y1 = top + Math.sin(a1) * R * 0.9;
      g.quad(x0, y0, z - 6, x1, y1, z - 6, x1, y1, z + 6, x0, y0, z + 6, glass, (Math.cos(a0) + Math.cos(a1)) / 2, (Math.sin(a0) + Math.sin(a1)) / 2, 0);
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      for (const zz of [-6, -3, 0, 3, 6]) g.obox((x0 + x1) / 2, (y0 + y1) / 2 - 0.06, z + zz, len / 2, 0.06, (y0 + y1) / 2 + 0.06, (x1 - x0) / len, 0, steel);
    }
    const px = x + 3.6, pz = z - 7.5;
    g.box(px - 0.35, y, pz - 0.35, px + 0.35, y + 4.2, pz + 0.35, lin(0x4a3b30));
    g.box(px - 0.37, y + 3.4, pz - 0.37, px + 0.37, y + 3.9, pz + 0.37, lin(0xf2eee2));
    phys.box(px, y + 2.1, pz, 0.35, 2.1, 0.35);
    const k = ras.k;
    ras.fillQuad(x - 2.6, z - 6, x + 2.6, z - 6, x + 2.6, z + 6.5, x - 2.6, z + 6.5, (o) => { k[o] |= K.WALL; });
  }
}
