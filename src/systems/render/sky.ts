// Sky and image-based lighting. The visible sky is three's physically based Preetham sky (examples/jsm/objects/Sky.js:
// Rayleigh and Mie scattering, the sun disc, procedural clouds), with the sun where the day/night cycle puts it. The
// same sky (plus a dark ground below the horizon) is captured into a small cube map and prefiltered (PMREM) as the scene
// environment, so every PBR material is lit by the sky it stands under and glass and wet streets reflect it. The
// capture is redone only when the sun has moved a couple of degrees or the weather changed (a few milliseconds of GPU
// work every few seconds of play), never every frame, and always into the same targets (no allocation, no recompile).
//
// The capture is not sky alone: a street sees buildings at the horizon and sunlit or shaded pavement below it, and a
// sky-only environment made every reflection at street level (asphalt, walls and car paint at grazing angles) mirror
// the brightest, palest part of the sky and lit every shaded wall with pure blue sky (the washed-out look of the visual
// audit, docs/visual-audit.md section 7). So the capture also holds a ring of generic city facades (an irregular
// skyline 6-22 degrees high, brick and stone, rows of windows, lit by the sun on the side facing away from it, lit
// windows at night) and a ground disc lit by the sun and the sky: both computed from the current sun, so the bounce is
// warm and right for the hour. Rough surfaces get a warm, darker horizon in their diffuse and specular light; glossy
// ones (glass, wet roads, paint) reflect a believable skyline.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { TUNING } from '../../tuning';

const T = TUNING.look;

export interface SkyEnv {
  sky: Sky;
  uniforms: Record<string, THREE.IUniform>;
  envScene: THREE.Scene;
  ground: THREE.Mesh;
  /** brightness of the sky in the capture relative to the visible sky (TUNING.look.envSkyScale; tools may change it) */
  skyScale: number;
  /** the city ring and ground of the capture: sun direction, sun irradiance (colour x intensity), sky irradiance */
  city: { sunDir: THREE.IUniform<THREE.Vector3>; sun: THREE.IUniform<THREE.Color>; sky: THREE.IUniform<THREE.Color>; night: THREE.IUniform<number> };
  cubeRT: THREE.WebGLCubeRenderTarget;
  cubeCam: THREE.CubeCamera;
  pmrem: THREE.PMREMGenerator | null;
  pmremRT: THREE.WebGLCubeRenderTarget | null;
  /** state at the last capture */
  last: { dir: THREE.Vector3; cloud: number; night: number; at: number };
  refreshes: number;
}

export function createSkyEnv(scene: THREE.Scene): SkyEnv {
  const sky = new Sky();
  sky.scale.setScalar(T.skyBoxSize);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  sky.name = 'sky';
  scene.add(sky);
  const skyMat = sky.material as THREE.ShaderMaterial;
  const uniforms = skyMat.uniforms;
  // night: the scattering model goes black; add a deep blue sky with the city's warm glow low on the horizon
  uniforms.uNightSky = { value: 0 };
  uniforms.uOvercast = { value: 0 };
  // the sky's brightness: T.skyVisibleScale as drawn, e.skyScale in the environment capture (see updateSkyEnv)
  uniforms.uSkyScale = { value: T.skyVisibleScale };
  skyMat.fragmentShader = skyMat.fragmentShader
    .replace('uniform float time;', 'uniform float time;\nuniform float uNightSky;\nuniform float uOvercast;\nuniform float uSkyScale;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', `// overcast: a grey, much dimmer sky (the scattering model alone turns bright white under heavy cloud)
			texColor = mix(texColor, vec3(dot(texColor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.94, 0.97, 1.03), uOvercast * 0.85) * (1.0 - ${T.overcastDim.toFixed(2)} * uOvercast);
			texColor += uNightSky * mix(vec3(${T.nightSkyZenith.join(', ')}), vec3(${T.nightSkyHorizon.join(', ')}), pow(1.0 - max(direction.y, 0.0), 5.0));
			gl_FragColor = vec4( texColor * uSkyScale, 1.0 );`);
  uniforms.turbidity.value = T.skyTurbidity;
  uniforms.rayleigh.value = T.skyRayleigh;
  uniforms.mieCoefficient.value = T.skyMie;
  uniforms.mieDirectionalG.value = T.skyMieG;
  uniforms.cloudCoverage.value = T.skyCloudClear;
  uniforms.cloudDensity.value = T.skyCloudDensityClear;
  uniforms.cloudElevation.value = T.skyCloudElevation;
  // the environment capture: the same sky material, and a dark ground disc below the horizon (bounce light)
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(100);
  envSky.frustumCulled = false;
  envScene.add(envSky);
  const city = { sunDir: { value: new THREE.Vector3(0, 1, 0) }, sun: { value: new THREE.Color() }, sky: { value: new THREE.Color() }, night: { value: 0 } };
  const cityMat = (isGround: boolean) => new THREE.ShaderMaterial({
    uniforms: { uSunDir: city.sunDir, uSun: city.sun, uSky: city.sky, uNight: city.night },
    vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: isGround ? CITY_GROUND_FRAG : CITY_RING_FRAG,
    side: THREE.DoubleSide, toneMapped: false,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 24).rotateX(-Math.PI / 2).translate(0, -2, 0), cityMat(true));
  envScene.add(ground);
  // the ring: radius 40 (inside the 100 m sky box), from below the horizon up to the tallest building
  const ringH = 40 * Math.tan(THREE.MathUtils.degToRad(T.envCityMaxDeg + 1)) + 2.5;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, ringH, 96, 1, true).translate(0, ringH / 2 - 2.5, 0), cityMat(false));
  envScene.add(ring);
  const cubeRT = new THREE.WebGLCubeRenderTarget(T.envCubeSize, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: true });
  const cubeCam = new THREE.CubeCamera(0.1, 1000, cubeRT);
  envScene.add(cubeCam);
  return { sky, uniforms, envScene, ground, city, skyScale: T.envSkyScale, cubeRT, cubeCam, pmrem: null, pmremRT: null, last: { dir: new THREE.Vector3(0, -1, 0), cloud: -1, night: -1, at: -1e9 }, refreshes: 0 };
}

/** Shared declarations of the capture's city ring and ground (radiance out: the capture is linear HDR). */
const CITY_COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSky;
uniform float uNight;
varying vec3 vP;
float cHash(float x) { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }
`;
/** Skyline ring: 72 buildings per turn, each with its own height and facade (red brick, stone, painted render) and rows
 * of windows; Lambert-lit by the sun (the facades facing away from it) and the sky; some lit windows at night. */
const CITY_RING_FRAG = CITY_COMMON + /* glsl */ `
void main() {
  vec2 h = vP.xz;
  float r = length(h);
  float u = atan(h.y, h.x) / 6.2831853 + 0.5;
  float b = floor(u * 72.0);
  float hb = cHash(b);
  float e = vP.y / r;
  if (e > tan(radians(mix(${T.envCityMinDeg.toFixed(1)}, ${T.envCityMaxDeg.toFixed(1)}, hb * hb)))) discard;
  float kind = cHash(b + 17.0);
  vec3 alb = kind < 0.55 ? vec3(0.30, 0.13, 0.08) * (0.8 + 0.4 * cHash(b + 3.0))
           : kind < 0.8 ? vec3(0.42, 0.38, 0.32) * (0.8 + 0.3 * cHash(b + 5.0))
           : vec3(0.55, 0.5, 0.42) * (0.75 + 0.3 * cHash(b + 7.0));
  vec2 cell = vec2(fract(u * 216.0), fract(e * 30.0));
  float win = step(0.25, cell.x) * step(cell.x, 0.75) * step(0.3, cell.y) * step(cell.y, 0.8) * step(0.03, e);
  alb = mix(alb, vec3(0.04, 0.045, 0.05), win * 0.85);
  vec3 n = -normalize(vec3(h.x, 0.0, h.y));
  float sunOn = max(0.0, dot(n, uSunDir)) * step(0.0, uSunDir.y);
  // the lower storeys stand in the shadow of the buildings across the street more often
  sunOn *= smoothstep(-0.02, 0.12, e) * (0.55 + 0.45 * cHash(b + 29.0));
  vec3 rad = alb * (uSun * sunOn + uSky * (0.5 + 0.5 * smoothstep(0.0, 0.3, e))) / 3.14159;
  float lit = step(0.55, cHash(floor(u * 216.0) * 7.0 + floor(e * 30.0) * 13.0)) * win;
  rad += vec3(1.0, 0.72, 0.42) * lit * uNight * ${T.envCityWindowGlow.toFixed(3)};
  gl_FragColor = vec4(rad, 1.0);
}`;
/** Ground disc: streets, pavements and lawns, partly in the shade of buildings, lit by the sun and the sky. */
const CITY_GROUND_FRAG = CITY_COMMON + /* glsl */ `
void main() {
  float sunOn = max(0.0, uSunDir.y) * ${(1 - T.envGroundShade).toFixed(3)};
  vec3 rad = vec3(${T.envGroundAlbedo.map((v) => v.toFixed(3)).join(', ')}) * (uSun * sunOn + uSky) / 3.14159;
  rad += vec3(1.0, 0.75, 0.5) * uNight * ${T.envGroundNightGlow.toFixed(4)};
  gl_FragColor = vec4(rad, 1.0);
}`;

/**
 * Point the sky at the sun (unit direction towards it) and refresh the environment when it changed enough. `sun` is
 * the sun light's irradiance (colour x intensity, weather included) and `skyIrr` the sky's irradiance (both light the
 * city ring and ground of the capture); `force` recaptures now (boot, quality change).
 */
export function updateSkyEnv(e: SkyEnv, renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3, cloud: number, night: number, sun: THREE.Color, skyIrr: THREE.Color, time: number, force = false): boolean {
  const u = e.uniforms;
  (u.sunPosition.value as THREE.Vector3).copy(sunDir);
  // full cloud must close the deck: Sky.js varies coverage by +-0.3 per region, so anything below ~1.0 leaves holes
  // that the overcast greying turns into dark blue patches (an inverted-looking sky in the rain)
  u.cloudCoverage.value = THREE.MathUtils.lerp(T.skyCloudClear, T.skyCloudOvercast, cloud);
  u.cloudDensity.value = THREE.MathUtils.lerp(T.skyCloudDensityClear, T.skyCloudDensityOvercast, cloud);
  u.turbidity.value = THREE.MathUtils.lerp(T.skyTurbidity, 12, cloud);
  u.rayleigh.value = THREE.MathUtils.lerp(T.skyRayleigh, 0.4, cloud);
  u.time.value = time;
  u.uNightSky.value = night;
  u.uOvercast.value = THREE.MathUtils.smoothstep(cloud, 0.3, 0.9);
  const L = e.last;
  const moved = L.dir.angleTo(sunDir) > THREE.MathUtils.degToRad(T.envRefreshDegrees);
  const changed = Math.abs(cloud - L.cloud) > 0.04 || Math.abs(night - L.night) > 0.04;
  if (!force && !((moved || changed) && time - L.at > T.envRefreshMinSeconds)) return false;
  L.dir.copy(sunDir); L.cloud = cloud; L.night = night; L.at = time;
  if (!e.pmrem) { e.pmrem = new THREE.PMREMGenerator(renderer); e.pmrem.compileCubemapShader(); }
  // the city ring and ground: lit by the current sun and sky
  e.city.sunDir.value.copy(sunDir);
  e.city.sun.value.copy(sun);
  e.city.sky.value.copy(skyIrr);
  e.city.night.value = night;
  // the sun disc stays out of the capture: the sun is a light of its own (with shadows); in the environment it would
  // light every shadow too and wash them out
  const disc = u.showSunDisc.value;
  u.showSunDisc.value = 0;
  // the sky as a light source: the scattering model's radiance is right for the visible sky under the exposure, but as a
  // light it gave shade half the brightness of sunlight (a clear day is about 1:5 on the ground); the capture's sky is
  // scaled to that, and the city ring and ground below it are lit physically, so no extra fudge is needed in materials
  u.uSkyScale.value = e.skyScale;
  e.cubeCam.update(renderer, e.envScene);
  u.uSkyScale.value = T.skyVisibleScale;
  u.showSunDisc.value = disc;
  e.pmremRT = e.pmrem.fromCubemap(e.cubeRT.texture, e.pmremRT);
  scene.environment = e.pmremRT.texture;
  e.refreshes++;
  return true;
}
