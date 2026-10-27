// ==UserScript==
// @name         Veyra - Auto Farm Activate Buttons
// @namespace    local.veyra.auto-farm-activate-buttons
// @version      1.0.0
// @description  Adds an exclusive Activate button to each grouped Auto-Farm target.
// @match        https://demonicscans.org/active_wave.php*
// @match        https://www.demonicscans.org/active_wave.php*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const SELECTORS = Object.freeze({
    targets: '.af-targets',
    groupRow: '.af-group-row',
    enabled: '.grp-enabled',
    actions: '.btn-group-actions',
    save: '.grp-save',
    delete: '.grp-del-all',
  });

  const UI = Object.freeze({
    buttonClass: 'af-exclusive-activate-btn',
    processingClass: 'af-exclusive-processing',
    styleId: 'af-exclusive-activate-style',
  });

  const runtime = {
    observer: null,
    activationRunning: false,
    scanScheduled: false,
    scanHandle: null,
    scanUsesAnimationFrame: false,
    timers: new Set(),
    stopped: false,
  };

  function getGroupRows() {
    return Array.from(
      document.querySelectorAll?.(`${SELECTORS.targets} ${SELECTORS.groupRow}`) || [],
    );
  }

  function setEnabled(select, value) {
    if (!select || String(select.value) === value) return false;

    select.value = value;
    const EventConstructor = window.Event || globalThis.Event;

    if (typeof select.dispatchEvent === 'function' && typeof EventConstructor === 'function') {
      select.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    }

    return true;
  }

  function saveRows(rows) {
    // Collect every button before the first click. The native Save handler can
    // synchronously rebuild the target list and detach the remaining rows.
    const saveButtons = rows
      .map((row) => row.querySelector?.(SELECTORS.save))
      .filter((button) => typeof button?.click === 'function');

    for (const saveButton of saveButtons) {
      saveButton.click();
    }

    return saveButtons.length;
  }

  function activateExclusiveGroup(targetRow) {
    const rows = getGroupRows();
    if (!targetRow || !rows.includes(targetRow)) return 0;
    if (!targetRow.querySelector?.(SELECTORS.enabled)) return 0;

    const changedRows = [];

    for (const row of rows) {
      const enabled = row.querySelector?.(SELECTORS.enabled);
      const desiredValue = row === targetRow ? '1' : '0';

      if (setEnabled(enabled, desiredValue)) changedRows.push(row);
    }

    // Saving the selected row even when it was already the only active target
    // keeps this action equivalent to an explicit activation by the user.
    if (!changedRows.includes(targetRow)) changedRows.push(targetRow);

    return saveRows(changedRows);
  }

  function getTargetName(row) {
    const names = row?.querySelector?.('.af-group-names');
    return String(names?.getAttribute?.('title') || names?.textContent || 'Target').trim();
  }

  function scheduleTimer(callback, delay) {
    const timer = window.setTimeout(() => {
      runtime.timers.delete(timer);
      if (!runtime.stopped) callback();
    }, delay);
    runtime.timers.add(timer);
    return timer;
  }

  function showStatus(button, text) {
    if (!button || button.isConnected === false) return;

    button.textContent = text;
    scheduleTimer(() => {
      if (button.isConnected === false) return;

      button.textContent = '⚡ Activate';
      button.disabled = false;
      button.classList?.remove(UI.processingClass);
    }, 1_200);
  }

  function handleActivateClick(event) {
    const button = event.target?.closest?.(`.${UI.buttonClass}`);
    if (!button || runtime.activationRunning || runtime.stopped) return;

    const container = button.closest?.(SELECTORS.targets);
    const row = button.closest?.(SELECTORS.groupRow);
    if (!container || !row || !getGroupRows().includes(row)) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    runtime.activationRunning = true;
    button.disabled = true;
    button.classList?.add(UI.processingClass);
    button.textContent = '⏳ Activating…';

    const targetName = getTargetName(row);

    try {
      const saveCount = activateExclusiveGroup(row);

      if (saveCount > 0) {
        console.info(
          `[AF Exclusive Activate] "${targetName}" activated; ${saveCount} target(s) saved.`,
        );
        showStatus(button, '✅ Active');
      } else {
        console.warn('[AF Exclusive Activate] No matching target or Save button was found.');
        showStatus(button, '⚠️ No Save');
      }
    } catch (error) {
      console.error('[AF Exclusive Activate] Activation failed:', error);
      showStatus(button, '❌ Error');
    } finally {
      scheduleTimer(() => {
        runtime.activationRunning = false;
      }, 300);
    }
  }

  function injectStyles() {
    if (document.getElementById?.(UI.styleId)) return;
    if (!document.head || typeof document.createElement !== 'function') return;

    const style = document.createElement('style');
    style.id = UI.styleId;
    style.textContent = `
      .${UI.buttonClass} {
        border-color: #5dce8a !important;
        background: rgba(44, 160, 90, 0.16) !important;
        color: #bfffd5 !important;
        white-space: nowrap;
      }

      .${UI.buttonClass}:hover:not(:disabled) {
        background: rgba(44, 160, 90, 0.3) !important;
        box-shadow: 0 0 10px rgba(93, 206, 138, 0.25);
      }

      .${UI.buttonClass}:disabled,
      .${UI.buttonClass}.${UI.processingClass} {
        cursor: progress;
        opacity: 0.75;
      }
    `;
    document.head.appendChild(style);
  }

  function decorateGroupRows() {
    if (runtime.stopped) return;

    const rows = getGroupRows();
    if (rows.length === 0) return;

    injectStyles();

    for (const row of rows) {
      if (row.querySelector?.(`.${UI.buttonClass}`)) continue;

      const actions = row.querySelector?.(SELECTORS.actions);
      const enabled = row.querySelector?.(SELECTORS.enabled);
      const saveButton = row.querySelector?.(SELECTORS.save);
      if (!actions || !enabled || !saveButton || typeof document.createElement !== 'function') {
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${UI.buttonClass}`;
      button.textContent = '⚡ Activate';
      button.title = 'Dieses Target aktivieren und alle anderen deaktivieren';

      const deleteButton = actions.querySelector?.(SELECTORS.delete);
      if (deleteButton && typeof actions.insertBefore === 'function') {
        actions.insertBefore(button, deleteButton);
      } else {
        actions.appendChild?.(button);
      }
    }
  }

  function scheduleDecoration() {
    if (runtime.stopped || runtime.scanScheduled) return;

    runtime.scanScheduled = true;
    const run = () => {
      runtime.scanScheduled = false;
      runtime.scanHandle = null;
      decorateGroupRows();
    };

    if (typeof window.requestAnimationFrame === 'function') {
      runtime.scanUsesAnimationFrame = true;
      runtime.scanHandle = window.requestAnimationFrame(run);
    } else {
      runtime.scanUsesAnimationFrame = false;
      runtime.scanHandle = window.setTimeout(run, 0);
    }
  }

  function cancelDecoration() {
    if (!runtime.scanScheduled) return;

    if (runtime.scanUsesAnimationFrame) {
      window.cancelAnimationFrame?.(runtime.scanHandle);
    } else {
      window.clearTimeout(runtime.scanHandle);
    }

    runtime.scanScheduled = false;
    runtime.scanHandle = null;
  }

  function cleanup(event) {
    if (event?.persisted) return;

    runtime.stopped = true;
    document.removeEventListener?.('click', handleActivateClick, true);
    runtime.observer?.disconnect();
    cancelDecoration();

    for (const timer of runtime.timers) window.clearTimeout(timer);
    runtime.timers.clear();
  }

  decorateGroupRows();
  document.addEventListener?.('click', handleActivateClick, true);

  runtime.observer = new MutationObserver(scheduleDecoration);
  runtime.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener?.('pagehide', cleanup);
})();
