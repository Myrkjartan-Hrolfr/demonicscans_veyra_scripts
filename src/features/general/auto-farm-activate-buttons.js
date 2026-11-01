'use strict';

const SETTING = Object.freeze({
  key: 'veyra:autoFarm:showTargetActivateButtons',
  label: 'Show Auto Farm target Activate buttons',
  type: 'checkbox',
  default: true,
  hint: 'Adds an Activate button that enables the selected target group and disables every other group.',
});

const SELECTORS = Object.freeze({
  targets: '.af-targets',
  row: '.af-group-row',
  enabled: '.grp-enabled',
  actions: '.btn-group-actions',
  save: '.grp-save',
  delete: '.grp-del-all',
});

const BUTTON_CLASS = 'af-exclusive-activate-btn';
const PROCESSING_CLASS = 'af-exclusive-processing';
const STYLE_ID = 'veyra-automation-auto-farm-activate-style';
const LOADED_FLAG = '__veyraAutoFarmActivateButtonsLoaded';

function groupRows(doc) {
  return Array.from(doc?.querySelectorAll?.(`${SELECTORS.targets} ${SELECTORS.row}`) || []);
}

function setEnabled(win, select, value) {
  if (!select || String(select.value) === value) return false;
  select.value = value;
  const EventConstructor = win?.Event || globalThis.Event;
  if (typeof select.dispatchEvent === 'function' && typeof EventConstructor === 'function') {
    select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  }
  return true;
}

function activateExclusiveGroup(doc, win, targetRow) {
  const rows = groupRows(doc);
  if (!targetRow || !rows.includes(targetRow) || !targetRow.querySelector?.(SELECTORS.enabled)) return 0;

  const changedRows = [];
  for (const row of rows) {
    const desired = row === targetRow ? '1' : '0';
    if (setEnabled(win, row.querySelector?.(SELECTORS.enabled), desired)) changedRows.push(row);
  }
  if (!changedRows.includes(targetRow)) changedRows.push(targetRow);

  // Collect first: a native Save handler may rebuild and detach all rows.
  const buttons = changedRows
    .map((row) => row.querySelector?.(SELECTORS.save))
    .filter((button) => typeof button?.click === 'function');
  for (const button of buttons) button.click();
  return buttons.length;
}

function injectStyle(doc) {
  if (!doc?.head || doc.getElementById?.(STYLE_ID) || typeof doc.createElement !== 'function') return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BUTTON_CLASS}{border-color:#5dce8a!important;background:rgba(44,160,90,.16)!important;color:#bfffd5!important;white-space:nowrap}
    .${BUTTON_CLASS}:hover:not(:disabled){background:rgba(44,160,90,.3)!important;box-shadow:0 0 10px rgba(93,206,138,.25)}
    .${BUTTON_CLASS}:disabled,.${BUTTON_CLASS}.${PROCESSING_CLASS}{cursor:progress;opacity:.75}
  `;
  doc.head.appendChild(style);
}

function decorate(doc) {
  let added = 0;
  for (const row of groupRows(doc)) {
    if (row.querySelector?.(`.${BUTTON_CLASS}`)) continue;
    const actions = row.querySelector?.(SELECTORS.actions);
    if (!actions || !row.querySelector?.(SELECTORS.enabled) || !row.querySelector?.(SELECTORS.save)) continue;
    const button = doc.createElement?.('button');
    if (!button) continue;
    button.type = 'button';
    button.className = `btn ${BUTTON_CLASS}`;
    button.textContent = '⚡ Activate';
    button.title = 'Activate this target group and disable all other groups';
    const deleteButton = actions.querySelector?.(SELECTORS.delete);
    if (deleteButton && typeof actions.insertBefore === 'function') actions.insertBefore(button, deleteButton);
    else actions.appendChild?.(button);
    added += 1;
  }
  return added;
}

module.exports = Object.freeze({
  id: 'auto-farm-activate-buttons',
  group: 'General',
  settings: [SETTING],
  enabledBy: SETTING.key,
  SETTING,
  activateExclusiveGroup,
  decorate,

  matches(url) {
    return /\/active_wave\.php\/?$/i.test(url.pathname);
  },

  run({ win, doc, log, warn }) {
    if (!win || !doc || win[LOADED_FLAG]) return;
    win[LOADED_FLAG] = true;
    injectStyle(doc);

    let activationRunning = false;
    let observer = null;
    let scanPending = false;
    let stopped = false;
    const timers = new Set();

    const later = (callback, delay) => {
      const timer = win.setTimeout?.(() => {
        timers.delete(timer);
        if (!stopped) callback();
      }, delay);
      if (timer !== undefined && timer !== null) timers.add(timer);
    };
    const scheduleDecorate = () => {
      if (stopped || scanPending) return;
      scanPending = true;
      later(() => {
        scanPending = false;
        decorate(doc);
      }, 0);
    };
    const showStatus = (button, text) => {
      button.textContent = text;
      later(() => {
        if (button.isConnected === false) return;
        button.textContent = '⚡ Activate';
        button.disabled = false;
        button.classList?.remove(PROCESSING_CLASS);
      }, 1_200);
    };
    const onClick = (event) => {
      const button = event.target?.closest?.(`.${BUTTON_CLASS}`);
      if (!button || activationRunning || stopped) return;
      const row = button.closest?.(SELECTORS.row);
      if (!row || !button.closest?.(SELECTORS.targets)) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      activationRunning = true;
      button.disabled = true;
      button.classList?.add(PROCESSING_CLASS);
      button.textContent = '⏳ Activating…';
      try {
        const saved = activateExclusiveGroup(doc, win, row);
        showStatus(button, saved ? '✅ Active' : '⚠️ No Save');
        if (saved) log?.(`Activated an Auto Farm target group; saved ${saved} target(s).`);
      } catch (error) {
        warn?.('Auto Farm target activation failed.', error);
        showStatus(button, '❌ Error');
      } finally {
        later(() => { activationRunning = false; }, 300);
      }
    };
    const cleanup = (event) => {
      if (event?.persisted) return;
      stopped = true;
      doc.removeEventListener?.('click', onClick, true);
      observer?.disconnect?.();
      for (const timer of timers) win.clearTimeout?.(timer);
      timers.clear();
      win[LOADED_FLAG] = false;
    };

    decorate(doc);
    doc.addEventListener?.('click', onClick, true);
    const Observer = win.MutationObserver || globalThis.MutationObserver;
    if (typeof Observer === 'function' && doc.documentElement) {
      observer = new Observer(scheduleDecorate);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }
    win.addEventListener?.('pagehide', cleanup);
  },
});
