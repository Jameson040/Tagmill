// Virtual grid: renders only the visible window of a (potentially 50k+) collection.
// Thumbnail object URLs are managed by a strict LRU — memory stays bounded no matter the scroll depth.

import { $, el, hashColor, debounce } from './util.js';
import * as db from './db.js';

export class VirtualGrid {
  constructor({ viewport, cellsEl, bus }) {
    this.viewport = viewport;
    this.cellsEl = cellsEl;
    this.bus = bus;
    this.rows = [];                 // row numbers in display order
    this.meta = new Map();          // rowNum -> record ref (path/name/status/topTag/conf)
    this.thumbSize = 136;
    this.cols = 1;
    this.cellH = 0;
    this.selected = new Set();      // row numbers
    this.anchor = null;
    this.lru = new Map();           // id -> {url, blob}
    this.lruMax = 384;
    this.pendingFetch = new Set();
    this.thumbInFlight = new Set();
    this.urlForMissing = new Map(); // rowNum -> objectURL (from original file, if available)
    this.processingRows = new Set();
    this._renderQueued = false;
    this._scrollHandler = () => this._scheduleRender();
    this.viewport.addEventListener('scroll', this._scrollHandler, { passive: true });
    new ResizeObserver(() => { this._layout(); this._scheduleRender(); }).observe(this.viewport);
    this.viewport.addEventListener('click', (e) => this._onClick(e));
    this.viewport.addEventListener('dblclick', (e) => {
      const c = e.target.closest('.gcell');
      if (c) this.bus.emit('open', Number(c.dataset.rn));
    });
    this._flushThumbs = debounce(() => this._loadVisibleThumbs(), 60);
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this._scrollHandler);
    this._revokeAll();
  }

  setThumbSize(px) { this.thumbSize = px; this._layout(); this.render(true); }

  setRows(rowNums, metaFn) {
    this.rows = rowNums;
    this.meta.clear();
    if (metaFn) for (const rn of rowNums) { const m = metaFn(rn); if (m) this.meta.set(rn, m); }
    // position lookup for O(1) row refresh
    this.posOf = new Map();
    for (let i = 0; i < rowNums.length; i++) this.posOf.set(rowNums[i], i);
    // keep only selection that still exists
    const alive = new Set(rowNums);
    for (const rn of [...this.selected]) if (!alive.has(rn)) this.selected.delete(rn);
    this._layout();
    this.viewport.scrollTop = 0;
    this.render(true);
  }

  _layout() {
    const w = this.viewport.clientWidth || 800;
    this.cols = Math.max(2, Math.floor((w - 8) / (this.thumbSize + 6)));
    this.cellW = Math.floor((w - 8) / this.cols) - 6;
    this.cellH = Math.round(this.cellW * 1.08);
    const rows = Math.ceil(this.rows.length / this.cols);
    this.cellsEl.parentElement.style.height = (rows * (this.cellH + 6) + 12) + 'px';
  }

  // ---------- rendering ----------
  render(force = false) {
    this._renderQueued = false;
    const vt = this.viewport.scrollTop;
    const vh = this.viewport.clientHeight || 600;
    const rowH = this.cellH + 6;
    const firstRow = Math.max(0, Math.floor((vt - 150) / rowH));
    const lastRow = Math.ceil((vt + vh + 150) / rowH);
    const first = firstRow * this.cols;
    const last = Math.min(this.rows.length, lastRow * this.cols);
    if (!force && this._lastWindow && this._lastWindow[0] === first && this._lastWindow[1] === last && !this._dirty) return;
    this._lastWindow = [first, last];
    this._dirty = false;

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const rn = this.rows[i];
      frag.append(this._buildCell(rn, i));
    }
    this.cellsEl.replaceChildren(frag);
    this._touchVisible(first, last);
    this._flushThumbs();
  }

  _scheduleRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => this.render());
  }

  _buildCell(rn, i) {
    const m = this.meta.get(rn) || {};
    const row = Math.floor(i / this.cols), col = i % this.cols;
    const c = el('div', {
      class: `gcell st-${m.status || 'pending'}`,
      'data-rn': String(rn),
    });
    c.style.transform = `translate(${col * (this.cellW + 6) + 4}px, ${row * (this.cellH + 6) + 4}px)`;
    c.style.width = this.cellW + 'px';
    c.style.height = this.cellH + 'px';
    if (this.selected.has(rn)) c.classList.add('selected');

    const stripe = el('div', { class: 'stripe' });
    c.append(stripe);

    // thumbnail or placeholder
    const entry = this.lru.get(m.id);
    if (entry) {
      entry.seen = performance.now();
      const img = new Image();
      img.className = 'thumb';
      img.src = entry.url;
      img.decoding = 'async';
      img.loading = 'lazy';
      img.draggable = false;
      c.append(img);
    } else {
      const ph = document.createElement('canvas');
      ph.className = 'ph';
      ph.width = 48; ph.height = Math.max(24, Math.round(48 * this.cellH / Math.max(1, this.cellW)));
      const ctx = ph.getContext('2d');
      ctx.fillStyle = hashColor(m.id || String(rn));
      ctx.fillRect(0, 0, ph.width, ph.height);
      c.append(ph);
    }
    if (m.status === 'processing') c.append(el('div', { class: 'spinner' }));
    if (m.topTags && m.topTags.length) {
      const wrap = el('div', { class: 'toptags' });
      for (const t of m.topTags) {
        wrap.append(el('span', {
          class: t.catName ? `tcat-${t.catName}` : '',
          text: t.name,
          title: `${t.name} (${t.catName ? t.catName + ' · ' : ''}${Math.round((t.conf || 0) * 100)}%)`
        }));
      }
      c.append(wrap);
    } else if (m.topTag) {
      c.append(el('div', { class: 'toptags' }, el('span', { text: m.topTag })));
    }
    if (m.name) c.append(el('div', { class: 'label', text: m.name, title: m.path || m.name }));
    return c;
  }

  // ---------- thumbs ----------
  _touchVisible(first, last) {    // mark LRU
    for (let i = first; i < last; i++) {
      const m = this.meta.get(this.rows[i]);
      if (!m) continue;
      const e = this.lru.get(m.id);
      if (e) e.seen = performance.now();
    }
    // evict
    if (this.lru.size > this.lruMax) {
      const entries = [...this.lru.entries()].sort((a, b) => a[1].seen - b[1].seen);
      let toEvict = this.lru.size - this.lruMax;
      for (const [id, e] of entries) {
        if (toEvict-- <= 0) break;
        URL.revokeObjectURL(e.url);
        this.lru.delete(id);
      }
    }
  }

  async _loadVisibleThumbs() {
    const vt = this.viewport.scrollTop, vh = this.viewport.clientHeight || 600;
    const rowH = this.cellH + 6;
    const firstRow = Math.max(0, Math.floor((vt - 150) / rowH));
    const lastRow = Math.ceil((vt + vh + 150) / rowH);
    const want = [];
    for (let i = firstRow * this.cols; i < Math.min(this.rows.length, lastRow * this.cols); i++) {
      const rn = this.rows[i];
      const m = this.meta.get(rn);
      if (!m || this.lru.has(m.id) || this.pendingFetch.has(m.id)) continue;
      want.push({ rn, id: m.id });
    }
    if (!want.length) return;
    for (const w of want) this.pendingFetch.add(w.id);
    try {
      const blobs = await db.getThumbs(want.map(w => w.id));
      const newlyAvailable = [];
      want.forEach((w, i) => {
        this.pendingFetch.delete(w.id);
        if (blobs[i]) {
          this._storeThumb(w.id, blobs[i]);
          newlyAvailable.push(w.rn);
        }
      });
      if (newlyAvailable.length) this._dirty = true, this._scheduleRender();
      // ask the app for on-demand thumb generation of still-missing visible cells
      const missing = want.filter((w, i) => !blobs[i] && !this.thumbInFlight.has(w.id)).map(w => w.rn);
      if (missing.length) this.bus.emit('thumbs-needed', missing);
    } catch (e) {
      console.warn('thumb load', e);
    }
  }

  _storeThumb(id, blob) {
    if (this.lru.has(id)) { URL.revokeObjectURL(this.lru.get(id).url); this.lru.delete(id); }
    const url = URL.createObjectURL(blob);
    this.lru.set(id, { url, blob, seen: performance.now() });
  }

  setThumb(id, blob) {
    this._storeThumb(id, blob);
    this._dirty = true;
    this._scheduleRender();
  }

  _revokeAll() {
    for (const [, e] of this.lru) URL.revokeObjectURL(e.url);
    this.lru.clear();
  }

  // ---------- selection ----------
  _onClick(e) {
    const cell = e.target.closest('.gcell');
    if (!cell) return;
    const rn = Number(cell.dataset.rn);
    if (e.shiftKey && this.anchor != null) {
      const a = this.rows.indexOf(this.anchor), b = this.rows.indexOf(rn);
      if (a >= 0 && b >= 0) {
        if (!e.ctrlKey && !e.metaKey) this.selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.rows[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(rn)) this.selected.delete(rn); else this.selected.add(rn);
      this.anchor = rn;
    } else {
      this.selected.clear();
      this.selected.add(rn);
      this.anchor = rn;
    }
    this.bus.emit('selection', this.selected);
    this.render(true);
  }

  selectAll() {
    for (const rn of this.rows) this.selected.add(rn);
    this.bus.emit('selection', this.selected);
    this.render(true);
  }
  clearSelection() {
    this.selected.clear();
    this.bus.emit('selection', this.selected);
    this.render(true);
  }
  markProcessing(rn, on) {
    if (on) this.processingRows.add(rn); else this.processingRows.delete(rn);
  }
  markDirty() { this._dirty = true; this._scheduleRender(); }
}
