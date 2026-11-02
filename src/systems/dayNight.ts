// Day/night cycle: sun position, sky colours, fog, ambient light, street lights and lit windows.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';

export interface DayNightState {
  hour: number; // 0..24 game time
  day: number; // days elapsed
  night: number; // 0 = full day, 1 = full night
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  headlight: THREE.SpotLight;
}

const KEYS: { h: number; top: string; hor: string; sun: number; hemi: number }[] = [
  { h: 0, top: '#0b1026', hor: '#1c2541', sun: 0.0, hemi: 0.3 },
  { h: 5, top: '#141b3a', hor: '#3a3a5e', sun: 0.0, hemi: 0.32 },
  { h: 6.5, top: '#5b7db1', hor: '#f6a96b', sun: 1.0, hemi: 0.6 },
  { h: 9, top: '#4a90d9', hor: '#bfe0f5', sun: 3.0, hemi: 1.25 },
  { h: 16, top: '#3f86d4', hor: '#c6e4f5', sun: 3.0, hemi: 1.25 },
  { h: 18.3, top: '#5a7bc0', hor: '#f4b27a', sun: 2.0, hemi: 0.9 },
  { h: 19.5, top: '#2a2f5e', hor: '#e07a5f', sun: 0.3, hemi: 0.35 },
  { h: 21, top: '#0f1530', hor: '#253055', sun: 0.0, hemi: 0.3 },
  { h: 24, top: '#0b1026', hor: '#1c2541', sun: 0.0, hemi: 0.3 },
];

export function createDayNight(scene: THREE.Scene): DayNightState {
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -70;
  sc.right = sc.top = 70;
  sc.near = 1;
  sc.far = 400;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x8a7d6a, 0.8);
  scene.add(hemi);

  const skyTop = new THREE.Color();
  const skyHorizon = new THREE.Color();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: skyTop }, horizon: { value: skyHorizon } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vP;
      void main(){ float t = clamp(vP.y*1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(t,0.7)), 1.0);} `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12), skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);
  scene.fog = new THREE.Fog(0xbfe0f5, 180, 750);
  // one headlight for the player's car (cheap: a single spot light that follows whichever car you drive)
  const headlight = new THREE.SpotLight(0xfff2d0, 0, 60, 0.55, 0.5, 1.2);
  headlight.position.set(0, 0.4, 2);
  headlight.target.position.set(0, -1.5, 18);
  headlight.add(headlight.target);
  scene.add(headlight); // always in the scene so the light count never changes (no shader recompiles)
  return {
    headlight, hour: TUNING.time.startHour, day: 1, night: 0, sun, hemi, sky, skyTop, skyHorizon };
}

const ca = new THREE.Color();
const cb = new THREE.Color();

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
  const sunI = THREE.MathUtils.lerp(A.sun, B.sun, t);
  const hemiI = THREE.MathUtils.lerp(A.hemi, B.hemi, t);
  s.night = THREE.MathUtils.clamp((0.75 - hemiI) / 0.45, 0, 1);

  // sun arcs east -> south -> west; at night a dim moonlight from above keeps things readable
  const ang = ((s.hour - 6) / 12) * Math.PI;
  const up = Math.sin(ang);
  const p = w.player.mesh.position;
  if (up > 0) {
    s.sun.color.set(0xfff2dd).lerp(ca.set(0xffa060), 1 - Math.min(1, up * 2.5));
    s.sun.intensity = sunI;
    s.sun.position.set(p.x - Math.cos(ang) * 150, Math.max(20, up * 200), p.z + 60);
  } else {
    s.sun.color.set(0x8fa8ff);
    s.sun.intensity = 0.35;
    s.sun.position.set(p.x + 60, 160, p.z - 40);
  }
  s.sun.target.position.set(p.x, 0, p.z);
  s.hemi.intensity = hemiI;
  s.hemi.color.copy(s.skyTop).lerp(ca.set(0xffffff), 0.5);
  s.sky.position.copy(w.camera.position);
  (w.scene.fog as THREE.Fog).color.copy(s.skyHorizon);
  w.renderer.toneMappingExposure = 1.0 + s.night * 0.25;

  // the player's headlights
  const v = w.player.vehicle;
  if (v && s.headlight.parent !== v.mesh) v.mesh.add(s.headlight);
  if (!v && s.headlight.parent !== w.scene) w.scene.add(s.headlight);
  s.headlight.intensity = v && !v.wrecked ? THREE.MathUtils.clamp((s.night - 0.2) * 2, 0, 1) * 60 : 0;

  // street lights and windows glow at night
  const lampOn = THREE.MathUtils.clamp((s.night - 0.3) * 3, 0, 1);
  w.city.lampMat.color.setRGB(0.55 + 0.45 * lampOn, 0.55 + 0.4 * lampOn, 0.5 + 0.25 * lampOn);
  w.city.lampPoolMat.opacity = lampOn * 0.55;
  w.city.lampPoolMat.visible = lampOn > 0.01;
  const win = THREE.MathUtils.clamp((s.night - 0.15) * 2, 0, 1);
  w.city.litWindowMat.color.setRGB(0.22 + 0.78 * win, 0.28 + 0.62 * win, 0.36 + 0.24 * win);
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
