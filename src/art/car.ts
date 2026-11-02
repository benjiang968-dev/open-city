// Low-poly car bodies for each type, built in code. Forward is +Z.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import type { CarTypeName } from '../tuning';

const C = (h: number | string) => new THREE.Color(h);
const GLASS = C('#26303c');
const TRIM = C('#2b2b2b');
const HEAD = C('#fff6d5');
const TAIL = C('#d62828');

export const carMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.45, metalness: 0.2 });
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1f, flatShading: true, roughness: 0.9 });
const hubMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, flatShading: true, roughness: 0.4 });

/** Builds the body (no wheels). Body origin = chassis collider centre. */
export function buildCarBody(type: CarTypeName, paint: THREE.Color, extras?: { taxiSign?: boolean; police?: boolean }): GeoBuilder {
  const b = new GeoBuilder();
  const dark = paint.clone().multiplyScalar(0.8);
  if (type === 'hatchback') {
    b.box(-0.85, -0.3, -1.85, 0.85, 0.25, 1.85, paint, dark);
    b.box(-0.78, 0.25, -1.55, 0.78, 0.85, 0.55, paint, dark);
    b.wall(0, 0.57, 0.56, 1.4, 0.5, 0, 1, GLASS); // windscreen
    b.wall(0, 0.57, -1.56, 1.4, 0.45, 0, -1, GLASS);
    b.wall(0.79, 0.57, -0.5, 1.8, 0.45, 1, 0, GLASS);
    b.wall(-0.79, 0.57, -0.5, 1.8, 0.45, -1, 0, GLASS);
  } else if (type === 'sedan') {
    b.box(-0.92, -0.32, -2.25, 0.92, 0.22, 2.25, paint, dark);
    b.box(-0.84, 0.22, -1.2, 0.84, 0.82, 0.85, paint, dark);
    b.wall(0, 0.53, 0.86, 1.5, 0.5, 0, 1, GLASS);
    b.wall(0, 0.53, -1.21, 1.5, 0.5, 0, -1, GLASS);
    b.wall(0.85, 0.53, -0.18, 1.8, 0.45, 1, 0, GLASS);
    b.wall(-0.85, 0.53, -0.18, 1.8, 0.45, -1, 0, GLASS);
  } else {
    b.box(-1.0, -0.38, -2.55, 1.0, 0.3, 2.55, paint, dark);
    b.box(-0.95, 0.3, -0.2, 0.95, 1.05, 1.3, paint, dark); // cab
    b.box(-1.0, 0.3, -2.55, -0.88, 0.75, -0.3, dark); // bed sides
    b.box(0.88, 0.3, -2.55, 1.0, 0.75, -0.3, dark);
    b.box(-1.0, 0.3, -2.55, 1.0, 0.75, -2.42, dark);
    b.wall(0, 0.7, 1.31, 1.6, 0.55, 0, 1, GLASS);
    b.wall(0.96, 0.7, 0.55, 1.2, 0.5, 1, 0, GLASS);
    b.wall(-0.96, 0.7, 0.55, 1.2, 0.5, -1, 0, GLASS);
  }
  const len = type === 'hatchback' ? 1.85 : type === 'sedan' ? 2.25 : 2.55;
  const w = type === 'pickup' ? 1.0 : type === 'sedan' ? 0.92 : 0.85;
  b.wall(w - 0.3, 0.02, len + 0.01, 0.35, 0.16, 0, 1, HEAD);
  b.wall(-w + 0.3, 0.02, len + 0.01, 0.35, 0.16, 0, 1, HEAD);
  b.wall(w - 0.3, 0.05, -len - 0.01, 0.35, 0.14, 0, -1, TAIL);
  b.wall(-w + 0.3, 0.05, -len - 0.01, 0.35, 0.14, 0, -1, TAIL);
  b.box(-w + 0.02, -0.36, len - 0.05, w - 0.02, -0.18, len + 0.06, TRIM); // bumper
  b.box(-w + 0.02, -0.36, -len - 0.06, w - 0.02, -0.18, -len + 0.05, TRIM);
  const roofY = type === 'pickup' ? 1.05 : type === 'sedan' ? 0.82 : 0.85;
  if (extras?.taxiSign) b.box(-0.3, roofY, -0.5, 0.3, roofY + 0.22, -0.2, C('#f4c430'));
  if (extras?.police) {
    b.box(-0.6, roofY, -0.35, -0.05, roofY + 0.15, -0.1, C('#e63946'));
    b.box(0.05, roofY, -0.35, 0.6, roofY + 0.15, -0.1, C('#3a86ff'));
  }
  return b;
}

export function makeWheel(radius: number, width = 0.26): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 10).rotateZ(Math.PI / 2), wheelMat);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 6).rotateZ(Math.PI / 2), hubMat);
  tyre.castShadow = true;
  g.add(tyre, hub);
  return g;
}

/** A single merged mesh (body + static wheels) for AI cars: one draw call each. */
export function makeAiCarGeometry(type: CarTypeName, paint: THREE.Color, wheel: { r: number; x: number; zf: number; zr: number; y: number }, extras?: { police?: boolean; taxiSign?: boolean }): THREE.BufferGeometry {
  const b = buildCarBody(type, paint, extras);
  const tyre = C('#1d1d1f');
  for (const z of [wheel.zf, wheel.zr])
    for (const s of [-1, 1]) {
      const x = s * wheel.x;
      b.box(x - 0.13, wheel.y - wheel.r, z - wheel.r * 0.85, x + 0.13, wheel.y + wheel.r, z + wheel.r * 0.85, tyre);
    }
  return b.build();
}
