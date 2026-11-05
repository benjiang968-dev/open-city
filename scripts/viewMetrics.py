# Image metrics for the views of scripts/viewShots.mjs (docs/visual-audit.md uses them as acceptance numbers).
#
#   python3 -I scripts/viewMetrics.py stats <png> [<png> ...]
#   python3 -I scripts/viewMetrics.py compare <dir> <prefixA> <prefixB> [view ...]
#
# stats: tone statistics of the whole frame from the sRGB pixels: mean and standard deviation of the luminance (0..1),
#   % of pixels with a channel over 250 (clipped), % under 10/255 (crushed), 5th / 50th / 95th percentile, mean
#   saturation ((max-min)/max). For road-far shots (file name contains "road-far") also the "grain" of three road
#   regions: the standard deviation of the luminance minus its 2 px Gaussian blur, x1000 (near 3-8 m, mid 10-20 m,
#   far 60-150 m from the camera). Shots that are not 1280x720 are resized to it first (bilinear, as the browser
#   scales a canvas drawn at a lower resolution), so the regions and the grain stay comparable.
# compare: per view, the stats of <prefixA>-<view>.png and <prefixB>-<view>.png in <dir>, the mean absolute difference
#   (0..255) and the share of pixels that differ by more than 24 levels in any channel.
# Needs numpy and Pillow. Reads PNG files only (run with -I).
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter

W, H = 1280, 720
REGIONS = {'road-far': {'near': (560, 600, 860, 715), 'mid': (600, 430, 800, 480), 'far': (600, 372, 700, 390)}}
VIEWS = ['rep', 'street2', 'street3', 'door', 'people', 'car', 'tree', 'road-far', 'aerial', 'spawn']


def load(path):
    im = Image.open(path).convert('RGB')
    if im.size != (W, H):
        im = im.resize((W, H), Image.BILINEAR)
    return im


def lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def stats(path):
    im = load(path)
    a = np.asarray(im).astype(np.float32) / 255.0
    L = lum(a)
    mx, mn = a.max(axis=2), a.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    out = {
        'meanL': round(float(L.mean()), 3), 'sdL': round(float(L.std()), 3),
        'clipPct': round(float((mx > 250 / 255).mean()) * 100, 2), 'crushedPct': round(float((L < 10 / 255).mean()) * 100, 2),
        'p5': round(float(np.percentile(L, 5)), 3), 'p50': round(float(np.percentile(L, 50)), 3), 'p95': round(float(np.percentile(L, 95)), 3),
        'meanSat': round(float(sat.mean()), 3),
    }
    name = os.path.basename(path)
    for key, regs in REGIONS.items():
        if key in name:
            blur = np.asarray(im.filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255.0
            hp = L - lum(blur)
            for rn, (x0, y0, x1, y1) in regs.items():
                out[f'grain_{rn}'] = round(float(hp[y0:y1, x0:x1].std()) * 1000, 1)
                out[f'meanL_{rn}'] = round(float(L[y0:y1, x0:x1].mean()), 3)
    return out


def compare(d, pa, pb, views):
    for v in views:
        fa, fb = os.path.join(d, f'{pa}-{v}.png'), os.path.join(d, f'{pb}-{v}.png')
        if not (os.path.exists(fa) and os.path.exists(fb)):
            print(v.ljust(9), 'missing')
            continue
        a = np.asarray(load(fa)).astype(np.float32)
        b = np.asarray(load(fb)).astype(np.float32)
        diff = np.abs(a - b).max(axis=2)
        sa, sb = stats(fa), stats(fb)
        short = lambda s: {k: s[k] for k in ('meanL', 'sdL', 'clipPct', 'meanSat')}
        print(v.ljust(9), pa, json.dumps(short(sa)), '|', pb, json.dumps(short(sb)),
              f'| mean|diff| {np.abs(a - b).mean():.2f}, >24: {(diff > 24).mean() * 100:.1f}%')


if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] not in ('stats', 'compare'):
        print(__doc__ if __doc__ else 'usage: viewMetrics.py stats <png...> | compare <dir> <prefixA> <prefixB> [view...]')
        sys.exit(2)
    if sys.argv[1] == 'stats':
        for p in sys.argv[2:]:
            print(os.path.basename(p).ljust(36), json.dumps(stats(p)))
    else:
        compare(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:] or VIEWS)
