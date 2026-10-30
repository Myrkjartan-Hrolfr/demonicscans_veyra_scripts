'use strict';

const { normalizeDamageTarget } = require('../core/numbers');

const DEFAULT_DAMAGE = '1m';
const DEFAULT_ATTACK_COOLDOWN_MS = 100;
const MIN_ATTACK_COOLDOWN_MS = 100;
const MAX_ATTACK_COOLDOWN_MS = 2_000;

const SHADOWBRIDGE_MONSTERS = Object.freeze(
  [
    ['talla-flint-stem', 'Talla Flint-Stem'],
    ['gribble-junk-magus', 'Gribble Junk-Magus'],
    ['pip-tanglefoot', 'Pip Tanglefoot'],
    ['rukka-the-wolf-raider', 'Rukka The Wolf Raider'],
    ['gorvash-the-stone-ram', 'Gorvash the Stone-Ram'],
    ['droknar-night-blade', 'Droknar Night-Blade'],
    ['nib-wickfingers', 'Nib Wickfingers'],
    ['shagra-bone-singer', 'Shagra Bone-Singer'],
    ['vorga-ash-shaman', 'Vorga Ash-Shaman'],
    ['brog-skull', 'Brog Skull'],
    ['hruk-forge-eater', 'Hruk Forge-Eater'],
    ['krak-one-horn', 'Krak One-Horn'],
    ['makra-the-mireborn', 'Makra the Mireborn'],
    ['orc-stone-rend', 'Orc Stone-Rend'],
    ['skrit-gear', 'Skrit Gear'],
    ['tharka-blood-howl', 'Tharka Blood-Howl'],
    ['urzul-iron-tusks', 'Urzul Iron-Tusks'],
    ['zorgra-frost-vein', 'Zorgra Frost-Vein'],
  ].map(([id, name]) => Object.freeze({ id, name })),
);

const SHADOWBRIDGE_BOSS_ROOM = Object.freeze({ id: 'boss-room', name: 'Boss Room' });

const SHADOWBRIDGE_SKILLS = Object.freeze([
  Object.freeze({ id: '0', name: 'Slash', cost: 1 }),
  Object.freeze({ id: '-1', name: 'Power Slash', cost: 10 }),
  Object.freeze({ id: '-2', name: 'Heroic Slash', cost: 50 }),
  Object.freeze({ id: '-3', name: 'Ultimate Slash', cost: 100 }),
  Object.freeze({ id: '-4', name: 'Legendary Slash', cost: 200 }),
]);

const NORMAL_MODES = Object.freeze([
  Object.freeze({ id: 'max-loot', label: 'Max loot (read live)' }),
  Object.freeze({ id: 'kill', label: 'Kill monster' }),
  Object.freeze({ id: 'custom', label: 'Custom damage' }),
]);

const BOSS_MODES = Object.freeze([
  NORMAL_MODES[0],
  Object.freeze({ id: 'max-exp', label: 'Max experience (read live)' }),
  Object.freeze({ id: 'kill', label: 'Kill boss' }),
  NORMAL_MODES[2],
]);

const MONSTER_IDS = Object.freeze(SHADOWBRIDGE_MONSTERS.map((monster) => monster.id));
const MONSTER_ID_SET = new Set(MONSTER_IDS);
const SKILL_ID_SET = new Set(SHADOWBRIDGE_SKILLS.map((skill) => skill.id));

function normalizeOrder(value) {
  const order = [];
  const seen = new Set();
  for (const rawId of Array.isArray(value) ? value : []) {
    const id = String(rawId);
    if (!MONSTER_ID_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of MONSTER_IDS) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

function normalizeCooldown(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_ATTACK_COOLDOWN_MS;
  return Math.min(MAX_ATTACK_COOLDOWN_MS, Math.max(MIN_ATTACK_COOLDOWN_MS, number));
}

function normalizeTarget(value, allowedModes) {
  const mode = allowedModes.some((candidate) => candidate.id === value?.mode) ? value.mode : 'max-loot';
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    mode,
    damage: normalizeDamageTarget(value?.damage, DEFAULT_DAMAGE),
  };
}

function normalizeSettings(value) {
  const monsters = {};
  for (const monster of SHADOWBRIDGE_MONSTERS) {
    monsters[monster.id] = normalizeTarget(value?.monsters?.[monster.id], NORMAL_MODES);
  }

  const skill = String(value?.skill ?? '0');
  return {
    order: normalizeOrder(value?.order),
    monsters,
    bossRoom: normalizeTarget(value?.bossRoom, BOSS_MODES),
    skill: SKILL_ID_SET.has(skill) ? skill : '0',
    attackCooldownMs: normalizeCooldown(value?.attackCooldownMs),
  };
}

function cleanDungeonSettings(value) {
  const settings = normalizeSettings(value);
  for (const monster of SHADOWBRIDGE_MONSTERS) {
    settings.monsters[monster.id].enabled = true;
    settings.monsters[monster.id].mode = 'kill';
  }
  settings.bossRoom.enabled = true;
  settings.bossRoom.mode = 'kill';
  return settings;
}

function setTouchSize(element, includeWidth = false) {
  if (!element?.style) return;
  element.style.minHeight = '44px';
  if (includeWidth) element.style.minWidth = '44px';
}

function renderSettings(ctx) {
  ctx.addSectionTitle('Combat');
  const skillGroup = ctx.make('div', { className: ctx.cls('setting') });
  const skillLabel = ctx.make('label', { text: 'Attack skill' });
  const skillId = `${ctx.idPrefix}-skill`;
  skillLabel.setAttribute?.('for', skillId);
  const skillSelect = ctx.make('select', { id: skillId, className: ctx.cls('select') });
  for (const skill of SHADOWBRIDGE_SKILLS) {
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
      text: 'The selected base skill is used for every Shadowbridge attack.',
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

  ctx.addSectionTitle('Targets');
  const actionGroup = ctx.make('div', { className: ctx.cls('setting') });
  const cleanButton = ctx.make('button', {
    id: `${ctx.idPrefix}-clean-dungeon`,
    className: ctx.cls('primary'),
    type: 'button',
    text: 'Clean Dungeon',
    title: 'Enable every target and set it to Kill',
  });
  setTouchSize(cleanButton);
  actionGroup.appendChild(cleanButton);
  actionGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text:
        'Max loot and max experience limits are read from the battle page immediately before attacking. ' +
        'Use the arrow buttons to change the attack order on touch devices, or drag rows on desktop.',
    }),
  );
  ctx.container.appendChild(actionGroup);

  const list = ctx.make('div', { className: ctx.cls('setting-list') });
  const cards = new Map();
  const controls = new Map();
  let draggedId = '';

  function persistOrder(nextOrder) {
    ctx.settings = ctx.updateSettings((settings) => {
      settings.order = nextOrder;
    });
    renderOrder();
  }

  function moveBy(monsterId, offset) {
    const order = [...ctx.settings.order];
    const index = order.indexOf(monsterId);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    persistOrder(order);
  }

  function moveBefore(sourceId, targetId) {
    if (sourceId === targetId || !MONSTER_ID_SET.has(sourceId) || !MONSTER_ID_SET.has(targetId)) return;
    const order = ctx.settings.order.filter((id) => id !== sourceId);
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return;
    order.splice(targetIndex, 0, sourceId);
    persistOrder(order);
  }

  function updateTarget(targetKey, mutator) {
    ctx.settings = ctx.updateSettings((settings) => {
      const target = targetKey === SHADOWBRIDGE_BOSS_ROOM.id ? settings.bossRoom : settings.monsters[targetKey];
      mutator(target);
    });
    return targetKey === SHADOWBRIDGE_BOSS_ROOM.id
      ? ctx.settings.bossRoom
      : ctx.settings.monsters[targetKey];
  }

  function createTargetCard(definition, { boss = false, reorderable = false } = {}) {
    const targetKey = definition.id;
    const target = boss ? ctx.settings.bossRoom : ctx.settings.monsters[targetKey];
    const modes = boss ? BOSS_MODES : NORMAL_MODES;
    const card = ctx.make('div', {
      id: `${ctx.idPrefix}-target-${targetKey}`,
      className: ctx.cls('setting'),
    });
    card.setAttribute?.('data-target-id', targetKey);

    const header = ctx.make('div');
    if (header.style) {
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '8px';
    }
    header.appendChild(ctx.make('div', { className: ctx.cls('setting-label'), text: definition.name }));

    let upButton = null;
    let downButton = null;
    if (reorderable) {
      const orderButtons = ctx.make('div');
      if (orderButtons.style) {
        orderButtons.style.display = 'flex';
        orderButtons.style.gap = '6px';
      }
      upButton = ctx.make('button', {
        id: `${ctx.idPrefix}-target-${targetKey}-up`,
        className: ctx.cls('icon-button'),
        type: 'button',
        title: `Move ${definition.name} up`,
        text: '↑',
      });
      downButton = ctx.make('button', {
        id: `${ctx.idPrefix}-target-${targetKey}-down`,
        className: ctx.cls('icon-button'),
        type: 'button',
        title: `Move ${definition.name} down`,
        text: '↓',
      });
      upButton.setAttribute?.('aria-label', `Move ${definition.name} up`);
      downButton.setAttribute?.('aria-label', `Move ${definition.name} down`);
      setTouchSize(upButton, true);
      setTouchSize(downButton, true);
      upButton.addEventListener('click', () => moveBy(targetKey, -1));
      downButton.addEventListener('click', () => moveBy(targetKey, 1));
      orderButtons.appendChild(upButton);
      orderButtons.appendChild(downButton);
      header.appendChild(orderButtons);

      card.draggable = true;
      card.title = 'Drag to change attack order';
      card.addEventListener('dragstart', (event) => {
        draggedId = targetKey;
        event.dataTransfer?.setData?.('text/plain', targetKey);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', (event) => {
        if (draggedId && draggedId !== targetKey) event.preventDefault?.();
      });
      card.addEventListener('drop', (event) => {
        event.preventDefault?.();
        const sourceId = event.dataTransfer?.getData?.('text/plain') || draggedId;
        moveBefore(sourceId, targetKey);
        draggedId = '';
      });
      card.addEventListener('dragend', () => {
        draggedId = '';
      });
    }
    card.appendChild(header);

    const enabledLabel = ctx.make('label', { className: ctx.cls('check') });
    const enabledInput = ctx.make('input', {
      id: `${ctx.idPrefix}-target-${targetKey}-enabled`,
      type: 'checkbox',
    });
    enabledInput.checked = target.enabled;
    setTouchSize(enabledLabel);
    enabledInput.addEventListener('change', () => {
      updateTarget(targetKey, (settings) => {
        settings.enabled = enabledInput.checked;
      });
    });
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(ctx.make('span', { text: boss ? 'Attack boss room' : 'Attack this monster' }));
    card.appendChild(enabledLabel);

    const modeLabel = ctx.make('label', { text: 'Damage mode' });
    const modeId = `${ctx.idPrefix}-target-${targetKey}-mode`;
    modeLabel.setAttribute?.('for', modeId);
    const modeSelect = ctx.make('select', { id: modeId, className: ctx.cls('select') });
    for (const mode of modes) {
      const option = ctx.make('option', { text: mode.label });
      option.value = mode.id;
      modeSelect.appendChild(option);
    }
    modeSelect.value = target.mode;
    setTouchSize(modeSelect);
    card.appendChild(modeLabel);
    card.appendChild(modeSelect);

    const damageGroup = ctx.make('div');
    const damageLabel = ctx.make('label', { text: 'Custom damage target' });
    const damageId = `${ctx.idPrefix}-target-${targetKey}-damage`;
    damageLabel.setAttribute?.('for', damageId);
    const damageInput = ctx.make('input', {
      id: damageId,
      className: ctx.cls('input'),
      type: 'text',
    });
    damageInput.value = target.damage;
    damageInput.placeholder = 'e.g. 3m';
    damageInput.inputMode = 'decimal';
    damageInput.autocomplete = 'off';
    damageGroup.hidden = target.mode !== 'custom';
    damageGroup.appendChild(damageLabel);
    damageGroup.appendChild(damageInput);
    card.appendChild(damageGroup);

    modeSelect.addEventListener('change', () => {
      const next = updateTarget(targetKey, (settings) => {
        settings.mode = modeSelect.value;
      });
      modeSelect.value = next.mode;
      damageGroup.hidden = next.mode !== 'custom';
    });
    damageInput.addEventListener('change', () => {
      const next = updateTarget(targetKey, (settings) => {
        settings.damage = damageInput.value;
      });
      damageInput.value = next.damage;
    });

    controls.set(targetKey, {
      enabledInput,
      modeSelect,
      damageInput,
      damageGroup,
      upButton,
      downButton,
    });
    return card;
  }

  for (const monster of SHADOWBRIDGE_MONSTERS) {
    cards.set(monster.id, createTargetCard(monster, { reorderable: true }));
  }
  ctx.container.appendChild(list);

  ctx.addSectionTitle('Boss room');
  const bossCard = createTargetCard(SHADOWBRIDGE_BOSS_ROOM, { boss: true });
  bossCard.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text:
        'The boss is discovered from the unlocked Boss Room; its loot and experience limits are not stored ' +
        'as fixed values.',
    }),
  );
  ctx.container.appendChild(bossCard);

  function renderOrder() {
    ctx.settings.order.forEach((id) => list.appendChild(cards.get(id)));
    ctx.settings.order.forEach((id, index) => {
      const control = controls.get(id);
      if (control?.upButton) control.upButton.disabled = index === 0;
      if (control?.downButton) control.downButton.disabled = index === ctx.settings.order.length - 1;
    });
  }

  function syncControls() {
    for (const monster of SHADOWBRIDGE_MONSTERS) {
      const target = ctx.settings.monsters[monster.id];
      const control = controls.get(monster.id);
      control.enabledInput.checked = target.enabled;
      control.modeSelect.value = target.mode;
      control.damageInput.value = target.damage;
      control.damageGroup.hidden = target.mode !== 'custom';
    }
    const boss = controls.get(SHADOWBRIDGE_BOSS_ROOM.id);
    boss.enabledInput.checked = ctx.settings.bossRoom.enabled;
    boss.modeSelect.value = ctx.settings.bossRoom.mode;
    boss.damageInput.value = ctx.settings.bossRoom.damage;
    boss.damageGroup.hidden = ctx.settings.bossRoom.mode !== 'custom';
    renderOrder();
  }

  cleanButton.addEventListener('click', () => {
    ctx.settings = ctx.updateSettings((settings) => {
      Object.assign(settings, cleanDungeonSettings(settings));
    });
    syncControls();
  });

  renderOrder();
}

module.exports = Object.freeze({
  id: 'shadowbridge',
  label: 'Shadowbridge Warrens',
  path: '/guild_dungeon.php?veyra_route=shadowbridge',
  defaultEnabled: false,
  visitPathnames: Object.freeze([
    '/guild_dungeon_instance.php',
    '/guild_dungeon_location.php',
    '/battle.php',
  ]),
  defaultLoopMinutes: 30,
  maxVisitMs: 60 * 60_000,
  initialDelayMs: 10 * 60_000,
  SHADOWBRIDGE_BOSS_ROOM,
  SHADOWBRIDGE_MONSTERS,
  SHADOWBRIDGE_SKILLS,
  cleanDungeonSettings,

  matchesUrl(url) {
    return (
      /\/guild_dungeon\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('veyra_route') === 'shadowbridge'
    );
  },

  createDefaultSettings() {
    return normalizeSettings(null);
  },

  normalizeSettings,
  renderSettings,
});
