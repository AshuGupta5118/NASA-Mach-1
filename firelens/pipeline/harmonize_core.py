"""Harmonisation core: sensor model, calibration, and the FRP-inversion estimator.

THE PROBLEM
-----------
MODIS (Terra 2000-, Aqua 2002-) and VIIRS (Suomi NPP 2012-, NOAA-20 2018-,
NOAA-21 2023-) do not measure the same thing:

  * pixel size   MODIS 1 km (I-band 1 km, M-band 750 m)  vs  VIIRS 375 m
  * overpass     MODIS ~10:30 / ~13:30 local              vs  VIIRS ~01:30 / ~13:30
  * confidence   MODIS {low, nominal, high}               vs  VIIRS {low, nominal, medium, high}
  * sensitivity  MODIS misses small / short-lived fires that VIIRS detects

Counting detections per sensor therefore produces a record with a huge artificial
step at 2012 (and again at 2018), which is *not* a change in burning.

THE MODEL
---------
A "true" fire event is a burning cluster with latent size  S  (its total fire
radiative power, MW).  Sensor k detects it with probability p_k(S) and, if it is
detected, VIIRS emits m(S) >= 1 sub-pixel detections while MODIS emits 1.

    p_k(S) = a_k / (1 + exp(-(ln S - ln s_k) / b_k))

Observed counts for a cell/day:

    M_obs ~ Poisson( N * E[p_m(S)] )
    V_obs ~ Poisson( N * E[p_v(S) * m(S)] )

where N is the (unobservable) number of true events.

THE ESTIMATOR (what makes the record comparable)
------------------------------------------------
For every *observed* VIIRS detection we can compute the probability that MODIS
would also have seen that fire.  Averaging it gives MODIS's completeness against
the fires VIIRS reveals:

    c_m|v = mean_i [ p_m(S_i) ]        S_i = FRP of observed VIIRS detection i

Each VIIRS detection therefore stands for  1 / c_m|v  MODIS-equivalent units, and
the two sensors can be summed without double counting the overlap:

    N_union = M_obs + V_obs * (1 - c_m|v) / <m>

Finally VIIRS itself is incomplete for the smallest fires.  That residual is
recovered by deconvolving the observed VIIRS FRP spectrum against p_v(S):

    N_harm = N_union / c_v

N_harm is sensor-independent, is expressed in *true events*, and is directly
comparable across 2001-2025.  For the MODIS-only era we calibrate a single
bridge factor  beta = mean(N_harm) / mean(M_obs)  over the overlap period and
apply it to pre-2012 MODIS counts, which is what removes the artificial step.
"""
from __future__ import annotations

import math
import collections
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Sequence, Tuple

import numpy as np

# --------------------------------------------------------------------------- #
#  Sensor metadata
# --------------------------------------------------------------------------- #
SENSORS = {
    "MODIS": {
        "pixel_m": 1000.0,
        "platforms": ["Terra", "Aqua"],
        "first_full_year": 2001,
        "end_year": 2025,
        "confidence_scale": ["low", "nominal", "high"],
        "band": "4 um (band 21/22)",
        "colour": "#ff8a3d",
    },
    "VIIRS": {
        "pixel_m": 375.0,
        "platforms": ["Suomi NPP", "NOAA-20", "NOAA-21"],
        "first_full_year": 2012,
        "end_year": None,
        "confidence_scale": ["low", "nominal", "medium", "high"],
        "band": "I4 3.74 um",
        "colour": "#39d0ff",
    },
}

#: Unified confidence vocabulary.  VIIRS 'medium' has no MODIS analogue; it is
#: folded into 'high' so that the two records share one scale.  Source: FIRMS
#: user guide (VIIRS 375 m 'medium' ~ MODIS 'high' in false-alarm behaviour).
CONFIDENCE_MAP = {
    ("MODIS", "l"): "low", ("MODIS", "low"): "low",
    ("MODIS", "n"): "nominal", ("MODIS", "nominal"): "nominal",
    ("MODIS", "h"): "high", ("MODIS", "high"): "high",
    ("VIIRS", "l"): "low", ("VIIRS", "low"): "low",
    ("VIIRS", "n"): "nominal", ("VIIRS", "nominal"): "nominal",
    ("VIIRS", "m"): "high", ("VIIRS", "medium"): "high",
    ("VIIRS", "h"): "high", ("VIIRS", "high"): "high",
}

#: MODIS shapefiles deliver CONFIDENCE as a 0-100 percentage; CSVs deliver a
#: letter.  Normalise both onto the unified vocabulary.
def normalise_confidence(sensor: str, raw) -> str:
    key = str(raw).strip().lower()
    if key in ("", "none"):
        return "nominal"
    direct = CONFIDENCE_MAP.get((sensor, key))
    if direct:
        return direct
    try:                                     # numeric MODIS percentage
        pct = float(key)
    except ValueError:
        return "nominal"
    if sensor == "MODIS":
        return "high" if pct >= 80 else ("nominal" if pct >= 30 else "low")
    return "nominal"


def unify_confidence(conf: str) -> str:
    """Collapse to the 3-level scale shared by both sensors."""
    return {"medium": "high"}.get(conf, conf)


# --------------------------------------------------------------------------- #
#  Detection / multiplicity model
# --------------------------------------------------------------------------- #
@dataclass
class SensorModel:
    """Logistic detection probability  p(S) = a / (1 + exp(-(ln S - ln s50)/b))."""
    a: float = 0.99          # asymptotic completeness for very large fires
    s50: float = 30.0        # FRP [MW] at 50 % detection
    b: float = 0.55          # width in ln(FRP)
    mult_slope: float = 0.0  # only used by VIIRS
    mult_floor: float = 1.0
    mult_cap: float = 40.0

    def p(self, S):
        S = np.asarray(S, dtype=float)
        S = np.maximum(S, 1e-6)
        return self.a / (1.0 + np.exp(-(np.log(S) - math.log(self.s50)) / self.b))

    def mult(self, S):
        """Number of 375 m detections produced by one burning cluster of size S."""
        if self.mult_slope <= 0:
            return np.ones_like(np.asarray(S, dtype=float))
        S = np.maximum(np.asarray(S, dtype=float), 1e-6)
        return np.clip(1.0 + self.mult_slope * np.sqrt(S), self.mult_floor, self.mult_cap)


@dataclass
class Calibration:
    """Everything the harmoniser needs to run, serialisable to JSON."""
    modis: SensorModel = field(default_factory=lambda: SensorModel(
        a=0.995, s50=15.0, b=0.8))
    viirs: SensorModel = field(default_factory=lambda: SensorModel(
        a=0.99, s50=2.5, b=0.9, mult_slope=0.45))
    #: VIIRS -> MODIS radiometric scale factor for per-pixel FRP
    frp_ratio_viirs_to_modis: float = 0.31
    #: co-registration search radius used for event-level matching
    match_radius_km: float = 2.0
    #: P(sensor detects a randomly drawn true cluster)
    viirs_completeness: float = 0.90
    modis_completeness: float = 0.30
    #: mean number of detections per *detected cluster* for each sensor.
    #: VIIRS resolves one cluster into several 375 m pixels; a large MODIS fire
    #: front spans several 1 km pixels and Terra+Aqua give two passes per day.
    viirs_multiplicity: float = 3.0
    modis_multiplicity: float = 2.7
    #: P(MODIS detects | VIIRS detected) -- the overlap term
    modis_completeness_given_viirs: float = 0.19
    #: P(at least one sensor detects a true cluster)
    union_completeness: float = 0.82
    #: MODIS -> harmonised bridge factor for the pre-VIIRS era (1 / c_m)
    modis_bridge_beta: float = 6.5
    #: assumed relative uncertainty of each sensor's inversion, used for the
    #: inverse-variance combination.  MODIS is far more sensitive to detection-
    #: model error because it only sees the top ~15 % of the size distribution.
    rel_sigma_modis: float = 0.35
    rel_sigma_viirs: float = 0.12
    #: fitted latent cluster-size distribution
    cluster_s_median: float = 12.0
    cluster_sigma: float = 1.2
    modis_frp_eta: float = 0.70
    provenance: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Calibration":
        d = dict(d)
        d["modis"] = SensorModel(**d["modis"])
        d["viirs"] = SensorModel(**d["viirs"])
        return cls(**d)


# --------------------------------------------------------------------------- #
#  Data-only estimators (no simulator required)
# --------------------------------------------------------------------------- #
_Z = np.linspace(-6.0, 7.0, 521)          # quadrature nodes in ln S
_ZW = np.exp(-0.5 * _Z * _Z); _ZW /= _ZW.sum()


def _observed_spectrum(mu, sigma, sensor, eta, per_pixel_split):
    """Expected *observed* FRP distribution implied by a latent LogNormal(mu,sigma).

    Returns (frp_nodes, detection_weight_nodes).  A cluster of size S produces
    ``mult(S)`` detections, each reporting ``eta * S / mult(S)`` if
    ``per_pixel_split`` else ``eta * S``.
    """
    S = np.exp(mu + sigma * _Z)
    m = sensor.mult(S) if per_pixel_split else np.ones_like(S)
    # _ZW is the log-normal density factor: the nodes are uniform in ln S, so the
    # standard-normal weight must be applied or the tail dominates everything.
    w = _ZW * sensor.p(S) * m
    return eta * S / np.maximum(m, 1e-9), w


def fit_size_distribution(frp_obs, sensor, eta=1.0, per_pixel_split=True,
                          mus=None, sigmas=None):
    """Recover the latent cluster-size distribution from an observed FRP spectrum.

    Observed detections are size-biased by ``p(S) * mult(S)``.  We search
    (mu, sigma) of a log-normal so that the *implied* observed spectrum matches
    the real one on four robust statistics (p25, median, p90, P(FRP < 10)).

    Returns ``(mu, sigma, completeness, diagnostics)`` where completeness is
    ``E_S[p(S)]`` under the recovered distribution -- i.e. the fraction of true
    burning events this sensor actually reports.
    """
    frp = np.asarray([f for f in frp_obs if f and f > 0], dtype=float)
    if frp.size < 50:
        return math.log(sensor.s50), 1.2, 1.0, {"n": int(frp.size), "ok": False}
    obs = np.array([np.percentile(frp, 25), np.median(frp),
                    np.percentile(frp, 90), float((frp < 10).mean())])
    tol = np.array([0.25, 0.20, 0.30, 0.15])

    if mus is None:
        mus = np.log(np.geomspace(max(obs[1] * 0.05, 0.4), max(obs[1] * 8, 20.0), 34))
    if sigmas is None:
        sigmas = np.linspace(0.5, 2.6, 22)

    best, bl = None, np.inf
    for mu in mus:
        for sg in sigmas:
            f, w = _observed_spectrum(mu, sg, sensor, eta, per_pixel_split)
            if w.sum() <= 0:
                continue
            cw = np.cumsum(w) / w.sum()
            q = np.interp([0.25, 0.5, 0.9], cw, f)
            stat = np.array([q[0], q[1], q[2],
                             float(cw[min(int(np.searchsorted(f, 10.0)), cw.size - 1)])])
            l = float((((stat - obs) / (tol * np.maximum(obs, 1e-3) + 1e-3)) ** 2).sum())
            if l < bl:
                bl, best = l, (float(mu), float(sg))
    if best is None:
        return math.log(sensor.s50), 1.2, 1.0, {"n": int(frp.size), "ok": False}
    mu, sg = best
    S = np.exp(mu + sg * _Z)
    c = float((_ZW * sensor.p(S)).sum())
    return mu, sg, min(max(c, 0.02), 1.0), {
        "n": int(frp.size), "loss": round(bl, 3), "ok": True,
        "s_median": round(float(math.exp(mu)), 3), "sigma": round(sg, 3),
        "observed_stats": [round(float(x), 3) for x in obs],
    }


def completeness_from_spectrum(frp_obs, sensor, eta=1.0, per_pixel_split=True):
    """Convenience wrapper returning just the completeness."""
    return fit_size_distribution(frp_obs, sensor, eta, per_pixel_split)[2]


def cluster_size_distribution(cal: "Calibration") -> Tuple[np.ndarray, np.ndarray]:
    """Quadrature nodes + weights for the fitted latent cluster-size distribution."""
    S = np.exp(math.log(cal.cluster_s_median) + cal.cluster_sigma * _Z)
    return S, _ZW / _ZW.sum()


# --------------------------------------------------------------------------- #
#  Observing-system timeline
# --------------------------------------------------------------------------- #
# Adding a satellite does not change how much fire there is, but it multiplies the
# number of chances to see each fire.  Everything below is therefore expressed in
# *number of contributing satellites*, referenced to the configuration the
# calibration was fitted on (Terra+Aqua MODIS; Suomi NPP VIIRS only -- which is
# exactly what the FIRMS "Global 24 h" archive files contain).
import datetime as _dt

MODIS_SATS = [(_dt.date(2000, 2, 24), 1),      # Terra
              (_dt.date(2002, 7, 4), 2)]       # + Aqua
VIIRS_START = _dt.date(2012, 1, 1)
VIIRS_SATS = [(_dt.date(2012, 1, 1), 1),       # Suomi NPP
              (_dt.date(2018, 1, 1), 2),       # + NOAA-20 (J1)
              (_dt.date(2024, 1, 1), 3)]       # + NOAA-21 (J2)
MODIS_REF_SATS = 2
VIIRS_REF_SATS = 1

#: FIRMS SATELLITE field values -> family / platform
SAT_CODES = {"T": ("MODIS", "Terra"), "A": ("MODIS", "Aqua"),
             "1": ("MODIS", "Terra"), "2": ("MODIS", "Aqua"),
             "N": ("VIIRS", "Suomi NPP"), "NP": ("VIIRS", "Suomi NPP"),
             "20": ("VIIRS", "NOAA-20"), "J1": ("VIIRS", "NOAA-20"),
             "21": ("VIIRS", "NOAA-21"), "J2": ("VIIRS", "NOAA-21")}


def satellites_on(family, day):
    """How many satellites of `family` were contributing on `day`."""
    n = 0
    for start, k in (MODIS_SATS if family == "MODIS" else VIIRS_SATS):
        if day >= start:
            n = k
    return n


def satellites_from_data(sensor, codes) -> int:
    """Infer the observing configuration from the SATELLITE values in a dataset.

    This matters: a VIIRS extract that contains only Suomi NPP must not be
    inverted with the three-satellite amplitude, or burning will be
    under-reported by ~3x.
    """
    fam = {"N", "NP", "20", "J1", "21", "J2"} if sensor == "VIIRS" else {"T", "A", "1", "2"}
    seen = {str(c).strip().upper() for c in codes if str(c).strip()}
    seen = {c for c in seen if c in fam}
    if not seen:
        return satellites_on(sensor, _dt.date.today())
    if sensor == "MODIS":
        return 2 if len(seen) > 1 else 1
    order = {"N": 1, "NP": 1, "20": 2, "J1": 2, "21": 3, "J2": 3}
    return max(order[c] for c in seen)


_FAC_CACHE: Dict[Tuple[int, int], Tuple[float, ...]] = {}


def observing_factors(cal: "Calibration", day, n_modis_sats=None,
                      n_viirs_sats=None) -> Tuple[float, float, float, float]:
    """Platform-aware detection amplitudes for one calendar day.

    Returns ``(a_m, a_v, rel_sigma_m, rel_sigma_v)`` where

        a_k = E_S[ p_k(S) * m_k(S) ]

    is the expected number of *detections* one true burning cluster produces with
    the satellites flying on that day.  Adding a platform raises the per-day
    detection probability as  1-(1-p1)^n  and the multiplicity roughly linearly,
    which is why the raw records jump at 2003, 2012, 2018 and 2024 without any
    change in actual burning.
    """
    nm = n_modis_sats if n_modis_sats is not None else satellites_on("MODIS", day)
    nv = n_viirs_sats if n_viirs_sats is not None else satellites_on("VIIRS", day)
    # The cache key must include the resolved satellite counts: a platform can
    # join part-way through a month (Aqua on 2002-07-04), and keying on
    # (year, month) alone would reuse the wrong amplitude for the rest of it.
    key = (day.year, day.month, nm, nv)
    if key in _FAC_CACHE:
        return _FAC_CACHE[key]
    S, w = cluster_size_distribution(cal)

    def uplift(x, n, n_ref):
        """Scale a per-cluster quantity from the reference to an n-satellite config.

        Detection probability compounds as independent chances; multiplicity
        (pixels per cluster) grows roughly linearly with the number of overpasses.
        """
        r = n / max(n_ref, 1e-9)
        return 1.0 - (1.0 - np.clip(x, 0.0, 1.0)) ** r

    if nm > 0:
        pm = uplift(cal.modis.p(S), nm, MODIS_REF_SATS)
        mm = 1.0 + (cal.modis.mult(S) - 1.0) * (nm / MODIS_REF_SATS)
        a_m = float((w * pm * mm).sum())
    else:
        a_m = 0.0
    if nv > 0 and day >= VIIRS_START:
        pv = uplift(cal.viirs.p(S), nv, VIIRS_REF_SATS)
        mv = 1.0 + (cal.viirs.mult(S) - 1.0) * (nv / VIIRS_REF_SATS)
        a_v = float((w * pv * mv).sum())
    else:
        a_v = 0.0
    out = (a_m, a_v, cal.rel_sigma_modis, cal.rel_sigma_viirs)
    _FAC_CACHE[key] = out
    return out


# --------------------------------------------------------------------------- #
#  The harmoniser
# --------------------------------------------------------------------------- #
def invert_multiplicity(frp_pixel, sensor: SensorModel, iters: int = 40):
    """Observed VIIRS FRP is *per 375 m pixel*; recover the cluster FRP.

    ``f = S / m(S)``  =>  solve for S by damped fixed-point iteration.
    """
    f = np.maximum(np.asarray(frp_pixel, dtype=float), 1e-6)
    S = f.copy()
    for _ in range(iters):
        S = 0.5 * S + 0.5 * f * sensor.mult(S)
    return S


def modis_completeness_given_viirs(viirs_frp, cal: "Calibration") -> Tuple[float, float]:
    """(c_m|v, <m_V>) estimated from an observed VIIRS FRP spectrum.

    c_m|v : probability MODIS also detects a cluster that VIIRS detected.
    <m_V> : mean number of VIIRS pixels per detected cluster.
    Both are cluster-weighted (a cluster contributes m pixels).
    """
    f = np.asarray([x for x in viirs_frp if x and x > 0], dtype=float)
    if f.size == 0:
        return cal.modis_completeness_given_viirs, cal.viirs_multiplicity
    S = invert_multiplicity(f, cal.viirs)
    m = cal.viirs.mult(S)
    w = 1.0 / np.maximum(m, 1e-6)
    c = float((cal.modis.p(S) * w).sum() / w.sum())
    return min(max(c, 1e-3), 1.0), float(m.mean())


def harmonise(modis_n: float, viirs_n: float, day, cal: "Calibration",
              bridge: float = 1.0, n_modis_sats=None, n_viirs_sats=None) -> Dict[str, float]:
    """Harmonise one cell/day (or one AOI/day) into a single burning-activity count.

    Both sensors are inverted through their own platform-aware detection
    amplitude, so each yields an estimate of the *same* physical quantity -- the
    number of true burning clusters:

        N_modis = M / a_m(day)        N_viirs = V / a_v(day)

    These are combined by inverse-variance weighting.  VIIRS carries far more
    weight because it is ~5x more complete, so its inversion is much less
    sensitive to detection-model error.

    Before VIIRS exists, MODIS is the only witness.  Its inversion is then
    rescaled by an empirical *bridge factor* beta measured over the 2012+ overlap
    period, which is what removes the artificial step at the sensor handover
    without trusting the absolute MODIS detection model.
    """
    a_m, a_v, sm, sv = observing_factors(cal, day, n_modis_sats, n_viirs_sats)
    n_m = modis_n / a_m if a_m > 0 else float("nan")
    if a_v > 0 and viirs_n >= 0:
        n_v = viirs_n / a_v
        wm, wv = 1.0 / (sm * sm), 1.0 / (sv * sv)
        if np.isfinite(n_m) and modis_n > 0:
            n = (n_m * wm + n_v * wv) / (wm + wv)
            src = "both"
        else:
            n, src = n_v, "viirs"
        return {"n_harm": n, "n_modis_basis": n_m, "n_viirs_basis": n_v,
                "source": src, "a_modis": a_m, "a_viirs": a_v, "bridge": 1.0}
    n = (n_m * bridge) if np.isfinite(n_m) else 0.0
    return {"n_harm": n, "n_modis_basis": n_m, "n_viirs_basis": float("nan"),
            "source": "modis+bridge", "a_modis": a_m, "a_viirs": a_v, "bridge": bridge}


def bridge_factor(modis_series, viirs_series, days, cal: "Calibration") -> float:
    """Empirical MODIS -> harmonised bridge, measured on the overlap period.

        beta = sum(N_viirs) / sum(N_modis)   over days where both sensors flew

    A value of 1.0 means the two inversions already agree; any departure is
    residual detection-model bias and is transferred to the MODIS-only era.
    """
    num = den = 0.0
    for m, v, d in zip(modis_series, viirs_series, days):
        a_m, a_v, _, _ = observing_factors(cal, d)
        if a_v <= 0 or a_m <= 0 or v <= 0 or m <= 0:
            continue
        num += v / a_v
        den += m / a_m
    return float(num / den) if den > 0 else 1.0


def _rolling_median(x, half=183, min_valid=20):
    """Centred rolling median that skips NaNs (sensor-ratio baseline)."""
    x = np.asarray(x, float)
    n = x.size
    out = np.full(n, np.nan)
    valid = np.isfinite(x)
    for i in range(n):
        lo, hi = max(i - half, 0), min(i + half + 1, n)
        w = x[lo:hi][valid[lo:hi]]
        if w.size < min_valid:
            lo, hi = max(i - 365, 0), min(i + 366, n)
            w = x[lo:hi][valid[lo:hi]]
        if w.size:
            out[i] = float(np.median(w))
        elif valid[i]:
            out[i] = x[i]
    return out


def harmonise_series(modis, viirs, days, cal: "Calibration", bridge: float = 1.0,
                     n_modis_sats=None, n_viirs_sats=None,
                     q_lo: float = 0.60, q_hi: float = 1.70):
    """Harmonise a whole daily series, with cross-sensor data-quality detection.

    Returns a dict of aligned arrays:

      ``n_harm``    harmonised burning-activity estimate (true events/day)
      ``n_modis``   MODIS-only inversion  M / a_m
      ``n_viirs``   VIIRS-only inversion  V / a_v   (NaN before VIIRS exists)
      ``quality``   0 = both sensors agree, 1 = one sensor degraded (the other
                    carried the estimate), 2 = single-sensor period, estimate is
                    climatologically implausible and should be treated as a gap
      ``ratio``     n_viirs / n_modis, and its rolling baseline

    The cross-check matters operationally.  When a satellite goes into safe mode
    its counts collapse, and a naive fusion silently reports a drop in burning --
    exactly the false all-clear an early-warning product must never give.  Here
    the two independent inversions are compared: if they disagree by more than a
    factor band around their own rolling baseline, the outlier is discarded and
    the day is flagged.
    """
    modis = np.asarray(modis, float); viirs = np.asarray(viirs, float)
    n = len(days)
    a_m = np.zeros(n); a_v = np.zeros(n)
    for i, d in enumerate(days):
        am, av, _, _ = observing_factors(cal, d, n_modis_sats, n_viirs_sats)
        a_m[i], a_v[i] = am, av
    n_m = np.where(a_m > 0, modis / np.maximum(a_m, 1e-12), np.nan)
    n_v = np.where(a_v > 0, viirs / np.maximum(a_v, 1e-12), np.nan)

    sm, sv = cal.rel_sigma_modis, cal.rel_sigma_viirs
    wm, wv = 1.0 / sm ** 2, 1.0 / sv ** 2

    with np.errstate(invalid="ignore", divide="ignore"):
        q = np.where((n_v > 0) & (n_m > 0), n_v / np.maximum(n_m, 1e-9), np.nan)
    q0 = _rolling_median(q)
    with np.errstate(invalid="ignore", divide="ignore"):
        qr = q / q0

    n_harm = np.zeros(n)
    quality = np.zeros(n, dtype=np.int8)
    for i in range(n):
        has_v = np.isfinite(n_v[i]) and viirs[i] > 0
        has_m = np.isfinite(n_m[i]) and modis[i] > 0
        if has_v and has_m:
            r = qr[i] if np.isfinite(qr[i]) else 1.0
            if r < q_lo:            # VIIRS collapsed -> trust MODIS
                n_harm[i] = n_m[i]; quality[i] = 1
            elif r > q_hi:          # MODIS collapsed -> trust VIIRS
                n_harm[i] = n_v[i]; quality[i] = 1
            else:
                n_harm[i] = (n_m[i] * wm + n_v[i] * wv) / (wm + wv); quality[i] = 0
        elif has_v:
            n_harm[i] = n_v[i]; quality[i] = 0
        elif has_m:
            n_harm[i] = n_m[i] * bridge; quality[i] = 2
        else:
            n_harm[i] = 0.0; quality[i] = 2

    # single-sensor days that are climatologically implausible -> gap flag
    doy = np.array([d.timetuple().tm_yday for d in days])
    both = quality == 0
    if both.sum() > 30:
        clim = collections.defaultdict(list)
        for i in np.flatnonzero(both):
            clim[doy[i]].append(n_harm[i])
        med = {k: float(np.median(v)) for k, v in clim.items()}
        for i in range(n):
            if quality[i] == 2 and med.get(doy[i], 0) > 0:
                if n_harm[i] < 0.35 * med[doy[i]]:
                    quality[i] = 3
    return {"n_harm": n_harm, "n_modis": n_m, "n_viirs": n_v,
            "quality": quality, "ratio": q, "ratio_baseline": q0,
            "a_modis": a_m, "a_viirs": a_v}


def frp_bias_correct(viirs_frp: float, cal: "Calibration") -> float:
    """Put a VIIRS per-pixel FRP on the MODIS radiometric scale."""
    return viirs_frp * cal.frp_ratio_viirs_to_modis


# --------------------------------------------------------------------------- #
#  Spatial co-registration (event level)
# --------------------------------------------------------------------------- #
def spatial_match(modis_pts: List[dict], viirs_pts: List[dict],
                  radius_km: float = 1.5, day_window: int = 0) -> List[Tuple[int, int, float]]:
    """Greedy nearest-neighbour matching of MODIS to VIIRS detections.

    Points are dicts with keys ``lon``, ``lat``, ``doy_index`` (integer day).
    Returns a list of (modis_index, viirs_index, distance_km); each detection is
    used at most once.
    """
    if not modis_pts or not viirs_pts:
        return []
    import collections
    CELL = max(radius_km, 0.5) / 111.0
    index: Dict[Tuple[int, int, int], List[int]] = collections.defaultdict(list)
    for j, p in enumerate(viirs_pts):
        gi = int(math.floor(p["lat"] / CELL))
        gj = int(math.floor(p["lon"] / CELL))
        for d in range(-day_window, day_window + 1):
            index[(p["doy_index"] + d, gi, gj)].append(j)

    cand = []
    for i, p in enumerate(modis_pts):
        gi = int(math.floor(p["lat"] / CELL))
        gj = int(math.floor(p["lon"] / CELL))
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for j in index.get((p["doy_index"], gi + di, gj + dj), ()):
                    q = viirs_pts[j]
                    dlat = (p["lat"] - q["lat"]) * 111.0
                    dlon = (p["lon"] - q["lon"]) * 111.0 * math.cos(math.radians(p["lat"]))
                    d = math.hypot(dlat, dlon)
                    if d <= radius_km:
                        cand.append((d, i, j))
    cand.sort()
    used_i, used_j, out = set(), set(), []
    for d, i, j in cand:
        if i in used_i or j in used_j:
            continue
        used_i.add(i); used_j.add(j)
        out.append((i, j, d))
    return out
