// Hurt feedback: a short burst of small red dots whenever a person, a dog or the player is injured, and a few
// small flat red stains on the ground that fade over a minute. Stylised, not gore: round dots and round spots.
// Everything is allocated once at load: one InstancedMesh of dots and one of stains, with their state in
// fixed-size typed arrays (live entries packed at the front). A hit only writes into those arrays. With
// nothing alive the update returns at once and both meshes are hidden, so an idle frame costs nothing.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';

const F = TUNING.hurtFx;

export interface HurtFxState {
  dots: THREE.InstancedMesh;
  stains: THREE.InstancedMesh;
  /** Dots alive (packed at indices 0..live-1). */
  live: number;
  pos: Float32Array; // x, y, z per dot
  vel: Float32Array; // vx, vy, vz per dot
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  ground: Float32Array; // height of the surface under the dot
  /** > 0: this dot is a drop that leaves a stain of this radius where it lands. */
  dropR: Float32Array;
  cursor: number; // slot reused next when the pool is full
  /** Stains alive (packed at indices 0..stainLive-1). */
  stainLive: number;
  stainAge: Float32Array;
  stainAlpha: Float32Array; // the stains' per-instance opacity attribute
  fadeAcc: number; // seconds since stain opacity was last updated
  // counters for tests and the debug overlay
  bursts: number;
  stainsMade: number;
}

/** Lambert material whose opacity is multiplied per instance by an `instanceAlpha` attribute. */
function fadingMaterial(params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstanceAlpha;');
  };
  m.customProgramCacheKey = () => 'hurtfx-instance-alpha';
  return m;
}

export function createHurtFx(w: World): HurtFxState {
  const N = F.particlePool, M = F.stainPool;
  // dots: small round balls, colour per instance (a few shades of red), lit so they darken at night
  const dotMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x2a0000 });
  const dots = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dotMat, N);
  dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
  dots.count = 0;
  dots.frustumCulled = false;
  dots.visible = false;
  // stains: flat discs facing up, faded per instance
  const discGeo = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
  const stainAlpha = new Float32Array(M);
  discGeo.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(stainAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const stainMat = fadingMaterial({
    color: 0x9e1018, emissive: 0x220000, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const stains = new THREE.InstancedMesh(discGeo, stainMat, M);
  stains.count = 0;
  stains.frustumCulled = false;
  stains.receiveShadow = true;
  stains.visible = false;
  w.scene.add(dots, stains);
  return {
    dots, stains, live: 0,
    pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), age: new Float32Array(N), life: new Float32Array(N),
    size: new Float32Array(N), ground: new Float32Array(N), dropR: new Float32Array(N), cursor: 0,
    stainLive: 0, stainAge: new Float32Array(M), stainAlpha, fadeAcc: 0, bursts: 0, stainsMade: 0,
  };
}

/** Shader warm-up at boot: show both meshes so renderer.compile() builds their programs, then hide them. */
export function showHurtFxForWarmup(s: HurtFxState, on: boolean): void {
  s.dots.visible = on || s.live > 0;
  s.stains.visible = on || s.stainLive > 0;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * A burst of red dots at (x, y, z). `strength` is the impact in m/s (car hits) or hp × strengthPerDamage;
 * (dirX, dirZ) is the direction of the blow (0, 0 if unknown); `groundY` the surface under the victim;
 * `stains` false where a stain would make no sense (inside a car); (velX, velZ) the victim's own velocity
 * if they are being flung (the dots keep part of it, so they travel with them).
 */
export function hurtBurst(w: World, x: number, y: number, z: number, strength: number, dirX = 0, dirZ = 0, groundY = 0, stains = true, velX = 0, velZ = 0): void {
  const S = w.hurtFx;
  if (strength < F.minStrength) return;
  const N = F.particlePool;
  const n = Math.min(F.maxParticlesPerHit, Math.round(F.particlesBase + F.particlesPerStrength * strength));
  let drops = stains ? Math.min(F.maxStainsPerHit, Math.floor(strength * F.stainsPerStrength)) : 0;
  const spread = Math.min(F.maxSpread, F.spreadBase + F.spreadPerStrength * strength);
  const dl = Math.hypot(dirX, dirZ);
  const carry = dl > 1e-4 ? (spread * F.impactCarry) / dl : 0;
  const ix = velX * F.inheritVelocity, iz = velZ * F.inheritVelocity;
  const colors = S.dots.instanceColor!.array as Float32Array;
  for (let k = 0; k < n; k++) {
    let i: number;
    if (S.live < N) i = S.live++;
    else { i = S.cursor; S.cursor = (S.cursor + 1) % N; }
    // random direction, mostly upward and outward
    const rx = Math.random() * 2 - 1, ry = rnd(0.25, 1.15), rz = Math.random() * 2 - 1;
    const sp = (spread * rnd(0.45, 1)) / (Math.hypot(rx, ry, rz) || 1);
    const i3 = i * 3;
    S.pos[i3] = x + rnd(-0.08, 0.08); S.pos[i3 + 1] = y + rnd(-0.1, 0.1); S.pos[i3 + 2] = z + rnd(-0.08, 0.08);
    S.vel[i3] = rx * sp + dirX * carry + ix; S.vel[i3 + 1] = ry * sp; S.vel[i3 + 2] = rz * sp + dirZ * carry + iz;
    S.age[i] = 0;
    S.life[i] = F.particleLife * rnd(0.75, 1.25);
    S.size[i] = rnd(F.particleSize[0], F.particleSize[1]);
    S.ground[i] = groundY;
    S.dropR[i] = drops-- > 0 ? rnd(F.stainSize[0], F.stainSize[1]) : 0;
    // a few shades of red
    const shade = rnd(0.55, 0.95);
    colors[i3] = shade; colors[i3 + 1] = shade * rnd(0.02, 0.09); colors[i3 + 2] = shade * rnd(0.03, 0.08);
  }
  S.dots.instanceColor!.needsUpdate = true;
  S.dots.visible = true;
  S.bursts++;
}

// scratch for placing stains (spawn time only)
const sm = new THREE.Matrix4();
const sp3 = new THREE.Vector3();
const sq = new THREE.Quaternion();
const ss = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function addStain(S: HurtFxState, x: number, groundY: number, z: number, r: number) {
  const M = F.stainPool;
  let i = S.stainLive;
  if (i < M) S.stainLive++;
  else {
    // full: reuse the oldest
    i = 0;
    for (let k = 1; k < M; k++) if (S.stainAge[k] > S.stainAge[i]) i = k;
  }
  S.stainAge[i] = 0;
  S.stainAlpha[i] = F.stainOpacity;
  // slightly oval, random orientation; a hair of height per slot so overlapping stains never fight
  const e = rnd(0, 0.3);
  sp3.set(x, groundY + F.stainLift + i * 0.0004, z);
  sq.setFromAxisAngle(UP, rnd(0, Math.PI));
  ss.set(r * (1 + e), 1, r * (1 - e));
  sm.compose(sp3, sq, ss);
  S.stains.setMatrixAt(i, sm);
  S.stains.instanceMatrix.needsUpdate = true;
  (S.stains.geometry.getAttribute('instanceAlpha') as THREE.BufferAttribute).needsUpdate = true;
  S.stains.count = S.stainLive;
  S.stains.visible = true;
  S.stainsMade++;
}

/** Remove dot i by moving the last live dot into its slot. */
function killDot(S: HurtFxState, i: number) {
  const last = --S.live;
  if (i === last) return;
  const i3 = i * 3, l3 = last * 3;
  S.pos[i3] = S.pos[l3]; S.pos[i3 + 1] = S.pos[l3 + 1]; S.pos[i3 + 2] = S.pos[l3 + 2];
  S.vel[i3] = S.vel[l3]; S.vel[i3 + 1] = S.vel[l3 + 1]; S.vel[i3 + 2] = S.vel[l3 + 2];
  S.age[i] = S.age[last]; S.life[i] = S.life[last]; S.size[i] = S.size[last]; S.ground[i] = S.ground[last]; S.dropR[i] = S.dropR[last];
  const c = S.dots.instanceColor!.array as Float32Array;
  c[i3] = c[l3]; c[i3 + 1] = c[l3 + 1]; c[i3 + 2] = c[l3 + 2];
  S.dots.instanceColor!.needsUpdate = true;
}

function updateDots(S: HurtFxState, dt: number) {
  const g = F.gravity;
  // backwards, so the dot swapped into a freed slot has already been simulated this frame
  for (let i = S.live - 1; i >= 0; i--) {
    const age = (S.age[i] += dt);
    const drop = S.dropR[i] > 0;
    if (drop ? age > F.dropMaxAge : age >= S.life[i]) { killDot(S, i); continue; }
    const i3 = i * 3;
    S.vel[i3 + 1] -= g * dt;
    S.pos[i3] += S.vel[i3] * dt;
    S.pos[i3 + 1] += S.vel[i3 + 1] * dt;
    S.pos[i3 + 2] += S.vel[i3 + 2] * dt;
    const floor = S.ground[i] + S.size[i];
    if (S.pos[i3 + 1] <= floor) {
      if (drop) { addStain(S, S.pos[i3], S.ground[i], S.pos[i3 + 2], S.dropR[i]); killDot(S, i); continue; }
      // landed: lie there while shrinking away
      S.pos[i3 + 1] = floor;
      S.vel[i3] = S.vel[i3 + 1] = S.vel[i3 + 2] = 0;
    }
  }
  // instance matrices: uniform scale + translation (the off-diagonal terms stay 0 from creation)
  const m = S.dots.instanceMatrix.array as Float32Array;
  for (let i = 0; i < S.live; i++) {
    const t = S.dropR[i] > 0 ? 0 : S.age[i] / S.life[i];
    const s = S.size[i] * (1 - t * t * t);
    const o = i * 16, i3 = i * 3;
    m[o] = s; m[o + 5] = s; m[o + 10] = s; m[o + 15] = 1;
    m[o + 12] = S.pos[i3]; m[o + 13] = S.pos[i3 + 1]; m[o + 14] = S.pos[i3 + 2];
  }
  S.dots.count = S.live;
  S.dots.instanceMatrix.needsUpdate = true; // whole pool (12 KB), only while dots are alive; no update ranges (they allocate)
  if (S.live === 0) S.dots.visible = false;
}

/** Age stains by `dt` and fade them; remove the ones that have faded out. */
function ageStains(S: HurtFxState, dt: number) {
  const life = F.stainLifetime;
  const mat = S.stains.instanceMatrix.array as Float32Array;
  for (let i = S.stainLive - 1; i >= 0; i--) {
    const age = (S.stainAge[i] += dt);
    if (age < life) { S.stainAlpha[i] = F.stainOpacity * (1 - age / life); continue; }
    const last = --S.stainLive;
    if (i !== last) {
      S.stainAge[i] = S.stainAge[last];
      S.stainAlpha[i] = S.stainAlpha[last];
      mat.copyWithin(i * 16, last * 16, last * 16 + 16);
      S.stains.instanceMatrix.needsUpdate = true;
    }
  }
  (S.stains.geometry.getAttribute('instanceAlpha') as THREE.BufferAttribute).needsUpdate = true;
  S.stains.count = S.stainLive;
  if (S.stainLive === 0) S.stains.visible = false;
}

export function updateHurtFx(w: World, dt: number): void {
  const S = w.hurtFx;
  if (S.live === 0 && S.stainLive === 0) return; // idle: nothing to do, nothing drawn
  if (S.live > 0) updateDots(S, dt);
  if (S.stainLive > 0) {
    S.fadeAcc += dt;
    if (S.fadeAcc >= 1 / F.stainFadeHz) {
      ageStains(S, S.fadeAcc);
      S.fadeAcc = 0;
    }
  } else S.fadeAcc = 0;
}
