'use strict';

// Small DOM helpers shared by the general features. All of them are null
// safe so a missing document part never throws.

function injectStyle(doc, id, css) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const existing = doc.getElementById?.(id);
  if (existing) return existing;
  const parent = doc.head || doc.documentElement;
  if (!parent) return null;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = css;
  parent.appendChild(style);
  return style;
}

// Trailing-edge debounce, used for MutationObserver callbacks.
function debounce(fn, waitMs = 150) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}

function textOf(element) {
  return String(element?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  debounce,
  injectStyle,
  textOf,
};
