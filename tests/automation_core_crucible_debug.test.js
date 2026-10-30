'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CRUCIBLE_DEBUG_LOG_KEY,
  MAX_DETAILS_LENGTH,
  MAX_ENTRIES,
  appendCrucibleDebugLog,
  clearCrucibleDebugLog,
  formatCrucibleDebugLog,
  readCrucibleDebugLog,
} = require('../src/core/crucible-debug');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');

function createStore(config) {
  const values = new Map([[CONFIG_KEY, structuredClone(config)]]);
  return {
    read(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    write(key, value) { values.set(key, structuredClone(value)); return true; },
    remove(key) { values.delete(key); return true; },
  };
}

test('Crucible diagnostics are opt-in, bounded and redact sensitive fields', () => {
  const config = createDefaultConfig();
  const store = createStore(config);
  assert.equal(appendCrucibleDebugLog(store, 'worker', 'ignored', { value: 1 }, 1000), false);
  assert.equal(store.read(CRUCIBLE_DEBUG_LOG_KEY), null);

  config.routes.crucible.settings.debugLogging = true;
  store.write(CONFIG_KEY, config);
  for (let index = 0; index < MAX_ENTRIES + 10; index += 1) {
    appendCrucibleDebugLog(store, 'worker', `event ${index}`, {
      csrf: 'must-not-leak',
      nested: { authorization: 'also-secret', safe: index },
    }, 1_000 + index);
  }

  const log = readCrucibleDebugLog(store);
  assert.equal(log.entries.length, MAX_ENTRIES);
  assert.equal(log.entries[0].event, 'event 10');
  assert.equal(log.entries.at(-1).details.csrf, '[redacted]');
  assert.equal(log.entries.at(-1).details.nested.authorization, '[redacted]');
  const formatted = formatCrucibleDebugLog(log);
  assert.match(formatted, /\[worker\] event 509/);
  assert.doesNotMatch(formatted, /must-not-leak|also-secret/);

  appendCrucibleDebugLog(
    store,
    'worker',
    'large state',
    Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'x'.repeat(1000)])),
    2000,
  );
  const large = readCrucibleDebugLog(store).entries.at(-1).details;
  assert.equal(large.truncated, true);
  assert.ok(large.preview.length <= MAX_DETAILS_LENGTH + 1);

  assert.equal(clearCrucibleDebugLog(store), true);
  assert.equal(readCrucibleDebugLog(store).entries.length, 0);
});
