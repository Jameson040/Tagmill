import { $, el, fmtBytes, fmtDate } from './util.js';
import { CATEGORY_ORDER, CATEGORY_ID_LABELS, CATEGORY_IDS_BY_PRIORITY } from './model-registry.js';
import { CAT_NAME } from './exporters.js';

export class Inspector {
  constructor({ bus, app }) {
    this.bus = bus;
    this.app = app; // {source, rows, rowIndex, vocab, engine, persistManualEdit()}
    this.current = null; // rowNum
    this.el = $('#inspector');
    this._wire();
  }

  _wire() {
    $('#insp-close').addEventListener('click', () => this.hide());
    $('#insp-rerun').addEventListener('click', async () => {
      if (this.current == null) return;
      const app = this.app;
      await app.retagRows([this.current]);
    });
    $('#insp-copy-tags').addEventListener('click', () => {
      if (this.current == null) return;
      const text = this._copyText();
      navigator.clipboard.writeText(text).then(() => this.bus.emit('toast', { kind: 'ok', title: 'Copied', msg: text.slice(0, 120) + (text.length > 120 ? '…' : '') }))
        .catch(() => this.bus.emit('toast', { kind: 'err', title: 'Clipboard blocked', msg: 'Select and copy manually.' }));
    });
    $('#insp-add-btn').addEventListener('click', () => this._addManual());
    $('#insp-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._addManual(); });
    $('#insp-delete-file')?.addEventListener('click', async () => {
      if (this.current == null) return;
      const rec = this.app.rows[this.current];
      if (!rec) return;
      this.hide();
      await this.app.removeRows([rec.id]);
    });
  }

  async show(rowNum) {
    const app = this.app;
    const rec = app.rows[rowNum];
    if (!rec) return;
    this.current = rowNum;
    this.el.classList.remove('hide');
    $('#insp-name').textContent = rec.name;
    $('#insp-name').title = rec.path;
    $('#insp-meta').innerHTML = '';
    $('#insp-meta').append(
      el('div', {}, 'Path: ', el('b', { text: rec.path })),
      el('div', {}, `Size: ${fmtBytes(rec.size)} · ${rec.width && rec.height ? `${rec.width}×${rec.height}px` : 'dimensions unknown'} · modified ${fmtDate(rec.mtime)}`),
      rec.dupOf ? el('div', {}, el('b', { text: 'Duplicate of: ' }), rec.dupOf) : null,
      rec.quickHash ? el('div', { class: 'hint', text: `content id: ${rec.quickHash.slice(0, 20)}…` }) : null,
    );

    const st = $('#insp-status');
    st.innerHTML = '';
    const statusText = {
      pending: 'Not tagged yet', processing: 'Processing…', done: 'Tagged',
      failed: `Failed: ${rec.errorMsg || rec.error || 'error'}`, skipped: rec.dupOf ? 'Skipped (duplicate content)' : 'Skipped', missing: 'Missing on disk (rescan to fix)',
    }[rec.status] || rec.status;
    st.append(el('div', { class: `hint`, text: statusText }));

    // image preview
    const img = $('#insp-img');
    const note = $('#insp-img-note');
    note.classList.add('hide');
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    img.src = '';
    try {
      const file = await app.source.getFile(rec);
      if (file && this.current === rowNum) {
        this._objectUrl = URL.createObjectURL(file);
        img.src = this._objectUrl;
      }
    } catch {
      note.textContent = 'Preview unavailable (file handle lost — rescan the collection).';
      note.classList.remove('hide');
    }

    this._renderTags();
    this._fillDatalist();
  }

  hide() {
    this.el.classList.add('hide');
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    this.current = null;
  }

  _tagsByCategory(rec, { thresholds = null, catEnabled = null } = {}) {
    const vocab = this.app.vocab;
    const byCat = new Map();
    const add = (name, p, cat, manual) => {
      let list = byCat.get(cat);
      if (!list) { list = []; byCat.set(cat, list); }
      list.push({ name, p, cat, manual });
    };
    if (rec.tagIdx && vocab) {
      for (let k = 0; k < rec.tagIdx.length; k++) {
        const name = vocab.names[rec.tagIdx[k]];
        if (rec.manualRemove?.includes(name)) continue;
        const cat = vocab.catOf?.[rec.tagIdx[k]] ?? 0;
        const catName = CAT_NAME[cat] || 'general';
        if (catEnabled && catEnabled[catName] === false) continue;
        const p = (rec.tagP ? rec.tagP[k] : 0) / 65535;
        if (thresholds) {
          const th = thresholds[catName] ?? 0.5;
          if (p < th) continue;
        }
        add(name, p, cat, false);
      }
    }
    if (rec.manualAdd) {
      for (const name of rec.manualAdd) {
        if (rec.manualRemove?.includes(name)) continue;
        const idx = vocab?.index?.get(name);
        const cat = idx !== undefined ? (vocab?.catOf?.[idx] ?? 0) : -1;
        add(name, null, cat, true);
      }
    }
    for (const [, list] of byCat) list.sort((a, b) => (b.p ?? 1) - (a.p ?? 1));
    return byCat;
  }

  _renderTags() {
    const rec = this.current != null ? this.app.rows[this.current] : null;
    const wrap = $('#insp-tags');
    wrap.innerHTML = '';
    if (!rec) return;

    const vocab = this.app.vocab;
    const thresholds = this.app.settings?.thresholds || {};
    const catEnabled = this.app.settings?.catEnabled || {};

    const byCat = new Map();
    for (const catId of CATEGORY_IDS_BY_PRIORITY) {
      byCat.set(catId, { active: [], below: [] });
    }
    byCat.set(-1, { active: [], below: [] });

    if (rec.tagIdx && vocab) {
      for (let k = 0; k < rec.tagIdx.length; k++) {
        const idx = rec.tagIdx[k];
        const name = vocab.names[idx];
        if (!name || rec.manualRemove?.includes(name)) continue;
        const cat = vocab.catOf?.[idx] ?? 0;
        const catName = CAT_NAME[cat] || 'general';
        const p = (rec.tagP ? rec.tagP[k] : 0) / 65535;
        const th = thresholds[catName] ?? 0.5;
        const isEnabled = catEnabled[catName] !== false;

        const tagItem = { name, p, cat, catName, manual: false };
        let catGroup = byCat.get(cat);
        if (!catGroup) {
          catGroup = { active: [], below: [] };
          byCat.set(cat, catGroup);
        }
        if (isEnabled && p >= th) {
          catGroup.active.push(tagItem);
        } else {
          catGroup.below.push(tagItem);
        }
      }
    }

    if (rec.manualAdd) {
      for (const name of rec.manualAdd) {
        if (rec.manualRemove?.includes(name)) continue;
        const idx = vocab?.index?.get(name);
        const cat = idx !== undefined ? (vocab?.catOf?.[idx] ?? 0) : -1;
        const catName = CAT_NAME[cat] || 'manual';
        const tagItem = { name, p: null, cat, catName, manual: true };
        let catGroup = byCat.get(cat);
        if (!catGroup) {
          catGroup = { active: [], below: [] };
          byCat.set(cat, catGroup);
        }
        catGroup.active.push(tagItem);
      }
    }

    let totalRendered = 0;
    for (const [catId, { active, below }] of byCat) {
      if (!active.length && !below.length) continue;
      const catName = CAT_NAME[catId] || 'manual';
      const catLabel = CATEGORY_ID_LABELS[catId] || (catId === -1 ? 'Manual' : catName);
      const th = thresholds[catName];
      const isEnabled = catEnabled[catName] !== false;
      const thDisplay = th !== undefined ? (isEnabled ? `threshold: ${(th * 100).toFixed(0)}%` : 'disabled') : '';

      active.sort((a, b) => (b.p ?? 1) - (a.p ?? 1));
      below.sort((a, b) => (b.p ?? 0) - (a.p ?? 0));

      const sec = el('div', { class: `tagcat cat-${catName}` });
      const h3 = el('h3', {},
        el('span', { text: `${catLabel} (${active.length})` }),
        thDisplay ? el('span', { class: 'cat-th', text: thDisplay }) : el('span')
      );
      sec.append(h3);

      const renderRow = (t, isBelow = false) => {
        const row = el('div', { class: 'tagrow' + (t.manual ? ' manual' : '') + (isBelow ? ' below-th' : '') });
        row.append(
          el('span', { class: 'tname', text: t.name, title: isBelow ? `${t.name} (below threshold)` : t.name }),
          el('span', { class: `tcat-badge cat-${catName}`, text: catName })
        );
        if (t.p != null) {
          const bar = el('div', { class: 'tbar' }, el('div'));
          bar.firstChild.style.width = `${Math.round(t.p * 100)}%`;
          row.append(bar, el('span', { class: 'tp', text: (t.p * 100).toFixed(1) + '%' }));
        } else {
          row.append(el('span', { class: 'tp', text: 'manual' }));
        }
        row.append(el('button', {
          class: 'tx', title: 'Remove tag', text: '✕',
          onclick: () => this._removeTag(t.name),
        }));
        return row;
      };

      for (const t of active) {
        sec.append(renderRow(t, false));
        totalRendered++;
      }

      if (below.length > 0) {
        const belowContainer = el('div', { class: 'below-container hide' });
        for (const t of below) {
          belowContainer.append(renderRow(t, true));
        }
        const minConfStr = below[below.length - 1].p != null ? ` (min ${(below[below.length - 1].p * 100).toFixed(1)}%)` : '';
        const toggleBtn = el('div', {
          class: 'below-th-toggle',
          text: `▶ Show ${below.length} below threshold${minConfStr}`,
        });
        toggleBtn.addEventListener('click', () => {
          const isHidden = belowContainer.classList.toggle('hide');
          toggleBtn.textContent = (isHidden ? '▶' : '▼') + ` ${isHidden ? 'Show' : 'Hide'} ${below.length} below threshold`;
        });
        sec.append(toggleBtn, belowContainer);
      }

      wrap.append(sec);
    }

    if (!totalRendered && wrap.children.length === 0) {
      wrap.append(el('div', { class: 'hint', text: 'No active tags for current threshold settings.' }));
    }
  }

  async _removeTag(name) {
    const app = this.app;
    const rec = app.rows[this.current];
    if (!rec) return;
    if (rec.manualAdd?.includes(name)) {
      rec.manualAdd = rec.manualAdd.filter(t => t !== name);
    } else {
      rec.manualRemove = [...(rec.manualRemove || []), name];
    }
    await app.persistManualEdit(this.current);
    this._renderTags();
  }

  async _addManual() {
    const input = $('#insp-add-input');
    const name = input.value.trim().toLowerCase().replace(/\s+/g, '_');
    if (!name || this.current == null) return;
    const app = this.app;
    const rec = app.rows[this.current];
    if (rec.manualRemove?.includes(name)) rec.manualRemove = rec.manualRemove.filter(t => t !== name);
    else if (rec.tagIdx && rec.tagIdx.length && this.app.vocab.index.has(name) && [...rec.tagIdx].some(i => this.app.vocab.names[i] === name)) {
      // already stored
    } else {
      rec.manualAdd = [...(rec.manualAdd || []), name];
    }
    input.value = '';
    await app.persistManualEdit(this.current);
    this._renderTags();
  }

  _copyText() {
    const rec = this.app.rows[this.current];
    const byCat = this._tagsByCategory(rec, {
      thresholds: this.app.settings?.thresholds,
      catEnabled: this.app.settings?.catEnabled,
    });
    const parts = [];
    for (const cat of [...CATEGORY_IDS_BY_PRIORITY, -1]) {
      const list = byCat.get(cat);
      if (list) for (const t of list) parts.push(t.name);
    }
    return parts.join(', ');
  }

  _fillDatalist() {
    const dl = $('#tag-datalist');
    dl.innerHTML = '';
    const idx = this.app.tagIndex;
    if (!idx) return;
    // most common tags for quick add
    const top = [...idx.tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
    for (const [tag] of top) dl.append(el('option', { value: tag }));
  }

  refreshIfShowing(rowNum) {
    if (this.current === rowNum) this.show(rowNum);
  }
}
