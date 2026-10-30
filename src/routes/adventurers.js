'use strict';

function normalizeSettings() {
  return {};
}

module.exports = Object.freeze({
  id: 'adventurers',
  label: "Adventurer's Guild",
  path: '/adventurers_guild.php?veyra_route=adventurers',
  defaultEnabled: false,
  defaultLoopMinutes: 5,
  maxVisitMs: 2 * 60 * 60_000,
  initialDelayMs: 10 * 60_000,

  matchesUrl(url) {
    return (
      /\/adventurers_guild\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('veyra_route') === 'adventurers'
    );
  },

  createDefaultSettings: normalizeSettings,
  normalizeSettings,

  renderSettings(ctx) {
    ctx.addSectionTitle('Quest automation');
    const group = ctx.make('div', { className: ctx.cls('setting') });
    group.appendChild(
      ctx.make('div', {
        className: ctx.cls('hint'),
        text:
          'The worker first farms every currently available Olympus quest target, then accepts, loots and turns in one quest at a time. Quest monsters stay protected from every bulk-loot feature until the run is complete. Auto Farm settings are restored afterwards.',
      }),
    );
    ctx.container.appendChild(group);
  },
});
