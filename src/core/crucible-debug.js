'use strict';

const CRUCIBLE_DEBUG_LOG_KEY = 'veyra:crucible:debug-log:v1';
const CONFIG_KEY = 'veyra:orchestrator:config:v1';
const LOG_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_DETAILS_LENGTH = 6_000;
const MAX_STRING_LENGTH = 1_000;
const MAX_ARRAY_LENGTH = 30;
const REDACTED_KEY = /(?:csrf|token|password|passwd|secret|authorization|cookie|session)/i;

function debugEnabled(store) {
  try {
    return store?.read?.(CONFIG_KEY)?.routes?.crucible?.settings?.debugLogging === true;
  } catch {
    return false;
  }
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value ?? null;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (depth >= 5) return '[depth limit]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitize(entry, depth + 1, seen));
    if (value.length > MAX_ARRAY_LENGTH) result.push(`[${value.length - MAX_ARRAY_LENGTH} more]`);
    return result;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 60)) {
    result[key] = REDACTED_KEY.test(key) ? '[redacted]' : sanitize(entry, depth + 1, seen);
  }
  return result;
}

function boundedDetails(value) {
  const result = sanitize(value);
  let encoded = '';
  try {
    encoded = JSON.stringify(result);
  } catch {
    return { truncated: true, preview: '[unserializable diagnostic details]' };
  }
  if (encoded.length <= MAX_DETAILS_LENGTH) return result;
  return {
    truncated: true,
    originalLength: encoded.length,
    preview: `${encoded.slice(0, MAX_DETAILS_LENGTH)}…`,
  };
}

function normalizeLog(value) {
  const entries = [];
  for (const raw of Array.isArray(value?.entries) ? value.entries.slice(-MAX_ENTRIES) : []) {
    const at = Number(raw?.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    entries.push({
      at,
      source: String(raw?.source || 'crucible').slice(0, 60),
      event: String(raw?.event || 'event').slice(0, 120),
      details: boundedDetails(raw?.details),
    });
  }
  return { version: LOG_VERSION, entries };
}

function readCrucibleDebugLog(store) {
  try {
    return normalizeLog(store?.read?.(CRUCIBLE_DEBUG_LOG_KEY));
  } catch {
    return normalizeLog(null);
  }
}

function appendCrucibleDebugLog(store, source, event, details = null, now = Date.now()) {
  if (!debugEnabled(store)) return false;
  try {
    const log = readCrucibleDebugLog(store);
    log.entries.push({
      at: Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now(),
      source: String(source || 'crucible').slice(0, 60),
      event: String(event || 'event').slice(0, 120),
      details: boundedDetails(details),
    });
    if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
    return store?.write?.(CRUCIBLE_DEBUG_LOG_KEY, log) !== false;
  } catch {
    return false;
  }
}

function clearCrucibleDebugLog(store) {
  try {
    if (typeof store?.remove === 'function') return store.remove(CRUCIBLE_DEBUG_LOG_KEY) !== false;
    return store?.write?.(CRUCIBLE_DEBUG_LOG_KEY, normalizeLog(null)) !== false;
  } catch {
    return false;
  }
}

function formatCrucibleDebugLog(value) {
  const log = value?.entries ? normalizeLog(value) : normalizeLog(null);
  if (log.entries.length === 0) return 'No Crucible diagnostic entries recorded.';
  return log.entries
    .map((entry) => {
      let timestamp = String(entry.at);
      try {
        timestamp = new Date(entry.at).toISOString();
      } catch {
        // Numeric timestamp remains readable.
      }
      const details = entry.details === null ? '' : ` ${JSON.stringify(entry.details)}`;
      return `[${timestamp}] [${entry.source}] ${entry.event}${details}`;
    })
    .join('\n');
}

function summarizeResponse(response) {
  const json = response?.json && typeof response.json === 'object' ? response.json : null;
  const state = json?.state && typeof json.state === 'object' ? json.state : null;
  return sanitize({
    ok: response?.ok,
    status: response?.status,
    text: String(response?.text || '').slice(0, 500),
    json: json
      ? {
          ok: json.ok,
          success: json.success,
          status: json.status,
          message: json.message,
          error: json.error,
          redirect: json.redirect,
          room_status: json.room_status,
          room_joined: json.room_joined,
          match: json.match,
          battle: state?.battle,
          viewer: state?.viewer,
          captainCount: Array.isArray(state?.captains) ? state.captains.length : undefined,
          engagementCount: Array.isArray(state?.engagements) ? state.engagements.length : undefined,
          keys: Object.keys(json).slice(0, 40),
        }
      : null,
  });
}

module.exports = {
  CRUCIBLE_DEBUG_LOG_KEY,
  MAX_ENTRIES,
  MAX_DETAILS_LENGTH,
  appendCrucibleDebugLog,
  clearCrucibleDebugLog,
  debugEnabled,
  formatCrucibleDebugLog,
  readCrucibleDebugLog,
  sanitize,
  summarizeResponse,
};
