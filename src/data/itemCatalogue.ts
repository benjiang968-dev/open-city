/** Shared portable-object catalogue. Existing IDs and order are a save compatibility contract: append only. */
export const ITEM_IDS = ['bottle', 'can', 'bag', 'box', 'cone', 'brick', 'wrench', 'bat', 'book', 'notebook', 'mug', 'apple', 'sandwich', 'phone', 'screwdriver'] as const;
export type ItemId = typeof ITEM_IDS[number];
export interface ItemDefinition {
  name: string;
  description: string;
  mass: number;
  throwable: boolean;
  heavy: boolean;
  hitDamage: number;
  melee?: { damage: number; reach: number; cooldown: number; dent: number };
  use?: { kind: 'food'; heal: number } | { kind: 'read'; text: string } | { kind: 'clock' };
}
export const ITEM_DEFINITIONS: Record<ItemId, ItemDefinition> = {
  bottle: { name: 'Glass bottle', description: 'A reusable glass drinks bottle. A sealed bottle contains a drink; an opened one is empty.', mass: 0.4, throwable: true, heavy: false, hitDamage: 8 },
  can: { name: 'Drink can', description: 'A small aluminium drinks can. Sealed stock contains a drink; street litter is empty.', mass: 0.3, throwable: true, heavy: false, hitDamage: 4 },
  bag: { name: 'Rubbish bag', description: 'A tied, one-hand rubbish bag. Shift bags belong at the marked disposal point.', mass: 1.5, throwable: true, heavy: false, hitDamage: 2 },
  box: { name: 'Cardboard box', description: 'A portable taped carton. Labelled shift parcels must reach their work destination as this same object.', mass: 0.8, throwable: true, heavy: false, hitDamage: 3 },
  cone: { name: 'Traffic cone', description: 'A small portable safety cone with a rubber base.', mass: 1.2, throwable: true, heavy: false, hitDamage: 5 },
  brick: { name: 'Brick', description: 'A loose masonry brick: small enough for one hand, but heavy in a full inventory.', mass: 2.5, throwable: true, heavy: true, hitDamage: 34 },
  wrench: { name: 'Wrench', description: 'A steel wrench. The office maintenance shift supplies one for its repair panels.', mass: 1.0, throwable: false, heavy: true, hitDamage: 20, melee: { damage: 24, reach: 1.5, cooldown: 0.55, dent: 0.1 } },
  bat: { name: 'Baseball bat', description: 'A wooden baseball bat with a wrapped grip.', mass: 0.9, throwable: false, heavy: true, hitDamage: 18, melee: { damage: 32, reach: 1.9, cooldown: 0.7, dent: 0.16 } },
  book: { name: 'Canal field guide', description: 'A pocket guide to the neighbourhood, with a dark blue cloth cover.', mass: 0.32, throwable: true, heavy: false, hitDamage: 2, use: { kind: 'read', text: 'Canal field guide: M Street follows the old canal. The waterfront promenade lies south of K Street. Teal-marked doors welcome visitors.' } },
  notebook: { name: 'Route notebook', description: 'A small green notebook containing work and exploration notes.', mass: 0.18, throwable: true, heavy: false, hitDamage: 1, use: { kind: 'read', text: 'Route notes: press J to find neighbourhood work. Dispatch parcels go from the warehouse to the café. The office pays for three repaired panels.' } },
  mug: { name: 'Ceramic mug', description: 'An empty ceramic mug with a solid handle. Keep it, move it to a table, or store it at home.', mass: 0.28, throwable: true, heavy: false, hitDamage: 3 },
  apple: { name: 'Apple', description: 'A fresh apple. Eating it restores a little health and consumes this one item.', mass: 0.16, throwable: true, heavy: false, hitDamage: 1, use: { kind: 'food', heal: 8 } },
  sandwich: { name: 'Wrapped sandwich', description: 'A fresh sandwich. Eating it restores health and consumes this one item.', mass: 0.24, throwable: true, heavy: false, hitDamage: 1, use: { kind: 'food', heal: 16 } },
  phone: { name: 'Pocket phone', description: 'A simple offline pocket phone with a working clock and position display. It needs no account or network.', mass: 0.18, throwable: true, heavy: false, hitDamage: 2, use: { kind: 'clock' } },
  screwdriver: { name: 'Screwdriver', description: 'A small steel screwdriver with a red rubber grip. Portable workshop equipment.', mass: 0.22, throwable: true, heavy: false, hitDamage: 4 },
};
