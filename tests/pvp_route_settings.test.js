'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pvp = require('../src/routes/pvp');
const { createDefaultConfig, normalizeConfig } = require('../src/scheduler/config');

function makeElement(tagName, options = {}) {
  const listeners = new Map();
  return {
    tagName,
    id: options.id || '',
    className: options.className || '',
    textContent: options.text ?? '',
    type: options.type || '',
    children: [],
    attributes: {},
    style: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

function renderHarness(initialMode = 'autoplay') {
  const container = makeElement('div');
  const settings = { mode: initialMode };
  let updates = 0;
  const ctx = {
    container,
    idPrefix: 'veyra-automation-pvp',
    settings,
    cls: (name) => `veyra-automation__${name}`,
    make: makeElement,
    addSectionTitle(text) {
      container.appendChild(makeElement('div', { text }));
    },
    updateSettings(mutator) {
      const next = { ...settings };
      mutator(next);
      Object.assign(settings, pvp.normalizeSettings(next));
      updates += 1;
      return settings;
    },
  };

  pvp.renderSettings(ctx);
  return { container, settings, updateCount: () => updates };
}

test('PvP route defaults to autoplay and normalizes unsupported saved modes', () => {
  assert.deepEqual(pvp.createDefaultSettings(), { mode: 'autoplay' });
  assert.deepEqual(pvp.normalizeSettings(null), { mode: 'autoplay' });
  assert.deepEqual(pvp.normalizeSettings({ mode: 'unsupported' }), { mode: 'autoplay' });
  assert.deepEqual(pvp.normalizeSettings({ mode: 'skill-planner' }), { mode: 'skill-planner' });

  assert.equal(createDefaultConfig().routes.pvp.settings.mode, 'autoplay');
  assert.equal(
    normalizeConfig({ version: 1, routes: { pvp: { settings: { mode: 'skill-planner' } } } }).routes.pvp
      .settings.mode,
    'skill-planner',
  );
  assert.equal(
    normalizeConfig({ version: 1, routes: { pvp: { settings: { mode: 'unknown' } } } }).routes.pvp.settings
      .mode,
    'autoplay',
  );
});

test('PvP route renders touch-friendly English mode controls and persists changes', () => {
  const harness = renderHarness();
  assert.equal(harness.container.children[0].textContent, 'Battle mode');

  const group = harness.container.children[1];
  const [autoLabel, plannerLabel, hint] = group.children;
  const autoInput = autoLabel.children[0];
  const plannerInput = plannerLabel.children[0];

  assert.equal(autoLabel.children[1].textContent, 'Game Auto Play');
  assert.equal(plannerLabel.children[1].textContent, 'Solo PvP skill planner');
  assert.match(hint.textContent, /built-in automatic battle/);
  assert.match(hint.textContent, /deliberate skill sequence/);

  assert.equal(autoInput.type, 'radio');
  assert.equal(autoInput.value, 'autoplay');
  assert.equal(autoInput.checked, true);
  assert.equal(plannerInput.type, 'radio');
  assert.equal(plannerInput.value, 'skill-planner');
  assert.equal(plannerInput.checked, false);
  assert.equal(autoInput.name, plannerInput.name);
  assert.equal(autoInput.attributes['aria-describedby'], hint.id);
  assert.equal(autoLabel.style.minHeight, '44px');
  assert.equal(plannerLabel.style.minHeight, '44px');

  plannerInput.checked = true;
  plannerInput.dispatch('change');
  assert.equal(harness.settings.mode, 'skill-planner');
  assert.equal(harness.updateCount(), 1);

  plannerInput.checked = false;
  plannerInput.dispatch('change');
  assert.equal(harness.settings.mode, 'skill-planner');
  assert.equal(harness.updateCount(), 1);
});
