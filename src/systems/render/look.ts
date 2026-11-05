// The look library: the baked surface maps, the surface table and the uniforms every world material shares (wetness,
// snow, detail level). Created once at boot (main.ts / the preview page) and handed to the map builders, so there is no
// module-level state; the weather and lighting systems update its uniforms.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import { LAYER, SURF, SURF_ROWS, SURFACES } from './surfaces';
import { bakeSurfaceMaps, bakedBytes, disposeBaked, type BakedMaps } from './texBake';

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
}

export interface Look {
  uniforms: LookUniforms;
  maps: BakedMaps | null;
  quality: LookQuality;
  /** milliseconds of the last bake, and its GPU bytes */
  stats: { bakeMs: number; bytes: number; res: number };
}

function surfaceTable(): THREE.DataTexture {
  const W = 5;
  const data = new Float32Array(W * SURF_ROWS * 4);
  const c = new THREE.Color();
  const soil = SURFACES.find((s) => s.id === SURF.SOIL)!;
  for (const s of SURFACES) {
    const o = s.id * W * 4;
    data[o] = s.layer ? LAYER[s.layer] : 0;
    data[o + 1] = 1 / s.size[0];
    data[o + 2] = 1 / s.size[1];
    data[o + 3] = s.mapping;
    c.setHex(s.ref); // sRGB hex -> linear (three's colour management)
    data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = s.tint;
    data[o + 8] = s.metal; data[o + 9] = s.rough; data[o + 10] = s.normal; data[o + 11] = s.porosity;
    const flags = s.id === SURF.FOLIAGE ? 1 : s.id === SURF.TERRAIN ? 2 : 0;
    data[o + 12] = s.macro; data[o + 13] = flags; data[o + 14] = LAYER.soil; data[o + 15] = 1 / soil.size[0];
    c.setHex(soil.ref);
    data[o + 16] = c.r; data[o + 17] = c.g; data[o + 18] = c.b; data[o + 19] = 1;
  }
  const t = new THREE.DataTexture(data, W, SURF_ROWS, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function createLook(quality: LookQuality): Look {
  return {
    uniforms: {
      uAlbTex: { value: null }, uNrmTex: { value: null }, uMacro: { value: null }, uSurfTab: { value: surfaceTable() },
      uWet: { value: 0 }, uSnow: { value: 0 }, uDetail: { value: 1 }, uNight: { value: 0 }, uDaylight: { value: 1 },
      uWin: { value: new THREE.Color(0x8899aa) }, uTime: { value: 0 },
    },
    maps: null,
    quality,
    stats: { bakeMs: 0, bytes: 0, res: 0 },
  };
}

/** Bake (or re-bake at a new resolution) the surface maps for a quality preset. */
export function bakeLook(look: Look, renderer: THREE.WebGLRenderer, quality: LookQuality): void {
  const Q = TUNING.quality[quality];
  look.quality = quality;
  look.uniforms.uDetail.value = Q.textureDetail;
  if (look.maps && look.maps.res === Q.textureRes) return;
  const old = look.maps;
  const maps = bakeSurfaceMaps(renderer, Q.textureRes, Q.anisotropy);
  look.maps = maps;
  look.uniforms.uAlbTex.value = maps.alb.texture;
  look.uniforms.uNrmTex.value = maps.nrm.texture;
  look.uniforms.uMacro.value = maps.macro.texture;
  look.stats = { bakeMs: Math.round(maps.ms), bytes: bakedBytes(Q.textureRes), res: Q.textureRes };
  if (old) disposeBaked(old);
}
