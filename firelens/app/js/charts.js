/* FireLens — SVG chart primitives. No charting library, no canvas needed.
 *
 * Every chart returns an <svg> node and supports hover tooltips through a shared
 * delegate so the whole app has one consistent interaction model.
 */
(function (global) {
  'use strict';
  const F = global.FL;
  const S = F.svg;

  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = F.el('div', { class: 'fl-tip', style: 'display:none' });
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(evt, html) {
    const t = tip();
    t.innerHTML = html; t.style.display = 'block';
    const r = t.getBoundingClientRect();
    let x = evt.clientX + 14, y = evt.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y < 8) y = evt.clientY + 18;
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / e;
    const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * e;
  }
  function ticks(maxV, count) {
    const step = niceMax(maxV / (count || 4));
    const out = [];
    for (let v = 0; v <= maxV + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /**
   * Multi-series time/line chart.
   * series: [{name, color, values:Float64Array|Array, dash?:bool, width?:num, area?:bool}]
   * x: array of labels or Date objects; opts: {height, yLabel, markers:[{index,label,color}],
   *      xTickEvery, logY, onHover}
   */
  function lineChart(x, series, opts) {
    opts = opts || {};
    const W = opts.width || 900, H = opts.height || 240;
    const ml = 56, mr = 16, mt = 26, mb = 30;
    const iw = W - ml - mr, ih = H - mt - mb;
    let vmax = 0;
    for (const s of series) for (const v of s.values) if (isFinite(v) && v > vmax) vmax = v;
    vmax = niceMax(vmax * 1.08) || 1;
    const n = x.length;
    const X = i => ml + (n > 1 ? iw * i / (n - 1) : iw / 2);
    const Y = v => mt + ih - ih * (v / vmax);

    const root = S('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fl-chart', preserveAspectRatio: 'none' });
    // gridlines
    for (const t of ticks(vmax, 4)) {
      root.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(t), y2: Y(t), stroke: 'rgba(140,165,205,.13)' }));
      root.appendChild(S('text', { x: ml - 7, y: Y(t) + 4, 'text-anchor': 'end', class: 'ax' },
        [document.createTextNode(F.fmtInt(t))]));
    }
    // x ticks
    const every = opts.xTickEvery || Math.max(1, Math.round(n / 8));
    for (let i = 0; i < n; i += every) {
      const lab = x[i] instanceof Date
        ? (opts.xTickFormat ? opts.xTickFormat(x[i]) : String(x[i].getUTCFullYear()))
        : String(x[i]);
      root.appendChild(S('line', { x1: X(i), x2: X(i), y1: mt + ih, y2: mt + ih + 4, stroke: 'rgba(140,165,205,.3)' }));
      root.appendChild(S('text', { x: X(i), y: H - 10, 'text-anchor': 'middle', class: 'ax' },
        [document.createTextNode(lab)]));
    }
    // markers (observing-system changes etc.)
    for (const m of (opts.markers || [])) {
      const xi = X(m.index);
      root.appendChild(S('line', { x1: xi, x2: xi, y1: mt, y2: mt + ih, stroke: m.color || '#8ea3c4',
        'stroke-dasharray': '3 3', 'stroke-width': 1, opacity: .55 }));
      if (m.label) root.appendChild(S('text', { x: xi + 4, y: mt + 10, class: 'ax', fill: m.color || '#8ea3c4' },
        [document.createTextNode(m.label)]));
    }
    // series
    for (const s of series) {
      if (s.area) {
        let d = `M ${X(0)} ${Y(0)}`;
        for (let i = 0; i < n; i++) d += ` L ${X(i)} ${Y(Math.max(0, s.values[i] || 0))}`;
        d += ` L ${X(n - 1)} ${Y(0)} Z`;
        root.appendChild(S('path', { d, fill: s.color, opacity: .13, stroke: 'none' }));
      }
      let d = '', started = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (!isFinite(v)) { started = false; continue; }
        d += (started ? ' L ' : ' M ') + X(i).toFixed(2) + ' ' + Y(v).toFixed(2);
        started = true;
      }
      root.appendChild(S('path', { d, fill: 'none', stroke: s.color,
        'stroke-width': s.width || 1.7, 'stroke-dasharray': s.dash ? '4 3' : null,
        'stroke-linejoin': 'round', opacity: s.opacity === undefined ? 1 : s.opacity }));
    }
    if (opts.yLabel) root.appendChild(S('text', { x: 0, y: 12, class: 'ax' },
      [document.createTextNode(opts.yLabel)]));
    // hover
    if (opts.onHover !== false) {
      const crosshair = S('line', { y1: mt, y2: mt + ih, stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1, opacity: 0 });
      root.appendChild(crosshair);
      const hit = S('rect', { x: ml, y: mt, width: iw, height: ih, fill: 'transparent' });
      root.appendChild(hit);
      hit.addEventListener('pointermove', e => {
        const r = root.getBoundingClientRect();
        const px = (e.clientX - r.left) * (W / r.width);
        const i = Math.round((px - ml) / iw * (n - 1));
        if (i < 0 || i >= n) return;
        crosshair.setAttribute('x1', X(i)); crosshair.setAttribute('x2', X(i));
        crosshair.setAttribute('opacity', 1);
        const rows = series.map(s => `<span style="color:${s.color}">■</span> ${F.esc(s.name)}: <b>${F.fmtInt(s.values[i])}</b>`);
        const lab = x[i] instanceof Date ? F.fmtDate(x[i]) : String(x[i]);
        showTip(e, `<div class="tt-h">${F.esc(lab)}</div>${rows.join('<br>')}`);
        if (opts.onHover) opts.onHover(i, e);
      });
      hit.addEventListener('pointerleave', () => { crosshair.setAttribute('opacity', 0); hideTip(); });
      hit.addEventListener('click', e => {
        const r = root.getBoundingClientRect();
        const px = (e.clientX - r.left) * (W / r.width);
        const i = Math.round((px - ml) / iw * (n - 1));
        if (opts.onClick && i >= 0 && i < n) opts.onClick(i, e);
      });
    }
    return root;
  }

  /** Simple bar chart (annual totals, ranked provinces, …). */
  function barChart(items, opts) {
    opts = opts || {};
    const W = opts.width || 900, H = opts.height || 220;
    const ml = opts.marginLeft === undefined ? 56 : opts.marginLeft;
    const mr = 14, mt = 12, mb = opts.marginBottom === undefined ? 34 : opts.marginBottom;
    const iw = W - ml - mr, ih = H - mt - mb;
    const vmax = niceMax(Math.max(...items.map(d => Math.abs(d.value || 0)), 1e-9) * 1.08);
    const bw = iw / Math.max(items.length, 1);
    const Y = v => mt + ih - ih * (v / vmax);
    const root = S('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fl-chart' });
    for (const t of ticks(vmax, 4)) {
      root.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(t), y2: Y(t), stroke: 'rgba(140,165,205,.13)' }));
      root.appendChild(S('text', { x: ml - 7, y: Y(t) + 4, 'text-anchor': 'end', class: 'ax' },
        [document.createTextNode(F.fmtInt(t))]));
    }
    items.forEach((d, i) => {
      const x = ml + i * bw + bw * 0.14, w = bw * 0.72;
      const v = d.value || 0;
      const y = v >= 0 ? Y(v) : Y(0);
      const h = Math.abs(Y(v) - Y(0));
      const r = S('rect', { x, y, width: Math.max(w, 1), height: Math.max(h, 0.6),
        fill: d.color || '#e0561f', rx: 1.5, opacity: d.opacity === undefined ? .92 : d.opacity });
      if (d.title) {
        r.addEventListener('pointerenter', e => showTip(e, d.title));
        r.addEventListener('pointermove', e => showTip(e, d.title));
        r.addEventListener('pointerleave', hideTip);
      }
      if (d.onClick) { r.style.cursor = 'pointer'; r.addEventListener('click', d.onClick); }
      root.appendChild(r);
      if (d.badge) root.appendChild(S('text', { x: x + w / 2, y: y - 4, 'text-anchor': 'middle',
        class: 'ax', fill: d.badgeColor || '#ffd24a' }, [document.createTextNode(d.badge)]));
      if (bw > 22 && d.label) {
        root.appendChild(S('text', { x: x + w / 2, y: H - 12, 'text-anchor': 'middle', class: 'ax',
          transform: bw < 40 ? `rotate(-55 ${x + w / 2} ${H - 12})` : null },
          [document.createTextNode(d.label)]));
      }
    });
    return root;
  }

  /** Tiny inline sparkline. */
  function sparkline(values, opts) {
    opts = opts || {};
    const W = opts.width || 120, H = opts.height || 26;
    let vmax = 0; for (const v of values) if (isFinite(v) && v > vmax) vmax = v;
    vmax = vmax || 1;
    let d = '';
    for (let i = 0; i < values.length; i++) {
      const x = (W * i) / Math.max(values.length - 1, 1);
      const y = H - 2 - (H - 4) * (values[i] / vmax);
      d += (i ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return S('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'fl-spark' },
      [S('path', { d, fill: 'none', stroke: opts.color || '#f79218', 'stroke-width': 1.3 })]);
  }

  /**
   * The burning-activity calendar: day-of-year (columns) x year (rows).
   * This is the deliverable the challenge asks for.
   */
  function calendarHeatmap(matrix, rowLabels, opts) {
    opts = opts || {};
    const cw = opts.cellW || 2.6, ch = opts.cellH || 15;
    const ml = opts.marginLeft || 54, mt = opts.marginTop || 26, mr = 12, mb = 34;
    const cols = matrix[0] ? matrix[0].length : 366;
    const rows = matrix.length;
    const W = ml + cols * cw + mr, H = mt + rows * ch + mb;
    const root = S('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fl-chart fl-cal', width: '100%' });

    // month header
    let dayAcc = 0;
    for (let m = 0; m < 12; m++) {
      const nd = F.daysInMonth(2001, m + 1);
      root.appendChild(S('text', { x: ml + (dayAcc + nd / 2) * cw, y: mt - 9, 'text-anchor': 'middle', class: 'ax' },
        [document.createTextNode(F.MONTH_NAMES[m])]));
      root.appendChild(S('line', { x1: ml + dayAcc * cw, x2: ml + dayAcc * cw, y1: mt - 4, y2: mt + rows * ch,
        stroke: 'rgba(140,165,205,.18)' }));
      dayAcc += nd;
    }
    root.appendChild(S('line', { x1: ml + 365 * cw, x2: ml + 365 * cw, y1: mt - 4, y2: mt + rows * ch,
      stroke: 'rgba(140,165,205,.18)' }));

    for (let r = 0; r < rows; r++) {
      root.appendChild(S('text', { x: ml - 8, y: mt + r * ch + ch * 0.72, 'text-anchor': 'end', class: 'ax' },
        [document.createTextNode(String(rowLabels[r]))]));
      const row = matrix[r];
      for (let c = 0; c < cols; c++) {
        const cell = row[c];
        if (!cell || cell.v === null || cell.v === undefined || !isFinite(cell.v)) continue;
        const rect = S('rect', {
          x: ml + c * cw, y: mt + r * ch, width: cw + 0.35, height: ch - (opts.gap === undefined ? 1.6 : opts.gap),
          fill: cell.color, opacity: cell.opacity === undefined ? 1 : cell.opacity,
        });
        if (cell.quality) rect.setAttribute('stroke', cell.quality === 3 ? '#ff4d4d' : '#7fb2d6');
        if (cell.quality) rect.setAttribute('stroke-width', '0.7');
        if (cell.tip) {
          rect.addEventListener('pointerenter', e => showTip(e, cell.tip));
          rect.addEventListener('pointermove', e => showTip(e, cell.tip));
          rect.addEventListener('pointerleave', hideTip);
        }
        if (cell.onClick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', cell.onClick); }
        root.appendChild(rect);
      }
      // critical-period brackets
      for (const cp of (row._critical || [])) {
        root.appendChild(S('rect', { x: ml + cp.c0 * cw, y: mt + r * ch - 1.5,
          width: (cp.c1 - cp.c0 + 1) * cw, height: ch + 1,
          fill: 'none', stroke: '#ffd24a', 'stroke-width': 1.1, rx: 1.5, opacity: .9 }));
      }
    }
    if (opts.xLabel) root.appendChild(S('text', { x: ml + cols * cw / 2, y: H - 8, 'text-anchor': 'middle', class: 'ax' },
      [document.createTextNode(opts.xLabel)]));
    return root;
  }

  /** Colour legend bar. */
  function legend(stops, opts) {
    opts = opts || {};
    const W = opts.width || 260, H = 34;
    const id = 'lg' + Math.random().toString(36).slice(2, 8);
    const root = S('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'fl-legend' });
    const defs = S('defs');
    const lg = S('linearGradient', { id, x1: '0', x2: '1' });
    for (const [p, c] of stops) lg.appendChild(S('stop', { offset: (p * 100) + '%', 'stop-color': c }));
    defs.appendChild(lg); root.appendChild(defs);
    root.appendChild(S('rect', { x: 0, y: 4, width: W, height: 10, fill: `url(#${id})`, rx: 2 }));
    const labels = opts.labels || [];
    labels.forEach((t, i) => {
      root.appendChild(S('text', { x: (W * i) / Math.max(labels.length - 1, 1), y: 28,
        'text-anchor': i === 0 ? 'start' : (i === labels.length - 1 ? 'end' : 'middle'), class: 'ax' },
        [document.createTextNode(t)]));
    });
    return root;
  }

  global.FLCharts = { lineChart, barChart, sparkline, calendarHeatmap, legend,
                      showTip, hideTip, niceMax, ticks };
})(typeof window !== 'undefined' ? window : globalThis);
