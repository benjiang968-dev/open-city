// Every authored pickup rests on an actual collidable shelf/table in every room variant.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }) }) };
try {
 const room = await server.ssrLoadModule('/src/systems/interiors/index.ts');
 const { SolidTags } = await server.ssrLoadModule('/src/systems/objects/solidKinds.ts');
 const { createItems } = await server.ssrLoadModule('/src/systems/worldItems.ts');
 const { seedInteriorCollectibles } = await server.ssrLoadModule('/src/systems/interiorCollectibles.ts');
 const physics = new RAPIER.World({x:0,y:-9.81,z:0});
 const body = physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
 const w = {R:RAPIER,physics,scene:new THREE.Scene(),time:10,started:true,paused:false,
  city:{spawn:{x:0,z:0},pois:['shop','office','warehouse','garage','home','cafe','home','home','home','shop','office','garage','cafe','warehouse'].map((kind,id)=>({id,kind,x:id*25,z:0,door:{x:id*25,z:1}})),isBlocked:()=>false,isRoad:()=>false,isWater:()=>false,heightAt:()=>0,solidTags:new SolidTags()},
  player:{body,mesh:new THREE.Group(),vehicle:null,vy:0},cam:{focus:new THREE.Vector3(),yaw:0},input:{keys:new Set(),pressed:new Set()},hud:{toast:{style:{}}}};
 w.itemsState=createItems(w);w.interiors=room.createInteriors(w);seedInteriorCollectibles(w);
 const unsupported=[];let checked=0;
 for(const entry of w.interiors.entries){
  assert.equal(room.enterInterior(w,w.interiors,entry.id),true);physics.step();
  for(const it of w.itemsState.items.filter(it=>it.authoredKey?.startsWith(`interior-v2/${entry.id}/`))){
   const bottom=it.py-w.itemsState.art[it.type].restY;
   const hit=physics.castRay(new RAPIER.Ray({x:it.px,y:bottom+.04,z:it.pz},{x:0,y:-1,z:0}),.15,true,RAPIER.QueryFilterFlags.ONLY_FIXED);
   checked++;if(!hit||Math.abs(hit.timeOfImpact-.045)>.025)unsupported.push({key:it.authoredKey,bottom,hit:hit?.timeOfImpact});
  }
  room.exitInterior(w,w.interiors);
 }
 assert.deepEqual(unsupported,[],'all portable goods need real support surfaces');
 const count=w.itemsState.items.length;seedInteriorCollectibles(w);assert.equal(w.itemsState.items.length,count);
 console.log(JSON.stringify({pass:true,rooms:w.interiors.entries.length,physicalShelfAndTableItems:checked,duplicateSeeding:false}));physics.free();
}finally{await server.close();}
