# FireLens

### Harmonisation of MODIS and VIIRS hot spots → one burning-activity calendar
**2026 NASA Space Apps Challenge** · Earth Science + Software · Advanced

Satellites have watched the planet burn for 25 years — but not with one eye.
MODIS (Terra 2000, Aqua 2002) sees fire through 1 km pixels; VIIRS (Suomi NPP 2012,
NOAA-20 2018, NOAA-21 2024) sees it through 375 m pixels. For the same afternoon of
burning, the two sensors report numbers that differ by a factor of five, and every
time a satellite is launched the raw counts jump for reasons that have nothing to do
with fire. **FireLens turns those incompatible detections into a single
sensor-independent measure of burning activity**, and wraps it in a web application
that answers the questions the challenge poses: *when and where has it burned, is
this year unusual, when does the critical window open, and what should responders
expect next?*

---

## The headline result

On a 25-year synthetic record whose true burning is known (but never shown to the
estimator), FireLens' harmonised series recovers the truth to within **0.6 %**
globally, with daily correlation **r = 0.99** — while the obvious alternatives fail:

| estimator | bias | NRMSE | Pearson r |
|---|---:|---:|---:|
| raw MODIS detections | **−60.8 %** | 68 % | 0.951 |
| raw VIIRS detections | **+275.5 %** | 335 % | 0.733 |
| naive MODIS + VIIRS sum | **+151.4 %** | 288 % | 0.474 |
| **FireLens harmonised** | **−0.6 %** | **6.4 %** | **0.992** |

And on the question that motivated the challenge — long-term change — the naive sum
reports a trend of **+10.9 %/yr** that is entirely an artefact of platform launches,
against a true trend of **−0.14 %/yr**; FireLens reports **−0.04 %/yr** (annual
correlation with truth r = 0.993 vs 0.092 for the naive sum). At each of the four
observing-system hand-overs the harmonised series stays within a few points of the
real change while the raw records jump by up to +177 %. Full numbers, per-province
accuracy, outage handling and extreme-season detection are in
[`docs/VALIDATION.md`](docs/VALIDATION.md).

The sensor model behind it is not guessed: it was **fitted to a real NASA FIRMS
24-hour snapshot** (14,217 MODIS + 81,473 VIIRS detections, 14–15 October 2026), and
the application's *Harmonisation lab* runs event-level co-registration on that same
real data in your browser.

---

## Run it

Everything is dependency-free: no build step, no packages, no network at runtime.

**Option A — served (recommended, ~0.8 MB initial payload):**
```bash
cd firelens/app
python3 -m http.server 8080
# open http://localhost:8080
```

**Option B — one file, double-click (no server needed):**
```
app/firelens-standalone.html        # full, 11.6 MB, everything embedded
app/firelens-standalone-lite.html   # 6.9 MB, map uses climatological tiers
```
Built with `python3 tools/build_single_file.py [--lite]`. Works from `file://`
with the network disabled (verified).

**Reproduce the science end to end:**
```bash
python3 pipeline/fetch_firms.py          # download a real FIRMS 24 h snapshot (needs internet)
python3 pipeline/calibrate_real.py       # fit the sensor model to it
python3 pipeline/simulate_record.py      # build the 25-yr record + app payloads
python3 pipeline/validate.py             # score the harmoniser against retained truth
python3 tools/test_app.js                # browser logic vs Python, day by day
python3 tools/compare_implementations.py # JS == Python to 5e-5 events/day
```

---

## What the application does

Seven views, one shared harmonisation engine (identical code paths in Python and
JavaScript, cross-checked to 5×10⁻⁵ events/day):

1. **Overview** — KPIs for the chosen area and period, the raw-vs-harmonised
   record, a GitHub-style burning calendar for the focus year, ranked provinces,
   and an *auto-written operational briefing* (no hand-filled templates).
2. **Burning calendar** — the deliverable itself: a day-of-year × year heatmap on a
   single comparable scale, in absolute / anomaly-z / %-of-normal colouring, with
   critical-period brackets, per-year onset/cessation/length, and day-level
   tooltips that disclose the sensor basis and any data-quality flag.
3. **Trends & steps** — annual series for every estimator with observing-system
   change markers, fitted trends with a verdict column, 12-month rolling means and
   season-phenology trends.
4. **Map** — a dependency-free canvas map (embedded Natural Earth boundaries, no
   tile server): harmonised intensity, per-sensor layers and a sensor-agreement
   layer, over three spatial tiers (0.25° daily for recent months, 1° monthly and
   0.5° yearly climatology for the full record), with rectangle AOI drawing.
5. **Critical periods & early warning** — sustained elevated-burning detection
   against each area's own climatology, an operational status banner (normal /
   watch / elevated / critical) with the next-30-day expectation and the day the
   climatological peak arrives, a province watch list, and an explicit
   data-quality timeline.
6. **Harmonisation lab** — the method, its fitted constants, live sliders that
   re-run the estimator, detection-probability curves, and **event-level
   co-registration of the real NASA FIRMS snapshot** (match rate, separation
   distribution, per-pixel FRP ratio).
7. **Data & export** — drop in your own FIRMS CSVs and the whole product rebuilds
   on them (sensor detected from columns, platform count inferred from the
   `satellite` codes, bridge factor re-measured); export CSV / GeoJSON / Markdown
   briefing / full JSON report.

---

## How it works (short version)

A *true* fire event is a burning cluster of latent size `S` (its total fire
radiative power). Sensor `k` detects it with probability `p_k(S)` and, when it
does, resolves it into `m_k(S)` pixels. So each sensor can be **inverted**:

```
N_MODIS = M / a_M(date)      N_VIIRS = V / a_V(date)
N_harm  = (w_M·N_MODIS + w_V·N_VIIRS) / (w_M + w_V)
```

with `a_k = E[p_k(S)·m_k(S)]` computed **for the satellites actually flying that
day** (probability compounds as `1−(1−p)^(n/n_ref)`, multiplicity grows linearly).
That platform awareness is what deletes the 2002 / 2012 / 2018 / 2024 steps.
Before VIIRS exists, MODIS is rescaled by an empirical **bridge factor β** measured
on the overlap period. And the two inversions are cross-checked against their own
rolling ratio, so a sensor in safe mode is discarded and the day is *flagged as a
gap* rather than reported as a drop in burning — the failure mode an early-warning
product must never have.

Full derivation, the calibration procedure and its residuals, the data model and
the payload encoding are in [`docs/METHOD.md`](docs/METHOD.md).

---

## Repository layout

```
app/                     the web application (no build step, no runtime deps)
  index.html  css/  js/  data/           payloads (*.gz), firelens-standalone*.html
pipeline/
  fetch_firms.py         download a real NASA FIRMS 24 h snapshot
  dbf_shp.py             dependency-free ESRI shapefile reader
  harmonize_core.py      the sensor model + estimator (reference implementation)
  calibrate_real.py      fits the model to the real snapshot (coordinate descent)
  landmask.py            rasterises Natural Earth land into a 0.25° mask
  regions.py             58 fire provinces: footprints + seasonal phenology
  simulate_record.py     builds the 25-year record and the app payloads
  validate.py            scores everything against retained ground truth
tools/
  build_single_file.py   offline single-HTML bundle
  test_app.js            Node tests of the browser logic + payload decoding
  compare_implementations.py   JS vs Python parity check
  uitest.js              headless-Chromium smoke test of every view
docs/
  METHOD.md  VALIDATION.md  screenshots/
data/                    calibration, real snapshot, ground truth, validation
```

## Data provenance & honesty

* **Real NASA data**: the `Harmonisation lab` and the calibration use a genuine
  NASA FIRMS (LANCE) global 24 h archive snapshot — `MODIS_C6_1_Global_24h`
  (Terra+Aqua) and `SUOMI_VIIRS_C2_Global_24h` (Suomi NPP), 14–15 Oct 2026. It is
  shipped with the app and clearly labelled. NASA FIRMS data are free to use.
* **Synthetic long record**: a 25-year global archive cannot ship in a hackathon
  deliverable, so the 2001–2025 daily record is *generated* by a physically
  parameterised simulator whose spatial intensities, seasonal cycles, sensor
  response and absolute count scale are all fitted to the real snapshot above, and
  whose latent truth is retained so the estimator can be scored honestly. The app
  labels this explicitly and offers a one-click path to run the same pipeline on
  your own real FIRMS downloads.
* Country boundaries: Natural Earth 110 m, public domain.
