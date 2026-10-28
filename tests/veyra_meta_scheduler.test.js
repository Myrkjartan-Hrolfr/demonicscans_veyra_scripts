'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../veyra_meta_scheduler.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const {
  COMMAND_KEY,
  CONFIG_KEY,
  LEASE_KEY,
  POLL_INTERVAL_MS,
  ROUTES,
  RUNTIME_KEY,
  WAVE3_BOSSES,
  chooseDueRoute,
  createDefaultConfig,
  createDefaultRuntime,
  formatCountdown,
  normalizeConfig,
  routeIdForUrl,
  workerStatusKey,
} = require(scriptPath);

const NOW = 1_800_000_000_000;

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));

  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function createTimers() {
  let nextId = 1;
  const intervals = [];

  return {
    api: {
      setInterval(callback, delay) {
        const entry = { id: nextId++, callback, delay, cleared: false };
        intervals.push(entry);
        return entry.id;
      },
      clearInterval(id) {
        const entry = intervals.find((candidate) => candidate.id === id);
        if (entry) entry.cleared = true;
      },
    },
    runInterval(delay = POLL_INTERVAL_MS) {
      const entry = intervals.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms interval`);
      entry.callback();
    },
  };
}

function createFakeDom(documentListeners) {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.id = '';
      this.className = '';
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {
        removeProperty: (name) => {
          delete this.style[name];
        },
      };
      this.textContent = '';
      this.value = '';
      this.checked = false;
      this.hidden = false;
      this.type = '';
      this.title = '';
      this._rect = null;
    }

    get firstChild() {
      return this.children[0] || null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }

    getAttribute(name) {
      return this.attributes.get(String(name)) ?? null;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type, extra = {}) {
      for (const listener of this.listeners.get(type) || []) {
        listener({ type, target: this, ...extra });
      }
    }

    click() {
      this.dispatch('click');
    }

    getBoundingClientRect() {
      if (this._rect) return this._rect;
      if (this.id === 'veyra-meta-scheduler-trigger') {
        return { left: 0, right: 42, top: 0, bottom: 40, width: 42, height: 40 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    }
  }

  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  html.appendChild(head);
  html.appendChild(body);

  function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }

  const document = {
    body,
    head,
    documentElement: html,
    activeElement: null,
    hidden: false,
    visibilityState: 'visible',
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    getElementById(id) {
      return findById(html, String(id));
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
  };

  const siteSettings = new FakeElement('button');
  siteSettings.id = 'openSettingsDrawerBtn';
  siteSettings._rect = {
    left: 900,
    right: 942,
    top: 700,
    bottom: 740,
    width: 42,
    height: 40,
  };
  body.appendChild(siteSettings);

  const siteConsole = new FakeElement('button');
  siteConsole.id = 'openConsoleBtn';
  siteConsole._rect = {
    left: 850,
    right: 892,
    top: 700,
    bottom: 740,
    width: 42,
    height: 40,
  };
  body.appendChild(siteConsole);

  const quickSets = new FakeElement('button');
  quickSets.id = 'openQuickSetDrawerBtn';
  quickSets._rect = {
    left: 950,
    right: 992,
    top: 700,
    bottom: 740,
    width: 42,
    height: 40,
  };
  body.appendChild(quickSets);
  return document;
}

function runScheduler({
  href = 'https://demonicscans.org/pvp.php',
  localStorage = createStorage(),
  sessionStorage = createStorage(),
  now = NOW,
  withDom = false,
} = {}) {
  const timers = createTimers();
  const navigation = { replacements: [] };
  const url = new URL(href);
  const windowListeners = new Map();
  const documentListeners = new Map();

  class FixedDate extends Date {
    static now() {
      return typeof now === 'function' ? now() : now;
    }
  }

  const document = withDom
    ? createFakeDom(documentListeners)
    : {
        body: null,
        hidden: false,
        visibilityState: 'visible',
        getElementById() {
          return null;
        },
        addEventListener(type, listener) {
          const listeners = documentListeners.get(type) || [];
          listeners.push(listener);
          documentListeners.set(type, listeners);
        },
      };

  const window = {
    ...timers.api,
    localStorage,
    sessionStorage,
    location: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      replace(nextUrl) {
        navigation.replacements.push(String(nextUrl));
      },
    },
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      windowListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    },
  };

  vm.runInNewContext(scriptSource, {
    Date: FixedDate,
    Math,
    URL,
    console: { info() {}, warn() {}, error() {} },
    document,
    window,
  });

  return { document, localStorage, navigation, sessionStorage, timers, window };
}

function save(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
}

function read(storage, key) {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

function configuredStorage({ homeRouteId = 'pvp', runtime } = {}) {
  const storage = createStorage();
  save(storage, CONFIG_KEY, { ...createDefaultConfig(), homeRouteId });
  if (runtime) save(storage, RUNTIME_KEY, runtime);
  return storage;
}

function runtimeWithDueWave() {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW + ROUTES.pvp.intervalMs;
  runtime.nextRunAt.wave3 = NOW - 1;
  return runtime;
}

function runtimeWithDuePvp() {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW - 1;
  runtime.nextRunAt.wave3 = NOW + ROUTES.wave3.intervalMs;
  return runtime;
}

function runningVisit(taskId, returnPath) {
  return {
    version: 1,
    visitId: `visit-${taskId}`,
    taskId,
    phase: 'running',
    returnPath,
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + ROUTES[taskId].maxVisitMs,
  };
}

test('metadata covers apex and www pages without privileged grants', () => {
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/demonicscans\.org\/\*$/m);
  assert.match(scriptSource, /^\/\/ @match\s+https:\/\/www\.demonicscans\.org\/\*$/m);
  assert.match(scriptSource, /^\/\/ @grant\s+none$/m);
  assert.match(scriptSource, /^\/\/ @noframes$/m);
});

test('default config exposes route toggles and all four Wave 3 boss settings', () => {
  const config = createDefaultConfig();

  assert.equal(config.routes.pvp.enabled, true);
  assert.equal(config.routes.wave3.enabled, true);
  assert.equal(config.routes.wave3.settings.useStaminaPotions, false);
  assert.deepEqual(
    Object.keys(config.routes.wave3.settings.bosses),
    Object.keys(WAVE3_BOSSES),
  );
  for (const boss of Object.values(WAVE3_BOSSES)) {
    assert.deepEqual(config.routes.wave3.settings.bosses[boss.id], {
      name: boss.name,
      damage: '3b',
    });
  }
});

test('normalizes old configs and preserves valid Wave 3 drawer settings', () => {
  const migrated = normalizeConfig({ version: 1, enabled: true, homeRouteId: 'pvp' });
  assert.equal(migrated.routes.pvp.enabled, true);
  assert.equal(migrated.routes.wave3.settings.bosses.skarn.damage, '3b');

  const customized = normalizeConfig({
    ...createDefaultConfig(),
    routes: {
      pvp: { enabled: false, settings: {} },
      wave3: {
        enabled: true,
        settings: {
          useStaminaPotions: true,
          bosses: {
            skarn: { name: 'untrusted name', damage: '4.25b' },
            vessir: { damage: '' },
          },
        },
      },
    },
  });

  assert.equal(customized.routes.pvp.enabled, false);
  assert.equal(customized.routes.wave3.settings.useStaminaPotions, true);
  assert.equal(customized.routes.wave3.settings.bosses.skarn.name, WAVE3_BOSSES.skarn.name);
  assert.equal(customized.routes.wave3.settings.bosses.skarn.damage, '4.25b');
  assert.equal(customized.routes.wave3.settings.bosses.vessir.damage, '3b');

  const invalid = normalizeConfig({
    ...createDefaultConfig(),
    routes: {
      ...createDefaultConfig().routes,
      wave3: {
        enabled: true,
        settings: {
          bosses: {
            skarn: { damage: 'abc' },
            vessir: { damage: '0' },
          },
        },
      },
    },
  });
  assert.equal(invalid.routes.wave3.settings.bosses.skarn.damage, '3b');
  assert.equal(invalid.routes.wave3.settings.bosses.vessir.damage, '3b');
});

test('disabled routes are excluded from due-route selection', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW - 2;
  runtime.nextRunAt.wave3 = NOW - 1;
  const config = createDefaultConfig();
  config.routes.pvp.enabled = false;

  assert.equal(chooseDueRoute(runtime, NOW, config).id, 'wave3');
  config.routes.wave3.enabled = false;
  assert.equal(chooseDueRoute(runtime, NOW, config), null);
});

test('countdown text is stable for due, minute and hour values', () => {
  assert.equal(formatCountdown(NOW, NOW), 'Jetzt fällig');
  assert.equal(formatCountdown(NOW + 65_000, NOW), 'Noch 01:05');
  assert.equal(formatCountdown(NOW + 3_661_000, NOW), 'Noch 01:01:01');
});

test('floating trigger opens the drawer and its controls persist scheduler config', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW + ROUTES.pvp.intervalMs;
  runtime.nextRunAt.wave3 = NOW + ROUTES.wave3.intervalMs;
  const localStorage = configuredStorage({ runtime });
  const harness = runScheduler({ localStorage, withDom: true });
  const byId = (id) => harness.document.getElementById(id);

  const trigger = byId('veyra-meta-scheduler-trigger');
  const drawer = byId('veyra-meta-scheduler-drawer');
  assert.ok(trigger);
  assert.ok(drawer);
  assert.equal(trigger.style.left, '900px');
  assert.equal(trigger.style.top, '652px');
  assert.equal(byId('veyra-meta-scheduler-toggle').textContent, 'Stop');

  trigger.click();
  assert.equal(drawer.dataset.open, 'true');

  const home = byId('veyra-meta-scheduler-home');
  home.value = 'wave3';
  home.dispatch('change');
  assert.equal(read(localStorage, CONFIG_KEY).homeRouteId, 'wave3');

  const waveToggle = byId('veyra-meta-scheduler-route-wave3-enabled');
  waveToggle.checked = false;
  waveToggle.dispatch('change');
  assert.equal(read(localStorage, CONFIG_KEY).routes.wave3.enabled, false);
  assert.equal(byId('veyra-meta-scheduler-route-wave3-countdown').textContent, 'Inaktiv');

  byId('veyra-meta-scheduler-toggle').click();
  assert.equal(read(localStorage, CONFIG_KEY).enabled, false);
  assert.equal(byId('veyra-meta-scheduler-toggle').textContent, 'Start');
});

test('Wave 3 subdrawer saves four damage targets and the stamina-potion option', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.nextRunAt.pvp = NOW + ROUTES.pvp.intervalMs;
  runtime.nextRunAt.wave3 = NOW + ROUTES.wave3.intervalMs;
  const localStorage = configuredStorage({ runtime });
  const harness = runScheduler({ localStorage, withDom: true });
  const byId = (id) => harness.document.getElementById(id);

  byId('veyra-meta-scheduler-route-wave3-settings').click();
  assert.equal(byId('veyra-meta-scheduler-drawer').dataset.view, 'settings');

  for (const boss of Object.values(WAVE3_BOSSES)) {
    assert.equal(byId(`veyra-meta-scheduler-wave3-damage-${boss.id}`).value, '3b');
  }

  const skarnDamage = byId('veyra-meta-scheduler-wave3-damage-skarn');
  skarnDamage.value = '4b';
  skarnDamage.dispatch('change');
  const potions = byId('veyra-meta-scheduler-wave3-stamina-potions');
  potions.checked = true;
  potions.dispatch('change');

  const config = read(localStorage, CONFIG_KEY);
  assert.equal(config.routes.wave3.settings.bosses.skarn.damage, '4b');
  assert.equal(config.routes.wave3.settings.useStaminaPotions, true);
});

test('the PvP lobby and standalone PvP battle belong to the same worker route', () => {
  assert.equal(routeIdForUrl('https://demonicscans.org/pvp.php'), 'pvp');
  assert.equal(routeIdForUrl('https://demonicscans.org/pvp_battle.php?id=7'), 'pvp');
});

test('a due Wave 3 visit waits for a fresh safe PvP hand-off and then navigates', () => {
  const localStorage = configuredStorage({ runtime: runtimeWithDueWave() });
  const harness = runScheduler({ localStorage });

  const draining = read(localStorage, COMMAND_KEY);
  assert.equal(draining.taskId, 'wave3');
  assert.equal(draining.phase, 'draining');
  assert.deepEqual(harness.navigation.replacements, []);

  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'idle',
    safeToLeave: true,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'running');
  assert.deepEqual(harness.navigation.replacements, [
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  ]);
});

test('a disabled due route does not issue a visit command', () => {
  const config = createDefaultConfig();
  config.routes.wave3.enabled = false;
  const localStorage = configuredStorage({ runtime: runtimeWithDueWave() });
  save(localStorage, CONFIG_KEY, config);

  const harness = runScheduler({ localStorage });

  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit, null);
  assert.deepEqual(harness.navigation.replacements, []);
});

test('a disabled active route times out and returns home without a worker heartbeat', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = {
    ...runningVisit('wave3', ROUTES.pvp.path),
    deadlineAt: NOW,
  };
  runtime.activeVisit = visit;
  const config = createDefaultConfig();
  config.routes.wave3.enabled = false;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, CONFIG_KEY, config);
  save(localStorage, COMMAND_KEY, visit);

  const harness = runScheduler({
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage,
  });

  const settledRuntime = read(localStorage, RUNTIME_KEY);
  assert.equal(settledRuntime.activeVisit, null);
  assert.equal(settledRuntime.lastResult.state, 'error');
  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.deepEqual(harness.navigation.replacements, ['https://demonicscans.org/pvp.php']);
});

test('a busy standalone PvP battle defers a due route change', () => {
  const localStorage = configuredStorage({ runtime: runtimeWithDueWave() });
  const harness = runScheduler({
    href: 'https://demonicscans.org/pvp_battle.php?id=7',
    localStorage,
  });
  const draining = read(localStorage, COMMAND_KEY);

  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'working',
    safeToLeave: false,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.deepEqual(harness.navigation.replacements, []);
});

test('a manual Wave 3 battle without a visit marker is not interrupted while its worker is busy', () => {
  const localStorage = configuredStorage({
    homeRouteId: 'wave3',
    runtime: runtimeWithDuePvp(),
  });
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: '',
    workerId: 'wave3',
    state: 'busy',
    safeToLeave: false,
    updatedAt: NOW,
  });
  const harness = runScheduler({
    href: 'https://demonicscans.org/battle.php?id=42',
    localStorage,
  });

  assert.equal(read(localStorage, COMMAND_KEY).taskId, 'pvp');
  harness.timers.runInterval();

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.deepEqual(harness.navigation.replacements, []);
});

test('matching worker completion schedules the next run and returns home', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'done',
    safeToLeave: true,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage,
  });

  const nextRuntime = read(localStorage, RUNTIME_KEY);
  assert.equal(nextRuntime.activeVisit, null);
  assert.equal(nextRuntime.nextRunAt.wave3, NOW + ROUTES.wave3.intervalMs);
  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.deepEqual(harness.navigation.replacements, ['https://demonicscans.org/pvp.php']);
});

test('a stale completion from another visit is ignored', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: 'older-visit',
    workerId: 'wave3',
    state: 'done',
    safeToLeave: true,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage,
  });

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, visit.visitId);
  assert.deepEqual(harness.navigation.replacements, []);
});

test('a Wave 3 battle carrying its visit marker is not redirected when a heartbeat is briefly stale', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);

  const harness = runScheduler({
    href: `https://demonicscans.org/battle.php?id=42&veyra_visit=${visit.visitId}`,
    localStorage,
  });

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, visit.visitId);
  assert.deepEqual(harness.navigation.replacements, []);
});

test('the configured Wave 3 home route is used after a PvP visit', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('pvp', ROUTES.wave3.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ homeRouteId: 'wave3', runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'pvp',
    state: 'done',
    safeToLeave: true,
    updatedAt: NOW,
  });

  const harness = runScheduler({ href: 'https://demonicscans.org/pvp.php', localStorage });

  assert.deepEqual(harness.navigation.replacements, [
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  ]);
});

test('repeated polls cannot issue duplicate location replacements', () => {
  const localStorage = configuredStorage({ runtime: runtimeWithDueWave() });
  const harness = runScheduler({ localStorage });
  const draining = read(localStorage, COMMAND_KEY);
  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'idle',
    safeToLeave: true,
    updatedAt: NOW,
  });

  harness.timers.runInterval();
  harness.timers.runInterval();
  harness.timers.runInterval();

  assert.equal(harness.navigation.replacements.length, 1);
});

test('an unsafe terminal status cannot finish or navigate until the worker becomes safe', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'done',
    safeToLeave: false,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: 'https://demonicscans.org/active_wave.php?gate=3&wave=8',
    localStorage,
  });

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, visit.visitId);
  assert.deepEqual(harness.navigation.replacements, []);

  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'done',
    safeToLeave: true,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit, null);
  assert.deepEqual(harness.navigation.replacements, ['https://demonicscans.org/pvp.php']);
});

test('a running deadline requests draining and waits for a matching safe status', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = { ...runningVisit('wave3', ROUTES.pvp.path), deadlineAt: NOW };
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'busy',
    safeToLeave: false,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: `https://demonicscans.org/battle.php?id=42&veyra_visit=${visit.visitId}`,
    localStorage,
  });

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, visit.visitId);
  assert.deepEqual(harness.navigation.replacements, []);

  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'idle',
    safeToLeave: true,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  const settledRuntime = read(localStorage, RUNTIME_KEY);
  assert.equal(settledRuntime.activeVisit, null);
  assert.equal(settledRuntime.lastResult.state, 'error');
  assert.deepEqual(harness.navigation.replacements, ['https://demonicscans.org/pvp.php']);
});

test('an expired initial drain aborts when no fresh unsafe worker blocks it', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.activeVisit = {
    ...runningVisit('wave3', ROUTES.pvp.path),
    phase: 'draining',
    deadlineAt: NOW - 1,
  };
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, runtime.activeVisit);

  const harness = runScheduler({ localStorage });

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit, null);
  assert.equal(read(localStorage, RUNTIME_KEY).lastResult.state, 'error');
  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.deepEqual(harness.navigation.replacements, []);
});

test('an expired initial drain still waits for a fresh unsafe current worker', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.activeVisit = {
    ...runningVisit('wave3', ROUTES.pvp.path),
    phase: 'draining',
    deadlineAt: NOW - 1,
  };
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, runtime.activeVisit);
  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'busy',
    safeToLeave: false,
    updatedAt: NOW,
  });

  const harness = runScheduler({ localStorage });

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, runtime.activeVisit.visitId);
  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.deepEqual(harness.navigation.replacements, []);
});

test('off-route recovery drains a foreign busy worker before reopening the target', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'busy',
    safeToLeave: false,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: 'https://demonicscans.org/pvp_battle.php?id=7',
    localStorage,
  });

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.deepEqual(harness.navigation.replacements, []);

  save(localStorage, workerStatusKey('pvp'), {
    version: 1,
    visitId: '',
    workerId: 'pvp',
    state: 'idle',
    safeToLeave: true,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'running');
  assert.deepEqual(harness.navigation.replacements, [
    'https://demonicscans.org/active_wave.php?gate=3&wave=8',
  ]);
});

test('runtime is reloaded after winning the scheduler lease', () => {
  const initiallyDue = runtimeWithDueWave();
  const updatedRuntime = createDefaultRuntime(NOW);
  updatedRuntime.nextRunAt.pvp = NOW + ROUTES.pvp.intervalMs;
  updatedRuntime.nextRunAt.wave3 = NOW + ROUTES.wave3.intervalMs;
  const backingStorage = configuredStorage({ runtime: initiallyDue });
  let injected = false;
  const localStorage = {
    getItem: (key) => backingStorage.getItem(key),
    removeItem: (key) => backingStorage.removeItem(key),
    setItem(key, value) {
      backingStorage.setItem(key, value);
      if (key === LEASE_KEY && !injected) {
        injected = true;
        save(backingStorage, RUNTIME_KEY, updatedRuntime);
      }
    },
  };

  const harness = runScheduler({ localStorage });

  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit, null);
  assert.deepEqual(harness.navigation.replacements, []);
});

test('the target receives its full visit deadline after a draining hand-off', () => {
  const runtime = createDefaultRuntime(NOW);
  runtime.activeVisit = {
    ...runningVisit('pvp', ROUTES.pvp.path),
    phase: 'draining',
    deadlineAt: NOW + 1,
  };
  const localStorage = configuredStorage({ runtime });
  save(localStorage, COMMAND_KEY, runtime.activeVisit);

  runScheduler({ localStorage });

  const running = read(localStorage, RUNTIME_KEY).activeVisit;
  assert.equal(running.phase, 'running');
  assert.equal(running.deadlineAt, NOW + ROUTES.pvp.maxVisitMs);
});

test('pausing drains a running visit and settles it without navigation once safe', () => {
  const runtime = createDefaultRuntime(NOW);
  const visit = runningVisit('wave3', ROUTES.pvp.path);
  runtime.activeVisit = visit;
  const localStorage = configuredStorage({ runtime });
  save(localStorage, CONFIG_KEY, { ...createDefaultConfig(), enabled: false });
  save(localStorage, COMMAND_KEY, visit);
  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'busy',
    safeToLeave: false,
    updatedAt: NOW,
  });

  const harness = runScheduler({
    href: `https://demonicscans.org/battle.php?id=42&veyra_visit=${visit.visitId}`,
    localStorage,
  });

  assert.equal(read(localStorage, COMMAND_KEY).phase, 'draining');
  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit.visitId, visit.visitId);
  assert.deepEqual(harness.navigation.replacements, []);

  save(localStorage, workerStatusKey('wave3'), {
    version: 1,
    visitId: visit.visitId,
    workerId: 'wave3',
    state: 'idle',
    safeToLeave: true,
    updatedAt: NOW,
  });
  harness.timers.runInterval();

  assert.equal(read(localStorage, RUNTIME_KEY).activeVisit, null);
  assert.equal(localStorage.getItem(COMMAND_KEY), null);
  assert.deepEqual(harness.navigation.replacements, []);
});
