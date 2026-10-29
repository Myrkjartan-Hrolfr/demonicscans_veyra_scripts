'use strict';

// Pure, null-safe helpers shared by the PvP page features (ported from
// veyra-hud ui-improvements). Everything here can run in Node tests.

const PVP_PAGE_RE = /\/pvp\.php$/i;
const PVP_BATTLE_PAGE_RE = /\/pvp_battle\.php$/i;

function isPvpLobbyUrl(url) {
  return PVP_PAGE_RE.test(String(url?.pathname || ''));
}

function isPvpBattleUrl(url) {
  return PVP_BATTLE_PAGE_RE.test(String(url?.pathname || ''));
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The topbar shows "pills" like <div class="pill"><div class="lbl">Ladder</div>
// <div class="val">Solo</div></div>. Returns the value text or null.
function readPillValue(doc, label) {
  const wanted = normalizeText(label).toLowerCase();
  const pills = doc?.querySelectorAll?.('.pill') || [];
  for (const pill of pills) {
    const lbl = normalizeText(pill?.querySelector?.('.lbl')?.textContent).toLowerCase();
    if (lbl !== wanted) continue;
    const value = normalizeText(pill.querySelector?.('.val')?.textContent);
    return value || null;
  }
  return null;
}

// veyra-hud crashed here when the Ladder pill was missing; a missing pill
// now simply means "not a solo match".
function isSoloLadder(doc) {
  return (readPillValue(doc, 'Ladder') || '').toLowerCase() === 'solo';
}

// Name comparison for the "Current Turn" box (it may carry an emoji prefix).
function normalizeName(value) {
  return normalizeText(String(value ?? '').replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '')).toLowerCase();
}

function isPlayersTurn(playerName, turnText) {
  const player = normalizeName(playerName);
  const turn = normalizeName(turnText);
  if (!player || !turn) return false;
  return turn.includes(player);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Finds the newest attack log entry hitting the given side ("enemy" or
// "ally"). logDetailsMap may be an object keyed by log id or an array.
function findLastHit(logDetailsMap, side) {
  if (!logDetailsMap || typeof logDetailsMap !== 'object') return null;
  const entries = Array.isArray(logDetailsMap) ? logDetailsMap : Object.values(logDetailsMap);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'attack' || entry.target?.side !== side) continue;
    const before = toNumber(entry.target.hp_before);
    const after = toNumber(entry.target.hp_after);
    const hpDamage = before !== null && after !== null ? Math.max(0, before - after) : null;
    const dealt = toNumber(entry.formula?.target_damage_dealt);
    return {
      skillName: normalizeText(entry.skill?.name) || 'Attack',
      damage: dealt ?? hpDamage ?? 0,
      hpDamage: hpDamage ?? 0,
      key: [entry.actor?.key ?? '', entry.target?.key ?? '', before ?? '', after ?? '', index].join('|'),
    };
  }
  return null;
}

// stateData.teams.enemy.players_by_num → { slotKey: role }.
function extractEnemyRoles(stateData) {
  const players = stateData?.teams?.enemy?.players_by_num;
  const roles = {};
  if (!players || typeof players !== 'object') return roles;
  for (const player of Object.values(players)) {
    const key = player?.key;
    const role = normalizeText(player?.role);
    if (key && role) roles[key] = role;
  }
  return roles;
}

// "#4782068" → "4782068"; anything else → null.
function parseMatchId(text) {
  const match = String(text ?? '').match(/#?\s*(\d{1,12})/);
  return match ? match[1] : null;
}

function isRecentSectionTitle(text) {
  return /\brecent\b/i.test(String(text ?? ''));
}

function battleUrlForMatch(matchId) {
  return `/pvp_battle.php?match_id=${encodeURIComponent(matchId)}`;
}

function formatInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Math.round(number).toLocaleString('en-US');
}

// Calls `callback` at most once per `delayMs` after DOM changes below
// `target`. Replaces veyra-hud's permanent 333 ms polling.
function observeDebounced(win, target, callback, { delayMs = 150, options } = {}) {
  const Observer = win?.MutationObserver;
  if (!Observer || !target) return { disconnect() {}, flush() {} };
  let timer = null;
  const fire = () => {
    timer = null;
    try {
      callback();
    } catch (error) {
      console.error('[Veyra] PvP observer callback failed.', error);
    }
  };
  const observer = new Observer(() => {
    if (timer !== null) return;
    timer = win.setTimeout(fire, delayMs);
  });
  observer.observe(target, options || { childList: true, subtree: true, characterData: true });
  return {
    disconnect() {
      observer.disconnect();
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
    },
    flush: fire,
  };
}

module.exports = {
  battleUrlForMatch,
  extractEnemyRoles,
  findLastHit,
  formatInteger,
  isPlayersTurn,
  isPvpBattleUrl,
  isPvpLobbyUrl,
  isRecentSectionTitle,
  isSoloLadder,
  normalizeName,
  observeDebounced,
  parseMatchId,
  readPillValue,
};
