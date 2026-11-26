/**
 * sheet.js
 * Bottom sheets made on the fly for the shop (offers, cart, checkout, listings, orders): the same look as the fixed sheets in
 * index.html (.overlay > .sheet), but created from code and thrown away when closed. Sheets stack: opening one from another
 * puts it on top, and closing it shows the one below again.
 */
import { escapeHtml } from './dom.js';

/**
 * Opens a sheet and returns { el, body, setTitle, close }. `body` is where the content goes. Closes with the X, a tap on the
 * dark area around it, or Escape; `onClose` runs once whichever way it closed.
 */
export function openSheet({ title = '', full = false, onClose } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="sheet ${full ? 'sheet--full' : 'sheet--tall'} sheet--shop" role="dialog" aria-modal="true">
      <div class="sheet-header">
        <button class="icon-btn" type="button" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <h2 class="sheet-title sheet-title--inline">${escapeHtml(title)}</h2>
      </div>
      <div class="sheet-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && overlay === [...document.querySelectorAll('.overlay')].pop()) close(); };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (onClose) onClose();
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return {
    el: overlay,
    body: overlay.querySelector('.sheet-body'),
    setTitle: (text) => { overlay.querySelector('.sheet-title').textContent = text; },
    close,
  };
}
