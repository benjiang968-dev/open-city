// Taxi job: a fare waits at a taxi rank (or anyone who accepts a ride in conversation). Stop next to them
// in any car, drive to their destination, stop, get paid by distance + speed; crashing loses the tip.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { World } from '../../world';
import { emit } from '../../world';
import type { JobMarker, JobSystem } from './jobManager';
import type { Ped } from '../pedestrians';
import type { Poi } from '../cityGen';
import { toast } from '../hud';
import { adjustRelationship, remember } from '../../npc/npc';

const TX = TUNING.economy.taxi;

type Phase = 'none' | 'waiting' | 'boarding' | 'riding' | 'cooldown';

export class TaxiJob implements JobSystem {
  id = 'taxi';
  label = 'Taxi';
  phase: Phase = 'none';
  ped: Ped | null = null;
  pickup = new THREE.Vector2(); // where the car must stop
  pickupName = '';
  dest: Poi | null = null;
  tripDist = 0;
  tripTime = 0;
  allowance = 0;
  startHealth = 0;
  vehicleId = -1;
  timer = 0;
  completed = 0;
  earned = 0;
  tipMarker: { x: number; z: number; until: number } | null = null;
  private beacon: THREE.Group;
  private beaconMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private cam: THREE.Vector3;

  constructor(w: World) {
    this.cam = w.camera.position;
    this.beacon = new THREE.Group();
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    const col = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 40, 16, 1, true).translate(0, 20, 0), this.beaconMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(TX.pickupRadius - 0.8, TX.pickupRadius, 40).rotateX(-Math.PI / 2).translate(0, 0.08, 0), this.ringMat);
    col.renderOrder = ring.renderOrder = 2;
    this.beacon.add(col, ring);
    this.beacon.visible = false;
    w.scene.add(this.beacon);
    this.phase = 'cooldown';
    this.timer = 0.5;
  }

  /** Spawn a fare at a rank: reuse a pedestrian who is out of view so the street stays consistent. */
  private spawnAtRank(w: World, rank?: Poi): void {
    const ranks = w.city.taxiRanks;
    const pp = w.player.mesh.position;
    if (!rank) {
      // prefer a rank that is not the one we're standing at, but not across the whole map either
      const sorted = [...ranks].sort((a, b) => Math.hypot(a.x - pp.x, a.z - pp.z) - Math.hypot(b.x - pp.x, b.z - pp.z));
      rank = this.completed === 0 ? sorted[0] : sorted[1 + Math.floor(Math.random() * (sorted.length - 1))];
    }
    const cam = w.camera.position;
    const candidates = w.peds.filter((p) => !p.reserved && p.state !== 'down' && p.state !== 'talk' && p.pos.distanceTo(cam) > 60);
    const ped = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : w.peds.find((p) => !p.reserved && p.state !== 'talk');
    if (!ped) return;
    ped.pos.set(rank.x + (Math.random() - 0.5) * 2, 0.02, rank.z + (Math.random() - 0.5) * 2);
    this.waitWith(ped, rank.curbX, rank.curbZ, rank.name);
  }

  /** Called by the chat system when an NPC accepts a ride where they stand. */
  startFromPed(w: World, ped: Ped): boolean {
    if (this.phase === 'riding' || this.phase === 'boarding') return false;
    if (this.ped && this.ped !== ped) this.release();
    // nearest kerb point on the closest road
    const c = w.city;
    let bx = ped.pos.x, bz = ped.pos.z, bd = Infinity;
    for (let i = 0; i < c.xs.length; i++) {
      const kx = c.xs[i] + Math.sign(ped.pos.x - c.xs[i]) * (c.roadHalfX[i] - 1.6);
      const d = Math.abs(ped.pos.x - kx);
      if (d < bd) { bd = d; bx = kx; bz = ped.pos.z; }
    }
    for (let j = 0; j < c.zs.length; j++) {
      const kz = c.zs[j] + Math.sign(ped.pos.z - c.zs[j]) * (c.roadHalfZ[j] - 1.6);
      const d = Math.abs(ped.pos.z - kz);
      if (d < bd) { bd = d; bx = ped.pos.x; bz = kz; }
    }
    this.waitWith(ped, bx, bz, `${ped.npc.name.split(' ')[0]} (here)`);
    return true;
  }

  private waitWith(ped: Ped, x: number, z: number, name: string) {
    this.ped = ped;
    ped.reserved = true;
    ped.state = 'idle';
    ped.timer = 9999;
    ped.route = [];
    this.pickup.set(x, z);
    this.pickupName = name;
    this.phase = 'waiting';
    this.dest = null;
  }

  private release() {
    if (this.ped) {
      this.ped.reserved = false;
      this.ped.rig.root.visible = true;
      if (this.ped.state === 'idle') this.ped.timer = 1;
      this.ped.rig.armR.rotation.z = 0;
    }
    this.ped = null;
  }

  /** Where fares can be found right now (for NPC tips). */
  waitingAt(w: World): Poi | null {
    if (this.phase !== 'waiting') return null;
    return w.city.taxiRanks.find((r) => Math.hypot(r.curbX - this.pickup.x, r.curbZ - this.pickup.y) < 5) ?? null;
  }

  /** NPC tip: make sure a fare is waiting at this rank and ping it on the map. */
  tipAbout(w: World, rank: Poi): void {
    if (this.phase === 'cooldown' || this.phase === 'none') this.spawnAtRank(w, rank);
    this.tipMarker = { x: rank.curbX, z: rank.curbZ, until: w.time + 60 };
  }

  update(w: World, dt: number): void {
    const pv = w.player.vehicle;
    const t = w.time;
    this.beacon.visible = false;
    if (this.tipMarker && t > this.tipMarker.until) this.tipMarker = null;
    switch (this.phase) {
      case 'cooldown':
      case 'none':
        this.timer -= dt;
        if (this.timer <= 0) this.spawnAtRank(w);
        break;
      case 'waiting': {
        const ped = this.ped!;
        if (!ped || ped.state === 'down' || !ped.reserved) {
          // our fare got run over or wandered off
          this.release();
          this.phase = 'cooldown';
          this.timer = TX.nextFareDelay;
          break;
        }
        // wave at passing cars
        ped.rig.armR.rotation.z = 2.6 + Math.sin(t * 6) * 0.3;
        ped.heading = Math.atan2(this.pickup.x - ped.pos.x, this.pickup.y - ped.pos.z);
        this.showBeacon(this.pickup.x, this.pickup.y, 0xffd23f, t);
        if (pv && !pv.wrecked) {
          const p = pv.body.translation();
          const d = Math.hypot(p.x - this.pickup.x, p.z - this.pickup.y);
          if (d < TX.pickupRadius && Math.abs(pv.speed) < TX.stopSpeed) {
            this.phase = 'boarding';
            this.timer = 1.0;
            this.vehicleId = pv.id;
          }
        }
        break;
      }
      case 'boarding': {
        const ped = this.ped!;
        this.timer -= dt;
        const v = w.vehicles[this.vehicleId];
        const p = v.body.translation();
        ped.pos.lerp(new THREE.Vector3(p.x, 0.02, p.z), Math.min(1, dt * 3));
        ped.heading = Math.atan2(p.x - ped.pos.x, p.z - ped.pos.z);
        if (w.player.vehicle !== v) { this.phase = 'waiting'; break; }
        if (this.timer <= 0) {
          ped.rig.root.visible = false;
          ped.rig.armR.rotation.z = 0;
          this.chooseDestination(w, p.x, p.z);
          this.phase = 'riding';
          this.tripTime = 0;
          this.startHealth = v.health;
          toast(w, `<span style="font-size:22px">${ped.npc.name}: "${this.dest!.name}, please."</span>`, 2.5);
        }
        break;
      }
      case 'riding': {
        const ped = this.ped!;
        const v = w.vehicles[this.vehicleId];
        const p = v.body.translation();
        ped.pos.set(p.x, -50, p.z); // carried along (hidden)
        this.tripTime += dt;
        this.showBeacon(this.dest!.curbX, this.dest!.curbZ, 0x3ddc84, t);
        if (w.player.vehicle !== v || v.wrecked) {
          // passenger bails out
          ped.pos.set(p.x + 2, 0.02, p.z);
          ped.rig.root.visible = true;
          adjustRelationship(ped.npc, -15);
          remember(ped.npc, 'crashed', v.wrecked ? 'wrecked the cab I was riding in' : 'kicked me out halfway', w.dayNight.hour, w.dayNight.day);
          toast(w, '<span style="color:#ef476f">Fare abandoned</span>', 2);
          this.release();
          this.phase = 'cooldown';
          this.timer = TX.nextFareDelay;
          break;
        }
        const d = Math.hypot(p.x - this.dest!.curbX, p.z - this.dest!.curbZ);
        if (d < TX.pickupRadius && Math.abs(v.speed) < TX.stopSpeed) this.complete(w, p.x, p.z, v.health);
        break;
      }
    }
  }

  private chooseDestination(w: World, x: number, z: number) {
    const options = w.city.pois.filter((p) => {
      if (p.kind === 'taxiRank') return false;
      const d = Math.hypot(p.curbX - x, p.curbZ - z);
      return d >= TX.minTripDistance && d <= TX.maxTripDistance;
    });
    const list = options.length ? options : w.city.pois.filter((p) => p.kind !== 'taxiRank');
    this.dest = list[Math.floor(Math.random() * list.length)];
    this.tripDist = Math.hypot(this.dest.curbX - x, this.dest.curbZ - z);
    // allowance uses Manhattan distance since the city is a grid
    const manhattan = Math.abs(this.dest.curbX - x) + Math.abs(this.dest.curbZ - z);
    this.allowance = manhattan / TX.expectedSpeed + 10;
  }

  private complete(w: World, x: number, z: number, health: number) {
    const ped = this.ped!;
    const base = TX.baseFare + TX.perMetre * this.tripDist;
    let fare = base;
    let bonus = 0;
    if (this.tripTime < this.allowance) bonus = TX.timeBonusMax * (1 - this.tripTime / this.allowance);
    const late = this.tripTime > this.allowance * TX.lateAfterFactor;
    if (late) fare *= TX.lateFareFactor;
    const crashed = this.startHealth - health >= TX.crashTipLossDamage;
    const tip = crashed || late ? 0 : fare * TX.tipFraction;
    const total = Math.round(fare + bonus + tip);
    w.cash += total;
    this.completed++;
    this.earned += total;
    emit(w, { type: 'fareComplete', x, z, pay: total });
    w.audio.chime?.();
    const parts = [`fare $${Math.round(fare)}`];
    if (bonus >= 1) parts.push(`speed +$${Math.round(bonus)}`);
    parts.push(crashed ? 'no tip (you crashed)' : late ? 'no tip (late)' : `tip $${Math.round(tip)}`);
    toast(w, `<span style="color:#9be564">+$${total}</span><br><span style="font-size:16px">${parts.join(' · ')}</span>`, 3.5);
    // passenger steps out and goes about their day
    ped.pos.set(this.dest!.x, 0.02, this.dest!.z);
    ped.rig.root.visible = true;
    adjustRelationship(ped.npc, crashed ? -5 : 12);
    remember(ped.npc, 'fareDone', crashed ? 'drove me like a maniac, but got me there' : 'gave me a smooth taxi ride', w.dayNight.hour, w.dayNight.day);
    this.release();
    this.phase = 'cooldown';
    this.timer = TX.nextFareDelay;
  }

  private showBeacon(x: number, z: number, color: number, t: number) {
    this.beacon.visible = true;
    this.beacon.position.set(x, 0, z);
    this.beaconMat.color.setHex(color);
    this.ringMat.color.setHex(color);
    // fade the column when the camera is close so it never washes out the screen
    const camD = Math.hypot(this.cam.x - x, this.cam.z - z);
    const fade = Math.min(1, Math.max(0.12, (camD - 6) / 30));
    this.beaconMat.opacity = (0.25 + Math.sin(t * 3) * 0.08) * fade;
  }

  status(w: World): string {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const pp = w.player.mesh.position;
    switch (this.phase) {
      case 'waiting': {
        const d = Math.round(Math.hypot(this.pickup.x - pp.x, this.pickup.y - pp.z));
        const name = this.ped?.npc.name ?? 'Someone';
        return w.player.vehicle
          ? `🚕 ${name} needs a ride at <b>${this.pickupName}</b> · ${d} m`
          : `🚕 Fare waiting at <b>${this.pickupName}</b> · ${d} m <span style="opacity:.7">(get a car)</span>`;
      }
      case 'boarding':
        return '🚕 Passenger getting in…';
      case 'riding': {
        const d = Math.round(Math.hypot(this.dest!.curbX - pp.x, this.dest!.curbZ - pp.z));
        const left = this.allowance - this.tripTime;
        const clock = left >= 0 ? `<span style="color:#9be564">${fmt(left)}</span>` : `<span style="color:#ef476f">late ${fmt(-left)}</span>`;
        return `🚕 Drop ${this.ped?.npc.name.split(' ')[0]} at <b>${this.dest!.name}</b> (${this.dest!.street}) · ${d} m · ${clock}`;
      }
      default:
        return '';
    }
  }

  markers(w: World): JobMarker[] {
    const m: JobMarker[] = [];
    if (this.phase === 'waiting' || this.phase === 'boarding') m.push({ x: this.pickup.x, z: this.pickup.y, color: '#ffd23f', kind: 'pickup' });
    if (this.phase === 'riding' && this.dest) m.push({ x: this.dest.curbX, z: this.dest.curbZ, color: '#3ddc84', kind: 'dropoff' });
    if (this.tipMarker && w.time < this.tipMarker.until) m.push({ x: this.tipMarker.x, z: this.tipMarker.z, color: '#7bdff2', kind: 'tip' });
    return m;
  }

  debug(): string {
    return `${this.phase} done=${this.completed} earned=$${this.earned}${this.dest ? ` → ${this.dest.name}` : ''}`;
  }
}
