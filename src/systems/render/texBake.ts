// Procedural PBR bake on the GPU at boot: every surface layer (bakeShaders.ts) is rendered into two texture arrays,
// albedo + tint mask (sRGB) and normal xy + roughness + occlusion (linear), with mipmaps and anisotropy, plus one macro
// variation texture. Nothing is downloaded; the result is the same on every machine (fixed seeds).
//
// Cost: three full-screen passes per layer at the preset's resolution, once at boot (and again only when the player
// changes the texture resolution in the pause menu). Memory: see bakedBytes().
import * as THREE from 'three';
import { BAKE_LAYERS, BRICK, SURFACES } from './surfaces';
import { BAKE_VERT, MACRO_FRAG, NORMAL_FRAG, bakeFragment } from './bakeShaders';

/** Tile size of the water ripple layer (m); no surface uses it, the water material samples it directly. */
export const WATER_TILE = 8;
/** Macro variation texture size (px); it covers MACRO_TILE metres of world (see worldMaterial.ts). */
const MACRO_RES = 512;

export interface BakedMaps {
  alb: THREE.WebGLArrayRenderTarget;
  nrm: THREE.WebGLArrayRenderTarget;
  macro: THREE.WebGLRenderTarget;
  res: number;
  layers: number;
  ms: number;
}

/** Tile size (m) per bake layer: the first surface that uses it. */
export function layerSize(i: number): [number, number] {
  const name = BAKE_LAYERS[i];
  if (name === 'water') return [WATER_TILE, WATER_TILE];
  const s = SURFACES.find((d) => d.layer === name);
  return s ? s.size : [2, 2];
}

/** GPU bytes of a bake at `res` (both arrays with full mip chains, and the macro texture). */
export function bakedBytes(res: number): number {
  const mip = 4 / 3;
  return Math.round(res * res * 4 * BAKE_LAYERS.length * 2 * mip + MACRO_RES * MACRO_RES * 4 * mip);
}

export function bakeSurfaceMaps(renderer: THREE.WebGLRenderer, res: number, anisotropy: number): BakedMaps {
  const t0 = performance.now();
  const n = BAKE_LAYERS.length;
  const common = {
    depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy, type: THREE.UnsignedByteType,
  } as const;
  const alb = new THREE.WebGLArrayRenderTarget(res, res, n, { ...common, colorSpace: THREE.SRGBColorSpace });
  const nrm = new THREE.WebGLArrayRenderTarget(res, res, n, { ...common });
  // mipmaps once at the end, not after every layer
  alb.texture.mipmapsAutoUpdate = false;
  nrm.texture.mipmapsAutoUpdate = false;
  const tmp = new THREE.WebGLRenderTarget(res, res, {
    depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: false,
  });
  const macro = new THREE.WebGLRenderTarget(MACRO_RES, MACRO_RES, { ...common, anisotropy: 1 });

  const bakeUniforms = { uSize: { value: new THREE.Vector2(2, 2) }, uMat: { value: 0 }, uPass: { value: 0 }, uSeed: { value: 0 } };
  const bakeMat = (i: number) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: bakeFragment(BRICK, i), uniforms: bakeUniforms,
    depthTest: false, depthWrite: false,
  });
  const normal = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: NORMAL_FRAG,
    uniforms: { uHeight: { value: tmp.texture }, uSize: { value: new THREE.Vector2(2, 2) }, uRes: { value: res } },
    depthTest: false, depthWrite: false,
  });
  const macroMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: MACRO_FRAG,
    uniforms: { uSize: { value: new THREE.Vector2(256, 256) }, uMat: { value: 0 }, uPass: { value: 0 }, uSeed: { value: 0 } },
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), macroMat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  for (let i = 0; i < n; i++) {
    const [sx, sz] = layerSize(i);
    bakeUniforms.uSize.value.set(sx, sz);
    normal.uniforms.uSize.value.set(sx, sz);
    bakeUniforms.uMat.value = i;
    const bake = bakeMat(i);
    quad.material = bake;
    if (i === n - 1) alb.texture.mipmapsAutoUpdate = true;
    bakeUniforms.uPass.value = 0;
    renderer.setRenderTarget(alb, i);
    renderer.render(scene, cam);
    bakeUniforms.uPass.value = 1;
    renderer.setRenderTarget(tmp);
    renderer.render(scene, cam);
    quad.material = normal;
    if (i === n - 1) nrm.texture.mipmapsAutoUpdate = true;
    renderer.setRenderTarget(nrm, i);
    renderer.render(scene, cam);
    bake.dispose();
  }
  quad.material = macroMat;
  renderer.setRenderTarget(macro);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  tmp.dispose();
  normal.dispose();
  macroMat.dispose();
  quad.geometry.dispose();
  return { alb, nrm, macro, res, layers: n, ms: performance.now() - t0 };
}

export function disposeBaked(m: BakedMaps): void {
  m.alb.dispose();
  m.nrm.dispose();
  m.macro.dispose();
}
