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
