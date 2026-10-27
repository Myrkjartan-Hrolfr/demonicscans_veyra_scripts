'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../wave_3_boss_manager.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');
const monsterAutoBattleSource = fs.readFileSync(
  path.resolve(__dirname, '../monster_auto_battle.js'),
  'utf8',
);

const {
  BOSS_CONFIG,
  BOSS_PHASES,
  COMMAND_KEY,
  STATUS_KEY,
  createDefaultBossCycleState,
  isFightableBossData,
  isMonsterAutoBattleSuccess,
} = require(scriptPath);

const FIXED_NOW = 1_800_000_000_000;

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));

  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function createTimers() {
  let nextId = 1;
  const timeouts = [];
  const intervals = [];

  return {
    api: {
      setTimeout(callback, delay) {
        const entry = { id: nextId++, callback, delay, cleared: false };
        timeouts.push(entry);
        return entry.id;
      },
      clearTimeout(id) {
        const entry = timeouts.find((candidate) => candidate.id === id);
        if (entry) entry.cleared = true;
      },
      setInterval(callback, delay) {
        const entry = { id: nextId++, callback, delay, cleared: false };
        intervals.push(entry);
        return entry.id;
      },
      clearInterval(id) {
        const entry = intervals.find((candidate) => candidate.id === id);
        if (entry) entry.cleared = true;
      },
    },
    run(delay) {
      const entry = timeouts.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms timer`);
      entry.cleared = true;
      entry.callback();
    },
    runInterval(delay) {
      const entry = intervals.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms interval`);
      entry.callback();
    },
  };
}

function createDocument({
  nodes = {},
  nodeLists = {},
  cookies = {
    hide_dead_monsters: '1',
    show_dead_bosses_only: '0',
  },
} = {}) {
  const documentElement = { dataset: {} };
  const elementsById = new Map();
  const eventListeners = new Map();
  const cookieValues = new Map(
    Object.entries(cookies).map(([key, value]) => [String(key), String(value)]),
  );

  const document = {
    documentElement,
    hidden: false,
    visibilityState: 'visible',
    createElement(tagName) {
      return {
        tagName: String(tagName || '').toUpperCase(),
        id: '',
        dataset: {},
        style: { cssText: '' },
        textContent: '',
        parentElement: null,
        setAttribute() {},
      };
    },
    getElementById(id) {
      return elementsById.get(String(id)) || null;
    },
    querySelector(selector) {
      return nodes[selector] || null;
    },
    querySelectorAll(selector) {
      return nodeLists[selector] || [];
    },
    addEventListener(type, listener) {
      const listeners = eventListeners.get(type) || [];
      listeners.push(listener);
      eventListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = eventListeners.get(type) || [];
      eventListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    },
    dispatchEvent(event) {
      for (const listener of eventListeners.get(event?.type) || []) listener.call(this, event);
      return true;
    },
    registerElement(element) {
      if (element?.id) elementsById.set(String(element.id), element);
    },
  };

  Object.defineProperty(document, 'cookie', {
    get() {
      return [...cookieValues].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    set(serialized) {
      const [pair] = String(serialized || '').split(';');
      const separator = pair.indexOf('=');
      if (separator < 0) return;
      cookieValues.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    },
  });

  document.cookieValues = cookieValues;
  return document;
}

function bossState(overrides = {}, now = FIXED_NOW) {
  return {
    ...createDefaultBossCycleState(now),
    active: true,
    phase: BOSS_PHASES.checking,
    cycleStartedAt: now - 1_000,
    phaseUpdatedAt: now - 1_000,
    ...overrides,
  };
}

function storageWithBossState(state) {
  return createStorage({ [BOSS_CONFIG.storageKey]: JSON.stringify(state) });
}

function readBossState(storage) {
  return JSON.parse(storage.getItem(BOSS_CONFIG.storageKey));
}

function runUserscript({
  document,
  href = 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  localStorage = createStorage(),
  sessionStorage = createStorage(),
  navigator: navigatorObject,
  now = FIXED_NOW,
}) {
  const timers = createTimers();
  const navigation = { replacedWith: null, reloads: 0 };
  const url = new URL(href);
  const windowEventListeners = new Map();

  class FixedDate extends Date {
    static now() {
      return typeof now === 'function' ? now() : now;
    }
  }

  class EventStub {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles === true;
    }
  }

  const window = {
    ...timers.api,
    Event: EventStub,
    navigator: navigatorObject,
    addEventListener(type, listener) {
      const listeners = windowEventListeners.get(type) || [];
      listeners.push(listener);
      windowEventListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = windowEventListeners.get(type) || [];
      windowEventListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    },
    dispatchEvent(event) {
      for (const listener of windowEventListeners.get(event?.type) || []) listener.call(window, event);
      return true;
    },
    fetch() {
      throw new Error('unexpected fetch');
    },
    localStorage,
    sessionStorage,
    location: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      replace(nextUrl) {
        navigation.replacedWith = nextUrl;
      },
      reload() {
        navigation.reloads += 1;
      },
    },
  };

  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }

  vm.runInNewContext(scriptSource, {
    AbortController,
    DOMParser: class DOMParserStub {},
    Date: FixedDate,
    Event: EventStub,
    MutationObserver: MutationObserverStub,
    URL,
    console: { info() {}, warn() {}, error() {} },
    document,
    window,
  });

  return { localStorage, navigation, timers, window };
}

test('metadata covers the Grakthar wave and monster battle routes', () => {
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/active_wave\.php\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/battle\.php\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/www\.demonicscans\.org\/active_wave\.php\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/www\.demonicscans\.org\/battle\.php\*$/m);
  assert.match(
    monsterAutoBattleSource,
    /^\/\/ @match\s+https:\/\/www\.demonicscans\.org\/battle\.php\*$/m,
  );
});

test('a private Wave 3 run starts inactive without scheduler fields', () => {
  const state = createDefaultBossCycleState(FIXED_NOW);

  assert.equal(state.active, false);
  assert.equal(state.visitId, '');
  assert.equal('nextCheckAt' in state, false);
});

test('a matching running command starts a private run and publishes busy status', () => {
  const visitId = 'wave-visit-17';
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'wave3',
      visitId,
      phase: 'running',
      issuedAt: FIXED_NOW,
    }),
  });
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { timers } = runUserscript({
    document,
    href: `https://demonicscans.org/active_wave.php?gate=3&wave=8&veyra_visit=${visitId}`,
    localStorage: storage,
  });

  timers.run(40);

  const state = readBossState(storage);
  assert.equal(state.active, true);
  assert.equal(state.visitId, visitId);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.workerId, 'wave3');
  assert.equal(status.visitId, visitId);
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
});

test('a reloaded page does not restart a visit that already published a terminal status', () => {
  const visitId = 'already-finished-visit';
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'wave3',
      visitId,
      phase: 'running',
    }),
    [STATUS_KEY]: JSON.stringify({
      version: 1,
      workerId: 'wave3',
      visitId,
      state: 'done',
      safeToLeave: true,
      updatedAt: FIXED_NOW - 500,
      message: 'Already complete.',
    }),
  });
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(readBossState(storage).active, false);
  assert.equal(navigation.replacedWith, null);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'done');
  assert.equal(status.visitId, visitId);
});

test('a foreign draining command blocks a standalone Wave 3 scan', () => {
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'pvp',
      visitId: 'pvp-visit-4',
      phase: 'draining',
    }),
  });
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(readBossState(storage).active, false);
  assert.equal(navigation.replacedWith, null);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'idle');
  assert.equal(status.safeToLeave, true);
});

test('a foreign running command also blocks a standalone Wave 3 scan', () => {
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'pvp',
      visitId: 'pvp-running-visit',
      phase: 'running',
    }),
  });
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(readBossState(storage).active, false);
  assert.equal(navigation.replacedWith, null);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'idle');
});

test('a direct Wave 3 visit performs one standalone scan without a command', () => {
  const storage = createStorage();
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  const state = readBossState(storage);
  assert.equal(state.active, true);
  assert.equal(state.visitId, '');
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'busy');
});

test('busy worker status is refreshed as a five-second heartbeat', () => {
  let currentNow = FIXED_NOW;
  const visitId = 'heartbeat-visit';
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'wave3',
      visitId,
      phase: 'running',
    }),
  });
  const document = createDocument({ nodes: { '.monster-container': {} } });
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
    now: () => currentNow,
  });

  timers.run(40);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).updatedAt, FIXED_NOW);

  currentNow += 5_000;
  timers.runInterval(200);
  timers.run(40);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'busy');
  assert.equal(status.updatedAt, FIXED_NOW + 5_000);
});

test('battle.php is untouched without a private active boss target', () => {
  let startClicks = 0;
  const storage = createStorage();
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabTarget': { value: '0' },
      '#mabStart': {
        disabled: false,
        click() {
          startClicks += 1;
        },
      },
      '#yourDamageValue': { textContent: '0' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(startClicks, 0);
  assert.equal(navigation.replacedWith, null);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'idle');
});

test('recognizes active, alive bosses below the 3b personal-damage target', () => {
  const fightable = { boss: '1', dead: '0', joined: '0', userdmg: '0', monsterId: '4711' };

  assert.equal(isFightableBossData(fightable), true);
  assert.equal(isFightableBossData({ ...fightable, userdmg: undefined }), true);
  assert.equal(isFightableBossData({ ...fightable, joined: '1' }), true);
  assert.equal(isFightableBossData({ ...fightable, userdmg: '2,999,999,999' }), true);
  assert.equal(isFightableBossData({ ...fightable, boss: '0' }), false);
  assert.equal(isFightableBossData({ ...fightable, dead: '1' }), false);
  assert.equal(isFightableBossData({ ...fightable, joined: '1', userdmg: '3,000,000,000' }), false);
  assert.equal(isFightableBossData({ ...fightable, joined: '1', userdmg: '3.1b' }), false);
  assert.equal(isFightableBossData({ ...fightable, monsterId: '' }), false);
});

test('requires the live damage value to confirm the 3b target', () => {
  assert.equal(
    isMonsterAutoBattleSuccess({ statusText: '', damageText: '3b', hpText: '99b / 100b' }),
    true,
  );
  assert.equal(
    isMonsterAutoBattleSuccess({ statusText: 'Damage target of 3b reached', damageText: '', hpText: '' }),
    false,
  );
  assert.equal(
    isMonsterAutoBattleSuccess({
      statusText: 'Damage target of 3b reached',
      damageText: '2.99b',
      hpText: '97b / 100b',
    }),
    false,
  );
  assert.equal(
    isMonsterAutoBattleSuccess({ statusText: '', damageText: '2.99b', hpText: '97b / 100b' }),
    false,
  );
  assert.equal(
    isMonsterAutoBattleSuccess({
      statusText: 'Damage target of 1b reached',
      damageText: '1b',
      hpText: '99b / 100b',
    }),
    false,
  );
});

test('forces the alive-monsters filter before evaluating Wave 3 bosses', () => {
  let joinClicks = 0;
  const joinButton = {
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '811',
      expire: '99',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    cookies: {
      hide_dead_monsters: '0',
      show_dead_bosses_only: '1',
    },
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8&dead_page=4',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 0);
  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  assert.equal(document.cookieValues.get('hide_dead_monsters'), '1');
  assert.equal(document.cookieValues.get('show_dead_bosses_only'), '0');
  assert.equal(readBossState(storage).actionKind, 'wave-filter');

  timers.runInterval(200);
  timers.run(40);
  assert.equal(joinClicks, 0);
});

test('stops reloading when the alive-monsters filter cannot be saved', () => {
  const storage = storageWithBossState(
    bossState({
      actionKind: 'wave-filter',
      actionAt: FIXED_NOW - BOSS_CONFIG.actionRetryMs,
      actionAttempts: BOSS_CONFIG.maxActionAttempts,
    }),
  );
  const document = createDocument({
    cookies: {
      hide_dead_monsters: '0',
      show_dead_bosses_only: '1',
    },
    nodes: { '.monster-container': {} },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.active, false);
  assert.match(state.lastError, /alive-monsters filter could not be saved/i);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'error');
  assert.equal(status.safeToLeave, true);

  timers.runInterval(200);
  timers.run(40);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'error');
});

test('joins the first active boss below 3b on the wave hub', () => {
  let joinClicks = 0;
  const joinButton = {
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '250,000,000',
      monsterId: '812',
      expire: '99',
    },
    querySelector(selector) {
      return selector === '.continue-btn' ? null : null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.equal(state.phase, BOSS_PHASES.joining);
  assert.equal(state.actionKind, 'join');
});

test('recognizes a localized button.join-btn structurally and clicks it only once', () => {
  let joinClicks = 0;
  const joinButton = {
    disabled: false,
    textContent: 'Dem Kampf beitreten',
    classList: { contains: (name) => name === 'join-btn' },
    getAttribute: () => null,
    matches: (selector) => selector.includes('.join-btn'),
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '813',
      expire: '99',
    },
    querySelector(selector) {
      return selector.includes('.join-btn') ? joinButton : null;
    },
    querySelectorAll(selector) {
      if (selector.includes('.join-btn')) return [joinButton];
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);
  timers.runInterval(200);
  timers.run(40);

  assert.equal(joinClicks, 1);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '813');
  assert.equal(state.actionKind, 'join');
  assert.equal(state.actionAttempts, 1);
});

test('does not click or record a disabled Join control and eventually skips it', () => {
  let currentNow = FIXED_NOW;
  let joinClicks = 0;
  const joinButton = {
    disabled: true,
    textContent: 'Join Battle',
    classList: { contains: (name) => name === 'join-btn' },
    getAttribute: () => null,
    matches: (selector) => selector.includes('.join-btn'),
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '814',
      expire: '99',
    },
    querySelector(selector) {
      return selector.includes('.join-btn') ? joinButton : null;
    },
    querySelectorAll(selector) {
      if (selector.includes('.join-btn')) return [joinButton];
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { timers, navigation } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
    now: () => currentNow,
  });

  timers.run(40);

  assert.equal(joinClicks, 0);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '814');
  assert.equal(state.actionKind, '');
  assert.equal(state.actionAttempts, 0);

  currentNow += BOSS_CONFIG.actionTimeoutMs;
  timers.runInterval(200);
  timers.run(40);

  assert.equal(joinClicks, 0);
  assert.equal(navigation.replacedWith, 'https://demonicscans.org/active_wave.php?gate=3&wave=8');
  const timedOutState = readBossState(storage);
  assert.equal(timedOutState.targetBossId, '');
  assert.deepEqual(timedOutState.failedBossIds, ['814']);
});

test('falls back to a direct Join click when navigator.locks fails', async () => {
  for (const failureMode of ['throw', 'reject']) {
    let joinClicks = 0;
    let lockRequests = 0;
    const joinButton = {
      disabled: false,
      textContent: 'Join Battle',
      getAttribute: () => null,
      click() {
        joinClicks += 1;
      },
    };
    const card = {
      dataset: {
        boss: '1',
        dead: '0',
        joined: '0',
        userdmg: '0',
        monsterId: failureMode === 'throw' ? '815' : '816',
        expire: '99',
      },
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        return selector === 'button, a, input[type="button"], input[type="submit"]'
          ? [joinButton]
          : [];
      },
    };
    const storage = storageWithBossState(bossState());
    const document = createDocument({
      nodes: { '.monster-container': {} },
      nodeLists: {
        '.monster-card[data-boss][data-dead][data-monster-id]': [card],
      },
    });
    const navigatorObject = {
      locks: {
        request() {
          lockRequests += 1;
          if (failureMode === 'throw') throw new Error('locks unavailable');
          return Promise.reject(new Error('locks unavailable'));
        },
      },
    };
    const { timers } = runUserscript({
      document,
      href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
      localStorage: storage,
      navigator: navigatorObject,
    });

    timers.run(40);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(lockRequests, 1, failureMode);
    assert.equal(joinClicks, 1, failureMode);
    const state = readBossState(storage);
    assert.equal(state.actionKind, 'join', failureMode);
    assert.equal(state.actionAttempts, 1, failureMode);
  }
});

test('a persisted pagehide followed by pageshow resumes the boss scan', () => {
  let currentNow = FIXED_NOW;
  let joinClicks = 0;
  const joinButton = {
    disabled: false,
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '817',
      expire: '99',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { timers, window } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
    now: () => currentNow,
  });

  window.dispatchEvent({ type: 'pagehide', persisted: true });
  window.dispatchEvent({ type: 'pageshow', persisted: true });
  timers.run(40);
  currentNow += BOSS_CONFIG.hubSettleMs;
  timers.runInterval(200);
  timers.run(40);

  assert.equal(joinClicks, 1);
  assert.equal(readBossState(storage).actionKind, 'join');
});

test('a boss route takes over its active lease after mobile navigation loses sessionStorage', () => {
  let joinClicks = 0;
  const joinButton = {
    disabled: false,
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '818',
      expire: '99',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const storage = storageWithBossState(
    bossState({
      ownerId: 'owner-from-pvp-page',
      leaseUntil: FIXED_NOW + BOSS_CONFIG.leaseMs,
    }),
  );
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const mobileSessionStorage = createStorage();
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
    sessionStorage: mobileSessionStorage,
  });

  timers.run(40);

  assert.equal(joinClicks, 1);
  const state = readBossState(storage);
  assert.equal(state.ownerId, 'owner-from-pvp-page');
  assert.equal(
    mobileSessionStorage.getItem(BOSS_CONFIG.ownerStorageKey),
    'owner-from-pvp-page',
  );
  assert.equal(state.targetBossId, '818');
  assert.equal(state.actionKind, 'join');
});

test('joins an active auto-summon boss even when its monster card reports data-boss zero', () => {
  let joinClicks = 0;
  const joinButton = {
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const bossCard = {
    dataset: {
      boss: '0',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '556650107',
      expire: '1793084522',
      name: 'general skarn the radiant bastion',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton]
        : [];
    },
  };
  const activeBossLink = {
    href: 'https://demonicscans.org/battle.php?id=556650107',
    getAttribute(name) {
      return name === 'href' ? 'battle.php?id=556650107' : null;
    },
  };
  const autoSummonCard = {
    dataset: { alive: '1' },
    querySelector(selector) {
      return selector.includes('battle.php?id=') ? activeBossLink : null;
    },
    querySelectorAll(selector) {
      return selector.includes('battle.php?id=') ? [activeBossLink] : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [bossCard],
      '.auto-summon-card[data-alive="1"]': [autoSummonCard],
      '.auto-summon-card[data-alive="1"] a[href*="battle.php"]': [activeBossLink],
      '.auto-summon-card[data-alive="1"] a[href*="battle.php?id="]': [activeBossLink],
      '.auto-summon-card[data-alive="1"] a[href^="battle.php?id="]': [activeBossLink],
      '.auto-summon-card[data-alive="1"] a[href="battle.php?id=556650107"]': [activeBossLink],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '556650107');
  assert.equal(state.phase, BOSS_PHASES.joining);
  assert.equal(state.actionKind, 'join');
});

test('an already joined partially damaged boss clicks Enter Battle once without joining again', () => {
  let joinClicks = 0;
  let enterClicks = 0;
  const joinButton = {
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const enterButton = {
    textContent: 'Enter Battle',
    getAttribute: () => null,
    click() {
      enterClicks += 1;
    },
  };
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '1',
      userdmg: '2.5b',
      monsterId: '913',
      expire: '99',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [joinButton, enterButton]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(enterClicks, 1);
  assert.equal(joinClicks, 0);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '913');
  assert.equal(state.phase, BOSS_PHASES.entering);
  assert.equal(state.actionKind, 'enter');
  assert.equal(state.actionAttempts, 1);
});

test('skips a boss that already has 3b damage and selects the next fightable boss', () => {
  const completedControl = {
    textContent: 'Enter Battle',
    getAttribute: () => null,
    click() {
      throw new Error('a boss at the damage target must not be entered again');
    },
  };
  let joinClicks = 0;
  const nextJoinControl = {
    textContent: 'Join Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const completedCard = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '1',
      userdmg: '3,000,000,000',
      monsterId: '700',
      expire: '1',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [completedControl]
        : [];
    },
  };
  const nextCard = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '701',
      expire: '2',
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button, a, input[type="button"], input[type="submit"]'
        ? [nextJoinControl]
        : [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [
        completedCard,
        nextCard,
      ],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '701');
});

test('publishes done without cross-page navigation when every living boss already has 3b damage', () => {
  const completedCard = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '1',
      userdmg: '3b',
      monsterId: '700',
      expire: '1',
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [completedCard],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  assert.equal(readBossState(storage).active, false);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
});

test('clearing a completed command does not start a second standalone scan on the same page', () => {
  let currentNow = FIXED_NOW;
  const visitId = 'completed-command';
  const completedCard = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '1',
      userdmg: '3b',
      monsterId: '700',
      expire: '1',
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const storage = createStorage({
    [COMMAND_KEY]: JSON.stringify({
      version: 1,
      taskId: 'wave3',
      visitId,
      phase: 'running',
    }),
  });
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [completedCard],
    },
  });
  const { timers } = runUserscript({
    document,
    href: `https://demonicscans.org/active_wave.php?gate=3&wave=8&veyra_visit=${visitId}`,
    localStorage: storage,
    now: () => currentNow,
  });

  timers.run(40);
  currentNow += BOSS_CONFIG.hubSettleMs;
  timers.runInterval(200);
  timers.run(40);
  assert.equal(readBossState(storage).active, false);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'done');

  storage.removeItem(COMMAND_KEY);
  timers.runInterval(200);
  timers.run(40);
  assert.equal(readBossState(storage).active, false);
});

test('skips a boss that was confirmed not fightable during the current scan', () => {
  const card = {
    dataset: {
      boss: '1',
      dead: '0',
      joined: '0',
      userdmg: '0',
      monsterId: '812',
      expire: '1',
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      throw new Error('a failed boss must not be clicked again during the same scan');
    },
  };
  const storage = storageWithBossState(bossState({ failedBossIds: ['812'] }));
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [card],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  assert.equal(readBossState(storage).active, false);
  assert.equal(JSON.parse(storage.getItem(STATUS_KEY)).state, 'done');
});

test('clicks Join the Battle on battle.php after the wave-hub join', () => {
  let joinClicks = 0;
  const joinButton = {
    disabled: false,
    textContent: 'Join the Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.joining,
      targetBossId: '812',
      actionKind: 'join',
      actionAt: FIXED_NOW - BOSS_CONFIG.actionRetryMs,
      actionAttempts: 1,
    }),
  );
  const document = createDocument({
    nodes: {
      '#join-battle': joinButton,
      '#pHpText': { textContent: '💚 0 / 968,450 HP' },
    },
    nodeLists: {
      'button, a, input[type="button"], input[type="submit"]': [joinButton],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.equal(state.actionKind, 'join-page');
  assert.deepEqual(state.processedBossIds, []);
  assert.deepEqual(state.failedBossIds, []);
});

test('marks a battle-page join as unavailable after bounded attempts', () => {
  let joinClicks = 0;
  const joinButton = {
    disabled: false,
    textContent: 'Join the Battle',
    getAttribute: () => null,
    click() {
      joinClicks += 1;
    },
  };
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.joining,
      targetBossId: '812',
      actionKind: 'join-page',
      actionAt: FIXED_NOW - BOSS_CONFIG.actionTimeoutMs,
      actionAttempts: BOSS_CONFIG.maxActionAttempts,
    }),
  );
  const document = createDocument({
    nodes: { '#join-battle': joinButton },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(joinClicks, 0);
  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  assert.deepEqual(readBossState(storage).failedBossIds, ['812']);
});

test('a disabled battle-page Enter control times out instead of stalling forever', () => {
  let enterClicks = 0;
  const enterButton = {
    disabled: true,
    textContent: 'Enter Battle',
    getAttribute: () => null,
    click() {
      enterClicks += 1;
    },
  };
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.entering,
      phaseUpdatedAt: FIXED_NOW - BOSS_CONFIG.actionTimeoutMs,
      targetBossId: '812',
    }),
  );
  const document = createDocument({
    nodeLists: {
      'button, a, input[type="button"], input[type="submit"]': [enterButton],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(enterClicks, 0);
  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  assert.deepEqual(readBossState(storage).failedBossIds, ['812']);
});

test('uses the page heal-potion button before auto battle when the joined player has 0 HP', () => {
  let healClicks = 0;
  const healButton = {
    disabled: false,
    textContent: '🧪 Use Heal Potion',
    click() {
      healClicks += 1;
    },
  };
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.entering,
      targetBossId: '812',
      actionKind: 'battle-join',
      actionAt: FIXED_NOW - BOSS_CONFIG.actionRetryMs,
      actionAttempts: 1,
    }),
  );
  const document = createDocument({
    nodes: {
      '#pHpText': { textContent: '💚 0 / 968,450 HP' },
      '#usePotionBtn': healButton,
      '#yourDamageValue': { textContent: '0' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(healClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.equal(state.phase, BOSS_PHASES.entering);
  assert.equal(state.actionKind, 'heal');
  assert.deepEqual(state.processedBossIds, []);
  assert.deepEqual(state.failedBossIds, []);
});

test('sets the monster target to 3b before starting auto battle', () => {
  const dispatchedEvents = [];
  const targetInput = {
    value: '100m',
    dispatchEvent(event) {
      dispatchedEvents.push(event.type);
      return true;
    },
  };
  let valueAtStart = null;
  const startButton = {
    disabled: false,
    click() {
      valueAtStart = targetInput.value;
    },
  };
  const storage = storageWithBossState(
    bossState({ phase: BOSS_PHASES.entering, targetBossId: '812' }),
  );
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabTarget': targetInput,
      '#mabStart': startButton,
      '#mabStatus': { textContent: 'Ready' },
      '#yourDamageValue': { textContent: '0' },
      '#hpText': { textContent: '100b / 100b' },
    },
  });
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(targetInput.value, '3b');
  assert.deepEqual(dispatchedEvents, ['input', 'change']);
  assert.equal(valueAtStart, '3b');
  const state = readBossState(storage);
  assert.equal(state.phase, BOSS_PHASES.attacking);
  assert.equal(state.startIssued, true);
});

test('an unverified battle URL never sets 3b or starts Monster Auto Battle', () => {
  const dispatchedEvents = [];
  const targetInput = {
    value: '100m',
    dispatchEvent(event) {
      dispatchedEvents.push(event.type);
      return true;
    },
  };
  let startClicks = 0;
  const startButton = {
    disabled: false,
    click() {
      startClicks += 1;
    },
  };
  const storage = storageWithBossState(
    bossState({ phase: BOSS_PHASES.entering, targetBossId: '812' }),
  );
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabTarget': targetInput,
      '#mabStart': startButton,
      '#mabStatus': { textContent: 'Ready' },
      '#yourDamageValue': { textContent: '0' },
      '#hpText': { textContent: '100b / 100b' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(targetInput.value, '100m');
  assert.deepEqual(dispatchedEvents, []);
  assert.equal(startClicks, 0);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.equal(state.startIssued, false);
});

test('conflicting URL and DOM monster IDs never start Monster Auto Battle', () => {
  const targetInput = {
    value: '100m',
    dispatchEvent() {
      throw new Error('a conflicting monster identity must not change the damage target');
    },
  };
  let startClicks = 0;
  const storage = storageWithBossState(
    bossState({ phase: BOSS_PHASES.entering, targetBossId: '812' }),
  );
  const document = createDocument({
    nodes: {
      '.battle-card.monster-card[data-monster-id]': { dataset: { monsterId: '999' } },
      '#tm-monster-auto-battle': {},
      '#mabTarget': targetInput,
      '#mabStart': {
        disabled: false,
        click() {
          startClicks += 1;
        },
      },
      '#mabStatus': { textContent: 'Ready' },
      '#yourDamageValue': { textContent: '0' },
      '#hpText': { textContent: '100b / 100b' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(targetInput.value, '100m');
  assert.equal(startClicks, 0);
  assert.equal(navigation.replacedWith, null);
});

test('a stopped issued run below 3b starts Monster Auto Battle again', () => {
  const stoppedStatuses = [
    'Stopped manually.',
    'Level-up protection: 123 EXP remains. Stopped before the next attack.',
  ];

  for (const [index, statusText] of stoppedStatuses.entries()) {
    const bossId = String(900 + index);
    let startClicks = 0;
    const targetInput = {
      value: '3b',
      dispatchEvent() {
        throw new Error('the already configured target must not need another input event');
      },
    };
    const startButton = {
      disabled: false,
      click() {
        startClicks += 1;
      },
    };
    const storage = storageWithBossState(
      bossState({
        phase: BOSS_PHASES.attacking,
        targetBossId: bossId,
        actionKind: 'start',
        actionAt: FIXED_NOW - BOSS_CONFIG.actionRetryMs,
        actionAttempts: 1,
        startIssued: true,
      }),
    );
    const document = createDocument({
      nodes: {
        '#tm-monster-auto-battle': {},
        '#mabTarget': targetInput,
        '#mabStart': startButton,
        '#mabStatus': { textContent: statusText },
        '#yourDamageValue': { textContent: '10m' },
        '#hpText': { textContent: '99b / 100b' },
      },
    });
    const { navigation, timers } = runUserscript({
      document,
      href: `https://demonicscans.org/battle.php?id=${bossId}`,
      localStorage: storage,
    });

    timers.run(40);

    assert.equal(startClicks, 1, statusText);
    assert.equal(navigation.replacedWith, null, statusText);
    const state = readBossState(storage);
    assert.deepEqual(state.processedBossIds, [], statusText);
    assert.deepEqual(state.failedBossIds, [], statusText);
    assert.equal(state.targetBossId, bossId, statusText);
    assert.equal(state.phase, BOSS_PHASES.attacking, statusText);
  }
});

test('a stale reached-target status below 3b restarts instead of completing the boss', () => {
  let startClicks = 0;
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.attacking,
      targetBossId: '812',
      actionKind: 'start',
      actionAt: FIXED_NOW - BOSS_CONFIG.actionRetryMs,
      actionAttempts: 1,
      startIssued: true,
    }),
  );
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabTarget': {
        value: '3b',
        dispatchEvent() {
          throw new Error('the already configured target must not need another input event');
        },
      },
      '#mabStart': {
        disabled: false,
        click() {
          startClicks += 1;
        },
      },
      '#mabStatus': { textContent: 'Damage target of 3b reached' },
      '#yourDamageValue': { textContent: '2.99b' },
      '#hpText': { textContent: '99b / 100b' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(startClicks, 1);
  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.deepEqual(state.processedBossIds, []);
  assert.deepEqual(state.failedBossIds, []);
});

test('a completed 3b attack returns to the wave and records the boss', () => {
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.attacking,
      targetBossId: '812',
      startIssued: true,
    }),
  );
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabStatus': { textContent: 'Damage target of 3b reached' },
      '#yourDamageValue': { textContent: '3b' },
      '#hpText': { textContent: '97b / 100b' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  const state = readBossState(storage);
  assert.deepEqual(state.processedBossIds, ['812']);
  assert.equal(state.targetBossId, '');
  assert.equal(state.phase, BOSS_PHASES.returningHub);
});

test('internal navigation preserves the orchestrator visit query', () => {
  const visitId = 'wave-run-with-query';
  const storage = storageWithBossState(
    bossState({
      visitId,
      phase: BOSS_PHASES.attacking,
      targetBossId: '812',
      startIssued: true,
    }),
  );
  const document = createDocument({
    nodes: {
      '#tm-monster-auto-battle': {},
      '#mabStatus': { textContent: 'Damage target of 3b reached' },
      '#yourDamageValue': { textContent: '3b' },
      '#hpText': { textContent: '97b / 100b' },
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: `https://demonicscans.org/battle.php?id=812&veyra_visit=${visitId}`,
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(
    navigation.replacedWith,
    `https://demonicscans.org/active_wave.php?gate=3&wave=8&veyra_visit=${visitId}`,
  );
});

test('a known boss missing from a still-rendering wave is not marked as processed', () => {
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.returningHub,
      phaseUpdatedAt: FIXED_NOW - BOSS_CONFIG.hubSettleMs,
      targetBossId: '812',
    }),
  );
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.targetBossId, '812');
  assert.deepEqual(state.processedBossIds, []);
});

test('reloads Wave 3 instead of returning to PvP when the boss list fails to render', () => {
  const storage = storageWithBossState(
    bossState({ phaseUpdatedAt: FIXED_NOW - BOSS_CONFIG.actionTimeoutMs }),
  );
  const document = createDocument();
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  assert.equal(readBossState(storage).active, true);
});

test('a stale boss fight returns to Wave 3 for another attempt instead of PvP', () => {
  const storage = storageWithBossState(
    bossState({
      phase: BOSS_PHASES.attacking,
      cycleStartedAt: FIXED_NOW - BOSS_CONFIG.cycleTimeoutMs - 1,
      targetBossId: '812',
      startIssued: true,
    }),
  );
  const document = createDocument();
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/battle.php?id=812',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  assert.equal(readBossState(storage).active, true);
});

test('an empty wave hub waits for rendering before publishing done', () => {
  let currentNow = FIXED_NOW;
  const storage = storageWithBossState(bossState());
  const document = createDocument({
    nodes: { '.monster-container': {} },
    nodeLists: {
      '.monster-card[data-boss][data-dead][data-monster-id]': [],
    },
  });
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage: storage,
    now: () => currentNow,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  assert.equal(readBossState(storage).active, true);

  currentNow += BOSS_CONFIG.hubEmptyWaitMs;
  timers.runInterval(200);
  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  const state = readBossState(storage);
  assert.equal(state.active, false);
  assert.equal(state.phase, BOSS_PHASES.idle);
  const status = JSON.parse(storage.getItem(STATUS_KEY));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
});
