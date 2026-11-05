// Water look for the generator's water meshes (river, canal, creek): smooth dielectric water that mirrors the sky
// (environment, Fresnel), with two scrolling layers of the baked ripple normals on top of the generator's own
// vertex swell, and a dark, slightly green body colour. Patches the generator's material in place (its wave code and
// time uniform stay), so waterworks.ts is not edited.
import * as THREE from 'three';
import type { Look } from './look';
import { LAYER } from './surfaces';
import { WATER_TILE } from './texBake';

/** Body colours (sRGB) by mesh name: muddy river, green canal, brown creek. */
const BODY: Record<string, number> = { river: 0x2a3a33, canal: 0x2c3d30, creek: 0x34362a };

export function upgradeWater(meshes: THREE.Mesh[], look: Look): void {
  const done = new Set<THREE.Material>();
  for (const mesh of meshes) {
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m) || done.has(m)) continue;
    done.add(m);
    const key = Object.keys(BODY).find((k) => mesh.name.startsWith(k)) ?? 'river';
    m.color.setHex(BODY[key]);
    m.roughness = 0.05;
    m.metalness = 0;
    m.flatShading = false;
    const prev = m.onBeforeCompile;
    m.customProgramCacheKey = () => `oc-water-1-${key}`;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      sh.uniforms.uNrmTex = look.uniforms.uNrmTex;
      sh.uniforms.uWaterTime = sh.uniforms.uTime ?? look.uniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform highp sampler2DArray uNrmTex;
uniform float uWaterTime;
varying vec3 vWaterP;`)
        .replace('#include <normal_fragment_maps>', /* glsl */ `
{
  float t = uWaterTime;
  vec2 p = vWaterP.xz;
  vec2 a = texture(uNrmTex, vec3(p / ${WATER_TILE.toFixed(1)} + vec2(0.021, 0.013) * t, ${LAYER.water}.0)).xy * 2.0 - 1.0;
  vec2 b = texture(uNrmTex, vec3(p / 2.9 + vec2(-0.017, 0.029) * t, ${LAYER.water}.0)).xy * 2.0 - 1.0;
  vec2 c = texture(uNrmTex, vec3(p / 31.0 + vec2(0.006, -0.004) * t, ${LAYER.water}.0)).xy * 2.0 - 1.0;
  vec2 xy = (a * 0.55 + b * 0.35 + c * 0.6) * ${key === 'river' ? '0.55' : '0.3'};
  vec3 nw = normalize(vec3(xy.x, 1.0, xy.y));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}`);
    };
    m.needsUpdate = true;
  }
}
