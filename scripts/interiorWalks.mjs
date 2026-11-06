// Keyboard walks through the Stage C house and shop (systems/interiors/), re-exported by scenarios.mjs. The routes
// come from the interior's own plan (rooms, doorways, inner doors, stairs as a graph), and every metre of them is
// walked with held keys through the real game loop (window.__ih.walkTo: A / D to turn toward the next waypoint, W to
// walk, E at doors). The only teleport is the start spot on the pavement.
import { installInteriorHelpers } from './interiorScenarios.mjs';

const HOUSE = 'geo:b23e0ce279d85';
const SHOP = 'geo:be01bab3a0eeb';

/** Route helpers over an interior plan (window.__ir). */
function installRouteHelpers() {
  const w = window.__oc, H = window.__ih, P = w.player;
  const R = {};
  const pointIn = (x, z, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const edgeDist = (x, z, poly) => {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j][0], az = poly[j][1], dx = poly[i][0] - ax, dz = poly[i][1] - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    return best;
  };
  R.pointIn = pointIn;
  R.plan = (id) => w.interiors.byId.get(id).plan;
  R.roomAt = (plan, level, x, z) => plan.rooms.find((r) => r.level === level && pointIn(x, z, r.poly)) ?? null;
  /** Solid furniture rectangles (world) on a level, grown by g. */
  R.blocks = (plan, level, g) => plan.furniture.filter((f) => f.level === level && window.__ocFurn[f.def]?.solid).map((f) => {
    const d = window.__ocFurn[f.def], ax = f.fz, az = -f.fx, hw = d.w / 2 + g, hd = d.d / 2 + g;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [f.x + ax * a * hw + f.fx * b * hd, f.z + az * a * hw + f.fz * b * hd]);
  });
  /** The most open spot of a room (furthest from its walls and its solid furniture). */
  R.free = (plan, room) => {
    const xs = room.poly.map((p) => p[0]), zs = room.poly.map((p) => p[1]);
    const bl = R.blocks(plan, room.level, 0);
    let best = null, bs = -1;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.15) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.15) {
      if (!pointIn(x, z, room.poly)) continue;
      let s = edgeDist(x, z, room.poly);
      for (const b of bl) s = Math.min(s, pointIn(x, z, b) ? -1 : edgeDist(x, z, b));
      for (const st of plan.stairs) if (st.level === room.level || st.level + 1 === room.level) {
        const dx = x - st.x, dz = z - st.z, a = dx * st.dx + dz * st.dz, c = dx * st.dz - dz * st.dx;
        if (a > -0.3 && a < st.run + 0.3 && Math.abs(c) < st.width / 2 + 0.3) s = -1;
      }
      if (s > bs) { bs = s; best = [x, z]; }
    }
    return { x: best[0], z: best[1], clear: +bs.toFixed(2) };
  };
  /** Leaf segments of the open inner doors on a level (they stick out into a room). */
  const leaves = (plan, level) => {
    const out = [];
    for (const d of w.doors.list) {
      if (d.building !== plan.id || d.pd.level !== level || d.pd.front || d.hidden || d.angle < 0.05) continue;
      const pd = d.pd, hw = pd.width / 2;
      const hx = pd.x + pd.ux * pd.hinge * hw + pd.nx * pd.depth, hz = pd.z + pd.uz * pd.hinge * hw + pd.nz * pd.depth;
      const e0x = -pd.ux * pd.hinge, e0z = -pd.uz * pd.hinge, c = Math.cos(d.angle), s = Math.sin(d.angle) * d.side;
      const ex = e0x * c + pd.nx * s, ez = e0z * c + pd.nz * s;
      out.push([hx, hz, hx + ex * pd.width, hz + ez * pd.width]);
    }
    return out;
  };
  const segDist = (x, z, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    return Math.hypot(ax + dx * t - x, az + dz * t - z);
  };
  /** Walls of a level as segments (solid parts of the partitions; openings left out) with their half thickness. */
  const walls = (plan, level) => {
    const out = [];
    for (const p of plan.partitions) {
      if (p.level !== level) continue;
      const L = Math.hypot(p.bx - p.ax, p.bz - p.az), ux = (p.bx - p.ax) / L, uz = (p.bz - p.az) / L;
      let s = 0;
      for (const o of [...p.openings].sort((a, b) => a.s0 - b.s0)) {
        if (o.s0 > s) out.push([p.ax + ux * s, p.az + uz * s, p.ax + ux * o.s0, p.az + uz * o.s0]);
        s = o.s1;
      }
      if (s < L) out.push([p.ax + ux * s, p.az + uz * s, p.bx, p.bz]);
    }
    return out;
  };
  /** Occupancy grid of a level for a standing player (clearance C from walls, furniture, flights, stairwells). */
  R.grid = (plan, level, C = 0.38) => {
    const cell = 0.05, inner = plan.inner;
    const xs = inner.map((p) => p[0]), zs = inner.map((p) => p[1]);
    const x0 = Math.min(...xs), z0 = Math.min(...zs), nx = Math.ceil((Math.max(...xs) - x0) / cell) + 1, nz = Math.ceil((Math.max(...zs) - z0) / cell) + 1;
    const free = new Uint8Array(nx * nz);
    const wl = walls(plan, level), lv = leaves(plan, level), bl = R.blocks(plan, level, C);
    const flights = plan.stairs.filter((s) => s.level === level);
    const holes = plan.holes.filter((h) => h.level === level);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      if (!pointIn(x, z, inner) || edgeDist(x, z, inner) < C) continue;
      let ok = true;
      for (const s of wl) if (segDist(x, z, s[0], s[1], s[2], s[3]) < C + 0.05) { ok = false; break; }
      if (ok) for (const s of lv) if (segDist(x, z, s[0], s[1], s[2], s[3]) < C + 0.03) { ok = false; break; }
      if (ok) for (const b of bl) if (pointIn(x, z, b)) { ok = false; break; }
      if (ok) for (const st of flights) {
        const dx = x - st.x, dz = z - st.z, a = dx * st.dx + dz * st.dz, c = dx * st.dz - dz * st.dx;
        if (a > -0.05 && a < st.run + 0.2 && Math.abs(c) < st.width / 2 + 0.05) { ok = false; break; }
      }
      if (ok) for (const h of holes) if (pointIn(x, z, h.poly) || edgeDist(x, z, h.poly) < C + 0.05) { ok = false; break; }
      if (ok) free[i + j * nx] = 1;
    }
    return { x0, z0, cell, nx, nz, free };
  };
  const cellOf = (g, x, z) => [Math.round((x - g.x0) / g.cell), Math.round((z - g.z0) / g.cell)];
  const isFree = (g, i, j) => i >= 0 && j >= 0 && i < g.nx && j < g.nz && g.free[i + j * g.nx] === 1;
  const nearestFree = (g, x, z) => {
    const [ci, cj] = cellOf(g, x, z);
    for (let r = 0; r < 40; r++) {
      let best = null, bd = Infinity;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || !isFree(g, i, j)) continue;
        const d = Math.hypot(i - ci, j - cj);
        if (d < bd) { bd = d; best = [i, j]; }
      }
      if (best) return best;
    }
    return null;
  };
  /** A* over the grid from (x, z) to (tx, tz); world waypoints after string pulling, or null. */
  R.path = (g, x, z, tx, tz) => {
    const s = nearestFree(g, x, z), t = nearestFree(g, tx, tz);
    if (!s || !t) return null;
    const N = g.nx * g.nz, cost = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const si = s[0] + s[1] * g.nx, ti = t[0] + t[1] * g.nx;
    cost[si] = 0;
    const open = [si];
    const h = (k) => Math.hypot((k % g.nx) - t[0], Math.floor(k / g.nx) - t[1]);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (cost[open[k]] + h(open[k]) < cost[open[bi]] + h(open[bi])) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur === ti) break;
      if (done[cur]) continue;
      done[cur] = 1;
      const ci = cur % g.nx, cj = Math.floor(cur / g.nx);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (!isFree(g, ni, nj) || (di && dj && (!isFree(g, ci + di, cj) || !isFree(g, ci, cj + dj)))) continue;
        const k = ni + nj * g.nx, c2 = cost[cur] + (di && dj ? 1.4142 : 1);
        if (c2 < cost[k]) { cost[k] = c2; from[k] = cur; open.push(k); }
      }
    }
    if (from[ti] < 0 && ti !== si) return null;
    const cells = [];
    for (let k = ti; k >= 0; k = from[k]) { cells.unshift(k); if (k === si) break; }
    const pt = (k) => [g.x0 + (k % g.nx) * g.cell, g.z0 + Math.floor(k / g.nx) * g.cell];
    const los = (a, b) => {
      const [ax, az] = pt(a), [bx, bz] = pt(b), n = Math.ceil(Math.hypot(bx - ax, bz - az) / (g.cell * 0.5));
      for (let q = 0; q <= n; q++) { const [i, j] = cellOf(g, ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n); if (!isFree(g, i, j)) return false; }
      return true;
    };
    const out = [];
    let a = 0;
    while (a < cells.length - 1) {
      let b = cells.length - 1;
      while (b > a + 1 && !los(cells[a], cells[b])) b--;
      out.push(pt(cells[b]));
      a = b;
    }
    return out;
  };
  /** Doorways with a leaf on a level: centre, normal, door id. */
  const doorways = (plan, level) => {
    const out = [];
    for (const p of plan.partitions) {
      if (p.level !== level) continue;
      const L = Math.hypot(p.bx - p.ax, p.bz - p.az), ux = (p.bx - p.ax) / L, uz = (p.bz - p.az) / L;
      for (const o of p.openings) if (o.door) {
        const c = (o.s0 + o.s1) / 2;
        out.push({ id: `${plan.id}/${o.door}`, x: p.ax + ux * c, z: p.az + uz * c, ax: p.ax + ux * o.s0, az: p.az + uz * o.s0, bx: p.ax + ux * o.s1, bz: p.az + uz * o.s1, nx: -uz, nz: ux });
      }
    }
    return out;
  };
  const crosses = (p, q, d) => {
    const s1 = (q[0] - p[0]) * (d.az - p[1]) - (q[1] - p[1]) * (d.ax - p[0]), s2 = (q[0] - p[0]) * (d.bz - p[1]) - (q[1] - p[1]) * (d.bx - p[0]);
    const s3 = (d.bx - d.ax) * (p[1] - d.az) - (d.bz - d.az) * (p[0] - d.ax), s4 = (d.bx - d.ax) * (q[1] - d.az) - (d.bz - d.az) * (q[0] - d.ax);
    return s1 * s2 < 0 && s3 * s4 < 0;
  };
  /** Face an inner door and press E (open it if it is closed). */
  R.openDoor = (id) => {
    const d = w.doors.byId.get(id);
    if (!d) return { id, missing: true };
    if (d.open) return { id, already: true };
    const t = H.pos();
    H.face(Math.atan2(d.pd.x - t.x, d.pd.z - t.z));
    const prompt = P.prompt;
    H.press('KeyE');
    H.frame(50);
    return { id, prompt, open: d.open, angle: +d.angle.toFixed(2) };
  };
  /** The level the player stands on. */
  R.level = (plan) => {
    let lvl = 0;
    for (let k = plan.levels.length - 1; k >= 0; k--) if (H.feet() > plan.levels[k].y - 0.5) { lvl = k; break; }
    return lvl;
  };
  /**
   * Walk on the current level to (tx, tz) along A* waypoints with the keyboard, opening closed inner doors on the way
   * with E. Returns { reached, legs, doors, pen, kinds }.
   */
  R.navigate = (plan, tx, tz, run) => {
    const level = R.level(plan);
    const res = { level, reached: false, steps: [], doors: [], pen: -Infinity, kinds: {} };
    const add = (r) => { res.pen = Math.max(res.pen, r.pen); for (const [k, v] of Object.entries(r.kinds)) res.kinds[k] = (res.kinds[k] ?? 0) + v; res.steps.push(r.reached); return r.reached; };
    for (let guard = 0; guard < 6; guard++) {
      const g = R.grid(plan, level);
      const t = H.pos();
      const pts = R.path(g, t.x, t.z, tx, tz);
      if (!pts) { res.error = `no path on level ${level}`; return res; }
      // the first closed door the path crosses: walk to it, open it, through, then plan again
      let prev = [t.x, t.z], hit = null, upto = pts.length;
      for (let k = 0; k < pts.length && !hit; k++) {
        for (const d of doorways(plan, level)) if (!w.doors.byId.get(d.id)?.open && crosses(prev, pts[k], d)) { hit = d; upto = k; break; }
        prev = pts[k];
      }
      if (!hit) {
        for (const p of pts) if (!add(H.walkTo(p[0], p[1], { tol: 0.22, run }))) return res;
        res.reached = Math.hypot(H.pos().x - tx, H.pos().z - tz) < 0.6;
        return res;
      }
      const side = (t.x - hit.x) * hit.nx + (t.z - hit.z) * hit.nz > 0 ? 1 : -1;
      const near = [hit.x + hit.nx * side * 0.9, hit.z + hit.nz * side * 0.9];
      const p2 = R.path(g, t.x, t.z, near[0], near[1]);
      if (!p2) { res.error = `no path to door ${hit.id}`; return res; }
      for (const p of p2) if (!add(H.walkTo(p[0], p[1], { tol: 0.22, run }))) return res;
      res.doors.push(R.openDoor(hit.id));
      if (!add(H.walkTo(hit.x - hit.nx * side * 0.85, hit.z - hit.nz * side * 0.85, { tol: 0.25, run }))) return res;
      void upto;
    }
    res.error = 'too many doors';
    return res;
  };
  /** Up or down one flight from the current level (keyboard, straight along the flight). */
  R.flight = (plan, up, run) => {
    const lvl = R.level(plan);
    const st = plan.stairs.find((s) => s.level === (up ? lvl : lvl - 1));
    if (!st) return { error: `no flight ${up ? 'up' : 'down'} from level ${lvl}` };
    const foot = [st.x - st.dx * 0.6, st.z - st.dz * 0.6], head = [st.x + st.dx * (st.run + 0.75), st.z + st.dz * (st.run + 0.75)];
    const [a, b] = up ? [foot, head] : [head, foot];
    const nav = R.navigate(plan, a[0], a[1], run);
    const f0 = H.feet();
    const r = H.walkTo(b[0], b[1], { tol: 0.3, run, sec: 8 });
    const f1 = H.feet();
    return { via: up ? 'stair up' : 'stair down', approach: nav.reached, approachErr: nav.error, through: r.reached, rise: +(f1 - f0).toFixed(2), want: +(up ? st.rise : -st.rise).toFixed(2), pen: Math.max(nav.pen, r.pen), kinds: { ...nav.kinds, ...r.kinds }, seconds: r.seconds, doors: nav.doors };
  };
  /** Walk to a room's most open spot (any level), by flights and A*. */
  R.goto = (plan, to, run) => {
    const room = plan.rooms.find((r) => r.id === to);
    if (!room) return { error: `no room ${to}` };
    const legs = [];
    for (let guard = 0; guard < 8 && R.level(plan) !== room.level; guard++) {
      const up = R.level(plan) < room.level;
      const f = R.flight(plan, up, run);
      legs.push(f);
      if (f.error || !f.through) return { legs, error: f.error ?? `flight ${f.via} failed` };
    }
    const fs = R.free(plan, room);
    const nav = R.navigate(plan, fs.x, fs.z, run);
    legs.push({ via: 'walk', through: nav.reached, error: nav.error, pen: nav.pen, kinds: nav.kinds, doors: nav.doors });
    const feet = H.feet(), lv = plan.levels[room.level].y;
    return { legs, visit: { room: to, reached: nav.reached, feet: +feet.toFixed(2), floor: +lv.toFixed(2), dy: +(feet - lv).toFixed(3), pen: nav.pen, clear: fs.clear } };
  };
  window.__ir = R;
}

function legChecks(fails, what, r) {
  if (!r) { fails.push(`${what}: no result`); return; }
  if (r.error || r.approachErr) { fails.push(`${what}: ${r.error ?? r.approachErr}`); return; }
  if (r.reached === false || r.approach === false || r.through === false) fails.push(`${what}: did not get there (${JSON.stringify(r)})`);
  if (r.pen > 0.05) fails.push(`${what}: feet ${r.pen} m below the floor`);
  if (r.kinds && r.kinds.building) fails.push(`${what}: touched the building's solid core (${r.kinds.building} frames)`);
  if (r.dy !== undefined && Math.abs(r.dy) > 0.06) fails.push(`${what}: feet ${r.dy} m off the floor`);
  if (r.rise !== undefined && Math.abs(r.rise - r.want) > 0.12) fails.push(`${what}: rose ${r.rise} m, the flight rises ${r.want} m`);
}
function gotoChecks(fails, what, g) {
  if (!g || g.error) { fails.push(`${what}: ${g?.error ?? 'no result'}`); return; }
  for (const l of g.legs) legChecks(fails, `${what} via ${l.via}`, l);
  legChecks(fails, what, g.visit);
}

const snap = async (page, name) => {
  await page.waitForTimeout(300);
  try { await page.screenshot({ path: `screenshots/${name}.png`, timeout: 300000 }); } catch (e) { return `screenshot ${name} failed: ${e.message.split('\n')[0]}`; }
  return null;
};
const cam = (page, c) => page.evaluate((c) => { window.__oc.cam.override = c; }, c);

async function startInteriors(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__oc.started, null, { timeout: 120000 });
  await page.evaluate(installInteriorHelpers);
  await page.evaluate(installRouteHelpers);
  await page.evaluate(`window.__ipick = ${pickUpItem.toString()}`);
}

/**
 * From the pavement to a building's front door and in: the closed door stops you (kind 'door', never 'building'),
 * the prompt says "E open door", E opens it, you walk through. Returns the steps (page side).
 */
function approachAndEnter(id) {
  const w = window.__oc, H = window.__ih, P = w.player;
  const e = w.interiors.byId.get(id), d = e.front.pd; // d.n points into the building
  const out = {};
  out.startFeet = +H.put(d.x - d.nx * 6.5, d.z - d.nz * 6.5, Math.atan2(d.nx, d.nz), d.y + 3).toFixed(2);
  H.frame(30);
  out.build = { state: e.state, ms: +e.buildMs.toFixed(1), frames: e.buildFrames, colliders: e.built?.colliders.length, tris: e.built?.tris };
  const up = H.walkTo(d.x - d.nx * 0.1, d.z - d.nz * 0.1, { tol: 0.05, sec: 7 });
  H.hold(['KeyW'], 0.5);
  const t = H.pos();
  out.atDoor = { kinds: up.kinds, pen: up.pen, outside: +((t.x - d.x) * -d.nx + (t.z - d.z) * -d.nz).toFixed(2), feet: +H.feet().toFixed(2), sill: +d.y.toFixed(2), prompt: P.prompt };
  H.press('KeyE');
  H.frame(50);
  out.opened = { open: e.front.open, angle: +e.front.angle.toFixed(2) };
  return out;
}
function enterChecks(fails, a) {
  if (a.build.state !== 'active') fails.push(`interior not built when you reach the pavement (${a.build.state})`);
  if (!a.atDoor.kinds.door) fails.push(`the closed front door did not stop the player (${JSON.stringify(a.atDoor.kinds)})`);
  if (a.atDoor.kinds.building) fails.push('the building solid stopped the player at the door');
  if (a.atDoor.outside < 0.1) fails.push(`got past the closed door (${a.atDoor.outside} m outside the facade line)`);
  if (Math.abs(a.atDoor.feet - a.atDoor.sill) > 0.12) fails.push(`at the door the feet are ${a.atDoor.feet} m, the sill ${a.atDoor.sill} m`);
  if (!/open door/.test(a.atDoor.prompt)) fails.push(`no "E open door" prompt at the door ("${a.atDoor.prompt}")`);
  if (!a.opened.open || a.opened.angle < 1.2) fails.push(`E did not open the front door (${JSON.stringify(a.opened)})`);
}

/** Close the front door from where you stand (facing it), walk into it, open it again. */
function closeBlockOpen([id, side]) {
  const w = window.__oc, H = window.__ih, P = w.player;
  const e = w.interiors.byId.get(id), d = e.front.pd, door = e.front;
  const s = side === 'inside' ? 1 : -1; // where you stand: +n inside
  const out = { side };
  // stand 1.3 m from the doorway on that side, face it
  const back = s > 0 ? 1.7 : 1.3; // inside: out of the leaf's swing (1.04 m from the hinge plus the capsule)
  out.stand = H.walkTo(d.x + d.nx * s * back, d.z + d.nz * s * back, { tol: 0.25 });
  H.face(Math.atan2(-d.nx * s, -d.nz * s));
  out.promptOpen = P.prompt;
  H.press('KeyE');
  H.frame(70);
  out.closed = { open: door.open, angle: +door.angle.toFixed(3) };
  // walk (and then run, and jump) into it: you stay on your side
  const p0 = H.pos();
  const r1 = H.hold(['KeyW'], 1.5);
  const r2 = H.hold(['KeyW', 'ShiftLeft'], 1.0);
  w.input.keys.add('KeyW'); H.press('Space'); H.frame(50); w.input.keys.delete('KeyW');
  const t = H.pos();
  const side1 = (t.x - d.x) * d.nx + (t.z - d.z) * d.nz; // signed distance past the facade line (+ inside)
  out.blocked = { kinds: { ...r1.kinds, ...r2.kinds }, side: +side1.toFixed(2), moved: +Math.hypot(t.x - p0.x, t.z - p0.z).toFixed(2), pen: Math.max(r1.pen, r2.pen) };
  out.promptClosed = P.prompt;
  H.press('KeyE');
  H.frame(60);
  out.reopened = { open: door.open, angle: +door.angle.toFixed(2) };
  return out;
}
function blockChecks(fails, b) {
  if (b.closed.open || b.closed.angle > 0.01) fails.push(`${b.side}: E did not close the door (${JSON.stringify(b.closed)})`);
  if (!b.blocked.kinds.door) fails.push(`${b.side}: walking into the closed door never touched it (${JSON.stringify(b.blocked.kinds)})`);
  const wrong = b.side === 'inside' ? b.blocked.side < 0.15 : b.blocked.side > -0.15;
  if (wrong) fails.push(`${b.side}: got through the closed door (now ${b.blocked.side} m from the facade line)`);
  if (!/close door/.test(b.promptOpen)) fails.push(`${b.side}: prompt at the open door was "${b.promptOpen}"`);
  if (!/open door/.test(b.promptClosed)) fails.push(`${b.side}: prompt at the closed door was "${b.promptClosed}"`);
  if (!b.reopened.open) fails.push(`${b.side}: E did not open the door again`);
}

/**
 * The house end to end (geo:b23e0ce279d85, a 3-storey rowhouse with a 7-step stoop): pavement, up the stoop, the
 * closed door, E, in, every room on every floor (bathroom doors opened with E), both flights up and down, the front
 * door closed, walked into and reopened from inside, out to the pavement, closed, walked into and reopened from
 * outside. Screenshots 42-house-street, -door-open, -hall, -upstairs, -doorway-f4.
 */
export async function housewalk(page) {
  await startInteriors(page);
  const fails = [], shots = [];
  const a = await page.evaluate(approachAndEnter, HOUSE);
  enterChecks(fails, a);
  // the street view with the door open
  await page.evaluate((id) => {
    const w = window.__oc, d = w.interiors.byId.get(id).front.pd;
    w.cam.override = { px: d.x - d.nx * 8 - d.ux * 3, py: d.y + 0.9, pz: d.z - d.nz * 8 - d.uz * 3, lx: d.x + d.nx * 2, ly: d.y + 1.0, lz: d.z + d.nz * 2 };
  }, HOUSE);
  shots.push(await snap(page, '42-house-street'));
  // F4 at the doorway (the leaf, the frame, the interior's walls; no building solid in the opening)
  await page.evaluate((id) => {
    const w = window.__oc, d = w.interiors.byId.get(id).front.pd;
    w.cam.override = { px: d.x - d.nx * 3.2 + d.ux * 1.6, py: d.y + 2.2, pz: d.z - d.nz * 3.2 + d.uz * 1.6, lx: d.x + d.nx * 1.5, ly: d.y + 0.9, lz: d.z + d.nz * 1.5 };
    w.input.pressed.add('F4'); window.__ocRun(1 / 60, 60);
  }, HOUSE);
  shots.push(await snap(page, '42-house-doorway-f4'));
  await page.evaluate(() => { const w = window.__oc; w.input.pressed.add('F4'); window.__ocRun(1 / 60, 60); w.cam.override = null; });
  const c = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, e = w.interiors.byId.get(id), d = e.front.pd;
    const r = H.walkTo(d.x + d.nx * 1.5, d.z + d.nz * 1.5, { tol: 0.3 });
    H.frame(30);
    return { enter: r, inside: w.interiors.inside?.rec.id ?? null, coreEnabled: e.rec.core.filter((c) => c.isEnabled()).length, feet: +H.feet().toFixed(3), floor: +e.plan.levels[0].y.toFixed(3) };
  }, HOUSE);
  legChecks(fails, 'through the front door', c.enter);
  if (c.inside !== HOUSE) fails.push(`not inside the house after the doorway (${c.inside})`);
  if (c.coreEnabled) fails.push(`${c.coreEnabled} core colliders still enabled while the interior is active`);
  shots.push(await snap(page, '42-house-door-open'));
  // every room, floor by floor, then back down
  const tour = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, R = window.__ir;
    const plan = R.plan(id);
    const steps = [];
    const order = plan.rooms.filter((r) => r.kind !== 'stair').map((r) => r.id);
    for (const target of order) steps.push({ target, g: R.goto(plan, target) });
    const down = R.goto(plan, 'L0/hall');
    return { steps, down, rooms: order.length, doorsOpen: [...w.doors.list].filter((d) => d.building === id && d.open).map((d) => d.id) };
  }, HOUSE);
  for (const s of tour.steps) gotoChecks(fails, s.target, s.g);
  gotoChecks(fails, 'back down to the hall', tour.down);
  // hall view and an upstairs view (follow camera)
  shots.push(await snap(page, '42-house-hall'));
  const up = await page.evaluate((id) => {
    const R = window.__ir, plan = R.plan(id);
    const g = R.goto(plan, 'L1/front');
    return g;
  }, HOUSE);
  gotoChecks(fails, 'upstairs again (front bedroom)', up);
  shots.push(await snap(page, '42-house-upstairs'));
  const back = await page.evaluate((id) => {
    const R = window.__ir, plan = R.plan(id);
    return R.goto(plan, 'L0/hall');
  }, HOUSE);
  gotoChecks(fails, 'down to the hall again', back);
  // a door never traps you: standing in its swing, E makes it close only as far as you let it; step away and it
  // finishes closing (it never pushes you)
  const trap = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, e = w.interiors.byId.get(id), d = e.front.pd, door = e.front;
    H.walkTo(d.x + d.nx * 0.95, d.z + d.nz * 0.95, { tol: 0.2 });
    H.face(Math.atan2(-d.nx, -d.nz));
    const p0 = H.pos();
    H.press('KeyE');
    H.frame(60);
    const p1 = H.pos();
    const stopped = { angle: +door.angle.toFixed(2), waited: +door.waited.toFixed(2), pushed: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3) };
    H.face(Math.atan2(d.nx, d.nz));
    const away = H.hold(['KeyW'], 0.5);
    H.frame(60);
    const closed = { angle: +door.angle.toFixed(3), open: door.open };
    H.face(Math.atan2(-d.nx, -d.nz));
    H.walkTo(d.x + d.nx * 1.7, d.z + d.nz * 1.7, { tol: 0.25 });
    H.face(Math.atan2(-d.nx, -d.nz));
    H.press('KeyE');
    H.frame(60);
    return { stopped, away: away.kinds, closed, reopened: { open: door.open, angle: +door.angle.toFixed(2) } };
  }, HOUSE);
  if (!(trap.stopped.angle > 0.3)) fails.push(`the door closed through the player standing in its swing (${JSON.stringify(trap.stopped)})`);
  if (trap.stopped.pushed > 0.02) fails.push(`the closing door pushed the player ${trap.stopped.pushed} m`);
  if (trap.closed.angle > 0.01) fails.push(`the door did not finish closing once the player stepped away (${JSON.stringify(trap.closed)})`);
  if (!trap.reopened.open) fails.push('could not reopen the door after the trap test');
  // the front door from inside, then out and from outside
  const bin = await page.evaluate(closeBlockOpen, [HOUSE, 'inside']);
  blockChecks(fails, bin);
  const out = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, e = w.interiors.byId.get(id), d = e.front.pd;
    const r = H.walkTo(d.x - d.nx * 0.9, d.z - d.nz * 0.9, { tol: 0.3 });
    const s = H.walkTo(d.x - d.nx * 5.5, d.z - d.nz * 5.5, { tol: 0.4 });
    H.frame(20);
    return { out: r, pavement: s, inside: w.interiors.inside?.rec.id ?? null, feet: +H.feet().toFixed(2), street: +w.city.heightAt(H.pos().x, H.pos().z).toFixed(2) };
  }, HOUSE);
  legChecks(fails, 'out through the front door', out.out);
  legChecks(fails, 'down the stoop to the pavement', out.pavement);
  if (out.inside) fails.push(`still counted inside after leaving (${out.inside})`);
  const bout = await page.evaluate(closeBlockOpen, [HOUSE, 'outside']);
  blockChecks(fails, bout);
  return { a, c, tour: tour.steps.map((s) => ({ t: s.target, legs: s.g.legs?.map((l) => `${l.via}:${l.through}${l.rise !== undefined ? ` rise ${l.rise}/${l.want}` : ''}`), visit: s.g.visit && { dy: s.g.visit.dy, reached: s.g.visit.reached, pen: s.g.visit.pen } })), trap, inside: bin, outside: bout, out, fails, shots: shots.filter(Boolean) };
}

/**
 * Walk to an item lying on a piece of furniture and pick it up with E (page side). The stand point is in front of the
 * piece on the item's side, level with it along the piece; you face the item before pressing E.
 */
function pickUpItem(uid) {
  const w = window.__oc, H = window.__ih, R = window.__ir, P = w.player;
  const it = w.itemsState.byUid.get(uid);
  if (!it) return { uid, error: 'no such item' };
  const e = w.interiors.byId.get(it.building);
  const plan = e.plan;
  const fid = uid.slice(e.rec.id.length + 1).split('/').slice(0, -1).join('/');
  const f = plan.furniture.find((q) => q.id === fid);
  const def = window.__ocFurn[f.def];
  const s = (it.px - f.x) * f.fx + (it.pz - f.z) * f.fz >= 0 ? 1 : -1; // the item's side of the piece
  const along = (it.px - f.x) * f.fz - (it.pz - f.z) * f.fx; // along the piece's width (its local +x is (fz, -fx))
  const sx = f.x + f.fx * s * (def.d / 2 + 0.6) + f.fz * along, sz = f.z + f.fz * s * (def.d / 2 + 0.6) - f.fx * along;
  const level = plan.levels.findIndex((L, k) => it.py >= L.y && (k + 1 >= plan.levels.length || it.py < plan.levels[k + 1].y));
  const room = R.roomAt(plan, level, sx, sz) ?? R.roomAt(plan, level, f.x, f.z);
  const g = R.goto(plan, room.id);
  const st = H.walkTo(sx, sz, { tol: 0.2 });
  const t = H.pos();
  H.face(Math.atan2(it.px - t.x, it.pz - t.z));
  H.frame(2);
  const prompt = P.prompt, target = w.itemsState.target?.uid ?? null;
  H.press('KeyE');
  H.frame(5);
  const slot = w.inventory.slots.findIndex((q) => q && q.uid === uid);
  return { uid, type: it.type, furniture: fid, room: room.id, goto: g, stand: st, prompt, target, inHotbar: slot >= 0, owner: it.owner, slotPos: [it.px, it.py, it.pz] };
}

/**
 * The shop end to end (geo:be01bab3a0eeb, "Easel House" on M St NW, a 2-storey shop): pavement, closed door, E, in,
 * a product off a shelf (its price in the prompt), paid at the counter, another product carried out unpaid (stolen,
 * reported), the stock room through its door (E), the stair up to the office and down, the front door from both
 * sides. Screenshots 42-shop-front, -inside, -counter.
 */
export async function shopwalk(page) {
  await startInteriors(page);
  const fails = [], shots = [];
  await page.evaluate(() => { window.__oc.dayNight.hour = 13; });
  const a = await page.evaluate(approachAndEnter, SHOP);
  enterChecks(fails, a);
  await page.evaluate((id) => {
    const w = window.__oc, d = w.interiors.byId.get(id).front.pd;
    w.cam.override = { px: d.x - d.nx * 7 + d.ux * 2.5, py: d.y + 1.7, pz: d.z - d.nz * 7 + d.uz * 2.5, lx: d.x + d.nx * 2, ly: d.y + 1.3, lz: d.z + d.nz * 2 };
  }, SHOP);
  shots.push(await snap(page, '42-shop-front'));
  await cam(page, null);
  const c = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, e = w.interiors.byId.get(id), d = e.front.pd;
    const r = H.walkTo(d.x + d.nx * 1.6, d.z + d.nz * 1.6, { tol: 0.3 });
    H.frame(20);
    return { enter: r, inside: w.interiors.inside?.rec.id ?? null, coreEnabled: e.rec.core.filter((c) => c.isEnabled()).length };
  }, SHOP);
  legChecks(fails, 'through the shop door', c.enter);
  if (c.inside !== SHOP) fails.push(`not inside the shop after the doorway (${c.inside})`);
  if (c.coreEnabled) fails.push(`${c.coreEnabled} core colliders still enabled`);
  await page.evaluate((id) => {
    const w = window.__oc, e = w.interiors.byId.get(id), d = e.front.pd, f = e.plan.frame;
    w.cam.override = { px: d.x + d.nx * 0.8 + d.ux * 0.6, py: d.y + 2.0, pz: d.z + d.nz * 0.8 + d.uz * 0.6, lx: d.x + d.nx * 9, ly: d.y + 0.9, lz: d.z + d.nz * 9 };
    void f;
  }, SHOP);
  shots.push(await snap(page, '42-shop-inside'));
  await cam(page, null);
  // a product off a shelf, paid at the counter
  const buy = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, R = window.__ir, P = w.player;
    const e = w.interiors.byId.get(id), plan = e.plan;
    const items = w.itemsState.items.filter((it) => it.building === id && it.inWorld && !it.dormant && it.uid.includes('/L0/sales/') && it.py < plan.levels[0].y + 1.3);
    const pick = items.sort((p, q) => Math.hypot(p.px - e.counter.x, p.pz - e.counter.z) - Math.hypot(q.px - e.counter.x, q.pz - e.counter.z))[0];
    if (!pick) return { error: 'no product on the sales floor', n: items.length };
    const cash0 = w.cash;
    const got = window.__ipick(pick.uid);
    // to the counter (customer side), pay with E
    const cf = plan.furniture.find((f) => f.def === 'counter');
    const sx = cf.x + cf.fx * 0.95, sz = cf.z + cf.fz * 0.95;
    const st = H.walkTo(sx, sz, { tol: 0.25 });
    const t = H.pos();
    H.face(Math.atan2(cf.x - t.x, cf.z - t.z));
    H.frame(2);
    const prompt = P.prompt;
    return { got, items: items.length, cash0, stand: st, prompt, uid: pick.uid, value: window.__ocItemDefs[pick.type].value };
  }, SHOP);
  if (buy.error) fails.push(`shop: ${buy.error}`);
  else {
    if (!buy.got.inHotbar) fails.push(`could not pick up ${buy.uid} (prompt "${buy.got.prompt}", target ${buy.got.target})`);
    if (!/\$/.test(buy.got.prompt)) fails.push(`the shelf prompt shows no price ("${buy.got.prompt}")`);
    if (!/pay \$/.test(buy.prompt)) fails.push(`no "E pay" prompt at the counter ("${buy.prompt}")`);
  }
  shots.push(await snap(page, '42-shop-counter'));
  const paid = await page.evaluate((uid) => {
    const w = window.__oc, H = window.__ih;
    const cash1 = w.cash;
    H.press('KeyE');
    H.frame(5);
    const it = w.itemsState.byUid.get(uid);
    return { cash1, cash2: w.cash, owner: it?.owner, stolen: it?.stolen };
  }, buy.uid);
  if (!buy.error && (Math.abs(paid.cash1 - paid.cash2 - buy.value) > 0.01 || paid.owner !== 'player')) fails.push(`paying did not work (${JSON.stringify(paid)}, price ${buy.value})`);
  // the stock room through its door, the stair up to the office, back down
  const back = await page.evaluate((id) => {
    const R = window.__ir, plan = R.plan(id);
    const g1 = R.goto(plan, 'L0/back');
    const g2 = R.goto(plan, 'L1/office');
    const g3 = R.goto(plan, 'L1/stock');
    const g4 = R.goto(plan, 'L0/sales');
    return { g1, g2, g3, g4 };
  }, SHOP);
  gotoChecks(fails, 'stock room', back.g1);
  gotoChecks(fails, 'upstairs office', back.g2);
  gotoChecks(fails, 'upstairs stock', back.g3);
  gotoChecks(fails, 'back down to the sales floor', back.g4);
  // a second product carried out without paying
  const steal = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih;
    const e = w.interiors.byId.get(id), d = e.front.pd;
    const items = w.itemsState.items.filter((it) => it.building === id && it.inWorld && !it.dormant && it.uid.includes('/L0/sales/') && it.py < e.plan.levels[0].y + 1.3);
    const pick = items.sort((p, q) => Math.hypot(p.px - d.x, p.pz - d.z) - Math.hypot(q.px - d.x, q.pz - d.z))[0];
    if (!pick) return { error: 'no second product' };
    const got = window.__ipick(pick.uid);
    const ev0 = window.__ocWitness.callsStarted;
    const toDoor = window.__ir.goto(e.plan, 'L0/sales');
    const r1 = H.walkTo(d.x + d.nx * 0.9, d.z + d.nz * 0.9, { tol: 0.3 });
    const r2 = H.walkTo(d.x - d.nx * 2.5, d.z - d.nz * 2.5, { tol: 0.4 });
    H.frame(10);
    const it = w.itemsState.byUid.get(pick.uid);
    return { got: got.inHotbar, uid: pick.uid, toDoor: !!toDoor.visit, r1: r1.reached, r2: r2.reached, stolen: it.stolen, toast: w.hud.toast.textContent, inside: w.interiors.inside?.rec.id ?? null, calls0: ev0 };
  }, SHOP);
  if (steal.error) fails.push(`shop: ${steal.error}`);
  else {
    if (!steal.got) fails.push('could not pick up the second product');
    if (!steal.stolen) fails.push('carrying an unpaid product out did not mark it stolen');
    if (!/without paying/.test(steal.toast)) fails.push(`no shoplifting message ("${steal.toast}")`);
  }
  // the front door from outside, then from inside
  const bout = await page.evaluate(closeBlockOpen, [SHOP, 'outside']);
  blockChecks(fails, bout);
  const bin0 = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, d = w.interiors.byId.get(id).front.pd;
    return H.walkTo(d.x + d.nx * 1.8, d.z + d.nz * 1.8, { tol: 0.3 });
  }, SHOP);
  legChecks(fails, 'back into the shop', bin0);
  const bin = await page.evaluate(closeBlockOpen, [SHOP, 'inside']);
  blockChecks(fails, bin);
  const out = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, d = w.interiors.byId.get(id).front.pd;
    const r = H.walkTo(d.x - d.nx * 3, d.z - d.nz * 3, { tol: 0.4 });
    return { r, inside: w.interiors.inside?.rec.id ?? null };
  }, SHOP);
  legChecks(fails, 'out to the pavement', out.r);
  return { a, c, buy: { ...buy, got: { ...buy.got, goto: undefined } }, paid, back: Object.fromEntries(Object.entries(back).map(([k, g]) => [k, g.legs?.map((l) => `${l.via}:${l.through}${l.rise !== undefined ? ` rise ${l.rise}/${l.want}` : ''}`)])), steal, outside: bout, inside: bin, fails, shots: shots.filter(Boolean) };
}

/**
 * A mug from the house, carried out and dropped on the pavement, then the page reloaded twice: the mug is where it was
 * dropped (not back on its shelf, exactly one of it), then picked up again and still in the hotbar after a reload.
 */
export async function mugpersist(page) {
  await startInteriors(page);
  const fails = [];
  const a = await page.evaluate(approachAndEnter, HOUSE);
  enterChecks(fails, a);
  const take = await page.evaluate((id) => {
    const w = window.__oc, H = window.__ih, e = w.interiors.byId.get(id), d = e.front.pd;
    H.walkTo(d.x + d.nx * 1.5, d.z + d.nz * 1.5, { tol: 0.3 });
    const mugs = w.itemsState.items.filter((it) => it.building === id && it.type === 'mug' && it.inWorld && !it.dormant);
    mugs.sort((p, q) => p.py - q.py);
    if (!mugs.length) return { error: 'no mug in the house' };
    const got = window.__ipick(mugs[0].uid);
    return { got: { ...got, goto: undefined }, mugs: mugs.length };
  }, HOUSE);
  if (take.error) { fails.push(take.error); return { fails }; }
  if (!take.got.inHotbar) fails.push(`could not pick up the mug (prompt "${take.got.prompt}", target ${take.got.target})`);
  const uid = take.got.uid;
  const drop = await page.evaluate(([id, uid]) => {
    const w = window.__oc, H = window.__ih, R = window.__ir, e = w.interiors.byId.get(id), d = e.front.pd;
    const g = R.goto(e.plan, 'L0/hall');
    const r1 = H.walkTo(d.x + d.nx * 0.9, d.z + d.nz * 0.9, { tol: 0.3 });
    const r2 = H.walkTo(d.x - d.nx * 0.9, d.z - d.nz * 0.9, { tol: 0.3 });
    const r3 = H.walkTo(d.x - d.nx * 5.5 + d.ux * 1.5, d.z - d.nz * 5.5 + d.uz * 1.5, { tol: 0.4 });
    const inv = w.inventory;
    inv.selected = inv.slots.findIndex((q) => q && q.uid === uid);
    H.press('KeyQ');
    H.frame(180);
    const it = w.itemsState.byUid.get(uid);
    const t = it.body ? it.body.translation() : { x: it.px, y: it.py, z: it.pz };
    return { out: [!!g.visit, r1.reached, r2.reached, r3.reached], dropped: [t.x, t.y, t.z], inWorld: it.inWorld, sleeping: it.body?.isSleeping() ?? null, street: w.city.heightAt(t.x, t.z), building: it.building };
  }, [HOUSE, uid]);
  if (!drop.out.every(Boolean)) fails.push(`could not walk out with the mug (${JSON.stringify(drop.out)})`);
  if (!drop.inWorld) fails.push('Q did not drop the mug');
  if (Math.abs(drop.dropped[1] - drop.street) > 0.3) fails.push(`the mug is not lying on the pavement (y ${drop.dropped[1].toFixed(2)}, pavement ${drop.street.toFixed(2)})`);
  const back = await page.evaluate(([id, uid, slotPos]) => {
    const w = window.__oc, H = window.__ih, R = window.__ir, e = w.interiors.byId.get(id), d = e.front.pd;
    const r1 = H.walkTo(d.x - d.nx * 0.9, d.z - d.nz * 0.9, { tol: 0.3 });
    const r2 = H.walkTo(d.x + d.nx * 1.5, d.z + d.nz * 1.5, { tol: 0.3 });
    const room = R.roomAt(e.plan, 0, slotPos[0], slotPos[2]);
    const g = room ? R.goto(e.plan, room.id) : null;
    H.frame(30);
    const atSlot = w.itemsState.items.filter((it) => it.inWorld && !it.dormant && Math.hypot(it.px - slotPos[0], it.pz - slotPos[2]) < 0.1 && Math.abs(it.py - slotPos[1]) < 0.2).map((it) => it.uid);
    const copies = w.itemsState.items.filter((it) => it.uid === uid).length;
    const writes = w.save.writes;
    return { walked: [r1.reached, r2.reached, !!g?.visit], atSlot, copies, writes };
  }, [HOUSE, uid, take.got.slotPos]);
  if (back.atSlot.length) fails.push(`the shelf slot is not empty after re-entering (${back.atSlot.join(', ')})`);
  if (back.copies !== 1) fails.push(`${back.copies} copies of ${uid}`);
  if (!back.writes) fails.push('no autosave was written after the pickup and drop');
  await page.evaluate(() => window.__ocInteriors.save());
  // reload: the same world from the save
  const reload = async () => {
    await page.reload();
    await page.waitForFunction(() => window.__oc && window.__oc.time > 1, null, { timeout: 180000 });
    await startInteriors(page);
    await page.evaluate(() => window.__ocRun(1, 60));
  };
  await reload();
  const r1 = await page.evaluate(([id, uid, slotPos, dropped]) => {
    const w = window.__oc;
    const copies = w.itemsState.items.filter((it) => it.uid === uid);
    const it = copies[0];
    const atSlot = w.itemsState.items.filter((q) => q.inWorld && !q.dormant && Math.hypot(q.px - slotPos[0], q.pz - slotPos[2]) < 0.1 && Math.abs(q.py - slotPos[1]) < 0.2).map((q) => q.uid);
    const e = w.interiors.byId.get(id);
    return { saveStatus: w.save.status, copies: copies.length, at: it ? [it.px, it.py, it.pz] : null, off: it ? Math.hypot(it.px - dropped[0], it.py - dropped[1], it.pz - dropped[2]) : null, inWorld: it?.inWorld, atSlot, state: e.state, inside: w.interiors.inside?.rec.id ?? null };
  }, [HOUSE, uid, take.got.slotPos, drop.dropped]);
  if (r1.saveStatus !== 'loaded') fails.push(`after reload the save was not loaded (${r1.saveStatus})`);
  if (r1.copies !== 1) fails.push(`after reload: ${r1.copies} copies of the mug`);
  if (!(r1.off < 0.1)) fails.push(`after reload the mug is ${r1.off?.toFixed(3)} m from where it was dropped`);
  if (r1.atSlot.length) fails.push(`after reload the shelf slot holds ${r1.atSlot.join(', ')}`);
  // pick it up again, reload: it is in the hotbar
  const again = await page.evaluate((uid) => {
    const w = window.__oc, H = window.__ih, it = w.itemsState.byUid.get(uid);
    const t = H.pos();
    const st = H.walkTo(it.px - (it.px - t.x) * 0.0 + 0.0, it.pz, { tol: 0.7 });
    const p = H.pos();
    H.face(Math.atan2(it.px - p.x, it.pz - p.z));
    H.frame(2);
    const prompt = w.player.prompt;
    H.press('KeyE');
    H.frame(5);
    return { stand: st.reached, prompt, inHotbar: w.inventory.slots.some((q) => q && q.uid === uid) };
  }, uid);
  if (!again.inHotbar) fails.push(`could not pick the mug up again (prompt "${again.prompt}")`);
  await page.evaluate(() => window.__ocInteriors.save());
  await reload();
  const r2 = await page.evaluate((uid) => {
    const w = window.__oc;
    return { copies: w.itemsState.items.filter((it) => it.uid === uid).length, inHotbar: w.inventory.slots.findIndex((q) => q && q.uid === uid), inWorld: w.itemsState.byUid.get(uid)?.inWorld };
  }, uid);
  if (r2.copies !== 1 || r2.inHotbar < 0 || r2.inWorld) fails.push(`after the second reload the mug is not (only) in the hotbar (${JSON.stringify(r2)})`);
  return { uid, take: take.got, drop, back, r1, again, r2, fails };
}
