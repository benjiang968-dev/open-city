#!/usr/bin/env node
// Overture Maps importer (Stage 1): real 1:1 Georgetown, Washington DC, from open data.
//
//   npm run import-overture                       (= node scripts/importOverture.mjs)
//   node scripts/importOverture.mjs [--out <file>] [--report <file>] [--fetch] [--heights-spacing <m>]
//
// Reads the Overture Maps release cached under data/overture/ by scripts/fetchOverture.py (transportation segments
// and connectors, buildings and building parts, places, base water / land use / land / infrastructure) and the AWS
// Terrain Tiles (terrarium PNG) cached beside them, and writes src/data/georgetown.json in the game's map format
// "open-city-osm-1" (the schema scripts/importOsm.mjs writes and src/systems/map/geoDoc.ts types). If the cache is
// missing (or with --fetch) it runs the fetcher first with $OVERTURE_PYTHON (default python3), which needs pyarrow
// and shapely: see the top of scripts/fetchOverture.py.
//
// Output frame: metres, x east, z SOUTH, y up, origin ORIGIN (the old knowledge-based map's origin, so positions in
// the two files can be compared directly). Street, river, canal and public-park names are kept (USPS-abbreviated:
// "M Street Northwest" -> "M St NW"). Business and building names are never written: places carry a category only
// and the game names them from src/data/poiNames.ts. Synthesized extras (street trees on shopping streets, lamps,
// benches, bins, hydrants) are flagged with a 4th prop element 1.
//
// Licence: the output is a derivative database of OpenStreetMap data (via Overture Maps) under the ODbL; places are
// CDLA-Permissive-2.0; building heights include USGS 3DEP lidar (public domain) and Esri Community Maps (CC BY 4.0)
// contributions; terrain is AWS Terrain Tiles (USGS 3DEP, public domain). See meta.attribution / meta.licence.
// Plain Node ESM, no dependencies.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { clipArea, clipPolyline, clipRingSH, centroid, distPointSeg2, lineLength, pointInRing, sampleLine, signedArea, simplify, toJson, SegGrid, STREET_WORD, BUSINESS_WORD } from './importOsm.mjs';

// =================================================================================================== area
/**
 * Game area (lon/lat), about 2.0 km x 1.9 km: west past the Key Bridge landing into the Georgetown University campus,
 * east just past Washington Circle (to 22nd St NW), south into the Potomac (the waterfront, the Rock Creek mouth and
 * the Watergate shore, north of Theodore Roosevelt Island), north past R St (the edge runs through Dumbarton Oaks,
 * Montrose Park, Oak Hill Cemetery and the Rock Creek woods east of Wisconsin Ave).
 */
export const CROP = { minlon: -77.0726, minlat: 38.8986, maxlon: -77.0488, maxlat: 38.9157 };
/** Frame origin: the knowledge-based map's (scripts/georgetownFromSpec.mjs), so old and new positions compare 1:1. */
const ORIGIN = { lat: 38.9065, lon: -77.061 };
const CACHE = 'data/overture';
const DEFAULT_OUT = 'src/data/georgetown.json';
const FORMAT = 'open-city-osm-1';
const ATTRIBUTION = 'Map data: © OpenStreetMap contributors (ODbL), via Overture Maps Foundation (release {release}); places © Overture Maps Foundation (CDLA-Permissive-2.0); building heights include USGS 3DEP lidar, Microsoft ML Buildings and Esri Community Maps contributions; terrain: AWS Terrain Tiles (USGS 3DEP).';
const LICENCE = 'src/data/georgetown.json is a derivative database of OpenStreetMap data and is made available under the Open Database License (ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/). Overture places: CDLA-Permissive-2.0. Terrain: USGS 3DEP (public domain) via AWS Terrain Tiles. Street furniture flagged synth and all business names in the game are invented, not data.';
const SIZE_TARGET = 3 * 1024 * 1024;

// ======================================================================================= import constants
// These shape the generated data file, not gameplay; gameplay numbers stay in src/tuning.ts.
const LEVEL_HEIGHT = 3.3; // m per storey when only the floor count is known (Georgetown rowhouses: 3.0-3.6 m)
const MIN_BUILDING_AREA = 6; // m², smaller footprints are dropped as mapping noise
const MIN_INSIDE_FRACTION = 0.5; // buildings with less of their footprint inside the crop are dropped
const OVERLAP_DROP = 0.6; // a building overlapping a larger one by more than this share of its own area is dropped
const NEIGHBOUR_RADIUS = 60; // m: buildings with no height take the median of tagged neighbours of the same group
/** Fallback heights (m) by building class when no neighbour of the same group has one. Georgetown rowhouses: 2-4 storeys. */
const CLASS_HEIGHT = {
  house: 10, terrace: 10.5, semidetached_house: 10, detached: 9, residential: 11, apartments: 16, dormitory: 15, shed: 3, garage: 3.2,
  garages: 3.2, carport: 2.6, roof: 4.5, retail: 8, commercial: 11, office: 16, hotel: 22, church: 15, chapel: 9, school: 12,
  university: 15, college: 14, library: 12, hospital: 22, civic: 12, public: 12, government: 15, parking: 12, warehouse: 9,
  industrial: 9, service: 4, shelter: 3, boathouse: 6, transportation: 8, kiosk: 3, stadium: 15,
};
const DEFAULT_HEIGHT = 10; // m, unknown class with no neighbours
const SIMPLIFY_LINE = 0.25; // m, Douglas-Peucker for roads, paths and waterways (connector vertices are always kept)
const SIMPLIFY_AREA = 0.4; // m, water, parks, parking, bridge outlines
const SIMPLIFY_BUILDING = 0.15; // m, only removes near-collinear vertices
const HEIGHTS_SPACING = 5; // m, terrain grid written to the file (the 3DEP source is about 1-3 m; z15 tiles are 3.7 m/px)
const RIVER_BED = -2; // m below the river surface: the terrain under the Potomac
const LANE_WIDTH = 3.3; // m, as TUNING.geo.laneWidth
/**
 * Lane counts and carriageway widths when the data has none (Overture carries no lane counts; 26 segments here have
 * a width). Two-way / one-way: [lanes, kerb-to-kerb width m]. Lanes include a kerbside parking lane where the game
 * models one (2+ lanes per direction). Widths are typical DC values: 3.0-3.3 m travel lanes plus 2.2-2.4 m parking.
 */
const LANES = {
  motorway: { two: [4, 14.4], one: [2, 8.0] },
  trunk: { two: [4, 14.4], one: [2, 8.0] },
  primary: { two: [4, 13.6], one: [3, 10.5] },
  secondary: { two: [4, 13.2], one: [2, 8.5] },
  tertiary: { two: [2, 10.4], one: [2, 8.2] },
  unclassified: { two: [2, 8.0], one: [1, 5.0] },
  residential: { two: [2, 9.8], one: [2, 8.0] },
  living_street: { two: [2, 6.5], one: [1, 4.5] },
  road: { two: [2, 7.0], one: [1, 4.5] },
  link: { two: [2, 8.0], one: [1, 5.0] },
  alley: { two: [1, 4.2], one: [1, 4.2] },
  driveway: { two: [1, 3.6], one: [1, 3.6] },
  parking_aisle: { two: [2, 6.2], one: [1, 4.5] },
  service: { two: [1, 5.0], one: [1, 4.2] },
};
const MIN_PIECE = 0.3; // m, rule pieces shorter than this merge into a neighbour
/** Street-name abbreviations (USPS), whole words only. Circle, Parkway, Freeway, Bridge and the like stay spelled out. */
const ABBREV = [[/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bPlace\b/g, 'Pl'], [/\bBoulevard\b/g, 'Blvd'], [/\bDrive\b/g, 'Dr'],
  [/\bCourt\b/g, 'Ct'], [/\bLane\b/g, 'Ln'], [/\bTerrace\b/g, 'Ter'], [/\bNorthwest$/g, 'NW'], [/\bNortheast$/g, 'NE'], [/\bSouthwest$/g, 'SW'], [/\bSoutheast$/g, 'SE'],
  [/\bNorth$/g, 'N'], [/\bSouth$/g, 'S']];
/** Service roads of these kinds belong to a property or a car park: their names are never kept. */
const UNNAMED_SERVICE = new Set(['drive-through', 'parking_aisle', 'driveway']);
const STREET_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
const SIDEWALK_BAND = [0.5, 9]; // m beyond the estimated kerb where a separate sidewalk counts as this road's
const SIDEWALK_MIN_COVER = 0.25; // share of a road's length that needs a sidewalk alongside for sidewalk=separate
const SIGNAL_SNAP = 28; // m: signal / stop nodes snap to the nearest junction this close (tagged on approaches)
const TOWPATH_DIST = 26; // m from the canal for a path to count as towpath
const CREEK_NAME = /^Rock Creek$/;
const CANAL_NAME = /Chesapeake and Ohio Canal/;
const POI_MIN_CONFIDENCE = 0.55; // Overture places below this are skipped
const OFFICE_MIN_CONFIDENCE = 0.8; // offices / professional services need more (most sit on upper floors)
const MAX_OFFICES_PER_BUILDING = 2;
const POI_BUILDING_SNAP = 10; // m: a place outside every footprint joins the nearest building this close
// Synthesized street furniture (flagged synth), never on top of real features.
const SYNTH = {
  streetTreeStep: 12, // m between street trees on shopping streets
  treeKerbOffset: 0.9, // m from the kerb into the sidewalk
  lampStep: 30, // m between lamps along streets with sidewalks
  lampKerbOffset: 0.5,
  benchStep: 70, // m between benches on shopping streets
  binStep: 55, // m between litter bins on shopping streets
  hydrantStep: 90, // m between hydrants along streets with sidewalks
  clearReal: { tree: 5, lamp: 12, bench: 20, bin: 20, hydrant: 40 }, // m: no synth prop of a kind this close to a real one
  clearAny: 2.5, // m from any other prop
  shopsPer100m: 2.5, // POIs (shops, food, drink) within 30 m per 100 m of street that make it a shopping street
};

// =================================================================================================== main
const args = { out: DEFAULT_OUT, report: null, fetch: false, spacing: HEIGHTS_SPACING };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--out') args.out = argv[++i];
    else if (s === '--report') args.report = argv[++i];
    else if (s === '--fetch') args.fetch = true;
    else if (s === '--heights-spacing') args.spacing = Number(argv[++i]) || HEIGHTS_SPACING;
    else if (s === '-h' || s === '--help') {
      const src = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
      console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else { console.error(`importOverture: unknown argument ${s}`); process.exit(1); }
  }
}
const TYPES = ['segment', 'connector', 'building', 'building_part', 'place', 'water', 'land_use', 'infrastructure', 'land'];
if (args.fetch || TYPES.some((t) => !existsSync(`${CACHE}/${t}.jsonl`)) || !existsSync(`${CACHE}/terrain/tiles.json`)) {
  const py = process.env.OVERTURE_PYTHON || 'python3';
  console.log(`Fetching Overture data with ${py} scripts/fetchOverture.py ...`);
  execFileSync(py, ['-I', 'scripts/fetchOverture.py', ...(args.fetch ? ['--force'] : [])], { stdio: 'inherit' });
}
const T0 = performance.now();
const release = JSON.parse(readFileSync(`${CACHE}/release.json`, 'utf8'));
const load = (t) => readFileSync(`${CACHE}/${t}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const D = Object.fromEntries(TYPES.map((t) => [t, load(t)]));

// ============================================================================================= projection
const P0 = (ORIGIN.lat * Math.PI) / 180;
const mLat = 111132.954 - 559.822 * Math.cos(2 * P0) + 1.175 * Math.cos(4 * P0);
const mLon = 111412.84 * Math.cos(P0) - 93.5 * Math.cos(3 * P0) + 0.118 * Math.cos(5 * P0);
/** [lon, lat] -> [x east, y north] metres (internal frame; output flips y to z south). */
const fwd = (c) => [(c[0] - ORIGIN.lon) * mLon, (c[1] - ORIGIN.lat) * mLat];
const inv = (x, y) => [ORIGIN.lon + x / mLon, ORIGIN.lat + y / mLat];
const [rx0, ry0] = fwd([CROP.minlon, CROP.minlat]);
const [rx1, ry1] = fwd([CROP.maxlon, CROP.maxlat]);
const rect = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
const r1 = (v) => Math.round(v * 10) / 10 || 0;
const inRect = (x, y, m = 0) => x >= rect.x0 - m && x <= rect.x1 + m && y >= rect.y0 - m && y <= rect.y1 + m;
const latlon = (x, y) => { const [lo, la] = inv(x, y); return [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6]; };
const okey = (x, y) => `${r1(x)},${r1(-y)}`; // output-coordinate key (what the game matches vertices by)

const stats = { dropped: {}, notes: [] };
const drop = (why) => { stats.dropped[why] = (stats.dropped[why] ?? 0) + 1; };

// ------------------------------------------------------------------------------------- output helpers
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
/** GeoJSON Polygon / MultiPolygon -> [{ rings: [{pts, role, closed}] }] in the internal frame. */
const polysOf = (g) => {
  if (!g) return [];
  const one = (coords) => coords.map((ring, i) => {
    const pts = ring.map(fwd);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return { pts, role: i === 0 ? 'outer' : 'inner', closed: true };
  });
  if (g.type === 'Polygon') return [one(g.coordinates)];
  if (g.type === 'MultiPolygon') return g.coordinates.map(one);
  return [];
};
const shortId = (id, p = 'g') => `${p}${String(id).replace(/-/g, '').slice(0, 12)}`;
const usedIds = new Set();
const uniqueId = (base) => {
  let id = base, k = 1;
  while (usedIds.has(id)) id = `${base}.${k++}`;
  usedIds.add(id);
  return id;
};
const abbreviate = (n) => {
  if (!n) return null;
  let s = n.trim();
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  return s;
};
const streetName = (name) => (name && STREET_WORD.test(name) && !BUSINESS_WORD.test(name) ? name : null);

// ================================================================================================ connectors
const connKey = (c) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
const connectorAt = new Set();
for (const f of D.connector) if (f.geometry?.type === 'Point') connectorAt.add(connKey(f.geometry.coordinates));

// ===================================================================================== segments -> pieces
/** Linear-referencing rules (between = [from, to] fractions of the segment length) evaluated at a fraction. */
const ruleAt = (rules, t, pick) => {
  let v;
  for (const r of rules ?? []) {
    const b = r.between;
    if (!b || (t >= b[0] - 1e-9 && t <= b[1] + 1e-9)) v = pick(r, v);
  }
  return v;
};
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'unknown']);
const FOOT_CLASSES = { footway: 'footway', steps: 'steps', path: 'path', track: 'path', bridleway: 'path', cycleway: 'cycleway', pedestrian: 'pedestrian' };
const speedKmh = (ms) => (!ms || !ms.value ? null : Math.round(ms.unit === 'mph' ? ms.value * 1.609344 : ms.value));
function onewayOf(rules, t) {
  // access_restrictions: 'denied' with a heading and no mode/vehicle limits = a one-way street
  let ow = 0;
  for (const r of rules ?? []) {
    const b = r.between;
    if (b && (t < b[0] - 1e-9 || t > b[1] + 1e-9)) continue;
    const w = r.when ?? {};
    if (r.access_type !== 'denied' || !w.heading || w.during) continue;
    const modes = w.mode ?? [];
    if (modes.length && !modes.some((m) => ['vehicle', 'motor_vehicle', 'car', 'hgv'].includes(m))) continue;
    if (w.using?.length || w.recognized?.length) continue;
    ow = w.heading === 'backward' ? 1 : -1;
  }
  return ow;
}
function accessOf(rules, t) {
  for (const r of rules ?? []) {
    const b = r.between;
    if (b && (t < b[0] - 1e-9 || t > b[1] + 1e-9)) continue;
    const w = r.when ?? {};
    if (w.heading || w.during || w.mode?.length || w.using?.length) continue;
    if (r.access_type === 'denied') return 'no';
    if (r.access_type === 'designated') return null;
  }
  for (const r of rules ?? []) {
    const w = r.when ?? {};
    if (r.access_type === 'allowed' && (w.using ?? []).some((u) => u === 'as_customer' || u === 'at_destination' || u === 'to_deliver')) return w.using.includes('as_customer') ? 'customers' : 'destination';
    if (r.access_type === 'allowed' && (w.recognized ?? []).includes('as_private')) return 'private';
  }
  return null;
}

const roadsRaw = [], footRaw = [];
for (const f of D.segment) {
  const p = f.properties;
  if (p.subtype !== 'road' || f.geometry?.type !== 'LineString') { drop(`segment ${p.subtype}`); continue; }
  const cls = p.class;
  const isRoad = ROAD_CLASSES.has(cls), isFoot = cls in FOOT_CLASSES;
  if (!isRoad && !isFoot) { drop(`segment class ${cls}`); continue; }
  const coords = f.geometry.coordinates;
  const P = coords.map(fwd);
  for (let i = 0; i < P.length; i++) if (connectorAt.has(connKey(coords[i]))) P[i][2] = 1;
  P[0][2] = 1; P[P.length - 1][2] = 1;
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = cum[cum.length - 1];
  if (L < 0.05) { drop('segment degenerate'); continue; }
  // breakpoints from every linear-referenced rule
  const cuts = new Set([0, 1]);
  for (const key of ['road_flags', 'level_rules', 'subclass_rules', 'road_surface', 'speed_limits', 'access_restrictions', 'width_rules']) {
    for (const r of p[key] ?? []) if (r.between) for (const t of r.between) if (t > 0 && t < 1) cuts.add(Math.round(t * 1e6) / 1e6);
  }
  let ts = [...cuts].sort((a, b) => a - b);
  ts = ts.filter((t, i) => i === 0 || i === ts.length - 1 || ((t - ts[i - 1]) * L >= MIN_PIECE && (ts[ts.length - 1] - t) * L >= MIN_PIECE));
  const pointAtT = (t) => {
    const s = t * L;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const u = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u, 1];
  };
  const sliceT = (ta, tb) => {
    const out = [pointAtT(ta)];
    for (let i = 1; i < P.length - 1; i++) { const t = cum[i] / L; if (t > ta + 1e-9 && t < tb - 1e-9) out.push(P[i]); }
    if (ta === 0) out[0] = P[0];
    out.push(tb === 1 ? P[P.length - 1] : pointAtT(tb));
    return out;
  };
  const name = abbreviate(p.names?.primary ?? null);
  for (let k = 1; k < ts.length; k++) {
    const ta = ts[k - 1], tb = ts[k], tm = (ta + tb) / 2;
    const pts = sliceT(ta, tb);
    const flags = new Set(ruleAt(p.road_flags, tm, (r, v) => [...(v ?? []), ...r.values]) ?? []);
    if (flags.has('is_under_construction') || flags.has('is_abandoned')) { drop('segment under construction / abandoned'); continue; }
    const level = ruleAt(p.level_rules, tm, (r) => r.value) ?? 0;
    const sub = ruleAt(p.subclass_rules, tm, (r) => r.value) ?? p.subclass ?? null;
    const surface = ruleAt(p.road_surface, tm, (r) => r.value) ?? null;
    const maxspeed = speedKmh(ruleAt(p.speed_limits, tm, (r) => r.max_speed));
    const width = ruleAt(p.width_rules, tm, (r) => r.value) ?? null;
    const piece = {
      seg: p.id, idBase: shortId(p.id), cls, sub, name, pts, level: Math.max(-5, Math.min(5, level)), bridge: flags.has('is_bridge') ? 1 : 0, tunnel: flags.has('is_tunnel') ? 1 : 0,
      covered: flags.has('is_covered'), link: flags.has('is_link') || sub === 'link', surface, maxspeed, width, oneway: onewayOf(p.access_restrictions, tm), access: accessOf(p.access_restrictions, tm),
    };
    (isRoad ? roadsRaw : footRaw).push(piece);
  }
}

// ======================================================================= roads: class, lanes, width, names
const roads = [], footways = [], bridges = [];
const highwayOf = (pc) => {
  const base = pc.cls === 'unknown' ? 'road' : pc.cls;
  if (pc.link && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(base)) return `${base}_link`;
  return base;
};
const surfaceOut = (s, road) => (!s || s === 'paved' || s === 'unknown' ? null : road && (s === 'paving_stones' || s === 'cobblestone' || s === 'sett') ? 'sett' : s);
for (const pc of roadsRaw) {
  const hw = highwayOf(pc);
  const service = pc.cls === 'service' ? (pc.sub === 'alley' || pc.sub === 'driveway' || pc.sub === 'parking_aisle' ? pc.sub : null) : null;
  const key = service ?? (hw.endsWith('_link') ? 'link' : hw === 'service' ? 'service' : hw);
  const est = LANES[key] ?? LANES.road;
  let [lanes, width] = pc.oneway ? est.one : est.two;
  let widthSrc = 'estimate';
  if (pc.width && pc.width > 2 && pc.width < 40) {
    width = pc.width;
    lanes = Math.max(1, Math.round(width / LANE_WIDTH));
    if (!pc.oneway && lanes < 2 && width >= 5.5) lanes = 2;
    widthSrc = 'data';
  }
  const name = hw === 'service' || hw === 'road' ? (service && UNNAMED_SERVICE.has(service) ? null : streetName(pc.name)) : pc.name;
  for (const pieceRaw of clipPolyline(pc.pts, rect)) {
    const o = outLine(pieceRaw, SIMPLIFY_LINE);
    if (!o) continue;
    const id = uniqueId(pc.idBase);
    const r = {
      id, name, highway: hw, lanes, width: r1(width), oneway: pc.oneway, bridge: pc.bridge, tunnel: pc.tunnel, layer: pc.level,
      junction: null, maxspeed: pc.maxspeed, pts: o,
    };
    if (widthSrc === 'estimate') r.est = 1;
    const sf = surfaceOut(pc.surface, true);
    if (sf) r.surface = sf;
    if (service) r.service = service;
    if (pc.access) r.access = pc.access;
    if (pc.covered) r.covered = 1;
    roads.push(r);
    if (pc.bridge) bridges.push({ id, src: 'road', name, layer: pc.level || 1, pts: o });
  }
}

// ---- Washington Circle (and any other named circle whose pieces close into a loop): one closed road with
// junction=roundabout, one-way counter-clockwise (keep right). Overture keeps no junction tag and only some ring
// pieces carry an explicit one-way, so the ring is found geometrically: a loop of same-name pieces.
{
  const byName = new Map();
  for (const r of roads) if (r.name && /Circle/.test(r.name) && !r.tunnel && !r.bridge && !r.layer) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);
  const k = (p) => `${p[0]},${p[1]}`;
  for (const [name, list] of byName) {
    const at = new Map();
    for (const r of list) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) (at.get(k(p)) ?? at.set(k(p), []).get(k(p))).push(r);
    let best = null;
    for (const r0 of list) {
      const ring = [...r0.pts];
      const used = new Set([r0]);
      for (let guard = 0; guard < list.length; guard++) {
        const e = ring[ring.length - 1];
        const nx = (at.get(k(e)) ?? []).find((r) => !used.has(r));
        if (!nx) break;
        used.add(nx);
        ring.push(...(k(nx.pts[0]) === k(e) ? nx.pts : nx.pts.slice().reverse()).slice(1));
        if (k(ring[ring.length - 1]) === k(ring[0])) break;
      }
      if (k(ring[0]) === k(ring[ring.length - 1]) && ring.length >= 8 && (!best || used.size > best.used.size)) best = { ring, used };
    }
    if (!best) { stats.notes.push(`${name}: pieces do not close into a loop (left as plain roads)`); continue; }
    // counter-clockwise on a north-up map = positive shoelace area in the output's (x, z south) frame flipped
    let ring = best.ring;
    if (signedArea(ring.map(([x, z]) => [x, -z])) < 0) ring = ring.slice().reverse();
    const first = [...best.used].sort((a, b) => b.lanes - a.lanes)[0];
    const lanes = Math.max(2, ...[...best.used].map((r) => r.lanes));
    const ringRoad = { ...first, id: first.id, lanes, width: r1(Math.max(...[...best.used].map((r) => r.width), 2 * LANE_WIDTH + 1)), oneway: 1, junction: 'roundabout', pts: ring };
    for (const q of best.used) roads.splice(roads.indexOf(q), 1);
    roads.push(ringRoad);
    stats.notes.push(`${name}: ${best.used.size} pieces joined into a closed one-way roundabout, counter-clockwise (${ring.length} vertices, ${Math.round(lineLength(ring))} m, ${lanes} lanes)`);
  }
}

// ======================================================================================= footways
for (const pc of footRaw) {
  let kind = FOOT_CLASSES[pc.cls];
  if (pc.cls === 'footway' && pc.sub === 'sidewalk') kind = 'sidewalk';
  else if ((pc.cls === 'footway' || pc.cls === 'cycleway' || pc.cls === 'path') && (pc.sub === 'crosswalk' || pc.sub === 'cycle_crossing')) kind = 'crossing';
  const name = streetName(pc.name);
  for (const pieceRaw of clipPolyline(pc.pts, rect)) {
    const o = outLine(pieceRaw, SIMPLIFY_LINE);
    if (!o) continue;
    const id = uniqueId(pc.idBase);
    const f = { id, kind, name, pts: o };
    if (pc.bridge) f.bridge = 1;
    if (pc.tunnel) f.tunnel = 1;
    if (pc.level) f.layer = pc.level;
    const sf = surfaceOut(pc.surface, false);
    if (sf) f.surface = sf;
    footways.push(f);
    if (pc.bridge && kind !== 'sidewalk' && kind !== 'crossing') bridges.push({ id, src: 'path', name, layer: pc.level || 1, pts: o });
  }
}

// ---- sidewalk=separate where mapped sidewalks run alongside (per road; the world generator decides per side)
{
  const g = new SegGrid(25);
  for (const f of footways) if (f.kind === 'sidewalk') g.addLine(f.pts.map(([x, z]) => [x, -z]), f);
  for (const r of roads) {
    if (r.tunnel || r.service || r.highway === 'motorway' || r.highway.endsWith('_link')) { r.sidewalk = 'no'; continue; }
    const pts = r.pts.map(([x, z]) => [x, -z]);
    const hw = r.width / 2;
    let n = 0, hit = 0;
    sampleLine(pts, 6, (x, y, ux, uy) => {
      n++;
      for (const side of [-1, 1]) {
        let ok = false;
        const nx = -uy * side, ny = ux * side;
        for (const o of [SIDEWALK_BAND[0] + 1, 3, 5, 7, SIDEWALK_BAND[1]]) if (g.near(x + nx * (hw + o), y + ny * (hw + o), 1.6)) { ok = true; break; }
        if (ok) { hit++; break; }
      }
    });
    r.sidewalk = n && hit / n >= SIDEWALK_MIN_COVER ? 'separate' : 'no';
  }
}

// ---- towpath: paths named towpath / C&O Canal Trail, or running along the canal
const canalLines = D.water.filter((f) => f.properties.subtype === 'canal' && f.geometry?.type === 'LineString' && CANAL_NAME.test(f.properties.names?.primary ?? ''));
{
  const cg = new SegGrid(25);
  for (const f of canalLines) cg.addLine(f.geometry.coordinates.map(fwd), 1);
  for (const f of footways) {
    if (!['path', 'footway', 'cycleway'].includes(f.kind) || f.bridge) continue;
    const named = /tow\s*path|Canal Trail/i.test(f.name ?? '');
    const pts = f.pts.map(([x, z]) => [x, -z]);
    let n = 0, near = 0;
    sampleLine(pts, 5, (x, y) => { n++; if (cg.near(x, y, TOWPATH_DIST)) near++; });
    if ((named && near / Math.max(1, n) > 0.3) || (lineLength(pts) > 30 && n && near / n >= 0.8 && f.kind === 'path')) f.towpath = 1;
  }
}

// ============================================================================================= water
const water = [], waterways = [];
const riverLine = D.water.filter((f) => f.properties.subtype === 'river' && f.geometry?.type === 'LineString' && /Potomac/.test(f.properties.names?.primary ?? ''));
const creekLines = D.water.filter((f) => f.geometry?.type === 'LineString' && CREEK_NAME.test(f.properties.names?.primary ?? '') && !(f.properties.source_tags?.covered === 'yes') && !f.properties.source_tags?.tunnel);
/** Joins line features into the longest chain (shared end coordinates), as [x, y] internal points. */
function chainLines(feats) {
  const segs = feats.map((f) => f.geometry.coordinates.map(fwd));
  const used = new Uint8Array(segs.length);
  const k = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  let best = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    let chain = segs[s].slice();
    for (let grown = true; grown;) {
      grown = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const c = segs[j];
        if (k(c[0]) === k(chain[chain.length - 1])) chain = chain.concat(c.slice(1));
        else if (k(c[c.length - 1]) === k(chain[chain.length - 1])) chain = chain.concat(c.slice(0, -1).reverse());
        else if (k(c[c.length - 1]) === k(chain[0])) chain = c.slice(0, -1).concat(chain);
        else if (k(c[0]) === k(chain[0])) chain = c.slice(1).reverse().concat(chain);
        else continue;
        used[j] = 1;
        grown = true;
      }
    }
    if (lineLength(chain) > lineLength(best)) best = chain;
  }
  return best;
}
// rivers and creek areas
const riverPolys = [];
{
  const potomacG = new SegGrid(50);
  for (const f of riverLine) potomacG.addLine(f.geometry.coordinates.map(fwd), 1);
  const creekG = new SegGrid(25);
  for (const f of creekLines) creekG.addLine(f.geometry.coordinates.map(fwd), 1);
  for (const f of D.water) {
    const p = f.properties;
    if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
    let kind = null, name = null;
    const nm = p.names?.primary ?? null;
    if (p.subtype === 'river' || (p.subtype === 'water' && p.source_tags?.water === 'river')) {
      // Potomac or Rock Creek? Whichever centre line runs through it.
      let pot = 0, cr = 0;
      for (const poly of polysOf(f.geometry)) for (const v of poly[0].pts) { if (potomacG.near(v[0], v[1], 400)) pot++; if (creekG.near(v[0], v[1], 40)) cr++; }
      kind = p.source_tags?.lock === 'yes' ? 'lock' : cr > pot * 0.5 && cr > 0 ? 'stream' : 'river';
      name = kind === 'river' ? 'Potomac River' : kind === 'stream' ? 'Rock Creek' : nm;
    } else if (p.subtype === 'canal') { kind = p.source_tags?.lock === 'yes' ? 'lock' : 'canal'; name = kind === 'canal' ? 'Chesapeake and Ohio Canal' : nm; }
    else if (p.class === 'fountain' || p.class === 'reflecting_pool') kind = 'fountain';
    else if (p.class === 'swimming_pool') kind = 'swimming_pool';
    else if (p.subtype === 'pond' || p.class === 'basin' || p.subtype === 'water' || p.subtype === 'reservoir') kind = 'pond';
    if (!kind) continue;
    for (const poly of polysOf(f.geometry)) {
      const pieces = clipArea(poly, rect, null, [], p.id);
      pieces.forEach((pc) => {
        const o = outPoly(pc, SIMPLIFY_AREA);
        if (!o) return;
        const e = { id: uniqueId(shortId(p.id, 'g')), kind, name, ...o };
        if (kind === 'river') riverPolys.push({ e, area: Math.abs(signedArea(pc.outer)), ring: pc.outer });
        else water.push(e);
      });
    }
  }
  // fountains mapped as infrastructure polygons
  for (const f of D.infrastructure) {
    const p = f.properties;
    if (p.class !== 'fountain' || f.geometry?.type !== 'Polygon') continue;
    for (const poly of polysOf(f.geometry)) for (const pc of clipArea(poly, rect, null, [], p.id)) {
      const o = outPoly(pc, SIMPLIFY_AREA);
      if (o) water.push({ id: uniqueId(shortId(p.id)), kind: 'fountain', name: null, ...o });
    }
  }
  // the largest Potomac piece first (the world generator models the river from the first 'river' polygon)
  riverPolys.sort((a, b) => b.area - a.area);
  water.unshift(...riverPolys.map((r) => r.e));
}
// canal and creek centre lines (one each, as the world generator expects), Potomac line
const canalChain = chainLines(canalLines);
const creekChain = chainLines(creekLines);
// canal runs east -> west, creek north -> south (the world's corridor sides and level lookups assume these)
if (canalChain.length && canalChain[0][0] < canalChain[canalChain.length - 1][0]) canalChain.reverse();
if (creekChain.length && creekChain[0][1] < creekChain[creekChain.length - 1][1]) creekChain.reverse();
const canalW = { id: 'canal', kind: 'canal', name: 'Chesapeake and Ohio Canal', pts: null };
const creekW = { id: 'creek', kind: 'stream', name: 'Rock Creek', pts: null };
{
  const c = clipPolyline(canalChain, rect).sort((a, b) => lineLength(b) - lineLength(a))[0];
  if (c) canalW.pts = outLine(c, SIMPLIFY_LINE);
  const k = clipPolyline(creekChain, rect).sort((a, b) => lineLength(b) - lineLength(a))[0];
  if (k) creekW.pts = outLine(k, SIMPLIFY_LINE);
  if (canalW.pts) waterways.push(canalW);
  if (creekW.pts) waterways.push(creekW);
  const pot = chainLines(riverLine);
  for (const pc of clipPolyline(pot, rect)) { const o = outLine(pc, SIMPLIFY_LINE); if (o) waterways.push({ id: uniqueId('potomac'), kind: 'river', name: 'Potomac River', pts: o }); }
}

// ============================================================================================= parks
const parks = [];
const PARK_KIND = {
  'park:park': 'leisure=park', 'park:dog_park': 'leisure=dog_park', 'horticulture:garden': 'leisure=garden', 'managed:grass': 'landuse=grass',
  'recreation:pitch': 'leisure=pitch', 'recreation:playground': 'leisure=playground', 'recreation:recreation_ground': 'leisure=recreation_ground',
  'cemetery:cemetery': 'landuse=cemetery', 'agriculture:meadow': 'landuse=meadow', 'horticulture:flowerbed': 'landuse=flowerbed',
  'protected:nature_reserve': null, 'protected:national_park': null,
  'forest:wood': 'natural=wood', 'forest:forest': 'natural=wood', 'shrub:scrub': 'natural=scrub', 'grass:grassland': 'natural=grassland', 'shrub:heath': 'natural=heath',
};
const NAMED_PARKS = new Set(['leisure=park', 'landuse=cemetery', 'leisure=recreation_ground', 'leisure=garden']);
const plazas = [];
for (const f of [...D.land_use, ...D.land]) {
  const p = f.properties;
  if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
  if (p.subtype === 'pedestrian') { plazas.push(f); continue; }
  const kind = PARK_KIND[`${p.subtype}:${p.class}`];
  if (!kind) continue;
  const nm = p.names?.primary ?? null;
  for (const poly of polysOf(f.geometry)) for (const pc of clipArea(poly, rect, null, [], p.id)) {
    const o = outPoly(pc, SIMPLIFY_AREA);
    if (!o || Math.abs(signedArea(pc.outer)) < 25) continue;
    // keep public park / cemetery names; a private garden's name may be a property's
    parks.push({ id: uniqueId(shortId(p.id)), kind, name: NAMED_PARKS.has(kind) && nm && !/private/i.test(nm) ? nm : null, ...o });
  }
}
// pedestrian areas and plazas: footways kind pedestrian, area 1
for (const f of plazas) {
  const p = f.properties;
  for (const poly of polysOf(f.geometry)) for (const pc of clipArea(poly, rect, null, [], p.id)) {
    const o = outPoly(pc, SIMPLIFY_AREA);
    if (o && Math.abs(signedArea(pc.outer)) >= 30) footways.push({ id: uniqueId(shortId(p.id)), kind: 'pedestrian', area: 1, name: null, ...o });
  }
}

// ============================================================================================= parking
const parking = [];
for (const f of D.infrastructure) {
  const p = f.properties;
  if (p.class !== 'parking' || !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
  const t = p.source_tags ?? {};
  const type = t.parking ?? 'surface';
  if (type === 'underground' || type === 'multi-storey' || type === 'rooftop') { drop(`parking ${type} (a building)`); continue; }
  for (const poly of polysOf(f.geometry)) for (const pc of clipArea(poly, rect, null, [], p.id)) {
    const area = Math.abs(signedArea(pc.outer));
    if (area < 120) { drop('parking lot < 120 m²'); continue; }
    const o = outPoly(pc, SIMPLIFY_AREA);
    if (!o) continue;
    const cap = Number.parseInt(t.capacity, 10);
    const e = { id: uniqueId(shortId(p.id)), type, capacity: cap > 0 ? cap : Math.max(2, Math.round(area / 26)), pts: o.pts };
    if (!(cap > 0)) e.est = 1;
    if (t.access && t.access !== 'yes') e.access = t.access;
    parking.push(e);
  }
}

// ============================================================================================= buildings
const buildings = [];
const bGrid = new SegGrid(30); // outlines of written buildings, data = { b, ring, c, area }
{
  const partH = new Map(); // building id -> highest part
  for (const f of D.building_part) {
    const p = f.properties;
    const h = p.height ?? (p.num_floors ? p.num_floors * LEVEL_HEIGHT : null);
    if (h && p.building_id) partH.set(p.building_id, Math.max(partH.get(p.building_id) ?? 0, h));
  }
  const groupOf = (p) => {
    const c = p.class ?? '';
    if (['house', 'terrace', 'semidetached_house', 'detached', 'residential'].includes(c) || (!c && p.subtype === 'residential')) return 'home';
    if (['shed', 'garage', 'garages', 'carport', 'roof', 'shelter'].includes(c) || p.subtype === 'outbuilding') return 'small';
    if (['apartments', 'dormitory', 'hotel', 'office'].includes(c)) return 'tall';
    return c || p.subtype || 'other';
  };
  const recs = [];
  for (const f of D.building) {
    const p = f.properties;
    if (p.is_underground || (p.level ?? 0) < 0) { drop('building underground'); continue; }
    for (const poly of polysOf(f.geometry)) {
      let outer = poly[0].pts;
      let area = signedArea(outer);
      if (area < 0) { outer = outer.slice().reverse(); area = -area; }
      if (area < MIN_BUILDING_AREA) { drop('building tiny'); continue; }
      if (Math.abs(signedArea(clipRingSH(outer, rect))) / area < MIN_INSIDE_FRACTION) { drop('building outside crop'); continue; }
      const holes = poly.slice(1).map((h) => (signedArea(h.pts) > 0 ? h.pts.slice().reverse() : h.pts));
      let h = p.height ?? null, src = h ? 'height' : null;
      if (!h && partH.has(p.id)) { h = partH.get(p.id); src = 'parts'; }
      if (!h && p.num_floors) { h = p.num_floors * LEVEL_HEIGHT + 1; src = 'floors'; }
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of outer) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      recs.push({ p, outer, holes, area, h, src, c: centroid(outer), cls: p.class ?? null, group: groupOf(p), bb: [minx, miny, maxx, maxy] });
    }
  }
  // overlapping footprints (two sources for one building, or a part mapped as a building): drop the smaller one if
  // most of it lies inside a larger one
  const share = (a, b) => {
    const [minx, miny, maxx, maxy] = a.bb;
    let n = 0, ins = 0;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const x = minx + ((i + 0.5) / 7) * (maxx - minx), y = miny + ((j + 0.5) / 7) * (maxy - miny);
      if (!pointInRing(x, y, a.outer)) continue;
      n++;
      if (pointInRing(x, y, b.outer)) ins++;
    }
    return n ? ins / n : 0;
  };
  const g = new SegGrid(30);
  for (const r of recs) g.addLine([...r.outer, r.outer[0]], r);
  const gone = new Set();
  let overlapsKept = 0;
  for (const r of recs.slice().sort((a, b) => b.area - a.area)) {
    if (gone.has(r)) continue;
    const seen = new Set();
    g.query(...r.bb, (s) => {
      const o = s.data;
      if (o === r || gone.has(o) || seen.has(o) || o.area > r.area) return true;
      seen.add(o);
      const sh = share(o, r);
      if (sh > OVERLAP_DROP) { gone.add(o); drop('building mostly inside a larger one'); }
      else if (sh > 0.05) overlapsKept++;
      return true;
    });
  }
  stats.overlapsKept = overlapsKept;
  // heights for buildings without one: median of tagged neighbours in the same group, else the class default
  const kg = new SegGrid(NEIGHBOUR_RADIUS);
  for (const r of recs) if (r.h && !gone.has(r)) kg.addLine([r.c, r.c], r);
  const counts = { height: 0, parts: 0, floors: 0, neighbours: 0, class: 0 };
  for (const r of recs) {
    if (gone.has(r)) continue;
    if (!r.h) {
      const hs = [];
      kg.query(r.c[0] - NEIGHBOUR_RADIUS, r.c[1] - NEIGHBOUR_RADIUS, r.c[0] + NEIGHBOUR_RADIUS, r.c[1] + NEIGHBOUR_RADIUS, (s) => {
        const o = s.data;
        if (o.group === r.group && Math.hypot(o.c[0] - r.c[0], o.c[1] - r.c[1]) < NEIGHBOUR_RADIUS) hs.push(o.h);
        return true;
      });
      if (hs.length >= 3) { hs.sort((a, b) => a - b); r.h = hs[hs.length >> 1]; r.src = 'neighbours'; }
      else { r.h = CLASS_HEIGHT[r.cls] ?? DEFAULT_HEIGHT; r.src = 'class'; }
    }
    const pts = outRing(r.outer, SIMPLIFY_BUILDING);
    if (!pts) continue;
    counts[r.src]++;
    const roofH = r.p.roof_height ?? (r.group === 'home' ? 1.5 : 0.8);
    const levels = r.p.num_floors ?? Math.max(1, Math.round((r.h - roofH) / LEVEL_HEIGHT));
    const sub = r.p.subtype;
    const type = r.cls ?? (sub === 'residential' ? 'house' : sub === 'commercial' ? 'commercial' : sub === 'education' ? 'school' : sub === 'religious' ? 'church' : sub === 'outbuilding' ? 'shed' : sub === 'medical' ? 'hospital' : sub === 'civic' ? 'civic' : 'yes');
    const b = { id: uniqueId(shortId(r.p.id, 'b')), h: r1(r.h), type, levels: Math.max(1, Math.min(60, levels)) };
    if (r.src === 'neighbours' || r.src === 'class') b.est = 1;
    if (r.p.min_height > 0.5) b.minH = r1(r.p.min_height);
    if (r.p.roof_shape && r.p.roof_shape !== 'flat') b.roof = r.p.roof_shape;
    b.pts = pts;
    const hs = r.holes.map((h) => outRing(h, SIMPLIFY_BUILDING)).filter(Boolean);
    if (hs.length) b.holes = hs;
    buildings.push(b);
    bGrid.addLine([...r.outer, r.outer[0]], { b, ring: r.outer, c: r.c, area: r.area });
  }
  stats.heights = counts;
}
const buildingAt = (x, y, snap = 0) => {
  let found = null, bd = snap;
  bGrid.query(x - snap, y - snap, x + snap, y + snap, (s) => {
    if (pointInRing(x, y, s.data.ring)) { found = s.data; bd = -1; return false; }
    if (snap > 0) { const d = Math.sqrt(distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by)); if (d < bd) { bd = d; found = s.data; } }
    return true;
  });
  return found;
};

// ============================================================================================= bridge areas
for (const f of D.infrastructure) {
  const p = f.properties;
  if (p.subtype !== 'bridge' || !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
  for (const poly of polysOf(f.geometry)) for (const pc of clipArea(poly, rect, null, [], p.id)) {
    const o = outPoly(pc, SIMPLIFY_AREA);
    if (o) bridges.push({ id: uniqueId(shortId(p.id)), src: 'area', name: streetName(abbreviate(p.names?.primary ?? null)), layer: Number.parseInt(p.source_tags?.layer, 10) || 1, pts: o.pts });
  }
}

// ============================================================================================= POIs
// Overture taxonomy (primary category, then its hierarchy) -> the OSM key=value categories of src/data/poiNames.ts.
// First matching rule wins; categories with no rule are not visitable places for the game (skipped).
const POI_RULES = [
  [/^(coffee_shop|cafe|tea_room|bubble_tea_shop|juice_bar|coffee_roastery)$/, 'amenity=cafe'],
  [/^(bakery|patisserie|bagel_shop|donut_shop)$/, 'shop=bakery'],
  [/^(ice_cream_shop|frozen_yogurt_shop|dessert_shop|gelato)$/, 'amenity=ice_cream'],
  [/^(fast_food_restaurant|sandwich_shop|burger_restaurant|hot_dog|food_truck|chicken_restaurant|salad_shop)$/, 'amenity=fast_food'],
  [/^food_court$/, 'amenity=food_court'],
  [/^(pub|irish_pub|gastropub)$/, 'amenity=pub'],
  [/^(night_club|nightclub|dance_club)$/, 'amenity=nightclub'],
  [/(^|_)bar$|^(brewery|wine_bar|cocktail_bar|lounge|sports_bar|beer_garden|hookah_bar)$/, 'amenity=bar'],
  [/restaurant$|^(diner|bistro|steakhouse|brasserie|eatery|casual_eatery|buffet)$/, 'amenity=restaurant'],
  [/^(hotel|motel|inn|lodging|resort|hostel)$/, 'tourism=hotel'],
  [/^(bed_and_breakfast|guest_house)$/, 'tourism=guest_house'],
  [/^(supermarket|grocery_store|organic_grocery_store|international_grocery_store)$/, 'shop=supermarket'],
  [/^(convenience_store|corner_store|drugstore_convenience)$/, 'shop=convenience'],
  [/^(liquor_store|beer_wine_and_spirits)$/, 'shop=alcohol'],
  [/^(wine_store|wine_shop)$/, 'shop=wine'],
  [/^(deli|delicatessen|cheese_shop)$/, 'shop=deli'],
  [/^(butcher_shop|meat_shop|seafood_market)$/, 'shop=butcher'],
  [/^(chocolatier|chocolate_shop)$/, 'shop=chocolate'],
  [/^(candy_store|confectionery)$/, 'shop=confectionery'],
  [/^(fruit_and_vegetable_store|farmers_market|greengrocer)$/, 'shop=greengrocer'],
  [/^(coffee_and_tea_supplies|tea_store)$/, 'shop=coffee'],
  [/(shoe_store|shoe_shop)/, 'shop=shoes'],
  [/(jewelry_store|watch_store)/, 'shop=jewelry'],
  [/(handbag|luggage|leather_goods)/, 'shop=bag'],
  [/^boutique$/, 'shop=boutique'],
  [/(clothing_store|apparel|fashion|lingerie|bridal|thrift|vintage_clothing|accessories_store)/, 'shop=clothes'],
  [/^(barber|hair_salon|hairdresser|hair_stylist)$/, 'shop=hairdresser'],
  [/^(beauty_salon|nail_salon|spa|day_spa|skin_care|waxing|eyelash_service|massage|tanning_salon|personal_or_beauty_service)$/, 'shop=beauty'],
  [/^(cosmetics_and_beauty_supply|cosmetic_store|beauty_supply)$/, 'shop=cosmetics'],
  [/^(perfume_store)$/, 'shop=perfumery'],
  [/^(tattoo|tattoo_and_piercing|piercing)$/, 'shop=tattoo'],
  [/(optometrist|optician|eyewear)/, 'shop=optician'],
  [/(book_store|bookstore|used_bookstore|comic_books)/, 'shop=books'],
  [/(gift_shop|souvenir|card_shop|party_supply)/, 'shop=gift'],
  [/(furniture_store|mattress)/, 'shop=furniture'],
  [/(home_decor|interior_design|kitchen_supply|lighting_store|rug_store|home_goods|bed_and_bath|hardware_home_and_garden_store)/, 'shop=interior_decoration'],
  [/(antique)/, 'shop=antiques'],
  [/^(art_gallery)$/, 'tourism=gallery'],
  [/(art_supply|framing|art_store)/, 'shop=art'],
  [/(florist|flower)/, 'shop=florist'],
  [/(hardware_store|home_improvement|paint_store|locksmith)/, 'shop=hardware'],
  [/(electronics|computer_store|camera_store|appliance)/, 'shop=electronics'],
  [/(mobile_phone|cell_phone)/, 'shop=mobile_phone'],
  [/(bicycle|bike_shop|bike_repair)/, 'shop=bicycle'],
  [/(sporting_goods|sports_wear|golf_shop|running_store)/, 'shop=sports'],
  [/(outdoor_gear|camping|hunting)/, 'shop=outdoor'],
  [/(toy_store|hobby_shop|game_store)/, 'shop=toys'],
  [/(music_store|record_store|musical_instrument)/, 'shop=music'],
  [/(pet_store|pet_supplies|pet_groomer)/, 'shop=pet'],
  [/(tobacco|vape|cigar)/, 'shop=tobacco'],
  [/(dry_cleaning|tailor|alterations)/, 'shop=dry_cleaning'],
  [/(laundromat|laundry)/, 'shop=laundry'],
  [/(stationery|office_supplies|print_shop)/, 'shop=stationery'],
  [/^(department_store|shopping_mall|shopping_center)$/, 'shop=department_store'],
  [/(variety_store|discount_store|dollar_store|general_store|specialty_store|shopping|retail)/, 'shop=variety_store'],
  [/(bank|credit_union)/, 'amenity=bank'],
  [/^atm$/, 'amenity=atm'],
  [/(pharmacy|drugstore)/, 'amenity=pharmacy'],
  [/^(hospital|emergency_room|medical_center)$/, 'amenity=hospital'],
  [/(dentist|dental|orthodont)/, 'amenity=dentist'],
  [/(urgent_care|clinic|outpatient_care)/, 'amenity=clinic'],
  [/(doctor|physician|pediatric|dermatolog|family_practice|primary_care|internal_medicine|obstetrics|chiropract|physical_therapy)/, 'amenity=doctors'],
  [/(veterinar|animal_hospital)/, 'amenity=veterinary'],
  [/(gym|fitness|yoga|pilates|boxing|martial_arts|cycling_studio|crossfit|climbing)/, 'leisure=fitness_centre'],
  [/(dance_studio|dance_school)/, 'leisure=dance'],
  [/(sports_club|sports_center|recreation_center|swimming_pool|tennis|rowing|boating_club)/, 'leisure=sports_centre'],
  [/(marina|boat_rental|kayak|canoe|boat_tour)/, 'amenity=boat_rental'],
  [/^(preschool|child_care|day_care|nursery_school|kindergarten)$/, 'amenity=kindergarten'],
  [/(college_university|university|college)/, 'amenity=university'],
  [/(school|academy|high_school|elementary|middle_school)$/, 'amenity=school'],
  [/(library)/, 'amenity=library'],
  [/(place_of_worship|church|cathedral|chapel|synagogue|mosque|temple)/, 'amenity=place_of_worship'],
  [/(museum)/, 'tourism=museum'],
  [/(theatre|theater|performing_arts|concert_hall|opera)/, 'amenity=theatre'],
  [/(movie_theater|cinema)/, 'amenity=cinema'],
  [/(arts_center|art_center|community_center|cultural_center)/, 'amenity=community_centre'],
  [/^post_office$|shipping_center/, 'amenity=post_office'],
  [/^(police_department|police_station|police)$/, 'amenity=police'],
  [/^fire_station$|fire_department/, 'amenity=fire_station'],
  [/(car_dealer|auto_dealer|car_dealership|used_car)/, 'shop=car'],
  [/(auto_repair|car_repair|auto_body|tire_shop|oil_change|auto_parts)/, 'shop=car_repair'],
  [/(gas_station|fuel)/, 'amenity=fuel'],
  [/(car_rental|truck_rental)/, 'amenity=car_rental'],
  [/(car_wash)/, 'amenity=car_wash'],
  [/(historic_site|monument|memorial|landmark_and_historical_building|tourist_attraction|attraction|viewpoint)/, 'tourism=attraction'],
  [/(embassy|consulate)/, 'office=diplomatic'],
  [/(government|city_hall|courthouse|town_hall|public_service)/, 'office=government'],
  [/(attorney|lawyer|law_firm|legal)/, 'office=lawyer'],
  [/(real_estate)/, 'office=estate_agent'],
  [/(insurance)/, 'office=insurance'],
  [/(software|information_technology|it_service|web_design|computer)/, 'office=it'],
  [/(consult|professional_service|corporate|business|financial|accountant|architect|marketing|advertising|public_relations|media|publisher|design_service|engineering|employment|non_profit|charity|association|organization)/, 'office=company'],
];
const CUISINE = /^(italian|american|french|mexican|japanese|thai|indian|mediterranean|seafood|chinese|vietnamese|lebanese|spanish|greek|korean|middle_eastern|ethiopian|peruvian|turkish|sushi|pizza|burger|steakhouse|vegan|vegetarian|tapas|ramen|latin_american|asian_fusion|new_american|southern|cajun|caribbean|brazilian|german|british|irish|afghan|persian|pakistani|nepalese|moroccan)_restaurant$/;
function poiCat(p) {
  const tx = p.taxonomy ?? {};
  const cands = [tx.primary, p.basic_category, ...(tx.hierarchy ?? []).slice().reverse(), ...(tx.alternates ?? [])].filter(Boolean);
  for (const c of cands) for (const [re, cat] of POI_RULES) if (re.test(c)) return { cat, src: c };
  return null;
}
const pois = [];
{
  const offices = new Map();
  const unmapped = new Map();
  const seenSpot = new Set();
  const list = D.place.map((f) => ({ f, p: f.properties })).filter(({ f, p }) => f.geometry?.type === 'Point' && (p.confidence ?? 0) >= POI_MIN_CONFIDENCE && !/closed/.test(p.operating_status ?? ''));
  list.sort((a, b) => (b.p.confidence ?? 0) - (a.p.confidence ?? 0) || String(a.p.id).localeCompare(String(b.p.id)));
  for (const { f, p } of list) {
    const [x, y] = fwd(f.geometry.coordinates);
    if (!inRect(x, y)) continue;
    const m = poiCat(p);
    if (!m) { const k = p.taxonomy?.primary ?? p.basic_category ?? 'none'; unmapped.set(k, (unmapped.get(k) ?? 0) + 1); continue; }
    const isOffice = m.cat.startsWith('office=');
    if (isOffice && (p.confidence ?? 0) < OFFICE_MIN_CONFIDENCE) { drop('place office below confidence'); continue; }
    const b = buildingAt(x, y, POI_BUILDING_SNAP);
    if (isOffice && b) {
      const n = offices.get(b.b.id) ?? 0;
      if (n >= MAX_OFFICES_PER_BUILDING) { drop('place office over the per-building cap'); continue; }
      offices.set(b.b.id, n + 1);
    }
    const spot = `${m.cat}@${Math.round(x / 3)},${Math.round(y / 3)}`;
    if (seenSpot.has(spot)) { drop('place duplicate category at the same spot'); continue; }
    seenSpot.add(spot);
    const e = { id: uniqueId(shortId(p.id, 'p')), x: r1(x), z: r1(-y), cat: m.cat };
    const cu = CUISINE.exec(p.taxonomy?.primary ?? '');
    if (cu) e.subcat = cu[1].replace('_restaurant', '');
    else if (m.cat === 'amenity=place_of_worship' && /christian|church|cathedral|chapel/.test(m.src)) e.subcat = 'christian';
    if (b) e.b = b.b.id;
    pois.push(e);
  }
  stats.poiUnmapped = [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 25);
}

// ============================================================================================= props
const props = [];
const PROP_CLASS = {
  traffic_signals: 'signals', stop: 'stop', street_lamp: 'lamp', bench: 'bench', waste_basket: 'bin', bus_stop: 'bus_stop', fire_hydrant: 'hydrant',
  bicycle_parking: 'bike_rack', bicycle_rental: 'bike_dock', post_box: 'post_box', drinking_water: 'water_tap', fountain: 'fountain', information: 'info',
  artwork: 'artwork', vending_machine: 'vending', charging_station: 'charger', parking_entrance: 'parking_entrance', recycling: 'recycling', bollard: 'bollard',
};
const realProps = [];
for (const f of D.infrastructure) {
  const p = f.properties;
  const kind = PROP_CLASS[p.class];
  if (!kind || f.geometry?.type !== 'Point') continue;
  const [x, y] = fwd(f.geometry.coordinates);
  if (!inRect(x, y)) continue;
  realProps.push([x, y, kind]);
}
for (const f of D.land) {
  const p = f.properties;
  if (p.class === 'tree' && f.geometry?.type === 'Point') { const [x, y] = fwd(f.geometry.coordinates); if (inRect(x, y)) realProps.push([x, y, 'tree']); }
  else if (p.class === 'tree_row' && f.geometry?.type === 'LineString') sampleLine(f.geometry.coordinates.map(fwd), 8, (x, y) => { if (inRect(x, y)) realProps.push([x, y, 'tree']); });
}
// signals and stop signs sit on a junction node (the world generator reads them by node coordinates): mapped on the
// approach nodes, they snap to the nearest junction vertex (a vertex shared by roads with 3+ arms)
{
  const arms = new Map(); // output key -> arm count
  const where = new Map();
  for (const r of roads) r.pts.forEach((q, i) => {
    const k = `${q[0]},${q[1]}`;
    arms.set(k, (arms.get(k) ?? 0) + (i === 0 || i === r.pts.length - 1 ? 1 : 2));
    where.set(k, q);
  });
  const jn = [...arms].filter(([, n]) => n >= 3).map(([k]) => where.get(k));
  const jg = new SegGrid(SIGNAL_SNAP);
  for (const q of jn) jg.addLine([[q[0], -q[1]], [q[0], -q[1]]], q);
  const placed = new Map();
  let unsnapped = 0;
  for (const rp of realProps) {
    if (rp[2] !== 'signals' && rp[2] !== 'stop') continue;
    let best = null, bd = SIGNAL_SNAP;
    jg.query(rp[0] - SIGNAL_SNAP, rp[1] - SIGNAL_SNAP, rp[0] + SIGNAL_SNAP, rp[1] + SIGNAL_SNAP, (s) => { const d = Math.hypot(s.ax - rp[0], s.ay - rp[1]); if (d < bd) { bd = d; best = s.data; } return true; });
    if (!best) { unsnapped++; continue; }
    const k = `${best[0]},${best[1]}`;
    if (placed.get(k) === 'signals') continue;
    placed.set(k, rp[2]);
  }
  for (const [k, kind] of placed) { const q = where.get(k); props.push([q[0], q[1], kind]); }
  stats.signals = { junctionsWithSignals: [...placed.values()].filter((v) => v === 'signals').length, withStop: [...placed.values()].filter((v) => v === 'stop').length, notNearAJunction: unsnapped };
}
for (const rp of realProps) if (rp[2] !== 'signals' && rp[2] !== 'stop') props.push([r1(rp[0]), r1(-rp[1]), rp[2]]);

// ---- synthesized street furniture (4th element 1 = synth), never on top of real features
{
  const near = new SegGrid(10);
  const kindsNear = (x, y, r, kind) => {
    let hit = false;
    near.query(x - r, y - r, x + r, y + r, (s) => { if ((!kind || s.data === kind) && Math.hypot(s.ax - x, s.ay - y) < r) { hit = true; return false; } return true; });
    return hit;
  };
  for (const pr of props) near.addLine([[pr[0], -pr[1]], [pr[0], -pr[1]]], pr[2]);
  const roadG = new SegGrid(25);
  for (const r of roads) if (!r.tunnel && !r.bridge) roadG.addLine(r.pts.map(([x, z]) => [x, -z]), r);
  const onCarriageway = (x, y) => {
    let hit = false;
    roadG.query(x - 20, y - 20, x + 20, y + 20, (s) => { if (Math.sqrt(distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by)) < s.data.width / 2 + 0.3) { hit = true; return false; } return true; });
    return hit;
  };
  const crossG = new SegGrid(25);
  for (const f of footways) if (f.kind === 'crossing') crossG.addLine(f.pts.map(([x, z]) => [x, -z]), 1);
  const ends = new SegGrid(25); // junction vertices (driveways and side streets): keep corners clear
  for (const r of roads) for (const q of [r.pts[0], r.pts[r.pts.length - 1]]) ends.addLine([[q[0], -q[1]], [q[0], -q[1]]], r);
  // shopping streets: shops / food / drink places per 100 m within 30 m
  const shopG = new SegGrid(30);
  for (const p of pois) if (/^(shop|amenity=(cafe|restaurant|bar|pub|fast_food|ice_cream))/.test(p.cat)) shopG.addLine([[p.x, -p.z], [p.x, -p.z]], 1);
  const addAt = (x, y, kind) => {
    if (!inRect(x, y, -2) || kindsNear(x, y, SYNTH.clearReal[kind] ?? 3, kind) || kindsNear(x, y, SYNTH.clearAny) || onCarriageway(x, y) || buildingAt(x, y, 0.8) || crossG.near(x, y, 5)) return false;
    let corner = false;
    ends.query(x - 9, y - 9, x + 9, y + 9, (s) => { if (Math.hypot(s.ax - x, s.ay - y) < 9) { corner = true; return false; } return true; });
    if (corner && kind !== 'hydrant') return false;
    props.push([r1(x), r1(-y), kind, 1]);
    near.addLine([[x, y], [x, y]], kind);
    return true;
  };
  const synthCount = {};
  for (const r of roads) {
    if (r.sidewalk !== 'separate' || r.tunnel || r.bridge || !STREET_CLASSES.has(r.highway)) continue;
    const pts = r.pts.map(([x, z]) => [x, -z]);
    const L = lineLength(pts);
    if (L < 20) continue;
    let shops = 0;
    sampleLine(pts, 10, (x, y) => { shopG.query(x - 30, y - 30, x + 30, y + 30, (s) => { if (Math.hypot(s.ax - x, s.ay - y) < 30) shops += 0.1; return true; }); });
    const shopping = (shops / Math.max(1, L)) * 100 >= SYNTH.shopsPer100m && ['primary', 'secondary', 'tertiary'].includes(r.highway);
    const hw = r.width / 2;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const along = (step, offset, kind, phase) => {
      for (const side of [-1, 1]) {
        let i = 1;
        for (let s = phase; s < L - 8; s += step) {
          if (s < 8) continue;
          while (i < cum.length - 1 && cum[i] < s) i++;
          const ax = pts[i - 1][0], ay = pts[i - 1][1], l = cum[i] - cum[i - 1] || 1;
          const ux = (pts[i][0] - ax) / l, uy = (pts[i][1] - ay) / l, u = s - cum[i - 1];
          // right of travel in the internal (y north) frame is (uy, -ux)
          const o = (hw + offset) * side;
          const x = ax + ux * u + uy * o, y = ay + uy * u - ux * o;
          if (addAt(x, y, kind)) synthCount[kind] = (synthCount[kind] ?? 0) + 1;
        }
      }
    };
    if (shopping) {
      along(SYNTH.streetTreeStep, SYNTH.treeKerbOffset, 'tree', 6);
      along(SYNTH.benchStep, 1.6, 'bench', 20);
      along(SYNTH.binStep, 0.6, 'bin', 33);
    }
    along(SYNTH.lampStep, SYNTH.lampKerbOffset, 'lamp', 10);
    along(SYNTH.hydrantStep, 0.45, 'hydrant', 15);
  }
  stats.synth = synthCount;
}
props.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]));

// ============================================================================================= terrain
const heights = (() => {
  const meta = JSON.parse(readFileSync(`${CACHE}/terrain/tiles.json`, 'utf8'));
  const tw = meta.x1 - meta.x0 + 1, th = meta.y1 - meta.y0 + 1, W = tw * 256, H = th * 256;
  const E = new Float32Array(W * H);
  for (let tx = 0; tx < tw; tx++) for (let ty = 0; ty < th; ty++) {
    const img = decodePng(readFileSync(`${CACHE}/terrain/${meta.z}/${meta.x0 + tx}/${meta.y0 + ty}.png`));
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const o = (y * 256 + x) * img.bpp;
      E[(ty * 256 + y) * W + tx * 256 + x] = img.px[o] * 256 + img.px[o + 1] + img.px[o + 2] / 256 - 32768;
    }
  }
  const n = 2 ** meta.z;
  /** elevation (m) at internal (x, y) by bilinear interpolation of the web-mercator mosaic */
  const dem = (x, y) => {
    const [lon, lat] = inv(x, y);
    const fx = ((lon + 180) / 360) * n * 256 - meta.x0 * 256 - 0.5;
    const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n * 256 - meta.y0 * 256 - 0.5;
    const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const u = Math.max(0, Math.min(1, fx - ix)), v = Math.max(0, Math.min(1, fy - iy));
    const o = iy * W + ix;
    return (E[o] * (1 - u) + E[o + 1] * u) * (1 - v) + (E[o + W] * (1 - u) + E[o + W + 1] * u) * v;
  };
  // river surface: median of the DEM over the Potomac (lidar water is flattened)
  const river = riverPolys[0]?.ring ?? null;
  const samples = [];
  if (river) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of river) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    for (let y = miny; y < maxy; y += 15) for (let x = minx; x < maxx; x += 15) if (pointInRing(x, y, river)) samples.push(dem(x, y));
  }
  samples.sort((a, b) => a - b);
  const riverLevel = samples.length ? samples[samples.length >> 1] : 0;
  const sp = args.spacing;
  const x0 = rect.x0, z0 = -rect.y1;
  const nx = Math.ceil((rect.x1 - rect.x0) / sp) + 1, nz = Math.ceil((rect.y1 - rect.y0) / sp) + 1;
  const data = new Array(nx * nz);
  const rivers = riverPolys.map((r) => r.ring);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const x = x0 + ix * sp, y = -(z0 + iz * sp);
    let h = dem(x, y) - riverLevel;
    if (rivers.some((rg) => pointInRing(x, y, rg))) h = RIVER_BED;
    data[iz * nx + ix] = r1(h);
  }
  return { grid: { spacing: sp, x0: r1(x0), z0: r1(z0), nx, nz, data }, dem: (x, y) => dem(x, y) - riverLevel, riverLevel, demZoom: meta.z, demPx: (40075016.7 * Math.cos(P0)) / (n * 256) };
})();

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y > 0 ? px[dst - stride + x] : 0, c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

// ============================================================================================= canal and creek levels
const canalInfo = (() => {
  if (!canalW.pts) return null;
  const pts = canalW.pts.map(([x, z]) => [x, -z]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const project = (x, y) => {
    let best = { s: 0, d: Infinity, x: 0, y: 0 };
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1], dx = pts[i][0] - ax, dy = pts[i][1] - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(qx - x, qy - y);
      if (d < best.d) best = { s: cum[i - 1] + t * Math.sqrt(L2), d, x: qx, y: qy };
    }
    return best;
  };
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const u = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  };
  // locks: the data's lock chambers (water polygons tagged lock) along the canal, numbered by their names
  const locks = [];
  for (const w of water) {
    if (w.kind !== 'lock' || !/^Lock [1-9]/.test(w.name ?? '')) continue;
    const ring = w.pts.map(([x, z]) => [x, -z]);
    const ss = ring.map(([x, y]) => project(x, y)).filter((q) => q.d < 25).map((q) => q.s);
    if (ss.length < 3) continue;
    locks.push({ name: w.name, s0: Math.min(...ss), s1: Math.max(...ss) });
  }
  locks.sort((a, b) => a.s0 - b.s0);
  // pound levels: median DEM on the centre line between locks (the canal runs east -> west, so s grows westward)
  const bounds = [0, ...locks.flatMap((l) => [l.s0, l.s1]), cum[cum.length - 1]];
  const levels = [];
  for (let k = 0; k < bounds.length; k += 2) {
    const a = bounds[k] + 8, b = bounds[k + 1] - 8;
    const hs = [];
    for (let s = a; s < b; s += 4) { const [x, y] = at(s); hs.push(heights.dem(x, y)); }
    hs.sort((p, q) => p - q);
    levels.push(hs.length ? r1(hs[Math.floor(hs.length * 0.3)]) : null);
  }
  // pounds east of the first lock to the west of the last, as the world reads them (west first)
  const westFirst = levels.slice().reverse();
  for (let i = 0; i < westFirst.length; i++) if (westFirst[i] === null) westFirst[i] = westFirst[i - 1] ?? westFirst[i + 1] ?? 0;
  const gates = [];
  for (const l of locks) for (const s of [l.s0, l.s1]) { const [x, y] = at(s); gates.push([r1(x), r1(-y), 'lock_gate']); }
  return { levels: westFirst, locks: locks.map((l) => { const [x, y] = at((l.s0 + l.s1) / 2); return { name: l.name, x: r1(x), z: r1(-y), length: r1(l.s1 - l.s0) }; }), gates };
})();
if (canalInfo) props.push(...canalInfo.gates);
// Rock Creek: water level per vertex from the DEM (lowest within 4 m of the line), smoothed and never rising downstream
if (creekW.pts) {
  const pts = creekW.pts.map(([x, z]) => [x, -z]);
  const raw = pts.map(([x, y]) => {
    let m = Infinity;
    for (let a = 0; a < 8; a++) for (const r of [0, 2, 4]) m = Math.min(m, heights.dem(x + Math.cos(a) * r, y + Math.sin(a) * r));
    return m;
  });
  for (let i = 1; i < raw.length; i++) raw[i] = Math.min(raw[i], raw[i - 1]); // flows north -> south (downstream = later)
  const sm = raw.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 3); k <= Math.min(raw.length - 1, i + 3); k++) { s += raw[k]; n++; } return s / n; });
  for (let i = 1; i < sm.length; i++) sm[i] = Math.min(sm[i], sm[i - 1]);
  creekW.levels = sm.map((v) => r1(Math.max(0, v)));
}

// ============================================================================================= assemble
const towpath = footways.filter((f) => f.towpath).map((f) => f.id);
const landmarks = {
  canal: { waterways: canalW.pts ? [canalW.id] : [], water: water.filter((w) => w.kind === 'canal' || w.kind === 'lock').map((w) => w.id), levels: canalInfo?.levels ?? [], locks: canalInfo?.locks ?? [] },
  towpath,
};
const counts = { roads: roads.length, footways: footways.length, buildings: buildings.length, pois: pois.length, water: water.length, waterways: waterways.length, parks: parks.length, parking: parking.length, bridges: bridges.length, props: props.length };
const W = rect.x1 - rect.x0, H = rect.y1 - rect.y0;
const doc = {
  meta: {
    format: FORMAT,
    synthetic: false,
    source: `Overture Maps Foundation release ${release.release} (s3://${release.bucket}), fetched ${release.fetchedAt}; AWS Terrain Tiles terrarium z${heights.demZoom}`,
    sourceNote: 'Real data: roads, paths, buildings, water, parks and street furniture from OpenStreetMap via Overture Maps; places from Overture (categories only); terrain from USGS 3DEP via AWS Terrain Tiles. Props flagged with a 4th element 1 are synthesized.',
    osmBase: null,
    bbox: release.box,
    crop: { ...CROP, widthM: r1(W), heightM: r1(H) },
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    metresPerDegree: { lat: r1(mLat), lon: r1(mLon) },
    frame: 'equirectangular around origin; x east, z south, y up; metres rounded to 0.1',
    bounds: { x0: r1(rect.x0), z0: r1(-rect.y1), x1: r1(rect.x1), z1: r1(-rect.y0) },
    winding: 'outer rings counter-clockwise on a north-up map (negative shoelace area in raw x,z), holes the other way; rings do not repeat the first point',
    units: { maxspeed: 'km/h', h: 'm', width: 'm kerb to kerb', heights: 'm above the Potomac surface (river level 0)' },
    notes: 'ids: g/b/p + the first 12 hex digits of the Overture GERS id (stable across releases), .n when one feature became several pieces (split by bridge/tunnel/level/subclass rules or the crop). Road and path vertices at Overture connectors are kept and identical in every way that meets there, so graphs can be built by matching coordinates. Roads: lanes and width are estimates by class (est: 1) unless the data has a width; sidewalk=separate where mapped sidewalks run alongside. Washington Circle is one closed road with junction=roundabout. Buildings: h from Overture height (OSM or USGS lidar), building parts or floors, else the median of neighbours of the same kind or a class default (est: 1). POIs: category only (OSM key=value from the Overture taxonomy), b = building id. Props: [x, z, kind] real, [x, z, kind, 1] synthesized. landmarks.canal.levels: canal water levels west to east between the locks (lock_gate props mark both ends of each chamber); waterways creek.levels: Rock Creek water level per vertex. heights: grid of terrain heights relative to the river, data[iz * nx + ix] at (x0 + ix * spacing, z0 + iz * spacing).',
    simplify: { line: SIMPLIFY_LINE, area: SIMPLIFY_AREA, building: SIMPLIFY_BUILDING },
    attribution: ATTRIBUTION.replace('{release}', release.release),
    licence: LICENCE,
    generator: { script: 'scripts/importOverture.mjs', fetch: 'scripts/fetchOverture.py' },
    generatedAt: new Date().toISOString(),
    counts,
  },
  roads, footways, buildings, pois, water, waterways, parks, parking, bridges, landmarks, props,
  heights: heights.grid,
};
const text = toJson(doc);
mkdirSync(dirname(args.out) || '.', { recursive: true });
writeFileSync(args.out, text);
const bytes = Buffer.byteLength(text);

// ============================================================================================= report
const km = (list) => (list.reduce((s, e) => s + (e.pts && !e.area ? lineLength(e.pts) : 0), 0) / 1000).toFixed(1);
const by = (list, f) => { const m = new Map(); for (const e of list) { const k = f(e); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
const L = [];
L.push(`Overture import: release ${release.release} -> ${args.out} (${(bytes / 1048576).toFixed(2)} MB${bytes > SIZE_TARGET ? ', OVER the 3 MB target' : ''}) in ${((performance.now() - T0) / 1000).toFixed(1)} s`);
L.push(`  crop ${CROP.minlon},${CROP.minlat} .. ${CROP.maxlon},${CROP.maxlat} = ${Math.round(W)} m x ${Math.round(H)} m; bounds x ${r1(rect.x0)}..${r1(rect.x1)}, z ${r1(-rect.y1)}..${r1(-rect.y0)}`);
L.push(`  roads ${roads.length} (${km(roads)} km): ${by(roads, (r) => r.highway).map(([k, v]) => `${k} ${v}`).join(', ')}`);
L.push(`    one-way ${roads.filter((r) => r.oneway).length}, bridge pieces ${roads.filter((r) => r.bridge).length}, tunnel ${roads.filter((r) => r.tunnel).length}, layers ${by(roads.filter((r) => r.layer), (r) => r.layer).map(([k, v]) => `${k}:${v}`).join(' ')}, width from data ${roads.filter((r) => !r.est).length}, sidewalk=separate ${roads.filter((r) => r.sidewalk === 'separate').length}`);
L.push(`  footways ${footways.length} (${km(footways)} km): ${by(footways, (f) => f.kind).map(([k, v]) => `${k} ${v}`).join(', ')}; towpath pieces ${towpath.length}`);
L.push(`  buildings ${buildings.length}: heights ${JSON.stringify(stats.heights)}; overlaps kept (5-60%) ${stats.overlapsKept}`);
L.push(`  pois ${pois.length}: ${by(pois, (p) => p.cat).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', ')}`);
L.push(`    unmapped categories (skipped): ${stats.poiUnmapped.slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', ')}`);
L.push(`  water ${water.length}: ${by(water, (w) => w.kind).map(([k, v]) => `${k} ${v}`).join(', ')}; waterways ${waterways.map((w) => `${w.name} ${Math.round(lineLength(w.pts))} m`).join(', ')}`);
L.push(`  canal: ${landmarks.canal.locks.length} locks ${landmarks.canal.locks.map((l) => `${l.name} (${l.length} m)`).join(', ')}; levels west->east ${landmarks.canal.levels.join(', ')} m; creek levels ${creekW.levels ? `${creekW.levels[0]} .. ${creekW.levels[creekW.levels.length - 1]} m` : 'none'}`);
L.push(`  parks ${parks.length}: ${by(parks, (p) => p.kind).map(([k, v]) => `${k} ${v}`).join(', ')}; parking lots ${parking.length} (${parking.reduce((s, p) => s + p.capacity, 0)} spaces); bridges ${bridges.length}`);
L.push(`  props ${props.length}: ${by(props, (p) => `${p[2]}${p[3] ? '*' : ''}`).map(([k, v]) => `${k} ${v}`).join(', ')} (* synth)`);
L.push(`  signals: ${JSON.stringify(stats.signals)}`);
L.push(`  terrain: z${heights.demZoom} (${heights.demPx.toFixed(1)} m/px) resampled to ${args.spacing} m (${heights.grid.nx} x ${heights.grid.nz}); river surface at ${heights.riverLevel.toFixed(2)} m NAVD88 = 0; range ${heights.grid.data.reduce((a, b) => Math.min(a, b))} .. ${heights.grid.data.reduce((a, b) => Math.max(a, b))} m`);
L.push(`  dropped: ${Object.entries(stats.dropped).map(([k, v]) => `${k} ${v}`).join('; ')}`);
for (const n of stats.notes) L.push(`  note: ${n}`);
console.log(L.join('\n'));
if (args.report) writeFileSync(args.report, JSON.stringify({ stats, counts }, null, 1));
