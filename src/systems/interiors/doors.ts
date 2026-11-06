// Doors of building interiors: one leaf per plan door (plan.ts), drawn with one instanced mesh per style (house front
// door, glazed shop door, inner door). While its building's interior is built, a leaf is a kinematic Rapier body that
// swings open and shut with E; otherwise the leaf is drawn closed and the building's cold collision (records.ts
// plug) holds the doorway. A swing only moves into free space: before every step the leaf's next pose is tested
// against the player and any dynamic body, and a blocked door waits (it never pushes or traps anyone).
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '../../world';
import { TUNING } from '../../tuning';
import { GROUPS } from '../../physicsGroups';
import { GeoBuilder } from '../../art/geo';
import type { PlanDoor } from './plan';

const I = TUNING.interiors;
export type DoorStyle = PlanDoor['style'];
const STYLES: DoorStyle[] = ['house', 'shop', 'inner'];

export interface DoorObj {
  id: string;
  building: string;
  pd: PlanDoor;
  style: DoorStyle;
  inst: number;
  /** current and wanted swing angle (radians, 0 = closed) and the side it swings to (+1: toward pd.n) */
  angle: number;
  target: number;
  side: 1 | -1;
  open: boolean;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  /** seconds the swing has been held up by someone in the way */
  waited: number;
  changed: boolean;
  /** not drawn (an inner door of an interior that is not built) */
  hidden: boolean;
  /** a real door that does not open (its building has no interior yet): the prompt says so */
  locked: boolean;
}
export interface DoorsState {
  list: DoorObj[];
  byId: Map<string, DoorObj>;
  meshes: Record<DoorStyle, THREE.InstancedMesh>;
  /** the door the player faces within reach (E): a built one, or a cold front door (E then finishes its interior) */
  target: DoorObj | null;
  /** door states loaded from the save (id -> open), applied when a door is created */
  saved: Map<string, boolean>;
  /** set when a door changed state (the save system writes soon) */
  dirty: boolean;
}

/** Leaf geometry per style: x along the leaf's width (0..1 scaled), y up (0..1 scaled), z thickness (centred). */
function leafGeometry(style: DoorStyle): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const C = (h: string) => new THREE.Color(h);
  if (style === 'shop') {
    // aluminium frame round a glass pane, push bar
    const fr = C('#2b2e31'), gl = C('#6f8794');
    b.box(-0.5, 0, -0.5, -0.42, 1, 0.5, fr); b.box(0.42, 0, -0.5, 0.5, 1, 0.5, fr);
    b.box(-0.42, 0, -0.5, 0.42, 0.1, 0.5, fr); b.box(-0.42, 0.93, -0.5, 0.42, 1, 0.5, fr);
    b.box(-0.42, 0.1, -0.15, 0.42, 0.93, 0.15, gl);
    b.box(-0.35, 0.45, 0.5, 0.3, 0.48, 1.4, C('#c0c4c8'));
    b.box(-0.35, 0.45, -1.4, 0.3, 0.48, -0.5, C('#c0c4c8'));
  } else {
    // panelled timber door (white base: tinted per door through the instance colour), brass knob
    const w = C('#ffffff'), p = C('#e6e6e6');
    b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, w);
    for (const [y0, y1] of style === 'house' ? [[0.1, 0.42], [0.5, 0.9]] : [[0.12, 0.45], [0.55, 0.88]]) {
      b.box(-0.38, y0, 0.5, -0.04, y1, 0.75, p); b.box(0.04, y0, 0.5, 0.38, y1, 0.75, p);
      b.box(-0.38, y0, -0.75, -0.04, y1, -0.5, p); b.box(0.04, y0, -0.75, 0.38, y1, -0.5, p);
    }
    b.box(0.36, 0.46, 0.5, 0.42, 0.5, 1.6, C('#c9a84a')); b.box(0.36, 0.46, -1.6, 0.42, 0.5, -0.5, C('#c9a84a'));
  }
  const g = b.build();
  // x from 0 at the hinge to 1 at the latch
  g.translate(0.5, 0, 0);
  return g;
}

/** Leaf pools sized for the front doors of every enterable building plus inner doors of the built interiors. */
export function createDoors(w: World): DoorsState {
  const recs = w.city.buildingRecords ?? [];
  const cap: Record<DoorStyle, number> = {
    house: 8 + recs.filter((r) => r.door?.style === 'house').length,
    shop: 8 + recs.filter((r) => r.door?.style === 'shop').length,
    inner: I.innerDoorPool,
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  mat.name = 'door-leaves';
  const meshes = {} as Record<DoorStyle, THREE.InstancedMesh>;
  for (const s of STYLES) {
    const m = new THREE.InstancedMesh(leafGeometry(s), mat, cap[s]);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `doors-${s}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    w.scene.add(m);
    meshes[s] = m;
  }
  return { list: [], byId: new Map(), meshes, target: null, saved: new Map(), dirty: false };
}

const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0), col = new THREE.Color();

/** Leaf pose at an angle: hinge, the leaf's direction (hinge -> latch) and its middle. Allocation-free (out array). */
function pose(d: DoorObj, angle: number, out: Float64Array) {
  const pd = d.pd;
  const hw = pd.width / 2;
  const hx = pd.x + pd.ux * pd.hinge * hw + pd.nx * pd.depth, hz = pd.z + pd.uz * pd.hinge * hw + pd.nz * pd.depth;
  // closed: from the hinge across the opening; it turns toward side * n
  const e0x = -pd.ux * pd.hinge, e0z = -pd.uz * pd.hinge;
  const c = Math.cos(angle), s = Math.sin(angle) * d.side;
  const ex = e0x * c + pd.nx * s, ez = e0z * c + pd.nz * s;
  const L = pd.width - 0.012;
  out[0] = hx; out[1] = hz; out[2] = ex; out[3] = ez; out[4] = hx + ex * L / 2; out[5] = hz + ez * L / 2;
}
const P6 = new Float64Array(6);

function writeInstance(S: DoorsState, d: DoorObj) {
  const pd = d.pd;
  pose(d, d.angle, P6);
  const L = pd.width - 0.012;
  q4.setFromAxisAngle(yAxis, Math.atan2(-P6[3], P6[2]));
  p4.set(P6[0] + P6[2] * 0.006, pd.y + 0.005, P6[1] + P6[3] * 0.006);
  s4.set(L, pd.height - 0.01, I.leafThickness);
  if (d.hidden) s4.set(0, 0, 0);
  const m = S.meshes[d.style];
  m.setMatrixAt(d.inst, m4.compose(p4, q4, s4));
  m.instanceMatrix.needsUpdate = true;
}

/** Register a plan door (drawn closed, or at its saved state once its interior is active). */
export function addDoor(w: World, pd: PlanDoor, building: string, hidden = false): DoorObj {
  const S = w.doors;
  const old = S.byId.get(pd.id);
  if (old) { if (old.hidden !== hidden) { old.hidden = hidden; writeInstance(S, old); } return old; }
  const m = S.meshes[pd.style];
  // a full pool (more inner doors built at once than innerDoorPool) draws the extra leaves at instance 0's place:
  // never happens with the preset caps (maxActive x the biggest template's doors), checked by the interiors scenario
  const inst = m.count < m.instanceMatrix.count ? m.count++ : 0;
  const d: DoorObj = { id: pd.id, building, pd, style: pd.style, inst, angle: 0, target: 0, side: 1, open: false, body: null, collider: null, waited: 0, changed: false, hidden, locked: false };
  m.setColorAt(d.inst, col.setHex(pd.style === 'shop' ? 0xffffff : pd.colour).convertSRGBToLinear());
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  S.list.push(d);
  S.byId.set(d.id, d);
  writeInstance(S, d);
  return d;
}

/** The interior is built: the leaf becomes a kinematic body at its (saved) state. */
export function activateDoor(w: World, d: DoorObj): void {
  if (d.body) return;
  const R = w.R;
  d.hidden = false;
  const saved = w.doors.saved.get(d.id);
  if (saved !== undefined) { d.open = saved; d.target = d.angle = saved ? I.doorOpenAngle : 0; }
  pose(d, d.angle, P6);
  const yaw = Math.atan2(-P6[3], P6[2]);
  d.body = w.physics.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(P6[4], d.pd.y + d.pd.height / 2, P6[5]).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }));
  d.collider = w.physics.createCollider(R.ColliderDesc.cuboid((d.pd.width - 0.012) / 2, d.pd.height / 2 - 0.01, I.leafThickness / 2).setCollisionGroups(GROUPS.static).setFriction(0.6), d.body);
  w.city.solidTags.set(d.collider.handle, 'door');
  writeInstance(w.doors, d);
}

/** The interior is taken down: no body; the leaf is drawn closed (the cold plug is the doorway's collider again). */
export function deactivateDoor(w: World, d: DoorObj, hide: boolean): void {
  if (d.collider) w.city.solidTags.delete(d.collider.handle);
  if (d.body) w.physics.removeRigidBody(d.body);
  d.body = null; d.collider = null;
  d.angle = 0;
  d.target = d.open ? I.doorOpenAngle : 0;
  d.hidden = hide;
  writeInstance(w.doors, d);
}

/** Open or close a door (E). Doors that open away from you pick their side from where you stand. */
export function toggleDoor(w: World, d: DoorObj): void {
  if (!d.body) return;
  d.open = !d.open;
  if (d.open && d.angle < 0.02 && d.pd.swing === 'away') {
    const p = w.player.body.translation();
    d.side = (p.x - d.pd.x) * d.pd.nx + (p.z - d.pd.z) * d.pd.nz > 0 ? -1 : 1;
  }
  d.target = d.open ? I.doorOpenAngle : 0;
  d.waited = 0;
  d.changed = true;
  w.doors.saved.set(d.id, d.open);
  w.doors.dirty = true;
}

const shapeCache = new Map<string, RAPIER.Cuboid>();
/** Per physics step: swing doors toward their target, only into free space. */
export function updateDoors(w: World, dt: number): void {
  const S = w.doors;
  for (const d of S.list) {
    if (!d.body || Math.abs(d.target - d.angle) < 1e-4) continue;
    const step = Math.sign(d.target - d.angle) * Math.min(Math.abs(d.target - d.angle), I.doorSwingSpeed * dt);
    const next = d.angle + step;
    pose(d, d.angle, P6);
    const mx0 = P6[4], mz0 = P6[5];
    pose(d, next, P6);
    const yaw = Math.atan2(-P6[3], P6[2]);
    // the space the leaf moves into: the leaf at its next pose, thickened by doorClearance on the side it moves toward
    // only (so a door you lean on still opens away from you), checked against you and loose items
    let vx = P6[4] - mx0, vz = P6[5] - mz0;
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl; vz /= vl;
    const key = `${d.pd.width}:${d.pd.height}`;
    let sh = shapeCache.get(key);
    if (!sh) shapeCache.set(key, (sh = new w.R.Cuboid((d.pd.width - 0.012) / 2 + 0.02, d.pd.height / 2 - 0.02, I.leafThickness / 2 + I.doorClearance / 2)));
    ROT.y = Math.sin(yaw / 2); ROT.w = Math.cos(yaw / 2);
    POS.x = P6[4] + vx * I.doorClearance / 2; POS.y = d.pd.y + d.pd.height / 2; POS.z = P6[5] + vz * I.doorClearance / 2;
    let blocked = false;
    w.physics.intersectionsWithShape(POS, ROT, sh, (c) => {
      if (c === d.collider) return true;
      const pb = c.parent();
      if (c === w.player.collider || (pb && pb.isDynamic())) { blocked = true; return false; }
      return true;
    }, w.R.QueryFilterFlags.EXCLUDE_FIXED);
    if (blocked) { d.waited += dt; continue; }
    d.waited = 0;
    d.angle = next;
    POS.x = P6[4]; POS.z = P6[5];
    d.body.setNextKinematicTranslation(POS);
    d.body.setNextKinematicRotation(ROT);
    writeInstance(S, d);
  }
}
const POS = { x: 0, y: 0, z: 0 }, ROT = { x: 0, y: 0, z: 0, w: 1 };

/** The door the player is facing within reach (for the E prompt), or null. */
export function doorTarget(w: World): DoorObj | null {
  const p = w.player;
  if (p.vehicle || p.dead) return null;
  const t = p.body.translation();
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  let best: DoorObj | null = null, bs = Infinity;
  for (const d of w.doors.list) {
    if (d.hidden || (!d.body && !d.pd.front)) continue;
    pose(d, d.angle, P6);
    const dx = P6[4] - t.x, dz = P6[5] - t.z;
    if (Math.abs(t.y - (d.pd.y + 0.9)) > 1.4) continue;
    const dist = Math.hypot(dx, dz);
    if (dist > I.doorReach) continue;
    const dot = dist > 0.01 ? (dx * fx + dz * fz) / dist : 1;
    if (dot < I.doorFacing) continue;
    const score = dist - dot * 0.5;
    if (score < bs) { bs = score; best = d; }
  }
  return best;
}

/** Leaf centre (x, z) of a door now (tests and prompts). */
export function doorCentre(d: DoorObj): [number, number] {
  pose(d, d.angle, P6);
  return [P6[4], P6[5]];
}
