// Scenarios for building interiors (systems/interiors/): keyboard walks into the Stage C house and shop, doors from
// both sides, stairs, items and the save. Re-exported by scenarios.mjs, run with scripts/shot.mjs like the others.
//
// Movement is keyboard only: W / Shift held, A / D held to turn toward the next waypoint (tank controls, as a player
// steers), E pressed at doors, through the real game loop one 60 Hz frame at a time (window.__ocRun). The one teleport
// is the start spot on the pavement in front of the building.

const HOUSE = 'geo:b23e0ce279d85';
const SHOP = 'geo:be01bab3a0eeb';

/** Page helpers (installed as window.__ih). */
export function installInteriorHelpers() {
  const w = window.__oc, P = w.player, R = w.R;
  const hh = P.collider.halfHeight(), rad = P.collider.radius();
  const H = {};
  const STATIC = (0xffff << 16) | 1;
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const KINDS = window.__ocKinds ?? [];
  H.kindOf = (c) => { const k = w.city.solidTags.get(c.handle); return KINDS[k] ?? `#${k}`; };
  H.floor = (x, y, z, max = 40) => {
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z; ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const h = w.physics.castRay(ray, max, true, undefined, STATIC);
    return h ? { y: y - h.timeOfImpact, kind: H.kindOf(h.collider) } : null;
  };
  H.feet = () => P.body.translation().y - hh - rad;
  H.pos = () => { const t = P.body.translation(); return { x: t.x, y: t.y, z: t.z }; };
  H.entry = (id) => w.interiors.byId.get(id);
  H.frame = (n = 1) => window.__ocRun(n / 60, 60);
  /** The only teleport: stand at (x, z) on whatever is under it, facing `facing`. */
  H.put = (x, z, facing, from) => {
    const f = H.floor(x, from, z, 60);
    const y = (f ? f.y : w.city.heightAt(x, z)) + hh + rad + 0.03;
    P.body.setTranslation({ x, y, z }, true);
    P.body.setNextKinematicTranslation({ x, y, z });
    P.vy = 0; P.facing = facing; P.knockT = 0;
    w.input.keys.clear();
    w.cam.yaw = facing + Math.PI;
    H.frame(20);
    return H.feet();
  };
  /** Collisions of the character controller in the last step, by kind. */
  H.hits = () => {
    const out = [];
    for (let i = 0, n = P.cc.numComputedCollisions(); i < n; i++) { const c = P.cc.computedCollision(i); if (c?.collider) out.push(H.kindOf(c.collider)); }
    return out;
  };
  /** Hold keys for up to `sec` seconds; onFrame(t, pos, feet) returning false stops. Tracks feet below the floor. */
  H.hold = (keys, sec, onFrame) => {
    for (const k of keys) w.input.keys.add(k);
    const frames = Math.round(sec * 60);
    let pen = -Infinity, i = 0;
    const kinds = {};
    for (; i < frames; i++) {
      H.frame(1);
      const t = H.pos(), fy = t.y - hh - rad;
      const f = H.floor(t.x, fy + 0.5, t.z, 3);
      if (f) pen = Math.max(pen, f.y - fy);
      for (const k of H.hits()) kinds[k] = (kinds[k] ?? 0) + 1;
      if (onFrame && onFrame(i / 60, t, fy) === false) { i++; break; }
    }
    for (const k of keys) w.input.keys.delete(k);
    return { pen: +pen.toFixed(3), seconds: +(i / 60).toFixed(2), kinds };
  };
  H.press = (key) => { w.input.pressed.add(key); H.frame(1); };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  /**
   * Walk to (x, z) with the keyboard: A / D held to turn toward it (released when facing it), W held while roughly
   * facing it. Returns when within `tol` m, or after `sec`. Records collisions by kind and the deepest penetration.
   */
  H.walkTo = (x, z, opt = {}) => {
    const tol = opt.tol ?? 0.3, sec = opt.sec ?? 12, run = !!opt.run;
    let pen = -Infinity, frames = 0, reached = false, stuck = 0;
    const kinds = {};
    let last = H.pos();
    for (; frames < sec * 60; frames++) {
      const t = H.pos();
      const dx = x - t.x, dz = z - t.z, d = Math.hypot(dx, dz);
      if (d < tol) { reached = true; break; }
      const want = Math.atan2(dx, dz), diff = wrap(want - P.facing);
      w.input.keys.delete('KeyA'); w.input.keys.delete('KeyD'); w.input.keys.delete('KeyW'); w.input.keys.delete('ShiftLeft');
      if (Math.abs(diff) > 0.04) w.input.keys.add(diff > 0 ? 'KeyA' : 'KeyD');
      if (Math.abs(diff) < 0.5) { w.input.keys.add('KeyW'); if (run) w.input.keys.add('ShiftLeft'); }
      H.frame(1);
      const n = H.pos(), fy = n.y - hh - rad;
      const f = H.floor(n.x, fy + 0.5, n.z, 3);
      if (f) pen = Math.max(pen, f.y - fy);
      for (const k of H.hits()) kinds[k] = (kinds[k] ?? 0) + 1;
      if (Math.hypot(n.x - last.x, n.z - last.z) < 0.002 && Math.abs(diff) < 0.5) stuck++; else stuck = 0;
      last = n;
      if (stuck > 90) break; // pressing against something for 1.5 s: report where it stopped
    }
    for (const k of ['KeyA', 'KeyD', 'KeyW', 'ShiftLeft']) w.input.keys.delete(k);
    const e = H.pos();
    return { reached, at: [+e.x.toFixed(2), +H.feet().toFixed(2), +e.z.toFixed(2)], left: +Math.hypot(x - e.x, z - e.z).toFixed(2), seconds: +(frames / 60).toFixed(2), pen: +pen.toFixed(3), kinds, stuck: stuck > 90 };
  };
  /** Turn (A / D held) to face a direction. */
  H.face = (to) => {
    for (let i = 0; i < 240; i++) {
      const diff = wrap(to - P.facing);
      if (Math.abs(diff) < 0.04) break;
      w.input.keys.add(diff > 0 ? 'KeyA' : 'KeyD');
      H.frame(1);
      w.input.keys.delete('KeyA'); w.input.keys.delete('KeyD');
    }
  };
  H.door = (id) => w.doors.byId.get(id);
  H.prompt = () => P.prompt;
  window.__ih = H;
}

/** Look around the two pilot buildings: records, plans, the doorway's colliders before and after activation. */
export async function interiorprobe(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installInteriorHelpers);
  const out = await page.evaluate(([HOUSE, SHOP]) => {
    const w = window.__oc, H = window.__ih;
    const res = { spawn: w.city.spawn, recs: [], summary0: window.__ocInteriors.summary() };
    for (const id of [HOUSE, SHOP]) {
      const rec = w.city.buildingRecords.find((r) => r.id === id);
      if (!rec) { res.recs.push({ id, missing: true }); continue; }
      const pl = rec.plan;
      res.recs.push({
        id, template: rec.template, door: rec.door && { x: +rec.door.x.toFixed(2), z: +rec.door.z.toFixed(2), sill: +rec.door.sill.toFixed(2), nx: +rec.door.nx.toFixed(3), nz: +rec.door.nz.toFixed(3), w: rec.door.width, style: rec.door.style },
        planErrors: rec.planErrors, levels: rec.storeys.map((y) => +y.toFixed(2)), yTop: +rec.yTop.toFixed(2), pts: rec.pts.length, core: rec.core.length,
        plan: pl && { rooms: pl.rooms.map((r) => r.id), doors: pl.doors.map((d) => d.id), stairs: pl.stairs.length, furniture: pl.furniture.length, lights: pl.lights.length, notes: pl.notes, errors: pl.errors },
        spawnDist: rec.door ? +Math.hypot(rec.door.x - w.city.spawn.x, rec.door.z - w.city.spawn.z).toFixed(1) : null,
      });
    }
    // stand on the pavement 6 m in front of the house door, run 3 s: the interior should be built
    const rec = w.city.buildingRecords.find((r) => r.id === HOUSE);
    const d = rec.door;
    H.put(d.x + d.nx * 6, d.z + d.nz * 6, Math.atan2(-d.nx, -d.nz), d.sill + 4);
    H.frame(180);
    res.summary1 = window.__ocInteriors.summary();
    return res;
  }, [HOUSE, SHOP]);
  return out;
}

/** Footprint, walls and the planned door of one building (BID=<record id>). */
export async function buildingprobe(page) {
  const id = process.env.BID ?? SHOP;
  return page.evaluate((id) => {
    const w = window.__oc;
    const rec = w.city.buildingRecords.find((r) => r.id === id);
    if (!rec) return { id, missing: true };
    const f2 = (v) => +v.toFixed(2);
    return {
      id, type: rec.type, cats: rec.cats, template: rec.template, planErrors: rec.planErrors, front: rec.front,
      pts: rec.pts.map((p) => [f2(p[0]), f2(p[1])]),
      walls: rec.walls.map((x) => ({ a: [f2(x.ax), f2(x.az)], b: [f2(x.bx), f2(x.bz)], len: f2(x.len), n: [f2(x.nx), f2(x.nz)], party: x.party, street: x.street, front: x.front })),
      storeys: rec.storeys.map(f2), y0: f2(rec.y0), yTop: f2(rec.yTop),
    };
  }, id);
}

/** Debug: climb flight 0 of a building (BID) from its foot (teleport inside: a probe, not a test), log every frame. */
export async function climbprobe(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installInteriorHelpers);
  const id = process.env.BID ?? HOUSE;
  return page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, P = w.player;
    const e = w.interiors.byId.get(id), d = e.front.pd;
    H.put(d.x - d.nx * 6, d.z - d.nz * 6, 0, d.y + 3);
    H.frame(30);
    const st = e.plan.stairs[0];
    H.put(st.x - st.dx * 0.6, st.z - st.dz * 0.6, Math.atan2(st.dx, st.dz), st.y + 1.5);
    const rows = [];
    w.input.keys.add('KeyW');
    for (let i = 0; i < 150; i++) {
      H.frame(1);
      const t = H.pos();
      const a = (t.x - st.x) * st.dx + (t.z - st.z) * st.dz, c = (t.x - st.x) * st.dz - (t.z - st.z) * st.dx;
      const r = st.rise / st.steps, tt = st.run / (st.steps - 1);
      if (i % 6 === 0) rows.push([i, +a.toFixed(2), +c.toFixed(2), +(H.feet() - st.y).toFixed(2), +Math.min(st.rise, r * (Math.max(0, a) / tt + 0.5)).toFixed(2), P.grounded ? 'g' : 'air', H.hits().join(',')]);
    }
    w.input.keys.delete('KeyW');
    return { st: { x: st.x, z: st.z, dx: st.dx, dz: st.dz, run: st.run, rise: st.rise, w: st.width }, rows };
  }, id);
}

/** Debug: in through the front door, then back out, logging contacts (kind, collider centre, normal) every few frames. */
export async function doorprobe(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installInteriorHelpers);
  const id = process.env.BID ?? HOUSE;
  return page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, P = w.player;
    const e = w.interiors.byId.get(id), d = e.front.pd;
    H.put(d.x - d.nx * 3, d.z - d.nz * 3, Math.atan2(d.nx, d.nz), d.y + 3);
    H.frame(30);
    H.walkTo(d.x - d.nx * 0.6, d.z - d.nz * 0.6, { tol: 0.1 });
    H.press('KeyE'); H.frame(50);
    const log = [];
    const contacts = () => {
      const out = [];
      for (let i = 0, n = P.cc.numComputedCollisions(); i < n; i++) {
        const c = P.cc.computedCollision(i);
        if (!c?.collider) continue;
        const t = c.collider.translation();
        out.push(`${H.kindOf(c.collider)}@${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)} n=${c.normal1.x.toFixed(2)},${c.normal1.y.toFixed(2)},${c.normal1.z.toFixed(2)}`);
      }
      return out.join(' | ');
    };
    for (const [tag, k] of [['in', 1.4], ['out', -1.2]]) {
      const tx = d.x + d.nx * k, tz = d.z + d.nz * k;
      for (let i = 0; i < 150; i++) {
        const t = H.pos();
        if (Math.hypot(tx - t.x, tz - t.z) < 0.15) break;
        const want = Math.atan2(tx - t.x, tz - t.z);
        P.facing = want; // probe only: face the target directly
        w.input.keys.add('KeyW');
        H.frame(1);
        w.input.keys.delete('KeyW');
        if (i % 5 === 0) { const p = H.pos(); log.push(`${tag} ${i} p=${p.x.toFixed(2)},${H.feet().toFixed(2)},${p.z.toFixed(2)} ${contacts()}`); }
      }
    }
    // as the test does it: stand 1.3 m inside, face the door with A / D, E (close), then hold W
    H.walkTo(d.x + d.nx * 1.3, d.z + d.nz * 1.3, { tol: 0.25 });
    H.face(Math.atan2(-d.nx, -d.nz));
    log.push(`stand p=${JSON.stringify(H.pos())} facing=${P.facing.toFixed(2)} want=${Math.atan2(-d.nx, -d.nz).toFixed(2)} prompt=${P.prompt}`);
    H.press('KeyE');
    for (let i = 0; i < 70; i++) { H.frame(1); if (i % 10 === 0) log.push(`close ${i} angle=${e.front.angle.toFixed(2)} target=${e.front.target.toFixed(2)} waited=${e.front.waited.toFixed(2)}`); }
    w.input.keys.add('KeyW');
    for (let i = 0; i < 60; i++) { H.frame(1); if (i % 6 === 0) { const p = H.pos(); log.push(`push ${i} p=${p.x.toFixed(2)},${H.feet().toFixed(2)},${p.z.toFixed(2)} f=${P.facing.toFixed(2)} ${contacts()}`); } }
    w.input.keys.delete('KeyW');
    return { door: { x: d.x, z: d.z, nx: d.nx, nz: d.nz, ux: d.ux, uz: d.uz, w: d.width, y: d.y }, front: { open: e.front.open, angle: e.front.angle }, log };
  }, id);
}

/** Headroom over every flight of a building (BID): what a standing player's capsule touches along each flight. */
export async function stairprobe(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installInteriorHelpers);
  const id = process.env.BID ?? HOUSE;
  return page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, R = w.R;
    const e = w.interiors.byId.get(id), d = e.front.pd;
    H.put(d.x - d.nx * 6, d.z - d.nz * 6, 0, d.y + 3);
    H.frame(30);
    const cap = new R.Capsule(0.55, 0.35);
    const out = { state: e.state, stairs: [] };
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    for (const st of e.plan.stairs) {
      const t = st.run / (st.steps - 1), r = st.rise / st.steps;
      const rows = [];
      for (let a = -0.4; a <= st.run + 0.6; a += 0.3) {
        const ramp = Math.min(st.rise, r * (Math.max(0, a) / t + 0.5));
        const x = st.x + st.dx * a, z = st.z + st.dz * a, y = st.y + ramp;
        ray.origin.x = x; ray.origin.y = y + 0.05; ray.origin.z = z;
        const h = w.physics.castRay(ray, 4, true);
        const kinds = [];
        w.physics.intersectionsWithShape({ x, y: y + 0.04 + 0.9, z }, { x: 0, y: 0, z: 0, w: 1 }, cap, (c) => { kinds.push(H.kindOf(c)); return true; });
        rows.push({ a: +a.toFixed(2), ramp: +ramp.toFixed(2), up: h ? +h.timeOfImpact.toFixed(2) : null, upKind: h ? H.kindOf(h.collider) : null, capsule: kinds.join(',') });
      }
      out.stairs.push({ level: st.level, y: st.y, rise: st.rise, run: st.run, steps: st.steps, solid: st.solid, width: st.width, rows });
    }
    out.holes = e.plan.holes.map((h) => ({ level: h.level, poly: h.poly.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) }));
    return out;
  }, id);
}
