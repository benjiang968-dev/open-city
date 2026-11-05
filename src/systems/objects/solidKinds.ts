// Solid kinds: the one registry of what the world is made of, physically. Every prop or structure type the map
// generators draw declares here what it is (static / dynamic / interactive, the Stage 2 object classes), which
// collider shape it gets, and whether the player must be stopped by it. The generators tag their colliders and
// (in audit mode) their drawn geometry with these kinds; the physics audit (physicsAudit.ts) and the F4 collision
// view (physicsDebug.ts) read the tags back.
//
// Groundwork for Stage 2 (universal objects): pickup, inventory and interiors are NOT built here. A kind that later
// becomes movable (a bin, a chair) changes its `cls` and gets a body of its own instead of a static chunk collider.

/** Stage 2 object classes. static: part of the world, collides, never moves. dynamic: a loose Rapier body that
 * sleeps until touched. interactive: a static or kinematic thing with its own behaviour (doors, drawers). */
export type ObjectClass = 'static' | 'dynamic' | 'interactive';

/**
 * How the collider is built. trimesh: part of the 120 m chunk's ground trimesh. box / cylinder / hull: primitives
 * (Rapier cuboid, cylinder, convex hull) in the chunk's fixed body. ramp: a smooth sloped collider (convex hull or
 * trimesh strip) under drawn steps. boxes: a few boxes per object. body: the object's own rigid body. none: drawn only.
 */
export type ColliderShape = 'trimesh' | 'box' | 'cylinder' | 'hull' | 'ramp' | 'boxes' | 'body' | 'none';

export interface SolidKindDef {
  readonly label: string;
  readonly cls: ObjectClass;
  readonly shape: ColliderShape;
  /** The player must be stopped by it: the audit requires a collider that matches what is drawn. */
  readonly solid: boolean;
  /** F4 collision view colour (0xRRGGBB). */
  readonly color: number;
  /** Audit: metres the collider may differ from the drawn surface (sticking out or set back). */
  readonly tol: number;
  /** Audit: the height band above the floor (m) the player's body can touch; drawn parts above it don't need a
   * collider (tree crowns, awnings over the pavement). */
  readonly band: number;
}

const k = (label: string, cls: ObjectClass, shape: ColliderShape, solid: boolean, color: number, tol = 0.12, band = 1.7): SolidKindDef =>
  ({ label, cls, shape, solid, color, tol, band });

/** Every kind, in a fixed order (the index is the compact kind id stored per collider). */
export const SOLID_KINDS = {
  untagged: k('untagged (no kind set)', 'static', 'none', true, 0xff00ff),
  ground: k('ground: terrain, roads, sidewalks, junctions, lots', 'static', 'trimesh', true, 0x4f9a5a),
  kerb: k('kerb (road and lot edges)', 'static', 'trimesh', true, 0x8fbf8f, 0.06),
  deck: k('bridge / freeway deck', 'static', 'trimesh', true, 0x5aa0a0),
  parapet: k('bridge parapet', 'static', 'trimesh', true, 0x6fc0c0),
  // tolerance 0.14: the ramp runs half a riser (0.085 m) above the line through the risers' feet at 0.62 rise per run,
  // so a riser's face is up to 0.085 / 0.62 = 0.137 m in front of or behind the ramp (by design: a smooth ramp)
  stair: k('stair flight (ramp under the treads)', 'static', 'ramp', true, 0xffd24a, 0.14),
  stairWall: k('stair side wall', 'static', 'trimesh', true, 0xe0b040),
  stoop: k('house stoop (landing + steps)', 'static', 'ramp', true, 0xffa040, 0.12),
  stoopRail: k('stoop railing', 'static', 'hull', true, 0xd08030, 0.1),
  building: k('building (footprint box or prism)', 'static', 'hull', true, 0x9a8cff, 0.15),
  tower: k('tower, steeple, smokestack', 'static', 'box', true, 0x8070e0, 0.3),
  column: k('column (portico, arcade, bridge pier)', 'static', 'cylinder', true, 0xb0a0ff, 0.12),
  bridgePier: k('bridge pier / abutment', 'static', 'box', true, 0x7090c0, 0.4),
  monument: k('monument plinth, statue base, gate post', 'static', 'boxes', true, 0xe0e0e0, 0.12),
  railing: k('railing / fence', 'static', 'box', true, 0xc0c0c0, 0.12),
  wall: k('low wall / parapet (not a bridge)', 'static', 'box', true, 0xd0c0a0, 0.12),
  canopy: k('glass canopy', 'static', 'hull', true, 0x80c0ff, 0.2),
  pier: k('pier / boardwalk deck', 'static', 'box', true, 0xc09060, 0.1),
  boat: k('moored boat', 'static', 'boxes', true, 0xffffff, 0.2),
  lockGate: k('canal lock gate and balance beam', 'static', 'boxes', true, 0xa07040, 0.12),
  fountain: k('fountain basin', 'static', 'cylinder', true, 0x60b0ff, 0.15),
  tree: k('tree trunk', 'static', 'cylinder', true, 0x30c030, 0.1, 1.0), // band 1 m: low conifer branches start at 1.2 m
  lamp: k('street lamp', 'static', 'cylinder', true, 0xffe080, 0.1),
  signalPole: k('traffic signal pole', 'static', 'cylinder', true, 0xff6060, 0.1),
  signPost: k('sign post (stop sign, street sign, taxi rank)', 'static', 'cylinder', true, 0xff9090, 0.1),
  bench: k('bench (seat + back)', 'static', 'boxes', true, 0xb07040, 0.1),
  busShelter: k('bus shelter (panels, roof, bench, sign)', 'static', 'boxes', true, 0x60a0c0, 0.12),
  gravestone: k('gravestone', 'static', 'box', true, 0xb0b0a0, 0.1),
  container: k('shipping container stack', 'static', 'box', true, 0xc04040, 0.12),
  kiosk: k('kiosk', 'static', 'box', true, 0xf08080, 0.12),
  boundary: k('invisible map edge / safety floor', 'static', 'box', true, 0xff40ff),
  // drawn only: decoration or out of reach (no collider needed)
  overhead: k('overhead detail (awning, canopy, sign board, cornice)', 'static', 'none', false, 0x808080),
  roof: k('roof clutter and roof shapes', 'static', 'none', false, 0x808080),
  decor: k('flat or tiny decoration (decals, sills, rail tops, jets)', 'static', 'none', false, 0x808080),
  water: k('water surface', 'static', 'none', false, 0x3060ff),
  // Stage 2 groundwork: classes that exist today as bodies of their own
  vehicle: k('vehicle (own dynamic body)', 'dynamic', 'body', true, 0xff8000),
  item: k('loose item (own dynamic body)', 'dynamic', 'body', true, 0xffc000),
  person: k('person capsule (kinematic)', 'interactive', 'body', true, 0x00e0ff),
  // declared for Stage 2 (not placed yet): street furniture that will be movable or usable
  bin: k('litter bin (Stage 2: dynamic, sleeps until hit)', 'dynamic', 'body', true, 0x707070),
  door: k('door (Stage 2: interactive, opens)', 'interactive', 'box', true, 0x804020),
} as const satisfies Record<string, SolidKindDef>;

export type SolidKind = keyof typeof SOLID_KINDS;
/** Kind names by id (the order above). */
export const SOLID_KIND_LIST: readonly SolidKind[] = Object.keys(SOLID_KINDS) as SolidKind[];
const IDS = new Map<SolidKind, number>(SOLID_KIND_LIST.map((n, i) => [n, i]));
/** Compact id of a kind (what collider tags and audit records store). */
export function solidKindId(kind: SolidKind): number {
  return IDS.get(kind)!;
}
export function solidKindName(id: number): SolidKind {
  return SOLID_KIND_LIST[id] ?? 'untagged';
}
export function solidKindDef(id: number): SolidKindDef {
  return SOLID_KINDS[solidKindName(id)];
}

/**
 * Collider handle -> kind id, filled by whoever creates static colliders (PhysChunks, the grid generator). Lives on
 * the map (CityMap.solidTags), never in a module-level global. Reading it is only for the audit and the F4 view.
 */
export class SolidTags {
  private readonly byHandle = new Map<number, number>();
  set(handle: number, kind: SolidKind): void {
    this.byHandle.set(handle, solidKindId(kind));
  }
  /** Kind id of a collider, or -1 if it was never tagged (cars, people and items are tagged by class elsewhere). */
  get(handle: number): number {
    return this.byHandle.get(handle) ?? -1;
  }
  get size(): number {
    return this.byHandle.size;
  }
  /** Count per kind name (for reports). */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.byHandle.values()) {
      const n = solidKindName(id);
      out[n] = (out[n] ?? 0) + 1;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------ prop colliders
/**
 * One part of a prop's collider in the prop's own frame (x along the prop, z across, y up from its base), matching
 * the prop's drawn geometry. box: centre c and half extents h. cyl: upright cylinder standing at c with radius r and
 * height h (r scales with the prop's horizontal scale, h with its vertical scale).
 */
export type ColliderPart =
  | { readonly shape: 'box'; readonly c: readonly [number, number, number]; readonly h: readonly [number, number, number] }
  | { readonly shape: 'cyl'; readonly c: readonly [number, number, number]; readonly r: number; readonly h: number };

/**
 * Colliders of the instanced props, per kind, in metres of the prop's own geometry (props.ts / cityGen.ts draw the
 * same shapes). A generator places a prop with PhysChunks.placeProp(kind, x, y, z, yaw, scale): one static collider
 * per part in the 120 m chunk body. Stage 2 can give a kind its own body instead without touching the generators.
 */
export const PROP_COLLIDERS = {
  // Georgetown street furniture (props.ts)
  lamp: [
    { shape: 'cyl', c: [0, 0, 0], r: 0.22, h: 0.6 }, // cast-iron base
    { shape: 'cyl', c: [0, 0.6, 0], r: 0.09, h: 3.6 }, // pole (the globe 4.6 m up is out of reach)
  ],
  signalPole: [{ shape: 'cyl', c: [0, 0, 0], r: 0.15, h: 6.3 }],
  stopPost: [{ shape: 'cyl', c: [0, 0, 0], r: 0.07, h: 2.6 }],
  tree: [{ shape: 'cyl', c: [0, -0.1, 0], r: 0.22, h: 2.7 }], // trunk: 0.24 m at the foot, 0.16 at 2.7 m
  bench: [
    { shape: 'box', c: [-0.75, 0.225, 0], h: [0.05, 0.225, 0.25] }, // iron legs
    { shape: 'box', c: [0.75, 0.225, 0], h: [0.05, 0.225, 0.25] },
    { shape: 'box', c: [0, 0.445, -0.01], h: [0.95, 0.025, 0.23] }, // seat slats
    { shape: 'box', c: [0, 0.75, 0.265], h: [0.95, 0.15, 0.025] }, // back rails
  ],
  busShelter: [
    { shape: 'box', c: [0, 1.2, 0.585], h: [2.0, 1.2, 0.04] }, // back panel
    { shape: 'box', c: [-2, 1.2, 0.01], h: [0.05, 1.2, 0.61] }, // side panels
    { shape: 'box', c: [2, 1.2, 0.01], h: [0.05, 1.2, 0.61] },
    { shape: 'box', c: [0, 2.525, -0.025], h: [2.15, 0.075, 0.775] }, // roof
    { shape: 'box', c: [0, 0.485, 0.35], h: [1.4, 0.035, 0.15] }, // bench slab (drawn without legs)
    { shape: 'box', c: [2.63, 1.3, -0.72], h: [0.04, 1.3, 0.04] }, // sign post
  ],
  gravestone: [
    { shape: 'box', c: [0, 0.425, 0], h: [0.35, 0.475, 0.08] }, // stone
    { shape: 'box', c: [0, 0.975, 0], h: [0.22, 0.075, 0.08] }, // rounded top
  ],
  // grid city (cityGen.ts)
  gridBench: [{ shape: 'box', c: [0, 0.45, 0], h: [1, 0.05, 0.3] }], // a slab, as drawn
  gridSignPost: [{ shape: 'box', c: [0, 1.65, 0], h: [0.05, 1.65, 0.05] }],
  gridTaxiPost: [{ shape: 'box', c: [0, 1.3, 0], h: [0.06, 1.3, 0.06] }],
} as const satisfies Record<string, readonly ColliderPart[]>;
export type PropColliderName = keyof typeof PROP_COLLIDERS;
/** The solid kind each prop collider is tagged with. */
export const PROP_KIND: Record<PropColliderName, SolidKind> = {
  lamp: 'lamp', signalPole: 'signalPole', stopPost: 'signPost', tree: 'tree', bench: 'bench', busShelter: 'busShelter',
  gravestone: 'gravestone', gridBench: 'bench', gridSignPost: 'signPost', gridTaxiPost: 'signPost',
};

// ------------------------------------------------------------------------------------------ audit recorder
/** Record types the recorder stores (drawn primitives the audit probes). */
export const REC = { OBOX: 0, CYL: 1, WALL: 2 } as const;
/** Floats per record: type, kind, then 10 shape numbers (see SolidRecorder.obox / cyl / wall). */
export const REC_STRIDE = 12;

/**
 * Audit mode only (URL ?physaudit=1): every box, cylinder and wall a generator draws is recorded with the kind that
 * is current when it is drawn, so the audit can compare what is drawn with what Rapier reports there. Off (null
 * recorder) costs one null check per drawn primitive at boot and nothing at run time.
 */
export class SolidRecorder {
  data = new Float32Array(REC_STRIDE * 4096);
  n = 0;
  /** Kind id stamped on the next records (set with `tag`). */
  kind = 0;
  tag(kind: SolidKind): void {
    this.kind = solidKindId(kind);
  }
  private push(type: number): number {
    if ((this.n + 1) * REC_STRIDE > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    const o = this.n * REC_STRIDE;
    this.data[o] = type;
    this.data[o + 1] = this.kind;
    this.n++;
    return o;
  }
  /** Oriented box: centre (cx, cz), y0..y1, half extents hx along (ux, uz) and hz across. */
  obox(cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, ux: number, uz: number): void {
    const o = this.push(REC.OBOX), D = this.data;
    D[o + 2] = cx; D[o + 3] = cz; D[o + 4] = y0; D[o + 5] = y1; D[o + 6] = hx; D[o + 7] = hz; D[o + 8] = ux; D[o + 9] = uz;
  }
  /** Upright cylinder / frustum: centre (cx, cz), y0..y1, radius r0 at the bottom, r1 at the top. */
  cyl(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number): void {
    const o = this.push(REC.CYL), D = this.data;
    D[o + 2] = cx; D[o + 3] = cz; D[o + 4] = y0; D[o + 5] = y1; D[o + 6] = r0; D[o + 7] = r1;
  }
  /** Vertical wall a-b, bottom/top at each end, facing (hx, hz). */
  wall(ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number, hx: number, hz: number): void {
    const o = this.push(REC.WALL), D = this.data;
    D[o + 2] = ax; D[o + 3] = az; D[o + 4] = bx; D[o + 5] = bz; D[o + 6] = ya0; D[o + 7] = ya1; D[o + 8] = yb0; D[o + 9] = yb1; D[o + 10] = hx; D[o + 11] = hz;
  }
}
