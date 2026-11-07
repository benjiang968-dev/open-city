// Shared metre-scale silhouettes for the player and the instanced crowd. Parts are built once, never per frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface HumanGeometry {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
}
const WHITE = new THREE.Color(1, 1, 1);
const DARK = new THREE.Color('#24272b');

class Part {
  private chunks: THREE.BufferGeometry[] = [];
  private add(g: THREE.BufferGeometry, color: THREE.Color) {
    const mesh = g.index ? g.toNonIndexed() : g;
    if (mesh !== g) g.dispose();
    mesh.deleteAttribute('uv');
    const colors = new Float32Array(mesh.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b; }
    mesh.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.chunks.push(mesh);
  }
  oval(x: number, y: number, z: number, rx: number, ry: number, rz: number, color: THREE.Color, segments = 8, rows = 5) {
    this.add(new THREE.SphereGeometry(1, segments, rows).scale(rx, ry, rz).translate(x, y, z), color);
  }
  tube(x: number, y: number, z: number, topRadius: number, bottomRadius: number, height: number, sx: number, sz: number, color: THREE.Color, segments = 8) {
    this.add(new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments, 1).scale(sx, 1, sz).translate(x, y, z), color);
  }
  profile(points: [number, number][], depth: number, color: THREE.Color, segments = 10) {
    this.add(new THREE.LatheGeometry(points.map(([y, radius]) => new THREE.Vector2(radius, y)), segments).scale(1, 1, depth), color);
  }
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.Color) {
    this.add(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z), color);
  }
  build() {
    const geometry = mergeGeometries(this.chunks, false);
    for (const g of this.chunks) g.dispose();
    geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    return geometry;
  }
}

/** White means the part's per-instance colour (skin, clothing or hair) passes through unchanged. */
export function buildHumanGeometry(shirt = WHITE, pants = WHITE, skin = WHITE, hairColor = WHITE): HumanGeometry {
  const torso = new Part();
  // Shoulder/chest/waist taper, with a rounded shoulder line instead of a square slab.
  torso.profile([[0.825, 0.173], [0.87, 0.176], [1.02, 0.179], [1.21, 0.205], [1.32, 0.225],
    [1.37, 0.211], [1.405, 0.15], [1.419, 0.078]], 0.65, shirt);
  const seam = shirt.clone().multiplyScalar(0.66);
  torso.tube(0, 1.414, 0, 0.076, 0.081, 0.026, 1, 0.78, seam, 10);
  torso.box(0, 0.836, 0.116, 0.29, 0.025, 0.014, pants.clone().multiplyScalar(0.38));

  const head = new Part();
  head.tube(0, 1.434, 0, 0.061, 0.066, 0.075, 1, 0.9, skin);
  head.oval(0, 1.586, 0, 0.108, 0.143, 0.104, skin, 10, 7);
  head.oval(0, 1.512, 0.025, 0.083, 0.065, 0.079, skin, 8, 5);
  for (const side of [-1, 1]) head.oval(side * 0.108, 1.58, -0.005, 0.018, 0.037, 0.025, skin, 6, 4);
  head.oval(0, 1.579, 0.103, 0.019, 0.032, 0.028, skin, 6, 4);
  // Separate small eyes and a subtle mouth replace the former black band across the entire face.
  for (const side of [-1, 1]) head.oval(side * 0.041, 1.614, 0.094, 0.012, 0.009, 0.009, DARK, 6, 4);
  head.box(0, 1.531, 0.096, 0.033, 0.005, 0.006, skin.clone().multiplyScalar(0.5));

  const hair = new Part();
  hair.oval(0, 1.713, -0.014, 0.115, 0.067, 0.106, hairColor, 10, 5);
  hair.oval(0, 1.662, -0.076, 0.101, 0.067, 0.035, hairColor, 8, 4);
  for (const side of [-1, 1]) hair.box(side * 0.098, 1.651, -0.008, 0.018, 0.05, 0.046, hairColor);

  const leg = new Part();
  leg.profile([[-0.79, 0.052], [-0.65, 0.058], [-0.45, 0.072], [-0.36, 0.074], [-0.2, 0.083], [0, 0.088]], 1.04, pants, 8);
  const shoe = new THREE.Color('#34383c'), sole = new THREE.Color('#161b1e');
  leg.oval(0, -0.801, 0.037, 0.075, 0.057, 0.134, shoe, 8, 4);
  leg.box(0, -0.844, 0.042, 0.145, 0.028, 0.25, sole);

  const arm = new Part();
  arm.profile([[-0.487, 0.042], [-0.43, 0.046], [-0.31, 0.054], [-0.2, 0.06], [-0.05, 0.073],
    [0.005, 0.064], [0.044, 0.039], [0.055, 0]], 1.05, shirt, 8);
  arm.tube(0, -0.481, 0.003, 0.042, 0.043, 0.018, 1, 1.06, seam);
  const hand = new Part();
  hand.tube(0, -0.517, 0.003, 0.037, 0.036, 0.062, 1, 0.88, skin);
  hand.oval(0, -0.586, 0.008, 0.042, 0.065, 0.029, skin, 8, 5);
  hand.oval(-0.031, -0.568, 0.015, 0.018, 0.034, 0.023, skin, 6, 4);
  return { torso: torso.build(), head: head.build(), hair: hair.build(), leg: leg.build(), arm: arm.build(), hand: hand.build() };
}
