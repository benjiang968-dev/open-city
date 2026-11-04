// Taxi job: a fare waits at a taxi rank (or anyone who accepts a ride in conversation). Stop next to them
// in any car, drive to their destination, stop, get paid by distance + speed; crashing loses the tip.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { World } from '../../world';
import { emit } from '../../world';
import type { JobMarker, JobSystem } from './jobManager';
import type { Ped } from '../pedestrians';
import { roadRouter, type KerbHit, type LaneEdge, type LaneHit, type Poi } from '../map/cityMap';
import { toast } from '../hud';
import { adjustRelationship, remember } from '../../npc/npc';

const TX = TUNING.economy.taxi;
const FOOT = 0.02; // people stand this far above the ground
const KERB: KerbHit = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
const HA: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const HB: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
const boardTo = new THREE.Vector3();

type Phase = 'none' | 'waiting' | 'boarding' | 'riding' | 'cooldown';

/**
 * The cross street nearest a place along its own street: the other named street at the closest junction where its
 * street meets another (within TX.crossStreetRange), or null. Once per fare.
 */
function crossStreet(w: World, poi: Poi): string | null {
  const { nodes, edges } = w.city.roads;
  let best: string | null = null, bd: number = TX.crossStreetRange;
  for (const n of nodes) {
    if (!n.junction) continue;
    const d = Math.hypot(n.x - poi.curbX, n.z - poi.curbZ);
    if (d >= bd) continue;
    let onStreet = false, other: string | null = null;
    for (const list of [n.in, n.out]) for (const id of list) {
      const name = edges[id].name;
      if (!name) continue;
      if (name === poi.street) onStreet = true;
      else other ??= name;
    }
    if (onStreet && other) { bd = d; best = other; }
  }
  return best;
}

export class TaxiJob implements JobSystem {
  id = 'taxi';
  label = 'Taxi';
  phase: Phase = 'none';
  ped: Ped | null = null;
  pickup = new THREE.Vector2(); // where the car must stop
  pickupName = '';
  dest: Poi | null = null;
  /** The nearest cross street of the destination's street (shown in the HUD: "M St NW at 31st St NW"). */
  destCross: string | null = null;
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
    const candidates = w.peds.filter((p) => p.active && !p.hidden && p.followId < 0 && !p.dog && p.archetype !== 'parent' && p.phoneMode === null && !p.reserved && p.state !== 'down' && p.state !== 'talk' && p.pos.distanceTo(cam) > 60);
    const ped = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : w.peds.find((p) => !p.reserved && p.state !== 'talk');
    if (!ped) return;
    const px = rank.x + (Math.random() - 0.5) * 2, pz = rank.z + (Math.random() - 0.5) * 2;
    ped.pos.set(px, w.city.heightAt(px, pz) + FOOT, pz);
    this.waitWith(ped, rank.curbX, rank.curbZ, rank.name);
  }

  /** Called by the chat system when an NPC accepts a ride where they stand. */
  startFromPed(w: World, ped: Ped): boolean {
    if (this.phase === 'riding' || this.phase === 'boarding') return false;
    if (this.ped && this.ped !== ped) this.release();
    // the kerb stopping point nearest to where they stand
    const k = w.city.kerbPoint(ped.pos.x, ped.pos.z, KERB, ped.pos.y);
    const street = k ? w.city.roads.edges[KERB.edge]?.name : null;
    this.waitWith(ped, k ? KERB.x : ped.pos.x, k ? KERB.z : ped.pos.z, street ? `${ped.npc.name.split(' ')[0]}, ${street}` : `${ped.npc.name.split(' ')[0]} (here)`);
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
      this.ped.hidden = false;
      this.ped.body.setEnabled(true);
      if (this.ped.state === 'idle') this.ped.timer = 1;
    }
    this.ped = null;
  }

  /** Drop the current fare (player knocked out, etc.). */
  cancel(w: World): void {
    if (this.ped && this.phase === 'riding') {
      const p = w.player.mesh.position;
      this.ped.pos.set(p.x + 2, w.city.heightAt(p.x + 2, p.z) + FOOT, p.z);
    }
    this.release();
    this.dest = null;
    this.phase = 'cooldown';
    this.timer = TX.nextFareDelay * 3;
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
        ped.heading = Math.atan2(this.pickup.x - ped.pos.x, this.pickup.y - ped.pos.z);
        this.showBeacon(w, this.pickup.x, this.pickup.y, 0xffd23f, t);
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
        ped.pos.lerp(boardTo.set(p.x, w.city.heightAt(p.x, p.z) + FOOT, p.z), Math.min(1, dt * 3));
        ped.heading = Math.atan2(p.x - ped.pos.x, p.z - ped.pos.z);
        if (w.player.vehicle !== v) { this.phase = 'waiting'; break; }
        if (this.timer <= 0) {
          ped.hidden = true;
          ped.body.setEnabled(false);
          this.chooseDestination(w, p.x, p.z, p.y);
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
        this.showBeacon(w, this.dest!.curbX, this.dest!.curbZ, 0x3ddc84, t);
        if (w.player.vehicle !== v || v.wrecked) {
          // passenger bails out
          ped.pos.set(p.x + 2, w.city.heightAt(p.x + 2, p.z) + FOOT, p.z);
          ped.hidden = false;
          ped.body.setEnabled(true);
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

  private chooseDestination(w: World, x: number, z: number, y: number) {
    // a shop, restaurant, hotel, museum, park... (a home now and then): the HUD names the place and its street
    const home = Math.random() < TX.homeDestShare;
    const inRange = (p: Poi) => {
      if (p.kind === 'taxiRank' || (p.kind === 'apartment') !== home) return false;
      const d = Math.hypot(p.curbX - x, p.curbZ - z);
      return d >= TX.minTripDistance && d <= TX.maxTripDistance;
    };
    let list = w.city.pois.filter(inRange);
    if (!list.length) list = w.city.pois.filter((p) => p.kind !== 'taxiRank' && p.kind !== 'apartment');
    if (!list.length) list = w.city.pois.filter((p) => p.kind !== 'taxiRank');
    this.dest = list[Math.floor(Math.random() * list.length)];
    this.destCross = crossStreet(w, this.dest);
    this.tripDist = Math.hypot(this.dest.curbX - x, this.dest.curbZ - z);
    // time allowance from the driving distance along the roads (one-way streets and all)
    this.allowance = routeDistance(w, x, z, this.dest.curbX, this.dest.curbZ, y) / TX.expectedSpeed + 10;
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
    ped.pos.set(this.dest!.x, w.city.heightAt(this.dest!.x, this.dest!.z) + FOOT, this.dest!.z);
    ped.hidden = false;
    ped.body.setEnabled(true);
    adjustRelationship(ped.npc, crashed ? -5 : 12);
    remember(ped.npc, 'fareDone', crashed ? 'drove me like a maniac, but got me there' : 'gave me a smooth taxi ride', w.dayNight.hour, w.dayNight.day);
    this.release();
    this.phase = 'cooldown';
    this.timer = TX.nextFareDelay;
  }

  private showBeacon(w: World, x: number, z: number, color: number, t: number) {
    this.beacon.visible = true;
    this.beacon.position.set(x, w.city.heightAt(x, z), z);
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
        return `🚕 Drop ${this.ped?.npc.name.split(' ')[0]} at <b>${this.dest!.name}</b> (${this.destAddress()}) · ${d} m · ${clock}`;
      }
      default:
        return '';
    }
  }

  /** "M St NW at 31st St NW" (or just the street). */
  destAddress(): string {
    if (!this.dest) return '';
    return this.destCross ? `${this.dest.street} at ${this.destCross}` : this.dest.street;
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

/**
 * Driving distance from (ax, az) to (bx, bz) along the lanes: from the nearest lane at the start, through the
 * road graph, to the nearest lane at the end, taking either direction of the road at each end (the driver can turn
 * round; the stop can be on either kerb). `ay`: the car's height at the start (on a bridge deck the deck's lanes win
 * over the road below); the drop-off is a kerb at ground level. Falls back to TX.offRoadDetour x the straight line
 * if either end is off-road or there is no route.
 */
export function routeDistance(w: World, ax: number, az: number, bx: number, bz: number, ay = NaN): number {
  const c = w.city;
  const straight = Math.hypot(bx - ax, bz - az);
  if (!c.nearestLane(ax, az, TX.routeLaneSearch, HA, ay) || !c.nearestLane(bx, bz, TX.routeLaneSearch, HB, c.heightAt(bx, bz))) return straight * TX.offRoadDetour;
  const E = c.roads.edges, ea = E[HA.edge], eb = E[HB.edge];
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const a = i === 0 ? ea : ea.twin >= 0 ? E[ea.twin] : null;
    if (!a) continue;
    const sa = i === 0 ? HA.s : Math.max(0, a.len - HA.s);
    for (let j = 0; j < 2; j++) {
      const b = j === 0 ? eb : eb.twin >= 0 ? E[eb.twin] : null;
      if (!b) continue;
      const sb = j === 0 ? HB.s : Math.max(0, b.len - HB.s);
      best = Math.min(best, legDistance(w, a, sa, b, sb));
    }
  }
  return best < Infinity ? best : straight * TX.offRoadDetour;
}

/** Distance from `sa` along lane `a` to `sb` along lane `b` through the road graph (Infinity if unreachable). */
function legDistance(w: World, a: LaneEdge, sa: number, b: LaneEdge, sb: number): number {
  if (a.id === b.id && sb >= sa) return sb - sa;
  const r = roadRouter(w.city);
  if (r.path(a.to, b.from) < 0) return Infinity;
  return a.len - sa + r.length + sb;
}
