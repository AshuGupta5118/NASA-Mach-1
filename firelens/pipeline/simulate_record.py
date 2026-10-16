"""Synthesise a 25-year global active-fire record (2001-2025) and build app payloads.

Run:  python3 pipeline/simulate_record.py [--y0 2001] [--y1 2025] [--seed 20261015]

WHY A SIMULATED RECORD
----------------------
The full MODIS collection-6.1 archive is billions of detections and cannot ship
inside a hackathon deliverable.  This module builds a *physically parameterised*
record instead:

  * spatial pattern  -- fire-province footprints whose relative intensities are
                        FITTED to a real NASA FIRMS 24 h snapshot
  * seasonal cycle   -- per-province von Mises phenology (see pipeline/regions.py)
  * interannual      -- an ENSO-like index with per-province sensitivity, a
                        long-term land-use trend, and dated extreme fire seasons
  * observing system -- the calibrated MODIS/VIIRS detection model, including the
                        real platform changes (Aqua joins Terra in 2003; VIIRS
                        starts 2012; NOAA-20 in 2018; NOAA-21 in 2024) and
                        synthetic sensor outages

The latent "truth" (how many fires actually burned) is saved separately to
``data/sim_truth.npz`` so ``pipeline/validate.py`` can measure how well the
harmonisation estimator recovers it.  The shipped payload contains ONLY the two
sensors' observations -- the harmonised product shown in the app is recomputed
from those, never read from truth.
"""
from __future__ import annotations

import sys, os, json, math, gzip, base64, argparse, datetime, collections
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from pipeline import landmask as LM
from pipeline.regions import REGIONS, BY_KEY
from pipeline.harmonize_core import (Calibration, observing_factors,
                                     satellites_on, MODIS_SATS, VIIRS_SATS,
                                     VIIRS_START)

# --------------------------------------------------------------------------- #
#  Observing-system timeline lives in pipeline/harmonize_core.py so that the
#  simulator and the harmoniser can never disagree.  Only the synthetic outage
#  windows are defined here.
# --------------------------------------------------------------------------- #
#: Illustrative sensor safe-mode / outage windows, injected so the app's
#: data-gap handling can be demonstrated.  Not a log of real incidents.
OUTAGES = [
    ("MODIS", datetime.date(2002, 7, 1), datetime.date(2002, 7, 14), 0.45),
    ("MODIS", datetime.date(2020, 6, 15), datetime.date(2020, 6, 29), 0.55),
    ("VIIRS", datetime.date(2014, 2, 6), datetime.date(2014, 2, 19), 0.25),
    ("VIIRS", datetime.date(2019, 2, 3), datetime.date(2019, 2, 11), 0.30),
    ("VIIRS", datetime.date(2020, 8, 4), datetime.date(2020, 8, 9), 0.35),
    ("VIIRS", datetime.date(2023, 5, 12), datetime.date(2023, 5, 20), 0.40),
]


def outage_factor(sensor, day):
    for s_, a, b, f in OUTAGES:
        if s_ == sensor and a <= day <= b:
            return f
    return 1.0


# --------------------------------------------------------------------------- #
#  Interannual forcing
# --------------------------------------------------------------------------- #
#: Approximate annual-mean Oceanic Nino Index.  Used only as a plausible driver
#: of interannual variability in this synthetic record.
ENSO = {2001: -0.4, 2002: 0.8, 2003: -0.3, 2004: 0.3, 2005: 0.2, 2006: 0.9,
        2007: -1.0, 2008: -1.1, 2009: 0.5, 2010: 1.2, 2011: -1.2, 2012: 0.4,
        2013: 0.3, 2014: 0.4, 2015: 1.8, 2016: 0.9, 2017: 0.4, 2018: 0.7,
        2019: 0.5, 2020: 0.5, 2021: -0.8, 2022: -1.0, 2023: 1.3, 2024: 0.5,
        2025: -0.4}

#: d(ln burning) / d(ENSO) per province.  Positive = El Nino brings more fire.
ENSO_SENS = {
    "sumatra": 0.50, "borneo": 0.55, "java_bali": 0.30, "png": 0.30,
    "se_asia_main": 0.30, "philippines": 0.15,
    "bra_amazon_s": 0.35, "bra_amazon_c": 0.30, "bra_cerrado": 0.25,
    "bol_beni": 0.25, "guiana": 0.15, "peru_agr": 0.15,
    "aus_east": 0.35, "aus_south_west": 0.25, "aus_north": -0.20, "nz": 0.10,
    "us_west": 0.15, "us_south": 0.05, "canada_boreal_w": 0.15,
    "canada_boreal_e": 0.15, "alaska": 0.15, "siberia_w": 0.20,
    "siberia_e": 0.20, "russ_far_east": 0.10, "europe_north": 0.15,
    "med_iberia": 0.20, "med_balkans": 0.20, "med_greece": 0.25,
    "middle_east": 0.15, "ven_llanos": -0.15, "ind_gangetic": -0.10,
    "afr_sahel_w": -0.05, "afr_sahel_c": -0.05, "afr_guinea": -0.05,
}

#: d(ln burning) / year -- long-term land-use and climate trends.  Savanna and
#: cropland burning has declined as land is converted and fire is suppressed;
#: boreal wildfire burning has increased.
TREND = {
    "afr_sahel_w": -0.022, "afr_sahel_c": -0.022, "afr_guinea": -0.020,
    "afr_congo_n": -0.016, "afr_congo_s": -0.018, "afr_angola": -0.020,
    "afr_zambezi": -0.018, "afr_south": -0.014, "afr_ethiop": -0.010,
    "afr_madag": -0.010, "afr_horn": -0.006,
    "bra_cerrado": -0.018, "bra_amazon_s": -0.012, "bra_amazon_c": -0.010,
    "bol_beni": -0.014, "arg_pampas": -0.006,
    "ind_gangetic": -0.012, "ind_peninsula": -0.008, "se_asia_main": -0.014,
    "china_north": -0.016, "china_ne": -0.010, "himalaya_foothills": -0.006,
    "siberia_w": 0.018, "siberia_e": 0.022, "russ_far_east": 0.012,
    "canada_boreal_w": 0.020, "canada_boreal_e": 0.018, "alaska": 0.016,
    "us_west": 0.024, "aus_east": 0.014, "mongolia": 0.008,
    "kazakh_steppe": 0.006, "europe_north": 0.012, "med_iberia": 0.006,
    "med_greece": 0.010, "med_balkans": 0.006, "middle_east": 0.008,
}

#: Dated extreme fire seasons: (province, year, [months], multiplier).
EXTREMES = [
    ("europe_north", 2010, [7, 8], 2.2), ("siberia_w", 2010, [7, 8], 2.6),
    ("sumatra", 2015, [8, 9, 10, 11], 2.4), ("borneo", 2015, [8, 9, 10, 11], 2.6),
    ("png", 2015, [8, 9, 10], 1.8), ("java_bali", 2015, [9, 10], 1.5),
    ("bra_amazon_s", 2005, [8, 9, 10], 1.9), ("bra_amazon_s", 2010, [8, 9], 1.8),
    ("bra_amazon_c", 2010, [8, 9], 1.7),
    ("aus_east", 2019, [11, 12], 3.5), ("aus_east", 2020, [1, 2], 3.0),
    ("aus_south_west", 2020, [1, 2], 1.8), ("aus_north", 2002, [9, 10, 11], 1.6),
    ("canada_boreal_w", 2023, [5, 6, 7, 8, 9], 3.2),
    ("canada_boreal_e", 2023, [5, 6, 7, 8, 9], 3.0),
    ("canada_boreal_w", 2016, [5], 2.0), ("canada_boreal_e", 2025, [7, 8], 1.7),
    ("us_west", 2020, [8, 9, 10], 2.6), ("us_west", 2021, [7, 8, 9], 2.2),
    ("us_west", 2018, [8, 9], 1.8), ("us_west", 2025, [1], 1.9),
    ("med_iberia", 2003, [8], 2.2), ("med_greece", 2007, [8], 2.5),
    ("med_greece", 2018, [7], 2.0), ("med_iberia", 2017, [10], 2.0),
    ("med_balkans", 2021, [8], 2.0), ("med_iberia", 2022, [7, 8], 1.8),
    ("siberia_e", 2021, [7, 8], 2.6), ("siberia_e", 2019, [7, 8], 1.9),
    ("mongolia", 2022, [4, 5], 1.8), ("ind_gangetic", 2019, [11], 1.6),
    ("bol_beni", 2019, [9, 10], 2.2), ("bol_beni", 2024, [9, 10], 2.4),
    ("bra_cerrado", 2017, [9, 10], 1.7), ("bra_amazon_s", 2024, [8, 9, 10], 2.0),
    ("ven_llanos", 2024, [2, 3], 1.7), ("afr_congo_s", 2016, [8, 9], 1.4),
    ("afr_zambezi", 2011, [9, 10], 1.3), ("chi_central", 2017, [1, 2], 2.0),
    ("patagonia", 2025, [1, 2, 3], 1.8), ("uk_heather", 2019, [3, 4], 1.5),
]
_EXT = collections.defaultdict(dict)
for _k, _y, _ms, _f in EXTREMES:
    _EXT[(_k, _y)].update({m: _f for m in _ms})


# --------------------------------------------------------------------------- #
#  Spatial field

# --------------------------------------------------------------------------- #
#  Spatial-concentration tuning
# --------------------------------------------------------------------------- #
def real_cells_per_day():
    """Occupied 0.25 deg cells per day in the real FIRMS snapshot."""
    real = json.load(open(os.path.join(ROOT, "data", "calibration.json")))
    rs = real["real_statistics"]
    n = rs["cells_both"] + rs["cells_modis_only"] + rs["cells_viirs_only"]
    dates = [d for d in real["calibration"]["provenance"]["snapshot_dates"].split(",") if d]
    return n / max(len(dates), 1), n, len(dates)


def anchor_amplitudes(cal):
    """Detection amplitudes for the configuration the real snapshot came from:
    Terra+Aqua MODIS (the reference) and Suomi NPP VIIRS *only* -- the FIRMS
    ``SUOMI_VIIRS_C2_Global_24h`` archive file contains no NOAA-20/21 data."""
    a_m, a_v, _, _ = observing_factors(cal, datetime.date(2026, 10, 14),
                                       n_modis_sats=2, n_viirs_sats=1)
    return a_m, a_v


def anchor_amps(field, weights, day):
    doy = day.timetuple().tm_yday
    e = ENSO.get(day.year, 0.0)
    out = {}
    for r in REGIONS:
        if r.key not in field["prov"]:
            continue
        yf = math.exp(ENSO_SENS.get(r.key, 0.0) * e
                      + TREND.get(r.key, 0.0) * (day.year - 2013))
        out[r.key] = weights[r.key] * r.seasonality(doy) * yf
    return out


def global_scale(field, weights, cal, anchor=datetime.date(2026, 10, 14),
                 n_modis_real=14217.0):
    """K such that the simulated anchor day reproduces the real MODIS count."""
    amps = anchor_amps(field, weights, anchor)
    raw = sum(amps[k] * field["prov"][k]["A"] for k in amps)
    am, av = anchor_amplitudes(cal)
    K = n_modis_real / max(raw * am, 1e-9)
    return K, raw, am, av


def expected_occupied(field, weights, cal, K,
                      day=datetime.date(2026, 10, 14)):
    """Expected number of 0.25 deg cells holding >=1 detection on `day`."""
    amps = anchor_amps(field, weights, day)
    am, av = anchor_amplitudes(cal)
    lam = np.zeros(field["nunion"])
    for k, a in amps.items():
        if a > 0:
            pr = field["prov"][k]
            lam[pr["pos"]] += pr["fn"] * a
    lam *= K
    return float((1.0 - np.exp(-lam * (am + av))).sum()), float(lam.sum())


def tune_concentration(cal, target_cells, seed=20261015, verbose=True):
    """Pick the burnable-cell fraction that reproduces the real spatial density."""
    best = None
    for p_hot in (0.020, 0.028, 0.038, 0.050, 0.065, 0.085, 0.115):
        f = build_field(seed, p_hot=p_hot)
        w = fit_weights(f)
        K, raw, am, av = global_scale(f, w, cal)
        occ, tot = expected_occupied(f, w, cal, K)
        err = math.log(max(occ, 1.0) / target_cells)
        if verbose:
            print(f"    p_hot={p_hot:5.3f}  cells/day={occ:8,.0f}  "
                  f"(real {target_cells:,.0f}, err {100*(occ/target_cells-1):+6.1f}%)  "
                  f"N_true={tot:,.0f}  K={K:.4g}")
        if best is None or abs(err) < abs(best[0]):
            best = (err, p_hot, f, w, K, occ)
    return best


# --------------------------------------------------------------------------- #
def footprint_vec(r, LA, LO):
    """Vectorised province footprint (Gaussian, rotated)."""
    dlat = LA - r.lat
    dlon = (LO - r.lon + 540.0) % 360.0 - 180.0
    t = math.radians(r.tilt)
    c, s = math.cos(t), math.sin(t)
    u = (dlon * c + dlat * s) / r.rx
    v = (-dlon * s + dlat * c) / r.ry
    return np.exp(-0.5 * (u * u + v * v))


def build_field(seed=20261015, p_hot=0.05, hot_sigma=1.15, cold_shift=-9.0):
    """Pre-compute province footprints on the 0.25 deg grid times a noise field.

    The noise field is deliberately *bimodal*: only a fraction ``p_hot`` of land
    cells are "burnable" at full weight, the rest are heavily suppressed.  This
    reproduces the strong spatial concentration seen in real FIRMS data, where a
    single day's detections occupy only ~8,500 of the ~113,000 land cells in the
    0.25 deg grid but average >5 detections per occupied cell.  ``p_hot`` is tuned
    automatically against that real statistic (see ``tune_concentration``).
    """
    rng = np.random.default_rng(seed)
    mask, meta = LM.load_mask()
    nlat, nlon, cell = meta["nlat"], meta["nlon"], meta["cell"]
    lats = LM.LAT_MIN + (np.arange(nlat) + 0.5) * cell
    lons = LM.LON_MIN + (np.arange(nlon) + 0.5) * cell
    LO, LA = np.meshgrid(lons, lats)

    # ---- smooth multi-scale structure (fuel / land-use patchiness)
    noise = np.ones_like(LO)
    for amp, fx, fy, ph in [(0.42, 3, 5, 0.3), (0.30, 7, 4, 1.7), (0.22, 13, 11, 2.9),
                            (0.16, 23, 19, 4.1), (0.12, 41, 37, 5.3)]:
        noise *= np.exp(amp * np.sin(2 * np.pi * (fx * LO / 360 + fy * LA / 180) + ph))
    # ---- bimodal burnable-cell field
    u = rng.random(LO.shape)
    hot = u < p_hot
    # Non-burnable cells get ~1e-4 weight: effectively zero, but kept non-zero so
    # the field stays continuous and no land cell is strictly excluded.
    conc = np.where(hot, rng.lognormal(0.0, hot_sigma, size=LO.shape),
                    rng.lognormal(cold_shift, 0.6, size=LO.shape))
    noise *= conc
    noise = np.where(mask, noise, 0.0)
    m = noise > 0
    noise[m] /= noise[m].mean()          # keep the mean at 1 so K stays comparable
    noise_flat = noise.reshape(-1)

    prov, covered = {}, np.zeros(nlat * nlon, dtype=bool)
    for r in REGIONS:
        if r.key == "global_background":
            continue
        w, s, e, n_ = r.bbox()
        i0 = max(int((s - LM.LAT_MIN) // cell), 0)
        i1 = min(int((n_ - LM.LAT_MIN) // cell) + 1, nlat)
        j0 = max(int((w - LM.LON_MIN) // cell), 0)
        j1 = min(int((e - LM.LON_MIN) // cell) + 1, nlon)
        if i1 <= i0 or j1 <= j0:
            continue
        f = footprint_vec(r, LA[i0:i1, j0:j1], LO[i0:i1, j0:j1])
        f = np.where(mask[i0:i1, j0:j1] & (f > 2e-3), f, 0.0)
        ii, jj = np.nonzero(f)
        if ii.size == 0:
            continue
        flat = ((i0 + ii) * nlon + (j0 + jj)).astype(np.int64)
        fn = (f[ii, jj] * noise_flat[flat]).astype(np.float64)
        prov[r.key] = {"cells": flat, "fn": fn, "A": float(fn.sum())}
        covered[flat] = True

    bg = np.flatnonzero((noise_flat > 0.05) & ~covered)
    if bg.size:
        fn = noise_flat[bg].astype(np.float64) * 0.012
        prov["global_background"] = {"cells": bg.astype(np.int64), "fn": fn,
                                     "A": float(fn.sum())}
        covered[bg] = True

    ucells = np.flatnonzero(covered)
    pos_of = -np.ones(nlat * nlon, dtype=np.int64)
    pos_of[ucells] = np.arange(ucells.size)
    for p in prov.values():
        p["pos"] = pos_of[p["cells"]]
        p["A"] = max(p["fn"].sum(), 1e-9)
        p["share"] = (p["fn"] / p["A"]).astype(np.float32)
    return dict(prov=prov, union=ucells, nunion=int(ucells.size), noise=noise,
                mask=mask, meta=meta, nlat=nlat, nlon=nlon, cell=cell,
                lats=lats, lons=lons, pos_of=pos_of,
                params={"p_hot": p_hot, "hot_sigma": hot_sigma,
                        "cold_shift": cold_shift, "seed": seed})


def fit_weights(field):
    """Turn the real 24 h snapshot into de-seasonalised province intensities.

    observed_r ~ w_r * season_r(anchor_doy) * A_r, so w_r ~ observed_r/(season*A_r).
    """
    real = json.load(open(os.path.join(ROOT, "data", "calibration.json")))
    obs = real["region_counts_viirs"]
    tot = sum(obs.values()) or 1.0
    anchor_doy = 287                     # 14 October
    w = {}
    for r in REGIONS:
        o = obs.get(r.key, 0.0)
        if r.key == "global_background":
            o = max(o, 0.03 * tot)
        s = max(r.seasonality(anchor_doy), 0.02)
        A = field["prov"].get(r.key, {}).get("A", 1.0)
        w[r.key] = (o / tot) / (s * A)
    m = float(np.mean([w[r.key] for r in REGIONS if r.key in field["prov"]]))
    return {k: v / m for k, v in w.items()}


# --------------------------------------------------------------------------- #
_ZQ = np.linspace(-6.0, 7.0, 521)
_ZW = np.exp(-0.5 * _ZQ * _ZQ); _ZW /= _ZW.sum()


def detection_amplitudes(cal, day):
    """(A_modis, A_viirs): expected detections per true burning cluster.

    Delegates to ``harmonize_core.observing_factors`` so the simulated record and
    the harmoniser use exactly the same observing-system model.
    """
    a_m, a_v, _, _ = observing_factors(cal, day)
    return a_m, a_v


# --------------------------------------------------------------------------- #
def varint(buf, v):
    v = int(v)
    if v < 0:
        v = 0
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def encode_sparse_grid(slices, ncols):
    """Sparse daily/monthly/yearly grid -> compact binary.

    Layout (three *separate* streams, then concatenated).  Keeping the cell-index
    deltas apart from the counts matters: interleaving them destroys the
    redundancy gzip can exploit, and costs ~2x on disk.

        header   : varint nslices, varint ncols
        stream I : per slice -> varint count, then `count` delta-encoded cell indices
        stream M : per slice -> `count` varint MODIS detection numbers
        stream V : per slice -> `count` varint VIIRS detection numbers

    The browser reader is in app/js/data.js (readSparseGrid).
    """
    head = bytearray(); I = bytearray(); M = bytearray(); V = bytearray()
    varint(head, len(slices)); varint(head, ncols)
    for idx, mm, vv in slices:
        varint(I, idx.size)
        prev = 0
        for k in range(idx.size):
            c = int(idx[k])
            varint(I, c - prev); prev = c
        for k in range(idx.size):
            varint(M, int(mm[k]))
            varint(V, int(vv[k]))
    varint(head, len(I)); varint(head, len(M)); varint(head, len(V))
    return bytes(head) + bytes(I) + bytes(M) + bytes(V)


def write_bin_gz(path, data):
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(data)
    print(f"    {os.path.basename(path)}: {len(data)/1e6:.2f} MB raw -> "
          f"{os.path.getsize(path)/1e6:.2f} MB gz")


def encode_varints(values):
    buf = bytearray()
    varint(buf, len(values))
    for v in values:
        varint(buf, int(v))
    return base64.b64encode(bytes(buf)).decode("ascii")


def b64f32(a):
    return base64.b64encode(np.asarray(a, dtype="<f4").tobytes()).decode("ascii")


# --------------------------------------------------------------------------- ##  Main
# --------------------------------------------------------------------------- #
GRID_MONTHLY = 2.0        # deg - 300 slices, spatial climatology for any month
GRID_YEARLY = 1.0         # deg - 25 slices, spatial trend maps
TOP_N_PROVINCE = 2600     # cells kept per province in the AOI raster


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--y0", type=int, default=2001)
    ap.add_argument("--y1", type=int, default=2025)
    ap.add_argument("--seed", type=int, default=20261015)
    ap.add_argument("--recent-days", type=int, default=183)
    ap.add_argument("--out", default=os.path.join(ROOT, "app", "data"))
    args = ap.parse_args()

    cal = Calibration.from_dict(
        json.load(open(os.path.join(ROOT, "data", "calibration.json")))["calibration"])
    print("calibration (fitted to a real NASA FIRMS 24 h snapshot):")
    for k, v in cal.to_dict().items():
        if not isinstance(v, dict):
            print(f"   {k:34s} {v}")

    cells_real, cells_tot, n_dates = real_cells_per_day()
    print(f"\nreal snapshot: {cells_tot:,} occupied 0.25deg cells over {n_dates} UTC days "
          f"= {cells_real:,.0f}/day")

    print("tuning spatial concentration ...")
    err, p_hot, field, weights, K, occ = tune_concentration(cal, cells_real, args.seed)
    prov, nunion = field["prov"], field["nunion"]
    print(f"  chosen p_hot={p_hot} -> {occ:,.0f} cells/day ({100*(occ/cells_real-1):+.1f}% vs real)")
    print(f"  {len(prov)} provinces, {nunion:,} candidate land cells ({field['cell']} deg)")

    am_a, av_a = anchor_amplitudes(cal)
    amps = anchor_amps(field, weights, datetime.date(2026, 10, 14))
    raw_total = sum(amps[k] * prov[k]["A"] for k in amps)
    print(f"  global scale K = {K:.6g}")
    print(f"  anchor day 2026-10-14: N_true {K*raw_total:,.0f}   "
          f"MODIS {K*raw_total*am_a:,.0f} (real 14,217)   "
          f"VIIRS {K*raw_total*av_a:,.0f} (real 81,473)")

    # ---- per-province monthly weather noise
    rng = np.random.default_rng(args.seed + 1)
    years = list(range(args.y0, args.y1 + 1))
    weather = {}
    for y in years:
        for k in prov:
            base = float(rng.normal(0, 0.22))
            for m in range(1, 13):
                weather[(k, y, m)] = math.exp(base * 0.6 + float(rng.normal(0, 0.20)))

    day_index, d, i = {}, datetime.date(args.y0, 1, 1), 0
    while d.year <= args.y1:
        day_index[d] = i
        d += datetime.timedelta(days=1); i += 1
    ndays = i
    print(f"  {ndays:,} days: {args.y0}-01-01 .. {args.y1}-12-31")

    keys = sorted(prov.keys())
    kidx = {k: n for n, k in enumerate(keys)}
    reg_m = np.zeros((len(keys), ndays), dtype=np.int32)
    reg_v = np.zeros((len(keys), ndays), dtype=np.int32)
    reg_t = np.zeros((len(keys), ndays), dtype=np.float32)
    glob_m = np.zeros(ndays, dtype=np.int32)
    glob_v = np.zeros(ndays, dtype=np.int32)
    glob_t = np.zeros(ndays, dtype=np.float32)

    nlat, nlon, cell = field["nlat"], field["nlon"], field["cell"]
    ugi, ugj = np.divmod(field["union"], nlon)

    def coarse_index(fac):
        nl, ng = nlat // fac, nlon // fac
        return ((ugi // fac) * ng + (ugj // fac)).astype(np.int64), nl * ng, nl, ng

    fm = int(round(GRID_MONTHLY / cell)); fy = int(round(GRID_YEARLY / cell))
    ci_m, ncoarse_m, mnl, mng = coarse_index(fm)
    ci_y, ncoarse_y, ynl, yng = coarse_index(fy)

    monthly_slices, yearly_slices, recent = [], [], {}
    recent_start = max(ndays - args.recent_days, 0)
    mon_m = np.zeros(ncoarse_m, dtype=np.int32); mon_v = np.zeros(ncoarse_m, dtype=np.int32)
    yr_m = np.zeros(ncoarse_y, dtype=np.int32);  yr_v = np.zeros(ncoarse_y, dtype=np.int32)
    cur_month = cur_year = None

    amp_cache, det_cache = {}, {}
    lam = np.zeros(nunion, dtype=np.float64)
    t0 = datetime.datetime.now()

    d = datetime.date(args.y0, 1, 1)
    while d.year <= args.y1:
        di = day_index[d]
        mi = (d.year - args.y0) * 12 + (d.month - 1)
        if cur_month is not None and mi != cur_month:
            ix = np.flatnonzero((mon_m > 0) | (mon_v > 0))
            monthly_slices.append((ix.astype(np.int64), mon_m[ix].copy(), mon_v[ix].copy()))
            mon_m[:] = 0; mon_v[:] = 0
        cur_month = mi
        if cur_year is not None and d.year != cur_year:
            ix = np.flatnonzero((yr_m > 0) | (yr_v > 0))
            yearly_slices.append((ix.astype(np.int64), yr_m[ix].copy(), yr_v[ix].copy()))
            yr_m[:] = 0; yr_v[:] = 0
        cur_year = d.year

        ck = (d.year, d.month)
        if ck not in amp_cache:
            doy = d.timetuple().tm_yday
            e = ENSO.get(d.year, 0.0)
            a = {}
            for r in REGIONS:
                if r.key not in prov:
                    continue
                yf = math.exp(ENSO_SENS.get(r.key, 0.0) * e
                              + TREND.get(r.key, 0.0) * (d.year - 2013))
                mo = _EXT.get((r.key, d.year), {}).get(d.month, 1.0)
                a[r.key] = (weights[r.key] * r.seasonality(doy) * yf
                            * weather[(r.key, d.year, d.month)] * mo)
            amp_cache = {ck: a}
            det_cache = {ck: detection_amplitudes(cal, d)}
        amp = amp_cache[ck]
        am, av = det_cache[ck]
        am *= outage_factor("MODIS", d)
        av *= outage_factor("VIIRS", d)

        lam[:] = 0.0
        raw = 0.0
        for k, a in amp.items():
            if a <= 0:
                continue
            pr = prov[k]
            contrib = pr["fn"] * a
            lam[pr["pos"]] += contrib
            raw += contrib.sum()
        lam *= K

        act = np.flatnonzero(lam > 1e-4)
        if act.size:
            la = lam[act]
            nt = rng.poisson(la)
            nm = rng.poisson(la * am) if am > 0 else np.zeros(act.size, dtype=np.int64)
            nv = rng.poisson(la * av) if av > 0 else np.zeros(act.size, dtype=np.int64)
        else:
            nt = nm = nv = np.zeros(0, dtype=np.int64)

        gm, gv, gt = int(nm.sum()), int(nv.sum()), float(nt.sum())
        glob_m[di], glob_v[di], glob_t[di] = gm, gv, gt

        # The field is additive, so province r's share of the day's total intensity
        # is exactly amp_r*A_r / sum(amp_r'*A_r').
        if raw > 0 and gt > 0:
            tot_true = gt
            for k, a in amp.items():
                if a <= 0:
                    continue
                sc = (a * prov[k]["A"]) / raw
                ri = kidx[k]
                reg_t[ri, di] = sc * tot_true
                reg_m[ri, di] = int(round(sc * gm))
                reg_v[ri, di] = int(round(sc * gv))

        if act.size:
            yr_m += np.bincount(ci_y[act], weights=nm, minlength=ncoarse_y).astype(np.int32)
            yr_v += np.bincount(ci_y[act], weights=nv, minlength=ncoarse_y).astype(np.int32)
            mon_m += np.bincount(ci_m[act], weights=nm, minlength=ncoarse_m).astype(np.int32)
            mon_v += np.bincount(ci_m[act], weights=nv, minlength=ncoarse_m).astype(np.int32)
            if di >= recent_start:
                keep = (nm > 0) | (nv > 0)
                if keep.any():
                    recent[di] = (field["union"][act][keep].astype(np.int64),
                                  nm[keep].astype(np.int32),
                                  nv[keep].astype(np.int32))

        if di % 730 == 0:
            el = (datetime.datetime.now() - t0).total_seconds()
            print(f"    day {di}/{ndays}  {d}  M={gm:,} V={gv:,}  "
                  f"[{el:.0f}s, ETA {el/max(di,1)*ndays:.0f}s]")
        d += datetime.timedelta(days=1)

    ix = np.flatnonzero((mon_m > 0) | (mon_v > 0))
    monthly_slices.append((ix.astype(np.int64), mon_m[ix].copy(), mon_v[ix].copy()))
    ix = np.flatnonzero((yr_m > 0) | (yr_v > 0))
    yearly_slices.append((ix.astype(np.int64), yr_m[ix].copy(), yr_v[ix].copy()))

    print(f"\nsimulation done in {(datetime.datetime.now()-t0).total_seconds():.0f}s")
    print(f"  totals: MODIS {glob_m.sum():,}  VIIRS {glob_v.sum():,}  "
          f"true events {glob_t.sum():,.0f}")
    np.savez_compressed(os.path.join(ROOT, "data", "sim_truth.npz"),
                        glob_m=glob_m, glob_v=glob_v, glob_t=glob_t,
                        reg_m=reg_m, reg_v=reg_v, reg_t=reg_t,
                        keys=np.array(keys), ndays=ndays, y0=args.y0,
                        p_hot=p_hot, K=K)
    print("  wrote data/sim_truth.npz (ground truth, validation only)")

    build_payload(field, weights, cal, args, ndays, recent_start, keys, p_hot, K,
                  glob_m, glob_v, glob_t, reg_m, reg_v, reg_t,
                  monthly_slices, yearly_slices, recent,
                  mnl, mng, ynl, yng, nlat, nlon)


# --------------------------------------------------------------------------- #
def build_payload(field, weights, cal, args, ndays, recent_start, keys, p_hot, K,
                  glob_m, glob_v, glob_t, reg_m, reg_v, reg_t,
                  monthly_slices, yearly_slices, recent,
                  mnl, mng, ynl, yng, nlat, nlon):
    os.makedirs(args.out, exist_ok=True)
    cell = field["cell"]

    mon_bin = encode_sparse_grid(monthly_slices, mnl * mng)
    print(f"  monthly {GRID_MONTHLY}deg grid: {sum(s[0].size for s in monthly_slices):,} "
          f"cell-months -> {len(mon_bin)/1e6:.2f} MB")
    yr_bin = encode_sparse_grid(yearly_slices, ynl * yng)
    print(f"  yearly {GRID_YEARLY}deg grid: {sum(s[0].size for s in yearly_slices):,} "
          f"cell-years -> {len(yr_bin)/1e6:.2f} MB")

    rec_slices = []
    for di in range(recent_start, ndays):
        e = recent.get(di)
        if e is None:
            rec_slices.append((np.zeros(0, np.int64), np.zeros(0, np.int32),
                               np.zeros(0, np.int32)))
        else:
            idx, mm, vv = e
            o = np.argsort(idx)
            rec_slices.append((idx[o], mm[o], vv[o]))
    rec_bin = encode_sparse_grid(rec_slices, nlat * nlon)
    n_cell_days = sum(s[0].size for s in rec_slices)
    print(f"  recent daily {cell}deg grid ({args.recent_days} d): {n_cell_days:,} "
          f"cell-days ({n_cell_days/max(args.recent_days,1):,.0f}/day) -> "
          f"{len(rec_bin)/1e6:.2f} MB")

    # ---- province raster: the cells carrying >=95% of each province's mass
    pr = {}
    kept = []
    for k, pv in field["prov"].items():
        sh = pv["share"]
        order = np.argsort(-sh)
        cum = np.cumsum(sh[order])
        n = int(min(max(np.searchsorted(cum, 0.95) + 1, 40), TOP_N_PROVINCE, sh.size))
        sel = order[:n]
        ci = pv["cells"][sel].astype(np.int64)
        sv = (sh[sel] / max(cum[n - 1], 1e-12)).astype(np.float64)   # renormalise
        o = np.argsort(ci)
        ci, sv = ci[o], sv[o]
        buf = bytearray()
        varint(buf, ci.size)
        prev = 0
        for c, s_ in zip(ci, sv):
            varint(buf, int(c) - prev); prev = int(c)
            varint(buf, int(round(float(s_) * 8192)))
        pr[k] = base64.b64encode(bytes(buf)).decode("ascii")
        kept.append(n)
    print(f"  province raster: {sum(kept):,} cells "
          f"({sum(len(v) for v in pr.values())/1e6:.2f} MB b64)")

    core = {
        "meta": {
            "name": "FireLens harmonised active-fire record",
            "y0": args.y0, "y1": args.y1, "ndays": ndays,
            "start": f"{args.y0}-01-01",
            "grid": {"cell": cell, "nlat": nlat, "nlon": nlon,
                     "lat_min": LM.LAT_MIN, "lon_min": LM.LON_MIN},
            "monthly": {"cell": GRID_MONTHLY, "nlat": mnl, "nlon": mng,
                        "slices": len(monthly_slices)},
            "yearly": {"cell": GRID_YEARLY, "nlat": ynl, "nlon": yng,
                       "slices": len(yearly_slices)},
            "record_kind": "synthetic-25y",
            "record_note": (
                "The 2001-2025 daily record is SYNTHETIC, generated by "
                "pipeline/simulate_record.py. Province intensities, spatial "
                "concentration, the MODIS and VIIRS detection models and the "
                "absolute count scale are all fitted to a real NASA FIRMS 24 h "
                "snapshot (2026-10-14/15: 14,217 MODIS + 81,473 VIIRS detections "
                "in 17,104 grid cells). The bundled 'real FIRMS 24 h' dataset is "
                "genuine NASA data. Import your own FIRMS CSVs under Data to run "
                "the same harmonisation on a real archive."),
            "generated": datetime.datetime.now(datetime.timezone.utc)
                                   .isoformat(timespec="seconds"),
            "seed": args.seed, "p_hot": p_hot, "K": K,
            "outages": [[s_, a.isoformat(), b.isoformat(), f] for s_, a, b, f in OUTAGES],
            "observing_system": {
                "MODIS": [[dd.isoformat(), n] for dd, n in MODIS_SATS],
                "VIIRS": [[dd.isoformat(), n] for dd, n in VIIRS_SATS],
                "note": "entries are (date, number of contributing satellites); "
                        "detection amplitude compounds as 1-(1-p)^(n/n_ref)",
            },
            "grids_note": "Daily 0.25deg cells are shipped for the most recent "
                          f"{args.recent_days} days only; older periods use the "
                          "1.0deg monthly and 0.5deg yearly climatologies plus the "
                          "exact daily province series.",
        },
        "calibration": cal.to_dict(),
        "regions": [region_json(r, weights.get(r.key, 0.0)) for r in REGIONS],
        "series": {
            "global": {"modis": encode_varints(glob_m),
                       "viirs": encode_varints(glob_v),
                       "truth": b64f32(glob_t)},
            "keys": keys,
            "regions": {"modis": [encode_varints(reg_m[i_]) for i_ in range(len(keys))],
                        "viirs": [encode_varints(reg_v[i_]) for i_ in range(len(keys))]},
        },
        "province_raster": {"nlat": nlat, "nlon": nlon, "cell": cell,
                            "scale": 8192, "data": pr},
        #: the spatial grids live in their own gzipped binary files -- base64 inside
        #: JSON would cost 4/3 and defeat gzip's byte-level modelling.
        "grid_files": {
            "monthly": {"file": "grid_monthly.bin.gz", "cell": GRID_MONTHLY,
                        "nlat": mnl, "nlon": mng, "slices": len(monthly_slices),
                        "lat_min": LM.LAT_MIN, "lon_min": LM.LON_MIN},
            "yearly": {"file": "grid_yearly.bin.gz", "cell": GRID_YEARLY,
                       "nlat": ynl, "nlon": yng, "slices": len(yearly_slices),
                       "lat_min": LM.LAT_MIN, "lon_min": LM.LON_MIN},
            "recent": {"file": "grid_recent.bin.gz", "cell": cell,
                       "nlat": nlat, "nlon": nlon, "slices": len(rec_slices),
                       "start_day": recent_start,
                       "lat_min": LM.LAT_MIN, "lon_min": LM.LON_MIN},
        },
    }
    write_gz(os.path.join(args.out, "core.json.gz"), core)
    write_bin_gz(os.path.join(args.out, "grid_monthly.bin.gz"), mon_bin)
    write_bin_gz(os.path.join(args.out, "grid_yearly.bin.gz"), yr_bin)
    write_bin_gz(os.path.join(args.out, "grid_recent.bin.gz"), rec_bin)
    write_gz(os.path.join(args.out, "events.json.gz"), load_real_events())
    tot = sum(os.path.getsize(os.path.join(args.out, f))
              for f in os.listdir(args.out) if f.endswith(".gz"))
    print(f"wrote app/data/  (total {tot/1e6:.2f} MB gz)")


def region_json(r, weight):
    pk, _ = r.season_peak()
    return {
        "key": r.key, "name": r.name, "country": r.country,
        "lat": r.lat, "lon": r.lon, "rx": r.rx, "ry": r.ry, "tilt": r.tilt,
        "driver": r.driver, "landcover": r.landcover, "notes": r.notes,
        "weight": round(float(weight), 6),
        "seasons": [[c.mu, c.kappa, c.weight] for c in r.seasons],
        "peak_doy": pk, "s50": r.s50, "sigma": r.sigma,
        "bbox": [round(float(x), 3) for x in r.bbox()],
        "enso": ENSO_SENS.get(r.key, 0.0),
        "trend": TREND.get(r.key, 0.0),
    }


def write_gz(path, obj):
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(raw)
    print(f"    {os.path.basename(path)}: {len(raw)/1e6:.2f} MB raw -> "
          f"{os.path.getsize(path)/1e6:.2f} MB gz")


def load_real_events():
    """The genuine NASA FIRMS 24 h snapshot, as events, for the app's real-data mode."""
    from pipeline.dbf_shp import read_layer
    from pipeline.harmonize_core import normalise_confidence
    base = os.path.join(ROOT, "data", "real24h")
    out = {"meta": {}, "modis": [], "viirs": []}
    specs = [("modis", "modis_terra_24h", "MODIS_C6_1_Global_24h", "BRIGHTNESS"),
             ("viirs", "viirs_snpp_24h", "SUOMI_VIIRS_C2_Global_24h", "BRIGHT_TI4")]
    dates = set()
    for bucket, folder, stem, bfield in specs:
        rows = list(read_layer(os.path.join(base, folder), stem))
        recs = []
        for r in rows:
            dates.add(r["ACQ_DATE"])
            recs.append([
                round(float(r["LONGITUDE"]), 4), round(float(r["LATITUDE"]), 4),
                r["ACQ_DATE"][5:].replace("-", ""), int(r["ACQ_TIME"]),
                round(float(r["FRP"]), 2), round(float(r[bfield]), 1),
                normalise_confidence("MODIS" if bucket == "modis" else "VIIRS",
                                     r.get("CONFIDENCE")),
                r.get("DAYNIGHT", "?"), r.get("SATELLITE", "?"),
                round(float(r.get("SCAN", 1)), 2), round(float(r.get("TRACK", 1)), 2),
            ])
        out[bucket] = recs
        print(f"  real events {bucket}: {len(recs):,}")
    out["meta"] = {
        "source": "NASA FIRMS (LANCE): MODIS C6.1 Terra+Aqua and Suomi NPP VIIRS C2, "
                  "global 24 h archive",
        "dates": sorted(dates),
        "fields": ["lon", "lat", "mmdd", "time_utc_hhmm", "frp_mw", "bright_k",
                   "confidence", "daynight", "satellite", "scan", "track"],
        "url": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/",
        "licence": "NASA FIRMS data are free to use; see NASA's data usage policy.",
        "n_modis": len(out["modis"]), "n_viirs": len(out["viirs"]),
    }
    return out


if __name__ == "__main__":
    main()
