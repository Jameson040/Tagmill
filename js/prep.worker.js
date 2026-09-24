// Prep worker: decode → official Camie preprocessing (fit+pad 512², ImageNet norm) → tensor,
// plus thumbnails and quick content hashing. All heavy pixel work happens here, off the UI thread.

const SIZE = 512;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const PAD = [124, 116, 104];

let canvas512 = null, ctx512 = null;
let thumbCanvas = null, thumbCtx = null;

function get512() {
  if (!canvas512) {
    canvas512 = new OffscreenCanvas(SIZE, SIZE);
    ctx512 = canvas512.getContext('2d', { willReadFrequently: true, alpha: false });
  }
  return ctx512;
}
function getThumbCtx(w, h) {
  if (!thumbCanvas) { thumbCanvas = new OffscreenCanvas(w, h); thumbCtx = thumbCanvas.getContext('2d', { alpha: false }); }
  if (thumbCanvas.width !== w || thumbCanvas.height !== h) { thumbCanvas.width = w; thumbCanvas.height = h; }
  return thumbCtx;
}

// ---------- format sniffing ----------
function sniff(bytes, name, ext) {
  const b = bytes;
  const ascii = (s, off = 0) => { for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false; return true; };
  if (b.length < 12) return { mime: 'unknown', ext };
  if (b[0] === 0xFF && b[1] === 0xD8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (ascii('PNG')) return { mime: 'image/png', ext: 'png' };
  if (ascii('GIF8')) return { mime: 'image/gif', ext: 'gif' };
  if (ascii('RIFF', 0) && ascii('WEBP', 8)) return { mime: 'image/webp', ext: 'webp' };
  if (ascii('BM')) return { mime: 'image/bmp', ext: 'bmp' };
  if (ascii('II*\u0000') || ascii('MM\u0000*')) return { mime: 'image/tiff', ext: 'tif', unsupported: 'TIFF is not decodable by browsers' };
  if (ascii('ftyp', 4)) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1') || brand.startsWith('hevc') || brand.startsWith('avif'))
      return brand.startsWith('avif')
        ? { mime: 'image/avif', ext: 'avif' }
        : { mime: 'image/heic', ext: 'heic', unsupported: 'HEIC is not decodable by browsers (convert to JPEG/PNG first)' };
    return { mime: 'image/mp4?', ext, unsupported: 'ISOBMFF container is not a decodable image' };
  }
  if (ascii('<svg') || ascii('<?xml')) return { mime: 'image/svg+xml', ext: 'svg', unsupported: 'SVG is not a raster image' };
  if (ascii('8BPS')) return { mime: 'image/vnd.adobe.photoshop', ext: 'psd', unsupported: 'PSD is not decodable by browsers' };
  if (b[0] === 0x89 && ascii('HDF', 1)) return { mime: 'application/x-hdf', ext, unsupported: 'not an image' };
  // text-ish or random bytes that were never images
  let printable = 0;
  for (let i = 0; i < Math.min(64, b.length); i++) { const c = b[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++; }
  if (printable === Math.min(64, b.length)) return { mime: 'text/plain', ext, unsupported: 'not a binary image file' };
  return { mime: 'unknown', ext };
}

// dimension probing from headers (avoids decoding 500-megapixel monsters)
function probeDimensions(bytes) {
  try {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) { // JPEG: scan SOF markers
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xFF) { off++; continue; }
        const marker = bytes[off + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { h: (bytes[off + 5] << 8) | bytes[off + 6], w: (bytes[off + 7] << 8) | bytes[off + 8] };
        }
        const len = (bytes[off + 2] << 8) | bytes[off + 3];
        off += 2 + len;
      }
      return null;
    }
    if (String.fromCharCode(...bytes.slice(1, 4)) === 'PNG') return { w: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0, h: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 };
    if (String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8') return { w: bytes[6] | bytes[7] << 8, h: bytes[8] | bytes[9] << 8 };
    if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
      const fourcc = String.fromCharCode(...bytes.slice(12, 16));
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (fourcc === 'VP8X') return { w: 1 + (dv.getUint16(24, true)), h: 1 + (dv.getUint16(26, true)) };
      if (fourcc === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      if (fourcc === 'VP8L') { const b = dv.getUint32(21, true); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* best effort */ }
  return null;
}

// ---------- decode ----------
async function decode(file, maxMP, headBytes) {
  const dim = probeDimensions(headBytes);
  if (dim && dim.w * dim.h > maxMP * 1e6) {
    const err = new Error(`Image is ${dim.w}×${dim.h} (${(dim.w * dim.h / 1e6).toFixed(0)} MP) — exceeds the ${(maxMP)} MP decode budget. Enable "attempt huge images" in Storage & maintenance to override.`);
    err.code = 'E_TOO_LARGE';
    throw err;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  } catch (e) {
    const err = new Error(`Decode failed: ${e.message || e}`);
    err.code = 'E_DECODE';
    throw err;
  }
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    const err = new Error('Decoded to empty image');
    err.code = 'E_DECODE';
    throw err;
  }
  if (bitmap.width * bitmap.height > maxMP * 1e6) {
    bitmap.close();
    const err = new Error(`Decoded size ${bitmap.width}×${bitmap.height} exceeds the ${maxMP} MP decode budget`);
    err.code = 'E_TOO_LARGE';
    throw err;
  }
  return bitmap;
}

// ---------- official preprocessing: aspect-fit resize + pad(124,116,104) + ImageNet normalize ----------
function toTensor(bitmap) {
  const ctx = get512();
  const ar = bitmap.width / bitmap.height;
  let nw, nh;
  if (ar > 1) { nw = SIZE; nh = Math.round(SIZE / ar); } else { nh = SIZE; nw = Math.round(SIZE * ar); }
  nw = Math.max(1, Math.min(SIZE, nw)); nh = Math.max(1, Math.min(SIZE, nh));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = `rgb(${PAD[0]},${PAD[1]},${PAD[2]})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(bitmap, (SIZE - nw) >> 1, (SIZE - nh) >> 1, nw, nh);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE;
  const out = new Float32Array(3 * n);
  const planeR = 0, planeG = n, planeB = 2 * n;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[planeR + i] = (px[p] / 255 - MEAN[0]) / STD[0];
    out[planeG + i] = (px[p + 1] / 255 - MEAN[1]) / STD[1];
    out[planeB + i] = (px[p + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

async function makeThumb(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = getThumbCtx(w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
}

async function quickHash(file, headBytes) {
  try {
    const sample = headBytes.length >= (256 << 10)
      ? headBytes.slice(0, 256 << 10)
      : headBytes;
    const digest = await crypto.subtle.digest('SHA-256', sample);
    const hex = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 32)}-${file.size}`;
  } catch {
    return null; // hashing is best-effort (insecure contexts lack crypto.subtle)
  }
}

const HEAD_BYTES = Math.max(256 << 10, 0); // one read serves sniff + dim probe + hash sample

async function doPrep(msg) {
  const t0 = performance.now();
  const { file, maxMP = 120, thumbSize = 144 } = msg;
  let headBytes = null;
  try {
    headBytes = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  } catch (e) {
    throw Object.assign(new Error(`Cannot read file: ${e.message}`), { code: 'E_READ' });
  }
  const sniffed = sniff(headBytes, file.name, (file.name.match(/\.([^.]+)$/) || [])[1]);
  if (sniffed.unsupported) throw Object.assign(new Error(sniffed.unsupported), { code: 'E_UNSUPPORTED', mime: sniffed.mime });
  const bitmap = await decode(file, maxMP, headBytes);
  const width = bitmap.width, height = bitmap.height;
  try {
    const tensor = toTensor(bitmap);
    const thumb = thumbSize > 0 ? await makeThumb(bitmap, thumbSize) : null;
    const quickHashVal = await quickHash(file, headBytes);
    return {
      tensor, thumb, width, height, quickHash: quickHashVal,
      mime: sniffed.mime, decodeMs: Math.round(performance.now() - t0),
    };
  } finally {
    bitmap.close();
  }
}

async function doThumbOnly(msg) {
  const { file, thumbSize = 144, maxMP = 120 } = msg;
  let headBytes;
  try { headBytes = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()); }
  catch (e) { throw Object.assign(new Error(`Cannot read file: ${e.message}`), { code: 'E_READ' }); }
  const sniffed = sniff(headBytes, file.name, '');
  if (sniffed.unsupported) throw Object.assign(new Error(sniffed.unsupported), { code: 'E_UNSUPPORTED' });
  const bitmap = await decode(file, maxMP, headBytes);
  try {
    const thumb = await makeThumb(bitmap, thumbSize);
    return { thumb, width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'ping') { postMessage({ type: 'pong' }); return; }
  if (m.type === 'prep') {
    try {
      const r = await doPrep(m);
      const tensorBuf = r.tensor.buffer;
      const { tensor, ...rest } = r;
      postMessage({ type: 'prep-ok', reqId: m.reqId, id: m.id, ...rest, tensorBuf }, [tensorBuf]);
    } catch (err) {
      postMessage({ type: 'prep-err', reqId: m.reqId, id: m.id, code: err.code || 'E_UNKNOWN', message: String(err.message || err) });
    }
  } else if (m.type === 'thumb') {
    try {
      const r = await doThumbOnly(m);
      postMessage({ type: 'thumb-ok', reqId: m.reqId, id: m.id, thumb: r.thumb, width: r.width, height: r.height });
    } catch (err) {
      postMessage({ type: 'thumb-err', reqId: m.reqId, id: m.id, code: err.code || 'E_UNKNOWN', message: String(err.message || err) });
    }
  }
};
