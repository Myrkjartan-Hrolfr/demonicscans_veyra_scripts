'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../src/features/automation/boss-logic');
const dom = require('../src/features/automation/boss-dom');
const { createBossWorker, bossWorkerFeature } = require('../src/features/automation/boss-worker');
const AUTOMATION_FEATURES = require('../src/features/automation');
const { createJsonStore } = require('../src/core/storage');
const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');

// ------------------------------------------------------------------ stubs

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function el({ attrs = {}, text = '', children = {} } = {}) {
  return {
    textContent: text,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    querySelector: (selector) => {
      const value = children[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll: (selector) => {
      const value = children[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
    clicks: 0,
    click() {
      this.clicks += 1;
    },
  };
}

function monsterCard({ id, name, dead = '0', joined = '1', userdmg = '0', expire = '1793385061' }) {
  return el({
    attrs: {
      'data-monster-id': String(id),
      'data-name': name,
      'data-dead': dead,
      'data-joined': joined,
      'data-userdmg': String(userdmg),
      'data-expire': expire,
      'data-boss': '0',
    },
  });
}

function summonCard({ name, alive = true, id = '' }) {
  return el({
    attrs: { 'data-alive': alive ? '1' : '0' },
    children: {
      '.auto-summon-name': el({ text: name }),
      'a[href*="battle.php"]': id ? el({ attrs: { href: `battle.php?id=${id}` } }) : null,
    },
  });
}

function healingPotion({ invId = 'hp-1', quantity = 3 } = {}) {
  return el({
    attrs: { 'data-inv-id': invId, 'data-item-id': '108' },
    children: {
      '.potion-use-btn': el({
        attrs: { 'data-name': 'Full HP Potion', 'data-max': String(quantity) },
      }),
      '.potion-qty-left': el({ text: String(quantity) }),
      '.potion-name': el({ text: 'Full HP Potion' }),
    },
  });
}

const GOOD_COOKIES = { hide_dead_monsters: '1', show_dead_bosses_only: '0' };

function fakeDoc({ selectors = {}, cookies = GOOD_COOKIES } = {}) {
  const jar = { ...cookies };
  return {
    hidden: false,
    visibilityState: 'visible',
    get cookie() {
      return Object.entries(jar)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
    },
    set cookie(text) {
      const [pair] = String(text).split(';');
      const index = pair.indexOf('=');
      jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    },
    querySelector(selector) {
      const value = selectors[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = selectors[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
}

function hubDoc({ cards = [], summons = [], cookies } = {}) {
  return fakeDoc({
    cookies,
    selectors: {
      '.auto-summon-card': summons,
      '.monster-card[data-monster-id]': cards,
      '.monster-container': el(),
    },
  });
}

function fakeWin(href) {
  const url = new URL(href);
  const replaced = [];
  return {
    location: {
      href: url.href,
      origin: url.origin,
      replace(next) {
        replaced.push(next);
      },
    },
    replaced,
  };
}

function stubController(initial = {}) {
  const calls = [];
  const listeners = new Set();
  let state = { running: false, finished: false, reason: '', yourDamage: 0, message: '', ...initial };
  return {
    calls,
    setTargetDamage: (value) => calls.push(['target', value]),
    setAttacks: (skills) => {
      calls.push(['attacks', skills]);
      return true;
    },
    setPotions: (potions) => calls.push(['potions', potions]),
    start: () => {
      calls.push(['start']);
      state = { ...state, running: true, finished: false };
    },
    stop: () => {
      calls.push(['stop']);
      state = { ...state, running: false, finished: true, reason: 'stopped' };
    },
    getState: () => state,
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit(patch) {
      state = { ...state, ...patch };
      for (const callback of [...listeners]) callback(state);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const T0 = 1_800_000_000_000;

function createEnv({ routeId = 'olympus', configure, visitId = 'v1', phase = 'running', deadlineAt } = {}) {
  const storage = createStorage();
  const store = createJsonStore(storage);
  const sessionStore = createJsonStore(createStorage());
  const clock = { time: T0 };
  const config = createDefaultConfig();
  configure?.(config);
  store.write(CONFIG_KEY, config);
  if (routeId) {
    store.write(COMMAND_KEY, {
      version: 1,
      visitId,
      taskId: routeId,
      phase,
      returnPath: '/pvp.php',
      issuedAt: T0 - 1_000,
      deadlineAt: deadlineAt ?? T0 + 45 * 60_000,
    });
  }
  const posts = [];
  const fetches = [];
  const env = {
    store,
    storage,
    sessionStore,
    clock,
    posts,
    fetches,
    phaseStates: [],
    joinAnswer: 'You have successfully joined the battle!',
    controller: null,
    status: (route) => store.read(workerStatusKey(route)),
    run: () => logic.normalizeRunState(store.read(logic.RUN_KEY), clock.time),
    setCommandPhase(nextPhase) {
      store.write(COMMAND_KEY, { ...store.read(COMMAND_KEY), phase: nextPhase });
    },
    page(href, doc) {
      const win = fakeWin(href);
      const worker = createBossWorker({
        win,
        doc,
        store,
        sessionStore,
        postForm: async (url, params) => {
          posts.push({ url, params });
          return { ok: true, status: 200, text: env.joinAnswer };
        },
        fetchJson: async (url) => {
          fetches.push(url);
          return env.phaseStates.shift() || { ok: false, error: 'No queued phase state.' };
        },
        getUserId: async () => 159129,
        bridge: {
          whenController: async () => env.controller,
          getController: () => env.controller,
        },
        now: () => clock.time,
        logger: { info() {}, warn() {}, error() {} },
      });
      worker.initOwner();
      return { win, worker };
    },
  };
  return env;
}

function enableOlympus(config, ids, damage = '10b', phase3Damage = null) {
  for (const id of ids) {
    config.routes.olympus.settings.bosses[id].enabled = true;
    config.routes.olympus.settings.bosses[id].damage = damage;
    if (phase3Damage !== null && 'phase3Damage' in config.routes.olympus.settings.bosses[id]) {
      config.routes.olympus.settings.bosses[id].phase3Damage = phase3Damage;
    }
  }
  config.routes.olympus.potions = { stamina: [30], heal: [108] };
  config.routes.olympus.settings.skills = ['0', '-1'];
}

const HUB = 'https://demonicscans.org/active_wave.php';

// --------------------------------------------------------------- matching

test('boss names normalize and the prefix is the part before the first comma', () => {
  assert.equal(logic.normalizeBossName('Zeus, Sovereign of the Storm Throne'), 'zeus sovereign of the storm throne');
  assert.equal(logic.bossNamePrefix('Zeus, Sovereign of the Storm Throne'), 'zeus');
  assert.equal(logic.bossNamePrefix('Drakzareth The Tyrant Lizard King'), 'drakzareth the tyrant lizard king');
});

const ZEUS_BOSSES = [
  { id: 'aeolus', name: 'Aeolus, Herald of Bound Winds', enabled: true, damage: '1b', damageValue: 1e9 },
  { id: 'zeus', name: 'Zeus, Sovereign of the Storm Throne', enabled: true, damage: '8b', damageValue: 8e9 },
];

test('an alive Sovereign is matched through its duelist card name', () => {
  const matches = logic.matchHubBosses({
    bosses: ZEUS_BOSSES,
    summons: [
      { name: 'Aeolus, Herald of Bound Winds', alive: true, monsterId: '557482543' },
      { name: 'Zeus, Sovereign of the Storm Throne', alive: true, monsterId: '' },
    ],
    cards: [
      { monsterId: '557482543', name: 'aeolus, herald of bound winds', dead: false, joined: true, userDamage: 1025181950, expire: 2 },
      { monsterId: '557125239', name: 'zeus, duelist of the storm throne', dead: false, joined: true, userDamage: 7014853693, expire: 1 },
    ],
  });
  assert.deepEqual(
    matches.map((match) => [match.bossId, match.monsterId, match.source]),
    [
      ['aeolus', '557482543', 'card'],
      ['zeus', '557125239', 'card'],
    ],
  );
  assert.equal(logic.needsWork(matches[0]), false);
  assert.equal(logic.needsWork(matches[1]), true);
});

test('the prefix fallback needs an alive auto-summon card and ignores dead cards', () => {
  const cards = [
    { monsterId: '1', name: 'zeus, duelist of the storm throne', dead: false, joined: true, userDamage: 0 },
    { monsterId: '2', name: 'zeus, sovereign of the storm throne', dead: true, joined: true, userDamage: 0 },
  ];
  const waiting = logic.matchHubBosses({
    bosses: ZEUS_BOSSES,
    summons: [{ name: 'Zeus, Sovereign of the Storm Throne', alive: false, monsterId: '' }],
    cards,
  });
  assert.deepEqual(waiting, []);

  const alive = logic.matchHubBosses({
    bosses: ZEUS_BOSSES,
    summons: [{ name: 'Zeus, Sovereign of the Storm Throne', alive: true, monsterId: '' }],
    cards,
  });
  assert.deepEqual(alive.map((match) => match.monsterId), ['1']);
});

test('disabled bosses are ignored and a card-less alive boss uses its auto-summon link', () => {
  const matches = logic.matchHubBosses({
    bosses: [
      { ...ZEUS_BOSSES[0], enabled: false },
      { id: 'oceanus', name: 'Oceanus The Water Titan', enabled: true, damage: '1b', damageValue: 1e9 },
    ],
    summons: [
      { name: 'Aeolus, Herald of Bound Winds', alive: true, monsterId: '9' },
      { name: 'Oceanus The Water Titan', alive: true, monsterId: '557482535' },
    ],
    cards: [{ monsterId: '9', name: 'aeolus, herald of bound winds', dead: false, joined: false, userDamage: 0 }],
  });
  assert.deepEqual(matches.map((match) => [match.bossId, match.monsterId, match.source, match.joined]), [
    ['oceanus', '557482535', 'summon', null],
  ]);
  assert.equal(logic.needsWork(matches[0]), true);
});

test('Wave 3 bosses are matched by exact name, ordinary monsters never', () => {
  const plan = logic.buildPlan('wave3', createDefaultConfig().routes.wave3);
  assert.equal(plan.length, 1);
  const matches = logic.matchHubBosses({
    bosses: plan[0].bosses,
    summons: [{ name: 'Drakzareth The Tyrant Lizard King', alive: true, monsterId: '557578482' }],
    cards: [
      { monsterId: '557578482', name: 'drakzareth the tyrant lizard king', dead: false, joined: true, userDamage: 3247818809 },
      { monsterId: '557587554', name: 'lizardman vanguard', dead: false, joined: false, userDamage: 0 },
    ],
  });
  assert.deepEqual(matches.map((match) => match.monsterId), ['557578482']);
  assert.equal(matches[0].damageValue, 3e9);
  assert.equal(logic.needsWork(matches[0]), false, '3.25b already reached the 3b target');
});

test('damage target checks: unjoined or unknown damage always needs a fight', () => {
  assert.equal(logic.reachedTarget(3e9, 3e9), true);
  assert.equal(logic.reachedTarget(2.9e9, 3e9), false);
  assert.equal(logic.reachedTarget(null, 3e9), false);
  assert.equal(logic.needsWork({ joined: false, userDamage: 5e9, damageValue: 3e9 }), true);
  assert.equal(logic.needsWork({ joined: null, userDamage: null, damageValue: 3e9 }), true);
  assert.equal(logic.needsWork({ joined: true, userDamage: 5e9, damageValue: 3e9 }), false);
});

test('chooseNextBoss skips processed, failed and exhausted bosses', () => {
  const matches = ['a', 'b', 'c', 'd'].map((monsterId) => ({
    monsterId,
    joined: true,
    userDamage: 0,
    damageValue: 1,
  }));
  const run = {
    ...logic.createRunState({ visitId: 'v', routeId: 'olympus', now: 0 }),
    processed: ['a'],
    failed: ['b'],
    fights: { c: logic.LIMITS.maxFightsPerBoss },
  };
  assert.equal(logic.chooseNextBoss(matches, run).monsterId, 'd');
  assert.equal(logic.chooseNextBoss(matches.slice(0, 3), run), null);
});

// ---------------------------------------------------------------- domains

test('the Olympus plan only contains domains with enabled bosses, in visit order', () => {
  const config = createDefaultConfig();
  enableOlympus(config, ['zeus', 'hera'], '5b');
  const plan = logic.buildPlan('olympus', config.routes.olympus);
  assert.deepEqual(plan.map((domain) => domain.id), ['hera', 'zeus']);
  assert.equal(plan[0].path, '/active_wave.php?gate=5&wave=16');
  assert.equal(plan[0].bosses.find((boss) => boss.id === 'hera').damageValue, 5e9);
  assert.equal(plan[0].bosses.find((boss) => boss.id === 'nemesis').enabled, false);

  assert.equal(logic.nextDomainId('olympus', plan, ''), 'hera');
  assert.equal(logic.nextDomainId('olympus', plan, 'outer'), 'hera');
  assert.equal(logic.nextDomainId('olympus', plan, 'hera'), 'zeus');
  assert.equal(logic.nextDomainId('olympus', plan, 'zeus'), null);
  assert.deepEqual(logic.buildPlan('olympus', createDefaultConfig().routes.olympus), []);
});

test('phased Olympus gods keep Phase 1 and Phase 3 separate but use their sum on the hub', () => {
  const config = createDefaultConfig();
  enableOlympus(config, ['zeus'], '3b', '4b');
  const zeus = logic.buildPlan('olympus', config.routes.olympus)[0].bosses.find((boss) => boss.id === 'zeus');
  assert.equal(zeus.phased, true);
  assert.equal(zeus.phase1DamageValue, 3e9);
  assert.equal(zeus.phase3DamageValue, 4e9);
  assert.equal(zeus.damageValue, 7e9);
  assert.equal(zeus.damage, '7b');
  assert.deepEqual(logic.battleDamageTarget(zeus, false), { phase: 1, damage: '3b', damageValue: 3e9 });
  assert.deepEqual(logic.battleDamageTarget(zeus, true), { phase: 3, damage: '7b', damageValue: 7e9 });
});

test('Olympus duel logic prefers affordable Power Slash and falls back to Slash', () => {
  const state = {
    ok: true,
    room_status: 'live',
    match: { ended: false },
    turn: { side: 'ally', user_id: 159129 },
    me: {
      in_match: true,
      alive: true,
      tokens: 40,
      skills: [
        { id: '0', name: 'Slash', cost: 0 },
        { id: '-1', name: 'Power Slash', cost: 9 },
      ],
    },
    teams: { enemy: { players_by_num: { 3: { key: 'enemy:monster_phase:7', alive: true } } } },
  };
  assert.deepEqual(logic.decidePhaseDuelAction(state, 159129), {
    kind: 'attack',
    skillId: '-1',
    skillName: 'Power Slash',
    targetKey: 'enemy:monster_phase:7',
  });
  assert.equal(logic.decidePhaseDuelAction({ ...state, me: { ...state.me, tokens: 8 } }, 159129).skillId, '0');
  assert.deepEqual(
    logic.decidePhaseDuelAction({ ...state, room_status: 'cleared', match: { ended: true, winner_side: 'ally' } }),
    { kind: 'won' },
  );
  assert.deepEqual(
    logic.decidePhaseDuelAction({ ...state, room_status: 'lost', match: { ended: true, winner_side: 'enemy' } }),
    { kind: 'retry' },
  );
});

test('hub URLs map to their route and domain', () => {
  const url = (search) => new URL(`${HUB}${search}`);
  assert.equal(logic.hubRouteForUrl(url('?gate=3&wave=8')), 'wave3');
  assert.equal(logic.hubRouteForUrl(url('?gate=5&wave=17&veyra_visit=x')), 'olympus');
  assert.equal(logic.hubRouteForUrl(url('?gate=3&wave=3')), null);
  assert.equal(logic.domainIdForUrl('olympus', url('?gate=5&wave=17')), 'zeus');
  assert.equal(logic.domainIdForUrl('wave3', url('?gate=3&wave=8')), 'wave3');
  assert.equal(
    logic.withVisit('/battle.php?id=5', 'v1').href,
    'https://demonicscans.org/battle.php?id=5&veyra_visit=v1',
  );
});

// ---------------------------------------------------------------- command

test('commands: only running/draining visits of the boss routes count', () => {
  const base = { version: 1, visitId: 'v', returnPath: '/x', issuedAt: 1, deadlineAt: 100 };
  assert.equal(logic.evaluateCommand(null).kind, 'none');
  assert.equal(logic.evaluateCommand({ ...base, taskId: 'pvp', phase: 'running' }, 50).kind, 'none');
  assert.deepEqual(logic.evaluateCommand({ ...base, taskId: 'olympus', phase: 'running' }, 50), {
    kind: 'running',
    routeId: 'olympus',
    visitId: 'v',
    deadlineAt: 100,
  });
  assert.equal(logic.evaluateCommand({ ...base, taskId: 'wave3', phase: 'draining' }, 50).kind, 'draining');
  assert.equal(logic.evaluateCommand({ ...base, taskId: 'wave3', phase: 'running' }, 150).kind, 'expired');
  assert.equal(logic.evaluateCommand({ ...base, taskId: 'wave3', phase: 'paused' }, 50).kind, 'none');
});

// -------------------------------------------------------------- run state

test('run state transitions: target, fight, completion and failure limits', () => {
  let run = logic.createRunState({ visitId: 'v', routeId: 'olympus', ownerId: 'me', now: 10 });
  run = logic.enterDomain(run, 'hera', 11);
  run = logic.selectTarget(run, { monsterId: '7', bossId: 'hera', name: 'Hera', damage: '5b', damageValue: 5e9 }, 'hera', 12);
  assert.equal(run.target.domainId, 'hera');

  run = logic.beginFight(run, 13);
  assert.equal(run.phase, 'opening');
  assert.equal(logic.fightCount(run, '7'), 1);

  let failed = logic.failTarget(run, 'stopped', 14);
  assert.equal(failed.target, null);
  assert.deepEqual(failed.failed, [], 'first failed fight is retried');
  assert.equal(failed.phase, 'returning');
  assert.equal(logic.settleOnHub(failed, 15).phase, 'hub');

  for (let i = 1; i < logic.LIMITS.maxFightsPerBoss; i += 1) run = logic.beginFight(run, 16);
  failed = logic.failTarget(run, 'stopped', 17);
  assert.deepEqual(failed.failed, ['7'], 'gives up after the last allowed fight');
  assert.deepEqual(logic.failTarget({ ...run, fights: {} }, 'x', 17, { abandon: true }).failed, ['7']);

  const done = logic.completeTarget(run, 18);
  assert.deepEqual(done.processed, ['7']);
  assert.equal(done.target, null);

  const finished = logic.finishRun(done, 'done', 'ok', 19);
  assert.deepEqual(finished.finished, { state: 'done', message: 'ok', at: 19 });
  const restored = logic.normalizeRunState(JSON.parse(JSON.stringify(finished)), 20);
  assert.equal(restored.phase, 'finished');
  assert.deepEqual(restored.processed, ['7']);
  assert.equal(logic.normalizeRunState({ ...finished, version: 99 }), null);
  assert.equal(logic.normalizeRunState({ ...finished, routeId: 'pvp' }), null);
});

test('actions retry after a pause and are exhausted after the attempt limit', () => {
  let run = logic.createRunState({ visitId: 'v', routeId: 'wave3', now: 0 });
  run = logic.recordAction(run, 'join', 1_000);
  assert.equal(logic.actionReady(run, 'join', 2_000), false);
  assert.equal(logic.actionReady(run, 'join', 6_000), true);
  assert.equal(logic.actionReady(run, 'enter', 2_000), true);
  run = logic.recordAction(logic.recordAction(run, 'join', 6_000), 'join', 12_000);
  assert.equal(run.action.attempts, 3);
  assert.equal(logic.actionExhausted(run, 'join'), true);
  assert.equal(logic.recordAction(run, 'other', 13_000).action.attempts, 1);
});

test('resume re-bases timeouts only for the owning tab; lease helpers', () => {
  let run = logic.createRunState({ visitId: 'v', routeId: 'wave3', ownerId: 'me', now: 0 });
  run = logic.recordAction(run, 'join', 100);
  const resumed = logic.refreshAfterResume(run, 'me', 900_000);
  assert.equal(resumed.action.at, 900_000);
  assert.equal(resumed.phaseAt, 900_000);
  assert.equal(logic.refreshAfterResume(run, 'other', 900_000), run);
  assert.equal(logic.isLeaseHeldByOther(run, 'other', 1_000), true);
  assert.equal(logic.isLeaseHeldByOther(run, 'other', logic.TIMING.leaseMs + 1), false);
  assert.equal(logic.isLeaseHeldByOther(run, 'me', 1_000), false);
});

test('fight results and join answers are classified', () => {
  assert.equal(logic.decideAfterFight('target'), 'complete');
  assert.equal(logic.decideAfterFight('defeated'), 'complete');
  assert.equal(logic.decideAfterFight('no-stamina'), 'stop-visit');
  assert.equal(logic.decideAfterFight('stopped'), 'retry');
  assert.equal(logic.decideAfterFight('error'), 'retry');
  assert.equal(logic.isJoinSuccess('You have successfully joined the battle!'), true);
  assert.equal(logic.isJoinSuccess('Invalid monster.'), false);
  assert.equal(logic.isJoinFatal('Invalid monster.'), true);
});

test('alive-monsters filter cookies', () => {
  const url = new URL(`${HUB}?gate=3&wave=8`);
  assert.equal(logic.isAliveFilterActive('hide_dead_monsters=1; show_dead_bosses_only=0', url), true);
  assert.equal(logic.isAliveFilterActive('hide_dead_monsters=0; show_dead_bosses_only=0', url), false);
  assert.equal(
    logic.isAliveFilterActive('hide_dead_monsters=1; show_dead_bosses_only=0', new URL(`${url.href}&dead_page=2`)),
    false,
  );
});

// --------------------------------------------------------------------- DOM

test('DOM readers parse auto-summon and monster cards', () => {
  const doc = hubDoc({
    summons: [
      summonCard({ name: 'Aeolus, Herald of Bound Winds', id: '557482543' }),
      summonCard({ name: 'Zeus, Sovereign of the Storm Throne' }),
      summonCard({ name: 'Poseidon, The Sea Emperor', alive: false }),
    ],
    cards: [monsterCard({ id: 557125239, name: 'zeus, duelist of the storm throne', userdmg: '7014853693' })],
  });
  assert.deepEqual(dom.readSummons(doc), [
    { name: 'Aeolus, Herald of Bound Winds', alive: true, monsterId: '557482543' },
    { name: 'Zeus, Sovereign of the Storm Throne', alive: true, monsterId: '' },
    { name: 'Poseidon, The Sea Emperor', alive: false, monsterId: '' },
  ]);
  assert.deepEqual(dom.readMonsterCards(doc), [
    {
      monsterId: '557125239',
      name: 'zeus, duelist of the storm throne',
      dead: false,
      joined: true,
      userDamage: 7014853693,
      expire: 1793385061,
    },
  ]);
  assert.equal(dom.hasBossList(doc), true);
  assert.equal(dom.battleMonsterId(new URL('https://demonicscans.org/battle.php?id=5'), fakeDoc()), '5');
});

test('DOM readers recognize the Olympus phase-duel link and Ascended PvE form', () => {
  const phaseLink = el({ attrs: { href: 'pvp_style_battle.php?source=monster_phase&active_id=557845671' } });
  const phaseDoc = fakeDoc({ selectors: { [dom.SELECTORS.phaseDuel]: phaseLink } });
  assert.deepEqual(dom.findPhaseDuelControl(phaseDoc), {
    element: phaseLink,
    href: '/pvp_style_battle.php?source=monster_phase&active_id=557845671',
    activeId: '557845671',
  });
  assert.equal(
    dom.isAscendedBattle(fakeDoc({ selectors: { [dom.SELECTORS.battleTitle]: el({ text: 'Zeus, Ascended Sovereign' }) } })),
    true,
  );
});

// ------------------------------------------------------------------ worker

test('the feature is registered for wave and battle pages', () => {
  assert.ok(AUTOMATION_FEATURES.includes(bossWorkerFeature));
  assert.equal(bossWorkerFeature.group, 'Automation');
  assert.deepEqual(bossWorkerFeature.settings, []);
  assert.equal(bossWorkerFeature.matches(new URL(`${HUB}?gate=5&wave=9`)), true);
  assert.equal(bossWorkerFeature.matches(new URL('https://demonicscans.org/battle.php?id=1')), true);
  assert.equal(
    bossWorkerFeature.matches(new URL('https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=1')),
    true,
  );
  assert.equal(
    bossWorkerFeature.matches(new URL('https://demonicscans.org/pvp_style_battle.php?source=cube&instance_id=1')),
    false,
  );
  assert.equal(bossWorkerFeature.matches(new URL('https://demonicscans.org/pvp.php')), false);
});

test('without a visit the hub only publishes an idle, safe heartbeat', () => {
  const env = createEnv({ routeId: null });
  const { win, worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  const status = env.status('olympus');
  assert.equal(status.state, 'idle');
  assert.equal(status.safeToLeave, true);
  assert.equal(status.visitId, '');
  assert.deepEqual(win.replaced, []);
  assert.equal(env.run(), null);
});

test('a visit for another boss route leaves this hub idle', () => {
  const env = createEnv({ routeId: 'wave3' });
  const { win, worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  assert.equal(env.status('olympus').state, 'idle');
  assert.deepEqual(win.replaced, []);
});

test('Olympus skips domains without enabled bosses and keeps veyra_visit', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera', 'zeus']) });
  const { win, worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  assert.deepEqual(win.replaced, ['https://demonicscans.org/active_wave.php?gate=5&wave=16&veyra_visit=v1']);
  assert.equal(env.run().domainId, 'hera');
  assert.equal(env.status('olympus').state, 'busy');
  assert.equal(env.status('olympus').safeToLeave, false);
});

test('a done domain moves on to the next planned domain; the last one finishes the visit', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera', 'zeus'], '5b') });
  const heraDoc = hubDoc({
    summons: [summonCard({ name: 'Hera, Sovereign of the Crown Court' })],
    cards: [monsterCard({ id: 557125237, name: 'hera, duelist of the crown court', userdmg: '7050785263' })],
  });
  let page = env.page(`${HUB}?gate=5&wave=16&veyra_visit=v1`, heraDoc);
  env.clock.time += 1_500;
  page.worker.tick();
  assert.deepEqual(page.win.replaced, ['https://demonicscans.org/active_wave.php?gate=5&wave=17&veyra_visit=v1']);
  assert.equal(env.run().domainId, 'zeus');

  const zeusDoc = hubDoc({
    summons: [summonCard({ name: 'Zeus, Sovereign of the Storm Throne' })],
    cards: [monsterCard({ id: 557125239, name: 'zeus, duelist of the storm throne', userdmg: '7014853693' })],
  });
  page = env.page(`${HUB}?gate=5&wave=17&veyra_visit=v1`, zeusDoc);
  env.clock.time += 1_500;
  page.worker.tick();
  assert.deepEqual(page.win.replaced, []);
  const status = env.status('olympus');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(status.visitId, 'v1');
  assert.equal(env.run().finished.state, 'done');

  // A reload of the finished visit only repeats the result.
  env.clock.time += 5_000;
  page = env.page(`${HUB}?gate=5&wave=17&veyra_visit=v1`, zeusDoc);
  page.worker.tick();
  assert.equal(env.status('olympus').state, 'done');
  assert.deepEqual(page.win.replaced, []);
});

test('the hub fixes the alive-monsters filter cookies before checking bosses', () => {
  const env = createEnv({ routeId: 'wave3' });
  const doc = hubDoc({ cookies: {} });
  const { win, worker } = env.page(`${HUB}?gate=3&wave=8&dead_page=2`, doc);
  worker.tick();
  assert.match(doc.cookie, /hide_dead_monsters=1/);
  assert.match(doc.cookie, /show_dead_bosses_only=0/);
  assert.deepEqual(win.replaced, ['https://demonicscans.org/active_wave.php?gate=3&wave=8&veyra_visit=v1']);
});

test('an unjoined boss is joined on the hub and its battle opened with veyra_visit', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['asclepius']) });
  const doc = hubDoc({
    summons: [summonCard({ name: 'Asclepius, Herald of Golden Mercy', id: '557602201' })],
    cards: [monsterCard({ id: 557602201, name: 'asclepius, herald of golden mercy', joined: '0', userdmg: '0' })],
  });
  const { win, worker } = env.page(`${HUB}?gate=5&wave=14&veyra_visit=v1`, doc);
  env.clock.time += 1_500;
  worker.tick();
  await flush();
  assert.deepEqual(env.posts, [
    { url: 'user_join_battle.php', params: { monster_id: '557602201', user_id: 159129 } },
  ]);
  assert.deepEqual(win.replaced, ['https://demonicscans.org/battle.php?id=557602201&veyra_visit=v1']);
  const run = env.run();
  assert.equal(run.phase, 'opening');
  assert.equal(run.target.monsterId, '557602201');
  assert.equal(logic.fightCount(run, '557602201'), 1);
});

test('a joined boss below its target opens the battle directly', () => {
  const env = createEnv({ routeId: 'wave3' });
  const doc = hubDoc({
    summons: [summonCard({ name: 'Drakzareth The Tyrant Lizard King', id: '557578482' })],
    cards: [monsterCard({ id: 557578482, name: 'drakzareth the tyrant lizard king', userdmg: '1000' })],
  });
  const { win, worker } = env.page(`${HUB}?gate=3&wave=8`, doc);
  env.clock.time += 1_500;
  worker.tick();
  assert.deepEqual(env.posts, []);
  assert.deepEqual(win.replaced, ['https://demonicscans.org/battle.php?id=557578482&veyra_visit=v1']);
});

test('Wave 3 skips disabled bosses and finishes when every enabled boss reached its target', () => {
  const env = createEnv({
    routeId: 'wave3',
    configure: (config) => {
      config.routes.wave3.settings.bosses.drakzareth.enabled = false;
    },
  });
  const doc = hubDoc({
    summons: [summonCard({ name: 'Drakzareth The Tyrant Lizard King', id: '557578482' })],
    cards: [monsterCard({ id: 557578482, name: 'drakzareth the tyrant lizard king', userdmg: '1000' })],
  });
  const { win, worker } = env.page(`${HUB}?gate=3&wave=8`, doc);
  env.clock.time += 1_500;
  worker.tick();
  assert.deepEqual(win.replaced, []);
  assert.equal(env.status('wave3').state, 'done');
});

function battleRun(env, { routeId = 'olympus', monsterId = '557125237', domainId = 'hera' } = {}) {
  let run = logic.createRunState({ visitId: 'v1', routeId, ownerId: 'other-tab', now: env.clock.time });
  run = logic.enterDomain(run, domainId, env.clock.time);
  run = logic.selectTarget(
    run,
    { monsterId, bossId: domainId, name: 'Hera, Sovereign of the Crown Court', damage: '10b', damageValue: 1e10 },
    domainId,
    env.clock.time,
  );
  run = logic.beginFight(run, env.clock.time);
  // The fight was opened by this tab after a navigation.
  env.store.write(logic.RUN_KEY, { ...run, ownerId: '' });
}

function phasedBattleRun(env, { monsterId = '557845671', domainId = 'zeus' } = {}) {
  let run = logic.createRunState({ visitId: 'v1', routeId: 'olympus', ownerId: 'other-tab', now: env.clock.time });
  run = logic.enterDomain(run, domainId, env.clock.time);
  run = logic.selectTarget(
    run,
    {
      monsterId,
      bossId: domainId,
      name: 'Zeus, Sovereign of the Storm Throne',
      phased: true,
      damage: '7b',
      damageValue: 7e9,
      phase1Damage: '3b',
      phase1DamageValue: 3e9,
      phase3Damage: '4b',
      phase3DamageValue: 4e9,
    },
    domainId,
    env.clock.time,
  );
  run = logic.beginFight(run, env.clock.time);
  env.store.write(logic.RUN_KEY, { ...run, ownerId: '' });
}

function livePhaseState(tokens = 40) {
  return {
    ok: true,
    room_status: 'live',
    match: { ended: false },
    turn: { side: 'ally', user_id: 159129 },
    me: {
      in_match: true,
      alive: true,
      tokens,
      skills: [
        { id: '0', name: 'Slash', cost: 0 },
        { id: '-1', name: 'Power Slash', cost: 9 },
      ],
    },
    teams: {
      enemy: {
        players_by_num: {
          3: { key: 'enemy:monster_phase:557845671', alive: true },
        },
      },
    },
  };
}

test('the battle page drives Monster Auto Battle and returns to the domain hub', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  const { win, worker } = env.page('https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1', fakeDoc());
  worker.tick();
  await flush();
  assert.deepEqual(env.controller.calls, [
    ['target', 1e10],
    ['attacks', ['-1', '0']],
    ['potions', { stamina: [30], heal: [108] }],
    ['start'],
  ]);
  assert.equal(env.run().phase, 'battle');
  assert.equal(env.status('olympus').state, 'busy');

  env.clock.time += 2_000;
  env.controller.emit({ running: false, finished: true, reason: 'target', yourDamage: 1e10 });
  assert.deepEqual(win.replaced, ['https://demonicscans.org/active_wave.php?gate=5&wave=16&veyra_visit=v1']);
  const run = env.run();
  assert.deepEqual(run.processed, ['557125237']);
  assert.equal(run.target, null);
});

test('a zero-HP boss battle uses the selected healing potion before Monster Auto Battle', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  const doc = fakeDoc({
    selectors: {
      [dom.SELECTORS.playerHp]: el({ text: '💚 0 / 968,450 HP' }),
      '.potion-card[data-inv-id][data-item-id]': [
        healingPotion({ invId: '823978883', quantity: 2 }),
      ],
    },
  });
  const { win, worker } = env.page(
    'https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1',
    doc,
  );

  worker.tick();
  await flush();

  assert.deepEqual(env.posts, [
    {
      url: 'user_heal_potion.php',
      params: { inv_id: '823978883', qty: undefined },
    },
  ]);
  assert.deepEqual(env.controller.calls, []);
  assert.deepEqual(win.replaced, [
    'https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1',
  ]);

  worker.tick();
  await flush();
  assert.equal(env.posts.length, 1, 'the same page never consumes a second healing potion');
});

test('a zero-HP boss battle stops safely when no healing potion is selected', async () => {
  const env = createEnv({
    configure: (config) => {
      enableOlympus(config, ['hera']);
      config.routes.olympus.potions.heal = [];
    },
  });
  battleRun(env);
  env.controller = stubController();
  const doc = fakeDoc({
    selectors: {
      [dom.SELECTORS.playerHp]: el({ text: '💚 0 / 968,450 HP' }),
      '.potion-card[data-inv-id][data-item-id]': [healingPotion()],
    },
  });
  const { win, worker } = env.page(
    'https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1',
    doc,
  );

  worker.tick();
  await flush();

  assert.deepEqual(env.posts, []);
  assert.deepEqual(env.controller.calls, []);
  assert.deepEqual(win.replaced, []);
  assert.equal(env.status('olympus').state, 'done');
  assert.equal(env.status('olympus').safeToLeave, true);
  assert.match(env.status('olympus').message, /no healing potion is selected/i);
});

test('a phased Olympus battle opens its matching Phase 2 duel with the visit marker', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['zeus'], '3b', '4b') });
  phasedBattleRun(env);
  const phaseLink = el({ attrs: { href: 'pvp_style_battle.php?source=monster_phase&active_id=557845671' } });
  const doc = fakeDoc({ selectors: { [dom.SELECTORS.phaseDuel]: phaseLink } });
  const { win, worker } = env.page(
    'https://demonicscans.org/battle.php?id=557845671&veyra_visit=v1',
    doc,
  );
  worker.tick();
  assert.deepEqual(win.replaced, [
    'https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=557845671&veyra_visit=v1',
  ]);
  assert.equal(env.run().phase, 'duel');
});

test('the Phase 2 worker uses Power Slash while affordable and Slash otherwise', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['zeus'], '3b', '4b') });
  phasedBattleRun(env);
  env.phaseStates.push(livePhaseState(40));
  let page = env.page(
    'https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=557845671&veyra_visit=v1',
    fakeDoc(),
  );
  page.worker.tick();
  await flush();
  assert.match(env.fetches[0], /pvp_style_state\.php\?source=monster_phase/);
  assert.deepEqual(env.posts.at(-1), {
    url: '/pvp_style_action.php',
    params: {
      source: 'monster_phase',
      active_id: '557845671',
      action: 'use_skill',
      skill_id: '-1',
      target_key: 'enemy:monster_phase:557845671',
    },
  });

  env.phaseStates.push(livePhaseState(8));
  page = env.page(
    'https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=557845671&veyra_visit=v1',
    fakeDoc(),
  );
  page.worker.tick();
  await flush();
  assert.equal(env.posts.at(-1).params.skill_id, '0');
});

test('a won Phase 2 duel returns to the same boss and Phase 3 uses the combined damage target', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['zeus'], '3b', '4b') });
  phasedBattleRun(env);
  env.phaseStates.push({
    ...livePhaseState(),
    room_status: 'cleared',
    match: { ended: true, winner_side: 'ally' },
  });
  let page = env.page(
    'https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=557845671&veyra_visit=v1',
    fakeDoc(),
  );
  page.worker.tick();
  await flush();
  assert.deepEqual(page.win.replaced, [
    'https://demonicscans.org/battle.php?id=557845671&veyra_visit=v1',
  ]);
  assert.equal(env.run().phase, 'battle');
  assert.equal(env.run().target.damageValue, 7e9);

  env.controller = stubController();
  const ascendedDoc = fakeDoc({
    selectors: { [dom.SELECTORS.battleTitle]: el({ text: 'Zeus, Ascended Sovereign of the Storm Throne' }) },
  });
  page = env.page('https://demonicscans.org/battle.php?id=557845671&veyra_visit=v1', ascendedDoc);
  page.worker.tick();
  await flush();
  assert.deepEqual(env.controller.calls.slice(0, 2), [
    ['target', 7e9],
    ['attacks', ['-1', '0']],
  ]);
});

test('a failed fight returns to the hub for a retry; no stamina ends the visit', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  let page = env.page('https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1', fakeDoc());
  page.worker.tick();
  await flush();
  env.controller.emit({ running: false, finished: true, reason: 'error', message: 'Attack failed' });
  assert.equal(page.win.replaced.length, 1);
  assert.deepEqual(env.run().failed, []);
  assert.match(env.run().lastError, /error/);

  battleRun(env);
  env.controller = stubController();
  page = env.page('https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1', fakeDoc());
  page.worker.tick();
  await flush();
  env.controller.emit({ running: false, finished: true, reason: 'no-stamina' });
  assert.deepEqual(page.win.replaced, []);
  const status = env.status('olympus');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.match(status.message, /stamina/);
});

test('draining stops Monster Auto Battle and then reports safeToLeave', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  const { worker } = env.page('https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1', fakeDoc());
  worker.tick();
  await flush();
  assert.equal(env.controller.getState().running, true);

  env.setCommandPhase('draining');
  env.clock.time += 1_000;
  worker.tick();
  assert.deepEqual(env.controller.calls.at(-1), ['stop']);
  const status = env.status('olympus');
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.deepEqual(env.run().processed, [], 'the stop is not mistaken for a result');
});

test('draining on the hub ends the run at that safe point', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  const { worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  assert.ok(env.run());
  env.setCommandPhase('draining');
  env.clock.time += 1_000;
  const second = env.page(`${HUB}?gate=5&wave=16&veyra_visit=v1`, hubDoc());
  second.worker.tick();
  assert.equal(env.status('olympus').state, 'done');
  assert.equal(env.status('olympus').safeToLeave, true);
  assert.deepEqual(second.win.replaced, []);
});

test('battles without this visit marker are never touched', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  const { win, worker } = env.page('https://demonicscans.org/battle.php?id=557125237', fakeDoc());
  worker.tick();
  await flush();
  assert.deepEqual(env.controller.calls, []);
  assert.deepEqual(win.replaced, []);
  assert.equal(env.status('olympus'), null);
});

test('the battle page joins first when the game still shows Join the Battle', async () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  env.controller = stubController();
  const doc = fakeDoc({ selectors: { '#join-battle': el() } });
  const { win, worker } = env.page('https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1', doc);
  worker.tick();
  await flush();
  assert.deepEqual(env.posts, [
    { url: 'user_join_battle.php', params: { monster_id: '557125237', user_id: 159129 } },
  ]);
  assert.deepEqual(win.replaced, ['https://demonicscans.org/battle.php?id=557125237&veyra_visit=v1']);
  assert.deepEqual(env.controller.calls, []);
});

test('a wrong monster on the battle page abandons the target and returns', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  battleRun(env);
  const { win, worker } = env.page('https://demonicscans.org/battle.php?id=1&veyra_visit=v1', fakeDoc());
  worker.tick();
  assert.deepEqual(win.replaced, ['https://demonicscans.org/active_wave.php?gate=5&wave=16&veyra_visit=v1']);
  assert.deepEqual(env.run().failed, ['557125237']);
});

test('another tab with a live lease only waits', () => {
  const env = createEnv({ configure: (config) => enableOlympus(config, ['hera']) });
  env.store.write(logic.RUN_KEY, {
    ...logic.createRunState({ visitId: 'v1', routeId: 'olympus', ownerId: 'tab-elsewhere', now: env.clock.time }),
  });
  env.sessionStore.writeRaw(logic.OWNER_KEY, 'tab-mine');
  const { win, worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  assert.deepEqual(win.replaced, []);
  assert.equal(env.run().ownerId, 'tab-elsewhere');
});

test('a new visit never inherits the previous run', () => {
  const env = createEnv({ visitId: 'v2', configure: (config) => enableOlympus(config, ['hera']) });
  env.store.write(logic.RUN_KEY, {
    ...logic.createRunState({ visitId: 'v1', routeId: 'olympus', ownerId: 'tab-elsewhere', now: env.clock.time }),
    processed: ['557125237'],
  });
  const { worker } = env.page(`${HUB}?gate=5&wave=9`, hubDoc());
  worker.tick();
  const run = env.run();
  assert.equal(run.visitId, 'v2');
  assert.deepEqual(run.processed, []);
});
