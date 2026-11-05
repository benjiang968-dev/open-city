// Graphics quality presets (Low / Medium / High): resolution scale, shadows and pedestrian budget.
// Chosen in the pause menu, remembered per browser (localStorage, optional), default Medium.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import { bakeLook } from './render/look';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];

export interface SettingsState {
  quality: Quality;
  pedBudget: number; // pedestrians kept active near the player
}

const KEY = 'openCity.quality';

export function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(KEY);
    const forced = new URLSearchParams(location.search).get('quality');
    if (forced && (QUALITIES as string[]).includes(forced)) return forced as Quality;
    if (q && (QUALITIES as string[]).includes(q)) return q as Quality;
  } catch {
    // storage blocked (private window, sandbox): fall back to the default
  }
  return TUNING.quality.default as Quality;
}

export function createSettings(): SettingsState {
  const q = loadQuality();
  return { quality: q, pedBudget: TUNING.quality[q].pedBudget };
}

/** Apply a preset. Call once at boot (before the shader warm-up) and again whenever the player changes it. */
export function applyQuality(w: World, q: Quality, boot = false): void {
  const p = TUNING.quality[q];
  w.settings.quality = q;
  w.settings.pedBudget = p.pedBudget;
  w.city?.setQuality?.(q); // the map's own draw distance, detail and trees (not yet loaded at the first call)
  if (!boot && w.look) bakeLook(w.look, w.renderer, q); // surface maps at the preset's resolution (a re-bake only if it changed)
  const r = w.renderer;
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.maxDevicePixelRatio) * p.resolutionScale);
  r.setSize(window.innerWidth, window.innerHeight);
  const sun = w.dayNight.sun;
  const shadowsChanged = r.shadowMap.enabled !== p.shadows;
  r.shadowMap.enabled = p.shadows;
  sun.castShadow = p.shadows;
  if (sun.shadow.mapSize.x !== p.shadowMapSize) {
    sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  // switching shadows on/off changes shader code: recompile (only happens from the pause menu)
  if (shadowsChanged && !boot) {
    w.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }
  try {
    localStorage.setItem(KEY, q);
  } catch {
    // not saved; still applied for this session
  }
}
