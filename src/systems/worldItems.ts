// Loose items in the world: small Rapier bodies (sleeping until disturbed) drawn with one InstancedMesh per
// item type. Scattered by the generator: litter on pavements, rubbish bags and boxes by shops, cones at
// roadworks, brick piles, bats by the gym, wrenches at the garage. Picked up items leave the physics world.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { Rng } from '../rng';
import { buildItemArt, ITEM_IDS, type ItemArt, type ItemId } from '../art/items';
import { GROUPS } from '../physicsGroups';

const IT = TUNING.items;

export interface WorldItem {
  id: number;
  /** Stable id (saves): 'street:<n>' for the seed's street items, '<building id>/<furniture slot>' for interior items,
   * 'new:<n>' for anything made later. */
  uid: string;
  type: ItemId;
  /** Physics body: always for street items; for lazy (interior) items only while the player is near (see wakeRadius). */
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  inWorld: boolean; // false while in the inventory
  /** Lazy items rest without a body until the player comes near (interior shelves and tables). */
  lazy: boolean;
  /** Lying inside a building whose interior is not built: not drawn, not simulated, not targetable. */
  dormant: boolean;
  /** The building it lies in (record id), or null. */
  building: string | null;
  /** 'public', 'player', 'business:<building id>', 'home:<building id>' */
  owner: string;
  /** Moved, picked up or dropped since it was made (the save keeps it). */
  touched: boolean;
  /** Rotation while resting without a body. */
  qx: number; qy: number; qz: number; qw: number;
  inst: number; // instance index in its type's InstancedMesh
  px: number; // cached position (updated while awake)
  py: number;
  pz: number;
  thrown: boolean; // flying after being thrown by the player
  thrownAt: number;
  speed: number; // speed at the last update (for hit strength)
  stolen: boolean; // taken from a shop without paying (M3)
  illegal: boolean; // illegal to carry (M3 weapons)
}

export interface ItemsState {
  items: WorldItem[];
  byUid: Map<string, WorldItem>;
  /** Uids that were used up or lost for good (eaten, thrown into the river): never made again. */
  gone: Set<string>;
  /** Counter for items made during play ('new:<n>'). */
  nextNew: number;
  /** Something changed that the save should write (pickup, drop, moved). */
  dirty: boolean;
  art: Record<ItemId, ItemArt>;
  meshes: Record<ItemId, THREE.InstancedMesh>;
  material: THREE.MeshStandardMaterial;
  byCollider: Map<number, WorldItem>;
  target: WorldItem | null; // item the player is looking at
  marker: THREE.Mesh;
  eventQueue: RAPIER.EventQueue;
  /** Seeded items left out at load because their spot was no good (in a wall, water, at an edge). */
  skipped: number;
}

const CAPACITY = 160; // per item type
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const p4 = new THREE.Vector3();
const s1 = new THREE.Vector3(1, 1, 1);

export function createItems(w: World): ItemsState {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
  const art = {} as Record<ItemId, ItemArt>;
  const meshes = {} as Record<ItemId, THREE.InstancedMesh>;
  for (const id of ITEM_IDS) {
    art[id] = buildItemArt(id);
    const im = new THREE.InstancedMesh(art[id].geo, material, CAPACITY);
    im.count = 0;
    im.castShadow = true;
    im.frustumCulled = false; // instances are spread over the whole city
    w.scene.add(im);
    meshes[id] = im;
  }
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.25, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
  marker.visible = false;
  w.scene.add(marker);
  return { items: [], byUid: new Map(), gone: new Set(), nextNew: 0, dirty: false, art, meshes, material, byCollider: new Map(), target: null, marker, eventQueue: new w.R.EventQueue(true), skipped: 0 };
}

/** Give an item a physics body at its resting place (asleep). */
export function wakeItem(w: World, it: WorldItem, asleep = true): void {
  if (it.body) return;
  const S = w.itemsState, R = w.R, a = S.art[it.type];
  const body = w.physics.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(it.px, it.py, it.pz).setRotation({ x: it.qx, y: it.qy, z: it.qz, w: it.qw })
      .setLinearDamping(0.2).setAngularDamping(0.4).setSleeping(asleep),
  );
  const cd = a.collider.kind === 'box' ? R.ColliderDesc.cuboid(a.collider.hx, a.collider.hy, a.collider.hz) : R.ColliderDesc.cylinder(a.collider.hh, a.collider.r);
  const collider = w.physics.createCollider(cd.setMass(IT.defs[it.type].mass).setFriction(0.75).setRestitution(0.2).setCollisionGroups(GROUPS.item), body);
  it.body = body; it.collider = collider;
  S.byCollider.set(collider.handle, it);
  if (!it.inWorld) body.setEnabled(false);
}
/** Take a lazy item's body away (it rests where it is, drawn only). */
export function restItem(w: World, it: WorldItem): void {
  if (!it.body) return;
  const S = w.itemsState;
  if (it.inWorld) {
    const t = it.body.translation(), r = it.body.rotation();
    it.px = t.x; it.py = t.y; it.pz = t.z; it.qx = r.x; it.qy = r.y; it.qz = r.z; it.qw = r.w;
  }
  if (it.collider) S.byCollider.delete(it.collider.handle);
  w.physics.removeRigidBody(it.body);
  it.body = null; it.collider = null;
}

/**
 * A lazy item (no body until the player comes near) resting at (x, y, z) with a yaw: interior shelves and tables, and
 * items restored from a save. `y` is the surface it stands on.
 */
export function spawnLazy(w: World, type: ItemId, uid: string, x: number, y: number, z: number, yaw: number, owner: string, building: string | null): WorldItem | null {
  const S = w.itemsState;
  const im = S.meshes[type];
  if (im.count >= CAPACITY || S.byUid.has(uid)) return S.byUid.get(uid) ?? null;
  const a = S.art[type];
  q4.setFromEuler(new THREE.Euler(0, yaw, a.restRotZ, 'YXZ'));
  const it: WorldItem = {
    id: S.items.length, uid, type, body: null, collider: null, inWorld: true, lazy: true, dormant: false, building, owner, touched: false,
    qx: q4.x, qy: q4.y, qz: q4.z, qw: q4.w, inst: im.count, px: x, py: y + a.restY + 0.003, pz: z,
    thrown: false, thrownAt: -10, speed: 0, stolen: false, illegal: false,
  };
  im.count++;
  S.items.push(it);
  S.byUid.set(uid, it);
  writeMatrix(S, it);
  return it;
}

/** Hide an item lying in a building whose interior is taken down (no body), or bring it back. */
export function setDormant(w: World, it: WorldItem, on: boolean): void {
  if (it.dormant === on) return;
  // its body goes (a street item too: from now on it is lazy, given a body again only when the player comes near)
  if (on) { restItem(w, it); it.lazy = true; }
  it.dormant = on;
  writeMatrix(w.itemsState, it);
}

/**
 * Create an item at rest on the ground at (x, z) (or `lift` metres above the ground, e.g. stacked, if given). `near`:
 * the height of the surface it belongs on (a bridge deck's walk node), so it lands on the deck, not the ground below.
 */
export function spawnItem(w: World, type: ItemId, x: number, z: number, yaw: number, lift?: number, near?: number): WorldItem | null {
  const S = w.itemsState;
  const im = S.meshes[type];
  if (im.count >= CAPACITY) return null;
  const R = w.R;
  const a = S.art[type];
  const def = IT.defs[type];
  const y = w.city.heightAt(x, z, near) + (lift ?? 0.02);
  q4.setFromEuler(new THREE.Euler(0, yaw, a.restRotZ, 'YXZ'));
  const body = w.physics.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(x, y + a.restY, z)
      .setRotation({ x: q4.x, y: q4.y, z: q4.z, w: q4.w })
      .setLinearDamping(0.2)
      .setAngularDamping(0.4)
      .setSleeping(lift === undefined),
  );
  const cd = a.collider.kind === 'box' ? R.ColliderDesc.cuboid(a.collider.hx, a.collider.hy, a.collider.hz) : R.ColliderDesc.cylinder(a.collider.hh, a.collider.r);
  const collider = w.physics.createCollider(cd.setMass(def.mass).setFriction(0.75).setRestitution(0.2).setCollisionGroups(GROUPS.item), body);
  const item: WorldItem = {
    id: S.items.length, uid: `street:${S.items.length}`, type, body, collider, inWorld: true, lazy: false, dormant: false, building: null, owner: 'public', touched: false,
    qx: q4.x, qy: q4.y, qz: q4.z, qw: q4.w, inst: im.count, px: x, py: y + a.restY, pz: z,
    thrown: false, thrownAt: -10, speed: 0, stolen: false, illegal: false,
  };
  im.count++;
  S.items.push(item);
  S.byUid.set(item.uid, item);
  S.byCollider.set(collider.handle, item);
  writeMatrix(S, item);
  return item;
}

/** Redraw one item where it is now (after its state was changed from outside: saves). */
export function writeItem(w: World, it: WorldItem): void {
  writeMatrix(w.itemsState, it);
}

function writeMatrix(S: ItemsState, it: WorldItem) {
  const im = S.meshes[it.type];
  if (!it.inWorld || it.dormant) im.setMatrixAt(it.inst, ZERO);
  else {
    if (it.body) { const r = it.body.rotation(); q4.set(r.x, r.y, r.z, r.w); }
    else q4.set(it.qx, it.qy, it.qz, it.qw);
    p4.set(it.px, it.py, it.pz);
    im.setMatrixAt(it.inst, m4.compose(p4, q4, s1));
  }
  im.instanceMatrix.needsUpdate = true;
}

/** Take an item out of the world (picked up). */
export function removeFromWorld(w: World, it: WorldItem): void {
  it.inWorld = false;
  it.thrown = false;
  it.touched = true;
  it.building = null;
  if (it.lazy) restItem(w, it);
  else it.body?.setEnabled(false);
  w.itemsState.dirty = true;
  writeMatrix(w.itemsState, it);
}

/** Put an item back into the world at a position with a velocity (dropped or thrown). */
export function placeInWorld(w: World, it: WorldItem, x: number, y: number, z: number, yaw: number, vx: number, vy: number, vz: number): void {
  it.inWorld = true;
  it.dormant = false;
  it.touched = true;
  q4.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  it.px = x; it.py = y; it.pz = z; it.qx = q4.x; it.qy = q4.y; it.qz = q4.z; it.qw = q4.w;
  if (!it.body) wakeItem(w, it, false);
  const body = it.body!;
  body.setEnabled(true);
  body.setTranslation({ x, y, z }, true);
  body.setRotation({ x: q4.x, y: q4.y, z: q4.z, w: q4.w }, true);
  body.setLinvel({ x: vx, y: vy, z: vz }, true);
  body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
  w.itemsState.dirty = true;
  writeMatrix(w.itemsState, it);
}

/** Per frame: copy moving items into their instances, settle thrown items, pick the look-at target. */
export function updateWorldItems(w: World, dt: number): void {
  const S = w.itemsState;
  const pp0 = w.player.mesh.position;
  const wake2 = IT.wakeRadius * IT.wakeRadius, sleep2 = IT.sleepRadius * IT.sleepRadius;
  for (const it of S.items) {
    if (it.dormant || !it.inWorld) { it.speed = 0; continue; }
    if (it.lazy) {
      // lazy items: a body only while the player is near (or while they move)
      const dx = it.px - pp0.x, dy = it.py - pp0.y, dz = it.pz - pp0.z, d2 = dx * dx + dy * dy * 4 + dz * dz;
      if (!it.body) { if (d2 < wake2) wakeItem(w, it); else { it.speed = 0; continue; } }
      else if (d2 > sleep2 && it.body.isSleeping() && !it.thrown) { restItem(w, it); writeMatrix(S, it); it.speed = 0; continue; }
    }
    const body = it.body!;
    if (body.isSleeping()) {
      it.speed = 0;
      if (it.thrown) settle(it);
      continue;
    }
    const t = body.translation();
    const lv = body.linvel();
    it.speed = Math.hypot(lv.x, lv.y, lv.z);
    if (!it.touched && (Math.abs(t.x - it.px) > 0.05 || Math.abs(t.z - it.pz) > 0.05 || Math.abs(t.y - it.py) > 0.05)) { it.touched = true; S.dirty = true; }
    it.px = t.x; it.py = t.y; it.pz = t.z;
    if (t.y < -20) { // fell out of the world (into the bay): park it out of sight
      removeFromWorld(w, it);
      continue;
    }
    writeMatrix(S, it);
    if (it.thrown && (w.time - it.thrownAt > 4 || it.speed < 0.5)) settle(it);
  }
  // look-at target for E (on foot only)
  S.target = null;
  const p = w.player;
  if (!p.vehicle && !p.dead && w.started) {
    const pp = p.mesh.position;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    let best = Infinity;
    for (const it of S.items) {
      if (!it.inWorld || it.thrown || it.dormant) continue;
      const dx = it.px - pp.x, dz = it.pz - pp.z;
      if (Math.abs(dx) > IT.pickupRange || Math.abs(dz) > IT.pickupRange || it.py > pp.y + 1.6) continue;
      const d = Math.hypot(dx, dz);
      if (d > IT.pickupRange) continue;
      const dot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      if (dot < IT.pickupCone && d > 0.7) continue;
      const score = d - dot * 0.6;
      if (score < best) { best = score; S.target = it; }
    }
  }
  S.marker.visible = !!S.target;
  if (S.target) {
    S.marker.position.set(S.target.px, S.target.py + 0.45 + Math.sin(w.time * 5) * 0.05, S.target.pz);
    S.marker.rotation.y += dt * 3;
  }
}

function settle(it: WorldItem) {
  it.thrown = false;
  it.body?.enableCcd(false);
  it.collider?.setActiveEvents(0);
}

/** Spawn the city's litter and props from the seed. */
export function scatterItems(w: World): void {
  const rng = new Rng(w.seed ^ 0x17e5);
  const c = w.city;
  const pois = c.pois;
  const tangentOf = (p: { x: number; z: number; curbX: number; curbZ: number }) => {
    const nx = p.curbX - p.x, nz = p.curbZ - p.z, l = Math.hypot(nx, nz) || 1;
    return { tx: -nz / l, tz: nx / l, nx: nx / l, nz: nz / l };
  };
  /**
   * A sane resting spot: not inside a building, not in the water, not in the carriageway (unless `road`), and on
   * level ground: the surface a little way out on all four sides is within maxStep of it (never at the edge of a
   * bridge deck, a pier, a kerb or a stair). `near`: the height of the surface it belongs on (decks).
   */
  const fits = (x: number, z: number, near?: number, road = false) => {
    if (c.isBlocked(x, z) || (!road && c.isRoad(x, z))) return false;
    const y = c.heightAt(x, z, near);
    if (c.isWater(x, z) && y <= c.waterLevelAt(x, z) + IT.waterClearance) return false;
    const e = IT.edgeProbe, b = IT.wallProbe;
    for (let k = 0; k < 4; k++) {
      const ox = k === 0 ? 1 : k === 1 ? -1 : 0, oz = k === 2 ? 1 : k === 3 ? -1 : 0;
      if (c.isBlocked(x + ox * b, z + oz * b) || Math.abs(c.heightAt(x + ox * e, z + oz * e, y + 0.5) - y) > IT.maxStep) return false;
      if (Math.abs(c.heightAt(x + ox * IT.dropProbe, z + oz * IT.dropProbe, y + 0.5) - y) > IT.maxDrop) return false;
    }
    return true;
  };
  let skipped = 0;
  const put = (type: ItemId, x: number, z: number, yaw: number, lift?: number, near?: number, road = false) => {
    if (!fits(x, z, near, road)) { skipped++; return; }
    spawnItem(w, type, x, z, yaw, lift, near);
  };
  // litter along pavements
  const litter: ItemId[] = ['bottle', 'can', 'can', 'bottle', 'bag'];
  for (let k = 0; k < IT.litterCount; k++) {
    const a = rng.pick(c.walk.nodes);
    const b = c.walk.nodes[rng.pick(a.nbrs)];
    if (!b) continue;
    const t = rng.range(0.15, 0.85);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const off = rng.range(-1.1, 1.1);
    put(rng.pick(litter), a.x + dx * t - (dz / l) * off, a.z + dz * t + (dx / l) * off, rng.range(0, Math.PI * 2), undefined, a.y + (b.y - a.y) * t);
  }
  // rubbish bags and boxes by shops, diners, bars and markets
  for (const p of pois) {
    if (!['shop', 'diner', 'bar', 'market', 'cafe'].includes(p.kind)) continue;
    const { tx, tz, nx, nz } = tangentOf(p);
    const py = c.walk.nodes[p.walkNode]?.y;
    if (rng.chance(IT.bagClusterChance)) {
      const s = rng.range(2.5, 4) * (rng.chance(0.5) ? 1 : -1);
      for (let k = 0; k < rng.int(1, 3); k++) put('bag', p.x + tx * (s + k * 0.45) - nx * 0.75, p.z + tz * (s + k * 0.45) - nz * 0.75, rng.range(0, 6), undefined, py);
    }
    if (rng.chance(IT.boxChance)) {
      const s = rng.range(-4, -2.5);
      const bx = p.x + tx * s - nx * 0.8, bz = p.z + tz * s - nz * 0.8;
      if (fits(bx, bz, py)) {
        spawnItem(w, 'box', bx, bz, rng.range(0, 6), undefined, py);
        if (rng.chance(0.5)) spawnItem(w, 'box', bx, bz, rng.range(0, 6), 0.32, py);
      } else skipped++;
    }
  }
  // roadworks: lines of cones along a kerb (where no car is parked)
  const taken = (x: number, z: number) => w.vehicles.some((v) => Math.hypot(v.px - x, v.pz - z) < 9) || (w.parked?.cars.some((r) => Math.hypot(r.x - x, r.z - z) < 9) ?? false);
  for (let k = 0, tries = 0; k < IT.coneClusters && tries < 200; tries++) {
    const s = rng.pick(c.parkingSpots);
    if (s.cls === 'lot' || taken(s.x, s.z)) continue;
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    for (let i = 0; i < IT.conesPerCluster; i++) put('cone', s.x + fx * (i * 2.4 - 3.6), s.z + fz * (i * 2.4 - 3.6), 0, undefined, s.y, true);
    k++;
  }
  // brick piles against the south side of a few buildings (skipped where that spot is inside something)
  for (let k = 0; k < IT.brickPiles; k++) {
    const b = rng.pick(c.buildings);
    const x = (b.minX + b.maxX) / 2 + rng.range(-3, 3), z = b.maxZ + 0.9;
    if (!fits(x, z) || !fits(x + 0.5, z)) { skipped++; continue; }
    for (let i = 0; i < IT.bricksPerPile; i++) spawnItem(w, 'brick', x + (i % 3) * 0.24 - 0.24, z, 0, 0.02 + Math.floor(i / 3) * 0.072);
  }
  // bats by the gym, wrenches at the garage (fallbacks keep every seed stocked); on the pavement in front of the door
  // if the spot by the wall is no good
  const gyms = pois.filter((p) => p.kind === 'gym');
  const garages = pois.filter((p) => p.kind === 'garage');
  const atDoor = (type: ItemId, p: (typeof pois)[number], along: number, out: number, yaw: number) => {
    const { tx, tz, nx, nz } = tangentOf(p);
    const py = c.walk.nodes[p.walkNode]?.y;
    const x = p.x + tx * along - nx * out, z = p.z + tz * along - nz * out;
    if (fits(x, z, py)) spawnItem(w, type, x, z, yaw, undefined, py);
    else if (fits(p.x + tx * along * 0.5, p.z + tz * along * 0.5, py)) spawnItem(w, type, p.x + tx * along * 0.5, p.z + tz * along * 0.5, yaw, undefined, py);
    else skipped++;
  };
  for (const p of (gyms.length ? gyms : pois.filter((q) => q.kind === 'park')).slice(0, IT.gymsWithBats)) {
    for (let i = 0; i < IT.batsPerGym; i++) atDoor('bat', p, 2.5 + i * 0.5, 1.0, rng.range(0, 0.4));
  }
  for (const p of garages.length ? garages : pois.filter((q) => q.kind === 'market').slice(0, 1)) {
    for (let i = 0; i < IT.wrenchesPerGarage; i++) atDoor('wrench', p, 1.5 + i * 0.6, 1.0, rng.range(0, 6));
  }
  w.itemsState.skipped = skipped;
}
/** Render a small icon for each item type (used by the hotbar). */
export function renderItemIcons(w: World): Record<ItemId, string> {
  const S = w.itemsState;
  const size = 64;
  const rt = new THREE.WebGLRenderTarget(size, size);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6);
  dl.position.set(2, 3, 2);
  scene.add(dl);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  const out = {} as Record<ItemId, string>;
  const pixels = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g2 = canvas.getContext('2d')!;
  const prevTarget = w.renderer.getRenderTarget();
  const prevClear = w.renderer.getClearAlpha();
  w.renderer.setClearAlpha(0);
  for (const id of ITEM_IDS) {
    const mesh = new THREE.Mesh(S.art[id].geo, S.material);
    mesh.rotation.set(0.35, 0.7, id === 'bat' || id === 'wrench' ? 0.9 : 0.15);
    scene.add(mesh);
    const r = S.art[id].geo.boundingSphere!.radius;
    cam.position.set(0, 0, r / Math.tan((15 * Math.PI) / 180) * 1.05);
    cam.lookAt(0, 0, 0);
    w.renderer.setRenderTarget(rt);
    w.renderer.clear();
    w.renderer.render(scene, cam);
    w.renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
    const img = g2.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    g2.putImageData(img, 0, 0);
    out[id] = canvas.toDataURL();
    scene.remove(mesh);
  }
  w.renderer.setRenderTarget(prevTarget);
  w.renderer.setClearAlpha(prevClear);
  rt.dispose();
  return out;
}
