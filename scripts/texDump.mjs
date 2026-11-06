// Dump the baked surface arrays (render/texBake.ts + render/texLibrary.ts) of a build as one contact sheet, read back
// from the GPU after boot: every layer's albedo (and with --nrm its normal/roughness map), one mip level, labelled,
// plus the per-layer texel statistics (linear luminance mean, sd/mean, 10th-90th percentile ratio).
//
//   node scripts/texDump.mjs [--dist dist] [--quality medium] [--level 1] [--nrm] [--out file.png]
//
// The dist folder is served read-only. Exit code 1 on any console error or warning.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
const dist = resolve(opt('dist', 'dist'));
const quality = opt('quality', 'medium');
const level = Number(opt('level', '1'));
const nrm = flag('nrm');
const out = resolve(opt('out', 'screenshots/texdump.png'));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = resolve(join(dist, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname)));
  if (p !== dist && !p.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(p); res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(600000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/?quality=${quality}`);
await page.waitForFunction(() => window.__oc && window.__oc.look && window.__oc.look.maps, null, { timeout: 600000, polling: 250 });
const res = await page.evaluate(({ level, nrm }) => {
  const w = window.__oc, look = w.look, r = w.renderer, gl = r.getContext();
  const T = (nrm ? look.maps.nrm : look.maps.alb).texture;
  const tex = r.properties.get(T).__webglTexture;
  const n = Math.max(1, look.maps.res >> level), L = look.maps.layers;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const cols = 7, rows = Math.ceil(L / cols), lab = 14;
  const cv = document.createElement('canvas');
  cv.width = cols * n; cv.height = rows * (n + lab);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = '11px sans-serif';
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const stats = [];
  for (let i = 0; i < L; i++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, level, i);
    const buf = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const img = ctx.createImageData(n, n);
    const Y = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const s = ((n - 1 - y) * n + x) * 4, d = (y * n + x) * 4;
      img.data[d] = buf[s]; img.data[d + 1] = buf[s + 1]; img.data[d + 2] = buf[s + 2]; img.data[d + 3] = 255;
      Y[y * n + x] = 0.2126 * lin(buf[s]) + 0.7152 * lin(buf[s + 1]) + 0.0722 * lin(buf[s + 2]);
    }
    const cx = (i % cols) * n, cy = Math.floor(i / cols) * (n + lab);
    ctx.putImageData(img, cx, cy);
    const sorted = Float32Array.from(Y).sort();
    let m = 0, s2 = 0; for (const v of Y) { m += v; s2 += v * v; } m /= Y.length; const sd = Math.sqrt(Math.max(0, s2 / Y.length - m * m));
    const p10 = sorted[Math.floor(Y.length * 0.1)], p90 = sorted[Math.floor(Y.length * 0.9)];
    stats.push({ layer: i, mean: +m.toFixed(3), sdPct: +(100 * sd / Math.max(m, 1e-6)).toFixed(1), p90p10: +(p90 / Math.max(p10, 1e-6)).toFixed(2) });
    ctx.fillStyle = '#fff';
    ctx.fillText(`${i} ${(window.__ocLayerNames || [])[i] ?? ''}`, cx + 3, cy + n + 11);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return { png: cv.toDataURL('image/png'), stats, lib: { sets: look.library.sets, failed: look.library.failed, ms: look.library.ms }, res: look.maps.res };
}, { level, nrm });
await writeFile(out, Buffer.from(res.png.split(',')[1], 'base64'));
console.log(`res ${res.res}, level ${level}: ${out}\nlibrary: ${JSON.stringify(res.lib)}`);
for (const s of res.stats) console.log(`  layer ${String(s.layer).padStart(2)}  mean ${s.mean}  sd/mean ${s.sdPct}%  p90/p10 ${s.p90p10}`);
console.log(errors.length ? errors.join('\n') : '  console clean');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
