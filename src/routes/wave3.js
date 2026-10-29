'use strict';

const { potionsOfType } = require('../core/potions');
const { normalizeBossSettings, renderBossSettings } = require('./boss-settings');

// Boss names identify the bosses on the page and must not be editable
// through persisted data.
const WAVE3_BOSSES = Object.freeze({
  skarn: Object.freeze({
    id: 'skarn',
    name: 'General Skarn the Radiant Bastion',
    defaultDamage: '3b',
  }),
  vessir: Object.freeze({
    id: 'vessir',
    name: 'General Vessir the Sunfang Duelist',
    defaultDamage: '3b',
  }),
  hrazz: Object.freeze({
    id: 'hrazz',
    name: 'General Hrazz the Dawnflame Oathkeeper',
    defaultDamage: '3b',
  }),
  drakzareth: Object.freeze({
    id: 'drakzareth',
    name: 'Drakzareth The Tyrant Lizard King',
    defaultDamage: '3b',
  }),
});

const BOSS_LIST = Object.freeze(Object.values(WAVE3_BOSSES));

function normalizeSettings(value) {
  // useStaminaPotions is kept for wave_3_boss_manager.js and is derived from
  // the page's potion selection in finalizeRouteConfig.
  return { useStaminaPotions: false, ...normalizeBossSettings(value, BOSS_LIST) };
}

module.exports = Object.freeze({
  id: 'wave3',
  label: 'Wave 3',
  path: '/active_wave.php?gate=3&wave=8',
  visitPathnames: Object.freeze(['/battle.php']),
  defaultLoopMinutes: 30,
  maxVisitMs: 15 * 60_000,
  initialDelayMs: 30 * 60_000,
  WAVE3_BOSSES,

  matchesUrl(url) {
    return (
      /\/active_wave\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('gate') === '3' &&
      url.searchParams.get('wave') === '8'
    );
  },

  createDefaultSettings() {
    return normalizeSettings(null);
  },

  normalizeSettings,

  // Configs saved before per-page potions existed are migrated once.
  finalizeRouteConfig(routeConfig, savedRoute) {
    const hasPotionList = Array.isArray(savedRoute?.potions?.stamina);
    if (!hasPotionList && savedRoute?.settings?.useStaminaPotions === true) {
      routeConfig.potions.stamina = potionsOfType('stamina').map((potion) => potion.itemId);
    }
    routeConfig.settings.useStaminaPotions = routeConfig.potions.stamina.length > 0;
  },

  renderSettings(ctx) {
    renderBossSettings(ctx, [{ title: 'Bosses', bosses: BOSS_LIST }]);
  },
});
