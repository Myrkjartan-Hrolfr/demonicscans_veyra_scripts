'use strict';

// Setting definitions of the PvP features. The keys are the ones veyra-hud
// uses, so existing veyra-hud preferences carry over.

const KEYS = Object.freeze({
  soloImprovements: 'ui-improvements:useCustomSoloPvPStyles',
  enemyClass: 'ui-improvements:showEnemyClass',
  enemyLastHit: 'ui-improvements:showEnemyLastHit',
  allyLastHit: 'ui-improvements:showAllyLastHit',
  attackCard: 'ui-improvements:showAttackCard',
  moveRecentBattles: 'ui-improvements:moveRecentBattles',
  linkRecentBattles: 'ui-improvements:linkRecentBattles',
});

const enabledWithSoloImprovements = (get) => get(KEYS.soloImprovements) !== false;

const SETTINGS = Object.freeze({
  soloImprovements: {
    key: KEYS.soloImprovements,
    label: 'Solo PvP improvements',
    type: 'checkbox',
    default: true,
    hint: 'Master switch for the solo battle HUD and the PvP lobby tweaks below.',
  },
  enemyClass: {
    key: KEYS.enemyClass,
    label: 'Show enemy class',
    type: 'checkbox',
    default: true,
    hint: 'Shows the class/role under each enemy in solo and party battles.',
  },
  enemyLastHit: {
    key: KEYS.enemyLastHit,
    label: 'Show enemy last hit',
    type: 'checkbox',
    default: true,
    visibleIf: enabledWithSoloImprovements,
  },
  allyLastHit: {
    key: KEYS.allyLastHit,
    label: 'Show ally last hit',
    type: 'checkbox',
    default: true,
    visibleIf: enabledWithSoloImprovements,
  },
  attackCard: {
    key: KEYS.attackCard,
    label: 'Show attack card',
    type: 'checkbox',
    default: true,
    hint: 'Shows your active skills inline above Turn Control and glows on your turn.',
    visibleIf: enabledWithSoloImprovements,
  },
  moveRecentBattles: {
    key: KEYS.moveRecentBattles,
    label: 'Move recent battles',
    type: 'checkbox',
    default: true,
    hint: 'Moves the "Recent battles" lists into the main column of the PvP page.',
    visibleIf: enabledWithSoloImprovements,
  },
  linkRecentBattles: {
    key: KEYS.linkRecentBattles,
    label: 'Link recent battles',
    type: 'checkbox',
    default: true,
    hint: 'Makes recent battle cards open the battle (Ctrl/middle click opens a new tab).',
    visibleIf: enabledWithSoloImprovements,
  },
});

// Menu order as in veyra-hud.
const ALL_SETTINGS = Object.freeze([
  SETTINGS.soloImprovements,
  SETTINGS.enemyClass,
  SETTINGS.enemyLastHit,
  SETTINGS.allyLastHit,
  SETTINGS.attackCard,
  SETTINGS.moveRecentBattles,
  SETTINGS.linkRecentBattles,
]);

module.exports = { ALL_SETTINGS, KEYS, SETTINGS };
