// Headless screenshots and perf numbers for the Georgetown world preview (preview.html). Serves dist/, opens the
// preview in Chromium, takes the views below into screenshots/, prints draw calls / triangles / frame time per view and
// quality, the boot time, a collider-vs-surface ray check, and fails on console errors.
//   npm run build && node scripts/previewShots.mjs [only-view ...]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

// --cam name px py pz lx ly lz [hour] [quality]: one ad-hoc shot (absolute coordinates) into screenshots/dbg-<name>.png
// --eval "<js expression using geo>": print the JSON result (debugging)
const evalArg = process.argv.indexOf('--eval');
const evalSrc = evalArg >= 0 ? process.argv[evalArg + 1] : null;
const camArg = process.argv.indexOf('--cam');
const custom = camArg >= 0 ? process.argv.slice(camArg + 1) : null;
const only = custom || evalSrc ? ['__none__'] : process.argv.slice(2);
const SHOTS = [
  ['26-geo-aerial', 'aerial', 'medium'],
  ['26-geo-mst', 'mst', 'medium'],
  ['26-geo-keybridge', 'keybridge', 'medium'],
  ['26-geo-circle', 'circle', 'medium'],
  ['26-geo-canal', 'canal', 'medium'],
  ['26-geo-waterfront', 'waterfront', 'medium'],
  ['26-geo-rowhouses', 'rowhouses', 'medium'],
  ['26-geo-night', 'night', 'medium'],
  ['26-geo-aerial-low', 'aerial', 'low'],
].filter(([name, view]) => !only.length || only.includes(view) || only.includes(name));
const PERF = [['mst', 'low'], ['mst', 'medium'], ['mst', 'high'], ['aerial', 'low'], ['aerial', 'medium'], ['aerial', 'high']];

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/preview.html?view=aerial&quality=medium`);
await page.waitForFunction(() => window.__geo && window.__geo.ready, null, { timeout: 180000 });
const stats = await page.evaluate(() => window.__geo.stats);
console.log(`boot ${stats.bootMs} ms (page ready after ${Date.now() - t0} ms)  phases ${JSON.stringify(stats.phases)}`);
console.log(`meshes ${stats.meshes}  triangles built ${(stats.tris / 1e6).toFixed(2)} M  colliders ${stats.colliders}  trimesh tris ${stats.trimeshTris}`);
mkdirSync('screenshots', { recursive: true });

const settle = async (frames = 4) => {
  const f0 = await page.evaluate(() => window.__geo.perf().frames);
  await page.waitForFunction((f) => window.__geo.perf().frames >= f, f0 + frames, { timeout: 120000 });
};
if (evalSrc) {
  const out = await page.evaluate((src) => { const geo = window.__geo.geo, castDown = window.__geo.castDown; return JSON.stringify(eval(src)); }, evalSrc);
  console.log(out);
}
if (custom) {
  const [name, ...nums] = custom;
  const [px, py, pz, lx, ly, lz, hour = 13] = nums.map(Number);
  await page.evaluate(([a, b, c, d, e, f, h, q]) => { window.__geo.setQuality(q); window.__geo.setHour(h); window.__geo.setCamera(a, b, c, d, e, f); }, [px, py, pz, lx, ly, lz, hour, nums[7] ?? 'medium']);
  await settle(4);
  const p = await page.evaluate(() => window.__geo.perf());
  console.log(`dbg-${name}: calls ${p.calls} tris ${(p.tris / 1e6).toFixed(2)} M`);
  await page.screenshot({ path: `screenshots/dbg-${name}.png`, timeout: 120000 });
}
const results = {};
for (const [name, view, q] of SHOTS) {
  await page.evaluate(([v, qq]) => { window.__geo.setQuality(qq); window.__geo.setView(v); }, [view, q]);
  await settle(4);
  const p = await page.evaluate(() => window.__geo.perf());
  results[name] = p;
  console.log(`${name.padEnd(22)} ${q.padEnd(6)} calls ${String(p.calls).padStart(4)}  tris ${(p.tris / 1e6).toFixed(2)} M  cpu ${p.cpuMs.toFixed(1)} ms`);
  await page.screenshot({ path: `screenshots/${name}.png`, timeout: 120000 });
}
if (!only.length) {
  console.log('\nperf by view and quality (renderer.info after a full frame incl. shadow pass)');
  const perf = [];
  for (const [view, q] of PERF) {
    const switchMs = await page.evaluate(([v, qq]) => { window.__geo.setView(v); return window.__geo.setQuality(qq); }, [view, q]);
    await settle(6);
    const p = await page.evaluate(() => window.__geo.perf());
    perf.push({ view, q, calls: p.calls, tris: p.tris, cpuMs: +p.cpuMs.toFixed(2), frameMs: +p.frameMs.toFixed(1), switchMs: +switchMs.toFixed(1) });
    console.log(`  ${view.padEnd(8)} ${q.padEnd(6)} calls ${String(p.calls).padStart(4)}  tris ${(p.tris / 1e6).toFixed(2)} M  cpu ${p.cpuMs.toFixed(1)} ms  frame ${p.frameMs.toFixed(0)} ms (swiftshader)  setQuality ${switchMs.toFixed(1)} ms`);
  }
  const rc = await page.evaluate(() => window.__geo.rayCheck());
  console.log(`\nray check: ${rc.samples} samples, ${rc.bad} off by > 12 cm, max ${rc.maxErr.toFixed(2)} m, ${rc.lips} lips on decks`);
  for (const w of rc.worst) console.log('  ' + w);
  writeFileSync('screenshots/26-geo-perf.json', JSON.stringify({ stats, shots: results, perf, rayCheck: rc }, null, 1));
}
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.join('\n')); process.exitCode = 1; }
else console.log('console clean');
await browser.close();
server.close();
