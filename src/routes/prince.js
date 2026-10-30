'use strict';

const { normalizeDamageTarget } = require('../core/numbers');
const shadowbridge = require('./shadowbridge');

const DUNGEON_NAME = 'Castle of the Fallen Prince';
const DEFAULT_DAMAGE = '1m';
const DEFAULT_ATTACK_COOLDOWN_MS = 100;
const MIN_ATTACK_COOLDOWN_MS = 100;
const MAX_ATTACK_COOLDOWN_MS = 2_000;

// Room names are stable configuration keys. Instance and battle ids are
// deliberately absent: both are discovered again during every scheduler run.
const PRINCE_TARGETS = Object.freeze(
  [
    ['vizier-hall', "The Vizier's Conspiracy Hall", 'The Goblin Royal Vizier', false],
    ['bloodbound-hall', 'Hall of the Bloodbound', '', false],
    ['beasts-room', 'Room of Beasts', '', false],
    ['dead-crown-room', 'Room of the Dead Crown', '', false],
    ['true-heir-throne', 'The True Heir Throne', '', true],
  ].map(([id, locationName, knownMonsterName, isBoss]) =>
    Object.freeze({ id, locationName, knownMonsterName, isBoss }),
  ),
);

const SKILL_ID_SET = new Set(shadowbridge.SHADOWBRIDGE_SKILLS.map((skill) => skill.id));
const DAMAGE_MODES = Object.freeze([
  Object.freeze({ id: 'max-damage', label: 'Max damage (current max HP)' }),
  Object.freeze({ id: 'kill', label: 'Kill monster' }),
  Object.freeze({ id: 'custom', label: 'Custom damage' }),
]);
const DAMAGE_MODE_SET = new Set(DAMAGE_MODES.map((mode) => mode.id));

function normalizedText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function targetForLocation(location) {
  const label = normalizedText(location?.label);
  if (!label) return null;
  return PRINCE_TARGETS.find((target) => label.includes(normalizedText(target.locationName))) || null;
}

function normalizeCooldown(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_ATTACK_COOLDOWN_MS;
  return Math.min(MAX_ATTACK_COOLDOWN_MS, Math.max(MIN_ATTACK_COOLDOWN_MS, number));
}

function normalizeMonsterName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name && name.length <= 160 ? name : '';
}

function normalizeTarget(value) {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    mode: DAMAGE_MODE_SET.has(value?.mode) ? value.mode : 'max-damage',
    damage: normalizeDamageTarget(value?.damage, DEFAULT_DAMAGE),
  };
}

function normalizeSettings(value) {
  const targets = {};
  const discoveredNames = {};
  for (const definition of PRINCE_TARGETS) {
    targets[definition.id] = normalizeTarget(value?.targets?.[definition.id]);
    discoveredNames[definition.id] =
      normalizeMonsterName(value?.discoveredNames?.[definition.id]) || definition.knownMonsterName;
  }
  const skill = String(value?.skill ?? '0');
  return {
    targets,
    discoveredNames,
    skill: SKILL_ID_SET.has(skill) ? skill : '0',
    attackCooldownMs: normalizeCooldown(value?.attackCooldownMs),
  };
}

function mergeDiscoveredMonsters(settings, scans = []) {
  const merged = normalizeSettings(settings);
  let changed = false;
  for (const scan of scans) {
    const definition = targetForLocation(scan?.location);
    const name = normalizeMonsterName(scan?.monsters?.find((monster) => !monster.dead)?.name || scan?.monsters?.[0]?.name);
    if (!definition || !name || merged.discoveredNames[definition.id] === name) continue;
    merged.discoveredNames[definition.id] = name;
    changed = true;
  }
  return { changed, settings: merged };
}

function settingsForLocation(settings, location) {
  const definition = targetForLocation(location);
  if (!definition) return null;
  const normalized = normalizeSettings(settings);
  return {
    definition,
    target: normalized.targets[definition.id],
    displayName: normalized.discoveredNames[definition.id] || `Monster in ${definition.locationName}`,
  };
}

function setTouchSize(element) {
  if (element?.style) element.style.minHeight = '44px';
}

function renderSettings(ctx) {
  ctx.addSectionTitle('Combat');
  const skillGroup = ctx.make('div', { className: ctx.cls('setting') });
  const skillLabel = ctx.make('label', { text: 'Attack skill' });
  const skillId = `${ctx.idPrefix}-skill`;
  skillLabel.setAttribute?.('for', skillId);
  const skillSelect = ctx.make('select', { id: skillId, className: ctx.cls('select') });
  for (const skill of shadowbridge.SHADOWBRIDGE_SKILLS) {
    const option = ctx.make('option', { text: `${skill.name} (${skill.cost} stamina)` });
    option.value = skill.id;
    skillSelect.appendChild(option);
  }
  skillSelect.value = ctx.settings.skill;
  setTouchSize(skillSelect);
  skillSelect.addEventListener('change', () => {
    ctx.settings = ctx.updateSettings((settings) => {
      settings.skill = skillSelect.value;
    });
    skillSelect.value = ctx.settings.skill;
  });
  skillGroup.appendChild(skillLabel);
  skillGroup.appendChild(skillSelect);
  skillGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: 'Instance id, monster battle id and maximum HP are always read from the currently active dungeon.',
    }),
  );
  ctx.container.appendChild(skillGroup);

  const cooldownInput = ctx.addTextInput({
    id: 'attack-cooldown-ms',
    label: 'Attack cooldown (ms)',
    value: ctx.settings.attackCooldownMs,
    type: 'number',
    inputMode: 'numeric',
    onChange(value) {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.attackCooldownMs = value;
      });
      return ctx.settings.attackCooldownMs;
    },
  });
  cooldownInput.min = String(MIN_ATTACK_COOLDOWN_MS);
  cooldownInput.max = String(MAX_ATTACK_COOLDOWN_MS);
  cooldownInput.step = '10';

  ctx.addSectionTitle('Five monsters');
  for (const definition of PRINCE_TARGETS) {
    const target = ctx.settings.targets[definition.id];
    const discoveredName = ctx.settings.discoveredNames[definition.id];
    const card = ctx.make('div', {
      id: `${ctx.idPrefix}-target-${definition.id}`,
      className: ctx.cls('setting'),
    });
    card.appendChild(
      ctx.make('div', {
        className: ctx.cls('setting-label'),
        text: discoveredName || `Monster in ${definition.locationName}`,
      }),
    );
    card.appendChild(
      ctx.make('div', {
        className: ctx.cls('hint'),
        text: `${definition.locationName}${definition.isBoss ? ' (Boss)' : ''}`,
      }),
    );

    const enabledLabel = ctx.make('label', { className: ctx.cls('check') });
    const enabledInput = ctx.make('input', {
      id: `${ctx.idPrefix}-target-${definition.id}-enabled`,
      type: 'checkbox',
    });
    enabledInput.checked = target.enabled;
    enabledInput.addEventListener('change', () => {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.targets[definition.id].enabled = enabledInput.checked;
      });
    });
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(ctx.make('span', { text: 'Attack this monster' }));
    card.appendChild(enabledLabel);

    const modeId = `${ctx.idPrefix}-target-${definition.id}-mode`;
    const modeLabel = ctx.make('label', { text: 'Damage mode' });
    modeLabel.setAttribute?.('for', modeId);
    const modeSelect = ctx.make('select', { id: modeId, className: ctx.cls('select') });
    for (const mode of DAMAGE_MODES) {
      const option = ctx.make('option', { text: mode.label });
      option.value = mode.id;
      modeSelect.appendChild(option);
    }
    modeSelect.value = target.mode;
    setTouchSize(modeSelect);
    card.appendChild(modeLabel);
    card.appendChild(modeSelect);

    const damageGroup = ctx.make('div');
    const damageId = `${ctx.idPrefix}-target-${definition.id}-damage`;
    const damageLabel = ctx.make('label', { text: 'Custom damage target' });
    damageLabel.setAttribute?.('for', damageId);
    const damageInput = ctx.make('input', {
      id: damageId,
      className: ctx.cls('input'),
      type: 'text',
    });
    damageInput.value = target.damage;
    damageInput.placeholder = 'e.g. 3m';
    damageInput.inputMode = 'decimal';
    damageGroup.hidden = target.mode !== 'custom';
    damageGroup.appendChild(damageLabel);
    damageGroup.appendChild(damageInput);
    card.appendChild(damageGroup);

    modeSelect.addEventListener('change', () => {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.targets[definition.id].mode = modeSelect.value;
      });
      modeSelect.value = ctx.settings.targets[definition.id].mode;
      damageGroup.hidden = modeSelect.value !== 'custom';
    });
    damageInput.addEventListener('change', () => {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.targets[definition.id].damage = damageInput.value;
      });
      damageInput.value = ctx.settings.targets[definition.id].damage;
    });
    ctx.container.appendChild(card);
  }
}

module.exports = Object.freeze({
  id: 'prince',
  label: DUNGEON_NAME,
  path: '/guild_dungeon.php?veyra_route=prince',
  defaultEnabled: false,
  visitPathnames: Object.freeze([
    '/guild_dungeon_instance.php',
    '/guild_dungeon_location.php',
    '/battle.php',
  ]),
  defaultLoopMinutes: 30,
  maxVisitMs: 60 * 60_000,
  initialDelayMs: 10 * 60_000,
  DAMAGE_MODES,
  DUNGEON_NAME,
  PRINCE_TARGETS,
  mergeDiscoveredMonsters,
  settingsForLocation,
  targetForLocation,

  matchesUrl(url) {
    return (
      /\/guild_dungeon\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('veyra_route') === 'prince'
    );
  },

  createDefaultSettings() {
    return normalizeSettings(null);
  },

  normalizeSettings,
  renderSettings,
});
