import type { ItemId } from './itemCatalogue';
import type { InteriorKind } from './interiorDefs';

/** Stable semantic slot keys, local X/Z and support surface top in metres. Append slots; do not rename old keys. */
export interface InteriorContent { key: string; type: ItemId; x: number; z: number; supportY: number; price?: number; withoutUpstairs?: { x: number; z: number; supportY: number } }
const shelves = (name: string, x: number, z: number, width: number, stock: readonly ItemId[], sale = false): InteriorContent[] => {
  const out: InteriorContent[] = [];
  for (let tier = 0; tier < 3; tier++) for (let column = 0; column < 3; column++) {
    const type = stock[(tier * 3 + column) % stock.length];
    out.push({ key: `${name}/${tier}/${column}`, type, x: x + (column - 1) * (width - 0.5) / 2, z,
      supportY: [0.195, 0.845, 1.495][tier], price: sale ? ({ apple: 3, sandwich: 6, book: 8, notebook: 4, mug: 5, phone: 30, screwdriver: 8 } as Partial<Record<ItemId, number>>)[type] ?? 5 : undefined });
  }
  return out;
};
export const INTERIOR_CONTENTS: Record<InteriorKind, readonly InteriorContent[]> = {
  shop: [
    ...shelves('shelf-west-back', -3.9, -2.1, 1.7, ['apple', 'sandwich', 'mug'], true),
    ...shelves('shelf-west-front', -3.9, 1.2, 1.7, ['book', 'notebook', 'mug'], true),
    ...shelves('shelf-east-back', 3.9, -2.1, 1.7, ['sandwich', 'apple', 'mug'], true),
    ...shelves('shelf-east-front', 3.9, 1.2, 1.7, ['notebook', 'book', 'phone'], true),
  ],
  cafe: [
    { key: 'counter-sandwich', type: 'sandwich', x: -1.8, z: -4.7, supportY: 1.04, price: 6 },
    { key: 'counter-apple', type: 'apple', x: -2.2, z: -4.5, supportY: 1.04, price: 3 },
    ...[-2.8, 2.8].flatMap((x, xi) => [-1.8, 2.1].flatMap((z, zi) => [
      { key: `table/${xi}/${zi}/mug`, type: 'mug' as const, x: x - 0.17, z, supportY: 0.83 },
      { key: `table/${xi}/${zi}/food`, type: 'sandwich' as const, x: x + 0.17, z, supportY: 0.83, price: 6 },
    ])),
  ],
  office: [
    ...shelves('filing-shelf', -3.5, 3.4, 1.8, ['book', 'notebook', 'mug']),
    { key: 'desk-back-phone', type: 'phone', x: -2.2, z: -3.8, supportY: 0.83 },
    { key: 'desk-back-notes', type: 'notebook', x: -3.2, z: -3.8, supportY: 0.83 },
    { key: 'desk-front-mug', type: 'mug', x: -2.2, z: -0.3, supportY: 0.83 },
    { key: 'upstairs-notes', type: 'book', x: -2, z: -2, supportY: 4.03, withoutUpstairs: { x: -3.2, z: -0.3, supportY: 0.83 } },
  ],
  workshop: [
    ...shelves('tool-shelf', 3.7, -3.5, 1.7, ['screwdriver', 'wrench', 'notebook']),
    { key: 'bench-driver', type: 'screwdriver', x: -1.5, z: -4.7, supportY: 0.83 },
    { key: 'bench-guide', type: 'book', x: -2.9, z: -4.5, supportY: 0.83 },
    { key: 'work-table-phone', type: 'phone', x: 2.8, z: 1.4, supportY: 0.83 },
  ],
  warehouse: [
    ...shelves('west-back', -3.8, -3.7, 1.6, ['box', 'screwdriver', 'notebook']),
    ...shelves('west-front', -3.8, 0, 1.6, ['box', 'book', 'mug']),
    ...shelves('east-back', 3.8, -3.7, 1.6, ['box', 'screwdriver', 'notebook']),
    ...shelves('east-front', 3.8, 0, 1.6, ['box', 'book', 'mug']),
    { key: 'dispatch-phone', type: 'phone', x: -0.7, z: -4.8, supportY: 0.83 },
  ],
  apartment: [
    ...shelves('living-bookshelf', -3, -2.8, 2.4, ['book', 'notebook', 'mug']),
    { key: 'coffee-table-book', type: 'book', x: -2.9, z: 1.7, supportY: 0.83 },
    { key: 'coffee-table-phone', type: 'phone', x: -2.3, z: 1.7, supportY: 0.83 },
    { key: 'kitchen-apple', type: 'apple', x: -2.6, z: -4.9, supportY: 1.04 },
    { key: 'dining-mug', type: 'mug', x: 0.5, z: -2, supportY: 0.83 },
    { key: 'bedroom-notebook', type: 'notebook', x: -3.5, z: 1, supportY: 4.24, withoutUpstairs: { x: -3.5, z: 3.6, supportY: 1.04 } },
  ],
};
