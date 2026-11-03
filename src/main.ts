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
import { spawnTraffic, updateTraffic, syncTraffic } from './systems/traffic';
import { spawnPeds, updatePeds } from './systems/pedestrians';
import { updateNpcMemory } from './systems/npcMemory';
import { createPolice, spawnPolicePool, updatePolice, drivePolice, syncPolice } from './systems/police';
import { JobManager } from './systems/economy/jobManager';
import { TaxiJob } from './systems/economy/taxi';
import { createChat, updateChat } from './systems/chat';
import { createMinimap, showMinimap, updateMinimap } from './systems/minimap';
import { createAudio, startAudio, updateAudio, toggleMute } from './systems/audio';
import { ScriptedProvider } from './npc/providers/scripted';
import { createWeather, updateWeather, cycleWeather } from './systems/weather';

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
    police: createPolice(), jobs: new JobManager(), audio: createAudio(), dialogue: new ScriptedProvider(),
  } as unknown as World;
  w.dayNight = createDayNight(scene);
  w.city = generateCity(scene, RAPIER, physics, seed);
  w.weather = createWeather(w);
  const rank = w.city.taxiRanks[0];
  w.player = createPlayer(w, rank.x, rank.z);
  spawnInitialVehicles(w);
  spawnTraffic(w);
  spawnPolicePool(w);
  spawnPeds(w);
  w.hud = createHud();
  w.chat = createChat(w);
  w.jobs.bind(w);
  w.jobs.register(new TaxiJob(w));
  createMinimap(w);
  createDebug(w);

  // expose read-only state for automated tests (scripts/*.mjs)
  (window as unknown as { __oc: World }).__oc = w;

  /** One fixed physics tick for everything that moves bodies. */
  function simStep(step: number) {
    updatePlayer(w, step);
    updateVehicles(w, step);
    updateTraffic(w, step);
    drivePolice(w, step);
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

  /** One whole game frame. `render` is false when tests fast-forward the simulation. */
  function tick(dt: number, render: boolean) {
    w.time += dt;
    w.frameDt = dt;
    if (!w.started && w.input.anyKeyPressed) {
      w.started = true;
      w.input.pressed.clear();
      showHud(w.hud, w.cash);
      showMinimap();
      startAudio(w.audio);
      w.cam.yaw = Math.PI / 2;
    }
    if (act.debug(w.input)) w.debugVisible = !w.debugVisible;
    if (w.input.pressed.has('KeyM')) toggleMute(w.audio);
    if (w.started && !w.input.blocked && w.input.pressed.has('KeyN')) cycleWeather(w);

    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      simStep(STEP);
      acc -= STEP;
      steps++;
      if (steps === 1) w.input.pressed.clear(); // one-shot keys fire once per frame
    }
    if (steps === 4) acc = 0;

    if (w.started) {
      updatePeds(w, dt);
      updateChat(w);
      w.jobs.update(w, dt);
    }
    // event consumers run once per frame, then events are cleared
    updateNpcMemory(w);
    updatePolice(w, dt);
    updateAudio(w, dt);
    w.events.length = 0;

    syncTraffic(w);
    syncPolice(w);
    updateDayNight(w, dt);
    updateWeather(w, dt);
    if (render) updateCity(w.city, w.time);
    updateCamera(w, dt);
    updateHud(w, dt);
    if (render) {
      updateMinimap(w);
      updateDebug(w);
      renderer.render(scene, camera);
    }
    if (steps > 0) endInputFrame(w.input);
    else { w.input.mouseDX = 0; w.input.mouseDY = 0; }
  }
  // tests: fast-forward whole frames without rendering
  (window as unknown as { __ocRun: (seconds: number, fps?: number) => void }).__ocRun = (seconds: number, fps = 30) => {
    for (let k = 0; k < seconds * fps; k++) tick(1 / fps, false);
  };

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) { w.fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    tick(dt, true);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fff;position:fixed;top:10px;left:10px">Failed to start: ${String(e)}</pre>`);
});
