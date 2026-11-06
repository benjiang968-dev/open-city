// Surface registry for the PBR look: every material the world generators can ask for (asphalt, brick sidewalk, granite
// kerb, brick in three bonds, slate...), with the layer its procedural maps are baked into (texBake.ts), its real-world
// tile size, how it is projected onto merged geometry that has no UVs, and its reference colour.
//
// Generators pick a surface by tagging a palette colour: surf(SURF.ASPHALT, lin(0x4b4e54)) stores the surface id in the
// top byte of the packed colour, MeshBuf writes it into the aSurf vertex attribute, and the world material
// (worldMaterial.ts) samples that surface's maps. The colour itself becomes a tint relative to the surface's reference
// colour, so per-building colour choices keep working on top of realistic textures. An untagged colour (id 0) is drawn
// as before, flat vertex colour with a little macro variation.

/** Surface ids (0..127; 0 = untagged). Order matters only for the bake layer (LAYER below). */
export const SURF = {
  NONE: 0,
  ASPHALT: 1,
  PAINT: 2,
  CONCRETE_SLAB: 3,
  BRICK_PAVER: 4,
  GRANITE: 5,
  SETT: 6,
  GRASS: 7,
  SOIL: 8,
  GRAVEL: 9,
  BARK: 10,
  FOLIAGE: 11,
  WOOD: 12,
  METAL_PAINT: 13,
  METAL_BARE: 14,
  CONCRETE: 15,
  STONE: 16,
  BRICK_RUNNING: 17,
  BRICK_FLEMISH: 18,
  BRICK_COMMON: 19,
  BRICK_PAINTED: 20,
  STUCCO: 21,
  CLAPBOARD: 22,
  SLATE: 23,
  METAL_SEAM: 24,
  ROOF_TAR: 25,
  /** Terrain: grass and soil mixed per pixel by the vertex colour's greenness (see worldMaterial.ts). */
  TERRAIN: 26,
  /** Old tram rails set in the setts: polished steel. */
  RAIL: 27,
  /** Sandstone/limestone ashlar on facades (lighter, finer joints than STONE). */
  ASHLAR: 28,
  /** Painted wood trim (cornices, door cases, porch columns). */
  TRIM: 29,
  /** Awning canvas. */
  CANVAS: 30,
  /** Rubber (tyres) and dark plastics. */
  RUBBER: 31,
} as const;
export type SurfId = (typeof SURF)[keyof typeof SURF];

/** How a surface is projected (merged geometry has no UVs). */
export const MAP = {
  /** no texture: vertex colour + macro variation */
  NONE: 0,
  /** world XZ from above (roads, sidewalks, grass) */
  TOP: 1,
  /** walls and roofs: top projection on near-flat faces, else a frame along the face (u horizontal, v up the slope) */
  BOX: 2,
  /** the geometry's own uv attribute (facade tiles handle their walls themselves) */
  UV: 3,
} as const;

/** Bake layers: one array layer per textured surface (the terrain and ashlar reuse others). */
export const BAKE_LAYERS = [
  'asphalt', 'paint', 'concreteSlab', 'brickPaver', 'granite', 'sett', 'grass', 'soil', 'gravel', 'bark', 'foliage', 'wood',
  'metalPaint', 'metalBare', 'concrete', 'stone', 'brickRunning', 'brickFlemish', 'brickCommon', 'brickPainted', 'stucco',
  'clapboard', 'slate', 'metalSeam', 'roofTar', 'canvas', 'water',
] as const;
export type BakeLayer = (typeof BAKE_LAYERS)[number];
export const LAYER = Object.fromEntries(BAKE_LAYERS.map((n, i) => [n, i])) as Record<BakeLayer, number>;

/**
 * Brick module: a 215 x 65 mm brick (102.5 mm wide) with 10 mm joints, close to the hand-made bricks of Federal-era
 * Georgetown (about 8 1/4 x 2 1/2 in). The procedural bonds (bakeShaders.ts) and the photo brick sets (data/
 * textureSets.ts, measured in courses and bricks per image) are all laid out on it, so every wall has the same brick.
 */
export const BRICK = { len: 0.225, course: 0.075, header: 0.1125 };

export interface SurfaceDef {
  id: number;
  layer: BakeLayer | null;
  /** metres covered by one texture tile (u, v) */
  size: [number, number];
  mapping: number;
  /** sRGB hex the texture was authored for: a vertex colour equal to it shows the texture unchanged */
  ref: number;
  /** 0..1: how much the vertex colour tints the texture (1 = fully, relative to ref) */
  tint: number;
  metal: number;
  /** multiplies the baked roughness */
  rough: number;
  /** normal map strength (1 = baked height as is) */
  normal: number;
  /** 0..1: how much rain darkens and smooths it (porous paving 1, glass/metal 0) */
  porosity: number;
  /** 0..1: large-scale brightness variation (world-space noise) so tiles never repeat visibly */
  macro: number;
}

const S = (id: number, layer: BakeLayer | null, size: number | [number, number], mapping: number, ref: number, o: Partial<SurfaceDef> = {}): SurfaceDef => ({
  id, layer, size: typeof size === 'number' ? [size, size] : size, mapping, ref, tint: 1, metal: 0, rough: 1, normal: 1, porosity: 0.8, macro: 0.5, ...o,
});

/** Tile sizes are whole numbers of pattern periods (bricks, slabs, setts) so the tiles join seamlessly. */
export const SURFACES: SurfaceDef[] = [
  S(SURF.NONE, null, 1, MAP.NONE, 0xffffff, { macro: 0.35, porosity: 0.6 }),
  S(SURF.ASPHALT, 'asphalt', 4, MAP.TOP, 0x4b4e54, { macro: 0.7, porosity: 1 }),
  S(SURF.PAINT, 'paint', 2, MAP.TOP, 0xeeeee6, { macro: 0.25, porosity: 0.7 }),
  S(SURF.CONCRETE_SLAB, 'concreteSlab', 3, MAP.TOP, 0xbcb7ad, { macro: 0.6, porosity: 0.9 }),
  S(SURF.BRICK_PAVER, 'brickPaver', 1.2, MAP.TOP, 0xa86a55, { macro: 0.6, porosity: 1 }),
  S(SURF.GRANITE, 'granite', 2, MAP.BOX, 0xa3a29c, { macro: 0.3, porosity: 0.5 }),
  S(SURF.SETT, 'sett', 2, MAP.TOP, 0x7d7268, { macro: 0.5, porosity: 0.9 }),
  S(SURF.GRASS, 'grass', 3, MAP.TOP, 0x7fae5a, { macro: 0.8, porosity: 0.5 }),
  S(SURF.SOIL, 'soil', 3, MAP.TOP, 0x8a7357, { macro: 0.7, porosity: 1 }),
  S(SURF.GRAVEL, 'gravel', 2, MAP.TOP, 0xc2ad86, { macro: 0.6, porosity: 1 }),
  S(SURF.BARK, 'bark', [1.2, 1.6], MAP.BOX, 0x6b4a2f, { macro: 0.3, porosity: 0.6 }),
  S(SURF.FOLIAGE, 'foliage', 1.6, MAP.BOX, 0x5c9e47, { macro: 0.5, porosity: 0 }),
  S(SURF.WOOD, 'wood', 2, MAP.BOX, 0x8c6440, { macro: 0.5, porosity: 0.9 }),
  S(SURF.METAL_PAINT, 'metalPaint', 1, MAP.BOX, 0x2f3236, { macro: 0.15, porosity: 0.1 }),
  S(SURF.METAL_BARE, 'metalBare', 1, MAP.BOX, 0x9a9da0, { metal: 1, macro: 0.15, porosity: 0 }),
  S(SURF.CONCRETE, 'concrete', 4, MAP.BOX, 0xb3afa6, { macro: 0.6, porosity: 0.8 }),
  S(SURF.STONE, 'stone', [3.2, 2.4], MAP.BOX, 0xaaa397, { macro: 0.5, porosity: 0.7 }),
  S(SURF.BRICK_RUNNING, 'brickRunning', [BRICK.len * 12, BRICK.course * 36], MAP.BOX, 0xad5844, { macro: 0.45, porosity: 0.7 }),
  S(SURF.BRICK_FLEMISH, 'brickFlemish', [(BRICK.len + BRICK.header) * 8, BRICK.course * 36], MAP.BOX, 0xad5844, { macro: 0.45, porosity: 0.7 }),
  S(SURF.BRICK_COMMON, 'brickCommon', [BRICK.len * 12, BRICK.course * 36], MAP.BOX, 0xad5844, { macro: 0.45, porosity: 0.7 }),
  S(SURF.BRICK_PAINTED, 'brickPainted', [BRICK.len * 12, BRICK.course * 36], MAP.BOX, 0xffffff, { macro: 0.35, porosity: 0.4 }),
  S(SURF.STUCCO, 'stucco', 3, MAP.BOX, 0xffffff, { macro: 0.4, porosity: 0.5 }),
  S(SURF.CLAPBOARD, 'clapboard', [2.4, 2.4], MAP.BOX, 0xffffff, { macro: 0.3, porosity: 0.3 }),
  S(SURF.SLATE, 'slate', [2.4, 2.4], MAP.BOX, 0x4a4f57, { macro: 0.4, porosity: 0.3 }),
  S(SURF.METAL_SEAM, 'metalSeam', [2.7, 2.7], MAP.BOX, 0x6f7f72, { metal: 0.55, macro: 0.3, porosity: 0 }),
  S(SURF.ROOF_TAR, 'roofTar', 4, MAP.BOX, 0x8d8a84, { macro: 0.6, porosity: 0.6 }),
  S(SURF.TERRAIN, 'grass', 3, MAP.TOP, 0x7fae5a, { macro: 0.8, porosity: 0.6 }),
  S(SURF.RAIL, 'metalBare', 1, MAP.TOP, 0x9a9da0, { metal: 1, rough: 0.6, macro: 0.2, porosity: 0 }),
  S(SURF.ASHLAR, 'stone', [3.2, 2.4], MAP.BOX, 0xc9bfae, { macro: 0.4, porosity: 0.6, normal: 0.7 }),
  S(SURF.TRIM, 'stucco', 3, MAP.BOX, 0xffffff, { rough: 0.75, macro: 0.2, porosity: 0.3, normal: 0.4 }),
  S(SURF.CANVAS, 'canvas', 1, MAP.BOX, 0xffffff, { macro: 0.2, porosity: 0.8 }),
  S(SURF.RUBBER, 'roofTar', 1, MAP.BOX, 0x222222, { rough: 0.95, macro: 0.1, porosity: 0.2, normal: 0.3 }),
];
/** Number of rows in the surface table texture (power of two, ids above the list are untagged). */
export const SURF_ROWS = 64;

// ------------------------------------------------------------------------------------------ colour tags
/**
 * Tag a packed colour (0xRRGGBB, as lin() returns) with a surface id in bits 24..30. MeshBuf writes the id into the
 * aSurf attribute; meshKit's shade() and mixc() keep it.
 */
export function surf(id: number, colour: number): number {
  return ((id & 127) << 24) | (colour & 0xffffff);
}
/** Surface id of a tagged colour (0 = untagged). */
export function surfOf(colour: number): number {
  return (colour >>> 24) & 127;
}
