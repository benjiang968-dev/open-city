// A shared metre-scale person, matching the crowd's instanced parts. Limbs pivot through the existing walk cycle.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makePersonMaterial } from '../systems/render/vehicleMaterials';
import { buildHumanGeometry } from './humanGeometry';

export interface PersonRig {
  root: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
}
const matCache = makePersonMaterial();

export function makePerson(shirt: THREE.Color, pants: THREE.Color, skin: THREE.Color, hair: THREE.Color, scale = 1): PersonRig {
  const root = new THREE.Group();
  const parts = buildHumanGeometry(shirt, pants, skin, hair);
  const mesh = (g: THREE.BufferGeometry) => { const m = new THREE.Mesh(g, matCache); m.castShadow = true; return m; };
  const body = mergeGeometries([parts.torso, parts.head, parts.hair], false);
  const arm = mergeGeometries([parts.arm, parts.hand], false);
  for (const g of [parts.torso, parts.head, parts.hair, parts.arm, parts.hand]) g.dispose();
  root.add(mesh(body));
  const legL = new THREE.Group(), legR = new THREE.Group(), armL = new THREE.Group(), armR = new THREE.Group();
  legL.position.set(-0.105, 0.86, 0); legR.position.set(0.105, 0.86, 0);
  armL.position.set(-0.245, 1.36, 0); armR.position.set(0.245, 1.36, 0);
  legL.add(mesh(parts.leg)); legR.add(mesh(parts.leg));
  armL.add(mesh(arm)); armR.add(mesh(arm));
  root.add(legL, legR, armL, armR); root.scale.setScalar(scale);
  return { root, legL, legR, armL, armR };
}

/** Swing limbs. Phase advances with distance, not display frames. */
export function animatePerson(r: PersonRig, phase: number, amount: number): void {
  const s = Math.sin(phase) * 0.7 * amount;
  r.legL.rotation.x = s; r.legR.rotation.x = -s;
  r.armL.rotation.x = -s * 0.8; r.armR.rotation.x = s * 0.8;
}
