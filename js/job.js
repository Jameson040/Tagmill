// Job engine: orchestrates prep → infer → persist for (potentially) tens of thousands of images.
// Guarantees: pause/resume, per-image failure isolation, EP fallback, duplicate-content reuse,
// crash-safe persistence (every result written immediately; job snapshot checkpointed).

import { emitter, sleep } from './util.js';
import * as db from './db.js';

export const ERROR_LABELS = {
  E_DECODE: 'Decoding failed (corrupt or unsupported pixel data)',
  E_UNSUPPORTED: 'Format not supported by the browser',
  E_TOO_LARGE: 'Image exceeds the decode pixel budget',
  E_READ: 'File could not be read (moved, deleted, or permission lost?)',
  E_INFER: 'Inference failed',
  E_INFER_OOM: 'Inference ran out of memory',
  E_INFER_DEVICE: 'GPU device lost during inference',
  E_CHANGED: 'File changed while it was being processed',
  E_TIMEOUT: 'Processing timed out',
  E_UNKNOWN: 'Unknown error',
};

export class JobEngine {
  constructor({ prep, model, source, settings, collectionId }) {
    this.bus = emitter();
    this.prep = prep;
    this.model = model;
    this.source = source;
    this.settings = settings;
    this.collectionId = collectionId;

    this.state = 'idle';          // idle | running | pausing | paused | stopping | error
    this.queue = [];
    this.queuePos = 0;
    this.rows = null;
    this.rowIndex = null;

    this.inflightPrep = new Map(); // rec.id -> rowNum
    this.readyTensors = [];
    this.inflightInfer = 0;
    this.doneTimes = [];
    this.counters = { done: 0, failed: 0, skipped: 0, pending: 0, processing: 0 };
    this.hashToDone = new Map();
    this.inflightHashes = new Map();
    this.restarts = 0;
    this.epFellBack = false;
    this.stopRequested = false;
    this._loopRunning = false;
    this._lastProgressPost = 0;
    this._checkpointTimer = null;
    this._initArgsProvider = null;
    this._modelVariantId = null;
  }

  attachRows(rows, rowIndex) {
    this.rows = rows;
    this.rowIndex = rowIndex;
    this._rebuildHashIndex();
  }

  _rebuildHashIndex() {
    this.hashToDone.clear();
    for (let rn = 0; rn < this.rows.length; rn++) {
      const r = this.rows[rn];
      if ((r.status === 'done' || r.status === 'skipped') && r.quickHash) this.hashToDone.set(r.quickHash, rn);
    }
  }

  setSettings(s) { this.settings = s; }
  setInitArgsProvider(fn) { this._initArgsProvider = fn; }
  setCounters(c) { this.counters = { ...this.counters, ...c }; }
  _rec(rn) { return this.rows[rn]; }

  // ---------- queue building ----------
  buildQueue({ onlyRows = null, includeFailed = false } = {}) {
    const q = [];
    const s = this.settings;
    const push = (rn) => {
      const r = this._rec(rn);
      if (!r || r.status === 'missing') return;
      if (!includeFailed) {
        if (r.status === 'done' && s.skipDone) return;
        if (r.status === 'skipped' && s.skipDone) return;
        if (r.status === 'failed') return;
      }
      q.push(rn);
    };
    if (onlyRows) for (const rn of onlyRows) push(rn);
    else for (let rn = 0; rn < this.rows.length; rn++) push(rn);
    return q;
  }

  // ---------- lifecycle ----------
  async start({ onlyRows = null, includeFailed = false } = {}) {
    if (this.state === 'running' || this.state === 'pausing') return;
    if (!this.model.ready) throw new Error('Model is not loaded');
    this.queue = this.buildQueue({ onlyRows, includeFailed });
    this.queuePos = 0;
    this.inflightHashes.clear();
    this.stopRequested = false;
    this.state = 'running';
    this._saveJobSnapshot('running');
    this._startCheckpoint();
    this.bus.emit('state', this.state);
    this._pump();
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'pausing';
    this.bus.emit('state', this.state);
  }

  stop() {
    this.stopRequested = true;
    if (this.state === 'running' || this.state === 'pausing') this.state = 'stopping';
    this.bus.emit('state', this.state);
  }

  async retryFailed() {
    const targets = [];
    for (let rn = 0; rn < this.rows.length; rn++) if (this._rec(rn).status === 'failed') targets.push(rn);
    if (!targets.length) return 0;
    for (const rn of targets) {
      const r = this._rec(rn);
      r.status = 'pending'; r.error = null; r.errorMsg = null;
      this.counters.failed = Math.max(0, this.counters.failed - 1);
      this.counters.pending++;
    }
    await db.putImages(targets.map(rn => this._persistable(this._rec(rn))));
    this.bus.emit('counters');
    if (this.state === 'idle' || this.state === 'paused' || this.state === 'error') {
      if (this.model.ready) await this.start({ onlyRows: targets });
    }
    return targets.length;
  }

  // ---------- main pump ----------
  async _pump() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    try {
      const maxPrep = Math.max(2, (this.settings.batchSize || 1) + 1);
      for (;;) {
        const draining = this.inflightPrep.size === 0 && this.readyTensors.length === 0 && this.inflightInfer === 0;
        if (this.state === 'pausing' && draining) {
          this.state = 'paused';
          this._saveJobSnapshot('paused');
          this.bus.emit('state', this.state);
          break;
        }
        if ((this.state === 'stopping' || this.stopRequested) && draining) {
          this.state = 'idle';
          this.stopRequested = false;
          this._saveJobSnapshot('idle');
          this.bus.emit('state', this.state);
          break;
        }
        // feed prep pipeline
        while (this.state === 'running' &&
               this.inflightPrep.size < maxPrep &&
               this.readyTensors.length + this.inflightPrep.size < maxPrep + (this.settings.batchSize || 1) &&
               this.queuePos < this.queue.length) {
          const rn = this.queue[this.queuePos++];
          this._dispatchPrep(rn);
        }
        // flush a batch
        const wantBatch = this.settings.batchSize || 1;
        if (this.readyTensors.length >= wantBatch ||
            (this.readyTensors.length > 0 && this.state !== 'running' && this.inflightPrep.size === 0)) {
          const batch = [];
          let scan = 0;
          while (scan < this.readyTensors.length && batch.length < wantBatch) {
            const item = this.readyTensors[scan];
            const h = item.quickHash;
            if (this.settings.reuseDup && h) {
              const donorRn = this.hashToDone.get(h);
              if (donorRn !== undefined && donorRn !== item.rowNum) {
                // donor already inferred → reuse tags now, drop the tensor (free memory)
                this.readyTensors.splice(scan, 1);
                this._applyDupReuse(item, donorRn);
                continue; // next item shifted into `scan`
              }
              if (this.inflightHashes.has(h)) { scan++; continue; } // identical content currently inferring → defer to a later batch
            }
            batch.push(this.readyTensors.splice(scan, 1)[0]);
            if (h) this.inflightHashes.set(h, item.rowNum);
          }
          if (batch.length) {
            this.inflightInfer++;
            // don't await inside the tick loop; keep pumping prep while GPU works
            this._dispatchInfer(batch).finally(() => { this.inflightInfer--; });
          }
        }
        if (this.queuePos >= this.queue.length && this.inflightPrep.size === 0 && this.inflightInfer === 0 && this.readyTensors.length === 0) {
          this.state = 'idle';
          this.stopRequested = false;
          this._saveJobSnapshot('idle');
          this.bus.emit('state', this.state);
          this.bus.emit('finished');
          break;
        }
        await sleep(10);
        this._maybePostProgress();
      }
    } catch (err) {
      console.error('job loop crashed', err);
      this.state = 'error';
      this.bus.emit('state', this.state);
      this.bus.emit('fatal', err);
    } finally {
      this._loopRunning = false;
      this._stopCheckpoint();
    }
  }

  // ---------- prep ----------
  _dispatchPrep(rn) {
    const rec = this._rec(rn);
    rec.status = 'processing';
    this.counters.processing++;
    this.counters.pending = Math.max(0, this.counters.pending - 1);
    this.inflightPrep.set(rec.id, rn);
    this.bus.emit('image-processing', { rowNum: rn });
    this.source.getFile(rec).then(file => {
      if (this.inflightPrep.get(rec.id) !== rn) return null; // superseded (e.g., stop)
      if (!file) throw Object.assign(new Error('File handle no longer available — rescan the collection'), { code: 'E_READ' });
      if (file.size !== rec.size) throw Object.assign(new Error(`File changed on disk (${rec.size} → ${file.size} bytes) — rescan to update`), { code: 'E_CHANGED' });
      return this.prep.prep({
        id: rec.id, file,
        maxMP: this.settings.maxMP,
        thumbSize: this.settings.genThumbs ? this.settings.thumbSize : 0,
      });
    }).then(m => { if (m) return this._onPrepOk(m); })
      .catch(err => this._onPrepError(rn, err.code || 'E_UNKNOWN', err.message));
  }

  _onPrepError(rn, code, message) {
    const rec = this._rec(rn);
    if (!rec || (rec.status !== 'processing' && rec.status !== 'pending')) return;
    rec.status = 'failed'; rec.error = code; rec.errorMsg = message;
    if (this.inflightPrep.delete(rec.id)) {
      this.counters.failed++;
      this.counters.processing = Math.max(0, this.counters.processing - 1);
    }
    db.putImages([this._persistable(rec)]).catch(() => {});
    this.bus.emit('image-failed', { rowNum: rn, code, message });
    this._maybePostProgress();
  }

  async _onPrepOk(m) {
    const rn = this.inflightPrep.get(m.id);
    this.inflightPrep.delete(m.id);
    const rec = this._rec(rn);
    if (!rec || (rec.status !== 'processing' && rec.status !== 'done' && rec.status !== 'skipped')) return;
    this.counters.processing = Math.max(0, this.counters.processing - 1);
    rec.width = m.width; rec.height = m.height;
    if (m.quickHash) rec.quickHash = m.quickHash;

    // duplicate-content reuse (fast path: donor finished while this prep ran)
    if (this.settings.reuseDup && m.quickHash) {
      const donorRn = this.hashToDone.get(m.quickHash);
      if (donorRn !== undefined && donorRn !== rn) {
        const reused = await this._applyDupReuse(
          { rowNum: rn, width: m.width, height: m.height, quickHash: m.quickHash }, donorRn);
        if (reused) return;
      }
    }

    this.readyTensors.push({
      rowNum: rn, tensorBuf: m.tensorBuf, thumb: m.thumb,
      width: m.width, height: m.height, quickHash: m.quickHash, mime: m.mime, decodeMs: m.decodeMs,
    });
    this._maybePostProgress();
  }

  // Copy donor tags onto an identical-content image; returns false if donor unusable.
  async _applyDupReuse(item, donorRn) {
    const rec = this._rec(item.rowNum);
    const donor = this._rec(donorRn);
    if (!rec || !donor || (donor.status !== 'done' && donor.status !== 'skipped') || !donor.tagIdx) return false;
    rec.tagIdx = donor.tagIdx.slice();
    rec.tagP = donor.tagP.slice();
    rec.tagStamp = Date.now();
    rec.modelVariant = donor.modelVariant;
    rec.dupOf = donor.path;
    if (item.width) rec.width = item.width;
    if (item.height) rec.height = item.height;
    if (item.quickHash) rec.quickHash = item.quickHash;
    rec.status = 'skipped';
    this.counters.skipped++;
    this.hashToDone.set(item.quickHash, item.rowNum);
    try { await db.putImages([this._persistable(rec)]); } catch { /* */ }
    this.bus.emit('image-done', { rowNum: item.rowNum, rec, summary: null, dupOf: donor.path });
    this._maybePostProgress();
    return true;
  }

  // ---------- infer ----------
  async _dispatchInfer(batch) {
    if (!batch.length) return;
    try {
      const tensors = batch.map(b => new Float32Array(b.tensorBuf));
      const res = await this.model.infer({
        tensors,
        ids: batch.map(b => this._rec(b.rowNum).id),
      });
      const byId = new Map(res.results.map(r => [r.id, r]));
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i];
        const rec = this._rec(b.rowNum);
        const r = byId.get(rec.id);
        if (!r) { this._markFailed(b.rowNum, 'E_INFER', 'missing result for batch item'); continue; }
        rec.tagIdx = r.tags.idx;
        rec.tagP = r.tags.p16;
        rec.tagStamp = Date.now();
        rec.modelVariant = this._modelVariantId;
        rec.width = b.width; rec.height = b.height;
        if (b.quickHash) rec.quickHash = b.quickHash;
        rec.dupOf = null;
        rec.status = 'done';
        this.counters.done++;
        this.doneTimes.push(performance.now());
        if (this.doneTimes.length > 50) this.doneTimes.shift();
        if (b.quickHash) this.hashToDone.set(b.quickHash, b.rowNum);
        try { await db.putImages([this._persistable(rec)]); }
        catch (e) { console.error('persist failed for', rec.path, e); }
        if (b.thumb && this.settings.genThumbs) {
          db.putThumb(rec.id, b.thumb).catch(() => {});
          this.bus.emit('thumb-ready', { rowNum: b.rowNum, blob: b.thumb });
        }
        this.bus.emit('image-done', { rowNum: b.rowNum, rec, summary: r.summary });
      }
    } catch (err) {
      const fatal = err.fatal || err.code === 'E_INFER_OOM' || err.code === 'E_INFER_DEVICE' ||
                    err.code === 'E_TIMEOUT' || /crash|worker|aborted/i.test(String(err.message || ''));
      for (const b of batch) {
        if (fatal) {
          const rec = this._rec(b.rowNum);
          if (rec.status === 'processing') rec.status = 'pending';
        } else {
          this._markFailed(b.rowNum, err.code || 'E_INFER', err.message);
        }
      }
      if (fatal) await this._handleFatalInfer(err);
    } finally {
      for (const b of batch) {
        if (b.quickHash) this.inflightHashes.delete(b.quickHash);
        b.tensorBuf = null; b.thumb = null;
      }
      this._maybePostProgress();
    }
  }

  _markFailed(rn, code, message) {
    const rec = this._rec(rn);
    if (!rec || rec.status === 'done') return;
    rec.status = 'failed'; rec.error = code; rec.errorMsg = String(message || '').slice(0, 300);
    this.counters.failed++;
    db.putImages([this._persistable(rec)]).catch(() => {});
    this.bus.emit('image-failed', { rowNum: rn, code, message });
  }

  async _handleFatalInfer(err) {
    this.restarts++;
    this.bus.emit('model-trouble', { restarts: this.restarts, error: err.message, code: err.code });
    if (this.restarts <= 2) {
      await sleep(800 * this.restarts);
      try {
        const args = await this._initArgsProvider();
        await this.model.init(args);
        this.bus.emit('model-restarted', { restarts: this.restarts });
        return;
      } catch (e) {
        this.bus.emit('model-trouble', { restarts: this.restarts, error: 'restart failed: ' + e.message });
      }
    }
    if (this.restarts === 3) {
      const alt = this.model.info?.ep === 'webgpu' ? 'wasm' : null;
      if (alt) {
        this.epFellBack = true;
        this.bus.emit('ep-fallback', { from: this.model.info?.ep, to: alt });
        try {
          const args = await this._initArgsProvider();
          await this.model.init({ ...args, wantEP: alt });
          return;
        } catch (e) {
          this.bus.emit('model-trouble', { error: 'fallback to WASM also failed: ' + e.message });
        }
      }
    }
    this.state = 'error';
    this._saveJobSnapshot('error');
    this.bus.emit('state', this.state);
    this.bus.emit('fatal', new Error(`Inference pipeline failed repeatedly: ${err.message}`));
  }

  _persistable(rec) {
    return {
      id: rec.id, collectionId: rec.collectionId, path: rec.path, name: rec.name, ext: rec.ext,
      size: rec.size, mtime: rec.mtime, status: rec.status, error: rec.error, errorMsg: rec.errorMsg,
      quickHash: rec.quickHash, dupOf: rec.dupOf,
      tagIdx: rec.tagIdx, tagP: rec.tagP, tagStamp: rec.tagStamp, modelVariant: rec.modelVariant,
      manualAdd: rec.manualAdd, manualRemove: rec.manualRemove,
      width: rec.width, height: rec.height, addedAt: rec.addedAt,
    };
  }

  // ---------- worker wiring ----------
  wire() {
    this.prep.bus.on('crash', () => {
      // in-flight prep jobs died with the worker; reset their records to pending
      for (const [id, rn] of [...this.inflightPrep]) {
        this.inflightPrep.delete(id);
        const rec = this._rec(rn);
        if (rec && rec.status === 'processing') { rec.status = 'pending'; this.counters.processing = Math.max(0, this.counters.processing - 1); this.counters.pending++; }
      }
      // drop any tensors that referenced dead state (they're still valid buffers, keep them)
      this.bus.emit('prep-crash');
    });
    this.model.bus.on('crash', ({ reason }) => {
      this.inflightInfer = 0;
      this.bus.emit('model-crash', { reason });
      if (this.state === 'running' || this.state === 'pausing') {
        this._handleFatalInfer(new Error(`model worker crashed: ${reason}`));
      }
    });
    this.model.bus.on('device-lost', (m) => {
      this.bus.emit('device-lost', m);
      if (this.state === 'running' || this.state === 'pausing') this._handleFatalInfer(new Error('WebGPU device lost'));
    });
  }

  // ---------- progress ----------
  _rate() {
    if (this.doneTimes.length < 2) return 0;
    const span = (this.doneTimes[this.doneTimes.length - 1] - this.doneTimes[0]) / 1000;
    if (span <= 0) return 0;
    return (this.doneTimes.length - 1) / span;
  }

  _maybePostProgress(force = false) {
    const now = performance.now();
    if (!force && now - this._lastProgressPost < 250) return;
    this._lastProgressPost = now;
    const rate = this._rate();
    const queuedLeft = this.queue.length - this.queuePos;
    const remaining = this.counters.pending + this.counters.processing + queuedLeft;
    const eta = rate > 0 ? remaining / rate : Infinity;
    this.bus.emit('progress', {
      counters: { ...this.counters },
      rate, eta, remaining, queuedLeft,
      state: this.state,
    });
  }

  _startCheckpoint() {
    this._stopCheckpoint();
    this._checkpointTimer = setInterval(() => this._saveJobSnapshot(this.state), 3000);
  }
  _stopCheckpoint() {
    if (this._checkpointTimer) { clearInterval(this._checkpointTimer); this._checkpointTimer = null; }
  }

  _saveJobSnapshot(state) {
    const job = {
      collectionId: this.collectionId,
      state,
      modelVariant: this._modelVariantId,
      ep: this.model?.info?.ep || null,
      counters: { ...this.counters },
      updatedAt: Date.now(),
      queuedTotal: this.queue.length,
      queuePos: this.queuePos,
      settings: {
        thresholds: this.settings.thresholds,
        catEnabled: this.settings.catEnabled,
        skipDone: this.settings.skipDone,
        reuseDup: this.settings.reuseDup,
      },
    };
    db.putJob(job).catch(() => {});
    this.bus.emit('job-snapshot', job);
  }
}
