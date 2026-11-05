// Geometry kit for the world generator v2: growable typed-array triangle soups (compact attributes), render buckets
// merged per chunk and material layer, and static physics grouped into one fixed body per physics chunk.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS } from '../../physicsGroups';
import { SolidTags, type SolidKind, type SolidRecorder } from '../objects/solidKinds';

// ------------------------------------------------------------------------------------------ colours
/** sRGB hex (0xRRGGBB) to packed LINEAR bytes, which is what three.js expects in vertex colours. */
const S2L = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}
export function lin(hex: number): number {
  return (S2L[(hex >> 16) & 255] << 16) | (S2L[(hex >> 8) & 255] << 8) | S2L[hex & 255];
}
/** Scale a packed linear colour (f > 1 brightens, clamped). */
export function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}
/** Mix two packed linear colours. */
export function mixc(a: number, b: number, t: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

// ------------------------------------------------------------------------------------------ mesh buffer
/**
 * Non-indexed triangle soup. Every face call computes a flat normal and orients the triangle so that normal agrees
 * with the hint direction, so callers never have to think about winding.
 */
export class MeshBuf {
  pos: Float32Array;
  nor: Int8Array;
  col: Uint8Array;
  uv: Float32Array | null;
  ex: Uint8Array | null;
  n = 0;
  /** Current facade attributes (tileA, tileB, altBay, seed) for buffers that carry them. */
  exA = 0; exB = 0; exC = 255; exD = 0;
  /** Current uv mode: if set, uvFn computes uv per vertex. */
  uvFn: ((x: number, y: number, z: number, out: Float32Array, o: number) => void) | null = null;
  /** Audit mode: drawn boxes, cylinders and walls are recorded (null = off). */
  rec: SolidRecorder | null = null;
  /** Nesting depth of primitive calls (only the outermost call is recorded: a box's own walls are not). */
  private recDepth = 0;
  constructor(withUv = false, withEx = false, cap = 4096) {
    this.pos = new Float32Array(cap * 3);
    this.nor = new Int8Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
    this.uv = withUv ? new Float32Array(cap * 2) : null;
    this.ex = withEx ? new Uint8Array(cap * 4) : null;
  }
  private grow(need: number) {
    let cap = this.pos.length / 3;
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const n = new Int8Array(cap * 3); n.set(this.nor); this.nor = n;
    const c = new Uint8Array(cap * 3); c.set(this.col); this.col = c;
    if (this.uv) { const u = new Float32Array(cap * 2); u.set(this.uv); this.uv = u; }
    if (this.ex) { const e = new Uint8Array(cap * 4); e.set(this.ex); this.ex = e; }
  }
  /** Raw vertex with an explicit normal (unit) and packed linear colour; uv explicit or via uvFn. */
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number, u = 0, v = 0) {
    const i = this.n;
    if (i * 3 + 3 > this.pos.length) this.grow(i + 1);
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.nor[o] = Math.round(nx * 127); this.nor[o + 1] = Math.round(ny * 127); this.nor[o + 2] = Math.round(nz * 127);
    this.col[o] = (c >> 16) & 255; this.col[o + 1] = (c >> 8) & 255; this.col[o + 2] = c & 255;
    if (this.uv) {
      if (this.uvFn) this.uvFn(x, y, z, this.uv, i * 2);
      else { this.uv[i * 2] = u; this.uv[i * 2 + 1] = v; }
    }
    if (this.ex) { const e = i * 4; this.ex[e] = this.exA; this.ex[e + 1] = this.exB; this.ex[e + 2] = this.exC; this.ex[e + 3] = this.exD; }
    this.n = i + 1;
  }
  /** Triangle with a flat normal; flipped if the normal disagrees with hint (hx,hy,hz). Colour per triangle. */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, c: number, hx = 0, hy = 1, hz = 0) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    if (nx * hx + ny * hy + nz * hz < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      this.vert(ax, ay, az, nx, ny, nz, c); this.vert(cx, cy, cz, nx, ny, nz, c); this.vert(bx, by, bz, nx, ny, nz, c);
    } else {
      this.vert(ax, ay, az, nx, ny, nz, c); this.vert(bx, by, bz, nx, ny, nz, c); this.vert(cx, cy, cz, nx, ny, nz, c);
    }
  }
  /** Quad a-b-c-d (in order around the edge) split into two triangles, oriented by hint. */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, c: number, hx = 0, hy = 1, hz = 0) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, c, hx, hy, hz);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, c, hx, hy, hz);
  }
  /** Vertical wall from (ax,az) to (bx,bz), bottom ya0/yb0, top ya1/yb1, facing (outward) side hint. */
  wall(ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number, c: number, hx: number, hz: number) {
    if (this.rec && this.recDepth === 0) this.rec.wall(ax, az, bx, bz, ya0, ya1, yb0, yb1, hx, hz);
    this.quad(ax, ya0, az, bx, yb0, bz, bx, yb1, bz, ax, ya1, az, c, hx, 0, hz);
  }
  /** Axis-aligned box (no bottom face). sideC defaults to c. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, sideC = c) {
    if (this.rec && this.recDepth === 0) this.rec.obox((x0 + x1) / 2, (z0 + z1) / 2, y0, y1, (x1 - x0) / 2, (z1 - z0) / 2, 1, 0);
    this.recDepth++;
    this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, c, 0, 1, 0);
    this.wall(x0, z1, x1, z1, y0, y1, y0, y1, sideC, 0, 1);
    this.wall(x1, z0, x0, z0, y0, y1, y0, y1, sideC, 0, -1);
    this.wall(x1, z1, x1, z0, y0, y1, y0, y1, sideC, 1, 0);
    this.wall(x0, z0, x0, z1, y0, y1, y0, y1, sideC, -1, 0);
    this.recDepth--;
  }
  /**
   * Box centred at (cx, cz), from y0 to y1, half extents hx (along heading) and hz (across), rotated so its local +x
   * points along (ux, uz). Optional bottom.
   */
  obox(cx: number, y0: number, cz: number, hx: number, hz: number, y1: number, ux: number, uz: number, c: number, sideC = c, bottom = false) {
    if (this.rec && this.recDepth === 0) this.rec.obox(cx, cz, y0, y1, hx, hz, ux, uz);
    this.recDepth++;
    const vx = -uz, vz = ux; // local +z
    const ax = cx - ux * hx - vx * hz, az = cz - uz * hx - vz * hz;
    const bx = cx + ux * hx - vx * hz, bz = cz + uz * hx - vz * hz;
    const qx = cx + ux * hx + vx * hz, qz = cz + uz * hx + vz * hz;
    const dx = cx - ux * hx + vx * hz, dz = cz - uz * hx + vz * hz;
    this.quad(ax, y1, az, bx, y1, bz, qx, y1, qz, dx, y1, dz, c, 0, 1, 0);
    if (bottom) this.quad(ax, y0, az, bx, y0, bz, qx, y0, qz, dx, y0, dz, c, 0, -1, 0);
    this.wall(ax, az, bx, bz, y0, y1, y0, y1, sideC, -vx, -vz);
    this.wall(bx, bz, qx, qz, y0, y1, y0, y1, sideC, ux, uz);
    this.wall(qx, qz, dx, dz, y0, y1, y0, y1, sideC, vx, vz);
    this.wall(dx, dz, ax, az, y0, y1, y0, y1, sideC, -ux, -uz);
    this.recDepth--;
  }
  /** Upright cylinder / cone frustum with flat-shaded sides (and a top cap if r1 > 0). */
  cyl(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, segs: number, c: number, cap = true) {
    const y1 = y0 + h;
    if (this.rec && this.recDepth === 0) this.rec.cyl(cx, cz, y0, y1, r0, r1);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const mx = (c0 + c1) / 2, mz = (s0 + s1) / 2;
      if (r1 > 0) this.quad(cx + c0 * r0, y0, cz + s0 * r0, cx + c1 * r0, y0, cz + s1 * r0, cx + c1 * r1, y1, cz + s1 * r1, cx + c0 * r1, y1, cz + s0 * r1, c, mx, 0, mz);
      else this.tri(cx + c0 * r0, y0, cz + s0 * r0, cx + c1 * r0, y0, cz + s1 * r0, cx, y1, cz, c, mx, 0.3, mz);
      if (cap && r1 > 0) this.tri(cx, y1, cz, cx + c0 * r1, y1, cz + s0 * r1, cx + c1 * r1, y1, cz + s1 * r1, c, 0, 1, 0);
    }
  }
  /** Pyramid (spire) on a square base centred at (cx,cz) with half size hs, rotated to axis (ux,uz). */
  pyramid(cx: number, y0: number, cz: number, hs: number, h: number, ux: number, uz: number, c: number) {
    if (this.rec && this.recDepth === 0) this.rec.obox(cx, cz, y0, y0 + h, hs, hs, ux, uz);
    const vx = -uz, vz = ux;
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + ux * a * hs + vx * b * hs, cz + uz * a * hs + vz * b * hs]);
    for (let i = 0; i < 4; i++) {
      const p = P[i], q = P[(i + 1) % 4];
      const mx = (p[0] + q[0]) / 2 - cx, mz = (p[1] + q[1]) / 2 - cz;
      this.tri(p[0], y0, p[1], q[0], y0, q[1], cx, y0 + h, cz, c, mx, 0.2, mz);
    }
  }
  get tris() { return this.n / 3; }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    if (this.ex) g.setAttribute('aFac', new THREE.BufferAttribute(this.ex.slice(0, n * 4), 4, false));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ------------------------------------------------------------------------------------------ render chunks
export type Layer = 'ground' | 'decal' | 'facade' | 'detail';
export const LAYERS: Layer[] = ['ground', 'decal', 'facade', 'detail'];

/** Render buckets: one MeshBuf per (layer, chunk). Whole objects go into the chunk of a reference point. */
export class RenderChunks {
  readonly size: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  bufs = new Map<string, MeshBuf>();
  /** Audit mode recorder shared by every buffer except decals (null = off). */
  rec: SolidRecorder | null = null;
  constructor(size: number, bounds: { x0: number; z0: number; x1: number; z1: number }, margin: number) {
    this.size = size;
    this.x0 = bounds.x0 - margin;
    this.z0 = bounds.z0 - margin;
    this.nx = Math.ceil((bounds.x1 - bounds.x0 + 2 * margin) / size);
    this.nz = Math.ceil((bounds.z1 - bounds.z0 + 2 * margin) / size);
  }
  key(x: number, z: number) {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.size)));
    const j = Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.z0) / this.size)));
    return j * this.nx + i;
  }
  buf(layer: Layer, x: number, z: number): MeshBuf {
    const k = `${layer}:${this.key(x, z)}`;
    let b = this.bufs.get(k);
    if (!b) {
      this.bufs.set(k, (b = new MeshBuf(layer === 'facade', layer === 'facade')));
      if (layer !== 'decal') b.rec = this.rec;
    }
    return b;
  }
  /** Audit mode: the kind stamped on what is drawn from now on (no-op when the recorder is off). */
  tag(kind: SolidKind): void {
    if (this.rec) this.rec.tag(kind);
  }
}

// ------------------------------------------------------------------------------------------ physics chunks
/** Positions-only triangle soup for a trimesh collider. */
export class PhysBuf {
  pos = new Float32Array(3 * 1024);
  n = 0;
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    if ((this.n + 3) * 3 > this.pos.length) { const p = new Float32Array(this.pos.length * 2); p.set(this.pos); this.pos = p; }
    const o = this.n * 3;
    const P = this.pos;
    P[o] = ax; P[o + 1] = ay; P[o + 2] = az; P[o + 3] = bx; P[o + 4] = by; P[o + 5] = bz; P[o + 6] = cx; P[o + 7] = cy; P[o + 8] = cz;
    this.n += 3;
  }
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
  }
}

/**
 * Static colliders grouped into one fixed body per physics chunk (like the grid city: a single body with thousands of
 * colliders made the player's CCD expensive). Triangles collect per chunk and kind and become one trimesh each
 * (terrain + roads, stair ramps, parapets...). Every collider is tagged with its solid kind (solidKinds.ts).
 */
export class PhysChunks {
  readonly R: typeof RAPIER;
  readonly world: RAPIER.World;
  readonly size: number;
  bodies = new Map<number, RAPIER.RigidBody>();
  tris = new Map<number, PhysBuf>();
  /** chunk key per trimesh buffer key */
  private trisChunk = new Map<number, number>();
  /** kind per trimesh buffer key */
  private trisKind = new Map<number, SolidKind>();
  private kindSlots = new Map<SolidKind, number>();
  colliders = 0;
  /** Collider handle -> solid kind (read by the audit and the F4 view). */
  readonly tags = new SolidTags();
  constructor(R: typeof RAPIER, world: RAPIER.World, size: number) {
    this.R = R;
    this.world = world;
    this.size = size;
  }
  private key(x: number, z: number) {
    return (Math.floor(x / this.size) + 1000) * 4096 + (Math.floor(z / this.size) + 1000);
  }
  body(x: number, z: number): RAPIER.RigidBody {
    const k = this.key(x, z);
    let b = this.bodies.get(k);
    if (!b) this.bodies.set(k, (b = this.world.createRigidBody(this.R.RigidBodyDesc.fixed())));
    return b;
  }
  /** Ground triangles near (x,z) (they become part of that chunk's ground trimesh). */
  ground(x: number, z: number): PhysBuf {
    return this.trimesh(x, z, 'ground');
  }
  /** Triangles of one kind near (x, z): one trimesh per chunk and kind. */
  trimesh(x: number, z: number, kind: SolidKind): PhysBuf {
    const ck = this.key(x, z);
    let slot = this.kindSlots.get(kind);
    if (slot === undefined) this.kindSlots.set(kind, (slot = this.kindSlots.size));
    const k = ck * 64 + slot;
    let b = this.tris.get(k);
    if (!b) {
      this.tris.set(k, (b = new PhysBuf()));
      this.trisChunk.set(k, ck);
      this.trisKind.set(k, kind);
    }
    return b;
  }
  private add(desc: RAPIER.ColliderDesc, x: number, z: number, kind: SolidKind, friction = 0.7): RAPIER.Collider {
    const c = this.world.createCollider(desc.setFriction(friction).setCollisionGroups(GROUPS.static), this.body(x, z));
    this.tags.set(c.handle, kind);
    this.colliders++;
    return c;
  }
  /** Oriented box: centre (cx, cy, cz), half extents (hx along (ux,uz), hy up, hz across). */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, ux = 1, uz = 0, kind: SolidKind = 'untagged') {
    const yaw = Math.atan2(-uz, ux);
    const d = this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    this.add(d, cx, cz, kind);
  }
  /** Vertical prism over a convex footprint (x, z pairs), from y0 to y1: a convex hull collider. */
  prism(pts: ArrayLike<number>, y0: number, y1: number, kind: SolidKind = 'untagged') {
    const n = pts.length / 2;
    const v = new Float32Array(n * 6);
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      v[i * 6] = pts[i * 2]; v[i * 6 + 1] = y0; v[i * 6 + 2] = pts[i * 2 + 1];
      v[i * 6 + 3] = pts[i * 2]; v[i * 6 + 4] = y1; v[i * 6 + 5] = pts[i * 2 + 1];
      cx += pts[i * 2] / n; cz += pts[i * 2 + 1] / n;
    }
    const d = this.R.ColliderDesc.convexHull(v);
    if (d) this.add(d, cx, cz, kind);
    return !!d;
  }
  /** Convex hull of arbitrary points (x, y, z triples): ramps under steps, rails, canopies. */
  hull(pts: ArrayLike<number>, kind: SolidKind): boolean {
    const n = pts.length / 3;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 3] / n; cz += pts[i * 3 + 2] / n; }
    const d = this.R.ColliderDesc.convexHull(pts instanceof Float32Array ? pts : Float32Array.from(pts));
    if (d) this.add(d, cx, cz, kind);
    return !!d;
  }
  cylinder(cx: number, y0: number, cz: number, r: number, h: number, kind: SolidKind = 'untagged') {
    this.add(this.R.ColliderDesc.cylinder(h / 2, r).setTranslation(cx, y0 + h / 2, cz), cx, cz, kind);
  }
  /** Build every accumulated trimesh. Returns the number of triangles. */
  finishTrimeshes(): number {
    let total = 0;
    for (const [k, b] of this.tris) {
      if (b.n < 3) continue;
      const verts = b.pos.slice(0, b.n * 3);
      const idx = new Uint32Array(b.n);
      for (let i = 0; i < b.n; i++) idx[i] = i;
      const d = this.R.ColliderDesc.trimesh(verts, idx, 0 as RAPIER.TriMeshFlags);
      const ck = this.trisChunk.get(k)!;
      const x = (Math.floor(ck / 4096) - 1000 + 0.5) * this.size, z = ((ck % 4096) - 1000 + 0.5) * this.size;
      this.add(d, x, z, this.trisKind.get(k)!, 0.9);
      total += b.n / 3;
    }
    this.tris.clear();
    this.trisChunk.clear();
    this.trisKind.clear();
    return total;
  }
}
