// Before/after look screenshots from fixed cameras (the Georgetown world preview, preview.html, same named views in every
// build). Serves a dist folder, opens the preview in Chromium, shoots each view into screenshots/<prefix>-<view>.png,
// prints draw calls / triangles / CPU ms per view and fails on console errors or warnings.
//   npm run build && node scripts/lookShots.mjs [--dist <folder>] [--prefix 33-look-after] [--quality medium] [view ...]
// Views: mst rowhouses keybridge waterfront circle canal night (see VIEWS in src/preview/georgetownPreview.ts), and
// texsheet (every baked surface map, albedo above normals).
// --hour <h> overrides every view's hour; --jpg writes JPEG instead of PNG.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
const dist = resolve(opt('dist', 'dist'));
const prefix = opt('prefix', '33-look-after');
const quality = opt('quality', 'medium');
const hour = opt('hour', null);
const jpg = flag('jpg');
const views = args.length ? args : ['mst', 'rowhouses', 'keybridge', 'waterfront'];

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(dist, url.pathname === '/' ? 'preview.html' : url.pathname);
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
page.setDefaultTimeout(240000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/preview.html?view=${views[0]}&quality=${quality}`);
await page.waitForFunction(() => window.__geo && window.__geo.ready, null, { timeout: 240000 });
const stats = await page.evaluate(() => window.__geo.stats);
const lookStats = await page.evaluate(() => window.__geo.look?.stats ?? null);
console.log(`${dist}: boot ${stats.bootMs} ms (page ready after ${Date.now() - t0} ms)${lookStats ? `  texture bake ${lookStats.bakeMs} ms at ${lookStats.res} px, ${(lookStats.bytes / 1048576).toFixed(1)} MiB` : ''}`);
await page.evaluate(() => { for (const id of ['hud', 'help']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } });
mkdirSync('screenshots', { recursive: true });
const settle = async (frames) => {
  const f0 = await page.evaluate(() => window.__geo.perf().frames);
  await page.waitForFunction((f) => window.__geo.perf().frames >= f, f0 + frames, { timeout: 240000 });
};
for (const v of views) {
  await page.evaluate(([vv, q, h]) => {
    window.__geo.setQuality(q);
    // 'texsheet': the baked surface maps (albedo above normals), not a camera view
    window.__geo.texSheet?.(vv === 'texsheet');
    if (vv !== 'texsheet') window.__geo.setView(vv);
    if (h !== null) window.__geo.setHour(Number(h));
  }, [v, quality, hour]);
  await settle(5);
  const p = await page.evaluate(() => window.__geo.perf());
  const file = `screenshots/${prefix}-${v}.${jpg ? 'jpg' : 'png'}`;
  await page.screenshot({ path: file, timeout: 240000, ...(jpg ? { type: 'jpeg', quality: 85 } : {}) });
  console.log(`${file.padEnd(44)} calls ${String(p.calls).padStart(4)}  tris ${(p.tris / 1e6).toFixed(2)} M  cpu ${p.cpuMs.toFixed(1)} ms`);
}
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.join('\n')); process.exitCode = 1; }
else console.log('console clean');
await browser.close();
server.close();
