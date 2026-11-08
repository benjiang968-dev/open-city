// Starting-car departure validation against real Rapier static geometry; no renderer required.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import * as THREE from 'three';
import R from '@dimforge/rapier3d-compat';
await R.init();
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
 const {initialDepartureClear,spawnInitialVehicles}=await server.ssrLoadModule('/src/systems/vehicles.ts');
 const {TUNING}=await server.ssrLoadModule('/src/tuning.ts');
 const spec=TUNING.vehicles.types.sedan,spot={x:0,y:0,z:0,heading:0,cls:'residential',street:'Test St',lot:-1,edge:0,s:0};
 const fixture=(height=()=>0)=>{
  const physics=new R.World({x:0,y:-15,z:0});
  const corners=[[-100,-100],[100,-100],[100,100],[-100,100]];
  physics.createCollider(R.ColliderDesc.trimesh(Float32Array.from(corners.flatMap(([x,z])=>[x,height(x,z),z])),Uint32Array.from([0,2,1,0,3,2])));
  physics.step();
  return{R,physics,scene:new THREE.Scene(),vehicles:[],colliderOwner:new Map(),city:{spawn:{x:0,z:0},heightAt:height,isRoad:()=>true,isBlocked:()=>false,isWater:()=>false,parkingSpots:[]}};
 };
 const flat=fixture();assert.equal(initialDepartureClear(flat,spot,spec),true);
 const gentle=fixture((_x,z)=>z*.05);assert.equal(initialDepartureClear(gentle,spot,spec),true);
 const steep=fixture((_x,z)=>-z*.36);assert.equal(initialDepartureClear(steep,spot,spec),false,'steep junction approach is unsuitable for the first drive');
 const cross=fixture(x=>x*.15);assert.equal(initialDepartureClear(cross,spot,spec),false,'tilted wheel tracks are rejected');
 const lip=fixture();lip.city.heightAt=(_x,z)=>z>8?.2:0;assert.equal(initialDepartureClear(lip,spot,spec),false,'abrupt surface lip is rejected');
 flat.physics.createCollider(R.ColliderDesc.cylinder(2,.15).setTranslation(0,2,12));flat.physics.step();
 assert.equal(initialDepartureClear(flat,spot,spec),false,'full departing chassis detects a pole beyond the parked footprint');
 // Changing fresh placement preserves the stable vehicle slot IDs, types and ownership used by save restoration.
 const selection=fixture((x,z)=>x<10?-z*.36:0);
 selection.city.parkingSpots=[{...spot},{...spot,x:30},{...spot,x:45}];
 // Dormant windscreen crack decals need a canvas; this CPU check never draws those textures.
 const noop=()=>{};globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({beginPath:noop,moveTo:noop,lineTo:noop,stroke:noop,ellipse:noop})})};
 spawnInitialVehicles(selection);
 assert.deepEqual(selection.vehicles.map(v=>v.id),[0,1,2]);
 assert.deepEqual(selection.vehicles.map(v=>v.type),TUNING.vehicles.playerCarSpawn);
 assert.deepEqual(selection.vehicles.map(v=>v.owned),[true,false,false]);
 assert.equal(selection.vehicles[0].px,30,'owned car takes the nearest suitable existing spot');
 assert.equal(selection.vehicles[1].px,0,'other starting cars retain nearest available spots');
 const fresh=fixture();fresh.city.parkingSpots=[{...spot},{...spot,x:30},{...spot,x:45}];
 fresh.physics.createCollider(R.ColliderDesc.cylinder(2,.15).setTranslation(0,2,12));
 assert.equal(initialDepartureClear(fresh,spot,spec),true,'new colliders are absent from Rapier queries before refresh');
 spawnInitialVehicles(fresh);
 assert.equal(fresh.vehicles[0].px,30,'spawn boundary refresh rejects an unstepped pole before choosing a pose');
 const legacy=fixture((x,z)=>x<10?-z*.36:0);legacy.startingLayout='legacy';
 legacy.city.parkingSpots=[{...spot},{...spot,x:30},{...spot,x:45}];
 spawnInitialVehicles(legacy);
 assert.equal(legacy.vehicles[0].px,0,'legacy saves retain the exact original nearest-spot reservations');
 assert.deepEqual(legacy.vehicles.map(v=>v.id),[0,1,2]);
 delete globalThis.document;
 for(const w of[flat,gentle,steep,cross,lip,selection,fresh,legacy])w.physics.free();
 console.log('PASS initial-car gentle/steep grades, cross-slope, ground lip, static pole, stable slots and legacy reservations');
}finally{await server.close();}
