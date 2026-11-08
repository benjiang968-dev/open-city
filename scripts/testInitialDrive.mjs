// Production fresh-start car: hold W for25m, then restore the page's original actor and vehicle poses.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,extname,dirname} from 'node:path';
import {runInitialCarProbe} from './initialCarScenario.mjs';
const buildRoot=process.env.BUILD_ROOT??'dist';
const server=createServer(async(req,res)=>{const p=new URL(req.url,'http://local').pathname;if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}try{const file=p==='/'?'index.html':p;res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(await readFile(join(buildRoot,file)));}catch{res.writeHead(404);res.end();}}).listen(0);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:320,height:180}}),errors=[];
 await page.addInitScript(()=>{const raf=requestAnimationFrame.bind(window);let id;window.requestAnimationFrame=fn=>(id=raf(fn));window.__freezeInitialDrive=()=>{cancelAnimationFrame(id);window.requestAnimationFrame=()=>0;};});
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://localhost:${server.address().port}/?map=georgetown&quality=low&seed=123`);await page.waitForFunction(()=>window.__ocStep,null,{timeout:240000});await page.evaluate(()=>window.__freezeInitialDrive());
 const result=await runInitialCarProbe(page);
 if(process.env.SHOT==='1'){
  await mkdir('screenshots',{recursive:true});await page.setViewportSize({width:800,height:500});
  await page.evaluate(()=>{const w=window.__oc,v=w.vehicles.find(v=>v.owned&&!v.pooled),p=v.body.translation(),q=v.body.rotation(),sin=Math.sin(v.heading),cos=Math.cos(v.heading);document.querySelectorAll('body > :not(canvas)').forEach(e=>e.style.visibility='hidden');w.renderer.setPixelRatio(1);w.renderer.setSize(800,500,false);w.camera.aspect=800/500;w.camera.updateProjectionMatrix();w.camera.position.set(p.x-sin*12+cos*8,p.y+8,p.z-cos*12-sin*8);w.camera.lookAt(p.x+sin*5,p.y,p.z+cos*5);w.camera.updateMatrixWorld();w.city.geo.update(w.time,w.camera);/* Fixed physics ticks do not refresh parked-car instances; draw the same car's own mesh for this still. */v.mesh.position.set(p.x,p.y,p.z);v.mesh.quaternion.set(q.x,q.y,q.z,q.w);v.mesh.visible=true;w.scene.updateMatrixWorld(true);w.renderer.render(w.scene,w.camera);});
  await page.screenshot({path:'screenshots/39-initial-drive.png',timeout:60000});
 }
 const report={map:'georgetown',seed:123,scenario:'Actual fresh owned car, held W until25m, moving actors disabled, runtime restored',errors,...result},out=process.env.OUT??'screenshots/39-initial-drive.json';await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.deepEqual(errors,[]);assert.equal(result.stop,'25m','fresh owned car must have a usable departure');assert.equal(result.firstDamage,null);assert.equal(result.final.health,result.initial.health,'first25m must retain starting health');
}finally{await browser.close();server.close();}
