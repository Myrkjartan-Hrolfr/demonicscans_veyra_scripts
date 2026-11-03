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
  });
});

test('standalone expedition combat uses expensive attacks before cheap attacks', () => {
  const decision = helpers.chooseCombatAction(battle(), catalog(), 42, { autoRescue: true });
  assert.equal(decision.action, 'order');
  assert.equal(decision.data.order.skill, 'expensive');
  assert.equal(decision.data.order.target, 'e1');
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
