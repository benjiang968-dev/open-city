# Georgetown map: suspicious areas to look at (Milestone 3)

**Update 2026-11-05 (Stage 1):** `src/data/georgetown.json` is now **real data**: OpenStreetMap via Overture Maps
(release 2026-10-21.0) and USGS 3DEP terrain, imported by `scripts/importOverture.mjs`. Part 0 below lists how it
differs from the old knowledge-based map and the data problems found in the import. Parts 1-4 are the review of the
old knowledge-based map (2026-11-04); they describe that map, which `npm run gen-georgetown` still produces.

The knowledge-based map was generated from a hand-written spec (`data/georgetown-spec.json`) based on general
knowledge of the place (Overpass could not be reached). It is 20–80 m off in most places, and more in the spots listed
in part 4.

This file lists every place where the 3D world built from that data (world generator v2, `src/systems/map/`)
looked wrong during the review of 2026-11-04. For each place it says what was wrong, how bad it is and whether it
was fixed.

**Coordinates.** `x, z` are map metres, with x pointing east and z pointing **south**. The origin is the centre of
the crop. Latitude and longitude come from the map's own frame:
`lat = 38.9065 − z / 111013.7`, `lon = −77.061 + x / 86740.3` (`meta.origin` and `meta.metresPerDegree` in the
JSON).

**How to look.** Run `npm run build`, then open `preview.html` with a local server (`npx vite preview`, then
`/preview.html`). The top-left readout shows the camera position as `x y z`. Controls: WASD to fly, Q/E to go
down/up, drag to look, Shift to go faster.

To take the review screenshots again, run `node scripts/previewShots.mjs --review`. They are saved as
`screenshots/26-geo-r-*.jpg`.

`node scripts/geoAudit.mjs` re-runs every check that produced the numbers below. It casts rays at the colliders
and compares the result with `heightAt` and `roadSurfaceAt`. It also checks the lanes, the props and how building
footprints sit against the streets.


## 0. Stage 1: the real map (2026-11-05)

Same frame as before: origin 38.9065, -77.061, `lat = 38.9065 − z / 111013.7`, `lon = −77.061 + x / 86740.3`. The
crop is -77.0726, 38.8986 to -77.0483, 38.9157 (2108 m x 1898 m; x -1006..1102, z -1021..877). The numbers below
come from comparing the two JSON files (old: `src/data/georgetown.json` at commit 4133d32).

### What moved (old knowledge-based line → real line of the same name)

Median and largest distance from the old line's vertices to the real street:

| Street | median | max | Street | median | max |
|---|---|---|---|---|---|
| Francis Scott Key Bridge | 78 m | 238 m | M St NW | 18 m | 121 m |
| R St NW | 78 m | 96 m | 33rd St NW | 17 m | 38 m |
| Dumbarton St NW | 50 m | 54 m | Rock Creek and Potomac Parkway | 16 m | 179 m |
| 37th St NW | 48 m | 594 m | 31st St NW | 16 m | 99 m |
| I St NW | 45 m | 55 m | Prospect St NW | 15 m | 38 m |
| 24th St NW | 42 m | 43 m | 29th St NW | 14 m | 19 m |
| Water St NW | 40 m | 108 m | Wisconsin Ave NW | 12 m | 50 m |
| Potomac St NW | 37 m | 43 m | P St NW | 12 m | 148 m |
| O St NW | 35 m | 72 m | Whitehurst Freeway | 9 m | 47 m |
| Canal Rd NW | 33 m | 35 m | Pennsylvania Ave NW | 6 m | 40 m |
| 23rd St NW | 32 m | 101 m | Thomas Jefferson St NW | 5 m | 6 m |
| New Hampshire Ave NW | 28 m | 44 m | 30th St NW | 4 m | 43 m |
| N St NW | 23 m | 29 m | K St NW | 1 m | 36 m |
| Q St NW | 19 m | 44 m | Washington Circle | 19 m | 35 m |

- **Washington Circle:** centre moved 38 m east (old 908, 444; real 946, 439), radius 55 → 59 m. It is still one
  closed one-way ring, now counter-clockwise from the data's geometry (Overture keeps no `junction` tag, and only some
  ring pieces carry a one-way restriction, so the importer finds the ring as a loop of same-name pieces).
- **C&O Canal:** old centre line 16 m (median) from the real one, at most 45 m. Its four locks are now the data's lock
  chambers (39-49 m long); the pound levels come from the terrain: 11.0, 8.6, 4.0, 1.4, 0 m west to east (the old
  tuned values were 5.2 to 2.0 m).
- **Rock Creek:** the old line was 70 m off (median), up to 237 m. Its water level per vertex now comes from the
  terrain (4.1 m at the north edge to 0 at the mouth).
- **Potomac shore:** the real north shore lies 37-79 m further north west of Key Bridge (z 245-374 instead of
  312-441) and 32-62 m further south east of 31st St.
- **Terrain:** real minus old heights on a 50 m grid: median +2.3 m, 10th percentile -6.0 m, 90th +10.2 m, largest
  28.5 m. M St at Wisconsin Ave is at 21.1 m (old 11.6), the Key Bridge landing 21.0 m (old 9.4), Washington Circle
  21.5 m (old 16.5), R St at Wisconsin 61.1 m (old 58.6).
- **Counts (old → new):** roads 71 → 1071 pieces, footways 969 → 2024, buildings 3986 (all synthesized) → 4714 (all
  real footprints), POIs 711 → 1838, parks 12 → 179, car parks 5 → 107, props 6473 → 8560 (2400 real: trees, lamps,
  benches, signals, stop signs, bus stops; the rest flagged synthesized).

### Data problems found (with places)

| Problem | Where (x, z / lat, lon) | What the import or the world does |
|---|---|---|
| Overture has no lane counts; 26 segments have a width | everywhere | Width measured from the mapped sidewalk lines either side for 393 pieces (`est: 2`), else a class estimate (`est: 1`); one width per street |
| Washington Circle ring pieces mostly lack a one-way restriction | 946, 439 / 38.90255, -77.05009 | Ring found as a loop of same-name pieces, made one closed one-way counter-clockwise road |
| K St underpass under Washington Circle and the Potomac Freeway tunnel under Virginia Ave | 1015, 459 / 38.90237, -77.0493; 605, 794 / 38.89935, -77.05403 | Tunnels (layer < 0) are in the data with their levels but not rendered; their approach ramps are pruned back to the street they leave (36 pieces) |
| Bare-earth terrain keeps parts of bridges near their abutments | Key Bridge north end -707, 288 / 38.90391, -77.06915 | Junctions inside a bridge take heights interpolated along the bridge; ground under every deck is cut below the deck |
| Key Bridge north end height is inferred | -707, 288 | The deck must clear the Whitehurst Freeway ramps below; the generator puts it at 38 m and the approach to M St (21.6 m) runs at about 15 % |
| 22nd St NW lay exactly on the first crop edge | 1058, 300 / 38.9038, -77.0488 | Crop widened to -77.0483 so the street and its sidewalks are inside |
| Kalorama (beyond Rock Creek) and the Virginia shore were cut mid-block by the rectangle | north-east of 960, -540 / 38.91136, -77.04993; south of the Potomac centre line | Masked: dropped and turned into woodland (natural edges: the Rock Creek valley, the river) |
| Juarez Circle pieces do not close into a loop inside the crop | 660, 800 / 38.89929, -77.05339 | Left as plain roads |
| Driveways into garages, alleys under buildings | 51 pieces | Service roads cut where they enter a footprint (39 cut, 18 dropped); 85 alleys narrowed to the gap between buildings (at least 2.6 m) |
| Overlapping building footprints from two sources | 13 | The smaller one dropped when 60 % or more lies inside a larger one |
| Places: 8606 in the download, most offices on upper floors | | 1838 kept: confidence 0.55+, offices 0.8+ and at most 2 per building, categories only |
| Rock Creek is `waterway=river` in OSM | | Written as the map's `stream` (the world's creek model) |
| North-west and south-east crop edges | north of S St west of Wisconsin; H St to Virginia Ave | Still a straight cut through the street grid (no natural edge there) |
| The Rock Creek / K St / Whitehurst Freeway / Potomac Freeway interchanges | 330-620, 320-800 / 38.8988-38.9036, -77.0572 to -77.0539 | Many ramps at different levels with few bridge flags; the worst road-smoothness numbers are here (see DEVLOG) |

Severity (parts 1-3, the knowledge-based map):

- **high:** breaks driving or walking (you fall through, hit an invisible wall, or a car is launched).
- **medium:** clearly visible, or wrong by more than 5 cm where things get placed.
- **low:** cosmetic or rare.

---

## 1. Buildings overlapping roads, sidewalks and junctions

Before the review, 43 building footprints reached into a carriageway, its sidewalk or a junction surface. After
the review there are 0. The world generator now cuts each such footprint back to the back of the sidewalk, plus
0.3 m, parallel to the street. Where a corner sits on a junction, it is cut along the junction edge instead.

In total 207 footprints were trimmed, nearly all of them by less than half a metre. One footprint was left too
small and was dropped. The data itself is unchanged: the clipping happens when the world is built. If the map is
re-generated from a better source, the cut should no longer be needed.

| Building | x, z | lat, lon | What was wrong | Severity | Status |
|---|---|---|---|---|---|
| s1613 (commercial, NE of Washington Circle) | 878, 509 | 38.90192, −77.05088 | 1.64 m into the sidewalk along 17 m² | high | fixed (cut back) |
| s5040 (commercial, K St / 31st St) | −10, 342 | 38.90342, −77.06112 | 29 m² on a junction surface | high | fixed (cut back) |
| s4938 (terrace, 27th St near P St) | 463, −160 | 38.90794, −77.05567 | 14 m² on a junction; too little was left after the cut | high | fixed (dropped) |
| s4628 (university, Foggy Bottom) | 639, 586 | 38.90122, −77.05363 | 14 m² on a junction | high | fixed (cut back) |
| s1800 (university, Foggy Bottom) | 673, 618 | 38.90094, −77.05324 | 11 m² on a junction | high | fixed (cut back) |
| s1218 (retail, M St at Key Bridge) | −908, 139 | 38.90525, −77.07147 | 9 m² on the M St / Key Bridge junction | high | fixed (cut back) |
| s1232, s1233 (retail, M St at 34th St) | −719, 158 / −706, 159 | 38.90507, −77.06929 | 8.5 m² and 1.3 m² on a junction | medium | fixed (cut back) |
| s1990 (terrace, 37th St / Prospect St) | −925, 88 | 38.90571, −77.07166 | 5 m² on a junction | medium | fixed (cut back) |
| s2777 (terrace, 27th St) | 442, −141 | 38.90777, −77.05590 | 4 m² on a junction | medium | fixed (cut back) |
| 33 rowhouses along the north side of N St (x −146 … 72, z ≈ −92) and the 28th St block (x 270 … 340, z −65 … −96) | e.g. −139, −92 and 285, −93 | 38.90732, −77.06260 and 38.90733, −77.05772 | 0.05–0.2 m into the sidewalk | low | fixed (cut back) |

**Building colliders (fixed, medium).** Each building got an oriented box around its footprint, centred on the
mean of its corners. On 185 skewed footprints the box was 2–9 m² bigger than the building. That made a sliver of
invisible wall up to a few tens of centimetres wide along a wall or at a corner. Examples:

- s1295 at x 234, z 159 (38.90507, −77.05830), 8.9 m² extra
- s1412 at x −146, z 58 (38.90598, −77.06268), 7.4 m² extra

Those footprints now get an exact prism collider. Near-rectangles, where the box adds at most 1.5 % + 2 m² (a
sliver of a few cm), keep the cheaper box.

---

## 2. Sidewalks missing where the data has them

The data's sidewalk lines run 1.5 m from the kerb. The audit samples them every 4 m: 15,524 points in total. 281
points (1.8 %) have no sidewalk, car park or deck within 1 m:

- **224 are on a carriageway.** These are the corner joins in the data, which cut across junction corners. That is
  expected, because the generator draws its own corner sidewalks.
- **57 are on bare ground**, which means a sidewalk really is missing. Nearly all of them are around Washington
  Circle (not fixed, low):
  - Outer edge of the ring and the first metres of the spokes between Pennsylvania Ave, K St and New Hampshire
    Ave: 863, 452; 866, 425; 889, 401; 897, 399 (38.9025–38.9029, −77.0511 … −77.0507).
  - East side: 951, 471; 960, 479; 972, 449; 936, 485 (38.9019–38.9025, −77.0498 … −77.0502).

  The generator decides whether each side of an edge has a sidewalk by matching it against the data's sidewalk
  lines. On the ring that match fails: the ring is snapped to a true circle while the data's sidewalks follow the
  original polygon.
- **The K St bridge ends** (401, 435 and 401, 453; 38.9026, −77.0564) lose their north sidewalk where the
  Whitehurst Freeway runs alongside. This is deliberate (`noSw`); the pavement continues on the south side.

---

## 3. Geometry that looked wrong

### Fixed

| Where | x, z | lat, lon | What was wrong | Severity |
|---|---|---|---|---|
| C&O Canal, the whole length (worst near every bend) | e.g. −393, 227; 234, 241; −981, 164 | 38.90445, −77.06553 | The ground heights under the canal mixed up water and towpath near each bend, so the towpath was sometimes reported over open water, up to 2.7 m off. A cap past the east end left a hole down to the safety floor. | high |
| Gaps under 5 m between sidewalks and buildings, and alleys, all over the map | e.g. 238, −47; 876, 35; −737, 101 | 38.90693, −77.05826 | No ground at all, so you would fall to the safety floor: about 8,500 m² in total | high |
| Slot between the back of the sidewalk and facades set less than 1 m back (23rd St, the whole length) | x ≈ 920, z −300 … 800 | 38.9074, −77.0504 | A 0.5 m strip with no ground | high |
| Rock Creek and Potomac Parkway in the creek cutting | 386, 414; 491, 99 | 38.90267, −77.05655; 38.90561, −77.05534 | The steep bank stuck 0.3–0.8 m up through the carriageway, giving a ridge and 0.15–0.17 m steps | high |
| M St bridge over Rock Creek, east end | 500 … 546, 119 … 121 | 38.90543, −77.05524 | The road came off the bridge at a 20 % slope with a crest that launches cars. It is now limited to the 7.5 % ramp grade by raising the next junction. | high |
| Every junction edge, worst on steep streets (Wisconsin Ave at M St, K St west of Washington Circle) | −150, 171; 846, 442 | 38.90496, −77.06273 | The carriageway met the flat junction surface up to 0.2 m off. You could see the sky through the crack. | medium |
| Lane heights through junctions, everywhere (exported `GeoLane.pts`) | e.g. −820, 78 (36th St) | 38.90580, −77.07045 | Up to 1.1 m off the junction surface. Traffic placed on lanes would float or sink. | high |
| Sidewalks on every bridge (Key Bridge, the Rock Creek bridges, the canal road bridges) | e.g. −825, 422 | 38.90270, −77.07051 | `walkSurfaceAt` was 15 cm below the raised sidewalk. Beside decks with a sidewalk on one side only, it reported a deck in mid-air. | high |
| Canal footbridges | −330, 233; −564, 225 | 38.90440, −77.06480 | The side-rail collider was one box down the middle of the walkway, which blocked it | high |
| Grass next to every road | (map-wide) | | `heightAt` was up to 0.3 m above the visible ground within about 5 m of road edges, so 63 trees floated up to 0.9 m | medium |
| Rowhouse stoops on sloping streets | e.g. N St, 29th St, Prospect St | | 400 bottom steps floated up to 0.75 m and 58 were buried up to 1.5 m | medium |
| Kerbs (every sidewalk) and the canal walls | (map-wide) | | `heightAt` smeared the 15 cm kerb over 1 m, so it was 5–11 cm off within 0.5 m of every kerb: 4,596 of 13,776 samples 0.25 m on the road side and 6,406 of 13,778 on the sidewalk side were off by more than 5 cm. Now 12 and 48. The canal's 2.7 m wall was smeared the same way; the mean error on the banks fell from 15 cm to 5 cm. | medium |
| Grass colour | (map-wide) | | A regular checkerboard was visible from the air | low |

### Still open (not fixed)

| Where | x, z | lat, lon | What is wrong | Severity |
|---|---|---|---|---|
| Steep side streets between M St and Prospect St: 35th St, 36th St, 37th St, 34th St, 33rd St | 35th St at −713, 108; 37th St at −931, 56; 36th St at −822, 50 | 38.90553, −77.06922 | Grades up to 30 % over 4 m, with the grade changing by up to 19 % within 8 m. The spot heights in the data make this hill very steep, and flat junctions push the climb into the middle of each block. Cars may scrape or jump at the crests. | medium |
| P St and Q St dropping into the Rock Creek valley; 27th St | 458, −312; 422, −468; 451, −171 | 38.90931, −77.05572 | 16–18 % grades | medium |
| K St approaching Washington Circle from the west (by the K St underpass, which is not built) | 803 … 846, 442 | 38.90252, −77.05125 | 15–17 % grade with a 17 % change of grade and a 0.36 m step in the lanes at 846, 442 | medium |
| M St at Key Bridge, climbing west | −798, 124 | 38.90539, −77.07030 | 18 % grade | medium |
| N St dead end at the Rock Creek valley | 434, −22 | 38.90670, −77.05600 | The road ends with a 0.24 m drop onto the grass | low |
| 31st St crossing the canal; the canal steps sit against its kerb | −29, 244 | 38.90430, −77.06133 | ±0.35 m bump at the edge of the lane | medium |
| 23rd St at the south side of Washington Circle | 906, 377 | 38.90310, −77.05056 | ±0.26 m step in the lane | medium |
| Pennsylvania Ave bridge over Rock Creek, east end | 485, 223 | 38.90449, −77.05541 | A 0.15 m step in a lane where the deck meets the street. The same step at the P St and Q St bridge ends (693, −335 and 746, −478) was fixed in the review. | medium |
| K St west of Washington Circle | 819, 436 and 819, 452 | 38.90258, −77.05166 | 0.15 m steps at the lane edges | medium |
| New Hampshire Ave at the east map edge | 1124, 152 | 38.90513, −77.04805 | A 0.23 m drop at the very end of the lane, at the boundary wall | low |
| Waterfront promenade and park at night | −150 … 165, 500 … 600 | 38.9011–38.9020, −77.0627 … −77.0591 | No lamps: the data puts lamps only along the street sidewalks, so the promenade is dark at night | low |
| K St bridge, north sidewalk, where the Whitehurst Freeway runs alongside it | 382, 436 | 38.90257, −77.05659 | `walkSurfaceAt` is up to 6 m off in a few spots beside the freeway | low |
| Canal Rd / M St junction (Key Bridge approach from the west) | −911, 116 | 38.90546, −77.07150 | The junction corner on the side with no sidewalk stands about 0.5 m above the grass, with a dark skirt. It is cosmetic: the carriageway itself is smooth. | low |
| Washington Harbour plaza, river edge | 151, 594 | 38.90115, −77.05926 | `heightAt` smears the 3 m quay wall over 1 m along the edge | low |
| Exorcist Steps, top and sides | −808, 117 | 38.90545, −77.07032 | ±1 m between the stair collider and `heightAt` at the stair edges | low |
| Data street lamps 0.4 m from the kerb (187 lamps) | e.g. P St x −932 … −759, z −307; Q St z −470 | 38.90927, −77.07175 | They stand on the sidewalk, but closer to the kerb than the 1 m raster can resolve, so `isRoad` is true at their bases. They are not in the carriageway. | low |
| Map west edge, Canal Rd | −1128, 33 | 38.90620, −77.07400 | The road just ends at the invisible boundary wall | low |

---

## 4. Geography uncertainties of the knowledge-based map

These are not generator bugs. The data itself is probably wrong here, and an OSM import would settle each of
them.

| What | x, z | lat, lon | Note |
|---|---|---|---|
| Virginia shore (Rosslyn) and the north tip of Roosevelt Island are missing from the SW corner | x −1128 … −300, z 700 … 833 (Key Bridge lands at about −824, 777; the island tip at about −390, 777) | 38.8990–38.9002, −77.0740 … −77.0645 | The map shows open river right to the south edge. Key Bridge runs off the map over water. |
| C&O Canal west of Key Bridge is probably about 100 m too far south | canal from −770, 209 to −1128, 133; Canal Rd from −911, 116 to −1128, 33 | 38.90462, −77.06988 to 38.90530, −77.07399 | It should run close beside Canal Rd. The spec's three sources disagree by up to 133 m (worst at 38.90530, −77.07400). |
| An empty strip about 290 m wide east of Oak Hill Cemetery | x 380 … 670, z −833 … −560 | 38.9081–38.9140, −77.0566 … −77.0533 | In reality this is the wooded Rock Creek valley (Rock Creek Park and Dumbarton Oaks Park side). The map has bare grass. |
| Empty land east of Rock Creek between M St and P St | x 470 … 600, z −310 … 115 | 38.9055–38.9093, −77.0556 … −77.0541 | The West End blocks east of the creek are missing here |
| Where R St becomes Reservoir Rd | −729, −699 | 38.9128, −77.0694 | The sources put it at 35th St (kept) or at Wisconsin Ave, about 420 m apart |
| Where K St becomes Water St | −130, 400 | 38.9029, −77.0625 | The sources put it at Wisconsin Ave (kept) or between 31st and 33rd St |
| Rock Creek centreline | worst at 737, −833 | 38.91400, −77.05250 | The sources disagree by up to 104 m |
| Rock Creek and Potomac Parkway | worst at 789, −833 | 38.91400, −77.05190 | Up to 139 m. In reality it has ramps near Thompson Boat Center; the map has one synthetic ramp to K St. |
| Potomac north shore | worst at −1128, 255 | 38.90420, −77.07400 | Up to 100 m |
| Water St west end | −911, 400 | 38.9029, −77.0715 | The three sources' ends are 278 m apart; the median was used |
| 33rd St extent | north end at −477, −477 | 38.9108, −77.0665 | The north end varies by 397 m and the south end by 235 m between sources |
| Potomac St north end | −330, −144 | 38.9078, −77.0648 | The sources differ by 320 m |
| Dumbarton St | −87, −78 | 38.9072, −77.0620 | One source puts it between P and Q St, about 300 m north. The map uses N–O St, with confidence 0.35. |
| One-way directions of the N–S side streets (34th, 33rd, 30th, 29th, 35th, 31st St), L St and M St (West End) | | | The sources conflict. The map uses the majority, or two-way where they split. |
| Washington Circle | centre 911, 444 | 38.90250, −77.05050 | Radius 55 m (sources say 50–60 m). The K St underpass is in the data but not built: it is left out of the render and the graph. |
| K St bridge over Rock Creek | from 347, 444 | 38.9025, −77.0570 | Only one source draws it |
| Whitehurst Freeway | worst at −320, 400 | 38.90289, −77.06265 | The centreline is off by up to 49 m. Its last stretch is moved 15.6 m north in the generator so it runs beside the K St bridge, not on top of it. |
| Wisconsin Ave north of P St | to the north edge at −347, −833 | 38.9140, −77.0650 | The checker moved it to lean NNW (the sources disagreed by up to 121 m) |
| Sheridan Circle and Massachusetts Ave | 971, −566 | 38.9116, −77.0498 | They may clip the NE corner of the box; not modelled |
| Streets none of the sources drew | | | 32nd St, Dent Pl, Olive St, Cecil Pl, Cady's Alley, Lovers Lane and Massachusetts Ave are not on the map |
| Overall | | | The inputs are from memory, not surveys. Expect 20–80 m absolute error everywhere. |
