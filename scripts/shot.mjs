// Headless check: serves dist/, opens the game in Chromium, runs a scenario, saves a screenshot,
// and fails if the console reports errors.  Usage: node scripts/shot.mjs <name> [scenario] [seed]
// Env: MAP=<id> loads ?map=<id> (default: the game's default map); THROTTLE=<n> slows the CPU n times.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const [name = 'shot', scenario = 'title', seed = ''] = process.argv.slice(2);
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
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

const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000); // software GL: on a real map a frame (and so a screenshot) can take seconds
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
if (process.env.THROTTLE) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
}
const params = [seed ? `seed=${seed}` : '', process.env.MAP ? `map=${encodeURIComponent(process.env.MAP)}` : ''].filter(Boolean).join('&');
await page.goto(`http://localhost:${port}/${params ? `?${params}` : ''}`);
await page.waitForFunction(() => window.__oc && window.__oc.time > 1, null, { timeout: 180000 }); // software GL: a real map's first frames are slow
const mod = await import(`./scenarios.mjs`);
await page.evaluate(mod.installMapHelpers);

const S = {
  async title() { await page.waitForTimeout(1500); },
  async start() {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  },
};
const run = mod[scenario] ?? S[scenario];
if (!run) throw new Error(`unknown scenario ${scenario}`);
const result = await run(page, S);
mkdirSync('screenshots', { recursive: true });
const fps = await page.evaluate(() => window.__oc.fps);
console.log(JSON.stringify({ name, scenario, fps: Math.round(fps), result }, null, 0));
try { await page.screenshot({ path: `screenshots/${name}.png`, timeout: 90000 }); } catch (e) { console.log('screenshot failed: ' + e.message.split('\n')[0]); }
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.join('\n')); process.exitCode = 1; }
else console.log('console clean');
await browser.close();
server.close();
