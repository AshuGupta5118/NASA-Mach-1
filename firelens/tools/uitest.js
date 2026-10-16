/* End-to-end UI smoke test: serves the app, loads every view, and fails on any
 * console error or uncaught exception.  Also writes screenshots.
 *
 *   node tools/uitest.js
 */
// Playwright is not a project dependency (the app itself needs no build step and
// no packages). Point PLAYWRIGHT_PATH at an install, or run with NODE_PATH set.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = process.env.FL_APP || path.join(__dirname, '..', 'app');
const SHOTS = path.join(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.gz': 'application/octet-stream',
               '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, q) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(APP, p);
      if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        q.writeHead(404); q.end('not found'); return;
      }
      q.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
                         'Content-Encoding': f.endsWith('.gz') ? 'gzip' : 'identity',
                         'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(q);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

// NOTE: .gz files are served with Content-Encoding: gzip so the browser
// transparently decodes them; the app then sees plain JSON/bytes.
(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  console.log('serving', url);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 },
                                       deviceScaleFactor: 1 });
  const errors = [], warnings = [];
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error') errors.push('console: ' + t);
    else if (m.type() === 'warning') warnings.push('warn: ' + t);
  });
  page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('requestfailed', r => {
    const u = r.url();
    if (!u.includes('favicon')) errors.push('requestfailed: ' + u + ' ' + (r.failure() || {}).errorText);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('loader') === null ||
    document.getElementById('loader').classList.contains('hide'), { timeout: 90000 });
  await page.waitForTimeout(1500);

  const views = ['overview', 'calendar', 'trends', 'map', 'critical', 'lab', 'data'];
  for (const v of views) {
    console.log('--- view:', v);
    await page.evaluate(x => window.FLApp.setView(x), v);
    await page.waitForTimeout(v === 'map' ? 4500 : 2200);
    const n = await page.evaluate(() => document.getElementById('main').children.length);
    const txt = await page.evaluate(() => document.getElementById('main').innerText.length);
    console.log(`    rendered ${n} top-level nodes, ${txt} chars of text`);
    if (n < 1 || txt < 200) errors.push(`view ${v} rendered almost nothing (${n} nodes, ${txt} chars)`);
    await page.screenshot({ path: path.join(SHOTS, `${v}.png`), fullPage: v !== 'map' });
  }

  // ---- interactions
  console.log('--- interactions');
  await page.evaluate(() => window.FLApp.setView('overview'));
  await page.waitForTimeout(1200);

  // switch AOI via the top-bar select
  const before = await page.evaluate(() => document.querySelector('.page-h h2').textContent);
  await page.selectOption('#aoi-select', 'borneo');
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => document.querySelector('.page-h h2').textContent);
  console.log(`    AOI switch: "${before}" -> "${after}"`);
  if (before === after) errors.push('AOI switch did not change the page');
  await page.screenshot({ path: path.join(SHOTS, 'overview-borneo.png'), fullPage: true });

  // period presets
  for (const p of ['30d', '90d', 'all']) {
    await page.evaluate(lbl => {
      const b = [...document.querySelectorAll('#period-seg button')].find(x => x.textContent.includes(lbl));
      if (b) b.click();
    }, p);
    await page.waitForTimeout(1100);
  }
  console.log('    period presets cycled');

  // calendar colour modes
  await page.evaluate(() => window.FLApp.setView('calendar'));
  await page.waitForTimeout(2000);
  for (const mode of ['Absolute', 'Anomaly (z)', '% of normal']) {
    await page.evaluate(m => {
      const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === m);
      if (b) b.click();
    }, mode);
    await page.waitForTimeout(1600);
  }
  await page.screenshot({ path: path.join(SHOTS, 'calendar-anomaly.png'), fullPage: true });
  console.log('    calendar colour modes cycled');

  // map: layers + tiers
  await page.evaluate(() => window.FLApp.setView('map'));
  await page.waitForTimeout(5000);
  for (const L of ['MODIS only', 'VIIRS only', 'Agreement', 'Harmonised']) {
    await page.evaluate(l => {
      const b = [...document.querySelectorAll('.mapbar .seg button')].find(x => x.textContent.trim() === l);
      if (b) b.click();
    }, L);
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: path.join(SHOTS, 'map-daily.png') });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === 'A year');
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS, 'map-year.png') });
  console.log('    map layers and tiers cycled');

  // lab: run the real-data co-registration
  await page.evaluate(() => window.FLApp.setView('lab'));
  await page.waitForTimeout(2000);
  const ran = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Run co-registration'));
    if (!b) return 'button not found';
    b.click();
    return 'clicked';
  });
  console.log('    lab co-registration:', ran);
  await page.waitForTimeout(14000);
  const labTxt = await page.evaluate(() => document.getElementById('main').innerText);
  console.log('    lab mentions matched pairs:', /Matched pairs|matched/i.test(labTxt),
              '| text length', labTxt.length);
  if (!/MODIS detections/.test(labTxt)) errors.push('lab did not render the real-event statistics');
  await page.screenshot({ path: path.join(SHOTS, 'lab.png'), fullPage: true });

  // sliders
  const slid = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type=range]')];
    if (!inputs.length) return 0;
    const i = inputs[0];
    i.value = String(+i.min + (+i.max - +i.min) * 0.75);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return inputs.length;
  });
  console.log('    sliders found:', slid);
  await page.waitForTimeout(4000);

  // data view exports
  await page.evaluate(() => window.FLApp.setView('data'));
  await page.waitForTimeout(1500);
  const csv = await page.evaluate(() => {
    const st = window.FLApp.App.store;
    const s = st.aoiSeries(window.FLApp.state.aoi);
    return { days: st.ndays, harm0: s.harm[0], label: s.label };
  });
  console.log('    store ok:', JSON.stringify(csv));
  await page.screenshot({ path: path.join(SHOTS, 'data.png'), fullPage: true });

  // critical view
  await page.evaluate(() => window.FLApp.setView('critical'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, 'critical.png'), fullPage: true });

  await browser.close();
  srv.close();

  console.log('\n=== console errors: ' + errors.length + ' ===');
  errors.slice(0, 25).forEach(e => console.log('  ' + e.slice(0, 400)));
  if (warnings.length) {
    console.log('--- warnings (' + warnings.length + ') ---');
    warnings.slice(0, 8).forEach(w => console.log('  ' + w.slice(0, 240)));
  }
  console.log('\nscreenshots written to docs/screenshots/');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('HARNESS FAILURE', e); process.exit(2); });
