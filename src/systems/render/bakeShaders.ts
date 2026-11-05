// GLSL for the procedural PBR bake (texBake.ts). Every material is a function of the tile uv that returns albedo (linear),
// a tint mask, height (metres), roughness and cavity occlusion; all noise is periodic over the tile, so the baked maps
// tile seamlessly. Original by construction: noise, cells and parametric layouts only, no photographs.
//
// Tiles are measured in metres (uSize), patterns are whole numbers of periods per tile (see surfaces.ts sizes).

export const BAKE_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}`;

/** GLSL3 ShaderMaterials declare their own output (three only aliases gl_FragColor for GLSL1). */
export const FRAG_OUT = 'layout(location = 0) out highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n';

const NOISE = /* glsl */ `
precision highp float;
precision highp int;
in vec2 vUv;
uniform vec2 uSize;   // tile size in metres
uniform int uMat;     // bake layer
uniform int uPass;    // 0 albedo+tint, 1 height/roughness/ao
uniform float uSeed;

uint ihash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float hash(vec2 p, int s) {
  ivec2 q = ivec2(floor(p + 0.5));
  uint h = ihash(uint(q.x) * 1597334677u ^ ihash(uint(q.y) * 3812015801u ^ uint(s + int(uSeed)) * 2798796415u));
  return float(h >> 8) / 16777215.0;
}
vec2 hash2(vec2 p, int s) { return vec2(hash(p, s), hash(p, s + 101)); }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
/** cells per tile for a feature size in metres (whole numbers, so every pattern tiles) */
vec2 cyc(float m) { return max(vec2(1.0), floor(uSize / m + 0.5)); }
vec2 cyc2(vec2 m) { return max(vec2(1.0), floor(uSize / m + 0.5)); }

// periodic gradient noise, about 0..1
float gnoise(vec2 uv, vec2 per, int s) {
  vec2 x = uv * per;
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 a = mod(i, per), b = mod(i + 1.0, per);
  float g00 = hash(a, s) * 6.2831853, g10 = hash(vec2(b.x, a.y), s) * 6.2831853;
  float g01 = hash(vec2(a.x, b.y), s) * 6.2831853, g11 = hash(b, s) * 6.2831853;
  float n00 = dot(vec2(cos(g00), sin(g00)), f);
  float n10 = dot(vec2(cos(g10), sin(g10)), f - vec2(1.0, 0.0));
  float n01 = dot(vec2(cos(g01), sin(g01)), f - vec2(0.0, 1.0));
  float n11 = dot(vec2(cos(g11), sin(g11)), f - vec2(1.0, 1.0));
  return clamp(0.5 + 0.75 * mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y), 0.0, 1.0);
}
float fbm(vec2 uv, vec2 per, int oct, int s) {
  float v = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    v += a * gnoise(uv, per, s + i * 13);
    n += a; per *= 2.0; a *= 0.5;
  }
  return v / n;
}
float ridged(vec2 uv, vec2 per, int s) { return 1.0 - abs(gnoise(uv, per, s) * 2.0 - 1.0); }
// periodic Worley: x = F1, y = F2, z = cell hash, w = second cell hash (in cell units)
vec4 worley(vec2 uv, vec2 per, int s, float jit) {
  vec2 x = uv * per;
  vec2 i = floor(x), f = x - i;
  float d1 = 9.0, d2 = 9.0, id1 = 0.0, id2 = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int xx = -1; xx <= 1; xx++) {
      vec2 o = vec2(float(xx), float(y));
      vec2 c = mod(i + o, per);
      vec2 r = o + 0.5 + (hash2(c, s) - 0.5) * jit - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; id2 = id1; d1 = d; id1 = hash(c, s + 7); }
      else if (d < d2) { d2 = d; id2 = hash(c, s + 7); }
    }
  return vec4(sqrt(d1), sqrt(d2), id1, id2);
}

struct Mat { vec3 alb; float tint; float h; float rough; float ao; };

// ------------------------------------------------------------------------------------------------ ground
Mat asphalt(vec2 uv) {
  float base = fbm(uv, cyc(0.6), 4, 1);
  vec4 w = worley(uv, cyc(0.022), 2, 0.9);
  float stone = smoothstep(0.46, 0.30, w.x);
  vec4 w2 = worley(uv, cyc(0.009), 3, 0.9);
  float grit = smoothstep(0.42, 0.25, w2.x) * step(0.55, w2.z);
  float fine = gnoise(uv, cyc(0.004), 4);
  vec3 binder = srgb(vec3(0.21, 0.21, 0.215));
  vec3 stoneCol = mix(srgb(vec3(0.36, 0.35, 0.34)), srgb(vec3(0.60, 0.58, 0.55)), w.z);
  vec3 alb = mix(binder, stoneCol, stone * (0.45 + 0.55 * w.z));
  alb = mix(alb, srgb(vec3(0.5, 0.49, 0.47)), grit * 0.5);
  alb *= (0.82 + 0.36 * base) * (0.9 + 0.2 * fine);
  // crack networks (warped cell borders) only in places, and tar-sealed cracks elsewhere
  vec2 warp = vec2(gnoise(uv, cyc(0.5), 5), gnoise(uv, cyc(0.5), 6)) - 0.5;
  vec4 c = worley(uv + warp * 0.06, cyc(1.3), 7, 0.9);
  float edge = c.y - c.x;
  float crackZone = smoothstep(0.63, 0.74, fbm(uv, cyc(2.0), 3, 9));
  float crack = (1.0 - smoothstep(0.0, 0.03, edge)) * crackZone;
  float sealZone = smoothstep(0.6, 0.68, fbm(uv, cyc(2.0), 2, 11)) * (1.0 - crackZone);
  float seal = (1.0 - smoothstep(0.02, 0.07, edge)) * sealZone;
  alb = mix(alb, srgb(vec3(0.075, 0.075, 0.08)), seal * 0.95);
  alb = mix(alb, srgb(vec3(0.05, 0.05, 0.05)), crack);
  float h = stone * 0.0025 * (0.4 + w.z) + grit * 0.0008 + fine * 0.0006 - crack * 0.004 + seal * 0.0005;
  float rough = mix(0.93, 0.8, stone);
  rough = mix(rough, 0.5, seal);
  return Mat(alb, 1.0, h, rough, 1.0 - crack * 0.7 - (1.0 - stone) * 0.12);
}

Mat paint(vec2 uv) {
  float wear = fbm(uv, cyc(0.35), 5, 21);
  float speck = gnoise(uv, cyc(0.008), 22);
  float scuff = fbm(uv, cyc(0.06), 3, 23);
  float worn = smoothstep(0.6, 0.7, wear + 0.35 * (scuff - 0.5) + 0.12 * (speck - 0.5));
  Mat a = asphalt(uv);
  vec3 paintCol = srgb(vec3(0.86)) * (0.9 + 0.1 * speck);
  // aggregate peeks through thin paint
  paintCol = mix(paintCol, a.alb * 2.2, smoothstep(0.75, 0.95, scuff) * 0.35);
  Mat m;
  m.alb = mix(paintCol, a.alb, worn);
  m.tint = 1.0 - worn;
  m.h = a.h * 0.6 + (1.0 - worn) * 0.0012;
  m.rough = mix(0.62, a.rough, worn);
  m.ao = mix(1.0, a.ao, worn);
  return m;
}

Mat concreteSlab(vec2 uv) {
  vec2 g = uv * 2.0;               // 1.5 m slabs in a 3 m tile
  vec2 cell = floor(g), f = fract(g);
  float slabM = 1.5;
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * slabM;
  float groove = 1.0 - smoothstep(0.003, 0.009, edge);
  float tone = hash(mod(cell, 2.0), 31);
  float base = fbm(uv, cyc(0.4), 5, 32);
  float grain = gnoise(uv, cyc(0.003), 33);
  vec4 pores = worley(uv, cyc(0.012), 34, 1.0);
  float pore = smoothstep(0.18, 0.08, pores.x) * step(0.7, pores.z);
  vec4 stains = worley(uv, cyc(0.5), 35, 1.0);
  float stain = smoothstep(0.35, 0.1, stains.x) * step(0.8, stains.z);
  vec4 gum = worley(uv, cyc(0.09), 36, 1.0);
  float gumSpot = smoothstep(0.14, 0.09, gum.x) * step(0.93, gum.z);
  vec3 alb = srgb(vec3(0.66, 0.64, 0.6)) * (0.9 + 0.12 * tone) * (0.85 + 0.3 * base) * (0.92 + 0.16 * grain);
  alb *= 1.0 - 0.25 * stain;
  alb = mix(alb, srgb(vec3(0.25, 0.24, 0.23)), gumSpot * 0.8);
  alb *= 1.0 - 0.35 * pore;
  alb = mix(alb, alb * 0.55, groove);
  float h = -groove * 0.006 + grain * 0.0004 - pore * 0.0008 + (tone - 0.5) * 0.0015 + gumSpot * 0.0005;
  return Mat(alb, 1.0, h, mix(0.86, 0.95, groove) - gumSpot * 0.2, 1.0 - groove * 0.5);
}

/** 90-degree herringbone of 200 x 100 mm pavers (units of 100 mm; period 4 units). */
Mat brickPaver(vec2 uv) {
  vec2 p = uv * uSize / 0.1;
  float tileU = uSize.x / 0.1;
  vec2 local = vec2(0.0), centre = vec2(0.0), dims = vec2(1.0);
  for (int dm = 0; dm < 2; dm++) {
    float m = floor((p.x - p.y + 3.0) / 4.0) - float(dm);
    vec2 q = p - m * vec2(2.0, -2.0);
    float k = floor(q.y);
    if (q.x - k >= 0.0 && q.x - k < 2.0) { local = vec2(q.x - k, q.y - k); centre = vec2(k + 1.0, k + 0.5) + m * vec2(2.0, -2.0); dims = vec2(2.0, 1.0); break; }
    k = floor(q.x);
    if (q.y - k >= 1.0 && q.y - k < 3.0) { local = vec2(q.x - k, q.y - k - 1.0); centre = vec2(k + 0.5, k + 2.0) + m * vec2(2.0, -2.0); dims = vec2(1.0, 2.0); break; }
  }
  vec2 id = mod(floor(centre * 2.0 + 0.5), tileU * 2.0);
  float r = hash(id, 41), r2 = hash(id, 42), r3 = hash(id, 43);
  vec2 dEdge = min(local, dims - local) * 0.1;  // metres to the paver's edges
  float e = min(dEdge.x, dEdge.y);
  float joint = 1.0 - smoothstep(0.0015, 0.004, e);
  float bevel = smoothstep(0.0, 0.012, e);
  vec3 c = mix(srgb(vec3(0.56, 0.29, 0.21)), srgb(vec3(0.66, 0.38, 0.27)), r);
  c = mix(c, srgb(vec3(0.38, 0.21, 0.17)), step(0.82, r2) * 0.8);
  c = mix(c, srgb(vec3(0.5, 0.36, 0.3)), step(0.9, r3) * 0.6);
  float sand = gnoise(uv, cyc(0.004), 44);
  float wear = fbm(uv, cyc(0.25), 4, 45);
  c *= (0.86 + 0.24 * sand) * (0.85 + 0.3 * wear);
  vec3 jointCol = srgb(vec3(0.42, 0.38, 0.32)) * (0.8 + 0.4 * sand);
  vec3 alb = mix(c, jointCol, joint);
  float tilt = dot(local - dims * 0.5, vec2(r2 - 0.5, r3 - 0.5)) * 0.0012;
  float h = (bevel * 0.004 + (r - 0.5) * 0.002 + tilt) * (1.0 - joint) + sand * 0.0003;
  return Mat(alb, 1.0, h, mix(0.82, 0.95, joint) - wear * 0.06, mix(1.0, 0.55, joint));
}

Mat granite(vec2 uv) {
  vec4 g1 = worley(uv, cyc(0.006), 51, 1.0);
  vec4 g2 = worley(uv, cyc(0.0035), 52, 1.0);
  float base = fbm(uv, cyc(0.3), 4, 53);
  vec3 alb = srgb(vec3(0.6, 0.59, 0.57)) * (0.88 + 0.24 * base);
  alb = mix(alb, srgb(vec3(0.16, 0.16, 0.17)), step(0.72, g1.z) * smoothstep(0.5, 0.3, g1.x));
  alb = mix(alb, srgb(vec3(0.82, 0.8, 0.77)), step(0.7, g2.z) * smoothstep(0.5, 0.3, g2.x) * 0.8);
  alb = mix(alb, srgb(vec3(0.66, 0.55, 0.52)), step(0.9, g1.w) * 0.35);
  float h = (g1.x * 0.0004 + base * 0.0008);
  return Mat(alb, 1.0, h, 0.62 + 0.12 * base, 1.0);
}

/** Granite setts (Belgian block) about 250 x 125 mm in running courses with rounded tops and sand joints. */
Mat sett(vec2 uv) {
  vec2 n = cyc2(vec2(0.25, 0.125));
  vec2 x = uv * n;
  float row = floor(x.y);
  float off = hash(vec2(mod(row, n.y), 0.0), 61);
  x.x += off;
  vec2 cell = floor(x);
  vec2 f = fract(x);
  vec2 id = vec2(mod(cell.x, n.x), mod(row, n.y));
  float r = hash(id, 62), r2 = hash(id, 63);
  vec2 warp = (vec2(gnoise(uv, cyc(0.06), 64), gnoise(uv, cyc(0.06), 65)) - 0.5) * 0.12;
  vec2 d = min(f, 1.0 - f) + warp * vec2(0.5, 1.0);
  vec2 dm = d * vec2(0.25, 0.125);
  float e = min(dm.x, dm.y);
  float joint = 1.0 - smoothstep(0.004, 0.009, e);
  float dome = smoothstep(0.0, 0.04, e);
  vec3 c = mix(srgb(vec3(0.42, 0.4, 0.38)), srgb(vec3(0.56, 0.52, 0.48)), r);
  c = mix(c, srgb(vec3(0.5, 0.42, 0.36)), step(0.75, r2) * 0.6);
  float grain = gnoise(uv, cyc(0.004), 66);
  c *= 0.88 + 0.24 * grain;
  float polish = smoothstep(0.02, 0.05, e);
  vec3 alb = mix(c, srgb(vec3(0.24, 0.21, 0.18)), joint);
  float h = (dome * 0.012 + (r - 0.5) * 0.004) * (1.0 - joint) + grain * 0.0004;
  return Mat(alb, 1.0, h, mix(0.75, 0.55, polish) + joint * 0.2, mix(1.0, 0.45, joint));
}

Mat grass(vec2 uv) {
  float clump = fbm(uv, cyc(0.5), 4, 71);
  float blades = gnoise(uv * vec2(1.0, 1.0), cyc2(vec2(0.004, 0.012)), 72);
  float blades2 = gnoise(uv, cyc2(vec2(0.012, 0.004)), 73);
  float dry = smoothstep(0.55, 0.75, fbm(uv, cyc(0.9), 3, 74));
  vec4 soilP = worley(uv, cyc(0.15), 75, 1.0);
  float bare = smoothstep(0.35, 0.15, soilP.x) * step(0.85, soilP.z);
  vec3 green = mix(srgb(vec3(0.23, 0.33, 0.12)), srgb(vec3(0.33, 0.43, 0.17)), clump);
  green = mix(green, srgb(vec3(0.46, 0.45, 0.24)), dry * 0.6);
  float b = max(blades, blades2);
  green *= 0.7 + 0.55 * b;
  vec3 alb = mix(green, srgb(vec3(0.33, 0.27, 0.2)), bare * 0.7);
  float h = b * 0.006 + clump * 0.01 - bare * 0.004;
  return Mat(alb, 1.0, h, 0.93, 0.75 + 0.25 * b);
}

Mat soil(vec2 uv) {
  float base = fbm(uv, cyc(0.4), 5, 81);
  vec4 peb = worley(uv, cyc(0.025), 82, 1.0);
  float pebble = smoothstep(0.38, 0.22, peb.x) * step(0.6, peb.z);
  float damp = smoothstep(0.5, 0.7, fbm(uv, cyc(1.0), 3, 83));
  vec3 alb = mix(srgb(vec3(0.36, 0.28, 0.2)), srgb(vec3(0.46, 0.37, 0.27)), base);
  alb = mix(alb, mix(srgb(vec3(0.5, 0.48, 0.45)), srgb(vec3(0.62, 0.56, 0.48)), peb.w), pebble);
  alb *= 1.0 - 0.3 * damp;
  float h = base * 0.012 + pebble * 0.004;
  return Mat(alb, 1.0, h, 0.95 - pebble * 0.15, 0.85 + 0.15 * base);
}

Mat gravel(vec2 uv) {
  vec4 w = worley(uv, cyc(0.018), 91, 0.9);
  vec4 w2 = worley(uv, cyc(0.008), 92, 0.9);
  float peb = smoothstep(0.5, 0.25, w.x);
  vec3 c = mix(srgb(vec3(0.58, 0.53, 0.45)), srgb(vec3(0.74, 0.68, 0.58)), w.z);
  c = mix(c, srgb(vec3(0.5, 0.5, 0.5)), step(0.7, w.w) * 0.5);
  vec3 alb = mix(srgb(vec3(0.34, 0.3, 0.25)), c, peb);
  alb *= 0.9 + 0.2 * smoothstep(0.4, 0.1, w2.x);
  float h = peb * (0.006 - w.x * 0.006) + smoothstep(0.4, 0.1, w2.x) * 0.0015;
  return Mat(alb, 1.0, h, 0.88, mix(0.6, 1.0, peb));
}

// ------------------------------------------------------------------------------------------------ nature
Mat bark(vec2 uv) {
  vec2 warp = vec2(gnoise(uv, cyc(0.3), 101) - 0.5, 0.0) * 0.08;
  float r = ridged(uv + warp, cyc2(vec2(0.06, 0.4)), 102);
  float r2 = ridged(uv + warp * 1.5, cyc2(vec2(0.025, 0.15)), 103);
  float fiss = smoothstep(0.55, 0.95, r * 0.65 + r2 * 0.35);
  float lichen = smoothstep(0.62, 0.72, fbm(uv, cyc(0.25), 3, 104));
  vec3 alb = mix(srgb(vec3(0.16, 0.13, 0.1)), srgb(vec3(0.38, 0.33, 0.28)), fiss);
  alb = mix(alb, srgb(vec3(0.45, 0.48, 0.38)), lichen * 0.5);
  float h = fiss * 0.012 + r2 * 0.003;
  return Mat(alb, 1.0, h, 0.95, mix(0.55, 1.0, fiss));
}

/**
 * Leaves in clumps: alpha (the tint channel) is coverage for cut-out canopy cards. Clumps of about 0.3 m are filled
 * with overlapping leaves of 6-9 cm; between the clumps the canopy is open. Gaps keep a deep-shade green so mipmaps
 * and the opaque far crowns read as dense foliage, not speckle.
 */
Mat foliage(vec2 uv) {
  vec4 cl = worley(uv, cyc(0.3), 110, 1.0);
  float clump = smoothstep(0.8, 0.45, cl.x);
  float cover = 0.0, h = 0.0, tone = 0.5, lit = 1.0;
  for (int k = 0; k < 2; k++) {
    vec4 w = worley(uv + vec2(float(k) * 0.37, float(k) * 0.61), cyc(0.085 - float(k) * 0.025), 111 + k * 9, 1.0);
    float leaf = smoothstep(0.66, 0.4, w.x);
    if (leaf > cover) { cover = leaf; tone = w.z; h = (0.66 - w.x) * 0.03; lit = 1.0 - 0.2 * float(k); }
  }
  cover *= mix(0.25, 1.0, clump);
  vec3 alb = mix(srgb(vec3(0.17, 0.27, 0.09)), srgb(vec3(0.33, 0.45, 0.16)), tone);
  alb = mix(alb, srgb(vec3(0.44, 0.47, 0.2)), step(0.9, tone) * 0.6);
  alb *= lit * mix(0.7, 1.05, clump);
  vec3 deep = srgb(vec3(0.07, 0.11, 0.05));
  alb = mix(deep, alb, smoothstep(0.1, 0.5, cover));
  return Mat(alb, cover, h + clump * 0.02, 0.86, mix(0.45, 1.0, cover * clump));
}

Mat wood(vec2 uv) {
  float n = max(1.0, floor(uSize.y / 0.14 + 0.5));
  float row = floor(uv.y * n);
  float fy = fract(uv.y * n);
  float r = hash(vec2(row, 0.0), 121);
  float joints = floor(1.0 + r * 2.0);
  float u = fract(uv.x * joints + hash(vec2(row, 1.0), 122));
  float gap = 1.0 - smoothstep(0.02, 0.06, min(fy, 1.0 - fy));
  float butt = 1.0 - smoothstep(0.002, 0.006, min(u, 1.0 - u) * uSize.x / joints);
  float grain = gnoise(vec2(uv.x, uv.y), cyc2(vec2(0.5, 0.006)), 123);
  float knots = smoothstep(0.15, 0.05, worley(uv, cyc(0.4), 124, 1.0).x);
  float weather = fbm(uv, cyc(0.5), 3, 125);
  vec3 c = mix(srgb(vec3(0.45, 0.34, 0.24)), srgb(vec3(0.56, 0.45, 0.34)), r);
  c = mix(c, srgb(vec3(0.5, 0.48, 0.45)), weather * 0.45);
  c *= 0.85 + 0.25 * grain;
  c *= 1.0 - 0.3 * knots;
  vec3 alb = mix(c, srgb(vec3(0.08, 0.07, 0.06)), max(gap, butt));
  float h = (1.0 - max(gap, butt)) * 0.004 + grain * 0.0006;
  return Mat(alb, 1.0, h, 0.82 + 0.1 * weather, mix(1.0, 0.4, max(gap, butt)));
}

// ------------------------------------------------------------------------------------------------ metal, concrete, stone
Mat metalPaint(vec2 uv) {
  float peel = gnoise(uv, cyc(0.01), 131);
  float scr = smoothstep(0.985, 1.0, ridged(uv, cyc2(vec2(0.3, 0.02)), 132));
  vec4 rs = worley(uv, cyc(0.12), 133, 1.0);
  float rust = smoothstep(0.3, 0.1, rs.x) * step(0.92, rs.z);
  vec3 alb = srgb(vec3(0.184, 0.196, 0.212)) * (0.95 + 0.1 * peel);
  alb = mix(alb, alb * 1.8, scr * 0.5);
  alb = mix(alb, srgb(vec3(0.35, 0.18, 0.1)), rust);
  return Mat(alb, 1.0 - rust, peel * 0.0002 - rust * 0.0005, 0.42 + 0.3 * rust, 1.0);
}

Mat metalBare(vec2 uv) {
  vec4 sp = worley(uv, cyc(0.02), 141, 1.0);
  float brush = gnoise(uv, cyc2(vec2(0.3, 0.002)), 142);
  vec3 alb = srgb(vec3(0.62, 0.63, 0.64)) * (0.88 + 0.16 * sp.z) * (0.95 + 0.1 * brush);
  return Mat(alb, 1.0, brush * 0.0001, 0.3 + 0.18 * sp.z, 1.0);
}

Mat concrete(vec2 uv) {
  float base = fbm(uv, cyc(0.5), 5, 151);
  float mott = fbm(uv, cyc(0.08), 3, 152);
  vec4 p = worley(uv, cyc(0.01), 153, 1.0);
  float pore = smoothstep(0.2, 0.08, p.x) * step(0.75, p.z);
  // formwork panel joints every 1.33 m (v) and tie holes on a 0.66 m grid
  float fv = fract(uv.y * 3.0);
  float joint = 1.0 - smoothstep(0.001, 0.004, min(fv, 1.0 - fv) * uSize.y / 3.0);
  vec2 tg = fract(uv * cyc(0.66)) - 0.5;
  float tie = 1.0 - smoothstep(0.012, 0.018, length(tg * uSize / cyc(0.66)));
  float streak = gnoise(uv, cyc2(vec2(0.05, 2.0)), 154);
  vec3 alb = srgb(vec3(0.6, 0.59, 0.56)) * (0.82 + 0.3 * base) * (0.94 + 0.12 * mott);
  alb *= 1.0 - 0.18 * smoothstep(0.55, 0.8, streak);
  alb *= 1.0 - 0.4 * pore;
  alb *= 1.0 - 0.35 * max(joint, tie);
  float h = mott * 0.0008 - pore * 0.001 - joint * 0.002 - tie * 0.006;
  return Mat(alb, 1.0, h, 0.9, 1.0 - 0.4 * max(joint, tie));
}

/** Dressed stone blocks in courses (canal walls, bridge piers, ashlar facades). */
Mat stone(vec2 uv) {
  vec2 n = cyc2(vec2(0.8, 0.4));
  float row = floor(uv.y * n.y);
  float off = hash(vec2(mod(row, n.y), 0.0), 161) * 0.7;
  float x = uv.x * n.x + off;
  float col = floor(x);
  // two block lengths per course: some blocks merge with their neighbour
  vec2 id = vec2(mod(col, n.x), row);
  float r = hash(id, 162), r2 = hash(id, 163);
  vec2 f = vec2(fract(x), fract(uv.y * n.y));
  vec2 dm = min(f, 1.0 - f) * uSize / n;
  float e = min(dm.x, dm.y);
  float joint = 1.0 - smoothstep(0.004, 0.009, e);
  float chisel = fbm(uv, cyc(0.06), 4, 164);
  float face = smoothstep(0.0, 0.03, e);
  vec3 c = mix(srgb(vec3(0.55, 0.52, 0.47)), srgb(vec3(0.68, 0.64, 0.57)), r);
  c = mix(c, srgb(vec3(0.6, 0.55, 0.45)), step(0.8, r2) * 0.5);
  c *= 0.86 + 0.26 * chisel;
  vec3 alb = mix(c, srgb(vec3(0.5, 0.48, 0.44)), joint);
  float h = (face * 0.008 + chisel * 0.003 + (r2 - 0.5) * 0.003) * (1.0 - joint);
  return Mat(alb, 1.0 - joint * 0.5, h, 0.86, mix(1.0, 0.5, joint));
}

// ------------------------------------------------------------------------------------------------ brick walls
/** One brick: per-brick colour, sand texture, chipped edges. Returns colour; h and joint via out params. */
vec3 brickFace(vec2 id, float burnt, vec2 uv, out float hb) {
  float r = hash(id, 171), r2 = hash(id, 172), r3 = hash(id, 173);
  vec3 c = mix(srgb(vec3(0.56, 0.25, 0.18)), srgb(vec3(0.66, 0.33, 0.23)), r);
  c = mix(c, srgb(vec3(0.42, 0.2, 0.16)), step(0.8, r2) * 0.85);
  c = mix(c, srgb(vec3(0.7, 0.42, 0.3)), step(0.92, r3) * 0.7);
  c = mix(c, srgb(vec3(0.24, 0.15, 0.14)), burnt * (0.6 + 0.3 * r));
  float sand = gnoise(uv, cyc(0.003), 174);
  float blot = fbm(uv, cyc(0.05), 2, 175);
  c *= (0.84 + 0.26 * sand) * (0.9 + 0.2 * blot);
  hb = sand * 0.0005 + (r - 0.5) * 0.001;
  return c;
}
/** Course layout: x position and course index -> brick id, local metres to the brick's edges. */
Mat brickWall(vec2 uv, int bond, bool painted) {
  float L = BRICK_LEN, C = BRICK_COURSE, Hd = BRICK_HEADER;
  vec2 m = uv * uSize;
  float row = floor(m.y / C);
  float rows = floor(uSize.y / C + 0.5);
  float fy = m.y - row * C;
  float len = L, off = 0.0, burnt = 0.0;
  float x = m.x;
  vec2 id;
  float fx;
  if (bond == 1) {
    // Flemish: stretcher + header alternating, headers centred over the stretchers below; dark burnt headers
    float unit = L + Hd;
    off = mod(row, 2.0) * (L + Hd) * 0.5;
    float xs = x + off;
    float u = floor(xs / unit);
    float within = xs - u * unit;
    if (within < L) { len = L; fx = within; id = vec2(mod(u * 2.0, floor(uSize.x / unit + 0.5) * 2.0), mod(row, rows)); }
    else { len = Hd; fx = within - L; id = vec2(mod(u * 2.0 + 1.0, floor(uSize.x / unit + 0.5) * 2.0), mod(row, rows)); burnt = step(0.35, hash(id, 176)); }
  } else {
    bool headerCourse = bond == 2 && mod(row, 6.0) == 0.0;
    if (headerCourse) { len = uSize.x / floor(uSize.x / Hd + 0.5); off = len * 0.5 * mod(row / 6.0, 2.0); }
    else off = mod(row, 2.0) * L * 0.5;
    float xs = x + off;
    float u = floor(xs / len);
    fx = xs - u * len;
    id = vec2(mod(u, floor(uSize.x / len + 0.5)) + (headerCourse ? 50.0 : 0.0), mod(row, rows));
  }
  float j = 0.01;
  float ex = min(fx, len - fx), ey = min(fy, C - fy);
  float e = min(ex, ey);
  float mortar = 1.0 - smoothstep(j * 0.5 - 0.0008, j * 0.5 + 0.0008, e);
  float bevel = smoothstep(j * 0.5, j * 0.5 + 0.004, e);
  float hb;
  vec3 b = brickFace(id, burnt, uv, hb);
  float mg = gnoise(uv, cyc(0.002), 177);
  vec3 mortarCol = srgb(vec3(0.66, 0.63, 0.57)) * (0.85 + 0.25 * mg);
  float soot = fbm(uv, cyc(0.6), 3, 178);
  Mat o;
  if (painted) {
    float paintVar = fbm(uv, cyc(0.15), 3, 179);
    vec4 chip = worley(uv, cyc(0.12), 180, 1.0);
    float peel = smoothstep(0.25, 0.15, chip.x) * step(0.9, chip.z) * (1.0 - mortar);
    vec3 paintCol = srgb(vec3(0.86, 0.85, 0.82)) * (0.92 + 0.1 * paintVar) * mix(1.0, 0.8, mortar);
    o.alb = mix(paintCol, b, peel);
    o.tint = 1.0 - peel;
    o.h = (bevel * 0.004 + hb * 0.5) * (1.0 - mortar) - mortar * 0.003;
    o.rough = mix(0.7, 0.88, peel);
    o.ao = mix(1.0, 0.75, mortar);
    return o;
  }
  o.alb = mix(b, mortarCol, mortar) * (0.92 + 0.12 * soot);
  o.tint = 1.0 - mortar;
  o.h = (bevel * 0.005 + hb) * (1.0 - mortar) - mortar * 0.004;
  o.rough = mix(0.84, 0.95, mortar);
  o.ao = mix(1.0, 0.6, mortar);
  return o;
}

Mat stucco(vec2 uv) {
  vec2 warp = vec2(gnoise(uv, cyc(0.4), 191), gnoise(uv, cyc(0.4), 192)) - 0.5;
  float trowel = fbm(uv + warp * 0.08, cyc(0.15), 4, 193);
  float grain = gnoise(uv, cyc(0.002), 194);
  vec4 c = worley(uv, cyc(0.7), 195, 1.0);
  float crack = (1.0 - smoothstep(0.0, 0.015, c.y - c.x)) * smoothstep(0.7, 0.8, fbm(uv, cyc(1.5), 2, 196));
  vec3 alb = srgb(vec3(0.84, 0.83, 0.8)) * (0.9 + 0.1 * trowel) * (0.95 + 0.08 * grain);
  alb *= 1.0 - 0.3 * crack;
  float h = trowel * 0.0015 + grain * 0.0004 - crack * 0.001;
  return Mat(alb, 1.0, h, 0.86, 1.0 - 0.3 * crack);
}

Mat clapboard(vec2 uv) {
  float n = max(1.0, floor(uSize.y / 0.15 + 0.5));
  float row = floor(uv.y * n), fy = fract(uv.y * n);
  float grain = gnoise(uv, cyc2(vec2(0.6, 0.004)), 201);
  float r = hash(vec2(row, 0.0), 202);
  vec3 alb = srgb(vec3(0.85, 0.84, 0.81)) * (0.94 + 0.06 * r) * (0.95 + 0.08 * grain);
  float lip = 1.0 - smoothstep(0.0, 0.08, fy);
  alb *= 1.0 - 0.3 * lip;
  float h = fy * 0.01 + grain * 0.0003;
  return Mat(alb, 1.0, h, 0.6, mix(1.0, 0.55, lip));
}

// ------------------------------------------------------------------------------------------------ roofs
Mat slate(vec2 uv) {
  vec2 n = cyc2(vec2(0.3, 0.2));
  float row = floor(uv.y * n.y);
  float x = uv.x * n.x + mod(row, 2.0) * 0.5;
  float col = floor(x);
  vec2 id = vec2(mod(col, n.x), mod(row, n.y));
  float r = hash(id, 211), r2 = hash(id, 212);
  float fy = fract(uv.y * n.y) + (r2 - 0.5) * 0.08;
  float fx = fract(x);
  float side = 1.0 - smoothstep(0.0, 0.012, min(fx, 1.0 - fx));
  float lip = 1.0 - smoothstep(0.0, 0.05, fy);
  float grain = gnoise(uv, cyc2(vec2(0.01, 0.03)), 213);
  vec3 c = mix(srgb(vec3(0.22, 0.24, 0.27)), srgb(vec3(0.33, 0.35, 0.38)), r);
  c = mix(c, srgb(vec3(0.3, 0.26, 0.24)), step(0.85, r2) * 0.6);
  c *= 0.9 + 0.15 * grain;
  c *= 1.0 - 0.45 * max(side, lip);
  float h = fy * 0.006 + grain * 0.0004 - side * 0.002;
  return Mat(c, 1.0, h, 0.62 + 0.1 * r, mix(1.0, 0.5, max(side, lip)));
}

Mat metalSeam(vec2 uv) {
  float n = max(1.0, floor(uSize.x / 0.45 + 0.5));
  float fx = fract(uv.x * n);
  float d = min(fx, 1.0 - fx) * uSize.x / n;
  float seam = 1.0 - smoothstep(0.008, 0.016, d);
  float can = fbm(uv, cyc(0.4), 3, 221);
  vec3 alb = srgb(vec3(0.44, 0.5, 0.45)) * (0.92 + 0.12 * can);
  float h = seam * 0.025 + can * 0.002;
  return Mat(alb, 1.0, h, 0.42 + 0.1 * can, mix(1.0, 0.8, seam));
}

Mat roofTar(vec2 uv) {
  float speck = gnoise(uv, cyc(0.005), 231);
  float base = fbm(uv, cyc(0.6), 4, 232);
  float fv = fract(uv.y * 4.0);
  float lap = 1.0 - smoothstep(0.0, 0.01, fv * uSize.y / 4.0);
  vec4 pt = worley(uv, cyc(1.2), 233, 1.0);
  float pat = step(0.85, pt.z) * smoothstep(0.42, 0.38, pt.x);
  vec3 alb = srgb(vec3(0.45, 0.44, 0.42)) * (0.8 + 0.35 * speck) * (0.85 + 0.3 * base);
  alb = mix(alb, srgb(vec3(0.16, 0.16, 0.17)), pat * 0.8);
  alb *= 1.0 - 0.3 * lap;
  float h = speck * 0.0015 + base * 0.003 + lap * 0.002 + pat * 0.001;
  return Mat(alb, 1.0, h, 0.92 - pat * 0.3, 1.0);
}

Mat canvas(vec2 uv) {
  vec2 n = cyc(0.003);
  vec2 x = uv * n;
  float weave = 0.5 + 0.25 * (sin(x.x * 6.2831853) * sign(sin(x.y * 3.14159)) + sin(x.y * 6.2831853) * sign(sin(x.x * 3.14159)));
  float dirt = fbm(uv, cyc(0.3), 3, 241);
  vec3 alb = srgb(vec3(0.84)) * (0.88 + 0.12 * weave) * (0.9 + 0.1 * dirt);
  return Mat(alb, 1.0, weave * 0.0004, 0.9, 1.0);
}

Mat water(vec2 uv) {
  float h = fbm(uv, cyc(1.2), 5, 251) * 0.05 + gnoise(uv, cyc(0.25), 252) * 0.012;
  return Mat(vec3(0.0), 1.0, h, 0.05, 1.0);
}

/** One material per program (MAT is defined per bake layer): a shader that held all of them ran every branch on
 * software GL. */
Mat material(vec2 uv) {
#if MAT == 0
  return asphalt(uv);
#elif MAT == 1
  return paint(uv);
#elif MAT == 2
  return concreteSlab(uv);
#elif MAT == 3
  return brickPaver(uv);
#elif MAT == 4
  return granite(uv);
#elif MAT == 5
  return sett(uv);
#elif MAT == 6
  return grass(uv);
#elif MAT == 7
  return soil(uv);
#elif MAT == 8
  return gravel(uv);
#elif MAT == 9
  return bark(uv);
#elif MAT == 10
  return foliage(uv);
#elif MAT == 11
  return wood(uv);
#elif MAT == 12
  return metalPaint(uv);
#elif MAT == 13
  return metalBare(uv);
#elif MAT == 14
  return concrete(uv);
#elif MAT == 15
  return stone(uv);
#elif MAT == 16
  return brickWall(uv, 0, false);
#elif MAT == 17
  return brickWall(uv, 1, false);
#elif MAT == 18
  return brickWall(uv, 2, false);
#elif MAT == 19
  return brickWall(uv, 0, true);
#elif MAT == 20
  return stucco(uv);
#elif MAT == 21
  return clapboard(uv);
#elif MAT == 22
  return slate(uv);
#elif MAT == 23
  return metalSeam(uv);
#elif MAT == 24
  return roofTar(uv);
#elif MAT == 25
  return canvas(uv);
#elif MAT == 26
  return water(uv);
#else
  return water(uv);
#endif
}
`;

/** Pass 0 (albedo + tint) and pass 1 (height, roughness, occlusion) of one layer. */
export function bakeFragment(brick: { len: number; course: number; header: number }, layer: number): string {
  return FRAG_OUT + `#define MAT ${layer}\n` + brickDefines(brick) + NOISE + /* glsl */ `
void main() {
  Mat m = material(vUv);
  if (uPass == 0) gl_FragColor = vec4(clamp(m.alb, 0.0, 1.0), clamp(m.tint, 0.0, 1.0));
  else gl_FragColor = vec4(m.h, clamp(m.rough, 0.02, 1.0), clamp(m.ao, 0.0, 1.0), 1.0);
}`;
}
function brickDefines(b: { len: number; course: number; header: number }): string {
  return `#define BRICK_LEN ${b.len.toFixed(4)}\n#define BRICK_COURSE ${b.course.toFixed(4)}\n#define BRICK_HEADER ${b.header.toFixed(4)}\n`;
}

/** Pass 2: normals from the height pass (wrapping Sobel; heights and texel size in metres). */
export const NORMAL_FRAG = FRAG_OUT + /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uHeight;
uniform vec2 uSize;
uniform float uRes;
float H(vec2 o) { return texture(uHeight, fract(vUv + o / uRes)).r; }
void main() {
  vec4 c = texture(uHeight, vUv);
  float tl = H(vec2(-1, 1)), t = H(vec2(0, 1)), tr = H(vec2(1, 1));
  float l = H(vec2(-1, 0)), r = H(vec2(1, 0));
  float bl = H(vec2(-1, -1)), b = H(vec2(0, -1)), br = H(vec2(1, -1));
  vec2 texel = uSize / uRes;
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / (8.0 * texel.x);
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / (8.0 * texel.y);
  vec3 n = normalize(vec3(-dx, -dy, 1.0));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, c.g, c.b);
}`;

/** Macro variation texture: R/G large-scale tone fields, B puddle field, A grime field (periodic). */
export const MACRO_FRAG = FRAG_OUT + '#define MAT -1\n' + brickDefines({ len: 0.213, course: 0.067, header: 0.102 }) + NOISE + /* glsl */ `
void main() {
  float a = fbm(vUv, vec2(4.0), 5, 301);
  float b = fbm(vUv, vec2(7.0), 4, 302);
  float c = fbm(vUv, vec2(10.0), 4, 303);
  float d = fbm(vUv, vec2(16.0), 3, 304);
  gl_FragColor = vec4(a, b, c, d);
}`;
