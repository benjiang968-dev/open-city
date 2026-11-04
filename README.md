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

Map data © OpenStreetMap contributors, ODbL

Milestone 3 builds the city from OpenStreetMap (Georgetown, Washington DC; see https://www.openstreetmap.org/copyright).
Street, river, canal and park names come from OSM. Shop and business names are invented (`src/data/poiNames.ts`).
To import the map, follow `data/osm/README.md` (`npm run import-osm`).
