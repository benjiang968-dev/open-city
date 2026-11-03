// Hotbar inventory: 9 one-hand slots along the bottom of the screen. 1–9 or the mouse wheel select,
// E picks up the item you're looking at, Q drops the selected one as a physics object. Hands start empty.
// The selected item is shown in the player's right hand. Cash is not an item.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import type { ItemId } from '../art/items';
import { ITEM_IDS } from '../art/items';
import { removeFromWorld, placeInWorld, renderItemIcons, type WorldItem } from './worldItems';

const IT = TUNING.items;

export interface InventoryState {
  slots: (WorldItem | null)[];
  selected: number;
  slotEls: HTMLElement[];
  nameEl: HTMLElement;
  nameUntil: number;
  icons: Record<ItemId, string>;
  held: Record<ItemId, THREE.Mesh>;
  shownKey: string; // last rendered hotbar state (skip DOM work when unchanged)
  /** Arm pose override this frame (set by combat while charging / swinging). */
  armPose: number | null;
}

export function createInventory(w: World): InventoryState {
  const root = document.createElement('div');
  root.id = 'hotbar';
  const slotEls: HTMLElement[] = [];
  for (let i = 0; i < IT.hotbarSlots; i++) {
    const s = document.createElement('div');
    s.className = 'slot';
    s.innerHTML = `<span class="n">${i + 1}</span><img alt="" hidden><span class="q"></span>`;
    root.appendChild(s);
    slotEls.push(s);
  }
  const nameEl = document.createElement('div');
  nameEl.id = 'hotbar-name';
  nameEl.className = 'shadow';
  const ui = document.getElementById('ui')!;
  ui.appendChild(root);
  ui.appendChild(nameEl);
  root.style.visibility = 'hidden';
  // a mesh per item type in the right hand (only the selected one is visible)
  const S = w.itemsState;
  const held = {} as Record<ItemId, THREE.Mesh>;
  for (const id of ITEM_IDS) {
    const m = new THREE.Mesh(S.art[id].geo, S.material);
    const a = S.art[id];
    m.position.set(...a.holdPos);
    m.rotation.set(...a.holdRot);
    m.visible = false;
    m.castShadow = true;
    w.player.rig.armR.add(m);
    held[id] = m;
  }
  return {
    slots: Array(IT.hotbarSlots).fill(null), selected: 0, slotEls, nameEl, nameUntil: 0, icons: renderItemIcons(w), held, shownKey: '', armPose: null,
  };
}

export function showHotbar(): void {
  const el = document.getElementById('hotbar');
  if (el) el.style.visibility = 'visible';
}

export function selectedItem(w: World): WorldItem | null {
  return w.inventory.slots[w.inventory.selected];
}

export function freeSlot(w: World): number {
  return w.inventory.slots.indexOf(null);
}

/** Put a world item into the first free slot. Returns false when the hotbar is full. */
export function pickUp(w: World, it: WorldItem): boolean {
  const inv = w.inventory;
  const i = freeSlot(w);
  if (i < 0) return false;
  inv.slots[i] = it;
  removeFromWorld(w, it);
  // pick into the selected slot when the hands are empty, so the item is ready to use
  if (!inv.slots[inv.selected]) inv.selected = i;
  flashName(w, IT.defs[it.type].name);
  w.audio.pickup?.();
  return true;
}

/** Remove the selected item from the hotbar (thrown or dropped). */
export function takeSelected(w: World): WorldItem | null {
  const inv = w.inventory;
  const it = inv.slots[inv.selected];
  inv.slots[inv.selected] = null;
  return it;
}

export function dropSelected(w: World): void {
  const p = w.player;
  const it = takeSelected(w);
  if (!it) return;
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  const pos = p.mesh.position;
  placeInWorld(w, it, pos.x + fx * 0.55, pos.y + 1.0, pos.z + fz * 0.55, p.facing, fx * IT.dropSpeed, 1, fz * IT.dropSpeed);
}

function flashName(w: World, name: string) {
  w.inventory.nameEl.textContent = name;
  w.inventory.nameEl.style.opacity = '1';
  w.inventory.nameUntil = w.time + 1.6;
}

/** Hotbar keys: call once per frame before the simulation consumes one-shot key presses. */
export function inventoryKeys(w: World): void {
  const inv = w.inventory;
  const inp = w.input;
  const p = w.player;
  const canAct = w.started && !w.paused && !inp.blocked && !p.dead;
  if (canAct) {
    const before = inv.selected;
    for (let i = 0; i < IT.hotbarSlots; i++) if (inp.pressed.has(`Digit${i + 1}`)) inv.selected = i;
    if (inp.wheel !== 0) inv.selected = (inv.selected + (inp.wheel > 0 ? 1 : -1) + IT.hotbarSlots) % IT.hotbarSlots;
    if (inv.selected !== before) {
      const it = inv.slots[inv.selected];
      flashName(w, it ? IT.defs[it.type].name : 'Empty hands');
    }
    if (inp.pressed.has('KeyQ') && !p.vehicle) dropSelected(w);
  }
}

/** Visuals: held item, arm pose, hotbar DOM. Call after the simulation. */
export function updateInventory(w: World): void {
  const inv = w.inventory;
  const p = w.player;
  // held item in the right hand
  const sel = inv.slots[inv.selected];
  const showHeld = !!sel && !p.vehicle && !p.dead;
  for (const id of ITEM_IDS) inv.held[id].visible = showHeld && sel!.type === id;
  if (showHeld && !p.vehicle) p.rig.armR.rotation.x = inv.armPose ?? -0.45;
  inv.armPose = null;

  // hotbar DOM (only when something changed)
  const key = `${inv.selected}|${inv.slots.map((s) => (s ? s.type : '-')).join(',')}`;
  if (key !== inv.shownKey) {
    inv.shownKey = key;
    inv.slotEls.forEach((el, i) => {
      const it = inv.slots[i];
      el.classList.toggle('sel', i === inv.selected);
      const img = el.querySelector('img') as HTMLImageElement;
      if (it) {
        img.src = inv.icons[it.type];
        img.hidden = false;
        img.alt = IT.defs[it.type].name;
        el.title = IT.defs[it.type].name;
      } else {
        img.hidden = true;
        el.title = '';
      }
    });
  }
  if (inv.nameUntil && w.time > inv.nameUntil) {
    inv.nameEl.style.opacity = '0';
    inv.nameUntil = 0;
  }
}
