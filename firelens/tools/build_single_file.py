#!/usr/bin/env python3
"""Bundle FireLens into ONE self-contained HTML file.

    python3 tools/build_single_file.py            # full, ~11 MB
    python3 tools/build_single_file.py --lite     # without the recent daily grid, ~6.5 MB

The result needs no server, no network and no packages: every script, the
stylesheet, the embedded country map and all gzipped data payloads travel inside
the file (base64 of the same gzip streams the served app fetches). The app's data
layer notices ``window.__FL_EMBEDDED__`` and decodes from there instead of calling
fetch, which is what makes a ``file://`` open possible at all.

Why keep the gzip layer inside base64? Because the payloads are 8 MB compressed;
embedding them uncompressed would be ~30 MB of JavaScript string.
"""
from __future__ import annotations

import argparse
import base64
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')

SCRIPTS = ['world.js', 'util.js', 'harmonize.js', 'data.js', 'analysis.js',
           'charts.js', 'map.js', 'import.js', 'app.js']

PAYLOADS = {
    'core': 'core.json.gz',
    'events': 'events.json.gz',
    'grid_monthly': 'grid_monthly.bin.gz',
    'grid_yearly': 'grid_yearly.bin.gz',
    'recent': 'grid_recent.bin.gz',
}


def b64(path):
    with open(path, 'rb') as fh:
        return base64.b64encode(fh.read()).decode('ascii')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lite', action='store_true',
                    help='omit the recent daily 0.25deg grid (map falls back to climatology)')
    ap.add_argument('--out', default=os.path.join(APP, 'firelens-standalone.html'))
    args = ap.parse_args()

    html = open(os.path.join(APP, 'index.html'), encoding='utf-8').read()
    css = open(os.path.join(APP, 'css', 'app.css'), encoding='utf-8').read()

    parts = []
    for name in SCRIPTS:
        src = open(os.path.join(APP, 'js', name), encoding='utf-8').read()
        if '</script' in src.lower():
            raise SystemExit(f'{name} contains a </script> sequence; cannot inline')
        parts.append(f'/* ===== js/{name} ===== */\n{src}')
    js = '\n'.join(parts)

    payloads = {k: b64(os.path.join(APP, 'data', v))
                for k, v in PAYLOADS.items() if not (args.lite and k == 'recent')}
    emb = 'window.__FL_EMBEDDED__ = {\n' + ',\n'.join(
        f'"{k}": "{v}"' for k, v in payloads.items()) + '\n};\n'

    # splice: replace the external <link> and <script src> tags
    html = re.sub(r'<link rel="stylesheet" href="css/app\.css">',
                  '<style>\n' + css + '\n</style>', html)
    script_tags = ''.join(f'<script src="js/{n}"></script>\n' for n in SCRIPTS)
    if script_tags.strip() not in html:
        # tolerate whitespace differences
        html = re.sub(r'(<script src="js/world\.js"></script>.*?<script src="js/app\.js"></script>)',
                      '@@SCRIPTS@@', html, flags=re.S)
    else:
        html = html.replace(script_tags.strip(), '@@SCRIPTS@@')
    if '@@SCRIPTS@@' not in html:
        raise SystemExit('could not locate the script block in index.html')
    html = html.replace('@@SCRIPTS@@',
                        '<script>\n' + emb + '\n</script>\n<script>\n' + js + '\n</script>')

    # note in the page that this is the offline bundle
    html = html.replace('<div class="sub">Harmonised MODIS &amp; VIIRS burning-activity calendar</div>',
                        '<div class="sub">Harmonised MODIS &amp; VIIRS burning-activity calendar</div>')

    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write(html)
    size = os.path.getsize(args.out)
    print(f'wrote {args.out}  ({size/1e6:.1f} MB)')
    print('  embedded payloads: ' + ', '.join(
        f'{k} ({os.path.getsize(os.path.join(APP, "data", PAYLOADS[k]))/1e6:.2f} MB gz)'
        for k in payloads))
    print('  open it directly in a browser (file:// is fine — no fetch is needed)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
