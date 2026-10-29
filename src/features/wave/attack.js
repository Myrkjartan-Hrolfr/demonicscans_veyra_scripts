'use strict';

// Join / attack logic of veyra-hud's "Strategic Attack", kept free of DOM
// access so the automation can reuse it. Every network call goes through an
// injected postForm (core/http.js signature: postForm(url, params) →
// { ok, status, text, json }), which already waits out HTTP 429/503.

const { computeBackoffMs } = require('../../core/http');
const { parseGameNumber } = require('../../core/numbers');
const { sleep: defaultSleep } = require('../../core/time');
const { staminaCost } = require('../shared/asterion');

const DEFAULT_JOIN_URL = 'user_join_battle.php';
const DEFAULT_ATTACK_URL = 'damage.php';
const DEFAULT_WAIT_BUFFER_MS = 1050;
const MIN_WAIT_BUFFER_MS = 100;
const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;
const INVALID_REQUEST_RETRY_MS = 350;

// Skill names are the values veyra-hud stored in ui-improvements:attackStrategy.
const SKILLS = Object.freeze({
  slash: Object.freeze({ name: 'slash', id: 0, cost: 1 }),
  'power slash': Object.freeze({ name: 'power slash', id: -1, cost: 10 }),
  'heroic slash': Object.freeze({ name: 'heroic slash', id: -2, cost: 50 }),
  'ultimate slash': Object.freeze({ name: 'ultimate slash', id: -3, cost: 100 }),
  'legendary slash': Object.freeze({ name: 'legendary slash', id: -4, cost: 200 }),
});

const SKILL_NAMES = Object.freeze(Object.keys(SKILLS));

function getSkill(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return Object.prototype.hasOwnProperty.call(SKILLS, key) ? SKILLS[key] : null;
}

// Accepts the stored value (array, or a JSON string of one) and keeps the
// known skill names in order.
function normalizeStrategy(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map(getSkill).filter(Boolean).map((skill) => skill.name);
}

// Total stamina of a strategy; each attack is rounded up separately, like
// the game does with the Asterion multiplier.
function strategyCost(strategy, multiplier = 1) {
  return normalizeStrategy(strategy).reduce(
    (total, name) => total + staminaCost(SKILLS[name].cost, multiplier),
    0,
  );
}

function normalizeWaitBuffer(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_WAIT_BUFFER_MS;
  return Math.max(MIN_WAIT_BUFFER_MS, number);
}

// The game sometimes prefixes JSON with a BOM or PHP notices.
function parseJsonLoose(text) {
  const raw = String(text ?? '');
  const trimmed = raw.replace(/^﻿/, '').trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Same success rules as the game's own normalizeOk().
function normalizeResponse(response) {
  const raw = String(response?.text ?? '');
  const data =
    response?.json && typeof response.json === 'object' ? response.json : parseJsonLoose(raw) || {};
  const ok =
    data.status === 'success' ||
    data.ok === true ||
    data.success === true ||
    /^\s*success\s*$/i.test(raw) ||
    /joined|already joined/i.test(raw);
  const message =
    typeof data.message === 'string' && data.message.trim()
      ? data.message
      : typeof data.error === 'string' && data.error.trim()
        ? data.error
        : raw.trim() || (ok ? 'OK' : 'Failed');
  return { ok, msg: message, data, raw, status: Number(response?.status) || 0 };
}

const RATE_LIMIT_PATTERN =
  /rate[\s_-]?limit|too fast|too many requests|throttl|slow down|too quickly|wait (?:\d+|a few)|try again in|cooling down|not ready|please wait/i;

function isRateLimited(result) {
  if (!result || result.ok) return false;
  if (result.status === 429 || result.status === 503) return true;
  const data = result.data && typeof result.data === 'object' ? JSON.stringify(result.data) : '';
  return RATE_LIMIT_PATTERN.test(`${result.msg || ''} ${result.raw || ''} ${data}`);
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const DAMAGE_FIELDS = Object.freeze(['damage', 'dmg', 'damage_dealt', 'total_damage', 'totalDamage']);

// Damage of one attack: a numeric JSON field, the <strong>N</strong> in the
// message (what veyra-hud read) or "dealt N damage" text. 0 when unknown.
function parseDamage(result) {
  const data = result?.data && typeof result.data === 'object' ? result.data : {};
  for (const field of DAMAGE_FIELDS) {
    const value = data[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string') {
      const parsed = parseGameNumber(value);
      if (parsed !== null) return parsed;
    }
  }
  const message = String(result?.msg ?? '');
  const strong = message.match(/<strong>\s*([\d.,]+[kmbtq]?)\s*<\/strong>/i);
  if (strong) return parseGameNumber(strong[1]) ?? 0;
  const dealt = stripTags(message).match(/dealt\s+([\d.,]*\d[kmbtq]?)\b/i);
  if (dealt) return parseGameNumber(dealt[1]) ?? 0;
  return 0;
}

async function joinMonster({ postForm, joinUrl = DEFAULT_JOIN_URL, monsterId, userId }) {
  if (!joinUrl) return { ok: false, msg: 'Join endpoint not set' };
  if (!userId) return { ok: false, msg: 'Missing user id' };
  try {
    return normalizeResponse(await postForm(joinUrl, { monster_id: monsterId, user_id: userId }));
  } catch {
    return { ok: false, msg: 'Join request failed' };
  }
}

// One attack. Like the game, an "Invalid request." answer is retried once.
async function attackMonster({
  postForm,
  attackUrl = DEFAULT_ATTACK_URL,
  monsterId,
  skill,
  sleep = defaultSleep,
}) {
  if (!attackUrl) return { ok: false, msg: 'Attack endpoint not set', status: 0 };
  const params = { monster_id: monsterId, skill_id: skill.id, stamina_cost: skill.cost };
  let result = normalizeResponse(await postForm(attackUrl, params));
  if (!result.ok && result.data?.message === 'Invalid request.') {
    await sleep(INVALID_REQUEST_RETRY_MS);
    result = normalizeResponse(await postForm(attackUrl, params));
  }
  return result;
}

// Runs the skills of a strategy against one monster, in order. Stops on the
// first failed attack or once damageLimit (> 0) is reached. Between attacks
// it keeps at least waitBufferMs from the start of one attack (for the first
// one: startTime, i.e. the join) to the start of the next.
async function runStrategy({
  postForm,
  attackUrl = DEFAULT_ATTACK_URL,
  monsterId,
  strategy,
  waitBufferMs = DEFAULT_WAIT_BUFFER_MS,
  damageLimit = 0,
  startTime = null,
  sleep = defaultSleep,
  now = Date.now,
  maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES,
  onAttack = null,
}) {
  const buffer = normalizeWaitBuffer(waitBufferMs);
  const limit = Number(damageLimit) > 0 ? Number(damageLimit) : 0;
  const attacks = [];
  let totalDamage = 0;
  let limitReached = false;
  let pendingStart = startTime ?? now();

  const list = Array.isArray(strategy) ? strategy : normalizeStrategy(strategy);
  for (const skillName of list) {
    const skill = getSkill(skillName);
    if (!skill) {
      attacks.push({ skill: String(skillName), ok: false, msg: `Unknown skill: ${skillName}`, damage: 0 });
      continue;
    }
    if (limit && totalDamage >= limit) {
      limitReached = true;
      break;
    }

    let result = null;
    for (let attempt = 0; attempt < maxRateLimitRetries; attempt += 1) {
      const attackStart = attacks.length === 0 && attempt === 0 ? pendingStart : now();
      try {
        result = await attackMonster({ postForm, attackUrl, monsterId, skill, sleep });
      } catch {
        result = { ok: false, msg: `Attack request failed (${skill.name})`, failed: true };
      }
      if (!result.failed && isRateLimited(result) && attempt < maxRateLimitRetries - 1) {
        const retryAfter = Number(result.retryAfterMs);
        await sleep(
          retryAfter > 0 ? Math.min(retryAfter, MAX_RATE_LIMIT_WAIT_MS) : computeBackoffMs(attempt),
        );
        continue;
      }
      const remaining = buffer - (now() - attackStart);
      if (remaining > 0) await sleep(remaining);
      break;
    }

    const damage = result.ok ? parseDamage(result) : 0;
    totalDamage += damage;
    const message = result.msg || (result.ok ? `Attacked with ${skill.name}` : `Attack failed with ${skill.name}`);
    const entry = { skill: skill.name, ok: Boolean(result.ok), msg: message, damage };
    attacks.push(entry);
    onAttack?.(entry, { monsterId, totalDamage });
    if (!result.ok) break;
  }

  return {
    ok: attacks.length > 0 && attacks.every((attack) => attack.ok),
    attacks,
    totalDamage,
    limitReached,
  };
}

// Joins (when needed) and runs the strategy on each target, one after the
// other. targets: [{ monsterId, joined }].
async function runStrategicAttack({
  postForm,
  joinUrl = DEFAULT_JOIN_URL,
  attackUrl = DEFAULT_ATTACK_URL,
  userId,
  targets,
  strategy,
  waitBufferMs = DEFAULT_WAIT_BUFFER_MS,
  damageLimit = 0,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = null,
  onJoined = null,
  onAttack = null,
}) {
  const list = normalizeStrategy(strategy);
  const results = [];
  const all = Array.isArray(targets) ? targets : [];
  for (let index = 0; index < all.length; index += 1) {
    const target = all[index];
    const monsterId = target?.monsterId;
    onProgress?.({ index, total: all.length, monsterId });

    const startTime = now();
    let joinMsg = '';
    if (!target?.joined) {
      const join = await joinMonster({ postForm, joinUrl, monsterId, userId });
      joinMsg = join.msg || '';
      if (!join.ok) {
        results.push({ monsterId, ok: false, joinMsg, skipped: true, attacks: [], totalDamage: 0 });
        continue;
      }
      onJoined?.(monsterId);
    }

    const run = await runStrategy({
      postForm,
      attackUrl,
      monsterId,
      strategy: list,
      waitBufferMs,
      damageLimit,
      startTime,
      sleep,
      now,
      onAttack,
    });
    results.push({ monsterId, joinMsg, skipped: false, ...run });
  }
  return results;
}

function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const success = list.filter((result) => result.ok).length;
  return {
    processed: list.length,
    success,
    failed: list.length - success,
    totalDamage: list.reduce((sum, result) => sum + (Number(result.totalDamage) || 0), 0),
  };
}

module.exports = {
  DEFAULT_ATTACK_URL,
  DEFAULT_JOIN_URL,
  DEFAULT_WAIT_BUFFER_MS,
  MIN_WAIT_BUFFER_MS,
  SKILLS,
  SKILL_NAMES,
  attackMonster,
  getSkill,
  isRateLimited,
  joinMonster,
  normalizeResponse,
  normalizeStrategy,
  normalizeWaitBuffer,
  parseDamage,
  parseJsonLoose,
  runStrategicAttack,
  runStrategy,
  stripTags,
  strategyCost,
  summarizeResults,
};
