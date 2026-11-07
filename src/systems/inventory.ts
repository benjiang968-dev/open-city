// Hotbar inventory: 9 one-hand slots along the bottom of the screen. 1–9 or the mouse wheel select,
// E picks up the item you're looking at, Q drops the selected one as a physics object. Hands start empty.
// The selected item is shown in the player's right hand. Cash is not an item.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import { emit, type World } from '../world';
import { toast } from './hud';
import { saveGame } from './persistence';
import type { ItemId } from '../art/items';
import { ITEM_IDS } from '../art/items';
import { removeFromWorld, placeInWorld, renderItemIcons, type WorldItem } from './worldItems';

const IT = TUNING.items;

export interface InventoryState {
  slots: (WorldItem | null)[];
  panel: HTMLElement;
  open: boolean;
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
  const panel = document.createElement('section');
  panel.id = 'inventory-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Inventory');
  panel.style.cssText = 'display:none;pointer-events:auto;position:fixed;inset:10% 15%;z-index:30;background:#18212bea;color:#edf2f6;padding:24px;border:1px solid #7e929f;border-radius:12px;overflow:auto;font:15px system-ui;box-shadow:0 20px 70px #0008';
  ui.appendChild(panel);
  panel.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    const index = button.getAttribute('data-slot');
    if (index !== null) { w.inventory.selected = Number(index); renderInventoryPanel(w); return; }
    if (button.dataset.action === 'close') closeInventory(w);
    if (button.dataset.action === 'use') { useSelected(w); renderInventoryPanel(w); }
    if (button.dataset.action === 'drop') { dropSelected(w); renderInventoryPanel(w); }
    if (button.dataset.action === 'save') void saveGame(w).then((ok) => { toast(w, ok ? 'Saved in this browser' : 'Save failed · keep this tab open'); renderInventoryPanel(w); });
  });
  window.addEventListener('keydown', (e) => {
    if (w.inventory?.open && (e.code === 'KeyI' || e.code === 'Escape') && !e.repeat) {
      e.preventDefault(); closeInventory(w);
    }
  });
  return {
    panel, open: false,
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
  // The same registry instance can occupy exactly one location. Repeated E must never duplicate it.
  if (!it.inWorld || it.location !== 'world' || w.inventory.slots.includes(it) || !pickupEligible(w, it)) return false;
  const inv = w.inventory;
  const i = freeSlot(w);
  if (i < 0) return false;
  inv.slots[i] = it;
  removeFromWorld(w, it);
  it.location = 'inventory';
  if (it.stolen && it.owner && !it.reportedTheft) {
    it.reportedTheft = true;
    emit(w, { type: 'shopTheft', x: it.px, z: it.pz, itemId: it.id, itemName: IT.defs[it.type].name });
  }
  // pick into the selected slot when the hands are empty, so the item is ready to use
  if (!inv.slots[inv.selected]) inv.selected = i;
  flashName(w, IT.defs[it.type].name);
  w.audio.pickup?.();
  void saveGame(w);
  return true;
}

/** Remove the selected item from the hotbar (thrown or dropped). */
export function takeSelected(w: World): WorldItem | null {
  const inv = w.inventory;
  const it = inv.slots[inv.selected];
  inv.slots[inv.selected] = null;
  if (it) it.location = 'storage'; // synchronous transit to a world position or a named container
  return it;
}

export function dropSelected(w: World): void {
  const p = w.player;
  const it = takeSelected(w);
  if (!it) return;
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  const pos = p.mesh.position;
  placeInWorld(w, it, pos.x + fx * 0.35, pos.y + 0.65, pos.z + fz * 0.35, p.facing, fx * IT.dropSpeed, 0, fz * IT.dropSpeed);
  void saveGame(w);
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
    if ((inp.pressed.has('KeyQ') || inp.pressed.has('KeyG')) && !p.vehicle) dropSelected(w);
    if (inp.pressed.has('KeyI')) openInventory(w);
    if (inp.pressed.has('KeyU') && !p.vehicle) useSelected(w);
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


export function carriedMass(w: World): number {
  return w.inventory.slots.reduce((sum, it) => sum + (it ? IT.defs[it.type].mass : 0), 0);
}

/** A single physical eligibility rule serves litter, tools, shop stock and interior objects. */
export function pickupEligible(w: World, it: WorldItem): boolean {
  const shape = w.itemsState.art[it.type].collider;
  const size = shape.kind === 'box' ? 2 * Math.max(shape.hx, shape.hy, shape.hz) : 2 * Math.max(shape.hh, shape.r);
  return size <= IT.handMaxSize && carriedMass(w) + IT.defs[it.type].mass <= IT.carryMaxKg;
}

export function useSelected(w: World): boolean {
  const it = selectedItem(w);
  if (!it) return false;
  if ((it.type === 'can' || it.type === 'bottle') && it.sealed) {
    // Consumes contents once, retaining the same empty, droppable container.
    it.sealed = false;
    w.player.health = Math.min(100, w.player.health + IT.drinkHeal);
    toast(w, `Drank ${IT.defs[it.type].name.toLowerCase()} · empty container kept`);
    void saveGame(w);
    return true;
  }
  toast(w, it.type === 'wrench' ? 'Use this wrench at a repair job workbench' : it.type === 'box' ? 'A portable box · useful for delivery and warehouse jobs' : 'Inspect this item or drop it with G');
  return false;
}

export function openInventory(w: World): void {
  if (w.inventory.open || w.chat.open || w.player.dead) return;
  w.inventory.open = true;
  w.input.blocked = true;
  w.input.keys.clear(); w.input.pressed.clear(); w.input.mouse0 = false;
  if (document.pointerLockElement) { w.input.expectUnlock = true; document.exitPointerLock(); }
  renderInventoryPanel(w);
  w.inventory.panel.style.display = 'block';
  (w.inventory.panel.querySelector('button') as HTMLButtonElement)?.focus();
}

export function closeInventory(w: World): void {
  w.inventory.open = false;
  w.inventory.panel.style.display = 'none';
  w.input.blocked = false;
  w.input.keys.clear(); w.input.pressed.clear(); w.input.mouse0 = false;
}

function renderInventoryPanel(w: World): void {
  const inv = w.inventory, it = selectedItem(w);
  const buttons = inv.slots.map((item, i) => `<button data-slot="${i}" style="padding:12px;margin:4px;min-width:110px;background:${i === inv.selected ? '#487080' : '#293e4a'};color:white;border:1px solid #71858f;border-radius:6px">${item ? `<img src="${inv.icons[item.type]}" alt="" width="38" height="38"><br>${IT.defs[item.type].name}` : 'Empty'}<br><small>Slot ${i + 1}</small></button>`).join('');
  const describe = it ? `${IT.defs[it.type].mass} kg · ${it.sealed ? 'Sealed drink · restores a little health' : it.type === 'bottle' || it.type === 'can' ? 'Empty container' : 'Portable object'}${it.stolen ? ' · unpaid property' : ''}` : 'Select a slot to inspect its item.';
  inv.panel.innerHTML = `<button data-action="close" style="float:right;padding:8px">Close (I / Esc)</button><h2>Inventory</h2><p>${carriedMass(w).toFixed(1)} / ${IT.carryMaxKg} kg · ${inv.slots.filter(Boolean).length} / ${IT.hotbarSlots} slots</p><div>${buttons}</div><h3>${it ? IT.defs[it.type].name : 'Empty hands'}</h3><p>${describe}</p><button data-action="use" ${it ? '' : 'disabled'}>Use (U)</button> <button data-action="drop" ${it && !w.player.vehicle ? '' : 'disabled'}>Drop (G)</button> <button data-action="save">Save now</button><p style="opacity:.65">Saves stay in this browser on this website. They do not sync between devices.</p>`;
}


/** Container retrieval moves the same item; unlike world pickup it does not create another theft report. */
export function transferToInventory(w: World, it: WorldItem): boolean {
  if (it.inWorld || it.location !== 'storage' || w.inventory.slots.includes(it) || !pickupEligible(w, it)) return false;
  const slot = freeSlot(w);
  if (slot < 0) return false;
  it.location = 'inventory'; w.inventory.slots[slot] = it;
  if (!selectedItem(w)) w.inventory.selected = slot;
  w.inventory.shownKey = '';
  return true;
}
