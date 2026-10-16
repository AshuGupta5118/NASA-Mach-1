/* Verify the self-contained build works from file:// with zero network access. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const fs = require('fs');

const target = process.argv[2] ||
  path.join(__dirname, '..', 'app', 'firelens-standalone.html');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 },
                                         offline: true });          // hard no-network
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + (e.message || e)));
  page.on('request', r => {
    const u = r.url();
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'))
      errors.push('NETWORK REQUEST: ' + u);
  });

  await page.goto('file://' + target, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.getElementById('loader') === null ||
    document.getElementById('loader').classList.contains('hide'), { timeout: 180000 });
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => ({
    view: window.FLApp.state.view,
    days: window.FLApp.App.store.ndays,
    mainNodes: document.getElementById('main').children.length,
    text: document.getElementById('main').innerText.length,
  }));
  console.log('standalone loaded:', JSON.stringify(info));

  for (const v of ['calendar', 'trends', 'map', 'critical', 'lab', 'data']) {
    await page.evaluate(x => window.FLApp.setView(x), v);
    await page.waitForTimeout(v === 'map' ? 4000 : 1600);
    const t = await page.evaluate(() => document.getElementById('main').innerText.length);
    console.log(`  ${v}: ${t} chars`);
    if (t < 200) errors.push(`view ${v} rendered almost nothing`);
  }
  await page.evaluate(() => window.FLApp.setView('overview'));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(path.dirname(target), '..', 'docs', 'screenshots',
                                           'standalone-overview.png') });
  await browser.close();
  console.log('\nerrors: ' + errors.length);
  errors.slice(0, 20).forEach(e => console.log('  ' + e.slice(0, 300)));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('HARNESS FAILURE', e); process.exit(2); });
