'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { readCrucibleDebugLog } = require('../src/core/crucible-debug');
const { LEASE_KEY, TAB_KEY } = require('../src/scheduler/engine');
const { CRUCIBLE_PVP_WATCH_KEY } = require('../src/features/automation/crucible-pvp-watch');
const {
  ARMY_ACTION_URL,
  ARMY_LIVE_URL,
  CUBE_ACTION_URL,
  DAMAGE_URL,
  MINIMAL_ARMY_CONTRIBUTIONS_KEY,
  PVP_ACTION_URL,
  SHADOW_ARMY_FORMATION_URL,
  SHADOW_ARMY_URL,
  createCrucibleWorker,
  readStamina,
} = require('../src/features/automation/crucible-worker');

const NOW = 1_800_000_000_000;

function element({ text = '', attrs = {}, classes = [], one = {}, many = {}, parent = null, disabled = false } = {}) {
  return {
    textContent: text,
    parentElement: parent,
    disabled,
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

function scriptDocument(source) {
  return documentWith({ many: { script: [element({ text: source })] } });
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
    remove(key) {
      values.delete(key);
      return true;
    },
  };
}

function command(overrides = {}) {
  return {
    version: 1,
    visitId: 'crucible-visit',
    taskId: 'crucible',
    phase: 'running',
    returnPath: '/pvp.php',
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 60_000,
    ...overrides,
  };
}

function createWindow() {
  return {
    location: {
      href: 'https://demonicscans.org/guild_dungeon.php?veyra_route=crucible',
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
  const card = element({ text: 'The Polyhedral Crucible Enter dungeon' });
  const link = element({ attrs: { href: '/guild_dungeon_enter.php?id=16126' }, parent: card });
  return documentWith({ many: { 'a[href*="guild_dungeon_enter.php"]': [link] } });
}

function cubeDocument(nodes) {
  const state = { nodes };
  return scriptDocument(`const INSTANCE_ID = 16126; const STATE = ${JSON.stringify(state)};`);
}

function createEnvironment({
  config = createDefaultConfig(),
  phase = 'running',
  sessionStore = null,
  fetchDocumentImpl,
  fetchJsonImpl,
  postImpl,
  visitRewardPageImpl,
  getUserId = async () => 159129,
  asterionMultiplier = 1,
} = {}) {
  const store = createStore({
    [COMMAND_KEY]: command({ phase }),
    [CONFIG_KEY]: config,
  });
  const fetched = [];
  const jsonGets = [];
  const posts = [];
  const worker = createCrucibleWorker({
    win: createWindow(),
    doc: hubDocument(),
    store,
    sessionStore,
    fetchDocument: async (url) => {
      fetched.push(url);
      if (!fetchDocumentImpl) throw new Error(`Unexpected GET ${url}`);
      return fetchDocumentImpl(url, fetched.length);
    },
    fetchJson: async (url) => {
      jsonGets.push(url);
      if (!fetchJsonImpl) throw new Error(`Unexpected JSON GET ${url}`);
      return fetchJsonImpl(url, jsonGets.length);
    },
    postForm: async (url, params, options) => {
      posts.push({ url, params, options });
      if (!postImpl) throw new Error(`Unexpected POST ${url}`);
      return postImpl(url, params, posts.length);
    },
    getUserId,
    asterionMultiplier,
    sleepImpl: async () => {},
    now: () => NOW,
    logger: null,
    visitRewardPage: visitRewardPageImpl || (async () => { throw new Error('Unexpected reward page visit'); }),
  });
  return { fetched, jsonGets, posts, store, worker };
}

function disableSections(config, { pve = false, pvp = false, army = false } = {}) {
  const settings = config.routes.crucible.settings;
  settings.pveEnabled = pve;
  settings.pvp.enabled = pvp;
  settings.army.enabled = army;
  return config;
}

test('reads Crucible stamina and never acts without the scheduler lease', async () => {
  assert.equal(readStamina(documentWith({ one: { '#stamina_span': element({ text: '375 / 1,000' }) } })), 375);
  const sessionStore = {
    available: true,
    readRaw(key) {
      return key === TAB_KEY ? 'secondary-tab' : null;
    },
  };
  const config = disableSections(createDefaultConfig(), { pve: true });
  const env = createEnvironment({ config, sessionStore });
  env.store.write(LEASE_KEY, { ownerId: 'primary-tab', leaseUntil: NOW + 60_000 });
  await env.worker.tick();
  assert.deepEqual(env.fetched, []);
  assert.deepEqual(env.posts, []);
  assert.equal(env.store.read(workerStatusKey('crucible')), null);
});

test('a draining visit finishes safely before any page request or mutation', async () => {
  const config = createDefaultConfig();
  config.routes.crucible.settings.debugLogging = true;
  const env = createEnvironment({ phase: 'draining', config });
  await env.worker.tick();
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'done');
  assert.equal(status.safeToLeave, true);
  assert.match(status.message, /stopped safely/i);
  assert.deepEqual(env.fetched, []);
  assert.deepEqual(env.posts, []);
  const events = readCrucibleDebugLog(env.store).entries.map((entry) => entry.event);
  assert.ok(events.includes('worker created'));
  assert.ok(events.includes('terminal state'));
});

function statBlock(label, value, fullText = '') {
  return element({
    text: fullText || `${label} ${value}`,
    one: {
      '.label': element({ text: label }),
      strong: element({ text: value }),
    },
  });
}

function pveLocationDocument(name = 'Prismblade Reaver', monsterId = '7001') {
  const card = element({
    one: {
      '.monster-name, .name': element({ text: name }),
      'a[href*="battle.php"]': element({
        attrs: { href: `/battle.php?dgmid=${monsterId}&instance_id=16126` },
      }),
    },
    many: { '.pill': [element({ text: 'joined' })] },
  });
  return documentWith({ many: { '.mon': [card] } });
}

function pveBattleDocument({ ownDamage = 0, includeOwnRow = true } = {}) {
  const row = element({
    one: {
      '.lb-name a': element({ text: 'Player', attrs: { href: '/player.php?pid=159129' } }),
      '.lb-dmg': element({ text: `${ownDamage} DMG` }),
    },
  });
  return documentWith({
    one: {
      '.battle-actions-card': element({ text: 'Battle actions' }),
      '#hpText': element({ text: '10,000 / 10,000' }),
      '#pHpText': element({ text: '12,000 / 12,000' }),
      '#stamina_span': element({ text: '1,000' }),
    },
    many: {
      '.stat-block': [
        statBlock('Monster HP', '10,000'),
        statBlock('EXP Cap', '', 'EXP Cap Deal ~100 dmg to hit cap'),
      ],
      '.loot-card .chip, .loot-stats .chip': [element({ text: 'DMG req: 50' })],
      '.lb-list .lb-row': includeOwnRow ? [row] : [],
      '.potion-card[data-inv-id][data-item-id]': [],
    },
  });
}

test('PvE reads max EXP live, attacks to it and sends the base stamina cost with Asterion', async () => {
  const config = disableSections(createDefaultConfig(), { pve: true });
  const settings = config.routes.crucible.settings;
  for (const target of Object.values(settings.targets)) target.enabled = false;
  settings.targets['gate_prism:prismblade-reaver'] = { enabled: true, mode: 'max-exp', damage: '1m' };
  settings.skill = '-1';
  const nodes = [
    { id: 2, face_key: 'front', key: 'gate_prism', name: 'Gate Prism', type: 'pve', status: 'available', linked_location_id: 11 },
  ];
  const cube = cubeDocument(nodes);
  const env = createEnvironment({
    config,
    asterionMultiplier: 2,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/guild_dungeon_location\.php/.test(url)) return pveLocationDocument();
      if (/battle\.php/.test(url)) return pveBattleDocument();
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url) => {
      if (url === CUBE_ACTION_URL) {
        return { ok: true, status: 200, json: { ok: true, redirect: '/guild_dungeon_location.php?instance_id=16126&location_id=11' }, text: '' };
      }
      if (url === DAMAGE_URL) {
        return { ok: true, status: 200, json: { status: 'success', damage: 100, hp: { value: 9_900 } }, text: '' };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
  });
  await env.worker.tick();
  assert.equal(env.posts.filter((entry) => entry.url === DAMAGE_URL).length, 1);
  const damagePost = env.posts.find((entry) => entry.url === DAMAGE_URL);
  assert.deepEqual(damagePost.params, {
    instance_id: '16126',
    dgmid: '7001',
    skill_id: '-1',
    stamina_cost: 10,
  });
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'done');
  assert.match(status.message, /1 PvE target.*1 PvE attack/i);
});

test('the available Zenith Lock apex is discovered and attacked with its configured boss mode', async () => {
  const config = disableSections(createDefaultConfig(), { pve: true });
  config.routes.crucible.settings.nodeDefaults.zenith_lock = {
    enabled: true,
    mode: 'kill',
    damage: '1m',
  };
  const cube = cubeDocument([
    { id: 12, face_key: 'top', key: 'zenith_lock', name: 'Zenith Lock', type: 'boss', status: 'available', linked_location_id: 14 },
  ]);
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/guild_dungeon_location\.php/.test(url)) return pveLocationDocument('Apex Calibration Horror', '9001');
      if (/battle\.php/.test(url)) return pveBattleDocument();
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url) => {
      if (url === CUBE_ACTION_URL) {
        return { ok: true, status: 200, json: { ok: true, redirect: '/guild_dungeon_location.php?instance_id=16126&location_id=14' }, text: '' };
      }
      if (url === DAMAGE_URL) {
        return { ok: true, status: 200, json: { status: 'success', damage: 10_000, dead: true, hp: { value: 0 } }, text: '' };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
  });

  await env.worker.tick();
  assert.equal(env.posts.filter((entry) => entry.url === DAMAGE_URL).length, 1);
  assert.equal(env.fetched.some((url) => /location_id=14/.test(url)), true);
  const settings = env.store.read(CONFIG_KEY).routes.crucible.settings;
  assert.deepEqual(settings.targets['zenith_lock:apex-calibration-horror'], {
    enabled: true,
    mode: 'kill',
    damage: '1m',
  });
});

function pvpSlot({ name = '', own = false } = {}) {
  return element({
    one: {
      '.name': name ? element({ text: name }) : null,
      '.selfMark': own ? element({ text: 'YOUR SLOT' }) : null,
    },
  });
}

function pvpCard(matchNo, occupied, own = false, status = 'OPEN') {
  const slots = Array.from({ length: 5 }, (_, index) =>
    index < occupied ? pvpSlot({ name: own && index === 0 ? 'Me' : `Player ${index + 1}`, own: own && index === 0 }) : pvpSlot(),
  );
  return element({
    one: {
      '.meta': element({ text: `Match #${matchNo} / Slots ${occupied}/5` }),
      '.badge': element({ text: status }),
      'a[href*="pvp_style_battle.php"]': element({
        attrs: { href: `/pvp_style_battle.php?source=cube&instance_id=16126&node_id=7&match_no=${matchNo}` },
      }),
    },
    many: { '.slots .slot': slots },
  });
}

function pvpLobbyDocument(own = false) {
  return documentWith({
    many: {
      '.grid > .match': own ? [pvpCard(1, 1), pvpCard(2, 5, true)] : [pvpCard(1, 1), pvpCard(2, 4)],
    },
  });
}

test('PvP claims the fullest match, confirms its slot and publishes a short node recheck', async () => {
  const config = disableSections(createDefaultConfig(), { pvp: true });
  const cube = cubeDocument([
    { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
  ]);
  let lobbyReads = 0;
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/pvp_style_node\.php/.test(url)) {
        lobbyReads += 1;
        return pvpLobbyDocument(lobbyReads > 1);
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    fetchJsonImpl: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, room_status: 'open', room_joined: true, match: { ended: false } },
    }),
    postImpl: async (url) => {
      if (url === PVP_ACTION_URL) return { ok: true, status: 200, json: { ok: true, message: 'Slot claimed' }, text: '' };
      throw new Error(`Unexpected POST ${url}`);
    },
  });
  await env.worker.tick();
  assert.equal(env.posts.length, 1);
  assert.deepEqual(env.posts[0].params, {
    source: 'cube',
    action: 'pick_slot',
    instance_id: '16126',
    node_id: '7',
    match_no: '2',
    slot_index: '5',
  });
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'done');
  assert.equal(status.retryAt, 0);
  assert.match(status.note, /waiting for players/i);
  assert.deepEqual(env.store.read(CRUCIBLE_PVP_WATCH_KEY), {
    version: 1,
    mode: 'match',
    instanceId: '16126',
    nodeId: '7',
    nodeKey: 'ring_ward',
    nodeName: 'Ring Ward',
    matchNo: '2',
    nextCheckAt: NOW + 15_000,
    updatedAt: NOW,
  });
});

test('PvP ignores cleared historical own slots and claims the current fullest open match', async () => {
  const config = disableSections(createDefaultConfig(), { pvp: true });
  const cube = cubeDocument([
    { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
  ]);
  let lobbyReads = 0;
  const historicalLobby = (confirmed) => documentWith({
    many: {
      '.grid > .match': [
        pvpCard(7, 5, true, 'CLEARED'),
        pvpCard(9, 5, true, 'CLEARED'),
        pvpCard(10, 1),
        pvpCard(12, confirmed ? 5 : 4, confirmed),
      ],
    },
  });
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/pvp_style_node\.php/.test(url)) {
        lobbyReads += 1;
        return historicalLobby(lobbyReads > 1);
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    fetchJsonImpl: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, room_status: 'open', room_joined: true, match: { ended: false } },
    }),
    postImpl: async (url) => {
      if (url === PVP_ACTION_URL) return { ok: true, status: 200, json: { ok: true, message: 'Slot claimed' }, text: '' };
      throw new Error(`Unexpected POST ${url}`);
    },
  });

  await env.worker.tick();

  assert.equal(env.posts.length, 1);
  assert.deepEqual(env.posts[0].params, {
    source: 'cube',
    action: 'pick_slot',
    instance_id: '16126',
    node_id: '7',
    match_no: '12',
    slot_index: '5',
  });
  assert.equal(env.store.read(CRUCIBLE_PVP_WATCH_KEY).matchNo, '12');
});

test('a live PvP match is checked once and does not block the Army section', async () => {
  const config = disableSections(createDefaultConfig(), { pvp: true, army: true });
  const cube = cubeDocument([
    { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const emptyArmyNode = scriptDocument('let fightCards = []; let activeMatchNo = 0;');
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/pvp_style_node\.php/.test(url)) return pvpLobbyDocument(true);
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return emptyArmyNode;
      throw new Error(`Unexpected GET ${url}`);
    },
    fetchJsonImpl: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, room_status: 'live', room_joined: true, match: { ended: false } },
    }),
  });

  await env.worker.tick();

  assert.equal(env.jsonGets.length, 1);
  assert.equal(env.fetched.some((url) => /guild_dungeon_cube_army_enter\.php/.test(url)), true);
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'done');
  assert.match(status.note, /match in progress/i);
});

test('a won PvP match is opened in the background so the server grants its reward', async () => {
  const config = disableSections(createDefaultConfig(), { pvp: true });
  const cube = cubeDocument([
    { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
  ]);
  let rewardReads = 0;
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/pvp_style_node\.php/.test(url)) return pvpLobbyDocument(true);
      throw new Error(`Unexpected GET ${url}`);
    },
    visitRewardPageImpl: async (url, expected) => {
      rewardReads += 1;
      assert.match(url, /pvp_style_battle\.php/);
      assert.equal(expected.matchNo, 2);
      return {
        ok: true,
        rewardItems: [{ item_id: 251, qty: 1 }, { item_id: 337, qty: 50 }],
        rewardModalShown: true,
      };
    },
    fetchJsonImpl: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, room_status: 'cleared', room_joined: true, match: { ended: true, winner_side: 'ally' } },
    }),
  });

  await env.worker.tick();

  assert.equal(rewardReads, 1);
  assert.equal(env.fetched.some((url) => /pvp_style_battle\.php/.test(url)), false);
  assert.equal(env.store.read(workerStatusKey('crucible')).state, 'done');
  assert.equal(env.store.read(CRUCIBLE_PVP_WATCH_KEY).mode, 'lobby');
});

test('a PvE section failure does not undo or prevent PvP participation', async () => {
  const config = disableSections(createDefaultConfig(), { pve: true, pvp: true });
  const settings = config.routes.crucible.settings;
  for (const target of Object.values(settings.targets)) target.enabled = false;
  settings.targets['gate_prism:prismblade-reaver'] = { enabled: true, mode: 'max-loot', damage: '1m' };
  const cube = cubeDocument([
    { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
    { id: 2, face_key: 'front', key: 'gate_prism', name: 'Gate Prism', type: 'pve', status: 'available', linked_location_id: 11 },
  ]);
  let lobbyReads = 0;
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/pvp_style_node\.php/.test(url)) {
        lobbyReads += 1;
        return pvpLobbyDocument(lobbyReads > 1);
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    fetchJsonImpl: async () => ({
      ok: true,
      status: 200,
      json: { ok: true, room_status: 'open', room_joined: true, match: { ended: false } },
    }),
    postImpl: async (url) => {
      if (url === PVP_ACTION_URL) {
        return { ok: true, status: 200, json: { ok: true, message: 'Slot claimed' }, text: '' };
      }
      if (url === CUBE_ACTION_URL) {
        return { ok: true, status: 200, json: { ok: false, message: 'Node changed' }, text: '' };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
  });

  await env.worker.tick();

  assert.equal(env.posts[0].url, PVP_ACTION_URL);
  assert.equal(env.posts[0].params.action, 'pick_slot');
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'error');
  assert.equal(status.retryAt, 0);
  assert.match(status.message, /PvE: Entering Gate Prism failed/i);
});

function healDocument(available) {
  const form = element({
    one: {
      'input[name="action"][value="heal_all_units"]': element(),
      'button[type="submit"], button': element({ disabled: !available, attrs: available ? {} : { disabled: '' } }),
    },
  });
  return documentWith({ many: { form: [form] } });
}

function ownedArmyDocumentWithoutHealControl() {
  return scriptDocument(
    `const specialUnits = ${JSON.stringify({
      5588: { shadow_id: 5, title: 'Drakzareth The Tyrant' },
    })};`,
  );
}

function formationDocument({ activeShadowIds = ['5', '3'], locked = false } = {}) {
  const active = new Set(activeShadowIds.map(String));
  return scriptDocument(`window.FormationData = ${JSON.stringify({
    ajaxUrl: '/shadow_army_formation.php',
    formationLocked: locked,
    formationLockedMessage: locked ? 'Formation locked by an active roster.' : '',
    captainLimit: 4,
    captains: {
      5588: { inv_id: 5588, shadow_id: 5, title: 'Drakzareth The Tyrant', in_formation: active.has('5'), dead: false },
      5406: { inv_id: 5406, shadow_id: 3, title: 'Vessir the Sunfang Duelist', in_formation: active.has('3'), dead: false },
    },
    normals: {},
  })};`);
}

function armyState({
  joined = false,
  enemyHp = 200,
  retreated = false,
  turnsActed = 0,
  hasRoster = true,
  canJoin = null,
} = {}) {
  return {
    battle: { id: 51365, status: 'ACTIVE', winner_side: '' },
    viewer: { has_roster: hasRoster, can_join: canJoin === null ? !joined : canJoin },
    captains: [
      ...(joined
        ? [{ id: 101, source_shadow_id: 5, display_name: 'Drakzareth The Tyrant', side: 'ALLY', is_mine: true, is_dead: false, retreat_requested: retreated, turns_acted: turnsActed, squad_current_health: 100, squad_max_health: 100 }]
        : []),
      { id: 201, side: 'ENEMY', is_mine: false, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: enemyHp, squad_max_health: 200 },
    ],
    engagements: [],
  };
}

test('Army heals, joins, verifies one minimal hit and retreats the assigned captain', async () => {
  const config = disableSections(createDefaultConfig(), { army: true });
  config.routes.crucible.settings.army.mode = 'minimal';
  const cube = cubeDocument([
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const armyNode = scriptDocument(
    `let fightCards = ${JSON.stringify([{ match_no: 1, battle_id: 0, status: 'open' }])}; let activeMatchNo = 0;`,
  );
  const live = scriptDocument(
    `const battleId = 51365; const initialState = ${JSON.stringify(armyState({ hasRoster: false, canJoin: true }))};`,
  );
  let healReads = 0;
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return armyNode;
      if (url === SHADOW_ARMY_URL) {
        healReads += 1;
        return healDocument(healReads === 1);
      }
      if (url === SHADOW_ARMY_FORMATION_URL) return formationDocument();
      if (/shadow_army_live_battle\.php/.test(url)) return live;
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url, params) => {
      if (url === SHADOW_ARMY_URL) return { ok: true, status: 200, text: '<html>healed</html>', json: null };
      if (url === ARMY_ACTION_URL) {
        return { ok: true, status: 200, text: '', json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=51365' } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'join_battle') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'assign_target') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, turnsActed: 1 }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'retreat_captain') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, retreated: true, turnsActed: 1 }) } };
      }
      throw new Error(`Unexpected POST ${url} ${params.action || ''}`);
    },
  });
  await env.worker.tick();
  assert.deepEqual(env.posts.map((entry) => [entry.url, entry.params.action]), [
    [SHADOW_ARMY_URL, 'heal_all_units'],
    [ARMY_ACTION_URL, 'enter_fight'],
    [ARMY_LIVE_URL, 'join_battle'],
    [ARMY_LIVE_URL, 'assign_target'],
    [ARMY_LIVE_URL, 'retreat_captain'],
  ]);
  assert.equal(
    env.posts.filter((entry) => entry.url === ARMY_LIVE_URL).every((entry) => entry.params.csrf === ''),
    true,
  );
  assert.deepEqual(env.posts[3].params, {
    action: 'assign_target',
    csrf: '',
    battle_id: '51365',
    attacker_captain_unit_id: '101',
    defender_captain_unit_id: '201',
  });
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'done');
  assert.equal(status.retryAt, 0);
  assert.match(status.note, /contribution complete/i);
  assert.deepEqual(env.store.read(MINIMAL_ARMY_CONTRIBUTIONS_KEY), {
    records: [{ battleId: '51365', captainId: '101', verifiedAt: NOW }],
  });

  const postsBeforeRecheck = env.posts.length;
  env.store.write(COMMAND_KEY, command({ visitId: 'crucible-visit-2' }));
  await env.worker.tick();
  assert.deepEqual(
    env.posts.slice(postsBeforeRecheck).map((entry) => [entry.url, entry.params.action]),
    [[ARMY_ACTION_URL, 'enter_fight']],
  );
  assert.match(env.store.read(workerStatusKey('crucible')).note, /contribution complete/i);
});

test('Army joins when the real Army page omits the heal form because nothing is healable', async () => {
  const config = disableSections(createDefaultConfig(), { army: true });
  config.routes.crucible.settings.army.mode = 'minimal';
  const cube = cubeDocument([
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const armyNode = scriptDocument(
    `let fightCards = ${JSON.stringify([{ match_no: 1, battle_id: 51365, status: 'active' }])}; let activeMatchNo = 1;`,
  );
  const live = scriptDocument(
    `const battleId = 51365; const initialState = ${JSON.stringify(armyState({ joined: true }))};`,
  );
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return armyNode;
      if (url === SHADOW_ARMY_URL) return ownedArmyDocumentWithoutHealControl();
      if (url === SHADOW_ARMY_FORMATION_URL) return formationDocument();
      if (/shadow_army_live_battle\.php/.test(url)) return live;
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url, params) => {
      if (url === ARMY_ACTION_URL) {
        return { ok: true, status: 200, text: '', json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=51365' } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'assign_target') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, turnsActed: 1 }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'retreat_captain') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, retreated: true, turnsActed: 1 }) } };
      }
      throw new Error(`Unexpected POST ${url} ${params.action || ''}`);
    },
  });

  await env.worker.tick();

  assert.equal(env.posts.some((entry) => entry.url === SHADOW_ARMY_URL), false);
  assert.equal(env.posts.some((entry) => entry.url === ARMY_ACTION_URL), true);
  assert.equal(env.posts.some((entry) => entry.params.action === 'assign_target'), true);
  assert.equal(env.store.read(workerStatusKey('crucible')).state, 'done');
});

test('Army creates a missing saved formation and refreshes a stale no-roster battle state', async () => {
  const config = disableSections(createDefaultConfig(), { army: true });
  config.routes.crucible.settings.army.mode = 'minimal';
  config.routes.crucible.settings.army.selectedShadowIds = ['5'];
  const cube = cubeDocument([
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const armyNode = scriptDocument(
    `let fightCards = ${JSON.stringify([{ match_no: 1, battle_id: 51365, status: 'active' }])}; let activeMatchNo = 0;`,
  );
  const staleState = armyState();
  staleState.viewer = { has_roster: false, can_join: false };
  const live = scriptDocument(
    `const battleId = 51365; const initialState = ${JSON.stringify(staleState)};`,
  );
  let formationSaved = false;
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return armyNode;
      if (url === SHADOW_ARMY_URL) return healDocument(false);
      if (url === SHADOW_ARMY_FORMATION_URL) {
        return formationDocument({ activeShadowIds: formationSaved ? ['5'] : [] });
      }
      if (/shadow_army_live_battle\.php/.test(url)) return live;
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url, params) => {
      if (url === SHADOW_ARMY_FORMATION_URL && params.action === 'set_captain') {
        formationSaved = true;
        return { ok: true, status: 200, text: '', json: { ok: true } };
      }
      if (url === ARMY_ACTION_URL) {
        return { ok: true, status: 200, text: '', json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=51365' } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'get_state') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState() } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'join_battle') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'assign_target') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, turnsActed: 1 }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'retreat_captain') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 190, retreated: true, turnsActed: 1 }) } };
      }
      throw new Error(`Unexpected POST ${url} ${params.action || ''}`);
    },
  });

  await env.worker.tick();

  assert.deepEqual(env.posts.map((entry) => [entry.url, entry.params.action]), [
    [SHADOW_ARMY_FORMATION_URL, 'set_captain'],
    [ARMY_ACTION_URL, 'enter_fight'],
    [ARMY_LIVE_URL, 'get_state'],
    [ARMY_LIVE_URL, 'join_battle'],
    [ARMY_LIVE_URL, 'assign_target'],
    [ARMY_LIVE_URL, 'retreat_captain'],
  ]);
  assert.deepEqual(env.posts[0].params, { action: 'set_captain', unit_inv_id: '5588' });
  assert.equal(env.store.read(workerStatusKey('crucible')).state, 'done');
});

test('Army retreats unselected Shadows and assigns only the selected formation captain', async () => {
  const config = disableSections(createDefaultConfig(), { army: true });
  config.routes.crucible.settings.army.mode = 'minimal';
  config.routes.crucible.settings.army.selectedShadowIds = ['3'];
  const cube = cubeDocument([
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const armyNode = scriptDocument(
    `let fightCards = ${JSON.stringify([{ match_no: 1, battle_id: 0, status: 'open' }])}; let activeMatchNo = 0;`,
  );
  const live = scriptDocument(
    `const battleId = 51366; const initialState = ${JSON.stringify(armyState())};`,
  );
  const selectedState = ({ drakRetreated = false, vessirTurns = 0, vessirRetreated = false, enemyHp = 200 } = {}) => ({
    battle: { id: 51366, status: 'ACTIVE', winner_side: '' },
    viewer: { has_roster: true, can_join: false },
    captains: [
      { id: 101, source_shadow_id: 5, display_name: 'Drakzareth The Tyrant', side: 'ALLY', is_mine: true, is_dead: false, retreat_requested: drakRetreated, turns_acted: 0, squad_current_health: 100, squad_max_health: 100 },
      { id: 102, source_shadow_id: 3, display_name: 'Vessir the Sunfang Duelist', side: 'ALLY', is_mine: true, is_dead: false, retreat_requested: vessirRetreated, turns_acted: vessirTurns, squad_current_health: 100, squad_max_health: 100 },
      { id: 201, side: 'ENEMY', is_mine: false, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: enemyHp, squad_max_health: 200 },
    ],
    engagements: [],
  });
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return armyNode;
      if (url === SHADOW_ARMY_URL) return healDocument(false);
      if (url === SHADOW_ARMY_FORMATION_URL) return formationDocument();
      if (/shadow_army_live_battle\.php/.test(url)) return live;
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url, params) => {
      if (url === ARMY_ACTION_URL) {
        return { ok: true, status: 200, text: '', json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=51366' } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'join_battle') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: selectedState() } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'retreat_captain' && params.captain_unit_id === '101') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: selectedState({ drakRetreated: true }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'assign_target') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: selectedState({ drakRetreated: true, vessirTurns: 1, enemyHp: 190 }) } };
      }
      if (url === ARMY_LIVE_URL && params.action === 'retreat_captain' && params.captain_unit_id === '102') {
        return { ok: true, status: 200, text: '', json: { ok: true, state: selectedState({ drakRetreated: true, vessirTurns: 1, vessirRetreated: true, enemyHp: 190 }) } };
      }
      throw new Error(`Unexpected POST ${url} ${params.action || ''}`);
    },
  });

  await env.worker.tick();
  assert.deepEqual(
    env.posts.filter((entry) => entry.url === ARMY_LIVE_URL).map((entry) => [entry.params.action, entry.params.captain_unit_id || entry.params.attacker_captain_unit_id || '']),
    [
      ['join_battle', ''],
      ['retreat_captain', '101'],
      ['assign_target', '102'],
      ['retreat_captain', '102'],
    ],
  );
  assert.equal(env.store.read(workerStatusKey('crucible')).state, 'done');
});

test('Army minimal mode never retreats on another player\'s damage', async () => {
  const config = disableSections(createDefaultConfig(), { army: true });
  config.routes.crucible.settings.army.mode = 'minimal';
  const cube = cubeDocument([
    { id: 5, key: 'veil_post', name: 'Veil Post', type: 'army', status: 'in_progress' },
  ]);
  const armyNode = scriptDocument(
    `let fightCards = ${JSON.stringify([{ match_no: 1, battle_id: 51365, status: 'active' }])}; let activeMatchNo = 1;`,
  );
  const live = scriptDocument(
    `const battleId = 51365; const initialState = ${JSON.stringify(armyState({ joined: true }))};`,
  );
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url) && !/army_enter/.test(url)) return cube;
      if (/guild_dungeon_cube_army_enter\.php/.test(url)) return armyNode;
      if (url === SHADOW_ARMY_URL) return healDocument(false);
      if (url === SHADOW_ARMY_FORMATION_URL) return formationDocument();
      if (/shadow_army_live_battle\.php/.test(url)) return live;
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url, params) => {
      if (url === ARMY_ACTION_URL) {
        return { ok: true, status: 200, text: '', json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=51365' } };
      }
      if (url === ARMY_LIVE_URL && ['assign_target', 'get_state'].includes(params.action)) {
        return { ok: true, status: 200, text: '', json: { ok: true, state: armyState({ joined: true, enemyHp: 150 }) } };
      }
      throw new Error(`Unexpected POST ${url} ${params.action || ''}`);
    },
  });

  await env.worker.tick();
  assert.equal(env.posts.some((entry) => entry.params.action === 'retreat_captain'), false);
  assert.equal(env.store.read(workerStatusKey('crucible')).state, 'error');
});

test('PvE fails closed when the personal leaderboard row is missing', async () => {
  const config = disableSections(createDefaultConfig(), { pve: true });
  const settings = config.routes.crucible.settings;
  for (const target of Object.values(settings.targets)) target.enabled = false;
  settings.targets['gate_prism:prismblade-reaver'] = { enabled: true, mode: 'max-loot', damage: '1m' };
  const cube = cubeDocument([
    { id: 2, face_key: 'front', key: 'gate_prism', name: 'Gate Prism', type: 'pve', status: 'available', linked_location_id: 11 },
  ]);
  const env = createEnvironment({
    config,
    fetchDocumentImpl: async (url) => {
      if (/guild_dungeon_(?:enter|cube)\.php/.test(url)) return cube;
      if (/guild_dungeon_location\.php/.test(url)) return pveLocationDocument();
      if (/battle\.php/.test(url)) return pveBattleDocument({ includeOwnRow: false });
      throw new Error(`Unexpected GET ${url}`);
    },
    postImpl: async (url) => {
      if (url === CUBE_ACTION_URL) {
        return { ok: true, status: 200, json: { ok: true, redirect: '/guild_dungeon_location.php?instance_id=16126&location_id=11' }, text: '' };
      }
      throw new Error('No combat mutation expected');
    },
  });
  await env.worker.tick();
  assert.deepEqual(env.posts.map((entry) => entry.url), [CUBE_ACTION_URL]);
  const status = env.store.read(workerStatusKey('crucible'));
  assert.equal(status.state, 'error');
  assert.match(status.message, /current damage is missing/i);
});
