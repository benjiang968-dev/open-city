// Third-person camera: follows smoothly, orbits with the mouse, swings behind the car when driving,
// and pulls in when a building is between it and the target.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';

const T = TUNING.camera;

export interface CameraState {
  yaw: number; // radians; camera sits at target + (sin(yaw), ., cos(yaw)) * dist
  pitch: number;
  dist: number;
  focus: THREE.Vector3; // smoothed look-at point
  titleAngle: number;
  /** Tests/screenshots only: fixed camera position and look-at point. */
  override: { px: number; py: number; pz: number; lx: number; ly: number; lz: number } | null;
}

export function createCamera(): CameraState {
  return { yaw: Math.PI, pitch: 0.32, dist: T.distanceOnFoot, focus: new THREE.Vector3(), titleAngle: 0, override: null };
}

const tmp = new THREE.Vector3();
const desired = new THREE.Vector3();

export function updateCamera(w: World, dt: number): void {
  const c = w.cam;
  const cam = w.camera;
  if (c.override) {
    const o = c.override;
    cam.position.set(o.px, o.py, o.pz);
    cam.lookAt(o.lx, o.ly, o.lz);
    return;
  }
  if (!w.started) {
    // slow orbit over the live city behind the title text
    c.titleAngle += dt * 0.05;
    const p = w.player.mesh.position;
    cam.position.set(p.x + Math.sin(c.titleAngle) * 150, 95, p.z + Math.cos(c.titleAngle) * 150);
    cam.lookAt(p.x, 0, p.z);
    return;
  }
  const inp = w.input;
  c.yaw -= inp.mouseDX * T.mouseSensitivity;
  c.pitch = THREE.MathUtils.clamp(c.pitch + inp.mouseDY * T.mouseSensitivity, T.minPitch, T.maxPitch);

  const veh = w.player.vehicle;
  let target: THREE.Vector3;
  let speed = 0;
  if (veh) {
    target = veh.mesh.position;
    speed = Math.abs(veh.speed);
    const sinceMouse = w.time - inp.mouseMovedAt;
    if (sinceMouse > T.autoRecenterDelay && speed > 2) {
      // swing behind the direction of travel (or ahead when reversing)
      const behind = veh.heading + (veh.speed < -1 ? 0 : Math.PI);
      const diff = Math.atan2(Math.sin(behind - c.yaw), Math.cos(behind - c.yaw));
      c.yaw += diff * Math.min(1, dt * T.autoRecenterSpeed);
      c.pitch += (0.28 - c.pitch) * Math.min(1, dt * 1.5);
    }
  } else {
    target = w.player.mesh.position;
    // stay behind the way the character faces (tank controls), unless the mouse is looking around
    if (w.time - inp.mouseMovedAt > T.autoRecenterDelay * 0.5) {
      const behind = w.player.facing + Math.PI;
      const diff = Math.atan2(Math.sin(behind - c.yaw), Math.cos(behind - c.yaw));
      c.yaw += diff * Math.min(1, dt * T.footRecenterSpeed);
    }
  }
  const wantDist = veh ? T.distanceInCar + (veh.spec.halfExtents[2] - 2) * 2 : T.distanceOnFoot;
  c.dist += (wantDist - c.dist) * Math.min(1, dt * 3);

  desired.set(target.x, target.y + T.heightOffset, target.z);
  // snap if the target jumped (teleport / enter car)
  if (c.focus.distanceToSquared(desired) > 400) c.focus.copy(desired);
  c.focus.lerp(desired, 1 - Math.exp(-T.followLerp * dt));

  const cp = Math.cos(c.pitch);
  tmp.set(Math.sin(c.yaw) * cp, Math.sin(c.pitch), Math.cos(c.yaw) * cp);
  // pull the camera in when something solid is in the way
  let dist = c.dist;
  const R = w.R;
  const ray = new R.Ray({ x: c.focus.x, y: c.focus.y, z: c.focus.z }, { x: tmp.x, y: tmp.y, z: tmp.z });
  const hit = w.physics.castRay(ray, dist, true, R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC);
  if (hit) dist = Math.max(1.2, hit.timeOfImpact - 0.3);
  cam.position.copy(c.focus).addScaledVector(tmp, dist);
  if (cam.position.y < 0.4) cam.position.y = 0.4;
  cam.lookAt(c.focus);

  const spec = veh ? veh.spec.maxSpeed : 1;
  const fov = T.fov + T.fovSpeedBoost * Math.min(1, speed / spec);
  if (Math.abs(cam.fov - fov) > 0.05) {
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
    cam.updateProjectionMatrix();
  }
}
