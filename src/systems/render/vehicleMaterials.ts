// Materials for vehicles and people (their shapes stay as they are). Cars are one vertex-coloured mesh per body, so the
// car material sorts each vertex by its colour into paint (metallic flake under a clearcoat), glass (dark, sharp
// reflections), trim and rubber (rough black plastic) and lamps (a little self-lit), using the vertex colour before
// any per-car paint tint. People get a soft cloth response (sheen) instead of plastic.
import * as THREE from 'three';

/** Car colours from art/car.ts (sRGB) that are not paint. */
const GLASS = new THREE.Color('#26303c'), TRIM = new THREE.Color('#2b2b2b'), HEAD = new THREE.Color('#fff6d5'), TAIL = new THREE.Color('#d62828');
const v3 = (c: THREE.Color) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

export function makeCarMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, flatShading: true, roughness: 0.38, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06,
  });
  m.name = 'car';
  m.customProgramCacheKey = () => 'oc-car-1';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nflat varying float vCarKind;')
      .replace('#include <color_vertex>', /* glsl */ `#include <color_vertex>
{
  // kind from the model's own colour (before the per-car paint tint): 0 paint, 1 glass, 2 trim/rubber, 3 lamp
  vec3 cc = color.rgb;
  vCarKind = distance(cc, ${v3(GLASS)}) < 0.02 ? 1.0 : distance(cc, ${v3(TRIM)}) < 0.02 ? 2.0 :
    (distance(cc, ${v3(HEAD)}) < 0.03 || distance(cc, ${v3(TAIL)}) < 0.03) ? 3.0 : 0.0;
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying float vCarKind;')
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
float roughnessFactor = vCarKind == 1.0 ? 0.04 : vCarKind == 2.0 ? 0.62 : vCarKind == 3.0 ? 0.12 : roughness;`)
      .replace('#include <metalnessmap_fragment>', /* glsl */ `
float metalnessFactor = vCarKind == 0.0 ? metalness : 0.0;`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
if (vCarKind == 3.0) totalEmissiveRadiance += diffuseColor.rgb * 0.25;
if (vCarKind == 1.0) diffuseColor.rgb *= 0.35;`)
      .replace('#include <lights_physical_fragment>', /* glsl */ `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= vCarKind == 0.0 ? 1.0 : 0.0;
#endif`);
  };
  return m;
}

/** Tyres and wheel hubs. */
export function makeTyreMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x1b1b1c, flatShading: true, roughness: 0.92, metalness: 0 });
}
export function makeHubMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xc8ccd2, flatShading: true, roughness: 0.22, metalness: 1 });
}

/** People: cloth with a soft sheen (skin and hair keep the same response; their shapes stay low-poly for now). */
export function makePersonMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xffffff) });
  m.name = 'person';
  return m;
}
