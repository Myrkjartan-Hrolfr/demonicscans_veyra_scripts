'use strict';

// Monsters that bulk looting must leave alone, e.g. because the Adventurer's
// Guild quest automation still has to loot them itself for quest progress.
// Stored as { names: ["kraken", …] } (lowercase monster names).

const LOOT_GUARD_KEY = 'veyra:loot-guard:v1';

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function readProtectedNames(store) {
  const saved = store?.read?.(LOOT_GUARD_KEY);
  return new Set((Array.isArray(saved?.names) ? saved.names : []).map(normalizeName).filter(Boolean));
}

function setProtectedNames(store, names) {
  const unique = [...new Set((names || []).map(normalizeName).filter(Boolean))];
  store.write(LOOT_GUARD_KEY, { names: unique });
  return unique;
}

function isLootProtected(store, monsterName) {
  return readProtectedNames(store).has(normalizeName(monsterName));
}

module.exports = {
  LOOT_GUARD_KEY,
  isLootProtected,
  readProtectedNames,
  setProtectedNames,
};
