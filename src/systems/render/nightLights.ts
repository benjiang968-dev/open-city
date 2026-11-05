// Real light from the street lamps nearest the camera at night: a small fixed pool of point lights (TUNING.quality
// *.lampLights, none on Low) that move to the closest lamp heads when the camera has moved a few metres. Lamps further
// away keep their glowing globes and the soft pools on the ground. The pool size never changes during play, so lights
// coming and going never recompile a shader.
import * as THREE from 'three';
import { TUNING } from '../../tuning';

const LT = TUNING.look;

export interface NightLights {
  lights: THREE.PointLight[];
  /** lamp head positions (x, y, z) */
  heads: Float32Array;
  update(cam: THREE.Vector3, on: number): void;
  /** How many of the lights are in use (the quality preset); the others are switched off. */
  setActive(k: number): void;
}

/** Lamp heads: every instance of the instanced meshes drawn with the city's lamp material (the globes / heads). */
export function findLampHeads(root: THREE.Object3D, lampMat: THREE.Material): Float32Array {
  const out: number[] = [];
  const m = new THREE.Matrix4(), c = new THREE.Vector3(), p = new THREE.Vector3();
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || im.material !== lampMat) return;
    im.geometry.computeBoundingBox();
    im.geometry.boundingBox!.getCenter(c);
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      p.copy(c).applyMatrix4(m);
      out.push(p.x, p.y - 0.25, p.z);
    }
  });
  return Float32Array.from(out);
}

export function createNightLights(scene: THREE.Scene, heads: Float32Array, count: number): NightLights {
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xffc98a, 0, LT.lampLightRange, 2);
    l.castShadow = false;
    l.position.set(0, -1000, 0);
    scene.add(l);
    lights.push(l);
  }
  const best = new Float32Array(Math.max(1, count));
  const bestIdx = new Int32Array(Math.max(1, count));
  const last = new THREE.Vector3(1e9, 0, 1e9);
  const n = heads.length / 3;
  let active = count;
  return {
    lights,
    heads,
    setActive(k: number) {
      active = Math.min(count, k);
      lights.forEach((l, i) => { l.visible = i < active; });
      last.set(1e9, 0, 1e9);
    },
    update(cam: THREE.Vector3, on: number) {
      const I = on * LT.lampLightIntensity;
      for (const l of lights) l.intensity = I;
      if (!active || on <= 0) return;
      if (cam.distanceToSquared(last) < 16) return;
      last.copy(cam);
      // the `count` nearest heads (insertion into a short sorted list; no allocation)
      best.fill(Infinity);
      bestIdx.fill(-1);
      for (let i = 0; i < n; i++) {
        const dx = heads[i * 3] - cam.x, dy = heads[i * 3 + 1] - cam.y, dz = heads[i * 3 + 2] - cam.z;
        const d = dx * dx + dy * dy * 0.25 + dz * dz;
        if (d >= best[count - 1]) continue;
        let k = count - 1;
        while (k > 0 && best[k - 1] > d) { best[k] = best[k - 1]; bestIdx[k] = bestIdx[k - 1]; k--; }
        best[k] = d;
        bestIdx[k] = i;
      }
      for (let k = 0; k < count; k++) {
        const i = bestIdx[k];
        if (i < 0) lights[k].position.set(0, -1000, 0);
        else lights[k].position.set(heads[i * 3], heads[i * 3 + 1], heads[i * 3 + 2]);
      }
    },
  };
}
