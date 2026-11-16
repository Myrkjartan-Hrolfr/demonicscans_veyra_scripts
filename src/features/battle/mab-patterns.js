'use strict';

const PATTERN_MODES = Object.freeze(['attack', 'global-pattern', 'monster-pattern']);

function createPattern() {
  return { attackKeys: [], useStaminaPotions: false, useManaPotions: false };
}

function normalizePattern(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    attackKeys: Array.isArray(source.attackKeys)
      ? source.attackKeys.map((key) => String(key ?? '')).filter(Boolean)
      : [],
    useStaminaPotions: source.useStaminaPotions === true,
    useManaPotions: source.useManaPotions === true,
  };
}

function patternCosts(pattern, attacks) {
  const byKey = new Map((attacks || []).map((attack) => [attack.key, attack]));
  return normalizePattern(pattern).attackKeys.reduce(
    (total, key) => {
      const attack = byKey.get(key);
      if (!attack) return total;
      total.stamina += Number(attack.costs?.stamina) || 0;
      total.mana += Number(attack.costs?.mana) || 0;
      return total;
    },
    { stamina: 0, mana: 0 },
  );
}

function missingPatternKeys(pattern, attacks) {
  const available = new Set((attacks || []).map((attack) => attack.key));
  return normalizePattern(pattern).attackKeys.filter((key) => !available.has(key));
}

function selectedPattern(settings, monsterId) {
  if (settings.primaryMode === 'global-pattern') return normalizePattern(settings.globalPattern);
  if (settings.primaryMode === 'monster-pattern') {
    return normalizePattern(settings.monsterPatterns?.[monsterId]);
  }
  return null;
}

module.exports = {
  PATTERN_MODES,
  createPattern,
  missingPatternKeys,
  normalizePattern,
  patternCosts,
  selectedPattern,
};
