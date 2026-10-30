'use strict';

// Pure Solo PvP helpers. The attack planner is the tested strategy from the
// former activate_auto_battle_target.js userscript, kept independent from DOM
// and scheduler state so it can be verified without a browser.

const SKILL_KEYS = Object.freeze({
  slash: 'slash',
  powerSlash: 'powerSlash',
  venomRend: 'venomRend',
  deathMark: 'deathMark',
  finalWish: 'finalWish',
});

const SKILL_IDS = Object.freeze({
  [SKILL_KEYS.slash]: '0',
  [SKILL_KEYS.powerSlash]: '-1',
  [SKILL_KEYS.venomRend]: 'adv:18',
  [SKILL_KEYS.deathMark]: 'adv:19',
  [SKILL_KEYS.finalWish]: 'adv:20',
});

const SKILL_NAMES = Object.freeze({
  [SKILL_KEYS.slash]: 'Slash',
  [SKILL_KEYS.powerSlash]: 'Power Slash',
  [SKILL_KEYS.venomRend]: 'Venom Rend',
  [SKILL_KEYS.deathMark]: 'Death Mark',
  [SKILL_KEYS.finalWish]: 'Final Wish',
});

const COMBAT_DEFAULTS = Object.freeze({
  slashTokenGain: 3,
  resourceGainPerAction: 25,
  finalWishCost: 15,
  resourceMaximum: 100,
});

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const match = String(value ?? '').match(/-?\d[\d.,\s]*/);
  if (!match) return null;
  const number = Number.parseInt(match[0].replace(/\D/g, ''), 10);
  if (!Number.isFinite(number)) return null;
  return match[0].trim().startsWith('-') ? -number : number;
}

function parseFraction(value) {
  const match = String(value ?? '').match(/(\d[\d.,\s]*)\s*\/\s*(\d[\d.,\s]*)/);
  if (!match) return null;
  const current = parseInteger(match[1]);
  const maximum = parseInteger(match[2]);
  return current === null || maximum === null ? null : { current, maximum };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function roundsUntilFinalWish({
  tokens,
  resource,
  finalCost = COMBAT_DEFAULTS.finalWishCost,
  resourceMaximum = COMBAT_DEFAULTS.resourceMaximum,
  slashTokenGain = COMBAT_DEFAULTS.slashTokenGain,
  resourceGainPerAction = COMBAT_DEFAULTS.resourceGainPerAction,
}) {
  const tokenValue = finiteNumber(tokens);
  const resourceValue = finiteNumber(resource);
  const cost = finiteNumber(finalCost);
  const maximum = finiteNumber(resourceMaximum);
  if (
    tokenValue === null ||
    resourceValue === null ||
    cost === null ||
    maximum === null ||
    slashTokenGain <= 0 ||
    resourceGainPerAction <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const tokenRounds = Math.ceil(Math.max(0, cost - tokenValue) / slashTokenGain);
  const resourceRounds = Math.ceil(Math.max(0, maximum - resourceValue) / resourceGainPerAction);
  return Math.max(tokenRounds, resourceRounds);
}

function canSpendWithoutDelayingFinal({
  tokens,
  skillCost,
  rounds,
  finalCost = COMBAT_DEFAULTS.finalWishCost,
  slashTokenGain = COMBAT_DEFAULTS.slashTokenGain,
}) {
  const tokenValue = finiteNumber(tokens);
  const cost = finiteNumber(skillCost);
  if (tokenValue === null || cost === null || !Number.isFinite(rounds) || rounds < 1) return false;
  const remainingSlashActions = Math.max(0, Math.floor(rounds) - 1);
  return tokenValue - cost + remainingSlashActions * slashTokenGain >= finalCost;
}

function canUseSkill(skill, snapshot) {
  if (!skill?.available) return false;
  const cost = finiteNumber(skill.cost);
  const resourceCost = finiteNumber(skill.resourceCost);
  if (cost === null || resourceCost === null || cost < 0 || resourceCost < 0) return false;
  if (snapshot.tokens < cost || snapshot.resource < resourceCost) return false;
  return !skill.requiresFullResource || snapshot.resource >= snapshot.resourceMaximum;
}

function makeDecision(skillKey, reason, rounds, options = {}) {
  return {
    skillKey,
    reason,
    roundsUntilFinalWish: rounds,
    prepareBridge: options.prepareBridge === true,
    consumeBridge: options.consumeBridge === true,
    resetCycle: options.resetCycle === true,
  };
}

function chooseAttackPlan(input) {
  const tokens = finiteNumber(input?.tokens);
  const resource = finiteNumber(input?.resource);
  const resourceMaximum = finiteNumber(input?.resourceMaximum) ?? COMBAT_DEFAULTS.resourceMaximum;
  const skills = input?.skills || {};
  const bridgePending = input?.bridgePending === true;
  const enemyPoisoned = input?.enemyPoisoned === true;
  const slash = skills[SKILL_KEYS.slash];
  const finalWish = skills[SKILL_KEYS.finalWish];
  const finalCost = finiteNumber(finalWish?.cost) ?? COMBAT_DEFAULTS.finalWishCost;

  if (tokens === null || resource === null) {
    return makeDecision(null, 'Battle values are unavailable.', Number.POSITIVE_INFINITY, {
      consumeBridge: bridgePending,
    });
  }

  const snapshot = { tokens, resource, resourceMaximum };
  const rounds = roundsUntilFinalWish({ tokens, resource, finalCost, resourceMaximum });
  if (rounds === 0 && canUseSkill(finalWish, snapshot)) {
    return makeDecision(SKILL_KEYS.finalWish, 'Final Wish is ready now.', rounds, {
      consumeBridge: bridgePending,
      resetCycle: true,
    });
  }

  if (!slash?.available) {
    return makeDecision(null, 'Slash is unavailable.', rounds, { consumeBridge: bridgePending });
  }

  if (tokens < finalCost) {
    return makeDecision(SKILL_KEYS.slash, `Only ${tokens} token(s): build with Slash.`, rounds, {
      consumeBridge: bridgePending,
    });
  }

  if (bridgePending) {
    const followUpKey = enemyPoisoned ? SKILL_KEYS.venomRend : SKILL_KEYS.powerSlash;
    const followUp = skills[followUpKey];
    const followUpName = SKILL_NAMES[followUpKey];
    if (
      rounds === 1 &&
      canUseSkill(followUp, snapshot) &&
      canSpendWithoutDelayingFinal({ tokens, skillCost: followUp.cost, rounds, finalCost })
    ) {
      return makeDecision(
        followUpKey,
        enemyPoisoned
          ? `${followUpName}: Death Mark is prepared and the enemy is poisoned.`
          : `${followUpName}: Death Mark is prepared and the enemy is not poisoned.`,
        rounds,
        { consumeBridge: true },
      );
    }
    return makeDecision(
      SKILL_KEYS.slash,
      `${followUpName} would delay Final Wish or is unavailable; use Slash.`,
      rounds,
      { consumeBridge: true },
    );
  }

  const deathMark = skills[SKILL_KEYS.deathMark];
  if (
    (rounds === 1 || rounds === 2) &&
    canUseSkill(deathMark, snapshot) &&
    canSpendWithoutDelayingFinal({ tokens, skillCost: deathMark.cost, rounds, finalCost })
  ) {
    return makeDecision(
      SKILL_KEYS.deathMark,
      `Death Mark prepares Final Wish ${rounds === 1 ? 'next turn' : 'in two turns'}.`,
      rounds,
      { prepareBridge: rounds === 2 },
    );
  }

  return makeDecision(
    SKILL_KEYS.slash,
    Number.isFinite(rounds)
      ? `Build for Final Wish (${rounds} preparation turn(s) remaining).`
      : 'Could not calculate Final Wish safely; use Slash.',
    rounds,
  );
}

function isConfirmedSkillUse(logText, actorName, skillName) {
  const text = normalizeText(logText);
  const actor = normalizeText(actorName);
  const skill = normalizeText(skillName);
  if (!text || !actor || !skill) return false;
  const prefix = `${actor} used ${skill}`;
  if (!text.startsWith(prefix)) return false;
  const boundary = text.charAt(prefix.length);
  return boundary === '' || /[\s.,!?:;()-]/.test(boundary);
}

function isFinishedBattleState({ statusText, rewardsVisible, allyAlive, enemyAlive }) {
  const status = normalizeText(statusText);
  if (/victory|defeat|draw|battle ended|match ended|finished/.test(status) || rewardsVisible) {
    return true;
  }
  if (/battle in progress|match in progress/.test(status)) return false;
  return allyAlive === false || enemyAlive === false;
}

module.exports = {
  COMBAT_DEFAULTS,
  SKILL_IDS,
  SKILL_KEYS,
  SKILL_NAMES,
  canSpendWithoutDelayingFinal,
  canUseSkill,
  chooseAttackPlan,
  finiteNumber,
  isConfirmedSkillUse,
  isFinishedBattleState,
  normalizeText,
  parseFraction,
  parseInteger,
  roundsUntilFinalWish,
};
