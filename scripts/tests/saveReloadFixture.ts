import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '../../src/world';
import { createItems, spawnItem, placeInWorld } from '../../src/systems/worldItems';
import { pickUp } from '../../src/systems/inventory';
import { createPersistence, loadGame, saveGame, persistenceStatus } from '../../src/systems/persistence';
await RAPIER.init();
const physics = new RAPIER.World({ x: 0, y: -22, z: 0 });
const body = physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
const w = {
  R: RAPIER, physics, scene: new THREE.Scene(), seed: 987654, cash: 250, time: 6,
  city: { id: 'grid', spawn: { x: 0, z: 0 }, heightAt: () => 0 },
  dayNight: { day: 2, hour: 12.5 }, player: { body, mesh: new THREE.Group(), facing: 0, health: 50, vy: 0, vehicle: null },
  inventory: { slots: Array(9).fill(null), selected: 0, nameEl: { style: {} }, nameUntil: 0, shownKey: '' },
  hud: { toast: { style: {}, innerHTML: '' }, toastUntil: 0 }, audio: {}, events: [], vehicles: [], peds: [], parked: { cars: [], dirty: false },
} as unknown as World;
w.itemsState = createItems(w);
const changed = new URLSearchParams(location.search).has('changed');
spawnItem(w, changed ? 'brick' : 'can', 1, 2, 0)!.sealed = true;
if (changed) spawnItem(w, 'phone', 8, 9, 0)!.authoredKey = 'fixture-shelf/phone';
const primary = () => w.itemsState.items[0];
let extra: { apartment: string | null; storage: number[] } = { apartment: null, storage: [] };
createPersistence(w, { capture: () => structuredClone(extra), restore: (data) => { if (data) extra = data as typeof extra; } });
const loaded = await loadGame(w);
const api = {
  loaded,
  state: () => { const it = primary(); return ({ type: it.type, authoredPhones: w.itemsState.items.filter(i => i.authoredKey === 'fixture-shelf/phone').length, cash: w.cash, ids: w.inventory.slots.map((i) => i?.id ?? null), item: { inWorld: it.inWorld, enabled: it.body.isEnabled(), location: it.location, sealed: it.sealed, x: it.px }, extra, status: persistenceStatus(w) }); },
  transact: async () => { w.cash -= 80; extra.apartment = 'home-1'; pickUp(w, primary()); return await saveGame(w); },
  moveAndSave: async () => { w.inventory.slots.fill(null); placeInWorld(w, primary(), 4, 0.5, 5, 0, 0, 0, 0); return await saveGame(w); },
  saveCurrent: () => saveGame(w),
  legacy: async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('open-city-saves', 1);
      req.onsuccess = () => { const tx = req.result.transaction('worlds', 'readwrite'); const store = tx.objectStore('worlds'); const get = store.get('grid:987654');
        get.onsuccess = () => { const data = get.result; data.items.forEach((item: {authoredKey?: string}) => { delete item.authoredKey; }); store.put(data); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
    });
  },
  corrupt: async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('open-city-saves', 1);
      req.onsuccess = () => { const tx = req.result.transaction('worlds', 'readwrite'); tx.objectStore('worlds').put({ key: 'grid:987654', version: 999, sentinel: 'preserve me' }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
    });
  },
};
(window as unknown as { __saveTest: typeof api }).__saveTest = api;
