'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { coerceSetting, createSettingsStore } = require('../src/core/settings');
const { createJsonStore } = require('../src/core/storage');
const {
  getRequiredExperienceToLevel,
  pageGlobal,
  readUserIdFromDocument,
} = require('../src/core/game');
const { isFeatureEnabled, runFeatures, settingGroups } = require('../src/features/runner');
const { FEATURES } = require('../src/features');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

// Minimal document stub: querySelector answers from a selector → element map.
function fakeDoc(elements = {}) {
  return {
    querySelector: (selector) => elements[selector] || null,
    getElementById: () => null,
  };
}

const CHECKBOX = { key: 'test:flag', type: 'checkbox', default: true };
const NUMBER = { key: 'test:number', type: 'number', default: 1.5, min: 1 };
const SELECT = { key: 'test:mode', type: 'select', default: 'a', options: [{ value: 'a' }, { value: 'b' }] };

test('settings are coerced to their type and fall back to defaults', () => {
  assert.equal(coerceSetting(CHECKBOX, 'false'), false);
  assert.equal(coerceSetting(CHECKBOX, 'maybe'), true);
  assert.equal(coerceSetting(NUMBER, '2.5'), 2.5);
  assert.equal(coerceSetting(NUMBER, '0'), 1);
  assert.equal(coerceSetting(NUMBER, ''), 1.5);
  assert.equal(coerceSetting(SELECT, 'b'), 'b');
  assert.equal(coerceSetting(SELECT, 'c'), 'a');
});

test('settings store reads values saved by veyra-hud (JSON per key)', () => {
  const storage = createStorage({ 'test:flag': 'false', 'test:number': '3' });
  const settings = createSettingsStore(createJsonStore(storage));
  assert.equal(settings.get(CHECKBOX), false);
  assert.equal(settings.get(NUMBER), 3);
  assert.equal(settings.get(SELECT), 'a');
  assert.equal(settings.set(SELECT, 'b'), 'b');
  assert.equal(storage.getItem('test:mode'), '"b"');
});

test('page helpers are null safe', () => {
  assert.equal(getRequiredExperienceToLevel(fakeDoc()), null);
  assert.equal(
    getRequiredExperienceToLevel(
      fakeDoc({ '.gtb-exp-top span:last-child': { textContent: '1,000 / 5,000' } }),
    ),
    4_000,
  );
  assert.equal(readUserIdFromDocument(fakeDoc()), null);
  assert.equal(
    readUserIdFromDocument(
      fakeDoc({ '.small-ava img[src*="user_"]': { getAttribute: () => 'uploads/avatars/user_159129_1.webp' } }),
    ),
    159_129,
  );
  assert.equal(pageGlobal(globalThis, 'NOT_DEFINED_ANYWHERE'), undefined);
  assert.equal(pageGlobal(globalThis, 'bad name;'), undefined);
});

test('runFeatures runs matching enabled features and isolates failures', async () => {
  const ran = [];
  const features = [
    {
      id: 'one',
      group: 'G',
      settings: [{ key: 'f:one', type: 'checkbox', default: true, label: 'One' }],
      enabledBy: 'f:one',
      matches: () => true,
      run: () => ran.push('one'),
    },
    {
      id: 'broken',
      group: 'G',
      settings: [],
      matches: () => true,
      run: () => {
        throw new Error('boom');
      },
    },
    {
      id: 'off',
      group: 'G',
      settings: [{ key: 'f:off', type: 'checkbox', default: false, label: 'Off' }],
      enabledBy: 'f:off',
      matches: () => true,
      run: () => ran.push('off'),
    },
    {
      id: 'elsewhere',
      group: 'G',
      settings: [],
      matches: (url) => url.pathname === '/pvp.php',
      run: () => ran.push('elsewhere'),
    },
    {
      id: 'after',
      group: 'H',
      settings: [],
      matches: () => true,
      run: async (ctx) => ran.push(`after:${ctx.setting('f:one')}`),
    },
  ];
  const settings = createSettingsStore(createJsonStore(createStorage()));
  const originalError = console.error;
  console.error = () => {};
  try {
    await Promise.all(
      runFeatures({
        win: { location: { href: 'https://demonicscans.org/game_dash.php' } },
        doc: {},
        features,
        settings,
        store: null,
        getUserId: async () => 1,
      }),
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(ran.sort(), ['after:true', 'one']);
  assert.equal(isFeatureEnabled(features[2], features, settings), false);
});

test('settingGroups merges shared keys and drops empty groups', () => {
  const shared = { key: 's:shared', type: 'checkbox', default: true, label: 'Shared' };
  const groups = settingGroups([
    { id: 'a', group: 'G', settings: [shared] },
    { id: 'b', group: 'G', settings: [shared, { key: 's:b', type: 'text', default: '', label: 'B' }] },
    { id: 'c', group: 'Empty', settings: [] },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.title, group.settings.map((setting) => setting.key)]),
    [['G', ['s:shared', 's:b']]],
  );
});

test('every registered feature is well formed', () => {
  const ids = new Set();
  for (const feature of FEATURES) {
    assert.ok(feature.id && !ids.has(feature.id), `duplicate or missing id ${feature.id}`);
    ids.add(feature.id);
    assert.equal(typeof feature.group, 'string');
    assert.equal(typeof feature.matches, 'function');
    assert.equal(typeof feature.run, 'function');
    for (const setting of feature.settings || []) {
      assert.ok(setting.key && setting.label, `${feature.id}: setting needs key and label`);
      assert.ok(['checkbox', 'number', 'text', 'select'].includes(setting.type), `${feature.id}: ${setting.key}`);
    }
    if (feature.enabledBy) {
      const all = FEATURES.flatMap((candidate) => candidate.settings || []);
      assert.ok(all.some((setting) => setting.key === feature.enabledBy), `${feature.id}: enabledBy`);
    }
  }
});
