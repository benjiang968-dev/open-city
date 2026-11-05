// Street furniture for the Georgetown world, all instanced: trees (three low-poly species, data trees plus street trees
// along the shopping streets), globe street lamps with night pools, benches, mast-arm signals at signalised junctions,
// stop signs, bus shelters and the cemetery's gravestones. Posts and trunks near roads get colliders.
import * as THREE from 'three';
import { TUNING } from '../../tuning';
import type { GeoDoc } from './geoDoc';
import { hashStr, pointInPoly, rand, SegGrid } from './geoDoc';
import { lin, MeshBuf, shade, type PhysChunks, type RenderChunks } from './meshKit';
import { pointAtS, type Arm, type RNode, type RoadNet } from './roadNet';
import type { NetMeshInfo } from './roadMesh';
import { B, K, type GeoRaster } from './terrain';

const G = TUNING.geo;

// ----------------------------------------------------------------------------------------- art constants
const STREET_TREE_STEP = 12; // m between street trees on shopping streets
const LAMP_HEAD = 4.6; // m: globe height above the lamp base
const GREENS = [0x5c9e47, 0x4f8a3e, 0x76b051, 0x3f7a3a, 0x88b84b, 0x6aa04a];
const CONIFER = [0x3b6b45, 0x2f5e3c, 0x46784c];
const SHOPPING = [{ name: 'M St NW', maxX: 362 }, { name: 'Wisconsin Ave NW', minZ: -30 }];

interface TreeSpot { x: number; y: number; z: number; s: number; sp: number; c: number; yaw: number; rank: number }

export function buildProps(doc: GeoDoc, ras: GeoRaster, net: RoadNet, info: NetMeshInfo, extraLamps: { x: number; y: number; z: number; ax: number; az: number }[], chunks: RenderChunks, phys: PhysChunks, root: THREE.Group, lampMat: THREE.MeshBasicMaterial, lampPoolMat: THREE.MeshBasicMaterial) {
  let tris = 0;
  const near = new SegGrid(16);
  const roadDist = (x: number, z: number) => {
    let d = Infinity;
    info.edgeGrid.query(x, z, (_s, id, dd) => { const e = net.edges[id]; if (!e.deck) d = Math.min(d, dd - e.hw); });
    return d;
  };

  // ------------------------------------------------------------------------------------- lamps
  const lamps: { x: number; y: number; z: number }[] = [];
  // (not where the road now runs: Washington Circle is snapped to a true circle, which put a few data lamps in its lanes)
  for (const p of doc.props) if (p[2] === 'lamp' && roadDist(p[0], p[1]) > 0.3) lamps.push({ x: p[0], y: ras.heightAt(p[0], p[1]), z: p[1] });
  for (const l of extraLamps) lamps.push({ x: l.x, y: l.y, z: l.z });
  const lampPositions = new Float32Array(lamps.length * 3);
  lamps.forEach((l, i) => { lampPositions[i * 3] = l.x; lampPositions[i * 3 + 1] = l.y; lampPositions[i * 3 + 2] = l.z; });
  const lampGrid = new SegGrid(16);
  lamps.forEach((l, i) => lampGrid.add(l.x, l.z, l.x, l.z, i, 4));
  {
    const pole = new MeshBuf();
    const dark = lin(0x22282b);
    pole.cyl(0, 0, 0, 0.22, 0.17, 0.6, 6, dark);
    pole.cyl(0, 0.6, 0, 0.085, 0.07, 3.55, 5, dark, false);
    pole.cyl(0, 4.15, 0, 0.16, 0.12, 0.2, 6, dark);
    pole.cyl(0, 4.92, 0, 0.12, 0, 0.22, 5, dark);
    const poles = inst(pole.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }), lamps.length);
    const globe = inst(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 1.15, 1).translate(0, LAMP_HEAD, 0), lampMat, lamps.length);
    if (!lampPoolMat.map) {
      // soft round pool of light (the day/night system fades it in)
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g2 = cv.getContext('2d')!;
      const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,214,150,0.9)');
      grad.addColorStop(0.35, 'rgba(255,196,120,0.38)');
      grad.addColorStop(1, 'rgba(255,190,110,0)');
      g2.fillStyle = grad;
      g2.fillRect(0, 0, 64, 64);
      lampPoolMat.map = new THREE.CanvasTexture(cv);
      lampPoolMat.needsUpdate = true;
    }
    const poolGeo = new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2).translate(0, 0.08, 0);
    const pools = inst(poolGeo, lampPoolMat, lamps.length);
    const m = new THREE.Matrix4();
    lamps.forEach((l, i) => {
      m.makeTranslation(l.x, l.y, l.z);
      poles.setMatrixAt(i, m);
      globe.setMatrixAt(i, m);
      pools.setMatrixAt(i, m);
      phys.cylinder(l.x, l.y, l.z, 0.16, 4.3);
    });
    pools.renderOrder = 1;
    poles.name = 'lamp-poles'; globe.name = 'lamp-globes'; pools.name = 'lamp-pools';
    for (const im of [poles, globe, pools]) { im.computeBoundingSphere(); root.add(im); }
    tris += lamps.length * (pole.tris + 20 + 2);
  }

  // ------------------------------------------------------------------------------------- trees
  const trees: TreeSpot[] = [];
  const treeGrid = new SegGrid(12);
  const cemetery = doc.parks.find((p) => p.kind === 'landuse=cemetery')?.pts;
  const addTree = (x: number, z: number, street: boolean) => {
    const r = rand(hashStr(`${Math.round(x * 10)},${Math.round(z * 10)}`));
    const park = (ras.kindAt(x, z) & K.PARK) !== 0;
    const inCem = cemetery ? pointInPoly(x, z, cemetery) : false;
    const sp = street ? 2 : (inCem || (park && r() < 0.3)) && r() < 0.6 ? 1 : 0;
    const c = sp === 1 ? CONIFER[Math.floor(r() * CONIFER.length)] : GREENS[Math.floor(r() * GREENS.length)];
    const s = street ? 0.8 + r() * 0.25 : 0.75 + r() * 0.65;
    trees.push({ x, y: ras.heightAt(x, z), z, s, sp, c, yaw: r() * Math.PI * 2, rank: r() });
    treeGrid.add(x, z, x, z, trees.length - 1, 4);
  };
  for (const p of doc.props) if (p[2] === 'tree') {
    const k = ras.kindAt(p[0], p[1]);
    if (k & (K.ROAD | K.BUILDING | K.WATER)) continue;
    addTree(p[0], p[1], false);
  }
  // street trees on the shopping streets, where the sidewalk has room
  const busStops = doc.props.filter((p) => p[2] === 'bus_stop');
  const pits = new MeshBuf();
  for (const e of net.edges) {
    if (e.deck) continue;
    // (imported data brings its own street trees as synthesized props; only the knowledge-based map plants them here)
    const spec = doc.meta.synthetic ? SHOPPING.find((s) => s.name === e.name) : undefined;
    if (!spec) continue;
    for (const side of [-1, 1]) {
      if (!(side < 0 ? e.swL : e.swR)) continue;
      for (let s = e.trimA + 7; s < e.L - e.trimB - 7; s += STREET_TREE_STEP) {
        const q = pointAtS(e, s);
        if (spec.maxX !== undefined && q.x > spec.maxX) continue;
        if (spec.minZ !== undefined && q.z < spec.minZ) continue;
        const o = (e.hw + 0.9) * side;
        const x = q.x - q.uz * o, z = q.z + q.ux * o;
        const k = ras.kindAt(x, z);
        if (!(k & K.WALK) || (k & (K.ROAD | K.BUILDING | K.LOT))) continue;
        if (e.cuts.some((c) => c[0] === side && s > c[1] - 3 && s < c[2] + 3)) continue;
        if (info.crossings.some((c) => Math.hypot(c.x - x, c.z - z) < 7)) continue;
        if (busStops.some((b) => Math.hypot(b[0] - x, b[1] - z) < 8)) continue;
        let clash = false;
        lampGrid.query(x, z, (_s, _p, d) => { if (d < 3) clash = true; });
        treeGrid.query(x, z, (_s, _p, d) => { if (d < 4.5) clash = true; });
        if (clash) continue;
        addTree(x, z, true);
        const y = ras.heightAt(x, z) + 0.012;
        const ux = q.ux * 0.6, uz = q.uz * 0.6, rx = -q.uz * 0.6, rz = q.ux * 0.6;
        chunks.buf('decal', x, z).quad(x - ux - rx, y, z - uz - rz, x + ux - rx, y, z + uz - rz, x + ux + rx, y, z + uz + rz, x - ux + rx, y, z - uz + rz, lin(0x4a3a2c), 0, 1, 0);
      }
    }
  }
  void pits;
  const species = speciesGeometries();
  const treeMeshes: THREE.InstancedMesh[] = [];
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  for (let sp = 0; sp < 3; sp++) {
    const list = trees.filter((t) => t.sp === sp).sort((a, b) => a.rank - b.rank);
    const im = inst(species[sp], treeMat, list.length);
    im.name = `trees-${sp}`;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const base = new THREE.Color(sp === 1 ? CONIFER[0] : GREENS[0]);
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      m.compose(v.set(t.x, t.y - 0.1, t.z), q, sc.set(t.s, t.s * (0.9 + (t.rank % 0.1) * 3), t.s));
      im.setMatrixAt(i, m);
      col.setHex(t.c);
      im.setColorAt(i, col.setRGB(col.r / base.r, col.g / base.g, col.b / base.b));
      if (roadDist(t.x, t.z) < G.treeColliderRoadDist) phys.cylinder(t.x, t.y, t.z, 0.2 * t.s, 2.4 * t.s);
    });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true;
    im.computeBoundingSphere();
    root.add(im);
    treeMeshes.push(im);
    tris += list.length * (species[sp].getAttribute('position').count / 3);
  }

  // ------------------------------------------------------------------------------------- benches
  const footGrid = new SegGrid(24);
  for (const f of doc.footways) if (f.kind === 'footway' || f.kind === 'path' || f.surface === 'paving_stones') footGrid.addLine(f.pts, 0, 12);
  {
    const benches = doc.props.filter((p) => p[2] === 'bench');
    const g = new MeshBuf();
    const wood = lin(0x8a5a36), iron = lin(0x26292c);
    for (const x of [-0.75, 0.75]) g.box(x - 0.05, 0, -0.25, x + 0.05, 0.45, 0.25, iron);
    for (let k = 0; k < 3; k++) g.box(-0.95, 0.42, -0.24 + k * 0.17, 0.95, 0.47, -0.12 + k * 0.17, wood);
    for (let k = 0; k < 2; k++) g.box(-0.95, 0.6 + k * 0.18, 0.24, 0.95, 0.72 + k * 0.18, 0.29, wood);
    const im = inst(g.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), benches.length);
    im.name = 'benches';
    const m = new THREE.Matrix4();
    benches.forEach((p, i) => {
      // face the nearest path (back toward the lawn), else a road
      let best = Infinity, yaw = (hashStr(`${p[0]}${p[1]}`) % 628) / 100;
      footGrid.query(p[0], p[1], (seg, _pl, d, t) => {
        if (d >= best) return;
        best = d;
        const S = footGrid.segs, o = seg * 5;
        const qx = S[o] + (S[o + 2] - S[o]) * t, qz = S[o + 1] + (S[o + 3] - S[o + 1]) * t;
        yaw = Math.atan2(p[0] - qx, p[1] - qz); // +z of the bench (its back) points away from the path
      });
      m.makeRotationY(yaw).setPosition(p[0], ras.heightAt(p[0], p[1]), p[1]);
      im.setMatrixAt(i, m);
    });
    im.castShadow = true;
    im.computeBoundingSphere();
    root.add(im);
    tris += benches.length * g.tris;
  }

  // ------------------------------------------------------------------------------------- signals and stop signs
  const inbound = (A: Arm) => {
    const e = A.edge;
    return A.atStart ? e.bwd : e.fwd;
  };
  /** Per signal head: x, y, z (the head's top), yaw, node id, and the arm direction ux, uz (away from the node). */
  let signalHeads = new Float32Array(0);
  const sigSpots: { x: number; y: number; z: number; ux: number; uz: number; len: number; heads: number[]; node: number }[] = [];
  const stopSpots: { x: number; y: number; z: number; ux: number; uz: number }[] = [];
  for (const n of net.nodes) {
    if (!n.signals && !n.stop && !n.arms.some((A) => A.stop)) continue;
    if (n.roundabout) continue;
    for (const A of n.arms) {
      const nIn = inbound(A);
      if (!nIn) continue;
      if (!n.signals && !n.stop && !A.stop) continue; // a stop sign on some approaches only
      const e = A.edge;
      const s = Math.min(e.L / 2, A.trim + (n.signals ? 2.5 : 1.5));
      const q = pointAtS(e, A.atStart ? s : e.L - s);
      const ux = A.atStart ? q.ux : -q.ux, uz = A.atStart ? q.uz : -q.uz; // pointing away from the node
      // the driver's right when approaching = arm's m side = (uz, -ux)
      const mx = uz, mz = -ux;
      const mSide = A.atStart ? -1 : 1; // m side in edge terms: left if leaving from the start
      const sw = mSide < 0 ? e.swL : e.swR;
      const off = e.hw + (sw ? 0.7 : 0.6);
      const px = q.x + mx * off, pz = q.z + mz * off;
      const y = ras.heightAt(px, pz);
      if (n.signals) {
        const lw = (2 * e.hw) / e.lanes.length;
        const heads: number[] = [];
        for (let k = 0; k < nIn; k++) heads.push(off - e.hw + (k + 0.5) * lw);
        sigSpots.push({ x: px, y, z: pz, ux, uz, len: off - e.hw + nIn * lw + 0.3, heads, node: n.id });
      } else stopSpots.push({ x: px, y, z: pz, ux, uz });
      phys.cylinder(px, y, pz, 0.12, 3);
    }
  }
  void ({} as RNode);
  {
    const poleG = new MeshBuf();
    poleG.cyl(0, 0, 0, 0.16, 0.13, 6.3, 8, lin(0x6d7276));
    const armG = new MeshBuf();
    armG.box(0, 5.85, -0.07, 1, 6.0, 0.07, lin(0x6d7276));
    const headG = new MeshBuf();
    headG.box(-0.2, -1.05, -0.17, 0.2, 0, 0.17, lin(0x2a2c1e));
    headG.box(-0.24, -1.09, -0.02, 0.24, 0.04, 0.0, lin(0xd9b52b));
    // unlit lenses (dark glass): the live light is drawn over them by signalHeads.ts from the traffic signal state
    const lens = [0x3a1512, 0x3a2c10, 0x12301c];
    lens.forEach((c, k) => headG.box(-0.11, -0.3 - k * 0.32, -0.24, 0.11, -0.08 - k * 0.32, -0.17, lin(c), shade(lin(c), 0.5)));
    const nHeads = sigSpots.reduce((s, p) => s + p.heads.length, 0);
    signalHeads = new Float32Array(nHeads * 7);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 });
    const poles = inst(poleG.toGeometry(), mat, sigSpots.length);
    const arms = inst(armG.toGeometry(), mat, sigSpots.length);
    const heads = inst(headG.toGeometry(), mat, nHeads);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let h = 0;
    sigSpots.forEach((p, i) => {
      // local +x of the arm points from the pole across the inbound lanes (= -m side = (-uz, ux))
      const yaw = Math.atan2(-p.ux, -p.uz);
      q.setFromAxisAngle(up, yaw);
      m.compose(v.set(p.x, p.y, p.z), q, sc.set(1, 1, 1));
      poles.setMatrixAt(i, m);
      m.compose(v, q, sc.set(p.len, 1, 1));
      arms.setMatrixAt(i, m);
      for (const along of p.heads) {
        const hx = p.x + -p.uz * along, hz = p.z + p.ux * along;
        // heads face the approaching traffic (+u): local -z faces +u
        const yawH = Math.atan2(-p.ux, -p.uz);
        q.setFromAxisAngle(up, yawH);
        m.compose(v.set(hx, p.y + 5.85, hz), q, sc.set(1, 1, 1));
        heads.setMatrixAt(h, m);
        signalHeads.set([hx, p.y + 5.85, hz, yawH, p.node, p.ux, p.uz], h * 7);
        h++;
      }
    });
    poles.name = 'signal-poles'; arms.name = 'signal-arms'; heads.name = 'signal-heads';
    for (const im of [poles, arms, heads]) { im.castShadow = true; im.computeBoundingSphere(); root.add(im); }
    tris += sigSpots.length * (poleG.tris + armG.tris) + nHeads * headG.tris;

    const postG = new MeshBuf();
    postG.box(-0.04, 0, -0.04, 0.04, 2.5, 0.04, lin(0x9a9ea2));
    const faceG = new MeshBuf();
    const oct = (r: number, z: number, c: number) => {
      for (let k = 0; k < 8; k++) {
        const a0 = ((k + 0.5) / 8) * Math.PI * 2, a1 = ((k + 1.5) / 8) * Math.PI * 2;
        faceG.tri(0, 2.25, z, Math.cos(a0) * r, 2.25 + Math.sin(a0) * r, z, Math.cos(a1) * r, 2.25 + Math.sin(a1) * r, z, c, 0, 0, -1);
        faceG.tri(0, 2.25, z + 0.01, Math.cos(a0) * r, 2.25 + Math.sin(a0) * r, z + 0.01, Math.cos(a1) * r, 2.25 + Math.sin(a1) * r, z + 0.01, lin(0x9a9ea2), 0, 0, 1);
      }
    };
    oct(0.4, -0.05, lin(0xf4f4f0));
    oct(0.35, -0.06, lin(0xc3201f));
    // a white bar suggesting the lettering
    faceG.quad(-0.22, 2.2, -0.065, 0.22, 2.2, -0.065, 0.22, 2.3, -0.065, -0.22, 2.3, -0.065, lin(0xf4f4f0), 0, 0, -1);
    const posts = inst(postG.toGeometry(), mat, stopSpots.length);
    const faces = inst(faceG.toGeometry(), mat, stopSpots.length);
    stopSpots.forEach((p, i) => {
      q.setFromAxisAngle(up, Math.atan2(-p.ux, -p.uz));
      m.compose(v.set(p.x, p.y, p.z), q, sc.set(1, 1, 1));
      posts.setMatrixAt(i, m);
      faces.setMatrixAt(i, m);
    });
    posts.name = 'stop-posts'; faces.name = 'stop-faces';
    for (const im of [posts, faces]) { im.computeBoundingSphere(); root.add(im); }
    tris += stopSpots.length * (postG.tris + faceG.tris);
  }

  // ------------------------------------------------------------------------------------- bus shelters
  {
    const g = new MeshBuf();
    const frame = lin(0x3a4046), glass = lin(0x9fb6c2), roof = lin(0x4d555c);
    g.box(-2, 0, 0.55, 2, 2.4, 0.62, glass, glass); // back panel
    for (const x of [-2, 2]) g.box(x - 0.04, 0, -0.6, x + 0.04, 2.4, 0.62, glass, glass);
    for (const [x, z] of [[-2, 0.6], [2, 0.6], [-2, -0.6], [2, -0.6]]) g.box(x - 0.05, 0, z - 0.05, x + 0.05, 2.45, z + 0.05, frame);
    g.box(-2.15, 2.45, -0.8, 2.15, 2.6, 0.75, roof);
    g.box(-1.4, 0.45, 0.2, 1.4, 0.52, 0.5, lin(0x8a5a36));
    g.box(2.6, 0, -0.75, 2.66, 2.6, -0.69, frame);
    g.box(2.38, 2.0, -0.78, 2.88, 2.6, -0.66, lin(0x1f5c9a));
    const shelters: { x: number; y: number; z: number; yaw: number }[] = [];
    for (const p of busStops) {
      let best = Infinity, ex = 0, ez = 0, side = 1, bestE = -1, bs = 0;
      info.edgeGrid.query(p[0], p[1], (_s, id, d) => {
        const e = net.edges[id];
        if (e.deck || d >= best) return;
        best = d; bestE = id;
      });
      if (bestE < 0) continue;
      const e = net.edges[bestE];
      const pr = net.project(e, p[0], p[1]);
      side = pr.off >= 0 ? 1 : -1;
      bs = pr.s;
      const q = pointAtS(e, bs);
      const sw = side > 0 ? e.swR : e.swL;
      const o = (e.hw + (sw ? G.sidewalkWidth - 0.75 : 1.2)) * side;
      ex = q.x - q.uz * o; ez = q.z + q.ux * o;
      if (ras.kindAt(ex, ez) & (K.BUILDING | K.ROAD)) continue;
      // local +z (the back panel) points away from the road
      const bx = -q.uz * side, bz = q.ux * side;
      shelters.push({ x: ex, y: ras.heightAt(ex, ez), z: ez, yaw: Math.atan2(bx, bz) });
      phys.box(ex + bx * 0.58, ras.heightAt(ex, ez) + 1.2, ez + bz * 0.58, 2, 1.2, 0.06, q.ux, q.uz);
    }
    const im = inst(g.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 }), shelters.length);
    im.name = 'bus-shelters';
    const m = new THREE.Matrix4();
    shelters.forEach((s, i) => { m.makeRotationY(s.yaw).setPosition(s.x, s.y, s.z); im.setMatrixAt(i, m); });
    im.castShadow = true;
    im.computeBoundingSphere();
    root.add(im);
    tris += shelters.length * g.tris;
  }

  // ------------------------------------------------------------------------------------- gravestones
  if (cemetery) {
    const g = new MeshBuf();
    g.box(-0.35, 0, -0.08, 0.35, 0.9, 0.08, lin(0xbfbcb4), lin(0xa9a69e));
    g.box(-0.22, 0.9, -0.08, 0.22, 1.05, 0.08, lin(0xbfbcb4), lin(0xa9a69e));
    const spots: number[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of cemetery) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const r = rand(1789);
    for (let x = minX + 3; x < maxX; x += 4.2)
      for (let z = minZ + 3; z < maxZ; z += 3.4) {
        const jx = x + (r() - 0.5) * 1.6, jz = z + (r() - 0.5) * 1.2;
        if (!pointInPoly(jx, jz, cemetery) || r() < 0.25) continue;
        if (ras.kindAt(jx, jz) & (K.ROAD | K.WALK | K.BUILDING) || ras.bandAt(jx, jz) !== B.NONE) continue;
        let clash = false;
        treeGrid.query(jx, jz, (_s, _p, d) => { if (d < 2) clash = true; });
        footGrid.query(jx, jz, (_s, _p, d) => { if (d < 2.2) clash = true; });
        if (clash) continue;
        spots.push(jx, ras.heightAt(jx, jz), jz, (r() - 0.5) * 0.2);
      }
    const im = inst(g.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), spots.length / 4);
    im.name = 'gravestones';
    const m = new THREE.Matrix4();
    for (let i = 0; i < spots.length / 4; i++) {
      m.makeRotationY(spots[i * 4 + 3]).setPosition(spots[i * 4], spots[i * 4 + 1] - 0.05, spots[i * 4 + 2]);
      im.setMatrixAt(i, m);
    }
    im.computeBoundingSphere();
    root.add(im);
    tris += (spots.length / 4) * g.tris;
  }
  void near;

  return {
    lampPositions,
    signalHeads,
    tris,
    treeCount: trees.length,
    setTreeShare(f: number) {
      for (const im of treeMeshes) im.count = Math.max(0, Math.floor((im.instanceMatrix.count) * f));
    },
    update(_cam: THREE.Vector3, _detail: number, _draw: number) { /* instanced props are culled as a whole */ },
  };
}

function inst(geo: THREE.BufferGeometry, mat: THREE.Material, n: number): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  im.count = n;
  im.matrixAutoUpdate = false;
  return im;
}

/** Three tree species with trunk and crown in one geometry (vertex colours; instance colour tints the crown). */
function speciesGeometries(): THREE.BufferGeometry[] {
  const trunk = lin(0x6b4a2f);
  const mk = (crown: (b: MeshBuf) => void) => {
    const b = new MeshBuf();
    b.cyl(0, 0, 0, 0.24, 0.16, 2.7, 6, trunk, false);
    crown(b);
    return b.toGeometry();
  };
  // crowns in a base green; the per-instance colour is a ratio around 1 so trunks stay brown
  const leaf = lin(GREENS[0]);
  const round = mk((b) => {
    const ico = new THREE.IcosahedronGeometry(2.2, 0);
    const p = ico.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v = (i: number) => [p.getX(i), p.getY(i) * 1.05 + 4.1, p.getZ(i)];
      const a = v(i), c = v(i + 1), d = v(i + 2);
      b.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], shade(leaf, 0.86 + ((i / 3) % 4) * 0.05), (a[0] + c[0] + d[0]) / 3, (a[1] + c[1] + d[1]) / 3 - 4.1, (a[2] + c[2] + d[2]) / 3);
    }
  });
  const cleaf = lin(CONIFER[0]);
  const conifer = mk((b) => {
    b.cyl(0, 1.8, 0, 2.0, 0, 3.4, 7, cleaf, false);
    b.cyl(0, 3.6, 0, 1.6, 0, 3.0, 7, shade(cleaf, 0.93), false);
    b.cyl(0, 5.2, 0, 1.15, 0, 2.6, 7, shade(cleaf, 0.88), false);
  });
  const street = mk((b) => {
    const ico = new THREE.IcosahedronGeometry(1.55, 0);
    const p = ico.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v = (i: number) => [p.getX(i) * 1.05, p.getY(i) * 1.45 + 4.6, p.getZ(i) * 1.05];
      const a = v(i), c = v(i + 1), d = v(i + 2);
      b.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], shade(leaf, 0.86 + ((i / 3) % 4) * 0.05), (a[0] + c[0] + d[0]) / 3, (a[1] + c[1] + d[1]) / 3 - 4.6, (a[2] + c[2] + d[2]) / 3);
    }
  });
  return [round, conifer, street];
}
