// Facade material for the Georgetown buildings. The facade tile arrays (map/facadeTex.ts) lay out window bays, doors and
// shopfronts per storey; this material fills their wall pixels with the building's PBR wall surface (brick in one of
// three bonds chosen per building, painted brick, stucco, ashlar, clapboard...; roofs with slate, standing seam or tar),
// gives frames and doors their relief, and renders the glass as glass: a sharp reflection of the sky with, behind it,
// a room (interior mapping: a ray-box intersection per window, wall colour, floor, ceiling, furniture, blinds) that
// glows warm at night when that window is lit.
import * as THREE from 'three';
import { TILE, makeFacadeTexture } from '../map/facadeTex';
import { OC_FRAG_PARS, OC_VERT_MAIN, OC_VERT_PARS } from './worldMaterial';
import { SURF } from './surfaces';
import type { Look } from './look';

export function makeFacadeMaterial(look: Look, litWindowMat: THREE.MeshBasicMaterial, anisotropy: number): THREE.MeshStandardMaterial {
  const { tex, aux } = makeFacadeTexture();
  tex.anisotropy = aux.anisotropy = anisotropy; // fixed at build: changing it later re-uploads the arrays
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  mat.name = 'geo-facade';
  mat.userData.facadeTex = tex;
  mat.customProgramCacheKey = () => 'oc-facade-1';
  const defs = `
#define S_BRICK_RUNNING ${SURF.BRICK_RUNNING}
#define S_BRICK_FLEMISH ${SURF.BRICK_FLEMISH}
#define S_BRICK_COMMON ${SURF.BRICK_COMMON}
#define S_STONE ${SURF.STONE}
#define T_PLINTH ${TILE.PLINTH}.0`;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, look.uniforms);
    sh.uniforms.uFacade = { value: tex };
    sh.uniforms.uFacAux = { value: aux };
    sh.uniforms.uWin = { value: litWindowMat.color }; // the day/night system drives this colour
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${OC_VERT_PARS}\nattribute vec4 aFac;\nflat varying vec4 vFac;\nvarying vec2 vFUv;`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFac = aFac;\nvFUv = uv;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${OC_VERT_MAIN}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${defs}
${OC_FRAG_PARS}
uniform highp sampler2DArray uFacade;
uniform highp sampler2DArray uFacAux;
uniform vec3 uWin;
uniform float uNight;
uniform float uDaylight;
flat varying vec4 vFac;
varying vec2 vFUv;
// integer hash of a window cell and the building's seed: exact, so a window is either lit or not
float fHash(vec2 c, float seed) {
  uint h = uint(int(c.x) + 4096) * 73856093u ^ uint(int(c.y) + 4096) * 19349663u ^ uint(seed) * 83492791u;
  h ^= h >> 13u; h *= 0x5bd1e995u; h ^= h >> 15u;
  return float(h & 1023u) / 1023.0;
}
vec3 fPick(float r, vec3 a, vec3 b, vec3 c, vec3 d) { return r < 0.25 ? a : r < 0.5 ? b : r < 0.75 ? c : d; }
/**
 * Interior mapping: the window cell is the front of a room D metres deep; trace the view ray to the room's back wall,
 * side walls, floor or ceiling. Returns radiance before the day/night scale (rgb) and how lit it is.
 */
vec3 fRoom(vec2 f, vec3 V, vec3 T, vec3 B, vec3 N, vec2 cell, float seed, float lit, out float blind) {
  float lt = max(length(T), 1e-3), lb = max(length(B), 1e-3);
  vec3 Tn = T / lt, Bn = B / lb;
  const float D = 4.5;
  vec3 rd = vec3(dot(V, Tn) / lt, dot(V, Bn) / lb, max(dot(V, -N), 0.02) / D);
  vec3 ro = vec3(f, 0.0);
  vec3 tt = (step(vec3(0.0), rd) - ro) / rd;
  tt.z = (1.0 - ro.z) / rd.z;
  float t = min(min(tt.x, tt.y), tt.z);
  vec3 h = ro + rd * t;
  float r1 = fHash(cell, seed + 11.0), r2 = fHash(cell, seed + 23.0), r3 = fHash(cell, seed + 37.0);
  vec3 wallC = fPick(r1, vec3(0.62, 0.58, 0.5), vec3(0.55, 0.57, 0.58), vec3(0.6, 0.52, 0.42), vec3(0.45, 0.5, 0.44));
  vec3 floorC = fPick(r2, vec3(0.3, 0.2, 0.12), vec3(0.42, 0.3, 0.2), vec3(0.25, 0.25, 0.27), vec3(0.4, 0.36, 0.3));
  vec3 c;
  float shadeK;
  if (t == tt.z) {
    c = wallC; shadeK = 0.75;
    // furniture against the back wall (a sofa, a desk, shelves) and a picture
    float fx = 0.18 + 0.5 * r3;
    if (h.y < 0.28 + 0.12 * r2 && abs(h.x - fx) < 0.22) { c = fPick(r3, vec3(0.2, 0.22, 0.3), vec3(0.35, 0.25, 0.18), vec3(0.5, 0.48, 0.45), vec3(0.15, 0.15, 0.15)); shadeK = 0.6; }
    else if (h.y > 0.5 && h.y < 0.72 && abs(h.x - (1.0 - fx)) < 0.12) { c = vec3(0.7, 0.62, 0.45) * (0.6 + 0.6 * r1); }
  } else if (t == tt.y) {
    if (rd.y < 0.0) { c = floorC; shadeK = 0.55; }
    else { c = vec3(0.8, 0.79, 0.76); shadeK = 0.85; }
  } else { c = wallC; shadeK = 0.62; }
  // daylight falls off into the room; a ceiling light pools in the middle at night
  float depthK = mix(1.0, 0.35, h.z);
  vec3 day = c * shadeK * depthK;
  float lamp = exp(-4.0 * dot(h.xz - vec2(0.5, 0.5), h.xz - vec2(0.5, 0.5)));
  vec3 night = c * (0.35 + 0.9 * lamp) * vec3(1.0, 0.82, 0.58);
  // blinds or curtains on some windows (in the window plane, no parallax)
  float b = fHash(cell, seed + 51.0);
  blind = 0.0;
  if (b < 0.3 && f.y > 1.0 - (0.15 + 0.5 * fHash(cell, seed + 61.0))) blind = 1.0;
  else if (b > 0.8 && (f.x < 0.2 || f.x > 0.8)) blind = 1.0;
  vec3 col = day * uDaylight * 0.32 + night * lit * 1.6;
  vec3 fabric = fPick(fHash(cell, seed + 71.0), vec3(0.82, 0.8, 0.74), vec3(0.75, 0.7, 0.6), vec3(0.6, 0.62, 0.66), vec3(0.7, 0.55, 0.45));
  vec3 blindCol = fabric * (uDaylight * 0.45 + lit * 1.3 * vec3(1.0, 0.8, 0.55));
  return mix(col, blindCol, blind);
}`)
      .replace('#include <map_fragment>', /* glsl */ `
vec3 ocNg = normalize(vOcN);
vec3 ocVc = vColor.rgb;
vec2 fCell = floor(vFUv);
float fLayer = (abs(fCell.x - vFac.z) < 0.5 && fCell.y < 0.5) ? vFac.y : vFac.x;
vec4 fTex = texture(uFacade, vec3(vFUv, fLayer));
vec4 fAux = texture(uFacAux, vec3(vFUv, fLayer));
float fWall = fTex.a;
float fGlass = fAux.r * (1.0 - fWall);
int ocSid = int(vSurf + 0.5);
// one brick bond per building (from its seed): running bond mostly, some common bond, some Flemish
if (ocSid == S_BRICK_RUNNING) { float r = fract(vFac.w * 0.6180339 + 0.13); ocSid = r < 0.55 ? S_BRICK_RUNNING : r < 0.8 ? S_BRICK_COMMON : S_BRICK_FLEMISH; }
if (abs(fLayer - T_PLINTH) < 0.5) { ocSid = S_STONE; ocVc = vec3(0.39, 0.36, 0.31); }
OcOut ocS = ocSurface(ocSid, ocNg, ocVc, 0.8, 0.0);
// tile frame: exact dP/du and dP/dv from screen derivatives (the bay width and storey height in metres)
vec3 fdpx = dFdx(vOcP), fdpy = dFdy(vOcP);
vec2 fdux = dFdx(vFUv), fduy = dFdy(vFUv);
float fDet = fdux.x * fduy.y - fdux.y * fduy.x;
vec3 fT = abs(fDet) > 1e-14 ? (fdpx * fduy.y - fdpy * fdux.y) / fDet : normalize(cross(vec3(0.0, 1.0, 0.0), ocNg)) * 3.0;
vec3 fB = abs(fDet) > 1e-14 ? (fdpy * fdux.x - fdpx * fduy.x) / fDet : vec3(0.0, 3.2, 0.0);
if (dot(fT, fT) > 400.0 || dot(fB, fB) > 400.0) { fT = normalize(cross(vec3(0.0, 1.0, 0.0), ocNg)) * 3.0; fB = vec3(0.0, 3.2, 0.0); }
vec3 fTn = normalize(fT - ocNg * dot(fT, ocNg)), fBn = normalize(fB - ocNg * dot(fB, ocNg));
vec2 fnxy = fAux.gb * 2.0 - 1.0;
vec3 fTileN = normalize(fTn * fnxy.x + fBn * fnxy.y + ocNg * sqrt(max(0.0, 1.0 - dot(fnxy, fnxy))));
// compose: walls from the surface, frames and doors from the tile, glass from the room behind it
vec3 fAlb = mix(fTex.rgb, ocS.alb, fWall);
float fRough = mix(0.5, ocS.rough, fWall);
vec3 fN = normalize(mix(fTileN, ocS.nW, fWall));
float fAO = mix(fAux.a, ocS.ao, fWall);
// lit windows at night (same share and hash as before: shops more often)
float fShare = 0.34 + 0.18 * fract(vFac.w * 0.137) + (fCell.y < 0.5 ? 0.3 : 0.0);
float fLit = step(fHash(fCell, vFac.w), fShare);
vec2 fW = fwidth(vFUv);
float fFar = smoothstep(0.25, 0.7, max(fW.x, fW.y));
fLit = mix(fLit, fShare, fFar);
float fNight = clamp((uWin.r - 0.22) / 0.78, 0.0, 1.0);
float fBlind;
vec3 fRoomC = fRoom(fract(vFUv), normalize(vOcP - cameraPosition), fT, fB, ocNg, fCell, vFac.w, fLit * fNight, fBlind);
// far away the rooms average out to a dim, slightly warm glass
fRoomC = mix(fRoomC, vec3(0.06, 0.06, 0.07) * uDaylight + vec3(0.9, 0.72, 0.5) * fLit * fNight * 0.7, fFar * 0.7);
vec2 fPane = vec2(fHash(fCell, vFac.w + 91.0), fHash(fCell, vFac.w + 97.0)) - 0.5;
vec3 fGlassN = normalize(ocNg + (fTn * fPane.x + fBn * fPane.y) * 0.025);
fAlb = mix(fAlb, vec3(0.015), fGlass * (1.0 - fBlind));
fRough = mix(fRough, mix(0.035, 0.7, fBlind), fGlass);
fN = normalize(mix(fN, fGlassN, fGlass));
fAO = mix(fAO, 1.0, fGlass);
vec3 fEmit = fRoomC * fGlass;
diffuseColor.rgb *= fAlb;`)
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(fRough, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = ocS.metal * fWall;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(fN, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += fEmit;')
      .replace('#include <aomap_fragment>', /* glsl */ `
reflectedLight.indirectDiffuse *= fAO;
reflectedLight.indirectSpecular *= mix(fAO, 1.0, 0.5);
reflectedLight.directDiffuse *= mix(1.0, fAO, 0.6);`);
  };
  return mat;
}
