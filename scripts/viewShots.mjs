// Reproducible BEFORE/AFTER views of the running game (the real Georgetown map), for judging the look.
//
//   node scripts/viewShots.mjs --dist <folder> --prefix <name> [options] [view ...]
//   e.g. node scripts/viewShots.mjs --dist /path/to/before-dist --prefix 40-before
//        node scripts/viewShots.mjs --dist dist --prefix 41-after rep road-far
//
// Writes <out>/<prefix>-<view>.png (default out: screenshots/) and prints draw calls, triangles, the capture frame's CPU
// ms and the console errors per view. The dist folder is served read-only (files are only read). Exit code 1 on any
// console error or warning (same filter as shot.mjs).
//
// Options:
//   --quality low|medium|high  graphics preset through ?quality= (default medium)
//   --hd                       1920x1080 instead of 1280x720 (device pixel ratio 1 either way)
//   --seed <n>                 ?seed= (default 1; the seed varies cars, people and shop names, never the map)
//   --hour <h>                 game time for every view (default 11, late morning; a view may pin its own)
//   --weather <kind>           clear (default), cloudy, fog, rain, storm, snow
//   --settle <s>               simulated seconds after moving to a view, before the capture (default 20)
//   --out <dir>                output folder (default screenshots)
//   --exp <file.js>            experiments: the file's text is the body of a function (w, view, variant) run in the
//                              page right before each capture (w = window.__oc). A view may be named <view>@<variant>
//                              (file <prefix>-<view>-<variant>.png) to capture the same view several ways in one run.
//                              Whatever the function puts in window.__vsNote is printed. Used by docs/visual-audit.md
//                              to toggle mipmaps, normal maps, exposure, sun, sky light, etc. without rebuilding.
//   --follow-ground            ignore the views' pinned camera heights and put the camera at its height above the
//                              ground of the build being shot (use when a build deliberately moves the ground)
//   --json <file>              also write the per-view stats as JSON
//   --list                     print the views and exit
//
// How a view is made (identical for every build, using only hooks that the BEFORE preview build c109c1c already has:
// window.__oc (the World), __ocRun, __ocFrames and World.cam.override):
//  1. Math.random is replaced by a fixed-seed generator before the game loads, and requestAnimationFrame is gated, so
//     the game's own loop never runs a frame (held from the moment the game publishes __oc) and this script steps every
//     frame itself with fixed steps (__ocRun: simulate without drawing; __ocFrames(1, true): one whole drawn frame).
//     Nothing advances between steps, and two runs of the same build give the same pixels.
//  2. The game is marked started (people and jobs run; no HUD is shown), the weather is forced and held, the clock is
//     reset to the view's hour after every simulated second (so it stays within one game minute of it).
//  3. The (hidden) player is moved to the ground under the camera, because traffic, parked-car stand-ins and the
//     crowd are all centred on the player; the crowd and traffic then settle for --settle seconds.
//  4. The camera is fixed (World.cam.override) at the view's position and look-at, FOV set, the player hidden; views
//     may hide traffic or stand a few people at fixed spots; the sky light (PMREM) is recaptured for the final sun.
//  5. Two drawn frames (the first lets chunk LOD and near trees follow the camera), and the canvas of the second is
//     read back in the same task (toDataURL), so no HUD or DOM overlay is in the picture.
//
// Views (x east, z south, y up, metres; heights are above the ground under the point unless abs):
//  rep      M St NW, 3200 block (between Wisconsin Ave and Potomac St): north pavement at the kerb, x=-277.3, z=141.0,
//           eye 1.7 m, half way between two street trees, a lamp 10 m behind, a parked car just behind on the right,
//           looking east along the street (towards Wisconsin Ave). THE representative street: on the spawn street
//           (M St NW, ~370 m east of the spawn at -648, 170), and the block with the most of what the owner judges at
//           once: in a scan of every 60 m of 13 streets (trees, parked cars, shops, buildings within 35 m), the stretch
//           at (-266, 150) has the most street trees (10) and parked cars (16) of all of M St, 15 shops and offices in
//           14 two- to four-storey Federal rowhouse fronts, lamps, a 4-lane carriageway with markings, and the busiest
//           pavements (M St at lunch is the crowd's busiest place).
//  street2  N St NW, 3300 block (residential rowhouses with stoops), south pavement at x=-446, z=-27.2, looking west
//           uphill along the street (no data trees on this block).
//  street3  Wisconsin Ave NW between M St and Prospect St (main shopping street), east pavement at x=-147, z=104.5,
//           looking north uphill with trees and shops on both sides.
//  door     a rowhouse front door with a five-step stoop and iron rails, 3324 N St NW area (door at x=-512.1, z=-21.2,
//           landing 28.5 m), from the pavement 4 m in front at eye height.
//  people   six people standing on the M St north pavement 4-8 m from the camera (placed at fixed spots, idle).
//  (door, car and tree leave the crowd out of the picture: a passer-by in front of the lens is chance, not content.)
//  car      a parked sedan on M St (kerbside, north kerb at x=-241, z=141.4) from 5 m, three-quarter front view.
//  tree     a street tree on M St (x=-271.3, z=140.2) from 6 m, seen from the pavement to its east (FOV 70 so the whole
//           crown and the trunk's foot are in the frame).
//  road-far M St carriageway at eye height (1.7 m) from x=-300 looking east: the road recedes past 200 m (the
//           "television static" test). Traffic hidden.
//  aerial   190 m up over the waterfront, looking north-east at M St and Wisconsin Ave (the rep block in the middle).
//  spawn    what the game shows on start: the player at the spawn (Key Bridge end of M St) with the normal follow
//           camera (the player visible; HUD still left out).
// Extra views (only when named; not in the default list): the M St / Wisconsin Ave junction, where the overlap probe
// (viewExperiments.js zfight) finds markings under another road surface:
//  junction      from the south-west corner pavement (x=-182, z=157.5) at eye height, looking north-east across it.
//  junction-top  45 m above the junction (abs), looking down at it steeply.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

// at: [camera y, look-at y], absolute, pinned to what the base build (s1-integrate 7183f1f) gives for the heights above
// the ground, so every build is shot from exactly the same point (the BEFORE build's ground differs by up to 6 cm).
export const VIEWS = {
  rep: { pos: [-277.3, 1.7, 141.0], look: [-200, 2.8, 151.5], fov: 62, at: [22.743, 24.016] },
  street2: { pos: [-446, 1.7, -27.2], look: [-560, 5, -35], fov: 62, at: [27.023, 33.889] },
  street3: { pos: [-147, 1.7, 104.5], look: [-158, 6, 20], fov: 62, at: [24.315, 31.756] },
  door: { pos: [-512.12, 1.6, -25.2], look: [-512.12, 2.0, -21.2], fov: 62, lookRel: [-512.12, -25.2], hidePeople: true, at: [29.185, 29.585] },
  people: {
    pos: [-267.5, 1.65, 140.6], look: [-259.5, 1.0, 139.0], fov: 55, at: [22.775, 22.130],
    peds: [[-263.4, 139.5, -1.2], [-262.0, 138.3, 1.6], [-261.2, 140.9, -2.0], [-260.4, 138.7, -0.9], [-264.6, 138.0, 0.4], [-262.8, 141.4, 1.9]],
  },
  car: { pos: [-245, 1.6, 138.4], look: [-241, 0.7, 141.4], fov: 55, lookRel: [-245, 138.4], hidePeople: true, at: [23.018, 22.118] },
  tree: { pos: [-265.4, 1.6, 139.3], look: [-271.3, 3.6, 140.2], fov: 70, lookRel: [-265.4, 139.3], hidePeople: true, at: [22.720, 24.720] },
  'road-far': { pos: [-300, 1.7, 147.3], look: [-80, 1.7, 145.4], fov: 62, hideTraffic: true, lookRel: [-300, 147.3], at: [22.243, 22.243] },
  aerial: { pos: [-420, 190, 380], look: [-200, 21, 140], fov: 55, abs: true },
  spawn: { player: true },
  junction: { pos: [-182, 1.7, 157.5], look: [-150, 0.5, 141], fov: 62, extra: true },
  'junction-top': { pos: [-157, 66, 172], look: [-157, 21, 146], fov: 55, abs: true, hideTraffic: true, extra: true },
};

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
if (flag('list')) { for (const [k, v] of Object.entries(VIEWS)) console.log(k.padEnd(9), JSON.stringify(v)); process.exit(0); }
const dist = resolve(opt('dist', 'dist'));
const prefix = opt('prefix', 'view');
const quality = opt('quality', 'medium');
const hd = flag('hd');
const seed = opt('seed', '1');
const hourOpt = Number(opt('hour', '11'));
const weather = opt('weather', 'clear');
const settle = Number(opt('settle', '20'));
const followGround = flag('follow-ground');
const outDir = resolve(opt('out', 'screenshots'));
const expFile = opt('exp', null);
const jsonOut = opt('json', null);
const map = opt('map', '');
const views = args.length ? args : Object.keys(VIEWS).filter((v) => v !== 'spawn' && !VIEWS[v].extra);
for (const v of views) if (!VIEWS[v.split('@')[0]]) throw new Error(`unknown view ${v} (try --list)`);
const exp = expFile ? await readFile(expFile, 'utf8') : null;

// ------------------------------------------------------------------------------------- read-only static server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = resolve(join(dist, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname)));
  if (p !== dist && !p.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
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

const W = hd ? 1920 : 1280, H = hd ? 1080 : 720;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(900000); // software GL on a shared machine: a PBR frame can take a minute
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
// fixed-seed Math.random and a gate on the game loop (see the header)
await page.addInitScript(() => {
  let s = 0x2545f491;
  Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const raf = window.requestAnimationFrame.bind(window);
  window.__vsHold = false;
  // the game's own loop never runs: from the moment the game publishes window.__oc (right before its first frame) every
  // frame callback is held, so the whole simulation is stepped by this script with fixed steps (no wall-clock frames
  // with real dt between boot and the first view, which made traffic and the crowd differ from run to run)
  window.requestAnimationFrame = (cb) => raf((t) => { if (window.__vsHold || window.__oc) window.requestAnimationFrame(cb); else cb(t); });
});
const params = [`seed=${seed}`, `quality=${quality}`, map ? `map=${encodeURIComponent(map)}` : ''].filter(Boolean).join('&');
const t0 = Date.now();
await page.goto(`http://localhost:${port}/?${params}`);
// polled on a timer: the default polling runs on requestAnimationFrame, which the gate holds once __oc exists
await page.waitForFunction(() => window.__oc && typeof window.__ocFrames === 'function' && typeof window.__ocRun === 'function', null, { timeout: 900000, polling: 250 });
const info = await page.evaluate(() => {
  window.__vsHold = true;
  const w = window.__oc;
  w.started = true; // people, jobs and theft run; the HUD, minimap and hotbar stay hidden (they are shown by the start key)
  const r = w.renderer, gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    map: w.city.id, look: w.look ? { ...w.look.stats, quality: w.look.quality } : null, quality: w.settings.quality,
    pixelRatio: r.getPixelRatio(), canvas: [r.domElement.width, r.domElement.height],
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace,
  };
});
console.log(`${dist}\n  boot ${Date.now() - t0} ms, map ${info.map}, preset ${info.quality}, canvas ${info.canvas.join('x')} @${info.pixelRatio}, ${info.gpu}`);
await mkdir(outDir, { recursive: true });

const results = [];
let first = true;
let lastBase = '';
for (const full of views) {
  const [name, variant = ''] = full.split('@');
  const v = VIEWS[name];
  const hour = v.hour ?? hourOpt;
  const tv = Date.now();
  // the crowd starts round the spawn: the first view waits longer for it to fill in round the new place; a variant of
  // the view just shot needs no settling at all (same place, same moment)
  const settleNow = name === lastBase && variant ? 0 : settle + (first ? 20 : 0);
  first = false;
  lastBase = name;
  // move there, hold weather and clock, settle
  await page.evaluate(({ v, hour, weather }) => {
    const w = window.__oc, c = w.city;
    w.weather.kind = weather; w.weather.timer = 1e9;
    w.dayNight.hour = hour;
    if (!v.player) {
      // the player stands on the ground under the camera (on the deck the camera is over, if any)
      const [x, py, z] = v.pos;
      const y = v.abs ? c.heightAt(x, z) : c.heightAt(x, z, c.heightAt(x, z) + py);
      w.player.body.setTranslation({ x, y: y + 1.2, z }, true);
    } else {
      const s = c.spawn;
      w.player.body.setTranslation({ x: s.x, y: c.heightAt(s.x, s.z) + 1.2, z: s.z }, true);
      w.player.facing = s.heading;
      w.cam.yaw = Math.PI / 2;
    }
  }, { v, hour, weather });
  for (let k = 0; k < settleNow; k++) {
    await page.evaluate(({ hour, weather }) => {
      const w = window.__oc;
      w.dayNight.hour = hour;
      w.weather.kind = weather; w.weather.timer = 1e9;
      window.__ocRun(1, 30);
    }, { hour, weather });
  }
  // fix the camera, people, traffic; force the weather look and the sky light for the final sun
  await page.evaluate(({ v, hour, weather, followGround }) => {
    const w = window.__oc, c = w.city;
    const L = { clear: { cloud: 0, fogFar: 750, rain: 0, snow: 0, wet: 0, grip: 1 } }[weather];
    if (L) { Object.assign(w.weather.look, L); w.weather.snowCover = 0; }
    w.dayNight.hour = hour;
    const env = w.dayNight.env;
    if (env) { env.last.at = -1e9; env.last.dir.set(0, -1, 0); }
    // the clouds drift with the game clock: pin the sky's clock so every view has the same sky whatever its place in
    // the run (the sky light is captured from the same sky)
    const su = env?.uniforms?.time;
    if (su && !su.__vsPinned) { Object.defineProperty(su, 'value', { get: () => 60, set: () => {}, configurable: true }); su.__vsPinned = true; }
    if (v.player) { w.cam.override = null; w.player.mesh.visible = true; return; }
    const [px, py, pz] = v.pos, [lx, ly, lz] = v.look;
    // camera and look-at heights: absolute for abs views; the pinned absolute heights (v.at) when the view has them
    // (the same pixels in every build, even where a build moves the ground by a few cm); otherwise above the ground
    let camY, lookY;
    if (v.abs) { camY = py; lookY = ly; }
    else if (v.at && !followGround) { [camY, lookY] = v.at; }
    else {
      camY = c.heightAt(px, pz, c.heightAt(px, pz) + py) + py;
      lookY = (v.lookRel ? c.heightAt(v.lookRel[0], v.lookRel[1]) : c.heightAt(lx, lz)) + ly;
    }
    w.cam.override = { px, py: camY, pz, lx, ly: lookY, lz };
    w.camera.position.set(px, camY, pz);
    w.camera.lookAt(lx, lookY, lz);
    w.camera.fov = v.fov ?? 62;
    w.camera.updateProjectionMatrix();
    w.player.mesh.visible = false;
    for (const t of w.traffic) if (t.mesh) t.mesh.visible = !v.hideTraffic;
    // close-up views of one object leave the crowd out (a passer-by in front of the lens is chance, not content)
    if (w.crowd) for (const k of Object.keys(w.crowd)) if (w.crowd[k]?.mesh) w.crowd[k].mesh.visible = !v.hidePeople;
    if (v.peds) {
      // stand adults (no kid, no dog) at the given spots, idle, nearest first
      const pool = w.peds.filter((p) => p.active && !p.hidden && !p.dog && p.archetype !== 'kid' && !w.peds.some((k) => k.followId === p.id))
        .sort((a, b) => a.id - b.id);
      v.peds.forEach(([x, z, h], i) => {
        const p = pool[i];
        if (!p) return;
        p.pos.set(x, c.heightAt(x, z, c.heightAt(x, z)) + 0.02, z);
        p.body?.setTranslation({ x, y: p.pos.y + 0.9, z }, true);
        p.heading = h; p.state = 'idle'; p.timer = 1e6; p.tilt = 0; p.armPose = 'none'; p.moveAmount = 0; p.route.length = 0;
      });
    }
  }, { v, hour, weather, followGround });
  const note = exp ? await page.evaluate(({ src, name, variant }) => { window.__vsNote = ''; new Function('w', 'view', 'variant', src)(window.__oc, name, variant); return window.__vsNote; }, { src: exp, name, variant }) : '';
  // two drawn frames; read the second back in the same task
  const shot = await page.evaluate(({ v }) => {
    const w = window.__oc;
    window.__ocFrames(1, true);
    if (!v.player) w.player.mesh.visible = false;
    if (v.hideTraffic) for (const t of w.traffic) if (t.mesh) t.mesh.visible = false;
    const t1 = performance.now();
    const f = window.__ocFrames(1, true);
    const ms = performance.now() - t1;
    const r = w.renderer, inf = r.info;
    const url = r.domElement.toDataURL('image/png');
    return {
      url, cpu: f[0]?.cpu ?? ms, wallMs: Math.round(ms), calls: inf.render.calls, tris: inf.render.triangles,
      textures: inf.memory.textures, geometries: inf.memory.geometries, hour: +w.dayNight.hour.toFixed(3), cam: w.camera.position.toArray().map((x) => +x.toFixed(2)),
      exposure: r.toneMappingExposure, env: w.scene.environmentIntensity, sun: +w.dayNight.sun.intensity.toFixed(3),
      peds: w.crowd ? (w.crowd.torso.mesh.visible ? w.crowd.torso.mesh.count : 0) : -1, light: window.__vsLight ?? null,
    };
  }, { v });
  const file = join(outDir, `${prefix}-${name}${variant ? `-${variant}` : ''}.png`);
  await writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'));
  delete shot.url;
  results.push({ view: name, variant, file, ...shot, note, seconds: Math.round((Date.now() - tv) / 1000) });
  console.log(`  ${full.padEnd(9)} ${file}  calls ${shot.calls}  tris ${shot.tris}  frame ${shot.cpu} ms  hour ${shot.hour}  people drawn ${shot.peds}  (${Math.round((Date.now() - tv) / 1000)} s)${note ? `\n    ${note}` : ''}`);
}
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ dist, quality, hd, seed, info, results, errors: real }, null, 1));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.slice(0, 30).join('\n')); process.exitCode = 1; }
else console.log('  console clean');
await browser.close();
server.close();
