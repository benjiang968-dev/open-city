// Debug helper for the Georgetown world: boots the built preview page and prints the JSON value of a JS expression
// evaluated in it (W = window.__geo, geo = the GeoWorld, doc = the map document).
//   npm run build && node scripts/geoProbe.mjs <file.js | --expr "<js>">
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const ei = process.argv.indexOf('--expr');
const src = ei >= 0 ? process.argv[ei + 1] : readFileSync(process.argv[2], 'utf8');
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(root, url.pathname === '/' ? 'preview.html' : url.pathname);
  try {
    const d = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(d);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`http://localhost:${server.address().port}/preview.html?view=aerial&quality=low`);
await page.waitForFunction(() => window.__geo && window.__geo.ready, null, { timeout: 180000 });
// eslint-disable-next-line no-unused-vars
const out = await page.evaluate((s) => { const W = window.__geo, geo = W.geo, doc = W.doc; return JSON.stringify(eval(s)); }, src);
console.log(out);
await browser.close();
server.close();
