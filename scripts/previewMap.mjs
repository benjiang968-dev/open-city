#!/usr/bin/env node
// Top-down preview of the game map data (src/data/georgetown.json, from importOsm.mjs or georgetownFromSpec.mjs).
//
//   node scripts/previewMap.mjs [map.json] [--out <png>] [--svg <svg>] [--width <px>]
//   npm run preview-map
//
// Writes an SVG (default screenshots/24-map-preview.svg) and renders it with Playwright's Chromium to a PNG (default
// screenshots/24-map-preview.png, 2400 px wide): terrain tint, hill shading and 5 m contours from the heightfield,
// water, parks, hatched car parks, plazas, footways, roads (width by lanes, bridges cased, tunnels dashed) with street
// names and one-way arrows, buildings by type, trees and POI dots by category, plus a legend and scale bar.
// Plain Node ESM; Playwright is loaded with createRequire (installed globally in this environment).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as zlib from 'node:zlib';

const args = { map: 'src/data/georgetown.json', out: 'screenshots/24-map-preview.png', svg: 'screenshots/24-map-preview.svg', width: 2400 };
{
  const argv = process.argv.slice(2);
  let pos = 0;
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    const val = () => argv[++i];
    if (s === '--out') args.out = val();
    else if (s === '--svg') args.svg = val();
    else if (s === '--width') args.width = Number(val()) || 2400;
    else if (s === '-h' || s === '--help') {
      console.log('node scripts/previewMap.mjs [map.json] [--out png] [--svg svg] [--width px]');
      process.exit(0);
    } else if (!s.startsWith('-') && pos++ === 0) args.map = s;
    else {
      console.error(`previewMap: unexpected argument ${s}`);
      process.exit(1);
    }
  }
}

const doc = JSON.parse(readFileSync(args.map, 'utf8'));
// real data: places and CC BY 4.0 footprints live in companion files next to the main file (their own licences)
if (doc.meta?.companions) {
  const near = (f) => JSON.parse(readFileSync(join(dirname(args.map), f), 'utf8'));
  doc.pois = near(doc.meta.companions.pois).pois;
  doc.buildings = doc.buildings.concat(near(doc.meta.companions.buildings).buildings);
}
const B = doc.meta.bounds;
const W = B.x1 - B.x0, H = B.z1 - B.z0;
const k = args.width / W; // px per metre
const PW = args.width, PH = Math.round(H * k);
// Legend box (px): over the river, east of Key Bridge on the Georgetown map.
const LEGEND = { w: 600, h: 312, x: Math.round(PW * 0.163) };
LEGEND.y = PH - LEGEND.h - 16;
const X = (x) => ((x - B.x0) * k).toFixed(1);
const Y = (z) => ((z - B.z0) * k).toFixed(1);
const pathOf = (pts, close = false) => `M${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join('L')}${close ? 'Z' : ''}`;
const polyPath = (e) => [e.pts, ...(e.holes ?? [])].map((r) => pathOf(r, true)).join('');
const inRing = (x, z, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const segDist = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)) : 0;
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dz - z);
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------------------------------- terrain raster
function terrainImage() {
  const h = doc.heights;
  if (!h?.data?.length) return '';
  const S = 4; // upsampling factor
  const w = (h.nx - 1) * S + 1, ht = (h.nz - 1) * S + 1;
  const at = (ix, iz) => h.data[Math.min(h.nz - 1, Math.max(0, iz)) * h.nx + Math.min(h.nx - 1, Math.max(0, ix))];
  const sample = (fx, fz) => {
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    return (at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx) * (1 - tz) + (at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx) * tz;
  };
  const ramp = [[-2, [196, 214, 190]], [0, [214, 228, 196]], [10, [226, 233, 199]], [25, [236, 229, 196]], [40, [233, 216, 178]], [55, [222, 199, 160]], [70, [208, 182, 143]]];
  const tint = (v) => {
    for (let i = 1; i < ramp.length; i++) {
      if (v <= ramp[i][0]) {
        const t = Math.max(0, (v - ramp[i - 1][0]) / (ramp[i][0] - ramp[i - 1][0]));
        return ramp[i - 1][1].map((c, j) => c + (ramp[i][1][j] - c) * t);
      }
    }
    return ramp[ramp.length - 1][1];
  };
  const rgba = Buffer.alloc(w * ht * 4);
  const cell = h.spacing / S;
  for (let pz = 0; pz < ht; pz++) {
    for (let px = 0; px < w; px++) {
      const fx = px / S, fz = pz / S;
      const v = sample(fx, fz);
      const dx = (sample(fx + 0.5, fz) - sample(fx - 0.5, fz)) / (h.spacing);
      const dz = (sample(fx, fz + 0.5) - sample(fx, fz - 0.5)) / (h.spacing);
      // Light from the north-west, exaggerated 3x so a 10% street grade reads.
      const nx = -dx * 3, nz = -dz * 3, ny = 1;
      const L = Math.hypot(nx, ny, nz);
      const lx = -0.5, ly = 0.75, lz = -0.43;
      const shade = Math.max(0.55, Math.min(1.12, 0.35 + 0.75 * ((nx * lx + ny * ly + nz * lz) / L)));
      const c = tint(v);
      const o = (pz * w + px) * 4;
      rgba[o] = Math.min(255, c[0] * shade);
      rgba[o + 1] = Math.min(255, c[1] * shade);
      rgba[o + 2] = Math.min(255, c[2] * shade);
      rgba[o + 3] = 255;
    }
  }
  void cell;
  const png = encodePng(w, ht, rgba);
  const ex = h.x0 + (h.nx - 1) * h.spacing, ez = h.z0 + (h.nz - 1) * h.spacing;
  return `<image x="${X(h.x0)}" y="${Y(h.z0)}" width="${((ex - h.x0) * k).toFixed(1)}" height="${((ez - h.z0) * k).toFixed(1)}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString('base64')}"/>`;
}
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k2 = 0; k2 < 8; k2++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------- contours
function contours(interval) {
  const h = doc.heights;
  if (!h?.data?.length) return { minor: '', major: '' };
  const minor = [], major = [];
  const v = (ix, iz) => h.data[iz * h.nx + ix];
  const xs = (ix) => h.x0 + ix * h.spacing, zs = (iz) => h.z0 + iz * h.spacing;
  const lo = Math.ceil(h.data.reduce((a, b) => Math.min(a, b)) / interval) * interval, hi = h.data.reduce((a, b) => Math.max(a, b));
  for (let level = Math.max(interval, lo); level <= hi; level += interval) {
    const out = level % (interval * 5) === 0 ? major : minor;
    for (let iz = 0; iz < h.nz - 1; iz++) {
      for (let ix = 0; ix < h.nx - 1; ix++) {
        const a = v(ix, iz), b = v(ix + 1, iz), c = v(ix + 1, iz + 1), d = v(ix, iz + 1);
        const pts = [];
        const edge = (p, q, x0, z0, x1, z1) => {
          if ((p < level) !== (q < level)) {
            const t = (level - p) / (q - p);
            pts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
          }
        };
        edge(a, b, xs(ix), zs(iz), xs(ix + 1), zs(iz));
        edge(b, c, xs(ix + 1), zs(iz), xs(ix + 1), zs(iz + 1));
        edge(c, d, xs(ix + 1), zs(iz + 1), xs(ix), zs(iz + 1));
        edge(d, a, xs(ix), zs(iz + 1), xs(ix), zs(iz));
        for (let i = 0; i + 1 < pts.length; i += 2) out.push(`M${X(pts[i][0])},${Y(pts[i][1])}L${X(pts[i + 1][0])},${Y(pts[i + 1][1])}`);
      }
    }
  }
  return { minor: minor.join(''), major: major.join('') };
}

// ------------------------------------------------------------------------------------------- styles
const BUILDING_FILL = { terrace: '#dcbc8e', house: '#e6cba0', retail: '#e8a96b', commercial: '#c99f74', apartments: '#bf9468', university: '#b8775a', church: '#a58bc4', warehouse: '#a68c70', civic: '#93a9c2' };
const POI_GROUPS = [
  ['food & drink', '#e4572e', (c) => /^amenity=(restaurant|cafe|bar|pub|fast_food|ice_cream|nightclub)$|^shop=(bakery|deli|wine)$/.test(c)],
  ['shops', '#7b4bb7', (c) => c.startsWith('shop=') && !/^shop=(car|car_repair)$/.test(c)],
  ['hotels', '#1f5fae', (c) => c === 'tourism=hotel'],
  ['services', '#138a7c', (c) => /^amenity=(bank|pharmacy|post_office|clinic|hospital|police|fire_station|library|school|university|place_of_worship)$/.test(c)],
  ['cars & parking', '#f29e0c', (c) => /^(shop=car|shop=car_repair|amenity=fuel|amenity=parking)$/.test(c)],
  ['leisure & sights', '#2e8b57', (c) => /^(tourism=|leisure=|historic=|amenity=(boat_rental|cinema))/.test(c)],
  ['offices', '#555', (c) => c.startsWith('office=')],
  ['transit', '#111', (c) => c.startsWith('railway=') || c.startsWith('public_transport=')],
];
const poiColour = (c) => (POI_GROUPS.find((g) => g[2](c)) ?? ['other', '#999'])[1];
const FOOT_STYLE = {
  sidewalk: 'stroke="#f6f2ea" stroke-width="2.2"',
  crossing: 'stroke="#ffffff" stroke-width="2.2" stroke-dasharray="1.2 1.2"',
  footway: 'stroke="#d8c39a" stroke-width="1.6"',
  path: 'stroke="#a8814f" stroke-width="1.8" stroke-dasharray="5 2.5"',
  cycleway: 'stroke="#2f8f4e" stroke-width="2" stroke-dasharray="6 2.5"',
  steps: 'stroke="#c0392b" stroke-width="2.2" stroke-dasharray="1.5 1.2"',
};

// ------------------------------------------------------------------------------------------- layers
const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif">`);
parts.push(`<defs>
<pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#e3e1dc"/><line x1="0" y1="0" x2="0" y2="7" stroke="#9c988f" stroke-width="1.6"/></pattern>
<pattern id="graves" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#b9d2a6"/><path d="M4.5 2.5v4M3 4h3" stroke="#7c9a6a" stroke-width="0.8"/></pattern>
</defs>`);
parts.push(`<rect width="${PW}" height="${PH}" fill="#e6e8d6"/>`);
parts.push(terrainImage());
const ct = contours(5);
parts.push(`<path d="${ct.minor}" fill="none" stroke="#8b7653" stroke-opacity="0.22" stroke-width="0.7"/>`);
parts.push(`<path d="${ct.major}" fill="none" stroke="#7a6545" stroke-opacity="0.42" stroke-width="1.2"/>`);

for (const p of doc.parks ?? []) {
  const fill = p.kind === 'landuse=cemetery' ? 'url(#graves)' : p.kind === 'leisure=garden' ? '#c6e2ae' : '#b5d99c';
  parts.push(`<path d="${polyPath(p)}" fill="${fill}" fill-rule="evenodd" stroke="#86b86a" stroke-width="1"/>`);
}
for (const f of doc.footways ?? []) if (f.area) parts.push(`<path d="${polyPath(f)}" fill="#ebe3d4" fill-rule="evenodd" stroke="#c4b49b" stroke-width="1"/>`);
for (const p of doc.parking ?? []) parts.push(`<path d="${polyPath(p)}" fill="url(#hatch)" stroke="#8a867c" stroke-width="1.2"/>`);
for (const w of doc.water ?? []) parts.push(`<path d="${polyPath(w)}" fill="#8cc5ec" fill-rule="evenodd" stroke="#5b9cd0" stroke-width="1.2"/>`);

// Footways under roads (sidewalks sit beside the carriageway), piers drawn heavier.
for (const f of doc.footways ?? []) {
  if (f.area) continue;
  const st = f.pier ? 'stroke="#8b5a2b" stroke-width="3.2"' : f.towpath ? 'stroke="#b08655" stroke-width="2.6"' : FOOT_STYLE[f.kind] ?? FOOT_STYLE.footway;
  parts.push(`<path d="${pathOf(f.pts)}" fill="none" ${st} stroke-linecap="round" stroke-linejoin="round"/>`);
}

// Roads: tunnels, at-grade casing then fill, then bridges and elevated roads with a dark casing on top.
const roadW = (r) => Math.max(2, (r.lanes ?? 2) * 3.3 * k);
const grey = (r) => (r.highway === 'trunk' || r.highway === 'motorway' ? '#8f8f8f' : r.highway === 'primary' ? '#a6a6a6' : r.highway === 'secondary' ? '#b0b0b0' : '#bdbdbd');
const roads = doc.roads ?? [];
for (const r of roads.filter((r) => r.tunnel)) parts.push(`<path d="${pathOf(r.pts)}" fill="none" stroke="#777" stroke-width="${roadW(r).toFixed(1)}" stroke-opacity="0.35" stroke-dasharray="6 4"/>`);
const ground = roads.filter((r) => !r.tunnel && !r.bridge && !r.layer);
const RANK = { motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, service: 0 };
ground.sort((a, b) => (RANK[a.highway] ?? 0) - (RANK[b.highway] ?? 0)); // main roads cover the end caps of side streets
for (const r of ground) parts.push(`<path d="${pathOf(r.pts)}" fill="none" stroke="#7b7b7b" stroke-width="${(roadW(r) + 1.6).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
for (const r of ground) parts.push(`<path d="${pathOf(r.pts)}" fill="none" stroke="${grey(r)}" stroke-width="${roadW(r).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
// Footway bridges and crossings over the road surface.
for (const f of doc.footways ?? []) if (f.kind === 'crossing' && !f.bridge) parts.push(`<path d="${pathOf(f.pts)}" fill="none" ${FOOT_STYLE.crossing}/>`);
const elevated = roads.filter((r) => !r.tunnel && (r.bridge || r.layer > 0)).sort((a, b) => (a.highway === 'trunk') - (b.highway === 'trunk'));
for (const r of elevated) {
  parts.push(`<path d="${pathOf(r.pts)}" fill="none" stroke="#3d3d3d" stroke-width="${(roadW(r) + 3.2).toFixed(1)}" stroke-linejoin="round"/>`);
  parts.push(`<path d="${pathOf(r.pts)}" fill="none" stroke="${r.highway === 'trunk' ? '#8f8f8f' : grey(r)}" stroke-width="${roadW(r).toFixed(1)}" stroke-linejoin="round"/>`);
}
for (const f of doc.footways ?? []) if (f.bridge && !f.area) parts.push(`<path d="${pathOf(f.pts)}" fill="none" stroke="#3d3d3d" stroke-width="3.6"/><path d="${pathOf(f.pts)}" fill="none" stroke="#efe6d2" stroke-width="2"/>`);

// Buildings, trees, small props.
for (const b of doc.buildings ?? []) parts.push(`<path d="${pathOf(b.pts, true)}" fill="${BUILDING_FILL[b.type] ?? '#d0b48a'}" stroke="#7d6346" stroke-width="0.55"/>`);
const trees = (doc.props ?? []).filter((p) => p[2] === 'tree');
parts.push(`<g fill="#4f8f3f" fill-opacity="0.75">${trees.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="1.5"/>`).join('')}</g>`);
const signals = (doc.props ?? []).filter((p) => p[2] === 'signals');
parts.push(`<g fill="#d62828">${signals.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="1.8"/>`).join('')}</g>`);
const locks = (doc.props ?? []).filter((p) => p[2] === 'lock_gate');
parts.push(`<g fill="#3b2a1a">${locks.map((p) => `<rect x="${(X(p[0]) - 1.5).toFixed(1)}" y="${(Y(p[1]) - 6).toFixed(1)}" width="3" height="12"/>`).join('')}</g>`);

// One-way arrows every 70 m along one-way roads, pointing in the direction of travel.
{
  const arrows = [];
  for (const r of roads) {
    if (!r.oneway) continue;
    const pts = r.oneway < 0 ? r.pts.slice().reverse() : r.pts;
    let carry = 25;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = carry; s < L; s += 70) {
        const x = ax + ((bx - ax) * s) / L, z = az + ((bz - az) * s) / L;
        const ang = (Math.atan2(bz - az, bx - ax) * 180) / Math.PI;
        arrows.push(`<path transform="translate(${X(x)},${Y(z)}) rotate(${ang.toFixed(1)})" d="M5,0L-4,-3.6L-2,0L-4,3.6Z"/>`);
      }
      carry = Math.max(0, carry - L) || ((carry - L) % 70 + 70) % 70;
    }
  }
  parts.push(`<g fill="#ffffff" stroke="#333" stroke-width="0.8">${arrows.join('')}</g>`);
}

// POIs.
parts.push(`<g stroke="#ffffff" stroke-width="0.9">${(doc.pois ?? []).map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="3.1" fill="${poiColour(p.cat)}"/>`).join('')}</g>`);

// Street names along the roads (one label per ~380 m of each name), reading left to right.
{
  const defs = [], texts = [];
  const placed = new Map();
  let n = 0;
  const FONT = 12;
  const charW = FONT * 0.66; // bold sans
  for (const r of [...roads].sort((a, b) => (b.lanes ?? 2) - (a.lanes ?? 2))) {
    if (!r.name || r.tunnel) continue;
    const pts = r.pts.map((p) => [(p[0] - B.x0) * k, (p[1] - B.z0) * k]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    const need = r.name.length * charW + 16;
    if (L < need) continue;
    const at = (s) => {
      let i = 1;
      while (i < pts.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    };
    const count = Math.max(1, Math.floor(L / (380 * k)));
    for (let c = 0; c < count; c++) {
      const mid = (L * (c + 0.5)) / count;
      const s0 = Math.max(0, mid - need / 2), s1 = Math.min(L, mid + need / 2);
      const m = at(mid);
      const prev = placed.get(r.name) ?? [];
      if (prev.some((q) => Math.hypot(q[0] - m[0], q[1] - m[1]) < 300 * k)) continue;
      prev.push(m);
      placed.set(r.name, prev);
      let seg = [at(s0)];
      for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) seg.push(pts[i]);
      seg.push(at(s1));
      const a = seg[0], b = seg[seg.length - 1];
      if (b[0] < a[0] - 1e-6 || (Math.abs(b[0] - a[0]) < 1e-6 && b[1] < a[1])) seg = seg.reverse();
      const id = `rl${n++}`;
      defs.push(`<path id="${id}" d="M${seg.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}"/>`);
      texts.push(`<text font-size="${FONT}" dy="4" text-anchor="middle"><textPath href="#${id}" startOffset="50%">${esc(r.name)}</textPath></text>`);
    }
  }
  parts.push(`<defs>${defs.join('')}</defs>`);
  parts.push(`<g fill="#1b1b1b" stroke="#ffffff" stroke-width="3.2" paint-order="stroke" stroke-linejoin="round" font-weight="600">${texts.join('')}</g>`);
}

// Water and park names.
{
  const lab = [];
  const centroidOf = (ring) => {
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f;
      cx += (ring[j][0] + ring[i][0]) * f;
      cz += (ring[j][1] + ring[i][1]) * f;
    }
    return a ? [cx / (3 * a), cz / (3 * a)] : ring[0];
  };
  const longest = new Map();
  for (const w of doc.waterways ?? []) {
    if (!w.name || w.kind === 'canal') continue;
    if (!longest.has(w.name) || w.pts.length > longest.get(w.name).pts.length) longest.set(w.name, w);
  }
  // A river's name goes at the most open point of its water area that the legend does not cover.
  const openSpot = (name) => {
    const areas = (doc.water ?? []).filter((w) => w.name === name);
    let best = null;
    for (let py = 30; py < PH - 30; py += 12) {
      for (let px = 150; px < PW - 150; px += 12) {
        if (px > LEGEND.x - 160 && px < LEGEND.x + LEGEND.w + 160 && py > LEGEND.y - 30 && py < LEGEND.y + LEGEND.h + 30) continue;
        const x = B.x0 + px / k, z = B.z0 + py / k;
        const area = areas.find((a) => inRing(x, z, a.pts));
        if (!area) continue;
        let d = Infinity;
        for (let i = 0, j = area.pts.length - 1; i < area.pts.length; j = i++) d = Math.min(d, segDist(x, z, area.pts[j], area.pts[i]));
        d = Math.min(d, (px - 120) / k, (PW - 120 - px) / k, (py - 20) / k, (PH - 20 - py) / k);
        if (best && d <= best.d) continue;
        for (const r of doc.roads ?? []) for (let i = 1; i < r.pts.length && d > (best?.d ?? 0); i++) d = Math.min(d, segDist(x, z, r.pts[i - 1], r.pts[i]));
        if (!best || d > best.d) best = { d, m: [x, z] };
      }
    }
    return best?.m ?? null;
  };
  for (const w of longest.values()) {
    const m = (w.kind === 'river' && openSpot(w.name)) || w.pts[Math.floor(w.pts.length * 0.62)];
    lab.push(`<text x="${X(m[0])}" y="${Y(m[1])}" font-size="${w.kind === 'river' ? 26 : 13}" font-style="italic" fill="#1d5f99" text-anchor="middle"${w.kind === 'stream' ? ` transform="rotate(-62 ${X(m[0])} ${Y(m[1])})"` : ''}>${esc(w.name)}</text>`);
  }
  const canal = (doc.waterways ?? []).find((w) => w.kind === 'canal');
  if (canal) {
    const m = canal.pts[Math.floor(canal.pts.length * 0.12)];
    lab.push(`<text x="${X(m[0])}" y="${(Number(Y(m[1])) - 9).toFixed(1)}" font-size="11" font-style="italic" fill="#1d5f99" text-anchor="middle">C&amp;O Canal</text>`);
  }
  for (const p of doc.parks ?? []) {
    if (!p.name) continue;
    let area = 0;
    for (let i = 0, j = p.pts.length - 1; i < p.pts.length; j = i++) area += (p.pts[j][0] - p.pts[i][0]) * (p.pts[j][1] + p.pts[i][1]);
    if (Math.abs(area / 2) < 2500 && !/Circle/.test(p.name)) continue;
    const c = centroidOf(p.pts);
    lab.push(`<text x="${X(c[0])}" y="${Y(c[1])}" font-size="11" font-style="italic" fill="#2c5e1f" text-anchor="middle">${esc(p.name.replace(/ corridor$/, ''))}</text>`);
  }
  parts.push(`<g stroke="#ffffff" stroke-width="2.6" paint-order="stroke" stroke-opacity="0.85">${lab.join('')}</g>`);
}

// Legend, scale bar, north arrow.
{
  const { w: lw, h: lh, x: lx, y: ly } = LEGEND;
  const L = [];
  L.push(`<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="8" fill="#ffffff" fill-opacity="0.93" stroke="#666" stroke-width="1"/>`);
  L.push(`<text x="${lx + 16}" y="${ly + 30}" font-size="21" font-weight="700" fill="#222">Georgetown, Washington DC: map preview</text>`);
  const m = doc.meta;
  const sub = m.synthetic ? 'Hand-authored approximation, not OpenStreetMap; buildings, POIs and heights synthesized' : (m.attribution ?? '');
  L.push(`<text x="${lx + 16}" y="${ly + 51}" font-size="12.5" fill="#444">${esc(sub)}</text>`);
  const c = m.counts ?? {};
  L.push(`<text x="${lx + 16}" y="${ly + 70}" font-size="12.5" fill="#444">${m.crop.widthM} x ${m.crop.heightM} m  ·  ${c.roads} roads, ${c.footways} footways, ${c.buildings} buildings, ${c.pois} POIs, ${c.props} props</text>`);
  let y = ly + 96;
  const sw = (x, yy, fill, label, extra = '') => `<rect x="${x}" y="${yy - 10}" width="22" height="13" fill="${fill}" stroke="#666" stroke-width="0.7" ${extra}/><text x="${x + 30}" y="${yy + 1}" font-size="12.5" fill="#222">${esc(label)}</text>`;
  const col1 = [['#8cc5ec', 'water'], ['#b5d99c', 'park'], ['url(#graves)', 'cemetery'], ['url(#hatch)', 'car park'], ['#ebe3d4', 'plaza'], ['#a6a6a6', 'road (width = lanes)'], ['#3d3d3d', 'bridge / elevated'], ['#f6f2ea', 'sidewalk']];
  col1.forEach(([f, l], i) => L.push(sw(lx + 16, y + i * 21, f, l)));
  const col2 = Object.entries(BUILDING_FILL);
  col2.forEach(([t, f], i) => L.push(sw(lx + 210, y + i * 21, f, `building: ${t}`)));
  POI_GROUPS.forEach(([label, colour], i) => L.push(`<circle cx="${lx + 425}" cy="${y + i * 21 - 4}" r="5" fill="${colour}" stroke="#fff"/><text x="${lx + 437}" y="${y + i * 21 + 1}" font-size="12.5" fill="#222">${esc(label)}</text>`));
  const sy = ly + lh - 22;
  const sbar = 200 * k;
  L.push(`<rect x="${lx + 16}" y="${sy - 6}" width="${sbar / 2}" height="6" fill="#222"/><rect x="${lx + 16 + sbar / 2}" y="${sy - 6}" width="${sbar / 2}" height="6" fill="#fff" stroke="#222"/>`);
  L.push(`<text x="${lx + 16}" y="${sy + 13}" font-size="11.5" fill="#222">0</text><text x="${lx + 16 + sbar}" y="${sy + 13}" font-size="11.5" fill="#222" text-anchor="middle">200 m</text>`);
  L.push(`<text x="${lx + 290}" y="${sy + 2}" font-size="11.5" fill="#444">contours 5 m · red dots: signals · arrows: one-way · dashed red: steps</text>`);
  const nx = PW - 60, ny = 70;
  L.push(`<g transform="translate(${nx},${ny})"><circle r="30" fill="#fff" fill-opacity="0.9" stroke="#666"/><path d="M0,-24L9,8L0,2L-9,8Z" fill="#222"/><text y="22" font-size="15" font-weight="700" text-anchor="middle" fill="#222">N</text></g>`);
  parts.push(L.join(''));
}
parts.push('</svg>');
const svg = parts.join('\n');

mkdirSync(dirname(args.svg) || '.', { recursive: true });
writeFileSync(args.svg, svg);
console.log(`SVG ${args.svg}: ${PW} x ${PH} px, ${(Buffer.byteLength(svg) / 1048576).toFixed(2)} MB`);

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: PW, height: PH }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style></head><body>${svg}</body></html>`, { waitUntil: 'load' });
  mkdirSync(dirname(args.out) || '.', { recursive: true });
  await page.screenshot({ path: args.out, clip: { x: 0, y: 0, width: PW, height: PH } });
  console.log(`PNG ${args.out}: ${PW} x ${PH} px${errors.length ? `; page errors: ${errors.join(' | ')}` : ', no page errors'}`);
} finally {
  await browser.close();
}
