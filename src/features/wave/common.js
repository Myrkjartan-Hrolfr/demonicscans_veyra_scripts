'use strict';

// Small DOM helpers shared by the wave page features. All of them are null
// safe so a missing element never throws.

function isWavePage(url) {
  return /\/active_wave\.php\/?$/i.test(String(url?.pathname || ''));
}

function addStyle(doc, id, css) {
  if (!doc?.createElement || doc.getElementById?.(id)) return null;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = css;
  (doc.head || doc.documentElement)?.appendChild(style);
  return style;
}

function debounce(fn, waitMs = 200) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

// createElement with className/text/attributes in one call.
function make(doc, tag, { className, text, attrs, style } = {}) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [name, value] of Object.entries(attrs || {})) element.setAttribute(name, String(value));
  if (style) element.style.cssText = style;
  return element;
}

function reloadPage(win) {
  try {
    win?.location?.reload?.();
  } catch {
    // ignore
  }
}

function setStatus(doc, text) {
  const status = doc?.getElementById?.('batchAttackStatus');
  if (status) status.textContent = String(text ?? '');
  return status;
}

function monsterCards(root) {
  return Array.from(root?.querySelectorAll?.('.monster-card') || []);
}

function findMonsterCard(doc, monsterId) {
  const id = String(monsterId);
  return monsterCards(doc).find((card) => card.dataset?.monsterId === id) || null;
}

module.exports = {
  addStyle,
  debounce,
  findMonsterCard,
  isWavePage,
  make,
  monsterCards,
  reloadPage,
  setStatus,
};
