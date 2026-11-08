// Production game integration: actual E interactions, job objectives, transactions and browser-local reload.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { runInitialCarProbe } from './initialCarScenario.mjs';
import { runExtendedFlow } from './extendedScenario.mjs';
import { runSandboxFlow } from './sandboxScenario.mjs';
const root = process.env.BUILD_ROOT ?? 'dist';
const types = {'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
const server=createServer(async(req,res)=>{const p=new URL(req.url,'http://local').pathname;if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}try{res.setHeader('Content-Type',types[extname(p==='/'?'index.html':p)]??'application/octet-stream');res.end(await readFile(join(root,p==='/'?'index.html':p)));}catch{res.writeHead(404);res.end();}}).listen(0);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:640,height:360}});
page.setDefaultTimeout(180000);
await page.addInitScript(()=>{const raf=requestAnimationFrame.bind(window);let last=0;window.requestAnimationFrame=f=>(last=raf(f));window.__freeze=()=>{cancelAnimationFrame(last);window.requestAnimationFrame=()=>0;};});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const map=process.env.MAP??'georgetown';
const url=process.env.GAME_URL??`http://localhost:${server.address().port}/?map=${map}&quality=low&seed=123`;
const ready=async()=>{await page.waitForFunction(()=>window.__ocSandbox);await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__oc.started);await page.evaluate(()=>{window.__freeze();const w=window.__oc;w.started=true;w.paused=false;w.input.blocked=false;});};
try{
 await page.goto(url);await ready();
 const initialCar=await runInitialCarProbe(page);assert.equal(initialCar.firstDamage,null,'Fresh starter must have a safe25m departure');assert.equal(initialCar.stop,'25m');console.log('initialCar',JSON.stringify(initialCar));await writeFile('work/initial-car-report.json',JSON.stringify(initialCar,null,2));
 const initial=await page.evaluate(()=>({entries:window.__oc.interiors.entries.map(e=>({id:e.id,kind:e.kind,at:e.exterior})),cash:window.__oc.cash}));console.log('initial',JSON.stringify(initial));
 const jobs=await runSandboxFlow(page);console.log('jobs',JSON.stringify(jobs));
 const extended=await runExtendedFlow(page);console.log('extended',JSON.stringify(extended));
 const before=await page.evaluate(async()=>{
  const w=window.__oc,api=window.__ocSandbox,run=window.__ocRun;
  const apartment=w.interiors.entries.find(e=>e.kind==='apartment');
  if (w.interiors.active !== apartment.id) { api.exitInterior(); api.enterInterior(apartment.id); run(.2,60); }
  const it=w.inventory.slots.find(it=>it && !it.owner);if(!it)throw Error('No stored collectible');
  w.inventory.selected=w.inventory.slots.indexOf(it);if(!api.store(apartment.id))throw Error('Storage deposit for reload failed');
  const id=it.id;api.exitInterior();run(1,60);
  const shop=w.interiors.entries.find(e=>e.kind==='shop');
  w.player.body.setTranslation({x:shop.exterior.x,y:shop.exterior.y+1,z:shop.exterior.z},true);w.player.vy=0;run(.1,60);
  w.input.pressed.add('KeyE');run(1/60,60);if(w.interiors.active!==shop.id)throw Error('Shop entry failed');
  const stock=w.itemsState.items.find(it=>it.owner===shop.id&&it.inWorld);
  w.player.body.setTranslation({x:stock.px,y:shop.origin.y+1,z:stock.pz+.5},true);w.player.vy=0;w.player.facing=Math.PI;run(.1,60);
  w.input.pressed.add('KeyE');run(1/60,60);if(!w.inventory.slots.includes(stock))throw Error('Stock pickup failed');
  if(w.police.stars)throw Error('Picking up to inspect should not report theft');
  api.exitInterior();run(.1,60);if(w.police.heat<=0)throw Error('Shopkeeper failed to report theft');
  const heat=w.police.heat;
  // Resolve the existing police system through its real unseen countdown on a physical indoor floor.
  api.enterInterior(apartment.id);run(45,30);if(w.police.stars!==0)throw Error('Pursuit did not resolve unseen: '+w.police.stars);
  const upstairs=w.interiors.entries.find(e=>e.id===w.interiors.active);run(.2,60);window.__ocFrames(2,true);
  const saved=await api.save();if(!saved)throw Error('Save failed '+JSON.stringify(api.status()));
  return{itemId:id,cash:w.cash,apartment:apartment.id,completed:w.sandbox.save.completed,theftHeat:heat,pursuitResolved:w.police.stars===0,active:upstairs.id};
 });console.log('saved',JSON.stringify(before));
 await mkdir('screenshots',{recursive:true});await page.screenshot({path:`screenshots/36-gameplay-${map}-interior.png`,timeout:60000});
 await page.reload();await ready();
 const after=await page.evaluate(({itemId,apartment,secondApartment,storedBook})=>{
  const w=window.__oc,api=window.__ocSandbox,run=window.__ocRun;
  if(w.interiors.active!==apartment)throw Error('Active interior was not restored');
  if(!w.interiors.entries.find(e=>e.id===apartment).room)throw Error('Restored interior has no floor');
  if(!w.sandbox.save.properties[apartment]?.stored.includes(itemId))throw Error('Storage lost on reload');
  if(!w.sandbox.save.properties[secondApartment]?.stored.includes(storedBook))throw Error('Second apartment book lost on reload');
  if(!api.retrieve(itemId))throw Error('Retrieve after reload failed');
  if(api.retrieve(itemId))throw Error('Duplicate retrieval accepted');
  const same=w.inventory.slots.filter(it=>it?.id===itemId).length===1;
  run(1,60);window.__ocFrames(2,true);
  return{cash:w.cash,completed:w.sandbox.save.completed,sameInstance:same,active:w.interiors.active,health:w.player.health};
 },{...before,...extended});console.log('reloaded',JSON.stringify(after));
 assert.equal(after.cash,before.cash);assert.equal(after.completed,4);assert.equal(after.sameInstance,true);assert.ok(after.health>0);assert.deepEqual(errors,[]);
 await writeFile(`screenshots/36-gameplay-${map}.json`,JSON.stringify({initial,initialCar,jobs,extended,before,after,errors},null,2));
 console.log('Production gameplay integration PASS; console clean.');
}finally{await browser.close();server.close();}
