'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const parse = require('../src/features/battle/mab-parse');
const {
  createDefaultSettings,
  createResumeStore,
  createSettingsStore,
  normalizeSettings,
  resumeKey,
  settingsKey,
} = require('../src/features/battle/mab-settings');
const {
  attackFromButton,
  getAttackCosts,
  mapSkillIdsToAttackKeys,
  reconcileAttackKeys,
} = require('../src/features/battle/mab-attacks');
const {
  applyPotionLists,
  collectPotions,
  getPotionType,
  movePotion,
  pickPotion,
  reconcilePotionSettings,
  usageAmount,
} = require('../src/features/battle/mab-potions');
const { createEngine, evaluateStopCondition } = require('../src/features/battle/mab-engine');
const { createController, normalizeTargetAmount } = require('../src/features/battle/mab-controller');
const bridge = require('../src/features/battle/mab-bridge');
const { FEATURES } = require('../src/features');

// ---- stubs -----------------------------------------------------------------

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

// Minimal element: answers querySelector(All) from a selector map.
function element({ text = '', dataset = {}, nodes = {}, lists = {}, closest = {}, ...rest } = {}) {
  return {
    textContent: text,
    dataset,
    isConnected: true,
    querySelector: (selector) => nodes[selector] || lists[selector]?.[0] || null,
    querySelectorAll: (selector) => lists[selector] || [],
    closest: (selector) => closest[selector] || null,
    getAttribute: () => null,
    ...rest,
  };
}

function attackButton(skillId, text, { skillName, classSkill = false, cost, dataset = {} } = {}) {
  return element({
    text,
    dataset: { skillId, ...(skillName ? { skillName } : {}), ...dataset },
    nodes: cost ? { '.skill-cost': { textContent: cost } } : {},
    closest: classSkill ? { '.class-skill-bar': {} } : {},
  });
}

function potionButton({ item, name, description = '', quantity }) {
  const card = element({
    dataset: { itemId: item },
    nodes: {
      '.potion-desc': { textContent: description },
      '.potion-qty-left': { textContent: `${quantity} left` },
    },
  });
  return element({ text: 'Use', dataset: { item, name }, closest: { '.potion-card': card } });
}

// ---- parsing -----------------------------------------------------------------

test('target damage parsing and display keep the original MAB rules', () => {
  assert.equal(parse.parseTarget(''), 0);
  assert.equal(parse.parseTarget('0'), 0);
  assert.equal(parse.parseTarget('5m'), 5e6);
  assert.equal(parse.parseTarget('2,5b'), 2.5e9);
  assert.equal(parse.parseTarget('1.250,5k'), 1_250_500);
  assert.equal(parse.parseTarget('5.000.000'), 5e6);
  assert.ok(Number.isNaN(parse.parseTarget('5 apples')));
  assert.equal(parse.formatTargetDisplay('3000000000'), '3.000.000.000');
  assert.equal(parse.formatTargetDisplay(' 2.5b '), '2.5b');
  assert.equal(parse.formatTargetDisplay('abc'), '');
  assert.equal(parse.cursorAfterFormat('12345', 4, '12.345'), 5);
});

test('numbers are read from decorated game text', () => {
  assert.equal(parse.parseInteger('Stamina: 1,234'), 1234);
  assert.equal(parse.parseInteger(null), null);
  assert.deepEqual(parse.parseFraction('💚 0 / 968,450 HP'), { current: 0, maximum: 968_450 });
  assert.equal(parse.parseFraction('—'), null);
  assert.equal(parse.parseLooseGameNumber('1.5m'), 1_500_000);
  assert.equal(parse.parseLooseGameNumber(12.6), 13);
  assert.equal(parse.firstGameNumber(undefined, 'x', '7'), 7);
  assert.equal(parse.retryAfterToMs('3'), 3000);
  assert.equal(parse.retryAfterToMs('999'), 120_000);
  assert.equal(parse.retryAfterToMs('soon'), null);
  assert.equal(parse.calculateExperienceGain({ current: 10, maximum: 100 }, { current: 40, maximum: 100 }), 30);
  assert.equal(parse.calculateExperienceGain({ current: 90, maximum: 100 }, { current: 5, maximum: 200 }), 15);
});

test('feedback, poison log entries and damage responses are classified', () => {
  assert.equal(parse.classifyFeedback('not enough stamina'), 'stamina');
  assert.equal(parse.classifyFeedback('insufficient mana'), 'mana');
  assert.equal(parse.classifyFeedback('you are dead'), 'dead');
  assert.equal(parse.classifyFeedback('please wait'), 'cooldown');
  assert.equal(parse.classifyFeedback('hello'), null);

  assert.equal(parse.getLogEntryPlayerName('⚔️ [END] Hero One used Poison Strike'), 'Hero One');
  assert.equal(parse.logEntryShowsActivePoison('⚔️ Hero used X and poisoned the enemy'), true);
  assert.equal(parse.logEntryShowsActivePoison('⚔️ Hero used X. Poison has worn off'), false);

  const hit = parse.parseFastAttackResponse(
    { ok: true, status: 200, retryAfterMs: null },
    JSON.stringify({ status: 'success', damage: '1,500', totaldmgdealt: 9000, exp_gain: 12, stamina_after: 40 }),
  );
  assert.equal(hit.ok, true);
  assert.equal(hit.damage, 1500);
  assert.equal(hit.totalDamage, 9000);
  assert.equal(hit.experienceGain, 12);
  assert.equal(hit.staminaAfter, 40);
  assert.equal(hit.monsterDead, false);

  const dead = parse.parseFastAttackResponse({ ok: true, status: 200 }, 'This monster is already dead.');
  assert.equal(dead.monsterDead, true);
  const failed = parse.parseFastAttackResponse(
    { ok: true, status: 200 },
    JSON.stringify({ status: 'error', message: 'Not enough stamina' }),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.feedbackType, 'stamina');
  assert.equal(parse.isRateLimited({ status: 429, message: '' }), true);
  assert.equal(parse.isRateLimited({ status: 200, message: 'You are attacking too fast' }), true);
  assert.equal(parse.isRateLimited({ status: 200, message: 'ok' }), false);
});

// ---- settings ---------------------------------------------------------------

test('settings keep the v6 storage keys and normalise broken values', () => {
  assert.equal(
    settingsKey('demonicscans.org', '/battle.php'),
    'tm-monster-auto-battle:settings:v6:demonicscans.org:/battle.php',
  );
  assert.equal(
    resumeKey('demonicscans.org', '/battle.php'),
    'tm-monster-auto-battle:resume:v3:demonicscans.org:/battle.php',
  );

  assert.deepEqual(normalizeSettings(null), createDefaultSettings());
  assert.deepEqual(normalizeSettings('garbage'), createDefaultSettings());

  const settings = normalizeSettings({
    attackKeys: ['0|Slash'],
    autoStamina: true,
    autoMana: 'yes',
    delayMs: -5,
    levelMultiplier: 0,
    targetDamage: '3b',
    potionEnabled: { 30: false },
    potionOrder: { stamina: [30, '251'], mana: 'bad' },
    extra: 'kept',
  });
  assert.deepEqual(settings.attackKeys, ['0|Slash', '', '']);
  assert.equal(settings.autoStamina, true);
  assert.equal(settings.autoMana, false);
  assert.equal(settings.delayMs, 100);
  assert.equal(settings.levelMultiplier, 2);
  assert.equal(settings.targetDamage, '3b');
  assert.deepEqual(settings.potionEnabled, { 30: false });
  assert.deepEqual(settings.potionOrder, { stamina: ['30', '251'], mana: [], health: [] });
  assert.equal(settings.extra, 'kept');
});

test('the settings store survives corrupt JSON and missing storage', () => {
  const key = settingsKey('h', '/battle.php');
  const storage = createStorage({ [key]: '{not json' });
  const store = createSettingsStore(storage, key);
  assert.deepEqual(store.load(), createDefaultSettings());
  store.save({ ...createDefaultSettings(), delayMs: 250 });
  assert.equal(JSON.parse(storage.getItem(key)).delayMs, 250);

  const missing = createSettingsStore(null, key);
  assert.deepEqual(missing.load(), createDefaultSettings());
  assert.doesNotThrow(() => missing.save({}));
});

test('resume state expires after a minute', () => {
  let now = 1_000_000;
  const storage = createStorage();
  const store = createResumeStore(storage, 'resume', () => now);
  store.save({ monsterKey: 'm', sessionDamage: 5 });
  assert.equal(store.load().sessionDamage, 5);
  now += 60_001;
  assert.equal(store.load(), null);
  assert.equal(storage.getItem('resume'), null);
});

// ---- attacks ----------------------------------------------------------------

test('attack discovery reads names, groups and costs from buttons', () => {
  const slash = attackFromButton(attackButton('0', 'Slash (1)'));
  assert.deepEqual(slash, {
    key: '0|Slash (1)',
    skillId: '0',
    name: 'Slash (1)',
    group: 'Standard Attacks',
    costs: { stamina: 1, mana: 0 },
  });

  const power = attackFromButton(attackButton('-1', 'Power Slash (10)', { skillName: 'Power Slash' }));
  assert.equal(power.key, '-1|Power Slash');
  assert.deepEqual(power.costs, { stamina: 10, mana: 0 });

  const skill = attackFromButton(
    attackButton('17', 'Venom', { skillName: 'Venom Bite', classSkill: true, cost: '20 MP / 200 STAM' }),
  );
  assert.equal(skill.group, 'Class Attacks');
  assert.deepEqual(skill.costs, { stamina: 200, mana: 20 });

  assert.deepEqual(getAttackCosts(attackButton('3', 'Strike', { dataset: { stamCost: '50' } })), {
    stamina: 50,
    mana: 0,
  });
  assert.equal(attackFromButton(null).name, 'Unnamed Attack');
});

test('attack slots keep valid choices, fill missing ones and sort expensive to cheap', () => {
  const costs = [1, 10, 50];
  const attacks = ['0|Slash', '-1|Power', '-2|Heroic'].map((key, index) => ({
    key,
    skillId: key.split('|')[0],
    costs: { stamina: costs[index], mana: 0 },
  }));
  const settings = { attackKeys: ['-1|Power', 'gone', ''], poisonAttackKey: 'gone' };
  reconcileAttackKeys(settings, attacks);
  assert.deepEqual(settings.attackKeys, ['-2|Heroic', '-1|Power', '0|Slash']);
  assert.equal(settings.poisonAttackKey, '');

  const single = { attackKeys: ['', '', ''], poisonAttackKey: '' };
  reconcileAttackKeys(single, [attacks[0]]);
  assert.deepEqual(single.attackKeys, ['0|Slash', '0|Slash', '0|Slash']);
});

test('controller skill ids map onto attack slots', () => {
  const attacks = [
    { key: '0|Slash', skillId: '0', group: 'Standard Attacks', costs: { stamina: 1, mana: 0 } },
    { key: '-1|Power', skillId: '-1', group: 'Standard Attacks', costs: { stamina: 10, mana: 0 } },
    { key: '-1|Class copy', skillId: '-1', group: 'Class Attacks', costs: { stamina: 10, mana: 0 } },
    { key: '-2|Heroic', skillId: '-2', group: 'Standard Attacks', costs: { stamina: 50, mana: 0 } },
    { key: '-3|Ultimate', skillId: '-3', group: 'Standard Attacks', costs: { stamina: 100, mana: 0 } },
  ];
  assert.deepEqual(mapSkillIdsToAttackKeys(attacks, ['-1', '0']), ['-1|Power', '0|Slash', '0|Slash']);
  assert.deepEqual(mapSkillIdsToAttackKeys(attacks, [-2]), ['-2|Heroic', '-2|Heroic', '-2|Heroic']);
  assert.deepEqual(mapSkillIdsToAttackKeys(attacks, ['99', '-3', '-3', '0', '-1', '-2']), [
    '-3|Ultimate',
    '-2|Heroic',
    '-1|Power',
  ]);
  assert.equal(mapSkillIdsToAttackKeys(attacks, ['99']), null);
  assert.equal(mapSkillIdsToAttackKeys(attacks, null), null);
});

// ---- potions ----------------------------------------------------------------

test('potions are classified and deduplicated by item id', () => {
  assert.equal(getPotionType('Small Stamina Potion', ''), 'stamina');
  assert.equal(getPotionType('Blue Vial', 'Restores mana'), 'mana');
  assert.equal(getPotionType('Full HP Potion', ''), 'health');
  assert.equal(getPotionType('Lucky Charm', 'More drops'), 'other');

  const potions = collectPotions([
    potionButton({ item: '30', name: 'Small Stamina Potion', quantity: 3 }),
    potionButton({ item: '30', name: 'Small Stamina Potion', quantity: 7 }),
    potionButton({ item: '108', name: 'Full HP Potion', quantity: 2 }),
    potionButton({ item: '5', name: 'Lucky Charm', quantity: 1 }),
  ]);
  assert.deepEqual(
    potions.map((potion) => [potion.key, potion.type, potion.quantity]),
    [
      ['30', 'stamina', 7],
      ['108', 'health', 2],
    ],
  );
});

test('potion priorities, enable flags and amounts', () => {
  const settings = createDefaultSettings();
  settings.potionOrder.stamina = ['251', 'gone', '30'];
  settings.potionEnabled = { 251: false };
  settings.potionUseAmount = { 30: 5 };
  const potions = [
    { key: '30', itemId: '30', type: 'stamina', quantity: 3 },
    { key: '251', itemId: '251', type: 'stamina', quantity: 4 },
    { key: '35', itemId: '35', type: 'stamina', quantity: 0 },
    { key: '108', itemId: '108', type: 'health', quantity: 1 },
  ];
  reconcilePotionSettings(settings, potions);
  assert.deepEqual(settings.potionOrder.stamina, ['251', '30', '35']);
  assert.deepEqual(settings.potionOrder.health, ['108']);
  assert.equal(settings.potionEnabled['30'], true);
  assert.equal(settings.potionEnabled['251'], false);

  // 251 is disabled, 30 is next; 35 has no stock.
  assert.equal(pickPotion(settings, potions, 'stamina').key, '30');
  assert.equal(pickPotion(settings, potions, 'mana'), null);
  // Item 30 supports multi-use: configured 5, capped by the stock of 3.
  assert.equal(usageAmount(settings, potions[0]), 3);
  assert.equal(usageAmount(settings, potions[1]), 1);

  assert.equal(movePotion(settings, 'stamina', 0, -1), false);
  assert.equal(movePotion(settings, 'stamina', 0, 1), true);
  assert.deepEqual(settings.potionOrder.stamina, ['30', '251', '35']);
});

test('controller potion lists map onto the per-type enable and priority settings', () => {
  const settings = createDefaultSettings();
  settings.autoMana = true;
  settings.potionOrder = { stamina: ['30', '251'], mana: ['77'], health: ['108'] };
  settings.potionEnabled = { 30: true, 251: true, 77: true, 108: true };
  const potions = [
    { key: '30', type: 'stamina' },
    { key: '251', type: 'stamina' },
    { key: '999', type: 'stamina' },
    { key: '108', type: 'health' },
  ];

  applyPotionLists(settings, { stamina: [251, 35], heal: [] }, potions);
  assert.deepEqual(settings.potionOrder.stamina.slice(0, 2), ['251', '35']);
  assert.equal(settings.potionEnabled['251'], true);
  assert.equal(settings.potionEnabled['35'], true);
  assert.equal(settings.potionEnabled['30'], false);
  assert.equal(settings.potionEnabled['999'], false);
  // Catalog potions not on the page are disabled too, so they never get
  // enabled by default when they appear later.
  assert.equal(settings.potionEnabled['359'], false);
  assert.equal(settings.autoStamina, true);
  assert.equal(settings.potionEnabled['108'], false);
  assert.equal(settings.autoHealth, false);
  // Mana is not part of the automation interface.
  assert.equal(settings.autoMana, true);
  assert.equal(settings.potionEnabled['77'], true);

  applyPotionLists(settings, { heal: ['108'] }, potions);
  assert.equal(settings.autoHealth, true);
  assert.equal(settings.potionEnabled['108'], true);
  // stamina list missing -> untouched
  assert.equal(settings.autoStamina, true);

  applyPotionLists(settings, { stamina: [] }, potions);
  assert.equal(settings.autoStamina, false);
  assert.equal(settings.potionEnabled['251'], false);
});

// ---- stop conditions --------------------------------------------------------

test('stop conditions report target, defeat and level-up protection', () => {
  const base = {
    monsterDead: false,
    totalDamage: 100,
    target: 0,
    stopBeforeLevelUp: false,
    lastExperienceGain: null,
    levelMultiplier: 2,
    remainingExperience: null,
  };
  assert.equal(evaluateStopCondition(base), null);
  assert.equal(evaluateStopCondition({ ...base, monsterDead: true }).reason, 'defeated');
  assert.equal(evaluateStopCondition({ ...base, target: 100 }).reason, 'target');
  assert.equal(evaluateStopCondition({ ...base, target: 101 }), null);
  assert.equal(evaluateStopCondition({ ...base, target: NaN }), null);
  assert.equal(evaluateStopCondition({ ...base, target: 50, totalDamage: null }), null);

  const guard = { ...base, stopBeforeLevelUp: true, lastExperienceGain: 10 };
  assert.equal(evaluateStopCondition({ ...guard, remainingExperience: 25 }), null);
  const levelStop = evaluateStopCondition({ ...guard, remainingExperience: 19 });
  assert.equal(levelStop.reason, 'stopped');
  assert.match(levelStop.message, /Level-up protection/);
  assert.equal(evaluateStopCondition({ ...guard, remainingExperience: null }).reason, 'error');
  // Without a known EXP gain the guard does not trigger yet.
  assert.equal(evaluateStopCondition({ ...guard, lastExperienceGain: null, remainingExperience: 1 }), null);
});

test('target amounts from the bridge are normalised', () => {
  assert.equal(normalizeTargetAmount(3e9), '3000000000');
  assert.equal(normalizeTargetAmount(1.2), '2');
  assert.equal(normalizeTargetAmount(0), '0');
  assert.equal(normalizeTargetAmount('1.25b'), '1.25b');
  assert.equal(normalizeTargetAmount(-1), null);
  assert.equal(normalizeTargetAmount(NaN), null);
  assert.equal(normalizeTargetAmount('lots'), null);
  assert.equal(normalizeTargetAmount(''), null);
});

// ---- engine + controller with a stub page -----------------------------------

function createBattlePage({
  hp = '100 / 100',
  damage = '0',
  stamina = '100',
  buttons,
  potions = [],
  search = '',
  postForm,
} = {}) {
  const attackButtons = buttons || [
    attackButton('0', 'Slash (1)'),
    attackButton('-1', 'Power Slash (10)', { skillName: 'Power Slash' }),
    attackButton('17', 'Venom', { skillName: 'Venom Bite', classSkill: true, cost: '0 MP / 5 STAM' }),
  ];
  const damageNode = { textContent: damage };
  const hpNode = { textContent: hp };
  const card = element({
    nodes: { '#yourDamageValue': damageNode, '#hpText': hpNode, '.card-title': { textContent: 'Goblin' } },
    lists: { 'button.attack-btn': attackButtons },
    classList: { contains: () => false },
  });
  const staminaNode = { textContent: stamina };
  const doc = element({
    nodes: { '#stamina_span': staminaNode },
    lists: { '.battle-card.monster-card': [card], '.potion-use-btn': potions },
  });
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const win = {
    location: { pathname: '/battle.php', search },
    fetch: async () => ({ ok: false, text: async () => '' }),
  };
  const engine = createEngine({
    doc,
    win,
    postForm: postForm || (async () => assert.fail('unexpected request')),
    settingsStore: createSettingsStore(localStorage, 'settings'),
    resumeStore: createResumeStore(sessionStorage, 'resume'),
  });
  engine.setCard(card);
  return { engine, card, damageNode, hpNode, staminaNode, localStorage };
}

test('a start on a defeated monster finishes with reason defeated', async () => {
  const { engine } = createBattlePage({ hp: '0 / 100' });
  await engine.start();
  const state = engine.getState();
  assert.equal(state.running, false);
  assert.equal(state.finished, true);
  assert.equal(state.reason, 'defeated');
  assert.equal(state.monsterHp, 0);
});

test('a start with the damage target already reached finishes with reason target', async () => {
  const { engine } = createBattlePage({ damage: '3,000,000,000' });
  engine.state.settings.targetDamage = '3b';
  await engine.start();
  const state = engine.getState();
  assert.equal(state.finished, true);
  assert.equal(state.reason, 'target');
  assert.equal(state.yourDamage, 3e9);
  assert.equal(state.targetDamage, 3e9);
  assert.match(state.message, /target of 3,000,000,000 was reached/);
});

test('running out of stamina without allowed potions finishes with reason no-stamina', async () => {
  const { engine } = createBattlePage({ stamina: '0' });
  const controller = createController(engine);
  assert.equal(controller.setAttacks(['-1']), true);
  controller.setPotions({ stamina: [], heal: [] });
  const changes = [];
  controller.onChange((snapshot) => changes.push(snapshot));
  await engine.start();
  const state = controller.getState();
  assert.equal(state.finished, true);
  assert.equal(state.reason, 'no-stamina');
  assert.equal(changes.at(-1).reason, 'no-stamina');
});

test('a failed validation finishes with reason error', async () => {
  const { engine } = createBattlePage({ buttons: [] });
  await engine.start();
  assert.equal(engine.getState().reason, 'error');
  assert.equal(engine.getState().message, 'Please select a valid Attack 1.');
});

test('the fast attack posts to damage.php and stops at the target', async () => {
  const requests = [];
  const postForm = async (url, params, options) => {
    requests.push({ url, params, options });
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({ status: 'success', damage: 500, totaldmgdealt: 3_000_000_000 }),
      json: null,
    };
  };
  const { engine, damageNode } = createBattlePage({
    damage: '2,999,999,500',
    search: '?dgmid=11&instance_id=22',
    postForm,
  });
  const controller = createController(engine);
  controller.setAttacks(['-1', '0']);
  controller.setTargetDamage(3e9);
  engine.state.settings.delayMs = 0;
  await engine.start();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/damage.php');
  assert.deepEqual(requests[0].params, { instance_id: '22', dgmid: '11', skill_id: '-1', stamina_cost: '10' });
  assert.equal(typeof requests[0].options.fetchImpl, 'function');
  assert.equal(damageNode.textContent, '3,000,000,000');
  const state = controller.getState();
  assert.equal(state.reason, 'target');
  assert.equal(state.yourDamage, 3e9);
});

test('controller maps attacks, potions and target into the saved settings', async () => {
  const potions = [
    potionButton({ item: '30', name: 'Small Stamina Potion', quantity: 4 }),
    potionButton({ item: '251', name: 'Large Stamina Potion', quantity: 4 }),
    potionButton({ item: '108', name: 'Full HP Potion', quantity: 1 }),
  ];
  const { engine, localStorage } = createBattlePage({ potions });
  let synced = 0;
  const controller = createController(engine, () => {
    synced += 1;
  });
  engine.state.settings.poisonAttackKey = '17|Venom Bite';

  assert.equal(controller.setAttacks(['42']), false);
  assert.equal(controller.setAttacks(['0', '-1']), true);
  assert.deepEqual(engine.state.settings.attackKeys, ['-1|Power Slash', '0|Slash (1)', '0|Slash (1)']);
  assert.equal(engine.state.settings.poisonAttackKey, '');

  controller.setPotions({ stamina: [251], heal: [108] });
  const saved = JSON.parse(localStorage.getItem('settings'));
  assert.equal(saved.autoStamina, true);
  assert.equal(saved.autoHealth, true);
  assert.equal(saved.potionOrder.stamina[0], '251');
  assert.equal(saved.potionEnabled['30'], false);
  assert.equal(saved.potionEnabled['251'], true);

  assert.equal(controller.setTargetDamage('2.5b'), true);
  assert.equal(controller.getState().targetDamage, 2.5e9);
  assert.equal(controller.setTargetDamage('nonsense'), false);
  assert.equal(controller.getState().targetDamage, 2.5e9);
  assert.equal(synced, 3);

  const state = controller.getState();
  assert.equal(state.running, false);
  assert.equal(state.finished, false);
  assert.equal(state.reason, null);
  controller.stop();
  assert.equal(controller.getState().finished, false);
});

test('the controller keeps the bridge interface', () => {
  const { engine } = createBattlePage();
  const controller = createController(engine);
  for (const name of ['setTargetDamage', 'setAttacks', 'setPotions', 'start', 'stop', 'getState', 'onChange']) {
    assert.equal(typeof controller[name], 'function', name);
  }
  const unsubscribe = controller.onChange(() => {});
  assert.equal(typeof unsubscribe, 'function');
  bridge.registerController(controller);
  assert.equal(bridge.getController(), controller);
  bridge.unregisterController(controller);
  assert.equal(bridge.getController(), null);
});

test('the feature is registered for battle.php only', () => {
  const feature = FEATURES.find((candidate) => candidate.id === 'monster-auto-battle');
  assert.ok(feature);
  assert.equal(feature.group, 'Battle');
  assert.deepEqual(feature.settings, []);
  assert.equal(feature.matches(new URL('https://demonicscans.org/battle.php?id=5')), true);
  assert.equal(feature.matches(new URL('https://demonicscans.org/active_wave.php')), false);
});
