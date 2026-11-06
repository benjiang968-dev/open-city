// Georgetown world preview (preview.html): builds the world generator v2 on its own, with a free-fly camera, the
// game's day/night lighting, and window hooks (window.__geo) for scripted screenshots and perf readouts
// (scripts/previewShots.mjs). Independent of the game's main.ts.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import { attachLampLights, createDayNight, updateDayNight, updateSky } from '../systems/dayNight';
import { buildGeorgetownWorld, type GeoQuality, type GeoWorld } from '../systems/map/georgetownWorld';
import { loadGeoDoc } from '../systems/map/geoDoc';
import type { World } from '../world';
import { bakeLook, createLook } from '../systems/render/look';
import { fillMissingLayers, loadTextureLibrary } from '../systems/render/texLibrary';
import { createTexSheet } from '../systems/render/texSheet';
import { warmDraw } from '../systems/render/warmup';

type View = { pos: [number, number, number]; look: [number, number, number]; hour: number; fov: number; abs?: boolean; deck?: boolean };
/** Named camera views (x, z are map metres; y is metres above the ground there unless abs). */
const VIEWS: Record<string, View> = {
  aerial: { pos: [0, 1750, 1180], look: [0, 0, -60], hour: 11, fov: 48, abs: true },
  mst: { pos: [-262, 1.8, 158.4], look: [-120, 4.5, 154.5], hour: 15.5, fov: 62 },
  keybridge: { pos: [-803, 2.2, 360], look: [-768, 4, 140], hour: 16.5, fov: 62, deck: true },
  circle: { pos: [905, 40, 528], look: [910.8, 0, 446], hour: 13, fov: 62 },
  canal: { pos: [-405, 2.6, 243], look: [-300, 1.5, 231], hour: 10.5, fov: 62 },
  waterfront: { pos: [-140, 26, 640], look: [60, 2, 470], hour: 17.5, fov: 60, abs: false },
  rowhouses: { pos: [12, 1.8, -9.6], look: [160, 3.0, -11.6], hour: 9.5, fov: 62 },
  night: { pos: [-262, 1.8, 158.4], look: [-120, 4.5, 154.5], hour: 21.6, fov: 62 },
  freeway: { pos: [-420, 18, 330], look: [-200, 10, 400], hour: 14, fov: 60 },
  wisconsin: { pos: [-150, 2, 120], look: [-185, 20, -120], hour: 12, fov: 62 },
  exorcist: { pos: [-806, 2, 135], look: [-815, 9, 85], hour: 14, fov: 62 },
  healy: { pos: [-900, 30, -60], look: [-997, 25, -122], hour: 15, fov: 60 },
};
/** Review viewpoints (scripts/previewShots.mjs --review writes screenshots/26-geo-r-<name>.jpg). */
export const REVIEW_VIEWS: Record<string, View> = {
  'kb-mst-approach': { pos: [-690, 1.8, 141], look: [-780, 5, 136], hour: 14, fov: 62 },
  'kb-canalrd-approach': { pos: [-965, 1.8, 104], look: [-800, 6, 134], hour: 14, fov: 62 },
  'kb-deck-north': { pos: [-792, 2, 262], look: [-768, 2.5, 133], hour: 15, fov: 62, deck: true },
  'kb-abutment': { pos: [-690, 12, 300], look: [-790, 6, 175], hour: 15, fov: 60, abs: true },
  'fw-west-ramp': { pos: [-705, 9, 185], look: [-620, 8, 200], hour: 14, fov: 62 },
  'fw-east-ramp': { pos: [300, 16, 485], look: [440, 3, 444], hour: 14, fov: 62 },
  'canal-lock': { pos: [245, 3.5, 252], look: [190, 0, 236], hour: 11, fov: 62 },
  'canal-footbridge': { pos: [-300, 3.2, 252], look: [-330, 1.5, 233], hour: 11, fov: 62 },
  towpath: { pos: [-555, 1.8, 238], look: [-650, 1.4, 229], hour: 10, fov: 62 },
  'waterfront-park': { pos: [-75, 2.2, 508], look: [60, 1.5, 548], hour: 17, fov: 62 },
  'waterfront-piers': { pos: [60, 8, 630], look: [100, 0, 580], hour: 16, fov: 60 },
  'circle-spoke': { pos: [905, 1.8, 318], look: [909, 3, 446], hour: 13, fov: 62 },
  'wisconsin-up': { pos: [-150, 2, 175], look: [-182, 16, -30], hour: 12, fov: 62 },
  'rowhouses-29th': { pos: [262.5, 1.8, -20], look: [254, 9, -160], hour: 9.5, fov: 62 },
  'rock-creek': { pos: [440, 10, 300], look: [430, 0, 160], hour: 13, fov: 62 },
  'mst-bridge': { pos: [575, 2, 124], look: [470, 5, 120], hour: 13, fov: 62 },
  'edge-north': { pos: [-120, 25, -760], look: [-120, 0, -840], hour: 13, fov: 62 },
  'edge-west': { pos: [-1050, 18, 30], look: [-1135, 0, 40], hour: 13, fov: 62 },
  'edge-east': { pos: [1060, 18, 300], look: [1135, 0, 300], hour: 13, fov: 62 },
  'lot-waterfront': { pos: [-600, 14, 365], look: [-640, 0, 312], hour: 13, fov: 62 },
  'lot-westend': { pos: [430, 14, 560], look: [460, 0, 515], hour: 13, fov: 62 },
  'canal-31st': { pos: [-28, 3, 275], look: [-28, 1, 232], hour: 12, fov: 62 },
  'kst-circle': { pos: [800, 3, 455], look: [860, 2, 443], hour: 13, fov: 62 },
  'night-keybridge': { pos: [-792, 2, 262], look: [-768, 2.5, 133], hour: 22, fov: 62, deck: true },
  'night-waterfront': { pos: [-75, 2.2, 508], look: [60, 1.5, 548], hour: 21.5, fov: 62 },
  'night-rowhouses': { pos: [262.5, 1.8, -20], look: [254, 9, -160], hour: 22.5, fov: 62 },
};

async function boot() {
  const params = new URLSearchParams(location.search);
  await RAPIER.init();
  const canvas = document.getElementById('geo') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 1600);
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
  const physics = new RAPIER.World({ x: 0, y: -TUNING.vehicles.gravity, z: 0 });
  (physics as unknown as { mapNewSoftBodies: () => void }).mapNewSoftBodies = () => {};

  const doc = await loadGeoDoc();
  const quality = (['low', 'medium', 'high'].includes(params.get('quality') ?? '') ? params.get('quality') : 'medium') as GeoQuality;
  const seed = Number(params.get('seed') ?? TUNING.world.defaultSeed) || TUNING.world.defaultSeed;
  const dn = createDayNight(scene);
  const look = createLook(quality);
  bakeLook(look, renderer, quality, true);
  await loadTextureLibrary(look, renderer);
  fillMissingLayers(look, renderer);
  const geo: GeoWorld = buildGeorgetownWorld(scene, RAPIER, physics, doc, { seed, quality, look });
  document.getElementById('loading')!.remove();
  const applyQ = (q: GeoQuality) => {
    geo.setQuality(q);
    if (bakeLook(look, renderer, q)) void loadTextureLibrary(look, renderer);
    const Q = TUNING.quality[q];
    const on = Q.shadows, size = Q.shadowMapSize;
    dn.sun.shadow.camera.far = Math.max(1, Q.shadowDistance);
    dn.lamps?.setActive(Q.lampLights);
    const changed = renderer.shadowMap.enabled !== on;
    renderer.shadowMap.enabled = on;
    dn.sun.castShadow = on;
    if (dn.sun.shadow.mapSize.x !== size) { dn.sun.shadow.mapSize.set(size, size); dn.sun.shadow.map?.dispose(); dn.sun.shadow.map = null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 2 : 1.25) * (q === 'low' ? 0.7 : 1));
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (changed) scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
  };
  applyQ(quality);

  // a fake World with only what updateDayNight reads
  const target = new THREE.Object3D();
  const fake = { dayNight: dn, player: { mesh: target, vehicle: null }, camera, scene, renderer, city: geo, look } as unknown as World;
  attachLampLights(fake, TUNING.quality[quality].lampLights);
  updateDayNight(fake, 0);
  updateSky(fake, true);
  warmDraw(renderer, scene);
  // texture sheet (debug): every baked layer, albedo above normals; ?texsheet=1 or __geo.texSheet(true)
  const sheet = createTexSheet(look);
  let showSheet = params.get('texsheet') === '1';
  let hour = 15;
  const state = { yaw: 0, pitch: 0, view: 'aerial' };
  const setCam = (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => {
    camera.position.set(px, py, pz);
    camera.lookAt(lx, ly, lz);
    const d = new THREE.Vector3(lx - px, ly - py, lz - pz).normalize();
    state.yaw = Math.atan2(d.x, d.z);
    state.pitch = Math.asin(d.y);
  };
  const setView = (name: string) => {
    const v = VIEWS[name] ?? REVIEW_VIEWS[name] ?? VIEWS.aerial;
    state.view = name;
    const [px, py, pz] = v.pos, [lx, ly, lz] = v.look;
    const gy = v.abs ? 0 : v.deck ? geo.roadSurfaceAt(px, pz) : geo.heightAt(px, pz);
    const gl = v.abs ? 0 : v.deck ? geo.roadSurfaceAt(lx, lz) : geo.heightAt(lx, lz);
    camera.fov = v.fov;
    camera.far = v.abs ? 6000 : 1600;
    camera.updateProjectionMatrix();
    setCam(px, gy + py, pz, lx, gl + ly, lz);
    hour = v.hour;
    const fog = scene.fog as THREE.FogExp2;
    fog.density = 1.7320508 / (v.abs ? 9000 : TUNING.weather.visibility.clear);
  };
  setView(params.get('view') ?? 'aerial');
  if (params.get('hour')) hour = Number(params.get('hour'));

  // ---- free-fly controls
  const keys = new Set<string>();
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    const n = Number(e.key);
    if (n >= 1 && n <= 9) setView(Object.keys(VIEWS)[n - 1]);
    if (e.code === 'KeyL') applyQ('low');
    if (e.code === 'KeyM') applyQ('medium');
    if (e.code === 'KeyH') applyQ('high');
    if (e.code === 'KeyN') hour = hour > 19 || hour < 6 ? 13 : 22;
    if (e.code === 'KeyP') { const h = document.getElementById('hud')!; h.style.display = h.style.display === 'none' ? '' : 'none'; }
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  let drag = false;
  canvas.addEventListener('mousedown', () => (drag = true));
  addEventListener('mouseup', () => (drag = false));
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    state.yaw -= e.movementX * 0.003;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch - e.movementY * 0.003));
  });

  // ---- loop
  const hud = document.getElementById('hud')!;
  const perf = { calls: 0, tris: 0, frameMs: 0, cpuMs: 0, frames: 0 };
  let last = performance.now();
  const fwd = new THREE.Vector3();
  /** Scripted captures (lookShots.mjs) stop the loop and render single frames themselves (software GL is slow). */
  let paused = false;
  const frame = () => {
    const now = performance.now();
    if (paused) { last = now; requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    perf.frameMs = perf.frameMs * 0.9 + (now - last) * 0.1;
    last = now;
    // move
    const sp = (keys.has('ShiftLeft') ? 120 : 25) * dt;
    fwd.set(Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), Math.cos(state.yaw) * Math.cos(state.pitch));
    if (keys.has('KeyW')) camera.position.addScaledVector(fwd, sp);
    if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -sp);
    if (keys.has('KeyA')) camera.position.add(new THREE.Vector3(fwd.z, 0, -fwd.x).normalize().multiplyScalar(sp));
    if (keys.has('KeyD')) camera.position.add(new THREE.Vector3(-fwd.z, 0, fwd.x).normalize().multiplyScalar(sp));
    if (keys.has('KeyE')) camera.position.y += sp;
    if (keys.has('KeyQ')) camera.position.y -= sp;
    camera.lookAt(camera.position.x + fwd.x, camera.position.y + fwd.y, camera.position.z + fwd.z);
    renderNow(now);
    if (perf.frames % 2 === 0) {
      const p = camera.position;
      hud.textContent = `view ${state.view}  quality ${geo.quality}  hour ${hour.toFixed(1)}\n` +
        `calls ${perf.calls}  tris ${(perf.tris / 1e6).toFixed(2)} M\nframe ${perf.frameMs.toFixed(1)} ms  cpu ${perf.cpuMs.toFixed(1)} ms\n` +
        `boot ${geo.stats.bootMs} ms  colliders ${geo.stats.colliders}\npos ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}  ground ${geo.heightAt(p.x, p.z).toFixed(1)}`;
    }
    requestAnimationFrame(frame);
  };
  /** Update the world for the current camera and draw one frame. */
  function renderNow(now: number) {
    const t0 = performance.now();
    // the sun follows a point in front of the camera (the game follows the player)
    const ahead = Math.min(60, Math.max(10, camera.position.y));
    target.position.set(camera.position.x + fwd.x * ahead, 0, camera.position.z + fwd.z * ahead);
    dn.hour = hour;
    updateDayNight(fake, 0);
    fake.time = now / 1000;
    updateSky(fake);
    geo.update(now / 1000, camera);
    renderer.info.reset();
    if (showSheet) renderer.render(sheet.scene, sheet.camera);
    else renderer.render(scene, camera);
    perf.calls = renderer.info.render.calls;
    perf.tris = renderer.info.render.triangles;
    perf.cpuMs = perf.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    perf.frames++;
  }
  requestAnimationFrame(frame);

  // ---- hooks for scripts/previewShots.mjs
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  physics.step();
  const castDown = (x: number, y: number, z: number) => {
    ray.origin = { x, y, z };
    const hit = physics.castRay(ray, 60, true);
    return hit ? y - hit.timeOfImpact : NaN;
  };
  /** Ground colliders only (trimeshes: terrain, roads, sidewalks, decks, lots), ignoring posts, trunks and boxes. */
  const groundOnly = (c: RAPIER.Collider) => c.shapeType() === RAPIER.ShapeType.TriMesh;
  const castGround = (x: number, y: number, z: number) => {
    ray.origin = { x, y, z };
    const hit = physics.castRay(ray, 60, true, undefined, undefined, undefined, undefined, groundOnly);
    return hit ? y - hit.timeOfImpact : NaN;
  };
  /** Like castDown, and the Rapier shape type that was hit (6 = trimesh ground, 1 = box, 10 = cylinder), or -1. */
  const castDownShape = (x: number, y: number, z: number, out: number[]) => {
    ray.origin = { x, y, z };
    const hit = physics.castRay(ray, 60, true);
    out[0] = hit ? y - hit.timeOfImpact : NaN;
    out[1] = hit ? hit.collider.shapeType() : -1;
    return out;
  };
  (window as unknown as { __geo: unknown }).__geo = {
    ready: true,
    stats: geo.stats,
    look,
    texSheet: (on: boolean) => { showSheet = on; },
    /** Debug: the renderer, scene, camera and day/night state; timeFrame renders once and waits for the GPU. */
    renderer, scene, camera, dn,
    /** Stop (true) or restart the animation loop. */
    pause: (on: boolean) => { paused = on; },
    /** Render one frame now (n times, for the sky light to settle) and return it as a PNG data URL. */
    capture: (n = 1) => {
      for (let i = 0; i < n; i++) renderNow(performance.now());
      return canvas.toDataURL('image/png');
    },
    timeFrame: () => {
      const gl = renderer.getContext(), px = new Uint8Array(4);
      const t0 = performance.now();
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { ms: Math.round(performance.now() - t0), calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    },
    geo,
    doc,
    castDown,
    castDownShape,
    castGround,
    setView: (n: string) => setView(n),
    /** Switch quality; returns the milliseconds GeoWorld.setQuality took (the renderer's own settings excluded). */
    setQuality: (q: GeoQuality) => { const t = performance.now(); geo.setQuality(q); const ms = performance.now() - t; applyQ(q); return ms; },
    setHour: (h: number) => { hour = h; },
    /** Ad-hoc camera for debugging: absolute position and look-at point. */
    setCamera: (px: number, py: number, pz: number, lx: number, ly: number, lz: number, fov = 60) => {
      state.view = 'custom';
      camera.fov = fov;
      camera.far = py > 300 ? 6000 : 1600;
      camera.updateProjectionMatrix();
      const fog = scene.fog as THREE.FogExp2;
      fog.density = 1.7320508 / (py > 300 ? 9000 : TUNING.weather.visibility.clear);
      setCam(px, py, pz, lx, ly, lz);
    },
    perf: () => ({ ...perf, view: state.view, quality: geo.quality }),
    reviewViews: Object.keys(REVIEW_VIEWS),
    /** Mean milliseconds of GeoWorld.update(time, camera) over n calls (perf script). */
    timeUpdate: (n: number) => { const t0 = performance.now(); for (let i = 0; i < n; i++) geo.update(i * 0.016, camera); return (performance.now() - t0) / n; },
    /** JS heap growth (bytes) over n GeoWorld.update calls; needs --enable-precise-memory-info and --expose-gc. */
    heapUpdate: (n: number) => {
      const g = (window as unknown as { gc?: () => void }).gc;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (!mem) return NaN;
      g?.();
      const m0 = mem.usedJSHeapSize;
      for (let i = 0; i < n; i++) geo.update(i * 0.016, camera);
      return mem.usedJSHeapSize - m0;
    },
    /** Compare the colliders with roadSurfaceAt along every lane and deck; look for lips on decks and ramps. */
    rayCheck: () => {
      let n = 0, bad = 0, maxErr = 0, lips = 0;
      const worst: string[] = [];
      for (const r of geo.roadPolys) {
        const c = r.centre;
        for (let i = 0; i + 3 < c.length; i += 3) {
          for (let t = 0.013; t < 1; t += 0.25) {
            const x = c[i] + (c[i + 3] - c[i]) * t, z = c[i + 2] + (c[i + 5] - c[i + 2]) * t;
            const B = geo.bounds;
            if (x < B.x0 + 3 || x > B.x1 - 3 || z < B.z0 + 3 || z > B.z1 - 3) continue;
            const yRef = c[i + 1] + (c[i + 4] - c[i + 1]) * t;
            const s = geo.roadSurfaceAt(x, z, yRef);
            const hit = castDown(x, s + 2.5, z);
            n++;
            const err = Math.abs(hit - s);
            if (!(err < 0.12)) { bad++; if (worst.length < 12) worst.push(`${r.name || r.roadId} @${x.toFixed(0)},${z.toFixed(0)} surf ${s.toFixed(2)} hit ${hit.toFixed(2)}`); }
            if (err > maxErr && Number.isFinite(err)) maxErr = err;
          }
        }
        if (r.deck) {
          let prev = NaN;
          for (let i = 0; i + 3 < c.length; i += 3) {
            for (let t = 0.013; t < 1; t += 0.1) {
              const x = c[i] + (c[i + 3] - c[i]) * t, z = c[i + 2] + (c[i + 5] - c[i + 2]) * t;
              const B = geo.bounds;
              if (x < B.x0 + 3 || x > B.x1 - 3 || z < B.z0 + 3 || z > B.z1 - 3) { prev = NaN; continue; }
              const y = c[i + 1] + (c[i + 4] - c[i + 1]) * t;
              const h = castDown(x, y + 1.5, z);
              if (Number.isFinite(prev) && Math.abs(h - prev) > 0.12) { lips++; if (worst.length < 20) worst.push(`lip on ${r.name} @${x.toFixed(0)},${z.toFixed(0)}: ${prev.toFixed(2)} -> ${h.toFixed(2)}`); }
              prev = h;
            }
          }
        }
      }
      return { samples: n, bad, maxErr, lips, worst };
    },
  };
}

boot().catch((e) => { console.error(e); document.getElementById('loading')!.textContent = String(e); });
