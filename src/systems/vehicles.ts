// Drivable cars: Rapier raycast vehicles with suspension, engine, brakes, handbrake drift,
// speed-sensitive steering, downforce, a yaw-stability assist, health and crash detection.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING, type CarSpec, type CarTypeName } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { buildCarParts, carMaterial, makeWheel, makeCarInterior } from '../art/car';
import { buildDamageableCar, applyImpact, type CarDamage } from './carDamage';
import { GROUPS } from '../physicsGroups';
import { act } from './input';
import type { ParkingSpot } from './map/cityMap';
import type { ParkedCar } from './parkedCars';

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
  steeringWheel: THREE.Object3D | null;
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
  lastRecovery: number;
  inWaterTimer: number;
  driven: boolean;
  wrecked: boolean;
  lastHitTime: number;
  dmg: CarDamage; // dents, bumpers, lights, windscreen
  px: number; // cached position (refreshed every physics step)
  py: number; // body centre height (same refresh)
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
  /** Owned by a local who isn't one of the simulated people (owner stays 'nobody'; the prompt says "a local's car"). */
  ownerLocal: boolean;
  // ---- parked-car pool (parkedCars.ts) ----
  /** One of the pooled cars that stand in for parked cars near you. */
  pooled: boolean;
  /** A pooled car not standing in for any parked car right now: hidden, body disabled, far away. */
  idle: boolean;
  /** The parked car this pooled car stands in for (null when idle or not pooled). */
  parked: ParkedCar | null;
  /** Drawn as an instance of the shared parked-car meshes while untouched (-1: its own meshes are shown). */
  inst: number;
  /** The paint its body was last coloured with (pooled cars are repainted for each parked car). */
  paint: THREE.Color;
  /** Body vertices that carry the paint (1) or its darker shade (2): built on the first repaint. */
  paintMask: Uint8Array | null;
}

/** Height of the chassis centre above the ground for a car of this spec at rest on its springs. */
export function rideHeight(spec: CarSpec): number {
  return -spec.wheelY + spec.suspensionRest * 0.75 + spec.wheelRadius + 0.02;
}

/** `y`: the surface the car stands on (a parking spot's y, e.g. on a sloping street); default: the ground there. */
export function spawnVehicle(w: World, type: CarTypeName, x: number, z: number, heading: number, paint?: THREE.Color, y?: number): Vehicle {
  const R = w.R;
  const spec = V.types[type];
  const [hx, hy, hz] = spec.halfExtents;
  const rideY = rideHeight(spec); // chassis centre height at rest
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const m = spec.mass;
  const inertia = { x: (m / 3) * (hy * hy + hz * hz), y: (m / 3) * (hx * hx + hz * hz), z: (m / 3) * (hx * hx + hy * hy) };
  const bodyDesc = R.RigidBodyDesc.dynamic()
    .setTranslation(x, (y ?? w.city.heightAt(x, z)) + rideY, z)
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
  const coat = paint ? paint.clone() : new THREE.Color(spec.color);
  const { bodyMesh, dmg } = buildDamageableCar({ mesh: group }, buildCarParts(type, coat));
  const interior = makeCarInterior(type);
  group.add(interior);
  const steeringWheel = interior.getObjectByName('steeringWheel') ?? null;
  const wheels: THREE.Group[] = [];
  for (const p of wheelPos) {
    const wg = makeWheel(spec.wheelRadius);
    wg.position.set(p.x, spec.wheelY - spec.suspensionRest, p.z);
    group.add(wg);
    wheels.push(wg);
  }
  w.scene.add(group);
  const v: Vehicle = {
    id: w.vehicles.length, type, spec, body, collider, ctrl, mesh: group, bodyMesh, wheels, steeringWheel,
    health: spec.health, maxHealth: spec.health, steer: 0, speed: 0, heading, slip: 0, throttle: 0,
    rearGrip: spec.frictionSlipRear, prevVel: new THREE.Vector3(), upsideTimer: 0, lastRecovery: -Infinity, inWaterTimer: 0,
    driven: false, wrecked: false, lastHitTime: -10, px: x, py: (y ?? w.city.heightAt(x, z)) + rideY, pz: z, dmg,
    owner: 'nobody', owned: false, locked: false, stolen: false, forSale: null, alarmUntil: 0, spotCls: null, ownerLocal: false,
    pooled: false, idle: false, parked: null, inst: -1, paint: coat, paintMask: null,
  };
  w.vehicles.push(v);
  w.colliderOwner.set(collider.handle, { kind: 'vehicle', id: v.id });
  syncMesh(v);
  return v;
}

/** A gentle, unobstructed physical departure for a freshly spawned owned car, using current scene queries. */
export function initialDepartureClear(w: Pick<World, 'city' | 'physics' | 'R'>, spot: ParkingSpot, spec: CarSpec): boolean {
  const limits = TUNING.geo.roadLimits, [hx, hy, hz] = spec.halfExtents;
  const sin = Math.sin(spot.heading), cos = Math.cos(spot.heading);
  const rotation = { x: 0, y: Math.sin(spot.heading / 2), z: 0, w: Math.cos(spot.heading / 2) };
  const shape = new w.R.Cuboid(hx, hy, hz);
  const step = 0.5; // same baseline as the road-limit kink audit
  let previous = NaN, grade = NaN, reference = spot.y;
  // Two parking spaces give the first owned car a usable departure before it needs a turn. Validate the physical
  // parking line, including its wheel tracks and chassis, rather than the nearby traffic lane's smoother profile.
  for (let d = -hz; d <= V.kerbSlotSpacing * 2 + hz; d += step) {
    const x = spot.x + sin * d, z = spot.z + cos * d;
    if (!w.city.isRoad(x, z) || w.city.isBlocked(x, z) || w.city.isWater(x, z)) return false;
    const y = w.city.heightAt(x, z, reference);
    const left = w.city.heightAt(x + cos * spec.wheelX, z - sin * spec.wheelX, y);
    const right = w.city.heightAt(x - cos * spec.wheelX, z + sin * spec.wheelX, y);
    if (![y, left, right].every(Number.isFinite) || Math.abs(left - right) / (2 * spec.wheelX) > limits.maxCrossSlope) return false;
    if (previous === previous) {
      const nextGrade = (y - previous) / step;
      if (Math.abs(nextGrade) > limits.maxGradeMain || (grade === grade && Math.abs(nextGrade - grade) * step > limits.maxStep)) return false;
      grade = nextGrade;
    }
    const at = { x, y: Math.max(y, left, right) + rideHeight(spec) + V.recoveryClearance, z };
    if (w.physics.intersectionWithShape(at, rotation, shape, w.R.QueryFilterFlags.ONLY_FIXED)) return false;
    previous = reference = y;
  }
  return true;
}

/** Spawn one of each starting type, preserving ownership/IDs; the owned cars prefer a safe departure near spawn.
 * Parked-car filling keeps clear of the returned spots and the dealership's reserved spots. */
export function spawnInitialVehicles(w: World, reserved: readonly { x: number; z: number }[] = []): { x: number; z: number }[] {
  // Rapier's query tree must include fixed colliders just created by the map, including on the grid fallback.
  // No vehicles exist yet; this refreshes queries before choosing any of their starting poses.
  w.physics.step();
  const start = w.city.spawn;
  const taken: { x: number; z: number }[] = [];
  const isFree = (s: { x: number; z: number }) => ![...reserved, ...taken].some((t) => Math.hypot(t.x - s.x, t.z - s.z) < V.kerbSlotSpacing * 0.5);
  // spots nearest the spawn, one of each type
  const spots = w.city.parkingSpots.filter((s) => s.cls !== 'lot').sort(
    (a, b) => (a.x - start.x) ** 2 + (a.z - start.z) ** 2 - ((b.x - start.x) ** 2 + (b.z - start.z) ** 2),
  );
  for (let k = 0; k < V.playerCarSpawn.length; k++) {
    const available = spots.filter(isFree);
    // Existing saves restore their own vehicle transforms later; this only chooses a fresh world's starting pose.
    const s = (k < V.ownedAtStart ? available.find(s => initialDepartureClear(w, s, V.types[V.playerCarSpawn[k]])) : null) ?? available[0];
    if (!s) break;
    taken.push(s);
    const v = spawnVehicle(w, V.playerCarSpawn[k], s.x, s.z, s.heading, undefined, s.y);
    v.owned = k < V.ownedAtStart;
    v.spotCls = s.cls;
  }
  return taken;
}

/** Colour a car's body (pooled parked cars get the paint of each parked car they stand in for). No allocation after the first call. */
export function repaintVehicle(v: Vehicle, paint: THREE.Color): void {
  const attr = v.bodyMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const col = attr.array as Float32Array;
  const n = col.length / 3;
  if (!v.paintMask) {
    // which vertices carry the paint (and the 0.8 shade the builder uses for lower panels)
    const m = new Uint8Array(n), p = v.paint, eq = (a: number, b: number) => Math.abs(a - b) < 1e-4;
    for (let i = 0; i < n; i++) {
      const r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
      if (eq(r, p.r) && eq(g, p.g) && eq(b, p.b)) m[i] = 1;
      else if (eq(r, p.r * 0.8) && eq(g, p.g * 0.8) && eq(b, p.b * 0.8)) m[i] = 2;
    }
    v.paintMask = m;
  }
  const m = v.paintMask;
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    const k = m[i] === 1 ? 1 : 0.8;
    col[i * 3] = paint.r * k;
    col[i * 3 + 1] = paint.g * k;
    col[i * 3 + 2] = paint.b * k;
  }
  attr.needsUpdate = true;
  v.paint.copy(paint);
}

/** Put the car's meshes where its body is (pooled cars after being moved while asleep). */
export function syncVehicleMesh(v: Vehicle): void {
  syncMesh(v);
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
    if (v.idle || (!v.driven && v.upsideTimer === 0 && v.body.isSleeping())) continue;
    const r = v.body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    fwd.set(0, 0, 1).applyQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    right.set(-1, 0, 0).applyQuaternion(q);
    v.heading = Math.atan2(fwd.x, fwd.z);
    const tp = v.body.translation();
    v.px = tp.x;
    v.py = tp.y;
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
      if (act.reset(inp) && resetUpright(w, v)) continue; // no forces from the old pose after teleporting
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
    if (v.idle || (!v.driven && v.body.isSleeping())) continue; // at rest (prevVel stays ~0 until it is woken)
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
  m.clearcoat = 0; // burnt paint is dull
  m.roughness = 0.9;
  m.metalness = 0.1;
  return m;
})();

function wreck(v: Vehicle) {
  v.wrecked = true;
  v.bodyMesh.material = wreckMaterial;
}

/** Recover to an absolute ground pose, never relative to the current chassis altitude. The full
 * rotated footprint is tested, so recovery next to a facade cannot place the chassis inside it. */
export function resetUpright(w: World, v: Vehicle): boolean {
  if (w.time - v.lastRecovery < V.recoveryCooldown) return false;
  const p = v.body.translation(), R = w.R;
  const [hx, hy, hz] = v.spec.halfExtents;
  const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.heading);
  const rotation = { x: qq.x, y: qq.y, z: qq.z, w: qq.w };
  const shape = new R.Cuboid(hx + V.recoveryClearance, hy, hz + V.recoveryClearance);
  const sin = Math.sin(v.heading), cos = Math.cos(v.heading);
  const candidate = (x: number, z: number): { x: number; y: number; z: number } | null => {
    let low = Infinity, high = -Infinity;
    for (const lx of [-hx, 0, hx]) for (const lz of [-hz, 0, hz]) {
      const sx = x + lx * cos + lz * sin, sz = z - lx * sin + lz * cos;
      if (w.city.isBlocked(sx, sz) || w.city.isWater(sx, sz)) return null;
      const gy = w.city.heightAt(sx, sz, p.y);
      if (!Number.isFinite(gy)) return null;
      low = Math.min(low, gy); high = Math.max(high, gy);
    }
    if (high - low > V.recoveryMaxGroundDelta) return null;
    const pos = { x, y: high + Math.max(rideHeight(v.spec), hy) + V.recoveryClearance, z };
    const blocked = w.physics.intersectionWithShape(pos, rotation, shape,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, v.collider, v.body);
    return blocked ? null : pos;
  };
  let spot = candidate(p.x, p.z);
  for (let radius = V.recoverySearchStep; !spot && radius <= V.recoverySearchRadius; radius += V.recoverySearchStep) {
    const count = Math.ceil(2 * Math.PI * radius / V.recoverySearchStep);
    for (let k = 0; k < count && !spot; k++) {
      const angle = k * Math.PI * 2 / count;
      spot = candidate(p.x + Math.cos(angle) * radius, p.z + Math.sin(angle) * radius);
    }
  }
  if (!spot) return false; // keep the existing pose if every nearby surface is unsafe
  v.body.setTranslation(spot, true);
  v.body.setRotation(rotation, true);
  v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  v.body.resetForces(true); v.body.resetTorques(true);
  for (let i = 0; i < 4; i++) {
    v.ctrl.setWheelEngineForce(i, 0); v.ctrl.setWheelBrake(i, 0); v.ctrl.setWheelSteering(i, 0);
  }
  v.prevVel.set(0, 0, 0); v.speed = 0; v.steer = 0; v.throttle = 0; v.slip = 0;
  v.px = spot.x; v.py = spot.y; v.pz = spot.z;
  v.upsideTimer = 0; v.inWaterTimer = 0; v.lastRecovery = w.time;
  syncMesh(v);
  return true;
}

function syncMesh(v: Vehicle) {
  const t = v.body.translation();
  const r = v.body.rotation();
  v.mesh.position.set(t.x, t.y, t.z);
  v.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  if (v.steeringWheel) v.steeringWheel.rotation.z = -v.steer * 2;
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
