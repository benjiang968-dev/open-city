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
const glassMat = new THREE.MeshPhysicalMaterial({color:0x9fb8c7, roughness:0.12, metalness:0, transparent:true, opacity:0.2, depthWrite:false, side:THREE.DoubleSide});

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

/** Body dimensions in metres; +X is driver's side and forward is +Z. */
const SHAPES = {
  hatchback: { w: 0.85, len: 1.85, belt: 0.25, roof: 0.9, front: 0.58, rear: -1.5 },
  sedan: { w: 0.92, len: 2.25, belt: 0.22, roof: 0.86, front: 0.88, rear: -1.2 },
  pickup: { w: 1, len: 2.55, belt: 0.3, roof: 1.07, front: 1.3, rear: -0.2 },
  suv: { w: 0.99, len: 2.3, belt: 0.34, roof: 1.15, front: 1.02, rear: -1.85 },
  van: { w: 1.02, len: 2.55, belt: 0.4, roof: 1.62, front: 1.55, rear: -2.34 },
  sports: { w: 0.96, len: 2.12, belt: 0.14, roof: 0.66, front: 0.62, rear: -0.98 },
} as const;

/** Actual eye point above the left front seat, local to the chassis. */
export function driverSeat(type: CarTypeName): THREE.Vector3 {
  const s = SHAPES[type];
  return new THREE.Vector3(s.w * 0.44, s.roof - 0.19, s.front - 0.63);
}

/** Builds the car as separate parts for drivable cars that can lose bumpers and lights. */
export function buildCarParts(type: CarTypeName, paint: THREE.Color, extras?: { taxiSign?: boolean; police?: boolean }, split = true): CarParts {
  const b = new GeoBuilder();
  const bf = split ? new GeoBuilder() : b, br = split ? new GeoBuilder() : b, ll = split ? new GeoBuilder() : b, lr = split ? new GeoBuilder() : b;
  const dark = paint.clone().multiplyScalar(0.8);
  const s = SHAPES[type], { len, w, belt, roof, front, rear } = s;
  b.box(-w, -0.32, -len, w, belt, len, paint, dark);
  // A real opening above each door beltline. The former solid cabin box remained beneath the glass and blocked
  // first-person vision. Only the roof, narrow pillars and frames carry paint here; outward glass is back-face
  // culled in the distant LOD. Drivable cars use the thin transparent glazing in makeCarInterior().
  const cw = w - 0.07, bottom = belt + 0.02, top = roof - 0.09, middle = (bottom + top) / 2;
  b.box(-cw, top, rear, cw, roof, front, paint, dark);
  for (const x of [-cw, cw]) {
    for (const z of [rear + 0.035, front - 0.035]) b.box(x - 0.035, belt, z - 0.035, x + 0.035, top, z + 0.035, paint);
    if (type !== 'sports' && type !== 'pickup') b.box(x - 0.035, belt, (rear + front) / 2 - 0.03, x + 0.035, top, (rear + front) / 2 + 0.03, TRIM);
    if (!split) b.wall(x + Math.sign(x) * 0.008, middle, (rear + front) / 2, front - rear - 0.12, top - bottom, Math.sign(x), 0, GLASS);
    // Door handles, wing mirrors and lower protective mouldings.
    b.box(x - 0.025, belt - 0.08, front - 0.65, x + 0.025, belt - 0.035, front - 0.42, TRIM);
    b.box(x - 0.03, belt + 0.07, front - 0.22, x + 0.03, belt + 0.14, front - 0.13, TRIM);
    b.box(x + Math.sign(x) * 0.05 - 0.06, belt + 0.1, front - 0.33, x + Math.sign(x) * 0.05 + 0.06, belt + 0.23, front - 0.08, dark);
    b.wall(x + Math.sign(x) * 0.12, belt + 0.17, front - 0.205, 0.2, 0.09, Math.sign(x), 0, GLASS);
  }
  if (!split) {
    b.wall(0, middle, front + 0.008, cw * 2 - 0.1, top - bottom, 0, 1, GLASS);
    b.wall(0, middle, rear - 0.008, cw * 2 - 0.1, top - bottom, 0, -1, GLASS);
  }
  if (type === 'pickup') {
    b.box(-w, belt, -len, -w + 0.12, belt + 0.45, rear - 0.1, dark);
    b.box(w - 0.12, belt, -len, w, belt + 0.45, rear - 0.1, dark);
    b.box(-w, belt, -len, w, belt + 0.45, -len + 0.12, dark);
    b.quadY(-w + 0.12, -len + 0.12, w - 0.12, rear - 0.1, belt + 0.02, TRIM);
  }
  if (type === 'van') {
    // Cargo panels distinguish a work van from the SUV's glazed passenger cabin.
    for (const sign of [-1, 1]) b.wall(sign * (cw + 0.015), (belt + top) / 2, rear + 1.05, 1.92, top - belt, sign, 0, paint);
    b.box(-0.02, belt, rear - 0.02, 0.02, top, rear + 0.02, TRIM);
  }
  if (type === 'suv') {
    for (const x of [-0.68, 0.68]) b.box(x - 0.035, roof, rear + 0.15, x + 0.035, roof + 0.07, front - 0.2, TRIM);
  }
  if (type === 'sports') {
    b.box(-0.8, belt + 0.17, -len + 0.23, 0.8, belt + 0.21, -len + 0.5, dark);
    for (const x of [-0.6, 0.6]) b.box(x - 0.025, belt, -len + 0.32, x + 0.025, belt + 0.17, -len + 0.38, TRIM);
  }
  // Seats and dashboard are part of the shared shell, also visible through parked-car windows.
  const seatZ = front - 0.85, seatY = Math.max(-0.05, roof - 0.88), upholstery = C('#37393b');
  for (const x of [-w * 0.44, w * 0.44]) {
    b.box(x - 0.24, seatY - 0.17, seatZ - 0.3, x + 0.24, seatY, seatZ + 0.2, upholstery);
    b.box(x - 0.23, seatY - 0.05, seatZ - 0.32, x + 0.23, roof - 0.3, seatZ - 0.2, upholstery);
    b.box(x - 0.14, roof - 0.36, seatZ - 0.32, x + 0.14, roof - 0.18, seatZ - 0.2, upholstery);
  }
  b.box(-cw, roof - 0.65, front - 0.27, cw, roof - 0.42, front - 0.03, TRIM);
  if (split) {
    b.wall(w - 0.3, 0.02, len + 0.005, 0.42, 0.18, 0, 1, TRIM);
    b.wall(-w + 0.3, 0.02, len + 0.005, 0.42, 0.18, 0, 1, TRIM);
  }
  const lampH = type === 'van' || type === 'suv' ? 0.2 : type === 'sports' ? 0.09 : 0.14;
  ll.wall(w - 0.3, 0.04, len + 0.02, 0.4, lampH, 0, 1, HEAD);
  lr.wall(-w + 0.3, 0.04, len + 0.02, 0.4, lampH, 0, 1, HEAD);
  for (const sign of [-1, 1]) {
    b.wall(sign * (w - 0.22), belt - 0.12, -len - 0.015, 0.25, lampH, 0, -1, TAIL);
    b.wall(sign * (w - 0.23), -0.11, len + 0.015, 0.2, 0.06, 0, 1, TRIM);
  }
  b.wall(0, -0.08, len + 0.018, 0.6, 0.14, 0, 1, TRIM); // grille
  b.wall(0, -0.12, -len - 0.02, 0.34, 0.13, 0, -1, C('#d7d8d3')); // fictional plain plate
  bf.box(-w + 0.02, -0.36, len - 0.05, w - 0.02, -0.18, len + 0.08, TRIM);
  br.box(-w + 0.02, -0.36, -len - 0.08, w - 0.02, -0.18, -len + 0.05, TRIM);
  if (extras?.taxiSign) b.box(-0.3, roof, -0.5, 0.3, roof + 0.22, -0.2, C('#f4c430'));
  if (extras?.police) {
    b.box(-0.6, roof, -0.35, -0.05, roof + 0.15, -0.1, C('#e63946'));
    b.box(0.05, roof, -0.35, 0.6, roof + 0.15, -0.1, C('#3a86ff'));
  }
  const windscreen = { x: 0, y: middle, z: front + 0.025, w: cw * 2 - 0.1, h: top - bottom };
  const sideWindow = { x: cw + 0.02, y: middle, z: (rear + front) / 2, w: front - rear - 0.12, h: top - bottom };
  return { body: b, bumperF: bf, bumperR: br, lightL: ll, lightR: lr, windscreen, sideWindow, len, halfW: w };
}

/** Small reusable cockpit detail group. Wheels remain separate so steering rotates around the column. */
export function makeCarInterior(type: CarTypeName): THREE.Group {
  const s = SHAPES[type];
  const group = new THREE.Group();
  group.name = 'cockpit';
  const glazing = new GeoBuilder(), cw = s.w - 0.07, bottom = s.belt + 0.02, top = s.roof - 0.09;
  glazing.wall(0, (bottom+top)/2, s.front+0.008, cw*2-0.1, top-bottom, 0, 1, C(0xffffff));
  if(type !== 'van') glazing.wall(0, (bottom+top)/2, s.rear-0.008, cw*2-0.1, top-bottom, 0, -1, C(0xffffff));
  for(const sign of [-1,1]) {
    const rear=type==='van'?s.front-1.15:s.rear;
    glazing.wall(sign*(cw+0.008), (bottom+top)/2, (rear+s.front)/2, s.front-rear-0.12, top-bottom, sign, 0, C(0xffffff));
  }
  group.add(new THREE.Mesh(glazing.build(),glassMat));
  const dash=s.roof-0.55;
  const instrument = new GeoBuilder();
  instrument.box(s.w * 0.44 - 0.23, dash + 0.12, s.front - 0.27, s.w * 0.44 + 0.23, dash + 0.22, s.front - 0.12, TRIM);
  const panel = new THREE.Mesh(instrument.build(), carMaterial);
  group.add(panel);
  const wheel = new THREE.Group();
  wheel.name = 'steeringWheel';
  wheel.position.set(s.w * 0.44, dash + 0.15, s.front - 0.49);
  wheel.rotation.x = -0.2;
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.023, 6, 20), wheelMat));
  const spokes = new GeoBuilder();
  spokes.box(-0.14, -0.022, -0.012, 0.14, 0.022, 0.012, TRIM);
  spokes.box(-0.022, -0.14, -0.012, 0.022, 0.022, 0.012, TRIM);
  wheel.add(new THREE.Mesh(spokes.build(), carMaterial));
  group.add(wheel);
  // Gauge faces are bright, tiny geometry rather than a per-car texture or a light.
  const gaugeMat = new THREE.MeshBasicMaterial({color:0x8bbcb9});
  for (const off of [-0.1, 0.1]) {
    const gauge = new THREE.Mesh(new THREE.CircleGeometry(0.055, 16), gaugeMat);
    gauge.position.set(s.w * 0.44 + off, dash + 0.175, s.front - 0.275);
    gauge.rotation.y = Math.PI;
    group.add(gauge);
  }
  return group;
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
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 18).rotateZ(Math.PI / 2), wheelMat);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 10).rotateZ(Math.PI / 2), hubMat);
  tyre.castShadow = true;
  g.add(tyre, hub);
  return g;
}

/** Shared round wheel geometry for the instanced parked and one-mesh traffic LODs. */
const staticTyre = new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2).toNonIndexed();
const staticHub = new THREE.CylinderGeometry(0.56, 0.56, 1.06, 10).rotateZ(Math.PI / 2).toNonIndexed();
export function appendStaticWheels(b: GeoBuilder, wheel: { r: number; x: number; zf: number; zr: number; y: number }): void {
  for (const z of [wheel.zf, wheel.zr]) for (const sign of [-1, 1]) {
    const x = sign * wheel.x;
    for (const [g, color] of [[staticTyre, C('#1d1d1f')], [staticHub, C('#9a9da1')]] as const) {
      const p = g.getAttribute('position'), n = g.getAttribute('normal');
      for (let i = 0; i < p.count; i++) {
        b.pos.push(x + p.getX(i) * 0.26, wheel.y + p.getY(i) * wheel.r, z + p.getZ(i) * wheel.r);
        b.nor.push(n.getX(i), n.getY(i), n.getZ(i));
        b.col.push(color.r, color.g, color.b);
      }
    }
  }
}

/** A single merged mesh (body + static wheels) for AI cars: one draw call each. */
export function makeAiCarGeometry(type: CarTypeName, paint: THREE.Color, wheel: { r: number; x: number; zf: number; zr: number; y: number }, extras?: { police?: boolean; taxiSign?: boolean }): THREE.BufferGeometry {
  const b = buildCarBody(type, paint, extras);
  appendStaticWheels(b, wheel);
  return b.build();
}
