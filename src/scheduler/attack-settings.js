'use strict';

const STANDARD_ATTACKS = Object.freeze([
  Object.freeze({ id: '-5', name: 'Skill −5', stamina: 1_000, mana: 0, classAttack: false }),
  Object.freeze({ id: '-4', name: 'Legendary Slash', stamina: 200, mana: 0, classAttack: false }),
  Object.freeze({ id: '-3', name: 'Ultimate Slash', stamina: 100, mana: 0, classAttack: false }),
  Object.freeze({ id: '-2', name: 'Heroic Slash', stamina: 50, mana: 0, classAttack: false }),
  Object.freeze({ id: '-1', name: 'Power Slash', stamina: 10, mana: 0, classAttack: false }),
  Object.freeze({ id: '0', name: 'Slash', stamina: 1, mana: 0, classAttack: false }),
]);

function createPattern() {
  return { skillIds: [], useStaminaPotions: false, useManaPotions: false };
}

function normalizePattern(value) {
  return {
    skillIds: Array.isArray(value?.skillIds)
      ? value.skillIds.map(String).map((id) => id.trim()).filter(Boolean).slice(0, 30)
      : [],
    useStaminaPotions: value?.useStaminaPotions === true,
    useManaPotions: value?.useManaPotions === true,
  };
}

function normalizeKnownAttacks(value) {
  const result = [];
  const seen = new Set(STANDARD_ATTACKS.map((attack) => attack.id));
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw?.id ?? '').trim();
    const name = String(raw?.name ?? '').trim().slice(0, 100);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name,
      stamina: Math.max(0, Number(raw?.stamina) || 0),
      mana: Math.max(0, Number(raw?.mana) || 0),
      classAttack: true,
    });
  }
  return result.slice(0, 100);
}

function normalizeAttackSettings(value) {
  return {
    globalPattern: normalizePattern(value?.globalPattern),
    knownClassAttacks: normalizeKnownAttacks(value?.knownClassAttacks),
  };
}

function availableAttacks(config) {
  return [...STANDARD_ATTACKS, ...normalizeKnownAttacks(config?.knownClassAttacks)];
}

function cacheClassAttacks(store, configKey, attacks) {
  const classAttacks = (attacks || [])
    .filter((attack) => attack.group === 'Class Attacks' && attack.skillId)
    .map((attack) => ({
      id: String(attack.skillId),
      name: attack.name,
      stamina: Number(attack.costs?.stamina) || 0,
      mana: Number(attack.costs?.mana) || 0,
      classAttack: true,
    }));
  if (!classAttacks.length || !store) return false;
  const config = store.read(configKey);
  if (!config || typeof config !== 'object') return false;
  const current = normalizeKnownAttacks(config.attack?.knownClassAttacks);
  const merged = normalizeKnownAttacks([...current, ...classAttacks]);
  if (JSON.stringify(current) === JSON.stringify(merged)) return false;
  config.attack = { ...normalizeAttackSettings(config.attack), knownClassAttacks: merged };
  return store.write(configKey, config);
}

function patternCosts(pattern, attacks) {
  const byId = new Map((attacks || []).map((attack) => [String(attack.id), attack]));
  return normalizePattern(pattern).skillIds.reduce(
    (total, id) => {
      const attack = byId.get(id);
      total.stamina += Number(attack?.stamina) || 0;
      total.mana += Number(attack?.mana) || 0;
      return total;
    },
    { stamina: 0, mana: 0 },
  );
}

function renderPatternEditor(ctx, { id, title, pattern, attacks, onChange }) {
  const card = ctx.make('div', { className: ctx.cls('setting') });
  card.appendChild(ctx.make('div', { className: ctx.cls('setting-label'), text: title }));
  const save = (rerender = false) => onChange(normalizePattern(pattern), rerender);

  pattern.skillIds.forEach((skillId, index) => {
    const row = ctx.make('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = 'minmax(0,1fr) auto auto auto';
    row.style.gap = '5px';
    const select = ctx.make('select', { className: ctx.cls('select') });
    for (const attack of attacks) {
      const option = ctx.make('option', {
        text: `${attack.name}${attack.classAttack ? ' · class' : ''} (${attack.stamina} STA${attack.mana ? ` / ${attack.mana} MP` : ''})`,
      });
      option.value = attack.id;
      select.appendChild(option);
    }
    select.value = skillId;
    select.addEventListener('change', () => {
      pattern.skillIds[index] = select.value;
      save();
    });
    row.appendChild(select);
    for (const [label, action] of [
      ['↑', () => index > 0 && pattern.skillIds.splice(index - 1, 0, pattern.skillIds.splice(index, 1)[0])],
      ['↓', () => index < pattern.skillIds.length - 1 && pattern.skillIds.splice(index + 1, 0, pattern.skillIds.splice(index, 1)[0])],
      ['×', () => pattern.skillIds.splice(index, 1)],
    ]) {
      const button = ctx.make('button', { className: ctx.cls('icon-button'), type: 'button', text: label });
      button.addEventListener('click', () => {
        action();
        save(true);
      });
      row.appendChild(button);
    }
    card.appendChild(row);
  });

  const add = ctx.make('button', { className: ctx.cls('primary'), type: 'button', text: '+ Add attack' });
  add.disabled = attacks.length === 0;
  add.addEventListener('click', () => {
    pattern.skillIds.push(attacks[0]?.id || '');
    save(true);
  });
  card.appendChild(add);
  for (const [key, label] of [
    ['useStaminaPotions', 'Use stamina potions for this pattern'],
    ['useManaPotions', 'Use mana potions for this pattern'],
  ]) {
    ctx.addCheckbox({
      id: `${id}-${key}`,
      label,
      checked: pattern[key],
      parent: card,
      onChange(checked) {
        pattern[key] = checked;
        save();
      },
    });
  }
  const costs = patternCosts(pattern, attacks);
  card.appendChild(ctx.make('div', {
    className: ctx.cls('hint'),
    text: `One loop: ${costs.stamina.toLocaleString('en-US')} stamina / ${costs.mana.toLocaleString('en-US')} mana`,
  }));
  ctx.container.appendChild(card);
  return card;
}

module.exports = {
  STANDARD_ATTACKS,
  availableAttacks,
  cacheClassAttacks,
  createPattern,
  normalizeAttackSettings,
  normalizeKnownAttacks,
  normalizePattern,
  patternCosts,
  renderPatternEditor,
};
