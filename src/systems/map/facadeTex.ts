// Facade tiles for the Georgetown buildings, drawn in code on canvases and packed into one texture array (one layer per
// tile: a window bay, a door, a shopfront, roof surfaces...). Alpha encodes what the shader does with a pixel:
// 255 = wall (tinted by the building's vertex colour), 128 = glass (lit at night), 0 = fixed colour (frames, doors).
import * as THREE from 'three';

export const TILE = {
  PLAIN: 0, ROW_SHUT: 1, ROW_WIN: 2, DOOR_BLACK: 3, DOOR_RED: 4, DOOR_NAVY: 5, SHOP: 6, SHOP_DOOR: 7, OFFICE: 8,
  CURTAIN: 9, WARE: 10, LOADING: 11, CHURCH: 12, UNIV: 13, ROOF_FLAT: 14, ROOF_SLATE: 15, STONE: 16, ARCH: 17,
  APT: 18, PLINTH: 19, DOOR_GREEN: 20, SMOOTH: 21, BELFRY: 22, BOATDOOR: 23,
} as const;
const COUNT = 24;
const S = 128; // px per tile

type Ctx = CanvasRenderingContext2D;
interface Pen {
  c: Ctx; // colour
  m: Ctx; // mask
}
const MASK = { wall: '#ffffff', glass: '#808080', fixed: '#000000' };

function rect(p: Pen, x: number, y: number, w: number, h: number, col: string, mask: keyof typeof MASK) {
  p.c.fillStyle = col;
  p.c.fillRect(x, y, w, h);
  p.m.fillStyle = MASK[mask];
  p.m.fillRect(x, y, w, h);
}
function shape(p: Pen, path: (c: Ctx) => void, col: string, mask: keyof typeof MASK) {
  for (const [c, st] of [[p.c, col], [p.m, MASK[mask]]] as [Ctx, string][]) {
    c.fillStyle = st;
    c.beginPath();
    path(c);
    c.fill();
  }
}
/** deterministic noise for textures */
function nz(i: number) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function brick(p: Pen, tone = 236, courses = 7) {
  rect(p, 0, 0, S, S, `rgb(${tone},${tone},${tone})`, 'wall');
  let k = 0;
  for (let y = 0; y < S; y += courses) {
    const off = ((y / courses) & 1) * 9;
    for (let x = -off; x < S; x += 18) {
      const v = tone - 10 + Math.round(nz(k++) * 18);
      p.c.fillStyle = `rgb(${v},${v - 2},${v - 3})`;
      p.c.fillRect(x + 1, y + 1, 16, courses - 1);
    }
  }
}
function smoothWall(p: Pen, tone = 240) {
  rect(p, 0, 0, S, S, `rgb(${tone},${tone},${tone})`, 'wall');
  for (let i = 0; i < 90; i++) {
    const v = tone - 6 + Math.round(nz(i) * 10);
    p.c.fillStyle = `rgb(${v},${v},${v})`;
    p.c.fillRect(Math.floor(nz(i + 7) * S), Math.floor(nz(i + 13) * S), 3, 2);
  }
}
function glass(p: Pen, x: number, y: number, w: number, h: number, tint = [52, 66, 82]) {
  const g = p.c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `rgb(${tint[0] + 40},${tint[1] + 46},${tint[2] + 50})`);
  g.addColorStop(0.45, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
  g.addColorStop(1, `rgb(${tint[0] - 12},${tint[1] - 12},${tint[2] - 10})`);
  p.c.fillStyle = g;
  p.c.fillRect(x, y, w, h);
  p.m.fillStyle = MASK.glass;
  p.m.fillRect(x, y, w, h);
}
function sash(p: Pen, x: number, y: number, w: number, h: number, frame = '#f1efe8', panesX = 3, panesY = 2) {
  rect(p, x - 4, y - 4, w + 8, h + 8, frame, 'fixed');
  glass(p, x, y, w, h);
  const half = h / 2;
  rect(p, x, y + half - 2, w, 4, frame, 'fixed');
  for (const [yy, hh] of [[y, half], [y + half, half]] as [number, number][]) {
    for (let i = 1; i < panesX; i++) rect(p, x + (w * i) / panesX - 1, yy, 2, hh, frame, 'fixed');
    for (let j = 1; j < panesY; j++) rect(p, x, yy + (hh * j) / panesY - 1, w, 2, frame, 'fixed');
  }
}
function shutters(p: Pen, x: number, y: number, w: number, h: number, col = '#2f4a3a') {
  rect(p, x, y, w, h, col, 'fixed');
  p.c.fillStyle = 'rgba(0,0,0,0.25)';
  for (let yy = y + 3; yy < y + h - 2; yy += 5) p.c.fillRect(x + 2, yy, w - 4, 2);
}
function stoneBand(p: Pen, x: number, y: number, w: number, h: number) {
  rect(p, x, y, w, h, '#d6cdbb', 'fixed');
  p.c.fillStyle = '#c2b8a4';
  p.c.fillRect(x, y + h - 2, w, 2);
}
function door(p: Pen, col: string) {
  brick(p);
  rect(p, 30, 14, 68, 114, '#f1efe8', 'fixed'); // surround
  rect(p, 24, 6, 80, 10, '#f1efe8', 'fixed'); // cornice
  shape(p, (c) => { c.moveTo(38, 22); c.lineTo(90, 22); c.lineTo(90, 40); c.lineTo(38, 40); }, '#000', 'glass');
  glass(p, 40, 24, 48, 15, [70, 64, 52]);
  for (let i = 1; i < 5; i++) rect(p, 40 + i * 9.6, 24, 1.5, 15, '#f1efe8', 'fixed');
  rect(p, 40, 42, 48, 86, col, 'fixed');
  p.c.fillStyle = 'rgba(255,255,255,0.08)';
  for (const [px, py] of [[44, 48], [66, 48], [44, 86], [66, 86]]) p.c.fillRect(px, py, 18, 32);
  p.c.fillStyle = '#c9a84a';
  p.c.fillRect(80, 86, 4, 4);
}

function drawTile(i: number, p: Pen) {
  const c = p.c;
  switch (i) {
    case TILE.PLAIN: brick(p); break;
    case TILE.SMOOTH: smoothWall(p); break;
    case TILE.ROW_SHUT:
      brick(p);
      stoneBand(p, 32, 12, 64, 8);
      shutters(p, 18, 20, 16, 74);
      shutters(p, 94, 20, 16, 74);
      sash(p, 40, 24, 48, 66);
      stoneBand(p, 32, 94, 64, 6);
      break;
    case TILE.ROW_WIN:
      brick(p);
      stoneBand(p, 34, 12, 60, 8);
      sash(p, 40, 24, 48, 66);
      stoneBand(p, 34, 94, 60, 6);
      break;
    case TILE.DOOR_BLACK: door(p, '#1d2023'); break;
    case TILE.DOOR_RED: door(p, '#7b2220'); break;
    case TILE.DOOR_NAVY: door(p, '#1f2c47'); break;
    case TILE.DOOR_GREEN: door(p, '#1f3f2d'); break;
    case TILE.SHOP:
    case TILE.SHOP_DOOR: {
      brick(p);
      rect(p, 0, 0, S, 24, '#2a2e33', 'fixed'); // fascia (signs go here)
      rect(p, 0, 24, S, 4, '#f0ede4', 'fixed');
      rect(p, 4, 28, 120, 76, '#2b2b2b', 'fixed');
      if (i === TILE.SHOP) {
        glass(p, 8, 32, 112, 70, [58, 70, 78]);
        rect(p, 62, 32, 4, 70, '#2b2b2b', 'fixed');
        rect(p, 8, 46, 112, 3, '#2b2b2b', 'fixed');
      } else {
        glass(p, 8, 32, 34, 70, [58, 70, 78]);
        glass(p, 86, 32, 34, 70, [58, 70, 78]);
        rect(p, 46, 30, 36, 98, '#2b2b2b', 'fixed');
        glass(p, 50, 34, 28, 90, [58, 70, 78]);
        rect(p, 72, 76, 3, 12, '#c9a84a', 'fixed');
      }
      // stall riser (tinted) under the window
      rect(p, 4, 104, 120, 24, '#d9d9d9', 'wall');
      break;
    }
    case TILE.OFFICE:
      smoothWall(p, 236);
      for (const x of [12, 70]) {
        rect(p, x - 2, 22, 50, 74, '#9aa0a4', 'fixed');
        glass(p, x, 24, 46, 70, [46, 62, 76]);
        rect(p, x + 22, 24, 2, 70, '#9aa0a4', 'fixed');
      }
      break;
    case TILE.CURTAIN:
      glass(p, 0, 0, S, 100, [44, 64, 80]);
      rect(p, 0, 100, S, 28, '#34414b', 'fixed');
      for (const x of [0, 42, 85]) rect(p, x, 0, 3, S, '#8f979c', 'fixed');
      rect(p, 0, 98, S, 3, '#8f979c', 'fixed');
      break;
    case TILE.WARE:
      brick(p, 232, 6);
      shape(p, (cc) => { cc.moveTo(12, 34); cc.quadraticCurveTo(64, 4, 116, 34); cc.lineTo(116, 40); cc.lineTo(12, 40); }, '#b8b8b8', 'wall');
      rect(p, 14, 32, 100, 70, '#3a3d40', 'fixed');
      glass(p, 18, 36, 92, 62, [60, 72, 80]);
      for (let x = 18; x < 110; x += 11.5) rect(p, x, 36, 2, 62, '#3a3d40', 'fixed');
      for (let y = 36; y < 98; y += 10.3) rect(p, 18, y, 92, 2, '#3a3d40', 'fixed');
      stoneBand(p, 10, 102, 108, 7);
      break;
    case TILE.LOADING:
      brick(p, 232, 6);
      rect(p, 12, 22, 104, 8, '#cfc6b4', 'fixed');
      rect(p, 16, 30, 96, 98, '#4b3a2b', 'fixed');
      c.fillStyle = 'rgba(0,0,0,0.25)';
      for (let x = 22; x < 112; x += 10) c.fillRect(x, 30, 2, 98);
      rect(p, 16, 76, 96, 4, '#3a2c20', 'fixed');
      break;
    case TILE.CHURCH:
      brick(p, 226, 9);
      shape(p, (cc) => { cc.moveTo(40, 112); cc.lineTo(40, 40); cc.quadraticCurveTo(42, 12, 64, 4); cc.quadraticCurveTo(86, 12, 88, 40); cc.lineTo(88, 112); }, '#d6cdbb', 'fixed');
      shape(p, (cc) => { cc.moveTo(46, 108); cc.lineTo(46, 42); cc.quadraticCurveTo(48, 18, 64, 11); cc.quadraticCurveTo(80, 18, 82, 42); cc.lineTo(82, 108); }, '#000', 'glass');
      for (let k = 0; k < 40; k++) {
        const cols = ['#3e5fa8', '#a8323a', '#d9a63a', '#3f8a5a', '#6a4aa0'];
        c.fillStyle = cols[k % cols.length];
        c.fillRect(46 + (k % 4) * 9, 18 + Math.floor(k / 4) * 9, 9, 9);
      }
      rect(p, 63, 14, 2, 94, '#d6cdbb', 'fixed');
      rect(p, 46, 60, 36, 2, '#d6cdbb', 'fixed');
      break;
    case TILE.UNIV:
      smoothWall(p, 228);
      rect(p, 30, 16, 68, 84, '#cfc8ba', 'fixed');
      glass(p, 36, 22, 56, 72, [50, 60, 70]);
      rect(p, 62, 22, 4, 72, '#cfc8ba', 'fixed');
      rect(p, 36, 46, 56, 4, '#cfc8ba', 'fixed');
      break;
    case TILE.ROOF_FLAT:
      rect(p, 0, 0, S, S, '#dcdcdc', 'wall');
      for (let k = 0; k < 400; k++) { const v = 190 + Math.round(nz(k) * 60); c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(nz(k + 3) * S, nz(k + 9) * S, 2, 2); }
      break;
    case TILE.ROOF_SLATE:
      rect(p, 0, 0, S, S, '#d8d8d8', 'wall');
      for (let y = 0; y < S; y += 10) {
        const off = ((y / 10) & 1) * 8;
        for (let x = -off; x < S; x += 16) { const v = 200 + Math.round(nz(x * 3 + y) * 40); c.fillStyle = `rgb(${v},${v},${v + 4})`; c.fillRect(x + 1, y + 1, 14, 8); }
      }
      break;
    case TILE.STONE:
      rect(p, 0, 0, S, S, '#e2e2e2', 'wall');
      for (let k = 0, y = 0; y < S; y += 14, k++) {
        for (let x = -(k % 3) * 7; x < S; x += 16 + (k % 4) * 3) { const v = 196 + Math.round(nz(x + y * 7) * 50); c.fillStyle = `rgb(${v},${v - 4},${v - 10})`; c.fillRect(x + 2, y + 2, 14 + (k % 4) * 3, 11); }
      }
      break;
    case TILE.ARCH:
      brick(p);
      shape(p, (cc) => { cc.moveTo(30, 102); cc.lineTo(30, 46); cc.arc(64, 46, 34, Math.PI, 0); cc.lineTo(98, 102); }, '#d6cdbb', 'fixed');
      shape(p, (cc) => { cc.moveTo(38, 98); cc.lineTo(38, 46); cc.arc(64, 46, 26, Math.PI, 0); cc.lineTo(90, 98); }, '#000', 'glass');
      glass(p, 38, 46, 52, 52, [50, 62, 74]);
      c.save(); c.beginPath(); c.arc(64, 46, 26, Math.PI, 0); c.clip(); glass(p, 38, 18, 52, 30, [62, 74, 86]); c.restore();
      rect(p, 62, 22, 4, 76, '#e8e4da', 'fixed');
      rect(p, 38, 60, 52, 3, '#e8e4da', 'fixed');
      break;
    case TILE.APT:
      smoothWall(p, 232);
      rect(p, 18, 20, 92, 76, '#a5a9ab', 'fixed');
      glass(p, 22, 24, 40, 68, [48, 62, 76]);
      glass(p, 66, 24, 40, 68, [48, 62, 76]);
      rect(p, 14, 70, 100, 3, '#2d3134', 'fixed');
      for (let x = 16; x < 114; x += 7) rect(p, x, 72, 2, 26, '#2d3134', 'fixed');
      rect(p, 14, 96, 100, 4, '#2d3134', 'fixed');
      break;
    case TILE.PLINTH:
      rect(p, 0, 0, S, S, '#dedad2', 'wall');
      for (let y = 0; y < S; y += 32) for (let x = (y / 32) % 2 ? -24 : 0; x < S; x += 48) { c.fillStyle = '#cbc6bb'; c.fillRect(x + 2, y + 2, 44, 28); }
      break;
    case TILE.BELFRY:
      smoothWall(p, 226);
      shape(p, (cc) => { cc.moveTo(36, 118); cc.lineTo(36, 50); cc.arc(64, 50, 28, Math.PI, 0); cc.lineTo(92, 118); }, '#2a2725', 'fixed');
      c.fillStyle = '#4c4640';
      for (let y = 40; y < 116; y += 8) c.fillRect(38, y, 52, 3);
      break;
    case TILE.BOATDOOR:
      smoothWall(p, 238);
      rect(p, 10, 18, 108, 110, '#e8e6df', 'fixed');
      rect(p, 16, 24, 96, 104, '#5a4632', 'fixed');
      c.fillStyle = 'rgba(0,0,0,0.25)';
      for (let x = 20; x < 112; x += 8) c.fillRect(x, 24, 2, 104);
      break;
  }
}

/**
 * Build the texture arrays at 2x the drawing size (TILE_PX): colour + tint mask (RGBA, sRGB, alpha 255 = the building's
 * wall surface shows through) and an aux array (RGBA, linear): R = glass mask (so filtering never turns a wall/frame mix
 * into "glass"), G/B = normal x/y from a relief derived from the masks (glass set back, frames proud of the glass), A =
 * occlusion inside window openings (darker under the lintel). Both repeat and are mipmapped.
 */
export const TILE_PX = S * 2;
export function makeFacadeTexture(): { tex: THREE.DataArrayTexture; aux: THREE.DataArrayTexture } {
  const P = TILE_PX;
  const data = new Uint8Array(P * P * 4 * COUNT);
  const aux = new Uint8Array(P * P * 4 * COUNT);
  const cc = document.createElement('canvas');
  const cm = document.createElement('canvas');
  cc.width = cm.width = P;
  cc.height = cm.height = P;
  const c = cc.getContext('2d', { willReadFrequently: true })!;
  const m = cm.getContext('2d', { willReadFrequently: true })!;
  const h = new Float32Array(P * P), wall = new Float32Array(P * P), tmp = new Float32Array(P * P);
  const PX_M = 0.012; // metres per pixel (a bay is 2.5-4.5 m, a storey 3.2 m)
  for (let i = 0; i < COUNT; i++) {
    for (const ctx of [c, m]) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, P, P); ctx.setTransform(P / S, 0, 0, P / S, 0, 0); }
    drawTile(i, { c, m });
    const col = c.getImageData(0, 0, P, P).data;
    const msk = m.getImageData(0, 0, P, P).data;
    const base = i * P * P * 4;
    for (let y = 0; y < P; y++) {
      const src = (P - 1 - y) * P * 4; // flip: row 0 of the texture is the bottom of the storey
      for (let x = 0; x < P; x++) {
        const mv = msk[src + x * 4];
        const o = base + (y * P + x) * 4;
        data[o] = col[src + x * 4];
        data[o + 1] = col[src + x * 4 + 1];
        data[o + 2] = col[src + x * 4 + 2];
        data[o + 3] = mv > 200 ? 255 : 0;
        const isGlass = mv >= 60 && mv <= 200;
        aux[o] = isGlass ? 255 : 0;
        h[y * P + x] = mv > 200 ? 0 : isGlass ? -0.08 : -0.03;
        wall[y * P + x] = mv > 200 ? 1 : 0;
      }
    }
    blur(h, tmp, P, 1); blur(h, tmp, P, 1);
    blur(wall, tmp, P, 5); blur(wall, tmp, P, 5);
    for (let y = 0; y < P; y++)
      for (let x = 0; x < P; x++) {
        const at = (xx: number, yy: number) => h[((yy + P) % P) * P + ((xx + P) % P)];
        const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * PX_M), dy = (at(x, y + 1) - at(x, y - 1)) / (2 * PX_M);
        const L = Math.hypot(dx, dy, 1);
        const o = base + (y * P + x) * 4;
        aux[o + 1] = Math.round((-dx / L * 0.5 + 0.5) * 255);
        aux[o + 2] = Math.round((-dy / L * 0.5 + 0.5) * 255);
        const self = data[o + 3] > 0 ? 1 : 0;
        const above = wall[Math.min(P - 1, y + 7) * P + x];
        const ao = self ? 1 : (1 - 0.4 * wall[y * P + x]) * (1 - 0.3 * above);
        aux[o + 3] = Math.round(Math.max(0, Math.min(1, ao)) * 255);
      }
  }
  const setup = (t: THREE.DataArrayTexture) => {
    t.type = THREE.UnsignedByteType;
    t.format = THREE.RGBAFormat;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
  };
  const tex = new THREE.DataArrayTexture(data, P, P, COUNT);
  tex.colorSpace = THREE.SRGBColorSpace;
  setup(tex);
  const auxTex = new THREE.DataArrayTexture(aux, P, P, COUNT);
  setup(auxTex);
  return { tex, aux: auxTex };
}

/** Separable box blur in place (wrapping), radius r px. */
function blur(a: Float32Array, tmp: Float32Array, P: number, r: number) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += a[y * P + ((x + d + P) % P)];
      tmp[y * P + x] = s * k;
    }
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[((y + d + P) % P) * P + x];
      a[y * P + x] = s * k;
    }
}
