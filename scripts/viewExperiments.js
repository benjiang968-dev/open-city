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
//   exp1 exp07                tone mapping exposure 1.0 / 0.7 (game: 0.86 by day)
//   agx neutral notm          AgX / Khronos neutral / no tone mapping instead of ACES filmic
//   nofog                     fog pushed out of sight
//   skydiff1                  all of the sky light on diffuse surfaces (game: 0.42 by day)
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
        sh.fragmentShader = sh.fragmentShader
          .replace('uniform float uSkyDiffuse;', 'uniform float uSkyDiffuse;\nuniform float uVsMode;')
          .replace('vec4 ta = textureGrad(uAlbTex, vec3(tuv, A.x), gx, gy);',
            'vec4 ta = uVsMode == 1.0 ? textureLod(uAlbTex, vec3(tuv, A.x), 0.0) : uVsMode == 2.0 ? textureLod(uAlbTex, vec3(tuv, A.x), 20.0) : textureGrad(uAlbTex, vec3(tuv, A.x), gx, gy);')
          .replace('vec4 tn = uDetail > 0.5 ? textureGrad(uNrmTex, vec3(tuv, A.x), gx, gy)',
            'vec4 tn = uDetail > 0.5 ? (uVsMode == 1.0 ? textureLod(uNrmTex, vec3(tuv, A.x), 0.0) : textureGrad(uNrmTex, vec3(tuv, A.x), gx, gy))')
          .replace('float mac = (m1.r - 0.5) * 0.7 + (m2.g - 0.5) * 0.5;', 'float mac = uVsMode == 5.0 ? 0.0 : (m1.r - 0.5) * 0.7 + (m2.g - 0.5) * 0.5;')
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
const modes = { nomip: 1, avgalb: 2, nomacro: 5, miplod: 6 };
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
  w.__vsLight = { exposure: r.toneMappingExposure, toneMapping: r.toneMapping, env: w.scene.environmentIntensity, sun: dn.sun.intensity, sunColor: dn.sun.color.getHexString(), hemi: dn.hemi.intensity, hemiSky: dn.hemi.color.getHexString(), hemiGround: dn.hemi.groundColor.getHexString(), skyDiffuse: look.uniforms.uSkyDiffuse.value, fog: [w.scene.fog.near, w.scene.fog.far, w.scene.fog.color.getHexString()] };
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
  window.__vsNote = JSON.stringify({ res, texelMm: +(4000 / res).toFixed(2), alb: desc(A), nrm: desc(N), macro: desc(M), facade: fac[0], caps, asphalt, paint, asphaltNormal: { level0: nrm0, level3: nrm3 }, light: w.__vsLight ?? null });
} else {
  window.__vsNote = variant ? `variant ${variant}` : '';
}
