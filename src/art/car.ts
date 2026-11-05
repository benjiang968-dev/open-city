// Low-poly car bodies for each type, built in code. Forward is +Z.
import * as THREE from 'three';
import { GeoBuilder } from './geo';
import type { CarTypeName } from '../tuning';
import { makeCarMaterial, makeHubMaterial, makeTyreMaterial } from '../systems/render/vehicleMaterials';

const C = (h: number | string) => new THREE.Color(h);
const GLASS = C('#26303c');
const TRIM = C('#2b2b2b');
const HEAD = C('#fff6d5');
const TAIL = C('#d62828');

// clearcoat paint, glass, trim and lamps sorted per vertex colour; rubber tyres and polished hubs (render/vehicleMaterials.ts)
export const carMaterial = makeCarMaterial();
const wheelMat = makeTyreMaterial();
const hubMat = makeHubMaterial();

export interface CarParts {
  body: GeoBuilder; // deformable shell (includes glass and tail lights)
  bumperF: GeoBuilder;
  bumperR: GeoBuilder;
  lightL: GeoBuilder; // headlights, one per side so they can break separately (+X = car's left)
  lightR: GeoBuilder;
  windscreen: { x: number; y: number; z: number; w: number; h: number };
  /** Left side window (mirror x for the right): centre, length along the car, height. */
  sideWindow: { x: number; y: number; z: number; w: number; h: number };
  len: number; // half length
  halfW: number;
}

/** Builds the body (no wheels) as one builder. Body origin = chassis collider centre. */
export function buildCarBody(type: CarTypeName, paint: THREE.Color, extras?: { taxiSign?: boolean; police?: boolean }): GeoBuilder {
  return buildCarParts(type, paint, extras, false).body;
}

/** Builds the car as separate parts (split=true) for drivable cars that can lose bumpers and lights. */
export function buildCarParts(type: CarTypeName, paint: THREE.Color, extras?: { taxiSign?: boolean; police?: boolean }, split = true): CarParts {
  const b = new GeoBuilder();
  const bf = split ? new GeoBuilder() : b, br = split ? new GeoBuilder() : b, ll = split ? new GeoBuilder() : b, lr = split ? new GeoBuilder() : b;
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
  if (split) {
    // dark sockets stay on the body when the lamps break
    b.wall(w - 0.3, 0.02, len + 0.005, 0.37, 0.18, 0, 1, TRIM);
    b.wall(-w + 0.3, 0.02, len + 0.005, 0.37, 0.18, 0, 1, TRIM);
  }
  ll.wall(w - 0.3, 0.02, len + 0.02, 0.35, 0.16, 0, 1, HEAD);
  lr.wall(-w + 0.3, 0.02, len + 0.02, 0.35, 0.16, 0, 1, HEAD);
  b.wall(w - 0.3, 0.05, -len - 0.01, 0.35, 0.14, 0, -1, TAIL);
  b.wall(-w + 0.3, 0.05, -len - 0.01, 0.35, 0.14, 0, -1, TAIL);
  bf.box(-w + 0.02, -0.36, len - 0.05, w - 0.02, -0.18, len + 0.08, TRIM); // bumpers
  br.box(-w + 0.02, -0.36, -len - 0.08, w - 0.02, -0.18, -len + 0.05, TRIM);
  const roofY = type === 'pickup' ? 1.05 : type === 'sedan' ? 0.82 : 0.85;
  if (extras?.taxiSign) b.box(-0.3, roofY, -0.5, 0.3, roofY + 0.22, -0.2, C('#f4c430'));
  if (extras?.police) {
    b.box(-0.6, roofY, -0.35, -0.05, roofY + 0.15, -0.1, C('#e63946'));
    b.box(0.05, roofY, -0.35, 0.6, roofY + 0.15, -0.1, C('#3a86ff'));
  }
  const windscreen =
    type === 'hatchback' ? { x: 0, y: 0.57, z: 0.575, w: 1.4, h: 0.5 } : type === 'sedan' ? { x: 0, y: 0.53, z: 0.875, w: 1.5, h: 0.5 } : { x: 0, y: 0.7, z: 1.325, w: 1.6, h: 0.55 };
  const sideWindow =
    type === 'hatchback' ? { x: 0.79, y: 0.57, z: -0.5, w: 1.8, h: 0.45 } : type === 'sedan' ? { x: 0.85, y: 0.53, z: -0.18, w: 1.8, h: 0.45 } : { x: 0.96, y: 0.7, z: 0.55, w: 1.2, h: 0.5 };
  return { body: b, bumperF: bf, bumperR: br, lightL: ll, lightR: lr, windscreen, sideWindow, len, halfW: w };
}

/** Split every triangle into 4 (repeatable) so dents can bend flat panels smoothly. Non-indexed only. */
export function subdivide(g: THREE.BufferGeometry, levels: number): THREE.BufferGeometry {
  let pos = g.getAttribute('position').array as Float32Array;
  let nor = g.getAttribute('normal').array as Float32Array;
  let col = g.getAttribute('color').array as Float32Array;
  for (let l = 0; l < levels; l++) {
    const n = pos.length / 9;
    const P = new Float32Array(pos.length * 4), N = new Float32Array(nor.length * 4), Cc = new Float32Array(col.length * 4);
    let o = 0;
    for (let t = 0; t < n; t++) {
      const a = t * 9;
      const v = (k: number, i: number) => pos[a + k * 3 + i];
      const m = (k1: number, k2: number, i: number) => (v(k1, i) + v(k2, i)) / 2;
      const pts = [
        [0, 1, 2].map((i) => v(0, i)), [0, 1, 2].map((i) => v(1, i)), [0, 1, 2].map((i) => v(2, i)),
        [0, 1, 2].map((i) => m(0, 1, i)), [0, 1, 2].map((i) => m(1, 2, i)), [0, 1, 2].map((i) => m(2, 0, i)),
      ];
      for (const [x, y, z] of [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]]) {
        for (const k of [x, y, z]) {
          P.set(pts[k], o * 3);
          N.set([nor[a], nor[a + 1], nor[a + 2]], o * 3);
          Cc.set([col[a], col[a + 1], col[a + 2]], o * 3);
          o++;
        }
      }
    }
    pos = P; nor = N; col = Cc;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Shared windscreen crack texture (drawn once in code). */
let crackTex: THREE.CanvasTexture | null = null;
let crackMat: THREE.MeshBasicMaterial | null = null;
export function crackMaterial(): THREE.MeshBasicMaterial {
  if (!crackTex) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d')!;
    g.strokeStyle = 'rgba(235,245,255,0.9)';
    g.lineWidth = 1.6;
    const cx = 150, cy = 40;
    // deterministic spider-web crack
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2 + 0.3;
      g.beginPath();
      g.moveTo(cx, cy);
      let x = cx, y = cy;
      for (let s = 0; s < 6; s++) {
        x += Math.cos(a + Math.sin(k * 7 + s) * 0.4) * 14;
        y += Math.sin(a + Math.cos(k * 5 + s) * 0.4) * 9;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (const r of [10, 22, 36]) {
      g.beginPath();
      g.ellipse(cx, cy, r * 1.4, r * 0.8, 0, 0, Math.PI * 2);
      g.stroke();
    }
    crackTex = new THREE.CanvasTexture(c);
  }
  if (!crackMat) crackMat = new THREE.MeshBasicMaterial({ map: crackTex, transparent: true, depthWrite: false });
  return crackMat;
}
export const headlightMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });

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
