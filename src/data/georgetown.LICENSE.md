# Licence and sources of `georgetown.json`

`georgetown.json` (the Georgetown map: roads, paths, buildings, water, parks, car parks, street furniture, places and
terrain heights) is a **derivative database** of OpenStreetMap data. It is made available under the
**Open Database License (ODbL) 1.0**: https://opendatacommons.org/licenses/odbl/1-0/. Any rights in individual
contents of the database are licensed under the Database Contents License: https://opendatacommons.org/licenses/dbcl/1-0/.

You may copy, distribute and adapt it, as long as you attribute it, share any adapted database under the ODbL, and
keep it open (see the licence for the exact terms).

## Sources

| What | Source | Licence |
|---|---|---|
| Roads, paths, buildings, water, land use, street furniture | OpenStreetMap contributors, via Overture Maps Foundation release 2026-10-21.0 (transportation, buildings, base themes) | ODbL 1.0 |
| A few road segments | TomTom contributions to Overture transportation (released by Overture under ODbL) | ODbL 1.0 |
| Building heights | USGS 3DEP lidar (public domain), Microsoft ML Buildings (ODbL), Esri Community Maps (CC BY 4.0 with OpenStreetMap waivers), via Overture buildings | as listed |
| Place categories (no names) | Overture Maps Foundation places | CDLA-Permissive-2.0 |
| Terrain heights | AWS Terrain Tiles (terrarium), from USGS 3DEP and other public elevation data | public domain / see https://github.com/tilezen/joerd/blob/master/docs/attribution.md |

Attribution shown in the game (pause menu) and the README:

> Map data: © OpenStreetMap contributors (ODbL), via Overture Maps Foundation (release 2026-10-21.0); places © Overture
> Maps Foundation (CDLA-Permissive-2.0); building heights include USGS 3DEP lidar, Microsoft ML Buildings and Esri
> Community Maps contributions; terrain: AWS Terrain Tiles (USGS 3DEP).

## Not from the data

- Business and building names are never stored: places carry a category (OSM `key=value`), and the game invents a name
  from `src/data/poiNames.ts`.
- Props with a fourth element `1` (street trees on shopping streets, lamps, benches, bins, hydrants, woodland and park
  trees) are synthesized by `scripts/importOverture.mjs`, not mapped.
- Road widths and lane counts are estimates where the data has none (`est`), canal pound levels and Rock Creek water
  levels are measured from the terrain tiles.

Produced by `scripts/importOverture.mjs` (with `scripts/fetchOverture.py`).
