// Small asset fixture, independent of map boot and gameplay. Uses the same geometry and materials as the game.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, appType: 'mpa' });
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/worldVisuals.html`);
  await page.waitForFunction(() => window.__visuals, null, { timeout: 60000 });
  await mkdir('screenshots', { recursive: true });
  const stats = {};
  for (const view of ['people', 'trees']) {
    stats[view] = await page.evaluate(view => window.__visuals.render(view), view);
    await page.screenshot({ path: `screenshots/37-world-${view}.png`, timeout: 30000 });
  }
  assert.deepEqual(errors, []);
  await writeFile('screenshots/37-world-visuals.json', JSON.stringify({ fixture: 'shared game assets; includes shadow passes', stats, errors }, null, 2));
  console.log(JSON.stringify({ pass: true, stats, errors }));
} finally {
  await browser?.close();
  await server.close();
}
