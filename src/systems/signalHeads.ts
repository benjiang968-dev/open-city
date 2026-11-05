// Traffic signal lights: the map draws the poles and the signal heads with dark lenses (Georgetown: props.ts); this
// lights the lens each approach is shown (red, amber or green, junctions.ts) with one instanced mesh of small glowing
// squares. Only heads whose light changed are rewritten, from scratch objects (no allocation).
import * as THREE from 'three';
import type { World } from '../world';
import { laneSample, type LanePoint } from './map/cityMap';
import { stopLine, isTrafficLane, LIGHT_GREEN, LIGHT_AMBER, LIGHT_RED, LIGHT_NONE, CTL_SIGNALS } from './junctions';

export interface SignalHeads {
  mesh: THREE.InstancedMesh | null;
  /** Per head: x, y, z, yaw (as the map gives them). */
  heads: Float32Array;
  /** Per head: the lane whose light it shows (-1: none). */
  edgeOf: Int32Array;
  shown: Uint8Array;
}

const COLORS = [new THREE.Color(0x35ff7a), new THREE.Color(0xffb21a), new THREE.Color(0xff2b1c)];
const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const OFF = new THREE.Vector3();
const S1 = new THREE.Vector3(1, 1, 1);
const S0 = new THREE.Vector3(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const LP: LanePoint = { x: 0, y: 0, z: 0, heading: 0 };

export function createSignalHeads(w: World): SignalHeads {
  const src = (w.city as unknown as { geo?: { signalHeads?: Float32Array } }).geo?.signalHeads;
  const n = src ? src.length / 7 : 0;
  const S: SignalHeads = { mesh: null, heads: new Float32Array(n * 4), edgeOf: new Int32Array(n).fill(-1), shown: new Uint8Array(n).fill(255) };
  if (!src || !n) return S;
  const { nodes, edges } = w.city.roads;
  const J = w.junctions;
  for (let i = 0; i < n; i++) {
    const node = src[i * 7 + 4], ux = src[i * 7 + 5], uz = src[i * 7 + 6];
    S.heads.set([src[i * 7], src[i * 7 + 1], src[i * 7 + 2], src[i * 7 + 3]], i * 4);
    if (!nodes[node] || J.nodes[node].kind !== CTL_SIGNALS) continue;
    // the approach driving toward the junction along -u, nearest the head
    let best = -1, bestScore = -Infinity;
    for (const id of nodes[node].in) {
      const e = edges[id];
      if (!isTrafficLane(e)) continue;
      laneSample(e, stopLine(e), LP);
      const align = -(Math.sin(LP.heading) * ux + Math.cos(LP.heading) * uz);
      if (align < 0.5) continue;
      const d = Math.hypot(LP.x - src[i * 7], LP.z - src[i * 7 + 2]);
      const score = align * 10 - d;
      if (score > bestScore) { bestScore = score; best = id; }
    }
    S.edgeOf[i] = best;
  }
  const geo = new THREE.PlaneGeometry(0.24, 0.24);
  geo.rotateY(Math.PI); // the lens faces the head's local -z (toward the traffic)
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.name = 'signal-lights';
  for (let i = 0; i < n; i++) { mesh.setColorAt(i, COLORS[2]); M4.compose(V.set(S.heads[i * 4], S.heads[i * 4 + 1], S.heads[i * 4 + 2]), Q, S0); mesh.setMatrixAt(i, M4); }
  mesh.computeBoundingSphere();
  // the bounding sphere must cover every head whatever lens is lit
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 2;
  w.scene.add(mesh);
  S.mesh = mesh;
  updateSignalHeads(w, S, true);
  return S;
}

/** Light the lens each head should show (only heads whose light changed). */
export function updateSignalHeads(w: World, S: SignalHeads, force = false): void {
  const J = w.junctions;
  if (!S.mesh || (!J.lightsChanged && !force)) return;
  J.lightsChanged = false;
  const mesh = S.mesh, H = S.heads;
  let dirty = false;
  for (let i = 0; i < S.edgeOf.length; i++) {
    const e = S.edgeOf[i];
    const L = e >= 0 ? J.light[e] : LIGHT_NONE;
    if (L === S.shown[i]) continue;
    S.shown[i] = L;
    dirty = true;
    Q.setFromAxisAngle(UP, H[i * 4 + 3]);
    if (L === LIGHT_NONE) {
      M4.compose(V.set(H[i * 4], H[i * 4 + 1], H[i * 4 + 2]), Q, S0);
    } else {
      const k = L === LIGHT_RED ? 0 : L === LIGHT_AMBER ? 1 : 2; // lens row from the top
      OFF.set(0, -0.19 - k * 0.32, -0.25).applyQuaternion(Q);
      M4.compose(V.set(H[i * 4] + OFF.x, H[i * 4 + 1] + OFF.y, H[i * 4 + 2] + OFF.z), Q, S1);
      mesh.setColorAt(i, COLORS[L === LIGHT_GREEN ? 0 : L === LIGHT_AMBER ? 1 : 2]);
    }
    mesh.setMatrixAt(i, M4);
  }
  if (dirty) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
