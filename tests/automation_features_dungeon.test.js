'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../src/features/dungeon/participation-helpers');
const dungeonFeatures = require('../src/features/dungeon');

// Tiny element fake: textContent, attributes, class list and a selector map.
function el({ text = '', attrs = {}, classes = [], children = {} } = {}) {
  return {
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    classList: { contains: (name) => classes.includes(name) },
    querySelector: (selector) => [].concat(children[selector] || [])[0] || null,
    querySelectorAll: (selector) => [].concat(children[selector] || []),
  };
}

test('number parsers read battle page texts', () => {
  assert.equal(helpers.parseExpCapDamage('80.00% Deal ~6,400,000,000 dmg to hit cap.'), 6_400_000_000);
  assert.equal(helpers.parseExpCapDamage('Deal ~1.5b dmg to hit cap'), 1_500_000_000);
  assert.equal(helpers.parseExpCapDamage('EXP Cap 80%'), null);
  assert.equal(helpers.parseLootRequirement('DMG req: 500,000,000'), 500_000_000);
  assert.equal(helpers.parseLootRequirement('Drop: 100%'), null);
});

test('locations come from unlocked map pins of this instance', () => {
  const pin = (href, classes = []) => el({ attrs: { href }, classes });
  const doc = el({
    children: {
      'a[href*="guild_dungeon_location.php"]': [
        pin('guild_dungeon_location.php?instance_id=16137&location_id=1'),
        pin('guild_dungeon_location.php?instance_id=16137&location_id=3'),
        pin('guild_dungeon_location.php?instance_id=16137&location_id=3'),
        pin('guild_dungeon_location.php?instance_id=999&location_id=7'),
        pin('javascript:void(0)', ['locked']),
        pin('guild_dungeon_location.php?instance_id=16137&location_id=10'),
      ],
    },
  });
  assert.deepEqual(helpers.parseLocationIds(doc, '16137'), ['1', '3', '10']);
  assert.deepEqual(helpers.parseLocationIds(null, '1'), []);
});

test('location monsters resolve battle urls and EXP/dmg', () => {
  const statpill = el({ children: { '.k': el({ text: 'EXP/dmg' }), '.v': el({ text: '0.0115' }) } });
  const card = el({
    children: {
      'a[href*="battle.php"]': el({ attrs: { href: 'battle.php?dgmid=2520921&instance_id=16126' } }),
      '.statpill': [statpill],
    },
  });
  const broken = el({ children: {} });
  const doc = el({ children: { '.mon': [card, broken] } });
  assert.deepEqual(
    helpers.parseLocationMonsters(doc, 'https://demonicscans.org/guild_dungeon_location.php?instance_id=16126&location_id=1'),
    [{ monsterId: '2520921', url: 'https://demonicscans.org/battle.php?dgmid=2520921&instance_id=16126', expPerDamage: 0.0115 }],
  );
});

test('battle info reads EXP cap, EXP/DMG, highest loot req and leaderboard', () => {
  const block = (label, strong, extra = '') =>
    el({ text: `${label} ${strong} ${extra}`, children: { '.label': el({ text: label }), strong: el({ text: strong }) } });
  const row = (pid, name, dmg) =>
    el({
      children: {
        '.lb-name a': el({ text: name, attrs: { href: `player.php?pid=${pid}` } }),
        '.lb-avatar': el({ attrs: { src: `uploads/avatars/user_${pid}.webp` } }),
        '.lb-dmg': el({ text: `${dmg} DMG` }),
      },
    });
  const doc = el({
    children: {
      '.stat-block': [
        block('Level Req', 'LV 2,500'),
        block('EXP Cap', '80.00%', 'Deal ~6,400,000,000 dmg to hit cap.'),
        block('EXP / DMG', '0.013000'),
        block('Monster HP', '8,000,000,000'),
      ],
      '.loot-card .chip, .loot-stats .chip': [
        el({ text: 'Drop: 100%' }),
        el({ text: 'DMG req: 500,000,000' }),
        el({ text: 'DMG req: 5,000,000,000' }),
        el({ text: 'DMG req: 1,000,000,000' }),
      ],
      '.lb-list .lb-row': [row(100038, '[FATE] Fyujin', '6,461,307,814'), row(78645, 'IJIN', '6,400,282,892'), el()],
    },
  });
  const info = helpers.parseBattleInfo(doc);
  assert.equal(info.expCapDamage, 6_400_000_000);
  assert.equal(info.expPerDamage, 0.013);
  assert.equal(info.maxHp, 8_000_000_000);
  assert.equal(info.lootRequirement, 5_000_000_000);
  assert.deepEqual(info.leaderboard[0], {
    pid: '100038',
    name: '[FATE] Fyujin',
    avatar: 'uploads/avatars/user_100038.webp',
    damage: 6_461_307_814,
  });
  assert.equal(info.leaderboard.length, 2);

  const empty = helpers.parseBattleInfo(el());
  assert.deepEqual(empty, { expCapDamage: null, expPerDamage: null, maxHp: null, lootRequirement: null, leaderboard: [] });
});

test('aggregation sums damage, EXP and damage over caps per player', () => {
  const { players, available } = helpers.aggregateParticipation([
    {
      monsterId: '1',
      monsterName: 'Boss',
      url: '/battle.php?dgmid=1',
      expCapDamage: 1000,
      expPerDamage: 0.5,
      lootRequirement: 1500,
      leaderboard: [
        { pid: '1', name: 'A', damage: 2000 },
        { pid: '2', name: 'B', damage: 500 },
      ],
    },
    {
      monsterId: '2',
      monsterName: 'Grunt',
      url: '/battle.php?dgmid=2',
      expCapDamage: null,
      expPerDamage: null,
      lootRequirement: null,
      leaderboard: [{ pid: '1', name: 'A', damage: 300 }, null],
    },
    null,
  ]);
  assert.deepEqual(available, { exp: true, expCap: true, loot: true });
  const [a, b] = players;
  assert.equal(a.pid, '1');
  assert.equal(a.totalDamage, 2300);
  assert.equal(a.monstersDamaged, 2);
  assert.equal(a.totalExp, 500);
  assert.equal(a.damageOverExpCap, 1000);
  assert.equal(a.damageOverLootReq, 500);
  assert.equal(a.wastedDamage, 500, 'damage over both the EXP cap and the loot req');
  assert.deepEqual(a.overLootMonsters.map((monster) => monster.monsterName), ['Boss']);
  assert.equal(b.totalExp, 250);
  assert.equal(b.wastedDamage, 0);

  const none = helpers.aggregateParticipation([{ leaderboard: [{ pid: '9', name: 'Z', damage: 10 }] }]);
  assert.deepEqual(none.available, { exp: false, expCap: false, loot: false });
  assert.deepEqual(
    helpers.visibleColumns(none.available).map((column) => column.key),
    ['name', 'monstersDamaged', 'totalDamage'],
  );
});

test('sorting by number, string and computed columns is stable by name', () => {
  const players = [
    { name: 'bob', totalDamage: 5, overLootMonsters: [1] },
    { name: 'Alice', totalDamage: 5, overLootMonsters: [] },
    { name: 'carl', totalDamage: 9, overLootMonsters: [1, 2] },
  ];
  assert.deepEqual(helpers.sortPlayers(players, 'totalDamage', 'desc').map((p) => p.name), ['carl', 'Alice', 'bob']);
  assert.deepEqual(helpers.sortPlayers(players, 'name', 'asc').map((p) => p.name), ['Alice', 'bob', 'carl']);
  assert.deepEqual(helpers.sortPlayers(players, 'overLootCount', 'asc').map((p) => p.name), ['Alice', 'bob', 'carl']);
  assert.deepEqual(helpers.sortPlayers(null), []);
});

test('CSV contains only computable columns and escapes values', () => {
  const report = {
    available: { exp: true, expCap: false, loot: false },
    players: [
      { pid: '1', name: 'Smith, "J"', monstersDamaged: 2, totalDamage: 10, totalExp: 5, overLootMonsters: [] },
      { pid: '2', name: '=HYPERLINK("x")', monstersDamaged: 1, totalDamage: 3, totalExp: 1, overLootMonsters: [] },
    ],
  };
  const lines = helpers.buildCsv(report).split('\r\n');
  assert.equal(lines[0], 'pid,name,monstersDamaged,totalDamage,totalExp');
  assert.equal(lines[1], '1,"Smith, ""J""",2,10,5');
  assert.equal(lines[2], `2,"'=HYPERLINK(""x"")",1,3,1`);
  assert.equal(helpers.escapeCsv(null), '');
  assert.equal(helpers.escapeCsv(-5), '-5');
});

test('stored reports: legacy veyra-hud arrays and pruning', () => {
  const legacy = helpers.normalizeReport([{ pid: 1, name: 'A', totalDamage: 10, totalExp: 1.6, damageOverExpCap: 4 }]);
  assert.equal(legacy.version, 1);
  assert.equal(legacy.players[0].totalExp, 2);
  assert.equal(legacy.players[0].wastedDamage, 4);
  assert.equal(helpers.normalizeReport(null), null);
  assert.equal(helpers.normalizeReport({ players: 'x' }), null);

  let reports = {};
  for (let id = 1; id <= 4; id += 1) {
    reports = helpers.upsertReport(reports, id, { generatedAt: id, players: [] }, 3);
  }
  assert.deepEqual(Object.keys(reports).sort(), ['2', '3', '4']);
  reports = helpers.upsertReport(reports, '2', { generatedAt: 10, players: [] }, 3);
  assert.deepEqual(Object.keys(reports).sort(), ['2', '3', '4']);
});

test('mapWithConcurrency limits parallel work and keeps order', async () => {
  let running = 0;
  let peak = 0;
  const progress = [];
  const results = await helpers.mapWithConcurrency(
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    4,
    async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (value === 5) throw new Error('fail');
      return value * 2;
    },
    (done, total) => progress.push(`${done}/${total}`),
  );
  assert.equal(peak, 4);
  assert.equal(results[4].status, 'rejected');
  assert.equal(results[8].value, 18);
  assert.equal(progress.at(-1), '9/9');
  assert.deepEqual(await helpers.mapWithConcurrency([], 4, async () => 1), []);
});

test('participation report feature registration', () => {
  assert.equal(dungeonFeatures.length, 1);
  const [feature] = dungeonFeatures;
  assert.equal(feature.group, 'Dungeon');
  assert.equal(feature.enabledBy, 'veyra:dungeon:participationReport');
  assert.deepEqual(
    feature.settings.map((setting) => [setting.key, setting.type, setting.default]),
    [['veyra:dungeon:participationReport', 'checkbox', true]],
  );
  assert.equal(feature.matches(new URL('https://demonicscans.org/guild_dungeon_instance.php?id=1')), true);
  assert.equal(feature.matches(new URL('https://demonicscans.org/guild_dungeon_location.php?instance_id=1')), false);
  assert.equal(helpers.REPORTS_KEY, 'dungeon-participation-check:reports');
});
