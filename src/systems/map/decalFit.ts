// Road paint and other decals (rails, path ribbons) fitted to the surfaces they lie on, after the world is built. A
// marking is drawn 12 mm over its own road's profile (roadMesh.ts DH), but where two road surfaces meet (junction
// plateaus, a side road's apron, a road passing under a raised one) another surface can lie over the marking or within
// a few millimetres of it: the visual audit's overlap probe found 12 % of the marking samples at M St / Wisconsin Ave
// under another road surface, where they flicker through the decal's polygon offset at grazing angles. Polygon offset
// alone cannot fix that; the geometry is fixed here instead:
//  - a vertex with a surface only a little above it or a hair below it (a junction plateau a few cm above the
//    profile) is lifted onto that surface, keeping the clearance;
//  - a triangle whose inside is still within that band of a surface after the lift is removed (collapsed to a point:
//    the merged buffer keeps its layout);
//  - a marking under a surface well above it (a stripe's end under the kerb and sidewalk, a road under a deck) is left
//    alone: the opaque surface hides it cleanly, depth precision is ample at that separation.
// Heights come from the walking-surface index (surfaceIndex.ts): the same triangles as the drawn ground.
import type * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { SurfaceIndex } from './surfaceIndex';

export interface DecalFitStats { triangles: number; lifted: number; removed: number; removedBySurface: Record<number, number> }

const G = TUNING.geo;

/** Highest surface at (x, z) no higher than `ceil` over the given indexes (NaN where none covers the point). */
function topAt(idx: readonly SurfaceIndex[], x: number, z: number, ceil: number): number {
  let best = NaN;
  for (const s of idx) {
    const h = s.at(x, z, ceil);
    if (h === h && h <= ceil && !(h <= best)) best = h;
  }
  return best;
}

/** How far (m) the triangle p must rise so every sample along its edges and its centroid clears the surface under it
 * by half the clearance (0 = it does); only surfaces within `reach` above a sample count. */
function deficit(idx: readonly SurfaceIndex[], p: Float64Array, clear: number, reach: number, step: number): number {
  let need = 0;
  const test = (x: number, y: number, z: number) => {
    const top = topAt(idx, x, z, y + reach);
    if (top === top && top > y - clear * 0.5) need = Math.max(need, top + clear * 0.5 - y + 1e-4);
  };
  for (let e = 0; e < 3; e++) {
    const i0 = e * 3, i1 = ((e + 1) % 3) * 3;
    const n = Math.max(1, Math.ceil(Math.hypot(p[i1] - p[i0], p[i1 + 2] - p[i0 + 2]) / step));
    for (let s = 1; s < n; s++) {
      const f = s / n;
      test(p[i0] + (p[i1] - p[i0]) * f, p[i0 + 1] + (p[i1 + 1] - p[i0 + 1]) * f, p[i0 + 2] + (p[i1 + 2] - p[i0 + 2]) * f);
    }
  }
  test((p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3);
  return need;
}

/**
 * Fit every decal mesh's triangles (non-indexed position buffers, world space) to the surfaces. Mutates the position
 * attributes in place and recomputes the bounds.
 */
export function fitDecals(meshes: readonly THREE.Mesh[], ground: SurfaceIndex, decks: SurfaceIndex): DecalFitStats {
  const idx = [ground, decks];
  const stats: DecalFitStats = { triangles: 0, lifted: 0, removed: 0, removedBySurface: {} };
  const clear = G.decalClearance, reach = G.decalLiftReach, step = G.decalSampleStep;
  const p = new Float64Array(9);
  for (const mesh of meshes) {
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    const srf = mesh.geometry.getAttribute('aSurf');
    let changed = false;
    for (let t = 0; t + 8 < a.length; t += 9) {
      stats.triangles++;
      for (let k = 0; k < 9; k++) p[k] = a[t + k];
      // per vertex: lift onto a surface a little above it (at most `reach` above the marking)
      let lifted = false, drop: boolean;
      for (let v = 0; v < 3; v++) {
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        const top = topAt(idx, x, z, y + reach);
        if (top === top && top > y - clear) { p[v * 3 + 1] = top + clear; lifted = true; }
      }
      // then the inside: samples along the edges and the centroid must clear the surface under them; a small deficit
      // (a fold of the surface between the vertices, a path draped on a smoother height than the terrain mesh) lifts
      // the whole triangle, a larger one removes it
      let need = deficit(idx, p, clear, reach, step);
      if (need > 0 && need <= reach) {
        for (let v = 0; v < 3; v++) p[v * 3 + 1] += need;
        lifted = true;
        need = deficit(idx, p, clear, reach, step);
      }
      drop = need > 0;
      if (drop) {
        const cx = (a[t] + a[t + 3] + a[t + 6]) / 3, cy = (a[t + 1] + a[t + 4] + a[t + 7]) / 3, cz = (a[t + 2] + a[t + 5] + a[t + 8]) / 3;
        for (let v = 0; v < 3; v++) { a[t + v * 3] = cx; a[t + v * 3 + 1] = cy; a[t + v * 3 + 2] = cz; }
        stats.removed++;
        const sid = srf ? srf.getX(t / 3) : 0;
        stats.removedBySurface[sid] = (stats.removedBySurface[sid] ?? 0) + 1;
        changed = true;
      } else if (lifted) {
        for (let v = 0; v < 3; v++) a[t + v * 3 + 1] = p[v * 3 + 1];
        stats.lifted++;
        changed = true;
      }
    }
    if (changed) {
      attr.needsUpdate = true;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    }
  }
  return stats;
}
