/* FireLens — analysis layer: climatology, anomalies, critical periods,
 * early warning and the automatic narrative.
 *
 * Everything here works on a plain daily series plus its dates, so the same code
 * runs on the bundled record and on a user-imported FIRMS archive.
 */
(function (global) {
  'use strict';
  const F = global.FL;

  // ------------------------------------------------------------------ climatology
  /**
   * Day-of-year climatology with a smoothing window, so a single noisy day does
   * not define "normal".
   * Returns {mean, sd, p: Float64Array[367][percentiles]}
   */
  function climatology(values, days, percentiles, smooth) {
    percentiles = percentiles || [10, 25, 50, 75, 90, 95];
    smooth = smooth === undefined ? 7 : smooth;
    const buckets = new Map();
    for (let i = 0; i < days.length; i++) {
      const v = values[i];
      if (!isFinite(v)) continue;
      const d = F.dayOfYear(days[i]);
      let a = buckets.get(d); if (!a) { a = []; buckets.set(d, a); }
      a.push(v);
    }
    const mean = new Float64Array(367), sd = new Float64Array(367);
    const P = {}; percentiles.forEach(p => P[p] = new Float64Array(367));
    for (let d = 1; d <= 366; d++) {
      const a = buckets.get(d);
      if (!a || !a.length) { mean[d] = NaN; continue; }
      mean[d] = F.mean(a); sd[d] = F.stdev(a);
      const s = Float64Array.from(a).sort();
      percentiles.forEach(p => P[p][d] = F.quantile(s, p / 100));
    }
    // circular smoothing over day-of-year
    if (smooth > 1) {
      const h = Math.floor(smooth / 2);
      const sm = new Float64Array(367), ss = new Float64Array(367);
      const sp = {}; percentiles.forEach(p => sp[p] = new Float64Array(367));
      for (let d = 1; d <= 366; d++) {
        let n = 0, a1 = 0, a2 = 0;
        const acc = {}; percentiles.forEach(p => acc[p] = []);
        for (let k = -h; k <= h; k++) {
          let dd = d + k;
          while (dd < 1) dd += 365; while (dd > 366) dd -= 365;
          if (!isFinite(mean[dd])) continue;
          a1 += mean[dd]; a2 += sd[dd]; n++;
          percentiles.forEach(p => acc[p].push(P[p][dd]));
        }
        sm[d] = n ? a1 / n : NaN; ss[d] = n ? a2 / n : NaN;
        percentiles.forEach(p => sp[p][d] = n ? F.mean(acc[p]) : NaN);
      }
      return { mean: sm, sd: ss, p: sp, percentiles, n: buckets };
    }
    return { mean, sd, p: P, percentiles, n: buckets };
  }

  /** Anomaly z-score of every day against its day-of-year climatology. */
  function anomalies(values, days, clim, smooth) {
    clim = clim || climatology(values, days, null, smooth);
    const z = new Float64Array(values.length);
    const pctRank = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const d = F.dayOfYear(days[i]);
      const m = clim.mean[d], s = clim.sd[d];
      z[i] = (isFinite(m) && s > 1e-9) ? (values[i] - m) / s : 0;
      pctRank[i] = isFinite(m) && m > 0 ? values[i] / m : NaN;
    }
    return { z, ratio: pctRank, clim };
  }

  // ------------------------------------------------------------- critical periods
  /**
   * Detect sustained "critical burning periods".
   *
   * A day is *elevated* when activity reaches the `pct`-th percentile of its own
   * day-of-year climatology.  Consecutive elevated days, bridging gaps of at most
   * `gap` days, form a candidate period; it is reported when it lasts at least
   * `minDays` and accumulates at least `minEvents`.
   */
  function criticalPeriods(values, days, opts) {
    opts = opts || {};
    const pct = opts.pct || 75, gap = opts.gap === undefined ? 3 : opts.gap;
    const minDays = opts.minDays || 7, minEvents = opts.minEvents || 25;
    const clim = opts.clim || climatology(values, days, [pct, 90]);
    const thr = clim.p[pct] || clim.p[90];
    const n = values.length;
    const flag = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = F.dayOfYear(days[i]);
      const t = thr ? thr[d] : NaN;
      flag[i] = (isFinite(t) && t > 0 && values[i] >= t) ? 1 : 0;
    }
    const out = [];
    let i = 0;
    while (i < n) {
      if (!flag[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n) {
        let k = j + 1, run = 0;
        while (k < n && !flag[k] && run < gap) { k++; run++; }
        if (k < n && flag[k]) j = k; else break;
      }
      let total = 0, peak = 0, peakI = i;
      for (let t = i; t <= j; t++) { total += values[t]; if (values[t] > peak) { peak = values[t]; peakI = t; } }
      const len = Math.round((days[j] - days[i]) / F.MS_DAY) + 1;
      if (len >= minDays && total >= minEvents) {
        // baseline expectation for the same window from climatology
        let exp = 0;
        for (let t = i; t <= j; t++) { const m = clim.mean[F.dayOfYear(days[t])]; if (isFinite(m)) exp += m; }
        out.push({
          start: days[i], end: days[j], startIdx: i, endIdx: j, days: len,
          events: total, expected: exp, peak: peak, peakDate: days[peakI],
          anomalyPct: exp > 0 ? 100 * (total / exp - 1) : NaN,
          intensity: len > 0 ? total / len : 0,
        });
      }
      i = j + 1;
    }
    return out;
  }

  // ---------------------------------------------------------------- fire season
  /**
   * Season onset / cessation / length using cumulative-activity percentiles.
   * Onset = day the cumulative season total first reaches `lo`%; cessation = `hi`%.
   */
  function seasonMetrics(values, days, lo, hi) {
    lo = lo || 10; hi = hi || 90;
    const years = [...new Set(days.map(d => d.getUTCFullYear()))].sort();
    const out = [];
    for (const y of years) {
      let tot = 0, sum = 0, onset = null, cess = null, peak = 0, peakD = null;
      const nd = F.daysInYear(y);
      const cum = new Float64Array(nd + 1);
      for (let i = 0; i < days.length; i++) {
        if (days[i].getUTCFullYear() !== y) continue;
        const d = F.dayOfYear(days[i]);
        tot += values[i]; cum[d] = tot;
        if (values[i] > peak) { peak = values[i]; peakD = days[i]; }
      }
      if (tot <= 0) { out.push({ year: y, total: 0 }); continue; }
      for (let d = 1; d <= nd; d++) {
        if (onset === null && cum[d] >= tot * lo / 100) onset = d;
        if (cess === null && cum[d] >= tot * hi / 100) cess = d;
      }
      out.push({ year: y, total: tot, onset, cessation: cess,
                 length: (onset && cess) ? cess - onset : null,
                 peak, peakDate: peakD });
    }
    return out;
  }

  // --------------------------------------------------------------- early warning
  /**
   * Operational status for an AOI over the last `window` days of the record.
   * Combines the recent anomaly with the climatological expectation for the days
   * ahead, which is what makes it a *warning* rather than a report.
   */
  function earlyWarning(values, days, opts) {
    opts = opts || {};
    const win = opts.window || 14;
    const clim = opts.clim || climatology(values, days, [50, 75, 90, 95], 9);
    const n = values.length;
    const end = n - 1;
    const start = Math.max(0, end - win + 1);
    let obs = 0, exp = 0, peakZ = -Infinity;
    for (let i = start; i <= end; i++) {
      const d = F.dayOfYear(days[i]);
      obs += values[i];
      if (isFinite(clim.mean[d])) exp += clim.mean[d];
      const s = clim.sd[d];
      const z = (isFinite(s) && s > 1e-9) ? (values[i] - clim.mean[d]) / s : 0;
      if (z > peakZ) peakZ = z;
    }
    const ratio = exp > 0 ? obs / exp : NaN;
    const z = exp > 0 && obs > 0 ? (obs - exp) / Math.max(Math.sqrt(exp), 1e-9) : 0;

    // what does climatology say about the next 30 days?
    const last = days[end];
    let next30 = 0, next30p90 = 0, peakAhead = null, peakAheadVal = -1;
    for (let k = 1; k <= 30; k++) {
      const d = F.dayOfYear(F.addDays(last, k));
      if (isFinite(clim.mean[d])) next30 += clim.mean[d];
      const p90 = clim.p[90] ? clim.p[90][d] : NaN;
      if (isFinite(p90)) next30p90 += p90;
      if (isFinite(clim.mean[d]) && clim.mean[d] > peakAheadVal) {
        peakAheadVal = clim.mean[d]; peakAhead = k;
      }
    }
    let level = 'normal';
    if (z > 6 || ratio > 2.2) level = 'critical';
    else if (z > 3 || ratio > 1.6) level = 'elevated';
    else if (z > 1.5 || ratio > 1.25) level = 'watch';
    else if (ratio < 0.6) level = 'suppressed';
    return {
      window: win, observed: obs, expected: exp, ratio, z, peakZ,
      level, asOf: last,
      next30Expected: next30, next30P90: next30p90,
      climatologicalPeakInDays: peakAhead,
    };
  }

  // ------------------------------------------------------------------ narrative
  const LEVEL_TEXT = {
    critical: 'CRITICAL', elevated: 'ELEVATED', watch: 'WATCH',
    normal: 'NORMAL', suppressed: 'BELOW NORMAL',
  };

  /**
   * Turn the numbers into the paragraphs a duty officer would write.
   * Deterministic, data-driven, and honest about data quality.
   */
  function narrative(store, aoi, series, opts) {
    opts = opts || {};
    const days = store.days, vals = series.harm;
    const n = vals.length;
    const clim = climatology(vals, days, [25, 50, 75, 90, 95], 9);
    const years = [...new Set(days.map(d => d.getUTCFullYear()))].sort();
    const focusYear = opts.year || years[years.length - 1];
    const sel = [];
    for (let i = 0; i < n; i++) if (days[i].getUTCFullYear() === focusYear) sel.push(i);
    if (!sel.length) return { paragraphs: [], stats: {} };

    const yearTotal = sel.reduce((a, i) => a + vals[i], 0);
    const idxAll = [];
    for (let i = 0; i < n; i++) if (days[i].getUTCFullYear() !== focusYear) idxAll.push(i);
    const otherYears = new Map();
    for (const i of idxAll) {
      const y = days[i].getUTCFullYear();
      otherYears.set(y, (otherYears.get(y) || 0) + vals[i]);
    }
    const others = [...otherYears.values()];
    const baseMed = others.length ? F.median(others) : yearTotal;
    const baseP90 = others.length ? F.quantile(Float64Array.from(others).sort(), 0.9) : yearTotal;
    const anomaly = baseMed > 0 ? 100 * (yearTotal / baseMed - 1) : 0;

    const sm = seasonMetrics(vals, days);
    const thisSeason = sm.find(s => s.year === focusYear);
    const otherSeasons = sm.filter(s => s.year !== focusYear && s.onset);
    const medOnset = otherSeasons.length ? F.median(otherSeasons.map(s => s.onset)) : null;
    const medCess = otherSeasons.length ? F.median(otherSeasons.map(s => s.cessation)) : null;
    const medLen = otherSeasons.length ? F.median(otherSeasons.map(s => s.length)) : null;

    const cps = criticalPeriods(vals, days, { clim, minEvents: Math.max(5, yearTotal * 0.002) })
      .filter(c => c.start.getUTCFullYear() === focusYear || c.end.getUTCFullYear() === focusYear);
    const warn = earlyWarning(vals, days, { clim, window: 14 });

    const sensor = sensorSplit(store, aoi, sel);
    const qual = qualitySummary(series.quality, sel, store.days);

    const P = [];
    const name = series.label || 'the selected area';
    P.push(`In ${focusYear}, ${name} recorded an estimated **${F.fmtInt(yearTotal)} burning events** ` +
      `on the harmonised MODIS+VIIRS scale. That is **${F.fmtPct(anomaly, 0)}** against the ` +
      `${otherYears.size}-year median of ${F.fmtInt(baseMed)} for the same area, ` +
      (yearTotal > baseP90 ? 'placing the year **above the 90th percentile** of the record.'
        : (yearTotal < baseMed * 0.9 ? 'well **below** a typical year.' : 'within the normal range.')));

    if (thisSeason && thisSeason.onset && medOnset) {
      const dOn = thisSeason.onset - medOnset, dC = (thisSeason.cessation || 0) - (medCess || 0);
      P.push(`The burning season ran from about **day ${thisSeason.onset}** ` +
        `(${F.fmtDateShort(F.fromDayOfYear(focusYear, thisSeason.onset))}) to **day ${thisSeason.cessation}** ` +
        `(${F.fmtDateShort(F.fromDayOfYear(focusYear, thisSeason.cessation))}), a length of ` +
        `${thisSeason.length} days. Onset was **${Math.abs(dOn)} days ${dOn > 0 ? 'later' : 'earlier'}** ` +
        `and cessation **${Math.abs(dC)} days ${dC > 0 ? 'later' : 'earlier'}** than the climatological median, ` +
        `${thisSeason.length - medLen > 5 ? 'a materially longer season than usual.' :
          (medLen - thisSeason.length > 5 ? 'a shorter season than usual.' : 'close to the usual season length.')}`);
    }

    if (cps.length) {
      const worst = cps.slice().sort((a, b) => b.anomalyPct - a.anomalyPct)[0];
      P.push(`**${cps.length} critical burning period${cps.length > 1 ? 's were' : ' was'}** detected ` +
        `(activity at or above the 75th percentile of its own day-of-year climatology for 7+ days). ` +
        `The most intense ran **${F.fmtDate(worst.start)} – ${F.fmtDate(worst.end)}** ` +
        `(${worst.days} days, ${F.fmtInt(worst.events)} events, ${F.fmtPct(worst.anomalyPct, 0)} vs normal), ` +
        `peaking on ${F.fmtDate(worst.peakDate)}.`);
    } else {
      P.push('No sustained critical burning period was detected in this year — activity never held ' +
        'above its climatological 75th percentile for a week or more.');
    }

    P.push(`**Current status (${F.fmtDate(warn.asOf)}):** ${LEVEL_TEXT[warn.level]}. Over the last ` +
      `${warn.window} days the area recorded ${F.fmtInt(warn.observed)} events against a climatological ` +
      `expectation of ${F.fmtInt(warn.expected)} (${warn.ratio > 0 ? warn.ratio.toFixed(2) + '×' : 'n/a'}, ` +
      `z = ${warn.z.toFixed(1)}). Climatology puts the next local maximum about ` +
      `**${warn.climatologicalPeakInDays} days** ahead, with ~${F.fmtInt(warn.next30Expected)} events ` +
      `expected in the next 30 days (${F.fmtInt(warn.next30P90)} at the 90th percentile).`);

    P.push(`**Sensor basis.** ${sensor.text} ${qual.text}`);

    return {
      paragraphs: P, focusYear, yearTotal, baseMed, anomaly, season: thisSeason,
      critical: cps, warning: warn, sensor, quality: qual, clim, years,
    };
  }

  function sensorSplit(store, aoi, idx) {
    const s = store.aoiSeries(aoi);
    let m = 0, v = 0;
    for (const i of idx) { m += s.modis[i]; v += s.viirs[i]; }
    const years = new Set(idx.map(i => store.days[i].getUTCFullYear()));
    const hasV = [...years].some(y => y >= 2012);
    const text = hasV
      ? `The estimate fuses ${F.fmtInt(m)} MODIS and ${F.fmtInt(v)} VIIRS detections. ` +
        `Raw counts are not comparable: over this window VIIRS reports ` +
        `${m > 0 ? (v / m).toFixed(1) + '×' : '—'} as many detections as MODIS for the same burning, ` +
        `because its 375 m pixels resolve small and short-lived fires that a 1 km MODIS pixel misses.`
      : `This period predates VIIRS, so the estimate rests on MODIS alone, rescaled by the ` +
        `overlap-calibrated bridge factor β = ${store.bridgeFactor.toFixed(3)}.`;
    return { modis: m, viirs: v, hasViirs: hasV, text };
  }

  function qualitySummary(quality, idx, days) {
    let bad = 0, gap = 0;
    const spans = [];
    for (const i of idx) {
      if (quality[i] === 1) bad++;
      else if (quality[i] >= 2) gap++;
    }
    if (bad) spans.push(`${bad} day${bad > 1 ? 's' : ''} where one sensor dropped out and the other carried the estimate`);
    if (gap) spans.push(`${gap} single-sensor day${gap > 1 ? 's' : ''}`);
    const text = spans.length
      ? `Data quality: ${spans.join('; ')}. Flagged days are marked on the calendar and excluded from trend fits.`
      : 'Data quality: both sensors agreed within tolerance on every day of this period; no gap flags were raised.';
    return { degraded: bad, singleSensor: gap, text };
  }

  /** Rolling mean with edge handling (for trend lines). */
  function rollingMean(values, win) {
    const n = values.length, out = new Float64Array(n);
    const h = Math.floor(win / 2);
    let sum = 0, cnt = 0;
    for (let i = 0; i < Math.min(win, n); i++) { sum += values[i]; cnt++; }
    for (let i = 0; i < n; i++) {
      out[i] = cnt ? sum / cnt : NaN;
      const add = i + h + 1, rem = i - h;
      if (add < n) { sum += values[add]; cnt++; }
      if (rem >= 0) { sum -= values[rem]; cnt--; }
    }
    return out;
  }

  /** Annual totals keyed by year. */
  function annualTotals(values, days) {
    const out = new Map();
    for (let i = 0; i < days.length; i++) {
      const y = days[i].getUTCFullYear();
      out.set(y, (out.get(y) || 0) + values[i]);
    }
    return out;
  }

  /** Ordinary least squares slope, ignoring non-finite values. */
  function olsTrend(xs, ys) {
    const px = [], py = [];
    for (let i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
    if (px.length < 3) return { slope: NaN, intercept: NaN, r2: NaN, n: px.length };
    const mx = F.mean(px), my = F.mean(py);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < px.length; i++) {
      const a = px[i] - mx, b = py[i] - my;
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    const slope = sxx > 0 ? sxy / sxx : NaN;
    const r2 = (sxx > 0 && syy > 0) ? (sxy * sxy) / (sxx * syy) : NaN;
    return { slope, intercept: my - slope * mx, r2, n: px.length };
  }

  global.FLAnalysis = {
    climatology, anomalies, criticalPeriods, seasonMetrics, earlyWarning,
    narrative, rollingMean, annualTotals, olsTrend, LEVEL_TEXT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
