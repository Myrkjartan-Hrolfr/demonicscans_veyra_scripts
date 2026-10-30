'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const shadowbridge = require('../src/routes/shadowbridge');
const { ROUTES } = require('../src/routes');
const { createDefaultConfig, normalizeConfig } = require('../src/scheduler/config');
const { isUrlWithinVisit, routeIdForUrl } = require('../src/scheduler/runtime');

function makeElement(tagName, options = {}) {
  const listeners = new Map();
  const element = {
    tagName,
    id: options.id || '',
    className: options.className || '',
    textContent: options.text ?? '',
    type: options.type || '',
    title: options.title || '',
    children: [],
    attributes: {},
    style: {},
    hidden: false,
    appendChild(child) {
      if (!child) return child;
      const oldIndex = this.children.indexOf(child);
      if (oldIndex >= 0) this.children.splice(oldIndex, 1);
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
  return element;
}

function walk(root) {
  return [root, ...root.children.flatMap(walk)];
}

function renderHarness(initialSettings = shadowbridge.createDefaultSettings()) {
  const container = makeElement('div');
  let settings = shadowbridge.normalizeSettings(initialSettings);
  let updates = 0;
  const ctx = {
    container,
    idPrefix: 'veyra-automation-shadowbridge',
    settings,
    cls: (name) => `veyra-automation__${name}`,
    make: makeElement,
    addSectionTitle(text) {
      container.appendChild(makeElement('div', { text }));
    },
    addTextInput({ id, label, value, type, inputMode, onChange }) {
      const row = makeElement('div');
      row.appendChild(makeElement('label', { text: label }));
      const input = makeElement('input', { id: `${this.idPrefix}-${id}`, type });
      input.value = String(value);
      input.inputMode = inputMode;
      input.addEventListener('change', () => {
        const shown = onChange(input.value);
        if (shown !== undefined) input.value = String(shown);
      });
      row.appendChild(input);
      container.appendChild(row);
      return input;
    },
    updateSettings(mutator) {
      const next = structuredClone(settings);
      mutator(next);
      settings = shadowbridge.normalizeSettings(next);
      ctx.settings = settings;
      updates += 1;
      return settings;
    },
  };
  shadowbridge.renderSettings(ctx);
  const byId = (id) => walk(container).find((element) => element.id === id);
  return { byId, container, getSettings: () => settings, updateCount: () => updates };
}

test('Shadowbridge route is registered with a distinct listing entry and immutable canonical targets', () => {
  assert.equal(ROUTES.shadowbridge, shadowbridge);
  assert.equal(shadowbridge.id, 'shadowbridge');
  assert.equal(shadowbridge.path, '/guild_dungeon.php?veyra_route=shadowbridge');
  assert.equal(routeIdForUrl('/guild_dungeon.php?veyra_route=shadowbridge'), 'shadowbridge');
  assert.equal(routeIdForUrl('/guild_dungeon.php'), null);
  assert.equal(routeIdForUrl('/guild_dungeon_instance.php?id=16137'), null);
  assert.equal(
    isUrlWithinVisit(
      'shadowbridge',
      '/guild_dungeon_instance.php?id=16137&veyra_visit=visit-1',
      'visit-1',
    ),
    true,
  );
  assert.equal(isUrlWithinVisit('shadowbridge', '/guild_dungeon_instance.php?id=16137', 'visit-1'), false);
  assert.equal(shadowbridge.matchesUrl(new URL('https://demonicscans.org/guild_dungeon_location.php')), false);
  assert.deepEqual(shadowbridge.visitPathnames, [
    '/guild_dungeon_instance.php',
    '/guild_dungeon_location.php',
    '/battle.php',
  ]);

  assert.equal(shadowbridge.SHADOWBRIDGE_MONSTERS.length, 18);
  assert.equal(shadowbridge.SHADOWBRIDGE_MONSTERS[0].name, 'Talla Flint-Stem');
  assert.equal(shadowbridge.SHADOWBRIDGE_MONSTERS[17].name, 'Zorgra Frost-Vein');
  assert.equal(new Set(shadowbridge.SHADOWBRIDGE_MONSTERS.map((monster) => monster.id)).size, 18);
  assert.equal(Object.isFrozen(shadowbridge.SHADOWBRIDGE_MONSTERS), true);
  assert.equal(shadowbridge.SHADOWBRIDGE_MONSTERS.every(Object.isFrozen), true);
});

test('Shadowbridge settings normalize order, targets, skill, damage and cooldown', () => {
  const routeDefaults = createDefaultConfig().routes.shadowbridge;
  const defaults = routeDefaults.settings;
  assert.equal(routeDefaults.enabled, false);
  const canonicalOrder = shadowbridge.SHADOWBRIDGE_MONSTERS.map((monster) => monster.id);
  assert.deepEqual(defaults.order, canonicalOrder);
  assert.equal(defaults.skill, '0');
  assert.equal(defaults.attackCooldownMs, 100);
  assert.equal(Object.values(defaults.monsters).every((target) => target.enabled && target.mode === 'max-loot'), true);
  assert.deepEqual(defaults.bossRoom, { enabled: true, mode: 'max-loot', damage: '1m' });

  const saved = normalizeConfig({
    version: 1,
    routes: {
      shadowbridge: {
        settings: {
          order: ['zorgra-frost-vein', 'zorgra-frost-vein', 'unknown', 'talla-flint-stem'],
          monsters: {
            'zorgra-frost-vein': { enabled: false, mode: 'custom', damage: '2.5B' },
            'talla-flint-stem': { mode: 'max-exp', damage: 'invalid' },
          },
          bossRoom: { enabled: false, mode: 'max-exp', damage: '750m' },
          skill: '-3',
          attackCooldownMs: 9_999,
        },
      },
    },
  }).routes.shadowbridge.settings;

  assert.deepEqual(saved.order.slice(0, 2), ['zorgra-frost-vein', 'talla-flint-stem']);
  assert.equal(saved.order.length, 18);
  assert.deepEqual(saved.monsters['zorgra-frost-vein'], {
    enabled: false,
    mode: 'custom',
    damage: '2.5b',
  });
  assert.deepEqual(saved.monsters['talla-flint-stem'], {
    enabled: true,
    mode: 'max-loot',
    damage: '1m',
  });
  assert.deepEqual(saved.bossRoom, { enabled: false, mode: 'max-exp', damage: '750m' });
  assert.equal(saved.skill, '-3');
  assert.equal(saved.attackCooldownMs, 2_000);

  const invalid = shadowbridge.normalizeSettings({ skill: 'unknown', attackCooldownMs: 5 });
  assert.equal(invalid.skill, '0');
  assert.equal(invalid.attackCooldownMs, 100);
});

test('Clean Dungeon enables every target in kill mode without discarding other settings', () => {
  const custom = shadowbridge.normalizeSettings({
    order: ['zorgra-frost-vein'],
    skill: '-2',
    attackCooldownMs: 450,
    monsters: { 'talla-flint-stem': { enabled: false, mode: 'custom', damage: '9m' } },
    bossRoom: { enabled: false, mode: 'max-exp', damage: '20m' },
  });
  const cleaned = shadowbridge.cleanDungeonSettings(custom);
  assert.equal(Object.values(cleaned.monsters).every((target) => target.enabled && target.mode === 'kill'), true);
  assert.equal(cleaned.bossRoom.enabled, true);
  assert.equal(cleaned.bossRoom.mode, 'kill');
  assert.equal(cleaned.monsters['talla-flint-stem'].damage, '9m');
  assert.equal(cleaned.bossRoom.damage, '20m');
  assert.equal(cleaned.skill, '-2');
  assert.equal(cleaned.attackCooldownMs, 450);
  assert.deepEqual(cleaned.order, custom.order);
});

test('Shadowbridge menu exposes English touch controls, live modes, ordering and Clean Dungeon', () => {
  const harness = renderHarness();
  const prefix = 'veyra-automation-shadowbridge';
  const cleanButton = harness.byId(`${prefix}-clean-dungeon`);
  const skill = harness.byId(`${prefix}-skill`);
  const cooldown = harness.byId(`${prefix}-attack-cooldown-ms`);
  const firstUp = harness.byId(`${prefix}-target-talla-flint-stem-up`);
  const firstDown = harness.byId(`${prefix}-target-talla-flint-stem-down`);
  const normalMode = harness.byId(`${prefix}-target-talla-flint-stem-mode`);
  const bossMode = harness.byId(`${prefix}-target-boss-room-mode`);

  assert.equal(cleanButton.textContent, 'Clean Dungeon');
  assert.equal(cleanButton.style.minHeight, '44px');
  assert.equal(firstUp.style.minWidth, '44px');
  assert.equal(firstDown.style.minHeight, '44px');
  assert.equal(firstUp.disabled, true);
  assert.equal(skill.children[0].textContent, 'Slash (1 stamina)');
  assert.equal(cooldown.min, '100');
  assert.equal(cooldown.max, '2000');
  assert.deepEqual(normalMode.children.map((option) => option.value), ['max-loot', 'kill', 'custom']);
  assert.deepEqual(bossMode.children.map((option) => option.value), ['max-loot', 'max-exp', 'kill', 'custom']);
  assert.match(
    harness.container.children.map((element) => element.textContent).join(' '),
    /Combat.*Targets.*Boss room/,
  );

  firstDown.dispatch('click');
  assert.deepEqual(harness.getSettings().order.slice(0, 2), ['gribble-junk-magus', 'talla-flint-stem']);

  normalMode.value = 'custom';
  normalMode.dispatch('change');
  assert.equal(harness.getSettings().monsters['talla-flint-stem'].mode, 'custom');
  assert.equal(harness.byId(`${prefix}-target-talla-flint-stem-damage`).value, '1m');

  cooldown.value = '2500';
  cooldown.dispatch('change');
  assert.equal(cooldown.value, '2000');
  assert.equal(harness.getSettings().attackCooldownMs, 2_000);

  cleanButton.dispatch('click');
  assert.equal(
    Object.values(harness.getSettings().monsters).every((target) => target.enabled && target.mode === 'kill'),
    true,
  );
  assert.equal(harness.getSettings().bossRoom.mode, 'kill');
  assert.ok(harness.updateCount() >= 4);
});

test('desktop drag events persist the same canonical order used by touch buttons', () => {
  const harness = renderHarness();
  const prefix = 'veyra-automation-shadowbridge';
  const source = harness.byId(`${prefix}-target-zorgra-frost-vein`);
  const target = harness.byId(`${prefix}-target-talla-flint-stem`);
  const transfer = {
    value: '',
    setData(_type, value) {
      this.value = value;
    },
    getData() {
      return this.value;
    },
  };
  source.dispatch('dragstart', { dataTransfer: transfer });
  target.dispatch('drop', { dataTransfer: transfer, preventDefault() {} });
  assert.equal(harness.getSettings().order[0], 'zorgra-frost-vein');
});
