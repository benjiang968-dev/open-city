// The world material: a MeshStandardMaterial patched (onBeforeCompile) to read each vertex's surface id (aSurf), project
// that surface's baked PBR maps onto the merged, UV-less geometry in world space (from above for ground, along the face
// for walls and roofs), tint them by the vertex colour relative to the surface's reference colour, add macro variation
// so tiles never repeat visibly, and make porous surfaces wet in the rain. One material serves every surface of a layer,
// so the generator's chunk batching (one draw call per chunk and layer) is unchanged.
import * as THREE from 'three';
import type { Look } from './look';
import { TUNING } from '../../tuning';

/** Vertex additions: world position and normal, surface id. */
export const OC_VERT_PARS = /* glsl */ `
attribute float aSurf;
flat varying float vSurf;
varying vec3 vOcP;
varying vec3 vOcN;`;
export const OC_VERT_MAIN = /* glsl */ `
{
  vec4 ocW = vec4(transformed, 1.0);
  vec3 ocN0 = objectNormal;
#ifdef USE_INSTANCING
  ocW = instanceMatrix * ocW;
  ocN0 = mat3(instanceMatrix) * ocN0;
#endif
  ocW = modelMatrix * ocW;
  vOcP = ocW.xyz;
  vOcN = normalize(mat3(modelMatrix) * ocN0);
  vSurf = aSurf;
}`;

/** Fragment declarations and the surface sampler shared by the world and facade materials. */
export const OC_FRAG_PARS = /* glsl */ `
#define OC_SKY_SAT ${TUNING.look.skyDiffuseSaturation.toFixed(3)}
uniform highp sampler2DArray uAlbTex;
uniform highp sampler2DArray uNrmTex;
uniform sampler2D uMacro;
uniform highp sampler2D uSurfTab;
uniform float uWet;
uniform float uSnow;
uniform float uDetail;
uniform float uSkyDiffuse;
flat varying float vSurf;
varying vec3 vOcP;
varying vec3 vOcN;

struct OcOut { vec3 alb; float rough; float metal; vec3 nW; float ao; float alpha; vec2 wuv; float up; };

/** World-space projection frame: uv in metres, T/B = world directions of +u/+v. */
void ocFrame(vec3 N, int mode, out vec2 uv, out vec3 T, out vec3 B) {
  if (mode == 1 || abs(N.y) > 0.92) { uv = vOcP.xz; T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 0.0, 1.0); }
  else { T = normalize(vec3(-N.z, 0.0, N.x)); B = cross(T, N); uv = vec2(dot(vOcP, T), dot(vOcP, B)); }
}
vec3 ocTint(vec3 vcol, vec3 ref, float mask) {
  vec3 t = clamp(vcol / max(ref, vec3(0.003)), 0.0, 4.0);
  return mix(vec3(1.0), t, mask);
}
vec3 ocNormal(vec4 tn, float strength, vec3 T, vec3 B, vec3 N) {
  vec2 xy = (tn.xy * 2.0 - 1.0);
  float z = sqrt(max(0.0, 1.0 - dot(xy, xy)));
  vec3 t = normalize(vec3(xy * strength, max(z, 1e-3)));
  return normalize(T * t.x + B * t.y + N * t.z);
}

/** Sample surface s at this fragment. Ng = geometric world normal, vcol = vertex colour (linear). */
OcOut ocSurface(int s, vec3 Ng, vec3 vcol, float baseRough, float baseMetal) {
  vec4 A = texelFetch(uSurfTab, ivec2(0, s), 0);   // layer, 1/size u, 1/size v, mapping
  vec4 R = texelFetch(uSurfTab, ivec2(1, s), 0);   // reference colour (linear), tint amount
  vec4 C = texelFetch(uSurfTab, ivec2(2, s), 0);   // metalness, roughness multiplier, normal strength, porosity
  vec4 D = texelFetch(uSurfTab, ivec2(3, s), 0);   // macro amount, flags (1 foliage, 2 terrain), alt layer, alt 1/size
  int mode = int(A.w + 0.5);
  int flags = int(D.y + 0.5);
  float textured = mode == 0 ? 0.0 : 1.0;
  vec3 N = Ng;
  if (flags == 1) {
    // foliage cards: project along the card itself (its true face normal), light with the canopy's rounded normal
    vec3 fN = normalize(cross(dFdx(vOcP), dFdy(vOcP)));
    N = fN;
  }
  vec2 wuv; vec3 T, B;
  ocFrame(N, mode, wuv, T, B);
  vec2 tuv = wuv * A.yz;
  vec2 gx = dFdx(tuv), gy = dFdy(tuv);
  vec4 ta = textureGrad(uAlbTex, vec3(tuv, A.x), gx, gy);
  vec4 tn = textureGrad(uNrmTex, vec3(tuv, A.x), gx, gy);
  vec4 m1 = texture(uMacro, wuv * (1.0 / 173.0));
  vec4 m2 = texture(uMacro, wuv * (1.0 / 31.0) + 0.37);
  OcOut o;
  o.wuv = wuv;
  o.alpha = 1.0;
  float tintMask = ta.a * R.w;
  if (flags == 1) { o.alpha = ta.a; tintMask = R.w; }
  o.alb = mix(vec3(1.0), ta.rgb, textured) * ocTint(vcol, R.rgb, mix(1.0, tintMask, textured));
  if (flags == 2) {
    // terrain: grass and soil mixed by the vertex colour's greenness (natural edges from the macro noise)
    vec2 tuv2 = wuv * D.w;
    vec4 sa = textureGrad(uAlbTex, vec3(tuv2, D.z), gx * D.w / A.y, gy * D.w / A.y);
    vec4 sn = textureGrad(uNrmTex, vec3(tuv2, D.z), gx * D.w / A.y, gy * D.w / A.y);
    vec4 E = texelFetch(uSurfTab, ivec2(4, s), 0);  // soil reference colour
    float g = vcol.g / max(1e-4, vcol.r + vcol.g + vcol.b);
    float w = smoothstep(0.4, 0.5, g + (m2.r - 0.5) * 0.12 + (m1.g - 0.5) * 0.06);
    vec3 soilAlb = sa.rgb * ocTint(vcol, E.rgb, sa.a);
    o.alb = mix(soilAlb, o.alb, w);
    tn = mix(sn, tn, w);
    ta.a = 1.0;
  }
  float mac = (m1.r - 0.5) * 0.7 + (m2.g - 0.5) * 0.5;
  o.alb *= 1.0 + D.x * mac * 0.6;
  o.rough = mix(baseRough, tn.b * C.y, textured);
  o.metal = mix(baseMetal, C.x, textured);
  o.ao = mix(1.0, tn.a, textured * uDetail);
  o.up = clamp((Ng.y - 0.45) / 0.45, 0.0, 1.0);
  // rain: porous surfaces darken; upward faces turn glossy, with puddles in the dips of the macro field
  float wet = uWet * C.w;
  float pud = uWet * o.up * smoothstep(0.6, 0.7, m2.b * 0.65 + m1.b * 0.55) * step(0.55, C.w) * textured;
  o.alb *= 1.0 - wet * mix(0.22, 0.42, o.up);
  o.rough = mix(o.rough, mix(o.rough * 0.6, 0.14, o.up), wet);
  o.rough = mix(o.rough, 0.035, pud);
  // snow settles on what faces up
  float sn = uSnow * o.up * smoothstep(0.35, 0.65, m2.a + o.up * 0.35);
  o.alb = mix(o.alb, vec3(0.82, 0.84, 0.88), sn);
  o.rough = mix(o.rough, 0.75, sn);
  float strength = C.z * textured * uDetail * (1.0 - pud) * (1.0 - sn * 0.8);
  if (flags == 1) {
    vec3 leafN = ocNormal(tn, strength, T, B, N);
    o.nW = normalize(Ng * 1.2 + (leafN - N * dot(leafN, N)) * 0.9);
  } else {
    o.nW = ocNormal(tn, strength, T, B, Ng);
  }
  return o;
}`;

/**
 * Leaf card coverage: the leaf texture's alpha, rounded into a cluster by the card coordinate (ragged edge), and kept
 * dense in the smaller mip levels (averaged alpha would otherwise dissolve distant canopies into speckle).
 */
const FOLIAGE_ALPHA = /* glsl */ `
{
  float ocR = length(vCard);
  float ocEdge = 1.0 - smoothstep(0.55, 1.0, ocR + (ocS.alpha - 0.5) * 0.35);
  vec2 ocG = fwidth(ocS.wuv) * float(textureSize(uAlbTex, 0).x) * texelFetch(uSurfTab, ivec2(0, int(vSurf + 0.5)), 0).y;
  float ocLod = max(0.0, log2(max(ocG.x, ocG.y)));
  diffuseColor.a = clamp(ocS.alpha * (1.0 + 0.3 * ocLod), 0.0, 1.0) * ocEdge;
}`;

export interface WorldMatOptions {
  name: string;
  roughness?: number;
  metalness?: number;
  /** Decals (road paint, path ribbons): drawn over the ground with a polygon offset. */
  decal?: boolean;
  /** Foliage cards: alpha cut-out from the leaf texture, both sides. */
  foliage?: boolean;
  /** Instanced far trees: instances within `radius` of `centre` (xz) are not drawn (detailed trees stand there). */
  hideNear?: { centre: THREE.IUniform<THREE.Vector3>; radius: THREE.IUniform<number> };
}

/** A world material for MeshBuf geometry (vertex colours tagged with surface ids). */
export function makeWorldMaterial(look: Look, o: WorldMatOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: o.roughness ?? 0.9, metalness: o.metalness ?? 0,
    side: o.foliage ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (o.decal) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -6; }
  // leaf cards: soft cut-out edges with MSAA (alpha to coverage), a hard 0.5 cut without it
  if (o.foliage) { mat.alphaTest = 0.5; mat.alphaToCoverage = true; }
  mat.name = o.name;
  const key = `oc-world-1-${o.foliage ? 'f' : 's'}${o.hideNear ? 'h' : ''}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, look.uniforms);
    if (o.hideNear) { sh.uniforms.uNearCentre = o.hideNear.centre; sh.uniforms.uNearRadius = o.hideNear.radius; }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${OC_VERT_PARS}${o.hideNear ? '\nuniform vec3 uNearCentre;\nuniform float uNearRadius;' : ''}${o.foliage ? '\nattribute vec2 aCard;\nvarying vec2 vCard;' : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${OC_VERT_MAIN}${o.foliage ? '\nvCard = aCard;' : ''}`);
    if (o.hideNear) sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
#ifdef USE_INSTANCING
{
  vec3 ocIp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 ocD = ocIp.xz - uNearCentre.xz;
  if (dot(ocD, ocD) < uNearRadius * uNearRadius) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${OC_FRAG_PARS}${o.foliage ? '\nvarying vec2 vCard;' : ''}`)
      .replace('#include <map_fragment>', /* glsl */ `
vec3 ocNg = normalize(vOcN);
${o.foliage ? '' : '#ifdef DOUBLE_SIDED\n  ocNg *= gl_FrontFacing ? 1.0 : -1.0;\n#endif'}
#ifdef USE_COLOR
  vec3 ocVc = vColor.rgb;
#else
  vec3 ocVc = vec3(1.0);
#endif
OcOut ocS = ocSurface(int(vSurf + 0.5), ocNg, ocVc, roughness, metalness);
diffuseColor.rgb *= ocS.alb;
${o.foliage ? FOLIAGE_ALPHA : ''}`)
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(ocS.rough, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = ocS.metal;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(ocS.nW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', /* glsl */ `
reflectedLight.indirectDiffuse *= ocS.ao * uSkyDiffuse;
reflectedLight.indirectDiffuse = mix(vec3(dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722))), reflectedLight.indirectDiffuse, OC_SKY_SAT);
reflectedLight.indirectSpecular *= ocS.ao;
reflectedLight.directDiffuse *= mix(1.0, ocS.ao, 0.5);`);
  };
  return mat;
}
