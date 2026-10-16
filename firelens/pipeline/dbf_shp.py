"""Minimal pure-python readers for ESRI Shapefile (.shp) and dBASE (.dbf).

FIRMS distributes active-fire hot spots as zipped shapefiles.  Reading them
without GDAL keeps the harmonisation pipeline dependency-light.
"""
from __future__ import annotations
import struct, datetime
from pathlib import Path

# --------------------------------------------------------------------------- DBF
_FTYPES = {b'C': str, b'N': float, b'F': float, b'L': bool, b'D': str, b'M': str}

def read_dbf(path):
    """Yield dicts, one per dBASE record."""
    path = Path(path)
    with path.open('rb') as fh:
        hdr = fh.read(32)
        nrec, hlen, rlen = struct.unpack('<IHH', hdr[4:12])
        fields = []
        while True:
            fd = fh.read(32)
            if fd[0:1] in (b'\r', b''):
                break
            name = fd[:11].split(b'\x00')[0].decode('latin-1')
            ftype = fd[11:12].decode('latin-1')
            flen = fd[16]
            fdec = fd[17]
            fields.append((name, ftype, flen, fdec))
        fh.seek(hlen)
        for _ in range(nrec):
            rec = fh.read(rlen)
            if not rec or rec[:1] == b'*':
                continue
            off, out = 1, {}
            for name, ftype, flen, fdec in fields:
                raw = rec[off:off + flen]
                off += flen
                s = raw.decode('latin-1').strip()
                if ftype in ('N', 'F'):
                    try:
                        out[name] = int(s) if fdec == 0 and s.lstrip('-').isdigit() else float(s)
                    except ValueError:
                        out[name] = None
                elif ftype == 'D' and len(s) == 8:
                    try:
                        out[name] = datetime.date(int(s[:4]), int(s[4:6]), int(s[6:])).isoformat()
                    except ValueError:
                        out[name] = None
                elif ftype == 'L':
                    out[name] = s.upper() in ('T', 'Y', '1')
                else:
                    out[name] = s
            yield out

# --------------------------------------------------------------------------- SHP
def read_shp_points(path):
    """Return list of (x, y) for Point / PointZ / PointM shapefiles."""
    path = Path(path)
    pts = []
    with path.open('rb') as fh:
        data = fh.read()
    shape_type = struct.unpack('<i', data[32:36])[0]
    if shape_type not in (1, 11, 21):
        raise ValueError(f'expected point shapefile, got shape type {shape_type}')
    pos = 100
    n = len(data)
    while pos + 8 <= n:
        clen = struct.unpack('>i', data[pos + 4:pos + 8])[0] * 2
        body = data[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        if len(body) < 4:
            continue
        st = struct.unpack('<i', body[:4])[0]
        if st == 0:
            continue
        x, y = struct.unpack('<dd', body[4:20])
        pts.append((x, y))
    return pts

def read_layer(folder, stem):
    """Join a shapefile's geometry with its attributes."""
    folder, stem = Path(folder), stem
    pts = read_shp_points(folder / f'{stem}.shp')
    recs = list(read_dbf(folder / f'{stem}.dbf'))
    if len(pts) != len(recs):
        raise ValueError(f'{stem}: {len(pts)} geometries vs {len(recs)} attributes')
    for (x, y), r in zip(pts, recs):
        r['lon'], r['lat'] = x, y
        yield r
