'use strict';

// From veyra-hud ui-improvements ("Better Attack Buttons"): the attack
// buttons show their stamina cost including the Asterion multiplier.
// Changes: costs are rounded up like the game does, the base cost is kept
// in a data attribute so running twice never multiplies twice, and buttons
// with child elements (icons) keep them.

const { ASTERION_SETTINGS, staminaCost, staminaMultiplier } = require('../shared/asterion');

const SKILL_COST_PATTERN = /(\d[\d,]*)\s*MP\s*\/\s*(\d[\d,]*)\s*STAM/i;
const BUTTON_COST_PATTERN = /\(\s*(\d[\d,]*)\s*STAMINA\s*\)/i;

const toInt = (text) => Number(String(text).replace(/,/g, ''));

// "20 MP / 200 STAM" -> { mp: 20, stamina: 200 }
function parseSkillCost(text) {
  const match = String(text ?? '').match(SKILL_COST_PATTERN);
  return match ? { mp: toInt(match[1]), stamina: toInt(match[2]) } : null;
}

function formatSkillCost(mp, stamina) {
  return `${mp} MP / ${stamina} STAM`;
}

// "Power Slash (10 STAMINA)" -> { name: 'Power Slash', stamina: 10 }
// "Slash" -> { name: 'Slash', stamina: 1 } (the plain slash costs 1)
function parseAttackButtonText(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const match = value.match(BUTTON_COST_PATTERN);
  const name = value.replace(/\s*\([^)]*\)\s*/, ' ').replace(/\s+/g, ' ').trim();
  return { name, stamina: match ? toInt(match[1]) : 1 };
}

function formatAttackButtonText(name, stamina) {
  return `${name} (${stamina})`;
}

function updateButton(button, multiplier) {
  const costElement = button.querySelector?.('.skill-cost');
  if (costElement) {
    let base = button.dataset.veyraBaseCost ? JSON.parse(button.dataset.veyraBaseCost) : null;
    if (!base) {
      base = parseSkillCost(costElement.textContent);
      if (!base) return;
      button.dataset.veyraBaseCost = JSON.stringify(base);
    }
    costElement.textContent = formatSkillCost(base.mp, staminaCost(base.stamina, multiplier));
    return;
  }

  // Buttons with icons: only rewrite the text node that carries the name.
  const target = button.children?.length
    ? [...(button.childNodes || [])].find((node) => node.nodeType === 3 && node.textContent.trim())
    : button;
  if (!target) return;

  let base = button.dataset.veyraBaseCost ? JSON.parse(button.dataset.veyraBaseCost) : null;
  if (!base) {
    base = parseAttackButtonText(target.textContent);
    if (!base.name) return;
    button.dataset.veyraBaseCost = JSON.stringify(base);
  }
  target.textContent = formatAttackButtonText(base.name, staminaCost(base.stamina, multiplier));
}

module.exports = Object.freeze({
  id: 'better-attack-buttons',
  group: 'General',
  settings: [
    {
      key: 'ui-improvements:useBetterAttackButtons',
      label: 'Better Attack Buttons',
      type: 'checkbox',
      default: true,
      hint: 'Shows the stamina cost of each attack, including the Asterion multiplier.',
    },
    ...ASTERION_SETTINGS,
  ],
  enabledBy: 'ui-improvements:useBetterAttackButtons',
  formatAttackButtonText,
  formatSkillCost,
  parseAttackButtonText,
  parseSkillCost,

  matches() {
    return true;
  },

  run(ctx) {
    const buttons = ctx.doc.querySelectorAll?.('.attack-btn') || [];
    if (buttons.length === 0) return;
    const multiplier = staminaMultiplier(ctx);
    for (const button of buttons) {
      try {
        updateButton(button, multiplier);
      } catch (error) {
        ctx.warn('Could not update attack button.', error);
      }
    }
  },
});
