'use strict';

// Shared settings for boss pages (Wave 3, Olympus): per boss an attack
// checkbox and a damage target, plus the attacks Monster Auto Battle uses.

const {
  formatGameNumber,
  normalizeAdditionalDamageTarget,
  normalizeDamageTarget,
  parseGameNumber,
} = require('../core/numbers');
const {
  STANDARD_ATTACKS,
  attackSettingsForStore,
  availableAttacks,
  normalizePattern,
  renderPatternEditor,
} = require('../scheduler/attack-settings');

const STANDARD_SKILLS = Object.freeze(STANDARD_ATTACKS.map((attack) => Object.freeze({
  id: attack.id,
  name: attack.name,
  cost: attack.stamina,
})));

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
      specificPatternEnabled: saved?.specificPatternEnabled === true,
      specificPattern: normalizePattern(saved?.specificPattern),
    };
    if (boss.phase3 === true) {
      normalized.phase3Damage = normalizeAdditionalDamageTarget(
        saved?.phase3Damage,
        boss.defaultPhase3Damage,
      );
    }
    bosses[boss.id] = normalized;
  }
  return { bosses, skills: normalizeSkills(value?.skills), useGlobalPattern: value?.useGlobalPattern === true };
}

// sections: [{ title, bosses: [boss] }]
function renderBossSettings(ctx, sections) {
  ctx.addSectionTitle('Attacks');
  const skillGroup = ctx.make('div', { className: ctx.cls('setting') });
  ctx.addCheckbox({
    id: 'use-global-pattern',
    label: 'Global attack pattern (primary attack)',
    checked: ctx.settings.useGlobalPattern,
    parent: skillGroup,
    onChange(checked) {
      ctx.setUseGlobalPattern?.(checked);
      ctx.settings = ctx.updateSettings((settings) => {
        settings.useGlobalPattern = checked;
      });
    },
  });
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
      const patternHost = ctx.make('div', { className: ctx.cls('setting') });
      ctx.addCheckbox({
        id: `boss-${boss.id}-specific-pattern`,
        label: `Use specific attack pattern for ${boss.name}`,
        checked: bossSettings.specificPatternEnabled,
        parent: patternHost,
        onChange(checked) {
          ctx.settings = ctx.updateSettings((settings) => {
            settings.bosses[boss.id].specificPatternEnabled = checked;
          });
        },
      });
      const attackConfig = attackSettingsForStore(ctx.loadConfig?.()?.attack || {}, ctx.store);
      renderPatternEditor(
        { ...ctx, container: patternHost },
        {
          id: `boss-${boss.id}-pattern`,
          title: 'Specific attack pattern',
          pattern: normalizePattern(bossSettings.specificPattern),
          attacks: availableAttacks(attackConfig),
          onChange(next, rerender) {
            ctx.settings = ctx.updateSettings((settings) => {
              settings.bosses[boss.id].specificPattern = next;
            });
            if (rerender) ctx.rerender?.();
          },
        },
      );
      ctx.container.appendChild(patternHost);
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
          combinedHint.textContent =
            `Phase 1 stops at about ${formatGameNumber(phase1)}. Phase 3 then adds ` +
            `${formatGameNumber(phase3)} to the damage actually dealt in Phase 1.`;
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
