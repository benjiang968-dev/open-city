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
import { spawnInitialVehicles, updateVehicles, detectCrashes, wreckMaterial } from './systems/vehicles';
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
import { Profiler } from './systems/profiler';
import { updateCarDamage } from './systems/carDamage';
import { createHealthUi, updateHealth } from './systems/health';
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
    prof: new Profiler(), police: createPolice(), jobs: new JobManager(), audio: createAudio(), dialogue: new ScriptedProvider(),
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
  createHealthUi();

  // GPU warm-up: compile every shader now (police cars and the wreck look included) so a crash never
  // triggers a first-time shader compile mid-game
  {
    const pool = w.police.pool;
    for (const c of pool) c.mesh.visible = true;
    const keep = pool[0].mesh.material;
    pool[0].mesh.material = wreckMaterial;
    const crack = w.vehicles[0].dmg.crack;
    crack.visible = true;
    renderer.compile(scene, camera);
    crack.visible = false;
    pool[0].mesh.material = keep;
    for (const c of pool) c.mesh.visible = false;
  }

  // expose read-only state for automated tests (scripts/*.mjs)
  (window as unknown as { __oc: World }).__oc = w;

  /** One fixed physics tick for everything that moves bodies. */
  function simStep(step: number) {
    const P = w.prof;
    P.begin('player'); updatePlayer(w, step); P.end('player');
    P.begin('vehicles'); updateVehicles(w, step); P.end('vehicles');
    P.begin('traffic'); updateTraffic(w, step); P.end('traffic');
    P.begin('police-drive'); drivePolice(w, step); P.end('police-drive');
    P.begin('physics'); physics.step(); P.end('physics');
    P.begin('crashes'); detectCrashes(w); P.end('crashes');
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
  let last0 = last;
  let acc = 0;
  const STEP = 1 / 60;
  let fpsAcc = 0, fpsFrames = 0;

  /** One whole game frame. `render` is false when tests fast-forward the simulation. */
  function tick(dt: number, render: boolean, realMs = dt * 1000) {
    const P = w.prof;
    P.startFrame();
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
    P.begin('sim');
    while (acc >= STEP && steps < 4) {
      simStep(STEP);
      acc -= STEP;
      steps++;
      if (steps === 1) w.input.pressed.clear(); // one-shot keys fire once per frame
    }
    if (steps === 4) acc = 0;
    P.end('sim');

    if (w.started) {
      P.begin('peds'); updatePeds(w, dt); P.end('peds');
      P.begin('chat'); updateChat(w); P.end('chat');
      P.begin('jobs'); w.jobs.update(w, dt); P.end('jobs');
    }
    // event consumers run once per frame, then events are cleared
    P.begin('memory'); updateNpcMemory(w); P.end('memory');
    P.begin('police'); updatePolice(w, dt); updateHealth(w, dt); P.end('police');
    P.begin('audio'); updateAudio(w, dt); P.end('audio');
    w.events.length = 0;

    P.begin('sync'); syncTraffic(w); syncPolice(w); updateCarDamage(w, dt); P.end('sync');
    P.begin('daynight'); updateDayNight(w, dt); P.end('daynight');
    P.begin('weather'); updateWeather(w, dt); P.end('weather');
    if (render) { P.begin('city'); updateCity(w.city, w.time); P.end('city'); }
    P.begin('camera'); updateCamera(w, dt); P.end('camera');
    P.begin('hud'); updateHud(w, dt); P.end('hud');
    if (render) {
      P.begin('minimap'); updateMinimap(w); P.end('minimap');
      P.begin('debug'); updateDebug(w); P.end('debug');
      P.begin('render'); renderer.render(scene, camera); P.end('render');
    }
    P.endFrame(realMs, w.time);
    if (steps > 0) endInputFrame(w.input);
    else { w.input.mouseDX = 0; w.input.mouseDY = 0; }
  }
  // tests: fast-forward whole frames without rendering
  (window as unknown as { __ocRun: (seconds: number, fps?: number) => void }).__ocRun = (seconds: number, fps = 30) => {
    for (let k = 0; k < seconds * fps; k++) tick(1 / fps, false);
  };

  // tests: run n full frames (optionally rendered) and return each frame's CPU ms and its biggest sections
  (window as unknown as { __ocFrames: (n: number, render: boolean) => { cpu: number; top: string }[] }).__ocFrames = (n, render) => {
    const out: { cpu: number; top: string }[] = [];
    for (let k = 0; k < n; k++) {
      const t0 = performance.now();
      tick(1 / 60, render);
      const ms = performance.now() - t0;
      out.push({ cpu: +ms.toFixed(2), top: w.prof.breakdown() });
    }
    return out;
  };

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) { w.fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    tick(dt, true, now - last0);
    last0 = now;
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fff;position:fixed;top:10px;left:10px">Failed to start: ${String(e)}</pre>`);
});
