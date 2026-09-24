// Model worker: owns the ONNX Runtime session. Handles provider selection/fallback,
// device loss, batching, sigmoid + threshold postprocessing into compact typed arrays.

import { InferenceSession, Tensor, env } from '../vendor/ort.all.min.mjs';

env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
env.logLevel = 'error';

const SIZE = 512;

const state = {
  session: null,
  ep: null,
  variant: null,
  vocab: null,          // {size, names, catOf, index}
  thresholds: null,     // Float32Array per tag idx
  catEnabled: null,     // Uint8Array per tag idx
  batchSize: 1,
  sessionStart: 0,
  inferCount: 0,
};

let currentReqId = null; // reqId of the request being processed (responses must echo it)
function post(m, transfer) { postMessage(currentReqId != null ? { reqId: currentReqId, ...m } : m, transfer || []); }

// ---------------- EP detection ----------------
let cachedAdapter = null; // {ok, why, infoText, f16}
async function tryWebGPU(force = false) {
  if (cachedAdapter && !force) return cachedAdapter;
  if (!navigator.gpu) { cachedAdapter = { ok: false, why: 'WebGPU not exposed (browser lacks support or needs enabling)' }; return cachedAdapter; }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { cachedAdapter = { ok: false, why: 'No WebGPU adapter available (no GPU / blocklisted driver / software rendering disabled)' }; return cachedAdapter; }
    let infoText = 'WebGPU';
    try {
      const info = adapter.info || await adapter.requestAdapterInfo?.();
      if (info) infoText = `WebGPU · ${[info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'gpu'}`;
    } catch { /* adapter info optional */ }
    const f16 = adapter.features?.has?.('shader-f16');
    adapter.lost?.then(info => { cachedAdapter = null; post({ type: 'device-lost', reason: info?.reason || 'unknown', fatal: info?.reason !== 'destroyed' }); });
    cachedAdapter = { ok: true, adapter, f16, infoText };
    return cachedAdapter;
  } catch (e) {
    cachedAdapter = { ok: false, why: `WebGPU adapter probe failed: ${e.message}` };
    return cachedAdapter;
  }
}

function threadCount(want) {
  const cores = navigator.hardwareConcurrency || 4;
  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
  if (!isolated) return { threads: 1, isolated: false };
  const target = (want && want > 0) ? want : Math.max(1, Math.min(8, cores));
  return { threads: Math.max(1, Math.min(target, cores)), isolated: true };
}

// ---------------- session lifecycle ----------------
async function init(msg) {
  const { modelBlob, variant, wantEP, threads: wantThreads, batchSize } = msg;
  dispose();

  const fallbackList = (variant.eps && variant.eps.length) ? variant.eps : ['wasm'];
  const wanted = wantEP
    ? [wantEP, ...fallbackList.filter(e => e !== wantEP)]
    : fallbackList.slice();
  let lastError = null;
  let epTried = [];

  for (const ep of wanted) {
    try {
      const t0 = performance.now();
      let opts;
      let webgpuProbe = null;
      if (ep === 'webgpu') {
        webgpuProbe = await tryWebGPU();
        if (!webgpuProbe.ok) { epTried.push({ ep, why: webgpuProbe.why }); continue; }
        if (variant.id.includes('fp16') && !webgpuProbe.f16) {
          epTried.push({ ep, why: 'GPU lacks the shader-f16 feature required for FP16 weights' });
          continue;
        }
        const { threads } = threadCount(wantThreads);
        env.wasm.numThreads = threads;
        opts = {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        };
      } else {
        const { threads, isolated } = threadCount(wantThreads);
        env.wasm.numThreads = threads;
        opts = {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        };
        if (!isolated) post({ type: 'init-note', note: 'WASM multithreading unavailable (page not cross-origin isolated) — running single-threaded. Serve with COOP/COEP headers for ~2-4× throughput.' });
      }
      const session = await InferenceSession.create(modelBlob, opts);
      state.session = session;
      state.ep = ep;
      state.variant = variant;
      state.batchSize = Math.max(1, batchSize || (ep === 'webgpu' ? 4 : 1));
      state.inferCount = 0;
      state.sessionStart = performance.now();
      const io = {
        inputs: session.inputNames,
        outputs: session.outputNames,
      };
      post({
        type: 'init-ok',
        ep,
        threads: env.wasm.numThreads,
        infoText: ep === 'webgpu' ? (webgpuProbe?.infoText || 'WebGPU') : (env.wasm.numThreads > 1 ? `WASM · ${env.wasm.numThreads} threads` : 'WASM · single thread'),
        loadMs: Math.round(performance.now() - t0),
        batchSize: state.batchSize,
        ...io,
        triedFallbacks: epTried,
      });
      return;
    } catch (e) {
      lastError = e;
      epTried.push({ ep, why: String(e.message || e).slice(0, 300) });
      dispose();
    }
  }
  post({
    type: 'init-error',
    error: lastError ? String(lastError.message || lastError) : 'no execution provider available',
    tried: epTried,
  });
}

function dispose() {
  try { state.session?.release?.(); } catch { /* already gone */ }
  state.session = null;
  state.ep = null;
}

// ---------------- thresholds ----------------
function configure(msg) {
  state.vocab = msg.vocab;
  const { size, catOf } = msg.vocab;
  const catIdToName = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta', 6: 'year', 9: 'rating' };
  const thresholds = new Float32Array(size).fill(0.614);
  const enabled = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const catName = catIdToName[catOf[i]] || 'general';
    const th = msg.thresholds[catName];
    if (typeof th === 'number') thresholds[i] = th;
    enabled[i] = msg.catEnabled[catName] ? 1 : 0;
  }
  state.thresholds = thresholds;
  state.catEnabled = enabled;
  post({ type: 'config-ok' });
}

const MIN_STORE_PROB = 0.05;
const STORE_CAP = 1024;
const IDENTITY_CATS = new Set([4, 3, 1, 9, 6]); // character, copyright, artist, rating, year

function postprocess(probs) {
  const { vocab } = state;
  const n = vocab.size;
  const identityTags = []; // [prob, idx]
  const otherTags = [];    // [prob, idx]

  for (let i = 0; i < n; i++) {
    const p = probs[i];
    if (p < MIN_STORE_PROB) continue;
    const cat = vocab.catOf[i];
    if (IDENTITY_CATS.has(cat)) {
      identityTags.push([p, i]);
    } else {
      otherTags.push([p, i]);
    }
  }

  // Sort each group by confidence descending
  identityTags.sort((a, b) => b[0] - a[0]);
  otherTags.sort((a, b) => b[0] - a[0]);

  // Combine: preserve all identity tags (characters, series, artists, rating, year) + general/meta up to STORE_CAP
  const remainingCap = Math.max(128, STORE_CAP - identityTags.length);
  const selected = identityTags.concat(otherTags.slice(0, remainingCap));

  // Sort the final stored list by confidence descending
  selected.sort((a, b) => b[0] - a[0]);

  const idx = new Uint32Array(selected.length);
  const p16 = new Uint16Array(selected.length);
  for (let k = 0; k < selected.length; k++) {
    idx[k] = selected[k][1];
    p16[k] = Math.max(0, Math.min(65535, Math.round(selected[k][0] * 65535)));
  }
  return { idx, p16 };
}

const sigmoid = (x) => (x > 16 ? 1.0 : x < -16 ? 0.0 : 1 / (1 + Math.exp(-x)));

async function infer(msg) {
  if (!state.session) { post({ type: 'infer-error', reqId: msg.reqId, error: 'session not initialized' }); return; }
  const tensors = msg.tensors; // Array of Float32Array (each 3*512*512)
  const ids = msg.ids;
  const B = tensors.length;
  const input = B === 1 ? tensors[0] : concatBatch(tensors);
  const ortTensor = new Tensor('float32', input, [B, 3, SIZE, SIZE]);
  const t0 = performance.now();
  let results;
  try {
    results = await state.session.run({ [state.session.inputNames[0]]: ortTensor });
  } catch (e) {
    post({ type: 'infer-error', reqId: msg.reqId, ids, error: classifyInferError(e), fatal: isFatal(e) });
    return;
  }
  const inferMs = Math.round(performance.now() - t0);
  state.inferCount += B;

  const outName = state.session.outputNames.find(n => /refined/.test(n)) || state.session.outputNames[1] || state.session.outputNames[0];
  const refined = results[outName];
  const logits = refined.data; // Float32Array B*70527 (downloaded automatically on webgpu)
  const vocabSize = state.vocab.size;
  const out = [];
  for (let b = 0; b < B; b++) {
    const off = b * vocabSize;
    // sigmoid in place on a copy
    const probs = new Float32Array(vocabSize);
    const src = logits.subarray(off, off + vocabSize);
    for (let i = 0; i < vocabSize; i++) probs[i] = sigmoid(src[i]);
    const tags = postprocess(probs);
    // top-6 summary for live UI
    const summary = [];
    for (let k = 0; k < Math.min(6, tags.idx.length); k++) {
      const i = tags.idx[k];
      summary.push([state.vocab.names[i], tags.p16[k] / 65535]);
    }
    out.push({ id: ids[b], tags, summary });
  }
  const transfers = out.flatMap(r => [r.tags.idx.buffer, r.tags.p16.buffer]);
  post({ type: 'infer-ok', reqId: msg.reqId, results: out, inferMs, batch: B }, transfers);
}

function concatBatch(tensors) {
  const per = tensors[0].length;
  const out = new Float32Array(per * tensors.length);
  for (let b = 0; b < tensors.length; b++) out.set(tensors[b], b * per);
  return out;
}

function classifyInferError(e) {
  const s = String(e.message || e);
  if (/out of memory|OOM|allocation/i.test(s)) return 'E_INFER_OOM';
  if (/webgpu|device|lost/i.test(s)) return 'E_INFER_DEVICE';
  return 'E_INFER';
}
function isFatal(e) {
  return /out of memory|OOM|device lost|webgpu/i.test(String(e.message || e));
}

// ---------------- messages ----------------
self.onmessage = async (e) => {
  const m = e.data;
  currentReqId = m.reqId ?? null;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'configure') configure(m);
    else if (m.type === 'infer') await infer(m);
    else if (m.type === 'dispose') { dispose(); post({ type: 'dispose-ok' }); }
    else if (m.type === 'ping') post({ type: 'pong', ep: state.ep, inferCount: state.inferCount });
  } catch (err) {
    post({ type: 'worker-fatal', error: String(err.stack || err) });
  } finally {
    currentReqId = null;
  }
};
