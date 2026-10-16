/* FireLens — NASA FIRMS importer.
 *
 * Drop in the CSVs you download from https://firms.modaps.eosdis.nasa.gov/download/
 * and the whole application is rebuilt on your data: sensor detection, confidence
 * unification, platform inference from the `satellite` codes, per-province daily
 * aggregation and a freshly measured overlap bridge factor.
 *
 * Column names follow the FIRMS convention:
 *   MODIS  latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,
 *          instrument,confidence,version,bright_t31,frp,daynight
 *   VIIRS  latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
 *          instrument,confidence,version,bright_ti5,frp,daynight
 */
(function (global) {
  'use strict';
  const F = global.FL, HZ = global.FLHarmonize;

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1);
  }

  function detectSensor(header, name, sample) {
    const h = header.map(x => x.trim().toLowerCase());
    const has = c => h.includes(c);
    if (has('bright_ti4') && has('bright_ti5') && !has('bright_t31')) return 'VIIRS';
    if (has('brightness') || has('bright_t31')) return 'MODIS';
    const iCol = h.indexOf('instrument');
    if (iCol >= 0 && sample) {
      const v = String(sample[iCol] || '').toUpperCase();
      if (v.includes('VIIRS')) return 'VIIRS';
      if (v.includes('MODIS')) return 'MODIS';
    }
    const n = String(name).toLowerCase();
    if (n.includes('viirs') || n.includes('suomi') || n.includes('npp') || n.includes('noaa2') || n.includes('j1') || n.includes('j2')) return 'VIIRS';
    if (n.includes('modis') || n.includes('terra') || n.includes('aqua')) return 'MODIS';
    throw new Error('could not tell whether "' + name + '" is MODIS or VIIRS data');
  }

  /** Province footprint, matching pipeline/regions.py exactly. */
  function footprint(r, lat, lon) {
    const dlat = lat - r.lat;
    let dlon = (lon - r.lon + 540) % 360 - 180;
    const t = r.tilt * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const u = (dlon * c + dlat * s) / r.rx, v = (-dlon * s + dlat * c) / r.ry;
    const q = u * u + v * v;
    return q > 20 ? 0 : Math.exp(-0.5 * q);
  }

  function provinceIndex(regions) {
    return regions.filter(r => r.key !== 'global_background').map(r => ({
      key: r.key, lat: r.lat, lon: r.lon, rx: r.rx * 2.6, ry: r.ry * 2.6, tilt: r.tilt, ref: r,
    }));
  }

  async function importFiles(store, files, progress) {
    const say = m => { if (progress) progress(m); };
    const regions = store.regions;
    const provs = provinceIndex(regions);
    const pidx = new Map(provs.map(p => [p.key, provs.indexOf(p)]));

    const recs = { MODIS: [], VIIRS: [] };
    const usedFiles = [];
    for (const f of files) {
      say('Reading ' + f.name + ' (' + (f.size / 1024).toFixed(0) + ' KB)…');
      const text = await f.text();
      const rows = parseCSV(text);
      if (rows.length < 2) throw new Error(f.name + ': no data rows found');
      const header = rows[0].map(x => x.trim().toLowerCase());
      const sensor = detectSensor(header, f.name, rows[1]);
      const col = {};
      header.forEach((h, i) => col[h] = i);
      const need = ['latitude', 'longitude', 'acq_date'];
      for (const c of need) if (col[c] === undefined) throw new Error(f.name + ': missing column "' + c + '"');
      const cLat = col.latitude !== undefined ? col.latitude : col.lat;
      const cLon = col.longitude !== undefined ? col.longitude : col.lon;
      const cDate = col.acq_date, cSat = col.satellite, cFrp = col.frp;
      const cConf = col.confidence;
      let n = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const lat = parseFloat(r[cLat]), lon = parseFloat(r[cLon]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const date = String(r[cDate]).trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        recs[sensor].push({
          date, lat, lon,
          sat: cSat !== undefined ? String(r[cSat] || '').trim().toUpperCase() : '',
          frp: cFrp !== undefined ? parseFloat(r[cFrp]) || 0 : 0,
          conf: cConf !== undefined ? HZ.normaliseConfidence(sensor, r[cConf]) : 'nominal',
        });
        n++;
      }
      usedFiles.push(`${f.name} → ${sensor}, ${n.toLocaleString()} detections`);
      say(`  ${f.name}: ${n.toLocaleString()} ${sensor} detections`);
    }
    if (!recs.MODIS.length && !recs.VIIRS.length) throw new Error('no usable rows found');

    // ---- platform configuration inferred from the satellite codes present
    const nM = HZ.satellitesFromData('MODIS', recs.MODIS.map(r => r.sat));
    const nV = HZ.satellitesFromData('VIIRS', recs.VIIRS.map(r => r.sat));

    // ---- date axis
    say('Building the daily record…');
    const dateSet = new Set();
    for (const r of recs.MODIS) dateSet.add(r.date);
    for (const r of recs.VIIRS) dateSet.add(r.date);
    let dates = [...dateSet].sort();
    const d0 = F.isoToDate(dates[0]), d1 = F.isoToDate(dates[dates.length - 1]);
    const all = [];
    for (let d = new Date(d0); d <= d1; d = F.addDays(d, 1)) all.push(F.dateToISO(d));
    dates = all;
    const n = dates.length;
    const dIdx = new Map(dates.map((d, i) => [d, i]));

    const gM = new Float64Array(n), gV = new Float64Array(n);
    const keys = provs.map(p => p.key);
    const rM = keys.map(() => new Float64Array(n));
    const rV = keys.map(() => new Float64Array(n));

    function accumulate(list, target, rTarget) {
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        const i = dIdx.get(r.date);
        if (i === undefined) continue;
        target[i]++;
        // apportion to provinces by footprint share (same model as the simulator)
        let sum = 0; const hits = [];
        for (let p = 0; p < provs.length; p++) {
          const pr = provs[p];
          const dlat = Math.abs(r.lat - pr.lat);
          let dlon = Math.abs(((r.lon - pr.lon + 540) % 360) - 180);
          if (dlat > pr.ry || dlon > pr.rx) continue;
          const f = footprint(pr.ref, r.lat, r.lon);
          if (f > 0.02) { hits.push([p, f]); sum += f; }
        }
        if (sum > 0) for (const [p, f] of hits) rTarget[p][i] += f / sum;
      }
    }
    say('Aggregating MODIS detections…');
    accumulate(recs.MODIS, gM, rM);
    say('Aggregating VIIRS detections…');
    accumulate(recs.VIIRS, gV, rV);

    // ---- rebuild the store
    say('Re-harmonising…');
    const days = dates.map(F.isoToDate);
    store.replaceSeries(days, gM, gV, {
      label: `${dates[0]} → ${dates[n - 1]}`,
      files: usedFiles,
      n_modis: recs.MODIS.length, n_viirs: recs.VIIRS.length,
      platforms: { modis: nM, viirs: nV },
    });
    store.H.nModisSats = nM;
    store.H.nViirsSats = nV;
    store.H.bridge = store.H.bridgeFactor(gM, gV, days);
    store.bridgeFactor = store.H.bridge;
    store.globalHarm = store.H.series(gM, gV, days);
    store.keys = keys;
    store.keyIndex = new Map(keys.map((k, i) => [k, i]));
    store.provModis = rM;
    store.provViirs = rV;
    store.regionByKey = new Map(regions.map(r => [r.key, r]));

    const summary = `${recs.MODIS.length.toLocaleString()} MODIS + ${recs.VIIRS.length.toLocaleString()} VIIRS ` +
      `detections over ${n.toLocaleString()} days (${dates[0]} → ${dates[n - 1]}), ` +
      `${nM} MODIS / ${nV} VIIRS satellite(s) inferred, β = ${store.bridgeFactor.toFixed(3)}`;
    return { summary, dates: n, nModis: recs.MODIS.length, nViirs: recs.VIIRS.length };
  }

  global.FLImport = { importFiles, parseCSV, detectSensor, footprint };
})(typeof window !== 'undefined' ? window : globalThis);
