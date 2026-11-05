// The PBR look for the procedural grid city (?map=grid, cityGen.ts), applied after it is built so the generator itself
// is unchanged: every vertex-coloured mesh gets a surface id from its colour (the grid palette below: asphalt, paving,
// grass, sand, timber, concrete, stucco and painted fronts), plain-coloured meshes (tree trunks and crowns) get one
// from their material colour, and all of them move onto world materials; the sea gets the rippled water look.
import * as THREE from 'three';
import type { Look } from './look';
import { SURF } from './surfaces';
import { makeWorldMaterial } from './worldMaterial';

/** Grid palette (cityGen.ts COL, PALETTE, TOWER and props), sRGB hex -> surface. */
const GRID: [number, number][] = [
  [0x7dae5b, SURF.TERRAIN], [0x6fa84f, SURF.TERRAIN], [0xc9c4bb, SURF.CONCRETE_SLAB], [0xb3ada3, SURF.CONCRETE_SLAB],
  [0x4b4e55, SURF.ASPHALT], [0xf1efe6, SURF.PAINT], [0xe8c44a, SURF.PAINT], [0xead7a4, SURF.TERRAIN], [0xcdb886, SURF.TERRAIN],
  [0xa9a9a4, SURF.CONCRETE], [0x9a6b45, SURF.WOOD], [0x6e4a30, SURF.WOOD], [0x8b8d8a, SURF.STONE], [0x8c8f96, SURF.ROOF_TAR],
  [0x4d7c3a, SURF.FOLIAGE], [0x6b4a2f, SURF.BARK], [0x3b3f45, SURF.METAL_PAINT],
  // low-rise fronts (stucco and painted brick) and towers (precast concrete)
  [0xe8d5b7, SURF.STUCCO], [0xf2a65a, SURF.STUCCO], [0x7fb7be, SURF.BRICK_PAINTED], [0xd3e4cd, SURF.STUCCO], [0xf6e3c5, SURF.BRICK_PAINTED],
  [0xc97c5d, SURF.BRICK_RUNNING], [0x8e9aaf, SURF.STUCCO], [0xb8c4bb, SURF.STUCCO], [0xe9c46a, SURF.BRICK_PAINTED], [0xa8dadc, SURF.STUCCO],
  [0xf4a261, SURF.BRICK_PAINTED], [0xcdb4db, SURF.STUCCO], [0xef8a7a, SURF.BRICK_PAINTED], [0x9cc5a1, SURF.STUCCO],
  [0x6d8ea0, SURF.CONCRETE], [0x8aa1b1, SURF.CONCRETE], [0xa3b7c4, SURF.CONCRETE], [0x56718a, SURF.CONCRETE], [0xb9c6cf, SURF.CONCRETE],
  [0x7d8b99, SURF.CONCRETE],
];

const TABLE = (() => {
  const c = new THREE.Color();
  return GRID.map(([hex, s]) => { c.setHex(hex); return { r: c.r, g: c.g, b: c.b, s }; });
})();

/** Nearest grid palette colour (linear) within a small tolerance, scaled matches included (shaded sides). */
function surfaceFor(r: number, g: number, b: number): number {
  let best = 0, bd = 1e9;
  for (const q of TABLE) {
    const k = (r + g + b) / Math.max(1e-4, q.r + q.g + q.b);
    if (k < 0.6 || k > 1.3) continue;
    const L = Math.max(q.r, q.g, q.b, 0.03);
    const d = (Math.abs(r - q.r * k) + Math.abs(g - q.g * k) + Math.abs(b - q.b * k)) / L;
    if (d < bd) { bd = d; best = q.s; }
  }
  return bd < 0.2 ? best : 0;
}

function tagGeometry(g: THREE.BufferGeometry, fallback: THREE.Color | null, force = -1): void {
  if (g.getAttribute('aSurf')) return;
  const pos = g.getAttribute('position');
  const n = pos.count;
  const out = new Uint8Array(n);
  const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col && fallback) {
    // plain-coloured mesh: the material colour becomes a (white) vertex colour, the surface comes from it
    const s = force >= 0 ? force : surfaceFor(fallback.r, fallback.g, fallback.b);
    out.fill(s);
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  } else if (col) {
    const cache = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = col.getX(i), gg = col.getY(i), b = col.getZ(i);
      const key = (Math.round(r * 255) << 16) | (Math.round(gg * 255) << 8) | Math.round(b * 255);
      let s = cache.get(key);
      if (s === undefined) cache.set(key, (s = surfaceFor(r, gg, b)));
      out[i] = s;
    }
  }
  g.setAttribute('aSurf', new THREE.BufferAttribute(out, 1, false));
}

/** Move the grid city's meshes under `root` (built before anything else is added) onto world materials. */
export function applyGridLook(root: THREE.Object3D, look: Look, water: THREE.Mesh | null): number {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  let n = 0;
  const list: THREE.Mesh[] = [];
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m !== water) list.push(m); });
  for (const mesh of list) {
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m) || !m.isMeshStandardMaterial || m.transparent) continue;
    const plain = !m.vertexColors;
    // plain-coloured meshes keep their tint in the reference: the vertex colour is white, the colour is the material's
    const tint = plain ? m.color.clone() : null;
    // instanced crowns: white material, green per instance
    const crown = plain && (mesh as THREE.InstancedMesh).isInstancedMesh && !!(mesh as THREE.InstancedMesh).instanceColor;
    tagGeometry(mesh.geometry, tint, crown ? SURF.FOLIAGE : -1);
    if (plain && tint) {
      // white vertex colours with the material colour as the tint: scale the vertex colour instead
      const c = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c.count; i++) c.setXYZ(i, tint.r, tint.g, tint.b);
    }
    const key = `${m.roughness.toFixed(2)}:${m.metalness.toFixed(2)}`;
    let w = cache.get(key);
    if (!w) cache.set(key, (w = makeWorldMaterial(look, { name: `grid-${key}`, roughness: m.roughness, metalness: m.metalness })));
    m.dispose();
    mesh.material = w;
    n++;
  }
  if (water) {
    const wm = water.material as THREE.MeshStandardMaterial;
    wm.color.setHex(0x23403f);
    wm.roughness = 0.06;
    wm.metalness = 0;
    wm.opacity = 0.96;
    wm.flatShading = false;
    wm.needsUpdate = true;
  }
  return n;
}
