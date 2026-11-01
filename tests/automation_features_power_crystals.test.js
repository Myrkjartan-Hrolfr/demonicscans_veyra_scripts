'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const quickset = require('../src/features/general/power-crystal-quickset');

test('Power Crystal inline JSON parser handles nested data and braces in strings', () => {
  const source = 'const levelUpgradeData = {"12":{"expected_current":3,"preview_rows":[{"label":"{gain}"}]}};';
  assert.deepEqual(quickset.parseJsonAssignment(source, 'levelUpgradeData'), {
    12: { expected_current: 3, preview_rows: [{ label: '{gain}' }] },
  });
  assert.equal(quickset.parseJsonAssignment(source, 'starUpgradeData'), null);
});

test('Power Crystal equipment metadata falls back to useful image names, types and sets', () => {
  assert.equal(
    quickset.cleanImageName('/images/events/Emberfall/items/1759692004_Scalescourge_Emberstride_Boots.webp'),
    'Scalescourge Emberstride Boots',
  );
  assert.deepEqual(
    quickset.inferEquipmentMeta('Scalescourge Emberstride Boots'),
    { type: 'Feet', set: 'Scalescourge' },
  );
  assert.deepEqual(
    quickset.inferEquipmentMeta('Vaelith Scriptbound Gloves'),
    { type: 'Hands', set: 'Vaelith' },
  );
  assert.deepEqual(
    quickset.inferEquipmentMeta('Kaelan Last Dawn Swordstaff of the Unfallen', '/events/last_dawn/item.webp'),
    { type: 'Weapon', set: 'Last Dawn' },
  );
  assert.deepEqual(
    quickset.inferEquipmentMeta('Halo of the Unbroken Saint', '/events/last_dawn/item.webp'),
    { type: 'Head', set: 'Last Dawn' },
  );
  assert.deepEqual(
    quickset.inferEquipmentMeta('6830f15795d3'),
    { type: 'Other', set: 'Unknown' },
  );
});

test('Power Crystal move plan moves, replaces and swaps without losing assignments', () => {
  assert.deepEqual(
    quickset.planCrystalMove({ crystalId: 11, targetEquipmentKey: 'target', targetCrystalId: null }),
    [{ action: 'equip', crystalId: 11, equipmentKey: 'target' }],
  );
  assert.deepEqual(
    quickset.planCrystalMove({ crystalId: 11, targetEquipmentKey: 'target', targetCrystalId: 22 }),
    [
      { action: 'unequip', crystalId: 22 },
      { action: 'equip', crystalId: 11, equipmentKey: 'target' },
    ],
  );
  assert.deepEqual(
    quickset.planCrystalMove({
      crystalId: 11,
      sourceEquipmentKey: 'source',
      targetEquipmentKey: 'target',
      targetCrystalId: 22,
    }),
    [
      { action: 'unequip', crystalId: 11 },
      { action: 'unequip', crystalId: 22 },
      { action: 'equip', crystalId: 11, equipmentKey: 'target' },
      { action: 'equip', crystalId: 22, equipmentKey: 'source' },
    ],
  );
  assert.deepEqual(
    quickset.planCrystalMove({ crystalId: 11, sourceEquipmentKey: 'same', targetEquipmentKey: 'same' }),
    [],
  );
  assert.deepEqual(
    quickset.planCrystalMove({ crystalId: 11, sourceEquipmentKey: 'source', targetEquipmentKey: null }),
    [{ action: 'unequip', crystalId: 11 }],
  );
});

test('Power Crystal upgrades are enabled only when both gold and materials suffice', () => {
  const data = { expected_current: 2, gold_needed: 10_000_000, need_qty: 20, has_qty: 20 };
  assert.equal(quickset.upgradeAffordable(data, 10_000_000), true);
  assert.equal(quickset.upgradeAffordable({ ...data, has_qty: 19 }, 10_000_000), false);
  assert.equal(quickset.upgradeAffordable(data, 9_999_999), false);
  assert.equal(quickset.upgradeAffordable(null, 100_000_000), false);
});
