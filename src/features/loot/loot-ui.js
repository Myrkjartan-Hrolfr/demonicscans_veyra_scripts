'use strict';

// Loot result modal and small DOM helpers shared by the loot features.
// Results go into the game's own #batchLootModal when the page has it
// (wave pages); otherwise into a modal of our own.

const { dedupeItems, summarizeNotes, totalItemUnits } = require('./loot-api');

const STYLE_ID = 'veyra-automation-loot-style';
const MODAL_ID = 'veyra-loot-modal';

const CSS = `
#${MODAL_ID}{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;font-family:system-ui,sans-serif}
#${MODAL_ID}.is-open{display:flex}
#${MODAL_ID} .vl-box{background:#2a2a3d;color:#fff;border-radius:12px;padding:16px;width:520px;max-width:100%;max-height:85vh;overflow:auto;box-shadow:0 16px 44px rgba(0,0,0,.6);box-sizing:border-box;text-align:center}
#${MODAL_ID} h2{margin:0 0 10px;font-size:18px}
.vl-summary{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:6px 0 10px}
.vl-chip{background:#212439;color:#cdd1ea;border:1px solid #2b2e49;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
.vl-note{color:#9aa0be;font-size:12px;margin:0 0 10px}
.vl-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.vl-item{position:relative;background:#1e1e2f;border:1px solid #2b2d44;border-radius:10px;width:88px;padding:8px 6px;text-align:center;box-sizing:border-box}
.vl-item img{width:56px;height:56px;object-fit:cover;border-radius:8px;display:block;margin:0 auto 6px}
.vl-item small{display:block;line-height:1.2;font-size:11px;word-break:break-word}
.vl-item .vl-qty{position:absolute;top:4px;right:4px;background:#111827;color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:999px;border:1px solid #2b2d44;line-height:1;pointer-events:none}
.vl-item .vl-rank{color:#ffd369;font-size:9px;font-weight:700;margin-top:3px}
.vl-muted{color:#9aa0be;padding:6px 0}
#${MODAL_ID} .vl-actions{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
#${MODAL_ID} .vl-actions button{background:#333;color:#fff;border:1px solid #444;border-radius:8px;padding:9px 16px;cursor:pointer;font-weight:700;min-height:38px}
`;

function ensureLootStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function el(doc, tag, { className = '', text = null, attrs = null } = {}) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  for (const [name, value] of Object.entries(attrs || {})) element.setAttribute(name, String(value));
  return element;
}

function safeImageUrl(url) {
  const text = String(url || '').trim();
  if (!text || /^\s*(?:javascript|data):/i.test(text)) return '';
  return text;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : String(value ?? '');
}

function summaryChips(totals, extraChips = []) {
  const chips = [...extraChips];
  const planned = totals.planned ? `${formatNumber(totals.processed)}/${formatNumber(totals.planned)}` : formatNumber(totals.processed);
  chips.push(`Processed: ${planned}`);
  chips.push(`Success: ${formatNumber(totals.success)}`);
  chips.push(`Fail: ${formatNumber(totals.fail)}`);
  chips.push(`EXP: ${formatNumber(totals.exp)}`);
  chips.push(`Gold: ${formatNumber(totals.gold)}`);
  if (totals.damage) chips.push(`Damage: ${formatNumber(totals.damage)}`);
  chips.push(`Items: ${formatNumber(totalItemUnits(totals.items))}`);
  return chips;
}

function renderItems(doc, container, items) {
  container.replaceChildren();
  const grouped = dedupeItems(items);
  if (!grouped.length) {
    container.appendChild(el(doc, 'div', { className: 'vl-muted muted', text: 'No items this time.' }));
    return;
  }
  for (const item of grouped) {
    const box = el(doc, 'div', { className: 'vl-item blm-item' });
    if (item.quantity > 1) box.appendChild(el(doc, 'span', { className: 'vl-qty', text: `x${formatNumber(item.quantity)}` }));
    const src = safeImageUrl(item.image);
    if (src) box.appendChild(el(doc, 'img', { attrs: { src, alt: item.name, loading: 'lazy' } }));
    box.appendChild(el(doc, 'small', { text: item.name }));
    if (item.tier) box.appendChild(el(doc, 'small', { className: 'muted', text: item.tier }));
    if (item.source === 'ranking') box.appendChild(el(doc, 'div', { className: 'vl-rank', text: 'RANK REWARD' }));
    container.appendChild(box);
  }
}

function fillSummary(doc, container, chips) {
  container.replaceChildren(...chips.map((text) => el(doc, 'span', { className: 'chip vl-chip', text })));
}

function ensureOwnModal(doc) {
  let modal = doc.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = el(doc, 'div', { attrs: { id: MODAL_ID, role: 'dialog', 'aria-modal': 'true' } });
  const box = el(doc, 'div', { className: 'vl-box' });
  box.append(
    el(doc, 'h2', { className: 'vl-title', text: '🎁 Loot Gained' }),
    el(doc, 'div', { className: 'vl-summary' }),
    el(doc, 'div', { className: 'vl-note' }),
    el(doc, 'div', { className: 'vl-grid' }),
  );
  const actions = el(doc, 'div', { className: 'vl-actions' });
  const close = el(doc, 'button', { className: 'vl-close', text: 'Close', attrs: { type: 'button' } });
  actions.appendChild(close);
  box.appendChild(actions);
  modal.appendChild(box);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close.click();
  });
  close.addEventListener('click', () => {
    modal.classList.remove('is-open');
    if (modal._veyraReload) doc.defaultView?.location?.reload?.();
  });
  doc.body.appendChild(modal);
  return modal;
}

// Shows a loot summary. Options: title, totals (createLootTotals shape),
// extraChips, reloadOnClose (own modal only).
function showLootResults(doc, { title = '🎁 Loot Gained', totals, extraChips = [], reloadOnClose = false } = {}) {
  if (!doc?.body || !totals) return;
  ensureLootStyle(doc);
  const chips = summaryChips(totals, extraChips);
  const note = summarizeNotes(totals.notes, totals.items.length > 0);

  const native = doc.getElementById('batchLootModal');
  const nativeSummary = doc.getElementById('blmSummary');
  const nativeGrid = doc.getElementById('batchLootItems');
  if (native && nativeSummary && nativeGrid) {
    const nativeTitle = doc.getElementById('blmTitle');
    if (nativeTitle) nativeTitle.textContent = title;
    fillSummary(doc, nativeSummary, chips);
    const nativeNote = doc.getElementById('blmNote');
    if (nativeNote) {
      nativeNote.textContent = note;
      nativeNote.style.display = note ? 'block' : 'none';
    }
    renderItems(doc, nativeGrid, totals.items);
    native.style.display = 'flex';
    return;
  }

  const modal = ensureOwnModal(doc);
  modal._veyraReload = Boolean(reloadOnClose);
  modal.querySelector('.vl-title').textContent = title;
  fillSummary(doc, modal.querySelector('.vl-summary'), chips);
  const noteEl = modal.querySelector('.vl-note');
  noteEl.textContent = note;
  noteEl.style.display = note ? 'block' : 'none';
  renderItems(doc, modal.querySelector('.vl-grid'), totals.items);
  const close = modal.querySelector('.vl-close');
  if (close) close.textContent = reloadOnClose ? 'Close & refresh' : 'Close';
  modal.classList.add('is-open');
}

// Calls fn at most once per waitMs after the last call.
function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}

// Debounced subtree observer that only reacts when elements are added (the
// wave page rewrites countdown text every second, which is ignored).
// Returns a disconnect function.
function observeDebounced(win, target, callback, waitMs = 300) {
  const Observer = win?.MutationObserver || globalThis.MutationObserver;
  if (!Observer || !target) return () => {};
  const run = debounce(callback, waitMs);
  const observer = new Observer((records) => {
    const addsElements = records.some((record) => [...record.addedNodes].some((node) => node.nodeType === 1));
    if (addsElements) run();
  });
  observer.observe(target, { childList: true, subtree: true });
  return () => observer.disconnect();
}

module.exports = {
  MODAL_ID,
  STYLE_ID,
  debounce,
  el,
  ensureLootStyle,
  formatNumber,
  observeDebounced,
  safeImageUrl,
  showLootResults,
  summaryChips,
};
