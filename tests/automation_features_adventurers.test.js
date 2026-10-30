'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LOOT_GUARD_KEY } = require('../src/core/loot-guard');
const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { routeIdForUrl } = require('../src/scheduler/runtime');
const adventurersRoute = require('../src/routes/adventurers');
const { ROUTES } = require('../src/routes');
const logic = require('../src/features/automation/adventurers-logic');
const {
  ACCEPT_PATH,
  AUTOFARM_SNAPSHOT_KEY,
  AUTO_FARM_PATH,
  FINISH_PATH,
  LOOT_PATH,
  createAdventurersWorker,
} = require('../src/features/automation/adventurers-worker');

const NOW = 1_800_000_000_000;

function element({ text = '', attrs = {}, dataset = {}, value = '', selected = false, disabled = false, one = {}, many = {} } = {}) {
  return {
    textContent: text,
    dataset,
    value,
    selected,
    disabled,
    classList: { contains: () => false },
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

function deadCard({ id = '1001', damage = '5000000', expiresAt = NOW + 60_000 } = {}) {
  return element({
    dataset: {
      monsterId: id,
      name: 'kraken',
      userdmg: damage,
      dead: '1',
      eligible: '1',
      expire: String(Math.floor(expiresAt / 1_000)),
    },
  });
}

function waveDocument(cards = [deadCard()]) {
  return documentWith({ many: { '.monster-card[data-dead="1"]': cards, '.unclaimed-pill': [] } });
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

test("Adventurer's Guild route is distinct and disabled by default", () => {
  assert.equal(ROUTES.adventurers, adventurersRoute);
  assert.equal(routeIdForUrl('/adventurers_guild.php?veyra_route=adventurers'), 'adventurers');
  assert.equal(routeIdForUrl('/adventurers_guild.php'), null);
  assert.equal(createDefaultConfig().routes.adventurers.enabled, false);
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

test('worker accepts, loots and finishes a ready quest without ever giving it up', async () => {
  let state = 'available';
  let progress = 0;
  const posts = [];
  const config = createDefaultConfig();
  config.routes.adventurers.enabled = true;
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
  const worker = createAdventurersWorker({
    win,
    doc: pageDoc,
    store,
    fetchDocument: async (url) =>
      String(url).includes('active_wave.php') ? waveDocument() : guildDocument(state, progress, 1),
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

  assert.deepEqual(posts.map((entry) => entry.url), [ACCEPT_PATH, LOOT_PATH, FINISH_PATH]);
  assert.equal(posts.some((entry) => /giveup/i.test(entry.url)), false);
  assert.deepEqual(store.read(LOOT_GUARD_KEY), { names: [] });
  const status = store.read(workerStatusKey('adventurers'));
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
