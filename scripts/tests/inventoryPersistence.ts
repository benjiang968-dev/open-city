// Headless real-Rapier regression: item identity, mass limits, consume-once, and snapshot restore.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '../../src/world';
import { TUNING } from '../../src/tuning';
import { createItems, spawnItem, removeFromWorld, placeInWorld, resetItemRegistry } from '../../src/systems/worldItems';
import { pickUp, takeSelected, transferToInventory, useSelected, carriedMass } from '../../src/systems/inventory';
import { ITEM_IDS } from '../../src/art/items';
import { seedInteriorCollectibles } from '../../src/systems/interiorCollectibles';
import { captureSave, restoreSave, validSave } from '../../src/systems/persistence';
await RAPIER.init();
const physics = new RAPIER.World({ x: 0, y: -22, z: 0 });
const body = physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
const w = {
  R: RAPIER, physics, scene: new THREE.Scene(), seed: 123, cash: 500, time: 6,
  city: { id: 'grid', spawn: { x: 0, z: 0 }, heightAt: () => 0 },
  dayNight: { day: 2, hour: 12.5 }, player: { body, mesh: new THREE.Group(), facing: 0, health: 50, vy: 0, vehicle: null },
  inventory: { slots: Array(TUNING.items.hotbarSlots).fill(null), selected: 0, nameEl: { style: {} }, nameUntil: 0, shownKey: '' },
  hud: { toast: { style: {}, innerHTML: '' }, toastUntil: 0 }, audio: {}, events: [], vehicles: [], peds: [], parked: { cars: [], dirty: false },
} as unknown as World;
w.itemsState = createItems(w);
const can = spawnItem(w, 'can', 1, 2, 0)!;
can.sealed = true; can.owner = 'corner-shop'; can.stolen = true;
assert.equal(pickUp(w, can), true);
assert.equal(pickUp(w, can), false);
assert.equal(w.inventory.slots.filter(Boolean).length, 1);
assert.equal(w.events.filter((e) => e.type === 'shopTheft').length, 1);
assert.equal(useSelected(w), true); assert.equal(w.player.health, 55); assert.equal(can.sealed, false);
assert.equal(useSelected(w), false); assert.equal(w.player.health, 55);
assert.equal(takeSelected(w), can); removeFromWorld(w, can);
assert.equal(can.location, 'storage');
assert.equal(transferToInventory(w, can), true);
assert.equal(transferToInventory(w, can), false);
assert.equal(w.events.filter((e) => e.type === 'shopTheft').length, 1);
const snapshot = structuredClone(captureSave(w));
assert.equal(validSave(snapshot, 'grid:123'), true);
assert.equal(validSave({ ...snapshot, version: 999 }, 'grid:123'), false);
const duplicate = structuredClone(snapshot); duplicate.inventory[1] = can.id;
assert.equal(validSave(duplicate, 'grid:123'), false);
const disagree = structuredClone(snapshot); disagree.items[0].location = 'world';
assert.equal(validSave(disagree, 'grid:123'), false);
w.inventory.slots.fill(null); placeInWorld(w, can, 18, 9, 8, 1, 5, 6, 7); w.cash = 1; w.player.health = 1;
restoreSave(w, snapshot);
assert.equal(w.cash, 500); assert.equal(w.player.health, 55);
assert.equal(w.inventory.slots[0], can); assert.equal(can.inWorld, false); assert.equal(can.body.isEnabled(), false);
assert.equal(can.location, 'inventory'); assert.equal(can.sealed, false); assert.equal(can.reportedTheft, true);
assert.equal(carriedMass(w), 0.3);
// Weight, rather than spare slot count, rejects additional heavy items consistently.
w.inventory.slots.fill(null);
for (let i = 0; i < 5; i++) {
 const brick = spawnItem(w, 'brick', i, 0, 0)!;
 assert.equal(pickUp(w, brick), i < 4);
}
assert.equal(carriedMass(w), 10);
// Shared catalogue gives every hand-sized authored prop the same pickup/drop/use path.
w.inventory.slots.fill(null);
assert.deepEqual(ITEM_IDS.slice(0, 8), ['bottle','can','bag','box','cone','brick','wrench','bat']);
for (const type of ITEM_IDS) assert.ok(w.itemsState.art[type].geo.getAttribute('position').array.every(Number.isFinite));
const apple = spawnItem(w, 'apple', 0, 0, 0)!; apple.owner = 'corner-shop'; apple.price = 3;
w.player.health = 40; assert.equal(pickUp(w, apple), true); assert.equal(useSelected(w), true);
assert.equal(w.player.health, 48); assert.equal(apple.location, 'consumed'); assert.equal(useSelected(w), false);
assert.equal(pickUp(w, apple), false); assert.equal(apple.reportedTheft, true);
assert.equal(w.events.filter(e => e.type === 'shopTheft' && e.itemId === apple.id).length, 1);
const sandwich = spawnItem(w, 'sandwich', 0, 0, 0)!; assert.equal(pickUp(w, sandwich), true); assert.equal(useSelected(w), true); assert.equal(w.player.health, 64);
const book = spawnItem(w, 'book', 0, 0, 0)!; assert.equal(pickUp(w, book), true); assert.equal(useSelected(w), true); assert.equal(book.location, 'inventory');
w.inventory.slots.fill(null);
const phone = spawnItem(w, 'phone', 0, 0, 0)!; assert.equal(pickUp(w, phone), true); assert.equal(useSelected(w), true); assert.match(w.hud.toast.innerHTML, /Phone.*Day 2/);
w.interiors = { entries: [{ id: 'workshop-fixture', kind: 'workshop', origin: {x:50,y:300,z:50} }], active: null } as unknown as World['interiors'];
const oldCount = w.itemsState.items.length; seedInteriorCollectibles(w); const seededCount = w.itemsState.items.length;
assert.ok(seededCount > oldCount); seedInteriorCollectibles(w); assert.equal(w.itemsState.items.length, seededCount);
assert.ok(w.itemsState.items.slice(oldCount).every(it => !!it.authoredKey && it.py > 300));
// A legacy v1 save with no authored keys survives a different current map's scatter ordering.
const legacy = structuredClone(snapshot); legacy.items.forEach(it => { delete it.authoredKey; });
resetItemRegistry(w); spawnItem(w, 'brick', 0, 0, 0);
const newPhone = spawnItem(w, 'phone', 5, 6, 0)!; newPhone.authoredKey = 'new-room/phone';
restoreSave(w, legacy);
assert.equal(w.itemsState.items[0].type, 'can'); assert.equal(w.inventory.slots[0]?.id, 0); assert.equal(w.cash, 500);
assert.equal(w.itemsState.items.filter(it => it.authoredKey === 'new-room/phone').length, 1);
restoreSave(w, legacy); assert.equal(w.itemsState.items.filter(it => it.authoredKey === 'new-room/phone').length, 1);
const migrated = structuredClone(captureSave(w)); assert.equal(validSave(migrated, 'grid:123'), true);
restoreSave(w, migrated); assert.equal(w.itemsState.items.filter(it => it.authoredKey === 'new-room/phone').length, 1);
// Authored content grows on registration, not through an invisible fixed cap or per-frame rebuilding.
for (let n = 0; n < 300; n++) assert.ok(spawnItem(w, 'mug', n, 0, 0));
assert.ok(w.itemsState.meshes.mug.instanceMatrix.count >= 300); assert.equal(w.itemsState.meshes.mug.count, 300);
physics.free();
console.log('PASS item catalogue, physical eligibility, food/read/phone use, unpaid-use reports, same-ID inventory/storage, legacy v1 changed-scatter migration, stable authored seeding and draw capacity growth');
