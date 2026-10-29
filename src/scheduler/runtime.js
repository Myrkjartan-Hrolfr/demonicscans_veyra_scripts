'use strict';

const { finiteTimestamp } = require('../core/numbers');
const protocol = require('../core/protocol');
const { ROUTE_IDS, ROUTE_LIST, getRoute } = require('../routes');
const { loopIntervalMs, normalizeConfig } = require('./config');

const RUNTIME_KEY = 'veyra:orchestrator:runtime:v1';
const { PROTOCOL_VERSION } = protocol;

function normalizeVisit(value) {
  return protocol.normalizeVisit(value, (taskId) => Boolean(getRoute(taskId)));
}

function createDefaultRuntime(now = Date.now()) {
  const nextRunAt = {};
  for (const route of ROUTE_LIST) nextRunAt[route.id] = now + route.initialDelayMs;

  return {
    version: PROTOCOL_VERSION,
    nextRunAt,
    notes: {},
    activeVisit: null,
    lastResult: null,
  };
}

const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

function normalizeNotes(value) {
  const notes = {};
  for (const route of ROUTE_LIST) {
    const note = String(value?.[route.id] || '').slice(0, 60);
    if (note) notes[route.id] = note;
  }
  return notes;
}

function normalizeRuntime(value, now = Date.now()) {
  const defaults = createDefaultRuntime(now);
  if (!value || typeof value !== 'object' || value.version !== PROTOCOL_VERSION) return defaults;

  const nextRunAt = {};
  for (const route of ROUTE_LIST) {
    nextRunAt[route.id] = finiteTimestamp(value.nextRunAt?.[route.id], defaults.nextRunAt[route.id]);
  }

  const lastResult =
    value.lastResult && typeof value.lastResult === 'object'
      ? {
          taskId: getRoute(value.lastResult.taskId) ? value.lastResult.taskId : '',
          state: String(value.lastResult.state || ''),
          finishedAt: finiteTimestamp(value.lastResult.finishedAt, 0),
        }
      : null;

  return {
    version: PROTOCOL_VERSION,
    nextRunAt,
    notes: normalizeNotes(value.notes),
    activeVisit: normalizeVisit(value.activeVisit),
    lastResult,
  };
}

function toUrl(value, base) {
  try {
    return value instanceof URL ? value : new URL(String(value || '/'), base);
  } catch {
    return null;
  }
}

function routeIdForUrl(value, base = 'https://demonicscans.org') {
  const url = toUrl(value, base);
  if (!url) return null;
  return ROUTE_LIST.find((route) => route.matchesUrl(url))?.id || null;
}

function isUrlWithinVisit(taskId, value, visitId, base = 'https://demonicscans.org') {
  const route = getRoute(taskId);
  const url = toUrl(value, base);
  if (!route || !url) return false;

  if (routeIdForUrl(url) === taskId) return true;
  return Boolean(
    visitId &&
      route.visitPathnames?.includes(url.pathname) &&
      url.searchParams.get('veyra_visit') === visitId,
  );
}

function chooseDueRoute(runtime, now = Date.now(), config = null) {
  if (!runtime || runtime.activeVisit) return null;
  const normalizedConfig = normalizeConfig(config);

  return (
    ROUTE_LIST.filter(
      (route) =>
        normalizedConfig.routes[route.id]?.enabled !== false &&
        finiteTimestamp(runtime.nextRunAt?.[route.id], Number.POSITIVE_INFINITY) <= now,
    ).sort((left, right) => {
      const dueDifference = runtime.nextRunAt[left.id] - runtime.nextRunAt[right.id];
      return dueDifference || ROUTE_IDS.indexOf(left.id) - ROUTE_IDS.indexOf(right.id);
    })[0] || null
  );
}

// hint: { retryAt, note } from the worker. A future retryAt replaces the loop
// length for this one countdown, e.g. "come back when stamina has refilled".
function completeRuntimeVisit(runtime, outcome, now = Date.now(), config = null, hint = null) {
  const visit = normalizeVisit(runtime?.activeVisit);
  const next = normalizeRuntime(runtime, now);
  if (!visit) return next;

  const retryAt = finiteTimestamp(hint?.retryAt, 0);
  if (retryAt > now) {
    next.nextRunAt[visit.taskId] = Math.min(retryAt, now + MAX_RETRY_DELAY_MS);
    next.notes[visit.taskId] = String(hint?.note || '').slice(0, 60);
    if (!next.notes[visit.taskId]) delete next.notes[visit.taskId];
  } else {
    next.nextRunAt[visit.taskId] = now + loopIntervalMs(normalizeConfig(config), visit.taskId);
    delete next.notes[visit.taskId];
  }
  next.activeVisit = null;
  next.lastResult = {
    taskId: visit.taskId,
    state: outcome === 'done' ? 'done' : 'error',
    finishedAt: now,
  };
  return next;
}

// A shorter loop length should take effect right away instead of waiting
// for the old, longer countdown to run out.
function applyLoopChange(runtime, routeId, intervalMs, now = Date.now()) {
  const next = normalizeRuntime(runtime, now);
  if (!getRoute(routeId)) return next;
  next.nextRunAt[routeId] = Math.min(next.nextRunAt[routeId], now + intervalMs);
  return next;
}

module.exports = {
  RUNTIME_KEY,
  applyLoopChange,
  chooseDueRoute,
  completeRuntimeVisit,
  createDefaultRuntime,
  isUrlWithinVisit,
  normalizeRuntime,
  normalizeVisit,
  routeIdForUrl,
};
