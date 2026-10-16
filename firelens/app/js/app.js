/* FireLens — application shell, state and views. */
(function (global) {
  'use strict';
  const F = global.FL, C = global.FLCharts, A = global.FLAnalysis, HZ = global.FLHarmonize;
  const el = F.el, svg = F.svg;

  const state = {
    view: 'overview',
    aoi: { type: 'province', key: 'bra_cerrado' },
    period: { preset: 'ytd' },
    calMetric: 'harm',
    calMode: 'anomaly',
    calYear: null,
    mapLayer: 'harmonised',
    mapLog: true,
    mapOpacity: 0.9,
    mapTier: 'auto',
    mapDateMode: 'recent',
    mapDayOffset: 0,
    mapMonth: null,
    mapYear: null,
    labSensors: { modis: null, viirs: null },
    labOverride: null,
    trendMetric: 'harm',
    criticalYear: null,
    dataTab: 'import',
  };

  const App = {
    store: null, map: null, presets: [],
  };

  // ================================================================== bootstrap
  async function boot() {
    const loaderMsg = document.getElementById('load-msg');
    const setMsg = m => { if (loaderMsg) loaderMsg.textContent = m; };
    try {
      setMsg('loading core record (2001–2025)…');
      const store = new FLStore.Store();
      await store.load('data/', setMsg);
      App.store = store;
      App.presets = FLStore.presetAOIs(store);
      setMsg('rendering…');
      buildShell();
      setView('overview');
      document.getElementById('loader').classList.add('hide');
      setTimeout(() => { const l = document.getElementById('loader'); if (l) l.remove(); }, 600);
    } catch (e) {
      console.error(e);
      const l = document.getElementById('loader');
      if (l) l.innerHTML =
        `<h2>FIRE<em>LENS</em></h2>
         <div class="err"><b>Could not load the data payload.</b><br><br>
         ${F.esc(e.message || String(e))}<br><br>
         FireLens reads gzipped payloads with <code>fetch()</code>, which browsers block on
         <code>file://</code>. Serve the folder instead:<br><br>
         <code>cd firelens/app &amp;&amp; python3 -m http.server 8080</code><br>
         then open <code>http://localhost:8080</code>.<br><br>
         Or use the self-contained build: <code>python3 tools/build_single_file.py</code>
         and open <code>app/firelens-standalone.html</code> directly.</div>`;
    }
  }

  // ==================================================================== shell
  function buildShell() {
    const root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(topbar());
    const body = el('div', { class: 'body' });
    body.appendChild(sidebar());
    body.appendChild(el('main', { class: 'main', id: 'main' }));
    root.appendChild(body);
    global.addEventListener('resize', () => { if (App.map) App.map.resize(); });
    document.addEventListener('keydown', e => {
      if (e.target.matches('input,select,textarea')) return;
      const k = e.key.toLowerCase();
      const map = { '1': 'overview', '2': 'calendar', '3': 'trends', '4': 'map',
                    '5': 'critical', '6': 'lab', '7': 'data' };
      if (map[k]) { setView(map[k]); e.preventDefault(); }
    });
  }

  function logo() {
    return svg('svg', { class: 'mark', viewBox: '0 0 32 32' }, [
      svg('defs', {}, [
        (() => { const g = svg('linearGradient', { id: 'flg', x1: '0', y1: '1', x2: '1', y2: '0' });
          g.appendChild(svg('stop', { offset: '0%', 'stop-color': '#e0561f' }));
          g.appendChild(svg('stop', { offset: '55%', 'stop-color': '#f79218' }));
          g.appendChild(svg('stop', { offset: '100%', 'stop-color': '#ffd24a' }));
          return g; })(),
      ]),
      svg('path', { d: 'M16 2.5c1.6 4.2-.4 6.3-2.2 8.2C11.6 13 9.8 15 10.2 18.4c-1.5-.6-2.6-1.9-3-3.4-1.6 2-2.3 4.4-1.9 6.8.7 4.2 4.4 7.4 8.9 7.7 5.4.4 10-3.4 10.6-8.6.5-4.6-1.9-7.6-4.6-10.6-1.7-1.9-3.4-3.7-4.2-7.8z', fill: 'url(#flg)' }),
      svg('path', { d: 'M16.6 14.6c.9 1.9.1 3-.7 4-.9 1.1-1.4 2-1 3.2.3 1 1.3 1.7 2.4 1.7 1.5 0 2.6-1.2 2.6-2.9 0-2.4-1.6-4.1-3.3-6z', fill: '#0a0f1b', opacity: '.55' }),
    ]);
  }

  function topbar() {
    const st = App.store;
    const bar = el('header', { class: 'topbar' });
    const brand = el('div', { class: 'brand' }, [
      logo(),
      el('div', {}, [
        el('h1', { html: 'FIRE<em>LENS</em>' }),
        el('div', { class: 'sub' }),
      ]),
    ]);
    brand.querySelector('.sub').textContent = 'Harmonised burning-activity calendar';
    bar.appendChild(brand);

    // dataset badge
    const badge = el('div', { class: 'badge gold', id: 'ds-badge' });
    badge.appendChild(el('span', { class: 'dot' }));
    badge.appendChild(el('span', { text: datasetLabel() }));
    bar.appendChild(badge);

    bar.appendChild(el('div', { class: 'tb-spacer' }));

    // AOI
    const g1 = el('div', { class: 'tb-group' });
    g1.appendChild(el('span', { class: 'tb-label', text: 'Area' }));
    const sel = el('select', { id: 'aoi-select', style: 'max-width:290px' });
    let group = null, og = null;
    for (const p of App.presets) {
      if (p.group !== group) { group = p.group; og = el('optgroup', { label: group }); sel.appendChild(og); }
      og.appendChild(el('option', { value: p.type === 'globe' ? 'globe' : p.key, text: p.name }));
    }
    const custom = el('option', { value: '__custom__', text: '✎ Custom area (draw on map)' });
    sel.appendChild(custom);
    sel.value = state.aoi.type === 'globe' ? 'globe'
      : (state.aoi.type === 'province' ? state.aoi.key : '__custom__');
    sel.addEventListener('change', () => {
      if (sel.value === '__custom__') { setView('map'); toast('Drag a rectangle on the map to define your area of interest.'); return; }
      state.aoi = sel.value === 'globe' ? { type: 'globe' } : { type: 'province', key: sel.value };
      refresh();
    });
    g1.appendChild(sel);
    bar.appendChild(g1);

    // period
    const g2 = el('div', { class: 'tb-group' });
    g2.appendChild(el('span', { class: 'tb-label', text: 'Period' }));
    const seg = el('div', { class: 'seg', id: 'period-seg' });
    [['30d', '30d'], ['90d', '90d'], ['ytd', 'Year to date'], ['year', 'Full year'], ['all', 'Whole record']]
      .forEach(([k, lab]) => {
        const b = el('button', { text: lab, class: state.period.preset === k ? 'on' : '' });
        b.addEventListener('click', () => { state.period = { preset: k }; refresh(); });
        seg.appendChild(b);
      });
    g2.appendChild(seg);
    const ys = el('select', { id: 'year-select', style: 'width:78px' });
    const years = yearList();
    for (const y of years) ys.appendChild(el('option', { value: y, text: String(y) }));
    ys.value = String(focusYear());
    ys.addEventListener('change', () => {
      state.period = { preset: state.period.preset === 'year' ? 'year' : 'year', year: +ys.value };
      refresh();
    });
    g2.appendChild(ys);
    bar.appendChild(g2);

    // data quality
    const q = qualityBadge();
    bar.appendChild(q);
    return bar;
  }

  function datasetLabel() {
    const st = App.store;
    if (st.imported) return 'Imported · ' + st.imported.label;
    return `NASA record ${st.y0}–${st.y1}`;
  }

  function yearList() {
    const st = App.store;
    const out = [];
    for (let y = st.y0; y <= st.y1; y++) out.push(y);
    return out;
  }
  function focusYear() {
    if (state.period.year) return state.period.year;
    const [d0, d1] = periodDates();
    return d1.getUTCFullYear();
  }

  function periodDates() {
    const st = App.store;
    const last = st.days[st.ndays - 1];
    switch (state.period.preset) {
      case '30d': return [F.addDays(last, -29), last];
      case '90d': return [F.addDays(last, -89), last];
      case 'ytd': return [new Date(Date.UTC(last.getUTCFullYear(), 0, 1)), last];
      case 'year': { const y = state.period.year || last.getUTCFullYear();
        return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))]; }
      default: return [st.days[0], last];
    }
  }

  function qualityBadge() {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    const [i0, i1] = st.range(...periodDates());
    let bad = 0, gap = 0;
    for (let i = i0; i <= i1; i++) { if (s.quality[i] === 1) bad++; else if (s.quality[i] >= 2) gap++; }
    const cls = bad > (i1 - i0) * 0.2 ? 'critical' : (bad || gap ? 'elevated' : 'ok');
    const b = el('div', { class: 'badge ' + cls, title: `${bad} day(s) with one sensor degraded, ${gap} single-sensor day(s)` });
    b.appendChild(el('span', { class: 'dot' }));
    b.appendChild(el('span', { text: bad || gap ? `${bad + gap} data-quality flag${bad + gap > 1 ? 's' : ''}` : 'Sensors agree' }));
    return b;
  }

  function sidebar() {
    const s = el('nav', { class: 'sidebar' });
    const nav = el('div', { class: 'nav' });
    nav.appendChild(el('div', { class: 'nav-h', text: 'Analyse' }));
    const items = [
      ['overview', 'Overview', 'M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z'],
      ['calendar', 'Burning calendar', 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4'],
      ['trends', 'Trends & steps', 'M3 17l5-6 4 3 6-9M3 21h18'],
      ['map', 'Map', 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14'],
      ['critical', 'Critical periods', 'M12 3l9 16H3zM12 9v5M12 17h.01'],
    ];
    for (const [k, lab, d] of items) nav.appendChild(navBtn(k, lab, d));
    nav.appendChild(el('div', { class: 'nav-h', text: 'Method' }));
    for (const [k, lab, d] of [['lab', 'Harmonisation lab', 'M9 3h6v5l4 8a4 4 0 01-3.5 6h-9A4 4 0 013 16l4-8z'],
                               ['data', 'Data & export', 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01']]) {
      nav.appendChild(navBtn(k, lab, d));
    }
    s.appendChild(nav);
    s.appendChild(aoiPanel());
    s.appendChild(provincePanel());
    s.appendChild(warningPanel());
    s.appendChild(el('div', { class: 'panel', html:
      `<h3>About</h3><div class="note">FireLens harmonises the MODIS and VIIRS active-fire
       records into one comparable burning-activity calendar.<br><br>
       Built for the <b>2026 NASA Space Apps Challenge</b>.<br>
       Keyboard <code>1</code>–<code>7</code> switch views.</div>` }));
    return s;
  }

  function navBtn(key, label, dpath) {
    const b = el('button', { class: state.view === key ? 'on' : '' });
    b.dataset.view = key;
    const ic = svg('svg', { class: 'ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      [svg('path', { d: dpath })]);
    b.appendChild(ic);
    b.appendChild(el('span', { text: label }));
    const idx = ['overview', 'calendar', 'trends', 'map', 'critical', 'lab', 'data'].indexOf(key) + 1;
    b.appendChild(el('span', { class: 'kbd', text: String(idx) }));
    b.addEventListener('click', () => setView(key));
    return b;
  }

  function aoiPanel() {
    const st = App.store;
    const p = el('div', { class: 'panel', id: 'aoi-panel' });
    p.appendChild(el('h3', { text: 'Area of interest' }));
    const s = st.aoiSeries(state.aoi);
    const r = state.aoi.type === 'province' ? st.regionByKey.get(state.aoi.key) : null;
    const rows = [];
    rows.push(['Label', s.label]);
    if (r) {
      rows.push(['Country / basin', r.country]);
      rows.push(['Dominant driver', r.driver]);
      rows.push(['Land cover', r.landcover]);
      rows.push(['Peak day-of-year', r.peak_doy + ' (' + F.fmtDateShort(F.fromDayOfYear(2001, r.peak_doy)) + ')']);
      rows.push(['ENSO sensitivity', (r.enso >= 0 ? '+' : '') + r.enso.toFixed(2) + ' / unit ONI']);
      rows.push(['Long-term trend', (r.trend >= 0 ? '+' : '') + (r.trend * 100).toFixed(1) + ' %/yr']);
    } else if (state.aoi.type === 'bbox') {
      rows.push(['Bounds', `${state.aoi.w.toFixed(1)}°, ${state.aoi.s.toFixed(1)}° → ${state.aoi.e.toFixed(1)}°, ${state.aoi.n.toFixed(1)}°`]);
      const w = st.aoiWeights(state.aoi);
      rows.push(['Coverage', (100 * (w.coverage || 0)).toFixed(0) + '% of provincial intensity']);
      rows.push(['Provinces', w.top.slice(0, 3).map(t => st.regionByKey.get(t[0]).name.split(' ')[0]).join(', ') || '—']);
    }
    for (const [k, v] of rows) {
      const row = el('div', { class: 'row' });
      row.appendChild(el('span', { text: k }));
      row.appendChild(el('span', { text: v }));
      p.appendChild(row);
    }
    if (r && r.notes) p.appendChild(el('div', { class: 'note', style: 'margin-top:8px', text: r.notes }));
    const btns = el('div', { style: 'display:flex;gap:6px;margin-top:9px;flex-wrap:wrap' });
    const b1 = el('button', { class: 'btn sm', text: 'Zoom to area' });
    b1.addEventListener('click', () => { setView('map'); setTimeout(zoomToAoi, 60); });
    const b2 = el('button', { class: 'btn sm', text: 'Whole planet' });
    b2.addEventListener('click', () => { state.aoi = { type: 'globe' }; refresh(); });
    btns.appendChild(b1); btns.appendChild(b2);
    p.appendChild(btns);
    return p;
  }

  function provincePanel() {
    const st = App.store;
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h3', { text: 'Fire provinces' }));
    const inp = el('input', { type: 'text', placeholder: 'Filter…', style: 'width:100%;margin-bottom:7px' });
    const list = el('div', { class: 'prov-list' });
    function fill(q) {
      list.innerHTML = '';
      let group = null;
      for (const pr of App.presets) {
        if (pr.type !== 'province') continue;
        if (q && !(pr.name + pr.country).toLowerCase().includes(q)) continue;
        if (pr.group !== group) { group = pr.group; list.appendChild(el('div', { class: 'g', text: group })); }
        const b = el('button', { text: pr.name, class: state.aoi.type === 'province' && state.aoi.key === pr.key ? 'on' : '' });
        b.addEventListener('click', () => { state.aoi = { type: 'province', key: pr.key }; refresh(); });
        list.appendChild(b);
      }
    }
    inp.addEventListener('input', () => fill(inp.value.toLowerCase().trim()));
    fill('');
    p.appendChild(inp); p.appendChild(list);
    return p;
  }

  function warningPanel() {
    const st = App.store;
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h3', { text: 'Early warning · top 6' }));
    const rows = topWarnings(6);
    if (!rows.length) p.appendChild(el('div', { class: 'note', text: 'Not enough data.' }));
    for (const w of rows) {
      const r = el('div', { class: 'row', style: 'cursor:pointer' });
      r.appendChild(el('span', { html: `<span class="badge ${w.level}" style="font-size:9px;padding:1px 5px">${A.LEVEL_TEXT[w.warn.level]}</span> ${F.esc(w.name)}` }));
      r.appendChild(el('span', { text: (w.warn.ratio > 0 ? w.warn.ratio.toFixed(2) + '×' : '—') }));
      r.addEventListener('click', () => { state.aoi = { type: 'province', key: w.key }; setView('critical'); });
      p.appendChild(r);
    }
    const b = el('button', { class: 'btn sm', style: 'margin-top:9px;width:100%', text: 'Open alert centre →' });
    b.addEventListener('click', () => setView('critical'));
    p.appendChild(b);
    return p;
  }

  function topWarnings(n) {
    const st = App.store;
    const out = [];
    for (const pr of App.presets) {
      if (pr.type !== 'province') continue;
      const s = st.harmonised(pr.key);
      if (st.ndays < 400) continue;
      const w = A.earlyWarning(s.n_harm, st.days, { window: 14 });
      out.push({ key: pr.key, name: pr.name, warn: w, score: isFinite(w.z) ? w.z : -99 });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, n);
  }

  // ==================================================================== views
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.nav button[data-view]').forEach(b =>
      b.classList.toggle('on', b.dataset.view === v));
    const m = document.getElementById('main');
    if (m) { m.scrollTop = 0; }
    render();
  }

  function refresh() {
    buildShell();
    render();
  }

  function render() {
    const m = document.getElementById('main');
    if (!m) return;
    m.innerHTML = '';
    const v = state.view;
    if (v === 'overview') viewOverview(m);
    else if (v === 'calendar') viewCalendar(m);
    else if (v === 'trends') viewTrends(m);
    else if (v === 'map') viewMap(m);
    else if (v === 'critical') viewCritical(m);
    else if (v === 'lab') viewLab(m);
    else if (v === 'data') viewData(m);
  }

  function pageHead(m, title, sub) {
    const h = el('div', { class: 'page-h' });
    h.appendChild(el('div', {}, [el('h2', { text: title }), sub ? el('p', { text: sub }) : null]));
    m.appendChild(h);
  }
  function section(m, title, hint) {
    const s = el('div', { class: 'sec' });
    s.appendChild(el('h2', { text: title }));
    if (hint) s.appendChild(el('p', { class: 'hint', text: hint }));
    m.appendChild(s);
    return s;
  }
  function toast(msg) {
    const t = el('div', { class: 'fl-tip', style: 'left:50%;top:70px;transform:translateX(-50%);display:block;z-index:1000' });
    t.innerHTML = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function zoomToAoi() {
    const st = App.store;
    if (!App.map) return;
    if (state.aoi.type === 'globe') { App.map.scale = 1.5; App.map.cx = 15; App.map.cy = 8; App.map.setAoi(null); }
    else if (state.aoi.type === 'province') {
      const r = st.regionByKey.get(state.aoi.key);
      App.map.fit([r.lon - r.rx * 2.4, r.lat - r.ry * 2.4, r.lon + r.rx * 2.4, r.lat + r.ry * 2.4]);
      App.map.setAoi({ type: 'bbox', w: r.lon - r.rx * 1.8, s: r.lat - r.ry * 1.8, e: r.lon + r.rx * 1.8, n: r.lat + r.ry * 1.8 });
    } else App.map.fit([state.aoi.w, state.aoi.s, state.aoi.e, state.aoi.n]), App.map.setAoi(state.aoi);
    App.map.render();
  }

  // --------------------------------------------------------------- OVERVIEW
  function viewOverview(m) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    const [i0, i1] = st.range(...periodDates());
    const days = st.days.slice(i0, i1 + 1);
    const vals = s.harm.slice(i0, i1 + 1);
    const clim = A.climatology(s.harm, st.days, [50, 75, 90, 95], 9);
    let obs = 0, exp = 0, mod = 0, vir = 0;
    for (let i = i0; i <= i1; i++) {
      obs += s.harm[i]; mod += s.modis[i]; vir += s.viirs[i];
      const mm = clim.mean[F.dayOfYear(st.days[i])];
      if (isFinite(mm)) exp += mm;
    }
    const warn = A.earlyWarning(s.harm, st.days, { clim, window: 14 });
    const cps = A.criticalPeriods(s.harm, st.days, { clim, minEvents: Math.max(5, obs * 0.004) })
      .filter(c => c.end >= days[0] && c.start <= days[days.length - 1]);

    pageHead(m, s.label,
      `Harmonised burning activity for ${F.fmtDate(days[0])} – ${F.fmtDate(days[days.length - 1])}. ` +
      `Counts are true-burning-event equivalents on a single sensor-independent scale, ` +
      `not raw detections.`);

    // KPI cards
    const cards = el('div', { class: 'cards' });
    const anom = exp > 0 ? 100 * (obs / exp - 1) : NaN;
    cards.appendChild(kpi('accent', 'Harmonised events', F.fmtInt(obs),
      `<b>${F.fmtPct(anom, 0)}</b> vs climatology (${F.fmtInt(exp)} expected)`));
    cards.appendChild(kpi(warn.level === 'critical' ? 'bad' : warn.level === 'elevated' ? 'warn' : 'good',
      'Current status', A.LEVEL_TEXT[warn.level],
      `last ${warn.window} d: <b>${F.fmtInt(warn.observed)}</b> vs <b>${F.fmtInt(warn.expected)}</b> expected (z ${warn.z.toFixed(1)})`));
    cards.appendChild(kpi('info', 'Critical periods', String(cps.length),
      cps.length ? `worst: <b>${F.fmtDate(cps.slice().sort((a,b)=>b.anomalyPct-a.anomalyPct)[0].start)}</b>, ` +
        `${F.fmtPct(cps.slice().sort((a,b)=>b.anomalyPct-a.anomalyPct)[0].anomalyPct,0)}` : 'none sustained above the 75th percentile'));
    cards.appendChild(kpi('', 'Raw detections seen', F.fmtInt(mod + vir),
      `MODIS <b>${F.fmtInt(mod)}</b> · VIIRS <b>${F.fmtInt(vir)}</b> — ${vir > 0 && mod > 0 ? (vir / mod).toFixed(1) + '× apart' : 'single-sensor period'}`));
    cards.appendChild(kpi('', 'Sensor agreement', agreementPct() + '%',
      `bridge factor β = <b>${st.bridgeFactor.toFixed(3)}</b>`));
    m.appendChild(cards);

    // The harmonisation gap
    const sec = section(m, 'Why raw counts cannot be compared',
      'The same burning, counted by each sensor and by the harmonised product. Raw VIIRS detections run ' +
      'several times higher than raw MODIS for identical fire activity, and both jump when a satellite is added.');
    const box = el('div', { class: 'box' });
    const years = yearList();
    const annHarm = [], annMod = [], annVir = [], annNaive = [];
    for (const y of years) {
      let h = 0, mm = 0, vv = 0;
      for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y) {
        h += s.harm[i]; mm += s.modis[i]; vv += s.viirs[i];
      }
      annHarm.push(h); annMod.push(mm); annVir.push(vv); annNaive.push(mm + vv);
    }
    box.appendChild(C.lineChart(years, [
      { name: 'Naive MODIS+VIIRS sum', color: '#6b7a94', values: annNaive, dash: true, width: 1.3 },
      { name: 'Raw VIIRS detections', color: F.SENSOR.VIIRS, values: annVir, width: 1.5 },
      { name: 'Raw MODIS detections', color: F.SENSOR.MODIS, values: annMod, width: 1.5 },
      { name: 'Harmonised burning events', color: F.SENSOR.HARM, values: annHarm, width: 2.6, area: true },
    ], {
      height: 290, yLabel: 'events / detections per year',
      markers: observingSystemMarkers(years),
      xTickEvery: Math.max(1, Math.round(years.length / 12)),
    }));
    box.appendChild(el('div', { class: 'note', style: 'margin-top:8px', html:
      'Dashed vertical lines mark changes to the observing system — Aqua joining Terra (2002), VIIRS becoming ' +
      'operational (2012), NOAA-20 (2018) and NOAA-21 (2024). Each produces a step in the raw counts that has ' +
      'nothing to do with fire. The harmonised series removes them.' }));
    sec.appendChild(box);

    // calendar strip
    const sec2 = section(m, 'Burning-activity calendar', 'Every day of the focus year, coloured by departure from its own day-of-year climatology.');
    sec2.appendChild(calendarStrip(s, focusYear(), clim));
    const b = el('button', { class: 'btn sm', style: 'margin-top:9px', text: 'Open the full calendar →' });
    b.addEventListener('click', () => setView('calendar'));
    sec2.appendChild(b);

    // ranked provinces
    const sec3 = section(m, 'Where burning is concentrated', 'Ranked by harmonised events over the selected period; sparkline shows the full 25-year annual record.');
    sec3.appendChild(provinceRanking(s, days, i0, i1));

    // narrative
    const sec4 = section(m, 'Auto-generated briefing', 'Written from the numbers above — no templates filled by hand.');
    const nar = A.narrative(st, state.aoi, s, { year: focusYear() });
    const nd = el('div', { class: 'narr' });
    nar.paragraphs.forEach((p, i) => nd.appendChild(el('p', { class: i === 0 ? 'lede' : '', html: md(p) })));
    sec4.appendChild(nd);
    const nb = el('div', { style: 'display:flex;gap:7px;margin-top:9px;flex-wrap:wrap' });
    const cb = el('button', { class: 'btn sm', text: 'Copy briefing' });
    cb.addEventListener('click', () => {
      navigator.clipboard.writeText(nar.paragraphs.map(p => p.replace(/\*\*/g, '')).join('\n\n'));
      toast('Briefing copied to clipboard.');
    });
    const db = el('button', { class: 'btn sm', text: 'Download full report' });
    db.addEventListener('click', () => exportReport());
    nb.appendChild(cb); nb.appendChild(db);
    sec4.appendChild(nb);
  }

  function kpi(cls, k, v, d) {
    return el('div', { class: 'card ' + cls }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', text: v }),
      el('div', { class: 'd', html: d }),
    ]);
  }
  function agreementPct() {
    const st = App.store;
    const H = st.globalHarm;
    let ok = 0, tot = 0;
    for (let i = 0; i < st.ndays; i++) if (isFinite(H.ratio[i]) && isFinite(H.ratio_baseline[i])) {
      tot++;
      const r = H.ratio[i] / H.ratio_baseline[i];
      if (r >= 0.6 && r <= 1.7) ok++;
    }
    return tot ? Math.round(100 * ok / tot) : 100;
  }
  function observingSystemMarkers(years) {
    const out = [];
    const marks = [[2002, 'Aqua'], [2012, 'VIIRS'], [2018, 'NOAA-20'], [2024, 'NOAA-21']];
    for (const [y, lab] of marks) {
      const i = years.indexOf(y);
      if (i >= 0) out.push({ index: i, label: lab, color: y === 2012 ? '#39d0ff' : '#8ea3c4' });
    }
    return out;
  }

  function calendarStrip(s, year, clim) {
    const st = App.store;
    const cols = 53, rows = 7;
    const cw = 15, ch = 15;
    const W = cols * cw + 40, H = rows * ch + 26;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fl-chart', style: 'max-width:100%' });
    const start = new Date(Date.UTC(year, 0, 1));
    const firstDow = start.getUTCDay();
    for (let k = 0; k < 366; k++) {
      const d = F.addDays(start, k);
      if (d.getUTCFullYear() !== year) break;
      const i = st.dayIndex.get(F.dateToISO(d));
      const col = Math.floor((k + firstDow) / 7), row = (k + firstDow) % 7;
      let color = 'rgba(255,255,255,.045)', tiph = '';
      if (i !== undefined) {
        const v = s.harm[i];
        const doy = F.dayOfYear(d);
        const mu = clim.mean[doy], sd = clim.sd[doy];
        const z = (isFinite(mu) && sd > 1e-9) ? (v - mu) / sd : 0;
        color = zColor(z, v > 0);
        tiph = `<div class="tt-h">${F.fmtDate(d)}</div>harmonised <b>${F.fmtInt(v)}</b> events<br>` +
          `climatology <b>${F.fmtInt(mu)}</b> · z <b>${z.toFixed(2)}</b><br>` +
          `MODIS ${F.fmtInt(s.modis[i])} · VIIRS ${F.fmtInt(s.viirs[i])}` +
          (s.quality[i] === 1 ? '<br><span style="color:#7fb2d6">⚠ one sensor degraded</span>' : '') +
          (s.quality[i] >= 2 ? '<br><span style="color:#f87171">⚠ single-sensor estimate</span>' : '');
      }
      const r = svg('rect', { x: 34 + col * cw, y: 16 + row * ch, width: cw - 2, height: ch - 2,
        fill: color, rx: 2 });
      if (tiph) {
        r.addEventListener('pointerenter', e => C.showTip(e, tiph));
        r.addEventListener('pointermove', e => C.showTip(e, tiph));
        r.addEventListener('pointerleave', C.hideTip);
      }
      root.appendChild(r);
    }
    for (let mo = 0; mo < 12; mo++) {
      const dd = new Date(Date.UTC(year, mo, 1));
      const k = Math.round((dd - start) / F.MS_DAY);
      const col = Math.floor((k + firstDow) / 7);
      root.appendChild(svg('text', { x: 34 + col * cw, y: 11, class: 'ax' },
        [document.createTextNode(F.MONTH_NAMES[mo])]));
    }
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d, i) => {
      if (i % 2 === 1) root.appendChild(svg('text', { x: 4, y: 16 + i * ch + 11, class: 'ax' },
        [document.createTextNode(d)]));
    });
    return root;
  }

  function zColor(z, active) {
    if (!active) return 'rgba(255,255,255,.045)';
    const t = F.clamp((z + 3) / 6, 0, 1);
    return F.ANOM(t);
  }

  function provinceRanking(s, days, i0, i1) {
    const st = App.store;
    const rows = [];
    for (const pr of App.presets) {
      if (pr.type !== 'province') continue;
      const h = st.harmonised(pr.key);
      let tot = 0, exp = 0;
      const clim = A.climatology(h.n_harm, st.days, [50], 9);
      for (let i = i0; i <= i1; i++) {
        tot += h.n_harm[i];
        const mm = clim.mean[F.dayOfYear(st.days[i])];
        if (isFinite(mm)) exp += mm;
      }
      if (tot <= 0) continue;
      const ann = [];
      for (const y of yearList()) {
        let v = 0;
        for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y) v += h.n_harm[i];
        ann.push(v);
      }
      rows.push({ key: pr.key, name: pr.name, total: tot, anom: exp > 0 ? 100 * (tot / exp - 1) : 0, ann });
    }
    rows.sort((a, b) => b.total - a.total);
    const top = rows.slice(0, 14);
    const box = el('div', { class: 'box' });
    const t = el('table', { class: 'tbl' });
    t.innerHTML = `<thead><tr><th>Province</th><th class="num">Harmonised events</th>
      <th class="num">vs climatology</th><th class="num">Share</th><th>25-yr record</th></tr></thead>`;
    const tb = el('tbody');
    const maxTot = top.length ? top[0].total : 1;
    const sumTot = rows.reduce((a, r) => a + r.total, 0) || 1;
    for (const r of top) {
      const tr = el('tr', { class: 'click' });
      tr.appendChild(el('td', { text: r.name }));
      const c1 = el('td', { class: 'num' });
      c1.appendChild(el('div', { class: 'bar', style: `width:${Math.max(4, 100 * r.total / maxTot)}%;margin-bottom:3px` }));
      c1.appendChild(document.createTextNode(F.fmtInt(r.total)));
      tr.appendChild(c1);
      tr.appendChild(el('td', { class: 'num ' + (r.anom > 15 ? 'up' : r.anom < -15 ? 'down' : 'flat'),
        text: F.fmtPct(r.anom, 0) }));
      tr.appendChild(el('td', { class: 'num', text: (100 * r.total / sumTot).toFixed(1) + '%' }));
      const c4 = el('td'); c4.appendChild(C.sparkline(r.ann, { width: 130, height: 22 }));
      tr.appendChild(c4);
      tr.addEventListener('click', () => { state.aoi = { type: 'province', key: r.key }; refresh(); });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    box.appendChild(t);
    return box;
  }

  // --------------------------------------------------------------- CALENDAR
  function viewCalendar(m) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    pageHead(m, 'Burning-activity calendar',
      'The deliverable this challenge asks for: one comparable picture of when and where burning happened, ' +
      'spanning the whole MODIS and VIIRS record. Rows are years, columns are days of the year.');

    // controls
    const ctl = el('div', { class: 'box', style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:14px' });
    ctl.appendChild(el('span', { class: 'tb-label', text: 'Value' }));
    const segM = el('div', { class: 'seg' });
    [['harm', 'Harmonised'], ['modis', 'Raw MODIS'], ['viirs', 'Raw VIIRS']].forEach(([k, lab]) => {
      const b = el('button', { text: lab, class: state.calMetric === k ? 'on' : '' });
      b.addEventListener('click', () => { state.calMetric = k; render(); });
      segM.appendChild(b);
    });
    ctl.appendChild(segM);
    ctl.appendChild(el('span', { class: 'tb-label', text: 'Colour' }));
    const segC = el('div', { class: 'seg' });
    [['absolute', 'Absolute'], ['anomaly', 'Anomaly (z)'], ['percentile', '% of normal']].forEach(([k, lab]) => {
      const b = el('button', { text: lab, class: state.calMode === k ? 'on' : '' });
      b.addEventListener('click', () => { state.calMode = k; render(); });
      segC.appendChild(b);
    });
    ctl.appendChild(segC);
    const legendBox = el('div', { style: 'margin-left:auto' });
    ctl.appendChild(legendBox);
    m.appendChild(ctl);

    const values = state.calMetric === 'modis' ? s.modis : state.calMetric === 'viirs' ? s.viirs : s.harm;
    const clim = A.climatology(values, st.days, [25, 50, 75, 90, 95], 9);
    const years = yearList();
    const matrix = [], rowLabels = [];
    const perYear = [];
    for (const y of years) {
      const nd = F.daysInYear(y);
      const row = new Array(366).fill(null);
      let tot = 0, cnt = 0;
      const cps = [];
      for (let doy = 1; doy <= nd; doy++) {
        const d = F.fromDayOfYear(y, doy);
        const i = st.dayIndex.get(F.dateToISO(d));
        if (i === undefined) continue;
        const v = values[i];
        tot += v; cnt++;
        const mu = clim.mean[doy], sd = clim.sd[doy];
        const z = (isFinite(mu) && sd > 1e-9) ? (v - mu) / sd : 0;
        const ratio = isFinite(mu) && mu > 0 ? v / mu : NaN;
        let color, key;
        if (state.calMode === 'anomaly') { color = v > 0 ? F.ANOM(F.clamp((z + 3) / 6, 0, 1)) : 'rgba(255,255,255,.05)'; key = z; }
        else if (state.calMode === 'percentile') { color = v > 0 ? F.EMBERS(F.clamp(ratio / 3, 0.05, 1)) : 'rgba(255,255,255,.05)'; key = ratio; }
        else { color = v > 0 ? F.EMBERS(F.clamp(Math.log10(1 + v) / Math.log10(1 + (window.__calmax || 1)), 0.05, 1)) : 'rgba(255,255,255,.05)'; key = v; }
        row[doy - 1] = {
          v: key, color,
          quality: s.quality[i] || 0,
          tip: `<div class="tt-h">${F.fmtDate(d)}</div>` +
            `harmonised <b>${F.fmtInt(s.harm[i])}</b> events<br>` +
            `MODIS <b>${F.fmtInt(s.modis[i])}</b> · VIIRS <b>${F.fmtInt(s.viirs[i])}</b><br>` +
            `climatology <b>${F.fmtInt(mu)}</b> · z <b>${z.toFixed(2)}</b> · ` +
            `<b>${isFinite(ratio) ? (ratio * 100).toFixed(0) + '%' : '—'}</b> of normal` +
            (s.quality[i] === 1 ? '<br><span style="color:#7fb2d6">⚠ one sensor degraded; the other carried the estimate</span>' : '') +
            (s.quality[i] === 3 ? '<br><span style="color:#f87171">⚠ implausible single-sensor value — treat as a data gap</span>' : '') +
            (s.quality[i] === 2 && st.days[i] < HZ.VIIRS_START ? '<br><span style="color:#7d8ca8">MODIS-only era (β = ' + st.bridgeFactor.toFixed(3) + ')</span>' : ''),
        };
        if (v > (window.__calmax || 0)) window.__calmax = v;
      }
      row._critical = cps;
      matrix.push(row); rowLabels.push(y);
      perYear.push({ year: y, total: tot, n: cnt });
    }
    // second pass for absolute scaling now that the max is known
    if (state.calMode === 'absolute') {
      const mx = window.__calmax || 1;
      for (const row of matrix) for (const c of row) {
        if (c && c.v > 0) c.color = F.EMBERS(F.clamp(Math.log10(1 + c.v) / Math.log10(1 + mx), 0.05, 1));
      }
    }
    // critical-period overlays
    const cpsAll = A.criticalPeriods(values, st.days, { clim, minEvents: Math.max(5, 0.002 * values.reduce((a, b) => a + b, 0) / Math.max(years.length, 1)) });
    for (const cp of cpsAll) {
      // a period can straddle New Year; draw one clipped bracket per year row
      for (const y of new Set([cp.start.getUTCFullYear(), cp.end.getUTCFullYear()])) {
        const ri = years.indexOf(y);
        if (ri < 0 || !matrix[ri]) continue;
        const last = F.daysInYear(y);
        const c0 = cp.start.getUTCFullYear() === y ? F.dayOfYear(cp.start) - 1 : 0;
        const c1 = cp.end.getUTCFullYear() === y ? F.dayOfYear(cp.end) - 1 : last - 1;
        if (c1 < c0) continue;
        (matrix[ri]._critical || (matrix[ri]._critical = [])).push({ c0, c1, cp });
      }
    }

    const calBox = el('div', { class: 'box', style: 'overflow-x:auto' });
    calBox.appendChild(C.calendarHeatmap(matrix, rowLabels, {
      cellW: 2.7, cellH: 15, marginLeft: 50,
      xLabel: 'day of year →',
    }));
    m.appendChild(calBox);

    legendBox.appendChild(C.legend(
      state.calMode === 'anomaly' ? [[0, '#123a6b'], [.2, '#2b6ca8'], [.38, '#7fb2d6'], [.5, '#12161f'], [.62, '#d99a63'], [.8, '#e0561f'], [1, '#ff2d2d']]
        : [[0, '#0b1020'], [.28, '#5b1f4e'], [.45, '#a52a3c'], [.62, '#e0561f'], [.78, '#f79218'], [1, '#fff6c9']],
      { width: 300, labels: state.calMode === 'anomaly' ? ['−3σ', '−1.5σ', 'normal', '+1.5σ', '+3σ']
        : (state.calMode === 'percentile' ? ['0%', '100%', '200%', '300%+'] : ['0', 'mid', 'max']) }));

    // day-of-year climatology curve
    const sec = section(m, 'Climatology and this year',
      'Grey band: 25th–90th percentile of every year on record. Gold: the focus year.');
    const fy = focusYear();
    const doyX = [], band = [], lo = [], p90 = [], thisY = [];
    const nd = F.daysInYear(fy);
    for (let doy = 1; doy <= 366; doy++) {
      doyX.push(doy);
      lo.push(clim.p[25][doy]); p90.push(clim.p[90][doy]);
      const d = F.fromDayOfYear(fy, doy);
      const i = st.dayIndex.get(F.dateToISO(d));
      thisY.push(i === undefined ? NaN : values[i]);
    }
    const box2 = el('div', { class: 'box' });
    box2.appendChild(C.lineChart(doyX.map(d => F.fmtDateShort(F.fromDayOfYear(fy, d))), [
      { name: '90th percentile', color: '#3a4a66', values: p90, width: 1.2, dash: true },
      { name: '25th percentile', color: '#3a4a66', values: lo, width: 1.2, dash: true },
      { name: 'median', color: '#7d8ca8', values: Array.from({ length: 366 }, (_, i) => clim.mean[i + 1]), width: 1.4 },
      { name: String(fy), color: F.SENSOR.HARM, values: thisY, width: 2.1 },
    ], { height: 240, xTickEvery: 30, yLabel: 'events / day',
         xTickFormat: (l) => l }));
    sec.appendChild(box2);

    // year table
    const sec2 = section(m, 'Year-by-year summary', 'Click a row to make it the focus year.');
    const sm = A.seasonMetrics(values, st.days);
    const t = el('table', { class: 'tbl' });
    t.innerHTML = `<thead><tr><th>Year</th><th class="num">Total events</th><th class="num">vs median</th>
      <th class="num">Peak day</th><th class="num">Season onset</th><th class="num">Cessation</th>
      <th class="num">Length</th><th class="num">Critical periods</th><th class="num">Quality flags</th></tr></thead>`;
    const tb = el('tbody');
    const totals = sm.map(x => x.total).filter(v => v > 0).sort((a, b) => a - b);
    const medTot = totals.length ? F.quantile(Float64Array.from(totals), 0.5) : 0;
    for (const row of sm) {
      const y = row.year;
      let flags = 0;
      for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y && s.quality[i] >= 1) flags++;
      const nc = cpsAll.filter(c => c.start.getUTCFullYear() === y).length;
      const tr = el('tr', { class: 'click' + (y === fy ? ' on' : '') });
      if (y === fy) tr.style.background = 'rgba(255,210,74,.07)';
      tr.appendChild(el('td', { html: `<b>${y}</b>` }));
      tr.appendChild(el('td', { class: 'num', text: F.fmtInt(row.total) }));
      const an = medTot > 0 ? 100 * (row.total / medTot - 1) : 0;
      tr.appendChild(el('td', { class: 'num ' + (an > 15 ? 'up' : an < -15 ? 'down' : 'flat'), text: F.fmtPct(an, 0) }));
      tr.appendChild(el('td', { class: 'num', text: row.peakDate ? F.fmtDateShort(row.peakDate) : '—' }));
      tr.appendChild(el('td', { class: 'num', text: row.onset ? row.onset + ' (' + F.fmtDateShort(F.fromDayOfYear(y, row.onset)) + ')' : '—' }));
      tr.appendChild(el('td', { class: 'num', text: row.cessation ? row.cessation + ' (' + F.fmtDateShort(F.fromDayOfYear(y, row.cessation)) + ')' : '—' }));
      tr.appendChild(el('td', { class: 'num', text: row.length ? row.length + ' d' : '—' }));
      tr.appendChild(el('td', { class: 'num', text: nc ? String(nc) : '—' }));
      tr.appendChild(el('td', { class: 'num', text: flags ? String(flags) : '—' }));
      tr.addEventListener('click', () => { state.period = { preset: 'year', year: y }; refresh(); });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const box3 = el('div', { class: 'box scroller' }); box3.appendChild(t);
    sec2.appendChild(box3);
  }

  // ----------------------------------------------------------------- TRENDS
  function viewTrends(m) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    pageHead(m, 'Trends and the observing-system steps',
      'The reason harmonisation matters: without it, the record reports a trend that is really a change in satellites.');

    const years = yearList();
    const pick = k => k === 'modis' ? s.modis : k === 'viirs' ? s.viirs : k === 'naive'
      ? Float64Array.from(s.modis, (v, i) => v + s.viirs[i]) : s.harm;
    const series = [];
    const ann = {};
    for (const k of ['harm', 'modis', 'viirs', 'naive']) {
      const v = pick(k); ann[k] = [];
      for (const y of years) {
        let t = 0;
        for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y) t += v[i];
        ann[k].push(t);
      }
    }
    const box = el('div', { class: 'box' });
    box.appendChild(C.lineChart(years, [
      { name: 'Naive MODIS+VIIRS sum', color: '#6b7a94', values: ann.naive, dash: true, width: 1.4 },
      { name: 'Raw VIIRS', color: F.SENSOR.VIIRS, values: ann.viirs, width: 1.5 },
      { name: 'Raw MODIS', color: F.SENSOR.MODIS, values: ann.modis, width: 1.5 },
      { name: 'Harmonised', color: F.SENSOR.HARM, values: ann.harm, width: 2.8, area: true },
    ], { height: 320, markers: observingSystemMarkers(years), yLabel: 'events per year',
         xTickEvery: Math.max(1, Math.round(years.length / 12)) }));
    m.appendChild(box);

    // trend table
    const sec = section(m, 'Fitted trends', 'Ordinary least squares on annual totals. The naive sum invents a trend out of platform changes.');
    const rows = [];
    for (const k of [['harm', 'Harmonised'], ['modis', 'Raw MODIS'], ['viirs', 'Raw VIIRS (2012+)', 2012], ['naive', 'Naive sum']]) {
      const from = k[2] || st.y0;
      const xs = [], ys = [];
      years.forEach((y, i) => { if (y >= from && ann[k[0]][i] > 0) { xs.push(y); ys.push(ann[k[0]][i]); } });
      const tr = A.olsTrend(xs, ys);
      rows.push({ name: k[1], pct: 100 * tr.slope / Math.max(F.mean(ys), 1e-9), r2: tr.r2, n: tr.n });
    }
    const t = el('table', { class: 'tbl' });
    t.innerHTML = '<thead><tr><th>Series</th><th class="num">Trend</th><th class="num">R²</th><th class="num">Years used</th><th>Verdict</th></tr></thead>';
    const tb = el('tbody');
    const verdict = { 'Harmonised': 'The defensible estimate.', 'Raw MODIS': 'Misses ~85 % of fires; drifts with platform changes.',
      'Raw VIIRS (2012+)': 'Fine internally, incomparable with the MODIS era.', 'Naive sum': 'Dominated by the 2012/2018/2024 steps — not a fire signal.' };
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: r.name }));
      tr.appendChild(el('td', { class: 'num ' + (r.pct > 0.5 ? 'up' : r.pct < -0.5 ? 'down' : 'flat'), text: F.fmtPct(r.pct, 2) + '/yr' }));
      tr.appendChild(el('td', { class: 'num', text: isFinite(r.r2) ? r.r2.toFixed(3) : '—' }));
      tr.appendChild(el('td', { class: 'num', text: String(r.n) }));
      tr.appendChild(el('td', { class: 'note', text: verdict[r.name] || '' }));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const b1 = el('div', { class: 'box' }); b1.appendChild(t); sec.appendChild(b1);

    // rolling 12-month
    const sec2 = section(m, 'Twelve-month rolling mean', 'Smoothed so single extreme days do not dominate.');
    const roll = A.rollingMean(s.harm, 365);
    const rollM = A.rollingMean(s.modis, 365), rollV = A.rollingMean(s.viirs, 365);
    const idx = [];
    for (let i = 0; i < st.ndays; i += 7) idx.push(i);
    const b2 = el('div', { class: 'box' });
    b2.appendChild(C.lineChart(idx.map(i => st.days[i]), [
      { name: 'Raw MODIS (12-mo)', color: F.SENSOR.MODIS, values: idx.map(i => rollM[i]), width: 1.3, dash: true },
      { name: 'Raw VIIRS (12-mo)', color: F.SENSOR.VIIRS, values: idx.map(i => rollV[i]), width: 1.3, dash: true },
      { name: 'Harmonised (12-mo)', color: F.SENSOR.HARM, values: idx.map(i => roll[i]), width: 2.4, area: true },
    ], { height: 280, yLabel: 'events / day (12-month mean)',
         markers: [2002, 2012, 2018, 2024]
           .map(y => ({ index: idx.findIndex(i => st.days[i].getUTCFullYear() === y), label: String(y) }))
           .filter(mk => mk.index >= 0),
         xTickFormat: d => String(d.getUTCFullYear()), xTickEvery: Math.max(1, Math.round(idx.length / 10)) }));
    sec2.appendChild(b2);

    // season length
    const sec3 = section(m, 'Season phenology', 'Onset = day the cumulative season total passes 10 %; cessation = 90 %.');
    const sm = A.seasonMetrics(s.harm, st.days);
    const b3 = el('div', { class: 'box' });
    const ok = sm.filter(x => x.onset && x.cessation);
    b3.appendChild(C.lineChart(ok.map(x => x.year), [
      { name: 'Onset (day of year)', color: '#4ade80', values: ok.map(x => x.onset), width: 1.8 },
      { name: 'Cessation (day of year)', color: '#f87171', values: ok.map(x => x.cessation), width: 1.8 },
      { name: 'Season length (days)', color: F.SENSOR.HARM, values: ok.map(x => x.length), width: 2.4, dash: true },
    ], { height: 260, yLabel: 'day of year / days', xTickEvery: Math.max(1, Math.round(ok.length / 12)) }));
    if (ok.length > 3) {
      const tl = A.olsTrend(ok.map(x => x.year), ok.map(x => x.length));
      const to = A.olsTrend(ok.map(x => x.year), ok.map(x => x.onset));
      b3.appendChild(el('div', { class: 'note', style: 'margin-top:8px', html:
        `Season length is changing by <b>${tl.slope >= 0 ? '+' : ''}${tl.slope.toFixed(2)} days/year</b> ` +
        `(R² ${isFinite(tl.r2) ? tl.r2.toFixed(3) : '—'}); onset by ` +
        `<b>${to.slope >= 0 ? '+' : ''}${to.slope.toFixed(2)} days/year</b>. ` +
        `A later onset or a longer season shifts the critical period for responders.` }));
    }
    sec3.appendChild(b3);
  }

  // -------------------------------------------------------------------- MAP
  function viewMap(m) {
    const st = App.store;
    pageHead(m, 'Burning map',
      'Spatial distribution of harmonised activity. Fine daily cells are available for the most recent months; ' +
      'older periods use the monthly and yearly climatological grids.');

    const wrap = el('div', { class: 'mapwrap', style: 'height:66vh;min-height:440px' });
    const cv = el('canvas');
    wrap.appendChild(cv);
    m.appendChild(wrap);

    const barTL = el('div', { class: 'mapbar tl' });
    const barTR = el('div', { class: 'mapbar tr' });
    const barBL = el('div', { class: 'mapbar bl' });
    wrap.appendChild(barTL); wrap.appendChild(barTR); wrap.appendChild(barBL);

    // layer control
    const seg = el('div', { class: 'seg' });
    [['harmonised', 'Harmonised'], ['modis', 'MODIS only'], ['viirs', 'VIIRS only'], ['agreement', 'Agreement']]
      .forEach(([k, lab]) => {
        const b = el('button', { text: lab, class: state.mapLayer === k ? 'on' : '' });
        b.addEventListener('click', () => { state.mapLayer = k; App.map.layerMode = k; App.map.render(); refreshMapBars(); });
        seg.appendChild(b);
      });
    barTL.appendChild(seg);

    const tierInfo = el('div', { class: 'chip' });
    barBL.appendChild(tierInfo);
    const readout = el('div', { class: 'chip', style: 'min-width:230px' });
    barBL.appendChild(readout);

    const legend = el('div', { class: 'legendbox' });
    barTR.appendChild(legend);

    const btns = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' });
    const drawBtn = el('button', { class: 'btn', text: '✎ Draw area of interest' });
    drawBtn.addEventListener('click', () => {
      App.map.aoiMode = !App.map.aoiMode;
      cv.classList.toggle('drawing', App.map.aoiMode);
      drawBtn.classList.toggle('on', App.map.aoiMode);
      if (App.map.aoiMode) toast('Drag a rectangle on the map. Release to set it as your area of interest.');
    });
    const zoomBtn = el('button', { class: 'btn', text: '⤢ Zoom to area' });
    zoomBtn.addEventListener('click', zoomToAoi);
    const globeBtn = el('button', { class: 'btn', text: '🌍 Whole planet' });
    globeBtn.addEventListener('click', () => { state.aoi = { type: 'globe' }; refresh(); });
    const projBtn = el('button', { class: 'btn', text: '⇄ Projection' });
    projBtn.addEventListener('click', () => {
      App.map.proj = App.map.proj === 'mercator' ? 'equirect' : 'mercator';
      projBtn.textContent = App.map.proj === 'mercator' ? '⇄ Projection' : '⇄ Equirectangular';
      App.map.render();
    });
    btns.append(drawBtn, zoomBtn, globeBtn, projBtn);
    m.appendChild(btns);

    // period control
    const pc = el('div', { class: 'box', style: 'margin-top:12px;display:flex;gap:16px;align-items:center;flex-wrap:wrap' });
    pc.appendChild(el('span', { class: 'tb-label', text: 'Period' }));
    const seg2 = el('div', { class: 'seg' });
    [['recent', 'Recent days'], ['month', 'A month'], ['year', 'A year']].forEach(([k, lab]) => {
      const b = el('button', { text: lab, class: state.mapDateMode === k ? 'on' : '' });
      b.addEventListener('click', () => { state.mapDateMode = k; render(); });
      seg2.appendChild(b);
    });
    pc.appendChild(seg2);
    const pcRight = el('div', { style: 'display:flex;gap:9px;align-items:center;flex:1;min-width:280px' });
    pc.appendChild(pcRight);
    m.appendChild(pc);

    const opt = el('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:10px' });
    opt.appendChild(el('label', { class: 'chk' }, [
      (() => { const i = el('input', { type: 'checkbox' }); i.checked = state.mapLog;
        i.addEventListener('change', () => { state.mapLog = i.checked; App.map.logScale = i.checked; App.map.render(); refreshMapBars(); });
        return i; })(),
      el('span', { text: 'Logarithmic colour' })]));
    opt.appendChild(el('label', { class: 'chk' }, [
      (() => { const i = el('input', { type: 'checkbox' }); i.checked = App.store ? true : false;
        i.checked = true; i.addEventListener('change', () => { App.map.showProvinces = i.checked; App.map.render(); });
        return i; })(),
      el('span', { text: 'Province boxes' })]));
    const op = el('input', { type: 'range', min: '0.2', max: '1', step: '0.05', style: 'width:130px' });
    op.value = state.mapOpacity;
    op.addEventListener('input', () => { state.mapOpacity = +op.value; App.map.opacity = +op.value; App.map.render(); });
    opt.appendChild(el('span', { class: 'tb-label', text: 'Opacity' })); opt.appendChild(op);
    m.appendChild(opt);

    App.map = new FLMap.FireMap(cv, {
      lon: 15, lat: 8, scale: 1.55,
      onPick: p => {
        const r = provinceAt(p.lat, p.lon);
        if (r) { state.aoi = { type: 'province', key: r.key }; refresh(); }
      },
      onHover: h => {
        if (!h) { readout.textContent = ''; return; }
        const c = h.cell;
        readout.innerHTML = `${h.lat.toFixed(2)}°, ${h.lon.toFixed(2)}°` +
          (c && !c.empty ? ` &nbsp;·&nbsp; MODIS <b>${F.fmtInt(c.modis)}</b> · VIIRS <b>${F.fmtInt(c.viirs)}</b>` +
            ` &nbsp;·&nbsp; harmonised <b>${F.fmtInt(App.map._harmonised(c.modis, c.viirs))}</b>` : ' &nbsp;·&nbsp; no detections');
      },
      onAoiChange: a => {
        state.aoi = a;
        cv.classList.remove('drawing');
        toast('Area of interest set from the drawn rectangle.');
        refresh();
      },
    });
    App.map.setWorld(global.FL_WORLD);
    App.map.layerMode = state.mapLayer;
    App.map.logScale = state.mapLog;
    App.map.opacity = state.mapOpacity;
    App.map.showProvinces = true;
    App.map.setProvinceBoxes(st.regions.filter(r => r.key !== 'global_background'));
    App.map.setAoi(state.aoi.type === 'bbox' ? state.aoi : null);

    async function applyPeriod() {
      let d0, d1, tier;
      const last = st.days[st.ndays - 1];
      if (state.mapDateMode === 'recent') {
        const off = state.mapDayOffset;
        const R = st.gridFiles.recent;
        const rs = R.start_day;
        const maxOff = Math.max(0, R.slices - 1);
        const idx = Math.min(rs + maxOff - off, st.ndays - 1);
        d1 = st.days[Math.max(rs, idx)]; d0 = d1;
        await st.loadRecent('data/', t => tierInfo.textContent = t);
        tier = 'daily';
      } else if (state.mapDateMode === 'month') {
        const mi = state.mapMonth === null ? st.ndays - 30 : state.mapMonth;
        const y = st.y0 + Math.floor(mi / 12), mo = (mi % 12) + 1;
        d0 = new Date(Date.UTC(y, mo - 1, 1));
        d1 = new Date(Date.UTC(y, mo - 1, F.daysInMonth(y, mo)));
        state.mapMonth = mi; tier = 'monthly';
      } else {
        const y = state.mapYear || st.y1;
        d0 = new Date(Date.UTC(y, 0, 1)); d1 = new Date(Date.UTC(y, 11, 31));
        state.mapYear = y; tier = 'yearly';
      }
      const L = st.aggregateGrid(d0, d1);
      App.map.setLayer(L, L, st.H, d1);
      tierInfo.innerHTML = `<b>${F.fmtDate(d0)}${d1 !== d0 ? ' – ' + F.fmtDate(d1) : ''}</b> · ` +
        `${L.tier} tier · ${L.cell}° cells · ${L.idx.length.toLocaleString()} active`;
      refreshMapBars();
    }

    function refreshMapBars() {
      const L = App.map.layer;
      legend.innerHTML = '';
      if (state.mapLayer === 'agreement') {
        legend.appendChild(el('div', { class: 't', text: 'Sensor agreement' }));
        [['#c07bff', 'Both sensors detected'], ['#39d0ff', 'VIIRS only (MODIS missed it)'],
         ['#ff8a3d', 'MODIS only (different overpass / QA)']].forEach(([c, lab]) => {
          const r = el('div', { style: 'display:flex;gap:7px;align-items:center;font-size:11px;color:#b6c3d9;margin-top:3px' });
          r.appendChild(el('span', { style: `width:10px;height:10px;border-radius:2px;background:${c};display:inline-block` }));
          r.appendChild(el('span', { text: lab }));
          legend.appendChild(r);
        });
      } else {
        legend.appendChild(el('div', { class: 't', text: state.mapLayer === 'harmonised' ? 'Harmonised events' : state.mapLayer + ' detections' }));
        legend.appendChild(C.legend([[0, '#0b1020'], [.28, '#5b1f4e'], [.45, '#a52a3c'], [.62, '#e0561f'], [.78, '#f79218'], [1, '#fff6c9']],
          { width: 210, labels: ['0', state.mapLog ? 'log' : 'linear', L ? F.fmtInt(L.__vmax || App.map._vmax || 1) : '1'] }));
      }
    }

    // period widgets
    pcRight.innerHTML = '';
    if (state.mapDateMode === 'recent') {
      const sl = el('input', { type: 'range', min: '0', max: String(Math.max(0, st.gridFiles.recent.slices - 1)), step: '1' });
      sl.value = String(state.mapDayOffset);
      const lab = el('span', { class: 'tb-label', style: 'min-width:120px' });
      sl.addEventListener('input', () => { state.mapDayOffset = +sl.value; applyPeriod(); });
      pcRight.appendChild(el('span', { class: 'tb-label', text: 'Days back' }));
      pcRight.appendChild(sl); pcRight.appendChild(lab);
      const play = el('button', { class: 'btn sm', text: '▶ Animate' });
      let timer = null;
      play.addEventListener('click', () => {
        if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ Animate'; return; }
        play.textContent = '⏸ Pause';
        timer = setInterval(() => {
          state.mapDayOffset = (state.mapDayOffset + 3) % Math.max(1, st.gridFiles.recent.slices);
          sl.value = String(state.mapDayOffset);
          applyPeriod();
        }, 110);
      });
      pcRight.appendChild(play);
    } else if (state.mapDateMode === 'month') {
      const sel = el('select', { style: 'max-width:200px' });
      const nm = (st.y1 - st.y0 + 1) * 12;
      for (let i = nm - 1; i >= 0; i--) {
        const y = st.y0 + Math.floor(i / 12), mo = (i % 12) + 1;
        sel.appendChild(el('option', { value: i, text: F.MONTH_NAMES[mo - 1] + ' ' + y }));
      }
      sel.value = String(state.mapMonth === null ? nm - 1 : state.mapMonth);
      sel.addEventListener('change', () => { state.mapMonth = +sel.value; applyPeriod(); });
      pcRight.appendChild(sel);
    } else {
      const sel = el('select');
      for (const y of yearList()) sel.appendChild(el('option', { value: y, text: String(y) }));
      sel.value = String(state.mapYear || st.y1);
      sel.addEventListener('change', () => { state.mapYear = +sel.value; applyPeriod(); });
      pcRight.appendChild(sel);
    }

    applyPeriod().then(() => { zoomToAoi(); });
  }

  function provinceAt(lat, lon) {
    const st = App.store;
    let best = null, bf = 0.06;
    for (const r of st.regions) {
      if (r.key === 'global_background') continue;
      const dlat = lat - r.lat;
      let dlon = (lon - r.lon + 540) % 360 - 180;
      const t = r.tilt * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
      const u = (dlon * c + dlat * sn) / r.rx, v = (-dlon * sn + dlat * c) / r.ry;
      const f = Math.exp(-0.5 * (u * u + v * v));
      if (f > bf) { bf = f; best = r; }
    }
    return best;
  }

  // -------------------------------------------------------------- CRITICAL
  function viewCritical(m) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    pageHead(m, 'Critical periods and early warning',
      'Sustained elevated burning, detected from the area\'s own climatology — plus the operational status ' +
      'for the days ahead.');

    const clim = A.climatology(s.harm, st.days, [50, 75, 90, 95], 9);
    const warn = A.earlyWarning(s.harm, st.days, { clim, window: 14 });

    // status banner
    const banner = el('div', { class: 'box', style: `border-left:3px solid ${
      warn.level === 'critical' ? 'var(--crimson)' : warn.level === 'elevated' ? 'var(--warn)' :
      warn.level === 'watch' ? 'var(--viirs)' : 'var(--ok)'}` });
    banner.appendChild(el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, [
      el('span', { class: 'badge ' + warn.level }, [el('span', { class: 'dot' }), el('span', { text: A.LEVEL_TEXT[warn.level] })]),
      el('div', { style: 'font-size:13px;color:var(--txt-1)' , html:
        `As of <b>${F.fmtDate(warn.asOf)}</b>, the last ${warn.window} days recorded <b>${F.fmtInt(warn.observed)}</b> ` +
        `harmonised events against a climatological expectation of <b>${F.fmtInt(warn.expected)}</b> ` +
        `(<b>${warn.ratio > 0 ? warn.ratio.toFixed(2) + '×' : '—'}</b>, z = ${warn.z.toFixed(1)}).` }),
    ]));
    const stats = el('div', { class: 'stat-grid', style: 'margin-top:12px' });
    stats.appendChild(statBox('Next climatological peak', warn.climatologicalPeakInDays ? `in ${warn.climatologicalPeakInDays} d` : '—'));
    stats.appendChild(statBox('Expected, next 30 d', F.fmtInt(warn.next30Expected), `90th pct ${F.fmtInt(warn.next30P90)}`));
    stats.appendChild(statBox('Peak daily z-score', warn.peakZ.toFixed(2), 'within the window'));
    stats.appendChild(statBox('Bridge factor β', st.bridgeFactor.toFixed(3), 'MODIS-only era scaling'));
    banner.appendChild(stats);
    m.appendChild(banner);

    // critical periods table
    const fy = focusYear();
    const cps = A.criticalPeriods(s.harm, st.days, { clim, minEvents: Math.max(5, 0.0015 * s.harm.reduce((a, b) => a + b, 0) / yearList().length) });
    const sec = section(m, 'Detected critical burning periods',
      'A period is critical when activity stays at or above the 75th percentile of its own day-of-year climatology ' +
      'for at least 7 days (gaps of up to 3 days are bridged).');
    const ctl = el('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap' });
    ctl.appendChild(el('span', { class: 'tb-label', text: 'Filter year' }));
    const ysel = el('select');
    ysel.appendChild(el('option', { value: 'all', text: 'All years' }));
    for (const y of yearList()) ysel.appendChild(el('option', { value: y, text: String(y) }));
    ysel.value = String(fy);
    ctl.appendChild(ysel);
    ctl.appendChild(el('span', { class: 'note', text: `${cps.length} detected across the whole record` }));
    const tbox = el('div', { class: 'box scroller' });
    sec.appendChild(ctl); sec.appendChild(tbox);
    function drawTable() {
      const yv = ysel.value;
      const list = cps.filter(c => yv === 'all' || c.start.getUTCFullYear() === +yv)
                      .sort((a, b) => b.anomalyPct - a.anomalyPct);
      tbox.innerHTML = '';
      const t = el('table', { class: 'tbl' });
      t.innerHTML = `<thead><tr><th>Start</th><th>End</th><th class="num">Days</th><th class="num">Events</th>
        <th class="num">Expected</th><th class="num">Anomaly</th><th class="num">Peak day</th><th>Severity</th></tr></thead>`;
      const tb = el('tbody');
      const maxA = Math.max(...list.map(c => Math.abs(c.anomalyPct) || 0), 1);
      for (const c of list) {
        const tr = el('tr', { class: 'click' });
        tr.appendChild(el('td', { text: F.fmtDate(c.start) }));
        tr.appendChild(el('td', { text: F.fmtDate(c.end) }));
        tr.appendChild(el('td', { class: 'num', text: String(c.days) }));
        tr.appendChild(el('td', { class: 'num', text: F.fmtInt(c.events) }));
        tr.appendChild(el('td', { class: 'num', text: F.fmtInt(c.expected) }));
        tr.appendChild(el('td', { class: 'num ' + (c.anomalyPct > 0 ? 'up' : 'down'), text: F.fmtPct(c.anomalyPct, 0) }));
        tr.appendChild(el('td', { class: 'num', text: F.fmtDateShort(c.peakDate) + ' · ' + F.fmtInt(c.peak) }));
        const td = el('td');
        const bar = el('div', { class: 'bar', style: `width:${Math.max(4, 100 * Math.abs(c.anomalyPct) / maxA * 0.6)}%;display:inline-block;vertical-align:middle;margin-right:6px` });
        td.appendChild(bar);
        td.appendChild(el('span', { class: 'badge ' + (c.anomalyPct > 200 ? 'critical' : c.anomalyPct > 80 ? 'elevated' : 'watch'),
          text: c.anomalyPct > 200 ? 'severe' : c.anomalyPct > 80 ? 'high' : 'moderate' }));
        tr.appendChild(td);
        tr.addEventListener('click', () => {
          state.period = { preset: 'year', year: c.start.getUTCFullYear() };
          setView('calendar');
        });
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      if (!list.length) t.appendChild(el('tbody', {}, [el('tr', {}, [el('td', { colspan: '8', class: 'note', text: 'No critical periods matched this filter.' })])]));
      tbox.appendChild(t);
    }
    ysel.addEventListener('change', drawTable);
    drawTable();

    // province watch list
    const sec2 = section(m, 'Province watch list',
      'Every fire province scored over the last 14 days. Click a row to switch the area of interest.');
    const rows = [];
    for (const pr of App.presets) {
      if (pr.type !== 'province') continue;
      const h = st.harmonised(pr.key);
      const w = A.earlyWarning(h.n_harm, st.days, { window: 14 });
      if (!isFinite(w.observed) || w.observed <= 0) continue;
      rows.push({ ...pr, w });
    }
    const rank = { critical: 4, elevated: 3, watch: 2, normal: 1, suppressed: 0 };
    rows.sort((a, b) => (rank[b.w.level] - rank[a.w.level]) || (b.w.z - a.w.z));
    const b2 = el('div', { class: 'box scroller' });
    const t2 = el('table', { class: 'tbl' });
    t2.innerHTML = `<thead><tr><th>Province</th><th>Status</th><th class="num">Last 14 d</th>
      <th class="num">Expected</th><th class="num">Ratio</th><th class="num">z</th>
      <th class="num">Next peak</th></tr></thead>`;
    const tb2 = el('tbody');
    for (const r of rows.slice(0, 60)) {
      const tr = el('tr', { class: 'click' });
      tr.appendChild(el('td', { text: r.name }));
      tr.appendChild(el('td', { html: `<span class="badge ${r.w.level}">${A.LEVEL_TEXT[r.w.level]}</span>` }));
      tr.appendChild(el('td', { class: 'num', text: F.fmtInt(r.w.observed) }));
      tr.appendChild(el('td', { class: 'num', text: F.fmtInt(r.w.expected) }));
      tr.appendChild(el('td', { class: 'num', text: r.w.ratio > 0 ? r.w.ratio.toFixed(2) + '×' : '—' }));
      tr.appendChild(el('td', { class: 'num ' + (r.w.z > 3 ? 'up' : ''), text: r.w.z.toFixed(1) }));
      tr.appendChild(el('td', { class: 'num', text: r.w.climatologicalPeakInDays ? 'in ' + r.w.climatologicalPeakInDays + ' d' : '—' }));
      tr.addEventListener('click', () => { state.aoi = { type: 'province', key: r.key }; refresh(); });
      tb2.appendChild(tr);
    }
    t2.appendChild(tb2); b2.appendChild(t2); sec2.appendChild(b2);

    // data quality timeline
    const sec3 = section(m, 'Data-quality flags',
      'Days where the two sensors disagreed beyond tolerance, or where only one sensor was available. ' +
      'These are exactly the days on which a single-sensor product would silently report less burning.');
    const b3 = el('div', { class: 'box' });
    const flags = [];
    for (let i = 0; i < st.ndays; i++) if (s.quality[i] >= 1) flags.push(i);
    if (!flags.length) b3.appendChild(el('div', { class: 'note', text: 'No quality flags were raised for this area.' }));
    else {
      const groups = [];
      let cur = [flags[0], flags[0]];
      for (let k = 1; k < flags.length; k++) {
        if (flags[k] - cur[1] <= 2) cur[1] = flags[k];
        else { groups.push(cur); cur = [flags[k], flags[k]]; }
      }
      groups.push(cur);
      const t3 = el('table', { class: 'tbl' });
      t3.innerHTML = '<thead><tr><th>Window</th><th class="num">Days</th><th>Flag</th><th>Interpretation</th></tr></thead>';
      const tb3 = el('tbody');
      for (const [a, b] of groups.slice(0, 60)) {
        const q = s.quality[a];
        const tr = el('tr');
        tr.appendChild(el('td', { text: F.fmtDate(st.days[a]) + (b > a ? ' – ' + F.fmtDateShort(st.days[b]) : '') }));
        tr.appendChild(el('td', { class: 'num', text: String(b - a + 1) }));
        tr.appendChild(el('td', { html: q === 1 ? '<span class="badge watch">sensor dropout</span>'
          : q === 3 ? '<span class="badge critical">implausible</span>' : '<span class="badge muted">single sensor</span>' }));
        tr.appendChild(el('td', { class: 'note', text: q === 1
          ? 'The two inversions disagreed beyond tolerance; the consistent sensor carried the estimate.'
          : q === 3 ? 'Single-sensor value far below climatology — treat as a data gap, not as low burning.'
          : 'Only one sensor was available; the estimate uses the overlap-calibrated bridge factor.' }));
        tb3.appendChild(tr);
      }
      t3.appendChild(tb3); b3.appendChild(t3);
    }
    sec3.appendChild(b3);
  }

  function statBox(k, v, d) {
    return el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }),
      el('div', { class: 'v', text: v }), d ? el('div', { class: 'note', text: d }) : null]);
  }

  /** Apply lab overrides to the calibration and rebuild every derived series. */
  function reharmonise() {
    const st = App.store;
    const cal = applyOverrides(st.cal, st.labOverride);
    st.provinceCache.clear(); st.aoiCache.clear();
    st.H = new HZ.Harmonizer(cal);
    if (st.imported) { st.H.nModisSats = st.imported.platforms.modis;
                       st.H.nViirsSats = st.imported.platforms.viirs; }
    st.H.bridge = st.H.bridgeFactor(st.globalModis, st.globalViirs, st.days);
    st.bridgeFactor = st.H.bridge;
    st.globalHarm = st.H.series(st.globalModis, st.globalViirs, st.days);
    render();
  }

  const CAL_PATHS = {
    modis_s50: ['modis', 's50'], modis_b: ['modis', 'b'], modis_a: ['modis', 'a'],
    modis_mult: ['modis', 'mult_slope'],
    viirs_s50: ['viirs', 's50'], viirs_b: ['viirs', 'b'], viirs_a: ['viirs', 'a'],
    viirs_mult: ['viirs', 'mult_slope'],
    cluster_s_median: ['cluster_s_median'], cluster_sigma: ['cluster_sigma'],
    rel_sigma_modis: ['rel_sigma_modis'], rel_sigma_viirs: ['rel_sigma_viirs'],
  };
  function applyOverrides(cal, ov) {
    const out = JSON.parse(JSON.stringify(cal));
    if (!ov) return out;
    for (const k in ov) {
      const path = CAL_PATHS[k];
      if (!path) continue;
      let t = out;
      for (let i = 0; i < path.length - 1; i++) t = t[path[i]];
      t[path[path.length - 1]] = ov[k];
    }
    return out;
  }

  // ------------------------------------------------------------------- LAB
  function viewLab(m) {
    const st = App.store;
    pageHead(m, 'Harmonisation lab',
      'The method, its constants, and what happens when you change them. Also runs event-level ' +
      'co-registration on a real NASA FIRMS 24 h snapshot.');

    const s = st.aoiSeries(state.aoi);
    const cal = st.labOverride ? Object.assign({}, st.cal, st.labOverride) : st.cal;

    const sec = section(m, 'What the estimator does', null);
    const box = el('div', { class: 'box' });
    box.appendChild(el('div', { class: 'note', style: 'font-size:13px;color:var(--txt-1)', html: md(
      'A **true** fire event is a burning cluster with a latent size `S` (its total fire radiative power). ' +
      'Each sensor detects it with probability `p(S)` and, if it does, splits it into a number of pixels: ' +
      'a 375 m VIIRS pixel resolves part of a large cluster, a 1 km MODIS pixel integrates several. So the ' +
      'expected detections per true cluster are `a_k = E[ p_k(S) · m_k(S) ]`, and each sensor can be inverted ' +
      'on its own:') }));
    box.appendChild(el('div', { class: 'math', html:
      'N<sub>MODIS</sub> = M / a<sub>M</sub>(date) &nbsp;&nbsp;&nbsp; ' +
      'N<sub>VIIRS</sub> = V / a<sub>V</sub>(date) &nbsp;&nbsp;&nbsp; ' +
      'N<sub>harm</sub> = (w<sub>M</sub>·N<sub>MODIS</sub> + w<sub>V</sub>·N<sub>VIIRS</sub>) / (w<sub>M</sub>+w<sub>V</sub>)' }));
    box.appendChild(el('div', { class: 'note', style: 'font-size:13px;color:var(--txt-1)', html: md(
      '`a_k` is **platform-aware**: adding a satellite multiplies the chances of seeing each fire, so ' +
      '`p` compounds as `1−(1−p₁)ⁿ` and pixel multiplicity grows roughly linearly. Without that term the ' +
      'product would inherit the very steps it exists to remove. Where VIIRS does not yet exist, MODIS is ' +
      'rescaled by an empirical **bridge factor** measured over the overlap period rather than by the modelled ' +
      'absolute sensitivity. Finally the two inversions are cross-checked against their own rolling ratio: ' +
      'a sensor that collapses (safe mode, outage) is discarded for those days and the day is flagged, so a ' +
      'data gap never masquerades as a drop in burning.') }));
    sec.appendChild(box);

    // live constants
    const sec2 = section(m, 'Calibrated constants',
      'Fitted by coordinate descent to 15 summary statistics of a real NASA FIRMS 24 h snapshot ' +
      '(14,217 MODIS and 81,473 VIIRS detections, 14–15 October 2026). Move a slider to see the effect.');
    const b2 = el('div', { class: 'box' });
    const grid = el('div', { class: 'stat-grid' });
    const show = (k, v, d) => grid.appendChild(el('div', { class: 'stat' },
      [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
       el('div', { class: 'note', text: d || '' })]));
    const today = st.days[st.ndays - 1];
    const [amT, avT, nmT, nvT] = st.H.amplitudes(today);
    show('a_MODIS today', amT.toFixed(3), `${nmT} satellite(s) · detections per true cluster`);
    show('a_VIIRS today', avT.toFixed(3), `${nvT} satellite(s)`);
    show('MODIS completeness', (100 * cal.modis_completeness).toFixed(0) + '%', 'of true clusters MODIS reports');
    show('VIIRS completeness', (100 * cal.viirs_completeness).toFixed(0) + '%', 'of true clusters VIIRS reports');
    show('VIIRS multiplicity', cal.viirs_multiplicity.toFixed(2), '375 m pixels per detected cluster');
    show('MODIS multiplicity', cal.modis_multiplicity.toFixed(2), '1 km pixels per detected cluster');
    show('Bridge factor β', st.bridgeFactor.toFixed(3), 'measured on the 2012+ overlap');
    show('Cluster FRP median', cal.cluster_s_median.toFixed(1) + ' MW', 'fitted latent size distribution');
    b2.appendChild(grid);

    // sliders
    const sliders = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:14px' });
    const mk = (label, key, min, max, step, get) => {
      const wrap = el('div');
      const lab = el('div', { class: 'note', html: `${label}: <b id="sv-${key}" style="color:var(--gold);font-family:var(--mono)">${get().toFixed(3)}</b>` });
      const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      inp.value = String(get());
      inp.addEventListener('input', () => {
        document.getElementById('sv-' + key).textContent = (+inp.value).toFixed(3);
        st.labOverride = Object.assign({}, st.labOverride || {}, { [key]: +inp.value });
        clearTimeout(mk._t);
        mk._t = setTimeout(() => reharmonise(), 260);
      });
      wrap.appendChild(lab); wrap.appendChild(inp);
      return wrap;
    };
    sliders.appendChild(mk('MODIS 50 % detection FRP (s₅₀)', 'modis_s50', 10, 200, 1, () => cal.modis.s50));
    sliders.appendChild(mk('MODIS detection width (b)', 'modis_b', 0.2, 2, 0.01, () => cal.modis.b));
    sliders.appendChild(mk('VIIRS 50 % detection FRP (s₅₀)', 'viirs_s50', 0.3, 10, 0.05, () => cal.viirs.s50));
    sliders.appendChild(mk('VIIRS detection width (b)', 'viirs_b', 0.2, 2.5, 0.01, () => cal.viirs.b));
    sliders.appendChild(mk('Cluster FRP median (MW)', 'cluster_s_median', 2, 60, 0.5, () => cal.cluster_s_median));
    sliders.appendChild(mk('Cluster size spread (σ)', 'cluster_sigma', 0.6, 2.4, 0.02, () => cal.cluster_sigma));
    b2.appendChild(sliders);
    const reset = el('button', { class: 'btn sm', style: 'margin-top:10px', text: 'Reset to fitted calibration' });
    reset.addEventListener('click', () => { st.labOverride = null; reharmonise(); });
    b2.appendChild(reset);
    sec2.appendChild(b2);

    // detection curves
    const sec3 = section(m, 'Detection probability and pixel multiplicity',
      'Why the two sensors count differently: MODIS only sees the top of the size distribution, VIIRS sees almost all of it and splits each fire into several pixels.');
    const b3 = el('div', { class: 'box' });
    const Ss = [], pm = [], pv = [], mm = [], mv = [];
    for (let i = 0; i <= 200; i++) {
      const S = Math.exp(Math.log(0.3) + (Math.log(4000) - Math.log(0.3)) * i / 200);
      Ss.push(S);
      pm.push(st.H.modis.p(S) * 100); pv.push(st.H.viirs.p(S) * 100);
      mm.push(st.H.modis.mult(S)); mv.push(st.H.viirs.mult(S));
    }
    const g2 = el('div', { class: 'grid2' });
    const c1 = el('div');
    c1.appendChild(el('div', { class: 'note', style: 'margin-bottom:4px', text: 'Detection probability vs cluster FRP' }));
    c1.appendChild(C.lineChart(Ss.map((S, i) => (i % 10 === 0 ? S.toFixed(S < 10 ? 1 : 0) + ' MW' : '')), [
      { name: 'VIIRS 375 m', color: F.SENSOR.VIIRS, values: pv, width: 2.2 },
      { name: 'MODIS 1 km', color: F.SENSOR.MODIS, values: pm, width: 2.2 },
    ], { height: 240, yLabel: '% detected', xTickEvery: 20 }));
    const c2 = el('div');
    c2.appendChild(el('div', { class: 'note', style: 'margin-bottom:4px', text: 'Pixels reported per detected cluster' }));
    c2.appendChild(C.lineChart(Ss.map((S, i) => (i % 10 === 0 ? S.toFixed(S < 10 ? 1 : 0) + ' MW' : '')), [
      { name: 'VIIRS pixels', color: F.SENSOR.VIIRS, values: mv, width: 2.2 },
      { name: 'MODIS pixels', color: F.SENSOR.MODIS, values: mm, width: 2.2 },
    ], { height: 240, yLabel: 'pixels / cluster', xTickEvery: 20 }));
    g2.appendChild(c1); g2.appendChild(c2);
    b3.appendChild(g2);
    b3.appendChild(el('div', { class: 'note', style: 'margin-top:8px', html:
      'Read together these explain the raw-count gap: VIIRS detects <b>' +
      (100 * cal.viirs_completeness).toFixed(0) + '%</b> of true clusters against MODIS\'s <b>' +
      (100 * cal.modis_completeness).toFixed(0) + '%</b>, and reports <b>' + cal.viirs_multiplicity.toFixed(1) +
      '</b> pixels per cluster against <b>' + cal.modis_multiplicity.toFixed(1) + '</b>. ' +
      'The product of the two ratios is the ~' + (cal.viirs_completeness * cal.viirs_multiplicity /
      Math.max(cal.modis_completeness * cal.modis_multiplicity, 1e-9)).toFixed(1) + '× ' +
      'VIIRS-to-MODIS detection gap measured in the real snapshot.' }));
    sec3.appendChild(b3);

    // live accuracy (synthetic record only)
    if (!st.imported) {
      const sec4 = section(m, 'Accuracy against retained ground truth',
        'The bundled record was generated with a known number of true burning clusters per day. ' +
        'The harmoniser never sees that number; this is an honest out-of-sample check.');
      const b4 = el('div', { class: 'box' });
      const truth = st.globalTruth;
      const seriesList = [
        ['Raw MODIS count', s === st.globalHarm ? st.globalModis : null],
      ];
      const cand = [
        ['Raw MODIS count', st.globalModis, F.SENSOR.MODIS],
        ['Raw VIIRS count', st.globalViirs, F.SENSOR.VIIRS],
        ['Naive MODIS+VIIRS sum', Float64Array.from(st.globalModis, (v, i) => v + st.globalViirs[i]), '#6b7a94'],
        ['Harmonised', st.globalHarm.n_harm, F.SENSOR.HARM],
        ['Ground truth', truth, '#4ade80'],
      ];
      const years = yearList();
      const ann = cand.map(c => [c[0], c[1], c[2], years.map(y => {
        let t = 0; for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y) t += c[1][i];
        return t;
      })]);
      b4.appendChild(C.lineChart(years, ann.slice(0, 4).map(a => ({ name: a[0], color: a[2], values: a[3],
        width: a[0] === 'Harmonised' ? 2.8 : 1.5, dash: a[0] !== 'Harmonised', area: a[0] === 'Harmonised' })),
        { height: 300, yLabel: 'events per year', markers: observingSystemMarkers(years),
          xTickEvery: Math.max(1, Math.round(years.length / 12)) }));
      const tbl = el('table', { class: 'tbl', style: 'margin-top:12px' });
      tbl.innerHTML = '<thead><tr><th>Estimator</th><th class="num">Bias</th><th class="num">NRMSE</th><th class="num">Pearson r</th><th class="num">Spearman ρ</th></tr></thead>';
      const tb = el('tbody');
      const tAnn = years.map(y => { let t = 0; for (let i = 0; i < st.ndays; i++) if (st.days[i].getUTCFullYear() === y) t += truth[i]; return t; });
      for (const [name, vals, color] of cand.slice(0, 4)) {
        const useV = name === 'Raw VIIRS count'
          ? vals.map((v, i) => st.days[i] >= HZ.VIIRS_START ? v : NaN) : Array.from(vals);
        const useT = name === 'Raw VIIRS count'
          ? truth.map((v, i) => st.days[i] >= HZ.VIIRS_START ? v : NaN) : Array.from(truth);
        const pairs = useV.map((v, i) => [v, useT[i]]).filter(p => isFinite(p[0]) && isFinite(p[1]));
        const x = pairs.map(p => p[0]), yv = pairs.map(p => p[1]);
        const bias = 100 * (F.mean(x) / F.mean(yv) - 1);
        const rmse = Math.sqrt(F.mean(x.map((v, i) => (v - yv[i]) ** 2)));
        const tr = el('tr');
        tr.appendChild(el('td', { html: `<span style="color:${color}">■</span> ${name}` }));
        tr.appendChild(el('td', { class: 'num ' + (Math.abs(bias) > 20 ? 'up' : 'down'), text: F.fmtPct(bias, 1) }));
        tr.appendChild(el('td', { class: 'num', text: (100 * rmse / F.mean(yv)).toFixed(1) + '%' }));
        tr.appendChild(el('td', { class: 'num', text: F.pearson(x, yv).toFixed(4) }));
        tr.appendChild(el('td', { class: 'num', text: spearman(x, yv).toFixed(4) }));
        tb.appendChild(tr);
      }
      tbl.appendChild(tb); b4.appendChild(tbl);
      sec4.appendChild(b4);
    }

    // real events lab
    const sec5 = section(m, 'Event-level co-registration on real NASA data',
      'A genuine FIRMS 24 h snapshot (MODIS Terra+Aqua and Suomi NPP VIIRS, 14–15 October 2026). ' +
      'Each MODIS detection is matched to its nearest VIIRS detection within 2 km on the same UTC day.');
    const b5 = el('div', { class: 'box' });
    b5.appendChild(el('div', { class: 'note', text: 'Loading 95,690 real detections…' }));
    sec5.appendChild(b5);
    const run = el('button', { class: 'btn pri', text: 'Run co-registration on the real snapshot' });
    b5.innerHTML = '';
    b5.appendChild(el('div', { class: 'note', style: 'margin-bottom:10px', html:
      'This uses <b>real NASA FIRMS data</b>, not the synthetic record: every detection below is an actual ' +
      'satellite observation. It is the empirical evidence for the detection model above.' }));
    b5.appendChild(run);
    const out = el('div', { style: 'margin-top:14px' });
    b5.appendChild(out);
    run.addEventListener('click', async () => {
      run.disabled = true; run.textContent = 'Working…';
      try {
        const ev = await st.loadEvents('data/');
        await new Promise(r => setTimeout(r, 30));
        const t0 = performance.now();
        const pairs = st.H.spatialMatch(ev.modis, ev.viirs, cal.match_radius_km || 2, 0);
        const ms = performance.now() - t0;
        const dist = pairs.map(p => p.km).sort((a, b) => a - b);
        const ratios = pairs.map(p => ev.modis[p.i].frp / Math.max(ev.viirs[p.j].frp, 1e-3)).sort((a, b) => a - b);
        const vUnmatched = ev.viirs.length - pairs.length;
        const cells = cellStats(ev);
        out.innerHTML = '';
        const g = el('div', { class: 'stat-grid' });
        g.appendChild(statBox('MODIS detections', ev.modis.length.toLocaleString(), 'Terra + Aqua, 24 h'));
        g.appendChild(statBox('VIIRS detections', ev.viirs.length.toLocaleString(), 'Suomi NPP only, 24 h'));
        g.appendChild(statBox('Raw ratio', (ev.viirs.length / ev.modis.length).toFixed(2) + '×', 'VIIRS ÷ MODIS, same burning'));
        g.appendChild(statBox('Matched pairs', pairs.length.toLocaleString(),
          (100 * pairs.length / ev.modis.length).toFixed(1) + '% of MODIS detections, r ≤ 2 km'));
        g.appendChild(statBox('Median separation', F.quantile(Float64Array.from(dist), 0.5).toFixed(2) + ' km',
          'p90 ' + F.quantile(Float64Array.from(dist), 0.9).toFixed(2) + ' km'));
        g.appendChild(statBox('FRP ratio', F.quantile(Float64Array.from(ratios), 0.5).toFixed(2) + '×',
          'MODIS ÷ matched VIIRS: a 1 km pixel integrates several 375 m pixels'));
        g.appendChild(statBox('VIIRS-only detections', vUnmatched.toLocaleString(),
          (100 * vUnmatched / ev.viirs.length).toFixed(1) + '% — fires MODIS structurally cannot see'));
        g.appendChild(statBox('Harmonised estimate', F.fmtInt(st.H.fuse(ev.modis.length, ev.viirs.length,
          F.isoToDate(ev.meta.dates[0]))), 'true clusters for the same 24 h'));
        out.appendChild(g);
        out.appendChild(el('div', { class: 'note', style: 'margin-top:10px', html:
          `Co-registration took <b>${ms.toFixed(0)} ms</b> in the browser. Grid cells: ` +
          `<b>${cells.both.toLocaleString()}</b> contain both sensors, <b>${cells.modisOnly.toLocaleString()}</b> MODIS only, ` +
          `<b>${cells.viirsOnly.toLocaleString()}</b> VIIRS only — the MODIS-only cells are mostly fires observed ` +
          `at a different overpass time or rejected by VIIRS quality screening, which is why the fusion is ` +
          `probabilistic rather than a simple intersection.` }));
        // FRP histograms
        const h = el('div', { class: 'grid2', style: 'margin-top:14px' });
        h.appendChild(frpHistogram(ev.modis.map(x => x.frp), 'MODIS FRP spectrum (real)', F.SENSOR.MODIS));
        h.appendChild(frpHistogram(ev.viirs.map(x => x.frp), 'VIIRS FRP spectrum (real)', F.SENSOR.VIIRS));
        out.appendChild(h);
        // map of matched/unmatched
        const wrap = el('div', { class: 'mapwrap', style: 'height:420px;margin-top:14px' });
        const cv = el('canvas'); wrap.appendChild(cv); out.appendChild(wrap);
        const em = new FLMap.FireMap(cv, { lon: 15, lat: -5, scale: 1.5 });
        em.setWorld(global.FL_WORLD);
        em.setPoints({ modis: ev.modis, viirs: ev.viirs });
        em.layer = null;
        const lg = el('div', { class: 'legendbox', style: 'position:absolute;top:10px;right:10px' });
        lg.innerHTML = '<div class="t">Real FIRMS detections, 24 h</div>' +
          '<div style="font-size:11px;color:#b6c3d9"><span style="color:#ff8a3d">●</span> MODIS 1 km &nbsp; ' +
          '<span style="color:#39d0ff">●</span> VIIRS 375 m</div>';
        wrap.appendChild(lg);
        run.textContent = 'Re-run co-registration'; run.disabled = false;
      } catch (e) {
        out.appendChild(el('div', { class: 'err', text: 'Could not load the real snapshot: ' + e.message }));
        run.disabled = false; run.textContent = 'Retry';
      }
    });
  }

  function cellStats(ev) {
    const C0 = 0.25;
    const key = p => Math.floor(p.lat / C0) + '|' + Math.floor(p.lon / C0) + '|' + p.day;
    const m = new Set(ev.modis.map(key)), v = new Set(ev.viirs.map(key));
    let both = 0; for (const k of m) if (v.has(k)) both++;
    return { both, modisOnly: m.size - both, viirsOnly: v.size - both };
  }

  function frpHistogram(vals, title, color) {
    const bins = 40, lo = Math.log(0.3), hi = Math.log(3000);
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      const x = Math.log(Math.max(v, 0.31));
      const b = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / (hi - lo) * bins)));
      counts[b]++;
    }
    const labels = counts.map((_, i) => i % 6 === 0 ? Math.exp(lo + (hi - lo) * i / bins).toFixed(0) : '');
    const d = el('div');
    d.appendChild(el('div', { class: 'note', style: 'margin-bottom:4px', text: title }));
    d.appendChild(C.lineChart(labels, [{ name: title, color, values: counts, width: 2, area: true }],
      { height: 190, yLabel: 'detections', xTickEvery: 6 }));
    return d;
  }

  function spearman(x, y) {
    const rx = rank(x), ry = rank(y);
    return F.pearson(rx, ry);
  }
  function rank(a) {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const out = new Array(a.length);
    idx.forEach((p, k) => out[p[1]] = k);
    return out;
  }

  // ------------------------------------------------------------------ DATA
  function viewData(m) {
    const st = App.store;
    pageHead(m, 'Data, provenance and export',
      'Import your own NASA FIRMS archive and run exactly the same harmonisation, or export what you see.');

    const tabs = el('div', { class: 'seg', style: 'margin-bottom:14px' });
    [['import', 'Import FIRMS data'], ['export', 'Export'], ['provenance', 'Provenance & method']]
      .forEach(([k, lab]) => {
        const b = el('button', { text: lab, class: state.dataTab === k ? 'on' : '' });
        b.addEventListener('click', () => { state.dataTab = k; render(); });
        tabs.appendChild(b);
      });
    m.appendChild(tabs);

    if (state.dataTab === 'import') importTab(m);
    else if (state.dataTab === 'export') exportTab(m);
    else provenanceTab(m);
  }

  function importTab(m) {
    const st = App.store;
    const box = el('div', { class: 'box' });
    const dz = el('div', { class: 'dropzone', html:
      `<b>Drop NASA FIRMS CSV files here</b> (or click to browse)<br>
       <span class="note">Accepts the standard FIRMS download columns — MODIS C6.1 and VIIRS C2, either
       <code>.csv</code> or zipped shapefile attribute tables. Recognised columns:
       <code>latitude, longitude, bright_ti4/brightness, scan, track, acq_date, acq_time, satellite,
       confidence, frp, daynight</code>. Select several files to combine sensors.</span>` });
    const inp = el('input', { type: 'file', multiple: 'true', accept: '.csv,.txt', style: 'display:none' });
    dz.appendChild(inp);
    dz.addEventListener('click', () => inp.click());
    ['dragover', 'dragenter'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', ev => handleFiles(ev.dataTransfer.files));
    inp.addEventListener('change', () => handleFiles(inp.files));
    box.appendChild(dz);

    const status = el('div', { class: 'note', style: 'margin-top:12px' });
    box.appendChild(status);
    m.appendChild(box);

    const how = el('div', { class: 'box', style: 'margin-top:14px' });
    how.appendChild(el('h3', { style: 'margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-2)', text: 'Where to get the data' }));
    how.appendChild(el('div', { class: 'note', html: md(
      '1. Go to **NASA FIRMS** → [Download Data](https://firms.modaps.eosdis.nasa.gov/download/). \n' +
      '2. Request an area or country, choose **MODIS (Terra and Aqua, NRT)** and **Suomi NPP VIIRS 375 m (NRT)**, ' +
      'and a date range. Free registration gives you an API key.\n' +
      '3. Drop the CSVs here. FireLens detects which sensor each file came from, reads the `satellite` codes to ' +
      'work out how many platforms contributed (so the platform-aware amplitude is right), unifies the confidence ' +
      'vocabularies, aggregates to daily counts per fire province, measures the overlap-period bridge factor, and ' +
      'rebuilds every view.\n\n' +
      'Everything runs locally in your browser — nothing is uploaded.') }));
    m.appendChild(how);

    if (st.imported) {
      const cur = el('div', { class: 'box', style: 'margin-top:14px;border-left:3px solid var(--ok)' });
      cur.appendChild(el('div', { html: `<b>Currently loaded:</b> ${F.esc(st.imported.label)}` }));
      cur.appendChild(el('div', { class: 'note', html:
        `${st.imported.files.map(F.esc).join('<br>')}<br>` +
        `${st.ndays.toLocaleString()} days · ${F.fmtInt(st.globalModis.reduce((a, b) => a + b, 0))} MODIS and ` +
        `${F.fmtInt(st.globalViirs.reduce((a, b) => a + b, 0))} VIIRS detections · ` +
        `bridge factor β = ${st.bridgeFactor.toFixed(3)}` }));
      const back = el('button', { class: 'btn sm', style: 'margin-top:9px', text: 'Restore the bundled 2001–2025 record' });
      back.addEventListener('click', () => location.reload());
      cur.appendChild(back);
      m.appendChild(cur);
    }

    async function handleFiles(files) {
      if (!files || !files.length) return;
      status.innerHTML = 'Reading…';
      try {
        const res = await global.FLImport.importFiles(st, [...files], t => status.innerHTML = F.esc(t));
        status.innerHTML = `<b style="color:var(--ok)">Loaded.</b> ${F.esc(res.summary)}`;
        toast('Imported ' + F.esc(res.summary) + '. All views rebuilt.');
        setTimeout(() => { state.period = { preset: 'all' }; refresh(); }, 900);
      } catch (e) {
        console.error(e);
        status.innerHTML = `<b style="color:var(--bad)">Import failed:</b> ${F.esc(e.message)}`;
      }
    }
  }

  function exportTab(m) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    const [i0, i1] = st.range(...periodDates());
    const box = el('div', { class: 'box' });
    box.appendChild(el('div', { class: 'note', style: 'margin-bottom:12px', html:
      `Exports cover <b>${F.esc(s.label)}</b>, ${F.fmtDate(st.days[i0])} – ${F.fmtDate(st.days[i1])} ` +
      `(${(i1 - i0 + 1).toLocaleString()} days).` }));
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px' });
    const add = (title, desc, fn, name) => {
      const c = el('div', { class: 'card' });
      c.appendChild(el('div', { class: 'k', text: title }));
      c.appendChild(el('div', { class: 'd', style: 'margin-bottom:9px', text: desc }));
      const b = el('button', { class: 'btn sm', text: 'Download' });
      b.addEventListener('click', fn);
      c.appendChild(b);
      grid.appendChild(c);
    };
    add('Daily series (CSV)', 'date, modis, viirs, harmonised, quality flag, climatology, z-score',
      () => F.download(csvName('daily'), dailyCSV(s, i0, i1), 'text/csv'), 'csv');
    add('Critical periods (CSV)', 'start, end, days, events, expected, anomaly %, peak',
      () => {
        const clim = A.climatology(s.harm, st.days, [75, 90], 9);
        const cps = A.criticalPeriods(s.harm, st.days, { clim });
        const rows = [['start', 'end', 'days', 'events', 'expected_events', 'anomaly_pct', 'peak_date', 'peak_events']];
        for (const c of cps) rows.push([F.dateToISO(c.start), F.dateToISO(c.end), c.days,
          c.events.toFixed(1), c.expected.toFixed(1), c.anomalyPct.toFixed(1),
          F.dateToISO(c.peakDate), c.peak.toFixed(1)]);
        F.download(csvName('critical_periods'), rows.map(r => r.join(',')).join('\n'), 'text/csv');
      });
    add('Province summary (CSV)', 'per-province totals, anomalies, trends and current warning level',
      () => F.download(csvName('provinces'), provincesCSV(), 'text/csv'));
    add('Critical periods (GeoJSON)', 'as time-stamped polygons over each province — drop into QGIS or a web map',
      () => F.download(csvName('critical_periods') + '.geojson', criticalGeoJSON(), 'application/geo+json'));
    add('Briefing (Markdown)', 'the auto-generated narrative plus the numbers behind it',
      () => F.download(csvName('briefing') + '.md', briefingMD(s, i0, i1), 'text/markdown'));
    add('Full JSON report', 'everything: calibration, series, critical periods, warnings, provenance',
      () => F.download(csvName('report') + '.json', JSON.stringify(fullReport(s, i0, i1), null, 1), 'application/json'));
    box.appendChild(grid);
    m.appendChild(box);

    const pv = el('div', { class: 'box', style: 'margin-top:14px' });
    pv.appendChild(el('h3', { style: 'margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-2)', text: 'Preview' }));
    const pre = el('textarea', { readonly: 'true', style: 'width:100%;height:230px;font-family:var(--mono);font-size:11.5px' });
    pre.value = dailyCSV(s, i0, Math.min(i1, i0 + 24));
    pv.appendChild(pre);
    m.appendChild(pv);
  }

  function csvName(kind) {
    const st = App.store;
    const s = st.aoiSeries(state.aoi);
    const slug = (s.label || 'aoi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return `firelens-${kind}-${slug}.csv`;
  }
  function dailyCSV(s, i0, i1) {
    const st = App.store;
    const clim = A.climatology(s.harm, st.days, [25, 50, 75, 90], 9);
    const rows = [['date', 'day_of_year', 'modis_detections', 'viirs_detections',
      'harmonised_events', 'climatology_median', 'climatology_p90', 'anomaly_z',
      'pct_of_normal', 'quality_flag']];
    for (let i = i0; i <= i1; i++) {
      const d = st.days[i], doy = F.dayOfYear(d);
      const mu = clim.mean[doy], sd = clim.sd[d];
      rows.push([F.dateToISO(d), doy, (+s.modis[i]).toFixed(0), (+s.viirs[i]).toFixed(0),
        s.harm[i].toFixed(2), isFinite(mu) ? mu.toFixed(2) : '',
        isFinite(clim.p[90][doy]) ? clim.p[90][doy].toFixed(2) : '',
        (isFinite(mu) && sd > 1e-9) ? ((s.harm[i] - mu) / sd).toFixed(3) : '',
        (isFinite(mu) && mu > 0) ? (100 * s.harm[i] / mu).toFixed(1) : '',
        s.quality[i]]);
    }
    return rows.map(r => r.join(',')).join('\n');
  }
  function provincesCSV() {
    const st = App.store;
    const rows = [['province', 'country', 'driver', 'peak_doy', 'total_events',
      'anomaly_vs_climatology_pct', 'trend_pct_per_year', 'warning_level', 'last14d_ratio']];
    for (const pr of App.presets) {
      if (pr.type !== 'province') continue;
      const h = st.harmonised(pr.key);
      const r = st.regionByKey.get(pr.key);
      const clim = A.climatology(h.n_harm, st.days, [50], 9);
      let tot = 0, exp = 0;
      for (let i = 0; i < st.ndays; i++) {
        tot += h.n_harm[i];
        const mu = clim.mean[F.dayOfYear(st.days[i])]; if (isFinite(mu)) exp += mu;
      }
      const ann = A.annualTotals(h.n_harm, st.days);
      const ys = [...ann.keys()].sort(), ys2 = [], tv = [];
      for (const y of ys) if (ann.get(y) > 0) { ys2.push(y); tv.push(ann.get(y)); }
      const tr = A.olsTrend(ys2, tv);
      const w = A.earlyWarning(h.n_harm, st.days, { window: 14 });
      rows.push([pr.key, '"' + (r.country || '') + '"', '"' + (r.driver || '') + '"', r.peak_doy,
        tot.toFixed(0), exp > 0 ? (100 * (tot / exp - 1)).toFixed(1) : '',
        isFinite(tr.slope) ? (100 * tr.slope / Math.max(F.mean(tv), 1e-9)).toFixed(2) : '',
        w.level, isFinite(w.ratio) ? w.ratio.toFixed(3) : '']);
    }
    return rows.map(r => r.join(',')).join('\n');
  }
  function criticalGeoJSON() {
    const st = App.store;
    const feats = [];
    for (const pr of App.presets) {
      if (pr.type !== 'province') continue;
      const h = st.harmonised(pr.key);
      const clim = A.climatology(h.n_harm, st.days, [75], 9);
      const cps = A.criticalPeriods(h.n_harm, st.days, { clim, minEvents: 5 });
      const r = st.regionByKey.get(pr.key);
      for (const c of cps) {
        feats.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[
            [r.lon - r.rx, r.lat - r.ry], [r.lon + r.rx, r.lat - r.ry],
            [r.lon + r.rx, r.lat + r.ry], [r.lon - r.rx, r.lat + r.ry],
            [r.lon - r.rx, r.lat - r.ry]]] },
          properties: { province: pr.key, name: r.name, country: r.country, driver: r.driver,
            start: F.dateToISO(c.start), end: F.dateToISO(c.end), days: c.days,
            events: +c.events.toFixed(1), expected: +c.expected.toFixed(1),
            anomaly_pct: +c.anomalyPct.toFixed(1), peak_date: F.dateToISO(c.peakDate) },
        });
      }
    }
    return JSON.stringify({ type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: feats }, null, 1);
  }
  function briefingMD(s, i0, i1) {
    const st = App.store;
    const nar = A.narrative(st, state.aoi, s, { year: focusYear() });
    const L = [`# FireLens briefing — ${s.label}`, '',
      `Period: ${F.fmtDate(st.days[i0])} to ${F.fmtDate(st.days[i1])}  `,
      `Generated: ${new Date().toISOString()}  `,
      `Record: ${st.imported ? 'user-imported NASA FIRMS data' : `synthetic ${st.y0}–${st.y1}, calibrated on a real FIRMS snapshot`}`,
      '', '## Summary', ''];
    nar.paragraphs.forEach(p => L.push(p.replace(/\*\*/g, '**'), ''));
    L.push('## Calibration', '', '```json', JSON.stringify(st.cal, null, 1), '```', '');
    L.push('## Reproduce', '', '```', 'python3 pipeline/calibrate_real.py',
      'python3 pipeline/simulate_record.py', 'python3 pipeline/validate.py', '```');
    return L.join('\n');
  }
  function fullReport(s, i0, i1) {
    const st = App.store;
    const clim = A.climatology(s.harm, st.days, [25, 50, 75, 90, 95], 9);
    const nar = A.narrative(st, state.aoi, s, { year: focusYear() });
    return {
      product: 'FireLens harmonised burning-activity record',
      generated: new Date().toISOString(),
      area: { label: s.label, aoi: state.aoi },
      period: { start: F.dateToISO(st.days[i0]), end: F.dateToISO(st.days[i1]) },
      record: st.imported ? { kind: 'imported', ...st.imported } : { kind: 'synthetic', y0: st.y0, y1: st.y1,
        note: st.meta.record_note },
      calibration: st.cal,
      bridge_factor: st.bridgeFactor,
      totals: {
        modis_detections: sum(s.modis, i0, i1), viirs_detections: sum(s.viirs, i0, i1),
        harmonised_events: sum(s.harm, i0, i1),
      },
      warning: nar.warning,
      critical_periods: nar.critical.map(c => ({ start: F.dateToISO(c.start), end: F.dateToISO(c.end),
        days: c.days, events: c.events, expected: c.expected, anomaly_pct: c.anomalyPct })),
      narrative: nar.paragraphs,
      observing_system: st.meta.observing_system,
      provenance: st.meta.record_note,
    };
  }
  function sum(a, i0, i1) { let t = 0; for (let i = i0; i <= i1; i++) t += a[i] || 0; return +t.toFixed(1); }

  function provenanceTab(m) {
    const st = App.store;
    const box = el('div', { class: 'box' });
    const meta = st.meta;
    box.appendChild(el('div', { class: 'note', style: 'font-size:13px', html: md(meta.record_note) }));
    box.appendChild(el('hr', { class: 'sep' }));
    const dl = el('dl', { class: 'kv' });
    const add = (k, v) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); };
    add('Record span', `${meta.y0}-01-01 to ${meta.y1}-12-31 (${meta.ndays.toLocaleString()} days)`);
    add('Native grid', `${meta.grid.cell}° × ${meta.grid.cell}°, ${meta.grid.nlat}×${meta.grid.nlon} cells, land only`);
    add('Monthly climatology grid', `${st.gridFiles.monthly.cell}°, ${st.gridFiles.monthly.slices} slices`);
    add('Yearly climatology grid', `${st.gridFiles.yearly.cell}°, ${st.gridFiles.yearly.slices} slices`);
    add('Daily fine grid', `${st.gridFiles.recent.cell}° for the most recent ${st.gridFiles.recent.slices} days`);
    add('Generated', meta.generated);
    add('Random seed', String(meta.seed));
    add('Burnable-cell fraction', String(meta.p_hot));
    add('Global scale K', Number(meta.K).toFixed(4));
    add('Bridge factor β', st.bridgeFactor.toFixed(4));
    box.appendChild(dl);
    box.appendChild(el('hr', { class: 'sep' }));
    box.appendChild(el('h3', { style: 'margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-2)', text: 'Observing-system timeline used' }));
    const t = el('table', { class: 'tbl' });
    t.innerHTML = '<thead><tr><th>Family</th><th>From</th><th class="num">Satellites</th></tr></thead>';
    const tb = el('tbody');
    for (const fam of ['MODIS', 'VIIRS']) for (const [d, n] of meta.observing_system[fam]) {
      const tr = el('tr'); tr.appendChild(el('td', { text: fam }));
      tr.appendChild(el('td', { text: d })); tr.appendChild(el('td', { class: 'num', text: String(n) }));
      tb.appendChild(tr);
    }
    t.appendChild(tb); box.appendChild(t);
    box.appendChild(el('div', { class: 'note', style: 'margin-top:8px', text: meta.observing_system.note || '' }));
    if (meta.outages && meta.outages.length) {
      box.appendChild(el('hr', { class: 'sep' }));
      box.appendChild(el('h3', { style: 'margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-2)', text: 'Injected data-quality artefacts' }));
      const t2 = el('table', { class: 'tbl' });
      t2.innerHTML = '<thead><tr><th>Sensor</th><th>From</th><th>To</th><th class="num">Retention</th></tr></thead>';
      const tb2 = el('tbody');
      for (const [s, a, b, f] of meta.outages) {
        const tr = el('tr');
        tr.appendChild(el('td', { text: s })); tr.appendChild(el('td', { text: a }));
        tr.appendChild(el('td', { text: b })); tr.appendChild(el('td', { class: 'num', text: (f * 100).toFixed(0) + '%' }));
        tb2.appendChild(tr);
      }
      t2.appendChild(tb2); box.appendChild(t2);
      box.appendChild(el('div', { class: 'note', style: 'margin-top:6px', text:
        'Synthetic safe-mode windows, included so the gap-handling logic can be demonstrated. They are not a log of real incidents.' }));
    }
    box.appendChild(el('hr', { class: 'sep' }));
    box.appendChild(el('h3', { style: 'margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt-2)', text: 'Real NASA data included' }));
    box.appendChild(el('div', { class: 'note', html: md(
      'The **Harmonisation lab** runs on a genuine NASA FIRMS 24 h archive snapshot: ' +
      '`MODIS_C6_1_Global_24h` (Terra + Aqua) and `SUOMI_VIIRS_C2_Global_24h` (Suomi NPP), ' +
      'downloaded from <https://firms.modaps.eosdis.nasa.gov/data/active_fire/>. ' +
      'The same snapshot is what the sensor model was fitted to. NASA FIRMS data are free to use; ' +
      'see NASA\'s data usage policy and cite the FIRMS/LANCE product.\n\n' +
      'Country boundaries: Natural Earth 110 m, public domain.') }));
    m.appendChild(box);
  }

  // ------------------------------------------------------------------ markdown
  function md(s) {
    return F.esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/&lt;(https?:[^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--viirs)">$1</a>')
      .replace(/\n/g, '<br>');
  }

  // ------------------------------------------------------------------- export
  function exportReport() {
    const st = App.store, s = st.aoiSeries(state.aoi);
    const [i0, i1] = st.range(...periodDates());
    F.download(csvName('report') + '.json', JSON.stringify(fullReport(s, i0, i1), null, 1), 'application/json');
    toast('Report downloaded.');
  }

  global.FLApp = { App, state, boot, setView, refresh };
  document.addEventListener('DOMContentLoaded', boot);
})(typeof window !== 'undefined' ? window : globalThis);
