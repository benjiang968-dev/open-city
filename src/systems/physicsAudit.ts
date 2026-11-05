// Physics audit (tests only): compares what the world DRAWS with what Rapier REPORTS there, per solid kind.
// Loaded on demand when the URL has ?physaudit=1 (the map then records every drawn box, cylinder and wall with its
// kind, see SolidRecorder); scripts/scenarios.mjs `physaudit` runs it and prints the mismatches with coordinates.
//
// Three checks:
//  1. Side probes: for every drawn solid primitive (recorded boxes / cylinders / walls), every instanced prop (body
//     part of its own geometry) and every building footprint edge, a horizontal ray from 1.2 m outside toward the
//     drawn face, at a height the player's body reaches. The hit must be at the drawn face (+- the kind's tolerance):
//     MISSING = nothing there (walk through), SHORT = collider set back (walk into it), LONG = invisible wall.
//  2. Surfaces: vertical rays at sample points (random over the map, inside every solid primitive, along every
//     stair) against the drawn triangles (upward faces, from the render meshes) and against Rapier, level by level:
//     UNSOLID = something drawn within reach above the physics floor (you sink into or walk through it), UNDRAWN =
//     a physics floor with nothing drawn at it (an invisible step or ledge).
//  3. Stairs: per stair, the largest drawn-vs-physics height difference on the flights and the largest jump in the
//     physics surface between samples 0.1 m apart (must stay under the character's autostep).
// No part of this runs in the game; allocation does not matter here.
import * as THREE from 'three';
import type { World } from '../world';
import { G, groups } from '../physicsGroups';
import { REC, REC_STRIDE, SOLID_KINDS, solidKindId, solidKindName, type SolidKind } from './objects/solidKinds';

const STATIC_ONLY = groups(0xffff, G.STATIC);
const OUT = 1.2; // m: probe rays start this far outside the drawn face
const MAX_EXAMPLES = 10;

interface KindStats {
  probes: number; ok: number; missing: number; short: number; long: number; occluded: number; unreachable: number;
  worstLong: number; worstShort: number; examples: string[];
}
interface SurfStats { samples: number; ok: number; unsolid: number; undrawn: number; worst: number; examples: string[] }

export interface AuditOptions {
  /** Random surface samples over the map. */
  randomSamples?: number;
  /** At most this many recorded primitives probed per kind (deterministic stride). */
  maxPerKind?: number;
}

export interface AuditReport {
  map: string;
  records: number;
  colliders: number;
  taggedColliders: Record<string, number>;
  probes: Record<string, KindStats>;
  surfaces: Record<string, SurfStats>;
  stairs: { name: string; length: number; rise: number; samples: number; maxVisualDev: number; maxPhysStep: number; physMinusVisual: [number, number] }[];
  /** Mismatch totals over solid kinds (side probes: missing + short + long; surfaces: unsolid + undrawn). */
  totals: { probeMismatches: number; surfaceMismatches: number; untaggedProbed: number };
  ms: number;
}

// ================================================================================================ triangle grid
/** Upward-facing drawn triangles bucketed on a 4 m grid, for vertical ray tests (y of every face over a point). */
class TriGrid {
  readonly cell = 4;
  x0: number; z0: number; nx: number; nz: number;
  tri: Float32Array; // 9 floats per triangle
  nTri = 0;
  kind: Int16Array; // solid kind id per triangle (-1: from a merged chunk mesh)
  start: Int32Array;
  items: Int32Array;
  constructor(meshes: { pos: Float32Array; kind: number }[], x0: number, z0: number, x1: number, z1: number) {
    this.x0 = x0; this.z0 = z0;
    this.nx = Math.ceil((x1 - x0) / this.cell) + 1;
    this.nz = Math.ceil((z1 - z0) / this.cell) + 1;
    let total = 0;
    for (const m of meshes) total += m.pos.length / 9;
    this.tri = new Float32Array(total * 9);
    this.kind = new Int16Array(total);
    for (const m of meshes) {
      const P = m.pos;
      for (let o = 0; o + 8 < P.length; o += 9) {
        const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
        const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
        const ny = uz * vx - ux * vz;
        const L = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
        if (L < 1e-9 || ny / L < 0.2) continue; // vertical or facing down
        this.tri.set(P.subarray(o, o + 9), this.nTri * 9);
        this.kind[this.nTri] = m.kind;
        this.nTri++;
      }
    }
    const count = new Int32Array(this.nx * this.nz + 1);
    this.forCells((c) => { count[c]++; });
    this.start = new Int32Array(this.nx * this.nz + 1);
    for (let c = 0; c < this.nx * this.nz; c++) this.start[c + 1] = this.start[c] + count[c];
    this.items = new Int32Array(this.start[this.nx * this.nz]);
    const fill = this.start.slice();
    this.forCells((c, t) => { this.items[fill[c]++] = t; });
  }
  private forCells(cb: (cell: number, tri: number) => void) {
    const T = this.tri;
    for (let t = 0; t < this.nTri; t++) {
      const o = t * 9;
      const minX = Math.min(T[o], T[o + 3], T[o + 6]), maxX = Math.max(T[o], T[o + 3], T[o + 6]);
      const minZ = Math.min(T[o + 2], T[o + 5], T[o + 8]), maxZ = Math.max(T[o + 2], T[o + 5], T[o + 8]);
      const i0 = Math.max(0, Math.floor((minX - this.x0) / this.cell)), i1 = Math.min(this.nx - 1, Math.floor((maxX - this.x0) / this.cell));
      const j0 = Math.max(0, Math.floor((minZ - this.z0) / this.cell)), j1 = Math.min(this.nz - 1, Math.floor((maxZ - this.z0) / this.cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cb(j * this.nx + i, t);
    }
  }
  /** Heights of every upward face over (x, z), descending, with the kind id of each. */
  heightsAt(x: number, z: number, out: { y: number; kind: number }[]): void {
    out.length = 0;
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return;
    const c = j * this.nx + i, T = this.tri;
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const t = this.items[k], o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push({ y: l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7], kind: this.kind[t] });
    }
    out.sort((a, b) => b.y - a.y);
  }
}

// ================================================================================================ the audit
export function runPhysicsAudit(w: World, opts: AuditOptions = {}): AuditReport {
  const t0 = performance.now();
  const R = w.R, physics = w.physics, city = w.city;
  const tags = city.solidTags, rec = city.solidRecorder;
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const kindOfCollider = (h: number) => {
    const k = tags.get(h);
    if (k >= 0) return solidKindName(k);
    const owner = w.colliderOwner.get(h);
    return owner ? (owner.kind === 'ped' ? 'person' : 'vehicle') : 'item';
  };
  const castDown = (x: number, y: number, z: number, max: number, solid: boolean) => {
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
    ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    return physics.castRayAndGetNormal(ray, max, solid, undefined, STATIC_ONLY);
  };
  /** Top physics floor under (x, z) starting at y (NaN if none). */
  const floorAt = (x: number, z: number, y: number) => {
    const h = castDown(x, y, z, 400, true);
    return h ? y - h.timeOfImpact : NaN;
  };
  const castH = (x: number, y: number, z: number, dx: number, dz: number, max: number) => {
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
    ray.dir.x = dx; ray.dir.y = 0; ray.dir.z = dz;
    return physics.castRay(ray, max, true, undefined, STATIC_ONLY);
  };

  // drawn meshes (merged chunks and solid instanced props) for checking a suspected invisible collider: is something
  // drawn where the ray hit it?
  const drawn: THREE.Object3D[] = [];
  w.scene.updateMatrixWorld(true);
  w.scene.traverse((o) => {
    const kind = o.userData.solidKind as string | undefined;
    if (/^(geo-(ground|detail|facade)-|grid-(ground|buildings|props|seafloor)$)/.test(o.name) || (kind && kind !== 'tree' && SOLID_KINDS[kind as SolidKind]?.solid)) drawn.push(o);
  });
  const caster = new THREE.Raycaster();
  const cO = new THREE.Vector3(), cD = new THREE.Vector3();
  const drawnAt = (x: number, y: number, z: number, dx: number, dz: number, t: number, tol: number) => {
    cO.set(x, y, z); cD.set(dx, 0, dz).normalize();
    caster.set(cO, cD);
    caster.far = t + tol + 0.05;
    const hits = caster.intersectObjects(drawn, false);
    return hits.length > 0 && Math.abs(hits[0].distance - t) <= tol + 0.03;
  };

  // ---------------------------------------------------------------------------------------- side probes
  const probes: Record<string, KindStats> = {};
  const stat = (k: string): KindStats => (probes[k] ??= { probes: 0, ok: 0, missing: 0, short: 0, long: 0, occluded: 0, unreachable: 0, worstLong: 0, worstShort: 0, examples: [] });
  const f2 = (v: number) => v.toFixed(2);
  /**
   * One face: drawn face at distance `dist` from (cx, cz) along (nx, nz), drawn from y0 to y1. Probes at a height the
   * body reaches above the floor in front of the face.
   */
  const probeFace = (kind: string, cx: number, cz: number, nx: number, nz: number, dist0: number, y0: number, y1: number, label: string, ownR = Infinity, distTop = dist0, self = -1) => {
    let dist = dist0;
    const def = SOLID_KINDS[kind as SolidKind] ?? SOLID_KINDS.untagged;
    const S = stat(kind);
    const fx = cx + nx * (dist + 0.6), fz = cz + nz * (dist + 0.6);
    const floor = floorAt(fx, fz, y1 + 0.6);
    if (floor !== floor || floor > y1 + 0.55) { S.unreachable++; return; } // nothing to stand on / covered
    const lo = Math.max(y0, floor) + Math.min(0.05, (y1 - y0) / 3), hi = Math.min(y1, floor + def.band) - 0.02;
    if (hi - lo < 0.005) { S.unreachable++; return; }
    const yp = lo + Math.min(0.3, (hi - lo) / 2);
    if (distTop !== dist0 && y1 > y0) dist = dist0 + (distTop - dist0) * Math.min(1, Math.max(0, (yp - y0) / (y1 - y0))); // a tapered cylinder
    const ox = cx + nx * (dist + OUT), oz = cz + nz * (dist + OUT);
    S.probes++;
    const inside = castH(ox, yp, oz, -nx, -nz, 0.001);
    if (inside && inside.timeOfImpact === 0) { S.occluded++; S.probes--; return; }
    const hit = castH(ox, yp, oz, -nx, -nz, OUT + dist * 2 + 0.6);
    const where = `${label} @(${f2(ox - nx * OUT)}, ${f2(yp)}, ${f2(oz - nz * OUT)}) n(${f2(nx)},${f2(nz)})`;
    const note = (msg: string) => { if (S.examples.length < MAX_EXAMPLES) S.examples.push(`${msg} ${where}`); };
    if (!hit) { S.missing++; note('MISSING'); return; }
    const dev = OUT - hit.timeOfImpact; // + = the collider sticks out beyond the drawn face
    const hk = kindOfCollider(hit.collider.handle);
    if (dev > def.tol) {
      if (hk !== kind && hk !== 'untagged') { S.occluded++; S.probes--; return; } // something else stands in front
      // the collider matches another drawn part there (a pier's cutwater in front of the pier): not invisible
      const t = hit.timeOfImpact;
      if (explained(ox - nx * t, yp, oz - nz * t, self) || drawnAt(ox, yp, oz, -nx, -nz, t, def.tol)) { S.occluded++; S.probes--; return; }
      if (hit.collider.shapeType() !== R.ShapeType.TriMesh) {
        const ct = hit.collider.translation();
        // a neighbour of the same kind (two trees side by side): its centre is not this object's
        if (Math.hypot(ct.x - cx, ct.z - cz) > Math.min(dist + 0.5, ownR) && kind !== 'building' && kind !== 'boundary') { S.occluded++; S.probes--; return; }
      }
      S.long++; S.worstLong = Math.max(S.worstLong, dev); note(`LONG ${f2(dev)} (${hk})`);
    } else if (dev < -def.tol) {
      if (-dev > dist * 2 + 0.3) { S.missing++; note(`MISSING (ray went through, hit ${hk} ${f2(-dev)} m in)`); return; }
      S.short++; S.worstShort = Math.max(S.worstShort, -dev); note(`SHORT ${f2(-dev)} (${hk})`);
    } else S.ok++;
  };
  const probeObox = (kind: string, cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, ux: number, uz: number, label: string, ownR = Infinity, self = -1) => {
    const vx = -uz, vz = ux;
    probeFace(kind, cx, cz, ux, uz, hx, y0, y1, label, ownR, hx, self);
    probeFace(kind, cx, cz, -ux, -uz, hx, y0, y1, label, ownR, hx, self);
    probeFace(kind, cx, cz, vx, vz, hz, y0, y1, label, ownR, hz, self);
    probeFace(kind, cx, cz, -vx, -vz, hz, y0, y1, label, ownR, hz, self);
  };
  const probeCyl = (kind: string, cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, label: string, self: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2;
      probeFace(kind, cx, cz, Math.cos(a), Math.sin(a), Math.max(0.01, r0), y0, y1, label, Infinity, Math.max(0.01, r1), self);
    }
  };
  const isSolid = (kind: string) => kind === 'untagged' || (SOLID_KINDS[kind as SolidKind]?.solid ?? false);

  // recorded primitives
  let untaggedProbed = 0;
  const recs = rec ? rec.n : 0;
  const recIdx = new Map<number, number[]>();
  if (rec) for (let i = 0; i < rec.n; i++) { const k = rec.data[i * REC_STRIDE + 1]; let l = recIdx.get(k); if (!l) recIdx.set(k, (l = [])); l.push(i); }
  const maxPer = opts.maxPerKind ?? 2500;
  // drawn solid primitives on an 8 m grid: is a point on (or in) some drawn solid part?
  const RC = 8, cells = new Map<number, number[]>();
  const ckey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  if (rec) for (let i = 0; i < rec.n; i++) {
    const o = i * REC_STRIDE, D = rec.data;
    if (!isSolid(solidKindName(D[o + 1]))) continue;
    let x0: number, x1: number, z0: number, z1: number;
    if (D[o] === REC.WALL) { x0 = Math.min(D[o + 2], D[o + 4]); x1 = Math.max(D[o + 2], D[o + 4]); z0 = Math.min(D[o + 3], D[o + 5]); z1 = Math.max(D[o + 3], D[o + 5]); }
    else { const r = D[o] === REC.CYL ? Math.max(D[o + 6], D[o + 7]) : Math.hypot(D[o + 6], D[o + 7]); x0 = D[o + 2] - r; x1 = D[o + 2] + r; z0 = D[o + 3] - r; z1 = D[o + 3] + r; }
    if (x1 - x0 > 400 || z1 - z0 > 400) continue;
    for (let a = Math.floor(x0 / RC); a <= Math.floor(x1 / RC); a++) for (let c = Math.floor(z0 / RC); c <= Math.floor(z1 / RC); c++) {
      const k = ckey(a, c);
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(i);
    }
  }
  const explained = (x: number, y: number, z: number, self: number) => {
    const l = cells.get(ckey(Math.floor(x / RC), Math.floor(z / RC)));
    if (!l || !rec) return false;
    const e = 0.06, D = rec.data;
    for (const i of l) {
      if (i === self) continue;
      const o = i * REC_STRIDE;
      if (D[o] === REC.WALL) {
        const ax = D[o + 2], az = D[o + 3], dx = D[o + 4] - ax, dz = D[o + 5] - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2));
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) > e) continue;
        const yb = D[o + 6] + (D[o + 8] - D[o + 6]) * t, yt = D[o + 7] + (D[o + 9] - D[o + 7]) * t;
        if (y >= yb - e && y <= yt + e) return true;
        continue;
      }
      if (y < D[o + 4] - e || y > D[o + 5] + e) continue;
      const dx = x - D[o + 2], dz = z - D[o + 3];
      if (D[o] === REC.CYL) { if (Math.hypot(dx, dz) <= Math.max(D[o + 6], D[o + 7]) + e) return true; continue; }
      const ux = D[o + 8], uz = D[o + 9];
      if (Math.abs(dx * ux + dz * uz) <= D[o + 6] + e && Math.abs(-dx * uz + dz * ux) <= D[o + 7] + e) return true;
    }
    return false;
  };
  for (const [kid, list] of recIdx) {
    const kind = solidKindName(kid);
    if (!isSolid(kind)) continue;
    const step = Math.max(1, Math.ceil(list.length / maxPer));
    for (let q = 0; q < list.length; q += step) {
      const o = list[q] * REC_STRIDE, D = rec!.data;
      if (kind === 'untagged') untaggedProbed++;
      if (D[o] === REC.OBOX) probeObox(kind, D[o + 2], D[o + 3], D[o + 4], D[o + 5], D[o + 6], D[o + 7], D[o + 8], D[o + 9], `${kind} box`, Infinity, list[q]);
      else if (D[o] === REC.CYL) probeCyl(kind, D[o + 2], D[o + 3], D[o + 4], D[o + 5], D[o + 6], D[o + 7], `${kind} cyl`, list[q]);
      else {
        const ax = D[o + 2], az = D[o + 3], bx = D[o + 4], bz = D[o + 5];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.2) continue;
        let nx = D[o + 10], nz = D[o + 11];
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        for (const t of L > 3 ? [0.25, 0.5, 0.75] : [0.5]) {
          const y0 = D[o + 6] + (D[o + 8] - D[o + 6]) * t, y1 = D[o + 7] + (D[o + 9] - D[o + 7]) * t;
          probeFace(kind, ax + (bx - ax) * t, az + (bz - az) * t, nx, nz, 0, y0, y1, `${kind} wall`, Infinity, 0, list[q]);
        }
      }
    }
  }
  // instanced props (and single meshes with a kind, the grid's boats): horizontal rays at the drawn triangles of each
  // instance's own geometry (the part the body reaches) and at Rapier, so open shapes (a bus shelter's front, the
  // space under a bench's back) are judged by what is really drawn
  const instKinds: { mesh: THREE.InstancedMesh; kind: string }[] = [];
  const single: { mesh: THREE.Mesh; kind: string }[] = [];
  w.scene.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    const kind = o.userData.solidKind as string | undefined;
    if (!kind || !isSolid(kind)) return;
    if (im.isInstancedMesh) instKinds.push({ mesh: im, kind });
    else if ((o as THREE.Mesh).isMesh) single.push({ mesh: o as THREE.Mesh, kind });
  });
  {
    const m = new THREE.Matrix4(), mi = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const lr = new THREE.Ray(), tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), hitP = new THREE.Vector3(), o3 = new THREE.Vector3(), d3 = new THREE.Vector3();
    w.scene.updateMatrixWorld(true);
    const all = [...instKinds.map((e) => ({ ...e, n: e.mesh.count, inst: true })), ...single.map((e) => ({ mesh: e.mesh as THREE.InstancedMesh, kind: e.kind, n: 1, inst: false }))];
    for (const { mesh, kind, n, inst } of all) {
      const def = SOLID_KINDS[kind as SolidKind] ?? SOLID_KINDS.untagged;
      const S = stat(kind);
      const g = mesh.geometry, pos = g.getAttribute('position'), idx = g.getIndex();
      const nT = (idx ? idx.count : pos.count) / 3;
      const V = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
      const step = Math.max(1, Math.ceil(n / maxPer));
      for (let i = 0; i < n; i += step) {
        if (inst) { mesh.getMatrixAt(i, m); m.premultiply(mesh.matrixWorld); } else m.copy(mesh.matrixWorld);
        m.decompose(p, q, sc);
        if (sc.x === 0) continue;
        mi.copy(m).invert();
        const lim = def.band / sc.y;
        // the body part: triangles that start below the band (a trunk, not the crown)
        const tris: number[] = [];
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, yTop = -Infinity;
        for (let t = 0; t < nT; t++) {
          const a = V(t, 0), b2 = V(t, 1), c = V(t, 2);
          if (Math.min(pos.getY(a), pos.getY(b2), pos.getY(c)) > lim) continue;
          tris.push(a, b2, c);
          for (const v of [a, b2, c]) {
            const x = pos.getX(v), z = pos.getZ(v), y = Math.min(pos.getY(v), lim);
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y > yTop) yTop = y;
          }
        }
        if (!tris.length) continue;
        const visualHit = (ox: number, oy: number, oz: number, dx: number, dz: number) => {
          o3.set(ox, oy, oz).applyMatrix4(mi);
          d3.set(ox + dx, oy, oz + dz).applyMatrix4(mi).sub(o3);
          lr.set(o3, d3.normalize());
          let best = Infinity;
          for (let k = 0; k < tris.length; k += 3) {
            tA.fromBufferAttribute(pos, tris[k]); tB.fromBufferAttribute(pos, tris[k + 1]); tC.fromBufferAttribute(pos, tris[k + 2]);
            if (!lr.intersectTriangle(tA, tB, tC, false, hitP)) continue;
            hitP.applyMatrix4(m);
            const dd = Math.hypot(hitP.x - ox, hitP.y - oy, hitP.z - oz);
            if (dd < best) best = dd;
          }
          return best;
        };
        const ux = m.elements[0] / sc.x, uz = m.elements[2] / sc.x; // local +x in world (unit)
        const vx = m.elements[8] / sc.z, vz = m.elements[10] / sc.z; // local +z
        const cxl = (x0 + x1) / 2, czl = (z0 + z1) / 2;
        const cx = p.x + ux * cxl * sc.x + vx * czl * sc.z, cz = p.z + uz * cxl * sc.x + vz * czl * sc.z;
        const hx = ((x1 - x0) / 2) * sc.x, hz = ((z1 - z0) / 2) * sc.z;
        const yTopW = p.y + yTop * sc.y;
        for (const [dx, dz, ext, ax, az, across] of [[ux, uz, hx, vx, vz, hz], [-ux, -uz, hx, vx, vz, hz], [vx, vz, hz, ux, uz, hx], [-vx, -vz, hz, ux, uz, hx]] as number[][]) {
          const floor = floorAt(cx + dx * (ext + 0.6), cz + dz * (ext + 0.6), yTopW + 0.6);
          if (floor !== floor || floor > yTopW + 0.5) { S.unreachable++; continue; }
          const lo = Math.max(p.y, floor) + 0.05, hi = Math.min(yTopW, floor + def.band) - 0.02;
          if (hi < lo) { S.unreachable++; continue; }
          for (const yp of hi - lo > 0.5 ? [lo + 0.25, Math.min(hi, lo + 0.9)] : [(lo + hi) / 2]) {
            for (const lat of [-0.6, 0, 0.6]) {
              const ox = cx + dx * (ext + OUT) + ax * across * lat, oz = cz + dz * (ext + OUT) + az * across * lat;
              const where = `${kind} #${i} @(${f2(ox - dx * OUT)}, ${f2(yp)}, ${f2(oz - dz * OUT)}) n(${f2(dx)},${f2(dz)})`;
              const note = (msg: string) => { if (S.examples.length < MAX_EXAMPLES) S.examples.push(`${msg} ${where}`); };
              const inside = castH(ox, yp, oz, -dx, -dz, 0.001);
              if (inside && inside.timeOfImpact === 0) { S.occluded++; continue; }
              const tv = visualHit(ox, yp, oz, -dx, -dz);
              const max = OUT + ext * 2 + 0.3;
              const hit = castH(ox, yp, oz, -dx, -dz, max);
              const tp = hit ? hit.timeOfImpact : Infinity;
              const mine = hit ? kindOfCollider(hit.collider.handle) === kind : false;
              const ct = hit && hit.collider.shapeType() !== R.ShapeType.TriMesh ? hit.collider.translation() : null;
              const own = !ct || !POSTS.has(kind) || Math.hypot(ct.x - p.x, ct.z - p.z) < 0.15;
              if (tv === Infinity) {
                // nothing drawn on this line: only a collider of this very prop there is wrong (an invisible part)
                if (hit && mine && own && tp < OUT + ext * 2 - def.tol) { S.probes++; S.long++; S.worstLong = Math.max(S.worstLong, ext * 2 + OUT - tp); note(`LONG (nothing drawn) ${f2(OUT + ext * 2 - tp)}`); }
                continue;
              }
              S.probes++;
              const dev = tv - tp; // + = the collider is in front of the drawn surface
              if (Math.abs(dev) <= def.tol) { S.ok++; continue; }
              if (dev > 0) {
                if (!mine || !own) { S.occluded++; S.probes--; continue; }
                S.long++; S.worstLong = Math.max(S.worstLong, dev); note(`LONG ${f2(dev)}`);
              } else if (tp === Infinity || tp > tv + ext * 2) { S.missing++; note(tp === Infinity ? 'MISSING' : `MISSING (went through, hit ${hit ? kindOfCollider(hit.collider.handle) : '-'} ${f2(tp - tv)} m in)`); }
              else { S.short++; S.worstShort = Math.max(S.worstShort, -dev); note(`SHORT ${f2(-dev)}`); }
            }
          }
        }
      }
    }
  }
  // (buildings: their facade walls are recorded like any other drawn wall)

  // ---------------------------------------------------------------------------------------- surfaces
  const b = city.bounds;
  const vis: { pos: Float32Array; kind: number }[] = [];
  const KID = (k: SolidKind) => solidKindId(k);
  w.scene.updateMatrixWorld(true);
  w.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const im = o as THREE.InstancedMesh;
    const kind = mesh.userData.solidKind as string | undefined;
    const merged = /^(geo-(ground|detail|facade)-|grid-(ground|buildings|props|seafloor)$)/.test(mesh.name);
    if (!merged && !(im.isInstancedMesh && kind && isSolid(kind) && kind !== 'tree')) return;
    const src = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex();
    const nV = idx ? idx.count : src.count;
    const base = new Float32Array(nV * 3);
    for (let v = 0; v < nV; v++) { const s = idx ? idx.getX(v) : v; base[v * 3] = src.getX(s); base[v * 3 + 1] = src.getY(s); base[v * 3 + 2] = src.getZ(s); }
    const v3 = new THREE.Vector3();
    const emit = (mat: THREE.Matrix4, kid: number) => {
      const out = new Float32Array(base.length);
      for (let v = 0; v < nV; v++) {
        v3.set(base[v * 3], base[v * 3 + 1], base[v * 3 + 2]).applyMatrix4(mat);
        out[v * 3] = v3.x; out[v * 3 + 1] = v3.y; out[v * 3 + 2] = v3.z;
      }
      vis.push({ pos: out, kind: kid });
    };
    if (im.isInstancedMesh) {
      const m = new THREE.Matrix4(), mw = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); mw.multiplyMatrices(im.matrixWorld, m); emit(mw, KID(kind as SolidKind)); }
    } else emit(mesh.matrixWorld, -1);
  });
  const grid = new TriGrid(vis, b.minX - 20, b.minZ - 20, b.maxX + 20, b.maxZ + 20);
  const surfaces: Record<string, SurfStats> = {};
  const sstat = (k: string): SurfStats => (surfaces[k] ??= { samples: 0, ok: 0, unsolid: 0, undrawn: 0, worst: 0, examples: [] });
  const vh: { y: number; kind: number }[] = [];
  const floorTol = 0.06;
  /** Level by level down the physics column at (x, z); label: what the point was sampled for. */
  const surfaceAt = (x: number, z: number, label: string, tolOverride = 0) => {
    grid.heightsAt(x, z, vh);
    // ceilTol: how far the drawn surface of the floor above may lie below its collider (the treads under a stair's
    // ramp): drawn faces that close under the ceiling belong to it, not to the floor below
    let yTop = 300, ceiling = Infinity, ceilTol = 0.05;
    for (let level = 0; level < 8; level++) {
      const h = castDown(x, yTop, z, yTop + 50, true);
      if (!h) break;
      if (h.timeOfImpact === 0) {
        // started inside a solid shape (the box under the floor just checked): continue below it
        const e = castDown(x, yTop, z, yTop + 50, false);
        if (!e) break;
        ceiling = yTop - e.timeOfImpact;
        yTop = ceiling - 0.02;
        continue;
      }
      const y = yTop - h.timeOfImpact;
      if (h.normal.y < 0.2) { ceiling = y; yTop = y - 0.02; continue; } // an underside or a wall: keep going down
      const kind = kindOfCollider(h.collider.handle);
      // buildings and towers (roofs out of reach), thin posts and trunks are checked by the side probes
      if (NOT_FLOORS.has(kind)) break;
      const def = SOLID_KINDS[kind as SolidKind] ?? SOLID_KINDS.untagged;
      const tol = Math.max(floorTol, tolOverride, kind === 'stair' || kind === 'stoop' ? def.tol : 0);
      const S = sstat(label === 'random' ? kind : label);
      S.samples++;
      let near = Infinity;
      let unsolid: { y: number; kind: number } | null = null;
      for (const v of vh) {
        const d = v.y - y;
        if (Math.abs(d) < Math.abs(near)) near = d;
        if (d > tol && d < def.band && v.y < ceiling - ceilTol && (!unsolid || v.y > unsolid.y)) unsolid = v;
      }
      const where = `@(${f2(x)}, ${f2(y)}, ${f2(z)}) on ${kind}`;
      if (unsolid) {
        S.unsolid++;
        S.worst = Math.max(S.worst, unsolid.y - y);
        if (S.examples.length < MAX_EXAMPLES) S.examples.push(`UNSOLID drawn ${f2(unsolid.y - y)} m above the floor (${unsolid.kind >= 0 ? solidKindName(unsolid.kind) : 'chunk mesh'}) ${where}`);
      } else if (Math.abs(near) > tol) {
        S.undrawn++;
        if (Number.isFinite(near)) S.worst = Math.max(S.worst, Math.abs(near));
        if (S.examples.length < MAX_EXAMPLES) S.examples.push(`UNDRAWN nearest drawn face ${Number.isFinite(near) ? f2(near) : 'none'} ${where}`);
      } else S.ok++;
      ceiling = y;
      ceilTol = Math.max(0.05, tol);
      yTop = y - 0.3; // the next level down (under a deck); solid shapes start a new cast below this one
      if (kind === 'ground') break;
    }
  };
  // random points over the map (fixed sequence: same points every run)
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const nRand = opts.randomSamples ?? 3000;
  for (let i = 0; i < nRand; i++) {
    const x = b.minX + 2 + rnd() * (b.maxX - b.minX - 4), z = b.minZ + 2 + rnd() * (b.maxZ - b.minZ - 4);
    if (city.isWater(x, z)) continue;
    surfaceAt(x, z, 'random');
  }
  // inside every recorded solid box / cylinder (centre and four inner points)
  if (rec) {
    for (const [kid, list] of recIdx) {
      const kind = solidKindName(kid);
      if (!isSolid(kind) || kind === 'building' || kind === 'tower' || kind === 'bridgePier' || kind === 'column') continue;
      const step = Math.max(1, Math.ceil(list.length / Math.min(maxPer, 600)));
      for (let q = 0; q < list.length; q += step) {
        const o = list[q] * REC_STRIDE, D = rec.data;
        if (D[o] === REC.WALL) continue;
        const cx = D[o + 2], cz = D[o + 3];
        if (D[o] === REC.CYL) { surfaceAt(cx, cz, `in ${kind}`); continue; }
        const hx = D[o + 6], hz = D[o + 7], ux = D[o + 8], uz = D[o + 9];
        surfaceAt(cx, cz, `in ${kind}`);
        for (const [a, c] of [[0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]) {
          if (hx < 0.15 || hz < 0.15) break;
          surfaceAt(cx + ux * hx * a - uz * hz * c, cz + uz * hx * a + ux * hz * c, `in ${kind}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------- stairs
  const stairsOut: AuditReport['stairs'] = [];
  const geo = (city as unknown as { geo?: { stairs: { pts: [number, number][]; w: number; L: number; name: string | null; h: (s: number) => number; flights: [number, number][] }[] } }).geo;
  for (const st of geo?.stairs ?? []) {
    const cum = [0];
    for (let i = 1; i < st.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(st.pts[i][0] - st.pts[i - 1][0], st.pts[i][1] - st.pts[i - 1][1]));
    let maxDev = 0, maxStep = 0, n = 0, dMin = Infinity, dMax = -Infinity;
    for (const off of [-st.w / 3, -st.w / 6, st.w / 6, st.w / 3]) { // (not the centre line: the big stair's hand rail)
      let prev = NaN;
      for (let s = 0.05; s < st.L - 0.05; s += 0.1) {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < s) i++;
        const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        const ax = st.pts[i - 1][0], az = st.pts[i - 1][1], bx = st.pts[i][0], bz = st.pts[i][1];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        const x = ax + (bx - ax) * t - ((bz - az) / L) * off, z = az + (bz - az) * t + ((bx - ax) / L) * off;
        const top = st.h(s) + 1.2; // below a street bridge over the stair foot
        const hd = castDown(x, top, z, 30, true);
        // started inside something solid (a wall's coping where the stair turns): not a floor sample
        if (hd && hd.timeOfImpact === 0) { prev = NaN; continue; }
        const py = hd ? top - hd.timeOfImpact : NaN;
        grid.heightsAt(x, z, vh);
        // the drawn tread: the highest upward face within reach of the physics floor
        let vy = NaN;
        for (const v of vh) if (v.y < top && Math.abs(v.y - py) < 0.6 && !(Math.abs(v.y - py) >= Math.abs(vy - py))) vy = v.y;
        n++;
        if (vy === vy && py === py) {
          maxDev = Math.max(maxDev, Math.abs(py - vy));
          dMin = Math.min(dMin, py - vy); dMax = Math.max(dMax, py - vy);
        }
        if (prev === prev && py === py) maxStep = Math.max(maxStep, Math.abs(py - prev));
        prev = py;
      }
    }
    const rise = Math.abs(st.h(st.L) - st.h(0));
    stairsOut.push({ name: st.name ?? 'steps', length: +st.L.toFixed(1), rise: +rise.toFixed(2), samples: n, maxVisualDev: +maxDev.toFixed(3), maxPhysStep: +maxStep.toFixed(3), physMinusVisual: [+dMin.toFixed(3), +dMax.toFixed(3)] });
    // the stair surface also counts in the surface stats
    for (let s = 0.2; s < st.L - 0.2; s += 0.5) {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      const ax = st.pts[i - 1][0], az = st.pts[i - 1][1], bx = st.pts[i][0], bz = st.pts[i][1], L = Math.hypot(bx - ax, bz - az) || 1;
      const o = st.w / 4; // off the centre line (the big stair's hand rail runs down the middle)
      surfaceAt(ax + (bx - ax) * t - ((bz - az) / L) * o, az + (bz - az) * t + ((bx - ax) / L) * o, 'stair flight', 0.2);
    }
  }

  // ---------------------------------------------------------------------------------------- totals
  let probeMis = 0, surfMis = 0;
  for (const [k, s] of Object.entries(probes)) if (k !== 'untagged') probeMis += s.missing + s.short + s.long;
  for (const s of Object.values(surfaces)) surfMis += s.unsolid + s.undrawn;
  let colliders = 0;
  physics.colliders.forEach(() => { colliders++; });
  return {
    map: city.id, records: recs, colliders, taggedColliders: tags.counts(), probes, surfaces, stairs: stairsOut,
    totals: { probeMismatches: probeMis, surfaceMismatches: surfMis, untaggedProbed },
    ms: Math.round(performance.now() - t0),
  };
}

const POSTS = new Set(['tree', 'lamp', 'signalPole', 'signPost']);
/** Physics floors the surface check skips (side probes cover them; their tops are out of reach or tiny). */
const NOT_FLOORS = new Set(['boundary', 'building', 'tower', 'bridgePier', 'column', 'lamp', 'signalPole', 'signPost', 'tree', 'kiosk', 'container', 'monument', 'railing', 'stoopRail']);
