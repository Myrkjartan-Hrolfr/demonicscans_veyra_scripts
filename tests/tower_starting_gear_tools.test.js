'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findRerollOffer,
  gearMatchesFilters,
  getRerollRarity,
  normalizeSearchText,
  parseNativePendingValue,
  revisionAdvanced,
  sanitizeFilters,
} = require('../tower_starting_gear_tools.user.js');

function makeGear({ rarity = 'legendary', name = 'Abysscaller Robe', details = '' } = {}) {
  return {
    rarity,
    searchText: normalizeSearchText(`${rarity} armor ${name} ${details}`),
  };
}

test('combines rarity and free-text filters for Abysscaller gear', () => {
  const gear = makeGear({ details: 'Blood Vitality Frost Channel' });

  assert.equal(
    gearMatchesFilters(gear, { rarity: 'legendary', query: 'Abysscaller' }),
    true,
  );
  assert.equal(gearMatchesFilters(gear, { rarity: 'epic', query: 'Abysscaller' }), false);
  assert.equal(gearMatchesFilters(gear, { rarity: 'legendary', query: 'Archfiend' }), false);
});

test('uses AND matching for multi-word searches across rarity, name, slot, and passives', () => {
  const gear = makeGear({ name: 'Abysscaller Grasp', details: 'Mana Drink Frost Channel' });

  assert.equal(gearMatchesFilters(gear, { rarity: 'all', query: 'legendary abysscaller mana' }), true);
  assert.equal(gearMatchesFilters(gear, { rarity: 'all', query: 'legendary abysscaller slash' }), false);
});

test('sanitizes saved filter values', () => {
  assert.deepEqual(sanitizeFilters({ rarity: ' LEGENDARY ', query: '  Mana   Drink ' }), {
    rarity: 'legendary',
    query: 'Mana Drink',
  });
  assert.deepEqual(sanitizeFilters({ rarity: 'unknown', query: null }), {
    rarity: 'all',
    query: '',
  });
});

test('recognizes only the two supported Merchant passive reroll cards', () => {
  assert.equal(getRerollRarity('Epic Equipment Passive Reroll', 'epic'), 'epic');
  assert.equal(
    getRerollRarity('Legendary Equipment Passive Reroll', 'legendary'),
    'legendary',
  );
  assert.equal(getRerollRarity('Legendary Equipment Passive Reroll', 'epic'), '');
  assert.equal(getRerollRarity('Abysscaller Robe', 'legendary'), '');
});

test('normalizes fixed English tokens independently of the browser locale', () => {
  assert.equal(normalizeSearchText('EPIC EQUIPMENT'), 'epic equipment');
  assert.equal(getRerollRarity('EPIC EQUIPMENT PASSIVE REROLL', 'EPIC'), 'epic');
});

test('maps gear to exactly one Merchant option by rarity, equipment ID, and name', () => {
  const gear = {
    equipmentId: '48780',
    name: 'Abysscaller Robe',
    rarity: 'legendary',
  };
  const matchingOffer = {
    rarity: 'legendary',
    submitter: { disabled: false },
    select: {
      options: [{ value: '48780', textContent: 'Abysscaller Robe', disabled: false }],
    },
  };

  assert.equal(findRerollOffer(gear, [matchingOffer]), matchingOffer);
  assert.equal(
    findRerollOffer(gear, [
      {
        ...matchingOffer,
        select: {
          options: [{ value: '48780', textContent: 'Archfiend Warplate', disabled: false }],
        },
      },
    ]),
    null,
  );
  assert.equal(findRerollOffer(gear, [matchingOffer, matchingOffer]), null);
  assert.equal(
    findRerollOffer(gear, [{ ...matchingOffer, submitter: { disabled: true } }]),
    null,
  );
  assert.equal(
    findRerollOffer(gear, [
      { ...matchingOffer, select: { ...matchingOffer.select, disabled: true } },
    ]),
    null,
  );
});

test('requires a newer revision before treating a reroll response as successful', () => {
  const before = { numericMaximum: 140684, values: new Set(['140684']) };

  assert.equal(
    revisionAdvanced(before, { numericMaximum: 140685, values: new Set(['140685']) }),
    true,
  );
  assert.equal(
    revisionAdvanced(before, { numericMaximum: 140684, values: new Set(['140684']) }),
    false,
  );
});

test('does not mistake the Tower pending sentinel for an active request', () => {
  assert.equal(parseNativePendingValue(null), null);
  assert.equal(parseNativePendingValue('null'), null);
  assert.deepEqual(parseNativePendingValue('{"url":"/tower","body":[]}'), {
    url: '/tower',
    body: [],
  });
  assert.equal(parseNativePendingValue('not-json'), null);
});
