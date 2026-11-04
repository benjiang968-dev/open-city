// Pedestrians: walk routines between points of interest on the pavement graph, by archetype (adults,
// joggers, delivery workers, tourists, elderly people, parents with kids, dog walkers). They dodge and flee
// reckless drivers, get knocked down, react to being hit or shoved, and stop to talk. Dogs can be hurt too: they
// tumble, then limp back to their owner and stay at their legs until they recover. How many are out near the
// player follows the map's crowd density (pedDensity.ts: shops nearby, road class, time of day, scaled to the
// quality's pedestrian budget); people appear and leave out of view, and far ones are moved back to busy spots.
// Each has a kinematic capsule so the player bumps into (and shoves) them and thrown items bounce off.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { generateNpc, routineTarget, type NpcProfile, type Personality } from '../npc/npc';
import { reactAfterFlinch, hurtDog } from './npcReactions';
import { victimMaybeCalls } from './witness';
import { hurtBurst } from './hurtFx';
import type { Vehicle } from './vehicles';
import { say } from './bubbles';
import { LINES, pick } from '../npc/reactionLines';
import { GROUPS } from '../physicsGroups';
import { Rng } from '../rng';
import { walkRouter } from './map/cityMap';
import { updatePedDensity, pickSpawn, inCameraView } from './pedDensity';

const PT = TUNING.peds;
const AR = PT.archetypes;
const DG = TUNING.dogs;
/** People and dogs stand this far above the ground (no z-fighting with the pavement). */
const FOOT = 0.02;

export type PedState = 'walk' | 'idle' | 'flee' | 'dodge' | 'down' | 'talk' | 'flinch' | 'confront' | 'yell' | 'stumble' | 'follow' | 'phone' | 'look' | 'chase';
export type Archetype = 'adult' | 'jogger' | 'delivery' | 'tourist' | 'elderly' | 'parent' | 'kid' | 'dogwalker';
export type ArmPose = 'none' | 'phone' | 'film' | 'wave' | 'carry' | 'cane';

export interface DogState {
  pos: THREE.Vector3;
  heading: number;
  phase: number;
  scale: number;
  color: THREE.Color;
  barkCd: number;
  orbit: number;
  // hurt (M3): dogs can't die; they tumble, limp back to their owner and recover
  vel: THREE.Vector3; // velocity while tumbling after a hit
  tumbleT: number; // seconds of rolling left
  hurtT: number; // seconds of limping left
  lastHit: number; // w.time of the last hit
  roll: number; // sideways lean for the renderer (rolling over, limping)
  rollSide: number; // which side it rolls onto (-1 / 1)
  timesHurt: number;
}

export interface Ped {
  id: number;
  npc: NpcProfile;
  archetype: Archetype;
  active: boolean; // inside the quality budget
  hidden: boolean; // riding in the taxi etc.
  pos: THREE.Vector3;
  heading: number;
  state: PedState;
  route: THREE.Vector2[];
  routeIdx: number;
  targetPoi: number;
  timer: number;
  vel: THREE.Vector3; // used while flying/sliding after a hit and while dodging
  fleeDir: THREE.Vector2;
  walkPhase: number;
  moveAmount: number; // 0..1.4 limb swing amount (speed relative to a walk)
  speedingCd: number;
  offset: number; // personal lateral offset so crowds don't walk single file
  /** Set while someone is waiting at this ped as a taxi fare (taxi system owns them). */
  reserved: boolean;
  health: number; // 0..100; at 0 they are knocked out for a while
  hitCount: number; // hits by the player within the repeat window
  lastHitByPlayer: number;
  lastShoved: number;
  shoveCount: number;
  shoutT: number; // countdown to the next shout while confronting
  // looks
  scale: number;
  tilt: number; // lean (stagger, lying down)
  armPose: ArmPose;
  prop: 'none' | 'camera' | 'parcel' | 'cane';
  shirt: THREE.Color;
  pants: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  speedMul: number;
  followId: number; // kid -> parent
  dog: DogState | null;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  // witnesses (M2.8)
  phoneT: number; // seconds left on a 999 call / filming
  phoneMode: 'call' | 'film' | null;
  report: { x: number; z: number; heat: number; kind: string } | null;
  /** Kids are never targets: things pass them by and they always dodge cars. (Dogs can be hurt: see hurtDog.) */
  protectedTarget: boolean;
  solid: boolean; // capsule currently enabled
}

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'];
const SHIRT = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#e9c46a', '#6a4c93', '#ffffff', '#1d3557', '#ff8fab', '#8ac926', '#ff595e', '#3a86ff'];
const PANTS = ['#2b2d42', '#3d405b', '#5c4033', '#264653', '#6c757d', '#1b263b', '#a68a64'];
const HAIR = ['#2b1d0e', '#4a2c17', '#b5651d', '#e6c27a', '#111111', '#7f7f7f', '#a83232'];
const SPORT = ['#39ff14', '#ff3fa4', '#00e5ff', '#ffea00', '#ff6d00'];
const TOURIST = ['#ff9f1c', '#2ec4b6', '#e71d36', '#f4d35e', '#9b5de5'];
const MUTED = ['#8d99ae', '#a68a64', '#6b705c', '#b7b7a4', '#7f5539'];
const GREY_HAIR = ['#d9d9d9', '#bfbfbf', '#eeeeee'];

function pickArchetype(rng: Rng): Exclude<Archetype, 'kid' | 'parent'> | 'family' {
  const entries = Object.entries(AR) as [string, { weight: number }][];
  let r = rng.next() * entries.reduce((a, [, v]) => a + v.weight, 0);
  for (const [k, v] of entries) {
    r -= v.weight;
    if (r <= 0) return k as Exclude<Archetype, 'kid' | 'parent'> | 'family';
  }
  return 'adult';
}

function makePed(w: World, id: number, rng: Rng, archetype: Archetype, startX: number, startZ: number, startY = NaN): Ped {
  const npc = generateNpc(id, rng, w.city);
  npc.archetype = archetype;
  const C = (a: readonly string[]) => new THREE.Color(rng.pick(a as string[]));
  const spec = AR[archetype === 'kid' || archetype === 'parent' ? 'family' : archetype];
  let scale = rng.range(spec.scale[0], spec.scale[1]);
  let shirt = C(SHIRT), pants = C(PANTS), hair = C(HAIR);
  let prop: Ped['prop'] = 'none';
  const pers = (opts: Personality[]) => (npc.personality = rng.pick(opts));
  switch (archetype) {
    case 'jogger': shirt = C(SPORT); pants = new THREE.Color('#1b1b1f'); break;
    case 'delivery': shirt = new THREE.Color('#2f7d32'); pants = new THREE.Color('#3e2c1c'); prop = 'parcel'; npc.job = 'courier'; break;
    case 'tourist': shirt = C(TOURIST); prop = 'camera'; npc.job = 'tourist'; pers(['chatty', 'posh', 'friendly', 'laidback']); break;
    case 'elderly': shirt = C(MUTED); hair = C(GREY_HAIR); prop = rng.chance(0.6) ? 'cane' : 'none'; npc.job = rng.pick(['retired teacher', 'retired fisher', 'retired nurse']); break;
    case 'kid': scale = PT.kidScale; shirt = C(SPORT); npc.job = 'school kid'; pers(['chatty', 'nervous', 'friendly']); break;
    default: break;
  }
  const R = w.R;
  const ground = w.city.heightAt(startX, startZ, startY);
  const body = w.physics.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(startX, ground + 0.95 * scale, startZ));
  const collider = w.physics.createCollider(R.ColliderDesc.capsule(0.55 * scale, 0.3 * scale).setCollisionGroups(GROUPS.ped), body);
  w.colliderOwner.set(collider.handle, { kind: 'ped', id });
  return {
    id, npc, archetype, active: true, hidden: false, pos: new THREE.Vector3(startX, ground + FOOT, startZ), heading: rng.range(0, 6.28),
    state: 'idle', route: [], routeIdx: 0, targetPoi: -1, timer: rng.range(0, 3), vel: new THREE.Vector3(), fleeDir: new THREE.Vector2(),
    walkPhase: rng.range(0, 6), moveAmount: 0, speedingCd: 0, offset: rng.range(-0.9, 0.9), reserved: false,
    health: 100, hitCount: 0, lastHitByPlayer: -100, lastShoved: -100, shoveCount: 0, shoutT: 0,
    scale, tilt: 0, armPose: 'none', prop, shirt, pants, skin: C(SKIN), hair, speedMul: spec.speed, followId: -1, dog: null,
    body, collider, phoneT: 0, phoneMode: null, report: null, protectedTarget: archetype === 'kid', solid: true,
  };
}

export function spawnPeds(w: World): void {
  const rng = new Rng(w.seed ^ 0x9ed);
  const nodes = w.city.walk.nodes;
  // every archetype appears near the start of the list, so even the Low budget has one of each
  const guaranteed: ReturnType<typeof pickArchetype>[] = ['dogwalker', 'family', 'tourist', 'jogger', 'delivery', 'elderly', 'dogwalker', 'tourist'];
  while (w.peds.length < PT.maxPopulation) {
    const a = guaranteed.length ? guaranteed.shift()! : pickArchetype(rng);
    const start = rng.pick(nodes);
    if (a === 'family') {
      if (w.peds.length + 2 > PT.maxPopulation) continue;
      const parent = makePed(w, w.peds.length, rng, 'parent', start.x, start.z, start.y);
      w.peds.push(parent);
      const kid = makePed(w, w.peds.length, rng, 'kid', start.x + 0.8, start.z, start.y);
      kid.followId = parent.id;
      kid.state = 'follow';
      kid.npc.homePoi = parent.npc.homePoi;
      w.peds.push(kid);
    } else {
      const p = makePed(w, w.peds.length, rng, a, start.x, start.z, start.y);
      if (a === 'dogwalker') {
        p.dog = {
          pos: new THREE.Vector3(start.x + 1.5, w.city.heightAt(start.x + 1.5, start.z, start.y) + FOOT, start.z), heading: 0, phase: 0, scale: rng.range(0.8, 1.2),
          color: new THREE.Color(rng.pick(['#8d5524', '#e0c9a6', '#2b2b2b', '#c68642', '#f5f5f5'])), barkCd: 0, orbit: rng.range(0, 6),
          vel: new THREE.Vector3(), tumbleT: 0, hurtT: 0, lastHit: -100, roll: 0, rollSide: 1, timesHurt: 0,
        };
      }
      w.peds.push(p);
    }
  }
  // everyone starts off-stage; the crowd around the spawn is then filled to the map's density target
  for (const p of w.peds) setActive(p, false);
  updatePedDensity(w, 0, true);
  for (let guard = 0; countActive(w) < w.pedDensity.target && guard < w.peds.length; guard++) if (!activateOne(w)) break;
  w.pedDensity.added = 0;
}

/** Turn a person (and the kid walking with them) on or off. Off: no capsule, not drawn, not simulated. */
function setActive(p: Ped, on: boolean): void {
  p.active = on;
  p.solid = on && !p.hidden;
  p.body.setEnabled(p.solid);
}

/** Bring someone on-stage right where they are now (a taxi fare taken from off-stage at a quiet hour). */
export function bringOnStage(w: World, p: Ped): void {
  if (p.active) return;
  setActive(p, true);
  for (const kid of w.peds) if (kid.followId === p.id) setActive(kid, true);
  w.pedDensity.added++;
}

function countActive(w: World): number {
  let n = 0;
  for (const p of w.peds) if (p.active) n++;
  return n;
}

/** A person who may be taken off-stage now (not busy with you, a fare, a call or a chase; kids go with their parent). */
function canLeave(p: Ped): boolean {
  return p.active && !p.reserved && !p.hidden && p.followId < 0 && (p.state === 'walk' || p.state === 'idle') && p.phoneMode === null;
}

/**
 * Quality changed (pause menu): never more people than the new budget (the farthest leave first); a bigger budget
 * fills up gradually as the density target allows.
 */
export function applyPedBudget(w: World): void {
  updatePedDensity(w, 0, true);
  const pp = w.player.mesh.position;
  for (let guard = 0; countActive(w) > w.settings.pedBudget && guard < w.peds.length; guard++) {
    let best: Ped | null = null, bd = -1;
    for (const p of w.peds) {
      if (!canLeave(p)) continue;
      const d = Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z);
      if (d > bd) { bd = d; best = p; }
    }
    if (!best) break;
    deactivate(w, best);
  }
}

function deactivate(w: World, p: Ped): void {
  setActive(p, false);
  for (const kid of w.peds) if (kid.followId === p.id && kid.active) setActive(kid, false);
  w.pedDensity.removed++;
}

let activateCursor = 0;
const SPAWN = { x: 0, y: 0, z: 0 };
/** Bring one person (a parent brings their kid) on-stage at a busy spot near you, out of view. */
function activateOne(w: World): boolean {
  const n = w.peds.length;
  for (let k = 0; k < n; k++) {
    activateCursor = (activateCursor + 1) % n;
    const p = w.peds[activateCursor];
    if (p.active || p.followId >= 0 || p.reserved) continue;
    if (!pickSpawn(w, p.archetype === 'jogger' || p.archetype === 'dogwalker', SPAWN)) return false;
    setActive(p, true);
    placeAt(w, p, SPAWN.x, SPAWN.y, SPAWN.z);
    for (const kid of w.peds) if (kid.followId === p.id) setActive(kid, true);
    w.pedDensity.added++;
    return true;
  }
  return false;
}

/** Leave one person: the farthest who may leave, at least despawnMinDist away and out of view. */
function deactivateOne(w: World): boolean {
  const pp = w.player.mesh.position;
  let best: Ped | null = null, bd = PT.density.despawnMinDist;
  for (const p of w.peds) {
    if (!canLeave(p)) continue;
    const d = Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z);
    if (d <= bd || inCameraView(w, p.pos.x, p.pos.z)) continue;
    bd = d;
    best = p;
  }
  if (!best) return false;
  deactivate(w, best);
  return true;
}

let changeAcc = 0;
/** Follow the density target around the player: add or remove a few people a second, always out of view. */
function followDensity(w: World, dt: number): void {
  const S = w.pedDensity;
  w.camera.updateMatrixWorld(); // view tests read it (fast-forwarded test frames don't render)
  updatePedDensity(w, dt);
  let active = 0, near = 0;
  const pp = w.player.mesh.position, R = PT.density.radius;
  for (const p of w.peds) {
    if (!p.active) continue;
    active++;
    if (Math.abs(p.pos.x - pp.x) < R && Math.abs(p.pos.z - pp.z) < R && Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z) < R) near++;
  }
  S.active = active;
  S.near = near;
  changeAcc = Math.min(1, changeAcc + dt * PT.density.changesPerSecond);
  if (changeAcc < 1) return;
  const slack = PT.density.slack;
  if (active < S.target - slack) { if (activateOne(w)) changeAcc = 0; }
  else if (active > S.target + slack) { if (deactivateOne(w)) changeAcc = 0; }
}

/**
 * Shortest walk over the walk graph from the node nearest the person to the target POI's node (or, with
 * `poiId` < 0, to walk node `node`). Dog walkers and joggers prefer the towpath, the waterfront and park paths.
 */
export function planRoute(w: World, ped: Ped, poiId: number, node = -1): void {
  const city = w.city;
  const poi = poiId >= 0 ? city.pois[poiId] : null;
  const nodes = city.walk.nodes;
  const goal = poi ? poi.walkNode : node;
  if (goal < 0) { ped.state = 'idle'; ped.timer = 2; return; }
  const start = city.nearestWalk(ped.pos.x, ped.pos.z, ped.pos.y);
  const router = walkRouter(city);
  const outdoorish = ped.archetype === 'jogger' || ped.archetype === 'dogwalker';
  const n = outdoorish ? router.path(start, goal, w.pedDensity.routeCost, PT.density.outdoorRouteCost) : router.path(start, goal);
  // reuse this person's waypoint vectors (routes are planned often)
  const route = ped.route;
  const count = Math.max(0, n) + 1;
  while (route.length < count) route.push(new THREE.Vector2());
  route.length = count;
  for (let i = 0; i < count; i++) if (!(route[i] instanceof THREE.Vector2)) route[i] = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    const s = nodes[router.nodes[i]];
    route[i].set(s.x + ped.offset * 0.5, s.z + ped.offset * 0.5);
  }
  route[count - 1].set((poi ? poi.x : nodes[goal].x) + ped.offset, (poi ? poi.z : nodes[goal].z) + ped.offset * 0.3);
  ped.routeIdx = 0;
  ped.targetPoi = poiId;
  ped.state = 'walk';
  ped.tilt = 0;
}

const KIND_SETS: Partial<Record<Archetype, readonly string[]>> = {
  jogger: ['park', 'beach', 'pier', 'marina'],
  delivery: ['shop', 'market', 'diner', 'cafe', 'garage', 'office', 'hotel'],
  tourist: ['pier', 'marina', 'beach', 'park', 'hotel', 'market', 'cafe', 'museum', 'monument'],
  dogwalker: ['park', 'beach', 'pier'],
};
const ELDERLY_SET: readonly string[] = ['park', 'cafe', 'shop', 'clinic', 'diner', 'church'];

/** A random place of one of `kinds` within `range` of (x, z) (not `skip`), or -1. One pass, no allocation. */
function randomPoi(w: World, kinds: readonly string[], x: number, z: number, range: number, skip: number): number {
  let pick = -1, seen = 0;
  for (const p of w.city.pois) {
    if (p.id === skip || Math.abs(p.x - x) > range || Math.abs(p.z - z) > range || !kinds.includes(p.kind)) continue;
    if (Math.hypot(p.x - x, p.z - z) > range) continue;
    if (Math.random() * ++seen < 1) pick = p.id; // reservoir sampling
  }
  return pick;
}

/**
 * Pick where to go next and plan the walk there. Dog walkers and joggers mostly head for a towpath or waterfront
 * spot (else a park or pier); people on a busy street often pop into a shop or cafe nearby (the crowd stays where
 * the shops are); otherwise the routine (home, work, errands by the hour).
 */
function wander(w: World, ped: Ped): void {
  const D = PT.density;
  const x = ped.pos.x, z = ped.pos.z;
  if ((ped.archetype === 'jogger' || ped.archetype === 'dogwalker') && Math.random() < D.outdoorTripChance) {
    const nodes = w.pedDensity.outdoorNodes, W = w.city.walk.nodes;
    for (let tries = 0; tries < 12 && nodes.length; tries++) {
      const n = W[nodes[Math.floor(Math.random() * nodes.length)]];
      const d = Math.hypot(n.x - x, n.z - z);
      if (d > 40 && d < D.outdoorTripRange) { planRoute(w, ped, -1, n.id); return; }
    }
  }
  const set = KIND_SETS[ped.archetype];
  if (set) {
    const id = randomPoi(w, set, x, z, 420, ped.targetPoi);
    if (id >= 0) { planRoute(w, ped, id); return; }
  }
  if (ped.archetype === 'elderly' && Math.random() < 0.7) {
    const home = w.city.pois[ped.npc.homePoi];
    const id = randomPoi(w, ELDERLY_SET, home.x, home.z, 260, ped.targetPoi);
    if (id >= 0) { planRoute(w, ped, id); return; }
  }
  if (Math.random() < D.errandChance) {
    const id = randomPoi(w, D.shopKinds, x, z, D.errandRange, ped.targetPoi);
    if (id >= 0) { planRoute(w, ped, id); return; }
  }
  const want = routineTarget(ped.npc, w.dayNight.hour);
  if (want !== ped.targetPoi) { planRoute(w, ped, want); return; }
  // already at the routine stop: wander to something nearby to keep the streets alive
  const id = randomPoi(w, D.shopKinds, x, z, 260, ped.targetPoi);
  planRoute(w, ped, id >= 0 ? id : want);
}

function idleTime(ped: Ped): number {
  const base = PT.idleTimeMin + Math.random() * (PT.idleTimeMax - PT.idleTimeMin);
  if (ped.archetype === 'jogger') return 1 + Math.random() * 3;
  if (ped.archetype === 'delivery') return 3 + Math.random() * 3;
  if (ped.archetype === 'elderly') return base * 1.8;
  return base;
}

const tmp = new THREE.Vector3();
const CAR_POS = new THREE.Vector3();
const CAR_VEL = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const KIN = { x: 0, y: 0, z: 0 };
let recycleCursor = 0;

export function updatePeds(w: World, dt: number): void {
  const pv = w.player.vehicle;
  let carPos: THREE.Vector3 | null = null;
  let carVel: THREE.Vector3 | null = null;
  let carSpeed = 0;
  if (pv) {
    const t = pv.body.translation();
    const lv = pv.body.linvel();
    carPos = CAR_POS.set(t.x, t.y, t.z);
    carVel = CAR_VEL.set(lv.x, 0, lv.z);
    carSpeed = carVel.length();
    fwd.set(Math.sin(pv.heading), 0, Math.cos(pv.heading));
    right.set(-fwd.z, 0, fwd.x);
  }
  const pp = w.player.mesh.position;

  for (const ped of w.peds) {
    if (!ped.active) continue;
    ped.speedingCd -= dt;
    let moveSpeed = 0;

    if (ped.hidden || ped.pos.y < -10) continue; // riding in the player's taxi
    const prevX = ped.pos.x, prevZ = ped.pos.z; // to step back out of walls and water

    // ---- reactions to the player's car ----
    if (pv && carPos && carVel && ped.state !== 'down') {
      tmp.copy(ped.pos).sub(carPos);
      const lz = tmp.dot(fwd), lx = tmp.dot(right);
      const hx = pv.spec.halfExtents[0] + 0.35, hz = pv.spec.halfExtents[2] + 0.35;
      const dist = Math.hypot(tmp.x, tmp.z);
      if (Math.abs(lx) < hx && Math.abs(lz) < hz && ped.pos.y < carPos.y + 1.2) {
        if (carSpeed > PT.hitSpeed && !ped.protectedTarget) {
          knockDown(w, ped, carVel, carSpeed);
          continue;
        }
        // gentle bump (or a kid leaping clear): shove aside
        ped.pos.addScaledVector(right, Math.sign(lx || 1) * (hx - Math.abs(lx) + (ped.protectedTarget ? 0.6 : 0.05)));
      } else if (ped.state !== 'dodge' && ped.state !== 'talk' && carSpeed > PT.dodgeCarSpeed && dist < PT.dodgeDistance + carSpeed * 0.4) {
        // car heading at me? jump out of the way
        const closing = -(tmp.x * carVel.x + tmp.z * carVel.z) / Math.max(1, dist);
        if (closing > carSpeed * 0.6 && Math.abs(lx) < 3.5 && lz > 0) {
          ped.state = 'dodge';
          ped.timer = 0.6;
          const side = Math.sign(lx || (Math.random() - 0.5));
          ped.vel.set(right.x * side * 5.5, 0, right.z * side * 5.5);
        }
      }
      if (ped.speedingCd <= 0 && dist < 14 && carSpeed > 70 / 3.6) {
        ped.speedingCd = 20;
        emit(w, { type: 'speeding', x: ped.pos.x, z: ped.pos.z, speed: carSpeed });
      }
    }

    // a kid sticks with their parent unless something dramatic is happening
    const parent = ped.followId >= 0 ? w.peds[ped.followId] : null;
    if (parent && (ped.state === 'walk' || ped.state === 'idle' || ped.state === 'follow')) {
      if (parent.state === 'flee') startFlee(ped, pp.x, pp.z, parent.timer);
      else ped.state = 'follow';
    }

    ped.armPose = 'none';
    switch (ped.state) {
      case 'down': {
        ped.timer -= dt;
        if (ped.pos.y > w.city.heightAt(ped.pos.x, ped.pos.z, ped.pos.y) + FOOT || ped.vel.y > 0) {
          ped.vel.y -= 22 * dt;
          ped.pos.addScaledVector(ped.vel, dt);
          ped.tilt = Math.max(-Math.PI / 2, ped.tilt - dt * 7);
          const ground = w.city.heightAt(ped.pos.x, ped.pos.z, ped.pos.y) + FOOT;
          if (ped.pos.y <= ground) { ped.pos.y = ground; ped.vel.set(ped.vel.x * 0.3, 0, ped.vel.z * 0.3); }
        } else {
          ped.pos.addScaledVector(ped.vel, dt);
          ped.pos.y = w.city.heightAt(ped.pos.x, ped.pos.z, ped.pos.y) + FOOT;
          ped.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
          ped.tilt = -Math.PI / 2;
        }
        if (ped.timer <= 0) {
          ped.tilt = 0;
          ped.health = Math.max(ped.health, TUNING.reactions.healthAfterGettingUp);
          startFlee(ped, pp.x, pp.z);
        }
        break;
      }
      case 'flinch': {
        ped.timer -= dt;
        ped.tilt = -Math.sin((1 - ped.timer / TUNING.reactions.flinchTime) * Math.PI) * 0.35;
        ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        if (ped.timer <= 0) {
          ped.tilt = 0;
          reactAfterFlinch(w, ped);
        }
        break;
      }
      case 'stumble': {
        ped.timer -= dt;
        ped.tilt = Math.sin((1 - ped.timer / TUNING.reactions.stumbleTime) * Math.PI) * 0.3;
        if (ped.timer <= 0) {
          ped.tilt = 0;
          ped.state = ped.followId >= 0 ? 'follow' : ped.route.length && ped.routeIdx < ped.route.length ? 'walk' : 'idle';
          ped.timer = 1;
        }
        break;
      }
      case 'confront': {
        ped.timer -= dt;
        ped.shoutT -= dt;
        const dx = pp.x - ped.pos.x, dz = pp.z - ped.pos.z, d = Math.hypot(dx, dz);
        ped.heading = Math.atan2(dx, dz);
        if (d > TUNING.reactions.confrontDistance && d < 25) {
          const sp = PT.walkSpeed * 1.3;
          ped.pos.x += (dx / d) * sp * dt;
          ped.pos.z += (dz / d) * sp * dt;
          moveSpeed = sp;
        }
        if (ped.shoutT <= 0) {
          ped.shoutT = 2.6;
          say(w, ped, pick(LINES.confront), 2.2, `ped${ped.id}`);
        }
        if (ped.timer <= 0 || d > 30) wander(w, ped);
        break;
      }
      case 'look': {
        // stopped to stare at a commotion (a car alarm): faces you, then carries on where they were going
        ped.timer -= dt;
        ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        if (ped.timer <= 0) {
          ped.state = ped.followId >= 0 ? 'follow' : ped.route.length && ped.routeIdx < ped.route.length ? 'walk' : 'idle';
          ped.timer = 1;
        }
        break;
      }
      case 'chase': {
        // a car owner running after the thief, shouting (started by carTheft.ts); then they may call 999
        const TH = TUNING.theft;
        ped.timer -= dt;
        ped.shoutT -= dt;
        const dx = pp.x - ped.pos.x, dz = pp.z - ped.pos.z, d = Math.hypot(dx, dz);
        ped.heading = Math.atan2(dx, dz);
        if (d > TUNING.reactions.confrontDistance) {
          const sp = PT.fleeSpeed * TH.ownerRunFactor * (ped.archetype === 'elderly' ? 0.45 : 1);
          ped.pos.x += (dx / d) * sp * dt;
          ped.pos.z += (dz / d) * sp * dt;
          moveSpeed = sp;
        }
        if (ped.shoutT <= 0) {
          ped.shoutT = TH.shoutEvery;
          say(w, ped, pick(LINES.carOwner), 2.2, `ped${ped.id}`);
        }
        if (ped.timer <= 0 || d > TH.ownerGiveUpDistance) {
          if (!victimMaybeCalls(w, ped)) {
            ped.state = 'yell';
            ped.timer = TUNING.reactions.yellTime;
            say(w, ped, pick(LINES.carOwnerGaveUp), 2.2, `ped${ped.id}`);
          }
        }
        break;
      }
      case 'yell': {
        ped.timer -= dt;
        ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        // a dog owner screams first, then calls 999 (the witness system has set their report)
        if (ped.timer <= 0 && !victimMaybeCalls(w, ped)) wander(w, ped);
        break;
      }
      case 'phone': {
        // on the phone to 999 (or filming): stands still, phone visible, faces the scene
        ped.armPose = ped.phoneMode === 'film' ? 'film' : 'phone';
        if (ped.report) ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        break; // the witness system advances the timer and decides what happens next
      }
      case 'dodge': {
        ped.timer -= dt;
        ped.pos.addScaledVector(ped.vel, dt);
        moveSpeed = 5.5;
        ped.heading = Math.atan2(ped.vel.x, ped.vel.z);
        if (ped.timer <= 0) startFlee(ped, carPos?.x ?? ped.pos.x, carPos?.z ?? ped.pos.z, 3);
        break;
      }
      case 'flee': {
        ped.timer -= dt;
        const sp = PT.fleeSpeed * (ped.archetype === 'elderly' ? 0.45 : ped.archetype === 'kid' ? 0.9 : 1);
        ped.pos.x += ped.fleeDir.x * sp * dt;
        ped.pos.z += ped.fleeDir.y * sp * dt;
        moveSpeed = sp;
        ped.heading = Math.atan2(ped.fleeDir.x, ped.fleeDir.y);
        if (ped.timer <= 0) {
          if (ped.followId >= 0) ped.state = 'follow';
          else wander(w, ped);
        }
        break;
      }
      case 'idle': {
        ped.timer -= dt;
        if (ped.archetype === 'tourist' && ped.timer > 1.5 && ped.timer < 5) ped.armPose = 'film'; // taking photos
        if (ped.timer <= 0 && !ped.reserved) wander(w, ped);
        break;
      }
      case 'talk': {
        ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        break;
      }
      case 'follow': {
        if (!parent || !parent.active) { ped.state = 'idle'; ped.timer = 2; break; }
        // walk at the parent's side
        const side = 0.9;
        const tx = parent.pos.x + Math.cos(parent.heading) * side, tz = parent.pos.z - Math.sin(parent.heading) * side;
        const dx = tx - ped.pos.x, dz = tz - ped.pos.z, d = Math.hypot(dx, dz);
        if (d > 8) { ped.pos.set(tx, w.city.heightAt(tx, tz, parent.pos.y) + FOOT, tz); break; }
        if (d > 0.25) {
          const sp = Math.min(PT.walkSpeed * 1.8, d * 2.2);
          ped.pos.x += (dx / d) * sp * dt;
          ped.pos.z += (dz / d) * sp * dt;
          moveSpeed = sp;
          ped.heading = Math.atan2(dx, dz);
        } else ped.heading = parent.heading;
        break;
      }
      case 'walk': {
        const wp = ped.route[ped.routeIdx];
        if (!wp) { ped.state = 'idle'; ped.timer = 1; break; }
        const dx = wp.x - ped.pos.x, dz = wp.y - ped.pos.z;
        const d = Math.hypot(dx, dz);
        let speed = PT.walkSpeed * ped.speedMul * (0.85 + 0.3 * ((ped.id * 37) % 10) / 10);
        if (d < 0.4) {
          ped.routeIdx++;
          if (ped.routeIdx >= ped.route.length) {
            ped.state = 'idle';
            ped.timer = idleTime(ped);
          }
          break;
        }
        // wait at the kerb if a car is about to cross our path
        if (crossingBlocked(w, ped, dx / d, dz / d)) speed = 0;
        ped.pos.x += (dx / d) * speed * dt;
        ped.pos.z += (dz / d) * speed * dt;
        moveSpeed = speed;
        const target = Math.atan2(dx, dz);
        ped.heading += Math.atan2(Math.sin(target - ped.heading), Math.cos(target - ped.heading)) * Math.min(1, dt * 8);
        if (ped.archetype === 'delivery') ped.armPose = 'carry';
        break;
      }
    }
    if (ped.prop === 'cane' && ped.armPose === 'none' && ped.state !== 'down') ped.armPose = 'cane';
    if (ped.reserved && ped.state === 'idle') ped.armPose = 'wave';

    // off-route movement keeps out of buildings, water and the map edge (slides along walls)
    if (ped.state === 'flee' || ped.state === 'dodge' || ped.state === 'down' || ped.state === 'confront' || ped.state === 'stumble' || ped.state === 'chase') keepOutOfBlocked(w, ped, prevX, prevZ);
    // stand on the ground (hills); a knocked-down person handles their own fall
    if (ped.state !== 'down') ped.pos.y = w.city.heightAt(ped.pos.x, ped.pos.z, ped.pos.y) + FOOT;

    ped.walkPhase += moveSpeed * dt * 3.2 / Math.max(0.6, ped.scale);
    ped.moveAmount = ped.state === 'down' ? 0 : Math.min(1.4, moveSpeed / PT.walkSpeed);
    if (ped.dog) {
      if (pv && carPos) dogVsCar(w, ped, pv, carSpeed);
      updateDog(w, ped, dt, moveSpeed);
    }

    // capsule (off while lying down). Its position is only pushed to Rapier near the player: nothing else
    // touches it, and every Rapier body write allocates. Far capsules keep their last spot until you come
    // close (toggling them on/off instead made whole groups re-enter the broad phase at once).
    const solid = ped.state !== 'down';
    if (ped.solid !== solid) {
      ped.solid = solid;
      ped.body.setEnabled(solid);
    }
    if (solid && Math.abs(ped.pos.x - pp.x) < PT.capsuleRange && Math.abs(ped.pos.z - pp.z) < PT.capsuleRange) {
      KIN.x = ped.pos.x; KIN.y = ped.pos.y + 0.95 * ped.scale; KIN.z = ped.pos.z;
      ped.body.setNextKinematicTranslation(KIN);
    }
  }
  followDensity(w, dt);
  recycleFarPeds(w);
}

/** The player's car against a dog (uses the car frame set up at the top of updatePeds). */
function dogVsCar(w: World, ped: Ped, pv: Vehicle, carSpeed: number) {
  const d = ped.dog!;
  if (d.tumbleT > 0) return; // already flying
  tmp.copy(d.pos).sub(CAR_POS);
  const lz = tmp.dot(fwd), lx = tmp.dot(right);
  const hx = pv.spec.halfExtents[0] + 0.3, hz = pv.spec.halfExtents[2] + 0.3;
  if (Math.abs(lx) >= hx || Math.abs(lz) >= hz || d.pos.y > CAR_POS.y + 1.2) return;
  if (carSpeed > PT.hitSpeed && w.time - d.lastHit > DG.carRehitTime) {
    // thrown forward and out to the side it was on
    const side = Math.sign(lx || 1) * carSpeed * DG.carSideFling;
    if (hurtDog(w, ped, 'car', carSpeed, CAR_VEL.x + right.x * side, CAR_VEL.z + right.z * side, pv.spec.label)) return;
  }
  // a slow bump (or still under the car that just hit it): nudged aside
  d.pos.addScaledVector(right, Math.sign(lx || 1) * (hx - Math.abs(lx) + 0.05));
}

/** Knocked over: thrown away from the blow, rolls onto its side. Called by hurtDog. */
export function tumbleDog(d: DogState, strength: number, dirX: number, dirZ: number): void {
  const l = Math.hypot(dirX, dirZ) || 1;
  const k = Math.min(DG.maxKnockback, strength * DG.knockbackPerStrength);
  d.vel.set((dirX / l) * k, Math.min(DG.maxHop, DG.hopBase + strength * DG.hopPerStrength), (dirZ / l) * k);
  d.tumbleT = DG.tumbleTimeMax * Math.min(1, Math.max(0.3, strength / DG.tumbleFullAt));
  d.rollSide = Math.random() < 0.5 ? -1 : 1;
  d.hurtT = Math.min(DG.maxLimpTime, Math.max(0, d.hurtT) + DG.limpTime);
  d.timesHurt++;
}

function updateDog(w: World, ped: Ped, dt: number, walkerSpeed: number) {
  const d = ped.dog!;
  d.barkCd -= dt;
  if (d.tumbleT > 0 || d.pos.y > w.city.heightAt(d.pos.x, d.pos.z, d.pos.y) + FOOT) {
    // rolling over after a hit
    d.tumbleT -= dt;
    d.vel.y -= DG.gravity * dt;
    d.pos.addScaledVector(d.vel, dt);
    const ground = w.city.heightAt(d.pos.x, d.pos.z, d.pos.y) + FOOT;
    if (d.pos.y <= ground) {
      d.pos.y = ground;
      d.vel.y = 0;
      const f = Math.max(0, 1 - dt * DG.groundFriction);
      d.vel.x *= f;
      d.vel.z *= f;
    }
    d.roll += (d.rollSide * 1.45 - d.roll) * Math.min(1, dt * 14);
    d.phase += dt * 30; // legs scramble
    return;
  }
  if (d.hurtT > 0) {
    // limp back to the owner and stay pressed against their side
    d.hurtT -= dt;
    const tx = ped.pos.x + Math.sin(ped.heading) * 0.15 + Math.cos(ped.heading) * 0.5, tz = ped.pos.z + Math.cos(ped.heading) * 0.15 - Math.sin(ped.heading) * 0.5;
    const dx = tx - d.pos.x, dz = tz - d.pos.z, dist = Math.hypot(dx, dz);
    if (dist > 0.2) {
      const sp = Math.min(DG.runToOwnerSpeed, dist * 4);
      d.pos.x += (dx / dist) * sp * dt;
      d.pos.z += (dz / dist) * sp * dt;
      d.pos.y = w.city.heightAt(d.pos.x, d.pos.z, d.pos.y) + FOOT;
      d.heading = Math.atan2(dx, dz);
      d.phase += sp * dt * 6;
    } else d.heading = ped.heading;
    // lurch on the bad leg while moving, settle (back on its feet after a tumble) while standing
    const lean = dist > 0.2 ? Math.sin(d.phase * 0.5) * DG.limpRoll : 0;
    d.roll += (lean - d.roll) * Math.min(1, dt * 10);
    if (d.hurtT <= 0) d.roll = 0;
    return;
  }
  d.roll = 0;
  d.orbit += dt * 0.6;
  // trot around the walker on an imaginary leash
  const tx = ped.pos.x + Math.cos(ped.heading) * 1.1 + Math.sin(d.orbit) * 0.6, tz = ped.pos.z - Math.sin(ped.heading) * 1.1 + Math.sin(ped.heading) * 0.8 + Math.cos(d.orbit) * 0.6;
  const dx = tx - d.pos.x, dz = tz - d.pos.z, dist = Math.hypot(dx, dz);
  if (dist > 6) d.pos.set(tx, w.city.heightAt(tx, tz, ped.pos.y) + FOOT, tz);
  else if (dist > 0.1) {
    const sp = Math.min(Math.max(walkerSpeed * 1.3, 1.2), dist * 3);
    d.pos.x += (dx / dist) * sp * dt;
    d.pos.z += (dz / dist) * sp * dt;
    d.pos.y = w.city.heightAt(d.pos.x, d.pos.z, d.pos.y) + FOOT;
    d.heading = Math.atan2(dx, dz);
    d.phase += sp * dt * 6;
  }
  const pp = w.player.mesh.position;
  const pd = Math.hypot(pp.x - d.pos.x, pp.z - d.pos.z);
  if (pd < PT.dogBarkDistance && d.barkCd <= 0 && !w.player.vehicle) {
    d.barkCd = PT.dogBarkCooldown;
    d.heading = Math.atan2(pp.x - d.pos.x, pp.z - d.pos.z);
    say(w, d, pick(LINES.bark), 1.4, `dog${ped.id}`);
  }
}

/**
 * Keep the crowd around the player: a far-away walker (out of view) is moved back to a busy spot near you (or,
 * with more people out than the density target, leaves). Two checked per frame.
 */
function recycleFarPeds(w: World) {
  if (!w.peds.length) return;
  for (let k = 0; k < 2; k++) {
    recycleCursor = (recycleCursor + 1) % w.peds.length;
    const p = w.peds[recycleCursor];
    if (!canLeave(p)) continue;
    const pp = w.player.mesh.position;
    if (Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z) < PT.recycleDistance) continue;
    if (inCameraView(w, p.pos.x, p.pos.z)) continue;
    const S = w.pedDensity;
    if (S.active > S.target + PT.density.slack) { deactivate(w, p); S.active--; continue; }
    if (pickSpawn(w, p.archetype === 'jogger' || p.archetype === 'dogwalker', SPAWN)) {
      placeAt(w, p, SPAWN.x, SPAWN.y, SPAWN.z);
      S.relocated++;
    }
  }
}

/** Put a person (with their kid and dog) at (x, z) on the surface near height y, standing, about to set off. */
function placeAt(w: World, p: Ped, x: number, y: number, z: number) {
  const c = w.city;
  p.pos.set(x, c.heightAt(x, z, y) + FOOT, z);
  p.state = 'idle';
  p.timer = Math.random() * 2;
  p.tilt = 0;
  for (const kid of w.peds) if (kid.followId === p.id) { kid.pos.set(x + 0.8, c.heightAt(x + 0.8, z, y) + FOOT, z); kid.state = 'follow'; kid.tilt = 0; }
  if (p.dog) { p.dog.pos.set(x + 1.2, c.heightAt(x + 1.2, z, y) + FOOT, z); p.dog.tumbleT = 0; p.dog.vel.set(0, 0, 0); }
}

function crossingBlocked(w: World, ped: Ped, dx: number, dz: number): boolean {
  // only matters on the road: check moving cars within 14 m heading toward us
  const px = ped.pos.x + dx * 2, pz = ped.pos.z + dz * 2;
  for (const car of w.traffic) {
    if (car.speed < 2) continue;
    const rx = px - car.px, rz = pz - car.pz;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const along = rx * fx + rz * fz;
    if (along > 0 && along < 14 && Math.abs(rx * fz - rz * fx) < 2.5) {
      // are we stepping into the road?
      return w.city.isRoad(px, pz);
    }
  }
  return false;
}

/** A person's body would overlap a building, water or the map edge here (PT.wallClearance around them). */
function pedBlocked(w: World, x: number, z: number): boolean {
  const c = w.city, m = PT.wallClearance;
  return c.isBlocked(x, z) || c.isBlocked(x + m, z) || c.isBlocked(x - m, z) || c.isBlocked(x, z + m) || c.isBlocked(x, z - m);
}

/**
 * Moving off the pavement network (fleeing, dodging, flung): if the new spot is blocked, slide along the wall
 * (keep whichever axis of the move is free) or step back; a fleeing person turns away from the wall.
 */
function keepOutOfBlocked(w: World, ped: Ped, prevX: number, prevZ: number): void {
  const x = ped.pos.x, z = ped.pos.z;
  if ((x === prevX && z === prevZ) || !pedBlocked(w, x, z)) return;
  if (pedBlocked(w, prevX, prevZ)) return; // already stuck in something: nothing better to step back to
  if (!pedBlocked(w, prevX, z)) ped.pos.x = prevX;
  else if (!pedBlocked(w, x, prevZ)) ped.pos.z = prevZ;
  else { ped.pos.x = prevX; ped.pos.z = prevZ; }
  if (ped.state === 'flee') ped.fleeDir.set(ped.fleeDir.y, -ped.fleeDir.x);
}

export function startFlee(ped: Ped, fromX: number, fromZ: number, time = TUNING.peds.fleeTime): void {
  if (ped.state === 'down') return;
  ped.state = 'flee';
  ped.timer = time;
  ped.tilt = 0;
  ped.fleeDir.set(ped.pos.x - fromX, ped.pos.z - fromZ);
  if (ped.fleeDir.lengthSq() < 0.01) ped.fleeDir.set(Math.random() - 0.5, Math.random() - 0.5);
  ped.fleeDir.normalize();
}

function knockDown(w: World, ped: Ped, carVel: THREE.Vector3, speed: number) {
  ped.state = 'down';
  ped.timer = PT.knockdownTime;
  ped.vel.set(carVel.x * 0.7, Math.min(7, 2 + speed * 0.18), carVel.z * 0.7);
  const ground = w.city.heightAt(ped.pos.x, ped.pos.z, ped.pos.y);
  ped.pos.y = ground + 0.1;
  ped.reserved = false;
  ped.phoneMode = null;
  ped.report = null;
  emit(w, { type: 'pedHit', pedId: ped.id, x: ped.pos.x, z: ped.pos.z, speed });
  w.audio.thud?.(ped.pos.x, ped.pos.z, speed);
  hurtBurst(w, ped.pos.x, ground + 1.05 * ped.scale, ped.pos.z, speed, carVel.x, carVel.z, ground, true, ped.vel.x, ped.vel.z);
}

/** Nearest ped to a point within range that can be talked to. */
export function nearestPed(w: World, x: number, z: number, range: number): Ped | null {
  let best: Ped | null = null, bd = range;
  for (const p of w.peds) {
    if (!p.active || p.hidden || p.state === 'down') continue;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
