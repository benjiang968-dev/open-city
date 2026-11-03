// Visible crash damage for drivable cars: vertex dents at the impact point, bumpers that hang then fall off,
// headlights that break, and a cracked windscreen. Everything is created when the car spawns; a crash only
// moves existing vertices and toggles existing meshes (no allocations at impact time).
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import type { Vehicle } from './vehicles';
import { carMaterial, crackMaterial, headlightMaterial, subdivide, type CarParts } from '../art/car';

const D = TUNING.damage;

interface Bumper {
  mesh: THREE.Mesh;
  front: boolean;
  state: 0 | 1 | 2; // intact, hanging, gone
}
export interface CarDamage {
  base: Float32Array; // undamaged vertex positions of the body
  pos: Float32Array; // live positions (the geometry's own array)
  attr: THREE.BufferAttribute;
  bumpers: Bumper[];
  lights: THREE.Mesh[]; // [left, right]
  crack: THREE.Mesh;
  dentTotal: number; // sum of dent depth applied (for tests / debug)
}

/** Builds damageable parts for a drivable car and returns the body mesh. Called once at spawn. */
export function buildDamageableCar(v: Pick<Vehicle, 'mesh'>, parts: CarParts): { bodyMesh: THREE.Mesh; dmg: CarDamage } {
  const geo = subdivide(parts.body.build(), D.subdivisions);
  const bodyMesh = new THREE.Mesh(geo, carMaterial);
  bodyMesh.castShadow = true;
  v.mesh.add(bodyMesh);
  const attr = geo.getAttribute('position') as THREE.BufferAttribute;
  const mk = (b: CarParts['bumperF'], mat: THREE.Material) => {
    const m = new THREE.Mesh(b.build(), mat);
    v.mesh.add(m);
    return m;
  };
  const bumpers: Bumper[] = [
    { mesh: mk(parts.bumperF, carMaterial), front: true, state: 0 },
    { mesh: mk(parts.bumperR, carMaterial), front: false, state: 0 },
  ];
  const lights = [mk(parts.lightL, headlightMaterial), mk(parts.lightR, headlightMaterial)];
  const ws = parts.windscreen;
  const crack = new THREE.Mesh(new THREE.PlaneGeometry(ws.w * 0.95, ws.h * 0.95), crackMaterial());
  crack.position.set(ws.x, ws.y, ws.z + 0.012);
  crack.visible = false;
  v.mesh.add(crack);
  return {
    bodyMesh,
    dmg: { base: Float32Array.from(attr.array as Float32Array), pos: attr.array as Float32Array, attr, bumpers, lights, crack, dentTotal: 0 },
  };
}

// ---------- debris pool (bumpers that fell off) ----------
interface Debris {
  obj: THREE.Object3D | null;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  landed: boolean;
}
const pool: Debris[] = Array.from({ length: D.debrisPool }, () => ({ obj: null, vel: new THREE.Vector3(), spin: new THREE.Vector3(), age: 0, landed: false }));

function spawnDebris(w: World, obj: THREE.Object3D, carVel: { x: number; y: number; z: number }) {
  // reuse the oldest slot if all are busy
  let slot = pool[0];
  for (const d of pool) {
    if (!d.obj) { slot = d; break; }
    if (d.age > slot.age) slot = d;
  }
  if (slot.obj) slot.obj.visible = false;
  w.scene.attach(obj);
  slot.obj = obj;
  slot.age = 0;
  slot.landed = false;
  slot.vel.set(carVel.x * 0.55 + (Math.random() - 0.5) * 2, 2 + Math.random() * 2, carVel.z * 0.55 + (Math.random() - 0.5) * 2);
  slot.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
}

export function updateCarDamage(w: World, dt: number): void {
  for (const d of pool) {
    if (!d.obj) continue;
    d.age += dt;
    if (!d.landed) {
      d.vel.y -= 18 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.y += d.spin.y * dt;
      d.obj.rotation.z += d.spin.z * dt;
      if (d.obj.position.y < 0.12) {
        d.obj.position.y = 0.12;
        d.landed = true;
        d.obj.rotation.x = 0;
        d.obj.rotation.z = Math.PI; // lies flat-ish, upside down
      }
    }
    if (d.age > D.debrisLifetime) {
      d.obj.visible = false;
      d.obj = null;
    }
  }
}

// ---------- impacts ----------
const qInv = new THREE.Quaternion();
const dir = new THREE.Vector3();
const hit = new THREE.Vector3();

/** Apply a crash to a car. `dv` is the world-space change of velocity this step (points away from what we hit). */
export function applyImpact(w: World, v: Vehicle, dvx: number, dvy: number, dvz: number, dvMag: number): void {
  if (dvMag < D.dentThreshold) return;
  const r = v.body.rotation();
  qInv.set(r.x, r.y, r.z, r.w).invert();
  dir.set(dvx, 0, dvz).applyQuaternion(qInv); // horizontal only: landings and bumps never dent the roof
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();
  // impact point: where the opposite of the dent direction leaves the chassis box
  const [hx, hy, hz] = v.spec.halfExtents;
  const s = Math.min(hx / Math.max(1e-3, Math.abs(dir.x)), (hy + 0.3) / Math.max(1e-3, Math.abs(dir.y)), hz / Math.max(1e-3, Math.abs(dir.z)));
  hit.copy(dir).multiplyScalar(-s);
  hit.y = Math.min(hit.y, 0.2); // most crashes hit at bumper / door height
  dentAt(v, hit.x, hit.y, hit.z, dir.x, dir.y, dir.z, Math.min(D.maxDentPerHit, (dvMag - D.dentThreshold) * D.dentPerMs), D.dentRadius + dvMag * D.dentRadiusPerMs);

  const dm = v.dmg;
  const frontHit = hit.z > hz * 0.55, rearHit = hit.z < -hz * 0.55;
  // bumpers: hang first, fall off on a second hard hit (or one very hard hit)
  for (const b of dm.bumpers) {
    if ((b.front && !frontHit) || (!b.front && !rearHit) || b.state === 2) continue;
    if (dvMag > D.bumperFallSpeed || (b.state === 1 && dvMag > D.bumperHangSpeed)) {
      b.state = 2;
      spawnDebris(w, b.mesh, v.body.linvel());
    } else if (dvMag > D.bumperHangSpeed && b.state === 0) {
      b.state = 1;
      // drop one end: rotate about the car's side-to-side axis and sag
      b.mesh.rotation.z = (hit.x >= 0 ? -1 : 1) * 0.28;
      b.mesh.position.y = -0.12;
    }
  }
  // headlights break on front impacts on their side
  if (frontHit && dvMag > D.headlightBreakSpeed) {
    if (hit.x > -0.3) dm.lights[0].visible = false;
    if (hit.x < 0.3) dm.lights[1].visible = false;
  }
  if ((frontHit && dvMag > D.crackSpeed) || dvMag > D.crackSpeed * 1.4) dm.crack.visible = true;
}

/** Push body vertices near a local point along a local direction (also used by melee hits later). */
export function dentAt(v: Vehicle, px: number, py: number, pz: number, dx: number, dy: number, dz: number, depth: number, radius: number): void {
  const dm = v.dmg;
  const P = dm.pos, B = dm.base;
  const r2 = radius * radius, maxD2 = D.maxDent * D.maxDent;
  for (let i = 0; i < P.length; i += 3) {
    const ox = P[i] - px, oy = P[i + 1] - py, oz = P[i + 2] - pz;
    const d2 = ox * ox + oy * oy + oz * oz;
    if (d2 > r2) continue;
    const f = 1 - Math.sqrt(d2) / radius;
    const k = depth * f * f;
    let nx = P[i] + dx * k, ny = P[i + 1] + dy * k, nz = P[i + 2] + dz * k;
    // never push a vertex further than maxDent from where it started
    const ex = nx - B[i], ey = ny - B[i + 1], ez = nz - B[i + 2];
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > maxD2) {
      const sc = D.maxDent / Math.sqrt(e2);
      nx = B[i] + ex * sc; ny = B[i + 1] + ey * sc; nz = B[i + 2] + ez * sc;
    }
    P[i] = nx; P[i + 1] = ny; P[i + 2] = nz;
  }
  dm.dentTotal += depth;
  dm.attr.needsUpdate = true;
}

/** Number of working headlights (0..2), drives the player's headlight beam. */
export function workingHeadlights(v: Vehicle): number {
  return (v.dmg.lights[0].visible ? 1 : 0) + (v.dmg.lights[1].visible ? 1 : 0);
}
