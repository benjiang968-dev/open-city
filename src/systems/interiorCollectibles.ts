/** Authored room goods use the same registry, physical bodies and inventory path as street litter. */
import type { World } from '../world';
import { INTERIOR_CONTENTS } from '../data/interiorContents';
import { spawnItem, placeInWorld } from './worldItems';

/** Call after legacy stock AND stable job pools, before loading saves. Existing published numeric IDs never move. */
export function seedInteriorCollectibles(w: World): void {
  const existing = new Set(w.itemsState.items.map(it => it.authoredKey).filter(Boolean));
  for (const entry of w.interiors.entries) for (const spec of INTERIOR_CONTENTS[entry.kind]) {
    const key = `interior-v2/${entry.id}/${spec.key}`;
    if (existing.has(key)) continue;
    const at = !entry.upstairs && spec.withoutUpstairs ? spec.withoutUpstairs : spec;
    const item = spawnItem(w, spec.type, entry.origin.x + at.x, entry.origin.z + at.z, 0);
    if (!item) throw new Error(`Cannot register room object ${key}`);
    item.authoredKey = key;
    const x = entry.origin.x + at.x, z = entry.origin.z + at.z;
    const y = entry.origin.y + at.supportY + w.itemsState.art[spec.type].restY + 0.005;
    placeInWorld(w, item, x, y, z, 0, 0, 0, 0);
    item.body.setAngvel({ x: 0, y: 0, z: 0 }, false); item.body.sleep();
    if (spec.price && (entry.kind === 'shop' || entry.kind === 'cafe')) { item.owner = entry.id; item.price = spec.price; }
    existing.add(key);
  }
}
