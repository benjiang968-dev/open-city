// Draws every pedestrian with a handful of InstancedMeshes (torso, head, hair, legs, arms and props),
// so 60 people cost about a dozen draw calls instead of five each. Limbs swing per instance.
import * as THREE from 'three';
import type { World } from '../world';
import { GeoBuilder } from '../art/geo';
import type { Ped } from './pedestrians';

const WHITE = new THREE.Color(1, 1, 1);

interface Part {
  mesh: THREE.InstancedMesh;
  n: number;
}
export interface CrowdRender {
  torso: Part; head: Part; hair: Part; legL: Part; legR: Part; armL: Part; armR: Part;
  phone: Part; camera: Part; parcel: Part; cane: Part; dog: Part; dogTail: Part;
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col = WHITE) {
  const b = new GeoBuilder();
  b.box(x0, y0, z0, x1, y1, z1, col);
  return b;
}

export function createCrowd(w: World, capacity: number): CrowdRender {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });
  const make = (g: THREE.BufferGeometry, cap: number, colored: boolean, shadow: boolean): Part => {
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    if (colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    w.scene.add(mesh);
    return { mesh, n: 0 };
  };
  // head: skin colour comes from the instance colour; the eye band stays dark
  const head = box(-0.13, 1.45, -0.12, 0.13, 1.72, 0.13);
  head.box(-0.09, 1.55, 0.13, 0.09, 1.6, 0.135, new THREE.Color(0.12, 0.12, 0.12));
  const camera = box(-0.07, -0.05, -0.04, 0.07, 0.05, 0.04, new THREE.Color('#2b2d31'));
  camera.box(-0.03, -0.03, 0.04, 0.03, 0.03, 0.08, new THREE.Color('#111'));
  const dog = new GeoBuilder();
  dog.box(-0.13, 0.25, -0.32, 0.13, 0.48, 0.28, WHITE); // body
  dog.box(-0.11, 0.42, 0.26, 0.11, 0.62, 0.48, WHITE); // head
  dog.box(-0.05, 0.45, 0.48, 0.05, 0.53, 0.56, new THREE.Color(0.15, 0.12, 0.1)); // nose
  dog.box(-0.12, 0.6, 0.28, -0.06, 0.68, 0.34, WHITE); // ears
  dog.box(0.06, 0.6, 0.28, 0.12, 0.68, 0.34, WHITE);
  for (const [x, z] of [[-0.09, 0.2], [0.09, 0.2], [-0.09, -0.24], [0.09, -0.24]]) dog.box(x - 0.04, 0, z - 0.04, x + 0.04, 0.27, z + 0.04, WHITE);
  return {
    torso: make(box(-0.24, 0.85, -0.14, 0.24, 1.45, 0.14).build(), capacity, true, true),
    head: make(head.build(), capacity, true, true),
    hair: make(box(-0.14, 1.68, -0.14, 0.14, 1.78, 0.14).build(), capacity, true, false),
    legL: make(box(-0.09, -0.86, -0.09, 0.09, 0, 0.09).build(), capacity, true, true),
    legR: make(box(-0.09, -0.86, -0.09, 0.09, 0, 0.09).build(), capacity, true, true),
    armL: make(box(-0.07, -0.6, -0.09, 0.07, 0, 0.09).build(), capacity, true, false),
    armR: make(box(-0.07, -0.6, -0.09, 0.07, 0, 0.09).build(), capacity, true, false),
    phone: make(box(-0.035, -0.065, -0.008, 0.035, 0.065, 0.008, new THREE.Color('#15171c')).build(), capacity, false, false),
    camera: make(camera.build(), capacity, false, false),
    parcel: make(box(-0.18, -0.13, -0.15, 0.18, 0.13, 0.15, new THREE.Color('#c69c6d')).build(), capacity, false, true),
    cane: make(box(-0.015, -0.9, -0.015, 0.015, 0, 0.015, new THREE.Color('#5a3d26')).build(), capacity, false, false),
    dog: make(dog.build(), capacity, true, true),
    dogTail: make(box(-0.025, 0, -0.025, 0.025, 0.2, 0.025).build(), capacity, true, false),
  };
}

const base = new THREE.Matrix4();
const local = new THREE.Matrix4();
const out = new THREE.Matrix4();
const arm = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s = new THREE.Vector3();
const frustum = new THREE.Frustum();
const pv = new THREE.Matrix4();
const sphere = new THREE.Sphere();

function put(p: Part, m: THREE.Matrix4, color?: THREE.Color) {
  p.mesh.setMatrixAt(p.n, m);
  if (color && p.mesh.instanceColor) p.mesh.setColorAt(p.n, color);
  p.n++;
}

/** Limb matrix: pivot at (px,py,pz) in the person's space, swung about X by `rx` (and Z by `rz`). */
function limb(px: number, py: number, pz: number, rx: number, rz = 0) {
  e.set(rx, 0, rz);
  q.setFromEuler(e);
  v.set(px, py, pz);
  s.set(1, 1, 1);
  local.compose(v, q, s);
  return out.multiplyMatrices(base, local);
}

export function renderCrowd(w: World): void {
  const C = w.crowd;
  for (const k of Object.keys(C) as (keyof CrowdRender)[]) C[k].n = 0;
  const cam = w.camera;
  pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pv);
  const camPos = cam.position;
  for (const ped of w.peds) {
    if (!ped.active || ped.hidden) continue;
    const dx = ped.pos.x - camPos.x, dz = ped.pos.z - camPos.z;
    if (dx * dx + dz * dz > 170 * 170) continue;
    sphere.center.set(ped.pos.x, ped.pos.y + 0.9, ped.pos.z);
    sphere.radius = 1.2;
    if (!frustum.intersectsSphere(sphere)) continue;
    drawPed(C, ped);
    if (ped.dog) drawDog(C, ped);
  }
  for (const k of Object.keys(C) as (keyof CrowdRender)[]) {
    const p = C[k];
    p.mesh.count = p.n;
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }
}

function drawPed(C: CrowdRender, ped: Ped) {
  e.set(ped.tilt, ped.heading, 0, 'YXZ');
  q.setFromEuler(e);
  e.order = 'XYZ';
  s.setScalar(ped.scale);
  base.compose(ped.pos, q, s);
  put(C.torso, base, ped.shirt);
  put(C.head, base, ped.skin);
  put(C.hair, base, ped.hair);
  const swing = Math.sin(ped.walkPhase) * 0.7 * Math.min(1.4, ped.moveAmount);
  put(C.legL, limb(-0.12, 0.86, 0, swing), ped.pants);
  put(C.legR, limb(0.12, 0.86, 0, -swing), ped.pants);
  put(C.armL, limb(-0.31, 1.42, 0, ped.armPose === 'carry' ? -1.2 : -swing * 0.8), ped.shirt);
  // right arm pose: phone at the ear, camera held up, waving, carrying, cane, or swinging
  let rx = swing * 0.8, rz = 0;
  switch (ped.armPose) {
    case 'phone': rx = -2.0; rz = -0.45; break; // phone held up in front of the face
    case 'film': rx = -1.45; break;
    case 'wave': rx = 0; rz = 2.6 + Math.sin(ped.walkPhase * 3 + ped.id) * 0.3; break;
    case 'carry': rx = -1.2; break;
    case 'cane': rx = -0.35 + swing * 0.2; break;
  }
  arm.copy(limb(0.31, 1.42, 0, rx, rz));
  put(C.armR, arm, ped.shirt);
  if (ped.armPose === 'carry') put(C.parcel, limb(0, 1.12, 0.33, 0));
  // hand-held props at the end of the right arm
  if (ped.armPose === 'phone' || ped.armPose === 'film' || ped.prop === 'camera' || ped.armPose === 'cane') {
    local.makeTranslation(0, -0.62, 0.06);
    out.multiplyMatrices(arm, local);
    if (ped.armPose === 'phone' || (ped.armPose === 'film' && ped.prop !== 'camera')) put(C.phone, out);
    else if (ped.prop === 'camera') put(C.camera, out);
    else if (ped.armPose === 'cane') put(C.cane, out);
  }
}

function drawDog(C: CrowdRender, ped: Ped) {
  const d = ped.dog!;
  e.set(0, d.heading, 0, 'YXZ');
  q.setFromEuler(e);
  e.order = 'XYZ';
  v.set(d.pos.x, 0.02 + Math.abs(Math.sin(d.phase)) * 0.04, d.pos.z);
  s.setScalar(d.scale);
  base.compose(v, q, s);
  put(C.dog, base, d.color);
  put(C.dogTail, limb(0, 0.42, -0.32, -0.6 + Math.sin(d.phase * 2.5) * 0.5, 0), d.color);
}
