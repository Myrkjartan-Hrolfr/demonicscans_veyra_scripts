'use strict';

const { normalizeDamageTarget } = require('../core/numbers');

const DEFAULT_DAMAGE = '1m';
const DEFAULT_ATTACK_COOLDOWN_MS = 100;
const MIN_ATTACK_COOLDOWN_MS = 100;
const MAX_ATTACK_COOLDOWN_MS = 2_000;

const CRUCIBLE_SKILLS = Object.freeze([
  Object.freeze({ id: '0', name: 'Slash', cost: 1 }),
  Object.freeze({ id: '-1', name: 'Power Slash', cost: 10 }),
  Object.freeze({ id: '-2', name: 'Heroic Slash', cost: 50 }),
  Object.freeze({ id: '-3', name: 'Ultimate Slash', cost: 100 }),
  Object.freeze({ id: '-4', name: 'Legendary Slash', cost: 200 }),
]);

const CRUCIBLE_PVE_NODES = Object.freeze(
  [
    {
      id: 'gate_prism',
      name: 'Gate Prism',
      faceName: 'Prism Gate',
      locationId: '11',
      monsters: ['Prismblade Reaver', 'Mireglass Stalker', 'Siege-Root Howler'],
    },
    {
      id: 'ash_lane',
      name: 'Ash Lane',
      faceName: 'Ash Lane',
      locationId: '12',
      monsters: ['Null Choir Adept', 'Calibration Warden', 'Bastion Iterant', 'Polyhedral Devourer'],
    },
    {
      id: 'crown_lens',
      name: 'Crown Lens',
      faceName: 'Crown of Calibration',
      locationId: '13',
      // This node was still hidden in the supplied page capture. Its live
      // monster names are discovered and persisted by the worker instead of
      // guessing identifiers that the game may later change.
      monsters: [],
    },
    {
      id: 'zenith_lock',
      name: 'Zenith Lock',
      faceName: 'Apex',
      locationId: '14',
      isApex: true,
      // The apex was locked in the supplied capture. Its live boss name is
      // discovered from location 14 and inherits this node's configured mode.
      monsters: [],
    },
  ].map((node) =>
    Object.freeze({
      ...node,
      monsters: Object.freeze([...node.monsters]),
    }),
  ),
);

const CRUCIBLE_PVP_NODES = Object.freeze([
  Object.freeze({ id: 'ring_ward', name: 'Ring Ward' }),
  Object.freeze({ id: 'duel_heart', name: 'Duel Heart' }),
  Object.freeze({ id: 'tyrant_conclave', name: 'Tyrant Conclave' }),
]);

const CRUCIBLE_ARMY_NODES = Object.freeze([
  Object.freeze({ id: 'veil_post', name: 'Veil Post' }),
  Object.freeze({ id: 'captain_spine', name: 'Captain Spine' }),
  Object.freeze({ id: 'abyssal_muster', name: 'Abyssal Muster' }),
]);

const CRUCIBLE_ARMY_SHADOWS = Object.freeze([
  Object.freeze({ id: '5', name: 'Drakzareth The Tyrant' }),
  Object.freeze({ id: '3', name: 'Vessir the Sunfang Duelist' }),
  Object.freeze({ id: '4', name: 'Hrazz the Dawnflame Oathkeeper' }),
  Object.freeze({ id: '2', name: 'Skarn the Radiant General' }),
  Object.freeze({ id: '6', name: 'Malreth the Corruptor' }),
]);

const PVE_MODES = Object.freeze([
  Object.freeze({ id: 'max-loot', label: 'Max loot (read live)' }),
  Object.freeze({ id: 'max-exp', label: 'Max experience (read live)' }),
  Object.freeze({ id: 'kill', label: 'Kill monster' }),
  Object.freeze({ id: 'custom', label: 'Custom damage' }),
]);

const ARMY_MODES = Object.freeze([
  Object.freeze({ id: 'minimal', label: 'Minimal (one hit, then retreat)' }),
  Object.freeze({ id: 'kill', label: 'Kill (all available captains)' }),
]);

const PVE_NODE_IDS = new Set(CRUCIBLE_PVE_NODES.map((node) => node.id));
const SKILL_IDS = new Set(CRUCIBLE_SKILLS.map((skill) => skill.id));
const PVE_MODE_IDS = new Set(PVE_MODES.map((mode) => mode.id));
const ARMY_MODE_IDS = new Set(ARMY_MODES.map((mode) => mode.id));

function slug(value) {
  return String(value ?? '')
    .normalize?.('NFKD')
    ?.replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || '';
}

function targetIdForMonster(nodeId, name) {
  const node = String(nodeId || '').trim();
  const monster = slug(name);
  return PVE_NODE_IDS.has(node) && monster ? `${node}:${monster}` : '';
}

const CRUCIBLE_PVE_MONSTERS = Object.freeze(
  CRUCIBLE_PVE_NODES.flatMap((node) =>
    node.monsters.map((name) =>
      Object.freeze({
        id: targetIdForMonster(node.id, name),
        nodeId: node.id,
        name,
        discovered: false,
      }),
    ),
  ),
);
const CANONICAL_TARGET_IDS = new Set(CRUCIBLE_PVE_MONSTERS.map((monster) => monster.id));

function normalizeCooldown(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_ATTACK_COOLDOWN_MS;
  return Math.min(MAX_ATTACK_COOLDOWN_MS, Math.max(MIN_ATTACK_COOLDOWN_MS, number));
}

function normalizeTarget(value, fallback = null) {
  const fallbackMode = PVE_MODE_IDS.has(fallback?.mode) ? fallback.mode : 'max-loot';
  const fallbackDamage = normalizeDamageTarget(fallback?.damage, DEFAULT_DAMAGE);
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : fallback?.enabled !== false,
    mode: PVE_MODE_IDS.has(value?.mode) ? value.mode : fallbackMode,
    damage: normalizeDamageTarget(value?.damage, fallbackDamage),
  };
}

function normalizeDiscovery(value) {
  const nodeId = String(value?.nodeId || '').trim();
  const name = String(value?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const id = targetIdForMonster(nodeId, name);
  if (!id || CANONICAL_TARGET_IDS.has(id)) return null;
  return { id, nodeId, name, discovered: true };
}

function normalizeDiscoveries(value) {
  const discoveries = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const discovery = normalizeDiscovery(raw);
    if (!discovery || seen.has(discovery.id)) continue;
    seen.add(discovery.id);
    discoveries.push(discovery);
    if (discoveries.length >= 100) break;
  }
  return discoveries;
}

function monsterDefinitions(settings) {
  return [...CRUCIBLE_PVE_MONSTERS, ...normalizeDiscoveries(settings?.discoveredMonsters)];
}

function normalizeArmyShadow(value) {
  const id = String(value?.id ?? value?.shadowId ?? value?.shadow_id ?? '').trim();
  const name = String(value?.name || value?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!/^\d+$/.test(id) || Number(id) <= 0 || !name) return null;
  return { id, name };
}

function normalizeArmyShadows(value) {
  const shadows = [];
  const seen = new Set();
  for (const raw of [...CRUCIBLE_ARMY_SHADOWS, ...(Array.isArray(value) ? value : [])]) {
    const shadow = normalizeArmyShadow(raw);
    if (!shadow || seen.has(shadow.id)) continue;
    seen.add(shadow.id);
    shadows.push(shadow);
    if (shadows.length >= 50) break;
  }
  return shadows;
}

function normalizeSettings(value) {
  const nodeDefaults = {};
  for (const node of CRUCIBLE_PVE_NODES) {
    nodeDefaults[node.id] = normalizeTarget(value?.nodeDefaults?.[node.id]);
  }

  const discoveredMonsters = normalizeDiscoveries(value?.discoveredMonsters);
  const targets = {};
  for (const definition of [...CRUCIBLE_PVE_MONSTERS, ...discoveredMonsters]) {
    targets[definition.id] = normalizeTarget(value?.targets?.[definition.id], nodeDefaults[definition.nodeId]);
  }

  const skill = String(value?.skill ?? '0');
  const armyMode = String(value?.army?.mode || 'minimal');
  const armyShadows = normalizeArmyShadows(value?.army?.shadows);
  const validShadowIds = new Set(armyShadows.map((shadow) => shadow.id));
  const selectedSource = Array.isArray(value?.army?.selectedShadowIds)
    ? value.army.selectedShadowIds
    : armyShadows.map((shadow) => shadow.id);
  const selectedShadowIds = [...new Set(selectedSource.map(String))].filter((id) => validShadowIds.has(id));
  return {
    pveEnabled: value?.pveEnabled !== false,
    skill: SKILL_IDS.has(skill) ? skill : '0',
    attackCooldownMs: normalizeCooldown(value?.attackCooldownMs),
    nodeDefaults,
    discoveredMonsters,
    targets,
    pvp: { enabled: value?.pvp?.enabled !== false },
    army: {
      enabled: value?.army?.enabled !== false,
      mode: ARMY_MODE_IDS.has(armyMode) ? armyMode : 'minimal',
      shadows: armyShadows,
      selectedShadowIds,
    },
  };
}

function mergeDiscoveredMonsters(value, discoveries) {
  const settings = normalizeSettings(value);
  const existing = new Set(settings.discoveredMonsters.map((monster) => monster.id));
  let changed = false;
  for (const raw of Array.isArray(discoveries) ? discoveries : []) {
    const discovery = normalizeDiscovery(raw);
    if (!discovery || existing.has(discovery.id)) continue;
    existing.add(discovery.id);
    settings.discoveredMonsters.push(discovery);
    settings.targets[discovery.id] = normalizeTarget(null, settings.nodeDefaults[discovery.nodeId]);
    changed = true;
  }
  return { changed, settings: normalizeSettings(settings) };
}

function mergeDiscoveredShadows(value, discoveries) {
  const settings = normalizeSettings(value);
  const existing = new Set(settings.army.shadows.map((shadow) => shadow.id));
  let changed = false;
  for (const raw of Array.isArray(discoveries) ? discoveries : []) {
    const shadow = normalizeArmyShadow(raw);
    if (!shadow || existing.has(shadow.id)) continue;
    existing.add(shadow.id);
    settings.army.shadows.push(shadow);
    changed = true;
  }
  return { changed, settings: normalizeSettings(settings) };
}

function settingsForMonster(settingsValue, nodeId, name) {
  const settings = normalizeSettings(settingsValue);
  const id = targetIdForMonster(nodeId, name);
  return {
    id,
    target: settings.targets[id] || settings.nodeDefaults[nodeId] || null,
    known: Boolean(settings.targets[id]),
  };
}

function setTouchSize(element) {
  if (element?.style) element.style.minHeight = '44px';
}

function renderSettings(ctx) {
  ctx.addSectionTitle('PvE');
  const pveGeneral = ctx.make('div', { className: ctx.cls('setting') });
  ctx.addCheckbox({
    id: 'pve-enabled',
    label: 'Enable PvE automation',
    checked: ctx.settings.pveEnabled,
    parent: pveGeneral,
    onChange(checked) {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.pveEnabled = checked;
      });
    },
  });

  const skillLabel = ctx.make('label', { text: 'Attack skill' });
  const skillId = `${ctx.idPrefix}-pve-skill`;
  skillLabel.setAttribute?.('for', skillId);
  const skillSelect = ctx.make('select', { id: skillId, className: ctx.cls('select') });
  for (const skill of CRUCIBLE_SKILLS) {
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
  pveGeneral.appendChild(skillLabel);
  pveGeneral.appendChild(skillSelect);
  pveGeneral.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: 'Loot and experience caps are read from each live battle page immediately before attacking.',
    }),
  );
  ctx.container.appendChild(pveGeneral);

  const cooldownInput = ctx.addTextInput({
    id: 'pve-attack-cooldown-ms',
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

  function updateTarget(kind, key, mutator) {
    ctx.settings = ctx.updateSettings((settings) => {
      const target = kind === 'default' ? settings.nodeDefaults[key] : settings.targets[key];
      if (target) mutator(target);
    });
    return kind === 'default' ? ctx.settings.nodeDefaults[key] : ctx.settings.targets[key];
  }

  function createTargetCard(definition, kind = 'target') {
    const key = kind === 'default' ? definition.nodeId : definition.id;
    const target = kind === 'default' ? ctx.settings.nodeDefaults[key] : ctx.settings.targets[key];
    const domKey = String(key).replace(/[^\w-]+/g, '-');
    const card = ctx.make('div', {
      id: `${ctx.idPrefix}-pve-target-${domKey}`,
      className: ctx.cls('setting'),
    });
    card.appendChild(ctx.make('div', { className: ctx.cls('setting-label'), text: definition.name }));

    const enabledLabel = ctx.make('label', { className: ctx.cls('check') });
    const enabled = ctx.make('input', {
      id: `${ctx.idPrefix}-pve-target-${domKey}-enabled`,
      type: 'checkbox',
    });
    enabled.checked = target.enabled;
    enabled.addEventListener('change', () => {
      updateTarget(kind, key, (next) => {
        next.enabled = enabled.checked;
      });
    });
    enabledLabel.appendChild(enabled);
    enabledLabel.appendChild(
      ctx.make('span', { text: kind === 'default' ? 'Use for newly discovered monsters' : 'Attack this monster' }),
    );
    setTouchSize(enabledLabel);
    card.appendChild(enabledLabel);

    const modeLabel = ctx.make('label', { text: 'Damage mode' });
    const modeId = `${ctx.idPrefix}-pve-target-${domKey}-mode`;
    modeLabel.setAttribute?.('for', modeId);
    const mode = ctx.make('select', { id: modeId, className: ctx.cls('select') });
    for (const optionDefinition of PVE_MODES) {
      const option = ctx.make('option', { text: optionDefinition.label });
      option.value = optionDefinition.id;
      mode.appendChild(option);
    }
    mode.value = target.mode;
    setTouchSize(mode);
    card.appendChild(modeLabel);
    card.appendChild(mode);

    const damageGroup = ctx.make('div');
    const damageId = `${ctx.idPrefix}-pve-target-${domKey}-damage`;
    const damageLabel = ctx.make('label', { text: 'Custom damage target' });
    damageLabel.setAttribute?.('for', damageId);
    const damage = ctx.make('input', { id: damageId, className: ctx.cls('input'), type: 'text' });
    damage.value = target.damage;
    damage.placeholder = 'e.g. 3m';
    damage.inputMode = 'decimal';
    damage.autocomplete = 'off';
    damageGroup.hidden = target.mode !== 'custom';
    damageGroup.appendChild(damageLabel);
    damageGroup.appendChild(damage);
    card.appendChild(damageGroup);

    mode.addEventListener('change', () => {
      const next = updateTarget(kind, key, (settings) => {
        settings.mode = mode.value;
      });
      mode.value = next.mode;
      damageGroup.hidden = next.mode !== 'custom';
    });
    damage.addEventListener('change', () => {
      const next = updateTarget(kind, key, (settings) => {
        settings.damage = damage.value;
      });
      damage.value = next.damage;
    });
    return card;
  }

  const definitions = monsterDefinitions(ctx.settings);
  for (const node of CRUCIBLE_PVE_NODES) {
    const nodeCard = ctx.make('div', { className: ctx.cls('setting') });
    nodeCard.appendChild(
      ctx.make('div', {
        className: ctx.cls('setting-label'),
        text: `${node.faceName} · ${node.name}${node.isApex ? ' (Apex boss)' : ''}`,
      }),
    );
    nodeCard.appendChild(
      ctx.make('div', {
        className: ctx.cls('hint'),
        text: `Location ${node.locationId}. New live monster names inherit the default below and are saved individually.`,
      }),
    );
    ctx.container.appendChild(nodeCard);
    for (const definition of definitions.filter((monster) => monster.nodeId === node.id)) {
      const label = definition.discovered ? `${definition.name} (discovered)` : definition.name;
      ctx.container.appendChild(createTargetCard({ ...definition, name: label }));
    }
    ctx.container.appendChild(
      createTargetCard(
        { nodeId: node.id, name: `${node.name}: newly discovered monster default` },
        'default',
      ),
    );
  }

  ctx.addSectionTitle('PvP');
  const pvpGroup = ctx.make('div', { className: ctx.cls('setting') });
  ctx.addCheckbox({
    id: 'pvp-enabled',
    label: 'Enable Crucible PvP nodes',
    checked: ctx.settings.pvp.enabled,
    parent: pvpGroup,
    onChange(checked) {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.pvp.enabled = checked;
      });
    },
  });
  pvpGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: 'Uses Ring Ward, Duel Heart and Tyrant Conclave. The fullest open match is preferred.',
    }),
  );
  ctx.container.appendChild(pvpGroup);

  ctx.addSectionTitle('Army');
  const armyGroup = ctx.make('div', { className: ctx.cls('setting') });
  ctx.addCheckbox({
    id: 'army-enabled',
    label: 'Enable Crucible Army nodes',
    checked: ctx.settings.army.enabled,
    parent: armyGroup,
    onChange(checked) {
      ctx.settings = ctx.updateSettings((settings) => {
        settings.army.enabled = checked;
      });
    },
  });
  const armyModeLabel = ctx.make('label', { text: 'Army damage mode' });
  const armyModeId = `${ctx.idPrefix}-army-mode`;
  armyModeLabel.setAttribute?.('for', armyModeId);
  const armyMode = ctx.make('select', { id: armyModeId, className: ctx.cls('select') });
  for (const definition of ARMY_MODES) {
    const option = ctx.make('option', { text: definition.label });
    option.value = definition.id;
    armyMode.appendChild(option);
  }
  armyMode.value = ctx.settings.army.mode;
  setTouchSize(armyMode);
  armyMode.addEventListener('change', () => {
    ctx.settings = ctx.updateSettings((settings) => {
      settings.army.mode = armyMode.value;
    });
    armyMode.value = ctx.settings.army.mode;
  });
  armyGroup.appendChild(armyModeLabel);
  armyGroup.appendChild(armyMode);
  armyGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: 'Minimal assigns one captain until a hit is verified, then retreats it. Kill assigns every available captain.',
    }),
  );

  armyGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('setting-label'),
      text: 'Shadows used by the automation formation',
    }),
  );
  for (const shadow of ctx.settings.army.shadows) {
    ctx.addCheckbox({
      id: `army-shadow-${shadow.id}`,
      label: shadow.name,
      checked: ctx.settings.army.selectedShadowIds.includes(shadow.id),
      parent: armyGroup,
      onChange(checked) {
        ctx.settings = ctx.updateSettings((settings) => {
          const selected = new Set(settings.army.selectedShadowIds);
          if (checked) selected.add(shadow.id);
          else selected.delete(shadow.id);
          settings.army.selectedShadowIds = [...selected];
        });
      },
    });
  }
  armyGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: 'The game still joins with its saved formation. The worker keeps only the selected special Shadows active and retreats unselected captains before assigning targets. Newly owned Shadows are discovered on the Shadow Army page and appear here unchecked.',
    }),
  );
  ctx.container.appendChild(armyGroup);
}

module.exports = Object.freeze({
  id: 'crucible',
  label: 'The Polyhedral Crucible',
  path: '/guild_dungeon.php?veyra_route=crucible',
  defaultEnabled: false,
  visitPathnames: Object.freeze([
    '/guild_dungeon_cube.php',
    '/guild_dungeon_location.php',
    '/battle.php',
    '/pvp_style_node.php',
    '/pvp_style_battle.php',
    '/guild_dungeon_cube_army_enter.php',
    '/shadow_army_live_battle.php',
    '/shadow_army.php',
  ]),
  defaultLoopMinutes: 5,
  maxVisitMs: 60 * 60_000,
  initialDelayMs: 15 * 60_000,
  ARMY_MODES,
  CRUCIBLE_ARMY_NODES,
  CRUCIBLE_ARMY_SHADOWS,
  CRUCIBLE_PVE_MONSTERS,
  CRUCIBLE_PVE_NODES,
  CRUCIBLE_PVP_NODES,
  CRUCIBLE_SKILLS,
  PVE_MODES,
  mergeDiscoveredMonsters,
  mergeDiscoveredShadows,
  monsterDefinitions,
  settingsForMonster,
  targetIdForMonster,

  matchesUrl(url) {
    return (
      /\/guild_dungeon\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('veyra_route') === 'crucible'
    );
  },

  createDefaultSettings() {
    return normalizeSettings(null);
  },

  normalizeSettings,
  renderSettings,
});
