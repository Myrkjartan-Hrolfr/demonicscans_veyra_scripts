'use strict';

// From veyra-hud ui-improvements ("Strategic Attack"): a purple "Quick Join &
// Attack" button that joins the selected monsters and runs a configurable
// sequence of skills on each, plus the Attack Strategy Builder modal. The
// network logic lives in ./attack.js.

const { formatGameNumber } = require('../../core/numbers');
const { ASTERION_SETTINGS, ASTERION_VALUE, USE_ASTERION, staminaCost, staminaMultiplier } = require('../shared/asterion');
const {
  DEFAULT_ATTACK_URL,
  DEFAULT_JOIN_URL,
  DEFAULT_WAIT_BUFFER_MS,
  MIN_WAIT_BUFFER_MS,
  SKILLS,
  SKILL_NAMES,
  normalizeStrategy,
  runStrategicAttack,
  stripTags,
  strategyCost,
  summarizeResults,
} = require('./attack');
const { addStyle, findMonsterCard, isWavePage, make, setStatus } = require('./common');

const GROUP = 'Wave page';
const STYLE_ID = 'veyra-automation-wave-strategy';
const MODAL_ID = 'veyra-strategy-modal';
// Stored as a JSON array of skill names; the menu cannot render it, so it is
// read and written through ctx.store (not listed in settings).
const STRATEGY_KEY = 'ui-improvements:attackStrategy';

const ENABLE_STRATEGY = Object.freeze({
  key: 'ui-improvements:enableCustomAttackStrategy',
  label: 'Strategic attack',
  type: 'checkbox',
  default: true,
  hint: 'Adds a purple "Quick Join & Attack" button that runs your attack strategy on the selected monsters.',
});

const WAIT_BUFFER = Object.freeze({
  key: 'ui-improvements:strategicAttackWaitBuffer',
  label: 'Minimum delay between strategic attacks (ms)',
  type: 'number',
  default: DEFAULT_WAIT_BUFFER_MS,
  min: MIN_WAIT_BUFFER_MS,
  step: 50,
  visibleIf: (get) => get(ENABLE_STRATEGY.key) === true,
});

const USE_DAMAGE_LIMIT = Object.freeze({
  key: 'ui-improvements:useDamageLimit',
  label: 'Stop strategy at a damage limit',
  type: 'checkbox',
  default: false,
  hint: 'Skips the remaining skills on a monster once your damage reaches the limit (useful with crits).',
  visibleIf: (get) => get(ENABLE_STRATEGY.key) === true,
});

const DAMAGE_LIMIT = Object.freeze({
  key: 'ui-improvements:damageLimitValue',
  label: 'Damage limit',
  type: 'number',
  default: 0,
  min: 0,
  visibleIf: (get) => get(ENABLE_STRATEGY.key) === true && get(USE_DAMAGE_LIMIT.key) === true,
});

const CSS = `
  #${MODAL_ID} { position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,.65); display:flex;
    align-items:center; justify-content:center; padding:12px; box-sizing:border-box; }
  #${MODAL_ID} .vs-modal { background:#1f2233; color:#e6e8ff; border-radius:10px; padding:16px;
    width:min(470px, 100%); max-height:calc(100vh - 24px); overflow:auto; -webkit-overflow-scrolling:touch;
    box-shadow:0 10px 30px rgba(0,0,0,.4); box-sizing:border-box; font-size:14px; }
  #${MODAL_ID} h3 { margin:0 0 10px; }
  #${MODAL_ID} .vs-picker { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  #${MODAL_ID} .vs-skill { font-size:13px; padding:8px 10px; min-height:36px; background:#151728;
    border:1px solid #2d3154; color:#e6e8ff; border-radius:6px; cursor:pointer; text-transform:capitalize; }
  #${MODAL_ID} .vs-label { font-size:12px; color:#9aa0be; margin-bottom:6px; }
  #${MODAL_ID} .vs-chips { display:flex; flex-direction:column; gap:6px; }
  #${MODAL_ID} .vs-chip { display:flex; align-items:center; gap:6px; background:#2d3154; padding:6px 10px;
    border-radius:8px; font-size:13px; }
  #${MODAL_ID} .vs-chip-label { flex:1; text-transform:capitalize; }
  #${MODAL_ID} .vs-chip button { background:#1f2233; border:none; color:#9aa0be; border-radius:5px;
    min-width:36px; min-height:32px; cursor:pointer; font-size:13px; }
  #${MODAL_ID} .vs-chip button[disabled] { opacity:.3; cursor:default; }
  #${MODAL_ID} .vs-chip .vs-remove { color:#ef4444; }
  #${MODAL_ID} .vs-empty { color:#9aa0be; font-size:12px; padding:6px 0; }
  #${MODAL_ID} .vs-meta { margin-top:12px; font-size:13px; color:#9aa0be; display:flex; flex-direction:column; gap:8px; }
  #${MODAL_ID} .vs-cost { color:#FFD369; font-weight:700; text-shadow:0 0 6px rgba(255,211,105,.6); }
  #${MODAL_ID} .vs-option { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #${MODAL_ID} .vs-option label { cursor:pointer; }
  #${MODAL_ID} .vs-option input[type=checkbox] { width:18px; height:18px; margin:0; }
  #${MODAL_ID} .vs-option input[type=number] { width:120px; padding:6px; border-radius:4px; border:1px solid #2d3154;
    background:#2d3154; color:#e6e8ff; font-size:14px; }
  #${MODAL_ID} .vs-footer { margin-top:14px; display:flex; justify-content:flex-end; gap:8px; }
  #${MODAL_ID} .vs-footer button { min-height:36px; padding:6px 14px; }
  .veyra-strategy-attack-btn { background:#7c3aed !important; border-color:#7c3aed !important; }
  .veyra-bam-msg { margin-top:6px; color:#9aa0be; font-size:12px; line-height:1.45; }
  .veyra-bam-msg b { color:#e6e9ff; }
`;

// ---------------------------------------------------------------- helpers

function readStrategy(store) {
  return normalizeStrategy(store?.read?.(STRATEGY_KEY));
}

function writeStrategy(store, strategy) {
  store?.write?.(STRATEGY_KEY, normalizeStrategy(strategy));
}

function damageLimitOf(ctx) {
  if (ctx.setting(USE_DAMAGE_LIMIT.key) !== true) return 0;
  const limit = Number(ctx.setting(DAMAGE_LIMIT.key));
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

function strategyButtonLabel(strategy, multiplier, damageLimit) {
  if (!strategy.length) return '🧠 Quick Join & Attack (no strategy)';
  let label = `🧠 Quick Join & Attack (${strategyCost(strategy, multiplier)})`;
  if (damageLimit > 0) label += ` (limit ${formatGameNumber(damageLimit)})`;
  return label;
}

function selectedMonsterIds(doc) {
  return Array.from(doc.querySelectorAll('.pickMonster:checked'))
    .map((checkbox) => Number.parseInt(checkbox.dataset?.mid || '0', 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function capitalize(text) {
  return String(text).replace(/\b\w/g, (char) => char.toUpperCase());
}

// Shows the results in the game's #batchAttackModal.
function showResults(ctx, results) {
  const { doc } = ctx;
  const summary = summarizeResults(results);
  const summaryText =
    `Processed: ${summary.processed} | Success: ${summary.success} | Failed: ${summary.failed}` +
    (summary.totalDamage > 0 ? ` | Damage: ${formatGameNumber(summary.totalDamage)}` : '');
  const modal = doc.getElementById('batchAttackModal');
  const sum = doc.getElementById('bamSummary');
  const list = doc.getElementById('bamList');
  if (!modal || !list) {
    ctx.notify(summaryText, summary.failed ? 'error' : 'success');
    return;
  }
  if (sum) sum.textContent = summaryText;
  list.textContent = '';
  for (const result of results) {
    const ok = Boolean(result.ok);
    const card = make(doc, 'div', {
      style:
        `background:#1e1e2f;border:1px solid ${ok ? 'rgba(0,255,140,.25)' : 'rgba(255,0,80,.25)'};` +
        'border-radius:10px;padding:10px 12px;',
    });
    const header = make(doc, 'div', {
      style: 'display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;',
    });
    const link = make(doc, 'a', {
      text: `Go to battle #${result.monsterId}`,
      style:
        'display:inline-block;padding:4px 8px;background:#1a9d73;color:#fff;text-decoration:none;' +
        'border-radius:6px;font-weight:700;',
      attrs: { target: '_blank', rel: 'noopener noreferrer' },
    });
    link.href = `battle.php?id=${encodeURIComponent(result.monsterId)}`;
    header.appendChild(link);
    header.appendChild(
      make(doc, 'div', {
        text: ok ? '✅ OK' : '❌ FAIL',
        style: `font-weight:800;color:${ok ? '#7CFFB8' : '#ff6b6b'};`,
      }),
    );
    card.appendChild(header);

    const body = make(doc, 'div', { className: 'veyra-bam-msg' });
    const line = (text) => body.appendChild(make(doc, 'div', { text }));
    if (result.joinMsg) line(`Join: ${stripTags(result.joinMsg)}`);
    if (result.skipped) line('Skipped (join failed).');
    for (const attack of result.attacks || []) {
      const row = make(doc, 'div');
      row.appendChild(make(doc, 'b', { text: `${capitalize(attack.skill)}: ` }));
      row.appendChild(doc.createTextNode(stripTags(attack.msg)));
      body.appendChild(row);
    }
    if (result.limitReached) line('Damage limit reached, remaining skills skipped.');
    if (result.totalDamage > 0) line(`Total damage: ${formatGameNumber(result.totalDamage)}`);
    card.appendChild(body);
    list.appendChild(card);
  }
  modal.style.display = 'flex';
}

// ------------------------------------------------------------------- feature

function createController(ctx) {
  const { doc } = ctx;
  let strategy = readStrategy(ctx.store);
  let strategyButton = null;
  let running = false;

  const multiplier = () => staminaMultiplier(ctx);

  function refreshButtons() {
    if (strategyButton) {
      strategyButton.textContent = strategyButtonLabel(strategy, multiplier(), damageLimitOf(ctx));
    }
    for (const button of doc.querySelectorAll('.btnQuickJoinAttack')) {
      const base = Number(button.dataset?.stam);
      if (!Number.isFinite(base) || base <= 0) continue;
      button.textContent = `⚡ Quick Join & Attack (${staminaCost(base, multiplier())})`;
    }
  }

  function setRunning(state) {
    running = state;
    for (const button of [...doc.querySelectorAll('.btnQuickJoinAttack'), strategyButton]) {
      if (!button) continue;
      button.disabled = state;
      button.style.opacity = state ? '0.7' : '';
    }
  }

  function saveStrategy(next) {
    strategy = normalizeStrategy(next);
    writeStrategy(ctx.store, strategy);
    refreshButtons();
  }

  async function run() {
    if (running) return;
    const ids = selectedMonsterIds(doc);
    if (!ids.length) {
      setStatus(doc, 'Select at least 1 monster.');
      return;
    }
    if (!strategy.length) {
      setStatus(doc, 'Your attack strategy is empty. Open "🧠 Strategy" to build one.');
      return;
    }
    const endpoints = ctx.pageGlobal('ENDPOINTS') || {};
    const targets = ids.map((monsterId) => ({
      monsterId,
      joined: findMonsterCard(doc, monsterId)?.dataset?.joined === '1',
    }));

    setRunning(true);
    setStatus(doc, `Running attack strategy on ${ids.length} monsters...`);
    try {
      const userId = targets.every((target) => target.joined) ? null : await ctx.getUserId();
      const results = await runStrategicAttack({
        postForm: (url, params) => ctx.postForm(url, params),
        joinUrl: endpoints.JOIN || DEFAULT_JOIN_URL,
        attackUrl: endpoints.ATTACK || DEFAULT_ATTACK_URL,
        userId,
        targets,
        strategy,
        waitBufferMs: ctx.setting(WAIT_BUFFER.key),
        damageLimit: damageLimitOf(ctx),
        onProgress: ({ index, total, monsterId }) =>
          setStatus(doc, `(${index + 1}/${total}) Strategy attacking monster #${monsterId}...`),
        onJoined: (monsterId) => {
          const card = findMonsterCard(doc, monsterId);
          if (card) {
            card.dataset.joined = '1';
            card.dataset.unjoined = '0';
          }
        },
      });
      setStatus(doc, 'Strategy complete.');
      showResults(ctx, results);
    } catch (error) {
      ctx.warn('Strategic attack failed.', error);
      setStatus(doc, 'Strategic attack failed. See the console for details.');
    } finally {
      setRunning(false);
    }
  }

  function openModal() {
    if (doc.getElementById(MODAL_ID) || !doc.body) return;
    const overlay = make(doc, 'div', { attrs: { role: 'dialog', 'aria-modal': 'true' } });
    overlay.id = MODAL_ID;
    const modal = make(doc, 'div', { className: 'vs-modal' });
    overlay.appendChild(modal);

    const close = () => {
      overlay.remove();
      doc.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    doc.addEventListener('keydown', onKey);

    modal.appendChild(make(doc, 'h3', { text: '🧠 Attack Strategy Builder' }));
    modal.appendChild(make(doc, 'div', { className: 'vs-label', text: 'Tap a skill to add it to the end:' }));
    const picker = make(doc, 'div', { className: 'vs-picker' });
    for (const name of SKILL_NAMES) {
      const button = make(doc, 'button', {
        className: 'vs-skill',
        text: `${name} (${SKILLS[name].cost})`,
        attrs: { type: 'button' },
      });
      button.addEventListener('click', () => {
        saveStrategy([...strategy, name]);
        render();
      });
      picker.appendChild(button);
    }
    modal.appendChild(picker);
    modal.appendChild(make(doc, 'div', { className: 'vs-label', text: 'Strategy order:' }));
    const chips = make(doc, 'div', { className: 'vs-chips' });
    modal.appendChild(chips);
    const cost = make(doc, 'div');
    const meta = make(doc, 'div', { className: 'vs-meta' });
    meta.appendChild(cost);
    modal.appendChild(meta);

    const option = (id, labelText, checked, numberValue, numberProps, onToggle, onValue) => {
      const row = make(doc, 'div', { className: 'vs-option' });
      const checkbox = make(doc, 'input', { attrs: { type: 'checkbox' } });
      checkbox.id = id;
      checkbox.checked = checked;
      const label = make(doc, 'label', { text: labelText });
      label.setAttribute('for', id);
      const input = make(doc, 'input', { attrs: { type: 'number', inputmode: 'decimal', ...numberProps } });
      input.value = String(numberValue ?? '');
      input.style.display = checked ? '' : 'none';
      checkbox.addEventListener('change', () => {
        input.style.display = checkbox.checked ? '' : 'none';
        onToggle(checkbox.checked);
        render();
      });
      input.addEventListener('change', () => {
        input.value = String(onValue(input.value) ?? '');
        render();
      });
      row.append(checkbox, label, input);
      meta.appendChild(row);
    };

    option(
      'veyra-strategy-use-asterion',
      'Calculate using Asterion',
      ctx.setting(USE_ASTERION.key) === true,
      ctx.setting(ASTERION_VALUE.key),
      { min: '1', step: '0.5' },
      (checked) => ctx.setSetting(USE_ASTERION.key, checked),
      (value) => ctx.setSetting(ASTERION_VALUE.key, value),
    );
    option(
      'veyra-strategy-use-damage-limit',
      'Use damage limit (useful for crits)',
      ctx.setting(USE_DAMAGE_LIMIT.key) === true,
      ctx.setting(DAMAGE_LIMIT.key),
      { min: '0', step: '1' },
      (checked) => ctx.setSetting(USE_DAMAGE_LIMIT.key, checked),
      (value) => ctx.setSetting(DAMAGE_LIMIT.key, value),
    );

    const footer = make(doc, 'div', { className: 'vs-footer' });
    const clear = make(doc, 'button', { className: 'btn', text: 'Clear', attrs: { type: 'button' } });
    clear.addEventListener('click', () => {
      saveStrategy([]);
      render();
    });
    const closeButton = make(doc, 'button', { className: 'btn', text: 'Close', attrs: { type: 'button' } });
    closeButton.addEventListener('click', close);
    footer.append(clear, closeButton);
    modal.appendChild(footer);

    function render() {
      chips.textContent = '';
      if (!strategy.length) {
        chips.appendChild(make(doc, 'div', { className: 'vs-empty', text: 'No skills yet.' }));
      }
      strategy.forEach((name, index) => {
        const chip = make(doc, 'div', { className: 'vs-chip' });
        chip.appendChild(make(doc, 'span', { className: 'vs-chip-label', text: `${index + 1}. ${name}` }));
        const control = (text, title, disabled, mutate, extraClass = '') => {
          const button = make(doc, 'button', {
            className: extraClass,
            text,
            attrs: { type: 'button', title, 'aria-label': title },
          });
          button.disabled = disabled;
          button.addEventListener('click', () => {
            const next = [...strategy];
            mutate(next);
            saveStrategy(next);
            render();
          });
          chip.appendChild(button);
        };
        control('↑', 'Move up', index === 0, (next) => {
          [next[index - 1], next[index]] = [next[index], next[index - 1]];
        });
        control('↓', 'Move down', index === strategy.length - 1, (next) => {
          [next[index + 1], next[index]] = [next[index], next[index + 1]];
        });
        control('✕', 'Remove', false, (next) => next.splice(index, 1), 'vs-remove');
        chips.appendChild(chip);
      });
      cost.textContent = 'Total stamina cost: ';
      cost.appendChild(make(doc, 'span', { className: 'vs-cost', text: strategyCost(strategy, multiplier()) }));
      refreshButtons();
    }

    render();
    doc.body.appendChild(overlay);
  }

  function inject() {
    const actions = doc.querySelector('.qol-select-actions');
    if (actions && !actions.querySelector('.veyra-strategy-settings-btn')) {
      const settingsButton = make(doc, 'button', {
        className: 'btn veyra-strategy-settings-btn',
        text: '🧠 Strategy',
        attrs: { type: 'button', title: 'Attack Strategy Builder' },
      });
      settingsButton.addEventListener('click', openModal);
      actions.appendChild(settingsButton);
    }

    const attacks = doc.querySelector('.qol-attacks');
    if (attacks && !attacks.querySelector('.veyra-strategy-attack-btn')) {
      strategyButton = make(doc, 'button', {
        className: 'btn veyra-strategy-attack-btn',
        attrs: { type: 'button' },
      });
      strategyButton.addEventListener('click', run);
      attacks.appendChild(strategyButton);
    }
    refreshButtons();
  }

  return { inject, openModal, run, refreshButtons, getStrategy: () => strategy };
}

const strategicAttackFeature = Object.freeze({
  id: 'wave-strategic-attack',
  group: GROUP,
  settings: [ENABLE_STRATEGY, WAIT_BUFFER, USE_DAMAGE_LIMIT, DAMAGE_LIMIT, ...ASTERION_SETTINGS],
  enabledBy: ENABLE_STRATEGY.key,
  matches: isWavePage,

  run(ctx) {
    if (!ctx.doc.querySelector('.qol-attacks, .qol-select-actions')) return null;
    addStyle(ctx.doc, STYLE_ID, CSS);
    const controller = createController(ctx);
    controller.inject();
    return controller;
  },
});

module.exports = {
  DAMAGE_LIMIT,
  ENABLE_STRATEGY,
  STRATEGY_KEY,
  USE_DAMAGE_LIMIT,
  WAIT_BUFFER,
  createController,
  readStrategy,
  selectedMonsterIds,
  strategicAttackFeature,
  strategyButtonLabel,
  writeStrategy,
};
