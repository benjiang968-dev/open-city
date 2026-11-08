// CPU geometry regressions for bridge stair openings and layered walking-surface heights.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
 const {bridgeRailSegments}=await server.ssrLoadModule('/src/systems/map/waterworks.ts');
 const {stairProfile,stairJointLandings,fitStairEnds}=await server.ssrLoadModule('/src/systems/map/bridges.ts');
 const {RenderChunks,PhysChunks}=await server.ssrLoadModule('/src/systems/map/meshKit.ts');
 const {TUNING}=await server.ssrLoadModule('/src/tuning.ts');
 const {buildStairs}=await server.ssrLoadModule('/src/systems/map/bridges.ts');
 const {SurfaceIndex}=await server.ssrLoadModule('/src/systems/map/surfaceIndex.ts');
 const a={x:0,y:10,z:0},b={x:10,y:10,z:0};
 const stair=(x,y)=>({pts:[[x,0],[x,5]],w:2.2,L:5,h:()=>y});
 assert.deepEqual(bridgeRailSegments(a,b,[]),[[0,1]]);
 const openings=bridgeRailSegments(a,b,[stair(5,10)]);
 assert.equal(openings.length,2);assert.ok(openings[0][1]<.4&&openings[1][0]>.6,'full pedestrian opening');
 assert.deepEqual(bridgeRailSegments(a,b,[stair(5,2)]),[[0,1]],'stairs under bridge keep its rail');
 assert.deepEqual(bridgeRailSegments(a,b,[stair(50,10)]),[[0,1]],'far stairs do not cut bridge guards');
 assert.ok(bridgeRailSegments(a,b,[stair(0,10)])[0][0]>.1,'opening at segment end');
 const plane=y=>Float32Array.from([0,y,0,4,y,0,4,y,4,0,y,0,4,y,4,0,y,4]);
 const surf=new SurfaceIndex([plane(0),plane(5)]);
 assert.equal(surf.at(2,2,1),0);assert.equal(surf.at(2,2,6),5);assert.equal(surf.at(2,2),5);
 assert.ok(Number.isNaN(surf.at(10,10)));
 assert.equal(surf.closest(2,2,.2,3),0,'stair under bridge stays on ground');assert.equal(surf.closest(2,2,4.8,3),5,'deck landing stays on deck');assert.ok(Number.isNaN(surf.closest(2,2,2.5,1)));
 const clear=new SurfaceIndex([plane(0),plane(2.1)]),covered=new SurfaceIndex([plane(0),plane(.65)]);
 assert.equal(clear.closest(2,2,.1,3,1.8),0,'upper deck with capsule headroom keeps the lower landing');
 assert.ok(Math.abs(covered.closest(2,2,.1,3,1.8)-.65)<1e-6,'buried lower triangle yields to its covering landing');
 const steep=new SurfaceIndex([plane(0),Float32Array.from([0,0,0,4,20,0,4,20,4,0,0,0,4,20,4,0,0,4])]);
 assert.equal(steep.closest(.1,2,.1,3,1.8),0,'steep wall faces cannot become a stair landing');
 const narrow={pts:[[0,0],[10,0]],cum:[0,10],L:10,w:2.2,ha:0,hb:4,name:null};
 const narrowProfile=stairProfile(10,0,4,false);Object.assign(narrow,narrowProfile);
 fitStairEnds(narrow,(x,z)=>(x<5?0:4)+(Math.abs(z)<.1?1:0),{kindAt:()=>0});
 assert.equal(narrow.h(0),1,'centre support sets a narrow landing instead of lower shoulders');assert.equal(narrow.h(10),5);
 const pts=[[0,0],[8,0],[8,5],[16,5]],cum=[0,8,13,21],zones=stairJointLandings(pts,cum,2.2);
 const profile=stairProfile(21,0,8,false,zones);
 assert.equal(profile.h(0),0);assert.equal(profile.h(21),8);
 for(const [lo,hi]of zones)assert.ok(Math.abs(profile.h(lo+.01)-profile.h(hi-.01))<1e-6,'shared turn landing stays flat');
 const fixtures=[[[0,0],[10,0],[10,-5],[23,-5]],[[0,0],[5,0],[9,.4],[10.7,-2.9],[11.8,-7.3]],[[.7889012070387,4.69523545563456],[1.7,4.5],[2.1,3.6],[0,0]]];
 const summary=[];
 for(const [fi,points]of fixtures.entries()){
  const lengths=[0];for(let j=1;j<points.length;j++)lengths.push(lengths[j-1]+Math.hypot(points[j][0]-points[j-1][0],points[j][1]-points[j-1][1]));
  const L=lengths.at(-1),height=[5,8,1.348892115633224][fi];
  const p=stairProfile(L,0,height,false,stairJointLandings(points,lengths,2.2));
  const plan={pts:points,cum:lengths,L,w:2.2,h:p.h,flights:p.flights,name:null,ha:0,hb:height};
  const world=new RAPIER.World({x:0,y:-22,z:0}),chunks=new RenderChunks(100,{x0:-20,z0:-20,x1:40,z1:20},0),phys=new PhysChunks(RAPIER,world,120);
  buildStairs([plan],chunks,phys,{heightAt:()=>0});phys.finishTrimeshes();
  const P=TUNING.player,offset=P.capsuleHalfHeight+P.capsuleRadius;
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const collider=world.createCollider(RAPIER.ColliderDesc.capsule(P.capsuleHalfHeight,P.capsuleRadius),body);
  const cc=world.createCharacterController(P.ccOffset);cc.enableAutostep(P.autostepHeight,P.autostepMinWidth,true);cc.enableSnapToGround(P.snapToGround);cc.setMaxSlopeClimbAngle(P.maxSlopeDeg*Math.PI/180);
  const nearest=(x,z)=>{let best=0,dist=Infinity;for(let j=1;j<points.length;j++){const a=points[j-1],b=points[j],dx=b[0]-a[0],dz=b[1]-a[1],len=lengths[j]-lengths[j-1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(len*len))),d=Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);if(d<dist){dist=d;best=lengths[j-1]+t*len;}}return best;};
  const at=s=>{s=Math.max(0,Math.min(L,s));for(let j=1;j<points.length;j++)if(s<=lengths[j]||j===points.length-1){const a=points[j-1],b=points[j],t=(s-lengths[j-1])/(lengths[j]-lengths[j-1]);return{x:a[0]+(b[0]-a[0])*t,z:a[1]+(b[1]-a[1])*t};}};
  for(const dir of [1,-1]){
   const start=dir===1?0:L,target=dir===1?L:0,begin=at(start);body.setTranslation({x:begin.x,y:plan.h(start)+offset+.04,z:begin.z},true);world.step();
   let pass=false,last;
   for(let k=0;k<(L+4)/3.5*60*2;k++){
    const pos=body.translation(),s=nearest(pos.x,pos.z),q=at(s+dir*.55),dx=q.x-pos.x,dz=q.z-pos.z,len=Math.hypot(dx,dz)||1;
    cc.computeColliderMovement(collider,{x:dx/len*3.5/60,y:-1/60,z:dz/len*3.5/60});const m=cc.computedMovement();body.setNextKinematicTranslation({x:pos.x+m.x,y:pos.y+m.y,z:pos.z+m.z});world.step();last=body.translation();
    const end=at(target);if(Math.hypot(last.x-end.x,last.z-end.z)<.4&&Math.abs(last.y-offset-plan.h(target))<.2){pass=true;break;}
   }
   assert.ok(pass,`fixture${fi} dir${dir} blocked at${JSON.stringify(last)}`);
  }
  summary.push({fixture:fi,length:L,rise:height,up:true,down:true});world.free();
 }
 console.log('PASS height-aware stair/footbridge guard openings, layered walking heights and real Rapier sharp-turn stairs',JSON.stringify(summary));
}finally{await server.close();}
