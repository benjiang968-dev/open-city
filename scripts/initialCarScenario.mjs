// Execute on an already booted/frozen Georgetown page before gameplay fixtures; restores runtime poses/state.
export async function profileInitialCarSpots(page) {
 return page.evaluate(() => {
  const w=window.__oc,R=w.R,v=w.vehicles.find(v=>v.owned&&!v.pooled);
  const spots=w.city.parkingSpots.filter(s=>s.cls!=='lot').sort((a,b)=>Math.hypot(a.x-w.city.spawn.x,a.z-w.city.spawn.z)-Math.hypot(b.x-w.city.spawn.x,b.z-w.city.spawn.z)).slice(0,30);
  return spots.map((s,i)=>{
   const e=w.city.roads.edges[s.edge];
   const atLane=distance=>{const t=Math.min(e.len,Math.max(0,distance));for(let k=1;k<e.cum.length;k++)if(t<=e.cum[k]||k===e.cum.length-1){const f=(t-e.cum[k-1])/(e.cum[k]-e.cum[k-1]);return{x:e.pts[(k-1)*3]+(e.pts[k*3]-e.pts[(k-1)*3])*f,y:e.pts[(k-1)*3+1]+(e.pts[k*3+1]-e.pts[(k-1)*3+1])*f,z:e.pts[(k-1)*3+2]+(e.pts[k*3+2]-e.pts[(k-1)*3+2])*f};}};
   const sin=Math.sin(s.heading),cos=Math.cos(s.heading),samples=[];
   for(let d=0;d<=30;d+=.5){const x=s.x+sin*d,z=s.z+cos*d;
    const floor=(x,z)=>{const hit=w.physics.castRay(new R.Ray({x,y:s.y+15,z},{x:0,y:-1,z:0}),40,true,R.QueryFilterFlags.ONLY_FIXED,undefined,undefined,undefined,c=>[1,2,3].includes(w.city.solidTags.get(c.handle)));return hit?s.y+15-hit.timeOfImpact:null;};
    const lane=atLane(s.s+d);
    samples.push({d,x,z,y:floor(x,z),left:floor(x+cos*v.spec.wheelX,z-sin*v.spec.wheelX),right:floor(x-cos*v.spec.wheelX,z+sin*v.spec.wheelX),road:w.city.isRoad(x,z),lane:{...lane,floor:floor(lane.x,lane.z)}});
   }
   const grades=samples.slice(1).map((p,i)=>2*(p.y-samples[i].y));
   const maxGrade=Math.max(...grades.map(Math.abs)),maxKink=Math.max(...grades.slice(1).map((g,i)=>Math.abs(g-grades[i]))),maxCrossGrade=Math.max(...samples.map(p=>Math.abs(p.left-p.right)/(2*v.spec.wheelX)));
   const edgePlan=[0,10].includes(i)?{name:e.name,length:e.len,offset:e.offset,halfWidth:e.halfWidth,trimStart:e.trimStart,trimEnd:e.trimEnd,from:w.city.roads.nodes[e.from],to:w.city.roads.nodes[e.to],outgoing:w.city.roads.nodes[e.to].out.map(i=>({name:w.city.roads.edges[i].name,points:Array.from(w.city.roads.edges[i].pts.slice(0,9))})),road:w.city.geo.roadPolys.filter(p=>p.roadId===e.roadId).map(p=>({name:p.name,width:p.halfWidth*2,centre:Array.from(p.centre),kerbL:Array.from(p.kerbL),kerbR:Array.from(p.kerbR)}))}:undefined;
   return{...s,distance:Math.hypot(s.x-w.city.spawn.x,s.z-w.city.spawn.z),maxGrade,maxKink,maxCrossGrade,offRoad:samples.filter(p=>!p.road).length,samples:[0,7,10,11].includes(i)?samples:undefined,edgePlan};
  });
 });
}
export async function runInitialCarProbe(page) {
 return page.evaluate(() => {
  const w=window.__oc,R=w.R,v=w.vehicles.find(v=>v.owned&&!v.pooled),P=w.player,step=window.__ocStep;
  if(!v)throw new Error('No initial owned car');
  const primitive=o=>Object.fromEntries(Object.entries(o).filter(([,v])=>v===null||['number','string','boolean'].includes(typeof v)));
  const bodies=[...new Set([P.body,...w.vehicles.map(a=>a.body),...w.traffic.map(a=>a.body),...w.police.pool.map(a=>a.body),...w.peds.map(a=>a.body),...w.itemsState.items.map(a=>a.body)].filter(Boolean))].map(body=>({body,enabled:body.isEnabled(),sleeping:body.isSleeping(),position:body.translation(),rotation:body.rotation(),velocity:body.linvel(),spin:body.angvel()}));
  const meshes=[];for(const root of[v.mesh,P.mesh])root.traverse(mesh=>meshes.push({mesh,position:mesh.position.clone(),quaternion:mesh.quaternion.clone(),visible:mesh.visible}));
  const saved={world:{started:w.started,paused:w.paused,time:w.time},blocked:w.input.blocked,keys:[...w.input.keys],pressed:[...w.input.pressed],player:primitive(P),vehicle:P.vehicle,collider:P.collider.isEnabled(),vehicles:w.vehicles.map(a=>({a,values:primitive(a),prev:a.prevVel.clone()})),events:w.events.length,children:new Set(w.scene.children),damage:Float32Array.from(v.dmg.pos),dentTotal:v.dmg.dentTotal,bumpers:v.dmg.bumpers.map(b=>b.state),material:v.bodyMesh.material};
  try {
   w.started=true;w.paused=false;w.input.blocked=false;w.input.keys.clear();w.input.pressed.clear();
   for(const b of bodies)if(b.body!==v.body&&b.body!==P.body)b.body.setEnabled(false);
   step(30);P.vehicle=v;P.collider.setEnabled(false);v.driven=true;v.body.wakeUp();
   const start=v.body.translation(),h=v.heading,dir={x:Math.sin(h),y:0,z:Math.cos(h)};
   const obstacle=c=>![1,2,3].includes(w.city.solidTags.get(c.handle));
   const ride=-v.spec.wheelY+v.spec.suspensionRest*.75+v.spec.wheelRadius+.02;
   const sweep=s=>{const hit=w.physics.castShape({x:s.x,y:s.y+ride,z:s.z},{x:0,y:Math.sin(s.heading/2),z:0,w:Math.cos(s.heading/2)},{x:Math.sin(s.heading),y:0,z:Math.cos(s.heading)},new R.Cuboid(...v.spec.halfExtents),0,30,true,R.QueryFilterFlags.ONLY_FIXED,undefined,undefined,undefined,obstacle);return hit?{distance:hit.time_of_impact,kind:w.city.solidTags.get(hit.collider.handle),point:hit.collider.translation()}:null;};
   const spots=w.city.parkingSpots.filter(s=>s.cls!=='lot').sort((a,b)=>Math.hypot(a.x-w.city.spawn.x,a.z-w.city.spawn.z)-Math.hypot(b.x-w.city.spawn.x,b.z-w.city.spawn.z)).slice(0,20).map(s=>({...s,forward:sweep(s)}));
   const initial={position:start,heading:h,health:v.health,type:v.type,footprint:v.spec.halfExtents,forward:sweep({x:start.x,y:start.y-ride,z:start.z,heading:h})};
   w.input.keys.add('KeyW');let firstDamage=null,maxSpeed=0,stop='time';const trace=[];
   for(let k=0;k<480;k++){
    step(1);const p=v.body.translation(),forward=(p.x-start.x)*dir.x+(p.z-start.z)*dir.z;maxSpeed=Math.max(maxSpeed,Math.abs(v.speed));
    if(k%30===0)trace.push({tick:k,forward,speed:v.speed,health:v.health,position:p});
    if(v.health<initial.health){const contacts=[];w.physics.contactPairsWith(v.collider,c=>contacts.push({kind:w.city.solidTags.get(c.handle),position:c.translation()}));firstDamage={tick:k,forward,health:v.health,position:p,contacts};stop='damage';break;}
    if(forward>=25){stop='25m';break;}
   }
   const contacts=[];w.physics.contactPairsWith(v.collider,c=>contacts.push({kind:w.city.solidTags.get(c.handle),position:c.translation()}));
   return{spawn:w.city.spawn,initial,spots,firstDamage,maxSpeed,stop,trace,final:{position:v.body.translation(),health:v.health,contacts},restored:true};
  } finally {
   for(const b of bodies){b.body.setEnabled(true);b.body.setTranslation(b.position,false);b.body.setRotation(b.rotation,false);if(b.body.isKinematic()){b.body.setNextKinematicTranslation(b.position);b.body.setNextKinematicRotation(b.rotation);}b.body.setLinvel(b.velocity,false);b.body.setAngvel(b.spin,false);b.body.resetForces(false);b.body.resetTorques(false);if(b.sleeping)b.body.sleep();b.body.setEnabled(b.enabled);}
   Object.assign(w,saved.world);Object.assign(P,saved.player);P.vehicle=saved.vehicle;P.collider.setEnabled(saved.collider);
   for(const {a,values,prev}of saved.vehicles){Object.assign(a,values);a.prevVel.copy(prev);for(let i=0;i<4;i++){a.ctrl.setWheelEngineForce(i,0);a.ctrl.setWheelBrake(i,0);a.ctrl.setWheelSteering(i,a.steer);}}
   for(const {mesh,position,quaternion,visible}of meshes){mesh.position.copy(position);mesh.quaternion.copy(quaternion);mesh.visible=visible;}
   v.dmg.pos.set(saved.damage);v.dmg.attr.needsUpdate=true;v.bodyMesh.geometry.computeVertexNormals();v.bodyMesh.material=saved.material;v.dmg.dentTotal=saved.dentTotal;v.dmg.bumpers.forEach((b,i)=>b.state=saved.bumpers[i]);
   for(const child of [...w.scene.children])if(!saved.children.has(child))w.scene.remove(child);
   w.events.length=saved.events;w.input.blocked=saved.blocked;w.input.keys.clear();saved.keys.forEach(k=>w.input.keys.add(k));w.input.pressed.clear();saved.pressed.forEach(k=>w.input.pressed.add(k));
  }
 });
}
