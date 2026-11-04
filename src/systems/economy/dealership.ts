// Car dealerships: a showroom of 2–4 display cars, in the bays of a car park next to the place (a car dealer's lot,
// a used-car lot) or else at the kerb outside it. Walk up to one and the
// prompt shows its price and stats; E buys it if you have the cash. A bought car is yours (never theft,
// no alarm) and gets its own marker on the minimap. Sold cars are restocked after a while, out of sight.
// Data-driven from a list of POI ids, so the real map can put dealerships at real car-shop / big-lot POIs;
// on the grid city `pickDealershipPois` picks garages (or shops) instead.
import * as THREE from 'three';
import { TUNING, type CarTypeName } from '../../tuning';
import type { World } from '../../world';
import type { CityMap, LaneHit, ParkingSpot, Poi } from '../map/cityMap';
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
  y: number; // the surface the car stands on (a car park bay's height)
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
  /** Where the display cars stand: 'kerb' (along the kerb outside) or 'lot' (bays of a car park: a car dealer's lot, a used-car lot). */
  showroom: 'kerb' | 'lot';
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

/** Kerb display slot `i` of a showroom at `poi` keeps clear of other places' taxi stops and of the traffic lanes. */
function kerbSlotOk(city: CityMap, poi: Poi, i: number): boolean {
  const { x, z } = slotSpot(poi, i);
  if (city.pois.some((q) => q.id !== poi.id && Math.hypot(q.curbX - x, q.curbZ - z) < D.slotClearance)) return false;
  return !blocksTraffic(city, x, z);
}

/** The car park (index) with at least lotMinBays bays nearest `poi` within lotSearch, or -1. */
function lotNear(city: CityMap, poi: Poi): number {
  const bays = new Map<number, { n: number; d: number }>();
  for (const s of city.parkingSpots) {
    if (s.lot < 0) continue;
    const b = bays.get(s.lot) ?? { n: 0, d: Infinity };
    b.n++;
    b.d = Math.min(b.d, Math.hypot(s.x - poi.x, s.z - poi.z));
    bays.set(s.lot, b);
  }
  let best = -1, bd: number = D.lotSearch;
  for (const [lot, b] of bays) if (b.n >= D.lotMinBays && b.d < bd) { bd = b.d; best = lot; }
  return best;
}

/** `n` bays of car park `lot` nearest `poi`, at least a bay apart (the showroom row). */
function lotSlots(city: CityMap, lot: number, poi: Poi, n: number): ParkingSpot[] {
  const bays = city.parkingSpots.filter((s) => s.lot === lot).sort((a, b) => Math.hypot(a.x - poi.x, a.z - poi.z) - Math.hypot(b.x - poi.x, b.z - poi.z));
  const out: ParkingSpot[] = [];
  for (const s of bays) {
    if (out.length >= n) break;
    if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < TUNING.geo.stallWidth * 1.9)) continue; // one empty bay between cars
    out.push(s);
  }
  return out;
}

/**
 * Dealership sites, far apart, up to maxSites for this map: car dealers first (a map category 'shop=car'), then big
 * car parks (used-car lots), then garages, then shops. A site shows its cars in a car park if one is close, else
 * along its kerb (where at least the first two display slots must keep out of the traffic lanes).
 */
export function pickDealershipPois(city: CityMap): DealershipSite[] {
  const max = D.maxSites[city.id] ?? D.maxSites.grid;
  const out: DealershipSite[] = [];
  // the biggest car park is the one used-car lot (a row of its bays; the rest stays a car park)
  const lotOf = (p: Poi) => lotNear(city, p);
  const bays = (lot: number) => (lot < 0 ? 0 : city.parkingSpots.filter((s) => s.lot === lot).length);
  const usedCarLot = city.pois.filter((p) => p.kind === 'parking' && lotOf(p) >= 0).sort((a, b) => bays(lotOf(b)) - bays(lotOf(a)))[0];
  // a car dealer and the used-car lot show their cars in the car park; garages and shops at their kerb
  const tiers: { take: (p: Poi) => boolean; lot: boolean }[] = [
    { take: (p) => p.cat === 'shop=car', lot: true },
    { take: (p) => p === usedCarLot, lot: true },
    { take: (p) => p.kind === 'garage', lot: false },
    { take: (p) => p.kind === 'shop', lot: false },
  ];
  for (const tier of tiers) {
    for (const p of city.pois) {
      if (out.length >= max) break;
      if (!tier.take(p) || out.some((s) => s.poiId === p.id)) continue;
      if (out.some((s) => Math.hypot(city.pois[s.poiId].x - p.x, city.pois[s.poiId].z - p.z) < D.minSiteSpacing)) continue;
      const lot = tier.lot ? lotOf(p) : -1;
      if (lot < 0 && (!kerbSlotOk(city, p, 0) || !kerbSlotOk(city, p, 1))) continue;
      out.push({ poiId: p.id, lot });
    }
  }
  return out;
}

/** A dealership's place, and the car park its display cars stand in (-1: at its kerb). */
export interface DealershipSite {
  poiId: number;
  lot: number;
}

export class DealershipJob implements JobSystem {
  readonly id = 'dealership';
  readonly label = 'Car dealerships';
  sites: Dealership[] = [];
  sold = 0;
  private restockT = 0;
  private rng: Rng;

  /** Plans a showroom at each POI (display slots in its car park, or along its kerb). Cars are parked by `stockShowrooms`. */
  constructor(w: World, sitesToPlan: DealershipSite[]) {
    this.rng = new Rng(w.seed ^ 0xdea1);
    const city = w.city;
    sitesToPlan.forEach(({ poiId, lot }, k) => {
      const poi = city.pois[poiId];
      // f: along the kerb, the way traffic in the kerbside lane drives (parked cars face that way);
      // n: from the pavement out into the road (the pavement is on the lane's right-hand side)
      const heading = poi.kerbHeading;
      const nx = Math.cos(heading), nz = -Math.sin(heading);
      const stock = D.stock[k % D.stock.length];
      const slots: DisplaySlot[] = [];
      if (lot >= 0) {
        lotSlots(city, lot, poi, stock.length).forEach((s, i) => slots.push({ x: s.x, y: s.y, z: s.z, heading: s.heading, type: stock[i], car: null, soldAt: -Infinity }));
      } else {
        stock.forEach((type, i) => {
          if (!kerbSlotOk(city, poi, i)) return;
          const { x, z } = slotSpot(poi, i);
          slots.push({ x, y: city.heightAt(x, z), z, heading, type, car: null, soldAt: -Infinity });
        });
      }
      // a place whose name is already on its shop sign keeps it; otherwise it gets a dealership name
      const name = poi.signed ? poi.name : NAMES[k % NAMES.length];
      poi.name = name; // so people can give directions to it
      if (lot >= 0 && slots.length) {
        // the sign stands in the (kept empty) bay at the end of the showroom row, facing the aisle the cars face
        const a = slots[0], b = slots[1] ?? slots[0];
        let rx = Math.cos(a.heading), rz = -Math.sin(a.heading); // along the row
        if ((b.x - a.x) * rx + (b.z - a.z) * rz > 0) { rx = -rx; rz = -rz; } // away from the other display cars
        buildSign(w, name, a.x + rx * D.lotSignOut, a.z + rz * D.lotSignOut, a.heading);
      } else buildSign(w, name, poi.x + nx * D.signOut, poi.z + nz * D.signOut, Math.atan2(nx, nz));
      this.sites.push({ id: k, poiId, name, x: poi.x, z: poi.z, showroom: lot >= 0 ? 'lot' : 'kerb', slots });
    });
  }

  /** Kerb spots and car park bays the showrooms will use (parked cars keep clear of them). */
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
    if (w.vehicles.some((v) => Math.hypot(v.px - sl.x, v.pz - sl.z) < D.slotClearance * (site.showroom === 'lot' ? 0.4 : 1))) return false;
    // at load a new car; restocking later takes an idle car from the parked-car pool (the car list doesn't grow per sale)
    const paint = new THREE.Color(this.rng.pick(PAINTS));
    const v = w.parked ? takePooledCar(w, sl.type, sl.x, sl.y, sl.z, sl.heading, paint) : spawnVehicle(w, sl.type, sl.x, sl.z, sl.heading, paint, sl.y);
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
