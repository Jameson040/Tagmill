// Model cache orchestrator (main thread) — talks to dl.worker for OPFS-backed downloads.
import { emitter } from './util.js';

export class ModelCache {
  constructor() {
    this.bus = emitter();
    this.worker = new Worker(new URL('./dl.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.reqSeq = 0;
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'download worker crashed');
      for (const p of this.pending.values()) p.reject?.(err);
      this.pending.clear();
      this.bus.emit('worker-crash', err);
    };
    this.opfsOk = null;
    this.testOpfs();
  }

  _onMessage(m) {
    switch (m.type) {
      case 'download-progress': this.bus.emit('progress', m); break;
      case 'download-done': this.pending.get(m.id)?.resolve({ received: m.received }); this.pending.delete(m.id); this.bus.emit('done', m); break;
      case 'download-aborted': this.pending.get(m.id)?.reject(Object.assign(new Error('aborted'), { aborted: true, received: m.received })); this.pending.delete(m.id); break;
      case 'download-error': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        this.bus.emit('error', m);
        p?.reject(Object.assign(new Error(m.error), { fatal: m.fatal }));
        break;
      }
      case 'stat-result': this.pending.get(m.req)?.resolve(m.out); this.pending.delete(m.req); break;
      case 'delete-result': this.pending.get(m.req)?.resolve(m.ok); this.pending.delete(m.req); break;
      case 'test-opfs-result': this.opfsOk = m.ok; this.bus.emit('opfs-test', m); break;
      case 'worker-error': console.error('dl worker:', m.error, m.stack); break;
    }
  }

  _send(msg) { this.worker.postMessage(msg); }

  testOpfs() {
    return new Promise(res => {
      const onRes = (m) => { this.bus.off('opfs-test', onRes); res(m.ok); };
      this.bus.on('opfs-test', onRes);
      this._send({ type: 'test-opfs' });
      setTimeout(() => res(this.opfsOk === true), 4000);
    });
  }

  download(variant, tagsMetaToo = false) {
    return new Promise((resolve, reject) => {
      const id = 'dl-' + Math.random().toString(36).slice(2);
      this.pending.set(id, { resolve, reject });
      this._send({
        type: 'download', id,
        url: variant.url,
        opfsPath: 'model-' + variant.id + '.onnx',
        size: variant.size,
        sha256: variant.sha256,
      });
    });
  }
  abortDownload() { this._send({ type: 'abort-download' }); }

  stat(paths) {
    return new Promise((resolve, reject) => {
      const req = 'r' + (++this.reqSeq);
      this.pending.set(req, { resolve, reject });
      this._send({ type: 'stat', paths, req });
      setTimeout(() => { if (this.pending.has(req)) { this.pending.delete(req); resolve(Object.fromEntries(paths.map(p => [p, { exists: false, size: 0 }]))); } }, 8000);
    });
  }

  async modelFile(variantId) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(`model-${variantId}.onnx`);
    const file = await fh.getFile();
    return file;
  }

  async deleteModel(variantId) {
    await new Promise(resolve => {
      const req = 'r' + (++this.reqSeq);
      this.pending.set(req, { resolve, reject: resolve });
      this._send({ type: 'delete', path: `model-${variantId}.onnx`, req });
      setTimeout(resolve, 5000);
    });
    await new Promise(resolve => {
      const req = 'r' + (++this.reqSeq);
      this.pending.set(req, { resolve, reject: resolve });
      this._send({ type: 'delete', path: `model-${variantId}.onnx.meta`, req });
      setTimeout(resolve, 5000);
    });
  }

  /** Fetch + validate the tags vocabulary. Returns parsed vocab. order: memory -> IDB -> network */
  async ensureTags() {
    if (this.vocab) return this.vocab;
    const { kvGet, kvSet } = await import('./db.js');
    const { parseTagVocab, getTagsMeta } = await import('./model-registry.js');
    try {
      const raw = await kvGet('tagsjson');
      if (raw) {
        const v = parseTagVocab(JSON.parse(raw));
        if (v.size >= 70000) { this.vocab = v; return v; }
      }
    } catch (e) { console.warn('cached tags unusable:', e); }
    const meta = getTagsMeta();
    const res = await fetch(meta.url);
    if (!res.ok) throw new Error(`Failed to download tag vocabulary (HTTP ${res.status})`);
    const text = await res.text();
    const v = parseTagVocab(JSON.parse(text));
    kvSet('tagsjson', text).catch(() => {});
    this.vocab = v;
    return v;
  }

  async ensureTagsFromLocal(rawJsonText) {
    const { parseTagVocab } = await import('./model-registry.js');
    const v = parseTagVocab(JSON.parse(rawJsonText));
    if (v.size < 1000) throw new Error(`Vocabulary too small (${v.size} tags) — is this the right file?`);
    const { kvSet } = await import('./db.js');
    kvSet('tagsjson', rawJsonText).catch(() => {});
    this.vocab = v;
    return v;
  }
}
