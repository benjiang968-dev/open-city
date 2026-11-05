// Furniture library for building interiors (systems/interiors/). Each piece is drawn from boxes in its own frame
// (x across its width, z out of its front toward the room, y up from the floor; the origin is the middle of its
// footprint on the floor) and gets one static box collider over its whole size when `solid` (beds, sofas, counters,
// shelves, tables, wardrobes...). Chairs, rugs and lamps are drawn only. `slots` are the places on it where small
// items (src/art/items.ts) are put: a row of `n` positions along x at height y, each holding one item picked from
// `items` by the building's seed. Item slots get stable ids from the building id, the furniture's place in the plan
// and the slot index, so picked-up items are remembered across visits and saves.
import type { ItemId } from '../art/items';

/** Surface names (render/surfaces.ts SURF keys) the builder tags part colours with. */
export type FurnSurface = 'WOOD' | 'METAL_PAINT' | 'METAL_BARE' | 'STUCCO' | 'CANVAS' | 'STONE' | 'CONCRETE' | 'TRIM' | 'RUBBER' | 'NONE';

export interface FurnPart {
  /** centre and half extents in the piece's frame (m) */
  c: readonly [number, number, number];
  h: readonly [number, number, number];
  /** sRGB colour */
  col: number;
  s: FurnSurface;
}
export interface FurnSlot {
  /** first position (x, y, z) and step along x */
  x: number; y: number; z: number; step: number; n: number;
  /** what may stand there (one is chosen per position) */
  items: readonly ItemId[];
  /** share of positions left empty (0..1) */
  gaps?: number;
}
export interface FurnDef {
  label: string;
  /** footprint width (x), depth (z) and height (m) */
  w: number; d: number; hgt: number;
  solid: boolean;
  parts: readonly FurnPart[];
  slots?: readonly FurnSlot[];
  /** emits light (a lamp shade): drawn with the light-fixture material */
  glow?: readonly FurnPart[];
}

const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: number, s: FurnSurface = 'WOOD'): FurnPart => ({ c: [cx, cy, cz], h: [hx, hy, hz], col, s });

const OAK = 0x9a7048, WALNUT = 0x5e4128, PINE = 0xc49a6c, WHITE = 0xece8df, GREY = 0x7d8288, DARK = 0x2f3236, STEEL = 0xa9adb1;
const FABRIC_BLUE = 0x46597a, FABRIC_GREEN = 0x5d6e4f, FABRIC_RED = 0x8a4a3e, LINEN = 0xd9d2c4;

export const FURNITURE = {
  // ---------------------------------------------------------------- living room
  sofa: {
    label: 'Sofa', w: 2.0, d: 0.9, hgt: 0.85, solid: true,
    parts: [box(0, 0.22, 0.05, 1.0, 0.22, 0.4, FABRIC_BLUE, 'CANVAS'), box(0, 0.55, -0.33, 1.0, 0.3, 0.12, FABRIC_BLUE, 'CANVAS'),
      box(-0.92, 0.42, 0.05, 0.08, 0.2, 0.4, FABRIC_BLUE, 'CANVAS'), box(0.92, 0.42, 0.05, 0.08, 0.2, 0.4, FABRIC_BLUE, 'CANVAS'),
      box(-0.45, 0.47, 0.08, 0.43, 0.06, 0.32, 0x52668a, 'CANVAS'), box(0.45, 0.47, 0.08, 0.43, 0.06, 0.32, 0x52668a, 'CANVAS')],
  },
  armchair: {
    label: 'Armchair', w: 0.85, d: 0.85, hgt: 0.85, solid: true,
    parts: [box(0, 0.22, 0.05, 0.42, 0.22, 0.38, FABRIC_GREEN, 'CANVAS'), box(0, 0.55, -0.32, 0.42, 0.3, 0.1, FABRIC_GREEN, 'CANVAS'),
      box(-0.36, 0.42, 0.05, 0.06, 0.2, 0.38, FABRIC_GREEN, 'CANVAS'), box(0.36, 0.42, 0.05, 0.06, 0.2, 0.38, FABRIC_GREEN, 'CANVAS')],
  },
  coffeeTable: {
    label: 'Coffee table', w: 1.1, d: 0.6, hgt: 0.42, solid: true,
    parts: [box(0, 0.4, 0, 0.55, 0.025, 0.3, WALNUT), box(-0.5, 0.19, -0.25, 0.03, 0.19, 0.03, WALNUT), box(0.5, 0.19, -0.25, 0.03, 0.19, 0.03, WALNUT),
      box(-0.5, 0.19, 0.25, 0.03, 0.19, 0.03, WALNUT), box(0.5, 0.19, 0.25, 0.03, 0.19, 0.03, WALNUT)],
    slots: [{ x: -0.3, y: 0.425, z: 0, step: 0.6, n: 2, items: ['mug', 'book', 'phone'], gaps: 0.3 }],
  },
  bookshelf: {
    label: 'Bookshelf', w: 1.0, d: 0.32, hgt: 1.9, solid: true,
    parts: [box(0, 0.95, -0.14, 0.5, 0.95, 0.02, OAK), box(-0.48, 0.95, 0, 0.02, 0.95, 0.16, OAK), box(0.48, 0.95, 0, 0.02, 0.95, 0.16, OAK),
      box(0, 0.04, 0, 0.5, 0.04, 0.16, OAK), box(0, 0.55, 0, 0.47, 0.015, 0.15, OAK), box(0, 1.05, 0, 0.47, 0.015, 0.15, OAK), box(0, 1.55, 0, 0.47, 0.015, 0.15, OAK),
      box(0, 1.89, 0, 0.5, 0.015, 0.16, OAK)],
    slots: [{ x: -0.36, y: 0.565, z: 0.02, step: 0.18, n: 5, items: ['book'], gaps: 0.2 }, { x: -0.36, y: 1.065, z: 0.02, step: 0.18, n: 5, items: ['book', 'book', 'jar'], gaps: 0.3 }],
  },
  tvUnit: {
    label: 'TV cabinet', w: 1.4, d: 0.42, hgt: 1.05, solid: true,
    parts: [box(0, 0.25, 0, 0.7, 0.25, 0.21, WALNUT), box(0, 0.78, -0.12, 0.55, 0.3, 0.025, 0x111214, 'METAL_PAINT'), box(0, 0.51, -0.12, 0.08, 0.02, 0.06, 0x111214, 'METAL_PAINT')],
    slots: [{ x: 0.55, y: 0.5, z: 0.05, step: 0.2, n: 1, items: ['phone', 'mug'] }],
  },
  floorLamp: {
    label: 'Floor lamp', w: 0.35, d: 0.35, hgt: 1.6, solid: false,
    parts: [box(0, 0.015, 0, 0.15, 0.015, 0.15, DARK, 'METAL_PAINT'), box(0, 0.75, 0, 0.015, 0.72, 0.015, DARK, 'METAL_PAINT')],
    glow: [box(0, 1.45, 0, 0.16, 0.14, 0.16, 0xf6e7c6, 'NONE')],
  },
  rug: { label: 'Rug', w: 2.0, d: 1.4, hgt: 0.01, solid: false, parts: [box(0, 0.005, 0, 1.0, 0.005, 0.7, FABRIC_RED, 'CANVAS')] },
  // ---------------------------------------------------------------- dining and kitchen
  diningTable: {
    label: 'Dining table', w: 1.5, d: 0.85, hgt: 0.76, solid: true,
    parts: [box(0, 0.74, 0, 0.75, 0.025, 0.425, OAK), box(-0.68, 0.36, -0.36, 0.035, 0.36, 0.035, OAK), box(0.68, 0.36, -0.36, 0.035, 0.36, 0.035, OAK),
      box(-0.68, 0.36, 0.36, 0.035, 0.36, 0.035, OAK), box(0.68, 0.36, 0.36, 0.035, 0.36, 0.035, OAK)],
    slots: [{ x: -0.45, y: 0.765, z: 0.1, step: 0.45, n: 3, items: ['mug', 'jar', 'book', 'phone'], gaps: 0.4 }],
  },
  chair: {
    label: 'Chair', w: 0.45, d: 0.45, hgt: 0.9, solid: false,
    parts: [box(0, 0.44, 0, 0.21, 0.025, 0.21, OAK), box(0, 0.68, -0.2, 0.21, 0.22, 0.02, OAK), box(-0.18, 0.21, -0.18, 0.02, 0.21, 0.02, OAK),
      box(0.18, 0.21, -0.18, 0.02, 0.21, 0.02, OAK), box(-0.18, 0.21, 0.18, 0.02, 0.21, 0.02, OAK), box(0.18, 0.21, 0.18, 0.02, 0.21, 0.02, OAK)],
  },
  kitchenRun: {
    label: 'Kitchen counter', w: 2.1, d: 0.62, hgt: 0.92, solid: true,
    parts: [box(0, 0.45, 0, 1.05, 0.45, 0.3, WHITE, 'TRIM'), box(0, 0.905, 0.01, 1.06, 0.02, 0.31, 0x3b3a38, 'STONE'),
      box(0.5, 0.92, 0.0, 0.28, 0.005, 0.22, STEEL, 'METAL_BARE'), // sink
      box(-0.62, 0.93, 0.02, 0.26, 0.01, 0.25, 0x1b1c1e, 'METAL_PAINT'), // hob
      box(0, 1.85, -0.12, 1.05, 0.35, 0.18, WHITE, 'TRIM')], // wall cupboards
    slots: [{ x: -0.25, y: 0.925, z: -0.12, step: 0.17, n: 4, items: ['mug', 'mug', 'jar', 'cereal', 'milk', 'tin'], gaps: 0.25 }],
  },
  fridge: {
    label: 'Fridge', w: 0.65, d: 0.65, hgt: 1.85, solid: true,
    parts: [box(0, 0.925, 0, 0.325, 0.925, 0.325, 0xe6e7e4, 'METAL_PAINT'), box(0.26, 1.15, 0.33, 0.015, 0.25, 0.01, STEEL, 'METAL_BARE')],
  },
  // ---------------------------------------------------------------- bedrooms and bathroom
  bedDouble: {
    label: 'Double bed', w: 1.5, d: 2.05, hgt: 0.55, solid: true,
    parts: [box(0, 0.2, 0, 0.75, 0.2, 1.02, WALNUT), box(0, 0.47, 0.05, 0.72, 0.08, 0.95, LINEN, 'CANVAS'), box(0, 0.45, 0.35, 0.73, 0.1, 0.6, 0x7b8fa8, 'CANVAS'),
      box(0, 0.62, -0.75, 0.6, 0.07, 0.18, 0xf2efe8, 'CANVAS'), box(0, 0.6, -1.0, 0.75, 0.4, 0.03, WALNUT)],
  },
  bedSingle: {
    label: 'Single bed', w: 0.95, d: 2.0, hgt: 0.55, solid: true,
    parts: [box(0, 0.2, 0, 0.47, 0.2, 1.0, PINE), box(0, 0.47, 0.05, 0.45, 0.08, 0.93, LINEN, 'CANVAS'), box(0, 0.45, 0.35, 0.46, 0.1, 0.6, 0x8a6f9e, 'CANVAS'),
      box(0, 0.6, -0.98, 0.47, 0.35, 0.03, PINE)],
  },
  nightstand: {
    label: 'Bedside table', w: 0.45, d: 0.4, hgt: 0.55, solid: true,
    parts: [box(0, 0.275, 0, 0.225, 0.275, 0.2, WALNUT)],
    slots: [{ x: 0, y: 0.55, z: 0, step: 0.2, n: 1, items: ['book', 'phone', 'mug'] }],
    glow: [box(0.12, 0.7, -0.08, 0.08, 0.09, 0.08, 0xf6e7c6, 'NONE')],
  },
  wardrobe: {
    label: 'Wardrobe', w: 1.2, d: 0.6, hgt: 2.0, solid: true,
    parts: [box(0, 1.0, 0, 0.6, 1.0, 0.3, OAK), box(0, 1.0, 0.305, 0.005, 0.95, 0.005, WALNUT), box(-0.05, 1.05, 0.31, 0.01, 0.08, 0.01, STEEL, 'METAL_BARE'), box(0.05, 1.05, 0.31, 0.01, 0.08, 0.01, STEEL, 'METAL_BARE')],
  },
  desk: {
    label: 'Desk', w: 1.2, d: 0.6, hgt: 0.75, solid: true,
    parts: [box(0, 0.73, 0, 0.6, 0.02, 0.3, OAK), box(-0.56, 0.36, 0, 0.03, 0.36, 0.28, OAK), box(0.4, 0.36, 0, 0.2, 0.36, 0.28, OAK)],
    slots: [{ x: -0.35, y: 0.75, z: 0.05, step: 0.35, n: 3, items: ['book', 'mug', 'phone', 'book'], gaps: 0.3 }],
  },
  bath: {
    label: 'Bath', w: 1.7, d: 0.75, hgt: 0.58, solid: true,
    parts: [box(0, 0.29, 0, 0.85, 0.29, 0.375, 0xf4f4f0, 'METAL_PAINT'), box(0, 0.56, 0, 0.76, 0.02, 0.3, 0xdfe6ea, 'METAL_PAINT')],
  },
  toilet: {
    label: 'Toilet', w: 0.4, d: 0.65, hgt: 0.8, solid: true,
    parts: [box(0, 0.2, 0.05, 0.18, 0.2, 0.25, 0xf4f4f0, 'METAL_PAINT'), box(0, 0.42, 0.07, 0.19, 0.02, 0.24, 0xf4f4f0, 'METAL_PAINT'), box(0, 0.6, -0.24, 0.19, 0.2, 0.08, 0xf4f4f0, 'METAL_PAINT')],
  },
  basin: {
    label: 'Wash basin', w: 0.6, d: 0.45, hgt: 0.88, solid: true,
    parts: [box(0, 0.4, -0.05, 0.08, 0.4, 0.08, 0xf4f4f0, 'METAL_PAINT'), box(0, 0.83, 0, 0.3, 0.05, 0.22, 0xf4f4f0, 'METAL_PAINT'), box(0, 1.45, -0.21, 0.25, 0.3, 0.01, 0xc9d3d8, 'METAL_BARE')],
  },
  // ---------------------------------------------------------------- shop
  counter: {
    label: 'Shop counter', w: 2.2, d: 0.65, hgt: 1.0, solid: true,
    parts: [box(0, 0.48, 0, 1.1, 0.48, 0.325, 0x6f4a32), box(0, 0.98, 0, 1.13, 0.02, 0.34, 0x2e2a26, 'STONE'),
      box(0.6, 1.1, 0, 0.18, 0.1, 0.14, 0x1d1f22, 'METAL_PAINT'), box(0.6, 1.26, -0.06, 0.16, 0.08, 0.015, 0x1d1f22, 'METAL_PAINT')], // the till
  },
  gondola: {
    label: 'Shelving unit', w: 3.0, d: 0.9, hgt: 1.5, solid: true,
    parts: [box(0, 0.75, 0, 1.5, 0.75, 0.04, GREY, 'METAL_PAINT'), box(0, 0.06, 0, 1.5, 0.06, 0.45, DARK, 'METAL_PAINT'),
      box(0, 0.52, 0, 1.48, 0.015, 0.44, GREY, 'METAL_PAINT'), box(0, 0.98, 0, 1.48, 0.015, 0.44, GREY, 'METAL_PAINT'), box(0, 1.47, 0, 1.5, 0.03, 0.2, GREY, 'METAL_PAINT'),
      box(-1.49, 0.75, 0, 0.015, 0.75, 0.45, GREY, 'METAL_PAINT'), box(1.49, 0.75, 0, 0.015, 0.75, 0.45, GREY, 'METAL_PAINT')],
    slots: [
      { x: -1.26, y: 0.535, z: 0.24, step: 0.36, n: 8, items: ['tin', 'tin', 'jar', 'cereal', 'chips'], gaps: 0.15 },
      { x: -1.26, y: 0.995, z: 0.24, step: 0.36, n: 8, items: ['cereal', 'chips', 'bottle', 'can'], gaps: 0.15 },
      { x: -1.26, y: 0.535, z: -0.24, step: 0.36, n: 8, items: ['tin', 'jar', 'milk', 'can'], gaps: 0.15 },
      { x: -1.26, y: 0.995, z: -0.24, step: 0.36, n: 8, items: ['bottle', 'can', 'chips', 'cereal'], gaps: 0.15 },
    ],
  },
  wallShelf: {
    label: 'Wall shelving', w: 2.4, d: 0.45, hgt: 1.8, solid: true,
    parts: [box(0, 0.9, -0.21, 1.2, 0.9, 0.02, GREY, 'METAL_PAINT'), box(0, 0.06, 0, 1.2, 0.06, 0.225, DARK, 'METAL_PAINT'),
      box(0, 0.62, 0, 1.18, 0.015, 0.22, GREY, 'METAL_PAINT'), box(0, 1.12, 0, 1.18, 0.015, 0.22, GREY, 'METAL_PAINT'), box(0, 1.62, 0, 1.18, 0.015, 0.22, GREY, 'METAL_PAINT'),
      box(-1.19, 0.9, 0, 0.015, 0.9, 0.225, GREY, 'METAL_PAINT'), box(1.19, 0.9, 0, 0.015, 0.9, 0.225, GREY, 'METAL_PAINT')],
    slots: [
      { x: -1.0, y: 0.635, z: 0.03, step: 0.28, n: 8, items: ['jar', 'tin', 'cereal'], gaps: 0.2 },
      { x: -1.0, y: 1.135, z: 0.03, step: 0.28, n: 8, items: ['bottle', 'jar', 'chips'], gaps: 0.2 },
    ],
  },
  drinksFridge: {
    label: 'Drinks fridge', w: 1.3, d: 0.7, hgt: 2.0, solid: true,
    parts: [box(0, 1.0, -0.05, 0.65, 1.0, 0.3, 0xe9ebec, 'METAL_PAINT'), box(0, 1.85, 0.3, 0.6, 0.12, 0.02, 0x2f5d8a, 'METAL_PAINT'),
      box(0, 0.62, 0.05, 0.6, 0.012, 0.25, STEEL, 'METAL_BARE'), box(0, 1.12, 0.05, 0.6, 0.012, 0.25, STEEL, 'METAL_BARE')],
    glow: [box(0, 1.0, 0.33, 0.6, 0.8, 0.01, 0xdff2ff, 'NONE')],
    slots: [
      { x: -0.48, y: 0.632, z: 0.08, step: 0.24, n: 5, items: ['milk', 'can', 'bottle'] },
      { x: -0.48, y: 1.132, z: 0.08, step: 0.24, n: 5, items: ['can', 'bottle'] },
    ],
  },
  stockBoxes: {
    label: 'Stock boxes', w: 1.2, d: 0.8, hgt: 1.1, solid: true,
    parts: [box(-0.3, 0.3, 0, 0.3, 0.3, 0.4, 0xc69c6d, 'NONE'), box(0.3, 0.3, 0, 0.3, 0.3, 0.4, 0xb8895a, 'NONE'), box(0, 0.85, 0.05, 0.4, 0.25, 0.3, 0xc69c6d, 'NONE')],
  },
  officeDesk: {
    label: 'Office desk', w: 1.6, d: 0.8, hgt: 0.75, solid: true,
    parts: [box(0, 0.73, 0, 0.8, 0.02, 0.4, 0xd8d2c6, 'TRIM'), box(-0.76, 0.36, 0, 0.03, 0.36, 0.38, GREY, 'METAL_PAINT'), box(0.76, 0.36, 0, 0.03, 0.36, 0.38, GREY, 'METAL_PAINT'),
      box(0.2, 0.98, -0.25, 0.3, 0.2, 0.02, 0x111214, 'METAL_PAINT')],
    slots: [{ x: -0.5, y: 0.75, z: 0.1, step: 0.35, n: 3, items: ['mug', 'phone', 'book'], gaps: 0.3 }],
  },
  filing: {
    label: 'Filing cabinet', w: 0.5, d: 0.6, hgt: 1.3, solid: true,
    parts: [box(0, 0.65, 0, 0.25, 0.65, 0.3, GREY, 'METAL_PAINT')],
  },
} as const satisfies Record<string, FurnDef>;

export type FurnId = keyof typeof FURNITURE;
