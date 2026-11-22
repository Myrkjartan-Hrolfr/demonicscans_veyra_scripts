'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { helpers } = require('../expedition-auto.js');

function actor(patch = {}) {
  return {
    id: 'u1', uid: 42, name: 'Hunter', class: 'mage', hp: 1_000, maxHp: 1_000,
    energy: 100, row: 6, col: 2, skills: ['cheap', 'expensive'], cooldowns: {}, ...patch,
  };
}

function enemy(id, row, col, patch = {}) {
  return { id, name: id, hp: 200, maxHp: 200, row, col, footprint: 1, ...patch };
}

function catalog() {
  return {
    skills: {
      cheap: { name: 'Cheap Bolt', target: 'enemy', range: 3, cost: 0 },
      expensive: { name: 'Meteor', target: 'enemy', range: 3, cost: 40 },
      heal: { name: 'Greater Heal', text: 'Restore HP to an ally.', target: 'ally', range: 3, cost: 30 },
      guard: { name: 'Guard', target: 'self', cost: 0 },
      rescue: { name: 'Rescue', target: 'fallen', range: 3, cost: 30 },
    },
    powers: {
      iron_skin: { name: 'Iron Skin', text: 'More defense.' },
      arcane_well: { name: 'Arcane Well', text: 'More magic and energy.' },
    },
  };
}

function battle(patch = {}) {
  return {
    phase: 'battle', battleSerial: 7, round: 3, board: { rows: 8, cols: 8 },
    actors: [actor()], enemies: [enemy('e1', 3, 2)], objects: [], blocked: [],
    ground_warning: [], supplies: 3, ...patch,
  };
}

test('standalone expedition settings remain safe by default', () => {
  assert.deepEqual(helpers.normalizeSettings(null), {
    enabled: false,
    autoStart: false,
    fillWithNpcs: true,
    preferredClass: 'mage',
    preferredPower: 'sharpened_instinct',
    routeChoice: 'left',
    claimRareLoot: true,
    autoRescue: true,
    collapsed: false,
    disabledSkills: {},
  });
});

test('standalone expedition skill selection is stored per class and keeps zero-cost skills enabled', () => {
  const settings = helpers.normalizeSettings({
    disabledSkills: {
      mage: ['expensive', 'cheap', 'expensive', ''],
      unknown: ['cheap'],
    },
  });
  assert.deepEqual(settings.disabledSkills, { mage: ['expensive', 'cheap'] });
  assert.deepEqual(helpers.enabledCombatSkills(actor(), catalog(), settings), ['cheap']);
  assert.deepEqual(
    helpers.enabledCombatSkills(actor({ class: 'healer' }), catalog(), settings),
    ['cheap', 'expensive'],
  );
});

test('standalone expedition combat immediately respects disabled paid skills', () => {
  const decision = helpers.chooseCombatAction(
    battle(),
    catalog(),
    42,
    { autoRescue: true, disabledSkills: { mage: ['expensive'] } },
  );
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition healer does not use a heal disabled live by the player', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', skills: ['cheap', 'heal'] }),
        actor({ id: 'ally', uid: 99, class: 'warrior', hp: 200, maxHp: 1_000, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true, disabledSkills: { healer: ['heal'] } },
  );
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition combat uses expensive attacks before cheap attacks', () => {
  const decision = helpers.chooseCombatAction(battle(), catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'expensive');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition combat ends a paced turn after all useful actions are complete', () => {
  const run = battle({
    pacing_version: 1,
    actors: [actor({ acted_on: '7:3', moved_on: '7:3' })],
  });
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'finish');
  assert.equal(decision.key, 'finish:7:3');
  assert.deepEqual(decision.data, { round: 3, battle: 7 });
});

test('standalone expedition combat does not finish the same turn twice', () => {
  const run = battle({
    pacing_version: 1,
    section: 4,
    encounter: 2,
    actors: [actor({ acted_on: '7:3', moved_on: '7:3' })],
    pace_done: { u1: 'battle:4:2:7:3:0:' },
  });
  assert.equal(helpers.turnFinished(run, run.actors[0]), true);
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, '');
  assert.match(decision.message, /turn finished/i);
});

test('standalone expedition combat attacks enemy healers before bosses', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      enemies: [
        enemy('boss', 3, 2, { boss: true }),
        enemy('enemy-healer', 4, 2, { role: 'Healer' }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'expensive');
  assert.equal(decision.data.order.target, 'enemy-healer');
});

test('standalone expedition combat attacks Clown objectives instead of the immortal boss', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      enemies: [
        enemy('clown', 3, 2, { name: 'The Clown', role: 'Immortal', boss: true, immortal: true }),
        enemy('box', 4, 2, { name: 'Jack-in-the-Box', role: 'Destroy to break protection' }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.target, 'box');
});

test('standalone expedition combat recognizes and prioritizes Jack-in-the-Box by its API id', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      enemies: [
        enemy('enemy-healer', 4, 2, { role: 'Healer' }),
        enemy('clown_box_31', 5, 2, { name: '', role: '' }),
        enemy('clown', 3, 2, { name: 'The Clown', role: 'Immortal', boss: true, immortal: true }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(helpers.isJackInTheBox({ id: 'clown_box_31' }), true);
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'expensive');
  assert.equal(decision.data.order.target, 'clown_box_31');
});

test('standalone expedition endpoint preserves the active special mode', () => {
  const clown = helpers.createEndpoint('https://demonicscans.org', 'clown');
  assert.equal(clown.pathname, '/event_hunt.php');
  assert.equal(clown.searchParams.get('event'), '13');
  assert.equal(clown.searchParams.get('lodge_map'), '24');
  assert.equal(clown.searchParams.get('tab'), 'expeditions');
  assert.equal(clown.searchParams.get('mode'), 'clown');
  assert.equal(helpers.createEndpoint('https://demonicscans.org', 'bad mode!').searchParams.has('mode'), false);
});

test('standalone expedition endpoint follows the lodge map used by the page', () => {
  const endpoint = helpers.createEndpoint('https://demonicscans.org', 'normal', 30);
  assert.equal(endpoint.searchParams.get('lodge_map'), '30');
  assert.equal(helpers.normalizeLodgeMap('30'), 30);
  assert.equal(helpers.normalizeLodgeMap('invalid'), 24);
});

test('standalone expedition combat uses a cheaper skill when only it can reach an enemy healer', () => {
  const skillCatalog = catalog();
  skillCatalog.skills.expensive.range = 1;
  const decision = helpers.chooseCombatAction(
    battle({
      enemies: [
        enemy('nearby-boss', 5, 2, { boss: true }),
        enemy('enemy-healer', 4, 2, { role: 'Healer' }),
      ],
    }),
    skillCatalog,
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'enemy-healer');
});

test('standalone expedition healer prioritizes the lowest ally below 90 percent', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', hp: 400, maxHp: 1_000, skills: ['cheap', 'heal'] }),
        actor({ id: 'wounded', uid: 99, class: 'warrior', hp: 350, maxHp: 1_000, row: 5, col: 2 }),
        actor({ id: 'lowest', uid: 98, class: 'tank', hp: 850, maxHp: 1_000, row: 5, col: 3 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'heal');
  assert.equal(decision.data.order.target, 'wounded');
});

test('standalone expedition healer protects itself at 30 percent before rescuing', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', hp: 300, maxHp: 1_000, skills: ['cheap', 'heal'] }),
        actor({ id: 'fallen', uid: 99, class: 'warrior', hp: 0, maxHp: 1_000, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'heal');
  assert.equal(decision.data.order.target, 'u1');
});

test('standalone expedition healer includes itself when selecting the lowest reachable hp ratio', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', hp: 200, maxHp: 1_000, skills: ['cheap', 'heal'] }),
        actor({ id: 'ally', uid: 99, class: 'warrior', hp: 300, maxHp: 1_000, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'heal');
  assert.equal(decision.data.order.target, 'u1');
});

test('standalone expedition healer ignores a lower target outside the current heal range', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', hp: 800, maxHp: 1_000, skills: ['cheap', 'heal'] }),
        actor({ id: 'reachable', uid: 99, class: 'warrior', hp: 500, maxHp: 1_000, row: 5, col: 2 }),
        actor({ id: 'unreachable', uid: 98, class: 'tank', hp: 100, maxHp: 1_000, row: 0, col: 7 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'heal');
  assert.equal(decision.data.order.target, 'reachable');
});

test('standalone expedition healer attacks when nobody is below 90 percent', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', skills: ['cheap', 'heal'] }),
        actor({ id: 'ally', uid: 99, class: 'warrior', hp: 900, maxHp: 1_000, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition healer attacks when healing is not currently possible', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', energy: 10, skills: ['cheap', 'heal'] }),
        actor({ id: 'ally', uid: 99, class: 'warrior', hp: 200, maxHp: 1_000, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition tank attacks before moving to gather enemies near the healer', () => {
  const run = battle({
    actors: [
      actor({ class: 'tank', row: 6, col: 2 }),
      actor({ id: 'healer', uid: 99, class: 'healer', row: 7, col: 2 }),
    ],
    enemies: [enemy('left', 5, 1), enemy('right', 5, 3)],
  });
  const attack = helpers.chooseCombatAction(
    run,
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(attack.action, 'order');

  run.actors[0].acted_on = '7:3';
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 5, col: 2 });
});

test('standalone expedition ranged attacker attacks at three tiles instead of following the healer', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'mage', row: 6, col: 0 }),
        actor({ id: 'healer', uid: 99, class: 'healer', row: 6, col: 5 }),
      ],
      enemies: [enemy('e1', 3, 0)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition party movement takes a shielding position near the healer', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'warrior', row: 7, col: 3 }),
        actor({ id: 'healer', uid: 99, class: 'healer', row: 6, col: 4 }),
      ],
      enemies: [enemy('e1', 6, 0)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 6, col: 3 });
});

test('standalone expedition healer attacks before moving to bring teammates into heal range', () => {
  const run = battle({
    actors: [
      actor({ class: 'healer', row: 6, col: 2, skills: ['cheap', 'heal'] }),
      actor({ id: 'wounded', uid: 99, class: 'warrior', hp: 200, maxHp: 1_000, row: 6, col: 6 }),
    ],
    enemies: [enemy('e1', 3, 2)],
  });
  const attack = helpers.chooseCombatAction(
    run,
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(attack.action, 'order');

  run.actors[0].acted_on = '7:3';
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 6, col: 3 });
});

test('standalone expedition healer prefers covering the largest group over one wounded ally', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      board: { rows: 8, cols: 10 },
      actors: [
        actor({ class: 'healer', row: 4, col: 4, skills: ['cheap', 'heal'] }),
        actor({ id: 'ally-one', uid: 99, class: 'tank', row: 4, col: 0 }),
        actor({ id: 'ally-two', uid: 97, class: 'mage', row: 3, col: 1 }),
        actor({ id: 'ally-three', uid: 96, class: 'archer', row: 5, col: 1 }),
        actor({ id: 'wounded', uid: 98, class: 'warrior', hp: 200, maxHp: 1_000, row: 4, col: 8 }),
      ],
      enemies: [],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 4, col: 3 });
});

test('standalone expedition healer does not flee enemies when already centered in the party', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', row: 6, col: 3, skills: ['cheap', 'heal'] }),
        actor({ id: 'ally-one', uid: 99, class: 'warrior', row: 6, col: 4 }),
        actor({ id: 'ally-two', uid: 98, class: 'mage', row: 7, col: 4 }),
      ],
      enemies: [enemy('e1', 5, 3)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'cheap');
  assert.equal(decision.data.order.target, 'e1');
});

test('standalone expedition healer moves into attack range when nobody needs healing', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', row: 6, col: 2, skills: ['cheap', 'heal'] }),
        actor({ id: 'ally', uid: 99, class: 'warrior', row: 6, col: 3 }),
      ],
      enemies: [enemy('e1', 2, 2)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 5, col: 2 });
});

test('standalone expedition combat attacks before escaping danger', () => {
  const escape = helpers.chooseCombatAction(
    battle({ ground_warning: [{ row: 6, col: 2 }] }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(escape.action, 'order');
  assert.equal(escape.data.order.target, 'e1');

  const afterAttack = helpers.chooseCombatAction(
    battle({
      actors: [actor({ acted_on: '7:3' })],
      ground_warning: [{ row: 6, col: 2 }],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(afterAttack.action, 'move');
  assert.deepEqual(afterAttack.data.position, { lane: 0, row: 5, col: 2 });
});

test('standalone expedition combat rescues humans first', () => {
  const rescue = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ skills: ['cheap'] }),
        actor({ id: 'human', uid: 99, hp: 0, row: 5, col: 2 }),
        actor({ id: 'npc', uid: 0, bot: true, hp: 0, row: 5, col: 3 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(rescue.data.order.skill, 'rescue');
  assert.equal(rescue.data.order.target, 'human');
});

test('standalone expedition combat leaves active lethal boss-hazard tiles after attacking', () => {
  const run = battle({
    enemies: [enemy('clown', 3, 2, {
      boss: true,
      immortal: true,
      hazard: {
        skill: 'laughing_gas',
        resolve_round: 3,
        tiles: [{ row: 6, col: 2 }, { row: 6, col: 3 }],
      },
    })],
  });
  assert.equal(helpers.dangerTiles(run).has('6:2'), true);
  assert.deepEqual(helpers.chooseEmergencyEscape(run, run.actors[0]), { lane: 0, row: 5, col: 2 });
  run.actors[0].acted_on = '7:3';
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 5, col: 2 });
  assert.match(decision.message, /special-effect tile/i);
});

test('standalone expedition combat leaves persistent ground effects after attacking', () => {
  const run = battle({
    actors: [actor({ acted_on: '7:3' })],
    ground_warning: [{ row: 6, col: 2 }, { row: 6, col: 1 }],
  });
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 5, col: 2 });
});

test('standalone expedition combat always guards while interrupted', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({
          class: 'healer', hp: 200, maxHp: 1_000, skills: ['cheap', 'heal'], interrupted_until: 3,
        }),
        actor({ id: 'fallen', uid: 99, class: 'warrior', hp: 0, row: 5, col: 2 }),
      ],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'guard');
  assert.equal(decision.data.order.target, 'u1');
});

test('standalone expedition powers follow the selected class', () => {
  assert.equal(helpers.choosePower(catalog().powers, 'mage'), 'arcane_well');
  assert.equal(helpers.choosePower(catalog().powers, 'tank'), 'iron_skin');
});

test('standalone expedition uses the configured one of the three standard powers', () => {
  const powers = {
    reserve: { name: 'Deep Reserves', text: '+10% maximum HP.' },
    instinct: { name: 'Sharpened Instinct', text: '+10% ATK and Magic.' },
    defense: { name: 'Steadfast', text: '+15% Defense.' },
  };
  assert.equal(helpers.choosePower(powers, 'healer', [], 'deep_reserves'), 'reserve');
  assert.equal(helpers.choosePower(powers, 'healer', [], 'sharpened_instinct'), 'instinct');
  assert.equal(helpers.choosePower(powers, 'healer', [], 'steadfast'), 'defense');
  assert.equal(helpers.choosePower(powers, 'healer', ['instinct'], 'sharpened_instinct'), 'reserve');
});

test('standalone expedition confirms paced loot after all choices were saved', () => {
  const run = battle({
    phase: 'loot',
    pacing_version: 1,
    loot: [
      { id: 'personal', personal: true, claims: {} },
      { id: 'rare', personal: false, claims: { u1: true } },
    ],
  });
  const decision = helpers.choosePacedPhaseAction(
    run,
    run.actors[0],
    catalog(),
    { claimRareLoot: true },
    { id: 19, selection: 6 },
  );
  assert.equal(decision.action, 'finish');
  assert.deepEqual(decision.data, { party: 19, selection: 6 });
  assert.match(decision.message, /confirming loot/i);
});

test('standalone expedition saves missing paced loot choices before confirming', () => {
  const run = battle({
    phase: 'loot',
    pacing_version: 1,
    loot: [{ id: 'rare', personal: false, claims: {} }],
  });
  const decision = helpers.choosePacedPhaseAction(
    run,
    run.actors[0],
    catalog(),
    { claimRareLoot: false },
    { id: 19, selection: 6 },
  );
  assert.equal(decision.action, 'claim');
  assert.deepEqual(decision.data.lots, ['rare']);
  assert.equal(decision.data.selected, false);
});

test('standalone expedition fills every paced power slot and then confirms', () => {
  const choosingRun = battle({
    phase: 'powers',
    pacing_version: 1,
    power_picks: 2,
    powerChoices: { u1: { 0: 'arcane_well' } },
  });
  const choosing = helpers.choosePacedPhaseAction(
    choosingRun,
    choosingRun.actors[0],
    catalog(),
    {},
    { id: 19, selection: 7 },
  );
  assert.equal(choosing.action, 'power');
  assert.equal(choosing.data.pick, 1);
  assert.equal(choosing.data.power, 'iron_skin');

  choosingRun.powerChoices.u1[1] = 'iron_skin';
  const confirming = helpers.choosePacedPhaseAction(
    choosingRun,
    choosingRun.actors[0],
    catalog(),
    {},
    { id: 19, selection: 7 },
  );
  assert.equal(confirming.action, 'finish');
  assert.deepEqual(confirming.data, { party: 19, selection: 7 });
});

test('standalone expedition ticker keeps worker and fallback timers active in background tabs', () => {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const workers = [];
  const intervals = [];
  const clearedIntervals = [];
  const revokedUrls = [];
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const win = {
    document: {
      addEventListener: (name, listener) => documentListeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (documentListeners.get(name) === listener) documentListeners.delete(name);
      },
    },
    Worker: FakeWorker,
    Blob: class FakeBlob {},
    URL: {
      createObjectURL: () => 'blob:expedition-worker',
      revokeObjectURL: (url) => revokedUrls.push(url),
    },
    setInterval: (listener, delay) => {
      intervals.push({ listener, delay });
      return 17;
    },
    clearInterval: (id) => clearedIntervals.push(id),
    setTimeout: (listener) => listener(),
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (windowListeners.get(name) === listener) windowListeners.delete(name);
    },
  };
  let ticks = 0;
  const stop = helpers.createBackgroundTicker(win, () => { ticks += 1; }, 750);

  assert.equal(intervals[0].delay, 750);
  assert.deepEqual(workers[0].messages[0], { type: 'start', interval: 750 });
  workers[0].onmessage();
  documentListeners.get('visibilitychange')();
  windowListeners.get('pageshow')();
  assert.equal(ticks, 3);

  stop();
  assert.deepEqual(clearedIntervals, [17]);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(revokedUrls, ['blob:expedition-worker']);
  assert.equal(documentListeners.size, 0);
  assert.equal(windowListeners.size, 0);
});

test('standalone expedition detects server AFK warnings and active AI support', () => {
  assert.equal(helpers.needsControlResume(actor()), false);
  assert.equal(helpers.needsControlResume(actor({ afk_missed: 1 })), true);
  assert.equal(helpers.needsControlResume(actor({ afk_active: true })), true);
  assert.equal(helpers.needsControlResume(actor({ afk_active: 1 })), true);
  assert.equal(helpers.needsControlResume(actor({ afk_active: '1' })), true);
  assert.equal(helpers.needsControlResume(actor({ hp: 0, afk_active: true })), false);
});

test('standalone expedition still finds a human actor temporarily controlled by server AI', () => {
  const controlled = actor({ uid: 42, bot: true, afk_active: 1 });
  assert.equal(helpers.actorFor({ actors: [controlled] }, 42), controlled);
});

test('standalone expedition targets healer, mage, archer, then remaining enemies', () => {
  const run = battle({
    enemies: [
      enemy('tank', 2, 2, { class: undefined, role: 'Tank' }),
      enemy('archer', 2, 3, { role: 'Archer' }),
      enemy('mage', 2, 4, { role: 'Mage' }),
      enemy('healer', 2, 5, { role: 'Healer' }),
    ],
  });
  assert.equal(helpers.choosePriorityTarget(run).id, 'healer');
  run.enemies.find((unit) => unit.id === 'healer').hp = 0;
  assert.equal(helpers.choosePriorityTarget(run).id, 'mage');
  run.enemies.find((unit) => unit.id === 'mage').hp = 0;
  assert.equal(helpers.choosePriorityTarget(run).id, 'archer');
});

test('standalone expedition melee closes to one tile while ranged stops at three', () => {
  const target = enemy('target', 1, 2, { role: 'Warrior' });
  const meleeRun = battle({ actors: [actor({ class: 'warrior', row: 6, col: 2 })], enemies: [target] });
  const rangedRun = battle({ actors: [actor({ class: 'mage', row: 6, col: 2 })], enemies: [target] });
  assert.deepEqual(helpers.chooseMoveToward(meleeRun, meleeRun.actors[0], target), { lane: 0, row: 5, col: 2 });
  assert.deepEqual(helpers.chooseMoveToward(rangedRun, rangedRun.actors[0], target), { lane: 0, row: 5, col: 2 });
  rangedRun.actors[0].row = 4;
  assert.equal(helpers.chooseMoveToward(rangedRun, rangedRun.actors[0], target), null);
});

test('standalone expedition attacks barricades before ordinary enemies', () => {
  const run = battle({
    enemies: [enemy('warrior', 3, 2, { role: 'Warrior' })],
    objects: [enemy('barricade', 4, 2, { is_object: true, name: 'Barricade' })],
  });
  assert.equal(helpers.choosePriorityTarget(run).id, 'barricade');
  const decision = helpers.chooseCombatAction(run, catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.target, 'barricade');
});

test('standalone expedition protects dragon eggs by prioritizing the closest equal-role threat', () => {
  const run = battle({
    branch_objective: { type: 'cart' },
    objects: [enemy('o_cart', 4, 4, { name: 'Dragon eggs' })],
    enemies: [
      enemy('far', 0, 0, { role: 'Warrior' }),
      enemy('near', 3, 4, { role: 'Warrior' }),
    ],
  });
  assert.equal(helpers.choosePriorityTarget(run).id, 'near');
});

test('standalone expedition moves to a free beacon and stays once it arrives', () => {
  const run = battle({
    actors: [actor({ row: 6, col: 2 })],
    branch_objective: { type: 'beacons', tiles: [{ row: 4, col: 2 }] },
  });
  assert.deepEqual(helpers.chooseBeaconMove(run, run.actors[0]), { lane: 0, row: 5, col: 2 });
  run.actors[0].row = 4;
  assert.equal(helpers.chooseBeaconMove(run, run.actors[0]), null);
  assert.equal(helpers.holdsBeacon(run, run.actors[0]), true);
});
