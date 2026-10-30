'use strict';

const { normalizeBossSettings, renderBossSettings } = require('./boss-settings');

const boss = (id, name, options = {}) => Object.freeze({
  id,
  name,
  defaultDamage: '1b',
  defaultEnabled: false,
  ...options,
});
const phasedBoss = (id, name) => boss(id, name, { phase3: true, defaultPhase3Damage: '0' });

// One scheduler page for all Olympus domains; a visit walks through them in
// this order. Each domain has a herald and its god.
const OLYMPUS_DOMAINS = Object.freeze([
  Object.freeze({
    id: 'outer',
    label: 'Olympus (outer)',
    wave: 9,
    bosses: Object.freeze([
      boss('oceanus', 'Oceanus The Water Titan'),
      boss('poseidon-emperor', 'Poseidon, The Sea Emperor'),
    ]),
  }),
  Object.freeze({
    id: 'hermes',
    label: 'Hermes',
    wave: 10,
    bosses: Object.freeze([
      boss('pan', 'Pan, Wild Herald of Hermes'),
      phasedBoss('hermes', 'Hermes, Divine Herald of the Endless Road'),
    ]),
  }),
  Object.freeze({
    id: 'artemis',
    label: 'Artemis',
    wave: 11,
    bosses: Object.freeze([
      boss('orion', 'Orion, Eternal Hunter of Artemis'),
      phasedBoss('artemis', 'Artemis, Divine Huntress of the Moonlit Wilds'),
    ]),
  }),
  Object.freeze({
    id: 'poseidon',
    label: 'Poseidon',
    wave: 12,
    bosses: Object.freeze([
      boss('triton', 'Triton, Herald of the Deep Crown'),
      phasedBoss('poseidon', 'Poseidon, Sovereign of the Drowned Steps'),
    ]),
  }),
  Object.freeze({
    id: 'ares',
    label: 'Ares',
    wave: 13,
    bosses: Object.freeze([
      boss('deimos', 'Deimos, Herald of Panic'),
      phasedBoss('ares', 'Ares, Sovereign of the Red Bastion'),
    ]),
  }),
  Object.freeze({
    id: 'apollo',
    label: 'Apollo',
    wave: 14,
    bosses: Object.freeze([
      boss('asclepius', 'Asclepius, Herald of Golden Mercy'),
      phasedBoss('apollo', 'Apollo, Sovereign of the Sun Basilica'),
    ]),
  }),
  Object.freeze({
    id: 'athena',
    label: 'Athena',
    wave: 15,
    bosses: Object.freeze([
      boss('nike', 'Nike, Herald of Unbroken Victory'),
      phasedBoss('athena', 'Athena, Sovereign of the Ivory War Library'),
    ]),
  }),
  Object.freeze({
    id: 'hera',
    label: 'Hera',
    wave: 16,
    bosses: Object.freeze([
      boss('nemesis', 'Nemesis, Herald of Reckoning'),
      phasedBoss('hera', 'Hera, Sovereign of the Crown Court'),
    ]),
  }),
  Object.freeze({
    id: 'zeus',
    label: 'Zeus',
    wave: 17,
    bosses: Object.freeze([
      boss('aeolus', 'Aeolus, Herald of Bound Winds'),
      phasedBoss('zeus', 'Zeus, Sovereign of the Storm Throne'),
    ]),
  }),
]);

const OLYMPUS_GATE = '5';
const OLYMPUS_BOSSES = Object.freeze(OLYMPUS_DOMAINS.flatMap((domain) => domain.bosses));

function domainPath(domain) {
  return `/active_wave.php?gate=${OLYMPUS_GATE}&wave=${domain.wave}`;
}

function domainForUrl(url) {
  if (!/\/active_wave\.php\/?$/i.test(url.pathname) || url.searchParams.get('gate') !== OLYMPUS_GATE) {
    return null;
  }
  const wave = Number(url.searchParams.get('wave'));
  return OLYMPUS_DOMAINS.find((domain) => domain.wave === wave) || null;
}

module.exports = Object.freeze({
  id: 'olympus',
  label: 'Olympus',
  path: domainPath(OLYMPUS_DOMAINS[0]),
  visitPathnames: Object.freeze(['/battle.php', '/pvp_style_battle.php']),
  defaultLoopMinutes: 30,
  maxVisitMs: 45 * 60_000,
  initialDelayMs: 5 * 60_000,
  OLYMPUS_DOMAINS,
  OLYMPUS_BOSSES,
  domainForUrl,
  domainPath,

  matchesUrl(url) {
    return Boolean(domainForUrl(url));
  },

  createDefaultSettings() {
    return normalizeBossSettings(null, OLYMPUS_BOSSES);
  },

  normalizeSettings(value) {
    return normalizeBossSettings(value, OLYMPUS_BOSSES);
  },

  renderSettings(ctx) {
    renderBossSettings(
      ctx,
      OLYMPUS_DOMAINS.map((domain) => ({ title: domain.label, bosses: domain.bosses })),
    );
  },
});
