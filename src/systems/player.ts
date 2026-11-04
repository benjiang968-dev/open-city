// On-foot player: walk/run/jump with Rapier's kinematic character controller; E enters/exits cars.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { act } from './input';
import { makePerson, animatePerson, type PersonRig } from '../art/person';
import type { Vehicle } from './vehicles';
import { nearestPed } from './pedestrians';
import { openChat } from './chat';
import { toast } from './hud';
import { clinicNearby, clinicFee, treatAtClinic } from './health';
import { GROUPS } from '../physicsGroups';
import { pickUp, freeSlot } from './inventory';
import { shovePed } from './npcReactions';
import { carPrompt, useCar, type BreakIn } from './carTheft';
import { showroomPrompt, buyDisplayCar } from './economy/dealership';
import type { KerbHit } from './map/cityMap';

const P = TUNING.player;
const KERB: KerbHit = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };

/**
 * Somewhere safe on dry land near (x, z): the pavement behind the nearest kerb (the kerb stop itself if that is
 * blocked). Used when you swim back from the water or fall out of the world.
 */
export function safeSpotNear(w: World, x: number, z: number, out: { x: number; z: number }): void {
  const c = w.city;
  if (!c.kerbPoint(x, z, KERB)) { out.x = c.spawn.x; out.z = c.spawn.z; return; }
  // the pavement is to the right of the kerbside lane
  const step = TUNING.map.kerbStopGap + P.rescuePavementStep;
  const px = KERB.x - Math.cos(KERB.heading) * step, pz = KERB.z + Math.sin(KERB.heading) * step;
  if (!c.isBlocked(px, pz)) { out.x = px; out.z = pz; }
  else { out.x = KERB.x; out.z = KERB.z; }
}
const SAFE = { x: 0, z: 0 };

export interface PlayerState {
  mesh: THREE.Group;
  rig: PersonRig;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  cc: RAPIER.KinematicCharacterController;
  vy: number;
  grounded: boolean;
  facing: number;
  walkPhase: number;
  vehicle: Vehicle | null;
  /** Interaction hint shown in the HUD ("E: drive Sedan"). */
  prompt: string;
  lastVehicleId: number;
  health: number; // 0..100
  lastHurt: number; // w.time of the last damage
  knockT: number; // seconds of knock-back left (hit by a car on foot)
  knockX: number; // knock-back velocity
  knockZ: number;
  dead: boolean;
  deadT: number; // seconds since death (drives the fade)
  /** Smashing a locked car's window (carTheft.ts runs it); you can't move meanwhile. */
  breakIn: BreakIn | null;
}

export function createPlayer(w: World, x: number, z: number): PlayerState {
  const R = w.R;
  const rig = makePerson(new THREE.Color('#ff7a59'), new THREE.Color('#2d3047'), new THREE.Color('#e0ac69'), new THREE.Color('#3b2416'));
  w.scene.add(rig.root);
  const body = w.physics.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, w.city.heightAt(x, z) + P.capsuleHalfHeight + P.capsuleRadius + 0.05, z));
  const collider = w.physics.createCollider(R.ColliderDesc.capsule(P.capsuleHalfHeight, P.capsuleRadius).setCollisionGroups(GROUPS.player), body);
  const cc = w.physics.createCharacterController(0.04);
  cc.setUp({ x: 0, y: 1, z: 0 });
  cc.enableAutostep(0.45, 0.25, true);
  cc.enableSnapToGround(0.4);
  cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  cc.setApplyImpulsesToDynamicBodies(true);
  return {
    mesh: rig.root, rig, body, collider, cc, vy: 0, grounded: true, facing: 0, walkPhase: 0, vehicle: null, prompt: '', lastVehicleId: -1,
    health: 100, lastHurt: -100, knockT: 0, knockX: 0, knockZ: 0, dead: false, deadT: 0, breakIn: null,
  };
}

const move = new THREE.Vector3();

export function updatePlayer(w: World, dt: number): void {
  const p = w.player;
  const inp = w.input;
  p.prompt = '';
  if (!w.started || p.dead) {
    syncMesh(p);
    return;
  }

  if (p.vehicle) {
    const v = p.vehicle;
    p.mesh.position.copy(v.mesh.position);
    // drove into the water (open water, or sunk under a pier deck): swim back to the nearest pavement
    const vp = v.mesh.position;
    if (vp.y < w.city.waterLevel - 0.8 && (w.city.isWater(vp.x, vp.z) || vp.y < w.city.heightAt(vp.x, vp.z) - 1.5)) {
      v.inWaterTimer += dt;
      if (v.inWaterTimer > 1.5) {
        v.health = 0;
        v.wrecked = true;
        exitVehicle(w);
        safeSpotNear(w, vp.x, vp.z, SAFE);
        p.body.setTranslation({ x: SAFE.x, y: w.city.heightAt(SAFE.x, SAFE.z) + 1.2, z: SAFE.z }, true);
        toast(w, 'You swam back to shore', 2.5);
      }
      return;
    }
    // ride inside; hidden
    if (act.interact(inp) && Math.abs(v.speed) < 6) exitVehicle(w);
    else p.prompt = Math.abs(v.speed) < 6 ? 'E  get out' : '';
    return;
  }

  // busy smashing a car window: stand still (carTheft.ts animates and finishes it)
  if (p.breakIn) {
    p.prompt = 'Breaking in…';
    syncMesh(p);
    return;
  }

  // nearest enterable car
  const pos = p.body.translation();
  let best: Vehicle | null = null;
  let bd: number = P.enterCarRange;
  for (const v of w.vehicles) {
    const t = v.body.translation();
    const d = Math.hypot(t.x - pos.x, t.z - pos.z) - v.spec.halfExtents[0];
    if (d < bd) { bd = d; best = v; }
  }
  // at a clinic door: get patched up (takes priority over talking and cars)
  const clinic = clinicNearby(w);
  if (clinic && !w.chat.open) {
    p.prompt = `E  see a doctor at ${clinic.name} ($${clinicFee(w)})`;
    if (act.interact(inp)) {
      treatAtClinic(w);
      return;
    }
  }

  // nearest person to talk to (preferred over a car when closer)
  const ped = w.chat.open ? null : nearestPed(w, pos.x, pos.z, P.talkRange);
  const pedD = ped ? Math.hypot(ped.pos.x - pos.x, ped.pos.z - pos.z) : Infinity;
  const item = w.chat.open ? null : w.itemsState.target;
  const itemD = item ? Math.hypot(item.px - pos.x, item.pz - pos.z) : Infinity;
  if (item && itemD <= pedD && itemD <= bd + 0.3) {
    const room = freeSlot(w) >= 0;
    p.prompt = room ? `E  pick up ${TUNING.items.defs[item.type].name}` : 'Hotbar full · Q drops the selected item';
    if (room && act.interact(inp)) {
      pickUp(w, item);
      return;
    }
  } else if (ped && (!best || pedD < bd + 0.5)) {
    p.prompt = `E  talk to ${ped.npc.name}`;
    if (act.interact(inp)) {
      openChat(w, ped);
      return;
    }
  } else if (best && !w.chat.open) {
    if (best.forSale) {
      // dealership stock: price and stats, E buys it
      p.prompt = showroomPrompt(w, best);
      if (act.interact(inp)) buyDisplayCar(w, best);
    } else {
      // yours: drive; someone else's: steal it, or smash the window if it's locked
      p.prompt = carPrompt(w, best);
      if (act.interact(inp) && !best.wrecked) {
        useCar(w, best);
        return;
      }
    }
  }

  // tank-style movement: A/D turn the character, W/S walk along the way they face
  const turn = (act.left(inp) ? 1 : 0) - (act.right(inp) ? 1 : 0);
  p.facing += turn * P.turnSpeed * dt;
  const fwdIn = (act.forward(inp) ? 1 : 0) - (act.back(inp) ? 1 : 0);
  const running = act.run(inp) && fwdIn > 0;
  const injured = p.health < TUNING.health.injuredBelow ? TUNING.health.injuredSpeedFactor : 1;
  const speed = (fwdIn > 0 ? (running ? P.runSpeed : P.walkSpeed) : P.walkSpeed * P.backSpeedFactor) * (running ? injured : 1);
  const ix = Math.sin(p.facing) * fwdIn, iz = Math.cos(p.facing) * fwdIn;
  const len = Math.abs(fwdIn) + Math.abs(turn) * 0.3; // a little leg movement when turning on the spot
  if (p.grounded) {
    p.vy = -1;
    if (act.jump(inp)) p.vy = P.jumpVelocity;
  } else p.vy -= P.gravity * dt;
  move.set(ix * speed * dt, p.vy * dt, iz * speed * dt);
  if (p.knockT > 0) {
    // thrown by a car: slide away, no control
    p.knockT -= dt;
    move.set(p.knockX * dt, p.vy * dt, p.knockZ * dt);
    p.knockX *= 1 - Math.min(1, dt * 3);
    p.knockZ *= 1 - Math.min(1, dt * 3);
  }
  p.cc.computeColliderMovement(p.collider, { x: move.x, y: move.y, z: move.z });
  const c = p.cc.computedMovement();
  // bumped into a person: shove them a little (they stumble and complain)
  for (let i = 0, n = p.cc.numComputedCollisions(); i < n; i++) {
    const hit = p.cc.computedCollision(i);
    const owner = hit?.collider ? w.colliderOwner.get(hit.collider.handle) : undefined;
    if (owner?.kind !== 'ped') continue;
    const ped = w.peds[owner.id];
    const dx = ped.pos.x - pos.x, dz = ped.pos.z - pos.z, l = Math.hypot(dx, dz) || 1;
    shovePed(w, ped, (dx / l) * TUNING.reactions.shovePush, (dz / l) * TUNING.reactions.shovePush);
  }
  p.grounded = p.cc.computedGrounded();
  if (p.grounded && p.vy > 0 && move.y > 0 && c.y < move.y * 0.5) p.vy = 0; // bumped head
  p.body.setNextKinematicTranslation({ x: pos.x + c.x, y: pos.y + c.y, z: pos.z + c.z });
  // safety: fell through the ground or into the water -> back onto the nearest pavement
  if (pos.y < w.city.heightAt(pos.x, pos.z) - 3) {
    if (w.city.isWater(pos.x, pos.z) || w.city.isBlocked(pos.x, pos.z)) safeSpotNear(w, pos.x, pos.z, SAFE);
    else { SAFE.x = pos.x; SAFE.z = pos.z; }
    p.body.setTranslation({ x: SAFE.x, y: w.city.heightAt(SAFE.x, SAFE.z) + 1.2, z: SAFE.z }, true);
  }
  p.walkPhase += Math.hypot(c.x, c.z) * 3.2;
  animatePerson(p.rig, p.walkPhase, p.grounded ? Math.min(1, (len * speed) / P.walkSpeed) : 0.3);
  syncMesh(p);
}

function syncMesh(p: PlayerState) {
  const t = p.body.translation();
  p.mesh.position.set(t.x, t.y - P.capsuleHalfHeight - P.capsuleRadius, t.z);
  p.mesh.rotation.y = p.facing;
}

export function enterVehicle(w: World, v: Vehicle): void {
  const p = w.player;
  p.vehicle = v;
  v.driven = true;
  v.body.wakeUp(); // parked cars sleep in the physics engine
  p.mesh.visible = false;
  p.collider.setEnabled(false);
  const t = v.body.translation();
  const seen = w.police.seen;
  if (p.lastVehicleId !== v.id) emit(w, { type: 'enterCar', x: t.x, z: t.z, carId: v.id, seen });
  p.lastVehicleId = v.id;
  w.cam.yaw = v.heading + Math.PI;
}

export function exitVehicle(w: World): void {
  const p = w.player;
  const v = p.vehicle;
  if (!v) return;
  v.driven = false;
  p.vehicle = null;
  const t = v.body.translation();
  // driver side is the car's left (+X local)
  const side = v.spec.halfExtents[0] + 0.9;
  const lx = Math.cos(v.heading) * side, lz = -Math.sin(v.heading) * side;
  let x = t.x + lx, z = t.z + lz;
  // if blocked on the left, try the right
  const R = w.R;
  const blocked = (px: number, pz: number) =>
    w.physics.intersectionWithShape({ x: px, y: w.city.heightAt(px, pz) + 1.0, z: pz }, { x: 0, y: 0, z: 0, w: 1 }, new R.Capsule(P.capsuleHalfHeight, P.capsuleRadius), undefined, undefined, v.collider) !== null;
  if (blocked(x, z)) { x = t.x - lx; z = t.z - lz; }
  if (blocked(x, z)) { x = t.x; z = t.z; }
  p.body.setTranslation({ x, y: Math.max(w.city.heightAt(x, z) + 1.0, t.y + 0.4), z }, true);
  p.collider.setEnabled(true);
  p.mesh.visible = true;
  p.facing = v.heading;
  p.vy = 0;
}
