// Shared silhouette and instancing budget checks; no GPU needed.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { buildHumanGeometry } = await server.ssrLoadModule('/src/art/humanGeometry.ts');
  const { makePerson, animatePerson } = await server.ssrLoadModule('/src/art/person.ts');
  const { createCrowd, renderCrowd } = await server.ssrLoadModule('/src/systems/crowdRender.ts');
  const { speciesGeometries } = await server.ssrLoadModule('/src/systems/map/props.ts');
  const { nearTree } = await server.ssrLoadModule('/src/systems/render/trees.ts');
  const parts = buildHumanGeometry();
  const finite = geometry => {
    for (const name of ['position', 'normal', 'color']) assert.ok([...geometry.getAttribute(name).array].every(Number.isFinite), `${name} finite`);
    const n = geometry.getAttribute('normal');
    for (let i=0; i<n.count; i++) assert.ok(Math.abs(Math.hypot(n.getX(i),n.getY(i),n.getZ(i))-1)<(n.array.BYTES_PER_ELEMENT===1?0.015:0.001),'unit surface normals');
  };
  for (const geometry of Object.values(parts)) finite(geometry);
  const triangles = (parts.torso.getAttribute('position').count + parts.head.getAttribute('position').count + parts.hair.getAttribute('position').count + 2*(parts.leg.getAttribute('position').count + parts.arm.getAttribute('position').count + parts.hand.getAttribute('position').count))/3;
  assert.ok(triangles<2200,'a complete person must stay under 2,200 triangles');
  const rig=makePerson(new THREE.Color('#799994'),new THREE.Color('#424959'),new THREE.Color('#b77b56'),new THREE.Color('#3c3027'));
  let playerMeshes=0;rig.root.traverse(o=>{if(o.isMesh)playerMeshes++;});assert.equal(playerMeshes,5,'player keeps five body draw calls');
  rig.root.updateMatrixWorld();const bounds=new THREE.Box3().setFromObject(rig.root);
  assert.ok(bounds.min.y>=-0.005 && bounds.max.y>1.74 && bounds.max.y<1.83,'feet on ground and believable adult eye/height');
  assert.ok(bounds.max.x-bounds.min.x<0.7,'arms fit the existing player capsule');
  animatePerson(rig,Math.PI/2,1);assert.ok(rig.armR.rotation.x>0 && rig.legL.rotation.x>0,'existing opposite-arm walk cycle retained');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 16/9, .1, 300);
  camera.position.set(0,2,20);camera.lookAt(0,1,0);camera.updateMatrixWorld();
  const ped = id => ({id,active:true,hidden:false,pos:new THREE.Vector3((id%10)-4.5,0,-Math.floor(id/10)),scale:1,heading:0,tilt:0,shirt:new THREE.Color('#799994'),pants:new THREE.Color('#424959'),skin:new THREE.Color('#b77b56'),hair:new THREE.Color('#3c3027'),walkPhase:id*.4,moveAmount:.5,armPose:'walk',prop:null,dog:null});
  const w={scene,camera,peds:Array.from({length:60},(_,id)=>ped(id))};w.crowd=createCrowd(w,64);renderCrowd(w);
  const batches=Object.values(w.crowd).filter(p=>p.mesh.count>0).length;
  assert.equal(batches,9,'60 shaped people use nine instanced body-part batches');
  assert.equal(w.crowd.handL.mesh.count,60);assert.equal(w.crowd.handR.mesh.count,60);
  const trees=speciesGeometries().map((g,i)=>{finite(g);g.computeBoundingBox();assert.ok(g.boundingBox.min.y>=-.03 && g.boundingBox.max.y>6 && g.boundingBox.max.y<8,'tree metre scale');const tris=g.getAttribute('position').count/3;assert.ok(tris<=96,'far tree budget');const near=nearTree(i);finite(near.wood);finite(near.leaves);const nearTriangles=(near.wood.getAttribute('position').count+near.leaves.getAttribute('position').count)/3;assert.ok(nearTriangles<=480,'near tree budget');return {species:i,farTriangles:tris,nearTriangles};});
  console.log(JSON.stringify({pass:true,humanTriangles:triangles,adultHeight:bounds.max.y,batchesFor60People:batches,trees}));
} finally { await server.close(); }
