// Production-browser regression for camera, input focus, walking speed, and ground-anchored car recovery.
// Run npm run build first. MAP=georgetown checks real slopes; default grid isolates movement distances.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { installMapHelpers } from './scenarios.mjs';
const buildRoot = process.env.BUILD_ROOT ?? 'dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
  try { const p = join(buildRoot, path === '/' ? 'index.html' : path); res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream'); res.end(await readFile(p)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => { const raf = requestAnimationFrame.bind(window); let id = 0; window.requestAnimationFrame = cb => (id = raf(cb)); window.__freezeControls = () => { cancelAnimationFrame(id); window.requestAnimationFrame = () => 0; }; });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const map = process.env.MAP ?? 'grid';
try {
  await page.goto(`http://localhost:${server.address().port}/?map=${map}&quality=low&seed=123`);
  await page.waitForFunction(() => !!window.__ocRun, null, { timeout: 180000 });
  await page.evaluate(() => window.__freezeControls());
  await page.evaluate(installMapHelpers);
  const result = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, step = window.__ocStep;
    w.started = true; w.paused = false; w.input.blocked = false;
    // Use an unoccupied straight lane with 100 m run-up; moving actors are disabled for this controlled fixture.
    for (const a of [...w.traffic, ...w.peds]) a.body?.setEnabled(false);
    const road = window.__mh.straight();
    const px = road.x + Math.sin(road.heading) * 20, pz = road.z + Math.cos(road.heading) * 20;
    // An isolated physical platform avoids traffic/streaming changing the controlled distance run.
    const platform = w.physics.createRigidBody(w.R.RigidBodyDesc.fixed().setTranslation(px, 100, pz));
    w.physics.createCollider(w.R.ColliderDesc.cuboid(100, .5, 100), platform);
    const initFoot = () => {
      w.player.vehicle = null; w.player.collider.setEnabled(true); w.input.keys.clear(); w.input.pressed.clear();
      w.player.body.setTranslation({ x: px, y: 101.45, z: pz }, true);
      w.player.body.setNextKinematicTranslation({ x: px, y: 101.45, z: pz });
      w.player.vy = 0; w.player.moveSpeed = 0; w.player.facing = road.heading; w.player.grounded = true;
      w.cam.yaw = road.heading + Math.PI; w.cam.mode = 'third';
      step(3); w.player.moveSpeed = 0;
    };
    const distances = [];
    let physicsSteps = 0;
    const originalStep = w.physics.step.bind(w.physics);
    w.physics.step = (...args) => { physicsSteps++; return originalStep(...args); };
    for (const fps of [30, 60, 120]) {
      initFoot(); const startSteps = physicsSteps; w.input.keys.add('KeyW'); run(2, fps); w.input.keys.clear();
      const p = w.player.body.translation(); distances.push({ fps, distance: Math.hypot(p.x - px, p.z - pz), steps: physicsSteps - startSteps, speed: w.player.moveSpeed, hp: w.player.health, knock: w.player.knockT, y:p.y, facing:w.player.facing });
    }
    initFoot(); w.input.keys.add('KeyW'); w.input.keys.add('ShiftLeft'); run(2, 60); w.input.keys.clear();
    const sp = w.player.body.translation(); const sprint = Math.hypot(sp.x - px, sp.z - pz);
    initFoot(); w.input.keys.add('KeyW'); w.input.keys.add('KeyA');
    let path = 0, previous = w.player.body.translation();
    for (let k = 0; k < 120; k++) { run(1 / 60, 60); const p = w.player.body.translation(); path += Math.hypot(p.x - previous.x, p.z - previous.z); previous = p; }
    w.input.keys.clear();
    const headingError = () => Math.abs(Math.atan2(Math.sin(w.cam.yaw - w.player.facing - Math.PI), Math.cos(w.cam.yaw - w.player.facing - Math.PI)));
    const turnError = headingError();
    w.input.mouseDX = 110; w.input.mouseDY = 20; run(1 / 60, 60);
    const mouseError = headingError();
    w.input.keys.add('ArrowRight'); run(.5, 60); w.input.keys.clear(); const combinedError = headingError();
    w.input.pressed.add('KeyV'); run(.2, 60); const firstFoot = w.cam.mode === 'first' && !w.player.mesh.visible;
    const eyeHeight = w.camera.position.y - w.player.mesh.position.y;
    w.input.pressed.add('KeyV'); run(.3, 60); const thirdFoot = w.cam.mode === 'third' && w.player.mesh.visible;
    w.input.keys.add('KeyW'); w.input.pressed.add('Space'); w.input.mouseDX = 40; w.input.mouse0 = true;
    window.dispatchEvent(new Event('blur'));
    const focusCleared = w.input.keys.size === 0 && w.input.pressed.size === 0 && !w.input.mouse0 && w.input.mouseDX === 0;
    w.physics.removeRigidBody(platform);
    // Real E entry/exit through the player interaction code.
    const v = w.vehicles.find(v => v.owned && !v.idle && !v.wrecked);
    v.body.setTranslation({ x: px, y: w.city.heightAt(px, pz) + 1, z: pz }, true);
    v.body.setRotation({ x: 0, y: Math.sin(road.heading / 2), z: 0, w: Math.cos(road.heading / 2) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    w.player.body.setTranslation({ x: px + Math.cos(road.heading) * 2, y: w.city.heightAt(px, pz) + 1, z: pz - Math.sin(road.heading) * 2 }, true);
    w.input.pressed.add('KeyE'); step(1); const entered = w.player.vehicle === v;
    if (!entered) throw new Error('E entry failed: ' + w.player.prompt);
    w.input.pressed.add('KeyV'); run(.8, 60); const firstCar = w.cam.mode === 'first';
    const steeringBefore = w.cam.yaw; w.input.keys.add('KeyA'); run(.2, 60); w.input.keys.clear();
    const steering = v.steer, steeringCameraChange = Math.abs(w.cam.yaw - steeringBefore);
    // Recover from high above the road, then hammer and hold R. The old code gained 1.2 m per press.
    const recover = (x, z, y) => {
      v.body.setTranslation({ x, y, z }, true); v.body.setLinvel({ x: 3, y: 12, z: 2 }, true);
      v.lastRecovery = -Infinity; v.wrecked = false; v.health = v.maxHealth;
      let maxAltitude = -Infinity;
      for (let i = 0; i < 180; i++) {
        if (i < 120) w.input.pressed.add('KeyR'); // 120 rapid taps, then one held key
        if (i === 120) { w.input.keys.add('KeyR'); w.input.pressed.add('KeyR'); }
        step(1);
        maxAltitude = Math.max(maxAltitude, v.body.translation().y - w.city.heightAt(v.px, v.pz, v.py));
      }
      w.input.keys.clear();
      const p = v.body.translation();
      const clear = [-v.spec.halfExtents[0], 0, v.spec.halfExtents[0]].every(lx => [-v.spec.halfExtents[2], 0, v.spec.halfExtents[2]].every(lz =>
        !w.city.isBlocked(p.x + lx * Math.cos(v.heading) + lz * Math.sin(v.heading), p.z - lx * Math.sin(v.heading) + lz * Math.cos(v.heading))));
      return { maxAltitude, finalAltitude: p.y - w.city.heightAt(p.x, p.z, p.y), clear, position: p };
    };
    const flat = recover(px, pz, w.city.heightAt(px, pz) + 40);
    const edges = w.city.roads.edges.filter(e => !e.bridge && e.pts.length > 3);
    let steep = null, grade = 0;
    for (const e of edges) for (let j = 3; j < e.pts.length; j += 3) {
      const d = Math.hypot(e.pts[j] - e.pts[j - 3], e.pts[j + 2] - e.pts[j - 1]);
      const g = Math.abs(e.pts[j + 1] - e.pts[j - 2]) / d;
      if (d > 4 && g > grade && g < .25) { grade = g; steep = { x: (e.pts[j] + e.pts[j - 3]) / 2, z: (e.pts[j + 2] + e.pts[j - 1]) / 2 }; }
    }
    const slope = steep ? recover(steep.x, steep.z, w.city.heightAt(steep.x, steep.z) + 10) : null;
    const b = w.city.buildings.find(b => b.maxX - b.minX < 80 && b.maxZ - b.minZ < 80 && b.maxX - b.minX > 5);
    const wall = b ? recover(b.minX + .2, (b.minZ + b.maxZ) / 2, w.city.heightAt(b.minX, b.minZ) + 10) : null;
    w.input.pressed.add('KeyV'); run(.2, 60); const thirdCar = w.cam.mode === 'third';
    v.speed = 0; v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    w.input.pressed.add('KeyE'); step(1); run(.3, 60); const exited = !w.player.vehicle;
    const room = w.interiors.entries.find(e => e.kind === 'apartment');
    const roomEntered = window.__ocSandbox.enterInterior(room.id); run(.5,60);
    const closeCameraHidesBody = !w.player.mesh.visible && w.cam.playerObscured;
    w.player.body.setTranslation({x:room.origin.x,y:room.origin.y+1,z:room.origin.z},true);w.player.vy=0;run(.8,60);
    const indoorThirdVisible = w.player.mesh.visible && !w.cam.playerObscured;
    const cameraInside = Math.abs(w.camera.position.x-room.origin.x)<5 && Math.abs(w.camera.position.z-room.origin.z)<6;
    w.input.pressed.add('KeyV');run(.6,60);const indoorFirst = w.cam.mode==='first' && !w.player.mesh.visible;
    w.input.pressed.add('KeyV');run(.8,60);const indoorThird = w.cam.mode==='third' && w.player.mesh.visible;
    return { distances, sprint, turningPath: path, turnError, mouseError, combinedError, firstFoot, eyeHeight, thirdFoot,
      focusCleared, entered, firstCar, steering, steeringCameraChange, flat, slope, grade, wall, thirdCar, exited, roomEntered, closeCameraHidesBody, indoorThirdVisible, cameraInside, indoorFirst, indoorThird };
  });
  console.log(JSON.stringify({ map, ...result }, null, 2));
  assert.ok(result.distances.every(d => d.distance > 9.5), 'walking should cover over 9.5m in 2s');
  assert.ok(Math.max(...result.distances.map(d => d.distance)) - Math.min(...result.distances.map(d => d.distance)) < .2, 'frame rates changed walking speed');
  assert.ok(result.sprint > result.distances[0].distance + 3, 'sprint must remain faster');
  assert.ok(result.turningPath <= result.distances[1].distance + .5, 'turning caused faster diagonal travel');
  assert.ok(result.turnError < .001 && result.mouseError < .001 && result.combinedError < .001, 'view detached from heading');
  assert.ok(result.firstFoot && result.thirdFoot && result.eyeHeight > 1.4 && result.eyeHeight < 1.9, 'walking camera modes');
  assert.ok(result.focusCleared && result.entered && result.exited && result.firstCar && result.thirdCar, 'focus or vehicle camera transitions');
  assert.ok(Math.abs(result.steering) > .1 && result.steeringCameraChange < .05, 'steering must not rotate car view');
  for (const [label, r] of [['flat', result.flat], ['slope', result.slope], ['wall', result.wall]]) {
    if (!r) continue;
    assert.ok(r.maxAltitude < 3 && r.finalAltitude < 2 && r.clear, `${label}: car recovery must stay on clear ground`);
  }
  assert.ok(result.roomEntered && result.closeCameraHidesBody && result.indoorThirdVisible && result.cameraInside && result.indoorFirst && result.indoorThird, 'indoor camera obstruction or view transitions');
  assert.deepEqual(errors, [], 'browser console errors');
  await mkdir('screenshots', { recursive: true });
  await writeFile(`screenshots/controls-${map}.json`, JSON.stringify({ map, ...result, consoleErrors: errors }, null, 2));
  await page.screenshot({ path: `screenshots/controls-${map}.png`, timeout: 120000 });
  console.log('Controls regression passed; console clean.');
} finally { await browser.close(); server.close(); }
