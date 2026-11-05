// Surface ids for the generators' existing palette colours. Most world geometry is drawn with fixed palette colours
// (meshKit lin(0xRRGGBB)); rather than editing every generator call, MeshBuf.toGeometry() looks an untagged colour up
// here (exact match on the packed linear colour, then the nearest entry within a small distance, so shade() variants
// follow their base colour). Explicitly tagged colours (surf()) always win. Facade wall and roof palettes go through
// facadeColour(), which the facade generator uses for its building colours.
import { SURF, surf } from './surfaces';

/** sRGB hex to packed linear bytes (same as meshKit lin(); kept here so meshKit can import this module). */
function lin(hex: number): number {
  const ch = (v: number) => { const c = v / 255; return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); };
  return (ch((hex >> 16) & 255) << 16) | (ch((hex >> 8) & 255) << 8) | ch(hex & 255);
}

/** sRGB hex -> surface, grouped by what the generators draw with them. */
const TABLE: [number, number][] = [
  // bridges (Key Bridge, freeway, footbridges, stairs)
  [0xd3c8b2, SURF.CONCRETE], [0xb6ab95, SURF.CONCRETE], [0xb3afa6, SURF.CONCRETE], [0x96928a, SURF.CONCRETE],
  [0x5f6b66, SURF.METAL_PAINT], [0x4a5450, SURF.METAL_PAINT], [0x9d9387, SURF.STONE], [0x857c71, SURF.STONE],
  [0xc9c3b6, SURF.GRANITE], [0xb0a89b, SURF.STONE], [0x2b2e31, SURF.METAL_PAINT],
  // waterworks (canal walls, towpath, piers, boardwalk, plaza, boats)
  [0xaaa397, SURF.STONE], [0xb9b3a6, SURF.GRANITE], [0xc2ad86, SURF.GRAVEL], [0x7aa257, SURF.GRASS], [0x8c6440, SURF.WOOD],
  [0x5e4128, SURF.WOOD], [0x2f3236, SURF.METAL_PAINT], [0xc8bba5, SURF.CONCRETE_SLAB], [0xa89c88, SURF.CONCRETE_SLAB],
  [0x8e8b86, SURF.GRANITE], [0xf4f1e8, SURF.METAL_PAINT], [0xd94f3d, SURF.METAL_PAINT], [0x2f5d8a, SURF.METAL_PAINT],
  [0x2e7d5b, SURF.METAL_PAINT], [0xf2c14e, SURF.METAL_PAINT], [0xf2f2ee, SURF.METAL_PAINT],
  // props (lamps, benches, signals, signs, shelters, gravestones, tree pits)
  [0x22282b, SURF.METAL_PAINT], [0x26292c, SURF.METAL_PAINT], [0x2a2c1e, SURF.METAL_PAINT], [0x3a4046, SURF.METAL_PAINT],
  [0x4d555c, SURF.METAL_PAINT], [0x6d7276, SURF.METAL_BARE], [0x9a9ea2, SURF.METAL_BARE], [0x8a5a36, SURF.WOOD],
  [0xbfbcb4, SURF.GRANITE], [0xa9a69e, SURF.GRANITE], [0x4a3a2c, SURF.SOIL], [0x6b4a2f, SURF.BARK],
  [0xc3201f, SURF.METAL_PAINT], [0xd9b52b, SURF.METAL_PAINT], [0xf4f4f0, SURF.METAL_PAINT], [0x1f5c9a, SURF.METAL_PAINT],
  // monuments
  [0x24272a, SURF.METAL_PAINT], [0xa69f92, SURF.STONE], [0x8f8b85, SURF.GRANITE], [0x5b6166, SURF.METAL_BARE],
  [0xb8b3a8, SURF.GRANITE], [0xd9d4c8, SURF.ASHLAR], [0x4f5f52, SURF.METAL_BARE], [0x3c4a40, SURF.METAL_BARE],
  [0x2b2d30, SURF.ASPHALT], [0x55585c, SURF.METAL_PAINT], [0x4a3b30, SURF.WOOD], [0xf2eee2, SURF.TRIM],
  // facade details drawn with fixed colours (cornices, sills, stoops, rails, canopies, chimneys, plant, spires)
  [0xf2efe6, SURF.TRIM], [0xe9e4d8, SURF.ASHLAR], [0xcfc9bb, SURF.ASHLAR], [0xb8b1a4, SURF.STONE], [0x222428, SURF.METAL_PAINT],
  [0x1f2226, SURF.METAL_PAINT], [0x9a9c9e, SURF.METAL_BARE], [0x85878a, SURF.METAL_BARE], [0x8a857c, SURF.ROOF_TAR],
  [0x56636a, SURF.SLATE], [0x6c7275, SURF.SLATE], [0x5f9c86, SURF.METAL_SEAM], [0x6f8f86, SURF.METAL_SEAM],
  [0x4a5560, SURF.SLATE], [0x5f8f7c, SURF.METAL_SEAM], [0x8c7f70, SURF.CONCRETE], [0x9b5a45, SURF.BRICK_RUNNING],
  [0x7d4636, SURF.BRICK_RUNNING], [0xe9e1d0, SURF.ASHLAR], [0xf3f0e8, SURF.CONCRETE], [0xe2ded4, SURF.CONCRETE],
  [0xf4f1ea, SURF.ASHLAR], [0xd8d2c6, SURF.STONE], [0xe8e2d4, SURF.TRIM], [0xf4f1e6, SURF.TRIM],
  // tree crowns (props.ts GREENS / CONIFER: the far crowns get the leaf texture)
  [0x5c9e47, SURF.FOLIAGE], [0x4f8a3e, SURF.FOLIAGE], [0x76b051, SURF.FOLIAGE], [0x3f7a3a, SURF.FOLIAGE], [0x88b84b, SURF.FOLIAGE],
  [0x6aa04a, SURF.FOLIAGE], [0x3b6b45, SURF.FOLIAGE], [0x2f5e3c, SURF.FOLIAGE], [0x46784c, SURF.FOLIAGE],
];

/** Facade wall and roof palette colours (facades.ts ROW_COLOURS, BRICK, STONE, MODERN, ROOF_*, AWNINGS, landmarks). */
const FACADE: [number, number][] = [
  [0xad5844, SURF.BRICK_RUNNING], [0xb8664e, SURF.BRICK_RUNNING], [0x9e4c3c, SURF.BRICK_RUNNING], [0xc2735a, SURF.BRICK_RUNNING],
  [0x94503f, SURF.BRICK_RUNNING], [0xbf7a5c, SURF.BRICK_RUNNING], [0xa86b55, SURF.BRICK_RUNNING], [0x9b4a3b, SURF.BRICK_RUNNING],
  [0xa1503d, SURF.BRICK_RUNNING],
  [0xead48f, SURF.BRICK_PAINTED], [0xf0e3c4, SURF.BRICK_PAINTED], [0xa9c2d4, SURF.BRICK_PAINTED], [0xa7c4a2, SURF.BRICK_PAINTED],
  [0xe7b9b4, SURF.BRICK_PAINTED], [0xc9b9d8, SURF.BRICK_PAINTED], [0xf3efe6, SURF.BRICK_PAINTED], [0xe9c79c, SURF.BRICK_PAINTED],
  [0x9fb4a0, SURF.BRICK_PAINTED], [0xd9a98d, SURF.BRICK_PAINTED],
  [0xc9bfae, SURF.ASHLAR], [0xd6ccba, SURF.ASHLAR], [0xb9b09f, SURF.ASHLAR], [0xa79f92, SURF.ASHLAR], [0x8f9290, SURF.ASHLAR],
  [0xa89a86, SURF.STONE], [0xe2cda6, SURF.ASHLAR],
  [0xd8cdb6, SURF.STUCCO], [0xc8c2b5, SURF.STUCCO], [0xb8b4ab, SURF.CONCRETE], [0xe0d8c4, SURF.STUCCO], [0x9ea4a6, SURF.CONCRETE],
  [0xefebe2, SURF.STUCCO], [0xe6e1d6, SURF.STUCCO], [0xeedfb5, SURF.STUCCO], [0xf0e6cf, SURF.STUCCO],
  [0xf1efe6, SURF.CLAPBOARD], [0xdfe7da, SURF.CLAPBOARD], [0xe8dcc4, SURF.CLAPBOARD],
  [0x8d8a84, SURF.ROOF_TAR], [0x9a958c, SURF.ROOF_TAR], [0x7e7b76, SURF.ROOF_TAR], [0xa39c90, SURF.ROOF_TAR], [0x8f5a4a, SURF.ROOF_TAR],
  [0x6f7f72, SURF.ROOF_TAR], [0xa6aaae, SURF.ROOF_TAR],
  [0x4a4f57, SURF.SLATE], [0x55504b, SURF.SLATE], [0x3f4a52, SURF.SLATE], [0x6b4a3c, SURF.SLATE],
  [0x1f5c45, SURF.CANVAS], [0x7a2430, SURF.CANVAS], [0x23395b, SURF.CANVAS], [0x1c1c1f, SURF.CANVAS], [0xd8cfb8, SURF.CANVAS],
  [0xb5552e, SURF.CANVAS], [0xc79a2e, SURF.CANVAS], [0x4f6d3a, SURF.CANVAS],
];

function index(list: [number, number][]) {
  const exact = new Map<number, number>();
  const near: { r: number; g: number; b: number; s: number }[] = [];
  for (const [hex, s] of list) {
    const c = lin(hex);
    exact.set(c, s);
    near.push({ r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255, s });
  }
  return { exact, near };
}
const AUTO = index(TABLE);
const FAC = index(FACADE);

/** Facade building colour (sRGB hex) -> tagged packed linear colour. */
export function facadeColour(hex: number): number {
  const c = lin(hex);
  return surf(FAC.exact.get(c) ?? AUTO.exact.get(c) ?? SURF.BRICK_PAINTED, c);
}

/**
 * Surface for an untagged packed linear colour: exact palette match, else the nearest palette colour within ~6 %
 * per channel (shade() variants), else 0 (flat colour). Results are cached per colour by the caller.
 */
export function inferSurface(c: number): number {
  const e = AUTO.exact.get(c & 0xffffff);
  if (e !== undefined) return e;
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  let best = 0, bd = 1e9;
  for (const q of AUTO.near) {
    const lum = Math.max(q.r, q.g, q.b, 8);
    // compare chromaticity and brightness relative to the entry (shade() scales all channels)
    const k = (r + g + b) / Math.max(1, q.r + q.g + q.b);
    if (k < 0.7 || k > 1.25) continue;
    const d = (Math.abs(r - q.r * k) + Math.abs(g - q.g * k) + Math.abs(b - q.b * k)) / lum;
    if (d < bd) { bd = d; best = q.s; }
  }
  return bd < 0.18 ? best : 0;
}
