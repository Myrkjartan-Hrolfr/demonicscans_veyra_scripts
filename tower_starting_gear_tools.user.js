// ==UserScript==
// @name         Demonic Tower Starting Gear Tools
// @namespace    local.demonicscans.tower
// @version      1.0.1
// @description  Filters persistent Tower gear and starts the matching Merchant passive reroll from each gear card.
// @author       Myrkjartan Hrolfr
// @match        https://demonicscans.org/occurrence_castle.php?slug=black_crown_tower
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_ID = 'tm-tower-starting-gear-tools';
  const FILTERS_VERSION = 1;
  const REROLL_TIMEOUT_MS = 20_000;
  const NATIVE_ACCEPT_TIMEOUT_MS = 3_000;

  const SELECTORS = Object.freeze({
    loadout: '#te-modal-loadout #loadout, section#loadout',
    cards: ':scope > .te-cards > article.te-panel.te-item',
    merchantForms: '#merchant article.te-shop form.te-form[data-action="shop_buy"]',
  });

  const RARITY_ORDER = Object.freeze([
    'common',
    'uncommon',
    'rare',
    'epic',
    'legendary',
    'mythic',
  ]);

  const DEFAULT_FILTERS = Object.freeze({
    rarity: 'all',
    query: '',
  });

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSearchText(value) {
    return normalizeText(value).toLowerCase();
  }

  function sanitizeFilters(value) {
    const source = value && typeof value === 'object' ? value : {};
    const rarity = normalizeSearchText(source.rarity);

    return {
      rarity: rarity === 'all' || RARITY_ORDER.includes(rarity) ? rarity : DEFAULT_FILTERS.rarity,
      query: normalizeText(source.query),
    };
  }

  function gearMatchesFilters(gear, filters) {
    const safeFilters = sanitizeFilters(filters);

    if (safeFilters.rarity !== 'all' && gear.rarity !== safeFilters.rarity) {
      return false;
    }

    const terms = normalizeSearchText(safeFilters.query).split(' ').filter(Boolean);
    return terms.every((term) => gear.searchText.includes(term));
  }

  function getRerollRarity(title, rarityLabel = '') {
    const titleMatch = normalizeText(title).match(/^(epic|legendary) equipment passive reroll$/i);

    if (!titleMatch) {
      return '';
    }

    const titleRarity = titleMatch[1].toLowerCase();
    const cardRarity = normalizeSearchText(rarityLabel).split(' / ')[0];

    return !cardRarity || cardRarity === titleRarity ? titleRarity : '';
  }

  const testExports = Object.freeze({
    findRerollOffer,
    gearMatchesFilters,
    getRerollRarity,
    normalizeSearchText,
    normalizeText,
    parseNativePendingValue,
    revisionAdvanced,
    sanitizeFilters,
  });

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) {
      module.exports = testExports;
    }
    return;
  }

  if (!document.body) {
    return;
  }

  if (
    !document.body.matches('[data-tower-user][data-tower-occ]') &&
    !document.querySelector('#te-modal-loadout, section#loadout, section#merchant')
  ) {
    return;
  }

  const storageKey = `${SCRIPT_ID}:filters:v${FILTERS_VERSION}:${document.body.dataset.towerUser || 'default'}`;
  const state = {
    filters: loadFilters(),
    observer: null,
    scanFrame: 0,
    monitorTimer: 0,
    transaction: null,
    status: '',
    statusTone: 'neutral',
  };

  function loadFilters() {
    try {
      const saved = localStorage.getItem(storageKey);
      return sanitizeFilters(saved === null ? DEFAULT_FILTERS : JSON.parse(saved));
    } catch {
      return { ...DEFAULT_FILTERS };
    }
  }

  function saveFilters() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state.filters));
    } catch {
      // Filtering still works for the current page when storage is unavailable.
    }
  }

  function injectStyles() {
    if (document.getElementById(`${SCRIPT_ID}-style`)) {
      return;
    }

    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      .${SCRIPT_ID}-toolbar {
        display: grid;
        grid-template-columns: minmax(130px, 0.55fr) minmax(190px, 1fr) auto;
        gap: 10px;
        align-items: end;
        margin: 14px 0;
        padding: 12px;
        border: 1px solid rgba(201, 182, 237, 0.38);
        border-color: color-mix(in srgb, var(--ember, #c9b6ed) 38%, transparent);
        border-radius: 10px;
        background: #211d2c;
        background: color-mix(in srgb, var(--panel, #211d2c) 88%, transparent);
      }

      .${SCRIPT_ID}-field {
        display: grid;
        gap: 5px;
        min-width: 0;
        color: var(--muted, #b9b5c7);
        font-size: 12px;
        font-weight: 700;
      }

      .${SCRIPT_ID}-field select,
      .${SCRIPT_ID}-field input {
        box-sizing: border-box;
        width: 100%;
        min-height: 38px;
        padding: 8px 10px;
        border: 1px solid rgba(201, 182, 237, 0.45);
        border-color: color-mix(in srgb, var(--ember, #c9b6ed) 45%, transparent);
        border-radius: 7px;
        color: var(--text, #f3effa);
        background: var(--panel-strong, #181520);
        font: inherit;
      }

      .${SCRIPT_ID}-reset {
        min-height: 38px;
        white-space: nowrap;
      }

      .${SCRIPT_ID}-summary,
      .${SCRIPT_ID}-status {
        grid-column: 1 / -1;
        margin: 0;
        color: var(--muted, #b9b5c7);
        font-size: 12px;
        line-height: 1.45;
      }

      .${SCRIPT_ID}-status[data-tone='success'] { color: #9ed294; }
      .${SCRIPT_ID}-status[data-tone='warning'] { color: #e9b66f; }
      .${SCRIPT_ID}-status[data-tone='error'] { color: #e28074; }
      .${SCRIPT_ID}-filtered-out { display: none !important; }

      .${SCRIPT_ID}-actions {
        display: grid;
        gap: 5px;
        margin-top: 9px;
      }

      .${SCRIPT_ID}-reroll {
        width: 100%;
      }

      .${SCRIPT_ID}-reroll:disabled {
        cursor: not-allowed;
        opacity: 0.58;
      }

      .${SCRIPT_ID}-hint {
        color: var(--muted, #aaa6b8);
        font-size: 11px;
        line-height: 1.35;
        text-align: center;
      }

      @media (max-width: 680px) {
        .${SCRIPT_ID}-toolbar { grid-template-columns: 1fr; }
        .${SCRIPT_ID}-summary,
        .${SCRIPT_ID}-status { grid-column: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  function readGear(card) {
    const selectForm = card.querySelector('form.te-form[data-action="select_gear"]');
    const equipmentId = normalizeText(selectForm?.querySelector('input[name="equipment"]')?.value);
    const name = normalizeText(card.querySelector(':scope > h3')?.textContent);
    const rarityElement = card.querySelector(':scope > .te-rarity');
    const rarityAndSlot = normalizeSearchText(rarityElement?.textContent).split('/');
    const rarity = normalizeText(rarityAndSlot[0]);
    const slot = normalizeText(rarityAndSlot.slice(1).join(' '));
    const details = [...card.children]
      .filter((element) => element.tagName === 'P' && !element.classList.contains('te-accent'))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean)
      .join(' ');

    return {
      card,
      equipmentId,
      name,
      rarity,
      slot,
      searchText: normalizeSearchText(`${rarity} ${slot} ${name} ${details}`),
    };
  }

  function getRerollOffers() {
    const offers = [];

    document.querySelectorAll(SELECTORS.merchantForms).forEach((form) => {
      const article = form.closest('article.te-shop');
      const title = normalizeText(article?.querySelector(':scope > h3')?.textContent);
      const rarityLabel = normalizeText(article?.querySelector('.te-rarity')?.textContent);
      const rarity = getRerollRarity(title, rarityLabel);
      const select = form.querySelector('select[name="equipment"][required], select[name="equipment"]');
      const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');

      if (!article || !rarity || !select || !submitter) {
        return;
      }

      offers.push({
        article,
        form,
        offerValue: normalizeText(form.querySelector('input[name="offer"]')?.value),
        price: normalizeText(article.querySelector('.te-price')?.textContent),
        rarity,
        select,
        submitter,
      });
    });

    return offers;
  }

  function findRerollOffer(gear, offers = getRerollOffers()) {
    if (!gear.equipmentId || !gear.name) {
      return null;
    }

    const matches = offers.filter(
      (offer) =>
        rerollOfferContainsGear(offer, gear) &&
        !offer.select.disabled &&
        !offer.submitter.disabled,
    );

    return matches.length === 1 ? matches[0] : null;
  }

  function rerollOfferContainsGear(offer, gear) {
    if (offer.rarity !== gear.rarity) {
      return false;
    }

    const option = [...offer.select.options].find(
      (candidate) =>
        candidate.value === gear.equipmentId &&
        normalizeSearchText(candidate.textContent) === normalizeSearchText(gear.name),
    );

    return !!option && !option.disabled;
  }

  function ensureToolbar(section) {
    let toolbar = section.querySelector(`:scope > .${SCRIPT_ID}-toolbar`);

    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.className = `${SCRIPT_ID}-toolbar`;
      toolbar.setAttribute('role', 'group');
      toolbar.setAttribute('aria-label', 'Starting Gear Filter');
      toolbar.innerHTML = `
        <label class="${SCRIPT_ID}-field">
          <span>Seltenheit</span>
          <select data-filter="rarity" aria-label="Starting Gear nach Seltenheit filtern"></select>
        </label>
        <label class="${SCRIPT_ID}-field">
          <span>Suche</span>
          <input data-filter="query" type="search" placeholder="z. B. Abysscaller oder Mana Drink" autocomplete="off">
        </label>
        <button class="te-button ${SCRIPT_ID}-reset" type="button" data-gear-tools-reset>Filter zurücksetzen</button>
        <p class="${SCRIPT_ID}-summary" aria-live="polite"></p>
        <p class="${SCRIPT_ID}-status" role="status" aria-live="polite" hidden></p>
      `;

      const cards = section.querySelector(':scope > .te-cards');
      section.insertBefore(toolbar, cards || null);
    }

    syncToolbar(toolbar, section);
    return toolbar;
  }

  function syncToolbar(toolbar, section) {
    const cards = [...section.querySelectorAll(SELECTORS.cards)];
    const availableRarities = new Set(cards.map((card) => readGear(card).rarity).filter(Boolean));
    const raritySelect = toolbar.querySelector('[data-filter="rarity"]');
    const optionValues = [
      'all',
      ...RARITY_ORDER.filter(
        (rarity) => availableRarities.has(rarity) || state.filters.rarity === rarity,
      ),
    ];
    const signature = optionValues.join('|');

    if (raritySelect.dataset.options !== signature) {
      raritySelect.replaceChildren(
        ...optionValues.map((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value === 'all' ? 'Alle' : value[0].toUpperCase() + value.slice(1);
          return option;
        }),
      );
      raritySelect.dataset.options = signature;
    }

    if (raritySelect.value !== state.filters.rarity) {
      raritySelect.value = state.filters.rarity;
    }

    const queryInput = toolbar.querySelector('[data-filter="query"]');
    if (document.activeElement !== queryInput && queryInput.value !== state.filters.query) {
      queryInput.value = state.filters.query;
    }

    const status = toolbar.querySelector(`.${SCRIPT_ID}-status`);
    const shouldHideStatus = !state.status;
    if (status.textContent !== state.status) {
      status.textContent = state.status;
    }
    if (status.hidden !== shouldHideStatus) {
      status.hidden = shouldHideStatus;
    }
    status.dataset.tone = state.statusTone;
  }

  function ensureRerollButton(gear, offers) {
    let actions = gear.card.querySelector(`:scope > .${SCRIPT_ID}-actions`);

    if (!actions) {
      actions = document.createElement('div');
      actions.className = `${SCRIPT_ID}-actions`;
      actions.innerHTML = `
        <button class="te-button ${SCRIPT_ID}-reroll" type="button" data-gear-reroll></button>
        <span class="${SCRIPT_ID}-hint"></span>
      `;

      const selectForm = gear.card.querySelector('form.te-form[data-action="select_gear"]');
      if (selectForm) {
        selectForm.insertAdjacentElement('afterend', actions);
      } else {
        gear.card.appendChild(actions);
      }
    }

    const button = actions.querySelector('[data-gear-reroll]');
    const hint = actions.querySelector(`.${SCRIPT_ID}-hint`);
    const offer = findRerollOffer(gear, offers);
    const listedOffers = offers.filter((candidate) => rerollOfferContainsGear(candidate, gear));
    const merchantDisabled =
      listedOffers.length === 1 &&
      (listedOffers[0].select.disabled || listedOffers[0].submitter.disabled);
    const rerollableRarity = gear.rarity === 'epic' || gear.rarity === 'legendary';
    let label;
    let hintText;

    button.dataset.equipmentId = gear.equipmentId;

    if (state.transaction) {
      label = state.transaction.equipmentId === gear.equipmentId ? 'Reroll läuft …' : 'Reroll gesperrt';
      hintText = 'Es kann nur ein Reroll gleichzeitig ausgeführt werden.';
      button.disabled = true;
    } else if (offer) {
      label = gear.rarity === 'legendary' ? 'Passives rerollen' : 'Passive rerollen';
      hintText = offer.price ? `Merchant-Preis: ${offer.price}` : 'Merchant-Reroll verfügbar';
      button.disabled = false;
    } else if (!rerollableRarity) {
      label = 'Kein Reroll verfügbar';
      hintText = `Der Merchant bietet keinen ${gear.rarity || 'passenden'} Reroll an.`;
      button.disabled = true;
    } else if (merchantDisabled) {
      label = 'Reroll derzeit gesperrt';
      hintText = 'Der zugehörige Merchant-Button ist momentan deaktiviert.';
      button.disabled = true;
    } else if (offers.length === 0) {
      label = 'Merchant nicht geladen';
      hintText = 'Öffne den Merchant einmal, damit sein aktuelles Reroll-Formular geladen wird.';
      button.disabled = true;
    } else {
      label = 'Nicht beim Merchant gelistet';
      hintText = 'Für dieses Equipment wurde kein eindeutiges aktuelles Reroll-Ziel gefunden.';
      button.disabled = true;
    }

    if (button.textContent !== label) {
      button.textContent = label;
    }
    if (hint.textContent !== hintText) {
      hint.textContent = hintText;
    }
  }

  function enhanceLoadout(section) {
    const toolbar = ensureToolbar(section);
    const offers = getRerollOffers();
    const gears = [...section.querySelectorAll(SELECTORS.cards)].map(readGear);
    let visibleCount = 0;

    gears.forEach((gear) => {
      const visible = gearMatchesFilters(gear, state.filters);
      gear.card.classList.toggle(`${SCRIPT_ID}-filtered-out`, !visible);
      gear.card.setAttribute('aria-hidden', String(!visible));
      visibleCount += Number(visible);
      ensureRerollButton(gear, offers);
    });

    const summary = toolbar.querySelector(`.${SCRIPT_ID}-summary`);
    const summaryText = `${visibleCount} von ${gears.length} Ausrüstungsteilen angezeigt`;
    if (summary.textContent !== summaryText) {
      summary.textContent = summaryText;
    }
  }

  function scanPage() {
    state.scanFrame = 0;
    injectStyles();
    document.querySelectorAll(SELECTORS.loadout).forEach(enhanceLoadout);
    checkTransaction();
  }

  function scheduleScan() {
    if (state.scanFrame) {
      return;
    }

    state.scanFrame = window.requestAnimationFrame(scanPage);
  }

  function setStatus(message, tone = 'neutral') {
    state.status = normalizeText(message);
    state.statusTone = tone;

    document.querySelectorAll(`.${SCRIPT_ID}-status`).forEach((status) => {
      const shouldHideStatus = !state.status;
      if (status.textContent !== state.status) {
        status.textContent = state.status;
      }
      if (status.hidden !== shouldHideStatus) {
        status.hidden = shouldHideStatus;
      }
      status.dataset.tone = tone;
    });
  }

  function getNativePendingKey() {
    const user = document.body.dataset.towerUser;
    const occurrence = document.body.dataset.towerOcc;
    return user && occurrence ? `tower:${user}:${occurrence}:pending` : '';
  }

  function readNativePending() {
    const key = getNativePendingKey();

    if (!key) {
      return null;
    }

    try {
      return parseNativePendingValue(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function parseNativePendingValue(value) {
    if (value === null) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function nativeRequestIsBusy() {
    return (
      document.getElementById('te-message')?.getAttribute('aria-busy') === 'true' ||
      readNativePending() !== null
    );
  }

  function getRevisionSnapshot() {
    const values = [...document.querySelectorAll('form.te-form input[name="revision"]')]
      .map((input) => normalizeText(input.value))
      .filter(Boolean);
    const numericValues = values.map(Number).filter(Number.isFinite);

    return {
      numericMaximum: numericValues.length ? Math.max(...numericValues) : null,
      values: new Set(values),
    };
  }

  function revisionAdvanced(before, after) {
    if (before.numericMaximum !== null && after.numericMaximum !== null) {
      return after.numericMaximum > before.numericMaximum;
    }

    return [...after.values].some((value) => !before.values.has(value));
  }

  function requestIdStillExists(requestId) {
    return [...document.querySelectorAll('form.te-form input[name="request_id"]')].some(
      (input) => input.value === requestId,
    );
  }

  function findTransactionFormError(transaction) {
    const forms = new Set();

    if (transaction.form?.isConnected) {
      forms.add(transaction.form);
    }

    getRerollOffers()
      .filter(
        (offer) =>
          offer.rarity === transaction.rarity &&
          (!transaction.offerValue || offer.offerValue === transaction.offerValue),
      )
      .forEach((offer) => forms.add(offer.form));

    return [...forms]
      .flatMap((form) => [...form.querySelectorAll('.te-form-error:not([hidden])')])
      .map((element) => normalizeText(element.textContent))
      .find(Boolean);
  }

  function clearTransaction(message, tone) {
    window.clearTimeout(state.monitorTimer);
    state.monitorTimer = 0;
    state.transaction = null;
    setStatus(message, tone);
    scheduleScan();
  }

  function scheduleTransactionCheck(delay = 120) {
    window.clearTimeout(state.monitorTimer);
    state.monitorTimer = window.setTimeout(checkTransaction, delay);
  }

  function checkTransaction() {
    const transaction = state.transaction;

    if (!transaction) {
      return;
    }

    const busy = nativeRequestIsBusy();
    transaction.seenBusy = transaction.seenBusy || busy;

    const currentRevisions = getRevisionSnapshot();
    const advanced = revisionAdvanced(transaction.revisions, currentRevisions);
    const oldRequestGone = !requestIdStillExists(transaction.requestId);
    const settled = !busy;

    if (advanced || oldRequestGone) {
      transaction.seenDomChange = true;
    }

    const errorText =
      settled && (transaction.seenBusy || transaction.seenDomChange)
        ? findTransactionFormError(transaction)
        : '';
    if (errorText) {
      clearTransaction(`Reroll fehlgeschlagen: ${errorText}`, 'error');
      return;
    }

    if (advanced && oldRequestGone && settled) {
      setStatus(`Reroll für ${transaction.itemName} abgeschlossen. Seite wird aktualisiert …`, 'success');
      window.clearTimeout(state.monitorTimer);
      state.monitorTimer = window.setTimeout(() => window.location.reload(), 180);
      return;
    }

    const elapsed = Date.now() - transaction.startedAt;

    if (elapsed >= REROLL_TIMEOUT_MS) {
      clearTransaction(
        'Der Reroll konnte nicht eindeutig bestätigt werden. Es wurde kein automatischer Reload ausgeführt.',
        'error',
      );
      return;
    }

    if (
      elapsed >= NATIVE_ACCEPT_TIMEOUT_MS &&
      !transaction.seenBusy &&
      !transaction.seenDomChange
    ) {
      clearTransaction(
        'Der native Merchant-Handler hat den Reroll nicht angenommen. Bitte Merchant und Starting Gear neu öffnen.',
        'error',
      );
      return;
    }

    scheduleTransactionCheck();
  }

  function dispatchSelectEvents(select) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function startReroll(button) {
    if (state.transaction) {
      setStatus('Ein Reroll wird bereits verarbeitet.', 'warning');
      return;
    }

    if (nativeRequestIsBusy()) {
      setStatus('Die Tower-Seite verarbeitet bereits eine andere Aktion. Bitte kurz warten.', 'warning');
      return;
    }

    const card = button.closest('article.te-item');
    const gear = card ? readGear(card) : null;
    const offer = gear ? findRerollOffer(gear) : null;

    if (!gear?.equipmentId || !offer) {
      setStatus('Für dieses Equipment wurde kein eindeutiger aktueller Merchant-Reroll gefunden.', 'error');
      scheduleScan();
      return;
    }

    const previousValue = offer.select.value;
    offer.select.value = gear.equipmentId;
    dispatchSelectEvents(offer.select);

    if (offer.select.value !== gear.equipmentId || !offer.form.reportValidity()) {
      offer.select.value = previousValue;
      dispatchSelectEvents(offer.select);
      setStatus('Das Equipment konnte im Merchant-Formular nicht sicher ausgewählt werden.', 'error');
      return;
    }

    const nativeConfirmation = normalizeText(offer.form.getAttribute('data-confirm'));
    const confirmation = nativeConfirmation
      ? `${nativeConfirmation}\n\nZiel: ${gear.name}`
      : `${gear.name} wirklich beim Merchant rerollen${offer.price ? ` (${offer.price})` : ''}?`;

    if (!window.confirm(confirmation)) {
      offer.select.value = previousValue;
      dispatchSelectEvents(offer.select);
      setStatus('Reroll abgebrochen.', 'neutral');
      return;
    }

    const requestId = normalizeText(offer.form.querySelector('input[name="request_id"]')?.value);
    if (!requestId) {
      offer.select.value = previousValue;
      dispatchSelectEvents(offer.select);
      setStatus('Dem Merchant-Formular fehlt eine aktuelle Request-ID. Bitte Seite neu laden.', 'error');
      return;
    }

    state.transaction = {
      equipmentId: gear.equipmentId,
      form: offer.form,
      itemName: gear.name,
      offerValue: offer.offerValue,
      rarity: offer.rarity,
      requestId,
      revisions: getRevisionSnapshot(),
      startedAt: Date.now(),
      seenBusy: false,
      seenDomChange: false,
    };
    setStatus(`Reroll für ${gear.name} wird beim Merchant ausgeführt …`, 'warning');
    scheduleScan();

    const confirmationAttribute = offer.form.getAttribute('data-confirm');
    if (confirmationAttribute !== null) {
      offer.form.removeAttribute('data-confirm');
    }

    const restoreConfirmation = () => {
      if (
        confirmationAttribute !== null &&
        offer.form.isConnected &&
        !offer.form.hasAttribute('data-confirm')
      ) {
        offer.form.setAttribute('data-confirm', confirmationAttribute);
      }
    };

    try {
      if (typeof offer.form.requestSubmit === 'function') {
        offer.form.requestSubmit(offer.submitter);
      } else {
        offer.submitter.click();
      }
    } catch (error) {
      restoreConfirmation();
      if (offer.select.isConnected) {
        offer.select.value = previousValue;
        dispatchSelectEvents(offer.select);
      }
      console.error('[Demonic Tower Starting Gear Tools] Could not submit reroll.', error);
      clearTransaction('Der Merchant-Reroll konnte nicht abgesendet werden.', 'error');
      return;
    }

    window.queueMicrotask(restoreConfirmation);
    scheduleTransactionCheck();
  }

  document.addEventListener('input', (event) => {
    const control = event.target.closest?.(`.${SCRIPT_ID}-toolbar [data-filter]`);
    if (!control) {
      return;
    }

    state.filters = sanitizeFilters({
      ...state.filters,
      [control.dataset.filter]: control.value,
    });
    saveFilters();
    scheduleScan();
  });

  document.addEventListener('change', (event) => {
    const control = event.target.closest?.(`.${SCRIPT_ID}-toolbar [data-filter]`);
    if (!control) {
      return;
    }

    state.filters = sanitizeFilters({
      ...state.filters,
      [control.dataset.filter]: control.value,
    });
    saveFilters();
    scheduleScan();
  });

  document.addEventListener('click', (event) => {
    const resetButton = event.target.closest?.('[data-gear-tools-reset]');
    if (resetButton) {
      state.filters = { ...DEFAULT_FILTERS };
      saveFilters();
      scheduleScan();
      return;
    }

    const rerollButton = event.target.closest?.('[data-gear-reroll]');
    if (rerollButton && !rerollButton.disabled) {
      startReroll(rerollButton);
    }
  });

  state.observer = new MutationObserver(scheduleScan);
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'hidden', 'open'],
  });

  window.addEventListener('pagehide', () => {
    state.observer?.disconnect();
    window.cancelAnimationFrame(state.scanFrame);
    window.clearTimeout(state.monitorTimer);
  });

  scheduleScan();
})();
