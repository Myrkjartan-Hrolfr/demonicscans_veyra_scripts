'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptSource = fs.readFileSync(
  path.resolve(__dirname, '../activate_auto_battle_target.js'),
  'utf8',
);
const { COMMAND_KEY, STATUS_KEY } = require('../activate_auto_battle_target.js');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  const writes = [];

  return {
    writes,
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
      writes.push({ key: String(key), value: String(value) });
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function saveCommand(storage, overrides = {}) {
  const now = Date.now();
  storage.setItem(
    COMMAND_KEY,
    JSON.stringify({
      version: 1,
      visitId: 'visit-1',
      taskId: 'pvp',
      phase: 'running',
      returnPath: '/pvp.php',
      issuedAt: now - 1_000,
      deadlineAt: now + 60_000,
      ...overrides,
    }),
  );
}

function readStatus(storage) {
  return JSON.parse(storage.getItem(STATUS_KEY));
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
    has(delay) {
      return timeouts.some((entry) => !entry.cleared && entry.delay === delay);
    },
    runInterval(delay) {
      const entry = intervals.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms interval`);
      entry.callback();
    },
  };
}

function runUserscript(document, locationOverrides = {}, environment = {}) {
  const timers = createTimers();
  const navigation = { replacedWith: null, reloads: 0 };
  const window = {
    ...timers.api,
    addEventListener() {},
    localStorage: environment.localStorage,
    fetch:
      environment.fetch ||
      (() => {
        throw new Error('unexpected fetch');
      }),
    location: {
      href: 'https://demonicscans.org/pvp.php',
      origin: 'https://demonicscans.org',
      pathname: '/pvp.php',
      replace(url) {
        navigation.replacedWith = url;
      },
      reload() {
        navigation.reloads += 1;
      },
      ...locationOverrides,
    },
  };

  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }

  vm.runInNewContext(scriptSource, {
    AbortController,
    Date: environment.Date || Date,
    DOMParser: environment.DOMParser || class DOMParserStub {},
    MutationObserver: MutationObserverStub,
    URL,
    console: environment.console || { info() {}, warn() {}, error() {} },
    document,
    window,
  });

  return { navigation, timers };
}

function createLobbyDocument(tokens) {
  let matchClicks = 0;
  const title = { textContent: 'Solo Ladder' };
  const label = { textContent: 'Tokens:' };
  const value = { textContent: String(tokens) };
  const pill = {
    querySelector(selector) {
      if (selector === 'strong') return label;
      if (selector === 'span') return value;
      return null;
    },
  };
  const section = {
    querySelector(selector) {
      return selector === '.section-title' ? title : null;
    },
    querySelectorAll(selector) {
      return selector === '.info-pill' ? [pill] : [];
    },
  };
  const matchButton = {
    disabled: false,
    closest() {
      return section;
    },
    click() {
      matchClicks += 1;
      this.disabled = true;
    },
  };
  const documentElement = { dataset: {} };

  return {
    document: {
      documentElement,
      querySelector(selector) {
        if (selector === '.js-matchmake[data-ladder="solo"]') return matchButton;
        return null;
      },
      querySelectorAll(selector) {
        return selector === 'section' ? [section] : [];
      },
    },
    documentElement,
    matchButton,
    get matchClicks() {
      return matchClicks;
    },
  };
}

function createEndedBattleDocument() {
  const matchStatus = { textContent: 'Allied victory' };
  const nodes = new Map([
    [
      '#fastEnemyBtn',
      {
        disabled: false,
        textContent: 'Enemy Turns 1s On',
        classList: { contains: (name) => name === 'active' },
        getAttribute: (name) => (name === 'aria-pressed' ? 'true' : null),
      },
    ],
    ['#battleControlCard', {}],
    ['#enemyFormation', {}],
    ['#matchStatusBadge', matchStatus],
    ['#rewardsModal', { classList: { contains: () => false } }],
    ['#allyFormation .pSlot[data-side="ally"][data-alive="1"]', {}],
  ]);
  const documentElement = { dataset: {} };

  return {
    documentElement,
    matchStatus,
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

test('metadata is limited to apex and www PvP routes', () => {
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/pvp\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/www\.demonicscans\.org\/pvp\*$/m);
  assert.doesNotMatch(scriptSource, /^\/\/ @match\s+.*active_wave/m);
  assert.doesNotMatch(scriptSource, /^\/\/ @match\s+.*\/battle\.php/m);
  assert.match(scriptSource, /^\/\/ @grant\s+none$/m);
  assert.match(scriptSource, /^\/\/ @noframes$/m);
});

test('starts a Solo match from the lobby when a token is available', () => {
  const lobby = createLobbyDocument(17);
  const { timers } = runUserscript(lobby.document);

  assert.equal(lobby.documentElement.dataset.veyraSmartPvpLifecycle, '1');
  timers.run(40);
  timers.run(250);
  assert.equal(lobby.matchClicks, 1);
});

test('waits and schedules a token refresh when the lobby has no token', () => {
  const lobby = createLobbyDocument(0);
  const { timers } = runUserscript(lobby.document);

  timers.run(40);
  assert.equal(lobby.matchClicks, 0);
  assert.equal(timers.has(30_000), true);
});

test('a foreign draining command prevents a new match and reports PvP safe to leave', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, {
    visitId: 'visit-wave3',
    taskId: 'wave3',
    phase: 'draining',
    returnPath: '/pvp.php',
  });
  const lobby = createLobbyDocument(17);
  const { timers } = runUserscript(lobby.document, {}, { localStorage });

  timers.run(40);

  assert.equal(lobby.matchClicks, 0);
  assert.equal(timers.has(250), false);
  assert.deepEqual(
    {
      workerId: readStatus(localStorage).workerId,
      visitId: readStatus(localStorage).visitId,
      state: readStatus(localStorage).state,
      safeToLeave: readStatus(localStorage).safeToLeave,
    },
    { workerId: 'pvp', visitId: '', state: 'idle', safeToLeave: true },
  );
});

test('a draining command for the active PvP visit finishes in the lobby without a new match', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, {
    visitId: 'visit-pvp-drain',
    taskId: 'pvp',
    phase: 'draining',
  });
  const lobby = createLobbyDocument(17);
  const { timers } = runUserscript(lobby.document, {}, { localStorage });

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(lobby.matchClicks, 0);
  assert.equal(timers.has(250), false);
  assert.equal(status.workerId, 'pvp');
  assert.equal(status.visitId, 'visit-pvp-drain');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
});

test('a missing Solo section reports a safe lobby error instead of blocking a drain forever', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, {
    visitId: 'visit-pvp-missing-section',
    taskId: 'pvp',
    phase: 'draining',
  });
  const document = {
    documentElement: { dataset: {} },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const { timers } = runUserscript(document, {}, { localStorage });

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.visitId, 'visit-pvp-missing-section');
  assert.equal(status.state, 'error');
  assert.equal(status.safeToLeave, true);
  assert.equal(timers.has(30_000), false);
});

test('an already active matchmaking request remains unsafe while its PvP visit drains', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, {
    visitId: 'visit-pvp-matchmaking',
    taskId: 'pvp',
    phase: 'draining',
  });
  const lobby = createLobbyDocument(17);
  lobby.matchButton.disabled = true;
  const { timers } = runUserscript(lobby.document, {}, { localStorage });

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.visitId, 'visit-pvp-matchmaking');
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
});

test('a matching scheduled PvP visit completes safely when no token remains', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, { visitId: 'visit-pvp' });
  const lobby = createLobbyDocument(0);
  const { timers } = runUserscript(lobby.document, {}, { localStorage });

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.workerId, 'pvp');
  assert.equal(status.visitId, 'visit-pvp');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(timers.has(30_000), false);
});

test('an unchanged worker status is throttled but refreshed after five seconds', () => {
  let now = 2_000_000;
  class MutableDate extends Date {
    static now() {
      return now;
    }
  }

  const localStorage = createStorage();
  const lobby = createLobbyDocument(0);
  const { timers } = runUserscript(lobby.document, {}, { Date: MutableDate, localStorage });

  timers.run(40);
  assert.equal(localStorage.writes.filter(({ key }) => key === STATUS_KEY).length, 1);

  now += 4_999;
  timers.runInterval(200);
  timers.run(40);
  assert.equal(localStorage.writes.filter(({ key }) => key === STATUS_KEY).length, 1);

  now += 1;
  timers.runInterval(200);
  timers.run(40);
  assert.equal(localStorage.writes.filter(({ key }) => key === STATUS_KEY).length, 2);
  assert.equal(readStatus(localStorage).updatedAt, now);
});

test('refreshes a zero-token lobby when the periodic check finds a token', async () => {
  const currentLobby = createLobbyDocument(0);
  const refreshedLobby = createLobbyDocument(1);
  const { navigation, timers } = runUserscript(currentLobby.document, {}, {
    fetch: async () => ({ ok: true, text: async () => '<html></html>' }),
    DOMParser: class DOMParserStub {
      parseFromString() {
        return refreshedLobby.document;
      }
    },
  });

  timers.run(40);
  timers.run(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigation.reloads, 1);
});

test('returns an ended battle to the PvP lobby', () => {
  const battleDocument = createEndedBattleDocument();
  const { navigation, timers } = runUserscript(battleDocument, {
    href: 'https://demonicscans.org/pvp_battle.php?match_id=1',
    pathname: '/pvp_battle.php',
  });

  timers.run(40);
  assert.equal(battleDocument.documentElement.dataset.veyraSmartPvp, '1');
  timers.run(3000);
  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
});

test('does not treat temporarily missing desktop formation slots as a finished battle', () => {
  const battleDocument = createEndedBattleDocument();
  battleDocument.matchStatus.textContent = 'Battle in progress';
  const { navigation, timers } = runUserscript(battleDocument, {
    href: 'https://demonicscans.org/pvp_battle.php?match_id=2',
    pathname: '/pvp_battle.php',
  });

  timers.run(40);
  assert.equal(timers.has(3000), false);
  assert.equal(navigation.replacedWith, null);
});

test('an active PvP battle reports busy and unsafe to leave for its matching visit', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, { visitId: 'visit-battle' });
  const battleDocument = createEndedBattleDocument();
  battleDocument.matchStatus.textContent = 'Battle in progress';
  const { timers } = runUserscript(
    battleDocument,
    {
      href: 'https://demonicscans.org/pvp_battle.php?match_id=5',
      pathname: '/pvp_battle.php',
    },
    { localStorage },
  );

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.workerId, 'pvp');
  assert.equal(status.visitId, 'visit-battle');
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
});

test('an empty PvP battle DOM remains busy and unsafe while the page is rendering', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, { visitId: 'visit-rendering-battle' });
  const document = {
    documentElement: { dataset: {} },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const { timers } = runUserscript(
    document,
    {
      href: 'https://demonicscans.org/pvp_battle.php?match_id=rendering',
      pathname: '/pvp_battle.php',
    },
    { localStorage },
  );

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.visitId, 'visit-rendering-battle');
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
  assert.equal(timers.has(3000), false);
});

test('a draining PvP visit stays busy until its active battle can return to the lobby', () => {
  const localStorage = createStorage();
  saveCommand(localStorage, { visitId: 'visit-draining-battle', phase: 'draining' });
  const battleDocument = createEndedBattleDocument();
  battleDocument.matchStatus.textContent = 'Battle in progress';
  const { navigation, timers } = runUserscript(
    battleDocument,
    {
      href: 'https://demonicscans.org/pvp_battle.php?match_id=6',
      pathname: '/pvp_battle.php',
    },
    { localStorage },
  );

  timers.run(40);

  const status = readStatus(localStorage);
  assert.equal(status.visitId, 'visit-draining-battle');
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
  assert.equal(navigation.replacedWith, null);
  assert.equal(timers.has(3000), false);
});

test('rechecks the battle before a scheduled desktop lobby return', () => {
  const battleDocument = createEndedBattleDocument();
  const { navigation, timers } = runUserscript(battleDocument, {
    href: 'https://demonicscans.org/pvp_battle.php?match_id=3',
    pathname: '/pvp_battle.php',
  });

  timers.run(40);
  assert.equal(timers.has(3000), true);

  battleDocument.matchStatus.textContent = 'Battle in progress';
  timers.run(3000);
  assert.equal(navigation.replacedWith, null);
});

test('cancels a pending desktop lobby return as soon as the battle is running', () => {
  const battleDocument = createEndedBattleDocument();
  const { navigation, timers } = runUserscript(battleDocument, {
    href: 'https://demonicscans.org/pvp_battle.php?match_id=4',
    pathname: '/pvp_battle.php',
  });

  timers.run(40);
  assert.equal(timers.has(3000), true);

  battleDocument.matchStatus.textContent = 'Battle in progress';
  timers.runInterval(200);
  timers.run(40);
  assert.equal(timers.has(3000), false);
  assert.equal(navigation.replacedWith, null);
});
