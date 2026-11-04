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
  c.drawMinimapBase(g, { scale, ox, oz, width: base.width, height: base.height });
  buildLabels(w);
  // taxi ranks and car dealerships are drawn on top each frame at a fixed size (painted into the base image they
  // shrank to a pixel or two at the minimap's zoom)
  badgeX.length = badgeZ.length = badgeKind.length = 0;
  for (const r of c.taxiRanks) { badgeX.push(r.curbX); badgeZ.push(r.curbZ); badgeKind.push(0); }
  const dealer = w.jobs.get<DealershipJob>('dealership');
  for (const site of dealer?.sites ?? []) {
    // the badge sits by the showroom cars (a car park can be a little way from the place's door)
    const sl = site.slots[0];
    badgeX.push(sl ? (sl.x + site.x) / 2 : site.x);
    badgeZ.push(sl ? (sl.z + site.z) / 2 : site.z);
    badgeKind.push(1);
    minimapStats.dealerships++;
  }
}

// fixed-size badges: taxi ranks (0) and car dealerships (1)
const badgeX: number[] = [];
const badgeZ: number[] = [];
const badgeKind: number[] = [];
/** Badges within the minimap circle, upright, at a size you can read (`k`: px per metre; (r, r) the centre). */
function drawBadges(px: number, pz: number, yaw: number, k: number, r: number): void {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), lim = (r - 10) * (r - 10);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < badgeX.length; i++) {
    const dx = (badgeX[i] - px) * k, dz = (badgeZ[i] - pz) * k;
    const sx = dx * cy - dz * sy, sz = dx * sy + dz * cy;
    if (sx * sx + sz * sz > lim) continue;
    const dealer = badgeKind[i] === 1;
    const rad = dealer ? H.minimapDealerBadgePx : H.minimapRankBadgePx;
    ctx.fillStyle = dealer ? '#1d4ed8' : '#f4c430';
    ctx.strokeStyle = dealer ? '#ffffff' : '#3d2c00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r + sx, r + sz, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = dealer ? '#ffffff' : '#3d2c00';
    ctx.font = `bold ${Math.round(rad * 1.35)}px system-ui, sans-serif`;
    ctx.fillText(dealer ? '$' : 'T', r + sx, r + sz + 0.5);
  }
}

// ---------- street-name labels (drawn upright along the road, on top of the rotating map) ----------
const labelText: string[] = [];
let labelX = new Float32Array(0);
let labelZ = new Float32Array(0);
let labelAng = new Float32Array(0);
let labelW = new Float32Array(0); // text width in pixels
const LABEL_FONT = `600 ${H.minimapLabelPx}px system-ui, sans-serif`;
const RANK: Record<string, number> = { primary: 0, parkway: 1, secondary: 2, tertiary: 3, residential: 4, service: 5 };

/**
 * Anchor points for every named street: its middle if short, else one every minimapLabelSpacing metres. Major
 * streets first (they win where labels would overlap). Names lose a trailing quadrant (" NW"): the minimap is small.
 */
function buildLabels(w: World): void {
  const items: { x: number; z: number; a: number; text: string; rank: number }[] = [];
  for (const st of w.city.streets) {
    if (!st.name) continue;
    const p = st.pts;
    let total = 0;
    for (let k = 2; k < p.length; k += 2) total += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    if (total < H.minimapLabelMinLength) continue;
    const text = st.name.replace(/\s+(NW|NE|SW|SE)$/, '');
    const step = H.minimapLabelSpacing;
    const first = total < step ? total / 2 : step / 2;
    for (let at = first; at < total; at += step) {
      // walk to the segment holding `at`
      let run = 0;
      for (let k = 2; k < p.length; k += 2) {
        const sl = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
        if (run + sl >= at || k === p.length - 2) {
          const t = sl > 0 ? Math.min(1, (at - run) / sl) : 0;
          items.push({ x: p[k - 2] + (p[k] - p[k - 2]) * t, z: p[k - 1] + (p[k + 1] - p[k - 1]) * t, a: Math.atan2(p[k + 1] - p[k - 1], p[k] - p[k - 2]), text, rank: RANK[st.cls] ?? 9 });
          break;
        }
        run += sl;
      }
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  labelText.length = 0;
  ctx.font = LABEL_FONT;
  labelX = Float32Array.from(items, (i) => i.x);
  labelZ = Float32Array.from(items, (i) => i.z);
  labelAng = Float32Array.from(items, (i) => i.a);
  labelW = Float32Array.from(items, (i) => ctx.measureText(i.text).width);
  for (const i of items) labelText.push(i.text);
}

// labels placed this frame (screen boxes and which label) for the overlap and repeat tests
const placed = new Float32Array(4 * 48);
const placedIdx = new Int32Array(48);
/**
 * Street names near the player, upright and along their road. `k`: px per metre; (r, r) the centre. A label is left
 * out where it would overlap one already drawn, run past the rim, or repeat the same name close by.
 */
function drawLabels(px: number, pz: number, yaw: number, k: number, r: number): void {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round'; // mitred joins drew spikes round the letters
  ctx.strokeStyle = 'rgba(16,20,28,0.85)';
  ctx.fillStyle = '#f4f1e8';
  const cy = Math.cos(yaw), sy = Math.sin(yaw), th = H.minimapLabelPx * 0.6 + 2, pad = H.minimapLabelGapPx;
  let n = 0;
  for (let i = 0; i < labelText.length && n < placedIdx.length; i++) {
    const dx = (labelX[i] - px) * k, dz = (labelZ[i] - pz) * k;
    const sx = dx * cy - dz * sy, sz = dx * sy + dz * cy;
    let a = labelAng[i] + yaw;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (a > Math.PI / 2) a -= Math.PI;
    else if (a <= -Math.PI / 2) a += Math.PI;
    const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a)), hw = labelW[i] / 2 + 2;
    const bx = ca * hw + sa * th, bz = sa * hw + ca * th; // half size of the rotated label's screen box
    if (Math.hypot(sx, sz) + Math.max(bx, bz) > r - 4) continue;
    let clash = false;
    for (let j = 0; j < n && !clash; j++) {
      const o = j * 4;
      if (Math.abs(sx - placed[o]) < bx + placed[o + 2] + pad && Math.abs(sz - placed[o + 1]) < bz + placed[o + 3] + pad) clash = true;
      else if (labelText[placedIdx[j]] === labelText[i] && Math.hypot(sx - placed[o], sz - placed[o + 1]) < H.minimapLabelRepeatPx) clash = true;
    }
    if (clash) continue;
    const o = n * 4;
    placed[o] = sx; placed[o + 1] = sz; placed[o + 2] = bx; placed[o + 3] = bz;
    placedIdx[n++] = i;
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
  drawBadges(p.x, p.z, yaw, k, r);
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
