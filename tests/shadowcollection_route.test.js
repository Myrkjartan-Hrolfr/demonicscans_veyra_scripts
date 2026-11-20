'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../src/routes/shadowcollection');
const worker = require('../src/features/automation/shadowcollection-worker');

test('Shadow Collection is daily, disabled by default and recognizes only its marked Gate 3 URL', () => {
  assert.equal(route.defaultLoopMinutes, 1440);
  assert.equal(route.defaultEnabled, false);
  assert.equal(route.matchesUrl(new URL('https://demonicscans.org/game_dash.php?veyra_route=shadowcollection')), true);
  assert.equal(route.matchesUrl(new URL('https://demonicscans.org/active_wave.php?gate=3&wave=8')), false);
  assert.equal(route.TARGETS.length, 10);
});

test('Shadow Collection clamps the configured daily total to five', () => {
  const settings = route.normalizeSettings({ rows: [
    { targetId: 'guardian', quantity: 3 },
    { targetId: 'drakzareth', quantity: 4 },
    { targetId: 'unknown', quantity: 5 },
  ] });
  assert.deepEqual(settings.rows.slice(0, 3), [
    { targetId: 'guardian', quantity: 3 },
    { targetId: 'drakzareth', quantity: 2 },
    { targetId: '', quantity: 0 },
  ]);
  assert.equal(settings.rows.reduce((sum, row) => sum + row.quantity, 0), 5);
});

test('configured targets resolve stable names and quantities', () => {
  assert.deepEqual(worker.configuredTargets(route.normalizeSettings({ rows: [
    { targetId: 'warmage', quantity: 2 },
    { targetId: 'skarn', quantity: 1 },
  ] })), [
    { id: 'warmage', name: 'Lizardman Warmage', quantity: 2 },
    { id: 'skarn', name: 'General Skarn the Radiant Bastion', quantity: 1 },
  ]);
});

test('changing one quantity preserves every previously selected monster', () => {
  let settings = route.normalizeSettings(null);
  settings.rows[0].targetId = 'guardian';
  settings = route.normalizeSettings(settings);
  settings.rows[1].targetId = 'drakzareth';
  settings = route.normalizeSettings(settings);
  settings.rows[0].quantity = '2';
  settings = route.normalizeSettings(settings);
  assert.deepEqual(settings.rows.slice(0, 2), [
    { targetId: 'guardian', quantity: 2 },
    { targetId: 'drakzareth', quantity: 0 },
  ]);
  settings.rows[1].quantity = '3';
  settings = route.normalizeSettings(settings);
  assert.deepEqual(settings.rows.slice(0, 2), [
    { targetId: 'guardian', quantity: 2 },
    { targetId: 'drakzareth', quantity: 3 },
  ]);
});

test('raw Gate 3 HTML fallback reads live monster-card data attributes', () => {
  assert.deepEqual(worker.parseRawWaveMonsters(`
    <div class="monster-card rare" data-monster-id="5571" data-dead="0" data-name="lizardman guardian"><h3>Lizardman Guardian</h3></div>
    <div class="monster-card" data-monster-id="5572" data-dead="1" data-name="lizardman guardian"></div>
    <div class="monster-card" data-monster-id="5573" data-dead="0" data-name="lizardman warmage"></div>
  `), [
    { id: '5571', name: 'lizardman guardian', href: '/battle.php?id=5571', expiresAtMs: 0 },
    { id: '5573', name: 'lizardman warmage', href: '/battle.php?id=5573', expiresAtMs: 0 },
  ]);
});

test('wave and battle auto-die timestamps are parsed as absolute milliseconds', () => {
  assert.deepEqual(worker.parseRawWaveMonsters(`
    <div class="monster-card" data-monster-id="5571" data-dead="0" data-expire="1795195976" data-name="lizardman guardian"></div>
  `), [{
    id: '5571',
    name: 'lizardman guardian',
    href: '/battle.php?id=5571',
    expiresAtMs: 1795195976000,
  }]);
  assert.equal(worker.battleAutoDieAt("startNoDamageCountdown('nodmgCountdown', 1795195976000);"), 1795195976000);
  assert.equal(worker.battleAutoDieAt('window.AUTO_DIE_CFG = { nextDieMs: 1795196974000 };'), 1795196974000);
});

test('raw monster id diagnostics return compact source samples', () => {
  assert.deepEqual(worker.rawMonsterIdSamples(`
    <script>document.querySelector('.monster-card[data-monster-id="123"]')</script>
    <button data-monster-id="456">Attack</button>
  `), [
    '<script>document.querySelector(\'.monster-card[data-monster-id="123"]\')</script>',
    '<button data-monster-id="456">Attack</button>',
  ]);
});

test('raw card diagnostics distinguish live and dead monster cards', () => {
  assert.deepEqual(worker.rawMonsterCardStats(`
    <div class="monster-card" data-monster-id="11" data-dead="0" data-name="live"></div>
    <div
      class="monster-card rare"
      data-monster-id="12"
      data-dead="1"
      data-name="dead"></div>
  `), { total: 2, alive: 1, dead: 1 });
});

test('monster view cookie reader returns the selected server view', () => {
  assert.equal(worker.cookieValue({ cookie: 'foo=x; hide_dead_monsters=0; show_dead_bosses_only=1' }, 'hide_dead_monsters'), '0');
  assert.equal(worker.cookieValue({ cookie: 'foo=x' }, 'hide_dead_monsters'), null);
});
