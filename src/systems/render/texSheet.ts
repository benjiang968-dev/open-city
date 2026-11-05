// Debug view of the baked surface maps: every layer in a grid, albedo (top half of each cell) above its normal map
// (bottom half), shown full screen. Used by the preview page (?texsheet=1) to check the bake by eye.
import * as THREE from 'three';
import { BAKE_LAYERS } from './surfaces';
import type { Look } from './look';
import { FRAG_OUT } from './bakeShaders';

export function createTexSheet(look: Look): { scene: THREE.Scene; camera: THREE.OrthographicCamera } {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uAlbTex: look.uniforms.uAlbTex, uNrmTex: look.uniforms.uNrmTex, uCount: { value: BAKE_LAYERS.length } },
    vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
    fragmentShader: FRAG_OUT + /* glsl */ `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAlbTex;
uniform sampler2DArray uNrmTex;
uniform float uCount;
in vec2 vUv;
void main() {
  float cols = 9.0, rows = ceil(uCount / cols);
  vec2 g = vec2(vUv.x * cols, (1.0 - vUv.y) * rows);
  vec2 cell = floor(g), f = fract(g);
  float layer = cell.y * cols + cell.x;
  if (layer >= uCount) { gl_FragColor = vec4(0.05, 0.05, 0.06, 1.0); return; }
  vec2 uv = vec2(f.x, 1.0 - fract(f.y * 2.0));
  vec3 c;
  if (f.y < 0.5) c = texture(uAlbTex, vec3(uv, layer)).rgb;
  else { vec4 n = texture(uNrmTex, vec3(uv, layer)); c = vec3(n.xy, 1.0); }
  if (min(f.x, min(f.y, 1.0 - f.y)) < 0.01) c = vec3(0.0);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`,
    depthTest: false,
    depthWrite: false,
  });
  mat.toneMapped = false;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
}
