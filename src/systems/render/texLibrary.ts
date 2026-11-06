// The shared texture library (data/textureSets.ts): CC0 photo PBR sets resampled into the baked surface arrays, one
// set per layer, at the preset's resolution, with full mipmaps. A layer whose files fail to load (or arrive after the
// boot's wait) keeps its procedural bake, so the game never depends on them; nothing is fetched from a third party
// (the files are part of the build).
//
// Flow: bakeLook() skips the procedural bake of every layer a set will fill; loadTextureLibrary() fetches and decodes
// the files (off the main thread: createImageBitmap), draws each set into its layer (bakeShaders.ts PHOTO_FRAG), sets
// the layer's tile size (the surfaces using it are scaled to the photo's real size) and bakes the procedural maps of
// any layer whose set failed. The decoded images are released straight after; a later re-bake (texture resolution
// changed in the pause menu) loads them again from the browser cache.
import * as THREE from 'three';
import { TEXTURE_SETS, type TextureSet } from '../../data/textureSets';
import { BAKE_VERT, PHOTO_FRAG } from './bakeShaders';
import { BAKE_LAYERS, LAYER } from './surfaces';
import { bakeProceduralLayers, layerSize, type BakedMaps } from './texBake';
import type { Look } from './look';

/** Layers a texture set fills (their procedural bake is skipped at boot). */
export function photoLayers(): Set<number> {
  return new Set(TEXTURE_SETS.map((s) => LAYER[s.layer]));
}

interface Loaded { set: TextureSet; col: ImageBitmap; nrm: ImageBitmap; rgh: ImageBitmap }

async function bitmap(url: string): Promise<ImageBitmap> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`texture ${url}: HTTP ${r.status}`);
  // flipY: row 0 = the image's bottom, so +v is image-up, as the OpenGL normal maps assume
  return createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

async function loadSet(s: TextureSet): Promise<Loaded> {
  const [col, nrm, rgh] = await Promise.all([bitmap(s.col), bitmap(s.nrm), bitmap(s.rgh)]);
  return { set: s, col, nrm, rgh };
}

function tex(b: ImageBitmap, srgb: boolean): THREE.Texture {
  const t = new THREE.Texture(b);
  t.flipY = false; // already flipped by createImageBitmap
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Draw loaded sets into the arrays of `maps` (mipmaps regenerated once at the end). */
function bakePhotoLayers(renderer: THREE.WebGLRenderer, maps: BakedMaps, sets: Loaded[]): void {
  if (sets.length === 0) return;
  const uniforms = {
    uCol: { value: null as THREE.Texture | null }, uNrm: { value: null as THREE.Texture | null }, uRgh: { value: null as THREE.Texture | null },
    uLod: { value: new THREE.Vector3() }, uMean: { value: new THREE.Vector4() }, uContrast: { value: 1 }, uNormal: { value: 1 },
    uRough: { value: new THREE.Vector2(1, 0) }, uTint: { value: 1 }, uPass: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: PHOTO_FRAG, uniforms, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  maps.alb.texture.mipmapsAutoUpdate = false;
  maps.nrm.texture.mipmapsAutoUpdate = false;
  const c = new THREE.Color();
  const lod = (b: ImageBitmap) => Math.max(0, Math.log2(b.width / maps.res));
  for (let k = 0; k < sets.length; k++) {
    const { set: s, col, nrm, rgh } = sets[k];
    const last = k === sets.length - 1;
    const tc = tex(col, true), tn = tex(nrm, false), tr = tex(rgh, false);
    uniforms.uCol.value = tc; uniforms.uNrm.value = tn; uniforms.uRgh.value = tr;
    uniforms.uLod.value.set(lod(col), lod(nrm), lod(rgh));
    if (s.mean !== null) { c.setHex(s.mean); uniforms.uMean.value.set(c.r, c.g, c.b, 1); } else uniforms.uMean.value.set(0, 0, 0, 0);
    uniforms.uContrast.value = s.contrast;
    uniforms.uNormal.value = s.normal;
    uniforms.uRough.value.set(s.rough[0], s.rough[1]);
    uniforms.uTint.value = s.tintMask === 'none' ? 0 : s.tintMask === 'brick' ? 2 : 1;
    const layer = LAYER[s.layer];
    if (last) maps.alb.texture.mipmapsAutoUpdate = true;
    uniforms.uPass.value = 0;
    renderer.setRenderTarget(maps.alb, layer);
    renderer.render(scene, cam);
    if (last) maps.nrm.texture.mipmapsAutoUpdate = true;
    uniforms.uPass.value = 1;
    renderer.setRenderTarget(maps.nrm, layer);
    renderer.render(scene, cam);
    tc.dispose(); tn.dispose(); tr.dispose();
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  mat.dispose();
  quad.geometry.dispose();
}

/**
 * Load the library into the look's current maps. Resolves when every layer is filled (photo or procedural fallback);
 * never rejects. A newer call (re-bake at another resolution) supersedes an older one still loading.
 */
export async function loadTextureLibrary(look: Look, renderer: THREE.WebGLRenderer): Promise<void> {
  const gen = ++look.library.gen;
  const maps = look.maps;
  if (!maps) return;
  const t0 = performance.now();
  const results = await Promise.allSettled(TEXTURE_SETS.map(loadSet));
  const ok: Loaded[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') ok.push(r.value); else failed.push(TEXTURE_SETS[i].id); });
  const stale = gen !== look.library.gen || look.maps !== maps;
  if (!stale) {
    bakePhotoLayers(renderer, maps, ok);
    // a failed set's layer gets its procedural bake (it was skipped at boot), unless the boot already filled it
    const missing = [...photoLayers()].filter((l) => !ok.some((o) => LAYER[o.set.layer] === l) && !look.library.procedural.has(l));
    if (missing.length) { bakeProceduralLayers(renderer, maps, missing); for (const l of missing) look.library.procedural.add(l); }
    for (let i = 0; i < BAKE_LAYERS.length; i++) { look.layerScale[i * 2] = look.layerScale[i * 2 + 1] = 1; look.layerTint[i] = 1; }
    for (const o of ok) {
      const l = LAYER[o.set.layer];
      const [sx, sz] = layerSize(l);
      look.layerScale[l * 2] = o.set.tile[0] / sx;
      look.layerScale[l * 2 + 1] = o.set.tile[1] / sz;
      look.layerTint[l] = o.set.tint;
      look.library.procedural.delete(l);
    }
    look.refreshSurfaceTable();
    look.library.sets = ok.map((o) => o.set.id);
    look.library.failed = failed;
    look.library.ms = Math.round(performance.now() - t0);
  }
  for (const o of ok) { o.col.close(); o.nrm.close(); o.rgh.close(); }
}

/** Boot / timeout fallback: give every photo layer that has nothing in it yet its procedural bake. */
export function fillMissingLayers(look: Look, renderer: THREE.WebGLRenderer): void {
  if (!look.maps) return;
  const filled = new Set(look.library.sets.map((id) => LAYER[TEXTURE_SETS.find((s) => s.id === id)!.layer]));
  const missing = [...photoLayers()].filter((l) => !filled.has(l) && !look.library.procedural.has(l));
  if (!missing.length) return;
  bakeProceduralLayers(renderer, look.maps, missing);
  for (const l of missing) look.library.procedural.add(l);
}
