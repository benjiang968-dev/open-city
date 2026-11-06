// Road paint and other decals (rails, path ribbons) fitted to the surfaces they lie on, after the world is built. A
// marking is drawn 12 mm over its own road's profile (roadMesh.ts DH), but where two road surfaces meet (junction
// plateaus, a side road's apron, a road passing under a raised one) another surface can lie over the marking or within
// a few millimetres of it: the visual audit's overlap probe found 12 % of the marking samples at M St / Wisconsin Ave
// under another road surface, where they flicker through the decal's polygon offset at grazing angles. Polygon offset
// alone cannot fix that; the geometry is fixed here instead:
//  - a triangle whose covering surface is only a little higher (a plateau a few cm above the profile) is lifted vertex
//    by vertex onto it, keeping the clearance;
//  - a triangle still under a surface after that, or buried under the ground (a road's profile running under the
//    terrain or a junction it should stop at), is removed (collapsed to a point: the merged buffer keeps its layout).
//    Markings under a bridge or freeway deck far above stay: they are seen from under the deck.
// Heights come from the walking-surface index (surfaceIndex.ts): the same triangles as the drawn ground.
import type * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { SurfaceIndex } from './surfaceIndex';

export interface DecalFitStats { triangles: number; lifted: number; removed: number }

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

/**
 * Fit every decal mesh's triangles (non-indexed position buffers, world space) to the surfaces. Mutates the position
 * attributes in place and recomputes the bounds.
 */
export function fitDecals(meshes: readonly THREE.Mesh[], ground: SurfaceIndex, decks: SurfaceIndex): DecalFitStats {
  const idx = [ground, decks];
  const groundOnly = [ground];
  const stats: DecalFitStats = { triangles: 0, lifted: 0, removed: 0 };
  const clear = G.decalClearance, reach = G.decalLiftReach, step = G.decalSampleStep;
  const p = new Float64Array(9);
  for (const mesh of meshes) {
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    let changed = false;
    for (let t = 0; t + 8 < a.length; t += 9) {
      stats.triangles++;
      for (let k = 0; k < 9; k++) p[k] = a[t + k];
      // per vertex: lift onto a surface a little above it (never more than `reach`)
      let lifted = false, drop = false;
      for (let v = 0; v < 3; v++) {
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        const top = topAt(idx, x, z, y + reach);
        if (top === top && top > y - clear) { p[v * 3 + 1] = top + clear; lifted = true; }
      }
      // then the inside: samples along the edges and the centroid must all clear the surface under them
      for (let e = 0; e < 3 && !drop; e++) {
        const i0 = e * 3, i1 = ((e + 1) % 3) * 3;
        const len = Math.hypot(p[i1] - p[i0], p[i1 + 2] - p[i0 + 2]);
        const n = Math.max(1, Math.ceil(len / step));
        for (let s = 1; s < n && !drop; s++) {
          const f = s / n;
          const x = p[i0] + (p[i1] - p[i0]) * f, y = p[i0 + 1] + (p[i1 + 1] - p[i0 + 1]) * f, z = p[i0 + 2] + (p[i1 + 2] - p[i0 + 2]) * f;
          const top = topAt(idx, x, z, y + reach);
          if (top === top && top > y - clear * 0.5) drop = true;
        }
      }
      if (!drop) {
        const x = (p[0] + p[3] + p[6]) / 3, y = (p[1] + p[4] + p[7]) / 3, z = (p[2] + p[5] + p[8]) / 3;
        const top = topAt(idx, x, z, y + reach);
        if (top === top && top > y - clear * 0.5) drop = true;
      }
      // a vertex buried under the ground (not a deck) beyond the reach: the triangle goes
      for (let v = 0; v < 3 && !drop; v++) {
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        const over = topAt(groundOnly, x, z, y + 1000);
        if (over === over && over > y - clear * 0.5) drop = true;
      }
      if (drop) {
        const cx = (a[t] + a[t + 3] + a[t + 6]) / 3, cy = (a[t + 1] + a[t + 4] + a[t + 7]) / 3, cz = (a[t + 2] + a[t + 5] + a[t + 8]) / 3;
        for (let v = 0; v < 3; v++) { a[t + v * 3] = cx; a[t + v * 3 + 1] = cy; a[t + v * 3 + 2] = cz; }
        stats.removed++;
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
