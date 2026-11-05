// Building entry audit (Stage A of the 2026-11-05 realism request): serves dist/, boots the game in headless Chromium
// and answers, from the running world, why buildings cannot be entered. Read-only: it changes nothing in the game.
//   node scripts/auditBuildings.mjs [outDir]      (default outDir: screenshots/)
// Env: MAP=grid for the grid city; W/H viewport (default 800x450); SHOTS=0 skips the screenshots (software GL is slow).
// What it does, in the page (window.__oc):
//  1. collider inventory: static colliders by solid kind, bodies, door colliders, door / interior objects in the scene;
//  2. every building: is a point 1.2 m above its floor inside a static collider (Rapier intersectionsWithPoint), and
//     what does a ray straight down from above hit first;
//  3. every place (POI) with a door on a footprint: a horizontal ray from the pavement to the door at 0.3, 1.0 and
//     1.8 m: what stops it and how far from the door;
//  4. painted stoop doors (facades.ts) against the doors the gameplay uses (Poi.door, georgetownMap.ts frontOf);
//  5. keyboard walks: the player stands on the pavement and holds W (tank controls) at a rowhouse stoop, a shop and an
//     office / apartment door, then presses E and jumps; per-frame character-controller collisions are tagged by kind;
//  6. Rapier step cost (profiler 'physics' section over 240 fixed steps) and collider counts;
//  7. screenshots of the stoop and the shop door, and from inside a rowhouse, with and without the F4 collision view.
// Prints one JSON line with everything and writes <outDir>/audit-buildings-<map>.json.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const outDir = resolve(process.argv[2] ?? 'screenshots');
mkdirSync(outDir, { recursive: true });
const MAP = process.env.MAP ?? 'georgetown';
const VW = Number(process.env.W ?? 800), VH = Number(process.env.H ?? 450);
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  try { const data = await readFile(p); res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.setDefaultTimeout(600000);
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/?map=${MAP}&quality=low&seed=123`);
await page.waitForFunction(() => window.__oc && window.__oc.time > 1, null, { timeout: 300000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__oc.started, null, { timeout: 300000 });

// ------------------------------------------------------------------------------------------------ in-page helpers
await page.evaluate(() => {
  const w = window.__oc, c = w.city, P = w.player, R = w.R;
  const hh = P.collider.halfHeight(), rad = P.collider.radius();
  const STATIC = (0xffff << 16) | 1; // query: every membership, filter = static colliders only
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const KINDS = ['untagged', 'ground', 'kerb', 'deck', 'parapet', 'stair', 'stairWall', 'stoop', 'stoopRail', 'building', 'tower', 'column', 'bridgePier', 'monument', 'railing', 'wall', 'canopy', 'pier', 'boat', 'lockGate', 'fountain', 'tree', 'lamp', 'signalPole', 'signPost', 'bench', 'busShelter', 'gravestone', 'container', 'kiosk', 'boundary', 'overhead', 'roof', 'decor', 'water', 'vehicle', 'item', 'person', 'bin', 'door'];
  const H = {};
  H.kind = (handle) => { const k = c.solidTags.get(handle); if (k >= 0) return KINDS[k] ?? `#${k}`; const o = w.colliderOwner?.get(handle); return o ? o.kind : 'dynamic/other'; };
  H.floor = (x, y, z, max = 80) => {
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z; ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const h = w.physics.castRay(ray, max, true, undefined, STATIC);
    return h ? { y: +(y - h.timeOfImpact).toFixed(2), kind: H.kind(h.collider.handle) } : null;
  };
  H.cast = (x, y, z, dx, dz, max) => {
    const l = Math.hypot(dx, dz) || 1;
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z; ray.dir.x = dx / l; ray.dir.y = 0; ray.dir.z = dz / l;
    const h = w.physics.castRay(ray, max, true, undefined, STATIC);
    return h ? { d: +h.timeOfImpact.toFixed(2), kind: H.kind(h.collider.handle) } : null;
  };
  H.inside = (x, y, z) => { const ks = []; w.physics.intersectionsWithPoint({ x, y, z }, (col) => { ks.push(H.kind(col.handle)); return true; }, undefined, STATIC); return ks; };
  H.feet = () => P.body.translation().y - hh - rad;
  H.pos = () => P.body.translation();
  H.put = (x, z, facing, from) => {
    const f = H.floor(x, from, z, 80);
    const y = (f ? f.y : c.heightAt(x, z)) + hh + rad + 0.03;
    P.body.setTranslation({ x, y, z }, true);
    P.body.setNextKinematicTranslation({ x, y, z });
    P.vy = 0; P.facing = facing; P.knockT = 0;
    w.input.keys.clear();
    window.__ocStep(20);
    return H.feet();
  };
  /** Hold keys for `sec` (fixed 60 Hz steps); returns path summary and the kinds the controller collided with. */
  H.hold = (keys, sec, onFrame) => {
    for (const k of keys) w.input.keys.add(k);
    const hits = {};
    const frames = Math.round(sec * 60);
    const p0 = { ...H.pos() };
    const path = [];
    for (let i = 0; i < frames; i++) {
      window.__ocStep(1);
      for (let j = 0, n = P.cc.numComputedCollisions(); j < n; j++) {
        const col = P.cc.computedCollision(j)?.collider;
        if (col) { const k = H.kind(col.handle); hits[k] = (hits[k] ?? 0) + 1; }
      }
      const t = H.pos();
      if (i % 15 === 0) path.push([+t.x.toFixed(2), +(t.y - hh - rad).toFixed(2), +t.z.toFixed(2)]);
      if (onFrame) onFrame(i / 60, t);
    }
    for (const k of keys) w.input.keys.delete(k);
    const p1 = H.pos();
    return { moved: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2), hits, path };
  };
  H.turnTo = (to) => {
    const d = Math.atan2(Math.sin(to - P.facing), Math.cos(to - P.facing));
    const key = d > 0 ? 'KeyA' : 'KeyD';
    w.input.keys.add(key); window.__ocStep(Math.round(Math.abs(d) / 3.0 * 60)); w.input.keys.delete(key);
    P.facing = to;
  };
  H.ringHas = (pts, x, z) => {
    let ins = false;
    for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++) {
      const xi = pts[i * 2], zi = pts[i * 2 + 1], xj = pts[j * 2], zj = pts[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  H.buildingAt = (x, z) => {
    for (let i = 0; i < c.buildings.length; i++) { const b = c.buildings[i]; if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue; if (H.ringHas(b.pts, x, z)) return i; }
    return -1;
  };
  /**
   * The facade point a place's door belongs to: Poi.door itself when it lies on a footprint (Georgetown), else the
   * first footprint met walking on from the pavement spot through the door point (the grid city's doors are points on
   * the pavement). Returns { x, z, ux, uz, L (pavement spot -> facade), building } or null.
   */
  H.facadeOf = (p) => {
    const dx = p.door.x - p.x, dz = p.door.z - p.z, L = Math.hypot(dx, dz);
    if (L < 0.05) return null;
    const ux = dx / L, uz = dz / L;
    let bi = H.buildingAt(p.door.x + ux * 0.6, p.door.z + uz * 0.6);
    if (bi >= 0) return { x: p.door.x, z: p.door.z, ux, uz, L, building: bi };
    for (let s = 0.1; s <= 10; s += 0.1) {
      bi = H.buildingAt(p.x + ux * s, p.z + uz * s);
      if (bi >= 0) return { x: p.x + ux * (s - 0.05), z: p.z + uz * (s - 0.05), ux, uz, L: s - 0.05, building: bi };
    }
    return null;
  };
  window.__ab = H;
});

const R = {};
// ------------------------------------------------------------------------------------------------ 1 + 2 + 3 + 4 + 6
Object.assign(R, await page.evaluate(() => {
  const w = window.__oc, c = w.city, H = window.__ab, geo = c.geo;
  const out = { map: c.id };
  // 1. inventory
  out.solidKinds = c.solidTags.counts();
  let fixed = 0, dyn = 0, kin = 0;
  w.physics.bodies.forEach((b) => { if (b.isFixed()) fixed++; else if (b.isKinematic()) kin++; else dyn++; });
  out.bodies = { fixed, dynamic: dyn, kinematic: kin, colliders: w.physics.colliders.len() };
  out.doorColliders = out.solidKinds.door ?? 0;
  const named = [];
  w.scene.traverse((o) => { if (/door|interior|room/i.test(o.name ?? '')) named.push(o.name); });
  out.sceneObjectsNamedDoorOrInterior = named.slice(0, 20);
  out.buildingsInMap = c.buildings.length;
  if (geo) out.droppedIds = [...geo.droppedBuildings];
  if (geo) out.geo = { colliders: geo.stats.colliders, trimeshTris: geo.stats.trimeshTris, tris: geo.stats.tris, meshes: geo.stats.meshes, bootMs: geo.stats.bootMs, buildingsPhaseMs: geo.stats.phases.buildings, physicsPhaseMs: geo.stats.phases.physics, clipped: geo.audit.buildingsClipped.length, dropped: geo.droppedBuildings.size, stoops: geo.audit.stoopInfo.length / 8 };
  out.items = { count: w.itemsState.items.length, ids: 'index in ItemsState.items (spawn order from the seed)', types: [...new Set(w.itemsState.items.map((i) => i.type))] };
  // 2. every building: solid inside?
  let solid1 = 0, solidMid = 0, roofFirst = 0, tested = 0, notSolid = [];
  const under = {};
  const STATIC = (0xffff << 16) | 1;
  const ray = new w.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const roofKinds = {};
  for (let i = 0; i < c.buildings.length; i++) {
    const b = c.buildings[i];
    // a point inside the footprint: the centroid, else the first triangle-ish probe that falls inside
    let x = 0, z = 0; const n = b.pts.length / 2;
    for (let k = 0; k < n; k++) { x += b.pts[k * 2] / n; z += b.pts[k * 2 + 1] / n; }
    if (!H.ringHas(b.pts, x, z)) {
      let ok = false;
      for (let k = 0; k < n && !ok; k++) {
        const mx = (b.pts[k * 2] + b.pts[((k + 1) % n) * 2]) / 2, mz = (b.pts[k * 2 + 1] + b.pts[((k + 1) % n) * 2 + 1]) / 2;
        for (const t of [0.15, 0.3]) { const px = mx + (x - mx) * t, pz = mz + (z - mz) * t; if (H.ringHas(b.pts, px, pz)) { x = px; z = pz; ok = true; break; } }
      }
      if (!ok) continue;
    }
    tested++;
    const g = c.heightAt(x, z);
    const k1 = H.inside(x, g + 1.2, z);
    if (k1.some((k) => k === 'building' || k === 'tower')) solid1++; else if (notSolid.length < 15) notSolid.push({ i, x: +x.toFixed(1), z: +z.toFixed(1), kinds: k1 });
    if (H.inside(x, g + Math.max(1.5, b.h * 0.5), z).some((k) => k === 'building' || k === 'tower')) solidMid++;
    const f = H.floor(x, g + 400, z, 600);
    if (f) { roofKinds[f.kind] = (roofKinds[f.kind] ?? 0) + 1; if (f.kind === 'building' || f.kind === 'tower') roofFirst++; }
    // what would hold the player up if the building's solid were simply removed: the first static surface below
    // 1.2 m above the ground, ignoring building / tower colliders
    ray.origin.x = x; ray.origin.y = g + 1.2; ray.origin.z = z; ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const u = w.physics.castRay(ray, 60, true, undefined, STATIC, undefined, undefined, (col) => { const k = H.kind(col.handle); return k !== 'building' && k !== 'tower'; });
    const uk = u ? H.kind(u.collider.handle) : 'nothing';
    const gap = u ? 1.2 - u.timeOfImpact : null; // surface height relative to map.heightAt there
    const key = u ? `${uk}${Math.abs(gap) < 0.3 ? ' (at ground level)' : gap < 0 ? ' (more than 0.3 m below)' : ' (above)'}` : 'nothing';
    under[key] = (under[key] ?? 0) + 1;
  }
  out.solidity = { tested, pointAt1p2mInsideBuildingCollider: solid1, pointAtHalfHeightInside: solidMid, rayFromAboveFirstHit: roofKinds, rayFromAboveHitsBuildingFirst: roofFirst, floorUnderIfSolidRemoved: under, notSolidSamples: notSolid };
  // 3. POI doors: ray from the pavement through the door
  const doorRays = { tested: 0, blockedAtFacade: 0, open: 0, byKind: {}, gaps: [], samples: [], notBlocked: [] };
  for (const p of c.pois) {
    const f = H.facadeOf(p);
    if (!f || f.L < 0.3 || f.L > 8) continue; // not a building door
    const L = f.L, ux = f.ux, uz = f.uz;
    doorRays.tested++;
    const y = c.heightAt(p.x, p.z);
    const hs = [0.3, 1.0, 1.8].map((h) => H.cast(p.x, y + h, p.z, ux, uz, L + 3));
    const h1 = hs[1];
    if (h1) { doorRays.byKind[h1.kind] = (doorRays.byKind[h1.kind] ?? 0) + 1; doorRays.gaps.push(+(h1.d - L).toFixed(2)); }
    if (hs.every((h) => h && h.d <= L + 0.35)) doorRays.blockedAtFacade++;
    else if (doorRays.notBlocked.length < 20) doorRays.notBlocked.push({ name: p.name, kind: p.kind, cat: p.cat ?? null, street: p.street, at: [+p.x.toFixed(1), +p.z.toFixed(1)], doorDist: +L.toFixed(2), i: f.building, hits: hs });
    if (hs.some((h) => !h)) doorRays.open++;
    if (doorRays.samples.length < 6) doorRays.samples.push({ name: p.name, kind: p.kind, street: p.street, doorDist: +L.toFixed(2), hits: hs });
  }
  const gs = doorRays.gaps.sort((a, b) => a - b);
  doorRays.gapToDoorM = gs.length ? { p10: gs[Math.floor(gs.length * 0.1)], median: gs[gs.length >> 1], p90: gs[Math.floor(gs.length * 0.9)] } : null;
  delete doorRays.gaps;
  out.doorRays = doorRays;
  // 4. painted stoop doors vs gameplay doors (Poi.door) in the same building
  if (geo) {
    const S = geo.audit.stoopInfo;
    const stoopDoor = new Map();
    for (let i = 0; i < S.length; i += 8) {
      const bi = H.buildingAt(S[i] - S[i + 3] * 0.5, S[i + 1] - S[i + 4] * 0.5);
      if (bi >= 0 && !stoopDoor.has(bi)) stoopDoor.set(bi, [S[i], S[i + 1]]);
    }
    const ds = [];
    let sameBuilding = 0;
    for (const p of c.pois) {
      const dx = p.door.x - p.x, dz = p.door.z - p.z, L = Math.hypot(dx, dz) || 1;
      const bi = H.buildingAt(p.door.x + (dx / L) * 0.6, p.door.z + (dz / L) * 0.6);
      const sd = stoopDoor.get(bi);
      if (!sd) continue;
      sameBuilding++;
      ds.push(Math.hypot(sd[0] - p.door.x, sd[1] - p.door.z));
    }
    ds.sort((a, b) => a - b);
    out.stoopVsPoiDoor = { buildingsWithStoop: stoopDoor.size, poisInThoseBuildings: sameBuilding, distM: ds.length ? { min: +ds[0].toFixed(2), median: +ds[ds.length >> 1].toFixed(2), max: +ds[ds.length - 1].toFixed(2), over1m: ds.filter((d) => d > 1).length } : null };
  }
  // 6. physics step cost and collider count
  const iP = w.prof.names.indexOf('physics');
  w.prof.startFrame();
  const t0 = performance.now();
  window.__ocStep(240);
  const simMs = (performance.now() - t0) / 240;
  out.physicsStep = { msPerStep: +(w.prof.cur[iP] / 240).toFixed(3), simStepMs: +simMs.toFixed(3), note: '240 fixed 60 Hz steps (player, vehicles, traffic, police, physics.step, crashes), no rendering' };
  return out;
}));

// ------------------------------------------------------------------------------------------------ 5. keyboard walks
R.walks = await page.evaluate((isGeo) => {
  const w = window.__oc, c = w.city, P = w.player, H = window.__ab, geo = c.geo;
  const face = (ux, uz) => Math.atan2(ux, uz);
  const res = [];
  const tryDoor = (label, doorX, doorZ, nx, nz, startOut, extra) => {
    // stand on the pavement startOut metres out from the door, facing it; hold W (walk), then Shift+W (run), then E,
    // then Space+W (jump at the door). Inside = behind the facade line ((p - door) . n < 0).
    const sx = doorX + nx * startOut, sz = doorZ + nz * startOut;
    const f0 = H.put(sx, sz, face(-nx, -nz), c.heightAt(sx, sz) + 3);
    let deepest = Infinity;
    const track = (t, p) => { const s = (p.x - doorX) * nx + (p.z - doorZ) * nz; if (s < deepest) deepest = s; };
    const walkW = H.hold(['KeyW'], Math.max(2.5, startOut / 4.2 + 1.5), track);
    const atDoor = H.pos();
    const gapWalk = (atDoor.x - doorX) * nx + (atDoor.z - doorZ) * nz;
    const runW = H.hold(['KeyW', 'ShiftLeft'], 1.5, track);
    window.__ocStep(1);
    const promptAtDoor = P.prompt;
    const before = { ...H.pos() };
    w.input.pressed.add('KeyE');
    window.__ocStep(2);
    const after = H.pos();
    const eMoved = +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2);
    w.input.pressed.add('Space');
    const jumpW = H.hold(['KeyW'], 1.2, track);
    const fin = H.pos();
    // what is right in front of the player at chest height
    const ahead = H.cast(fin.x, H.feet() + 1.0, fin.z, -nx, -nz, 3);
    res.push({
      label, ...extra, door: [+doorX.toFixed(1), +doorZ.toFixed(1)], startOutM: startOut, feetStart: +f0.toFixed(2),
      walk: { moved: walkW.moved, hits: walkW.hits, path: walkW.path }, gapToFacadeAfterWalkM: +gapWalk.toFixed(2),
      run: { moved: runW.moved, hits: runW.hits }, jump: { moved: jumpW.moved, hits: jumpW.hits },
      deepestBehindFacadeLineM: +(-deepest).toFixed(2), finalGapM: +(((fin.x - doorX) * nx + (fin.z - doorZ) * nz)).toFixed(2),
      promptAtDoor, eMovedM: eMoved, aheadAtChest: ahead, inVehicle: !!P.vehicle, chatOpen: w.chat.open,
      insidePointBehindDoor: H.inside(doorX - nx * 1.0, c.heightAt(doorX + nx * 1.5, doorZ + nz * 1.5) + 1.2, doorZ - nz * 1.0),
    });
    if (w.chat.open) { w.chat.open = false; }
  };
  if (isGeo) {
    // a rowhouse stoop near the spawn with 4-7 steps and open pavement in front
    const S = geo.audit.stoopInfo;
    let best = -1, bd = Infinity;
    for (let i = 0; i < S.length; i += 8) {
      if (S[i + 7] < 4 || S[i + 7] > 7) continue;
      const fx = S[i] + S[i + 3] * (S[i + 5] + 1.5), fz = S[i + 1] + S[i + 4] * (S[i + 5] + 1.5);
      if (c.isBlocked(fx, fz) || c.isRoad(fx, fz)) continue;
      const d = Math.hypot(S[i] - c.spawn.x, S[i + 1] - c.spawn.z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      const [dx, dz, y0, nx, nz, outN, gy, steps] = Array.from(S.slice(best, best + 8));
      tryDoor('rowhouse stoop door', dx, dz, nx, nz, outN + 1.3, { building: H.buildingAt(dx - nx * 0.5, dz - nz * 0.5), landingY: +y0.toFixed(2), pavementY: +gy.toFixed(2), steps });
      window.__abStoop = { dx, dz, nx, nz, outN, y0 };
    }
  }
  // a signed shop (cafe / shop / diner) and an office or apartment door, nearest the spawn
  const pick = (kinds, signed) => {
    let b = null, bd = Infinity;
    for (const p of c.pois) {
      if (!kinds.includes(p.kind) || (signed && !p.signed)) continue;
      const f = H.facadeOf(p);
      if (!f || f.L < 0.8 || f.L > 4) continue;
      const d = Math.hypot(p.x - c.spawn.x, p.z - c.spawn.z);
      if (d < bd) { bd = d; b = p; }
    }
    return b;
  };
  for (const [label, kinds, signed] of [['shop door', ['shop', 'cafe', 'diner', 'bar'], true], ['office / apartment door', ['office', 'apartment', 'hotel'], false]]) {
    const p = pick(kinds, signed);
    if (!p) continue;
    const f = H.facadeOf(p);
    tryDoor(label, f.x, f.z, -f.ux, -f.uz, f.L + 1.5, { poi: p.name, poiKind: p.kind, cat: p.cat ?? null, street: p.street, building: f.building, doorIsPavementPoint: Math.abs(f.L - Math.hypot(p.door.x - p.x, p.door.z - p.z)) > 0.01, poiDoorToFacadeM: +(f.L - Math.hypot(p.door.x - p.x, p.door.z - p.z)).toFixed(2) });
    if (label === 'shop door') window.__abShop = { dx: f.x, dz: f.z, nx: -f.ux, nz: -f.uz };
  }
  return res;
}, MAP === 'georgetown');

// ------------------------------------------------------------------------------------------------ 7. screenshots
R.shots = [];
if (process.env.SHOTS !== '0') {
  // stoop / shop: from the street, the player standing against the door after the keyboard walk; inside: the camera
  // 2.5 m behind the rowhouse door at head height, looking deeper into the footprint (what a room would show)
  for (const which of ['stoop', 'shop', 'inside']) {
    const ok = await page.evaluate((which) => {
      const w = window.__oc, c = w.city, P = w.player, H = window.__ab;
      const s = which === 'shop' ? window.__abShop : window.__abStoop;
      if (!s) return false;
      w.dayNight.hour = 12.5;
      const out = which === 'shop' ? 0.45 : s.outN + 1.0;
      H.put(s.dx + s.nx * out, s.dz + s.nz * out, Math.atan2(-s.nx, -s.nz), c.heightAt(s.dx + s.nx * out, s.dz + s.nz * out) + 3);
      if (which !== 'shop') { H.hold(['KeyW'], 2.5); } // up the stoop to the door, by key
      const fy = H.feet();
      const ex = -s.nz, ez = s.nx;
      if (which === 'stoop') w.cam.override = { px: s.dx + s.nx * 6 + ex * 2.5, py: fy + 2.6, pz: s.dz + s.nz * 6 + ez * 2.5, lx: s.dx, ly: fy + 1.2, lz: s.dz };
      else if (which === 'shop') w.cam.override = { px: s.dx + s.nx * 5 + ex * 1.5, py: fy + 2.2, pz: s.dz + s.nz * 5 + ez * 1.5, lx: s.dx, ly: fy + 1.3, lz: s.dz };
      else w.cam.override = { px: s.dx - s.nx * 2.5, py: s.y0 + 1.6, pz: s.dz - s.nz * 2.5, lx: s.dx - s.nx * 8, ly: s.y0 + 1.2, lz: s.dz - s.nz * 8 };
      window.__ocFrames(2, true);
      return true;
    }, which);
    if (!ok) continue;
    for (const f4 of [false, true]) {
      await page.evaluate((f4) => { const w = window.__oc; if (w.physDebug.on !== f4) w.input.pressed.add('F4'); window.__ocFrames(1, true); w.physDebug.nextAt = 0; window.__ocFrames(3, true); }, f4);
      const path = join(outDir, `40-audit-buildings-${MAP}-${which}${f4 ? '-f4' : ''}.png`);
      try { await page.screenshot({ path, timeout: 600000 }); R.shots.push(path); } catch (e) { R.shots.push(`FAILED ${path}: ${e.message.split('\n')[0]}`); }
    }
    await page.evaluate(() => { const w = window.__oc; if (w.physDebug.on) { w.input.pressed.add('F4'); window.__ocFrames(1, true); } w.cam.override = null; });
  }
}

// building index (CityMap.buildings) -> data id: the map keeps the data's order minus the buildings dropped under decks
if (R.droppedIds) {
  const D = (f) => JSON.parse(readFileSync(resolve('src/data', f), 'utf8'));
  const all = D('georgetown.json').buildings.concat(D('georgetown-buildings-ccby.json').buildings);
  const drop = new Set(R.droppedIds);
  const standing = all.filter((b) => !drop.has(b.id));
  const idOf = (i) => (i >= 0 && standing[i] ? `${standing[i].id} (${standing[i].type}, ${standing[i].levels} storeys)` : null);
  for (const s of R.solidity.notSolidSamples) s.id = idOf(s.i);
  for (const s of R.doorRays.notBlocked) s.id = idOf(s.i);
  for (const wk of R.walks) wk.buildingId = idOf(wk.building);
}
R.console = consoleMsgs.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
R.conditions = { viewport: `${VW}x${VH}`, quality: 'low', seed: 123, browser: `headless Chromium ${browser.version()} (SwiftShader software GL)` };
await writeFile(join(outDir, `audit-buildings-${MAP}.json`), JSON.stringify(R, null, 1));
console.log(JSON.stringify(R));
await browser.close();
server.close();
