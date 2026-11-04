// Car ownership, locks, break-ins, car alarms and theft. Every drivable parked car belongs to a local
// (or to nobody: abandoned). E on a car that isn't yours takes it: straight in when it's unlocked, or a
// ~3 s window smash when it's locked (elbow strikes rock the car, the side window cracks then shatters,
// the alarm goes off and people turn to look). Taking a car is a 'carTheft' crime for the witness system;
// the owner remembers you and, if close enough to notice, comes running and shouting.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import type { Vehicle } from './vehicles';
import type { Ped } from './pedestrians';
import { enterVehicle } from './player';
import { crackSideWindow } from './carDamage';
import { say } from './bubbles';
import { LINES, pick } from '../npc/reactionLines';
import { canSee } from './witness';
import { toast } from './hud';
import { Rng } from '../rng';

const TH = TUNING.theft;

/** A break-in in progress (the player stands at the car's side window). */
export interface BreakIn {
  v: Vehicle;
  t: number; // seconds since it started
  side: number; // +1: the car's left side (local +X), -1: right
  strikes: number; // elbow strikes landed so far
}

/** Counters for the debug overlay and automated tests. */
export const theftStats = { thefts: 0, breakIns: 0, ownerChases: 0, lastShout: '', lookers: 0 };

/**
 * Once people exist: give every parked car that isn't yours (and isn't dealership stock) an owner, the
 * adult living or working nearest to it (one car each), or nobody (abandoned, always unlocked); then
 * lock a share of the owned ones. Uses its own seeded generator so other systems' sequences don't shift.
 */
export function assignCarOwners(w: World): void {
  const rng = new Rng(w.seed ^ 0xca7);
  const pois = w.city.pois;
  const hasCar = new Set<number>();
  for (const v of w.vehicles) {
    if (v.owned || v.forSale) continue;
    v.owner = 'nobody';
    v.locked = false;
    if (rng.chance(TH.abandonedFraction)) continue;
    let best = -1, bd = Infinity;
    for (const p of w.peds) {
      if (p.archetype === 'kid' || hasCar.has(p.id)) continue;
      const h = pois[p.npc.homePoi], wk = pois[p.npc.workPoi];
      const d = Math.min(Math.hypot(h.x - v.px, h.z - v.pz), Math.hypot(wk.x - v.px, wk.z - v.pz));
      if (d < bd) { bd = d; best = p.id; }
    }
    if (best < 0) continue;
    hasCar.add(best);
    v.owner = best;
    v.locked = rng.chance(TH.lockedFraction);
  }
}

function ownerName(w: World, v: Vehicle): string | null {
  return typeof v.owner === 'number' ? w.peds[v.owner].npc.name.split(' ')[0] : null;
}

/** HUD prompt for E on a car (dealership stock is handled by the dealership). */
export function carPrompt(w: World, v: Vehicle): string {
  const name = v.spec.label;
  if (v.wrecked) return `${name} is wrecked`;
  if (v.owned) return `E  drive your ${name}`;
  if (v.stolen) return `E  drive the ${name}`;
  const who = ownerName(w, v);
  const whose = who ? `${who}'s car` : 'abandoned';
  if (!v.locked) return `E  steal the ${name} <span style="opacity:.75">(${whose}, unlocked)</span>`;
  return `E  break into the ${name} <span style="opacity:.75">(${whose}, locked: smash the window)</span>`;
}

/** E on a car that isn't for sale: drive it, steal it, or start smashing the window. */
export function useCar(w: World, v: Vehicle): void {
  if (v.wrecked || w.player.breakIn) return;
  if (v.owned || v.stolen) { enterVehicle(w, v); return; }
  if (!v.locked) {
    enterVehicle(w, v);
    carTaken(w, v, false);
    return;
  }
  startBreakIn(w, v);
}

/** Car's local +X axis (its left side) in world space is (cos h, 0, -sin h). */
function startBreakIn(w: World, v: Vehicle): void {
  const p = w.player;
  const pos = p.mesh.position;
  const ch = Math.cos(v.heading), sh = Math.sin(v.heading);
  const lx = (pos.x - v.px) * ch - (pos.z - v.pz) * sh;
  const side = lx >= 0 ? 1 : -1;
  // face the driver's-door glass on our side
  const sw = v.dmg.sideWindow;
  const along = sw.z + sw.w * 0.25;
  const tx = v.px + ch * side * sw.x + sh * along, tz = v.pz - sh * side * sw.x + ch * along;
  p.facing = Math.atan2(tx - pos.x, tz - pos.z);
  p.breakIn = { v, t: 0, side, strikes: 0 };
  theftStats.breakIns++;
}

/** Start (or extend) a car's alarm. Your own cars never go off. */
export function triggerAlarm(w: World, v: Vehicle): void {
  if (v.owned || v.forSale) return;
  v.alarmUntil = Math.max(v.alarmUntil, w.time + TH.alarmSeconds);
}

function strike(w: World, b: BreakIn): void {
  const v = b.v;
  const n = TH.strikeTimes.length;
  const k = b.strikes; // 0-based strike number
  crackSideWindow(v, b.side, (k + 1) / n);
  // rock the car on its springs: push in through the window
  const ch = Math.cos(v.heading), sh = Math.sin(v.heading);
  const sw = v.dmg.sideWindow;
  const t = v.body.translation();
  v.body.applyImpulseAtPoint(
    { x: -b.side * ch * TH.shoveImpulse, y: 0, z: b.side * sh * TH.shoveImpulse },
    { x: t.x + ch * b.side * sw.x, y: t.y + sw.y, z: t.z - sh * b.side * sw.x },
    true,
  );
  if (k === 0) triggerAlarm(w, v); // the shock sensor goes off on the first hit
  if (k === n - 1) w.audio.smash?.(v.px, v.pz);
  else w.audio.thud?.(v.px, v.pz, 5);
}

/** Right-arm angle (radians about X; positive = back, negative = forward) for elbow strikes at strikeTimes. */
function armAngle(t: number): number {
  const ST = TH.strikeTimes;
  let k = 0;
  while (k < ST.length && ST[k] < t) k++;
  const sincePrev = k > 0 ? t - ST[k - 1] : 99;
  const toNext = k < ST.length ? ST[k] - t : 99;
  if (sincePrev < 0.25) return THREE.MathUtils.lerp(-1.55, -0.65, sincePrev / 0.25); // follow-through
  if (toNext < 0.12) return THREE.MathUtils.lerp(1.0, -1.55, 1 - toNext / 0.12); // drive into the glass
  if (toNext < 0.45) return THREE.MathUtils.lerp(-0.65, 1.0, (0.45 - toNext) / 0.33); // wind back
  return -0.65; // guard
}

function updateBreakIn(w: World, dt: number): void {
  const p = w.player;
  const b = p.breakIn;
  if (!b) return;
  const v = b.v;
  const pos = p.mesh.position;
  const tooFar = Math.hypot(v.px - pos.x, v.pz - pos.z) > v.spec.halfExtents[2] + TH.cancelDistance;
  if (p.dead || p.knockT > 0 || p.vehicle || v.wrecked || v.driven || tooFar) {
    p.breakIn = null;
    if (b.strikes > 0) v.locked = false; // the glass is broken now: next time it's just "steal"
    return;
  }
  b.t += dt;
  while (b.strikes < TH.strikeTimes.length && b.t >= TH.strikeTimes[b.strikes]) {
    strike(w, b);
    b.strikes++;
  }
  // arm animation: right elbow strikes, left arm up as a guard
  const a = armAngle(b.t);
  p.rig.armR.rotation.x = a;
  p.rig.armL.rotation.x = -0.9;
  p.rig.legL.rotation.x = 0.15;
  p.rig.legR.rotation.x = -0.1;
  w.inventory.armPose = a; // a held item follows the arm
  if (b.t >= TH.breakInTime) {
    p.breakIn = null;
    v.locked = false;
    p.rig.armL.rotation.x = 0;
    enterVehicle(w, v);
    carTaken(w, v, true);
  }
}

/** The player just took a car that isn't theirs. */
function carTaken(w: World, v: Vehicle, forced: boolean): void {
  v.stolen = true;
  theftStats.thefts++;
  const alarm = v.alarmUntil > w.time;
  const ownerId = typeof v.owner === 'number' ? v.owner : -1;
  const owner = ownerId >= 0 ? w.peds[ownerId] : null;
  let ownerSaw = false;
  if (owner && canReact(owner)) {
    const d = Math.hypot(owner.pos.x - v.px, owner.pos.z - v.pz);
    // close enough, and either sees it happen or hears their own alarm
    if (d < TH.ownerNoticeRange && (alarm || canSee(w, owner, v.px, v.pz))) {
      ownerSaw = true;
      owner.state = 'chase';
      owner.timer = TH.ownerChaseTime;
      owner.shoutT = TH.shoutEvery;
      owner.route = [];
      const line = LINES.carOwner[0];
      say(w, owner, line, 2.4, `ped${owner.id}`);
      theftStats.ownerChases++;
      theftStats.lastShout = line;
    }
  }
  emit(w, { type: 'carTheft', x: v.px, z: v.pz, carId: v.id, ownerId, ownerSaw, alarm, forced });
  const who = ownerName(w, v);
  toast(w, `<span style="font-size:20px">🚗 You stole ${who ? `${who}'s` : 'an abandoned'} ${v.spec.label}</span>`, 2);
}

function canReact(p: Ped): boolean {
  return p.active && !p.hidden && !p.reserved && p.state !== 'down' && p.state !== 'talk' && p.state !== 'phone' && p.pos.y > -10;
}

let lookT = 0;
/** People within earshot of a car alarm stop and stare at it (checked a few times a second). */
function alarmsDrawAttention(w: World, dt: number): void {
  lookT -= dt;
  if (lookT > 0) return;
  lookT = TH.lookCheckInterval;
  const r = TUNING.witness.radius.carTheftAlarm;
  for (const v of w.vehicles) {
    // a hard knock on a locked parked car sets its alarm off too
    if (!v.driven && v.locked && w.time - v.lastHitTime < TH.lookCheckInterval + 0.05) triggerAlarm(w, v);
    if (v.alarmUntil <= w.time) continue;
    for (const p of w.peds) {
      if (!p.active || p.hidden || p.reserved || (p.state !== 'walk' && p.state !== 'idle')) continue;
      if (Math.abs(p.pos.x - v.px) > r || Math.abs(p.pos.z - v.pz) > r || Math.hypot(p.pos.x - v.px, p.pos.z - v.pz) > r) continue;
      p.state = 'look';
      p.timer = TH.lookTime + Math.random() * 1.5;
      theftStats.lookers++;
    }
  }
}

/** Per frame (before NPC memory and witnesses read this frame's events). */
export function updateCarTheft(w: World, dt: number): void {
  updateBreakIn(w, dt);
  alarmsDrawAttention(w, dt);
}

/** Loudest alarm the player can hear: 0..1 by distance (audio reads this). */
export function alarmLevel(w: World): number {
  const pp = w.player.mesh.position;
  let best = 0;
  for (const v of w.vehicles) {
    if (v.alarmUntil <= w.time) continue;
    const g = 1 - Math.hypot(v.px - pp.x, v.pz - pp.z) / TUNING.audio.alarmRange;
    if (g > best) best = g;
  }
  return best;
}
