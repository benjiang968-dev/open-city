// Sampling heap profile of a scenario (which functions allocate most). Usage: DIST=dist-prof node scripts/heapprof.mjs <scenario>
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
const root = resolve(process.env.DIST || 'dist');
const server = createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); const p = join(root, u.pathname === '/' ? 'index.html' : u.pathname); try { const d = await readFile(p); res.writeHead(200, { 'content-type': extname(p) === '.js' ? 'text/javascript' : 'text/html' }); res.end(d); } catch { res.writeHead(404); res.end(); } }).listen(0);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => window.__oc && window.__oc.time > 1);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096 });
const t0 = Date.now();
await page.evaluate(() => window.__ocFrames(900, false)); // 15 s of game time, all systems except drawing
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const ms = Date.now() - t0;
const agg = new Map();
const walk = (n, stack) => {
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  agg.set(key, (agg.get(key) || 0) + n.selfSize);
  for (const c of n.children) walk(c, stack);
};
walk(profile.head, []);
const total = [...agg.values()].reduce((a, b) => a + b, 0);
const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
console.log(`sampled allocations over 900 frames: ${(total / 1e6).toFixed(1)} MB (${(total / 900 / 1024).toFixed(1)} KB/frame), wall ${ms} ms`);
for (const [k, v] of top) console.log(`${(v / 1024).toFixed(0).padStart(7)} KB  ${k}`);
await browser.close();
server.close();
