// Minimap: pre-rendered map image (the map paints its own base layer), rotated around the player, with street
// names along the roads, job markers, police, your own cars, car dealerships and the player arrow.
import { TUNING } from '../tuning';
import type { World } from '../world';
import type { DealershipJob } from './economy/dealership';

const H = TUNING.hud;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let base: HTMLCanvasElement;
let scale = 1; // pixels per metre in the base image
let ox = 0, oz = 0; // world origin of the base image
let last = 0;
/** What the last minimap draw showed (debug overlay / automated tests). */
export const minimapStats = { ownedCars: 0, dealerships: 0 };

export function createMinimap(w: World): void {
  canvas = document.createElement('canvas');
  canvas.id = 'minimap';
  canvas.width = canvas.height = H.minimapSize;
  canvas.style.width = canvas.style.height = `${H.minimapSize}px`;
  canvas.style.visibility = 'hidden';
  document.getElementById('ui')!.appendChild(canvas);
  ctx = canvas.getContext('2d')!;

  const c = w.city;
  const b = c.bounds;
  scale = H.minimapBaseScale;
  ox = b.minX - 20;
  oz = b.minZ - 20;
  base = document.createElement('canvas');
  base.width = Math.ceil((b.maxX - b.minX + 40) * scale);
  base.height = Math.ceil((b.maxZ - b.minZ + 40) * scale);
  const g = base.getContext('2d')!;
  const X = (x: number) => (x - ox) * scale, Z = (z: number) => (z - oz) * scale;
  c.drawMinimapBase(g, { scale, ox, oz, width: base.width, height: base.height });
  buildLabels(w);
  g.fillStyle = '#f4c430';
  for (const r of c.taxiRanks) { g.beginPath(); g.arc(X(r.curbX), Z(r.curbZ), 3, 0, Math.PI * 2); g.fill(); }
  // car dealerships: a blue badge with a dollar sign
  const dealer = w.jobs.get<DealershipJob>('dealership');
  for (const site of dealer?.sites ?? []) {
    const x = X(site.x), z = Z(site.z);
    g.fillStyle = '#1d4ed8';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, z, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('$', x, z + 0.5);
    minimapStats.dealerships++;
  }
}

// ---------- street-name labels (drawn upright along the road, on top of the rotating map) ----------
const labelText: string[] = [];
let labelX = new Float32Array(0);
let labelZ = new Float32Array(0);
let labelAng = new Float32Array(0);
const LABEL_FONT = `600 ${H.minimapLabelPx}px system-ui, sans-serif`;

/** Anchor points for every named street: its middle if short, else one every minimapLabelSpacing metres. */
function buildLabels(w: World): void {
  const ax: number[] = [], az: number[] = [], angs: number[] = [];
  labelText.length = 0;
  for (const st of w.city.streets) {
    if (!st.name) continue;
    const p = st.pts;
    let total = 0;
    for (let k = 2; k < p.length; k += 2) total += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    if (total < H.minimapLabelMinLength) continue;
    const step = H.minimapLabelSpacing;
    const first = total < step ? total / 2 : step / 2;
    for (let at = first; at < total; at += step) {
      // walk to the segment holding `at`
      let run = 0;
      for (let k = 2; k < p.length; k += 2) {
        const sl = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
        if (run + sl >= at || k === p.length - 2) {
          const t = sl > 0 ? Math.min(1, (at - run) / sl) : 0;
          ax.push(p[k - 2] + (p[k] - p[k - 2]) * t);
          az.push(p[k - 1] + (p[k + 1] - p[k - 1]) * t);
          angs.push(Math.atan2(p[k + 1] - p[k - 1], p[k] - p[k - 2]));
          labelText.push(st.name);
          break;
        }
        run += sl;
      }
    }
  }
  labelX = Float32Array.from(ax);
  labelZ = Float32Array.from(az);
  labelAng = Float32Array.from(angs);
}

/** Street names near the player, upright and along their road. `k`: px per metre; (r, r) the centre. */
function drawLabels(px: number, pz: number, yaw: number, k: number, r: number): void {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(16,20,28,0.85)';
  ctx.fillStyle = '#f4f1e8';
  const cy = Math.cos(yaw), sy = Math.sin(yaw), lim = (r - 14) * (r - 14);
  for (let i = 0; i < labelText.length; i++) {
    const dx = (labelX[i] - px) * k, dz = (labelZ[i] - pz) * k;
    const sx = dx * cy - dz * sy, sz = dx * sy + dz * cy;
    if (sx * sx + sz * sz > lim) continue;
    let a = labelAng[i] + yaw;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (a > Math.PI / 2) a -= Math.PI;
    else if (a <= -Math.PI / 2) a += Math.PI;
    ctx.setTransform(1, 0, 0, 1, r + sx, r + sz);
    ctx.rotate(a);
    ctx.strokeText(labelText[i], 0, 0);
    ctx.fillText(labelText[i], 0, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function showMinimap(): void {
  canvas.style.visibility = 'visible';
}

export function updateMinimap(w: World): void {
  if (!w.started || w.time - last < 1 / 30) return;
  last = w.time;
  const S = H.minimapSize, r = S / 2;
  const k = r / H.minimapRange; // px per metre on the minimap
  const p = w.player.mesh.position;
  const yaw = w.cam.yaw; // map rotates so "up" is where the camera looks
  ctx.save();
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#2f7fb3';
  ctx.fillRect(0, 0, S, S);
  ctx.translate(r, r);
  ctx.rotate(yaw);
  const m = k / scale;
  ctx.drawImage(base, -(p.x - ox) * k, -(p.z - oz) * k, base.width * m, base.height * m);
  // police
  for (const c of w.police.cars) {
    const t = c.body.translation();
    ctx.fillStyle = Math.floor(w.time * 4) % 2 ? '#ef476f' : '#3a86ff';
    ctx.beginPath();
    ctx.arc((t.x - p.x) * k, (t.z - p.z) * k, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // street names (clipped to the round map)
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.clip();
  drawLabels(p.x, p.z, yaw, k, r);
  ctx.restore();
  // job markers (clamped to the edge when far away)
  for (const mk of w.jobs.markers()) {
    const dx = (mk.x - p.x) * k, dz = (mk.z - p.z) * k;
    let sx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    let sz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const d = Math.hypot(sx, sz);
    if (d > r - 8) { sx *= (r - 8) / d; sz *= (r - 8) / d; }
    ctx.fillStyle = mk.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r + sx, r + sz, mk.kind === 'tip' ? 5 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // your own cars (parked): a green car shape, kept on the rim when far away so you can find it
  let owned = 0;
  for (const v of w.vehicles) {
    if (!v.owned || v.driven) continue;
    owned++;
    const dx = (v.px - p.x) * k, dz = (v.pz - p.z) * k;
    let sx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    let sz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const d = Math.hypot(sx, sz);
    if (d > r - 9) { sx *= (r - 9) / d; sz *= (r - 9) / d; }
    ctx.save();
    ctx.translate(r + sx, r + sz);
    ctx.rotate(-(v.heading - yaw) + Math.PI);
    ctx.fillStyle = '#06d6a0';
    ctx.strokeStyle = '#04332a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-3.5, -6, 7, 12, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#04332a';
    ctx.fillRect(-2.5, -3.5, 5, 2.2); // windscreen: shows which way it faces
    ctx.restore();
  }
  minimapStats.ownedCars = owned;
  // player arrow (heading relative to camera)
  const heading = w.player.vehicle ? w.player.vehicle.heading : w.player.facing;
  ctx.save();
  ctx.translate(r, r);
  ctx.rotate(-(heading - yaw) + Math.PI);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(6, 7);
  ctx.lineTo(0, 3);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
