// Picks the map implementation from the URL (?map=grid, ?map=georgetown). Only the URL chooses the map; the seed
// never does. Unknown names fall back to the default map with a console warning (not an error), so old links keep
// working. Real maps are loaded on demand: their code and data are separate chunks the grid city never downloads.
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../../tuning';
import type { CityMap, MapId } from './cityMap';
import { createGridMap } from './gridMap';

type Quality = 'low' | 'medium' | 'high';
type MapFactory = (scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number, quality: Quality) => Promise<CityMap>;

const MAPS: Record<MapId, MapFactory> = {
  grid: async (scene, R, physics, seed) => createGridMap(scene, R, physics, seed),
  georgetown: async (scene, R, physics, seed, quality) => {
    const m = await import('./georgetownMap');
    const doc = await m.loadGeorgetownDoc();
    return m.createGeorgetownMap(scene, R, physics, seed, doc, quality);
  },
};

/** The map id the URL asks for (or the default). */
export function mapIdFromUrl(): string {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('map');
  return q && q.trim() ? q.trim().toLowerCase() : TUNING.map.defaultMap;
}

/** Builds the map the URL asks for. `quality` is the starting graphics preset (real maps size their detail by it). */
export async function loadMap(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number, quality: Quality): Promise<CityMap> {
  const want = mapIdFromUrl();
  let make = (MAPS as Partial<Record<string, MapFactory>>)[want];
  if (!make) {
    console.warn(`Unknown map "${want}" in the URL; loading "${TUNING.map.defaultMap}" instead.`);
    make = MAPS[TUNING.map.defaultMap as MapId];
  }
  return make(scene, R, physics, seed, quality);
}
