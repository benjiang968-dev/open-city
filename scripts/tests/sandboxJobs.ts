import assert from 'node:assert/strict';
import * as THREE from 'three';
import R from '@dimforge/rapier3d-compat';
import type { World } from '../../src/world';
import { createItems } from '../../src/systems/worldItems';
import { pickUp } from '../../src/systems/inventory';
import { createSandbox, startSandboxJob, sandboxInteraction, cancelSandboxJob } from '../../src/systems/sandbox';
await R.init();
const physics = new R.World({x:0,y:-9.81,z:0});
const entry = (id:string,kind:string,x:number) => ({id,kind,name:id,origin:{x,y:300,z:0},exterior:{x,y:0,z:0}});
const panel = {setAttribute(){},addEventListener(){},style:{}};
(globalThis as any).document = {createElement:()=>panel,getElementById:()=>({appendChild(){}})};
const w = {
 R,physics,scene:new THREE.Scene(),seed:123,time:1,cash:150,started:true,paused:false,events:[],
 city:{spawn:{x:0,z:0},heightAt:()=>0},
 player:{mesh:new THREE.Group(),vehicle:null,dead:false,prompt:''},
 interiors:{active:'depot-a',entries:[entry('depot-a','warehouse',0),entry('depot-b','warehouse',30),entry('shop','shop',60),entry('office','office',90),entry('cafe','cafe',120)]},
 inventory:{slots:Array(9).fill(null),selected:0,nameEl:{style:{}},nameUntil:0},
 input:{blocked:false,pressed:new Set<string>(),keys:new Set<string>()},
 audio:{},hud:{toast:{style:{}},toastUntil:0},jobs:{register(){}},chat:{open:false},
} as unknown as World;
w.itemsState=createItems(w);w.sandbox=createSandbox(w);
const completeWarehouse = (id:string) => {
 w.interiors.active=id;assert.equal(startSandboxJob(w,'warehouse'),true);
 const a=w.sandbox.save.active!;assert.equal(a.startEntryId,id);const ids=[...a.items];
 const e=w.interiors.entries.find(e=>e.id===id)!;
 for(const itemId of ids){const it=w.itemsState.items[itemId];assert.equal(it.inWorld,true);assert.equal(pickUp(w,it),true);w.inventory.selected=w.inventory.slots.findIndex(it=>it?.id===itemId);w.player.mesh.position.set(e.origin.x+2,e.origin.y,e.origin.z+2);w.input.pressed.add('KeyE');assert.equal(sandboxInteraction(w),true);}
 assert.equal(w.sandbox.save.active,null);const cash=w.cash;w.input.pressed.add('KeyE');assert.equal(sandboxInteraction(w),false);assert.equal(w.cash,cash,'completed shift cannot pay again');
 assert.ok(ids.every(id=>w.itemsState.items[id].location==='consumed'));
 return ids;
};
const first=completeWarehouse('depot-a');assert.equal(w.cash,200);const count=w.itemsState.items.length;
const second=completeWarehouse('depot-b');assert.equal(w.cash,250);assert.equal(w.sandbox.save.completed,2);
assert.deepEqual(second,first,'repeat shift reuses the same physical task IDs');assert.equal(w.itemsState.items.length,count,'repeat shift must not clone supplies');
assert.equal(startSandboxJob(w,'delivery'),true);cancelSandboxJob(w);assert.equal(w.cash,250,'cancelled work cannot pay');
physics.free();delete (globalThis as any).document;
console.log('PASS repeat warehouse shift at a second workplace, same-ID supply recycling, exact payouts, repeated E and cancellation guards');
