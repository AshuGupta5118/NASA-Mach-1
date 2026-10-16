#!/usr/bin/env python3
"""Download a real NASA FIRMS global 24 h active-fire snapshot.

    python3 pipeline/fetch_firms.py

Pulls the public (key-free) shapefile archives:
    MODIS C6.1 (Terra + Aqua)  and  Suomi NPP VIIRS C2
from https://firms.modaps.eosdis.nasa.gov/data/active_fire/ and unpacks them into
data/real24h/.  These files are what ``calibrate_real.py`` fits the sensor model
to, and what the application's Harmonisation lab runs co-registration on.

For a multi-year archive of your own area, request CSVs from the FIRMS download
page (free API key) and drop them into FireLens' Data > Import view instead --
that path runs the identical harmonisation on real data.
"""
from __future__ import annotations

import os
import sys
import zipfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'data', 'real24h')
BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/'

TARGETS = [
    ('modis_terra_24h', BASE + 'terra-modis/shapes/zips/MODIS_C6_1_Global_24h.zip',
     'MODIS_C6_1_Global_24h'),
    ('modis_aqua_24h', BASE + 'aqua-modis/shapes/zips/MODIS_C6_1_Global_24h.zip',
     'MODIS_C6_1_Global_24h'),
    ('viirs_snpp_24h', BASE + 'suomi-npp-viirs-c2/shapes/zips/SUOMI_VIIRS_C2_Global_24h.zip',
     'SUOMI_VIIRS_C2_Global_24h'),
]


def main():
    os.makedirs(DEST, exist_ok=True)
    for name, url, stem in TARGETS:
        folder = os.path.join(DEST, name)
        if os.path.isdir(folder) and os.path.exists(os.path.join(folder, stem + '.dbf')):
            print(f'skip    {name} (already present)')
            continue
        print(f'fetch   {url}')
        req = urllib.request.Request(url, headers={'User-Agent': 'FireLens/1.0 (SpaceApps)'})
        data = urllib.request.urlopen(req, timeout=120).read()
        tmp = os.path.join(DEST, name + '.zip')
        with open(tmp, 'wb') as fh:
            fh.write(data)
        os.makedirs(folder, exist_ok=True)
        with zipfile.ZipFile(tmp) as z:
            z.extractall(folder)
        os.remove(tmp)
        print(f'        {len(data)/1e6:.1f} MB -> {folder}')
    print('\ndone. next: python3 pipeline/calibrate_real.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
