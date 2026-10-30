'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { RUNTIME_KEY, createDefaultRuntime } = require('../src/scheduler/runtime');
const {
  CRUCIBLE_PVP_WATCH_KEY,
  createCruciblePvpWatcher,
  visitPvpRewardPage,
  watchPvpLobby,
  watchPvpMatch,
} = require('../src/features/automation/crucible-pvp-watch');

const NOW = 1_800_000_000_000;

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
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

function element({ text = '', one = {}, many = {} } = {}) {
  return {
    textContent: text,
    getAttribute() {
      return null;
    },
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
}

function documentWith({ one = {}, many = {} } = {}) {
  return {
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
}

function pvpSlot(name = '') {
  return element({ one: { '.name': name ? element({ text: name }) : null, '.selfMark': null } });
}

function openLobby() {
  const card = element({
    one: {
      '.meta': element({ text: 'Match #4 / Slots 4/5 Waiting' }),
      'a[href*="pvp_style_battle.php"]': element(),
    },
    many: {
      '.slots .slot': [pvpSlot('One'), pvpSlot('Two'), pvpSlot('Three'), pvpSlot('Four'), pvpSlot()],
      '.badge': [element({ text: 'OPEN' })],
    },
  });
  return documentWith({ many: { '.grid > .match': [card] } });
}

function createEnvironment({ fetchDocument, fetchJson, visitRewardPage } = {}) {
  const config = createDefaultConfig();
  config.enabled = true;
  config.routes.crucible.enabled = true;
  config.routes.crucible.settings.pvp.enabled = true;
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.crucible = NOW + 60 * 60_000;
  const store = createStore({ [CONFIG_KEY]: config, [RUNTIME_KEY]: runtime });
  const win = {
    location: { origin: 'https://demonicscans.org' },
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
  const watcher = createCruciblePvpWatcher({
    win,
    store,
    fetchDocument: fetchDocument || (async () => { throw new Error('Unexpected document fetch'); }),
    fetchJson: fetchJson || (async () => { throw new Error('Unexpected JSON fetch'); }),
    visitRewardPage: visitRewardPage || (async () => { throw new Error('Unexpected reward page visit'); }),
    now: () => NOW,
    ownsSchedulerLease: () => true,
    logger: null,
  });
  return { store, watcher };
}

test('reward visit uses a hidden real document and waits for its victory modal', async () => {
  const scripts = [element({
    text: `const SOURCE_PARAMS = {"instance_id":"16219","node_id":"7","match_no":"7"};
      const ROOM_STATUS = "cleared";
      const PVP_REWARD_ITEMS = [{"item_id":251,"qty":1},{"item_id":337,"qty":35}];`,
  })];
  const rewardDoc = documentWith({ many: { script: scripts } });
  rewardDoc.getElementById = (id) => id === 'rewardsModal' ? {
    classList: { contains: (name) => name === 'show' },
    getAttribute: (name) => name === 'aria-hidden' ? 'false' : null,
  } : null;
  const listeners = {};
  let removed = false;
  const frame = {
    contentDocument: rewardDoc,
    hidden: false,
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener(type, callback) {
      listeners[type] = callback;
    },
    remove() {
      removed = true;
    },
  };
  const doc = {
    body: {
      appendChild(candidate) {
        assert.equal(candidate, frame);
        queueMicrotask(() => listeners.load());
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'iframe');
      return frame;
    },
  };
  const win = {
    location: { origin: 'https://demonicscans.org' },
    setTimeout,
    clearTimeout,
  };

  const result = await visitPvpRewardPage(
    win,
    doc,
    'https://demonicscans.org/pvp_style_battle.php?source=cube&instance_id=16219&node_id=7&match_no=7',
    { instanceId: 16219, nodeId: 7, matchNo: 7 },
    { timeoutMs: 1_000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.rewardModalShown, true);
  assert.equal(frame.hidden, true);
  assert.equal(removed, true);
});

test('reward visit accepts the verified cleared page when its already-seen modal stays hidden', async () => {
  const rewardDoc = documentWith({
    many: {
      script: [element({
        text: `const SOURCE_PARAMS = {"instance_id":"16219","node_id":"7","match_no":"7"};
          const ROOM_STATUS = "cleared";
          const PVP_REWARD_ITEMS = [{"item_id":337,"qty":35}];`,
      })],
    },
  });
  rewardDoc.getElementById = () => ({
    classList: { contains: () => false },
    getAttribute: () => 'true',
  });
  const listeners = {};
  let timeoutCallback = null;
  const frame = {
    contentDocument: rewardDoc,
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener(type, callback) { listeners[type] = callback; },
    remove() {},
  };
  const win = {
    location: { origin: 'https://demonicscans.org' },
    setTimeout(callback, delay) {
      if (delay >= 1000) timeoutCallback = callback;
      return delay;
    },
    clearTimeout() {},
  };
  const doc = {
    body: {
      appendChild() {
        listeners.load();
        timeoutCallback();
      },
    },
    createElement() { return frame; },
  };

  const result = await visitPvpRewardPage(
    win,
    doc,
    'https://demonicscans.org/pvp_style_battle.php?source=cube&instance_id=16219&node_id=7&match_no=7',
    { instanceId: 16219, nodeId: 7, matchNo: 7 },
    { timeoutMs: 1000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.rewardModalShown, false);
  assert.equal(result.rewardPageVerified, true);
});

test('background watcher extends a binding cooldown without waking or navigating', async () => {
  let reads = 0;
  const env = createEnvironment({
    fetchDocument: async () => {
      reads += 1;
      return documentWith({ one: { '.warn': element({ text: 'Committed for about 01:59:55 more.' }) } });
    },
  });
  watchPvpLobby(env.store, {
    instanceId: 16126,
    nodeId: 7,
    nodeKey: 'ring_ward',
    nodeName: 'Ring Ward',
    nextCheckAt: NOW,
  }, NOW);

  await env.watcher.tick();

  assert.equal(reads, 1);
  assert.equal(env.store.read(CRUCIBLE_PVP_WATCH_KEY).nextCheckAt, NOW + 7_195_000);
  assert.equal(env.store.read(RUNTIME_KEY).nextRunAt.crucible, NOW + 60 * 60_000);
});

test('background watcher wakes Crucible immediately when a PvP slot is available', async () => {
  const env = createEnvironment({ fetchDocument: async () => openLobby() });
  watchPvpLobby(env.store, {
    instanceId: 16126,
    nodeId: 7,
    nodeKey: 'ring_ward',
    nodeName: 'Ring Ward',
    nextCheckAt: NOW,
  }, NOW);

  await env.watcher.tick();

  assert.equal(env.store.read(RUNTIME_KEY).nextRunAt.crucible, NOW);
  assert.match(env.store.read(RUNTIME_KEY).notes.crucible, /slot ready/i);
});

test('background watcher polls a live match and wakes Crucible for its won reward', async () => {
  let requested = '';
  let rewardPageRequested = '';
  const env = createEnvironment({
    visitRewardPage: async (url, expected) => {
      rewardPageRequested = url;
      assert.equal(expected.matchNo, '2');
      return { ok: true, rewardItems: [{ item_id: 337, qty: 50 }], rewardModalShown: true };
    },
    fetchJson: async (url) => {
      requested = url;
      return {
        ok: true,
        json: { ok: true, room_status: 'cleared', room_joined: true, match: { ended: true, winner_side: 'ally' } },
      };
    },
  });
  watchPvpMatch(env.store, {
    instanceId: 16126,
    nodeId: 7,
    nodeKey: 'ring_ward',
    nodeName: 'Ring Ward',
    matchNo: 2,
    nextCheckAt: NOW,
  }, NOW);

  await env.watcher.tick();

  assert.match(requested, /pvp_style_state\.php/);
  assert.match(requested, /match_no=2/);
  assert.match(rewardPageRequested, /pvp_style_battle\.php/);
  assert.match(rewardPageRequested, /match_no=2/);
  assert.equal(env.store.read(RUNTIME_KEY).nextRunAt.crucible, NOW);
  assert.match(env.store.read(RUNTIME_KEY).notes.crucible, /reward collected/i);
  assert.equal(env.store.read(CRUCIBLE_PVP_WATCH_KEY).mode, 'lobby');
});

test('background watcher never opens the reward page before the joined match has ended', async () => {
  let rewardPageReads = 0;
  const env = createEnvironment({
    visitRewardPage: async () => {
      rewardPageReads += 1;
      throw new Error('The battle page must not be opened while the match is waiting.');
    },
    fetchJson: async () => ({
      ok: true,
      json: { ok: true, room_status: 'open', room_joined: true, match: { ended: false, winner_side: '' } },
    }),
  });
  watchPvpMatch(env.store, {
    instanceId: 16219,
    nodeId: 7,
    nodeKey: 'ring_ward',
    nodeName: 'Ring Ward',
    matchNo: 7,
    nextCheckAt: NOW,
  }, NOW);

  await env.watcher.tick();

  assert.equal(rewardPageReads, 0);
  const watch = env.store.read(CRUCIBLE_PVP_WATCH_KEY);
  assert.equal(watch.mode, 'match');
  assert.equal(watch.nextCheckAt, NOW + 15_000);
});
