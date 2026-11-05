// F4 physics debug view: wireframes of the collision shapes near the player, coloured by solid kind (static world:
// the registry colour; cars orange, people cyan, loose items yellow, the player white). Lines in front of the scene are
// bright, hidden ones faint. Rebuilt a few times a second from Rapier's colliders within TUNING.debug.physRadius.
// Off: nothing is built, nothing is in the scene and the per-frame cost is one key check.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { act } from './input';
import { solidKindDef } from './objects/solidKinds';

const D = TUNING.debug;

/** Static shape data copied out of Rapier once per collider (trimeshes come with a coarse triangle grid). */
interface ShapeCache {
  verts: Float32Array;
  idx: Uint32Array;
  /** TriMesh only: triangle ids per 16 m cell (key -> ids). */
  cells?: Map<number, number[]>;
}

export interface PhysDebugState {
  on: boolean;
  lines: THREE.LineSegments | null;
  hidden: THREE.LineSegments | null;
  pos: Float32Array | null;
  col: Float32Array | null;
  nextAt: number;
  segs: number;
  colliders: number;
  cache: Map<number, ShapeCache>;
  label: HTMLElement | null;
}

export function createPhysDebug(): PhysDebugState {
  return { on: false, lines: null, hidden: null, pos: null, col: null, nextAt: 0, segs: 0, colliders: 0, cache: new Map(), label: null };
}

/** F4 (read at the top of the frame, with F3, before one-shot keys are cleared). */
export function physDebugKeys(w: World): void {
  if (act.physDebug(w.input)) toggle(w, w.physDebug);
}

/** Rebuild the lines every TUNING.debug.physRefresh seconds while on. */
export function updatePhysDebug(w: World): void {
  const S = w.physDebug;
  if (!S.on) return;
  if (w.time < S.nextAt) return;
  S.nextAt = w.time + D.physRefresh;
  rebuild(w, S);
}

function toggle(w: World, S: PhysDebugState) {
  S.on = !S.on;
  if (S.on && !S.lines) {
    const n = D.physMaxSegments * 2;
    S.pos = new Float32Array(n * 3);
    S.col = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(S.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(S.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    // in front: bright; behind other geometry: faint (same buffers, second pass without depth test)
    S.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    S.hidden = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
    for (const l of [S.lines, S.hidden]) { l.frustumCulled = false; l.matrixAutoUpdate = false; l.name = 'physics-debug'; }
    S.hidden.renderOrder = 999;
    S.label = document.createElement('div');
    S.label.style.cssText = 'position:absolute;right:22px;bottom:110px;font:12px/1.4 ui-monospace,monospace;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:5px;color:#e8f4ff;pointer-events:none';
    document.getElementById('ui')?.appendChild(S.label);
  }
  if (!S.lines || !S.hidden || !S.label) return;
  if (S.on) { w.scene.add(S.lines, S.hidden); S.label.style.display = 'block'; S.nextAt = 0; }
  else { w.scene.remove(S.lines, S.hidden); S.label.style.display = 'none'; S.cache.clear(); }
}

// ------------------------------------------------------------------------------------------------ building lines
const tmpC = new THREE.Color();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const o = new THREE.Vector3();

function rebuild(w: World, S: PhysDebugState) {
  const pos = S.pos!, col = S.col!;
  const max = D.physMaxSegments;
  let n = 0;
  const R = w.R;
  const p = w.player.vehicle ? w.player.vehicle.mesh.position : w.player.mesh.position;
  const cx = p.x, cy = p.y, cz = p.z, r = D.physRadius, r2 = r * r;
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (n >= max) return;
    const k = n * 6;
    pos[k] = ax; pos[k + 1] = ay; pos[k + 2] = az; pos[k + 3] = bx; pos[k + 4] = by; pos[k + 5] = bz;
    col[k] = col[k + 3] = tmpC.r; col[k + 1] = col[k + 4] = tmpC.g; col[k + 2] = col[k + 5] = tmpC.b;
    n++;
  };
  // local point -> world (collider pose in o / q)
  const W = (x: number, y: number, z: number) => v.set(x, y, z).applyQuaternion(q).add(o);
  let count = 0;
  w.physics.collidersWithAabbIntersectingAabb({ x: cx, y: cy, z: cz }, { x: r, y: D.physHeight, z: r }, (c: RAPIER.Collider) => {
    if (!c.isEnabled() || n >= max) return true;
    count++;
    colourOf(w, c);
    const t = c.translation(), rot = c.rotation();
    o.set(t.x, t.y, t.z);
    q.set(rot.x, rot.y, rot.z, rot.w);
    const type = c.shapeType();
    if (type === R.ShapeType.Cuboid) {
      const h = c.halfExtents()!;
      const P: number[] = [];
      for (const [sx, sy, sz] of BOX_CORNERS) { const a = W(sx * h.x, sy * h.y, sz * h.z); P.push(a.x, a.y, a.z); }
      for (const [i, j] of BOX_EDGES) seg(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
    } else if (type === R.ShapeType.Cylinder || type === R.ShapeType.Capsule || type === R.ShapeType.Ball) {
      const rad = c.radius(), hh = type === R.ShapeType.Ball ? 0 : c.halfHeight();
      const ring = (y: number, rr: number, verticals: boolean) => {
        let px = 0, py = 0, pz = 0;
        for (let k = 0; k <= 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const pt = W(Math.cos(a) * rr, y, Math.sin(a) * rr);
          if (k > 0) seg(px, py, pz, pt.x, pt.y, pt.z);
          px = pt.x; py = pt.y; pz = pt.z;
          if (verticals && k % 3 === 0 && k < 12) {
            const b = W(Math.cos(a) * rr, -y, Math.sin(a) * rr);
            seg(pt.x, pt.y, pt.z, b.x, b.y, b.z);
          }
        }
      };
      if (type === R.ShapeType.Cylinder) { ring(hh, rad, true); ring(-hh, rad, false); }
      else if (type === R.ShapeType.Capsule) { ring(hh, rad, true); ring(-hh, rad, false); ring(hh + rad * 0.7, rad * 0.7, false); ring(-hh - rad * 0.7, rad * 0.7, false); }
      else { ring(0, rad, false); }
    } else if (type === R.ShapeType.ConvexPolyhedron || type === R.ShapeType.TriMesh) {
      let sc = S.cache.get(c.handle);
      if (!sc) {
        const nsc: ShapeCache = { verts: c.vertices(), idx: c.indices() ?? new Uint32Array(0) };
        if (type === R.ShapeType.TriMesh) {
          const cells = new Map<number, number[]>();
          const V = nsc.verts, I = nsc.idx;
          for (let t3 = 0; t3 < I.length; t3 += 3) {
            const key = cellKey((V[I[t3] * 3] + V[I[t3 + 1] * 3] + V[I[t3 + 2] * 3]) / 3, (V[I[t3] * 3 + 2] + V[I[t3 + 1] * 3 + 2] + V[I[t3 + 2] * 3 + 2]) / 3);
            let l = cells.get(key);
            if (!l) cells.set(key, (l = []));
            l.push(t3);
          }
          nsc.cells = cells;
        }
        S.cache.set(c.handle, nsc);
        sc = nsc;
      }
      const V = sc.verts, I = sc.idx;
      const tri = (t3: number) => {
        const a = I[t3] * 3, b = I[t3 + 1] * 3, d = I[t3 + 2] * 3;
        const A = W(V[a], V[a + 1], V[a + 2]); const ax = A.x, ay = A.y, az = A.z;
        const B = W(V[b], V[b + 1], V[b + 2]); const bx = B.x, by = B.y, bz = B.z;
        const C = W(V[d], V[d + 1], V[d + 2]);
        seg(ax, ay, az, bx, by, bz); seg(bx, by, bz, C.x, C.y, C.z); seg(C.x, C.y, C.z, ax, ay, az);
      };
      if (sc.cells) {
        // only triangles near the player (trimeshes are local-space = world-space: chunk bodies sit at the origin)
        const c0 = Math.floor((cx - r) / CELL), c1 = Math.floor((cx + r) / CELL), d0 = Math.floor((cz - r) / CELL), d1 = Math.floor((cz + r) / CELL);
        for (let i = c0; i <= c1; i++) for (let j = d0; j <= d1; j++) {
          const l = sc.cells.get((i + 4096) * 8192 + (j + 4096));
          if (!l) continue;
          for (const t3 of l) {
            const a = I[t3] * 3;
            const dx = V[a] - cx, dz = V[a + 2] - cz, dy = V[a + 1] - cy;
            if (dx * dx + dz * dz > r2 || Math.abs(dy) > D.physHeight) continue;
            tri(t3);
          }
        }
      } else for (let t3 = 0; t3 < I.length; t3 += 3) tri(t3);
    }
    return n < max;
  });
  S.segs = n;
  S.colliders = count;
  const g = S.lines!.geometry;
  g.setDrawRange(0, n * 2);
  (g.getAttribute('position') as THREE.BufferAttribute).addUpdateRange(0, n * 6);
  (g.getAttribute('color') as THREE.BufferAttribute).addUpdateRange(0, n * 6);
  g.getAttribute('position').needsUpdate = true;
  g.getAttribute('color').needsUpdate = true;
  if (S.label) S.label.textContent = `F4 collision view · ${count} colliders · ${n}${n >= max ? '+' : ''} edges within ${r} m`;
}

const CELL = 16;
function cellKey(x: number, z: number) {
  return (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096);
}

function colourOf(w: World, c: RAPIER.Collider) {
  if (c === w.player.collider) { tmpC.setHex(0xffffff); return; }
  const k = w.city.solidTags.get(c.handle);
  if (k >= 0) { tmpC.setHex(solidKindDef(k).color); return; }
  const owner = w.colliderOwner.get(c.handle);
  if (owner) { tmpC.setHex(owner.kind === 'ped' ? 0x00e0ff : 0xff8000); return; }
  tmpC.setHex(w.itemsState.byCollider.has(c.handle) ? 0xffc000 : 0xff00ff);
}

const BOX_CORNERS = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]];
const BOX_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
