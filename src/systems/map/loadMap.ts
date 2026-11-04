// Picks the map implementation from the URL (?map=grid). Only the URL chooses the map; the seed never does.
// Unknown names fall back to the default map with a console warning (not an error), so old links keep working.
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../../tuning';
import type { CityMap, MapId } from './cityMap';
import { createGridMap } from './gridMap';

const MAPS: Partial<Record<MapId, (scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number) => CityMap>> = {
  grid: createGridMap,
};

/** The map id the URL asks for (or the default). */
export function mapIdFromUrl(): string {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('map');
  return q && q.trim() ? q.trim().toLowerCase() : TUNING.map.defaultMap;
}

export function loadMap(scene: THREE.Scene, R: typeof RAPIER, physics: RAPIER.World, seed: number): CityMap {
  const want = mapIdFromUrl();
  let make = MAPS[want as MapId];
  if (!make) {
    console.warn(`Unknown map "${want}" in the URL; loading "${TUNING.map.defaultMap}" instead.`);
    make = MAPS[TUNING.map.defaultMap as MapId]!;
  }
  return make(scene, R, physics, seed);
}
