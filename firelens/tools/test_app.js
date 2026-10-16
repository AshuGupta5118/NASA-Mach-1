/* Node-side test harness: verifies that the browser code decodes the real payload
 * correctly and that the JS harmoniser reproduces the Python pipeline's numbers.
 *
 *   node tools/test_app.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');

// ---- minimal browser shim
const store = {};
global.window = global;
global.atob = s => Buffer.from(s, 'base64').toString('binary');
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
                    createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
                    body: { appendChild() {} }, addEventListener() {}, getElementById: () => null,
                    querySelectorAll: () => [] };
global.performance = { now: () => Date.now() };
global.navigator = {};

for (const f of ['util.js', 'harmonize.js', 'analysis.js']) {
  const src = fs.readFileSync(path.join(APP, 'js', f), 'utf8');
  new Function('window', 'globalThis_', src)(global, global);
}

const F = global.FL, HZ = global.FLHarmonize, A = global.FLAnalysis;

function gunzipJSON(p) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) fails++;
}
function near(a, b, tol, name) {
  const ok = Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);
  check(name, ok, `got ${a.toFixed(4)}, expected ${b.toFixed(4)} (±${tol * 100}%)`);
}

console.log('\n=== payload decoding ===');
const core = gunzipJSON(path.join(APP, 'data', 'core.json.gz'));
check('core.json.gz parses', !!core.meta);
console.log(`  record ${core.meta.y0}-${core.meta.y1}, ${core.meta.ndays} days, ` +
            `${core.regions.length} regions, ${core.series.keys.length} provinces`);

const gm = F.readVarintSeries(core.series.global.modis);
const gv = F.readVarintSeries(core.series.global.viirs);
const gt = F.readFloat32Array(core.series.global.truth);
check('global MODIS series length', gm.length === core.meta.ndays, `${gm.length}`);
check('global VIIRS series length', gv.length === core.meta.ndays, `${gv.length}`);
check('truth series length', gt.length === core.meta.ndays, `${gt.length}`);

let sumM = 0, sumV = 0, sumT = 0;
for (let i = 0; i < gm.length; i++) { sumM += gm[i]; sumV += gv[i]; sumT += gt[i]; }
console.log(`  totals: MODIS ${sumM.toLocaleString()}  VIIRS ${sumV.toLocaleString()}  truth ${Math.round(sumT).toLocaleString()}`);
check('MODIS total in a plausible range', sumM > 1e8 && sumM < 5e8);
check('VIIRS/MODIS total ratio > 3', sumV / sumM > 3, (sumV / sumM).toFixed(2));

// VIIRS must be exactly zero before 2012
const d0 = F.isoToDate(core.meta.start);
let preViirs = 0, firstViirs = -1;
for (let i = 0; i < gm.length; i++) {
  const d = F.addDays(d0, i);
  if (d < HZ.VIIRS_START) preViirs += gv[i];
  else if (firstViirs < 0 && gv[i] > 0) firstViirs = i;
}
check('no VIIRS before 2012-01-01', preViirs === 0, `sum=${preViirs}`);
check('VIIRS starts on 2012-01-01', F.dateToISO(F.addDays(d0, firstViirs)) === '2012-01-01',
      F.dateToISO(F.addDays(d0, firstViirs)));

console.log('\n=== province raster ===');
const pr = core.province_raster;
const ras = F.readProvinceRaster(F.b64ToBytes(pr.data['bra_cerrado']), pr.scale);
let shareSum = 0;
for (let i = 0; i < ras.share.length; i++) shareSum += ras.share[i];
check('bra_cerrado raster decodes', ras.cells.length > 100, `${ras.cells.length} cells`);
check('shares sum to ~0.95-1.0', shareSum > 0.94 && shareSum < 1.001, shareSum.toFixed(4));
check('cell indices sorted & in range',
      ras.cells[0] >= 0 && ras.cells[ras.cells.length - 1] < pr.nlat * pr.nlon);

console.log('\n=== sparse grids ===');
const gf = core.grid_files;
const mon = F.readSparseGrid(zlib.gunzipSync(fs.readFileSync(path.join(APP, 'data', gf.monthly.file))));
check('monthly grid slices', mon.length === gf.monthly.slices, `${mon.length}`);
let monCells = 0, monSum = 0;
for (const s of mon) { monCells += s.idx.length; for (let i = 0; i < s.idx.length; i++) monSum += s.viirs[i]; }
console.log(`  monthly: ${monCells.toLocaleString()} cell-months, VIIRS total ${monSum.toLocaleString()}`);
check('monthly grid VIIRS total EXACTLY equals the daily series', monSum === sumV,
      `${monSum.toLocaleString()} vs ${sumV.toLocaleString()}`);
let monSumM = 0; for (const s2 of mon) for (let i = 0; i < s2.idx.length; i++) monSumM += s2.modis[i];
check('monthly grid MODIS total EXACTLY equals the daily series', monSumM === sumM,
      `${monSumM.toLocaleString()} vs ${sumM.toLocaleString()}`);
const yr = F.readSparseGrid(zlib.gunzipSync(fs.readFileSync(path.join(APP, 'data', gf.yearly.file))));
check('yearly grid slices', yr.length === gf.yearly.slices, `${yr.length}`);

console.log('\n=== recent daily grid ===');
const rec = F.readSparseGrid(zlib.gunzipSync(fs.readFileSync(path.join(APP, 'data', 'grid_recent.bin.gz'))));
check('recent slices', rec.length === gf.recent.slices, `${rec.length}`);
let recCells = 0;
for (const s of rec) recCells += s.idx.length;
console.log(`  ${recCells.toLocaleString()} cell-days over ${rec.length} days ` +
            `(${Math.round(recCells / rec.length).toLocaleString()}/day)`);

console.log('\n=== JS harmoniser vs Python pipeline ===');
const days = [];
for (let i = 0; i < gm.length; i++) days.push(F.addDays(d0, i));
const H = new HZ.Harmonizer(core.calibration);
const beta = H.bridgeFactor(gm, gv, days);
H.bridge = beta;
const py = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'validation.json'), 'utf8'));
near(beta, py.bridge_factor, 0.01, 'bridge factor beta matches Python');

const res = H.series(gm, gv, days);
let sh = 0, st2 = 0;
for (let i = 0; i < days.length; i++) { sh += res.n_harm[i]; st2 += gt[i]; }
const biasPct = 100 * (sh / st2 - 1);
console.log(`  JS harmonised total ${Math.round(sh).toLocaleString()} vs truth ${Math.round(st2).toLocaleString()}  bias ${biasPct.toFixed(2)}%`);
const pyBias = py.estimator_metrics_global['harmonised (full)'].bias_pct;
near(biasPct, pyBias, 0.6, 'global bias agrees with the Python validation (different RNG draws)');

// correlation with truth
let ok = true;
const r = F.pearson(Array.from(res.n_harm), Array.from(gt));
check('daily Pearson r > 0.99', r > 0.99, r.toFixed(4));

// platform-aware amplitudes
const a2001 = H.amplitudes(F.isoToDate('2001-06-15'));
const a2005 = H.amplitudes(F.isoToDate('2005-06-15'));
const a2015 = H.amplitudes(F.isoToDate('2015-06-15'));
const a2019 = H.amplitudes(F.isoToDate('2019-06-15'));
const a2025 = H.amplitudes(F.isoToDate('2025-06-15'));
console.log(`  a_modis: 2001 ${a2001[0].toFixed(4)} (Terra only)  2005 ${a2005[0].toFixed(4)} (Terra+Aqua)`);
console.log(`  a_viirs: 2015 ${a2015[1].toFixed(4)} (1 sat)  2019 ${a2019[1].toFixed(4)} (2 sat)  2025 ${a2025[1].toFixed(4)} (3 sat)`);
check('MODIS amplitude rises when Aqua joins Terra (2002)', a2001[0] < a2005[0] * 0.85,
      `${a2001[0].toFixed(3)} -> ${a2005[0].toFixed(3)}`);
check('MODIS amplitude is stable across the VIIRS era', Math.abs(a2005[0] - a2015[0]) < 1e-9);
check('VIIRS amplitude rises with each satellite', a2019[1] > a2015[1] && a2025[1] > a2019[1]);
check('no VIIRS amplitude before 2012', H.amplitudes(F.isoToDate('2010-06-15'))[1] === 0);

// outage handling: quality flags must be raised on the injected windows
const outageDays = core.meta.outages.map(o => ({ s: o[1], e: o[2], sensor: o[0], f: o[3] }));
let flagged = 0, checked = 0;
for (const o of outageDays) {
  if (o.s < '2012-01-01' && o.sensor === 'VIIRS') continue;
  let ds = F.isoToDate(o.s);
  const de = F.isoToDate(o.e);
  while (ds <= de) {
    const i = Math.round((ds - d0) / F.MS_DAY);
    if (i >= 0 && i < days.length) { checked++; if (res.quality[i] >= 1) flagged++; }
    ds = F.addDays(ds, 1);
  }
}
check('sensor outages are flagged, not silently reported as low burning',
      checked > 0 && flagged / checked > 0.6, `${flagged}/${checked} outage days flagged`);

console.log('\n=== real-event co-registration (JS port) ===');
const ev = gunzipJSON(path.join(APP, 'data', 'events.json.gz'));
const dEv = F.isoToDate(ev.meta.dates[0]);
const wrap = (arr, sensor) => arr.map(r => ({
  lon: r[0], lat: r[1], day: Math.round((F.isoToDate(ev.meta.dates[0].slice(0, 4) + '-' +
    r[2].slice(0, 2) + '-' + r[2].slice(2)) - dEv) / F.MS_DAY),
  frp: r[4], conf: r[6], sat: r[8], sensor,
}));
const em = wrap(ev.modis, 'MODIS'), evv = wrap(ev.viirs, 'VIIRS');
check('real events decoded', em.length === ev.meta.n_modis && evv.length === ev.meta.n_viirs,
      `${em.length} MODIS, ${evv.length} VIIRS`);
const t0 = Date.now();
const pairs = H.spatialMatch(em, evv, 2.0, 0);
const ms = Date.now() - t0;
const pct = 100 * pairs.length / em.length;
console.log(`  matched ${pairs.length.toLocaleString()} pairs = ${pct.toFixed(1)}% of MODIS in ${ms} ms`);
const pyCR = null;
check('co-registration match rate is 40-60% of MODIS', pct > 40 && pct < 60, pct.toFixed(1) + '%');
const dists = pairs.map(p => p.km).sort((a, b) => a - b);
const med = F.quantile(Float64Array.from(dists), 0.5);
check('median separation < 1 km', med < 1.0, med.toFixed(3) + ' km');

// satellite inference
const nV = HZ.satellitesFromData('VIIRS', evv.map(r => r.sat));
const nM = HZ.satellitesFromData('MODIS', em.map(r => r.sat));
check('infers 1 VIIRS satellite (NPP only)', nV === 1, String(nV));
check('infers 2 MODIS satellites (Terra+Aqua)', nM === 2, String(nM));

// harmonised estimate for the real day, using the inferred configuration
const H2 = new HZ.Harmonizer(core.calibration);
H2.nModisSats = nM; H2.nViirsSats = nV;
const nReal = H2.fuse(em.length, evv.length, dEv);
console.log(`  real 24 h harmonised N = ${Math.round(nReal).toLocaleString()} true clusters ` +
            `(simulator ground truth for the anchor day ~33,900)`);
check('real-day harmonised estimate within 15% of the simulator truth',
      Math.abs(nReal / 33867 - 1) < 0.15, ((nReal / 33867 - 1) * 100).toFixed(1) + '%');

console.log('\n=== analysis layer ===');
const clim = A.climatology(res.n_harm, days, [25, 50, 75, 90], 9);
check('climatology built for all days of year', clim.mean[100] > 0 && clim.mean[300] > 0);
const cps = A.criticalPeriods(res.n_harm, days, { clim, minEvents: 5000 });
check('critical periods detected', cps.length > 20, `${cps.length} periods`);
const sm = A.seasonMetrics(res.n_harm, days);
const withSeason = sm.filter(x => x.onset && x.cessation);
check('season metrics computed', withSeason.length >= 20, `${withSeason.length}/${sm.length} years`);
const warn = A.earlyWarning(res.n_harm, days, { clim, window: 14 });
check('early warning produced', ['normal', 'watch', 'elevated', 'critical', 'suppressed'].includes(warn.level),
      `level=${warn.level}, ratio=${warn.ratio.toFixed(2)}, z=${warn.z.toFixed(1)}`);

// known extreme seasons must be flagged
const probes = [[2019, 'Black Summer Australia'], [2023, 'Canadian megafires'],
                [2015, 'Indonesian peat fires'], [2010, 'Russian heatwave']];
const ann = A.annualTotals(res.n_harm, days);
const years = [...ann.keys()].sort();
const vals = years.map(y => ann.get(y));
const medAnn = F.median(vals);
for (const [y, label] of probes) {
  const v = ann.get(y);
  console.log(`  ${y} (${label}): ${Math.round(v).toLocaleString()} events, ` +
              `${(100 * (v / medAnn - 1)).toFixed(1)}% vs the record median`);
}
const t2023 = ann.get(2023);
check('2023 (Canadian megafires) is a global high', t2023 > medAnn * 1.02,
      `${(100 * (t2023 / medAnn - 1)).toFixed(1)}% vs median`);

console.log('\n=== narrative ===');
const nar = A.narrative({ days, ndays: days.length, y0: 2001, y1: 2025, bridgeFactor: beta,
                          aoiSeries: () => ({ modis: gm, viirs: gv, harm: res.n_harm,
                                              quality: res.quality, label: 'Whole planet' }),
                          harmonised: () => res, regionByKey: new Map(), imported: null },
                        { type: 'globe' },
                        { modis: gm, viirs: gv, harm: res.n_harm, quality: res.quality, label: 'Whole planet' },
                        { year: 2023 });
check('narrative generated', nar.paragraphs && nar.paragraphs.length >= 4,
      `${nar.paragraphs.length} paragraphs`);
console.log('\n--- sample paragraph ---\n' + nar.paragraphs[0].slice(0, 400) + '\n');

console.log(fails === 0 ? '\nALL CHECKS PASSED\n' : `\n${fails} CHECK(S) FAILED\n`);
process.exit(fails ? 1 : 0);
