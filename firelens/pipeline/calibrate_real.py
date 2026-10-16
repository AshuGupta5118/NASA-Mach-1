"""Fit the sensor model + region intensities to a real NASA FIRMS 24 h snapshot.

Run:  python3 pipeline/calibrate_real.py

Reads   data/real24h/{modis_terra_24h,viirs_snpp_24h}   (ESRI shapefiles)
Writes  data/calibration.json

---------------------------------------------------------------------------
Generative model being fitted
---------------------------------------------------------------------------
A *true* fire event is a burning cluster with latent total FRP  S  [MW],
    S ~ LogNormal(ln s_med, s_sig).

VIIRS (375 m) detects the cluster with probability p_v(S) and then resolves it
into  m(S) = 1 + ms*sqrt(S)  sub-pixel detections, each reporting only its own
share of the energy:
    FRP_pixel = S / m(S) * exp(N(0, sig_p)).

MODIS (1 km) detects the cluster with probability p_m(S) and reports a single
detection whose FRP integrates most, but not all, of the cluster:
    FRP_modis = eta * S * exp(N(0, sig_m)).

Clusters are scattered over grid cells with a Gamma-distributed intensity so
that spatial clumping (and therefore cell-occupancy statistics) is reproduced.

The fit is a coordinate-descent search over the 11 free parameters against 13
summary statistics measured on the real snapshot.
"""
from __future__ import annotations

import sys, os, json, math, collections, datetime
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from pipeline.dbf_shp import read_layer
from pipeline.harmonize_core import (SensorModel, Calibration, spatial_match,
                                     normalise_confidence, fit_size_distribution)
from pipeline.regions import REGIONS, BY_KEY

CELL = 0.25
N_PROBE = 120_000            # clusters used to measure model means
SIG_P = 0.50                 # per-pixel FRP log-scatter (VIIRS)
SIG_M = 0.35                 # per-pixel FRP log-scatter (MODIS)


# --------------------------------------------------------------------------- #
def load_real():
    base = os.path.join(ROOT, "data", "real24h")
    mod = list(read_layer(os.path.join(base, "modis_terra_24h"), "MODIS_C6_1_Global_24h"))
    vir = list(read_layer(os.path.join(base, "viirs_snpp_24h"), "SUOMI_VIIRS_C2_Global_24h"))
    for r in mod:
        r["sensor"] = "MODIS"
        r["confidence_unified"] = normalise_confidence("MODIS", r.get("CONFIDENCE"))
    for r in vir:
        r["sensor"] = "VIIRS"
        r["confidence_unified"] = normalise_confidence("VIIRS", r.get("CONFIDENCE"))
    return mod, vir


def _cellkey(r):
    return (r["ACQ_DATE"],
            int(math.floor(float(r["LATITUDE"]) / CELL)),
            int(math.floor(float(r["LONGITUDE"]) / CELL)))


def target_stats(mod, vir):
    fm = np.array([float(r["FRP"]) for r in mod])
    fv = np.array([float(r["FRP"]) for r in vir])
    cm, cv = collections.Counter(map(_cellkey, mod)), collections.Counter(map(_cellkey, vir))
    shared = set(cm) & set(cv)
    n_both, n_mo, n_vo = len(shared), len(cm) - len(shared), len(cv) - len(shared)
    tot = n_both + n_mo + n_vo
    return dict(
        n_modis=len(mod), n_viirs=len(vir), ratio=len(vir) / max(len(mod), 1),
        med_frp_modis=float(np.median(fm)), med_frp_viirs=float(np.median(fv)),
        p25_frp_modis=float(np.percentile(fm, 25)), p25_frp_viirs=float(np.percentile(fv, 25)),
        p90_frp_modis=float(np.percentile(fm, 90)), p90_frp_viirs=float(np.percentile(fv, 90)),
        frac_lt10_modis=float((fm < 10).mean()), frac_lt10_viirs=float((fv < 10).mean()),
        frac_lt25_viirs=float((fv < 25).mean()),
        mean_frp_modis=float(fm.mean()), mean_frp_viirs=float(fv.mean()),
        cells_both=n_both, cells_modis_only=n_mo, cells_viirs_only=n_vo,
        f_cells_both=n_both / tot, f_cells_modis_only=n_mo / tot, f_cells_viirs_only=n_vo / tot,
        viirs_per_modis_cell=float(np.mean([cv[k] for k in shared])) if shared else 0.0,
        modis_per_cell=len(mod) / max(n_both + n_mo, 1),
        viirs_per_cell=len(vir) / max(n_both + n_vo, 1),
    )


# --------------------------------------------------------------------------- #
PARAMS = ["s_med", "s_sig", "m_a", "m_s50", "m_b", "m_ms", "v_a", "v_s50",
          "v_b", "v_ms", "eta", "k_clump", "k_hot", "s_hot", "q_indep"]

GRID = {
    "s_med":   [4, 6, 8, 10, 13, 17, 22, 28],
    "s_sig":   [0.8, 1.0, 1.2, 1.4, 1.6, 1.9, 2.2],
    "m_s50":   [5, 8, 11, 15, 20, 28, 40, 55, 75],
    "m_b":     [0.3, 0.45, 0.6, 0.8, 1.0, 1.3],
    "v_s50":   [1.2, 1.8, 2.5, 3.5, 5.0],
    "v_b":     [0.5, 0.7, 0.9, 1.2],
    "v_ms":    [0.3, 0.5, 0.7, 0.9, 1.15, 1.4, 1.7],
    # m_ms: MODIS 1 km pixels emitted per detected cluster (large fronts span
    # several pixels, and Terra+Aqua give up to two passes per day).
    "m_ms":    [0.0, 0.05, 0.10, 0.18, 0.28, 0.40, 0.55, 0.75],
    "eta":     [0.35, 0.5, 0.65, 0.8, 1.0, 1.25, 1.6],
    # k_clump: Gamma shape of cell intensity.  Small = strongly clumped fires,
    # large = close to a uniform Poisson field.
    "k_clump": [0.6, 1.2, 2.5, 5.0, 9.0, 16.0, 30.0],
    # k_hot: clumping of the large-fire field (small = a few intense hotspots)
    "k_hot":   [0.02, 0.05, 0.1, 0.2, 0.4, 0.8],
    # s_hot: cluster FRP [MW] at which a fire starts to belong to the hot field
    "s_hot":   [8, 15, 25, 40, 65, 100],
    # q_indep: share of MODIS detections that are NOT co-registered with a VIIRS
    # detection of the same cluster.  Physically this is the overpass-time gap
    # (MODIS Terra 10:30 / Aqua 13:30 vs VIIRS NPP 01:30 / 13:30 local) plus
    # independent QA screening: a fire can be visible to one sensor only.
    "q_indep": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.72],
    "m_a":     [0.97, 0.995],
    "v_a":     [0.97, 0.99],
}


def models(p):
    return (SensorModel(a=p["m_a"], s50=p["m_s50"], b=p["m_b"], mult_slope=p["m_ms"]),
            SensorModel(a=p["v_a"], s50=p["v_s50"], b=p["v_b"], mult_slope=p["v_ms"]))


def simulate_stats(p, rng, n_viirs_target, n_cells):
    """Simulate one global day and return the same statistics as target_stats()."""
    mmod, mvir = models(p)

    # --- probe pass: expected VIIRS pixels per cluster
    S0 = np.exp(rng.normal(math.log(p["s_med"]), p["s_sig"], size=N_PROBE))
    per_cluster_v = float((mvir.p(S0) * mvir.mult(S0)).mean())
    if per_cluster_v <= 0:
        return {k: 0.0 for k in TARGETS}
    n = max(min(int(round(n_viirs_target / per_cluster_v)), 1_500_000), 1000)

    # --- main pass
    S = np.exp(rng.normal(math.log(p["s_med"]), p["s_sig"], size=n))
    pv, pm = mvir.p(S), mmod.p(S)
    mv, mm = mvir.mult(S), mmod.mult(S)
    det_v = rng.random(n) < pv
    det_m = rng.random(n) < pm

    n_v = float(mv[det_v].sum())
    scale = n_viirs_target / max(n_v, 1e-9)          # normalise to the real day
    Sv, Sm = S[det_v], S[det_m]
    frp_v = (Sv / np.maximum(mv[det_v], 1e-6)) * np.exp(rng.normal(0, SIG_P, size=Sv.size))
    frp_m = (p["eta"] * Sm / np.maximum(mm[det_m], 1e-6)) * \
            np.exp(rng.normal(0, SIG_M, size=Sm.size))
    n_m = float(mm[det_m].sum()) * scale

    # --- spatial placement -> cell occupancy
    # Two superposed intensity fields: a diffuse one for the many small
    # agricultural burns, and a strongly clumped one for large fire fronts.
    # Big clusters preferentially belong to the clumped field, which is why
    # MODIS (large fires only) occupies far fewer cells than VIIRS.
    lam_d = rng.gamma(p["k_clump"], 1.0 / p["k_clump"], size=n_cells)
    lam_h = rng.gamma(p["k_hot"], 1.0 / p["k_hot"], size=n_cells)
    cw_d = np.cumsum(lam_d / lam_d.sum())
    cw_h = np.cumsum(lam_h / lam_h.sum())
    hot = rng.random(n) < (1.0 / (1.0 + np.exp(-(np.log(S) - math.log(p["s_hot"])) / 0.6)))
    cid = np.where(hot,
                   np.searchsorted(cw_h, rng.random(n)),
                   np.searchsorted(cw_d, rng.random(n)))

    def expand(cid_det, mult_det, s):
        """Spread a cluster's pixels over cells (mostly its own, sometimes a neighbour)."""
        rep = np.maximum(np.round(mult_det * s).astype(int), 0)
        base = np.repeat(cid_det, rep)
        extra = int(rep.sum() - base.size)
        if extra > 0:
            base = np.concatenate([base, np.repeat(cid_det, 1)[
                rng.integers(0, cid_det.size, size=extra)]])
        return base

    cid_v = expand(cid[det_v], mv[det_v], scale)
    cid_m = expand(cid[det_m], mm[det_m], scale)
    # a share of MODIS detections belong to a different overpass and therefore
    # are not co-registered with the VIIRS detection of the same cluster
    q = p.get("q_indep", 0.0)
    if q > 0 and cid_m.size > 1:
        n_ind = min(int(round(cid_m.size * q)), cid_m.size)
        if n_ind:
            cid_m = np.concatenate([cid_m[n_ind:], np.searchsorted(cw_d, rng.random(n_ind))])
    cnt_v = np.bincount(cid_v, minlength=n_cells) > 0
    cnt_m = np.bincount(cid_m, minlength=n_cells) > 0
    n_both = int((cnt_m & cnt_v).sum())
    n_mo = int((cnt_m & ~cnt_v).sum())
    n_vo = int((~cnt_m & cnt_v).sum())
    tot = max(n_both + n_mo + n_vo, 1)

    return dict(
        n_modis=n_m, n_viirs=n_viirs_target, ratio=n_v / max(n_m, 1e-9),
        med_frp_modis=float(np.median(frp_m)) if frp_m.size else 0.0,
        med_frp_viirs=float(np.median(frp_v)) if frp_v.size else 0.0,
        p25_frp_modis=float(np.percentile(frp_m, 25)) if frp_m.size else 0.0,
        p25_frp_viirs=float(np.percentile(frp_v, 25)) if frp_v.size else 0.0,
        p90_frp_modis=float(np.percentile(frp_m, 90)) if frp_m.size else 0.0,
        p90_frp_viirs=float(np.percentile(frp_v, 90)) if frp_v.size else 0.0,
        frac_lt10_modis=float((frp_m < 10).mean()) if frp_m.size else 0.0,
        frac_lt10_viirs=float((frp_v < 10).mean()) if frp_v.size else 0.0,
        frac_lt25_viirs=float((frp_v < 25).mean()) if frp_v.size else 0.0,
        mean_frp_modis=float(frp_m.mean()) if frp_m.size else 0.0,
        mean_frp_viirs=float(frp_v.mean()) if frp_v.size else 0.0,
        cells_both=n_both, cells_modis_only=n_mo, cells_viirs_only=n_vo,
        f_cells_both=n_both / tot, f_cells_modis_only=n_mo / tot, f_cells_viirs_only=n_vo / tot,
        viirs_per_modis_cell=n_v / max(n_both, 1),
        modis_per_cell=n_m / max(n_mo + n_both, 1),
        viirs_per_cell=n_v / max(n_vo + n_both, 1),
    )


TARGETS = ["n_modis", "ratio", "med_frp_modis", "med_frp_viirs",
           "p25_frp_modis", "p25_frp_viirs", "p90_frp_modis", "p90_frp_viirs",
           "frac_lt10_modis", "frac_lt10_viirs", "frac_lt25_viirs",
           "f_cells_both", "f_cells_modis_only", "f_cells_viirs_only",
           "modis_per_cell", "viirs_per_cell"]

# relative tolerance per statistic
TOL = {"n_modis": 0.10, "ratio": 0.10, "med_frp_modis": 0.12, "med_frp_viirs": 0.12,
       "p25_frp_modis": 0.15, "p25_frp_viirs": 0.15,
       "p90_frp_modis": 0.15, "p90_frp_viirs": 0.15,
       "frac_lt10_modis": 0.12, "frac_lt10_viirs": 0.08, "frac_lt25_viirs": 0.08,
       "f_cells_both": 0.30, "f_cells_modis_only": 0.45, "f_cells_viirs_only": 0.25,
       "modis_per_cell": 0.12, "viirs_per_cell": 0.12}


def loss(sim, real):
    tot = 0.0
    for k in TARGETS:
        r, s = real.get(k, 0.0), sim.get(k, 0.0)
        denom = abs(r) * TOL[k] + 1e-6
        tot += min(((s - r) / denom) ** 2, 100.0)
    return tot


def fit(real, seed=11):
    rng = np.random.default_rng(seed)
    n_cells = real["cells_both"] + real["cells_modis_only"] + real["cells_viirs_only"]
    best = dict(s_med=10.0, s_sig=1.4, m_a=0.97, m_s50=40.0, m_b=0.8, m_ms=0.18,
                v_a=0.99, v_s50=1.6, v_b=0.9, v_ms=0.45, eta=0.65,
                k_clump=9.0, k_hot=0.1, s_hot=25.0, q_indep=0.35)
    args = (rng, real["n_viirs"], n_cells)
    cur = loss(simulate_stats(best, *args), real)
    print(f"  initial loss {cur:.1f}")

    grids = dict(GRID)
    for sweep in range(10):
        improved = False
        for key in PARAMS:
            for v in grids[key]:
                trial = dict(best); trial[key] = v
                l = loss(simulate_stats(trial, *args), real)
                if l < cur - 1e-9:
                    cur, best, improved = l, trial, True
        # local refinement every sweep: bracket each parameter around its optimum
        if True:
            refined = False
            for key in PARAMS:
                v0 = best[key]
                for f in (0.7, 0.85, 1.18, 1.4):
                    v = round(v0 * f, 4)
                    if key in ("m_a", "v_a"):          # probabilities must stay <= 1
                        v = min(max(v, 0.5), 1.0)
                    if key in ("s_med", "m_s50", "v_s50", "m_b", "v_b", "s_sig",
                               "eta", "k_clump", "k_hot", "s_hot", "q_indep",
                               "m_ms", "v_ms"):
                        v = max(v, 0.01)
                    if key == "q_indep":
                        v = min(v, 0.95)
                    trial = dict(best); trial[key] = v
                    l = loss(simulate_stats(trial, *args), real)
                    if l < cur - 1e-9:
                        cur, best, refined, improved = l, trial, True, True
            print(f"  sweep {sweep+1}: loss {cur:.2f}" + ("" if improved else "") +
                  ("" if refined else "  (converged)"))
            if not refined and not improved:
                break
    return best, cur, simulate_stats(best, *args), n_cells


# --------------------------------------------------------------------------- #
def region_weights(rs, cell=CELL):
    """Share of real detections attributable to each fire province."""
    dens = collections.Counter()
    for r in rs:
        dens[(int(math.floor(float(r["LATITUDE"]) / cell)),
              int(math.floor(float(r["LONGITUDE"]) / cell)))] += 1
    reg = collections.Counter()
    for (gi, gj), n in dens.items():
        lat, lon = (gi + 0.5) * cell, (gj + 0.5) * cell
        if not (-60 <= lat <= 80):
            continue
        best, bestf = None, 0.0
        for rg in REGIONS:
            if rg.key == "global_background":
                continue
            f = rg.footprint(lat, lon)
            if f > bestf:
                best, bestf = rg, f
        if best is not None and bestf > 0.05:
            reg[best.key] += n * bestf
        else:
            reg["global_background"] += n
    return reg


# --------------------------------------------------------------------------- #
def main():
    print("reading real FIRMS shapefiles ...")
    mod, vir = load_real()
    dates = sorted({r["ACQ_DATE"] for r in mod + vir})
    print(f"  MODIS {len(mod):,}   VIIRS {len(vir):,}   dates {dates}")
    real = target_stats(mod, vir)

    print("fitting sensor model (coordinate descent) ...")
    params, lval, sim, n_cells = fit(real)

    print("\n%-22s %12s %12s %8s" % ("statistic", "REAL", "MODEL", "err%"))
    for k in TARGETS + ["n_modis", "n_viirs", "mean_frp_modis", "mean_frp_viirs"]:
        r, s = real.get(k, float("nan")), sim.get(k, float("nan"))
        err = 100 * (s - r) / r if r else float("nan")
        print("%-22s %12.4g %12.4g %8.1f" % (k, r, s, err))
    print("\nfitted parameters:")
    for k in PARAMS:
        print(f"  {k:9s} = {params[k]}")

    # ------------------------------------------------ completeness from the fitted model
    mmod, mvir = models(params)
    rng = np.random.default_rng(3)
    S = np.exp(rng.normal(math.log(params["s_med"]), params["s_sig"], size=400_000))
    c_v = float(mvir.p(S).mean())
    c_m = float(mmod.p(S).mean())
    mult_bar = float((mvir.p(S) * mvir.mult(S)).sum() / max(mvir.p(S).sum(), 1e-9))
    # MODIS completeness *conditioned on* VIIRS having detected the cluster
    c_mv = float((mmod.p(S) * mvir.p(S)).sum() / max(mvir.p(S).sum(), 1e-9))
    c_u = float((mmod.p(S) + mvir.p(S) - mmod.p(S) * mvir.p(S)).mean())
    print(f"\ncompleteness:  VIIRS c_v = {c_v:.3f}   MODIS c_m = {c_m:.3f}   "
          f"union c_u = {c_u:.3f}")
    print(f"MODIS completeness given VIIRS  c_m|v = {c_mv:.3f}   "
          f"mean VIIRS multiplicity <m> = {mult_bar:.2f} pixels/cluster")
    mult_m = float((mmod.p(S) * mmod.mult(S)).sum() / max(mmod.p(S).sum(), 1e-9))
    print(f"mean MODIS multiplicity <m_M> = {mult_m:.2f} pixels/cluster")
    print(f"=> N = [ M/{mult_m:.2f} + (V/{mult_bar:.2f})*(1-{c_mv:.3f}/{c_v:.3f}) ] / {c_u:.3f}")
    n_est = ((len(mod) / mult_m) + (len(vir) / mult_bar) * (1 - c_mv / c_v)) / c_u
    n_true_sim = real["n_viirs"] / max(float((mvir.p(S) * mvir.mult(S)).mean()), 1e-9)
    print(f"   harmonised N for the real day = {n_est:,.0f}   "
          f"(simulator ground truth {n_true_sim:,.0f}, error "
          f"{100*(n_est-n_true_sim)/n_true_sim:+.1f}%)")
    print(f"   raw MODIS count would have understated it by "
          f"{n_est/max(len(mod),1):.1f}x; raw VIIRS pixels overstate clusters by "
          f"{len(vir)/max(n_true_sim,1):.1f}x")

    # ------------------------------------------------ data-only completeness estimators
    fv = np.array([float(r["FRP"]) for r in vir])
    fm = np.array([float(r["FRP"]) for r in mod])
    mu_v, sg_v, dv, diag_v = fit_size_distribution(fv, mvir, eta=1.0, per_pixel_split=True)
    mu_m, sg_m, dm, diag_m = fit_size_distribution(fm, mmod, eta=params["eta"],
                                                   per_pixel_split=False)
    print(f"data-only estimators (no simulator):  c_v = {dv:.3f}  c_m = {dm:.3f}   "
          f"[simulator truth {c_v:.3f} / {c_m:.3f}]")
    print(f"   recovered VIIRS cluster-size dist: median {math.exp(mu_v):.1f} MW, "
          f"sigma {sg_v:.2f}   (fit {params['s_med']:.1f} / {params['s_sig']:.2f})")
    print(f"   recovered MODIS cluster-size dist: median {math.exp(mu_m):.1f} MW, "
          f"sigma {sg_m:.2f}   loss_v={diag_v['loss']} loss_m={diag_m['loss']}")

    # ------------------------------------------------ event-level co-registration
    d0 = datetime.date.fromisoformat(min(dates))
    def di(r):
        return (datetime.date.fromisoformat(r["ACQ_DATE"]) - d0).days
    mp = [{"lon": float(r["LONGITUDE"]), "lat": float(r["LATITUDE"]), "doy_index": di(r)} for r in mod]
    vp = [{"lon": float(r["LONGITUDE"]), "lat": float(r["LATITUDE"]), "doy_index": di(r)} for r in vir]
    pairs = spatial_match(mp, vp, radius_km=2.0, day_window=0)
    dist = np.array([p[2] for p in pairs]) if pairs else np.array([0.0])
    fa = np.array([float(mod[i]["FRP"]) for i, _, _ in pairs])
    fb = np.array([float(vir[j]["FRP"]) for _, j, _ in pairs])
    frp_ratio = float(np.median(fa / np.maximum(fb, 1e-3))) if pairs else 1.0
    print(f"\nco-registration (r <= 2 km, same UTC day): {len(pairs):,} pairs = "
          f"{100*len(pairs)/len(mod):.1f}% of MODIS detections")
    print(f"  separation   median {np.median(dist):.2f} km   p90 {np.percentile(dist,90):.2f} km")
    print(f"  FRP ratio    median MODIS/VIIRS = {frp_ratio:.2f} "
          f"(a 1 km MODIS pixel integrates several 375 m VIIRS pixels)")

    # ------------------------------------------------ region weights
    reg_v, reg_m = region_weights(vir), region_weights(mod)
    tot_v = sum(reg_v.values()) or 1.0
    weights = {k: reg_v[k] / tot_v for k in reg_v}
    print("\nfire provinces by real VIIRS density:")
    for k, w in sorted(weights.items(), key=lambda t: -t[1])[:16]:
        print(f"  {w*100:5.2f}%  {BY_KEY[k].name if k in BY_KEY else k}")

    cal = Calibration(
        modis=mmod, viirs=mvir,
        frp_ratio_viirs_to_modis=round(1.0 / frp_ratio, 4),
        match_radius_km=2.0,
        viirs_completeness=round(c_v, 4),
        modis_completeness=round(c_m, 4),
        viirs_multiplicity=round(mult_bar, 3),
        modis_multiplicity=round(mult_m, 3),
        modis_completeness_given_viirs=round(c_mv, 4),
        union_completeness=round(c_u, 4),
        modis_bridge_beta=round(1.0 / max(c_m, 1e-9), 4),
        cluster_s_median=round(params["s_med"], 3),
        cluster_sigma=round(params["s_sig"], 3),
        modis_frp_eta=round(params["eta"], 3),
        provenance={
            "source": "NASA FIRMS: MODIS C6.1 (Terra+Aqua) and Suomi NPP VIIRS C2, global 24 h",
            "snapshot_dates": ", ".join(dates),
            "n_modis": str(len(mod)), "n_viirs": str(len(vir)),
            "fitted_parameters": json.dumps(params),
            "co_registered_pairs": str(len(pairs)),
            "note": "Sensor model fitted by coordinate descent to 13 summary statistics "
                    "of the real snapshot; see pipeline/calibrate_real.py.",
        },
    )
    out = {
        "calibration": cal.to_dict(),
        "fitted_parameters": params,
        "real_statistics": real,
        "model_statistics": sim,
        "fit_loss": round(lval, 3),
        "derived": {
            "viirs_completeness": round(c_v, 4),
            "modis_completeness": round(c_m, 4),
            "modis_completeness_given_viirs": round(c_mv, 4),
            "union_completeness": round(c_u, 4),
            "count_kappa": round((1 - c_mv) / mult_bar, 4),
            "viirs_multiplicity_mean": round(mult_bar, 3),
            "modis_multiplicity_mean": round(mult_m, 3),
            "harmonised_N_for_snapshot": int(round(n_est)),
            "simulator_ground_truth_N": int(round(n_true_sim)),
            "data_only_viirs_completeness": round(float(dv), 4),
            "data_only_modis_completeness": round(float(dm), 4),
            "data_only_recovered_cluster_median_mw": round(float(math.exp(mu_v)), 3),
            "data_only_recovered_cluster_sigma": round(float(sg_v), 3),
            "implied_true_events_viirs_basis": int(round(len(vir) / max(c_v * mult_bar, 1e-9))),
            "implied_true_events_modis_basis": int(round(len(mod) / max(c_m, 1e-9))),

        },
        "region_weights": weights,
        "region_counts_viirs": dict(reg_v),
        "region_counts_modis": dict(reg_m),
        "co_registration": {
            "radius_km": 2.0,
            "pairs": len(pairs),
            "pct_of_modis_matched": round(100 * len(pairs) / len(mod), 2),
            "median_separation_km": round(float(np.median(dist)), 3),
            "p90_separation_km": round(float(np.percentile(dist, 90)), 3),
            "frp_ratio_modis_to_viirs_median": round(frp_ratio, 3),
        },
    }
    with open(os.path.join(ROOT, "data", "calibration.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    print("\nwrote data/calibration.json")
    return out


if __name__ == "__main__":
    main()
