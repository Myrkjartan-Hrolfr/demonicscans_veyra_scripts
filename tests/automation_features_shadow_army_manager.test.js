'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const manager = require('../src/features/general/shadow-army-manager');

function pageDocument(source) {
  return {
    querySelectorAll(selector) {
      return selector === 'script' ? [{ textContent: source }] : [];
    },
  };
}

const SOURCE = `
  const specialUnits = {
    "5":{"inv_id":5,"title":"Elite Five","image":"elite.webp","rank":"Elite Grade","level":12,"max_level":300,"stars":3,"stars_text":"★★★","copies_needed":8,"extra_copies":9,"can_star_up":true}
  };
  const normalUnits = {
    "10":{"inv_id":10,"title":"Raised Guardian","image":"normal.webp","level":8,"max_level":80,"stars":1,"stars_text":"★","copies_needed":2,"can_star_up":true,"sacrifice_candidates":[{"inv_id":40,"level":2},{"inv_id":30,"level":1},{"inv_id":20,"level":1}]},
    "20":{"inv_id":20,"title":"Victim A","level":1,"max_level":80,"stars":1},
    "30":{"inv_id":30,"title":"Victim B","level":1,"max_level":80,"stars":1}
  };
  const captainShadowScroll = { count: 7, exp: 10000000, name: "Shadow EXP Scroll"};
  const normalShadowScroll = { count: 19, exp: 500000, name: "Small Shadow EXP Scroll"};
`;

test('Shadow manager separates level-1 normal Shadows into its sacrifice list', () => {
  const state = manager.parsePageState(pageDocument(SOURCE));
  assert.equal(state.elite.length, 1);
  assert.equal(state.elite[0].title, 'Elite Five');
  assert.deepEqual(state.normal.map((unit) => unit.id), [10]);
  assert.deepEqual(state.victims.map((unit) => unit.id), [20, 30]);
  assert.equal(state.levelOneVictims, 2);
  assert.deepEqual(state.specialScroll, { count: 7, exp: 10_000_000, name: 'Shadow EXP Scroll' });
  assert.deepEqual(state.normalScroll, { count: 19, exp: 500_000, name: 'Small Shadow EXP Scroll' });
});

test('normal Star Up selects only level-1 sacrifices in stable inventory order', () => {
  const [unit] = manager.parsePageState(pageDocument(SOURCE)).normal;
  assert.deepEqual(manager.normalStarPlan(unit), {
    needed: 2,
    available: 2,
    sacrificeIds: [20, 30],
    canSubmit: true,
  });
  assert.deepEqual(manager.actionPayload(unit, 'star'), {
    action: 'star_up_unit',
    unit_type: 'normal',
    unit_id: '10',
    selected_sacrifice_ids: '20,30',
    item_inv_id: '',
    scroll_qty: '',
  });
});

test('Level Up spends exactly one scroll on the selected Shadow', () => {
  const [unit] = manager.parsePageState(pageDocument(SOURCE)).elite;
  assert.deepEqual(manager.actionPayload(unit, 'level'), {
    action: 'use_shadow_exp_scroll',
    unit_type: 'special',
    unit_id: '5',
    selected_sacrifice_ids: '',
    item_inv_id: '',
    scroll_qty: '1',
  });
});

test('target level plan clamps normal Shadows to level 80 and sends the required scroll quantity', () => {
  const victim = manager.parsePageState(pageDocument(SOURCE)).victims[0];
  assert.deepEqual(manager.levelTargetPlan(victim, 12, 19), {
    target: 12,
    quantity: 11,
    canSubmit: true,
  });
  assert.deepEqual(manager.levelTargetPlan(victim, 99, 19), {
    target: 80,
    quantity: 79,
    canSubmit: false,
  });
  assert.deepEqual(manager.actionPayload(victim, 'level', 11), {
    action: 'use_shadow_exp_scroll',
    unit_type: 'normal',
    unit_id: '20',
    selected_sacrifice_ids: '',
    item_inv_id: '',
    scroll_qty: '11',
  });
  const elite = manager.parsePageState(pageDocument(SOURCE)).elite[0];
  assert.deepEqual(manager.levelTargetPlan(elite, 120, 200), {
    target: 120,
    quantity: 108,
    canSubmit: true,
  });
});

test('inline parser accepts nested candidate arrays and braces inside JSON strings', () => {
  assert.deepEqual(
    manager.parseJsonAssignment('const normalUnits={"1":{"title":"{Guard}","sacrifice_candidates":[{"inv_id":2,"level":1}]}};', 'normalUnits'),
    { 1: { title: '{Guard}', sacrifice_candidates: [{ inv_id: 2, level: 1 }] } },
  );
});
