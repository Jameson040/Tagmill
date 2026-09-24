// Download worker: streams a large remote file into OPFS with HTTP Range resume + SHA-256 verify.
// Uses createSyncAccessHandle (worker-only API) for flat, memory-safe writes.

// ---- compact SHA-256 (streaming, chunk-friendly) ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const W = new Uint32Array(64);
function sha256Stream(chunks, totalLen, onTick) {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  let buffered = 0, processed = 0, tickAt = 0;
  const block = new Uint8Array(64);
  const dv = new DataView(block.buffer);
  const processBlock = () => {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ((W[i - 15] >>> 7) | (W[i - 15] << 25)) ^ ((W[i - 15] >>> 18) | (W[i - 15] << 14)) ^ (W[i - 15] >>> 3);
      const s1 = ((W[i - 2] >>> 17) | (W[i - 2] << 15)) ^ ((W[i - 2] >>> 19) | (W[i - 2] << 13)) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    processed += 64;
    if (onTick && processed >= tickAt) { tickAt = processed + (4 << 20); onTick(processed, totalLen); }
  };
  let carry = 0;
  const feed = (bytes) => {
    let off = 0;
    if (carry > 0) {
      const need = 64 - carry;
      const take = Math.min(need, bytes.length);
      block.set(bytes.subarray(0, take), carry);
      carry += take; off = take;
      if (carry === 64) { processBlock(); carry = 0; }
    }
    while (off + 64 <= bytes.length) {
      block.set(bytes.subarray(off, off + 64));
      processBlock();
      off += 64;
    }
    if (off < bytes.length) { block.set(bytes.subarray(off), 0); carry = bytes.length - off; }
  };
  for (const ch of chunks) feed(ch);
  // padding
  const bitLenHi = Math.floor(totalLen / 0x20000000);
  const bitLenLo = (totalLen << 3) >>> 0;
  const pad = new Uint8Array(((carry < 56 ? 56 - carry : 120 - carry) + 8));
  pad[0] = 0x80;
  const dvPad = new DataView(pad.buffer);
  dvPad.setUint32(pad.length - 8, bitLenHi);
  dvPad.setUint32(pad.length - 4, bitLenLo);
  feed(pad);
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

const enc = new TextEncoder();
let currentJob = null; // {id, abort}

async function opfsRoot() { return navigator.storage.getDirectory(); }

async function fileExists(path) {
  try { await (await opfsRoot()).getFileHandle(path); return true; } catch { return false; }
}

async function statFile(path) {
  try {
    const fh = await (await opfsRoot()).getFileHandle(path);
    const f = await fh.getFile();
    return { exists: true, size: f.size, mtime: f.lastModified };
  } catch { return { exists: false, size: 0 }; }
}

async function deleteFile(path) {
  try { await (await opfsRoot()).removeEntry(path); return true; } catch { return false; }
}

async function verifyHash(path, expected, onProgress) {
  const fh = await (await opfsRoot()).getFileHandle(path);
  const file = await fh.getFile();
  const CHUNK = 8 << 20;
  const parts = [];
  let off = 0;
  while (off < file.size) {
    const buf = await file.slice(off, Math.min(off + CHUNK, file.size)).arrayBuffer();
    parts.push(new Uint8Array(buf));
    off += buf.byteLength;
    onProgress?.(off, file.size);
  }
  return sha256Stream(parts, file.size);
}

async function doDownload(msg) {
  const { id, url, opfsPath, size, sha256 } = msg;
  currentJob = { id, abort: new AbortController() };
  const signal = currentJob.abort.signal;
  const post = (m) => postMessage(m);

  const metaPath = opfsPath + '.meta';
  const root = await opfsRoot();

  // read meta (received bytes so far)
  let received = 0;
  try {
    const mh = await root.getFileHandle(metaPath);
    const meta = JSON.parse(await (await mh.getFile()).text());
    if (meta.received > 0 && await fileExists(opfsPath)) received = meta.received;
  } catch { /* fresh */ }

  // probe server resume support
  let res;
  try {
    res = await fetch(url, {
      headers: received > 0 ? { Range: `bytes=${received}-` } : {},
      signal,
    });
  } catch (e) {
    post({ type: 'download-error', id, error: `Network error: ${e.message}`, fatal: false });
    return;
  }
  if (!res.ok && res.status !== 206) {
    post({ type: 'download-error', id, error: `HTTP ${res.status} from model host`, fatal: res.status >= 400 && res.status < 500 && res.status !== 416 });
    return;
  }
  if (received > 0 && res.status !== 206) {
    // server ignored Range — restart from scratch
    received = 0;
  }
  const contentLength = res.headers.get('content-length');
  const total = res.status === 206 ? received + (parseInt(contentLength, 10) || 0) : (parseInt(contentLength, 10) || size || 0);

  if (size && total && Math.abs(total - size) > 1024) {
    post({ type: 'download-error', id, error: `Host reports ${total} bytes, expected ${size} — file may have changed upstream`, fatal: true });
    return;
  }

  let fh;
  try { fh = await root.getFileHandle(opfsPath, { create: true }); }
  catch (e) { post({ type: 'download-error', id, error: `OPFS unavailable: ${e.message}`, fatal: true }); return; }
  const access = await fh.createSyncAccessHandle();
  const writeMeta = (n) => {
    try {
      // sync meta write via separate handle is awkward; use async fire-and-forget
      const p = (async () => {
        const mf = await root.getFileHandle(metaPath, { create: true });
        const w = await mf.createWritable();
        await w.write(JSON.stringify({ received: n, size: total }));
        await w.close();
      })();
      p.catch(() => {});
    } catch { /* non-fatal */ }
  };

  access.truncate(received);
  let writeAt = received; // FileSystemSyncAccessHandle has no seek(); position via {at}

  const reader = res.body.getReader();
  const t0 = Date.now();
  let lastPost = 0, bytesSincePost = 0, appended = 0;
  const chunks = []; // collected post-resume for hashing
  let hashing = true; // hash everything we append in this session

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        access.write(new Uint8Array(value), { at: writeAt });
        writeAt += value.length;
        received += value.length; appended += value.length; bytesSincePost += value.length;
        if (hashing) chunks.push(value);
        const now = Date.now();
        if (now - lastPost > 120) {
          lastPost = now;
          post({ type: 'download-progress', id, received, total, rate: appended / ((now - t0) / 1000 + 1e-9) });
        }
        if (bytesSincePost > (16 << 20)) { bytesSincePost = 0; writeMeta(received); }
      }
    }
    access.flush();
    writeMeta(received);
  } catch (e) {
    try { access.close(); } catch {}
    if (signal.aborted) post({ type: 'download-aborted', id, received });
    else post({ type: 'download-error', id, error: `Download interrupted: ${e.message} (will resume from ${received} bytes)`, fatal: false });
    return;
  }
  access.close();

  if (total && received !== total) {
    post({ type: 'download-error', id, error: `Connection closed early (${received}/${total} bytes) — resume to continue`, fatal: false });
    return;
  }

  // verify
  if (sha256) {
    post({ type: 'download-progress', id, received, total, phase: 'verify' });
    let hashProgress = 0;
    const got = sha256Stream(chunks, appended, (p, tot) => {
      const now = Date.now();
      if (now - hashProgress > 200) { hashProgress = now; post({ type: 'download-progress', id, received: p, total: tot, phase: 'verify' }); }
    });
    // If we resumed a previous session, hash of appended part cannot equal whole-file hash.
    // In that case do a full-file verify (slower, safe).
    let verified = null;
    if (appended === received && got === sha256) verified = got;
    else {
      post({ type: 'download-progress', id, received: 0, total: received, phase: 'verify-full' });
      const full = await verifyHash(opfsPath, sha256, (p, tot) => {
        const now = Date.now();
        if (now - hashProgress > 200) { hashProgress = now; post({ type: 'download-progress', id, received: p, total: tot, phase: 'verify-full' }); }
      });
      verified = full === sha256 ? full : null;
    }
    if (!verified) {
      post({ type: 'download-error', id, error: 'SHA-256 mismatch — the downloaded file is corrupt. It will be deleted; please retry.', fatal: true });
      await deleteFile(opfsPath);
      await deleteFile(metaPath);
      return;
    }
  } else if (appended !== received) {
    // resumed but nothing to verify against — full size check only
  }

  post({ type: 'download-done', id, received, verifiedSha256: !!sha256 });
  currentJob = null;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'download') {
      if (currentJob) { postMessage({ type: 'download-error', id: m.id, error: 'another download is already running', fatal: false }); return; }
      await doDownload(m);
    } else if (m.type === 'abort-download') {
      currentJob?.abort.abort();
    } else if (m.type === 'stat') {
      const out = {};
      for (const p of m.paths) out[p] = await statFile(p);
      postMessage({ type: 'stat-result', req: m.req, out });
    } else if (m.type === 'delete') {
      postMessage({ type: 'delete-result', req: m.req, ok: await deleteFile(m.path) });
    } else if (m.type === 'test-opfs') {
      try {
        const root = await opfsRoot();
        const fh = await root.getFileHandle('.tagmill-opfs-test', { create: true });
        const ah = await fh.createSyncAccessHandle();
        ah.write(enc.encode('ok'));
        ah.truncate(2);
        ah.close();
        await root.removeEntry('.tagmill-opfs-test');
        postMessage({ type: 'test-opfs-result', ok: true });
      } catch (err) {
        postMessage({ type: 'test-opfs-result', ok: false, error: err.message });
      }
    }
  } catch (err) {
    postMessage({ type: 'worker-error', error: err.message, stack: err.stack });
  }
};
