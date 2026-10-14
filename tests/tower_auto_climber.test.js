const test = require('node:test');
const assert = require('node:assert/strict');

const {
  choosePowerPlacement,
  formatPowerWishlist,
  isStatusPotionName,
  matchStatusEffect,
  normalizePowerKey,
  normalizePowerWishlist,
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

test('normalizes wishlist target amounts while preserving legacy entries', () => {
  assert.deepEqual(
    normalizePowerWishlist([
      'Skullbreaker',
      { name: ' Raven Eye ', desiredStacks: 2 },
      'skullbreaker | 3',
      'Vampiric Edge | 0',
      'Crimson Vitality | 500',
      'Ashen Wand | invalid',
    ]),
    [
      { name: 'Skullbreaker', desiredStacks: null },
      { name: 'Raven Eye', desiredStacks: 2 },
      { name: 'Vampiric Edge', desiredStacks: 1 },
      { name: 'Crimson Vitality', desiredStacks: 99 },
      { name: 'Ashen Wand', desiredStacks: 1 },
    ],
  );

  assert.equal(
    formatPowerWishlist([
      { name: 'Skullbreaker', desiredStacks: null },
      { name: 'Raven Eye', desiredStacks: 2 },
    ]),
    'Skullbreaker\nRaven Eye | 2',
  );
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

test('stops adding a wishlisted power once its requested amount is reached', () => {
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('43', 'Ashen Wand', 'common'),
  ];
  const belowTarget = power('Skullbreaker', 'epic', { ownedStacks: 1, maxStacks: 3 });
  const atTarget = power('Skullbreaker', 'epic', { ownedStacks: 2, maxStacks: 3 });
  const wishlist = [{ name: 'Skullbreaker', desiredStacks: 2 }];

  assert.equal(
    choosePowerPlacement(belowTarget, options, wishlist, {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }).kind,
    'free',
  );
  assert.equal(
    choosePowerPlacement(atTarget, options, wishlist, {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }),
    null,
  );
  assert.equal(
    choosePowerPlacement(atTarget, options, wishlist, {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'rarity',
    }),
    null,
  );
});

test('still allows a same-power rarity upgrade after the requested amount is reached', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 2, maxStacks: 3 });
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('42', 'Skullbreaker', 'common'),
    replacement('43', 'Ashen Wand', 'common'),
  ];
  const placement = choosePowerPlacement(
    candidate,
    options,
    [{ name: 'Skullbreaker', desiredStacks: 2 }],
    {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    },
  );

  assert.equal(placement.kind, 'upgrade');
  assert.equal(placement.value, '42');
});

test('fails closed when an explicit target has no readable owned amount', () => {
  const candidate = power('Skullbreaker', 'epic', { maxStacks: 3 });
  const wishlist = [{ name: 'Skullbreaker', desiredStacks: 2 }];

  assert.equal(
    choosePowerPlacement(candidate, [], wishlist, {
      hasSelect: false,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }),
    null,
  );
});

test('caps a requested amount at the native maximum', () => {
  const candidate = power('Skullbreaker', 'epic', { ownedStacks: 3, maxStacks: 3 });
  const options = [
    replacement('0', '', '', { isFree: true }),
    replacement('43', 'Ashen Wand', 'common'),
  ];

  assert.equal(
    choosePowerPlacement(candidate, options, [{ name: 'Skullbreaker', desiredStacks: 99 }], {
      hasSelect: true,
      hasFreeCapacity: true,
      strategy: 'wishlist',
    }),
    null,
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

test('matches configured harmful statuses without substring false positives', () => {
  assert.equal(matchStatusEffect('Current status: Burned'), 'burned');
  assert.equal(matchStatusEffect('FROZEN solid'), 'frozen');
  assert.equal(matchStatusEffect('Poisoned (2 turns)'), 'poisoned');
  assert.equal(matchStatusEffect('A burnished shield'), '');
  assert.equal(matchStatusEffect('None'), '');
  assert.equal(
    matchStatusEffect('Burned', {
      burned: false,
      frozen: true,
      poisoned: true,
    }),
    '',
  );
});

test('recognizes only the exact Status Potion item name', () => {
  assert.equal(isStatusPotionName(' Status   Potion '), true);
  assert.equal(isStatusPotionName('Small Blood Potion'), false);
  assert.equal(isStatusPotionName('Status Potion Bundle'), false);
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
      statusPotionEnabled: false,
      statusPotionStatuses: {
        burned: true,
        frozen: true,
        poisoned: true,
      },
      respectNoPotion: true,
      path: 'left',
      powerMode: 'wishlist',
      powerFallback: 'pause',
      preferredPowers: [{ name: 'Raven Eye', desiredStacks: null }],
      unknownDecision: 'pause',
      actionDelayMs: 750,
      collapsed: false,
    },
  );
});

test('sanitizes persisted wishlist amounts and status potion choices', () => {
  const settings = sanitizeSettings({
    statusPotionEnabled: true,
    statusPotionStatuses: {
      burned: false,
      poisoned: false,
    },
    preferredPowers: 'Skullbreaker | 2\nRaven Eye | 4',
  });

  assert.equal(settings.statusPotionEnabled, true);
  assert.deepEqual(settings.statusPotionStatuses, {
    burned: false,
    frozen: true,
    poisoned: false,
  });
  assert.deepEqual(settings.preferredPowers, [
    { name: 'Skullbreaker', desiredStacks: 2 },
    { name: 'Raven Eye', desiredStacks: 4 },
  ]);
});
