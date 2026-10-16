/* FireLens — dependency-free canvas map engine.
 *
 * No Leaflet, no tile server, no network: countries come from an embedded
 * Natural Earth TopoJSON and fire data is drawn straight from the payload grids.
 * Supports Web Mercator and equirectangular projections, smooth pan/zoom, an AOI
 * rectangle tool and hit-testing.
 */
(function (global) {
  'use strict';
  const F = global.FL;

  class FireMap {
    constructor(canvas, opts) {
      opts = opts || {};
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.proj = opts.proj || 'mercator';       // 'mercator' | 'equirect'
      this.cx = opts.lon === undefined ? 15 : opts.lon;
      this.cy = opts.lat === undefined ? 5 : opts.lat;
      this.scale = opts.scale || 1.6;            // world widths across the canvas
      this.dpr = global.devicePixelRatio || 1;
      this.countries = null;
      this.land = null;
      this.layer = null;                          // aggregated grid layer
      this.points = null;                         // event layer
      this.aoi = null;
      this.provinces = [];
      this.showProvinces = true;
      this.showGrid = false;
      this.layerMode = 'harmonised';              // harmonised|modis|viirs|agreement
      this.logScale = true;
      this.opacity = 0.9;
      this.hover = null;
      this.onPick = opts.onPick || null;
      this.onHover = opts.onHover || null;
      this.onAoiChange = opts.onAoiChange || null;
      this._drag = null;
      this._aoiDrag = null;
      this.aoiMode = false;
      this._bind();
      this.resize();
    }

    setWorld(topo) {
      this.countries = F.topoFeatures(topo, 'countries');
      this.render();
    }

    resize() {
      const r = this.c.parentElement.getBoundingClientRect();
      const w = Math.max(200, r.width), h = Math.max(200, r.height);
      this.c.width = Math.round(w * this.dpr);
      this.c.height = Math.round(h * this.dpr);
      this.c.style.width = w + 'px';
      this.c.style.height = h + 'px';
      this.w = w; this.h = h;
      this.render();
    }

    // ------------------------------------------------------------------ projection
    project(lon, lat) {
      if (this.proj === 'equirect') {
        const pxPerDeg = (this.w * this.scale) / 360;
        return [this.w / 2 + (lon - this.cx) * pxPerDeg,
                this.h / 2 - (lat - this.cy) * pxPerDeg];
      }
      const R = (this.w * this.scale) / (2 * Math.PI);
      const x = this.w / 2 + R * (lon - this.cx) * Math.PI / 180;
      const sy = Math.sin(Math.max(-85, Math.min(85, this.cy)) * Math.PI / 180);
      const yc = Math.log((1 + sy) / (1 - sy)) / 2;
      const s2 = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
      const y = this.h / 2 - R * (Math.log((1 + s2) / (1 - s2)) / 2 - yc);
      return [x, y];
    }
    unproject(x, y) {
      if (this.proj === 'equirect') {
        const pxPerDeg = (this.w * this.scale) / 360;
        return [this.cx + (x - this.w / 2) / pxPerDeg,
                this.cy - (y - this.h / 2) / pxPerDeg];
      }
      const R = (this.w * this.scale) / (2 * Math.PI);
      const lon = this.cx + (x - this.w / 2) / R * 180 / Math.PI;
      const sy = Math.sin(Math.max(-85, Math.min(85, this.cy)) * Math.PI / 180);
      const yc = Math.log((1 + sy) / (1 - sy)) / 2;
      const yy = yc - (y - this.h / 2) / R;
      const e = Math.exp(2 * yy);
      const lat = Math.asin(Math.max(-0.9999, Math.min(0.9999, (e - 1) / (e + 1)))) * 180 / Math.PI;
      return [lon, lat];
    }
    fit(bbox, pad) {
      pad = pad === undefined ? 0.14 : pad;
      const [w, s, e, n] = bbox;
      this.cx = (w + e) / 2; this.cy = (s + n) / 2;
      const spanLon = Math.max(e - w, 2), spanLat = Math.max(n - s, 2);
      this.scale = Math.min(this.w / (spanLon * (this.w / 360)) * (1 - pad),
                            this.h / (spanLat * (this.w / 360)) * (1 - pad));
      this.scale = Math.max(0.6, Math.min(this.scale, 220));
      this.render();
    }

    // ------------------------------------------------------------------- rendering
    render() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, '#070b14'); g.addColorStop(1, '#0b1220');
      ctx.fillStyle = g; ctx.fillRect(0, 0, this.w, this.h);
      this._graticule();
      this._countries();
      if (this.layer) this._layer();
      if (this.points) this._points();
      if (this.showProvinces && this.provinces.length) this._provinces();
      this._aoi();
      this._scaleBar();
    }

    _graticule() {
      const ctx = this.ctx;
      ctx.strokeStyle = 'rgba(120,150,200,0.10)';
      ctx.lineWidth = 1;
      const step = this.scale > 20 ? 5 : (this.scale > 6 ? 10 : (this.scale > 2 ? 30 : 30));
      ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += step) {
        const p0 = this.project(lon, -85), p1 = this.project(lon, 85);
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      }
      for (let lat = -80; lat <= 80; lat += step) {
        const p0 = this.project(-180, lat), p1 = this.project(180, lat);
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(150,180,230,0.28)';
      ctx.beginPath();
      const eq = this.project(-180, 0), eq2 = this.project(180, 0);
      ctx.moveTo(eq[0], eq[1]); ctx.lineTo(eq2[0], eq2[1]); ctx.stroke();
    }

    _countries() {
      if (!this.countries) return;
      const ctx = this.ctx;
      ctx.lineJoin = 'round';
      for (const f of this.countries) {
        ctx.beginPath();
        for (const poly of f.polys) for (const ring of poly) {
          let first = true;
          for (let i = 0; i < ring.length; i += 2) {
            const p = this.project(ring[i], ring[i + 1]);
            if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
        }
        ctx.fillStyle = '#131c2c';
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(120,155,205,0.32)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    _provinces() {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,210,74,0.30)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      for (const p of this.provinces) {
        const a = this.project(p.bbox[0], p.bbox[3]);
        const b = this.project(p.bbox[2], p.bbox[1]);
        ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      }
      ctx.restore();
    }

    _layer() {
      const L = this.layer, ctx = this.ctx;
      const cell = L.cell, nlon = L.nlon;
      const latMin = this._latMin, lonMin = this._lonMin;
      // value accessor + colour scale
      const vals = new Float64Array(L.idx.length);
      let vmax = 0;
      for (let k = 0; k < L.idx.length; k++) {
        let v;
        if (this.layerMode === 'modis') v = L.modis[k];
        else if (this.layerMode === 'viirs') v = L.viirs[k];
        else if (this.layerMode === 'agreement') {
          const m = L.modis[k], vv = L.viirs[k];
          v = (m > 0 && vv > 0) ? 2 : (vv > 0 ? 1 : 0);
        } else v = this._harmonised(L.modis[k], L.viirs[k]);
        vals[k] = v; if (v > vmax) vmax = v;
      }
      const denom = this.logScale ? Math.log10(1 + vmax) : Math.max(vmax, 1e-9);
      for (let k = 0; k < L.idx.length; k++) {
        const c = L.idx[k];
        const gi = (c / nlon) | 0, gj = c % nlon;
        const lat0 = latMin + gi * cell, lon0 = lonMin + gj * cell;
        const lat1 = lat0 + cell;
        let p0, p1;
        if (this.proj === 'equirect') {
          p0 = this.project(lon0, lat1); p1 = this.project(lon0 + cell, lat0);
        } else {
          p0 = this.project(Math.max(lon0, -180), Math.min(lat1, 85));
          p1 = this.project(Math.min(lon0 + cell, 180), Math.max(lat0, -85));
        }
        const x = p0[0], y = p0[1], w = Math.max(p1[0] - p0[0], 1), h = Math.max(p1[1] - p0[1], 1);
        if (x + w < -2 || x > this.w + 2 || y + h < -2 || y > this.h + 2) continue;
        let t = vals[k] <= 0 ? 0 : (this.logScale ? Math.log10(1 + vals[k]) / Math.max(denom, 1e-9)
                                                  : vals[k] / denom);
        let col;
        if (this.layerMode === 'agreement') {
          col = vals[k] === 2 ? 'rgba(192,123,255,0.85)'
              : vals[k] === 1 ? 'rgba(57,208,255,0.75)' : 'rgba(255,138,61,0.85)';
        } else {
          col = F.EMBERS(Math.max(0.06, t), this.opacity);
        }
        ctx.fillStyle = col;
        ctx.fillRect(x, y, w + 0.6, h + 0.6);
      }
      this._vmax = vmax;
    }

    _harmonised(m, v) {
      const H = this._H;
      if (!H) return m + v;
      const [am, av] = H.amplitudes(this._layerDate || new Date());
      // fuse with the same inverse-variance weights used everywhere else
      const sm = H.cal.rel_sigma_modis || 0.35, sv = H.cal.rel_sigma_viirs || 0.12;
      const wm = 1 / (sm * sm), wv = 1 / (sv * sv);
      const nm = am > 0 ? m / am : NaN, nv = av > 0 ? v / av : NaN;
      if (isFinite(nm) && isFinite(nv)) return (nm * wm + nv * wv) / (wm + wv);
      if (isFinite(nv)) return nv;
      if (isFinite(nm)) return nm * H.bridge;
      return 0;
    }

    _points() {
      const ctx = this.ctx, P = this.points;
      const r = Math.max(1.1, Math.min(4.5, 1.1 * Math.sqrt(this.scale)));
      for (const arr of [P.modis, P.viirs]) {
        for (const p of arr) {
          const q = this.project(p.lon, p.lat);
          if (q[0] < -5 || q[0] > this.w + 5 || q[1] < -5 || q[1] > this.h + 5) continue;
          ctx.beginPath();
          ctx.arc(q[0], q[1], p.sensor === 'MODIS' ? r * 1.25 : r, 0, 6.2832);
          ctx.fillStyle = p.sensor === 'MODIS' ? 'rgba(255,138,61,0.85)' : 'rgba(57,208,255,0.7)';
          ctx.fill();
        }
      }
    }

    _aoi() {
      if (!this.aoi) return;
      const ctx = this.ctx;
      const a = this.project(this.aoi.w, this.aoi.n), b = this.project(this.aoi.e, this.aoi.s);
      ctx.save();
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.fillStyle = 'rgba(255,210,74,0.07)';
      ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.restore();
    }

    _scaleBar() {
      const ctx = this.ctx;
      const [x0] = this.project(this.cx - 5, this.cy), [x1] = this.project(this.cx + 5, this.cy);
      const px = Math.abs(x1 - x0);
      if (!(px > 4)) return;
      const w = px, y = this.h - 22;
      ctx.strokeStyle = 'rgba(220,230,250,0.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.w / 2 - w / 2, y); ctx.lineTo(this.w / 2 + w / 2, y);
      ctx.moveTo(this.w / 2 - w / 2, y - 4); ctx.lineTo(this.w / 2 - w / 2, y + 4);
      ctx.moveTo(this.w / 2 + w / 2, y - 4); ctx.lineTo(this.w / 2 + w / 2, y + 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(220,230,250,0.75)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('10°', this.w / 2, y - 7);
    }

    // ---------------------------------------------------------------- interaction
    _bind() {
      const c = this.c;
      c.style.touchAction = 'none';
      c.addEventListener('pointerdown', e => {
        c.setPointerCapture(e.pointerId);
        const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.aoiMode) {
          const [lon, lat] = this.unproject(x, y);
          this._aoiDrag = { x0: lon, y0: lat, x1: lon, y1: lat };
        } else {
          this._drag = { x, y, cx: this.cx, cy: this.cy };
        }
      });
      c.addEventListener('pointermove', e => {
        const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this._aoiDrag) {
          const [lon, lat] = this.unproject(x, y);
          this._aoiDrag.x1 = lon; this._aoiDrag.y1 = lat;
          const a = this._aoiDrag;
          this.aoi = { w: Math.min(a.x0, a.x1), e: Math.max(a.x0, a.x1),
                       s: Math.min(a.y0, a.y1), n: Math.max(a.y0, a.y1) };
          this.render();
          return;
        }
        if (this._drag) {
          const d = this._drag;
          if (this.proj === 'equirect') {
            const pxPerDeg = (this.w * this.scale) / 360;
            this.cx = d.cx - (x - d.x) / pxPerDeg;
            this.cy = d.cy + (y - d.y) / pxPerDeg;
          } else {
            const R = (this.w * this.scale) / (2 * Math.PI);
            this.cx = d.cx - (x - d.x) / R * 180 / Math.PI;
            const sy = Math.sin(Math.max(-85, Math.min(85, d.cy)) * Math.PI / 180);
            const yc = Math.log((1 + sy) / (1 - sy)) / 2 - (y - d.y) / R * -1;
            const e2 = Math.exp(2 * (Math.log((1 + sy) / (1 - sy)) / 2 + (y - d.y) / R));
            this.cy = Math.asin(Math.max(-0.9999, Math.min(0.9999, (e2 - 1) / (e2 + 1)))) * 180 / Math.PI;
          }
          this.cx = ((this.cx + 180) % 360 + 360) % 360 - 180;
          this.cy = Math.max(-85, Math.min(85, this.cy));
          this.render();
          return;
        }
        const [lon, lat] = this.unproject(x, y);
        const hit = this._hitCell(lon, lat);
        this.hover = { x, y, lon, lat, cell: hit };
        if (this.onHover) this.onHover(this.hover);
      });
      const up = e => {
        if (this._aoiDrag) {
          const a = this._aoiDrag;
          this._aoiDrag = null;
          if (Math.abs(a.x1 - a.x0) > 0.4 && Math.abs(a.y1 - a.y0) > 0.4 && this.onAoiChange) {
            this.aoiMode = false;
            this.onAoiChange({ type: 'bbox', w: +this.aoi.w.toFixed(3), e: +this.aoi.e.toFixed(3),
                               s: +this.aoi.s.toFixed(3), n: +this.aoi.n.toFixed(3) });
          }
        }
        this._drag = null;
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('pointerleave', () => { this.hover = null; if (this.onHover) this.onHover(null); });
      c.addEventListener('click', e => {
        if (this.aoiMode || this._drag) return;
        const r = c.getBoundingClientRect();
        const [lon, lat] = this.unproject(e.clientX - r.left, e.clientY - r.top);
        if (this.onPick) this.onPick({ lon, lat, cell: this._hitCell(lon, lat) });
      });
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0016);
        const r = c.getBoundingClientRect();
        const [lon0, lat0] = this.unproject(e.clientX - r.left, e.clientY - r.top);
        this.scale = Math.max(0.6, Math.min(this.scale * f, 400));
        const [lon1, lat1] = this.unproject(e.clientX - r.left, e.clientY - r.top);
        this.cx += lon0 - lon1; this.cy += lat0 - lat1;
        this.cx = ((this.cx + 180) % 360 + 360) % 360 - 180;
        this.cy = Math.max(-85, Math.min(85, this.cy));
        this.render();
      }, { passive: false });
    }

    _hitCell(lon, lat) {
      if (!this.layer) return null;
      const L = this.layer;
      let gj = Math.floor((lon - this._lonMin) / L.cell);
      const gi = Math.floor((lat - this._latMin) / L.cell);
      if (gi < 0 || gi >= L.nlat) return null;
      if (gj < 0) gj += L.nlon; if (gj >= L.nlon) gj -= L.nlon;
      const c = gi * L.nlon + gj;
      let lo = 0, hi = L.idx.length - 1, found = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (L.idx[m] === c) { found = m; break; } if (L.idx[m] < c) lo = m + 1; else hi = m - 1; }
      if (found < 0) return { idx: c, modis: 0, viirs: 0, lat, lon, empty: true };
      return { idx: c, modis: L.modis[found], viirs: L.viirs[found], lat, lon };
    }

    setLayer(layer, gridMeta, H, date) {
      this.layer = layer;
      this._latMin = gridMeta ? gridMeta.lat_min : -60;
      this._lonMin = gridMeta ? gridMeta.lon_min : -180;
      this._H = H; this._layerDate = date;
      this.render();
    }
    setPoints(points) { this.points = points; this.render(); }
    setAoi(a) {
      this.aoi = (a && a.type === 'bbox') ? { w: a.w, s: a.s, e: a.e, n: a.n } : null;
      this.render();
    }
    setProvinceBoxes(list) { this.provinces = list || []; this.render(); }
  }

  global.FLMap = { FireMap };
})(typeof window !== 'undefined' ? window : globalThis);
