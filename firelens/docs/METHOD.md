# Method

How FireLens converts two incompatible satellite detection records into one
comparable measure of burning activity. This document is the technical record;
[`VALIDATION.md`](VALIDATION.md) is the evidence, and the application's
*Harmonisation lab* view exposes the same numbers interactively.

---

## 1. Why the records cannot be compared directly

| property | MODIS C6.1 | VIIRS C2 (375 m) |
|---|---|---|
| platforms | Terra (2000‑), Aqua (2002‑) | Suomi NPP (2012‑), NOAA‑20 (2018‑), NOAA‑21 (2024‑) |
| hot-spot pixel | ~1 km (expands to ~4 km at scan edge) | 375 m (nearly constant across swath) |
| local overpasses | ~10:30 / ~13:30 + night | ~13:30 / ~01:30 |
| confidence vocabulary | `low / nominal / high` (or a 0–100 score in shapefiles) | `low / nominal / medium / high` |
| what one detection means | a 1 km pixel whose thermal anomaly passed QA | a 375 m pixel; one fire yields several |

Consequences measured on a single real day (FIRMS global 24 h, 2026‑10‑14/15):

* **81,473 VIIRS vs 14,217 MODIS detections** for the same burning → ratio **5.73×**.
* Median FRP **5.0 MW** (VIIRS) vs **13.9 MW** (MODIS): a 1 km pixel integrates the
  energy of several 375 m pixels (matched-pair median ratio **3.19×**).
* Co-registration (nearest neighbour, r ≤ 2 km, same UTC day) matches **50.8 %** of
  MODIS detections; median separation **0.40 km**. The **44,407 VIIRS detections in
  MODIS-empty cells** (80 % of them below 10 MW) are the fires MODIS structurally
  cannot see.
* Launching a satellite changes the counts without changing the fire: the record
  therefore contains steps at 2002 (Aqua), 2012 (VIIRS), 2018 (NOAA‑20), 2024
  (NOAA‑21) that any naive long-term analysis mistakes for trends.

Any product that adds the two records, or splices MODIS-only years onto VIIRS
years, inherits all of this. Harmonisation has to *model* the sensors.

---

## 2. The generative sensor model

A true fire event is a **burning cluster** with latent total fire radiative power
`S` [MW]. Clusters are log-normally distributed:

```
S ~ LogNormal(ln s_med, sigma)          fitted: s_med = 10.0 MW, sigma = 1.40
```

Sensor `k` detects the cluster with a logistic probability in ln S and, if
detected, reports `m_k(S)` pixels:

```
p_k(S) = a_k / (1 + exp(-(ln S - ln s50_k) / b_k))
m_V(S) = clip(1 + 0.45·sqrt(S), 1, 40)          VIIRS resolves a front into 375 m pixels
m_M(S) = clip(1 + 0.212·sqrt(S), 1, 40)         MODIS pixels + Terra/Aqua double-look
```

An observed pixel's FRP is only its share of the cluster: VIIRS
`f ≈ S/m_V(S)`, MODIS `f ≈ eta·S/m_M(S)` with `eta = 0.77` (partial pixel fill).

**Fitted values** (coordinate descent against 15 summary statistics of the real
snapshot; see `pipeline/calibrate_real.py`):

| parameter | value |
|---|---|
| MODIS `s50`, `b`, `a` | 75 MW, 0.80, 0.995 |
| VIIRS `s50`, `b`, `a` | 0.95 MW, 1.20, 0.97 |
| VIIRS multiplicity slope | 0.45 |
| MODIS multiplicity slope | 0.212 |
| cluster FRP median / sigma | 10.0 MW / 1.40 |
| MODIS partial-fill `eta` | 0.77 |
| spatial burnable-cell fraction `p_hot` | 0.085 (tuned to the real occupied-cell count, +0.9 %) |

Reproduction of the real day (model vs measurement):

| statistic | real | model | error |
|---|---:|---:|---:|
| MODIS detections | 14,217 | 13,790 | −3.0 % |
| VIIRS / MODIS ratio | 5.73 | 5.90 | +2.9 % |
| median MODIS FRP | 13.86 | 14.32 | +3.3 % |
| median VIIRS FRP | 5.02 | 4.75 | −5.3 % |
| P(FRP<10) MODIS / VIIRS | 0.34 / 0.78 | 0.34 / 0.77 | −0.3 % / −1.8 % |
| occupied 0.25° cells / day | 8,552 | 8,626 | +0.9 % |

Known residual model error (reported honestly): the MODIS FRP upper tail
(p90 −23 %) and the MODIS-only-cell share (0.054 vs 0.106) are under-reproduced,
because same-day overpass differences between Terra/Aqua and NPP are modelled as a
single independent-observation term.

---

## 3. Platform-aware detection amplitudes

Adding a satellite multiplies the *chances* of seeing each cluster, so with `n`
satellites of a family against the reference configuration `n_ref` (MODIS: Terra+Aqua
= 2; VIIRS: NPP = 1, which is what the FIRMS 24 h files contain):

```
p_k(S; n) = 1 - (1 - p_k(S; n_ref))^(n/n_ref)
m_k(S; n) = 1 + (m_k(S; n_ref) - 1)·(n/n_ref)
a_k(n)    = E_S[ p_k(S;n) · m_k(S;n) ]
```

`a_k` is the expected number of detections per true cluster on that day — the
quantity that makes a count invertible. Examples:

| date | MODIS sats | VIIRS sats | a_M | a_V |
|---|---|---|---:|---:|
| 2001‑06 | 1 | 0 | 0.166 | – |
| 2005‑06 | 2 | 0 | 0.408 | – |
| 2015‑06 | 2 | 1 | 0.408 | 2.404 |
| 2019‑06 | 2 | 2 | 0.408 | 4.490 |
| 2025‑06 | 2 | 3 | 0.408 | 6.390 |

(A real bug this design caught: caching `a_k` by calendar month is wrong when a
platform joins mid-month — Aqua on 2002‑07‑04. The cache key must include the
resolved satellite count.)

---

## 4. The estimator

For a cell/day, AOI/day, or whole record:

```
N_MODIS = M / a_M(date)                       N_VIIRS = V / a_V(date)
N_harm  = ( w_M·N_MODIS + w_V·N_VIIRS ) / ( w_M + w_V )      w = 1/sigma^2
```

with `sigma_M = 0.35`, `sigma_V = 0.12`: MODIS' inversion is far more sensitive to
detection-model error because MODIS samples only the top ~15 % of the size
distribution, so VIIRS carries ~90 % of the weight where both exist. Each term is
already an unbiased estimate of the *same* quantity (true clusters), which is why
they can be averaged at all.

**Pre-VIIRS bridge.** Where `a_V = 0`, MODIS alone is inverted and rescaled by an
empirical bridge

```
beta = sum(N_VIIRS) / sum(N_MODIS)   over the overlap period   (measured: 0.9952)
```

so the hand-over is tied to the data, not to the absolute MODIS sensitivity model.

**Cross-sensor quality control.** The two inversions are compared against their
own rolling median ratio `q0` (±183 days). If `N_VIIRS/N_MODIS / q0 < 0.60` the VIIRS
stream has collapsed (safe mode, outage) and MODIS carries the day; `> 1.70` does the
reverse; otherwise they are fused. Single-sensor days whose value falls below 35 %
of their day-of-year climatology median are flagged as **gaps**, not reported as low
burning. On injected 25–75 % sensor dropouts this keeps the harmonised bias inside
±0.2 % (and honestly reports −76 % for the one 2002 window where MODIS is the only
sensor and is itself degraded).

**Confidence harmonisation.** VIIRS `medium` has no MODIS analogue and is folded
into `high`; MODIS numeric confidences (shapefiles) map to the same three levels
(≥80 high, ≥30 nominal, else low). Imported CSVs with letter codes use the same
table.

---

## 5. From detections to a burning-activity calendar

* **Climatology** — per day-of-year, smoothed over a ±3-day circular window, with
  mean, sd and percentiles. Everything "unusual" is measured against *the area's own*
  climatology, never against a global threshold.
* **Anomaly** — z-score against that climatology; the calendar's anomaly colour mode.
* **Critical burning period** — a run of days at/above the 75th percentile of the
  day-of-year climatology, bridging gaps ≤ 3 days, lasting ≥ 7 days and accumulating
  ≥ min-events. Reported with duration, events, expected-from-climatology, anomaly %
  and peak day; cross-year periods are clipped per calendar row.
* **Season phenology** — onset/cessation at the 10 %/90 % points of the cumulative
  season, giving season length and its trend.
* **Early warning** — the last 14 days vs climatology (Poisson-style z and ratio)
  combined with the *forward* climatology: expected events over the next 30 days and
  the day the climatological peak arrives. Levels: normal / watch / elevated /
  critical / suppressed.
* **Narrative** — deterministic assembly of the above into prose, including sensor
  basis and data-quality statements, so a briefing is reproducible and auditable.

---

## 6. Data model and payload encoding

The browser must stay fast and offline, so the record is shipped in tiers and all
grids are sparse, delta- and varint-encoded, then gzipped (base64 only inside the
single-file bundle):

| tier | resolution | content | size (gz) |
|---|---|---|---:|
| `core.json.gz` | – | metadata, calibration, 58 provinces, exact daily province + global series 2001–2025, province intensity raster | 0.76 MB |
| `grid_monthly.bin.gz` | 2.0° | 300 monthly slices | 2.08 MB |
| `grid_yearly.bin.gz` | 1.0° | 25 yearly slices | 0.75 MB |
| `grid_recent.bin.gz` | 0.25° | last 183 days, daily | 3.54 MB |
| `events.json.gz` | point | **real** FIRMS 24 h snapshot, 95,690 detections | 1.34 MB |

Grid totals are verified to equal the daily series exactly (they are the same
Poisson draws re-binned). An arbitrary area of interest is decomposed into fire
provinces using each province's fitted intensity footprint, so an AOI drawn as a
rectangle inherits an exact daily series for the full 25 years.

The simulator's latent truth (`data/sim_truth.npz`) is **never** read by the
application; the app recomputes everything from the two sensors' counts.

---

## 7. What is real and what is generated

| component | source |
|---|---|
| Sensor response, FRP spectra, spatial density, count scale | **real**: fitted to a NASA FIRMS global 24 h snapshot (14,217 MODIS + 81,473 VIIRS, 14–15 Oct 2026) |
| Province geometry & seasonal phenology | expert-delineated fire regimes; relative intensities fitted to the real snapshot |
| Interannual variability | approximate ONI-like index with per-province sensitivity + dated extreme seasons from the published record (2010 Russia, 2015 Indonesia, 2019–20 Australia, 2023 Canada, …) |
| 2001–2025 daily record | **generated** by the simulator above; latent truth retained for validation |
| Sensor outages | synthetic safe-mode windows, injected to exercise gap handling; labelled as such in-app |
| Country boundaries | Natural Earth 110 m (public domain) |

The application states this on every relevant surface (dataset badge, provenance
tab, exported reports) and provides the import path so the identical pipeline can
be run on a genuine multi-year FIRMS archive.
