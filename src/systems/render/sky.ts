// Sky and image-based lighting. The visible sky is three's physically based Preetham sky (examples/jsm/objects/Sky.js:
// Rayleigh and Mie scattering, the sun disc, procedural clouds), with the sun where the day/night cycle puts it. The
// same sky (plus a dark ground below the horizon) is captured into a small cube map and prefiltered (PMREM) as the scene
// environment, so every PBR material is lit by the sky it stands under and glass and wet streets reflect it. The
// capture is redone only when the sun has moved a couple of degrees or the weather changed (a few milliseconds of GPU
// work every few seconds of play), never every frame, and always into the same targets (no allocation, no recompile).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { TUNING } from '../../tuning';

const T = TUNING.look;

export interface SkyEnv {
  sky: Sky;
  uniforms: Record<string, THREE.IUniform>;
  envScene: THREE.Scene;
  ground: THREE.Mesh;
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
  skyMat.fragmentShader = skyMat.fragmentShader
    .replace('uniform float time;', 'uniform float time;\nuniform float uNightSky;\nuniform float uOvercast;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', `// overcast: a grey, much dimmer sky (the scattering model alone turns bright white under heavy cloud)
			texColor = mix(texColor, vec3(dot(texColor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.94, 0.97, 1.03), uOvercast * 0.85) * (1.0 - ${T.overcastDim.toFixed(2)} * uOvercast);
			texColor += uNightSky * mix(vec3(${T.nightSkyZenith.join(', ')}), vec3(${T.nightSkyHorizon.join(', ')}), pow(1.0 - max(direction.y, 0.0), 5.0));
			gl_FragColor = vec4( texColor, 1.0 );`);
  uniforms.turbidity.value = T.skyTurbidity;
  uniforms.rayleigh.value = T.skyRayleigh;
  uniforms.mieCoefficient.value = T.skyMie;
  uniforms.mieDirectionalG.value = T.skyMieG;
  uniforms.cloudCoverage.value = T.skyCloudClear;
  uniforms.cloudDensity.value = 0.45;
  uniforms.cloudElevation.value = 0.55;
  // the environment capture: the same sky material, and a dark ground disc below the horizon (bounce light)
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(100);
  envSky.frustumCulled = false;
  envScene.add(envSky);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 24).rotateX(-Math.PI / 2).translate(0, -2, 0), new THREE.MeshBasicMaterial({ color: 0x222222, toneMapped: false }));
  envScene.add(ground);
  const cubeRT = new THREE.WebGLCubeRenderTarget(T.envCubeSize, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: true });
  const cubeCam = new THREE.CubeCamera(0.1, 1000, cubeRT);
  envScene.add(cubeCam);
  return { sky, uniforms, envScene, ground, cubeRT, cubeCam, pmrem: null, pmremRT: null, last: { dir: new THREE.Vector3(0, -1, 0), cloud: -1, night: -1, at: -1e9 }, refreshes: 0 };
}

const groundCol = new THREE.Color();

/**
 * Point the sky at the sun (unit direction towards it) and refresh the environment when it changed enough.
 * `daylight` 0..1 scales the ground bounce; `force` recaptures now (boot, quality change).
 */
export function updateSkyEnv(e: SkyEnv, renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3, cloud: number, night: number, daylight: number, time: number, force = false): boolean {
  const u = e.uniforms;
  (u.sunPosition.value as THREE.Vector3).copy(sunDir);
  u.cloudCoverage.value = THREE.MathUtils.lerp(T.skyCloudClear, 0.95, cloud);
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
  // ground bounce: a mid-grey city floor lit by the day
  const g = 0.012 + T.groundBounce * daylight;
  (e.ground.material as THREE.MeshBasicMaterial).color.copy(groundCol.setRGB(g, g * 0.95, g * 0.86));
  // the sun disc stays out of the capture: the sun is a light of its own (with shadows); in the environment it would
  // light every shadow too and wash them out
  const disc = u.showSunDisc.value;
  u.showSunDisc.value = 0;
  e.cubeCam.update(renderer, e.envScene);
  u.showSunDisc.value = disc;
  e.pmremRT = e.pmrem.fromCubemap(e.cubeRT.texture, e.pmremRT);
  scene.environment = e.pmremRT.texture;
  e.refreshes++;
  return true;
}
