// On-foot player: walk/run/jump with Rapier's kinematic character controller; E enters/exits cars.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { act } from './input';
import { makePerson, animatePerson, type PersonRig } from '../art/person';
import type { Vehicle } from './vehicles';

const P = TUNING.player;

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
}

export function createPlayer(w: World, x: number, z: number): PlayerState {
  const R = w.R;
  const rig = makePerson(new THREE.Color('#ff7a59'), new THREE.Color('#2d3047'), new THREE.Color('#e0ac69'), new THREE.Color('#3b2416'));
  w.scene.add(rig.root);
  const body = w.physics.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, P.capsuleHalfHeight + P.capsuleRadius + 0.05, z));
  const collider = w.physics.createCollider(R.ColliderDesc.capsule(P.capsuleHalfHeight, P.capsuleRadius), body);
  const cc = w.physics.createCharacterController(0.04);
  cc.setUp({ x: 0, y: 1, z: 0 });
  cc.enableAutostep(0.45, 0.25, true);
  cc.enableSnapToGround(0.4);
  cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  cc.setApplyImpulsesToDynamicBodies(true);
  return {
    mesh: rig.root, rig, body, collider, cc, vy: 0, grounded: true, facing: 0, walkPhase: 0, vehicle: null, prompt: '', lastVehicleId: -1,
  };
}

const move = new THREE.Vector3();

export function updatePlayer(w: World, dt: number): void {
  const p = w.player;
  const inp = w.input;
  p.prompt = '';
  if (!w.started) {
    syncMesh(p);
    return;
  }

  if (p.vehicle) {
    const v = p.vehicle;
    p.mesh.position.copy(v.mesh.position);
    // ride inside; hidden
    if (act.interact(inp) && Math.abs(v.speed) < 6) exitVehicle(w);
    else p.prompt = Math.abs(v.speed) < 6 ? 'E  get out' : '';
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
  if (best && !w.chat.open) {
    p.prompt = best.wrecked ? `${best.spec.label} is wrecked` : `E  drive ${best.spec.label}`;
    if (act.interact(inp) && !best.wrecked) {
      enterVehicle(w, best);
      return;
    }
  }

  // camera-relative movement
  const yaw = w.cam.yaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = -fz, rz = fx; // right = (cos yaw, -sin yaw)
  let ix = 0, iz = 0;
  if (act.forward(inp)) { ix += fx; iz += fz; }
  if (act.back(inp)) { ix -= fx; iz -= fz; }
  if (act.right(inp)) { ix += rx; iz += rz; }
  if (act.left(inp)) { ix -= rx; iz -= rz; }
  const len = Math.hypot(ix, iz);
  const speed = act.run(inp) ? P.runSpeed : P.walkSpeed;
  if (len > 0) {
    ix /= len; iz /= len;
    const target = Math.atan2(ix, iz);
    const diff = Math.atan2(Math.sin(target - p.facing), Math.cos(target - p.facing));
    p.facing += diff * Math.min(1, dt * P.turnLerp);
  }
  if (p.grounded) {
    p.vy = -1;
    if (act.jump(inp)) p.vy = P.jumpVelocity;
  } else p.vy -= P.gravity * dt;
  move.set(ix * speed * dt, p.vy * dt, iz * speed * dt);
  p.cc.computeColliderMovement(p.collider, { x: move.x, y: move.y, z: move.z });
  const c = p.cc.computedMovement();
  p.grounded = p.cc.computedGrounded();
  if (p.grounded && p.vy > 0 && move.y > 0 && c.y < move.y * 0.5) p.vy = 0; // bumped head
  p.body.setNextKinematicTranslation({ x: pos.x + c.x, y: pos.y + c.y, z: pos.z + c.z });
  // safety: fell through or into the bay -> back to the promenade
  if (pos.y < -3) {
    p.body.setTranslation({ x: pos.x, y: 1.2, z: Math.min(pos.z, w.city.coastZ - 20) }, true);
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
    w.physics.intersectionWithShape({ x: px, y: 1.0, z: pz }, { x: 0, y: 0, z: 0, w: 1 }, new R.Capsule(P.capsuleHalfHeight, P.capsuleRadius), undefined, undefined, v.collider) !== null;
  if (blocked(x, z)) { x = t.x - lx; z = t.z - lz; }
  if (blocked(x, z)) { x = t.x; z = t.z; }
  p.body.setTranslation({ x, y: Math.max(1.0, t.y + 0.4), z }, true);
  p.collider.setEnabled(true);
  p.mesh.visible = true;
  p.facing = v.heading;
  p.vy = 0;
}
