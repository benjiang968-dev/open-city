// Geometry and cockpit clearance regression. Browser rendering is checked separately.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
 const {buildCarParts,driverSeat,makeCarInterior,carMaterial,makeWheel}=await server.ssrLoadModule('/src/art/car.ts');
 const {TUNING}=await server.ssrLoadModule('/src/tuning.ts');
 const counts=[];
 for(const type of Object.keys(TUNING.vehicles.types)) {
  const parts=buildCarParts(type,new THREE.Color('#457b9d'));
  const geometry=parts.body.build();
  assert.ok([...geometry.getAttribute('position').array].every(Number.isFinite),`${type} finite vertices`);
  const shell=new THREE.Mesh(geometry,carMaterial);shell.updateMatrixWorld();
  const eye=driverSeat(type);
  // The former solid painted cabin box blocked all these sightlines. Windscreen now has a real opening from inside.
  for(const d of [new THREE.Vector3(0,0,1),new THREE.Vector3(.15,0,1).normalize(),new THREE.Vector3(-.15,0,1).normalize()]) {
   const ray=new THREE.Raycaster(eye,d,0,3);
   assert.equal(ray.intersectObject(shell).length,0,`${type} driver's forward view clear`);
  }
  const cockpit=makeCarInterior(type);assert.ok(cockpit.getObjectByName('steeringWheel'),`${type} movable steering wheel`);
  assert.ok(eye.y<parts.windscreen.y+parts.windscreen.h/2 && eye.y>parts.windscreen.y-parts.windscreen.h/2,`${type} eye at windscreen height`);
  const wheel=makeWheel(TUNING.vehicles.types[type].wheelRadius);assert.equal(wheel.children.length,2);
  counts.push({type,triangles:geometry.getAttribute('position').count/3,driver:eye.toArray()});
 }
 assert.equal(counts.length,6);
 console.log(JSON.stringify({pass:true,cars:counts}));
} finally {await server.close();}
