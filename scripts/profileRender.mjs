// GPU-drained production-build profile. Uses synchronous readback to include queued GPU work.
// With the sky cache present, alternates its retained physical source and cached material in the same scene.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(process.argv[2] ?? 'dist');
const output = process.argv[3] ?? 'work/render-profile.json';
const server = createServer(async (request, response) => {
  let path = new URL(request.url, 'http://local').pathname;
  if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (path === '/') path = '/index.html';
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(join(root, path)));
  } catch { response.writeHead(404).end(); }
}).listen(0);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    let id;
    const raf = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => (id = raf(callback));
    window.freeze = () => { cancelAnimationFrame(id); window.requestAnimationFrame = () => 0; };
  });
  const started = Date.now();
  await page.goto(`http://localhost:${server.address().port}/?map=georgetown&quality=low&seed=123`);
  await page.waitForFunction(() => !!window.__ocFrames, null, { timeout: 180000 });
  await page.evaluate(() => window.freeze());
  const data = await page.evaluate(() => {
    const world = window.__oc;
    world.started = true;
    world.paused = false;
    world.dayNight.hour = 15.5;
    world.player.body.setTranslation({ x: -240, y: world.city.heightAt(-240, 160) + 1, z: 160 }, true);
    window.__ocRun(.25);
    window.__ocFrames(2, true);
    const gl = world.renderer.getContext(), pixel = new Uint8Array(4);
    const sky = world.dayNight.sky, env = world.dayNight.env;
    const cached = sky.material, physical = env.envScene.children.find(object => object.isMesh).material;
    const drain = () => {
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    };
    const render = material => { sky.material = material; world.renderer.render(world.scene, world.camera); drain(); };
    const summary = (label, ms) => ({ label, ms, median: [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)],
      calls: world.renderer.info.render.calls, triangles: world.renderer.info.render.triangles, pixel: [...pixel] });
    const pair = () => {
      render(physical); render(cached); // Compile both before measurement.
      const sourceMs = [], cachedMs = [];
      for (let sample = 0; sample < 12; sample++) {
        let start = performance.now(); render(physical); sourceMs.push(performance.now() - start);
        start = performance.now(); render(cached); cachedMs.push(performance.now() - start);
      }
      return { physical: summary('physical', sourceMs), cached: summary('cached', cachedMs) };
    };
    const fullWorld = pair();
    const hidden = [];
    world.scene.traverse(object => {
      if ((object.isMesh || object.isPoints || object.isLine) && object !== sky) {
        hidden.push([object, object.visible]); object.visible = false;
      }
    });
    const skyOnly = pair();
    for (const [object, visible] of hidden) object.visible = visible;
    sky.material = cached;
    return { fullWorld, skyOnly, renderer: gl.getParameter(gl.RENDERER), boot: window.__ocBoot,
      environmentRefreshes: env.refreshes, hasCache: !!env.display };
  });
  const result = { ...data, elapsedMs: Date.now() - started, errors };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); server.close(); }
