// Shadow pass program churn. three draws every shadow caster with one shared depth material, so whenever an instanced
// caster follows a plain one (or an instanced one with instance colours follows one without), the renderer re-derives
// that material's program parameters and cache key for the draw: per-frame CPU and garbage that grows with every caster
// and every cascade. Instanced casters get depth materials of their own instead, one per variant, so consecutive
// shadow draws keep their program. Call once the scene is built (before the shader warm-up, which then compiles them).
import * as THREE from 'three';

export function separateInstancedDepth(root: THREE.Object3D): number {
  const plain = new THREE.MeshDepthMaterial();
  const coloured = new THREE.MeshDepthMaterial();
  plain.name = 'depth-instanced';
  coloured.name = 'depth-instanced-colour';
  let n = 0;
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || !im.castShadow || im.customDepthMaterial) return;
    const m = im.material as THREE.Material | THREE.Material[];
    // cut-outs (alpha test, alpha to coverage, maps) keep three's own per-material depth variant
    if (Array.isArray(m) || m.alphaTest > 0 || m.alphaToCoverage || (m as THREE.MeshStandardMaterial).map) return;
    im.customDepthMaterial = im.instanceColor ? coloured : plain;
    n++;
  });
  return n;
}
