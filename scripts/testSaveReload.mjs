// Real IndexedDB + browser reload integration without software-GL rendering overhead.
import assert from 'node:assert/strict';
import { rolldown } from 'rolldown';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const folder = await mkdtemp(join(tmpdir(), 'open-city-save-reload-'));
let browser, server;
try {
  const bundle = await rolldown({ input: resolve('scripts/tests/saveReloadFixture.ts'), platform: 'browser' });
  const file = join(folder, 'fixture.js');
  await bundle.write({ file, format: 'esm' }); await bundle.close();
  server = createServer(async (req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(file)); }
    else res.end('<!DOCTYPE html><title>Save integration test</title><script type="module" src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ready = async () => page.waitForFunction(() => window.__saveTest);
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await ready();
  assert.equal(await page.evaluate(() => window.__saveTest.loaded), false);
  assert.equal(await page.evaluate(() => window.__saveTest.transact()), true);
  await page.reload(); await ready();
  let s = await page.evaluate(() => window.__saveTest.state());
  assert.equal(await page.evaluate(() => window.__saveTest.loaded), true);
  assert.equal(s.cash, 170); assert.equal(s.extra.apartment, 'home-1');
  assert.equal(s.ids.filter(id => id !== null).length, 1); assert.equal(s.ids[0], 0);
  assert.equal(s.item.location, 'inventory'); assert.equal(s.item.enabled, false); assert.equal(s.item.sealed, true);
  assert.equal(await page.evaluate(() => window.__saveTest.moveAndSave()), true);
  await page.reload(); await ready(); s = await page.evaluate(() => window.__saveTest.state());
  assert.equal(s.ids.filter(id => id !== null).length, 0); assert.equal(s.item.location, 'world'); assert.equal(s.item.x, 4); assert.equal(s.item.enabled, true);
  // Unknown future schema must remain untouched: no autosave can replace it.
  await page.evaluate(() => window.__saveTest.corrupt());
  await page.reload(); await ready(); s = await page.evaluate(() => window.__saveTest.state());
  assert.equal(s.status.ready, false); assert.equal(await page.evaluate(() => window.__saveTest.transact()), false);
  assert.deepEqual(errors, []);
  console.log('PASS browser IndexedDB atomic transaction, reload inventory/world identity, property extra data, and unsupported-save protection; console clean');
} finally { await browser?.close(); server?.close(); await rm(folder, { recursive: true, force: true }); }
