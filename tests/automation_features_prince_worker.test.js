'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMAND_KEY, workerStatusKey } = require('../src/core/protocol');
const { CONFIG_KEY, createDefaultConfig } = require('../src/scheduler/config');
const { attackPlan, createPrinceWorker } = require('../src/features/automation/prince-worker');

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

function createStore(initial) {
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

function hubDocument() {
  const wrongCard = element({ text: 'Shadowbridge Warrens Instance #1' });
  const castleCard = element({ text: 'Castle of the Fallen Prince Instance #98765' });
  const wrong = element({ attrs: { href: '/guild_dungeon_enter.php?id=1' }, parent: wrongCard });
  const castle = element({ attrs: { href: '/guild_dungeon_enter.php?id=98765' }, parent: castleCard });
  return documentWith({ many: { 'a[href*="guild_dungeon_enter.php"]': [wrong, castle] } });
}

function instanceDocument() {
  const location = element({
    text: "The Vizier's Conspiracy Hall — 0/1",
    attrs: {
      href: '/guild_dungeon_location.php?instance_id=98765&location_id=6',
      title: "The Vizier's Conspiracy Hall",
    },
  });
  return documentWith({
    one: { title: element({ text: 'Castle of the Fallen Prince — Instance #98765' }) },
    many: { 'a[href*="guild_dungeon_location.php"]': [location], 'a.pin.locked': [] },
  });
}

function locationDocument() {
  const card = element({
    one: {
      '.monster-name, .name': element({ text: 'A Newly Rolled Royal Vizier' }),
      'a[href*="battle.php"]': element({
        attrs: { href: '/battle.php?dgmid=555001&instance_id=98765' },
      }),
    },
    many: { '.pill': [element({ text: 'not joined' })] },
  });
  return documentWith({ many: { '.mon': [card] } });
}

function healingPotion({ invId = 'hp-1', quantity = 3 } = {}) {
  return element({
    attrs: { 'data-inv-id': invId, 'data-item-id': '108' },
    one: {
      '.potion-use-btn': element({
        attrs: { 'data-name': 'Full HP Potion', 'data-max': String(quantity) },
      }),
      '.potion-qty-left': element({ text: String(quantity) }),
      '.potion-name': element({ text: 'Full HP Potion' }),
    },
  });
}

function battleDocument({
  joined,
  ownDamage = 0,
  playerHp = 10_000,
  playerMaxHp = 10_000,
  potions = [],
}) {
  const row = element({
    one: {
      '.lb-name a': element({ attrs: { href: '/player.php?pid=159129' } }),
      '.lb-dmg': element({ text: `${ownDamage} DMG` }),
    },
  });
  return documentWith({
    one: {
      '#join-battle': joined ? null : element({ text: 'Join battle' }),
      '.battle-actions-card': element({ text: joined ? 'Battle actions' : 'Join this battle' }),
      '#hpText': element({ text: '900 / 1,000' }),
      '#pHpText': element({ text: `${playerHp} / ${playerMaxHp}` }),
      '#stamina_span': element({ text: '1,000' }),
    },
    many: {
      '.stat-block': [],
      '.loot-card .chip, .loot-stats .chip': [],
      '.lb-list .lb-row': joined ? [row] : [],
      '.potion-card[data-inv-id][data-item-id]': potions,
    },
  });
}

test('Castle plan uses rooms rather than fixed monster or instance ids', () => {
  const config = createDefaultConfig().routes.prince.settings;
  const scans = [{
    location: { label: 'Room of Beasts — 0/1', instanceId: '42' },
    monsters: [{ monsterId: 'random-700', instanceId: '42', name: 'Random Beast', dead: false }],
  }];
  const plan = attackPlan(scans, config);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].targetId, 'beasts-room');
  assert.equal(plan[0].monsterId, 'random-700');
});

test('Castle worker joins, heals at zero player HP and reaches live maximum HP damage', async () => {
  const config = createDefaultConfig();
  for (const target of Object.values(config.routes.prince.settings.targets)) target.enabled = false;
  config.routes.prince.settings.targets['vizier-hall'].enabled = true;
  config.routes.prince.potions.heal = [108];
  const store = createStore({
    [COMMAND_KEY]: {
      version: 1,
      visitId: 'prince-visit',
      taskId: 'prince',
      phase: 'running',
      returnPath: '/pvp.php',
      issuedAt: NOW - 1000,
      deadlineAt: NOW + 60_000,
    },
    [CONFIG_KEY]: config,
  });
  const docs = {
    'https://demonicscans.org/guild_dungeon_enter.php?id=98765': instanceDocument(),
    'https://demonicscans.org/guild_dungeon_instance.php?id=98765': instanceDocument(),
    'https://demonicscans.org/guild_dungeon_location.php?instance_id=98765&location_id=6': locationDocument(),
  };
  const posts = [];
  let battleReads = 0;
  const worker = createPrinceWorker({
    win: {
      location: {
        href: 'https://demonicscans.org/guild_dungeon.php?veyra_route=prince',
        origin: 'https://demonicscans.org',
      },
      setInterval() { return 1; },
      clearInterval() {},
      addEventListener() {},
      removeEventListener() {},
    },
    doc: hubDocument(),
    store,
    fetchDocument: async (url) => {
      if (url === 'https://demonicscans.org/battle.php?dgmid=555001&instance_id=98765') {
        battleReads += 1;
        return battleDocument({
          joined: battleReads > 1,
          ownDamage: battleReads > 1 ? 200 : 0,
          playerHp: battleReads > 1 ? 0 : 10_000,
          potions: battleReads > 1 ? [healingPotion({ invId: 'hp-prince' })] : [],
        });
      }
      if (docs[url]) return docs[url];
      throw new Error(`Unexpected GET ${url}`);
    },
    postForm: async (url, params) => {
      posts.push({ url, params });
      if (url === '/dungeon_join_battle.php') {
        return { ok: true, status: 200, text: 'You have successfully joined the battle!', json: null };
      }
      if (url === 'user_heal_potion.php') {
        return { ok: true, status: 200, text: 'success', json: null };
      }
      return {
        ok: true,
        status: 200,
        text: '',
        json: { status: 'success', damage: 800, hp: { value: 100, max: 1000 } },
      };
    },
    getUserId: async () => 159129,
    sleepImpl: async () => {},
    now: () => NOW,
    logger: null,
  });

  await worker.tick();

  assert.deepEqual(posts, [
    {
      url: '/dungeon_join_battle.php',
      params: { instance_id: '98765', dgmid: '555001', user_id: '159129' },
    },
    {
      url: 'user_heal_potion.php',
      params: { inv_id: 'hp-prince', qty: undefined },
    },
    {
      url: '/damage.php',
      params: { instance_id: '98765', dgmid: '555001', skill_id: '0', stamina_cost: 1 },
    },
  ]);
  const status = store.read(workerStatusKey('prince'));
  assert.equal(status.state, 'done', status.message);
  assert.match(status.message, /1 target\(s\).*1 attack\(s\)/);
  assert.equal(
    store.read(CONFIG_KEY).routes.prince.settings.discoveredNames['vizier-hall'],
    'A Newly Rolled Royal Vizier',
  );
  const progress = worker.statusView.snapshot().entries[0];
  assert.equal(progress.targetDamage, 1000);
  assert.equal(progress.currentDamage, 1000);
});
