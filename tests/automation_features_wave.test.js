'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const attack = require('../src/features/wave/attack');
const filtering = require('../src/features/wave/filtering');
const page = require('../src/features/wave/page');
const strategic = require('../src/features/wave/strategic-attack');
const WAVE_FEATURES = require('../src/features/wave');
const { createSettingsStore } = require('../src/core/settings');
const { createJsonStore } = require('../src/core/storage');
const { createFeatureContext } = require('../src/features/runner');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function card({ id, name = 'mob', hp = null, dead = '0', joined = '0' }) {
  return {
    dataset: { monsterId: String(id), name, dead, joined },
    style: { display: '' },
    querySelector: (selector) =>
      selector === '.stat-icon.hp + .stat-main .stat-value' && hp !== null ? { textContent: hp } : null,
  };
}

// Records postForm calls and answers from a list (last answer repeats).
function stubPost(answers) {
  const calls = [];
  const post = async (url, params) => {
    calls.push({ url, params });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: true, status: 200, text, json };
  };
  post.calls = calls;
  return post;
}

function fakeClock() {
  let time = 1_000;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
    sleeps,
  };
}

// ------------------------------------------------------------- filtering

test('HP limits accept numbers and game text; empty max means no limit', () => {
  assert.equal(filtering.parseHpLimit(5), 5);
  assert.equal(filtering.parseHpLimit('1,000,000'), 1_000_000);
  assert.equal(filtering.parseHpLimit('1.5m'), 1_500_000);
  assert.equal(filtering.parseHpLimit(''), null);
  assert.equal(filtering.parseHpLimit('abc'), null);
  assert.equal(filtering.parseHpLimit(null), null);
  assert.deepEqual(filtering.normalizeHpRange('', ''), { min: 0, max: Infinity });
  assert.deepEqual(filtering.normalizeHpRange(10, 0), { min: 10, max: Infinity });
  assert.deepEqual(filtering.normalizeHpRange('1k', '2k'), { min: 1_000, max: 2_000 });
});

test('cards are filtered by current HP; unknown HP stays visible', () => {
  const range = filtering.normalizeHpRange(100, 1_000);
  assert.equal(filtering.hpInRange({ current: 50, max: 2_000 }, range), false);
  assert.equal(filtering.hpInRange({ current: 100, max: 2_000 }, range), true);
  assert.equal(filtering.hpInRange({ current: 1_001, max: 2_000 }, range), false);
  assert.equal(filtering.hpInRange(null, range), true);
  assert.equal(filtering.hpInRange({ current: 5e12, max: 5e12 }, filtering.normalizeHpRange(0, null)), true);
  assert.deepEqual(
    filtering.readCardHp(card({ id: 1, hp: '1,800,000,000,000 /\n   1,800,000,000,000 ' })),
    { current: 1.8e12, max: 1.8e12 },
  );
  assert.equal(filtering.readCardHp(card({ id: 1 })), null);
  assert.equal(filtering.readCardHp(null), null);
});

test('sortCardsByHp: lowest HP first, unknown then dead last, stable', () => {
  const cards = [
    card({ id: 1, hp: '500 / 1,000' }),
    card({ id: 2, hp: '0 / 1,000', dead: '1' }),
    card({ id: 3 }),
    card({ id: 4, hp: '100 / 1,000' }),
    card({ id: 5, hp: '500 / 2,000' }),
  ];
  assert.deepEqual(
    filtering.sortCardsByHp(cards).map((entry) => entry.dataset.monsterId),
    ['4', '1', '5', '3', '2'],
  );
});

test('groupCardsByName keeps first-appearance order and sorts by id unless told not to', () => {
  const cards = [
    card({ id: 30, name: 'b' }),
    card({ id: 20, name: 'a' }),
    card({ id: 10, name: 'b' }),
  ];
  const grouped = filtering.groupCardsByName(cards);
  assert.deepEqual([...grouped.keys()], ['b', 'a']);
  assert.deepEqual(grouped.get('b').map((entry) => entry.dataset.monsterId), ['10', '30']);
  const unsorted = filtering.groupCardsByName(cards, { sortById: false });
  assert.deepEqual(unsorted.get('b').map((entry) => entry.dataset.monsterId), ['30', '10']);
});

test('selectableCards skips dead and hidden cards', () => {
  const hidden = card({ id: 2 });
  hidden.style.display = 'none';
  const cards = [card({ id: 1 }), hidden, card({ id: 3, dead: '1' }), card({ id: 4 })];
  assert.deepEqual(filtering.selectableCards(cards).map((entry) => entry.dataset.monsterId), ['1', '4']);
});

function contextFor(feature, storage, extra = {}) {
  const store = createJsonStore(storage);
  return {
    ...createFeatureContext({
      feature,
      features: WAVE_FEATURES,
      win: {},
      doc: extra.doc || emptyDoc(),
      url: new URL('https://demonicscans.org/active_wave.php?gate=3&wave=3'),
      settings: createSettingsStore(store),
      store,
      getUserId: async () => 42,
    }),
    ...extra,
  };
}

test('Use Groups migrates from the misspelled veyra-hud key', () => {
  const storage = createStorage({ 'ui-imrovements:useGroupedMobs': 'true' });
  const ctx = contextFor(filtering.filterSortGroupFeature, storage);
  filtering.migrateGroupSetting(ctx);
  assert.equal(storage.getItem('ui-improvements:useGroupedMobs'), 'true');
  assert.equal(ctx.setting('ui-improvements:useGroupedMobs'), true);

  // An existing new value wins.
  const kept = createStorage({ 'ui-imrovements:useGroupedMobs': 'true', 'ui-improvements:useGroupedMobs': 'false' });
  const keptCtx = contextFor(filtering.filterSortGroupFeature, kept);
  filtering.migrateGroupSetting(keptCtx);
  assert.equal(keptCtx.setting('ui-improvements:useGroupedMobs'), false);
});

test('HP limits stored as text by veyra-hud are rewritten as numbers', () => {
  const storage = createStorage({
    'ui-improvements:minHpValue': '"1,000"',
    'ui-improvements:maxHpValue': '""',
  });
  const ctx = contextFor(filtering.filterSortGroupFeature, storage);
  assert.equal(filtering.readHpSetting(ctx, filtering.MIN_HP), 1_000);
  assert.equal(storage.getItem('ui-improvements:minHpValue'), '1000');
  assert.equal(filtering.readHpSetting(ctx, filtering.MAX_HP), null);

  const garbage = createStorage({ 'ui-improvements:maxHpValue': '"lots"' });
  const garbageCtx = contextFor(filtering.filterSortGroupFeature, garbage);
  assert.equal(filtering.readHpSetting(garbageCtx, filtering.MAX_HP), null);
  assert.equal(garbage.getItem('ui-improvements:maxHpValue'), 'null');
});

// ----------------------------------------------------------------- page

test('page helpers: low HP, joined count, heal result', () => {
  assert.equal(page.isLowHp(9.9), true);
  assert.equal(page.isLowHp(10), false);
  assert.equal(page.isLowHp(null), false);
  assert.equal(page.hpPercentFromWidth({ style: { width: '40.19%' } }), 40.19);
  assert.equal(page.hpPercentFromWidth(null), null);
  assert.equal(
    page.countJoinedAlive([
      card({ id: 1, joined: '1' }),
      card({ id: 2, joined: '1', dead: '1' }),
      card({ id: 3, joined: '0' }),
    ]),
    1,
  );
  assert.equal(page.healSucceeded({ json: { status: 'success' } }), true);
  assert.equal(page.healSucceeded({ json: { status: 'error' } }), false);
  assert.equal(page.healSucceeded({ json: null, text: 'success' }), true);
});

// --------------------------------------------------------------- attack

test('strategy normalization and stamina cost with Asterion', () => {
  assert.deepEqual(attack.normalizeStrategy(['Slash', 'POWER  slash', 'nope']), ['slash', 'power slash']);
  assert.deepEqual(attack.normalizeStrategy('["heroic slash"]'), ['heroic slash']);
  assert.deepEqual(attack.normalizeStrategy('not json'), []);
  assert.deepEqual(attack.normalizeStrategy(null), []);
  const all = attack.SKILL_NAMES;
  assert.equal(attack.strategyCost(all), 361);
  // Each attack is rounded up separately: ceil(1.5) + ceil(15) ...
  assert.equal(attack.strategyCost(['slash', 'slash'], 1.5), 4);
  assert.equal(attack.strategyCost(all, 1.5), 2 + 15 + 75 + 150 + 300);
  assert.deepEqual(
    all.map((name) => attack.SKILLS[name].id),
    [0, -1, -2, -3, -4],
  );
  assert.equal(attack.normalizeWaitBuffer(10), 100);
  assert.equal(attack.normalizeWaitBuffer('abc'), 1050);
});

test('responses are normalized like the game does', () => {
  const ok = attack.normalizeResponse({ status: 200, text: '﻿{"status":"success","message":"Hit"}' });
  assert.equal(ok.ok, true);
  assert.equal(ok.msg, 'Hit');
  assert.equal(attack.normalizeResponse({ text: 'You already joined' }).ok, true);
  const failed = attack.normalizeResponse({ text: '{"status":"error","error":"Nope"}' });
  assert.equal(failed.ok, false);
  assert.equal(failed.msg, 'Nope');
  assert.equal(attack.isRateLimited({ ok: false, msg: 'You are attacking too quickly' }), true);
  assert.equal(attack.isRateLimited({ ok: false, status: 429 }), true);
  assert.equal(attack.isRateLimited({ ok: false, msg: 'Not enough stamina' }), false);
  assert.equal(attack.isRateLimited({ ok: true, msg: 'please wait' }), false);
});

test('parseDamage reads JSON fields, <strong> numbers and "dealt" text', () => {
  assert.equal(attack.parseDamage({ data: { damage: 1234 } }), 1234);
  assert.equal(attack.parseDamage({ data: { dmg: '2.5m' } }), 2_500_000);
  assert.equal(attack.parseDamage({ msg: 'You hit for <strong>1,234,567</strong> damage!' }), 1_234_567);
  assert.equal(attack.parseDamage({ msg: 'You dealt 9,876 damage.' }), 9_876);
  assert.equal(attack.parseDamage({ msg: 'Missed' }), 0);
  assert.equal(attack.parseDamage(null), 0);
  assert.equal(attack.stripTags('A <strong>1</strong>&amp;<br>B'), 'A 1& B');
});

test('runStrategy attacks in order, waits the buffer and stops on failure', async () => {
  const clock = fakeClock();
  const post = stubPost([
    { status: 'success', message: 'dealt <strong>100</strong>' },
    { status: 'error', message: 'Not enough stamina' },
  ]);
  const result = await attack.runStrategy({
    postForm: post,
    monsterId: 7,
    strategy: ['slash', 'power slash', 'heroic slash'],
    waitBufferMs: 1050,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.deepEqual(
    post.calls.map((call) => call.params),
    [
      { monster_id: 7, skill_id: 0, stamina_cost: 1 },
      { monster_id: 7, skill_id: -1, stamina_cost: 10 },
    ],
  );
  assert.equal(post.calls[0].url, 'damage.php');
  assert.equal(result.ok, false);
  assert.equal(result.totalDamage, 100);
  assert.deepEqual(result.attacks.map((entry) => entry.ok), [true, false]);
  assert.deepEqual(clock.sleeps, [1050, 1050]);
});

test('runStrategy counts the join time against the first wait and honours the damage limit', async () => {
  const clock = fakeClock();
  const startTime = clock.now();
  clock.advance(400); // the join took 400 ms
  const post = stubPost([{ status: 'success', damage: 600 }]);
  const result = await attack.runStrategy({
    postForm: post,
    monsterId: 1,
    strategy: ['slash', 'slash', 'slash'],
    waitBufferMs: 1000,
    damageLimit: 1000,
    startTime,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(post.calls.length, 2);
  assert.equal(result.totalDamage, 1200);
  assert.equal(result.limitReached, true);
  assert.equal(result.ok, true);
  assert.deepEqual(clock.sleeps, [600, 1000]);
});

test('runStrategy retries text rate limits and "Invalid request."', async () => {
  const clock = fakeClock();
  const post = stubPost([
    { status: 'error', message: 'Slow down, you are attacking too quickly' },
    { status: 'error', message: 'Invalid request.' },
    { status: 'success', message: 'ok' },
  ]);
  const result = await attack.runStrategy({
    postForm: post,
    monsterId: 3,
    strategy: ['slash'],
    waitBufferMs: 100,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(post.calls.length, 3);
  assert.equal(result.ok, true);
  assert.equal(clock.sleeps[0], 800); // backoff for the rate limit
  assert.equal(clock.sleeps[1], 350); // invalid request retry
});

test('runStrategy turns thrown requests into a failed attack', async () => {
  const clock = fakeClock();
  const result = await attack.runStrategy({
    postForm: async () => {
      throw new Error('network');
    },
    monsterId: 3,
    strategy: ['slash', 'slash'],
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.attacks.length, 1);
  assert.equal(result.attacks[0].ok, false);
});

test('runStrategicAttack joins unjoined targets and skips failed joins', async () => {
  const clock = fakeClock();
  const calls = [];
  const post = async (url, params) => {
    calls.push({ url, params });
    if (url === 'join.php') {
      const text = params.monster_id === 2 ? '{"status":"error","message":"Battle is full"}' : 'You joined the battle';
      return { ok: true, status: 200, text, json: null };
    }
    return { ok: true, status: 200, text: '{"status":"success","damage":5}', json: null };
  };
  const joined = [];
  const results = await attack.runStrategicAttack({
    postForm: post,
    joinUrl: 'join.php',
    attackUrl: 'hit.php',
    userId: 99,
    targets: [
      { monsterId: 1, joined: false },
      { monsterId: 2, joined: false },
      { monsterId: 3, joined: true },
    ],
    strategy: ['slash', 'power slash'],
    waitBufferMs: 100,
    sleep: clock.sleep,
    now: clock.now,
    onJoined: (id) => joined.push(id),
  });
  assert.deepEqual(joined, [1]);
  assert.deepEqual(
    calls.map((call) => `${call.url}:${call.params.monster_id}`),
    ['join.php:1', 'hit.php:1', 'hit.php:1', 'join.php:2', 'hit.php:3', 'hit.php:3'],
  );
  assert.deepEqual(calls[0].params, { monster_id: 1, user_id: 99 });
  assert.deepEqual(results.map((result) => [result.monsterId, result.ok, result.skipped]), [
    [1, true, false],
    [2, false, true],
    [3, true, false],
  ]);
  assert.equal(results[1].joinMsg, 'Battle is full');
  assert.deepEqual(attack.summarizeResults(results), { processed: 3, success: 2, failed: 1, totalDamage: 20 });
});

test('joinMonster needs a user id', async () => {
  const post = stubPost(['joined']);
  assert.deepEqual(await attack.joinMonster({ postForm: post, monsterId: 1, userId: null }), {
    ok: false,
    msg: 'Missing user id',
  });
  assert.equal(post.calls.length, 0);
});

// ------------------------------------------------------- strategic attack

test('strategy is stored as a JSON array through ctx.store', () => {
  const storage = createStorage({ 'ui-improvements:attackStrategy': '["slash","Legendary Slash","bogus"]' });
  const store = createJsonStore(storage);
  assert.deepEqual(strategic.readStrategy(store), ['slash', 'legendary slash']);
  strategic.writeStrategy(store, ['power slash', 'x']);
  assert.equal(storage.getItem('ui-improvements:attackStrategy'), '["power slash"]');
  assert.deepEqual(strategic.readStrategy(null), []);
  assert.equal(strategic.strategyButtonLabel([], 1, 0), '🧠 Quick Join & Attack (no strategy)');
  assert.equal(
    strategic.strategyButtonLabel(['legendary slash'], 1.5, 50_000_000),
    '🧠 Quick Join & Attack (300) (limit 50m)',
  );
});

// ----------------------------------------------------------- null safety

function emptyDoc() {
  return {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => {
      throw new Error('should not create elements on an empty page');
    },
    head: null,
    body: null,
  };
}

test('wave features are registered and do nothing on a page without their elements', async () => {
  const ids = WAVE_FEATURES.map((feature) => feature.id);
  assert.deepEqual(ids, [
    'wave-select-visible',
    'wave-filter-sort-group',
    'wave-gate-info',
    'wave-flash-hp',
    'wave-in-battle-count',
    'wave-heal-button',
    'wave-auto-farm-buttons',
    'wave-boss-join-links',
    'wave-strategic-attack',
  ]);
  const url = new URL('https://demonicscans.org/active_wave.php?gate=3&wave=3');
  for (const feature of WAVE_FEATURES) {
    assert.equal(feature.matches(url), true, feature.id);
    assert.equal(feature.matches(new URL('https://demonicscans.org/battle.php?id=1')), false, feature.id);
    const ctx = contextFor(feature, createStorage());
    await feature.run(ctx);
  }
  // The strategy array is not a menu setting.
  const keys = WAVE_FEATURES.flatMap((feature) => (feature.settings || []).map((setting) => setting.key));
  assert.ok(!keys.includes(strategic.STRATEGY_KEY));
  assert.ok(keys.includes('ui-improvements:useAsterion'));
  assert.ok(!keys.includes(filtering.LEGACY_USE_GROUPS_KEY));
});
