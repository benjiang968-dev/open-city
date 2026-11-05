// Experiments for docs/visual-audit.md, run through scripts/viewShots.mjs:
//   node scripts/viewShots.mjs --dist <dist> --prefix <p> --exp scripts/viewExperiments.js road-far road-far@nomip ...
// This file is the body of a function (w, view, variant), evaluated in the page right before a view is captured
// (w = window.__oc). Every variant sets the whole experiment state, so variants can follow each other in one run.
// It uses only what the BEFORE build (c109c1c) already has, so the same experiment runs on both builds.
//
// Variants (empty = the game as it is):
//   texinfo   no change; notes the texture setup (formats, colour spaces, mipmaps, filtering, anisotropy) and reads the
//             baked asphalt and paint maps back from the GPU, level by level, to check the mip chain is real
//   nomip     surface maps sampled at mip level 0 only (what missing mipmaps would look like)
//   avgalb    every surface's albedo replaced by its whole-tile average (the last mip level): what is left is lighting,
//             normal maps, macro variation and geometry
//   nonrm     normal, roughness and occlusion maps off (uDetail 0, as on the Low preset)
//   nomacro   no large-scale macro brightness variation
//   miplod    false colour of the mip level each pixel reads (0 red, 1 orange, 2 yellow, 3 green, 4 cyan, 5 blue, 6+ violet)
//   noshadow  sun shadows off (shadow intensity 0): shadow acne check
//   a2coff    leaf cards without alpha to coverage (hard alpha test only)
//   nocards   near trees without their leaf cards (trunk, branches and the inner crown alone)
//   wire      every material drawn as wireframe (geometry density and depth)
//   env0 hemi0 sun0 onlysun   sky light (environment) off / hemisphere fill off / sun off / sun only
//   envspec0 envdiff0         only the sky reflections (indirect specular) off / only the sky's diffuse light off
//                             (every material with the game's shader patch: world, facades, cars, people)
//   exp1 exp07                tone mapping exposure 1.0 / 0.7 (game: 0.86 by day)
//   agx neutral notm          AgX / Khronos neutral / no tone mapping instead of ACES filmic
//   nofog                     fog pushed out of sight
//   skydiff1                  all of the sky light on diffuse surfaces (game: 0.42 by day)
//   zfight    no change; overlap / z-fighting probe of the ground and decal chunk meshes (geo-ground-*, geo-decal-*:
//             world space, merged per chunk) over four study boxes (the rep block, M St / Wisconsin, Wisconsin Ave,
//             N St): a 0.2 m grid of samples, every covering triangle found exactly, and counted: ground triangles
//             within 3 cm of the top one (coplanar overlaps; whether the two top surfaces differ), markings less than
//             5 mm above the top ground or under it, paint on paint within 3 mm
const look = w.look;
const T = { ACES: 4, AGX: 6, NEUTRAL: 7, NONE: 0 };
// ---- one-time shader patch: a uniform switch in the shared world/facade surface sampler
if (!w.__vsPatched) {
  w.__vsPatched = true;
  w.__vsDetail0 = look.uniforms.uDetail.value;
  look.uniforms.uVsMode = { value: 0 };
  const seen = new Set();
  w.scene.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      if (seen.has(m) || !m.onBeforeCompile || !m.customProgramCacheKey) continue;
      const key = m.customProgramCacheKey();
      if (!/^oc-/.test(key)) continue;
      seen.add(m);
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (sh, r) => {
        prev(sh, r);
        sh.uniforms.uVsMode = look.uniforms.uVsMode;
        // declared at the top of every patched shader (world, facade, car and people materials all get the lighting
        // switches; the sampler switches only touch shaders that have the world sampler)
        sh.fragmentShader = 'uniform float uVsMode;\n' + sh.fragmentShader
          .replace('vec4 ta = textureGrad(uAlbTex, vec3(tuv, A.x), gx, gy);',
            'vec4 ta = uVsMode == 1.0 ? textureLod(uAlbTex, vec3(tuv, A.x), 0.0) : uVsMode == 2.0 ? textureLod(uAlbTex, vec3(tuv, A.x), 20.0) : textureGrad(uAlbTex, vec3(tuv, A.x), gx, gy);')
          .replace('vec4 tn = uDetail > 0.5 ? textureGrad(uNrmTex, vec3(tuv, A.x), gx, gy)',
            'vec4 tn = uDetail > 0.5 ? (uVsMode == 1.0 ? textureLod(uNrmTex, vec3(tuv, A.x), 0.0) : textureGrad(uNrmTex, vec3(tuv, A.x), gx, gy))')
          .replace('float mac = (m1.r - 0.5) * 0.7 + (m2.g - 0.5) * 0.5;', 'float mac = uVsMode == 5.0 ? 0.0 : (m1.r - 0.5) * 0.7 + (m2.g - 0.5) * 0.5;')
          .replace('vec3 totalDiffuse = ', 'if (uVsMode == 7.0) reflectedLight.indirectSpecular = vec3(0.0);\nif (uVsMode == 8.0) reflectedLight.indirectDiffuse = vec3(0.0);\nvec3 totalDiffuse = ')
          .replace(/\n  return o;\n}/, `
  if (uVsMode == 6.0 && textured > 0.5) {
    float vsL = log2(max(max(length(gx), length(gy)) * float(textureSize(uAlbTex, 0).x), 1e-6));
    vec3 vsC[7] = vec3[7](vec3(1,0,0), vec3(1,0.5,0), vec3(1,1,0), vec3(0,1,0), vec3(0,1,1), vec3(0,0.3,1), vec3(0.6,0,1));
    o.alb = vsC[int(clamp(floor(vsL), 0.0, 6.0))] * 0.5; o.nW = Ng; o.rough = 1.0; o.metal = 0.0;
  }
  return o;
}`);
      };
      m.customProgramCacheKey = () => key + '-vs';
      m.needsUpdate = true;
    }
  });
  // state the game resets every frame (exposure, sky light, sun, hemisphere, fog, sky share) is applied again right
  // before each draw of the scene
  const orig = w.renderer.render.bind(w.renderer);
  w.renderer.render = (s, c) => { if (window.__vsApply) window.__vsApply(); return orig(s, c); };
}
const modes = { nomip: 1, avgalb: 2, nomacro: 5, miplod: 6, envspec0: 7, envdiff0: 8 };
look.uniforms.uVsMode.value = modes[variant] ?? 0;
look.uniforms.uDetail.value = variant === 'nonrm' ? 0 : w.__vsDetail0;
const leafMats = new Set();
w.scene.traverse((o) => {
  if (/^trees-near-leaves-/.test(o.name)) { o.visible = variant !== 'nocards'; leafMats.add(o.material); }
  const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
  for (const m of ms) if ('wireframe' in m) m.wireframe = variant === 'wire';
});
for (const m of leafMats) { const want = variant !== 'a2coff'; if (m.alphaToCoverage !== want) { m.alphaToCoverage = want; m.needsUpdate = true; } }
window.__vsApply = () => {
  const dn = w.dayNight, r = w.renderer;
  r.toneMapping = variant === 'agx' ? T.AGX : variant === 'neutral' ? T.NEUTRAL : variant === 'notm' ? T.NONE : T.ACES;
  if (variant === 'exp1') r.toneMappingExposure = 1.0;
  if (variant === 'exp07') r.toneMappingExposure = 0.7;
  if (variant === 'env0' || variant === 'onlysun') w.scene.environmentIntensity = 0;
  if (variant === 'hemi0' || variant === 'onlysun') dn.hemi.intensity = 0;
  if (variant === 'sun0') dn.sun.intensity = 0;
  if (variant === 'nofog') { w.scene.fog.near = 1e5; w.scene.fog.far = 1e6; }
  if (variant === 'skydiff1') look.uniforms.uSkyDiffuse.value = 1;
  if (dn.sun.shadow && 'intensity' in dn.sun.shadow) dn.sun.shadow.intensity = variant === 'noshadow' ? 0 : 1;
  window.__vsLight = { exposure: r.toneMappingExposure, toneMapping: r.toneMapping, env: w.scene.environmentIntensity, sun: dn.sun.intensity, sunColor: dn.sun.color.getHexString(), hemi: dn.hemi.intensity, hemiSky: dn.hemi.color.getHexString(), hemiGround: dn.hemi.groundColor.getHexString(), skyDiffuse: look.uniforms.uSkyDiffuse.value, fog: [w.scene.fog.near, w.scene.fog.far, w.scene.fog.color.getHexString()] };
};
if (variant === 'texinfo') {
  const r = w.renderer, gl = r.getContext();
  const A = look.maps.alb.texture, N = look.maps.nrm.texture, M = look.maps.macro.texture;
  const desc = (t) => ({ colorSpace: t.colorSpace, format: t.format, type: t.type, generateMipmaps: t.generateMipmaps, minFilter: t.minFilter, magFilter: t.magFilter, anisotropy: t.anisotropy, wrap: [t.wrapS, t.wrapT] });
  const fac = [];
  w.scene.traverse((o) => { if (o.material && o.material.name === 'geo-facade' && o.material.userData.facadeTex && !fac.length) { const t = o.material.userData.facadeTex; fac.push({ ...desc(t), size: [t.image.width, t.image.height, t.image.depth] }); } });
  const res = look.maps.res;
  const tex = r.properties.get(A).__webglTexture, ntex = r.properties.get(N).__webglTexture;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const read = (t, level, layer) => {
    const n = Math.max(1, res >> level);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, level, layer);
    const buf = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { n, buf };
  };
  // sRGB byte -> linear
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const stats = ({ n, buf }) => {
    let s = 0, s2 = 0, c = 0, mn = 1e9, mx = -1e9;
    const L = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) { const y = 0.2126 * lin(buf[i * 4]) + 0.7152 * lin(buf[i * 4 + 1]) + 0.0722 * lin(buf[i * 4 + 2]); L[i] = y; s += y; s2 += y * y; mn = Math.min(mn, y); mx = Math.max(mx, y); }
    const m = s / (n * n), sd = Math.sqrt(Math.max(0, s2 / (n * n) - m * m));
    // correlation of each texel with its right-hand neighbour (1 = smooth, 0 = independent noise per texel)
    let cov = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cov += (L[y * n + x] - m) * (L[y * n + ((x + 1) % n)] - m);
    c = sd > 0 ? cov / (n * n) / (sd * sd) : 1;
    // 10th / 90th percentiles of linear luminance (contrast of the material itself)
    const sorted = Array.from(L).sort((a, b) => a - b);
    return { n, mean: +m.toFixed(4), sd: +sd.toFixed(4), min: +mn.toFixed(4), max: +mx.toFixed(4), p10: +sorted[Math.floor(n * n * 0.1)].toFixed(4), p90: +sorted[Math.floor(n * n * 0.9)].toFixed(4), nbrCorr: +c.toFixed(3) };
  };
  const slope = ({ n, buf }) => { let s = 0, big = 0; for (let i = 0; i < n * n; i++) { const x = buf[i * 4] / 127.5 - 1, y = buf[i * 4 + 1] / 127.5 - 1; const t = Math.hypot(x, y); s += t; if (t > 0.3) big++; } return { meanTilt: +(s / (n * n)).toFixed(3), over0_3: +(big / (n * n)).toFixed(3), rough: +(Array.from({ length: Math.min(4096, n * n) }, (_, i) => buf[i * 4 + 2]).reduce((a, b) => a + b, 0) / Math.min(4096, n * n) / 255).toFixed(3) }; };
  const levels = Math.log2(res) + 1;
  const asphalt = [], paint = [];
  for (const lv of [0, 1, 2, 3, 4, 6, levels - 1]) { asphalt.push({ level: lv, ...stats(read(tex, lv, 0)) }); paint.push({ level: lv, ...stats(read(tex, lv, 1)) }); }
  const nrm0 = slope(read(ntex, 0, 0)), nrm3 = slope(read(ntex, 3, 0));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  r.resetState();
  const caps = { maxAnisotropy: r.capabilities.getMaxAnisotropy(), samples: gl.getParameter(gl.SAMPLES), maxTextures: r.capabilities.maxTextures, outputColorSpace: r.outputColorSpace, toneMapping: r.toneMapping, shadowType: r.shadowMap.type };
  window.__vsNote = JSON.stringify({ res, texelMm: +(4000 / res).toFixed(2), alb: desc(A), nrm: desc(N), macro: desc(M), facade: fac[0], caps, asphalt, paint, asphaltNormal: { level0: nrm0, level3: nrm3 }, light: window.__vsLight ?? null });
} else if (variant === 'zfight') {
  const boxes = {
    'M St 3200 (rep, road-far)': [-330, -170, 118, 178],
    'M St / Wisconsin junction': [-175, -120, 110, 175],
    'Wisconsin Ave (street3)': [-175, -130, 20, 110],
    'N St 3300 (street2)': [-570, -420, -45, -10],
  };
  const tris = { ground: [], decal: [] };
  w.scene.traverse((o) => {
    const m = /^geo-(ground|decal)-/.exec(o.name);
    if (!m || !o.geometry) return;
    const g = o.geometry, P = g.attributes.position.array, S = g.attributes.aSurf ? g.attributes.aSurf.array : null;
    const I = g.index ? g.index.array : null;
    const n = I ? I.length / 3 : P.length / 9;
    for (let t = 0; t < n; t++) {
      const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
      tris[m[1]].push([P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2], S ? S[a] : -1, o.name]);
    }
  });
  const out = {};
  for (const [bn, [x0, x1, z0, z1]] of Object.entries(boxes)) {
    const cell = 0.5, nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
    const grid = { ground: new Map(), decal: new Map() };
    for (const kind of ['ground', 'decal']) {
      for (const T of tris[kind]) {
        const mnx = Math.min(T[0], T[3], T[6]), mxx = Math.max(T[0], T[3], T[6]), mnz = Math.min(T[2], T[5], T[8]), mxz = Math.max(T[2], T[5], T[8]);
        if (mxx < x0 || mnx > x1 || mxz < z0 || mnz > z1) continue;
        const ix0 = Math.max(0, Math.floor((mnx - x0) / cell)), ix1 = Math.min(nx - 1, Math.floor((mxx - x0) / cell));
        const iz0 = Math.max(0, Math.floor((mnz - z0) / cell)), iz1 = Math.min(nz - 1, Math.floor((mxz - z0) / cell));
        for (let i = ix0; i <= ix1; i++) for (let j = iz0; j <= iz1; j++) { const k = i * 100000 + j; let l = grid[kind].get(k); if (!l) grid[kind].set(k, (l = [])); l.push(T); }
      }
    }
    const hits = (kind, x, z) => {
      const l = grid[kind].get(Math.floor((x - x0) / cell) * 100000 + Math.floor((z - z0) / cell));
      const r = [];
      if (!l) return r;
      for (const T of l) {
        const ax = T[0], az = T[2], bx = T[3], bz = T[5], cx = T[6], cz = T[8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-9) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, s = 1 - u - v;
        if (u < -1e-6 || v < -1e-6 || s < -1e-6) continue;
        r.push({ y: u * T[1] + v * T[4] + s * T[7], surf: T[9], mesh: T[10] });
      }
      return r.sort((p, q) => q.y - p.y);
    };
    let samples = 0, covered = 0, gg0 = 0, gg5 = 0, gg30 = 0, ggDiff = 0, dg = 0, dgBelow = 0, dd = 0, decalSamples = 0;
    const pairs = {}, where = [];
    const step = 0.2;
    for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
      samples++;
      const G = hits('ground', x, z);
      if (!G.length) continue;
      covered++;
      // distinct triangles at (nearly) the same height as the top one
      const top = G[0];
      const near = G.slice(1).filter((h) => top.y - h.y < 0.03);
      if (near.length) {
        const gap = top.y - near[0].y;
        if (gap < 1e-4) gg0++; else if (gap < 0.005) gg5++; else gg30++;
        if (near[0].surf !== top.surf) {
          ggDiff++;
          const k = `${top.surf}/${near[0].surf}`; pairs[k] = (pairs[k] ?? 0) + 1;
          if (where.length < 12 && gap > 1e-4) where.push([+x.toFixed(1), +z.toFixed(1), +gap.toFixed(4), k]);
        }
      }
      const D = hits('decal', x, z);
      if (D.length) {
        decalSamples++;
        const lift = D[0].y - top.y;
        if (lift < 0) dgBelow++; else if (lift < 0.005) dg++;
        if (D.length > 1 && D[0].y - D[1].y < 0.003) dd++;
      }
    }
    const pc = (a, b) => +(100 * a / Math.max(1, b)).toFixed(2);
    out[bn] = {
      samples, coveredPct: pc(covered, samples),
      groundOverlapWithin3cmPct: pc(gg0 + gg5 + gg30, covered), exactCoplanarPct: pc(gg0, covered), gapUnder5mmPct: pc(gg5, covered), gap5to30mmPct: pc(gg30, covered),
      differentSurfaceOnTopPct: pc(ggDiff, covered), surfacePairs: pairs, examples: where,
      decalSamples, decalLiftUnder5mmPct: pc(dg, decalSamples), decalBelowGroundPct: pc(dgBelow, decalSamples), decalOnDecalWithin3mmPct: pc(dd, decalSamples),
    };
  }
  window.__vsNote = JSON.stringify({ tris: { ground: tris.ground.length, decal: tris.decal.length }, boxes: out });
} else {
  window.__vsNote = variant ? `variant ${variant}` : '';
}
