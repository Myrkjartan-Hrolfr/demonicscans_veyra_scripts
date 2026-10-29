'use strict';

// The Asterion pet multiplies stamina costs. veyra-hud stored these two
// settings under ui-improvements:*; features that show or pay stamina costs
// list ASTERION_SETTINGS in their settings so the menu shows them once.

const USE_ASTERION = Object.freeze({
  key: 'ui-improvements:useAsterion',
  label: 'Use Asterion multiplier',
  type: 'checkbox',
  default: false,
  hint: 'Multiplies stamina costs. The value is read automatically on the pets page.',
});

const ASTERION_VALUE = Object.freeze({
  key: 'ui-improvements:asterionValue',
  label: 'Asterion multiplier',
  type: 'number',
  default: 1.5,
  min: 1,
  step: 0.5,
  visibleIf: (get) => get(USE_ASTERION.key) === true,
});

const ASTERION_SETTINGS = Object.freeze([USE_ASTERION, ASTERION_VALUE]);

// ctx is a feature context (features/runner.js).
function staminaMultiplier(ctx) {
  return ctx.setting(USE_ASTERION.key) ? ctx.setting(ASTERION_VALUE.key) : 1;
}

function staminaCost(baseCost, multiplier) {
  return Math.ceil(Number(baseCost) * Math.max(1, Number(multiplier) || 1));
}

module.exports = {
  ASTERION_SETTINGS,
  ASTERION_VALUE,
  USE_ASTERION,
  staminaCost,
  staminaMultiplier,
};
