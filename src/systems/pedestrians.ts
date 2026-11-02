// Pedestrians: walk daily routines between points of interest on the pavement graph,
// dodge and flee from reckless drivers, get knocked down, and stop to talk.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import { makePerson, animatePerson, type PersonRig } from '../art/person';
import { generateNpc, routineTarget, type NpcProfile } from '../npc/npc';

const PT = TUNING.peds;

export type PedState = 'walk' | 'idle' | 'flee' | 'dodge' | 'down' | 'talk';

export interface Ped {
  id: number;
  npc: NpcProfile;
  rig: PersonRig;
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
  speedingCd: number;
  offset: number; // personal lateral offset so crowds don't walk single file
  /** Set while someone is waiting at this ped as a taxi fare (taxi system owns them). */
  reserved: boolean;
}

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0522d'];
const SHIRT = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#e9c46a', '#6a4c93', '#ffffff', '#1d3557', '#ff8fab', '#8ac926', '#ff595e', '#3a86ff'];
const PANTS = ['#2b2d42', '#3d405b', '#5c4033', '#264653', '#6c757d', '#1b263b', '#a68a64'];
const HAIR = ['#2b1d0e', '#4a2c17', '#b5651d', '#e6c27a', '#111111', '#7f7f7f', '#a83232'];

export function spawnPeds(w: World): void {
  const rng = w.rng.fork(77);
  for (let k = 0; k < PT.count; k++) {
    const npc = generateNpc(k, rng, w.city);
    const C = (a: string[]) => new THREE.Color(rng.pick(a));
    const rig = makePerson(C(SHIRT), C(PANTS), C(SKIN), C(HAIR), rng.range(0.92, 1.08));
    w.scene.add(rig.root);
    const start = rng.pick(w.city.sideNodes);
    const ped: Ped = {
      id: k, npc, rig, pos: new THREE.Vector3(start.x, 0.02, start.z), heading: 0, state: 'idle', route: [], routeIdx: 0,
      targetPoi: -1, timer: rng.range(0, 3), vel: new THREE.Vector3(), fleeDir: new THREE.Vector2(), walkPhase: rng.range(0, 6),
      speedingCd: 0, offset: rng.range(-0.9, 0.9), reserved: false,
    };
    w.peds.push(ped);
  }
}

/** BFS over the pavement graph from the node nearest `from` to the target POI. */
export function planRoute(w: World, ped: Ped, poiId: number): void {
  const city = w.city;
  const poi = city.pois[poiId];
  let start = 0, bd = Infinity;
  for (const s of city.sideNodes) {
    const d = (s.x - ped.pos.x) ** 2 + (s.z - ped.pos.z) ** 2;
    if (d < bd) { bd = d; start = s.id; }
  }
  const goal = poi.sideNode;
  const prev = new Int32Array(city.sideNodes.length).fill(-2);
  prev[start] = -1;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    if (n === goal) break;
    for (const m of city.sideNodes[n].nbrs) if (prev[m] === -2) { prev[m] = n; queue.push(m); }
  }
  const ids: number[] = [];
  for (let n = goal; n !== -1 && n !== -2; n = prev[n]) ids.unshift(n);
  ped.route = ids.map((id) => new THREE.Vector2(city.sideNodes[id].x + ped.offset * 0.5, city.sideNodes[id].z + ped.offset * 0.5));
  ped.route.push(new THREE.Vector2(poi.x + ped.offset, poi.z + ped.offset * 0.3));
  ped.routeIdx = 0;
  ped.targetPoi = poiId;
  ped.state = 'walk';
}

function chooseDestination(w: World, ped: Ped): number {
  const want = routineTarget(ped.npc, w.dayNight.hour);
  if (want !== ped.targetPoi) return want;
  // already at the routine stop: wander to something nearby to keep the streets alive
  const near = w.city.pois.filter((p) => p.kind !== 'taxiRank' && Math.hypot(p.x - ped.pos.x, p.z - ped.pos.z) < 260);
  return near.length ? near[Math.floor(Math.random() * near.length)].id : want;
}

const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

export function updatePeds(w: World, dt: number): void {
  const pv = w.player.vehicle;
  let carPos: THREE.Vector3 | null = null;
  let carVel: THREE.Vector3 | null = null;
  let carSpeed = 0;
  if (pv) {
    const t = pv.body.translation();
    const lv = pv.body.linvel();
    carPos = new THREE.Vector3(t.x, t.y, t.z);
    carVel = new THREE.Vector3(lv.x, 0, lv.z);
    carSpeed = carVel.length();
    fwd.set(Math.sin(pv.heading), 0, Math.cos(pv.heading));
    right.set(-fwd.z, 0, fwd.x);
  }
  const cam = w.camera.position;

  for (const ped of w.peds) {
    ped.speedingCd -= dt;
    let moveSpeed = 0;

    if (ped.pos.y < -10) {
      // riding in the player's taxi: hidden and inert
      ped.rig.root.visible = false;
      continue;
    }
    // ---- reactions to the player's car ----
    if (pv && carPos && carVel && ped.state !== 'down') {
      tmp.copy(ped.pos).sub(carPos);
      const lz = tmp.dot(fwd), lx = tmp.dot(right);
      const hx = pv.spec.halfExtents[0] + 0.35, hz = pv.spec.halfExtents[2] + 0.35;
      const dist = Math.hypot(tmp.x, tmp.z);
      if (Math.abs(lx) < hx && Math.abs(lz) < hz && ped.pos.y < carPos.y + 1.2) {
        if (carSpeed > PT.hitSpeed) {
          knockDown(w, ped, carVel, carSpeed);
          continue;
        }
        // gentle bump: shove aside
        ped.pos.addScaledVector(right, Math.sign(lx || 1) * (hx - Math.abs(lx) + 0.05));
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

    switch (ped.state) {
      case 'down': {
        ped.timer -= dt;
        if (ped.pos.y > 0.02 || ped.vel.y > 0) {
          ped.vel.y -= 22 * dt;
          ped.pos.addScaledVector(ped.vel, dt);
          ped.rig.root.rotation.x = Math.max(-Math.PI / 2, ped.rig.root.rotation.x - dt * 7);
          if (ped.pos.y <= 0.02) { ped.pos.y = 0.02; ped.vel.set(ped.vel.x * 0.3, 0, ped.vel.z * 0.3); }
        } else {
          ped.pos.addScaledVector(ped.vel, dt);
          ped.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
        }
        if (ped.timer <= 0) {
          ped.rig.root.rotation.x = 0;
          startFlee(ped, w.player.mesh.position.x, w.player.mesh.position.z);
        }
        break;
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
        ped.pos.x += ped.fleeDir.x * PT.fleeSpeed * dt;
        ped.pos.z += ped.fleeDir.y * PT.fleeSpeed * dt;
        moveSpeed = PT.fleeSpeed;
        ped.heading = Math.atan2(ped.fleeDir.x, ped.fleeDir.y);
        if (ped.timer <= 0) planRoute(w, ped, chooseDestination(w, ped));
        break;
      }
      case 'idle': {
        ped.timer -= dt;
        if (ped.timer <= 0 && !ped.reserved) planRoute(w, ped, chooseDestination(w, ped));
        break;
      }
      case 'talk': {
        const pp = w.player.mesh.position;
        ped.heading = Math.atan2(pp.x - ped.pos.x, pp.z - ped.pos.z);
        break;
      }
      case 'walk': {
        const wp = ped.route[ped.routeIdx];
        if (!wp) { ped.state = 'idle'; ped.timer = 1; break; }
        const dx = wp.x - ped.pos.x, dz = wp.y - ped.pos.z;
        const d = Math.hypot(dx, dz);
        // wait at the kerb if a car is about to cross our path
        let speed = PT.walkSpeed * (0.85 + 0.3 * ((ped.id * 37) % 10) / 10);
        if (d < 0.4) {
          ped.routeIdx++;
          if (ped.routeIdx >= ped.route.length) {
            ped.state = 'idle';
            ped.timer = PT.idleTimeMin + Math.random() * (PT.idleTimeMax - PT.idleTimeMin);
          }
          break;
        }
        if (crossingBlocked(w, ped, dx / d, dz / d)) speed = 0;
        ped.pos.x += (dx / d) * speed * dt;
        ped.pos.z += (dz / d) * speed * dt;
        moveSpeed = speed;
        const target = Math.atan2(dx, dz);
        ped.heading += Math.atan2(Math.sin(target - ped.heading), Math.cos(target - ped.heading)) * Math.min(1, dt * 8);
        break;
      }
    }

    // keep out of buildings and the bay (simple clamp against building rects)
    if (ped.state === 'flee' || ped.state === 'dodge' || ped.state === 'down') pushOutOfBuildings(w, ped);

    // render
    const visible = ped.pos.distanceToSquared(cam) < 170 * 170;
    ped.rig.root.visible = visible;
    if (visible) {
      ped.rig.root.position.copy(ped.pos);
      ped.rig.root.rotation.y = ped.heading;
      ped.walkPhase += moveSpeed * dt * 3.2;
      animatePerson(ped.rig, ped.walkPhase, ped.state === 'down' ? 0 : Math.min(1.4, moveSpeed / PT.walkSpeed));
    }
  }
}

function crossingBlocked(w: World, ped: Ped, dx: number, dz: number): boolean {
  // only matters on the road: check moving cars within 14 m heading toward us
  const px = ped.pos.x + dx * 2, pz = ped.pos.z + dz * 2;
  for (const car of w.traffic) {
    if (car.speed < 2) continue;
    const t = car.body.translation();
    const rx = px - t.x, rz = pz - t.z;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const along = rx * fx + rz * fz;
    if (along > 0 && along < 14 && Math.abs(rx * fz - rz * fx) < 2.5) {
      // are we stepping into the road? (inside a road strip)
      return isOnRoad(w, px, pz);
    }
  }
  return false;
}

function isOnRoad(w: World, x: number, z: number): boolean {
  const c = w.city;
  for (let i = 0; i < c.xs.length; i++) if (Math.abs(x - c.xs[i]) < c.roadHalfX[i]) return true;
  for (let j = 0; j < c.zs.length; j++) if (Math.abs(z - c.zs[j]) < c.roadHalfZ[j]) return true;
  return false;
}

function pushOutOfBuildings(w: World, ped: Ped) {
  for (const r of w.city.buildingRects) {
    const m = 0.4;
    if (ped.pos.x > r.x0 - m && ped.pos.x < r.x1 + m && ped.pos.z > r.z0 - m && ped.pos.z < r.z1 + m) {
      const dl = ped.pos.x - (r.x0 - m), dr = r.x1 + m - ped.pos.x, dt = ped.pos.z - (r.z0 - m), db = r.z1 + m - ped.pos.z;
      const mn = Math.min(dl, dr, dt, db);
      if (mn === dl) ped.pos.x = r.x0 - m;
      else if (mn === dr) ped.pos.x = r.x1 + m;
      else if (mn === dt) ped.pos.z = r.z0 - m;
      else ped.pos.z = r.z1 + m;
      if (ped.state === 'flee') { ped.fleeDir.set(ped.fleeDir.y, -ped.fleeDir.x); }
    }
  }
  if (ped.pos.z > w.city.coastZ - 1) ped.pos.z = w.city.coastZ - 1;
}

export function startFlee(ped: Ped, fromX: number, fromZ: number, time = TUNING.peds.fleeTime): void {
  if (ped.state === 'down') return;
  ped.state = 'flee';
  ped.timer = time;
  ped.fleeDir.set(ped.pos.x - fromX, ped.pos.z - fromZ);
  if (ped.fleeDir.lengthSq() < 0.01) ped.fleeDir.set(Math.random() - 0.5, Math.random() - 0.5);
  ped.fleeDir.normalize();
}

function knockDown(w: World, ped: Ped, carVel: THREE.Vector3, speed: number) {
  ped.state = 'down';
  ped.timer = PT.knockdownTime;
  ped.vel.set(carVel.x * 0.7, Math.min(7, 2 + speed * 0.18), carVel.z * 0.7);
  ped.pos.y = 0.1;
  ped.reserved = false;
  emit(w, { type: 'pedHit', pedId: ped.id, x: ped.pos.x, z: ped.pos.z, speed });
  w.audio.thud?.(ped.pos.x, ped.pos.z, speed);
}

/** Nearest ped to a point within range that can be talked to. */
export function nearestPed(w: World, x: number, z: number, range: number): Ped | null {
  let best: Ped | null = null, bd = range;
  for (const p of w.peds) {
    if (p.state === 'down') continue;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
