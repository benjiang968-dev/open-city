// Minimap: pre-rendered city canvas, rotated around the player, with job markers, police, your own cars,
// car dealerships and the player arrow.
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
  scale = 1.2;
  ox = b.minX - 20;
  oz = b.minZ - 20;
  base = document.createElement('canvas');
  base.width = Math.ceil((b.maxX - b.minX + 40) * scale);
  base.height = Math.ceil((c.coastZ + 300 - oz) * scale);
  const g = base.getContext('2d')!;
  const X = (x: number) => (x - ox) * scale, Z = (z: number) => (z - oz) * scale;
  g.fillStyle = '#7da35a';
  g.fillRect(0, 0, base.width, base.height);
  g.fillStyle = '#2f7fb3';
  g.fillRect(0, Z(c.coastZ), base.width, base.height);
  g.fillStyle = '#cfc9bf';
  g.fillRect(X(c.xs[0] - 10), Z(c.zs[0] - 10), (c.xs[c.xs.length - 1] - c.xs[0] + 20) * scale, (c.zs[c.zs.length - 1] - c.zs[0] + 18) * scale);
  g.fillStyle = '#e9d8a6';
  g.fillRect(0, Z(c.zs[c.zs.length - 1] + 10), base.width, (c.coastZ - c.zs[c.zs.length - 1] - 10) * scale);
  g.fillStyle = '#6fa84f';
  for (const r of c.parkRects) g.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * scale, (r.z1 - r.z0) * scale);
  g.fillStyle = '#9a9aa3';
  for (const r of c.buildingRects) g.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * scale, (r.z1 - r.z0) * scale);
  g.fillStyle = '#3b3e45';
  for (let i = 0; i < c.xs.length; i++) g.fillRect(X(c.xs[i] - c.roadHalfX[i]), Z(c.zs[0] - c.roadHalfZ[0]), c.roadHalfX[i] * 2 * scale, (c.zs[c.zs.length - 1] - c.zs[0] + c.roadHalfZ[0] + c.roadHalfZ[c.zs.length - 1]) * scale);
  for (let j = 0; j < c.zs.length; j++) g.fillRect(X(c.xs[0] - c.roadHalfX[0]), Z(c.zs[j] - c.roadHalfZ[j]), (c.xs[c.xs.length - 1] - c.xs[0] + c.roadHalfX[0] * 2) * scale, c.roadHalfZ[j] * 2 * scale);
  g.fillStyle = '#a0754f';
  const pr = c.pierRect;
  g.fillRect(X(pr.x0), Z(pr.z0), (pr.x1 - pr.x0) * scale, (pr.z1 - pr.z0) * scale);
  for (const r of c.marinaRects) g.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * scale, (r.z1 - r.z0) * scale);
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
