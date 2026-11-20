'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../src/routes/shadowcollection');
const worker = require('../src/features/automation/shadowcollection-worker');

test('Shadow Collection is daily, disabled by default and recognizes only its marked Gate 3 URL', () => {
  assert.equal(route.defaultLoopMinutes, 1440);
  assert.equal(route.defaultEnabled, false);
  assert.equal(route.matchesUrl(new URL('https://demonicscans.org/active_wave.php?gate=3&wave=8&veyra_route=shadowcollection')), true);
  assert.equal(route.matchesUrl(new URL('https://demonicscans.org/active_wave.php?gate=3&wave=8')), false);
  assert.equal(route.TARGETS.length, 8);
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
