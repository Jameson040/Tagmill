import { CAT_NAME } from './exporters.js';

export class TagIndex {
  constructor(options = {}) {
    this.thresholds = options.thresholds || null;
    this.catEnabled = options.catEnabled || null;
    this.byTag = new Map();      // tag name -> Set(rowNum)
    this.tagCount = new Map();   // tag name -> occurrence count
    this.rowTags = new Map();    // rowNum -> Set(tag name) (effective)
    this.catRows = null;
    this.size = 0;
  }

  configure({ thresholds, catEnabled } = {}) {
    if (thresholds !== undefined) this.thresholds = thresholds;
    if (catEnabled !== undefined) this.catEnabled = catEnabled;
  }

  clear() {
    this.byTag.clear();
    this.tagCount.clear();
    this.rowTags.clear();
    if (this.catRows) this.catRows.clear();
    this.size = 0;
  }

  static effectiveTagNames(rec, vocab, thresholds = null, catEnabled = null) {
    // returns Set of tag names meeting threshold and not removed manually
    const out = new Set();
    if (rec.tagIdx && vocab) {
      for (let k = 0; k < rec.tagIdx.length; k++) {
        const idx = rec.tagIdx[k];
        const name = vocab.names?.[idx];
        if (!name || rec.manualRemove?.includes(name)) continue;
        const cat = vocab.catOf?.[idx] ?? 0;
        const catName = CAT_NAME[cat] || 'general';
        if (catEnabled && catEnabled[catName] === false) continue;
        const p = (rec.tagP ? rec.tagP[k] : 65535) / 65535;
        if (thresholds) {
          const th = thresholds[catName] ?? 0.5;
          if (p < th) continue;
        }
        out.add(name);
      }
    }
    if (rec.manualAdd) {
      for (const t of rec.manualAdd) {
        if (!rec.manualRemove?.includes(t)) out.add(t);
      }
    }
    return out;
  }

  addRow(rowNum, rec, vocab, opts = {}) {
    const th = opts.thresholds ?? this.thresholds;
    const en = opts.catEnabled ?? this.catEnabled;
    const tags = TagIndex.effectiveTagNames(rec, vocab, th, en);
    this.rowTags.set(rowNum, tags);
    for (const t of tags) {
      let s = this.byTag.get(t);
      if (!s) { s = new Set(); this.byTag.set(t, s); }
      s.add(rowNum);
      this.tagCount.set(t, (this.tagCount.get(t) || 0) + 1);
    }
    this.size++;
  }

  updateRow(rowNum, rec, vocab, opts = {}) {
    const old = this.rowTags.get(rowNum) || new Set();
    const th = opts.thresholds ?? this.thresholds;
    const en = opts.catEnabled ?? this.catEnabled;
    const fresh = TagIndex.effectiveTagNames(rec, vocab, th, en);
    for (const t of old) {
      if (!fresh.has(t)) {
        this.byTag.get(t)?.delete(rowNum);
        const c = (this.tagCount.get(t) || 1) - 1;
        if (c <= 0) { this.tagCount.delete(t); this.byTag.delete(t); } else this.tagCount.set(t, c);
      }
    }
    for (const t of fresh) {
      if (!old.has(t)) {
        let s = this.byTag.get(t);
        if (!s) { s = new Set(); this.byTag.set(t, s); }
        s.add(rowNum);
        this.tagCount.set(t, (this.tagCount.get(t) || 0) + 1);
      }
    }
    this.rowTags.set(rowNum, fresh);
  }

  removeRow(rowNum) {
    const tags = this.rowTags.get(rowNum);
    if (!tags) return;
    for (const t of tags) {
      this.byTag.get(t)?.delete(rowNum);
      const c = (this.tagCount.get(t) || 1) - 1;
      if (c <= 0) { this.tagCount.delete(t); this.byTag.delete(t); } else this.tagCount.set(t, c);
    }
    this.rowTags.delete(rowNum);
    this.size--;
  }

  tagsOf(rowNum) { return this.rowTags.get(rowNum) || new Set(); }

  /** Parse & run a query. Terms are ANDed. Returns Set(rowNum) or null (match all). */
  query(qs, vocab = null) {
    const v = vocab || this.vocab;
    const terms = [];
    const exclude = [];
    let cat = null;
    for (const raw of String(qs || '').trim().split(/\s+/).filter(Boolean)) {
      let t = raw;
      let neg = false;
      if (t.startsWith('-') && t.length > 1) { neg = true; t = t.slice(1); }
      const lower = t.toLowerCase();
      if (lower.startsWith('cat:')) {
        const c = lower.slice(4);
        cat = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5, year: 6, rating: 9 }[c] ?? null;
        continue;
      }
      let catPrefix = null;
      let cleanTerm = lower;
      if (lower.startsWith('char:') || lower.startsWith('character:')) {
        catPrefix = 4;
        cleanTerm = lower.startsWith('char:') ? lower.slice(5) : lower.slice(10);
      } else if (lower.startsWith('series:') || lower.startsWith('copyright:')) {
        catPrefix = 3;
        cleanTerm = lower.startsWith('series:') ? lower.slice(7) : lower.slice(10);
      } else if (lower.startsWith('artist:')) {
        catPrefix = 1;
        cleanTerm = lower.slice(7);
      } else if (lower.startsWith('general:')) {
        catPrefix = 0;
        cleanTerm = lower.slice(8);
      }

      if (neg) {
        exclude.push({ term: cleanTerm, cat: catPrefix });
      } else {
        terms.push({ term: cleanTerm, cat: catPrefix });
      }
    }
    if (!terms.length && !exclude.length && cat === null) return null;

    const resolveTermRows = ({ term, cat: termCat }) => {
      const out = new Set();
      for (const [tag, rSet] of this.byTag) {
        if (tag === term || tag.startsWith(term) || tag.includes('_' + term) || tag.includes(term)) {
          if (termCat !== null && v) {
            const idx = v.index?.get(tag);
            if (idx === undefined || (v.catOf?.[idx] ?? 0) !== termCat) continue;
          }
          for (const r of rSet) out.add(r);
        }
      }
      return out;
    };

    let result = null;
    if (terms.length) {
      const sortedSets = terms.map(resolveTermRows).sort((a, b) => a.size - b.size);
      result = new Set(sortedSets[0]);
      for (let i = 1; i < sortedSets.length && result.size; i++) {
        for (const r of result) if (!sortedSets[i].has(r)) result.delete(r);
      }
    }
    if (cat !== null) {
      const catRows = this.catRows?.get(cat);
      if (result) for (const r of result) if (!catRows?.has(r)) result.delete(r);
      else result = new Set(catRows || []);
    }
    for (const ex of exclude) {
      const set = resolveTermRows(ex);
      if (!set.size) continue;
      if (!result) {
        result = new Set();
        for (const [rn] of this.rowTags) result.add(rn);
      }
      for (const r of set) result.delete(r);
    }
    return result || new Set();
  }

  _prefixSet(prefix) {
    // exact match failed — prefix match over tag names (used for user convenience)
    const out = new Set();
    for (const [tag, rows] of this.byTag) {
      if (tag.startsWith(prefix)) for (const r of rows) out.add(r);
    }
    return out;
  }

  /** autocompletion */
  suggest(prefix, limit = 12, vocab = null) {
    const v = vocab || this.vocab;
    const p = prefix.toLowerCase();
    const out = [];
    if (!p) return out;
    const exact = this.byTag.get(p);
    if (exact) {
      const idx = v?.index?.get(p);
      const cat = idx !== undefined ? (v?.catOf?.[idx] ?? 0) : -1;
      out.push({ tag: p, count: exact.size, cat, catName: CAT_NAME[cat] || 'general' });
    }
    for (const [tag, rows] of this.byTag) {
      if (tag !== p && tag.startsWith(p)) {
        const idx = v?.index?.get(tag);
        const cat = idx !== undefined ? (v?.catOf?.[idx] ?? 0) : -1;
        out.push({ tag, count: rows.size, cat, catName: CAT_NAME[cat] || 'general' });
        if (out.length >= limit * 3) break;
      }
    }
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
  }

  distinctTagCount() { return this.byTag.size; }

  /** category → rows map for cat: filters (built once per collection open) */
  buildCatRows(vocab) {
    this.vocab = vocab;
    this.catRows = new Map();
    for (const [rn, tags] of this.rowTags) {
      for (const t of tags) {
        const idx = vocab?.index?.get(t);
        const cat = idx !== undefined ? (vocab?.catOf?.[idx] ?? 0) : -1;
        let s = this.catRows.get(cat);
        if (!s) { s = new Set(); this.catRows.set(cat, s); }
        s.add(rn);
      }
    }
  }
}
