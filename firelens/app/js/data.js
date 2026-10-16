/* FireLens — data layer.
 *
 * Loads the payload tiers, decodes the compact binary grids, and answers the two
 * questions every view asks:
 *
 *   1. "give me the daily MODIS / VIIRS / harmonised series for this AOI"
 *   2. "give me the spatial distribution for this AOI and this period"
 *
 * Data tiers (see pipeline/simulate_record.py):
 *   core.json.gz        always loaded: metadata, calibration, province list,
 *                       exact daily province series 2001-2025, province raster,
 *                       2.0deg monthly and 1.0deg yearly grids
 *   grid_recent.bin.gz  loaded on demand: exact daily 0.25deg cells, last 6 months
 *   events.json.gz      loaded on demand: a REAL NASA FIRMS 24 h snapshot, as
 *                       individual detections, for the event-level lab
 */
(function (global) {
  'use strict';
  const F = global.FL;

  const EMBEDDED = global.__FL_EMBEDDED__ || null;

  async function loadJSON(name, path) {
    if (EMBEDDED && EMBEDDED[name]) {
      const bytes = F.b64ToBytes(EMBEDDED[name]);
      const raw = (bytes[0] === 0x1f && bytes[1] === 0x8b) ? await F.gunzipBytes(bytes) : bytes;
      return JSON.parse(new TextDecoder().decode(raw));
    }
    return F.fetchGzJSON(path);
  }
  async function loadBytes(name, path) {
    if (EMBEDDED && EMBEDDED[name]) {
      const bytes = F.b64ToBytes(EMBEDDED[name]);
      return (bytes[0] === 0x1f && bytes[1] === 0x8b) ? F.gunzipBytes(bytes) : bytes;
    }
    return F.fetchGzBytes(path);
  }

  class Store {
    constructor() {
      this.ready = false;
      this.provinceCache = new Map();     // key -> harmonised series result
      this.aoiCache = new Map();
      this.raster = null;
      this.grids = {};
    }

    async load(base, onProgress) {
      base = base || 'data/';
      const say = m => { if (onProgress) onProgress(m); };
      say('Loading core record…');
      const core = await loadJSON('core', base + 'core.json.gz');
      this.core = core;
      this.meta = core.meta;
      this.cal = core.calibration;
      this.regions = core.regions;
      this.regionByKey = new Map(core.regions.map(r => [r.key, r]));

      this.y0 = core.meta.y0; this.y1 = core.meta.y1;
      this.ndays = core.meta.ndays;
      this.start = F.isoToDate(core.meta.start);
      this.days = new Array(this.ndays);
      for (let i = 0; i < this.ndays; i++) this.days[i] = F.addDays(this.start, i);
      this.dayIndex = new Map();
      for (let i = 0; i < this.ndays; i++) this.dayIndex.set(F.dateToISO(this.days[i]), i);

      // ---- daily series
      say('Decoding daily series…');
      this.globalModis = F.readVarintSeries(core.series.global.modis);
      this.globalViirs = F.readVarintSeries(core.series.global.viirs);
      this.globalTruth = F.readFloat32Array(core.series.global.truth);
      this.keys = core.series.keys;
      this.provModis = core.series.regions.modis.map(F.readVarintSeries);
      this.provViirs = core.series.regions.viirs.map(F.readVarintSeries);
      this.keyIndex = new Map(this.keys.map((k, i) => [k, i]));

      // ---- harmoniser + bridge factor measured on the overlap period
      say('Harmonising…');
      this.H = new global.FLHarmonize.Harmonizer(this.cal);
      const bridge = this.H.bridgeFactor(this.globalModis, this.globalViirs, this.days);
      this.H.bridge = bridge;
      this.bridgeFactor = bridge;
      this.globalHarm = this.H.series(this.globalModis, this.globalViirs, this.days);

      // ---- province raster (for arbitrary AOIs)
      say('Decoding province raster…');
      const pr = core.province_raster;
      this.rasterScale = pr.scale;
      this.rasterNlat = pr.nlat; this.rasterNlon = pr.nlon;
      this.raster = new Map();
      for (const k in pr.data) {
        this.raster.set(k, F.readProvinceRaster(F.b64ToBytes(pr.data[k]), pr.scale));
      }

      // ---- spatial grids (separate gzipped binary files)
      say('Decoding climatological grids…');
      const gf = core.grid_files;
      this.gridFiles = gf;
      this.grids.monthly = F.readSparseGrid(await loadBytes('grid_monthly', base + gf.monthly.file));
      this.grids.yearly = F.readSparseGrid(await loadBytes('grid_yearly', base + gf.yearly.file));
      this.monthlyMeta = gf.monthly;
      this.yearlyMeta = gf.yearly;
      this.recentMeta = null;
      this.grids.recent = null;

      this.ready = true;
      return this;
    }

    /** Load the fine daily grid (only needed by the Map view). */
    async loadRecent(base, onProgress) {
      if (this.grids.recent) return this.grids.recent;
      base = base || 'data/';
      if (onProgress) onProgress('Loading recent daily grid…');
      const bytes = await loadBytes('recent', base + this.gridFiles.recent.file);
      this.grids.recent = F.readSparseGrid(bytes);
      this.recentMeta = this.gridFiles.recent;
      return this.grids.recent;
    }

    async loadEvents(base, onProgress) {
      if (this.events) return this.events;
      base = base || 'data/';
      if (onProgress) onProgress('Loading real FIRMS snapshot…');
      const ev = await loadJSON('events', base + 'events.json.gz');
      // attach an integer day index for co-registration
      const d0 = F.isoToDate(ev.meta.dates[0]);
      const wrap = (arr, sensor) => arr.map(r => ({
        lon: r[0], lat: r[1],
        day: Math.round((F.isoToDate(fullDate(r[2], d0.getUTCFullYear())) - d0) / F.MS_DAY),
        time: r[3], frp: r[4], bright: r[5], conf: r[6], daynight: r[7],
        sat: r[8], scan: r[9], track: r[10], sensor,
      }));
      function fullDate(mmdd, yearHint) {
        const mm = parseInt(mmdd.slice(0, 2), 10), dd = parseInt(mmdd.slice(2), 10);
        let y = yearHint;
        if (mm === 1 && yearHint === 2026 && ev.meta.dates.some(d => d.endsWith('-12-31'))) y = yearHint;
        return y + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
      }
      this.events = {
        meta: ev.meta,
        modis: wrap(ev.modis, 'MODIS'),
        viirs: wrap(ev.viirs, 'VIIRS'),
      };
      return this.events;
    }

    // ------------------------------------------------------------------ series
    harmonised(key) {
      if (key === '__globe__') return this.globalHarm;
      if (this.provinceCache.has(key)) return this.provinceCache.get(key);
      const i = this.keyIndex.get(key);
      if (i === undefined) return this.globalHarm;
      const r = this.H.series(this.provModis[i], this.provViirs[i], this.days);
      this.provinceCache.set(key, r);
      return r;
    }

    /**
     * Daily series for an AOI.
     *   globe    -> the global series
     *   province -> that province's series
     *   bbox     -> area-weighted sum of the provinces it covers, where the weight
     *               of each province is the share of its fitted intensity footprint
     *               that falls inside the box.  Exact for province-aligned AOIs.
     */
    aoiSeries(aoi) {
      const ck = aoiKey(aoi);
      if (this.aoiCache.has(ck)) return this.aoiCache.get(ck);
      let out;
      if (aoi.type === 'globe') {
        out = { modis: this.globalModis, viirs: this.globalViirs,
                harm: this.globalHarm.n_harm, quality: this.globalHarm.quality,
                n_modis_basis: this.globalHarm.n_modis, n_viirs_basis: this.globalHarm.n_viirs,
                weights: { '__globe__': 1 }, label: 'Whole planet' };
      } else if (aoi.type === 'province') {
        const i = this.keyIndex.get(aoi.key);
        const h = this.harmonised(aoi.key);
        const r = this.regionByKey.get(aoi.key);
        out = { modis: this.provModis[i], viirs: this.provViirs[i],
                harm: h.n_harm, quality: h.quality,
                n_modis_basis: h.n_modis, n_viirs_basis: h.n_viirs,
                weights: { [aoi.key]: 1 }, label: r ? r.name : aoi.key };
      } else {
        const w = this.aoiWeights(aoi);
        const n = this.ndays;
        const modis = new Float64Array(n), viirs = new Float64Array(n), harm = new Float64Array(n);
        const qual = new Uint8Array(n);
        let covered = 0;
        for (const k in w.fractions) {
          const f = w.fractions[k];
          if (f <= 0) continue;
          covered += f;
          const i = this.keyIndex.get(k);
          if (i === undefined) continue;
          const h = this.harmonised(k);
          const m = this.provModis[i], v = this.provViirs[i];
          for (let d = 0; d < n; d++) {
            modis[d] += m[d] * f; viirs[d] += v[d] * f; harm[d] += h.n_harm[d] * f;
            if (h.quality[d] > qual[d]) qual[d] = h.quality[d];
          }
        }
        out = { modis, viirs, harm, quality: qual, weights: w.fractions,
                coverage: covered, label: w.label || 'Custom area' };
      }
      this.aoiCache.set(ck, out);
      return out;
    }

    /** Share of each province's intensity footprint inside a bounding box. */
    aoiWeights(aoi) {
      const nlon = this.rasterNlon, nlat = this.rasterNlat;
      const cell = this.meta.grid.cell, latMin = this.meta.grid.lat_min, lonMin = this.meta.grid.lon_min;
      let W = aoi.w, S = aoi.s, E = aoi.e, N = aoi.n;
      if (E < W) E += 360;
      const fractions = {};
      const touched = [];
      for (const [k, r] of this.raster) {
        let sum = 0;
        const cells = r.cells, share = r.share;
        for (let t = 0; t < cells.length; t++) {
          const gi = (cells[t] / nlon) | 0, gj = cells[t] % nlon;
          const lat = latMin + (gi + 0.5) * cell;
          let lon = lonMin + (gj + 0.5) * cell;
          if (lon > 180) lon -= 360;
          if (lat < S || lat > N) continue;
          let lo = lon; if (E > 180 && lo < W - 180) lo += 360;
          if (lo < W || lo > E) continue;
          sum += share[t];
        }
        if (sum > 1e-6) { fractions[k] = sum; touched.push([k, sum]); }
      }
      touched.sort((a, b) => b[1] - a[1]);
      const label = touched.length
        ? (touched[0][1] > 0.85 ? this.regionByKey.get(touched[0][0]).name
                                : 'Custom area (' + touched.length + ' provinces)')
        : 'Custom area';
      return { fractions, label, top: touched.slice(0, 6) };
    }

    // ------------------------------------------------------------------- grids
    /** Which spatial tier can answer a request for [d0, d1]? */
    gridTierFor(d0, d1) {
      const R = this.gridFiles.recent;
      const rs = R.start_day, re = rs + R.slices;
      const i0 = this.dayIndex.get(F.dateToISO(d0)), i1 = this.dayIndex.get(F.dateToISO(d1));
      if (this.grids.recent && i0 >= rs && i1 < re) return 'daily';
      if (sameMonth(d0, d1)) return 'monthly';
      if (sameYear(d0, d1)) return 'yearly';
      return 'yearly';
    }

    monthIndex(d) { return (d.getUTCFullYear() - this.y0) * 12 + d.getUTCMonth(); }

    /**
     * Aggregate grid slices covering [d0, d1] into one layer.
     * Returns {cell, nlat, nlon, idx, modis, viirs, slicesUsed, tier}.
     */
    aggregateGrid(d0, d1) {
      const tier = this.gridTierFor(d0, d1);
      let slices = [], meta;
      if (tier === 'daily') {
        meta = this.gridFiles.recent;
        const rs = this.gridFiles.recent.start_day;
        const i0 = this.dayIndex.get(F.dateToISO(d0)), i1 = this.dayIndex.get(F.dateToISO(d1));
        for (let i = i0; i <= i1; i++) { const s = this.grids.recent[i - rs]; if (s) slices.push(s); }
      } else if (tier === 'monthly') {
        meta = this.gridFiles.monthly;
        const m0 = this.monthIndex(d0), m1 = this.monthIndex(d1);
        for (let m = m0; m <= m1; m++) if (this.grids.monthly[m]) slices.push(this.grids.monthly[m]);
      } else {
        meta = this.gridFiles.yearly;
        for (let y = d0.getUTCFullYear(); y <= d1.getUTCFullYear(); y++) {
          const s = this.grids.yearly[y - this.y0]; if (s) slices.push(s);
        }
      }
      const acc = new Map();
      for (const s of slices) {
        for (let k = 0; k < s.idx.length; k++) {
          const c = s.idx[k];
          const e = acc.get(c);
          if (e) { e[0] += s.modis[k]; e[1] += s.viirs[k]; }
          else acc.set(c, [s.modis[k], s.viirs[k]]);
        }
      }
      const n = acc.size;
      const idx = new Int32Array(n), mm = new Float64Array(n), vv = new Float64Array(n);
      let t = 0;
      for (const [c, v] of acc) { idx[t] = c; mm[t] = v[0]; vv[t] = v[1]; t++; }
      return { cell: meta.cell, nlat: meta.nlat, nlon: meta.nlon,
               lat_min: meta.lat_min === undefined ? this.meta.grid.lat_min : meta.lat_min,
               lon_min: meta.lon_min === undefined ? this.meta.grid.lon_min : meta.lon_min,
               idx, modis: mm, viirs: vv, slicesUsed: slices.length, tier };
    }

    cellLatLon(c, nlon, cell, latMin, lonMin) {
      const gi = (c / nlon) | 0, gj = c % nlon;
      let lon = lonMin + (gj + 0.5) * cell;
      if (lon > 180) lon -= 360;
      return [latMin + (gi + 0.5) * cell, lon];
    }

    /** Slice a series to a date range -> {days, values...} */
    range(d0, d1) {
      const i0 = Math.max(0, this.dayIndex.get(F.dateToISO(d0)) || 0);
      const i1 = Math.min(this.ndays - 1, this.dayIndex.get(F.dateToISO(d1)) || (this.ndays - 1));
      return [i0, i1];
    }

    /** Import a user dataset and replace the record (see js/import.js). */
    replaceSeries(days, modis, viirs, meta) {
      this.days = days; this.ndays = days.length;
      this.start = days[0];
      this.dayIndex = new Map(); days.forEach((d, i) => this.dayIndex.set(F.dateToISO(d), i));
      this.globalModis = modis; this.globalViirs = viirs;
      this.provinceCache.clear(); this.aoiCache.clear();
      this.H = new global.FLHarmonize.Harmonizer(this.cal);
      this.H.bridge = this.H.bridgeFactor(modis, viirs, days);
      this.bridgeFactor = this.H.bridge;
      this.globalHarm = this.H.series(modis, viirs, days);
      this.keys = []; this.provModis = []; this.provViirs = [];
      this.keyIndex = new Map();
      this.grids = { monthly: null, yearly: null, recent: null };
      this.imported = meta;
      this.y0 = days[0].getUTCFullYear();
      this.y1 = days[days.length - 1].getUTCFullYear();
    }
  }

  function aoiKey(aoi) {
    if (aoi.type === 'globe') return 'globe';
    if (aoi.type === 'province') return 'p:' + aoi.key;
    return 'b:' + [aoi.w, aoi.s, aoi.e, aoi.n].map(x => x.toFixed(2)).join(',');
  }
  function sameMonth(a, b) {
    return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  }
  function sameYear(a, b) { return a.getUTCFullYear() === b.getUTCFullYear(); }

  // ------------------------------------------------------------- preset AOIs
  function presetAOIs(store) {
    const out = [{ key: '__globe__', name: 'Whole planet', type: 'globe', group: 'Global' }];
    const groups = {
      'afr_': 'Africa', 'bra_': 'South America', 'bol_': 'South America',
      'ven_': 'South America', 'arg_': 'South America', 'chi_': 'South America',
      'peru': 'South America', 'guiana': 'South America',
      'ind_': 'South & SE Asia', 'se_asia': 'South & SE Asia', 'sumatra': 'South & SE Asia',
      'borneo': 'South & SE Asia', 'java': 'South & SE Asia', 'philippines': 'South & SE Asia',
      'png': 'Oceania', 'aus_': 'Oceania', 'nz': 'Oceania',
      'china': 'East & Central Asia', 'mongolia': 'East & Central Asia',
      'siberia': 'Boreal', 'russ_': 'Boreal', 'kazakh': 'Boreal',
      'canada': 'Boreal', 'alaska': 'Boreal', 'europe_north': 'Boreal',
      'us_': 'North America', 'mexico': 'North America', 'caribbean': 'North America',
      'med_': 'Mediterranean & W. Asia', 'middle_east': 'Mediterranean & W. Asia',
      'iran': 'Mediterranean & W. Asia', 'uk_': 'Mediterranean & W. Asia',
      'himalaya': 'South & SE Asia',
    };
    for (const r of store.regions) {
      if (r.key === 'global_background') continue;
      let g = 'Other';
      for (const pre in groups) if (r.key.startsWith(pre)) { g = groups[pre]; break; }
      out.push({ key: r.key, name: r.name, type: 'province', group: g,
                 country: r.country, bbox: r.bbox, driver: r.driver });
    }
    return out;
  }

  global.FLStore = { Store, presetAOIs, aoiKey };
})(typeof window !== 'undefined' ? window : globalThis);
