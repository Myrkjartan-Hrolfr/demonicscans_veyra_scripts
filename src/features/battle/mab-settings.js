'use strict';

// Monster Auto Battle: persisted settings and the short-lived resume state.
// Storage keys are unchanged from the standalone userscript (v1.6.5), so
// saved settings carry over.

const ID = 'tm-monster-auto-battle';
const RESUME_TTL_MS = 60_000;
const POTION_TYPES = Object.freeze(['stamina', 'mana', 'health']);

const DEFAULTS = Object.freeze({
  attackKeys: ['', '', ''],
  poisonAttackKey: '',
  autoStamina: false,
  autoMana: false,
  autoHealth: false,
  stopBeforeLevelUp: false,
  levelMultiplier: 2,
  targetDamage: '0',
  delayMs: 100,
  collapsed: false,
  potionEnabled: {},
  potionUseAmount: {},
  potionOrder: { stamina: [], mana: [], health: [] },
});

function settingsKey(host, pathname) {
  return `${ID}:settings:v6:${host}:${pathname}`;
}

function resumeKey(host, pathname) {
  return `${ID}:resume:v3:${host}:${pathname}`;
}

function createDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) => (Array.isArray(value) ? value.map((entry) => String(entry ?? '')) : []);

// Turns whatever was saved into a complete settings object. Unknown extra
// keys are kept (like the original spread), broken values fall back.
function normalizeSettings(saved) {
  const source = isPlainObject(saved) ? saved : {};
  const settings = { ...createDefaultSettings(), ...source };

  const attackKeys = stringList(source.attackKeys).slice(0, 3);
  while (attackKeys.length < 3) attackKeys.push('');
  settings.attackKeys = attackKeys;
  settings.poisonAttackKey = typeof source.poisonAttackKey === 'string' ? source.poisonAttackKey : '';

  for (const flag of ['autoStamina', 'autoMana', 'autoHealth', 'stopBeforeLevelUp', 'collapsed']) {
    settings[flag] = source[flag] === true;
  }

  const target = source.targetDamage;
  settings.targetDamage =
    typeof target === 'string' || typeof target === 'number' ? String(target).trim() || '0' : '0';

  const delay = Number(source.delayMs);
  settings.delayMs = Number.isFinite(delay) && delay >= 0 ? delay : DEFAULTS.delayMs;

  const multiplier = Number(source.levelMultiplier);
  settings.levelMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : DEFAULTS.levelMultiplier;

  settings.potionEnabled = isPlainObject(source.potionEnabled) ? { ...source.potionEnabled } : {};
  settings.potionUseAmount = isPlainObject(source.potionUseAmount) ? { ...source.potionUseAmount } : {};
  settings.potionOrder = {};
  for (const type of POTION_TYPES) {
    settings.potionOrder[type] = stringList(source.potionOrder?.[type]);
  }
  return settings;
}

// storage: a Web Storage object (or null when unavailable).
function createSettingsStore(storage, key, warn = () => {}) {
  return {
    load() {
      try {
        return normalizeSettings(JSON.parse(storage?.getItem(key) || '{}'));
      } catch (error) {
        warn('Could not load settings.', error);
        return createDefaultSettings();
      }
    },
    save(settings) {
      try {
        storage?.setItem(key, JSON.stringify(settings));
      } catch (error) {
        warn('Could not save settings.', error);
      }
    },
  };
}

// Survives the page reload some potion uses cause, for at most a minute.
function createResumeStore(storage, key, now = () => Date.now()) {
  const store = {
    save(data) {
      try {
        storage?.setItem(key, JSON.stringify({ ...data, savedAt: now() }));
      } catch {
        // Ignore storage errors.
      }
    },
    load() {
      try {
        const raw = storage?.getItem(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data?.savedAt || now() - data.savedAt > RESUME_TTL_MS) {
          store.clear();
          return null;
        }
        return data;
      } catch {
        store.clear();
        return null;
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // Ignore storage errors.
      }
    },
  };
  return store;
}

module.exports = {
  DEFAULTS,
  ID,
  POTION_TYPES,
  RESUME_TTL_MS,
  createDefaultSettings,
  createResumeStore,
  createSettingsStore,
  normalizeSettings,
  resumeKey,
  settingsKey,
};
