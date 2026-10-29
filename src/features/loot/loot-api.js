'use strict';

// Loot requests and result bookkeeping shared by the wave and dungeon loot
// features. Merges veyra-hud's lootMonster/dedupeItems (MIT, koenrad) with
// the response handling of our Advanced Dead Monster Looter.
//
// Every request function takes the postForm of a feature context
// (core/http.postForm signature: (url, params) → {ok, status, text, json}),
// so the logic can be tested without a browser.

const { parseGameNumber } = require('../../core/numbers');
const { sleep } = require('../../core/time');

// Wave bosses that bulk looting skips when "ignore boss mobs" is on
// (veyra-hud LOOTING_BLACKLIST).
const LOOTING_BLACKLIST = Object.freeze([
  'drakzareth the cataclysmic half dragon king',
  'general skarn the radiant bastion',
  'general vessir the sunfang duelist',
  'general hrazz the dawnflame oathkeeper',
  'vessir, the solar inferna empress',
  'drakzareth the tyrant lizard king',
  'hrazz the dawnflame seraph',
  'skarn, the molten general',
  'oceanus the water titan',
  'poseidon, the sea emperor',
]);

const LOOTING_BLACKLIST_SET = new Set(LOOTING_BLACKLIST);

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

function normalizeMonsterName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isBlacklistedBoss(name) {
  return LOOTING_BLACKLIST_SET.has(normalizeMonsterName(name));
}

// ----------------------------------------------------------------------------
// Numbers and response parsing
// ----------------------------------------------------------------------------

function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined || value === '') return 0;
  const parsed = parseGameNumber(value);
  return parsed === null ? 0 : parsed;
}

// "75", "75.00", "1,250", 3 → positive integer, otherwise the fallback.
function parsePositiveQuantity(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  let text = String(value).trim();
  if (/^\d{1,3}(?:[,.]\d{3})+$/.test(text)) text = text.replace(/[,.]/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Same priority as the game's own loot modal (QUANTITY, then quantity),
// then the variants other endpoints use (dungeon bulk loot: QTY).
function itemQuantity(item) {
  if (!item || typeof item !== 'object') return 1;
  const candidates = [
    item.QUANTITY,
    item.quantity,
    item.QTY,
    item.qty,
    item.AMOUNT,
    item.amount,
    item.COUNT,
    item.count,
    item.QUANTITY_DROPPED,
  ];
  for (const value of candidates) {
    const quantity = parsePositiveQuantity(value, 0);
    if (quantity > 0) return quantity;
  }
  return 1;
}

function itemName(item) {
  return String(item?.NAME || item?.name || item?.ITEM_NAME || item?.item_name || item?.title || 'Unknown item');
}

function itemImage(item) {
  const image = item?.IMAGE_URL || item?.image_url || item?.image || item?.IMG || item?.img || '';
  return typeof image === 'string' ? image : '';
}

function itemTier(item) {
  const tier = item?.TIER || item?.tier || '';
  return typeof tier === 'string' ? tier : '';
}

function itemKey(item) {
  const id = item?.ITEM_ID ?? item?.item_id ?? item?.ID ?? item?.id;
  const base = id !== undefined && id !== null && id !== '' ? `id:${id}` : `name:${itemName(item).toLowerCase()}`;
  return `${item?.__source === 'ranking' ? 'ranking' : 'normal'}:${base}`;
}

// The loot payload is usually an array, but older responses used a single
// item or a {name: qty} map.
function normalizeItemPayload(payload, source) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === 'object').map((item) => ({ ...item, __source: source }));
  }
  if (typeof payload !== 'object') return [];
  if (payload.NAME || payload.name || payload.ITEM_NAME || payload.IMAGE_URL || payload.image_url) {
    return [{ ...payload, __source: source }];
  }
  return Object.entries(payload).flatMap(([name, value]) => {
    if (value && typeof value === 'object') return [{ name, ...value, __source: source }];
    const quantity = parsePositiveQuantity(value, 0);
    return quantity > 0 ? [{ name, QUANTITY: quantity, __source: source }] : [];
  });
}

function extractItems(data) {
  if (!data || typeof data !== 'object') return [];
  const normal = data.items ?? data.rewards?.items ?? data.loot?.items ?? null;
  return [...normalizeItemPayload(normal, 'normal'), ...normalizeItemPayload(data.ranking_rewards, 'ranking')];
}

function parseJsonText(text) {
  const cleaned = String(text ?? '')
    .replace(/^﻿/, '')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function responseData(response) {
  if (response?.json && typeof response.json === 'object') return response.json;
  return parseJsonText(response?.text);
}

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function readLevel(data) {
  const candidates = [
    data?.new_level,
    data?.newLevel,
    data?.player_level,
    data?.user_level,
    data?.user?.level,
    data?.player?.level,
    data?.rewards?.new_level,
    data?.rewards?.level,
  ];
  for (const value of candidates) {
    const level = Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(level) && level > 0) return level;
  }
  return null;
}

function hasLevelUpSignal(data, message) {
  if (!data || typeof data !== 'object') return false;
  const flag = [data.level_up, data.levelUp, data.leveled_up, data.leveledUp, data.did_level_up].some(isTruthyFlag);
  const status = String(data.status || '').toLowerCase();
  if (flag || ['level_up', 'levelup', 'leveled_up'].includes(status)) return true;
  const text = String(message || '');
  if (/\b(?:did\s+not|not|no)\s+level(?:ed|led)?\s*up\b/i.test(text)) return false;
  return /\b(?:level(?:ed|led)\s*up|reached\s+(?:a\s+)?new\s+level|new\s+level\s+reached)\b/i.test(text);
}

function isSuccessData(data) {
  return Boolean(data && (data.status === 'success' || data.success === true || data.ok === true));
}

// Turns a loot.php / dungeon_loot.php response into one flat result.
function parseLootResponse(response) {
  const data = responseData(response);
  const ok = isSuccessData(data);
  const message = String(data?.message || data?.error || (ok ? 'OK' : '') || '');
  const rewards = data?.rewards && typeof data.rewards === 'object' ? data.rewards : data || {};
  const result = {
    ok,
    httpStatus: response?.status ?? null,
    message: ok ? message : message || (response?.status ? `HTTP ${response.status}` : 'Failed'),
    note: ok ? String(data?.note || '') : message || 'Failed',
    exp: ok ? toAmount(rewards.exp ?? data?.exp) : 0,
    gold: ok ? toAmount(rewards.gold ?? data?.gold) : 0,
    damage: ok ? toAmount(rewards.damage_dealt ?? data?.damage_dealt) : 0,
    items: ok ? extractItems(data) : [],
    levelUp: ok && hasLevelUpSignal(data, `${data?.message || ''} ${data?.note || ''}`),
    level: ok ? readLevel(data) : null,
    processed: 1,
    data,
  };
  return result;
}

// dungeon_loot.php action=loot_all answers
// {status, summary: {processed, exp, gold}, items: [{NAME, QTY, …}], note}.
function parseBulkLootResponse(response) {
  const data = responseData(response);
  const ok = isSuccessData(data);
  const summary = data?.summary && typeof data.summary === 'object' ? data.summary : {};
  return {
    ok,
    httpStatus: response?.status ?? null,
    message: String(data?.message || (ok ? 'OK' : response?.status ? `HTTP ${response.status}` : 'Failed')),
    note: String(data?.note || (ok ? '' : data?.message || '')),
    exp: ok ? toAmount(summary.exp ?? data?.exp) : 0,
    gold: ok ? toAmount(summary.gold ?? data?.gold) : 0,
    damage: ok ? toAmount(summary.damage_dealt ?? summary.damage) : 0,
    items: ok ? extractItems(data) : [],
    levelUp: ok && hasLevelUpSignal(data, data?.message),
    level: ok ? readLevel(data) : null,
    processed: ok ? Math.max(0, Math.floor(toAmount(summary.processed))) : 0,
    // false when the endpoint is missing or answered with something else
    // than JSON, so callers can fall back to per-monster looting.
    understood: Boolean(data && typeof data === 'object'),
    data,
  };
}

// ----------------------------------------------------------------------------
// Requests
// ----------------------------------------------------------------------------

function failedResult(message) {
  return {
    ok: false,
    httpStatus: null,
    message,
    note: message,
    exp: 0,
    gold: 0,
    damage: 0,
    items: [],
    levelUp: false,
    level: null,
    processed: 1,
    data: null,
  };
}

function validId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : null;
}

// Wave: POST loot.php monster_id(+user_id).
// Dungeon (instanceId given): POST dungeon_loot.php dgmid + instance_id.
async function lootMonster(postForm, { monsterId, userId = null, instanceId = null } = {}) {
  const id = validId(monsterId);
  if (!id) return failedResult('Missing monster id');
  const instance = validId(instanceId);
  const user = validId(userId);
  try {
    const response = instance
      ? await postForm('dungeon_loot.php', {
          dgmid: id,
          monster_id: id,
          instance_id: instance,
          user_id: user ?? undefined,
        })
      : await postForm('loot.php', { monster_id: id, user_id: user ?? undefined });
    return parseLootResponse(response);
  } catch (error) {
    return failedResult(`Network error: ${error?.message || error}`);
  }
}

async function lootDungeonLocation(postForm, { instanceId, locationId = null } = {}) {
  const instance = validId(instanceId);
  if (!instance) return { ...failedResult('Missing instance id'), processed: 0, understood: false };
  try {
    const response = await postForm('dungeon_loot.php', {
      action: 'loot_all',
      instance_id: instance,
      location_id: validId(locationId) ?? undefined,
    });
    return parseBulkLootResponse(response);
  } catch (error) {
    return { ...failedResult(`Network error: ${error?.message || error}`), processed: 0, understood: false };
  }
}

// POST /battle.php?id=<id> action=extract_shadow → {ok|status, shadow: {name, image}}.
async function extractShadow(postForm, monsterId) {
  const id = validId(monsterId);
  if (!id) return { ok: false, message: 'Missing monster id', shadow: null };
  try {
    const response = await postForm(`/battle.php?id=${id}`, { action: 'extract_shadow' });
    const data = responseData(response);
    const ok = isSuccessData(data);
    const shadow = ok
      ? {
          NAME: data?.shadow?.name || data?.shadow?.NAME || 'Shadow',
          IMAGE_URL: data?.shadow?.image || data?.shadow?.IMAGE_URL || '',
          ITEM_ID: `shadow:${data?.shadow?.id ?? data?.shadow?.ID ?? data?.shadow?.name ?? 'shadow'}`,
          QUANTITY: itemQuantity(data?.shadow || {}),
          TIER: 'SHADOW',
        }
      : null;
    return { ok, message: String(data?.message || (ok ? 'OK' : 'Extraction failed')), shadow };
  } catch (error) {
    return { ok: false, message: `Network error: ${error?.message || error}`, shadow: null };
  }
}

// ----------------------------------------------------------------------------
// Aggregation
// ----------------------------------------------------------------------------

function createLootTotals(planned = 0) {
  return { planned, processed: 0, success: 0, fail: 0, exp: 0, gold: 0, damage: 0, items: [], notes: [], levelUp: false };
}

function addLootResult(totals, result) {
  if (!result) return totals;
  // Single loots count as one monster; bulk results report how many
  // monsters they covered (possibly 0).
  const count = Number.isFinite(Number(result.processed)) ? Math.max(0, Number(result.processed)) : 1;
  if (result.ok) {
    totals.processed += count;
    totals.success += count;
    totals.exp += result.exp || 0;
    totals.gold += result.gold || 0;
    totals.damage += result.damage || 0;
    if (Array.isArray(result.items)) totals.items.push(...result.items);
    if (result.note) totals.notes.push(result.note);
    if (result.levelUp) totals.levelUp = true;
  } else {
    totals.processed += 1;
    totals.fail += 1;
    if (result.note || result.message) totals.notes.push(result.note || result.message);
  }
  return totals;
}

// Groups identical drops and SUMS their quantities (veyra-hud counted every
// drop as one, ignoring QUANTITY). Sorted by quantity, largest first.
function dedupeItems(items) {
  const groups = new Map();
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const key = itemKey(item);
    const quantity = itemQuantity(item);
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += quantity;
      if (!existing.image) existing.image = itemImage(item);
    } else {
      groups.set(key, {
        key,
        name: itemName(item),
        image: itemImage(item),
        tier: itemTier(item),
        source: item.__source === 'ranking' ? 'ranking' : 'normal',
        quantity,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

function totalItemUnits(items) {
  return (items || []).reduce((sum, item) => sum + itemQuantity(item), 0);
}

// Notes like "No item dropped" are noise when other monsters did drop items.
const DROPLESS_PATTERNS = [/^\s*no item dropped/i, /^\s*you didn[’']?t reach the damage requirement/i];

function summarizeNotes(notes, hasItems) {
  let filtered = (notes || []).map((note) => String(note || '').trim()).filter(Boolean);
  filtered = filtered.filter((note) => note !== 'OK');
  if (hasItems) filtered = filtered.filter((note) => !DROPLESS_PATTERNS.some((pattern) => pattern.test(note)));
  return [...new Set(filtered)].slice(0, 6).join(' ');
}

// ----------------------------------------------------------------------------
// Runner and level-up check
// ----------------------------------------------------------------------------

// Runs worker(item, index) for every item with at most `concurrency`
// requests in flight (veyra-hud fired 200 at once). shouldStop() is checked
// before every new item, so a stop leaves at most concurrency-1 requests
// running. Worker errors become {ok:false} results instead of rejecting.
async function runLimited(items, worker, options = {}) {
  const list = Array.from(items || []);
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(Number(options.concurrency) || DEFAULT_CONCURRENCY)));
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const sleepImpl = options.sleepImpl || sleep;
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;

  const results = new Array(list.length);
  let next = 0;
  let completed = 0;
  let stopped = false;

  async function lane() {
    while (next < list.length) {
      if (stopped || shouldStop()) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      let result;
      try {
        result = await worker(list[index], index);
      } catch (error) {
        result = failedResult(String(error?.message || error || 'Error'));
      }
      results[index] = result;
      completed += 1;
      try {
        onResult?.(result, list[index], { completed, total: list.length, index });
      } catch {
        // progress display errors must not stop looting
      }
      if (delayMs && next < list.length) await sleepImpl(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane));
  return { results, completed, stopped: stopped && completed < list.length };
}

// Decides when "stop on level up" fires. Without a known EXP requirement it
// relies on explicit server signals and NEVER stops just because the
// requirement is unknown (veyra-hud compared exp >= null, which is true, and
// stopped after the first monster).
function createLevelUpTracker({ expToLevel = null, startLevel = null } = {}) {
  const required = Number.isFinite(expToLevel) && expToLevel !== null && expToLevel > 0 ? expToLevel : null;
  const state = {
    required,
    startLevel: Number.isFinite(startLevel) ? startLevel : null,
    gainedExp: 0,
    reached: false,
    level: null,
  };
  return {
    state,
    get reached() {
      return state.reached;
    },
    get knowsRequirement() {
      return state.required !== null;
    },
    // Feed every loot result; returns true once a level up is detected.
    add(result) {
      if (!result?.ok) return state.reached;
      state.gainedExp += Number(result.exp) || 0;
      if (result.levelUp) state.reached = true;
      if (result.level !== null && result.level !== undefined && state.startLevel !== null && result.level > state.startLevel) {
        state.reached = true;
        state.level = result.level;
      }
      if (state.required !== null && state.gainedExp >= state.required) state.reached = true;
      return state.reached;
    },
    // A freshly read player level (e.g. from a reloaded page).
    observeLevel(level) {
      if (Number.isFinite(level) && state.startLevel !== null && level > state.startLevel) {
        state.reached = true;
        state.level = level;
      }
      return state.reached;
    },
  };
}

module.exports = {
  DEFAULT_CONCURRENCY,
  LOOTING_BLACKLIST,
  addLootResult,
  createLevelUpTracker,
  createLootTotals,
  dedupeItems,
  extractItems,
  extractShadow,
  isBlacklistedBoss,
  itemQuantity,
  lootDungeonLocation,
  lootMonster,
  normalizeMonsterName,
  parseBulkLootResponse,
  parseJsonText,
  parseLootResponse,
  parsePositiveQuantity,
  runLimited,
  summarizeNotes,
  totalItemUnits,
  validId,
};
