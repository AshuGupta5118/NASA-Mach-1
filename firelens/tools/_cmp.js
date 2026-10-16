/* Companion to tools/compare_implementations.py — compares the browser
 * harmoniser against the Python pipeline day by day. */
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');

global.window = global;
global.atob = s => Buffer.from(s, 'base64').toString('binary');
global.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  body: { appendChild() {} }, addEventListener() {}, getElementById: () => null,
  querySelectorAll: () => [],
};
global.performance = { now: () => Date.now() };
global.navigator = {};
for (const f of ['util.js', 'harmonize.js']) {
  new Function('window', fs.readFileSync(path.join(APP, 'js', f), 'utf8'))(global);
}
const F = global.FL, HZ = global.FLHarmonize;

const core = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(APP, 'data', 'core.json.gz'))));
const gm = F.readVarintSeries(core.series.global.modis);
const gv = F.readVarintSeries(core.series.global.viirs);
const d0 = F.isoToDate(core.meta.start);
const days = []; for (let i = 0; i < gm.length; i++) days.push(F.addDays(d0, i));

const H = new HZ.Harmonizer(core.calibration);
const beta = H.bridgeFactor(gm, gv, days);
H.bridge = beta;
const r = H.series(gm, gv, days);

const py = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_py_series.json'), 'utf8'));
console.log('node  : total %.j'.replace('%.j', r.n_harm.reduce((a, b) => a + b, 0).toFixed(1)),
            ' beta', beta.toFixed(6));
console.log('node first 8:', Array.from(r.n_harm.slice(0, 8)).map(x => x.toFixed(3)).join(' '));

function cmp(name, jsArr, pyArr) {
  let maxd = 0, arg = -1, ndiff = 0;
  for (let i = 0; i < jsArr.length; i++) {
    const a = jsArr[i], b = pyArr[i];
    const av = (a === null || a === undefined || !isFinite(a)) ? null : a;
    const bv = (b === null || b === undefined || !isFinite(b)) ? null : b;
    if (av === null || bv === null) { if (av !== bv) { ndiff++; if (maxd < 1) { maxd = 1; arg = i; } } continue; }
    const d = Math.abs(av - bv);
    if (d > 1e-6) ndiff++;
    if (d > maxd) { maxd = d; arg = i; }
  }
  const rel = pyArr.reduce((a, b) => a + (b || 0), 0);
  console.log(`  ${name.padEnd(16)} max|js-py| = ${maxd.toExponential(2)}` +
              (arg >= 0 ? ` at ${F.dateToISO(days[arg])}` : '') +
              `   differing days: ${ndiff}/${jsArr.length}` +
              (rel ? `   total delta ${(100 * (jsArr.reduce((a, b) => a + (b || 0), 0) / rel - 1)).toFixed(4)}%` : ''));
  return { maxd, ndiff };
}
console.log('\nday-by-day comparison:');
const a = cmp('n_harm', Array.from(r.n_harm), py.n_harm);
cmp('n_modis', Array.from(r.n_modis), py.n_modis);
cmp('n_viirs', Array.from(r.n_viirs), py.n_viirs);
cmp('ratio_baseline', Array.from(r.ratio_baseline), py.ratio_baseline);
const qd = r.quality.reduce((s, q, i) => s + (q !== py.quality[i] ? 1 : 0), 0);
console.log(`  ${'quality flags'.padEnd(16)} differing days: ${qd}/${r.quality.length}`);

if (a.maxd > 0.01 || qd > 0) {
  let arg = -1, maxd = 0;
  for (let i = 0; i < r.n_harm.length; i++) {
    const d = Math.abs(r.n_harm[i] - py.n_harm[i]);
    if (d > maxd) { maxd = d; arg = i; }
  }
  console.log('\nworst day', F.dateToISO(days[arg]));
  console.log('  MODIS', gm[arg], 'VIIRS', gv[arg]);
  console.log('  js  n_modis', r.n_modis[arg], 'n_viirs', r.n_viirs[arg], 'q', r.quality[arg],
              'ratio_base', r.ratio_baseline[arg]);
  console.log('  py  n_modis', py.n_modis[arg], 'n_viirs', py.n_viirs[arg], 'q', py.quality[arg],
              'ratio_base', py.ratio_baseline[arg]);
  process.exit(1);
}
console.log('\nOK: the browser and Python implementations agree to <0.01 events/day.\n');
