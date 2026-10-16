"""Rasterise the Natural Earth 110 m land polygons into a 0.25 deg land mask.

The mask keeps simulated (and imported) fire data off the ocean and is cached to
``data/land_mask.json`` so it only has to be computed once.
"""
from __future__ import annotations

import json, os, sys, base64
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELL = 0.25
LAT_MIN, LAT_MAX = -60.0, 85.0
LON_MIN, LON_MAX = -180.0, 180.0
NLAT = int(round((LAT_MAX - LAT_MIN) / CELL))
NLON = int(round((LON_MAX - LON_MIN) / CELL))


def _decode_arcs(topo, arcs_needed=None):
    tr = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        a = np.asarray(arc, dtype=float)
        if tr:
            sx, sy = tr["scale"]
            tx, ty = tr["translate"]
            out = np.cumsum(a, axis=0)          # deltas are relative to the previous point
            out[:, 0] = out[:, 0] * sx + tx
            out[:, 1] = out[:, 1] * sy + ty
        else:
            out = a
        arcs.append(out)
    return arcs


def _rings_for_object(topo, arcs):
    """Yield closed rings (Nx2 lon/lat arrays) for every geometry in the object."""
    obj = list(topo["objects"].values())[0]
    for geom in obj["geometries"]:
        t = geom["type"]
        if t == "Polygon":
            ring_lists = geom["arcs"]                 # [ring, ring, ...]
        elif t == "MultiPolygon":
            ring_lists = [r for poly in geom["arcs"] for r in poly]
        else:
            continue
        for ring_refs in ring_lists:
            pts = []
            for ref in ring_refs:
                idx = ~ref if ref < 0 else ref
                a = arcs[idx]
                pts.append(a if ref >= 0 else a[::-1])
            if not pts:
                continue
            ring = np.concatenate(pts, axis=0)
            if len(ring) > 3:
                if not np.array_equal(ring[0], ring[-1]):
                    ring = np.vstack([ring, ring[0]])
                yield ring


def _point_in_rings(lon, lat, rings, edge_chunk=64):
    """Vectorised even-odd rule.  ``lon``/``lat`` are 2-D point grids."""
    inside = np.zeros(lon.shape, dtype=bool)
    for ring in rings:
        x1 = ring[:-1, 0][:, None, None]
        y1 = ring[:-1, 1][:, None, None]
        dy = (ring[1:, 1] - ring[:-1, 1])[:, None, None]
        dx = (ring[1:, 0] - ring[:-1, 0])[:, None, None]
        ne = x1.shape[0]
        for a in range(0, ne, edge_chunk):
            b = min(a + edge_chunk, ne)
            cond = (y1[a:b] > lat) != ((y1[a:b] + dy[a:b]) > lat)
            with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                xint = x1[a:b] + dx[a:b] * (lat - y1[a:b]) / np.where(dy[a:b] == 0, 1e-12, dy[a:b])
            cross = cond & (lon < xint)
            inside ^= (cross.sum(axis=0) % 2 == 1)
    return inside


def build_mask(verbose=True):
    path = os.path.join(ROOT, "data", "land110.json")
    topo = json.load(open(path))
    arcs = _decode_arcs(topo)
    rings = list(_rings_for_object(topo, arcs))
    if verbose:
        print(f"land110: {len(rings)} rings, "
              f"{sum(len(r) for r in rings):,} vertices")
    lats = LAT_MIN + (np.arange(NLAT) + 0.5) * CELL
    lons = LON_MIN + (np.arange(NLON) + 0.5) * CELL
    # process in latitude strips to bound memory
    mask = np.zeros((NLAT, NLON), dtype=bool)
    for i in range(0, NLAT, 40):
        sl = slice(i, min(i + 40, NLAT))
        LO, LA = np.meshgrid(lons, lats[sl])
        mask[sl] = _point_in_rings(LO, LA, rings)
    return mask


def save_mask(mask):
    packed = np.packbits(mask, axis=None)
    out = {
        "cell": CELL, "lat_min": LAT_MIN, "lat_max": LAT_MAX,
        "lon_min": LON_MIN, "lon_max": LON_MAX,
        "nlat": NLAT, "nlon": NLON,
        "bits": base64.b64encode(packed.tobytes()).decode("ascii"),
        "land_cells": int(mask.sum()),
    }
    with open(os.path.join(ROOT, "data", "land_mask.json"), "w") as fh:
        json.dump(out, fh)
    return out


def load_mask():
    p = os.path.join(ROOT, "data", "land_mask.json")
    if not os.path.exists(p):
        return build_mask_and_save()
    d = json.load(open(p))
    bits = np.frombuffer(base64.b64decode(d["bits"]), dtype=np.uint8)
    m = np.unpackbits(bits)[: d["nlat"] * d["nlon"]].reshape(d["nlat"], d["nlon"]).astype(bool)
    return m, d


def build_mask_and_save():
    m = build_mask()
    d = save_mask(m)
    print(f"land mask: {d['land_cells']:,} of {NLAT*NLON:,} cells "
          f"({100*d['land_cells']/(NLAT*NLON):.1f}%) -> data/land_mask.json")
    return m, d


def cell_index(lat, lon):
    gi = int(np.floor((lat - LAT_MIN) / CELL))
    gj = int(np.floor((lon - LON_MIN) / CELL))
    return gi, gj


if __name__ == "__main__":
    build_mask_and_save()
