'use strict';

// Monster Auto Battle: reading attack buttons and keeping the three attack
// slots plus the poison attack valid. Works on anything button-like
// ({ dataset, textContent, querySelector, closest }), so tests use stubs.

const { parseInteger } = require('./mab-parse');

const GROUP_STANDARD = 'Standard Attacks';
const GROUP_CLASS = 'Class Attacks';
const ATTACK_GROUPS = Object.freeze([GROUP_STANDARD, GROUP_CLASS]);
const COST_NUMBER = '(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d+)';

function getAttackCosts(button) {
  const text = [
    button?.dataset?.skillName || '',
    button?.textContent || '',
    button?.querySelector?.('.skill-cost')?.textContent || '',
  ].join(' ');

  const staminaMatch = text.match(new RegExp(`${COST_NUMBER}\\s*(?:stam|stamina)\\b`, 'i'));
  const manaMatch = text.match(new RegExp(`${COST_NUMBER}\\s*(?:mp|mana)\\b`, 'i'));
  let stamina = staminaMatch ? parseInteger(staminaMatch[1]) : null;
  const mana = manaMatch ? parseInteger(manaMatch[1]) : 0;

  // Standard attack buttons often carry the real stamina cost only in their
  // text, e.g. "Power Slash (10)".
  if (!Number.isFinite(stamina) || stamina <= 1) {
    const ending = String(button?.textContent || '').match(new RegExp(`\\(${COST_NUMBER}\\)\\s*$`));
    const visibleCost = ending ? parseInteger(ending[1]) : null;
    const dataCost = parseInteger(button?.dataset?.stamCost);
    stamina = Number.isFinite(visibleCost) ? visibleCost : (dataCost ?? 0);
  }

  return { stamina: stamina || 0, mana: mana || 0 };
}

function attackFromButton(button) {
  const name =
    button?.dataset?.skillName?.trim() ||
    button?.querySelector?.('.skill-name')?.textContent?.trim() ||
    button?.textContent?.trim() ||
    'Unnamed Attack';
  const skillId = String(button?.dataset?.skillId ?? '');
  return {
    key: `${skillId}|${name}`,
    skillId,
    name,
    group: button?.closest?.('.class-skill-bar') ? GROUP_CLASS : GROUP_STANDARD,
    costs: getAttackCosts(button),
  };
}

function attackSignature(attacks) {
  return attacks.map((attack) => `${attack.key}:${attack.costs.stamina}:${attack.costs.mana}`).join('||');
}

// Keeps saved slots that still exist and fills the others with the first
// attack not selected yet. Clears a poison attack that disappeared.
function reconcileAttackKeys(settings, attacks) {
  const keys = Array.isArray(settings.attackKeys) ? settings.attackKeys.slice(0, 3) : ['', '', ''];
  for (let index = 0; index < 3; index += 1) {
    if (attacks.some((attack) => attack.key === keys[index])) continue;
    keys[index] =
      attacks.find((attack) => !keys.includes(attack.key))?.key || attacks[index]?.key || attacks[0]?.key || '';
  }
  settings.attackKeys = keys;
  if (settings.poisonAttackKey && !attacks.some((attack) => attack.key === settings.poisonAttackKey)) {
    settings.poisonAttackKey = '';
  }
  return settings;
}

function findAttack(attacks, key) {
  return (key && attacks.find((attack) => attack.key === key)) || null;
}

// Maps standard skill ids ('0', '-1', ...) to attack keys in the given
// order. Unknown ids are skipped; with a standard and a class button for the
// same id the standard one wins. Returns three slot keys (the last match is
// repeated for unused fallback slots) or null when no id matched.
function mapSkillIdsToAttackKeys(attacks, skillIds) {
  const keys = [];
  for (const rawId of Array.isArray(skillIds) ? skillIds : []) {
    const skillId = String(rawId ?? '').trim();
    if (!skillId) continue;
    const matches = attacks.filter((attack) => attack.skillId === skillId);
    const attack = matches.find((candidate) => candidate.group === GROUP_STANDARD) || matches[0];
    if (attack && !keys.includes(attack.key)) keys.push(attack.key);
  }
  if (keys.length === 0) return null;
  const slots = keys.slice(0, 3);
  while (slots.length < 3) slots.push(slots[slots.length - 1]);
  return slots;
}

function attackOptionLabel(attack, formatNumber) {
  const costs = [];
  if (attack.costs.stamina) costs.push(`${formatNumber(attack.costs.stamina)} STA`);
  if (attack.costs.mana) costs.push(`${formatNumber(attack.costs.mana)} MP`);
  return costs.length ? `${attack.name} · ${costs.join(' / ')}` : attack.name;
}

module.exports = {
  ATTACK_GROUPS,
  GROUP_CLASS,
  GROUP_STANDARD,
  attackFromButton,
  attackOptionLabel,
  attackSignature,
  findAttack,
  getAttackCosts,
  mapSkillIdsToAttackKeys,
  reconcileAttackKeys,
};
