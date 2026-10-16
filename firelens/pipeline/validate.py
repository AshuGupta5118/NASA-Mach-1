"""Validate the harmonisation estimator against the simulator's ground truth.

Run:  python3 pipeline/validate.py

The simulator knows how many fires actually burned (``data/sim_truth.npz``);
the harmoniser only ever sees what the two sensors reported.  This script
recomputes the harmonised series exactly the way ``app/js/harmonize.js`` does and
measures how much of the observing-system artefact is removed.

Writes ``docs/VALIDATION.md`` and ``data/validation.json``.
"""
from __future__ import annotations

import sys, os, json, math, datetime, collections
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from pipeline.harmonize_core import (Calibration, observing_factors, satellites_on,
                                     bridge_factor, harmonise_series, VIIRS_START)
from pipeline.simulate_record import OUTAGES, EXTREMES


def pearson(a, b):
    a = np.asarray(a, float); b = np.asarray(b, float)
    if a.std() < 1e-12 or b.std() < 1e-12:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


def spearman(a, b):
    ra = np.argsort(np.argsort(np.asarray(a, float)))
    rb = np.argsort(np.argsort(np.asarray(b, float)))
    return pearson(ra, rb)


def metrics(est, truth):
    est = np.asarray(est, float); truth = np.asarray(truth, float)
    ok = np.isfinite(est) & np.isfinite(truth)
    est, truth = est[ok], truth[ok]
    if truth.sum() == 0:
        return {}
    bias = float(est.sum() / truth.sum() - 1.0)
    rmse = float(np.sqrt(((est - truth) ** 2).mean()))
    mae = float(np.abs(est - truth).mean())
    return {
        "bias_pct": round(100 * bias, 2),
        "rmse": round(rmse, 2),
        "mae": round(mae, 2),
        "nrmse_pct": round(100 * rmse / max(truth.mean(), 1e-9), 2),
        "pearson_r": round(pearson(est, truth), 4),
        "spearman_rho": round(spearman(est, truth), 4),
        "mean_est": round(float(est.mean()), 2),
        "mean_truth": round(float(truth.mean()), 2),
    }


def harmonised_series(m, v, days, cal, bridge=1.0, qc=True):
    """Thin wrapper so every estimator below uses the shipped production code."""
    kw = {} if qc else {"q_lo": -1.0, "q_hi": 1e9}
    return harmonise_series(m, v, days, cal, bridge, **kw)["n_harm"]


def step_size(series, days, boundary):
    """Relative jump across a platform change, normalised by the local level."""
    idx = {d: i for i, d in enumerate(days)}
    before = [series[idx[d]] for d in days
              if boundary - datetime.timedelta(days=180) <= d < boundary]
    after = [series[idx[d]] for d in days
             if boundary <= d < boundary + datetime.timedelta(days=180)]
    if not before or not after:
        return float("nan")
    b, a = float(np.mean(before)), float(np.mean(after))
    return 100.0 * (a - b) / max(b, 1e-9)


# --------------------------------------------------------------------------- #
def critical_periods(counts, days, doy_of, min_len=7, pct=75.0, gap=3, min_events=25):
    """The same algorithm the app runs (see app/js/analysis.js)."""
    clim = collections.defaultdict(list)
    for i, d in enumerate(days):
        clim[doy_of[i]].append(counts[i])
    thr = {k: float(np.percentile(v, pct)) for k, v in clim.items()}
    flags = np.array([counts[i] >= max(thr[doy_of[i]], 1e-9) for i in range(len(days))])
    out, i, n = [], 0, len(days)
    while i < n:
        if not flags[i]:
            i += 1; continue
        j = i
        while j + 1 < n:
            k, run = j + 1, 0
            while k < n and not flags[k] and run < gap:
                k += 1; run += 1
            if k < n and flags[k]:
                j = k
            else:
                break
        total = float(counts[i:j + 1].sum())
        ndays = int((days[j] - days[i]).days) + 1
        if ndays >= min_len and total >= min_events:
            out.append({"start": days[i].isoformat(), "end": days[j].isoformat(),
                        "days": ndays, "events": round(total, 1)})
        i = j + 1
    return out


def main():
    z = np.load(os.path.join(ROOT, "data", "sim_truth.npz"), allow_pickle=True)
    cal = Calibration.from_dict(
        json.load(open(os.path.join(ROOT, "data", "calibration.json")))["calibration"])
    gm, gv, gt = z["glob_m"], z["glob_v"], z["glob_t"]
    reg_m, reg_v, reg_t = z["reg_m"], z["reg_v"], z["reg_t"]
    keys = [str(k) for k in z["keys"]]
    y0, ndays = int(z["y0"]), int(z["ndays"])
    d0 = datetime.date(y0, 1, 1)
    days = [d0 + datetime.timedelta(days=i) for i in range(ndays)]
    doy = np.array([d.timetuple().tm_yday for d in days])

    print(f"record: {days[0]} .. {days[-1]}  ({ndays:,} days)")
    print(f"totals: MODIS {gm.sum():,}  VIIRS {gv.sum():,}  true {gt.sum():,.0f}")

    # ---- empirical bridge factor from the overlap period
    beta = bridge_factor(gm, gv, days, cal)
    print(f"\nbridge factor beta (overlap-calibrated MODIS -> harmonised) = {beta:.4f}")

    viirs_mask = np.array([d >= VIIRS_START for d in days])

    # ---------------------------------------------------------------- estimators
    est = {
        "raw MODIS count": gm.astype(float),
        "raw VIIRS count": gv.astype(float),
        "naive MODIS+VIIRS sum": (gm + gv).astype(float),
        "harmonised (bridge, no platform correction)": None,
        "harmonised (full)": None,
    }
    est["harmonised (bridge, no platform correction)"] = np.array([
        (gm[i] / 0.4076) if not viirs_mask[i] else (gv[i] / 2.4036) for i in range(ndays)])
    H = harmonise_series(gm, gv, days, cal, beta)
    harm_full = H["n_harm"]
    est["harmonised (full)"] = harm_full
    est["harmonised (no quality control)"] = harmonised_series(gm, gv, days, cal, beta, qc=False)

    print("\n== GLOBAL DAILY SERIES vs GROUND TRUTH ==")
    print("%-46s %8s %8s %8s %8s %8s" % ("estimator", "bias%", "NRMSE%", "MAE", "r", "rho"))
    table = []
    for name, series in est.items():
        if name == "raw VIIRS count":
            m_ = metrics(series[viirs_mask], gt[viirs_mask])
        else:
            m_ = metrics(series, gt)
        table.append((name, m_))
        print("%-46s %8.2f %8.2f %8.1f %8.4f %8.4f" % (
            name, m_.get("bias_pct", float('nan')), m_.get("nrmse_pct", float('nan')),
            m_.get("mae", float('nan')), m_.get("pearson_r", float('nan')),
            m_.get("spearman_rho", float('nan'))))

    # ---------------------------------------------------------------- step removal
    boundaries = [("Aqua joins Terra (MODIS 1->2 sats)", datetime.date(2002, 7, 4)),
                  ("VIIRS operational (MODIS -> MODIS+VIIRS)", datetime.date(2012, 1, 1)),
                  ("NOAA-20 joins VIIRS (1->2 sats)", datetime.date(2018, 1, 1)),
                  ("NOAA-21 joins VIIRS (2->3 sats)", datetime.date(2024, 1, 1))]
    print("\n== CHANGE AT EACH OBSERVING-SYSTEM BOUNDARY (%) ==")
    print("    'TRUTH' is the real change in burning; anything beyond it is an artefact")
    print("%-42s %9s %9s %9s %9s %9s" % ("boundary", "TRUTH", "raw MODIS",
                                          "raw VIIRS", "naive sum", "harmonised"))
    steps = []
    for label, b in boundaries:
        row = [step_size(gt, days, b),
               step_size(gm.astype(float), days, b),
               step_size(gv.astype(float), days, b),
               step_size((gm + gv).astype(float), days, b),
               step_size(harm_full, days, b)]
        steps.append((label, b.isoformat(), row))
        print("%-42s %9.1f %9.1f %9.1f %9.1f %9.1f" % (label, *row))

    # ---------------------------------------------------------------- outage gaps
    print("\n== SENSOR OUTAGE HANDLING ==")
    outage_rows = []
    for sensor, a, b, f in OUTAGES:
        sel = np.array([(a <= d <= b) for d in days])
        win = np.flatnonzero(sel)
        if win.size == 0:
            continue
        lo, hi = max(win[0] - 60, 0), min(win[-1] + 60, ndays)
        base = gt[lo:hi].mean()
        raw = (gm if sensor == "MODIS" else gv)[win].mean()
        harm = harm_full[win].mean()
        truth = gt[win].mean()
        outage_rows.append({"sensor": sensor, "start": a.isoformat(), "end": b.isoformat(),
                            "injected_retention": f,
                            "raw_drop_pct": round(100 * (1 - raw / max(base, 1e-9)), 1),
                            "harmonised_bias_pct": round(100 * (harm / max(truth, 1e-9) - 1), 1)})
        print(f"  {sensor} {a}..{b}: raw {sensor} count falls "
              f"{100*(1-raw/max((gm if sensor=='MODIS' else gv)[lo:hi].mean(),1e-9)):.0f}% "
              f"below its 60-day baseline; harmonised series bias "
              f"{100*(harm/max(truth,1e-9)-1):+.1f}%")

    # ---------------------------------------------------------------- per province
    print("\n== PER-PROVINCE ACCURACY (harmonised, annual totals) ==")
    prov_rows = []
    order = np.argsort(-reg_t.sum(axis=1))[:16]
    for ri in order:
        k = keys[ri]
        # calendar years present in the record
        years = sorted({d.year for d in days})
        ph = harmonised_series(reg_m[ri], reg_v[ri], days, cal, beta)
        tt, hh = [], []
        for y in years:
            sel = np.array([d.year == y for d in days])
            tt.append(reg_t[ri][sel].sum())
            hh.append(ph[sel].sum())
        mm_ = metrics(hh, tt)
        prov_rows.append({"province": k, **mm_})
        print("  %-24s bias %+6.2f%%  r %.4f  rho %.4f" % (
            k, mm_.get("bias_pct", float('nan')), mm_.get("pearson_r", float('nan')),
            mm_.get("spearman_rho", float('nan'))))

    # ---------------------------------------------------- anomaly / critical period
    print("\n== EXTREME-SEASON DETECTION (injected events) ==")
    harm = harm_full
    prov_harm = {}
    # per-province anomaly z-score against day-of-year climatology
    clim = collections.defaultdict(list)
    for i in range(ndays):
        clim[doy[i]].append(harm[i])
    mu = {k: float(np.mean(v)) for k, v in clim.items()}
    sd = {k: float(np.std(v)) + 1e-9 for k, v in clim.items()}
    zz = np.array([(harm[i] - mu[doy[i]]) / sd[doy[i]] for i in range(ndays)])
    cps = critical_periods(harm, days, doy)
    print(f"  {len(cps)} critical periods detected globally (>=75th percentile, "
          f">=7 days, >=25 events)")
    hit = 0
    det_rows = []
    for prov, year, months, mult in EXTREMES:
        if prov not in keys:
            continue
        ri = keys.index(prov)
        sel = np.array([d.year == year and d.month in months for d in days])
        if sel.sum() == 0:
            continue
        # province-level anomaly
        if ri not in prov_harm:
            prov_harm[ri] = harmonised_series(reg_m[ri], reg_v[ri], days, cal, beta)
        ph = prov_harm[ri][sel]
        other = np.array([d.year != year and d.month in months for d in days])
        base = reg_t[ri][other]
        if base.size == 0:
            continue
        z_prov = (ph.mean() - base.mean()) / (base.std() + 1e-9)
        found = z_prov > 1.5
        hit += int(found)
        det_rows.append({"province": prov, "year": year, "months": months,
                         "injected_multiplier": mult, "anomaly_z": round(float(z_prov), 2),
                         "detected": bool(found)})
    print(f"  {hit}/{len(det_rows)} injected extreme seasons recovered at z > 1.5")
    for r in sorted(det_rows, key=lambda x: -x["anomaly_z"])[:12]:
        print(f"    z={r['anomaly_z']:+6.2f}  {r['province']:22s} {r['year']} "
              f"months {r['months']} (x{r['injected_multiplier']})  "
              f"{'DETECTED' if r['detected'] else 'missed'}")

    # ---------------------------------------------------------------- trend check
    print("\n== LONG-TERM TREND (the point of harmonisation) ==")
    years = sorted({d.year for d in days})
    ann_true = np.array([gt[np.array([d.year == y for d in days])].sum() for y in years])
    ann_harm = np.array([harm[np.array([d.year == y for d in days])].sum() for y in years])
    ann_modis = np.array([gm[np.array([d.year == y for d in days])].sum() for y in years])
    ann_naive = np.array([(gm + gv)[np.array([d.year == y for d in days])].sum() for y in years])
    def trend(a, ys):
        sl = np.polyfit(ys, a, 1)[0]
        return 100 * sl / max(a.mean(), 1e-9)
    print(f"  true      : {trend(ann_true, years):+.2f} %/yr")
    print(f"  harmonised: {trend(ann_harm, years):+.2f} %/yr")
    print(f"  raw MODIS : {trend(ann_modis, years):+.2f} %/yr")
    print(f"  naive sum : {trend(ann_naive, years):+.2f} %/yr   <- dominated by the "
          f"2012/2018/2024 platform steps")
    corr_true_harm = pearson(ann_true, ann_harm)
    corr_true_naive = pearson(ann_true, ann_naive)
    print(f"  annual correlation with truth: harmonised r={corr_true_harm:.4f}, "
          f"naive sum r={corr_true_naive:.4f}")

    # ---------------------------------------------------------------- write report
    out = {
        "record": {"start": days[0].isoformat(), "end": days[-1].isoformat(),
                   "days": ndays,
                   "totals": {"modis": int(gm.sum()), "viirs": int(gv.sum()),
                              "true": float(gt.sum())}},
        "bridge_factor": round(beta, 4),
        "estimator_metrics_global": {n: m for n, m in table},
        "steps_pct": [{"boundary": l, "date": d, "truth": r[0],
                       "raw_modis": r[1], "raw_viirs": r[2],
                       "naive_sum": r[3], "harmonised": r[4]} for l, d, r in steps],
        "quality_flag_days": {str(int(k)): int(v) for k, v in
                              collections.Counter(H["quality"].tolist()).items()},
        "outages": outage_rows,
        "provinces": prov_rows,
        "extremes": {"detected": hit, "total": len(det_rows), "rows": det_rows},
        "critical_periods_global": cps[:40],
        "trend_pct_per_year": {"true": trend(ann_true, years),
                               "harmonised": trend(ann_harm, years),
                               "raw_modis": trend(ann_modis, years),
                               "naive_sum": trend(ann_naive, years)},
        "annual": {"years": years,
                   "true": [round(float(x), 1) for x in ann_true],
                   "harmonised": [round(float(x), 1) for x in ann_harm],
                   "raw_modis": [int(x) for x in ann_modis],
                   "raw_viirs": [int(gv[np.array([d.year == y for d in days])].sum())
                                 for y in years],
                   "naive_sum": [int(x) for x in ann_naive]},
        "calibration": cal.to_dict(),
    }
    with open(os.path.join(ROOT, "data", "validation.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=str)
    write_report(out)
    print("\nwrote data/validation.json and docs/VALIDATION.md")


def write_report(v):
    L = []
    A = L.append
    A("# Harmonisation validation")
    A("")
    A(f"Record: **{v['record']['start']} to {v['record']['end']}** "
      f"({v['record']['days']:,} days), global, 0.25&deg; daily.")
    A("")
    A("The simulator retains the latent number of true burning clusters; the "
      "harmoniser only ever sees the two sensors' detections. Every number below "
      "compares a harmonised estimate against that retained truth.")
    A("")
    A("## Headline")
    A("")
    hm = v["estimator_metrics_global"]["harmonised (full)"]
    nm = v["estimator_metrics_global"]["naive MODIS+VIIRS sum"]
    mm = v["estimator_metrics_global"]["raw MODIS count"]
    A(f"- Global bias of the harmonised series: **{hm['bias_pct']:+.2f}%** "
      f"(raw MODIS {mm['bias_pct']:+.1f}%, naive sum {nm['bias_pct']:+.1f}%).")
    A(f"- Normalised RMSE: **{hm['nrmse_pct']:.1f}%** vs {nm['nrmse_pct']:.0f}% for the "
      f"naive sum and {mm['nrmse_pct']:.0f}% for raw MODIS.")
    A(f"- Daily correlation with truth: **r = {hm['pearson_r']:.4f}**, "
      f"rho = {hm['spearman_rho']:.4f}.")
    A(f"- Empirical bridge factor for the pre-VIIRS era: **beta = "
      f"{v['bridge_factor']:.4f}** (1.0 would mean the two inversions already agree).")
    A("")
    A("## Estimator comparison (global daily counts)")
    A("")
    A("| estimator | bias % | NRMSE % | MAE | Pearson r | Spearman rho |")
    A("|---|---:|---:|---:|---:|---:|")
    for name, m in v["estimator_metrics_global"].items():
        A(f"| {name} | {m['bias_pct']:+.2f} | {m['nrmse_pct']:.2f} | {m['mae']:,.0f} | "
          f"{m['pearson_r']:.4f} | {m['spearman_rho']:.4f} |")
    A("")
    A("*Raw VIIRS is scored only from 2012 onwards, when it exists.*")
    A("")
    A("## Artificial steps at observing-system changes")
    A("")
    A("Percentage jump in the 180 days after each platform change relative to the "
      "180 days before. A step here is an artefact of the observing system, not a "
      "change in burning.")
    A("")
    A("| boundary | date | truth | raw MODIS | raw VIIRS | naive sum | **harmonised** |")
    A("|---|---|---:|---:|---:|---:|---:|")
    def fmt(x):
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return "&mdash;"
        return f"{x:+.1f}%"
    for r in v["steps_pct"]:
        A(f"| {r['boundary']} | {r['date']} | {fmt(r['truth'])} | {fmt(r['raw_modis'])} | "
          f"{fmt(r['raw_viirs'])} | {fmt(r['naive_sum'])} | **{fmt(r['harmonised'])}** |")
    A("")
    A("## Sensor outages")
    A("")
    A("Synthetic safe-mode windows were injected into the record. Because the "
      "harmoniser fuses both sensors, a dropout in one is largely absorbed.")
    A("")
    A("| sensor | window | injected retention | harmonised bias during window |")
    A("|---|---|---:|---:|")
    for o in v["outages"]:
        A(f"| {o['sensor']} | {o['start']} .. {o['end']} | {o['injected_retention']:.2f} | "
          f"{o['harmonised_bias_pct']:+.1f}% |")
    A("")
    A("## Per-province accuracy (annual totals)")
    A("")
    A("| province | bias % | Pearson r | Spearman rho |")
    A("|---|---:|---:|---:|")
    for r in v["provinces"]:
        A(f"| {r['province']} | {r['bias_pct']:+.2f} | {r['pearson_r']:.4f} | "
          f"{r['spearman_rho']:.4f} |")
    A("")
    A("## Long-term trend")
    A("")
    A("| series | trend %/yr |")
    A("|---|---:|")
    for k, val in v["trend_pct_per_year"].items():
        A(f"| {k.replace('_',' ')} | {val:+.2f} |")
    A("")
    A("The naive MODIS+VIIRS sum is dominated by the 2012 / 2018 / 2024 platform "
      "steps and therefore reports a trend that is an artefact. The harmonised "
      "series tracks the true trend.")
    A("")
    A("## Extreme-season detection")
    A("")
    A(f"{v['extremes']['detected']} of {v['extremes']['total']} injected extreme fire "
      "seasons were recovered at province level with an anomaly z-score above 1.5.")
    A("")
    A("| province | year | months | injected x | anomaly z | detected |")
    A("|---|---|---|---:|---:|---|")
    for r in sorted(v["extremes"]["rows"], key=lambda x: -x["anomaly_z"]):
        A(f"| {r['province']} | {r['year']} | {','.join(map(str, r['months']))} | "
          f"{r['injected_multiplier']} | {r['anomaly_z']:+.2f} | "
          f"{'yes' if r['detected'] else 'no'} |")
    A("")
    A("## Annual totals")
    A("")
    A("| year | true | harmonised | raw MODIS | raw VIIRS | naive sum |")
    A("|---|---:|---:|---:|---:|---:|")
    a = v["annual"]
    for i, y in enumerate(a["years"]):
        A(f"| {y} | {a['true'][i]:,.0f} | {a['harmonised'][i]:,.0f} | "
          f"{a['raw_modis'][i]:,} | {a['raw_viirs'][i]:,} | {a['naive_sum'][i]:,} |")
    A("")
    A("## Reproduce")
    A("")
    A("```bash")
    A("python3 pipeline/calibrate_real.py    # fit the sensor model to real FIRMS data")
    A("python3 pipeline/simulate_record.py   # build the 25-year record + app payloads")
    A("python3 pipeline/validate.py          # this report")
    A("```")
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    with open(os.path.join(ROOT, "docs", "VALIDATION.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
