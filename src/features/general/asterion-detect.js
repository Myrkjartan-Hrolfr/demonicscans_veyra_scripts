'use strict';

// From veyra-hud ui-improvements: on the pets page the Asterion multiplier
// is read from the pet and stored, so stamina costs use the real value.
// Change: decimal multipliers ("x1.5") are accepted.

const { ASTERION_SETTINGS, ASTERION_VALUE } = require('../shared/asterion');

// "Multiplies stamina x3" -> 3; "×2.5" -> 2.5; anything else -> null.
function parseAsterionMultiplier(text) {
  const match = String(text ?? '').match(/(?:^|[^a-z])[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

// slots: [{ name, powerText }]. Returns the multiplier of the first
// Asterion slot that has one.
function findAsterionMultiplier(slots) {
  for (const slot of slots || []) {
    if (!/asterion/i.test(String(slot?.name ?? ''))) continue;
    const value = parseAsterionMultiplier(slot.powerText);
    if (value !== null) return value;
  }
  return null;
}

module.exports = Object.freeze({
  id: 'asterion-detect',
  group: 'General',
  settings: [...ASTERION_SETTINGS],
  findAsterionMultiplier,
  parseAsterionMultiplier,

  matches(url) {
    return /\/pets\.php$/i.test(url.pathname);
  },

  run(ctx) {
    const slots = [...(ctx.doc.querySelectorAll?.('.slot-box') || [])].map((slot) => {
      const overlay = slot.querySelector?.('.pet-info-overlay');
      return {
        name: slot.querySelector?.('img')?.alt || overlay?.dataset?.name || '',
        powerText: slot.querySelector?.('.pet-power')?.textContent || overlay?.dataset?.desc || '',
      };
    });
    const value = findAsterionMultiplier(slots);
    if (value === null || ctx.setting(ASTERION_VALUE.key) === value) return;
    ctx.setSetting(ASTERION_VALUE.key, value);
    ctx.log(`Asterion multiplier set to ${value}.`);
  },
});
