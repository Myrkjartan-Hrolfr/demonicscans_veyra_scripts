'use strict';

// Monster Auto Battle: the combat loop. Ported from the standalone
// userscript v1.6.5; the decision logic (attack priority, stamina/mana
// fallbacks, poison attack, potion use, level-up protection, safety stops)
// is unchanged. Every stop now carries a machine-readable reason for the
// automation bridge:
//   'target' | 'defeated' | 'stopped' | 'no-stamina' | 'error'

const { sleep } = require('../../core/time');
const {
  calculateExperienceGain,
  classifyFeedback,
  formatNumber,
  getLogEntryPlayerName,
  isRateLimited,
  logEntryShowsActivePoison,
  normalizeText,
  parseFastAttackResponse,
  parseFraction,
  parseInteger,
  parseTarget,
  retryAfterToMs,
} = require('./mab-parse');
const { attackFromButton, attackSignature, findAttack, reconcileAttackKeys } = require('./mab-attacks');
const {
  collectPotions,
  pickPotion,
  potionFromButton,
  reconcilePotionSettings,
  usageAmount,
} = require('./mab-potions');
const { ID } = require('./mab-settings');

const MAX_RATE_RETRIES = 8;
const SEL = Object.freeze({
  monsterCard: '.battle-card.monster-card',
  attack: 'button.attack-btn',
  damage: '#yourDamageValue',
  monsterHp: '#hpText',
  stamina: '#stamina_span',
  playerHp: '#pHpText',
  playerMana: '#pManaText',
  exp: '.game-topbar .gtb-exp .gtb-exp-top span:last-child',
  potion: '.potion-use-btn',
  potionCard: '.potion-card',
  attackLog: '.panel.log-panel',
  playerName: '#sideDrawer .small-name, .side-drawer .small-name',
});

const FEEDBACK_SELECTORS = Object.freeze([
  '.toast',
  '.toast-message',
  '.notification',
  '.alert',
  '.message',
  '.swal2-popup',
  '.swal2-html-container',
  '[role="alert"]',
]);

const CONFIRM_SELECTORS = Object.freeze([
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
]);

const DIALOG_SELECTORS = Object.freeze([
  '.swal2-container',
  '.swal-overlay',
  '.modal.show',
  '[role="dialog"][aria-modal="true"]',
  '.dialog.open',
  '.popup.open',
  '.modal.active',
]);

const CONFIRM_TEXT = /^(confirm|yes|ok|okay|use|continue|accept|confirm use|use potion|confirm potion)$/i;

// Pure stop check run before every attack. Returns { message, tone, reason }
// or null to keep fighting.
function evaluateStopCondition({
  monsterDead,
  totalDamage,
  target,
  stopBeforeLevelUp,
  lastExperienceGain,
  levelMultiplier,
  remainingExperience,
}) {
  if (monsterDead) return { message: 'Monster defeated.', tone: 'success', reason: 'defeated' };
  if (target > 0 && Number.isFinite(totalDamage) && totalDamage >= target) {
    return {
      message: `Total monster damage target of ${formatNumber(target)} was reached.`,
      tone: 'success',
      reason: 'target',
    };
  }
  if (stopBeforeLevelUp && Number.isFinite(lastExperienceGain) && lastExperienceGain > 0) {
    if (!Number.isFinite(remainingExperience)) {
      return {
        message: 'Remaining EXP could not be read. Level-up protection stopped the script.',
        tone: 'error',
        reason: 'error',
      };
    }
    const threshold = lastExperienceGain * levelMultiplier;
    if (remainingExperience < threshold) {
      return {
        message:
          `Level-up protection: ${formatNumber(remainingExperience)} EXP remains. ` +
          `The last attack granted ${formatNumber(lastExperienceGain)} EXP, ` +
          `so the stop threshold is ${formatNumber(threshold)} EXP.`,
        tone: 'success',
        reason: 'stopped',
      };
    }
  }
  return null;
}

function noop() {}

// options: { doc, win, postForm, settingsStore, resumeStore, warn }
function createEngine(options) {
  const { doc, win, postForm, settingsStore, resumeStore } = options;
  const warn = options.warn || noop;

  const ui = {
    setStatus: noop,
    log: noop,
    renderAttackOptions: noop,
    renderPotionLists: noop,
    updateButtons: noop,
    updateMetrics: noop,
    readForm: noop,
  };
  const listeners = new Set();

  const state = {
    card: null,
    running: false,
    monsterKey: '',
    attacks: [],
    attackSignature: '',
    potions: [],
    settings: settingsStore.load(),
    sessionDamage: 0,
    lastDamage: 0,
    lastExperienceGain: null,
    noDamageCount: 0,
    forcedAttackIndex: 0,
    playerName: '',
    poisonActive: false,
    lastPlayerLogEntry: '',
    finished: false,
    reason: null,
    message: '',
  };

  const queryAll = (selector, root = doc) => {
    try {
      return root?.querySelectorAll ? [...root.querySelectorAll(selector)] : [];
    } catch {
      return [];
    }
  };
  const query = (selector, root = doc) => root?.querySelector?.(selector) || null;

  // ---- notifications ------------------------------------------------------

  function getState() {
    const target = parseTarget(state.settings.targetDamage);
    const hp = parseFraction((query(SEL.monsterHp, state.card) || query(SEL.monsterHp))?.textContent);
    return {
      running: state.running,
      finished: state.finished,
      reason: state.finished ? state.reason : null,
      yourDamage: readYourDamage(),
      targetDamage: Number.isFinite(target) && target > 0 ? target : 0,
      monsterHp: hp ? hp.current : null,
      message: state.message,
    };
  }

  function emit() {
    if (listeners.size === 0) return;
    const snapshot = getState();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        warn('A state listener failed.', error);
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return noop;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setStatus(message, tone = 'idle') {
    state.message = String(message);
    ui.setStatus(state.message, tone);
    emit();
  }

  function log(message) {
    ui.log(message);
  }

  function refreshMetrics() {
    ui.updateMetrics();
    emit();
  }

  function saveSettings() {
    settingsStore.save(state.settings);
  }

  // ---- page readers -------------------------------------------------------

  function getActivePlayerName() {
    return normalizeText(query(SEL.playerName)?.textContent);
  }

  function getAttackLogLines() {
    const panel = queryAll(SEL.attackLog).find((element) => /attack log/i.test(element.textContent || ''));
    if (!panel?.cloneNode) return [];
    const copy = panel.cloneNode(true);
    for (const breakElement of queryAll('br', copy)) breakElement.replaceWith('\n');
    return String(copy.textContent || '')
      .split(/\n+/)
      .map(normalizeText)
      .filter((line) => /^⚔️/.test(line));
  }

  function getLatestPlayerLogEntry() {
    const playerName = state.playerName || getActivePlayerName();
    if (!playerName) return '';
    const wanted = normalizeText(playerName).toLocaleLowerCase();
    return getAttackLogLines().find((line) => getLogEntryPlayerName(line).toLocaleLowerCase() === wanted) || '';
  }

  function announcePoisonChange() {
    log(
      state.poisonActive
        ? `Own poison detected for ${state.playerName}. Switching to the configured poison attack.`
        : 'Own poison is no longer reported. Returning to the normal attack priority.',
    );
  }

  function syncPoisonStatusFromLog(force = false) {
    const entry = getLatestPlayerLogEntry();
    if (!entry || (!force && entry === state.lastPlayerLogEntry)) return false;
    const wasActive = state.poisonActive;
    state.lastPlayerLogEntry = entry;
    state.poisonActive = logEntryShowsActivePoison(entry);
    if (state.running && wasActive !== state.poisonActive) announcePoisonChange();
    return true;
  }

  async function waitForPlayerLogUpdate(previousEntry, timeoutMs = 900) {
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < timeoutMs) {
      const currentEntry = getLatestPlayerLogEntry();
      if (currentEntry && currentEntry !== previousEntry) {
        syncPoisonStatusFromLog();
        return true;
      }
      await sleep(75);
    }
    return false;
  }

  function findMonsterCard() {
    return queryAll(SEL.monsterCard).find((card) => query(SEL.attack, card)) || null;
  }

  function getMonsterKey(card = state.card) {
    const title = query('.card-title', card)?.textContent?.trim() || 'monster';
    const image = query('#monsterImage, .monster_image', card)?.getAttribute?.('src') || '';
    let instance = '';
    try {
      instance = win?.AUTO_DIE_CFG?.nextDieMs ?? '';
    } catch {
      instance = '';
    }
    return [win?.location?.pathname || '', title, image, instance].join('|');
  }

  function getCurrentDamage() {
    return parseInteger(query(SEL.damage, state.card)?.textContent);
  }

  function readYourDamage() {
    const fromCard = getCurrentDamage();
    return Number.isFinite(fromCard) ? fromCard : parseInteger(query(SEL.damage)?.textContent);
  }

  function getCurrentStamina() {
    return parseInteger(query(SEL.stamina)?.textContent);
  }

  function getCurrentMana() {
    return parseFraction(query(SEL.playerMana)?.textContent)?.current ?? null;
  }

  function getCurrentHealth() {
    return parseFraction(query(SEL.playerHp)?.textContent)?.current ?? null;
  }

  function getResource(type) {
    if (type === 'stamina') return getCurrentStamina();
    if (type === 'mana') return getCurrentMana();
    return getCurrentHealth();
  }

  function getExperienceProgress() {
    const experience = parseFraction(query(SEL.exp)?.textContent);
    if (!experience) return null;
    return { ...experience, remaining: Math.max(0, experience.maximum - experience.current) };
  }

  function getRemainingExperience() {
    return getExperienceProgress()?.remaining ?? null;
  }

  async function waitForExperienceUpdate(before, timeoutMs = 3000) {
    if (!before) return null;
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < timeoutMs) {
      const current = getExperienceProgress();
      if (current && (current.current !== before.current || current.maximum !== before.maximum)) return current;
      await sleep(100);
    }
    return getExperienceProgress();
  }

  function isMonsterDead(card = state.card) {
    const health = parseFraction(query(SEL.monsterHp, card)?.textContent)?.current;
    return health === 0 || Boolean(card?.classList?.contains?.('dead'));
  }

  // ---- attacks ------------------------------------------------------------

  function discoverAttacks() {
    const attacks = state.card ? queryAll(SEL.attack, state.card).map(attackFromButton) : [];
    const signature = attackSignature(attacks);
    const changed = signature !== state.attackSignature;
    state.attackSignature = signature;
    state.attacks = attacks;
    reconcileAttackKeys(state.settings, attacks);
    saveSettings();
    return changed;
  }

  const getSelectedAttack = (index) => findAttack(state.attacks, state.settings.attackKeys[index]);
  const getSelectedPoisonAttack = () => findAttack(state.attacks, state.settings.poisonAttackKey);

  function findLiveAttackButton(key) {
    if (!state.card) return null;
    return queryAll(SEL.attack, state.card).find((button) => attackFromButton(button).key === key) || null;
  }

  function getFastAttackContext(button) {
    let params;
    try {
      params = new URLSearchParams(win?.location?.search || '');
    } catch {
      params = new URLSearchParams();
    }
    const hidden = (name) => query(`input[name="${name}"]`)?.value || '';
    const dgmid = params.get('dgmid') || button?.dataset?.dgmid || hidden('dgmid');
    const instanceId = params.get('instance_id') || button?.dataset?.instanceId || hidden('instance_id');
    if (!dgmid || !instanceId) return null;
    return { dgmid: String(dgmid), instanceId: String(instanceId) };
  }

  function setLiveText(selector, text) {
    const element = query(selector);
    if (element && text != null) element.textContent = String(text);
  }

  function applyFastAttackResult(result, beforeDamage) {
    let totalDamage = result.totalDamage;
    if (!Number.isFinite(totalDamage) && Number.isFinite(beforeDamage) && Number.isFinite(result.damage)) {
      totalDamage = beforeDamage + result.damage;
    }
    if (Number.isFinite(totalDamage)) {
      const damageElement = query(SEL.damage, state.card);
      if (damageElement) damageElement.textContent = formatNumber(totalDamage);
    }
    if (Number.isFinite(result.staminaAfter)) setLiveText(SEL.stamina, formatNumber(result.staminaAfter));
    if (Number.isFinite(result.userHpAfter)) {
      const element = query(SEL.playerHp);
      const health = parseFraction(element?.textContent);
      if (element && health) {
        element.textContent = `💚 ${formatNumber(result.userHpAfter)} / ${formatNumber(health.maximum)} HP`;
      }
    }
    if (Number.isFinite(result.manaAfter)) {
      const element = query(SEL.playerMana);
      const mana = parseFraction(element?.textContent);
      if (element && mana) {
        element.textContent = `💠 ${formatNumber(result.manaAfter)} / ${formatNumber(mana.maximum)} MP`;
      }
    }
  }

  async function fetchDashboardSnapshot() {
    try {
      const response = await win.fetch('/game_dash.php', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) return null;
      const html = await response.text();
      const snapshot = new win.DOMParser().parseFromString(html, 'text/html');
      // Copy the updated resource values into the visible battle page.
      for (const selector of [SEL.stamina, SEL.playerHp, SEL.playerMana, SEL.exp]) {
        const source = query(selector, snapshot);
        const target = query(selector);
        if (source && target) target.textContent = source.textContent;
      }
      const experience = parseFraction(query(SEL.exp, snapshot)?.textContent);
      return {
        experience: experience
          ? {
              current: experience.current,
              maximum: experience.maximum,
              remaining: Math.max(0, experience.maximum - experience.current),
            }
          : null,
      };
    } catch (error) {
      warn('Could not refresh dashboard values.', error);
      return null;
    }
  }

  function applyKnownExperienceGain(beforeExperience, experienceGain) {
    if (!beforeExperience || !Number.isFinite(experienceGain) || experienceGain <= 0) return null;
    const newCurrent = beforeExperience.current + experienceGain;
    // A level rollover needs the new maximum and cannot be synthesized.
    if (newCurrent >= beforeExperience.maximum) return null;
    const element = query(SEL.exp);
    if (element) element.textContent = `${formatNumber(newCurrent)} / ${formatNumber(beforeExperience.maximum)}`;
    return {
      current: newCurrent,
      maximum: beforeExperience.maximum,
      remaining: beforeExperience.maximum - newCurrent,
    };
  }

  async function refreshAfterFastAttack(beforeExperience, experienceGain) {
    let snapshot = await fetchDashboardSnapshot();
    let afterExperience = snapshot?.experience || null;
    const unchanged = (after) =>
      beforeExperience &&
      after &&
      after.current === beforeExperience.current &&
      after.maximum === beforeExperience.maximum;

    // The dashboard can lag a little; retry once while level-up protection
    // depends on it.
    if (state.settings.stopBeforeLevelUp && unchanged(afterExperience)) {
      await sleep(150);
      snapshot = await fetchDashboardSnapshot();
      afterExperience = snapshot?.experience || afterExperience;
    }
    if (!afterExperience || unchanged(afterExperience)) {
      afterExperience = applyKnownExperienceGain(beforeExperience, experienceGain) || afterExperience;
    }
    return afterExperience;
  }

  async function performFastAttack(attack, button, beforeDamage, beforeExperience) {
    const context = getFastAttackContext(button);
    // Battle pages without dgmid/instance_id use the button click instead.
    if (!context || attack.skillId === '') return { unsupported: true };

    const params = {
      instance_id: context.instanceId,
      dgmid: context.dgmid,
      skill_id: attack.skillId,
      stamina_cost: String(attack.costs.stamina),
    };
    const aborted = new Error('Monster Auto Battle stopped.');
    let lastRetryAfterMs = null;
    // Never sends a request once the run was stopped (also between the
    // rate-limit retries postForm performs itself).
    const guardedFetch = async (url, init) => {
      if (!state.running) throw aborted;
      const response = await win.fetch(url, init);
      lastRetryAfterMs = retryAfterToMs(response?.headers?.get?.('Retry-After'));
      return response;
    };

    let attempt = 0;
    while (attempt < MAX_RATE_RETRIES) {
      if (!state.running) return { type: 'timeout', mode: 'api' };

      let response;
      try {
        response = await postForm('/damage.php', params, {
          fetchImpl: guardedFetch,
          maxRetries: Math.max(0, MAX_RATE_RETRIES - 1 - attempt),
          onRateLimit: ({ waitMs }) => {
            attempt += 1;
            setStatus(`Rate limited. Retrying in ${Math.ceil(waitMs / 1000)} seconds...`, 'running');
          },
        });
      } catch (error) {
        if (error === aborted) return { type: 'timeout', mode: 'api' };
        warn('Fast attack request failed.', error);
        // No button click after a network error: the server may have
        // received the request although the response was lost.
        return { type: 'timeout', mode: 'api', message: String(error) };
      }
      attempt += 1;

      const result = parseFastAttackResponse(
        { ok: response.ok, status: response.status, retryAfterMs: lastRetryAfterMs },
        response.text,
      );

      if (isRateLimited(result)) {
        if (attempt >= MAX_RATE_RETRIES) break;
        const wait = result.retryAfterMs || Math.min(20000, 800 * 2 ** (attempt - 1));
        setStatus(`Rate limited. Retrying in ${Math.ceil(wait / 1000)} seconds...`, 'running');
        await sleep(wait);
        continue;
      }

      applyFastAttackResult(result, beforeDamage);
      const afterExperience = await refreshAfterFastAttack(beforeExperience, result.experienceGain);

      let damage = result.damage;
      if (!Number.isFinite(damage) && Number.isFinite(result.totalDamage) && Number.isFinite(beforeDamage)) {
        damage = Math.max(0, result.totalDamage - beforeDamage);
      }

      if (result.ok && Number.isFinite(damage) && damage > 0) {
        return {
          type: 'damage',
          mode: 'api',
          damage,
          totalDamage: result.totalDamage,
          experienceGain: result.experienceGain,
          afterExperience,
          monsterDead: result.monsterDead,
          poisonActive: result.poisonActive,
          message: result.message,
        };
      }
      if (result.monsterDead) {
        return { type: 'monster-dead', mode: 'api', afterExperience, message: result.message };
      }
      if (result.feedbackType) {
        return { type: result.feedbackType, mode: 'api', message: result.message, retryAfterMs: result.retryAfterMs };
      }
      return { type: 'timeout', mode: 'api', message: result.message };
    }

    return { type: 'cooldown', mode: 'api', retryAfterMs: 20000 };
  }

  function getFeedbackText() {
    return FEEDBACK_SELECTORS.flatMap((selector) => queryAll(selector))
      .filter((element) => !element.closest?.(`#${ID}`))
      .slice(-12)
      .map((element) => element.textContent?.trim())
      .filter(Boolean)
      .join(' | ')
      .toLowerCase();
  }

  async function waitForAttackOutcome(beforeDamage, beforeFeedback) {
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < 6500) {
      await sleep(110);
      const damage = getCurrentDamage();
      if (Number.isFinite(beforeDamage) && Number.isFinite(damage) && damage > beforeDamage) {
        return { type: 'damage', damage: damage - beforeDamage };
      }
      if (isMonsterDead()) return { type: 'monster-dead' };
      const feedback = getFeedbackText();
      if (feedback && feedback !== beforeFeedback) {
        const type = classifyFeedback(feedback);
        if (type) return { type };
      }
    }
    const finalFeedback = getFeedbackText();
    return {
      type: finalFeedback !== beforeFeedback ? classifyFeedback(finalFeedback) || 'timeout' : 'timeout',
    };
  }

  async function performAttack(attack, button, beforeDamage, beforeExperience, beforeFeedback) {
    const fastResult = await performFastAttack(attack, button, beforeDamage, beforeExperience);
    if (!fastResult.unsupported) return fastResult;
    // Battle modes without the direct /damage.php parameters.
    button.click();
    return waitForAttackOutcome(beforeDamage, beforeFeedback);
  }

  // ---- potions ------------------------------------------------------------

  function discoverPotions() {
    state.potions = collectPotions(queryAll(SEL.potion));
    reconcilePotionSettings(state.settings, state.potions);
    saveSettings();
  }

  function getPotionAmountInput(button) {
    return query('input[type="number"]', button?.closest?.('.potion-actions')) || null;
  }

  function findLivePotionButton(potion, amount = 1) {
    const matches = queryAll(SEL.potion).filter(
      (button) => potionFromButton(button).itemId === potion.itemId && !button.disabled,
    );
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
    try {
      const style = win.getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rectangle.width > 0 &&
        rectangle.height > 0
      );
    } catch {
      return false;
    }
  }

  function findPotionConfirmationButton() {
    for (const selector of CONFIRM_SELECTORS) {
      const button = queryAll(selector).find((element) => isElementVisible(element) && !element.disabled);
      if (button) return button;
    }
    for (const selector of DIALOG_SELECTORS) {
      for (const dialog of queryAll(selector)) {
        if (!isElementVisible(dialog)) continue;
        const button = queryAll('button, input[type="button"], input[type="submit"]', dialog).find((element) => {
          const text = String(element.textContent || element.value || element.getAttribute?.('aria-label') || '').trim();
          return !element.disabled && isElementVisible(element) && CONFIRM_TEXT.test(text);
        });
        if (button) return button;
      }
    }
    return null;
  }

  async function watchPotionConfirmation(timeoutMs = 6000) {
    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < timeoutMs) {
      const button = findPotionConfirmationButton();
      if (button) {
        log('Potion confirmation accepted automatically.');
        button.click();
        return true;
      }
      await sleep(75);
    }
    return false;
  }

  // The game asks for confirmation either with window.confirm() or with a
  // modal; both are accepted for the duration of this click.
  function clickPotionWithConfirmation(button) {
    let originalConfirm = null;
    let replaced = false;
    try {
      originalConfirm = win.confirm;
      win.confirm = (message) => {
        log(`Potion confirmation accepted: ${String(message || 'Confirm')}`);
        return true;
      };
      replaced = true;
    } catch (error) {
      warn('Could not override confirm().', error);
    }

    void watchPotionConfirmation();

    try {
      button.click();
    } finally {
      setTimeout(() => {
        if (!replaced) return;
        try {
          win.confirm = originalConfirm;
        } catch (error) {
          warn('Could not restore confirm().', error);
        }
      }, 1200);
    }
  }

  function saveResumeState() {
    if (!state.running) return;
    resumeStore.save({
      monsterKey: state.monsterKey || getMonsterKey(),
      sessionDamage: state.sessionDamage,
      lastDamage: state.lastDamage,
      lastExperienceGain: state.lastExperienceGain,
    });
  }

  async function usePotion(type) {
    discoverPotions();
    const potion = pickPotion(state.settings, state.potions, type);
    if (!potion) {
      setStatus(`No enabled ${type} potion is available.`, 'error');
      log(`No ${type} potion is available.`);
      return false;
    }

    const amount = usageAmount(state.settings, potion);
    const button = findLivePotionButton(potion, amount);
    if (!button) {
      setStatus(
        amount > 1 ? `${potion.name} has no editable amount field.` : `${potion.name} could not be found.`,
        'error',
      );
      return false;
    }

    const beforeQuantity = potion.quantity;
    const beforeResource = getResource(type);
    const input = getPotionAmountInput(button);
    if (amount > 1 && (!input || input.readOnly || input.disabled)) {
      setStatus(`Could not set the amount for ${potion.name}.`, 'error');
      return false;
    }
    if (input && !input.readOnly && !input.disabled) {
      input.value = String(amount);
      const EventCtor = win.Event || Event;
      input.dispatchEvent(new EventCtor('input', { bubbles: true }));
      input.dispatchEvent(new EventCtor('change', { bubbles: true }));
      await sleep(80);
    }

    log(
      amount > 1
        ? `Using ${formatNumber(amount)} × ${potion.name}. Stock before use: ${formatNumber(beforeQuantity)}.`
        : `Using ${potion.name}. Stock before use: ${formatNumber(beforeQuantity)}.`,
    );

    // Some potion uses reload the page; the run resumes from this state.
    saveResumeState();
    clickPotionWithConfirmation(button);

    const startedAt = Date.now();
    while (state.running && Date.now() - startedAt < 8000) {
      await sleep(120);
      discoverPotions();
      const refreshed = state.potions.find((item) => item.key === potion.key);
      const afterResource = getResource(type);
      const quantityChanged = refreshed && refreshed.quantity < beforeQuantity;
      const resourceChanged =
        Number.isFinite(beforeResource) && Number.isFinite(afterResource) && afterResource > beforeResource;
      if (quantityChanged || resourceChanged) {
        log(`${potion.name} was used successfully. Auto-battle will continue.`);
        ui.renderPotionLists();
        refreshMetrics();
        return true;
      }
    }

    resumeStore.clear();
    ui.renderPotionLists();
    log(`${potion.name} was clicked, but no resource or quantity change was detected.`);
    return false;
  }

  // ---- decisions ----------------------------------------------------------

  async function ensurePlayerIsAlive() {
    if (getCurrentHealth() !== 0) return true;
    if (!state.settings.autoHealth) {
      stop('Your health is 0 and automatic health potions are disabled.', 'idle', 'error');
      return false;
    }
    const used = await usePotion('health');
    if (!used) {
      stop('You are defeated and no enabled health potion is available.', 'error', 'error');
      return false;
    }
    await sleep(650);
    return true;
  }

  async function preparePoisonAttack(attack) {
    const stamina = getCurrentStamina();
    const mana = getCurrentMana();

    if (Number.isFinite(mana) && mana < attack.costs.mana) {
      if (!state.settings.autoMana) {
        stop(
          `The poison attack requires ${formatNumber(attack.costs.mana)} mana, but only ${formatNumber(mana)} is available.`,
          'idle',
          'error',
        );
        return null;
      }
      if (!(await usePotion('mana'))) {
        stop('The poison attack requires mana, but no enabled mana potion is available.', 'error', 'error');
        return null;
      }
      return { retry: true };
    }

    if (Number.isFinite(stamina) && stamina < attack.costs.stamina) {
      if (!state.settings.autoStamina) {
        stop(
          `The poison attack requires ${formatNumber(attack.costs.stamina)} stamina, but only ${formatNumber(stamina)} is available.`,
          'idle',
          'no-stamina',
        );
        return null;
      }
      if (!(await usePotion('stamina'))) {
        stop('The poison attack requires stamina, but no enabled stamina potion is available.', 'error', 'no-stamina');
        return null;
      }
      return { retry: true };
    }

    return { attack, index: -1, isPoisonAttack: true };
  }

  async function prepareNextAttack() {
    if (discoverAttacks()) ui.renderAttackOptions();
    syncPoisonStatusFromLog();

    const poisonAttack = getSelectedPoisonAttack();
    if (state.poisonActive && poisonAttack) return preparePoisonAttack(poisonAttack);

    const attacks = [getSelectedAttack(0), getSelectedAttack(1), getSelectedAttack(2)];
    const primary = attacks[0];
    if (!primary) {
      stop('Attack 1 is not available on the current monster card.', 'error', 'error');
      return null;
    }

    const stamina = getCurrentStamina();
    const mana = getCurrentMana();

    // Continue a stamina fallback chain started after a server error.
    if (state.forcedAttackIndex > 0) {
      let manaBlocked = false;
      for (let index = state.forcedAttackIndex; index < 3; index += 1) {
        const attack = attacks[index];
        if (!attack) continue;
        if (Number.isFinite(stamina) && stamina < attack.costs.stamina) continue;
        if (Number.isFinite(mana) && mana < attack.costs.mana) {
          manaBlocked = true;
          if (!state.settings.autoMana) continue;
          if (!(await usePotion('mana'))) {
            stop(`Attack ${index + 1} requires mana, but no mana potion is available.`, 'error', 'error');
            return null;
          }
          state.forcedAttackIndex = index;
          return { retry: true };
        }
        return { attack, index };
      }

      if (manaBlocked) {
        stop('A fallback attack requires more mana. Enable mana potions or select another attack.', 'idle', 'error');
        return null;
      }
      if (!state.settings.autoStamina) {
        stop(
          'Attack 2 and Attack 3 also require more stamina. Automatic stamina potions are disabled.',
          'idle',
          'no-stamina',
        );
        return null;
      }
      if (!(await usePotion('stamina'))) {
        stop('No enabled stamina potion is available.', 'error', 'no-stamina');
        return null;
      }
      state.forcedAttackIndex = 0;
      return { retry: true };
    }

    // Attack 1 has absolute priority: restore mana before switching away.
    if (Number.isFinite(mana) && mana < primary.costs.mana) {
      if (!state.settings.autoMana) {
        stop(
          `Attack 1 requires ${formatNumber(primary.costs.mana)} mana, but only ${formatNumber(mana)} is available.`,
          'idle',
          'error',
        );
        return null;
      }
      if (!(await usePotion('mana'))) {
        stop('Attack 1 requires mana, but no enabled mana potion is available.', 'error', 'error');
        return null;
      }
      return { retry: true };
    }

    if (!Number.isFinite(stamina) || stamina >= primary.costs.stamina) return { attack: primary, index: 0 };

    // Attack 1 lacks stamina: try Attack 2 and 3 while some stamina is left.
    let manaBlocked = false;
    if (stamina > 0) {
      for (let index = 1; index < 3; index += 1) {
        const attack = attacks[index];
        if (!attack || stamina < attack.costs.stamina) continue;
        if (Number.isFinite(mana) && mana < attack.costs.mana) {
          manaBlocked = true;
          if (!state.settings.autoMana) continue;
          if (!(await usePotion('mana'))) {
            stop(`Attack ${index + 1} requires mana, but no mana potion is available.`, 'error', 'error');
            return null;
          }
          state.forcedAttackIndex = index;
          return { retry: true };
        }
        log(`Attack 1 is too expensive. Using Attack ${index + 1}: ${attack.name}.`);
        return { attack, index };
      }
    }

    if (manaBlocked) {
      stop('A fallback attack has enough stamina but requires more mana.', 'idle', 'error');
      return null;
    }

    // A stamina potion only after all three selected attacks were rejected.
    if (!state.settings.autoStamina) {
      stop(`Current stamina (${formatNumber(stamina)}) is not enough for any selected attack.`, 'idle', 'no-stamina');
      return null;
    }
    if (!(await usePotion('stamina'))) {
      stop('Stamina is too low and no enabled stamina potion is available.', 'error', 'no-stamina');
      return null;
    }
    state.forcedAttackIndex = 0;
    return { retry: true };
  }

  async function useStaminaAfterFailure(noAutoMessage, noPotionMessage) {
    if (!state.settings.autoStamina) {
      stop(noAutoMessage, 'idle', 'no-stamina');
      return;
    }
    if (await usePotion('stamina')) {
      state.forcedAttackIndex = 0;
      await sleep(650);
    } else {
      stop(noPotionMessage, 'error', 'no-stamina');
    }
  }

  async function handleFailedAttack(outcome, prepared) {
    const attackIndex = prepared.index;
    const isPoisonAttack = prepared.isPoisonAttack === true;

    if (outcome.type === 'monster-dead') {
      stop('Monster defeated.', 'success', 'defeated');
      return;
    }

    if (outcome.type === 'dead') {
      if (!state.settings.autoHealth) {
        stop('You are defeated and automatic health potions are disabled.', 'idle', 'error');
        return;
      }
      if (!(await usePotion('health'))) stop('No enabled health potion is available.', 'error', 'error');
      return;
    }

    if (outcome.type === 'mana') {
      if (!state.settings.autoMana) {
        stop('Not enough mana and automatic mana potions are disabled.', 'idle', 'error');
        return;
      }
      if (await usePotion('mana')) {
        state.forcedAttackIndex = isPoisonAttack ? 0 : attackIndex;
        await sleep(650);
      } else {
        stop('No enabled mana potion is available.', 'error', 'error');
      }
      return;
    }

    if (outcome.type === 'stamina') {
      if (isPoisonAttack) {
        await useStaminaAfterFailure(
          'Not enough stamina for the poison attack and automatic stamina potions are disabled.',
          'No enabled stamina potion is available for the poison attack.',
        );
        return;
      }
      const nextAttack = attackIndex < 2 ? getSelectedAttack(attackIndex + 1) : null;
      if (getCurrentStamina() !== 0 && nextAttack) {
        state.forcedAttackIndex = attackIndex + 1;
        log(`Attack ${attackIndex + 1} failed because of stamina. Trying Attack ${attackIndex + 2}.`);
        return;
      }
      await useStaminaAfterFailure(
        'Not enough stamina and automatic stamina potions are disabled.',
        'No enabled stamina potion is available.',
      );
      return;
    }

    if (outcome.type === 'cooldown') {
      const wait = Math.max(outcome.retryAfterMs || 1600, state.settings.delayMs);
      log(`The server reported a cooldown. Waiting ${Math.ceil(wait / 1000)} seconds.`);
      await sleep(wait);
      return;
    }

    state.noDamageCount += 1;
    if (state.noDamageCount >= 2) {
      stop('No damage was detected twice. Safety stop activated.', 'error', 'error');
    } else {
      log('No damage was detected. One retry will be attempted.');
      await sleep(Math.max(1200, state.settings.delayMs));
    }
  }

  // ---- run / stop ---------------------------------------------------------

  // Returns an error message or '' when the settings allow a start.
  function validateSettings() {
    const target = parseTarget(state.settings.targetDamage);
    if (!Number.isFinite(target) || target < 0) return 'Invalid target damage. Examples: 5m, 5b, or 5,000,000.';
    if (!(state.settings.levelMultiplier > 0)) return 'The level-up multiplier must be greater than 0.';
    for (let index = 0; index < 3; index += 1) {
      const attack = getSelectedAttack(index);
      if (!attack || !findLiveAttackButton(attack.key)) return `Please select a valid Attack ${index + 1}.`;
    }
    if (state.settings.poisonAttackKey) {
      const poisonAttack = getSelectedPoisonAttack();
      if (!poisonAttack || !findLiveAttackButton(poisonAttack.key)) return 'Please select a valid poison attack.';
      if (!state.playerName) return 'The active player name could not be read from the side drawer.';
    }
    return '';
  }

  function currentStopCondition() {
    return evaluateStopCondition({
      monsterDead: isMonsterDead(),
      totalDamage: getCurrentDamage(),
      target: parseTarget(state.settings.targetDamage),
      stopBeforeLevelUp: state.settings.stopBeforeLevelUp,
      lastExperienceGain: state.lastExperienceGain,
      levelMultiplier: state.settings.levelMultiplier,
      remainingExperience: state.settings.stopBeforeLevelUp ? getRemainingExperience() : null,
    });
  }

  // Ends the run (or records why a run could not start).
  function stop(message = 'Stopped manually.', tone = 'idle', reason = 'stopped') {
    state.running = false;
    state.finished = true;
    state.reason = reason;
    resumeStore.clear();
    setStatus(message, tone);
    log(message);
    ui.updateButtons();
  }

  async function runAutoBattle(resumeData = null) {
    if (resumeData && typeof resumeData !== 'object') resumeData = null;
    if (resumeData && 'type' in resumeData && 'target' in resumeData) resumeData = null; // DOM event
    if (state.running) return;

    ui.readForm();
    discoverAttacks();
    discoverPotions();
    state.playerName = getActivePlayerName();
    state.lastPlayerLogEntry = '';
    state.poisonActive = false;
    syncPoisonStatusFromLog(true);
    ui.renderAttackOptions();
    ui.renderPotionLists();

    // A run that has nothing left to do finishes right away, even when the
    // attack selection would not validate (e.g. buttons of a dead monster).
    if (state.card) {
      const done = evaluateStopCondition({
        monsterDead: isMonsterDead(),
        totalDamage: getCurrentDamage(),
        target: parseTarget(state.settings.targetDamage),
      });
      if (done) {
        stop(done.message, done.tone, done.reason);
        return;
      }
    }

    const problem = state.card ? validateSettings() : 'No monster card with attack buttons was found.';
    if (problem) {
      state.finished = true;
      state.reason = 'error';
      setStatus(problem, 'error');
      return;
    }

    const currentMonsterKey = getMonsterKey();
    if (resumeData?.monsterKey && resumeData.monsterKey !== currentMonsterKey) {
      resumeStore.clear();
      state.finished = true;
      state.reason = 'error';
      setStatus('Auto-battle could not resume because the monster changed.', 'error');
      return;
    }
    state.monsterKey = currentMonsterKey;

    if (resumeData) {
      state.sessionDamage = Number(resumeData.sessionDamage) || 0;
      state.lastDamage = Number(resumeData.lastDamage) || 0;
      state.lastExperienceGain = resumeData.lastExperienceGain == null ? null : Number(resumeData.lastExperienceGain);
    } else {
      resumeStore.clear();
      state.sessionDamage = 0;
      state.lastDamage = 0;
      state.lastExperienceGain = null;
    }

    state.noDamageCount = 0;
    state.forcedAttackIndex = 0;
    state.finished = false;
    state.reason = null;
    state.running = true;

    ui.updateButtons();
    refreshMetrics();
    setStatus(resumeData ? 'Auto-battle resumed after potion use.' : 'Auto-battle is running.', 'running');
    log(`Started with ${formatNumber(getCurrentDamage() || 0)} damage already dealt.`);

    try {
      while (state.running) {
        if (!state.card?.isConnected || getMonsterKey() !== state.monsterKey) {
          // A card that vanished because the monster died is a defeat.
          if (isMonsterDead() || isMonsterDead(findMonsterCard()) || isMonsterDead(doc)) {
            stop('Monster defeated.', 'success', 'defeated');
          } else {
            stop('The monster card changed. Auto-battle was stopped.', 'idle', 'error');
          }
          break;
        }

        const condition = currentStopCondition();
        if (condition) {
          stop(condition.message, condition.tone, condition.reason);
          break;
        }

        if (!(await ensurePlayerIsAlive())) break;

        const prepared = await prepareNextAttack();
        if (!state.running || !prepared) break;
        if (prepared.retry) {
          await sleep(500);
          continue;
        }

        const button = findLiveAttackButton(prepared.attack.key);
        const attackLabel = prepared.isPoisonAttack ? 'Poison attack' : `Attack ${prepared.index + 1}`;
        if (!button) {
          stop(`${attackLabel} is no longer available.`, 'error', 'error');
          break;
        }

        if (button.disabled || button.getAttribute?.('aria-disabled') === 'true') {
          state.noDamageCount += 1;
          if (state.noDamageCount >= 3) {
            stop('The selected attack button remained disabled.', 'error', 'error');
            break;
          }
          await sleep(Math.max(1200, state.settings.delayMs));
          continue;
        }

        const beforeDamage = getCurrentDamage();
        const beforeExperience = getExperienceProgress();
        const beforeFeedback = getFeedbackText();
        const beforePlayerLogEntry = getLatestPlayerLogEntry();

        log(`${attackLabel}: ${prepared.attack.name}.`);
        const outcome = await performAttack(prepared.attack, button, beforeDamage, beforeExperience, beforeFeedback);
        if (!state.running) break;

        if (outcome.type === 'damage') {
          resumeStore.clear();
          state.noDamageCount = 0;
          state.forcedAttackIndex = 0;
          state.lastDamage = Math.max(0, outcome.damage || 0);
          state.sessionDamage += state.lastDamage;

          if (outcome.mode === 'api') {
            const wasPoisonActive = state.poisonActive;
            state.poisonActive = outcome.poisonActive === true;
            if (wasPoisonActive !== state.poisonActive) announcePoisonChange();
          } else {
            await waitForPlayerLogUpdate(beforePlayerLogEntry);
          }

          const afterExperience =
            outcome.mode === 'api' ? outcome.afterExperience : await waitForExperienceUpdate(beforeExperience);
          const calculatedGain = calculateExperienceGain(beforeExperience, afterExperience);
          state.lastExperienceGain =
            Number.isFinite(outcome.experienceGain) && outcome.experienceGain > 0
              ? outcome.experienceGain
              : Number.isFinite(calculatedGain) && calculatedGain > 0
                ? calculatedGain
                : null;

          if (Number.isFinite(state.lastExperienceGain)) {
            log(
              `Hit dealt ${formatNumber(state.lastDamage)} damage and granted ` +
                `${formatNumber(state.lastExperienceGain)} EXP.`,
            );
          } else if (state.settings.stopBeforeLevelUp) {
            stop(
              'The EXP gain from the last attack could not be determined. Level-up protection stopped the script.',
              'error',
              'error',
            );
            break;
          }

          refreshMetrics();
          if (outcome.monsterDead) {
            stop('Monster defeated.', 'success', 'defeated');
            break;
          }
        } else {
          await handleFailedAttack(outcome, prepared);
        }

        if (state.running) await sleep(Math.max(0, state.settings.delayMs));
      }
    } catch (error) {
      warn('Auto-battle failed.', error);
      stop(`Error: ${error?.message || error}`, 'error', 'error');
    } finally {
      state.running = false;
      if (!state.finished) {
        state.finished = true;
        state.reason = 'error';
      }
      ui.updateButtons();
      refreshMetrics();
    }
  }

  // Starts a run unless one is active. Resolves when the run ends.
  function start(resumeData = null) {
    return runAutoBattle(resumeData);
  }

  // Called after a reload during potion use.
  async function resumeAfterReload() {
    if (state.running || !state.card) return;
    const resumeData = resumeStore.load();
    if (!resumeData) return;
    if (resumeData.monsterKey !== getMonsterKey()) {
      resumeStore.clear();
      setStatus('Auto-battle was not resumed because the monster changed.');
      return;
    }
    setStatus('Potion use completed. Resuming auto-battle...', 'running');
    await sleep(500);
    if (!state.running) void runAutoBattle(resumeData);
  }

  function setCard(card) {
    state.card = card;
    state.attackSignature = '';
  }

  return {
    SEL,
    state,
    ui,
    discoverAttacks,
    discoverPotions,
    findMonsterCard,
    getCurrentDamage,
    getCurrentHealth,
    getCurrentMana,
    getCurrentStamina,
    getMonsterKey,
    getRemainingExperience,
    getState,
    refreshMetrics,
    resumeAfterReload,
    saveSettings,
    setCard,
    setStatus,
    log,
    start,
    stop,
    subscribe,
  };
}

module.exports = {
  MAX_RATE_RETRIES,
  SEL,
  createEngine,
  evaluateStopCondition,
};
