// Building statistics for the Georgetown map data (input to docs/interiors-design.md): what kinds of buildings the
// interior system has to fill, and the shapes, storeys, slopes and neighbours it has to fit.
//   node scripts/buildingStats.mjs [out.json]
// Reads src/data/georgetown.json, georgetown-buildings-ccby.json and georgetown-places.json (data only; no browser).
// Rules copied from the world generator where they decide something (src/systems/map/facades.ts): a wall is a party
// wall when 2 of 3 points 0.8 m outside it fall inside another footprint; the front is the non-party wall nearest a
// street (probe 4 m out); "street-facing" = that probe within 9 m of a carriageway edge; rowhouse stoops are drawn for
// type house / terrace east of x = 380 (Georgetown proper; the West End gets level entrances). Footprints are the
// data's: the world later trims 1-2 % of them back from streets and drops a few under decks (the runtime numbers come
// from scripts/auditBuildings.mjs). Terrain is the data's height grid (5 m USGS 3DEP samples, bilinear), i.e. the
// natural ground before roads and sidewalks are graded into it.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const D = (f) => JSON.parse(readFileSync(resolve('src/data', f), 'utf8'));
const doc = D('georgetown.json');
const ccby = D('georgetown-buildings-ccby.json').buildings;
const places = D('georgetown-places.json').pois;
const B = doc.buildings.concat(ccby);
const bounds = doc.meta.bounds;
const WEST_END_X = 380; // facades.ts
const NOTCH_TOL = 0.3; // TUNING.geo.footprintNotchTol: deeper notches make a footprint concave for the colliders
const STOREY = 3.2; // facades.ts storey height; ground floor 4.2 for retail / warehouse / commercial, 3.3 otherwise

// ------------------------------------------------------------------------------------------------- helpers
const area = (P) => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] - P[i][0]) * (P[j][1] + P[i][1]); return a / 2; };
const centroid = (P) => { let x = 0, z = 0; for (const p of P) { x += p[0]; z += p[1]; } return [x / P.length, z / P.length]; };
const inPoly = (x, z, P) => { let ins = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; };
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)); return Math.hypot(ax + dx * t - px, az + dz * t - pz); };
function hull(P) {
  const pts = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** Minimum-area enclosing rectangle (over the hull's edge directions): [short side, long side, area]. */
function obb(P) {
  const H = hull(P);
  let best = [0, 0, Infinity];
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of H) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (A < best[2]) best = [Math.min(u1 - u0, v1 - v0), Math.max(u1 - u0, v1 - v0), A];
  }
  return best;
}
/** Concave in the colliders' sense (convexPieces in facades.ts): a vertex more than NOTCH_TOL inside the line past it. */
function concave(P) {
  // the same test as facades.ts convexPieces: shoelace sign, then each vertex's turn against it
  let a2 = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
  const sg = Math.sign(a2) || 1;
  let reflex = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[(i + P.length - 1) % P.length], b = P[i], c = P[(i + 1) % P.length];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if ((cr * sg) / L < -NOTCH_TOL) reflex++;
  }
  return reflex;
}
const H = doc.heights;
const ground = (x, z) => {
  const fx = Math.max(0, Math.min(H.nx - 1.0001, (x - H.x0) / H.spacing)), fz = Math.max(0, Math.min(H.nz - 1.0001, (z - H.z0) / H.spacing));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, o = iz * H.nx + ix, d = H.data;
  return (d[o] * (1 - tx) + d[o + 1] * tx) * (1 - tz) + (d[o + H.nx] * (1 - tx) + d[o + H.nx + 1] * tx) * tz;
};
const hashStr = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };
const rand = (seed) => { let s = seed >>> 0 || 1; return () => { let t = (s = (s + 0x6d2b79f5) >>> 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// ------------------------------------------------------------------------------------------------- spatial grids
const CELL = 24;
const grid = new Map();
const key = (i, j) => i * 100003 + j;
B.forEach((b, idx) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of b.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  b._bb = [x0, z0, x1, z1];
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
});
const buildingAt = (x, z, not) => {
  for (const idx of grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
    if (idx === not) continue;
    const b = B[idx], bb = b._bb;
    if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
    if (inPoly(x, z, b.pts)) return idx;
  }
  return -1;
};
// roads at grade (decks and tunnels are not streets a door opens onto; facades.ts skips deck edges)
const RC = 32;
const rgrid = new Map();
const roadSegs = [];
const decks = [];
for (const r of doc.roads) {
  const deck = r.bridge || r.layer > 0, under = r.tunnel || r.layer < 0;
  const hw = (r.width ?? 7) / 2;
  for (let k = 1; k < r.pts.length; k++) {
    const s = [r.pts[k - 1][0], r.pts[k - 1][1], r.pts[k][0], r.pts[k][1], hw, r.highway];
    if (deck) { decks.push(s); continue; }
    if (under) continue;
    const id = roadSegs.push(s) - 1;
    const pad = hw + 14;
    for (let i = Math.floor((Math.min(s[0], s[2]) - pad) / RC); i <= Math.floor((Math.max(s[0], s[2]) + pad) / RC); i++)
      for (let j = Math.floor((Math.min(s[1], s[3]) - pad) / RC); j <= Math.floor((Math.max(s[1], s[3]) + pad) / RC); j++) { const kk = key(i, j); if (!rgrid.has(kk)) rgrid.set(kk, []); rgrid.get(kk).push(id); }
  }
}
/** Distance from (x, z) to the nearest carriageway edge at grade (negative inside a carriageway). */
const roadEdgeDist = (x, z) => {
  let d = Infinity;
  for (const id of rgrid.get(key(Math.floor(x / RC), Math.floor(z / RC))) ?? []) { const s = roadSegs[id]; d = Math.min(d, segDist(x, z, s[0], s[1], s[2], s[3]) - s[4]); }
  return d;
};

// ------------------------------------------------------------------------------------------------- POIs by building
const poisBy = new Map();
for (const p of places) if (p.b) { if (!poisBy.has(p.b)) poisBy.set(p.b, []); poisBy.get(p.b).push(p.cat); }
const POI_CLASS = (cat) => {
  if (/^amenity=(cafe|restaurant|fast_food|bar|pub|ice_cream|food_court|nightclub)$|^shop=(bakery|deli|coffee|confectionery|chocolate)$/.test(cat)) return 'cafe/restaurant';
  if (/^shop=(car|car_repair)$|^amenity=(fuel|car_wash|car_rental|boat_rental)$/.test(cat)) return 'garage/workshop';
  if (/^shop=/.test(cat)) return 'shop';
  if (/^office=|^amenity=(bank|post_office|clinic|doctors|dentist|veterinary|pharmacy|atm)$|^leisure=(fitness_centre|sports_centre|dance)$/.test(cat)) return 'office';
  if (/^tourism=(hotel|guest_house)$/.test(cat)) return 'apartment';
  if (/^amenity=(place_of_worship|school|university|college|library|hospital|theatre|cinema|community_centre|police|fire_station|kindergarten)$|^tourism=(museum|gallery)$/.test(cat)) return 'church/institution';
  return null; // tourism=attraction, historic=..., amenity=parking...: no template of their own
};
const TYPE_CLASS = (t) =>
  ['house', 'terrace', 'semidetached_house', 'detached', 'residential'].includes(t) ? 'rowhouse/house'
    : ['apartments', 'dormitory', 'hotel'].includes(t) ? 'apartment'
      : ['retail', 'commercial'].includes(t) ? 'shop'
        : ['garage', 'boathouse', 'warehouse'].includes(t) ? 'garage/workshop'
          : ['church', 'school', 'university', 'library', 'hospital', 'post_office', 'civic'].includes(t) ? 'church/institution'
            : t === 'shed' ? 'shed/outbuilding'
              : ['roof', 'shelter', 'pavilion', 'guardhouse'].includes(t) ? 'open structure'
                : 'untyped (yes)';
const CLASS_ORDER = ['rowhouse/house', 'apartment', 'shop', 'cafe/restaurant', 'office', 'garage/workshop', 'church/institution', 'shed/outbuilding', 'open structure', 'untyped (yes)'];
// the template class: a place inside wins (a rowhouse with a salon is a shop downstairs); several places: the first
// of cafe > shop > garage > office > institution > hotel; then the data type
const PRIORITY = ['cafe/restaurant', 'shop', 'garage/workshop', 'office', 'church/institution', 'apartment'];

// ------------------------------------------------------------------------------------------------- per building
const rows = [];
B.forEach((b, idx) => {
  const P = b.pts;
  const A = Math.abs(area(P));
  const [cx, cz] = centroid(P);
  const [w, len, obbA] = obb(P);
  const reflex = concave(P);
  // walls: party, street distance (facades.ts rules)
  const sg = area(P);
  let partyLen = 0, perim = 0, front = null, frontD = Infinity, nonParty = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 0.3) continue;
    perim += L;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    let nx = -uz, nz = ux;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; } // facades.ts: away from the centroid
    let touching = 0;
    for (const f of [0.2, 0.5, 0.8]) if (buildingAt(p[0] + (q[0] - p[0]) * f + nx * 0.8, p[1] + (q[1] - p[1]) * f + nz * 0.8, idx) >= 0) touching++;
    if (touching >= 2) { partyLen += L; continue; }
    nonParty++;
    const d = roadEdgeDist(mx + nx * 4, mz + nz * 4);
    if (d < frontD) { frontD = d; front = { L, mx, mz, nx, nz, ax: p[0], az: p[1], bx: q[0], bz: q[1] }; }
  }
  void sg;
  // terrain across the footprint: vertices + a 2 m grid inside
  let gmin = Infinity, gmax = -Infinity;
  for (const p of P) { const g = ground(p[0], p[1]); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
  const bb = b._bb;
  for (let x = bb[0] + 1; x < bb[2]; x += 2) for (let z = bb[1] + 1; z < bb[3]; z += 2) if (inPoly(x, z, P)) { const g = ground(x, z); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
  // the front wall: ground along it vs the far side (a bank house: entrance level at the street, garden a floor lower)
  let frontFall = null;
  if (front) {
    const gFront = ground(front.mx + front.nx * 1.6, front.mz + front.nz * 1.6);
    let gBack = gFront;
    for (const p of P) gBack = Math.abs(ground(p[0], p[1]) - gFront) > Math.abs(gBack - gFront) ? ground(p[0], p[1]) : gBack;
    frontFall = gBack - gFront; // + : the back stands higher than the street (dug in), - : falls away
  }
  // the pavement along the front wall: facades.ts sets the ground floor from the middle of the front wall; a door near
  // one end of a wall on a sloping street sits above or below the pavement there by this much
  let frontSlope = null;
  if (front) {
    const g = (x, z) => ground(x + front.nx * 1.6, z + front.nz * 1.6);
    const gm = g(front.mx, front.mz);
    const t = Math.min(1.3, front.L / 2) / front.L; // a door bay's middle, ~1.3 m in from the corner
    const ea = g(front.ax + (front.bx - front.ax) * t, front.az + (front.bz - front.az) * t), eb = g(front.bx + (front.ax - front.bx) * t, front.bz + (front.az - front.bz) * t);
    frontSlope = Math.max(Math.abs(ea - gm), Math.abs(eb - gm));
  }
  const pois = poisBy.get(b.id) ?? [];
  const poiClasses = [...new Set(pois.map(POI_CLASS).filter(Boolean))];
  const typeClass = TYPE_CLASS(b.type);
  const poiClass = PRIORITY.find((c) => poiClasses.includes(c)) ?? null;
  const cls = poiClass ?? typeClass;
  // stoop as facades.ts draws it (rowhouse types east of the West End, a door on a non-party wall, rise 0.2-2.4 m):
  // the first draw of the building's random stream sets the nominal stoop; the drawn rise comes from the ground
  const westEnd = cx > WEST_END_X;
  const stoopType = (b.type === 'house' || b.type === 'terrace') && !westEnd;
  const nominalStoop = stoopType ? 0.45 + rand(hashStr(b.id))() * 0.6 : 0.05;
  // under a deck: a bridge / freeway line within its half width + sidewalk + 1.2 m of a vertex (buildingsUnderDecks)
  let nearDeck = false;
  for (const s of decks) { for (const p of P) if (segDist(p[0], p[1], s[0], s[1], s[2], s[3]) < s[4] + 3 + 1.2) { nearDeck = true; break; } if (nearDeck) break; }
  const edgeDist = Math.min(bb[0] - bounds.x0, bounds.x1 - bb[2], bb[1] - bounds.z0, bounds.z1 - bb[3]);
  const groundH = b.type === 'retail' || b.type === 'warehouse' || (b.type === 'commercial' && !westEnd) ? 4.2 : STOREY + 0.1;
  const facadeH = groundH + (Math.max(1, b.levels) - 1) * STOREY;
  rows.push({
    id: b.id, type: b.type, cls, typeClass, poiClass, pois, levels: b.levels, h: b.h, est: !!b.est, area: A, w, len, rect: A / obbA, verts: P.length, reflex, holes: b.holes?.length ?? 0,
    partyShare: perim ? partyLen / perim : 0, nonParty, frontD, street: frontD < 9, fall: gmax - gmin, frontFall, frontSlope, stoopType, nominalStoop, westEnd, nearDeck, edgeDist, facadeH, ccby: idx >= doc.buildings.length,
  });
});

// terraces: rows of buildings joined by party walls (connected components)
{
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  B.forEach((b, idx) => {
    const P = b.pts, [cx, cz] = centroid(P);
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (L < 0.3) continue;
      let nx = -(q[1] - p[1]) / L, nz = (q[0] - p[0]) / L;
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
      const o = buildingAt(mx + nx * 0.8, mz + nz * 0.8, idx);
      if (o >= 0) parent[find(o)] = find(idx);
    }
  });
  const size = new Map();
  rows.forEach((_, i) => size.set(find(i), (size.get(find(i)) ?? 0) + 1));
  rows.forEach((r, i) => { r.rowSize = size.get(find(i)); });
}

// ------------------------------------------------------------------------------------------------- tables
const N = rows.length;
const pct = (n, d = N) => `${((100 * n) / d).toFixed(1)} %`;
const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : NaN; };
const by = (f) => { const m = new Map(); for (const r of rows) { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const out = { buildings: N, mainFile: doc.buildings.length, ccby: ccby.length, places: places.length, placesInBuildings: places.filter((p) => p.b).length };
const L = [];
L.push(`Georgetown building statistics (scripts/buildingStats.mjs, data ${doc.meta.source?.slice(0, 60) ?? ''})`);
L.push(`${N} footprints (${doc.buildings.length} ODbL + ${ccby.length} CC BY), ${places.length} places, ${out.placesInBuildings} of them inside a footprint, in ${new Set(places.filter((p) => p.b).map((p) => p.b)).size} buildings.`);
L.push('');
L.push('| class (template) | buildings | share | by data type only | with a place | median area m2 | median width m | median storeys | storeys >= 4 | concave | narrow < 4.5 m | street door | party walls | terrain fall > 1.5 m |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const cls = by((r) => r.cls);
const tcls = by((r) => r.typeClass);
for (const c of CLASS_ORDER) {
  const R = cls.get(c) ?? [];
  if (!R.length && !(tcls.get(c) ?? []).length) continue;
  L.push(`| ${c} | ${R.length} | ${pct(R.length)} | ${(tcls.get(c) ?? []).length} | ${R.filter((r) => r.pois.length).length} | ${q(R.map((r) => r.area), 0.5)?.toFixed(0)} | ${q(R.map((r) => r.w), 0.5)?.toFixed(1)} | ${q(R.map((r) => r.levels), 0.5)} | ${R.filter((r) => r.levels >= 4).length} | ${R.filter((r) => r.reflex > 0).length} | ${R.filter((r) => r.w < 4.5).length} | ${R.filter((r) => r.street).length} | ${R.filter((r) => r.partyShare > 0).length} | ${R.filter((r) => r.fall > 1.5).length} |`);
}
L.push(`| **all** | ${N} | 100 % | ${N} | ${rows.filter((r) => r.pois.length).length} | ${q(rows.map((r) => r.area), 0.5).toFixed(0)} | ${q(rows.map((r) => r.w), 0.5).toFixed(1)} | ${q(rows.map((r) => r.levels), 0.5)} | ${rows.filter((r) => r.levels >= 4).length} | ${rows.filter((r) => r.reflex > 0).length} | ${rows.filter((r) => r.w < 4.5).length} | ${rows.filter((r) => r.street).length} | ${rows.filter((r) => r.partyShare > 0).length} | ${rows.filter((r) => r.fall > 1.5).length} |`);
L.push('');
// data types
L.push('Data types: ' + [...by((r) => r.type)].sort((a, b) => b[1].length - a[1].length).map(([t, R]) => `${t} ${R.length}`).join(', '));
// POI classes
const pc = new Map();
for (const p of places) { const c = POI_CLASS(p.cat) ?? `(no template: ${p.cat.split('=')[0]})`; pc.set(c, (pc.get(c) ?? 0) + 1); }
L.push('Places by template class: ' + [...pc].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '));
// untyped footprints (building=yes, no place): the fallback the design proposes (docs/interiors-design.md, template choice)
const yes = rows.filter((r) => r.cls === 'untyped (yes)');
const fb = (r) => (r.area < 25 || r.w < 3 ? 'shed (one room or none)' : r.frontD > 15 && r.area < 150 ? 'garage / carriage house (back lot)' : r.area >= 600 ? 'office / public lobby (large)' : 'house (default)');
const fbc = new Map();
for (const r of yes) { const k = fb(r); fbc.set(k, (fbc.get(k) ?? 0) + 1); r.fallback = k; }
L.push(`Untyped footprints without a place (${yes.length}) by the proposed fallback: ` + [...fbc].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') + '.');
const mixed = rows.filter((r) => r.poiClass && r.typeClass === 'rowhouse/house');
L.push(`Rowhouse / house footprints with a place inside (shop or office downstairs): ${mixed.length}; buildings with 2+ places: ${rows.filter((r) => r.pois.length >= 2).length}; most places in one building: ${Math.max(...rows.map((r) => r.pois.length))}`);
L.push('');
// area and shape
const areaB = [[0, 20], [20, 40], [40, 80], [80, 150], [150, 300], [300, 1000], [1000, 3000], [3000, 1e9]];
L.push('| footprint area m2 | ' + areaB.map(([a, b]) => (b > 1e8 ? `>= ${a}` : `${a}-${b}`)).join(' | ') + ' |');
L.push('|---|' + areaB.map(() => '---').join('|') + '|');
L.push('| buildings | ' + areaB.map(([a, b]) => rows.filter((r) => r.area >= a && r.area < b).length).join(' | ') + ' |');
const wB = [[0, 3], [3, 4.5], [4.5, 6], [6, 8], [8, 12], [12, 20], [20, 1e9]];
L.push('');
L.push('| width (short side of the min-area box) m | ' + wB.map(([a, b]) => (b > 1e8 ? `>= ${a}` : `${a}-${b}`)).join(' | ') + ' |');
L.push('|---|' + wB.map(() => '---').join('|') + '|');
L.push('| buildings | ' + wB.map(([a, b]) => rows.filter((r) => r.w >= a && r.w < b).length).join(' | ') + ' |');
L.push('| of them rowhouse/house | ' + wB.map(([a, b]) => rows.filter((r) => r.w >= a && r.w < b && r.typeClass === 'rowhouse/house').length).join(' | ') + ' |');
L.push('');
L.push(`Shape: concave for the colliders (a notch deeper than ${NOTCH_TOL} m) ${rows.filter((r) => r.reflex > 0).length} (${pct(rows.filter((r) => r.reflex > 0).length)}); with courtyards (holes) ${rows.filter((r) => r.holes).length}; rectangular (area >= 95 % of its min box) ${rows.filter((r) => r.rect >= 0.95).length}; quads ${rows.filter((r) => r.verts === 4).length}; > 12 vertices ${rows.filter((r) => r.verts > 12).length}; tiny (< 20 m2) ${rows.filter((r) => r.area < 20).length}; narrow (< 4.5 m) ${rows.filter((r) => r.w < 4.5).length}; deep and narrow (length >= 3x width) ${rows.filter((r) => r.len >= 3 * r.w).length}.`);
L.push('');
// storeys
const lv = by((r) => Math.min(r.levels, 8));
L.push('| storeys (data levels) | ' + [1, 2, 3, 4, 5, 6, 7, 8].map((k) => (k === 8 ? '8+' : k)).join(' | ') + ' |');
L.push('|---|' + [1, 2, 3, 4, 5, 6, 7, 8].map(() => '---').join('|') + '|');
L.push('| buildings | ' + [1, 2, 3, 4, 5, 6, 7, 8].map((k) => (lv.get(k) ?? []).length).join(' | ') + ' |');
L.push('| of them rowhouse/house | ' + [1, 2, 3, 4, 5, 6, 7, 8].map((k) => (lv.get(k) ?? []).filter((r) => r.typeClass === 'rowhouse/house').length).join(' | ') + ' |');
const dh = rows.map((r) => r.facadeH + 0.7 - r.h);
L.push('');
L.push(`Heights: ${rows.filter((r) => r.est).length} estimated (${pct(rows.filter((r) => r.est).length)}), the rest lidar / mapped. Facade wall height from the storeys (facades.ts: ground floor 3.3 or 4.2 m + 3.2 m per upper storey + 0.7 m parapet) minus the data height: median ${q(dh, 0.5).toFixed(1)} m, 10-90 % ${q(dh, 0.1).toFixed(1)} to ${q(dh, 0.9).toFixed(1)} m (the exterior is drawn from levels, so interiors must use the same storey lines).`);
L.push('');
// doors, stoops, party walls
const noDoorWall = rows.filter((r) => r.nonParty === 0);
L.push(`Doors: ${rows.filter((r) => r.nonParty > 0).length} buildings have at least one non-party wall (facades.ts paints a door on the one nearest a street); ${noDoorWall.length} are walled in on every side (no painted door at all: ${noDoorWall.slice(0, 8).map((r) => r.id).join(', ')}${noDoorWall.length > 8 ? ', ...' : ''}). Street-facing front (probe within 9 m of a carriageway): ${rows.filter((r) => r.street).length} (${pct(rows.filter((r) => r.street).length)}); front wall more than 30 m from any street (back lots, courtyards, campus): ${rows.filter((r) => r.frontD > 30).length}.`);
L.push(`Stoops: ${rows.filter((r) => r.stoopType).length} footprints get the rowhouse stoop treatment (type house east of x = ${WEST_END_X}); nominal landing height 0.45-1.05 m above the pavement (the drawn rise follows the ground at the door, 0.2-2.4 m, else no steps). West End (x > ${WEST_END_X}, level entrances): ${rows.filter((r) => r.westEnd).length}.`);
const rs = rows.map((r) => r.rowSize);
L.push(`Party walls: ${rows.filter((r) => r.partyShare > 0).length} buildings (${pct(rows.filter((r) => r.partyShare > 0).length)}) share at least one wall; ${rows.filter((r) => r.partyShare >= 0.4).length} have 40 %+ of their perimeter shared. Terraces (buildings joined by walls): ${new Set(rows.map((r) => r.rowSize > 1 ? r.rowSize + ':' : null)).size - 1 >= 0 ? '' : ''}${rows.filter((r) => r.rowSize === 1).length} detached, ${rows.filter((r) => r.rowSize >= 2 && r.rowSize <= 5).length} in rows of 2-5, ${rows.filter((r) => r.rowSize > 5 && r.rowSize <= 20).length} in rows of 6-20, ${rows.filter((r) => r.rowSize > 20).length} in blocks of more than 20 joined footprints (largest ${Math.max(...rs)}).`);
L.push('');
// terrain
const fB = [[0, 0.5], [0.5, 1.5], [1.5, 3], [3, 6], [6, 1e9]];
L.push('| natural ground fall across the footprint m | ' + fB.map(([a, b]) => (b > 1e8 ? `>= ${a}` : `${a}-${b}`)).join(' | ') + ' |');
L.push('|---|' + fB.map(() => '---').join('|') + '|');
L.push('| buildings | ' + fB.map(([a, b]) => rows.filter((r) => r.fall >= a && r.fall < b).length).join(' | ') + ' |');
L.push('| of them rowhouse/house | ' + fB.map(([a, b]) => rows.filter((r) => r.fall >= a && r.fall < b && r.typeClass === 'rowhouse/house').length).join(' | ') + ' |');
const ff = rows.filter((r) => r.frontFall !== null).map((r) => r.frontFall);
L.push('');
L.push(`Street side vs the far corners: ground behind the front wall higher than the pavement by > 1.5 m (dug into the bank: back rooms below grade) ${ff.filter((x) => x > 1.5).length}; lower by > 1.5 m (garden or basement level at the back) ${ff.filter((x) => x < -1.5).length}; lower by > ${STOREY} m (a whole storey) ${ff.filter((x) => x < -STOREY).length}.`);
const fs = rows.filter((r) => r.frontSlope !== null);
L.push(`Pavement along the front wall (door bay at a wall end vs the wall's middle, where the ground floor level is set): differs by > 0.3 m ${fs.filter((r) => r.frontSlope > 0.3).length}, > 0.45 m (more than the controller's autostep) ${fs.filter((r) => r.frontSlope > 0.45).length}, > 1 m ${fs.filter((r) => r.frontSlope > 1).length} (of them rowhouse/house ${fs.filter((r) => r.frontSlope > 1 && r.typeClass === 'rowhouse/house').length}).`);
L.push(`Map edge: footprints within 1 m of the crop edge (cut by it) ${rows.filter((r) => r.edgeDist < 1).length}, within 20 m ${rows.filter((r) => r.edgeDist < 20).length}. Near a bridge / freeway deck line (candidates for buildingsUnderDecks, which drops those whose roof the deck would cut): ${rows.filter((r) => r.nearDeck).length}.`);
// stair feasibility (estimate on the min-area box, design numbers: 3.2 m storey = 17 risers of 0.188 m, goings 0.27 m;
// a straight flight with its landings needs 5.6 m x 0.95 m beside a room at least 2.4 m wide; a dogleg core 2.1 x 3.2 m)
const multi = rows.filter((r) => r.levels > 1 && r.cls !== 'shed/outbuilding' && r.cls !== 'open structure');
const straight = multi.filter((r) => r.len * Math.min(1, r.rect + 0.05) >= 5.6 && r.w >= 3.35);
const dogleg = multi.filter((r) => !straight.includes(r) && r.w >= 2.1 && r.len >= 3.2 && r.area >= 30);
L.push(`Stairs (estimate on each footprint's min box): ${multi.length} buildings have upper floors; a straight side flight fits ${straight.length}, only a dogleg core fits ${dogleg.length}, neither (upper floors would stay sealed) ${multi.length - straight.length - dogleg.length}.`);
L.push(`Big footprints (>= 1000 m2: campus halls, the harbour, the mall, hospital wings) ${rows.filter((r) => r.area >= 1000).length}; tall (>= 6 storeys) ${rows.filter((r) => r.levels >= 6).length}.`);
const text = L.join('\n');
console.log(text);
out.table = text;
out.byClass = Object.fromEntries(CLASS_ORDER.map((c) => [c, (cls.get(c) ?? []).length]));
out.byTypeClass = Object.fromEntries(CLASS_ORDER.map((c) => [c, (tcls.get(c) ?? []).length]));
out.samples = Object.fromEntries(CLASS_ORDER.map((c) => [c, (cls.get(c) ?? []).slice(0, 5).map((r) => ({ id: r.id, type: r.type, pois: r.pois, area: +r.area.toFixed(0), w: +r.w.toFixed(1), levels: r.levels }))]));
out.noDoorWall = noDoorWall.map((r) => r.id);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ ...out, rows: rows.map((r) => ({ ...r, area: +r.area.toFixed(1), w: +r.w.toFixed(2), len: +r.len.toFixed(2), rect: +r.rect.toFixed(3), partyShare: +r.partyShare.toFixed(3), frontD: +r.frontD.toFixed(1), fall: +r.fall.toFixed(2), frontFall: r.frontFall === null ? null : +r.frontFall.toFixed(2), frontSlope: r.frontSlope === null ? null : +r.frontSlope.toFixed(2), nominalStoop: +r.nominalStoop.toFixed(2), edgeDist: +r.edgeDist.toFixed(1), facadeH: +r.facadeH.toFixed(1) })) }, null, 0));
