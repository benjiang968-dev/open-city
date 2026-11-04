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
  type: ItemId;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  inWorld: boolean; // false while in the inventory
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
  art: Record<ItemId, ItemArt>;
  meshes: Record<ItemId, THREE.InstancedMesh>;
  material: THREE.MeshStandardMaterial;
  byCollider: Map<number, WorldItem>;
  target: WorldItem | null; // item the player is looking at
  marker: THREE.Mesh;
  eventQueue: RAPIER.EventQueue;
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
  return { items: [], art, meshes, material, byCollider: new Map(), target: null, marker, eventQueue: new w.R.EventQueue(true) };
}

/** Create an item at rest on the ground at (x, z) (or `lift` metres above the ground, e.g. stacked, if given). */
export function spawnItem(w: World, type: ItemId, x: number, z: number, yaw: number, lift?: number): WorldItem | null {
  const S = w.itemsState;
  const im = S.meshes[type];
  if (im.count >= CAPACITY) return null;
  const R = w.R;
  const a = S.art[type];
  const def = IT.defs[type];
  const y = w.city.heightAt(x, z) + (lift ?? 0.02);
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
    id: S.items.length, type, body, collider, inWorld: true, inst: im.count, px: x, py: y + a.restY, pz: z,
    thrown: false, thrownAt: -10, speed: 0, stolen: false, illegal: false,
  };
  im.count++;
  S.items.push(item);
  S.byCollider.set(collider.handle, item);
  writeMatrix(S, item);
  return item;
}

function writeMatrix(S: ItemsState, it: WorldItem) {
  const im = S.meshes[it.type];
  if (!it.inWorld) im.setMatrixAt(it.inst, ZERO);
  else {
    const r = it.body.rotation();
    q4.set(r.x, r.y, r.z, r.w);
    p4.set(it.px, it.py, it.pz);
    im.setMatrixAt(it.inst, m4.compose(p4, q4, s1));
  }
  im.instanceMatrix.needsUpdate = true;
}

/** Take an item out of the world (picked up). */
export function removeFromWorld(w: World, it: WorldItem): void {
  it.inWorld = false;
  it.thrown = false;
  it.body.setEnabled(false);
  writeMatrix(w.itemsState, it);
}

/** Put an item back into the world at a position with a velocity (dropped or thrown). */
export function placeInWorld(w: World, it: WorldItem, x: number, y: number, z: number, yaw: number, vx: number, vy: number, vz: number): void {
  it.inWorld = true;
  it.body.setEnabled(true);
  q4.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  it.body.setTranslation({ x, y, z }, true);
  it.body.setRotation({ x: q4.x, y: q4.y, z: q4.z, w: q4.w }, true);
  it.body.setLinvel({ x: vx, y: vy, z: vz }, true);
  it.body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
  it.px = x; it.py = y; it.pz = z;
  writeMatrix(w.itemsState, it);
}

/** Per frame: copy moving items into their instances, settle thrown items, pick the look-at target. */
export function updateWorldItems(w: World, dt: number): void {
  const S = w.itemsState;
  for (const it of S.items) {
    if (!it.inWorld || it.body.isSleeping()) {
      it.speed = 0;
      if (it.thrown && it.inWorld) settle(it);
      continue;
    }
    const t = it.body.translation();
    const lv = it.body.linvel();
    it.speed = Math.hypot(lv.x, lv.y, lv.z);
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
      if (!it.inWorld || it.thrown) continue;
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
  it.body.enableCcd(false);
  it.collider.setActiveEvents(0);
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
  // litter along pavements
  const litter: ItemId[] = ['bottle', 'can', 'can', 'bottle', 'bag'];
  for (let k = 0; k < IT.litterCount; k++) {
    const a = rng.pick(c.walk.nodes);
    const b = c.walk.nodes[rng.pick(a.nbrs)];
    if (!b) continue;
    const t = rng.range(0.15, 0.85);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const off = rng.range(-1.1, 1.1);
    spawnItem(w, rng.pick(litter), a.x + dx * t - (dz / l) * off, a.z + dz * t + (dx / l) * off, rng.range(0, Math.PI * 2));
  }
  // rubbish bags and boxes by shops, diners, bars and markets
  for (const p of pois) {
    if (!['shop', 'diner', 'bar', 'market', 'cafe'].includes(p.kind)) continue;
    const { tx, tz, nx, nz } = tangentOf(p);
    if (rng.chance(IT.bagClusterChance)) {
      const s = rng.range(2.5, 4) * (rng.chance(0.5) ? 1 : -1);
      for (let k = 0; k < rng.int(1, 3); k++) spawnItem(w, 'bag', p.x + tx * (s + k * 0.45) - nx * 1.0, p.z + tz * (s + k * 0.45) - nz * 1.0, rng.range(0, 6));
    }
    if (rng.chance(IT.boxChance)) {
      const s = rng.range(-4, -2.5);
      spawnItem(w, 'box', p.x + tx * s - nx * 1.1, p.z + tz * s - nz * 1.1, rng.range(0, 6));
      if (rng.chance(0.5)) spawnItem(w, 'box', p.x + tx * s - nx * 1.1, p.z + tz * s - nz * 1.1, rng.range(0, 6), 0.32);
    }
  }
  // roadworks: lines of cones along a kerb
  const taken = (x: number, z: number) => w.vehicles.some((v) => Math.hypot(v.px - x, v.pz - z) < 9);
  for (let k = 0, tries = 0; k < IT.coneClusters && tries < 200; tries++) {
    const s = rng.pick(c.parkingSpots);
    if (taken(s.x, s.z)) continue;
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    for (let i = 0; i < IT.conesPerCluster; i++) spawnItem(w, 'cone', s.x + fx * (i * 2.4 - 3.6), s.z + fz * (i * 2.4 - 3.6), 0);
    k++;
  }
  // brick piles against the south side of a few buildings (skipped where that spot is inside something)
  for (let k = 0; k < IT.brickPiles; k++) {
    const b = rng.pick(c.buildings);
    const x = (b.minX + b.maxX) / 2 + rng.range(-3, 3), z = b.maxZ + 0.9;
    if (c.isBlocked(x, z)) continue;
    for (let i = 0; i < IT.bricksPerPile; i++) spawnItem(w, 'brick', x + (i % 3) * 0.24 - 0.24, z, 0, 0.02 + Math.floor(i / 3) * 0.072);
  }
  // bats by the gym, wrenches at the garage (fallbacks keep every seed stocked)
  const gyms = pois.filter((p) => p.kind === 'gym');
  const garages = pois.filter((p) => p.kind === 'garage');
  for (const p of (gyms.length ? gyms : pois.filter((q) => q.kind === 'park')).slice(0, IT.gymsWithBats)) {
    const { tx, tz, nx, nz } = tangentOf(p);
    for (let i = 0; i < IT.batsPerGym; i++) spawnItem(w, 'bat', p.x + tx * (2.5 + i * 0.5) - nx * 1.0, p.z + tz * (2.5 + i * 0.5) - nz * 1.0, rng.range(0, 0.4));
  }
  for (const p of garages.length ? garages : pois.filter((q) => q.kind === 'market').slice(0, 1)) {
    const { tx, tz, nx, nz } = tangentOf(p);
    for (let i = 0; i < IT.wrenchesPerGarage; i++) spawnItem(w, 'wrench', p.x + tx * (1.5 + i * 0.6) - nx * 1.0, p.z + tz * (1.5 + i * 0.6) - nz * 1.0, rng.range(0, 6));
  }
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
