// ==UserScript==
// @name         Dungeon Location Farmer - Controlled
// @namespace    http://tampermonkey.net/
// @version      2.0.4
// @description  Farm all alive monsters with attack fallbacks and configurable potion priorities.
// @author       [J4F] RacletteCestLavie / enhanced
// @match        https://demonicscans.org/guild_dungeon_location.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=demonicscans.org
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const ID = 'dlf-controlled';
  const STORE_KEY = `${ID}:settings:v2:${location.host}:${location.pathname}`;
  const RESUME_KEY = `${ID}:resume:v1:${location.host}:${location.pathname}`;

  const MAX_RATE_RETRIES = 8;
  const MAX_FAIL_RETRIES = 3;
  const MAX_LOG_LINES = 300;
  const POTION_CONFIRM_TIMEOUT_MS = 6000;
  const POTION_RESULT_TIMEOUT_MS = 8000;

  const SEL = {
    stamina: '#stamina_span',
    potion: '.potion-use-btn',
    potionCard: '.potion-card',
    playerHp: '#pHpText',
  };

  const SKILLS = {
    slash: { id: '0', name: 'Slash', cost: 1 },
    'power slash': { id: '-1', name: 'Power Slash', cost: 10 },
    'heroic slash': { id: '-2', name: 'Heroic Slash', cost: 50 },
    'ultimate slash': { id: '-3', name: 'Ultimate Slash', cost: 100 },
    'legendary slash': { id: '-4', name: 'Legendary Slash', cost: 200 },
  };

  const DEFAULTS = {
    attackKeys: ['legendary slash', 'ultimate slash', 'slash'],
    attackDelayMs: 100,

    damageMode: 'kill',
    specificDamage: '1000000',

    autoStamina: false,
    staminaReserve: 10,
    staminaFailureAction: 'wait',
    staminaWaitSeconds: 30,
    maxStaminaWaits: 10,

    autoHealth: false,
    healthThreshold: 30,
    healthFailureAction: 'stop',

    potionEnabled: {},
    potionUseAmount: {},
    potionOrder: {
      stamina: [],
      health: [],
    },
  };

  const state = {
    settings: loadSettings(),
    potions: [],
    overlay: null,
    ui: {},
    runState: { stopped: true },
    activeRun: null,
    potionRefreshTimer: null,
    resumePending: false,
    pageIsUnloading: false,
    resumeCleanupTimer: null,
  };

  window.addEventListener('beforeunload', () => {
    state.pageIsUnloading = true;
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      const settings = {
        ...clone(DEFAULTS),
        ...saved,
        attackKeys: Array.isArray(saved.attackKeys) ? saved.attackKeys.slice(0, 3) : clone(DEFAULTS.attackKeys),
        potionEnabled: { ...(saved.potionEnabled || {}) },
        potionUseAmount: { ...(saved.potionUseAmount || {}) },
        potionOrder: {
          stamina: saved.potionOrder?.stamina || [],
          health: saved.potionOrder?.health || [],
        },
      };

      while (settings.attackKeys.length < 3) {
        settings.attackKeys.push(DEFAULTS.attackKeys[settings.attackKeys.length]);
      }

      return settings;
    } catch (error) {
      console.warn('[DLF] Could not load settings.', error);
      return clone(DEFAULTS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
    } catch (error) {
      console.warn('[DLF] Could not save settings.', error);
    }
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function sleepInterruptible(milliseconds, runState = state.runState) {
    const endAt = Date.now() + Math.max(0, milliseconds);

    while (!runState.stopped && Date.now() < endAt) {
      await sleep(Math.min(250, endAt - Date.now()));
    }

    return !runState.stopped;
  }

  function queryAll(selector, root = document) {
    return [...root.querySelectorAll(selector)];
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value) : '?';
  }

  function parseInteger(value) {
    const match = String(value ?? '').match(/-?\d{1,3}(?:[.,\s]\d{3})+|-?\d+/);
    if (!match) return null;

    const number = Number(match[0].replace(/\D/g, ''));
    if (!Number.isFinite(number)) return null;

    return match[0].trim().startsWith('-') ? -number : number;
  }

  function parseFraction(value) {
    const match = String(value ?? '').match(/(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)/);

    if (!match) return null;

    const current = parseInteger(match[1]);
    const maximum = parseInteger(match[2]);

    if (!Number.isFinite(current) || !Number.isFinite(maximum)) return null;
    return { current, maximum };
  }

  function parseGameNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value) : null;
    }

    const match = String(value ?? '').match(/(-?[\d.,]+)\s*([kKmMbBtTqQ])?/);
    if (!match) return null;

    const suffix = String(match[2] || '').toLowerCase();
    if (!suffix) return parseInteger(match[1]);

    let numberText = match[1];

    if (numberText.includes('.') && numberText.includes(',')) {
      const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';
      const thousands = decimal === ',' ? '.' : ',';
      numberText = numberText.split(thousands).join('').replace(decimal, '.');
    } else {
      numberText = numberText.replace(',', '.');
    }

    const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
    const number = Number.parseFloat(numberText);

    return Number.isFinite(number) ? Math.round(number * multipliers[suffix]) : null;
  }

  function firstGameNumber(...values) {
    for (const value of values) {
      const number = parseGameNumber(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function parseTarget(value) {
    const raw = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (!raw) return 0;

    const match = raw.match(/^([\d.,]+)([kmbtq])?$/);
    if (!match) return NaN;

    const factors = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
    const suffix = match[2] || '';
    let numberText = match[1];

    if (!suffix) {
      numberText = numberText.replace(/\D/g, '');
    } else if (numberText.includes('.') && numberText.includes(',')) {
      const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';
      const thousands = decimal === ',' ? '.' : ',';
      numberText = numberText.split(thousands).join('').replace(decimal, '.');
    } else {
      numberText = numberText.replace(',', '.');
    }

    const result = Number(numberText) * factors[suffix];
    return Number.isFinite(result) ? Math.round(result) : NaN;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getUserId() {
    const link = document.querySelector('a[href*="player.php?pid="]');
    const match = link?.href?.match(/pid=(\d+)/);
    return match?.[1] || null;
  }

  function getPlayerHpFromPage() {
    const direct = parseFraction(document.querySelector(SEL.playerHp)?.textContent);
    if (direct) return direct;

    return parseFraction(document.querySelector('.playerhp .muted')?.textContent);
  }

  function getStaminaFromPage() {
    return parseInteger(document.querySelector(SEL.stamina)?.textContent);
  }

  async function fetchDashboardSnapshot() {
    try {
      const response = await fetch('/game_dash.php', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });

      if (!response.ok) return null;

      const html = await response.text();
      const snapshotDocument = new DOMParser().parseFromString(html, 'text/html');
      const stamina = parseInteger(snapshotDocument.querySelector(SEL.stamina)?.textContent);
      const health =
        parseFraction(snapshotDocument.querySelector(SEL.playerHp)?.textContent) ||
        parseFraction(snapshotDocument.querySelector('.playerhp .muted')?.textContent);

      const sourceStamina = snapshotDocument.querySelector(SEL.stamina);
      const targetStamina = document.querySelector(SEL.stamina);
      if (sourceStamina && targetStamina) targetStamina.textContent = sourceStamina.textContent;

      const sourceHp = snapshotDocument.querySelector(SEL.playerHp);
      const targetHp = document.querySelector(SEL.playerHp);
      if (sourceHp && targetHp) targetHp.textContent = sourceHp.textContent;

      return { stamina, health };
    } catch (error) {
      console.warn('[DLF] Could not refresh dashboard values.', error);
      return null;
    }
  }

  async function getStamina() {
    const snapshot = await fetchDashboardSnapshot();
    return snapshot?.stamina ?? getStaminaFromPage();
  }

  function getAliveMonsters() {
    const monsters = [];

    for (const card of document.querySelectorAll('.mon:not(.dead)')) {
      const link = card.querySelector("a[href*='battle.php']");
      if (!link) continue;

      const href = link.getAttribute('href') || '';
      const params = new URLSearchParams(href.split('?')[1] || '');
      const dgmid = params.get('dgmid');
      if (!dgmid) continue;

      const nameElement =
        card.querySelector('[style*="font-weight:700"]') || card.querySelector('[style*="font-weight: 700"]');

      let name = 'Unknown';
      if (nameElement) {
        name = nameElement.textContent.trim();
        nameElement.querySelectorAll('*').forEach((element) => {
          name = name.replace(element.textContent, '').trim();
        });
        name = name.replace(/\s+/g, ' ').trim() || 'Unknown';
      }

      monsters.push({ dgmid, name });
    }

    return monsters;
  }

  async function getMonsterBattleData(dgmid, instanceId) {
    const userId = getUserId();

    try {
      const response = await fetch(`/battle.php?dgmid=${dgmid}&instance_id=${instanceId}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });

      const html = await response.text();
      const battleDocument = new DOMParser().parseFromString(html, 'text/html');

      let capDamage = null;
      for (const block of battleDocument.querySelectorAll('.stat-block')) {
        const label = block.querySelector('.label');
        if (!label || label.textContent.trim() !== 'EXP Cap') continue;

        const note = block.querySelector(':scope > div:not(.label)');
        const match = note?.textContent?.match(/deal\s*~?([\d.,]+\s*[kKmMbBtTqQ]?)\s*dmg/i);
        if (match) {
          capDamage = parseGameNumber(match[1]);
          break;
        }
      }

      let currentDamage = 0;
      if (userId) {
        for (const row of battleDocument.querySelectorAll('.lb-list .lb-row')) {
          const link = row.querySelector('.lb-name a');
          const href = link?.getAttribute('href') || '';
          const pid = new URLSearchParams(href.split('?')[1] || '').get('pid');

          if (String(pid) === String(userId)) {
            currentDamage = parseGameNumber(row.querySelector('.lb-dmg')?.textContent) || 0;
            break;
          }
        }
      }

      return { capDamage, currentDamage };
    } catch (error) {
      console.warn('[DLF] Could not read battle data.', error);
      return { capDamage: null, currentDamage: 0 };
    }
  }

  async function doJoin(dgmid, instanceId) {
    const userId = getUserId();
    if (!userId) return { ok: false, msg: 'Could not find user ID' };

    const body = new URLSearchParams();
    body.set('instance_id', instanceId);
    body.set('dgmid', dgmid);
    body.set('user_id', userId);

    try {
      const response = await fetch('/dungeon_join_battle.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });

      const raw = await response.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        // Plain text responses are supported.
      }

      const explicitFailure = data?.status === 'error' || data?.success === false;
      const ok = !explicitFailure && (response.ok || data?.status === 'success' || data?.success === true);

      return { ok, msg: data?.message || raw.slice(0, 250) };
    } catch (error) {
      return { ok: false, msg: String(error) };
    }
  }

  function getRetryAfterMilliseconds(response) {
    const value = response.headers.get('Retry-After');
    if (!value) return null;

    const seconds = Number.parseInt(String(value).trim(), 10);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120000) : null;
  }

  async function doAttack(dgmid, skill, instanceId) {
    const body = new URLSearchParams();
    body.set('instance_id', instanceId);
    body.set('dgmid', dgmid);
    body.set('skill_id', skill.id);
    body.set('stamina_cost', String(skill.cost));

    let response;
    try {
      response = await fetch('/damage.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        msg: String(error),
        damage: 0,
        totalDamage: null,
        monsterDead: false,
        userHpAfter: null,
        staminaAfter: null,
        feedbackType: null,
        retryAfterMs: null,
      };
    }

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      // Plain text and HTML responses are supported.
    }

    const message = String(data?.message ?? raw ?? '');
    const lowerMessage = message.toLowerCase();

    const strongDamage = String(raw).match(/<strong>\s*([\d,.\s]+)\s*<\/strong>/i)?.[1];
    const messageDamage = message.match(/(?:dealt|hit(?:\s+for)?)\s*([\d,.\s]+)\s*(?:damage|dmg)/i)?.[1];

    const damage =
      firstGameNumber(
        data?.damage,
        data?.damage_dealt,
        data?.damageDealt,
        data?.hit_damage,
        data?.hitDamage,
        strongDamage,
        messageDamage,
      ) || 0;

    const totalDamage = firstGameNumber(
      data?.totaldmgdealt,
      data?.total_damage_dealt,
      data?.totalDamageDealt,
      data?.total_damage,
      data?.totalDamage,
    );

    const userHpAfter = firstGameNumber(data?.retaliation?.user_hp_after, data?.user_hp_after, data?.userHpAfter);

    const staminaAfter = firstGameNumber(data?.stamina_after, data?.staminaAfter, data?.current_stamina);

    const explicitFailure = data?.status === 'error' || data?.success === false;
    const ok = !explicitFailure && (response.ok || data?.status === 'success' || data?.success === true);

    const monsterDead =
      data?.monster_dead === true ||
      data?.monsterDead === true ||
      lowerMessage.includes('is dead') ||
      lowerMessage.includes('defeated') ||
      lowerMessage.includes('monster died') ||
      lowerMessage.includes('already dead') ||
      lowerMessage.includes('you killed') ||
      lowerMessage.includes('has been slain') ||
      lowerMessage.includes('0 hp');

    let feedbackType = null;
    if (
      /not enough\s+stamina|insufficient\s+stamina|out of\s+stamina|stamina\s+(?:is\s+)?(?:empty|too low|depleted)/.test(
        lowerMessage,
      )
    ) {
      feedbackType = 'stamina';
    } else if (
      /you are dead|you died|you have died|knocked out|cannot attack.*dead|dead.*cannot attack/.test(lowerMessage)
    ) {
      feedbackType = 'dead';
    } else if (/cooldown|too fast|please wait|wait before|rate limit|cooling down/.test(lowerMessage)) {
      feedbackType = 'cooldown';
    }

    return {
      ok,
      status: response.status,
      msg: message.slice(0, 250),
      damage,
      totalDamage,
      monsterDead,
      userHpAfter,
      staminaAfter,
      feedbackType,
      retryAfterMs: getRetryAfterMilliseconds(response),
    };
  }

  async function lootAll(instanceId, locationId) {
    const body = new URLSearchParams();
    body.set('action', 'loot_all');
    body.set('instance_id', String(instanceId));
    body.set('location_id', String(locationId));

    try {
      const response = await fetch('/dungeon_loot.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
      return await response.json();
    } catch (error) {
      return { status: 'error', message: String(error) };
    }
  }

  function getPotionType(name, description) {
    const text = `${name} ${description}`.toLowerCase();
    if (text.includes('stamina')) return 'stamina';
    if (/\bhp\b|health|heal/.test(text)) return 'health';
    return 'other';
  }

  function getPotionAmountInput(button) {
    return button.closest('.potion-actions')?.querySelector('input[type="number"]') || null;
  }

  function potionFromButton(button) {
    const card = button.closest(SEL.potionCard);
    const name =
      button.dataset.name?.trim() ||
      card?.querySelector('.potion-name span')?.textContent?.trim() ||
      button.textContent?.trim() ||
      'Unknown Potion';

    const description = card?.querySelector('.potion-desc')?.textContent?.trim() || '';
    const itemId = String(button.dataset.item || card?.dataset.itemId || name);

    const quantity = [
      card?.querySelector('.potion-qty-left')?.textContent,
      button.querySelector('.ds-potion-count')?.textContent,
      button.dataset.max,
    ]
      .map(parseInteger)
      .find(Number.isFinite);

    return {
      key: itemId,
      itemId,
      name,
      description,
      type: getPotionType(name, description),
      quantity: Number.isFinite(quantity) ? quantity : null,
      supportsAmount: Boolean(getPotionAmountInput(button)) || itemId === '30' || itemId === '162',
    };
  }

  function discoverPotions(save = true) {
    const unique = new Map();

    for (const button of queryAll(SEL.potion)) {
      const potion = potionFromButton(button);
      if (potion.type === 'other') continue;

      const existing = unique.get(potion.key);
      const existingQuantity = existing?.quantity ?? -1;
      const newQuantity = potion.quantity ?? -1;

      if (!existing || newQuantity > existingQuantity) unique.set(potion.key, potion);
    }

    state.potions = [...unique.values()];

    for (const type of ['stamina', 'health']) {
      const available = state.potions.filter((potion) => potion.type === type).map((potion) => potion.key);
      const oldOrder = state.settings.potionOrder[type] || [];

      state.settings.potionOrder[type] = [
        ...oldOrder.filter((key) => available.includes(key)),
        ...available.filter((key) => !oldOrder.includes(key)),
      ];

      for (const key of available) {
        if (!(key in state.settings.potionEnabled)) state.settings.potionEnabled[key] = true;
        if (!(key in state.settings.potionUseAmount)) state.settings.potionUseAmount[key] = 1;
      }
    }

    if (save) saveSettings();
    return state.potions;
  }

  function getConfiguredPotionAmount(potion) {
    const value = Number(state.settings.potionUseAmount?.[potion.key] ?? 1);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  }

  function getActualPotionAmount(potion) {
    const configured = getConfiguredPotionAmount(potion);
    if (Number.isFinite(potion.quantity) && potion.quantity > 0) {
      return Math.min(configured, potion.quantity);
    }
    return configured;
  }

  function findLivePotionButton(potion, amount = 1) {
    const matches = queryAll(SEL.potion).filter((button) => {
      return potionFromButton(button).itemId === potion.itemId && !button.disabled;
    });

    if (amount > 1) {
      return (
        matches.find((button) => {
          const input = getPotionAmountInput(button);
          return input && !input.readOnly && !input.disabled;
        }) || null
      );
    }

    return matches.find((button) => button.offsetParent !== null) || matches[0] || null;
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;

    const style = getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  }

  function findPotionConfirmationButton() {
    const directSelectors = [
      '.swal2-container .swal2-confirm',
      '.swal-modal .swal-button--confirm',
      '.modal.show .btn-confirm',
      '.modal.show [data-confirm="true"]',
      '.modal.show button.btn-primary',
      '[role="dialog"][aria-modal="true"] .confirm',
      '[role="dialog"][aria-modal="true"] [data-confirm]',
      '[role="dialog"][aria-modal="true"] button[type="submit"]',
      '.dialog.open .confirm',
      '.popup.open .confirm',
    ];

    for (const selector of directSelectors) {
      const button = queryAll(selector).find((element) => isElementVisible(element) && !element.disabled);
      if (button) return button;
    }

    const dialogSelectors = [
      '.swal2-container',
      '.swal-overlay',
      '.modal.show',
      '[role="dialog"][aria-modal="true"]',
      '.dialog.open',
      '.popup.open',
      '.modal.active',
    ];

    const acceptedText =
      /^(confirm|yes|ok|okay|use|continue|accept|confirm use|use potion|confirm potion|bestätigen|ja|benutzen)$/i;

    for (const selector of dialogSelectors) {
      for (const dialog of queryAll(selector)) {
        if (!isElementVisible(dialog)) continue;

        const button = queryAll('button, input[type="button"], input[type="submit"]', dialog).find((element) => {
          const text = String(element.textContent || element.value || element.getAttribute('aria-label') || '').trim();

          return !element.disabled && isElementVisible(element) && acceptedText.test(text);
        });

        if (button) return button;
      }
    }

    return null;
  }

  async function watchPotionConfirmation(addLog) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < POTION_CONFIRM_TIMEOUT_MS) {
      const button = findPotionConfirmationButton();
      if (button) {
        addLog('Potion confirmation accepted automatically.');
        button.click();
        return true;
      }
      await sleep(75);
    }

    return false;
  }

  function clickPotionWithConfirmation(button, addLog) {
    const originalConfirm = window.confirm;
    let replaced = false;

    try {
      window.confirm = (message) => {
        addLog(`Potion confirmation accepted: ${String(message || 'Confirm')}`);
        return true;
      };
      replaced = true;
    } catch (error) {
      console.warn('[DLF] Could not override confirm().', error);
    }

    void watchPotionConfirmation(addLog);

    try {
      button.click();
    } finally {
      setTimeout(() => {
        if (!replaced) return;
        try {
          window.confirm = originalConfirm;
        } catch (error) {
          console.warn('[DLF] Could not restore confirm().', error);
        }
      }, 1200);
    }
  }

  function saveResumeState() {
    if (!state.activeRun || state.runState.stopped) return;

    clearTimeout(state.resumeCleanupTimer);
    state.resumeCleanupTimer = null;
    state.resumePending = true;

    try {
      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          instanceId: state.activeRun.instanceId,
          locationId: state.activeRun.locationId,
          reason: 'potion',
        }),
      );
    } catch (error) {
      state.resumePending = false;
      console.warn('[DLF] Could not save resume state.', error);
    }
  }

  function loadResumeState() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);
      if (!data?.savedAt || Date.now() - data.savedAt > 120000) {
        clearResumeState();
        return null;
      }

      return data;
    } catch (_) {
      clearResumeState();
      return null;
    }
  }

  function clearResumeState() {
    clearTimeout(state.resumeCleanupTimer);

    state.resumeCleanupTimer = null;
    state.resumePending = false;

    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function scheduleResumeCleanupAfterStableAttack() {
    if (!state.resumePending) return;

    clearTimeout(state.resumeCleanupTimer);

    /*
     * Der Marker bleibt noch fünf Sekunden bestehen.
     * Falls die Potion einen verzögerten Reload auslöst,
     * wird dieser Timer durch den Seitenwechsel abgebrochen
     * und der Marker bleibt für die Wiederaufnahme erhalten.
     */
    state.resumeCleanupTimer = setTimeout(() => {
      if (!state.pageIsUnloading && !state.runState.stopped && state.resumePending) {
        addLog('Potion recovery confirmed after a successful attack.');
        clearResumeState();
      }
    }, 5000);
  }

  function getPreferredPotion(type) {
    discoverPotions();

    return (
      (state.settings.potionOrder[type] || [])
        .map((key) => state.potions.find((potion) => potion.key === key))
        .find((potion) => {
          const available = potion && (potion.quantity === null || potion.quantity > 0);
          return available && state.settings.potionEnabled[potion.key] !== false;
        }) || null
    );
  }

  async function usePotion(type, setStatus, addLog) {
    const potion = getPreferredPotion(type);

    if (!potion) {
      setStatus(`No enabled ${type} potion is available.`, 'error');
      addLog(`No enabled ${type} potion is available.`);
      return false;
    }

    const amount = potion.supportsAmount ? getActualPotionAmount(potion) : 1;
    const button = findLivePotionButton(potion, amount);

    if (!button) {
      const message =
        amount > 1 ? `${potion.name} has no editable amount field.` : `${potion.name} could not be found.`;
      setStatus(message, 'error');
      addLog(message);
      return false;
    }

    const input = getPotionAmountInput(button);
    if (amount > 1 && (!input || input.readOnly || input.disabled)) {
      const message = `Could not set the amount for ${potion.name}.`;
      setStatus(message, 'error');
      addLog(message);
      return false;
    }

    const beforeQuantity = potion.quantity;
    const beforeSnapshot = await fetchDashboardSnapshot();
    const beforeResource =
      type === 'stamina'
        ? (beforeSnapshot?.stamina ?? getStaminaFromPage())
        : (beforeSnapshot?.health?.current ?? getPlayerHpFromPage()?.current);

    if (input && !input.readOnly && !input.disabled) {
      input.value = String(amount);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
    }

    const stockText = Number.isFinite(beforeQuantity) ? formatNumber(beforeQuantity) : 'unknown';
    addLog(
      amount > 1
        ? `Using ${formatNumber(amount)} x ${potion.name}. Stock before use: ${stockText}.`
        : `Using ${potion.name}. Stock before use: ${stockText}.`,
    );
    setStatus(`Using ${potion.name}...`, 'running');

    saveResumeState();
    clickPotionWithConfirmation(button, addLog);

    const startedAt = Date.now();
    while (!state.runState.stopped && Date.now() - startedAt < POTION_RESULT_TIMEOUT_MS) {
      await sleep(160);
      discoverPotions(false);

      const refreshed = state.potions.find((item) => item.key === potion.key);
      const afterResource = type === 'stamina' ? getStaminaFromPage() : getPlayerHpFromPage()?.current;

      const quantityChanged =
        Number.isFinite(beforeQuantity) && Number.isFinite(refreshed?.quantity) && refreshed.quantity < beforeQuantity;

      const resourceChanged =
        Number.isFinite(beforeResource) && Number.isFinite(afterResource) && afterResource > beforeResource;

      if (quantityChanged || resourceChanged) {
        // clearResumeState();
        saveSettings();
        renderPotionLists();
        updateMetrics();
        addLog(`${potion.name} was used successfully.`);
        return true;
      }
    }

    const afterSnapshot = await fetchDashboardSnapshot();
    const afterResource = type === 'stamina' ? afterSnapshot?.stamina : afterSnapshot?.health?.current;

    discoverPotions(false);
    const refreshed = state.potions.find((item) => item.key === potion.key);

    const quantityChanged =
      Number.isFinite(beforeQuantity) && Number.isFinite(refreshed?.quantity) && refreshed.quantity < beforeQuantity;

    const resourceChanged =
      Number.isFinite(beforeResource) && Number.isFinite(afterResource) && afterResource > beforeResource;

    if (quantityChanged || resourceChanged) {
      // clearResumeState();
      renderPotionLists();
      updateMetrics();
      addLog(`${potion.name} was used successfully.`);
      return true;
    }

    clearResumeState();
    renderPotionLists();
    addLog(`${potion.name} was clicked, but no resource or quantity change was detected.`);
    return false;
  }

  function getSelectedSkills(settings) {
    const unique = new Set();
    const skills = [];

    for (const key of settings.attackKeys || []) {
      const skill = SKILLS[key];
      if (!skill || unique.has(key)) continue;
      unique.add(key);
      skills.push({ key, ...skill });
    }

    if (!skills.length) skills.push({ key: 'slash', ...SKILLS.slash });
    return skills;
  }

  function chooseAttack(stamina, settings) {
    const skills = getSelectedSkills(settings);
    if (!Number.isFinite(stamina)) return skills[0];

    const reserve = Math.max(0, Number(settings.staminaReserve) || 0);
    return skills.find((skill) => stamina >= skill.cost + reserve) || null;
  }

  async function ensureAttackAvailable(settings, runState, setStatus, addLog, counters) {
    const stamina = await getStamina();
    const attack = chooseAttack(stamina, settings);

    if (attack) {
      counters.staminaWaits = 0;
      return { attack, stamina };
    }

    const skills = getSelectedSkills(settings);
    const cheapest = Math.min(...skills.map((skill) => skill.cost));
    const required = cheapest + Math.max(0, Number(settings.staminaReserve) || 0);

    if (settings.autoStamina) {
      setStatus(
        `Stamina ${formatNumber(stamina)} is below the required ${formatNumber(required)}. Using a potion...`,
        'running',
      );

      const used = await usePotion('stamina', setStatus, addLog);
      if (used) {
        counters.staminaWaits = 0;
        return { retry: true };
      }
    }

    if (settings.staminaFailureAction === 'stop') {
      return { stop: true, reason: 'no_stamina', stamina, required };
    }

    counters.staminaWaits += 1;
    if (counters.staminaWaits > settings.maxStaminaWaits) {
      return { stop: true, reason: 'no_stamina', stamina, required };
    }

    const waitMs = Math.max(1, settings.staminaWaitSeconds) * 1000;
    setStatus(
      `Low stamina (${formatNumber(stamina)}). Waiting ${Math.round(waitMs / 1000)} seconds ` +
        `(${counters.staminaWaits}/${settings.maxStaminaWaits})...`,
      'running',
    );
    await sleepInterruptible(waitMs, runState);

    if (runState.stopped) return { stop: true, reason: 'stopped' };
    return { retry: true };
  }

  async function ensureHealthAvailable(playerHp, settings, runState, setStatus, addLog) {
    if (!playerHp || !Number.isFinite(playerHp.maximum) || playerHp.maximum <= 0) {
      return { ok: true, health: playerHp };
    }

    if (playerHp.current <= 0 && !settings.autoHealth) {
      runState.stopped = true;
      return { ok: false, reason: 'player_dead' };
    }

    if (!settings.autoHealth) {
      return { ok: true, health: playerHp };
    }

    const percentage = Math.round((playerHp.current / playerHp.maximum) * 100);
    if (playerHp.current > 0 && percentage > settings.healthThreshold) {
      return { ok: true, health: playerHp };
    }

    setStatus(
      `HP is low (${formatNumber(playerHp.current)} / ${formatNumber(playerHp.maximum)}). Using a potion...`,
      'running',
    );

    const used = await usePotion('health', setStatus, addLog);
    if (used) {
      await sleep(400);
      const snapshot = await fetchDashboardSnapshot();
      return { ok: true, health: snapshot?.health || getPlayerHpFromPage() || playerHp };
    }

    if (playerHp.current <= 0) {
      const healButton = document.getElementById('healBtn');
      if (healButton && !healButton.disabled) {
        addLog('No health potion was available. Clicking the page revive button.');
        healButton.click();
        await sleep(3000);
        const snapshot = await fetchDashboardSnapshot();
        return { ok: true, health: snapshot?.health || getPlayerHpFromPage() || playerHp };
      }
    }

    if (settings.healthFailureAction === 'continue' && playerHp.current > 0) {
      addLog('No enabled health potion was available. Continuing because this is configured.');
      return { ok: true, health: playerHp };
    }

    runState.stopped = true;
    return { ok: false, reason: playerHp.current <= 0 ? 'player_dead' : 'no_health_potion' };
  }

  async function attackUntilTarget(dgmid, name, instanceId, settings, runState, setStatus, line, addLog) {
    let target = null;
    let baseline = 0;

    if (settings.damageMode === 'cap' || settings.damageMode === 'specific') {
      setStatus(`Checking battle data for ${name}...`, 'running');
      const battleData = await getMonsterBattleData(dgmid, instanceId);
      baseline = battleData.currentDamage || 0;

      if (settings.damageMode === 'cap') {
        target = battleData.capDamage;
        if (!Number.isFinite(target)) {
          addLog(`No EXP cap was found for ${name}. Kill mode will be used for this monster.`);
          target = null;
        }
      } else {
        target = settings.specificDamage;
      }

      if (Number.isFinite(target) && baseline >= target) {
        const message = `${name} is already at target (${formatNumber(baseline)} / ${formatNumber(target)}).`;
        setStatus(message, 'success');
        line.update(`✓ ${message}`, '#5fd07a');
        return { reason: 'already_done', totalDamage: baseline };
      }
    }

    let playerHp = getPlayerHpFromPage();

    setStatus(`Joining ${name}...`, 'running');
    const joinResult = await doJoin(dgmid, instanceId);
    if (!joinResult.ok) {
      const message = `Join failed for ${name}: ${joinResult.msg}`;
      setStatus(message, 'error');
      line.update(`✗ ${message}`, '#e06c6c');
      return { reason: 'join_failed' };
    }

    let attackCount = 0;
    let sessionDamage = 0;
    let totalDamage = baseline;
    let failRetries = 0;
    const counters = { staminaWaits: 0 };

    while (!runState.stopped) {
      const healthResult = await ensureHealthAvailable(playerHp, settings, runState, setStatus, addLog);

      if (!healthResult.ok) {
        line.update(
          `✗ ${name} - ${healthResult.reason === 'player_dead' ? 'player died' : 'no health potion'} ` +
            `(${formatNumber(totalDamage)} dmg)`,
          '#e06c6c',
        );
        return { reason: healthResult.reason, totalDamage };
      }
      playerHp = healthResult.health;

      const prepared = await ensureAttackAvailable(settings, runState, setStatus, addLog, counters);

      if (prepared.stop) {
        if (prepared.reason === 'stopped') break;

        const message =
          `${name} - out of stamina (${formatNumber(prepared.stamina)} available, ` +
          `${formatNumber(prepared.required)} required)`;
        line.update(`✗ ${message}`, '#e0b35c');
        runState.stopped = true;
        return { reason: 'no_stamina', totalDamage };
      }

      if (prepared.retry) continue;
      const skill = prepared.attack;

      let result = null;
      for (let attempt = 0; attempt < MAX_RATE_RETRIES; attempt += 1) {
        if (runState.stopped) break;

        result = await doAttack(dgmid, skill, instanceId);
        const rateLimited =
          result.status === 429 ||
          result.feedbackType === 'cooldown' ||
          /rate limit|too fast|cooling down/.test(String(result.msg).toLowerCase());

        if (!rateLimited && result.status === 200) break;
        if (!rateLimited && result.status !== 200 && result.status !== 0) break;

        const wait = result.retryAfterMs || Math.min(20000, 800 * Math.pow(2, attempt));
        setStatus(`Rate limited. Retrying ${name} in ${Math.ceil(wait / 1000)} seconds...`, 'running');
        await sleepInterruptible(wait, runState);
      }

      if (runState.stopped || !result) break;

      if (result.feedbackType === 'stamina') {
        addLog(`${skill.name} was rejected because of stamina. Rechecking attack fallbacks.`);
        await sleep(300);
        continue;
      }

      if (result.feedbackType === 'dead') {
        playerHp = { current: 0, maximum: playerHp?.maximum || 0 };
        continue;
      }

      if (!result.ok && !result.monsterDead) {
        failRetries += 1;
        if (failRetries >= MAX_FAIL_RETRIES) {
          const message = `${name} - gave up after ${MAX_FAIL_RETRIES} failed attacks.`;
          setStatus(message, 'error');
          line.update(`✗ ${message}`, '#e06c6c');
          return { reason: 'failed', totalDamage };
        }

        setStatus(`${skill.name} failed (${failRetries}/${MAX_FAIL_RETRIES}): ${result.msg}`, 'error');
        await sleep(1000);
        continue;
      }

      failRetries = 0;

      /*
       * Ein Angriff nach der Potion hat funktioniert.
       * Der Resume-Marker wird mit Verzögerung gelöscht,
       * falls die Seite nicht doch noch neu lädt.
       */
      scheduleResumeCleanupAfterStableAttack();

      attackCount += 1;
      sessionDamage += Math.max(0, Number(result.damage) || 0);

      const reportedTotal = Number(result.totalDamage);
      totalDamage = Math.max(baseline + sessionDamage, Number.isFinite(reportedTotal) ? reportedTotal : 0);

      if (Number.isFinite(result.userHpAfter)) {
        playerHp = {
          current: result.userHpAfter,
          maximum: playerHp?.maximum || Math.max(result.userHpAfter, 1),
        };
      }

      if (Number.isFinite(result.staminaAfter)) {
        const staminaElement = document.querySelector(SEL.stamina);
        if (staminaElement) staminaElement.textContent = formatNumber(result.staminaAfter);
      }

      const targetText = Number.isFinite(target)
        ? `${formatNumber(totalDamage)} / ${formatNumber(target)}`
        : `${formatNumber(totalDamage)} dmg`;

      setStatus(`${name}: ${skill.name} #${attackCount}, +${formatNumber(result.damage)} [${targetText}]`, 'running');
      line.update(`⚔ ${name} - ${targetText} (${skill.name}, hit #${attackCount})`);
      updateMetrics(skill.name);

      if (result.monsterDead) {
        const message = `${name} defeated (${formatNumber(totalDamage)} dmg).`;
        setStatus(message, 'success');
        line.update(`💀 ${message}`, '#5fd07a');
        return { reason: 'dead', attackCount, totalDamage };
      }

      if (Number.isFinite(target) && totalDamage >= target) {
        const message = `${name} reached target (${formatNumber(totalDamage)} / ${formatNumber(target)}).`;
        setStatus(message, 'success');
        line.update(`🎯 ${message}`, '#5fd07a');
        return { reason: 'target_reached', attackCount, totalDamage };
      }

      if (settings.attackDelayMs > 0) {
        await sleepInterruptible(settings.attackDelayMs, runState);
      }
    }

    return { reason: 'stopped', totalDamage };
  }

  async function runFarm(instanceId, locationId, settings, runState, setStatus, newLogLine, addLog) {
    const monsters = getAliveMonsters();

    if (!monsters.length) {
      setStatus('No alive monsters were found on this location.', 'error');
      return;
    }

    setStatus(`Found ${monsters.length} alive monster(s). Starting...`, 'running');
    addLog(`Started with ${monsters.length} alive monster(s).`);
    await sleep(300);

    let killed = 0;
    let processed = 0;

    for (let index = 0; index < monsters.length; index += 1) {
      if (runState.stopped) break;

      const monster = monsters[index];
      const line = newLogLine(`[${index + 1}/${monsters.length}] ${monster.name} - starting...`);

      const result = await attackUntilTarget(
        monster.dgmid,
        monster.name,
        instanceId,
        settings,
        runState,
        setStatus,
        line,
        addLog,
      );

      if (result.reason === 'dead') killed += 1;
      if (['dead', 'target_reached', 'already_done'].includes(result.reason)) processed += 1;
      if (['no_stamina', 'player_dead', 'no_health_potion'].includes(result.reason)) break;
    }

    if (runState.stopped) {
      setStatus(`Stopped. Processed ${processed}, killed ${killed}.`, 'idle');
      addLog(`Stopped. Processed ${processed}, killed ${killed}.`);
      return;
    }

    if (killed > 0) {
      setStatus('Looting dead monsters...', 'running');
      const loot = await lootAll(instanceId, locationId);

      if (loot?.status === 'success') {
        const summary = loot.summary || {};
        const message =
          `Done. Killed ${killed}, processed ${processed}. ` +
          `EXP: ${formatNumber(summary.exp || 0)}, Gold: ${formatNumber(summary.gold || 0)}, ` +
          `Items: ${Array.isArray(loot.items) ? loot.items.length : 0}.`;
        setStatus(message, 'success');
        addLog(message);
      } else {
        const message = `Done, but looting failed. Killed ${killed}, processed ${processed}.`;
        setStatus(message, 'error');
        addLog(message);
      }
    } else {
      const message = `Done. Processed ${processed} monster(s), none killed.`;
      setStatus(message, 'success');
      addLog(message);
    }
  }

  function injectStyles() {
    if (document.getElementById(`${ID}-style`)) return;

    const style = document.createElement('style');
    style.id = `${ID}-style`;
    style.textContent = `
      #${ID}-overlay {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 10000;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(0,0,0,.76);
      }

      #${ID} {
        width: min(680px, 97vw);
        max-height: 92vh;
        overflow: auto;
        padding: 18px;
        border: 1px solid #363d60;
        border-radius: 16px;
        background: #111322;
        color: #dfe6ff;
        box-shadow: 0 18px 60px rgba(0,0,0,.7);
        font: 13px system-ui, Arial, sans-serif;
      }

      #${ID} * { box-sizing: border-box; }
      #${ID} h2 { margin: 0; font-size: 17px; }
      #${ID} .dlf-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px; }
      #${ID} .dlf-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      #${ID} .dlf-section { margin-top:12px; padding:11px; border:1px solid #2e3452; border-radius:11px; background:#14172a; }
      #${ID} .dlf-section-title { margin-bottom:9px; color:#bdc7f5; font-size:11px; font-weight:800; text-transform:uppercase; }
      #${ID} .dlf-field { display:flex; flex-direction:column; gap:5px; color:#cfd6f7; font-size:12px; font-weight:700; }
      #${ID} .dlf-field small, #${ID} .dlf-hint { color:#858fb8; font-size:10px; font-weight:500; line-height:1.45; }
      #${ID} select, #${ID} input[type="text"], #${ID} input[type="number"] {
        width:100%; min-height:35px; padding:7px 9px; border:1px solid #3a4163; border-radius:8px;
        outline:none; background:#0e1020; color:#eef1ff;
      }
      #${ID} select:focus, #${ID} input:focus { border-color:#7488ff; box-shadow:0 0 0 2px rgba(116,136,255,.16); }
      #${ID} input[type="checkbox"], #${ID} input[type="radio"] { accent-color:#7185ff; }
      #${ID} .dlf-options { display:flex; flex-wrap:wrap; gap:9px 16px; align-items:center; }
      #${ID} .dlf-potion-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      #${ID} fieldset { min-width:0; margin:0; padding:9px; border:1px solid #2f3554; border-radius:10px; background:#101322; }
      #${ID} legend { color:#bfc8f5; font-size:11px; font-weight:800; text-transform:uppercase; }
      #${ID} .dlf-list { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
      #${ID} .dlf-potion-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; gap:6px; align-items:center; padding:6px; border:1px solid #2a304c; border-radius:8px; background:#191c30; }
      #${ID} .dlf-potion-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
      #${ID} .dlf-potion-amount { display:flex; align-items:center; gap:5px; margin-top:4px; color:#98a4d2; font-size:10px; }
      #${ID} .dlf-potion-amount input { width:62px; min-height:25px; padding:3px 6px; font-size:11px; }
      #${ID} .dlf-qty { color:#98a4d2; font-size:10px; font-variant-numeric:tabular-nums; }
      #${ID} .dlf-moves { display:flex; gap:3px; }
      #${ID} button { border-radius:8px; cursor:pointer; font-weight:750; }
      #${ID} .dlf-move { width:25px; height:25px; padding:0; border:1px solid #3a4267; background:#242943; color:#e3e8ff; }
      #${ID} button:disabled { opacity:.4; cursor:default; }
      #${ID} .dlf-controls { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
      #${ID} .dlf-primary { padding:9px 14px; border:1px solid #35845e; background:#245d42; color:#fff; }
      #${ID} .dlf-stop { padding:9px 14px; border:1px solid #9a3b45; background:#6e2930; color:#fff; }
      #${ID} .dlf-secondary { padding:8px 11px; border:1px solid #3b4267; background:#252a43; color:#fff; }
      #${ID} .dlf-close { padding:5px 9px; border:1px solid #3b4267; background:#252a43; color:#c4c9de; }
      #${ID} .dlf-status { margin-top:11px; padding:9px 10px; border:1px solid #343a59; border-radius:9px; background:#171a2b; font-size:12px; font-weight:700; }
      #${ID} .dlf-status-running { border-color:#3d765d; background:#17271f; color:#b8f0cf; }
      #${ID} .dlf-status-success { border-color:#476d85; background:#16242d; color:#c8ebff; }
      #${ID} .dlf-status-error { border-color:#7e3b45; background:#2a171b; color:#ffc5cb; }
      #${ID} .dlf-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-top:9px; }
      #${ID} .dlf-metrics > div { padding:7px; border:1px solid #2d3350; border-radius:8px; background:#111423; }
      #${ID} .dlf-metrics span { display:block; color:#8792bd; font-size:9px; text-transform:uppercase; }
      #${ID} .dlf-metrics strong { display:block; margin-top:3px; font-size:12px; }
      #${ID} .dlf-log { max-height:170px; overflow:auto; margin-top:7px; padding:7px; border:1px solid #292f4b; border-radius:8px; background:#0d0f1b; color:#aeb8df; font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
      #${ID} .dlf-empty { color:#7883aa; font-size:10px; line-height:1.4; }
      @media (max-width:700px) {
        #${ID} .dlf-grid, #${ID} .dlf-potion-grid, #${ID} .dlf-metrics { grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function createSkillOptions(selectedKey) {
    return Object.entries(SKILLS)
      .map(([key, skill]) => {
        const selected = key === selectedKey ? ' selected' : '';
        return `<option value="${escapeHtml(key)}"${selected}>${escapeHtml(skill.name)} (${skill.cost} STA)</option>`;
      })
      .join('');
  }

  function createUI() {
    const urlParams = new URLSearchParams(location.search);
    const instanceId = urlParams.get('instance_id');
    const locationId = urlParams.get('location_id');
    if (!instanceId || !locationId) return;

    let monstersHeader = null;
    for (const header of document.querySelectorAll('.panel .h')) {
      if (header.textContent.includes('Monsters')) {
        monstersHeader = header;
        break;
      }
    }
    if (!monstersHeader) return;

    injectStyles();
    discoverPotions();

    const triggerRow = document.createElement('div');
    triggerRow.style.cssText = 'margin:8px 0 12px;';

    const triggerButton = document.createElement('button');
    triggerButton.type = 'button';
    triggerButton.textContent = '⚔ Farm Location';
    triggerButton.style.cssText =
      'padding:7px 14px;border-radius:10px;border:1px solid #2f324d;background:#24263a;color:#edeff6;font-size:13px;font-weight:700;cursor:pointer';

    triggerRow.appendChild(triggerButton);
    monstersHeader.insertAdjacentElement('afterend', triggerRow);

    const overlay = document.createElement('div');
    overlay.id = `${ID}-overlay`;
    overlay.innerHTML = `
      <section id="${ID}">
        <div class="dlf-head">
          <div>
            <h2>⚔ Dungeon Location Farmer</h2>
            <div class="dlf-hint">Attack fallbacks and real potion priorities</div>
          </div>
          <button id="dlfClose" class="dlf-close" type="button">Close</button>
        </div>

        <div class="dlf-section">
          <div class="dlf-section-title">Attack priority</div>
          <div class="dlf-grid">
            <label class="dlf-field">
              <span>Attack 1 <small>Primary</small></span>
              <select id="dlfAttack1">${createSkillOptions(state.settings.attackKeys[0])}</select>
            </label>
            <label class="dlf-field">
              <span>Attack 2 <small>First stamina fallback</small></span>
              <select id="dlfAttack2">${createSkillOptions(state.settings.attackKeys[1])}</select>
            </label>
            <label class="dlf-field">
              <span>Attack 3 <small>Second stamina fallback</small></span>
              <select id="dlfAttack3">${createSkillOptions(state.settings.attackKeys[2])}</select>
            </label>
            <label class="dlf-field">
              <span>Delay between attacks (ms)</span>
              <input id="dlfDelay" type="number" min="0" step="50" value="${state.settings.attackDelayMs}">
            </label>
          </div>
        </div>

        <div class="dlf-section">
          <div class="dlf-section-title">Damage goal</div>
          <div class="dlf-options">
            <label><input type="radio" name="dlfMode" value="kill" ${state.settings.damageMode === 'kill' ? 'checked' : ''}> Kill monster</label>
            <label><input type="radio" name="dlfMode" value="cap" ${state.settings.damageMode === 'cap' ? 'checked' : ''}> EXP cap</label>
            <label><input type="radio" name="dlfMode" value="specific" ${state.settings.damageMode === 'specific' ? 'checked' : ''}> Specific damage</label>
          </div>
          <label id="dlfSpecificRow" class="dlf-field" style="margin-top:9px;${state.settings.damageMode === 'specific' ? '' : 'display:none'}">
            <span>Damage amount <small>Examples: 5m, 5b, 5,000,000</small></span>
            <input id="dlfSpecific" type="text" value="${escapeHtml(state.settings.specificDamage)}" placeholder="5m">
          </label>
        </div>

        <div class="dlf-section">
          <div class="dlf-section-title">Resource behavior</div>
          <div class="dlf-grid">
            <label class="dlf-field">
              <span><input id="dlfAutoStamina" type="checkbox" ${state.settings.autoStamina ? 'checked' : ''}> Use stamina potions automatically</span>
              <small>A potion is used only when none of the three attacks can preserve the stamina reserve.</small>
            </label>
            <label class="dlf-field">
              <span>Stamina reserve after attack</span>
              <input id="dlfReserve" type="number" min="0" value="${state.settings.staminaReserve}">
            </label>
            <label class="dlf-field">
              <span>When no stamina potion works</span>
              <select id="dlfStaminaAction">
                <option value="wait" ${state.settings.staminaFailureAction === 'wait' ? 'selected' : ''}>Wait for regeneration</option>
                <option value="stop" ${state.settings.staminaFailureAction === 'stop' ? 'selected' : ''}>Stop immediately</option>
              </select>
            </label>
            <label class="dlf-field">
              <span>Wait seconds / maximum waits</span>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
                <input id="dlfWaitSeconds" type="number" min="1" value="${state.settings.staminaWaitSeconds}" title="Seconds per wait">
                <input id="dlfMaxWaits" type="number" min="1" value="${state.settings.maxStaminaWaits}" title="Maximum waits">
              </div>
            </label>
            <label class="dlf-field">
              <span><input id="dlfAutoHealth" type="checkbox" ${state.settings.autoHealth ? 'checked' : ''}> Use health potions automatically</span>
              <small>The first enabled health potion in the priority list is used.</small>
            </label>
            <label class="dlf-field">
              <span>Use health potion at or below (%)</span>
              <input id="dlfHealthThreshold" type="number" min="1" max="99" value="${state.settings.healthThreshold}">
            </label>
            <label class="dlf-field">
              <span>When no health potion works</span>
              <select id="dlfHealthAction">
                <option value="stop" ${state.settings.healthFailureAction === 'stop' ? 'selected' : ''}>Stop</option>
                <option value="continue" ${state.settings.healthFailureAction === 'continue' ? 'selected' : ''}>Continue while alive</option>
              </select>
            </label>
          </div>
        </div>

        <div class="dlf-section">
          <div class="dlf-section-title">Potion priority</div>
          <div class="dlf-potion-grid">
            <fieldset>
              <legend>Stamina potions</legend>
              <div id="dlfStaminaList" class="dlf-list"></div>
            </fieldset>
            <fieldset>
              <legend>Health potions</legend>
              <div id="dlfHealthList" class="dlf-list"></div>
            </fieldset>
          </div>
          <button id="dlfRefreshPotions" class="dlf-secondary" type="button" style="margin-top:9px">Refresh potion list</button>
          <div class="dlf-hint" style="margin-top:7px">
            The farmer uses the first enabled potion with stock. Use the arrows to change priority.
          </div>
        </div>

        <div class="dlf-controls">
          <button id="dlfStart" class="dlf-primary" type="button">▶ Start</button>
          <button id="dlfStop" class="dlf-stop" type="button" disabled>■ Stop</button>
        </div>

        <div id="dlfStatus" class="dlf-status">Ready.</div>

        <div class="dlf-metrics">
          <div><span>Stamina</span><strong id="dlfMetricStamina">?</strong></div>
          <div><span>HP</span><strong id="dlfMetricHp">?</strong></div>
          <div><span>Current attack</span><strong id="dlfMetricAttack">-</strong></div>
        </div>

        <details id="dlfLogDetails" style="margin-top:9px">
          <summary>Log</summary>
          <div id="dlfLog" class="dlf-log"></div>
        </details>
      </section>
    `;

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.activeRun = { instanceId, locationId };

    state.ui = {
      triggerButton,
      close: overlay.querySelector('#dlfClose'),
      start: overlay.querySelector('#dlfStart'),
      stop: overlay.querySelector('#dlfStop'),
      status: overlay.querySelector('#dlfStatus'),
      logDetails: overlay.querySelector('#dlfLogDetails'),
      log: overlay.querySelector('#dlfLog'),
      specificRow: overlay.querySelector('#dlfSpecificRow'),
      staminaList: overlay.querySelector('#dlfStaminaList'),
      healthList: overlay.querySelector('#dlfHealthList'),
      metricStamina: overlay.querySelector('#dlfMetricStamina'),
      metricHp: overlay.querySelector('#dlfMetricHp'),
      metricAttack: overlay.querySelector('#dlfMetricAttack'),
    };

    state.ui.logDetails?.addEventListener('toggle', () => {
      if (!state.runState.stopped && !state.ui.logDetails.open) {
        requestAnimationFrame(() => {
          if (!state.runState.stopped && state.ui.logDetails) {
            state.ui.logDetails.open = true;
          }
        });
      }
    });

    bindUIEvents(instanceId, locationId);
    renderPotionLists();
    updateMetrics();

    setTimeout(() => {
      void resumeAfterReload(instanceId, locationId);
    }, 450);
  }

  function readForm() {
    if (!state.overlay) return state.settings;

    state.settings.attackKeys = [1, 2, 3].map((number) => {
      return state.overlay.querySelector(`#dlfAttack${number}`)?.value || 'slash';
    });

    state.settings.attackDelayMs = Math.max(
      0,
      Math.floor(Number(state.overlay.querySelector('#dlfDelay')?.value) || 0),
    );

    state.settings.damageMode = state.overlay.querySelector('input[name="dlfMode"]:checked')?.value || 'kill';
    state.settings.specificDamage = state.overlay.querySelector('#dlfSpecific')?.value.trim() || '0';

    state.settings.autoStamina = state.overlay.querySelector('#dlfAutoStamina')?.checked || false;
    state.settings.staminaReserve = Math.max(
      0,
      Math.floor(Number(state.overlay.querySelector('#dlfReserve')?.value) || 0),
    );
    state.settings.staminaFailureAction = state.overlay.querySelector('#dlfStaminaAction')?.value || 'wait';
    state.settings.staminaWaitSeconds = Math.max(
      1,
      Math.floor(Number(state.overlay.querySelector('#dlfWaitSeconds')?.value) || 30),
    );
    state.settings.maxStaminaWaits = Math.max(
      1,
      Math.floor(Number(state.overlay.querySelector('#dlfMaxWaits')?.value) || 10),
    );

    state.settings.autoHealth = state.overlay.querySelector('#dlfAutoHealth')?.checked || false;
    state.settings.healthThreshold = Math.min(
      99,
      Math.max(1, Math.floor(Number(state.overlay.querySelector('#dlfHealthThreshold')?.value) || 30)),
    );
    state.settings.healthFailureAction = state.overlay.querySelector('#dlfHealthAction')?.value || 'stop';

    saveSettings();
    return state.settings;
  }

  function validateSettings() {
    if (state.settings.damageMode === 'specific') {
      const target = parseTarget(state.settings.specificDamage);
      if (!Number.isFinite(target) || target <= 0) {
        setStatus('Invalid specific damage. Examples: 5m, 5b, or 5,000,000.', 'error');
        return false;
      }
    }

    if (!getSelectedSkills(state.settings).length) {
      setStatus('Select at least one valid attack.', 'error');
      return false;
    }

    return true;
  }

  function setStatus(message, tone = 'idle') {
    if (!state.ui.status) return;
    state.ui.status.textContent = message;
    state.ui.status.className = `dlf-status dlf-status-${tone}`;
  }

  function keepRunningLogVisible(scrollIntoView = false) {
    if (state.runState.stopped || !state.ui.logDetails) return;

    // Log aufklappen.
    state.ui.logDetails.open = true;

    // Innerhalb des Logs immer die neuesten Einträge anzeigen.
    if (state.ui.log) {
      state.ui.log.scrollTop = state.ui.log.scrollHeight;
    }

    if (scrollIntoView) {
      // Zweimal requestAnimationFrame, damit das <details>-Element
      // zuerst vollständig aufgeklappt und berechnet wird.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!state.runState.stopped && state.ui.logDetails) {
            state.ui.logDetails.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
              inline: 'nearest',
            });
          }
        });
      });
    }
  }

  function addLog(message) {
    if (!state.ui.log) return;

    keepRunningLogVisible();

    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString('en-GB')}] ${message}`;
    state.ui.log.prepend(line);

    while (state.ui.log.children.length > MAX_LOG_LINES) {
      state.ui.log.lastElementChild?.remove();
    }

    state.ui.log.scrollTop = 0;
  }

  function newLogLine(text, color) {
    keepRunningLogVisible();

    const line = document.createElement('div');
    line.textContent = text;
    if (color) line.style.color = color;
    state.ui.log.prepend(line);

    while (state.ui.log.children.length > MAX_LOG_LINES) {
      state.ui.log.lastElementChild?.remove();
    }

    state.ui.log.scrollTop = 0;

    return {
      update(nextText, nextColor) {
        keepRunningLogVisible();
        line.textContent = nextText;
        if (nextColor) line.style.color = nextColor;
        state.ui.log.scrollTop = 0;
      },
    };
  }

  function updateButtons() {
    const running = !state.runState.stopped;
    if (state.ui.start) state.ui.start.disabled = running;
    if (state.ui.stop) state.ui.stop.disabled = !running;
    if (state.ui.close) state.ui.close.disabled = running;
  }

  function updateMetrics(activeAttack = null) {
    const stamina = getStaminaFromPage();
    const hp = getPlayerHpFromPage();

    if (state.ui.metricStamina) state.ui.metricStamina.textContent = formatNumber(stamina);
    if (state.ui.metricHp) {
      state.ui.metricHp.textContent = hp ? `${formatNumber(hp.current)} / ${formatNumber(hp.maximum)}` : '?';
    }
    if (state.ui.metricAttack && activeAttack !== null) {
      state.ui.metricAttack.textContent = activeAttack || '-';
    }
  }

  function renderPotionLists() {
    if (!state.overlay) return;
    discoverPotions();
    renderPotionList('stamina', state.ui.staminaList);
    renderPotionList('health', state.ui.healthList);
  }

  function renderPotionList(type, container) {
    if (!container) return;
    container.replaceChildren();

    const potions = (state.settings.potionOrder[type] || [])
      .map((key) => state.potions.find((potion) => potion.key === key))
      .filter(Boolean);

    if (!potions.length) {
      const empty = document.createElement('div');
      empty.className = 'dlf-empty';
      empty.textContent = 'No matching potion was found on this page.';
      container.appendChild(empty);
      return;
    }

    potions.forEach((potion, index) => {
      const row = document.createElement('div');
      row.className = 'dlf-potion-row';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = state.settings.potionEnabled[potion.key] !== false;
      enabled.title = 'Allow this potion';
      enabled.addEventListener('change', () => {
        state.settings.potionEnabled[potion.key] = enabled.checked;
        saveSettings();
      });

      const main = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'dlf-potion-name';
      name.textContent = potion.name;
      name.title = potion.description;
      main.appendChild(name);

      if (potion.supportsAmount) {
        const amountRow = document.createElement('label');
        amountRow.className = 'dlf-potion-amount';

        const amountLabel = document.createElement('span');
        amountLabel.textContent = 'Use at once:';

        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.min = '1';
        amountInput.step = '1';
        amountInput.value = String(getConfiguredPotionAmount(potion));
        amountInput.addEventListener('change', () => {
          const amount = Math.max(1, Math.floor(Number(amountInput.value) || 1));
          amountInput.value = String(amount);
          state.settings.potionUseAmount[potion.key] = amount;
          saveSettings();
        });

        amountRow.append(amountLabel, amountInput);
        main.appendChild(amountRow);
      }

      const quantity = document.createElement('div');
      quantity.className = 'dlf-qty';
      quantity.textContent = Number.isFinite(potion.quantity) ? `x${formatNumber(potion.quantity)}` : 'x?';

      const moves = document.createElement('div');
      moves.className = 'dlf-moves';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'dlf-move';
      up.textContent = '↑';
      up.title = 'Increase priority';
      up.disabled = index === 0;
      up.addEventListener('click', () => movePotion(type, index, -1));

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'dlf-move';
      down.textContent = '↓';
      down.title = 'Decrease priority';
      down.disabled = index === potions.length - 1;
      down.addEventListener('click', () => movePotion(type, index, 1));

      moves.append(up, down);
      row.append(enabled, main, quantity, moves);
      container.appendChild(row);
    });
  }

  function movePotion(type, index, direction) {
    const order = state.settings.potionOrder[type];
    const target = index + direction;
    if (!order || target < 0 || target >= order.length) return;

    [order[index], order[target]] = [order[target], order[index]];
    saveSettings();
    renderPotionLists();
  }

  async function startFarm(instanceId, locationId, resume = false) {
    if (!state.runState.stopped) return;

    readForm();
    if (!validateSettings()) return;

    // Der vorhandene Resume-Marker wurde jetzt verarbeitet.
    // Spätere Potion-Nutzungen erstellen bei Bedarf einen neuen.
    clearResumeState();

    const specificDamage = parseTarget(state.settings.specificDamage);
    const settings = {
      ...clone(state.settings),
      specificDamage: Number.isFinite(specificDamage) ? specificDamage : 0,
    };

    state.runState = { stopped: false };
    state.activeRun = { instanceId, locationId };
    updateButtons();
    keepRunningLogVisible(true);

    if (resume) addLog('Resumed after potion use or page reload.');

    try {
      await runFarm(instanceId, locationId, settings, state.runState, setStatus, newLogLine, addLog);
    } catch (error) {
      console.error('[DLF]', error);
      setStatus(`Error: ${error?.message || error}`, 'error');
      addLog(`Error: ${error?.message || error}`);
    } finally {
      state.runState.stopped = true;

      // Bei einem durch eine Potion ausgelösten Seitenwechsel
      // muss der Resume-Marker erhalten bleiben.
      if (!state.resumePending && !state.pageIsUnloading) {
        clearResumeState();
      }

      updateButtons();
      updateMetrics('');
    }
  }

  function stopFarm() {
    state.runState.stopped = true;
    clearResumeState();
    setStatus('Stopping...', 'idle');
    addLog('Manual stop requested.');
    updateButtons();
  }

  async function resumeAfterReload(instanceId, locationId) {
    if (!state.runState.stopped) return;

    const resume = loadResumeState();
    if (!resume) return;

    state.resumePending = true;
    state.pageIsUnloading = false;

    if (String(resume.instanceId) !== String(instanceId) || String(resume.locationId) !== String(locationId)) {
      clearResumeState();
      return;
    }

    state.overlay.style.display = 'flex';
    setStatus('Potion use completed. Resuming the location farmer...', 'running');
    await sleep(350);
    await startFarm(instanceId, locationId, true);
  }

  function bindUIEvents(instanceId, locationId) {
    state.ui.triggerButton.addEventListener('click', () => {
      state.overlay.style.display = 'flex';
      discoverPotions();
      renderPotionLists();
      updateMetrics();
    });

    state.ui.close.addEventListener('click', () => {
      if (!state.runState.stopped) return;
      state.overlay.style.display = 'none';
    });

    state.overlay.addEventListener('click', (event) => {
      if (event.target === state.overlay && state.runState.stopped) {
        state.overlay.style.display = 'none';
      }
    });

    state.ui.start.addEventListener('click', () => {
      void startFarm(instanceId, locationId, false);
    });

    state.ui.stop.addEventListener('click', stopFarm);

    state.overlay.querySelector('#dlfRefreshPotions').addEventListener('click', () => {
      discoverPotions();
      renderPotionLists();
      updateMetrics();
      setStatus('Potion list refreshed.', 'success');
    });

    for (const element of state.overlay.querySelectorAll('select, input')) {
      element.addEventListener('change', () => {
        readForm();
        const mode = state.settings.damageMode;
        state.ui.specificRow.style.display = mode === 'specific' ? 'flex' : 'none';
      });

      if (element.matches('input[type="text"], input[type="number"]')) {
        element.addEventListener('input', readForm);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    const potionChanged = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return target?.closest?.(
        '#battleDrawer, #ds-combat-potion-quick-use, .potion-card, .potion-qty-left, .ds-potion-count',
      );
    });

    if (potionChanged && state.overlay) {
      clearTimeout(state.potionRefreshTimer);
      state.potionRefreshTimer = setTimeout(() => {
        renderPotionLists();
        updateMetrics();
      }, 250);
    }

    const resourceChanged = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return target?.closest?.(`${SEL.stamina}, ${SEL.playerHp}, .playerhp`);
    });

    if (resourceChanged && state.overlay) updateMetrics();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  createUI();
})();
