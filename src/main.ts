// Boot + game loop. Opens straight into the live world with a one-line "press any key" title.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { Rng, seedFromUrl } from './rng';
import type { World } from './world';
import { createInput, endInputFrame, act } from './systems/input';
import { loadMap } from './systems/map/loadMap';
import { validateCityMap, laneSample, projectOnLane, roadRouter, walkRouter } from './systems/map/cityMap';
import { createDayNight, updateDayNight } from './systems/dayNight';
import { createCamera, updateCamera } from './systems/camera';
import { createPlayer, updatePlayer } from './systems/player';
import { spawnInitialVehicles, updateVehicles, detectCrashes, wreckMaterial } from './systems/vehicles';
import { createHud, showHud, updateHud } from './systems/hud';
import { createDebug, updateDebug } from './systems/debug';
import { spawnTraffic, updateTraffic, syncTraffic } from './systems/traffic';
import { spawnPeds, updatePeds } from './systems/pedestrians';
import { createPedDensity, densityAround, updatePedDensity } from './systems/pedDensity';
import { updateNpcMemory } from './systems/npcMemory';
import { createPolice, spawnPolicePool, updatePolice, drivePolice, syncPolice } from './systems/police';
import { JobManager } from './systems/economy/jobManager';
import { TaxiJob } from './systems/economy/taxi';
import { DealershipJob, pickDealershipPois } from './systems/economy/dealership';
import { assignCarOwners, updateCarTheft, theftStats } from './systems/carTheft';
import { createChat, updateChat } from './systems/chat';
import { createMinimap, showMinimap, updateMinimap, minimapStats } from './systems/minimap';
import { createAudio, startAudio, updateAudio, toggleMute } from './systems/audio';
import { ScriptedProvider } from './npc/providers/scripted';
import { Profiler } from './systems/profiler';
import { createSettings, applyQuality } from './systems/settings';
import { createPauseMenu, updatePauseKeys } from './systems/pauseMenu';
import { createItems, scatterItems, updateWorldItems } from './systems/worldItems';
import { createInventory, inventoryKeys, updateInventory, showHotbar } from './systems/inventory';
import { createCombat, updateCombat, thrownItemHitCollider } from './systems/combat';
import { createBubbles, updateBubbles } from './systems/bubbles';
import { createCrowd, renderCrowd } from './systems/crowdRender';
import { updateWitnesses, witnessStats } from './systems/witness';
import { updateCarDamage } from './systems/carDamage';
import { createHealthUi, updateHealth } from './systems/health';
import { createWeather, updateWeather, cycleWeather } from './systems/weather';
import { createHurtFx, updateHurtFx, showHurtFxForWarmup } from './systems/hurtFx';

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
  // Rapier 0.21's World.step() ends with mapNewSoftBodies(), which walks every body and collider through
  // JS callbacks to sync its lookup maps. Measured: ~150 KB of garbage per frame with ~2000 colliders,
  // the main cause of GC stutter. We never create or remove anything inside the engine (no soft bodies),
  // and createRigidBody/createCollider/remove* already update those maps, so the per-step walk is skipped.
  (physics as unknown as { mapNewSoftBodies: () => void }).mapNewSoftBodies = () => {};

  // Systems fill in the World in order; fields used before creation get safe placeholders.
  const w = {
    seed, rng: new Rng(seed), R: RAPIER, physics, renderer, scene, camera,
    input: createInput(canvas), cam: createCamera(), vehicles: [], traffic: [], peds: [], cash: TUNING.economy.startingCash,
    started: false, paused: false, time: 0, frameDt: 0, fps: 60, debugVisible: false, events: [], colliderOwner: new Map(),
    prof: new Profiler(), settings: createSettings(), police: createPolice(), jobs: new JobManager(), audio: createAudio(), dialogue: new ScriptedProvider(),
  } as unknown as World;
  w.dayNight = createDayNight(scene);
  applyQuality(w, w.settings.quality, true);
  const tMap = performance.now();
  w.city = await loadMap(scene, RAPIER, physics, seed, w.settings.quality); // ?map= picks the map; the seed never does
  w.city.setQuality?.(w.settings.quality);
  const mapMs = performance.now() - tMap;
  w.weather = createWeather(w);
  const spawn = w.city.spawn;
  w.player = createPlayer(w, spawn.x, spawn.z);
  w.player.facing = spawn.heading;
  // dealership showrooms plan their kerb slots first so random parked cars keep clear of them; the display
  // cars are parked after the starting cars (vehicle ids 0..2 stay the cars at the taxi rank)
  const dealerships = new DealershipJob(w, pickDealershipPois(w.city));
  spawnInitialVehicles(w, dealerships.reservedSpots());
  dealerships.stockShowrooms(w);
  w.itemsState = createItems(w);
  scatterItems(w);
  spawnTraffic(w);
  spawnPolicePool(w);
  w.pedDensity = createPedDensity(w); // crowd density from the map (shops, road class, time of day)
  spawnPeds(w);
  assignCarOwners(w); // every parked car that isn't yours belongs to someone (or nobody)
  w.crowd = createCrowd(w, TUNING.peds.maxPopulation + 4);
  w.hurtFx = createHurtFx(w);
  w.hud = createHud();
  w.chat = createChat(w);
  w.jobs.bind(w);
  w.jobs.register(new TaxiJob(w));
  w.jobs.register(dealerships);
  createMinimap(w);
  createDebug(w);
  createHealthUi();
  createPauseMenu(w);
  w.inventory = createInventory(w);
  w.combat = createCombat(w);
  createBubbles();

  // GPU warm-up: compile every shader now (police cars and the wreck look included) so a crash never
  // triggers a first-time shader compile mid-game
  {
    const pool = w.police.pool;
    for (const c of pool) c.mesh.visible = true;
    const keep = pool[0].mesh.material;
    pool[0].mesh.material = wreckMaterial;
    const crack = w.vehicles[0].dmg.crack;
    crack.visible = true;
    showHurtFxForWarmup(w.hurtFx, true);
    renderer.compile(scene, camera);
    showHurtFxForWarmup(w.hurtFx, false);
    crack.visible = false;
    pool[0].mesh.material = keep;
    for (const c of pool) c.mesh.visible = false;
  }

  // expose read-only state for automated tests (scripts/*.mjs)
  (window as unknown as { __oc: World }).__oc = w;
  (window as unknown as { __ocWitness: unknown }).__ocWitness = witnessStats;
  (window as unknown as { __ocTheft: unknown }).__ocTheft = theftStats;
  (window as unknown as { __ocMinimap: unknown }).__ocMinimap = minimapStats;
  (window as unknown as { __ocMap: unknown }).__ocMap = { validate: () => validateCityMap(w.city), laneSample, projectOnLane, roadRouter: () => roadRouter(w.city), walkRouter: () => walkRouter(w.city) };
  (window as unknown as { __ocDensity: unknown }).__ocDensity = { around: (x: number, z: number, r: number) => densityAround(w, x, z, r), update: () => updatePedDensity(w, 0, true) };

  /** Collision events (thrown items hitting people and cars are handled in M2.7). */
  function drainPhysicsEvents(w: World) {
    const S = w.itemsState;
    S.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = S.byCollider.get(h1), b = S.byCollider.get(h2);
      if (a?.thrown) thrownItemHitCollider(w, a, h2);
      if (b?.thrown) thrownItemHitCollider(w, b, h1);
    });
  }

  /** One fixed physics tick for everything that moves bodies. */
  function simStep(step: number) {
    const P = w.prof;
    P.begin('player'); updatePlayer(w, step); P.end('player');
    P.begin('vehicles'); updateVehicles(w, step); P.end('vehicles');
    P.begin('traffic'); updateTraffic(w, step); P.end('traffic');
    P.begin('police-drive'); drivePolice(w, step); P.end('police-drive');
    P.begin('physics'); physics.step(w.itemsState.eventQueue); drainPhysicsEvents(w); P.end('physics');
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
      showHotbar();
      startAudio(w.audio);
      w.cam.yaw = Math.PI / 2;
    }
    if (act.debug(w.input)) w.debugVisible = !w.debugVisible;
    updatePauseKeys(w);
    if (!w.paused) inventoryKeys(w);
    if (w.paused) {
      // world frozen behind the menu; keep drawing it
      if (render) renderer.render(scene, camera);
      endInputFrame(w.input);
      return;
    }
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
      P.begin('theft'); updateCarTheft(w, dt); P.end('theft');
    }
    // event consumers run once per frame, then events are cleared
    P.begin('memory'); updateNpcMemory(w); P.end('memory');
    P.begin('police'); updateWitnesses(w, dt); updatePolice(w, dt); updateHealth(w, dt); P.end('police');
    P.begin('audio'); updateAudio(w, dt); P.end('audio');
    w.events.length = 0;

    P.begin('sync'); syncTraffic(w); syncPolice(w); updateCarDamage(w, dt); updateWorldItems(w, dt); if (w.started) updateCombat(w, dt); updateInventory(w); updateBubbles(w); P.end('sync');
    P.begin('fx'); updateHurtFx(w, dt); P.end('fx');
    P.begin('daynight'); updateDayNight(w, dt); P.end('daynight');
    P.begin('weather'); updateWeather(w, dt); P.end('weather');
    if (render) { P.begin('city'); w.city.update(w.time, camera); P.end('city'); }
    P.begin('camera'); updateCamera(w, dt); P.end('camera');
    P.begin('hud'); updateHud(w, dt); P.end('hud');
    if (render) {
      P.begin('minimap'); updateMinimap(w); P.end('minimap');
      P.begin('debug'); updateDebug(w); P.end('debug');
      P.begin('render'); renderCrowd(w); renderer.render(scene, camera); P.end('render');
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

  // boot timing for tests: map build, and page start -> first rendered (playable) frame
  const boot = { mapMs: Math.round(mapMs), firstFrameMs: 0 };
  (window as unknown as { __ocBoot: typeof boot }).__ocBoot = boot;
  function frame(now: number) {
    requestAnimationFrame(frame);
    if (!boot.firstFrameMs) boot.firstFrameMs = Math.round(performance.now());
    // never negative: after a long boot the first rAF timestamp can be older than `last`, which would wind the
    // fixed-step accumulator back and freeze the simulation for as long as the boot took
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
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
