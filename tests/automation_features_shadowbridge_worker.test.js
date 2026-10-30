'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../src/scheduler/engine');
const {
  DAMAGE_URL,
  JOIN_URL,
  attackPlan,
  createShadowbridgeWorker,
  readStamina,
} = require('../src/features/automation/shadowbridge-worker');

const NOW = 1_800_000_000_000;

function element({ text = '', attrs = {}, classes = [], one = {}, many = {}, parent = null } = {}) {
  return {
    textContent: text,
    parentElement: parent,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
    closest() {
      return parent;
    },
  };
}

function documentWith({ one = {}, many = {}, body = null } = {}) {
  return {
    body,
    hidden: false,
    visibilityState: 'visible',
    querySelector(selector) {
      const value = one[selector] ?? many[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = many[selector] ?? one[selector];
      return Array.isArray(value) ? value : value ? [value] : [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function statBlock(label, value, fullText = '') {
  return element({
    text: fullText || `${label} ${value}`,
    one: {
      '.label': element({ text: label }),
      strong: element({ text: value }),
    },
  });
}

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    read(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    write(key, value) {
      values.set(key, structuredClone(value));
      return true;
    },
  };
}

function command(overrides = {}) {
  return {
    version: 1,
    visitId: 'shadow-visit',
    taskId: 'shadowbridge',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 60_000,
    ...overrides,
  };
}

function shadowConfig({ skill = '0', mode = 'max-loot', damage = '1m' } = {}) {
  const config = createDefaultConfig();
  const route = config.routes.shadowbridge;
  for (const target of Object.values(route.settings.monsters)) target.enabled = false;
  route.settings.monsters['talla-flint-stem'] = { enabled: true, mode, damage };
  route.settings.bossRoom.enabled = false;
  route.settings.skill = skill;
  route.settings.attackCooldownMs = 100;
  return config;
}

function createWindow() {
  return {
    location: {
      href: 'https://demonicscans.org/guild_dungeon.php?veyra_route=shadowbridge',
      origin: 'https://demonicscans.org',
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function hubDocument() {
  const card = element({ text: 'Shadowbridge Warrens Enter dungeon' });
  const link = element({ attrs: { href: '/guild_dungeon_enter.php?id=16137' }, parent: card });
  return documentWith({ many: { 'a[href*="guild_dungeon_enter.php"]': [link] } });
}

function instanceDocument() {
  const location = element({
    text: 'Brood Pits',
    attrs: {
      href: '/guild_dungeon_location.php?instance_id=16137&location_id=1',
      title: 'Brood Pits',
    },
  });
  return documentWith({
    one: { title: element({ text: 'Shadowbridge Warrens — Instance #16137' }) },
    many: {
      'a[href*="guild_dungeon_location.php"]': [location],
      'a.pin.locked': [],
    },
  });
}

function locationDocument() {
  const card = element({
    one: {
      '.monster-name, .name': element({ text: 'Talla Flint-Stem' }),
      'a[href*="battle.php"]': element({
        attrs: { href: '/battle.php?dgmid=7001&instance_id=16137' },
      }),
    },
    many: { '.pill': [element({ text: 'not joined' })] },
  });
  return documentWith({ many: { '.mon': [card] } });
}

function battleDocument({ joined = true, ownDamage = 0, includeOwnRow = true, loot = 100, stamina = 1_000 } = {}) {
  const lootChip = element({ text: `DMG req: ${loot}` });
  const playerRow = element({
    one: {
      '.lb-name a': element({ text: 'Player', attrs: { href: '/player.php?pid=159129' } }),
      '.lb-dmg': element({ text: `${ownDamage} DMG` }),
    },
  });
  return documentWith({
    one: {
      '#join-battle': joined ? null : element({ text: 'Join Battle' }),
      '.battle-actions-card': element({ text: joined ? 'Battle actions' : 'Join this battle' }),
      '#hpText': element({ text: '10,000 / 10,000' }),
      '#pHpText': element({ text: '12,000 / 12,000' }),
      '#stamina_span': element({ text: String(stamina) }),
    },
    many: {
      '.stat-block': [statBlock('Monster HP', '10,000')],
      '.loot-card .chip, .loot-stats .chip': [lootChip],
      '.lb-list .lb-row': includeOwnRow ? [playerRow] : [],
      '.potion-card[data-inv-id][data-item-id]': [],
    },
  });
}

function createEnvironment({
  phase = 'running',
  config = shadowConfig(),
  sessionStore = null,
  asterionMultiplier = 1,
  battleDocuments = [battleDocument()],
  post,
} = {}) {
  const store = createStore({
    [COMMAND_KEY]: command({ phase }),
    [CONFIG_KEY]: config,
  });
  const docs = {
    'https://demonicscans.org/guild_dungeon_enter.php?id=16137': instanceDocument(),
    'https://demonicscans.org/guild_dungeon_instance.php?id=16137': instanceDocument(),
    'https://demonicscans.org/guild_dungeon_location.php?instance_id=16137&location_id=1': locationDocument(),
  };
  let battleIndex = 0;
  const fetched = [];
  const posts = [];
  const worker = createShadowbridgeWorker({
    win: createWindow(),
    doc: hubDocument(),
    store,
    sessionStore,
    fetchDocument: async (url) => {
      fetched.push(url);
      if (url === 'https://demonicscans.org/battle.php?dgmid=7001&instance_id=16137') {
        const result = battleDocuments[Math.min(battleIndex, battleDocuments.length - 1)];
        battleIndex += 1;
        return result;
      }
      if (docs[url]) return docs[url];
      throw new Error(`Unexpected GET ${url}`);
    },
    postForm: async (url, params, options) => {
      posts.push({ url, params, options });
      if (post) return post(url, params, posts.length);
      return { ok: true, status: 200, text: 'success', json: { status: 'success', damage: 100, hp: { value: 9_900 } } };
    },
    getUserId: async () => 159129,
    asterionMultiplier,
    sleepImpl: async () => {},
    now: () => NOW,
    logger: null,
  });
  return { fetched, posts, store, worker };
}

test('reads stamina and orders all normal monsters before the dynamic boss room', () => {
  assert.equal(readStamina(documentWith({ one: { '#stamina_span': element({ text: '375 / 1,000' }) } })), 375);
  const settings = shadowConfig().routes.shadowbridge.settings;
  settings.monsters['zorgra-frost-vein'].enabled = true;
  settings.order = ['zorgra-frost-vein', ...settings.order.filter((id) => id !== 'zorgra-frost-vein')];
  const scans = [
    {
      location: { id: '1', instanceId: '1', isBoss: false },
      monsters: [
        { monsterId: 'a', monsterTypeId: 'talla-flint-stem', instanceId: '1', dead: false },
        { monsterId: 'b', monsterTypeId: 'zorgra-frost-vein', instanceId: '1', dead: false },
      ],
    },
    {
      location: { id: '5', instanceId: '1', isBoss: true },
      monsters: [{ monsterId: 'boss', name: 'Goblin King', instanceId: '1', dead: false }],
    },
  ];
  settings.bossRoom.enabled = true;
  assert.deepEqual(attackPlan(scans, settings).map((target) => target.monsterId), ['b', 'a', 'boss']);
});

test('does not fetch or mutate when a different tab owns the scheduler lease', async () => {
  const storeSession = {
    available: true,
    readRaw(key) {
      return key === TAB_KEY ? 'secondary-tab' : null;
    },
  };
  const env = createEnvironment({ sessionStore: storeSession });
  env.store.write(LEASE_KEY, { ownerId: 'primary-tab', leaseUntil: NOW + 30_000 });

  await env.worker.tick();

  assert.equal(env.fetched.length, 0);
  assert.equal(env.posts.length, 0);
  assert.equal(env.store.read(workerStatusKey('shadowbridge')), null);
});

test('honours an immediate drain without entering or attacking the dungeon', async () => {
  const env = createEnvironment({ phase: 'draining' });

  await env.worker.tick();

  const status = env.store.read(workerStatusKey('shadowbridge'));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.equal(env.fetched.length, 0);
  assert.equal(env.posts.length, 0);
});

test('joins, attacks to the live loot limit and sends the base skill cost despite Asterion', async () => {
  const config = shadowConfig({ skill: '-4' });
  const env = createEnvironment({
    config,
    asterionMultiplier: 2,
    battleDocuments: [
      battleDocument({ joined: false, includeOwnRow: false }),
      battleDocument({ joined: true, ownDamage: 0, loot: 100, stamina: 1_000 }),
    ],
    post(url) {
      if (url === JOIN_URL) {
        return { ok: true, status: 200, text: 'You have successfully joined the battle!', json: null };
      }
      return {
        ok: true,
        status: 200,
        text: '',
        json: { status: 'success', damage: 100, hp: { value: 9_900, max: 10_000 } },
      };
    },
  });
  // The effective local stamina check is 400, but F21 requires 200 in the API.
  await env.worker.tick();

  assert.equal(env.posts.length, 2);
  assert.equal(env.posts[0].url, JOIN_URL);
  assert.deepEqual(env.posts[0].params, {
    instance_id: '16137',
    dgmid: '7001',
    user_id: '159129',
  });
  assert.equal(env.posts[1].url, DAMAGE_URL);
  assert.deepEqual(env.posts[1].params, {
    instance_id: '16137',
    dgmid: '7001',
    skill_id: '-4',
    stamina_cost: 200,
  });
  const status = env.store.read(workerStatusKey('shadowbridge'));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.match(status.message, /1 target\(s\).*1 attack\(s\)/);
});

test('fails closed after join when current personal damage is absent from the leaderboard', async () => {
  const env = createEnvironment({
    battleDocuments: [battleDocument({ joined: true, includeOwnRow: false })],
  });

  await env.worker.tick();

  assert.equal(env.posts.length, 0);
  const status = env.store.read(workerStatusKey('shadowbridge'));
  assert.equal(status.state, 'error');
  assert.equal(status.safeToLeave, true);
  assert.match(status.message, /current damage is missing/i);
});
