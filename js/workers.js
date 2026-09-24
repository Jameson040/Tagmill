// Worker wrappers with crash-recovery: prep (decode/preprocess) + model (ORT inference).

import { emitter } from './util.js';

class WorkerHost {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.bus = emitter();
    this.seq = 0;
    this.pending = new Map(); // reqId -> {resolve, reject, msg, retries}
    this.crashes = 0;
    this.alive = false;
    this._spawn();
  }

  _spawn() {
    this.alive = true;
    this.worker = new Worker(this.url, { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => this._onCrash(e.message || 'worker error');
  }

  _onCrash(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.crashes++;
    try { this.worker.terminate(); } catch { /* */ }
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.bus.emit('crash', { reason, crashes: this.crashes, pending });
    // auto-respawn; caller re-dispatches
    setTimeout(() => { this._spawn(); this.bus.emit('respawn'); }, 50);
  }

  _onMessage(m) {
    const reqId = m.reqId;
    if (reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId);
      if (m.type.endsWith('-ok')) { this.pending.delete(reqId); p.resolve(m); }
      else if (m.type.endsWith('-err') || m.type.endsWith('-error')) {
        this.pending.delete(reqId);
        p.reject(Object.assign(new Error(m.message || m.error || 'worker error'), m));
      }
    }
    this.bus.emit('message', m);
  }

  request(msg, { timeoutMs = 0, onEigen = null } = {}) {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, msg, retries: 0 };
      this.pending.set(reqId, entry);
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          if (this.pending.has(reqId)) {
            this.pending.delete(reqId);
            reject(Object.assign(new Error(`${this.name} request timed out`), { code: 'E_TIMEOUT' }));
          }
        }, timeoutMs);
      }
      try { this.worker.postMessage({ ...msg, reqId }); }
      catch (e) { this.pending.delete(reqId); reject(e); }
    });
  }

  redispatch(pendingEntries) {
    for (const { msg, reqId } of pendingEntries) {
      if (!msg) continue;
      try { this.worker.postMessage({ ...msg, reqId }); } catch (e) { console.error('redispatch failed', e); }
    }
  }

  post(msg, transfer) { this.worker.postMessage(msg, transfer || []); }
  terminate() { this.alive = false; try { this.worker.terminate(); } catch { /* */ } }
}

export class PrepHost extends WorkerHost {
  constructor() {
    super(new URL('./prep.worker.js', import.meta.url), 'prep');
    this.bus.on('crash', ({ pending }) => {
      // re-queue prep/thumb jobs that died with the worker (unless they already retried too often)
      const retry = [];
      for (const [, entry] of Object.entries(pending)) {
        const msg = entry?.msg;
        if (!msg) continue;
        entry.retries = (entry.retries || 0) + 1;
        if (entry.retries <= 2) retry.push(entry);
      }
      this.bus.emit('jobs-lost', retry);
    });
  }
  prep(job, timeoutMs = 120000) {
    return this.request({ type: 'prep', ...job }, { timeoutMs });
  }
  thumb(job, timeoutMs = 120000) {
    return this.request({ type: 'thumb', ...job }, { timeoutMs });
  }
}

export class ModelHost extends WorkerHost {
  constructor() {
    super(new URL('./model.worker.js', import.meta.url), 'model');
    this.ready = false;
    this.info = null;
    this.inferCallCount = 0;
    this.inferImageCount = 0;
    this.bus.on('message', (m) => {
      if (m.type === 'init-ok') { this.ready = true; this.info = m; }
      if (m.type === 'init-error' || m.type === 'worker-fatal') { /* engine handles */ }
      if (m.type === 'device-lost') this.bus.emit('device-lost', m);
    });
    this.bus.on('crash', () => { this.ready = false; this.info = null; });
  }

  async init(opts) {
    this.ready = false;
    // ORT-Web accepts a URL string or typed buffer — not a File/Blob. Blob URLs stream efficiently
    // into the wasm heap with a single copy and work in workers.
    let objectUrl = null;
    if (typeof Blob !== 'undefined' && opts.modelBlob instanceof Blob) {
      objectUrl = URL.createObjectURL(opts.modelBlob);
      opts = { ...opts, modelBlob: objectUrl };
    }
    try {
      const res = await this.request({ type: 'init', ...opts }, { timeoutMs: 300000 });
      if (this.info) this.info.variantId = opts.variant?.id || null;
      return res;
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    }
  }
  configure(opts) { return this.request({ type: 'configure', ...opts }, { timeoutMs: 30000 }); }
  infer(opts) {
    this.inferCallCount++;
    this.inferImageCount += opts.tensors?.length || 0;
    return this.request({ type: 'infer', ...opts }, { timeoutMs: 600000 });
  }
  async dispose() {
    if (!this.alive) {
      this.ready = false;
      this.info = null;
      return;
    }
    try { await this.request({ type: 'dispose' }, { timeoutMs: 15000 }); } catch { /* */ }
    this.ready = false;
    this.info = null;
  }
}
