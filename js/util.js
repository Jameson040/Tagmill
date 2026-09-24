// Shared helpers
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
export function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function fmtNum(n) { return n.toLocaleString('en-US'); }
export function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }

export function debounce(fn, ms) {
  let t = null;
  const w = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  w.cancel = () => clearTimeout(t);
  return w;
}

export function hashColor(str) { // stable pastel from string
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 32% 26%)`;
}

// Minimal event bus
export function emitter() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) ?? map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev)?.delete(fn); },
    off(ev, fn) { map.get(ev)?.delete(fn); },
    emit(ev, ...args) { map.get(ev)?.forEach(fn => { try { fn(...args); } catch (e) { console.error('listener', ev, e); } }); },
  };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'jfif', 'pjpg']);
// deliberately NOT auto-included: heic/heic (no browser decode), svg (vector, different pipeline), psd etc.

export function sanitizeFilename(s, fallback = 'file') {
  // cross-platform conservative: replace path separators & control chars, trim dots/spaces at ends
  let out = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/ +$/, '');
  if (!out || out === '.') out = fallback;
  return out.slice(0, 180); // leave room for extension
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// CRC32 for zip
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}
