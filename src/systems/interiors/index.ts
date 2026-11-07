/** Furnished, collidable interiors behind marked doors. Rooms stream once on entry, then retain their objects.
 * A doorway transition separates the room from the exterior footprint; this avoids spawning the player in a
 * solid imported building or an unfitted floor. Entry positions are taken from reachable pavement, never roads.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from '../../world';
import { GROUPS } from '../../physicsGroups';
import { TUNING } from '../../tuning';
import { INTERIOR as I, INTERIOR_SITES, type InteriorKind } from '../../data/interiorDefs';
import type { SolidKind } from '../objects/solidKinds';
import { toast } from '../hud';

export type { InteriorKind } from '../../data/interiorDefs';
export interface InteriorEntry {
  id: string;
  kind: InteriorKind;
  name: string;
  poiId: number;
  exterior: { x: number; y: number; z: number; heading: number };
  origin: { x: number; y: number; z: number };
  upstairs: boolean;
  sign: THREE.Group;
  room: THREE.Group | null;
  colliders: RAPIER.Collider[];
  /** Useful local work/storage/pickup positions, clear of furniture. */
  stations: { x: number; y: number; z: number }[];
  door?: { pivot: THREE.Group; collider: RAPIER.Collider; open: boolean; angle: number };
}
export interface InteriorsState {
  entries: InteriorEntry[];
  active: string | null;
  lastTransition: number;
  /** Root can enforce access/payment, or issue a trespass event, before a door transition. */
  beforeEnter?: (entry: InteriorEntry) => boolean;
  onEnter?: (entry: InteriorEntry) => void;
  onExit?: (entry: InteriorEntry) => void;
}

const sharedMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x39a89c, roughness: 0.55, emissive: 0x154d47, emissiveIntensity: 0.3 });

/** Select one nearby legal pavement entrance per use. Stable per map: seed changes never move these doors. */
export function createInteriors(w: World): InteriorsState {
  const entries: InteriorEntry[] = [];
  const used = new Set<number>();
  const spawn = w.city.spawn;
  const sorted = [...w.city.pois].sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z));
  for (const spec of INTERIOR_SITES) {
    const valid = (p: (typeof sorted)[number]) => !used.has(p.id) && !w.city.isBlocked(p.x, p.z) && !w.city.isRoad(p.x, p.z) && !w.city.isWater(p.x, p.z)
      && !entries.some((e) => Math.hypot(e.exterior.x - p.x, e.exterior.z - p.z) < I.interactRange * 2);
    const poi = sorted.find((p) => valid(p) && spec.matches.some((m) => `${p.kind} ${p.cat ?? ''}`.includes(m))) ?? sorted.find(valid);
    if (!poi) continue;
    used.add(poi.id);
    const y = w.city.heightAt(poi.x, poi.z);
    const towardDoor = Math.atan2(poi.door.x - poi.x, poi.door.z - poi.z);
    const e: InteriorEntry = {
      id: `interior-${spec.kind}-${poi.id}`, kind: spec.kind, name: spec.title,
      poiId: poi.id, upstairs: spec.upstairs,
      exterior: { x: poi.x, y, z: poi.z, heading: towardDoor },
      origin: { x: poi.x, y: I.floorHeight + entries.length * I.levelSpacing, z: poi.z },
      sign: new THREE.Group(), room: null, colliders: [], stations: [],
    };
    // Stand just outside the imported facade. The plaque signals a real available interior, not every facade.
    e.sign.position.set(poi.x, y, poi.z);
    e.sign.rotation.y = towardDoor;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.14, 0.12), trimMaterial);
    frame.position.set(0, 2.52, 0.45); e.sign.add(frame);
    for (const x of [-0.87, 0.87]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.12), trimMaterial);
      post.position.set(x, 1.25, 0.45); e.sign.add(post);
    }
    const plaque = label(`${spec.title}\nE  ENTER`, 1.8, 0.58);
    plaque.position.set(0, 2.88, 0.45); plaque.rotation.y = Math.PI; e.sign.add(plaque);
    w.scene.add(e.sign);
    e.stations = [interiorPoint(e, 0, 0), interiorPoint(e, -1.1, -3.6), interiorPoint(e, 1.1, 2.3)];
    entries.push(e);
  }
  const S: InteriorsState = { entries, active: null, lastTransition: -100 };
  return S;
}

function label(text: string, width: number, height: number): THREE.Mesh {
  const c = document.createElement('canvas'); c.width = 512; c.height = 160;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#103830'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#69d3bd'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 504, 152);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#f2eee5';
  const lines = text.split('\n');
  lines.forEach((line, n) => { ctx.font = n ? 'bold 26px sans-serif' : 'bold 33px sans-serif'; ctx.fillText(line, 256, lines.length > 1 ? 52 + n * 62 : 80, 480); });
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
}

/** World coordinate of a local room point. Ground/upper-floor points are usable for items and job targets. */
export function interiorPoint(e: InteriorEntry, x: number, z: number, upper = false) {
  return { x: e.origin.x + x, y: e.origin.y + (upper ? I.upperFloor : 0), z: e.origin.z + z };
}

function buildRoom(w: World, e: InteriorEntry) {
  if (e.room) return;
  const room = e.room = new THREE.Group(); room.position.set(e.origin.x, e.origin.y, e.origin.z);
  const geometries: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number, kind: SolidKind | null = 'building') => {
    const geo = new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
    const colorV = new THREE.Color(color), colors = new Float32Array(geo.getAttribute('position').count * 3);
    for (let n = 0; n < colors.length; n += 3) { colors[n] = colorV.r; colors[n + 1] = colorV.g; colors[n + 2] = colorV.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometries.push(geo);
    if (kind) {
      const co = w.physics.createCollider(w.R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setTranslation(e.origin.x + x, e.origin.y + y, e.origin.z + z).setCollisionGroups(GROUPS.static).setFriction(0.85));
      w.city.solidTags.set(co.handle, kind); e.colliders.push(co);
    }
  };
  const ceiling = e.upstairs ? I.upperCeiling : I.ceiling;
  box(0, -0.15, 0, I.halfWidth * 2 + 0.4, 0.3, I.halfDepth * 2 + 0.4, 0x9b8164, 'ground');
  // Real wall opening at the door; imported exterior and room share an explicit transition threshold.
  const side = I.halfWidth - I.doorWidth / 2;
  box(-(I.doorWidth / 2 + side / 2), ceiling / 2, I.halfDepth, side, ceiling, 0.22, 0xe3ded2);
  box(I.doorWidth / 2 + side / 2, ceiling / 2, I.halfDepth, side, ceiling, 0.22, 0xe3ded2);
  box(0, (ceiling + I.doorHeight) / 2, I.halfDepth, I.doorWidth, ceiling - I.doorHeight, 0.22, 0xe3ded2);
  box(0, ceiling / 2, -I.halfDepth, I.halfWidth * 2, ceiling, 0.22, 0xe3ded2);
  box(-I.halfWidth, ceiling / 2, 0, 0.22, ceiling, I.halfDepth * 2, 0xd8d8cc);
  box(I.halfWidth, ceiling / 2, 0, 0.22, ceiling, I.halfDepth * 2, 0xd8d8cc);
  box(0, ceiling + 0.12, 0, I.halfWidth * 2 + 0.4, 0.24, I.halfDepth * 2 + 0.4, 0xf3f0e8);
  // Hinged, collidable leaf: O opens/closes it, while E crosses the exit threshold.
  const pivot = new THREE.Group(); pivot.position.set(-I.doorWidth / 2, 0, I.halfDepth);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(I.doorWidth, I.doorHeight, 0.08), new THREE.MeshStandardMaterial({ color: 0x68513e, roughness: 0.8 }));
  leaf.position.set(I.doorWidth / 2, I.doorHeight / 2, 0); pivot.add(leaf); room.add(pivot);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.05), trimMaterial);
  handle.position.set(I.doorWidth - 0.18, 1.1, -0.065); pivot.add(handle);
  const dc = w.physics.createCollider(w.R.ColliderDesc.cuboid(I.doorWidth / 2, I.doorHeight / 2, 0.04).setCollisionGroups(GROUPS.static));
  w.city.solidTags.set(dc.handle, 'door'); e.colliders.push(dc);
  e.door = { pivot, collider: dc, open: true, angle: -Math.PI / 2 }; updateDoor(e, 0);
  const exit = label('EXIT\nE  LEAVE', 1.2, 0.42); exit.position.set(0, 2.68, I.halfDepth - 0.13); exit.rotation.y = Math.PI; room.add(exit);
  for (const x of [-4.2, 4.2]) box(x, 0.11, 0, 0.08, 0.18, 11.8, 0xf1e9db, null);

  // Simple reusable furniture modules have matching collision, rather than decorative non-solid silhouettes.
  const table = (x: number, z: number, width = 1.8, depth = 0.8, y = 0) => {
    box(x, y + 0.78, z, width, 0.1, depth, 0x916b43);
    for (const dx of [-width / 2 + 0.1, width / 2 - 0.1]) for (const dz of [-depth / 2 + 0.1, depth / 2 - 0.1]) box(x + dx, y + 0.37, z + dz, 0.08, 0.74, 0.08, 0x393c3d);
  };
  const chair = (x: number, z: number, y = 0) => {
    box(x, y + 0.43, z, 0.48, 0.1, 0.5, 0x53766f);
    box(x, y + 0.78, z - 0.23, 0.48, 0.6, 0.08, 0x53766f);
    for (const dx of [-0.18, 0.18]) for (const dz of [-0.18, 0.18]) box(x + dx, y + 0.2, z + dz, 0.055, 0.4, 0.055, 0x474747);
  };
  const shelf = (x: number, z: number, width = 2, y = 0) => {
    box(x - width / 2, y + 0.9, z, 0.1, 1.8, 0.45, 0x75624b);
    box(x + width / 2, y + 0.9, z, 0.1, 1.8, 0.45, 0x75624b);
    for (const h of [0.15, 0.8, 1.45]) {
      box(x, y + h, z, width, 0.09, 0.45, 0xa88964);
      for (let n = 0; n < 4; n++) box(x - width / 2 + 0.28 + n * (width - 0.4) / 4, y + h + 0.18, z, 0.19, 0.28, 0.25, [0x9f6655, 0xd7bb6a, 0x4d6e79, 0x6d8062][n], null);
    }
  };
  const cabinet = (x: number, z: number, width: number, y = 0) => {
    box(x, y + 0.48, z, width, 0.96, 0.65, 0x7c897a);
    box(x, y + 1, z, width + 0.08, 0.08, 0.72, 0xd2c6b4);
    for (const dx of [-width / 4, width / 4]) box(x + dx, y + 0.55, z + 0.34, 0.2, 0.035, 0.045, 0x484d48, null);
  };
  switch (e.kind) {
    case 'apartment': {
      box(-2.9, 0.42, 0.1, 2.8, 0.8, 1.05, 0x747e7a);
      box(-2.9, 0.95, -0.4, 2.8, 0.7, 0.18, 0x68716e);
      table(-2.7, 1.7, 1.6, 0.75); cabinet(-2.8, -4.9, 3.4); shelf(-3, -2.8, 2.4);
      table(0.5, -2, 1.2, 1.2); chair(0.5, -3.0); chair(0.5, -1);
      box(-2.4, I.upperFloor + 0.35, -2.4, 2, 0.55, 2.7, 0xb0aaa1);
      box(-2.4, I.upperFloor + 0.69, -3.25, 1.65, 0.18, 0.6, 0xe7e2d8);
      cabinet(-3.5, 1, 1.8, I.upperFloor);
      break;
    }
    case 'shop':
      shelf(-3.9, -2.1, 1.7); shelf(-3.9, 1.2, 1.7); shelf(3.9, -2.1, 1.7); shelf(3.9, 1.2, 1.7);
      cabinet(0, -4.9, 3.2); box(0.8, 1.15, -4.9, 0.48, 0.26, 0.35, 0x31393a); break;
    case 'office':
      for (const z of [-3.8, -0.3]) { table(-2.7, z, 2.1, 0.9); chair(-2.7, z + 0.9); box(-2.7, 1.13, z - 0.16, 0.75, 0.5, 0.08, 0x344950, null); }
      shelf(-3.5, 3.4, 1.8); table(-2, -2, 2.5, 1.3, I.upperFloor); chair(-2, -0.8, I.upperFloor);
      for (const x of [-1, 0, 1]) {
        box(x, 1.2, -4.4, 0.55, 0.7, 0.22, 0x58676b);
        box(x, 0.42, -4.4, 0.08, 0.84, 0.09, 0x434c4d);
        box(x, 0.06, -4.4, 0.46, 0.12, 0.42, 0x434c4d);
        box(x + 0.15, 1.38, -4.26, 0.055, 0.055, 0.025, 0x7cce80, null);
        box(x, 1.07, -4.26, 0.3, 0.06, 0.025, 0xdbcc9a, null);
      }
      break;
    case 'warehouse':
      for (const x of [-3.8, 3.8]) {
        shelf(x, -3.7, 1.6); shelf(x, 0, 1.6);
        box(x, 0.4, 3.5, 1.4, 0.8, 1.2, 0xb58c58); box(x, 1.05, 3.5, 1.1, 0.5, 1, 0xae8452);
      } table(0, -4.8, 2.5); break;
    case 'workshop':
      table(-2.6, -4.7, 3.8, 1); shelf(3.7, -3.5, 1.7); cabinet(-3.8, 0, 1.6);
      table(2.8, 1.4, 2, 1); box(-2.4, 1.15, -4.8, 0.55, 0.5, 0.42, 0x54645d); break;
    case 'cafe':
      cabinet(-2.6, -4.7, 3.8); box(-3, 1.25, -4.6, 0.8, 0.5, 0.6, 0x586d6e);
      for (const x of [-2.8, 2.8]) for (const z of [-1.8, 2.1]) { table(x, z, 1, 1); chair(x, z - 0.9); chair(x, z + 0.9); }
      break;
  }
  if (e.upstairs) {
    // Upper slab leaves a 2 m-wide stairwell. The long run is 27 degrees, comfortably below the CC climb limit.
    box(-1.3, I.upperFloor - 0.13, -1.15, 7.4, 0.26, 9.7, 0xb39a77, 'ground');
    box(3.7, I.upperFloor - 0.13, 3.95, 2.6, 0.26, 3.9, 0xb39a77, 'ground');
    const st = I.stair;
    const verts = new Float32Array([
      st.x - st.width / 2, 0, st.z0, st.x + st.width / 2, 0, st.z0,
      st.x - st.width / 2, 0, st.z1, st.x + st.width / 2, 0, st.z1,
      st.x - st.width / 2, st.rise, st.z1, st.x + st.width / 2, st.rise, st.z1,
    ]);
    const desc = w.R.ColliderDesc.convexHull(verts)!;
    desc.setTranslation(e.origin.x, e.origin.y, e.origin.z).setCollisionGroups(GROUPS.static).setFriction(0.9);
    const co = w.physics.createCollider(desc); e.colliders.push(co); w.city.solidTags.set(co.handle, 'stair');
    for (let n = 0; n < st.steps; n++) {
      const depth = (st.z1 - st.z0) / st.steps, top = st.rise * (n + 1) / st.steps;
      box(st.x, top / 2 - 0.025, st.z0 + depth * (n + 0.5), st.width, top - 0.05, depth, n % 2 ? 0xc9b494 : 0xbfa987, null);
    }
    // Rail alongside the opening, with a clear landing at each end.
    box(2.36, I.upperFloor + 0.5, -1.2, 0.08, 1, 6.1, 0x61706d, 'railing');
  }
  const geo = mergeGeometries(geometries);
  for (const part of geometries) part.dispose();
  const mesh = new THREE.Mesh(geo, sharedMaterial); mesh.castShadow = true; mesh.receiveShadow = true; room.add(mesh);
  const light = new THREE.PointLight(0xffe8c7, 55, 19, 2); light.position.set(0, e.upstairs ? 5.5 : 2.8, 0); room.add(light);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.4), new THREE.MeshBasicMaterial({ color: 0xffefcb }));
  glow.position.set(0, e.upstairs ? 6.55 : 3.05, 0); room.add(glow);
  e.stations = [interiorPoint(e, 0, 0), interiorPoint(e, -1.1, -3.6), interiorPoint(e, 1.1, 2.3)];
  room.visible = false; w.scene.add(room);
}

export function activeInterior(S: InteriorsState): InteriorEntry | null {
  return S.entries.find((e) => e.id === S.active) ?? null;
}

function placePlayer(w: World, x: number, y: number, z: number, heading: number) {
  const p = w.player;
  const capsule = TUNING.player.capsuleHalfHeight + TUNING.player.capsuleRadius;
  p.body.setTranslation({ x, y: y + capsule + 0.04, z }, true);
  p.body.setNextKinematicTranslation({ x, y: y + capsule + 0.04, z });
  p.mesh.position.set(x, y + 0.04, z); p.facing = heading; p.mesh.rotation.y = heading;
  p.vy = 0; p.knockT = 0; p.knockX = 0; p.knockZ = 0;
  w.cam.focus.set(x, y + TUNING.camera.heightOffset, z); w.cam.yaw = heading + Math.PI;
  w.input.keys.clear(); w.input.pressed.delete('KeyE'); w.input.mouse0 = false;
}

export function enterInterior(w: World, S: InteriorsState, entryId: string): boolean {
  const e = S.entries.find((site) => site.id === entryId);
  if (!e || w.player.vehicle || S.active || (S.beforeEnter && !S.beforeEnter(e))) return false;
  buildRoom(w, e); if (e.door) { e.door.open = true; e.door.angle = -Math.PI / 2; updateDoor(e, 0); } e.room!.visible = true; S.active = e.id; S.lastTransition = w.time;
  const p = interiorPoint(e, 0, I.doorInset);
  placePlayer(w, p.x, p.y, p.z, Math.PI);
  toast(w, `${e.name} · E at the door to leave`, 3); S.onEnter?.(e); return true;
}

export function exitInterior(w: World, S: InteriorsState): boolean {
  const e = activeInterior(S); if (!e) return false;
  const { x, y, z, heading } = e.exterior;
  placePlayer(w, x, y, z, heading + Math.PI);
  e.room!.visible = false; S.active = null; S.lastTransition = w.time; S.onExit?.(e);
  toast(w, 'Back on the street', 2); return true;
}

/** Call before updatePlayer each simulation tick. Consumes E only when an actual marked door is in range. */
export function interiorInteraction(w: World, S: InteriorsState): boolean {
  if (!w.started || w.paused || w.input.blocked || w.player.dead || w.player.vehicle) return false;
  const p = w.player.body.translation();
  const e = activeInterior(S);
  if (e) {
    const exit = interiorPoint(e, 0, I.halfDepth - 0.55);
    if (Math.hypot(p.x - exit.x, p.z - exit.z) < I.interactRange && p.y < e.origin.y + 2) {
      w.player.prompt = 'E  leave · O  open / close door';
      if (w.input.pressed.has('KeyO') && e.door) {
        const thresholdOccupied = Math.abs(p.x - e.origin.x) < I.doorWidth / 2 + TUNING.player.capsuleRadius && Math.abs(p.z - e.origin.z - I.halfDepth) < TUNING.player.capsuleRadius + 0.25;
        if (e.door.open && thresholdOccupied) toast(w, 'Step back from the doorway to close it', 2);
        else e.door.open = !e.door.open;
        w.input.pressed.delete('KeyO');
      }
      if (w.input.pressed.has('KeyE') && w.time - S.lastTransition > I.transitionCooldown) { w.input.pressed.delete('KeyE'); exitInterior(w, S); return true; }
    }
    return false;
  }
  let best: InteriorEntry | null = null, dist: number = I.interactRange;
  for (const site of S.entries) {
    const d = Math.hypot(site.exterior.x - p.x, site.exterior.z - p.z);
    if (d < dist && Math.abs(p.y - site.exterior.y) < 3) { best = site; dist = d; }
  }
  if (!best) return false;
  w.player.prompt = `E  enter ${best.name}`;
  if (w.input.pressed.has('KeyE') && w.time - S.lastTransition > I.transitionCooldown) { w.input.pressed.delete('KeyE'); return enterInterior(w, S, best.id); }
  return false;
}

/** Update after the player: this also restores the door hint after the player's general street interactions. */
export function updateInteriors(w: World, S: InteriorsState, dt: number): void {
  const e = activeInterior(S);
  if (e) {
    updateDoor(e, dt);
    // No transition can unload the floor below the player. If a debug teleport falls outside, restore inside.
    const p = w.player.body.translation();
    if (p.y < e.origin.y - 2 || p.y > e.origin.y + I.upperCeiling + 3 || Math.abs(p.x - e.origin.x) > I.halfWidth + 2 || Math.abs(p.z - e.origin.z) > I.halfDepth + 2) {
      const safe = interiorPoint(e, 0, I.doorInset); placePlayer(w, safe.x, safe.y, safe.z, Math.PI);
    }
  }
  const pressed = w.input.pressed.has('KeyE');
  w.input.pressed.delete('KeyE'); interiorInteraction(w, S);
  if (pressed) w.input.pressed.add('KeyE');
}

/** The leaf and its static collider share exactly one transform. Close only while the threshold is clear. */
function updateDoor(e: InteriorEntry, dt: number): void {
  const d = e.door; if (!d) return;
  const target = d.open ? -Math.PI / 2 : 0;
  d.angle += (target - d.angle) * (1 - Math.exp(-9 * dt));
  d.pivot.rotation.y = d.angle;
  const half = I.doorWidth / 2;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.angle);
  d.collider.setTranslation({ x: e.origin.x - half + Math.cos(d.angle) * half, y: e.origin.y + I.doorHeight / 2, z: e.origin.z + I.halfDepth - Math.sin(d.angle) * half });
  d.collider.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
}
