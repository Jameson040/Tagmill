// Modal & toast primitives.
import { $, el, escapeHtml } from './util.js';

export function toast({ kind = 'info', title = '', msg = '', timeout = 5000 }) {
  const t = el('div', { class: `toast ${kind}` });
  if (title) t.append(el('b', { text: title }));
  if (msg) t.append(msg instanceof Node ? msg : el('span', { text: msg }));
  $('#toasts').append(t);
  if (timeout) setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, timeout);
  return t;
}

export function modal({ title, body, buttons = [], wide = false, onClose = null }) {
  const root = $('#modal-root');
  const overlay = el('div');
  const box = el('div', { class: 'modal', style: wide ? 'width:860px' : '' });
  const close = () => { overlay.remove(); onClose?.(); };
  box.append(el('h2', { text: title }));
  const bodyEl = el('div');
  if (body instanceof Node) bodyEl.append(body); else bodyEl.innerHTML = body;
  box.append(bodyEl);
  if (buttons.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const b of buttons) {
      foot.append(el('button', {
        class: 'btn' + (b.kind ? ' ' + b.kind : ''),
        text: b.label,
        onclick: async () => {
          if (b.keepOpen) { await b.onClick?.(close); return; }
          close();
          await b.onClick?.();
        },
      }));
    }
    box.append(foot);
  }
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  root.append(overlay);
  return { close, box, body: bodyEl };
}

export function confirmDialog(msg, { danger = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = modal({
      title: 'Please confirm',
      body: `<p style="white-space:pre-wrap">${escapeHtml(msg)}</p>`,
      buttons: [
        { label: 'Cancel', onClick: () => { settled = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { settled = true; resolve(true); } },
      ],
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}
