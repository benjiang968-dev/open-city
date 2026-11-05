// Look performance: the game (?map=georgetown by default) at each quality preset, base build vs this build, runs
// interleaved (the machine is shared and noisy). Per run: boot (map build, first frame, texture bake), draw calls and
// triangles of a rendered frame at M St, CPU ms per frame (median and p90 of N rendered frames from __ocFrames, which
// includes three's render submission; software GL fill cost is mostly outside it), JS heap, texture memory estimate.
//   node scripts/lookPerf.mjs --base <distDir> [--new dist] [--rounds 2] [--frames 12] [--throttle 4] [--map georgetown]
//     [--size 640x360] [--qualities low,medium,high]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
const dirs = { base: opt('base', null), new: opt('new', 'dist') };
const rounds = Number(opt('rounds', 2)), frames = Number(opt('frames', 12)), throttle = Number(opt('throttle', 1));
const map = opt('map', 'georgetown');
const [vw, vh] = opt('size', '640x360').split('x').map(Number);
const qualities = opt('qualities', 'low,medium,high').split(',');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

function serve(dir) {
  const root = resolve(dir);
  const s = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    try { const d = await readFile(p); res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end(); }
  }).listen(0);
  return s;
}

async function run(label, dir, q) {
  const server = serve(dir);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.setDefaultTimeout(1200000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(e.message));
  if (throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
  const t0 = Date.now();
  await page.goto(`http://localhost:${server.address().port}/?map=${map}&quality=${q}`);
  await page.waitForFunction(() => window.__oc && window.__oc.time > 1, null, { timeout: 1200000 });
  const ready = Date.now() - t0;
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 600000 });
  const r = await page.evaluate(([n]) => {
    const w = window.__oc;
    w.dayNight.hour = 15.5;
    // M St (Georgetown) or the grid centre: the player stands on the pavement, the chase camera behind
    const at = w.city.id === 'grid' ? { x: 16, z: -200 } : { x: -240, z: 160 };
    w.player.body.setTranslation({ x: at.x, y: w.city.heightAt(at.x, at.z) + 1.2, z: at.z }, true);
    window.__ocRun(1);
    window.__ocFrames(2, true); // settle (sky light, streaming)
    const frames = window.__ocFrames(n, true);
    const f = frames.map((x) => x.cpu).sort((a, b) => a - b);
    const top = frames[frames.length - 1].top; // the profiler's biggest sections of the last frame
    const info = w.renderer.info;
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    return {
      boot: window.__ocBoot, bake: w.look ? w.look.stats : null, calls: info.render.calls, tris: info.render.triangles,
      textures: info.memory.textures, geometries: info.memory.geometries, programs: info.programs ? info.programs.length : null,
      cpuMedian: f[Math.floor(f.length / 2)], cpuP90: f[Math.floor(f.length * 0.9)], heapMB: mem, top,
    };
  }, [frames]);
  await browser.close();
  server.close();
  return { label, q, readyMs: ready, ...r, errors: errors.length };
}

const out = [];
for (let k = 0; k < rounds; k++)
  for (const q of qualities)
    for (const label of ['base', 'new']) {
      if (!dirs[label]) continue;
      const res = await run(label, dirs[label], q);
      out.push(res);
      console.log(JSON.stringify(res));
    }
console.log('\nsummary (median over rounds)');
for (const q of qualities)
  for (const label of ['base', 'new']) {
    const rs = out.filter((r) => r.q === q && r.label === label);
    if (!rs.length) continue;
    const med = (f) => { const a = rs.map(f).filter((v) => v != null).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    console.log(`${q.padEnd(7)} ${label.padEnd(5)} calls ${med((r) => r.calls)}  tris ${(med((r) => r.tris) / 1e6).toFixed(2)} M  cpu ${med((r) => r.cpuMedian)} ms (p90 ${med((r) => r.cpuP90)})  map ${med((r) => r.boot.mapMs)} ms  first frame ${med((r) => r.boot.firstFrameMs)} ms  bake ${med((r) => r.bake?.bakeMs ?? 0)} ms  tex ${med((r) => r.bake ? (r.bake.bytes / 1048576).toFixed(0) : 0)} MiB  heap ${med((r) => r.heapMB)} MB  programs ${med((r) => r.programs)}`);
  }
