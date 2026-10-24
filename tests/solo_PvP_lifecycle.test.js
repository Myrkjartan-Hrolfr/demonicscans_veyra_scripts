'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptSource = fs.readFileSync(path.resolve(__dirname, '../solo_PvP.js'), 'utf8');

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
    hasTimeout(delay) {
      return timeouts.some((entry) => !entry.cleared && entry.delay === delay);
    },
    runTimeout(delay) {
      const entry = timeouts.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms timeout`);
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

function createBattleDocument(statusText = 'Allied victory') {
  const matchStatus = { textContent: statusText };
  const nodes = new Map([
    ['#matchStatusBadge', matchStatus],
    ['#rewardsModal', { classList: { contains: () => false } }],
  ]);

  return {
    body: null,
    title: 'Solo PvP Match',
    documentElement: { dataset: {} },
    matchStatus,
    getElementById() {
      return null;
    },
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function runUserscript(document) {
  const timers = createTimers();
  const navigation = { replacedWith: null };
  const window = {
    ...timers.api,
    location: {
      href: 'https://demonicscans.org/pvp_battle.php?match_id=1',
      origin: 'https://demonicscans.org',
      pathname: '/pvp_battle.php',
      replace(url) {
        navigation.replacedWith = url;
      },
    },
  };

  vm.runInNewContext(scriptSource, {
    AbortController,
    DOMParser: class DOMParserStub {},
    URL,
    console: { info() {}, warn() {} },
    document,
    window,
  });

  return { navigation, timers };
}

test('legacy Solo PvP rechecks a scheduled lobby return', () => {
  const document = createBattleDocument();
  const { navigation, timers } = runUserscript(document);

  assert.equal(timers.hasTimeout(3000), true);
  document.matchStatus.textContent = 'Battle in progress';
  timers.runTimeout(3000);
  assert.equal(navigation.replacedWith, null);
});

test('legacy Solo PvP cancels its lobby timer when Smart Battle takes ownership', () => {
  const document = createBattleDocument();
  const { navigation, timers } = runUserscript(document);

  assert.equal(timers.hasTimeout(3000), true);
  document.documentElement.dataset.veyraSmartPvpLifecycle = '1';
  timers.runInterval(750);
  assert.equal(timers.hasTimeout(3000), false);
  assert.equal(navigation.replacedWith, null);
});

test('legacy Solo PvP still returns a genuinely ended battle to the lobby', () => {
  const document = createBattleDocument();
  const { navigation, timers } = runUserscript(document);

  timers.runTimeout(3000);
  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
});
