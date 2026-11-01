'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../src/features/loot/loot-api');
const waveLoot = require('../src/features/loot/wave-loot');
const dungeonLoot = require('../src/features/loot/dungeon-loot');
const lootFeatures = require('../src/features/loot');

function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, text: JSON.stringify(data), json: data };
}

// postForm stub that records calls and answers from a function.
function stubPostForm(answer) {
  const calls = [];
  const postForm = async (url, params) => {
    calls.push({ url, params });
    return answer(url, params, calls.length);
  };
  return { postForm, calls };
}

const instantSleep = async () => {};

// ---------------------------------------------------------------------------
// Parsing and dedupe
// ---------------------------------------------------------------------------

test('itemQuantity reads every known quantity field and defaults to 1', () => {
  assert.equal(api.itemQuantity({ QUANTITY: '75' }), 75);
  assert.equal(api.itemQuantity({ quantity: 3 }), 3);
  assert.equal(api.itemQuantity({ QTY: '1,250' }), 1_250);
  assert.equal(api.itemQuantity({ QUANTITY: '75.00' }), 75);
  assert.equal(api.itemQuantity({ NAME: 'x' }), 1);
  assert.equal(api.itemQuantity(null), 1);
  assert.equal(api.itemQuantity({ QUANTITY: 0 }), 1);
});

test('dedupeItems sums per-drop quantities instead of counting drops', () => {
  const grouped = api.dedupeItems([
    { ITEM_ID: 7, NAME: 'Gem', IMAGE_URL: 'g.png', QUANTITY: 5 },
    { ITEM_ID: 7, NAME: 'Gem', IMAGE_URL: 'g.png', QUANTITY: 3 },
    { ITEM_ID: 9, NAME: 'Potion' },
    { ITEM_ID: 7, NAME: 'Gem', __source: 'ranking', QUANTITY: 2 },
    null,
  ]);
  assert.deepEqual(
    grouped.map((item) => [item.name, item.quantity, item.source]),
    [
      ['Gem', 8, 'normal'],
      ['Gem', 2, 'ranking'],
      ['Potion', 1, 'normal'],
    ],
  );
  assert.equal(api.totalItemUnits([{ QUANTITY: 5 }, { QTY: 2 }, {}]), 8);
});

test('parseLootResponse handles success, BOM text, ranking rewards and failures', () => {
  const ok = api.parseLootResponse(
    jsonResponse({
      status: 'success',
      message: 'Looted',
      rewards: { exp: 1200, gold: '3,000', damage_dealt: 50 },
      items: [{ ITEM_ID: 1, NAME: 'Gem', QUANTITY: 2 }],
      ranking_rewards: [{ ITEM_ID: 2, NAME: 'Crown' }],
      note: 'nice',
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.exp, 1200);
  assert.equal(ok.gold, 3000);
  assert.equal(ok.damage, 50);
  assert.equal(ok.items.length, 2);
  assert.equal(ok.items[1].__source, 'ranking');
  assert.equal(ok.note, 'nice');

  const bom = api.parseLootResponse({ ok: true, status: 200, text: '﻿{"status":"success","exp":5}', json: null });
  assert.equal(bom.ok, true);
  assert.equal(bom.exp, 5);

  const failed = api.parseLootResponse(jsonResponse({ status: 'error', message: 'Already looted' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.note, 'Already looted');
  assert.equal(failed.exp, 0);

  const html = api.parseLootResponse({ ok: false, status: 500, text: '<html>', json: null });
  assert.equal(html.ok, false);
  assert.equal(html.message, 'HTTP 500');

  const levelUp = api.parseLootResponse(jsonResponse({ status: 'success', level_up: 1, new_level: 12 }));
  assert.equal(levelUp.levelUp, true);
  assert.equal(levelUp.level, 12);
  const notLevel = api.parseLootResponse(jsonResponse({ status: 'success', message: 'You did not level up' }));
  assert.equal(notLevel.levelUp, false);
});

test('parseBulkLootResponse reads the dungeon loot_all summary', () => {
  const bulk = api.parseBulkLootResponse(
    jsonResponse({
      status: 'success',
      summary: { processed: 12, exp: 9000, gold: 400 },
      items: [{ NAME: 'Ore', QTY: 4, IMAGE_URL: 'o.png' }],
      note: '',
    }),
  );
  assert.deepEqual([bulk.ok, bulk.processed, bulk.exp, bulk.gold, bulk.understood], [true, 12, 9000, 400, true]);
  assert.equal(api.totalItemUnits(bulk.items), 4);
  const refused = api.parseBulkLootResponse(jsonResponse({ status: 'error', message: 'Nothing to loot.' }));
  assert.deepEqual([refused.ok, refused.understood, refused.message], [false, true, 'Nothing to loot.']);
  const missing = api.parseBulkLootResponse({ ok: false, status: 404, text: 'Not found', json: null });
  assert.equal(missing.understood, false);
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test('lootMonster posts loot.php for waves and dungeon_loot.php for dungeons', async () => {
  const { postForm, calls } = stubPostForm(() => jsonResponse({ status: 'success', rewards: { exp: 1, gold: 2 } }));

  const wave = await api.lootMonster(postForm, { monsterId: 557578482, userId: 159129 });
  assert.equal(wave.ok, true);
  assert.deepEqual(calls[0], { url: 'loot.php', params: { monster_id: '557578482', user_id: '159129' } });

  await api.lootMonster(postForm, { monsterId: '42' });
  assert.deepEqual(calls[1].params, { monster_id: '42', user_id: undefined });

  await api.lootMonster(postForm, { monsterId: 2525385, instanceId: 16159, userId: 7 });
  assert.equal(calls[2].url, 'dungeon_loot.php');
  assert.equal(calls[2].params.dgmid, '2525385');
  assert.equal(calls[2].params.instance_id, '16159');
  assert.equal(calls[2].params.user_id, '7');

  const invalid = await api.lootMonster(postForm, { monsterId: 'abc' });
  assert.equal(invalid.ok, false);
  assert.equal(calls.length, 3, 'no request for an invalid id');

  const broken = await api.lootMonster(
    async () => {
      throw new Error('offline');
    },
    { monsterId: 1 },
  );
  assert.equal(broken.ok, false);
  assert.match(broken.message, /offline/);
});

test('lootDungeonLocation and extractShadow use the game endpoints', async () => {
  const { postForm, calls } = stubPostForm((url) =>
    url === 'dungeon_loot.php'
      ? jsonResponse({ status: 'success', summary: { processed: 3, exp: 30, gold: 3 }, items: [] })
      : jsonResponse({ ok: true, shadow: { id: 5, name: 'Shade', image: 's.png' } }),
  );
  const bulk = await api.lootDungeonLocation(postForm, { instanceId: 16137, locationId: 2 });
  assert.equal(bulk.processed, 3);
  assert.deepEqual(calls[0], {
    url: 'dungeon_loot.php',
    params: { action: 'loot_all', instance_id: '16137', location_id: '2' },
  });

  const shadow = await api.extractShadow(postForm, 99);
  assert.equal(calls[1].url, '/battle.php?id=99');
  assert.deepEqual(calls[1].params, { action: 'extract_shadow' });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.shadow.NAME, 'Shade');
  assert.equal(shadow.shadow.QUANTITY, 1);
});

// ---------------------------------------------------------------------------
// Runner, totals and level-up tracking
// ---------------------------------------------------------------------------

test('runLimited keeps at most `concurrency` requests in flight and keeps result order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  const { results, completed, stopped } = await api.runLimited(
    items,
    async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (item === 5) throw new Error('boom');
      return { ok: true, value: item * 2 };
    },
    { concurrency: 4, sleepImpl: instantSleep, delayMs: 10 },
  );
  assert.equal(maxInFlight, 4);
  assert.equal(completed, 20);
  assert.equal(stopped, false);
  assert.equal(results[3].value, 6);
  assert.equal(results[5].ok, false);
});

test('runLimited caps concurrency and stops when asked', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await api.runLimited(
    Array.from({ length: 30 }, (_, index) => index),
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ok: true };
    },
    { concurrency: 200 },
  );
  assert.ok(maxInFlight <= 8, `never 200 parallel requests (saw ${maxInFlight})`);

  let done = 0;
  const run = await api.runLimited(
    Array.from({ length: 10 }, (_, index) => index),
    async () => ({ ok: true }),
    { concurrency: 1, shouldStop: () => done >= 3, onResult: () => (done += 1) },
  );
  assert.equal(run.completed, 3);
  assert.equal(run.stopped, true);
});

test('level-up tracker never stops when the EXP requirement is unknown', () => {
  const unknown = api.createLevelUpTracker({ expToLevel: null });
  assert.equal(unknown.knowsRequirement, false);
  for (let i = 0; i < 5; i += 1) unknown.add({ ok: true, exp: 1_000_000 });
  assert.equal(unknown.reached, false);

  const known = api.createLevelUpTracker({ expToLevel: 2_500 });
  known.add({ ok: true, exp: 1_000 });
  known.add({ ok: false, exp: 5_000 });
  assert.equal(known.reached, false);
  known.add({ ok: true, exp: 1_500 });
  assert.equal(known.reached, true);

  const flagged = api.createLevelUpTracker({ expToLevel: null, startLevel: 10 });
  flagged.add({ ok: true, exp: 1, level: 10 });
  assert.equal(flagged.reached, false);
  flagged.add({ ok: true, exp: 1, level: 11 });
  assert.equal(flagged.reached, true);

  const observed = api.createLevelUpTracker({ startLevel: 10 });
  assert.equal(observed.observeLevel(null), false);
  assert.equal(observed.observeLevel(11), true);

  const signal = api.createLevelUpTracker({});
  signal.add({ ok: true, exp: 0, levelUp: true });
  assert.equal(signal.reached, true);
});

test('loot totals add up results and filter dropless notes', () => {
  const totals = api.createLootTotals(3);
  api.addLootResult(totals, { ok: true, exp: 10, gold: 1, damage: 5, items: [{ QUANTITY: 2 }], note: 'No item dropped' });
  api.addLootResult(totals, { ok: false, note: 'Already looted' });
  api.addLootResult(totals, { ok: true, processed: 12, exp: 100, gold: 0, items: [] });
  assert.deepEqual(
    [totals.processed, totals.success, totals.fail, totals.exp, totals.gold, totals.damage],
    [14, 13, 1, 110, 1, 5],
  );
  assert.equal(api.summarizeNotes(totals.notes, true), 'Already looted');
  assert.equal(api.summarizeNotes(['No item dropped', 'No item dropped'], false), 'No item dropped');
});

test('boss blacklist matches names case-insensitively', () => {
  assert.equal(api.isBlacklistedBoss('Oceanus The Water Titan'), true);
  assert.equal(api.isBlacklistedBoss('  drakzareth   the tyrant lizard king '), true);
  assert.equal(api.isBlacklistedBoss('Kraken'), false);
  assert.equal(api.isBlacklistedBoss(undefined), false);
});

// ---------------------------------------------------------------------------
// Wave helpers
// ---------------------------------------------------------------------------

test('wave cardInfo and selectLootTargets honour guard, blacklist, damage and visibility', () => {
  const { cardInfo, selectLootTargets } = waveLoot.helpers;
  const card = (data, extra = {}) =>
    cardInfo({ dataset: { dead: '1', eligible: '1', ...data }, classList: { contains: () => false }, style: {}, ...extra });

  const infos = [
    card({ monsterId: '1', name: 'kraken', userdmg: '6000000' }),
    card({ monsterId: '2', name: 'oceanus the water titan', userdmg: '0' }),
    card({ monsterId: '3', name: 'merfolk', userdmg: '0' }),
    card({ monsterId: '4', name: 'merfolk', userdmg: '10', eligible: '0' }),
    card({ monsterId: '5', name: 'merfolk' }, { style: { display: 'none' } }),
    card({ monsterId: '3', name: 'merfolk', userdmg: '0' }),
    card({ monsterId: '', name: 'merfolk' }),
  ];
  assert.equal(infos[0].damage, 6_000_000);
  assert.equal(infos[4].hasDamage, false);
  assert.equal(infos[4].hidden, true);

  const ids = (options) => selectLootTargets(infos, options).map((info) => info.id);
  assert.deepEqual(ids({}), ['1', '2', '3', '5']);
  assert.deepEqual(ids({ protectedNames: new Set(['kraken']) }), ['2', '3', '5']);
  assert.deepEqual(ids({ ignoreBosses: true }), ['1', '3', '5']);
  assert.deepEqual(ids({ zeroDamageOnly: true }), ['2', '3']);
  assert.deepEqual(ids({ visibleOnly: true, limit: 2 }), ['1', '2']);
});

test('wave dead page count and damage sort', () => {
  const { parseDeadPageCount, sortByDamage, parseDamage } = waveLoot.helpers;
  assert.deepEqual(parseDeadPageCount({ text: 'Dead loot page 1 / 4' }), { current: 1, total: 4 });
  assert.deepEqual(parseDeadPageCount({ unclaimed: 401 }), { current: 1, total: 3 });
  assert.deepEqual(parseDeadPageCount({ unclaimed: null }), { current: 1, total: 1 });
  assert.deepEqual(parseDeadPageCount(), { current: 1, total: 1 });
  assert.equal(parseDamage('3,247,818,809'), 3_247_818_809);
  assert.equal(parseDamage(undefined), 0);
  const sorted = sortByDamage(
    [
      { id: 'a', d: 5 },
      { id: 'b', d: 0 },
      { id: 'c', d: 5 },
      { id: 'd', d: 1 },
    ],
    (item) => item.d,
  );
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['b', 'd', 'a', 'c'],
  );
});

// ---------------------------------------------------------------------------
// Dungeon helpers and flow
// ---------------------------------------------------------------------------

test('dungeon locations come from unlocked map pins and revealed cube nodes', () => {
  const { locationsFromPins, locationsFromState, instanceIdFromState } = dungeonLoot.helpers;
  const pin = (href, locked = false) => ({
    getAttribute: () => href,
    classList: { contains: (name) => locked && name === 'locked' },
  });
  assert.deepEqual(
    locationsFromPins([
      pin('guild_dungeon_location.php?instance_id=16137&amp;location_id=1'),
      pin('guild_dungeon_location.php?instance_id=16137&location_id=2'),
      pin('guild_dungeon_location.php?instance_id=16137&location_id=2'),
      pin('javascript:void(0)', true),
      pin('guild_dungeon_location.php?location_id=4'),
    ], '16137'),
    [
      { instanceId: '16137', locationId: '1' },
      { instanceId: '16137', locationId: '2' },
      { instanceId: '16137', locationId: '4' },
    ],
  );

  const state = {
    nodes: [
      { is_revealed: 1, linked_location_id: 0 },
      { is_revealed: 1, linked_location_id: 11, monsters_total: 22, monsters_left: 20 },
      { is_revealed: 0, linked_location_id: 12 },
      { is_revealed: 1, linked_location_id: 13, monsters_total: 22, monsters_left: 22 },
      { is_revealed: 1, linked_location_id: 14 },
    ],
    run_leaders: [{ INSTANCE_ID: 16126 }],
  };
  assert.deepEqual(locationsFromState(state), ['11', '14']);
  assert.deepEqual(locationsFromState(undefined), []);
  assert.equal(instanceIdFromState(state), '16126');
});

function fakeLocationDoc(ids) {
  const mons = ids.map((id) => ({
    querySelectorAll: () => [{ textContent: ' not looted ' }],
    querySelector: () => ({ getAttribute: () => `battle.php?dgmid=${id}&instance_id=1` }),
  }));
  return { querySelectorAll: (selector) => (selector === '.mon' ? mons : []), querySelector: () => null };
}

function fakeDungeonCtx({ postForm, expText = null, locationDocs = {} }) {
  return {
    doc: {
      querySelector: (selector) =>
        selector === '.gtb-exp-top span:last-child' && expText ? { textContent: expText } : null,
      getElementById: () => null,
    },
    postForm,
    pageGlobal: (name) => (name === 'USER_ID' ? 159129 : undefined),
    getUserId: async () => 159129,
    fetchDocument: async (url) => locationDocs[url.match(/location_id=(\d+)/)[1]],
    warn: () => {},
  };
}

test('dungeon loot uses the bulk endpoint and does not stop when EXP is unknown', async () => {
  const { postForm, calls } = stubPostForm(() =>
    jsonResponse({ status: 'success', summary: { processed: 4, exp: 1_000_000, gold: 10 }, items: [] }),
  );
  const { totals, leveledUp, precise } = await dungeonLoot.helpers.lootDungeon(fakeDungeonCtx({ postForm }), {
    instanceId: '16137',
    locationIds: ['1', '2'],
    stopOnLevelUp: true,
  });
  assert.equal(precise, false);
  assert.equal(leveledUp, false);
  assert.equal(calls.length, 2, 'both locations looted although EXP to level is unknown');
  assert.equal(totals.success, 8);
  assert.equal(totals.exp, 2_000_000);
});

test('dungeon loot goes monster by monster and stops at the level up when EXP is known', async () => {
  const { postForm, calls } = stubPostForm(() =>
    jsonResponse({ status: 'success', rewards: { exp: 600, gold: 1, damage_dealt: 0 }, items: [] }),
  );
  const ctx = fakeDungeonCtx({
    postForm,
    expText: '4,000 / 5,000',
    locationDocs: { 1: fakeLocationDoc([11, 12, 13, 14]), 2: fakeLocationDoc([21]) },
  });
  const { totals, leveledUp, precise } = await dungeonLoot.helpers.lootDungeon(ctx, {
    instanceId: '16137',
    locationIds: ['1', '2'],
    stopOnLevelUp: true,
  });
  assert.equal(precise, true);
  assert.equal(leveledUp, true);
  assert.equal(calls.length, 2, '600 + 600 EXP reaches the 1,000 still needed');
  assert.ok(calls.every((call) => call.url === 'dungeon_loot.php' && call.params.instance_id === '16137'));
  assert.equal(totals.success, 2);
});

test('dungeon loot falls back to per-monster looting when loot_all is unavailable', async () => {
  const { postForm, calls } = stubPostForm((url, params) =>
    params.action === 'loot_all'
      ? { ok: false, status: 404, text: 'Not found', json: null }
      : jsonResponse({ status: 'success', rewards: { exp: 1, gold: 1, damage_dealt: 0 }, items: [{ ITEM_ID: 1, QUANTITY: 2 }] }),
  );
  const ctx = fakeDungeonCtx({ postForm, locationDocs: { 3: fakeLocationDoc([31, 32]) } });
  const { totals } = await dungeonLoot.helpers.lootDungeon(ctx, {
    instanceId: '5',
    locationIds: ['3'],
    stopOnLevelUp: false,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(1).map((call) => call.params.dgmid).sort(),
    ['31', '32'],
  );
  assert.equal(totals.success, 2);
  assert.equal(api.totalItemUnits(totals.items), 4);
});

test('loot features are registered with the expected settings', () => {
  assert.deepEqual(
    lootFeatures.map((feature) => feature.id),
    ['wave-loot', 'dungeon-loot'],
  );
  const keys = lootFeatures.flatMap((feature) => feature.settings.map((setting) => setting.key));
  for (const key of [
    'ui-improvements:enableLootXFaster',
    'ui-improvements:ignoreBossMobsWhenLooting',
    'ui-improvements:useDungeonLoot',
    'ui-improvements:stopLootingOnLevelUp',
  ]) {
    assert.ok(keys.includes(key), key);
  }
  const url = (path) => new URL(`https://demonicscans.org${path}`);
  assert.equal(waveLoot.matches(url('/active_wave.php?gate=3&wave=3')), true);
  assert.equal(waveLoot.matches(url('/battle.php?id=1')), false);
  assert.equal(dungeonLoot.matches(url('/guild_dungeon_instance.php?id=16137')), true);
  assert.equal(dungeonLoot.matches(url('/guild_dungeon_cube.php?instance_id=16126')), true);
  assert.equal(dungeonLoot.matches(url('/guild_dungeon_location.php?instance_id=1&location_id=1')), false);
});
