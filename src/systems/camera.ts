// One heading on foot: keyboard turns and mouse look turn both view and movement. In a car the same
// keys steer; the mouse looks independently. V toggles first/third person in either mode.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarTypeName } from '../tuning';
import type { World } from '../world';
import { injurySway } from './health';
import { INTERIOR } from '../data/interiorDefs';
import { driverSeat } from '../art/car';

const T = TUNING.camera;

export interface CameraState {
  yaw: number; // camera sits behind the view direction (view heading = yaw + PI)
  pitch: number;
  dist: number;
  focus: THREE.Vector3;
  titleAngle: number;
  mode: 'third' | 'first';
  viewBlend: number;
  obstructionDistance: number;
  playerObscured: boolean;
  lastLookTime: number; // simulation clock, never compared with performance.now()
  override: { px: number; py: number; pz: number; lx: number; ly: number; lz: number } | null;
}

export function createCamera(): CameraState {
  return { yaw: Math.PI, pitch: 0.32, dist: T.distanceOnFoot, focus: new THREE.Vector3(), titleAngle: 0,
    mode: 'third', viewBlend: 0, obstructionDistance: T.distanceOnFoot, playerObscured: false, lastLookTime: -100, override: null };
}

/** Called before movement and again before drawing. Deltas/actions are consumed exactly once even with
 * several fixed physics ticks per rendered frame, or with a frame that contains no physics tick. */
export function applyCameraInput(w: World): void {
  if (!w.started || w.paused || w.input.blocked) return;
  const c = w.cam, inp = w.input;
  if (inp.pressed.delete('KeyV')) {
    c.mode = c.mode === 'third' ? 'first' : 'third';
    c.pitch = c.mode === 'first' ? 0 : 0.32;
    c.lastLookTime = w.time;
  }
  if (inp.mouseDX || inp.mouseDY) {
    const delta = -inp.mouseDX * T.mouseSensitivity;
    c.yaw += delta;
    if (!w.player.vehicle) w.player.facing += delta;
    const min = c.mode === 'first' ? -T.firstPersonPitch : T.minPitch;
    const max = c.mode === 'first' ? T.firstPersonPitch : T.maxPitch;
    c.pitch = THREE.MathUtils.clamp(c.pitch + inp.mouseDY * T.mouseSensitivity, min, max);
    c.lastLookTime = w.time;
    inp.mouseDX = 0; inp.mouseDY = 0;
  }
}

const direction = new THREE.Vector3();
const desired = new THREE.Vector3();
const eye = new THREE.Vector3();
const look = new THREE.Vector3();
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
let sweep: RAPIER.Ball | null = null;
const driverSeats = new Map<CarTypeName, THREE.Vector3>();

export function updateCamera(w: World, dt: number): void {
  const c = w.cam, cam = w.camera;
  if (c.override) {
    const o = c.override;
    cam.position.set(o.px, o.py, o.pz); cam.lookAt(o.lx, o.ly, o.lz);
    return;
  }
  if (!w.started) {
    c.titleAngle += dt * 0.05;
    const p = w.player.mesh.position;
    cam.position.set(p.x + Math.sin(c.titleAngle) * 150, p.y + 95, p.z + Math.cos(c.titleAngle) * 150);
    cam.lookAt(p.x, p.y, p.z);
    return;
  }
  applyCameraInput(w);
  const veh = w.player.vehicle;
  const target = veh ? veh.mesh.position : w.player.mesh.position;
  const speed = veh ? Math.abs(veh.speed) : 0;
  if (veh && w.time - c.lastLookTime > T.autoRecenterDelay && speed > 2) {
    const behind = veh.heading + (veh.speed < -1 && c.mode === 'third' ? 0 : Math.PI);
    const diff = Math.atan2(Math.sin(behind - c.yaw), Math.cos(behind - c.yaw));
    c.yaw += diff * (1 - Math.exp(-dt * T.autoRecenterSpeed));
    c.pitch += ((c.mode === 'first' ? 0 : 0.28) - c.pitch) * (1 - Math.exp(-dt * 1.5));
  }
  // No delayed recenter on foot: turning the character must never leave the camera pointing elsewhere.
  if (!veh) c.yaw = w.player.facing + Math.PI;
  const indoor = !!w.interiors?.active;
  const wantDist = veh ? T.distanceInCar + (veh.spec.halfExtents[2] - 2) * 2 : indoor ? T.indoorDistance : T.distanceOnFoot;
  c.dist += (wantDist - c.dist) * (1 - Math.exp(-dt * 3));
  desired.set(target.x, target.y + T.heightOffset, target.z);
  if (c.focus.distanceToSquared(desired) > 400) c.focus.copy(desired);
  c.focus.lerp(desired, 1 - Math.exp(-T.followLerp * dt));
  const cp = Math.cos(c.pitch);
  direction.set(Math.sin(c.yaw) * cp, Math.sin(c.pitch), Math.cos(c.yaw) * cp);
  const R = w.R;
  sweep ??= new R.Ball(T.collisionRadius);
  // A sphere protects the near plane, including beside door frames. Pull in immediately; return smoothly.
  const hit = w.physics.castShape(c.focus, IDENTITY, direction, sweep, 0, c.dist, true,
    R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC | R.QueryFilterFlags.EXCLUDE_SENSORS);
  let clear = hit ? Math.max(T.collisionGap, hit.time_of_impact - T.collisionGap) : c.dist;
  const interior = w.interiors?.entries.find(e => e.id === w.interiors.active);
  if (interior) {
    // The marked entrance is a scene transition. A chase camera must stay inside the room even through an open door.
    const inset = T.collisionRadius + T.collisionGap;
    const extents = [INTERIOR.halfWidth - inset, INTERIOR.halfDepth - inset];
    const axes = [[c.focus.x - interior.origin.x, direction.x, extents[0]], [c.focus.z - interior.origin.z, direction.z, extents[1]]];
    for (const [p, d, extent] of axes) if (Math.abs(d) > 1e-6) clear = Math.min(clear, Math.max(T.collisionGap, ((d > 0 ? extent : -extent) - p) / d));
  }
  if (clear < c.obstructionDistance) c.obstructionDistance = clear;
  else c.obstructionDistance += (clear - c.obstructionDistance) * (1 - Math.exp(-dt * T.collisionReturnSpeed));
  cam.position.copy(c.focus).addScaledVector(direction, Math.min(clear, c.obstructionDistance));
  const floor = w.city.heightAt(cam.position.x, cam.position.z, cam.position.y) + T.collisionRadius;
  if (cam.position.y < floor) cam.position.y = floor;
  if (veh) {
    let seat = driverSeats.get(veh.type);
    if (!seat) { seat = driverSeat(veh.type); driverSeats.set(veh.type, seat); }
    eye.copy(seat).applyQuaternion(veh.mesh.quaternion).add(veh.mesh.position);
  }
  else eye.set(target.x, target.y + T.eyeHeight, target.z);
  c.viewBlend += ((c.mode === 'first' ? 1 : 0) - c.viewBlend) * (1 - Math.exp(-dt * T.followLerp));
  if (Math.abs(c.viewBlend - (c.mode === 'first' ? 1 : 0)) < 0.001) c.viewBlend = c.mode === 'first' ? 1 : 0;
  cam.position.lerp(eye, c.viewBlend);
  look.copy(eye).addScaledVector(direction, -10).lerp(c.focus, 1 - c.viewBlend);
  cam.lookAt(look);
  const eyeDistance = cam.position.distanceTo(eye);
  c.playerObscured = eyeDistance < T.hidePlayerDistance + (c.playerObscured ? T.playerVisibilityHysteresis : 0);
  w.player.mesh.visible = !veh && c.mode === 'third' && !c.playerObscured;
  const sway = injurySway(w);
  if (sway) cam.rotateZ(sway);
  const fov = T.fov + T.fovSpeedBoost * Math.min(1, speed / (veh?.spec.maxSpeed ?? 1));
  if (Math.abs(cam.fov - fov) > 0.05) {
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 3)); cam.updateProjectionMatrix();
  }
}
