'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const leveler = require('../src/features/general/pet-food-leveler');

test('pet EXP curve matches the values exposed by the pets page', () => {
  assert.equal(leveler.expForLevel(1), 125);
  assert.equal(leveler.expForLevel(18), 2356);
  assert.equal(leveler.expForLevel(35), 8200);
  assert.equal(leveler.expForLevel(88), 49606);
  assert.equal(leveler.expToTarget(1, 0, 3), 281);
  assert.equal(leveler.expToTarget(35, 3923, 36), 4277);
});

test('food planner minimizes excess instead of exhausting one food type first', () => {
  const plan = leveler.optimalFoodPlan([
    { id: 1, name: 'Small', exp: 300, count: 10 },
    { id: 2, name: 'Large', exp: 1000, count: 3 },
  ], 1900);
  assert.equal(plan.reached, true);
  assert.equal(plan.totalExp, 1900);
  assert.equal(plan.waste, 0);
  assert.deepEqual(plan.items.map(({ id, quantity }) => ({ id, quantity })), [
    { id: 1, quantity: 3 },
    { id: 2, quantity: 1 },
  ]);
});

test('food planner uses all remaining food when the target cannot be reached', () => {
  const plan = leveler.optimalFoodPlan([
    { id: 1, exp: 300, count: 2 },
    { id: 2, exp: 1000, count: 1 },
  ], 2000);
  assert.equal(plan.reached, false);
  assert.equal(plan.totalExp, 1600);
  assert.deepEqual(plan.items.map(({ id, quantity }) => ({ id, quantity })), [
    { id: 1, quantity: 2 },
    { id: 2, quantity: 1 },
  ]);
});

test('ascension plan includes the escalating Forbidden Fruit costs', () => {
  assert.deepEqual(leveler.ascensionsToTarget(79, 120), [
    { level: 80, fruits: 1 },
    { level: 90, fruits: 2 },
    { level: 100, fruits: 4 },
    { level: 110, fruits: 8 },
  ]);
  assert.deepEqual(leveler.ascensionsToTarget(80, 90), [{ level: 80, fruits: 1 }]);
  assert.deepEqual(leveler.ascensionsToTarget(80, 80), []);
  assert.deepEqual(leveler.ascensionsToTarget(91, 105), [{ level: 100, fruits: 4 }]);
});
