// Material assignment for the generators' instanced props (lamp posts, benches, signals, signs, bus shelters,
// gravestones): their plain vertex-colour materials become world materials, so each part shows its surface (painted
// metal, galvanised steel, wood, granite) from the palette (render/palette.ts). Trees are handled by trees.ts.
import * as THREE from 'three';
import type { Look } from './look';
import { makeWorldMaterial } from './worldMaterial';

export function upgradePropMaterials(root: THREE.Object3D, look: Look): number {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  let n = 0;
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || /^trees-/.test(im.name)) return;
    const m = im.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m) || !m.isMeshStandardMaterial || !m.vertexColors || !im.geometry.getAttribute('aSurf')) return;
    const key = `${m.roughness.toFixed(2)}:${m.metalness.toFixed(2)}`;
    let w = cache.get(key);
    if (!w) cache.set(key, (w = makeWorldMaterial(look, { name: `props-${key}`, roughness: m.roughness, metalness: m.metalness })));
    m.dispose();
    im.material = w;
    im.castShadow = true;
    im.receiveShadow = true;
    n++;
  });
  return n;
}
