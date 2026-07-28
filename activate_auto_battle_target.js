// ==UserScript==
// @name         AF Targets – Exclusive Activate Button
// @namespace    af-target-exclusive-activate
// @version      1.0.0
// @description  Fügt jedem Target einen Button hinzu, der nur dieses Target aktiviert.
// @match        https://demonicscans.org/active_wave.php*
// @grant        none
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SELECTORS = {
    targetsContainer: '.af-targets',

    // Gruppierte Ansicht
    groupRow: '.af-group-row',
    groupEnabled: '.grp-enabled',
    groupActions: '.btn-group-actions',
    groupSave: '.grp-save',
    groupDelete: '.grp-del-all',

    // Normale Detailansicht
    detailRow: '.af-row[data-target-id]',
    detailEnabled: '.afTEnabled',
  };

  const BUTTON_CLASS = 'af-exclusive-activate-btn';
  const PROCESSING_CLASS = 'af-exclusive-processing';

  let scanScheduled = false;
  let activationRunning = false;

  /**
   * Löst Events aus, damit die Seite die Änderung genauso behandelt,
   * als wäre das Select manuell verändert worden.
   */
  function setSelectValue(select, value) {
    if (!select || select.value === value) {
      return false;
    }

    select.value = value;

    select.dispatchEvent(
      new Event('input', {
        bubbles: true,
      }),
    );

    select.dispatchEvent(
      new Event('change', {
        bubbles: true,
      }),
    );

    return true;
  }

  /**
   * Ermittelt den Namen eines Targets für Statusmeldungen.
   */
  function getTargetName(row) {
    const groupedName = row.querySelector('.af-group-names');
    if (groupedName) {
      return (groupedName.getAttribute('title') || groupedName.textContent || 'Target').trim();
    }

    const monsterSelect = row.querySelector('.afTMonster');
    if (monsterSelect) {
      return monsterSelect.selectedOptions[0]?.textContent.trim() || 'Target';
    }

    return 'Target';
  }

  /**
   * Findet in einer Detailzeile den vorhandenen Save-Button.
   */
  function findDetailSaveButton(row) {
    return Array.from(row.querySelectorAll('button')).find((button) => {
      const onclick = button.getAttribute('onclick') || '';

      return (
        onclick.includes('afUpdateTarget') || button.textContent.includes('Save') || button.textContent.includes('💾')
      );
    });
  }

  /**
   * Speichert alle geänderten Zeilen.
   *
   * Die Klicks werden bewusst direkt nacheinander ausgelöst.
   * So können alle Save-Handler starten, bevor die Seite ihre Ansicht
   * eventuell neu rendert.
   */
  function saveRows(rows, viewType) {
    const saveButtons = [];

    for (const row of rows) {
      const saveButton = viewType === 'group' ? row.querySelector(SELECTORS.groupSave) : findDetailSaveButton(row);

      if (saveButton) {
        saveButtons.push(saveButton);
      }
    }

    for (const saveButton of saveButtons) {
      saveButton.click();
    }

    return saveButtons.length;
  }

  /**
   * Aktiviert exklusiv eine Zeile in der gruppierten Ansicht.
   */
  function activateGroupedTarget(targetRow) {
    const rows = Array.from(document.querySelectorAll(`${SELECTORS.targetsContainer} ${SELECTORS.groupRow}`));

    const changedRows = [];

    for (const row of rows) {
      const enabledSelect = row.querySelector(SELECTORS.groupEnabled);
      const desiredValue = row === targetRow ? '1' : '0';

      if (setSelectValue(enabledSelect, desiredValue)) {
        changedRows.push(row);
      }
    }

    /*
     * Wenn bereits nur dieses Ziel aktiv war, speichern wir es trotzdem.
     * Dadurch verhält sich der Button immer wie eine bewusste Aktivierung.
     */
    if (!changedRows.includes(targetRow)) {
      changedRows.push(targetRow);
    }

    return saveRows(changedRows, 'group');
  }

  /**
   * Aktiviert exklusiv eine Zeile in der normalen Detailansicht.
   */
  function activateDetailTarget(targetRow) {
    const rows = Array.from(document.querySelectorAll(`${SELECTORS.targetsContainer} ${SELECTORS.detailRow}`));

    const changedRows = [];

    for (const row of rows) {
      const enabledSelect = row.querySelector(SELECTORS.detailEnabled);
      const desiredValue = row === targetRow ? '1' : '0';

      if (setSelectValue(enabledSelect, desiredValue)) {
        changedRows.push(row);
      }
    }

    if (!changedRows.includes(targetRow)) {
      changedRows.push(targetRow);
    }

    return saveRows(changedRows, 'detail');
  }

  /**
   * Temporärer Status direkt auf dem geklickten Button.
   */
  function showButtonStatus(button, text) {
    if (!button?.isConnected) {
      return;
    }

    button.textContent = text;

    window.setTimeout(() => {
      if (!button.isConnected) {
        return;
      }

      button.textContent = '⚡ Activate';
      button.disabled = false;
      button.classList.remove(PROCESSING_CLASS);
    }, 1200);
  }

  /**
   * Zentraler Click-Handler für dynamisch erzeugte Buttons.
   */
  function handleActivateClick(event) {
    const button = event.target.closest(`.${BUTTON_CLASS}`);

    if (!button || activationRunning) {
      return;
    }

    const row = button.closest(`${SELECTORS.groupRow}, ${SELECTORS.detailRow}`);

    if (!row) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    activationRunning = true;
    button.disabled = true;
    button.classList.add(PROCESSING_CLASS);
    button.textContent = '⏳ Activating…';

    const targetName = getTargetName(row);

    try {
      let saveCount = 0;

      if (row.matches(SELECTORS.groupRow)) {
        saveCount = activateGroupedTarget(row);
      } else {
        saveCount = activateDetailTarget(row);
      }

      if (saveCount > 0) {
        console.info(`[AF Exclusive Activate] "${targetName}" aktiviert. ` + `${saveCount} Target(s) gespeichert.`);

        showButtonStatus(button, '✅ Active');
      } else {
        console.warn('[AF Exclusive Activate] Kein Save-Button gefunden.');

        showButtonStatus(button, '⚠️ No Save');
      }
    } catch (error) {
      console.error('[AF Exclusive Activate] Aktivierung fehlgeschlagen:', error);

      showButtonStatus(button, '❌ Error');
    } finally {
      window.setTimeout(() => {
        activationRunning = false;
      }, 300);
    }
  }

  function createActivateButton(viewType) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = `btn ${BUTTON_CLASS}`;
    button.dataset.afView = viewType;
    button.textContent = '⚡ Activate';
    button.title = 'Dieses Target aktivieren und alle anderen deaktivieren';

    return button;
  }

  /**
   * Ergänzt Buttons in der gruppierten Ansicht.
   */
  function decorateGroupedRows(root = document) {
    const rows = root.matches?.(SELECTORS.groupRow) ? [root] : root.querySelectorAll?.(SELECTORS.groupRow) || [];

    for (const row of rows) {
      if (row.querySelector(`.${BUTTON_CLASS}`)) {
        continue;
      }

      const actions = row.querySelector(SELECTORS.groupActions);

      if (!actions) {
        continue;
      }

      const button = createActivateButton('group');
      const deleteButton = actions.querySelector(SELECTORS.groupDelete);

      // Direkt vor Delete einfügen.
      if (deleteButton) {
        actions.insertBefore(button, deleteButton);
      } else {
        actions.appendChild(button);
      }
    }
  }

  /**
   * Ergänzt Buttons in der normalen Detailansicht.
   */
  function decorateDetailRows(root = document) {
    const rows = root.matches?.(SELECTORS.detailRow) ? [root] : root.querySelectorAll?.(SELECTORS.detailRow) || [];

    for (const row of rows) {
      if (row.querySelector(`.${BUTTON_CLASS}`)) {
        continue;
      }

      const button = createActivateButton('detail');

      const removeButton = Array.from(row.querySelectorAll(':scope > button')).find((candidate) => {
        const onclick = candidate.getAttribute('onclick') || '';

        return (
          onclick.includes('afRemoveTarget') ||
          candidate.textContent.includes('Remove') ||
          candidate.textContent.includes('🗑')
        );
      });

      if (removeButton) {
        row.insertBefore(button, removeButton);
      } else {
        row.appendChild(button);
      }
    }
  }

  function scanForTargets() {
    scanScheduled = false;

    const container = document.querySelector(SELECTORS.targetsContainer);

    if (!container) {
      return;
    }

    decorateGroupedRows(container);
    decorateDetailRows(container);
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    requestAnimationFrame(scanForTargets);
  }

  /**
   * Styles für den neuen Button.
   */
  function injectStyles() {
    if (document.getElementById('af-exclusive-activate-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'af-exclusive-activate-style';
    style.textContent = `
            .${BUTTON_CLASS} {
                border-color: #5dce8a !important;
                background: rgba(44, 160, 90, 0.16) !important;
                color: #bfffd5 !important;
                white-space: nowrap;
            }

            .${BUTTON_CLASS}:hover:not(:disabled) {
                background: rgba(44, 160, 90, 0.3) !important;
                box-shadow: 0 0 10px rgba(93, 206, 138, 0.25);
            }

            .${BUTTON_CLASS}:disabled,
            .${BUTTON_CLASS}.${PROCESSING_CLASS} {
                cursor: progress;
                opacity: 0.75;
            }
        `;

    document.head.appendChild(style);
  }

  injectStyles();
  document.addEventListener('click', handleActivateClick, true);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  scanForTargets();
})();
