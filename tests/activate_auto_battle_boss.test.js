'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../activate_auto_battle_target.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const {
  BOSS_CONFIG,
  BOSS_PHASES,
  createDefaultBossCycleState,
  formatBossCheckCountdown,
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

function createDocument({ nodes = {}, nodeLists = {} } = {}) {
  const documentElement = { dataset: {} };
  const elementsById = new Map();

  return {
    documentElement,
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
    registerElement(element) {
      if (element?.id) elementsById.set(String(element.id), element);
    },
  };
}

function bossState(overrides = {}, now = FIXED_NOW) {
  return {
    ...createDefaultBossCycleState(now),
    active: true,
    phase: BOSS_PHASES.checking,
    cycleStartedAt: now - 1_000,
    phaseUpdatedAt: now - 1_000,
    nextCheckAt: now - 1,
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
  href = 'https://demonicscans.org/pvp.php',
  localStorage = createStorage(),
  sessionStorage = createStorage(),
  now = FIXED_NOW,
}) {
  const timers = createTimers();
  const navigation = { replacedWith: null, reloads: 0 };
  const url = new URL(href);

  class FixedDate extends Date {
    static now() {
      return now;
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
    addEventListener() {},
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

  return { localStorage, navigation, timers };
}

function createLobbyDocument(tokens = 1) {
  const title = { textContent: 'Solo Ladder' };
  const label = { textContent: 'Tokens:' };
  const value = { textContent: String(tokens) };
  const pill = {
    children: [label, value],
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
      throw new Error('matchmaking must not start while the boss check is due');
    },
  };

  const document = createDocument({
    nodes: { '.js-matchmake[data-ladder="solo"]': matchButton },
    nodeLists: { section: [section] },
  });
  pill.appendChild = (element) => {
    element.parentElement = pill;
    pill.children.push(element);
    document.registerElement(element);
  };
  document.soloTokenPill = pill;
  document.soloTokenValue = value;
  return document;
}

function createRunningPvpDocument() {
  const activeClassList = { contains: (name) => name === 'active' };
  const inactiveClassList = { contains: () => false };
  const nodes = {
    '#fastEnemyBtn': {
      disabled: false,
      classList: activeClassList,
      getAttribute: () => null,
      textContent: 'Enemy Turns 1s: ON',
    },
    '#battleControlCard': {},
    '#enemyFormation': {},
    '#matchStatusBadge': { textContent: 'Battle in progress' },
    '#rewardsModal': { classList: inactiveClassList },
    '#allyFormation .pSlot[data-side="ally"][data-alive="1"]': { dataset: { username: 'Hero' } },
    '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)': {},
  };
  const document = createDocument({ nodes });
  const targetHint = {};
  const combatTokenPanel = {
    children: [],
    querySelector(selector) {
      return selector === '#targetHint' ? targetHint : null;
    },
    insertBefore(element) {
      element.parentElement = combatTokenPanel;
      combatTokenPanel.children.push(element);
      document.registerElement(element);
    },
    appendChild(element) {
      element.parentElement = combatTokenPanel;
      combatTokenPanel.children.push(element);
      document.registerElement(element);
    },
  };
  const tokenValue = {
    textContent: '40',
    closest(selector) {
      return selector === '.combatTokenPanel' ? combatTokenPanel : null;
    },
  };
  nodes['#myTokens'] = tokenValue;
  document.combatTokenPanel = combatTokenPanel;
  document.combatTokenValue = tokenValue;

  return document;
}

test('metadata covers the Grakthar wave and monster battle routes', () => {
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/active_wave\.php\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/battle\.php\*$/m);
});

test('the first boss check is scheduled for 30 minutes after initialization', () => {
  const state = createDefaultBossCycleState(FIXED_NOW);

  assert.equal(state.active, false);
  assert.equal(state.nextCheckAt, FIXED_NOW + 30 * 60 * 1000);
});

test('formats the time until the next boss check without negative countdowns', () => {
  const waiting = createDefaultBossCycleState(FIXED_NOW);

  assert.equal(formatBossCheckCountdown(waiting, FIXED_NOW), 'Bossprüfung in 30:00');
  assert.equal(
    formatBossCheckCountdown({ ...waiting, nextCheckAt: FIXED_NOW + 90_001 }, FIXED_NOW),
    'Bossprüfung in 01:31',
  );
  assert.equal(
    formatBossCheckCountdown({ ...waiting, nextCheckAt: FIXED_NOW - 1 }, FIXED_NOW),
    'Bossprüfung jetzt',
  );
  assert.equal(
    formatBossCheckCountdown({ ...waiting, active: true, nextCheckAt: FIXED_NOW - 1 }, FIXED_NOW),
    'Bossprüfung läuft',
  );
});

test('shows one boss countdown directly in the Solo token pill', () => {
  const state = {
    ...createDefaultBossCycleState(FIXED_NOW),
    nextCheckAt: FIXED_NOW + 90_001,
  };
  const storage = storageWithBossState(state);
  const document = createLobbyDocument(0);
  const { timers } = runUserscript({ document, localStorage: storage });

  timers.run(40);
  const countdown = document.getElementById('tm-boss-check-countdown');
  assert.ok(countdown);
  assert.equal(countdown.parentElement, document.soloTokenPill);
  assert.equal(countdown.textContent, 'Bossprüfung in 01:31');
  assert.equal(document.soloTokenValue.textContent, '0');

  timers.runInterval(200);
  timers.run(40);
  assert.equal(
    document.soloTokenPill.children.filter((element) => element.id === 'tm-boss-check-countdown').length,
    1,
  );
});

test('shows the boss countdown inside the PvP combat token panel', () => {
  const storage = storageWithBossState(createDefaultBossCycleState(FIXED_NOW));
  const document = createRunningPvpDocument();
  const { timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/pvp_battle.php?match_id=44',
    localStorage: storage,
  });

  timers.run(40);
  const countdown = document.getElementById('tm-boss-check-countdown');
  assert.ok(countdown);
  assert.equal(countdown.parentElement, document.combatTokenPanel);
  assert.equal(countdown.textContent, 'Bossprüfung in 30:00');
  assert.equal(document.combatTokenValue.textContent, '40');
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

test('a due boss check leaves the PvP lobby for Grakthar Wave 3', () => {
  const dueState = createDefaultBossCycleState(FIXED_NOW);
  dueState.nextCheckAt = FIXED_NOW - 1;
  const storage = storageWithBossState(dueState);
  const document = createLobbyDocument(2);
  const { navigation, timers } = runUserscript({ document, localStorage: storage });

  timers.run(40);

  assert.equal(
    navigation.replacedWith,
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  );
  const state = readBossState(storage);
  assert.equal(state.active, true);
  assert.equal(state.phase, BOSS_PHASES.checking);
});

test('a due boss check never interrupts an ongoing PvP battle', () => {
  const dueState = createDefaultBossCycleState(FIXED_NOW);
  dueState.nextCheckAt = FIXED_NOW - 1;
  const storage = storageWithBossState(dueState);
  const document = createRunningPvpDocument();
  const { navigation, timers } = runUserscript({
    document,
    href: 'https://demonicscans.org/pvp_battle.php?match_id=77',
    localStorage: storage,
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, null);
  assert.equal(document.documentElement.dataset.veyraSmartPvp, '1');
  const state = readBossState(storage);
  assert.equal(state.active, false);
  assert.equal(state.nextCheckAt, FIXED_NOW - 1);
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

test('returns to PvP when every living boss already has 3b damage', () => {
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

  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
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

  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
  assert.equal(readBossState(storage).active, false);
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

test('an empty wave hub returns to PvP and schedules the next check in 30 minutes', () => {
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
  });

  timers.run(40);

  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
  const state = readBossState(storage);
  assert.equal(state.active, false);
  assert.equal(state.phase, BOSS_PHASES.idle);
  assert.equal(state.nextCheckAt, FIXED_NOW + 30 * 60 * 1000);
});
