# Open City (working title)

A browser open-world sandbox: a seeded coastal city, cars you can drift, traffic, pedestrians you can talk to,
a taxi job and police. No story, no cutscenes. See `CLAUDE.md` for the design and `DEVLOG.md` for progress.

## Run

```bash
npm install
npm run dev        # opens http://localhost:5173
```

`?seed=123` in the URL picks a different city (people, cars; on the grid map also buildings, shops and street names). `?map=grid` picks the map;
the seed never changes which map loads. Every system reads the map through one interface, `src/systems/map/cityMap.ts`.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | walk / drive |
| Shift | run |
| Space | jump / handbrake |
| E | enter or exit a car, talk to someone |
| Mouse (click to lock) | look around |
| R | flip the car upright |
| H | horn |
| F3 or ` (backtick) | debug overlay |
| M | mute |

## Build and deploy

```bash
npm run build      # type-check + static build into dist/
npm run deploy     # build and push dist/ to the gh-pages branch
```

GitHub Pages: repository Settings → Pages → Source: "Deploy from a branch", branch `gh-pages`, folder `/ (root)`.
The site is then served at `https://<owner>.github.io/open-city/`.

## Headless checks

```bash
npm run build
node scripts/shot.mjs 06-taxi taxi       # runs a scenario, saves screenshots/06-taxi.png, fails on console errors
```

Scenarios live in `scripts/scenarios.mjs` (handling, life, taxi, chat, police, bust, night, perf …).
`MAP=<id> node scripts/shot.mjs x mapcheck` checks a map's integrity (graph, 30 lane choices by a traffic car, 20 walks).

## Map data

Map data © OpenStreetMap contributors (ODbL), via the Overture Maps Foundation; places © Overture Maps Foundation
(CDLA-Permissive-2.0); building heights include USGS 3DEP lidar, Microsoft ML Buildings and Esri Community Maps
contributions; terrain: AWS Terrain Tiles (USGS 3DEP). The same line is in the pause menu (`meta.attribution`).

`src/data/georgetown.json` (Georgetown and the Potomac waterfront, Washington DC, about 2.1 km x 1.9 km at 1:1) is a
derivative database of OpenStreetMap data, made available under the Open Database License: see
`src/data/georgetown.LICENSE.md` and https://www.openstreetmap.org/copyright. Real street, river, canal and park names
are kept; business names never: places carry a category only and the game invents a name from `src/data/poiNames.ts`.
Street furniture the data lacks (street trees on shopping streets, lamps, benches, bins, hydrants, woodland trees) is
synthesized and flagged in the file.

Rebuild it with `npm run import-overture` (`scripts/importOverture.mjs`): it reads Overture Maps release 2026-10-21.0
and the terrain tiles from the cache in `data/overture/` (gitignored), downloading them first with
`scripts/fetchOverture.py` when the cache is missing (needs Python with `pyarrow` and `shapely`; set
`OVERTURE_PYTHON` to that interpreter, see the top of the script). `npm run preview-map` draws the result to
`screenshots/24-map-preview.png`.

Fallbacks: `npm run gen-georgetown` regenerates the older hand-authored approximation from `data/georgetown-spec.json`
(general knowledge, 20-80 m error, `meta.synthetic` true) into the same file, and `npm run import-osm` converts an
OpenStreetMap XML download (`data/osm/README.md`). `?map=grid` is the procedural grid city.
