'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMAND_KEY, STATUS_FRESH_MS, workerStatusKey } = require('../src/core/protocol');
const { createJsonStore } = require('../src/core/storage');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { createSchedulerEngine } = require('../src/scheduler/engine');
const { RUNTIME_KEY, createDefaultRuntime } = require('../src/scheduler/runtime');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function expiredVisit(now) {
  return {
    version: 1,
    visitId: 'expired-wave3-visit',
    taskId: 'wave3',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: now - 60_000,
    deadlineAt: now - 1,
  };
}

function createHarness(workerStatus) {
  const now = Date.now();
  const runtime = createDefaultRuntime(now);
  runtime.activeVisit = expiredVisit(now);

  const initial = {
    [CONFIG_KEY]: JSON.stringify(createDefaultConfig()),
    [RUNTIME_KEY]: JSON.stringify(runtime),
    [COMMAND_KEY]: JSON.stringify(runtime.activeVisit),
  };
  if (workerStatus) {
    initial[workerStatusKey('wave3')] = JSON.stringify({
      version: 1,
      visitId: runtime.activeVisit.visitId,
      workerId: 'wave3',
      state: 'busy',
      safeToLeave: false,
      ...workerStatus,
    });
  }

  const store = createJsonStore(createStorage(initial));
  const navigations = [];
  const win = {
    location: {
      href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
      origin: 'https://demonicscans.org',
      replace: (url) => navigations.push(url),
    },
    setInterval: () => 1,
    clearInterval: () => {},
    crypto: { randomUUID: () => 'scheduler-timeout-test' },
  };
  const engine = createSchedulerEngine({
    win,
    store,
    sessionStore: createJsonStore(createStorage()),
    ui: { setStatus: () => {}, update: () => {} },
  });

  return { engine, navigations, now, store };
}

function assertTimedOut({ navigations, store }) {
  const runtime = store.read(RUNTIME_KEY);
  assert.equal(runtime.activeVisit, null);
  assert.equal(runtime.lastResult.state, 'error');
  assert.equal(store.read(COMMAND_KEY), null);
  assert.deepEqual(navigations, ['https://demonicscans.org/pvp.php']);
}

test('an expired running visit without a worker heartbeat fails and returns home', () => {
  const harness = createHarness();

  harness.engine.start();

  assertTimedOut(harness);
});

test('an expired running visit with a stale worker heartbeat fails and returns home', () => {
  const harness = createHarness({ updatedAt: Date.now() - STATUS_FRESH_MS - 1_000 });

  harness.engine.start();

  assertTimedOut(harness);
});

test('an expired running visit keeps draining while its worker heartbeat is fresh and unsafe', () => {
  const harness = createHarness({ updatedAt: Date.now() });

  harness.engine.start();

  assert.equal(harness.store.read(RUNTIME_KEY).activeVisit.visitId, 'expired-wave3-visit');
  assert.equal(harness.store.read(COMMAND_KEY).phase, 'draining');
  assert.deepEqual(harness.navigations, []);
});
