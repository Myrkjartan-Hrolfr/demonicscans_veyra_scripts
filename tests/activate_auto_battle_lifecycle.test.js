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

function createTimers() {
  let nextId = 1;
  const timeouts = [];

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
      setInterval() {
        return nextId++;
      },
      clearInterval() {},
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
  };
}

function runUserscript(document, locationOverrides = {}, environment = {}) {
  const timers = createTimers();
  const navigation = { replacedWith: null, reloads: 0 };
  const window = {
    ...timers.api,
    addEventListener() {},
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
    DOMParser: environment.DOMParser || class DOMParserStub {},
    MutationObserver: MutationObserverStub,
    URL,
    console: { info() {}, warn() {}, error() {} },
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
    get matchClicks() {
      return matchClicks;
    },
  };
}

function createEndedBattleDocument() {
  const nodes = new Map([
    ['#fastEnemyBtn', {}],
    ['#battleControlCard', {}],
    ['#enemyFormation', {}],
    ['#matchStatusBadge', { textContent: 'Allied victory' }],
    ['#rewardsModal', { classList: { contains: () => false } }],
    ['#allyFormation .pSlot[data-side="ally"][data-alive="1"]', {}],
  ]);
  const documentElement = { dataset: {} };

  return {
    documentElement,
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

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
