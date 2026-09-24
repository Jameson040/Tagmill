// Exporters: JSON / CSV / per-image TXT in a ZIP. All stream through OPFS so even
// 50k-image exports never build a giant string in memory.

import { fmtDate, crc32 } from './util.js';
import { CATEGORY_ORDER } from './model-registry.js';

export const CAT_NAME = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta', 6: 'year', 9: 'rating', [-1]: 'manual', [-2]: 'manual' };

export const CAT_PRIORITY = {
  [-2]: 0,
  [-1]: 0,
  4: 1, // character
  3: 2, // copyright
  1: 3, // artist
  0: 4, // general
  5: 5, // meta
  9: 6, // rating
  6: 7, // year
};

export function effectiveTags(rec, vocab, { thresholds = null, catEnabled = null, orderBy = 'category' } = {}) {
  // returns [{name, p, cat, catName, isManual}] ordered by category priority or confidence
  const out = [];
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
      out.push({ name, p, cat, catName, isManual: false });
    }
  }
  if (rec.manualAdd) {
    for (const name of rec.manualAdd) {
      if (rec.manualRemove?.includes(name)) continue;
      const idx = vocab?.index?.get(name);
      const cat = idx !== undefined ? (vocab?.catOf?.[idx] ?? 0) : -1;
      const catName = CAT_NAME[cat] || 'manual';
      if (catEnabled && cat !== -1 && catEnabled[catName] === false) continue;
      out.push({ name, p: 1, cat, catName, isManual: true });
    }
  }
  if (orderBy === 'category') {
    out.sort((a, b) => {
      const pa = CAT_PRIORITY[a.cat] ?? 99;
      const pb = CAT_PRIORITY[b.cat] ?? 99;
      if (pa !== pb) return pa - pb;
      return b.p - a.p;
    });
  } else {
    out.sort((a, b) => b.p - a.p);
  }
  return out;
}

// ---------- OPFS streaming sink ----------
async function opfsSink(name) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  return {
    write(str) { return w.write(str); },
    async close() { await w.close(); return fh; },
    async abort() { try { await w.abort?.(); } catch { /* */ } try { await w.close(); } catch { /* */ } try { await root.removeEntry(name); } catch { /* */ } },
  };
}

export async function saveFileToUser(fileBlobOrHandle, suggestedName, mime) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: mime || 'file', accept: { [mime || 'application/octet-stream']: [ '.' + (suggestedName.split('.').pop() || 'bin') ] } }] });
      const w = await handle.createWritable();
      await (fileBlobOrHandle.stream ? fileBlobOrHandle.stream().pipeTo(w) : w.write(fileBlobOrHandle));
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      console.warn('save picker failed, falling back to download', e);
    }
  }
  const url = URL.createObjectURL(fileBlobOrHandle);
  const a = document.createElement('a');
  a.href = url; a.download = suggestedName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

const csvEscape = (s) => {
  s = String(s ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const jsonEscape = (s) => JSON.stringify(s);

/**
 * Export a set of records. onProgress(done, total). Returns {file, filename}.
 * formats: 'json' | 'csv' | 'csv-long' | 'txtzip'
 */
export async function exportRecords({ records, vocab, format, collection, options = {}, onProgress, signal }) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = `tagmill-${collection.name.replace(/[^\w.-]+/g, '_')}-${stamp}`;

  if (format === 'json') return _exportJson({ records, vocab, collection, options, onProgress, signal, base });
  if (format === 'csv') return _exportCsv({ records, vocab, options, onProgress, signal, base });
  if (format === 'csv-long') return _exportCsvLong({ records, vocab, options, onProgress, signal, base });
  if (format === 'txtzip') return _exportTxtZip({ records, vocab, options, onProgress, signal, base });
  throw new Error('unknown format ' + format);
}

async function _exportJson({ records, vocab, collection, options, onProgress, signal, base }) {
  const sink = await opfsSink('export.tmp');
  const minP = options.minProb ?? 0;
  try {
    await sink.write(`{\n"application":"Tagmill",\n"collection":${jsonEscape(collection.name)},\n"exportedAt":${jsonEscape(new Date().toISOString())},\n"model":"Camie Tagger v2",\n"images":[\n`);
    let first = true, n = 0;
    for (const rec of records) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const tags = effectiveTags(rec, vocab, { thresholds: options.thresholds, catEnabled: options.catEnabled, orderBy: 'category' }).filter(t => t.p >= minP);
      const obj = {
        path: rec.path, name: rec.name, size: rec.size, width: rec.width || null, height: rec.height || null,
        status: rec.status, contentId: rec.quickHash || null, taggedAt: rec.tagStamp || null, model: rec.modelVariant || null,
        tags: Object.fromEntries(tags.map(t => [t.name, Math.round(t.p * 10000) / 10000])),
        categories: (() => { const m = {}; for (const t of tags) (m[CAT_NAME[t.cat] || 'manual'] ??= []).push(t.name); return m; })(),
        manualAdd: rec.manualAdd || undefined,
        manualRemove: rec.manualRemove || undefined,
        duplicateOf: rec.dupOf || undefined,
      };
      await sink.write((first ? '' : ',\n') + JSON.stringify(obj));
      first = false;
      if (++n % 500 === 0) { onProgress?.(n, records.length); await new Promise(r => setTimeout(r)); }
    }
    await sink.write('\n]\n}\n');
    const fh = await sink.close();
    return { file: await fh.getFile(), filename: base + '.json' };
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

async function _exportCsv({ records, vocab, options, onProgress, signal, base }) {
  const sink = await opfsSink('export.tmp');
  const minP = options.minProb ?? 0;
  try {
    await sink.write('path,name,status,width,height,rating,artist,copyright,characters,general_tags,tags_with_confidence,content_id,duplicate_of\n');
    let n = 0;
    for (const rec of records) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const tags = effectiveTags(rec, vocab, { thresholds: options.thresholds, catEnabled: options.catEnabled, orderBy: 'category' }).filter(t => t.p >= minP);
      const byCat = {};
      for (const t of tags) (byCat[t.cat] ??= []).push(t);
      const joinCat = (c) => (byCat[c] || []).map(t => t.name).join(' ');
      const conf = tags.map(t => `${t.name}:${t.p.toFixed(3)}`).join('|');
      await sink.write([
        csvEscape(rec.path), csvEscape(rec.name), rec.status,
        rec.width || '', rec.height || '',
        joinCat(9), joinCat(1), joinCat(3), joinCat(4), joinCat(0),
        csvEscape(conf), rec.quickHash || '', rec.dupOf || '',
      ].join(',') + '\n');
      if (++n % 1000 === 0) { onProgress?.(n, records.length); await new Promise(r => setTimeout(r)); }
    }
    const fh = await sink.close();
    return { file: await fh.getFile(), filename: base + '.csv' };
  } catch (e) { await sink.abort(); throw e; }
}

async function _exportCsvLong({ records, vocab, options, onProgress, signal, base }) {
  const sink = await opfsSink('export.tmp');
  const minP = options.minProb ?? 0;
  try {
    await sink.write('path,tag,category,confidence\n');
    let n = 0;
    for (const rec of records) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const tags = effectiveTags(rec, vocab, { thresholds: options.thresholds, catEnabled: options.catEnabled, orderBy: 'category' }).filter(t => t.p >= minP);
      for (const t of tags) {
        await sink.write(`${csvEscape(rec.path)},${csvEscape(t.name)},${CAT_NAME[t.cat] || 'manual'},${t.p.toFixed(4)}\n`);
      }
      if (++n % 500 === 0) { onProgress?.(n, records.length); await new Promise(r => setTimeout(r)); }
    }
    const fh = await sink.close();
    return { file: await fh.getFile(), filename: base + '-tags.csv' };
  } catch (e) { await sink.abort(); throw e; }
}

// ---------- minimal store-only ZIP ----------
async function _exportTxtZip({ records, vocab, options, onProgress, signal, base }) {
  const sink = await opfsSink('export.tmp');
  const minP = options.minProb ?? 0;
  const enc = new TextEncoder();
  const nameToBytes = (name) => enc.encode(name); // UTF-8; we set the UTF-8 flag bit
  const used = new Map(); // dedupe paths inside the zip
  const dosTime = (() => { const d = new Date(); return { t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  let offset = 0;
  const central = [];
  const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const cat = [9, 1, 3, 4, 0, 5, 6];

  try {
    let n = 0;
    for (const rec of records) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const tags = effectiveTags(rec, vocab, { thresholds: options.thresholds, catEnabled: options.catEnabled, orderBy: 'category' }).filter(t => t.p >= minP);
      const ordered = tags.map(t => t.name);
      if (options.ratingArgmax === false) { /* keep all */ }
      if (!ordered.length && options.skipEmpty !== false) { if (++n % 1000 === 0) { onProgress?.(n, records.length); } continue; }
      let zn = rec.path.replace(/\.[^.]+$/, '') + '.txt';
      let k = 2;
      while (used.has(zn)) zn = rec.path.replace(/\.[^.]+$/, '') + `_${k++}.txt`;
      used.set(zn, 1);
      const nameB = nameToBytes(zn);
      const data = enc.encode(ordered.join(', '));
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameB.length);
      local.set(u32(0x04034b50), 0); local.set(u16(20), 4); local.set(u16(0x0800), 6);
      local.set(u16(0), 8); local.set(u16(dosTime.t), 10); local.set(u16(dosTime.d), 12);
      local.set(u32(crc), 14); local.set(u32(data.length), 18); local.set(u32(data.length), 22);
      local.set(u16(nameB.length), 26); local.set(u16(0), 28); local.set(nameB, 30);
      await sink.write(local);
      await sink.write(data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += local.length + data.length;
      if (++n % 400 === 0) { onProgress?.(n, records.length); await new Promise(r => setTimeout(r)); }
    }
    const cdStart = offset;
    for (const e of central) {
      const cd = new Uint8Array(46 + e.nameB.length);
      cd.set(u32(0x02014b50), 0); cd.set(u16(20), 4); cd.set(u16(20), 6); cd.set(u16(0x0800), 8);
      cd.set(u16(0), 10); cd.set(u16(dosTime.t), 12); cd.set(u16(dosTime.d), 14);
      cd.set(u32(e.crc), 16); cd.set(u32(e.size), 20); cd.set(u32(e.size), 24);
      cd.set(u16(e.nameB.length), 28); cd.set(u16(0), 30); cd.set(u16(0), 32);
      cd.set(u16(0), 34); cd.set(u16(0), 36); cd.set(u32(0), 38); cd.set(u32(e.offset), 42); cd.set(e.nameB, 46);
      await sink.write(cd);
      offset += cd.length;
    }
    const eocd = new Uint8Array(22);
    eocd.set(u32(0x06054b50), 0); eocd.set(u16(0), 8); eocd.set(u16(central.length), 10);
    eocd.set(u32(offset - cdStart), 12); eocd.set(u32(cdStart), 16); eocd.set(u16(0), 20);
    await sink.write(eocd);
    const fh = await sink.close();
    return { file: await fh.getFile(), filename: base + '-tags-txt.zip' };
  } catch (e) { await sink.abort(); throw e; }
}
