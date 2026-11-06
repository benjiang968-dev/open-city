// Interior plans: pure data describing a building's rooms, partitions, doors, stairs, stairwell holes, railings,
// furniture and lights, made by a template (templates.ts) from the building's record (records.ts). No three.js, no
// Rapier: interiorBuild.ts turns a plan into meshes and colliders. A plan is deterministic from the record (the
// layout never depends on the seed; what stands on the shelves may), and it is validated before the building's
// doorway is cut: a building whose plan fails keeps its solid and is reported by id.
//
// Generalisation (Stage D): a template is `(rec, B: PlanBuilder) => void` that lays rooms out in the record's frame
// (u along the front wall from the door's end, v inward) with the builder's helpers; everything is clipped to the
// building's inner polygon (the footprint inset by the wall thicknesses), so any footprint shape works.
import type { BuildingRecord, TemplateId } from './records';
import { TUNING } from '../../tuning';
import { FURNITURE, type FurnId } from '../../data/furniture';
import { area, clipBox, edgeDist, frameBounds, insetPoly, pointIn, segmentInside, toFrame, toWorld, type Frame, type P2 } from './geom';

const I = TUNING.interiors;

/** Bump whenever a template's output changes: saved door states of a building with an older plan are dropped. */
export const PLAN_VERSION = 1;

export interface PlanLevel {
  /** finished floor, underside of the slab above (the ceiling), and the next floor (or the roof slab's top) */
  y: number; ceil: number; top: number;
}
export interface PlanRoom { id: string; level: number; name: string; kind: string; poly: P2[]; floor: number; wall: number }
export interface PlanOpening { s0: number; s1: number; h: number; door: string | null }
export interface PlanPartition { level: number; ax: number; az: number; bx: number; bz: number; openings: PlanOpening[] }
export interface PlanDoor {
  id: string; level: number; front: boolean;
  /** centre of the opening at the sill, on the wall's centre line (front doors: on the facade line) */
  x: number; y: number; z: number;
  /** along the wall (hinge side -1 at s = -width / 2), and the wall's normal (the side the door opens to: +) */
  ux: number; uz: number; nx: number; nz: number;
  width: number; height: number;
  hinge: -1 | 1;
  /** offset of the closed leaf's middle along n from (x, z) */
  depth: number;
  /** 'in': always opens to +n; 'away': opens away from whoever opens it */
  swing: 'in' | 'away';
  style: 'house' | 'shop' | 'inner';
  colour: number;
}
export interface PlanStair {
  level: number;
  /** foot of the flight (middle of its width) at the floor, and the direction up the flight */
  x: number; z: number; dx: number; dz: number;
  y: number; width: number; run: number; rise: number; steps: number;
  /** metres of run from the foot under which the flight is solid down to the floor (the rest is a sloped slab) */
  solid: number;
  /** sides of the flight that get a balustrade (world unit vectors across the flight, pointing to that side) */
  rails: [number, number][];
}
export interface PlanHole { level: number; poly: P2[] }
export interface PlanRail { level: number; ax: number; az: number; bx: number; bz: number }
export interface PlanFurn { id: string; def: FurnId; level: number; room: string; x: number; z: number; fx: number; fz: number }
export interface PlanLight { level: number; room: string; x: number; y: number; z: number }

export interface Plan {
  id: string;
  version: number;
  template: TemplateId;
  frame: Frame;
  inner: P2[];
  levels: PlanLevel[];
  rooms: PlanRoom[];
  partitions: PlanPartition[];
  doors: PlanDoor[];
  stairs: PlanStair[];
  holes: PlanHole[];
  rails: PlanRail[];
  furniture: PlanFurn[];
  lights: PlanLight[];
  /** validation problems that make the plan unusable (empty = fine) */
  errors: string[];
  /** things left out to make it fit (furniture that would block a door, ...) */
  notes: string[];
}

/** Room floor and wall finishes: sRGB colours plus a surface name (interiorBuild tags them). */
export const FINISH = {
  oak: { col: 0x9a6a42, s: 'WOOD' }, pine: { col: 0xb08458, s: 'WOOD' }, tile: { col: 0xd9d6cf, s: 'STONE' }, slate: { col: 0x6d6f70, s: 'STONE' },
  concrete: { col: 0xa8a49b, s: 'CONCRETE' }, lino: { col: 0xbfb8a8, s: 'CONCRETE' },
  white: { col: 0xeeeae2, s: 'STUCCO' }, cream: { col: 0xeadfc8, s: 'STUCCO' }, sage: { col: 0xc6cfba, s: 'STUCCO' }, blue: { col: 0xc4d0dc, s: 'STUCCO' },
  rose: { col: 0xe2cbc4, s: 'STUCCO' }, grey: { col: 0xd2d2ce, s: 'STUCCO' },
} as const;
export type FinishId = keyof typeof FINISH;
const FIN_IDS = Object.keys(FINISH) as FinishId[];
export const finishIndex = (f: FinishId) => FIN_IDS.indexOf(f);
export const finishOf = (i: number) => FINISH[FIN_IDS[i] ?? 'white'];

/** The helpers a template lays a plan out with (all coordinates in the record's frame unless named world). */
export class PlanBuilder {
  readonly rec: BuildingRecord;
  readonly f: Frame;
  readonly inner: P2[];
  readonly plan: Plan;
  /** inner extent across the front, measured just inside the front wall, and the inner depth along a line */
  readonly uf0: number; readonly uf1: number;
  readonly v0: number; readonly v1: number;
  constructor(rec: BuildingRecord, template: TemplateId) {
    this.rec = rec;
    const d = rec.door!;
    // frame: origin at the door's end of the front wall, u along it, v inward
    const w = rec.walls[d.wall];
    const o = d.atStart ? [w.ax, w.az] : [w.bx, w.bz];
    const sg = d.atStart ? 1 : -1;
    this.f = { ox: o[0], oz: o[1], ux: w.ux * sg, uz: w.uz * sg, vx: -w.nx, vz: -w.nz };
    // inner polygon: footprint edges inset by their wall thickness (party walls half, others a whole outer wall)
    const P = rec.pts;
    const th = P.map((p, i) => {
      const q = P[(i + 1) % P.length];
      const wr = rec.walls.find((x) => Math.hypot(x.ax - p[0], x.az - p[1]) < 1e-3 && Math.hypot(x.bx - q[0], x.bz - q[1]) < 1e-3);
      return wr?.party ? I.partyWall : I.outerWall;
    });
    this.inner = insetPoly(P, th);
    const [, , bv0, bv1] = frameBounds(this.f, this.inner);
    // across the front (just inside the front wall) and the depth
    const [u0, u1] = this.across(bv0 + 0.6);
    this.uf0 = u0; this.uf1 = u1;
    this.v0 = bv0; this.v1 = bv1;
    const levels: PlanLevel[] = rec.storeys.map((y, k) => {
      const top = k + 1 < rec.storeys.length ? rec.storeys[k + 1] : rec.yTop;
      return { y, ceil: top - I.slab, top };
    });
    this.plan = {
      id: rec.id, version: PLAN_VERSION, template, frame: this.f, inner: this.inner, levels, rooms: [], partitions: [], doors: [], stairs: [], holes: [], rails: [],
      furniture: [], lights: [], errors: [], notes: [],
    };
  }
  /** World point of a frame point. */
  W(u: number, v: number): P2 { return toWorld(this.f, u, v); }
  /** The widest inside interval across the building (along u) at depth v. */
  across(v: number): [number, number] {
    const a = this.W(-1000, v), b = this.W(1000, v);
    const iv = segmentInside(this.inner, a[0], a[1], b[0], b[1]);
    let best: [number, number] = [0, 0];
    for (const [t0, t1] of iv) if (t1 - t0 > best[1] - best[0]) best = [t0, t1];
    return [-1000 + best[0] * 2000, -1000 + best[1] * 2000];
  }
  /** The inside interval along v at offset u, starting from the front. */
  along(u: number): [number, number] {
    const a = this.W(u, -1000), b = this.W(u, 1000);
    const iv = segmentInside(this.inner, a[0], a[1], b[0], b[1]);
    if (!iv.length) return [0, 0];
    const t = iv[0];
    return [-1000 + t[0] * 2000, -1000 + t[1] * 2000];
  }
  /** The inner wall's u on the far (+1) or near (-1) side, the tightest over v in [va, vb] (furniture against it). */
  wallU(side: 1 | -1, va: number, vb: number): number {
    let best = side > 0 ? Infinity : -Infinity;
    const a0 = Math.min(va, vb) + 0.04, a1 = Math.max(va, vb) - 0.04;
    for (let i = 0; i <= 4; i++) {
      const [a, b] = this.across(a0 + ((a1 - a0) * i) / 4);
      if (b - a < 0.1) continue;
      best = side > 0 ? Math.min(best, b) : Math.max(best, a);
    }
    return Number.isFinite(best) ? best : side > 0 ? this.uf1 : this.uf0;
  }
  /** The inner wall's v at the back (+1) or front (-1), the tightest over u in [ua, ub]. */
  wallV(side: 1 | -1, ua: number, ub: number): number {
    let best = side > 0 ? Infinity : -Infinity;
    const a0 = Math.min(ua, ub) + 0.04, a1 = Math.max(ua, ub) - 0.04;
    for (let i = 0; i <= 4; i++) {
      const [a, b] = this.along(a0 + ((a1 - a0) * i) / 4);
      if (b - a < 0.1) continue;
      best = side > 0 ? Math.min(best, b) : Math.max(best, a);
    }
    return Number.isFinite(best) ? best : side > 0 ? this.v1 : this.v0;
  }
  /** Furniture against the far (+1) or near (-1) side wall, its middle at depth v (it faces across the building). */
  side(def: FurnId, level: number, room: string | null, side: 1 | -1, v: number) {
    const w = FURNITURE[def].w / 2;
    this.against(def, level, room, this.wallU(side, v - w, v + w), v, -side, 0);
  }
  room(level: number, name: string, kind: string, u0: number, u1: number, v0: number, v1: number, floor: FinishId, wall: FinishId): string | null {
    const poly = clipBox(this.inner, this.f, u0, u1, v0, v1);
    if (poly.length < 3) return null;
    const id = `L${level}/${name}`;
    this.plan.rooms.push({ id, level, name, kind, poly, floor: finishIndex(floor), wall: finishIndex(wall) });
    return id;
  }
  /**
   * A partition from frame (ua, va) to (ub, vb) on a level, clipped to the inner polygon; openings at frame
   * positions along it ([centre measured along the segment from a, width, height, door id or null]).
   */
  partition(level: number, ua: number, va: number, ub: number, vb: number, openings: [number, number, number, string | null][] = []) {
    const A = this.W(ua, va), B = this.W(ub, vb);
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    for (const [t0, t1] of segmentInside(this.inner, A[0], A[1], B[0], B[1])) {
      const a: P2 = [A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0], b: P2 = [A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1];
      const s0 = t0 * L, len = (t1 - t0) * L;
      const ops: PlanOpening[] = [];
      for (const [c, wd, h, door] of openings) {
        const o0 = c - wd / 2 - s0, o1 = c + wd / 2 - s0;
        if (o1 <= 0.05 || o0 >= len - 0.05) continue;
        ops.push({ s0: Math.max(0, o0), s1: Math.min(len, o1), h, door });
      }
      this.plan.partitions.push({ level, ax: a[0], az: a[1], bx: b[0], bz: b[1], openings: ops });
    }
  }
  /** The building's front door (records.ts DoorRec) as a plan door: opens inward, the leaf recessed in the reveal. */
  frontDoor(): string {
    const d = this.rec.door!;
    const id = `${this.rec.id}/door0`;
    this.plan.doors.push({
      id, level: 0, front: true, x: d.x, y: d.sill, z: d.z, ux: d.ux, uz: d.uz, nx: -d.nx, nz: -d.nz, width: d.width, height: d.height,
      hinge: d.hinge, depth: I.leafRecess + I.leafThickness / 2, swing: 'in', style: d.style, colour: d.colour,
    });
    return id;
  }
  /** An inner door leaf in a partition opening: centre at frame (u, v), wall direction along frame (du, dv). */
  innerDoor(level: number, id: string, u: number, v: number, du: number, dv: number, hinge: -1 | 1): string {
    const [x, z] = this.W(u, v);
    const ux = this.f.ux * du + this.f.vx * dv, uz = this.f.uz * du + this.f.vz * dv;
    const L = Math.hypot(ux, uz) || 1;
    this.plan.doors.push({
      id: `${this.rec.id}/${id}`, level, front: false, x, y: this.plan.levels[level].y, z, ux: ux / L, uz: uz / L, nx: -uz / L, nz: ux / L,
      width: I.innerDoorWidth - 0.06, height: I.innerDoorHeight - 0.03, hinge, depth: 0, swing: 'away', style: 'inner', colour: 0xf2efe6,
    });
    return `${this.rec.id}/${id}`;
  }
  /** A flight from `level` up to the next, foot at frame (u, v) rising along frame (du, dv); `rails`: frame directions of
   * the sides that get a balustrade. */
  stair(level: number, u: number, v: number, du: number, dv: number, width: number, solid: number, rails: [number, number][]): PlanStair {
    const lv = this.plan.levels;
    const rise = lv[level + 1].y - lv[level].y;
    const risers = Math.ceil(rise / I.stairRiseMax - 1e-6);
    const run = (risers - 1) * I.stairRun;
    const [x, z] = this.W(u, v);
    const dx = this.f.ux * du + this.f.vx * dv, dz = this.f.uz * du + this.f.vz * dv;
    const rw = rails.map(([a, b]): [number, number] => [this.f.ux * a + this.f.vx * b, this.f.uz * a + this.f.vz * b]);
    const st: PlanStair = { level, x, z, dx, dz, y: lv[level].y, width, run, rise, steps: risers, solid: Math.min(run, solid), rails: rw };
    this.plan.stairs.push(st);
    return st;
  }
  /** Run of a flight on a level (for layouts, before it is placed). */
  runOf(level: number): number {
    const lv = this.plan.levels;
    if (level + 1 >= lv.length) return 0;
    const risers = Math.ceil((lv[level + 1].y - lv[level].y) / I.stairRiseMax - 1e-6);
    return (risers - 1) * I.stairRun;
  }
  /** Horizontal distance from a flight's foot after which the slab above must be cut away (headroom). */
  holeStart(level: number): number {
    const lv = this.plan.levels;
    const rise = lv[level + 1].y - lv[level].y, run = this.runOf(level);
    return Math.max(0.3, ((rise - I.slab - I.stairHeadroom) * run) / rise - I.stairHeadBack);
  }
  hole(level: number, u0: number, u1: number, v0: number, v1: number) {
    const poly = [this.W(u0, v0), this.W(u1, v0), this.W(u1, v1), this.W(u0, v1)];
    this.plan.holes.push({ level, poly });
  }
  rail(level: number, ua: number, va: number, ub: number, vb: number) {
    const a = this.W(ua, va), b = this.W(ub, vb);
    this.plan.rails.push({ level, ax: a[0], az: a[1], bx: b[0], bz: b[1] });
  }
  /** Furniture with its middle at frame (u, v), its front facing frame direction (fu, fv). */
  furn(def: FurnId, level: number, room: string | null, u: number, v: number, fu: number, fv: number) {
    if (!room) return;
    const [x, z] = this.W(u, v);
    const fx = this.f.ux * fu + this.f.vx * fv, fz = this.f.uz * fu + this.f.vz * fv;
    const L = Math.hypot(fx, fz) || 1;
    const id = `${room}/${def}${this.plan.furniture.filter((q) => q.room === room && q.def === def).length}`;
    this.plan.furniture.push({ id, def, level, room, x, z, fx: fx / L, fz: fz / L });
  }
  /** Furniture with its back against a wall at frame position: sugar over furn (back offset by half its depth). */
  against(def: FurnId, level: number, room: string | null, u: number, v: number, fu: number, fv: number) {
    const d = FURNITURE[def].d / 2 + 0.02;
    this.furn(def, level, room, u + fu * d, v + fv * d, fu, fv);
  }
  light(level: number, room: string | null) {
    if (!room) return;
    const r = this.plan.rooms.find((q) => q.id === room);
    if (!r) return;
    let x = 0, z = 0;
    for (const p of r.poly) { x += p[0]; z += p[1]; }
    x /= r.poly.length; z /= r.poly.length;
    if (!pointIn(x, z, r.poly)) { x = r.poly[0][0] * 0.5 + x * 0.5; z = r.poly[0][1] * 0.5 + z * 0.5; }
    this.plan.lights.push({ level, room, x, y: this.plan.levels[level].ceil - 0.12, z });
  }
}

// ------------------------------------------------------------------------------------------------ validation
/** Corners of a furniture piece (world). */
export function furnCorners(p: PlanFurn, grow = 0): P2[] {
  const d = FURNITURE[p.def];
  const ax = p.fz, az = -p.fx; // local +x
  const hw = d.w / 2 + grow, hd = d.d / 2 + grow;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [p.x + ax * a * hw + p.fx * b * hd, p.z + az * a * hw + p.fz * b * hd] as P2);
}
function rectsOverlap(A: P2[], B: P2[]): boolean {
  // separating axis test for two convex quads
  for (const P of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const p = P[i], q = P[(i + 1) % 4];
      const nx = -(q[1] - p[1]), nz = q[0] - p[0];
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const c of A) { const t = c[0] * nx + c[1] * nz; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
      for (const c of B) { const t = c[0] * nx + c[1] * nz; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
  }
  return true;
}
/** Clear squares on both sides of every door and at every stair end: furniture may not stand there. */
function clearZones(plan: Plan): { level: number; q: P2[] }[] {
  const out: { level: number; q: P2[] }[] = [];
  const sq = (x: number, z: number, ux: number, uz: number, hw: number, hd: number): P2[] =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [x + ux * a * hw - uz * b * hd, z + uz * a * hw + ux * b * hd] as P2);
  for (const d of plan.doors) {
    const hw = d.width / 2 + 0.05;
    for (const s of [-1, 1]) {
      const reach = Math.max(0.9, d.width + 0.1); // the leaf's swing (either side for doors that open away from you)
      const cx = d.x + d.nx * s * (reach / 2 + 0.15), cz = d.z + d.nz * s * (reach / 2 + 0.15);
      out.push({ level: d.level, q: sq(cx, cz, d.ux, d.uz, hw, reach / 2) });
    }
  }
  for (const p of plan.partitions) {
    for (const o of p.openings) {
      const L = Math.hypot(p.bx - p.ax, p.bz - p.az) || 1;
      const ux = (p.bx - p.ax) / L, uz = (p.bz - p.az) / L;
      const c = (o.s0 + o.s1) / 2;
      const x = p.ax + ux * c, z = p.az + uz * c;
      out.push({ level: p.level, q: sq(x, z, ux, uz, (o.s1 - o.s0) / 2 + 0.05, 0.85) });
    }
  }
  for (const s of plan.stairs) {
    const ax = s.dz, az = -s.dx;
    // the flight itself plus a landing at its foot (this level) and at its head (the level above)
    const len = s.run + I.stairLanding * 2;
    const mx = s.x + s.dx * (s.run / 2), mz = s.z + s.dz * (s.run / 2);
    for (const lv of [s.level, s.level + 1]) {
      out.push({ level: lv, q: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [mx + ax * a * (s.width / 2) + s.dx * b * (len / 2), mz + az * a * (s.width / 2) + s.dz * b * (len / 2)] as P2) });
    }
  }
  return out;
}

/** Validate a plan in place: drops furniture that does not fit, records errors that make it unusable. */
export function validatePlan(plan: Plan): void {
  const inner = plan.inner;
  const inside = (x: number, z: number, m = 0.02) => pointIn(x, z, inner) && edgeDist(x, z, inner) >= m;
  // doors: both sides inside, a clear approach
  for (const d of plan.doors) {
    // a front door's (x, z) is on the facade line, an inner door's on its partition's centre line
    const back = d.front ? I.outerWall + 0.6 : 0.6;
    const ox = d.x + d.nx * back, oz = d.z + d.nz * back;
    if (!inside(ox, oz, 0.3)) plan.errors.push(`door ${d.id}: no room behind it`);
    if (!d.front && !inside(d.x - d.nx * 0.6, d.z - d.nz * 0.6, 0.3)) plan.errors.push(`door ${d.id}: no room in front of it`);
    if (d.width < 0.85) plan.errors.push(`door ${d.id}: ${d.width.toFixed(2)} m is too narrow for the player`);
  }
  // stairs: the flight and both landings inside the building
  for (const s of plan.stairs) {
    const ax = s.dz, az = -s.dx;
    for (const t of [-I.stairLanding * 0.7, 0, s.run, s.run + I.stairLanding * 0.7]) {
      for (const k of [-0.45, 0.45]) {
        const x = s.x + s.dx * t + ax * s.width * k, z = s.z + s.dz * t + az * s.width * k;
        if (!pointIn(x, z, inner)) { plan.errors.push(`stair on L${s.level}: ${t < 0 ? 'foot landing' : t > s.run ? 'head landing' : 'flight'} outside the building`); break; }
      }
    }
    if (s.rise / Math.max(0.1, s.run) > Math.tan((46 * Math.PI) / 180)) plan.errors.push(`stair on L${s.level}: steeper than 46 degrees`);
  }
  // rooms: big enough
  for (const r of plan.rooms) {
    if (r.kind === 'stair' || r.kind === 'landing') continue;
    if (area(r.poly) < 2.2) plan.errors.push(`room ${r.id}: ${area(r.poly).toFixed(1)} m2 is too small`);
  }
  // furniture: inside its room, off doors and stairs, not overlapping other furniture (later ones are dropped)
  const zones = clearZones(plan);
  const kept: PlanFurn[] = [];
  for (const p of plan.furniture) {
    const room = plan.rooms.find((r) => r.id === p.room);
    const C = furnCorners(p);
    let why = '';
    if (!room) why = 'no room';
    else if (!C.every((c) => pointIn(c[0], c[1], room.poly) || edgeDist(c[0], c[1], room.poly) < 0.06)) why = 'outside its room';
    else if (zones.some((zn) => zn.level === p.level && FURNITURE[p.def].solid && rectsOverlap(C, zn.q))) why = 'in a doorway or on a stair landing';
    else if (kept.some((k) => k.level === p.level && FURNITURE[k.def].solid && FURNITURE[p.def].solid && rectsOverlap(C, furnCorners(k)))) why = 'overlaps other furniture';
    if (why) { plan.notes.push(`${p.id} left out (${why})`); continue; }
    kept.push(p);
  }
  plan.furniture = kept;
}

/** Frame coordinates of a world point (tests and templates). */
export function frameOf(plan: Plan, x: number, z: number): P2 { return toFrame(plan.frame, x, z); }
