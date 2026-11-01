'use strict';

const DEFAULT_FARM_MONSTERS = 90;
const MIN_FARM_MONSTERS = 1;
const MAX_FARM_MONSTERS = 100_000;

function normalizeFarmMonsterCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_FARM_MONSTERS;
  return Math.min(MAX_FARM_MONSTERS, Math.max(MIN_FARM_MONSTERS, number));
}

function normalizeSettings(value) {
  return {
    farmMonsterCount: normalizeFarmMonsterCount(value?.farmMonsterCount),
  };
}

module.exports = Object.freeze({
  DEFAULT_FARM_MONSTERS,
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

    const group = ctx.make('div', { className: ctx.cls('setting') });
    group.appendChild(
      ctx.make('div', {
        className: ctx.cls('hint'),
        text:
          'When quests are available, the worker resets a finished Auto Farm, enables all nine Olympus quest monsters, farms the configured total and then accepts, loots and turns in one quest at a time. It uses 1,000 HP potions and one Large Stamina Potion; other stamina potions and loot-to-level are disabled. Quest monsters stay protected from bulk looting until the run is complete, then the previous Auto Farm configuration is restored.',
      }),
    );
    ctx.container.appendChild(group);
  },
});
