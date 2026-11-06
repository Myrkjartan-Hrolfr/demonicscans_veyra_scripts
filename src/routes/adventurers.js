'use strict';

const DEFAULT_FARM_MONSTERS = 95;
const MIN_FARM_MONSTERS = 1;
const MAX_FARM_MONSTERS = 100_000;
const DEFAULT_FARM_STACK = 10;
const MIN_FARM_STACK = 1;
const MAX_FARM_STACK = 250;

function normalizeInteger(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeFarmMonsterCount(value) {
  return normalizeInteger(value, DEFAULT_FARM_MONSTERS, MIN_FARM_MONSTERS, MAX_FARM_MONSTERS);
}

function normalizeFarmStackCount(value) {
  return normalizeInteger(value, DEFAULT_FARM_STACK, MIN_FARM_STACK, MAX_FARM_STACK);
}

function normalizeSettings(value) {
  const hasStackSetting = Object.prototype.hasOwnProperty.call(value || {}, 'farmStackCount');
  const savedMonsterCount = !hasStackSetting && Number(value?.farmMonsterCount) === 90
    ? DEFAULT_FARM_MONSTERS
    : value?.farmMonsterCount;
  return {
    farmMonsterCount: normalizeFarmMonsterCount(savedMonsterCount),
    farmStackCount: normalizeFarmStackCount(value?.farmStackCount),
  };
}

module.exports = Object.freeze({
  DEFAULT_FARM_MONSTERS,
  DEFAULT_FARM_STACK,
  id: 'adventurers',
  label: "Adventurer's Guild",
  path: '/adventurers_guild.php?veyra_route=adventurers',
  defaultEnabled: false,
  defaultLoopMinutes: 5,
  maxVisitMs: 2 * 60 * 60_000,
  initialDelayMs: 10 * 60_000,

  matchesUrl(url) {
    // This page has its own unambiguous pathname. Keep recognizing it if a
    // response canonicalizes the scheduler URL and removes veyra_route.
    return /\/adventurers_guild\.php\/?$/i.test(url.pathname);
  },

  createDefaultSettings: normalizeSettings,
  normalizeFarmMonsterCount,
  normalizeFarmStackCount,
  normalizeSettings,

  renderSettings(ctx) {
    ctx.addSectionTitle('Quest automation');
    const countInput = ctx.addTextInput({
      id: 'farm-monster-count',
      label: 'Monsters to farm before quest turn-ins',
      value: ctx.settings.farmMonsterCount,
      type: 'number',
      inputMode: 'numeric',
      onChange(value) {
        ctx.settings = ctx.updateSettings((settings) => {
          settings.farmMonsterCount = value;
        });
        return ctx.settings.farmMonsterCount;
      },
    });
    countInput.min = String(MIN_FARM_MONSTERS);
    countInput.max = String(MAX_FARM_MONSTERS);
    countInput.step = '1';

    const stackInput = ctx.addTextInput({
      id: 'farm-stack-count',
      label: 'Maximum stack per quest monster',
      value: ctx.settings.farmStackCount,
      type: 'number',
      inputMode: 'numeric',
      onChange(value) {
        ctx.settings = ctx.updateSettings((settings) => {
          settings.farmStackCount = value;
        });
        return ctx.settings.farmStackCount;
      },
    });
    stackInput.min = String(MIN_FARM_STACK);
    stackInput.max = String(MAX_FARM_STACK);
    stackInput.step = '1';

    const group = ctx.make('div', { className: ctx.cls('setting') });
    group.appendChild(
      ctx.make('div', {
        className: ctx.cls('hint'),
        text:
          'Defaults: 95 monsters and a maximum stack of 10 per quest monster. When quests are available, the worker resets Auto Farm, applies these settings to all nine Olympus quest monsters and then accepts, loots and turns in one quest at a time. It uses 1,000 HP potions and one Large Stamina Potion; other stamina potions and loot-to-level are disabled. Quest monsters stay protected from bulk looting until the run is complete, then the previous Auto Farm configuration is restored.',
      }),
    );
    ctx.container.appendChild(group);
  },
});
