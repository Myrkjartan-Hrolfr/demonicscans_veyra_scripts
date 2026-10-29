'use strict';

// Monster Auto Battle: the controller registered with mab-bridge.js. The
// automation workers drive MAB only through it. Settings it changes are
// MAB's normal persisted settings and are written back into the panel, so
// the user sees (and a later Start keeps) what the automation chose.

const { mapSkillIdsToAttackKeys } = require('./mab-attacks');
const { formatTargetDisplay, parseTarget } = require('./mab-parse');
const { applyPotionLists } = require('./mab-potions');

// Accepts a number (3e9) or game text ("3b", "3,000,000,000"); 0 means
// unlimited. Returns the stored text or null for invalid input.
function normalizeTargetAmount(amount) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.ceil(amount).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  }
  const text = String(amount ?? '').trim();
  const parsed = parseTarget(text);
  if (!text || !Number.isFinite(parsed) || parsed < 0) return null;
  return text.replace(/\s+/g, '');
}

// engine: from createEngine; syncForm: refreshes the panel from settings.
function createController(engine, syncForm = () => {}) {
  const { state } = engine;

  function afterSettingsChange() {
    engine.saveSettings();
    try {
      syncForm();
    } catch {
      // The panel may be gone; the settings are saved anyway.
    }
  }

  return {
    // Stop once your total damage on this monster (#yourDamageValue)
    // reaches the amount. Applies immediately, also to a running battle.
    setTargetDamage(amount) {
      const text = normalizeTargetAmount(amount);
      if (text === null) return false;
      state.settings.targetDamage = formatTargetDisplay(text) || '0';
      afterSettingsChange();
      return true;
    },

    // Fills Attack 1-3 with the attacks whose data-skill-id matches, in the
    // given order (unknown ids are skipped, more than three are ignored,
    // fewer repeat the last one so no other attack is used as a fallback).
    // A configured poison attack is turned off unless its skill id is listed.
    setAttacks(skillIds) {
      engine.discoverAttacks();
      const keys = mapSkillIdsToAttackKeys(state.attacks, skillIds);
      if (!keys) return false;
      state.settings.attackKeys = keys;
      const poison = state.attacks.find((attack) => attack.key === state.settings.poisonAttackKey);
      const wanted = (Array.isArray(skillIds) ? skillIds : []).map((id) => String(id ?? '').trim());
      if (poison && !wanted.includes(poison.skillId)) state.settings.poisonAttackKey = '';
      afterSettingsChange();
      return true;
    },

    // { stamina: [itemIds], heal: [itemIds] } in priority order. Listed
    // potions are enabled, all other potions of that type disabled, and
    // automatic use of that type is on exactly when the list is not empty.
    setPotions(lists) {
      engine.discoverPotions();
      applyPotionLists(state.settings, lists || {}, state.potions);
      afterSettingsChange();
      return true;
    },

    // Returns true when a battle is running after the call.
    start() {
      if (!state.running) {
        engine.start().catch(() => {});
      }
      return state.running;
    },

    stop() {
      if (state.running) engine.stop();
    },

    getState() {
      return engine.getState();
    },

    onChange(callback) {
      return engine.subscribe(callback);
    },
  };
}

module.exports = {
  createController,
  normalizeTargetAmount,
};
