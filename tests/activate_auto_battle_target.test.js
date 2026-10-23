'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SKILL_KEYS,
  canSpendWithoutDelayingFinal,
  canUseSkill,
  chooseAttackPlan,
  isConfirmedSkillUse,
  isFinishedBattleState,
  parseInteger,
  roundsUntilFinalWish,
} = require('../activate_auto_battle_target.js');

function skills(overrides = {}) {
  const defaults = {
    [SKILL_KEYS.slash]: { available: true, cost: 0, resourceCost: 0 },
    [SKILL_KEYS.powerSlash]: { available: true, cost: 9, resourceCost: 0 },
    [SKILL_KEYS.venomRend]: { available: true, cost: 8, resourceCost: 0 },
    [SKILL_KEYS.deathMark]: { available: true, cost: 8, resourceCost: 0 },
    [SKILL_KEYS.finalWish]: {
      available: true,
      cost: 15,
      resourceCost: 100,
      requiresFullResource: true,
    },
  };

  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, { ...value, ...(overrides[key] || {}) }]),
  );
}

function choose({ tokens, resource, poisoned = false, bridge = false, overrides = {} }) {
  return chooseAttackPlan({
    tokens,
    resource,
    resourceMaximum: 100,
    enemyPoisoned: poisoned,
    bridgePending: bridge,
    skills: skills(overrides),
  });
}

test('calculates Slash-only preparation turns from both energy and tokens', () => {
  assert.equal(roundsUntilFinalWish({ tokens: 99, resource: 0 }), 4);
  assert.equal(roundsUntilFinalWish({ tokens: 99, resource: 25 }), 3);
  assert.equal(roundsUntilFinalWish({ tokens: 99, resource: 50 }), 2);
  assert.equal(roundsUntilFinalWish({ tokens: 99, resource: 75 }), 1);
  assert.equal(roundsUntilFinalWish({ tokens: 99, resource: 100 }), 0);
  assert.equal(roundsUntilFinalWish({ tokens: 9, resource: 100 }), 2);
  assert.equal(roundsUntilFinalWish({ tokens: null, resource: 100 }), Number.POSITIVE_INFINITY);
});

test('uses Final Wish immediately when both requirements are met', () => {
  assert.equal(choose({ tokens: 15, resource: 100 }).skillKey, SKILL_KEYS.finalWish);
  assert.equal(
    choose({ tokens: 15, resource: 100, poisoned: true, bridge: true }).skillKey,
    SKILL_KEYS.finalWish,
  );
});

test('always builds with Slash while fewer than 15 tokens are available', () => {
  assert.equal(choose({ tokens: 14, resource: 100 }).skillKey, SKILL_KEYS.slash);
  assert.equal(choose({ tokens: 8, resource: 75 }).skillKey, SKILL_KEYS.slash);
});

test('uses Death Mark only when it cannot delay the planned Final Wish', () => {
  assert.equal(choose({ tokens: 100, resource: 25 }).skillKey, SKILL_KEYS.slash);
  assert.equal(choose({ tokens: 22, resource: 75 }).skillKey, SKILL_KEYS.slash);
  assert.equal(choose({ tokens: 23, resource: 75 }).skillKey, SKILL_KEYS.deathMark);
  assert.equal(choose({ tokens: 19, resource: 50 }).skillKey, SKILL_KEYS.slash);

  const twoTurnSetup = choose({ tokens: 20, resource: 50 });
  assert.equal(twoTurnSetup.skillKey, SKILL_KEYS.deathMark);
  assert.equal(twoTurnSetup.prepareBridge, true);
});

test('plans the poisoned Death Mark, Venom Rend, Final Wish sequence', () => {
  const deathMark = choose({ tokens: 31, resource: 50, poisoned: true });
  assert.equal(deathMark.skillKey, SKILL_KEYS.deathMark);
  assert.equal(deathMark.prepareBridge, true);

  const venomRend = choose({ tokens: 23, resource: 75, poisoned: true, bridge: true });
  assert.equal(venomRend.skillKey, SKILL_KEYS.venomRend);
  assert.equal(venomRend.consumeBridge, true);

  assert.equal(choose({ tokens: 15, resource: 100, poisoned: true }).skillKey, SKILL_KEYS.finalWish);
});

test('plans the unpoisoned Death Mark, Power Slash, Final Wish sequence', () => {
  const deathMark = choose({ tokens: 32, resource: 50 });
  assert.equal(deathMark.skillKey, SKILL_KEYS.deathMark);
  assert.equal(deathMark.prepareBridge, true);

  const powerSlash = choose({ tokens: 24, resource: 75, bridge: true });
  assert.equal(powerSlash.skillKey, SKILL_KEYS.powerSlash);
  assert.equal(powerSlash.consumeBridge, true);

  assert.equal(choose({ tokens: 15, resource: 100 }).skillKey, SKILL_KEYS.finalWish);
});

test('accounts for Death Mark consuming the current build action', () => {
  assert.equal(
    canSpendWithoutDelayingFinal({ tokens: 23, skillCost: 8, rounds: 1 }),
    true,
  );
  assert.equal(
    canSpendWithoutDelayingFinal({ tokens: 22, skillCost: 8, rounds: 1 }),
    false,
  );
  assert.equal(
    canSpendWithoutDelayingFinal({ tokens: 20, skillCost: 8, rounds: 2 }),
    true,
  );
  assert.equal(
    canSpendWithoutDelayingFinal({ tokens: 19, skillCost: 8, rounds: 2 }),
    false,
  );
});

test('keeps the low-token Death Mark sequence on the original Final Wish turn', () => {
  const deathMark = choose({ tokens: 20, resource: 50 });
  assert.equal(deathMark.skillKey, SKILL_KEYS.deathMark);
  assert.equal(deathMark.prepareBridge, true);

  const slash = choose({ tokens: 12, resource: 75, bridge: true });
  assert.equal(slash.skillKey, SKILL_KEYS.slash);
  assert.equal(slash.consumeBridge, true);

  assert.equal(choose({ tokens: 15, resource: 100 }).skillKey, SKILL_KEYS.finalWish);
});

test('uses Venom Rend after a two-turn Death Mark only on a poisoned target with reserve', () => {
  assert.equal(
    choose({ tokens: 23, resource: 75, poisoned: true, bridge: true }).skillKey,
    SKILL_KEYS.venomRend,
  );
  assert.equal(
    choose({ tokens: 22, resource: 75, poisoned: true, bridge: true }).skillKey,
    SKILL_KEYS.slash,
  );
  assert.equal(
    choose({
      tokens: 23,
      resource: 75,
      poisoned: true,
      bridge: true,
      overrides: { [SKILL_KEYS.venomRend]: { available: false } },
    }).skillKey,
    SKILL_KEYS.slash,
  );
});

test('uses Power Slash after a two-turn Death Mark only without poison and with reserve', () => {
  assert.equal(
    choose({ tokens: 24, resource: 75, poisoned: false, bridge: true }).skillKey,
    SKILL_KEYS.powerSlash,
  );
  assert.equal(
    choose({ tokens: 23, resource: 75, poisoned: false, bridge: true }).skillKey,
    SKILL_KEYS.slash,
  );
});

test('falls back to Slash instead of another paid skill when a preferred skill is disabled', () => {
  assert.equal(
    choose({
      tokens: 23,
      resource: 75,
      overrides: { [SKILL_KEYS.deathMark]: { available: false } },
    }).skillKey,
    SKILL_KEYS.slash,
  );
  assert.equal(
    choose({
      tokens: 24,
      resource: 75,
      bridge: true,
      overrides: { [SKILL_KEYS.powerSlash]: { available: false } },
    }).skillKey,
    SKILL_KEYS.slash,
  );
});

test('does nothing when Slash itself is unavailable', () => {
  assert.equal(
    choose({
      tokens: 50,
      resource: 50,
      overrides: { [SKILL_KEYS.slash]: { available: false } },
    }).skillKey,
    null,
  );
});

test('still uses a ready Final Wish when Slash is unavailable', () => {
  assert.equal(
    choose({
      tokens: 15,
      resource: 100,
      overrides: { [SKILL_KEYS.slash]: { available: false } },
    }).skillKey,
    SKILL_KEYS.finalWish,
  );
});

test('does nothing when token or resource values cannot be read', () => {
  assert.equal(
    chooseAttackPlan({ tokens: null, resource: 100, resourceMaximum: 100, skills: skills() }).skillKey,
    null,
  );
  assert.equal(
    chooseAttackPlan({ tokens: 20, resource: null, resourceMaximum: 100, skills: skills() }).skillKey,
    null,
  );
});

test('treats missing or malformed cost metadata as unavailable', () => {
  const snapshot = { tokens: 100, resource: 100, resourceMaximum: 100 };

  assert.equal(canUseSkill({ available: true, cost: null, resourceCost: 0 }, snapshot), false);
  assert.equal(canUseSkill({ available: true, cost: 8, resourceCost: undefined }, snapshot), false);
  assert.equal(canUseSkill({ available: true, cost: 'invalid', resourceCost: 0 }, snapshot), false);
  assert.equal(canUseSkill({ available: true, cost: -1, resourceCost: 0 }, snapshot), false);
});

test('confirms skill logs only for the exact actor at the start of the line', () => {
  assert.equal(
    isConfirmedSkillUse('Ron used Death Mark on Enemy - dealt 1 damage.', 'Ron', 'Death Mark'),
    true,
  );
  assert.equal(
    isConfirmedSkillUse('Baron used Death Mark on Ron - dealt 1 damage.', 'Ron', 'Death Mark'),
    false,
  );
  assert.equal(isConfirmedSkillUse('Ron used Death Marker.', 'Ron', 'Death Mark'), false);
});

test('recognizes all native battle-end signals used for the lobby return', () => {
  const running = {
    statusText: 'Battle in progress',
    rewardsVisible: false,
    allyAlive: true,
    enemyAlive: true,
  };

  assert.equal(isFinishedBattleState(running), false);
  assert.equal(isFinishedBattleState({ ...running, statusText: 'Allied victory' }), true);
  assert.equal(isFinishedBattleState({ ...running, statusText: 'Enemy victory' }), true);
  assert.equal(isFinishedBattleState({ ...running, statusText: 'Draw' }), true);
  assert.equal(isFinishedBattleState({ ...running, rewardsVisible: true }), true);
  assert.equal(isFinishedBattleState({ ...running, enemyAlive: false }), true);
  assert.equal(isFinishedBattleState({ ...running, allyAlive: false }), true);
});

test('parses the Solo token values used by the lobby', () => {
  assert.equal(parseInteger('17'), 17);
  assert.equal(parseInteger('1.234'), 1234);
  assert.equal(parseInteger('Tokens: 5'), 5);
  assert.equal(parseInteger(''), null);
});
