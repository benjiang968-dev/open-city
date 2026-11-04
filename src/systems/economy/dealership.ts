// Car dealerships: a showroom of 2–4 display cars parked at the kerb outside a POI. Walk up to one and the
// prompt shows its price and stats; E buys it if you have the cash. A bought car is yours (never theft,
// no alarm) and gets its own marker on the minimap. Sold cars are restocked after a while, out of sight.
// Data-driven from a list of POI ids, so the real map can put dealerships at real car-shop / big-lot POIs;
// on the grid city `pickDealershipPois` picks garages (or shops) instead.
import * as THREE from 'three';
import { TUNING, type CarTypeName } from '../../tuning';
import type { World } from '../../world';
import type { CityMap, LaneHit, Poi } from '../map/cityMap';
import type { JobSystem, JobMarker } from './jobManager';
import { spawnVehicle, type Vehicle } from '../vehicles';
import { takePooledCar } from '../parkedCars';
import { toast } from '../hud';
import { Rng } from '../../rng';

const D = TUNING.economy.dealership;
const NAMES = ['Harbourside Motors', 'Gull Point Autos', 'Kerbstone Car Mart', 'Bayline Motor Co.'];
const PAINTS = ['#ff595e', '#1982c4', '#ffca3a', '#8ac926', '#6a4c93', '#f1faee', '#ff924c', '#2ec4b6'];

export interface DisplaySlot {
  x: number;
  z: number;
  heading: number;
  type: CarTypeName;
  car: Vehicle | null;
  soldAt: number; // w.time the car was bought (for restocking)
}

export interface Dealership {
  id: number;
  poiId: number;
  name: string;
  x: number; // the door, on the pavement (minimap badge)
  z: number;
  slots: DisplaySlot[];
}

const HIT: LaneHit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
/**
 * Would a car parked at (x, z) stand in a lane traffic drives in? (Real maps stop taxis in the kerbside lane; a
 * display car there would block a one-lane street for good. A parking lane with another lane beside it is fine.)
 */
function blocksTraffic(city: CityMap, x: number, z: number): boolean {
  if (!city.nearestLane(x, z, D.laneClearance, HIT, city.heightAt(x, z))) return false;
  const e = city.roads.edges[HIT.edge];
  return !(e.parking && e.lanesSameDir > 1);
}
/** Where display car `i` of a showroom at `poi` stands (along the kerb, nudged off the taxi-stop line). */
function slotSpot(poi: Poi, i: number): { x: number; z: number } {
  const heading = poi.kerbHeading, off = D.slotOffsets[i % D.slotOffsets.length];
  const fx = Math.sin(heading), fz = Math.cos(heading), nx = Math.cos(heading), nz = -Math.sin(heading);
  return { x: poi.curbX - nx * D.kerbNudge + fx * off, z: poi.curbZ - nz * D.kerbNudge + fz * off };
}

/** Garage POIs far apart (shops if there aren't enough garages) whose kerb has room for display cars. */
export function pickDealershipPois(city: CityMap): number[] {
  const out: Poi[] = [];
  for (const kind of ['garage', 'shop']) {
    for (const p of city.pois) {
      if (out.length >= D.maxSites) break;
      if (p.kind !== kind) continue;
      if (out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < D.minSiteSpacing)) continue;
      // at least the first two display slots must keep out of the traffic lanes
      if (blocksTraffic(city, slotSpot(p, 0).x, slotSpot(p, 0).z) || blocksTraffic(city, slotSpot(p, 1).x, slotSpot(p, 1).z)) continue;
      out.push(p);
    }
  }
  return out.map((p) => p.id);
}

export class DealershipJob implements JobSystem {
  readonly id = 'dealership';
  readonly label = 'Car dealerships';
  sites: Dealership[] = [];
  sold = 0;
  private restockT = 0;
  private rng: Rng;

  /** Plans a showroom at each POI (display slots along its kerb). Cars are parked by `stockShowrooms`. */
  constructor(w: World, poiIds: number[]) {
    this.rng = new Rng(w.seed ^ 0xdea1);
    poiIds.forEach((poiId, k) => {
      const poi = w.city.pois[poiId];
      // f: along the kerb, the way traffic in the kerbside lane drives (parked cars face that way);
      // n: from the pavement out into the road (the pavement is on the lane's right-hand side)
      const heading = poi.kerbHeading;
      const nx = Math.cos(heading), nz = -Math.sin(heading);
      const stock = D.stock[k % D.stock.length];
      const slots: DisplaySlot[] = [];
      stock.forEach((type, i) => {
        const { x, z } = slotSpot(poi, i);
        // keep other POIs' taxi stops free, and the traffic lanes
        if (w.city.pois.some((q) => q.id !== poiId && Math.hypot(q.curbX - x, q.curbZ - z) < D.slotClearance)) return;
        if (blocksTraffic(w.city, x, z)) return;
        slots.push({ x, z, heading, type, car: null, soldAt: -Infinity });
      });
      // a place whose name is already on its shop sign keeps it; otherwise it gets a dealership name
      const name = poi.signed ? poi.name : NAMES[k % NAMES.length];
      poi.name = name; // so people can give directions to it
      buildSign(w, name, poi.x + nx * D.signOut, poi.z + nz * D.signOut, Math.atan2(nx, nz));
      this.sites.push({ id: k, poiId, name, x: poi.x, z: poi.z, slots });
    });
  }

  /** Kerb spots the showrooms will use (random parked cars keep clear of them). */
  reservedSpots(): { x: number; z: number }[] {
    return this.sites.flatMap((s) => s.slots.map((sl) => ({ x: sl.x, z: sl.z })));
  }

  /** Park a display car in every free slot. */
  stockShowrooms(w: World): void {
    for (const site of this.sites) for (let i = 0; i < site.slots.length; i++) this.stock(w, site, i);
  }

  private stock(w: World, site: Dealership, i: number): boolean {
    const sl = site.slots[i];
    if (sl.car) return false;
    if (w.vehicles.some((v) => Math.hypot(v.px - sl.x, v.pz - sl.z) < D.slotClearance)) return false;
    // at load a new car; restocking later takes an idle car from the parked-car pool (the car list doesn't grow per sale)
    const paint = new THREE.Color(this.rng.pick(PAINTS));
    const v = w.parked ? takePooledCar(w, sl.type, sl.x, w.city.heightAt(sl.x, sl.z), sl.z, sl.heading, paint) : spawnVehicle(w, sl.type, sl.x, sl.z, sl.heading, paint);
    v.forSale = { site: site.id, slot: i, price: D.prices[sl.type] };
    v.owner = 'nobody';
    v.locked = true;
    sl.car = v;
    return true;
  }

  update(w: World, dt: number): void {
    // restock sold slots now and then, while you're away
    this.restockT -= dt;
    if (this.restockT > 0) return;
    this.restockT = 1;
    const pp = w.player.mesh.position;
    for (const site of this.sites) {
      // a display car smashed to a wreck is off the market (its slot restocks once the wreck is gone)
      for (const sl of site.slots) {
        if (!sl.car?.wrecked) continue;
        sl.car.forSale = null;
        sl.car.locked = false;
        sl.car = null;
        sl.soldAt = w.time;
      }
      if (Math.hypot(site.x - pp.x, site.z - pp.z) < D.restockMinDistance) continue;
      site.slots.forEach((sl, i) => {
        if (!sl.car && w.time - sl.soldAt > D.restockSeconds) this.stock(w, site, i);
      });
    }
  }

  status(): string {
    return '';
  }

  markers(): JobMarker[] {
    return [];
  }

  debug(): string {
    return `${this.sites.length} showrooms, ${this.sold} sold`;
  }
}

/** A showroom sign on two posts at the pavement's road edge, readable from the road both ways. Built once. */
function buildSign(w: World, name: string, x: number, z: number, facing: number): void {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d4ed8';
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = '#ffd23f';
  g.fillRect(0, 116, 512, 44);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  let px = 60;
  do g.font = `bold ${px--}px system-ui, sans-serif`; while (g.measureText(name.toUpperCase()).width > 430 && px > 20);
  g.fillText(name.toUpperCase(), 256, 60);
  g.fillStyle = '#14181f';
  g.font = 'bold 30px system-ui, sans-serif';
  g.fillText('CARS FOR SALE', 256, 139);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const group = new THREE.Group();
  const board = new THREE.PlaneGeometry(3.2, 1.0);
  const front = new THREE.Mesh(board, mat);
  const back = new THREE.Mesh(board, mat);
  front.position.set(0, 2.85, 0.03);
  back.position.set(0, 2.85, -0.03);
  back.rotation.y = Math.PI;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.6 });
  const postGeo = new THREE.BoxGeometry(0.1, 3.35, 0.1).translate(0, 1.675, 0);
  for (const sx of [-1.5, 1.5]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.x = sx;
    post.castShadow = true;
    group.add(post);
  }
  group.add(front, back);
  group.position.set(x, w.city.heightAt(x, z), z);
  group.rotation.y = facing; // the board faces the road
  w.scene.add(group);
}

function driveLabel(v: Vehicle): string {
  return v.spec.driveFront && v.spec.driveRear ? '4WD' : v.spec.driveFront ? 'FWD' : 'RWD';
}

/** HUD prompt next to a display car: price, stats, and whether you can afford it. */
export function showroomPrompt(w: World, v: Vehicle): string {
  const fs = v.forSale!;
  if (v.wrecked) return `${v.spec.label} is wrecked`;
  const job = w.jobs.get<DealershipJob>('dealership');
  const site = job?.sites[fs.site];
  const s = v.spec;
  const stats = `top ${Math.round(s.maxSpeed * 3.6)} km/h · ${driveLabel(v)} · ${s.mass.toLocaleString()} kg · toughness ${s.health}${site ? ` · ${site.name}` : ''}`;
  const price = `$${fs.price.toLocaleString()}`;
  const head = w.cash >= fs.price ? `E  buy the ${s.label} · ${price}` : `${s.label} · ${price} <span style="color:#ffb703">(you need $${Math.ceil(fs.price - w.cash).toLocaleString()} more)</span>`;
  return `${head}<br><span style="font-size:14px;opacity:.85">${stats}</span>`;
}

/** E on a display car: pay and take the keys (the car becomes yours). */
export function buyDisplayCar(w: World, v: Vehicle): boolean {
  const fs = v.forSale;
  if (!fs || v.wrecked) return false; // a wreck is not for sale (the showroom drops it from stock)
  if (w.cash < fs.price) {
    toast(w, `<span style="font-size:20px">Not enough cash for the ${v.spec.label} ($${fs.price.toLocaleString()})</span>`, 2);
    return false;
  }
  w.cash -= fs.price;
  const job = w.jobs.get<DealershipJob>('dealership');
  const sl = job?.sites[fs.site]?.slots[fs.slot];
  if (sl) { sl.car = null; sl.soldAt = w.time; }
  if (job) job.sold++;
  v.forSale = null;
  v.owned = true;
  v.locked = false;
  v.stolen = false;
  v.owner = 'nobody';
  v.alarmUntil = 0;
  w.audio.chime?.();
  toast(w, `<span style="font-size:22px">🔑 You bought the ${v.spec.label} for $${fs.price.toLocaleString()}. It's yours!</span>`, 3);
  return true;
}
