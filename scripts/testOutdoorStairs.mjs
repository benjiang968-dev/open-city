// Production Georgetown stair traversal: actual character controller, static city geometry and both directions.
// Usage: node scripts/testOutdoorStairs.mjs; IDS=6,17,24 for selected stairs; FULL=0 for the historic problem areas.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
const root=process.env.BUILD_ROOT??'dist';
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://local');if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}const p=join(root,u.pathname==='/'?'index.html':u.pathname);try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'})[extname(p)]??'application/octet-stream');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}}).listen(0);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:320,height:180}});page.setDefaultTimeout(240000);
await page.addInitScript(()=>{const raf=requestAnimationFrame.bind(window);let id;window.requestAnimationFrame=fn=>(id=raf(fn));window.__freezeStairs=()=>{cancelAnimationFrame(id);window.requestAnimationFrame=()=>0;};});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await page.goto(`http://localhost:${server.address().port}/?map=georgetown&quality=low&seed=123`);await page.waitForFunction(()=>window.__ocStep);await page.evaluate(()=>window.__freezeStairs());
 const result=await page.evaluate(({full,ids})=>{
  const w=window.__oc,P=w.player,R=w.R,ST=w.city.geo.stairs;
  for(const st of ST){st.cum=[0];for(let i=1;i<st.pts.length;i++)st.cum.push(st.cum[i-1]+Math.hypot(st.pts[i][0]-st.pts[i-1][0],st.pts[i][1]-st.pts[i-1][1]));st.ha=st.h(0);st.hb=st.h(st.L);}
  w.started=true;w.paused=false;w.input.blocked=false;
  for(const a of [...w.vehicles,...w.traffic,...w.police.pool,...w.peds])a.body?.setEnabled(false);
  for(const i of w.itemsState.items)i.body.setEnabled(false);
  const offset=P.collider.halfHeight()+P.collider.radius(),staticFilter=(0xffff<<16)|1;
  const floor=(x,y,z)=>{const hit=w.physics.castRay(new R.Ray({x,y,z},{x:0,y:-1,z:0}),80,true,undefined,staticFilter);return hit?{y:y-hit.timeOfImpact,kind:w.city.solidTags.get(hit.collider.handle)}:null;};
  const sample=(st,s)=>{s=Math.max(0,Math.min(st.L,s));for(let j=1;j<st.pts.length;j++){if(s<=st.cum[j]||j===st.pts.length-1){const L=st.cum[j]-st.cum[j-1],t=(s-st.cum[j-1])/L;return{x:st.pts[j-1][0]+(st.pts[j][0]-st.pts[j-1][0])*t,z:st.pts[j-1][1]+(st.pts[j][1]-st.pts[j-1][1])*t,ux:(st.pts[j][0]-st.pts[j-1][0])/L,uz:(st.pts[j][1]-st.pts[j-1][1])/L};}}};
  const project=(st,x,z)=>{let best=0,dist=Infinity;for(let j=1;j<st.pts.length;j++){const a=st.pts[j-1],b=st.pts[j],dx=b[0]-a[0],dz=b[1]-a[1],L=Math.hypot(dx,dz),t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(L*L))),d=Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);if(d<dist){dist=d;best=st.cum[j-1]+t*L;}}return best;};
  // Some source lines end exactly against a facade. A capsule's centre must stop short of that wall; find a
  // collision-free support point instead of spawning inside it or requiring the centre to touch the facade.
  const endpoint=(st,s,lane)=>{
   const dir=s===0?1:-1;
   for(let inset=0;inset<=Math.min(1.2,st.L/4);inset+=.1){
    const q=sample(st,s+dir*inset),x=q.x-q.uz*lane,z=q.z+q.ux*lane,f=floor(x,st.h(s)+1,z);if(!f||![1,2,3,5,7].includes(f.kind))continue;
    // A rounded capsule stands slightly above the plane under its centre on a sloped ramp. Find a free pose,
    // then let the production controller settle onto that support instead of treating slope contact as a wall.
    for(let lift=.04;lift<=.201;lift+=.04){
     const p={x,y:f.y+offset+lift,z};let blocked=false;
     w.physics.intersectionsWithShape(p,{x:0,y:0,z:0,w:1},P.collider.shape,c=>{if(c.handle!==P.collider.handle)blocked=true;return true;},R.QueryFilterFlags.ONLY_FIXED);
     if(!blocked)return{...p,inset,lift,surface:f};
    }
   }
   return null;
  };
  const traverse=(st,reverse)=>{
   const lowFirst=st.ha<=st.hb,dir=(lowFirst!==reverse)?1:-1,start=dir>0?0:st.L,end=dir>0?st.L:0;
   const lane=st.name?st.w/4:0,begin=endpoint(st,start,lane),finish=endpoint(st,end,lane);
   if(!begin||!finish)return{pass:false,reason:'no collision-free endpoint',begin,finish};
   const px=begin.x,pz=begin.z,y=begin.y,f=begin.surface;
   P.body.setTranslation({x:px,y,z:pz},true);P.body.setNextKinematicTranslation({x:px,y,z:pz});P.vy=0;P.moveSpeed=0;P.grounded=true;P.knockT=0;w.input.keys.clear();w.input.pressed.clear();
   // Controller movements exclude external simulation and keep gravity/snap identical to game settings.
   const step=(dx,dz)=>{const p=P.body.translation();P.cc.computeColliderMovement(P.collider,{x:dx,y:-1/60,z:dz});const m=P.cc.computedMovement();P.body.setNextKinematicTranslation({x:p.x+m.x,y:p.y+m.y,z:p.z+m.z});w.physics.step();return P.body.translation();};
   for(let k=0;k<4;k++)step(0,0);
   let pos=P.body.translation(),maxPen=0,stuck=0,last=pos,progress=start;
   const ticks=Math.ceil((st.L+4)/3.5*60*2);
   for(let k=0;k<ticks;k++){
    const s=project(st,pos.x,pos.z),target=sample(st,s+dir*.55),dx=target.x-pos.x-target.uz*lane,dz=target.z-pos.z+target.ux*lane,L=Math.hypot(dx,dz)||1;
    pos=step(dx/L*3.5/60,dz/L*3.5/60);progress=project(st,pos.x,pos.z);
    const feet=pos.y-offset,fy=floor(pos.x,feet+.4,pos.z);if(fy)maxPen=Math.max(maxPen,fy.y-feet);
    if(Math.hypot(pos.x-last.x,pos.z-last.z)<.0005)stuck++;else stuck=0;last=pos;
    const distEnd=Math.hypot(pos.x-finish.x,pos.z-finish.z);
    if(distEnd<.4&&Math.abs(feet-finish.surface.y)<.35)return{pass:true,ticks:k,feet,expected:finish.surface.y,planned:st.h(end),maxPen,progress,startInset:begin.inset,endInset:finish.inset};
    if(stuck>100)break;
   }
   const yaw=Math.atan2(sample(st,progress+dir*.5).x-pos.x,sample(st,progress+dir*.5).z-pos.z);
   const hit=w.physics.castRay(new R.Ray({x:pos.x,y:pos.y-.2,z:pos.z},{x:Math.sin(yaw),y:0,z:Math.cos(yaw)}),2,true,R.QueryFilterFlags.ONLY_FIXED);
   const collisions=[];for(let i=0;i<P.cc.numComputedCollisions();i++){const c=P.cc.computedCollision(i);collisions.push({kind:w.city.solidTags.get(c.collider.handle),normal:c.normal1,point:c.witness1});}
   const goal=sample(st,end),goalX=goal.x-goal.uz*lane,goalZ=goal.z+goal.ux*lane;
   return{pass:false,feet:pos.y-offset,expected:finish.surface.y,planned:st.h(end),maxPen,progress,pos,startFloor:f,goalFloor:floor(goalX,st.h(end)+1,goalZ),startInset:begin.inset,endInset:finish.inset,collisions,blocked:hit?{kind:w.city.solidTags.get(hit.collider.handle),distance:hit.timeOfImpact}:null};
  };
  const rows=[];
  for(let i=0;i<ST.length;i++){
   const st=ST[i];if(ids.length?!ids.includes(i):!full&&!st.pts.some(p=>[[-349,240],[-934,-24],[252,-770],[228,-888]].some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<30)))continue;
   rows.push({i,pts:st.pts,L:st.L,w:st.w,name:st.name,flights:st.flights,ha:st.ha,hb:st.hb,up:traverse(st,false),down:traverse(st,true)});
  }
  return{count:ST.length,tested:rows.length,failed:rows.filter(r=>!r.up.pass||!r.down.pass),maxPen:Math.max(0,...rows.flatMap(r=>[r.up.maxPen??0,r.down.maxPen??0])),rows};
 },{full:process.env.FULL!=='0',ids:(process.env.IDS??'').split(',').filter(Boolean).map(Number)});
 const report={scenario:'Production city stairs: static geometry, both directions, direct Rapier character-controller ticks',map:'georgetown',seed:123,speed:3.5,endpointPolicy:'Collision-free source endpoints; maximum inset 1.2m, valid support and capsule clearance required',errors,...result};
 console.log(JSON.stringify(report,null,2));const out=process.env.OUT??'work/outdoor-stairs.json';await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));
 assert.deepEqual(errors,[]);assert.equal(result.failed.length,0,'outdoor stairs must be traversable both ways');assert.ok(result.maxPen<=.05,'walking capsule must remain above the physical floor');
}finally{await browser.close();server.close();}
