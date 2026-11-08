// Run the published v1 game, save real progress, then serve the new production build at the SAME browser origin.
import assert from 'node:assert/strict';
import { profileInitialCarSpots } from './initialCarScenario.mjs';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';
let buildRoot=process.env.OLD_BUILD??'work/release-v1-dist';
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
const server=createServer(async(req,res)=>{const p=new URL(req.url,'http://local').pathname;if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}const file=p==='/'?'index.html':p;try{res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');res.end(await readFile(join(buildRoot,file)));}catch{res.writeHead(404);res.end();}}).listen(0);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:480,height:270}});page.setDefaultTimeout(240000);
await page.addInitScript(()=>{const raf=requestAnimationFrame.bind(window);let id=0;window.requestAnimationFrame=f=>(id=raf(f));window.__freeze=()=>{cancelAnimationFrame(id);window.requestAnimationFrame=()=>0;};});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const ready=async()=>{await page.waitForFunction(()=>window.__ocSandbox);await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__oc.started);await page.evaluate(()=>window.__freeze());};
try{
 await page.goto(`http://localhost:${server.address().port}/?map=georgetown&quality=low&seed=123`);await ready();
 const legacy=await page.evaluate(async()=>{
  const w=window.__oc,api=window.__ocSandbox,run=window.__ocRun;
  const e=w.interiors.entries.find(e=>e.kind==='apartment');w.cash=800;api.enterInterior(e.id);run(.2,60);
  if(!api.rent(e.id))throw Error('Legacy lease failed');
  const it=w.itemsState.items.find(it=>it.inWorld&&!it.owner&&it.type==='can'&&Math.abs(it.py-e.origin.y)<1);
  if(!it)throw Error('No legacy home collectible');
  w.player.body.setTranslation({x:it.px,y:e.origin.y+1,z:it.pz+.5},true);w.player.vy=0;w.player.facing=Math.PI;run(.15,60);w.input.pressed.add('KeyE');run(1/60,60);
  const slot=w.inventory.slots.findIndex(x=>x?.id===it.id);if(slot<0)throw Error('Legacy pickup failed');w.inventory.selected=slot;
  if(!api.store(e.id))throw Error('Legacy storage failed');w.sandbox.save.completed=2;w.sandbox.save.earned=95;w.peds[0].npc.relationship=24;
  if(!await api.save())throw Error('Legacy save failed');
  return{id:it.id,type:it.type,apartment:e.id,cash:w.cash,count:w.itemsState.items.length,relationship:24,parked:w.parked.cars.slice(0,20).map(r=>({id:r.id,type:r.type,x:r.x,z:r.z}))};
 });console.log('Published v1 progress saved',JSON.stringify(legacy));
 buildRoot=process.env.NEW_BUILD??'dist';await page.reload();await ready();
 const roadProfile=await profileInitialCarSpots(page);await writeFile('work/initial-car-surfaces.json',JSON.stringify(roadProfile,null,2));console.log('Initial car surface profile saved');
 const inspect=()=>page.evaluate(({id,type,apartment,cash,count,relationship,parked})=>{
  const w=window.__oc,api=window.__ocSandbox;
  if(!api.status().ready)throw Error('Upgrade save is not writable: '+JSON.stringify(api.status()));
  if(w.startingLayout!=='legacy')throw Error('Old parking generation contract changed');
  if(JSON.stringify(w.parked.cars.slice(0,20).map(r=>({id:r.id,type:r.type,x:r.x,z:r.z})))!==JSON.stringify(parked))throw Error('Legacy parked-car IDs or types reshuffled');
  if(w.cash!==cash||w.sandbox.save.completed!==2||w.peds[0].npc.relationship!==relationship)throw Error('Money/job/NPC progress lost');
  if(w.interiors.active!==apartment||!w.sandbox.save.properties[apartment]?.stored.includes(id))throw Error('Home/access/storage lost');
  if(w.itemsState.items[id]?.type!==type||w.itemsState.items[id]?.location!=='storage')throw Error('Old numeric item identity lost');
  const authored=w.itemsState.items.filter(it=>it.authoredKey),keys=authored.map(it=>it.authoredKey);
  if(!authored.length||new Set(keys).size!==keys.length)throw Error('New room items missing or duplicated');
  if(w.itemsState.items.length<=count)throw Error('New content was not added');
  return{count:w.itemsState.items.length,authored:keys.length,cash:w.cash,stored:id,apartments:w.interiors.entries.filter(e=>e.kind==='apartment').length};
 },legacy);
 const upgraded=await inspect();await page.evaluate(()=>window.__ocSandbox.save());await page.reload();await ready();const reloaded=await inspect();
 assert.equal(reloaded.count,upgraded.count);assert.equal(reloaded.authored,upgraded.authored);assert.deepEqual(errors,[]);
 await writeFile('screenshots/37-upgrade.json',JSON.stringify({legacy,upgraded,reloaded,errors},null,2));console.log('PASS published-v1 → new-build → reload; progress and item identities preserved; new authored items appended once',JSON.stringify(reloaded));
}finally{await browser.close();server.close();}
