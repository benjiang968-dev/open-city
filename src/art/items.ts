// Code-built meshes for pickable items. Each geometry is centred on its physics collider.
import * as THREE from 'three';
import { GeoBuilder } from './geo';

export type ItemId = 'bottle' | 'can' | 'bag' | 'box' | 'cone' | 'brick' | 'wrench' | 'bat';
export const ITEM_IDS: ItemId[] = ['bottle', 'can', 'bag', 'box', 'cone', 'brick', 'wrench', 'bat'];

export interface ItemArt {
  geo: THREE.BufferGeometry;
  collider: { kind: 'box'; hx: number; hy: number; hz: number } | { kind: 'cyl'; r: number; hh: number };
  /** Resting pose on the ground: centre height and rotation about Z (bats lie on their side). */
  restY: number;
  restRotZ: number;
  /** Pose in the right hand (arm hangs along -Y from the shoulder). */
  holdPos: [number, number, number];
  holdRot: [number, number, number];
}

const C = (h: string) => new THREE.Color(h);

function cylinder(r0: number, r1: number, h: number, seg: number, color: THREE.Color, y = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg).toNonIndexed().translate(0, y, 0);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  for (const p of parts) {
    pos.push(...(p.getAttribute('position').array as Float32Array));
    nor.push(...(p.getAttribute('normal').array as Float32Array));
    col.push(...(p.getAttribute('color').array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

export function buildItemArt(id: ItemId): ItemArt {
  switch (id) {
    case 'bottle': {
      const glass = C('#2f8f4e');
      return {
        geo: merge([cylinder(0.045, 0.045, 0.18, 8, glass, -0.04), cylinder(0.045, 0.018, 0.05, 8, glass, 0.075), cylinder(0.018, 0.018, 0.04, 6, C('#1f6b39'), 0.115)]),
        collider: { kind: 'cyl', r: 0.045, hh: 0.135 },
        restY: 0.135, restRotZ: 0, holdPos: [0, -0.62, 0.03], holdRot: [0, 0, 0],
      };
    }
    case 'can': {
      return {
        geo: merge([cylinder(0.033, 0.033, 0.1, 10, C('#d62828')), cylinder(0.031, 0.031, 0.02, 10, C('#c0c4c8'), 0.06)]),
        collider: { kind: 'cyl', r: 0.033, hh: 0.06 },
        restY: 0.06, restRotZ: 0, holdPos: [0, -0.62, 0.03], holdRot: [0, 0, 0],
      };
    }
    case 'bag': {
      const g = new THREE.IcosahedronGeometry(0.22, 0); // already non-indexed
      g.scale(1, 0.85, 1);
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set(i % 9 < 3 ? [0.16, 0.17, 0.19] : [0.1, 0.1, 0.12], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      return { geo: merge([g, cylinder(0.03, 0.05, 0.08, 6, C('#2b2d31'), 0.21)]), collider: { kind: 'box', hx: 0.2, hy: 0.19, hz: 0.2 }, restY: 0.19, restRotZ: 0, holdPos: [0, -0.86, 0.02], holdRot: [0, 0, 0] };
    }
    case 'box': {
      const b = new GeoBuilder();
      const card = C('#c69c6d');
      b.box(-0.2, -0.15, -0.15, 0.2, 0.15, 0.15, card, C('#b8895a'));
      b.box(-0.2, 0.15, -0.02, 0.2, 0.152, 0.02, C('#e0c9a6')); // tape
      return { geo: b.build(), collider: { kind: 'box', hx: 0.2, hy: 0.15, hz: 0.15 }, restY: 0.15, restRotZ: 0, holdPos: [0, -0.75, 0.12], holdRot: [0, 0, 0] };
    }
    case 'cone': {
      const orange = C('#ff7a1a');
      const parts = [cylinder(0.16, 0.16, 0.03, 4, C('#222222'), -0.225)];
      parts[0].rotateY(Math.PI / 4);
      parts.push(cylinder(0.13, 0.03, 0.42, 10, orange, 0.0));
      parts.push(cylinder(0.085, 0.07, 0.07, 10, C('#f5f5f5'), 0.02));
      return { geo: merge(parts), collider: { kind: 'cyl', r: 0.15, hh: 0.24 }, restY: 0.24, restRotZ: 0, holdPos: [0, -0.62, 0.05], holdRot: [Math.PI, 0, 0] };
    }
    case 'brick': {
      const b = new GeoBuilder();
      b.box(-0.11, -0.035, -0.055, 0.11, 0.035, 0.055, C('#a4472c'), C('#8e3b24'));
      return { geo: b.build(), collider: { kind: 'box', hx: 0.11, hy: 0.035, hz: 0.055 }, restY: 0.035, restRotZ: 0, holdPos: [0, -0.64, 0.03], holdRot: [0, 0, Math.PI / 2] };
    }
    case 'wrench': {
      const b = new GeoBuilder();
      const steel = C('#9aa3ad');
      b.box(-0.15, -0.012, -0.018, 0.1, 0.012, 0.018, steel, C('#7d8590'));
      b.box(0.1, -0.012, -0.04, 0.15, 0.012, -0.012, steel);
      b.box(0.1, -0.012, 0.012, 0.15, 0.012, 0.04, steel);
      b.box(-0.15, -0.013, -0.019, -0.04, 0.013, 0.019, C('#c1121f')); // grip
      return { geo: b.build(), collider: { kind: 'box', hx: 0.15, hy: 0.013, hz: 0.04 }, restY: 0.013, restRotZ: 0, holdPos: [0, -0.66, 0.05], holdRot: [0, 0, -Math.PI / 2] };
    }
    case 'bat': {
      const g = merge([cylinder(0.018, 0.036, 0.6, 8, C('#c8a165'), 0.12), cylinder(0.018, 0.018, 0.22, 6, C('#3d2b1f'), -0.29), cylinder(0.026, 0.026, 0.02, 8, C('#3d2b1f'), -0.405)]);
      return { geo: g, collider: { kind: 'cyl', r: 0.036, hh: 0.42 }, restY: 0.036, restRotZ: Math.PI / 2, holdPos: [0, -0.52, 0.29], holdRot: [1.25, 0, 0] }; // handle in the hand, barrel forward
    }
  }
}
