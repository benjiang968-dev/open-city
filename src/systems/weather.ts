// Weather: clear, cloudy, fog, rain, storm (lightning + thunder) and snow. Changes over game time,
// blends smoothly, dims the sun, thickens fog, makes roads wet/snowy and cuts tyre grip.
// Runs after the day/night system each frame and modifies its lighting.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';

const WT = TUNING.weather;

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow';
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'storm', 'snow'];

interface Look {
  cloud: number; // 0..1 sky cover (dims sun, greys sky)
  fogFar: number; // metres of visibility
  rain: number; // 0..1 rain particles
  snow: number; // 0..1 snow particles
  wet: number; // 0..1 how wet roads get
  grip: number; // tyre grip multiplier
}
const LOOKS: Record<WeatherKind, Look> = {
  clear: { cloud: 0, fogFar: 750, rain: 0, snow: 0, wet: 0, grip: 1 },
  cloudy: { cloud: 0.65, fogFar: 520, rain: 0, snow: 0, wet: 0, grip: 1 },
  fog: { cloud: 0.55, fogFar: WT.fogVisibility, rain: 0, snow: 0, wet: 0.2, grip: 0.97 },
  rain: { cloud: 0.8, fogFar: 300, rain: 0.6, snow: 0, wet: 1, grip: WT.rainGrip },
  storm: { cloud: 0.95, fogFar: 200, rain: 1, snow: 0, wet: 1, grip: WT.stormGrip },
  snow: { cloud: 0.75, fogFar: 240, rain: 0, snow: 1, wet: 0.4, grip: WT.snowGrip },
};
export const WEATHER_ICON: Record<WeatherKind, string> = { clear: '☀️', cloudy: '☁️', fog: '🌫️', rain: '🌧️', storm: '⛈️', snow: '🌨️' };

export interface WeatherState {
  kind: WeatherKind; // target weather
  look: Look; // current blended values
  timer: number; // real seconds until the next change
  flash: number; // lightning brightness 0..1
  nextLightning: number;
  snowCover: number; // 0..1 accumulated snow on the ground
  grip: number;
  rainPts: THREE.LineSegments;
  snowPts: THREE.Points;
  stars: THREE.Points;
  moon: THREE.Mesh;
  thunder?: () => void;
}

const DROPS = 3500;
const FLAKES = 2500;
const BOX = 60; // particle box around the camera (m)

export function createWeather(w: World): WeatherState {
  const scene = w.scene;
  // rain: short vertical line segments
  const rp = new Float32Array(DROPS * 6);
  for (let i = 0; i < DROPS; i++) {
    const x = (Math.random() - 0.5) * BOX * 2, y = Math.random() * 40, z = (Math.random() - 0.5) * BOX * 2;
    rp.set([x, y, z, x + 0.05, y - 0.9, z], i * 6);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  const rainPts = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaac4dd, transparent: true, opacity: 0.5, depthWrite: false }));
  rainPts.frustumCulled = false;
  rainPts.visible = false;
  scene.add(rainPts);
  // snow: soft round points
  const sp = new Float32Array(FLAKES * 3);
  for (let i = 0; i < FLAKES; i++) sp.set([(Math.random() - 0.5) * BOX * 2, Math.random() * 40, (Math.random() - 0.5) * BOX * 2], i * 3);
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const dot = document.createElement('canvas');
  dot.width = dot.height = 16;
  const dg = dot.getContext('2d')!;
  const grad = dg.createRadialGradient(8, 8, 0, 8, 8, 8);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  dg.fillStyle = grad;
  dg.fillRect(0, 0, 16, 16);
  const snowPts = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.25, map: new THREE.CanvasTexture(dot), transparent: true, depthWrite: false, opacity: 0.9 }));
  snowPts.frustumCulled = false;
  snowPts.visible = false;
  scene.add(snowPts);
  // stars on a big sphere, and a moon
  const st = new Float32Array(1500 * 3);
  for (let i = 0; i < 1500; i++) {
    const u = Math.random(), v = Math.random() * 0.9 + 0.1;
    const th = u * Math.PI * 2, ph = Math.acos(1 - v);
    st.set([Math.sin(ph) * Math.cos(th) * 850, Math.cos(ph) * 850, Math.sin(ph) * Math.sin(th) * 850], i * 3);
  }
  const stg = new THREE.BufferGeometry();
  stg.setAttribute('position', new THREE.BufferAttribute(st, 3));
  const stars = new THREE.Points(stg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.renderOrder = -0.5;
  scene.add(stars);
  const moon = new THREE.Mesh(new THREE.CircleGeometry(28, 24), new THREE.MeshBasicMaterial({ color: 0xf4f1de, fog: false, transparent: true, opacity: 0 }));
  moon.frustumCulled = false;
  scene.add(moon);

  const forced = new URLSearchParams(location.search).get('weather') as WeatherKind | null;
  const kind: WeatherKind = forced && WEATHER_KINDS.includes(forced) ? forced : 'clear';
  return {
    kind, look: { ...LOOKS[kind] }, timer: forced ? 1e9 : rangeRand(WT.minDuration, WT.maxDuration), flash: 0, nextLightning: 5,
    snowCover: kind === 'snow' ? 0.6 : 0, grip: LOOKS[kind].grip, rainPts, snowPts, stars, moon,
  };
}

function rangeRand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function pickNext(cur: WeatherKind): WeatherKind {
  const table = WT.transitions[cur] as unknown as [WeatherKind, number][];
  let r = Math.random() * table.reduce((a, [, p]) => a + p, 0);
  for (const [k, p] of table) {
    r -= p;
    if (r <= 0) return k as WeatherKind;
  }
  return 'clear';
}

/** N key: cycle to the next weather type. */
export function cycleWeather(w: World): void {
  setWeather(w, WEATHER_KINDS[(WEATHER_KINDS.indexOf(w.weather.kind) + 1) % WEATHER_KINDS.length]);
}

/** Force the weather (debug key / URL / tests). */
export function setWeather(w: World, kind: WeatherKind): void {
  w.weather.kind = kind;
  w.weather.timer = rangeRand(WT.minDuration, WT.maxDuration);
}

const grey = new THREE.Color();
export function updateWeather(w: World, dt: number): void {
  const s = w.weather;
  s.timer -= dt;
  if (s.timer <= 0) setWeather(w, pickNext(s.kind));

  // blend toward the target look
  const tgt = LOOKS[s.kind];
  const k = Math.min(1, dt / WT.blendSeconds);
  for (const key of Object.keys(tgt) as (keyof Look)[]) s.look[key] += (tgt[key] - s.look[key]) * k;
  const L = s.look;
  s.snowCover = THREE.MathUtils.clamp(s.snowCover + (L.snow > 0.5 ? dt / 60 : -dt / 90), 0, 1);
  s.grip = L.grip * (1 - s.snowCover * 0.1);

  // lighting: clouds dim the sun and grey the sky
  const dn = w.dayNight;
  dn.sun.intensity *= 1 - 0.88 * L.cloud;
  dn.hemi.intensity *= 1 - 0.25 * L.cloud;
  grey.setRGB(0.5, 0.53, 0.58).multiplyScalar(0.25 + 0.75 * (1 - dn.night));
  dn.skyTop.lerp(grey, Math.min(1, L.cloud * 1.05));
  dn.skyHorizon.lerp(grey, L.cloud * 0.7);
  const fog = w.scene.fog as THREE.Fog;
  fog.far = L.fogFar;
  fog.near = Math.min(180, L.fogFar * 0.25);
  fog.color.copy(dn.skyHorizon);

  // lightning during storms
  s.flash = Math.max(0, s.flash - dt * 4);
  if (L.rain > 0.8 && s.kind === 'storm') {
    s.nextLightning -= dt;
    if (s.nextLightning <= 0) {
      s.flash = 1;
      s.nextLightning = rangeRand(WT.lightningMin, WT.lightningMax);
      const delay = 400 + Math.random() * 2200;
      setTimeout(() => w.audio.thunder?.(), delay);
    }
  }
  if (s.flash > 0) {
    dn.hemi.intensity += s.flash * 2.5;
    dn.skyTop.lerp(grey.setRGB(0.85, 0.88, 1), s.flash * 0.8);
  }

  // wet roads get shiny and dark; snow whitens the ground
  for (const m of w.city.groundMats) {
    m.roughness = 0.95 - 0.55 * L.wet * (1 - s.snowCover);
    const wetDark = 1 - 0.25 * L.wet;
    m.color.setRGB(wetDark, wetDark, wetDark).lerp(grey.setRGB(2.2, 2.25, 2.4), s.snowCover * 0.55);
  }

  // particles follow the camera
  const c = w.camera.position;
  updateParticles(s.rainPts, c, L.rain, dt, 26, true);
  updateParticles(s.snowPts, c, L.snow, dt, 2.2, false);
  (s.rainPts.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.35 * L.rain;

  // stars and moon at night when the sky is clear enough
  const clearSky = 1 - L.cloud;
  (s.stars.material as THREE.PointsMaterial).opacity = Math.max(0, dn.night - 0.3) * 1.4 * clearSky;
  s.stars.position.copy(c);
  const ang = ((dn.hour - 18) / 12) * Math.PI; // moon rises in the evening
  s.moon.position.set(c.x - Math.cos(ang) * 700, Math.sin(ang) * 500 + 60, c.z - 300);
  s.moon.lookAt(c);
  (s.moon.material as THREE.MeshBasicMaterial).opacity = Math.max(0, dn.night - 0.2) * clearSky;

  w.audio.setRain?.(L.rain);
}

function updateParticles(obj: THREE.Points | THREE.LineSegments, cam: THREE.Vector3, amount: number, dt: number, speed: number, isRain: boolean) {
  obj.visible = amount > 0.03;
  if (!obj.visible) return;
  const g = obj.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  const stride = isRain ? 6 : 3;
  const count = a.length / stride;
  const active = Math.floor(count * amount);
  g.setDrawRange(0, active * (isRain ? 2 : 1));
  const t = performance.now() / 1000;
  for (let i = 0; i < active; i++) {
    const o = i * stride;
    a[o + 1] -= speed * dt;
    if (!isRain) a[o] += Math.sin(t + i) * dt * 0.6;
    if (a[o + 1] < 0) {
      a[o + 1] += 40;
      a[o] = (Math.random() - 0.5) * BOX * 2;
      a[o + 2] = (Math.random() - 0.5) * BOX * 2;
    }
    if (isRain) {
      a[o + 3] = a[o] + 0.05;
      a[o + 4] = a[o + 1] - 0.9;
      a[o + 5] = a[o + 2];
    }
  }
  pos.needsUpdate = true;
  obj.position.set(cam.x, Math.max(0, cam.y - 20), cam.z);
}
