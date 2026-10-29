'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../src/features/pvp/pvp-helpers');
const pvpFeatures = require('../src/features/pvp');
const soloHud = require('../src/features/pvp/solo-battle-hud');
const recentBattles = require('../src/features/pvp/recent-battles');
const { KEYS } = require('../src/features/pvp/settings');
const { settingGroups } = require('../src/features/runner');

function node(textContent, children = {}) {
  return {
    textContent,
    querySelector: (selector) => children[selector] || null,
    querySelectorAll: (selector) => (children[selector] ? [].concat(children[selector]) : []),
  };
}

function pill(label, value) {
  return node(`${label} ${value}`, { '.lbl': node(label), '.val': node(value) });
}

function docWithPills(pills) {
  return { querySelectorAll: (selector) => (selector === '.pill' ? pills : []) };
}

test('ladder pill: missing pill is not solo and never throws', () => {
  assert.equal(helpers.readPillValue(docWithPills([]), 'Ladder'), null);
  assert.equal(helpers.isSoloLadder(docWithPills([pill('Player', 'Rothgar')])), false);
  assert.equal(helpers.isSoloLadder(docWithPills([pill('Ladder', ' Solo ')])), true);
  assert.equal(helpers.isSoloLadder(docWithPills([pill('Ladder', 'Party')])), false);
  assert.equal(helpers.isSoloLadder(null), false);
  assert.equal(helpers.readPillValue(docWithPills([pill('Player', 'Rothgar')]), 'player'), 'Rothgar');
});

test('turn detection ignores emoji and case', () => {
  assert.equal(helpers.isPlayersTurn('Rothgar', '🎯 rothgar'), true);
  assert.equal(helpers.isPlayersTurn('Rothgar', 'Enemy'), false);
  assert.equal(helpers.isPlayersTurn('', 'Rothgar'), false);
  assert.equal(helpers.isPlayersTurn('Rothgar', null), false);
});

test('findLastHit returns the newest attack on the requested side', () => {
  const map = {
    1: { kind: 'attack', actor: { key: 'a' }, target: { side: 'enemy', hp_before: 100, hp_after: 60 }, skill: { name: 'Slash' }, formula: { target_damage_dealt: 45 } },
    2: { kind: 'heal', target: { side: 'enemy' } },
    3: { kind: 'attack', actor: { key: 'e' }, target: { side: 'ally', hp_before: 50, hp_after: 20 } },
  };
  const enemy = helpers.findLastHit(map, 'enemy');
  assert.equal(enemy.skillName, 'Slash');
  assert.equal(enemy.damage, 45);
  assert.equal(enemy.hpDamage, 40);
  const ally = helpers.findLastHit(Object.values(map), 'ally');
  assert.equal(ally.skillName, 'Attack');
  assert.equal(ally.damage, 30, 'falls back to HP loss without formula');
  assert.notEqual(ally.key, enemy.key);
  assert.equal(helpers.findLastHit(null, 'enemy'), null);
  assert.equal(helpers.findLastHit({ 1: null, 2: { kind: 'attack' } }, 'enemy'), null);
});

test('extractEnemyRoles reads players_by_num null safely', () => {
  assert.deepEqual(helpers.extractEnemyRoles(null), {});
  assert.deepEqual(helpers.extractEnemyRoles({ teams: { enemy: { players_by_num: { 1: { key: 'enemy:1', role: 'Mage' }, 2: { key: 'enemy:2' }, 3: null } } } }), {
    'enemy:1': 'Mage',
  });
});

test('recent battle helpers parse match ids', () => {
  assert.equal(helpers.parseMatchId('#4782068'), '4782068');
  assert.equal(helpers.parseMatchId(''), null);
  assert.equal(helpers.isRecentSectionTitle('Recent Solo Battles'), true);
  assert.equal(helpers.isRecentSectionTitle('Solo Ladder'), false);
  assert.equal(helpers.battleUrlForMatch('42'), '/pvp_battle.php?match_id=42');

  const matchPill = node('Match: #4782068', { strong: node('Match:'), span: node('#4782068') });
  const pointsPill = node('Points: 2,610', { strong: node('Points:'), span: node('2,610') });
  assert.equal(recentBattles._test.matchIdOfCard(node('', { '.info-pill': [pointsPill, matchPill] })), '4782068');
  assert.equal(recentBattles._test.matchIdOfCard(node('', { '.info-pill': [pointsPill] })), null);
});

test('observeDebounced coalesces mutations into one callback', async () => {
  let trigger = null;
  const win = {
    MutationObserver: class {
      constructor(callback) {
        trigger = callback;
      }
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  let calls = 0;
  helpers.observeDebounced(win, {}, () => (calls += 1), { delayMs: 5 });
  trigger();
  trigger();
  trigger();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  trigger();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  // Without MutationObserver it is a no-op instead of a crash.
  assert.doesNotThrow(() => helpers.observeDebounced({}, {}, () => {}).disconnect());
});

test('solo HUD does nothing (and does not throw) without a Ladder pill', () => {
  let injected = 0;
  const ctx = {
    doc: { querySelectorAll: () => [], getElementById: () => null, body: {} },
    win: {},
    setting: () => true,
    injectPageScript: () => (injected += 1),
    pageGlobal: () => undefined,
  };
  assert.doesNotThrow(() => soloHud.run(ctx));
  assert.equal(injected, 0);
});

function runPopulate({ automation }) {
  const slot = { dataset: { key: 'enemy:7:1', alive: '1' }, classList: { contains: () => false } };
  const grid = { dataset: {}, textContent: 'x', children: [], appendChild(child) { this.children.push(child); } };
  const used = [];
  const globals = {
    document: {
      documentElement: { dataset: automation ? { veyraSmartPvpLifecycle: '1' } : {} },
      getElementById: (id) => (id === 'grid' ? grid : null),
      querySelector: (selector) => (selector.includes('data-alive="1"') ? slot : null),
    },
    mySkills: [
      { id: 1, target: 'enemy', cost: 1 },
      { id: 2, target: 'ally_alive', cost: 1 },
      { id: 3, target: 'self', cost: 2 },
    ],
    createSkillButton: (skill, handler) => ({ skill, click: handler }),
    useSkill: (id, target) => used.push([id, target, globals.selectedTargetKey]),
    selectedTargetKey: '',
    console,
  };
  // Run the page-context function with the page globals in scope.
  const source = `with (scope) { (${soloHud._test.populateSkillsInPage})('grid'); }`;
  // eslint-disable-next-line no-new-func
  new Function('scope', source)(new Proxy(globals, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : globalThis[k]), set: (t, k, v) => ((t[k] = v), true) }));
  return { grid, globals, used };
}

test('attack card skills: built once and never retarget while automation runs', () => {
  const manual = runPopulate({ automation: false });
  assert.equal(manual.grid.dataset.veyraPopulated, '1');
  assert.deepEqual(manual.grid.children.map((button) => button.skill.id), [1, 3]);
  manual.grid.children[0].click();
  assert.deepEqual(manual.used, [['1', 'enemy', 'enemy:7:1']]);

  const automated = runPopulate({ automation: true });
  automated.grid.children[0].click();
  assert.deepEqual(automated.used, [['1', 'enemy', '']]);
  assert.equal(automated.globals.selectedTargetKey, '');
});

test('PvP settings keep the veyra-hud keys, default true, in one group', () => {
  const groups = settingGroups(pvpFeatures);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'PvP');
  assert.deepEqual(
    groups[0].settings.map((setting) => setting.key),
    [
      'ui-improvements:useCustomSoloPvPStyles',
      'ui-improvements:showEnemyClass',
      'ui-improvements:showEnemyLastHit',
      'ui-improvements:showAllyLastHit',
      'ui-improvements:showAttackCard',
      'ui-improvements:moveRecentBattles',
      'ui-improvements:linkRecentBattles',
    ],
  );
  assert.ok(groups[0].settings.every((setting) => setting.type === 'checkbox' && setting.default === true));
  const masterOff = (key) => key !== KEYS.soloImprovements;
  const hidden = groups[0].settings.filter((setting) => setting.visibleIf && !setting.visibleIf(masterOff));
  assert.equal(hidden.length, 5);
});

test('PvP features match their pages only', () => {
  const at = (path) => new URL(`https://demonicscans.org${path}`);
  const ids = (path) => pvpFeatures.filter((feature) => feature.matches(at(path))).map((feature) => feature.id);
  assert.deepEqual(ids('/pvp_battle.php?match_id=1'), ['pvp-solo-battle-hud', 'pvp-enemy-class']);
  assert.deepEqual(ids('/pvp.php'), ['pvp-recent-battles']);
  assert.deepEqual(ids('/pvp_style_battle.php'), []);
});
