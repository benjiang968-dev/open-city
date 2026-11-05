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
| F4 | collision view: the physics shapes near you, coloured by kind |
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
Physics: `QUERY=physaudit=1 MAP=<id> node scripts/shot.mjs x physaudit` compares what is drawn with the colliders,
`stairs` walks every stair and into every prop kind, `fallthrough` drops the player at thousands of points.

## Map data

Real map data: © OpenStreetMap contributors via Overture Maps Foundation (release 2026-10-21.0), ODbL 1.0; places ©
Overture Maps Foundation, CDLA-Permissive-2.0; some building footprints © Esri Community Maps contributors, CC BY 4.0;
building heights include USGS 3DEP lidar and Microsoft ML Buildings; elevation: USGS 3DEP via AWS Terrain Tiles. The
same line is in the pause menu (`meta.attribution`).

The Georgetown map (Georgetown and the Potomac waterfront, Washington DC, about 2.1 km x 1.9 km at 1:1) ships as
three files with their own licences (`src/data/georgetown.LICENSE.md`):

- `src/data/georgetown.json`: a derivative database of OpenStreetMap data under the Open Database License (ODbL 1.0,
  https://www.openstreetmap.org/copyright);
- `src/data/georgetown-places.json`: place categories and positions (CDLA-Permissive-2.0; places with an Apache-2.0
  source are left out);
- `src/data/georgetown-buildings-ccby.json`: the building footprints that come from Esri Community Maps (CC BY 4.0).

Real street, river, canal and park names are kept; business names never: places carry a category only and the game
invents a name from `src/data/poiNames.ts`. Street furniture the data lacks (street trees on shopping streets, lamps,
benches, bins, hydrants, woodland trees) is synthesized and flagged in the file.

Rebuild it with `npm run import-overture` (`scripts/importOverture.mjs`): it reads Overture Maps release 2026-10-21.0
and the terrain tiles from the cache in `data/overture/` (gitignored), downloading them first with
`scripts/fetchOverture.py` when the cache is missing (needs Python with `pyarrow` and `shapely`; set
`OVERTURE_PYTHON` to that interpreter, see the top of the script; a cache from before 2026-11-05 lacks place sources:
re-fetch with `--only place --force`). `npm run preview-map` draws the result to
`screenshots/24-map-preview.png`.

Fallbacks: `npm run gen-georgetown` regenerates the older hand-authored approximation from `data/georgetown-spec.json`
(general knowledge, 20-80 m error, `meta.synthetic` true) into the same file, and `npm run import-osm` converts an
OpenStreetMap XML download (`data/osm/README.md`). `?map=grid` is the procedural grid city.
