#!/usr/bin/env node
// OpenStreetMap importer for Milestone 3: Washington DC, Georgetown slice.
//
//   node scripts/importOsm.mjs [input.osm | input.osm.gz] [options]     (default input: data/osm/georgetown.osm)
//   node scripts/importOsm.mjs --overpass                                (download BBOX from Overpass first)
//   npm run import-osm -- [input] [options]
//
// Reads OSM XML (openstreetmap.org export, Overpass /api/map or /api/interpreter output, JOSM files), crops it to
// CROP, projects it to local metres and writes compact JSON for the game (default src/data/georgetown.json).
// Street, river/canal, bridge and public-park names are kept. Names of businesses, buildings, ponds and fountains
// are never written: the game names POIs from src/data/poiNames.ts by category instead. See data/osm/README.md.
//
// Options:
//   --out <file>            output JSON (default src/data/georgetown.json)
//   --overpass              fetch BBOX from the Overpass API, save it to the input path, then import it
//   --overpass-url <url>    Overpass interpreter endpoint (default https://overpass-api.de/api/interpreter)
//   --print-query           print the Overpass QL query (paste it into overpass-turbo.eu) and exit
//   --crop <minlon,minlat,maxlon,maxlat>   override CROP for this run
//   --report-json <file>    also write the full suspicious-areas lists as JSON
//   --report-limit <n>      rows per suspicious list printed to stdout (default 25)
//   --simplify <scale>      multiply the SIMPLIFY_* tolerances (default: 1, raised to 2 then 4 if over 3 MB)
//
// Output frame: x east, z SOUTH, y up, metres, origin at the crop centre (the game's +z is south).
// Plain Node ESM, no dependencies.

import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';

// =================================================================================================== area
/** Download area: what --overpass fetches; use the same numbers for a manual download. */
export const BBOX = { minlon: -77.074, minlat: 38.899, maxlon: -77.048, maxlat: 38.914 };
/**
 * Game area, about 2.0 km x 1.5 km. West: past the Georgetown end of Key Bridge (~-77.070).
 * East: just east of Washington Circle / 23rd St NW (~-77.0506). South: into the Potomac, leaving 100-250 m of river
 * south of the Georgetown shore for boats. North: just north of R St NW (~38.913).
 * Must sit inside BBOX so every way that crosses it is complete in the download.
 */
export const CROP = { minlon: -77.072, minlat: 38.9, maxlon: -77.049, maxlat: 38.9138 };

const DEFAULT_IN = 'data/osm/georgetown.osm';
const DEFAULT_OUT = 'src/data/georgetown.json';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ATTRIBUTION = 'Map data © OpenStreetMap contributors, ODbL';
const FORMAT = 'open-city-osm-1';

// ======================================================================================= import constants
// These shape the generated data file, not gameplay; gameplay numbers stay in src/tuning.ts.
const LEVEL_HEIGHT = 3.2; // m per storey when only building:levels is tagged
const ROOF_LEVEL_HEIGHT = 1.6; // m per roof:levels storey (attics, mansards)
const DEFAULT_BUILDING_HEIGHT = 9; // m, building=yes with no height or levels
/** Height estimates (m) by building=* when neither height nor building:levels is tagged. Output gets est:1. */
const BUILDING_TYPE_HEIGHT = {
  house: 9, detached: 8, semidetached_house: 9, terrace: 10, residential: 10, apartments: 16, dormitory: 14,
  commercial: 10, retail: 7, office: 18, hotel: 22, supermarket: 7, kiosk: 3,
  church: 15, chapel: 9, cathedral: 25, mosque: 12, synagogue: 12, temple: 10, religious: 12,
  school: 11, university: 15, college: 14, kindergarten: 5, hospital: 20, civic: 12, public: 12, government: 15,
  fire_station: 9, transportation: 8, train_station: 10, parking: 12, boathouse: 6, warehouse: 9, industrial: 9,
  garage: 3.2, garages: 3.2, carport: 2.6, shed: 2.6, hut: 3, roof: 4.5, service: 4, construction: 8, stadium: 15,
};
const MIN_BUILDING_AREA = 4; // m², smaller footprints are dropped as mapping noise
const MIN_INSIDE_FRACTION = 0.5; // buildings with less of their footprint inside CROP are dropped
const SIMPLIFY_LINE = 0.25; // m, Douglas-Peucker tolerance for roads, paths and waterways
const SIMPLIFY_AREA = 0.3; // m, for water, parks, parking and bridge outlines
const SIMPLIFY_BUILDING = 0.1; // m, only removes near-collinear vertices
const SIZE_TARGET = 3 * 1024 * 1024; // bytes, warn above this
const LANE_WIDTH = 3.2; // m, used with lanes=* for the overlap report
/** Half widths (m, centre line to kerb) by highway=* when lanes=* is missing. Only used by the overlap report. */
const ROAD_HALF_WIDTH = { motorway: 7, trunk: 6, primary: 5.5, secondary: 5, tertiary: 4.5, unclassified: 3.5, residential: 3.5, living_street: 3, road: 3.5, busway: 3.5 };
const OVERLAP_REPORT_MIN = 1.0; // m a building must reach into a road's half width to be reported
const SIDEWALK_SEARCH = 14; // m from a road centre line to look for separately mapped sidewalks
const SIDEWALK_MIN_COVER = 0.3; // fraction of a road's length that must have a footway nearby
const SIDEWALK_REPORT_MIN_LEN = 40; // m, shorter untagged roads are not reported
const TOWPATH_DIST = 25; // m from the canal for a path to count as towpath
const TOWPATH_MIN_FRACTION = 0.6; // fraction of a path's length that must be that close
const TOWPATH_MIN_LEN = 40; // m
const LAND_CELL = 4; // m, evidence grid used to tell which side of a cut shoreline is inside
/** m, probe offsets either side of a cut shoreline: every 4 m up to 39 m, then every 8 m up to 135 m. */
const LAND_PROBE = [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 47, 55, 63, 71, 79, 87, 95, 103, 111, 119, 127, 135];
const LAND_FAR = 160; // m, distance used when a probe finds nothing
const WATERLINE_BONUS = 100; // score for finding a river/canal centre line before any land on one side
const GUESSED_AREA_WARN = 0.6; // flag a guessed area that covers more than this fraction of the crop

// =================================================================================================== tags
const ROAD_TYPES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road', 'busway']);
const FOOT_TYPES = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway', 'track']);
/** Roads checked by the sidewalk and overlap reports (not service roads, tracks or freeways). */
const STREET_TYPES = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
  'tertiary_link', 'unclassified', 'residential', 'living_street', 'road', 'busway']);
const WATERWAY_LINES = new Set(['river', 'canal', 'stream', 'ditch', 'drain', 'brook']);
const PARK_TAGS = {
  leisure: new Set(['park', 'garden', 'playground', 'pitch', 'recreation_ground', 'nature_reserve', 'common', 'dog_park', 'golf_course']),
  landuse: new Set(['grass', 'recreation_ground', 'meadow', 'village_green', 'forest', 'cemetery', 'flowerbed']),
  natural: new Set(['wood', 'scrub', 'grassland', 'heath']),
};
/** Water kinds whose real names are kept (natural geography; a fountain or pond may be named after a property). */
const NAMED_WATER = new Set(['river', 'canal', 'stream', 'lake', 'reservoir', 'lock', 'bay', 'sea', 'oxbow', 'lagoon']);
/** Public places whose real names are kept (they are geography, not businesses). */
const NAMED_PARKS = new Set(['leisure=park', 'leisure=nature_reserve', 'leisure=recreation_ground', 'leisure=common', 'landuse=cemetery', 'landuse=recreation_ground']);
const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare', 'historic'];
/** Values of POI keys that are not places to visit (areas handled elsewhere, street furniture, noise). */
const NOT_POI = {
  shop: new Set(['vacant', 'disused']),
  amenity: new Set(['parking', 'parking_space', 'parking_entrance', 'motorcycle_parking', 'bicycle_parking', 'bench', 'waste_basket',
    'waste_disposal', 'recycling', 'post_box', 'telephone', 'drinking_water', 'fountain', 'vending_machine', 'bicycle_rental',
    'charging_station', 'shelter', 'clock', 'loading_dock', 'grit_bin', 'bbq', 'hunting_stand', 'grave_yard', 'compressed_air',
    'letter_box', 'smoking_area', 'water_point', 'kick-scooter_rental', 'device_charging_station', 'dog_toilet']),
  leisure: new Set(['park', 'garden', 'playground', 'pitch', 'recreation_ground', 'nature_reserve', 'common', 'dog_park', 'golf_course',
    'picnic_table', 'track', 'swimming_pool', 'outdoor_seating', 'firepit', 'bleachers']),
  tourism: new Set(['information', 'artwork', 'picnic_site']),
  historic: new Set(['building', 'district', 'yes', 'house', 'heritage']),
};
/** Street furniture and small details, written to props as [x, z, kind]. First match wins. */
const PROP_KINDS = [
  ['highway', 'traffic_signals', 'signals'], ['highway', 'stop', 'stop'], ['highway', 'crossing', 'crossing'],
  ['highway', 'bus_stop', 'bus_stop'], ['highway', 'street_lamp', 'lamp'], ['natural', 'tree', 'tree'],
  ['amenity', 'bench', 'bench'], ['amenity', 'waste_basket', 'bin'], ['amenity', 'bicycle_parking', 'bike_rack'],
  ['amenity', 'bicycle_rental', 'bike_dock'], ['amenity', 'fountain', 'fountain'], ['amenity', 'drinking_water', 'water_tap'],
  ['amenity', 'post_box', 'post_box'], ['amenity', 'telephone', 'phone'], ['amenity', 'vending_machine', 'vending'],
  ['amenity', 'charging_station', 'charger'], ['amenity', 'parking_entrance', 'parking_entrance'], ['tourism', 'information', 'info'],
  ['tourism', 'artwork', 'artwork'], ['waterway', 'lock_gate', 'lock_gate'], ['man_made', 'flagpole', 'flagpole'],
  ['leisure', 'picnic_table', 'picnic_table'],
];
/** Names on service roads, paths and bridge outlines are kept only if they look like a street or trail name. */
const STREET_WORD = /\b(street|st|place|pl|alley|aly|avenue|ave|road|rd|lane|ln|court|ct|way|drive|dr|terrace|ter|circle|cir|parkway|pkwy|freeway|fwy|expressway|bridge|row|walk|mews|trail|towpath|path|steps|boulevard|blvd|highway|hwy|square|sq|crescent|close|esplanade|promenade|tunnel|ramp|nw|ne|sw|se)\b/i;

// =================================================================================================== main
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`importOsm: ${e?.stack ?? e}`);
    process.exit(1);
  });
}

function die(msg) {
  console.error(`importOsm: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { input: null, out: DEFAULT_OUT, overpass: false, overpassUrl: OVERPASS_URL, printQuery: false, reportJson: null, reportLimit: 25, crop: { ...CROP }, simplify: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : die(`${s} needs a value`));
    if (s === '--out' || s === '-o') a.out = val();
    else if (s === '--overpass') a.overpass = true;
    else if (s === '--overpass-url') a.overpassUrl = val();
    else if (s === '--print-query') a.printQuery = true;
    else if (s === '--report-json') a.reportJson = val();
    else if (s === '--report-limit') a.reportLimit = Math.max(0, Number(val()) || 0);
    else if (s === '--simplify') a.simplify = Math.max(0, Number(val()) || 0) || null;
    else if (s === '--crop') {
      const v = val().split(',').map(Number);
      if (v.length !== 4 || v.some((n) => !Number.isFinite(n)) || v[0] >= v[2] || v[1] >= v[3]) die('--crop wants minlon,minlat,maxlon,maxlat');
      a.crop = { minlon: v[0], minlat: v[1], maxlon: v[2], maxlat: v[3] };
    } else if (s === '-h' || s === '--help') a.help = true;
    else if (s.startsWith('-')) die(`unknown option ${s} (try --help)`);
    else if (!a.input) a.input = s;
    else die(`unexpected argument ${s}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (args.printQuery) {
    console.log(overpassQuery(BBOX));
    return;
  }
  const c = args.crop;
  if (c.minlon < BBOX.minlon || c.maxlon > BBOX.maxlon || c.minlat < BBOX.minlat || c.maxlat > BBOX.maxlat) {
    console.warn('warning: CROP reaches outside BBOX; ways near the crop edge may be incomplete in the download.');
  }

  let input = args.input;
  if (!input) input = !existsSync(DEFAULT_IN) && existsSync(`${DEFAULT_IN}.gz`) ? `${DEFAULT_IN}.gz` : DEFAULT_IN;
  if (args.overpass) await fetchOverpass(args.overpassUrl, input);
  if (!existsSync(input)) {
    const b = BBOX;
    die(`no OSM file at ${input}.
  Download https://overpass-api.de/api/map?bbox=${b.minlon},${b.minlat},${b.maxlon},${b.maxlat}
  and save it as ${DEFAULT_IN} (see data/osm/README.md), or run with --overpass.`);
  }

  const t0 = performance.now();
  const osm = await parseOsmFile(input);
  const tParse = performance.now();
  if (osm.n === 0) die(`${input} has no <node> elements; is it OSM XML?`);
  // Convert; if the file comes out over the size target, simplify harder (up to 4x) before giving up with a warning.
  let res, text;
  for (const k of args.simplify ? [args.simplify] : [1, 2, 4]) {
    res = convert(osm, args.crop, input, k);
    text = toJson(res.doc);
    if (Buffer.byteLength(text) <= SIZE_TARGET) break;
  }
  const tConvert = performance.now();

  mkdirSync(dirname(args.out) || '.', { recursive: true });
  writeFileSync(args.out, text);
  if (args.reportJson) {
    mkdirSync(dirname(args.reportJson) || '.', { recursive: true });
    writeFileSync(args.reportJson, JSON.stringify(res.report, null, 1));
  }
  printReport({ input, out: args.out, osm, res, bytes: Buffer.byteLength(text), inBytes: statSync(input).size, tParse: tParse - t0, tConvert: tConvert - tParse, limit: args.reportLimit });
}

// =============================================================================================== overpass
function overpassQuery(b) {
  const box = `${b.minlat},${b.minlon},${b.maxlat},${b.maxlon}`;
  // Ways and POI nodes with any tag the importer reads; multipolygon relations touching the box, but only their
  // member ways inside the box (the whole Potomac relation would be enormous); then every node of those ways.
  return `[out:xml][timeout:300];
way[~"^(highway|building|amenity|shop|tourism|leisure|office|craft|healthcare|historic|landuse|natural|waterway|water|man_made|bridge|area:highway)$"~"."](${box})->.tagged;
rel[type=multipolygon](${box})->.mp;
way(r.mp)(${box})->.mpways;
(.tagged; .mpways;)->.ways;
(
  node(w.ways);
  node[~"^(amenity|shop|tourism|leisure|office|craft|healthcare|historic|highway|natural|man_made|waterway)$"~"."](${box});
)->.nodes;
.nodes out body qt;
.ways out body qt;
.mp out body qt;
`;
}

async function fetchOverpass(url, dest) {
  console.log(`Fetching ${BBOX.minlon},${BBOX.minlat},${BBOX.maxlon},${BBOX.maxlat} from ${url} (can take a minute) ...`);
  const help = `Download it by hand instead: https://overpass-api.de/api/map?bbox=${BBOX.minlon},${BBOX.minlat},${BBOX.maxlon},${BBOX.maxlat}
  and save it as ${dest} (see data/osm/README.md). Behind a proxy, Node 22.21+ needs NODE_USE_ENV_PROXY=1.`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'open-city-osm-importer/1.0' },
      body: `data=${encodeURIComponent(overpassQuery(BBOX))}`,
      signal: AbortSignal.timeout(420_000),
    });
  } catch (e) {
    die(`could not reach Overpass: ${e?.cause?.message ?? e?.message ?? e}\n  ${help}`);
  }
  const body = await res.text();
  if (!res.ok) die(`Overpass answered HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300).replace(/\s+/g, ' ')}\n  ${help}`);
  if (!body.includes('<osm')) die(`Overpass did not return OSM XML: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
  const remark = body.match(/<remark>([\s\S]*?)<\/remark>/);
  if (remark && /error|timed out|out of memory/i.test(remark[1])) die(`Overpass failed: ${remark[1].trim()}\n  ${help}`);
  mkdirSync(dirname(dest) || '.', { recursive: true });
  writeFileSync(dest, dest.endsWith('.gz') ? gzipSync(body) : body);
  console.log(`Saved ${(Buffer.byteLength(body) / 1048576).toFixed(1)} MB to ${dest}`);
}

// ================================================================================================== parse
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}
const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function attrs(s) {
  const o = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s))) o[m[1]] = m[2] ?? m[3];
  return o;
}

/** Streams OSM XML (optionally gzipped) into flat node arrays plus way and relation lists. */
async function parseOsmFile(path) {
  const magic = Buffer.alloc(2);
  const fd = openSync(path, 'r');
  readSync(fd, magic, 0, 2, 0);
  closeSync(fd);
  let stream = createReadStream(path, { highWaterMark: 1 << 20 });
  if (magic[0] === 0x1f && magic[1] === 0x8b) stream = stream.pipe(createGunzip());

  const osm = {
    index: new Map(), lat: new Float64Array(1 << 16), lon: new Float64Array(1 << 16), n: 0,
    nodeTags: new Map(), ways: [], rels: [], bounds: null, osmBase: null, generator: null, remarks: [],
  };
  const addNode = (id, lat, lon) => {
    if (osm.n === osm.lat.length) {
      const la = new Float64Array(osm.n * 2), lo = new Float64Array(osm.n * 2);
      la.set(osm.lat);
      lo.set(osm.lon);
      osm.lat = la;
      osm.lon = lo;
    }
    osm.index.set(id, osm.n);
    osm.lat[osm.n] = lat;
    osm.lon[osm.n] = lon;
    osm.n++;
  };

  let cur = null; // element being read
  const finish = () => {
    if (cur && !cur.skip) {
      if (cur.kind === 'n') {
        if (cur.tags) osm.nodeTags.set(cur.id, cur.tags);
      } else if (cur.kind === 'w') osm.ways.push(cur);
      else osm.rels.push(cur);
    }
    cur = null;
  };
  const deleted = (a) => a.action === 'delete' || a.visible === 'false';
  let remarkStart = -1;
  const onTag = (close, name, attrStr, buf, start, end) => {
    if (close) {
      if (name === 'node' || name === 'way' || name === 'relation') finish();
      else if (name === 'remark' && remarkStart >= 0) osm.remarks.push(decodeXml(buf.slice(remarkStart, start).trim()));
      return;
    }
    const self = attrStr.endsWith('/');
    switch (name) {
      case 'node': {
        const a = attrs(attrStr);
        if (deleted(a)) cur = { skip: true };
        else {
          const id = Number(a.id);
          addNode(id, Number(a.lat), Number(a.lon));
          cur = { kind: 'n', id, tags: null };
        }
        if (self) finish();
        break;
      }
      case 'way': {
        const a = attrs(attrStr);
        cur = deleted(a) ? { skip: true } : { kind: 'w', id: Number(a.id), refs: [], tags: {} };
        if (self) finish();
        break;
      }
      case 'relation': {
        const a = attrs(attrStr);
        cur = deleted(a) ? { skip: true } : { kind: 'r', id: Number(a.id), members: [], tags: {} };
        if (self) finish();
        break;
      }
      case 'nd':
        if (cur?.refs) cur.refs.push(Number(attrs(attrStr).ref));
        break;
      case 'member':
        if (cur?.members) {
          const a = attrs(attrStr);
          cur.members.push({ type: a.type, ref: Number(a.ref), role: decodeXml(a.role ?? '') });
        }
        break;
      case 'tag':
        if (cur && !cur.skip) {
          const a = attrs(attrStr);
          if (a.k == null) break;
          if (!cur.tags) cur.tags = {};
          cur.tags[decodeXml(a.k)] = decodeXml(a.v ?? '');
        }
        break;
      case 'bounds': {
        const a = attrs(attrStr);
        osm.bounds = { minlon: +a.minlon, minlat: +a.minlat, maxlon: +a.maxlon, maxlat: +a.maxlat };
        break;
      }
      case 'meta':
        osm.osmBase = attrs(attrStr).osm_base ?? osm.osmBase;
        break;
      case 'osm':
        osm.generator = attrs(attrStr).generator ?? null;
        break;
      case 'remark':
        remarkStart = self ? -1 : end;
        break;
      default:
    }
  };

  // Quote-aware tag scanner: attribute values may legally contain '>'.
  const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const scan = (final) => {
    TAG_RE.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = TAG_RE.exec(buf))) {
      onTag(m[1] === '/', m[2], m[3], buf, m.index, TAG_RE.lastIndex);
      last = TAG_RE.lastIndex;
    }
    buf = buf.slice(last);
    remarkStart = -1;
    if (!final && buf.length > 4 << 20) throw new Error('XML tag longer than 4 MB; is this OSM XML?');
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    scan(false);
  }
  buf += decoder.decode();
  scan(true);
  if (cur) finish();
  return osm;
}

// ============================================================================================= projection
function makeProjection(crop) {
  const lat0 = (crop.minlat + crop.maxlat) / 2;
  const lon0 = (crop.minlon + crop.maxlon) / 2;
  const p = (lat0 * Math.PI) / 180;
  // Metres per degree on the WGS84 ellipsoid at lat0 (standard series).
  const mLat = 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  return {
    lat0, lon0, mLat, mLon,
    /** lat/lon -> [x east, y north] in metres (internal frame; output flips y to z south). */
    fwd: (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * mLat],
    /** [x, y north] -> [lat, lon] */
    inv: (x, y) => [lat0 + y / mLat, lon0 + x / mLon],
  };
}

// =============================================================================================== geometry
// Internal frame: x east, y north (math orientation, CCW = positive area). Output: z = -y.
const r1 = (v) => Math.round(v * 10) / 10 || 0;
function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function lineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
function distPointSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}
function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function distSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.sqrt(Math.min(distPointSeg2(ax, ay, cx, cy, dx, dy), distPointSeg2(bx, by, cx, cy, dx, dy), distPointSeg2(cx, cy, ax, ay, bx, by), distPointSeg2(dx, dy, ax, ay, bx, by)));
}
/** Calls fn(x, y, ux, uy) every `step` metres along a polyline (ux, uy = unit direction). */
function sampleLine(pts, step, fn) {
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const dx = pts[i][0] - ax, dy = pts[i][1] - ay;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const ux = dx / L, uy = dy / L;
    let s = carry;
    for (; s < L; s += step) fn(ax + ux * s, ay + uy * s, ux, uy);
    carry = s - L;
  }
}
/**
 * Douglas-Peucker. Vertices flagged with p[2] === 1 (junctions shared by several ways) are always kept.
 * For closed rings (no repeated last point) the ring is split at its farthest vertex pair.
 */
function simplify(pts, tol, closed) {
  if (tol <= 0 || pts.length < (closed ? 5 : 3)) return pts;
  if (!closed && pts.some((p, i) => p[2] === 1 && i > 0 && i < pts.length - 1)) {
    const out = [pts[0]];
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      if (i < pts.length - 1 && pts[i][2] !== 1) continue;
      const s = simplify(pts.slice(start, i + 1).map((p) => [p[0], p[1]]), tol, false);
      for (let k = 1; k < s.length; k++) out.push(s[k]);
      start = i;
    }
    return out;
  }
  if (closed) {
    let far = 0, best = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    const a = simplify(pts.slice(0, far + 1), tol, false);
    const b = simplify([...pts.slice(far), pts[0]], tol, false);
    const out = a.concat(b.slice(1, -1));
    return out.length >= 3 ? out : pts;
  }
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const t2 = tol * tol;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distPointSeg2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > t2) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ----------------------------------------------------------------------------------------- rect clipping
const EDGE_EPS = 1e-6;
const inRect = (p, r) => p[0] >= r.x0 - EDGE_EPS && p[0] <= r.x1 + EDGE_EPS && p[1] >= r.y0 - EDGE_EPS && p[1] <= r.y1 + EDGE_EPS;
const onEdge = (p, r) => inRect(p, r) && (Math.abs(p[0] - r.x0) < EDGE_EPS || Math.abs(p[0] - r.x1) < EDGE_EPS || Math.abs(p[1] - r.y0) < EDGE_EPS || Math.abs(p[1] - r.y1) < EDGE_EPS);
const clampPt = (x, y, r) => [Math.min(r.x1, Math.max(r.x0, x)), Math.min(r.y1, Math.max(r.y0, y))];

/** Liang-Barsky: parameter range [t0, t1] of segment a-b inside the rect, or null. */
function clipSeg(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const P = [-dx, dx, -dy, dy], Q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) {
      if (Q[i] < 0) return null;
    } else {
      const t = Q[i] / P[i];
      if (P[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}
/** Clips a polyline to the rect: returns the pieces inside. Cut points lie exactly on the rect edge. */
function clipPolyline(pts, r) {
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = clipSeg(a[0], a[1], b[0], b[1], r);
    if (!c) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const [t0, t1] = c;
    const pa = t0 <= 0 ? a : clampPt(a[0] + t0 * (b[0] - a[0]), a[1] + t0 * (b[1] - a[1]), r);
    const pb = t1 >= 1 ? b : clampPt(a[0] + t1 * (b[0] - a[0]), a[1] + t1 * (b[1] - a[1]), r);
    if (cur && t0 > 0) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = [pa];
    cur.push(pb);
    if (t1 < 1) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.length >= 2 && lineLength(p) > 0.01);
}
/** Sutherland-Hodgman clip of a ring to the rect (used for area fractions). */
function clipRingSH(ring, r) {
  let out = ring;
  const planes = [[0, r.x0, 1], [0, r.x1, -1], [1, r.y0, 1], [1, r.y1, -1]];
  for (const [ax, v, s] of planes) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const p = inp[i], q = inp[(i + 1) % inp.length];
      const pin = (p[ax] - v) * s >= 0, qin = (q[ax] - v) * s >= 0;
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (v - p[ax]) / (q[ax] - p[ax]);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    if (!out.length) break;
  }
  return out;
}
function nearestEdgePoint(p, r) {
  const [x, y] = clampPt(p[0], p[1], r);
  const d = [x - r.x0, r.x1 - x, y - r.y0, r.y1 - y];
  const i = d.indexOf(Math.min(...d));
  return i === 0 ? [r.x0, y] : i === 1 ? [r.x1, y] : i === 2 ? [x, r.y0] : [x, r.y1];
}
/** Position of a rect-edge point along the perimeter, counter-clockwise from the south-west corner. */
function perimT(p, r) {
  const W = r.x1 - r.x0, H = r.y1 - r.y0, P = 2 * (W + H);
  let t;
  if (Math.abs(p[1] - r.y0) < EDGE_EPS) t = p[0] - r.x0;
  else if (Math.abs(p[0] - r.x1) < EDGE_EPS) t = W + (p[1] - r.y0);
  else if (Math.abs(p[1] - r.y1) < EDGE_EPS) t = W + H + (r.x1 - p[0]);
  else t = 2 * W + H + (r.y1 - p[1]);
  return ((t % P) + P) % P;
}
/**
 * Joins boundary-to-boundary pieces (each with the polygon's interior on its LEFT) into closed rings by walking
 * counter-clockwise along the rect from each exit to the next entry. This is how coastline tools close land/water
 * polygons that are cut by a bounding box.
 */
function closePieces(pieces, r) {
  const W = r.x1 - r.x0, H = r.y1 - r.y0, P = 2 * (W + H);
  const corners = [[W, [r.x1, r.y0]], [W + H, [r.x1, r.y1]], [2 * W + H, [r.x0, r.y1]], [P, [r.x0, r.y0]]];
  const items = pieces.map((pts) => ({ pts, tIn: perimT(pts[0], r), tOut: perimT(pts[pts.length - 1], r), used: false }));
  const rings = [];
  for (const start of items) {
    if (start.used) continue;
    start.used = true;
    const ring = start.pts.slice();
    let cur = start;
    for (let guard = 0; guard <= items.length; guard++) {
      let best = null, bestD = Infinity;
      for (const it of items) {
        if (it.used && it !== start) continue;
        const d = (((it.tIn - cur.tOut) % P) + P) % P;
        if (d < bestD - 1e-9) { bestD = d; best = it; }
      }
      const walk = [];
      for (const [ct, pt] of corners) {
        let c = ct;
        while (c <= cur.tOut + 1e-9) c += P;
        if (c < cur.tOut + bestD - 1e-9) walk.push([c, pt]);
      }
      walk.sort((a, b) => a[0] - b[0]);
      for (const [, pt] of walk) ring.push(pt);
      if (best === start) break;
      best.used = true;
      for (const p of best.pts) ring.push(p);
      cur = best;
    }
    rings.push(dedupeRing(ring));
  }
  return rings;
}
function dedupeRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-7) out.pop();
  return out;
}
const rectRing = (r) => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];

/**
 * Clips an area (outer/inner rings, closed or not) to the rect and returns [{outer, holes}].
 * Closed rings know their inside. Open chains (multipolygons cut by the download box) need `orient(piecesOfChain)`
 * returning >0 if the area lies to the LEFT of the chain's direction, <0 if to the right, 0 if unknown;
 * without it, open chains are dropped. `issues` collects problems for the report.
 */
function clipArea(rings, r, orient, issues, label) {
  const pieces = [], insideOuter = [], insideHoles = [];
  let allClosed = true;
  for (const ring of rings) {
    if (ring.closed) {
      let pts = ring.pts;
      if (pts.length < 3) continue;
      const a = signedArea(pts);
      if (ring.role === 'inner' ? a > 0 : a < 0) pts = pts.slice().reverse();
      if (pts.every((p) => inRect(p, r))) {
        (ring.role === 'inner' ? insideHoles : insideOuter).push(pts);
        continue;
      }
      const segs = clipPolyline([...pts, pts[0]], r);
      if (segs.length > 1) {
        const first = segs[0], last = segs[segs.length - 1];
        if (!onEdge(first[0], r) && !onEdge(last[last.length - 1], r)) {
          segs[0] = last.concat(first.slice(1));
          segs.pop();
        }
      }
      pieces.push(...segs);
    } else {
      allClosed = false;
      if (!orient) {
        issues.push({ kind: 'open-ring-dropped', id: label, where: ring.pts[0] });
        continue;
      }
      const segs = clipPolyline(ring.pts, r).map((s) => {
        if (!onEdge(s[0], r)) {
          issues.push({ kind: 'dangling-ring-end', id: label, where: s[0] });
          s = [nearestEdgePoint(s[0], r), ...s];
        }
        if (!onEdge(s[s.length - 1], r)) {
          issues.push({ kind: 'dangling-ring-end', id: label, where: s[s.length - 1] });
          s = [...s, nearestEdgePoint(s[s.length - 1], r)];
        }
        return s;
      });
      if (!segs.length) continue;
      const o = orient(segs);
      if (o === 0) issues.push({ kind: 'inside-unknown (no evidence either side; check it)', id: label, where: segs[0][0] });
      for (const s of segs) pieces.push(o < 0 ? s.slice().reverse() : s);
    }
  }
  const outers = [...insideOuter];
  for (let ring of closePieces(pieces, r)) {
    if (ring.length < 3) continue;
    if (signedArea(ring) < 0) {
      issues.push({ kind: 'ring-orientation', id: label, where: ring[0] });
      ring = ring.reverse();
    }
    outers.push(ring);
  }
  if (!pieces.length && allClosed && rings.length) {
    // No boundary crosses the crop: the crop is either fully outside or fully inside the area.
    const c = [r.x0, r.y0];
    let inside = false;
    for (const ring of rings) if (ring.closed && pointInRing(c[0], c[1], ring.pts)) inside = !inside;
    if (inside) outers.push(rectRing(r));
  }
  const polys = outers.filter((o) => signedArea(o) > 0.5).map((outer) => ({ outer, holes: [] }));
  for (const h of insideHoles) {
    let best = null, bestA = Infinity;
    for (const p of polys) {
      if (!pointInRing(h[0][0], h[0][1], p.outer)) continue;
      const a = signedArea(p.outer);
      if (a < bestA) { bestA = a; best = p; }
    }
    if (best) best.holes.push(h);
  }
  return polys;
}

// ----------------------------------------------------------------------------------------- spatial grids
class CellSet {
  constructor(size) { this.size = size; this.set = new Set(); }
  key(ix, iy) { return (ix + 1048576) * 2097152 + (iy + 1048576); }
  add(x, y) { this.set.add(this.key(Math.floor(x / this.size), Math.floor(y / this.size))); }
  has(x, y) { return this.set.has(this.key(Math.floor(x / this.size), Math.floor(y / this.size))); }
}
class SegGrid {
  constructor(size) { this.size = size; this.cells = new Map(); this.segs = []; this.stamp = 0; this.seen = []; }
  key(ix, iy) { return (ix + 1048576) * 2097152 + (iy + 1048576); }
  addLine(pts, data) {
    for (let i = 1; i < pts.length; i++) {
      const s = { ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], data };
      const idx = this.segs.push(s) - 1;
      this.seen.push(0);
      const x0 = Math.floor(Math.min(s.ax, s.bx) / this.size), x1 = Math.floor(Math.max(s.ax, s.bx) / this.size);
      const y0 = Math.floor(Math.min(s.ay, s.by) / this.size), y1 = Math.floor(Math.max(s.ay, s.by) / this.size);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const k = this.key(ix, iy);
          const list = this.cells.get(k);
          if (list) list.push(idx);
          else this.cells.set(k, [idx]);
        }
      }
    }
  }
  /** Calls fn(seg) once for every segment whose cells overlap the box. */
  query(minx, miny, maxx, maxy, fn) {
    const st = ++this.stamp;
    const x0 = Math.floor(minx / this.size), x1 = Math.floor(maxx / this.size);
    const y0 = Math.floor(miny / this.size), y1 = Math.floor(maxy / this.size);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === st) continue;
          this.seen[i] = st;
          if (fn(this.segs[i]) === false) return;
        }
      }
    }
  }
  /** True if any segment lies within d of (x, y). */
  near(x, y, d) {
    let hit = false;
    const d2 = d * d;
    this.query(x - d, y - d, x + d, y + d, (s) => {
      if (distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by) <= d2) { hit = true; return false; }
      return true;
    });
    return hit;
  }
}

// =========================================================================================== tag helpers
const isNo = (v) => v == null || v === 'no' || v === 'false' || v === '0';
function parseLength(v) {
  if (v == null) return NaN;
  const s = String(v).trim().toLowerCase().replace(',', '.');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''))?$/);
  if (m) return Number(m[1]) * 0.3048 + (m[2] ? Number(m[2]) * 0.0254 : 0);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|foot)?$/);
  if (!m) return NaN;
  return m[2] && m[2][0] === 'f' ? Number(m[1]) * 0.3048 : Number(m[1]);
}
function parseSpeedKmh(v) {
  if (v == null) return null;
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === 'mph' ? n * 1.609344 : m[2] === 'knots' ? n * 1.852 : n);
}
function parseOneway(t) {
  const v = t.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no' || v === 'false' || v === '0' || v === 'reversible' || v === 'alternating') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return 1;
  return 0;
}
function sidewalkOf(t) {
  if (t.sidewalk) return t.sidewalk;
  const b = t['sidewalk:both'], l = t['sidewalk:left'], rr = t['sidewalk:right'];
  if (b) return b === 'yes' ? 'both' : b;
  const L = l && !isNo(l) && l !== 'none', R = rr && !isNo(rr) && rr !== 'none';
  if (L && R) return l === 'separate' && rr === 'separate' ? 'separate' : 'both';
  if (L) return l === 'separate' ? 'separate' : 'left';
  if (R) return rr === 'separate' ? 'separate' : 'right';
  if (l || rr) return 'no';
  return null;
}
const firstToken = (v) => (v == null ? null : String(v).split(';')[0].trim() || null);
function poiCategory(t) {
  for (const k of POI_KEYS) {
    const v = t[k];
    if (!v || v === 'no') continue;
    if (NOT_POI[k]?.has(v)) continue;
    if (k === 'tourism' && v === 'information' && t.information !== 'office') continue;
    return `${k}=${v}`;
  }
  return null;
}
function parkKind(t) {
  for (const k of ['leisure', 'landuse', 'natural']) if (t[k] && PARK_TAGS[k].has(t[k])) return `${k}=${t[k]}`;
  return null;
}
function waterKind(t) {
  if (t.natural === 'water') return t.water || 'water';
  if (t.waterway === 'riverbank') return 'river';
  if (t.waterway === 'dock') return 'dock';
  if (t.landuse === 'reservoir' || t.landuse === 'basin') return t.landuse;
  return null;
}
function buildingHeight(t) {
  const h = parseLength(t.height ?? t['building:height']);
  if (h > 0) return { h, src: 'height' };
  const lv = Number.parseFloat(t['building:levels']);
  const rl = Number.parseFloat(t['roof:levels']);
  if (lv > 0) return { h: lv * LEVEL_HEIGHT + (rl > 0 ? rl * ROOF_LEVEL_HEIGHT : 0), src: 'levels' };
  return { h: BUILDING_TYPE_HEIGHT[t.building] ?? DEFAULT_BUILDING_HEIGHT, src: 'estimate' };
}
const streetName = (name) => (name && STREET_WORD.test(name) ? name : null);

// ================================================================================================ convert
function convert(osm, crop, inputPath, k = 1) {
  const proj = makeProjection(crop);
  const [cx0, cy0] = proj.fwd(crop.minlat, crop.minlon);
  const [cx1, cy1] = proj.fwd(crop.maxlat, crop.maxlon);
  const rect = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };

  // Project every node once.
  const X = new Float64Array(osm.n), Y = new Float64Array(osm.n);
  for (let i = 0; i < osm.n; i++) {
    const [x, y] = proj.fwd(osm.lat[i], osm.lon[i]);
    X[i] = x;
    Y[i] = y;
  }
  const stats = { missingNodes: 0, missingMembers: 0, namesDropped: 0, buildingsOutside: 0, buildingsTiny: 0, buildingsUnderground: 0, heightSrc: { height: 0, levels: 0, estimate: 0 } };
  const issues = [];
  // Nodes shared by several highway ways (or visited twice by one) are junctions: simplification keeps them, so
  // every road or path through a junction has a vertex with identical coordinates there (graph = match coordinates).
  const junction = new Set();
  {
    const seen = new Set();
    for (const w of osm.ways) {
      if (!ROAD_TYPES.has(w.tags.highway) && !FOOT_TYPES.has(w.tags.highway)) continue;
      const n = w.refs.length - (w.refs.length > 1 && w.refs[0] === w.refs[w.refs.length - 1] ? 1 : 0);
      for (let j = 0; j < n; j++) {
        const ref = w.refs[j];
        if (seen.has(ref)) junction.add(ref);
        else seen.add(ref);
      }
    }
  }
  const refsToPts = (refs, flagJunctions = false) => {
    const pts = [];
    for (const ref of refs) {
      const i = osm.index.get(ref);
      if (i === undefined) { stats.missingNodes++; continue; }
      const p = flagJunctions && junction.has(ref) ? [X[i], Y[i], 1] : [X[i], Y[i]];
      const q = pts[pts.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
    }
    return pts;
  };
  const wayById = new Map();
  for (const w of osm.ways) wayById.set(w.id, w);
  const isClosed = (refs) => refs.length >= 4 && refs[0] === refs[refs.length - 1];
  const wayRing = (w) => {
    const pts = refsToPts(w.refs);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts;
  };

  /** Assembles a multipolygon's member ways into rings by joining shared end nodes. */
  const relRings = (rel) => {
    const byRole = { outer: [], inner: [] };
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const w = wayById.get(m.ref);
      if (!w) { stats.missingMembers++; continue; }
      if (w.refs.length < 2) continue;
      byRole[m.role === 'inner' ? 'inner' : 'outer'].push(w.refs);
    }
    const out = [];
    for (const role of ['outer', 'inner']) {
      const open = [];
      for (const refs of byRole[role]) (isClosed(refs) ? out.push({ refs, role, closed: true }) : open.push(refs));
      const ends = new Map();
      const addEnd = (id, i) => { const l = ends.get(id); if (l) l.push(i); else ends.set(id, [i]); };
      open.forEach((refs, i) => { addEnd(refs[0], i); addEnd(refs[refs.length - 1], i); });
      const used = new Uint8Array(open.length);
      for (let i = 0; i < open.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        let chain = open[i].slice();
        for (let grown = true; grown && chain[0] !== chain[chain.length - 1];) {
          grown = false;
          const tail = chain[chain.length - 1];
          for (const j of ends.get(tail) ?? []) {
            if (used[j]) continue;
            used[j] = 1;
            grown = true;
            const c = open[j];
            chain = chain.concat(c[0] === tail ? c.slice(1) : c.slice(0, -1).reverse());
            break;
          }
          if (grown) continue;
          const head = chain[0];
          for (const j of ends.get(head) ?? []) {
            if (used[j]) continue;
            used[j] = 1;
            grown = true;
            const c = open[j];
            chain = (c[c.length - 1] === head ? c.slice(0, -1) : c.slice(1).reverse()).concat(chain);
            break;
          }
        }
        out.push({ refs: chain, role, closed: isClosed(chain) });
      }
    }
    return out.map((r) => {
      const pts = refsToPts(r.refs);
      if (r.closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      return { pts, role: r.role, closed: r.closed && pts.length >= 3 };
    });
  };
  const multipolygons = osm.rels.filter((r) => r.tags.type === 'multipolygon');
  /** Every area feature as {id, tags, rings}: closed ways and multipolygon relations. */
  const areas = [];
  for (const w of osm.ways) if (isClosed(w.refs)) areas.push({ id: `w${w.id}`, tags: w.tags, rings: null, way: w });
  for (const r of multipolygons) areas.push({ id: `r${r.id}`, tags: r.tags, rings: null, rel: r });
  const ringsOf = (a) => (a.rings ??= a.way ? [{ pts: wayRing(a.way), role: 'outer', closed: true }] : relRings(a.rel));

  // ---------------------------------------------------------------- output helpers (y north -> z south)
  const outLine = (pts, tol) => {
    const s = simplify(pts, tol, false);
    const o = [];
    for (const p of s) {
      const q = [r1(p[0]), r1(-p[1])];
      const l = o[o.length - 1];
      if (!l || l[0] !== q[0] || l[1] !== q[1]) o.push(q);
    }
    return o.length >= 2 ? o : null;
  };
  const outRing = (pts, tol) => {
    const o = outLine(simplify(pts, tol, true), 0);
    if (!o) return null;
    while (o.length > 1 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]) o.pop();
    return o.length >= 3 ? o : null;
  };
  const outPoly = (poly, tol) => {
    const pts = outRing(poly.outer, tol);
    if (!pts) return null;
    const holes = poly.holes.map((h) => outRing(h, tol)).filter(Boolean);
    return holes.length ? { pts, holes } : { pts };
  };
  const latlon = (x, y) => {
    const [la, lo] = proj.inv(x, y);
    return [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6];
  };

  // ---------------------------------------------------------------- roads and footways
  const roads = [], footways = [], bridges = [];
  const roadPieces = []; // internal-frame pieces for the reports
  const footPieces = [];
  for (const w of osm.ways) {
    const t = w.tags;
    const hw = t.highway;
    if (!hw) continue;
    const isRoad = ROAD_TYPES.has(hw);
    const isFoot = FOOT_TYPES.has(hw);
    if (!isRoad && !isFoot) continue;
    const id = `w${w.id}`;
    const bridge = !isNo(t.bridge) ? 1 : 0;
    const tunnel = !isNo(t.tunnel) ? 1 : 0;
    const layer = Math.max(-5, Math.min(5, Number.parseInt(t.layer, 10) || 0));
    if (isFoot && hw === 'pedestrian' && t.area === 'yes' && isClosed(w.refs)) {
      const polys = clipArea([{ pts: wayRing(w), role: 'outer', closed: true }], rect, null, issues, id);
      polys.forEach((p, i) => {
        const o = outPoly(p, SIMPLIFY_AREA * k);
        if (o) footways.push({ id, kind: 'pedestrian', area: 1, name: streetName(t.name), ...(polys.length > 1 ? { part: i } : {}), ...o });
      });
      continue;
    }
    const pieces = clipPolyline(refsToPts(w.refs, true), rect);
    pieces.forEach((pts, i) => {
      const o = outLine(pts, SIMPLIFY_LINE * k);
      if (!o) return;
      const part = pieces.length > 1 ? { part: i } : {};
      if (isRoad) {
        const name = hw === 'service' ? streetName(t.name) : t.name || null;
        const road = {
          id, name, highway: hw, lanes: Number.parseInt(t.lanes, 10) || null, oneway: parseOneway(t), bridge, tunnel, layer,
          junction: t.junction || null, maxspeed: parseSpeedKmh(t.maxspeed), ...part, pts: o,
        };
        const sw = sidewalkOf(t);
        if (sw) road.sidewalk = sw;
        if (t.surface) road.surface = t.surface;
        if (t.service) road.service = t.service;
        if (t.access && t.access !== 'yes') road.access = t.access;
        roads.push(road);
        roadPieces.push({ id, t, pts, layer, bridge, tunnel, name: road.name });
      } else {
        const kind = hw === 'footway' && (t.footway === 'sidewalk' || t.footway === 'crossing') ? t.footway : hw;
        const f = { id, kind, name: streetName(t.name), ...part, pts: o };
        if (bridge) f.bridge = 1;
        if (tunnel) f.tunnel = 1;
        if (layer) f.layer = layer;
        if (t.surface) f.surface = t.surface;
        footways.push(f);
        footPieces.push({ id, f, t, pts, bridge });
      }
      if (bridge) bridges.push({ id, src: isRoad ? 'road' : 'path', name: isRoad && hw !== 'service' ? t.name || null : streetName(t.name), layer, ...part, pts: o });
    });
  }

  // ---------------------------------------------------------------- land evidence (which side of a cut ring is inside)
  // Multipolygons that reach outside the download box arrive as open chains, so their inside is unknown. Water is
  // the side with no roads, paths or buildings nearby; a park is the side with no buildings nearby.
  const land = new CellSet(LAND_CELL);
  const builtUp = new CellSet(LAND_CELL);
  const wet = new CellSet(LAND_CELL); // river and canal centre lines
  for (const w of osm.ways) {
    const t = w.tags;
    const hw = t.highway;
    if (hw && (ROAD_TYPES.has(hw) || FOOT_TYPES.has(hw)) && isNo(t.bridge) && isNo(t.tunnel) && t.man_made !== 'pier' && !(Number.parseInt(t.layer, 10) > 0)) {
      sampleLine(refsToPts(w.refs), 1, (x, y) => land.add(x, y));
    } else if (WATERWAY_LINES.has(t.waterway) && isNo(t.tunnel)) {
      sampleLine(refsToPts(w.refs), 1, (x, y) => wet.add(x, y));
    } else if (t.building && t.building !== 'no' && t.man_made !== 'pier' && isClosed(w.refs)) {
      const ring = wayRing(w);
      if (ring.length >= 3) {
        sampleLine([...ring, ring[0]], 1, (x, y) => { land.add(x, y); builtUp.add(x, y); });
        const c = centroid(ring);
        land.add(c[0], c[1]);
        builtUp.add(c[0], c[1]);
      }
    }
  }
  /**
   * Orientation callback for clipArea: >0 when the area lies to the chain's LEFT. Every 10 m along the chain it
   * looks for the nearest evidence on each side; the inside is the side whose nearest evidence is farther away
   * (so a narrow canal still works: its own bank is metres away, the far bank 15+ m). A river or canal centre line
   * met before any land counts strongly for that side being water.
   */
  const guessed = new Set();
  const emptySide = (grid, wetGrid) => (segs) => {
    const nearest = (g, x, y, nx, ny) => {
      for (const o of LAND_PROBE) if (g.has(x + nx * o, y + ny * o)) return o;
      return LAND_FAR;
    };
    let score = 0;
    for (const s of segs) {
      sampleLine(s, 10, (x, y, ux, uy) => {
        const dl = nearest(grid, x, y, -uy, ux), dr = nearest(grid, x, y, uy, -ux);
        score += dl - dr;
        if (wetGrid) {
          if (nearest(wetGrid, x, y, -uy, ux) < dl) score += WATERLINE_BONUS;
          if (nearest(wetGrid, x, y, uy, -ux) < dr) score -= WATERLINE_BONUS;
        }
      });
    }
    if (score !== 0) {
      issues.push({ kind: 'cut-by-download-box (inside guessed, check it)', id: curArea, where: segs[0][0] });
      guessed.add(curArea);
    }
    return score;
  };
  let curArea = '';
  const waterSide = emptySide(land, wet);
  const parkSide = emptySide(builtUp, null);
  const cropArea = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  const checkGuess = (id, polys) => {
    if (!guessed.has(id)) return;
    const a = polys.reduce((sum, p) => sum + signedArea(p.outer) - p.holes.reduce((h, r) => h + Math.abs(signedArea(r)), 0), 0);
    if (a > GUESSED_AREA_WARN * cropArea) issues.push({ kind: `GUESSED AREA COVERS ${Math.round((100 * a) / cropArea)}% OF THE CROP (likely wrong side)`, id, where: polys[0].outer[0] });
  };

  // ---------------------------------------------------------------- water, parks, parking, bridge areas, buildings
  const water = [], parks = [], parking = [], buildings = [], pois = [];
  const buildingGrid = new SegGrid(25);
  const buildingRings = []; // for the POI-in-building lookup and overlap report
  for (const a of areas) {
    const t = a.tags;
    curArea = a.id;
    const wk = waterKind(t);
    if (wk) {
      const polys = clipArea(ringsOf(a), rect, waterSide, issues, a.id);
      checkGuess(a.id, polys);
      polys.forEach((p, i) => {
        const o = outPoly(p, SIMPLIFY_AREA * k);
        if (o) water.push({ id: a.id, kind: wk, name: NAMED_WATER.has(wk) ? t.name || null : null, ...(polys.length > 1 ? { part: i } : {}), ...o });
      });
    }
    const pk = parkKind(t);
    if (pk) {
      const polys = clipArea(ringsOf(a), rect, parkSide, issues, a.id);
      checkGuess(a.id, polys);
      polys.forEach((p, i) => {
        const o = outPoly(p, SIMPLIFY_AREA * k);
        if (o) parks.push({ id: a.id, kind: pk, name: NAMED_PARKS.has(pk) ? t.name || null : null, ...(polys.length > 1 ? { part: i } : {}), ...o });
      });
    }
    if (t.amenity === 'parking') {
      const polys = clipArea(ringsOf(a), rect, null, issues, a.id);
      polys.forEach((p, i) => {
        const o = outPoly(p, SIMPLIFY_AREA * k);
        if (!o) return;
        const e = { id: a.id, type: t.parking || null, ...(polys.length > 1 ? { part: i } : {}), ...o };
        if (t.access && t.access !== 'yes') e.access = t.access;
        parking.push(e);
      });
    }
    if (t.man_made === 'bridge') {
      const polys = clipArea(ringsOf(a), rect, null, issues, a.id);
      polys.forEach((p, i) => {
        const o = outPoly(p, SIMPLIFY_AREA * k);
        if (o) bridges.push({ id: a.id, src: 'area', name: streetName(t.name), layer: Number.parseInt(t.layer, 10) || 1, ...(polys.length > 1 ? { part: i } : {}), ...o });
      });
    }
    if (t.building && t.building !== 'no') {
      const rings = ringsOf(a);
      const outers = rings.filter((r) => r.role === 'outer' && r.closed);
      const inners = rings.filter((r) => r.role === 'inner' && r.closed);
      if (t.name) stats.namesDropped++;
      if (t.location === 'underground' || Number.parseInt(t.layer, 10) < 0) { stats.buildingsUnderground++; continue; }
      outers.forEach((ring, i) => {
        let outer = ring.pts;
        let area = signedArea(outer);
        if (area < 0) { outer = outer.slice().reverse(); area = -area; }
        if (area < MIN_BUILDING_AREA) { stats.buildingsTiny++; return; }
        const inside = Math.abs(signedArea(clipRingSH(outer, rect))) / area;
        if (inside < MIN_INSIDE_FRACTION) { stats.buildingsOutside++; return; }
        const holes = inners.filter((h) => pointInRing(h.pts[0][0], h.pts[0][1], outer)).map((h) => (signedArea(h.pts) > 0 ? h.pts.slice().reverse() : h.pts));
        const pts = outRing(outer, SIMPLIFY_BUILDING * k);
        if (!pts) return;
        const { h, src } = buildingHeight(t);
        stats.heightSrc[src]++;
        const b = { id: a.id, ...(outers.length > 1 ? { part: i } : {}), h: r1(h), type: t.building };
        const lv = Number.parseFloat(t['building:levels']);
        if (lv > 0) b.levels = lv;
        if (src === 'estimate') b.est = 1;
        b.pts = pts;
        const hs = holes.map((hr) => outRing(hr, SIMPLIFY_BUILDING * k)).filter(Boolean);
        if (hs.length) b.holes = hs;
        buildings.push(b);
        const rec = { id: a.id, ring: outer, t, b, area };
        buildingRings.push(rec);
        buildingGrid.addLine([...outer, outer[0]], rec);
      });
    }
  }

  // ---------------------------------------------------------------- incomplete water (coastline-style)
  const coast = osm.ways.filter((w) => w.tags.natural === 'coastline');
  if (coast.length) {
    // OSM coastlines have land on the left; the joined rings are reversed so the sea is on the left like any area.
    const fake = { id: 'coastline', tags: { natural: 'water', water: 'sea' }, rel: { members: coast.map((w) => ({ type: 'way', ref: w.id, role: 'outer' })) } };
    // Closed coastline rings are islands: reversed they run clockwise, i.e. holes in the sea.
    const rings = relRings(fake.rel).map((r) => ({ ...r, pts: r.pts.slice().reverse(), role: r.closed ? 'inner' : 'outer' }));
    const polys = clipArea(rings, rect, () => 1, issues, 'coastline');
    polys.forEach((p, i) => {
      const o = outPoly(p, SIMPLIFY_AREA * k);
      if (o) water.push({ id: 'coastline', kind: 'sea', name: null, part: i, ...o });
    });
  }

  // ---------------------------------------------------------------- waterways
  const waterways = [];
  const canalGrid = new SegGrid(25);
  for (const w of osm.ways) {
    const t = w.tags;
    if (!WATERWAY_LINES.has(t.waterway)) continue;
    const pieces = clipPolyline(refsToPts(w.refs), rect);
    pieces.forEach((pts, i) => {
      const o = outLine(pts, SIMPLIFY_LINE * k);
      if (!o) return;
      const e = { id: `w${w.id}`, kind: t.waterway, name: t.name || null, ...(pieces.length > 1 ? { part: i } : {}), pts: o };
      if (!isNo(t.tunnel)) e.tunnel = 1;
      waterways.push(e);
      if (t.waterway === 'canal') canalGrid.addLine(pts, e);
    });
  }

  // ---------------------------------------------------------------- POIs and props
  const props = [];
  const buildingAt = (x, y) => {
    let found = null;
    buildingGrid.query(x, y, x, y, (s) => {
      if (pointInRing(x, y, s.data.ring)) { found = s.data; return false; }
      return true;
    });
    return found;
  };
  const addPoi = (id, t, x, y) => {
    if (!inRect([x, y], rect)) return;
    const cat = poiCategory(t);
    if (!cat) return;
    if (t.name || t.brand || t.operator) stats.namesDropped++;
    const p = { id, x: r1(x), z: r1(-y), cat };
    const sub = firstToken(t.cuisine ?? t.religion ?? t.sport ?? null);
    if (sub) p.subcat = sub;
    const b = buildingAt(x, y);
    if (b) p.b = b.id;
    pois.push(p);
  };
  for (const [id, t] of osm.nodeTags) {
    const i = osm.index.get(id);
    const x = X[i], y = Y[i];
    if (!inRect([x, y], rect)) continue;
    let prop = null;
    for (const [key, val, kind] of PROP_KINDS) if (t[key] === val) { prop = kind; break; }
    if (prop) props.push([r1(x), r1(-y), prop]);
    else addPoi(`n${id}`, t, x, y);
  }
  for (const a of areas) {
    if (!poiCategory(a.tags)) continue;
    const outer = ringsOf(a).filter((r) => r.role === 'outer' && r.closed).sort((p, q) => Math.abs(signedArea(q.pts)) - Math.abs(signedArea(p.pts)))[0];
    if (!outer) continue;
    const [x, y] = centroid(outer.pts);
    addPoi(a.id, a.tags, x, y);
  }

  // ---------------------------------------------------------------- landmarks: C&O canal and towpath
  const canalWater = water.filter((w) => w.kind === 'canal' || w.kind === 'lock' || /canal/i.test(w.name ?? ''));
  for (const cw of canalWater) {
    // Polygon outlines count as canal geometry too, for when only the water area is mapped.
    const ring = cw.pts.map(([x, z]) => [x, -z]);
    canalGrid.addLine([...ring, ring[0]], cw);
  }
  // Towpath: paths named "...towpath..."; only if none is named, unnamed paths running along the canal.
  const towpath = [];
  const pathLike = (fp) => !fp.bridge && ['path', 'track', 'footway', 'cycleway', 'bridleway'].includes(fp.f.kind);
  const named = footPieces.filter((fp) => pathLike(fp) && /tow\s*path/i.test(fp.t.name ?? ''));
  const alongCanal = (fp) => {
    if (lineLength(fp.pts) < TOWPATH_MIN_LEN) return false;
    let n = 0, near = 0;
    sampleLine(fp.pts, 10, (x, y) => { n++; if (canalGrid.near(x, y, TOWPATH_DIST)) near++; });
    return n > 0 && near / n >= TOWPATH_MIN_FRACTION;
  };
  const towpathBy = named.length ? 'name' : canalGrid.segs.length ? 'distance' : 'none';
  for (const fp of named.length ? named : canalGrid.segs.length ? footPieces.filter((fp) => pathLike(fp) && alongCanal(fp)) : []) {
    fp.f.towpath = 1;
    if (!towpath.includes(fp.f.id)) towpath.push(fp.f.id);
  }
  const uniq = (a) => [...new Set(a)];
  const landmarks = {
    canal: { waterways: uniq(waterways.filter((w) => w.kind === 'canal').map((w) => w.id)), water: uniq(canalWater.map((w) => w.id)) },
    towpath,
  };

  // ---------------------------------------------------------------- report: buildings on roads
  const roadGrid = new SegGrid(25);
  for (const rp of roadPieces) {
    const t = rp.t;
    if (!STREET_TYPES.has(t.highway) || rp.bridge || rp.tunnel || rp.layer !== 0 || t.covered === 'yes') continue;
    const lanes = Number.parseInt(t.lanes, 10);
    const hw = lanes > 0 ? (lanes * LANE_WIDTH) / 2 : ROAD_HALF_WIDTH[t.highway.replace('_link', '')] ?? 3.5;
    roadGrid.addLine(rp.pts, { id: rp.id, name: rp.name, hw });
  }
  const overlaps = [];
  for (const br of buildingRings) {
    const t = br.t;
    if (['roof', 'carport', 'canopy', 'bridge', 'construction', 'ruins'].includes(t.building) || (Number.parseInt(t.layer, 10) || 0) !== 0) continue;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of br.ring) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    let worst = null;
    roadGrid.query(minx - 8, miny - 8, maxx + 8, maxy + 8, (s) => {
      let d = Infinity;
      if (pointInRing(s.ax, s.ay, br.ring) || pointInRing(s.bx, s.by, br.ring)) d = 0;
      else {
        const ring = br.ring;
        for (let i = 0, j = ring.length - 1; i < ring.length && d > 0; j = i++) d = Math.min(d, distSegSeg(ring[j][0], ring[j][1], ring[i][0], ring[i][1], s.ax, s.ay, s.bx, s.by));
      }
      const depth = s.data.hw - d;
      if (depth >= OVERLAP_REPORT_MIN && (!worst || depth > worst.depth)) worst = { depth, road: s.data };
      return true;
    });
    if (worst) {
      const c = centroid(br.ring);
      const [lat, lon] = latlon(c[0], c[1]);
      overlaps.push({ building: br.id, type: t.building, road: worst.road.id, roadName: worst.road.name, depth: r1(worst.depth), lat, lon });
    }
  }
  overlaps.sort((a, b) => b.depth - a.depth);

  // ---------------------------------------------------------------- report: streets without sidewalk tagging nearby
  const footGrid = new SegGrid(25);
  for (const fp of footPieces) if (fp.f.kind !== 'steps') footGrid.addLine(fp.pts, fp.id);
  const noSidewalk = [];
  for (const rp of roadPieces) {
    const t = rp.t;
    if (!STREET_TYPES.has(t.highway) || t.highway.startsWith('trunk') || t.motorroad === 'yes' || rp.tunnel) continue;
    if (Object.keys(t).some((key) => key === 'sidewalk' || key.startsWith('sidewalk:'))) continue;
    if (t.foot === 'no' || t.access === 'no' || t.access === 'private') continue;
    const L = lineLength(rp.pts);
    if (L < SIDEWALK_REPORT_MIN_LEN) continue;
    let n = 0, cov = 0;
    sampleLine(rp.pts, 15, (x, y) => { n++; if (footGrid.near(x, y, SIDEWALK_SEARCH)) cov++; });
    if (n && cov / n >= SIDEWALK_MIN_COVER) continue;
    let acc = 0, mid = rp.pts[0];
    sampleLine(rp.pts, 1, (x, y) => { if (acc++ === Math.floor(L / 2)) mid = [x, y]; });
    const [lat, lon] = latlon(mid[0], mid[1]);
    noSidewalk.push({ road: rp.id, name: rp.name, highway: t.highway, length: Math.round(L), cover: Math.round((n ? cov / n : 0) * 100) / 100, lat, lon });
  }
  noSidewalk.sort((a, b) => b.length - a.length);

  // ---------------------------------------------------------------- assemble
  const idNum = (id) => Number(String(id).slice(1)) || 0;
  const byId = (a, b) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id)) || (a.part ?? 0) - (b.part ?? 0);
  for (const list of [roads, footways, buildings, pois, water, waterways, parks, parking, bridges]) list.sort(byId);
  props.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]));
  const issueList = issues.map((i) => {
    const [lat, lon] = latlon(i.where[0], i.where[1]);
    return { kind: i.kind, id: i.id, lat, lon };
  });
  const counts = { roads: roads.length, footways: footways.length, buildings: buildings.length, pois: pois.length, water: water.length, waterways: waterways.length, parks: parks.length, parking: parking.length, bridges: bridges.length, props: props.length };
  const W = rect.x1 - rect.x0, H = rect.y1 - rect.y0;
  const doc = {
    meta: {
      format: FORMAT,
      source: basename(inputPath),
      osmBase: osm.osmBase,
      bbox: BBOX,
      crop: { ...crop, widthM: r1(W), heightM: r1(H) },
      origin: { lat: proj.lat0, lon: proj.lon0 },
      metresPerDegree: { lat: r1(proj.mLat), lon: r1(proj.mLon) },
      frame: 'equirectangular around origin; x east, z south, y up; metres rounded to 0.1',
      bounds: { x0: r1(rect.x0), z0: r1(-rect.y1), x1: r1(rect.x1), z1: r1(-rect.y0) },
      winding: 'outer rings counter-clockwise on a north-up map (negative shoelace area in raw x,z), holes the other way; rings do not repeat the first point',
      units: { maxspeed: 'km/h', h: 'm' },
      notes: 'ids: w=way, r=relation, n=node; part = index when one OSM feature was cut into several pieces. Road and path vertices shared by several ways (junctions) are always kept and identical in each way, so a graph can be built by matching coordinates. Footway bridge/tunnel/layer are omitted when 0/0/0. Business and building names are never included; name POIs from src/data/poiNames.ts by cat.',
      simplify: { scale: k, line: SIMPLIFY_LINE * k, area: SIMPLIFY_AREA * k, building: SIMPLIFY_BUILDING * k },
      attribution: ATTRIBUTION,
      generatedAt: new Date().toISOString(),
      counts,
    },
    roads, footways, buildings, pois, water, waterways, parks, parking, bridges, landmarks, props,
  };
  const lengthKm = (list) => list.reduce((s, e) => s + (e.pts && !e.area ? lineLength(e.pts) : 0), 0) / 1000;
  return {
    doc,
    stats: { ...stats, towpathBy, roadKm: lengthKm(roads), footKm: lengthKm(footways), towpathKm: lengthKm(footways.filter((f) => f.towpath)), W, H, proj },
    report: { overlaps, noSidewalk, issues: issueList },
  };
}

// ================================================================================================= output
/** Compact JSON with one feature per line, so git diffs of the data file stay readable. */
function toJson(doc) {
  const keys = Object.keys(doc);
  const lines = ['{'];
  keys.forEach((k, i) => {
    const v = doc[k];
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length) {
      lines.push(`${JSON.stringify(k)}:[`);
      lines.push(v.map((e) => JSON.stringify(e)).join(',\n'));
      lines.push(`]${comma}`);
    } else lines.push(`${JSON.stringify(k)}:${JSON.stringify(v)}${comma}`);
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function printReport({ input, out, osm, res, bytes, inBytes, tParse, tConvert, limit }) {
  const { doc, stats, report } = res;
  const c = doc.meta.counts;
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  const osmLink = (id) => `https://www.openstreetmap.org/${id[0] === 'w' ? 'way' : id[0] === 'r' ? 'relation' : 'node'}/${id.slice(1)}`;
  const at = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const L = [];
  L.push(`OSM import: ${input} (${mb(inBytes)}) -> ${out}`);
  L.push(`  parsed ${osm.n.toLocaleString('en')} nodes, ${osm.ways.length.toLocaleString('en')} ways, ${osm.rels.length.toLocaleString('en')} relations in ${(tParse / 1000).toFixed(1)} s; converted in ${(tConvert / 1000).toFixed(1)} s`);
  if (osm.osmBase) L.push(`  data as of ${osm.osmBase}`);
  const m = doc.meta;
  L.push(`  crop ${m.crop.minlon},${m.crop.minlat} .. ${m.crop.maxlon},${m.crop.maxlat} = ${Math.round(stats.W)} m x ${Math.round(stats.H)} m, origin ${m.origin.lat.toFixed(5)}, ${m.origin.lon.toFixed(5)}`);
  if (osm.bounds) {
    const b = osm.bounds;
    if (b.minlon > m.crop.minlon || b.maxlon < m.crop.maxlon || b.minlat > m.crop.minlat || b.maxlat < m.crop.maxlat) {
      L.push(`  WARNING: the file's bounds (${b.minlon},${b.minlat},${b.maxlon},${b.maxlat}) do not cover the crop`);
    }
  }
  L.push('');
  L.push('  feature      count');
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  L.push(`  ${pad('roads', 10)} ${lpad(c.roads, 6)}   ${stats.roadKm.toFixed(1)} km`);
  L.push(`  ${pad('footways', 10)} ${lpad(c.footways, 6)}   ${stats.footKm.toFixed(1)} km`);
  const hs = stats.heightSrc;
  L.push(`  ${pad('buildings', 10)} ${lpad(c.buildings, 6)}   heights: ${hs.height} tagged, ${hs.levels} from levels, ${hs.estimate} estimated`);
  const cats = new Map();
  for (const p of doc.pois) cats.set(p.cat, (cats.get(p.cat) ?? 0) + 1);
  const top = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
  L.push(`  ${pad('pois', 10)} ${lpad(c.pois, 6)}   ${top}`);
  for (const k of ['water', 'waterways', 'parks', 'parking', 'bridges', 'props']) L.push(`  ${pad(k, 10)} ${lpad(c[k], 6)}`);
  const lm = doc.landmarks;
  L.push(`  canal: ${lm.canal.waterways.length} waterway line(s), ${lm.canal.water.length} water area(s); towpath: ${lm.towpath.length} path(s), ${stats.towpathKm.toFixed(2)} km (found by ${stats.towpathBy})`);
  L.push('');
  const sk = doc.meta.simplify;
  L.push(`  output ${mb(bytes)} (target < ${mb(SIZE_TARGET)}), simplify x${sk.scale} (lines ${sk.line} m, areas ${sk.area} m, buildings ${sk.building} m)${bytes > SIZE_TARGET ? '  WARNING: over target; try --simplify 8 or a smaller CROP' : ''}`);
  L.push(`  dropped: ${stats.buildingsOutside} buildings mostly outside the crop, ${stats.buildingsTiny} tiny, ${stats.buildingsUnderground} underground; names dropped from ${stats.namesDropped} POIs/buildings`);
  if (stats.missingNodes || stats.missingMembers) L.push(`  incomplete input: ${stats.missingNodes} node refs and ${stats.missingMembers} relation members not in the file (normal for relations that reach outside the download box)`);
  L.push('');
  L.push('Suspicious areas (open the link, or search the lat/lon on openstreetmap.org):');
  const list = (title, rows, fmt) => {
    L.push(`  ${title}: ${rows.length}${rows.length > limit ? ` (showing ${limit})` : ''}`);
    for (const r of rows.slice(0, limit)) L.push(`    ${fmt(r)}`);
  };
  list('buildings overlapping a road', report.overlaps, (r) => `${r.building} (${r.type}) reaches ${r.depth} m into ${r.roadName ?? 'unnamed road'} ${r.road}  at ${at(r.lat, r.lon)}  ${osmLink(r.building)}`);
  list('streets with no sidewalk tagging nearby', report.noSidewalk, (r) => `${r.road} ${r.highway} "${r.name ?? 'unnamed'}" ${r.length} m, footway cover ${Math.round(r.cover * 100)}%  at ${at(r.lat, r.lon)}  ${osmLink(r.road)}`);
  list('areas cut by the download box / geometry problems', report.issues, (r) => `${r.kind} in ${r.id}  at ${at(r.lat, r.lon)}${r.id.startsWith('w') || r.id.startsWith('r') ? `  ${osmLink(r.id)}` : ''}`);
  if (osm.remarks.length) L.push(`  Overpass remarks: ${osm.remarks.join(' | ')}`);
  console.log(L.join('\n'));
}
