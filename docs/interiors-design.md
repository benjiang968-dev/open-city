# Enterable buildings: audit and interior system design

Stage A (buildings half) of the owner's request of 2026-11-05 ("make houses and buildings enterable"). Branch `cr-audit-buildings` (s1-integrate 4900f12 + main eac5385). This document answers the owner's four questions with evidence from the code and the running game, maps the pipeline the interior system plugs into, gives the building statistics of the real Georgetown map, and designs the system that Stages C and D build. Nothing here is implemented yet: today no building in the game can be entered.

Evidence tools (both committed on this branch):
- `node scripts/auditBuildings.mjs [outDir]` serves `dist/`, boots the game (Georgetown, Low, seed 123, 800x450, headless Chromium 153 with SwiftShader software GL) and queries the running world: collider inventory, Rapier point and ray queries for every building and every place door, keyboard walks into three doors, physics step cost, screenshots with and without the F4 collision view. `MAP=grid` runs it on the grid city.
- `node scripts/buildingStats.mjs [out.json]` reads the map data (no browser) and prints the statistics tables in section 3.

Numbers below are from those runs on 2026-11-05 (machine load average 9 to 15 on 4 shared cores, so timings are indicative only).

## 1. The owner's four questions

### 1.1 Are buildings only exterior meshes? Yes.

- `src/systems/map/facades.ts` `buildBuildings` draws each footprint as outward-facing wall quads (`fquad`), one per wall and floor band (plinth, ground floor, upper floors, parapet), a roof (`froof` triangles or `pitchedRoof`) and exterior details (cornices, sills, stoops, canopies, signs, awnings). All of it is merged into the 240 m render chunks (`RenderChunks`, layers `facade` / `ground` / `detail`). There are no inner faces, floors, ceilings or rooms.
- Windows and doors are pixels of a texture array (`src/systems/map/facadeTex.ts` `TILE.DOOR_BLACK`, `SHOP_DOOR`...), chosen per bay in the shader (`fquad(..., tileA, tileB, alt)`: bay `alt` gets the door tile). The "rooms" seen through windows are interior mapping in `src/systems/render/facadeMaterial.ts` (a ray-box trick per window), not geometry. The door's relief is a 3 cm height-map dent.
- The facade material is single-sided (`MeshStandardMaterial`, default `FrontSide`), so from inside a footprint every wall is invisible.
- The running game has no object named door, interior or room in the scene graph, and no collider of the registry kind `door` (`auditBuildings`: `doorColliders: 0`). The `door` kind exists in `src/systems/objects/solidKinds.ts` only as a Stage 2 placeholder.
- Screenshots: `screenshots/40-audit-buildings-georgetown-stoop.png` (the player on a stoop landing, pressed against a flat painted door), `-shop.png` (the player at the "door" the game uses for a shop on M St NW, which is a shop window), `-inside.png` (the camera 2.5 m behind that rowhouse's door at head height, looking toward the back: no floor, wall or room; the ground under the house, the neighbour's side wall and the houses behind are seen straight through the house's own walls).

### 1.2 Is a full-building collider blocking the entrance? Yes, a solid over the whole footprint.

- `facades.ts` lines 395-412: every building gets `phys.box(...)` (an oriented box, when the footprint is nearly a rectangle) or `phys.prism(piece, yMin, top)` for each convex piece of a concave footprint (`convexPieces`, Hertel-Mehlhorn), from 0.6 m below the lowest ground to the top of the parapet or 2 m above the eaves. Kind `building`. There is no gap at any door.
- Runtime (`auditBuildings`, Georgetown): 10,588 `building` colliders for 4,693 standing buildings (2.3 pieces each on average). For 4,687 of 4,693 buildings a point 1.2 m above the floor at the footprint's middle lies inside a `building` collider (Rapier `intersectionsWithPoint`); 4,668 at half the building height; a ray straight down from 400 m hits a `building` collider first for 4,688. The six exceptions are small one- or two-storey `building=yes` footprints whose middle point is outside their collider pieces (ids `bd1e587eefc08`, `bda43b6ee5e7b`, `b4534e396cec9`, `be0581820a358`, `be7b3543e0ba9`, `b7fcefa0bbaf8`; to look at, not an opening).
- Every place door: of the 1,499 places whose door (`Poi.door`) lies on a footprint, a horizontal ray from the pavement spot (`Poi.x, z`) toward the door at 0.3, 1.0 and 1.8 m above the pavement is stopped within 0.35 m of the door point at all three heights for 1,496 (median distance from the door point 0.00 m). The first collider hit at 1.0 m is `building` for 1,479, a stoop or stoop rail for 19 (the rail stands in front of the door) and a bus shelter for 1.
- Keyboard walks (held `KeyW`, then `Shift+W`, then `E`, then `Space+W`; positions from the Rapier body each 60 Hz step; the character controller's collisions tagged by kind):

  | door | building (data id) | walk | stopped at | collisions while pushing | prompt at the door | E |
  |---|---|---|---|---|---|---|
  | rowhouse stoop, 7 steps, near the spawn (-677.6, 121.3) | `b23e0ce279d85` (house, 3 storeys) | from the pavement 4.2 m out: up the stoop (feet 25.89 -> 27.34 m, landing 27.30 m), then 0 m further when walking, running and jumping | 0.39 m from the facade line (capsule radius 0.35 + controller skin 0.04) | `building` 76 frames (walk), 92 (run), 76 (jump); `stoop` 147 | none | nothing happens (moved 0 m) |
  | shop "Easel House", M St NW (-652.5, 147.8) | `be01bab3a0eeb` (retail, 2 storeys) | from the pavement 2.7 m out | 0.60 m (0.39 m at chest height in front) | `building` 121 frames | none | nothing |
  | office "Quayside Holdings", M St NW (-655.6, 147.8) | `b19bee4249eed` (retail, 2 storeys) | from the pavement 2.7 m out | 0.39 m | `building` 117 frames | none | nothing |

  Behind each of these doors, 1 m inside, the point query returns `building`: the inside is solid.
- The F4 view (`-stoop-f4.png`, `-shop-f4.png`) draws the `building` collider (purple) as one block over the whole facade, door and windows included.
- What would hold the player up if the solid were simply removed: a ray down from 1.2 m above the ground at each footprint's middle, ignoring `building` and `tower` colliders, hits the ground trimesh at ground level for 4,686 of 4,693 buildings (the terrain is not cut under footprints); the others hit nothing (1), the ground more than 0.3 m lower (1), the safety floor (2) or something above (3: the boundary or a stair wall). But the ground floor is drawn at `y0`, up to 2.4 m above that ground (stoops), so "remove the solid" would drop the player to the dirt under a floating door sill: the interior needs its own floor at `y0`, in place before the solid goes (4.6, 4.8).

### 1.3 Do doors have interactions? No.

- `src/systems/player.ts` `updatePlayer` builds the only interaction prompt: in a vehicle "E get out"; a car break-in in progress; a clinic door (`clinicNearby`, a distance check to a place, no door object); then the nearest of a loose item (`itemsState.target`), a person (`nearestPed` within `TUNING.player.talkRange` 3 m) or a car (within `enterCarRange` 3.6 m). Nothing looks for a door.
- The keyboard walks above found an empty prompt at all three doors and E changed nothing.
- `Poi.door` (`src/systems/map/cityMap.ts`) is just a point used by gameplay (taxi drop-offs, homes, clinics). In Georgetown it is computed by `georgetownMap.ts` `frontOf`: the point of the footprint nearest the kerb. That is not where `facades.ts` paints the door (the front wall is the non-party wall nearest a street; the door is in bay 0 or the last bay for houses, the middle bay otherwise). Where both exist in one building (276 places in buildings with a stoop), the gameplay door is a median 1.61 m and up to 30.9 m from the painted stoop door, more than 1 m away for 207 of 276. The shop walk above ended at a shop window for the same reason.

### 1.4 Are rooms, floors and stairs missing? Yes, all of them.

There is no interior geometry, no floor collider other than the solid, no stair inside any building, no interior light, and no furniture. The only building stairs are the exterior stoops (`stoopColliders`: a convex ramp under the steps plus two rail slabs, 2,176 stoops, 4,352 rail colliders) and the landmark stairs in `bridges.ts`. The grid city (`?map=grid`) is the same: `cityGen.ts` `addBuilding` draws a box with window decals and adds `addBoxCollider(x0, 0, z0, x1, h, z1, 'building')`; its places have a door point on the pavement and nothing on the building.

## 2. The pipeline today

### 2.1 Data, ids and places

- Footprints: `src/data/georgetown.json` (4,584, ODbL) plus `georgetown-buildings-ccby.json` (129, Esri CC BY 4.0), joined by `geoDoc.ts loadGeoDoc`. Each has `id`, `h` (m), `type` (OSM-style class from Overture, or `yes`), `levels`, `est` (height estimated: 2,882 of 4,713), optional `minH`, `roof`, `holes` (13 courtyards) and `pts` (x east, z south, metres from the crop centre).
- Ids: `scripts/importOverture.mjs` `uniqueId(shortId(gersId, 'b'))` = `b` + the first 12 hex digits of the Overture GERS id. They do not depend on the seed, the session or the build, and survive re-imports as long as Overture keeps the feature's GERS id (Overture's stated policy for persisting features). Ten ids carry a `.1` suffix because two GERS prefixes collided; the suffix depends on import order (risk 8).
- The world modifies footprints deterministically (never by seed): `clipBuildingsToStreets` trims 551 footprints back from a carriageway and `buildingsUnderDecks` drops 20 (no mesh, no collider; their ids are in `GeoWorld.droppedBuildings`).
- Places: `georgetown-places.json` (1,623, CDLA-Permissive-2.0), each with `cat` (e.g. `shop=clothes`) and `b`, the building id it stands in (1,479 places in 639 buildings). `georgetownMap.ts` turns them into `Poi`s: invented names from `src/data/poiNames.ts` keyed by place id and seed, a `kind` from `KIND` / `kindOf`, a pavement spot and `door` from `frontOf`. The `Poi` keeps no building id; `CityMap.buildings` (`Building`: `pts`, `h`, bounds) keeps no id or type either; its index order is the data order minus the dropped buildings. Up to 160 extra `apartment` places are picked among residential footprints as homes for people (`TUNING.map.homePois`).
- Grid city: `cityGen.ts` places rectangular buildings per block from the world seed (the grid's geometry changes with `?seed=`; Georgetown's never does), `gridMap.ts` exposes them as `Building`s; places come from `cityGen` with a door point on the pavement.

### 2.2 How Georgetown buildings are built (`facades.ts buildOne`)

1. Walls: one per footprint edge (>= 0.3 m), outward normal, `party` when 2 of 3 points 0.8 m outside fall on another building in the raster, `street` when a carriageway edge is within 9 m of a probe 4 m out. The front is the non-party wall nearest a street.
2. Levels: `ySide` = ground 1.6 m in front of the front wall's middle; ground floor level `y0 = ySide + stoop` (houses at x <= 380, Georgetown proper: 0.45 to 1.05 m from the building's random stream; others 0.05 m); ground storey 4.2 m (retail, warehouse, commercial outside the West End), 0 for churches, else 3.3 m; upper storeys 3.2 m (`STOREY`); `yTop = y0 + ground + (levels - 1) * 3.2`; parapet 0.7 m; plinth from the lowest ground minus 0.6 m up to `y0`.
3. Style per type (`switch (t)`): only `house`/`terrace`, `retail`, `commercial`, `apartments`, `university`, `warehouse`, `civic` and `church` have their own looks; every other type (1,750 `yes`, schools, hotels, dormitories...) gets the default brick with row-house windows and a black door.
4. Walls are drawn per band with tile ids for ground / upper floors and the door bay (`doorBay`: 0 or last bay for houses, middle bay otherwise, 255 = none). Party walls get plain wall. Cornices, sills, stoops (`stoopColliders`), canopies and rails on the front / street walls; roofs, chimneys and roof plant; landmark extras.
5. Shop signs and awnings for places of `SIGN_CATS` on the front wall, names from `poiName`.
6. Collider: the footprint solid of section 1.2.

`georgetownWorld.ts` then builds one `THREE.Mesh` per chunk and layer (349 meshes, 2.48 M triangles) and `PhysChunks.finishTrimeshes` the ground. `stats.phases.buildings` was 2.2 s of the 8.7 s headless world build.

### 2.3 Interaction, items, persistence

- Input: `src/systems/input.ts` keeps `keys` / `pressed` sets; `act.interact` = E pressed. Tank controls: A/D turn, W/S walk.
- Targeting: `player.ts` (section 1.3). Loose items: `worldItems.ts updateWorldItems` picks `S.target` within `TUNING.items.pickupRange` 1.8 m and a facing cone (`pickupCone` 0.4), score `d - dot * 0.6`, and floats a yellow marker over it.
- Items: 8 hard-coded types (`src/art/items.ts ItemId`: bottle, can, bag, box, cone, brick, wrench, bat) with gameplay numbers in `TUNING.items.defs` and code-built meshes. `scatterItems` places 427 items at boot from the seed (litter, bags and boxes by shops, cones, bricks, bats, wrenches), every one a dynamic Rapier body (sleeping) wherever it is in the city, drawn with one `InstancedMesh` per type. `WorldItem.id` is its index in `ItemsState.items`: an id that changes when the generator changes and means nothing across sessions. `inventory.ts`: a 9-slot hotbar of `WorldItem` references; E picks up (`pickUp` -> `removeFromWorld` disables the body), Q drops (`dropSelected` -> `placeInWorld` re-enables the same body with a toss), left click throws or swings (`combat.ts`). No owner (only a `stolen` flag), no containers, no weights limit, no persistence.
- Persistence: none. `settings.ts` stores the quality preset in `localStorage` (`openCity.quality`); nothing else is written anywhere (no IndexedDB, no save, no load). Every reload starts at the spawn with $150 and the seed's items.
- HUD: `hud.ts` shows the full controls list (`#help`) from the start of play and only fades it to 40 % after 15 s (it is still on screen in every screenshot of this audit), the one-line `#prompt` from `player.prompt`, cash, stars, clock, job banner and toasts. `pauseMenu.ts` already has a controls block.

### 2.4 Physics chunks and streaming

- All static physics is built at boot for the whole 2.1 x 1.9 km map; nothing streams. `PhysChunks` puts every collider in one fixed body per 120 m chunk: 308 fixed bodies, 28,575 world colliders (29,143 with cars, people and items), 444,887 trimesh triangles. By kind: tree 6,527, building 10,588, stoop rail 4,352, stoop 2,176, lamp 2,244, bench 756, sign post 323, bus shelter 324, railing 333, ground 306 trimeshes, signal pole 213, ...
- Dynamic: 507 dynamic bodies (427 items and the drivable cars), 61 kinematic (the player, people). Items sleep until touched; nothing is created or destroyed by distance.
- Rendering streams by visibility only: `georgetownWorld.update` hides chunk layers beyond the draw distance and the near-detail layer beyond `GEO_QUALITY[q].detail` (80 / 170 / 340 m).
- Step cost: the profiler's `physics` section (Rapier `world.step` plus event drain) averaged 0.97, 0.91 and 2.45 ms per 60 Hz step over 240 steps in three runs, the whole fixed step (player, vehicles, traffic, police, physics, crashes) 1.5, 1.6 and 2.9 ms (Low, no rendering, the busy shared machine above: the third run overlapped other agents' builds). A baseline for the collider changes of 4.6 and 4.7 must be taken on a quiet machine, interleaved with the new build.

## 3. Georgetown building statistics

`node scripts/buildingStats.mjs` (data footprints before the world's street clip; 4,713 footprints, 1,623 places, 1,479 of them in 639 buildings). The template class is the class of the places inside when there are any (cafe/restaurant > shop > garage/workshop > office > institution > hotel), else the data type.

| class (template) | buildings | share | by data type only | with a place | median area m2 | median width m | median storeys | storeys >= 4 | concave | narrow < 4.5 m | street door | party walls | terrain fall > 1.5 m |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rowhouse/house | 2573 | 54.6 % | 2714 | 3 | 75 | 5.6 | 3 | 19 | 1436 | 427 | 2437 | 2550 | 517 |
| apartment | 43 | 0.9 % | 50 | 20 | 500 | 16.7 | 4 | 23 | 26 | 1 | 43 | 27 | 21 |
| shop | 211 | 4.5 % | 77 | 199 | 126 | 7.4 | 3 | 45 | 119 | 8 | 208 | 192 | 96 |
| cafe/restaurant | 181 | 3.8 % | 0 | 181 | 206 | 10.4 | 3 | 67 | 115 | 4 | 179 | 143 | 87 |
| office | 154 | 3.3 % | 0 | 154 | 221 | 11.5 | 3 | 49 | 113 | 8 | 149 | 111 | 79 |
| garage/workshop | 14 | 0.3 % | 4 | 11 | 124 | 8.7 | 2 | 2 | 7 | 0 | 14 | 5 | 2 |
| church/institution | 63 | 1.3 % | 48 | 55 | 352 | 15.4 | 3 | 20 | 49 | 3 | 61 | 30 | 28 |
| shed/outbuilding | 58 | 1.2 % | 58 | 0 | 20 | 3.5 | 1 | 0 | 1 | 48 | 56 | 15 | 0 |
| open structure (roof, shelter, pavilion, guardhouse) | 7 | 0.1 % | 12 | 0 | 53 | 7.3 | 1 | 0 | 1 | 1 | 5 | 1 | 1 |
| untyped (`building=yes`, no place) | 1409 | 29.9 % | 1750 | 15 | 70 | 6.6 | 2 | 158 | 577 | 316 | 1151 | 681 | 352 |
| **all** | 4713 | 100 % | 4713 | 638 | 79 | 6.0 | 3 | 383 | 2444 | 816 | 4303 | 3755 | 1183 |

- Data types: house 2,705, yes 1,750, retail 73, shed 58, apartments 40, church 21, school 12, roof 9, university 8, dormitory 5, hotel 5, library 4, residential 4, commercial 4, semidetached_house 4, garage 3, hospital 2, and one each of guardhouse, boathouse, post_office, detached, shelter, pavilion.
- Places by template class: office 554 (offices, banks, clinics, gyms...), shop 479, cafe/restaurant 283, institution 165, hotel 52, garage/workshop 29, and 61 `tourism=attraction` with no template. 141 house footprints have a place inside (a shop or office downstairs), 320 buildings hold 2 or more places, one holds 34.
- Untyped footprints without a place (1,409) by the fallback proposed in 4.3: house 1,027, shed 252, garage / carriage house in a back lot 98, large office / lobby 32.
- Area: < 20 m2 193, 20-40 461, 40-80 1,750, 80-150 1,528, 150-300 443, 300-1000 223, 1000-3000 74, >= 3000 41.
- Width (short side of the minimum box): < 3 m 102, 3-4.5 m 714 (436 houses), 4.5-6 m 1,514 (1,198 houses), 6-8 m 1,291, 8-12 m 581, 12-20 m 292, >= 20 m 219. 1,042 footprints are at least three times as long as wide.
- Shape: concave in the colliders' sense (a notch deeper than `TUNING.geo.footprintNotchTol` 0.3 m) 2,444 (52 %); 13 with courtyards; 2,476 nearly rectangular (area >= 95 % of the box); 1,917 quads; 350 with more than 12 vertices; 193 tiny (< 20 m2).
- Storeys (data `levels`): 1: 496, 2: 1,236, 3: 2,598 (2,052 houses), 4: 225, 5: 71, 6: 17, 7: 10, 8+: 60. 61 % of heights are estimated. The exterior is drawn from `levels`, not `h` (wall top from the storeys minus the data height: median +0.4 m, 10-90 % -1.4 to +0.6 m), so the interior must use the exterior's storey lines.
- Doors: 4,703 buildings have a non-party wall and so a painted door; 10 are walled in on every side and have none (`b686ab73b3ccc`, `be1e7d12e8569`, `b9ebe63d5b50a`, `b8b4a82304a7b`, `b7eb9fcc96051`, `b08cd77493f46`, `b15cac590a101`, `ba0e1fc95072a` and two more in `stats.json`). Street-facing front (probe within 9 m of a carriageway) 4,303 (91 %); front more than 30 m from any street 77 (campus, back lots, courtyards).
- Stoops: 2,198 footprints get the rowhouse stoop treatment (type house at x <= 380, west of the West End), 2,176 stoops are drawn (rise 0.2 to 2.4 m at the door). 817 footprints are in the West End (x > 380: level entrances).
- Party walls: 3,755 buildings (80 %) share a wall; 2,190 share 40 % or more of their perimeter. 892 stand alone, 1,418 are in rows of 2-5, 2,204 in rows of 6-20, 199 in blocks of more than 20 joined footprints (largest 55).
- Terrain (natural ground from the 5 m elevation grid, before streets are graded): fall across the footprint < 0.5 m 1,048, 0.5-1.5 m 2,482, 1.5-3 m 1,001, 3-6 m 157, >= 6 m 25. Ground behind the front wall more than 1.5 m above the pavement (dug into a bank) 640; more than 1.5 m below (garden level at the back) 354; more than a storey below 36.
- Pavement along the front wall: the floor level is set at the wall's middle; at a door bay near a wall end the pavement differs from it by > 0.3 m for 357 buildings, > 0.45 m (more than the controller's autostep) for 190, > 1 m for 43.
- Map edge: 33 footprints are cut by the crop edge, 141 lie within 20 m of it. 14 lie near a bridge or freeway deck line (the world drops 20 under decks).
- Stairs (estimate on each footprint's minimum box): 4,215 buildings have upper floors; a straight flight beside a room fits 3,996; only a dogleg core fits 18; 201 fit neither.
- Big: 115 footprints of 1,000 m2 or more, 87 of 6 storeys or more.

What the numbers mean for the design:
- More than half the city is narrow rowhouses (median 5.6 m wide, 3 storeys, party walls on both sides, a stoop at one end of the front): the rowhouse side-hall plan must be excellent and fast; it alone covers about 3,600 buildings with the untyped houses.
- Places decide the ground floor of only 639 buildings, but they are the ones on the busy streets (M St, Wisconsin Ave). Mixed use (a shop under a flat) is common.
- Half the footprints are concave and 816 are under 4.5 m wide: the plan generator works inside arbitrary polygons and must fall back gracefully.
- The ground is rarely flat: the floor is level, the terrain is not flattened, so back rooms sit against a bank or above a garden, and doors on sloping streets need steps.

## 4. Interior system design

### 4.1 Goals and limits

Goals (from the brief and CLAUDE.md): every ordinary building has a real doorway with a door that opens and closes and collides, rooms with floors, walls, ceilings, furniture and interior light, reachable stairs to usable upper floors, all fitted to the footprint, the exterior's storeys, windows and the terrain; collision built before the player can reach the door and never removed from under the player or an active object; small items with stable ids that can be picked up, carried, dropped and persisted; door and item state saved; exits that put you back where you came in; performance within the Medium budget.

Not in v1 (reported per building, never hidden): lifts, basements and attics, roof access, the 7 open structures (they get roofs on posts instead of solids), the 10 walled-in footprints, footprints under 8 m2, interiors on the grid city other than its places (4.14).

### 4.2 Building records and ids

One record per standing building, made at boot by the generator (data only, no meshes), on the typed World via the map:

```ts
interface BuildingRecord {
  id: string;            // 'geo:b23e0ce279d85' (Georgetown: 'geo:' + data id) | 'grid:<seed>:<index>' (grid city)
  index: number;         // CityMap.buildings index (the minimap, buildingAt)
  footprint: Pt[];       // after the street clip; holes too
  type: string; levels: number; heightM: number; estimated: boolean;
  template: TemplateId;  // 4.3
  y0: number;            // ground floor level (finished floor) = the door sill
  storeys: number[];     // floor levels, from facades.ts (y0, y0 + ground, + 3.2 ...)
  walls: WallRec[];      // per footprint edge: ends, normal, party, street, bay count, window tile, outside ground
  doors: DoorRec[];      // [0] = the front door: wall, bay, centre x/z, normal, width, sill y, stoop?
  places: string[];      // place ids inside (Poi lookup by id)
  chunk: number;         // render / physics chunk
}
```

- The id is the data id with a map prefix: stable across sessions, seeds and builds (2.1). Everything persistent hangs off it: `geo:b23e0ce279d85/door/0`, rooms `.../L1/R2`, furniture slots `.../L1/R2/S5`, authored item instances `.../L1/R2/S5#0`. A plan version (`planVersion`, bumped whenever a template's output changes) is saved with any state of that building (4.11).
- `facades.ts` already computes walls, the front, storeys, `y0`, door bay and stoop: it fills the records instead of keeping them local, and `georgetownMap.ts` uses `record.doors[0]` for `Poi.door` and the pavement spot (removing the 1.6 m median mismatch of 1.3) and adds `Poi.building` (the record id). NPC homes and workplaces, taxi drop-offs and clinics then point at real doors.
- Importer: write 16 hex digits instead of 12 (no collisions, no order-dependent `.1` suffixes) together with an alias table old -> new for the 10 suffixed ids, used by a save migration.

### 4.3 Template choice

Order, first match wins:
1. Landmark key from `facades.ts LANDMARKS`: churches -> institution (nave), Healy / university -> institution (lobby and hall), the harbour and the mall -> office / lobby with shop units, the hospital and library -> institution.
2. Places inside, by class: cafe/restaurant > shop > garage/workshop > office (offices, banks, clinics, dentists, gyms) > institution > hotel. This is the ground floor; the upper floors follow step 3 (a shop under a house becomes shop + flat).
3. Data type: house, terrace, semidetached, detached, residential -> house; apartments, dormitory -> apartment; hotel -> apartment (hotel lobby variant); retail, commercial -> shop; garage, boathouse, warehouse -> garage/workshop; church, school, university, library, hospital, post office, civic -> institution; shed -> shed; roof, shelter, pavilion, guardhouse -> open structure (no interior).
4. `building=yes` with no place: area < 25 m2 or width < 3 m -> shed; front more than 15 m from a street and area < 150 m2 -> garage / carriage house; area >= 600 m2 -> office / lobby; otherwise house.
5. Anything a template cannot plan (4.4 validation) falls back: house -> one room per floor with the stair; shop / cafe / office -> open plan; then ground floor only with the upper floors sealed. Every fallback is counted per building id in the coverage report.

Projected coverage from section 3: house about 3,600, shop 211, cafe/restaurant 181, office/lobby about 186, apartment/hotel 43, garage/workshop about 112, institution 63, shed about 310 (one room), no interior 7 open structures + 10 walled-in + footprints under 8 m2.

### 4.4 Floor plans inside the real footprint

Plans are pure functions `planInterior(record, seed) -> Plan` (no three.js, no Rapier): rooms as polygons per level, wall segments with openings, doors, stair runs, furniture slots. Deterministic from the record (the layout never depends on the seed; contents may, per CLAUDE.md). Fast (target < 2 ms per building) so the whole city can be planned in a headless test.

Frame: `u` along the front wall from the door's end, `v` inward. The inner boundary is the footprint inset by the wall: 0.30 m for exterior walls, 0.15 m for party walls (the neighbour keeps the other half, so two active neighbours never overlap). All room splits are lines parallel to `u` or `v`, clipped to the inner polygon (Sutherland-Hodgman per convex piece), so concave footprints and skewed walls work; slivers narrower than 1.2 m are merged into their neighbour.

Templates:
- House (rowhouse, side-hall plan, matching the door at one end of the front): ground floor: a hall 1.1 m wide along the party wall on the door's side from the door to the stair; the stair (straight flight along the same wall, 4.3 m run for a 3.2 m storey plus a 0.9 m landing at each end) starts behind the front room; front room (parlour) beside the hall, depth min(4.5 m, 45 % of the depth); back room (kitchen and dining) behind; a WC under the stair when the depth allows. Upper floors: landing and corridor over the hall, front bedroom, back bedroom, bathroom (2.0 x 2.2 m) over the hall's end; the top floor has no stair up. Wide houses (> 9 m) use a centre hall with rooms on both sides. Detached houses add a back door to the garden.
- Shop: sales floor at the front, full width, depth up to 70 % or 12 m; counter by the door side at about a third of the depth with the till; shelf runs parallel to `v` with 1.2 m aisles (slots for stock); a back room (storage, staff WC) behind a partition with a door; the stair to the upper floor in the back room, or behind a second street door when the front has 3 or more bays (Georgetown's shop-and-flat doors). Upper floors: flat (house upper plan) or office.
- Cafe / restaurant: dining area at the front with tables for 2 and 4 on a 1.8 m grid, a counter or bar along a party wall, a kitchen behind a door at the back, a WC; upper floors as the shop.
- Garage / workshop: one or two vehicle bays (3.2 x 6 m each) behind a roller door 2.8 m wide at street level, a workbench and tool racks (the existing wrench and bat spawns move in here), a small office; a car can drive in. If the stoop or plinth puts the ground floor above the street, the bay floor stays at street level and the office is up a few steps.
- Office / public lobby: a lobby behind the door (full width, 3 to 5 m deep) with a reception desk and seating, the stair core at the back of the lobby against a party or side wall; upper floors: a corridor along `v` with offices on one or both sides. No lift (a lift that does not work would be a decorative fake; stairs only).
- Apartment / hotel: lobby with mailboxes (reception for hotels), stair core, a corridor per floor, flat doors. Each flat is a small house plan (living room, bedroom, kitchen, bathroom). One or two flats per building are open (deterministic), the others are real locked doors ("Locked" prompt); the locked ones are listed as sealed areas in the coverage report.
- Institution: the main hall (nave with pews for churches; a reading room for libraries; a hall with benches otherwise) behind a vestibule; upper floors sealed in v1.
- Shed: one room, no upper floor; under 8 m2 no interior (the door is a locked shed door).

Validation, run on every plan (and on the whole city in a headless test): every room reachable from the front door through doors at least 0.9 m clear (capsule diameter 0.70 m + skin 0.04 m on each side + margin); every stair fits inside its room with 2.1 m headroom under the slab above along its whole run, its foot and head landings on the floors they serve; doors are not blocked by furniture (a 0.9 x 0.9 m clear square on both sides); no room under 1.6 m wide or 3 m2; furniture slots inside their rooms; floor levels match `record.storeys`. A failed check falls back (4.3 step 5) and is reported with the building id.

### 4.5 Levels, windows and terrain

- Floor levels are the exterior's: ground floor finished floor at `y0` (the door sill), ground storey `ground` (3.3 or 4.2 m), upper storeys 3.2 m, `levels` from the data. Slabs 0.25 m thick below each floor line; ceilings 0.25 m below the next floor line (clear heights 3.05 / 3.95 / 2.95 m). The top floor's ceiling is the roof slab at `yTop`; pitched roof spaces are not used in v1.
- Windows: the interior's outer walls are cut by the same bay grid the facade uses (`nb = max(1, round(len / bay))` per wall, window rectangle per tile from a typed table exported by `facadeTex.ts`), so the openings line up with the drawn windows. Openings are filled with a glass pane (thin box collider; you cannot walk or jump out of a window). Party walls have no openings.
- From inside, the facade quads are invisible (single-sided), so the interior's inner wall surfaces are what you see, and the street is seen through the openings. From outside, the facade's fake rooms (interior mapping) would hide the real rooms: the facade material gets a small uniform list of active building indices (a per-vertex building index attribute on the facade layer) and discards glass pixels of those buildings, so the real interior and its glass show through. No shader recompiles: the list length is fixed.
- Terrain fit, no flattening: the floor is level at `y0` over the whole footprint; the plinth below it stays solid. Where the outside ground (0.5 m out) is above a window's sill, that opening is blind (wall) inside: 640 buildings are dug into a bank by more than 1.5 m at the back. Where the ground falls away by a storey or more (36 buildings), the space under the ground floor stays solid in v1 (garden levels are a v2 item). Doors on sloping streets: the ground floor level `y0` is taken from the pavement in front of the door bay instead of the wall's middle (the stoop code already measures its rise there); where the stoop code does not apply and the difference exceeds 0.15 m, one to three entrance steps are drawn outside (a kind `stoop` ramp under them), so the 190 buildings with more than an autostep of difference stay enterable.

### 4.6 The doorway

- Facade: the front wall's ground floor band is drawn as wall left of the opening, wall right of it and a lintel above, plus a reveal (two jambs, a head and a threshold) 0.30 m deep. Clear opening 1.05 x 2.30 m for houses (1.05 x 2.40 with a transom), 1.0 or 1.8 m (double) x 2.4 m for shops, 2.8 x 2.6 m roller doors for garages. This is done at boot for every building with a door (the facade is merged per 240 m chunk and cannot be cut cheaply later): about 10 more triangles per door, about 47,000 for the city (+2 %).
- Door leaf and frame: a casing and a leaf from a small shared set of door models (panelled house door in the four existing colours, glazed shop door, double door, roller door; downloaded CC0 models allowed, recorded in ASSET_SOURCES.md, or modelled in code). Drawn as one `InstancedMesh` per style per chunk, visible within the near-detail distance; beyond it the flat door tile at the back of the reveal (2 triangles, a new far layer) stands in. Opening a door only changes its instance matrix.
- Collider at boot (no interior yet): the footprint solid is split in two at `y0`: a plinth from the lowest ground to `y0` (kept forever: it is the ground floor's floor and the threshold) and a body from `y0` to the top. The body's footprint gets the door reveal notched out (four extra ring vertices at the opening; `convexPieces` cuts it), so the player can step into the reveal and touches the closed leaf exactly where it is drawn: no invisible barrier in front of a door. Building colliders go from 10,588 to roughly 21,000 to 26,000 (to be measured: boot time and step cost).
- Door behaviour (`doors.ts`): a kinematic position-based Rapier body with a box collider (kind `door`) for each door of an active interior; states closed / opening / open / closing / locked; E toggles. Front doors swing inward, interior doors away from the player. Before and during a swing the swept leaf is tested against the player's capsule and dynamic bodies (`intersectionsWithShape` at the next angle); a blocked swing stops where it is and reverses, so a door can never trap or push the player through a wall. Doors never close by themselves. Locked doors say so in the prompt. The leaf's collider matches the drawn leaf at every angle (one box, updated with `setNextKinematicRotation`).

### 4.7 Collision of an active building

Built from the plan, all static except doors: outer wall boxes per wall segment between door openings (full height of each storey band; window openings filled by glass boxes, so outer walls stay one box per segment), inner partitions (boxes split at doors), floor slabs per storey as convex pieces of the inner footprint minus the stairwell hole, stair flights as a ramp under the treads plus side walls (the technique of `bridges.ts buildStairs`, checked by the existing stair walk tests), landings, door frames (jamb boxes), substantial furniture (one box each: beds, sofas, counters, shelves, tables, wardrobes, cookers), and the door bodies. Chairs, stools and small things are items (4.10), not static colliders.

New kinds in the `solidKinds.ts` registry (so F4, the physics audit and the tests see them): `interiorWall`, `floorSlab`, `glass`, `doorFrame`, `furniture`; `stair` is reused for indoor flights; `door` changes from a placeholder to the real thing; the footprint solid becomes `plinth` and `buildingBody`.

Estimate per active building: a 3-storey rowhouse about 80 to 100 colliders and 8 to 10 door bodies; a shop with a flat about 120; budget 250 colliders and 24 door bodies for the largest templates (lobbies are capped in size, deeper floors sealed). All are kind-tagged in `SolidTags` so F4 and the physics audit cover them.

### 4.8 Activation and streaming

Per building: `cold` (plinth + notched body solid, closed leaf drawn) -> `planned` (plan computed) -> `building` (meshes and colliders made in slices) -> `ready` (interior colliders exist; the body solid still encloses them, nothing can be inside) -> `active` (body solid removed, doors interactive, windows see-through) -> `retiring` -> `cold`.

- Trigger: on foot within `TUNING.interiors.buildRadius` (proposed 30 m) of a door; in a car only when stopped within 15 m. Priority by distance and facing. At most 2 / 4 / 6 built interiors (Low / Medium / High) plus any the player or an active object is in; at most one building is being built at a time.
- Budget: build slices of at most 3 ms per frame (Medium; 2 ms Low), measured with `performance.now()` in the slice loop. Running at 8.5 m/s from 30 m gives 3.5 s (about 210 frames, 630 ms of budget) before the door; a rowhouse is expected to need 10 to 30 ms in total. If a building is somehow not active when the player is at its door (teleport, a very slow machine), its door stays closed and the prompt says "Opening..." until it is: never an open hole without collision behind it.
- Swap order (one frame): interior colliders already exist -> remove the building's body solid -> mark active. Retiring is the reverse: restore the body solid first, then remove the interior's colliders, bodies and meshes.
- Never unload from under anyone: a building is not retired while the player's capsule, a driven car or any awake dynamic body is inside its footprint (expanded by 1 m) or on its stoop, while a door is open, or within `retireRadius` (proposed 45 m, hysteresis). Items lying inside are stored as data first (their bodies removed) and re-created at their saved transforms on the next activation, so the restored solid never encloses a body.
- Rendering of an active interior: walls, floors and ceilings merged into one mesh per material (3 to 4 draw calls), furniture as shared `InstancedMesh`es across all active interiors, items instanced per definition; frustum culling per room mesh; built geometry and plans kept in a small LRU (4 to 8 buildings) so walking back into a building is instant.

### 4.8b Code that assumes buildings are solid

These read the 1 m raster or fixed colliders and must learn about active interiors in the same change that removes a solid:
- `CityMap.heightAt` / `walkSurfaceAt` (`georgetownWorld.ts groundAt`, `SurfaceIndex`): inside a footprint they return the raster ground, not a floor. Active interiors register their floor and stair surfaces (a small per-interior surface index consulted first inside its footprint), so heights on upper floors and on floors above a bank are right.
- The fall rescue in `player.ts` (`pos.y < heightAt - 3` -> `safeSpotNear`): with the raster under a house dug into a bank 3 to 6 m (157 footprints fall that much), a player on the ground floor would be "rescued" out of the house. It uses the interior's surfaces as above.
- `isBlocked` (raster `K.BUILDING`): used by pedestrians, item placement (`scatterItems fits`), `safeSpotNear`, police spawn checks. It stays true inside footprints (people do not path indoors in v1; nothing is scattered indoors by that code); the interior system places its own contents.
- Line of sight: police (`police.ts`) and witnesses (`witness.ts`) cast rays with `QueryFilterFlags.ONLY_FIXED`, so kinematic door bodies would be invisible to them; their filter must include colliders of kind `door` (closed doors block sight, open ones do not), and window glass counts as see-through for witnesses (a predicate on the `glass` kind).
- The camera (`camera.ts`) pulls in against fixed colliders to 1.2 m at least; in a 4.5 m wide rowhouse the 5.5 m orbit would sit against the walls. Indoors (the player's capsule inside an active footprint) it uses `TUNING.camera.distanceIndoor` (about 2.5 m), a higher focus, and hides the ceiling and upper floors above the player's level.
- `exitVehicle` (capsule test for a free spot) and `spawnItem` (`heightAt` + offset) work as they are once heights are right.

### 4.9 Materials and light

- Interior surfaces use the shared material library the Look lane builds (plaster, painted wall, wood floor, tile, carpet, concrete, metal, glass; base colour, normal and roughness at physical scale), never per-building textures; variation by vertex colour and the existing per-building hash.
- Light: a fixed pool of interior point lights (0 / 2 / 4 by preset, none casting shadows) moved to the rooms nearest the camera, like `nightLights.ts` does for street lamps; the pool size never changes, so no shader recompiles. Rooms also get a baked ambient term per room (vertex colour from the window count and room depth) so unlit rooms are not black, and the sky light (PMREM) as everywhere. The sun's shadow map treats facades as solid, so daylight does not enter through windows as a beam in v1 (honest limitation; a window-masked shadow material for active buildings is a later step).
- Lit windows at night: active buildings show their real lights through the see-through glass; others keep the facade's lit-window effect.

### 4.10 Furniture, items and dynamic physics

- Furniture library (`src/data/furniture.ts`, typed): id, model, footprint, height, collider (box, or none), slots (shelf rows, table tops, counter tops, beds, wardrobes as containers). Static furniture is part of the interior's static colliders and merged or instanced meshes.
- Item catalogue (`src/data/items.ts`, typed, replacing the closed `ItemId` union and `TUNING.items.defs` entries, existing numbers kept): id, name, category (food, drink, tool, household, book, electronics, clothing, toiletry, stationery, sports, litter...), mass (kg), size (m), stack size, value ($), one-handed (mass <= 3 kg and longest side <= 0.6 m, bats and wrenches by exception), use effect (eat, drink, read, melee, throw...), model and collider. Tunable numbers stay in `src/tuning.ts` or the typed data file, per CLAUDE.md.
- Instances: `{ uid, def, owner: 'player' | 'npc:<id>' | 'business:<buildingId>' | 'public', where: world (transform) | slot (slot id) | inventory (index) | container (uid), condition, stolen }`. Authored contents get `uid = <slotId>#<n>`; street items `street:<generator>:<n>`; anything the game creates later (a bought item, a dropped receipt) `new:<counter>` from a counter in the save.
- Contents per slot come from the template and the seed (a grocer's shelf: cans, bottles, cereal boxes, milk; a house kitchen: mugs, plates, a kettle; a study: books). Shop stock is owned by the business: leaving with unpaid stock sets `stolen` and raises the theft event the witness and police systems already handle.
- Physics only near the player: an item resting in a slot has no rigid body; it is drawn as an instance and found by the same targeting as today (distance and facing). Within 4 m of the player, or when something hits near it (the existing thrown-item contact events), it gets a dynamic body that sleeps. Picking up, dropping and throwing reuse `pickUp`, `dropSelected` and the combat path. A dropped item whose body has slept for a few seconds and is more than 8 m from the player goes back to body-less resting at its transform. One code path for every item.
- Seeded street items (the 427 of today) get uids and the same body-less resting state, instead of 427 permanent dynamic bodies.

### 4.11 Save system

- `src/systems/save.ts`: IndexedDB database `open-city`, object store `saves` keyed by slot (`auto`, later manual slots), one record per slot: `{ schema, savedAt, build, map, seed, gameTime, player: { x, y, z, facing, health, cash, inBuilding }, inventory: uid[], items: { [uid]: instance } (only instances that differ from what generation would make: picked up, moved, used up, created), doors: { [doorId]: { open, locked } } (only non-default), buildings: { [buildingId]: { planVersion } }, police, jobs, npcs (later) }`. Settings stay in `localStorage` (`openCity.quality`) and are untouched.
- Versioning: `schema` integer; `migrations[n]` turns schema n into n + 1 (the first one maps the 10 suffixed building ids to their 16-digit ids, 4.2); a save from a newer build than the game is never overwritten (kept, the game starts fresh and says so). If a building's `planVersion` changed, its door states are dropped and its items are restored only if their slots still exist; the player's own items left there move to the doorstep.
- When: an autosave at most every 60 s when something changed, plus on entering or leaving a building, on pickup / drop / door toggles (debounced 2 s), on pause and on `visibilitychange` to hidden. Never synchronous in the frame loop; serialisation is a few kB.
- Loading at boot: after the map and the building records, before items are scattered: generation consults the save, so an item has exactly one place (its uid's record wins over its generated slot). If the player was inside a building, that interior is planned and built synchronously before the first physics step (the floor exists before the player does).
- There is no save system today, so no old saves exist to break; the first schema starts at 1.

### 4.12 Exits and the street

There is no teleport: you leave through the door you came in by, so you are on the right pavement by construction. People (pedestrians) stay on the walk graph in v1; the door records are what a later step uses to send NPCs home and to work through real doors. `Poi.door` and the pavement spot come from the building record (4.2), so taxi drop-offs, homes, workplaces and clinics use the real door; the minimap and the coming big map can show door markers in the right place. A back door, where a template has one, opens to the footprint's other side (garden or alley).

### 4.13 HUD and prompts

- The controls list moves out of the play HUD (`hud.ts #help`) into the pause / help panel (which already has a controls block; it gains doors, G drop, I inventory, M map as they land). During play only a one-line hint "Esc: pause, controls and settings" shows for the first 20 seconds.
- Prompts stay one short line from one targeting function: the nearest interactable you face within its range among doors ("E open door", "E close door", "Locked"), items ("E pick up Glass bottle"), people ("E talk to Ana"), cars and places, scored like item targeting today (distance minus facing). No prompt text in the 3D world.

### 4.14 The grid city

Its buildings are boxes (`cityGen.ts addBuilding`), axis-aligned, on flat ground, with places that already have a door point. The same records are made there (`grid:<seed>:<index>`, storeys from the window rows, front wall = the side the place's door is on, else the side facing the nearest street), the box face is cut for the door and the box collider split like 4.6. v1 makes the grid's places enterable (shops, diners, bars, the gym, the garage, the police station lobby); other grid buildings keep their solid and are reported as not enterable. `?map=grid` must keep working either way.

### 4.15 Files

One system per file under `src/systems/`, shared state on the World:
- `src/systems/buildings/records.ts`: BuildingRecord type, ids, template choice (facades.ts and the grid generator fill the records).
- `src/systems/buildings/plan.ts` (+ `templates/*.ts`): pure floor plans and validation.
- `src/systems/buildings/interiorBuild.ts`: plan -> meshes and colliders, in slices.
- `src/systems/buildings/interiors.ts`: activation, budgets, swap, retire, the active list on the World.
- `src/systems/buildings/doors.ts`: door bodies, swing, blocking, prompts.
- `src/systems/interaction.ts`: one targeting function for E (doors, items, people, cars, places), used by `player.ts`.
- `src/systems/save.ts`: IndexedDB saves and migrations.
- `src/data/items.ts`, `src/data/furniture.ts`: catalogues. `TUNING.interiors`: radii, budgets, counts, door sizes, clearances, with comments.
- `facades.ts`: records, door openings and reveals, the plinth / body split, the far door layer. `georgetownMap.ts`: `Poi.door` and `Poi.building` from the records. `worldItems.ts` / `inventory.ts`: uids, catalogue, resting items. `hud.ts` / `pauseMenu.ts`: controls list and prompts.

### 4.16 Order of work

- C1. Records, ids and the door opening for the whole city (reveal, plinth / body split, far door layer, `Poi.door` from the record); doors still closed and not interactive. Measure boot time, collider count and step cost against the base.
- C2. One house and one shop end to end, chosen here because they are near the spawn and already walked by this audit: house `geo:b23e0ce279d85` (3 storeys, 7-step stoop at -677.6, 121.3) and shop `geo:be01bab3a0eeb` ("Easel House", retail, 2 storeys, M St NW at -652.5, 147.8). Plan, build, doors, stairs, lights, furniture, items, save; all tests in 4.17.
- D1. All templates and the fallback chain; the headless planning test over every building with a coverage table by template and a list of building ids with sealed areas or no interior.
- D2. The grid city's places. D3. Performance pass.

### 4.17 Test plan

Keyboard only for movement (held W/A/S/D/Shift/Space and E presses through the input state, as the `stairs` scenario does), positions asserted from the Rapier body every step, collisions from the character controller tagged by kind. Teleporting is used only to stand on the pavement at the start.

1. `doorwalk` (house and shop): from the pavement walk to the door (stopped by the closed leaf: collision kind `door`, not `building`); E opens it; walk through (the body crosses the facade line, feet within 5 cm of the floor, no `building` collision); E closes it from inside; walk into it (stopped); E opens; out; close from outside; walk into it (stopped). Both sides, every door on the path.
2. Rooms: visit every room's centre by steering with A/D and W along the plan's door path; walk into each outer wall, a partition and a window (stopped, no penetration deeper than the controller skin).
3. Stairs: up and down every flight of both buildings (feet rise by the storey height within 10 cm; never below the ramp by more than 5 cm; jump on a landing and under the slab: head bump, no clipping through).
4. Doors never trap: stand in a door's swing and press E (the door stops); close a door on a dropped box (it stops); walk out while it swings.
5. Items: pick up a bottle from the shop shelf (E), walk out, drop it (G / Q) on the pavement, walk back in (the shelf slot is empty), reload the page (the bottle is on the pavement at its spot within 0.1 m, the slot is still empty, exactly one instance with that uid exists); pick it up again, reload (it is in the hotbar). Theft flag when leaving with unpaid stock.
6. Streaming: walk away past `retireRadius` (the interior retires, the solid is back, the door is closed), come back (rebuilt before the door); stand inside while the camera flies away (never retired); a thrown item lying inside survives a retire and comes back where it was.
7. Coverage (headless, no rendering): plan every building; counts by template and fallback; every validation failure by building id; plan time per building.
8. Regressions on both maps: `world walk drive handling taxi chat police theft dealership items combat stairs fallthrough physaudit physf4 mapcheck geodrive geolife`, the production build, console clean, and `auditBuildings` again (it must now report open doorways and no `building` collider behind active doors).
9. Performance (4.18).

### 4.18 Performance budget and measurement

Budget (Medium, 1080p, mid-range laptop): an active interior adds at most 8 draw calls of its own plus the shared furniture and item instances, at most 60,000 triangles, 250 colliders and 24 door bodies; at most 3 ms of building work per frame; F3 spikes stay at 0 while walking into a street of rowhouses. Low: 2 built interiors, no interior lights, smaller furniture set.

Measure, against the base build (`s1-integrate` dist) and interleaved, at least 3 runs each, also with a 4x CPU throttle (CDP `Emulation.setCPUThrottlingRate`): CPU ms per frame from the profiler (outside on M St, on a stoop, inside the house, inside the shop, walking through a door during activation), draw calls and triangles (`renderer.info`), texture and geometry memory, garbage per frame (`performance.memory` with `--enable-precise-memory-info`), frames over 33 ms, boot time, collider count and the `physics` section. Report resolution, preset, browser (headless Chromium + SwiftShader) and hardware; never a 60 fps claim from software GL.

## 5. Risks

1. Plans in irregular footprints (biggest risk): half the footprints are concave, 816 are narrower than 4.5 m, 1,042 are deep and narrow, 13 have courtyards. Mitigation: the strip planner with validation and a fallback chain, the whole city planned in a headless test, and per-id reporting instead of claims.
2. Facade and interior disagreeing: windows, storey lines, the door (today's gameplay door is a median 1.6 m from the painted one), the West End's level entrances, facades drawn from `levels` while 61 % of heights are estimates. Mitigation: one record made by `facades.ts` feeds both the exterior and the interior.
3. Terrain: 1,183 footprints fall more than 1.5 m, 190 front doors would be more than an autostep off the pavement with today's floor rule. Mitigation: door sills from the pavement at the door, entrance steps, blind windows below the outside ground, level floors with solid plinths.
4. Collision and the character controller: doors as kinematic bodies pushing or trapping the capsule, seams between slabs and stair ramps, the reveal notch adding thousands of collider pieces at boot. Mitigation: swept-arc checks before every door move, stair ramps reused from the tested stair code, the physics audit extended to interiors, boot and step cost measured in C1.
5. Streaming stalls and unload safety: Mitigation: time-sliced builds, one build at a time, generous radii, the occupancy rules of 4.8, items stored as data before a retire.
6. GPU cost: interiors add draw calls and fill on top of a look that is already 2.3x (Low) to 5.1x (Medium) main's fill cost in software GL. Mitigation: merged meshes, instancing, a small light pool without shadows, interiors only near the player, real-GPU measurement still needed.
7. Exterior windows: discarding the fake rooms of active buildings needs a per-vertex building index on the facade layer (memory) and must not recompile shaders.
8. Persistence: ids that change (re-imports, the 10 suffixed ids, template changes) and seed-dependent contents. Mitigation: map prefix + data id, `planVersion`, migrations, saves per map and seed.
9. Merge conflicts: the look lane is rewriting facades, materials and models at the same time (`facades.ts`, `facadeMaterial.ts`, `facadeTex.ts`). Mitigation: the record and opening changes land early and small, in agreed functions.
10. Scope: 4,693 buildings cannot all be hand-checked. Coverage is reported by template, fallback and building id; "every building enterable" is only claimed for what the headless coverage test and the keyboard walks prove.
