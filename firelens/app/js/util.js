/* FireLens — low-level utilities: binary decoding, dates, colour, formatting.
 *
 * No external dependencies. Everything the app needs to run offline lives here
 * or in the sibling modules.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- base64 -> bytes
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------- gzip
  async function gunzipBytes(bytes) {
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (global.pako) return new Uint8Array(global.pako.ungzip(bytes));
    throw new Error('No gzip decoder available (need DecompressionStream or pako).');
  }

  async function fetchGzJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    // tolerate an already-decompressed payload
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const raw = await gunzipBytes(buf);
      return JSON.parse(new TextDecoder().decode(raw));
    }
    return JSON.parse(new TextDecoder().decode(buf));
  }

  async function fetchGzBytes(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipBytes(buf);
    return buf;
  }

  // ---------------------------------------------------------------- varint reader
  /** Streaming reader for the varint streams produced by pipeline/simulate_record.py */
  class VarReader {
    constructor(bytes) { this.b = bytes; this.i = 0; }
    next() {
      let result = 0, shift = 0, byte;
      do {
        byte = this.b[this.i++];
        result |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      return result >>> 0;
    }
    get pos() { return this.i; }
    seek(p) { this.i = p; return this; }
  }

  /**
   * Decode a sparse grid blob.
   * Layout: header(nslices, ncols, lenI, lenM, lenV) then stream I, M, V.
   * Returns an array of {idx:Int32Array, modis:Uint16Array, viirs:Uint16Array}.
   */
  function readSparseGrid(bytes) {
    const r = new VarReader(bytes);
    const nslices = r.next(), ncols = r.next();
    const lenI = r.next(), lenM = r.next(), lenV = r.next();
    const offI = r.pos, offM = offI + lenI, offV = offM + lenM;
    const ri = new VarReader(bytes.subarray(offI, offM));
    const rm = new VarReader(bytes.subarray(offM, offV));
    const rv = new VarReader(bytes.subarray(offV, offV + lenV));
    const out = new Array(nslices);
    for (let s = 0; s < nslices; s++) {
      const n = ri.next();
      // Int32, not Uint16: an annual total in a 1 deg cell can exceed a million
      // detections, and a silently wrapping counter would corrupt every map layer.
      const idx = new Int32Array(n), mm = new Int32Array(n), vv = new Int32Array(n);
      let prev = 0;
      for (let k = 0; k < n; k++) { prev += ri.next(); idx[k] = prev; }
      for (let k = 0; k < n; k++) mm[k] = rm.next();
      for (let k = 0; k < n; k++) vv[k] = rv.next();
      out[s] = { idx, modis: mm, viirs: vv, ncols };
    }
    out.ncols = ncols;
    return out;
  }

  /** Decode a province-raster blob: varint n, then n x (deltaCellIndex, share*SCALE). */
  function readProvinceRaster(bytes, scale) {
    const r = new VarReader(bytes);
    const n = r.next();
    const cells = new Int32Array(n), share = new Float32Array(n);
    let prev = 0;
    for (let k = 0; k < n; k++) { prev += r.next(); cells[k] = prev; share[k] = r.next() / scale; }
    return { cells, share };
  }

  function readInt32Array(b64) {
    const bytes = b64ToBytes(b64);
    return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  function readFloat32Array(b64) {
    const bytes = b64ToBytes(b64);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  /** Decode a varint-encoded integer series (base64). */
  function readVarintSeries(b64) {
    const r = new VarReader(b64ToBytes(b64));
    const n = r.next();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = r.next();
    return out;
  }

  // ---------------------------------------------------------------- dates
  const MS_DAY = 86400000;
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInYear(y) { return isLeap(y) ? 366 : 365; }
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function daysInMonth(y, m) { return m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]; }

  /** yyyy-mm-dd -> integer day index from 0000-12-31 (proleptic), via Date.UTC */
  function dateToISO(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function isoToDate(s) {
    const p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function addDays(d, n) { return new Date(d.getTime() + n * MS_DAY); }
  function dayOfYear(d) {
    const y = d.getUTCFullYear();
    let n = d.getUTCDate();
    for (let m = 1; m < d.getUTCMonth() + 1; m++) n += daysInMonth(y, m);
    return n;
  }
  function fromDayOfYear(y, doy) {
    let m = 1, rem = doy;
    while (m <= 12 && rem > daysInMonth(y, m)) { rem -= daysInMonth(y, m); m++; }
    return new Date(Date.UTC(y, m - 1, Math.min(rem, daysInMonth(y, Math.min(m, 12)))));
  }
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) { return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtDateShort(d) { return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()]; }

  // ---------------------------------------------------------------- numbers
  function fmtInt(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    if (a >= 100) return Math.round(v).toLocaleString('en-US');
    if (a >= 1) return v.toFixed(a >= 10 ? 0 : 1);
    return v.toFixed(2);
  }
  function fmtPct(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(dp === undefined ? 1 : dp) + '%';
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function median(a) { const s = Float64Array.from(a).sort(); return quantile(s, 0.5); }
  function mean(a) { let s = 0, n = 0; for (const v of a) if (isFinite(v)) { s += v; n++; } return n ? s / n : NaN; }
  function stdev(a) {
    const m = mean(a); let s = 0, n = 0;
    for (const v of a) if (isFinite(v)) { s += (v - m) * (v - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  }
  function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return NaN;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i] - mx, b = y[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : NaN;
  }

  // ---------------------------------------------------------------- colour
  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function ramp(stops) {
    const rgb = stops.map(s => hexToRgb(s[1]));
    const pos = stops.map(s => s[0]);
    return function (t, alpha) {
      t = clamp(t, 0, 1);
      let i = 0;
      while (i < pos.length - 2 && t > pos[i + 1]) i++;
      const t0 = pos[i], t1 = pos[i + 1];
      const f = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
      const c0 = rgb[i], c1 = rgb[i + 1];
      const r = Math.round(lerp(c0[0], c1[0], f));
      const g = Math.round(lerp(c0[1], c1[1], f));
      const b = Math.round(lerp(c0[2], c1[2], f));
      return alpha === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
    };
  }

  /** Sequential "embers" ramp: the signature FireLens scale for burning intensity. */
  const EMBERS = ramp([
    [0.00, '#0b1020'], [0.12, '#241a3a'], [0.28, '#5b1f4e'],
    [0.45, '#a52a3c'], [0.62, '#e0561f'], [0.78, '#f79218'],
    [0.90, '#ffd24a'], [1.00, '#fff6c9'],
  ]);
  /** Diverging ramp for anomalies (blue = below climatology, red = above). */
  const ANOM = ramp([
    [0.00, '#123a6b'], [0.20, '#2b6ca8'], [0.38, '#7fb2d6'],
    [0.50, '#12161f'], [0.62, '#d99a63'], [0.80, '#e0561f'],
    [1.00, '#ff2d2d'],
  ]);
  const SENSOR = { MODIS: '#ff8a3d', VIIRS: '#39d0ff', BOTH: '#c07bff', HARM: '#ffd24a' };

  // ---------------------------------------------------------------- DOM helpers
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, children) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === null || attrs[k] === undefined) continue;
      // SVG rejects negative geometry; clamp instead of throwing console errors
      if ((k === 'width' || k === 'height') && typeof attrs[k] === 'number' && attrs[k] < 0) continue;
      if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => { if (c != null) n.appendChild(c); });
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function download(name, text, mime) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  // ---------------------------------------------------------------- TopoJSON (minimal)
  function topoFeatures(topo, name) {
    const tr = topo.transform, sx = tr.scale[0], sy = tr.scale[1], tx = tr.translate[0], ty = tr.translate[1];
    const arcs = topo.arcs.map(arc => {
      const out = new Float64Array(arc.length * 2);
      let x = 0, y = 0;
      for (let i = 0; i < arc.length; i++) {
        x += arc[i][0]; y += arc[i][1];
        out[i * 2] = x * sx + tx; out[i * 2 + 1] = y * sy + ty;
      }
      return out;
    });
    function ring(refs) {
      const pts = [];
      for (const ref of refs) {
        const a = ref < 0 ? arcs[~ref] : arcs[ref];
        const n = a.length / 2;
        if (ref < 0) { for (let i = n - 1; i >= 0; i--) pts.push(a[i * 2], a[i * 2 + 1]); }
        else { for (let i = 0; i < n; i++) pts.push(a[i * 2], a[i * 2 + 1]); }
      }
      return pts;
    }
    const feats = [];
    for (const g of topo.objects[name].geometries) {
      const polys = [];
      if (g.type === 'Polygon') polys.push(g.arcs.map(ring));
      else if (g.type === 'MultiPolygon') for (const p of g.arcs) polys.push(p.map(ring));
      feats.push({ name: (g.properties && g.properties.name) || '', polys });
    }
    return feats;
  }

  global.FL = {
    b64ToBytes, gunzipBytes, fetchGzJSON, fetchGzBytes,
    VarReader, readSparseGrid, readProvinceRaster,
    readInt32Array, readFloat32Array, readVarintSeries,
    MS_DAY, isLeap, daysInYear, daysInMonth, dateToISO, isoToDate, addDays,
    dayOfYear, fromDayOfYear, MONTH_NAMES, fmtDate, fmtDateShort,
    fmtInt, fmtPct, clamp, lerp, quantile, median, mean, stdev, pearson,
    hexToRgb, ramp, EMBERS, ANOM, SENSOR,
    el, svg, esc, download, topoFeatures,
  };
})(typeof window !== 'undefined' ? window : globalThis);
