'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GENERAL = require('../src/features/general');
const navigation = require('../src/features/general/custom-navigation');
const attackButtons = require('../src/features/general/better-attack-buttons');
const asterion = require('../src/features/general/asterion-detect');
const battlePass = require('../src/features/general/battle-pass');
const guild = require('../src/features/general/guild-member-sorting');
const inventory = require('../src/features/general/inventory-filter');
const merchant = require('../src/features/general/merchant-buy-max');
const damon = require('../src/features/general/damon-bulk-buy');
const { staminaCost } = require('../src/features/shared/asterion');

const url = (path) => new URL(`https://demonicscans.org${path}`);

// Document stub where every lookup finds nothing.
const emptyDoc = {
  body: null,
  head: null,
  documentElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => {
    throw new Error('should not create elements on an empty page');
  },
};

function stubCtx(settings = {}) {
  const written = {};
  return {
    doc: emptyDoc,
    win: { confirm: () => false },
    url: url('/game_dash.php'),
    store: { read: () => null, write: () => true },
    setting: (key) => settings[key],
    setSetting: (key, value) => {
      written[key] = value;
      return value;
    },
    pageGlobal: () => undefined,
    notify: () => {},
    log: () => {},
    warn: () => {},
    written,
  };
}

test('general features keep veyra-hud keys and defaults', () => {
  const defaults = Object.fromEntries(
    GENERAL.flatMap((feature) => feature.settings || []).map((setting) => [setting.key, setting.default]),
  );
  assert.equal(defaults['ui-improvements:betterGameTopBar'], true);
  assert.equal(defaults['ui-improvements:useCustomNavigation'], true);
  assert.equal(defaults['ui-improvements:useBetterAttackButtons'], true);
  assert.equal(defaults['ui-improvements:useAsterion'], false);
  assert.equal(defaults['ui-improvements:asterionValue'], 1.5);
  assert.equal(defaults['ui-improvements:scrollToCurrentLevel'], true);
  assert.equal(defaults['ui-improvements:syncBattlePassScrollbars'], true);
  assert.equal(defaults['ui-improvements:enableGuildMemberListSorting'], true);
  assert.equal(defaults['inventory-filter:enableInventoryFilter'], true);
  assert.equal(defaults['ui-improvements:enableBuyAllButtons'], true);
  assert.equal(defaults['veyra:shops:damonBulkBuy'], true);
  assert.equal(GENERAL[0].id, 'adventurers-guild-layout');
});

test('features only match their pages', () => {
  assert.equal(battlePass.matches(url('/battle_pass.php')), true);
  assert.equal(battlePass.matches(url('/game_dash.php')), false);
  assert.equal(guild.matches(url('/guild_members.php')), true);
  assert.equal(guild.matches(url('/guild.php')), false);
  assert.equal(inventory.matches(url('/inventory.php')), true);
  assert.equal(merchant.matches(url('/merchant.php')), true);
  assert.equal(merchant.matches(url('/black_merchant.php')), false);
  assert.equal(damon.matches(url('/olympus.php')), true);
  assert.equal(asterion.matches(url('/pets.php')), true);
  assert.equal(asterion.matches(url('/pets_shop.php')), false);
});

test('every general feature tolerates a page without its elements', async () => {
  const settings = Object.fromEntries(
    GENERAL.flatMap((feature) => feature.settings || []).map((setting) => [setting.key, setting.default]),
  );
  settings['ui-improvements:scrollToCurrentLevel'] = false;
  // adventurers-guild-layout predates this file and always adds its style.
  for (const feature of GENERAL.filter((candidate) => candidate.id !== 'adventurers-guild-layout')) {
    await feature.run(stubCtx(settings));
  }
});

test('nav href normalisation ignores host and parameter order', () => {
  assert.equal(
    navigation.normalizeNavHref('https://demonicscans.org/active_wave.php?wave=9&gate=5'),
    navigation.normalizeNavHref('/active_wave.php?gate=5&wave=9'),
  );
  assert.equal(navigation.normalizeNavHref('/Weekly.php'), '/weekly.php');
  assert.equal(navigation.normalizeNavHref(''), null);
});

test('nav plan follows the veyra-hud order on a vanilla menu', () => {
  const existing = [
    'Home',
    'Emberfall Event',
    'PvP',
    'Inventory',
    'Guild',
    'Merchant',
    'Blacksmith',
    'Battle Pass',
  ].map((label) => ({ label, href: `/${label.toLowerCase().replace(/\s/g, '_')}.php` }));
  const plan = navigation.planNavLinks(existing);
  assert.deepEqual(
    plan.map(({ link, after }) => `${link.label}<${after}`),
    [
      'Olympus<Home',
      'Wave 3<Olympus',
      'Arcane Wild Fringe<Emberfall Event',
      'Shadow Army<Inventory',
      'Guild Dungeons<Guild',
      'Black Merchant<Merchant',
      'Legendary Forge<Blacksmith',
      'Decraft Altar<Legendary Forge',
      'Weekly Leaderboard<Battle Pass',
    ],
  );
  assert.ok(!plan.some(({ link }) => /settings/i.test(link.label)));
});

test('nav plan survives a missing event item and skips existing links', () => {
  const plan = navigation.planNavLinks([
    { label: 'Home', href: '/game_dash.php' },
    { label: 'Olympus Waves', href: '/active_wave.php?wave=9&gate=5' },
    { label: 'Weekly Leaderboard', href: '/weekly.php' },
    { label: 'Battle Pass', href: '/battle_pass.php' },
  ]);
  assert.deepEqual(
    plan.map(({ link, after }) => `${link.label}<${after}`),
    ['Wave 3<Home', 'Arcane Wild Fringe<Wave 3'],
  );
  assert.deepEqual(navigation.planNavLinks([]), []);
});

test('attack button texts are parsed and scaled by the Asterion multiplier', () => {
  assert.deepEqual(attackButtons.parseSkillCost('20 MP / 200 STAM'), { mp: 20, stamina: 200 });
  assert.equal(attackButtons.parseSkillCost('Ready'), null);
  assert.deepEqual(attackButtons.parseAttackButtonText(' Power Slash (10 STAMINA) '), {
    name: 'Power Slash',
    stamina: 10,
  });
  assert.deepEqual(attackButtons.parseAttackButtonText('World Breaker Slash(1,000 STAMINA)'), {
    name: 'World Breaker Slash',
    stamina: 1000,
  });
  assert.deepEqual(attackButtons.parseAttackButtonText('Slash'), { name: 'Slash', stamina: 1 });
  assert.equal(attackButtons.formatAttackButtonText('Slash', staminaCost(1, 1.5)), 'Slash (2)');
  assert.equal(attackButtons.formatSkillCost(20, staminaCost(200, 3)), '20 MP / 600 STAM');
});

test('Asterion multiplier is read from the pets page', () => {
  assert.equal(asterion.parseAsterionMultiplier('Stamina cost x3'), 3);
  assert.equal(asterion.parseAsterionMultiplier('×2.5 stamina'), 2.5);
  assert.equal(asterion.parseAsterionMultiplier('max 3 stacks'), null);
  assert.equal(asterion.parseAsterionMultiplier(''), null);
  assert.equal(
    asterion.findAsterionMultiplier([
      { name: 'Wolf', powerText: 'x9' },
      { name: 'Asterion', powerText: 'no number' },
      { name: 'Asterion the Bull', powerText: 'x 2' },
    ]),
    2,
  );
  assert.equal(asterion.findAsterionMultiplier([{ name: 'Wolf', powerText: 'x9' }]), null);
});

test('battle pass finds the highest reached level', () => {
  assert.equal(
    battlePass.highestReachedLevel([
      ['Reached', 'L3'],
      ['L12', 'Reached'],
      ['L40'],
    ]),
    12,
  );
  assert.equal(battlePass.highestReachedLevel([]), null);
  assert.equal(battlePass.highestReachedLevel([['Reached']]), null);
  assert.equal(battlePass.centeredScrollLeft(1000, 100, 400), 850);
  assert.equal(battlePass.centeredScrollLeft(50, 100, 400), 0);
});

test('guild members sort by role, numbers, dates and text', () => {
  const rows = [
    ['Bob', 'Member', '1,200', '2025-01-03'],
    ['Ann', 'Leader', '900', '2024-12-31'],
    ['Cid', 'Vice', '15,000', '2025-02-01'],
    ['Dee', 'Member', '-', '2023-05-05'],
  ];
  assert.deepEqual(guild.sortGuildRows(rows, 1, true, true), [1, 2, 0, 3]);
  assert.deepEqual(guild.sortGuildRows(rows, 2, false), [3, 2, 0, 1]);
  assert.deepEqual(guild.sortGuildRows(rows, 2, true), [1, 0, 2, 3]);
  assert.deepEqual(guild.sortGuildRows(rows, 3, true), [3, 1, 0, 2]);
  assert.deepEqual(guild.sortGuildRows(rows, 0, false), [3, 2, 0, 1]);
  assert.deepEqual(guild.guildSortKey('Member 2'), [2, 'member 2']);
  assert.equal(guild.findRoleColumn(['Name', 'Level', 'Role']), 2);
  assert.equal(guild.findRoleColumn(['Name', 'Rank']), 1);
  assert.equal(guild.findRoleColumn([]), 1);
});

test('inventory filter helpers', () => {
  assert.deepEqual(inventory.uniqueItemNames([' Potion ', 'Potion', '', null, 'Gem "Red"']), [
    'Potion',
    'Gem "Red"',
  ]);
  assert.equal(inventory.isItemShown('Potion', true, { Potion: false }), false);
  assert.equal(inventory.isItemShown('Potion', false, { Potion: false }), true);
  assert.equal(inventory.isItemShown('Gem', true, { Potion: false }), true);
  assert.equal(inventory.isItemShown('Gem', true, null), true);
});

test('merchant Buy N plan respects limit and gold', () => {
  assert.deepEqual(merchant.planBuyMax({ price: '100', maxQuantity: '10', bought: '2', gold: 450 }), {
    quantity: 4,
    remaining: 8,
  });
  assert.deepEqual(merchant.planBuyMax({ price: '100', maxQuantity: '10', bought: '2', gold: 1e9 }), {
    quantity: 8,
    remaining: 8,
  });
  assert.equal(merchant.planBuyMax({ price: '100', maxQuantity: '10', bought: '2', gold: 50 }).quantity, 0);
  assert.equal(merchant.planBuyMax({ price: '100', maxQuantity: '10', bought: '9', gold: 1e9 }), null);
  assert.equal(merchant.planBuyMax({ price: '0', maxQuantity: '10', bought: '0', gold: 1e9 }), null);
  assert.equal(merchant.planBuyMax({ price: '100', maxQuantity: '', bought: '', gold: 1e9 }), null);
});

test('Damon bulk buy splits into batches of 99', () => {
  assert.deepEqual(damon.planBatches(250), [99, 99, 52]);
  assert.deepEqual(damon.planBatches(99), [99]);
  assert.deepEqual(damon.planBatches(0), []);
  assert.equal(damon.planBatches(10_000).length, 102);
  assert.equal(damon.clampBulkQuantity('20000'), 10_000);
  assert.equal(damon.clampBulkQuantity('0'), 1);
  assert.equal(damon.clampBulkQuantity('1,500'), 1500);
  assert.equal(damon.clampBulkQuantity('abc'), null);
  assert.equal(damon.needsConfirmation(99), false);
  assert.equal(damon.needsConfirmation(100), true);
  assert.equal(damon.isUnlimitedOffer('Price: 5 Gold\n No weekly limit'), true);
  assert.equal(damon.isUnlimitedOffer('Weekly limit: 3 / 20'), false);
});
