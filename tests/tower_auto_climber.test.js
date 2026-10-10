const test = require('node:test');
const assert = require('node:assert/strict');

const {
  choosePowerPlacement,
  normalizePowerKey,
  orderRarityOffers,
  orderWishlistOffers,
  parseRatio,
  sanitizeSettings,
  uniquePowerNames,
} = require('../tower_auto_climber.user.js');

function power(name, rarity, extra = {}) {
  return {
    name,
    key: normalizePowerKey(name),
    rarity,
    ...extra,
  };
}

function replacement(value, name, rarity, extra = {}) {
  return {
    value,
    name,
    key: normalizePowerKey(name),
    rarity,
    disabled: false,
    isFree: false,
    ...extra,
  };
}

test('normalizes apostrophes, punctuation, spacing, and duplicate power names', () => {
  assert.equal(normalizePowerKey('  Executioner’s   Hand  '), 'executioners hand');
  assert.deepEqual(uniquePowerNames(['Skullbreaker', ' skullbreaker ', 'Raven Eye']), [
    'Skullbreaker',
    'Raven Eye',
  ]);
});

test('parses global capacity and per-power stack ratios', () => {
  assert.deepEqual(parseRatio('7/10 slots'), { current: 7, maximum: 10 });
  assert.deepEqual(parseRatio('1 of 3 stacks owned across rarities'), { current: 1, maximum: 3 });
  assert.equal(parseRatio('no ratio'), null);
});

test('wishlist order wins before rarity and rarity breaks ties', () => {
  const offers = [
    { ...power('Raven Eye', 'legendary'), index: 0 },
    { ...power('Skullbreaker', 'common'), index: 1 },
    { ...power('Skullbreaker', 'epic'), index: 2 },
  ];

  assert.deepEqual(
    orderWishlistOffers(offers, ['Skullbreaker', 'Raven Eye']).map((offer) => `${offer.name}:${offer.rarity}`),
    ['Skullbreaker:epic', 'Skullbreaker:common', 'Raven Eye:legendary'],
  );
  assert.deepEqual(orderRarityOffers(offers).map((offer) => offer.rarity), ['legendary', 'epic', 'common']);
});

test('uses the explicit free slot without replacing an owned power', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 0, maxStacks: 1 });
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('41', 'Raven Eye', 'common'),
  ];

  assert.deepEqual(
    choosePowerPlacement(candidate, options, ['Skullbreaker'], {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }),
    {
      kind: 'free',
      value: '0',
      reason: 'nutzt einen freien Power-Slot',
    },
  );
});

test('pauses when capacity says a slot is free but the current offer has no free-slot option', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 0, maxStacks: 1 });
  const options = [replacement('41', 'Raven Eye', 'common')];

  assert.equal(
    choosePowerPlacement(candidate, options, ['Skullbreaker'], {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }),
    null,
  );
});

test('does not use a free slot when a maxed stack needs a same-power rarity upgrade', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 1, maxStacks: 1 });
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('42', 'Skullbreaker', 'common'),
  ];

  assert.equal(
    choosePowerPlacement(candidate, options, ['Skullbreaker'], {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }).value,
    '42',
  );
});

test('never replaces an unrelated power when the offered power is already at its stack cap', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 1, maxStacks: 1 });
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('43', 'Ashen Wand', 'common'),
  ];

  assert.equal(
    choosePowerPlacement(candidate, options, ['Skullbreaker'], {
      hasSelect: true,
      hasFreeCapacity: false,
      strategy: 'wishlist',
    }),
    null,
  );
});

test('adds another wanted stack before upgrading the same power when an unlisted slot can be replaced', () => {
  const candidate = power('Crimson Vitality', 'epic', { ownedStacks: 1, maxStacks: 3 });
  const options = [
    replacement('44', 'Crimson Vitality', 'common'),
    replacement('45', 'Ashen Wand', 'common'),
  ];
  const placement = choosePowerPlacement(candidate, options, ['Crimson Vitality'], {
    hasSelect: true,
    hasFreeCapacity: false,
    strategy: 'wishlist',
  });

  assert.equal(placement.kind, 'replace-unlisted');
  assert.equal(placement.value, '45');
});

test('full wishlist replaces an unlisted power before another desired power', () => {
  const candidate = power('Skullbreaker', 'common', { ownedStacks: 0, maxStacks: 2 });
  const options = [
    replacement('11', 'Raven Eye', 'epic'),
    replacement('12', 'Ashen Wand', 'common'),
  ];
  const placement = choosePowerPlacement(candidate, options, ['Skullbreaker', 'Raven Eye'], {
    hasSelect: true,
    hasFreeCapacity: false,
    strategy: 'wishlist',
  });

  assert.equal(placement.kind, 'replace-unlisted');
  assert.equal(placement.value, '12');
});

test('wishlist only replaces a lower-priority desired power', () => {
  const candidate = power('Raven Eye', 'common', { ownedStacks: 0, maxStacks: 2 });
  const options = [replacement('21', 'Skullbreaker', 'common')];

  assert.equal(
    choosePowerPlacement(candidate, options, ['Skullbreaker', 'Raven Eye'], {
      hasSelect: true,
      hasFreeCapacity: false,
      strategy: 'wishlist',
    }),
    null,
  );

  const reverseCandidate = power('Skullbreaker', 'common', { ownedStacks: 0, maxStacks: 2 });
  const reversePlacement = choosePowerPlacement(
    reverseCandidate,
    [replacement('22', 'Raven Eye', 'legendary')],
    ['Skullbreaker', 'Raven Eye'],
    {
      hasSelect: true,
      hasFreeCapacity: false,
      strategy: 'wishlist',
    },
  );

  assert.equal(reversePlacement.kind, 'replace-lower-priority');
  assert.equal(reversePlacement.value, '22');
});

test('rarity mode protects wishlisted powers and only replaces a lower rarity', () => {
  const candidate = power('Infernal Riposte', 'epic', { ownedStacks: 0, maxStacks: 1 });
  const options = [
    replacement('31', 'Skullbreaker', 'common'),
    replacement('32', 'Ashen Wand', 'common'),
  ];
  const placement = choosePowerPlacement(candidate, options, ['Skullbreaker'], {
    hasSelect: true,
    hasFreeCapacity: false,
    strategy: 'rarity',
  });

  assert.equal(placement.value, '32');
  assert.equal(placement.kind, 'replace-lower-rarity');
});

test('sanitizes persisted settings and clamps unsafe delays and thresholds', () => {
  assert.deepEqual(
    sanitizeSettings({
      attack: 'invalid',
      potionEnabled: true,
      potionThreshold: 300,
      actionDelayMs: 10,
      preferredPowers: ['Raven Eye', 'raven eye'],
    }),
    {
      attack: 'slash',
      guardHeavy: true,
      potionEnabled: true,
      potionThreshold: 99,
      respectNoPotion: true,
      path: 'left',
      powerMode: 'wishlist',
      powerFallback: 'pause',
      preferredPowers: ['Raven Eye'],
      unknownDecision: 'pause',
      actionDelayMs: 750,
      collapsed: false,
    },
  );
});
