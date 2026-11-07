// Production Chromium regression: cached sky radiance, face scheduling, target reuse, day/night and weather.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = process.env.BUILD_ROOT ?? 'dist';
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
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    let id;
    const raf = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => (id = raf(callback));
    window.freeze = () => { cancelAnimationFrame(id); window.requestAnimationFrame = () => 0; };
  });
  await page.goto(`http://localhost:${server.address().port}/?map=grid&quality=low&seed=123`);
  await page.waitForFunction(() => window.__ocFrames, null, { timeout: 180000 });
  await page.evaluate(() => window.freeze());
  const result = await page.evaluate(() => {
    const world = window.__oc, env = world.dayNight.env, display = env.display;
    const gl = world.renderer.getContext(), pixel = new Uint8Array(4);
    world.started = true;
    const originalTargets = [display.front.texture, display.back.texture];
    let maxDisplayFacesPerFrame = 0, maxEnvironmentFacesPerFrame = 0;
    const counts = () => ({ faces: display.faces, swaps: display.swaps, envFaces: env.environmentFaces, environment: env.refreshes });
    const advance = seconds => {
      for (let frame = 0; frame < seconds * 60; frame++) {
        const before = counts();
        window.__ocRun(1 / 60, 60);
        maxDisplayFacesPerFrame = Math.max(maxDisplayFacesPerFrame, display.faces - before.faces);
        maxEnvironmentFacesPerFrame = Math.max(maxEnvironmentFacesPerFrame, env.environmentFaces - before.envFaces);
      }
    };
    const compare = label => {
      const hidden = [];
      world.scene.traverse(object => {
        if ((object.isMesh || object.isPoints || object.isLine) && object !== world.dayNight.sky) {
          hidden.push([object, object.visible]); object.visible = false;
        }
      });
      world.camera.position.set(0, 100, 0);
      world.dayNight.sky.position.copy(world.camera.position);
      const cached = world.dayNight.sky.material;
      const physical = env.envScene.children.find(object => object.isMesh).material;
      const sample = material => {
        world.dayNight.sky.material = material;
        world.renderer.render(world.scene, world.camera);
        gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return [...pixel].slice(0, 3);
      };
      const views = [[0, .5, -1], [0, .5, 1], [1, .5, 0], [-1, .5, 0], [0, 1, .01], [0, -.6, -1]];
      const samples = views.map(direction => {
        world.camera.lookAt(direction[0] * 100, 100 + direction[1] * 100, direction[2] * 100);
        return { direction, cached: sample(cached), physical: sample(physical) };
      });
      world.dayNight.sky.material = cached;
      for (const [object, visible] of hidden) object.visible = visible;
      return { label, samples };
    };
    const before = counts();
    advance(2);
    const afterDay = counts(), day = compare('clear day');
    world.dayNight.hour = 21;
    world.weather.kind = 'storm'; world.weather.look.cloud = 1;
    advance(3);
    const night = compare('storm night'), nightState = { night: world.dayNight.night, sunHeight: world.dayNight.sunDir.y };
    world.dayNight.hour = 15.5;
    world.weather.kind = 'clear'; world.weather.look.cloud = 0;
    advance(2);
    const recovery = compare('clear day after storm');
    return { before, afterDay, latest: counts(), radiance: [day, night, recovery], nightState,
      maxDisplayFacesPerFrame, maxEnvironmentFacesPerFrame,
      targetsReused: originalTargets.includes(display.front.texture) && originalTargets.includes(display.back.texture),
      groundBounceVisible: env.ground.visible };
  });
  assert.equal(result.maxDisplayFacesPerFrame, 1, 'visible sky capture should cost at most one face per frame');
  assert.equal(result.maxEnvironmentFacesPerFrame, 1, 'lighting capture should cost at most one face per frame');
  assert.ok(result.afterDay.swaps > result.before.swaps);
  assert.ok(result.latest.environment > result.afterDay.environment);
  assert.ok(result.targetsReused && result.groundBounceVisible);
  for (const { label, samples } of result.radiance) for (const sample of samples) {
    assert.ok(sample.cached.every((value, channel) => Math.abs(value - sample.physical[channel]) <= 8), `${label} ${sample.direction}: cache ${sample.cached} must match physical source ${sample.physical}`);
  }
  assert.ok(result.nightState.night > .8 && result.nightState.sunHeight < 0);
  assert.deepEqual(errors, []);
  await mkdir('screenshots', { recursive: true });
  await writeFile('screenshots/sky-cache.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify(result));
  console.log('PASS physical sky radiance in 18 views; one-face captures, reused targets, storm/night/day transitions, clean console');
} finally { await browser.close(); server.close(); }
