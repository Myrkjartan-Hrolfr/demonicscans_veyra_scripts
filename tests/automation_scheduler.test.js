'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { COMMAND_KEY } = require('../src/core/protocol');
const { createJsonStore } = require('../src/core/storage');
const { ROUTES } = require('../src/routes');
const {
  CONFIG_KEY,
  createDefaultConfig,
  loopIntervalMs,
  normalizeConfig,
} = require('../src/scheduler/config');
const {
  RUNTIME_KEY,
  applyLoopChange,
  chooseDueRoute,
  completeRuntimeVisit,
  createDefaultRuntime,
  routeIdForUrl,
} = require('../src/scheduler/runtime');
const { createSchedulerEngine } = require('../src/scheduler/engine');
const { countdownText } = require('../src/scheduler/ui');
const { build } = require('../build');

const NOW = 1_800_000_000_000;

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function createFakeWindow(href) {
  const navigations = [];
  const location = {
    href,
    origin: new URL(href).origin,
    replace(url) {
      navigations.push(url);
    },
  };
  return {
    location,
    navigations,
    setInterval: () => 1,
    clearInterval: () => {},
    crypto: { randomUUID: () => 'test-owner' },
  };
}

function createEngine(href, storageValues = {}) {
  const storage = createStorage(storageValues);
  const store = createJsonStore(storage);
  const sessionStore = createJsonStore(createStorage());
  const statuses = [];
  const ui = { setStatus: (text) => statuses.push(text), update: () => {} };
  const win = createFakeWindow(href);
  const engine = createSchedulerEngine({ win, store, sessionStore, ui });
  return { engine, store, storage, win, statuses };
}

test('default config gives every page a loop length and its own potion selection', () => {
  const config = createDefaultConfig();
  assert.equal(config.homeRouteId, 'pvp');
  for (const route of Object.values(ROUTES)) {
    const routeConfig = config.routes[route.id];
    assert.equal(routeConfig.enabled, route.defaultEnabled !== false);
    assert.equal(routeConfig.loopMinutes, route.defaultLoopMinutes);
    assert.deepEqual(routeConfig.potions, { stamina: [], heal: [] });
  }
});

test('new mutating routes stay disabled when an older config has no entry for them', () => {
  const config = normalizeConfig({
    version: 1,
    enabled: true,
    homeRouteId: 'pvp',
    routes: { pvp: { enabled: true } },
  });
  assert.equal(config.routes.adventurers.enabled, false);
  assert.equal(config.routes.shadowbridge.enabled, false);
  assert.equal(config.routes.crucible.enabled, false);
});

test('potion selections are stored per page and stay independent', () => {
  const config = normalizeConfig({
    version: 1,
    routes: {
      pvp: { potions: { stamina: [30], heal: [108] } },
      wave3: { potions: { stamina: [251, 35], heal: [] } },
    },
  });
  assert.deepEqual(config.routes.pvp.potions, { stamina: [30], heal: [108] });
  assert.deepEqual(config.routes.wave3.potions, { stamina: [251, 35], heal: [] });
});

test('loop length is clamped and drives the next countdown', () => {
  const config = normalizeConfig({ version: 1, routes: { pvp: { loopMinutes: 0 }, wave3: { loopMinutes: '45' } } });
  assert.equal(config.routes.pvp.loopMinutes, 1);
  assert.equal(config.routes.wave3.loopMinutes, 45);
  assert.equal(normalizeConfig({ version: 1, routes: { pvp: { loopMinutes: 99_999 } } }).routes.pvp.loopMinutes, 1_440);
  assert.equal(loopIntervalMs(config, 'wave3'), 45 * 60_000);

  const runtime = createDefaultRuntime(NOW);
  runtime.activeVisit = {
    version: 1,
    visitId: 'v1',
    taskId: 'wave3',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: NOW,
    deadlineAt: NOW + 1,
  };
  const completed = completeRuntimeVisit(runtime, 'done', NOW, config);
  assert.equal(completed.nextRunAt.wave3, NOW + 45 * 60_000);
  assert.equal(completed.activeVisit, null);
  assert.equal(completed.lastResult.state, 'done');
});

test('shortening the loop pulls the countdown forward, lengthening does not push it back', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW + 60 * 60_000;
  assert.equal(applyLoopChange(runtime, 'pvp', 5 * 60_000, NOW).nextRunAt.pvp, NOW + 5 * 60_000);
  runtime.nextRunAt.pvp = NOW + 60_000;
  assert.equal(applyLoopChange(runtime, 'pvp', 60 * 60_000, NOW).nextRunAt.pvp, NOW + 60_000);
});

test('legacy wave3 configs keep working with the old worker flag', () => {
  const legacy = normalizeConfig({
    version: 1,
    routes: { wave3: { enabled: true, settings: { useStaminaPotions: true, bosses: { skarn: { damage: '5B' } } } } },
  });
  assert.deepEqual(legacy.routes.wave3.potions.stamina, [30, 251, 35, 359]);
  assert.equal(legacy.routes.wave3.settings.useStaminaPotions, true);
  assert.equal(legacy.routes.wave3.settings.bosses.skarn.damage, '5b');
  assert.equal(legacy.routes.wave3.settings.bosses.skarn.name, 'General Skarn the Radiant Bastion');

  const cleared = normalizeConfig({
    version: 1,
    routes: { wave3: { potions: { stamina: [] }, settings: { useStaminaPotions: true } } },
  });
  assert.equal(cleared.routes.wave3.settings.useStaminaPotions, false);
});

test('routes are recognised from URLs', () => {
  assert.equal(routeIdForUrl('/pvp.php'), 'pvp');
  assert.equal(routeIdForUrl('/pvp_battle.php?id=3'), 'pvp');
  assert.equal(routeIdForUrl('/active_wave.php?gate=3&wave=8'), 'wave3');
  assert.equal(routeIdForUrl('/active_wave.php?gate=5&wave=9'), 'olympus');
  assert.equal(routeIdForUrl('/active_wave.php?gate=5&wave=17'), 'olympus');
  assert.equal(routeIdForUrl('/active_wave.php?gate=5&wave=18'), null);
  assert.equal(routeIdForUrl('/adventurers_guild.php?veyra_route=adventurers'), 'adventurers');
  assert.equal(routeIdForUrl('/adventurers_guild.php'), null);
  assert.equal(routeIdForUrl('/active_wave.php?gate=3&wave=5'), null);
  assert.equal(routeIdForUrl('/game_dash.php'), null);
});

test('boss pages store attack toggles, damage targets and up to three skills', () => {
  const config = normalizeConfig({
    version: 1,
    routes: {
      wave3: { settings: { bosses: { vessir: { enabled: false, damage: '2B' } }, skills: ['-4', '0', '-1', '-2'] } },
      olympus: { settings: { bosses: { zeus: { enabled: true, damage: '750m' } }, skills: ['nope'] } },
    },
  });
  const wave3 = config.routes.wave3.settings;
  assert.equal(wave3.bosses.vessir.enabled, false);
  assert.equal(wave3.bosses.vessir.damage, '2b');
  assert.equal(wave3.bosses.skarn.enabled, true);
  assert.deepEqual(wave3.skills, ['0', '-1', '-2']);

  const olympus = config.routes.olympus.settings;
  assert.equal(olympus.bosses.zeus.enabled, true);
  assert.equal(olympus.bosses.zeus.name, 'Zeus, Sovereign of the Storm Throne');
  assert.equal(olympus.bosses.hera.enabled, false);
  assert.deepEqual(olympus.skills, ['0']);
  assert.equal(Object.keys(olympus.bosses).length, 18);
  assert.equal(ROUTES.olympus.domainPath(ROUTES.olympus.OLYMPUS_DOMAINS[8]), '/active_wave.php?gate=5&wave=17');
});

test('chooseDueRoute skips disabled pages and picks the earliest due one', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt = { pvp: NOW - 1_000, wave3: NOW - 5_000 };
  assert.equal(chooseDueRoute(runtime, NOW, createDefaultConfig()).id, 'wave3');

  const config = createDefaultConfig();
  config.routes.wave3.enabled = false;
  assert.equal(chooseDueRoute(runtime, NOW, config).id, 'pvp');
});

test('countdown text in the menu', () => {
  const config = createDefaultConfig();
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW + 90_000;
  assert.equal(countdownText('pvp', config, runtime, NOW), 'In 01:30');
  config.routes.pvp.enabled = false;
  assert.equal(countdownText('pvp', config, runtime, NOW), 'Inactive');
});

test('engine starts a due visit and navigates to the page', () => {
  const { engine, store, win } = createEngine('https://demonicscans.org/game_dash.php');
  const runtime = createDefaultRuntime(Date.now());
  runtime.nextRunAt = { pvp: Date.now() - 1, wave3: Date.now() + 60_000 };
  store.write(RUNTIME_KEY, runtime);

  engine.start();
  const command = store.read(COMMAND_KEY);
  assert.equal(command.taskId, 'pvp');
  assert.equal(command.phase, 'draining');

  engine.tick();
  assert.deepEqual(win.navigations, ['https://demonicscans.org/pvp.php']);
  assert.equal(store.read(COMMAND_KEY).phase, 'running');
});

test('engine finishes a visit when the worker reports done and schedules by loop length', () => {
  const now = Date.now();
  const config = createDefaultConfig();
  config.routes.pvp.loopMinutes = 7;
  config.homeRouteId = 'wave3';
  const runtime = createDefaultRuntime(now);
  runtime.nextRunAt.wave3 = now + 60_000;
  runtime.activeVisit = {
    version: 1,
    visitId: 'visit-1',
    taskId: 'pvp',
    phase: 'running',
    returnPath: '/active_wave.php?gate=3&wave=8',
    issuedAt: now,
    deadlineAt: now + 60_000,
  };
  const { engine, store, win } = createEngine('https://demonicscans.org/pvp.php', {
    [CONFIG_KEY]: JSON.stringify(config),
    [RUNTIME_KEY]: JSON.stringify(runtime),
    'veyra:worker:pvp:status:v1': JSON.stringify({
      visitId: 'visit-1',
      state: 'done',
      safeToLeave: true,
      updatedAt: now,
    }),
  });

  engine.start();
  const saved = store.read(RUNTIME_KEY);
  assert.equal(saved.activeVisit, null);
  assert.ok(Math.abs(saved.nextRunAt.pvp - (now + 7 * 60_000)) < 5_000);
  assert.deepEqual(win.navigations, ['https://demonicscans.org/active_wave.php?gate=3&wave=8']);
  assert.equal(store.read(COMMAND_KEY), null);
});

test('engine keeps working while the tab is hidden', () => {
  const { engine, store } = createEngine('https://demonicscans.org/game_dash.php');
  const runtime = createDefaultRuntime(Date.now());
  runtime.nextRunAt = { pvp: Date.now() - 1, wave3: Date.now() + 60_000 };
  store.write(RUNTIME_KEY, runtime);
  globalThis.document = { hidden: true };
  try {
    engine.start();
  } finally {
    delete globalThis.document;
  }
  assert.equal(store.read(COMMAND_KEY)?.taskId, 'pvp');
});

test('updateRouteConfig stores per-page potions and applies a shorter loop at once', () => {
  const { engine, store } = createEngine('https://demonicscans.org/pvp.php');
  engine.start();
  engine.updateRouteConfig('wave3', (routeConfig) => {
    routeConfig.potions.stamina = [251];
    routeConfig.loopMinutes = 2;
  });

  const config = store.read(CONFIG_KEY);
  assert.deepEqual(config.routes.wave3.potions.stamina, [251]);
  assert.deepEqual(config.routes.pvp.potions.stamina, []);
  assert.equal(config.routes.wave3.settings.useStaminaPotions, true);
  assert.ok(store.read(RUNTIME_KEY).nextRunAt.wave3 <= Date.now() + 2 * 60_000);
});

test('the bundle builds and evaluates without errors', () => {
  const { outFile, modules } = build();
  assert.ok(modules.includes('main.js'));
  const source = fs.readFileSync(outFile, 'utf8');
  assert.match(source, /^\/\/ ==UserScript==/);
  assert.match(source, /Power Target List/);
  assert.match(source, /Status Potion Auto Use/);
  // Without window/document the entry module must do nothing.
  vm.runInNewContext(source, { console, URL, URLSearchParams }, { filename: path.basename(outFile) });
});
