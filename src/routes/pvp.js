'use strict';

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
});
