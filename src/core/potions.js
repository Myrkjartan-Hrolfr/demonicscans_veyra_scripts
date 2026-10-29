'use strict';

const { postForm } = require('./http');
const { parseGameNumber } = require('./numbers');

const POTION_TYPES = Object.freeze({
  stamina: Object.freeze({ id: 'stamina', label: 'Stamina potions' }),
  heal: Object.freeze({ id: 'heal', label: 'Healing potions' }),
});

// Order is the usage priority: cheap potions first.
const POTION_CATALOG = Object.freeze([
  Object.freeze({ itemId: 30, type: 'stamina', name: 'Small Stamina Potion' }),
  Object.freeze({ itemId: 251, type: 'stamina', name: 'Large Stamina Potion' }),
  Object.freeze({ itemId: 35, type: 'stamina', name: 'Full Stamina Potion' }),
  Object.freeze({ itemId: 359, type: 'stamina', name: 'Adventurer Stamina Potion' }),
  Object.freeze({ itemId: 108, type: 'heal', name: 'Full HP Potion' }),
]);

const HEAL_POTION_ENDPOINT_ITEM_ID = 108;

function potionsOfType(type) {
  return POTION_CATALOG.filter((potion) => potion.type === type);
}

function createDefaultPotionSettings() {
  const settings = {};
  for (const type of Object.keys(POTION_TYPES)) settings[type] = [];
  return settings;
}

// Keeps only known item ids of the right type, in catalog priority order.
function normalizePotionSettings(value, fallback = createDefaultPotionSettings()) {
  const settings = {};
  for (const type of Object.keys(POTION_TYPES)) {
    const saved = Array.isArray(value?.[type]) ? value[type] : fallback[type] || [];
    const selected = new Set(saved.map(Number));
    settings[type] = potionsOfType(type)
      .filter((potion) => selected.has(potion.itemId))
      .map((potion) => potion.itemId);
  }
  return settings;
}

// Reads the potion drawer that the game renders on every page.
function readPotionInventory(root) {
  const cards = root?.querySelectorAll?.('.potion-card[data-inv-id][data-item-id]') || [];
  const inventory = [];
  for (const card of cards) {
    const button = card.querySelector?.('.potion-use-btn');
    const qtyText = card.querySelector?.('.potion-qty-left')?.textContent;
    const quantity = parseGameNumber(qtyText) ?? parseGameNumber(button?.getAttribute?.('data-max')) ?? 0;
    inventory.push({
      invId: String(card.getAttribute('data-inv-id') || ''),
      itemId: Number(card.getAttribute('data-item-id')),
      name: String(button?.getAttribute?.('data-name') || card.querySelector?.('.potion-name')?.textContent || '').trim(),
      quantity,
    });
  }
  return inventory.filter((entry) => entry.invId && Number.isFinite(entry.itemId));
}

// Picks the first selected potion (in priority order) that is in stock.
function pickPotion(inventory, selectedItemIds) {
  for (const itemId of selectedItemIds || []) {
    const entry = (inventory || []).find(
      (candidate) => candidate.itemId === Number(itemId) && candidate.quantity > 0,
    );
    if (entry) return entry;
  }
  return null;
}

function endpointForItem(itemId) {
  return Number(itemId) === HEAL_POTION_ENDPOINT_ITEM_ID ? 'user_heal_potion.php' : 'use_item.php';
}

async function usePotion(entry, options = {}) {
  const { quantity = 1, post = postForm } = options;
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const response = await post(endpointForItem(entry.itemId), {
    inv_id: entry.invId,
    qty: qty > 1 ? qty : undefined,
  });
  return {
    ok: response.ok && String(response.text || '').toLowerCase().includes('success'),
    message: String(response.text || '').trim(),
  };
}

module.exports = {
  POTION_CATALOG,
  POTION_TYPES,
  createDefaultPotionSettings,
  endpointForItem,
  normalizePotionSettings,
  pickPotion,
  potionsOfType,
  readPotionInventory,
  usePotion,
};
