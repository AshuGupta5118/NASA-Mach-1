/* FireLens — harmonisation engine (browser port of pipeline/harmonize_core.py).
 *
 * The two implementations must stay numerically identical: the Python pipeline
 * builds and validates the record, the browser recomputes the same product live
 * (including on user-imported FIRMS CSVs).  Every constant below comes from
 * data/calibration.json, which was fitted to a real NASA FIRMS 24 h snapshot.
 */
(function (global) {
  'use strict';
  const F = global.FL;

  // ------------------------------------------------------------------ sensor model
  /** p(S) = a / (1 + exp(-(ln S - ln s50)/b))   -- detection probability vs cluster FRP */
  function makeSensor(m) {
    const lnS50 = Math.log(m.s50), b = m.b, a = m.a;
    const slope = m.mult_slope || 0, floor = m.mult_floor || 1, cap = m.mult_cap || 40;
    return {
      raw: m,
      p(S) { return a / (1 + Math.exp(-(Math.log(Math.max(S, 1e-6)) - lnS50) / b)); },
      mult(S) {
        if (slope <= 0) return 1;
        return Math.min(Math.max(1 + slope * Math.sqrt(Math.max(S, 1e-6)), floor), cap);
      },
    };
  }

  /** Map every confidence vocabulary onto one 3-level scale. */
  const CONF_MAP = {
    l: 'low', low: 'low', n: 'nominal', nominal: 'nominal',
    h: 'high', high: 'high', m: 'high', medium: 'high',
  };
  function normaliseConfidence(sensor, raw) {
    const k = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!k) return 'nominal';
    if (CONF_MAP[k]) return CONF_MAP[k];
    const pct = parseFloat(k);                       // MODIS shapefiles: 0-100
    if (isFinite(pct)) {
      if (sensor === 'MODIS') return pct >= 80 ? 'high' : (pct >= 30 ? 'nominal' : 'low');
      return 'nominal';
    }
    return 'nominal';
  }

  // ------------------------------------------------------- observing-system timeline
  const D = s => F.isoToDate(s);
  const MODIS_SATS = [[D('2000-02-24'), 1], [D('2002-07-04'), 2]];   // Terra, +Aqua
  const VIIRS_START = D('2012-01-01');
  const VIIRS_SATS = [[D('2012-01-01'), 1], [D('2018-01-01'), 2], [D('2024-01-01'), 3]];
  const MODIS_REF = 2, VIIRS_REF = 1;
  const SAT_CODES = {
    T: 'MODIS', A: 'MODIS', 1: 'MODIS', 2: 'MODIS',
    N: 'VIIRS', NP: 'VIIRS', 20: 'VIIRS', J1: 'VIIRS', 21: 'VIIRS', J2: 'VIIRS',
  };
  const SAT_RANK = { N: 1, NP: 1, 20: 2, J1: 2, 21: 3, J2: 3 };

  function satellitesOn(family, day) {
    let n = 0;
    for (const [start, k] of (family === 'MODIS' ? MODIS_SATS : VIIRS_SATS)) if (day >= start) n = k;
    return n;
  }
  /** Infer the configuration from the SATELLITE codes actually present in a dataset. */
  function satellitesFromData(sensor, codes) {
    const seen = new Set();
    for (const c of codes) {
      const k = String(c || '').trim().toUpperCase();
      if (SAT_CODES[k] === sensor) seen.add(k);
    }
    if (!seen.size) return satellitesOn(sensor, new Date());
    if (sensor === 'MODIS') return seen.size > 1 ? 2 : 1;
    let r = 1; for (const k of seen) r = Math.max(r, SAT_RANK[k] || 1);
    return r;
  }

  // --------------------------------------------------------------- cluster quadrature
  const ZQ = (() => { const a = new Float64Array(521); for (let i = 0; i < 521; i++) a[i] = -6 + 13 * i / 520; return a; })();
  const ZW = (() => {
    const a = new Float64Array(521); let s = 0;
    for (let i = 0; i < 521; i++) { a[i] = Math.exp(-0.5 * ZQ[i] * ZQ[i]); s += a[i]; }
    for (let i = 0; i < 521; i++) a[i] /= s;
    return a;
  })();

  class Harmonizer {
    constructor(cal) {
      this.cal = cal;
      this.modis = makeSensor(cal.modis);
      this.viirs = makeSensor(cal.viirs);
      this.S = new Float64Array(521);
      for (let i = 0; i < 521; i++) {
        this.S[i] = Math.exp(Math.log(cal.cluster_s_median) + cal.cluster_sigma * ZQ[i]);
      }
      this._cache = new Map();
      this.nModisSats = null;   // null = use the timeline
      this.nViirsSats = null;
      this.bridge = cal.bridge_beta || 1.0;
    }

    /** (a_modis, a_viirs) for a day: expected detections per true burning cluster. */
    amplitudes(day) {
      const nm = this.nModisSats == null ? satellitesOn('MODIS', day) : this.nModisSats;
      const nv = this.nViirsSats == null ? satellitesOn('VIIRS', day) : this.nViirsSats;
      const key = day.getUTCFullYear() * 100 + day.getUTCMonth() + '|' + nm + '|' + nv;
      let v = this._cache.get(key);
      if (v) return v;
      let am = 0, av = 0;
      for (let i = 0; i < 521; i++) {
        const S = this.S[i], w = ZW[i];
        if (nm > 0) {
          const p2 = this.modis.p(S);
          const p = 1 - Math.pow(1 - p2, nm / MODIS_REF);
          am += w * p * (1 + (this.modis.mult(S) - 1) * (nm / MODIS_REF));
        }
        if (nv > 0 && day >= VIIRS_START) {
          const p2 = this.viirs.p(S);
          const p = 1 - Math.pow(1 - p2, nv / VIIRS_REF);
          av += w * p * (1 + (this.viirs.mult(S) - 1) * (nv / VIIRS_REF));
        }
      }
      v = [am, av, nm, nv];
      this._cache.set(key, v);
      return v;
    }

    /** Invert one sensor's count into an estimate of true burning clusters. */
    invert(count, sensor, day) {
      const [am, av] = this.amplitudes(day);
      const a = sensor === 'MODIS' ? am : av;
      return a > 0 ? count / a : NaN;
    }

    /** Fuse both sensors for one day (inverse-variance; VIIRS dominates by design). */
    fuse(m, v, day) {
      const [am, av] = this.amplitudes(day);
      const nm = am > 0 ? m / am : NaN;
      const nv = av > 0 ? v / av : NaN;
      const sm = this.cal.rel_sigma_modis || 0.35, sv = this.cal.rel_sigma_viirs || 0.12;
      const wm = 1 / (sm * sm), wv = 1 / (sv * sv);
      if (isFinite(nm) && isFinite(nv) && m > 0 && v > 0) return (nm * wm + nv * wv) / (wm + wv);
      if (isFinite(nv) && v > 0) return nv;
      if (isFinite(nm)) return nm * this.bridge;
      return 0;
    }

    /**
     * Harmonise a whole daily series with cross-sensor quality control.
     * Mirrors harmonize_core.harmonise_series exactly.
     */
    series(modis, viirs, days) {
      const n = days.length;
      const nm = new Float64Array(n), nv = new Float64Array(n);
      const harm = new Float64Array(n), q = new Uint8Array(n);
      const am = new Float64Array(n), av = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const [a, b] = this.amplitudes(days[i]);
        am[i] = a; av[i] = b;
        nm[i] = a > 0 ? modis[i] / a : NaN;
        nv[i] = b > 0 ? viirs[i] / b : NaN;
      }
      const ratio = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        ratio[i] = (isFinite(nv[i]) && nv[i] > 0 && isFinite(nm[i]) && nm[i] > 0) ? nv[i] / nm[i] : NaN;
      }
      const base = rollingMedian(ratio, 183, 20);
      const sm = this.cal.rel_sigma_modis || 0.35, sv = this.cal.rel_sigma_viirs || 0.12;
      const wm = 1 / (sm * sm), wv = 1 / (sv * sv);
      const QLO = 0.60, QHI = 1.70;
      for (let i = 0; i < n; i++) {
        const hasV = isFinite(nv[i]) && viirs[i] > 0;
        const hasM = isFinite(nm[i]) && modis[i] > 0;
        if (hasV && hasM) {
          const r = isFinite(base[i]) && base[i] > 0 ? ratio[i] / base[i] : 1;
          if (r < QLO) { harm[i] = nm[i]; q[i] = 1; }            // VIIRS collapsed
          else if (r > QHI) { harm[i] = nv[i]; q[i] = 1; }       // MODIS collapsed
          else { harm[i] = (nm[i] * wm + nv[i] * wv) / (wm + wv); q[i] = 0; }
        } else if (hasV) { harm[i] = nv[i]; q[i] = 0; }
        else if (hasM) { harm[i] = nm[i] * this.bridge; q[i] = 2; }
        else { harm[i] = 0; q[i] = 2; }
      }
      // single-sensor days that are climatologically implausible -> data gap
      const doy = new Int16Array(n);
      for (let i = 0; i < n; i++) doy[i] = F.dayOfYear(days[i]);
      const buckets = new Map();
      for (let i = 0; i < n; i++) if (q[i] === 0) {
        const a = buckets.get(doy[i]) || []; a.push(harm[i]); buckets.set(doy[i], a);
      }
      const med = new Map();
      for (const [k, a] of buckets) med.set(k, F.median(a));
      for (let i = 0; i < n; i++) {
        if (q[i] === 2) {
          const m0 = med.get(doy[i]) || 0;
          if (m0 > 0 && harm[i] < 0.35 * m0) q[i] = 3;
        }
      }
      return { n_harm: harm, n_modis: nm, n_viirs: nv, quality: q, ratio, ratio_baseline: base, a_modis: am, a_viirs: av };
    }

    /** Empirical MODIS -> harmonised bridge factor measured on the overlap period. */
    bridgeFactor(modis, viirs, days) {
      let num = 0, den = 0;
      for (let i = 0; i < days.length; i++) {
        const [am, av] = this.amplitudes(days[i]);
        if (am <= 0 || av <= 0 || modis[i] <= 0 || viirs[i] <= 0) continue;
        num += viirs[i] / av; den += modis[i] / am;
      }
      return den > 0 ? num / den : 1;
    }

    // -------------------------------------------------- event-level (imported data)
    /** Cluster FRP from an observed per-pixel VIIRS FRP. */
    invertMultiplicity(frp) {
      let S = Math.max(frp, 1e-6);
      for (let k = 0; k < 40; k++) S = 0.5 * S + 0.5 * Math.max(frp, 1e-6) * this.viirs.mult(S);
      return S;
    }
    /** (c_m|v, <m_V>) from an observed VIIRS FRP sample. */
    completenessGivenViirs(viirsFrps) {
      if (!viirsFrps.length) return [this.cal.modis_completeness_given_viirs, this.cal.viirs_multiplicity];
      let num = 0, den = 0, msum = 0;
      for (const f of viirsFrps) {
        if (!(f > 0)) continue;
        const S = this.invertMultiplicity(f), m = this.viirs.mult(S);
        const w = 1 / m;
        num += this.modis.p(S) * w; den += w; msum += m;
      }
      return den > 0 ? [Math.min(Math.max(num / den, 1e-3), 1), msum / viirsFrps.length]
                     : [this.cal.modis_completeness_given_viirs, this.cal.viirs_multiplicity];
    }

    /**
     * Recover a sensor's completeness from its observed FRP spectrum alone, by
     * fitting the latent log-normal cluster-size distribution.  Port of
     * harmonize_core.fit_size_distribution.
     */
    fitSizeDistribution(frps, sensor, eta, perPixelSplit) {
      const arr = frps.filter(x => x > 0).sort((a, b) => a - b);
      if (arr.length < 50) return null;
      const obs = [pct(arr, 25), pct(arr, 50), pct(arr, 90), fracBelow(arr, 10)];
      const tol = [0.25, 0.20, 0.30, 0.15];
      const lo = Math.max(obs[1] * 0.05, 0.4), hi = Math.max(obs[1] * 8, 20);
      let best = null, bestL = Infinity;
      const NM = 34, NS = 22;
      const fbuf = new Float64Array(521), wbuf = new Float64Array(521), cw = new Float64Array(521);
      for (let a = 0; a < NM; a++) {
        const mu = Math.log(lo) + (Math.log(hi) - Math.log(lo)) * a / (NM - 1);
        for (let b = 0; b < NS; b++) {
          const sg = 0.5 + (2.6 - 0.5) * b / (NS - 1);
          let wsum = 0;
          for (let i = 0; i < 521; i++) {
            const S = Math.exp(mu + sg * ZQ[i]);
            const m = perPixelSplit ? sensor.mult(S) : 1;
            const w = ZW[i] * sensor.p(S) * m;
            fbuf[i] = eta * S / m; wbuf[i] = w; wsum += w;
          }
          if (!(wsum > 0)) continue;
          let acc = 0;
          for (let i = 0; i < 521; i++) { acc += wbuf[i] / wsum; cw[i] = acc; }
          const q = [interp(cw, fbuf, 0.25), interp(cw, fbuf, 0.5), interp(cw, fbuf, 0.9)];
          const f10 = lowerBound(fbuf, 10);
          const stat = [q[0], q[1], q[2], cw[Math.min(f10, 520)]];
          let L = 0;
          for (let i = 0; i < 4; i++) {
            const d = (stat[i] - obs[i]) / (tol[i] * Math.max(obs[i], 1e-3) + 1e-3);
            L += d * d;
          }
          if (L < bestL) { bestL = L; best = [mu, sg]; }
        }
      }
      if (!best) return null;
      const [mu, sg] = best;
      let c = 0;
      for (let i = 0; i < 521; i++) c += ZW[i] * sensor.p(Math.exp(mu + sg * ZQ[i]));
      return { mu, sigma: sg, completeness: Math.min(Math.max(c, 0.02), 1),
               s_median: Math.exp(mu), loss: bestL, observed: obs };
    }

    /**
     * Greedy nearest-neighbour co-registration of two detection lists.
     * pts: [{lon, lat, day}] -> [{i, j, km}]
     */
    spatialMatch(modisPts, viirsPts, radiusKm, dayWindow) {
      radiusKm = radiusKm || this.cal.match_radius_km || 2;
      dayWindow = dayWindow || 0;
      const CELL = Math.max(radiusKm, 0.5) / 111;
      const index = new Map();
      viirsPts.forEach((p, j) => {
        const gi = Math.floor(p.lat / CELL), gj = Math.floor(p.lon / CELL);
        for (let d = -dayWindow; d <= dayWindow; d++) {
          const k = (p.day + d) + '|' + gi + '|' + gj;
          let a = index.get(k); if (!a) { a = []; index.set(k, a); } a.push(j);
        }
      });
      const cand = [];
      modisPts.forEach((p, i) => {
        const gi = Math.floor(p.lat / CELL), gj = Math.floor(p.lon / CELL);
        const cosl = Math.cos(p.lat * Math.PI / 180);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const a = index.get(p.day + '|' + (gi + di) + '|' + (gj + dj));
          if (!a) continue;
          for (const j of a) {
            const q = viirsPts[j];
            const dx = (p.lon - q.lon) * 111 * cosl, dy = (p.lat - q.lat) * 111;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= radiusKm) cand.push([d, i, j]);
          }
        }
      });
      cand.sort((x, y) => x[0] - y[0]);
      const ui = new Set(), uj = new Set(), out = [];
      for (const [d, i, j] of cand) {
        if (ui.has(i) || uj.has(j)) continue;
        ui.add(i); uj.add(j); out.push({ i, j, km: d });
      }
      return out;
    }
  }

  // ------------------------------------------------------------------ helpers
  function rollingMedian(x, half, minValid) {
    const n = x.length, out = new Float64Array(n);
    const tmp = [];
    for (let i = 0; i < n; i++) {
      let lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
      tmp.length = 0;
      for (let k = lo; k < hi; k++) if (isFinite(x[k])) tmp.push(x[k]);
      if (tmp.length < minValid) {
        lo = Math.max(0, i - 365); hi = Math.min(n, i + 366);
        tmp.length = 0;
        for (let k = lo; k < hi; k++) if (isFinite(x[k])) tmp.push(x[k]);
      }
      out[i] = tmp.length ? F.median(tmp) : (isFinite(x[i]) ? x[i] : NaN);
    }
    return out;
  }
  function pct(sorted, p) {
    const pos = (sorted.length - 1) * p / 100;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function fracBelow(sorted, v) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  }
  function interp(xp, fp, x) {           // xp increasing
    let lo = 0, hi = xp.length - 1;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[hi]) return fp[hi];
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
    const t = xp[hi] > xp[lo] ? (x - xp[lo]) / (xp[hi] - xp[lo]) : 0;
    return fp[lo] + (fp[hi] - fp[lo]) * t;
  }
  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  global.FLHarmonize = {
    Harmonizer, makeSensor, normaliseConfidence,
    satellitesOn, satellitesFromData, MODIS_SATS, VIIRS_SATS, VIIRS_START,
    MODIS_REF, VIIRS_REF, SAT_CODES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
