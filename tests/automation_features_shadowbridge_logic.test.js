'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../src/features/automation/shadowbridge-logic');

function element({ text = '', attrs = {}, classes = [], one = {}, many = {}, parent = null, childNodes = [] } = {}) {
  return {
    textContent: text,
    childNodes,
    parentElement: parent,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
    closest(selector) {
      return one[`closest:${selector}`] || parent || null;
    },
  };
}

function documentWith({ one = {}, many = {}, body = null } = {}) {
  return {
    body,
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
}

function statBlock(label, value, fullText = '') {
  return element({
    text: fullText || `${label} ${value}`,
    one: {
      '.label': element({ text: label }),
      strong: element({ text: value }),
    },
  });
}

test('keeps the canonical 18-monster order and normalizes the old Orc key', () => {
  assert.equal(logic.SHADOWBRIDGE_MONSTERS.length, 18);
  assert.equal(logic.SHADOWBRIDGE_MONSTERS[0].name, 'Talla Flint-Stem');
  assert.equal(logic.SHADOWBRIDGE_MONSTERS[17].name, 'Zorgra Frost-Vein');
  assert.equal(logic.monsterIdForName('  Orc Stone-Rend  '), 'orc-stone-rend');
  assert.equal(logic.monsterIdForName('unknown'), '');
});

test('finds only the dynamic Shadowbridge entry on the dungeon hub', () => {
  const selector = 'a[href*="guild_dungeon_enter.php"]';
  const panelLinks = [];
  const sharedPanel = element({
    text: 'Castle of the Fallen Prince Shadowbridge Warrens',
    many: { [selector]: panelLinks },
  });
  const wrongLinks = [];
  const rightLinks = [];
  const wrongCard = element({ text: 'Castle of the Fallen Prince Enter', parent: sharedPanel, many: { [selector]: wrongLinks } });
  const rightCard = element({ text: 'Shadowbridge Warrens Enter dungeon', parent: sharedPanel, many: { [selector]: rightLinks } });
  const wrong = element({
    attrs: { href: '/guild_dungeon_enter.php?id=12' },
    parent: wrongCard,
  });
  const right = element({
    attrs: { href: '/guild_dungeon_enter.php?id=16137' },
    parent: rightCard,
  });
  wrongLinks.push(wrong);
  rightLinks.push(right);
  panelLinks.push(wrong, right);
  const doc = documentWith({ many: { [selector]: [wrong, right] } });

  assert.deepEqual(logic.parseHubEntry(doc, 'https://demonicscans.org/guild_dungeon.php'), {
    instanceId: '16137',
    url: 'https://demonicscans.org/guild_dungeon_enter.php?id=16137',
  });
});

test('finds a named dungeon with its current instance id instead of a stored id', () => {
  const selector = 'a[href*="guild_dungeon_enter.php"]';
  const castleCard = element({ text: 'Castle of the Fallen Prince Instance #98765 Enter' });
  const link = element({
    attrs: { href: '/guild_dungeon_enter.php?id=98765' },
    parent: castleCard,
  });
  const doc = documentWith({ many: { [selector]: [link] } });

  assert.deepEqual(
    logic.parseNamedHubEntry(doc, 'Castle of the Fallen Prince', 'https://demonicscans.org/guild_dungeon.php'),
    {
      instanceId: '98765',
      url: 'https://demonicscans.org/guild_dungeon_enter.php?id=98765',
    },
  );
  assert.equal(logic.parseNamedHubEntry(doc, 'Shadowbridge Warrens'), null);
});

test('discovers unlocked locations dynamically and reports a locked boss room', () => {
  const location = (id, label) => element({
    text: label,
    attrs: {
      href: `/guild_dungeon_location.php?location_id=${id}&instance_id=16137`,
      title: label,
    },
  });
  const bossLocked = element({
    text: 'Boss Room Locked',
    attrs: { href: 'javascript:void(0)', title: 'Boss Room' },
    classes: ['pin', 'locked'],
  });
  const doc = documentWith({
    one: { title: element({ text: 'Shadowbridge Warrens — Instance #16137' }) },
    many: {
      'a[href*="guild_dungeon_location.php"]': [location(1, 'Brood Pits'), location(4, 'Territory Center')],
      'a.pin.locked': [bossLocked],
    },
  });

  const result = logic.parseInstancePage(doc, 'https://demonicscans.org/guild_dungeon_instance.php?id=16137');
  assert.equal(result.instanceId, '16137');
  assert.deepEqual(result.locations.map((entry) => entry.id), ['1', '4']);
  assert.equal(result.locations.every((entry) => entry.isBoss === false), true);
  assert.equal(result.bossLocked, true);
});

test('parses live location monsters without assigning fixed locations', () => {
  const liveHeading = element({
    text: 'not joined Prismblade Reaver',
    childNodes: [
      { nodeType: 1, textContent: 'not joined' },
      { nodeType: 3, textContent: '\n Prismblade Reaver ' },
    ],
  });
  const liveMarkupCard = element({
    one: {
      '[style*="font-weight:700"]': liveHeading,
      'a[href*="battle.php"]': element({
        attrs: { href: '/battle.php?instance_id=16126&dgmid=8001' },
      }),
    },
    many: { '.pill': [element({ text: 'not joined' })] },
  });
  const aliveCard = element({
    one: {
      '.monster-name, .name': element({ text: 'Talla Flint-Stem' }),
      'a[href*="battle.php"]': element({
        attrs: { href: '/battle.php?instance_id=16137&dgmid=7001' },
      }),
    },
    many: { '.pill': [element({ text: 'joined' })] },
  });
  const deadCard = element({
    classes: ['mon', 'dead'],
    one: {
      '.monster-name, .name': element({ text: 'Unexpected Boss' }),
      'a[href*="battle.php"]': element({
        attrs: { href: '/battle.php?dgmid=7002&instance_id=16137' },
      }),
    },
    many: { '.pill': [element({ text: 'defeated' })] },
  });
  const doc = documentWith({ many: { '.mon': [aliveCard, deadCard, liveMarkupCard] } });

  const monsters = logic.parseLocationPage(
    doc,
    'https://demonicscans.org/guild_dungeon_location.php?instance_id=16137&location_id=3',
  );
  assert.deepEqual(monsters[0], {
    monsterId: '7001',
    name: 'Talla Flint-Stem',
    monsterTypeId: 'talla-flint-stem',
    instanceId: '16137',
    locationId: '3',
    url: 'https://demonicscans.org/battle.php?instance_id=16137&dgmid=7001',
    dead: false,
    joined: true,
  });
  assert.equal(monsters[1].dead, true);
  assert.equal(monsters[1].monsterTypeId, '');
  assert.equal(monsters[2].name, 'Prismblade Reaver');
});

test('reads player damage, highest loot requirement and EXP cap from a battle page', () => {
  const expCap = statBlock('EXP Cap', '', 'EXP Cap Deal ~6,400,000 dmg to hit cap');
  const monsterHp = statBlock('Monster HP', '10,000,000');
  const lootA = element({ text: 'DMG req: 500,000' });
  const lootB = element({ text: 'DMG req: 2,000,000' });
  const playerRow = element({
    one: {
      '.lb-name a': element({ text: 'Player', attrs: { href: '/player.php?pid=159129' } }),
      '.lb-dmg': element({ text: '1,250,000 DMG' }),
    },
  });
  const doc = documentWith({
    one: {
      '#hpText': element({ text: '8,000,000 / 10,000,000' }),
      '#pHpText': element({ text: '3,775 / 12,000' }),
      '.battle-actions-card': element({ text: 'Battle actions' }),
    },
    many: {
      '.stat-block': [expCap, monsterHp],
      '.loot-card .chip, .loot-stats .chip': [lootA, lootB],
      '.lb-list .lb-row': [playerRow],
    },
  });

  const snapshot = logic.parseBattleSnapshot(doc, {
    userId: 159129,
    url: 'https://demonicscans.org/battle.php?dgmid=7001&instance_id=16137',
  });
  assert.equal(snapshot.joined, true);
  assert.equal(snapshot.ownDamageKnown, true);
  assert.equal(snapshot.ownDamage, 1_250_000);
  assert.equal(snapshot.lootRequirement, 2_000_000);
  assert.equal(snapshot.expCapDamage, 6_400_000);
  assert.equal(snapshot.currentHp, 8_000_000);
  assert.equal(snapshot.maxHp, 10_000_000);
  assert.equal(snapshot.playerHp, 3_775);
});

test('derives a boss EXP cap from its fraction and fails closed without own damage', () => {
  const expCap = statBlock('EXP Cap', '', 'EXP Cap 12.5% of monster HP');
  const monsterHp = statBlock('Monster HP', '8,000,000');
  const doc = documentWith({
    one: {
      '#hpText': element({ text: '8,000,000 / 8,000,000' }),
      '.battle-actions-card': element({ text: 'You joined battle' }),
    },
    many: {
      '.stat-block': [expCap, monsterHp],
      '.loot-card .chip, .loot-stats .chip': [],
      '.lb-list .lb-row': [],
    },
  });
  const snapshot = logic.parseBattleSnapshot(doc, { userId: 159129 });
  assert.equal(snapshot.expCapDamage, 1_000_000);
  assert.equal(snapshot.joined, true);
  assert.equal(snapshot.ownDamageKnown, false);
  assert.deepEqual(logic.resolveDamageTarget({ mode: 'max-exp', isBoss: true, snapshot }), {
    ok: false,
    error: 'Your current damage is missing from the battle leaderboard.',
  });
});

test('resolves normal and boss damage modes without treating max HP as a kill target', () => {
  const snapshot = {
    dead: false,
    ownDamageKnown: true,
    ownDamage: 1_250_000,
    lootRequirement: 2_000_000,
    expCapDamage: 4_000_000,
    maxHp: 10_000_000,
  };
  assert.deepEqual(logic.resolveDamageTarget({ mode: 'max-damage', snapshot }), {
    ok: true,
    done: false,
    untilDead: false,
    targetDamage: 10_000_000,
    remaining: 8_750_000,
  });
  assert.deepEqual(logic.resolveDamageTarget({ mode: 'max-loot', snapshot }), {
    ok: true,
    done: false,
    untilDead: false,
    targetDamage: 2_000_000,
    remaining: 750_000,
  });
  assert.deepEqual(logic.resolveDamageTarget({ mode: 'kill', snapshot }), {
    ok: true,
    done: false,
    untilDead: true,
    targetDamage: null,
    remaining: null,
  });
  assert.equal(logic.resolveDamageTarget({ mode: 'max-exp', isBoss: false, snapshot }).ok, false);
  assert.equal(
    logic.resolveDamageTarget({ mode: 'max-exp', allowMaxExp: true, snapshot }).targetDamage,
    4_000_000,
  );
  assert.equal(
    logic.resolveDamageTarget({ mode: 'custom', damage: '1m', snapshot: { ...snapshot, ownDamage: 1_000_000 } }).done,
    true,
  );
});

test('builds exact API payloads and always uses base stamina costs', () => {
  assert.deepEqual(
    logic.buildJoinPayload({ instanceId: 16137, monsterId: 7001, userId: 159129 }),
    { instance_id: '16137', dgmid: '7001', user_id: '159129' },
  );
  assert.deepEqual(
    logic.buildDamagePayload({ instanceId: 16137, monsterId: 7001, skillId: '-4', asterionMultiplier: 9 }),
    { instance_id: '16137', dgmid: '7001', skill_id: '-4', stamina_cost: 200 },
  );
  assert.equal(logic.buildDamagePayload({ instanceId: 16137, monsterId: 7001, skillId: '-99' }), null);
});

test('selects the alternative Max Loot skill only at the remaining-HP threshold', () => {
  const base = {
    mode: 'max-loot',
    primarySkillId: '0',
    alternativeSkillId: '-4',
    targetDamage: 2_000_000,
    ownDamage: 1_250_000,
  };

  const threshold = logic.selectAttackSkill({ ...base, currentHp: 750_000 });
  assert.equal(threshold.skill.id, '-4');
  assert.equal(threshold.usedAlternative, true);
  assert.equal(threshold.remainingDamage, 750_000);

  const aboveThreshold = logic.selectAttackSkill({ ...base, currentHp: 750_001 });
  assert.equal(aboveThreshold.skill.id, '0');
  assert.equal(aboveThreshold.usedAlternative, false);

  assert.equal(logic.selectAttackSkill({ ...base, mode: 'kill', currentHp: 1 }).skill.id, '0');
  assert.equal(logic.selectAttackSkill({ ...base, alternativeSkillId: '', currentHp: 1 }).skill.id, '0');
  assert.equal(logic.selectAttackSkill({ ...base, currentHp: null }).skill.id, '0');
});

test('requires semantic success from join and damage responses', () => {
  assert.equal(
    logic.parseJoinResponse({ ok: true, json: null, text: 'You have successfully joined the battle!' }).ok,
    true,
  );
  assert.equal(logic.parseJoinResponse({ ok: true, json: null, text: '<html>Login</html>' }).ok, false);
  assert.deepEqual(
    logic.parseAttackResponse({
      ok: true,
      json: { status: 'success', message: 'You dealt <strong>12,345</strong> damage.', hp: { value: 0, max: 99_999 } },
      text: '',
    }),
    {
      ok: true,
      damage: 12_345,
      dead: true,
      currentHp: 0,
      maxHp: 99_999,
      playerHp: null,
      message: 'You dealt <strong>12,345</strong> damage.',
    },
  );
  assert.equal(logic.parseAttackResponse({ ok: true, text: '<html>Login</html>', json: null }).ok, false);
});
