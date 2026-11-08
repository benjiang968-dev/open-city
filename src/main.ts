// Boot + game loop. Opens straight into the live world with a one-line "press any key" title.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { Rng, seedFromUrl } from './rng';
import type { World } from './world';
import { createInput, endInputFrame, act } from './systems/input';
import { loadMap, physAuditFromUrl } from './systems/map/loadMap';
import { validateCityMap, laneSample, projectOnLane, roadRouter, walkRouter } from './systems/map/cityMap';
import { createDayNight, updateDayNight, updateSky, attachLampLights } from './systems/dayNight';
import { createCamera, updateCamera } from './systems/camera';
import { createPlayer, updatePlayer } from './systems/player';
import { spawnInitialVehicles, updateVehicles, detectCrashes, wreckMaterial } from './systems/vehicles';
import { createHud, showHud, updateHud } from './systems/hud';
import { createDebug, updateDebug } from './systems/debug';
import { spawnTraffic, updateTraffic, syncTraffic, placeOnEdge, type AiCar } from './systems/traffic';
import { createJunctions, findMove, ringDist, turnCurve, TURN_SEGS } from './systems/junctions';
import { placeInitialTraffic, updateTrafficPopulation } from './systems/trafficPopulation';
import { createSignalHeads, updateSignalHeads } from './systems/signalHeads';
import { resetTrafficStats } from './systems/trafficAudit';
import { spawnPeds, updatePeds } from './systems/pedestrians';
import { createPedDensity, densityAround, updatePedDensity } from './systems/pedDensity';
import { createParkedCars, assignParkedOwners, updateParkedCars } from './systems/parkedCars';
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
import { createItems, scatterItems, updateWorldItems, spawnItem, placeInWorld } from './systems/worldItems';
import { createInventory, inventoryKeys, updateInventory, showHotbar } from './systems/inventory';
import { createCombat, updateCombat, thrownItemHitCollider } from './systems/combat';
import { createBubbles, updateBubbles } from './systems/bubbles';
import { createCrowd, renderCrowd } from './systems/crowdRender';
import { updateWitnesses, witnessStats } from './systems/witness';
import { updateCarDamage } from './systems/carDamage';
import { createHealthUi, updateHealth } from './systems/health';
import { createWeather, updateWeather, cycleWeather } from './systems/weather';
import { createHurtFx, updateHurtFx, showHurtFxForWarmup } from './systems/hurtFx';
import { createPhysDebug, physDebugKeys, updatePhysDebug } from './systems/physicsDebug';
import { createLook, bakeLook } from './systems/render/look';
import { warmDraw } from './systems/render/warmup';
import { createInteriors, interiorInteraction, updateInteriors, enterInterior, exitInterior } from './systems/interiors';
import { createSandbox, sandboxKeys, sandboxInteraction, updateSandbox, captureSandbox, restoreSandbox, startSandboxJob, transactApartment, storeApartmentItem, retrieveApartmentItem, payShopItem } from './systems/sandbox';
import { seedInteriorCollectibles } from './systems/interiorCollectibles';
import { createPersistence, loadGame, readStartingLayout, saveGame, updatePersistence, persistenceStatus } from './systems/persistence';
import { emit } from './world';
import { separateInstancedDepth } from './systems/render/shadowCasters';

async function boot() {
  const loading = (message: string) => { document.getElementById('title')!.textContent = message; };
  loading('Loading physics…');
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
  // procedural PBR surface maps, baked on the GPU before any world material is built (render/texBake.ts)
  loading('Preparing materials…');
  w.look = createLook(w.settings.quality);
  bakeLook(w.look, renderer, w.settings.quality);
  applyQuality(w, w.settings.quality, true);
  loading('Building city…');
  const tMap = performance.now();
  w.city = await loadMap(scene, RAPIER, physics, seed, w.settings.quality, w.look); // ?map= picks the map; the seed never does
  w.city.setQuality?.(w.settings.quality);
  attachLampLights(w, TUNING.quality[w.settings.quality].lampLights);
  const mapMs = performance.now() - tMap;
  loading('Preparing city life…');
  w.weather = createWeather(w);
  w.startingLayout = await readStartingLayout(w.city.id, w.seed);
  const spawn = w.city.spawn;
  w.player = createPlayer(w, spawn.x, spawn.z);
  w.player.facing = spawn.heading;
  // dealership showrooms plan their kerb slots first so parked cars keep clear of them; the display cars are parked
  // after the starting cars (vehicle ids 0..2 stay the cars at the taxi rank), then every other parked car
  const dealerships = new DealershipJob(w, pickDealershipPois(w.city));
  const startingSpots = spawnInitialVehicles(w, dealerships.reservedSpots());
  dealerships.stockShowrooms(w);
  createParkedCars(w, [...dealerships.reservedSpots(), ...startingSpots]);
  w.itemsState = createItems(w);
  scatterItems(w);
  w.junctions = createJunctions(w.city);
  w.signalHeads = createSignalHeads(w);
  spawnTraffic(w);
  spawnPolicePool(w);
  w.pedDensity = createPedDensity(w); // crowd density from the map (shops, road class, time of day)
  spawnPeds(w);
  placeInitialTraffic(w); // after the parked cars and the police pool: spread the preset's cars round the spawn
  assignCarOwners(w); // every parked car that isn't yours belongs to someone (or nobody)
  assignParkedOwners(w);
  w.crowd = createCrowd(w, TUNING.peds.maxPopulation + 4);
  w.hurtFx = createHurtFx(w);
  w.physDebug = createPhysDebug();
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
  w.interiors = createInteriors(w);
  // Register all interior goods deterministically before loading IDs from a save. Room physics is streamed on entry.
  for (const e of w.interiors.entries.slice(0, 6)) {
    const types = e.kind === 'shop' || e.kind === 'cafe' ? ['bottle', 'can', 'bottle'] as const
      : e.kind === 'workshop' ? ['wrench', 'brick'] as const : ['can', 'bottle'] as const;
    types.forEach((type, i) => {
      const it = spawnItem(w, type, e.origin.x, e.origin.z, 0);
      if (!it) return;
      placeInWorld(w, it, e.origin.x - 1.4 + i * 0.8, e.origin.y + w.itemsState.art[type].restY + 0.03, e.origin.z + 0.6, 0, 0, 0, 0);
      it.body.setAngvel({ x: 0, y: 0, z: 0 }, false); it.body.sleep();
      if (e.kind === 'shop' || e.kind === 'cafe') { it.owner = e.id; it.price = 5; it.sealed = true; }
    });
  }
  w.sandbox = createSandbox(w);
  seedInteriorCollectibles(w);
  w.interiors.onExit = e => {
    if (!persistenceStatus(w).ready) return;
    // Carrying stock is allowed for inspection; leaving without paying triggers the shopkeeper report once.
    for (const it of w.inventory.slots) if (it?.owner === e.id && !it.reportedTheft) {
      it.stolen = true; it.reportedTheft = true;
      emit(w, { type: 'shopTheft', x: e.exterior.x, z: e.exterior.z, itemId: it.id, itemName: TUNING.items.defs[it.type].name });
    }
    void saveGame(w);
  };
  createPersistence(w, {
    capture: () => ({ sandbox: captureSandbox(w), interior: w.interiors.active,
      rooms: w.interiors.entries.filter(e => e.room).map(e => e.id) }),
    restore: value => {
      const extra = value as { sandbox?: unknown; interior?: string; rooms?: string[] } | null;
      // Restore floors before dropped goods or the player can advance a physics tick.
      for (const id of extra?.rooms ?? []) { if (enterInterior(w, w.interiors, id)) exitInterior(w, w.interiors); }
      if (extra?.interior) enterInterior(w, w.interiors, extra.interior);
      restoreSandbox(w, extra?.sandbox);
    },
  });
  await loadGame(w);


  // the sky light (PMREM environment) exists before anything compiles, so no material recompiles when it arrives
  updateDayNight(w, 0);
  updateWeather(w, 0);
  updateSky(w, true);
  loading('Preparing graphics…');
  // GPU warm-up: compile every shader now (police cars and the wreck look included) so a crash never
  // triggers a first-time shader compile mid-game
  {
    const pool = w.police.pool;
    for (const c of pool) c.mesh.visible = true;
    const keep = pool[0].mesh.material;
    pool[0].mesh.material = wreckMaterial;
    const crack = w.vehicles[0].dmg.crack;
    crack.visible = true;
    updateParkedCars(w, 0); // the instanced parked cars exist and are drawn
    const car0 = w.vehicles[0].mesh, car0Shown = car0.visible;
    car0.visible = true; // a car's own meshes (shown once driven or dented)
    showHurtFxForWarmup(w.hurtFx, true);
    separateInstancedDepth(scene); // instanced shadow casters keep their own depth program (no per-draw program churn)
    renderer.compile(scene, camera);
    warmDraw(renderer, scene); // and draw each kind once: some drivers finish a program only at its first draw
    showHurtFxForWarmup(w.hurtFx, false);
    crack.visible = false;
    car0.visible = car0Shown;
    pool[0].mesh.material = keep;
    for (const c of pool) c.mesh.visible = false;
  }

  loading('press any key');
  // expose read-only state for automated tests (scripts/*.mjs)
  (window as unknown as { __oc: World }).__oc = w;
  (window as unknown as { __ocWitness: unknown }).__ocWitness = witnessStats;
  (window as unknown as { __ocTheft: unknown }).__ocTheft = theftStats;
  (window as unknown as { __ocMinimap: unknown }).__ocMinimap = minimapStats;
  (window as unknown as { __ocMap: unknown }).__ocMap = { validate: () => validateCityMap(w.city), laneSample, projectOnLane, roadRouter: () => roadRouter(w.city), walkRouter: () => walkRouter(w.city), roadLimits: TUNING.geo.roadLimits };
  (window as unknown as { __ocSandbox: unknown }).__ocSandbox = {
    startJob: (kind: Parameters<typeof startSandboxJob>[1]) => startSandboxJob(w, kind),
    rent: (id: string) => transactApartment(w, id, 'rent'), buy: (id: string) => transactApartment(w, id, 'buy'),
    store: (id: string) => storeApartmentItem(w, id), retrieve: (id: number) => retrieveApartmentItem(w, id),
    pay: () => payShopItem(w), enterInterior: (id: string) => enterInterior(w, w.interiors, id),
    exitInterior: () => exitInterior(w, w.interiors), save: () => saveGame(w), status: () => persistenceStatus(w),
  };
  // physics audit (tests only, ?physaudit=1): drawn geometry vs colliders, see systems/physicsAudit.ts
  if (physAuditFromUrl()) {
    const { runPhysicsAudit } = await import('./systems/physicsAudit');
    (window as unknown as { __ocPhysAudit: unknown }).__ocPhysAudit = (opts?: Parameters<typeof runPhysicsAudit>[1]) => runPhysicsAudit(w, opts);
  }
  (window as unknown as { __ocTraffic: unknown }).__ocTraffic = {
    placeOnEdge: (car: AiCar, edge: number, s0: number) => placeOnEdge(w, car, edge, s0),
    resetStats: () => resetTrafficStats(w.trafficSim.stats),
    findMove: (a: number, b: number) => findMove(w.junctions, a, b),
    ringDist: (car: AiCar, node: number) => ringDist(w, car, node),
    turnCurve: (a: number, b: number) => { const P = new Float32Array(2 * (TURN_SEGS + 1)), C = new Float32Array(TURN_SEGS + 1); turnCurve(w.city.roads.edges[a], w.city.roads.edges[b], P, C); return Array.from(P); },
  };
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
    P.begin('player'); sandboxInteraction(w); interiorInteraction(w, w.interiors); updatePlayer(w, step); P.end('player');
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
    physDebugKeys(w);
    updatePauseKeys(w);
    if (!w.paused) { sandboxKeys(w); inventoryKeys(w); }
    if (w.paused) {
      // world frozen behind the menu; keep drawing it
      if (render) renderer.render(scene, camera);
      endInputFrame(w.input);
      return;
    }
    if (w.input.pressed.has('KeyM')) toggleMute(w.audio);
    if (w.started && !w.input.blocked && w.input.pressed.has('KeyN')) cycleWeather(w);

    // drivable stand-ins for the parked cars around you (before physics), and the parked-car draw lists
    P.begin('parked'); updateParkedCars(w, dt); P.end('parked');
    acc += dt;
    let steps = 0;
    P.begin('sim');
    while (acc + 1e-9 >= STEP && steps < 4) {
      simStep(STEP);
      acc = Math.max(0, acc - STEP);
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
    updateInteriors(w, w.interiors, dt);
    updateSandbox(w, dt);
    // event consumers run once per frame, then events are cleared
    P.begin('memory'); updateNpcMemory(w); P.end('memory');
    P.begin('police'); updateWitnesses(w, dt); updatePolice(w, dt); updateHealth(w, dt); P.end('police');
    P.begin('audio'); updateAudio(w, dt); P.end('audio');
    w.events.length = 0;

    P.begin('traffic-ctl'); updateTrafficPopulation(w); updateSignalHeads(w, w.signalHeads); P.end('traffic-ctl');
    P.begin('sync'); syncTraffic(w); syncPolice(w); updateCarDamage(w, dt); updateWorldItems(w, dt); if (w.started) updateCombat(w, dt); updateInventory(w); updateBubbles(w); P.end('sync');
    P.begin('fx'); updateHurtFx(w, dt); P.end('fx');
    P.begin('daynight'); updateDayNight(w, dt); P.end('daynight');
    P.begin('weather'); updateWeather(w, dt); updateSky(w); P.end('weather');
    if (render) { P.begin('city'); w.city.update(w.time, camera); P.end('city'); }
    P.begin('camera'); updateCamera(w, dt); P.end('camera');
    P.begin('hud'); updateHud(w, dt); P.end('hud');
    if (render) {
      P.begin('minimap'); updateMinimap(w); P.end('minimap');
      P.begin('debug'); updateDebug(w); updatePhysDebug(w); P.end('debug');
      P.begin('render'); renderCrowd(w); renderer.render(scene, camera); P.end('render');
    }
    updatePersistence(w, dt);
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
    const elapsed = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.1, elapsed); // cap simulation catch-up, not the measured display frame rate
    last = now;
    fpsAcc += elapsed;
    fpsFrames++;
    if (fpsAcc > 0.5) { w.fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    tick(dt, true, Math.max(0, now - last0));
    last0 = now;
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fff;position:fixed;top:10px;left:10px">Failed to start: ${String(e)}</pre>`);
});
