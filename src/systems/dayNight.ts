// Day/night cycle: sun position, the physically based sky and the sky light it gives (render/sky.ts), the sun with two
// shadow cascades (near and far, three's SunLight), fog colour, street lights, lit windows and the player's headlights.
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { workingHeadlights } from './carDamage';
import { createSkyEnv, updateSkyEnv, type SkyEnv } from './render/sky';

const LT = TUNING.look;

export interface DayNightState {
  hour: number; // 0..24 game time
  day: number; // days elapsed
  night: number; // 0 = full day, 1 = full night
  /** 0..1 how much daylight there is (drives interiors, ground bounce) */
  daylight: number;
  sun: SunLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  env: SkyEnv;
  /** unit vector towards the sun (below the horizon at night) */
  sunDir: THREE.Vector3;
  /** fog / horizon colours (weather greys them) */
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  headlight: THREE.SpotLight;
}

/** Fog and horizon colours and light levels through the day (sun/hemi are multipliers of the TUNING.look levels). */
const KEYS: { h: number; top: string; hor: string; sun: number; hemi: number }[] = [
  { h: 0, top: '#0b1026', hor: '#151b2c', sun: 0.0, hemi: 0.3 },
  { h: 5, top: '#141b3a', hor: '#2a2d44', sun: 0.0, hemi: 0.32 },
  { h: 6.5, top: '#5b7db1', hor: '#d9a585', sun: 0.35, hemi: 0.6 },
  { h: 9, top: '#4a90d9', hor: '#b9cddd', sun: 1.0, hemi: 1.25 },
  { h: 16, top: '#3f86d4', hor: '#bccfdd', sun: 1.0, hemi: 1.25 },
  { h: 18.3, top: '#5a7bc0', hor: '#d6b393', sun: 0.65, hemi: 0.9 },
  { h: 19.5, top: '#2a2f5e', hor: '#a0705e', sun: 0.12, hemi: 0.35 },
  { h: 21, top: '#0f1530', hor: '#1c2236', sun: 0.0, hemi: 0.3 },
  { h: 24, top: '#0b1026', hor: '#151b2c', sun: 0.0, hemi: 0.3 },
];

export function createDayNight(scene: THREE.Scene): DayNightState {
  const sun = new SunLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.far = 320; // the cascades' reach (settings.applyQuality sets it per preset)
  sun.shadow.bias = LT.shadowBias;
  sun.shadow.normalBias = LT.shadowNormalBias;
  sun.shadow.radius = LT.shadowRadius;
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x8a7d6a, 0.8);
  scene.add(hemi);
  const env = createSkyEnv(scene);
  scene.fog = new THREE.Fog(0xbfe0f5, 180, 750);
  // one headlight for the player's car (cheap: a single spot light that follows whichever car you drive)
  const headlight = new THREE.SpotLight(0xfff2d0, 0, 60, 0.55, 0.5, 1.2);
  headlight.position.set(0, 0.4, 2);
  headlight.target.position.set(0, -1.5, 18);
  headlight.add(headlight.target);
  scene.add(headlight); // always in the scene so the light count never changes (no shader recompiles)
  return {
    headlight, hour: TUNING.time.startHour, day: 1, night: 0, daylight: 1, sun, hemi, sky: env.sky, env, sunDir: new THREE.Vector3(0, 1, 0),
    skyTop: new THREE.Color(), skyHorizon: new THREE.Color(),
  };
}

const ca = new THREE.Color();
const cb = new THREE.Color();
const moonDir = new THREE.Vector3(0.35, 0.85, -0.4).normalize();

/** Sun direction for a game hour: rises in the east (+x), noon in the south (+z), sets in the west. */
export function sunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  const ang = ((hour - 6) / 12) * Math.PI;
  return out.set(-Math.cos(ang), Math.sin(ang) * 1.25, 0.42).normalize();
}

export function updateDayNight(w: World, dt: number): void {
  const s = w.dayNight;
  s.hour += (dt * 24) / TUNING.time.realSecondsPerGameDay;
  if (s.hour >= 24) { s.hour -= 24; s.day++; }
  let k = 0;
  while (k < KEYS.length - 2 && KEYS[k + 1].h <= s.hour) k++;
  const A = KEYS[k], B = KEYS[k + 1];
  const t = (s.hour - A.h) / (B.h - A.h);
  s.skyTop.copy(ca.set(A.top)).lerp(cb.set(B.top), t);
  s.skyHorizon.copy(ca.set(A.hor)).lerp(cb.set(B.hor), t);
  const sunK = THREE.MathUtils.lerp(A.sun, B.sun, t);
  const hemiI = THREE.MathUtils.lerp(A.hemi, B.hemi, t);
  s.night = THREE.MathUtils.clamp((0.75 - hemiI) / 0.45, 0, 1);
  s.daylight = THREE.MathUtils.clamp(sunK * 1.1, 0, 1) * (1 - s.night * 0.9);

  sunDirection(s.hour, s.sunDir);
  const up = s.sunDir.y;
  if (up > 0.02) {
    // warm and dimmer near the horizon (more air to pass through)
    s.sun.color.set(0xfff4e6).lerp(ca.set(0xff9a55), 1 - THREE.MathUtils.smoothstep(up, 0.02, 0.45));
    s.sun.intensity = LT.sunIntensity * sunK;
    s.sun.position.copy(s.sunDir);
  } else {
    s.sun.color.set(0x8fa8ff);
    s.sun.intensity = LT.moonIntensity * s.night;
    s.sun.position.copy(moonDir);
  }
  s.hemi.intensity = THREE.MathUtils.lerp(LT.hemiDay, LT.hemiNight, s.night) * Math.min(1, hemiI * 1.2);
  s.hemi.color.copy(s.skyTop).lerp(ca.set(0xffffff), 0.5);
  s.sky.position.copy(w.camera.position);
  (w.scene.fog as THREE.Fog).color.copy(s.skyHorizon);
  w.renderer.toneMappingExposure = THREE.MathUtils.lerp(LT.exposureDay, LT.exposureNight, s.night);
  w.scene.environmentIntensity = THREE.MathUtils.lerp(LT.envIntensityDay, LT.envIntensityNight, s.night);

  // the player's headlights
  const v = w.player.vehicle;
  if (v && s.headlight.parent !== v.mesh) v.mesh.add(s.headlight);
  if (!v && s.headlight.parent !== w.scene) w.scene.add(s.headlight);
  s.headlight.intensity = v && !v.wrecked ? THREE.MathUtils.clamp((s.night - 0.2) * 2, 0, 1) * 30 * workingHeadlights(v) : 0;

  // street lights and windows glow at night
  const lampOn = THREE.MathUtils.clamp((s.night - 0.3) * 3, 0, 1);
  w.city.lampMat.color.setRGB(0.55 + 0.45 * lampOn, 0.55 + 0.4 * lampOn, 0.5 + 0.25 * lampOn);
  w.city.lampPoolMat.opacity = lampOn * 0.55;
  w.city.lampPoolMat.visible = lampOn > 0.01;
  const win = THREE.MathUtils.clamp((s.night - 0.15) * 2, 0, 1);
  w.city.litWindowMat.color.setRGB(0.22 + 0.78 * win, 0.28 + 0.62 * win, 0.36 + 0.24 * win);
  if (w.look) {
    w.look.uniforms.uNight.value = s.night;
    w.look.uniforms.uDaylight.value = s.daylight * LT.interiorDay;
  }
}

/** After the weather has adjusted the light: point the sky and refresh the sky light if needed. */
export function updateSky(w: World, force = false): void {
  const s = w.dayNight;
  updateSkyEnv(s.env, w.renderer, w.scene, s.sunDir, w.weather ? w.weather.look.cloud : 0, s.night, s.daylight, w.time, force);
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
