#!/usr/bin/env node
// Georgetown map data from a hand-authored spec (Milestone 3), for when no OpenStreetMap download is available.
//
//   node scripts/georgetownFromSpec.mjs [spec.json] [--out <file>] [--seed <n>] [--report-json <file>]
//   npm run gen-georgetown
//
// Reads data/georgetown-spec.json: streets, water, areas, landmarks, street character and spot heights as lat/lon,
// reconstructed from general geographic knowledge (NOT OpenStreetMap data and not survey-accurate: expect 20-80 m of
// error). Writes src/data/georgetown.json in the format of scripts/importOsm.mjs ("open-city-osm-1"), so a real OSM
// import can replace it later without changing game code. Whatever the spec cannot give is synthesized,
// deterministically for a given --seed (only meta.generatedAt changes between runs):
//   - building footprints along every street frontage, landmark buildings and a campus (every building has synth: true)
//   - POIs by street character (categories only, never names), car parks and a car-dealer lot
//   - sidewalks with corners and crossings, the towpath and its links, park paths, a waterfront promenade, docks
//   - street props (signals, stop signs, trees, lamps, benches, bus stops, lock gates, fountains)
//   - a smooth heightfield fitted to the spot heights
// It then validates the result (road graph connectivity, roundabout, intersections, buildings on roads, overlaps,
// file size) and prints a report. To make a real OSM import line up with this file, run the importer with the same
// crop: node scripts/importOsm.mjs --crop -77.074,38.899,-77.048,38.914
//
// Output frame: x east, z SOUTH, y up, metres, origin at the crop centre; the crop is the spec bbox.
// Plain Node ESM, no dependencies. The numbers here shape the generated data file, not gameplay (that is src/tuning.ts).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================================== constants
const DEFAULT_SPEC = 'data/georgetown-spec.json';
const DEFAULT_OUT = 'src/data/georgetown.json';
const FORMAT = 'open-city-osm-1'; // same as scripts/importOsm.mjs
const DEFAULT_SEED = 1789;
const ATTRIBUTION = 'Hand-authored approximation of Georgetown, Washington DC (not OpenStreetMap data); buildings, POIs, sidewalks, props and heights are synthesized.';

const LANE_WIDTH = 3.3; // m per lane: road width = lanes * LANE_WIDTH
const SIDEWALK_OFFSET = 1.5; // m from the kerb to the sidewalk centre line
const SIDEWALK_WIDTH = 3; // m, kerb to back of sidewalk
const BUILDING_SETBACK = 1; // m behind the back of the sidewalk
const NO_SIDEWALK_CLEAR = 2.5; // m beyond the kerb for roads without sidewalks (parkway, Canal Rd, tunnel)
const ELEVATED_CLEAR = 3; // m beyond the edge of an elevated road / high bridge
/** Layer of elevated roads: the Whitehurst Freeway runs directly above the (layer 1) K St bridge over Rock Creek. */
const ELEVATED_LAYER = 2;
const LOT_CLEAR = 0.5; // m between a car park and the back of the sidewalk
const CANAL_HALF_WIDTH = 6; // m, C&O Canal water
const CANAL_BRIDGE_HALF_SPAN = 13; // m either side of the canal centre line: street bridges also clear the towpath
const CREEK_HALF_WIDTH = { north: 7, mouth: 12 }; // m, Rock Creek water, widening toward the Potomac
const RIVER_CENTRE_OFFSET = 230; // m from the north shore to the Potomac centre line
const WATER_MARGIN = 2; // m, buildings keep this far from water
const PARK_MARGIN = 1; // m, buildings keep this far from parks, plazas and car parks
const FOOT_CLEAR = { path: 2.5, cycleway: 2.5, footway: 2, steps: 2 }; // m from a footway centre line to a building
const CORNER_MAX = 30; // m, longest sidewalk corner reach at sharp junctions
const REFLEX = 0.6; // rad past a straight line where an outside sidewalk corner becomes an arc
const CROSSING_GAP = 1.5; // m between a sidewalk corner and the crossing
const LEVEL_HEIGHT = 3.2; // m per storey, as in importOsm.mjs
const HEIGHT_SPACING = 10; // m, heightfield grid
const RIVER_BANK_HEIGHT = 1.0; // m above river level at the shoreline
const RIVER_BED = -2; // m, heightfield value under the Potomac
const CREEK_DEPTH = 1.2; // m below the creek's water level
const LAND_MIN = 0.6; // m, lowest dry land
const SIZE_TARGET = 3 * 1024 * 1024;
const OVERLAP_TOL = 0.05; // m, buildings may touch (party walls) but not overlap

/** km/h. DC: 20 mph on local streets, 25 mph on arterials. Per-street "maxspeed" in the spec overrides. */
const MAXSPEED = { trunk: 56, primary: 40, secondary: 40, tertiary: 40, residential: 32, service: 24, unclassified: 32 };
const MAXSPEED_BY_NAME = { 'Rock Creek and Potomac Parkway': 48, 'Canal Rd NW': 48 };
const HIGHWAY = { freeway: 'trunk', motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', residential: 'residential', service: 'service', unclassified: 'unclassified' };
const FOOT_KINDS = new Set(['footway', 'path', 'cycleway', 'steps']);
const NO_SIDEWALK = new Set(['Rock Creek and Potomac Parkway', 'Canal Rd NW']);
const SURFACE_BY_NAME = { 'O St NW': 'sett' };
/** Streets checked by the overlap report (as in importOsm.mjs: not service roads or freeways). */
const STREET_TYPES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential']);

// ----------------------------------------------------------------------------------- building zones
// w = frontage width, d = depth, dMin = shallowest allowed (corners), levels = storeys, gap = space between buildings,
// setback = extra front garden, runLevels = chance a rowhouse keeps its neighbour's height, poiP = chance of a POI.
const ZONES = {
  shopping: { w: [6, 15], d: [16, 26], dMin: 9, levels: [2, 4], types: [['retail', 0.8], ['commercial', 0.2]], roof: 0.8, poiP: 0.92, pois: 'shopping' },
  bookhill: { w: [6, 12], d: [12, 20], dMin: 8, levels: [2, 3], types: [['retail', 0.7], ['terrace', 0.3]], roof: 0.8, poiP: 0.7, pois: 'bookhill' },
  waterfront: { w: [18, 40], d: [18, 34], dMin: 12, levels: [4, 6], types: [['commercial', 0.6], ['apartments', 0.4]], roof: 1.2, gap: [0, 4], poiP: 0.85, pois: 'waterfront' },
  warehouse: { w: [12, 30], d: [14, 28], dMin: 9, levels: [3, 5], types: [['warehouse', 0.5], ['commercial', 0.5]], roof: 1, poiP: 0.55, pois: 'canal' },
  prospect: { w: [5, 8], d: [12, 18], dMin: 8, levels: [2, 4], types: [['terrace', 0.65], ['retail', 0.35]], roof: 1, runLevels: 0.5, poiP: 0.3, pois: 'prospect' },
  rowhouse: { w: [5, 8], d: [12, 18], dMin: 8, levels: [2, 4], types: [['terrace', 0.93], ['house', 0.07]], roof: 1, runLevels: 0.6, poiP: 0, cornerP: 0.15, pois: 'corner' },
  campusedge: { w: [5, 8], d: [12, 18], dMin: 8, levels: [2, 3], types: [['terrace', 1]], roof: 1, runLevels: 0.6, poiP: 0.1, pois: 'campus' },
  mansion: { w: [12, 20], d: [12, 18], dMin: 10, levels: [2, 3], types: [['house', 1]], roof: 2.5, gap: [5, 12], setback: [3, 9], poiP: 0 },
  westend: { w: [20, 45], d: [22, 40], dMin: 14, levels: [6, 10], types: [['commercial', 0.55], ['apartments', 0.45]], roof: 1.5, gap: [0, 3], poiP: 0.65, pois: 'westend' },
  foggy: { w: [20, 40], d: [20, 35], dMin: 12, levels: [4, 8], types: [['university', 0.6], ['apartments', 0.25], ['commercial', 0.15]], roof: 1.5, gap: [0, 6], poiP: 0.35, pois: 'foggy' },
  dupont: { w: [6, 9], d: [14, 20], dMin: 9, levels: [3, 4], types: [['terrace', 0.75], ['apartments', 0.25]], roof: 1.2, runLevels: 0.5, poiP: 0.04, pois: 'corner' },
};
/** Order in which streets claim their frontage (corner lots go to the earlier street). */
const FRONTAGE_ORDER = ['M St NW (Georgetown)', 'Wisconsin Ave NW', 'Pennsylvania Ave NW (Georgetown)', 'K St NW (Georgetown)', 'Water St NW',
  'M St NW (West End)', 'Pennsylvania Ave NW (West End)', 'Pennsylvania Ave NW (east of Washington Circle)', 'K St NW (West End)',
  'K St NW (east of Washington Circle)', 'Washington Circle', '23rd St NW (north of Washington Circle)', '23rd St NW (south of Washington Circle)',
  'New Hampshire Ave NW (north of Washington Circle)', 'New Hampshire Ave NW (south of Washington Circle)', 'I St NW', 'H St NW', 'L St NW',
  'Thomas Jefferson St NW', 'South St NW', 'Grace St NW', 'Prospect St NW', 'N St NW', 'O St NW', 'P St NW (Georgetown)', 'Dumbarton St NW',
  'Q St NW (Georgetown)', 'R St NW', 'Reservoir Rd NW'];
const NUMBERED = new Set(['36th St NW', '35th St NW', '34th St NW', '33rd St NW', 'Potomac St NW', '31st St NW', '30th St NW', '29th St NW', '28th St NW', '27th St NW (Georgetown)']);
const WEST_END = new Set(['M St NW (West End)', 'Pennsylvania Ave NW (West End)', 'Pennsylvania Ave NW (east of Washington Circle)', 'K St NW (West End)',
  'K St NW (east of Washington Circle)', 'Washington Circle', '26th St NW', 'L St NW', 'New Hampshire Ave NW (north of Washington Circle)']);
const FOGGY = new Set(['I St NW', 'H St NW', '23rd St NW (south of Washington Circle)', 'New Hampshire Ave NW (south of Washington Circle)']);

// ----------------------------------------------------------------------------------- POI categories
/** Spec street-character words -> OSM categories. Unknown words are skipped with a warning. */
const CATEGORY_WORDS = {
  'clothing boutiques': ['shop=clothes'], clothing: ['shop=clothes'], 'shoe stores': ['shop=shoes'], restaurants: ['amenity=restaurant'],
  bars: ['amenity=bar'], cafes: ['amenity=cafe'], bakery: ['shop=bakery'], bank: ['amenity=bank'], 'phone shop': ['shop=mobile_phone'],
  'art galleries': ['shop=art'], antiques: ['shop=antiques'], bistros: ['amenity=restaurant'], 'home goods': ['shop=interior_decoration', 'shop=furniture'],
  'waterfront restaurants': ['amenity=restaurant'], 'boat/kayak rental': [], parking: [], boathouses: [], trailhead: [],
  'offices in converted warehouses': ['office=company'], hotel: ['tourism=hotel'], hotels: ['tourism=hotel'], 'corner market/cafe': ['shop=convenience', 'amenity=cafe'],
  church: [], 'student cafe': ['amenity=cafe'], 'campus bookstore': ['shop=books'], coffee: ['amenity=cafe'], 'sandwich shops': ['amenity=fast_food'],
  hospital: [], university: [], 'fast casual food': ['amenity=fast_food'], pharmacy: ['amenity=pharmacy'],
};
/** Which spec street_character rows feed each POI table (matched on street + segment text). */
const POI_SOURCES = {
  shopping: [/^M St NW$/, /^Wisconsin Ave NW.*K St to N St/], bookhill: [/^Wisconsin Ave NW.*Book Hill/], waterfront: [/^K St NW \/ Water St NW/],
  canal: [/^Thomas Jefferson/], prospect: [/^Prospect St/], corner: [/^N St NW, O St NW/], campus: [/^37th St/], westend: [/^M St NW \/ Pennsylvania/, /^K St NW.*Rock Creek to east edge/],
  foggy: [/^23rd St NW \/ I St NW/],
};
/** Weights for categories from the spec, plus extras so the busy streets read as busy. */
const POI_WEIGHTS = {
  shopping: { 'shop=clothes': 7, 'shop=shoes': 3, 'amenity=restaurant': 7, 'amenity=bar': 3, 'amenity=cafe': 4, 'shop=bakery': 1.5, 'amenity=bank': 2, 'shop=mobile_phone': 1.5, extra: { 'amenity=pharmacy': 2, 'shop=cosmetics': 1.5, 'shop=jewelry': 1.5, 'amenity=ice_cream': 1, 'shop=gift': 1, 'shop=books': 0.7, 'shop=optician': 0.7, 'shop=sports': 1, 'amenity=fast_food': 2, 'shop=hairdresser': 1, 'shop=convenience': 1, 'amenity=pub': 1 } },
  bookhill: { 'shop=art': 3, 'shop=antiques': 3, 'amenity=restaurant': 3, 'shop=interior_decoration': 1.5, 'shop=furniture': 1.5, extra: { 'amenity=cafe': 2, 'shop=florist': 1, 'shop=wine': 1, 'shop=clothes': 1.5, 'shop=hairdresser': 0.8, 'shop=bakery': 0.8, 'shop=books': 0.7 } },
  waterfront: { 'amenity=restaurant': 4, 'amenity=bar': 3, extra: { 'amenity=cafe': 1.5, 'amenity=ice_cream': 1, 'office=company': 1.5, 'amenity=fast_food': 0.5 } },
  canal: { 'office=company': 3, 'amenity=restaurant': 3, 'tourism=hotel': 0.6, extra: { 'amenity=cafe': 1, 'shop=interior_decoration': 0.7 } },
  prospect: { 'amenity=restaurant': 4, extra: { 'amenity=bar': 1, 'amenity=cafe': 1 } },
  corner: { 'shop=convenience': 3, 'amenity=cafe': 3, extra: { 'shop=deli': 1, 'amenity=restaurant': 1, 'shop=hairdresser': 0.5, 'shop=dry_cleaning': 0.5 } },
  campus: { 'amenity=cafe': 3, 'shop=books': 2, extra: { 'amenity=fast_food': 1 } },
  westend: { 'tourism=hotel': 2, 'amenity=restaurant': 3, 'amenity=cafe': 3, 'amenity=fast_food': 2, extra: { 'office=company': 3, 'amenity=bank': 1, 'amenity=pharmacy': 0.7, 'shop=convenience': 0.7, 'amenity=bar': 1, 'shop=dry_cleaning': 0.5 } },
  foggy: { 'amenity=fast_food': 3, 'amenity=pharmacy': 1.5, extra: { 'amenity=cafe': 2, 'amenity=restaurant': 1, 'shop=convenience': 1, 'shop=books': 0.5 } },
};
const CUISINES = ['italian', 'american', 'french', 'mexican', 'japanese', 'thai', 'indian', 'mediterranean', 'seafood', 'steak_house', 'burger', 'pizza', 'chinese', 'vietnamese', 'lebanese', 'spanish', 'greek', 'korean'];
const FAST_FOOD = ['burger', 'sandwich', 'pizza', 'chicken', 'mexican', 'salad', 'bagel'];
/** POIs for one building each, given to the nearest suitable synthetic building to the target (lat, lon). */
const SERVICE_POIS = [
  { cat: 'amenity=fire_station', lat: 38.90555, lon: -77.0686 }, { cat: 'amenity=post_office', lat: 38.9046, lon: -77.0614 },
  { cat: 'amenity=police', lat: 38.9047, lon: -77.0512 }, { cat: 'shop=car_repair', lat: 38.9039, lon: -77.0589 },
  { cat: 'shop=car_repair', lat: 38.9031, lon: -77.0522 }, { cat: 'shop=supermarket', lat: 38.9039, lon: -77.0532 },
  { cat: 'shop=supermarket', lat: 38.9093, lon: -77.0640 }, { cat: 'amenity=cinema', lat: 38.90298, lon: -77.0598 },
  { cat: 'amenity=nightclub', lat: 38.9052, lon: -77.0605 }, { cat: 'amenity=clinic', lat: 38.9071, lon: -77.0634 },
  { cat: 'amenity=bank', lat: 38.90525, lon: -77.0631 }, { cat: 'amenity=pharmacy', lat: 38.90505, lon: -77.0645 },
];

// ----------------------------------------------------------------------------------- synthetic places
/** Extra green areas the spec mentions but does not draw ([lat, lon] rings). */
const SYNTH_PARKS = [
  // Book Hill Park: the slope below the library (south side of R St), on the east side of Wisconsin Ave (steps up from the avenue).
  { name: 'Book Hill Park', kind: 'leisure=park', ring: [[38.9118, -77.06495], [38.9126, -77.06535], [38.9126, -77.0642], [38.9118, -77.0642]] },
  { name: null, kind: 'leisure=garden', key: 'tudor-garden', ring: [[38.91085, -77.0620], [38.91265, -77.0620], [38.91265, -77.0631], [38.91085, -77.0631]] },
  { name: null, kind: 'leisure=garden', key: 'stonehouse-garden', ring: [[38.90546, -77.05962], [38.90572, -77.05962], [38.90572, -77.05992], [38.90546, -77.05992]] },
];
/** Synthetic car parks (centre, frontage width x depth in m, aligned to the nearest street). */
const SYNTH_LOTS = [
  { key: 'lot-water-st-west', lat: 38.90437, lon: -77.0709, w: 60, d: 38, poi: 'amenity=parking' },
  { key: 'lot-k-st-30th', lat: 38.90175, lon: -77.05868, w: 40, d: 100, poi: 'amenity=parking' },
  { key: 'lot-dealer', lat: 38.90205, lon: -77.05535, w: 70, d: 55, access: 'customers' },
  { key: 'lot-fuel', lat: 38.90285, lon: -77.0541, w: 32, d: 24, access: 'customers' },
];
/**
 * Hand-placed buildings for the spec's landmarks (and a few well-known schools and churches). w runs along the nearest
 * street unless `angle` (degrees, from east, counter-clockwise) is given. The search nudges each one up to 30 m and
 * shrinks it to 60% until it fits. `inPark` lets it sit in that park (the park gets a hole), `attach` glues it to a
 * placed building's side.
 */
const LANDMARKS = [
  { key: 'carbarn', lat: 38.9056, lon: -77.0699, w: 70, d: 27, type: 'commercial', levels: 4 },
  { key: 'healy', lat: 38.9076, lon: -77.0725, w: 90, d: 26, angle: 90, type: 'university', levels: 5, h: 24, campus: true },
  { key: 'healy-tower', attach: 'healy', side: -1, w: 10, d: 8, type: 'university', levels: 5, h: 61 },
  { key: 'trinity', lat: 38.9069, lon: -77.0703, w: 34, d: 18, type: 'church', levels: 1, h: 16, poi: 'amenity=place_of_worship', subcat: 'christian' },
  { key: 'oldstone', lat: 38.9054, lon: -77.0597, w: 12, d: 9, type: 'house', levels: 2, h: 7.5, poi: 'tourism=museum', subcat: 'history' },
  { key: 'gtownpark', lat: 38.9047, lon: -77.0638, w: 90, d: 52, type: 'retail', levels: 3, h: 14, poi: 'shop=mall', extraPois: ['shop=clothes', 'shop=shoes', 'shop=cosmetics', 'shop=jewelry', 'amenity=fast_food', 'shop=clothes'] },
  { key: 'grace', lat: 38.9038, lon: -77.0624, w: 24, d: 13, type: 'church', levels: 1, h: 13, poi: 'amenity=place_of_worship', subcat: 'christian' },
  { key: 'ritz', lat: 38.90318, lon: -77.06185, w: 80, d: 42, type: 'commercial', levels: 6, h: 22, poi: 'tourism=hotel' },
  { key: 'ritz-stack', attach: 'ritz', side: 1, w: 5, d: 5, type: 'commercial', levels: 1, h: 40 },
  { key: 'fourseasons', lat: 38.9046, lon: -77.0575, w: 75, d: 38, type: 'commercial', levels: 6, h: 22, poi: 'tourism=hotel' },
  { key: 'thompson', lat: 38.9002, lon: -77.0575, w: 40, d: 16, type: 'warehouse', levels: 2, h: 8, poi: 'amenity=boat_rental', boathouse: 3 },
  { key: 'harbour-w', lat: 38.90222, lon: -77.06045, w: 72, d: 40, type: 'commercial', levels: 7, h: 26, inPlaza: true, extraPois: ['amenity=restaurant:seafood', 'amenity=restaurant', 'amenity=bar', 'office=company'] },
  { key: 'harbour-e', lat: 38.90212, lon: -77.05945, w: 72, d: 40, type: 'commercial', levels: 7, h: 26, inPlaza: true, extraPois: ['amenity=restaurant:seafood', 'amenity=bar', 'amenity=ice_cream', 'amenity=restaurant'] },
  { key: 'gwuh', lat: 38.9015, lon: -77.0509, w: 55, d: 45, type: 'civic', levels: 7, h: 26, poi: 'amenity=hospital' },
  { key: 'watergate', lat: 38.8995, lon: -77.0553, w: 80, d: 36, type: 'apartments', levels: 12, h: 40 },
  { key: 'tudor', lat: 38.9116, lon: -77.0625, w: 32, d: 14, type: 'house', levels: 2, h: 11, inPark: 'tudor-garden', poi: 'tourism=museum', subcat: 'history' },
  { key: 'dumbarton', lat: 38.9135, lon: -77.0632, w: 55, d: 24, type: 'civic', levels: 3, h: 14, inPark: 'Dumbarton Oaks gardens', poi: 'tourism=museum', subcat: 'art' },
  { key: 'library', lat: 38.9128, lon: -77.065, w: 30, d: 24, type: 'civic', levels: 3, h: 13, poi: 'amenity=library' },
  { key: 'stjohn', lat: 38.9077, lon: -77.0651, w: 28, d: 15, type: 'church', levels: 1, h: 14, poi: 'amenity=place_of_worship', subcat: 'christian' },
  { key: 'christchurch', lat: 38.9077, lon: -77.0618, w: 30, d: 16, type: 'church', levels: 1, h: 15, poi: 'amenity=place_of_worship', subcat: 'christian' },
  { key: 'mountzion', lat: 38.9069, lon: -77.0584, w: 24, d: 14, type: 'church', levels: 1, h: 13, poi: 'amenity=place_of_worship', subcat: 'christian' },
  { key: 'hydeaddison', lat: 38.9083, lon: -77.0654, w: 45, d: 24, type: 'civic', levels: 3, poi: 'amenity=school' },
  { key: 'visitation', lat: 38.9101, lon: -77.0699, w: 50, d: 25, type: 'civic', levels: 3, poi: 'amenity=school' },
  { key: 'ellington', lat: 38.9134, lon: -77.0701, w: 60, d: 35, type: 'civic', levels: 4, poi: 'amenity=school' },
  { key: 'kb-boathouse', lat: 38.90364, lon: -77.0706, w: 18, d: 10, type: 'warehouse', levels: 1, h: 5, poi: 'amenity=boat_rental', boathouse: 1 },
  { key: 'boat-club', lat: 38.90392, lon: -77.0718, w: 24, d: 12, type: 'warehouse', levels: 2, h: 8, poi: 'leisure=sports_centre', subcat: 'rowing', boathouse: 1 },
  { key: 'canoe-club', lat: 38.90411, lon: -77.0728, w: 22, d: 10, type: 'warehouse', levels: 2, h: 8, poi: 'leisure=sports_centre', subcat: 'canoe', boathouse: 1 },
  { key: 'dealer-showroom', lat: 38.90222, lon: -77.0546, w: 30, d: 16, type: 'retail', levels: 1, h: 6, poi: 'shop=car', subcat: 'used' },
  { key: 'fuel-kiosk', lat: 38.9031, lon: -77.0544, w: 12, d: 8, type: 'retail', levels: 1, h: 4.5, poi: 'amenity=fuel' },
];
/** Extrapolation anchors for the heightfield where the spec has no spot heights (box corners and edges). */
const HEIGHT_ANCHORS = [
  [38.914, -77.074, 62], [38.9118, -77.074, 55], [38.9095, -77.074, 42], [38.9062, -77.074, 7], [38.914, -77.0605, 60],
  [38.914, -77.048, 40], [38.9065, -77.048, 20], [38.899, -77.048, 10],
];
/** Rock Creek water level (m) by latitude, mouth to the north edge. */
const CREEK_LEVELS = [[38.9006, 0.5], [38.9053, 2], [38.9093, 6], [38.9107, 8], [38.914, 11]];
/** C&O Canal lock gates: lock centres (lon), gates 13 m either side. */
const LOCKS = [-77.0572, -77.0585, -77.0596, -77.0607];
/**
 * Links the road graph needs but the spec leaves out. The parkway has no junction inside the box in the spec (it passes
 * under every bridge), so it would be a separate network; in reality ramps join it to K St / Virginia Ave near
 * Thompson Boat Center. `from` is snapped onto the named street (a vertex is spliced in); the last point is an existing
 * junction (the K St bridge's east end, where the Whitehurst Freeway lands).
 */
const SYNTH_ROADS = [
  { name: null, kind: 'secondary', lanes: 2, oneway: 'no', from: { street: 'Rock Creek and Potomac Parkway', lat: 38.9012, lon: -77.05716 }, points: [[38.90185, -77.05672], [38.9025, -77.056]], note: 'parkway ramp to K St (synthetic)' },
];
const PROMENADE_LON = [-77.0698, -77.0611, -77.0591]; // west end, boardwalk start (Washington Harbour), east end
const WATERFRONT_LINKS = [-77.0690, -77.0675, -77.0655, -77.0640, -77.0626, -77.0618];
const HARBOUR_PIERS = [-77.0597, -77.0606];

// =================================================================================================== main
function die(msg) {
  console.error(`georgetownFromSpec: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { spec: DEFAULT_SPEC, out: DEFAULT_OUT, seed: DEFAULT_SEED, reportJson: null, help: false };
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : die(`${s} needs a value`));
    if (s === '--out' || s === '-o') a.out = val();
    else if (s === '--seed') a.seed = Number(val()) >>> 0;
    else if (s === '--report-json') a.reportJson = val();
    else if (s === '-h' || s === '--help') a.help = true;
    else if (s.startsWith('-')) die(`unknown option ${s} (try --help)`);
    else if (positional++ === 0) a.spec = s;
    else die(`unexpected argument ${s}`);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const t0 = performance.now();
  const spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  const res = generate(spec, { seed: args.seed, specPath: args.spec });
  const text = toJson(res.doc);
  const bytes = Buffer.byteLength(text);
  res.report.fileBytes = bytes;
  mkdirSync(dirname(args.out) || '.', { recursive: true });
  writeFileSync(args.out, text);
  if (args.reportJson) {
    mkdirSync(dirname(args.reportJson) || '.', { recursive: true });
    writeFileSync(args.reportJson, JSON.stringify(res.report, null, 1));
  }
  printReport(args, res, bytes, performance.now() - t0);
}

// ================================================================================================ helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeProjection(crop) {
  // Same projection as importOsm.mjs: equirectangular around the crop centre, WGS84 metres per degree at lat0.
  const lat0 = (crop.minlat + crop.maxlat) / 2;
  const lon0 = (crop.minlon + crop.maxlon) / 2;
  const p = (lat0 * Math.PI) / 180;
  const mLat = 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  return {
    lat0, lon0, mLat, mLon,
    /** lat/lon -> [x east, y north] in metres (internal frame; output flips y to z south). */
    fwd: (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * mLat],
    inv: (x, y) => [lat0 + y / mLat, lon0 + x / mLon],
  };
}

// ---------------------------------------------------------------------- geometry (x east, y north)
const r1 = (v) => Math.round(v * 10) / 10 || 0;
const hyp = Math.hypot;
function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}
function ccw(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
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
function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}
const bbHit = (a, b, m = 0) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.y0 - m <= b.y1 && b.y0 - m <= a.y1;
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
/** Intersection of segments a-b and c-d: {t along a-b, u along c-d, x, y} or null. */
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + t * rx, y: ay + t * ry };
}
function distSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.sqrt(Math.min(distPointSeg2(ax, ay, cx, cy, dx, dy), distPointSeg2(bx, by, cx, cy, dx, dy), distPointSeg2(cx, cy, ax, ay, bx, by), distPointSeg2(dx, dy, ax, ay, bx, by)));
}
/** Distance from a polygon to a segment (0 if they touch or the segment is inside). */
function polySegDist(poly, ax, ay, bx, by) {
  if (pointInRing(ax, ay, poly) || pointInRing(bx, by, poly)) return 0;
  let d = Infinity;
  for (let i = 0, n = poly.length, j = n - 1; i < n && d > 0; j = i++) d = Math.min(d, distSegSeg(poly[j][0], poly[j][1], poly[i][0], poly[i][1], ax, ay, bx, by));
  return d;
}
function lineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
function cumLength(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
/** Point at arc length s: {x, y, tx, ty, i} (i = segment index, t* = unit direction). */
function pointAt(pts, cum, s) {
  const n = pts.length;
  let i = 1;
  while (i < n - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i];
  const L = cum[i] - cum[i - 1] || 1e-9;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / L));
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / L, ty: (b[1] - a[1]) / L, i };
}
function sliceLine(pts, cum, s0, s1) {
  const a = pointAt(pts, cum, s0), b = pointAt(pts, cum, s1);
  const out = [[a.x, a.y]];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push(pts[i]);
  out.push([b.x, b.y]);
  return out;
}
/** Nearest point on a polyline: {s (arc length), d2, i (segment end index), t, x, y}. */
function projectOnLine(pts, cum, x, y) {
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + t * dx, py = a[1] + t * dy;
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (!best || d2 < best.d2) best = { s: cum[i - 1] + t * Math.sqrt(L2), d2, i, t, x: px, y: py };
  }
  return best;
}
/** Offsets a polyline to its left by d[i] metres at vertex i (negative = right), mitred, miter capped at 3x. */
function offsetLine(pts, d) {
  const n = pts.length;
  const dd = typeof d === 'number' ? new Array(n).fill(d) : d;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
    if (i > 0) {
      const L = hyp(p[0] - a[0], p[1] - a[1]) || 1;
      n1x = -(p[1] - a[1]) / L;
      n1y = (p[0] - a[0]) / L;
    }
    if (i < n - 1) {
      const L = hyp(b[0] - p[0], b[1] - p[1]) || 1;
      n2x = -(b[1] - p[1]) / L;
      n2y = (b[0] - p[0]) / L;
    }
    if (i === 0) { n1x = n2x; n1y = n2y; }
    if (i === n - 1) { n2x = n1x; n2y = n1y; }
    let mx = n1x + n2x, my = n1y + n2y;
    const mL = hyp(mx, my);
    if (mL < 1e-9) { mx = n1x; my = n1y; } else { mx /= mL; my /= mL; }
    const cos = mx * n1x + my * n1y;
    const k = Math.min(3, 1 / Math.max(cos, 1e-3));
    out.push([p[0] + mx * dd[i] * k, p[1] + my * dd[i] * k]);
  }
  return out;
}
/** Polygon around a polyline with half widths hw[i] (ring, counter-clockwise). */
function bufferLine(pts, hw) {
  const w = typeof hw === 'number' ? new Array(pts.length).fill(hw) : hw;
  const left = offsetLine(pts, w), right = offsetLine(pts, w.map((v) => -v));
  return ccw([...left, ...right.reverse()]);
}
/** True if two convex polygons overlap by more than tol (touching is allowed). Separating axis test. */
function convexOverlap(A, B, tol) {
  for (const P of [A, B]) {
    for (let i = 0, n = P.length, j = n - 1; i < n; j = i++) {
      const ex = P[i][0] - P[j][0], ey = P[i][1] - P[j][1];
      const L = hyp(ex, ey);
      if (L < 1e-9) continue;
      const nx = -ey / L, ny = ex / L;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const q of A) { const d = q[0] * nx + q[1] * ny; if (d < amin) amin = d; if (d > amax) amax = d; }
      for (const q of B) { const d = q[0] * nx + q[1] * ny; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
      if (amax - bmin <= tol || bmax - amin <= tol) return false;
    }
  }
  return true;
}
/** Rectangle ring (CCW): centre, unit width axis u, half width hw (along u), half depth hd (along u rotated +90). */
function rectRing(cx, cy, ux, uy, hw, hd) {
  const vx = -uy, vy = ux;
  return [[cx - ux * hw - vx * hd, cy - uy * hw - vy * hd], [cx + ux * hw - vx * hd, cy + uy * hw - vy * hd], [cx + ux * hw + vx * hd, cy + uy * hw + vy * hd], [cx - ux * hw + vx * hd, cy - uy * hw + vy * hd]];
}
/** Grows a rectangle ring by g on every side. */
function inflateRect(ring, g) {
  if (!g) return ring;
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [p[0] - b[0], p[1] - b[1]];
    const l1 = hyp(...e1) || 1, l2 = hyp(...e2) || 1;
    return [p[0] + (g * e1[0]) / l1 + (g * e2[0]) / l2, p[1] + (g * e1[1]) / l1 + (g * e2[1]) / l2];
  });
}
function circleRing(cx, cy, r, n = 16) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return out;
}
/** Crossings of polyline pts with the vertical line x = X: [{i, t, y}] (segment end index, param). */
function vHits(pts, X) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a[0] - X) * (b[0] - X) > 0 || a[0] === b[0]) continue;
    const t = (X - a[0]) / (b[0] - a[0]);
    out.push({ i, t, x: X, y: a[1] + t * (b[1] - a[1]) });
  }
  return out;
}
function hHits(pts, Y) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a[1] - Y) * (b[1] - Y) > 0 || a[1] === b[1]) continue;
    const t = (Y - a[1]) / (b[1] - a[1]);
    out.push({ i, t, x: a[0] + t * (b[0] - a[0]), y: Y });
  }
  return out;
}
/** Splices a vertex into pts at segment i, param t; reuses an existing vertex within 0.3 m. Returns the vertex. */
function insertVertex(pts, i, t) {
  const a = pts[i - 1], b = pts[i];
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (hyp(q[0] - a[0], q[1] - a[1]) < 0.3) return a;
  if (hyp(q[0] - b[0], q[1] - b[1]) < 0.3) return b;
  pts.splice(i, 0, q);
  return q;
}

// ---------------------------------------------------------------------- rect clipping (from importOsm.mjs)
const EDGE_EPS = 1e-6;
const inRect = (p, r) => p[0] >= r.x0 - EDGE_EPS && p[0] <= r.x1 + EDGE_EPS && p[1] >= r.y0 - EDGE_EPS && p[1] <= r.y1 + EDGE_EPS;
const onEdge = (p, r) => inRect(p, r) && (Math.abs(p[0] - r.x0) < EDGE_EPS || Math.abs(p[0] - r.x1) < EDGE_EPS || Math.abs(p[1] - r.y0) < EDGE_EPS || Math.abs(p[1] - r.y1) < EDGE_EPS);
const clampPt = (x, y, r) => [Math.min(r.x1, Math.max(r.x0, x)), Math.min(r.y1, Math.max(r.y0, y))];
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
/** Closes a boundary-to-boundary chain (area on its LEFT) into a ring by walking the rect counter-clockwise. */
function closeAlongRect(chain, r) {
  const W = r.x1 - r.x0, H = r.y1 - r.y0, P = 2 * (W + H);
  const corners = [[W, [r.x1, r.y0]], [W + H, [r.x1, r.y1]], [2 * W + H, [r.x0, r.y1]], [P, [r.x0, r.y0]]];
  const tOut = perimT(chain[chain.length - 1], r), tIn = perimT(chain[0], r);
  const gap = (((tIn - tOut) % P) + P) % P;
  const ring = chain.slice();
  const walk = [];
  for (const [ct, pt] of corners) {
    let c = ct;
    while (c <= tOut + 1e-9) c += P;
    if (c < tOut + gap - 1e-9) walk.push([c, pt]);
  }
  walk.sort((a, b) => a[0] - b[0]);
  for (const [, pt] of walk) ring.push(pt);
  return ring;
}
function nearestEdgePoint(p, r) {
  const [x, y] = clampPt(p[0], p[1], r);
  const d = [x - r.x0, r.x1 - x, y - r.y0, r.y1 - y];
  const i = d.indexOf(Math.min(...d));
  return i === 0 ? [r.x0, y] : i === 1 ? [r.x1, y] : i === 2 ? [x, r.y0] : [x, r.y1];
}

// ----------------------------------------------------------------------------------- spatial index
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
}
/** Buildings (convex rings) bucketed by bounding box. */
class BoxGrid {
  constructor(size) { this.size = size; this.cells = new Map(); this.items = []; this.stamp = 0; }
  key(ix, iy) { return (ix + 1048576) * 2097152 + (iy + 1048576); }
  add(item) {
    item.bb = bboxOf(item.ring);
    item._seen = 0;
    this.items.push(item);
    const b = item.bb, s = this.size;
    for (let ix = Math.floor(b.x0 / s); ix <= Math.floor(b.x1 / s); ix++) {
      for (let iy = Math.floor(b.y0 / s); iy <= Math.floor(b.y1 / s); iy++) {
        const k = this.key(ix, iy);
        const l = this.cells.get(k);
        if (l) l.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }
  query(bb, fn) {
    const st = ++this.stamp, s = this.size;
    for (let ix = Math.floor(bb.x0 / s); ix <= Math.floor(bb.x1 / s); ix++) {
      for (let iy = Math.floor(bb.y0 / s); iy <= Math.floor(bb.y1 / s); iy++) {
        const l = this.cells.get(this.key(ix, iy));
        if (!l) continue;
        for (const it of l) {
          if (it._seen === st) continue;
          it._seen = st;
          if (fn(it) === false) return;
        }
      }
    }
  }
}

// ================================================================================================ generate
function generate(spec, opts) {
  const rng = mulberry32(opts.seed);
  const rand = (a, b) => a + (b - a) * rng();
  const randInt = (a, b) => Math.floor(rand(a, b + 1 - 1e-9));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const pickWeighted = (pairs) => {
    const tot = pairs.reduce((s, p) => s + p[1], 0);
    let r = rng() * tot;
    for (const p of pairs) if ((r -= p[1]) <= 0) return p[0];
    return pairs[pairs.length - 1][0];
  };
  const warnings = [];
  const crop = spec.bbox ?? { minlon: -77.074, minlat: 38.899, maxlon: -77.048, maxlat: 38.914 };
  const proj = makeProjection(crop);
  const P = (ll) => proj.fwd(ll[0], ll[1]);
  const [rx0, ry0] = proj.fwd(crop.minlat, crop.minlon);
  const [rx1, ry1] = proj.fwd(crop.maxlat, crop.maxlon);
  const rect = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
  const yOfLat = (lat) => (lat - proj.lat0) * proj.mLat;
  const xOfLon = (lon) => (lon - proj.lon0) * proj.mLon;
  const latlon = (x, y) => {
    const [la, lo] = proj.inv(x, y);
    return [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6];
  };
  let lastId = 0;
  const sid = () => `s${++lastId}`;

  // -------------------------------------------------------------------------------------------- roads
  const outName = (n) => {
    const b = n.match(/^(.+?) [Bb]ridge over /);
    if (b) return `${b[1]} NW`;
    const q = n.match(/^[^(]*Bridge \((\w+ St)\b/);
    if (q) return `${q[1]} NW`;
    return n.replace(/\s*\(.*\)\s*$/, '');
  };
  const roads = [];
  const footSpecs = [];
  for (const st of spec.streets) {
    if (FOOT_KINDS.has(st.kind)) { footSpecs.push(st); continue; }
    const highway = HIGHWAY[st.kind];
    if (!highway) { warnings.push(`street "${st.name}": unknown kind ${st.kind}, skipped`); continue; }
    const pts = st.points.map(P);
    const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const tunnel = /underpass|tunnel/i.test(st.name) ? 1 : 0;
    const bridge = st.bridge || st.elevated ? 1 : 0;
    const lanes = Math.max(1, st.lanes || 2);
    const name = outName(st.name);
    roads.push({
      specName: st.name, name, bridgeName: bridge ? st.name.replace(/\s*\(.*\)\s*$/, '') : null, highway, lanes,
      oneway: st.oneway === 'forward' ? 1 : st.oneway === 'backward' ? -1 : 0, bridge, tunnel, layer: tunnel ? -1 : st.elevated ? ELEVATED_LAYER : bridge ? 1 : 0,
      junction: closed ? 'roundabout' : null, maxspeed: st.maxspeed ?? MAXSPEED_BY_NAME[st.name] ?? MAXSPEED[highway] ?? 40,
      pts, closed, hw: (lanes * LANE_WIDTH) / 2, sw: !(highway === 'trunk' || highway === 'motorway' || tunnel || NO_SIDEWALK.has(st.name)),
      elevated: !!st.elevated, surface: SURFACE_BY_NAME[name] ?? null, confidence: st.confidence,
    });
  }
  // Synthetic links: splice a junction vertex into the street they leave from.
  for (const sr of SYNTH_ROADS) {
    const host = roads.find((r) => r.specName === sr.from.street);
    if (!host) { warnings.push(`synthetic road: no street "${sr.from.street}"`); continue; }
    const [fx, fy] = proj.fwd(sr.from.lat, sr.from.lon);
    const pr = projectOnLine(host.pts, cumLength(host.pts), fx, fy);
    const start = insertVertex(host.pts, pr.i, pr.t);
    const lanes = sr.lanes ?? 2;
    const highway = HIGHWAY[sr.kind] ?? 'secondary';
    roads.push({
      specName: sr.note ?? 'synthetic link', name: sr.name, bridgeName: null, highway, lanes, oneway: sr.oneway === 'forward' ? 1 : sr.oneway === 'backward' ? -1 : 0,
      bridge: 0, tunnel: 0, layer: 0, junction: null, maxspeed: MAXSPEED[highway] ?? 40, pts: [start, ...sr.points.map(P)], closed: false,
      hw: (lanes * LANE_WIDTH) / 2, sw: false, elevated: false, surface: null, synth: true,
    });
  }
  // Junction vertices (shared by two or more roads, or used twice): a canal bridge must not swallow one.
  const vKey = (p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const vUse = new Map();
  for (const r of roads) for (let i = 0; i < r.pts.length - (r.closed ? 1 : 0); i++) vUse.set(vKey(r.pts[i]), (vUse.get(vKey(r.pts[i])) ?? 0) + 1);

  // Streets that cross the canal at grade get a short bridge piece (bridge=1, layer=1) over the canal and towpath.
  const canalPts = spec.water.canal.map(P);
  const canalBridges = [];
  {
    const out = [];
    for (const r of roads) {
      if (r.bridge || r.tunnel || r.closed) { out.push(r); continue; }
      const cum = cumLength(r.pts);
      const L = cum[cum.length - 1];
      const cuts = [];
      for (let i = 1; i < r.pts.length; i++) {
        for (let j = 1; j < canalPts.length; j++) {
          const h = segIntersect(r.pts[i - 1][0], r.pts[i - 1][1], r.pts[i][0], r.pts[i][1], canalPts[j - 1][0], canalPts[j - 1][1], canalPts[j][0], canalPts[j][1]);
          if (h) cuts.push(cum[i - 1] + h.t * (cum[i] - cum[i - 1]));
        }
      }
      if (!cuts.length) { out.push(r); continue; }
      cuts.sort((a, b) => a - b);
      let prev = 0;
      const pieces = [];
      for (const c of cuts) {
        let s0 = Math.max(prev + 1, c - CANAL_BRIDGE_HALF_SPAN), s1 = Math.min(L - 1, c + CANAL_BRIDGE_HALF_SPAN);
        for (let i = 1; i < r.pts.length - 1; i++) {
          if ((vUse.get(vKey(r.pts[i])) ?? 0) < 2) continue;
          if (cum[i] > s0 && cum[i] <= c) s0 = cum[i] + 1;
          if (cum[i] < s1 && cum[i] >= c) s1 = cum[i] - 1;
        }
        if (s1 - s0 < 6) { warnings.push(`${r.specName}: no room for a canal bridge`); continue; }
        if (s0 > prev + 0.5) pieces.push({ s0: prev, s1: s0, bridge: 0 });
        pieces.push({ s0, s1, bridge: 1 });
        prev = s1;
      }
      if (prev < L - 0.5) pieces.push({ s0: prev, s1: L, bridge: 0 });
      // Pieces share their cut vertices (same array objects), so the graph stays connected.
      let carry = null;
      for (const pc of pieces) {
        const pts = sliceLine(r.pts, cum, pc.s0, pc.s1);
        if (carry) pts[0] = carry;
        carry = pts[pts.length - 1];
        const piece = { ...r, pts, bridge: pc.bridge || r.bridge, layer: pc.bridge ? 1 : r.layer, canalBridge: !!pc.bridge, bridgeName: pc.bridge ? `${r.name} canal bridge` : r.bridgeName };
        out.push(piece);
        if (pc.bridge) canalBridges.push(piece);
      }
    }
    roads.length = 0;
    roads.push(...out);
  }
  for (const r of roads) r.id = sid();

  // ----------------------------------------------------------------------------------- water
  const water = [], waterways = [];
  const waterAreas = []; // internal rings for checks {ring, kind}
  const shore = spec.water.potomac_north_shore.map(P);
  {
    const chain = shore.map((p) => p.slice());
    for (const k of [0, chain.length - 1]) if (!onEdge(chain[k], rect)) chain[k] = nearestEdgePoint(chain[k], rect);
    // Water lies south of (to the right of) the shore line; reversed, it is on the left, as closeAlongRect wants.
    const ring = ccw(clipRingSH(closeAlongRect(chain.reverse(), rect), rect));
    water.push({ id: sid(), kind: 'river', name: 'Potomac River', ring });
    waterAreas.push({ ring, kind: 'river' });
  }
  {
    const ring = ccw(clipRingSH(bufferLine(canalPts, CANAL_HALF_WIDTH), rect));
    const w = { id: sid(), kind: 'canal', name: 'Chesapeake and Ohio Canal', ring };
    water.push(w);
    waterAreas.push({ ring, kind: 'canal' });
  }
  const creekPts = spec.water.rock_creek.map(P);
  {
    // Run the creek a little into the river so the two water areas overlap at the mouth.
    const a = creekPts[creekPts.length - 2], b = creekPts[creekPts.length - 1];
    const L = hyp(b[0] - a[0], b[1] - a[1]) || 1;
    const ext = [...creekPts, [b[0] + ((b[0] - a[0]) / L) * 15, b[1] + ((b[1] - a[1]) / L) * 15]];
    const yN = Math.max(...ext.map((p) => p[1])), yS = Math.min(...ext.map((p) => p[1]));
    const hw = ext.map((p) => CREEK_HALF_WIDTH.north + ((yN - p[1]) / (yN - yS || 1)) * (CREEK_HALF_WIDTH.mouth - CREEK_HALF_WIDTH.north));
    const ring = ccw(clipRingSH(bufferLine(ext, hw), rect));
    water.push({ id: sid(), kind: 'stream', name: 'Rock Creek', ring });
    waterAreas.push({ ring, kind: 'stream', line: creekPts });
  }
  const fountainLm = spec.landmarks.find((l) => l.kind === 'fountain');
  if (fountainLm) {
    const [fx, fy] = proj.fwd(fountainLm.lat, fountainLm.lon);
    const ring = circleRing(fx, fy, 7, 16);
    water.push({ id: sid(), kind: 'fountain', name: null, ring });
    waterAreas.push({ ring, kind: 'fountain' });
  }
  for (const pc of clipPolyline(canalPts, rect)) waterways.push({ id: sid(), kind: 'canal', name: 'Chesapeake and Ohio Canal', pts: pc });
  for (const pc of clipPolyline(creekPts, rect)) waterways.push({ id: sid(), kind: 'stream', name: 'Rock Creek', pts: pc });
  for (const pc of clipPolyline(offsetLine(shore, -RIVER_CENTRE_OFFSET), rect)) waterways.push({ id: sid(), kind: 'river', name: 'Potomac River', pts: pc });
  const inWater = (x, y, kinds) => waterAreas.some((w) => (!kinds || kinds.includes(w.kind)) && pointInRing(x, y, w.ring));

  // ----------------------------------------------------------------------------------- areas
  const parks = [], parking = [], plazas = [], campuses = [], keepouts = [];
  let marina = null;
  const parkByKey = new Map();
  for (const a of spec.areas) {
    const ring = ccw(clipRingSH(a.polygon.map(P), rect));
    if (ring.length < 3) continue;
    if (a.kind === 'park' || a.kind === 'cemetery' || a.kind === 'garden') {
      const p = { id: sid(), kind: a.kind === 'cemetery' ? 'landuse=cemetery' : a.kind === 'garden' ? 'leisure=garden' : 'leisure=park', name: a.name, ring, holes: [] };
      parks.push(p);
      parkByKey.set(a.name, p);
    } else if (a.kind === 'plaza') plazas.push({ id: sid(), name: a.name, ring, holes: [] });
    else if (a.kind === 'parking') parking.push({ id: sid(), type: 'surface', ring, capacity: 0, poi: 'amenity=parking' });
    else if (a.kind === 'campus') campuses.push({ name: a.name, ring });
    else if (a.kind === 'marina') marina = { name: a.name, ring };
    else warnings.push(`area "${a.name}": unknown kind ${a.kind}, skipped`);
  }
  for (const s of SYNTH_PARKS) {
    const p = { id: sid(), kind: s.kind, name: s.name, ring: ccw(s.ring.map(P)), holes: [], synth: true };
    parks.push(p);
    parkByKey.set(s.key ?? s.name, p);
  }
  // A campus with no street inside it is exclusive (only campus buildings); one that streets cross is just a zone.
  for (const c of campuses) {
    c.exclusive = !roads.some((r) => r.pts.some((p) => pointInRing(p[0], p[1], c.ring)));
  }
  const metro = spec.landmarks.find((l) => l.kind === 'metro');
  if (metro) {
    const [mx, my] = proj.fwd(metro.lat, metro.lon);
    keepouts.push({ ring: circleRing(mx, my, 9, 12), tag: 'metro' });
  }

  // ----------------------------------------------------------------------------------- road index
  // clear = distance a building keeps from the centre line; lotClear = for car parks; trim = sidewalk centre line.
  for (const r of roads) {
    r.clear = r.elevated || (r.bridge && !r.sw) ? r.hw + ELEVATED_CLEAR : r.sw ? r.hw + SIDEWALK_WIDTH + BUILDING_SETBACK : r.hw + NO_SIDEWALK_CLEAR;
    if (r.specName === 'Francis Scott Key Bridge') r.clear = r.hw + SIDEWALK_WIDTH + ELEVATED_CLEAR;
    r.lotClear = r.sw ? r.hw + SIDEWALK_WIDTH + LOT_CLEAR : r.clear;
  }
  const roadGrid = new SegGrid(25);
  for (const r of roads) roadGrid.addLine(r.pts, r);
  const atGrade = (r) => r.layer === 0 && !r.tunnel;
  /** How far (x, y) is outside every at-grade carriageway + sidewalk centre line (negative = inside). */
  const sidewalkClearance = (x, y) => {
    let c = Infinity;
    roadGrid.query(x - 25, y - 25, x + 25, y + 25, (s) => {
      const r = s.data;
      if (!atGrade(r)) return true;
      const z = r.sw ? r.hw + SIDEWALK_OFFSET : r.hw + 0.5;
      c = Math.min(c, Math.sqrt(distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by)) - z);
      return true;
    });
    return c;
  };
  const nearestRoad = (x, y, filter) => {
    let best = null;
    roadGrid.query(x - 150, y - 150, x + 150, y + 150, (s) => {
      if (filter && !filter(s.data)) return true;
      const d2 = distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by);
      if (!best || d2 < best.d2) best = { d2, s };
      return true;
    });
    if (!best) return null;
    const { s } = best;
    const L = hyp(s.bx - s.ax, s.by - s.ay) || 1;
    return { road: s.data, d: Math.sqrt(best.d2), tx: (s.bx - s.ax) / L, ty: (s.by - s.ay) / L, seg: s };
  };

  // ----------------------------------------------------------------------------------- footways
  const foot = []; // internal footway records {kind, name, pts, bridge, layer, surface, towpath, pier, group}
  const addFoot = (f) => {
    const rec = { bridge: 0, layer: 0, name: null, ...f, id: sid() };
    foot.push(rec);
    return rec;
  };
  buildSidewalks();

  /** Sidewalks: offset lines on both sides of each street, joined at junction corners, with crossings. */
  function buildSidewalks() {
    const swRoads = roads.filter((r) => r.sw);
    const use = new Map();
    for (const r of swRoads) {
      const n = r.pts.length;
      r.pts.forEach((p, i) => {
        if (r.closed && i === n - 1) return;
        const k = vKey(p);
        let u = use.get(k);
        if (!u) use.set(k, (u = { segs: 0, ends: 0 }));
        const end = !r.closed && (i === 0 || i === n - 1);
        u.segs += end ? 1 : 2;
        if (end) u.ends++;
      });
    }
    const isSplit = (p) => {
      const u = use.get(vKey(p));
      return u.segs !== 2 || u.ends > 0;
    };
    const edges = [];
    for (const r of swRoads) {
      let pts = r.pts;
      if (r.closed) {
        const ring = pts.slice(0, -1);
        const s = ring.findIndex(isSplit);
        if (s < 0) { warnings.push(`${r.specName}: closed loop with no junction, no sidewalks`); continue; }
        pts = [...ring.slice(s), ...ring.slice(0, s), ring[s]];
      }
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        if (i === pts.length - 1 || isSplit(pts[i])) {
          edges.push({ r, pts: pts.slice(start, i + 1) });
          start = i;
        }
      }
    }
    const nodes = new Map();
    for (const e of edges) {
      for (const atStart of [true, false]) {
        const p = atStart ? e.pts[0] : e.pts[e.pts.length - 1];
        const q = atStart ? e.pts[1] : e.pts[e.pts.length - 2];
        const k = vKey(p);
        let nd = nodes.get(k);
        if (!nd) nodes.set(k, (nd = { p, arms: [] }));
        const L = hyp(q[0] - p[0], q[1] - p[1]) || 1;
        const arm = { e, atStart, dx: (q[0] - p[0]) / L, dy: (q[1] - p[1]) / L, o: e.r.hw + SIDEWALK_OFFSET, segLen: L, len: lineLength(e.pts) };
        arm.ang = Math.atan2(arm.dy, arm.dx);
        nd.arms.push(arm);
        if (atStart) e.a = arm;
        else e.b = arm;
      }
    }
    const crossings = [];
    for (const nd of nodes.values()) {
      const arms = nd.arms.sort((a, b) => a.ang - b.ang);
      const k = arms.length;
      const [px, py] = nd.p;
      const Lp = (a) => [px - a.dy * a.o, py + a.dx * a.o];
      const Rp = (a) => [px + a.dy * a.o, py - a.dx * a.o];
      if (k === 1) {
        const a = arms[0];
        a.leftPt = Lp(a);
        a.rightPt = Rp(a);
        // A dead end inside the map gets a crossing round the end; one on the crop edge just stops (the street goes on).
        const edge = Math.min(px - rect.x0, rect.x1 - px, py - rect.y0, rect.y1 - py) < 2;
        if (!edge) crossings.push({ pts: [a.rightPt, a.leftPt], r: a.e.r });
        continue;
      }
      for (let i = 0; i < k; i++) {
        const A = arms[i], B = arms[(i + 1) % k];
        let th = B.ang - A.ang;
        while (th <= 1e-9) th += 2 * Math.PI;
        const pA = Lp(A), pB = Rp(B);
        if (th > Math.PI + REFLEX) {
          // Outside of a sharp bend: the two sidewalks are joined by a short arc round the corner.
          A.leftPt = pA;
          B.rightPt = pB;
          const r0 = (A.o + B.o) / 2;
          const a0 = Math.atan2(pA[1] - py, pA[0] - px);
          let da = Math.atan2(pB[1] - py, pB[0] - px) - a0;
          while (da <= 0) da += 2 * Math.PI;
          const steps = Math.max(1, Math.ceil(da / 0.4));
          const arc = [pA];
          for (let s = 1; s < steps; s++) arc.push([px + r0 * Math.cos(a0 + (da * s) / steps), py + r0 * Math.sin(a0 + (da * s) / steps)]);
          arc.push(pB);
          addFoot({ kind: 'sidewalk', pts: arc, bridge: A.e.r.bridge && B.e.r.bridge ? 1 : 0, layer: A.e.r.bridge && B.e.r.bridge ? 1 : 0, group: 'sidewalk' });
          continue;
        }
        const cr = A.dx * B.dy - A.dy * B.dx;
        let c;
        if (Math.abs(cr) < 0.05) c = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2];
        else {
          const t = ((pB[0] - pA[0]) * B.dy - (pB[1] - pA[1]) * B.dx) / cr;
          c = [pA[0] + A.dx * t, pA[1] + A.dy * t];
          const d = hyp(c[0] - px, c[1] - py);
          if (d > CORNER_MAX) c = [px + ((c[0] - px) * CORNER_MAX) / d, py + ((c[1] - py) * CORNER_MAX) / d];
        }
        A.leftPt = c;
        B.rightPt = c;
      }
      if (k < 3) continue;
      for (const a of arms) {
        const tL = (a.leftPt[0] - px) * a.dx + (a.leftPt[1] - py) * a.dy;
        const tR = (a.rightPt[0] - px) * a.dx + (a.rightPt[1] - py) * a.dy;
        const tc = Math.max(tL, tR, 0) + CROSSING_GAP;
        if (tc > Math.min(a.segLen - 0.5, a.len * 0.45)) continue;
        const cx = px + a.dx * tc, cy = py + a.dy * tc;
        a.crossL = [cx - a.dy * a.o, cy + a.dx * a.o];
        a.crossR = [cx + a.dy * a.o, cy - a.dx * a.o];
        crossings.push({ pts: [a.crossR, a.crossL], r: a.e.r });
      }
    }
    for (const e of edges) {
      const cum = cumLength(e.pts);
      for (const side of [1, -1]) {
        const a = e.a, b = e.b;
        const start = side > 0 ? a.leftPt : a.rightPt;
        const cs = side > 0 ? a.crossL : a.crossR;
        const end = side > 0 ? b.rightPt : b.leftPt;
        const ce = side > 0 ? b.crossR : b.crossL;
        if (!start || !end) continue;
        const off = offsetLine(e.pts, side * (e.r.hw + SIDEWALK_OFFSET));
        const pr = (p) => projectOnLine(e.pts, cum, p[0], p[1]).s;
        let tS = pr(start), tE = pr(end);
        if (cs) tS = Math.max(tS, pr(cs));
        if (ce) tE = Math.min(tE, pr(ce));
        if (tE < tS - 0.5 && e.pts.length > 2) continue;
        const pts = [start];
        if (cs) pts.push(cs);
        for (let i = 1; i < e.pts.length - 1; i++) if (cum[i] > tS + 0.3 && cum[i] < tE - 0.3) pts.push(off[i]);
        if (ce) pts.push(ce);
        pts.push(end);
        const clean = [pts[0]];
        for (const p of pts.slice(1)) if (hyp(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 0.05) clean.push(p);
        if (clean.length < 2) continue;
        addFoot({ kind: 'sidewalk', pts: clean, bridge: e.r.bridge, layer: e.r.bridge ? 1 : 0, group: 'sidewalk', road: e.r, side });
      }
    }
    for (const c of crossings) addFoot({ kind: 'crossing', pts: c.pts, bridge: c.r.bridge, layer: c.r.bridge ? 1 : 0, group: 'crossing', road: c.r });
  }

  const walkNet = () => foot.filter((f) => f.group === 'sidewalk' || f.group === 'crossing');
  /** Snaps (x, y) onto the nearest footway in `list` within maxD, splicing in a shared vertex. */
  const snapTo = (list, x, y, maxD) => {
    let best = null;
    for (const f of list) {
      const p = f.pts;
      for (let i = 1; i < p.length; i++) {
        const d2 = distPointSeg2(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
        if (d2 <= maxD * maxD && (!best || d2 < best.d2)) best = { f, i, d2 };
      }
    }
    if (!best) return null;
    const p = best.f.pts, a = p[best.i - 1], b = p[best.i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    return insertVertex(p, best.i, t);
  };
  /** Moves a footway end out of the carriageway to the sidewalk line and joins it to the sidewalk there. */
  const trimAndSnap = (pts, atStart, maxD = 3) => {
    let p = atStart ? pts.slice() : pts.slice().reverse();
    const cum = cumLength(p);
    const L = cum[cum.length - 1];
    let cut = -1;
    for (let s = 0; s <= Math.min(L, 40); s += 0.25) {
      const q = pointAt(p, cum, s);
      if (sidewalkClearance(q.x, q.y) >= -0.05) { cut = s; break; }
    }
    if (cut < 0 || L - cut < 0.5) return null;
    if (cut > 0) p = sliceLine(p, cum, cut, L);
    const v = snapTo(walkNet(), p[0][0], p[0][1], maxD);
    if (v) {
      if (hyp(v[0] - p[0][0], v[1] - p[0][1]) < 0.3 || p.length < 2) p[0] = v;
      else p.unshift(v);
    }
    return atStart ? p : p.reverse();
  };

  // Spec footways: the Exorcist Steps, the towpath and the Capital Crescent Trail.
  let towpath = null;
  for (const st of footSpecs) {
    let pts = st.points.map(P);
    if (/towpath/i.test(st.name)) {
      towpath = addFoot({ kind: 'path', name: st.name, pts: clipPolyline(pts, rect)[0], surface: 'gravel', towpath: 1, group: 'towpath' });
      continue;
    }
    const kind = /steps|stair/i.test(st.name) ? 'steps' : st.kind === 'cycleway' ? 'cycleway' : st.kind === 'path' ? 'path' : 'footway';
    pts = trimAndSnap(pts, true);
    if (pts) pts = trimAndSnap(pts, false);
    if (!pts) { warnings.push(`footway "${st.name}" lies inside a road, skipped`); continue; }
    addFoot({ kind, name: st.name, pts: clipPolyline(pts, rect)[0], surface: kind === 'cycleway' ? 'asphalt' : null, group: 'trail' });
  }

  const roadsNamed = (re) => roads.filter((r) => re.test(r.specName));
  const sidewalksOf = (re) => foot.filter((f) => f.group === 'sidewalk' && f.road && re.test(f.road.specName));
  /** Footway hits on a vertical line x = X, each with its footway: [{f, i, t, x, y}]. */
  const vHitsOn = (list, X) => list.flatMap((f) => vHits(f.pts, X).map((h) => ({ ...h, f })));
  const hHitsOn = (list, Y) => list.flatMap((f) => hHits(f.pts, Y).map((h) => ({ ...h, f })));
  const takeHit = (h) => insertVertex(h.f.pts, h.i, h.t);

  // Canal footbridges (from the spec): M St's south sidewalk down to the north bank, then a bridge to the towpath.
  const canalYAt = (X) => vHits(canalPts, X)[0]?.y;
  for (const fb of spec.water.canal_footbridges ?? []) {
    if (!/footbridge/i.test(fb.name) || !towpath) continue;
    const X = xOfLon(fb.lon);
    const cy = canalYAt(X);
    const mHits = vHitsOn(sidewalksOf(/^M St NW \(Georgetown\)/), X).filter((h) => h.y > cy).sort((a, b) => a.y - b.y);
    const tHits = vHitsOn([towpath], X);
    if (cy == null || !mHits.length || !tHits.length) { warnings.push(`canal footbridge "${fb.name}" could not be connected`); continue; }
    const top = takeHit(mHits[0]);
    const tp = takeHit(tHits[0]);
    const bank = [X, cy + CANAL_HALF_WIDTH + 1.5];
    addFoot({ kind: 'footway', pts: [top, bank], group: 'link' });
    addFoot({ kind: 'footway', pts: [bank, tp], bridge: 1, layer: 1, group: 'footbridge' });
  }

  // Towpath links: steps from the towpath up to the east sidewalk at each street that bridges the canal.
  for (const b of canalBridges) {
    if (!towpath) break;
    const S = b.pts[0][1] < b.pts[b.pts.length - 1][1] ? b.pts[0] : b.pts[b.pts.length - 1];
    const X = S[0] + b.hw + 5;
    const tHits = vHitsOn([towpath], X);
    const sHits = hHitsOn(sidewalksOf(new RegExp(`^${b.specName.replace(/[()]/g, '\\$&')}$`)), S[1] - 5).filter((h) => h.x > S[0]).sort((a, c) => a.x - c.x);
    if (!tHits.length || !sHits.length) continue;
    const tp = takeHit(tHits[0]);
    const sw = takeHit(sHits[0]);
    if (hyp(tp[0] - sw[0], tp[1] - sw[1]) > 25) continue;
    addFoot({ kind: 'steps', pts: [tp, sw], group: 'link' });
  }

  // Waterfront promenade (Georgetown Waterfront Park) and the Washington Harbour boardwalk, 6 m in from the shore.
  let promenade = null, boardwalk = null;
  {
    const inland = offsetLine(shore, 6);
    const cut = (lonA, lonB) => {
      const XA = xOfLon(lonA), XB = xOfLon(lonB);
      const out = [];
      for (let i = 0; i < inland.length - 1; i++) {
        const a = inland[i], b = inland[i + 1];
        const segA = Math.max(Math.min(a[0], b[0]), XA), segB = Math.min(Math.max(a[0], b[0]), XB);
        if (segA > segB) continue;
        for (const X of [segA, segB]) {
          const t = (X - a[0]) / (b[0] - a[0] || 1);
          const q = [X, a[1] + t * (b[1] - a[1])];
          if (!out.length || hyp(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > 0.5) out.push(q);
        }
      }
      return out;
    };
    const pPts = cut(PROMENADE_LON[0], PROMENADE_LON[1]);
    const bPts = cut(PROMENADE_LON[1], PROMENADE_LON[2]);
    if (pPts.length >= 2) promenade = addFoot({ kind: 'footway', pts: pPts, surface: 'paving_stones', group: 'promenade' });
    if (bPts.length >= 2) {
      if (promenade) bPts[0] = promenade.pts[promenade.pts.length - 1];
      boardwalk = addFoot({ kind: 'footway', pts: bPts, surface: 'wood', group: 'promenade' });
    }
    // Links from the Water St / K St south sidewalk down to the promenade, and from the boardwalk's east end to K St.
    const streetSide = sidewalksOf(/^(Water St NW|K St NW \(Georgetown\))$/);
    for (const lon of [...WATERFRONT_LINKS, PROMENADE_LON[2] + 0.00002]) {
      const X = xOfLon(lon);
      const s = vHitsOn(streetSide, X).sort((a, b) => a.y - b.y)[0];
      const p = vHitsOn([promenade, boardwalk].filter(Boolean), X)[0];
      if (!s || !p || s.y < p.y || s.y - p.y > 140) continue;
      const a = takeHit(s), b = takeHit(p);
      addFoot({ kind: 'footway', pts: [a, b], group: 'link' });
    }
  }

  // Rock Creek Trail: 7 m east of the parkway's kerb (on the West End side), passing under the bridges, with steps up
  // to the street at each bridge's east end.
  {
    const pk = roads.find((r) => r.specName === 'Rock Creek and Potomac Parkway');
    const corridor = parkByKey.get('Rock Creek Park corridor');
    if (pk && corridor) {
      const off = offsetLine(pk.pts.filter((p, i) => i === 0 || hyp(p[0] - pk.pts[i - 1][0], p[1] - pk.pts[i - 1][1]) > 1), -(pk.hw + 7));
      const pts = off.filter((p) => pointInRing(p[0], p[1], corridor.ring) && !inWater(p[0], p[1]));
      if (pts.length >= 2) {
        const trail = addFoot({ kind: 'path', name: 'Rock Creek Trail', pts, surface: 'asphalt', group: 'trail' });
        const streets = roads.filter((r) => atGrade(r) && r.sw);
        for (const b of roads.filter((r) => r.bridge && !r.elevated && r.sw && !r.canalBridge)) {
          let X = null;
          for (let i = 1; i < trail.pts.length && !X; i++) {
            for (let j = 1; j < b.pts.length && !X; j++) {
              const h = segIntersect(trail.pts[i - 1][0], trail.pts[i - 1][1], trail.pts[i][0], trail.pts[i][1], b.pts[j - 1][0], b.pts[j - 1][1], b.pts[j][0], b.pts[j][1]);
              if (h) X = { i, t: h.t, x: h.x, y: h.y };
            }
          }
          if (!X) continue;
          const E = [b.pts[0], b.pts[b.pts.length - 1]].sort((p, q) => hyp(p[0] - X.x, p[1] - X.y) - hyp(q[0] - X.x, q[1] - X.y))[0];
          if (hyp(E[0] - X.x, E[1] - X.y) > 35) continue;
          // Candidate landing points: sidewalk vertices of the at-grade streets that meet the bridge end.
          const cands = walkNet().filter((f) => f.road && streets.includes(f.road) && f.road.pts.some((p) => vKey(p) === vKey(E)))
            .flatMap((f) => f.pts).filter((p) => hyp(p[0] - E[0], p[1] - E[1]) < 20)
            .sort((p, q) => hyp(p[0] - X.x, p[1] - X.y) - hyp(q[0] - X.x, q[1] - X.y));
          const ok = (p) => !roads.some((r) => atGrade(r) && r.pts.some((q, k) => k > 0 && segsCross(X.x, X.y, p[0], p[1], r.pts[k - 1][0], r.pts[k - 1][1], q[0], q[1])));
          const S = cands.find(ok);
          if (!S) continue;
          const T = insertVertex(trail.pts, X.i, X.t);
          addFoot({ kind: 'steps', pts: [T, S], group: 'link' });
        }
      }
    }
  }

  // Line footways become obstacles for buildings and car parks.
  const footGrid = new SegGrid(25);
  const addFootObstacle = (f) => {
    if (f.group === 'sidewalk' || f.group === 'crossing') return;
    footGrid.addLine(f.pts, { clear: FOOT_CLEAR[f.kind] ?? 2, f });
  };
  foot.forEach(addFootObstacle);

  // ----------------------------------------------------------------------------------- area obstacles
  const areaList = [];
  const addArea = (ring, margin, tag, obj) => areaList.push({ ring, margin, tag, obj, bb: bboxOf(ring) });
  for (const w of waterAreas) addArea(w.ring, WATER_MARGIN, `water:${w.kind}`);
  for (const p of parks) addArea(p.ring, PARK_MARGIN, `park:${p.name ?? p.kind}`, p);
  for (const p of plazas) addArea(p.ring, 0.5, `plaza:${p.name}`, p);
  for (const p of parking) addArea(p.ring, PARK_MARGIN, 'lot', p);
  for (const c of campuses) if (c.exclusive) addArea(c.ring, 2, `campus:${c.name}`, c);
  for (const k of keepouts) addArea(k.ring, 0, `keepout:${k.tag}`, k);
  const parkKeyTag = (key) => {
    const p = parkByKey.get(key);
    return p ? `park:${p.name ?? p.kind}` : null;
  };
  const areaBlocks = (ring, bb, ignore) => {
    for (const a of areaList) {
      if (ignore && ignore.has(a.tag)) continue;
      if (!bbHit(bb, a.bb, a.margin + 0.01)) continue;
      if (ring.some((p) => pointInRing(p[0], p[1], a.ring))) return a;
      if (a.ring.some((p) => p[0] >= bb.x0 && p[0] <= bb.x1 && p[1] >= bb.y0 && p[1] <= bb.y1 && pointInRing(p[0], p[1], ring))) return a;
      for (let i = 0, n = a.ring.length, j = n - 1; i < n; j = i++) {
        const e = a.ring[j], f = a.ring[i];
        if (Math.max(e[0], f[0]) < bb.x0 - a.margin || Math.min(e[0], f[0]) > bb.x1 + a.margin || Math.max(e[1], f[1]) < bb.y0 - a.margin || Math.min(e[1], f[1]) > bb.y1 + a.margin) continue;
        if (polySegDist(ring, e[0], e[1], f[0], f[1]) < a.margin - 1e-6 || (a.margin === 0 && segCrossesRing(ring, e, f))) return a;
      }
    }
    return null;
  };
  function segCrossesRing(ring, e, f) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) if (segsCross(ring[j][0], ring[j][1], ring[i][0], ring[i][1], e[0], e[1], f[0], f[1])) return true;
    return false;
  }

  const buildings = new BoxGrid(40);
  const MAXC = 25;
  /** Why the ring cannot go here (null = it fits). */
  const blocked = (ring, o = {}) => {
    const bb = bboxOf(ring);
    if (bb.x0 < rect.x0 + 0.5 || bb.x1 > rect.x1 - 0.5 || bb.y0 < rect.y0 + 0.5 || bb.y1 > rect.y1 - 0.5) return 'crop';
    let why = null;
    roadGrid.query(bb.x0 - MAXC, bb.y0 - MAXC, bb.x1 + MAXC, bb.y1 + MAXC, (s) => {
      const c = o.lot ? s.data.lotClear : s.data.clear;
      if (Math.min(s.ax, s.bx) > bb.x1 + c || Math.max(s.ax, s.bx) < bb.x0 - c || Math.min(s.ay, s.by) > bb.y1 + c || Math.max(s.ay, s.by) < bb.y0 - c) return true;
      if (polySegDist(ring, s.ax, s.ay, s.bx, s.by) < c - OVERLAP_TOL) { why = `road ${s.data.name}`; return false; }
      return true;
    });
    if (why) return why;
    footGrid.query(bb.x0 - 4, bb.y0 - 4, bb.x1 + 4, bb.y1 + 4, (s) => {
      if (o.ignoreFoot && o.ignoreFoot.has(s.data.f)) return true;
      if (polySegDist(ring, s.ax, s.ay, s.bx, s.by) < s.data.clear - OVERLAP_TOL) { why = 'footway'; return false; }
      return true;
    });
    if (why) return why;
    const a = areaBlocks(ring, bb, o.ignore);
    if (a) return a.tag;
    const test = o.gap ? inflateRect(ring, o.gap / 2) : ring;
    const tb = o.gap ? bboxOf(test) : bb;
    buildings.query(tb, (b) => {
      if (!bbHit(tb, b.bb)) return true;
      if (convexOverlap(test, b.ring, OVERLAP_TOL)) { why = 'building'; return false; }
      return true;
    });
    return why;
  };

  const blds = []; // internal building records
  const addBuilding = (ring, props) => {
    const b = { id: sid(), ring: ccw(ring), ...props };
    b.h = r1(props.h ?? props.levels * LEVEL_HEIGHT + (props.roof ?? 1));
    blds.push(b);
    buildings.add(b);
    return b;
  };

  /** Fits a w x d rectangle near (x, y): nudged up to 30 m, then shrunk to 60%. */
  const OFFSETS = [];
  for (let a = -30; a <= 30; a += 3) for (let b = -30; b <= 30; b += 3) OFFSETS.push([a, b]);
  OFFSETS.sort((p, q) => hyp(...p) - hyp(...q));
  const placeNear = (x, y, w, d, o = {}) => {
    let ux, uy;
    if (o.angle != null) {
      ux = Math.cos((o.angle * Math.PI) / 180);
      uy = Math.sin((o.angle * Math.PI) / 180);
    } else {
      const nr = nearestRoad(x, y, (r) => atGrade(r) && r.sw);
      ux = nr ? nr.tx : 1;
      uy = nr ? nr.ty : 0;
    }
    for (const sc of [1, 0.9, 0.8, 0.7, 0.6]) {
      for (const [a, b] of OFFSETS) {
        const cx = x + ux * a - uy * b, cy = y + uy * a + ux * b;
        const ring = rectRing(cx, cy, ux, uy, (w * sc) / 2, (d * sc) / 2);
        if (o.inside && !ring.every((p) => pointInRing(p[0], p[1], o.inside))) continue;
        if (!blocked(ring, o)) return { ring, cx, cy, ux, uy, sc, moved: hyp(a, b), w: w * sc, d: d * sc };
      }
    }
    return null;
  };

  // ----------------------------------------------------------------------------------- car parks
  const capacityOf = (ring) => Math.floor(Math.abs(signedArea(ring)) / 25);
  for (const p of parking) p.capacity = capacityOf(p.ring);
  const lotByKey = new Map();
  for (const L of SYNTH_LOTS) {
    const [x, y] = proj.fwd(L.lat, L.lon);
    const pl = placeNear(x, y, L.w, L.d, { lot: true });
    if (!pl) { warnings.push(`car park ${L.key} did not fit`); continue; }
    const lot = { id: sid(), type: 'surface', ring: pl.ring, capacity: capacityOf(pl.ring), access: L.access ?? null, poi: L.poi ?? null, key: L.key, synth: true, moved: pl.moved };
    parking.push(lot);
    lotByKey.set(L.key, lot);
    addArea(lot.ring, PARK_MARGIN, 'lot', lot);
  }

  // ----------------------------------------------------------------------------------- landmark buildings
  const lmByKey = new Map();
  const landmarkReport = [];
  for (const L of LANDMARKS) {
    let pl = null;
    if (L.attach) {
      const parent = lmByKey.get(L.attach);
      if (!parent) continue;
      const { ux, uy, cx, cy } = parent;
      const vx = -uy, vy = ux;
      for (const side of [L.side ?? 1, -(L.side ?? 1)]) {
        for (const along of [0, 0.3, -0.3, 0.45, -0.45]) {
          const dd = parent.d / 2 + L.d / 2;
          const x = cx + vx * dd * side + ux * along * parent.w, y = cy + vy * dd * side + uy * along * parent.w;
          const ring = rectRing(x, y, ux, uy, L.w / 2, L.d / 2);
          if (!blocked(ring, { ignore: parent.ignore })) { pl = { ring, cx: x, cy: y, ux, uy, sc: 1, moved: 0, w: L.w, d: L.d }; break; }
        }
        if (pl) break;
      }
    } else {
      const [x, y] = proj.fwd(L.lat, L.lon);
      const ignore = new Set();
      let inside = null;
      if (L.inPark) {
        const t = parkKeyTag(L.inPark);
        if (t) ignore.add(t);
        inside = parkByKey.get(L.inPark)?.ring ?? null;
      }
      if (L.inPlaza) for (const p of plazas) ignore.add(`plaza:${p.name}`);
      if (L.campus) for (const c of campuses) if (pointInRing(x, y, c.ring)) { ignore.add(`campus:${c.name}`); inside = c.ring; }
      pl = placeNear(x, y, L.w, L.d, { angle: L.angle, ignore, inside });
      if (pl) pl.ignore = ignore;
    }
    if (!pl) { warnings.push(`landmark ${L.key} did not fit`); landmarkReport.push({ key: L.key, placed: false }); continue; }
    const b = addBuilding(pl.ring, { type: L.type, levels: L.levels, h: L.h, roof: 1.5, zone: 'landmark', landmark: L.key });
    Object.assign(pl, { b });
    lmByKey.set(L.key, pl);
    landmarkReport.push({ key: L.key, placed: true, moved: r1(pl.moved), scale: pl.sc });
    // Buildings inside a park or plaza cut a hole in it.
    if (L.inPark) parkByKey.get(L.inPark)?.holes.push(b.ring);
    if (L.inPlaza) for (const p of plazas) if (pointInRing(...centroid(b.ring), p.ring)) p.holes.push(b.ring);
  }

  // Docks: piers from each boathouse into the river, and boat slips off the Washington Harbour boardwalk.
  const shoreCum = cumLength(shore);
  for (const L of LANDMARKS) {
    const pl = lmByKey.get(L.key);
    if (!L.boathouse || !pl) continue;
    const [cx, cy] = centroid(pl.b.ring);
    const pr = projectOnLine(shore, shoreCum, cx, cy);
    for (let k = 0; k < L.boathouse; k++) {
      const s = pr.s + (k - (L.boathouse - 1) / 2) * 10;
      const q = pointAt(shore, shoreCum, s);
      // Water is to the right of the shore line (south).
      const nx = q.ty, ny = -q.tx;
      const len = L.boathouse > 1 ? 28 : 16;
      const start = [q.x - nx * 1.5, q.y - ny * 1.5];
      addFoot({ kind: 'footway', pts: [start, [q.x + nx * len, q.y + ny * len]], surface: 'wood', pier: 1, group: 'dock' });
      // Path from the dock to the nearest trail or sidewalk within 45 m, unless a street, water or building is in the way.
      const targets = foot.filter((f) => f.group === 'trail' || f.group === 'promenade' || ((f.group === 'sidewalk' || f.group === 'crossing') && !f.bridge));
      let best = null;
      for (const f of targets) {
        const pr2 = projectOnLine(f.pts, cumLength(f.pts), start[0], start[1]);
        if (pr2.d2 < 45 * 45 && (!best || pr2.d2 < best.pr.d2)) best = { f, pr: pr2 };
      }
      if (best && k === 0) {
        const tgt = [best.pr.x, best.pr.y];
        let clear = !roads.some((r) => atGrade(r) && r.pts.some((p, j) => j > 0 && segsCross(start[0], start[1], tgt[0], tgt[1], r.pts[j - 1][0], r.pts[j - 1][1], p[0], p[1])));
        for (let s = 0.1; s < 1 && clear; s += 0.1) {
          const x = start[0] + (tgt[0] - start[0]) * s, y = start[1] + (tgt[1] - start[1]) * s;
          if (inWater(x, y)) clear = false;
          buildings.query({ x0: x, y0: y, x1: x, y1: y }, (bb) => { if (bb !== pl.b && pointInRing(x, y, bb.ring)) clear = false; return clear; });
        }
        if (clear) addFootObstacle(addFoot({ kind: 'footway', pts: [start, insertVertex(best.f.pts, best.pr.i, best.pr.t)], group: 'link' }));
      }
    }
  }
  if (boardwalk) {
    for (const lon of HARBOUR_PIERS) {
      const h = vHitsOn([boardwalk], xOfLon(lon))[0];
      if (!h) continue;
      const start = takeHit(h);
      const q = projectOnLine(shore, shoreCum, start[0], start[1]);
      const at = pointAt(shore, shoreCum, q.s);
      const nx = at.ty, ny = -at.tx;
      const end = [q.x + nx * 30, q.y + ny * 30];
      addFoot({ kind: 'footway', pts: [start, end], surface: 'wood', pier: 1, group: 'dock' });
      addFoot({ kind: 'footway', pts: [[end[0] - at.tx * 12, end[1] - at.ty * 12], end, [end[0] + at.tx * 12, end[1] + at.ty * 12]], surface: 'wood', pier: 1, group: 'dock' });
    }
  }

  // ----------------------------------------------------------------------------------- park paths
  // Two paths crossing each park through its centre along its main axes, joined to the nearest sidewalk.
  for (const p of parks) {
    if (/corridor/i.test(p.name ?? '') || p.kind === 'leisure=garden') continue;
    const area = Math.abs(signedArea(p.ring));
    if (area < 1000) continue;
    const c = centroid(p.ring);
    if (!pointInRing(c[0], c[1], p.ring) || p.holes.some((h) => pointInRing(c[0], c[1], h))) continue;
    // Main axis from the covariance of the ring vertices.
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of p.ring) { const dx = q[0] - c[0], dy = q[1] - c[1]; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const axes = [[Math.cos(ang), Math.sin(ang)], [-Math.sin(ang), Math.cos(ang)]];
    for (const [ux, uy] of axes) {
      const arm = (sx) => {
        let best = Infinity;
        for (let i = 0, n = p.ring.length, j = n - 1; i < n; j = i++) {
          const h = segIntersect(c[0], c[1], c[0] + sx * ux * 5000, c[1] + sx * uy * 5000, p.ring[j][0], p.ring[j][1], p.ring[i][0], p.ring[i][1]);
          if (h) best = Math.min(best, h.t * 5000);
        }
        if (!Number.isFinite(best) || best < 4) return null;
        const end = [c[0] + sx * ux * (best - 0.5), c[1] + sx * uy * (best - 0.5)];
        // Reject arms that cross water or a building.
        for (let s = 0; s <= best; s += 3) {
          const x = c[0] + sx * ux * s, y = c[1] + sx * uy * s;
          if (inWater(x, y)) return null;
          let hit = false;
          buildings.query({ x0: x, y0: y, x1: x, y1: y }, (b) => { if (pointInRing(x, y, b.ring)) { hit = true; return false; } return true; });
          if (hit) return null;
        }
        return end;
      };
      const e1 = arm(1), e2 = arm(-1);
      const pts = [];
      const join = (e) => {
        const v = snapTo(walkNet(), e[0], e[1], 16);
        return v ? [v, e] : [e];
      };
      if (e1) pts.push(...join(e1)); // [sidewalk vertex, park edge]
      pts.push(c);
      if (e2) pts.push(...join(e2).reverse()); // [park edge, sidewalk vertex]
      if (pts.length < 2) continue;
      const f = addFoot({ kind: 'footway', pts, group: 'parkpath' });
      addFootObstacle(f);
    }
  }

  // ----------------------------------------------------------------------------------- campus buildings
  for (const c of campuses) {
    if (!c.exclusive) continue;
    const ignore = new Set([`campus:${c.name}`]);
    const bb = bboxOf(c.ring);
    const inset = (ring) => ring.every((p) => pointInRing(p[0], p[1], c.ring)) && c.ring.every((q, i) => {
      const r = c.ring[(i + 1) % c.ring.length];
      return polySegDist(ring, q[0], q[1], r[0], r[1]) >= 4;
    });
    for (let y = bb.y0 + 20; y < bb.y1 - 10; y += 46) {
      for (let x = bb.x0 + 15; x < bb.x1 - 10; x += 42) {
        const horiz = rng() < 0.5;
        const w = rand(34, 68), d = rand(16, 26);
        const ring = rectRing(x + rand(-6, 6), y + rand(-6, 6), horiz ? 1 : 0, horiz ? 0 : 1, w / 2, d / 2);
        if (!inset(ring) || blocked(ring, { ignore, gap: 10 })) continue;
        addBuilding(ring, { type: 'university', levels: randInt(3, 6), roof: 2, zone: 'campus' });
      }
    }
  }

  // ----------------------------------------------------------------------------------- frontage buildings
  const mSt = roads.filter((r) => r.specName === 'M St NW (Georgetown)').flatMap((r) => r.pts);
  const southOfM = (x, y) => {
    const h = vHits(mSt, x)[0];
    return h ? y < h.y - 2 : false;
  };
  const Y_N = yOfLat(38.9066), Y_Q = yOfLat(38.9104), Y_K = yOfLat(38.9026), Y_DUP = yOfLat(38.9062);
  const X_KEYBRIDGE = xOfLon(-77.0703);
  const zoneFor = (r, side, x, y, nx) => {
    const n = r.specName;
    if (!atGrade(r) || !r.sw || /ramp|underpass/i.test(n)) return null;
    if (n === 'M St NW (Georgetown)' || n === 'Pennsylvania Ave NW (Georgetown)') return 'shopping';
    if (n === 'Wisconsin Ave NW') return y < Y_N ? 'shopping' : 'bookhill';
    if (n === 'K St NW (Georgetown)') return 'waterfront';
    if (n === 'Water St NW') return x < X_KEYBRIDGE ? 'warehouse' : 'waterfront';
    if (n === 'Grace St NW' || n === 'South St NW' || n === 'Thomas Jefferson St NW') return 'warehouse';
    if (n === 'Prospect St NW') return 'prospect';
    if (n === '37th St NW') return nx < 0 ? null : y > yOfLat(38.9079) && y < yOfLat(38.9094) ? 'campusedge' : 'rowhouse';
    if (NUMBERED.has(n)) return southOfM(x, y) ? 'warehouse' : y > Y_Q ? 'mansion' : 'rowhouse';
    if (n === 'Q St NW (Georgetown)' || n === 'R St NW') return 'mansion';
    if (WEST_END.has(n)) return 'westend';
    if (n === '25th St NW' || n === '24th St NW') return y < Y_K ? 'foggy' : 'westend';
    if (n === '23rd St NW (north of Washington Circle)') return y > Y_DUP ? 'dupont' : 'westend';
    if (n === '22nd St NW') return y < Y_K ? 'foggy' : y > Y_DUP ? 'dupont' : 'westend';
    if (FOGGY.has(n)) return 'foggy';
    if (/east of Rock Creek/.test(n)) return 'dupont';
    return 'rowhouse';
  };
  const orderOf = (r) => {
    const i = FRONTAGE_ORDER.indexOf(r.specName);
    return i < 0 ? FRONTAGE_ORDER.length : i;
  };
  const frontRoads = roads.filter((r) => atGrade(r) && r.sw && !r.closed).sort((a, b) => orderOf(a) - orderOf(b) || lineLength(b.pts) - lineLength(a.pts));
  const circle = roads.find((r) => r.closed && r.sw);
  if (circle) frontRoads.splice(FRONTAGE_ORDER.indexOf('Washington Circle'), 0, circle);
  let frontageTries = 0;
  for (const r of frontRoads) {
    const pts = r.pts;
    const cum = cumLength(pts);
    const L = cum[cum.length - 1];
    for (const side of [1, -1]) {
      let s = 0.5;
      let run = null;
      while (s < L - 2) {
        const at = pointAt(pts, cum, s);
        const nx = -at.ty * side, ny = at.tx * side;
        const zk = zoneFor(r, side, at.x, at.y, nx);
        if (!zk) { s += 5; run = null; continue; }
        const z = ZONES[zk];
        if (run && run.zone !== zk) run = null;
        const setback = z.setback ? rand(...z.setback) : 0;
        const gap = z.gap ? rand(...z.gap) : 0;
        const w0 = rand(...z.w);
        let placed = null;
        const segLeft = cum[at.i] - s;
        for (const w of [w0, Math.max(z.w[0], w0 * 0.7), z.w[0]]) {
          if (s + w > L + 0.5) continue;
          const dPref = run && rng() < 0.7 ? run.d : rand(...z.d);
          const depths = [];
          for (let d = dPref; d >= z.dMin - 1e-9; d -= 2) depths.push(d);
          if (depths[depths.length - 1] > z.dMin) depths.push(z.dMin);
          for (const d of depths) {
            frontageTries++;
            const off = r.clear + setback;
            const fx = at.x + nx * off, fy = at.y + ny * off;
            const ring = [[fx, fy], [fx + at.tx * w, fy + at.ty * w], [fx + at.tx * w + nx * d, fy + at.ty * w + ny * d], [fx + nx * d, fy + ny * d]];
            if (blocked(ring, { gap: z.gap ? Math.max(gap, z.gap[0]) : 0 })) continue;
            placed = { ring, w, d, fx, fy };
            break;
          }
          if (placed) break;
          if (segLeft < w) break;
        }
        if (!placed) { s += 1.5; run = null; continue; }
        const type = pickWeighted(z.types);
        let levels = randInt(...z.levels);
        if (run && z.runLevels && rng() < z.runLevels) levels = run.levels;
        const b = addBuilding(placed.ring, { type, levels, roof: z.roof * rand(0.6, 1.4), zone: zk, road: r });
        b.front = { x: placed.fx + (at.tx * placed.w) / 2, y: placed.fy + (at.ty * placed.w) / 2, nx, ny, a: [placed.fx, placed.fy], b: [placed.fx + at.tx * placed.w, placed.fy + at.ty * placed.w] };
        run = { zone: zk, levels, d: placed.d };
        s += placed.w + gap;
      }
    }
  }

  // ----------------------------------------------------------------------------------- road graph (for corners, props, validation)
  const outKey = (p) => `${r1(p[0])},${r1(-p[1])}`;
  const gNodes = new Map(); // key -> {p, nbr:Set, roads:Set}
  for (const r of roads) {
    for (let i = 0; i < r.pts.length; i++) {
      const k = outKey(r.pts[i]);
      let nd = gNodes.get(k);
      if (!nd) gNodes.set(k, (nd = { p: r.pts[i], nbr: new Set(), roads: new Set() }));
      nd.roads.add(r);
      if (i > 0) {
        const kp = outKey(r.pts[i - 1]);
        if (kp !== k) { nd.nbr.add(kp); gNodes.get(kp).nbr.add(k); }
      }
    }
  }
  const junctionNodes = [...gNodes.values()].filter((n) => n.nbr.size >= 3);

  // ----------------------------------------------------------------------------------- POIs
  const pois = [];
  const addPoi = (x, y, cat, subcat, b) => {
    if (!inRect([x, y], rect)) return null;
    let sub = subcat ?? null;
    if (!sub && cat === 'amenity=restaurant') sub = pick(CUISINES);
    if (!sub && cat === 'amenity=fast_food') sub = pick(FAST_FOOD);
    if (!sub && cat === 'amenity=cafe') sub = 'coffee_shop';
    const p = { id: sid(), x, y, cat };
    if (sub) p.subcat = sub;
    if (b) { p.b = b.id; b.pois = (b.pois ?? 0) + 1; }
    pois.push(p);
    return p;
  };
  const tables = {};
  for (const [key, w] of Object.entries(POI_WEIGHTS)) {
    const fromSpec = new Set();
    for (const row of spec.street_character ?? []) {
      const text = `${row.street}${row.segment ? ` ${row.segment}` : ''}`;
      if (!(POI_SOURCES[key] ?? []).some((re) => re.test(row.street) || re.test(text))) continue;
      for (const word of row.typical_shop_categories ?? []) {
        const cats = CATEGORY_WORDS[word.toLowerCase()];
        if (!cats) { warnings.push(`street character "${word}" has no OSM category mapping, skipped`); continue; }
        cats.forEach((c) => fromSpec.add(c));
      }
    }
    tables[key] = [...[...fromSpec].map((c) => [c, w[c] ?? 2]), ...Object.entries(w.extra ?? {})];
  }
  // Landmark POIs.
  for (const L of LANDMARKS) {
    const pl = lmByKey.get(L.key);
    if (!pl) continue;
    const [cx, cy] = centroid(pl.b.ring);
    if (L.poi) addPoi(cx, cy, L.poi, L.subcat, pl.b);
    (L.extraPois ?? []).forEach((c, i) => {
      const [cat, sub] = c.split(':');
      const t = (i + 1) / ((L.extraPois.length + 1));
      const q = [pl.ring[0][0] + (pl.ring[1][0] - pl.ring[0][0]) * t + (pl.ring[3][0] - pl.ring[0][0]) * 0.15, pl.ring[0][1] + (pl.ring[1][1] - pl.ring[0][1]) * t + (pl.ring[3][1] - pl.ring[0][1]) * 0.15];
      addPoi(q[0], q[1], cat, sub, pl.b);
    });
    if (L.key === 'healy') addPoi(cx, cy, 'amenity=university', null, pl.b);
  }
  // Campuses, the marina, car parks, the metro entrance and the statue.
  for (const c of campuses) {
    if (c.exclusive) continue;
    const [cx, cy] = centroid(c.ring);
    let host = null;
    buildings.query({ x0: cx - 60, y0: cy - 60, x1: cx + 60, y1: cy + 60 }, (b) => { if (b.type === 'university' && (!host || hyp(...centroid(b.ring).map((v, i) => v - [cx, cy][i])) < hyp(...centroid(host.ring).map((v, i) => v - [cx, cy][i])))) host = b; return true; });
    if (host) addPoi(...centroid(host.ring), 'amenity=university', null, host);
  }
  if (marina) addPoi(...centroid(marina.ring), 'leisure=marina', null, null);
  for (const p of parking) if (p.poi) addPoi(...centroid(p.ring), p.poi, 'surface', null);
  if (metro) addPoi(...proj.fwd(metro.lat, metro.lon), 'railway=subway_entrance', null, null);
  const statue = spec.landmarks.find((l) => l.kind === 'statue');
  if (statue) addPoi(...proj.fwd(statue.lat, statue.lon), 'historic=memorial', 'statue', null);
  // Service POIs: one each, in the nearest frontage building without a POI.
  const frontBlds = blds.filter((b) => b.front);
  const poiPoint = (b) => [b.front.x + b.front.nx * 2.5, b.front.y + b.front.ny * 2.5];
  for (const s of SERVICE_POIS) {
    const [x, y] = proj.fwd(s.lat, s.lon);
    let best = null;
    for (const b of frontBlds) {
      if (b.pois || b.type === 'house' || b.type === 'university') continue;
      const d = hyp(b.front.x - x, b.front.y - y);
      if (d < 120 && (!best || d < best.d)) best = { b, d };
    }
    if (!best) { warnings.push(`service POI ${s.cat} found no building near ${s.lat},${s.lon}`); continue; }
    addPoi(...poiPoint(best.b), s.cat, null, best.b);
  }
  // Street POIs by zone; corner shops in residential zones.
  const nearJunction = (pt) => junctionNodes.some((n) => hyp(n.p[0] - pt[0], n.p[1] - pt[1]) < 24);
  for (const b of frontBlds) {
    if (b.pois) continue;
    const z = ZONES[b.zone];
    if (!z?.pois) continue;
    let p = z.poiP;
    if (z.cornerP && (nearJunction(b.front.a) || nearJunction(b.front.b))) p = z.cornerP;
    if (b.type === 'house' || b.type === 'university' || rng() >= p) continue;
    let table = tables[z.pois];
    if (!table?.length) continue;
    if (b.zone === 'waterfront') table = table.map(([c, w]) => [c, w]);
    const cat = pickWeighted(table);
    const sub = cat === 'amenity=restaurant' && b.zone === 'waterfront' && rng() < 0.45 ? 'seafood' : cat === 'amenity=restaurant' && b.zone === 'bookhill' && rng() < 0.4 ? 'french' : null;
    addPoi(...poiPoint(b), cat, sub, b);
  }

  // ----------------------------------------------------------------------------------- props
  const props = [];
  const prop = (x, y, kind) => { if (inRect([x, y], rect)) props.push([r1(x), r1(-y), kind]); };
  const RANK = { motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, service: 0 };
  for (const n of junctionNodes) {
    const rs = [...n.roads].filter(atGrade);
    if (rs.length < 2) continue;
    const ranks = rs.map((r) => RANK[r.highway] ?? 0).sort((a, b) => b - a);
    const ring = rs.some((r) => r.junction === 'roundabout');
    if (ranks[0] >= 3 || (ranks[0] >= 2 && ranks[1] >= 2) || ring) prop(n.p[0], n.p[1], 'signals');
    else prop(n.p[0], n.p[1], 'stop');
  }
  for (const lon of LOCKS) {
    const X = xOfLon(lon);
    for (const dx of [-13, 13]) {
      const y = canalYAt(X + dx);
      if (y != null) prop(X + dx, y, 'lock_gate');
    }
  }
  if (fountainLm) prop(...proj.fwd(fountainLm.lat, fountainLm.lon), 'fountain');
  for (const p of plazas) {
    const c = centroid(p.ring);
    if (!p.holes.some((h) => pointInRing(c[0], c[1], h))) prop(c[0], c[1], 'fountain');
  }
  const inBuilding = (x, y, pad = 0.5) => {
    let hit = false;
    buildings.query({ x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad }, (b) => {
      if (pointInRing(x, y, b.ring) || b.ring.some((q, i) => distPointSeg2(x, y, q[0], q[1], b.ring[(i + 1) % 4][0], b.ring[(i + 1) % 4][1]) < pad * pad)) { hit = true; return false; }
      return true;
    });
    return hit;
  };
  const nearFoot = (x, y, d) => {
    let hit = false;
    footGrid.query(x - d, y - d, x + d, y + d, (s) => { if (distPointSeg2(x, y, s.ax, s.ay, s.bx, s.by) < d * d) { hit = true; return false; } return true; });
    return hit;
  };
  // Street trees, lamps and bus stops along the sidewalks.
  const BUS_STREETS = /^(M St NW|Wisconsin Ave NW|K St NW \(West End\)|Pennsylvania Ave NW \(West End\)|23rd St NW)/;
  for (const f of foot) {
    if (f.group !== 'sidewalk' || !f.road || f.bridge) continue;
    const r = f.road;
    const cum = cumLength(f.pts);
    const L = cum[cum.length - 1];
    if (L < 24) continue;
    const big = RANK[r.highway] >= 3;
    const treeStep = big ? 15 : 11;
    for (let s = 10 + rng() * 4; s < L - 10; s += treeStep * rand(0.85, 1.15)) {
      const q = pointAt(f.pts, cum, s);
      const ox = -q.ty * f.side, oy = q.tx * f.side; // away from the road
      const x = q.x + ox * 1.1, y = q.y + oy * 1.1;
      if (inBuilding(x, y, 1) || inWater(x, y) || sidewalkClearance(x, y) < 0.8) continue;
      prop(x, y, 'tree');
    }
    if (RANK[r.highway] >= 2) {
      for (let s = 8; s < L - 4; s += 32) {
        const q = pointAt(f.pts, cum, s);
        const ox = q.ty * f.side, oy = -q.tx * f.side; // toward the kerb
        prop(q.x + ox * 1.1, q.y + oy * 1.1, 'lamp');
      }
    }
    if (BUS_STREETS.test(r.specName) && L > 60) {
      // Roughly every 300 m along each side, staggered between the two sides.
      for (let s = f.side > 0 ? 40 : 190; s < L - 20; s += 300) {
        const q = pointAt(f.pts, cum, s);
        prop(q.x + q.ty * f.side * 1.1, q.y - q.tx * f.side * 1.1, 'bus_stop');
      }
    }
  }
  // Park trees and benches.
  for (const p of parks) {
    const dense = /corridor/i.test(p.name ?? '');
    const step = dense ? 11 : p.kind === 'landuse=cemetery' ? 14 : 16;
    const bb = bboxOf(p.ring);
    for (let y = bb.y0 + step / 2; y < bb.y1; y += step) {
      for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
        const tx = x + rand(-0.35, 0.35) * step, ty = y + rand(-0.35, 0.35) * step;
        if (!pointInRing(tx, ty, p.ring) || p.holes.some((h) => pointInRing(tx, ty, h))) continue;
        if (inWater(tx, ty) || nearFoot(tx, ty, 2.5) || inBuilding(tx, ty, 1)) continue;
        let onRoad = false;
        roadGrid.query(tx - 25, ty - 25, tx + 25, ty + 25, (s) => { if (Math.sqrt(distPointSeg2(tx, ty, s.ax, s.ay, s.bx, s.by)) < s.data.hw + (s.data.sw ? SIDEWALK_WIDTH : 1.5) + 0.5) { onRoad = true; return false; } return true; });
        if (onRoad || (!dense && rng() < 0.35)) continue;
        prop(tx, ty, 'tree');
      }
    }
  }
  for (const f of foot) {
    if (f.group !== 'parkpath' && f.group !== 'promenade') continue;
    const cum = cumLength(f.pts);
    const L = cum[cum.length - 1];
    for (let s = 12; s < L - 6; s += 35) {
      const q = pointAt(f.pts, cum, s);
      const x = q.x - q.ty * 1.8, y = q.y + q.tx * 1.8;
      if (!inWater(x, y) && !inBuilding(x, y)) prop(x, y, 'bench');
    }
  }
  props.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]));

  // ----------------------------------------------------------------------------------- heightfield
  const heights = buildHeights();

  function buildHeights() {
    const pts = []; // [x, y, h, lambda]
    for (const e of spec.elevation ?? []) pts.push([...proj.fwd(e.lat, e.lon), e.metres, 0.002]);
    for (const [la, lo, m] of HEIGHT_ANCHORS) pts.push([...proj.fwd(la, lo), m, 0.02]);
    for (let s = 0; s < shoreCum[shoreCum.length - 1]; s += 40) {
      const q = pointAt(shore, shoreCum, s);
      pts.push([q.x, q.y, RIVER_BANK_HEIGHT, 0.02]);
    }
    const river = waterAreas.find((w) => w.kind === 'river');
    if (river) {
      const bb = bboxOf(river.ring);
      for (let y = bb.y0 + 20; y < bb.y1; y += 70) {
        for (let x = bb.x0 + 20; x < bb.x1; x += 70) {
          if (!pointInRing(x, y, river.ring)) continue;
          if (projectOnLine(shore, shoreCum, x, y).d2 < 30 * 30) continue;
          pts.push([x, y, 0, 0.02]);
        }
      }
    }
    const creekLevel = (y) => {
      const lat = proj.inv(0, y)[0];
      const L = CREEK_LEVELS;
      if (lat <= L[0][0]) return L[0][1];
      for (let i = 1; i < L.length; i++) if (lat <= L[i][0]) return L[i - 1][1] + ((lat - L[i - 1][0]) / (L[i][0] - L[i - 1][0])) * (L[i][1] - L[i - 1][1]);
      return L[L.length - 1][1];
    };
    const cCum = cumLength(creekPts);
    for (let s = 0; s <= cCum[cCum.length - 1]; s += 40) {
      const q = pointAt(creekPts, cCum, s);
      pts.push([q.x, q.y, creekLevel(q.y), 0.02]);
    }
    // Thin-plate spline in km with per-point smoothing.
    const n = pts.length;
    const X = pts.map((p) => p[0] / 1000), Y = pts.map((p) => p[1] / 1000);
    const phi = (r2) => (r2 > 1e-12 ? 0.5 * r2 * Math.log(r2) : 0);
    const N = n + 3;
    const A = Array.from({ length: N }, () => new Float64Array(N));
    const b = new Float64Array(N);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] = phi((X[i] - X[j]) ** 2 + (Y[i] - Y[j]) ** 2) + (i === j ? pts[i][3] : 0);
      A[i][n] = 1; A[i][n + 1] = X[i]; A[i][n + 2] = Y[i];
      A[n][i] = 1; A[n + 1][i] = X[i]; A[n + 2][i] = Y[i];
      b[i] = pts[i][2];
    }
    const sol = solve(A, b);
    const f = (x, y) => {
      const xk = x / 1000, yk = y / 1000;
      let v = sol[n] + sol[n + 1] * xk + sol[n + 2] * yk;
      for (let i = 0; i < n; i++) v += sol[i] * phi((xk - X[i]) ** 2 + (yk - Y[i]) ** 2);
      return v;
    };
    const sp = HEIGHT_SPACING;
    const x0 = rect.x0, z0 = -rect.y1;
    const nx = Math.ceil((rect.x1 - rect.x0) / sp) + 1, nz = Math.ceil((rect.y1 - rect.y0) / sp) + 1;
    const data = new Array(nx * nz);
    const creek = waterAreas.find((w) => w.kind === 'stream');
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + ix * sp, y = -(z0 + iz * sp);
        let h = f(x, y);
        if (river && pointInRing(x, y, river.ring)) h = RIVER_BED;
        else if (creek && pointInRing(x, y, creek.ring)) h = Math.min(Math.max(h, LAND_MIN), creekLevel(y)) - CREEK_DEPTH;
        else h = Math.max(h, LAND_MIN);
        data[iz * nx + ix] = r1(h);
      }
    }
    const misfit = (spec.elevation ?? []).map((e) => {
      const [x, y] = proj.fwd(e.lat, e.lon);
      return { lat: e.lat, lon: e.lon, want: e.metres, got: r1(f(x, y)) };
    });
    return { spacing: sp, x0: r1(x0), z0: r1(z0), nx, nz, data, misfit, fn: f, creekLevel };
  }

  // ----------------------------------------------------------------------------------- validation
  const report = validate();

  function validate() {
    // Road graph: undirected components, intersections, dead ends, directed strong components.
    const keys = [...gNodes.keys()];
    const idx = new Map(keys.map((k, i) => [k, i]));
    const parent = keys.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    for (const [k, nd] of gNodes) for (const m of nd.nbr) { const a = find(idx.get(k)), c = find(idx.get(m)); if (a !== c) parent[a] = c; }
    const comps = new Map();
    keys.forEach((k, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, new Set()); for (const rd of gNodes.get(k).roads) comps.get(r).add(rd.specName); });
    const compList = [...comps.values()].map((s) => [...s]).sort((a, b) => b.length - a.length);
    const degrees = {};
    for (const nd of gNodes.values()) degrees[nd.nbr.size] = (degrees[nd.nbr.size] ?? 0) + 1;
    const deadEnds = [...gNodes.values()].filter((n) => n.nbr.size === 1);
    const onCropEdge = (p) => Math.min(p[0] - rect.x0, rect.x1 - p[0], p[1] - rect.y0, rect.y1 - p[1]) < 1;
    // Directed graph.
    const adj = keys.map(() => []);
    for (const r of roads) {
      for (let i = 1; i < r.pts.length; i++) {
        const a = idx.get(outKey(r.pts[i - 1])), c = idx.get(outKey(r.pts[i]));
        if (a === c) continue;
        if (r.oneway >= 0) adj[a].push(c);
        if (r.oneway <= 0) adj[c].push(a);
      }
    }
    const scc = tarjan(adj);
    const sccSizes = scc.map((c) => c.length).sort((a, b) => b - a);
    const largest = scc.reduce((m, c) => (c.length > m.length ? c : m), []);
    const inLargest = new Set(largest);
    const outsideLargest = keys.filter((_, i) => !inLargest.has(i)).map((k) => {
      const nd = gNodes.get(k);
      return { at: latlon(...nd.p), roads: [...nd.roads].map((r) => r.specName) };
    });
    // Roundabout.
    const rings = roads.filter((r) => r.junction === 'roundabout').map((r) => {
      const ringKeys = new Set(r.pts.map(outKey));
      const spokes = roads.filter((o) => o !== r && o.pts.some((p) => ringKeys.has(outKey(p))));
      return { name: r.name, closed: outKey(r.pts[0]) === outKey(r.pts[r.pts.length - 1]), vertices: r.pts.length, oneway: r.oneway, spokes: spokes.length, spokeNames: spokes.map((o) => o.specName) };
    });
    // At-grade roads crossing without a shared node, and at-grade roads over water.
    const crossings = [];
    const ag = roads.filter(atGrade);
    for (let i = 0; i < ag.length; i++) {
      for (let j = i + 1; j < ag.length; j++) {
        const A = ag[i].pts, B = ag[j].pts;
        for (let a = 1; a < A.length; a++) for (let c = 1; c < B.length; c++) {
          if (segsCross(A[a - 1][0], A[a - 1][1], A[a][0], A[a][1], B[c - 1][0], B[c - 1][1], B[c][0], B[c][1])) {
            const h = segIntersect(A[a - 1][0], A[a - 1][1], A[a][0], A[a][1], B[c - 1][0], B[c - 1][1], B[c][0], B[c][1]);
            crossings.push({ a: ag[i].specName, b: ag[j].specName, at: h ? latlon(h.x, h.y) : null });
          }
        }
      }
    }
    const roadsInWater = [];
    for (const r of ag) {
      const cum = cumLength(r.pts);
      for (let s = 0; s <= cum[cum.length - 1]; s += 2) {
        const q = pointAt(r.pts, cum, s);
        if (inWater(q.x, q.y, ['river', 'canal', 'stream'])) { roadsInWater.push({ road: r.specName, at: latlon(q.x, q.y) }); break; }
      }
    }
    // Buildings against roads (importer-style overlap report), each other, water and parks.
    const overlapCarriageway = [], inSidewalkBuffer = [];
    for (const b of blds) {
      const bb = bboxOf(b.ring);
      let worst = null, worstBuf = null;
      roadGrid.query(bb.x0 - 25, bb.y0 - 25, bb.x1 + 25, bb.y1 + 25, (s) => {
        const r = s.data;
        if (!atGrade(r)) return true;
        const d = polySegDist(b.ring, s.ax, s.ay, s.bx, s.by);
        if (STREET_TYPES.has(r.highway) && d < r.hw && (!worst || r.hw - d > worst.depth)) worst = { depth: r.hw - d, road: r.specName };
        const buf = r.sw ? r.hw + SIDEWALK_WIDTH + BUILDING_SETBACK : r.hw + NO_SIDEWALK_CLEAR;
        if (d < buf - 0.1 && (!worstBuf || buf - d > worstBuf.depth)) worstBuf = { depth: buf - d, road: r.specName };
        return true;
      });
      if (worst) overlapCarriageway.push({ building: b.id, ...worst, depth: r1(worst.depth), at: latlon(...centroid(b.ring)) });
      if (worstBuf) inSidewalkBuffer.push({ building: b.id, ...worstBuf, depth: r1(worstBuf.depth), at: latlon(...centroid(b.ring)) });
    }
    let bldOverlaps = 0;
    for (const b of blds) buildings.query(b.bb, (o) => { if (o !== b && o.id > b.id && bbHit(b.bb, o.bb) && convexOverlap(b.ring, o.ring, OVERLAP_TOL)) bldOverlaps++; return true; });
    const inWaterOrPark = [];
    const inParkHole = blds.filter((b) => parks.some((p) => p.holes.includes(b.ring)) || plazas.some((p) => p.holes.includes(b.ring))).map((b) => b.landmark);
    for (const b of blds) {
      const c = centroid(b.ring);
      const pts = [...b.ring, c];
      const wet = waterAreas.find((w) => pts.some((p) => pointInRing(p[0], p[1], w.ring)));
      const park = parks.find((p) => pts.some((q) => pointInRing(q[0], q[1], p.ring)) && !p.holes.some((h) => h === b.ring));
      if (wet || park) inWaterOrPark.push({ building: b.id, landmark: b.landmark ?? null, in: wet ? wet.kind : park.name ?? park.kind, at: latlon(...c) });
    }
    // Footway network: components by shared vertices.
    const fKey = (p) => outKey(p);
    const fParent = new Map();
    const ff = (k) => { while (fParent.get(k) !== k) { fParent.set(k, fParent.get(fParent.get(k))); k = fParent.get(k); } return k; };
    for (const f of foot) for (const p of f.pts) if (!fParent.has(fKey(p))) fParent.set(fKey(p), fKey(p));
    for (const f of foot) for (let i = 1; i < f.pts.length; i++) { const a = ff(fKey(f.pts[i - 1])), c = ff(fKey(f.pts[i])); if (a !== c) fParent.set(a, c); }
    const fComp = new Map();
    for (const f of foot) { const r = ff(fKey(f.pts[0])); fComp.set(r, (fComp.get(r) ?? 0) + lineLength(f.pts)); }
    const fSizes = [...fComp.values()].sort((a, b) => b - a);
    const footKm = fSizes.reduce((s, v) => s + v, 0) / 1000;
    // Steepest at-grade street grades on the heightfield.
    const grades = [];
    for (const r of ag) {
      const cum = cumLength(r.pts);
      let worst = 0;
      for (let s = 0; s + 20 <= cum[cum.length - 1]; s += 10) {
        const a = pointAt(r.pts, cum, s), c = pointAt(r.pts, cum, s + 20);
        worst = Math.max(worst, Math.abs(heights.fn(c.x, c.y) - heights.fn(a.x, a.y)) / 20);
      }
      grades.push({ road: r.specName, grade: Math.round(worst * 1000) / 10 });
    }
    grades.sort((a, b) => b.grade - a.grade);
    const mis = heights.misfit.map((m) => Math.abs(m.got - m.want));
    return {
      roadComponents: compList.length, components: compList, nodes: gNodes.size, degrees, intersections: junctionNodes.length,
      deadEnds: deadEnds.length, deadEndsOnCropEdge: deadEnds.filter((n) => onCropEdge(n.p)).length,
      deadEndList: deadEnds.filter((n) => !onCropEdge(n.p)).map((n) => ({ at: latlon(...n.p), roads: [...n.roads].map((r) => r.specName) })),
      strongComponents: scc.length, sccSizes: sccSizes.slice(0, 5), nodesOutsideLargestScc: outsideLargest,
      roundabouts: rings, unnodedCrossings: crossings, roadsInWater,
      buildingsOverlappingCarriageway: overlapCarriageway, buildingsInSidewalkBuffer: inSidewalkBuffer, buildingOverlaps: bldOverlaps, buildingsInWaterOrPark: inWaterOrPark, buildingsInParkOrPlazaHoles: inParkHole,
      footwayComponents: fSizes.length, largestFootwayComponentKm: r1(fSizes[0] / 1000), footwayKm: r1(footKm),
      heightMisfitRms: r1(Math.sqrt(mis.reduce((s, v) => s + v * v, 0) / Math.max(1, mis.length))), heightMisfitMax: r1(Math.max(0, ...mis)),
      heightRange: [Math.min(...heights.data), Math.max(...heights.data)], steepest: grades.slice(0, 6),
      landmarks: landmarkReport, frontageTries, warnings,
    };
  }

  // ----------------------------------------------------------------------------------- output
  const outPts = (pts) => {
    const o = [];
    for (const p of pts) {
      const q = [r1(p[0]), r1(-p[1])];
      const l = o[o.length - 1];
      if (!l || l[0] !== q[0] || l[1] !== q[1]) o.push(q);
    }
    return o;
  };
  const outRing = (ring) => {
    const o = outPts(ring);
    while (o.length > 1 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]) o.pop();
    return o;
  };
  const withHoles = (ring, holes) => {
    const e = { pts: outRing(ccw(ring)) };
    const hs = (holes ?? []).map((h) => outRing(ccw(h).slice().reverse())).filter((h) => h.length >= 3);
    if (hs.length) e.holes = hs;
    return e;
  };
  const roadsOut = roads.map((r) => {
    const o = { id: r.id, name: r.name, highway: r.highway, lanes: r.lanes, oneway: r.oneway, bridge: r.bridge, tunnel: r.tunnel, layer: r.layer, junction: r.junction, maxspeed: r.maxspeed, pts: outPts(r.pts) };
    o.sidewalk = r.sw ? 'separate' : 'no';
    if (r.surface) o.surface = r.surface;
    return o;
  });
  const footOut = [];
  for (const f of foot) {
    for (const pc of clipPolyline(f.pts, rect)) {
      const pts = outPts(pc);
      if (pts.length < 2) continue;
      const o = { id: f.id, kind: f.kind, name: f.name ?? null, pts };
      if (f.bridge) o.bridge = 1;
      if (f.layer) o.layer = f.layer;
      if (f.surface) o.surface = f.surface;
      if (f.towpath) o.towpath = 1;
      if (f.pier) o.pier = 1;
      footOut.push(o);
    }
  }
  for (const p of plazas) footOut.push({ id: p.id, kind: 'pedestrian', area: 1, name: null, ...withHoles(p.ring, p.holes) });
  const bridgesOut = [
    ...roads.filter((r) => r.bridge).map((r) => ({ id: r.id, src: 'road', name: r.bridgeName ?? r.name, layer: r.layer, pts: outPts(r.pts) })),
    ...foot.filter((f) => f.bridge && f.group !== 'sidewalk' && f.group !== 'crossing').map((f) => ({ id: f.id, src: 'path', name: f.name ?? null, layer: f.layer || 1, pts: outPts(f.pts) })),
  ];
  const doc = {
    meta: {
      format: FORMAT,
      synthetic: true,
      source: opts.specPath,
      sourceNote: spec.source ?? null,
      osmBase: null,
      bbox: crop,
      crop: { ...crop, widthM: r1(rect.x1 - rect.x0), heightM: r1(rect.y1 - rect.y0) },
      origin: { lat: proj.lat0, lon: proj.lon0 },
      metresPerDegree: { lat: r1(proj.mLat), lon: r1(proj.mLon) },
      frame: 'equirectangular around origin; x east, z south, y up; metres rounded to 0.1',
      bounds: { x0: r1(rect.x0), z0: r1(-rect.y1), x1: r1(rect.x1), z1: r1(-rect.y0) },
      winding: 'outer rings counter-clockwise on a north-up map (negative shoelace area in raw x,z), holes the other way; rings do not repeat the first point',
      units: { maxspeed: 'km/h', h: 'm', heights: 'm above the Potomac (river level 0)' },
      notes: 'Synthetic: generated by scripts/georgetownFromSpec.mjs from a hand-authored spec (general knowledge, not OpenStreetMap, 20-80 m error). ids are s<n>, unique across all lists. Streets, water, parks and landmark positions come from the spec; every building is synthesized (synth: true); POIs carry categories only (name them from src/data/poiNames.ts). Road and footway vertices shared by several ways are identical, so graphs can be built by matching coordinates. Streets that cross the canal are split into a short bridge piece. heights: grid of terrain heights, data[iz * nx + ix] at (x0 + ix * spacing, z0 + iz * spacing).',
      simplify: null,
      attribution: ATTRIBUTION,
      generator: { script: 'scripts/georgetownFromSpec.mjs', seed: opts.seed },
      generatedAt: new Date().toISOString(),
      counts: null,
    },
    roads: roadsOut,
    footways: footOut,
    buildings: blds.map((b) => ({ id: b.id, h: b.h, type: b.type, levels: b.levels, synth: true, pts: outRing(b.ring) })),
    pois: pois.map((p) => ({ id: p.id, x: r1(p.x), z: r1(-p.y), cat: p.cat, ...(p.subcat ? { subcat: p.subcat } : {}), ...(p.b ? { b: p.b } : {}) })),
    water: water.map((w) => ({ id: w.id, kind: w.kind, name: w.name, pts: outRing(w.ring) })),
    waterways: waterways.map((w) => ({ id: w.id, kind: w.kind, name: w.name, pts: outPts(w.pts) })),
    parks: parks.map((p) => ({ id: p.id, kind: p.kind, name: p.name ?? null, ...withHoles(p.ring, p.holes) })),
    parking: parking.map((p) => ({ id: p.id, type: p.type, capacity: p.capacity, ...(p.access ? { access: p.access } : {}), pts: outRing(p.ring) })),
    bridges: bridgesOut,
    landmarks: {
      canal: { waterways: waterways.filter((w) => w.kind === 'canal').map((w) => w.id), water: water.filter((w) => w.kind === 'canal').map((w) => w.id) },
      towpath: towpath ? [towpath.id] : [],
    },
    props,
    heights: { spacing: heights.spacing, x0: heights.x0, z0: heights.z0, nx: heights.nx, nz: heights.nz, data: heights.data },
  };
  const counts = {};
  for (const k of ['roads', 'footways', 'buildings', 'pois', 'water', 'waterways', 'parks', 'parking', 'bridges', 'props']) counts[k] = doc[k].length;
  doc.meta.counts = counts;
  return { doc, report, stats: { roadKm: lineLength0(roads), footKm: report.footwayKm } };

  function lineLength0(list) {
    return list.reduce((s, r) => s + lineLength(r.pts), 0) / 1000;
  }
}

/** Gaussian elimination with partial pivoting (A is overwritten). */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const piv = A[c][c];
    if (Math.abs(piv) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv;
      if (!f) continue;
      const Ar = A[r], Ac = A[c];
      for (let k = c; k < n; k++) Ar[k] -= f * Ac[k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = Math.abs(A[r][r]) < 1e-14 ? 0 : s / A[r][r];
  }
  return x;
}

/** Strongly connected components (iterative Tarjan). adj: array of neighbour index arrays. */
function tarjan(adj) {
  const n = adj.length;
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
  const stack = [], out = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    const work = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i < adj[v].length) {
        top[1]++;
        const w = adj[v][i];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === index[v]) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack[w] = 0; comp.push(w); } while (w !== v);
          out.push(comp);
        }
      }
    }
  }
  return out;
}

// ================================================================================================= output
/** Compact JSON with one feature per line (as importOsm.mjs), so git diffs of the data file stay readable. */
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

function printReport(args, res, bytes, ms) {
  const { doc, report: v, stats } = res;
  const c = doc.meta.counts;
  const L = [];
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  const at = (ll) => (ll ? `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}` : '?');
  const m = doc.meta;
  L.push(`Georgetown from spec: ${args.spec} -> ${args.out}  (seed ${args.seed}, ${(ms / 1000).toFixed(1)} s)`);
  L.push(`  crop ${m.crop.minlon},${m.crop.minlat} .. ${m.crop.maxlon},${m.crop.maxlat} = ${m.crop.widthM} m x ${m.crop.heightM} m, origin ${m.origin.lat.toFixed(5)}, ${m.origin.lon.toFixed(5)}; bounds x ${m.bounds.x0}..${m.bounds.x1}, z ${m.bounds.z0}..${m.bounds.z1}`);
  L.push('');
  L.push('  feature      count');
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  L.push(`  ${pad('roads', 10)} ${lpad(c.roads, 6)}   ${stats.roadKm.toFixed(1)} km`);
  const fk = {};
  for (const f of doc.footways) fk[f.kind] = (fk[f.kind] ?? 0) + 1;
  L.push(`  ${pad('footways', 10)} ${lpad(c.footways, 6)}   ${stats.footKm} km; ${Object.entries(fk).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const bt = {};
  for (const b of doc.buildings) bt[b.type] = (bt[b.type] ?? 0) + 1;
  L.push(`  ${pad('buildings', 10)} ${lpad(c.buildings, 6)}   ${Object.entries(bt).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const cats = new Map();
  for (const p of doc.pois) cats.set(p.cat, (cats.get(p.cat) ?? 0) + 1);
  L.push(`  ${pad('pois', 10)} ${lpad(c.pois, 6)}   ${cats.size} categories`);
  const catList = [...cats].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
  for (let i = 0; i < catList.length; i += 6) L.push(`               ${catList.slice(i, i + 6).join(', ')}`);
  for (const k of ['water', 'waterways', 'parks', 'parking', 'bridges', 'props']) L.push(`  ${pad(k, 10)} ${lpad(c[k], 6)}`);
  const pk = {};
  for (const p of doc.props) pk[p[2]] = (pk[p[2]] ?? 0) + 1;
  L.push(`               props: ${Object.entries(pk).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  L.push(`  heights    ${doc.heights.nx} x ${doc.heights.nz} at ${doc.heights.spacing} m, ${v.heightRange[0]}..${v.heightRange[1]} m; spot-height misfit rms ${v.heightMisfitRms} m, max ${v.heightMisfitMax} m`);
  L.push('');
  L.push(`  output ${mb(bytes)} (target < ${mb(SIZE_TARGET)})${bytes > SIZE_TARGET ? '  WARNING: over target' : ''}`);
  L.push('');
  L.push('Validation:');
  L.push(`  road graph: ${v.nodes} nodes, ${v.roadComponents} connected component(s)${v.roadComponents > 1 ? '  WARNING' : ''}; ${v.intersections} intersections (3+ ways), ${v.deadEnds} dead ends (${v.deadEndsOnCropEdge} on the crop edge)`);
  if (v.roadComponents > 1) for (const comp of v.components.slice(1)) L.push(`    separate: ${comp.join(', ')}`);
  for (const d of v.deadEndList) L.push(`    dead end inside the map: ${d.roads.join(' / ')} at ${at(d.at)}`);
  L.push(`  one-way check: ${v.strongComponents} strongly connected component(s); ${v.nodesOutsideLargestScc.length} node(s) not reachable both ways${v.nodesOutsideLargestScc.length ? ` (${v.nodesOutsideLargestScc.slice(0, 4).map((n) => `${n.roads[0]} at ${at(n.at)}`).join('; ')})` : ''}`);
  for (const r of v.roundabouts) L.push(`  roundabout ${r.name}: ${r.closed ? 'closed loop' : 'NOT CLOSED'}, ${r.vertices} vertices, oneway ${r.oneway}, ${r.spokes} spokes`);
  L.push(`  at-grade roads crossing without a junction: ${v.unnodedCrossings.length}${v.unnodedCrossings.length ? `  (${v.unnodedCrossings.slice(0, 4).map((x) => `${x.a} x ${x.b} at ${at(x.at)}`).join('; ')})` : ''}`);
  L.push(`  at-grade roads over water: ${v.roadsInWater.length}${v.roadsInWater.length ? `  (${v.roadsInWater.map((x) => `${x.road} at ${at(x.at)}`).join('; ')})` : ''}`);
  L.push(`  buildings overlapping a carriageway (lanes x ${LANE_WIDTH} m): ${v.buildingsOverlappingCarriageway.length}; inside sidewalk + ${BUILDING_SETBACK} m setback: ${v.buildingsInSidewalkBuffer.length}; overlapping each other: ${v.buildingOverlaps}; in water or parks: ${v.buildingsInWaterOrPark.length} (landmarks standing in a hole cut in a park or plaza on purpose: ${v.buildingsInParkOrPlazaHoles.join(', ') || 'none'})`);
  for (const b of v.buildingsInSidewalkBuffer.slice(0, 5)) L.push(`    ${b.building} reaches ${b.depth} m into ${b.road} at ${at(b.at)}`);
  L.push(`  footways: ${v.footwayComponents} connected group(s), largest ${v.largestFootwayComponentKm} of ${v.footwayKm} km`);
  L.push(`  steepest streets on the heightfield: ${v.steepest.map((g) => `${g.road} ${g.grade}%`).join(', ')}`);
  const lmBad = v.landmarks.filter((l) => !l.placed || l.moved > 0 || l.scale < 1);
  L.push(`  landmarks: ${v.landmarks.filter((l) => l.placed).length}/${v.landmarks.length} placed${lmBad.length ? `; adjusted: ${lmBad.map((l) => (l.placed ? `${l.key} moved ${l.moved} m${l.scale < 1 ? ` scaled ${l.scale}` : ''}` : `${l.key} NOT PLACED`)).join(', ')}` : ''}`);
  if (v.warnings.length) {
    L.push('');
    L.push('Warnings:');
    for (const w of v.warnings) L.push(`  ${w}`);
  }
  console.log(L.join('\n'));
}

// Run last, so every top-level constant above is initialised.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(`georgetownFromSpec: ${e?.stack ?? e}`);
    process.exit(1);
  }
}
