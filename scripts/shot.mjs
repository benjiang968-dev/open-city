// Headless check: serves dist/, opens the game in Chromium, runs a scenario, saves a screenshot,
// and fails if the console reports errors.  Usage: node scripts/shot.mjs <name> [scenario] [seed]
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/${seed ? `?seed=${seed}` : ''}`);
await page.waitForFunction(() => window.__oc && window.__oc.time > 1, null, { timeout: 60000 });

const S = {
  async title() { await page.waitForTimeout(1500); },
  async start() {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  },
};
const mod = await import(`./scenarios.mjs`);
const run = mod[scenario] ?? S[scenario];
if (!run) throw new Error(`unknown scenario ${scenario}`);
const result = await run(page, S);
mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: `screenshots/${name}.png` });
const fps = await page.evaluate(() => window.__oc.fps);
console.log(JSON.stringify({ name, scenario, fps: Math.round(fps), result }, null, 0));
const real = errors.filter((e) => !/GPU stall|ReadPixels|WebGL-|swiftshader|Automatic fallback/i.test(e));
if (real.length) { console.log('CONSOLE ERRORS:\n' + real.join('\n')); process.exitCode = 1; }
else console.log('console clean');
await browser.close();
server.close();
