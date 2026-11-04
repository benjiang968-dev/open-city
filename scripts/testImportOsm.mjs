// Checks scripts/importOsm.mjs against the synthetic fixture scripts/fixtures/tiny.osm.
// Writes only to a temp folder (never src/data).   Usage: node scripts/testImportOsm.mjs [outDir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'open-city-osm-'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'tiny.json');
const reportPath = join(outDir, 'tiny-report.json');
const run = spawnSync(process.execPath, ['scripts/importOsm.mjs', 'scripts/fixtures/tiny.osm', '--out', out, '--report-json', reportPath], { encoding: 'utf8' });
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(1);
}
const text = readFileSync(out, 'utf8');
const doc = JSON.parse(text);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const fixture = readFileSync('scripts/fixtures/tiny.osm', 'utf8');
let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};
const node = (id) => {
  const m = fixture.match(new RegExp(`<node id="${id}" lat="([-\\d.]+)" lon="([-\\d.]+)"`));
  return { lat: Number(m[1]), lon: Number(m[2]) };
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const ringArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2; // in raw x,z; outer rings (CCW on a north-up map) come out negative
};
const inRing = (x, z, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
console.log(`importOsm fixture test -> ${out}`);

check('meta: attribution, crop and frame', () => {
  assert.equal(doc.meta.attribution, 'Map data © OpenStreetMap contributors, ODbL');
  assert.equal(doc.meta.crop.minlon, -77.072);
  near(doc.meta.crop.widthM, 1995, 5, 'crop width');
  near(doc.meta.crop.heightM, 1532, 5, 'crop height');
  assert.match(doc.meta.frame, /z south/);
});

check('business and building names are dropped, street/water/park names kept', () => {
  // Ponds and fountains can be named after a property, so only natural water bodies keep their names.
  for (const banned of ['Blue Heron', 'Coffee Roasters', 'Real Looking', 'Boutique', 'Fixture House', 'Fixture Lot', 'Fixture Pond', 'example.com', '1234', 'opening', 'brand']) {
    assert.ok(!text.includes(banned), `output contains "${banned}"`);
  }
  for (const kept of ['Fixture Street NW', 'Sample Avenue NW', 'Fixture River', 'Fixture Canal', 'Fixture Green']) {
    assert.ok(text.includes(kept), `output lacks "${kept}"`);
  }
  for (const p of doc.pois) assert.equal(p.name, undefined);
  for (const b of doc.buildings) assert.equal(b.name, undefined);
});

check('projection: x east, z south, distances match haversine within 0.5%', () => {
  const o = doc.meta.origin;
  const R = 6371008.8, rad = Math.PI / 180;
  const hav = (a, b) => {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const cafe = doc.pois.find((p) => p.cat === 'amenity=cafe');
  const n = node(30);
  assert.ok(n.lon < o.lon && cafe.x < 0, 'west of origin -> negative x');
  assert.ok(n.lat < o.lat && cafe.z > 0, 'south of origin -> positive z');
  const d = hav(o, n), dXZ = Math.hypot(cafe.x, cafe.z);
  near(dXZ / d, 1, 0.005, 'origin->cafe distance ratio');
  near(cafe.x, -900, 0.1, 'cafe x (fixture layout)');
  near(cafe.z, 585, 0.1, 'cafe z (fixture layout)');
  // east-west and north-south scales separately
  near(hav(node(2), node(3)), 100, 0.4, 'node 2->3 haversine (100 m east)');
  near(hav(node(5), node(3)), 80, 0.3, 'node 5->3 haversine (80 m south)');
});

check('roads: oneway parsed, clipped to the crop, junction kept', () => {
  const a = doc.roads.find((r) => r.name === 'Fixture Street NW');
  const b = doc.roads.find((r) => r.name === 'Sample Avenue NW');
  assert.equal(a.oneway, 1);
  assert.equal(b.oneway, -1);
  assert.equal(a.lanes, 1);
  assert.equal(a.maxspeed, 40, '25 mph -> 40 km/h');
  assert.equal(a.sidewalk, 'both');
  assert.equal(a.pts[0][0], doc.meta.bounds.x0, 'clipped at the west crop edge');
  const key = (p) => `${p[0]},${p[1]}`;
  const shared = a.pts.map(key).filter((k) => b.pts.map(key).includes(k));
  assert.deepEqual(shared, ['-850,600'], 'both roads keep the junction vertex');
  for (const k of ['id', 'name', 'highway', 'lanes', 'oneway', 'bridge', 'tunnel', 'layer', 'junction', 'maxspeed', 'pts']) assert.ok(k in a, `road has ${k}`);
});

check('buildings: levels -> height, height tag parsed, mostly-outside dropped, rings open and CCW', () => {
  const house = doc.buildings.find((b) => b.id === 'w110');
  assert.equal(house.levels, 3);
  assert.equal(house.h, 9.6);
  assert.equal(doc.buildings.find((b) => b.id === 'w111').h, 12);
  assert.ok(!doc.buildings.some((b) => b.id === 'w112'), 'w112 is 62% outside the crop');
  for (const b of doc.buildings) {
    assert.notDeepEqual(b.pts[0], b.pts[b.pts.length - 1], 'ring does not repeat its first point');
    assert.ok(ringArea(b.pts) < 0, 'outer ring CCW on a north-up map');
  }
});

check('POIs: category and subcategory kept, shop building becomes a POI linked to its building', () => {
  const cafe = doc.pois.find((p) => p.id === 'n30');
  assert.equal(cafe.cat, 'amenity=cafe');
  assert.equal(cafe.subcat, 'coffee_shop');
  const shop = doc.pois.find((p) => p.cat === 'shop=clothes');
  assert.equal(shop.b, 'w111');
  assert.ok(!doc.pois.some((p) => p.cat.includes('bench')), 'bench is a prop, not a POI');
});

check('water: multipolygon outer ring assembled from 3 unordered ways, island kept as a hole', () => {
  const pond = doc.water.find((w) => w.id === 'r201');
  assert.equal(pond.kind, 'pond');
  assert.equal(pond.pts.length, 8, 'octagon');
  assert.equal(pond.holes.length, 1);
  assert.equal(pond.holes[0].length, 4);
  near(-ringArea(pond.pts), 2 * Math.SQRT2 * 40 * 40, 5, 'octagon area');
  assert.ok(ringArea(pond.holes[0]) > 0, 'hole runs the other way');
});

check('water: relation cut by the download box is closed along the crop edge on the water side', () => {
  const river = doc.water.find((w) => w.id === 'r202');
  assert.ok(river, 'r202 present');
  const { x0, z1 } = doc.meta.bounds; // z1 = south edge
  assert.ok(inRing(x0 + 5, z1 - 5, river.pts), 'south-west crop corner is water');
  assert.ok(!inRing(-900, 650, river.pts), 'the street side (north of the shore) is land');
  assert.ok(report.issues.some((i) => i.id === 'r202' && i.kind.startsWith('cut-by-download-box')), 'reported for checking');
});

check('water: narrow canal cut by the download box closes as a thin strip, not the land around it', () => {
  const canal = doc.water.find((w) => w.id === 'r203');
  assert.ok(canal, 'r203 present');
  assert.equal(canal.kind, 'canal');
  assert.ok(inRing(-900, 500, canal.pts), 'canal centre is water');
  assert.ok(!inRing(-900, 490, canal.pts), 'towpath is land');
  assert.ok(!inRing(-900, 515, canal.pts), 'south bank is land');
  near(-ringArea(canal.pts), 12 * (-760 - doc.meta.bounds.x0), 20, 'canal strip area');
});

check('canal, towpath, bridge, park, parking, props', () => {
  assert.deepEqual(doc.landmarks.canal.waterways, ['w140']);
  assert.deepEqual(doc.landmarks.canal.water, ['r203']);
  assert.deepEqual(doc.landmarks.towpath, ['w141'], 'unnamed path 10 m from the canal is the towpath; the footbridge is not');
  assert.ok(doc.bridges.some((b) => b.id === 'w142' && b.layer === 1));
  assert.equal(doc.parks[0].name, 'Fixture Green');
  assert.equal(doc.parking[0].type, 'surface');
  const kinds = doc.props.map((p) => p[2]).sort();
  assert.deepEqual(kinds, ['bench', 'signals', 'tree']);
});

check('report: building on a road and street without sidewalks, with lat/lon', () => {
  const o = report.overlaps.find((r) => r.building === 'w111');
  assert.ok(o && o.road === 'w102' && o.depth >= 3, 'w111 sits on Sample Avenue');
  assert.ok(!report.overlaps.some((r) => r.building === 'w110'));
  const s = report.noSidewalk.find((r) => r.road === 'w102');
  assert.ok(s, 'Sample Avenue has no sidewalk tagging nearby');
  near(s.lat, 38.9015, 0.001, 'reported latitude');
  near(s.lon, -77.0703, 0.001, 'reported longitude');
  assert.ok(!report.noSidewalk.some((r) => r.road === 'w101'), 'Fixture Street is tagged sidewalk=both');
});

check('numbers rounded to 0.1 m', () => {
  const nums = text.match(/-?\d+\.\d+/g) ?? [];
  const coords = [...doc.roads, ...doc.buildings, ...doc.water].flatMap((f) => f.pts.flat());
  for (const v of coords) assert.equal(Math.round(v * 10) / 10, v);
  assert.ok(nums.length > 0);
});

// src/data/poiNames.ts: Node 22.18+ strips the types itself; older Node skips this check.
let names = null;
try {
  names = await import('../src/data/poiNames.ts');
} catch (e) {
  console.log(`  skip poiNames.ts check (this Node cannot import .ts: ${e.code ?? e.message})`);
}
if (names) {
  check('poiNames.ts: 30+ categories with 4+ unique invented names, fallback per key, stable picks', () => {
    const cats = Object.entries(names.POI_NAMES);
    assert.ok(cats.length >= 30, `${cats.length} categories`);
    for (const [cat, list] of cats) {
      assert.match(cat, /^[a-z_]+=[a-z_]+$/, `category ${cat}`);
      assert.ok(list.length >= 4, `${cat} has ${list.length} names`);
    }
    const all = cats.flatMap(([, v]) => v);
    assert.equal(new Set(all).size, all.length, 'no name used twice');
    for (const k of ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare', 'historic']) assert.ok(names.POI_FALLBACK[k]?.length >= 4, `fallback for ${k}`);
    for (const p of doc.pois) assert.ok(names.POI_NAMES[p.cat].includes(names.poiName(p.cat, p.id)), `${p.cat} named from its list`);
    assert.equal(names.poiName('amenity=cafe', 'n30'), names.poiName('amenity=cafe', 'n30'));
    assert.ok(names.POI_FALLBACK.shop.includes(names.poiName('shop=no_such_value', 'n1')));
  });
}

console.log(`${checks} checks passed`);
