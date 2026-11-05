#!/usr/bin/env python3
"""Download the Georgetown slice of Overture Maps (and the terrain tiles) into data/overture/.

    python3 -I scripts/fetchOverture.py [--force] [--only segment,building,...] [--skip-terrain]

Needs pyarrow and shapely (PyPI). A virtual environment anywhere works, for example:

    python3 -m venv ~/.venv-overture && ~/.venv-overture/bin/pip install pyarrow shapely
    ~/.venv-overture/bin/python -I scripts/fetchOverture.py

(`npm run import-overture` runs this with $OVERTURE_PYTHON, default python3, when the cache is missing.)

What it does:
  * Overture Maps release RELEASE on the public bucket s3://overturemaps-us-west-2 (anonymous; HTTPS through the
    environment's HTTPS_PROXY if set). Every GeoParquet file has a bbox struct column with row-group statistics, so
    pyarrow reads only the row groups that intersect DOWNLOAD_BOX (plus every file's footer).
  * Writes, per Overture type, the matching rows as a raw parquet subset (data/overture/<type>.parquet) and a JSON
    lines file the Node importer reads (data/overture/<type>.jsonl: one feature per line with GeoJSON geometry).
    Names are dropped from places and buildings here already: the game never stores business names.
  * Downloads the AWS Terrain Tiles (terrarium PNG, z TERRAIN_ZOOM) covering DOWNLOAD_BOX into
    data/overture/terrain/<z>/<x>/<y>.png.

Everything under data/overture/ is a cache (gitignored). Downloads are data only: nothing from them is executed.
"""
import argparse
import json
import math
import os
import ssl
import sys
import time
import urllib.request

RELEASE = '2026-10-21.0'
BUCKET = 'overturemaps-us-west-2'
# Download box (lon/lat, WGS84): the game crop (see scripts/importOverture.mjs CROP) plus a margin, so ways and
# areas that cross the crop edge arrive complete.
DOWNLOAD_BOX = {'minlon': -77.0790, 'minlat': 38.8945, 'maxlon': -77.0440, 'maxlat': 38.9195}
TERRAIN_ZOOM = 15  # terrarium tiles: z15 is about 3.7 m per pixel here, about the source DEM resolution
TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

# Overture type -> (theme, columns to keep, drop names?)
TYPES = {
    'segment': ('transportation', ['id', 'names', 'subtype', 'class', 'subclass', 'subclass_rules', 'connectors', 'road_surface', 'road_flags',
                                   'width_rules', 'level_rules', 'access_restrictions', 'speed_limits', 'routes', 'sources', 'geometry', 'bbox'], False),
    'connector': ('transportation', ['id', 'geometry', 'bbox'], False),
    'building': ('buildings', ['id', 'subtype', 'class', 'height', 'min_height', 'num_floors', 'min_floor', 'level', 'is_underground', 'has_parts',
                               'roof_shape', 'roof_height', 'facade_material', 'roof_material', 'sources', 'geometry', 'bbox'], True),
    'building_part': ('buildings', ['id', 'building_id', 'height', 'min_height', 'num_floors', 'min_floor', 'level', 'geometry', 'bbox'], True),
    'place': ('places', ['id', 'categories', 'basic_category', 'taxonomy', 'confidence', 'operating_status', 'geometry', 'bbox'], True),
    'water': ('base', ['id', 'names', 'subtype', 'class', 'level', 'is_intermittent', 'source_tags', 'sources', 'geometry', 'bbox'], False),
    'land_use': ('base', ['id', 'names', 'subtype', 'class', 'level', 'surface', 'source_tags', 'sources', 'geometry', 'bbox'], False),
    'infrastructure': ('base', ['id', 'names', 'subtype', 'class', 'level', 'height', 'surface', 'source_tags', 'sources', 'geometry', 'bbox'], False),
    'land': ('base', ['id', 'names', 'subtype', 'class', 'level', 'surface', 'elevation', 'source_tags', 'sources', 'geometry', 'bbox'], False),
}
# Raw OSM tag keys kept from source_tags (everything else is dropped from the JSON lines file).
KEEP_TAGS = {'capacity', 'parking', 'access', 'lock', 'lock_name', 'waterway', 'water', 'natural', 'leisure', 'landuse', 'amenity', 'man_made',
             'bridge', 'tunnel', 'layer', 'location', 'height', 'surface', 'barrier', 'highway', 'building', 'covered', 'level', 'ele',
             'denotation', 'leaf_type', 'genus', 'species:wikidata', 'circumference', 'diameter_crown', 'material', 'support', 'operator:type',
             'tidal', 'intermittent', 'width', 'tourism', 'historic', 'memorial', 'place', 'area', 'boundary', 'protect_class', 'protected'}


def out_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), 'data', 'overture')


def jsonable(v):
    """pyarrow to_pylist() values -> JSON: maps arrive as lists of (key, value) tuples."""
    if isinstance(v, list):
        if v and all(isinstance(e, tuple) and len(e) == 2 for e in v):
            return {k: jsonable(x) for k, x in v}
        return [jsonable(e) for e in v]
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items() if x is not None}
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def fetch_type(fs, name, force):
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq
    import shapely
    theme, cols, drop_names = TYPES[name]
    d = out_dir()
    pq_path = os.path.join(d, f'{name}.parquet')
    jl_path = os.path.join(d, f'{name}.jsonl')
    if not force and os.path.exists(pq_path) and os.path.exists(jl_path):
        print(f'  {name}: cached ({os.path.getsize(jl_path) / 1e6:.1f} MB jsonl)')
        return
    t0 = time.time()
    path = f'{BUCKET}/release/{RELEASE}/theme={theme}/type={name}/'
    dset = ds.dataset(path, filesystem=fs, format='parquet')
    names = set(dset.schema.names)
    cols = [c for c in cols if c in names]
    b = DOWNLOAD_BOX
    f = ds.field
    filt = (f('bbox', 'xmin') <= b['maxlon']) & (f('bbox', 'xmax') >= b['minlon']) & (f('bbox', 'ymin') <= b['maxlat']) & (f('bbox', 'ymax') >= b['minlat'])
    table = dset.to_table(columns=cols, filter=filt, batch_readahead=4, fragment_readahead=8)
    pq.write_table(table, pq_path, compression='zstd')
    rows = table.to_pylist()
    with open(jl_path, 'w', encoding='utf-8') as fh:
        for r in rows:
            g = r.pop('geometry')
            geom = shapely.geometry.mapping(shapely.from_wkb(g)) if g else None
            props = {}
            for k, v in r.items():
                if v is None or k == 'bbox':
                    continue
                if drop_names and k in ('names', 'brand'):
                    continue
                if k == 'names':
                    v = {'primary': v.get('primary')} if isinstance(v, dict) else None
                    if not v or not v['primary']:
                        continue
                if k == 'source_tags':
                    v = {kk: vv for kk, vv in jsonable(v).items() if kk in KEEP_TAGS}
                    if not v:
                        continue
                if k == 'sources':
                    # keep only what attribution and the report need: dataset, record id, licence
                    v = [{'dataset': s.get('dataset'), 'record_id': s.get('record_id'), 'license': s.get('license')} for s in v if s]
                props[k] = jsonable(v)
            fh.write(json.dumps({'type': 'Feature', 'geometry': jsonable_geom(geom), 'properties': props}, separators=(',', ':')) + '\n')
    print(f'  {name}: {len(rows)} rows in {time.time() - t0:.0f} s -> {os.path.getsize(jl_path) / 1e6:.1f} MB jsonl')


def jsonable_geom(g):
    if g is None:
        return None
    def fix(c):
        if isinstance(c, (list, tuple)):
            if c and isinstance(c[0], (int, float)):
                return [round(float(c[0]), 7), round(float(c[1]), 7)]
            return [fix(e) for e in c]
        return c
    if g['type'] == 'GeometryCollection':
        return {'type': g['type'], 'geometries': [jsonable_geom(x) for x in g['geometries']]}
    return {'type': g['type'], 'coordinates': fix(g['coordinates'])}


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def fetch_terrain(force):
    b = DOWNLOAD_BOX
    z = TERRAIN_ZOOM
    x0, y0 = tile_xy(b['minlon'], b['maxlat'], z)
    x1, y1 = tile_xy(b['maxlon'], b['minlat'], z)
    ctx = ssl.create_default_context()
    ca = '/root/.ccr/ca-bundle.crt'
    if os.path.exists(ca):
        ctx.load_verify_locations(ca)
    n = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            p = os.path.join(out_dir(), 'terrain', str(z), str(x), f'{y}.png')
            if os.path.exists(p) and not force:
                continue
            os.makedirs(os.path.dirname(p), exist_ok=True)
            url = TERRAIN_URL.format(z=z, x=x, y=y)
            with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'open-city-importer/1.0'}), context=ctx, timeout=60) as r:
                data = r.read()
            if data[:8] != b'\x89PNG\r\n\x1a\n':
                raise RuntimeError(f'{url} did not return a PNG')
            with open(p, 'wb') as fh:
                fh.write(data)
            n += 1
    print(f'  terrain: z{z} x {x0}..{x1}, y {y0}..{y1} ({(x1 - x0 + 1) * (y1 - y0 + 1)} tiles, {n} downloaded)')
    with open(os.path.join(out_dir(), 'terrain', 'tiles.json'), 'w') as fh:
        json.dump({'z': z, 'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1, 'url': TERRAIN_URL, 'encoding': 'terrarium: (R * 256 + G + B / 256) - 32768 m'}, fh)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--force', action='store_true', help='download again even if cached')
    ap.add_argument('--only', default='', help='comma-separated Overture types (default: all)')
    ap.add_argument('--skip-terrain', action='store_true')
    a = ap.parse_args()
    os.makedirs(out_dir(), exist_ok=True)
    print(f'Overture {RELEASE}, box {DOWNLOAD_BOX}')
    only = [t for t in a.only.split(',') if t] or list(TYPES)
    try:
        import pyarrow.fs as pafs
    except ImportError:
        sys.exit('fetchOverture: needs pyarrow and shapely (pip install pyarrow shapely), see the top of this file')
    kw = {'anonymous': True, 'region': 'us-west-2'}
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if proxy:
        kw['proxy_options'] = proxy
    fs = pafs.S3FileSystem(**kw)
    for t in only:
        fetch_type(fs, t, a.force)
    if not a.skip_terrain:
        fetch_terrain(a.force)
    with open(os.path.join(out_dir(), 'release.json'), 'w') as fh:
        json.dump({'release': RELEASE, 'bucket': BUCKET, 'box': DOWNLOAD_BOX, 'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, fh)


if __name__ == '__main__':
    main()
