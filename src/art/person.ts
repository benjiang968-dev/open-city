// Low-poly person built from boxes: torso+head in one mesh, plus pivoting legs and arms for a walk cycle.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import { makePersonMaterial } from '../systems/render/vehicleMaterials';

export interface PersonRig {
  root: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
}

const matCache = makePersonMaterial(); // cloth with a soft sheen (render/vehicleMaterials.ts)

export function makePerson(shirt: THREE.Color, pants: THREE.Color, skin: THREE.Color, hair: THREE.Color, scale = 1): PersonRig {
  const root = new THREE.Group();
  const body = new GeoBuilder();
  body.box(-0.24, 0.85, -0.14, 0.24, 1.45, 0.14, shirt); // torso
  body.box(-0.13, 1.45, -0.12, 0.13, 1.72, 0.13, skin); // head
  body.box(-0.14, 1.68, -0.14, 0.14, 1.78, 0.14, hair); // hair
  body.box(-0.09, 1.55, 0.13, 0.09, 1.6, 0.135, new THREE.Color('#222')); // eyes band (faces +Z)
  const torso = new THREE.Mesh(body.build(), matCache);
  torso.castShadow = true;
  root.add(torso);
  const limb = (x0: number, x1: number, h: number, col: THREE.Color) => {
    const b = new GeoBuilder();
    b.box(x0, -h, -0.09, x1, 0, 0.09, col);
    const m = new THREE.Mesh(b.build(), matCache);
    m.castShadow = true;
    return m;
  };
  const legL = new THREE.Group(), legR = new THREE.Group(), armL = new THREE.Group(), armR = new THREE.Group();
  legL.position.set(-0.12, 0.86, 0);
  legR.position.set(0.12, 0.86, 0);
  armL.position.set(-0.31, 1.42, 0);
  armR.position.set(0.31, 1.42, 0);
  legL.add(limb(-0.09, 0.09, 0.86, pants));
  legR.add(limb(-0.09, 0.09, 0.86, pants));
  armL.add(limb(-0.07, 0.07, 0.6, shirt));
  armR.add(limb(-0.07, 0.07, 0.6, shirt));
  root.add(legL, legR, armL, armR);
  root.scale.setScalar(scale);
  return { root, legL, legR, armL, armR };
}

/** Swing limbs. phase advances with distance walked; amount 0..1. */
export function animatePerson(r: PersonRig, phase: number, amount: number): void {
  const s = Math.sin(phase) * 0.7 * amount;
  r.legL.rotation.x = s;
  r.legR.rotation.x = -s;
  r.armL.rotation.x = -s * 0.8;
  r.armR.rotation.x = s * 0.8;
}
