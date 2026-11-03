'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LOOT_GUARD_KEY } = require('../src/core/loot-guard');
const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../src/scheduler/engine');
const { routeIdForUrl } = require('../src/scheduler/runtime');
const adventurersRoute = require('../src/routes/adventurers');
const { ROUTES } = require('../src/routes');
const logic = require('../src/features/automation/adventurers-logic');
const {
  ACCEPT_PATH,
  AUTOFARM_SNAPSHOT_KEY,
  AUTO_FARM_PATH,
  FINISH_PATH,
  GUILD_PATH,
  LOOT_PATH,
  createAdventurersWorker,
} = require('../src/features/automation/adventurers-worker');

const NOW = 1_800_000_000_000;

function element({ text = '', attrs = {}, dataset = {}, value = '', selected = false, disabled = false, classes = [], one = {}, many = {} } = {}) {
  return {
    textContent: text,
    dataset,
    value,
    selected,
    disabled,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute(name) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) return String(attrs[name]);
      if (name === 'data-target-id' && dataset.targetId !== undefined) return String(dataset.targetId);
      return null;
    },
    querySelector(selector) {
      const result = one[selector] ?? many[selector];
      return Array.isArray(result) ? result[0] || null : result || null;
    },
    querySelectorAll(selector) {
      const result = many[selector] ?? one[selector];
      return Array.isArray(result) ? result : result ? [result] : [];
    },
  };
}

function documentWith({ text = '', one = {}, many = {} } = {}) {
  return {
    body: { textContent: text },
    hidden: false,
    visibilityState: 'visible',
    querySelector(selector) {
      const result = one[selector] ?? many[selector];
      return Array.isArray(result) ? result[0] || null : result || null;
    },
    querySelectorAll(selector) {
      const result = many[selector] ?? one[selector];
      return Array.isArray(result) ? result : result ? [result] : [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function documentWithCookies(doc, initial, events = []) {
  const values = new Map(Object.entries(initial).map(([name, value]) => [String(name), String(value)]));
  Object.defineProperty(doc, 'cookie', {
    configurable: true,
    get() {
      return [...values].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
    },
    set(text) {
      const parts = String(text || '').split(';');
      const pair = parts.shift() || '';
      const separator = pair.indexOf('=');
      if (separator < 1) return;
      const name = pair.slice(0, separator).trim();
      const encoded = pair.slice(separator + 1).trim();
      let value = encoded;
      try {
        value = decodeURIComponent(encoded);
      } catch {
        // Keep malformed values observable instead of making the fake jar throw.
      }
      const maxAge = parts
        .map((part) => part.trim().match(/^Max-Age=(-?\d+)$/i))
        .find(Boolean);
      if (maxAge && Number(maxAge[1]) <= 0) values.delete(name);
      else values.set(name, value);
      events.push({ type: 'cookie-write', name, value, raw: String(text) });
    },
  });
  doc.cookieValues = values;
  doc.cookieEvents = events;
  return doc;
}

function questRow({ id = '31', state = 'available', current = 0, count = 10, cooldownAt = 0 } = {}) {
  const buttons = [];
  if (state === 'available') buttons.push(element({ attrs: { onclick: `acceptQuest(${id}, this)` } }));
  if (state === 'active') {
    buttons.push(element({ attrs: { onclick: `giveUpQuest(${id}, this)` } }));
    if (current >= count) buttons.push(element({ attrs: { onclick: `finishQuest(${id}, this)` } }));
  }
  const one = {
    '.quest-req-text': element({ text: `Kill ${count} monster(s) · Monster: Kraken · min 5m dmg` }),
    '.quest-main-title': element({ text: 'Wrath of the Abyss' }),
    '.quest-progress': element({ text: `${current} / ${count}` }),
  };
  if (state === 'cooldown') {
    one['.quest-cooldown-timer[data-cooldown-ts]'] = element({
      attrs: { 'data-cooldown-ts': Math.floor(cooldownAt / 1_000) },
    });
  }
  return element({ one, many: { '[onclick]': buttons } });
}

function guildDocument(state, current = 0, count = 1) {
  return documentWith({
    many: {
      '.quest-row': [
        questRow({
          state,
          current,
          count,
          cooldownAt: state === 'cooldown' ? NOW + 48 * 60 * 60_000 : 0,
        }),
      ],
    },
  });
}

function deadCard({ id = '1001', damage = '5000000', expiresAt = NOW + 60_000, quantity = 1 } = {}) {
  return element({
    dataset: {
      monsterId: id,
      name: 'kraken',
      userdmg: damage,
      dead: '1',
      eligible: '1',
      expire: String(Math.floor(expiresAt / 1_000)),
      quantity: String(quantity),
    },
  });
}

function waveDocument(cards = [deadCard()], { farmState = 'finished', killed = 90, target = 90 } = {}) {
  const option = element({ text: 'Kraken', value: '501', selected: true });
  const monsterSelect = element({ value: '501', many: { option: [option] } });
  const targetRow = element({
    dataset: { targetId: '41' },
    one: {
      '.afTMonster': monsterSelect,
      '.afTEnabled': element({ value: '0' }),
      '.afTMode': element({ value: '0' }),
      '.afTMin': element({ value: '1000000' }),
      '.afTStack': element({ value: '1' }),
    },
  });
  const badge = element({
    text: farmState === 'finished' ? 'FINISHED' : farmState === 'running' ? 'RUNNING' : 'PAUSED',
    classes: [farmState === 'finished' ? 'fin' : farmState === 'running' ? 'on' : 'off'],
  });
  return documentWith({
    one: {
      '#afStateBadge': badge,
      '#afTotalKilledText': element({ text: String(killed) }),
      '#afTotalToKill': element({ value: String(target) }),
      '#afHpMax': element({ value: '3000' }),
      '#afSt20Max': element({ value: '10' }),
      '#afStHalfMax': element({ value: '10' }),
      '#afStFullMax': element({ value: '10' }),
      '#afStAdvMax': element({ value: '10' }),
      '#afStPriority': element({ value: '30' }),
      '#afAutoLootToLevel': element({ value: '1' }),
      '#afPrcExpLeft': element({ value: '100' }),
    },
    many: {
      '.monster-card[data-dead="1"]': cards,
      '.unclaimed-pill': [],
      '.af-row[data-target-id]': [targetRow],
      '.afTMonster option, #afAddMonster option': [option],
    },
  });
}

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    write(key, value) {
      values.set(key, structuredClone(value));
      return true;
    },
    remove(key) {
      values.delete(key);
    },
  };
}

function runningAdventurersCommand(visitId) {
  return {
    version: 1,
    visitId,
    taskId: 'adventurers',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 60_000,
  };
}

function adventurersWindow(doc) {
  return {
    document: doc,
    location: {
      href: 'https://demonicscans.org/adventurers_guild.php?veyra_route=adventurers',
      origin: 'https://demonicscans.org',
    },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function cookieSnapshot(doc) {
  return Object.fromEntries(doc.cookieValues);
}

function assertDeadPoolCookiesRestored(doc, events, afterEventIndex) {
  assert.deepEqual(cookieSnapshot(doc), {
    hide_dead_monsters: '1',
    show_dead_bosses_only: '0',
  });
  const cleanupWrites = events.slice(afterEventIndex + 1).filter((event) => event.type === 'cookie-write');
  assert.equal(
    cleanupWrites.some(
      (event) => event.name === 'hide_dead_monsters' && event.value === '1',
    ),
    true,
  );
  assert.equal(
    cleanupWrites.some(
      (event) => event.name === 'show_dead_bosses_only' && event.value === '0',
    ),
    true,
  );
}

test("Adventurer's Guild route is distinct and disabled by default", () => {
  assert.equal(ROUTES.adventurers, adventurersRoute);
  assert.equal(routeIdForUrl('/adventurers_guild.php?veyra_route=adventurers'), 'adventurers');
  assert.equal(routeIdForUrl('/adventurers_guild.php'), 'adventurers');
  assert.equal(createDefaultConfig().routes.adventurers.enabled, false);
  assert.equal(createDefaultConfig().routes.adventurers.settings.farmMonsterCount, 90);
});

test('quest requirements parse names with commas and compact damage values', () => {
  assert.deepEqual(
    logic.parseQuestRequirement(
      'Kill 10 monster(s) · Monster: Charybdis, Living Maelstrom · min 5m dmg',
    ),
    {
      name: 'Charybdis, Living Maelstrom',
      normalizedName: 'charybdis, living maelstrom',
      count: 10,
      minDamage: 5_000_000,
    },
  );
  assert.equal(logic.parseQuestRequirement('Collect ten apples'), null);
});

test('duplicate quest targets are aggregated so enough monsters are farmed for every quest', () => {
  const kraken = logic.parseQuestRequirement('Kill 10 monster(s) · Monster: Kraken · min 5m dmg');
  const harder = logic.parseQuestRequirement('Kill 4 monster(s) · Monster: Kraken · min 7m dmg');
  assert.deepEqual(logic.aggregateRequirements([kraken, harder]), [
    { name: 'Kraken', normalizedName: 'kraken', count: 14, minDamage: 7_000_000 },
  ]);
});

test('Auto Farm targets include cooldown quests, not only the currently available quest', () => {
  const names = [
    'Charybdis, Living Maelstrom',
    'The Crab King',
    'Dark Siren',
    'Scylla, Devourer of Sailors',
    'Kraken',
    'Merfolk',
    'Deep Sea Beast',
    'Triton Warrior',
    'Water Nymph',
  ];
  const quests = names.map((name, index) => ({
    state: index === 0 ? 'available' : 'cooldown',
    requirement: logic.parseQuestRequirement(
      `Kill 10 monster(s) · Monster: ${name} · min 5m dmg`,
    ),
  }));
  assert.deepEqual(
    logic.questFarmRequirements(quests).map((requirement) => requirement.name),
    names,
  );
});

test('dead monster selection requires eligibility, damage and a future expiry', () => {
  const requirement = logic.parseQuestRequirement('Kill 2 monster(s) · Monster: Kraken · min 5m dmg');
  const valid = logic.deadMonsterFromCard(deadCard({ id: '1' }), NOW);
  const weak = logic.deadMonsterFromCard(deadCard({ id: '2', damage: '4999999' }), NOW);
  const expired = logic.deadMonsterFromCard(deadCard({ id: '3', expiresAt: NOW - 1 }), NOW);
  assert.equal(valid.id, '1');
  assert.equal(expired, null);
  assert.deepEqual(logic.eligibleForRequirement([valid, weak], requirement).map((monster) => monster.id), ['1']);
  assert.equal(logic.requirementsSatisfied([requirement], [valid]), false);
});

test('stacked dead-monster cards contribute their full quantity', () => {
  const requirement = logic.parseQuestRequirement('Kill 10 monster(s) · Monster: Kraken · min 5m dmg');
  const stack = logic.deadMonsterFromCard(deadCard({ id: '9', quantity: 10 }), NOW);
  assert.equal(stack.quantity, 10);
  assert.equal(logic.requirementCounts([requirement], [stack])[0].count, 10);
  assert.equal(logic.requirementsSatisfied([requirement], [stack]), true);
});

test('worker reveals the dead pool before Wave fetches and restores both filter cookies after success', async () => {
  let state = 'available';
  let progress = 0;
  const events = [];
  const pageDoc = documentWithCookies(
    guildDocument('available', 0, 1),
    { hide_dead_monsters: '1', show_dead_bosses_only: '0' },
    events,
  );
  const store = createStore({ [COMMAND_KEY]: runningAdventurersCommand('adv-cookies-success') });
  const worker = createAdventurersWorker({
    win: adventurersWindow(pageDoc),
    doc: pageDoc,
    store,
    fetchDocument: async (url) => {
      if (String(url).includes('active_wave.php')) {
        events.push({ type: 'wave-fetch', cookies: cookieSnapshot(pageDoc) });
        return waveDocument();
      }
      return guildDocument(state, progress, 1);
    },
    postForm: async (url) => {
      if (url === ACCEPT_PATH) state = 'active';
      if (url === LOOT_PATH) progress = 1;
      if (url === FINISH_PATH) state = 'cooldown';
      return { ok: true, status: 200, json: { status: url === LOOT_PATH ? 'success' : 'ok' }, text: '' };
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  const waveFetches = events.filter((event) => event.type === 'wave-fetch');
  assert.ok(waveFetches.length >= 1);
  for (const event of waveFetches) {
    assert.equal(event.cookies.hide_dead_monsters, '0');
    assert.equal(event.cookies.show_dead_bosses_only, '0');
  }
  assertDeadPoolCookiesRestored(pageDoc, events, events.lastIndexOf(waveFetches.at(-1)));
  assert.equal(store.read(workerStatusKey('adventurers')).state, 'done');
});

test('worker restores the dead-pool filter cookies when a Wave fetch fails', async () => {
  const events = [];
  const pageDoc = documentWithCookies(
    guildDocument('available', 0, 1),
    { hide_dead_monsters: '1', show_dead_bosses_only: '0' },
    events,
  );
  const store = createStore({ [COMMAND_KEY]: runningAdventurersCommand('adv-cookies-error') });
  const worker = createAdventurersWorker({
    win: adventurersWindow(pageDoc),
    doc: pageDoc,
    store,
    fetchDocument: async (url) => {
      if (String(url).includes('active_wave.php')) {
        events.push({ type: 'wave-fetch', cookies: cookieSnapshot(pageDoc) });
        throw new Error('Wave request failed');
      }
      return guildDocument('available', 0, 1);
    },
    postForm: async () => {
      throw new Error('No mutation is expected before the failed Wave fetch.');
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  const waveIndex = events.findIndex((event) => event.type === 'wave-fetch');
  assert.notEqual(waveIndex, -1);
  assert.equal(events[waveIndex].cookies.hide_dead_monsters, '0');
  assert.equal(events[waveIndex].cookies.show_dead_bosses_only, '0');
  assertDeadPoolCookiesRestored(pageDoc, events, waveIndex);
  assert.equal(store.read(workerStatusKey('adventurers')).state, 'error');
});

test('worker restores the dead-pool filter cookies when its visit starts draining mid-scan', async () => {
  const events = [];
  const pageDoc = documentWithCookies(
    guildDocument('available', 0, 1),
    { hide_dead_monsters: '1', show_dead_bosses_only: '0' },
    events,
  );
  const store = createStore({ [COMMAND_KEY]: runningAdventurersCommand('adv-cookies-drain') });
  const worker = createAdventurersWorker({
    win: adventurersWindow(pageDoc),
    doc: pageDoc,
    store,
    fetchDocument: async (url) => {
      if (String(url).includes('active_wave.php')) {
        events.push({ type: 'wave-fetch', cookies: cookieSnapshot(pageDoc) });
        store.write(COMMAND_KEY, { ...store.read(COMMAND_KEY), phase: 'draining' });
        return waveDocument();
      }
      return guildDocument('available', 0, 1);
    },
    postForm: async () => ({ ok: true, status: 200, json: { ok: true }, text: '' }),
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  const waveIndex = events.findIndex((event) => event.type === 'wave-fetch');
  assert.notEqual(waveIndex, -1);
  assert.equal(events[waveIndex].cookies.hide_dead_monsters, '0');
  assertDeadPoolCookiesRestored(pageDoc, events, waveIndex);
  assert.equal(store.read(workerStatusKey('adventurers')).state, 'done');
});

test('stopping the worker restores dead-pool filter cookies while a Wave fetch is still pending', async () => {
  const events = [];
  const pageDoc = documentWithCookies(
    guildDocument('available', 0, 1),
    { hide_dead_monsters: '1', show_dead_bosses_only: '0' },
    events,
  );
  const store = createStore({ [COMMAND_KEY]: runningAdventurersCommand('adv-cookies-stop') });
  let signalWaveStarted;
  let releaseWave;
  const waveStarted = new Promise((resolve) => {
    signalWaveStarted = resolve;
  });
  const pendingWave = new Promise((resolve) => {
    releaseWave = resolve;
  });
  const worker = createAdventurersWorker({
    win: adventurersWindow(pageDoc),
    doc: pageDoc,
    store,
    fetchDocument: async (url) => {
      if (String(url).includes('active_wave.php')) {
        events.push({ type: 'wave-fetch', cookies: cookieSnapshot(pageDoc) });
        signalWaveStarted();
        return pendingWave;
      }
      return guildDocument('available', 0, 1);
    },
    postForm: async () => ({ ok: true, status: 200, json: { ok: true }, text: '' }),
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  const tickPromise = worker.tick();
  await waveStarted;
  const waveIndex = events.findIndex((event) => event.type === 'wave-fetch');
  try {
    assert.equal(events[waveIndex].cookies.hide_dead_monsters, '0');
    worker.stop();
    assertDeadPoolCookiesRestored(pageDoc, events, waveIndex);
  } finally {
    worker.stop();
    releaseWave(waveDocument());
    await tickPromise;
  }
});

test('worker accepts, loots and finishes a ready quest without ever giving it up', async () => {
  let state = 'available';
  let progress = 0;
  const posts = [];
  const config = createDefaultConfig();
  config.routes.adventurers.enabled = true;
  config.routes.adventurers.settings.farmMonsterCount = 123;
  const store = createStore({
    [CONFIG_KEY]: config,
    [COMMAND_KEY]: {
      version: 1,
      visitId: 'adv-visit',
      taskId: 'adventurers',
      phase: 'running',
      returnPath: '/pvp.php',
      issuedAt: NOW - 1_000,
      deadlineAt: NOW + 60_000,
    },
  });
  const win = {
    location: {
      href: 'https://demonicscans.org/adventurers_guild.php?veyra_route=adventurers',
      origin: 'https://demonicscans.org',
    },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const pageDoc = guildDocument('available', 0, 1);
  let waveFetches = 0;
  const worker = createAdventurersWorker({
    win,
    doc: pageDoc,
    store,
    fetchDocument: async (url) => {
      if (!String(url).includes('active_wave.php')) return guildDocument(state, progress, 1);
      waveFetches += 1;
      return waveFetches === 1
        ? waveDocument([], { farmState: 'paused', killed: 0, target: 123 })
        : waveDocument();
    },
    postForm: async (url, params) => {
      posts.push({ url, params });
      if (url === ACCEPT_PATH) state = 'active';
      if (url === LOOT_PATH) progress = 1;
      if (url === FINISH_PATH) state = 'cooldown';
      return { ok: true, status: 200, json: { status: url === LOOT_PATH ? 'success' : 'ok' }, text: '' };
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  assert.deepEqual(
    posts.filter((entry) => [ACCEPT_PATH, LOOT_PATH, FINISH_PATH].includes(entry.url)).map((entry) => entry.url),
    [ACCEPT_PATH, LOOT_PATH, FINISH_PATH],
  );
  const firstReset = posts.findIndex(
    (entry) => entry.url === AUTO_FARM_PATH && entry.params.action === 'reset',
  );
  const firstConfiguration = posts.findIndex(
    (entry) =>
      entry.url === AUTO_FARM_PATH &&
      ['update_target', 'add_target', 'save_settings'].includes(entry.params.action),
  );
  assert.ok(firstReset >= 0);
  assert.ok(firstReset < firstConfiguration, 'Auto Farm must reset before quest targets or settings are changed');
  const questFarmSettings = posts.find(
    (entry) => entry.url === AUTO_FARM_PATH && entry.params.action === 'save_settings' && entry.params.TOTAL_MONSTERS_TO_KILL === '123',
  );
  assert.deepEqual(
    {
      total: questFarmSettings?.params.TOTAL_MONSTERS_TO_KILL,
      hp: questFarmSettings?.params.HP_POTIONS_MAX_TO_USE,
      small: questFarmSettings?.params.STAM_POT_SMALL_ITEM_MAX_TO_USE,
      large: questFarmSettings?.params.STAM_POT_HALF_ITEM_ID_MAX_TO_USE,
      full: questFarmSettings?.params.STAM_POT_FULL_ITEM_ID_MAX_TO_USE,
      adventurer: questFarmSettings?.params.STAM_POT_ADV_ITEM_MAX_TO_USE,
      priority: questFarmSettings?.params.STAM_POT_PRIORITY_ITEM_ID,
      lootToLevel: questFarmSettings?.params.AUTO_LOOT_TO_LEVEL,
    },
    {
      total: '123',
      hp: '1000',
      small: '0',
      large: '1',
      full: '0',
      adventurer: '0',
      priority: '251',
      lootToLevel: '0',
    },
  );
  assert.equal(posts.some((entry) => /giveup/i.test(entry.url)), false);
  assert.deepEqual(store.read(LOOT_GUARD_KEY), { names: [] });
  const status = store.read(workerStatusKey('adventurers'));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(status.retryAt, NOW + 48 * 60 * 60_000);
});

test('worker skips Auto Farm when every required quest monster is already available', async () => {
  let state = 'available';
  let progress = 0;
  const posts = [];
  const store = createStore({
    [COMMAND_KEY]: runningAdventurersCommand('adv-skip-farm'),
  });
  const pageDoc = guildDocument('available', 0, 1);
  const worker = createAdventurersWorker({
    win: adventurersWindow(pageDoc),
    doc: pageDoc,
    store,
    fetchDocument: async (url) =>
      String(url).includes('active_wave.php')
        ? waveDocument([deadCard({ id: '2001', quantity: 1 })])
        : guildDocument(state, progress, 1),
    postForm: async (url, params) => {
      posts.push({ url, params });
      if (url === ACCEPT_PATH) state = 'active';
      if (url === LOOT_PATH) progress = 1;
      if (url === FINISH_PATH) state = 'cooldown';
      return { ok: true, status: 200, json: { status: url === LOOT_PATH ? 'success' : 'ok' }, text: '' };
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  assert.equal(posts.some((entry) => entry.url === AUTO_FARM_PATH), false);
  assert.deepEqual(
    posts.filter((entry) => [ACCEPT_PATH, LOOT_PATH, FINISH_PATH].includes(entry.url)).map((entry) => entry.url),
    [ACCEPT_PATH, LOOT_PATH, FINISH_PATH],
  );
  assert.equal(store.read(AUTOFARM_SNAPSHOT_KEY), null);
  assert.equal(store.read(workerStatusKey('adventurers')).state, 'done');
});

test('worker continues a leased visit when the server removes the Adventurers route marker', async () => {
  const ownerId = 'tab-adventurers';
  const fetches = [];
  const store = createStore({
    [LEASE_KEY]: {
      version: 1,
      ownerId,
      leaseUntil: NOW + 60_000,
    },
    [COMMAND_KEY]: {
      version: 1,
      visitId: 'adv-canonical',
      taskId: 'adventurers',
      phase: 'running',
      returnPath: '/pvp.php',
      issuedAt: NOW - 1_000,
      deadlineAt: NOW + 60_000,
    },
  });
  const sessionStore = {
    available: true,
    readRaw(key) {
      return key === TAB_KEY ? ownerId : null;
    },
  };
  const win = {
    location: {
      href: 'https://demonicscans.org/adventurers_guild.php',
      origin: 'https://demonicscans.org',
    },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const worker = createAdventurersWorker({
    win,
    doc: guildDocument('cooldown'),
    store,
    sessionStore,
    fetchDocument: async (url) => {
      fetches.push(String(url));
      return guildDocument('cooldown');
    },
    postForm: async () => {
      throw new Error('A cooldown-only visit must not mutate game state.');
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].startsWith(`${GUILD_PATH}?_veyra_quest=`), true);
  const status = store.read(workerStatusKey('adventurers'));
  assert.equal(status.visitId, 'adv-canonical');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(status.retryAt, NOW + 48 * 60 * 60_000);
});

test('a draining visit pauses an owned server-side Auto Farm before reporting safe', async () => {
  const posts = [];
  const store = createStore({
    [AUTOFARM_SNAPSHOT_KEY]: { version: 1, targets: [], settings: {}, active: false },
    [COMMAND_KEY]: {
      version: 1,
      visitId: 'adv-drain',
      taskId: 'adventurers',
      phase: 'draining',
      returnPath: '/pvp.php',
      issuedAt: NOW - 1_000,
      deadlineAt: NOW + 60_000,
    },
  });
  const win = {
    location: {
      href: 'https://demonicscans.org/adventurers_guild.php?veyra_route=adventurers',
      origin: 'https://demonicscans.org',
    },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const worker = createAdventurersWorker({
    win,
    doc: guildDocument('available', 0, 1),
    store,
    fetchDocument: async () => guildDocument('available', 0, 1),
    postForm: async (url, params, options) => {
      await options?.beforeAttempt?.({ attempt: 0 });
      posts.push({ url, params });
      return { ok: true, status: 200, json: { ok: true }, text: '' };
    },
    getUserId: async () => '7',
    sleepImpl: async () => {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  await worker.tick();

  assert.deepEqual(posts, [{ url: AUTO_FARM_PATH, params: { action: 'toggle', enabled: 0 } }]);
  assert.equal(store.read(workerStatusKey('adventurers')).safeToLeave, true);
  assert.notEqual(store.read(AUTOFARM_SNAPSHOT_KEY), null);
});
