// Geometry audit for the Georgetown world (world generator v2), run against the built preview page:
//   npm run build && node scripts/geoAudit.mjs [--out file.json]
// Casts Rapier rays down over a 1.5 m grid of the whole map and along every lane, and compares the colliders with
// heightAt / roadSurfaceAt (the functions everything in the game is placed with); checks lanes for steps and grade
// spikes; finds buildings that overlap carriageways, sidewalks, junctions or decks (footprint and physics box);
// finds floating, buried or misplaced props (trees, lamps, benches, signals, shelters, stoops). Prints a summary and
// writes the details as JSON. Exit code 1 on console errors only (the numbers are for a human to judge).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const outArg = process.argv.indexOf('--out');
const outFile = outArg >= 0 ? process.argv[outArg + 1] : null;
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(root, url.pathname === '/' ? 'preview.html' : url.pathname);
  try {
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/preview.html?view=aerial&quality=low`);
await page.waitForFunction(() => window.__geo && window.__geo.ready, null, { timeout: 180000 });

// ------------------------------------------------------------------------------------------------ in-page audit
const report = await page.evaluate(() => {
  const { geo: g, doc, castDownShape } = window.__geo;
  const K = { ROAD: 1, WALK: 2, BUILDING: 4, WATER: 8, WALL: 16, LOT: 32, PARK: 64, DECK: 128 };
  const TOL = 0.05;
  const Bd = g.bounds;
  const o2 = [0, 0];
  const r2 = (v) => Math.round(v * 100) / 100;
  const cls = {};
  const C = (name) => (cls[name] ??= { n: 0, bad: 0, bad15: 0, miss: 0, max: 0, maxAt: null, sumAbs: 0, cells: {} });
  const cellKey = (x, z) => `${Math.floor(x / 25) * 25},${Math.floor(z / 25) * 25}`;
  const rec = (name, x, z, err, note) => {
    const c = C(name);
    c.n++;
    if (!Number.isFinite(err)) {
      c.miss++;
      const k = cellKey(x, z);
      const m = ((c.missCells ??= {})[k] ??= { n: 0, at: [r2(x), r2(z), note ?? ''] });
      m.n++;
      return;
    }
    const a = Math.abs(err);
    c.sumAbs += a;
    if (a > c.max) { c.max = a; c.maxAt = [r2(x), r2(z), r2(err), note ?? '']; }
    if (a > TOL) {
      c.bad++;
      const k = cellKey(x, z);
      const cell = (c.cells[k] ??= { n: 0, max: 0, at: null });
      cell.n++;
      if (a > cell.max) { cell.max = a; cell.at = [r2(x), r2(z), r2(err), note ?? '']; }
    }
    if (a > 0.15) c.bad15++;
  };
  // ground-only ray (trimesh colliders), and the first hit of any kind
  const groundAt = (x, y, z) => {
    const w = window.__geo;
    return w.castGround ? w.castGround(x, y, z) : castDownShape(x, y, z, o2)[0];
  };

  // ---- 1. grid sweep: heightAt vs ground collider, per surface class; obstacles over walkable cells
  const obst = { boxOverWalk: {}, boxOverRoad: {}, cylOnRoad: {} };
  const addOb = (map, x, z, info) => { const k = cellKey(x, z); const c = (map[k] ??= { n: 0, at: [r2(x), r2(z)], info }); c.n++; };
  const STEP = 1.5;
  for (let z = Bd.z0 + 2.37; z < Bd.z1 - 2; z += STEP) {
    for (let x = Bd.x0 + 2.37; x < Bd.x1 - 2; x += STEP) {
      const k = g.kindAt(x, z), b = g.bandAt(x, z);
      if (k & (K.WATER | K.DECK)) continue;
      if (b === 4 || (k & K.BUILDING)) continue;
      let name;
      if (b === 1) name = 'road';
      else if (b === 2) name = k & K.LOT ? 'lot' : k & K.WALK ? 'walk' : 'flat-other';
      else if (b === 3) name = 'canal-bank';
      else name = k & K.PARK ? 'park' : k & K.WALK ? 'walk-on-terrain' : 'terrain';
      const h = g.heightAt(x, z);
      const y = groundAt(x, h + 1.2, z);
      if (Number.isFinite(y)) rec(name, x, z, y - h);
      else {
        // no ground under it: inside a building / shelter box (raster edge, harmless) or a real hole
        castDownShape(x, h + 1.2, z, o2);
        rec(o2[1] === 1 && o2[0] > h - 0.01 ? name + ':inBox' : name + ':HOLE', x, z, NaN);
      }
      // anything else standing here (boxes = buildings / shelters, cylinders = posts / trunks)
      castDownShape(x, h + 40, z, o2);
      if (o2[1] !== 6 && o2[0] > h + 0.5) {
        let nearB = false;
        for (let dz = -1.5; dz <= 1.5 && !nearB; dz += 0.75) for (let dx = -1.5; dx <= 1.5; dx += 0.75) if (g.kindAt(x + dx, z + dz) & K.BUILDING) { nearB = true; break; }
        if (o2[1] === 1 && (k & (K.WALK | K.LOT)) && !nearB) addOb(obst.boxOverWalk, x, z, `top ${r2(o2[0] - h)} m above`);
        if (o2[1] === 1 && (k & K.ROAD)) addOb(obst.boxOverRoad, x, z, `top ${r2(o2[0] - h)} m above`);
        if (o2[1] === 10 && b === 1) addOb(obst.cylOnRoad, x, z, `top ${r2(o2[0] - h)} m above`);
      }
    }
  }

  // ---- 2. kerb edges: 0.25 m either side of every kerb with a sidewalk (non-deck edges)
  const right = (c, i) => {
    const n = c.length / 3;
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = c[b * 3] - c[a * 3], tz = c[b * 3 + 2] - c[a * 3 + 2];
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    return [-tz, tx];
  };
  for (const r of g.roadPolys) {
    if (r.deck) continue;
    const c = r.centre, n = c.length / 3;
    let s = 0;
    for (let i = 1; i < n - 1; i++) {
      s += Math.hypot(c[i * 3] - c[i * 3 - 3], c[i * 3 + 2] - c[i * 3 - 1]);
      if (s < r.trimA + 1 || s > 1e9) continue;
      const [rx, rz] = right(c, i);
      for (const side of [-1, 1]) {
        if (!(side < 0 ? r.sidewalkL : r.sidewalkR)) continue;
        for (const off of [r.halfWidth - 0.25, r.halfWidth + 0.25, r.halfWidth + 0.6]) {
          const x = c[i * 3] + rx * off * side, z = c[i * 3 + 2] + rz * off * side;
          const k = g.kindAt(x, z);
          if (k & (K.DECK | K.BUILDING | K.WATER)) continue;
          const h = g.heightAt(x, z);
          rec(off < r.halfWidth ? 'kerb-road-side' : off < r.halfWidth + 0.5 ? 'kerb-walk-0.25' : 'kerb-walk-0.6', x, z, groundAt(x, h + 1.2, z) - h, r.name);
        }
      }
    }
  }

  // ---- 3. lanes: exported lane heights and roadSurfaceAt vs collider; steps and grades along every lane
  const steps = [], grades = [], laneHeight = [];
  const edgeGrade = [];
  for (const r of g.roadPolys) {
    let maxG = 0, maxGAt = null, maxCurv = 0, curvAt = null;
    for (const lane of r.lanes) {
      const p = lane.pts, n = p.length / 3;
      const hits = [], xs = [], zs = [];
      for (let i = 1; i < n; i++) {
        const ax = p[i * 3 - 3], ay = p[i * 3 - 2], az = p[i * 3 - 1], bx = p[i * 3], by = p[i * 3 + 1], bz = p[i * 3 + 2];
        const L = Math.hypot(bx - ax, bz - az);
        const m = Math.max(1, Math.ceil(L / 0.5));
        for (let q = i === 1 ? 0 : 1; q <= m; q++) {
          const t = q / m, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t;
          if (x < Bd.x0 + 3 || x > Bd.x1 - 3 || z < Bd.z0 + 3 || z > Bd.z1 - 3) continue;
          const hit = groundAt(x, y + 1.2, z);
          const sAt = g.roadSurfaceAt(x, z, y);
          rec(r.deck ? 'deck-lane-pts' : 'lane-pts', x, z, hit - y, r.name);
          rec(r.deck ? 'deck-roadSurfaceAt' : 'roadSurfaceAt', x, z, hit - sAt, r.name);
          if (!r.deck) rec('lane-heightAt', x, z, hit - g.heightAt(x, z), r.name);
          hits.push(hit); xs.push(x); zs.push(z);
        }
      }
      for (let i = 1; i < hits.length; i++) {
        const d = hits[i] - hits[i - 1];
        const L = Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
        if (Math.abs(d) > 0.15 && L < 0.8) steps.push([r.name || r.roadId, r2(xs[i]), r2(zs[i]), r2(d)]);
      }
      // grade over 4 m and its change over 8 m (vertical curvature: a crest that launches a car)
      let j = 0;
      const dist = [0];
      for (let i = 1; i < hits.length; i++) dist.push(dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]));
      const gr = new Array(hits.length).fill(NaN);
      for (let i = 0; i < hits.length; i++) {
        while (j < hits.length && dist[j] - dist[i] < 4) j++;
        if (j >= hits.length) break;
        gr[i] = (hits[j] - hits[i]) / (dist[j] - dist[i]);
        if (Math.abs(gr[i]) > maxG) { maxG = Math.abs(gr[i]); maxGAt = [r2(xs[i]), r2(zs[i])]; }
      }
      let k2 = 0;
      for (let i = 0; i < hits.length; i++) {
        while (k2 < hits.length && dist[k2] - dist[i] < 8) k2++;
        if (k2 >= hits.length || !Number.isFinite(gr[i]) || !Number.isFinite(gr[k2])) continue;
        const dc = Math.abs(gr[k2] - gr[i]);
        if (dc > maxCurv) { maxCurv = dc; curvAt = [r2(xs[i]), r2(zs[i])]; }
      }
    }
    edgeGrade.push({ name: r.name || r.roadId, edge: r.edge, deck: r.deck, maxGrade: r2(maxG), at: maxGAt, gradeChange8m: r2(maxCurv), curvAt });
  }
  edgeGrade.sort((a, b) => b.maxGrade - a.maxGrade);

  // ---- 4. deck sidewalks: walkSurfaceAt vs collider
  for (const r of g.roadPolys) {
    if (!r.deck) continue;
    const c = r.centre, n = c.length / 3;
    for (let i = 1; i < n - 1; i++) {
      const [rx, rz] = right(c, i);
      for (const side of [-1, 1]) {
        if (!(side < 0 ? r.sidewalkL : r.sidewalkR)) continue;
        const off = r.halfWidth + 1.5;
        const x = c[i * 3] + rx * off * side, z = c[i * 3 + 2] + rz * off * side, y = c[i * 3 + 1] + 0.15;
        if (x < Bd.x0 + 3 || x > Bd.x1 - 3 || z < Bd.z0 + 3 || z > Bd.z1 - 3) continue;
        const w = g.walkSurfaceAt(x, z, y);
        rec('deck-walkSurfaceAt', x, z, groundAt(x, y + 1.2, z) - w, r.name);
      }
    }
  }

  // ---- 5. junction surfaces (inside each outline)
  for (const j of g.junctions) {
    const O = j.outline, m = O.length / 2;
    if (m < 3) continue;
    for (let i = 0; i < m; i++) for (const f of [0.3, 0.65, 0.92]) {
      const x = j.x + (O[i * 2] - j.x) * f, z = j.z + (O[i * 2 + 1] - j.z) * f;
      const y = g.roadSurfaceAt(x, z, j.y);
      rec('junction', x, z, groundAt(x, y + 1.2, z) - y);
      rec('junction-node-y', x, z, groundAt(x, y + 1.2, z) - j.y);
    }
  }

  // ---- 6. lots: stall heights
  for (const l of g.lotStalls) {
    const s = l.stalls;
    for (let i = 0; i < s.length; i += 4) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      const hit = groundAt(x, y + 1.2, z);
      rec('lot-stall-y', x, z, hit - y, l.id);
      rec('lot-heightAt', x, z, hit - g.heightAt(x, z), l.id);
    }
  }

  // ---- 7. props: base vs the ground collider under them, and where they stand
  const props = {};
  const P = (name) => (props[name] ??= { n: 0, floating: [], buried: [], onRoad: [], inBuilding: [], inWater: [], maxFloat: 0, maxBury: 0 });
  const sinks = { 'trees-0': 0.1, 'trees-1': 0.1, 'trees-2': 0.1, 'gravestones': 0.05 };
  const checkProp = (name, x, y, z, sink) => {
    const p = P(name);
    p.n++;
    const k = g.kindAt(x, z);
    const hit = groundAt(x, y + sink + 1.5, z);
    const d = y + sink - hit; // + floating, - buried
    if (d > p.maxFloat) p.maxFloat = r2(d);
    if (d < p.maxBury) p.maxBury = r2(d);
    if (d > 0.05 && p.floating.length < 400) p.floating.push([r2(x), r2(z), r2(d)]);
    if (d < -0.25 && p.buried.length < 400) p.buried.push([r2(x), r2(z), r2(d)]);
    if ((k & K.ROAD) && !(k & K.DECK) && p.onRoad.length < 400) p.onRoad.push([r2(x), r2(z), g.bandAt(x, z)]);
    if ((k & K.BUILDING) && p.inBuilding.length < 400) p.inBuilding.push([r2(x), r2(z)]);
    if ((k & K.WATER) && !(k & K.DECK) && p.inWater.length < 400) p.inWater.push([r2(x), r2(z)]);
  };
  g.root.traverse((o) => {
    if (!o.isInstancedMesh || !/^(trees|lamp-poles|benches|signal-poles|stop-posts|bus-shelters|gravestones)/.test(o.name)) return;
    const a = o.instanceMatrix.array;
    const total = o.instanceMatrix.count;
    for (let i = 0; i < total; i++) checkProp(o.name.replace(/-\d$/, ''), a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14], sinks[o.name] ?? 0);
  });
  const st = g.audit?.stoops;
  if (st) for (let i = 0; i < st.length; i += 4) checkProp('stoop-bottom', st[i], st[i + 1], st[i + 2], 0);

  // ---- 8. buildings: footprint overlap with carriageways / sidewalks / junctions / lots / decks; physics box spill
  const segs = [];
  const SG = new Map();
  const gk = (i, j) => i * 100003 + j;
  g.roadPolys.forEach((r, ri) => {
    const c = r.centre;
    for (let i = 1; i < c.length / 3; i++) {
      const id = segs.length;
      segs.push([c[i * 3 - 3], c[i * 3 - 1], c[i * 3], c[i * 3 + 2], ri]);
      const pad = r.halfWidth + 5;
      for (let a = Math.floor((Math.min(c[i * 3 - 3], c[i * 3]) - pad) / 20); a <= Math.floor((Math.max(c[i * 3 - 3], c[i * 3]) + pad) / 20); a++)
        for (let b = Math.floor((Math.min(c[i * 3 - 1], c[i * 3 + 2]) - pad) / 20); b <= Math.floor((Math.max(c[i * 3 - 1], c[i * 3 + 2]) + pad) / 20); b++) {
          const key = gk(a, b);
          let l = SG.get(key);
          if (!l) SG.set(key, (l = []));
          l.push(id);
        }
    }
  });
  const nearest = (x, z) => {
    const l = SG.get(gk(Math.floor(x / 20), Math.floor(z / 20)));
    let best = null, bd = Infinity;
    if (!l) return null;
    for (const id of l) {
      const [ax, az, bx, bz, ri] = segs[id];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      const r = g.roadPolys[ri];
      const gap = d - r.halfWidth;
      if (gap < bd) { bd = gap; best = { r, gap, side: (x - ax) * -dz + (z - az) * dx > 0 ? 1 : -1 }; }
    }
    return best;
  };
  const inPoly = (x, z, pts) => {
    let ins = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  const SW = 3;
  const bOver = [], bBox = [];
  let built = 0, dropped = 0;
  for (const b of doc.buildings) {
    const P2 = b.pts;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P2) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    let bCells = 0, road = 0, walk = 0, walkProper = 0, lot = 0, deck = 0, junction = 0, maxRoad = 0, maxWalk = 0;
    const inside = [];
    for (let z = Math.ceil(z0 - Bd.z0) + Bd.z0; z <= z1; z += 1)
      for (let x = Math.ceil(x0 - Bd.x0) + Bd.x0; x <= x1; x += 1) {
        if (!inPoly(x, z, P2)) continue;
        inside.push([x, z]);
        const k = g.kindAt(x, z);
        if (k & K.BUILDING) bCells++;
      }
    if (!inside.length) continue;
    if (bCells === 0) { dropped++; continue; }
    built++;
    // sample the footprint densely (0.5 m) against the road geometry itself (not the raster)
    for (let z = z0 + 0.25; z <= z1; z += 0.5)
      for (let x = x0 + 0.25; x <= x1; x += 0.5) {
        if (!inPoly(x, z, P2)) continue;
        const k = g.kindAt(x, z);
        if (k & K.DECK) deck++;
        const nr = nearest(x, z);
        if (!nr) continue;
        if (nr.r.deck) continue;
        if (nr.gap < 0) { road++; maxRoad = Math.max(maxRoad, -nr.gap); continue; }
        const hasSw = nr.side > 0 ? nr.r.sidewalkR : nr.r.sidewalkL;
        if (hasSw && nr.gap < SW) { walkProper++; maxWalk = Math.max(maxWalk, SW - nr.gap); }
        if (k & K.WALK) walk++;
        if (k & K.LOT) lot++;
        if ((k & K.ROAD) && g.bandAt(x, z) === 1) junction++;
      }
    const [cx, cz] = [P2.reduce((s, p) => s + p[0], 0) / P2.length, P2.reduce((s, p) => s + p[1], 0) / P2.length];
    if (road || walkProper > 1 || junction || lot > 1)
      bOver.push({ id: b.id, type: b.type, at: [r2(cx), r2(cz)], roadCells: road / 4, maxIntoRoad: r2(maxRoad), sidewalkCells: walkProper / 4, maxIntoSidewalk: r2(maxWalk), junctionOrRasterRoad: junction / 4, lotCells: lot / 4, deckCells: deck / 4 });
    // physics box (same construction as facades.ts): first wall's axis, extents about the vertex mean (rectangles only)
    let w0 = null;
    for (let i = 0; i < P2.length; i++) {
      const p = P2[i], q = P2[(i + 1) % P2.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len >= 0.3) { w0 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len]; break; }
    }
    if (!w0) continue;
    const ux = w0[0], uz = w0[1], nx = -uz, nz = ux;
    let hu = 0, hv = 0;
    for (const p of P2) { hu = Math.max(hu, Math.abs((p[0] - cx) * ux + (p[1] - cz) * uz)); hv = Math.max(hv, Math.abs((p[0] - cx) * nx + (p[1] - cz) * nz)); }
    let spill = 0, spillWalk = 0, maxOut = 0;
    for (let u = -hu + 0.25; u < hu; u += 0.5)
      for (let v = -hv + 0.25; v < hv; v += 0.5) {
        const x = cx + ux * u + nx * v, z = cz + uz * u + nz * v;
        if (inPoly(x, z, P2)) continue;
        spill++;
        const k = g.kindAt(x, z);
        if ((k & (K.WALK | K.ROAD | K.LOT)) && !(k & K.BUILDING)) { spillWalk++; }
      }
    let area = 0;
    for (let i = 0, j = P2.length - 1; i < P2.length; j = i++) area += (P2[j][0] - P2[i][0]) * (P2[j][1] + P2[i][1]);
    area = Math.abs(area / 2);
    const boxArea = 4 * hu * hv;
    // facades.ts uses a footprint prism (exact) when the box would be bigger than the footprint
    if (boxArea > area * 1.01 + 0.5) continue;
    if (spillWalk > 2 || boxArea > area * 1.15 + 4)
      bBox.push({ id: b.id, type: b.type, at: [r2(cx), r2(cz)], verts: P2.length, area: Math.round(area), boxArea: Math.round(boxArea), spillM2: spill / 4, spillOverWalkableM2: spillWalk / 4 });
    void maxOut;
  }
  bOver.sort((a, b) => b.roadCells + b.sidewalkCells - (a.roadCells + a.sidewalkCells));
  bBox.sort((a, b) => b.spillOverWalkableM2 - a.spillOverWalkableM2);

  // ---- summaries
  const summary = {};
  for (const [k, c] of Object.entries(cls)) {
    const cells = Object.entries(c.cells).sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([key, v]) => ({ cell: key, n: v.n, worst: v.at }));
    const missCells = Object.entries(c.missCells ?? {}).sort((a, b) => b[1].n - a[1].n).slice(0, 25).map(([key, v]) => ({ cell: key, n: v.n, at: v.at }));
    summary[k] = { missCells, n: c.n, bad5cm: c.bad, bad15cm: c.bad15, miss: c.miss, meanAbsCm: r2((c.sumAbs / Math.max(1, c.n - c.miss)) * 100), maxM: r2(c.max), maxAt: c.maxAt, topCells: cells };
  }
  const obSum = {};
  for (const [k, m] of Object.entries(obst)) {
    const list = Object.entries(m).sort((a, b) => b[1].n - a[1].n);
    obSum[k] = { cells: list.length, samples: list.reduce((s, q) => s + q[1].n, 0), top: list.slice(0, 25).map(([key, v]) => ({ cell: key, n: v.n, at: v.at, info: v.info })) };
  }
  return { surfaces: summary, obstacles: obSum, steps: steps.slice(0, 200), stepCount: steps.length, edgeGrades: edgeGrade.slice(0, 40), props, buildings: { built, dropped, overlaps: bOver, overlapCount: bOver.length, boxes: bBox.slice(0, 80), boxCount: bBox.length }, laneHeight, grades };
});

// ------------------------------------------------------------------------------------------------ print
const S = report.surfaces;
console.log('surface heights vs ground colliders (5 cm tolerance)');
console.log('  class                      samples   >5cm   >15cm  miss  mean cm  max m   worst at');
for (const [k, v] of Object.entries(S)) console.log(`  ${k.padEnd(24)} ${String(v.n).padStart(9)} ${String(v.bad5cm).padStart(6)} ${String(v.bad15cm).padStart(7)} ${String(v.miss).padStart(5)} ${String(v.meanAbsCm).padStart(8)} ${String(v.maxM).padStart(6)}   ${JSON.stringify(v.maxAt)}`);
console.log('\nobstacles');
for (const [k, v] of Object.entries(report.obstacles)) console.log(`  ${k}: ${v.cells} 25 m cells, ${v.samples} samples; top ${JSON.stringify(v.top.slice(0, 6).map((t) => t.at))}`);
console.log(`\nsteps > 15 cm along lanes: ${report.stepCount}`);
for (const s of report.steps.slice(0, 15)) console.log('  ' + JSON.stringify(s));
console.log('\nsteepest edges (grade over 4 m, change of grade over 8 m)');
for (const e of report.edgeGrades.slice(0, 15)) console.log(`  ${e.name.padEnd(28)} edge ${String(e.edge).padStart(4)} ${e.deck ? 'deck' : '    '} grade ${(e.maxGrade * 100).toFixed(1)}% at ${JSON.stringify(e.at)}  dGrade ${(e.gradeChange8m * 100).toFixed(1)}% at ${JSON.stringify(e.curvAt)}`);
console.log('\nprops (base vs ground collider)');
for (const [k, p] of Object.entries(report.props)) console.log(`  ${k.padEnd(14)} n ${String(p.n).padStart(5)}  floating>5cm ${String(p.floating.length).padStart(4)} (max ${p.maxFloat})  buried>25cm ${String(p.buried.length).padStart(4)} (max ${p.maxBury})  onRoad ${p.onRoad.length}  inBuilding ${p.inBuilding.length}  inWater ${p.inWater.length}`);
const Bl = report.buildings;
console.log(`\nbuildings: ${Bl.built} built, ${Bl.dropped} dropped under decks; ${Bl.overlapCount} overlap roads / sidewalks / lots; ${Bl.boxCount} physics boxes bigger than the footprint`);
for (const b of Bl.overlaps.slice(0, 20)) console.log('  ' + JSON.stringify(b));
console.log('  boxes:');
for (const b of Bl.boxes.slice(0, 12)) console.log('  ' + JSON.stringify(b));
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 1));
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.join('\n')); process.exitCode = 1; }
else console.log('console clean');
await browser.close();
server.close();
