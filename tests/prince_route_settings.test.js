'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prince = require('../src/routes/prince');
const { ROUTES } = require('../src/routes');
const { createDefaultConfig, normalizeConfig } = require('../src/scheduler/config');
const { isUrlWithinVisit, routeIdForUrl } = require('../src/scheduler/runtime');

test('Castle route is registered without any stored instance or battle id', () => {
  assert.equal(ROUTES.prince, prince);
  assert.equal(routeIdForUrl('/guild_dungeon.php?veyra_route=prince'), 'prince');
  assert.equal(
    isUrlWithinVisit('prince', '/guild_dungeon_instance.php?id=99999&veyra_visit=v1', 'v1'),
    true,
  );
  assert.equal(prince.PRINCE_TARGETS.length, 5);
  assert.equal(prince.PRINCE_TARGETS.at(-1).isBoss, true);
  assert.doesNotMatch(JSON.stringify(prince.PRINCE_TARGETS), /instance|dgmid|16247/i);
});

test('Castle settings normalize five independent live damage targets', () => {
  const defaults = createDefaultConfig().routes.prince;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.settings.skill, '0');
  assert.equal(defaults.settings.attackCooldownMs, 100);
  assert.equal(Object.values(defaults.settings.targets).length, 5);
  assert.equal(
    Object.values(defaults.settings.targets).every((target) => target.enabled && target.mode === 'max-damage'),
    true,
  );

  const saved = normalizeConfig({
    version: 1,
    routes: {
      prince: {
        settings: {
          skill: '-4',
          attackCooldownMs: 9000,
          targets: {
            'vizier-hall': { enabled: false, mode: 'custom', damage: '2.5B' },
            'bloodbound-hall': { mode: 'not-a-mode' },
          },
        },
      },
    },
  }).routes.prince.settings;
  assert.deepEqual(saved.targets['vizier-hall'], { enabled: false, mode: 'custom', damage: '2.5b' });
  assert.equal(saved.targets['bloodbound-hall'].mode, 'max-damage');
  assert.equal(saved.skill, '-4');
  assert.equal(saved.attackCooldownMs, 2000);
});

test('Castle associates rooms by live labels and remembers discovered monster names', () => {
  const location = {
    label: "The Vizier's Conspiracy Hall — 0/1",
    instanceId: 'different-every-time',
  };
  assert.equal(prince.targetForLocation(location).id, 'vizier-hall');
  const settings = prince.createDefaultSettings();
  const merged = prince.mergeDiscoveredMonsters(settings, [
    {
      location,
      monsters: [{ name: 'A Newly Rolled Royal Vizier', dead: false, monsterId: 'changing-too' }],
    },
  ]);
  assert.equal(merged.changed, true);
  assert.equal(merged.settings.discoveredNames['vizier-hall'], 'A Newly Rolled Royal Vizier');
  assert.equal(prince.settingsForLocation(merged.settings, location).target.mode, 'max-damage');
});
