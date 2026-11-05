// Scripted scenarios for scripts/shot.mjs. Each gets the Playwright page and helpers.
const hold = async (page, key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
const state = (page) => page.evaluate(() => {
  const w = window.__oc; const v = w.player.vehicle; const p = w.player.mesh.position;
  return { x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1), inCar: !!v, kmh: v ? Math.round(v.speed * 3.6) : 0, heading: v ? +v.heading.toFixed(2) : null, hp: v ? Math.round(v.health) : null, cash: w.cash, stars: w.police.stars };
});
export { hold, state };

/**
 * Map-agnostic spots for the scenarios (installed in the page as window.__mh by shot.mjs). Spots are given as
 * offsets from the map centre; on the grid city the offsets used below land exactly where the old scenarios
 * put things (between avenues, in a lane, on a pavement), and on any other map they snap to the nearest road.
 */
export function installMapHelpers() {
  const w = window.__oc, c = w.city;
  const hit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
  const kerb = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
  const free = (x, z) => !c.isBlocked(x, z) && !c.isWater(x, z);
  const H = {};
  /** The pavement behind the kerb nearest to centre + (dx, dz). */
  H.pavement = (dx, dz) => {
    c.kerbPoint(c.center.x + dx, c.center.z + dz, kerb);
    const h = kerb.heading, step = 3.6;
    return { x: kerb.x - Math.cos(h) * step, z: kerb.z + Math.sin(h) * step, heading: h };
  };
  /** centre + (dx, dz) itself if it is open ground, else the pavement nearest to it. */
  H.spot = (dx, dz) => {
    const x = c.center.x + dx, z = c.center.z + dz;
    return free(x, z) ? { x, z, heading: 0 } : H.pavement(dx, dz);
  };
  /** centre + (dx, dz) if it is on a road, else the nearest lane centre. */
  H.road = (dx, dz) => {
    const x = c.center.x + dx, z = c.center.z + dz;
    c.nearestLane(x, z, 5000, hit);
    return c.isRoad(x, z) ? { x, z, heading: hit.heading, edge: hit.edge } : { x: hit.x, z: hit.z, heading: hit.heading, edge: hit.edge };
  };
  /** Start of the longest straight run of lanes (widest road first): { x, z, heading, length }. */
  H.straight = () => {
    const { nodes, edges } = c.roads;
    const dir = (e) => Math.atan2(e.pts[e.pts.length - 3] - e.pts[0], e.pts[e.pts.length - 1] - e.pts[2]);
    const same = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.05;
    const straightNext = (e) => nodes[e.to].out.map((i) => edges[i]).find((n) => n.lane === e.lane && n.roadId === e.roadId && n.to !== e.from && same(dir(n), dir(e)));
    const straightPrev = (e) => nodes[e.from].in.map((i) => edges[i]).find((p) => p.lane === e.lane && p.roadId === e.roadId && p.from !== e.to && same(dir(p), dir(e)));
    let best = null;
    for (const e of edges) {
      if (e.lane !== 0 || straightPrev(e)) continue; // only chain starts
      let len = 0;
      for (let k = e, n = 0; k && n < 500; k = straightNext(k), n++) len += k.len;
      if (!best || len > best.len + 1 || (Math.abs(len - best.len) <= 1 && e.halfWidth > best.e.halfWidth)) best = { e, len };
    }
    const e = best.e;
    return { x: e.pts[0], z: e.pts[2], heading: dir(e), length: best.len };
  };
  /**
   * Tall, wide buildings (crash walls), in map order, with open road 8-16 m south of their middle (the crash run-up;
   * on the grid that is every such building).
   */
  H.walls = () => c.buildings.filter((b) => {
    if (!(b.h > 10 && b.maxX - b.minX > 12)) return false;
    const x = (b.minX + b.maxX) / 2;
    for (const d of [8, 12, 16]) if (!c.isRoad(x, b.maxZ + d) || c.isBlocked(x, b.maxZ + d)) return false;
    return true;
  });
  /** Ground height at (x, z) (0 everywhere on the grid; terrain, roads and pavements on a real map). */
  H.gy = (x, z) => c.heightAt(x, z);
  /** Put a body `lift` metres above the ground at (x, z). */
  H.put = (body, x, z, lift) => body.setTranslation({ x, y: c.heightAt(x, z) + lift, z }, true);
  // ---- named places: real names on Georgetown, sensible spots on any other map (offsets snapped to roads) ----
  const E = c.roads.edges, N = c.roads.nodes;
  const namesAt = (n) => new Set([...n.in, ...n.out].map((i) => E[i].name));
  const junction = (a, b) => N.find((n) => { const s = namesAt(n); return s.has(a) && s.has(b); }) ?? null;
  /** The traffic lane (not a parking lane) of street `name` nearest (x, z), as a road spot. */
  const laneOf = (name, x, z) => {
    let best = null;
    for (const e of E) {
      if (e.name !== name || e.parking) continue;
      const h = window.__ocMap.projectOnLane(e, x, z, { ...hit });
      if (!best || h.dist < best.dist) best = { ...h };
    }
    return best && { x: best.x, z: best.z, y: best.y, heading: best.heading, edge: best.edge };
  };
  const PLACES = {
    'M St at Wisconsin Ave': { at: ['M St NW', 'Wisconsin Ave NW'], grid: [0, 0] },
    'Key Bridge north end': { at: ['Francis Scott Key Bridge', 'M St NW'], street: 'M St NW', grid: [-240, 0] },
    '29th St between N and P': { between: ['29th St NW', 'N St NW', 'P St NW'], grid: [120, -80] },
    'Washington Circle': { ring: true, grid: [240, -160] },
    'waterfront': { walkKind: 'waterfront', near: [-120, 470], grid: [0, 400] },
  };
  /**
   * A named place as a road spot { x, z, y, heading, edge } (a traffic lane there; the waterfront: a promenade walk
   * node, edge -1). Unknown on this map: the grid offset from the centre snapped to the nearest lane.
   */
  H.place = (name) => {
    const P = PLACES[name];
    if (!P) throw new Error(`unknown place ${name}`);
    if (P.at) {
      const j = junction(P.at[0], P.at[1]);
      if (j) return laneOf(P.street ?? P.at[0], j.x, j.z);
    }
    if (P.between) {
      const a = junction(P.between[0], P.between[1]), b = junction(P.between[0], P.between[2]);
      if (a && b) return laneOf(P.between[0], (a.x + b.x) / 2, (a.z + b.z) / 2);
    }
    if (P.ring) {
      const ring = N.filter((n) => n.roundabout);
      if (ring.length) {
        const cx = ring.reduce((s, n) => s + n.x, 0) / ring.length, cz = ring.reduce((s, n) => s + n.z, 0) / ring.length;
        const e = E.find((q) => q.roundabout && q.lane === 0);
        const h = window.__ocMap.projectOnLane(e, cx, cz - 1000, { ...hit }); // the north side of the ring
        return { x: h.x, z: h.z, y: h.y, heading: h.heading, edge: h.edge, centre: { x: cx, z: cz } };
      }
    }
    if (P.walkKind) {
      let best = null;
      for (const n of c.walk.nodes) if (n.kind === P.walkKind && (!best || Math.hypot(n.x - P.near[0], n.z - P.near[1]) < Math.hypot(best.x - P.near[0], best.z - P.near[1]))) best = n;
      if (best) return { x: best.x, z: best.z, y: best.y, heading: 0, edge: -1 };
    }
    const r = H.road(P.grid[0], P.grid[1]);
    return { ...r, y: c.heightAt(r.x, r.z) };
  };
  window.__mh = H;
}

export async function world(page, S) {
  await S.start(page);
  await page.waitForTimeout(800);
  return state(page);
}

// Real key presses, but time runs in game seconds (window.__ocRun) rather than wall-clock waits, so the result is
// the same on a slow software-GL machine (a real map renders a frame every few seconds there) as on a fast one.
const holdSim = async (page, key, seconds) => {
  await page.keyboard.down(key);
  await page.evaluate((s) => window.__ocRun(s, 60), seconds);
  await page.keyboard.up(key);
};
const runSim = (page, seconds) => page.evaluate((s) => window.__ocRun(s, 60), seconds);

export async function walk(page, S) {
  await S.start(page);
  const a = await state(page);
  await holdSim(page, 'KeyW', 1.5);
  await page.keyboard.down('ShiftLeft'); await holdSim(page, 'KeyW', 1.0); await page.keyboard.up('ShiftLeft');
  await page.keyboard.press('Space');
  await runSim(page, 0.15);
  const air = await state(page);
  await runSim(page, 0.8);
  const b = await state(page);
  return { a, air, b, walkedM: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(1), climbedM: +(b.y - a.y).toFixed(2), jumpedM: +(air.y - b.y).toFixed(2) };
}

// teleport next to the nearest car, enter, and drive
export async function drive(page, S) {
  await S.start(page);
  await page.evaluate(() => {
    const w = window.__oc; const v = w.vehicles[0]; const t = v.body.translation();
    window.__mh.put(w.player.body, t.x + Math.cos(v.heading) * 2.2, t.z - Math.sin(v.heading) * 2.2, 1.2);
  });
  await runSim(page, 0.4);
  await page.keyboard.press('KeyE');
  await runSim(page, 0.5);
  const out = { start: await state(page) };
  await holdSim(page, 'KeyW', 3);
  out.accel3s = await state(page);
  await page.keyboard.down('KeyW'); await holdSim(page, 'KeyA', 1.2); await page.keyboard.up('KeyW');
  out.afterLeft = await state(page);
  await holdSim(page, 'KeyS', 1.5);
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
    v.owned = true; // (M3) only the rank sedan is yours at the start; this test is about handling, not theft
    // the longest straight road (the bay boulevard on the grid city), 15 m in, heading along it
    const st = window.__mh.straight(), fx = Math.sin(st.heading), fz = Math.cos(st.heading);
    const x0 = st.x + fx * 15, z = st.z + fz * 15;
    const q = { x: 0, y: Math.sin(st.heading / 2), z: 0, w: Math.cos(st.heading / 2) };
    const place = (kmh) => {
      v.body.setTranslation({ x: x0, y: w.city.heightAt(x0, z) + 1, z }, true); v.body.setRotation(q, true);
      v.body.setLinvel({ x: fx * kmh / 3.6, y: 0, z: fz * kmh / 3.6 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.health = v.maxHealth; v.wrecked = false; v.prevVel.set(fx * kmh / 3.6, 0, fz * kmh / 3.6); keys.clear(); step(5);
    };
    place(0);
    // stand at the driver's door (the car's left)
    w.player.body.setTranslation({ x: x0 + fz * 2.5, y: w.city.heightAt(x0, z) + 1, z: z - fx * 2.5 }, true);
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
      return { t: Math.round(w.time), ph, stopped, avg: +(sum / w.traffic.length).toFixed(1), stun, c0: [Math.round(tt.x), Math.round(tt.y * 10) / 10, Math.round(tt.z), t0.phase, +t0.speed.toFixed(1), t0.edge, t0.next] };
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
    window.__mh.put(w.player.body, t.x + Math.cos(v.heading) * 2.4, t.z - Math.sin(v.heading) * 2.4, 1.2);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const out = { inCar: !!w.player.vehicle, fares: [] };
    const tp = (x, z) => {
      window.__mh.put(v.body, x, z, 1.0); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
    v.owned = true; // (M3) a car of your own, so this tests the grudge from the hit, not a theft
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
    v.owned = true; // (M3) heat here should come from the hits only, not from taking the car
    const t = v.body.translation();
    window.__mh.put(w.player.body, t.x + Math.cos(v.heading) * 2.6, t.z - Math.sin(v.heading) * 2.6, 1.2);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    // run over two pedestrians
    const hits = [];
    for (const i of [20, 21]) {
      const p = w.peds[i]; p.state = 'idle'; p.timer = 30;
      // run-up from the west (the grid's pavements run east-west); else the first open direction
      const clear = (h) => { for (let k = 2; k <= 12; k += 2) if (w.city.isBlocked(p.pos.x - Math.sin(h) * k, p.pos.z - Math.cos(h) * k)) return false; return true; };
      const h = [Math.PI / 2, -Math.PI / 2, 0, Math.PI].find(clear) ?? Math.PI / 2;
      const ux = Math.sin(h), uz = Math.cos(h);
      window.__mh.put(v.body, p.pos.x - ux * 12, p.pos.z - uz * 12, 1.0);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setLinvel({ x: ux * 13, y: 0, z: uz * 13 }, true); v.prevVel.set(ux * 13, 0, uz * 13);
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
    const sp = window.__mh.road(-18, -45); // grid: a long road east of the centre junction
    v.body.setTranslation({ x: sp.x, y: w.city.heightAt(sp.x, sp.z) + 1, z: sp.z }, true); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0);
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
    const v2 = w.vehicles.find((x) => x.type === 'hatchback');
    v2.owned = true; // (M3) switching to a car of your own (stealing one is the theft scenario)
    w.input.pressed.add('KeyE'); run(0.1); // get out
    const far = window.__mh.road(306, -237); // grid: the north-east corner, behind buildings
    window.__mh.put(v2.body, far.x, far.z, 1); v2.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v2.prevVel.set(0, 0, 0);
    window.__mh.put(w.player.body, far.x + 2.2, far.z, 1.2);
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
    const sp = window.__mh.spot(-18, -39); // grid: the pavement of the long road east of the centre junction
    w.player.body.setTranslation({ x: sp.x, y: w.city.heightAt(sp.x, sp.z) + 1.2, z: sp.z }, true);
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
    const bs = w.city.buildings.filter((b) => b.h > 10).slice(0, 40);
    speeds.forEach((kmh, i) => {
      const b = bs[(i * 3) % bs.length];
      const cx = (b.minX + b.maxX) / 2, z = b.maxZ + 18; // south of the building, facing north (-z)
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
    window.__mh.put(w.player.body, t.x + Math.cos(v.heading) * 2.4, t.z - Math.sin(v.heading) * 2.4, 1.2);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    const R = (n) => window.__ocFrames(n, false);
    R(60);
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const all = [];
    const bs = window.__mh.walls();
    const launch = (x, z, h, kmh) => {
      window.__mh.put(v.body, x, z, 0.9);
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
      launch((b.minX + b.maxX) / 2, b.maxZ + 12, Math.PI, kmh);
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
    const b = bs[3]; launch((b.minX + b.maxX) / 2, b.maxZ + 12, Math.PI, 90);
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
    const b = window.__mh.walls().find((q) => [4, 8, 12, 16, 20].every((d) => free((q.minX + q.maxX) / 2 - 1, q.maxZ + d) && free((q.minX + q.maxX) / 2 + 1, q.maxZ + d)));
    const launch = (kmh, xoff) => {
      const h = Math.PI;
      v.body.setTranslation({ x: (b.minX + b.maxX) / 2 + xoff, y: 0.9, z: b.maxZ + 10 }, true);
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
    const walls = window.__mh.walls().filter((q) => [4, 8, 12, 16].every((d) => free((q.minX + q.maxX) / 2 - 1, q.maxZ + d) && free((q.minX + q.maxX) / 2 + 1, q.maxZ + d)));
    const v = w.vehicles.find((c) => c.type === 'pickup'); const t = v.body.translation();
    v.owned = true; // (M3) crash test, not a theft
    w.player.body.setTranslation({ x: t.x + Math.cos(v.heading) * 2.6, y: 1.2, z: t.z - Math.sin(v.heading) * 2.6 }, true);
    window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
    w.cash = 500;
    const frames = [];
    const log = [];
    const launch = (b, kmh) => {
      const h = Math.PI;
      v.body.setTranslation({ x: (b.minX + b.maxX) / 2, y: 1.0, z: b.maxZ + 9 }, true);
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
    const sp = window.__mh.spot(-124, 348); // grid: the bay promenade
    w.player.body.setTranslation({ x: sp.x, y: w.city.heightAt(sp.x, sp.z) + 1.2, z: sp.z }, true);
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
    window.__mh.put(w.player.body, bottle.px, bottle.pz - 1.0, 1.2); w.player.facing = 0;
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const pp = w.player.mesh.position;
    // (real maps: the bottle may lie on a quiet street where nobody suitable is out yet; let the crowd fill in)
    let victim = null;
    for (let k = 0; k < 40 && !victim; k++) {
      victim = w.peds.find((p) => p.active && p.archetype === 'adult' && (p.npc.personality === 'posh' || p.npc.personality === 'friendly')) ?? (k > 10 ? w.peds.find((p) => p.active && p.archetype === 'adult') : null);
      if (!victim) run(0.5);
    }
    victim.pos.set(pp.x, window.__mh.gy(pp.x, pp.z + 5) + 0.02, pp.z + 5); victim.state = 'idle'; victim.timer = 30; victim.route = [];
    w.player.facing = 0; w.cam.yaw = Math.PI; w.cam.pitch = 0.49;
    w.input.keys.add('KeyF'); run(0.36); w.input.keys.delete('KeyF');
    const states = [];
    for (let k = 0; k < 6; k++) { run(0.15); states.push(victim.state); }
    window.__victim = victim.id;
    return { victim: victim.id, personality: victim.npc.personality, states, phoneMode: victim.phoneMode, stars: w.police.stars };
  });
  await page.evaluate(() => { const w = window.__oc; const v = w.peds[window.__victim]; const g = v.pos.y; w.cam.override = { px: v.pos.x + 2.2, py: g + 2.2, pz: v.pos.z - 2.6, lx: v.pos.x, ly: g + 1.3, lz: v.pos.z }; });
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
    const sp = window.__mh.road(306, -237); // grid: the north-east corner, behind buildings
    w.player.body.setTranslation({ x: sp.x, y: w.city.heightAt(sp.x, sp.z) + 1.2, z: sp.z }, true);
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
    let v = null;
    for (let k = 0; k < 40 && !v; k++) {
      v = w.peds.find((p) => p.active && p.archetype === 'adult' && p.npc.personality === 'friendly') ?? w.peds.find((p) => p.active && p.archetype === 'adult');
      if (!v) window.__ocRun(0.5); // (real maps: a quiet street; let the crowd fill in)
    }
    v.pos.set(pp.x, window.__mh?.gy ? window.__mh.gy(pp.x, pp.z + 5) + 0.02 : 0.02, pp.z + 5); v.state = 'idle'; v.timer = 30; v.route = [];
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
    const w = window.__oc, run = window.__ocRun;
    const sp = window.__mh.road(306, -237); // grid: the north-east corner, behind buildings
    w.player.body.setTranslation({ x: sp.x, y: w.city.heightAt(sp.x, sp.z) + 1.2, z: sp.z }, true);
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
    const w = window.__oc, run = window.__ocRun;
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
    // a clear stretch of road between two junctions: (i, j) picks an offset from the map centre (on the grid city:
    // mid-block between avenues i and i + 1 on street j); other maps snap it to the nearest lane
    H.spot = (i, j) => window.__mh.road(96 * i - 384, 96 * j - 240);
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
    // look from the far side of the stain, away from the player
    const pp = w.player.mesh.position, dx = x - pp.x, dz = z - pp.z, d = Math.hypot(dx, dz) || 1;
    window.__view = { px: x + (dx / d) * 1.3 + 0.4, py: 1.7, pz: z + (dz / d) * 1.3, lx: x - (dx / d) * 0.7, ly: 0, lz: z - (dz / d) * 0.7 };
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

// ---------------------------------------------------------------------------------------------------
// M3: car ownership, theft and dealerships.

/** Freeze the world (no menu), draw it from a fixed camera, screenshot, then carry on where it was. */
async function frozenShot(page, path, cam) {
  await page.evaluate((c) => {
    const w = window.__oc;
    // py / ly are heights above the ground under the camera and the target (the grid is flat: unchanged)
    if (c) c = { ...c, py: c.py + w.city.heightAt(c.px, c.pz), ly: c.ly + w.city.heightAt(c.lx, c.lz) };
    w.cam.override = c; window.__ocFrames(3, true); window.__frozenAt = w.time; w.paused = true;
  }, cam);
  await page.waitForTimeout(400);
  await page.screenshot({ path });
  await page.evaluate(() => { const w = window.__oc; w.paused = false; w.time = window.__frozenAt; w.cam.override = null; });
}

// Theft: (A) take an unlocked car on an empty street -> no stars. (B) break into a locked car in front of
// people -> ~3 s window smash, alarm, people turn to look, 999 call, stars; the owner shouts and holds a grudge.
export async function theft(page, S) {
  await S.start(page);
  return theftRun(page, { quiet: null, busy: null, shots: true });
}

/**
 * The two thefts. A: an unlocked parked car (on a `quiet` street if given) with nobody within 120 m -> no calls, no
 * stars. B: a locked car (on a `busy` street if given) with four people on the pavement and its owner up the street.
 * Parked cars are records (w.parked.cars): standing next to one gives it a drivable stand-in (record.v).
 */
async function theftRun(page, opts) {
  await page.evaluate((opts) => {
    const w = window.__oc, run = window.__ocRun;
    const kerbside = (r) => r.cls !== 'lot' && !r.v && (!opts.quiet || r.street === opts.quiet || r.cls === opts.quiet);
    const rec = w.parked.cars.find((r) => kerbside(r) && !r.locked && typeof r.owner === 'number' && w.peds[r.owner].active)
      ?? w.parked.cars.find((r) => kerbside(r) && !r.locked) ?? w.parked.cars.find((r) => kerbside(r));
    rec.locked = false;
    // empty the street: everyone within 120 m (the owner too) is sent to a pavement far away
    const far = w.city.walk.nodes.filter((n) => Math.hypot(n.x - rec.x, n.z - rec.z) > 200);
    let moved = 0;
    for (const p of w.peds) {
      if (!p.active || Math.hypot(p.pos.x - rec.x, p.pos.z - rec.z) > 120) continue;
      const n = far[(p.id * 7) % far.length];
      p.pos.set(n.x, window.__mh.gy(n.x, n.z) + 0.02, n.z); p.state = 'idle'; p.timer = 40; p.route = []; moved++;
      if (p.dog) p.dog.pos.set(n.x + 1, window.__mh.gy(n.x + 1, n.z) + 0.02, n.z);
    }
    const ch = Math.cos(rec.heading), sh = Math.sin(rec.heading);
    window.__mh.put(w.player.body, rec.x - ch * 2.0, rec.z + sh * 2.0, 1.2);
    w.player.facing = Math.atan2(ch, -sh); w.cam.yaw = w.player.facing + Math.PI;
    run(0.4);
    window.__A = { car: rec.v.id, moved, street: rec.street, cls: rec.cls };
  }, opts);
  if (opts.shots) await frozenShot(page, 'screenshots/23-theft-unlocked.png', null); // the empty street and the steal prompt
  const A = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const v = w.vehicles[window.__A.car], moved = window.__A.moved;
    const prompt = w.player.prompt;
    const calls0 = window.__ocWitness.callsStarted, thefts0 = window.__ocTheft.thefts;
    w.input.pressed.add('KeyE'); run(0.1);
    const inCar = w.player.vehicle === v;
    run(8);
    const owner = typeof v.owner === 'number' ? w.peds[v.owner] : null;
    return {
      car: `${v.type} #${v.id}`, street: window.__A.street, cls: window.__A.cls, owner: owner ? owner.npc.name : v.ownerLocal ? 'a local' : 'nobody', pedsMoved: moved, prompt: prompt.replace(/<[^>]+>/g, ''), inCar, stolen: v.stolen,
      thefts: window.__ocTheft.thefts - thefts0, callsStarted: window.__ocWitness.callsStarted - calls0, stars: w.police.stars, heat: w.police.heat,
      ownerMemory: owner ? owner.npc.memory.map((m) => `${m.kind}: ${m.note}`) : [], ownerRel: owner ? owner.npc.relationship : null,
    };
  });
  await page.evaluate(() => { const w = window.__oc; const v = w.player.vehicle; if (v) { v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); window.__ocRun(0.3); w.input.pressed.add('KeyE'); window.__ocRun(0.2); } });

  // ---- B: a locked car, people on the pavement, the owner up the street ----
  const B0 = await page.evaluate((opts) => {
    const w = window.__oc, run = window.__ocRun;
    // (an owner who is out and about: not the taxi fare waiting at the rank)
    const free = (id) => w.peds[id].active && !w.peds[id].reserved && !w.peds[id].hidden;
    const kerbside = (r) => r.cls !== 'lot' && !r.v && (!opts.busy || r.street === opts.busy || r.cls === opts.busy);
    let rec = w.parked.cars.find((r) => kerbside(r) && r.locked && typeof r.owner === 'number' && free(r.owner));
    if (!rec) { // fall back: lock a car and give it an active owner
      rec = w.parked.cars.find((r) => kerbside(r));
      rec.locked = true;
      const o = w.peds.find((p) => free(p.id) && p.archetype === 'adult' && !w.parked.cars.some((r) => r.owner === p.id)) ?? w.peds.find((p) => !p.reserved && !p.hidden && p.archetype === 'adult' && !w.parked.cars.some((r) => r.owner === p.id));
      if (!o.active) { o.active = true; o.solid = true; o.body.setEnabled(true); }
      rec.owner = o.id;
      rec.ownerLocal = false;
    }
    const owner = w.peds[rec.owner];
    const ch = Math.cos(rec.heading), sh = Math.sin(rec.heading);
    const kx = -ch, kz = sh; // towards the kerb (the car's right side)
    const fx = Math.sin(rec.heading), fz = Math.cos(rec.heading);
    // four people on the pavement nearby (elderly and posh/friendly adults are the likeliest to call)
    const rank = (p) => (p.archetype === 'elderly' ? 0 : p.npc.personality === 'posh' || p.npc.personality === 'friendly' ? 1 : 2);
    // (people out and about first; at a quiet hour someone off-stage is brought out: the crowd follows the map's density)
    const wit = w.peds.filter((p) => p !== owner && p.followId < 0 && !p.reserved && !p.hidden && p.state !== 'down' && ['elderly', 'adult', 'parent', 'delivery'].includes(p.archetype))
      .sort((a, b) => (b.active - a.active) || rank(a) - rank(b)).slice(0, 4);
    for (const p of wit) if (!p.active) { p.active = true; p.solid = true; p.body.setEnabled(true); }
    [-11, -6, 7, 12].forEach((off, i) => {
      const p = wit[i];
      p.pos.set(rec.x + kx * 3.0 + fx * off, window.__mh.gy(rec.x + kx * 3.0 + fx * off, rec.z + kz * 3.0 + fz * off) + 0.02, rec.z + kz * 3.0 + fz * off);
      p.state = 'idle'; p.timer = 40; p.route = [];
    });
    owner.pos.set(rec.x + kx * 3.0 - fx * 23, window.__mh.gy(rec.x + kx * 3.0 - fx * 23, rec.z + kz * 3.0 - fz * 23) + 0.02, rec.z + kz * 3.0 - fz * 23);
    owner.state = 'idle'; owner.timer = 40; owner.route = [];
    window.__mh.put(w.player.body, rec.x + kx * 1.95, rec.z + kz * 1.95, 1.2);
    w.player.facing = Math.atan2(-kx, -kz);
    run(0.4);
    const v = rec.v;
    window.__B = { car: v.id, owner: owner.id, wit: wit.map((p) => p.id), calls0: window.__ocWitness.callsStarted, done0: window.__ocWitness.callsCompleted, stars0: w.police.stars };
    return { car: `${v.type} #${v.id}`, street: rec.street, cls: rec.cls, owner: `${owner.npc.name} (${owner.npc.personality})`, witnesses: wit.map((p) => `${p.archetype}/${p.npc.personality}`), prompt: w.player.prompt.replace(/<[^>]+>/g, ''), starsBefore: w.police.stars };
  }, opts);
  // press E and watch the smash play out
  const B1 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const v = w.vehicles[window.__B.car];
    w.input.pressed.add('KeyE');
    const t0 = w.time;
    const log = [];
    for (let k = 0; k < 8; k++) {
      run(0.2); // ends at 1.6 s, just after the second strike (arm in the glass)
      const b = w.player.breakIn;
      log.push(`${(w.time - t0).toFixed(2)}s strikes ${b ? b.strikes : '-'} arm ${w.player.rig.armR.rotation.x.toFixed(2)} crack ${v.dmg.sideCrack.visible ? v.dmg.sideCrack.scale.x.toFixed(2) : 0} alarm ${v.alarmUntil > w.time ? 'ON' : 'off'} looking ${window.__B.wit.filter((id) => w.peds[id].state === 'look').length}/4`);
    }
    window.__B.t0 = t0;
    return { log, breakingIn: !!w.player.breakIn, inCar: !!w.player.vehicle };
  });
  // mid-smash picture: camera on the pavement behind the player, looking at the cracked window
  const cam1 = await page.evaluate(() => {
    const w = window.__oc; const v = w.vehicles[window.__B.car];
    const ch = Math.cos(v.heading), sh = Math.sin(v.heading), kx = -ch, kz = sh, fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    return { px: v.px + kx * 3.4 - fx * 3.6, py: 2.0, pz: v.pz + kz * 3.4 - fz * 3.6, lx: v.px + kx * 0.9 + fx * 0.4, ly: 1.05, lz: v.pz + kz * 0.9 + fz * 0.4 };
  });
  if (opts.shots) await frozenShot(page, 'screenshots/23-theft-smash.png', cam1);
  const B2 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const v = w.vehicles[window.__B.car];
    let k = 0;
    while (!w.player.vehicle && k++ < 60) run(0.05);
    const smashSeconds = +(w.time - window.__B.t0).toFixed(2);
    const owner = w.peds[window.__B.owner];
    run(0.6);
    return {
      smashSeconds, inCar: w.player.vehicle === v, alarm: v.alarmUntil > w.time, alarmLevel: +(w.audio.alarmLevel ?? 0).toFixed(2), crack: v.dmg.sideCrack.visible,
      ownerState: owner.state, shout: window.__ocTheft.lastShout, ownerChases: window.__ocTheft.ownerChases,
      witnessStates: window.__B.wit.map((id) => w.peds[id].state), callsStarted: window.__ocWitness.callsStarted - window.__B.calls0,
    };
  });
  const cam2 = await page.evaluate(() => {
    const w = window.__oc; const v = w.vehicles[window.__B.car];
    const ch = Math.cos(v.heading), sh = Math.sin(v.heading), kx = -ch, kz = sh, fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    // down the pavement: the owner running up in front, the callers, then the car
    return { px: v.px + kx * 5.5 - fx * 27, py: 3.4, pz: v.pz + kz * 5.5 - fz * 27, lx: v.px + kx * 1.5 + fx * 2, ly: 1.0, lz: v.pz + kz * 1.5 + fz * 2 };
  });
  if (opts.shots) await frozenShot(page, 'screenshots/23-theft-alarm.png', cam2);
  const B3 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const v = w.vehicles[window.__B.car];
    const owner = w.peds[window.__B.owner];
    const ownerStates = [owner.state];
    // sit in the car: the owner stands at the door shouting until they give up, then (maybe) phones 999
    for (let k = 0; k < 40 && (w.police.stars === 0 || owner.state === 'chase' || owner.state === 'phone'); k++) { run(0.5); if (ownerStates[ownerStates.length - 1] !== owner.state) ownerStates.push(owner.state); }
    // the owner won't chat now
    const world = { hour: 12, clock: '12:00', isNight: false, weather: 'clear', playerInCar: false, playerCarLabel: null, wantedStars: 0, cash: 100, npcWorkplace: 'work', npcHome: 'home', nearestPlace: 'the pier', taxiRanks: [{ poiId: 0, name: 'Rank', street: 'Main St', hasFare: false }], gossip: [], places: [] };
    const hello = w.dialogue.replySync({ npc: owner.npc, playerText: 'hello! how are you?', world });
    return {
      stars: w.police.stars, heat: w.police.heat, callsStarted: window.__ocWitness.callsStarted - window.__B.calls0, callsCompleted: window.__ocWitness.callsCompleted - window.__B.done0,
      ownerStates, ownerRel: owner.npc.relationship, ownerMemory: owner.npc.memory.map((m) => `${m.kind}: ${m.note}`),
      ownerSays: hello.text, ownerAction: hello.action?.type ?? null, alarmStillOn: v.alarmUntil > w.time,
    };
  });
  return { A, B0, B1, B2, B3 };
}

// Dealership: walk up to a display car (price + stats in the prompt), can't buy it broke, buy it with cash,
// it's yours (no crime, no alarm), money deducted, and it shows on the minimap.
export async function dealership(page, S) {
  await S.start(page);
  const setup = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const job = w.jobs.get('dealership');
    const site = job.sites[0];
    const slot = site.slots.find((s) => s.car && s.type === 'hatchback') ?? site.slots.find((s) => s.car);
    const v = slot.car;
    const ch = Math.cos(v.heading), sh = Math.sin(v.heading), kx = -ch, kz = sh;
    window.__mh.put(w.player.body, v.px + kx * 2.0, v.pz + kz * 2.0, 1.2);
    w.player.facing = Math.atan2(-kx, -kz);
    w.cash = 300;
    run(0.4);
    const brokePrompt = w.player.prompt.replace(/<[^>]+>/g, ' ');
    w.input.pressed.add('KeyE'); run(0.2);
    const afterBroke = { cash: w.cash, forSale: !!v.forSale, owned: v.owned, inCar: !!w.player.vehicle };
    w.cash = 5000; w.hud.shownCash = 5000;
    run(0.2);
    window.__D = { car: v.id, cash0: w.cash, thefts0: window.__ocTheft.thefts, calls0: window.__ocWitness.callsStarted };
    w.hud.toastUntil = w.time; // clear the 'not enough cash' toast for the picture
    // from across the road: the showroom cars, the sign and you with the price prompt
    const sx = site.x + kx * 1.2, sz = site.z + kz * 1.2;
    window.__Dcam = { px: sx - kx * 17 - Math.sin(v.heading) * 3, py: 4.6, pz: sz - kz * 17 - Math.cos(v.heading) * 3, lx: sx - kx * 2, ly: 1.4, lz: sz - kz * 2 };
    return {
      sites: job.sites.map((s) => ({ name: s.name, poiKind: w.city.pois[s.poiId].kind, cars: s.slots.filter((q) => q.car).map((q) => `${q.type} $${q.car.forSale.price}`) })),
      car: `${v.type} #${v.id}`, price: v.forSale.price, brokePrompt, afterBroke, prompt: w.player.prompt.replace(/<[^>]+>/g, ' '),
    };
  });
  await frozenShot(page, 'screenshots/23-dealership.png', await page.evaluate(() => window.__Dcam));
  const buy = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun; const v = w.vehicles[window.__D.car];
    w.input.pressed.add('KeyE'); run(0.2);
    const bought = { cash: w.cash, paid: window.__D.cash0 - w.cash, owned: v.owned, forSale: !!v.forSale, locked: v.locked, prompt: w.player.prompt.replace(/<[^>]+>/g, ' ') };
    window.__ocFrames(3, true);
    const minimapOwnedParked = window.__ocMinimap.ownedCars;
    // get in and drive off: no theft, no alarm, no stars
    w.input.pressed.add('KeyE'); run(0.2);
    const inCar = w.player.vehicle === v;
    const x0 = v.px, z0 = v.pz;
    w.input.keys.add('KeyW'); run(1.5); const kmh = Math.round(Math.abs(v.speed) * 3.6); w.input.keys.delete('KeyW'); run(4);
    return {
      bought, minimapOwnedParked, minimapDealerships: window.__ocMinimap.dealerships, inCar, kmhAfter1_5s: kmh, drove: Math.round(Math.hypot(v.px - x0, v.pz - z0)),
      thefts: window.__ocTheft.thefts - window.__D.thefts0, alarm: v.alarmUntil > w.time, callsStarted: window.__ocWitness.callsStarted - window.__D.calls0, stars: w.police.stars,
      ownedCars: w.vehicles.filter((c) => c.owned).map((c) => `${c.type} #${c.id}`),
    };
  });
  // park, get out, walk off a little and look back: the bought car has its own marker on the minimap
  await page.evaluate(() => {
    const w = window.__oc; const v = w.player.vehicle;
    if (v) { v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); window.__ocRun(0.5); w.input.pressed.add('KeyE'); window.__ocRun(0.3); }
    const car = w.vehicles[window.__D.car], fx = Math.sin(car.heading), fz = Math.cos(car.heading), kx = -Math.cos(car.heading), kz = Math.sin(car.heading);
    window.__mh.put(w.player.body, car.px + kx * 2.2 - fx * 30, car.pz + kz * 2.2 - fz * 30, 1.2);
    w.player.facing = car.heading; w.cam.yaw = car.heading + Math.PI;
    window.__ocRun(0.5); window.__ocFrames(3, true);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'screenshots/23-dealership-bought.png' });
  buy.minimapAfterParking = await page.evaluate(() => window.__ocMinimap.ownedCars);
  return { setup, buy };
}

// Map integrity (any map: MAP=<id> node scripts/shot.mjs x mapcheck): validateCityMap on the loaded map; one traffic
// car followed through 30 consecutive junction choices (every move must be onto an outgoing lane of the node it
// reached, and it must stay on its lane); 20 random walks on the walk graph; kerb points for every place.
export async function mapcheck(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, M = window.__ocMap, c = w.city, E = c.roads.edges, N = c.roads.nodes;
    const t0 = performance.now();
    const report = M.validate();
    const validateMs = +(performance.now() - t0).toFixed(1);
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    // ---- 1) drive ----
    const hit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
    const car = w.traffic.find((t) => t.phase === 'lane') ?? w.traffic[0];
    car.keep = true; // followed round the whole map: never moved nearer the player
    let prev = car.edge, streak = 0, best = 0, jumps = 0, maxOff = 0, uTurns = 0, laneChanges = 0;
    const visited = new Set([prev]), path = [];
    const simStart = w.time;
    while (streak < 30 && w.time - simStart < 900) {
      window.__ocRun(0.1, 30);
      // (not on the tick a recycled car reappears elsewhere: that is a jump, counted below, not a lane-keeping error)
      const jumped = car.edge !== prev && !N[E[prev].to].out.includes(car.edge);
      if (car.phase === 'lane' && car.stunT <= 0 && !jumped) {
        // off its lane beyond the sideways offset of a lane change it is making (car.latOff)
        const h = M.projectOnLane(E[car.edge], car.px, car.pz, hit);
        const lat = (car.px - h.x) * -Math.cos(h.heading) + (car.pz - h.z) * Math.sin(h.heading);
        maxOff = Math.max(maxOff, Math.abs(lat - (car.latOff ?? 0)));
      }
      if (car.edge === prev) continue;
      const from = E[prev];
      if (from.left === car.edge || from.right === car.edge) { laneChanges++; visited.add(car.edge); prev = car.edge; continue; } // a lane change, not a choice
      const legal = N[from.to].out.includes(car.edge);
      if (legal) {
        streak++;
        if (car.edge === from.twin && !N[from.to].deadEnd) uTurns++;
        if (path.length < 30) path.push(`${E[car.edge].name ?? E[car.edge].roadId}#${car.edge}`);
      } else { jumps++; streak = 0; } // recycled (teleported) or skipped a lane
      best = Math.max(best, streak);
      visited.add(car.edge);
      prev = car.edge;
    }
    car.keep = false;
    const drive = { choices: best, jumps, laneChanges, uTurnsNotAtDeadEnds: uTurns, maxOffLaneM: +maxOff.toFixed(2), simSeconds: Math.round(w.time - simStart), lanesVisited: visited.size, route: path.slice(0, 12).join(' > ') };
    // ---- 2) walks ----
    const router = M.walkRouter(), W = c.walk.nodes;
    let ok = 0, fail = 0, badLink = 0, hops = 0, metres = 0;
    for (let k = 0; k < 20; k++) {
      const a = Math.floor(rand() * W.length), b = Math.floor(rand() * W.length);
      const n = router.path(a, b);
      if (n <= 0) { fail++; continue; }
      if (router.nodes[0] !== a || router.nodes[n - 1] !== b) badLink++;
      for (let i = 1; i < n; i++) {
        const p = W[router.nodes[i - 1]], q = W[router.nodes[i]];
        if (!p.nbrs.includes(q.id)) badLink++;
        metres += Math.hypot(q.x - p.x, q.z - p.z);
      }
      hops += n;
      ok++;
    }
    const walkInside = W.filter((n) => c.isBlocked(n.x, n.z)).length;
    const walks = { ok, fail, badLink, avgNodes: ok ? +(hops / ok).toFixed(1) : 0, avgMetres: ok ? Math.round(metres / ok) : 0, walkNodesInsideBlocked: walkInside };
    // ---- 3) places ----
    const kerb = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
    let farKerb = 0, noKerb = 0;
    for (const p of c.pois) {
      if (!c.kerbPoint(p.x, p.z, kerb)) { noKerb++; continue; }
      if (Math.hypot(kerb.x - p.curbX, kerb.z - p.curbZ) > 15) farKerb++;
    }
    const places = { pois: c.pois.length, noKerbPoint: noKerb, kerbPointFarFromCurb: farKerb, spawnBlocked: c.isBlocked(c.spawn.x, c.spawn.z) };
    const pass = report.ok && drive.choices >= 30 && drive.uTurnsNotAtDeadEnds === 0 && drive.maxOffLaneM < 3 && walks.fail === 0 && walks.badLink === 0 && noKerb === 0;
    return { map: c.id, pass, validateMs, report: { ok: report.ok, errors: report.errors, warnings: report.warnings.slice(0, 8), warningCount: report.warnings.length, stats: report.stats }, drive, walks, places };
  });
}

// Real-map play check and screenshots (MAP=georgetown node scripts/shot.mjs x geoplay): the spawn, driving along
// M St, Key Bridge, Washington Circle with traffic, the F3 overlay, the minimap; the pause menu's attribution and the
// quality switch. Places come from window.__mh.place, so on the grid it runs too (at the fallback spots).
export async function geoplay(page, S) {
  await S.start(page);
  const out = {};
  // ---- 1) the spawn (afternoon light) ----
  out.spawn = await page.evaluate(() => {
    const w = window.__oc;
    w.dayNight.hour = 15.2;
    w.cam.yaw = w.player.facing + Math.PI;
    window.__ocRun(0.6);
    const p = w.player.mesh.position;
    return { map: w.city.id, x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1), facing: +w.player.facing.toFixed(2), street: w.city.walk.nodes[w.city.nearestWalk(p.x, p.z, p.y)].street, prompt: w.player.prompt.replace(/<[^>]+>/g, '') };
  });
  await frozenShot(page, 'screenshots/27-geo-play-spawn.png', null);
  // helpers in the page: get into your own car; put it on a lane spot moving at `speed`
  await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, c = w.city;
    window.__drive = (spot, back, speed) => {
      let v = w.player.vehicle;
      if (!v) {
        v = w.vehicles.find((q) => q.owned) ?? w.vehicles[0];
        window.__mh.put(w.player.body, v.px - Math.cos(v.heading) * 2.2, v.pz + Math.sin(v.heading) * 2.2, 1.2);
        run(0.2); w.input.pressed.add('KeyE'); run(0.2);
      }
      const hit = { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 };
      // `back` metres behind the spot along its lane, on the same lane (its level)
      const bx = spot.x - Math.sin(spot.heading) * back, bz = spot.z - Math.cos(spot.heading) * back;
      c.nearestLane(bx, bz, 40, hit, spot.y);
      const h = hit.heading;
      v.body.setTranslation({ x: hit.x, y: hit.y + 0.9, z: hit.z }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.body.setLinvel({ x: Math.sin(h) * speed, y: 0, z: Math.cos(h) * speed }, true);
      v.prevVel.set(Math.sin(h) * speed, 0, Math.cos(h) * speed);
      w.cam.yaw = h + Math.PI;
      return { inCar: w.player.vehicle === v, edge: c.roads.edges[hit.edge].name, x: Math.round(hit.x), y: +hit.y.toFixed(1), z: Math.round(hit.z) };
    };
    window.__car = () => { const v = w.player.vehicle, p = v.body.translation(); return { kmh: Math.round(v.speed * 3.6), x: Math.round(p.x), y: +p.y.toFixed(1), z: Math.round(p.z), hp: Math.round(v.health), lane: c.nearestLane(p.x, p.z, 20, { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 }, p.y) }; };
    window.__nearTraffic = (r) => { const p = w.player.mesh.position; return w.traffic.filter((t) => Math.hypot(t.px - p.x, t.pz - p.z) < r).length; };
  });
  // ---- 2) driving east along M St from west of Wisconsin Ave ----
  out.mst = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const spot = window.__mh.place('M St at Wisconsin Ave');
    const put = window.__drive(spot, 90, 9);
    w.input.keys.add('KeyW'); run(1.8); w.input.keys.delete('KeyW'); run(0.3);
    return { put, after: window.__car(), trafficWithin150m: window.__nearTraffic(150), parkedWithin60m: w.vehicles.filter((v) => !v.driven && Math.hypot(v.px - w.player.mesh.position.x, v.pz - w.player.mesh.position.z) < 60).length };
  });
  await frozenShot(page, 'screenshots/27-geo-play-mst-drive.png', null);
  // ---- 3) Key Bridge: northbound on the deck, toward Georgetown ----
  out.keybridge = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, c = w.city;
    const lanes = c.roads.edges.filter((e) => e.bridge && /Key Bridge/.test(e.name ?? ''));
    // northbound = travelling toward -z
    const nb = lanes.filter((e) => e.pts[e.pts.length - 1] < e.pts[2]).sort((a, b) => b.lane - a.lane)[0];
    if (!nb) return { skipped: 'no Key Bridge on this map' };
    const lp = { x: 0, y: 0, z: 0, heading: 0 };
    window.__ocMap.laneSample(nb, nb.len * 0.55, lp);
    const put = window.__drive({ x: lp.x, z: lp.z, y: lp.y, heading: lp.heading }, 0, 12);
    w.input.keys.add('KeyW'); run(1.2); w.input.keys.delete('KeyW'); run(0.2);
    const car = window.__car();
    return { put, after: car, deck: car.y > c.heightAt(car.x, car.z) + 3, ground: +c.heightAt(car.x, car.z).toFixed(1), onLane: car.lane };
  });
  await frozenShot(page, 'screenshots/27-geo-play-keybridge.png', null);
  // ---- 4) Washington Circle: a few cars on the ring, you waiting on 23rd St at the yield line ----
  out.circle = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, c = w.city, E = c.roads.edges, N = c.roads.nodes;
    const ring = E.filter((e) => e.roundabout);
    if (!ring.length) return { skipped: 'no roundabout on this map' };
    const lp = { x: 0, y: 0, z: 0, heading: 0 };
    // six traffic cars onto the ring
    w.traffic.slice(0, 6).forEach((car, k) => {
      const e = ring[(k * 5) % ring.length];
      if (window.__ocTraffic) { window.__ocTraffic.placeOnEdge(car, e.id, 2); car.speed = 4; return; }
      car.edge = e.id; car.next = -1; car.phase = 'lane'; car.s = Math.min(e.len - e.trimEnd - 1, e.trimStart + 2);
      window.__ocMap.laneSample(e, car.s, lp);
      car.heading = lp.heading; car.lastSetHeading = NaN; car.speed = 4; car.stunT = 0; car.stuckT = 0;
      car.body.setTranslation({ x: lp.x, y: lp.y + 0.62, z: lp.z }, true);
      car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      car.px = lp.x; car.pz = lp.z;
    });
    // you: on 23rd St north of the circle, heading south toward it
    const cen = window.__mh.place('Washington Circle').centre;
    const spoke = E.filter((e) => !e.roundabout && !e.parking && N[e.to].roundabout && e.name === '23rd St NW').sort((a, b) => N[a.to].z - N[b.to].z)[0];
    if (spoke) {
      window.__ocMap.laneSample(spoke, Math.max(0, spoke.len - spoke.trimEnd - 14), lp);
      window.__drive({ x: lp.x, z: lp.z, y: lp.y, heading: lp.heading }, 0, 0);
    }
    run(2.5);
    const onRing = w.traffic.filter((t) => E[t.edge].roundabout).length;
    return { centre: cen, ringCars: onRing, spoke: spoke?.name ?? null, flowing: w.traffic.slice(0, 6).map((t) => Math.round(t.speed * 3.6)) };
  });
  {
    const cam = await page.evaluate(() => { const cen = window.__mh.place('Washington Circle').centre; return cen ? { px: cen.x - 6, py: 38, pz: cen.z + 84, lx: cen.x, ly: 0, lz: cen.z } : null; });
    await frozenShot(page, 'screenshots/27-geo-play-circle.png', cam);
  }
  // ---- 5) F3 overlay while driving on M St ----
  out.f3 = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    const spot = window.__mh.place('M St at Wisconsin Ave');
    window.__drive(spot, 150, 10);
    w.input.keys.add('KeyW'); run(1.0); w.input.keys.delete('KeyW');
    w.input.pressed.add('F3'); window.__ocFrames(1, true);
    window.__ocFrames(14, true);
    const el = document.getElementById('debug');
    return { visible: w.debugVisible && el.style.display !== 'none', text: el.textContent.split('\n').slice(0, 13) };
  });
  await frozenShot(page, 'screenshots/27-geo-play-f3.png', null);
  // ---- 6) minimap (shown 2x so the street names can be read), on foot at the waterfront ----
  out.minimap = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    w.input.pressed.add('F3'); window.__ocFrames(1, true); // overlay off again
    const v = w.player.vehicle;
    if (v) { v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); run(0.4); w.input.pressed.add('KeyE'); run(0.3); }
    const p = window.__mh.place('M St at Wisconsin Ave');
    const k = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
    w.city.kerbPoint(p.x + 30, p.z + 20, k, p.y);
    window.__mh.put(w.player.body, k.x - Math.cos(k.heading) * 3.4, k.z + Math.sin(k.heading) * 3.4, 1.2);
    w.player.facing = k.heading; w.cam.yaw = k.heading + Math.PI;
    run(0.5);
    const mm = document.getElementById('minimap');
    mm.style.transformOrigin = 'left bottom';
    mm.style.transform = 'scale(2)';
    return { ...window.__ocMinimap, streetLabels: w.city.streets.length };
  });
  await frozenShot(page, 'screenshots/27-geo-play-minimap.png', null);
  // ---- 7) a police chase on M St: 2 stars while you sit in your car, then lose them on the far side of town ----
  out.chase = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, c = w.city;
    const P = w.police;
    const spot = window.__mh.place('M St at Wisconsin Ave');
    window.__drive(spot, 60, 0);
    run(0.5);
    const v = w.player.vehicle;
    P.heat = 2 * 40 - 1; // two stars (police.heatPerStar = 40)
    P.trackUntil = w.time + 4; P.lastSeenX = v.px; P.lastSeenZ = v.pz; P.lastSeenY = v.py;
    const samples = [];
    let firstSeen = null;
    for (let k = 0; k < 30; k++) {
      run(1);
      const near = P.cars.length ? Math.min(...P.cars.map((pc) => Math.hypot(pc.px - v.px, pc.pz - v.pz))) : null;
      if (P.seen && firstSeen === null) firstSeen = Math.round(w.time);
      if (k % 3 === 0) samples.push({ t: Math.round(w.time), stars: P.stars, cars: P.cars.length, seen: P.seen, nearest: near && Math.round(near), onRoad: P.cars.every((pc) => c.nearestLane(pc.px, pc.pz, 8, { edge: -1, s: 0, x: 0, y: 0, z: 0, heading: 0, dist: 0 }, pc.py)) });
      if (P.seen && near !== null && near < 25) break;
    }
    // get away: far side of town behind buildings, a new car of your own
    const far = window.__mh.place('29th St between N and P');
    window.__drive(far, 0, 0);
    const lose = [];
    for (let k = 0; k < 25 && P.stars > 0; k++) { run(2); lose.push([Math.round(w.time), P.stars, P.cars.length, P.seen ? 'seen' : '-']); }
    return { firstSeenAt: firstSeen, samples, lose, starsAtEnd: P.stars };
  });
  // ---- 8) pause menu: attribution and the quality switch ----
  out.pause = await page.evaluate(() => {
    const w = window.__oc;
    document.getElementById('minimap').style.transform = '';
    w.input.pressed.add('Escape'); window.__ocFrames(1, true);
    const attrib = document.querySelector('#pause .attrib')?.textContent ?? null;
    const geo = w.city.geo;
    const q = [];
    for (const k of ['low', 'high', 'medium']) {
      document.getElementById(`q-${k}`).click();
      q.push({ clicked: k, settings: w.settings.quality, map: geo ? geo.quality : 'n/a', peds: w.settings.pedBudget });
    }
    const paused = w.paused;
    w.input.pressed.add('Escape'); window.__ocFrames(1, true);
    return { paused, attrib, attribMatchesData: geo ? attrib === w.city.attribution : null, quality: q, resumed: !w.paused };
  });
  return out;
}

/**
 * Physics audit (run with QUERY=physaudit=1): drawn geometry vs Rapier colliders per solid kind (side probes),
 * drawn floors vs physics floors (surface samples) and every stair. Prints the mismatches with coordinates.
 * AUDIT_OUT=<file> writes the whole report as JSON. Passes when no solid kind has a probe or surface mismatch.
 */
export async function physaudit(page) {
  await page.waitForFunction(() => !!window.__ocPhysAudit, null, { timeout: 60000 }).catch(() => { throw new Error('physaudit needs QUERY=physaudit=1'); });
  const rep = await page.evaluate(() => window.__ocPhysAudit({ randomSamples: Number(new URLSearchParams(location.search).get('samples') ?? 3000) }));
  if (process.env.AUDIT_OUT) (await import('node:fs')).writeFileSync(process.env.AUDIT_OUT, JSON.stringify(rep, null, 1));
  const lines = [];
  for (const [k, s] of Object.entries(rep.probes)) {
    const bad = s.missing + s.short + s.long;
    lines.push(`probe ${k.padEnd(11)} ${String(s.probes).padStart(6)} probes  ok ${s.ok}  missing ${s.missing}  short ${s.short}  long ${s.long}  occluded ${s.occluded}  unreachable ${s.unreachable}${bad ? `  worst long ${s.worstLong.toFixed(2)} short ${s.worstShort.toFixed(2)}` : ''}`);
    for (const e of s.examples.slice(0, bad ? 4 : 0)) lines.push(`    ${e}`);
  }
  for (const [k, s] of Object.entries(rep.surfaces)) {
    lines.push(`floor ${k.padEnd(16)} ${String(s.samples).padStart(6)} samples  ok ${s.ok}  unsolid ${s.unsolid}  undrawn ${s.undrawn}${s.unsolid + s.undrawn ? `  worst ${s.worst.toFixed(2)}` : ''}`);
    for (const e of s.examples.slice(0, s.unsolid + s.undrawn ? 4 : 0)) lines.push(`    ${e}`);
  }
  for (const st of rep.stairs) lines.push(`stair ${st.name.padEnd(16)} L ${st.length} rise ${st.rise}  phys-visual ${st.physMinusVisual.join('..')}  max step ${st.maxPhysStep}`);
  console.log(lines.join('\n'));
  return { map: rep.map, colliders: rep.colliders, records: rep.records, totals: rep.totals, ms: rep.ms, pass: rep.totals.probeMismatches === 0 && rep.totals.surfaceMismatches === 0 };
}

/**
 * Page helpers for the walking tests: the player is put at a start spot (the only teleport), then moved ONLY by held
 * keys (W, A/D to turn, Space to jump) through the real game loop (window.__ocStep, 60 Hz). Each frame records the
 * feet height against the static collider surface right under the player (a ray that ignores the player).
 */
function installWalkHelpers() {
  const w = window.__oc, c = w.city, P = w.player, R = w.R;
  const hh = P.collider.halfHeight(), rad = P.collider.radius();
  const STATIC = (0xffff << 16) | 1; // query: every membership, filter = static colliders only
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const H = {};
  H.kindName = (id) => ['untagged', 'ground', 'kerb', 'deck', 'parapet', 'stair', 'stairWall', 'stoop', 'stoopRail', 'building', 'tower', 'column', 'bridgePier', 'monument', 'railing', 'wall', 'canopy', 'pier', 'boat', 'lockGate', 'fountain', 'tree', 'lamp', 'signalPole', 'signPost', 'bench', 'busShelter', 'gravestone', 'container', 'kiosk', 'boundary'][id] ?? `#${id}`;
  /** Static floor under (x, z) from y down: { y, kind } or null. */
  H.floor = (x, y, z, max = 60) => {
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z; ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const h = w.physics.castRay(ray, max, true, undefined, STATIC);
    return h ? { y: y - h.timeOfImpact, kind: H.kindName(c.solidTags.get(h.collider.handle)), toi: h.timeOfImpact } : null;
  };
  /** Horizontal ray (static only): distance to the first hit and its kind, or null. */
  H.cast = (x, y, z, dx, dz, max) => {
    const l = Math.hypot(dx, dz) || 1;
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z; ray.dir.x = dx / l; ray.dir.y = 0; ray.dir.z = dz / l;
    const h = w.physics.castRay(ray, max, true, undefined, STATIC);
    return h ? { d: h.timeOfImpact, kind: H.kindName(c.solidTags.get(h.collider.handle)) } : null;
  };
  H.feet = () => P.body.translation().y - hh - rad;
  H.pos = () => P.body.translation();
  /** Put the player standing at (x, z) on the floor under `from` (a physics ray), facing `facing`. */
  H.put = (x, z, facing, from) => {
    const f = H.floor(x, from, z, 80);
    const y = (f ? f.y : c.heightAt(x, z)) + hh + rad + 0.03;
    P.body.setTranslation({ x, y, z }, true);
    P.body.setNextKinematicTranslation({ x, y, z });
    P.vy = 0; P.facing = facing; P.knockT = 0;
    w.input.keys.clear();
    window.__ocStep(20); // settle (feet on the ground)
    return H.feet();
  };
  /** Hold keys for `sec` seconds; returns per-run stats (max penetration below the static floor, path). */
  H.hold = (keys, sec, onFrame) => {
    for (const k of keys) w.input.keys.add(k);
    let pen = -Infinity, airborneMax = 0, frames = Math.round(sec * 60), air = 0;
    const p0 = H.pos();
    for (let i = 0; i < frames; i++) {
      window.__ocStep(1);
      const t = H.pos(), fy = t.y - hh - rad;
      const f = H.floor(t.x, fy + 0.6, t.z);
      if (f) pen = Math.max(pen, f.y - fy); // > 0: feet below the static surface under the player
      if (!P.grounded) air++; else { airborneMax = Math.max(airborneMax, air); air = 0; }
      if (onFrame && onFrame(i / 60, t, fy) === false) { frames = i + 1; break; }
    }
    for (const k of keys) w.input.keys.delete(k);
    const p1 = H.pos();
    return { pen: +pen.toFixed(3), moved: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2), seconds: +(frames / 60).toFixed(2), airborneFramesMax: Math.max(airborneMax, air) };
  };
  H.press = (key) => { w.input.pressed.add(key); };
  /** Turn on the spot by holding A or D (tank controls) until facing `to` (radians). */
  H.turnTo = (to) => {
    const d = Math.atan2(Math.sin(to - P.facing), Math.cos(to - P.facing));
    const key = d > 0 ? 'KeyA' : 'KeyD';
    const frames = Math.round(Math.abs(d) / 3.0 * 60); // TUNING.player.turnSpeed = 3 rad/s
    w.input.keys.add(key);
    window.__ocStep(frames);
    w.input.keys.delete(key);
    P.facing = to; // remove the last fraction of a frame of turn
  };
  window.__wk = H;
}

/**
 * Stairs and props on foot (Georgetown, or any map for the props part): walks up and down one instance of every
 * stair type (the big landmark stair, canal steps, a footbridge, house stoops of several heights, the statue plinth
 * by jumping, kerbs, a car park kerb, Key Bridge and the freeway deck) and into one instance of every solid prop
 * kind, with held keys only. Asserts: feet never below the static surface (> 5 cm), the height gained matches the
 * stair (10 cm), climbs finish in reasonable time, and props stop the player at their collider.
 */
export async function stairs(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installWalkHelpers);
  const out = await page.evaluate(() => {
    const w = window.__oc, c = w.city, P = w.player, H = window.__wk, geo = c.geo;
    const res = { stairs: [], stoops: [], special: [], props: [], fails: [] };
    const fail = (what) => res.fails.push(what);
    const PEN = 0.05; // m: feet may not go deeper than this below the static surface
    const along = (pts, s) => {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (s <= acc + L || i === pts.length - 1) {
          const t = (s - acc) / L;
          const ux = (pts[i][0] - pts[i - 1][0]) / L, uz = (pts[i][1] - pts[i - 1][1]) / L;
          return { x: pts[i - 1][0] + ux * (s - acc), z: pts[i - 1][1] + uz * (s - acc), ux, uz, t };
        }
        acc += L;
      }
    };
    const face = (ux, uz) => Math.atan2(ux, uz);
    // arc length of the point of a stair line nearest (x, z)
    const project = (pts, x, z) => {
      let acc = 0, best = 0, bd = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0], az = pts[i - 1][1], dx = pts[i][0] - ax, dz = pts[i][1] - az, L = Math.hypot(dx, dz) || 1e-6;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (L * L)));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < bd) { bd = d; best = acc + t * L; }
        acc += L;
      }
      return best;
    };
    // steering along a bent stair (real data): face the point 1.5 m on along the line, as a player turning with A / D
    const steer = (st, dir, p) => {
      const s = project(st.pts, p.x, p.z), q = along(st.pts, s + dir * 1.5);
      P.facing = face(q.x - p.x, q.z - p.z);
    };
    // ------------------------------------------------------------------ stairs (up, then down)
    if (geo) {
      const pick = geo.stairs.map((_s, i) => i); // every stair: the landmark stair, the canal steps, path stairs
      for (const si of pick) {
        const st = geo.stairs[si];
        if (!st) continue;
        const up = st.h(st.L) > st.h(0);
        const sLow = up ? 0 : st.L, dir = up ? 1 : -1;
        const lane = st.name ? st.w / 4 : 0; // the big stair has a hand rail down the middle
        const a = along(st.pts, sLow - dir * 1.2);
        const ox = -a.uz * lane, oz = a.ux * lane;
        const hLow = st.h(sLow), hTop = st.h(up ? st.L : 0);
        const feet0 = H.put(a.x + ox, a.z + oz, face(a.ux * dir, a.uz * dir), hLow + 2);
        let reached = -1, rx = 0, rz = 0;
        const upRun = H.hold(['KeyW'], (st.L + 3) / 4.2 * 2 + 2, (t, p, fy) => {
          if (reached < 0) steer(st, dir, p);
          if (reached < 0 && fy > hTop - 0.12) { reached = t; rx = p.x; rz = p.z; }
          // stop a little past the top (1.2 m on from where the top was reached: a bent stair's end isn't straight ahead)
          if (reached >= 0 && Math.hypot(p.x - rx, p.z - rz) > 1.2) return false;
        });
        const feetTop = H.feet();
        H.turnTo(P.facing + Math.PI);
        let back = -1;
        const downRun = H.hold(['KeyW'], (st.L + 3) / 4.2 * 2 + 2, (t, p, fy) => { if (back < 0) steer(st, -dir, p); if (back < 0 && fy < hLow + 0.12) back = t; if (back >= 0 && t > back + 0.4) return false; });
        const feetEnd = H.feet();
        const r = { stair: st.name ?? `steps #${si}`, L: +st.L.toFixed(1), rise: +(hTop - hLow).toFixed(2), feet0: +feet0.toFixed(2), feetTop: +feetTop.toFixed(2), climbSec: +reached.toFixed(2), descendSec: +back.toFixed(2), feetEnd: +feetEnd.toFixed(2), penUp: upRun.pen, penDown: downRun.pen };
        res.stairs.push(r);
        if (reached < 0) fail(`${r.stair}: never reached the top (feet ${r.feetTop} vs ${hTop.toFixed(2)})`);
        else if (reached > (st.L + 2.4) / 4.2 * 1.6 + 1) fail(`${r.stair}: slow climb ${r.climbSec} s`);
        if (back < 0) fail(`${r.stair}: never got back down (feet ${r.feetEnd} vs ${hLow.toFixed(2)})`);
        if (Math.max(upRun.pen, downRun.pen) > PEN) fail(`${r.stair}: feet ${Math.max(upRun.pen, downRun.pen)} m below the surface`);
      }
      // standing still on a flight: no creeping, no jitter
      {
        const st = geo.stairs[0];
        const f0 = st.flights[0];
        const a = along(st.pts, (f0[0] + f0[1]) / 2);
        H.put(a.x - a.uz * st.w / 4, a.z + a.ux * st.w / 4, face(a.ux, a.uz), st.h((f0[0] + f0[1]) / 2) + 1.5);
        const p0 = H.pos(), y0 = H.feet();
        let ymin = Infinity, ymax = -Infinity;
        H.hold([], 3, (t, p, fy) => { ymin = Math.min(ymin, fy); ymax = Math.max(ymax, fy); });
        const p1 = H.pos();
        const creep = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        res.special.push({ test: 'stand still 3 s mid-flight', creep: +creep.toFixed(3), jitter: +(ymax - ymin).toFixed(3) });
        if (creep > 0.05 || ymax - ymin > 0.03) fail(`standing on the stair: creep ${creep.toFixed(3)} m, jitter ${(ymax - ymin).toFixed(3)} m`);
        void y0;
      }
      // ------------------------------------------------------------------ footbridge over the canal (arched deck)
      {
        // the longest one (real data also has footbridge stubs a few decimetres long)
        const fbLen = (f) => Math.hypot(f.pts[f.pts.length - 1][0] - f.pts[0][0], f.pts[f.pts.length - 1][1] - f.pts[0][1]);
        const fb = geo.footbridges.reduce((b, f) => (!b || fbLen(f) > fbLen(b) ? f : b), null);
        if (fb) {
          const a = fb.pts[0], b = fb.pts[fb.pts.length - 1];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
          H.put(a[0] - ux * 0.6, a[1] - uz * 0.6, face(ux, uz), fb.h[0] + 0.8); // on the bank the bridge lands on
          const top = Math.max(...fb.h);
          let peak = -Infinity;
          const run = H.hold(['KeyW'], (L + 3) / 4.2 + 1.5, (t, p, fy) => { peak = Math.max(peak, fy); });
          const e = H.pos();
          const crossed = (e.x - a[0]) * ux + (e.z - a[1]) * uz > L;
          res.special.push({ test: 'footbridge', L: +L.toFixed(1), deckTop: +top.toFixed(2), feetPeak: +peak.toFixed(2), crossed, pen: run.pen });
          if (!crossed) fail('footbridge: did not get across');
          if (Math.abs(peak - top) > 0.15) fail(`footbridge: peak ${peak.toFixed(2)} vs deck ${top.toFixed(2)}`);
          if (run.pen > PEN) fail(`footbridge: feet ${run.pen} below the deck`);
        }
      }
      // ------------------------------------------------------------------ stoops of several heights (up to the door, down)
      const S = geo.audit?.stoopInfo;
      if (S) {
        const want = [2, 3, 5, 7, 10];
        for (const steps of want) {
          let best = -1, bd = Infinity;
          for (let i = 0; i < S.length; i += 8) {
            if (S[i + 7] !== steps) continue;
            const d = Math.hypot(S[i] - c.spawn.x, S[i + 1] - c.spawn.z);
            // open pavement in front of the foot
            const fx = S[i] + S[i + 3] * (S[i + 5] + 1.5), fz = S[i + 1] + S[i + 4] * (S[i + 5] + 1.5);
            if (c.isBlocked(fx, fz) || c.isRoad(fx, fz)) continue;
            if (d < bd) { bd = d; best = i; }
          }
          if (best < 0) continue;
          const [dx, dz, y0, nx, nz, outN, gy] = Array.from(S.slice(best, best + 7));
          const sx = dx + nx * (outN + 1.3), sz = dz + nz * (outN + 1.3);
          const f0 = H.put(sx, sz, face(-nx, -nz), gy + 2);
          let reachedT = -1;
          const upRun = H.hold(['KeyW'], 3, (t, p, fy) => { if (reachedT < 0 && fy > y0 - 0.12) reachedT = t; });
          const e = H.pos();
          const wallGap = (e.x - dx) * nx + (e.z - dz) * nz; // distance of the capsule axis from the facade
          const top = H.feet();
          H.turnTo(P.facing + Math.PI);
          let end = NaN;
          const downRun = H.hold(['KeyW'], 2.5, (t, p, fy) => { if ((p.x - dx) * nx + (p.z - dz) * nz > outN + 0.6) { end = fy; return false; } });
          const r = { steps, rise: +(y0 - gy).toFixed(2), feet0: +f0.toFixed(2), feetTop: +top.toFixed(2), landing: +y0.toFixed(2), climbSec: +reachedT.toFixed(2), wallGap: +wallGap.toFixed(2), feetEnd: +end.toFixed(2), pen: Math.max(upRun.pen, downRun.pen) };
          res.stoops.push(r);
          if (Math.abs(top - y0) > 0.12) fail(`stoop ${steps} steps: landing feet ${r.feetTop} vs ${r.landing}`);
          if (wallGap < 0.3) fail(`stoop ${steps} steps: walked into the facade (gap ${r.wallGap})`);
          if (r.pen > PEN) fail(`stoop ${steps} steps: feet ${r.pen} below the surface`);
          if (Math.abs(end - gy) > 0.15) fail(`stoop ${steps} steps: back down at ${r.feetEnd} vs ${gy.toFixed(2)}`);
          // sideways off the landing into the iron rail
          if (steps >= 3) {
            const ux = -nz, uz = nx;
            H.put(dx + nx * 0.6, dz + nz * 0.6, face(ux, uz), y0 + 1.5);
            const p0 = H.pos();
            H.hold(['KeyW'], 1.2);
            const p1 = H.pos();
            const side = Math.abs((p1.x - dx) * ux + (p1.z - dz) * uz);
            res.stoops.push({ steps, test: 'into the rail', sideOffset: +side.toFixed(2), feet: +H.feet().toFixed(2) });
            if (side > 0.72 - 0.35 + 0.08) fail(`stoop ${steps} steps: walked through the rail (offset ${side.toFixed(2)})`);
            void p0;
          }
        }
      }
    }
    // ------------------------------------------------------------------ kerb: road to sidewalk and back (real maps: the grid has none)
    if (geo) {
      const k = { x: 0, y: 0, z: 0, heading: 0, edge: -1, s: 0, dist: 0 };
      // a kerb near the spawn with no car parked on it (the test once started on a car's bonnet at the spawn's kerb)
      const fx0 = Math.sin(c.kerbPoint(c.spawn.x, c.spawn.z, k) ? k.heading : 0), fz0 = Math.cos(k.heading);
      for (const along of [0, 6, -6, 12, -12, 18, -18, 24, -24, 30, -30]) {
        c.kerbPoint(c.spawn.x + fx0 * along, c.spawn.z + fz0 * along, k);
        if (!w.vehicles.some((v) => { const t = v.body.translation(); return Math.hypot(t.x - k.x, t.z - k.z) < 4; })) break;
      }
      const rx = -Math.cos(k.heading), rz = Math.sin(k.heading); // the pavement side
      H.put(k.x, k.z, face(rx, rz), k.y + 2);
      const f0 = H.feet();
      const run = H.hold(['KeyW'], 1.2);
      const f1 = H.feet();
      H.turnTo(P.facing + Math.PI);
      const back = H.hold(['KeyW'], 1.2);
      const f2 = H.feet();
      res.special.push({ test: 'kerb up and down', road: +f0.toFixed(2), sidewalk: +f1.toFixed(2), backOnRoad: +f2.toFixed(2), moved: run.moved, pen: Math.max(run.pen, back.pen) });
      if (run.moved < 3) fail(`kerb: stuck at the kerb (moved ${run.moved} m)`);
      if (f1 - f0 < 0.1) fail(`kerb: did not step up (${f0.toFixed(2)} -> ${f1.toFixed(2)})`);
      if (Math.max(run.pen, back.pen) > PEN) fail('kerb: feet below the surface');
    }
    // ------------------------------------------------------------------ statue plinth: blocked, then jump up two tiers
    {
      let tier = null;
      w.physics.colliders.forEach((col) => {
        if (tier || H.kindName(c.solidTags.get(col.handle)) !== 'monument' || col.shapeType() !== 1) return;
        const h = col.halfExtents();
        if (Math.abs(h.x - 4.5) < 0.01 && Math.abs(h.z - 3.2) < 0.01) { const t = col.translation(); tier = { x: t.x, y: t.y + h.y, z: t.z }; }
      });
      if (tier) {
        const y = tier.y - 0.5; // ground level at the plinth
        H.put(tier.x, tier.z + 3.2 + 2.5, Math.PI, y + 2);
        const blocked = H.hold(['KeyW'], 1.2);
        const gap1 = H.pos().z - (tier.z + 3.2);
        H.press('Space');
        const j1 = H.hold(['KeyW'], 0.9);
        const onTier1 = H.feet();
        H.press('Space');
        const j2 = H.hold(['KeyW'], 0.9);
        const onTier2 = H.feet();
        const j3 = H.hold(['KeyW'], 1.0);
        res.special.push({ test: 'statue plinth', groundFeet: +y.toFixed(2), blockedGap: +gap1.toFixed(2), tier1: +(onTier1 - y).toFixed(2), tier2: +(onTier2 - y).toFixed(2), pen: Math.max(blocked.pen, j1.pen, j2.pen, j3.pen), stoppedByMarble: j3.moved < 0.6 });
        if (gap1 < 0.35 - 0.08) fail(`plinth: walked into the first tier (gap ${gap1.toFixed(2)})`);
        // one running jump lands on tier 1 (0.5 m) or, carried on by the run and the autostep, on tier 2 (1.0 m)
        if (onTier1 - y < 0.4) fail(`plinth: jump onto tier 1 failed (${(onTier1 - y).toFixed(2)})`);
        if (Math.abs(onTier2 - y - 1.0) > 0.1) fail(`plinth: not standing on tier 2 after two jumps (${(onTier2 - y).toFixed(2)})`);
        if (!(j3.moved < 0.6)) fail('plinth: the marble block did not stop the player');
      }
    }
    // ------------------------------------------------------------------ jump onto a bench seat from the front
    {
      let seat = null;
      w.physics.colliders.forEach((col) => {
        if (H.kindName(c.solidTags.get(col.handle)) !== 'bench' || col.shapeType() !== 1) return;
        const h = col.halfExtents();
        if (Math.abs(h.y - 0.025) > 0.005 || Math.abs(h.x - 0.95) > 0.01) return; // the seat slats box
        const t = col.translation(), q = col.rotation();
        // the bench's local +z (its back) in world: rotate (0, 0, 1) by q
        const bx = 2 * (q.x * q.z + q.w * q.y), bz = 1 - 2 * (q.x * q.x + q.y * q.y);
        const fx = t.x - bx * 1.4, fz = t.z - bz * 1.4;
        const d = Math.hypot(t.x - c.spawn.x, t.z - c.spawn.z);
        if (c.isBlocked(fx, fz) || (seat && seat.d < d)) return;
        const fl = H.floor(fx, t.y + 2, fz);
        if (!fl || Math.abs(fl.y - (t.y - 0.445)) > 0.15) return; // level ground in front
        seat = { x: t.x, z: t.z, top: t.y + 0.025, bx, bz, fx, fz, d };
      });
      if (seat) {
        // stand at the front edge, jump with a short push forward (a running jump clears the 0.9 m back)
        H.put(seat.x - seat.bx * 0.7, seat.z - seat.bz * 0.7, face(seat.bx, seat.bz), seat.top + 1);
        const y0 = H.feet();
        H.press('Space');
        const run = H.hold(['KeyW'], 0.2);
        H.hold([], 1.0);
        const y1 = H.feet();
        res.special.push({ test: 'jump onto a bench', ground: +y0.toFixed(2), seatTop: +seat.top.toFixed(2), feetAfter: +y1.toFixed(2), pen: run.pen });
        if (Math.abs(y1 - seat.top) > 0.12) fail(`bench: not standing on the seat after the jump (feet ${y1.toFixed(2)}, seat ${seat.top.toFixed(2)})`);
      }
    }
    // ------------------------------------------------------------------ decks: Key Bridge sidewalk, the freeway carriageway
    for (const [name, onSidewalk] of [['Key Bridge', true], ['Whitehurst Freeway', false]]) {
      const e = c.roads.edges.find((q) => q.bridge && (q.name ?? '').includes(name) && q.len > 80);
      if (!e) continue;
      const lp = { x: 0, y: 0, z: 0, heading: 0 };
      window.__ocMap.laneSample?.(e, e.len * 0.3, lp);
      const off = onSidewalk ? e.halfWidth - e.offset + 1.5 : 0;
      const sx = lp.x - Math.cos(lp.heading) * off, sz = lp.z + Math.sin(lp.heading) * off;
      H.put(sx, sz, lp.heading, lp.y + 2.5);
      const f0 = H.feet();
      let minY = Infinity, maxDrop = 0;
      const run = H.hold(['KeyW'], 8, (t, p, fy) => { minY = Math.min(minY, fy); const s = c.heightAt(p.x, p.z, fy + 0.5); maxDrop = Math.max(maxDrop, s - fy); });
      const f1 = H.feet();
      // (mapDeckAbove: how far map.heightAt's deck stood above the feet: a map-query difference, reported only)
      res.special.push({ test: `walk the ${name} deck`, start: +f0.toFixed(2), end: +f1.toFixed(2), minFeet: +minY.toFixed(2), deckAt: +lp.y.toFixed(2), moved: run.moved, pen: run.pen, mapDeckAbove: +maxDrop.toFixed(3) });
      if (run.pen > PEN) fail(`${name}: feet below the deck`);
      if (minY < lp.y - 3) fail(`${name}: fell off the deck`);
      if (run.moved < 20) fail(`${name}: stuck on the deck (moved ${run.moved} m)`);
    }
    // ------------------------------------------------------------------ props: walk into one of each kind
    {
      const byKind = new Map();
      w.physics.colliders.forEach((col) => {
        const kn = H.kindName(c.solidTags.get(col.handle));
        if (!['tree', 'lamp', 'signalPole', 'signPost', 'bench', 'busShelter', 'gravestone', 'fountain', 'lockGate', 'column', 'railing', 'boat', 'kiosk', 'container', 'monument', 'wall', 'building', 'stoopRail', 'tower'].includes(kn)) return;
        if (col.shapeType() !== 1 && col.shapeType() !== 10) return; // primitives (their centre is meaningful)
        const t = col.translation();
        const d = Math.hypot(t.x - c.spawn.x, t.z - c.spawn.z);
        let l = byKind.get(kn);
        if (!l) byKind.set(kn, (l = []));
        l.push({ col, d, x: t.x, z: t.z });
      });
      for (const [kn, list] of byKind) {
        list.sort((a, b) => a.d - b.d);
        let done = false;
        for (const cand of list.slice(0, 60)) {
          if (done) break;
          for (let k = 0; k < 8 && !done; k++) {
            const a = (k / 8) * Math.PI * 2;
            const dx = Math.cos(a), dz = Math.sin(a);
            // start 3 m out on open ground, nothing else between the start and the prop at knee height
            const sx = cand.x + dx * 3, sz = cand.z + dz * 3;
            if (c.isBlocked(sx, sz) || c.isWater(sx, sz)) continue;
            const fl = H.floor(sx, c.heightAt(sx, sz, 1e3) + 3, sz);
            if (!fl || fl.kind !== 'ground' && fl.kind !== 'pier' && fl.kind !== 'kerb') continue;
            const knee = fl.y + 0.4;
            const hit = H.cast(sx, knee, sz, -dx, -dz, 4);
            if (!hit || hit.kind !== kn || hit.d > 3.2 || hit.d < 1.0) continue;
            // the floor between must be walkable and level-ish
            const mid = H.floor(sx - dx * hit.d * 0.5, fl.y + 1.5, sz - dz * hit.d * 0.5);
            if (!mid || Math.abs(mid.y - fl.y) > 0.3) continue;
            // how high the obstacle stands above that floor (a low one is stepped over or jumped on, not a wall)
            const hx = sx - dx * (hit.d + 0.06), hz = sz - dz * (hit.d + 0.06);
            const topHit = H.floor(hx, fl.y + 8, hz, 9);
            const height = topHit ? topHit.y - fl.y : 0;
            H.put(sx, sz, face(-dx, -dz), fl.y + 1.5);
            // closest the capsule's axis gets to the prop's collider (at knee and chest height), minus its radius
            let worst = Infinity;
            const run = H.hold(['KeyW'], 1.5, (t, p, fy) => {
              for (const hgt of [0.4, 1.2]) {
                const pr = cand.col.projectPoint({ x: p.x, y: fy + hgt, z: p.z }, true);
                const gap = pr.isInside ? -1 : Math.hypot(pr.point.x - p.x, pr.point.z - p.z) - 0.35;
                if (gap < worst) worst = gap;
              }
            });
            const r = { kind: kn, at: [+cand.x.toFixed(1), +cand.z.toFixed(1)], startGap: +(hit.d - 0.35).toFixed(2), obstacleHeight: +height.toFixed(2), closestGap: +worst.toFixed(3), moved: run.moved, pen: run.pen };
            res.props.push(r);
            if (height > 0.5 && worst < -0.06) fail(`${kn}: the capsule went ${(-worst).toFixed(2)} m into it at (${r.at})`);
            done = true;
          }
        }
        if (!done) res.props.push({ kind: kn, skipped: 'no clear approach found' });
      }
    }
    w.input.keys.clear();
    // the closing screenshot: halfway up the landmark stair with the F4 collision view on
    if (geo) {
      const st = geo.stairs[0], f = st.flights[1] ?? st.flights[0];
      const a = along(st.pts, (f[0] + f[1]) / 2);
      H.put(a.x - a.uz * st.w / 4, a.z + a.ux * st.w / 4, face(a.ux, a.uz), st.h((f[0] + f[1]) / 2) + 1.5);
      w.dayNight.hour = 12.5;
      if (!w.physDebug.on) w.input.pressed.add('F4');
      const y = H.feet();
      w.cam.override = { px: a.x - a.ux * 7 - a.uz * 6, py: y + 5, pz: a.z - a.uz * 7 + a.ux * 6, lx: a.x + a.ux * 2, ly: y + 0.5, lz: a.z + a.uz * 2 };
      window.__ocFrames(1, true); w.physDebug.nextAt = 0; window.__ocFrames(4, true);
    }
    return res;
  });
  return { ...out, pass: out.fails.length === 0 };
}

/**
 * Drops the player from 2 m at thousands of random points over the whole map (fixed sequence) and checks where the
 * feet come to rest: on a surface within 5 cm of map.heightAt (props, stoops and decks are reported separately:
 * landing on a bench is right), never below it, never inside a building. A capsule resting on a ledge's edge (its
 * centre over the lower floor) is counted as `ledge`, not as a hover. SAMPLES=<n> (default 2000), FALL_SEED=<n> picks
 * another fixed set of points.
 */
export async function fallthrough(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installWalkHelpers);
  const n = Number(process.env.SAMPLES ?? 2000), seed0 = Number(process.env.FALL_SEED ?? 987654);
  return page.evaluate(([n, seed0]) => {
    const w = window.__oc, c = w.city, P = w.player, H = window.__wk, R = w.R;
    const hh = P.collider.halfHeight(), rad = P.collider.radius();
    const b = c.bounds;
    let seed = seed0;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // below: the feet sank under the collider they stand on; mapLow / mapHigh: that collider is more than 5 cm under /
    // over map.heightAt there; hover: the feet rest more than 0.25 m above it (a capsule on a slope rests a little up)
    const st = { tried: 0, water: 0, blocked: 0, occupied: 0, raised: 0, landed: 0, ok: 0, onProp: 0, onDeck: 0, below: 0, mapLow: 0, mapHigh: 0, hover: 0, ledge: 0, insideBuilding: 0, notSettled: 0, drift: 0 };
    const examples = { below: [], mapLow: [], mapHigh: [], hover: [], ledge: [], insideBuilding: [], notSettled: [], onProp: {} };
    let maxRest = 0;
    const capsule = new R.Capsule(hh, rad);
    const STATIC = (0xffff << 16) | 1;
    const anyRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const t0 = performance.now();
    let maxDrift = 0;
    for (let i = 0; i < n; i++) {
      const x = b.minX + 3 + rnd() * (b.maxX - b.minX - 6), z = b.minZ + 3 + rnd() * (b.maxZ - b.minZ - 6);
      st.tried++;
      if (c.isWater(x, z)) { st.water++; continue; }
      if (c.isBlocked(x, z)) { st.blocked++; continue; }
      const g = c.heightAt(x, z);
      // a post, trunk or wall standing on the spot: nothing to land on there
      if (w.physics.intersectionWithShape({ x, y: g + hh + rad + 0.25, z }, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, STATIC) !== null) { st.occupied++; continue; }
      // 2 m above the ground; where that is inside something (a bridge deck or pier over the spot), 2 m above the top
      // of it (the player falls onto the deck: dropping a capsule inside a solid tests nothing)
      let top = g + 2;
      const inSolid = (y) => w.physics.intersectionWithShape({ x, y: y + hh + rad, z }, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, STATIC) !== null;
      if (inSolid(top)) {
        const roof = H.floor(x, g + 60, z, 60);
        if (roof && roof.y > g + 0.3) top = roof.y + 2;
        if (inSolid(top)) { st.occupied++; continue; }
        st.raised++;
      }
      P.body.setTranslation({ x, y: top + hh + rad, z }, true);
      P.body.setNextKinematicTranslation({ x, y: top + hh + rad, z });
      P.vy = 0; P.knockT = 0; w.input.keys.clear();
      // at rest: on the ground and no longer moving (a capsule that lands on a steep bank is grounded while it still
      // slides down it for a few frames)
      let settled = false, still = 0, lastY = NaN;
      for (let f = 0; f < 120; f++) {
        window.__ocStep(1);
        const y = P.body.translation().y;
        still = P.grounded && Math.abs(y - lastY) < 0.002 ? still + 1 : 0;
        lastY = y;
        if (f > 20 && still >= 4) { settled = true; break; }
      }
      const p = P.body.translation();
      const feet = p.y - hh - rad;
      const drift = Math.hypot(p.x - x, p.z - z);
      maxDrift = Math.max(maxDrift, drift);
      if (!settled) { st.notSettled++; if (examples.notSettled.length < 8) examples.notSettled.push([+x.toFixed(1), +z.toFixed(1), +feet.toFixed(2), +g.toFixed(2)]); continue; }
      st.landed++;
      if (drift > 0.3) st.drift++;
      const under = H.floor(p.x, feet + 0.3, p.z, 5);
      const kind = under ? under.kind : 'none';
      const gy = c.heightAt(p.x, p.z), gyy = c.heightAt(p.x, p.z, feet + 0.3);
      // inside a building: the capsule overlaps a building collider, or stands where the map says it's blocked
      let inBld = false;
      w.physics.intersectionsWithShape({ x: p.x, y: p.y, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Capsule(hh - 0.05, rad - 0.05), (col) => { if (H.kindName(c.solidTags.get(col.handle)) === 'building') inBld = true; return !inBld; }, undefined, STATIC);
      if (inBld) { st.insideBuilding++; if (examples.insideBuilding.length < 8) examples.insideBuilding.push([+x.toFixed(1), +z.toFixed(1)]); continue; }
      const ex = (list, extra) => { if (list.length < 8) list.push([+x.toFixed(1), +z.toFixed(1), +feet.toFixed(3), ...extra]); };
      if (!under) { st.below++; ex(examples.below, ['no floor under']); continue; }
      const rest = feet - under.y;
      maxRest = Math.max(maxRest, rest);
      if (rest < -0.05) { st.below++; ex(examples.below, [+under.y.toFixed(3), kind]); continue; }
      if (rest > 0.25) {
        // landed on something that moves (a parked car's roof, a person): the static floor ray doesn't see it
        let onBody = null;
        for (let k = 0; k <= 12 && !onBody; k++) {
          const r = k === 12 ? 0 : rad * 0.95;
          anyRay.origin.x = p.x + Math.cos(k * Math.PI / 6) * r; anyRay.origin.y = feet + 0.3; anyRay.origin.z = p.z + Math.sin(k * Math.PI / 6) * r;
          const h = w.physics.castRay(anyRay, 0.6, true, undefined, undefined, undefined, P.body);
          const body = h && h.collider.parent();
          if (body && !body.isFixed()) onBody = body.isDynamic() ? 'dynamic body' : 'kinematic body';
        }
        if (onBody) { st.onProp++; examples.onProp[onBody] = (examples.onProp[onBody] ?? 0) + 1; continue; }
        // resting on a ledge's or a step's edge (a capsule holds there with its centre over the lower floor): some floor
        // under the capsule's round bottom touches it. The controller keeps its skin gap (ccOffset) from surfaces, so
        // the bottom is a sphere of radius rad + gap whose lowest point is the gap below the feet: a floor point d from
        // the axis touches it at feet - gap + R - sqrt(R^2 - d^2). Reported, not a failure; a hover with nothing
        // touching the capsule is.
        const gap = w.player.cc.offset(), Rr = rad + gap;
        let rim = -Infinity, touch = false;
        for (let fr = 0.2; fr <= 1.001; fr += 0.1) for (let k = 0; k < 16; k++) {
          const d = Rr * fr;
          const f = H.floor(p.x + Math.cos(k * Math.PI / 8) * d, feet + rad, p.z + Math.sin(k * Math.PI / 8) * d, 5);
          if (!f) continue;
          rim = Math.max(rim, f.y);
          if (f.y >= feet - gap + Rr - Math.sqrt(Math.max(0, Rr * Rr - d * d)) - 0.03) touch = true;
        }
        if (touch) { st.ledge++; ex(examples.ledge, [+under.y.toFixed(3), +rim.toFixed(3), kind]); continue; }
        st.hover++; ex(examples.hover, [+under.y.toFixed(3), +rim.toFixed(3), kind]); continue;
      }
      if (kind !== 'ground' && kind !== 'kerb' && kind !== 'stair' && kind !== 'deck') { st.onProp++; examples.onProp[kind] = (examples.onProp[kind] ?? 0) + 1; continue; }
      const ref = Math.abs(gyy - under.y) < Math.abs(gy - under.y) ? gyy : gy;
      if (ref !== gy) st.onDeck++;
      const d = under.y - ref;
      if (d < -0.05) { st.mapLow++; ex(examples.mapLow, [+under.y.toFixed(3), +ref.toFixed(3), kind]); }
      else if (d > 0.05) { st.mapHigh++; ex(examples.mapHigh, [+under.y.toFixed(3), +ref.toFixed(3), kind]); }
      else st.ok++;
    }
    const ms = Math.round(performance.now() - t0);
    return { samples: n, seed: seed0, ...st, maxDrift: +maxDrift.toFixed(3), maxRestAbove: +maxRest.toFixed(3), examples, ms, pass: st.below === 0 && st.insideBuilding === 0 && st.notSettled === 0 && st.hover === 0 && st.mapLow + st.mapHigh <= Math.ceil(st.landed * 0.002) };
  }, [n, seed0]);
}

/**
 * F4 collision view screenshots (screenshots/31-physics-f4-*.png): a stair, a stoop, a park with trees and Key Bridge
 * on Georgetown (on the grid: a park and a street corner). The camera is fixed for each shot; the view is rebuilt
 * around the player, who stands at the spot.
 */
export async function physf4(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  const spots = await page.evaluate(() => {
    const w = window.__oc, c = w.city, geo = c.geo;
    w.dayNight.hour = 12.5;
    const out = [];
    const cam = (name, px, py, pz, lx, ly, lz, sx, sz) => out.push({ name, px, py, pz, lx, ly, lz, sx, sz });
    if (geo) {
      // the canal steps by Wisconsin Ave: from the towpath, looking up the flight (from the side away from the bridge,
      // whose sidewalk would hide the stair)
      const st = geo.stairs.reduce((b, s) => (Math.abs(s.pts[0][0] + 131) < Math.abs(b.pts[0][0] + 131) ? s : b), geo.stairs[1]);
      const a = st.pts[0], b = st.pts[st.pts.length - 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      cam('stair', m[0] - ux * 9 + uz * 3, 3.2, m[1] - uz * 9 - ux * 3, m[0] + ux * 2, 1.2, m[1] + uz * 2, m[0] - ux * 2, m[1] - uz * 2);
      // a stoop of about 7 steps near the spawn
      const S = geo.audit.stoopInfo;
      let best = -1, bd = Infinity;
      for (let i = 0; i < S.length; i += 8) { if (S[i + 7] < 6) continue; const d = Math.hypot(S[i] - c.spawn.x, S[i + 1] - c.spawn.z); if (d < bd) { bd = d; best = i; } }
      const [dx, dz, , nx, nz, outN] = Array.from(S.slice(best, best + 6));
      const ex = -nz, ez = nx;
      cam('stoop', dx + nx * (outN + 4) + ex * 3.5, 3, dz + nz * (outN + 4) + ez * 3.5, dx + nx * outN * 0.5, 0.6, dz + nz * outN * 0.5, dx + nx * (outN + 1.2), dz + nz * (outN + 1.2));
      // a park with trees and benches: the densest cluster of trunk colliders near the spawn
      let tx = 0, tz = 0, bn = -1;
      const trunks = [];
      w.physics.colliders.forEach((col) => { if (c.solidTags.get(col.handle) === 21 && col.shapeType() === 10) { const t = col.translation(); trunks.push([t.x, t.z]); } });
      for (let k = 0; k < trunks.length; k += 7) {
        const [x, z] = trunks[k];
        let n = 0;
        for (const [x2, z2] of trunks) if (Math.abs(x2 - x) < 12 && Math.abs(z2 - z) < 12) n++;
        if (n > bn && !c.isBlocked(x + 3, z) && !c.isWater(x + 3, z)) { bn = n; tx = x; tz = z; }
      }
      cam('park', tx + 9, 15, tz + 9, tx, 0.5, tz, tx + 3, tz); // above the crowns
      // Key Bridge: on its sidewalk
      const e = c.roads.edges.find((q) => q.bridge && (q.name ?? '').includes('Key Bridge') && q.len > 80);
      const lp = { x: 0, y: 0, z: 0, heading: 0 };
      window.__ocMap.laneSample(e, e.len * 0.4, lp);
      const off = e.halfWidth - e.offset + 1.5;
      const sx = lp.x - Math.cos(lp.heading) * off, sz = lp.z + Math.sin(lp.heading) * off;
      const fx = Math.sin(lp.heading), fz = Math.cos(lp.heading);
      cam('keybridge', sx - fx * 9 + Math.cos(lp.heading) * 2, 3.5, sz - fz * 9 - Math.sin(lp.heading) * 2, sx + fx * 4, 0.5, sz + fz * 4, sx, sz);
    } else {
      const p = c.parkRects?.[0] ?? null;
      const x = c.center.x, z = c.center.z;
      cam('grid-street', x + 14, 6, z + 14, x, 0.5, z, x + 2, z + 2);
      if (p) cam('grid-park', (p.x0 + p.x1) / 2 + 14, 7, (p.z0 + p.z1) / 2 + 14, (p.x0 + p.x1) / 2, 0.5, (p.z0 + p.z1) / 2, (p.x0 + p.x1) / 2 + 3, (p.z0 + p.z1) / 2 + 6);
    }
    return out;
  });
  const shots = [];
  for (const s of spots) {
    const info = await page.evaluate((s) => {
      const w = window.__oc, c = w.city, P = w.player;
      const y = c.heightAt(s.sx, s.sz, 1e3);
      P.body.setTranslation({ x: s.sx, y: y + 1.0, z: s.sz }, true);
      P.vy = 0;
      window.__ocStep(30);
      if (!w.physDebug.on) w.input.pressed.add('F4');
      // camera and target heights are above the player's own floor (on a bridge, the ground under the camera is the river)
      const fy = P.body.translation().y - P.collider.halfHeight() - P.collider.radius();
      w.cam.override = { px: s.px, py: fy + s.py, pz: s.pz, lx: s.lx, ly: fy + s.ly, lz: s.lz };
      window.__ocFrames(1, true);
      w.physDebug.nextAt = 0;
      window.__ocFrames(4, true);
      return { colliders: w.physDebug.colliders, edges: w.physDebug.segs };
    }, s);
    const path = `screenshots/31-physics-f4-${s.name}.png`;
    await page.screenshot({ path });
    shots.push({ path, ...info });
  }
  await page.evaluate(() => { const w = window.__oc; w.cam.override = null; if (w.physDebug.on) { w.input.pressed.add('F4'); window.__ocFrames(1, true); } });
  return { shots, pass: shots.every((s) => s.edges > 0) };
}

// Debug probe (any map): starts the game and prints the JSON value of the expression in $PROBE, evaluated in the page
// with w = window.__oc, c = the CityMap, M = window.__ocMap.  PROBE='c.roads.edges.length' node scripts/shot.mjs x probe
export async function probe(page, S) {
  await S.start(page);
  return page.evaluate((src) => { const w = window.__oc, c = w.city, M = window.__ocMap; return eval(src); }, process.env.PROBE ?? 'null');
}

// Road smoothness audit (MAP=georgetown node scripts/shot.mjs x roadaudit): casts rays at the static colliders along
// every lane (centre and both wheel tracks, every 0.5 m), across every junction (each arriving lane to each leaving
// lane, straight chord) and along every walk link, and measures grade, grade change per metre, kinks (second
// difference: bumps, seams, deck joins), cross-slope and the gap between the lane and the surface under it. Limits:
// TUNING.geo.roadLimits. Prints counts over the limits, percentiles and the worst places.
export async function roadaudit(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, c = w.city, M = window.__ocMap, Lm = M.roadLimits, R = w.R, P = w.physics;
    const E = c.roads.edges, N = c.roads.nodes;
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const fixedOnly = (col) => { const b = col.parent(); return !b || b.isFixed(); };
    const cast = (x, y, z, down) => {
      ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
      const hit = P.castRay(ray, down, true, undefined, undefined, undefined, undefined, fixedOnly);
      return hit ? y - hit.timeOfImpact : NaN;
    };
    const main = new Set(['primary', 'secondary', 'trunk', 'parkway']);
    const LP = { x: 0, y: 0, z: 0, heading: 0 };
    const stat = () => ({ n: 0, over: 0, worst: [] });
    const S2 = { grade: stat(), gradeChange: stat(), step: stat(), cross: stat(), gap: stat(), junction: stat(), walk: stat(), walkWall: stat(), holes: stat() };
    const vals = { grade: [], gradeChange: [], step: [], cross: [] };
    const byCls = {};
    let rs = 7;
    const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
    let curEnd = false;
    const note = (st, v, lim, where) => {
      st.n++;
      if (v > lim) {
        st.over++;
        const key = `${Object.keys(S2).find((k) => S2[k] === st)}:${where[1]}${curEnd ? ':end' : ''}`;
        byCls[key] = (byCls[key] ?? 0) + 1;
        // a reservoir sample of typical cases (the worst list only shows the extremes)
        st.sample ??= [];
        if (st.sample.length < 40) st.sample.push([+v.toFixed(3), ...where, curEnd ? 'end' : 'mid']);
        else { const j = Math.floor(rnd() * st.over); if (j < 40) st.sample[j] = [+v.toFixed(3), ...where, curEnd ? 'end' : 'mid']; }
        st.worst.push([+v.toFixed(3), ...where]);
        if (st.worst.length > 4000) { st.worst.sort((a, b) => b[0] - a[0]); st.worst.length = 2000; }
      }
    };
    const DS = 0.5;
    for (const e of E) {
      if (e.len < 2) continue;
      const isMain = main.has(e.cls), isSvc = e.cls === 'service';
      const n = Math.floor(e.len / DS) + 1;
      const ys = new Float32Array(n);
      const where = (s) => { curEnd = s < e.trimStart + 6 || s > e.len - e.trimEnd - 6; M.laneSample(e, s, LP); return [e.name ?? e.roadId, e.cls, Math.round(LP.x), Math.round(LP.z)]; };
      for (let i = 0; i < n; i++) {
        const s = Math.min(e.len, i * DS);
        M.laneSample(e, s, LP);
        const y = cast(LP.x, LP.y + 1.5, LP.z, 4);
        ys[i] = y;
        if (Number.isNaN(y)) { note(S2.holes, 1, 0.5, where(s)); continue; }
        note(S2.gap, Math.abs(y - LP.y), Lm.maxSurfaceGap, where(s));
        if (i % 2 === 0) {
          const rx = -Math.cos(LP.heading) * 0.8, rz = Math.sin(LP.heading) * 0.8;
          const yl = cast(LP.x - rx, LP.y + 1.5, LP.z - rz, 4), yr = cast(LP.x + rx, LP.y + 1.5, LP.z + rz, 4);
          if (!Number.isNaN(yl) && !Number.isNaN(yr)) { const cs = Math.abs(yl - yr) / 1.6; vals.cross.push(cs); note(S2.cross, cs, Lm.maxCrossSlope, where(s)); }
        }
      }
      // kinks: second difference over 0.5 m (a seam, a bump, a deck join); grades on a 4 m baseline
      for (let i = 1; i + 1 < n; i++) {
        if (Number.isNaN(ys[i - 1] + ys[i] + ys[i + 1])) continue;
        const k = Math.abs(ys[i + 1] - 2 * ys[i] + ys[i - 1]);
        vals.step.push(k);
        note(S2.step, k, Lm.maxStep, where(i * DS));
      }
      const g = new Float32Array(n).fill(NaN);
      for (let i = 4; i + 4 < n; i++) if (!Number.isNaN(ys[i - 4] + ys[i + 4])) g[i] = (ys[i + 4] - ys[i - 4]) / 4;
      for (let i = 4; i + 4 < n; i++) {
        if (Number.isNaN(g[i])) continue;
        vals.grade.push(Math.abs(g[i]));
        note(S2.grade, Math.abs(g[i]), isMain ? Lm.maxGradeMain : isSvc ? Lm.maxGradeService : Lm.maxGrade, where(i * DS));
        if (i + 2 < n && i >= 2 && !Number.isNaN(g[i - 2] + g[i + 2])) {
          const gc = Math.abs(g[i + 2] - g[i - 2]) / 2;
          vals.gradeChange.push(gc);
          note(S2.gradeChange, gc, isMain ? Lm.maxGradeChangeMain : isSvc ? Lm.maxGradeChangeService : Lm.maxGradeChange, where(i * DS));
        }
      }
    }
    // junctions: arriving lane end -> leaving lane start, a straight chord (the plateau and its seams with the arms)
    for (const nd of N) {
      if (!nd.junction) continue;
      for (const ia of nd.in) for (const ob of nd.out) {
        const a = E[ia], b = E[ob];
        if (b.twin === a.id && !nd.deadEnd) continue;
        M.laneSample(a, a.len - Math.min(a.len, 3), LP);
        const ax = LP.x, ay = LP.y, az = LP.z;
        M.laneSample(b, Math.min(b.len, 3), LP);
        const bx = LP.x, by = LP.y, bz = LP.z;
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1) continue;
        const m = Math.ceil(L / DS);
        let y0 = NaN, y1 = NaN, worst = 0, wx = 0, wz = 0;
        for (let i = 0; i <= m; i++) {
          const t = i / m, x = ax + (bx - ax) * t, z = az + (bz - az) * t, yy = ay + (by - ay) * t;
          const y = cast(x, yy + 1.5, z, 4);
          if (!Number.isNaN(y + y0 + y1)) { const k = Math.abs(y - 2 * y1 + y0); if (k > worst) { worst = k; wx = x; wz = z; } }
          y0 = y1; y1 = y;
        }
        note(S2.junction, worst, Lm.maxJunctionStep, [`${a.name ?? a.roadId} -> ${b.name ?? b.roadId}`, nd.id, Math.round(wx), Math.round(wz)]);
      }
    }
    // walk links: steps along the way people walk (kerbs at crossings are 0.15 m)
    const W = c.walk.nodes;
    for (const a of W) for (const j of a.nbrs) {
      if (j < a.id) continue;
      const b = W[j];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.5) continue;
      const m = Math.ceil(L / DS);
      let prev = NaN, worst = 0, wx = 0, wz = 0;
      for (let i = 0; i <= m; i++) {
        const t = i / m, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, yy = a.y + (b.y - a.y) * t;
        const y = cast(x, yy + 1.2, z, 3);
        if (!Number.isNaN(y + prev) && Math.abs(y - prev) > worst) { worst = Math.abs(y - prev); wx = x; wz = z; }
        prev = y;
      }
      note(S2.walk, worst, Lm.maxWalkStep, [a.kind + '-' + b.kind, a.street ?? '', Math.round(wx), Math.round(wz)]);
      if (worst > 0.45) note(S2.walkWall, worst, 0.45, [a.kind + '-' + b.kind, a.street ?? '', Math.round(wx), Math.round(wz)]);
    }
    const pct = (a, q) => { if (!a.length) return 0; a.sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(3); };
    curEnd = false;
    const out = { limits: Lm, lanes: E.length, metrics: {}, areas: {}, byClass: byCls };
    // where the over-limit samples are: 250 m cells
    for (const [k, st] of Object.entries(S2)) for (const wv of st.worst) { const key = `${Math.floor(wv[wv.length - 2] / 250) * 250},${Math.floor(wv[wv.length - 1] / 250) * 250}`; out.areas[key] = (out.areas[key] ?? 0) + 1; }
    for (const [k, st] of Object.entries(S2)) {
      st.worst.sort((a, b) => b[0] - a[0]);
      out.metrics[k] = { samples: st.n, over: st.over, worst: st.worst.slice(0, 12), sample: st.sample ?? [] };
      if (vals[k]) Object.assign(out.metrics[k], { p50: pct(vals[k], 0.5), p99: pct(vals[k], 0.99), p999: pct(vals[k], 0.999), max: pct(vals[k], 1) });
    }
    return out;
  });
}

// Drive test (MAP=georgetown node scripts/shot.mjs x roaddrive): the player's car driven physically along every
// major street (primary, secondary, tertiary, parkway; lanes chained straight on through junctions), at street speed,
// steered by a path follower that only turns the body about the vertical (suspension, pitch and roll stay physical).
// Measures the chassis' vertical acceleration and the time with all four wheels off the ground; reports the worst
// streets and places against TUNING.geo.roadLimits (maxVertAccel, maxAirtime). Other traffic is moved away first.
export async function roaddrive(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, c = w.city, M = window.__ocMap, Lm = M.roadLimits;
    const E = c.roads.edges, N = c.roads.nodes;
    const STEP = 1 / 60;
    const major = new Set(['primary', 'secondary', 'tertiary', 'parkway']);
    const dir = (e, atEnd) => { const p = e.pts, n = p.length; return atEnd ? Math.atan2(p[n - 3] - p[n - 6], p[n - 1] - p[n - 4]) : Math.atan2(p[3] - p[0], p[5] - p[2]); };
    const dAng = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const next = (e) => N[e.to].out.map((i) => E[i]).filter((n) => n.name && n.name === e.name && major.has(n.cls) && n.to !== e.from && !n.parking && dAng(dir(n, false), dir(e, true)) < 0.5).sort((a, b) => dAng(dir(a, false), dir(e, true)) - dAng(dir(b, false), dir(e, true)) || b.lane - a.lane)[0];
    const prev = (e) => N[e.from].in.map((i) => E[i]).find((p) => p.name === e.name && major.has(p.cls) && p.from !== e.to && dAng(dir(p, true), dir(e, false)) < 0.5);
    // chains of lanes along each major street (the inner lane: the kerbside one may be a parking lane), longest first,
    // each lane used once
    const used = new Set();
    const chains = [];
    for (const e of E) {
      if (!major.has(e.cls) || !e.name || e.lane !== e.lanesSameDir - 1 || e.parking || used.has(e.id) || prev(e)) continue;
      const list = [];
      for (let k = e, guard = 0; k && !used.has(k.id) && guard < 200; k = next(k), guard++) { list.push(k); used.add(k.id); }
      const len = list.reduce((s, q) => s + q.len, 0);
      if (len >= 120) chains.push({ name: e.name, cls: e.cls, list, len });
    }
    chains.sort((a, b) => b.len - a.len);
    const LP = { x: 0, y: 0, z: 0, heading: 0 };
    const pathOf = (ch) => {
      const P = [];
      for (const e of ch.list) for (let s = 0; s < e.len; s += 1) { M.laneSample(e, s, LP); P.push(LP.x, LP.y, LP.z); }
      return P;
    };
    // the player's car
    let v = w.player.vehicle;
    if (!v) {
      v = w.vehicles.find((q) => q.owned) ?? w.vehicles[0];
      window.__mh.put(w.player.body, v.px - Math.cos(v.heading) * 2.2, v.pz + Math.sin(v.heading) * 2.2, 1.2);
      window.__ocRun(0.2); w.input.pressed.add('KeyE'); window.__ocRun(0.2);
      v = w.player.vehicle ?? v;
    }
    // other traffic, parked cars and people out of the way (a collision would skew the numbers)
    for (const t of w.traffic) if (t.body) t.body.setTranslation({ x: t.px, y: -500, z: t.pz }, false);
    for (const q of w.vehicles) if (q !== v) { q.body.setTranslation({ x: q.px, y: -600, z: q.pz }, false); q.body.setLinvel({ x: 0, y: 0, z: 0 }, false); q.body.setBodyType(w.R.RigidBodyType.Fixed, false); }
    w.peds.length = 0;
    w.traffic.length = 0;
    const out = [];
    let worstA = 0, worstAir = 0, overA = 0, overAir = 0, samples = 0, metres = 0;
    const budgetM = 30000;
    for (const ch of chains) {
      if (metres > budgetM) break;
      const P = pathOf(ch), n = P.length / 3;
      if (n < 30) continue;
      const target = Math.min(ch.cls === 'parkway' ? 18 : 13.9, ch.list[0].speed || 13.9);
      const h0 = Math.atan2(P[9] - P[0], P[11] - P[2]);
      // a fresh, drivable car each run (a collision in the previous run may have wrecked it)
      v.health = v.maxHealth; v.wrecked = false; v.driven = true; v.upsideTimer = 0;
      v.body.setTranslation({ x: P[3], y: P[4] + 0.9, z: P[5] }, true);
      v.body.setRotation({ x: 0, y: Math.sin(h0 / 2), z: 0, w: Math.cos(h0 / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      v.body.setLinvel({ x: Math.sin(h0) * target, y: 0, z: Math.cos(h0) * target }, true);
      v.prevVel?.set(Math.sin(h0) * target, 0, Math.cos(h0) * target);
      let idx = 1, t = 0, vyPrev = 0, air = 0, maxA = 0, maxAir = 0, at = null, airAt = null, lost = false, crash = null, spPrev = target;
      const recent = []; // last 0.4 s of samples: dropped if a collision follows (its spike is not the road's)
      const vys = [];
      const K = w.input.keys;
      for (let step = 0; step < 60 * 400; step++) {
        const p = v.body.translation();
        let bd = Infinity, bi = idx;
        for (let i = idx; i < Math.min(n, idx + 40); i++) { const d = Math.hypot(P[i * 3] - p.x, P[i * 3 + 2] - p.z); if (d < bd) { bd = d; bi = i; } }
        idx = bi;
        if (bd > 6) { lost = true; break; }
        if (idx >= n - 8) break;
        const la = Math.min(n - 1, idx + 7);
        const want = Math.atan2(P[la * 3] - p.x, P[la * 3 + 2] - p.z);
        const r = v.body.rotation();
        const fwdx = 2 * (r.x * r.z + r.w * r.y), fwdz = 1 - 2 * (r.x * r.x + r.y * r.y);
        const cur = Math.atan2(fwdx, fwdz);
        const err = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        const d = err * 0.25;
        const cy = Math.cos(d / 2), sy = Math.sin(d / 2);
        v.body.setRotation({ w: cy * r.w - sy * r.y, x: cy * r.x + sy * r.z, y: cy * r.y + sy * r.w, z: cy * r.z - sy * r.x }, true);
        const lv = v.body.linvel();
        const cd = Math.cos(d), sd = Math.sin(d);
        v.body.setLinvel({ x: lv.x * cd + lv.z * sd, y: lv.y, z: -lv.x * sd + lv.z * cd }, true);
        const sp = Math.hypot(lv.x, lv.z);
        if (sp < target - 0.5) { K.add('KeyW'); K.delete('KeyS'); } else if (sp > target + 2) { K.delete('KeyW'); K.add('KeyS'); } else { K.delete('KeyW'); K.delete('KeyS'); }
        window.__ocStep(1);
        t += STEP;
        // vertical acceleration felt in the cabin: the change of vertical speed over 0.1 s (a single 1/60 s step is
        // contact-solver noise)
        const vy = v.body.linvel().y;
        vys.push(vy);
        if (vys.length > 7) vys.shift();
        const ay = vys.length === 7 ? (vys[6] - vys[0]) / (6 * STEP) : 0;
        vyPrev = vy;
        let contacts = 0;
        for (let i = 0; i < 4; i++) if (v.ctrl.wheelIsInContact(i)) contacts++;
        const lv2 = v.body.linvel(), sp2 = Math.hypot(lv2.x, lv2.z);
        if (t < 1.5) { air = 0; spPrev = sp2; continue; }
        if (spPrev - sp2 > 0.8 || (sp2 < target * 0.4 && t > 3)) { crash = [Math.round(p.x), Math.round(p.z)]; break; } // hit something
        spPrev = sp2;
        air = contacts === 0 ? air + STEP : 0;
        recent.push([ay, air, Math.round(p.x), Math.round(p.z)]);
        if (recent.length > 24) {
          const [a0, air0, x0, z0] = recent.shift();
          samples++;
          if (Math.abs(a0) > Math.abs(maxA)) { maxA = a0; at = [x0, z0]; }
          if (Math.abs(a0) > Lm.maxVertAccel) overA++;
          if (air0 > maxAir) { maxAir = air0; airAt = [x0, z0]; }
          if (air0 > Lm.maxAirtime && air0 - STEP <= Lm.maxAirtime) overAir++;
        }
      }
      K.delete('KeyW'); K.delete('KeyS');
      metres += (idx / n) * ch.len;
      worstA = Math.max(worstA, Math.abs(maxA));
      worstAir = Math.max(worstAir, maxAir);
      out.push({ street: ch.name, cls: ch.cls, len: Math.round(ch.len), driven: Math.round((idx / n) * ch.len), maxVertAccel: +maxA.toFixed(2), at, maxAirtime: +maxAir.toFixed(3), airAt, lost, crash });
    }
    out.sort((a, b) => Math.abs(b.maxVertAccel) - Math.abs(a.maxVertAccel));
    return { limits: { maxVertAccel: Lm.maxVertAccel, maxAirtime: Lm.maxAirtime }, chains: chains.length, drivenKm: +(metres / 1000).toFixed(1), samples, worstVertAccel: +worstA.toFixed(2), worstAirtime: +worstAir.toFixed(3), samplesOverAccel: overA, airEventsOver: overAir, pass: worstA <= Lm.maxVertAccel && worstAir <= Lm.maxAirtime, runs: out };
  });
}

// Gate drive on the real graph (MAP=georgetown node scripts/shot.mjs x geodrive): your car drives Key Bridge -> M St
// east -> Pennsylvania Ave -> once round Washington Circle -> K St west to the waterfront, steered by a simple
// autopilot that only presses W/A/S/D/Space (no teleports after the start), stopping at red lights, waiting at stop
// signs, yielding on entering the circle and keeping its distance; traffic runs at the preset's density meanwhile.
// Measures the route and every AI car (window.__oc.trafficSim.stats with the audit on, plus an independent check of
// each car's lane-to-lane moves), CPU per frame and the traffic / police profiler sections. Screenshots
// 28-traffic-{keybridge,mst,signals,circle}.png.
export async function geodrive(page, S) {
  await S.start(page);
  const out = {};
  out.route = await page.evaluate(() => {
    const w = window.__oc, c = w.city, E = c.roads.edges, N = c.roads.nodes, J = w.junctions, T = window.__ocTraffic;
    const router = window.__ocMap.roadRouter();
    const lStart = (e) => Math.min(e.trimStart, e.len * 0.5), lStop = (e) => Math.max(lStart(e), e.len - e.trimEnd);
    const namesAt = (n) => new Set([...n.in, ...n.out].map((i) => E[i].name));
    const nodeWith = (a, b) => N.find((n) => !n.roundabout && namesAt(n).has(a) && namesAt(n).has(b));
    const traffic = (e) => J.edgeRank[e.id] >= 0;
    const kb = E.find((e) => e.bridge && /Key Bridge/.test(e.name ?? '') && e.pts[e.pts.length - 1] < e.pts[2] && J.edgeRank[e.id] === 0);
    if (!kb) return { error: 'no Key Bridge (run with MAP=georgetown)' };
    const route = [kb.id];
    const go = (node) => {
      const at = E[route[route.length - 1]].to;
      if (at === node) return true;
      const n = router.path(at, node);
      if (n <= 0) return false;
      for (let i = 0; i < n; i++) route.push(router.edges[i]);
      return true;
    };
    const wps = [nodeWith('M St NW', 'Wisconsin Ave NW'), nodeWith('M St NW', 'Pennsylvania Ave NW'), nodeWith('Pennsylvania Ave NW', '24th St NW')];
    for (const n of wps) if (!n || !go(n.id)) return { error: `no route to ${n ? n.id : '?'}`, route };
    // into the circle from Pennsylvania Ave (the entry nearest the end of the route so far)
    const here = N[E[route[route.length - 1]].to];
    // (real data: each carriageway of an avenue meets the ring at its own node, so look for one with an arm coming in)
    const armIn = (n, name) => n.roundabout && n.in.some((i) => !E[i].roundabout && E[i].name === name && traffic(E[i]));
    const armOut = (n, name) => n.roundabout && n.out.some((i) => !E[i].roundabout && E[i].name === name && traffic(E[i]));
    const entry = N.filter((n) => armIn(n, 'Pennsylvania Ave NW')).sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))[0];
    if (!entry || !go(entry.id)) return { error: 'no way into the circle', route };
    // once round (outer lane) and on to the K St exit on the west side
    const kExit = N.filter((n) => armOut(n, 'K St NW')).sort((a, b) => a.x - b.x)[0];
    let at = entry.id, ringSteps = 0;
    for (let k = 0; k < 20; k++) {
      const e = E.find((q) => q.roundabout && q.from === at && J.edgeRank[q.id] === 0);
      route.push(e.id); ringSteps++; at = e.to;
      if (ringSteps >= 8 && at === kExit.id) break;
    }
    const kOut = N[kExit.id].out.map((i) => E[i]).find((e) => !e.roundabout && e.name === 'K St NW' && traffic(e));
    if (!kOut) return { error: 'no K St exit', route };
    route.push(kOut.id);
    const tj = nodeWith('K St NW', 'Thomas Jefferson St NW');
    if (!go(tj.id)) return { error: 'no route to the waterfront', route };
    const last = N[tj.id].out.map((i) => E[i]).find((e) => e.name === 'K St NW' && traffic(e) && N[e.to].x < N[tj.id].x);
    route.push(last.id);
    // lanes (lane discipline): on each road the lane furthest from the kerb that may make the move onto the next road
    // (clear of kerbside clutter, as most drivers going straight on), the outer lane round the circle and into it;
    // the car enters each road in the lane its move leads into and changes lanes along the road where they differ
    const groupOf = (id) => J.edgeGroup[id];
    const enter = [route[0]], chosen = [];
    for (let i = 0; i < route.length; i++) {
      const e = E[route[i]];
      const nextG = i < route.length - 1 ? groupOf(route[i + 1]) : -1;
      const outer = e.roundabout || (i < route.length - 1 && E[route[i + 1]].roundabout && !e.roundabout);
      let hi = e; while (hi.left >= 0) hi = E[hi.left];
      let pick = -1, pickOut = -1;
      for (let l = hi; l && pick < 0; l = l.right >= 0 ? E[l.right] : null) {
        if (!traffic(l)) continue;
        if (nextG < 0) { pick = l.id; break; }
        const m0 = J.edgeM0[l.id], mn = J.edgeMN[l.id];
        for (let m = m0; m < m0 + mn; m++) {
          if (!J.mvOk[m] || groupOf(J.mvOut[m]) !== nextG) continue;
          if (outer && J.edgeRank[J.mvOut[m]] !== 0) continue; // the circle: its outer lane
          pick = l.id; pickOut = J.mvOut[m]; break;
        }
      }
      if (pick < 0) { pick = route[i]; pickOut = i < route.length - 1 ? route[i + 1] : -1; }
      chosen.push(pick);
      if (i < route.length - 1) enter.push(pickOut);
    }
    // the path: lane centre lines from start to stop line (easing across where the entry lane is not the chosen one),
    // junction curves between
    const P = [], edgeOf = [], stopIdx = [];
    const lp = { x: 0, y: 0, z: 0, heading: 0 }, lq = { x: 0, y: 0, z: 0, heading: 0 };
    chosen.forEach((id, k) => {
      const e = E[id], a = E[enter[k]];
      const s0 = k === 0 ? e.len * 0.3 : lStart(e), s1 = k === chosen.length - 1 ? Math.min(lStop(e), lStart(e) + 45) : lStop(e);
      const sB = Math.max(s0 + 4, s1 - 22), sA = Math.max(s0, sB - 30);
      for (let s = s0; s <= s1 + 0.01; s = s >= s1 ? s1 + 1 : Math.min(s1, s + 2)) {
        window.__ocMap.laneSample(e, s, lp);
        if (a.id !== e.id && s < sB) {
          window.__ocMap.laneSample(a, Math.min(s, a.len), lq);
          const t = s <= sA ? 0 : (s - sA) / (sB - sA), u = t * t * (3 - 2 * t);
          lp.x = lq.x + (lp.x - lq.x) * u; lp.z = lq.z + (lp.z - lq.z) * u;
        }
        P.push(lp.x, lp.y, lp.z); edgeOf.push(k);
      }
      stopIdx.push(edgeOf.length - 1);
      if (k < chosen.length - 1) {
        const cv = T.turnCurve(id, enter[k + 1]);
        for (let j = 1; j < cv.length / 2 - 1; j++) { P.push(cv[j * 2], NaN, cv[j * 2 + 1]); edgeOf.push(k); }
      }
    });
    route.splice(0, route.length, ...chosen);
    const n = P.length / 3, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);
    window.__gd = { route, P, edgeOf, stopIdx, cum, n, idx: 0, maxDev: 0, t0: 0, frames: 0, cpu: [], slow: [], seen: {}, sec: {}, stopT: 0, stoppedAt: -1, playerRedRuns: 0, stuckT: 0, illegal: 0, illegalWhere: '', moves: 0, last: new Map(), hp0: 0 };
    const names = []; for (const id of route) { const nm = E[id].name ?? E[id].roadId; if (names[names.length - 1] !== nm) names.push(nm); }
    return { edges: route.length, metres: Math.round(cum[n - 1]), roads: names.join(' > '), ringLanes: ringSteps, lanes: route.map((id, k) => `${E[id].name}#${id}L${E[id].lane}${enter[k] !== id ? `(from L${E[enter[k]].lane})` : ''}`).join(' ') };
  });
  if (out.route.error) return out;
  // put your car at the start (the one teleport): on Key Bridge's northbound kerb lane, 30% along, at rest
  out.start = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun, G = window.__gd, E = w.city.roads.edges;
    let v = w.player.vehicle;
    if (!v) {
      v = w.vehicles.find((q) => q.owned) ?? w.vehicles[0];
      window.__mh.put(w.player.body, v.px - Math.cos(v.heading) * 2.2, v.pz + Math.sin(v.heading) * 2.2, 1.2);
      run(0.2); w.input.pressed.add('KeyE'); run(0.2);
    }
    v = w.player.vehicle;
    const x = G.P[0], y = G.P[1], z = G.P[2], h = Math.atan2(G.P[3] - x, G.P[5] - z);
    v.body.setTranslation({ x, y: y + 0.9, z }, true);
    v.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0);
    w.cam.yaw = h + Math.PI;
    w.dayNight.hour = 13.5;
    run(1.5); // traffic gathers round the new spot
    w.trafficSim.measure = true; window.__ocTraffic.resetStats();
    G.t0 = w.time; G.hp0 = v.health; G.hpLast = v.health; G.dmg = [];
    for (const car of w.traffic) G.last.set(car, [car.edge, car.respawns]);
    // the autopilot: one 60 Hz frame per step, keys only
    const J = w.junctions, CTL = { SIGNALS: 1, STOP: 2, PRIORITY: 3, ALLWAY: 4, RING: 5 };
    const SEC = ['traffic', 'police-drive', 'police', 'traffic-ctl', 'physics', 'peds'];
    const secIdx = SEC.map((n) => w.prof.names.indexOf(n));
    const keys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'];
    window.__gdStep = (maxFrames, until) => {
      const N = w.city.roads.nodes;
      for (let f = 0; f < maxFrames; f++) {
        const v = w.player.vehicle;
        if (!v) return { status: 'out of car' };
        const px = v.px, pz = v.pz;
        // progress along the path
        let best = G.idx, bd = Infinity;
        for (let i = G.idx; i < Math.min(G.n, G.idx + 50); i++) { const d = Math.hypot(G.P[i * 3] - px, G.P[i * 3 + 2] - pz); if (d < bd) { bd = d; best = i; } }
        G.idx = best;
        if (bd > G.maxDev) { G.maxDev = bd; G.maxDevAt = `${E[G.route[G.edgeOf[best]]].name} (${Math.round(px)}, ${Math.round(pz)})`; }
        if (G.idx >= G.n - 3) { for (const key of keys) w.input.keys.delete(key); return { status: 'done' }; }
        const k = G.edgeOf[G.idx], eid = G.route[k], e = E[eid];
        // steering: pure pursuit on a point Ld ahead
        const sp = Math.max(0, v.speed);
        const Ld = 6 + 0.45 * sp;
        let li = G.idx; while (li < G.n - 1 && G.cum[li] - G.cum[G.idx] < Ld) li++;
        const tx = G.P[li * 3], tz = G.P[li * 3 + 2];
        const bearing = Math.atan2(tx - px, tz - pz);
        const alpha = Math.atan2(Math.sin(bearing - v.heading), Math.cos(bearing - v.heading));
        const wb = v.spec.wheelZFront - v.spec.wheelZRear;
        const want = Math.atan((2 * wb * Math.sin(alpha)) / Ld);
        // speed: road speed, curves ahead, red lights, stop signs, the circle, cars and people ahead
        let target = Math.min(e.speed, 14);
        for (let i = G.idx + 1; i < G.n - 4 && G.cum[i] - G.cum[G.idx] < 60; i++) {
          const a0 = Math.atan2(G.P[i * 3] - G.P[i * 3 - 3], G.P[i * 3 + 2] - G.P[i * 3 - 1]);
          let j = i; while (j < G.n - 1 && G.cum[j] - G.cum[i] < 8) j++;
          const a1 = Math.atan2(G.P[j * 3] - G.P[j * 3 - 3], G.P[j * 3 + 2] - G.P[j * 3 - 1]);
          const bend = Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)));
          if (bend < 0.05) continue;
          const vc = Math.sqrt(3.2 * Math.max(4, (G.cum[j] - G.cum[i]) / bend));
          target = Math.min(target, Math.sqrt(vc * vc + 2 * 3 * (G.cum[i] - G.cum[G.idx])));
        }
        const dStop = G.cum[G.stopIdx[k]] - G.cum[G.idx];
        const c = J.nodes[e.to];
        let hold = false;
        if (k < G.route.length - 1 && dStop < 70 && dStop > -0.5) { // (once over the line, carry on: holding in the box blocked the ring)
          if (c.kind === CTL.SIGNALS) {
            const L = J.light[eid];
            if (L === 2 || (L === 1 && dStop > (sp * sp) / 8 + 3)) hold = true;
          } else if (c.kind === CTL.STOP || c.kind === CTL.ALLWAY || (c.kind === CTL.PRIORITY && c.apRank[J.edgeAp[eid]] < c.majorRank)) {
            if (G.stoppedAt !== e.to) hold = true;
          } else if (c.kind === CTL.RING && !e.roundabout) {
            for (const o of w.traffic) { const d = window.__ocTraffic.ringDist(o, e.to); if (d < 34 && (d < 10 || d / Math.max(o.speed, 0.5) < 3.6)) hold = true; }
          }
        }
        // the next lane is too short to stop on (K St off Washington Circle, 2 m before a signal): stop for that
        // signal from here, as the AI cars do (they go round the ring again instead)
        if (!hold && k + 1 < G.route.length - 1 && J.shortLane[G.route[k + 1]] && J.nodes[E[G.route[k + 1]].to].kind === CTL.SIGNALS && J.light[G.route[k + 1]] !== 0) {
          const d2 = G.cum[G.stopIdx[k + 1]] - G.cum[G.idx];
          if (d2 < 70) { hold = true; target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, d2 - 3))); }
        }
        if (hold) target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, dStop - 3)));
        G.why = hold ? `hold at node ${e.to} (kind ${c.kind}) dStop ${dStop.toFixed(1)}` : '';
        // stop signs: a full second at the line, then the junction box must be clear
        if (hold && G.stoppedAt !== e.to && (c.kind === CTL.STOP || c.kind === CTL.ALLWAY || c.kind === CTL.PRIORITY) && dStop < 6 && sp < 0.4) {
          G.stopT += 1 / 60;
          const busy = w.traffic.some((o) => o.phase === 'turn' && !o.respawnWanted && E[o.edge].to === e.to && (o.speed > 0.5 || Math.hypot(o.px - px, o.pz - pz) < 15));
          if (G.stopT > 1 && !busy) { G.stoppedAt = e.to; G.stopT = 0; }
        }
        // anything ahead in our way
        const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
        const ahead = (ox, oy, oz, half, what, latMax = 2.4) => { const rx = ox - px, rz = oz - pz, al = rx * fx + rz * fz, lat = Math.abs(rx * fz - rz * fx); if (al > 0 && al < 45 && lat < latMax && Math.abs(oy - v.py) < 3) { const t = Math.max(0, (al - half - 5) * 0.7); if (t < target) { target = t; G.why = `${what} ${al.toFixed(1)} m ahead`; } } };
        for (const o of w.traffic) ahead(o.px, o.py, o.pz, o.halfL, `car ${o.id} (${o.phase}, hold ${o.hold})`);
        for (const o of w.police.cars) ahead(o.px, o.py, o.pz, o.halfL, 'police');
        // people: in the road only (AI traffic's band); a wider one stopped us for someone on the Key Bridge pavement
        for (const p of w.peds) if (p.active && !p.hidden && p.state !== 'down') ahead(p.pos.x, p.pos.y, p.pos.z, 0.5, `person ${p.id} (${p.state})`, 1.7);
        // keys
        for (const key of keys) w.input.keys.delete(key);
        if (want > v.steer + 0.01) w.input.keys.add('KeyA');
        else if (want < v.steer - 0.01) w.input.keys.add('KeyD');
        if (target < 0.3 && Math.abs(v.speed) < 1.5) w.input.keys.add('Space');
        else if (v.speed < target - 0.3) w.input.keys.add('KeyW');
        else if (v.speed > target + 0.8 && v.speed > 1.2) w.input.keys.add('KeyS');
        // our own red-light crossings
        if (G.lastK !== undefined && G.lastK !== k && J.nodes[E[G.route[G.lastK]].to].kind === CTL.SIGNALS && J.light[G.route[G.lastK]] === 2) G.playerRedRuns++;
        G.lastK = k;
        // one frame
        const fr = window.__ocFrames(1, false)[0];
        G.frames++;
        G.cpu.push(fr.cpu);
        if (fr.cpu > 33 && G.slow.length < 12) G.slow.push(`${fr.cpu.toFixed(0)} ms: ${fr.top}`);
        for (let s = 0; s < SEC.length; s++) G.sec[SEC[s]] = (G.sec[SEC[s]] ?? 0) + w.prof.cur[secIdx[s]];
        // independent check of every AI car's moves: lane -> next lane out of its junction, or a neighbour lane
        for (const car of w.traffic) {
          const l = G.last.get(car);
          if (!l) { G.last.set(car, [car.edge, car.respawns]); continue; }
          if (l[0] !== car.edge) {
            if (l[1] === car.respawns) {
              const a = E[l[0]];
              G.moves++;
              if (!N[a.to].out.includes(car.edge) && a.left !== car.edge && a.right !== car.edge) { G.illegal++; G.illegalWhere = `car ${car.id} ${a.name}#${a.id} -> ${E[car.edge].name}#${car.edge}`; }
            }
            l[0] = car.edge;
          }
          l[1] = car.respawns;
        }
        if (v.health < G.hpLast - 0.5 && G.dmg.length < 8) {
          // what hit us (or what we hit): the nearest AI car
          let near = null, nd = Infinity;
          for (const o of w.traffic.concat(w.police.cars)) { const d = Math.hypot(o.px - px, o.pz - pz); if (d < nd) { nd = d; near = o; } }
          G.dmg.push(`t ${(w.time - G.t0).toFixed(1)} -${(G.hpLast - v.health).toFixed(0)} hp at (${Math.round(px)}, ${Math.round(pz)}) on ${e.name} v ${(sp * 3.6).toFixed(0)} km/h; nearest ${near ? `${near.kind} ${near.id} ${near.phase} ${E[near.edge].name}#${near.edge} ${nd.toFixed(1)} m` : '-'}; ${G.why}`);
        }
        G.hpLast = v.health;
        if (sp < 0.3) G.stuckT += 1 / 60; else G.stuckT = 0;
        if (G.stuckT > 60) return { status: 'stuck', at: [Math.round(px), Math.round(pz)], edge: e.name, why: G.why, target: +target.toFixed(2), keys: [...w.input.keys].join(' '), speed: +v.speed.toFixed(2), steer: +v.steer.toFixed(2) };
        if (until) { const cp = until(G, v, e, k); if (cp && !G.seen[cp]) { G.seen[cp] = 1; return { status: 'checkpoint', name: cp }; } }
      }
      return { status: 'running' };
    };
    return { x: Math.round(x), y: +y.toFixed(1), z: Math.round(z), heading: +h.toFixed(2), inCar: !!w.player.vehicle };
  });
  const step = (n, until) => page.evaluate(([n, u]) => window.__gdStep(n, u ? new Function('G', 'v', 'e', 'k', u) : null), [n, until ?? null]);
  const pos = () => page.evaluate(() => { const v = window.__oc.player.vehicle, G = window.__gd; return { t: +(window.__oc.time - G.t0).toFixed(1), x: Math.round(v.px), y: +v.py.toFixed(1), z: Math.round(v.pz), kmh: Math.round(v.speed * 3.6), road: window.__oc.city.roads.edges[G.route[G.edgeOf[G.idx]]].name, donePct: +(G.cum[G.idx] / G.cum[G.n - 1] * 100).toFixed(1) }; });
  out.progress = [];
  // Key Bridge: a few seconds in, on the deck
  let r = await step(60 * 6);
  out.progress.push({ ...(await pos()), status: r.status });
  await frozenShot(page, 'screenshots/28-traffic-keybridge.png', null);
  // the rest, with three checkpoints for screenshots on the way: M St past Wisconsin Ave, standing at a red light, on the circle
  const until = [
    "if (/M St/.test(e.name || '') && v.px > -100) return 'mst';",
    "const J = window.__oc.junctions; if (J.nodes[e.to].kind === 1 && J.light[e.id] === 2 && v.speed < 0.3 && G.cum[G.stopIdx[k]] - G.cum[G.idx] < 12) return 'signals';",
    // the circle: on the ring with at least 4 AI cars round it (else on the last ring lane before the exit)
    "const E = window.__oc.city.roads.edges; if (k > 0 && E[G.route[k]].roundabout && G.cum[G.idx] - G.cum[G.stopIdx[k - 1]] > 10) { const ring = window.__oc.city.roads.nodes.filter((n) => n.roundabout); const cx = ring.reduce((s, n) => s + n.x, 0) / ring.length, cz = ring.reduce((s, n) => s + n.z, 0) / ring.length; const near = window.__oc.traffic.filter((o) => Math.hypot(o.px - cx, o.pz - cz) < 75).length; if (near >= 4 || !E[G.route[k + 1]].roundabout) return 'circle'; }",
    'return null;',
  ].join('\n');
  for (let k = 0; k < 60 && r.status !== 'done' && r.status !== 'stuck' && r.status !== 'out of car'; k++) {
    r = await step(60 * 30, until);
    if (r.status === 'checkpoint') {
      out.progress.push({ ...(await pos()), status: r.name });
      if (r.name === 'mst') await frozenShot(page, 'screenshots/28-traffic-mst.png', null);
      if (r.name === 'signals') {
        const cam = await page.evaluate(() => { const v = window.__oc.player.vehicle, h = v.heading; return { px: v.px - Math.sin(h) * 9 + Math.cos(h) * 3, py: 6, pz: v.pz - Math.cos(h) * 9 - Math.sin(h) * 3, lx: v.px + Math.sin(h) * 28, ly: 3.5, lz: v.pz + Math.cos(h) * 28 }; });
        await frozenShot(page, 'screenshots/28-traffic-signals.png', cam);
      }
      if (r.name === 'circle') {
        const cam = await page.evaluate(() => { const c = window.__oc.city, ring = c.roads.nodes.filter((n) => n.roundabout); const cx = ring.reduce((s, n) => s + n.x, 0) / ring.length, cz = ring.reduce((s, n) => s + n.z, 0) / ring.length; return { px: cx - 10, py: 60, pz: cz + 95, lx: cx, ly: 0, lz: cz }; });
        await frozenShot(page, 'screenshots/28-traffic-circle.png', cam);
      }
    } else if (k % 3 === 0) out.progress.push({ ...(await pos()), status: r.status });
  }
  out.progress.push({ ...(await pos()), status: r.status, why: r.at ? `${r.edge} at ${r.at}: ${r.why} target ${r.target} keys ${r.keys} v ${r.speed} steer ${r.steer}` : undefined });
  out.result = await page.evaluate((status) => {
    const w = window.__oc, G = window.__gd, st = w.trafficSim.stats, v = w.player.vehicle;
    const cpu = [...G.cpu].sort((a, b) => a - b);
    const q = (p) => +cpu[Math.min(cpu.length - 1, Math.floor(cpu.length * p))].toFixed(2);
    const per = (n) => +(G.sec[n] / G.frames).toFixed(3);
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space']) w.input.keys.delete(k);
    w.trafficSim.measure = false;
    return {
      completed: status === 'done', status, routeSeconds: +(w.time - G.t0).toFixed(1), routeMetres: Math.round(G.cum[G.n - 1]), maxOffPathM: +G.maxDev.toFixed(2), maxOffPathAt: G.maxDevAt,
      playerDamage: Math.round(G.hp0 - (v ? v.health : 0)), damageEvents: G.dmg, playerRedRuns: G.playerRedRuns,
      ai: {
        cars: w.traffic.length, wrongWayMoves: st.wrongWay, lastWrongWay: st.lastWrongWay, illegalLaneMoves: G.illegal, illegalWhere: G.illegalWhere, laneMovesChecked: G.moves,
        redLightRuns: st.redRuns, signalCrossings: st.signalCrossings, lastRedRun: st.lastRedRun,
        ringEntries: st.ringEntries, ringEntriesNotYielding: st.yieldFails, lastYieldFail: st.lastYieldFail, ringStops: st.ringStops, ringGoRound: st.ringGoRound,
        stuckOver20s: st.stuck, stuckOver20sAtRed: st.stuckAtRed, stuckWhere: st.stuckWhere, longestStillS: +st.stillMax.toFixed(1),
        maxOffLaneM: +st.offLaneMax.toFixed(2), offLaneWhere: st.offLaneWhere, carStepsOver2m: st.offLaneOver2, offLaneEvents: st.offLaneEvents,
        wrongLevel: st.wrongLevel, lastWrongLevel: st.lastWrongLevel, aiCollisions: st.aiContacts, lastContact: st.lastContact,
        laneChanges: st.laneChanges, laneChangeAborts: st.laneChangeAborts, recycled: st.recycled, respawned: st.respawned, leftMap: st.leftMap, clearedHeld: st.clearedHeld,
        contactWhere: st.contactWhere,
      },
      cpu: { frames: G.frames, medianMs: q(0.5), p99Ms: q(0.99), maxMs: q(1), over33ms: cpu.filter((x) => x > 33).length, slowFrames: G.slow, perFrameMs: { traffic: per('traffic'), policeDrive: per('police-drive'), police: per('police'), trafficCtl: per('traffic-ctl'), physics: per('physics'), peds: per('peds') } },
      f3SpikesWindow: w.prof.spikes(w.time),
      near: status === 'done' ? undefined : w.traffic.filter((o) => Math.hypot(o.px - v.px, o.pz - v.pz) < 60).map((o) => { const E = w.city.roads.edges, e = E[o.edge]; return `${o.id} ${o.phase} hold${o.hold} ${e.name}#${o.edge}->${o.next >= 0 ? E[o.next].name + '#' + o.next : -1} node${e.to} s${o.s.toFixed(1)}/${(e.len - e.trimEnd).toFixed(1)} v${o.speed.toFixed(1)} rw${o.respawnWanted ? 1 : 0} stuck${o.stuckT.toFixed(0)} (${o.px.toFixed(0)},${o.pz.toFixed(0)})`; }),
    };
  }, r.status);
  return out;
}
// Life on the streets (MAP=georgetown node scripts/shot.mjs x geolife): crowd density from the map. For each check the
// game clock is held at an hour, the player stands on a pavement, the crowd settles for `settle` game seconds, then the
// active people inside the same-size window (WINDOW m round the spot) are counted, with the F3 numbers (the density
// target, the real-world head count it comes from, the active count) and the computed people per metre there.
const WINDOW = 60;
async function crowdAt(page, place, hour, settle = 40) {
  return page.evaluate(([place, hour, settle, R]) => {
    const w = window.__oc, c = w.city, run = window.__ocRun;
    const p = typeof place === 'string' ? window.__mh.place(place) : place;
    const n = c.walk.nodes[c.nearestWalk(p.x, p.z, p.y ?? NaN)];
    if (w.player.vehicle) { w.input.pressed.add('KeyE'); run(0.3); }
    w.player.body.setTranslation({ x: n.x, y: n.y + 1.2, z: n.z }, true);
    w.dayNight.hour = hour;
    const c0 = { added: w.pedDensity.added, removed: w.pedDensity.removed, relocated: w.pedDensity.relocated };
    for (let t = 0; t < settle; t += 5) { w.dayNight.hour = hour; run(5); }
    w.dayNight.hour = hour;
    window.__ocDensity.update();
    const pd = w.pedDensity;
    const inWin = w.peds.filter((q) => q.active && !q.hidden && Math.hypot(q.pos.x - n.x, q.pos.z - n.z) < R);
    const arch = {};
    for (const q of inWin) arch[q.archetype] = (arch[q.archetype] || 0) + 1;
    const dens = window.__ocDensity.around(n.x, n.z, R);
    return {
      place: typeof place === 'string' ? place : `${Math.round(n.x)},${Math.round(n.z)}`, at: [Math.round(n.x), Math.round(n.z)], street: n.street, hour,
      inWindow: inWin.length, arch, f3: { target: pd.target, real: Math.round(pd.real), active: pd.active, near: pd.near, budget: w.settings.pedBudget },
      flow: { added: pd.added - c0.added, removed: pd.removed - c0.removed, relocated: pd.relocated - c0.relocated }, rings: [30, 60, 90, 140, 300, 1e9].map((r, i, a) => w.peds.filter((q) => q.active && Math.hypot(q.pos.x - n.x, q.pos.z - n.z) < r && Math.hypot(q.pos.x - n.x, q.pos.z - n.z) >= (i ? a[i - 1] : 0)).length), states: w.peds.filter((q) => q.active).reduce((o, q) => (o[q.state] = (o[q.state] || 0) + 1, o), {}),
      perMetre: +dens.perMetre.toFixed(4), metresPerPerson: dens.perMetre ? Math.round(1 / dens.perMetre) : null, pavementM: Math.round(dens.metres), shopsMax: dens.shops,
    };
  }, [place, hour, settle, WINDOW]);
}

export async function geolife(page, S) {
  await S.start(page);
  const out = {};
  // ---- 0) seeded items as placed at load (before any car or person moves them): none inside a building, in the
  // water, or at the edge of a deck (a drop of more than 0.5 m within 0.6 m) ----
  out.items = await page.evaluate(() => {
    const w = window.__oc, c = w.city, S = w.itemsState;
    let inBlocked = 0, inWater = 0, onEdge = 0, n = 0;
    const bad = [];
    for (const it of S.items) {
      if (!it.inWorld) continue;
      n++;
      const y = c.heightAt(it.px, it.pz, it.py);
      const blocked = c.isBlocked(it.px, it.pz), water = c.isWater(it.px, it.pz) && y < c.waterLevelAt(it.px, it.pz) + 0.3;
      let edge = false;
      for (const [ox, oz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) if (Math.abs(c.heightAt(it.px + ox, it.pz + oz, y + 0.5) - y) > 0.5) edge = true;
      if (blocked) inBlocked++;
      if (water) inWater++;
      if (edge) onEdge++;
      if ((blocked || water || edge) && bad.length < 8) bad.push(`${it.type}@${Math.round(it.px)},${Math.round(it.pz)}`);
    }
    const byType = {};
    for (const it of S.items) if (it.inWorld) byType[it.type] = (byType[it.type] ?? 0) + 1;
    return { items: n, byType, skippedAtLoad: S.skipped, inBlocked, inWater, nearDrop: onEdge, bad };
  });
  // ---- 1) crowds: M St at lunch vs 29th St at lunch; M St at night; the waterfront in the evening; the towpath early ----
  out.mstLunch = await crowdAt(page, 'M St at Wisconsin Ave', 12.5);
  await lifeShot(page, 'screenshots/29-life-mst-lunch.png', 'M St at Wisconsin Ave', false);
  await lifeShot(page, 'screenshots/29-life-f3.png', 'M St at Wisconsin Ave', true);
  out.st29Lunch = await crowdAt(page, '29th St between N and P', 12.5);
  await lifeShot(page, 'screenshots/29-life-29th.png', '29th St between N and P', false);
  out.mstNight = await crowdAt(page, 'M St at Wisconsin Ave', 2.5);
  out.waterfrontEvening = await crowdAt(page, 'waterfront', 19.5);
  const tow = await page.evaluate(() => {
    const W = window.__oc.city.walk.nodes;
    let best = null;
    for (const n of W) if (n.kind === 'towpath' && (!best || Math.hypot(n.x + 200, n.z - 230) < Math.hypot(best.x + 200, best.z - 230))) best = n;
    return best ? { x: best.x, z: best.z, y: best.y } : null;
  });
  if (tow) {
    out.towpathMorning = await crowdAt(page, tow, 7.5, 60);
    await lifeShot(page, 'screenshots/29-life-towpath.png', tow, false);
  }
  const share = (r) => { const t = Object.values(r.arch).reduce((a, b) => a + b, 0); return t ? +(((r.arch.jogger ?? 0) + (r.arch.dogwalker ?? 0)) / t).toFixed(2) : null; };
  out.dogsAndJoggersShare = { mstLunch: share(out.mstLunch), st29Lunch: share(out.st29Lunch), towpathMorning: tow ? share(out.towpathMorning) : null, waterfrontEvening: share(out.waterfrontEvening) };
  out.ratioLunch = out.st29Lunch.inWindow ? +(out.mstLunch.inWindow / out.st29Lunch.inWindow).toFixed(1) : null;
  out.ratioTargetLunch = +(out.mstLunch.f3.target / Math.max(1, out.st29Lunch.f3.target)).toFixed(1);

  // ---- 2) parked cars: counts by street class, and driving into one at speed (its stand-in is there in time) ----
  out.parked = await page.evaluate(() => {
    const w = window.__oc, c = w.city, P = w.parked, run = window.__ocRun;
    const kerbM = {}, cars = {};
    for (const s of c.parkingSpots) if (s.cls !== 'lot') kerbM[s.cls] = (kerbM[s.cls] ?? 0) + (s.span ?? 13);
    for (const r of P.cars) if (r.cls !== 'lot') cars[r.cls] = (cars[r.cls] ?? 0) + 1;
    const per100 = {};
    for (const k of Object.keys(kerbM)) per100[k] = +((cars[k] ?? 0) / kerbM[k] * 100).toFixed(1);
    const street = (name) => { let m = 0, n = 0; for (const s of c.parkingSpots) if (s.street === name) m += s.span ?? 13; for (const r of P.cars) if (r.street === name) n++; return m ? +(n / m * 100).toFixed(1) : null; };
    const lots = {};
    for (const s of c.parkingSpots) if (s.cls === 'lot') { lots[s.lot] ??= { bays: 0, cars: 0, at: [Math.round(s.x), Math.round(s.z)], waterfront: P.stats.waterfrontLots.includes(s.lot) }; lots[s.lot].bays++; }
    for (const r of P.cars) if (r.cls === 'lot' && lots[r.lot]) lots[r.lot].cars++;
    // drive into a parked car on M St from 40 m back along its parking lane at ~50 km/h
    const target = P.cars.find((r) => r.street === 'M St NW' && !r.v && !P.cars.some((o) => o !== r && o.street === r.street && Math.hypot(o.x - r.x, o.z - r.z) < 45 && ((o.x - r.x) * Math.sin(r.heading) + (o.z - r.z) * Math.cos(r.heading)) < 0));
    let crash = null;
    const mine = w.vehicles[0];
    if (target && mine) {
      if (w.player.vehicle) { w.input.pressed.add('KeyE'); run(0.3); }
      const fx = Math.sin(target.heading), fz = Math.cos(target.heading);
      const sx = target.x - fx * 40, sz = target.z - fz * 40;
      const t0 = mine.body.translation();
      window.__mh.put(w.player.body, t0.x + Math.cos(mine.heading) * 2.4, t0.z - Math.sin(mine.heading) * 2.4, 1.2);
      run(0.3); w.input.pressed.add('KeyE'); run(0.2);
      const q = { x: 0, y: Math.sin(target.heading / 2), z: 0, w: Math.cos(target.heading / 2) };
      mine.body.setTranslation({ x: sx, y: target.y + 1.0, z: sz }, true); mine.body.setRotation(q, true);
      mine.body.setLinvel({ x: fx * 14, y: 0, z: fz * 14 }, true); mine.body.setAngvel({ x: 0, y: 0, z: 0 }, true); mine.prevVel.set(fx * 14, 0, fz * 14);
      const standInAt = [];
      w.input.keys.add('KeyW');
      for (let k = 0; k < 40; k++) { run(0.1); if (target.v && !standInAt.length) standInAt.push(+(Math.hypot(mine.px - target.x, mine.pz - target.z)).toFixed(1)); }
      w.input.keys.delete('KeyW');
      run(1);
      const v = target.v;
      crash = {
        inCar: w.player.vehicle === mine, standInWhenCarWasM: standInAt[0] ?? null, standIn: v ? `${v.type} #${v.id}` : null,
        pushedM: v ? +Math.hypot(v.px - target.pos[0], v.pz - target.pos[2]).toFixed(2) : 0, dented: v ? +v.dmg.dentTotal.toFixed(2) : 0, ownMeshes: v ? v.mesh.visible : null,
        myDamage: Math.round(mine.maxHealth - mine.health),
      };
      mine.body.setLinvel({ x: 0, y: 0, z: 0 }, true); run(0.5); w.input.pressed.add('KeyE'); run(0.3);
    }
    return { total: P.stats.cars, kerb: P.stats.kerb, lot: P.stats.lot, byClass: P.stats.byClass, per100mKerbByClass: per100, mSt: street('M St NW'), wisconsin: street('Wisconsin Ave NW'), nSt: street('N St NW'), prospect: street('Prospect St NW'), st29: street('29th St NW'), lots, crash, pool: P.stats.pool, poolGrown: P.stats.poolGrown, vehicles: w.vehicles.length };
  });

  // ---- 3) three taxi fares between real places ----
  out.taxi = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    w.dayNight.hour = 14;
    const taxi = w.jobs.get('taxi');
    const v = w.vehicles[0];
    const t = v.body.translation();
    window.__mh.put(w.player.body, t.x + Math.cos(v.heading) * 2.4, t.z - Math.sin(v.heading) * 2.4, 1.2);
    run(0.3); w.input.pressed.add('KeyE'); run(0.1);
    const res = { inCar: w.player.vehicle === v, fares: [] };
    const tp = (x, z) => { window.__mh.put(v.body, x, z, 1.0); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true); v.prevVel.set(0, 0, 0); };
    for (let k = 0; k < 3; k++) {
      let guard = 0;
      while (taxi.phase !== 'waiting' && guard++ < 100) run(0.2);
      const startCash = w.cash;
      const pk = taxi.pickupName;
      tp(taxi.pickup.x, taxi.pickup.y); run(2.5);
      const boarded = taxi.phase;
      const hud = w.jobs.statusText().replace(/<[^>]+>/g, '');
      const d = taxi.dest;
      run(Math.max(5, (taxi.tripDist ?? 300) / 20));
      if (d) tp(d.curbX, d.curbZ);
      run(1.5);
      res.fares.push({ pickup: pk, boarded, dest: d ? `${d.name} [${d.kind}${d.cat ? ` ${d.cat}` : ''}]` : null, address: taxi.destAddress?.() ?? null, hud, paid: w.cash - startCash });
    }
    res.completed = taxi.completed;
    if (w.player.vehicle) { w.input.pressed.add('KeyE'); run(0.3); }
    return res;
  });

  // ---- 4) thefts: unseen on a quiet residential street; a locked car on M St in front of people ----
  out.theft = await theftRun(page, { quiet: 'residential', busy: 'M St NW', shots: false });

  // ---- 5) a dealership: the showrooms, buying a car, the minimap ----
  out.dealer = await page.evaluate(() => {
    const w = window.__oc, run = window.__ocRun;
    w.dayNight.hour = 13;
    if (w.player.vehicle) { w.player.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true); run(0.3); w.input.pressed.add('KeyE'); run(0.3); }
    w.police.heat = 0; w.police.stars = 0; w.police.seen = false; // the theft's stars: a clean slate for shopping
    run(1);
    const job = w.jobs.get('dealership');
    const sites = job.sites.map((s) => ({ name: s.name, poi: `${w.city.pois[s.poiId].kind}${w.city.pois[s.poiId].cat ? ` ${w.city.pois[s.poiId].cat}` : ''}`, street: w.city.pois[s.poiId].street, showroom: s.showroom, at: [Math.round(s.x), Math.round(s.z)], cars: s.slots.filter((q) => q.car).map((q) => `${q.type} $${q.car.forSale.price}`) }));
    const site = job.sites[0];
    const slot = site.slots.find((s) => s.car);
    const v = slot.car;
    const ch = Math.cos(v.heading), sh = Math.sin(v.heading), kx = -ch, kz = sh;
    window.__mh.put(w.player.body, v.px + kx * 2.0, v.pz + kz * 2.0, 1.2);
    w.player.facing = Math.atan2(-kx, -kz);
    w.cash = 5000; w.hud.shownCash = 5000;
    run(0.4);
    const prompt = w.player.prompt.replace(/<[^>]+>/g, ' ');
    const player = { inCar: !!w.player.vehicle, dead: w.player.dead, knockT: w.player.knockT, toCar: +Math.hypot(w.player.mesh.position.x - v.px, w.player.mesh.position.z - v.pz).toFixed(1) };
    const vehicles0 = w.vehicles.length;
    w.input.pressed.add('KeyE'); run(0.2);
    const bought = { owned: v.owned, forSale: !!v.forSale, paid: 5000 - w.cash };
    window.__ocFrames(3, true);
    const minimap = { ownedCars: window.__ocMinimap.ownedCars, dealerships: window.__ocMinimap.dealerships };
    // drive it off the showroom (the bought car keeps the slot until it leaves); the slot restocks later out of the
    // parked-car pool, so the car list does not grow
    w.input.pressed.add('KeyE'); run(0.3);
    const drove = { inCar: w.player.vehicle === v, from: [v.px, v.pz] };
    w.input.keys.add('KeyW'); run(1.6); w.input.keys.delete('KeyW'); run(2);
    drove.metres = Math.round(Math.hypot(v.px - drove.from[0], v.pz - drove.from[1]));
    if (w.player.vehicle) { v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); run(0.4); w.input.pressed.add('KeyE'); run(0.3); }
    if (Math.hypot(v.px - slot.x, v.pz - slot.z) < 6) { window.__mh.put(v.body, slot.x + Math.sin(slot.heading) * 25, slot.z + Math.cos(slot.heading) * 25, 1); run(0.5); } // in case it got stuck
    const slotIdx = site.slots.indexOf(slot);
    slot.soldAt = w.time - 10000;
    window.__mh.put(w.player.body, site.x + 300, site.z, 1.2); run(1.2);
    const restocked = !!site.slots[slotIdx].car;
    window.__mh.put(w.player.body, v.px + kx * 2.0, v.pz + kz * 2.0, 1.2); run(0.4);
    // picture: from across the showroom row
    const sx = (site.slots[0].x + site.slots[site.slots.length - 1].x) / 2, sz = (site.slots[0].z + site.slots[site.slots.length - 1].z) / 2;
    const fx = Math.sin(site.slots[0].heading), fz = Math.cos(site.slots[0].heading);
    window.__Dcam = { px: sx + fx * 16 + kx * 3, py: 5, pz: sz + fz * 16 + kz * 3, lx: sx, ly: 1.2, lz: sz };
    return { sites, car: `${v.type} #${v.id}`, player, prompt, bought, minimap, drove, restocked, vehiclesBefore: vehicles0, vehiclesAfter: w.vehicles.length, pool: w.parked.stats.pool };
  });
  await frozenShot(page, 'screenshots/29-life-dealer.png', await page.evaluate(() => window.__Dcam));

  return out;
}

/** Camera above and behind a place on the pavement, looking along its street (F3 overlay on if `f3`). */
async function lifeShot(page, path, place, f3) {
  const cam = await page.evaluate(([place, f3]) => {
    const w = window.__oc, c = w.city;
    const p = typeof place === 'string' ? window.__mh.place(place) : place;
    const n = c.walk.nodes[c.nearestWalk(p.x, p.z, p.y ?? NaN)];
    // along the street (a named place: its lane's direction, from above the kerb), else along a walk link
    let dx = 1, dz = 0, ox = p.x, oz = p.z;
    if (typeof place === 'string' && p.edge >= 0) { dx = Math.sin(p.heading); dz = Math.cos(p.heading); ox = p.x - Math.cos(p.heading) * 4; oz = p.z + Math.sin(p.heading) * 4; }
    else if (n.nbrs.length) { const m = c.walk.nodes[n.nbrs[0]]; const l = Math.hypot(m.x - n.x, m.z - n.z) || 1; dx = (m.x - n.x) / l; dz = (m.z - n.z) / l; ox = n.x; oz = n.z; }
    w.debugVisible = f3;
    return { px: ox - dx * 14, py: 4.5, pz: oz - dz * 14, lx: ox + dx * 30, ly: 1.0, lz: oz + dz * 30 };
  }, [place, f3]);
  await frozenShot(page, path, cam);
  await page.evaluate(() => { window.__oc.debugVisible = false; });
}

// Parked cars (any map: MAP=<id> node scripts/shot.mjs x parkcheck): how many by street class, cars per 100 m of kerb on
// M St, a residential street and in the car parks; then walking and driving along a street: the drivable stand-ins
// near you, the pool, draw calls, and E on the nearest parked car.
export async function parkcheck(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, c = w.city, P = w.parked, run = window.__ocRun;
    const st = P.stats;
    // cars per 100 m of kerb along named streets (kerb length = parking spots x their span)
    const perStreet = {};
    for (const s of c.parkingSpots) {
      if (s.cls === 'lot') continue;
      const k = s.street ?? '?';
      perStreet[k] ??= { kerbM: 0, cars: 0, cls: s.cls };
      perStreet[k].kerbM += s.span ?? 13;
    }
    for (const r of P.cars) if (r.cls !== 'lot') { const k = r.street ?? '?'; if (perStreet[k]) perStreet[k].cars++; }
    const per100 = Object.entries(perStreet).filter(([, v]) => v.kerbM > 150).map(([k, v]) => [k, v.cls, Math.round(v.kerbM), +(v.cars / v.kerbM * 100).toFixed(1)]).sort((a, b) => b[3] - a[3]);
    const lots = {};
    for (const s of c.parkingSpots) if (s.cls === 'lot') { lots[s.lot] ??= { bays: 0, cars: 0, x: Math.round(s.x), z: Math.round(s.z) }; lots[s.lot].bays++; }
    for (const r of P.cars) if (r.cls === 'lot' && lots[r.lot]) lots[r.lot].cars++;
    // walk to M St, see stand-ins and draw calls
    const spot = window.__mh.place('M St at Wisconsin Ave');
    const n = c.walk.nodes[c.nearestWalk(spot.x, spot.z, spot.y)];
    w.player.body.setTranslation({ x: n.x, y: n.y + 1.2, z: n.z }, true);
    run(1);
    const f = window.__ocFrames(3, true);
    const atMst = { live: w.vehicles.filter((v) => v.pooled && !v.idle).length, pool: P.stats.pool, drawn: P.stats.drawn, calls: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles, vehicles: w.vehicles.length };
    // the nearest parked car has a drivable stand-in; E works on it
    let best = null, bd = 1e9;
    for (const r of P.cars) { const d = Math.hypot(r.x - n.x, r.z - n.z); if (d < bd) { bd = d; best = r; } }
    const ch = Math.cos(best.heading), sh = Math.sin(best.heading);
    w.player.body.setTranslation({ x: best.x - ch * 2.0, y: best.y + 1.4, z: best.z + sh * 2.0 }, true);
    run(0.5);
    const v = best.v;
    const prompt = w.player.prompt.replace(/<[^>]+>/g, '');
    return { stats: { cars: st.cars, kerb: st.kerb, lot: st.lot, byClass: st.byClass, poolGrown: st.poolGrown }, per100: per100.slice(0, 14), lots, atMst, nearest: { dist: Math.round(bd), street: best.street, standIn: v ? `${v.type} #${v.id}` : null, prompt, locked: best.locked, owner: best.owner, local: best.ownerLocal } };
  });
}

// Look screenshots from the game itself (cars, people, weather, the chosen quality). URL params (through the seed
// argument: `1337&lookview=mst&lookhour=21.6&weather=rain&quality=low`): lookview (a street view below), lookhour,
// lookout (file name, default screenshots/33-look-game.png). Renders single frames with the camera fixed at the view
// (software GL is slow: the animation loop is held while the shot is taken), writes the canvas as PNG, then restores.
export async function lookgame(page, S) {
  await S.start(page);
  const res = await page.evaluate(() => {
    const w = window.__oc, q = new URLSearchParams(location.search);
    // x, height above ground, z (camera), look-at x, height above ground, z, default hour
    const V = {
      mst: [-262, 1.8, 158.4, -120, 4.5, 154.5, 15.5],
      rowhouses: [12, 1.8, -9.6, 160, 3.0, -11.6, 9.5],
      waterfront: [-140, 26, 640, 60, 2, 470, 17.5],
      grid: [16, 2.2, -200, 16, 3, -120, 15.5],
    };
    const name = q.get('lookview') ?? (w.city.id === 'grid' ? 'grid' : 'mst');
    const v = V[name];
    w.dayNight.hour = Number(q.get('lookhour') ?? v[6]);
    if (name !== 'grid') window.__mh.put(w.player.body, v[0] + 1.5, v[2] + 1.5, 1.2);
    window.__ocRun(1.5);
    const gy = (x, z) => w.city.heightAt(x, z);
    // the grid city: the normal chase camera behind you at the spawn; the real maps: the fixed street view
    if (name === 'grid') { w.cam.override = null; window.__ocRun(1); }
    else w.cam.override = { px: v[0], py: gy(v[0], v[2]) + v[1], pz: v[2], lx: v[3], ly: gy(v[3], v[5]) + v[4], lz: v[5] };
    window.__ocFrames(2, true);
    // hold the animation loop's own rendering while capturing
    const r = w.renderer, orig = r.render.bind(r);
    window.__lookOrig = orig;
    r.render = () => {};
    const t0 = performance.now();
    orig(w.scene, w.camera);
    const url = r.domElement.toDataURL('image/png');
    return { name, hour: w.dayNight.hour, quality: w.settings.quality, weather: w.weather.kind, wet: +w.look.uniforms.uWet.value.toFixed(2), calls: r.info.render.calls, tris: r.info.render.triangles, frameMs: Math.round(performance.now() - t0), url, out: q.get('lookout') };
  });
  const { writeFileSync } = await import('node:fs');
  const file = res.out ? `screenshots/${res.out}.png` : 'screenshots/33-look-game.png';
  writeFileSync(file, Buffer.from(res.url.split(',')[1], 'base64'));
  await page.evaluate(() => { const w = window.__oc; w.renderer.render = window.__lookOrig; w.cam.override = null; });
  delete res.url;
  return { ...res, file };
}

// Shader compile stalls: after the boot warm-up, visiting the map by day, at night and in the rain must not compile a
// single new program (a first-time compile mid-game is a frame spike). Renders two frames per stop.
export async function lookstall(page, S) {
  await S.start(page);
  return page.evaluate(() => {
    const w = window.__oc, r = w.renderer;
    const stops = w.city.id === 'grid'
      ? [[16, -200], [200, -100], [-200, 50], [0, 60], [300, 200]]
      : [[-240, 160], [-760, 200], [-140, 520], [60, -10], [900, 440], [-400, 240], [300, 120]];
    const programs0 = r.info.programs.length;
    const log = [];
    const visit = (label) => {
      for (const [x, z] of stops) {
        window.__mh.put(w.player.body, x, z, 1.2);
        window.__ocFrames(2, true);
      }
      log.push({ label, programs: r.info.programs.length });
    };
    w.dayNight.hour = 13; visit('day');
    w.dayNight.hour = 22; visit('night');
    w.weather.kind = 'rain'; w.weather.look.wet = 1; w.weather.look.rain = 0.8; w.weather.look.cloud = 0.8; visit('rain');
    return { programs0, log, newPrograms: r.info.programs.length - programs0, envRefreshes: w.dayNight.env.refreshes };
  });
}
