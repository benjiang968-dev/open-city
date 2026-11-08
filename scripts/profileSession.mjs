// Reproducible standalone-production profile; no preview wrapper. System Chrome is supported.
// node scripts/profileSession.mjs /path/to/dist output.json [low|medium]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { existsSync } from 'node:fs';
const root = resolve(process.argv[2] || 'dist'), out = process.argv[3] || 'work/profile.json', quality = process.argv[4] || 'medium';
const types = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.wasm':'application/wasm' };
const server = createServer(async (req,res) => { const u = new URL(req.url,'http://localhost'); if(u.pathname === '/favicon.ico'){res.writeHead(204);res.end();return;} const file = join(root,u.pathname === '/' ? 'index.html' : u.pathname); try { const bytes=await readFile(file);res.writeHead(200, {'Content-Type':types[extname(file)] || 'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}}).listen(0);
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({executablePath, args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-precise-memory-info']});
const page = await browser.newPage({viewport:{width:480,height:270}});
await page.addInitScript(()=>{ const raf=window.requestAnimationFrame.bind(window);let id=0;window.requestAnimationFrame=fn=>(id=raf(fn));window.__stopProfileFrames=()=>{cancelAnimationFrame(id);window.requestAnimationFrame=()=>0;};});
const errors = [];
page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,500));});page.on('pageerror',e=>errors.push(e.message));
try {
 const t0=Date.now();
 await page.goto(`http://localhost:${server.address().port}/?quality=${quality}&seed=123`);
 await page.waitForFunction(()=>window.__oc && window.__oc.time>0.2,null,{timeout:180000});
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__oc.started,null,{timeout:60000});
 const readyMs=Date.now()-t0;
 await page.evaluate(()=>window.__stopProfileFrames());
 await page.evaluate(()=>{const w=window.__oc;w.dayNight.hour=15.5;w.player.body.setTranslation({x:-240,y:w.city.heightAt(-240,160)+1.2,z:160},true);window.__ocRun(.5);window.__ocFrames(2,true);});
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('HeapProfiler.enable');await cdp.send('HeapProfiler.startSampling',{samplingInterval:2048,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 const stats=await page.evaluate(()=>{const w=window.__oc; const frames=window.__ocFrames(120,true);const sorted=frames.map(x=>x.cpu).sort((a,b)=>a-b);const info=w.renderer.info;return {boot:window.__ocBoot,bake:w.look.stats,calls:info.render.calls,triangles:info.render.triangles,geometries:info.memory.geometries,textures:info.memory.textures,programs:info.programs.length,cpuMedian:sorted[60],cpuP90:sorted[108],cpuWorst:sorted[119],framesOver33:frames.filter(f=>f.cpu>33).length,slowest:frames.sort((a,b)=>b.cpu-a.cpu).slice(0,8),heapMB:Math.round(performance.memory.usedJSHeapSize/1048576)};});
 const {profile}=await cdp.send('HeapProfiler.stopSampling');
 const agg=new Map();function walk(n){const f=n.callFrame;const key=`${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber+1}`;agg.set(key,(agg.get(key)||0)+n.selfSize);for(const c of n.children)walk(c);}walk(profile.head);
 const allocated=[...agg.values()].reduce((a,b)=>a+b,0);
 const result={quality,renderer:'Chromium SwiftShader software GL',size:'480x270',seed:123,map:'georgetown',frames:120,readyMs,...stats,allocatedKBPerFrame:Math.round(allocated/120/1024),allocationTop:[...agg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12),errors};
 await writeFile(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 try { await page.screenshot({path:out.replace(/\.json$/,'.png'),timeout:30000}); } catch(e) { console.log('Screenshot: '+e.message.split('\n')[0]); }
} finally {await browser.close();server.close();}
