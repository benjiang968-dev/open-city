// Plan -> meshes and colliders for one building interior (plan.ts). Runs as a generator so the interior system can
// spread the work over frames (a few ms per frame): every `yield` is a point where it may stop until the next frame.
//
// Drawn (merged into three meshes per interior): the outer walls from inside with window openings and their reveals,
// partitions with doorways and casings, floors and ceilings per room (stairwells cut out), stair flights with treads,
// risers and balustrades, landing railings, furniture, window glass, and light fixtures. Colliders (one fixed body):
// the outer walls as boxes (the front one split round the door), partitions with gaps, floor slabs and the roof slab
// (stairwells cut out), stair ramps (solid to the floor where nothing passes under them, a sloped slab over a
// stairwell), balustrades, landing railings and substantial furniture. Doors are the doors system's (doors.ts).
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '../../world';
import { TUNING } from '../../tuning';
import { MeshBuf, lin, shade } from '../map/meshKit';
import { SURF, surf } from '../render/surfaces';
import { GROUPS } from '../../physicsGroups';
import { FURNITURE, type FurnDef, type FurnSurface } from '../../data/furniture';
import type { ItemId } from '../../art/items';
import { convexPieces } from '../map/facades';
import type { SolidKind } from '../objects/solidKinds';
import type { BuildingRecord, WallRec } from './records';
import { TILE_WINDOWS } from './records';
import { finishOf, type Plan, type PlanStair } from './plan';
import { clipHalf, hash32, pointIn, rng32, type P2 } from './geom';

const I = TUNING.interiors;

export interface ItemSlot { uid: string; type: ItemId; x: number; y: number; z: number; yaw: number }
export interface FloorPiece { y: number; holes: P2[][] }
export interface BuiltInterior {
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  group: THREE.Group;
  slots: ItemSlot[];
  levels: FloorPiece[];
  stairs: PlanStair[];
  tris: number;
  ms: number;
}
export interface InteriorMats { shell: THREE.Material; glass: THREE.Material; glow: THREE.Material }

const SURF_ID: Record<FurnSurface, number> = {
  WOOD: SURF.WOOD, METAL_PAINT: SURF.METAL_PAINT, METAL_BARE: SURF.METAL_BARE, STUCCO: SURF.STUCCO, CANVAS: SURF.CANVAS, STONE: SURF.STONE,
  CONCRETE: SURF.CONCRETE, TRIM: SURF.TRIM, RUBBER: SURF.RUBBER, NONE: SURF.NONE,
};
const tag = (s: FurnSurface | string, hex: number) => surf(SURF_ID[s as FurnSurface] ?? SURF.NONE, lin(hex));
const TRIM = tag('TRIM', 0xf2efe6);
const OAK_TREAD = tag('WOOD', 0x8a5e3a);
const CEIL = tag('STUCCO', 0xf4f2ec);
const IRON = tag('METAL_PAINT', 0x26292c);

/** Ramp height above a flight's foot at distance a along it (the line through the middle of every tread). */
export function rampAt(s: PlanStair, a: number): number {
  const t = s.run / (s.steps - 1), r = s.rise / s.steps;
  return Math.min(s.rise, r * (a / t + 0.5));
}

/**
 * Build one interior. Yields between pieces of work; returns the built interior (meshes added to `parent`, colliders
 * on a new fixed body tagged in the map's solid registry).
 */
export function* buildInterior(w: World, rec: BuildingRecord, plan: Plan, mats: InteriorMats, parent: THREE.Object3D): Generator<void, BuiltInterior> {
  const t0 = performance.now();
  const R = w.R, phys = w.physics, tags = w.city.solidTags;
  const shell = new MeshBuf(false, false, 8192);
  const glass = new MeshBuf(false, false, 512);
  const glow = new MeshBuf(false, false, 512);
  const body = phys.createRigidBody(R.RigidBodyDesc.fixed());
  const colliders: RAPIER.Collider[] = [];
  const add = (d: RAPIER.ColliderDesc | null, kind: SolidKind) => {
    if (!d) return;
    const c = phys.createCollider(d.setFriction(0.8).setCollisionGroups(GROUPS.static), body);
    tags.set(c.handle, kind);
    colliders.push(c);
  };
  const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, ux: number, uz: number, kind: SolidKind) => {
    if (hx < 0.005 || hy < 0.005 || hz < 0.005) return;
    const yaw = Math.atan2(-uz, ux);
    add(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }), kind);
  };
  const prism = (P: P2[], y0: number, y1: number, kind: SolidKind) => {
    if (P.length < 3) return;
    const v = new Float32Array(P.length * 6);
    P.forEach((p, i) => { v.set([p[0], y0, p[1], p[0], y1, p[1]], i * 6); });
    add(R.ColliderDesc.convexHull(v), kind);
  };
  const hull = (pts: number[], kind: SolidKind) => add(R.ColliderDesc.convexHull(Float32Array.from(pts)), kind);
  const L = plan.levels;
  const roomAt = (level: number, x: number, z: number) => plan.rooms.find((r) => r.level === level && pointIn(x, z, r.poly));
  const wallColAt = (level: number, x: number, z: number) => {
    const r = roomAt(level, x, z);
    const f = finishOf(r ? r.wall : 0);
    return tag(f.s, f.col);
  };
  /** A vertical face from (ax, az) along (ux, uz) between s0 and s1, y0..y1, facing (nx, nz); colour from the room in front. */
  const face = (level: number, ax: number, az: number, ux: number, uz: number, s0: number, s1: number, y0: number, y1: number, nx: number, nz: number, col?: number) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
    const px = ax + ux * s0, pz = az + uz * s0, qx = ax + ux * s1, qz = az + uz * s1;
    const c = col ?? wallColAt(level, (px + qx) / 2 + nx * 0.25, (pz + qz) / 2 + nz * 0.25);
    shell.wall(px, pz, qx, qz, y0, y1, y0, y1, c, nx, nz);
  };
  /** A wall face with rectangular openings ([s0, s1, y0, y1]) cut out, plus extra vertical split points. */
  const faceWithOpenings = (level: number, ax: number, az: number, ux: number, uz: number, S0: number, S1: number, Y0: number, Y1: number, nx: number, nz: number, ops: number[][], splits: number[]) => {
    const o = ops.filter((q) => q[1] > S0 + 0.01 && q[0] < S1 - 0.01).map((q) => [Math.max(S0, q[0]), Math.min(S1, q[1]), Math.max(Y0, q[2]), Math.min(Y1, q[3])]).sort((a, b) => a[0] - b[0]);
    const cuts = new Set<number>([S0, S1]);
    for (const q of o) { cuts.add(q[0]); cuts.add(q[1]); }
    for (const s of splits) if (s > S0 + 0.01 && s < S1 - 0.01) cuts.add(s);
    const xs = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = xs[i], b = xs[i + 1];
      if (b - a < 0.005) continue;
      const m = (a + b) / 2;
      const hole = o.find((q) => m > q[0] && m < q[1]);
      if (!hole) face(level, ax, az, ux, uz, a, b, Y0, Y1, nx, nz);
      else { face(level, ax, az, ux, uz, a, b, Y0, hole[2], nx, nz); face(level, ax, az, ux, uz, a, b, hole[3], Y1, nx, nz); }
    }
  };

  // ------------------------------------------------------------------------------------------- outer walls
  const P = rec.pts, n = P.length, inner = plan.inner;
  const door = rec.door!;
  const wallFor = (i: number): WallRec | undefined => {
    const p = P[i], q = P[(i + 1) % n];
    return rec.walls.find((x) => Math.hypot(x.ax - p[0], x.az - p[1]) < 1e-3 && Math.hypot(x.bx - q[0], x.bz - q[1]) < 1e-3);
  };
  const yBot = rec.y0 - 0.05, yTopC = rec.top;
  for (let i = 0; i < n; i++) {
    const wr = wallFor(i);
    const p = P[i], q = P[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.05) continue;
    const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
    // inward normal: toward the inner polygon
    let nx = -uz, nz = ux;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if (!pointIn(mx + nx * 0.2, mz + nz * 0.2, P)) { nx = -nx; nz = -nz; }
    const t = wr?.party ? I.partyWall : I.outerWall;
    const isFront = wr && rec.walls.indexOf(wr) === door.wall;
    // collision: one box per wall, the front one split round the door (left, right, lintel)
    const cx = mx + nx * t / 2, cz = mz + nz * t / 2;
    const yc = (yBot + yTopC) / 2, hy = (yTopC - yBot) / 2;
    if (!isFront) box(cx, yc, cz, len / 2, hy, t / 2, ux, uz, 'interiorWall');
    else {
      const sL = door.s - door.width / 2, sR = door.s + door.width / 2;
      const seg = (s0: number, s1: number, y0: number, y1: number) => {
        if (s1 - s0 < 0.01) return;
        const sm = (s0 + s1) / 2;
        box(p[0] + ux * sm + nx * t / 2, (y0 + y1) / 2, p[1] + uz * sm + nz * t / 2, (s1 - s0) / 2, (y1 - y0) / 2, t / 2, ux, uz, 'interiorWall');
      };
      seg(0, sL, yBot, yTopC); seg(sR, len, yBot, yTopC); seg(sL, sR, rec.y0 + door.height, yTopC);
    }
    // drawn: the inner face per level with windows (and the front door) cut out
    const A = inner[i], B = inner[(i + 1) % n];
    const ilen = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (ilen < 0.05) continue;
    const iux = (B[0] - A[0]) / ilen, iuz = (B[1] - A[1]) / ilen;
    const sA = (A[0] - p[0]) * ux + (A[1] - p[1]) * uz; // the inner face's start in the outer wall's s
    for (let k = 0; k < L.length; k++) {
      const lv = L[k];
      const ops: number[][] = [];
      if (wr) {
        for (const band of wr.bands) {
          const rows = band.rows, rh = (band.y1 - band.y0) / rows;
          for (let r = 0; r < rows; r++) {
            const yb = band.y0 + r * rh;
            if (yb < lv.y - 0.3 || yb >= lv.top - 0.3) continue;
            const wins = TILE_WINDOWS[band.tile];
            if (!wins) continue;
            const bw = (band.s1 - band.s0) / band.cols;
            for (let c = 0; c < band.cols; c++) {
              const ts = band.s0 + c * bw;
              for (const [x0, x1, v0, v1] of wins) {
                const flip = (wr.bz - wr.az) * wr.nx - (wr.bx - wr.ax) * wr.nz > 0;
                const s0 = flip ? ts + (1 - x1) * bw : ts + x0 * bw, s1 = flip ? ts + (1 - x0) * bw : ts + x1 * bw;
                let y0 = yb + v0 * rh, y1 = Math.min(yb + v1 * rh, lv.ceil - 0.05);
                y0 = Math.max(y0, lv.y + 0.05);
                if (y1 - y0 < 0.3) continue;
                // keep clear of the front door (shopfronts): the window is split round it
                if (isFront && k === 0) {
                  const dL = door.s - door.width / 2 - 0.12, dR = door.s + door.width / 2 + 0.12;
                  if (s1 > dL && s0 < dR) {
                    if (s0 < dL - 0.3) ops.push([s0 - sA, dL - sA, y0, y1]);
                    if (s1 > dR + 0.3) ops.push([dR - sA, s1 - sA, y0, y1]);
                    continue;
                  }
                }
                ops.push([s0 - sA, s1 - sA, y0, y1]);
              }
            }
          }
        }
      }
      if (isFront && k === 0) ops.push([door.s - door.width / 2 - sA, door.s + door.width / 2 - sA, lv.y - 0.1, lv.y + door.height]);
      // splits where partitions meet this face (so each room gets its own wall colour)
      const splits: number[] = [];
      for (const pt of plan.partitions) {
        if (pt.level !== k) continue;
        for (const [ex, ez] of [[pt.ax, pt.az], [pt.bx, pt.bz]]) {
          const along = (ex - A[0]) * iux + (ez - A[1]) * iuz, off = (ex - A[0]) * nx + (ez - A[1]) * nz;
          if (Math.abs(off) < 0.12 && along > 0 && along < ilen) splits.push(along);
        }
      }
      faceWithOpenings(k, A[0], A[1], iux, iuz, 0, ilen, lv.y, lv.ceil, nx, nz, ops, splits);
      // window reveals (wall thickness) and glass
      for (const o of ops) {
        if (isFront && k === 0 && Math.abs(o[3] - (lv.y + door.height)) < 1e-6) continue; // the door's reveal is the facade's
        const s0 = Math.max(0, o[0]), s1 = Math.min(ilen, o[1]), y0 = o[2], y1 = o[3];
        if (s1 - s0 < 0.05) continue;
        const col = wallColAt(k, A[0] + iux * (s0 + s1) / 2 + nx * 0.4, A[1] + iuz * (s0 + s1) / 2 + nz * 0.4);
        const P0 = [A[0] + iux * s0, A[1] + iuz * s0], P1 = [A[0] + iux * s1, A[1] + iuz * s1];
        const d = t - 0.012; // back to just behind the facade
        const o0 = [P0[0] - nx * d, P0[1] - nz * d], o1 = [P1[0] - nx * d, P1[1] - nz * d];
        shell.wall(P0[0], P0[1], o0[0], o0[1], y0, y1, y0, y1, col, iux, iuz);
        shell.wall(P1[0], P1[1], o1[0], o1[1], y0, y1, y0, y1, col, -iux, -iuz);
        shell.quad(P0[0], y0, P0[1], P1[0], y0, P1[1], o1[0], y0, o1[1], o0[0], y0, o0[1], TRIM, 0, 1, 0); // sill
        shell.quad(P0[0], y1, P0[1], P1[0], y1, P1[1], o1[0], y1, o1[1], o0[0], y1, o0[1], col, 0, -1, 0); // head
        const g = t - 0.05;
        glass.wall(P0[0] - nx * g, P0[1] - nz * g, P1[0] - nx * g, P1[1] - nz * g, y0, y1, y0, y1, lin(0x9fb4bf), nx, nz);
      }
    }
    yield;
  }

  // ------------------------------------------------------------------------------------------- floors, ceilings, slabs
  const holesOn = (k: number) => plan.holes.filter((h) => h.level === k).map((h) => h.poly);
  /** Polygon minus convex holes, as pieces (each the polygon clipped to one region outside the hole). */
  const minusHoles = (poly: P2[], holes: P2[][]): P2[][] => {
    let pieces = [poly];
    for (const H of holes) {
      const next: P2[][] = [];
      for (const piece of pieces) {
        let rest = piece;
        for (let i = 0; i < H.length && rest.length >= 3; i++) {
          const a = H[i], b = H[(i + 1) % H.length];
          // outward normal of the hole edge (the hole is convex): away from its centre
          let ex = -(b[1] - a[1]), ez = b[0] - a[0];
          const hc = H.reduce((s, q) => [s[0] + q[0] / H.length, s[1] + q[1] / H.length], [0, 0]);
          if ((hc[0] - a[0]) * ex + (hc[1] - a[1]) * ez > 0) { ex = -ex; ez = -ez; }
          const c = a[0] * ex + a[1] * ez;
          const out = clipHalf(rest, ex, ez, c);
          if (out.length >= 3) next.push(out);
          rest = clipHalf(rest, -ex, -ez, -c);
        }
      }
      pieces = next;
    }
    return pieces;
  };
  const flat = (poly: P2[], y: number, col: number, up: boolean) => {
    if (poly.length < 3) return;
    const tri = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
    for (const [a, b, c] of tri) shell.tri(poly[a][0], y, poly[a][1], poly[b][0], y, poly[b][1], poly[c][0], y, poly[c][1], col, 0, up ? 1 : -1, 0);
  };
  for (const r of plan.rooms) {
    const lv = L[r.level];
    const f = finishOf(r.floor);
    for (const piece of minusHoles(r.poly, holesOn(r.level))) flat(piece, lv.y + 0.002, tag(f.s, f.col), true);
    for (const piece of minusHoles(r.poly, holesOn(r.level + 1))) flat(piece, lv.ceil, CEIL, false);
  }
  // collision: slabs under every upper floor (the plinth is the ground floor's) and the roof slab over the top floor
  const pieces = convexPieces(P.map((p) => [p[0], p[1]] as [number, number])) as P2[][];
  for (let k = 1; k < L.length; k++) {
    for (const pc of pieces) for (const q of minusHoles(pc, holesOn(k))) prism(q, L[k].y - I.slab, L[k].y, 'floorSlab');
    // stairwell edges (drawn): the slab's thickness round each hole
    for (const H of holesOn(k)) {
      for (let i = 0; i < H.length; i++) {
        const a = H[i], b = H[(i + 1) % H.length];
        const hc = H.reduce((s, q) => [s[0] + q[0] / H.length, s[1] + q[1] / H.length], [0, 0]);
        shell.wall(a[0], a[1], b[0], b[1], L[k - 1].ceil, L[k].y, L[k - 1].ceil, L[k].y, CEIL, hc[0] - (a[0] + b[0]) / 2, hc[1] - (a[1] + b[1]) / 2);
      }
    }
  }
  const lt = L[L.length - 1];
  for (const pc of pieces) prism(pc, lt.ceil, lt.top, 'floorSlab');
  yield;

  // ------------------------------------------------------------------------------------------- partitions
  const tp = I.partition;
  for (const pt of plan.partitions) {
    const lv = L[pt.level];
    const len = Math.hypot(pt.bx - pt.ax, pt.bz - pt.az);
    if (len < 0.05) continue;
    const ux = (pt.bx - pt.ax) / len, uz = (pt.bz - pt.az) / len, nx = -uz, nz = ux;
    const ops = pt.openings.map((o) => [o.s0, o.s1, lv.y - 0.1, lv.y + o.h]);
    for (const sgn of [1, -1]) {
      const ox = pt.ax + nx * sgn * tp / 2, oz = pt.az + nz * sgn * tp / 2;
      faceWithOpenings(pt.level, ox, oz, ux, uz, 0, len, lv.y, lv.ceil, nx * sgn, nz * sgn, ops, []);
    }
    // collision: solid between the openings, lintels above them
    let s = 0;
    const sorted = [...pt.openings].sort((a, b) => a.s0 - b.s0);
    const seg = (s0: number, s1: number, y0: number, y1: number) => {
      if (s1 - s0 < 0.02 || y1 - y0 < 0.02) return;
      const sm = (s0 + s1) / 2;
      box(pt.ax + ux * sm, (y0 + y1) / 2, pt.az + uz * sm, (s1 - s0) / 2, (y1 - y0) / 2, tp / 2, ux, uz, 'interiorWall');
    };
    for (const o of sorted) {
      seg(s, o.s0, lv.y, lv.ceil);
      seg(o.s0, o.s1, lv.y + o.h, lv.ceil);
      // jambs and head inside the opening, and a painted casing round it on both faces
      for (const [sv, dirS] of [[o.s0, 1], [o.s1, -1]] as [number, number][]) {
        const jx = pt.ax + ux * sv, jz = pt.az + uz * sv;
        shell.wall(jx - nx * tp / 2, jz - nz * tp / 2, jx + nx * tp / 2, jz + nz * tp / 2, lv.y, lv.y + o.h, lv.y, lv.y + o.h, TRIM, ux * dirS, uz * dirS);
        for (const sg of [1, -1]) shell.obox(jx - ux * dirS * 0.04 + nx * sg * (tp / 2 + 0.01), lv.y, jz - uz * dirS * 0.04 + nz * sg * (tp / 2 + 0.01), 0.04, 0.012, lv.y + o.h + 0.07, ux, uz, TRIM);
      }
      const hx0 = pt.ax + ux * o.s0, hz0 = pt.az + uz * o.s0, hx1 = pt.ax + ux * o.s1, hz1 = pt.az + uz * o.s1;
      shell.quad(hx0 - nx * tp / 2, lv.y + o.h, hz0 - nz * tp / 2, hx1 - nx * tp / 2, lv.y + o.h, hz1 - nz * tp / 2, hx1 + nx * tp / 2, lv.y + o.h, hz1 + nz * tp / 2, hx0 + nx * tp / 2, lv.y + o.h, hz0 + nz * tp / 2, TRIM, 0, -1, 0);
      for (const sg of [1, -1]) {
        const mx = (hx0 + hx1) / 2 + nx * sg * (tp / 2 + 0.01), mz = (hz0 + hz1) / 2 + nz * sg * (tp / 2 + 0.01);
        shell.obox(mx, lv.y + o.h, mz, (o.s1 - o.s0) / 2 + 0.08, 0.012, lv.y + o.h + 0.07, ux, uz, TRIM);
      }
      s = o.s1;
    }
    seg(s, len, lv.y, lv.ceil);
  }
  yield;

  // ------------------------------------------------------------------------------------------- stairs and railings
  for (const st of plan.stairs) {
    const t = st.run / (st.steps - 1), r = st.rise / st.steps;
    const ax = st.dz, az = -st.dx; // across the flight
    const hw = st.width / 2;
    // treads and risers (a solid block where the flight is solid to the floor, a stepped slab over a stairwell)
    for (let k = 0; k < st.steps - 1; k++) {
      const a0 = k * t, a1 = (k + 1) * t, top = st.y + (k + 1) * r;
      const solid = a1 <= st.solid + 1e-6;
      const mx = st.x + st.dx * (a0 + a1) / 2, mz = st.z + st.dz * (a0 + a1) / 2;
      shell.obox(mx, solid ? st.y : top - 0.3, mz, t / 2, hw, top, st.dx, st.dz, k % 2 ? OAK_TREAD : shade(OAK_TREAD, 0.94), shade(TRIM, 0.97), !solid);
      // tread nosing
      shell.obox(st.x + st.dx * (a0 + 0.015), top - 0.025, st.z + st.dz * (a0 + 0.015), 0.02, hw, top + 0.006, st.dx, st.dz, shade(OAK_TREAD, 0.85));
    }
    // the last riser up to the floor above
    shell.obox(st.x + st.dx * (st.run - 0.01), st.y + st.rise - r, st.z + st.dz * (st.run - 0.01), 0.01, hw, st.y + st.rise, st.dx, st.dz, shade(TRIM, 0.97));
    // collision: a ramp through the middle of every tread (half a riser of lip at the foot; it meets the floor above)
    const aEnd = st.run + 0.5 * t;
    const prof = (a: number) => st.y + rampAt(st, a);
    const ring = (a0: number, a1: number, bottom: (a: number) => number) => {
      const pts: number[] = [];
      for (const sd of [-1, 1]) {
        const ox = ax * hw * sd, oz = az * hw * sd;
        for (const [a, y] of [[a0, prof(a0)], [a1, prof(a1)], [a1, bottom(a1)], [a0, bottom(a0)]]) pts.push(st.x + st.dx * a + ox, y, st.z + st.dz * a + oz);
      }
      hull(pts, 'stair');
    };
    if (st.solid > 0.01) ring(-0.02, Math.min(aEnd, st.solid + (st.solid >= st.run ? 0.5 * t : 0)), () => st.y - 0.05);
    if (st.solid < st.run) ring(Math.max(0, st.solid - 0.05), aEnd, (a) => prof(a) - 0.3);
    // balustrades on the open sides: a rail 0.9 m over the nosings, balusters, and a collider from the ramp to rail height
    for (const [sx, sz] of st.rails) {
      const sd = sx * ax + sz * az > 0 ? 1 : -1;
      const ox = ax * (hw + 0.03) * sd, oz = az * (hw + 0.03) * sd;
      const y0 = st.y + r * 0.5 + 0.9, y1 = st.y + st.rise - r * 0.5 + 0.9;
      const bx = st.x + ox, bz = st.z + oz, ex = st.x + st.dx * st.run + ox, ez = st.z + st.dz * st.run + oz;
      // handrail: a sloped bar (top and two sides)
      const q = (o: number, dy: number) => [bx + ax * o, y0 + dy, bz + az * o, ex + ax * o, y1 + dy, ez + az * o];
      const [a1, b1, c1, d1, e1, f1] = q(-0.03, 0), [a2, b2, c2, d2, e2, f2] = q(0.03, 0), [a3, b3, c3, d3, e3, f3] = q(-0.03, -0.06), [a4, b4, c4, d4, e4, f4] = q(0.03, -0.06);
      shell.quad(a1, b1, c1, d1, e1, f1, d2, e2, f2, a2, b2, c2, IRON, 0, 1, 0);
      shell.quad(a1, b1, c1, d1, e1, f1, d3, e3, f3, a3, b3, c3, IRON, -ax, 0, -az);
      shell.quad(a2, b2, c2, d2, e2, f2, d4, e4, f4, a4, b4, c4, IRON, ax, 0, az);
      for (let k = 0; k < st.steps - 1; k++) {
        const a = (k + 0.5) * t, yb = st.y + (k + 1) * r, yr = y0 + ((y1 - y0) * a) / st.run - 0.06;
        shell.obox(st.x + st.dx * a + ox, yb, st.z + st.dz * a + oz, 0.015, 0.015, yr, st.dx, st.dz, IRON);
      }
      const pts: number[] = [];
      for (const off of [-0.03, 0.03]) {
        for (const [a, y] of [[0, prof(0) - 0.2], [st.run, prof(st.run) - 0.2], [st.run, y1 + 0.05], [0, y0 + 0.05]]) pts.push(st.x + st.dx * a + ox + ax * off * sd, y, st.z + st.dz * a + oz + az * off * sd);
      }
      hull(pts, 'stairWall');
    }
    yield;
  }
  for (const rl of plan.rails) {
    const lv = L[rl.level];
    const len = Math.hypot(rl.bx - rl.ax, rl.bz - rl.az);
    if (len < 0.05) continue;
    const ux = (rl.bx - rl.ax) / len, uz = (rl.bz - rl.az) / len;
    const mx = (rl.ax + rl.bx) / 2, mz = (rl.az + rl.bz) / 2;
    shell.obox(mx, lv.y + I.railHeight - 0.05, mz, len / 2, 0.03, lv.y + I.railHeight, ux, uz, IRON, IRON, true);
    shell.obox(mx, lv.y + 0.08, mz, len / 2, 0.02, lv.y + 0.12, ux, uz, IRON, IRON, true);
    const nb = Math.max(2, Math.round(len / 0.12));
    for (let k = 0; k <= nb; k++) {
      const s = (k / nb - 0.5) * len;
      shell.obox(mx + ux * s, lv.y + 0.12, mz + uz * s, 0.012, 0.012, lv.y + I.railHeight - 0.05, ux, uz, IRON);
    }
    box(mx, lv.y + I.railHeight / 2, mz, len / 2, I.railHeight / 2, 0.04, ux, uz, 'railing');
  }
  yield;

  // ------------------------------------------------------------------------------------------- furniture and item slots
  const slots: ItemSlot[] = [];
  for (const fp of plan.furniture) {
    const def: FurnDef = FURNITURE[fp.def];
    const y = L[fp.level].y;
    const ax = fp.fz, az = -fp.fx; // the piece's local +x
    for (const part of def.parts) {
      const cx = fp.x + ax * part.c[0] + fp.fx * part.c[2], cz = fp.z + az * part.c[0] + fp.fz * part.c[2];
      const y0 = y + part.c[1] - part.h[1], y1 = y + part.c[1] + part.h[1];
      const col = tag(part.s, part.col);
      shell.obox(cx, y0, cz, part.h[0], part.h[2], y1, ax, az, col, shade(col, 0.92), y0 > y + 0.02);
    }
    for (const part of def.glow ?? []) {
      const cx = fp.x + ax * part.c[0] + fp.fx * part.c[2], cz = fp.z + az * part.c[0] + fp.fz * part.c[2];
      glow.obox(cx, y + part.c[1] - part.h[1], cz, part.h[0], part.h[2], y + part.c[1] + part.h[1], ax, az, lin(part.col), lin(part.col), true);
    }
    if (def.solid) box(fp.x, y + def.hgt / 2, fp.z, def.w / 2, def.hgt / 2, def.d / 2, ax, az, 'furniture');
    // item slots: one item (or a gap) per position, chosen from the building's seed
    const fslots = def.slots ?? [];
    fslots.forEach((sl, si) => {
      for (let j = 0; j < sl.n; j++) {
        const uid = `${rec.id}/${fp.id}/${si}.${j}`;
        const rnd = rng32(hash32(`${uid}:${w.seed}`));
        if (rnd() < (sl.gaps ?? 0)) continue;
        const type = sl.items[Math.floor(rnd() * sl.items.length)];
        const lx = sl.x + j * sl.step + (rnd() - 0.5) * I.itemSlotJitter, lz = sl.z + (rnd() - 0.5) * I.itemSlotJitter;
        slots.push({ uid, type, x: fp.x + ax * lx + fp.fx * lz, y: y + sl.y, z: fp.z + az * lx + fp.fz * lz, yaw: Math.atan2(fp.fx, fp.fz) + (rnd() - 0.5) * 0.3 });
      }
    });
  }
  yield;

  // ------------------------------------------------------------------------------------------- light fixtures
  for (const l of plan.lights) {
    glow.obox(l.x, l.y + 0.06, l.z, 0.2, 0.2, l.y + 0.1, 1, 0, lin(0xfff3da), lin(0xfff3da), true);
    shell.cyl(l.x, l.y + 0.1, l.z, 0.015, 0.015, L[l.level].ceil - l.y - 0.1, 4, IRON, false);
  }

  // ------------------------------------------------------------------------------------------- meshes
  const group = new THREE.Group();
  group.name = `interior-${rec.id}`;
  let tris = 0;
  for (const [buf, mat, name] of [[shell, mats.shell, 'shell'], [glass, mats.glass, 'glass'], [glow, mats.glow, 'glow']] as [MeshBuf, THREE.Material, string][]) {
    if (!buf.n) continue;
    const m = new THREE.Mesh(buf.toGeometry(), mat);
    m.name = `${group.name}-${name}`;
    m.matrixAutoUpdate = false;
    m.castShadow = false;
    m.receiveShadow = name === 'shell';
    if (name === 'glass') m.renderOrder = 2;
    group.add(m);
    tris += buf.tris;
  }
  parent.add(group);
  const levels: FloorPiece[] = L.map((lv, k) => ({ y: lv.y, holes: holesOn(k) }));
  return { body, colliders, group, slots, levels, stairs: plan.stairs, tris, ms: performance.now() - t0 };
}

/** Remove a built interior: meshes, colliders (and their registry tags). */
export function disposeInterior(w: World, b: BuiltInterior): void {
  for (const c of b.colliders) w.city.solidTags.delete(c.handle);
  w.physics.removeRigidBody(b.body);
  b.group.parent?.remove(b.group);
  b.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
}
