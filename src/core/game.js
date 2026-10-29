'use strict';

// Helpers that read common game data from a page document. They are null
// safe: a missing element yields null instead of throwing.

const { parseFraction, parseGameNumber } = require('./numbers');

// Reads a global of the page script. Top-level const/let bindings of the
// page (USER_ID, ENDPOINTS, STATE, …) are not window properties, but a
// Function created in the page realm can still resolve them by name.
function pageGlobal(win, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  try {
    const PageFunction = win?.Function || Function;
    return new PageFunction(`return typeof ${name} === 'undefined' ? undefined : ${name};`)();
  } catch {
    return undefined;
  }
}

// Runs a function inside the page context, for page APIs that only work
// when called from there.
function injectPageScript(doc, fn, ...args) {
  const script = doc.createElement('script');
  script.textContent = `(${fn})(...${JSON.stringify(args)});`;
  (doc.head || doc.documentElement).appendChild(script);
  script.remove();
}

function readUserIdFromDocument(doc, win = null) {
  const fromGlobal = Number(pageGlobal(win, 'USER_ID'));
  if (Number.isInteger(fromGlobal) && fromGlobal > 0) return fromGlobal;

  const avatar = doc?.querySelector?.('.small-ava img[src*="user_"]')?.getAttribute?.('src') || '';
  const avatarMatch = avatar.match(/user_(\d+)_/);
  if (avatarMatch) return Number(avatarMatch[1]);

  const profileLink = doc?.querySelector?.('a[href*="player.php?pid="]')?.getAttribute?.('href') || '';
  const profileMatch = profileLink.match(/pid=(\d+)/);
  if (profileMatch) return Number(profileMatch[1]);

  const healOnclick = doc?.querySelector?.('#healBtn')?.getAttribute?.('onclick') || '';
  const healMatch = healOnclick.match(/healDungeonPlayer\(\s*\d+\s*,\s*(\d+)/);
  if (healMatch) return Number(healMatch[1]);

  return null;
}

function createUserIdResolver({ doc, win, fetchImpl = globalThis.fetch }) {
  let cached = null;
  return async function getUserId() {
    if (cached) return cached;
    cached = readUserIdFromDocument(doc, win);
    if (cached) return cached;

    try {
      const response = await fetchImpl('/active_wave.php?gate=3&wave=3', { credentials: 'same-origin' });
      const match = (await response.text()).match(/USER_ID\s*=\s*(\d+)/);
      cached = match ? Number(match[1]) : null;
    } catch {
      cached = null;
    }
    return cached;
  };
}

function getUsername(doc) {
  return doc?.querySelector?.('.small-name')?.textContent?.trim() || null;
}

// "1,234 / 5,000" in the top bar; returns the EXP still missing or null.
function getRequiredExperienceToLevel(doc) {
  const text = doc?.querySelector?.('.gtb-exp-top span:last-child')?.textContent;
  const fraction = parseFraction(text);
  return fraction ? Math.max(0, fraction.max - fraction.current) : null;
}

function getCurrentLevel(doc) {
  const match = String(doc?.querySelector?.('.gtb-level')?.textContent || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function getStamina(doc) {
  const current = parseGameNumber(doc?.querySelector?.('#stamina_span')?.textContent);
  return current;
}

function getMonsterNameFromBattlePage(doc) {
  const title = doc?.querySelector?.('.monster-card .card-title');
  if (!title) return null;
  const textNode = [...title.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim());
  const text = (textNode?.textContent || title.textContent || '').replace(/[^\p{L}\p{N}\s,'.-]/gu, '');
  return text.trim() || null;
}

function isCloudflareError(doc) {
  return Boolean(
    doc?.querySelector?.('#cf-error-details, #cf-wrapper, #cf-cloudflare-status, .ch-description'),
  );
}

// Uses the game's own #notification toast when present, otherwise a small
// toast of our own.
function notify(doc, message, type = 'success') {
  const text = String(message ?? '');
  const native = doc?.getElementById?.('notification');
  const element = native || ensureToast(doc);
  if (!element) return;

  element.textContent = text;
  element.style.backgroundColor = type === 'error' ? '#e74c3c' : '#2ecc71';
  element.style.display = 'block';
  clearTimeout(element._veyraHideTimer);
  element._veyraHideTimer = setTimeout(() => {
    element.style.display = 'none';
  }, 3_000);
}

function ensureToast(doc) {
  if (!doc?.body) return null;
  let toast = doc.getElementById('veyra-automation-toast');
  if (toast) return toast;
  toast = doc.createElement('div');
  toast.id = 'veyra-automation-toast';
  toast.style.cssText =
    'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
    'padding:10px 16px;border-radius:10px;color:#fff;font:600 13px system-ui,sans-serif;' +
    'box-shadow:0 8px 20px rgba(0,0,0,.5);display:none;max-width:90vw;';
  doc.body.appendChild(toast);
  return toast;
}

module.exports = {
  createUserIdResolver,
  getCurrentLevel,
  getMonsterNameFromBattlePage,
  getRequiredExperienceToLevel,
  getStamina,
  getUsername,
  injectPageScript,
  isCloudflareError,
  notify,
  pageGlobal,
  readUserIdFromDocument,
};
