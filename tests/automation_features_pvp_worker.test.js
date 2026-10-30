'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY } = require('../src/scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../src/scheduler/engine');
const logic = require('../src/features/automation/pvp-logic');
const {
  MODES,
  TIMING,
  createPvpWorker,
  getLobbySnapshot,
  readSoloTokenCount,
} = require('../src/features/automation/pvp-worker');

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

function command(overrides = {}) {
  return {
    version: 1,
    visitId: 'pvp-visit',
    taskId: 'pvp',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 60_000,
    ...overrides,
  };
}

function pvpConfig(mode = MODES.autoplay) {
  return {
    version: 1,
    enabled: true,
    homeRouteId: 'pvp',
    routes: { pvp: { enabled: true, loopMinutes: 5, settings: { mode } } },
  };
}

function createWindow(pathname) {
  const timers = [];
  const listeners = new Map();
  const navigation = { replacedWith: null };
  const location = {
    origin: 'https://demonicscans.org',
    href: `https://demonicscans.org${pathname}`,
    pathname,
    replace(value) {
      navigation.replacedWith = value;
    },
  };
  return {
    navigation,
    timers,
    win: {
      location,
      setInterval() {
        return 1;
      },
      clearInterval() {},
      setTimeout(callback, delay) {
        timers.push({ callback, delay, cleared: false });
        return timers.length;
      },
      clearTimeout(id) {
        if (timers[id - 1]) timers[id - 1].cleared = true;
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    },
  };
}

function createDocument(nodes = {}, nodeLists = {}) {
  return {
    hidden: false,
    visibilityState: 'visible',
    documentElement: { dataset: {} },
    querySelector(selector) {
      return nodes[selector] || null;
    },
    querySelectorAll(selector) {
      return nodeLists[selector] || [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function createLobby(tokens) {
  let clicks = 0;
  const strong = { textContent: 'Tokens' };
  const span = { textContent: String(tokens) };
  const pill = {
    querySelector(selector) {
      return selector === 'strong' ? strong : selector === 'span' ? span : null;
    },
  };
  const section = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.info-pill' ? [pill] : [];
    },
  };
  const button = {
    disabled: false,
    closest(selector) {
      return selector === 'section' ? section : null;
    },
    click() {
      clicks += 1;
    },
  };
  const doc = createDocument(
    { '.js-matchmake[data-ladder="solo"]': button },
    { section: [section] },
  );
  return { button, doc, get clicks() { return clicks; } };
}

function createBattle({ ended = false } = {}) {
  let autoPlayClicks = 0;
  const autoPlay = {
    disabled: false,
    textContent: 'Auto Play: Off',
    classList: { contains: () => false },
    getAttribute: () => 'false',
    click() {
      autoPlayClicks += 1;
    },
  };
  const formation = {};
  const living = {};
  const nodes = {
    '#autoPlayBtn': autoPlay,
    '#fastEnemyBtn': { disabled: false, classList: { contains: () => true }, getAttribute: () => 'true' },
    '#battleControlCard': {},
    '#viewerModeBadge': { textContent: '' },
    '#matchStatusBadge': { textContent: ended ? 'Allied victory' : 'Battle in progress' },
    '#rewardsModal': { classList: { contains: () => false } },
    '#allyFormation': formation,
    '#enemyFormation': formation,
    '#allyFormation .pSlot[data-side="ally"][data-alive="1"]': living,
    '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)': living,
  };
  return {
    doc: createDocument(nodes),
    get autoPlayClicks() {
      return autoPlayClicks;
    },
  };
}

function createSkillPlannerBattle() {
  let finalWishClicks = 0;
  const classes = (...names) => ({ contains: (name) => names.includes(name) });
  const skillButton = (skillId, name, cost, resourceCost, requiresFullResource = false) => ({
    dataset: {
      skillId,
      cost: String(cost),
      resourceCost: String(resourceCost),
      requiresFullResource: requiresFullResource ? '1' : '0',
    },
    disabled: false,
    isConnected: true,
    querySelector: (selector) => (selector === '.skillName' ? { textContent: name } : null),
    click() {
      if (skillId === 'adv:20') finalWishClicks += 1;
    },
  });
  const skills = [
    skillButton('0', 'Slash', 0, 0),
    skillButton('-1', 'Power Slash', 9, 0),
    skillButton('adv:18', 'Venom Rend', 8, 0),
    skillButton('adv:19', 'Death Mark', 8, 0),
    skillButton('adv:20', 'Final Wish', 15, 100, true),
  ];
  const grid = {
    querySelector: () => skills[0],
    querySelectorAll: () => skills,
  };
  const logLine = {
    dataset: { logId: '7' },
    querySelector: (selector) => (selector === '.logText' ? { textContent: 'Ron takes the turn.' } : null),
  };
  const living = {};
  const enemy = {
    dataset: { key: 'enemy-1' },
    classList: classes('targeted'),
    click() {},
  };
  const nodes = {
    '#autoPlayBtn': {
      disabled: false,
      textContent: 'Auto Play: Off',
      classList: classes(),
      getAttribute: () => 'false',
      click() {},
    },
    '#fastEnemyBtn': {
      disabled: false,
      textContent: 'Enemy Turns 1s: On',
      classList: classes('active'),
      getAttribute: () => 'true',
      click() {},
    },
    '#viewerModeBadge': { textContent: '' },
    '#matchStatusBadge': { textContent: 'Battle in progress' },
    '#rewardsModal': { classList: classes() },
    '#battleControlCard': {},
    '#attackBtn': { disabled: false, click() {} },
    '#allyFormation': {},
    '#enemyFormation': {},
    '#allyFormation .pSlot[data-side="ally"][data-alive="1"]': {
      ...living,
      dataset: { username: 'Ron' },
    },
    '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)': enemy,
    '#myTokens': { textContent: '15' },
    '#advancedResourceValue': { textContent: '100 / 100' },
    '#skillsModal': { classList: classes('show') },
    '#skillsGrid': grid,
  };
  return {
    doc: createDocument(nodes, { '#logBox .logLine[data-log-id]': [logLine] }),
    get finalWishClicks() {
      return finalWishClicks;
    },
  };
}

test('reads the Solo token count from the lobby section', () => {
  const lobby = createLobby('1,234');
  assert.equal(readSoloTokenCount(lobby.doc), 1234);
  assert.deepEqual(
    { tokens: getLobbySnapshot(lobby.doc).tokens, canStart: getLobbySnapshot(lobby.doc).canStart },
    { tokens: 1234, canStart: true },
  );
});

test('does not start matchmaking without an orchestrator command', async () => {
  const lobby = createLobby(3);
  const { win } = createWindow('/pvp.php');
  const store = createStore({ [CONFIG_KEY]: pvpConfig() });
  const worker = createPvpWorker({ win, doc: lobby.doc, store, now: () => NOW, logger: null });

  await worker.tick();

  assert.equal(lobby.clicks, 0);
  assert.equal(store.read(workerStatusKey('pvp')).state, 'idle');
  assert.equal(store.read(workerStatusKey('pvp')).safeToLeave, true);
});

test('a PvP tab that does not own the scheduler lease cannot spend a token', async () => {
  const lobby = createLobby(3);
  const { win } = createWindow('/pvp.php');
  const store = createStore({
    [COMMAND_KEY]: command(),
    [CONFIG_KEY]: pvpConfig(),
    [LEASE_KEY]: { ownerId: 'primary-tab', leaseUntil: NOW + 30_000 },
  });
  const sessionStore = {
    available: true,
    readRaw(key) {
      return key === TAB_KEY ? 'secondary-tab' : null;
    },
  };
  const worker = createPvpWorker({
    win,
    doc: lobby.doc,
    store,
    sessionStore,
    now: () => NOW,
    logger: null,
  });

  await worker.tick();

  assert.equal(lobby.clicks, 0);
  assert.equal(store.read(workerStatusKey('pvp')), null);
});

test('publishes done when a scheduled lobby has no Solo tokens', async () => {
  const lobby = createLobby(0);
  const { win } = createWindow('/pvp.php');
  const store = createStore({ [COMMAND_KEY]: command(), [CONFIG_KEY]: pvpConfig() });
  const worker = createPvpWorker({ win, doc: lobby.doc, store, now: () => NOW, logger: null });

  await worker.tick();

  const status = store.read(workerStatusKey('pvp'));
  assert.equal(status.visitId, 'pvp-visit');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(lobby.clicks, 0);
});

test('a draining visit settles safely in the lobby without matchmaking', async () => {
  const lobby = createLobby(4);
  const { win } = createWindow('/pvp.php');
  const store = createStore({
    [COMMAND_KEY]: command({ phase: 'draining' }),
    [CONFIG_KEY]: pvpConfig(),
  });
  const worker = createPvpWorker({ win, doc: lobby.doc, store, now: () => NOW, logger: null });

  await worker.tick();

  const status = store.read(workerStatusKey('pvp'));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(lobby.clicks, 0);
});

test('Game Auto Play is enabled after the battle page has settled', async () => {
  let currentNow = NOW;
  const battle = createBattle();
  const { win } = createWindow('/pvp_battle.php?match_id=1');
  const store = createStore({ [COMMAND_KEY]: command(), [CONFIG_KEY]: pvpConfig(MODES.autoplay) });
  const worker = createPvpWorker({
    win,
    doc: battle.doc,
    store,
    now: () => currentNow,
    logger: null,
  });

  await worker.tick();
  assert.equal(battle.autoPlayClicks, 0);
  currentNow += 1_500;
  await worker.tick();

  assert.equal(battle.autoPlayClicks, 1);
  const status = store.read(workerStatusKey('pvp'));
  assert.equal(status.state, 'busy');
  assert.equal(status.safeToLeave, false);
});

test('the skill-planner mode executes its selected skill on the own turn', async () => {
  const battle = createSkillPlannerBattle();
  const { win } = createWindow('/pvp_battle.php?match_id=1');
  const store = createStore({
    [COMMAND_KEY]: command(),
    [CONFIG_KEY]: pvpConfig(MODES.skillPlanner),
  });
  const worker = createPvpWorker({ win, doc: battle.doc, store, now: () => NOW, logger: null });

  await worker.tick();

  assert.equal(battle.finalWishClicks, 1);
  assert.equal(worker.runtime.handledTurnKey, '7');
});

test('an ended scheduled battle returns to the PvP lobby', async () => {
  const battle = createBattle({ ended: true });
  const { win, timers, navigation } = createWindow('/pvp_battle.php?match_id=1');
  const store = createStore({ [COMMAND_KEY]: command(), [CONFIG_KEY]: pvpConfig() });
  const worker = createPvpWorker({ win, doc: battle.doc, store, now: () => NOW, logger: null });

  await worker.tick();
  const timer = timers.find((entry) => entry.delay === TIMING.returnToLobbyMs && !entry.cleared);
  assert.ok(timer);
  timer.callback();

  assert.equal(navigation.replacedWith, 'https://demonicscans.org/pvp.php');
});

test('a scheduled battle page that never renders fails safely after the grace period', async () => {
  const { win } = createWindow('/pvp_battle.php?match_id=1');
  const doc = createDocument();
  const store = createStore({ [COMMAND_KEY]: command(), [CONFIG_KEY]: pvpConfig() });
  const worker = createPvpWorker({
    win,
    doc,
    store,
    now: () => NOW + TIMING.renderGraceMs,
    logger: null,
  });

  // Move the page clock beyond the grace period established at construction.
  worker.runtime.startedAt = NOW;
  await worker.tick();

  const status = store.read(workerStatusKey('pvp'));
  assert.equal(status.state, 'error');
  assert.equal(status.safeToLeave, true);
});

test('the ported skill planner keeps Final Wish and its setup sequence', () => {
  const skill = (cost, options = {}) => ({
    available: true,
    cost,
    resourceCost: options.resourceCost ?? 0,
    requiresFullResource: options.requiresFullResource === true,
  });
  const skills = {
    [logic.SKILL_KEYS.slash]: skill(0),
    [logic.SKILL_KEYS.powerSlash]: skill(9),
    [logic.SKILL_KEYS.venomRend]: skill(8),
    [logic.SKILL_KEYS.deathMark]: skill(8),
    [logic.SKILL_KEYS.finalWish]: skill(15, { resourceCost: 100, requiresFullResource: true }),
  };

  assert.equal(
    logic.chooseAttackPlan({ tokens: 15, resource: 100, resourceMaximum: 100, skills }).skillKey,
    logic.SKILL_KEYS.finalWish,
  );
  const setup = logic.chooseAttackPlan({ tokens: 20, resource: 50, resourceMaximum: 100, skills });
  assert.equal(setup.skillKey, logic.SKILL_KEYS.deathMark);
  assert.equal(setup.prepareBridge, true);
});
