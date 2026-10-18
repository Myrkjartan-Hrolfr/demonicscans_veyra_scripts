const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseCompanionContinueChoice,
  chooseCompanionFloor19Choice,
  chooseCompanionRecruitmentChoice,
  chooseQuestOffer,
  classifyQuestOffer,
  chooseFloorBossChoice,
  chooseFinalSealChoice,
  chooseMerchantAction,
  chooseSanctuaryChoice,
  choosePowerPlacement,
  companionLatchMatchesVisit,
  formatPowerWishlist,
  getCompanionRecruitmentFloor,
  getMerchantChoice,
  hasExactChoiceSignature,
  isCompanionContinueContext,
  isCompanionFloor19Context,
  isFloorBossDecisionContext,
  isFinalSealDecisionContext,
  isStartFloorDecisionContext,
  isStatusPotionName,
  matchStatusEffect,
  merchantLatchMatchesVisit,
  normalizeCompanionFlowLatch,
  normalizePowerKey,
  normalizePowerWishlist,
  normalizeStartFloors,
  orderRarityOffers,
  orderWishlistOffers,
  parseRatio,
  parseStartFloor,
  planAutoRestartAction,
  planStartFloorAction,
  sanitizeSettings,
  scoreQuestOffer,
  shouldClearCompanionFlowLatch,
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
      reason: 'uses a free Power slot',
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

test('recognizes the Status Potion item name with an optional inventory quantity', () => {
  assert.equal(isStatusPotionName(' Status   Potion '), true);
  assert.equal(isStatusPotionName('Status Potion x2'), true);
  assert.equal(isStatusPotionName('Status Potion × 12'), true);
  assert.equal(isStatusPotionName('Status Potion (x3)'), true);
  assert.equal(isStatusPotionName('Small Blood Potion'), false);
  assert.equal(isStatusPotionName('Status Potion Bundle'), false);
});

test('chooses sanctuary rewards from HP, threshold, and harmful status', () => {
  const choose = (hpPercent, hasStatus, healThreshold = 50) => {
    return chooseSanctuaryChoice({ hpPercent, healThreshold, hasStatus });
  };

  assert.equal(choose(100, false), 'blessing');
  assert.equal(choose(100, true), 'cleanse');
  assert.equal(choose(75, false), 'heal');
  assert.equal(choose(75, true), 'cleanse');
  assert.equal(choose(50, false), 'heal');
  assert.equal(choose(50, true), 'heal');
  assert.equal(choose(10, false), 'heal');
  assert.equal(choose(10, true), 'heal');
});

test('fails closed on unreadable sanctuary HP and clamps its threshold', () => {
  assert.equal(chooseSanctuaryChoice({ hpPercent: undefined, healThreshold: 50, hasStatus: false }), null);
  assert.equal(chooseSanctuaryChoice({ hpPercent: '', healThreshold: 50, hasStatus: false }), null);
  assert.equal(chooseSanctuaryChoice({ hpPercent: Number.NaN, healThreshold: 50, hasStatus: false }), null);
  assert.equal(chooseSanctuaryChoice({ hpPercent: -1, healThreshold: 50, hasStatus: false }), null);
  assert.equal(chooseSanctuaryChoice({ hpPercent: 0.5, healThreshold: 0, hasStatus: true }), 'heal');
  assert.equal(chooseSanctuaryChoice({ hpPercent: 98, healThreshold: 200, hasStatus: true }), 'heal');
  assert.equal(sanitizeSettings({ sanctuaryHealThreshold: 0 }).sanctuaryHealThreshold, 1);
  assert.equal(sanitizeSettings({ sanctuaryHealThreshold: 200 }).sanctuaryHealThreshold, 99);
  assert.equal(sanitizeSettings({ sanctuaryHealThreshold: 'invalid' }).sanctuaryHealThreshold, 50);
});

test('normalizes the independently selected Start Floor checkboxes', () => {
  assert.deepEqual(normalizeStartFloors(), []);
  assert.deepEqual(normalizeStartFloors('10,20'), []);
  assert.deepEqual(normalizeStartFloors([30, '10', 20, 10, 40, 'invalid']), [10, 20, 30]);
  assert.deepEqual(sanitizeSettings({ startFloors: [20, 40, '10'] }).startFloors, [10, 20]);
  assert.deepEqual(sanitizeSettings({ startFloors: '10,20' }).startFloors, []);
});

test('classifies known quest contracts and the unnamed two-slot contract', () => {
  assert.deepEqual(
    classifyQuestOffer({
      title: 'Unbroken Resolve',
      description: 'Clear three floors without replacing any power. New powers may use free slots.',
      rewardText: 'Reward: 120 coins / 2 energy.',
      choice: 'unchanging',
    }),
    {
      type: 'unchanging',
      title: 'Unbroken Resolve',
      description: 'Clear three floors without replacing any power. New powers may use free slots.',
      choice: 'unchanging',
      coins: 120,
      energy: 2,
    },
  );
  assert.equal(
    classifyQuestOffer({
      title: 'A different name',
      description: 'Lock 2 ability slots for 3 floors.',
      rewardText: 'Reward: 180 coins.',
      choice: 'mystery',
    }).type,
    'ability_lock',
  );
  assert.deepEqual(
    classifyQuestOffer({
      title: 'Trial of the Hex',
      description: 'Clear three floors using Magic, not Slash. Guard is allowed.',
      rewardText: '100 coins / 2 energy, subject to the daily energy limit.',
      choice: 'magic_only',
    }),
    {
      type: 'magic_only',
      title: 'Trial of the Hex',
      description: 'Clear three floors using Magic, not Slash. Guard is allowed.',
      choice: 'magic_only',
      coins: 100,
      energy: 2,
    },
  );
  assert.equal(classifyQuestOffer({ title: 'Unknown', description: 'Do a thing.', choice: 'x' }), null);
});

test('selects the best safe quest for the current build', () => {
  const unchanging = classifyQuestOffer({
    title: 'Unbroken Resolve',
    description: 'Clear three floors without replacing any power.',
    rewardText: 'Reward: 120 coins / 2 energy.',
    choice: 'unchanging',
  });
  const dryBlood = classifyQuestOffer({
    title: 'The Unquenched',
    description: 'Clear three floors without drinking an HP potion.',
    rewardText: 'Reward: 120 coins / 2 energy.',
    choice: 'dry_blood',
  });
  const cleaver = classifyQuestOffer({
    title: 'Trial of the Cleaver',
    description: 'Clear three floors using Slash, not Magic. Guard is allowed.',
    rewardText: 'Reward: 100 coins / 2 energy.',
    choice: 'blade_only',
  });
  const hex = classifyQuestOffer({
    title: 'Trial of the Hex',
    description: 'Clear three floors using Magic, not Slash. Guard is allowed.',
    rewardText: 'Reward: 100 coins / 2 energy.',
    choice: 'magic_only',
  });
  const slotLock = classifyQuestOffer({
    title: 'Unnamed offer',
    description: 'Locks two power slots for three floors.',
    rewardText: 'Reward: 180 coins.',
    choice: 'locked_slots',
  });

  assert.equal(
    chooseQuestOffer({
      offers: [slotLock, unchanging],
      context: { attack: 'slash', potionEnabled: false, powerMode: 'skip', currentFloor: 1, freePowerSlots: 2 },
    }),
    'locked_slots',
  );
  assert.equal(
    chooseQuestOffer({
      offers: [slotLock, unchanging],
      context: {
        attack: 'slash',
        potionEnabled: false,
        wishlistEpicReady: true,
        hpPotionUsedRecently: false,
        freePowerSlots: 1,
      },
    }),
    'unchanging',
  );
  assert.equal(
    chooseQuestOffer({
      offers: [dryBlood, cleaver],
      context: { attack: 'slash', potionEnabled: true, powerMode: 'skip', potionThreshold: 30, hpPercent: 20 },
    }),
    'blade_only',
  );
  assert.equal(
    chooseQuestOffer({
      offers: [cleaver, { type: 'unknown', choice: 'unknown', coins: 999, energy: 0 }],
      context: { attack: 'magic', potionEnabled: false, freePowerSlots: 4 },
    }),
    'blade_only',
  );
  assert.equal(
    chooseQuestOffer({
      offers: [hex, dryBlood],
      context: { hpPotionUsedRecently: true },
    }),
    'magic_only',
  );
  assert.equal(scoreQuestOffer(slotLock, { currentFloor: 2 }), null);
});

test('parses only unambiguous Start Floor values from semantic labels', () => {
  assert.equal(parseStartFloor('buy_start_floor_10'), 10);
  assert.equal(parseStartFloor('Unlock starting floor: 20'), 20);
  assert.equal(parseStartFloor('Purchase the 30th floor checkpoint'), 30);
  assert.equal(parseStartFloor('Floor 10 or Floor 20'), null);
  assert.equal(parseStartFloor('Buy for 10 coins'), null);
  assert.equal(parseStartFloor('Floor 40'), null);
});

test('recognizes an explicit buy-or-skip checkpoint even when its floor is unknown', () => {
  const panelText =
    'YOUR DECISION Bind this checkpoint? Boss defeated. Pay 200 Abyssal Coins to start your next run on floor 21.';

  assert.equal(parseStartFloor(panelText), null);
  assert.equal(
    isStartFloorDecisionContext({
      panelText,
      roomChoices: ['buy', 'skip'],
    }),
    true,
  );
  assert.equal(
    isStartFloorDecisionContext({
      panelText,
      roomChoices: ['buy'],
    }),
    false,
  );
  assert.equal(
    isStartFloorDecisionContext({
      panelText: 'Choose whether to buy or skip this unrelated room offer.',
      roomChoices: ['buy', 'skip'],
    }),
    false,
  );
});

test('recognizes companion recruitment only from an exact title and choice signature', () => {
  const companions = [
    ['Razek, the Disgraced Blade', 3],
    ['Veyshi, the Rune-Eater', 6],
    ['Ulgro, the Gentle Devourer', 9],
  ];

  for (const [title, floor] of companions) {
    assert.equal(getCompanionRecruitmentFloor({ title, roomChoices: ['rescue', 'leave'] }), floor);
    assert.equal(getCompanionRecruitmentFloor({ title, roomChoices: ['leave', 'rescue'] }), floor);
  }

  assert.equal(
    getCompanionRecruitmentFloor({ title: 'Unknown Prisoner', roomChoices: ['rescue', 'leave'] }),
    null,
  );
  assert.equal(
    getCompanionRecruitmentFloor({
      title: 'Razek, the Disgraced Blade!',
      roomChoices: ['rescue', 'leave'],
    }),
    null,
  );

  for (const roomChoices of [
    ['rescue'],
    ['rescue', 'leave', 'skip'],
    ['rescue', 'rescue'],
    ['rescue', ''],
    [],
    null,
    'rescue,leave',
  ]) {
    assert.equal(
      getCompanionRecruitmentFloor({ title: 'Razek, the Disgraced Blade', roomChoices }),
      null,
      String(roomChoices),
    );
  }

  assert.equal(hasExactChoiceSignature(['leave', 'rescue'], ['rescue', 'leave']), true);
  assert.equal(hasExactChoiceSignature(['rescue', 'rescue'], ['rescue', 'leave']), false);
});

test('recruits only the configured floor and leaves all other companion offers', () => {
  const companions = [
    ['Razek, the Disgraced Blade', '3'],
    ['Veyshi, the Rune-Eater', '6'],
    ['Ulgro, the Gentle Devourer', '9'],
  ];
  const roomChoices = ['rescue', 'leave'];

  for (const configuredFloor of ['none', '3', '6', '9']) {
    for (const [title, offeredFloor] of companions) {
      assert.equal(
        chooseCompanionRecruitmentChoice({
          configuredFloor,
          title,
          roomChoices,
          availableChoices: roomChoices,
        }),
        configuredFloor === offeredFloor ? 'rescue' : 'leave',
      );
    }
  }
});

test('companion recruitment fails closed for invalid, unavailable, or ambiguous actions', () => {
  const base = {
    configuredFloor: '3',
    title: 'Razek, the Disgraced Blade',
    roomChoices: ['rescue', 'leave'],
  };

  assert.equal(chooseCompanionRecruitmentChoice({ ...base, configuredFloor: 'manual' }), null);
  assert.equal(chooseCompanionRecruitmentChoice({ ...base, availableChoices: ['leave'] }), null);
  assert.equal(
    chooseCompanionRecruitmentChoice({
      ...base,
      availableChoices: ['rescue', 'rescue', 'leave'],
    }),
    null,
  );
  assert.equal(
    chooseCompanionRecruitmentChoice({
      ...base,
      roomChoices: ['rescue', 'leave', 'skip'],
      availableChoices: ['rescue', 'leave', 'skip'],
    }),
    null,
  );
});

test('recognizes and maps both exact Floor 19 companion choices', () => {
  const roomChoices = ['defend', 'surrender'];

  assert.equal(
    isCompanionFloor19Context({ title: 'Ulgro, the Gentle Devourer', roomChoices }),
    true,
  );
  assert.equal(
    isCompanionFloor19Context({ title: 'Veyshi, the Rune-Eater', roomChoices: [...roomChoices].reverse() }),
    true,
  );

  for (const configuredChoice of roomChoices) {
    assert.equal(
      chooseCompanionFloor19Choice({
        configuredChoice,
        title: 'Razek, the Disgraced Blade',
        roomChoices,
        availableChoices: roomChoices,
      }),
      configuredChoice,
    );
  }

  assert.equal(isCompanionFloor19Context({ title: 'Unknown Companion', roomChoices }), false);
  assert.equal(
    chooseCompanionFloor19Choice({
      configuredChoice: 'defend',
      title: 'Ulgro, the Gentle Devourer',
      roomChoices: ['defend', 'surrender', 'leave'],
      availableChoices: ['defend', 'surrender', 'leave'],
    }),
    null,
  );
  assert.equal(
    chooseCompanionFloor19Choice({
      configuredChoice: 'surrender',
      title: 'Ulgro, the Gentle Devourer',
      roomChoices,
      availableChoices: ['defend'],
    }),
    null,
  );
  assert.equal(
    chooseCompanionFloor19Choice({
      configuredChoice: 'defend',
      title: 'Ulgro, the Gentle Devourer',
      roomChoices,
      availableChoices: ['defend', 'defend'],
    }),
    null,
  );
});

test('continues only on the matching companion result with one usable action', () => {
  const latch = {
    stage: 'floor19',
    choice: 'defend',
    title: 'Ulgro, the Gentle Devourer',
    requestId: 'defend-request',
    revision: '109063',
  };
  const result = {
    latch,
    panelTitle: 'A promise kept',
    panelText: 'A promise kept Ulgro crushes his collar. Nobody goes back in a cage.',
    roomChoices: ['continue'],
    availableChoices: ['continue'],
  };

  assert.equal(chooseCompanionContinueChoice(result), 'continue');
  assert.equal(isCompanionContinueContext(result), true);
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      latch: null,
    }),
    'continue',
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      latch: null,
      panelText: 'A promise kept Razek cuts through his collar and steps forward.',
    }),
    'continue',
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      latch: { ...latch, title: 'Razek, the Disgraced Blade' },
    }),
    'continue',
    'the exact result must not be blocked by a stale companion latch',
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      panelText: 'Continue to an unrelated room without the companion.',
    }),
    null,
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      panelTitle: 'Victory',
    }),
    null,
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      roomChoices: ['continue', 'skip'],
      availableChoices: ['continue', 'skip'],
    }),
    null,
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      availableChoices: [],
    }),
    null,
  );
  assert.equal(
    chooseCompanionContinueChoice({
      ...result,
      availableChoices: ['continue', 'continue'],
    }),
    null,
  );

  const surrenderResult = {
    ...result,
    latch: { ...latch, choice: 'surrender' },
    panelTitle: 'The hunters depart',
    panelText: 'Ulgro leaves with the pit hunters. Continue.',
  };

  assert.equal(chooseCompanionContinueChoice(surrenderResult), 'continue');
});

test('validates and deduplicates persisted companion flow latches', () => {
  const latch = {
    stage: 'floor19',
    choice: 'defend',
    title: 'Ulgro, the Gentle Devourer',
    requestId: 'defend-request',
    revision: '109063',
    usedAt: 1234,
  };

  assert.deepEqual(normalizeCompanionFlowLatch(latch), latch);
  assert.equal(
    normalizeCompanionFlowLatch({ ...latch, stage: 'continue' }).stage,
    'continue',
  );
  assert.equal(normalizeCompanionFlowLatch({ ...latch, title: 'Unknown Companion' }), null);
  assert.equal(normalizeCompanionFlowLatch({ ...latch, requestId: '' }), null);
  assert.equal(normalizeCompanionFlowLatch({ ...latch, revision: '' }), null);
  assert.equal(normalizeCompanionFlowLatch({ ...latch, stage: 'invalid' }), null);
  assert.equal(normalizeCompanionFlowLatch({ ...latch, stage: 'recruitment', choice: 'defend' }), null);
  assert.equal(normalizeCompanionFlowLatch({ ...latch, choice: 'rescue' }), null);

  assert.equal(
    companionLatchMatchesVisit(latch, {
      requestIds: ['other-request', 'defend-request'],
      revisions: ['999999'],
    }),
    true,
  );
  assert.equal(
    companionLatchMatchesVisit(latch, {
      requestIds: ['other-request'],
      revisions: ['109063'],
    }),
    true,
  );
  assert.equal(
    companionLatchMatchesVisit(latch, {
      requestIds: ['other-request'],
      revisions: ['109064'],
    }),
    false,
  );
  assert.equal(companionLatchMatchesVisit(latch, {}), true);
  assert.equal(companionLatchMatchesVisit(latch, { requestIds: ['other-request'] }), true);
  assert.equal(companionLatchMatchesVisit(latch, { revisions: ['109064'] }), true);
});

test('keeps the Floor 19 latch through a possibly renumbered defense fight', () => {
  const floor19Latch = {
    stage: 'floor19',
    choice: 'defend',
    title: 'Ulgro, the Gentle Devourer',
    requestId: 'defend-request',
    revision: '109063',
  };

  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 19 }),
    false,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 20 }),
    false,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 3 }),
    true,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 10 }),
    true,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 18 }),
    true,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: floor19Latch, reportedFloor: 'unknown' }),
    false,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: { ...floor19Latch, stage: 'continue' }, preserveContinue: true }),
    false,
  );
  assert.equal(
    shouldClearCompanionFlowLatch({ latch: { ...floor19Latch, stage: 'continue' } }),
    true,
  );
});

test('recognizes only the exact Floor Boss preparation choices', () => {
  const matches = (roomChoices) => isFloorBossDecisionContext({ roomChoices });

  assert.equal(matches(['healing', 'armor', 'intact']), true);
  assert.equal(matches(['intact', 'healing', 'armor']), true);

  for (const roomChoices of [
    ['healing', 'armor'],
    ['healing', 'armor', 'intact', 'skip'],
    ['healing', 'armor', 'armor'],
    ['heal', 'armor', 'intact'],
    [],
    null,
    'healing,armor,intact',
  ]) {
    assert.equal(matches(roomChoices), false, String(roomChoices));
  }
});

test('maps configured Floor Boss choices and leaves manual decisions untouched', () => {
  const roomChoices = ['healing', 'armor', 'intact'];

  for (const configuredChoice of roomChoices) {
    assert.equal(
      chooseFloorBossChoice({ configuredChoice, roomChoices, availableChoices: roomChoices }),
      configuredChoice,
    );
  }

  assert.equal(
    chooseFloorBossChoice({ configuredChoice: 'manual', roomChoices, availableChoices: roomChoices }),
    null,
  );
  assert.equal(
    chooseFloorBossChoice({ configuredChoice: 'invalid', roomChoices, availableChoices: roomChoices }),
    null,
  );
});

test('Floor Boss automation fails closed for malformed or unavailable choices', () => {
  const roomChoices = ['healing', 'armor', 'intact'];

  assert.equal(
    chooseFloorBossChoice({
      configuredChoice: 'healing',
      roomChoices: ['healing', 'armor'],
      availableChoices: ['healing', 'armor'],
    }),
    null,
  );
  assert.equal(
    chooseFloorBossChoice({
      configuredChoice: 'healing',
      roomChoices: [...roomChoices, 'skip'],
      availableChoices: [...roomChoices, 'skip'],
    }),
    null,
  );
  assert.equal(
    chooseFloorBossChoice({
      configuredChoice: 'armor',
      roomChoices,
      availableChoices: ['healing', 'intact'],
    }),
    null,
  );
  assert.equal(
    chooseFloorBossChoice({
      configuredChoice: 'healing',
      roomChoices,
      availableChoices: ['healing', 'healing', 'armor', 'intact'],
    }),
    null,
  );
});

test('buys only checked Start Floors and declines every unchecked offer', () => {
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [10, 30],
      offeredFloors: [10],
      buyableFloors: [10],
      declineAvailable: true,
    }),
    { kind: 'buy', floor: 10 },
  );
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [10, 30],
      offeredFloors: [20],
      buyableFloors: [20],
      declineAvailable: true,
    }),
    { kind: 'decline', floor: null },
  );
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [],
      offeredFloors: [30],
      buyableFloors: [30],
      declineAvailable: true,
    }),
    { kind: 'decline', floor: null },
  );
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [],
      offeredFloors: [],
      buyableFloors: [],
      declineAvailable: true,
    }),
    { kind: 'decline', floor: null },
  );
  assert.equal(
    planStartFloorAction({
      selectedFloors: [20],
      offeredFloors: [],
      buyableFloors: [],
      declineAvailable: true,
    }),
    null,
  );
});

test('Start Floor purchases fail closed and are attempted at most once per run', () => {
  assert.equal(
    planStartFloorAction({
      selectedFloors: [10],
      offeredFloors: [10],
      buyableFloors: [],
      declineAvailable: true,
    }),
    null,
  );
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [10, 20],
      offeredFloors: [10, 20],
      buyableFloors: [10, 20],
      attemptedFloors: [10],
      declineAvailable: true,
    }),
    { kind: 'buy', floor: 20 },
  );
  assert.deepEqual(
    planStartFloorAction({
      selectedFloors: [10],
      offeredFloors: [10],
      buyableFloors: [10],
      attemptedFloors: [10],
      declineAvailable: true,
    }),
    { kind: 'decline', floor: null },
  );
});

test('clamps persisted merchant positions to choices one through four', () => {
  assert.equal(sanitizeSettings({ merchantChoice: 1 }).merchantChoice, 1);
  assert.equal(sanitizeSettings({ merchantChoice: 4 }).merchantChoice, 4);
  assert.equal(sanitizeSettings({ merchantChoice: 0 }).merchantChoice, 1);
  assert.equal(sanitizeSettings({ merchantChoice: 9 }).merchantChoice, 4);
  assert.equal(sanitizeSettings({ merchantChoice: 'invalid' }).merchantChoice, 1);
});

test('maps merchant positions to stable choices and never shifts after a card disappears', () => {
  assert.equal(getMerchantChoice(1), 'potion');
  assert.equal(getMerchantChoice(2), 'common');
  assert.equal(getMerchantChoice(3), 'epic');
  assert.equal(getMerchantChoice(4), 'legendary');
  assert.equal(getMerchantChoice(0), null);
  assert.equal(getMerchantChoice(5), null);
  assert.equal(getMerchantChoice('invalid'), null);

  const shiftedChoices = ['potion', 'epic', 'legendary', 'leave'];
  assert.equal(
    chooseMerchantAction({ position: 2, availableChoices: shiftedChoices }),
    null,
    'a missing common card must not make position 2 buy the epic card',
  );
});

test('buys one configured merchant offer and then leaves instead of buying again', () => {
  const initialChoices = ['potion', 'common', 'epic', 'legendary', 'leave'];

  assert.equal(chooseMerchantAction({ position: 3, availableChoices: initialChoices }), 'epic');
  assert.equal(
    chooseMerchantAction({
      position: 3,
      purchaseAttempted: true,
      availableChoices: ['potion', 'common', 'legendary', 'leave'],
    }),
    'leave',
    'removing the purchased card must lead to leave, not a shifted replacement',
  );
  assert.equal(
    chooseMerchantAction({
      position: 3,
      purchaseAttempted: true,
      availableChoices: ['potion', 'common', 'legendary'],
    }),
    null,
    'after a purchase it waits when leave is temporarily unavailable',
  );
});

test('keeps a merchant purchase latch only for the matching visit revision', () => {
  const latch = {
    choice: 'common',
    requestId: 'buy-request-1',
    revision: '21054',
  };

  assert.equal(
    merchantLatchMatchesVisit(latch, {
      revision: '99999',
      requestIds: ['leave-request', 'buy-request-1'],
    }),
    true,
    'the original request id identifies the same pre-response view',
  );
  assert.equal(merchantLatchMatchesVisit(latch, { revision: '21054' }), true);
  assert.equal(merchantLatchMatchesVisit(latch, { revision: '21055' }), true);
  assert.equal(
    merchantLatchMatchesVisit(latch, { revision: '21056' }),
    false,
    'a later merchant visit must not inherit the old purchase latch',
  );
  assert.equal(merchantLatchMatchesVisit(null, { revision: '21054' }), false);
  assert.equal(
    merchantLatchMatchesVisit(latch, {}),
    true,
    'missing server tokens fail closed to avoid a duplicate purchase',
  );
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
      questEnabled: true,
      companionFloor: 'none',
      companionFloor19Choice: 'defend',
      floorBossChoice: 'manual',
      finalSealChoice: 'manual',
      autoRestartEnabled: false,
      autoRestartKeyLimit: 1,
      startFloors: [],
      sanctuaryHealThreshold: 50,
      merchantChoice: 1,
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

test('keeps quest automation enabled by default and permits opting out', () => {
  assert.equal(sanitizeSettings({}).questEnabled, true);
  assert.equal(sanitizeSettings({ questEnabled: false }).questEnabled, false);
});

test('sanitizes persisted companion preferences', () => {
  for (const companionFloor of ['none', '3', '6', '9']) {
    assert.equal(sanitizeSettings({ companionFloor }).companionFloor, companionFloor);
  }

  for (const companionFloor19Choice of ['defend', 'surrender']) {
    assert.equal(
      sanitizeSettings({ companionFloor19Choice }).companionFloor19Choice,
      companionFloor19Choice,
    );
  }

  assert.equal(sanitizeSettings({ companionFloor: '19' }).companionFloor, 'none');
  assert.equal(sanitizeSettings({ companionFloor19Choice: 'pay' }).companionFloor19Choice, 'defend');
  assert.equal(sanitizeSettings({}).companionFloor, 'none');
  assert.equal(sanitizeSettings({}).companionFloor19Choice, 'defend');
});

test('sanitizes the persisted Floor Boss preference', () => {
  for (const floorBossChoice of ['healing', 'armor', 'intact', 'manual']) {
    assert.equal(sanitizeSettings({ floorBossChoice }).floorBossChoice, floorBossChoice);
  }

  assert.equal(sanitizeSettings({ floorBossChoice: 'invalid' }).floorBossChoice, 'manual');
  assert.equal(sanitizeSettings({}).floorBossChoice, 'manual');
});

test('recognizes only the exact final-seal decision and maps its setting', () => {
  const title = 'The final seal is broken.';
  const roomChoices = ['continue', 'leave'];

  assert.equal(isFinalSealDecisionContext({ title, roomChoices }), true);
  assert.equal(isFinalSealDecisionContext({ title: `${title}!`, roomChoices }), false);
  assert.equal(isFinalSealDecisionContext({ title, roomChoices: ['continue'] }), false);
  assert.equal(
    chooseFinalSealChoice({
      configuredChoice: 'continue',
      title,
      roomChoices,
      availableChoices: roomChoices,
    }),
    'continue',
  );
  assert.equal(
    chooseFinalSealChoice({
      configuredChoice: 'leave',
      title,
      roomChoices,
      availableChoices: roomChoices,
    }),
    'leave',
  );
  assert.equal(sanitizeSettings({ finalSealChoice: 'leave' }).finalSealChoice, 'leave');
  assert.equal(sanitizeSettings({ finalSealChoice: 'invalid' }).finalSealChoice, 'manual');
});

test('plans automatic Tower restarts within the total key budget', () => {
  assert.equal(planAutoRestartAction({ enabled: false }), null);
  assert.deepEqual(
    planAutoRestartAction({ enabled: true, keyLimit: 5, usedKeys: 0, hasActiveRun: true }),
    { kind: 'active', usedKeys: 1, keyLimit: 5 },
  );
  assert.deepEqual(
    planAutoRestartAction({ enabled: true, keyLimit: 5, usedKeys: 1, canOpenEntrance: true }),
    { kind: 'open', usedKeys: 1, keyLimit: 5 },
  );
  assert.deepEqual(
    planAutoRestartAction({
      enabled: true,
      keyLimit: 5,
      usedKeys: 1,
      entranceOpen: true,
      canStartRun: true,
    }),
    { kind: 'start', usedKeys: 1, keyLimit: 5 },
  );
  assert.deepEqual(
    planAutoRestartAction({ enabled: true, keyLimit: 5, usedKeys: 5, canOpenEntrance: true }),
    { kind: 'limit', usedKeys: 5, keyLimit: 5 },
  );
  assert.equal(sanitizeSettings({ autoRestartEnabled: true }).autoRestartEnabled, true);
  assert.equal(sanitizeSettings({ autoRestartKeyLimit: 5000 }).autoRestartKeyLimit, 999);
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
