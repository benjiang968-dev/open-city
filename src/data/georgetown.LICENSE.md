# Licence and sources of the Georgetown map data

The real Georgetown map ships as three files, because their sources come under different licences. The game loads
all three (`loadGeoDoc` in `src/systems/map/geoDoc.ts`) and builds one world from them.

| File | What | Licence |
|---|---|---|
| `georgetown.json` | roads, paths, buildings, water, parks, car parks, street furniture, bridges and terrain heights | **ODbL 1.0** (derivative database of OpenStreetMap) |
| `georgetown-places.json` | place categories and positions (no names) | **CDLA-Permissive-2.0** (Overture places) |
| `georgetown-buildings-ccby.json` | 129 building footprints whose geometry comes from Esri Community Maps | **CC BY 4.0** |

## georgetown.json: ODbL

`georgetown.json` is a **derivative database** of OpenStreetMap data. It is made available under the
**Open Database License (ODbL) 1.0**: https://opendatacommons.org/licenses/odbl/1-0/. Any rights in individual
contents of the database are licensed under the Database Contents License: https://opendatacommons.org/licenses/dbcl/1-0/.

You may copy, distribute and adapt it, as long as you attribute it, share any adapted database under the ODbL, and
keep it open (see the licence for the exact terms). © OpenStreetMap contributors: https://www.openstreetmap.org/copyright.

## georgetown-places.json: CDLA-Permissive-2.0

Place categories and positions from the Overture Maps Foundation places theme, under the Community Data License
Agreement – Permissive, Version 2.0: https://cdla.dev/permissive-2-0/. Only the category (mapped to an OSM-style
`key=value`) and the position are kept, never a name or a brand. Records with an Apache-2.0 source (Foursquare) are
left out, and the importer stops if a place has any licence other than CDLA-Permissive-2.0 or CC0-1.0.

## georgetown-buildings-ccby.json: CC BY 4.0

Building footprints from Esri Community Maps, via Overture Maps Foundation buildings, under the Creative Commons
Attribution 4.0 International licence: https://creativecommons.org/licenses/by/4.0/. Credit: "Building footprints ©
Esri Community Maps contributors". They are kept out of the ODbL file: putting CC BY 4.0 data into an ODbL database
needs a waiver of CC BY 4.0 section 2(a)(5)(B), and Esri's waiver names OpenStreetMap and its users, not us (Stage 1
research: docs/research/map-data.md). Heights for these footprints are estimated as in the main file.

## Sources

| What | Source | Licence |
|---|---|---|
| Roads, paths, buildings, water, land use, street furniture | OpenStreetMap contributors, via Overture Maps Foundation release 2026-10-21.0 (transportation, buildings, base themes) | ODbL 1.0 |
| A few road segments | TomTom contributions to Overture transportation (released by Overture under ODbL) | ODbL 1.0 |
| A few building footprints | Microsoft ML Buildings, via Overture buildings | ODbL 1.0 |
| 129 building footprints | Esri Community Maps contributors, via Overture buildings | CC BY 4.0 (separate file) |
| Building heights | USGS 3DEP lidar (public domain), Microsoft ML Buildings (ODbL), via Overture buildings | as listed |
| Place categories (no names) | Overture Maps Foundation places | CDLA-Permissive-2.0 (separate file) |
| Terrain heights | AWS Terrain Tiles (terrarium), from USGS 3DEP and other public elevation data | public domain / see https://github.com/tilezen/joerd/blob/master/docs/attribution.md |

Attribution shown in the game (pause menu, `meta.attribution`) and the README:

> Real map data: © OpenStreetMap contributors via Overture Maps Foundation (release 2026-10-21.0), ODbL 1.0; places ©
> Overture Maps Foundation, CDLA-Permissive-2.0; some building footprints © Esri Community Maps contributors, CC BY 4.0;
> building heights include USGS 3DEP lidar and Microsoft ML Buildings; elevation: USGS 3DEP via AWS Terrain Tiles.

## Not from the data

- Business and building names are never stored: places carry a category (OSM `key=value`), and the game invents a name
  from `src/data/poiNames.ts`.
- Props with a fourth element `1` (street trees on shopping streets, lamps, benches, bins, hydrants, woodland and park
  trees) are synthesized by `scripts/importOverture.mjs`, not mapped.
- Road widths and lane counts are estimates where the data has none (`est`), canal pound levels and Rock Creek water
  levels are measured from the terrain tiles.

Produced by `scripts/importOverture.mjs` (with `scripts/fetchOverture.py`). Not legal advice.
