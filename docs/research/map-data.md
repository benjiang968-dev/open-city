# Map data for Open City: OpenStreetMap vs Overture Maps, licences, terrain

Stage 1, item 5 (research). Written 2026-11-05. It answers four questions for Stage 1 item 2 (real 1:1 map data):

- Which source should we use?
- What do the licences require of a free browser game?
- Which Overture fields give us what the generator needs?
- What exactly must the game and the repo say?

**Short answer.**

- **Use Overture Maps release `2026-10-21.0`** for the map:
  - roads, paths and steps from `transportation/segment`
  - crossings, signals, stop signs, lamps and benches from `base/infrastructure`
  - buildings, water and land use
  - places as categories only

  Use **AWS Terrain Tiles z15** (USGS 3DEP 1/9″ lidar DEM for DC) for the ground.
- **Treat `src/data/georgetown.json` as an ODbL Derivative Database.** Publish it, or the importer plus the
  release id, under ODbL with a licence notice. Show "© OpenStreetMap contributors" with a link wherever the
  map is shown and in the credits.
- **Keep places in a separate file under CDLA-Permissive-2.0.** Drop the Apache-2.0 (Foursquare) records or
  ship their NOTICE. Store only category and position, never names.
- Ready-to-paste strings are in section 8.

Not legal advice. Where a point rests on OSMF guidance that I could not open (see "How this was researched"), it is
marked.

## How this was researched

- **Read in full on 2026-11-05:**
  - the Overture attribution page source and its generated per-theme licence table, from the docs repository
    on raw.githubusercontent.com: `docs/attribution.mdx`, `docs/_generated_attribution.mdx` [O1, O2]
  - the Overture YAML schema for segments and infrastructure [O3, O4]
  - the schema repository README, which says the YAML schema is deprecated in favour of Pydantic packages and
    will be removed in December 2026 [O5]
  - the SPDX copies of ODbL-1.0, CDLA-Permissive-2.0, Apache-2.0 and CC0-1.0 [L1–L4]
  - tilezen/joerd's terrain docs `formats.md`, `data-sources.md` and `attribution.md` [E1–E3]
  - the AWS Open Data registry entry for Terrain Tiles [E4]
- **Primary data checked.** I listed the Overture bucket and read the Parquet footers of the `2026-10-21.0`
  release with HTTP range requests, so every schema field below is the real column list of that release.
  For Georgetown I then downloaded only the row groups whose bounding-box statistics hit the bbox, and computed
  the fill rates in the tables. The bbox is the one in `scripts/importOsm.mjs`: −77.074, 38.899, −77.048, 38.914.
  - Volume read: places 39 MB, segments 258 MB, infrastructure 43 MB, buildings 431 MB, almost all of it
    footers.
  - All downloads went to the scratchpad and nothing from them was executed.
  - Counts are features whose bbox intersects the Georgetown bbox, so a few long features reach outside it.
  - The tooling was a throwaway Python venv with pyarrow in the scratchpad. **No repo dependency was added.**
- **Terrain checked.** I fetched three Terrain Tiles for Georgetown (z14 4684/6266, z15 9369/12533,
  z15 9369/12535), tried z16, read the `x-amz-meta-x-imagery-sources` headers and decoded the PNGs.
- **Blocked from this environment (proxy 403 or DNS refused), not read directly:**
  - openstreetmap.org
  - osmfoundation.org (OSMF licence guidelines)
  - opendatacommons.org
  - cdla.dev
  - docs.overturemaps.org
  - registry.opendata.aws

  For the OSMF attribution and produced-work guidance I used web-search extracts [G1–G4]. The licence texts
  themselves were read in full from SPDX.

## 1. OpenStreetMap vs Overture for us

| | OpenStreetMap (raw) | Overture Maps |
|---|---|---|
| Reachable from the build container | **No** (openstreetmap.org, Overpass and osmfoundation.org are blocked by policy) | **Yes** (`overturemaps-us-west-2.s3.amazonaws.com`, GeoParquet, HTTP range requests work) |
| Licence of roads and buildings | ODbL 1.0 | ODbL 1.0 (OSM-derived; also TomTom and Microsoft data under ODbL) |
| Places / POIs | OSM shops and amenities, ODbL | Separate theme: CDLA-Permissive-2.0, plus some Apache-2.0 and CC0. **OSM POIs are not in it** |
| Update | live | monthly releases (latest `2026-10-21.0`; the bucket also holds `2026-09-23.0`/`.1`) |
| IDs | OSM ids (change on edits) | GERS ids, kept across releases where possible; `bridgefiles/<release>/` maps them to source ids |
| Attribute richness | every tag (`lanes`, `sidewalk=*`, `parking:*`, `step_count`, `incline`, `handrail`, `entrance`, `addr:*` …) | a curated subset (section 4); some raw OSM tags survive in `base.*.source_tags` |
| Tooling | `scripts/importOsm.mjs` already reads OSM XML | needs a GeoParquet reader (see section 9) |

**Decision:** Overture. It is the only one we can reach. Its road and building layers are OSM underneath, with
the same licence, and it adds lidar building heights (USGS) that raw OSM lacks in DC. Keep `importOsm.mjs`
working in case the owner later supplies an OSM extract; the two can share the `open-city-osm-1` output schema.

## 2. Overture themes and their licences

From Overture's generated attribution table [O2] (fetched 2026-11-05, entries "Accessed: 2026-10-15") and the
`sources[].license` column of the data:

| Theme (types) | Licence | Sources named by Overture | What we actually found in Georgetown |
|---|---|---|---|
| transportation (`segment`, `connector`) | **ODbL** | © OpenStreetMap contributors; data from TomTom | 2,898 segments. Source entries: OpenStreetMap/ODbL-1.0 4,172; TomTom/ODbL-1.0 18 |
| buildings (`building`, `building_part`) | **ODbL** | OSM; Esri Community Maps contributors (CC BY 4.0); Microsoft Global ML Building Footprints (ODbL); Google Open Buildings (CC BY 4.0); USGS 3DEP; others | 4,720 buildings. Geometry: OSM 4,564, **Esri Community Maps 140** ("CC BY 4.0 with OpenStreetMap waivers"), Microsoft 16. Heights: **USGS Lidar 1,317**, Microsoft ML 475 |
| base (`water`, `land`, `land_use`, `land_cover`, `infrastructure`, `bathymetry`) | **ODbL** | OSM; Daylight; ESA WorldCover (CC BY 4.0); ETOPO1; GLOBathy | infrastructure 2,099 points/lines, all OpenStreetMap/ODbL-1.0 |
| places (`place`) | **per source** (no single theme licence) | Meta, Microsoft, PinMeTo, Krick, RenderSEO, DAC, BrightQuery, Birdeye, Uberall, OpenTravel: **CDLA-Permissive-2.0**; Foursquare: **Apache-2.0** with NOTICE; AllThePlaces: **CC0-1.0** | 3,822 places. Source entries: CDLA 10,371; **Apache-2.0 336** (Foursquare); CC0 47. 336 places have Foursquare as their only external source |
| addresses (`address`) | per source, "permissive open licenses" | US: National Address Database (USDOT), "National Address Database Access and Usage License" | not sampled |
| divisions | ODbL | OSM, geoBoundaries (CC BY 4.0), Esri, LINZ | not needed |

Overture's own attribution page [O1] says that for anything made "wholly or in part from OpenStreetMap data" they
show **`© OpenStreetMap contributors, Overture Maps Foundation`**. The optional citation is
`Overture Maps Foundation, overturemaps.org`.

**CC BY 4.0 inside buildings.** 140 Georgetown footprints come from Esri Community Maps under CC BY 4.0. Overture
labels this "with OpenStreetMap waivers"; I could not read the waiver, so I am not relying on it. CC BY needs
credit: "Esri Community Maps contributors". Google Open Buildings did not appear in Georgetown. The importer
should list every `sources[].dataset` it keeps and fail if an unknown licence appears.

## 3. ODbL obligations for a game

Text: ODbL 1.0 [L1], read in full.

**Definitions that decide our case.**

- A **Produced Work** is "a work (such as an image, audiovisual material, text, or sounds) resulting from using
  the whole or a Substantial part of the Contents". The rendered game, screenshots and videos are Produced Works.
- A **Derivative Database** is "a database based upon the Database". Section 4.4 b adds: "Extraction or
  Re-utilisation of the whole or a Substantial part of the Contents into a new database is a Derivative
  Database". **`src/data/georgetown.json` is a Derivative Database.** It is the Overture/OSM roads, footways,
  buildings and water, reprojected, clipped and re-encoded.
- Shipping that JSON inside the static site (bundled or as a file) is **Publicly Conveying** the Derivative
  Database, not just using a Produced Work. The OSMF guidance points the same way: if a Produced Work can be
  used "to extract, copy, or recreate substantial parts of the OpenStreetMap data, it is considered to be a
  Derivative Database" [G2]. That is a search extract; the guideline page is blocked here.

**What we must do.**

1. **Licence the database under ODbL** (4.2 a, 4.4 a). `georgetown.json` (and any other OSM-derived data file)
   is offered under ODbL 1.0. This does **not** put the game's code under ODbL. Code and data are licensed
   separately; the repository currently has no code licence at all, which is the owner's decision.
2. **Notices with the database** (4.2 b–d). Include the ODbL text or its URI "both in the Database or
   Derivative Database and in any relevant documentation", keep the copyright notices, and put notices
   "in a location (such as a relevant directory) where users would be likely to look". In practice:
   - a `meta.license` / `meta.attribution` block inside the JSON
   - a `DATA-LICENSE.md` at the repo root (section 8)
   - the README section
3. **Notice on the Produced Work** (4.3). When the game is public it must carry a notice "reasonably
   calculated" to make anyone who sees it aware the content came from the database and is under ODbL. The
   licence's example: "Contains information from DATABASE NAME, which is made available here under the
   Open Database License (ODbL)."
4. **Offer the derivative database** (4.6). If we publicly use a Derivative Database or a Produced Work from
   it, we must offer recipients, free of charge over the internet, either "(a) The entire Derivative Database;
   or (b) A file containing all of the alterations made to the Database or the method of making the
   alterations… (such as an algorithm)". We can do both at no cost:
   - keep `src/data/georgetown.json` in the public repo and also serve it as a plain file on the site
     (for example `data/georgetown.json`, linked from Credits)
   - keep the importer script and the Overture release id in the repo
5. **No restrictive technical measures** (4.7). Do not obfuscate or encrypt the data file. A minified bundle is
   fine as long as the plain file is offered too ("parallel distribution", 4.7 b).
6. **Do not add incompatible contents** to the ODbL file (4.4 d). Anything we hand-author into it (our own
   street furniture, invented shop names, parking spots) becomes part of the ODbL database. That is fine
   because it is our own work. Third-party content under other licences must stay out (next point).

**Mixing with CDLA places (and Apache/CC0).**

- **CDLA-Permissive-2.0** [L2] has one condition for sharing data: "so long as the Data Recipient makes
  available the text of this agreement with the shared Data". It also says it "does not impose any
  restriction or obligations with respect to… Results" (results of computational analysis).
- **ODbL 4.5 a** allows a **Collective Database**: an ODbL database next to other databases, where the others
  need not be ODbL.
- **Low-risk layout:**
  - `georgetown.json`: OSM/Overture-derived geometry, ODbL.
  - `georgetown-places.json`: one record per place with only `{ id, x, z, basic_category, confidence,
    operating_status, sourceLicence }`, CDLA-Permissive-2.0, with the CDLA text shipped alongside.
  - No real names, phones, websites, socials, emails or brands. This is already a CLAUDE.md rule (names come
    from `src/data/poiNames.ts`).
  - Matching a place to a building can happen at load time, or be stored in the places file. **Do not** write
    place-derived values into the ODbL file. Not because it is clearly forbidden, but because OSMF has not ruled
    on CDLA/ODbL compatibility and the separate-file layout avoids the question. OSMF's "Horizontal Map Layers"
    guideline [G3] describes the same idea for produced works: separate layers that are not used to correct each
    other. I did not read it directly.
- **Apache-2.0 (Foursquare) records.** Redistribution needs a copy of the Apache licence, notices of changes and
  the NOTICE file contents (Apache-2.0 §4 [L3]). Overture links Foursquare's NOTICE at
  `https://opensource.foursquare.com/places-notice-txt/` [O2]. Simplest: **filter out places whose only
  external source is Foursquare** (336 of 3,822 in Georgetown). The alternative is to ship `LICENSE-APACHE-2.0`
  plus the NOTICE text.
- **CC0 (AllThePlaces)** places need nothing [L4].

**Attribution placement for a game (OSMF).**

- The OSMF Attribution Guidelines (search extracts [G1]) list acceptable places for games: "splash screen on
  application startup, in the game view, during gameplay, on the credits page, in the menu, or in another
  suitable location".
- Splash text must be legible long enough to read.
- Where the attribution cannot carry the link, the link to `https://www.openstreetmap.org/copyright` must be in
  "an easily locatable part of the… software".
- For an interactive map the usual expectation is attribution on or next to the map. Our minimap (and the
  Stage 3 big map) shows OSM-derived roads, so the short credit belongs in the big map's corner (or under the
  minimap) as well as in the pause menu.

## 4. Overture fields that give us what the generator needs

The columns are the real ones in `2026-10-21.0` (Parquet footers; schema system `overture-schema-system 2.0.0`).
Fill rates are for Georgetown. "Drivable" = road classes motorway, trunk, primary, secondary, tertiary,
residential, unclassified, service and living_street: 1,000 of 2,886 road segments.

| We need | Overture field | Georgetown |
|---|---|---|
| Road class | `segment.class`: motorway, trunk, primary, secondary, tertiary, residential, living_street, unclassified, service, pedestrian, footway, steps, path, track, cycleway, bridleway, unknown. `subtype`: road, rail, water | footway 1,566 · service 402 · steps 235 · residential 227 · primary 187 · secondary 70 · trunk 40 · tertiary 32 · cycleway 31 · path 27 · motorway 27 · unknown 18 · others ≤ 8 |
| Kind of service road, sidewalk, crossing | `subclass` (+ `subclass_rules` along the segment): link, sidewalk, crosswalk, parking_aisle, driveway, alley, cycle_crossing | sidewalk 442 · crosswalk 267 · alley 90 · driveway 66 · link 46 · parking_aisle 23 |
| Street names | `names.primary` (+ `names.common` by language, `names.rules` by side or range) | 567 / 1,000 drivable (the unnamed ones are mostly service roads). Names are full: "M Street Northwest", "Wisconsin Avenue Northwest" |
| One-way | `access_restrictions[]`: `{access_type: denied, when: {heading: backward}}` = one-way along the geometry. Also mode, purpose (`using`), status (`recognized`), vehicle dimensions, time (`during`), and `between` for part of a segment | 327 drivable segments one-way, for example 32nd Street NW |
| Other access | same array: `allowed`/`designated` with `mode: [foot, bicycle]`, `denied` with `mode: [motor_vehicle]` or `[car]`, `recognized: [as_private]` | 405 drivable segments have some rule |
| Turn bans | `prohibited_transitions[]` (sequence of segment/connector, `final_heading`, `when`) | 82 |
| Speed limits | `speed_limits[]`: `max_speed {value, unit}`, `min_speed`, `is_max_speed_variable`, `when`, `between` | 328 / 1,000 (32.8%): 25 mph 272, 35 mph 34, 30 mph 11, 15 mph 8, 40 mph 6, 10 mph 3, 20 and 55 mph 1 each. **Default by class for the rest** |
| Bridges, tunnels, covered | `road_flags[].values`: is_bridge, is_tunnel, is_covered, is_indoor, is_under_construction, is_abandoned, is_link (deprecated) | is_bridge 88 · is_link 56 · is_covered 48 · is_tunnel 29 |
| Stacking (layer) | `level_rules[] {value, between}` (z-order, not a height) | 1: 76 · −1: 50 · 2: 13 · 3: 6 · 5: 1 |
| Lanes | **none.** `lanes` is not in the schema | derive from class, one-way and names (as `importOsm.mjs` does today) |
| Width | `width_rules[] {value (m), between}` | **1 / 1,000** drivable. Effectively absent; use class defaults |
| Surface | `road_surface[]`: paved, unpaved, gravel, dirt, paving_stones, metal, unknown | 608 / 1,000 drivable; on all roads paving_stones 319 (Georgetown brick and cobble footways) |
| Steps | `class = steps` | 235 segments. **No step count, incline direction or handrail**; heights come from terrain at both ends |
| Crossings, signals, stop signs | **not on connectors** (`connector` has only id, geometry and sources). They are points in `base/infrastructure` | crossing 848 · traffic_signals 102 · stop 117 · give_way 5 · kerb 135 · motorway_junction 11 |
| Street furniture | `base/infrastructure` class: street_lamp, bench, waste_basket, bollard, bus_stop, bicycle_parking, bicycle_rental, fire_hydrant, post_box, drinking_water, fountain, artwork, … (`source_tags` keeps OSM tags, for example `traffic_signals:direction=forward`) | bench 228 · parking 147 · bus_stop 61 · bicycle_parking 59 · street_lamp 54 · gate 30 · parking_entrance 28 · artwork 21 · bollard 15 · waste_basket 10 · retaining_wall 9 · fire_hydrant 5 · … |
| Bridge outlines, piers | `base/infrastructure` subtype bridge (class bridge, boardwalk) and pier | bridge 103 · pier 6 |
| Building footprint and height | `building.geometry`, `height` (m), `num_floors`, `min_height`, `min_floor`, `roof_shape`, `roof_height`, `roof_direction`, `roof_orientation`, `roof_material`, `roof_color`, `facade_material`, `facade_color`, `class`, `subtype`, `level`, `is_underground`, `has_parts`; `building_part` has the same plus `building_id` | 4,720 buildings: height 1,829 (38.8%; quartiles 6.8 / 8.9 / 12.0 m, max 61 m), num_floors 157 (3.3%), roof_shape 11, facade_material 12 (all brick), class 2,906 (house 2,656, retail 71, apartments 40, shed 38, university 33, …), has_parts 14 |
| Entrances / doors | `base/infrastructure` class `entrance` exists in the schema | **0 in Georgetown.** Doors must be placed by our generator (street-facing side) |
| Place categories | `place.basic_category` (≈ 190 distinct values in Georgetown), `taxonomy {primary, hierarchy[], alternates[]}`, `confidence`, `operating_status`. **The older `categories` column is gone in this release** | 3,822 places: restaurant 262, fashion_and_apparel_store 209, real_estate_service 188, professional_service 183, health_care 147, … coffee_shop 27; operating_status open 2,824 / permanently_closed 286 / null 712; confidence median 0.92 |
| Water and land use | `base/water` (`class`, `subtype`, `is_intermittent`, `is_salt`, `level`), `base/land_use`, `base/land_cover` | not sampled (Potomac, C&O Canal and parks are known in OSM) |
| Provenance and licence per feature | `sources[] {dataset, license, record_id, property, update_time, confidence, between, …}` | use it to filter by licence and to write the credits automatically |

**Known gaps vs raw OSM** (what `importOsm.mjs` could read from OSM but Overture does not carry):

- **Lanes and widths:** no `lanes`, `lanes:forward/backward`, `turn:lanes` or `width` (`width_rules` is almost
  empty).
- **Sidewalks on roads:** no `sidewalk=*` tags. Only separately drawn sidewalk footways exist. DC maps
  sidewalks as separate ways, so we get 442, but streets without them get none. The generator must still add
  default sidewalks by class.
- **Parking:** no `parking:lane` / `parking:*` on streets. Car parks exist as `infrastructure` parking points or
  areas and `parking_aisle` service roads.
- **Junction attributes** are not on connectors. Signals, stop signs and crossings are separate points that
  must be snapped to the nearest connector or segment vertex. They come from OSM nodes, so they should sit
  exactly on segment vertices; the importer should verify this and report misses.
- **Steps detail:** no `step_count`, `incline`, `handrail`, `ramp` or `width`. Stair geometry must come from the
  terrain difference along the segment.
- **POIs:** OSM shops and amenities are not in the places theme. Places come from commercial and other
  providers, so positions are business listings (sometimes the building centroid, sometimes the door,
  sometimes stale; 286 are marked permanently closed).
- **Addresses on buildings:** OSM `addr:*` is not on buildings; it is a separate theme from other sources
  (US: the National Address Database).
- **Entrances:** OSM `entrance=*` nodes are in the schema but absent here.
- **Raw tags** survive only in `base.*.source_tags`, not on segments or buildings.
- **Freshness:** Overture lags OSM by at least a month.

## 5. Terrain: AWS Terrain Tiles (`elevation-tiles-prod`)

- **What it is.** Mapzen's Terrain Tiles, now "Managed By: Mapzen, a Linux Foundation project" on the AWS Open
  Data registry [E4]:
  - bucket `arn:aws:s3:::elevation-tiles-prod` (us-east-1), EU replica `elevation-tiles-prod-eu`
  - URL pattern `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  - The registry's licence link points to the attribution document [E3].
- **Source for Washington DC.**
  - Every Georgetown tile I fetched (z14 4684/6266, z15 9369/12533, z15 9369/12535) carries
    `x-amz-meta-x-imagery-sources: ned/ned19_n39x00_w077x25_md_washingtondc_2008.tif`. That is USGS
    NED/3DEP **1/9 arc-second** (about 3 m), the DC 2008 lidar-derived DEM. `data-sources.md` lists 3DEP
    1/3″ and 1/9″ in the US from z10 to z15 [E2].
  - Tiles are `Last-Modified: 12 Nov 2017`: a static dataset, no updates.
- **Resolution.**
  - **z15 is the maximum zoom; z16 returns 404** (checked: `terrarium/16/18739/25067.png`).
  - At z15 a 256 × 256 tile is about 951 m across here, so about **3.72 m per pixel** at lat 38.9065 (from
    `ground_resolution = cos(lat)·2π·6378137 / (256·2^z)` [E2]). That is about the native 1/9″ grid
    (about 3.4 m north-south and 2.7 m east-west).
  - At z14 it is about 7.4 m per pixel.
  - The Georgetown bbox needs 3 × 3 z15 tiles: x 9368–9370, y 12533–12535.
- **Encoding.**
  - **Terrarium** PNG, Web Mercator (EPSG:3857): `height = (R·256 + G + B/256) − 32768` metres, in steps of
    1/256 m (3.9 mm) [E1].
  - Also available: `normal` (PNG normals + quantised height), `geotiff` (512 × 512) and `skadi` (SRTM-style
    HGT).
- **Values (decoded).**

  | Tile | Area | Min | Median | Max |
  |---|---|---|---|---|
  | z15 9369/12535 | Potomac and waterfront | 0.00 m (p05 0.20) | 1.20 m | 29.9 m |
  | z15 9369/12533 | north Georgetown | 3.77 m | 44.9 m | 65.1 m |
  | z14 4684/6266 | | 3.55 m | | 108.2 m |

  The river surface reads about 0 to 0.2 m, so our current datum ("river level 0") lines up with the tiles
  without an offset. The vertical datum is NAVD88, the 3DEP standard (general knowledge, not read in the tile
  metadata).
- **Gotchas for the generator.**
  - It is a **bare-earth** DEM: buildings and **bridges are removed**. Key Bridge and the Whitehurst Freeway
    deck heights must come from Overture (`is_bridge`, `level_rules`) plus our own deck profile, not from the
    DEM.
  - Water is hydro-flattened.
  - Roads are not smoothed. Keep the generator's road-corridor smoothing so road surfaces have no lidar
    bumps.
- **Attribution.**
  - USGS asks for "3DEP data courtesy of the U.S. Geological Survey" (3DEP is public domain: "may be used
    without restriction").
  - Joerd's document gives a combined "Required attribution" list for the whole world [E3]. Only the USGS line
    applies to tiles that come from 3DEP alone, as ours do at z14–15.
  - Crediting Mapzen and the AWS Open Data programme is courteous and cheap.
  - If we ever use low zooms (z ≤ 9 uses SRTM/GMTED/ETOPO1), add "SRTM and GMTED2010 data courtesy of the
    U.S. Geological Survey; ETOPO1 U.S. National Oceanic and Atmospheric Administration".

## 6. Building heights: which to trust

USGS lidar heights (1,317 in Georgetown) and Microsoft ML heights (475) are mixed with OSM `height` tags. All of
them arrive in the same `height` column. `sources[].property == "/properties/height"` tells which source set it.

- **Priority:** OSM-tagged > USGS Lidar > Microsoft ML > our class/footprint heuristic.
- **Missing heights** (61%): fall back to `num_floors × 3.2 m`, then to the generator's current
  per-neighbourhood defaults.

## 7. Recommendation for item 2

1. **Pin a release.**
   - Import `2026-10-21.0` and write `meta.source = "overture"`, `meta.overtureRelease`, `meta.bbox` and
     `meta.license` into `georgetown.json`.
   - Do not float to "latest": GERS ids and geometry change monthly.
   - The schema's YAML is deprecated and goes in December 2026 [O5]. Read the Parquet columns, not the YAML.
2. **Two output files.**
   - `georgetown.json` (ODbL): roads, footways, steps, crossings, signals, infrastructure, buildings, water,
     land use.
   - `georgetown-places.json` (CDLA-Permissive-2.0): categories only.
   - Drop Apache-2.0-only places, or ship their NOTICE.
3. **Licence gate in the importer.**
   - Collect `sources[].dataset` and `license`, and fail on any licence not in an allow-list (ODbL-1.0,
     CDLA-Permissive-2.0, CC0-1.0, USGS/public domain, Esri CC BY 4.0).
   - Write the observed list into `meta.sources` so the credits panel can be generated from data.
4. **Defaults where Overture is empty.**
   - lanes and widths by class
   - sidewalks by class
   - speed limits by class (25 mph residential is what DC tags)
   - doors on the street-facing side
5. **Terrain.**
   - 9 z15 Terrarium tiles, bilinear-sampled into our height raster, cached in the repo as our own derived
     grid (public-domain input, so no licence issue).
   - Keep road corridors smoothed and decks from bridge data.

## 8. Exact attribution strings (ready to paste)

**Pause menu, small print** (the `CityMap.attribution` line) **and the big map's corner:**

```
© OpenStreetMap contributors (ODbL) · Overture Maps Foundation · Esri Community Maps contributors · USGS
```

The pause menu also gets a "Credits and data licences" panel with this text. The links must be clickable, and
the panel must be reachable in one click from the pause menu:

```
Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.
  https://www.openstreetmap.org/copyright
Roads, paths, buildings, water and land use from Overture Maps Foundation, release 2026-10-21.0
(https://overturemaps.org), including data from TomTom and Microsoft (ODbL).
Some building footprints © Esri Community Maps contributors, CC BY 4.0.
Building heights in part from USGS 3DEP lidar (public domain).
Place locations and categories from Overture Maps Foundation, CDLA-Permissive-2.0
(sources include Meta, Microsoft, BrightQuery and AllThePlaces). Business names in the game are invented.
Terrain: 3DEP data courtesy of the U.S. Geological Survey, via Terrain Tiles (Mapzen / Linux Foundation)
on the Registry of Open Data on AWS.
This game contains information from OpenStreetMap and Overture Maps, which is made available here under the
Open Database License (ODbL). The game's map database is free to download under the ODbL:
  <site>/data/georgetown.json  (source: src/data/georgetown.json and scripts/importOverture.mjs)
```

If Foursquare-sourced places are kept, add: `Some place data © Foursquare Labs, Inc., Apache License 2.0 (see
NOTICE).`

**README** (replace the current "Map data" heading text once real data lands; the current line claims OSM for a
map that is still synthetic):

```markdown
## Map data and licences

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/), via
[Overture Maps Foundation](https://overturemaps.org) release 2026-10-21.0 (includes TomTom and Microsoft data
under ODbL; some building footprints © Esri Community Maps contributors, CC BY 4.0; building heights in part
from USGS 3DEP lidar). Place categories: Overture Maps Foundation,
[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). Terrain: 3DEP data courtesy of the U.S. Geological
Survey, via [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/).

`src/data/georgetown.json` is a derivative database of OpenStreetMap/Overture and is licensed under the ODbL
1.0; `src/data/georgetown-places.json` is under CDLA-Permissive-2.0. See DATA-LICENSE.md. Street names are
real; shop and business names are invented (`src/data/poiNames.ts`).
```

**`DATA-LICENSE.md`** (new file at the repo root when the real data is committed; `scripts/importOverture.mjs` and `georgetown-places.json` are placeholder names for whatever item 2 calls them):

```markdown
# Data licences

The program code in this repository and the data files listed below are licensed separately.

## src/data/georgetown.json (and any file generated by scripts/importOverture.mjs)
Derivative database of OpenStreetMap and Overture Maps Foundation data.
Licensed under the Open Database License (ODbL) 1.0: https://opendatacommons.org/licenses/odbl/1-0/
© OpenStreetMap contributors (https://www.openstreetmap.org/copyright), Overture Maps Foundation
(https://overturemaps.org), release 2026-10-21.0; includes data from TomTom and Microsoft (ODbL) and
building footprints © Esri Community Maps contributors (CC BY 4.0). Building heights in part from USGS 3DEP (public domain).
Our own additions (generated sidewalks, lanes, doors, parking spots, hand placed props) are part of this
database and are released under the same licence.
How it was made: scripts/importOverture.mjs with the bbox and release in meta.

## src/data/georgetown-places.json
Place positions and categories from Overture Maps Foundation, CDLA-Permissive-2.0 (text: LICENSE-CDLA-2.0.txt).
Names, phone numbers, websites and brands are deliberately not included.

## Terrain heights inside georgetown.json
Derived from USGS 3DEP 1/9 arc-second elevation (public domain), served as AWS Terrain Tiles.
"3DEP data courtesy of the U.S. Geological Survey."

## Anything else
Procedurally generated textures and meshes are original to this project. Third-party assets, if any, are
listed with source and licence in assets/LICENSES.md.
```

Ship `LICENSE-CDLA-2.0.txt` (the 2,354-byte SPDX text) beside it, and the ODbL text or URI as 4.2 b requires.
The URI above satisfies the "or its URI" option.

## 9. Tooling note for the importer

The importer must read GeoParquet. Options:

- Pure-JS `hyparquet` 1.32.0 (MIT, 2026-10-29) with `hyparquet-compressors` 1.1.3 for zstd.
- `parquet-wasm` 0.9.0.
- DuckDB (`@duckdb/node-api` 2.0.0-r.1).

Any of them is a **new dev dependency** (build-time only, nothing shipped).

The approach used for this research works, and is cheap after the footer pass:

1. List the files.
2. Range-read each footer.
3. Keep the row groups whose `bbox.xmin/xmax/ymin/ymax` statistics hit the bbox.
4. Range-read only those.

It took 19 s for places, 138 s for segments and 477 s for buildings (512 files), each from a cold start.

## Sources (read or searched on 2026-11-05)

- [O1] Overture docs, "Attribution and Licensing" (source file). https://raw.githubusercontent.com/OvertureMaps/docs/main/docs/attribution.mdx (rendered: https://docs.overturemaps.org/attribution/, blocked here)
- [O2] Overture generated attribution table. https://raw.githubusercontent.com/OvertureMaps/docs/main/docs/_generated_attribution.mdx
- [O3] Overture schema, transportation segment (YAML, deprecated). https://raw.githubusercontent.com/OvertureMaps/schema/main/schema/transportation/segment.yaml
- [O4] Overture schema, base infrastructure (YAML, deprecated). https://raw.githubusercontent.com/OvertureMaps/schema/main/schema/base/infrastructure.yaml
- [O5] Overture schema README. https://raw.githubusercontent.com/OvertureMaps/schema/main/README.md
- [O6] Overture release `2026-10-21.0` on S3 (listing and Parquet footers read directly). https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/2026-10-21.0/
- [L1] ODbL 1.0 (SPDX copy). https://raw.githubusercontent.com/spdx/license-list-data/main/text/ODbL-1.0.txt (canonical: https://opendatacommons.org/licenses/odbl/1-0/)
- [L2] CDLA-Permissive-2.0 (SPDX copy). https://raw.githubusercontent.com/spdx/license-list-data/main/text/CDLA-Permissive-2.0.txt (canonical: https://cdla.dev/permissive-2-0/)
- [L3] Apache-2.0 (SPDX copy). https://raw.githubusercontent.com/spdx/license-list-data/main/text/Apache-2.0.txt
- [L4] CC0-1.0 (SPDX copy). https://raw.githubusercontent.com/spdx/license-list-data/main/text/CC0-1.0.txt
- [E1] tilezen/joerd, "Types of Terrain Tiles". https://github.com/tilezen/joerd/blob/master/docs/formats.md
- [E2] tilezen/joerd, "Data sources". https://github.com/tilezen/joerd/blob/master/docs/data-sources.md
- [E3] tilezen/joerd, "Attribution". https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- [E4] AWS Open Data registry entry, terrain-tiles.yaml. https://github.com/awslabs/open-data-registry/blob/main/datasets/terrain-tiles.yaml (rendered: https://registry.opendata.aws/terrain-tiles/, blocked here)
- [E5] Terrain tiles fetched directly: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/9369/12533.png, …/15/9369/12535.png, …/14/4684/6266.png (200) and …/16/18739/25067.png (404)
- [G1] OSMF Attribution Guidelines (search extracts only). https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- [G2] OSMF Licence and Legal FAQ / Produced Work guideline (search extracts only). https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ and https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline
- [G3] OSMF Horizontal Map Layers guideline (title and summary from search only). https://osmfoundation.org/wiki/Licence/Community_Guidelines/Horizontal_Map_Layers_-_Guideline
- [G4] OSM legal-talk, "Using OSM data, to generate game worlds" (2021, secondary). https://lists.openstreetmap.org/pipermail/legal-talk/2021-February/009061.html
