'use strict';

// Shared localStorage protocol between the scheduler and page workers.
// The keys are unchanged from veyra_meta_scheduler.js so existing workers
// (wave_3_boss_manager.js, activate_auto_battle_target.js) keep working.

const { finiteTimestamp } = require('./numbers');

const PROTOCOL_VERSION = 1;
const COMMAND_KEY = 'veyra:orchestrator:command:v1';
const STATUS_KEY_PREFIX = 'veyra:worker:';
const STATUS_KEY_SUFFIX = ':status:v1';
const STATUS_FRESH_MS = 15_000;
const WORKER_STATES = Object.freeze(['idle', 'ready', 'busy', 'working', 'done', 'error']);

function workerStatusKey(routeId) {
  return `${STATUS_KEY_PREFIX}${routeId}${STATUS_KEY_SUFFIX}`;
}

function normalizeVisit(value, isKnownTask = () => true) {
  if (!value || typeof value !== 'object') return null;

  const visitId = String(value.visitId || '').trim();
  const taskId = String(value.taskId || '').trim();
  const phase = value.phase === 'running' ? 'running' : value.phase === 'draining' ? 'draining' : '';
  const returnPath = String(value.returnPath || '').trim();
  const issuedAt = finiteTimestamp(value.issuedAt, -1);
  const deadlineAt = finiteTimestamp(value.deadlineAt, -1);

  if (
    !visitId ||
    !taskId ||
    !isKnownTask(taskId) ||
    !phase ||
    !returnPath.startsWith('/') ||
    issuedAt < 0 ||
    deadlineAt < issuedAt
  ) {
    return null;
  }

  return { version: PROTOCOL_VERSION, visitId, taskId, phase, returnPath, issuedAt, deadlineAt };
}

function normalizeWorkerStatus(value) {
  if (!value || typeof value !== 'object') return null;

  const state = String(value.state || '').trim().toLowerCase();
  const updatedAt = finiteTimestamp(value.updatedAt, -1);
  if (updatedAt < 0 || !WORKER_STATES.includes(state)) return null;

  return {
    version: PROTOCOL_VERSION,
    visitId: String(value.visitId || '').trim(),
    workerId: String(value.workerId || '').trim(),
    state,
    safeToLeave: value.safeToLeave === true,
    updatedAt,
    message: String(value.message || ''),
    // Optional with done/error: when the page should be visited next
    // (instead of the loop length) and a short reason for the menu.
    retryAt: finiteTimestamp(value.retryAt, 0),
    note: String(value.note || '').slice(0, 60),
  };
}

function isFreshWorkerStatus(status, now = Date.now(), freshnessMs = STATUS_FRESH_MS) {
  const normalized = normalizeWorkerStatus(status);
  if (!normalized) return false;
  return normalized.updatedAt <= now + 5_000 && now - normalized.updatedAt <= freshnessMs;
}

function isFreshMatchingStatus(status, visit, now = Date.now(), freshnessMs = STATUS_FRESH_MS) {
  const normalized = normalizeWorkerStatus(status);
  return Boolean(
    normalized &&
      visit &&
      normalized.visitId === visit.visitId &&
      isFreshWorkerStatus(normalized, now, freshnessMs),
  );
}

function isSettledSafeStatus(status) {
  return Boolean(
    status?.safeToLeave === true && ['idle', 'ready', 'done', 'error'].includes(status.state),
  );
}

// Worker side: publishes a heartbeat the scheduler can read.
function publishWorkerStatus(store, routeId, fields, now = Date.now()) {
  const status = normalizeWorkerStatus({ ...fields, updatedAt: now });
  if (!status) return null;
  store.write(workerStatusKey(routeId), status);
  return status;
}

module.exports = {
  COMMAND_KEY,
  PROTOCOL_VERSION,
  STATUS_FRESH_MS,
  WORKER_STATES,
  isFreshMatchingStatus,
  isFreshWorkerStatus,
  isSettledSafeStatus,
  normalizeVisit,
  normalizeWorkerStatus,
  publishWorkerStatus,
  workerStatusKey,
};
