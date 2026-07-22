// ==UserScript==
// @name         Auto Farm Profile Manager
// @namespace    local.auto-farm-profile-manager
// @version      1.0.1
// @description  Speichert pro Monster eigene Auto-Farm-Einstellungen und wendet sie mit einem Klick an.
// @match        https://demonicscans.org/active_wave.php*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /*
   * WICHTIG:
   * Das Skript arbeitet ausschließlich auf Seiten, auf denen #autoFarmPanel existiert.
   * Trotzdem solltest du die @match-Zeile oben später auf die konkrete Spiel-Domain einschränken.
   */

  const STORAGE_KEY = 'af-profile-manager:v1';
  const PANEL_ID = 'afpmPanel';
  const STATUS_ID = 'afpmStatus';

  const DEFAULT_PROFILE = Object.freeze({
    mode: '1',
    minDamage: 30000000,
    stack: 50,
    kills: 10,
    hpMax: 100,
    s20Max: 0,
    halfMax: 0,
    fullMax: 0,
    advMax: 0,
    priority: '251',
    autoLoot: '0',
    expLeft: 100,
  });

  const DEFAULT_OPTIONS = Object.freeze({
    disableOthers: true,
    resetBeforeStart: true,
    actionDelay: 350,
  });

  let state = loadState();
  let rebuildTimer = null;
  let lastMonsterSignature = '';

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

      return {
        profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},

        options: {
          ...DEFAULT_OPTIONS,
          ...(parsed.options && typeof parsed.options === 'object' ? parsed.options : {}),
        },
      };
    } catch (error) {
      console.warn('[AFPM] Gespeicherte Daten konnten nicht gelesen werden.', error);

      return {
        profiles: {},
        options: { ...DEFAULT_OPTIONS },
      };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  function normalizeName(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getGroupName(row) {
    const element = row?.querySelector('.af-group-names');

    if (!element) {
      return '';
    }

    const title = normalizeName(element.getAttribute('title'));

    if (title) {
      return title;
    }

    return normalizeName(element.textContent.replace(/^\s*\d+\s*x\s*/i, ''));
  }

  function getGroupRows() {
    return [...document.querySelectorAll('#af-grouped-view .af-group-row')];
  }

  function getGroupRowByName(name) {
    const wanted = normalizeName(name).toLowerCase();

    return (
      getGroupRows().find((row) => {
        return getGroupName(row).toLowerCase() === wanted;
      }) || null
    );
  }

  function discoverMonsters() {
    const names = new Set();

    for (const row of getGroupRows()) {
      const name = getGroupName(row);

      if (name) {
        names.add(name);
      }
    }

    document.querySelectorAll('.afTMonster option').forEach((option) => {
      const name = normalizeName(option.textContent);

      if (name) {
        names.add(name);
      }
    });

    document.querySelectorAll('#afMultiGrid .af-ms-check').forEach((check) => {
      const label = check.closest('label');

      const name = normalizeName(label?.querySelector('span')?.textContent || label?.textContent);

      if (name) {
        names.add(name);
      }
    });

    return [...names].sort((a, b) => {
      return a.localeCompare(b, 'de', { sensitivity: 'base' });
    });
  }

  function readNumber(id, fallback) {
    const element = document.getElementById(id);

    return clampNumber(element?.value, 0, Number.MAX_SAFE_INTEGER, fallback);
  }

  function readCurrentGlobalSettings() {
    return {
      kills: readNumber('afTotalToKill', DEFAULT_PROFILE.kills),

      hpMax: readNumber('afHpMax', DEFAULT_PROFILE.hpMax),

      s20Max: readNumber('afSt20Max', DEFAULT_PROFILE.s20Max),

      halfMax: readNumber('afStHalfMax', DEFAULT_PROFILE.halfMax),

      fullMax: readNumber('afStFullMax', DEFAULT_PROFILE.fullMax),

      advMax: readNumber('afStAdvMax', DEFAULT_PROFILE.advMax),

      priority: document.getElementById('afStPriority')?.value ?? DEFAULT_PROFILE.priority,

      autoLoot: document.getElementById('afAutoLootToLevel')?.value ?? DEFAULT_PROFILE.autoLoot,

      expLeft: readNumber('afPrcExpLeft', DEFAULT_PROFILE.expLeft),
    };
  }

  function readCurrentGroupSettings(name) {
    const row = getGroupRowByName(name);

    if (!row) {
      return {
        mode: DEFAULT_PROFILE.mode,
        minDamage: DEFAULT_PROFILE.minDamage,
        stack: DEFAULT_PROFILE.stack,
      };
    }

    return {
      mode: row.querySelector('.grp-mode')?.value ?? DEFAULT_PROFILE.mode,

      minDamage: clampNumber(
        row.querySelector('.grp-min')?.value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.minDamage,
      ),

      stack: clampNumber(row.querySelector('.grp-stack')?.value, 1, 250, DEFAULT_PROFILE.stack),
    };
  }

  function getProfile(name) {
    if (!state.profiles[name]) {
      state.profiles[name] = {
        ...DEFAULT_PROFILE,
        ...readCurrentGlobalSettings(),
        ...readCurrentGroupSettings(name),
      };

      saveState();
    }

    return {
      ...DEFAULT_PROFILE,
      ...state.profiles[name],
    };
  }

  function updateProfile(name, patch) {
    state.profiles[name] = {
      ...getProfile(name),
      ...patch,
    };

    saveState();
  }

  function setNativeValue(element, value) {
    if (!element) {
      return false;
    }

    const stringValue = String(value);
    const prototype = Object.getPrototypeOf(element);

    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor?.set) {
      descriptor.set.call(element, stringValue);
    } else {
      element.value = stringValue;
    }

    element.dispatchEvent(
      new Event('input', {
        bubbles: true,
      }),
    );

    element.dispatchEvent(
      new Event('change', {
        bubbles: true,
      }),
    );

    return true;
  }

  function clickElement(element) {
    if (!element || element.disabled) {
      return false;
    }

    element.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );

    return true;
  }

  function setStatus(message, type = 'info') {
    const status = document.getElementById(STATUS_ID);

    if (!status) {
      return;
    }

    status.textContent = message;
    status.dataset.type = type;
  }

  function profileFromRow(row) {
    return {
      mode: row.querySelector('[data-field="mode"]').value,

      minDamage: clampNumber(
        row.querySelector('[data-field="minDamage"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.minDamage,
      ),

      stack: clampNumber(row.querySelector('[data-field="stack"]').value, 1, 250, DEFAULT_PROFILE.stack),

      kills: clampNumber(
        row.querySelector('[data-field="kills"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.kills,
      ),

      hpMax: clampNumber(
        row.querySelector('[data-field="hpMax"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.hpMax,
      ),

      s20Max: clampNumber(
        row.querySelector('[data-field="s20Max"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.s20Max,
      ),

      halfMax: clampNumber(
        row.querySelector('[data-field="halfMax"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.halfMax,
      ),

      fullMax: clampNumber(
        row.querySelector('[data-field="fullMax"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.fullMax,
      ),

      advMax: clampNumber(
        row.querySelector('[data-field="advMax"]').value,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROFILE.advMax,
      ),

      priority: row.querySelector('[data-field="priority"]').value,

      autoLoot: row.querySelector('[data-field="autoLoot"]').checked ? '1' : '0',

      expLeft: clampNumber(row.querySelector('[data-field="expLeft"]').value, 0, 100, DEFAULT_PROFILE.expLeft),
    };
  }

  function persistRow(row) {
    const name = row.dataset.monsterName;

    if (!name) {
      return;
    }

    updateProfile(name, profileFromRow(row));

    row.classList.add('afpm-saved');

    window.setTimeout(() => {
      row.classList.remove('afpm-saved');
    }, 500);
  }

  function createNumberInput(field, value, min = 0, max = null, title = '') {
    const input = document.createElement('input');

    input.type = 'number';
    input.dataset.field = field;
    input.value = String(value);
    input.min = String(min);

    if (max !== null) {
      input.max = String(max);
    }

    if (title) {
      input.title = title;
    }

    return input;
  }

  function createSelect(field, value, options) {
    const select = document.createElement('select');

    select.dataset.field = field;

    for (const [optionValue, label] of options) {
      const option = document.createElement('option');

      option.value = optionValue;
      option.textContent = label;

      select.append(option);
    }

    select.value = String(value);

    return select;
  }

  function createProfileRow(name) {
    const profile = getProfile(name);

    const row = document.createElement('tr');

    row.dataset.monsterName = name;

    const monsterCell = document.createElement('td');

    monsterCell.className = 'afpm-monster';
    monsterCell.textContent = name;
    monsterCell.title = name;

    row.append(monsterCell);

    const modeCell = document.createElement('td');

    modeCell.append(
      createSelect('mode', profile.mode, [
        ['0', 'CAP'],
        ['1', 'Fixed'],
      ]),
    );

    row.append(modeCell);

    const damageCell = document.createElement('td');

    damageCell.append(createNumberInput('minDamage', profile.minDamage, 0, null, 'MIN damage'));

    row.append(damageCell);

    const stackCell = document.createElement('td');

    stackCell.append(createNumberInput('stack', profile.stack, 1, 250, 'Max stack'));

    row.append(stackCell);

    const killsCell = document.createElement('td');

    killsCell.append(createNumberInput('kills', profile.kills, 0, null, 'Zu jagende Monster'));

    row.append(killsCell);

    const hpCell = document.createElement('td');

    hpCell.append(createNumberInput('hpMax', profile.hpMax, 0, null, 'Maximale HP-Tränke'));

    row.append(hpCell);

    const s20Cell = document.createElement('td');

    s20Cell.append(createNumberInput('s20Max', profile.s20Max, 0, null, 'Small Stamina Potion'));

    row.append(s20Cell);

    const halfCell = document.createElement('td');

    halfCell.append(createNumberInput('halfMax', profile.halfMax, 0, null, 'Large Stamina Potion'));

    row.append(halfCell);

    const fullCell = document.createElement('td');

    fullCell.append(createNumberInput('fullMax', profile.fullMax, 0, null, 'Full Stamina Potion'));

    row.append(fullCell);

    const advCell = document.createElement('td');

    advCell.append(createNumberInput('advMax', profile.advMax, 0, null, 'Adventurer Stamina Potion'));

    row.append(advCell);

    const priorityCell = document.createElement('td');

    priorityCell.append(
      createSelect('priority', profile.priority, [
        ['0', 'Keine'],
        ['30', 'Small'],
        ['251', 'Large'],
        ['35', 'Full'],
        ['359', 'Adventurer'],
      ]),
    );

    row.append(priorityCell);

    const lootCell = document.createElement('td');

    const lootLabel = document.createElement('label');

    lootLabel.className = 'afpm-check';

    const lootCheck = document.createElement('input');

    lootCheck.type = 'checkbox';
    lootCheck.dataset.field = 'autoLoot';
    lootCheck.checked = profile.autoLoot === '1';

    lootLabel.append(lootCheck, document.createTextNode(' Loot'));

    lootCell.append(lootLabel);
    row.append(lootCell);

    const expCell = document.createElement('td');

    expCell.append(createNumberInput('expLeft', profile.expLeft, 0, 100, 'EXP-left threshold in Prozent'));

    row.append(expCell);

    const actionCell = document.createElement('td');

    actionCell.className = 'afpm-actions';

    const applyButton = document.createElement('button');

    applyButton.type = 'button';
    applyButton.textContent = '✓ Übernehmen';

    applyButton.addEventListener('click', () => {
      runProfile(name, false, applyButton);
    });

    const startButton = document.createElement('button');

    startButton.type = 'button';
    startButton.textContent = '▶ Start';
    startButton.className = 'afpm-primary';

    startButton.addEventListener('click', () => {
      runProfile(name, true, startButton);
    });

    actionCell.append(applyButton, startButton);

    row.append(actionCell);

    row.querySelectorAll('input, select').forEach((control) => {
      control.addEventListener('change', () => persistRow(row));
    });

    return row;
  }

  function createPanel() {
    const existing = document.getElementById(PANEL_ID);

    if (existing) {
      return existing;
    }

    const farmPanel = document.getElementById('autoFarmPanel');

    if (!farmPanel) {
      return null;
    }

    const panel = document.createElement('section');

    panel.id = PANEL_ID;

    panel.innerHTML = `
            <div class="afpm-header">
                <div>
                    <strong>🧭 Auto-Farm-Profile</strong>

                    <div class="afpm-sub">
                        Pro Monster eigene Werte speichern und mit einem Klick laden.
                        Bei Tränken bedeutet 0: deaktiviert.
                    </div>
                </div>

                <div class="afpm-header-actions">
                    <label>
                        <input
                            type="checkbox"
                            id="afpmDisableOthers"
                        >
                        andere Ziele deaktivieren
                    </label>

                    <label>
                        <input
                            type="checkbox"
                            id="afpmResetBeforeStart"
                        >
                        vor Start resetten
                    </label>

                    <button
                        type="button"
                        id="afpmReload"
                    >
                        ↻ Neu einlesen
                    </button>

                    <button
                        type="button"
                        id="afpmExport"
                    >
                        Export
                    </button>

                    <button
                        type="button"
                        id="afpmImport"
                    >
                        Import
                    </button>
                </div>
            </div>

            <div
                id="${STATUS_ID}"
                data-type="info"
            >
                Bereit. Änderungen in der Tabelle werden automatisch gespeichert.
            </div>

            <div class="afpm-table-wrap">
                <table class="afpm-table">
                    <thead>
                        <tr>
                            <th>Monster</th>
                            <th>Modus</th>
                            <th>MIN Schaden</th>
                            <th>Stack</th>
                            <th>Anzahl</th>
                            <th>HP</th>
                            <th title="Small Stamina Potion">
                                S20
                            </th>
                            <th title="Large Stamina Potion">
                                Large
                            </th>
                            <th title="Full Stamina Potion">
                                Full
                            </th>
                            <th title="Adventurer Stamina Potion">
                                Adv
                            </th>
                            <th>Priorität</th>
                            <th>Auto Loot</th>
                            <th>EXP %</th>
                            <th>Aktion</th>
                        </tr>
                    </thead>

                    <tbody id="afpmTableBody"></tbody>
                </table>
            </div>
        `;

    const style = document.createElement('style');

    style.id = 'afpmStyles';

    style.textContent = `
            #${PANEL_ID} {
                margin: 14px 0;
                padding: 14px;
                border: 1px solid #3d4267;
                border-radius: 12px;
                background:
                    linear-gradient(
                        180deg,
                        #171a2b,
                        #11131f
                    );
                color: #f1f3ff;
                box-shadow:
                    0 10px 30px
                    rgba(0, 0, 0, .35);
            }

            #${PANEL_ID} * {
                box-sizing: border-box;
            }

            .afpm-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 12px;
                flex-wrap: wrap;
                margin-bottom: 10px;
            }

            .afpm-header strong {
                color: #ffd369;
                font-size: 16px;
            }

            .afpm-sub {
                margin-top: 4px;
                color: #aeb5dc;
                font-size: 12px;
            }

            .afpm-header-actions {
                display: flex;
                align-items: center;
                gap: 10px;
                flex-wrap: wrap;
                font-size: 12px;
            }

            .afpm-header-actions label {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                white-space: nowrap;
            }

            #${PANEL_ID} button {
                border: 1px solid #444b78;
                border-radius: 7px;
                background: #292d49;
                color: #f7f8ff;
                padding: 7px 10px;
                cursor: pointer;
                white-space: nowrap;
            }

            #${PANEL_ID} button:hover {
                filter: brightness(1.14);
            }

            #${PANEL_ID} button:disabled {
                cursor: wait;
                opacity: .55;
            }

            #${PANEL_ID} .afpm-primary {
                border-color: #a76f00;
                background: #805700;
                color: #fff4cf;
            }

            #${STATUS_ID} {
                margin: 8px 0 12px;
                min-height: 34px;
                padding: 8px 10px;
                border-radius: 8px;
                background: #20243a;
                color: #cdd3ff;
                font-size: 12px;
            }

            #${STATUS_ID}[data-type="success"] {
                background: #173524;
                color: #bff4ce;
            }

            #${STATUS_ID}[data-type="error"] {
                background: #451f2a;
                color: #ffd0da;
            }

            #${STATUS_ID}[data-type="busy"] {
                background: #3a311a;
                color: #ffe7a7;
            }

            .afpm-table-wrap {
                overflow-x: auto;
                border: 1px solid #303552;
                border-radius: 9px;
            }

            .afpm-table {
                width: 100%;
                min-width: 1480px;
                border-collapse: collapse;
                font-size: 12px;
            }

            .afpm-table th,
            .afpm-table td {
                padding: 7px;
                border-bottom:
                    1px solid #2c304a;
                text-align: center;
                vertical-align: middle;
            }

            .afpm-table th {
                position: sticky;
                top: 0;
                z-index: 1;
                background: #242842;
                color: #dce0ff;
            }

            .afpm-table tbody tr:hover {
                background:
                    rgba(
                        126,
                        141,
                        255,
                        .07
                    );
            }

            .afpm-table tbody tr.afpm-saved {
                background:
                    rgba(
                        61,
                        188,
                        110,
                        .15
                    );
            }

            .afpm-table input[type="number"] {
                width: 96px;
            }

            .afpm-table select,
            .afpm-table input[type="number"] {
                padding: 6px;
                border: 1px solid #3e446b;
                border-radius: 6px;
                background: #171a2b;
                color: #f3f4ff;
            }

            .afpm-monster {
                min-width: 220px;
                max-width: 280px;
                text-align: left !important;
                font-weight: 700;
                color: #ffd369;
            }

            .afpm-check {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                white-space: nowrap;
            }

            .afpm-actions {
                display: flex;
                gap: 6px;
                justify-content: center;
            }
        `;

    document.head.append(style);

    const anchor =
      farmPanel.querySelector('#autoFarmBody') ||
      farmPanel.querySelector('.af-mini-bars')?.nextElementSibling ||
      farmPanel.firstElementChild;

    if (anchor) {
      farmPanel.insertBefore(panel, anchor);
    } else {
      farmPanel.append(panel);
    }

    const disableOthers = panel.querySelector('#afpmDisableOthers');

    const resetBeforeStart = panel.querySelector('#afpmResetBeforeStart');

    disableOthers.checked = Boolean(state.options.disableOthers);

    resetBeforeStart.checked = Boolean(state.options.resetBeforeStart);

    disableOthers.addEventListener('change', () => {
      state.options.disableOthers = disableOthers.checked;

      saveState();
    });

    resetBeforeStart.addEventListener('change', () => {
      state.options.resetBeforeStart = resetBeforeStart.checked;

      saveState();
    });

    panel.querySelector('#afpmReload').addEventListener('click', () => {
      buildRows(true);

      setStatus('Monsterliste wurde neu eingelesen.', 'success');
    });

    panel.querySelector('#afpmExport').addEventListener('click', async () => {
      const payload = JSON.stringify(state, null, 2);

      try {
        await navigator.clipboard.writeText(payload);

        setStatus('Profile wurden in die Zwischenablage kopiert.', 'success');
      } catch {
        window.prompt('Profile kopieren:', payload);
      }
    });

    panel.querySelector('#afpmImport').addEventListener('click', () => {
      const input = window.prompt('Exportierte Profildaten einfügen:');

      if (!input) {
        return;
      }

      try {
        const parsed = JSON.parse(input);

        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Ungültige Daten');
        }

        state = {
          profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},

          options: {
            ...DEFAULT_OPTIONS,
            ...(parsed.options && typeof parsed.options === 'object' ? parsed.options : {}),
          },
        };

        saveState();

        disableOthers.checked = Boolean(state.options.disableOthers);

        resetBeforeStart.checked = Boolean(state.options.resetBeforeStart);

        buildRows(true);

        setStatus('Profile wurden importiert.', 'success');
      } catch (error) {
        setStatus(`Import fehlgeschlagen: ${error.message}`, 'error');
      }
    });

    return panel;
  }

  function buildRows(force = false) {
    const panel = createPanel();

    if (!panel) {
      return;
    }

    const monsters = discoverMonsters();

    const signature = monsters.join('\u0000');

    if (!force && signature === lastMonsterSignature) {
      return;
    }

    lastMonsterSignature = signature;

    const body = panel.querySelector('#afpmTableBody');

    if (!body) {
      return;
    }

    body.replaceChildren();

    for (const name of monsters) {
      body.append(createProfileRow(name));
    }

    if (monsters.length === 0) {
      const row = document.createElement('tr');

      const cell = document.createElement('td');

      cell.colSpan = 14;
      cell.textContent = 'Noch keine Monster-Ziele gefunden.';

      row.append(cell);
      body.append(row);
    }
  }

  async function waitForGroupRow(name, timeout = 5000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const row = getGroupRowByName(name);

      if (row) {
        return row;
      }

      await sleep(150);
    }

    return null;
  }

  async function ensureTargetExists(name, profile) {
    let row = getGroupRowByName(name);

    if (row) {
      return row;
    }

    const checks = [...document.querySelectorAll('#afMultiGrid .af-ms-check')];

    const targetCheck = checks.find((check) => {
      const label = check.closest('label');

      const labelName = normalizeName(label?.querySelector('span')?.textContent || label?.textContent);

      return labelName.toLowerCase() === name.toLowerCase();
    });

    if (!targetCheck) {
      throw new Error(`Für "${name}" wurde weder ein vorhandenes Ziel noch ein Quick-Add-Eintrag gefunden.`);
    }

    checks.forEach((check) => {
      check.checked = false;

      check.dispatchEvent(
        new Event('change', {
          bubbles: true,
        }),
      );
    });

    targetCheck.checked = true;

    targetCheck.dispatchEvent(
      new Event('change', {
        bubbles: true,
      }),
    );

    setNativeValue(document.getElementById('afAddMode'), profile.mode);

    setNativeValue(document.getElementById('afAddMin'), profile.minDamage);

    setNativeValue(document.getElementById('afAddEnabled'), '0');

    setNativeValue(document.getElementById('afAddStack'), profile.stack);

    const addButton = document.getElementById('afAddBtn');

    if (!clickElement(addButton)) {
      throw new Error('Der Button "Add Selected" konnte nicht ausgelöst werden.');
    }

    row = await waitForGroupRow(name);

    if (!row) {
      throw new Error(`Das Ziel "${name}" wurde nach Quick Add nicht gefunden.`);
    }

    return row;
  }

  async function saveGroup(name, values) {
    const row = getGroupRowByName(name);

    if (!row) {
      throw new Error(`Zielzeile für "${name}" nicht gefunden.`);
    }

    if (values.enabled !== undefined) {
      setNativeValue(row.querySelector('.grp-enabled'), values.enabled);
    }

    if (values.mode !== undefined) {
      setNativeValue(row.querySelector('.grp-mode'), values.mode);
    }

    if (values.minDamage !== undefined) {
      setNativeValue(row.querySelector('.grp-min'), values.minDamage);
    }

    if (values.stack !== undefined) {
      setNativeValue(row.querySelector('.grp-stack'), values.stack);
    }

    const saveButton = row.querySelector('.grp-save');

    if (!clickElement(saveButton)) {
      throw new Error(`Speichern für "${name}" konnte nicht ausgelöst werden.`);
    }

    await sleep(state.options.actionDelay);
  }

  async function disableOtherTargets(selectedName) {
    const names = getGroupRows()
      .map(getGroupName)
      .filter(Boolean)
      .filter((name) => {
        return name !== selectedName;
      });

    for (const name of names) {
      const row = getGroupRowByName(name);

      const enabled = row?.querySelector('.grp-enabled');

      if (enabled?.value === '1') {
        setStatus(`Deaktiviere Ziel: ${name}`, 'busy');

        await saveGroup(name, { enabled: '0' });
      }
    }
  }

  async function applyGlobalSettings(profile) {
    const fields = [
      ['afTotalToKill', profile.kills],
      ['afHpMax', profile.hpMax],
      ['afSt20Max', profile.s20Max],
      ['afStHalfMax', profile.halfMax],
      ['afStFullMax', profile.fullMax],
      ['afStAdvMax', profile.advMax],
      ['afStPriority', profile.priority],
    ];

    for (const [id, value] of fields) {
      setNativeValue(document.getElementById(id), value);
    }

    setNativeValue(document.getElementById('afAutoLootToLevel'), profile.autoLoot);

    await sleep(80);

    setNativeValue(document.getElementById('afPrcExpLeft'), profile.expLeft);

    const saveButton = document.getElementById('afSaveSettingsBtn');

    if (!clickElement(saveButton)) {
      throw new Error('Die allgemeinen Auto-Farm-Einstellungen konnten nicht gespeichert werden.');
    }

    await sleep(state.options.actionDelay);
  }

  function setAllProfileButtonsDisabled(disabled) {
    document.querySelectorAll(`#${PANEL_ID} .afpm-actions button`).forEach((button) => {
      button.disabled = disabled;
    });
  }

  async function runProfile(name, shouldStart, clickedButton) {
    const row = clickedButton.closest('tr');

    persistRow(row);

    const profile = getProfile(name);

    setAllProfileButtonsDisabled(true);

    try {
      setStatus(`Profil "${name}" wird vorbereitet.`, 'busy');

      const pauseButton = document.getElementById('afPauseBtn');

      clickElement(pauseButton);

      await sleep(150);

      if (shouldStart && state.options.resetBeforeStart) {
        setStatus('Auto Farm wird zurückgesetzt.', 'busy');

        clickElement(document.getElementById('afResetBtn'));

        await sleep(state.options.actionDelay);
      }

      await ensureTargetExists(name, profile);

      if (state.options.disableOthers) {
        await disableOtherTargets(name);
      }

      setStatus(`Aktiviere und konfiguriere ${name}.`, 'busy');

      await saveGroup(name, {
        enabled: '1',
        mode: profile.mode,
        minDamage: profile.minDamage,
        stack: profile.stack,
      });

      setStatus('Übernehme Monsteranzahl, Tränke und Loot-Einstellungen.', 'busy');

      await applyGlobalSettings(profile);

      if (shouldStart) {
        setStatus(`Starte Auto Farm für ${name}.`, 'busy');

        if (!clickElement(document.getElementById('afStartBtn'))) {
          throw new Error('Der Auto-Farm-Startknopf konnte nicht ausgelöst werden.');
        }

        setStatus(`Auto Farm für "${name}" wurde gestartet.`, 'success');
      } else {
        setStatus(`Profil "${name}" wurde übernommen.`, 'success');
      }
    } catch (error) {
      console.error('[AFPM]', error);

      setStatus(error.message || String(error), 'error');
    } finally {
      setAllProfileButtonsDisabled(false);
    }
  }

  function scheduleRebuild() {
    window.clearTimeout(rebuildTimer);

    rebuildTimer = window.setTimeout(() => buildRows(false), 250);
  }

  function init() {
    const existingPanel = document.getElementById('autoFarmPanel');

    if (existingPanel) {
      createPanel();
      buildRows(true);
    }

    const observer = new MutationObserver(() => {
      if (document.getElementById('autoFarmPanel')) {
        createPanel();
        scheduleRebuild();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  init();
})();
