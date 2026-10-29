'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatGameNumber,
  normalizeDamageTarget,
  parseFraction,
  parseGameNumber,
} = require('../src/core/numbers');
const { formatCountdown, parseClockDuration } = require('../src/core/time');
const { computeBackoffMs, parseRetryAfter, postForm } = require('../src/core/http');
const {
  endpointForItem,
  normalizePotionSettings,
  pickPotion,
  usePotion,
} = require('../src/core/potions');
const { createJsonStore } = require('../src/core/storage');
const { isFreshWorkerStatus, publishWorkerStatus, workerStatusKey } = require('../src/core/protocol');

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function fakeResponse(status, text, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => text,
  };
}

test('parseGameNumber understands suffixes and thousands separators', () => {
  assert.equal(parseGameNumber('3M'), 3_000_000);
  assert.equal(parseGameNumber('3b'), 3_000_000_000);
  assert.equal(parseGameNumber('1.5k'), 1_500);
  assert.equal(parseGameNumber('2,5m'), 2_500_000);
  assert.equal(parseGameNumber('3,247,818,809'), 3_247_818_809);
  assert.equal(parseGameNumber(' 12 000 '), 12_000);
  assert.equal(parseGameNumber('0'), 0);
  assert.equal(parseGameNumber('abc'), null);
  assert.equal(parseGameNumber(''), null);
});

test('normalizeDamageTarget keeps valid input and falls back otherwise', () => {
  assert.equal(normalizeDamageTarget(' 500 M '), '500m');
  assert.equal(normalizeDamageTarget('0', '2b'), '2b');
  assert.equal(normalizeDamageTarget('nonsense', 'also bad'), '3b');
});

test('formatGameNumber and parseFraction', () => {
  assert.equal(formatGameNumber(3_000_000_000), '3b');
  assert.equal(formatGameNumber(1_250_000), '1.25m');
  assert.equal(formatGameNumber(999), '999');
  assert.deepEqual(parseFraction('3,775 / 12,000'), { current: 3_775, max: 12_000 });
  assert.equal(parseFraction('no fraction'), null);
});

test('countdown and clock parsing are in English', () => {
  assert.equal(formatCountdown(1_000, 5_000), 'Due now');
  assert.equal(formatCountdown(65_000, 0), 'In 01:05');
  assert.equal(formatCountdown(3_600_000 + 1_000, 0), 'In 01:00:01');
  assert.equal(parseClockDuration('for about 01:59:55 more'), 7_195_000);
  assert.equal(parseClockDuration('04:20'), 260_000);
  assert.equal(parseClockDuration('soon'), null);
});

test('retry helpers', () => {
  assert.equal(parseRetryAfter('3'), 3_000);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(computeBackoffMs(0), 800);
  assert.equal(computeBackoffMs(10), 20_000);
});

test('postForm sends url-encoded data and waits out rate limits', async () => {
  const calls = [];
  const waits = [];
  const responses = [fakeResponse(429, 'slow down', { 'Retry-After': '2' }), fakeResponse(200, '{"status":"success"}')];
  const result = await postForm(
    'damage.php',
    { monster_id: 5, skill_id: 0, skipped: undefined },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
      },
      sleepImpl: async (ms) => waits.push(ms),
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'monster_id=5&skill_id=0');
  assert.deepEqual(waits, [2_000]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { status: 'success' });
});

test('postForm gives up after maxRetries and returns the last response', async () => {
  const result = await postForm('x.php', {}, {
    maxRetries: 1,
    fetchImpl: async () => fakeResponse(429, 'nope'),
    sleepImpl: async () => {},
  });
  assert.equal(result.status, 429);
  assert.equal(result.ok, false);
});

test('potion settings keep only known items of the right type in priority order', () => {
  assert.deepEqual(normalizePotionSettings({ stamina: [35, 30, 108, 999, '251'], heal: [108, 30] }), {
    stamina: [30, 251, 35],
    heal: [108],
  });
  assert.deepEqual(normalizePotionSettings(null), { stamina: [], heal: [] });
});

test('pickPotion uses the first selected potion in stock', () => {
  const inventory = [
    { invId: '1', itemId: 30, quantity: 0 },
    { invId: '2', itemId: 251, quantity: 4 },
    { invId: '3', itemId: 35, quantity: 1 },
  ];
  assert.equal(pickPotion(inventory, [30, 251, 35]).invId, '2');
  assert.equal(pickPotion(inventory, [30]), null);
});

test('usePotion posts to the right endpoint and checks for success', async () => {
  assert.equal(endpointForItem(108), 'user_heal_potion.php');
  assert.equal(endpointForItem(30), 'use_item.php');

  const posted = [];
  const result = await usePotion(
    { invId: '77', itemId: 30 },
    {
      quantity: 3,
      post: async (url, params) => {
        posted.push({ url, params });
        return { ok: true, text: 'Success! Used.' };
      },
    },
  );
  assert.deepEqual(posted, [{ url: 'use_item.php', params: { inv_id: '77', qty: 3 } }]);
  assert.equal(result.ok, true);
});

test('json store survives broken storage and bad JSON', () => {
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {},
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const store = createJsonStore(broken);
    assert.equal(store.read('a'), null);
    assert.equal(store.write('a', 1), false);
  } finally {
    console.warn = originalWarn;
  }

  const storage = createStorage();
  storage.setItem('bad', '{');
  const store = createJsonStore(storage);
  console.warn = () => {};
  try {
    assert.equal(store.read('bad'), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(createJsonStore(null).available, false);
});

test('workers publish heartbeats under the shared protocol key', () => {
  const store = createJsonStore(createStorage());
  const status = publishWorkerStatus(store, 'wave3', { visitId: 'v1', state: 'busy', safeToLeave: false }, 1_000);
  assert.equal(status.state, 'busy');
  assert.deepEqual(store.read(workerStatusKey('wave3')), status);
  assert.equal(isFreshWorkerStatus(status, 10_000), true);
  assert.equal(isFreshWorkerStatus(status, 20_000), false);
  assert.equal(publishWorkerStatus(store, 'wave3', { state: 'unknown' }), null);
});
