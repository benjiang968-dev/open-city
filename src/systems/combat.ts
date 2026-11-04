// Throwing and melee. Left click (or F) with a throwable: hold to charge, an arc shows where it will land,
// release to throw (aimed where the camera looks). With a bat or wrench: click to swing. Thrown items are real
// physics objects; hitting people makes them react, heavy hits dent cars.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { selectedItem, takeSelected } from './inventory';
import { placeInWorld, type WorldItem } from './worldItems';
import { hitPed } from './npcReactions';
import { dentAt } from './carDamage';
import type { Vehicle } from './vehicles';
import { triggerAlarm } from './carTheft';

const CB = TUNING.combat;
const IT = TUNING.items;

export interface CombatState {
  charging: boolean;
  charge: number; // 0..1
  swingT: number; // >0 while a swing animation plays
  swingHitDone: boolean;
  cooldown: number;
  throwAnimT: number;
  heldBefore: boolean; // attack button state last frame
  lastMenace: number;
  arc: THREE.Line;
  arcPts: Float32Array;
  ring: THREE.Mesh;
  /** Thrown items still flying and which people they already hit. */
  flying: { item: WorldItem; hit: Set<number> }[];
}

const ARC_N = 48;

export function createCombat(w: World): CombatState {
  const arcPts = new Float32Array(ARC_N * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arcPts, 3));
  const arc = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.85, depthTest: false }));
  arc.frustumCulled = false;
  arc.visible = false;
  arc.renderOrder = 5;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.4, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.8, depthTest: false }));
  ring.visible = false;
  ring.renderOrder = 5;
  w.scene.add(arc, ring);
  return { charging: false, charge: 0, swingT: 0, swingHitDone: false, cooldown: 0, throwAnimT: 0, heldBefore: false, lastMenace: -100, arc, arcPts, ring, flying: [] };
}

/** Where a throw starts and its velocity, from the camera's aim and the current charge. */
function throwVector(w: World, charge: number) {
  const p = w.player;
  const yaw = w.cam.yaw;
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const elev = THREE.MathUtils.clamp(CB.throwBaseElevation - (w.cam.pitch - 0.32) * CB.throwPitchFactor, CB.throwMinElevation, CB.throwMaxElevation);
  const speed = CB.throwMinSpeed + (CB.throwMaxSpeed - CB.throwMinSpeed) * charge;
  const pos = p.mesh.position;
  return {
    x: pos.x + dx * 0.45, y: pos.y + 1.55, z: pos.z + dz * 0.45,
    vx: dx * Math.cos(elev) * speed, vy: Math.sin(elev) * speed, vz: dz * Math.cos(elev) * speed,
    facing: Math.atan2(dx, dz),
  };
}

function updateArc(w: World, c: CombatState) {
  const t = throwVector(w, c.charge);
  const gravity = TUNING.vehicles.gravity;
  let x = t.x, y = t.y, z = t.z, vy = t.vy, last = 0;
  const dt = 0.05;
  for (let i = 0; i < ARC_N; i++) {
    c.arcPts[i * 3] = x; c.arcPts[i * 3 + 1] = y; c.arcPts[i * 3 + 2] = z;
    last = i;
    if (y < 0.05 && i > 0) break;
    x += t.vx * dt; z += t.vz * dt; y += vy * dt; vy -= gravity * dt;
  }
  c.arc.geometry.setDrawRange(0, last + 1);
  (c.arc.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  c.ring.position.set(c.arcPts[last * 3], 0.06, c.arcPts[last * 3 + 2]);
}

export function updateCombat(w: World, dt: number): void {
  const c = w.combat;
  const inp = w.input;
  const p = w.player;
  c.cooldown = Math.max(0, c.cooldown - dt);
  const usable = w.started && !w.paused && !inp.blocked && !p.dead && !p.vehicle && !p.breakIn;
  const held = usable && (inp.mouse0 || inp.keys.has('KeyF'));
  const pressed = held && !c.heldBefore;
  const released = !held && c.heldBefore;
  c.heldBefore = held;
  const it = selectedItem(w);
  const def = it ? IT.defs[it.type] : null;

  // ---- melee ----
  if (def && 'melee' in def && def.melee) {
    c.charging = false;
    if (pressed && c.cooldown <= 0 && c.swingT <= 0) {
      c.swingT = CB.swingTime;
      c.swingHitDone = false;
      c.cooldown = def.melee.cooldown;
      p.facing = Math.atan2(-Math.sin(w.cam.yaw), -Math.cos(w.cam.yaw)); // swing where you look
      w.audio.whoosh?.();
      // waving a weapon around near people is a crime in itself (rate-limited)
      if (w.time - c.lastMenace > TUNING.witness.menaceCooldown) {
        c.lastMenace = w.time;
        emit(w, { type: 'menace', x: p.mesh.position.x, z: p.mesh.position.z });
      }
    }
    if (c.swingT > 0) {
      c.swingT -= dt;
      const k = 1 - c.swingT / CB.swingTime; // 0 → 1
      w.inventory.armPose = 1.9 - k * 3.5; // raised behind the shoulder → forward and down
      if (!c.swingHitDone && k > CB.swingHitAt) {
        c.swingHitDone = true;
        meleeHit(w, it!, def.melee);
      }
    }
  } else if (def && def.throwable) {
    // ---- throwing ----
    if (pressed) { c.charging = true; c.charge = 0; }
    if (c.charging && held) {
      c.charge = Math.min(1, c.charge + dt / CB.chargeTime);
      w.inventory.armPose = 1.3 + c.charge * 1.3; // wind up
      updateArc(w, c);
    }
    if (c.charging && released) {
      c.charging = false;
      throwSelected(w, c.charge);
      c.throwAnimT = 0.18;
    }
  } else {
    c.charging = false;
  }
  if (!usable) c.charging = false;
  if (c.throwAnimT > 0) {
    c.throwAnimT -= dt;
    w.inventory.armPose = -1.2;
  }
  c.arc.visible = c.ring.visible = c.charging;

  // ---- thrown items hitting people (sphere vs standing person) ----
  for (let i = c.flying.length - 1; i >= 0; i--) {
    const f = c.flying[i];
    const item = f.item;
    if (!item.thrown || !item.inWorld) { c.flying.splice(i, 1); continue; }
    if (item.speed < CB.minHitSpeed) continue;
    for (const ped of w.peds) {
      if (f.hit.has(ped.id) || ped.state === 'down' || !ped.active || ped.hidden || ped.protectedTarget) continue;
      const dx = item.px - ped.pos.x, dz = item.pz - ped.pos.z;
      if (Math.abs(dx) > 0.7 || Math.abs(dz) > 0.7) continue;
      const y = item.py - ped.pos.y;
      if (y < 0.05 || y > 1.85 || dx * dx + dz * dz > CB.pedHitRadius * CB.pedHitRadius) continue;
      f.hit.add(ped.id);
      const d = IT.defs[item.type];
      const dmg = d.hitDamage * THREE.MathUtils.clamp(item.speed / CB.throwMaxSpeed, 0.3, 1);
      hitPed(w, ped, 'thrown', dmg, d.heavy, item.px - dx * 3, item.pz - dz * 3, d.name);
      // bounce off them
      const lv = item.body.linvel();
      item.body.setLinvel({ x: -lv.x * 0.25, y: Math.abs(lv.y) * 0.3, z: -lv.z * 0.25 }, true);
      w.audio.thud?.(item.px, item.pz, 4);
    }
  }
}

function throwSelected(w: World, charge: number) {
  const it = takeSelected(w);
  if (!it) return;
  const t = throwVector(w, charge);
  w.player.facing = t.facing;
  placeInWorld(w, it, t.x, t.y, t.z, t.facing, t.vx, t.vy, t.vz);
  it.thrown = true;
  it.thrownAt = w.time;
  it.speed = Math.hypot(t.vx, t.vy, t.vz);
  it.body.enableCcd(true); // small fast object: don't tunnel through people or poles
  it.collider.setActiveEvents(w.R.ActiveEvents.COLLISION_EVENTS);
  w.combat.flying.push({ item: it, hit: new Set() });
  w.audio.whoosh?.();
}

/** Thrown item touched a car (from Rapier collision events): heavy things dent it. */
export function thrownItemHitCollider(w: World, item: WorldItem, otherHandle: number): void {
  const owner = w.colliderOwner.get(otherHandle);
  if (!owner || item.speed < CB.minHitSpeed) return;
  const d = IT.defs[item.type];
  if (owner.kind === 'vehicle') {
    const v = w.vehicles[owner.id];
    if (d.heavy) dentVehicleAt(w, v, item.px, item.py, item.pz, item.speed * d.mass * CB.thrownDentPerMomentum);
    if (d.heavy && v.locked && !v.driven) triggerAlarm(w, v);
    emit(w, { type: 'vandalism', x: item.px, z: item.pz, what: v.spec.label });
  } else if (owner.kind === 'traffic' || owner.kind === 'police') {
    const car = owner.kind === 'traffic' ? w.traffic[owner.id] : w.police.cars.find((q) => q.id === owner.id);
    if (car) { car.honkCd = 0; w.audio.horn?.(car.px, car.pz); }
    emit(w, { type: 'vandalism', x: item.px, z: item.pz, what: 'a car' });
  }
}

/** Dent a drivable car at a world point, pushing inward toward its centre. */
function dentVehicleAt(w: World, v: Vehicle, x: number, y: number, z: number, depth: number) {
  const r = v.body.rotation();
  const t = v.body.translation();
  const qi = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
  const local = new THREE.Vector3(x - t.x, y - t.y, z - t.z).applyQuaternion(qi);
  const [hx, hy, hz] = v.spec.halfExtents;
  // snap onto the body surface
  local.x = THREE.MathUtils.clamp(local.x, -hx, hx);
  local.y = THREE.MathUtils.clamp(local.y, -hy, hy + 0.4);
  local.z = THREE.MathUtils.clamp(local.z, -hz, hz);
  const dir = local.clone().multiplyScalar(-1).setY(0).normalize();
  dentAt(v, local.x, local.y, local.z, dir.x, 0, dir.z, Math.min(TUNING.damage.maxDentPerHit, depth), TUNING.damage.dentRadius * 0.7);
  // a hard hit near the front can crack the windscreen or break a light
  if (depth > 0.08 && local.z > hz * 0.3 && local.y > 0) v.dmg.crack.visible = true;
  if (depth > 0.06 && local.z > hz * 0.7) v.dmg.lights[local.x >= 0 ? 0 : 1].visible = false;
}

function meleeHit(w: World, item: WorldItem, m: { damage: number; reach: number; dent: number }) {
  const p = w.player;
  const pos = p.mesh.position;
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  const name = IT.defs[item.type].name;
  let hitSomething = false;
  // people in the swing arc
  for (const ped of w.peds) {
    if (ped.state === 'down' || ped.pos.y < -10 || !ped.active || ped.hidden || ped.protectedTarget) continue;
    const dx = ped.pos.x - pos.x, dz = ped.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d > m.reach + 0.35 || d < 0.01) continue;
    if ((dx * fx + dz * fz) / d < CB.swingArcDot) continue;
    hitPed(w, ped, 'melee', m.damage, true, pos.x, pos.z, name);
    hitSomething = true;
  }
  // cars in front: sample the swing point against each car's box
  const hx0 = pos.x + fx * m.reach * 0.8, hz0 = pos.z + fz * m.reach * 0.8;
  for (const v of w.vehicles) {
    if (v.driven) continue;
    const t = v.body.translation();
    if (Math.hypot(t.x - hx0, t.z - hz0) > 4) continue;
    const r = v.body.rotation();
    const qi = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
    const local = new THREE.Vector3(hx0 - t.x, 0.9 - t.y, hz0 - t.z).applyQuaternion(qi);
    const [hx, , hz] = v.spec.halfExtents;
    if (Math.abs(local.x) > hx + 0.35 || Math.abs(local.z) > hz + 0.35) continue;
    dentVehicleAt(w, v, hx0, 0.95, hz0, m.dent);
    v.health = Math.max(0, v.health - m.damage * 0.3);
    if (v.locked) triggerAlarm(w, v); // a bat on a locked car sets its alarm off
    emit(w, { type: 'vandalism', x: hx0, z: hz0, what: v.spec.label });
    w.audio.thud?.(hx0, hz0, 12);
    hitSomething = true;
  }
  for (const car of [...w.traffic, ...w.police.cars]) {
    if (Math.hypot(car.px - hx0, car.pz - hz0) > car.halfL + 0.6) continue;
    car.honkCd = 0;
    w.audio.horn?.(car.px, car.pz);
    w.audio.thud?.(hx0, hz0, 12);
    emit(w, { type: 'vandalism', x: hx0, z: hz0, what: 'a car' });
    hitSomething = true;
  }
  if (hitSomething) w.audio.thud?.(pos.x, pos.z, 8);
}
