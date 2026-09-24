// Tagmill main — application wiring.

import { $, $$, el, fmtBytes, fmtNum, fmtDur, debounce, emitter, sleep, escapeHtml } from './util.js';
import * as db from './db.js';
import { ModelCache } from './model-cache.js';
import { loadRegistry, parseTagVocab, THRESHOLD_PROFILES, DEFAULT_CAT_ENABLED, CATEGORY_ORDER, CATEGORY_LABELS, DEFAULT_REGISTRY } from './model-registry.js';
import { PrepHost, ModelHost } from './workers.js';
import { JobEngine, ERROR_LABELS } from './job.js';
import { VirtualGrid } from './grid.js';
import { TagIndex } from './tagindex.js';
import { Inspector } from './inspector.js';
import { supportsFSA, pickDirectory, permissionFor, requestPermission, scanDirectoryHandle, recordsFromFileList, diffScan, makeRecord } from './fs.js';
import { exportRecords, saveFileToUser, effectiveTags } from './exporters.js';
import { OPS_REQUIREMENTS, planRenames, planMoves, executeOps, undoOps, writeSidecars, undoSidecars, resolveDir, renderTemplate } from './ops.js';
import { toast, modal, confirmDialog } from './ui.js';

// ---------------------------------------------------------------- app state
const app = {
  registry: DEFAULT_REGISTRY,
  modelCache: null,
  prep: null,
  model: null,
  vocab: null,
  collection: null,      // {id, record, kind: 'fsa'|'input'|'opfs', rootName}
  dirHandle: null,
  fileMap: new Map(),    // recId -> File (input mode)
  rows: [],              // all records of the collection, rowNum order = path order
  rowIndex: new Map(),   // id -> rowNum
  tagIndex: new TagIndex(),
  engine: null,
  grid: null,
  inspector: null,
  filtered: [],
  settings: null,
  bus: emitter(),
  scanAbort: null,
  modelBusy: false,
};

const DEFAULT_SETTINGS = {
  thresholds: { ...THRESHOLD_PROFILES.balanced.values },
  catEnabled: { ...DEFAULT_CAT_ENABLED },
  gridTagCount: 4,
  skipDone: true,
  reuseDup: true,
  genThumbs: true,
  batchSize: 1,
  thumbSize: 144,
  maxMP: 120,
  wantEP: 'wasm',
  threads: 0, // auto
  thumbCache: 384,
  lastVariant: 'camie-v2-int8',
};

async function loadSettings() {
  const saved = (await db.kvGet('settings')) || {};
  app.settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(saved.thresholds || {}) },
    catEnabled: { ...DEFAULT_SETTINGS.catEnabled, ...(saved.catEnabled || {}) },
    wantEP: 'wasm',
    lastVariant: 'camie-v2-int8',
  };
}
const saveSettings = debounce(() => db.kvSet('settings', app.settings).catch(() => {}), 400);

// ---------------------------------------------------------------- sources
function fsaSource(dirHandle) {
  const dirCache = new Map();
  return {
    kind: 'fsa',
    root: () => dirHandle,
    async getFile(rec) {
      const perm = await permissionFor(dirHandle, 'read');
      if (perm !== 'granted') throw Object.assign(new Error('Folder permission lost — click Rescan to re-grant'), { code: 'E_READ' });
      let dir = dirHandle;
      const segs = rec.path.split('/');
      dirCache.clear(); // cheap safety: handles can go stale
      for (let i = 0; i < segs.length - 1; i++) {
        const key = segs.slice(0, i + 1).join('/');
        let d = dirCache.get(key);
        if (!d) { d = await dir.getDirectoryHandle(segs[i]); dirCache.set(key, d); }
        dir = d;
      }
      const fh = await dir.getFileHandle(segs[segs.length - 1]);
      return fh.getFile();
    },
  };
}
function inputSource() {
  return {
    kind: 'input',
    root: () => null,
    async getFile(rec) {
      const f = app.fileMap.get(rec.id);
      if (!f) throw Object.assign(new Error('File reference lost after page reload — re-pick the folder (results will be kept)'), { code: 'E_READ' });
      return f;
    },
  };
}

// ---------------------------------------------------------------- collection lifecycle
function makeSource() {
  if (app.dirHandle) return fsaSource(app.dirHandle);
  return inputSource();
}

async function findSameCollection(handle) {
  const cols = await db.getCollections();
  for (const c of cols) {
    if (c.kind !== 'fsa') continue;
    const h = (await db.getHandle(c.id))?.handle;
    if (!h) continue;
    try { if (await handle.isSameEntry(h)) return c; } catch { /* */ }
  }
  return null;
}

async function openFsDirectory(handle) {
  if (app.engine && (app.engine.state === 'running' || app.engine.state === 'pausing')) {
    toast({ kind: 'warn', title: 'Job running', msg: 'Pause the job before switching collections.' });
    return;
  }
  let existing = await findSameCollection(handle);
  if (!existing) {
    const cols = await db.getCollections();
    existing = cols.find(c => c.kind === 'fsa' && c.name === handle.name);
  }
  if (existing) {
    await db.putHandle(existing.id, handle, 'fsa');
    await attachCollection(existing.id, { dirHandle: handle, kind: 'fsa' });
    await rescan(true);
    return;
  }
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const col = { id, name: handle.name, kind: 'fsa', createdAt: Date.now(), imageCount: 0 };
  await db.putCollection(col);
  await db.putHandle(id, handle, 'fsa');
  await attachCollection(id, { dirHandle: handle, kind: 'fsa' });
  await rescan(false);
}

async function attachCollection(id, { dirHandle = null, kind = 'input' } = {}) {
  closeCollection({ keepData: true });
  const record = (await db.getCollections()).find(c => c.id === id);
  if (!record) throw new Error('collection record missing');
  app.collection = { id, record, kind, rootName: record.name };
  app.dirHandle = dirHandle;
  app.fileMap.clear();
  app.source = makeSource();

  // load records (memory-flat enough: ~200B each; 50k ≈ 10-20 MB)
  app.rows = [];
  app.rowIndex.clear();
  app.tagIndex.clear();
  await db.iterCollectionImages(id, (batch) => {
    for (const r of batch) {
      if (r.tagIdx) { /* tags stay as typed arrays — cheap */ }
      const rn = app.rows.length;
      app.rows.push(r);
      app.rowIndex.set(r.id, rn);
    }
  });
  app.rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  app.rowIndex.clear();
  for (let rn = 0; rn < app.rows.length; rn++) {
    app.rowIndex.set(app.rows[rn].id, rn);
    updateRowMeta(app.rows[rn]);
  }

  buildIndex();
  buildEngine();
  updateCountsFromRows();
  bindCollectionView();

  // unfinished job?
  const job = await db.getJob(id);
  if (job && (job.state === 'running' || job.state === 'paused' || job.state === 'error')) {
    const { done = 0, pending = 0 } = job.counters || {};
    toast({
      kind: 'info', title: 'Unfinished job found', timeout: 9000,
      msg: `${fmtNum(done)} images were tagged, ~${fmtNum(pending)} remain. Review and press Start to continue where it left off.`,
    });
  }
}

function buildIndex() {
  if (!app.tagIndex) app.tagIndex = new TagIndex();
  app.tagIndex.configure({
    thresholds: app.settings?.thresholds,
    catEnabled: app.settings?.catEnabled,
  });
  const t0 = performance.now();
  for (let rn = 0; rn < app.rows.length; rn++) {
    const r = app.rows[rn];
    if (r.status === 'missing') continue;
    if (r.tagIdx || r.manualAdd) app.tagIndex.addRow(rn, r, app.vocab);
  }
  app.tagIndex.buildCatRows(app.vocab);
  console.log(`index built: ${app.tagIndex.distinctTagCount()} tags over ${app.tagIndex.size} rows in ${Math.round(performance.now() - t0)}ms`);
}

function rebuildIndex() {
  if (!app.tagIndex) return;
  app.tagIndex.clear();
  buildIndex();
}

function buildEngine() {
  const prep = app.prep, model = app.model;
  app.engine = new JobEngine({
    prep, model,
    source: app.source,
    settings: {
      thresholds: app.settings.thresholds,
      catEnabled: app.settings.catEnabled,
      skipDone: app.settings.skipDone,
      reuseDup: app.settings.reuseDup,
      genThumbs: app.settings.genThumbs,
      batchSize: app.settings.batchSize,
      thumbSize: app.settings.thumbSize,
      maxMP: app.settings.maxMP,
    },
    collectionId: app.collection.id,
  });
  app.engine.attachRows(app.rows, app.rowIndex);
  app.engine._modelVariantId = app.model?.info?.variantId || app.settings.lastVariant || currentVariant()?.id;
  app.engine.setInitArgsProvider(async () => {
    const variant = currentVariant();
    const file = await app.modelCache.modelFile(variant.id);
    return { modelBlob: file, variant, wantEP: 'wasm', threads: app.settings.threads || null, batchSize: app.settings.batchSize };
  });
  app.engine.wire();
  wireEngineEvents();
}

function closeCollection({ keepData = true } = {}) {
  if (app.engine) {
    app.engine.stop();
    app.engine = null;
  }
  if (app.grid) {
    app.grid.setRows([], () => null);
  }
  app.collection = null;
  app.dirHandle = null;
  app.rows = [];
  app.rowIndex.clear();
  app.tagIndex.clear();
  app.filtered = [];
  app.fileMap.clear();
  $('#grid-viewport').classList.add('hide');
  $('#empty-state').classList.remove('hide');
  $('#collection-info').classList.add('hide');
  setJobButtons();
  renderSavedCollections();
}

function updateRowMeta(rec) {
  // cached display fields (non-persisted)
  const maxTags = Math.max(4, app.settings?.gridTagCount || 4);
  if ((rec.tagIdx?.length || rec.manualAdd?.length) && app.vocab) {
    const active = effectiveTags(rec, app.vocab, {
      thresholds: app.settings?.thresholds,
      catEnabled: app.settings?.catEnabled,
      orderBy: 'category',
    });

    if (active.length) {
      rec.topTag = active[0].name;
      rec.topConf = active[0].p;

      // Category-aware allocation:
      // Up to 2 character, up to 2 copyright/series, up to 1 artist, then general/others
      const chars = active.filter(t => t.cat === 4).slice(0, 2);
      const series = active.filter(t => t.cat === 3).slice(0, 2);
      const artists = active.filter(t => t.cat === 1).slice(0, 1);
      const pickedSet = new Set([...chars, ...series, ...artists]);

      const picked = [...chars, ...series, ...artists];
      for (const t of active) {
        if (picked.length >= maxTags) break;
        if (!pickedSet.has(t)) {
          picked.push(t);
          pickedSet.add(t);
        }
      }

      rec.topTags = picked.map(t => ({
        name: t.name,
        conf: t.p,
        cat: t.cat,
        catName: t.catName,
      }));
    } else {
      rec.topTag = null;
      rec.topConf = 0;
      rec.topTags = [];
    }
  } else {
    rec.topTag = null;
    rec.topConf = 0;
    rec.topTags = [];
  }
  return rec;
}

function buildCollectionView() {
  const vp = $('#grid-viewport');
  app.grid = new VirtualGrid({ viewport: vp, cellsEl: $('#grid-cells'), bus: app.bus });
  app.grid.lruMax = app.settings.thumbCache;
  app.inspector = new Inspector({ bus: app.bus, app });
  app.bus.on('open', (rn) => app.inspector.show(rn));
  app.bus.on('selection', (sel) => {
    $('#btn-process-selected').disabled = sel.size === 0;
    $('#btn-clear-selection').classList.toggle('hide', sel.size === 0);
    $('#btn-remove-selected').classList.toggle('hide', sel.size === 0);
  });
  app.bus.on('thumbs-needed', (rowNums) => onDemandThumbs(rowNums));
}

app.removeRows = async function(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  await db.deleteImages(ids);
  app.rows = app.rows.filter(r => !idSet.has(r.id));
  app.rowIndex.clear();
  for (let rn = 0; rn < app.rows.length; rn++) {
    app.rowIndex.set(app.rows[rn].id, rn);
  }
  rebuildIndex();
  updateCountsFromRows();
  updateCollectionStats();
  applyFilters();
  toast({ kind: 'ok', title: 'Removed from collection', msg: `${fmtNum(ids.length)} image(s) removed (files on disk are untouched).` });
};

let thumbJobs = 0;
async function onDemandThumbs(rowNums) {
  if (!app.settings) return;
  // throttled background thumbnail generation for visible-but-unprocessed tiles
  const budget = app.engine && (app.engine.state === 'running') ? 1 : 3;
  for (const rn of rowNums) {
    if (thumbJobs >= budget) return;
    const rec = app.rows[rn];
    if (!rec || rec.status === 'missing') continue;
    if (app.grid.lru.has(rec.id)) continue;
    thumbJobs++;
    try {
      const file = await app.source.getFile(rec);
      const res = await app.prep.thumb({ id: rec.id, file, thumbSize: Math.min(256, app.grid.thumbSize * 2), maxMP: app.settings.maxMP });
      await db.putThumb(rec.id, res.thumb);
      rec.width = res.width; rec.height = res.height;
      app.grid.setThumb(rec.id, res.thumb);
    } catch { /* leave placeholder */ }
    finally { thumbJobs--; }
  }
}

function bindCollectionView() {
  $('#grid-viewport').classList.remove('hide');
  $('#empty-state').classList.add('hide');
  $('#collection-info').classList.remove('hide');
  $('#col-name').textContent = app.collection.record.name;
  $('#btn-rescan').disabled = false;
  $('#btn-tag-unprocessed').disabled = false;
  $('#btn-export').disabled = false;
  $('#btn-organize').disabled = !OPS_REQUIREMENTS.ok;
  setJobButtons();
  updateCollectionStats();
  applyFilters();
}

function updateCollectionStats() {
  let total = 0, bytes = 0;
  for (const r of app.rows) { total++; bytes += r.size || 0; }
  $('#col-count').textContent = fmtNum(total);
  $('#col-size').textContent = fmtBytes(bytes);
  app.collection.record.imageCount = total;
  db.putCollection(app.collection.record).catch(() => {});
}

function updateCountsFromRows() {
  const c = { done: 0, failed: 0, skipped: 0, pending: 0, processing: 0, missing: 0 };
  for (const r of app.rows) c[r.status] = (c[r.status] || 0) + 1;
  if (app.engine) app.engine.setCounters(c);
  renderCounts(c);
}

// ---------------------------------------------------------------- scanning
async function rescan(interactivePermission) {
  if (!app.collection) return;
  const kind = app.collection.kind;
  try {
    let fresh;
    if (kind === 'fsa') {
      let perm = await permissionFor(app.dirHandle, 'read');
      if (perm !== 'granted') {
        perm = await requestPermission(app.dirHandle, 'read');
        if (perm !== 'granted') { toast({ kind: 'err', title: 'Permission denied', msg: 'Cannot read the folder without permission.' }); return; }
      }
      fresh = await runScan(() => scanDirectoryHandle(app.dirHandle, app.collection.id, {
        onProgress: (p) => updateScanProgress(p),
        signal: app.scanAbort?.signal,
      }));
    } else {
      toast({ kind: 'info', title: 'Re-pick needed', msg: 'Browser file inputs cannot be re-read after reload — please re-select the folder/files; existing tags will be matched automatically.' });
      return;
    }
    await ingestScan(fresh);
  } catch (e) {
    toast({ kind: 'err', title: 'Scan failed', msg: String(e.message || e) });
  }
}

async function runScan(scanFn) {
  app.scanAbort = new AbortController();
  const label = $('#job-label');
  label.textContent = 'Scanning…';
  const res = await scanFn();
  app.scanAbort = null;
  return res;
}

function updateScanProgress(p) {
  $('#job-label').textContent = `Scanning… ${fmtNum(p.records)} images found (${fmtNum(p.scanned)} entries seen)`;
  $('#job-bar').style.width = '100%';
}

async function ingestScan({ records, scanErrors, aborted }) {
  if (!records) return;
  const existingByPath = new Map(app.rows.map(r => [r.path, r]));
  const { toWrite, toDelete } = diffScan(existingByPath, records);

  // If any files were removed from disk, purge them from DB and in-memory rows
  if (toDelete && toDelete.length) {
    await db.deleteImages(toDelete);
    const delSet = new Set(toDelete);
    app.rows = app.rows.filter(r => !delSet.has(r.id));
    app.rowIndex.clear();
    for (let rn = 0; rn < app.rows.length; rn++) {
      app.rowIndex.set(app.rows[rn].id, rn);
    }
    rebuildIndex();
  }

  // bulk write
  const t0 = performance.now();
  for (let i = 0; i < toWrite.length; i += 1000) {
    await db.putImages(toWrite.slice(i, i + 1000));
    $('#job-label').textContent = `Saving scan… ${fmtNum(Math.min(i + 1000, toWrite.length))}/${fmtNum(toWrite.length)}`;
    await sleep(0);
  }
  // merge into memory
  const oldByPath = new Map(app.rows.map(r => [r.path, r]));
  for (const rec of toWrite) {
    const old = oldByPath.get(rec.path);
    if (old) {
      const rn = app.rowIndex.get(old.id);
      const newRec = { ...old, ...rec, id: old.id };
      app.rows[rn] = newRec;
      updateRowMeta(newRec);
      if (newRec.tagIdx || newRec.manualAdd) app.tagIndex.updateRow(rn, newRec, app.vocab);
    } else {
      const rn = app.rows.length;
      app.rows.push(rec);
      app.rowIndex.set(rec.id, rn);
      updateRowMeta(rec);
      if (rec.tagIdx || rec.manualAdd) app.tagIndex.addRow(rn, rec, app.vocab);
    }
  }
  app.engine?.attachRows(app.rows, app.rowIndex);
  updateCountsFromRows();
  updateCollectionStats();
  applyFilters();
  const added = toWrite.filter(r => !oldByPath.has(r.path)).length;
  const changed = toWrite.length - added;
  const removed = toDelete?.length || 0;
  const errs = scanErrors?.length || 0;
  toast({
    kind: 'ok', title: 'Scan complete',
    msg: `${fmtNum(app.rows.length)} images total (${fmtNum(added)} new, ${fmtNum(changed)} changed${removed ? `, ${fmtNum(removed)} removed` : ''})${errs ? `, ${errs} unreadable entries` : ''}${aborted ? ' — scan was cut short' : ''}. Scan took ${((performance.now() - t0) / 1000).toFixed(1)}s.`,
  });
  if (errs) console.warn('scan errors:', scanErrors.slice(0, 20));
}

// ---------------------------------------------------------------- filtering & view
function applyFilters() {
  if (!app.collection) return;
  const statusF = $('#filter-status').value;
  const sortF = $('#sort-by').value;
  const q = $('#search').value;

  let rns = null;
  if (q.trim()) {
    const set = app.tagIndex.query(q);
    rns = set ? [...set] : null;
  }
  let view = rns === null ? app.rows.map((_, i) => i) : rns.filter(rn => app.rows[rn]);

  if (statusF !== 'all') view = view.filter(rn => app.rows[rn].status === statusF);

  const keyFns = {
    path: (rn) => app.rows[rn].path,
    name: (rn) => app.rows[rn].name.toLowerCase(),
    size: (rn) => -app.rows[rn].size,
    conf: (rn) => -(app.rows[rn].topConf || 0),
    time: (rn) => -(app.rows[rn].tagStamp || 0),
  };
  view.sort((a, b) => {
    const ka = keyFns[sortF](a), kb = keyFns[sortF](b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  app.filtered = view;
  $('#match-count').textContent = `${fmtNum(view.length)} / ${fmtNum(app.rows.length)} shown`;
  app.grid.setRows(view, (rn) => {
    const r = app.rows[rn];
    return { id: r.id, path: r.path, name: r.name, status: r.status, topTag: r.topTag, topTags: r.topTags };
  });
}

const applyFiltersDebounced = debounce(() => applyFilters(), 160);

function refreshRowView(rn) {
  const rec = app.rows[rn];
  if (!rec) return;
  updateRowMeta(rec);
  const g = app.grid;
  if (g?.meta?.has(rn)) {
    g.meta.set(rn, { id: rec.id, path: rec.path, name: rec.name, status: rec.status, topTag: rec.topTag, topTags: rec.topTags });
    g._dirty = true;
    g._scheduleRender();
  }
}

// ---------------------------------------------------------------- engine events
function wireEngineEvents() {
  const e = app.engine;
  e.bus.on('progress', (p) => {
    renderCounts(p.counters);
    const total = app.rows.length || 1;
    const doneAll = p.counters.done + p.counters.skipped;
    const pct = Math.min(100, Math.round((doneAll / total) * 100));
    $('#job-bar').style.width = pct + '%';
    $('#job-label').textContent = p.state === 'running'
      ? `${fmtNum(doneAll)}/${fmtNum(total)} · ${p.rate ? p.rate.toFixed(1) : '—'} img/s · ETA ${fmtDur(p.eta)}${p.queuedLeft ? ` · ${fmtNum(p.queuedLeft)} queued` : ''}`
      : $('#job-label').textContent;
  });
  e.bus.on('state', (st) => {
    setJobButtons();
    if (st === 'paused') $('#job-label').textContent = 'Paused — progress saved. Press Start to resume.';
    if (st === 'error') $('#job-label').textContent = 'Job stopped: pipeline error (see toasts)';
    if (st === 'idle') $('#job-label').textContent = `Finished. ${fmtNum(e.counters.done + e.counters.skipped)} processed, ${fmtNum(e.counters.failed)} failed.`;
  });
  e.bus.on('image-done', ({ rowNum, rec, summary }) => {
    updateRowMeta(rec);
    refreshRowView(rowNum);
    app.inspector?.refreshIfShowing(rowNum);
    setJobButtons();
  });
  e.bus.on('image-failed', ({ rowNum, code, message }) => {
    refreshRowView(rowNum);
    setJobButtons();
  });
  e.bus.on('finished', () => {
    const c = e.counters;
    if (c.failed > 0) {
      toast({ kind: 'warn', title: 'Job finished with failures', msg: `${fmtNum(c.failed)} images failed — use "Retry failed" after fixing the cause.`, timeout: 10000 });
    } else {
      toast({ kind: 'ok', title: 'Job finished', msg: `${fmtNum(c.done)} tagged, ${fmtNum(c.skipped)} duplicates reused.` });
    }
  });
  e.bus.on('fatal', (err) => {
    toast({ kind: 'err', title: 'Job aborted', msg: String(err.message || err), timeout: 15000 });
    updateCountsFromRows();
  });
  e.bus.on('model-trouble', ({ restarts, error }) => {
    toast({ kind: 'warn', title: `Runtime problem (attempt ${restarts})`, msg: String(error), timeout: 8000 });
  });
  e.bus.on('ep-fallback', ({ from, to }) => {
    toast({ kind: 'warn', title: 'Switched execution provider', msg: `${from} → ${to} (automatic fallback)`, timeout: 10000 });
    setEpStatus(`fallback: ${to}`);
  });
  e.bus.on('device-lost', () => {
    toast({ kind: 'err', title: 'GPU device lost', msg: 'The browser dropped the WebGPU device. Attempting recovery…', timeout: 10000 });
  });
}

function setJobButtons() {
  const st = app.engine?.state || 'idle';
  $('#btn-start').textContent = st === 'paused' ? 'Resume' : (st === 'running' ? 'Running…' : 'Start tagging');
  // note: the click handler loads the model on demand, so model readiness is not required here
  $('#btn-start').disabled = !app.collection || st === 'running' || st === 'pausing';
  $('#btn-pause').disabled = st !== 'running';
  $('#btn-retry-failed').disabled = !(app.rows || []).some(r => r?.status === 'failed');
}

function renderCounts(c) {
  $('#c-done').textContent = fmtNum(c.done || 0);
  $('#c-failed').textContent = fmtNum(c.failed || 0);
  $('#c-skipped').textContent = fmtNum(c.skipped || 0);
  $('#c-pending').textContent = fmtNum(c.pending || 0);
  $('#c-processing').textContent = fmtNum(c.processing || 0);
}

// ---------------------------------------------------------------- model management
function currentVariant() {
  const id = app.settings.lastVariant || app.registry.find(v => v.eps.includes('wasm'))?.id;
  return app.registry.find(v => v.id === id) || app.registry[0];
}

function setModelStatus(kind, text) {
  const box = $('#model-status');
  box.className = 'model-status ' + kind;
  $('#model-status-text').textContent = text;
}

function setEpStatus(text) { $('#ep-status').textContent = text; }

async function loadVariant(variant, { wantEP = null, silent = false } = {}) {
  if (app.modelBusy) { toast({ kind: 'warn', title: 'Model switch busy' }); return false; }
  app.modelBusy = true;
  setModelStatus('busy', `Loading ${variant.label}…`);
  $('#model-progress').classList.add('hide');
  try {
    app.vocab = await app.modelCache.ensureTags();
    if (app.rows && app.rows.length) {
      for (const r of app.rows) updateRowMeta(r);
      if (app.grid) applyFilters();
    }
    let file;
    try {
      file = await app.modelCache.modelFile(variant.id);
      if (variant.size && Math.abs(file.size - variant.size) > 1024) {
        throw new Error(`cached file is ${fmtBytes(file.size)}, expected ${fmtBytes(variant.size)} — re-download required`);
      }
    } catch (e) {
      if (!variant.url) {
        if (!silent) toast({ kind: 'err', title: 'Model not available locally', msg: 'Open Model manager and download it first. ' + e.message });
        setModelStatus('error', 'Model not downloaded');
        return false;
      }
      // auto-download with progress (basic flow: Start tagging just works)
      setModelStatus('busy', `Downloading ${variant.label}…`);
      $('#model-progress').classList.remove('hide');
      const bar = $('#model-bar'), label = $('#model-progress-label');
      const onProg = (m) => {
        const pct = m.total ? Math.round((m.received / m.total) * 100) : 0;
        bar.style.width = pct + '%';
        label.textContent = m.phase === 'verify' || m.phase === 'verify-full'
          ? `Verifying SHA-256… ${pct}%`
          : `${fmtBytes(m.received)} / ${fmtBytes(m.total || variant.size)} · ${pct}% · ${fmtBytes(m.rate || 0)}/s`;
      };
      const off = app.modelCache.bus.on('progress', onProg);
      try {
        await app.modelCache.download(variant);
      } catch (dle) {
        toast({ kind: 'err', title: 'Model download failed', msg: String(dle.message || dle), timeout: 12000 });
        setModelStatus('error', 'Download failed');
        return false;
      } finally { off(); $('#model-progress').classList.add('hide'); }
      file = await app.modelCache.modelFile(variant.id);
    }
    // configure thresholds + vocab for postprocessing
    const cfgRes = await app.model.configure({
      vocab: { size: app.vocab.size, names: app.vocab.names, catOf: app.vocab.catOf, index: app.vocab.index },
      thresholds: app.settings.thresholds,
      catEnabled: app.settings.catEnabled,
    });
    const init = await app.model.init({
      modelBlob: file,
      variant,
      wantEP: wantEP || (app.settings.wantEP === 'auto' ? null : app.settings.wantEP),
      threads: app.settings.threads || null,
      batchSize: app.settings.batchSize,
    });
    app.settings.lastVariant = variant.id;
    if (app.engine) app.engine._modelVariantId = variant.id;
    saveSettings();
    setModelStatus('loaded', variant.label);
    setEpStatus(`${init.ep === 'webgpu' ? 'WebGPU' : 'WASM'}${init.threads > 1 ? ` × ${init.threads}` : ''} · load ${init.loadMs / 1000 | 0}s · batch ${init.batchSize}`);
    if (init.triedFallbacks?.length) {
      for (const f of init.triedFallbacks) {
        toast({ kind: 'warn', title: `${f.ep.toUpperCase()} fallback to ${init.ep.toUpperCase()}`, msg: `${f.why}. Loaded with ${init.ep.toUpperCase()}.`, timeout: 12000 });
      }
    }
    $('#btn-unload-model').disabled = false;
    setJobButtons();
    app.bus.emit('model-loaded', init);
    return true;
  } catch (e) {
    console.error('model load failed', e);
    setModelStatus('error', 'Model failed to load');
    const tried = e.tried?.map(t => `${t.ep}: ${t.why}`).join('; ');
    toast({ kind: 'err', title: 'Model failed to load', msg: String(e.message || e) + (tried ? ' — ' + tried : ''), timeout: 15000 });
    return false;
  } finally {
    app.modelBusy = false;
  }
}

async function autoLoadCachedModel() {
  // try the last-used variant if it's already fully cached
  const id = app.settings.lastVariant;
  if (!id) return;
  const variant = app.registry.find(v => v.id === id);
  if (!variant) return;
  try {
    const file = await app.modelCache.modelFile(id);
    if (file.size !== variant.size) return;
    await loadVariant(variant, { silent: true });
  } catch { /* not cached */ }
}

// ---------------------------------------------------------------- UI: model manager
function openModelManager() {
  const body = el('div');
  const statusLine = el('div', { class: 'hint', text: app.modelCache.opfsOk === false ? '⚠ OPFS unavailable in this browser — models cannot be cached. Use a Chromium/Firefox/Safari recent browser.' : '' });
  const list = el('div');
  body.append(statusLine, list);

  const epSel = el('select', {}, el('option', { value: 'auto', text: 'Execution: Auto (recommended)' }), el('option', { value: 'webgpu', text: 'Force WebGPU' }), el('option', { value: 'wasm', text: 'Force WASM (CPU)' }));
  epSel.value = app.settings.wantEP;
  epSel.addEventListener('change', () => { app.settings.wantEP = epSel.value; saveSettings(); });
  body.append(el('div', { style: 'margin:8px 0' }, epSel));

  const localInput = el('input', { type: 'file', accept: '.onnx,model/onnx' });
  const tagsInput = el('input', { type: 'file', accept: '.json' });
  body.append(
    el('details', {}, el('summary', { text: 'Load model from local files (offline use)' }),
      el('div', { class: 'opt' }, 'Model (.onnx): ', localInput),
      el('div', { class: 'opt' }, 'Tags (tags.json or camie metadata .json): ', tagsInput),
      el('button', {
        class: 'btn small', text: 'Load local model',
        onclick: async () => {
          if (!localInput.files[0]) { toast({ kind: 'warn', title: 'Pick an .onnx file' }); return; }
          try {
            // copy into OPFS for persistence & low-memory loading
            const root = await navigator.storage.getDirectory();
            const fh = await root.getFileHandle('model-local-custom.onnx', { create: true });
            const w = await fh.createWritable();
            await localInput.files[0].stream().pipeTo(w);
            if (tagsInput.files[0]) {
              const txt = await tagsInput.files[0].text();
              await app.modelCache.ensureTagsFromLocal(txt);
            } else if (!app.vocab) {
              toast({ kind: 'warn', title: 'Tags file recommended', msg: 'Continuing with cached vocabulary.' });
            }
            const variant = { id: 'local-custom', label: 'Local model (custom)', url: null, size: localInput.files[0].size, eps: ['webgpu', 'wasm'], note: 'User-supplied ONNX' };
            app.registry = [...app.registry.filter(v => v.id !== 'local-custom'), variant];
            app.modelCache._send({ type: 'delete', path: 'model-local-custom.onnx.meta', req: 'x' + Math.random() });
            await loadVariant(variant);
            m.close();
          } catch (e) {
            toast({ kind: 'err', title: 'Local model load failed', msg: String(e.message || e) });
          }
        },
      })),
  );

  const render = async () => {
    list.innerHTML = '';
    const paths = app.registry.map(v => `model-${v.id}.onnx`);
    const stats = await app.modelCache.stat(paths.concat(['model-local-custom.onnx']));
    for (const v of app.registry) {
      const st = stats[`model-${v.id}.onnx`] || { exists: false, size: 0 };
      const cached = st.exists && (!v.size || Math.abs(st.size - v.size) < 1024);
      const card = el('div', { class: 'modelcard' + (cached ? ' cached' : '') });
      const badges = v.eps.map(ep => el('span', { class: 'mbadge', text: ep === 'webgpu' ? 'WebGPU' : 'CPU/WASM' }));
      let epChoice = null;
      if (v.eps.length > 1) {
        epChoice = el('select', { class: 'small', title: 'Choose execution provider for this model' },
          el('option', { value: '', text: 'EP: Auto' }),
          ...v.eps.map(ep => el('option', { value: ep, text: ep === 'webgpu' ? 'WebGPU' : 'CPU/WASM' }))
        );
      }
      const isLoaded = !!(app.model?.ready && app.model?.info?.variantId === v.id);
      const loadBtn = el('button', {
        class: 'btn small primary' + (isLoaded ? ' is-loaded' : ''),
        text: isLoaded ? 'Loaded ✓' : 'Load',
        title: isLoaded ? 'Model is currently active' : 'Load this model',
        disabled: app.modelBusy || isLoaded,
      });
      loadBtn.addEventListener('click', async () => {
        loadBtn.disabled = true;
        try {
          await loadVariant(v, { wantEP: epChoice?.value || null });
        } finally {
          render();
        }
      });
      let unloadBtn = null;
      if (isLoaded) {
        unloadBtn = el('button', {
          class: 'btn small danger-ghost',
          text: 'Unload',
          title: 'Unload this model from memory',
          onclick: async () => {
            unloadBtn.disabled = true;
            await app.model.dispose();
            app.settings.lastVariant = null;
            saveSettings();
            setModelStatus('idle', 'Model unloaded');
            $('#btn-unload-model').disabled = true;
            setEpStatus('—');
            setJobButtons();
            app.bus.emit('model-unloaded');
            render();
          },
        });
      }
      const dlBtn = el('button', { class: 'btn small', text: cached ? 'Re-download' : 'Download' });
      const delBtn = el('button', { class: 'btn small danger-ghost', text: 'Delete', disabled: !cached });
      delBtn.addEventListener('click', async () => {
        if (!(await confirmDialog(`Delete the cached ${v.label} (${fmtBytes(v.size)}) from browser storage?`, { danger: true, okLabel: 'Delete' }))) return;
        delBtn.disabled = true;
        await app.modelCache.deleteModel(v.id);
        render();
      });
      const prog = el('div', { class: 'hide' }, el('div', { class: 'bar' }, (b => b)(el('div'))), el('div', { class: 'bar-label' }));
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        prog.classList.remove('hide');
        const bar = prog.querySelector('.bar > div');
        const label = prog.querySelector('.bar-label');
        const onProg = (m) => {
          const pct = m.total ? Math.round((m.received / m.total) * 100) : 0;
          bar.style.width = pct + '%';
          label.textContent = m.phase === 'verify' || m.phase === 'verify-full'
            ? `Verifying SHA-256… ${pct}%`
            : `${fmtBytes(m.received)} / ${fmtBytes(m.total || v.size)} · ${pct}% · ${fmtBytes(m.rate || 0)}/s`;
        };
        const off = app.modelCache.bus.on('progress', onProg);
        try {
          await app.modelCache.download(v);
          toast({ kind: 'ok', title: 'Model downloaded', msg: v.label });
        } catch (e) {
          if (!e.aborted) toast({ kind: 'err', title: 'Download failed', msg: String(e.message || e), timeout: 12000 });
        } finally {
          off();
          render();
        }
      });
      card.append(
        el('div', { class: 'mrow' },
          el('span', { class: 'mname', text: v.label }),
          el('span', { class: 'msize', text: fmtBytes(v.size) }),
          cached ? el('span', { class: 'mbadge rec', text: 'cached ✓' }) : null,
          ...badges,
          el('span', { class: 'spacer' }),
          epChoice, loadBtn, unloadBtn, dlBtn, delBtn),
        el('div', { class: 'mnote', text: (v.note || '') + (v.eps.includes('webgpu') ? ' Pick this for speed if your browser has WebGPU.' : '') }),
        prog,
      );
      list.append(card);
    }
  };
  render().then(() => { /* noop */ });
  const offLoaded = app.bus.on('model-loaded', () => render());
  const offUnloaded = app.bus.on('model-unloaded', () => render());
  const m = modal({
    title: 'Model manager — Camie Tagger v2',
    body, wide: true,
    buttons: [{ label: 'Close' }],
    onClose: () => { offLoaded(); offUnloaded(); },
  });
}

// ---------------------------------------------------------------- UI: settings
function openSettings() {
  const body = el('div');
  const cats = CATEGORY_ORDER; // ['character', 'copyright', 'artist', 'general', 'meta', 'rating', 'year']
  const vals = {};
  const en = {};
  const ranges = {};
  const nums = {};
  const cbs = {};

  const setCategoryValue = (c, val) => {
    vals[c] = val;
    if (ranges[c]) ranges[c].value = String(val);
    if (nums[c]) nums[c].textContent = val.toFixed(2);
  };

  const thr = el('div', { class: 'thr-grid' });
  for (const c of cats) {
    const v = app.settings.thresholds[c] ?? 0.50;
    const range = el('input', { type: 'range', min: '0.05', max: '0.95', step: '0.01', value: String(v) });
    const num = el('span', { class: 'val', text: v.toFixed(2) });
    ranges[c] = range;
    nums[c] = num;
    range.addEventListener('input', () => {
      vals[c] = parseFloat(range.value);
      num.textContent = parseFloat(range.value).toFixed(2);
    });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = app.settings.catEnabled[c] ?? true;
    cbs[c] = cb;
    cb.addEventListener('change', () => { en[c] = cb.checked; });
    const labelText = CATEGORY_LABELS[c] || c;
    thr.append(
      el('b', { text: labelText, title: `${c} (${labelText})` }),
      range,
      num,
      el('label', { class: 'opt', style: 'grid-column:1/4;margin-bottom:6px;' }, cb, ` Include ${labelText} tags in results`)
    );
  }

  // Profile presets
  const profileRow = el('div', { class: 'btn-row', style: 'margin-bottom:14px;flex-wrap:wrap;' });
  for (const [k, p] of Object.entries(THRESHOLD_PROFILES)) {
    profileRow.append(el('button', {
      class: 'btn small', text: p.label,
      onclick: () => {
        for (const c of cats) {
          if (p.values[c] !== undefined) {
            setCategoryValue(c, p.values[c]);
          }
        }
      },
    }));
  }

  body.append(
    el('p', { class: 'hint', text: 'Set confidence thresholds per category. Lowering thresholds increases recall (shows more tags); raising thresholds increases precision. Characters and Series thresholds are prioritized for organization.' }),
    el('div', { style: 'margin:8px 0 4px;' }, el('b', { text: 'Quick Profiles:' })),
    profileRow,
    thr,
    el('hr', { style: 'margin:14px 0;' }),
    el('label', { class: 'opt' }, 'Tags displayed per image card (at least 4 allowed): ',
      el('input', { type: 'number', id: 'set-gridtagcount', class: 'num', min: '1', max: '8', value: String(app.settings.gridTagCount || 4) })),
    el('label', { class: 'opt' }, 'Decode pixel budget (MP; larger images fail with E_TOO_LARGE instead of exhausting memory): ',
      el('input', { type: 'number', id: 'set-maxmp', class: 'num', min: '16', max: '400', value: String(app.settings.maxMP) })),
    el('label', { class: 'opt' }, 'Thumbnail long-edge px: ',
      el('input', { type: 'number', id: 'set-thumbsize', class: 'num', min: '96', max: '256', value: String(app.settings.thumbSize) })),
    el('label', { class: 'opt' }, 'Grid thumb cache (object URLs): ',
      el('input', { type: 'number', id: 'set-thumbcache', class: 'num', min: '64', max: '2000', value: String(app.settings.thumbCache) })),
  );

  modal({
    title: 'Thresholds & settings',
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', onClick: async () => {
          for (const c of cats) {
            if (vals[c] !== undefined) app.settings.thresholds[c] = vals[c];
            if (en[c] !== undefined) app.settings.catEnabled[c] = en[c];
          }
          app.settings.gridTagCount = Math.max(1, parseInt($('#set-gridtagcount').value) || 4);
          app.settings.maxMP = parseInt($('#set-maxmp').value) || 120;
          app.settings.thumbSize = parseInt($('#set-thumbsize').value) || 144;
          app.settings.thumbCache = parseInt($('#set-thumbcache').value) || 384;
          saveSettings();

          rebuildIndex();
          if (app.rows && app.rows.length) {
            for (const r of app.rows) updateRowMeta(r);
            if (app.grid) applyFilters();
          }
          if (app.inspector?.current != null) {
            app.inspector._renderTags();
          }
          if (app.model?.ready) {
            await app.model.configure({
              vocab: { size: app.vocab.size, names: app.vocab.names, catOf: app.vocab.catOf, index: app.vocab.index },
              thresholds: app.settings.thresholds,
              catEnabled: app.settings.catEnabled,
            });
          }
          toast({ kind: 'ok', title: 'Thresholds applied', msg: 'Thresholds updated and applied immediately across all images.' });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- UI: export
function openExport() {
  const eligible = app.rows.filter(r => r.status !== 'missing');
  const doneCount = eligible.filter(r => r.status === 'done' || r.status === 'skipped').length;
  const body = el('div');
  const sel = el('select', { class: 'lang' },
    el('option', { value: 'json', text: `JSON — full metadata (all ${fmtNum(eligible.length)} images)` }),
    el('option', { value: 'csv', text: `CSV — one row per image (summary columns)` }),
    el('option', { value: 'csv-long', text: `CSV — long form: one row per (image, tag, confidence)` }),
    el('option', { value: 'txtzip', text: `ZIP of .txt files — one per image, WD14/kohya-style (tagged only, ${fmtNum(doneCount)})` }),
  );
  const minP = el('input', { type: 'number', class: 'num', min: '0', max: '1', step: '0.01', value: '0' });
  const onlyTagged = el('input', { type: 'checkbox', checked: true });
  body.append(
    el('div', { class: 'opt' }, 'Format: ', sel),
    el('div', { class: 'opt' }, 'Min confidence to include: ', minP),
    el('div', { class: 'opt' }, onlyTagged, ' Only include images that have tags (skip untagged/failed)'),
    el('div', { class: 'hint', text: 'Exports stream through browser storage — safe for 50k+ images. Manual edits (added/removed tags) are included. Manual tags have confidence 1.' }),
  );
  const progWrap = el('div', { class: 'hide' }, el('div', { class: 'bar' }, el('div')), el('div', { class: 'bar-label' }));
  body.append(progWrap);
  modal({
    title: 'Export metadata',
    body,
    wide: true,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Export…', kind: 'primary', keepOpen: true, onClick: async (close) => {
          const ctrl = new AbortController();
          const bar = progWrap.querySelector('.bar > div');
          const label = progWrap.querySelector('.bar-label');
          progWrap.classList.remove('hide');
          let records = eligible;
          if (onlyTagged.checked) records = records.filter(r => r.status === 'done' || r.status === 'skipped');
          try {
            const { file, filename } = await exportRecords({
              records,
              vocab: app.vocab,
              format: sel.value,
              collection: app.collection.record,
              options: {
                minProb: parseFloat(minP.value) || 0,
                thresholds: app.settings?.thresholds,
                catEnabled: app.settings?.catEnabled,
              },
              onProgress: (n, total) => {
                bar.style.width = Math.round((n / Math.max(1, total)) * 100) + '%';
                label.textContent = `Writing… ${fmtNum(n)}/${fmtNum(total)}`;
              },
              signal: ctrl.signal,
            });
            await saveFileToUser(file, filename, sel.value === 'json' ? 'application/json' : sel.value.startsWith('csv') ? 'text/csv' : 'application/zip');
            toast({ kind: 'ok', title: 'Export saved', msg: filename });
            close();
          } catch (e) {
            if (e.aborted) return;
            toast({ kind: 'err', title: 'Export failed', msg: String(e.message || e) });
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- UI: organize
function openOrganize() {
  if (!OPS_REQUIREMENTS.ok) {
    modal({ title: 'File organization unavailable', body: `<p>${escapeHtml(OPS_REQUIREMENTS.why)}</p>`, buttons: [{ label: 'OK' }] });
    return;
  }
  const body = el('div');
  const tabs = el('div', { class: 'btn-row' });
  const content = el('div');
  const rootHandle = app.dirHandle || app.source.root();
  const hasRoot = !!rootHandle;
  if (!hasRoot) {
    body.append(el('p', { class: 'hint', text: 'This collection was opened with the file-picker fallback, so files cannot be modified in place. Re-open the folder with "Open folder…" (Chrome/Edge) to enable file operations.' }));
    modal({ title: 'Organize files', body, buttons: [{ label: 'Close' }] });
    return;
  }

  const mkTokenPill = (token, targetInput, onInsert) => {
    const pill = el('span', { class: 'token-pill', text: token, title: `Click to insert ${token}` });
    pill.addEventListener('click', () => {
      const el = targetInput;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const val = el.value;
      el.value = val.slice(0, start) + token + val.slice(end);
      el.focus();
      const nextPos = start + token.length;
      el.setSelectionRange(nextPos, nextPos);
      if (onInsert) onInsert(el.value);
    });
    return pill;
  };

  // --- rename tab
  const renamePreset = el('select', { class: 'lang' },
    el('option', { value: '{tag1} + {tag2} - {name}.{ext}', text: 'Combination: {tag1} + {tag2} - {name}.{ext}' }),
    el('option', { value: '{index}_{tag1}_{tag2}.{ext}', text: 'Index & Top 2: {index}_{tag1}_{tag2}.{ext}' }),
    el('option', { value: '{tag1} - {name}.{ext}', text: 'Top 1 Tag: {tag1} - {name}.{ext}' }),
    el('option', { value: '{name} [{tag1+tag2}].{ext}', text: 'Bracketed: {name} [{tag1+tag2}].{ext}' }),
    el('option', { value: '{artist} - {character} - {name}.{ext}', text: 'Artist & Character: {artist} - {character} - {name}.{ext}' }),
    el('option', { value: 'custom', text: 'Custom rename template…' }),
  );
  const tplInput = el('input', { class: 'lang', value: '{tag1} + {tag2} - {name}.{ext}', spellcheck: 'false', placeholder: '{tag1} + {tag2} - {name}.{ext}' });
  renamePreset.addEventListener('change', () => {
    if (renamePreset.value !== 'custom') tplInput.value = renamePreset.value;
  });
  tplInput.addEventListener('input', () => {
    const found = [...renamePreset.options].find(o => o.value === tplInput.value);
    renamePreset.value = found ? found.value : 'custom';
  });

  const renamePills = el('div', { class: 'token-list' },
    el('span', { class: 'token-label', text: 'Insert token:' }),
    mkTokenPill('{tag1}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{tag2}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{tag3}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{tag1+tag2}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{name}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{ext}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{index}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{artist}', tplInput, () => { renamePreset.value = 'custom'; }),
    mkTokenPill('{character}', tplInput, () => { renamePreset.value = 'custom'; }),
  );

  const renamePreview = el('div', { class: 'prewiew-list' });
  const renameBtn = el('button', { class: 'btn small', text: 'Preview' });
  const renameExec = el('button', { class: 'btn small primary', text: 'Rename…', disabled: true });
  let renamePlan = [];
  renameBtn.addEventListener('click', async () => {
    const targets = selectedOrAll(true);
    if (!targets.length) { toast({ kind: 'warn', title: 'Nothing to rename' }); return; }
    renameBtn.disabled = true;
    renamePreview.innerHTML = '';
    try {
      renamePlan = await planRenames(rootHandle, targets, tplInput.value, (rec) => tagsContext(rec), {});
      const sample = renamePlan.slice(0, 300);
      for (const p of sample) {
        renamePreview.append(el('div', { class: 'pr' + (p.conflict ? ' conflict' : '') },
          el('span', { text: p.fromPath }), el('span', { class: 'arr', text: '→' }), el('span', { class: 'to', text: p.toPath })));
      }
      if (renamePlan.length > 300) renamePreview.append(el('div', { class: 'pr' }, el('span', { text: `…and ${fmtNum(renamePlan.length - 300)} more` })));
      if (!renamePlan.length) renamePreview.append(el('div', { class: 'pr' }, el('span', { text: 'Nothing to change with this template.' })));
      renameExec.disabled = !renamePlan.some(p => !p.conflict);
    } catch (e) {
      toast({ kind: 'err', title: 'Preview failed', msg: String(e.message || e) });
    } finally { renameBtn.disabled = false; }
  });
  renameExec.addEventListener('click', async () => {
    const withConflicts = renamePlan.filter(p => p.conflict);
    if (withConflicts.length && !(await confirmDialog(`${withConflicts.length} planned names collide with existing files. Conflicts will be SKIPPED (no suffixing at execute time). Continue?`, { danger: true, okLabel: 'Skip conflicts & run' }))) return;
    await runOpsWithProgress(`Renaming ${fmtNum(renamePlan.length)} files…`, (onProgress, signal) =>
      executeOps(rootHandle, renamePlan, { onProgress, signal, writeUndo: true }), (newPaths) => refreshPaths(newPaths));
    renameExec.disabled = true;
  });

  // --- move tab
  const movePreset = el('select', { class: 'lang' },
    el('option', { value: '{tag1} + {tag2}', text: 'Combination of First Two Tags: {tag1} + {tag2}' }),
    el('option', { value: '{tag1}/{tag2}', text: 'Nested Subfolders: First Two Tags: {tag1}/{tag2}' }),
    el('option', { value: '{tag1}', text: 'Single Tag: Top 1 Tag: {tag1}' }),
    el('option', { value: '{tag2}', text: 'Single Tag: Top 2nd Tag: {tag2}' }),
    el('option', { value: '{tag1} + {tag2} + {tag3}', text: 'Combination of First Three Tags: {tag1} + {tag2} + {tag3}' }),
    el('option', { value: '{tag1}/{tag2}/{tag3}', text: 'Nested Subfolders: First Three Tags: {tag1}/{tag2}/{tag3}' }),
    el('option', { value: '{artist}', text: 'Category: Artist: {artist}' }),
    el('option', { value: '{character}', text: 'Category: Character: {character}' }),
    el('option', { value: '{copyright}', text: 'Category: Copyright / Series: {copyright}' }),
    el('option', { value: '{rating}', text: 'Category: Rating: {rating}' }),
    el('option', { value: 'custom', text: 'Custom folder pattern…' }),
  );
  const movePatternInput = el('input', { class: 'lang', value: '{tag1} + {tag2}', spellcheck: 'false', placeholder: 'e.g. {tag1} + {tag2} or {tag1}/{tag2}' });
  movePreset.addEventListener('change', () => {
    if (movePreset.value !== 'custom') movePatternInput.value = movePreset.value;
  });
  movePatternInput.addEventListener('input', () => {
    const found = [...movePreset.options].find(o => o.value === movePatternInput.value);
    movePreset.value = found ? found.value : 'custom';
  });

  const movePills = el('div', { class: 'token-list' },
    el('span', { class: 'token-label', text: 'Insert token:' }),
    mkTokenPill('{tag1}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{tag2}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{tag3}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{tag1} + {tag2}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{tag1}/{tag2}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{artist}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{character}', movePatternInput, () => { movePreset.value = 'custom'; }),
    mkTokenPill('{copyright}', movePatternInput, () => { movePreset.value = 'custom'; }),
  );

  const moveSummary = el('div', { class: 'folder-summary' });
  const movePreview = el('div', { class: 'prewiew-list' });
  const moveBtn = el('button', { class: 'btn small', text: 'Preview' });
  const moveExec = el('button', { class: 'btn small primary', text: 'Move…', disabled: true });
  let movePlan = [];

  moveBtn.addEventListener('click', async () => {
    const targets = selectedOrAll(true).filter(r => r.status === 'done' || r.status === 'skipped');
    if (!targets.length) { toast({ kind: 'warn', title: 'No tagged images in scope' }); return; }
    moveBtn.disabled = true;
    movePreview.innerHTML = '';
    moveSummary.textContent = '';
    const pattern = movePatternInput.value.trim() || '{tag1} + {tag2}';
    try {
      movePlan = await planMoves(
        rootHandle,
        targets,
        (rec, tagsFor, i) => renderTemplate(pattern, rec, tagsFor(rec), i),
        (rec) => tagsContext(rec),
        {}
      );
      const uniqueDirs = new Set(movePlan.map(p => p.targetDirPath)).size;
      moveSummary.textContent = `📦 Planned: ${fmtNum(movePlan.length)} files will be organized into ${fmtNum(uniqueDirs)} distinct folder${uniqueDirs === 1 ? '' : 's'}.`;
      for (const p of movePlan.slice(0, 300)) {
        movePreview.append(el('div', { class: 'pr' + (p.conflict ? ' conflict' : '') },
          el('span', { text: p.fromPath }), el('span', { class: 'arr', text: '→' }), el('span', { class: 'to', text: p.toPath })));
      }
      if (movePlan.length > 300) movePreview.append(el('div', { class: 'pr' }, el('span', { text: `…and ${fmtNum(movePlan.length - 300)} more` })));
      moveExec.disabled = !movePlan.some(p => !p.conflict);
    } catch (e) {
      toast({ kind: 'err', title: 'Preview failed', msg: String(e.message || e) });
    } finally { moveBtn.disabled = false; }
  });

  moveExec.addEventListener('click', async () => {
    const withConflicts = movePlan.filter(p => p.conflict);
    if (withConflicts.length && !(await confirmDialog(`${withConflicts.length} planned destination paths collide. Conflicting files will be skipped. Continue?`, { danger: true, okLabel: 'Move files' }))) return;
    await runOpsWithProgress(`Moving ${fmtNum(movePlan.length)} files…`, (onProgress, signal) =>
      executeOps(rootHandle, movePlan, { onProgress, signal, writeUndo: true }), (newPaths) => refreshPaths(newPaths));
    moveExec.disabled = true;
  });

  // --- txt sidecars tab
  const txtBtn = el('button', { class: 'btn small primary', text: `Write .txt next to images (${fmtNum(app.rows.filter(r => r.status === 'done' || r.status === 'skipped').length)} tagged)` });
  txtBtn.addEventListener('click', async () => {
    const targets = selectedOrAll(true).filter(r => r.status === 'done' || r.status === 'skipped');
    if (!targets.length) { toast({ kind: 'warn', title: 'No tagged images in scope' }); return; }
    if (!(await confirmDialog(`Write a ${'<name>'}.txt file with comma-separated tags next to each of ${fmtNum(targets.length)} images?\nExisting .txt files are not overwritten.`, { okLabel: 'Write .txt files' }))) return;
    await runOpsWithProgress(`Writing .txt sidecars…`, (onProgress, signal) =>
      writeSidecars(rootHandle, targets, (rec) => effectiveTags(rec, app.vocab, {
        thresholds: app.settings?.thresholds,
        catEnabled: app.settings?.catEnabled,
        orderBy: 'category',
      }).map(t => t.name).join(', '), { onProgress, signal, writeUndo: true }), null, true);
  });

  // --- undo
  const undoBtn = el('button', { class: 'btn small', text: 'Undo last file operation…' });
  undoBtn.addEventListener('click', async () => {
    const entries = await db.iterUndo(app.collection.id);
    if (!entries.length) { toast({ kind: 'info', title: 'Nothing to undo' }); return; }
    const lastTs = Math.max(...entries.map(e => e.ts));
    const batch = entries.filter(e => Math.abs(e.ts - lastTs) < 60000);
    const txtBatch = batch.filter(e => e.kind === 'txt');
    const mvBatch = batch.filter(e => e.kind !== 'txt');
    if (!(await confirmDialog(`Undo the last operation batch?\n${mvBatch.length} renames/moves${txtBatch.length ? ` + ${txtBatch.length} .txt deletions` : ''}`, { okLabel: 'Undo' }))) return;
    await runOpsWithProgress('Undoing…', async (onProgress, signal) => {
      const r1 = await undoOps(rootHandle, mvBatch, { onProgress, signal });
      const r2 = await undoSidecars(rootHandle, txtBatch, { onProgress, signal });
      await db.deleteUndo([...mvBatch, ...txtBatch].map(e => e.id));
      const restore = new Map(mvBatch.map(e => [e.recId, e.fromPath]));
      // restore record paths
      for (const [recId, fromPath] of restore) {
        const rn = app.rowIndex.get(recId);
        if (rn != null && app.rows[rn]) { app.rows[rn].path = fromPath; await db.putImages([app.rows[rn]]); }
      }
      applyFilters();
      toast({ kind: 'ok', title: 'Undo complete', msg: `${r1.done + r2.done} restored, ${r1.failed + r2.failed} failed.` });
      return { done: r1.done + r2.done };
    }, null, true);
  });

  function showTab(which) {
    content.innerHTML = '';
    if (which === 'rename') {
      content.append(
        el('p', { class: 'hint', text: 'Rename images using tag tokens and presets. Tokens: {tag1} {tag2} {tag1+tag2} {name} {ext} {index} {artist} {character}.' }),
        el('div', { class: 'opt' }, 'Preset: ', renamePreset),
        el('div', { class: 'opt' }, 'Template: ', tplInput),
        renamePills,
        el('div', { class: 'btn-row' }, renameBtn, renameExec),
        renamePreview,
      );
    } else if (which === 'move') {
      content.append(
        el('p', { class: 'hint', text: 'Create folders based on tag combinations or individual tags. Subfolders are created on disk as needed. Undoable anytime.' }),
        el('div', { class: 'opt' }, 'Preset: ', movePreset),
        el('div', { class: 'opt' }, 'Folder pattern: ', movePatternInput),
        movePills,
        moveSummary,
        el('div', { class: 'btn-row' }, moveBtn, moveExec),
        movePreview,
      );
    } else if (which === 'txt') {
      content.append(
        el('p', { class: 'hint', text: 'Writes <name>.txt (comma-separated tags, WD14 training format) next to each image.' }),
        el('div', { class: 'btn-row' }, txtBtn),
      );
    } else {
      content.append(
        el('p', { class: 'hint', text: 'Reverts the most recent batch of renames/moves/sidecars recorded by Tagmill (per collection).' }),
        el('div', { class: 'btn-row' }, undoBtn),
      );
    }
  }
  const mkTab = (id, label) => {
    const b = el('button', { class: 'btn small', text: label });
    b.addEventListener('click', () => { [...tabs.children].forEach(c => c.classList.remove('primary')); b.classList.add('primary'); showTab(id); });
    return b;
  };
  tabs.append(mkTab('rename', 'Rename by template'), mkTab('move', 'Move into tag folders'), mkTab('txt', 'Write .txt sidecars'), mkTab('undo', 'Undo'));
  body.append(tabs, content);
  modal({ title: 'Organize files', body, wide: true, buttons: [{ label: 'Close' }] });
  tabs.children[0].click();

  function tagsContext(rec) {
    const all = effectiveTags(rec, app.vocab, {
      thresholds: app.settings?.thresholds,
      catEnabled: app.settings?.catEnabled,
      orderBy: 'category',
    });
    const byCat = { 9: [], 1: [], 3: [], 4: [], 0: [], 5: [], 6: [] };
    for (const t of all) (byCat[t.cat] ??= []).push(t);
    return { allTags: all, tagsByCat: byCat };
  }
  function tagsByCat(rec) {
    return tagsContext(rec).tagsByCat;
  }
  function selectedOrAll(onlyTaggedForRename = false) {
    const sel = [...app.grid.selected];
    let targets = sel.length ? sel.map(rn => app.rows[rn]) : app.filtered.map(rn => app.rows[rn]);
    return targets.filter(r => r && r.status !== 'missing');
  }
  async function refreshPaths(newPaths) {
    for (const [recId, p] of newPaths) {
      const rn = app.rowIndex.get(recId);
      if (rn != null) app.rows[rn].path = p;
    }
    applyFilters();
    await rescanSilent();
  }
}

async function rescanSilent() {
  if (app.collection?.kind !== 'fsa') return;
  try {
    const fresh = await scanDirectoryHandle(app.dirHandle, app.collection.id, { signal: null });
    await ingestScan(fresh);
  } catch (e) { console.warn('silent rescan failed', e); }
}

async function runOpsWithProgress(label, opFn, afterFn, skipFinalToast = false) {
  const prog = el('div', {},
    el('div', { class: 'bar' }, el('div')),
    el('div', { class: 'bar-label', text: label }));
  const ctrl = new AbortController();
  const m = modal({
    title: label,
    body: prog,
    buttons: [{ label: 'Abort', onClick: () => ctrl.abort() }],
    onClose: () => ctrl.abort(),
  });
  const bar = prog.querySelector('.bar > div');
  const labelEl = prog.querySelector('.bar-label');
  try {
    const result = await opFn((done, total, item) => {
      bar.style.width = Math.round((done / Math.max(1, total)) * 100) + '%';
      labelEl.textContent = `${fmtNum(done)}/${fmtNum(total)}${item?.error ? ' · last error: ' + item.error : ''}`;
    }, ctrl.signal);
    if (afterFn) await afterFn(result.newPaths);
    if (!skipFinalToast) toast({ kind: result.failed ? 'warn' : 'ok', title: 'Operation finished', msg: `${fmtNum(result.done)} ok, ${fmtNum(result.failed)} failed${result.skipped ? `, ${fmtNum(result.skipped)} skipped` : ''}. Undo is available in Organize → Undo.` });
  } catch (e) {
    if (!e.aborted) toast({ kind: 'err', title: 'Operation failed', msg: String(e.message || e) });
  } finally {
    m.close();
  }
}

// ---------------------------------------------------------------- UI: storage & about
async function openStorage() {
  const est = await navigator.storage?.estimate?.() || {};
  const persisted = await navigator.storage?.persisted?.() || false;
  const thumbs = await db.thumbCount();
  const body = el('div');
  body.append(
    el('table', {},
      el('tr', {}, el('td', {}, 'App storage used'), el('td', { class: 'num', text: fmtBytes(est.usage || 0) })),
      el('tr', {}, el('td', {}, 'Quota'), el('td', { class: 'num', text: fmtBytes(est.quota || 0) })),
      el('tr', {}, el('td', {}, 'Persistent storage'), el('td', {}, persisted ? 'granted ✓ (data won\'t be evicted)' : 'best-effort')),
      el('tr', {}, el('td', {}, 'Cached thumbnails'), el('td', { class: 'num', text: fmtNum(thumbs) })),
      el('tr', {}, el('td', {}, 'Cross-origin isolated (WASM threads)'), el('td', {}, String(!!window.crossOriginIsolated))),
    ),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn small', text: 'Request persistent storage',
        onclick: async () => { const ok = await navigator.storage?.persist?.(); toast({ kind: ok ? 'ok' : 'warn', title: ok ? 'Persistent storage granted' : 'Not granted (browser policy)' }); openStorage(); m.close(); },
      }),
      el('button', {
        class: 'btn small', text: `Delete all thumbnails (frees space; regenerated on demand)`,
        onclick: async () => {
          if (!(await confirmDialog('Delete all cached thumbnails? They regenerate while browsing or tagging.', { danger: true, okLabel: 'Delete thumbs' }))) return;
          await db.clearThumbs();
          app.grid?.setThumbSize(app.grid.thumbSize); // force re-render
          toast({ kind: 'ok', title: 'Thumbnails cleared' });
          m.close();
        },
      }),
    ),
    el('p', { class: 'hint', text: 'Decode budget (E_TOO_LARGE threshold) can be raised in Thresholds & settings if your machine has RAM to spare. Huge images are the main cause of tab crashes — keep the budget sane.' }),
  );
  const m = modal({ title: 'Storage & maintenance', body, buttons: [{ label: 'Close' }] });
}

function openAbout() {
  const body = el('div');
  body.innerHTML = `
  <p><b>Tagmill</b> — a local-first bulk AI image tagger. Images never leave your machine; inference runs in-browser via ONNX Runtime Web (WebGPU with WASM fallback).</p>
  <h3>Model</h3>
  <p>Camie Tagger v2 by Camais03 — <a href="https://huggingface.co/Camais03/camie-tagger-v2" target="_blank" rel="noreferrer">huggingface.co/Camais03/camie-tagger-v2</a>, license <b>GPL-3.0</b>. 70,527 Danbooru tags across 7 categories; micro-F1 67.3% (micro profile), macro-F1 50.6% (macro profile). Quantized variants derived from the official ONNX export by <a href="https://huggingface.co/Smashinfries/camie-tagger-v2-onnx-mobile" target="_blank" rel="noreferrer">Smashinfries/camie-tagger-v2-onnx-mobile</a> (measured ≤≈1pp deviation, see repo).</p>
  <h3>Threshold profiles (official validation)</h3>
  <p>micro 0.614 · macro 0.492 · sigmoid-0.5 default in the official inference script.</p>
  <h3>Runtime</h3>
  <p><a href="https://github.com/microsoft/onnxruntime" target="_blank" rel="noreferrer">ONNX Runtime Web</a> (MIT). Preprocessing replicates the official pipeline: RGB, aspect-preserving resize, pad to 512² with RGB(124,116,104), ImageNet normalization; refined head + sigmoid.</p>
  <h3>Privacy</h3>
  <p>Model files are downloaded once from HuggingFace and cached in browser storage. Your images and tags stay local (IndexedDB + OPFS).</p>`;
  modal({ title: 'About & licenses', body, wide: true, buttons: [{ label: 'Close' }] });
}

// ---------------------------------------------------------------- input pickers
function pickViaInput({ directory }) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    if (directory) inp.webkitdirectory = true;
    inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const files = [...inp.files];
      if (!files.length) return resolve(null);
      const rootName = directory ? (files[0].webkitRelativePath?.split('/')[0] || 'collection') : 'picked files';
      resolve({ files, rootName });
    });
    document.body.append(inp);
    inp.click();
  });
}

async function openViaInput(directory) {
  const picked = await pickViaInput({ directory });
  if (!picked) return;
  if (app.engine && (app.engine.state === 'running' || app.engine.state === 'pausing')) {
    toast({ kind: 'warn', title: 'Pause the job first' });
    return;
  }
  const cols = await db.getCollections();
  const existing = cols.find(c => c.kind === 'input' && c.name === picked.rootName);
  let id = existing ? existing.id : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  if (existing) {
    await db.deleteCollectionCascade(id);
  }
  const col = { id, name: picked.rootName, kind: 'input', createdAt: Date.now(), imageCount: 0 };
  await db.putCollection(col);
  await attachCollection(id, { kind: 'input' });
  const records = recordsFromFileList(picked.files, id, app.fileMap, picked.rootName);
  await ingestScan({ records, scanErrors: [], aborted: false });
  if (!app.rows.length) toast({ kind: 'warn', title: 'No images found', msg: 'The selection contained no decodable image types.' });
}

async function openViaFSA() {
  try {
    const handle = await pickDirectory('readwrite');
    await openFsDirectory(handle);
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast({ kind: 'err', title: 'Could not open folder', msg: String(e.message || e) });
  }
}

// ---------------------------------------------------------------- saved collections list
async function renderSavedCollections() {
  const cols = await db.getCollections();
  const wrap = $('#saved-collections-list');
  wrap.innerHTML = '';
  $('#saved-collections').classList.toggle('hide', cols.length === 0);
  for (const c of cols.sort((a, b) => b.createdAt - a.createdAt)) {
    const open = el('div', { class: 'saved-col' });
    const name = el('span', { class: 'n', text: c.name + (app.collection?.id === c.id ? ' (open)' : '') });
    const cnt = el('span', { class: 'cnt', text: c.imageCount ? fmtNum(c.imageCount) : '' });
    const del = el('span', { class: 'del', title: 'Delete collection data (files on disk are untouched)', text: '✕' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const needsConfirm = c.kind !== 'input' && (c.imageCount || 0) > 1;
      if (needsConfirm) {
        if (!(await confirmDialog(`Delete Tagmill's stored metadata for "${c.name}"?\nImages on disk are NOT touched.`, { danger: true, okLabel: 'Delete' }))) return;
      }
      try {
        if (app.collection?.id === c.id) closeCollection();
        await db.deleteCollectionCascade(c.id);
        toast({ kind: 'ok', title: 'Collection deleted', msg: `Removed "${c.name}"` });
      } catch (err) {
        console.error('Cascade delete error, removing directly:', err);
        await db.deleteCollectionOnly(c.id).catch(() => {});
        toast({ kind: 'warn', title: 'Collection removed', msg: `Removed "${c.name}"` });
      } finally {
        await renderSavedCollections();
      }
    });
    open.addEventListener('click', async () => {
      const h = (await db.getHandle(c.id))?.handle;
      if (c.kind === 'fsa') {
        if (!h) { toast({ kind: 'err', title: 'Handle lost', msg: 'Re-open the folder manually.' }); return; }
        let perm = await permissionFor(h, 'read');
        if (perm !== 'granted') {
          perm = await requestPermission(h, 'read');
          if (perm !== 'granted') { toast({ kind: 'err', title: 'Permission denied' }); return; }
        }
        await attachCollection(c.id, { dirHandle: h, kind: 'fsa' });
        applyFilters();
        toast({ kind: 'ok', title: 'Collection restored', msg: 'Press Rescan to check for new/changed files.' });
      } else {
        toast({ kind: 'info', title: 'File-picker collection', msg: 'Re-pick the folder/files — results match automatically by path+size+date.' });
      }
    });
    open.append(name, cnt, del);
    wrap.append(open);
  }
}

// ---------------------------------------------------------------- boot & wiring
async function boot() {
  await loadSettings();
  app.registry = await loadRegistry();
  app.modelCache = new ModelCache();
  app.prep = new PrepHost();
  app.model = new ModelHost();
  buildCollectionView();

  // Eagerly prefetch/load tag vocabulary so tags display immediately even before model is loaded
  app.modelCache.ensureTags().then(v => {
    app.vocab = v;
    if (app.rows && app.rows.length) {
      for (const r of app.rows) updateRowMeta(r);
      if (app.grid) applyFilters();
    }
  }).catch(e => console.warn('Tags eager fetch deferred:', e));

  const cores = navigator.hardwareConcurrency || 4;
  $('#kv-threads').textContent = window.crossOriginIsolated ? `multithreaded (${cores} cores)` : 'single thread (no COOP/COEP)';

  // wire buttons
  $('#btn-open-folder').addEventListener('click', () => (supportsFSA ? openViaFSA() : pickViaInputFallback()));
  $('#btn-pick-files').addEventListener('click', () => openViaInput(false));
  $('#btn-rescan').addEventListener('click', () => rescan(true));
  $('#btn-close-col').addEventListener('click', async () => {
    if (app.engine && app.engine.counters.processing > 0) await confirmDialog('A job is mid-flight. Closing keeps all saved progress.', { okLabel: 'Close anyway' });
    closeCollection();
  });
  $('#btn-model-manager').addEventListener('click', openModelManager);
  $('#btn-unload-model').addEventListener('click', async () => {
    await app.model.dispose();
    app.settings.lastVariant = null;
    saveSettings();
    setModelStatus('idle', 'Model unloaded');
    $('#btn-unload-model').disabled = true;
    setEpStatus('—');
    setJobButtons();
    app.bus.emit('model-unloaded');
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-storage').addEventListener('click', openStorage);
  $('#btn-about').addEventListener('click', openAbout);
  $('#btn-export').addEventListener('click', openExport);
  $('#btn-organize').addEventListener('click', openOrganize);

  $('#btn-start').addEventListener('click', async () => {
    if (!app.collection) return;
    if (!app.model.ready) {
      setModelStatus('busy', 'Loading model…');
      const ok = await loadVariant(currentVariant());
      if (!ok) return;
    }
    // writewrite permission for potential later ops; read is what we need now
    if (app.collection.kind === 'fsa') {
      const perm = await permissionFor(app.dirHandle, 'read');
      if (perm !== 'granted') {
        const got = await requestPermission(app.dirHandle, 'read');
        if (got !== 'granted') { toast({ kind: 'err', title: 'Folder permission needed' }); return; }
      }
    }
    try { await app.engine.start(); }
    catch (e) { toast({ kind: 'err', title: 'Could not start', msg: String(e.message || e) }); }
  });
  $('#btn-pause').addEventListener('click', () => app.engine?.pause());
  $('#btn-retry-failed').addEventListener('click', async () => {
    const n = await app.engine?.retryFailed();
    if (n === 0) toast({ kind: 'info', title: 'No failed images' });
  });
  $('#btn-process-selected').addEventListener('click', async () => {
    if (!app.model.ready) { toast({ kind: 'warn', title: 'Load a model first' }); return; }
    await app.engine.start({ onlyRows: [...app.grid.selected], includeFailed: true });
  });
  $('#btn-tag-unprocessed').addEventListener('click', async () => {
    if (!app.model.ready) { toast({ kind: 'warn', title: 'Load a model first' }); return; }
    await app.engine.start({});
  });

  // search & filters
  $('#search').addEventListener('input', () => { applyFiltersDebounced(); showSuggest(); });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#search').value = ''; applyFilters(); hideSuggest(); }
    if (e.key === 'Tab' && suggestItems.length) {
      e.preventDefault();
      $('#search').value = suggestItems[suggestPos].tag + ' ';
      applyFiltersDebounced();
    }
  });
  $('#filter-status').addEventListener('change', applyFilters);
  $('#sort-by').addEventListener('change', applyFilters);
  $('#thumb-size').addEventListener('input', (e) => app.grid?.setThumbSize(parseInt(e.target.value)));
  $('#btn-select-all-matching').addEventListener('click', () => app.grid?.selectAll());
  $('#btn-clear-selection').addEventListener('click', () => app.grid?.clearSelection());
  $('#btn-remove-selected')?.addEventListener('click', async () => {
    const sel = [...app.grid.selected];
    if (!sel.length) return;
    const ids = sel.map(rn => app.rows[rn]?.id).filter(Boolean);
    if (!ids.length) return;
    app.grid.clearSelection();
    await app.removeRows(ids);
  });
  $('#btn-clear-all-cols')?.addEventListener('click', async () => {
    const cols = await db.getCollections();
    if (!cols.length) return;
    if (!(await confirmDialog(`Delete all ${cols.length} saved collections?\nImages on disk are NOT touched.`, { danger: true, okLabel: 'Clear all' }))) return;
    try {
      closeCollection();
      await db.clearAllCollections();
      toast({ kind: 'ok', title: 'All collections cleared' });
    } catch (err) {
      console.error('Clear all error, falling back to direct removal:', err);
      for (const c of cols) {
        await db.deleteCollectionOnly(c.id).catch(() => {});
      }
      toast({ kind: 'warn', title: 'Collections cleared' });
    } finally {
      await renderSavedCollections();
    }
  });

  // job options
  const bindOpt = (id, key, transform = (v) => v) => {
    const elx = $(id);
    elx.checked = app.settings[key];
    elx.addEventListener('change', () => {
      app.settings[key] = transform(elx.checked);
      app.engine?.setSettings({
        thresholds: app.settings.thresholds, catEnabled: app.settings.catEnabled,
        skipDone: app.settings.skipDone, reuseDup: app.settings.reuseDup,
        genThumbs: app.settings.genThumbs, batchSize: app.settings.batchSize,
        thumbSize: app.settings.thumbSize, maxMP: app.settings.maxMP,
      });
      saveSettings();
    });
  };
  bindOpt('#opt-skip-done', 'skipDone');
  bindOpt('#opt-reuse-dup', 'reuseDup');
  bindOpt('#opt-gen-thumbs', 'genThumbs');
  const batchInput = $('#opt-batch');
  batchInput.value = app.settings.batchSize;
  batchInput.addEventListener('change', () => {
    app.settings.batchSize = Math.max(1, Math.min(8, parseInt(batchInput.value) || 1));
    app.engine?.setSettings({ ...app.settings });
    saveSettings();
    if (app.model.ready) toast({ kind: 'info', title: 'Batch size applies to the next model load', timeout: 4000 });
  });

  // warn before closing while running
  window.addEventListener('beforeunload', (e) => {
    if (app.engine && (app.engine.state === 'running' || app.engine.state === 'pausing')) {
      app.engine.pause();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // global error surfacing
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled rejection', e.reason);
  });
  window.addEventListener('error', (e) => {
    if (e.message && /ResizeObserver loop/.test(e.message)) return;
    $('#crash-banner').classList.remove('hide');
    $('#crash-msg').textContent = String(e.message).slice(0, 200);
  });

  updateStorageQuota();
  setInterval(updateStorageQuota, 30000);
  await renderSavedCollections();
  autoLoadCachedModel();
}

let suggestItems = [], suggestPos = 0;
function showSuggest() {
  const box = $('#tag-suggest');
  const q = $('#search').value;
  const lastTerm = q.split(/\s+/).pop()?.toLowerCase();
  if (!lastTerm || lastTerm.startsWith('-') || lastTerm.startsWith('cat:')) { hideSuggest(); return; }

  let cleanTerm = lastTerm;
  let prefixPrefix = '';
  if (lastTerm.startsWith('char:') || lastTerm.startsWith('character:')) {
    prefixPrefix = lastTerm.startsWith('char:') ? 'char:' : 'character:';
    cleanTerm = lastTerm.slice(prefixPrefix.length);
  } else if (lastTerm.startsWith('series:') || lastTerm.startsWith('copyright:')) {
    prefixPrefix = lastTerm.startsWith('series:') ? 'series:' : 'copyright:';
    cleanTerm = lastTerm.slice(prefixPrefix.length);
  } else if (lastTerm.startsWith('artist:')) {
    prefixPrefix = 'artist:';
    cleanTerm = lastTerm.slice(7);
  } else if (lastTerm.startsWith('general:')) {
    prefixPrefix = 'general:';
    cleanTerm = lastTerm.slice(8);
  }

  if (!cleanTerm || cleanTerm.length < 2) { hideSuggest(); return; }
  suggestItems = app.tagIndex.suggest(cleanTerm, 10, app.vocab);
  suggestPos = 0;
  if (!suggestItems.length) { hideSuggest(); return; }
  box.innerHTML = '';
  suggestItems.forEach((s, i) => {
    const d = el('div', { class: 'sug' + (i === 0 ? ' active' : '') });
    if (s.catName) {
      d.append(el('span', { class: `sug-badge cat-${s.catName}`, text: s.catName }));
    }
    d.append(el('span', { text: s.tag }), el('span', { class: 'cnt', text: fmtNum(s.count) }));
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const terms = $('#search').value.split(/\s+/);
      terms[terms.length - 1] = prefixPrefix + s.tag;
      $('#search').value = terms.join(' ') + ' ';
      applyFilters();
      hideSuggest();
      $('#search').focus();
    });
    box.append(d);
  });
  box.classList.remove('hide');
}
function hideSuggest() { $('#tag-suggest').classList.add('hide'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#toolbar')) hideSuggest(); });

async function updateStorageQuota() {
  try {
    const est = await navigator.storage.estimate();
    $('#kv-quota').textContent = `${fmtBytes(est.usage || 0)} / ${fmtBytes(est.quota || 0)}`;
  } catch { $('#kv-quota').textContent = '—'; }
}

function pickViaInputFallback() {
  modal({
    title: 'Pick a folder',
    body: `<p>This browser doesn't support the File System Access API (Chrome/Edge give the best experience: resumable permissions, in-place rename/move).</p><p>You can still select a folder — images are processed locally all the same:</p>`,
    buttons: [
      { label: 'Choose folder…', kind: 'primary', onClick: () => openViaInput(true) },
      { label: 'Cancel' },
    ],
  });
}

// ---------------------------------------------------------------- test hooks (also useful for support/debugging)
window.__tm = {
  app, db, engine: () => app.engine, grid: () => app.grid, index: () => app.tagIndex,
  rows: () => app.rows,
  applyFilters,
  async debugState() {
    return {
      collection: app.collection?.record?.name || null,
      rows: app.rows.length,
      counters: app.engine?.counters || null,
      model: app.model?.info ? { ep: app.model.info.ep, variant: app.model.info.variantId, threads: app.model.info.threads } : null,
      engineState: app.engine?.state || null,
      filtered: app.filtered.length,
      isolated: !!window.crossOriginIsolated,
      memory: performance.memory ? { usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), jsHeapSizeLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null,
    };
  },
  async openOpcsCollection(dirHandle, name) {
    // full FSA code path via an OPFS directory handle
    const cols = await db.getCollections();
    const existing = cols.find(c => c.name === name && c.kind === 'fsa');
    if (existing) {
      await attachCollection(existing.id, { dirHandle, kind: 'fsa' });
      await rescan(false);
      return existing.id;
    }
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await db.putCollection({ id, name, kind: 'fsa', createdAt: Date.now(), imageCount: 0 });
    await db.putHandle(id, dirHandle, 'fsa');
    await attachCollection(id, { dirHandle, kind: 'fsa' });
    await rescan(false);
    return id;
  },
};

boot();
