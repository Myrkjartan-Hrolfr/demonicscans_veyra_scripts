'use strict';

const DEFAULT_MODE = 'autoplay';
const MODES = Object.freeze([
  Object.freeze({ id: 'autoplay', label: 'Game Auto Play' }),
  Object.freeze({ id: 'skill-planner', label: 'Solo PvP skill planner' }),
]);

function normalizeSettings(value) {
  const mode = MODES.some((candidate) => candidate.id === value?.mode) ? value.mode : DEFAULT_MODE;
  return { mode };
}

module.exports = Object.freeze({
  id: 'pvp',
  label: 'PvP',
  path: '/pvp.php',
  defaultLoopMinutes: 5,
  maxVisitMs: 30 * 60_000,
  initialDelayMs: 0,

  matchesUrl(url) {
    return /\/(?:pvp|pvp_battle)\.php\/?$/i.test(url.pathname);
  },

  createDefaultSettings() {
    return normalizeSettings(null);
  },

  normalizeSettings,

  renderSettings(ctx) {
    ctx.addSectionTitle('Battle mode');
    const group = ctx.make('div', { className: ctx.cls('setting') });
    const hintId = `${ctx.idPrefix}-mode-hint`;

    for (const mode of MODES) {
      const label = ctx.make('label', { className: ctx.cls('check') });
      const input = ctx.make('input', {
        id: `${ctx.idPrefix}-mode-${mode.id}`,
        type: 'radio',
      });
      input.name = `${ctx.idPrefix}-mode`;
      input.value = mode.id;
      input.checked = ctx.settings.mode === mode.id;
      input.setAttribute?.('aria-describedby', hintId);
      if (label.style) label.style.minHeight = '44px';
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const next = ctx.updateSettings((settings) => {
          settings.mode = mode.id;
        });
        ctx.settings.mode = next.mode;
      });
      label.appendChild(input);
      label.appendChild(ctx.make('span', { text: mode.label }));
      group.appendChild(label);
    }

    group.appendChild(
      ctx.make('div', {
        id: hintId,
        className: ctx.cls('hint'),
        text: "Game Auto Play uses the game's built-in automatic battle. Solo PvP skill planner uses the deliberate skill sequence from the PvP manager. The selected mode is used for every automated Solo PvP fight.",
      }),
    );
    ctx.container.appendChild(group);
  },
});
