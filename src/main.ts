// Boot + game loop. Opens straight into the live world with a one-line "press any key" title.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { Rng, seedFromUrl } from './rng';
import type { World } from './world';
import { createInput, endInputFrame, act } from './systems/input';
import { generateCity, updateCity } from './systems/cityGen';
import { createDayNight, updateDayNight } from './systems/dayNight';
import { createCamera, updateCamera } from './systems/camera';
import { createPlayer, updatePlayer } from './systems/player';
import { spawnInitialVehicles, updateVehicles, detectCrashes } from './systems/vehicles';
import { createHud, showHud, updateHud } from './systems/hud';
import { createDebug, updateDebug } from './systems/debug';

async function boot() {
  await RAPIER.init();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(TUNING.camera.fov, window.innerWidth / window.innerHeight, 0.25, 1600);
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const seed = seedFromUrl(TUNING.world.defaultSeed);
  const physics = new RAPIER.World({ x: 0, y: -TUNING.vehicles.gravity, z: 0 });
  physics.timestep = 1 / 60;

  // Systems fill in the World in order; fields used before creation get safe placeholders.
  const w = {
    seed, rng: new Rng(seed), R: RAPIER, physics, renderer, scene, camera,
    input: createInput(canvas), cam: createCamera(), vehicles: [], traffic: [], peds: [], cash: TUNING.economy.startingCash,
    started: false, paused: false, time: 0, frameDt: 0, fps: 60, debugVisible: false, events: [], colliderOwner: new Map(),
    police: { stars: 0, seen: false } as unknown as World['police'],
    chat: { open: false } as unknown as World['chat'],
    jobs: { statusText: () => '' } as unknown as World['jobs'],
  } as unknown as World;
  w.dayNight = createDayNight(scene);
  w.city = generateCity(scene, RAPIER, physics, seed);
  const rank = w.city.taxiRanks[0];
  w.player = createPlayer(w, rank.x, rank.z);
  spawnInitialVehicles(w);
  w.hud = createHud();
  createDebug(w);

  // expose read-only state for automated tests (scripts/*.mjs)
  (window as unknown as { __oc: World }).__oc = w;

  /** One fixed physics tick for everything that moves bodies. */
  function simStep(step: number) {
    updatePlayer(w, step);
    updateVehicles(w, step);
    physics.step();
    detectCrashes(w);
  }
  // deterministic stepping for automated handling tests (runs n ticks instantly, no rendering)
  (window as unknown as { __ocStep: (n: number) => void }).__ocStep = (n: number) => {
    for (let k = 0; k < n; k++) {
      simStep(STEP);
      w.time += STEP;
      w.input.pressed.clear();
    }
  };

  let last = performance.now();
  let acc = 0;
  const STEP = 1 / 60;
  let fpsAcc = 0, fpsFrames = 0;

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    w.time += dt;
    w.frameDt = dt;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) { w.fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

    if (!w.started && w.input.anyKeyPressed) {
      w.started = true;
      w.input.pressed.clear();
      showHud(w.hud, w.cash);
      w.cam.yaw = Math.PI / 2;
    }
    if (act.debug(w.input)) w.debugVisible = !w.debugVisible;

    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      simStep(STEP);
      acc -= STEP;
      steps++;
      if (steps === 1) w.input.pressed.clear(); // one-shot keys fire once per frame
    }
    if (steps === 4) acc = 0;

    updateDayNight(w, dt);
    updateCity(w.city, w.time);
    updateCamera(w, dt);
    updateHud(w, dt);
    updateDebug(w);
    w.events.length = 0;
    renderer.render(scene, camera);
    if (steps > 0) endInputFrame(w.input);
    else { w.input.mouseDX = 0; w.input.mouseDY = 0; }
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fff;position:fixed;top:10px;left:10px">Failed to start: ${String(e)}</pre>`);
});
