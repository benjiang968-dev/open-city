// Building records: one per standing building, made by the facade generator (map/facades.ts) from the same numbers
// it draws the exterior with (walls, the front, floor levels, the window grid, the door), so the interior and the
// exterior can never disagree. Ids are stable across sessions, seeds and builds: 'geo:' + the map data id.
//
// A record whose building has a template (house, shop) gets a real doorway: facades.ts cuts the opening into the
// front wall and the building's collision, and keeps the removable part of the collision (the core) in `core`, so the
// interior system can swap it for walls, floors, stairs and furniture when the interior is built (interiors.ts).
import type RAPIER from '@dimforge/rapier3d-compat';
import type { P2 } from './geom';
import type { Plan } from './plan';
import { hash32 } from './geom';
import { TUNING } from '../../tuning';

const I = TUNING.interiors;

export type TemplateId = 'house' | 'shop';

/** A band of facade tiles on a wall (windows for the interior's openings): s along the wall from its a end. */
export interface TileBand { s0: number; s1: number; y0: number; y1: number; tile: number; cols: number; rows: number }

export interface WallRec {
  ax: number; az: number; bx: number; bz: number;
  len: number;
  /** direction a -> b, and the outward normal */
  ux: number; uz: number; nx: number; nz: number;
  party: boolean; street: boolean; front: boolean;
  bands: TileBand[];
}

export interface DoorRec {
  /** wall index in the record, and the door's centre along it (from the wall's a end) */
  wall: number;
  s: number;
  /** centre of the opening on the facade line, at the sill */
  x: number; z: number; sill: number;
  ux: number; uz: number; nx: number; nz: number;
  width: number; height: number;
  style: 'house' | 'shop';
  /** -1: the hinge is at s - width / 2, +1: at s + width / 2 */
  hinge: -1 | 1;
  /** true when the door is at the wall's a end (the plan's u axis runs a -> b), else at the b end */
  atStart: boolean;
  /** leaf colour (sRGB hex) */
  colour: number;
}

export interface BuildingRecord {
  id: string;
  dataId: string;
  pts: P2[];
  type: string;
  levels: number;
  cx: number; cz: number;
  /** bottom of the plinth, the ground floor (door sill), the top of the top storey, the collider's top */
  yMin: number; y0: number; yTop: number; top: number;
  /** floor level of every storey, bottom up (storeys[0] = y0) */
  storeys: number[];
  walls: WallRec[];
  front: number;
  template: TemplateId | null;
  door: DoorRec | null;
  places: string[];
  cats: string[];
  /** facade colour of the walls (packed linear, surface-tagged) for the reveals */
  wallColour: number;
  /** The interior plan (templates.ts), made when the record is (null: no template, or its plan failed: see planErrors). */
  plan: Plan | null;
  /** Why this building has no interior although a template was chosen (empty when it has one). */
  planErrors: string[];
  /** Runtime: the removable part of the building's collision (disabled while its interior is active). */
  core: RAPIER.Collider[];
  /** Runtime: the cold door collider (in core too). */
  plug: RAPIER.Collider | null;
}

export function recordId(dataId: string): string {
  return `geo:${dataId}`;
}

/**
 * Template from the places inside, then the data type (docs/interiors-design.md 4.3). Stage C has the house and the
 * shop; other classes get null (no interior yet) and keep their solid.
 */
export function chooseTemplate(dataId: string, type: string, cats: readonly string[]): TemplateId | null {
  if (I.scope === 'pilot' && !(I.pilotIds as readonly string[]).includes(dataId)) return null;
  if (cats.some((c) => /^amenity=(cafe|restaurant|fast_food|bar|pub|ice_cream)/.test(c))) return null; // cafe template: Stage D
  if (cats.some((c) => c.startsWith('shop='))) return 'shop';
  if (type === 'retail' || type === 'commercial') return cats.length ? null : 'shop';
  if (type === 'house' || type === 'terrace' || type === 'semidetached_house' || type === 'detached' || type === 'residential') return cats.length ? null : 'house';
  return null;
}

/**
 * The front door of a building with a template, or null when the front wall cannot take one. Houses: at one end of
 * the front wall (the side-hall plan), far enough in for the stoop's rails; shops: in the middle.
 */
export function planDoor(rec: BuildingRecord, colour: number): DoorRec | null {
  if (!rec.template) return null;
  const wi = rec.front;
  const w = rec.walls[wi];
  if (!w || w.party) return null;
  const house = rec.template === 'house';
  const width = house ? I.houseDoorWidth : I.shopDoorWidth;
  const height = house ? I.houseDoorHeight : I.shopDoorHeight;
  const edge = house ? Math.max(I.doorEdgeMin, I.partyWall + I.hallWidth / 2) : width / 2 + 0.6;
  if (w.len < 2 * edge + 0.2 && house) return null;
  if (w.len < width + 1.2) return null;
  const atStart = (hash32(rec.dataId + ':door') & 1) === 0;
  const s = house ? (atStart ? edge : w.len - edge) : w.len / 2;
  return {
    wall: wi, s, x: w.ax + w.ux * s, z: w.az + w.uz * s, sill: rec.y0,
    ux: w.ux, uz: w.uz, nx: w.nx, nz: w.nz, width, height, style: house ? 'house' : 'shop',
    hinge: house ? (atStart ? -1 : 1) : -1, atStart, colour,
  };
}

/** Facade window rectangles per tile (fractions of the tile: x0, x1 from the left as seen outside, y0, y1 from the
 * bottom), for the tiles that have windows (map/facadeTex.ts draws them at these places). */
export const TILE_WINDOWS: Record<number, [number, number, number, number][]> = {
  1: [[40 / 128, 88 / 128, 38 / 128, 104 / 128]], // ROW_SHUT
  2: [[40 / 128, 88 / 128, 38 / 128, 104 / 128]], // ROW_WIN
  6: [[8 / 128, 120 / 128, 26 / 128, 96 / 128]], // SHOP
  8: [[12 / 128, 58 / 128, 34 / 128, 104 / 128], [70 / 128, 116 / 128, 34 / 128, 104 / 128]], // OFFICE
  18: [[22 / 128, 106 / 128, 36 / 128, 104 / 128]], // APT (two casements as one opening)
};
