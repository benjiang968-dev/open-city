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

// Crash benchmark: 10 crashes into building walls / traffic at different speeds. Per-frame CPU incl. render.
export async function crashbench(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc;
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    const R = window.__ocFrames;
    R(30, true); // warm up
    const base = R(40, true).map((f) => f.cpu);
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const speeds = [20, 35, 50, 60, 70, 80, 90, 100, 110, 120];
    const crashes = [];
    // pick tall buildings far from each other
    const bs = w.city.buildingRects.filter((b) => b.h > 10).slice(0, 40);
    speeds.forEach((kmh, i) => {
      const b = bs[(i * 3) % bs.length];
      const cx = (b.x0 + b.x1) / 2, z = b.z1 + 18; // south of the building, facing north (-z)
      const h = Math.PI;
      v.body.setTranslation({ x: cx, y: 0.9, z }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.body.setLinvel({ x: 0, y: 0, z: -kmh / 3.6 }, true);
      v.prevVel.set(0, 0, -kmh / 3.6);
      v.health = v.maxHealth; v.wrecked = false;
      const frames = R(60, true);
      const worst = frames.reduce((a, f) => (f.cpu > a.cpu ? f : a));
      crashes.push({ kmh, hp: Math.round(v.health), worst: worst.cpu, top: worst.top, over33: frames.filter((f) => f.cpu > 33).length });
    });
    return { baselineMedian: median(base), baselineMax: Math.max(...base), crashes };
  });
}

// Crash spike bench (CPU only, no rendering): walls at 10 speeds, 3 traffic cars, then a wreck.
// Reports frames over 33 ms, the worst frame + breakdown, and JS heap growth.
export async function crashspikes(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc;
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    const R = (n) => window.__ocFrames(n, false);
    R(60);
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const all = [];
    const bs = w.city.buildingRects.filter((b) => b.h > 10 && b.x1 - b.x0 > 12);
    const launch = (x, z, h, kmh) => {
      v.body.setTranslation({ x, y: 0.9, z }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const vx = Math.sin(h) * kmh / 3.6, vz = Math.cos(h) * kmh / 3.6;
      v.body.setLinvel({ x: vx, y: 0, z: vz }, true); v.prevVel.set(vx, 0, vz);
    };
    const hits = [];
    [20, 35, 50, 60, 70, 80, 90, 100, 110, 120].forEach((kmh, i) => {
      const b = bs[(i * 5) % bs.length];
      v.health = v.maxHealth; v.wrecked = false;
      const hp0 = v.health;
      launch((b.x0 + b.x1) / 2, b.z1 + 12, Math.PI, kmh);
      const fr = R(60); all.push(...fr); const wf = fr.reduce((a, f) => (f.cpu > a.cpu ? f : a));
      hits.push(`${kmh}km/h -${Math.round(hp0 - v.health)}hp worst ${wf.cpu} [${wf.top}]`);
    });
    // three traffic cars (raises heat, spawns police)
    for (let k = 0; k < 3; k++) {
      const c = w.traffic[k * 5]; const ct = c.body.translation();
      v.health = v.maxHealth; v.wrecked = false;
      launch(ct.x - Math.sin(c.heading + 1.2) * 14, ct.z - Math.cos(c.heading + 1.2) * 14, c.heading + 1.2, 70);
      const fr = R(90); all.push(...fr); const wf = fr.reduce((a, f) => (f.cpu > a.cpu ? f : a));
      hits.push(`traffic ${k} worst ${wf.cpu} [${wf.top}]`);
    }
    // a wreck
    v.health = 5; v.wrecked = false;
    const b = bs[3]; launch((b.x0 + b.x1) / 2, b.z1 + 12, Math.PI, 90);
    { const fr = R(60); all.push(...fr); const wf = fr.reduce((a, f) => (f.cpu > a.cpu ? f : a)); hits.push(`wreck worst ${wf.cpu} [${wf.top}]`); }
    const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const worst = all.reduce((a, f) => (f.cpu > a.cpu ? f : a));
    const sorted = all.map((f) => f.cpu).sort((a, b) => a - b);
    return {
      frames: all.length, over33: all.filter((f) => f.cpu > 33).length, over16: all.filter((f) => f.cpu > 16.7).length,
      median: sorted[Math.floor(sorted.length / 2)], p99: sorted[Math.floor(sorted.length * 0.99)], worst: worst.cpu, worstTop: worst.top,
      heapGrowthMB: +((heap1 - heap0) / 1e6).toFixed(1), damage: hits, stars: w.police.stars, police: w.police.cars.length,
    };
  });
}

// Crash the sedan nose-first into a wall twice, then turn it round and look at the front.
export async function dentclean(page, S) {
  await page.evaluate(() => { window.__noCrash = true; });
  return dent(page, S);
}
export async function dent(page, S) {
  await S.start(page);
  const r = await page.evaluate(() => {
    const w = window.__oc;
    const v = w.vehicles.find((c) => c.type === 'sedan'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    // a building with open ground (road) for 20 m south of it
    const R0 = w.R;
    const free = (x, z) => !w.physics.castRay(new R0.Ray({ x, y: 30, z }, { x: 0, y: -1, z: 0 }), 29.5, true, R0.QueryFilterFlags.ONLY_FIXED);
    const b = w.city.buildingRects.filter((q) => q.h > 10 && q.x1 - q.x0 > 12).find((q) => [4, 8, 12, 16, 20].every((d) => free((q.x0 + q.x1) / 2 - 1, q.z1 + d) && free((q.x0 + q.x1) / 2 + 1, q.z1 + d)));
    const launch = (kmh, xoff) => {
      const h = Math.PI;
      v.body.setTranslation({ x: (b.x0 + b.x1) / 2 + xoff, y: 0.9, z: b.z1 + 10 }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.body.setLinvel({ x: 0, y: 0, z: -kmh / 3.6 }, true); v.prevVel.set(0, 0, -kmh / 3.6);
      return window.__ocFrames(50, false);
    };
    const f1 = window.__noCrash ? [] : launch(55, 0.6); const f2 = window.__noCrash ? launch(3, 0) : launch(75, -0.5);
    const frames = [...f1, ...f2];
    // turn round so the camera (south of the car) sees the crumpled nose
    const tt = v.body.translation();
    v.body.setTranslation({ x: tt.x, y: 0.9, z: tt.z + 6 }, true);
    v.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0);
    window.__ocRun(1.5);
    const c = v.body.translation();
    w.cam.override = { px: c.x + 3.2, py: 2.2, pz: c.z + 5.5, lx: c.x, ly: 0.6, lz: c.z + 1.5 };
    const rr = v.body.rotation(); const tp = v.body.translation();
    let minY = 1e9, maxDisp = 0; const P = v.dmg.pos, B = v.dmg.base;
    for (let i = 0; i < P.length; i += 3) { minY = Math.min(minY, P[i + 1]); maxDisp = Math.max(maxDisp, Math.hypot(P[i] - B[i], P[i + 1] - B[i + 1], P[i + 2] - B[i + 2])); }
    const R = w.R; const gh = w.physics.castRay(new R.Ray({ x: tp.x, y: 5, z: tp.z }, { x: 0, y: -1, z: 0 }), 20, true, R.QueryFilterFlags.ONLY_FIXED);
    return { ground: gh ? +(5 - gh.timeOfImpact).toFixed(2) : null, susp: [0, 1, 2, 3].map((i) => +(v.ctrl.wheelSuspensionLength(i) || 0).toFixed(2)), y: +tp.y.toFixed(2), rot: [rr.x, rr.y, rr.z, rr.w].map((q) => +q.toFixed(2)), contacts: [0, 1, 2, 3].map((i) => v.ctrl.wheelIsInContact(i)), minY: +minY.toFixed(2), maxDisp: +maxDisp.toFixed(2), hp: Math.round(v.health), dent: +v.dmg.dentTotal.toFixed(2), bumpers: v.dmg.bumpers.map((q) => q.state), lights: v.dmg.lights.map((l) => l.visible), crack: v.dmg.crack.visible, over33: frames.filter((f) => f.cpu > 33).length, worst: Math.max(...frames.map((f) => f.cpu)) };
  });
  await page.waitForTimeout(1500);
  return r;
}

// Milestone 1 gate: 10 crashes, die from crashes, wake at the clinic; hit by traffic on foot; treated at clinic.
export async function gate1(page, S) {
  await S.start(page);
  const out = await page.evaluate(() => {
    const w = window.__oc, R0 = w.R;
    const free = (x, z) => !w.physics.castRay(new R0.Ray({ x, y: 30, z }, { x: 0, y: -1, z: 0 }), 29.5, true, R0.QueryFilterFlags.ONLY_FIXED);
    const walls = w.city.buildingRects.filter((q) => q.h > 10 && q.x1 - q.x0 > 12).filter((q) => [4, 8, 12, 16].every((d) => free((q.x0 + q.x1) / 2 - 1, q.z1 + d) && free((q.x0 + q.x1) / 2 + 1, q.z1 + d)));
    const v = w.vehicles.find((c) => c.type === 'pickup'); const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.6, y: 1.2, z: t.z - Math.sin(v.heading) * 2.6 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    w.cash = 500;
    const frames = [];
    const log = [];
    const launch = (b, kmh) => {
      const h = Math.PI;
      v.body.setTranslation({ x: (b.x0 + b.x1) / 2, y: 1.0, z: b.z1 + 9 }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.body.setLinvel({ x: 0, y: 0, z: -kmh / 3.6 }, true); v.prevVel.set(0, 0, -kmh / 3.6);
      v.health = v.maxHealth; v.wrecked = false;
      const f = window.__ocFrames(45, false); frames.push(...f);
    };
    [25, 40, 55, 30, 70, 45, 60, 35, 50, 65].forEach((kmh, i) => {
      w.player.health = 100; launch(walls[i % walls.length], kmh);
      log.push(`${kmh} km/h → player hp ${Math.round(w.player.health)}`);
    });
    const dents = +v.dmg.dentTotal.toFixed(2);
    // die: very hard crashes
    w.player.health = 100;
    const cash0 = w.cash, hour0 = w.dayNight.hour;
    let k = 0;
    while (!w.player.dead && k < 6) { launch(walls[k % walls.length], 140); k++; }
    const died = w.player.dead;
    const deadPos = { ...w.player.mesh.position };
    window.__ocFrames(60, false); // fade
    const midFade = document.getElementById('death').style.opacity;
    window.__ocFrames(240, false); // wake
    const clinic = w.city.pois.find((q) => q.kind === 'clinic');
    const pp = w.player.mesh.position;
    const wake = { dead: w.player.dead, hp: w.player.health, inCar: !!w.player.vehicle, distToClinic: Math.round(Math.hypot(pp.x - clinic.x, pp.z - clinic.z)), fee: cash0 - w.cash, hoursPassed: +(((w.dayNight.hour - hour0) + 24) % 24).toFixed(3), stars: w.police.stars, taxi: w.jobs.get('taxi').phase };
    // on foot: step in front of a traffic car
    const car = w.traffic.find((c) => c.phase === 'lane' && c.speed > 5) ?? w.traffic[0];
    car.speed = 11;
    w.player.body.setTranslation({ x: car.px + Math.sin(car.heading) * 6, y: 1.2, z: car.pz + Math.cos(car.heading) * 6 }, true);
    window.__ocRun(1.5);
    const footHp = Math.round(w.player.health);
    // clinic
    w.player.body.setTranslation({ x: clinic.x, y: 1.2, z: clinic.z }, true);
    window.__ocRun(0.3);
    const prompt = w.player.prompt;
    const c0 = w.cash;
    w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    const treated = { prompt, hp: w.player.health, paid: c0 - w.cash };
    return { log, dents, died, crashesToDie: k, midFade, wake, footHp, treated, over33: frames.filter((f) => f.cpu > 33).length, worst: Math.max(...frames.map((f) => f.cpu)) };
  });
  return out;
}

export async function injured(page, S) {
  await S.start(page);
  await page.evaluate(() => { const w = window.__oc; w.player.health = 22; w.player.lastHurt = w.time; });
  await page.waitForTimeout(1500);
  return page.evaluate(() => ({ hp: window.__oc.player.health, vignette: document.getElementById('vignette').style.opacity }));
}
export async function deathscreen(page, S) {
  await S.start(page);
  await page.evaluate(() => { const w = window.__oc; w.player.health = 5; window.__ocRun(0.1); });
  await page.evaluate(() => { const w = window.__oc; w.player.lastHurt = -10; });
  await page.evaluate(() => { const w = window.__oc; const v = w.player; v.health = 1; });
  await page.evaluate(() => { window.__oc.player.health = 0.5; });
  // hurt through the real path
  await page.evaluate(() => { const w = window.__oc; w.player.dead = false; w.events.push({ type: 'crash', x: 0, z: 0, damage: 50, dv: 99 }); });
  await page.evaluate(() => { const w = window.__oc; const v = w.vehicles[0]; w.player.vehicle = v; v.driven = true; window.__ocRun(0.05); w.player.vehicle = null; v.driven = false; });
  await page.evaluate(() => window.__ocRun(2.5));
  await page.waitForTimeout(800);
  return page.evaluate(() => ({ dead: window.__oc.player.dead, opacity: document.getElementById('death').style.opacity }));
}

export async function pause(page, S) {
  await S.start(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__oc.paused, null, { timeout: 5000 }).catch(() => {});
  const a = await page.evaluate(() => ({ paused: window.__oc.paused, t: window.__oc.dayNight.hour, shown: getComputedStyle(document.getElementById('pause')).display }));
  await page.click('#q-low');
  await page.waitForTimeout(600);
  const b = await page.evaluate(() => ({ q: window.__oc.settings.quality, shadows: window.__oc.renderer.shadowMap.enabled, budget: window.__oc.settings.pedBudget, pr: window.__oc.renderer.getPixelRatio(), t: window.__oc.dayNight.hour }));
  await page.click('#q-medium');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'screenshots/15-pause-menu.png' });
  await page.click('#pause-resume');
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => ({ paused: window.__oc.paused, q: window.__oc.settings.quality, shadows: window.__oc.renderer.shadowMap.enabled, pr: window.__oc.renderer.getPixelRatio() }));
  return { a, b, frozen: Math.abs(b.t - a.t) < 1e-6, c };
}

// Items: walk up to a bottle, E to pick up, pick up a bat too, Q drop, wheel select; held item visible.
export async function items(page, S) {
  await S.start(page);
  const step = (sec = 0.15) => page.evaluate((s) => window.__ocRun(s), sec);
  const near = (type) => page.evaluate((t) => {
    const w = window.__oc; const it = w.itemsState.items.find((i) => i.type === t && i.inWorld);
    w.player.body.setTranslation({ x: it.px, y: 1.2, z: it.pz - 1.1 }, true); w.player.facing = 0; w.cam.yaw = Math.PI;
    window.__ocRun(0.4);
    return { target: w.itemsState.target?.type ?? null, prompt: w.player.prompt };
  }, type);
  const counts = await page.evaluate(() => { const c = {}; for (const i of window.__oc.itemsState.items) c[i.type] = (c[i.type] || 0) + 1; return c; });
  const a = await near('bottle');
  await page.keyboard.press('KeyE'); await step();
  const b = await near('bat');
  await page.keyboard.press('KeyE'); await step();
  const slots1 = await page.evaluate(() => window.__oc.inventory.slots.map((s) => (s ? s.type : null)));
  await page.keyboard.press('Digit2'); await step();
  const held = await page.evaluate(() => Object.entries(window.__oc.inventory.held).filter(([, m]) => m.visible).map(([k]) => k));
  await page.evaluate(() => { const w = window.__oc; const p = w.player.mesh.position; w.cam.override = { px: p.x + 2.6, py: 1.9, pz: p.z + 2.2, lx: p.x, ly: 1.0, lz: p.z }; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/16-holding-bat.png' });
  await page.evaluate(() => { window.__oc.cam.override = null; });
  await page.keyboard.press('Digit1'); await step();
  await page.keyboard.press('KeyQ'); await step();
  const dropped = await page.evaluate(() => { const w = window.__oc; window.__ocRun(2); const it = w.itemsState.items.find((i) => i.type === 'bottle' && Math.hypot(i.px - w.player.mesh.position.x, i.pz - w.player.mesh.position.z) < 3 && i.inWorld); return it ? { y: +it.py.toFixed(2), sleeping: it.body.isSleeping() } : null; });
  const slots2 = await page.evaluate(() => window.__oc.inventory.slots.map((s) => (s ? s.type : null)));
  await page.mouse.wheel(0, 120); await step();
  const selAfterWheel = await page.evaluate(() => window.__oc.inventory.selected);
  return { counts, a, b, slots1, held, dropped, slots2, selAfterWheel };
}

// Combat: throw a bottle at a pedestrian, then bat a parked car.
export async function combat(page, S) {
  await S.start(page);
  const r1 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const bottle = w.itemsState.items.find((i) => i.type === 'bottle' && i.inWorld);
    // put the player at the bottle and pick it up
    w.player.body.setTranslation({ x: bottle.px, y: 1.2, z: bottle.pz - 1.0 }, true); w.player.facing = 0;
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const held = w.inventory.slots[w.inventory.selected]?.type;
    // a pedestrian stands 5 m ahead
    const ped = w.peds.find((p) => p.npc.personality === 'grumpy') ?? w.peds[2];
    const pp = w.player.mesh.position;
    ped.pos.set(pp.x, 0.02, pp.z + 5); ped.state = 'idle'; ped.timer = 30; ped.route = [];
    w.player.facing = 0; w.cam.yaw = Math.PI; w.cam.pitch = 0.49;
    w.input.keys.add('KeyF'); run(0.36);
    const charging = { charging: w.combat.charging, charge: +w.combat.charge.toFixed(2), arc: w.combat.arc.visible };
    window.__peek = { x: pp.x, z: pp.z };
    return { held, ped: ped.id, personality: ped.npc.personality, charging };
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'screenshots/17-throw-arc.png' });
  const r2 = await page.evaluate((pid) => {
    const w = window.__oc, run = window.__ocRun;
    w.input.keys.delete('KeyF'); run(0.05);
    const ped = w.peds[pid];
    const states = [];
    for (let k = 0; k < 8; k++) { run(0.15); states.push(ped.state); }
    return { slotAfter: w.inventory.slots[w.inventory.selected], states, health: ped.health, rel: ped.npc.relationship, mem: ped.npc.memory.map((m) => m.note), hitCount: ped.hitCount };
  }, r1.ped);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'screenshots/17-hit-reaction.png' });
  const r3 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const bat = w.itemsState.items.find((i) => i.type === 'bat' && i.inWorld);
    w.player.body.setTranslation({ x: bat.px, y: 1.2, z: bat.pz - 1.0 }, true); w.player.facing = 0;
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const slot = w.inventory.slots.findIndex((s) => s && s.type === 'bat'); w.inventory.selected = slot;
    // a parked car right in front, side-on
    const v = w.vehicles.find((c) => c.type === 'hatchback' && !c.driven);
    const pp = w.player.mesh.position;
    v.body.setTranslation({ x: pp.x, y: 0.8, z: pp.z + 2.1 }, true); v.body.setRotation({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0);
    run(0.6);
    const d0 = v.dmg.dentTotal;
    w.player.facing = 0; w.cam.yaw = Math.PI;
    for (let k = 0; k < 3; k++) { w.input.keys.add('KeyF'); run(0.1); w.input.keys.delete('KeyF'); run(0.8); }
    const c = v.body.translation();
    w.cam.override = { px: c.x + 3.5, py: 2.0, pz: c.z - 3.0, lx: c.x, ly: 0.7, lz: c.z };
    return { dentBefore: +d0.toFixed(2), dentAfter: +v.dmg.dentTotal.toFixed(2), hp: Math.round(v.health) };
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/17-bat-dent.png' });
  return { r1, r2, r3 };
}

// Crowd: archetypes, budget per quality, shove, CPU cost with 60 people; screenshot of a busy pavement.
export async function crowd(page, S) {
  await S.start(page);
  const r = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const arch = {}; for (const p of w.peds) arch[p.archetype] = (arch[p.archetype] || 0) + 1;
    const active = () => w.peds.filter((p) => p.active).length;
    const a0 = active();
    run(25); // let the recycler pull people in around the player
    const pp = w.player.mesh.position;
    const near = w.peds.filter((p) => p.active && Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z) < 120).length;
    // shove: put an adult right in front and walk into them
    const ped = w.peds.find((p) => p.archetype === 'adult' && p.active);
    ped.pos.set(pp.x, 0.02, pp.z + 0.9); ped.state = 'idle'; ped.timer = 20; run(0.1);
    w.player.facing = 0; w.input.keys.add('KeyW'); run(0.8); w.input.keys.delete('KeyW');
    const shove = { state: ped.state, shoved: ped.shoveCount, moved: +(ped.pos.z - pp.z).toFixed(2) };
    // CPU with 60 people
    w.settings.pedBudget = 60;
    const budget = window.__applyBudget ? 0 : 0;
    return { arch, a0, near, shove };
  });
  // switch to High through the menu to activate 60
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__oc.paused, null, { timeout: 8000 }).catch(() => {});
  await page.click('#q-high');
  const hi = await page.evaluate(() => window.__oc.peds.filter((p) => p.active).length);
  await page.click('#q-medium');
  await page.click('#pause-resume');
  const perf = await page.evaluate(() => {
    const w = window.__oc;
    document.getElementById('q-high')?.click();
    const f = window.__ocFrames(120, false).map((x) => x.cpu).sort((a, b) => a - b);
    const ped = f[Math.floor(f.length / 2)];
    const fr = window.__ocFrames(10, true);
    return { median: ped, p95: f[Math.floor(f.length * 0.95)], max: f[f.length - 1], calls: w.renderer.info.render.calls, renderTop: fr[fr.length - 1].top };
  });
  // a pavement full of people: look at the nearest group from above-behind
  await page.evaluate(() => {
    const w = window.__oc;
    let best = null, bc = 0;
    for (const p of w.peds) { if (!p.active) continue; const c = w.peds.filter((q) => q.active && Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) < 14).length; if (c > bc) { bc = c; best = p; } }
    w.player.body.setTranslation({ x: best.pos.x - 4, y: 1.2, z: best.pos.z - 9 }, true); window.__ocRun(0.2);
    w.cam.override = { px: best.pos.x - 6, py: 5.5, pz: best.pos.z - 13, lx: best.pos.x, ly: 0.8, lz: best.pos.z };
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/18-crowd.png' });
  return { ...r, high: hi, perf };
}

export async function lineup(page, S) {
  await S.start(page);
  const r = await page.evaluate(() => {
    const w = window.__oc;
    const c = w.city;
    w.player.body.setTranslation({ x: c.xs[3] + 20, y: 1.2, z: c.zs[c.zs.length - 1] + 12 }, true);
    window.__ocRun(0.2);
    const pp = w.player.mesh.position;
    const want = ['adult', 'jogger', 'delivery', 'tourist', 'elderly', 'parent', 'dogwalker'];
    const picked = [];
    want.forEach((a, i) => {
      const p = w.peds.find((q) => q.archetype === a && q.active && !picked.includes(q));
      if (!p) return;
      picked.push(p);
      p.pos.set(pp.x - 6 + i * 2, 0.02, pp.z + 6); p.heading = Math.PI; p.route = [];
      if (a === 'elderly') p.prop = 'cane';
      p.state = a === 'delivery' ? 'walk' : 'idle'; p.timer = a === 'tourist' ? 3 : 30;
      if (a === 'delivery') { p.route = [{ x: p.pos.x, y: p.pos.z - 30 }]; p.routeIdx = 0; }
      if (p.dog) p.dog.pos.set(p.pos.x + 0.9, 0.02, p.pos.z - 0.6);
      for (const kid of w.peds) if (kid.followId === p.id) { kid.pos.set(p.pos.x + 0.9, 0.02, p.pos.z); kid.state = 'follow'; }
    });
    window.__ocRun(0.3);
    w.cam.override = { px: pp.x, py: 2.6, pz: pp.z - 1, lx: pp.x, ly: 1.0, lz: pp.z + 6 };
    return picked.map((p) => `${p.archetype}:${p.armPose}`);
  });
  await page.waitForTimeout(1500);
  return r;
}

// Witness: throw a bottle at someone who calls 999; watch the visible call window; get a star; police dispatched.
export async function witness(page, S) {
  await S.start(page);
  const setup = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const bottle = w.itemsState.items.find((i) => i.type === 'bottle' && i.inWorld);
    w.player.body.setTranslation({ x: bottle.px, y: 1.2, z: bottle.pz - 1.0 }, true); w.player.facing = 0;
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const pp = w.player.mesh.position;
    const victim = w.peds.find((p) => p.active && p.archetype === 'adult' && (p.npc.personality === 'posh' || p.npc.personality === 'friendly'));
    victim.pos.set(pp.x, 0.02, pp.z + 5); victim.state = 'idle'; victim.timer = 30; victim.route = [];
    w.player.facing = 0; w.cam.yaw = Math.PI; w.cam.pitch = 0.49;
    w.input.keys.add('KeyF'); run(0.36); w.input.keys.delete('KeyF');
    const states = [];
    for (let k = 0; k < 6; k++) { run(0.15); states.push(victim.state); }
    window.__victim = victim.id;
    return { victim: victim.id, personality: victim.npc.personality, states, phoneMode: victim.phoneMode, stars: w.police.stars };
  });
  await page.evaluate(() => { const w = window.__oc; const v = w.peds[window.__victim]; w.cam.override = { px: v.pos.x + 2.2, py: 2.2, pz: v.pos.z - 2.6, lx: v.pos.x, ly: 1.3, lz: v.pos.z }; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/19-calling-999.png' });
  const after = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    w.cam.override = null;
    const v = w.peds[window.__victim];
    const t0 = w.time;
    while (v.phoneMode === 'call' && w.time - t0 < 6) run(0.1);
    run(0.2);
    return { callSeconds: +(w.time - t0).toFixed(1), stars: w.police.stars, heat: w.police.heat, searchFor: +(w.police.searchUntil - w.time).toFixed(1), stats: { ...window.__ocWitness } };
  });
  // escape: run far away and hide
  const escape = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const c = w.city;
    w.player.body.setTranslation({ x: c.xs[c.xs.length - 2] - 30, y: 1.2, z: c.zs[0] + 3 }, true);
    const s = [];
    for (let k = 0; k < 15; k++) { run(3); s.push([Math.round(w.time), w.police.stars, w.police.cars.length, w.police.seen ? 'seen' : '-']); if (w.police.stars === 0) break; }
    return s;
  });
  // interrupting a caller: knock them over mid-call
  const interrupt = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const p = w.peds.find((q) => q.active && q.archetype === 'elderly');
    const before = { ...window.__ocWitness };
    // pretend they saw something and are calling
    p.state = 'idle';
    w.events.push({ type: 'vandalism', x: p.pos.x + 3, z: p.pos.z, what: 'a car' });
    run(0.1);
    const calling = p.phoneMode;
    p.state = 'down'; p.timer = 3; // knocked over before the call connects
    run(3.5);
    return { calling, interrupted: window.__ocWitness.callsInterrupted - before.callsInterrupted, completed: window.__ocWitness.callsCompleted - before.callsCompleted };
  });
  return { setup, after, escape, interrupt };
}

// Milestone 2 gate, with real key presses where possible.
export async function gate2(page, S) {
  await S.start(page);
  const step = (sec) => page.evaluate((s) => window.__ocRun(s), sec);
  // 1) pick up a bottle with E
  await page.evaluate(() => {
    const w = window.__oc;
    const bottle = w.itemsState.items.find((i) => i.type === 'bottle' && i.inWorld);
    w.player.body.setTranslation({ x: bottle.px, y: 1.2, z: bottle.pz - 1.0 }, true); w.player.facing = 0;
  });
  await step(0.3);
  await page.keyboard.press('KeyE'); await step(0.1);
  const picked = await page.evaluate(() => window.__oc.inventory.slots.map((s) => s?.type ?? null).filter(Boolean));
  // 2) an NPC stands in front; hold F to charge, release to throw
  const victim = await page.evaluate(() => {
    const w = window.__oc; const pp = w.player.mesh.position;
    const v = w.peds.find((p) => p.active && p.archetype === 'adult' && p.npc.personality === 'friendly') ?? w.peds.find((p) => p.active && p.archetype === 'adult');
    v.pos.set(pp.x, 0.02, pp.z + 5); v.state = 'idle'; v.timer = 30; v.route = [];
    w.player.facing = 0; w.cam.yaw = Math.PI; w.cam.pitch = 0.49;
    return { id: v.id, personality: v.npc.personality };
  });
  await page.keyboard.down('KeyF'); await step(0.36); await page.keyboard.up('KeyF'); await step(0.1);
  const res = await page.evaluate((id) => {
    const w = window.__oc, run = window.__ocRun; const v = w.peds[id];
    const seq = [];
    for (let k = 0; k < 40 && w.police.stars === 0; k++) { run(0.15); if (seq[seq.length - 1] !== v.state) seq.push(v.state); }
    return { seq, stars: w.police.stars, health: Math.round(v.health), calls: { ...window.__ocWitness } };
  }, victim.id);
  // 3) escape
  const escape = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const c = w.city;
    w.player.body.setTranslation({ x: c.xs[c.xs.length - 2] - 30, y: 1.2, z: c.zs[0] + 3 }, true);
    const t0 = w.time;
    while (w.police.stars > 0 && w.time - t0 < 60) run(1);
    return { seconds: Math.round(w.time - t0), stars: w.police.stars };
  });
  // 4) bat a car
  const dent = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const bat = w.itemsState.items.find((i) => i.type === 'bat' && i.inWorld);
    w.player.body.setTranslation({ x: bat.px, y: 1.2, z: bat.pz - 1.0 }, true); w.player.facing = 0;
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    w.inventory.selected = w.inventory.slots.findIndex((s) => s && s.type === 'bat');
    const v = w.vehicles.find((c) => !c.driven && c.type === 'sedan');
    const pp = w.player.mesh.position;
    v.body.setTranslation({ x: pp.x, y: 0.8, z: pp.z + 2.2 }, true); v.body.setRotation({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0); run(0.5);
    const d0 = v.dmg.dentTotal;
    w.player.facing = 0; w.cam.yaw = Math.PI;
    w.input.keys.add('KeyF'); run(0.1); w.input.keys.delete('KeyF'); run(0.8);
    return { dentBefore: +d0.toFixed(2), dentAfter: +v.dmg.dentTotal.toFixed(2) };
  });
  // 5) 60 people (High): CPU cost vs 30 people (Low), frames over 33 ms
  const perf = await page.evaluate(() => {
    const w = window.__oc;
    const measure = (q) => {
      document.getElementById(`q-${q}`).click();
      window.__ocRun(3);
      const f = window.__ocFrames(300, false).map((x) => x.cpu).sort((a, b) => a - b);
      return { active: w.peds.filter((p) => p.active).length, median: f[150], p99: f[297], max: f[299], over33: f.filter((x) => x > 33).length };
    };
    const low = measure('low');
    const high = measure('high');
    document.getElementById('q-medium').click();
    return { low, high };
  });
  return { picked, victim, res, escape, dent, perf };
}

// Milestone 3 hurt feedback: red dots and ground stains on every injury (car hit, brick, dog, the player);
// dogs can be hurt by thrown items, melee and cars (serious crime: the owner screams and calls 999); kids stay
// untouchable; and an idle frame pays nothing for the effect pool.
export async function hurtfx(page, S) {
  await S.start(page);
  // close-up screenshot of the frozen frame (paused so the 0.6 s dots don't vanish during the capture).
  // Two rendered frames: the crowd is culled with the previous frame's camera, so a camera cut needs one.
  const snap = async (file, view) => {
    await page.evaluate((v) => { const w = window.__oc; w.cam.override = v; window.__ocFrames(2, true); w.paused = true; }, view);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `screenshots/${file}` });
    await page.evaluate(() => { const w = window.__oc; w.paused = false; w.cam.override = null; });
  };
  await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, c = w.city;
    const H = {};
    H.run = run;
    H.fx = () => { const f = w.hurtFx; return { bursts: f.bursts, dots: f.live, stains: f.stainLive, stainsMade: f.stainsMade, dotsVisible: f.dots.visible, stainsVisible: f.stains.visible }; };
    H.calm = () => { const p = w.police; p.heat = 0; p.stars = 0; p.loseTimer = 0; p.trackUntil = 0; p.searchUntil = 0; w.player.health = 100; };
    const fxIdx = w.prof.names.indexOf('fx');
    // n unrendered frames: whole-frame CPU and the hurt-fx section alone
    H.measure = (n) => {
      const cpu = [], fx = [];
      for (let k = 0; k < n; k++) { const r = window.__ocFrames(1, false); cpu.push(r[0].cpu); fx.push(w.prof.cur[fxIdx]); }
      cpu.sort((a, b) => a - b);
      return { frames: n, median: cpu[n >> 1], p95: cpu[Math.floor(n * 0.95)], fxMeanMs: +(fx.reduce((a, b) => a + b, 0) / n).toFixed(4), fxMaxMs: +Math.max(...fx).toFixed(4) };
    };
    // a clear stretch of road between two junctions
    H.spot = (i, j) => ({ x: (c.xs[i] + c.xs[i + 1]) / 2, z: c.zs[j] });
    H.tp = (x, z, facing = 0) => { w.player.body.setTranslation({ x, y: 1.2, z }, true); w.player.facing = facing; w.cam.yaw = facing + Math.PI; w.cam.pitch = 0.49; run(0.2, 60); };
    H.hold = (ped, x, z) => { ped.pos.set(x, 0.02, z); ped.state = 'idle'; ped.timer = 40; ped.route = []; ped.tilt = 0; };
    // put a dog walker so that their dog stands exactly at (x, z), its leash spot for owner heading h and orbit o
    // (default: owner 1.7 m to the -x side; h = -PI/2, o = 0 puts the owner 1.9 m to the -z side)
    H.placeDog = (owner, x, z, h = 0, o = Math.PI / 2) => {
      H.hold(owner, x - Math.cos(h) * 1.1 - Math.sin(o) * 0.6, z + Math.sin(h) * 0.3 - Math.cos(o) * 0.6);
      owner.heading = h; owner.dog.orbit = o;
      owner.dog.pos.set(x, 0.02, z); owner.dog.vel.set(0, 0, 0); owner.dog.tumbleT = 0; owner.dog.hurtT = 0;
    };
    // a view from in front of someone (heading h), a little to their right
    H.front = (p, h, dist, side, y, ly) => ({ px: p.x + Math.sin(h) * dist + Math.cos(h) * side, py: y, pz: p.z + Math.cos(h) * dist - Math.sin(h) * side, lx: p.x, ly, lz: p.z });
    H.pickUp = (type) => {
      const it = w.itemsState.items.find((i) => i.type === type && i.inWorld && !i.thrown);
      w.player.body.setTranslation({ x: it.px, y: 1.2, z: it.pz - 1.0 }, true); w.player.facing = 0; w.cam.yaw = Math.PI;
      run(0.3); w.input.pressed.add('KeyE'); run(0.1);
      return w.inventory.slots.filter(Boolean).map((s) => s.type);
    };
    H.select = (type) => { w.inventory.selected = w.inventory.slots.findIndex((s) => s && s.type === type); run(0.05, 60); };
    H.drive = (v, x, z, heading, speed) => {
      const q = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
      v.body.setTranslation({ x, y: 1.0, z }, true); v.body.setRotation(q, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const vx = Math.sin(heading) * speed, vz = Math.cos(heading) * speed;
      v.body.setLinvel({ x: vx, y: 0, z: vz }, true); v.prevVel.set(vx, 0, vz);
    };
    window.__H = H;
  });

  // ---- 0) idle cost before anything has been hurt ----
  const idleBefore = await page.evaluate(() => { window.__ocRun(2); return { ...window.__H.measure(300), fx: window.__H.fx() }; });

  // ---- 1) car knocks a pedestrian down (plus: a car at a dog, a car at a kid, and a crash that hurts the driver) ----
  const car = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    const v = w.vehicles.find((c) => c.type === 'sedan');
    const t = v.body.translation();
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.4, y: 1.2, z: t.z - Math.sin(v.heading) * 2.4 }, true);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const inCar = !!w.player.vehicle;
    const s = H.spot(2, 1);
    const ped = w.peds.find((p) => p.active && p.archetype === 'adult' && !p.reserved);
    H.hold(ped, s.x, s.z);
    ped.state = 'talk'; // not looking: doesn't jump out of the way
    H.drive(v, s.x - 12, s.z, Math.PI / 2, 11);
    const fx0 = H.fx();
    let tt = 0;
    while (ped.state !== 'down' && tt < 2) { run(1 / 60, 60); tt += 1 / 60; }
    // the driver stamps on the brake (so the car doesn't roll over the person it threw)
    v.body.setLinvel({ x: 1, y: 0, z: 0 }, true); v.prevVel.set(1, 0, 0);
    run(0.15, 60);
    window.__carPed = ped.id;
    return { inCar, ped: ped.id, state: ped.state, hitAfter: +tt.toFixed(2), fxBefore: fx0, fxAfter: H.fx() };
  });
  await page.evaluate(() => { const w = window.__oc; const p = w.peds[window.__carPed]; window.__view = { px: p.pos.x + 3.2, py: 1.7, pz: p.pos.z - 4.2, lx: p.pos.x - 0.8, ly: 0.7, lz: p.pos.z }; });
  await snap('22-hurt-car.png', await page.evaluate(() => window.__view));
  const activeCost = await page.evaluate(() => window.__H.measure(20));

  const carMore = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    const v = w.player.vehicle;
    // a car at a dog: the dog is in the car's path (1 m off its centre line), its owner (turned to the car,
    // not jumping clear) 1.9 m off it, outside the car's path
    run(2); H.calm();
    const s = H.spot(3, 1);
    const owners = w.peds.filter((p) => p.dog && p.active);
    const owner = owners[1] ?? owners[0];
    H.placeDog(owner, s.x, s.z - 1.0, -Math.PI / 2, 0);
    owner.state = 'talk';
    const dog0 = owner.dog.timesHurt, b0 = w.hurtFx.bursts;
    H.drive(v, s.x - 9, s.z, Math.PI / 2, 11);
    run(1.2, 60);
    const dogByCar = { owner: owner.id, dogHurt: owner.dog.timesHurt - dog0, ownerState: owner.state, ownerUp: owner.state !== 'down', bursts: w.hurtFx.bursts - b0 };
    // a car at a kid: kids always leap clear and are never knocked down
    run(2); H.calm();
    const k = H.spot(4, 1);
    const kid = w.peds.find((p) => p.archetype === 'kid' && p.active);
    const follow = kid.followId;
    kid.followId = -1; H.hold(kid, k.x, k.z);
    const kb = w.hurtFx.bursts;
    H.drive(v, k.x - 12, k.z, Math.PI / 2, 11);
    let minState = kid.state;
    for (let i = 0; i < 70; i++) { run(1 / 60, 60); if (kid.state === 'down') minState = 'down'; }
    kid.followId = follow;
    const kidByCar = { kid: kid.id, state: minState, health: kid.health, burstsFromKid: w.hurtFx.bursts - kb };
    // a hard crash hurts the (belted) driver: the burst comes out of the window, no stains in a car
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0); run(0.5);
    const hp0 = w.player.health, f0 = H.fx();
    w.events.push({ type: 'crash', x: v.mesh.position.x, z: v.mesh.position.z, damage: 20, dv: 20 });
    run(1 / 60, 60);
    const crash = { hpBefore: hp0, hpAfter: Math.round(w.player.health), bursts: w.hurtFx.bursts - f0.bursts, dots: w.hurtFx.live, stainsMadeAfter2s: 0 };
    run(2);
    crash.stainsMadeAfter2s = w.hurtFx.stainsMade - f0.stainsMade;
    // out of the car
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); run(0.5); w.input.pressed.add('KeyE'); run(0.3);
    return { dogByCar, kidByCar, crash, onFoot: !w.player.vehicle };
  });

  // ---- 2) a brick at an adult ----
  const items = await page.evaluate(() => { const H = window.__H; H.calm(); H.pickUp('brick'); H.pickUp('brick'); H.pickUp('bottle'); return H.pickUp('bat'); });
  const brick = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    H.calm();
    const s = H.spot(5, 2);
    H.tp(s.x, s.z - 2.5, 0);
    H.select('brick');
    const pp = w.player.mesh.position;
    const victim = w.peds.find((p) => p.active && p.archetype === 'adult' && p.state !== 'down' && !p.reserved);
    H.hold(victim, pp.x, pp.z + 5);
    const f0 = H.fx(), hp0 = victim.health;
    w.input.keys.add('KeyF'); run(0.36, 60); w.input.keys.delete('KeyF');
    let tt = 0;
    while (victim.health === hp0 && tt < 1.5) { run(1 / 60, 60); tt += 1 / 60; }
    run(0.08, 60);
    window.__victim = victim.id;
    return { victim: victim.id, damage: Math.round(hp0 - victim.health), state: victim.state, fxBefore: f0, fxAfter: H.fx() };
  });
  await page.evaluate(() => { const w = window.__oc; const v = w.peds[window.__victim]; window.__view = { px: v.pos.x + 2.4, py: 1.9, pz: v.pos.z - 2.8, lx: v.pos.x, ly: 1.1, lz: v.pos.z }; });
  await snap('22-hurt-brick.png', await page.evaluate(() => window.__view));

  // ---- 3) a thrown brick hits a dog: yelp, owner screams then calls 999 (certain), heat >= the dog-attack value ----
  const dog = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    run(5); H.calm(); // let earlier 999 calls finish, then start from zero heat
    const s = H.spot(6, 3);
    H.tp(s.x, s.z - 3, 0);
    H.select('brick');
    const owner = w.peds.filter((p) => p.dog && p.active && p.state !== 'down')[0];
    // charge, read where the arc passes low (dog height), put the dog there, then release
    w.input.keys.add('KeyF'); run(0.36, 60);
    const a = w.combat.arcPts;
    let k = 1;
    while (k < 47 && a[k * 3 + 1] > 0.35) k++;
    H.placeDog(owner, a[k * 3], a[k * 3 + 2]);
    // five ordinary people standing around in the street, 6-13 m away
    const dx = owner.dog.pos.x, dz = owner.dog.pos.z;
    const by = w.peds.filter((p) => p.active && !p.reserved && !p.dog && p.followId < 0 && p.archetype !== 'kid' && p.state !== 'down' && !w.peds.some((q) => q.followId === p.id)).slice(0, 5);
    [[9, 2], [-10, -1], [13, -2], [-6, 3], [6, -4]].forEach(([ox, oz], i) => { if (by[i]) H.hold(by[i], dx + ox, s.z + oz); });
    window.__bystanders = by.map((p) => p.id);
    const witnessesNear = w.peds.filter((p) => p.active && p.id !== owner.id && Math.hypot(p.pos.x - owner.pos.x, p.pos.z - owner.pos.z) < 45).length;
    const st0 = { ...window.__ocWitness, completedByKind: { ...window.__ocWitness.completedByKind } };
    const f0 = H.fx(), hurt0 = owner.dog.timesHurt;
    w.input.keys.delete('KeyF');
    let tt = 0;
    while (owner.dog.timesHurt === hurt0 && tt < 1.5) { run(1 / 60, 60); tt += 1 / 60; }
    run(0.1, 60);
    window.__owner = owner.id;
    window.__st0 = st0;
    return {
      owner: owner.id, personality: owner.npc.personality, dogHurt: owner.dog.timesHurt - hurt0, tumbling: owner.dog.tumbleT > 0, limpFor: +owner.dog.hurtT.toFixed(1),
      ownerState: owner.state, ownerHealth: owner.health, fxBefore: f0, fxAfter: H.fx(), witnessesNear,
    };
  });
  await page.evaluate(() => { const w = window.__oc; const d = w.peds[window.__owner].dog; window.__view = { px: d.pos.x + 2.2, py: 1.5, pz: d.pos.z - 2.6, lx: d.pos.x - 0.6, ly: 0.5, lz: d.pos.z }; });
  await snap('22-hurt-dog.png', await page.evaluate(() => window.__view));
  const dogCall = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    const owner = w.peds[window.__owner];
    // the five bystanders' reactions right after (phone = calling or filming)
    const reactions = {};
    for (const id of window.__bystanders) { const p = w.peds[id]; const r = p.state === 'phone' ? p.phoneMode : p.state; reactions[r] = (reactions[r] || 0) + 1; }
    const t0 = w.time;
    while (owner.phoneMode !== 'call' && w.time - t0 < 4) run(1 / 30);
    const callStartsAfter = +(w.time - t0).toFixed(2);
    run(0.6);
    return { reactions, ownerOnPhone: owner.phoneMode === 'call', callStartsAfter, ownerState: owner.state };
  });
  await page.evaluate(() => { const w = window.__oc; const o = w.peds[window.__owner]; window.__view = window.__H.front(o.pos, o.heading, 3.0, 1.4, 1.7, 0.8); });
  await snap('22-hurt-dog-call.png', await page.evaluate(() => window.__view));
  const dogAfter = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    const owner = w.peds[window.__owner];
    const st0 = window.__st0;
    // run until every 999 call about it is through; note when the owner's own call completes
    const t0 = w.time;
    let ownerCallDoneAt = -1, heatAtFirstCall = -1;
    while (w.time - t0 < 7) {
      run(1 / 30);
      const done = (window.__ocWitness.completedByKind.dogAttack ?? 0) - (st0.completedByKind.dogAttack ?? 0);
      if (done > 0 && heatAtFirstCall < 0) heatAtFirstCall = Math.round(w.police.heat);
      if (window.__ocWitness.lastCaller === owner.id && ownerCallDoneAt < 0) ownerCallDoneAt = +(w.time - t0).toFixed(1);
    }
    const out = {
      ownerCallCompleted: ownerCallDoneAt >= 0, ownerCallDoneAt,
      dogAttackCalls: (window.__ocWitness.completedByKind.dogAttack ?? 0) - (st0.completedByKind.dogAttack ?? 0),
      heatAtFirstCall, heat: Math.round(w.police.heat), dogAttackHeat: 60, stars: w.police.stars,
      ownerRel: owner.npc.relationship, ownerMemory: owner.npc.memory.map((m) => m.note),
      witnessMemory: w.peds.filter((p) => p.npc.memory.some((m) => m.kind === 'sawDogHurt')).length,
    };
    // the dog limps back to its owner and recovers (dogs can't die)
    run(10);
    const d = owner.dog;
    out.dogRecovered = d.hurtT <= 0 && d.tumbleT <= 0 && Math.abs(d.roll) < 1e-6;
    out.dogNearOwner = +Math.hypot(d.pos.x - owner.pos.x, d.pos.z - owner.pos.z).toFixed(1);
    return out;
  });

  // ---- 3b) a bat swing at a dog (melee) ----
  const dogMelee = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    H.calm();
    const s = H.spot(1, 2);
    H.tp(s.x, s.z - 1.5, 0);
    H.select('bat');
    const owners = w.peds.filter((p) => p.dog && p.active && p.state !== 'down');
    const owner = owners[owners.length - 1];
    const pp = w.player.mesh.position;
    H.placeDog(owner, pp.x, pp.z + 2.0); // in reach of the bat; the owner (1.7 m to the side) just out of it
    const hurt0 = owner.dog.timesHurt, b0 = w.hurtFx.bursts, hp0 = owner.health;
    w.input.keys.add('KeyF'); run(0.1, 60); w.input.keys.delete('KeyF'); run(0.6, 60);
    return { owner: owner.id, dogHurt: owner.dog.timesHurt - hurt0, ownerUntouched: owner.health === hp0, bursts: w.hurtFx.bursts - b0, ownerState: owner.state };
  });

  // ---- kids: a thrown bottle and a bat swing don't touch them ----
  const kids = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    H.calm();
    const s = H.spot(2, 3);
    H.tp(s.x, s.z - 2.5, 0);
    const kid = w.peds.find((p) => p.archetype === 'kid' && p.active);
    const follow = kid.followId;
    kid.followId = -1;
    const pp = w.player.mesh.position;
    H.hold(kid, pp.x, pp.z + 5);
    H.select('bottle');
    const b0 = w.hurtFx.bursts;
    w.input.keys.add('KeyF'); run(0.36, 60); w.input.keys.delete('KeyF'); run(1.2, 60);
    const thrown = { health: kid.health, state: kid.state, hitCount: kid.hitCount };
    H.hold(kid, pp.x, pp.z + 1.2);
    H.select('bat');
    w.input.keys.add('KeyF'); run(0.1, 60); w.input.keys.delete('KeyF'); run(0.6, 60);
    const melee = { health: kid.health, state: kid.state, hitCount: kid.hitCount };
    kid.followId = follow;
    return { kid: kid.id, thrown, melee, bursts: w.hurtFx.bursts - b0 };
  });

  // ---- 4) the player is hit by a car on foot (real health path: a traffic car running into you) ----
  const player = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    run(1); H.calm();
    const s = H.spot(4, 2);
    H.tp(s.x, s.z + 3.1, Math.PI);
    const pp = w.player.mesh.position;
    const tc = w.traffic.reduce((a, c) => (Math.hypot(c.px - pp.x, c.pz - pp.z) < Math.hypot(a.px - pp.x, a.pz - pp.z) ? c : a));
    const h = tc.heading, fx = Math.sin(h), fz = Math.cos(h);
    // its front bumper just reaching you at 40 km/h
    tc.body.setTranslation({ x: pp.x - fx * (tc.halfL + 0.3), y: tc.body.translation().y, z: pp.z - fz * (tc.halfL + 0.3) }, true);
    tc.body.setLinvel({ x: fx * 11, y: 0, z: fz * 11 }, true);
    tc.speed = 11;
    const hp0 = w.player.health, f0 = H.fx();
    let tt = 0;
    while (w.player.health === hp0 && tt < 0.5) { run(1 / 60, 60); tt += 1 / 60; }
    tc.body.setLinvel({ x: 0, y: 0, z: 0 }, true); tc.speed = 0; // the driver brakes
    run(0.15, 60);
    window.__carHeading = h;
    return { hpBefore: hp0, hpAfter: Math.round(w.player.health), fxBefore: f0, fxAfter: H.fx() };
  });
  await page.evaluate(() => { const p = window.__oc.player.mesh.position; window.__view = window.__H.front(p, window.__carHeading + Math.PI / 2, 4.4, 1.2, 1.8, 0.8); });
  await snap('22-hurt-player.png', await page.evaluate(() => window.__view));

  // ---- stains on the ground after the dots are gone; then everything fades and the idle cost is back to zero ----
  const stains = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    H.calm();
    run(2);
    const f = w.hurtFx, m = f.stains.instanceMatrix.array;
    // look at the newest stain (the player's, on this street)
    let k = 0;
    for (let i = 0; i < f.stainLive; i++) if (f.stainAge[i] < f.stainAge[k]) k = i;
    const x = m[k * 16 + 12], z = m[k * 16 + 14];
    window.__view = { px: x + 1.6, py: 2.4, pz: z - 2.2, lx: x, ly: 0, lz: z };
    return { ...H.fx(), alphaNewest: +f.stainAlpha[k].toFixed(2) };
  });
  await snap('22-hurt-stains.png', await page.evaluate(() => window.__view));
  const after = await page.evaluate(() => {
    const w = window.__oc, H = window.__H, run = H.run;
    H.calm();
    run(30);
    const live = w.hurtFx.stainLive;
    const half = { ...H.fx(), alphaMax: +Math.max(0, ...Array.from(w.hurtFx.stainAlpha.slice(0, live))).toFixed(2) };
    run(32); H.calm();
    const gone = H.fx();
    return { at30s: half, at62s: gone, idleAfter: H.measure(300) };
  });
  return { idleBefore, car, activeCost, carMore, items, brick, dog, dogCall, dogAfter, dogMelee, kids, player, stains, after };
}
