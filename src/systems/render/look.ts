// The look library: the baked surface maps, the surface table and the uniforms every world material shares (wetness,
// snow, detail level). Created once at boot (main.ts / the preview page) and handed to the map builders, so there is no
// module-level state; the weather and lighting systems update its uniforms.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import { BAKE_LAYERS, LAYER, SURF, SURF_ROWS, SURFACES } from './surfaces';
import { bakeSurfaceMaps, bakedBytes, disposeBaked, type BakedMaps } from './texBake';
import { photoLayers } from './texLibrary';

export type LookQuality = 'low' | 'medium' | 'high';

export interface LookUniforms {
  [k: string]: THREE.IUniform;
  uAlbTex: THREE.IUniform<THREE.Texture | null>;
  uNrmTex: THREE.IUniform<THREE.Texture | null>;
  uMacro: THREE.IUniform<THREE.Texture | null>;
  uSurfTab: THREE.IUniform<THREE.DataTexture>;
  uWet: THREE.IUniform<number>;
  uSnow: THREE.IUniform<number>;
  /** 1 = normal maps and occlusion on, 0 = off (cheaper fragments on Low) */
  uDetail: THREE.IUniform<number>;
  /** 0 = day, 1 = night (window interiors and lights) */
  uNight: THREE.IUniform<number>;
  /** daylight reaching interiors through windows (0..1) */
  uDaylight: THREE.IUniform<number>;
  /** lit-window colour, driven by the day/night system */
  uWin: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  /** share of the sky light (environment) on diffuse surfaces; specular reflections keep all of it */
  uSkyDiffuse: THREE.IUniform<number>;
}

export interface LibraryState {
  /** bumped by every load (a newer load supersedes an older one still in flight) */
  gen: number;
  /** ids of the photo sets in the current maps, and of the sets that failed to load */
  sets: string[];
  failed: string[];
  /** photo layers that hold their procedural fallback */
  procedural: Set<number>;
  /** milliseconds of the last load (fetch, decode, draw) */
  ms: number;
}

export interface Look {
  uniforms: LookUniforms;
  maps: BakedMaps | null;
  quality: LookQuality;
  /** milliseconds of the last bake, and its GPU bytes */
  stats: { bakeMs: number; bytes: number; res: number };
  /** per bake layer [u, v]: tile size relative to the procedural tile (a photo set's real size; render/texLibrary.ts) */
  layerScale: Float32Array;
  /** per bake layer: scale of the palette tint (a photo set's `tint`) */
  layerTint: Float32Array;
  library: LibraryState;
  /** rewrite the surface table after a layer's tile size changed */
  refreshSurfaceTable(): void;
}

const TABLE_W = 5;

function surfaceTable(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(TABLE_W * SURF_ROWS * 4), TABLE_W, SURF_ROWS, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/** Fill the surface table: per surface its layer, 1 / tile size (scaled by the layer's photo scale), mapping, reference
 * colour, PBR factors, macro amount and flags (worldMaterial.ts ocSurface reads it). */
function fillSurfaceTable(t: THREE.DataTexture, scale: Float32Array, tint: Float32Array): void {
  const W = TABLE_W;
  const data = t.image.data as Float32Array;
  const c = new THREE.Color();
  const soil = SURFACES.find((s) => s.id === SURF.SOIL)!;
  for (const s of SURFACES) {
    const o = s.id * W * 4;
    const L = s.layer ? LAYER[s.layer] : 0;
    data[o] = L;
    data[o + 1] = 1 / (s.size[0] * (s.layer ? scale[L * 2] : 1));
    data[o + 2] = 1 / (s.size[1] * (s.layer ? scale[L * 2 + 1] : 1));
    data[o + 3] = s.mapping;
    c.setHex(s.ref); // sRGB hex -> linear (three's colour management)
    data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = s.tint * (s.layer ? tint[L] : 1);
    data[o + 8] = s.metal; data[o + 9] = s.rough; data[o + 10] = s.normal; data[o + 11] = s.porosity;
    const flags = s.id === SURF.FOLIAGE ? 1 : s.id === SURF.TERRAIN ? 2 : 0;
    data[o + 12] = s.macro; data[o + 13] = flags; data[o + 14] = LAYER.soil; data[o + 15] = 1 / (soil.size[0] * scale[LAYER.soil * 2]);
    c.setHex(soil.ref);
    data[o + 16] = c.r; data[o + 17] = c.g; data[o + 18] = c.b; data[o + 19] = 1;
  }
  t.needsUpdate = true;
}

export function createLook(quality: LookQuality): Look {
  const tab = surfaceTable();
  const layerScale = new Float32Array(BAKE_LAYERS.length * 2).fill(1);
  const layerTint = new Float32Array(BAKE_LAYERS.length).fill(1);
  fillSurfaceTable(tab, layerScale, layerTint);
  return {
    uniforms: {
      uAlbTex: { value: null }, uNrmTex: { value: null }, uMacro: { value: null }, uSurfTab: { value: tab },
      uWet: { value: 0 }, uSnow: { value: 0 }, uDetail: { value: 1 }, uNight: { value: 0 }, uDaylight: { value: 1 },
      uWin: { value: new THREE.Color(0x8899aa) }, uTime: { value: 0 }, uSkyDiffuse: { value: 1 },
    },
    maps: null,
    quality,
    stats: { bakeMs: 0, bytes: 0, res: 0 },
    layerScale,
    layerTint,
    library: { gen: 0, sets: [], failed: [], procedural: new Set(), ms: 0 },
    refreshSurfaceTable: () => fillSurfaceTable(tab, layerScale, layerTint),
  };
}

/**
 * Bake (or re-bake at a new resolution) the surface maps for a quality preset. Returns true if it baked (then the
 * texture library must be loaded into the new maps: render/texLibrary.ts loadTextureLibrary). `skipPhotoLayers` leaves
 * the layers the library fills empty (boot: the library is awaited before the first frame, and fillMissingLayers
 * covers a failure); a re-bake during play bakes them too, so nothing is ever drawn black while the photos reload.
 */
export function bakeLook(look: Look, renderer: THREE.WebGLRenderer, quality: LookQuality, skipPhotoLayers = false): boolean {
  const Q = TUNING.quality[quality];
  look.quality = quality;
  look.uniforms.uDetail.value = Q.textureDetail;
  if (look.maps && look.maps.res === Q.textureRes) return false;
  const old = look.maps;
  // free the old arrays first: two sets of High's arrays at once was ~600 MB of GPU memory
  if (old) { disposeBaked(old); look.maps = null; }
  const skip = skipPhotoLayers ? photoLayers() : new Set<number>();
  const maps = bakeSurfaceMaps(renderer, Q.textureRes, Q.anisotropy, skip);
  look.library.gen++; // any load still in flight was for the old maps
  look.library.sets = [];
  look.library.procedural = new Set([...photoLayers()].filter((l) => !skip.has(l)));
  look.layerScale.fill(1);
  look.layerTint.fill(1);
  look.refreshSurfaceTable();
  look.maps = maps;
  look.uniforms.uAlbTex.value = maps.alb.texture;
  look.uniforms.uNrmTex.value = maps.nrm.texture;
  look.uniforms.uMacro.value = maps.macro.texture;
  look.stats = { bakeMs: Math.round(maps.ms), bytes: bakedBytes(Q.textureRes), res: Q.textureRes };
  return true;
}
