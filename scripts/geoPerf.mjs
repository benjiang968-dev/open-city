// Perf numbers for the Georgetown world (preview.html) with an optional CPU throttle, or the boot time of a game build
// (for comparing with an older build):
//   npm run build && THROTTLE=4 node scripts/geoPerf.mjs                 -> boot, draw calls / triangles per view and
//                                                                          quality, GeoWorld.update CPU ms, heap growth
//   THROTTLE=4 node scripts/geoPerf.mjs --game <dist dir>               -> ms from navigation to the game's first frame
// Headless WebGL is SwiftShader, so frame times mean little; CPU ms, calls and triangles are what to compare.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const gi = process.argv.indexOf('--game');
const gameDir = gi >= 0 ? resolve(process.argv[gi + 1]) : null;
const root = gameDir ?? resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(root, url.pathname === '/' ? (gameDir ? 'index.html' : 'preview.html') : url.pathname);
  try {
    const d = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(d);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const throttle = Number(process.env.THROTTLE ?? 1);
if (throttle > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
}
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

if (gameDir) {
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForFunction(() => window.__oc && window.__oc.renderer && window.__oc.renderer.info.render.frame > 0, null, { timeout: 300000 });
  console.log(JSON.stringify({ build: gameDir, throttle, firstFrameMs: Date.now() - t0 }));
} else {
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/preview.html?view=mst&quality=medium`);
  await page.waitForFunction(() => window.__geo && window.__geo.ready, null, { timeout: 300000 });
  const readyMs = Date.now() - t0;
  const stats = await page.evaluate(() => window.__geo.stats);
  const settle = async (frames) => {
    const f0 = await page.evaluate(() => window.__geo.perf().frames);
    await page.waitForFunction((f) => window.__geo.perf().frames >= f, f0 + frames, { timeout: 300000 });
  };
  const rows = [];
  for (const view of ['mst', 'keybridge', 'circle', 'aerial']) {
    for (const q of ['low', 'medium', 'high']) {
      await page.evaluate(([v, qq]) => { window.__geo.setQuality(qq); window.__geo.setView(v); }, [view, q]);
      await settle(3);
      const p = await page.evaluate(() => window.__geo.perf());
      const updMs = await page.evaluate(() => window.__geo.timeUpdate(400));
      rows.push({ view, q, calls: p.calls, trisM: +(p.tris / 1e6).toFixed(2), updateMs: +updMs.toFixed(4) });
    }
  }
  await page.evaluate(() => { window.__geo.setQuality('medium'); window.__geo.setView('mst'); });
  await settle(2);
  const heap = await page.evaluate(() => window.__geo.heapUpdate(5000));
  console.log(JSON.stringify({ throttle, readyMs, bootMs: stats.bootMs, phases: stats.phases, trisBuiltM: +(stats.tris / 1e6).toFixed(2), meshes: stats.meshes, colliders: stats.colliders, trimeshTris: stats.trimeshTris, heapGrowthBytesPer5000Updates: heap }));
  for (const r of rows) console.log(`  ${r.view.padEnd(10)} ${r.q.padEnd(6)} calls ${String(r.calls).padStart(4)}  tris ${r.trisM.toFixed(2)} M  GeoWorld.update ${r.updateMs.toFixed(3)} ms`);
}
if (errors.length) { console.log('CONSOLE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
await browser.close();
server.close();
