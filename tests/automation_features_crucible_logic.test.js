'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../src/features/automation/crucible-logic');

function element({ text = '', attrs = {}, one = {}, many = {}, parent = null, disabled = false } = {}) {
  return {
    textContent: text,
    parentElement: parent,
    disabled,
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

function documentWith({ one = {}, many = {} } = {}) {
  return {
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

test('finds the dynamic Crucible hub entry without selecting another dungeon', () => {
  const selector = 'a[href*="guild_dungeon_enter.php"]';
  const panelLinks = [];
  const sharedPanel = element({
    text: 'Shadowbridge Warrens The Polyhedral Crucible',
    many: { [selector]: panelLinks },
  });
  const otherLinks = [];
  const crucibleLinks = [];
  const otherCard = element({ text: 'Shadowbridge Warrens', parent: sharedPanel, many: { [selector]: otherLinks } });
  const crucibleCard = element({
    text: 'The Polyhedral Crucible Enter dungeon',
    parent: sharedPanel,
    many: { [selector]: crucibleLinks },
  });
  const otherLink = element({ attrs: { href: '/guild_dungeon_enter.php?id=12' }, parent: otherCard });
  const crucibleLink = element({ attrs: { href: '/guild_dungeon_enter.php?id=16126' }, parent: crucibleCard });
  otherLinks.push(otherLink);
  crucibleLinks.push(crucibleLink);
  panelLinks.push(otherLink, crucibleLink);
  const doc = documentWith({
    many: {
      [selector]: [otherLink, crucibleLink],
    },
  });
  assert.deepEqual(logic.parseHubEntry(doc), {
    instanceId: '16126',
    url: 'https://demonicscans.org/guild_dungeon_enter.php?id=16126',
  });
});

test('extracts balanced inline JSON without executing page script and normalizes cube nodes', () => {
  const state = {
    note: 'a string containing } and [ brackets',
    nodes: [
      { id: 2, key: 'gate_prism', name: 'Gate Prism', type: 'pve', status: 'available', linked_location_id: 11 },
      { id: 7, key: 'ring_ward', name: 'Ring Ward', type: 'pvp', status: 'in_progress' },
      { id: 6, key: 'captain_spine', name: 'Captain Spine', type: 'army', status: 'hidden' },
    ],
  };
  const script = element({
    text: `const INSTANCE_ID = 16126; const STATE = ${JSON.stringify(state)}; throw new Error('must not run');`,
  });
  const doc = documentWith({ many: { script: [script] } });
  assert.deepEqual(logic.extractAssignedJson(doc, 'STATE'), state);
  const cube = logic.parseCubePage(doc, 'https://demonicscans.org/guild_dungeon_cube.php');
  assert.equal(cube.instanceId, '16126');
  assert.deepEqual(logic.actionableNodes(cube).map((node) => node.key), ['gate_prism', 'ring_ward']);
  assert.equal(cube.nodes[0].linkedLocationId, '11');
});

test('builds a confirmed Cube node entry and rejects cross-origin or mismatched redirects', () => {
  assert.deepEqual(logic.buildCubeNodeEnterPayload({ instanceId: 16126, nodeId: 12, faceKey: 'top' }), {
    action: 'enter_node',
    instance_id: '16126',
    node_id: '12',
    face_key: 'top',
  });
  const expected = { instanceId: '16126', locationId: '14' };
  assert.equal(logic.parseCubeNodeEnterResponse({
    ok: true,
    json: { ok: true, redirect: '/guild_dungeon_location.php?instance_id=16126&location_id=14' },
  }, expected).ok, true);
  assert.equal(logic.parseCubeNodeEnterResponse({
    ok: true,
    json: { ok: true, redirect: 'https://evil.example/guild_dungeon_location.php?instance_id=16126&location_id=14' },
  }, expected).ok, false);
  assert.equal(logic.parseCubeNodeEnterResponse({
    ok: true,
    json: { ok: true, redirect: '/guild_dungeon_location.php?instance_id=16126&location_id=13' },
  }, expected).ok, false);
});

test('discovers PvE monster identities per node instead of guessing Crown Lens names', () => {
  const crown = logic.nodeForLocationId('13');
  assert.equal(crown.id, 'crown_lens');
  assert.deepEqual(
    logic.discoverPveMonsters(crown, [
      { name: '  Unknown Crown Horror ' },
      { name: 'Unknown Crown Horror' },
      { name: 'Second Horror' },
    ]),
    [
      { id: 'crown_lens:unknown-crown-horror', nodeId: 'crown_lens', name: 'Unknown Crown Horror' },
      { id: 'crown_lens:second-horror', nodeId: 'crown_lens', name: 'Second Horror' },
    ],
  );
});

function pvpSlot(index, { name = '', own = false } = {}) {
  return element({
    one: {
      '.name': name ? element({ text: name }) : null,
      '.selfMark': own ? element({ text: 'YOUR SLOT' }) : null,
    },
    attrs: { 'data-index': String(index) },
  });
}

function pvpCard(matchNo, occupied, { status = 'OPEN', own = false, elite = false } = {}) {
  const slots = [
    pvpSlot(1, occupied >= 1 ? { name: own ? 'Me' : 'One', own } : {}),
    pvpSlot(2, occupied >= 2 ? { name: 'Two' } : {}),
    pvpSlot(3, occupied >= 3 ? { name: 'Three' } : {}),
    pvpSlot(4, occupied >= 4 ? { name: 'Four' } : {}),
    pvpSlot(5, occupied >= 5 ? { name: 'Five' } : {}),
  ];
  return element({
    one: {
      '.meta': element({ text: `Match #${matchNo} / Slots ${occupied}/5 Waiting` }),
      'a[href*="pvp_style_battle.php"]': element({
        attrs: { href: `/pvp_style_battle.php?source=cube&instance_id=16126&node_id=8&match_no=${matchNo}` },
      }),
    },
    many: {
      '.slots .slot': slots,
      '.badge': elite ? [element({ text: 'Elite Team' }), element({ text: status })] : [element({ text: status })],
    },
  });
}

test('uses an existing PvP slot, otherwise chooses the fullest open match and exact empty slot', () => {
  const existingDoc = documentWith({
    one: { '.warn': element({ text: 'You are currently committed to match #2 for about 01:59:55 more.' }) },
    many: { '.grid > .match': [pvpCard(1, 5, { status: 'CLEARED' }), pvpCard(2, 2, { own: true })] },
  });
  const existingLobby = logic.parsePvpLobby(existingDoc, 'https://demonicscans.org/pvp_style_node.php');
  assert.equal(existingLobby.waitMs, 7_195_000);
  assert.equal(logic.choosePvpAction(existingLobby).match.matchNo, 2);

  const openDoc = documentWith({
    many: { '.grid > .match': [pvpCard(3, 1), pvpCard(4, 4), pvpCard(5, 3)] },
  });
  const choice = logic.choosePvpAction(logic.parsePvpLobby(openDoc));
  assert.deepEqual({ kind: choice.kind, matchNo: choice.match.matchNo, slotIndex: choice.slotIndex }, {
    kind: 'claim',
    matchNo: 4,
    slotIndex: 5,
  });
  assert.deepEqual(
    logic.buildPvpClaimPayload({ instanceId: 16126, nodeId: 8, matchNo: 4, slotIndex: 5 }),
    {
      source: 'cube',
      action: 'pick_slot',
      instance_id: '16126',
      node_id: '8',
      match_no: '4',
      slot_index: '5',
    },
  );

  const eliteChoice = logic.choosePvpAction(
    logic.parsePvpLobby(documentWith({ many: { '.grid > .match': [pvpCard(6, 4, { elite: true })] } })),
  );
  assert.equal(eliteChoice.kind, 'claim');
  assert.equal(eliteChoice.match.status, 'open');
});

test('ignores historical cleared own slots and joins the fullest current open PvP match', () => {
  const lobby = logic.parsePvpLobby(documentWith({
    many: {
      '.grid > .match': [
        pvpCard(7, 5, { status: 'CLEARED', own: true }),
        pvpCard(9, 5, { status: 'CLEARED', own: true }),
        pvpCard(10, 1),
        pvpCard(11, 0),
        pvpCard(12, 4),
      ],
    },
  }));

  const choice = logic.choosePvpAction(lobby);
  assert.deepEqual(
    { kind: choice.kind, matchNo: choice.match.matchNo, slotIndex: choice.slotIndex },
    { kind: 'claim', matchNo: 12, slotIndex: 5 },
  );
});

test('requires semantic success from PvP responses and identifies a finished ally win', () => {
  assert.equal(logic.parsePvpClaimResponse({ ok: true, json: { ok: true, message: 'Slot claimed' } }).ok, true);
  assert.equal(logic.parsePvpClaimResponse({ ok: true, text: '<html>Login</html>', json: null }).ok, false);
  assert.deepEqual(
    logic.parsePvpState({ ok: true, json: { ok: true, room_status: 'cleared', match: { ended: true, winner_side: 'ally' } } }),
    {
      ok: true,
      ended: true,
      won: true,
      roomStatus: 'cleared',
      winnerSide: 'ally',
      roomJoined: false,
      raw: { ok: true, room_status: 'cleared', match: { ended: true, winner_side: 'ally' } },
    },
  );
  assert.equal(logic.parsePvpState({ ok: true, json: { ok: false, error: 'expired' } }).ok, false);
});

test('builds and verifies the exact won PvP battle page used to collect rewards', () => {
  const expected = { instanceId: 16126, nodeId: 8, matchNo: 2 };
  assert.equal(
    logic.buildPvpBattleUrl('https://demonicscans.org/elsewhere', expected),
    'https://demonicscans.org/pvp_style_battle.php?source=cube&instance_id=16126&node_id=8&match_no=2',
  );
  const doc = documentWith({
    many: {
      script: [element({
        text: `const SOURCE_PARAMS = {"instance_id":"16126","node_id":"8","match_no":"2"};
          const ROOM_STATUS = "cleared";
          const PVP_REWARD_ITEMS = [{"item_id":337,"qty":50,"name":"Crucible Sigil"}];`,
      })],
    },
  });
  const page = logic.parsePvpBattlePage(doc, expected);
  assert.equal(page.ok, true);
  assert.equal(page.rewardItems.length, 1);
  assert.equal(logic.parsePvpBattlePage(doc, { ...expected, matchNo: 3 }).ok, false);
  assert.equal(logic.buildPvpBattleUrl('https://demonicscans.org', { ...expected, matchNo: 'bad' }), '');

  const waitingDoc = documentWith({
    many: {
      script: [element({
        text: `const SOURCE_PARAMS = {"instance_id":"16126","node_id":"8","match_no":"2"};
          const ROOM_STATUS = "open";
          const PVP_REWARD_ITEMS = [{"item_id":337,"qty":35}];`,
      })],
    },
  });
  assert.equal(logic.parsePvpBattlePage(waitingDoc, expected).ok, false);
});

test('parses Army fight cards, prioritizes the current live fight and validates its redirect', () => {
  const cards = [
    { match_no: 1, battle_id: 10, status: 'cleared' },
    { match_no: 2, battle_id: 20, status: 'active' },
    { match_no: 3, battle_id: 0, status: 'open' },
  ];
  const doc = documentWith({
    many: {
      script: [element({ text: `let fightCards = ${JSON.stringify(cards)}; let activeMatchNo = 2;` })],
    },
  });
  const page = logic.parseArmyNodePage(doc);
  assert.equal(logic.chooseArmyFight(page).matchNo, 2);
  assert.deepEqual(logic.buildArmyEnterPayload({ instanceId: 16126, nodeId: 6, matchNo: 2 }), {
    action: 'enter_fight',
    instance_id: '16126',
    node_id: '6',
    match_no: '2',
  });
  assert.equal(
    logic.parseArmyEnterResponse({ ok: true, json: { ok: true, redirect: '/shadow_army_live_battle.php?battle_id=20' } }).ok,
    true,
  );
  assert.equal(
    logic.parseArmyEnterResponse({
      ok: true,
      json: { ok: true, redirect: 'https://evil.example/shadow_army_live_battle.php?battle_id=20' },
    }).ok,
    false,
  );
});

function armyState(overrides = {}) {
  return {
    battle: { id: 51365, status: 'ACTIVE', winner_side: '' },
    viewer: { has_roster: true, can_join: false },
    captains: [
      { id: 101, source_shadow_id: 5, side: 'ALLY', is_mine: true, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: 100, squad_max_health: 100 },
      { id: 102, source_shadow_id: 3, side: 'ALLY', is_mine: true, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: 100, squad_max_health: 100 },
      { id: 201, side: 'ENEMY', is_mine: false, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: 200, squad_max_health: 200 },
      { id: 202, side: 'ENEMY', is_mine: false, is_dead: false, retreat_requested: false, turns_acted: 0, squad_current_health: 200, squad_max_health: 200 },
    ],
    engagements: [],
    ...overrides,
  };
}

test('plans Army assignments and requires a personal turn plus enemy health loss before retreat', () => {
  const initial = armyState();
  assert.deepEqual(logic.planArmyActions(initial, 'minimal').commands, [
    { action: 'assign', attackerId: 101, defenderId: 201 },
  ]);
  assert.deepEqual(logic.planArmyActions(initial, 'kill').commands, [
    { action: 'assign', attackerId: 101, defenderId: 201 },
    { action: 'assign', attackerId: 102, defenderId: 202 },
  ]);
  assert.deepEqual(logic.planArmyActions(initial, 'minimal', ['3']).commands, [
    { action: 'assign', attackerId: 102, defenderId: 201 },
  ]);
  assert.match(logic.planArmyActions(initial, 'kill', []).error, /no Shadow is selected/i);
  const after = armyState();
  after.captains.find((captain) => captain.id === 201).squad_current_health = 175;
  assert.equal(logic.hasVerifiedArmyHit(initial, after, 101, 201), false);
  after.captains.find((captain) => captain.id === 101).turns_acted = 1;
  assert.equal(logic.hasVerifiedArmyHit(initial, after, 101, 201), true);
  assert.equal(logic.hasVerifiedArmyHit(initial, after, 102, 201), false);
  assert.deepEqual(logic.buildArmyLivePayload('assign_target', { battleId: 51365, attackerId: 101, defenderId: 201 }), {
    action: 'assign_target',
    csrf: '',
    battle_id: '51365',
    attacker_captain_unit_id: '101',
    defender_captain_unit_id: '201',
  });
  assert.deepEqual(logic.buildArmyLivePayload('retreat_captain', { battleId: 51365, captainId: 101 }), {
    action: 'retreat_captain',
    csrf: '',
    battle_id: '51365',
    captain_unit_id: '101',
  });
});

test('parses live Army state and only enables heal-all when the form button is usable', () => {
  const state = armyState();
  const liveDoc = documentWith({
    many: { script: [element({ text: `const battleId = 51365; const initialState = ${JSON.stringify(state)};` })] },
  });
  assert.equal(logic.parseArmyLivePage(liveDoc).battleId, '51365');
  assert.equal(logic.parseArmyLivePage(liveDoc).state.captains.length, 4);

  const healForm = element({
    one: {
      'input[name="action"][value="heal_all_units"]': element(),
      'button[type="submit"], button': element({ disabled: false }),
    },
  });
  assert.deepEqual(logic.parseArmyHealAvailability(documentWith({ many: { form: [healForm] } })), {
    found: true,
    available: true,
  });
  const disabledForm = element({
    one: {
      'input[name="action"][value="heal_all_units"]': element(),
      'button[type="submit"], button': element({ disabled: true }),
    },
  });
  assert.deepEqual(logic.parseArmyHealAvailability(documentWith({ many: { form: [disabledForm] } })), {
    found: true,
    available: false,
  });
});

test('discovers owned special Shadows from inert page JSON', () => {
  const doc = documentWith({
    many: {
      script: [element({
        text: `const specialUnits = ${JSON.stringify({
          5588: { shadow_id: 5, title: 'Drakzareth The Tyrant' },
          5406: { shadow_id: 3, title: 'Vessir the Sunfang Duelist' },
          broken: { shadow_id: 0, title: 'Invalid' },
        })};`,
      })],
    },
  });
  assert.deepEqual(logic.parseOwnedArmyShadows(doc), [
    { id: '5', name: 'Drakzareth The Tyrant' },
    { id: '3', name: 'Vessir the Sunfang Duelist' },
  ]);
});

test('reads the real window.FormationData contract and builds a captain mutation', () => {
  const doc = documentWith({
    many: {
      script: [element({
        text: `window.FormationData = {
          formationLocked: false,
          formationLockedMessage: "Formation locked.",
          captainLimit: 4,
          captains: ${JSON.stringify({
            5588: { inv_id: 5588, shadow_id: 5, title: 'Drakzareth The Tyrant', in_formation: true, dead: false },
            5408: { inv_id: 5408, shadow_id: 4, title: 'Hrazz the Dawnflame Oathkeeper', in_formation: false, dead: false },
          })}
        };`,
      })],
    },
  });
  assert.deepEqual(logic.parseArmyFormationPage(doc), {
    found: true,
    locked: false,
    lockedMessage: 'Formation locked.',
    captainLimit: 4,
    captains: [
      { inventoryId: '5408', shadowId: '4', name: 'Hrazz the Dawnflame Oathkeeper', inFormation: false, dead: false },
      { inventoryId: '5588', shadowId: '5', name: 'Drakzareth The Tyrant', inFormation: true, dead: false },
    ],
  });
  assert.deepEqual(logic.buildArmyFormationPayload('set_captain', { inventoryId: 5408 }), {
    action: 'set_captain',
    unit_inv_id: '5408',
  });
  assert.equal(logic.parseArmyFormationActionResponse({ ok: true, json: { ok: true } }).ok, true);
});
