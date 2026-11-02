// Accumulates coloured triangles into a single BufferGeometry (one draw call for many boxes).
import * as THREE from 'three';

// ---------- geometry helper: accumulates coloured triangles into one BufferGeometry ----------
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  private tri(a: number[], b: number[], c: number[], n: number[], k: THREE.Color, uvs?: number[][]) {
    this.pos.push(...a, ...b, ...c);
    this.nor.push(...n, ...n, ...n);
    this.col.push(k.r, k.g, k.b, k.r, k.g, k.b, k.r, k.g, k.b);
    if (uvs) this.uv.push(...uvs[0], ...uvs[1], ...uvs[2]);
  }
  /** Horizontal rectangle facing up. */
  quadY(x0: number, z0: number, x1: number, z1: number, y: number, k: THREE.Color) {
    const n = [0, 1, 0];
    this.tri([x0, y, z0], [x0, y, z1], [x1, y, z1], n, k);
    this.tri([x0, y, z0], [x1, y, z1], [x1, y, z0], n, k);
  }
  /** Vertical rectangle centred at c, facing (nx,0,nz). Optional UV rect [u0,v0,u1,v1]. */
  wall(cx: number, cy: number, cz: number, w: number, h: number, nx: number, nz: number, k: THREE.Color, uvr?: number[]) {
    const tx = nz, tz = -nx; // viewer's right
    const hw = w / 2, hh = h / 2;
    const BL = [cx - tx * hw, cy - hh, cz - tz * hw];
    const BR = [cx + tx * hw, cy - hh, cz + tz * hw];
    const TR = [cx + tx * hw, cy + hh, cz + tz * hw];
    const TL = [cx - tx * hw, cy + hh, cz - tz * hw];
    const n = [nx, 0, nz];
    if (uvr) {
      const [u0, v0, u1, v1] = uvr;
      this.tri(BL, BR, TR, n, k, [[u0, v0], [u1, v0], [u1, v1]]);
      this.tri(BL, TR, TL, n, k, [[u0, v0], [u1, v1], [u0, v1]]);
    } else {
      this.tri(BL, BR, TR, n, k);
      this.tri(BL, TR, TL, n, k);
    }
  }
  /** Axis-aligned box from its min corner (x0,y0,z0) to max (x1,y1,z1). No bottom face. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, k: THREE.Color, sideK?: THREE.Color) {
    const s = sideK ?? k;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    this.quadY(x0, z0, x1, z1, y1, k);
    this.wall(cx, cy, z1, w, h, 0, 1, s);
    this.wall(cx, cy, z0, w, h, 0, -1, s);
    this.wall(x1, cy, cz, d, h, 1, 0, s);
    this.wall(x0, cy, cz, d, h, -1, 0, s);
  }
  build(withUv = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
  get empty() {
    return this.pos.length === 0;
  }
}

