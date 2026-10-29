'use strict';

// Monster Auto Battle: potion classification, priorities and the mapping of
// automation potion lists onto MAB's per-type enable/priority settings.
// MAB uses potions through the game's own .potion-use-btn flow (see the
// engine), because some potion uses reload the page and need the confirm
// dialog the game shows.

const { POTION_CATALOG } = require('../../core/potions');
const { parseInteger } = require('./mab-parse');
const { POTION_TYPES } = require('./mab-settings');

const MULTI_USE_ITEM_IDS = Object.freeze(['30', '162']);

function getPotionType(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  if (text.includes('stamina')) return 'stamina';
  if (text.includes('mana')) return 'mana';
  if (/\bhp\b|health|heal/.test(text)) return 'health';
  return 'other';
}

function potionFromButton(button) {
  const card = button?.closest?.('.potion-card') || null;
  const name =
    button?.dataset?.name?.trim() ||
    card?.querySelector?.('.potion-name span')?.textContent?.trim() ||
    button?.textContent?.trim() ||
    'Unknown Potion';
  const description = card?.querySelector?.('.potion-desc')?.textContent?.trim() || '';
  const itemId = String(button?.dataset?.item || card?.dataset?.itemId || name);
  const quantity =
    [
      card?.querySelector?.('.potion-qty-left')?.textContent,
      button?.querySelector?.('.ds-potion-count')?.textContent,
      button?.dataset?.max,
    ]
      .map(parseInteger)
      .find(Number.isFinite) ?? 0;

  return { key: itemId, itemId, name, description, type: getPotionType(name, description), quantity };
}

// One entry per item id (the highest quantity wins); unknown types dropped.
function collectPotions(buttons) {
  const unique = new Map();
  for (const button of buttons || []) {
    const potion = potionFromButton(button);
    if (potion.type === 'other') continue;
    const existing = unique.get(potion.key);
    if (!existing || potion.quantity > existing.quantity) unique.set(potion.key, potion);
  }
  return [...unique.values()];
}

// Priority lists only keep potions that exist; new potions are appended,
// enabled and set to "use 1 at once".
function reconcilePotionSettings(settings, potions) {
  for (const type of POTION_TYPES) {
    const available = potions.filter((potion) => potion.type === type).map((potion) => potion.key);
    const oldOrder = settings.potionOrder[type] || [];
    settings.potionOrder[type] = [
      ...oldOrder.filter((key) => available.includes(key)),
      ...available.filter((key) => !oldOrder.includes(key)),
    ];
    for (const key of available) {
      if (!(key in settings.potionEnabled)) settings.potionEnabled[key] = true;
      if (!(key in settings.potionUseAmount)) settings.potionUseAmount[key] = 1;
    }
  }
  return settings;
}

// First enabled, in-stock potion of a type in priority order.
function pickPotion(settings, potions, type) {
  return (
    (settings.potionOrder[type] || [])
      .map((key) => potions.find((potion) => potion.key === key))
      .find((potion) => potion && potion.quantity > 0 && settings.potionEnabled[potion.key] !== false) || null
  );
}

function supportsMultiplePotionUse(potion) {
  return MULTI_USE_ITEM_IDS.includes(potion?.itemId);
}

function getConfiguredPotionAmount(settings, potion) {
  const value = Number(settings.potionUseAmount?.[potion.key] ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function getActualPotionAmount(settings, potion) {
  const configured = getConfiguredPotionAmount(settings, potion);
  if (Number.isFinite(potion.quantity) && potion.quantity > 0) return Math.min(configured, potion.quantity);
  return configured;
}

function usageAmount(settings, potion) {
  return supportsMultiplePotionUse(potion) ? getActualPotionAmount(settings, potion) : 1;
}

function movePotion(settings, type, index, direction) {
  const order = settings.potionOrder[type];
  const target = index + direction;
  if (!order || target < 0 || target >= order.length) return false;
  [order[index], order[target]] = [order[target], order[index]];
  return true;
}

// Automation lists use the core catalog types ('stamina', 'heal'); MAB calls
// healing potions 'health'.
const BRIDGE_TYPES = Object.freeze([
  { list: 'stamina', type: 'stamina', catalogType: 'stamina', autoFlag: 'autoStamina' },
  { list: 'heal', type: 'health', catalogType: 'heal', autoFlag: 'autoHealth' },
]);

// Applies { stamina: [itemIds], heal: [itemIds] }: the listed potions are
// enabled in that priority order, every other known potion of that type is
// disabled, and the type's "use automatically" switch follows whether the
// list is empty. A list that is not an array leaves that type untouched.
// Mana potions are not part of the automation interface and stay as set.
function applyPotionLists(settings, lists, potions = []) {
  for (const { list, type, catalogType, autoFlag } of BRIDGE_TYPES) {
    const requested = lists?.[list];
    if (!Array.isArray(requested)) continue;
    const ids = [];
    for (const itemId of requested) {
      const key = String(itemId ?? '').trim();
      if (key && !ids.includes(key)) ids.push(key);
    }

    const known = new Set([
      ...(settings.potionOrder[type] || []),
      ...potions.filter((potion) => potion.type === type).map((potion) => potion.key),
      ...POTION_CATALOG.filter((potion) => potion.type === catalogType).map((potion) => String(potion.itemId)),
    ]);
    for (const key of known) settings.potionEnabled[key] = ids.includes(key);
    for (const key of ids) settings.potionEnabled[key] = true;

    settings.potionOrder[type] = [...ids, ...(settings.potionOrder[type] || []).filter((key) => !ids.includes(key))];
    settings[autoFlag] = ids.length > 0;
  }
  return settings;
}

module.exports = {
  applyPotionLists,
  collectPotions,
  getActualPotionAmount,
  getConfiguredPotionAmount,
  getPotionType,
  movePotion,
  pickPotion,
  potionFromButton,
  reconcilePotionSettings,
  supportsMultiplePotionUse,
  usageAmount,
};
