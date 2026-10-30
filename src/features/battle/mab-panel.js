'use strict';

// Monster Auto Battle: the settings/control panel below the monster card.
// Element ids are unchanged from the standalone userscript (#mabTarget,
// #mabStart, #mabStop, #mabStatus, #mabAttack1-3, #mabPoisonAttack,
// #mabAutoStamina, ...) because other scripts and muscle memory use them.

const { ATTACK_GROUPS, attackOptionLabel, sortAttackKeysByCost } = require('./mab-attacks');
const { cursorAfterFormat, formatNumber, formatTargetDisplay } = require('./mab-parse');
const { getConfiguredPotionAmount, movePotion, supportsMultiplePotionUse } = require('./mab-potions');
const { ID } = require('./mab-settings');

const STYLE_ID = `${ID}-style`;
const LOG_LIMIT = 60;
const FORM_FIELDS = Object.freeze([
  '#mabAttack1',
  '#mabAttack2',
  '#mabAttack3',
  '#mabPoisonAttack',
  '#mabDelay',
  '#mabAutoStamina',
  '#mabAutoMana',
  '#mabAutoHealth',
  '#mabLevelGuard',
  '#mabMultiplier',
]);
const POTION_LISTS = Object.freeze([
  ['stamina', '#mabStaminaList'],
  ['mana', '#mabManaList'],
  ['health', '#mabHealthList'],
]);

const CSS = `
  #${ID} { margin-top: 14px; color: #dfe6ff; font-family: inherit; }
  #${ID} * { box-sizing: border-box; }
  #${ID} details.mab-main { overflow: hidden; border: 1px solid #384063; border-radius: 14px; background: #111322; box-shadow: 0 10px 28px rgba(0,0,0,.4); }
  #${ID} .mab-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; cursor: pointer; list-style: none; background: #1d2138; font-weight: 800; user-select: none; }
  #${ID} .mab-header::-webkit-details-marker { display: none; }
  #${ID} .mab-note { color: #9aa7d7; font-size: 10px; text-transform: uppercase; }
  #${ID} .mab-body { padding: 13px; }
  #${ID} .mab-grid, #${ID} .mab-priority-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  #${ID} .mab-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: #cfd6f7; font-size: 12px; font-weight: 700; }
  #${ID} small { color: #8f99c2; }
  #${ID} select, #${ID} input[type="text"], #${ID} input[type="number"] { width: 100%; max-width: 100%; min-height: 36px; padding: 7px 9px; border: 1px solid #3a4163; border-radius: 9px; outline: none; background: #0e1020; color: #eef1ff; }
  #${ID} select:focus, #${ID} input:focus { border-color: #7488ff; box-shadow: 0 0 0 2px rgba(116,136,255,.16); }
  #${ID} .mab-options, #${ID} .mab-level-guard { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 15px; margin: 12px 0; padding: 10px; border: 1px solid #2e3452; border-radius: 10px; background: #14172a; font-size: 12px; }
  #${ID} .mab-level-guard { border-color: #594c2f; background: #211d16; }
  #${ID} .mab-level-guard input[type="number"] { width: 80px; min-height: 30px; }
  #${ID} input[type="checkbox"] { accent-color: #7185ff; }
  #${ID} fieldset, #${ID} .mab-health-box { min-width: 0; margin: 0; padding: 9px; border: 1px solid #2f3554; border-radius: 10px; background: #121526; }
  #${ID} .mab-health-box { margin-top: 10px; }
  #${ID} legend, #${ID} .mab-health-box > strong { color: #bfc8f5; font-size: 11px; font-weight: 800; text-transform: uppercase; }
  #${ID} .mab-list { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
  #${ID} .mab-potion-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; align-items: center; gap: 6px; padding: 5px 6px; border: 1px solid #2a304c; border-radius: 8px; background: #191c30; }
  #${ID} .mab-potion-main { min-width: 0; }
  #${ID} .mab-potion-name { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  #${ID} .mab-potion-amount { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: #98a4d2; font-size: 10px; font-weight: 600; }
  #${ID} .mab-potion-amount input[type="number"] { width: 68px; min-height: 26px; padding: 3px 6px; font-size: 11px; }
  #${ID} .mab-quantity { color: #98a4d2; font-size: 10px; font-variant-numeric: tabular-nums; }
  #${ID} .mab-moves { display: flex; gap: 4px; }
  #${ID} .mab-move { width: 25px; height: 25px; padding: 0; border: 1px solid #3a4267; border-radius: 6px; background: #242943; color: #e3e8ff; cursor: pointer; }
  #${ID} .mab-move:disabled { opacity: .35; cursor: default; }
  #${ID} .mab-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  #${ID} .mab-button { padding: 8px 12px; border: 1px solid transparent; border-radius: 9px; color: #fff; font-weight: 800; cursor: pointer; touch-action: manipulation; }
  #${ID} .mab-button:disabled { opacity: .45; cursor: default; }
  #${ID} .mab-start { border-color: #35845e; background: #245d42; }
  #${ID} .mab-stop { border-color: #9a3b45; background: #6e2930; }
  #${ID} .mab-secondary { border-color: #3b4267; background: #252a43; }
  #${ID} .mab-status { margin-top: 10px; padding: 9px 10px; border: 1px solid #343a59; border-radius: 9px; background: #171a2b; font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
  #${ID} .mab-status-running { border-color: #3d765d; background: #17271f; color: #b8f0cf; }
  #${ID} .mab-status-success { border-color: #476d85; background: #16242d; color: #c8ebff; }
  #${ID} .mab-status-error { border-color: #7e3b45; background: #2a171b; color: #ffc5cb; }
  #${ID} .mab-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 7px; margin-top: 10px; }
  #${ID} .mab-metrics > div { padding: 8px; border: 1px solid #2d3350; border-radius: 9px; background: #111423; }
  #${ID} .mab-metrics span { display: block; color: #8792bd; font-size: 9px; text-transform: uppercase; }
  #${ID} .mab-metrics strong { display: block; margin-top: 3px; font-size: 12px; font-variant-numeric: tabular-nums; }
  #${ID} .mab-log { max-height: 145px; overflow: auto; margin-top: 6px; padding: 7px; border: 1px solid #292f4b; border-radius: 8px; background: #0d0f1b; color: #aeb8df; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  #${ID} .mab-log > div + div { margin-top: 4px; }
  #${ID} .mab-empty, #${ID} .mab-hint { color: #7883aa; font-size: 10px; line-height: 1.45; }
  #${ID} .mab-hint { margin-top: 9px; }
  @media (max-width: 760px) {
    #${ID} .mab-grid, #${ID} .mab-priority-grid { grid-template-columns: 1fr; }
    #${ID} .mab-metrics { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 480px) {
    #${ID} .mab-body { padding: 10px; }
    #${ID} select, #${ID} input[type="text"], #${ID} .mab-grid input[type="number"] { font-size: 16px; }
    #${ID} .mab-controls .mab-button { flex: 1 1 100%; min-height: 42px; }
    #${ID} .mab-move { width: 34px; height: 34px; }
    #${ID} .mab-metrics { grid-template-columns: 1fr; }
  }
`;

const TEMPLATE = `
  <details class="mab-main">
    <summary class="mab-header">
      <span>🤖 Auto Battle</span>
      <span class="mab-note">Current monster only</span>
    </summary>
    <div class="mab-body">
      <div class="mab-grid">
        <label class="mab-field">
          <span>Attack 1 <small>Primary attack</small></span>
          <select id="mabAttack1"></select>
        </label>
        <label class="mab-field">
          <span>Attack 2 <small>First stamina fallback</small></span>
          <select id="mabAttack2"></select>
        </label>
        <label class="mab-field">
          <span>Attack 3 <small>Second stamina fallback</small></span>
          <select id="mabAttack3"></select>
        </label>
        <label class="mab-field">
          <span>Attack while poisoned <small>Only when the newest own log entry reports poison</small></span>
          <select id="mabPoisonAttack"></select>
        </label>
        <label class="mab-field">
          <span>Total monster damage target <small>Includes damage dealt before Start. 0 means unlimited.</small></span>
          <input id="mabTarget" type="text" inputmode="decimal" autocomplete="off" placeholder="5b or 5,000,000,000">
        </label>
        <label class="mab-field">
          <span>Delay between attacks in ms</span>
          <input id="mabDelay" type="number" inputmode="numeric" min="0" step="50">
        </label>
      </div>
      <div class="mab-options">
        <label><input id="mabAutoStamina" type="checkbox"> Use stamina potions automatically</label>
        <label><input id="mabAutoMana" type="checkbox"> Use mana potions automatically</label>
        <label><input id="mabAutoHealth" type="checkbox"> Use a full health potion when defeated</label>
      </div>
      <div class="mab-level-guard">
        <label><input id="mabLevelGuard" type="checkbox"> Stop before level-up</label>
        <span>when remaining EXP is lower than</span>
        <input id="mabMultiplier" type="number" inputmode="decimal" min="0.1" step="0.1">
        <span>× the last EXP gain</span>
      </div>
      <div class="mab-priority-grid">
        <fieldset>
          <legend>Stamina potion priority</legend>
          <div id="mabStaminaList" class="mab-list"></div>
        </fieldset>
        <fieldset>
          <legend>Mana potion priority</legend>
          <div id="mabManaList" class="mab-list"></div>
        </fieldset>
      </div>
      <div class="mab-health-box">
        <strong>Health potions</strong>
        <div id="mabHealthList" class="mab-list"></div>
      </div>
      <div class="mab-controls">
        <button id="mabStart" class="mab-button mab-start" type="button">▶ Start</button>
        <button id="mabStop" class="mab-button mab-stop" type="button" disabled>■ Stop</button>
        <button id="mabRefresh" class="mab-button mab-secondary" type="button">↻ Refresh attacks and potions</button>
      </div>
      <div id="mabStatus" class="mab-status">Ready.</div>
      <div class="mab-metrics">
        <div><span>Total monster damage</span><strong id="mabSession">0</strong></div>
        <div><span>Last EXP gain</span><strong id="mabLast">—</strong></div>
        <div><span>Remaining EXP</span><strong id="mabExp">—</strong></div>
        <div><span>Stamina / Mana / HP</span><strong id="mabResources">— / — / —</strong></div>
      </div>
      <details>
        <summary>Log</summary>
        <div id="mabLog" class="mab-log"></div>
      </details>
      <div class="mab-hint">
        Attack choices are re-read from the current monster card before every attack.
        Attack 2 and Attack 3 are stamina fallbacks. The poison attack is used only when
        the newest attack-log entry by the player shown in the side drawer reports that
        the enemy is poisoned.
      </div>
    </div>
  </details>
`;

function injectStyles(doc) {
  if (doc.getElementById?.(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement)?.appendChild(style);
}

// Builds the panel element and returns the UI hooks the engine calls.
function createPanel(engine, doc) {
  const { state } = engine;
  const panel = doc.createElement('section');
  panel.id = ID;
  panel.innerHTML = TEMPLATE;
  const $ = (selector) => panel.querySelector(selector);

  function fillAttackSelect(select, selectedKey, withDisabledOption) {
    if (!select) return;
    select.replaceChildren();
    if (withDisabledOption) {
      const off = doc.createElement('option');
      off.value = '';
      off.textContent = 'Disabled — use normal attack priority';
      off.selected = !selectedKey;
      select.appendChild(off);
    }
    for (const groupName of ATTACK_GROUPS) {
      const attacks = state.attacks.filter((attack) => attack.group === groupName);
      if (!attacks.length) continue;
      const group = doc.createElement('optgroup');
      group.label = groupName;
      for (const attack of attacks) {
        const option = doc.createElement('option');
        option.value = attack.key;
        option.textContent = attackOptionLabel(attack, formatNumber);
        option.selected = attack.key === selectedKey;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
  }

  function renderAttackOptions() {
    for (let index = 0; index < 3; index += 1) {
      fillAttackSelect($(`#mabAttack${index + 1}`), state.settings.attackKeys[index], false);
    }
    fillAttackSelect($('#mabPoisonAttack'), state.settings.poisonAttackKey, true);
  }

  function renderPotionList(type, selector) {
    const container = $(selector);
    if (!container) return;
    container.replaceChildren();
    const potions = (state.settings.potionOrder[type] || [])
      .map((key) => state.potions.find((potion) => potion.key === key))
      .filter(Boolean);

    if (!potions.length) {
      const empty = doc.createElement('div');
      empty.className = 'mab-empty';
      empty.textContent = 'No matching potion was found.';
      container.appendChild(empty);
      return;
    }

    potions.forEach((potion, index) => {
      const row = doc.createElement('div');
      row.className = 'mab-potion-row';

      const enabled = doc.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = state.settings.potionEnabled[potion.key] !== false;
      enabled.title = 'Allow this potion';
      enabled.addEventListener('change', () => {
        state.settings.potionEnabled[potion.key] = enabled.checked;
        engine.saveSettings();
      });

      const main = doc.createElement('div');
      main.className = 'mab-potion-main';
      const name = doc.createElement('div');
      name.className = 'mab-potion-name';
      name.textContent = potion.name;
      name.title = potion.description;
      main.appendChild(name);

      if (supportsMultiplePotionUse(potion)) {
        const amountRow = doc.createElement('label');
        amountRow.className = 'mab-potion-amount';
        const amountLabel = doc.createElement('span');
        amountLabel.textContent = 'Use at once:';
        const amountInput = doc.createElement('input');
        amountInput.type = 'number';
        amountInput.min = '1';
        amountInput.step = '1';
        amountInput.value = String(getConfiguredPotionAmount(state.settings, potion));
        amountInput.title = 'Number of potions to use at once';
        amountInput.addEventListener('change', () => {
          const amount = Math.max(1, Math.floor(Number(amountInput.value) || 1));
          amountInput.value = String(amount);
          state.settings.potionUseAmount[potion.key] = amount;
          engine.saveSettings();
        });
        amountInput.addEventListener('click', (event) => event.stopPropagation());
        amountRow.append(amountLabel, amountInput);
        main.appendChild(amountRow);
      }

      const quantity = doc.createElement('div');
      quantity.className = 'mab-quantity';
      quantity.textContent = `×${formatNumber(potion.quantity)}`;

      const moves = doc.createElement('div');
      moves.className = 'mab-moves';
      const up = doc.createElement('button');
      const down = doc.createElement('button');
      for (const button of [up, down]) {
        button.type = 'button';
        button.className = 'mab-move';
      }
      up.textContent = '↑';
      up.title = 'Increase priority';
      up.disabled = index === 0;
      down.textContent = '↓';
      down.title = 'Decrease priority';
      down.disabled = index === potions.length - 1;
      const move = (direction) => {
        if (movePotion(state.settings, type, index, direction)) {
          engine.saveSettings();
          renderPotionLists();
        }
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      moves.append(up, down);

      row.append(enabled, main, quantity, moves);
      container.appendChild(row);
    });
  }

  function renderPotionLists() {
    engine.discoverPotions();
    for (const [type, selector] of POTION_LISTS) renderPotionList(type, selector);
  }

  function setStatus(message, tone = 'idle') {
    const element = $('#mabStatus');
    if (!element) return;
    element.textContent = message;
    element.className = `mab-status mab-status-${tone}`;
  }

  function log(message) {
    const container = $('#mabLog');
    if (!container) return;
    const line = doc.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString('en-GB')}] ${message}`;
    container.prepend(line);
    while (container.children.length > LOG_LIMIT) container.lastElementChild?.remove();
  }

  function updateButtons() {
    const start = $('#mabStart');
    const stop = $('#mabStop');
    if (start) start.disabled = state.running;
    if (stop) stop.disabled = !state.running;
  }

  function setText(selector, text) {
    const element = $(selector);
    if (element) element.textContent = text;
  }

  function updateMetrics() {
    const show = (value) => (Number.isFinite(value) ? formatNumber(value) : '—');
    setText('#mabSession', show(engine.getCurrentDamage()));
    setText('#mabLast', show(state.lastExperienceGain));
    setText('#mabExp', show(engine.getRemainingExperience()));
    setText(
      '#mabResources',
      [engine.getCurrentStamina(), engine.getCurrentMana(), engine.getCurrentHealth()].map(show).join(' / '),
    );
  }

  function readForm() {
    const { settings } = state;
    settings.attackKeys = sortAttackKeysByCost(
      state.attacks,
      [1, 2, 3].map(
        (number, index) => $(`#mabAttack${number}`)?.value || settings.attackKeys[index] || '',
      ),
    );
    settings.poisonAttackKey = $('#mabPoisonAttack')?.value || '';
    settings.targetDamage = $('#mabTarget')?.value.trim() || '0';
    settings.delayMs = Math.max(0, Number($('#mabDelay')?.value) || 0);
    const checked = (selector, fallback) => {
      const element = $(selector);
      return element ? element.checked === true : fallback;
    };
    settings.autoStamina = checked('#mabAutoStamina', settings.autoStamina);
    settings.autoMana = checked('#mabAutoMana', settings.autoMana);
    settings.autoHealth = checked('#mabAutoHealth', settings.autoHealth);
    settings.stopBeforeLevelUp = checked('#mabLevelGuard', settings.stopBeforeLevelUp);
    settings.levelMultiplier = Number($('#mabMultiplier')?.value) || 2;
    engine.saveSettings();
  }

  // Writes the settings into the form fields.
  function writeFormValues() {
    const { settings } = state;
    const details = $('.mab-main');
    if (details) details.open = !settings.collapsed;
    const target = $('#mabTarget');
    if (target) target.value = formatTargetDisplay(settings.targetDamage);
    const delay = $('#mabDelay');
    if (delay) delay.value = String(settings.delayMs);
    const multiplier = $('#mabMultiplier');
    if (multiplier) multiplier.value = String(settings.levelMultiplier);
    for (const [selector, key] of [
      ['#mabAutoStamina', 'autoStamina'],
      ['#mabAutoMana', 'autoMana'],
      ['#mabAutoHealth', 'autoHealth'],
      ['#mabLevelGuard', 'stopBeforeLevelUp'],
    ]) {
      const element = $(selector);
      if (element) element.checked = settings[key] === true;
    }
  }

  // After the automation bridge changed settings: refresh the whole form so
  // a later readForm (e.g. on Start) keeps the new values.
  function syncForm() {
    writeFormValues();
    renderAttackOptions();
    renderPotionLists();
  }

  function formatTargetInput(input) {
    const original = input.value;
    if (/[kmbtq]$/i.test(original.trim())) return;
    const cursor = input.selectionStart ?? original.length;
    const formatted = formatTargetDisplay(original);
    input.value = formatted;
    const position = cursorAfterFormat(original, cursor, formatted);
    try {
      input.setSelectionRange(position, position);
    } catch {
      // Some input types do not support cursor positioning.
    }
  }

  function bindEvents() {
    const details = $('.mab-main');
    details?.addEventListener('toggle', () => {
      state.settings.collapsed = !details.open;
      engine.saveSettings();
    });
    $('#mabStart')?.addEventListener('click', () => void engine.start());
    $('#mabStop')?.addEventListener('click', () => engine.stop());
    $('#mabRefresh')?.addEventListener('click', () => {
      engine.discoverAttacks();
      engine.discoverPotions();
      renderAttackOptions();
      renderPotionLists();
      engine.refreshMetrics();
      engine.setStatus('Attacks and potions were refreshed.', 'success');
    });

    for (const selector of FORM_FIELDS) {
      const element = $(selector);
      if (!element) continue;
      element.addEventListener('change', () => {
        readForm();
        if (/^#mabAttack\d+$/.test(selector)) renderAttackOptions();
      });
      if (element.matches?.('input[type="text"], input[type="number"]')) element.addEventListener('input', readForm);
    }

    const target = $('#mabTarget');
    if (target) {
      target.addEventListener('input', () => {
        formatTargetInput(target);
        readForm();
      });
      const normalize = () => {
        target.value = formatTargetDisplay(target.value);
        readForm();
      };
      target.addEventListener('blur', normalize);
      target.addEventListener('change', normalize);
    }
  }

  const ui = { setStatus, log, renderAttackOptions, renderPotionLists, updateButtons, updateMetrics, readForm };

  writeFormValues();
  bindEvents();

  return { element: panel, ui, syncForm };
}

module.exports = {
  CSS,
  STYLE_ID,
  createPanel,
  injectStyles,
};
