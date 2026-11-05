// Draw warm-up. renderer.compile() links every program, but some drivers (software GL completely) only build the final
// GPU code the first time a program actually draws pixels with a given state, which shows up as a frame spike the
// first time the player sees, say, a near tree, a bus shelter or rain. This draws one representative of every
// material and mesh kind (plain / instanced / instance colours / vertex colours / shadow casting) on its own, in view
// of a small helper camera, into the game's own framebuffer at boot, so every such first draw happens behind the title.
import * as THREE from 'three';

type Drawable = THREE.Mesh | THREE.Points | THREE.Line;

const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
const sphere = new THREE.Sphere();
const m4 = new THREE.Matrix4();

/** Returns how many representatives were drawn. Call after renderer.compile(), with the scene fully built. */
export function warmDraw(renderer: THREE.WebGLRenderer, scene: THREE.Scene): number {
  const seen = new Set<string>();
  const reps: Drawable[] = [];
  const all: { o: THREE.Object3D; v: boolean }[] = [];
  scene.traverse((o) => {
    const d = o as Drawable;
    if (!(d as THREE.Mesh).isMesh && !(d as THREE.Points).isPoints && !(d as THREE.Line).isLine) return;
    all.push({ o, v: o.visible });
    const im = o as THREE.InstancedMesh;
    const mats = Array.isArray(d.material) ? d.material : [d.material];
    const key = mats.map((m) => m.uuid).join(',') + (im.isInstancedMesh ? `i${im.instanceColor ? 'c' : ''}` : '') +
      (d.geometry.getAttribute('color') ? 'v' : '') + (d.castShadow ? 's' : '') + (d.receiveShadow ? 'r' : '');
    if (seen.has(key)) return;
    seen.add(key);
    reps.push(d);
  });
  // parents (groups) that are hidden would skip their children
  const parents: { o: THREE.Object3D; v: boolean }[] = [];
  for (const { o } of all) for (let p = o.parent; p && p !== scene; p = p.parent) if (!p.visible) { parents.push({ o: p, v: false }); p.visible = true; }
  for (const { o } of all) o.visible = false;
  const vp = new THREE.Vector4();
  renderer.getViewport(vp);
  renderer.setViewport(0, 0, 64, 64);
  for (const d of reps) {
    const im = d as THREE.InstancedMesh;
    const count = im.isInstancedMesh ? im.count : -1;
    if (im.isInstancedMesh && im.count === 0) im.count = 1;
    if (!d.geometry.boundingSphere) d.geometry.computeBoundingSphere();
    sphere.copy(d.geometry.boundingSphere!);
    if (im.isInstancedMesh) { im.getMatrixAt(0, m4); sphere.applyMatrix4(m4); }
    sphere.applyMatrix4(d.matrixWorld);
    const r = Math.max(0.5, Math.min(sphere.radius, 400));
    cam.position.set(sphere.center.x + r * 1.6, sphere.center.y + r * 0.9, sphere.center.z + r * 1.6);
    cam.lookAt(sphere.center);
    cam.near = Math.max(0.05, r * 0.02);
    cam.far = r * 8 + 50;
    cam.updateProjectionMatrix();
    d.visible = true;
    const culled = d.frustumCulled;
    d.frustumCulled = false;
    renderer.render(scene, cam);
    d.frustumCulled = culled;
    d.visible = false;
    if (count >= 0) im.count = count;
  }
  renderer.setViewport(vp);
  for (const { o, v } of all) o.visible = v;
  for (const { o, v } of parents) o.visible = v;
  return reps.length;
}
