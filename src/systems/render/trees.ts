// Trees with two levels of detail. Far away: the generator's own instanced crowns (one per species), now with bark and
// leaf textures. Near the camera (TUNING.quality.*.treeNear metres): a detailed tree in the same place, with a tapered
// bark trunk, branches into the crown, a dense inner crown and several dozen alpha-cut leaf cards lit with rounded
// normals, so canopies read as foliage, not polyhedra. The far crowns hide themselves in the vertex shader inside that
// radius (no buffer rewrite); the near set is refilled from a grid when the camera has moved a few metres (no
// allocation). Leaf cards cast no shadow (a depth pass cannot cut them out); the far crowns keep casting the canopy
// shadow for every tree, near ones included.
import * as THREE from 'three';
import { SURF, surf } from './surfaces';
import type { Look } from './look';
import { makeWorldMaterial } from './worldMaterial';

/** sRGB hex to packed linear (as meshKit lin()). */
function lin(hex: number): number {
  const ch = (v: number) => { const c = v / 255; return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); };
  return (ch((hex >> 16) & 255) << 16) | (ch((hex >> 8) & 255) << 8) | ch(hex & 255);
}

/** Small geometry builder with explicit normals (rounded canopy normals need them). */
class Geo {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  s: number[] = [];
  /** card coordinates (-1..1 across a leaf card; 0 elsewhere): the shader rounds the cards into clusters */
  cd: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: number, cu = 0, cv = 0) {
    this.p.push(x, y, z);
    this.cd.push(cu, cv);
    const L = Math.hypot(nx, ny, nz) || 1;
    this.n.push(nx / L, ny / L, nz / L);
    this.c.push(((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255);
    this.s.push((col >>> 24) & 127);
  }
  /** Tapered tube from a to b (radii ra, rb), flat normals per side. */
  tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, segs: number, col: number) {
    const ax = new THREE.Vector3().subVectors(b, a).normalize();
    const u = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(ax).normalize() : new THREE.Vector3(1, 0, 0).cross(ax).normalize();
    const v = new THREE.Vector3().crossVectors(ax, u);
    const ring = (o: THREE.Vector3, r: number, k: number) => {
      const t = (k / segs) * Math.PI * 2;
      return o.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r);
    };
    for (let k = 0; k < segs; k++) {
      const a0 = ring(a, ra, k), a1 = ring(a, ra, k + 1), b0 = ring(b, rb, k), b1 = ring(b, rb, k + 1);
      const m = (k + 0.5) / segs * Math.PI * 2;
      const nx = u.x * Math.cos(m) + v.x * Math.sin(m), ny = u.y * Math.cos(m) + v.y * Math.sin(m), nz = u.z * Math.cos(m) + v.z * Math.sin(m);
      for (const q of [a0, a1, b1, a0, b1, b0]) this.vert(q.x, q.y, q.z, nx, ny, nz, col);
    }
  }
  /** Ellipsoid crown (low poly) with normals from its centre. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: number, detail = 1) {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    const pos = ico.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      this.vert(cx + x * rx, cy + y * ry, cz + z * rz, x, y * 0.8, z, col);
    }
    ico.dispose();
  }
  /** Leaf card: a quad centred at c, spanned by e1/e2 (half extents), rounded normals from the crown centre o. */
  card(c: THREE.Vector3, e1: THREE.Vector3, e2: THREE.Vector3, o: THREE.Vector3, col: number) {
    const q = [
      c.clone().sub(e1).sub(e2), c.clone().add(e1).sub(e2), c.clone().add(e1).add(e2), c.clone().sub(e1).add(e2),
    ];
    const cc = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = q[k];
      // a little of the card's own facing keeps the shading from looking like a smooth ball
      this.vert(p.x, p.y, p.z, p.x - o.x, (p.y - o.y) * 1.2 + 0.4, p.z - o.z, col, cc[k][0], cc[k][1]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(Uint8Array.from(this.s), 1, false));
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.cd, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic pseudo-random sequence for the species models. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Crown { cy: number; rx: number; ry: number; cards: number; card: [number, number]; conifer: boolean }
/** Crowns matching the generator's species (props.ts): 0 round deciduous, 1 conifer, 2 street tree. */
const CROWNS: Crown[] = [
  { cy: 4.1, rx: 2.3, ry: 2.4, cards: 46, card: [0.75, 1.0], conifer: false },
  { cy: 4.0, rx: 2.0, ry: 3.6, cards: 40, card: [0.7, 0.6], conifer: true },
  { cy: 4.6, rx: 1.75, ry: 2.3, cards: 38, card: [0.65, 0.9], conifer: false },
];

/** Near-detail tree for a species: wood (trunk, branches, inner crown) and leaves (cards). */
export function nearTree(sp: number): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const C = CROWNS[sp];
  const r = rng(1234 + sp * 77);
  const wood = new Geo(), leaves = new Geo();
  const bark = surf(SURF.BARK, lin(0x6b4a2f));
  const leanX = C.conifer ? 0.04 : (sp === 2 ? -0.1 : 0.13);
  const top = C.conifer ? C.cy + C.ry * 0.9 : C.cy - 0.2;
  wood.tube(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(leanX, top, 0.04), 0.24, C.conifer ? 0.05 : 0.13, 8, bark);
  // flared base
  wood.tube(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0, 0.45, 0), 0.24, 0.22, 8, bark);
  const o = new THREE.Vector3(0, C.cy, 0);
  if (!C.conifer) {
    // main branches from the top of the trunk into the crown
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + r() * 0.6;
      const y0 = C.cy - 1.6 + r() * 0.6;
      const end = new THREE.Vector3(Math.cos(a) * C.rx * 0.7, C.cy + 0.3 + r() * C.ry * 0.5, Math.sin(a) * C.rx * 0.7);
      wood.tube(new THREE.Vector3(0, y0, 0), end, 0.1, 0.035, 5, bark);
    }
  }
  // inner crown: darker, keeps the canopy from looking hollow between the cards
  const inner = surf(SURF.FOLIAGE, lin(sp === 1 ? 0x335c3b : 0x466c3e));
  if (C.conifer) {
    for (let t = 0; t < 3; t++) {
      const y = C.cy - C.ry * 0.55 + t * C.ry * 0.5, rr = C.rx * (1 - t * 0.28) * 0.75;
      wood.tube(new THREE.Vector3(0, y - C.ry * 0.2, 0), new THREE.Vector3(0.03, y + C.ry * 0.48, 0.02), rr, 0.025, 10, inner);
    }
  } else {
    // Overlapping irregular foliage clusters avoid the old dark sphere visible inside every backlit crown.
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI * 2 / 3 + sp * 0.65;
      wood.blob(Math.cos(a) * C.rx * 0.25, C.cy + (k === 1 ? 0.34 : -0.12), Math.sin(a) * C.rx * 0.25,
        C.rx * 0.72, C.ry * (k === 1 ? 0.68 : 0.58), C.rx * 0.72, inner, 1);
    }
  }
  // leaf cards over the crown surface, facing outward with some tilt
  const leaf = surf(SURF.FOLIAGE, lin(sp === 1 ? 0x3e6644 : 0x5b8149));
  const n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), c = new THREE.Vector3();
  for (let k = 0; k < C.cards; k++) {
    // points spread over the ellipsoid (more on top), slightly inside it
    const z = 1 - 2 * ((k + 0.5) / C.cards);
    const ph = k * 2.39996 + r() * 0.4;
    const rad = Math.sqrt(1 - z * z);
    n.set(Math.cos(ph) * rad, z * 0.8 + 0.2, Math.sin(ph) * rad).normalize();
    if (C.conifer) {
      // drooping tiers: cards hang out and down from the stem
      const tier = Math.floor(r() * 4);
      const y = C.cy - C.ry * 0.75 + tier * C.ry * 0.45 + r() * 0.3;
      const rr = C.rx * (1 - tier * 0.22) * (0.55 + r() * 0.35);
      c.set(Math.cos(ph) * rr, y, Math.sin(ph) * rr);
      n.set(Math.cos(ph), 0.35, Math.sin(ph)).normalize();
      wood.tube(new THREE.Vector3(0, y + 0.18, 0), c, 0.027, 0.008, 3, bark);
    } else {
      const lobe = k % 3, a = lobe * Math.PI * 2 / 3 + sp * 0.65;
      const k2 = 0.82 + r() * 0.18;
      c.set(Math.cos(a) * C.rx * 0.25 + n.x * C.rx * 0.72 * k2,
        C.cy + (lobe === 1 ? 0.34 : -0.12) + n.y * C.ry * (lobe === 1 ? 0.68 : 0.58) * k2,
        Math.sin(a) * C.rx * 0.25 + n.z * C.rx * 0.72 * k2);
    }
    // card plane: mostly tangent to the crown, tilted at random so they cross each other
    t1.set(0, 1, 0).cross(n);
    if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0);
    t1.normalize();
    t2.crossVectors(n, t1).normalize();
    const tilt = (r() - 0.5) * 1.6;
    t1.applyAxisAngle(n, r() * Math.PI);
    t2.crossVectors(n, t1).normalize();
    t2.applyAxisAngle(t1, tilt);
    // Evergreen boughs spread out and droop, instead of hanging as upright balls on the stem.
    if (C.conifer) t2.set(n.x, -0.32, n.z).normalize();
    const w = C.card[0] * (0.8 + r() * 0.5), h = C.card[1] * (0.8 + r() * 0.5);
    const shade = 0.88 + r() * 0.22;
    const variedLeaf = (leaf & 0x7f000000) | (Math.round(((leaf >> 16) & 255) * shade) << 16) | (Math.round(((leaf >> 8) & 255) * shade) << 8) | Math.round((leaf & 255) * shade);
    leaves.card(c, t1.multiplyScalar(w), t2.multiplyScalar(h), o, variedLeaf);
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

export interface TreeLod {
  /** Refill the near set when the camera has moved; call every frame (cheap when it has not). */
  update(cam: THREE.Vector3): void;
  setRadius(r: number): void;
  /** triangles of one near tree per species (for stats) */
  nearTris: number;
  meshes: THREE.InstancedMesh[];
}

/**
 * Detailed trees near the camera for the generator's instanced crowns named `trees-<species>` under root. Their
 * materials are replaced by the world material (bark and leaf textures) with the near-radius cut-out.
 */
export function createTreeLod(look: Look, root: THREE.Object3D, radius: number, capacity = 1500): TreeLod {
  const far: { im: THREE.InstancedMesh; sp: number }[] = [];
  root.traverse((o) => {
    const m = /^trees-(\d)$/.exec(o.name);
    if (m && (o as THREE.InstancedMesh).isInstancedMesh) far.push({ im: o as THREE.InstancedMesh, sp: Number(m[1]) });
  });
  const centre = { value: new THREE.Vector3(1e9, 0, 1e9) };
  const rad = { value: radius };
  const farMat = makeWorldMaterial(look, { name: 'trees-far', roughness: 0.85, hideNear: { centre, radius: rad } });
  const woodMat = makeWorldMaterial(look, { name: 'trees-wood', roughness: 0.9 });
  const leafMat = makeWorldMaterial(look, { name: 'trees-leaves', roughness: 0.75, foliage: true });
  const near: { wood: THREE.InstancedMesh; leaves: THREE.InstancedMesh }[] = [];
  let nearTris = 0;
  for (let sp = 0; sp < 3; sp++) {
    const g = nearTree(sp);
    nearTris += (g.wood.getAttribute('position').count + g.leaves.getAttribute('position').count) / 3;
    const wood = new THREE.InstancedMesh(g.wood, woodMat, capacity);
    const leaves = new THREE.InstancedMesh(g.leaves, leafMat, capacity);
    wood.name = `trees-near-wood-${sp}`;
    leaves.name = `trees-near-leaves-${sp}`;
    for (const im of [wood, leaves]) {
      im.count = 0;
      im.frustumCulled = false; // the set always surrounds the camera
      im.matrixAutoUpdate = false;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      root.add(im);
    }
    wood.castShadow = false; // the far crowns cast every tree's shadow (they are drawn in the shadow pass everywhere)
    leaves.castShadow = false;
    wood.receiveShadow = leaves.receiveShadow = true;
    near.push({ wood, leaves });
  }
  for (const f of far) { f.im.material = farMat; f.im.castShadow = true; }
  // grid of every instance: (far mesh index, instance index)
  const CELL = 32;
  const cells = new Map<number, number[]>();
  const pos = new THREE.Vector3(), m4 = new THREE.Matrix4();
  far.forEach((f, fi) => {
    for (let i = 0; i < f.im.instanceMatrix.count; i++) {
      f.im.getMatrixAt(i, m4);
      pos.setFromMatrixPosition(m4);
      const k = (Math.floor(pos.x / CELL) + 4096) * 8192 + (Math.floor(pos.z / CELL) + 4096);
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(fi, i);
    }
  });
  const last = new THREE.Vector3(1e9, 0, 1e9);
  const counts = [0, 0, 0];
  const refill = (cam: THREE.Vector3) => {
    // the far crowns hide around the same centre the near set was filled from, so no tree is drawn twice or missed
    centre.value.copy(cam);
    counts[0] = counts[1] = counts[2] = 0;
    const R = rad.value, R2 = R * R;
    const i0 = Math.floor((cam.x - R) / CELL), i1 = Math.floor((cam.x + R) / CELL);
    const j0 = Math.floor((cam.z - R) / CELL), j1 = Math.floor((cam.z + R) / CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const l = cells.get((i + 4096) * 8192 + (j + 4096));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 2) {
          const f = far[l[q]], idx = l[q + 1];
          if (idx >= f.im.count) continue; // beyond the quality's tree share
          const a = f.im.instanceMatrix.array as Float32Array;
          const dx = a[idx * 16 + 12] - cam.x, dz = a[idx * 16 + 14] - cam.z;
          if (dx * dx + dz * dz > R2) continue;
          const sp = f.sp, n = counts[sp];
          if (n >= capacity) continue;
          const N = near[sp];
          // plain copies (no typed-array views: refills make no garbage)
          const wm = N.wood.instanceMatrix.array as Float32Array, lm = N.leaves.instanceMatrix.array as Float32Array;
          for (let k = 0; k < 16; k++) { const v = a[idx * 16 + k]; wm[n * 16 + k] = v; lm[n * 16 + k] = v; }
          if (f.im.instanceColor) {
            const c = f.im.instanceColor.array as Float32Array;
            const wc = N.wood.instanceColor!.array as Float32Array, lc = N.leaves.instanceColor!.array as Float32Array;
            for (let k = 0; k < 3; k++) { const v = c[idx * 3 + k]; wc[n * 3 + k] = v; lc[n * 3 + k] = v; }
          }
          counts[sp] = n + 1;
        }
      }
    for (let sp = 0; sp < 3; sp++) {
      const N = near[sp];
      N.wood.count = N.leaves.count = counts[sp];
      for (const im of [N.wood, N.leaves]) {
        im.instanceMatrix.needsUpdate = true;
        im.instanceMatrix.clearUpdateRanges();
        im.instanceMatrix.addUpdateRange(0, counts[sp] * 16);
        im.instanceColor!.needsUpdate = true;
        im.instanceColor!.clearUpdateRanges();
        im.instanceColor!.addUpdateRange(0, counts[sp] * 3);
      }
    }
  };
  return {
    nearTris,
    meshes: near.flatMap((n) => [n.wood, n.leaves]),
    setRadius(r: number) { rad.value = r; last.set(1e9, 0, 1e9); },
    update(cam: THREE.Vector3) {
      if (rad.value <= 0) { if (counts[0] + counts[1] + counts[2] > 0) refill(cam); return; }
      const dx = cam.x - last.x, dz = cam.z - last.z;
      if (dx * dx + dz * dz < 36) return; // within 6 m of the last refill: the far crowns cover the ring edge
      last.copy(cam);
      refill(cam);
    },
  };
}
