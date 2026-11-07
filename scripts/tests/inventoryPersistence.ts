// Headless real-Rapier regression: item identity, mass limits, consume-once, and snapshot restore.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '../../src/world';
import { TUNING } from '../../src/tuning';
import { createItems, spawnItem, removeFromWorld, placeInWorld } from '../../src/systems/worldItems';
import { pickUp, takeSelected, transferToInventory, useSelected, carriedMass } from '../../src/systems/inventory';
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
physics.free();
console.log('PASS inventory identity, theft-once, consume-once, storage retrieval, weight limits, snapshot validation and restore');
