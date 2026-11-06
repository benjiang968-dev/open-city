// The shared texture library: CC0 photo-based PBR sets (ambientCG and cgbookcase; sources, licences and changes in
// ASSET_SOURCES.md) that replace the procedural bake of a surface layer (render/texLibrary.ts). Each set is three WebP
// files (colour sRGB 1024 px, OpenGL normal map, roughness greyscale) bundled by Vite (no run-time fetch from any third
// party). If a file fails to load, its layer keeps the procedural bake (render/bakeShaders.ts): the game never depends
// on these files being present.
//
// Physical scale: `tile` is the real-world size (m) one image covers, measured on the image (brick courses and lengths
// against the 215 x 65 mm brick with 10 mm joints of surfaces.ts BRICK, setts, slabs, siding boards, slates), so a brick
// is the same size on every wall and next to every door. The layer's surfaces are scaled to it (look.ts).
//
// Colour: `mean` (sRGB hex) re-centres the image on that average colour, keeping its own variation (per channel,
// relative), so a surface's palette tint still means the same thing; `contrast` scales the variation around the
// mean (1 = as photographed, <1 = calmer). `normal` scales the normal map's slopes, `rough` = [scale, offset] of the
// roughness map. `tintMask`: 'all' tints every texel by the palette colour, 'brick' only the saturated brick faces (not
// the mortar), 'none' never; `tint` scales how strongly (the procedural bricks were drawn around one reference red, so
// the per-building palette swung them a long way; a photographed brick already has its own colour).
import type { BakeLayer } from '../systems/render/surfaces';

export interface TextureSet {
  /** library id (ambientCG / cgbookcase asset id) */
  id: string;
  layer: BakeLayer;
  col: string;
  nrm: string;
  rgh: string;
  /** metres covered by one image [u, v] */
  tile: [number, number];
  /** sRGB hex the image's average is moved to; null keeps the photographed average */
  mean: number | null;
  contrast: number;
  normal: number;
  rough: [number, number];
  tintMask: 'all' | 'brick' | 'none';
  tint: number;
}

const u = (f: string) => new URL(`../assets/textures/${f}`, import.meta.url).href;
const set = (id: string, layer: BakeLayer, tile: number | [number, number], o: Partial<TextureSet> = {}): TextureSet => ({
  id, layer, col: u(`${id}_col.webp`), nrm: u(`${id}_nrm.webp`), rgh: u(`${id}_rgh.webp`),
  tile: typeof tile === 'number' ? [tile, tile] : tile, mean: null, contrast: 1, normal: 1, rough: [1, 0], tintMask: 'all', tint: 1, ...o,
});

/** One set per layer at most. Layers not listed keep their procedural bake (paint, pavers, Flemish and painted brick,
 * ashlar stone, wood, painted metal, standing seam, roof felt, canvas, bark, leaves, water). */
export const TEXTURE_SETS: TextureSet[] = [
  // Roads: fine dark aggregate, re-centred on a weathered mid-dark grey (linear albedo ~0.085) and calmed to about 13 %
  // texel contrast (the procedural asphalt was 74 %: the "salt and pepper" of the audit). 1 px = 3 mm at 1024.
  set('Asphalt010', 'asphalt', 3, { mean: 0x525457, contrast: 0.6, normal: 0.8, rough: [0.95, 0.05] }),
  // Sidewalk slabs: 4 rows of slabs per image -> 0.75 m slabs on a 3 m tile.
  set('PavingStones029', 'concreteSlab', 3, { mean: 0xb7b2a9, contrast: 0.9 }),
  // Granite kerbs, sills, steps: speckled grey stone.
  set('Concrete003', 'granite', 1.5, { mean: 0xa3a29c, contrast: 0.8, rough: [0.9, 0] }),
  // Granite setts (O St, alleys): 12 courses of ~0.11 m setts.
  set('PavingStones070', 'sett', 1.4, { mean: 0x7d7268, contrast: 0.85 }),
  // Lawns and verges (also the grass half of the terrain).
  set('Grass001', 'grass', 2.5, { mean: 0x5a7b3d, contrast: 0.8 }),
  // Soil (tree pits, worn ground, the soil half of the terrain).
  set('Ground036', 'soil', 2.5, { mean: 0x7f6a52, contrast: 0.85 }),
  // Towpath and park paths.
  set('Gravel006', 'gravel', 2, { mean: 0xb5a588, contrast: 0.8 }),
  // Galvanised and bare steel (rails, posts, signal poles).
  set('Metal003', 'metalBare', 1.5, { contrast: 0.45, normal: 0.5, rough: [0.7, 0.3] }),
  // Cast concrete (bridges, modern walls, plinths).
  set('Concrete034', 'concrete', 3, { mean: 0xb3afa6 }),
  // Red brick, running bond: 16 courses (75 mm: 65 mm brick + 10 mm joint) by 4 bricks; the photographed bricks are
  // long (Norman size), so the image is compressed to 0.9 m across to give 215 mm bricks.
  set('Bricks059', 'brickRunning', [0.9, 1.2], { tintMask: 'brick', tint: 0.35, normal: 0.9 }),
  // Old hand-made brick in header and stretcher courses: 12 courses by 3.75 stretchers, true to scale at 0.9 m.
  set('Bricks023', 'brickCommon', [0.9, 0.9], { tintMask: 'brick', tint: 0.35, contrast: 0.9, normal: 0.9 }),
  // Lime stucco and render (white; tinted by the building's colour).
  set('WhiteStuccoWall01', 'stucco', 2, { mean: 0xd6d4ce, normal: 0.8 }),
  // Painted clapboard: 16 boards of 0.15 m per image (tinted by the building's colour).
  set('WoodSiding009', 'clapboard', 2.4, { mean: 0xd9d7d0, contrast: 0.7 }),
  // Slate roofs: 16 courses of 0.15 m.
  set('RoofingTiles003', 'slate', 2.4, { mean: 0x4a4f57, contrast: 0.9 }),
];
