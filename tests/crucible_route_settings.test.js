'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const crucible = require('../src/routes/crucible');
const { ROUTES } = require('../src/routes');
const { createDefaultConfig, normalizeConfig } = require('../src/scheduler/config');
const { isUrlWithinVisit, routeIdForUrl } = require('../src/scheduler/runtime');

function makeElement(tagName, options = {}) {
  const listeners = new Map();
  return {
    tagName,
    id: options.id || '',
    className: options.className || '',
    textContent: options.text ?? '',
    type: options.type || '',
    children: [],
    style: {},
    hidden: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    setAttribute() {},
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function walk(root) {
  return [root, ...root.children.flatMap(walk)];
}

function renderHarness(initialSettings = crucible.createDefaultSettings()) {
  const container = makeElement('div');
  let settings = crucible.normalizeSettings(initialSettings);
  const ctx = {
    container,
    idPrefix: 'veyra-automation-crucible',
    settings,
    cls: (name) => `veyra-automation__${name}`,
    make: makeElement,
    addSectionTitle(value) {
      container.appendChild(makeElement('div', { text: value }));
    },
    addCheckbox({ id, label, checked, onChange, parent = container }) {
      const row = makeElement('label');
      const input = makeElement('input', { id: `${this.idPrefix}-${id}`, type: 'checkbox' });
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      row.appendChild(input);
      row.appendChild(makeElement('span', { text: label }));
      parent.appendChild(row);
      return input;
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
      settings = crucible.normalizeSettings(next);
      ctx.settings = settings;
      return settings;
    },
  };
  crucible.renderSettings(ctx);
  return {
    byId: (id) => walk(container).find((candidate) => candidate.id === id),
    container,
    getSettings: () => settings,
  };
}

test('Crucible route is registered and recognises only its marked scheduler hub', () => {
  assert.equal(ROUTES.crucible, crucible);
  assert.equal(routeIdForUrl('/guild_dungeon.php?veyra_route=crucible'), 'crucible');
  assert.equal(routeIdForUrl('/guild_dungeon.php'), null);
  assert.equal(
    isUrlWithinVisit('crucible', '/guild_dungeon_cube.php?instance_id=16126&veyra_visit=v1', 'v1'),
    true,
  );
  assert.equal(crucible.matchesUrl(new URL('https://demonicscans.org/guild_dungeon.php?veyra_route=shadowbridge')), false);
  assert.equal(crucible.CRUCIBLE_PVE_NODES.length, 4);
  assert.deepEqual(crucible.CRUCIBLE_PVE_NODES.map((node) => node.locationId), ['11', '12', '13', '14']);
  assert.equal(crucible.CRUCIBLE_PVE_NODES[3].isApex, true);
  assert.equal(crucible.CRUCIBLE_PVP_NODES.length, 3);
  assert.equal(crucible.CRUCIBLE_ARMY_NODES.length, 3);
});

test('Crucible settings normalize every mode, skill, cooldown and dynamic monster safely', () => {
  const routeDefaults = createDefaultConfig().routes.crucible;
  const defaults = routeDefaults.settings;
  assert.equal(routeDefaults.enabled, false);
  assert.equal(defaults.pveEnabled, true);
  assert.equal(defaults.debugLogging, false);
  assert.equal(defaults.pvp.enabled, true);
  assert.equal(defaults.army.enabled, true);
  assert.equal(defaults.army.mode, 'minimal');
  assert.equal(defaults.army.shadows.length, 5);
  assert.deepEqual(defaults.army.selectedShadowIds, ['5', '3', '4', '2', '6']);
  assert.equal(defaults.skill, '0');
  assert.equal(defaults.attackCooldownMs, 100);
  assert.equal(Object.keys(defaults.targets).length, 7);
  assert.equal(Object.values(defaults.targets).every((target) => target.enabled && target.mode === 'max-loot'), true);

  const saved = normalizeConfig({
    version: 1,
    routes: {
      crucible: {
        settings: {
          skill: '-4',
          debugLogging: true,
          attackCooldownMs: 9_999,
          pvp: { enabled: false },
          army: { enabled: true, mode: 'kill', selectedShadowIds: ['3'] },
          discoveredMonsters: [
            { nodeId: 'crown_lens', name: 'Crown Horror' },
            { nodeId: 'bad-node', name: 'Injected' },
          ],
          targets: {
            'crown_lens:crown-horror': { enabled: false, mode: 'custom', damage: '2.5B' },
          },
        },
      },
    },
  }).routes.crucible.settings;
  assert.equal(saved.skill, '-4');
  assert.equal(saved.debugLogging, true);
  assert.equal(saved.attackCooldownMs, 2_000);
  assert.equal(saved.pvp.enabled, false);
  assert.equal(saved.army.mode, 'kill');
  assert.deepEqual(saved.army.selectedShadowIds, ['3']);
  assert.equal(saved.discoveredMonsters.length, 1);
  assert.deepEqual(saved.targets['crown_lens:crown-horror'], {
    enabled: false,
    mode: 'custom',
    damage: '2.5b',
  });
});

test('new live monsters inherit their node default and become individual settings', () => {
  const settings = crucible.normalizeSettings({
    nodeDefaults: { crown_lens: { enabled: true, mode: 'max-exp', damage: '9m' } },
  });
  const merged = crucible.mergeDiscoveredMonsters(settings, [
    { nodeId: 'crown_lens', name: 'Crown Horror' },
    { nodeId: 'crown_lens', name: 'Crown Horror' },
  ]);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.settings.targets['crown_lens:crown-horror'], {
    enabled: true,
    mode: 'max-exp',
    damage: '9m',
  });
  assert.equal(
    crucible.settingsForMonster(merged.settings, 'crown_lens', 'Crown Horror').known,
    true,
  );
});

test('new owned Shadows are persisted but remain unselected until the user enables them', () => {
  const settings = crucible.normalizeSettings({ army: { selectedShadowIds: ['5'] } });
  const merged = crucible.mergeDiscoveredShadows(settings, [
    { id: '7', name: 'Newly Risen Captain' },
    { shadow_id: 7, title: 'Duplicate Name' },
  ]);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.settings.army.shadows.at(-1), { id: '7', name: 'Newly Risen Captain' });
  assert.deepEqual(merged.settings.army.selectedShadowIds, ['5']);
});

test('Crucible menu renders English PvE, PvP, Army and diagnostic controls with touch-sized selectors', () => {
  const harness = renderHarness();
  const prefix = 'veyra-automation-crucible';
  const titles = harness.container.children.map((child) => child.textContent).join(' ');
  assert.match(titles, /PvE.*PvP.*Army.*Diagnostics/);
  assert.equal(harness.byId(`${prefix}-pve-enabled`).checked, true);
  assert.equal(harness.byId(`${prefix}-pvp-enabled`).checked, true);
  assert.equal(harness.byId(`${prefix}-army-enabled`).checked, true);
  assert.equal(harness.byId(`${prefix}-debug-logging`).checked, false);
  assert.equal(harness.byId(`${prefix}-debug-output`).readOnly, true);
  assert.equal(harness.byId(`${prefix}-debug-copy`).textContent, 'Copy log');
  assert.equal(harness.byId(`${prefix}-pve-skill`).style.minHeight, '44px');
  assert.equal(harness.byId(`${prefix}-army-mode`).style.minHeight, '44px');
  assert.equal(harness.byId(`${prefix}-pve-target-zenith_lock-mode`).style.minHeight, '44px');
  assert.deepEqual(
    harness.byId(`${prefix}-pve-target-gate_prism-prismblade-reaver-mode`).children.map((option) => option.value),
    ['max-loot', 'max-exp', 'kill', 'custom'],
  );

  const armyMode = harness.byId(`${prefix}-army-mode`);
  armyMode.value = 'kill';
  armyMode.dispatch('change');
  assert.equal(harness.getSettings().army.mode, 'kill');

  const drakzareth = harness.byId(`${prefix}-army-shadow-5`);
  assert.equal(drakzareth.checked, true);
  drakzareth.checked = false;
  drakzareth.dispatch('change');
  assert.equal(harness.getSettings().army.selectedShadowIds.includes('5'), false);

  const pvp = harness.byId(`${prefix}-pvp-enabled`);
  pvp.checked = false;
  pvp.dispatch('change');
  assert.equal(harness.getSettings().pvp.enabled, false);

  const debug = harness.byId(`${prefix}-debug-logging`);
  debug.checked = true;
  debug.dispatch('change');
  assert.equal(harness.getSettings().debugLogging, true);
});
