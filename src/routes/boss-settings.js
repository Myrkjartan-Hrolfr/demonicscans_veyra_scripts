'use strict';

// Shared settings for boss pages (Wave 3, Olympus): per boss an attack
// checkbox and a damage target, plus the attacks Monster Auto Battle uses.

const {
  formatGameNumber,
  normalizeAdditionalDamageTarget,
  normalizeDamageTarget,
  parseGameNumber,
} = require('../core/numbers');

const STANDARD_SKILLS = Object.freeze([
  Object.freeze({ id: '-5', name: 'Skill −5', cost: 1_000 }),
  Object.freeze({ id: '-4', name: 'Legendary Slash', cost: 200 }),
  Object.freeze({ id: '-3', name: 'Ultimate Slash', cost: 100 }),
  Object.freeze({ id: '-2', name: 'Heroic Slash', cost: 50 }),
  Object.freeze({ id: '-1', name: 'Power Slash', cost: 10 }),
  Object.freeze({ id: '0', name: 'Slash', cost: 1 }),
]);

// Monster Auto Battle has three attack slots.
const MAX_SKILLS = 3;

function normalizeSkills(value, fallback = ['0']) {
  const known = STANDARD_SKILLS.map((skill) => skill.id);
  const selected = new Set((Array.isArray(value) ? value : fallback).map(String));
  const skills = known.filter((id) => selected.has(id)).slice(0, MAX_SKILLS);
  return skills.length > 0 ? skills : [...fallback];
}

// bossList: [{ id, name, defaultDamage, defaultEnabled }]
function normalizeBossSettings(value, bossList) {
  const bosses = {};
  for (const boss of bossList) {
    const saved = value?.bosses?.[boss.id];
    const normalized = {
      // Names identify the boss on the page and must not come from storage.
      name: boss.name,
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : boss.defaultEnabled !== false,
      damage: normalizeDamageTarget(saved?.damage, boss.defaultDamage),
    };
    if (boss.phase3 === true) {
      normalized.phase3Damage = normalizeAdditionalDamageTarget(
        saved?.phase3Damage,
        boss.defaultPhase3Damage,
      );
    }
    bosses[boss.id] = normalized;
  }
  return { bosses, skills: normalizeSkills(value?.skills) };
}

// sections: [{ title, bosses: [boss] }]
function renderBossSettings(ctx, sections) {
  ctx.addSectionTitle('Attacks');
  const skillGroup = ctx.make('div', { className: ctx.cls('setting') });
  for (const skill of STANDARD_SKILLS) {
    ctx.addCheckbox({
      id: `skill-${skill.id}`,
      label: `${skill.name} (${skill.cost.toLocaleString('en-US')} stamina)`,
      checked: ctx.settings.skills.includes(skill.id),
      parent: skillGroup,
      onChange(checked) {
        const next = ctx.updateSettings((settings) => {
          const selected = new Set(settings.skills);
          if (checked) selected.add(skill.id);
          else selected.delete(skill.id);
          settings.skills = [...selected];
        });
        ctx.settings.skills = next.skills;
      },
    });
  }
  skillGroup.appendChild(
    ctx.make('div', {
      className: ctx.cls('hint'),
      text: `Up to ${MAX_SKILLS} attacks, always used from the most expensive to the cheapest. Class skills can be chosen in Monster Auto Battle.`,
    }),
  );
  ctx.container.appendChild(skillGroup);

  for (const section of sections) {
    ctx.addSectionTitle(section.title);
    for (const boss of section.bosses) {
      const bossSettings = ctx.settings.bosses[boss.id];
      ctx.addCheckbox({
        id: `boss-${boss.id}-enabled`,
        label: `Attack ${boss.name}`,
        checked: bossSettings.enabled,
        onChange(checked) {
          ctx.updateSettings((settings) => {
            settings.bosses[boss.id].enabled = checked;
          });
        },
      });
      let updateCombinedHint = () => {};
      ctx.addTextInput({
        id: `boss-${boss.id}-damage`,
        label: boss.phase3 === true
          ? 'Phase 1 damage target (e.g. 500m, 3b)'
          : 'Damage target (e.g. 500m, 3b)',
        value: bossSettings.damage,
        placeholder: boss.defaultDamage,
        inputMode: 'decimal',
        onChange(value) {
          const next = ctx.updateSettings((settings) => {
            settings.bosses[boss.id].damage = normalizeDamageTarget(value, boss.defaultDamage);
          });
          ctx.settings = next;
          updateCombinedHint(next.bosses[boss.id]);
          return next.bosses[boss.id].damage;
        },
      });
      if (boss.phase3 === true) {
        ctx.addTextInput({
          id: `boss-${boss.id}-phase3-damage`,
          label: 'Phase 3 additional damage target (e.g. 500m, 4b)',
          value: bossSettings.phase3Damage,
          placeholder: boss.defaultPhase3Damage || '0',
          inputMode: 'decimal',
          onChange(value) {
            const next = ctx.updateSettings((settings) => {
              settings.bosses[boss.id].phase3Damage = normalizeAdditionalDamageTarget(
                value,
                boss.defaultPhase3Damage,
              );
            });
            ctx.settings = next;
            updateCombinedHint(next.bosses[boss.id]);
            return next.bosses[boss.id].phase3Damage;
          },
        });
        const combinedHint = ctx.make('div', { className: ctx.cls('hint') });
        updateCombinedHint = (settings) => {
          const phase1 = parseGameNumber(settings?.damage) || 0;
          const phase3 = parseGameNumber(settings?.phase3Damage) || 0;
          combinedHint.textContent = `Overall target after Phase 3: ${formatGameNumber(phase1 + phase3)} (Phase 1 + Phase 3).`;
        };
        updateCombinedHint(bossSettings);
        ctx.container.appendChild(combinedHint);
      }
    }
  }
}

module.exports = {
  MAX_SKILLS,
  STANDARD_SKILLS,
  normalizeBossSettings,
  normalizeSkills,
  renderBossSettings,
};
