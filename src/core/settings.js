'use strict';

// Feature settings are stored one value per localStorage key as JSON, the
// same format veyra-hud's Storage.get/set used. Keeping its keys
// ("ui-improvements:*") preserves existing user settings.

const SETTING_TYPES = Object.freeze(['checkbox', 'number', 'text', 'select']);

function coerceSetting(definition, value) {
  const fallback = definition.default;
  switch (definition.type) {
    case 'checkbox':
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      return fallback;
    case 'number': {
      const number = Number(value);
      if (value === '' || value === null || !Number.isFinite(number)) return fallback;
      const min = definition.min ?? -Infinity;
      const max = definition.max ?? Infinity;
      return Math.min(max, Math.max(min, number));
    }
    case 'select': {
      const allowed = (definition.options || []).map((option) => String(option.value));
      return allowed.includes(String(value)) ? String(value) : fallback;
    }
    default:
      return value === null || value === undefined ? fallback : String(value);
  }
}

function createSettingsStore(store) {
  return {
    get(definition) {
      const raw = store.read(definition.key);
      return raw === null || raw === undefined ? definition.default : coerceSetting(definition, raw);
    },

    set(definition, value) {
      const coerced = coerceSetting(definition, value);
      store.write(definition.key, coerced);
      return coerced;
    },
  };
}

module.exports = {
  SETTING_TYPES,
  coerceSetting,
  createSettingsStore,
};
