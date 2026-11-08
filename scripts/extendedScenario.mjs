// Additional production flows: actual modal keyboard input, paid food, useful books and a second apartment.
export async function runExtendedFlow(page) {
  await page.keyboard.press('KeyJ');
  await page.evaluate(() => window.__ocRun(.05,60));
  if (!await page.locator('#sandbox-panel').isVisible()) throw Error('J did not open work/home panel');
  const homes=await page.locator('#sandbox-panel button[data-action="rent"]').count();
  if(homes<4)throw Error('Expected four separately viewable apartments');
  await page.locator('#sandbox-panel button[data-action="locate"]').last().click();
  const waypoint=await page.evaluate(()=>{const w=window.__oc;return !w.input.blocked && !!w.sandbox.waypoint && w.jobs.markers().some(m=>m.kind==='tip');});
  if(!waypoint)throw Error('Map destination failed or modal left input blocked');
  return page.evaluate(()=>{
    const w=window.__oc,api=window.__ocSandbox,run=window.__ocRun;
    const assert=(v,m)=>{if(!v)throw Error(m);};
    const enter=e=>{if(w.interiors.active)api.exitInterior();run(1,60);w.player.body.setTranslation({x:e.exterior.x,y:e.exterior.y+1,z:e.exterior.z},true);w.player.vy=0;run(.15,60);w.input.pressed.add('KeyE');run(1/60,60);assert(w.interiors.active===e.id,'Cannot enter '+e.name);};
    const pick=it=>{const e=w.interiors.entries.find(e=>e.id===w.interiors.active);w.player.body.setTranslation({x:it.px,y:e.origin.y+1,z:it.pz+.65},true);w.player.vy=0;w.player.facing=Math.PI;run(.15,60);w.input.pressed.add('KeyE');run(1/60,60);const i=w.inventory.slots.findIndex(x=>x?.id===it.id);assert(i>=0,'Cannot pick '+it.type+' '+it.id);w.inventory.selected=i;};
    assert(w.police.heat===0, 'Earlier fixture left unrelated heat: '+w.police.heat+' '+JSON.stringify(w.inventory.slots.filter(Boolean).map(it=>({type:it.type,owner:it.owner}))));
    const cafe=w.interiors.entries.find(e=>e.kind==='cafe');enter(cafe);
    const food=w.itemsState.items.find(it=>it.authoredKey?.includes(cafe.id+'/counter-apple'));
    assert(food,'No physical food on café counter');pick(food);
    const cash=w.cash;assert(api.pay(),'Cannot pay for selected food');assert(w.cash===cash-3,'Food charged incorrectly');assert(!api.pay(),'Duplicate food payment');
    const itemId=food.id;w.player.health=90;w.player.lastHurt=w.time;w.input.pressed.add('KeyU');run(.05,60);assert(food.location==='consumed'&&w.player.health===98,'Food did not consume/heal once: '+JSON.stringify({location:food.location,hp:w.player.health,selected:w.inventory.slots[w.inventory.selected]?.type}));
    w.input.pressed.add('KeyU');run(.05,60);assert(w.player.health===98,'Consumed food used twice');assert(w.police.heat===0,'Paid food triggered theft');
    const homes=w.interiors.entries.filter(e=>e.kind==='apartment'), second=homes[1];enter(second);
    const before=w.cash;assert(!api.buy(second.id),'Insufficient funds should block purchase');assert(w.cash===before,'Failed purchase charged cash');
    assert(api.rent(second.id),'Second apartment lease failed');assert(w.cash===before-104,'Second apartment quote incorrect');assert(!api.rent(second.id),'Second apartment lease duplicated');
    const book=w.itemsState.items.find(it=>it.inWorld&&it.type==='book'&&it.authoredKey?.includes(second.id+'/coffee-table-book'));
    assert(book,'No physical book on apartment table');pick(book);w.input.pressed.add('KeyU');run(.05,60);
    assert(w.inventory.slots.some(it=>it?.id===book.id),'Reading consumed the book');assert(w.hud.toast.textContent.includes('Canal field guide'),'Reading did not show book content');
    assert(api.store(second.id),'Second apartment storage failed');assert(!api.store(second.id),'Same book stored twice');
    assert(w.sandbox.save.properties[homes[0].id]?.stored.length===0,'Second home contaminated first home storage');
    return{homes:homes.length,secondApartment:second.id,storedBook:book.id,paidFood:itemId,foodUsedOnce:true,bookReadable:true,mapDestination:true};
  });
}
