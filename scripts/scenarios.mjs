// Scripted scenarios for scripts/shot.mjs. Each gets the Playwright page and helpers.
const hold = async (page, key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
const state = (page) => page.evaluate(() => {
  const w = window.__oc; const v = w.player.vehicle; const p = w.player.mesh.position;
  return { x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1), inCar: !!v, kmh: v ? Math.round(v.speed * 3.6) : 0, heading: v ? +v.heading.toFixed(2) : null, hp: v ? Math.round(v.health) : null, cash: w.cash, stars: w.police.stars };
});
export { hold, state };

export async function world(page, S) {
  await S.start(page);
  await page.waitForTimeout(800);
  return state(page);
}

export async function walk(page, S) {
  await S.start(page);
  const a = await state(page);
  await hold(page, 'KeyW', 1500);
  await page.keyboard.down('ShiftLeft'); await hold(page, 'KeyW', 1000); await page.keyboard.up('ShiftLeft');
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  const air = await state(page);
  await page.waitForTimeout(800);
  const b = await state(page);
  return { a, air, b };
}

// teleport next to the nearest car, enter, and drive
export async function drive(page, S) {
  await S.start(page);
  await page.evaluate(() => {
    const w = window.__oc; const v = w.vehicles[0]; const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.2, y: 1.2, z: t.z - Math.sin(v.heading) * 2.2 }, true);
  });
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(500);
  const out = { start: await state(page) };
  await hold(page, 'KeyW', 3000);
  out.accel3s = await state(page);
  await page.keyboard.down('KeyW'); await hold(page, 'KeyA', 1200); await page.keyboard.up('KeyW');
  out.afterLeft = await state(page);
  await hold(page, 'KeyS', 1500);
  out.braked = await state(page);
  return out;
}

// Deterministic handling test: drives with simulated keys using fixed ticks (no frame-rate dependence).
export async function handling(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, step = window.__ocStep;
    const out = {};
    const keys = w.input.keys;
    const v = w.vehicles.find((c) => c.type === (window.__carType || 'sedan'));
    const z = w.city.zs[w.city.zs.length - 1] + 3;
    const x0 = w.city.xs[0] + 15;
    const q = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) };
    const place = (kmh) => {
      v.body.setTranslation({ x: x0, y: 1, z }, true); v.body.setRotation(q, true);
      v.body.setLinvel({ x: kmh / 3.6, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.health = v.maxHealth; v.wrecked = false; v.prevVel.set(kmh / 3.6, 0, 0); keys.clear(); step(5);
    };
    place(0);
    w.player.body.setTranslation({ x: x0, y: 1, z: z - 2.5 }, true);
    step(30);
    w.input.pressed.add('KeyE'); step(1);
    out.inCar = !!w.player.vehicle;
    const snap = (t) => { const p = v.body.translation(), lv = v.body.linvel(), av = v.body.angvel(); out[t] = { kmh: Math.round(v.speed * 3.6), x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: +p.y.toFixed(2), head: +v.heading.toFixed(2), yaw: +av.y.toFixed(2), slip: +v.slip.toFixed(2), latG: +((Math.hypot(lv.x, lv.z) * Math.abs(av.y)) / 9.81).toFixed(2) }; };
    keys.add('KeyW'); step(60); snap('accel1s'); step(60); snap('accel2s'); step(120); snap('accel4s'); keys.clear();
    // S-curve at 80 km/h
    place(80); keys.add('KeyW'); keys.add('KeyA'); step(30); snap('s80-left0.5'); keys.delete('KeyA'); keys.add('KeyD'); step(30); snap('s80-right0.5'); keys.delete('KeyD'); step(30); snap('s80-settle');
    // slow tight turn at 30 km/h
    place(30); keys.add('KeyA'); step(45); snap('t30-left0.75');
    // handbrake drift at 60 km/h: steer right + handbrake, then power out
    place(60); keys.add('KeyD'); keys.add('Space'); step(20); snap('hb-0.33'); step(20); snap('hb-0.66'); keys.delete('Space'); keys.add('KeyW'); step(25); snap('hb-power'); keys.delete('KeyD'); step(45); snap('hb-recover');
    // full brake from 100
    place(100); keys.add('KeyS'); step(60); snap('brake1s'); step(60); snap('brake2s');
    keys.clear();
    return out;
  });
}

// enter the starting sedan and drive a little in real time for a gameplay screenshot
export async function drivecam(page, S) {
  await S.start(page);
  await page.evaluate(() => {
    const w = window.__oc; const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocStep(10); w.input.pressed.add('KeyE'); window.__ocStep(1);
    w.input.keys.add('KeyW'); window.__ocStep(150); w.input.keys.delete('KeyW');
  });
  await page.waitForTimeout(1500);
  return state(page);
}

// let the city run and measure that traffic and pedestrians actually move
export async function life(page, S) {
  await S.start(page);
  const snap = () => page.evaluate(() => {
    const w = window.__oc;
    return { cars: w.traffic.map((c) => { const t = c.body.translation(); return [t.x, t.z, c.phase, c.speed]; }), peds: w.peds.map((p) => [p.pos.x, p.pos.z, p.state]) };
  });
  const a = await snap();
  await page.evaluate(() => window.__ocRun(20));
  const b = await snap();
  const moved = (A, B) => A.filter((p, i) => Math.hypot(p[0] - B[i][0], p[1] - B[i][1]) > 2).length;
  const states = {};
  for (const p of b.peds) states[p[2]] = (states[p[2]] || 0) + 1;
  const phases = {};
  for (const c of b.cars) phases[c[2]] = (phases[c[2]] || 0) + 1;
  // look at a busy junction from above the player
  return { carsMoved: moved(a.cars, b.cars) + '/' + a.cars.length, pedsMoved: moved(a.peds, b.peds) + '/' + a.peds.length, pedStates: states, carPhases: phases, simTime: await page.evaluate(() => window.__oc.time) };
}

export async function traffic2(page, S) {
  await S.start(page);
  const out = [];
  for (let k = 0; k < 6; k++) {
    await page.evaluate(() => window.__ocRun(20));
    out.push(await page.evaluate(() => {
      const w = window.__oc;
      const ph = {}; let stopped = 0, sum = 0, stun = 0;
      for (const c of w.traffic) { ph[c.phase] = (ph[c.phase] || 0) + 1; if (c.speed < 0.3) stopped++; sum += c.speed; if (c.stunT > 0) stun++; }
      const t0 = w.traffic[0]; const tt = t0.body.translation();
      return { t: Math.round(w.time), ph, stopped, avg: +(sum / w.traffic.length).toFixed(1), stun, c0: [Math.round(tt.x), Math.round(tt.y * 10) / 10, Math.round(tt.z), t0.phase, +t0.speed.toFixed(1), t0.from, t0.to] };
    }));
  }
  return out;
}

// Taxi loop: get in a car, then for 3 fares teleport the car to the pickup kerb and the drop-off kerb.
export async function taxi(page, S) {
  await S.start(page);
  const res = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const taxi = w.jobs.get('taxi');
    const v = w.vehicles.find((c) => c.type === 'sedan');
    const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const out = { inCar: !!w.player.vehicle, fares: [] };
    const tp = (x, z) => {
      v.body.setTranslation({ x, y: 1.0, z }, true); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.prevVel.set(0, 0, 0);
    };
    for (let k = 0; k < 3; k++) {
      let guard = 0;
      while (taxi.phase !== 'waiting' && guard++ < 100) run(0.2);
      const startCash = w.cash;
      const pk = { x: taxi.pickup.x, z: taxi.pickup.y, name: taxi.pickupName };
      tp(pk.x, pk.z); run(2.5);
      const boarded = taxi.phase;
      const dest = taxi.dest ? { name: taxi.dest.name, street: taxi.dest.street, dist: Math.round(taxi.tripDist), allowance: Math.round(taxi.allowance) } : null;
      run(Math.max(5, (dest?.dist ?? 300) / 20)); // pretend we drove at ~72 km/h
      if (k === 2) { v.health -= 10; } // crash on the last fare: tip should be lost
      if (taxi.dest) tp(taxi.dest.curbX, taxi.dest.curbZ);
      run(1.5);
      out.fares.push({ pickup: pk.name, boarded, dest, paid: w.cash - startCash, phase: taxi.phase });
    }
    out.completed = taxi.completed;
    out.cash = w.cash;
    out.hud = w.jobs.statusText();
    return out;
  });
  await page.waitForTimeout(800);
  return res;
}

// Talk to two pedestrians through the real chat box (typing into the input), plus a grudge test.
export async function chat(page, S) {
  await S.start(page);
  const say = async (text) => {
    await page.fill('#chat input', text);
    await page.press('#chat input', 'Enter');
    await page.waitForTimeout(250);
  };
  const talkTo = async (idx) => {
    await page.evaluate((i) => {
      const w = window.__oc; const p = w.peds[i];
      p.state = 'idle'; p.timer = 30;
      w.player.body.setTranslation({ x: p.pos.x + 1.2, y: 1.2, z: p.pos.z }, true);
      window.__ocRun(0.3);
    }, idx);
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
    return page.evaluate(() => window.__oc.chat.open);
  };
  const log = () => page.evaluate(() => [...document.querySelectorAll('#chat .log div')].map((d) => d.textContent));
  const out = {};
  out.open1 = await talkTo(3);
  for (const t of ['hello!', 'how are you?', 'what do you do?', 'any work around here? I need money']) await say(t);
  await page.screenshot({ path: 'screenshots/07-chat.png' });
  await say('need a ride somewhere?');
  out.ped1 = await page.evaluate(() => { const p = window.__oc.peds[3]; return { name: p.npc.name, personality: p.npc.personality, rel: p.npc.relationship, mem: p.npc.memory.map((m) => m.note) }; });
  out.log1 = await log();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const c = window.__oc.chat; if (c.open) c.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.__ocRun(1.5); });
  out.open2 = await talkTo(7);
  for (const t of ['hey', 'heard any gossip?', 'where is the marina?', 'you are an idiot', 'sorry about that', 'bye']) await say(t);
  out.log2 = await log();
  await page.evaluate(() => { const c = window.__oc.chat; if (c.open) c.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  // grudge: knock ped 12 down with a car, then try to talk
  out.grudge = await page.evaluate(() => {
    const w = window.__oc; const p = w.peds[12];
    p.state = 'idle'; p.timer = 30;
    const v = w.vehicles[1];
    w.player.body.setTranslation({ x: v.body.translation().x + 2, y: 1.2, z: v.body.translation().z }, true);
    window.__ocRun(0.2);
    if (!w.player.vehicle) { w.input.pressed.add('KeyE'); window.__ocRun(0.1); }
    // aim the car at the pedestrian at 40 km/h
    const dx = p.pos.x - 12, dz = p.pos.z;
    const h = Math.PI / 2;
    v.body.setTranslation({ x: p.pos.x - 12, y: 1.0, z: p.pos.z }, true);
    v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
    v.body.setLinvel({ x: 11, y: 0, z: 0 }, true); v.prevVel.set(11, 0, 0);
    window.__ocRun(1.5);
    const hit = p.state;
    const stars = w.police.stars;
    window.__ocRun(9);
    return { hit, stars, rel: p.npc.relationship, mem: p.npc.memory.map((m) => m.note) };
  });
  await page.evaluate(() => { const w = window.__oc; if (w.player.vehicle) { w.player.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true); window.__ocRun(0.5); w.input.pressed.add('KeyE'); window.__ocRun(0.2); } });
  out.open3 = await talkTo(12);
  for (const t of ['hi there', 'hello?', 'come on, talk to me']) { if (await page.evaluate(() => window.__oc.chat.open)) await say(t); }
  out.log3 = await log();
  out.stars = await page.evaluate(() => window.__oc.police.stars);
  return out;
}

// Police: commit crimes, get chased, then hide out of sight and lose them.
export async function police(page, S) {
  await S.start(page);
  const out = {};
  out.crime = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const v = w.vehicles.find((c) => c.type === 'pickup');
    const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.6, y: 1.2, z: t.z - Math.sin(v.heading) * 2.6 }, true);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    // run over two pedestrians
    const hits = [];
    for (const i of [20, 21]) {
      const p = w.peds[i]; p.state = 'idle'; p.timer = 30;
      const h = Math.PI / 2;
      v.body.setTranslation({ x: p.pos.x - 12, y: 1.0, z: p.pos.z }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setLinvel({ x: 13, y: 0, z: 0 }, true); v.prevVel.set(13, 0, 0);
      run(1.2);
      hits.push(p.state);
    }
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    return { hits, stars: w.police.stars, heat: w.police.heat };
  });
  // let police arrive: park the car in the middle of a long road and wait
  out.chase = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const v = w.player.vehicle;
    const c = w.city;
    v.body.setTranslation({ x: c.xs[4] + 30, y: 1, z: c.zs[2] + 3 }, true); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0);
    const samples = [];
    for (let k = 0; k < 6; k++) {
      run(3);
      const p = v.body.translation();
      samples.push({ t: Math.round(w.time), stars: w.police.stars, seen: w.police.seen, cars: w.police.cars.length, nearest: Math.round(Math.min(...w.police.cars.map((pc) => { const q = pc.body.translation(); return Math.hypot(q.x - p.x, q.z - p.z); }))) });
      if (w.police.seen) break;
    }
    return samples;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'screenshots/08-police-chase.png' });
  // escape: teleport into a different car far away behind buildings (out of sight), then wait
  out.escape = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const c = w.city;
    const v2 = w.vehicles.find((x) => x.type === 'hatchback');
    w.input.pressed.add('KeyE'); run(0.1); // get out
    const far = { x: c.xs[c.xs.length - 2] - 30, z: c.zs[0] + 3 };
    v2.body.setTranslation({ x: far.x, y: 1, z: far.z }, true); v2.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v2.prevVel.set(0, 0, 0);
    w.player.body.setTranslation({ x: far.x + 2.2, y: 1.2, z: far.z }, true);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const samples = [];
    for (let k = 0; k < 20; k++) {
      run(3);
      samples.push({ t: Math.round(w.time), stars: w.police.stars, seen: w.police.seen, lose: +w.police.loseTimer.toFixed(1), cars: w.police.cars.length });
      if (w.police.stars === 0 && w.police.cars.length === 0) break;
    }
    return { inCar: w.player.vehicle?.type, samples };
  });
  return out;
}

export async function bust(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const c = w.city;
    w.player.body.setTranslation({ x: c.xs[4] + 30, y: 1.2, z: c.zs[2] + 9 }, true);
    run(0.2);
    w.events.push({ type: 'policeCalled', x: 0, z: 0, byPed: 0 }, { type: 'policeCalled', x: 0, z: 0, byPed: 0 });
    run(0.05);
    const s = [];
    const cash0 = w.cash;
    for (let k = 0; k < 20; k++) {
      run(2);
      const pp = w.player.mesh.position;
      s.push([Math.round(w.time), w.police.stars, w.police.seen ? 'seen' : '-', Math.round(Math.min(999, ...w.police.cars.map((pc) => { const q = pc.body.translation(); return Math.hypot(q.x - pp.x, q.z - pp.z); }))), +w.police.bustTimer.toFixed(1)]);
      if (w.police.stars === 0) break;
    }
    return { s, cashLost: cash0 - w.cash };
  });
}

export async function debug(page, S) {
  await S.start(page);
  await page.keyboard.press('F3');
  await page.evaluate(() => window.__ocRun(1));
  await page.waitForTimeout(1500);
  return page.evaluate(() => document.getElementById('debug').textContent);
}

// jump the clock to night and look at the lights
export async function night(page, S) {
  await S.start(page);
  await page.evaluate(() => { const w = window.__oc; w.dayNight.hour = 21.5; window.__ocRun(0.5); });
  await page.waitForTimeout(1500);
  return page.evaluate(() => window.__oc.dayNight.night);
}

export async function nightdrive(page, S) {
  await S.start(page);
  await page.evaluate(() => {
    const w = window.__oc; w.dayNight.hour = 22;
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    w.input.keys.add('KeyW'); window.__ocRun(2); w.input.keys.delete('KeyW');
  });
  await page.waitForTimeout(1500);
  return state(page);
}

export async function perf(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc;
    // drive around so peds/traffic react
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.1);
    w.police.heat = 120;
    const t0 = performance.now();
    window.__ocRun(10, 60);
    const simMs = (performance.now() - t0) / 600;
    // water + render-side CPU (without GPU): time updateCity-like work by rendering a few frames
    const r0 = performance.now();
    for (let k = 0; k < 20; k++) w.renderer.render(w.scene, w.camera);
    const renderMs = (performance.now() - r0) / 20;
    return { simMsPerFrame: +simMs.toFixed(2), swiftshaderRenderMs: +renderMs.toFixed(1), calls: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles };
  });
}

export async function backtick(page, S) {
  await S.start(page);
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(1200);
  return page.evaluate(() => getComputedStyle(document.getElementById('debug')).display);
}

export async function tank(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, k = w.input.keys;
    const p = () => { const m = w.player.mesh.position; return { x: +m.x.toFixed(1), z: +m.z.toFixed(1), facing: +w.player.facing.toFixed(2), camYaw: +w.cam.yaw.toFixed(2) }; };
    const a = p();
    k.add('KeyW'); run(1); k.delete('KeyW'); const b = p();
    k.add('KeyA'); run(0.5); k.delete('KeyA'); const c = p();
    k.add('KeyW'); run(1); k.delete('KeyW'); run(1); const d = p();
    k.add('KeyS'); run(1); k.delete('KeyS'); const e = p();
    return { a, b, c, d, e };
  });
}

export async function chatbuttons(page, S) {
  await S.start(page);
  await page.evaluate(() => { const w = window.__oc; const p = w.peds[5]; p.state = 'idle'; p.timer = 30; w.player.body.setTranslation({ x: p.pos.x + 1.2, y: 1.2, z: p.pos.z }, true); window.__ocRun(0.3); });
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  for (const label of ['👋 Hi', 'Gossip?', 'Any work?']) { await page.click(`#chat .quick button:has-text("${label}")`); await page.waitForTimeout(250); }
  await page.screenshot({ path: 'screenshots/10-chat-buttons.png' });
  await page.click('#chat .close');
  return page.evaluate(() => ({ open: window.__oc.chat.open, lines: window.__oc.peds[5].npc.history.length }));
}

// usage: node scripts/shot.mjs name weathershot  (with ?weather= via the seed arg hack: pass "1337&weather=rain")
export async function weathershot(page, S) {
  await S.start(page);
  await page.evaluate(() => {
    const w = window.__oc;
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    if (window.__hour) w.dayNight.hour = window.__hour;
    window.__ocRun(30);
  });
  await page.waitForTimeout(1500);
  return page.evaluate(() => ({ kind: window.__oc.weather.kind, grip: window.__oc.weather.grip, snow: window.__oc.weather.snowCover }));
}
