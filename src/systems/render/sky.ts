// Sky and image-based lighting. The visible sky is three's physically based Preetham sky (examples/jsm/objects/Sky.js:
// Rayleigh and Mie scattering, the sun disc, procedural clouds), with the sun where the day/night cycle puts it. The
// same sky (plus a dark ground below the horizon) is captured into a small cube map and prefiltered (PMREM) as the scene
// environment, so every PBR material is lit by the sky it stands under and glass and wet streets reflect it. The
// visible dome samples a cached HDR cube, refreshed one face per frame. Lighting recaptures likewise spread their
// six faces over six frames when the sun or weather changes; both paths reuse their targets without recompiling.
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
  display: { front: THREE.WebGLCubeRenderTarget; back: THREE.WebGLCubeRenderTarget; camera: THREE.CubeCamera;
    face: number; at: number; swaps: number; faces: number; material: THREE.ShaderMaterial };
  environmentFace: number;
  environmentFaces: number;
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
  uniforms.cloudDensity.value = T.skyCloudDensityClear;
  uniforms.cloudElevation.value = T.skyCloudElevation;
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
  // The physical model is retained in envScene. The visible dome samples its cached radiance instead of
  // rerunning atmospheric scattering + four cloud-noise octaves at every screen pixel, every frame.
  const target = () => new THREE.WebGLCubeRenderTarget(T.skyCubeSize, { type: THREE.HalfFloatType,
    generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  const front = target(), back = target();
  const displayCamera = new THREE.CubeCamera(0.1, 1000, back);
  const material = new THREE.ShaderMaterial({
    uniforms: { tSky: { value: front.texture } }, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vSkyDirection;
      void main() { vec4 p = modelMatrix * vec4(position, 1.0); vSkyDirection = p.xyz - cameraPosition;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: `uniform samplerCube tSky; varying vec3 vSkyDirection;
      void main() { gl_FragColor = vec4(textureCube(tSky, normalize(vSkyDirection)).rgb, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  sky.material = material;
  return { sky, uniforms, envScene, ground, cubeRT, cubeCam, pmrem: null, pmremRT: null,
    last: { dir: new THREE.Vector3(0, -1, 0), cloud: -1, night: -1, at: -1e9 }, refreshes: 0,
    display: { front, back, camera: displayCamera, face: -1, at: -1e9, swaps: 0, faces: 0, material },
    environmentFace: -1, environmentFaces: 0 };
}

/** Render one CubeCamera face while retaining the main render target/viewport. CubeCamera.update is used at
 * boot to initialise face orientations for the renderer's coordinate system; later captures reuse those cameras. */
function captureFace(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.CubeCamera,
  target: THREE.WebGLCubeRenderTarget, face: number): void {
  const previous = renderer.getRenderTarget();
  const previousFace = renderer.getActiveCubeFace(), previousMip = renderer.getActiveMipmapLevel();
  renderer.setRenderTarget(target, face);
  renderer.render(scene, camera.children[face] as THREE.Camera);
  renderer.setRenderTarget(previous, previousFace, previousMip);
}

function updateDisplay(e: SkyEnv, renderer: THREE.WebGLRenderer, time: number, force: boolean): void {
  const D = e.display;
  const disc = e.uniforms.showSunDisc.value;
  const groundVisible = e.ground.visible;
  // Ground bounce belongs only to the lighting environment. Including it in the visible dome paints the
  // lower sky brown, unlike the physical sky's atmospheric horizon (noticeable from hills and bridges).
  e.ground.visible = false;
  e.uniforms.showSunDisc.value = 1;
  if (force || D.swaps === 0) {
    D.camera.renderTarget = D.back;
    D.camera.update(renderer, e.envScene); D.faces += 6;
    D.face = 6;
  } else {
    if (D.face < 0 && time - D.at >= T.skyRefreshSeconds) { D.face = 0; D.at = time; }
    if (D.face >= 0 && D.face < 6) { captureFace(renderer, e.envScene, D.camera, D.back, D.face++); D.faces++; }
  }
  e.uniforms.showSunDisc.value = disc;
  e.ground.visible = groundVisible;
  if (D.face === 6) {
    const complete = D.back; D.back = D.front; D.front = complete;
    D.material.uniforms.tSky.value = D.front.texture;
    D.face = -1; D.at = time; D.swaps++;
  }
}

const groundCol = new THREE.Color();

/**
 * Point the sky at the sun (unit direction towards it) and refresh the environment when it changed enough.
 * `daylight` 0..1 scales the ground bounce; `force` recaptures now (boot, quality change).
 */
export function updateSkyEnv(e: SkyEnv, renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3, cloud: number, night: number, daylight: number, time: number, force = false): boolean {
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
  // Cloud motion and daylight remain visible, but the same cubemap is reused between small, amortised captures.
  const g = 0.012 + T.groundBounce * daylight;
  (e.ground.material as THREE.MeshBasicMaterial).color.copy(groundCol.setRGB(g, g * 0.95, g * 0.86));
  updateDisplay(e, renderer, time, force);
  const L = e.last;
  const moved = L.dir.angleTo(sunDir) > THREE.MathUtils.degToRad(T.envRefreshDegrees);
  const changed = Math.abs(cloud - L.cloud) > 0.04 || Math.abs(night - L.night) > 0.04;
  if (e.environmentFace < 0 && (force || ((moved || changed) && time - L.at > T.envRefreshMinSeconds))) {
    L.dir.copy(sunDir); L.cloud = cloud; L.night = night; L.at = time;
    e.environmentFace = 0;
  }
  if (e.environmentFace < 0) return false;
  if (!e.pmrem) { e.pmrem = new THREE.PMREMGenerator(renderer); e.pmrem.compileCubemapShader(); }
  // The visible sun disc is excluded from lighting; otherwise it illuminates all shadows and washes them out.
  const disc = u.showSunDisc.value; u.showSunDisc.value = 0;
  if (force || e.refreshes === 0) { e.cubeCam.update(renderer, e.envScene); e.environmentFaces += 6; e.environmentFace = 6; }
  else { captureFace(renderer, e.envScene, e.cubeCam, e.cubeRT, e.environmentFace++); e.environmentFaces++; }
  u.showSunDisc.value = disc;
  if (e.environmentFace !== 6) return false;
  e.pmremRT = e.pmrem.fromCubemap(e.cubeRT.texture, e.pmremRT);
  scene.environment = e.pmremRT.texture;
  e.environmentFace = -1; e.refreshes++;
  return true;
}
