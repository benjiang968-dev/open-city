// Drivable cars: Rapier raycast vehicles with suspension, engine, brakes, handbrake drift,
// speed-sensitive steering, downforce, a yaw-stability assist, health and crash detection.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarSpec, type CarTypeName } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { buildCarParts, carMaterial, makeWheel } from '../art/car';
import { buildDamageableCar, applyImpact, type CarDamage } from './carDamage';
import { GROUPS } from '../physicsGroups';
import { act } from './input';
import type { ParkingSpot } from './map/cityMap';

const V = TUNING.vehicles;

// Sign conventions verified by the scripted test drive (scripts/drive-test.mjs).
const STEER_SIGN = 1; // +input (left) -> positive wheel steering angle
const ENGINE_SIGN = 1; // +force drives toward local +Z

export interface Vehicle {
  id: number;
  type: CarTypeName;
  spec: CarSpec;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  ctrl: RAPIER.DynamicRayCastVehicleController;
  mesh: THREE.Group;
  bodyMesh: THREE.Mesh;
  wheels: THREE.Group[];
  health: number;
  maxHealth: number;
  steer: number; // current wheel angle (radians)
  speed: number; // signed forward speed m/s
  heading: number; // yaw: forward = (sin h, 0, cos h)
  slip: number; // 0..1 lateral slip, drives tyre audio
  throttle: number; // -1..1 last applied, drives engine audio
  rearGrip: number; // current rear friction slip (blends back after handbrake)
  prevVel: THREE.Vector3;
  upsideTimer: number;
  inWaterTimer: number;
  driven: boolean;
  wrecked: boolean;
  lastHitTime: number;
  dmg: CarDamage; // dents, bumpers, lights, windscreen
  px: number; // cached position (refreshed every physics step)
  pz: number;
  // ---- ownership (M3) ----
  /** Whose car this is: an NPC id (index into w.peds) or 'nobody' (abandoned, or stock at a dealership). */
  owner: number | 'nobody';
  owned: boolean; // the player's own car: driving it is never theft and it has no alarm for you
  locked: boolean; // getting in means smashing the side window (alarm!)
  stolen: boolean; // the player already took it; getting back in isn't a new crime
  /** Display car at a dealership (E shows price and stats, buys it). */
  forSale: { site: number; slot: number; price: number } | null;
  alarmUntil: number; // w.time until which the car alarm sounds
  /** Class of the parking spot it was parked on at load (road class or 'lot'), null if not from a spot. */
  spotCls: ParkingSpot['cls'] | null;
}

export function spawnVehicle(w: World, type: CarTypeName, x: number, z: number, heading: number, paint?: THREE.Color): Vehicle {
  const R = w.R;
  const spec = V.types[type];
  const [hx, hy, hz] = spec.halfExtents;
  const rideY = -spec.wheelY + spec.suspensionRest * 0.75 + spec.wheelRadius + 0.02; // chassis centre height at rest
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const m = spec.mass;
  const inertia = { x: (m / 3) * (hy * hy + hz * hz), y: (m / 3) * (hx * hx + hz * hz), z: (m / 3) * (hx * hx + hy * hy) };
  const bodyDesc = R.RigidBodyDesc.dynamic()
    .setTranslation(x, w.city.heightAt(x, z) + rideY, z)
    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    .setAdditionalMassProperties(m, { x: 0, y: spec.comHeight, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
    .setLinearDamping(V.linearDamping)
    .setAngularDamping(V.angularDamping)
    .setCcdEnabled(V.playerCcd);
  const body = w.physics.createRigidBody(bodyDesc);
  const collider = w.physics.createCollider(
    R.ColliderDesc.cuboid(hx, hy, hz).setDensity(0).setFriction(0.3).setRestitution(0.1).setCollisionGroups(GROUPS.vehicle),
    body,
  );
  const ctrl = w.physics.createVehicleController(body);
  ctrl.indexUpAxis = 1;
  (ctrl as unknown as { setIndexForwardAxis: number }).setIndexForwardAxis = 2;
  const wheelPos = [
    { x: spec.wheelX, z: spec.wheelZFront }, // 0 front-left (+X is the car's left)
    { x: -spec.wheelX, z: spec.wheelZFront }, // 1 front-right
    { x: spec.wheelX, z: spec.wheelZRear }, // 2 rear-left
    { x: -spec.wheelX, z: spec.wheelZRear }, // 3 rear-right
  ];
  for (const p of wheelPos) {
    ctrl.addWheel({ x: p.x, y: spec.wheelY, z: p.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, spec.suspensionRest, spec.wheelRadius);
  }
  for (let i = 0; i < 4; i++) {
    ctrl.setWheelSuspensionStiffness(i, spec.suspensionStiffness);
    ctrl.setWheelSuspensionCompression(i, spec.suspensionCompression);
    ctrl.setWheelSuspensionRelaxation(i, spec.suspensionRelaxation);
    ctrl.setWheelMaxSuspensionTravel(i, spec.maxSuspensionTravel);
    ctrl.setWheelMaxSuspensionForce(i, spec.maxSuspensionForce);
    ctrl.setWheelFrictionSlip(i, i < 2 ? spec.frictionSlipFront : spec.frictionSlipRear);
    ctrl.setWheelSideFrictionStiffness(i, spec.sideFrictionStiffness);
  }

  const group = new THREE.Group();
  const { bodyMesh, dmg } = buildDamageableCar({ mesh: group }, buildCarParts(type, paint ?? new THREE.Color(spec.color)));
  const wheels: THREE.Group[] = [];
  for (const p of wheelPos) {
    const wg = makeWheel(spec.wheelRadius);
    wg.position.set(p.x, spec.wheelY - spec.suspensionRest, p.z);
    group.add(wg);
    wheels.push(wg);
  }
  w.scene.add(group);
  const v: Vehicle = {
    id: w.vehicles.length, type, spec, body, collider, ctrl, mesh: group, bodyMesh, wheels,
    health: spec.health, maxHealth: spec.health, steer: 0, speed: 0, heading, slip: 0, throttle: 0,
    rearGrip: spec.frictionSlipRear, prevVel: new THREE.Vector3(), upsideTimer: 0, inWaterTimer: 0,
    driven: false, wrecked: false, lastHitTime: -10, px: x, pz: z, dmg,
    owner: 'nobody', owned: false, locked: false, stolen: false, forSale: null, alarmUntil: 0, spotCls: null,
  };
  w.vehicles.push(v);
  w.colliderOwner.set(collider.handle, { kind: 'vehicle', id: v.id });
  syncMesh(v);
  return v;
}

type SpotClass = keyof typeof V.parkedCarsPer100m;

/**
 * Spawns the starting cars at the kerb spots nearest the player's spawn (the first `ownedAtStart` are yours),
 * then parks drivable cars on the map's parking spots at `parkedCarsPer100m` for each spot's class (its road
 * class, or 'lot' for car parks). Owners and locks are assigned once people exist (carTheft.assignCarOwners).
 * `reserved` kerb spots (dealership showrooms) stay free.
 */
export function spawnInitialVehicles(w: World, reserved: readonly { x: number; z: number }[] = []): void {
  const start = w.city.spawn;
  const rng = w.rng.fork(31);
  const taken: { x: number; z: number }[] = [...reserved];
  const isFree = (s: { x: number; z: number }) => !taken.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < V.kerbSlotSpacing * 0.5);
  // spots nearest the spawn, one of each type
  const spots = [...w.city.parkingSpots].sort(
    (a, b) => (a.x - start.x) ** 2 + (a.z - start.z) ** 2 - ((b.x - start.x) ** 2 + (b.z - start.z) ** 2),
  ).filter(isFree);
  V.playerCarSpawn.forEach((t, k) => {
    const s = spots[k];
    taken.push(s);
    const v = spawnVehicle(w, t, s.x, s.z, s.heading);
    v.owned = k < V.ownedAtStart;
    v.spotCls = s.cls;
  });
  const types = Object.keys(V.types) as CarTypeName[];
  const paints = ['#e63946', '#f1faee', '#457b9d', '#2a9d8f', '#e9c46a', '#264653', '#8d99ae', '#ff8fab', '#606c38', '#bc6c25'];
  for (const cls of Object.keys(V.parkedCarsPer100m) as SpotClass[]) {
    const pool = w.city.parkingSpots.filter((s) => s.cls === cls);
    const want = Math.round(((pool.length * V.kerbSlotSpacing) / 100) * V.parkedCarsPer100m[cls]);
    let placed = 0, tries = 0;
    while (placed < want && pool.length && tries++ < 500) {
      const s = pool[Math.floor(rng.next() * pool.length)];
      if (Math.hypot(s.x - start.x, s.z - start.z) < V.parkedClearOfRank || !isFree(s)) continue;
      taken.push(s);
      spawnVehicle(w, rng.pick(types), s.x, s.z, s.heading, new THREE.Color(rng.pick(paints))).spotCls = s.cls;
      placed++;
    }
  }
}

const q = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const right = new THREE.Vector3();
const vel = new THREE.Vector3();

export function updateVehicles(w: World, dt: number): void {
  for (const v of w.vehicles) {
    // parked and at rest: Rapier has put the body to sleep, so skip it (no controller update and no
    // allocating Rapier reads). Anything that bumps it (a car, you, a thrown brick) wakes it up again.
    // A car that fell asleep on its roof or side (upsideTimer running) is still updated so it gets righted.
    if (!v.driven && v.upsideTimer === 0 && v.body.isSleeping()) continue;
    const r = v.body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    fwd.set(0, 0, 1).applyQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    right.set(-1, 0, 0).applyQuaternion(q);
    v.heading = Math.atan2(fwd.x, fwd.z);
    const tp = v.body.translation();
    v.px = tp.x;
    v.pz = tp.z;
    const lv = v.body.linvel();
    vel.set(lv.x, lv.y, lv.z);
    const speedAbs = vel.length();

    const driving = v.driven && !v.wrecked && w.started;
    const inp = w.input;
    let throttle = 0, brake = 0, steerIn = 0, hand = false;
    if (driving) {
      const f = act.forward(inp), b = act.back(inp);
      steerIn = (act.left(inp) ? 1 : 0) - (act.right(inp) ? 1 : 0);
      hand = act.handbrake(inp);
      if (f && !b) {
        if (v.speed < -1) brake = 1;
        else throttle = 1;
      } else if (b && !f) {
        if (v.speed > 1) brake = 1;
        else throttle = -1;
      }
      if (act.reset(inp)) resetUpright(w, v);
    } else if (!v.driven || v.wrecked) {
      brake = 0.4; // parked or wrecked: wheels drag
    }

    // speed-sensitive steering
    const wheelbase = v.spec.wheelZFront - v.spec.wheelZRear;
    const sp = Math.min(1, Math.abs(v.speed) / v.spec.highSpeedSteerAt);
    const v2 = Math.max(1, v.speed * v.speed);
    const gripSteer = Math.atan((wheelbase * V.gripLatAccel * V.steerOverGrip) / v2);
    const maxSteer = Math.min(THREE.MathUtils.lerp(v.spec.maxSteer, v.spec.steerAtSpeed, sp), Math.max(gripSteer, v.spec.steerAtSpeed * 0.5));
    const target = steerIn * maxSteer;
    const rate = v.spec.steerRate * (Math.abs(target) < Math.abs(v.steer) ? 1.8 : 1);
    v.steer += THREE.MathUtils.clamp(target - v.steer, -rate * dt, rate * dt);

    // engine force fades as top speed approaches
    const fade = Math.max(0, 1 - Math.pow(Math.abs(v.speed) / v.spec.maxSpeed, 2));
    const force = throttle > 0 ? v.spec.engineForce * fade : throttle < 0 ? -v.spec.reverseForce * fade : 0;
    v.throttle = throttle;
    const coasting = throttle === 0 && brake === 0;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const drivenWheel = front ? v.spec.driveFront : v.spec.driveRear;
      v.ctrl.setWheelEngineForce(i, drivenWheel ? force * ENGINE_SIGN : 0);
      v.ctrl.setWheelSteering(i, front ? v.steer * STEER_SIGN : 0);
      let b = brake * v.spec.brakeForce + (coasting && driving ? V.rollingResistance : 0);
      if (!front && hand) b += v.spec.handbrakeForce;
      v.ctrl.setWheelBrake(i, b * dt);
    }
    // handbrake drops rear grip; grip blends back so drifts exit smoothly
    const grip = w.weather?.grip ?? 1; // rain, storm and snow cut grip
    v.ctrl.setWheelFrictionSlip(0, v.spec.frictionSlipFront * grip);
    v.ctrl.setWheelFrictionSlip(1, v.spec.frictionSlipFront * grip);
    const wantRear = (hand ? v.spec.handbrakeRearSlip : v.spec.frictionSlipRear) * grip;
    v.rearGrip += (wantRear - v.rearGrip) * Math.min(1, dt * (hand ? 12 : 2.5));
    v.ctrl.setWheelFrictionSlip(2, v.rearGrip);
    v.ctrl.setWheelFrictionSlip(3, v.rearGrip);

    v.ctrl.updateVehicle(dt, undefined, GROUPS.wheelRays); // wheels roll over litter and never touch people
    v.speed = v.ctrl.currentVehicleSpeed();

    // grounded wheels count for assists
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (v.ctrl.wheelIsInContact(i)) contacts++;
    if (contacts >= 2 && v.driven) {
      // downforce keeps the car planted at speed (driven cars only: these writes wake the body, and a
      // parked car must be allowed to fall asleep)
      const df = V.downforce * speedAbs * speedAbs * (v.spec.mass / 1000) * dt;
      v.body.applyImpulse({ x: -up.x * df, y: -up.y * df, z: -up.z * df }, true);
      // yaw stability: damp yaw rate beyond what the steering asks for
      const maxYaw = (V.gripLatAccel * 1.25) / Math.max(3, Math.abs(v.speed));
      const wantYaw = THREE.MathUtils.clamp((v.speed * Math.tan(v.steer * STEER_SIGN)) / wheelbase, -maxYaw, maxYaw);
      const av = v.body.angvel();
      const excess = av.y - wantYaw;
      const assist = hand ? V.driftYawAssist : V.yawStability;
      const k = Math.min(1, assist * dt * 4);
      v.body.setAngvel({ x: av.x, y: av.y - excess * k, z: av.z }, true);
    }

    // lateral slip for audio/HUD
    const lat = Math.abs(vel.dot(right));
    v.slip = speedAbs > 3 ? Math.min(1, lat / Math.max(4, speedAbs)) : 0;

    // flipped? auto-right after a moment
    if (up.y < 0.35 && speedAbs < 3) {
      v.upsideTimer += dt;
      if (v.upsideTimer > V.flipRecoverTime) resetUpright(w, v);
    } else v.upsideTimer = 0;

    syncMesh(v);
  }
}

/** Called after the physics step: detect sudden speed changes (crashes) on the player's car. */
export function detectCrashes(w: World): void {
  for (const v of w.vehicles) {
    if (!v.driven && v.body.isSleeping()) continue; // at rest (prevVel stays ~0 until it is woken)
    const lv = v.body.linvel();
    vel.set(lv.x, lv.y, lv.z);
    const dv = vel.distanceTo(v.prevVel);
    const prevSpeed = v.prevVel.length();
    const dvx = vel.x - v.prevVel.x, dvy = vel.y - v.prevVel.y, dvz = vel.z - v.prevVel.z;
    v.prevVel.copy(vel);
    if (!v.driven && dv < V.crashDamageThreshold * 2) continue; // parked cars only dent when hit hard
    if (dv > V.crashDamageThreshold && w.time - v.lastHitTime > 0.4) {
      v.lastHitTime = w.time;
      const dmg = (dv - V.crashDamageThreshold) * V.crashDamagePerMs;
      v.health = Math.max(0, v.health - dmg);
      const p = v.body.translation();
      if (v.driven) emit(w, { type: 'crash', x: p.x, z: p.z, damage: dmg, dv });
      // what did we hit?
      if (v.driven) w.physics.contactPairsWith(v.collider, (other) => {
        const owner = w.colliderOwner.get(other.handle);
        if (owner && (owner.kind === 'traffic' || owner.kind === 'police' || owner.kind === 'vehicle')) {
          emit(w, { type: 'carHit', targetKind: owner.kind === 'vehicle' ? 'parked' : owner.kind, x: p.x, z: p.z, speed: prevSpeed });
        }
      });
      applyImpact(w, v, dvx, dvy, dvz, dv);
      if (v.health <= 0 && !v.wrecked) wreck(v);
    }
  }
}

/** Shared burnt-out look (one material, pre-compiled at load so wrecking never compiles a shader). */
export const wreckMaterial = (() => {
  const m = carMaterial.clone();
  m.color.setRGB(0.35, 0.33, 0.32);
  return m;
})();

function wreck(v: Vehicle) {
  v.wrecked = true;
  v.bodyMesh.material = wreckMaterial;
}

export function resetUpright(w: World, v: Vehicle): void {
  const p = v.body.translation();
  const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.heading);
  v.body.setTranslation({ x: p.x, y: Math.max(p.y, w.city.heightAt(p.x, p.z)) + 1.2, z: p.z }, true);
  v.body.setRotation({ x: qq.x, y: qq.y, z: qq.z, w: qq.w }, true);
  v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  v.upsideTimer = 0;
}

function syncMesh(v: Vehicle) {
  const t = v.body.translation();
  const r = v.body.rotation();
  v.mesh.position.set(t.x, t.y, t.z);
  v.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  for (let i = 0; i < 4; i++) {
    const susp = v.ctrl.wheelSuspensionLength(i) ?? v.spec.suspensionRest;
    const wg = v.wheels[i];
    wg.position.y = v.spec.wheelY - susp;
    wg.rotation.set(0, 0, 0);
    wg.rotateY(v.ctrl.wheelSteering(i) ?? 0);
    wg.rotateX(v.ctrl.wheelRotation(i) ?? 0);
  }
}

export function vehicleForward(v: Vehicle, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(v.heading), 0, Math.cos(v.heading));
}
