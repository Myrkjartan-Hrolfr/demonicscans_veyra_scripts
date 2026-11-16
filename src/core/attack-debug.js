'use strict';

const { sanitize } = require('./crucible-debug');

const ATTACK_DEBUG_LOG_KEY = 'veyra:attack:debug-log:v1';
const MAX_ENTRIES = 500;

function normalize(value) {
  const entries = [];
  for (const raw of Array.isArray(value?.entries) ? value.entries.slice(-MAX_ENTRIES) : []) {
    const at = Number(raw?.at);
    if (!Number.isFinite(at)) continue;
    entries.push({
      at,
      source: String(raw?.source || 'attack').slice(0, 60),
      event: String(raw?.event || 'event').slice(0, 140),
      details: sanitize(raw?.details),
    });
  }
  return { version: 1, entries };
}

function readAttackDebugLog(store) {
  try {
    return normalize(store?.read?.(ATTACK_DEBUG_LOG_KEY));
  } catch {
    return normalize(null);
  }
}

function appendAttackDebugLog(store, source, event, details = null, now = Date.now()) {
  try {
    const log = readAttackDebugLog(store);
    log.entries.push({ at: Number(now) || Date.now(), source, event, details: sanitize(details) });
    if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
    return store?.write?.(ATTACK_DEBUG_LOG_KEY, log) !== false;
  } catch {
    return false;
  }
}

function clearAttackDebugLog(store) {
  try {
    store?.remove?.(ATTACK_DEBUG_LOG_KEY);
    return true;
  } catch {
    return false;
  }
}

function formatAttackDebugLog(value) {
  const log = normalize(value);
  if (!log.entries.length) return 'No attack diagnostic entries recorded.';
  return log.entries.map((entry) => {
    const details = entry.details == null ? '' : ` ${JSON.stringify(entry.details)}`;
    return `[${new Date(entry.at).toISOString()}] [${entry.source}] ${entry.event}${details}`;
  }).join('\n');
}

module.exports = {
  ATTACK_DEBUG_LOG_KEY,
  appendAttackDebugLog,
  clearAttackDebugLog,
  formatAttackDebugLog,
  readAttackDebugLog,
};
