# OpenStreetMap source file (Milestone 3: Georgetown, Washington DC)

Put the OpenStreetMap download in this folder as **`data/osm/georgetown.osm`** (a gzipped `georgetown.osm.gz` works too).
The importer turns it into `src/data/georgetown.json`, which the game will load.

## 1. Get the file

**Option A, browser (recommended).** Open this link:

https://overpass-api.de/api/map?bbox=-77.0740,38.8990,-77.0480,38.9140

The browser saves a file called `map` (tens of MB, it can take a minute). Rename it to `georgetown.osm` and move it
into this folder, so the path is `data/osm/georgetown.osm`.

**Option B, openstreetmap.org.** Go to https://www.openstreetmap.org/export, click "Manually select a different
area" and enter left -77.0740, bottom 38.8990, right -77.0480, top 38.9140, then Export. If the site says the area
is too large, it offers the Overpass link from option A instead.

**Option C, let the script download it.** Needs internet access to overpass-api.de:

```bash
npm run import-osm -- --overpass
```

It saves the download to `data/osm/georgetown.osm` and imports it. `node scripts/importOsm.mjs --print-query`
prints the Overpass query, which you can paste into https://overpass-turbo.eu instead.

## 2. Run the importer

```bash
node scripts/importOsm.mjs                       # reads data/osm/georgetown.osm, writes src/data/georgetown.json
node scripts/importOsm.mjs path/to/file.osm      # any other location, .osm or .osm.gz
npm run import-osm -- path/to/file.osm           # same thing through npm
```

Options: `--out <file>`, `--report-json <file>` (full suspicious-areas lists), `--report-limit <n>`,
`--crop minlon,minlat,maxlon,maxlat`, `--simplify <scale>`. `--help` lists them all.

The script prints:

- how many roads, footways, buildings, POIs, water areas, waterways, parks, car parks, bridges and street props it
  kept, and whether it found the C&O Canal and its towpath;
- the output file size (target under 3 MB; it simplifies harder by itself if needed);
- **suspicious areas** to check on openstreetmap.org, each with lat/lon and a link: buildings that sit on a road,
  streets with no sidewalk tagging nearby, and areas (like the Potomac) cut by the download box, where the script
  had to guess which side is water.

## 3. What ends up in the game

- The area is cropped to Key Bridge (west) through just east of Washington Circle (east), and from the Potomac
  (south) to just north of R St NW, about 2.0 km x 1.5 km. The numbers are `BBOX` and `CROP` at the top of
  `scripts/importOsm.mjs`.
- Coordinates are metres from the crop centre: x east, z south (the game's +z is south), rounded to 0.1 m.
- **Names:** street, river, canal, bridge and public-park names are real. Business and building names are never
  copied (nor pond or fountain names, which are often a property's name). Each POI only keeps its category (for
  example `amenity=cafe`), and the game gives it an invented name from `src/data/poiNames.ts`.

## Licence

Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright). `src/data/georgetown.json` is
derived from OpenStreetMap, so it stays under the ODbL and the game must show that attribution line.

The raw `.osm` file is large, so git ignores it (see `.gitignore`); commit the generated JSON instead.

## Testing the importer

```bash
node scripts/testImportOsm.mjs
```

This runs the importer on the small synthetic fixture `scripts/fixtures/tiny.osm` (invented streets, not real map
data). It writes to a temp folder, never to `src/data`.
