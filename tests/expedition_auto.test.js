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

test('standalone expedition tank moves to gather enemies while staying near the healer', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'tank', row: 6, col: 2 }),
        actor({ id: 'healer', uid: 99, class: 'healer', row: 7, col: 2 }),
      ],
      enemies: [enemy('left', 5, 1), enemy('right', 5, 3)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 5, col: 2 });
});

test('standalone expedition party movement closes a gap larger than three tiles to the healer', () => {
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
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 6, col: 1 });
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

test('standalone expedition healer moves safely toward the lowest ally outside heal range', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', row: 6, col: 2, skills: ['cheap', 'heal'] }),
        actor({ id: 'wounded', uid: 99, class: 'warrior', hp: 200, maxHp: 1_000, row: 6, col: 6 }),
      ],
      enemies: [enemy('e1', 3, 2)],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 6, col: 3 });
});

test('standalone expedition healer values heal range to the lowest ally before tank range', () => {
  const decision = helpers.chooseCombatAction(
    battle({
      actors: [
        actor({ class: 'healer', row: 4, col: 3, skills: ['cheap', 'heal'] }),
        actor({ id: 'tank', uid: 99, class: 'tank', row: 4, col: 0 }),
        actor({ id: 'wounded', uid: 98, class: 'warrior', hp: 200, maxHp: 1_000, row: 4, col: 7 }),
      ],
      enemies: [],
    }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 4, col: 4 });
});

test('standalone expedition healer escapes toward the party instead of isolating itself', () => {
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
  assert.equal(decision.action, 'move');
  assert.deepEqual(decision.data.position, { lane: 0, row: 7, col: 3 });
});

test('standalone expedition combat escapes danger and rescues humans first', () => {
  const escape = helpers.chooseCombatAction(
    battle({ ground_warning: [{ row: 6, col: 2 }] }),
    catalog(),
    42,
    { autoRescue: true },
  );
  assert.equal(escape.action, 'move');

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

test('standalone expedition powers follow the selected class', () => {
  assert.equal(helpers.choosePower(catalog().powers, 'mage'), 'arcane_well');
  assert.equal(helpers.choosePower(catalog().powers, 'tank'), 'iron_skin');
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
