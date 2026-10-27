// ==UserScript==
// @name         Veyra - Wave 3 Boss Manager
// @namespace    local.veyra.wave-3-boss-manager
// @version      1.0.0
// @description  Checks Grakthar Wave 3 bosses and delegates each fight to Monster Auto Battle.
// @match        https://demonicscans.org/active_wave.php*
// @match        https://demonicscans.org/battle.php*
// @match        https://www.demonicscans.org/active_wave.php*
// @match        https://www.demonicscans.org/battle.php*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const COMMAND_KEY = 'veyra:orchestrator:command:v1';
  const STATUS_KEY = 'veyra:worker:wave3:status:v1';
  const WORKER_ID = 'wave3';

  const BOSS_CONFIG = Object.freeze({
    storageKey: 'veyra:wave3:run:v1',
    ownerStorageKey: 'veyra:wave3:owner:v1',
    stateVersion: 1,
    scanIntervalMs: 200,
    scanDebounceMs: 40,
    leaseMs: 5 * 60_000,
    leaseRenewWindowMs: 60_000,
    actionRetryMs: 5_000,
    actionTimeoutMs: 30_000,
    hubSettleMs: 1_000,
    hubEmptyWaitMs: 30_000,
    cycleTimeoutMs: 2 * 60 * 60 * 1000,
    maxActionAttempts: 3,
    wavePath: '/active_wave.php?gate=3&wave=8',
    targetDamage: '3b',
    targetDamageValue: 3_000_000_000,
  });

  const BOSS_PHASES = Object.freeze({
    idle: 'idle',
    checking: 'checking',
    joining: 'joining',
    entering: 'entering',
    attacking: 'attacking',
    returningHub: 'returningHub',
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function parseInteger(value) {
    const match = String(value ?? '').match(/-?\d[\d.,\s]*/);
    if (!match) return null;
    const number = Number.parseInt(match[0].replace(/\D/g, ''), 10);
    if (!Number.isFinite(number)) return null;
    return match[0].trim().startsWith('-') ? -number : number;
  }

  function parseGameNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const match = String(value ?? '').match(/(-?[\d.,]+(?:\s[\d.,]+)*)\s*([kmbtq])?/i);
    if (!match) return null;

    const suffix = String(match[2] || '').toLowerCase();
    if (!suffix) return parseInteger(match[1]);

    let numberText = match[1].replace(/\s/g, '');
    if (numberText.includes('.') && numberText.includes(',')) {
      const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';
      const thousands = decimal === ',' ? '.' : ',';
      numberText = numberText.split(thousands).join('').replace(decimal, '.');
    } else {
      numberText = numberText.replace(',', '.');
    }

    const number = Number.parseFloat(numberText);
    const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }[suffix];
    return Number.isFinite(number) ? Math.round(number * multiplier) : null;
  }

  function normalizeComparableText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function createDefaultBossCycleState(now = Date.now()) {
    return {
      version: BOSS_CONFIG.stateVersion,
      active: false,
      visitId: '',
      phase: BOSS_PHASES.idle,
      cycleStartedAt: 0,
      phaseUpdatedAt: now,
      targetBossId: '',
      processedBossIds: [],
      failedBossIds: [],
      ownerId: '',
      leaseUntil: 0,
      actionKind: '',
      actionAt: 0,
      actionAttempts: 0,
      startIssued: false,
      lastError: '',
    };
  }

  function normalizeBossIdList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  function normalizeBossCycleState(value, now = Date.now()) {
    const defaults = createDefaultBossCycleState(now);
    if (!value || typeof value !== 'object' || value.version !== BOSS_CONFIG.stateVersion) {
      return defaults;
    }

    const phases = new Set(Object.values(BOSS_PHASES));
    const active = value.active === true;
    const phase = phases.has(value.phase) ? value.phase : active ? BOSS_PHASES.checking : BOSS_PHASES.idle;
    const numberOr = (candidate, fallback) => {
      const number = Number(candidate);
      return Number.isFinite(number) && number >= 0 ? number : fallback;
    };

    return {
      version: BOSS_CONFIG.stateVersion,
      active,
      visitId: String(value.visitId || ''),
      phase: active ? phase : BOSS_PHASES.idle,
      cycleStartedAt: numberOr(value.cycleStartedAt, 0),
      phaseUpdatedAt: numberOr(value.phaseUpdatedAt, now),
      targetBossId: String(value.targetBossId || ''),
      processedBossIds: normalizeBossIdList(value.processedBossIds),
      failedBossIds: normalizeBossIdList(value.failedBossIds),
      ownerId: String(value.ownerId || ''),
      leaseUntil: numberOr(value.leaseUntil, 0),
      actionKind: String(value.actionKind || ''),
      actionAt: numberOr(value.actionAt, 0),
      actionAttempts: Math.max(0, Math.floor(numberOr(value.actionAttempts, 0))),
      startIssued: value.startIssued === true,
      lastError: String(value.lastError || ''),
    };
  }

  function isUntouchedActiveBossData(dataset) {
    if (!dataset) return false;
    return (
      String(dataset.boss || '') === '1' &&
      String(dataset.dead || '') === '0' &&
      parseGameNumber(dataset.userdmg) === 0 &&
      Boolean(String(dataset.monsterId || '').trim())
    );
  }

  function isAliveBossData(dataset) {
    return Boolean(
      dataset &&
        String(dataset.boss || '') === '1' &&
        String(dataset.dead || '') === '0' &&
        String(dataset.monsterId || '').trim(),
    );
  }

  function isFightableBossData(dataset) {
    if (!isAliveBossData(dataset)) return false;
    const joined = String(dataset.joined || '');
    const damage = parseGameNumber(dataset.userdmg);
    return joined === '0' || !Number.isFinite(damage) || damage < BOSS_CONFIG.targetDamageValue;
  }

  function monsterAutoBattleCompletionReason({ statusText, damageText, hpText }) {
    const status = normalizeComparableText(statusText);
    const damage = parseGameNumber(damageText);
    const hp = String(hpText || '').trim();

    if (Number.isFinite(damage) && damage >= BOSS_CONFIG.targetDamageValue) return 'target';
    if (/(?:^|[^\d])0(?:[.,]0+)?\s*\//.test(hp) || /monster defeated/.test(status)) {
      return 'defeated';
    }
    return null;
  }

  function isMonsterAutoBattleSuccess(snapshot) {
    return monsterAutoBattleCompletionReason(snapshot) !== null;
  }

  function isMonsterAutoBattleFailure(statusText) {
    const status = normalizeComparableText(statusText);
    if (!status || isMonsterAutoBattleSuccess({ statusText })) return false;
    return /invalid|please select|not available|could not|not enough|safety stop|level-up protection|no enabled|requires .*potion|error|stopped manually|remained disabled/.test(
      status,
    );
  }

  const testExports = Object.freeze({
    BOSS_CONFIG,
    BOSS_PHASES,
    COMMAND_KEY,
    STATUS_KEY,
    createDefaultBossCycleState,
    isAliveBossData,
    isFightableBossData,
    isMonsterAutoBattleFailure,
    isMonsterAutoBattleSuccess,
    isUntouchedActiveBossData,
    monsterAutoBattleCompletionReason,
    normalizeBossCycleState,
    parseGameNumber,
    parseInteger,
  });

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = testExports;
    return;
  }

  const SELECTORS = Object.freeze({
    bossContainer: '.monster-container',
    bossCard: '.monster-card[data-boss][data-dead][data-monster-id]',
    monsterCard: '.monster-card[data-dead][data-monster-id]',
    activeAutoSummonBossLink: '.auto-summon-card[data-alive="1"] a[href*="battle.php"]',
    monsterAutoPanel: '#tm-monster-auto-battle',
    monsterAutoTarget: '#mabTarget',
    monsterAutoStart: '#mabStart',
    monsterAutoStop: '#mabStop',
    monsterAutoStatus: '#mabStatus',
    monsterDamage: '#yourDamageValue',
    monsterHp: '#hpText',
    monsterJoin: '#join-battle',
    playerHp: '#pHpText',
    healPotion: '#usePotionBtn',
  });

  const runtime = {
    scanRunning: false,
    scanTimer: null,
    interval: null,
    observer: null,
    statusKey: '',
    statusSignature: '',
    statusPublishedAt: 0,
    bossStorage: null,
    bossOwnerId: '',
    bossOwnerRestored: false,
    bossNavigationPending: false,
    bossActionPending: false,
    bossSuspendedAt: 0,
    bossEmptySince: 0,
    activeVisitId: '',
    finishedVisitId: '',
    finishedVisitState: '',
    finishedMessage: '',
    manualScanStarted: false,
    stopped: false,
  };

  function report(message, level = 'info') {
    const key = `${level}:${message}`;
    if (runtime.statusKey === key) return;
    runtime.statusKey = key;
    console[level === 'error' ? 'warn' : 'info'](`[Wave 3 Boss Manager] ${message}`);
  }

  function getBrowserStorage(name) {
    try {
      return window[name] || null;
    } catch (error) {
      console.warn(`[Wave 3 Boss Manager] ${name} is unavailable:`, error);
      return null;
    }
  }

  function parseStoredJson(storage, key) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn(`[Wave 3 Boss Manager] Could not read ${key}.`, error);
      return null;
    }
  }

  function loadOrchestratorCommand() {
    const value = parseStoredJson(runtime.bossStorage, COMMAND_KEY);
    if (!value || typeof value !== 'object' || Number(value.version) !== 1) return null;
    return {
      ...value,
      taskId: String(value.taskId || ''),
      visitId: String(value.visitId || ''),
      phase: String(value.phase || value.state || value.status || ''),
    };
  }

  function loadPublishedWorkerStatus() {
    const value = parseStoredJson(runtime.bossStorage, STATUS_KEY);
    if (!value || typeof value !== 'object' || Number(value.version) !== 1) return null;
    return {
      ...value,
      workerId: String(value.workerId || ''),
      visitId: String(value.visitId || ''),
      state: String(value.state || ''),
      message: String(value.message || ''),
    };
  }

  function matchingRunningCommand() {
    const command = loadOrchestratorCommand();
    return command?.taskId === WORKER_ID && command.phase === 'running' && command.visitId
      ? command
      : null;
  }

  function hasBlockingOrchestratorCommand() {
    // A command for another worker, or a Wave 3 command that is still
    // draining, belongs to the orchestrator. It must never be mistaken for a
    // command-free manual visit during the navigation hand-off window.
    return Boolean(loadOrchestratorCommand());
  }

  function publishWorkerStatus(state, safeToLeave, message = '', visitId = runtime.activeVisitId) {
    if (!runtime.bossStorage) return null;
    const now = Date.now();
    const status = {
      version: 1,
      workerId: WORKER_ID,
      visitId: String(visitId || ''),
      state,
      safeToLeave: safeToLeave === true,
      updatedAt: now,
      message: String(message || ''),
    };
    const signature = JSON.stringify({ ...status, updatedAt: 0 });
    // The orchestrator treats old worker states as stale. Re-publish an
    // otherwise unchanged busy/idle state as a heartbeat at least every 5s.
    if (runtime.statusSignature === signature && now - runtime.statusPublishedAt < 5_000) {
      return status;
    }
    try {
      runtime.bossStorage.setItem(STATUS_KEY, JSON.stringify(status));
      runtime.statusSignature = signature;
      runtime.statusPublishedAt = now;
      return status;
    } catch (error) {
      console.warn('[Wave 3 Boss Manager] Could not publish worker status.', error);
      return null;
    }
  }

  function getBossOwnerId() {
    const storage = getBrowserStorage('sessionStorage');
    if (!storage) return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const saved = storage.getItem(BOSS_CONFIG.ownerStorageKey);
      if (saved) {
        runtime.bossOwnerRestored = true;
        return saved;
      }
      const ownerId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      storage.setItem(BOSS_CONFIG.ownerStorageKey, ownerId);
      return ownerId;
    } catch (error) {
      console.warn('[Wave 3 Boss Manager] Could not initialize the run owner.', error);
      return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  runtime.bossStorage = getBrowserStorage('localStorage');
  runtime.bossOwnerId = getBossOwnerId();

  function saveBossCycleState(value, now = Date.now()) {
    if (!runtime.bossStorage) return null;
    const state = normalizeBossCycleState(value, now);
    try {
      runtime.bossStorage.setItem(BOSS_CONFIG.storageKey, JSON.stringify(state));
      return state;
    } catch (error) {
      console.warn('[Wave 3 Boss Manager] Could not save the private run.', error);
      return null;
    }
  }

  function loadBossCycleState(now = Date.now()) {
    if (!runtime.bossStorage) return null;
    try {
      const raw = runtime.bossStorage.getItem(BOSS_CONFIG.storageKey);
      if (!raw) return saveBossCycleState(createDefaultBossCycleState(now), now);
      return normalizeBossCycleState(JSON.parse(raw), now);
    } catch (error) {
      console.warn('[Wave 3 Boss Manager] Resetting an invalid private run.', error);
      return saveBossCycleState(createDefaultBossCycleState(now), now);
    }
  }

  function patchBossCycleState(state, patch, now = Date.now()) {
    const phaseChanged = patch.phase !== undefined && patch.phase !== state.phase;
    return saveBossCycleState(
      {
        ...state,
        ...patch,
        phaseUpdatedAt: phaseChanged ? now : (patch.phaseUpdatedAt ?? state.phaseUpdatedAt),
      },
      now,
    );
  }

  function claimBossCycleLease(state, now = Date.now()) {
    if (!state) return null;
    const heldByOther = state.ownerId && state.ownerId !== runtime.bossOwnerId && state.leaseUntil > now;
    if (heldByOther) return null;
    const claimed = saveBossCycleState(
      { ...state, ownerId: runtime.bossOwnerId, leaseUntil: now + BOSS_CONFIG.leaseMs },
      now,
    );
    if (!claimed) return null;
    const verified = loadBossCycleState(now);
    return verified?.ownerId === runtime.bossOwnerId ? verified : null;
  }

  function renewBossCycleLease(state, now = Date.now()) {
    if (
      state?.active &&
      state.ownerId &&
      state.ownerId !== runtime.bossOwnerId &&
      state.leaseUntil > now &&
      !runtime.bossOwnerRestored &&
      (isBossHubPage() || isMonsterBattlePage())
    ) {
      runtime.bossOwnerId = state.ownerId;
      runtime.bossOwnerRestored = true;
      try {
        getBrowserStorage('sessionStorage')?.setItem(BOSS_CONFIG.ownerStorageKey, state.ownerId);
      } catch (error) {
        console.warn('[Wave 3 Boss Manager] Could not restore the mobile run owner.', error);
      }
    }

    if (!state || state.ownerId !== runtime.bossOwnerId) return claimBossCycleLease(state, now);
    if (state.leaseUntil - now > BOSS_CONFIG.leaseRenewWindowMs) return state;
    return patchBossCycleState(state, { leaseUntil: now + BOSS_CONFIG.leaseMs }, now);
  }

  function isBossCycleStale(state, now = Date.now()) {
    return Boolean(
      state?.active &&
        state.cycleStartedAt > 0 &&
        now - state.cycleStartedAt > BOSS_CONFIG.cycleTimeoutMs,
    );
  }

  function currentUrl() {
    try {
      return new URL(window.location.href, window.location.origin);
    } catch {
      return new URL(window.location.origin);
    }
  }

  function isBossHubPage() {
    const url = currentUrl();
    return (
      /\/active_wave\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('gate') === '3' &&
      url.searchParams.get('wave') === '8'
    );
  }

  function isMonsterBattlePage() {
    return /\/battle\.php\/?$/i.test(currentUrl().pathname);
  }

  function visitIdForNavigation() {
    return (
      currentUrl().searchParams.get('veyra_visit') ||
      runtime.activeVisitId ||
      loadBossCycleState()?.visitId ||
      ''
    );
  }

  function withVisitQuery(path) {
    const url = new URL(path, window.location.origin);
    const visitId = visitIdForNavigation();
    if (visitId && !url.searchParams.has('veyra_visit')) {
      url.searchParams.set('veyra_visit', visitId);
    }
    return url;
  }

  function navigateTo(path) {
    if (runtime.bossNavigationPending) return;
    runtime.bossNavigationPending = true;
    window.location.replace(withVisitQuery(path).href);
  }

  function getCookieValue(name) {
    try {
      const prefix = `${name}=`;
      const entry = String(document.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix));
      return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
    } catch (error) {
      console.warn(`[Wave 3 Boss Manager] Could not read the ${name} cookie.`, error);
      return null;
    }
  }

  function setCookieValue(name, value, days = 30) {
    try {
      const maxAge = days * 24 * 60 * 60;
      document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
      return true;
    } catch (error) {
      console.warn(`[Wave 3 Boss Manager] Could not set the ${name} cookie.`, error);
      return false;
    }
  }

  function getBattleMonsterId() {
    const url = currentUrl();
    const urlId = String(url.searchParams.get('id') || url.searchParams.get('monster_id') || '').trim();
    const cardId = document.querySelector('.battle-card.monster-card[data-monster-id]')?.dataset?.monsterId;
    const inputId = document.querySelector('input[name="monster_id"], #monster_id')?.value;
    const ids = [urlId, cardId, inputId]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (ids.length === 0) return '';
    return new Set(ids).size === 1 ? ids[0] : '';
  }

  function startBossCycleIfNeeded(now = Date.now()) {
    let state = loadBossCycleState(now);
    if (!state) return null;

    const command = matchingRunningCommand();
    if (state.active) {
      // Any active run consumes this page load's one-shot scan. Otherwise an
      // orchestrated run could finish, have its command cleared, and then
      // immediately start an unintended standalone scan on the same page.
      runtime.manualScanStarted = true;
      runtime.activeVisitId = state.visitId || command?.visitId || '';
      if (!state.visitId && command?.visitId) {
        state = patchBossCycleState(state, { visitId: command.visitId }, now);
        runtime.activeVisitId = command.visitId;
      }
      publishWorkerStatus('busy', false, 'Wave 3 boss scan is running.', runtime.activeVisitId);
      return state;
    }

    if (!isBossHubPage()) return state;

    if (command) {
      const published = loadPublishedWorkerStatus();
      if (
        published?.workerId === WORKER_ID &&
        published.visitId === command.visitId &&
        (published.state === 'done' || published.state === 'error')
      ) {
        runtime.finishedVisitId = command.visitId;
        runtime.finishedVisitState = published.state;
        runtime.finishedMessage = published.message;
        publishWorkerStatus(published.state, true, published.message, command.visitId);
        return state;
      }
      if (runtime.finishedVisitId === command.visitId) {
        publishWorkerStatus(
          runtime.finishedVisitState || 'done',
          true,
          runtime.finishedMessage || 'Wave 3 boss scan is complete.',
          command.visitId,
        );
        return state;
      }
      runtime.manualScanStarted = true;
      runtime.activeVisitId = command.visitId;
    } else {
      if (runtime.finishedVisitState) {
        publishWorkerStatus(
          runtime.finishedVisitState,
          true,
          runtime.finishedMessage,
          runtime.finishedVisitId,
        );
        return state;
      }
      if (hasBlockingOrchestratorCommand() || runtime.manualScanStarted) {
        publishWorkerStatus('idle', true, 'Wave 3 is idle.', '');
        return state;
      }
      runtime.manualScanStarted = true;
      runtime.activeVisitId = '';
    }

    runtime.finishedVisitId = '';
    runtime.finishedVisitState = '';
    runtime.finishedMessage = '';

    state = saveBossCycleState(
      {
        ...createDefaultBossCycleState(now),
        active: true,
        visitId: runtime.activeVisitId,
        phase: BOSS_PHASES.checking,
        cycleStartedAt: now,
        phaseUpdatedAt: now,
        ownerId: runtime.bossOwnerId,
        leaseUntil: now + BOSS_CONFIG.leaseMs,
      },
      now,
    );
    publishWorkerStatus('busy', false, 'Wave 3 boss scan started.', runtime.activeVisitId);
    return state;
  }

  function ensureAliveMonsterWaveFilter(state, now = Date.now()) {
    if (runtime.bossNavigationPending) return null;
    const url = currentUrl();
    const hideDeadMonsters = getCookieValue('hide_dead_monsters');
    const showDeadBossesOnly = getCookieValue('show_dead_bosses_only');
    const deadPageSelected = url.searchParams.has('dead_page');
    const filterIsCorrect =
      hideDeadMonsters === '1' && showDeadBossesOnly === '0' && !deadPageSelected;

    if (filterIsCorrect) {
      if (state.actionKind !== 'wave-filter') return state;
      return patchBossCycleState(
        state,
        {
          phase: BOSS_PHASES.checking,
          phaseUpdatedAt: now,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          lastError: '',
        },
        now,
      );
    }

    const attempts = state.actionKind === 'wave-filter' ? state.actionAttempts + 1 : 1;
    if (state.actionKind === 'wave-filter' && now - state.actionAt < BOSS_CONFIG.actionRetryMs) {
      report('Waiting for the Wave 3 alive-monsters filter to be applied.');
      return null;
    }

    if (attempts > BOSS_CONFIG.maxActionAttempts) {
      failBossCycle(state, 'The Wave 3 alive-monsters filter could not be saved.');
      return null;
    }

    patchBossCycleState(
      state,
      {
        phase: BOSS_PHASES.checking,
        phaseUpdatedAt: now,
        actionKind: 'wave-filter',
        actionAt: now,
        actionAttempts: attempts,
        lastError: '',
      },
      now,
    );

    const hideDeadSaved = setCookieValue('hide_dead_monsters', '1');
    const deadBossFilterSaved = setCookieValue('show_dead_bosses_only', '0');
    const cookiesVerified =
      getCookieValue('hide_dead_monsters') === '1' &&
      getCookieValue('show_dead_bosses_only') === '0';
    if (!hideDeadSaved || !deadBossFilterSaved || !cookiesVerified) {
      report('The Wave 3 alive-monsters filter has not been accepted yet.', 'error');
      return null;
    }

    url.searchParams.delete('dead_page');
    report('Switching Wave 3 to the alive-monsters view before checking bosses.');
    navigateTo(`${url.pathname}${url.search}${url.hash}`);
    return null;
  }

  function isPageHidden() {
    return document.hidden === true || document.visibilityState === 'hidden';
  }

  function refreshBossCycleAfterMobileResume() {
    const now = Date.now();
    let state = loadBossCycleState(now);
    if (!state?.active) return;
    state = renewBossCycleLease(state, now);
    if (!state || state.ownerId !== runtime.bossOwnerId) return;
    patchBossCycleState(
      state,
      {
        phaseUpdatedAt: now,
        actionAt: state.actionAt > 0 ? now : 0,
        leaseUntil: now + BOSS_CONFIG.leaseMs,
      },
      now,
    );
  }

  function handleVisibilityChange() {
    if (isPageHidden()) {
      runtime.bossSuspendedAt = Date.now();
      return;
    }
    if (runtime.bossSuspendedAt > 0) {
      window.clearTimeout(runtime.scanTimer);
      runtime.scanTimer = null;
      runtime.bossActionPending = false;
      refreshBossCycleAfterMobileResume();
      runtime.bossSuspendedAt = 0;
    }
    scheduleScan();
  }

  function finishBossCycle(state, message = '') {
    const now = Date.now();
    const failures = state?.failedBossIds?.length || 0;
    const visitId = String(state?.visitId || runtime.activeVisitId || '');
    const completionMessage =
      message ||
      (failures > 0
        ? `Boss scan finished with ${failures} incomplete fight(s).`
        : 'Wave 3 boss scan finished.');

    saveBossCycleState(createDefaultBossCycleState(now), now);
    runtime.finishedVisitId = visitId;
    runtime.finishedVisitState = 'done';
    runtime.finishedMessage = completionMessage;
    runtime.activeVisitId = '';
    publishWorkerStatus('done', true, completionMessage, visitId);
    report(completionMessage, failures > 0 ? 'error' : 'info');
  }

  function failBossCycle(state, message) {
    const now = Date.now();
    const visitId = String(state?.visitId || runtime.activeVisitId || '');
    const next = createDefaultBossCycleState(now);
    next.lastError = String(message || 'Wave 3 boss scan failed.');
    saveBossCycleState(next, now);
    runtime.finishedVisitId = visitId;
    runtime.finishedVisitState = 'error';
    runtime.finishedMessage = next.lastError;
    runtime.activeVisitId = '';
    publishWorkerStatus('error', true, next.lastError, visitId);
    report(next.lastError, 'error');
  }

  function controlText(control) {
    return normalizeComparableText(
      control?.value || control?.textContent || control?.getAttribute?.('aria-label'),
    );
  }

  function findTextControl(root, acceptedTexts) {
    const accepted = new Set(acceptedTexts.map(normalizeComparableText));
    return (
      Array.from(
        root?.querySelectorAll?.('button, a, input[type="button"], input[type="submit"]') || [],
      ).find((control) => {
        const text = controlText(control);
        return accepted.has(text) || [...accepted].some((candidate) => text.endsWith(` ${candidate}`));
      }) || null
    );
  }

  function findJoinBossControl(card) {
    const control = findTextControl(card, ['join', 'join battle', 'join the battle']);
    if (control && !controlText(control).includes('quick join')) return control;
    return card?.querySelector?.('button.join-btn') || null;
  }

  function findEnterBattleControl(root, allowBattleLink = false) {
    const exact = findTextControl(root, ['enter battle', 'continue battle']);
    if (exact) return exact;
    const continueButton = root?.querySelector?.('.continue-btn');
    if (continueButton) return continueButton;
    return allowBattleLink ? root?.querySelector?.('a[href*="battle.php?id="]') || null : null;
  }

  function getMonsterIdFromBattleLink(link) {
    const href = link?.getAttribute?.('href') || link?.href;
    if (!href) return '';
    try {
      const url = new URL(href, window.location.origin);
      return String(url.searchParams.get('id') || url.searchParams.get('monster_id') || '').trim();
    } catch {
      return '';
    }
  }

  function getActiveAutoSummonBossIds() {
    return new Set(
      Array.from(document.querySelectorAll(SELECTORS.activeAutoSummonBossLink))
        .map(getMonsterIdFromBattleLink)
        .filter(Boolean),
    );
  }

  function isRecognizedBossCard(card, activeAutoSummonBossIds) {
    const bossId = String(card?.dataset?.monsterId || '').trim();
    return Boolean(
      bossId &&
        (String(card.dataset.boss || '') === '1' || activeAutoSummonBossIds.has(bossId)),
    );
  }

  function isFightableBossCard(card, activeAutoSummonBossIds) {
    if (!isRecognizedBossCard(card, activeAutoSummonBossIds)) return false;
    const dataset = card.dataset;
    return isFightableBossData(
      String(dataset.boss || '') === '1' ? dataset : { ...dataset, boss: '1' },
    );
  }

  function sortedBossCards(activeAutoSummonBossIds) {
    const cards = new Set([
      ...document.querySelectorAll(SELECTORS.bossCard),
      ...document.querySelectorAll(SELECTORS.monsterCard),
    ]);
    return Array.from(cards)
      .filter((card) => isRecognizedBossCard(card, activeAutoSummonBossIds))
      .sort((left, right) => {
        const leftExpiry = finiteNumber(left.dataset.expire) ?? Number.POSITIVE_INFINITY;
        const rightExpiry = finiteNumber(right.dataset.expire) ?? Number.POSITIVE_INFINITY;
        return leftExpiry - rightExpiry;
      });
  }

  function recordBossAction(state, { phase, kind, startIssued = state.startIssued }, now = Date.now()) {
    const attempts = state.actionKind === kind ? state.actionAttempts + 1 : 1;
    return patchBossCycleState(
      state,
      {
        phase,
        phaseUpdatedAt: now,
        actionKind: kind,
        actionAt: now,
        actionAttempts: attempts,
        startIssued,
      },
      now,
    );
  }

  function actionCanRun(state, kind, now = Date.now()) {
    return state.actionKind !== kind || now - state.actionAt >= BOSS_CONFIG.actionRetryMs;
  }

  function isDisabledControl(control) {
    return Boolean(
      control?.disabled === true ||
        control?.getAttribute?.('aria-disabled') === 'true' ||
        control?.classList?.contains?.('disabled'),
    );
  }

  function preserveVisitOnControl(control) {
    const visitId = visitIdForNavigation();
    if (!visitId || !control) return;

    const href = control.getAttribute?.('href') || control.href;
    if (href) {
      try {
        const url = new URL(href, window.location.origin);
        if (!url.searchParams.has('veyra_visit')) url.searchParams.set('veyra_visit', visitId);
        if (typeof control.setAttribute === 'function') control.setAttribute('href', url.href);
        else control.href = url.href;
      } catch {
        // Keep the native control unchanged if its URL is not parseable.
      }
    }

    const form = control.form || control.closest?.('form');
    if (form) {
      try {
        const action = new URL(form.getAttribute?.('action') || form.action || currentUrl().href, window.location.origin);
        if (!action.searchParams.has('veyra_visit')) action.searchParams.set('veyra_visit', visitId);
        if (typeof form.setAttribute === 'function') form.setAttribute('action', action.href);
        else form.action = action.href;
      } catch {
        // The command remains available in localStorage even without the URL hint.
      }
    }
  }

  function clickBossControl(state, control, options) {
    if (!control || runtime.bossActionPending || isDisabledControl(control)) return;

    const perform = () => {
      const now = Date.now();
      const latest = loadBossCycleState(now);
      if (
        isPageHidden() ||
        !latest?.active ||
        latest.ownerId !== runtime.bossOwnerId ||
        latest.leaseUntil <= now ||
        latest.targetBossId !== state.targetBossId ||
        control.isConnected === false ||
        isDisabledControl(control) ||
        (options.allowedPhases && !options.allowedPhases.includes(latest.phase)) ||
        (options.once && (latest.actionKind === options.kind || latest.startIssued)) ||
        (options.maxAttempts &&
          latest.actionKind === options.kind &&
          latest.actionAttempts >= options.maxAttempts) ||
        !actionCanRun(latest, options.kind, now)
      ) {
        return;
      }

      if (typeof options.beforeClick === 'function' && !options.beforeClick()) return;
      preserveVisitOnControl(control);
      recordBossAction(
        latest,
        {
          phase: options.phase,
          kind: options.kind,
          startIssued: options.startIssued ?? latest.startIssued,
        },
        now,
      );
      control.click();
    };

    const locks = window.navigator?.locks;
    if (!locks?.request) {
      perform();
      return;
    }

    runtime.bossActionPending = true;
    let lockCallbackRan = false;
    const performWithLock = () => {
      lockCallbackRan = true;
      perform();
    };

    let lockRequest;
    try {
      lockRequest = locks.request(
        'veyra-wave3:boss-action',
        { mode: 'exclusive' },
        performWithLock,
      );
    } catch (error) {
      runtime.bossActionPending = false;
      console.warn('[Wave 3 Boss Manager] Action lock failed; using fallback:', error);
      perform();
      return;
    }

    void Promise.resolve(lockRequest)
      .then(
        () => {
          if (!lockCallbackRan) performWithLock();
        },
        (error) => {
          console.warn('[Wave 3 Boss Manager] Action lock failed; using fallback:', error);
          if (!lockCallbackRan) performWithLock();
        },
      )
      .finally(() => {
        runtime.bossActionPending = false;
        scheduleScan();
      });
  }

  function abandonCurrentBoss(state, reason) {
    const bossId = state.targetBossId;
    const next = patchBossCycleState(state, {
      phase: BOSS_PHASES.returningHub,
      targetBossId: '',
      processedBossIds: normalizeBossIdList([...state.processedBossIds, bossId]),
      failedBossIds: normalizeBossIdList([...state.failedBossIds, bossId]),
      actionKind: '',
      actionAt: 0,
      actionAttempts: 0,
      startIssued: false,
      lastError: reason,
    });
    report(
      `Boss ${bossId || 'unknown'} is not currently fightable and will be skipped: ${reason}`,
      'error',
    );
    navigateTo(BOSS_CONFIG.wavePath);
    return next;
  }

  function completeCurrentBoss(state, reason = 'target') {
    const bossId = state.targetBossId;
    const next = patchBossCycleState(state, {
      phase: BOSS_PHASES.returningHub,
      targetBossId: '',
      processedBossIds: normalizeBossIdList([...state.processedBossIds, bossId]),
      failedBossIds: state.failedBossIds.filter((candidate) => candidate !== bossId),
      actionKind: '',
      actionAt: 0,
      actionAttempts: 0,
      startIssued: false,
      lastError: '',
    });
    report(
      reason === 'defeated'
        ? `Boss ${bossId} was defeated; returning to the wave.`
        : `Boss ${bossId} reached the 3b target; returning to the wave.`,
    );
    navigateTo(BOSS_CONFIG.wavePath);
    return next;
  }

  function handleBossHubPage() {
    const now = Date.now();
    let state = startBossCycleIfNeeded(now);
    if (!state?.active) return;

    if (isPageHidden()) {
      if (runtime.bossSuspendedAt === 0) runtime.bossSuspendedAt = now;
      return;
    }

    state = renewBossCycleLease(state, now);
    if (!state) {
      report('Another tab owns the active Wave 3 run; this tab is waiting.');
      return;
    }

    runtime.activeVisitId = state.visitId || runtime.activeVisitId;
    publishWorkerStatus('busy', false, 'Wave 3 boss scan is running.', runtime.activeVisitId);

    if (isBossCycleStale(state, now)) {
      state = patchBossCycleState(
        state,
        {
          phase: BOSS_PHASES.checking,
          cycleStartedAt: now,
          phaseUpdatedAt: now,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          startIssued: false,
          lastError: 'The boss scan exceeded its safety window and was resumed.',
        },
        now,
      );
      report('The safety window elapsed; continuing the Wave 3 scan.', 'error');
    }

    state = ensureAliveMonsterWaveFilter(state, now);
    if (!state) return;

    if (!document.querySelector(SELECTORS.bossContainer)) {
      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        patchBossCycleState(state, {
          phase: BOSS_PHASES.checking,
          phaseUpdatedAt: now,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          lastError: 'The boss list did not render; Wave 3 is being reloaded.',
        });
        report('The boss list did not render; reloading Wave 3.', 'error');
        navigateTo(BOSS_CONFIG.wavePath);
      } else {
        report('Waiting for the boss list to render.');
      }
      return;
    }

    const activeAutoSummonBossIds = getActiveAutoSummonBossIds();
    const cards = sortedBossCards(activeAutoSummonBossIds);
    if (now - state.phaseUpdatedAt < BOSS_CONFIG.hubSettleMs) {
      report('Waiting briefly for all boss cards to render.');
      return;
    }

    if (cards.length === 0) {
      if (runtime.bossEmptySince === 0) runtime.bossEmptySince = now;
      if (now - runtime.bossEmptySince < BOSS_CONFIG.hubEmptyWaitMs) {
        report('Waiting for the alive boss list to finish loading.');
        return;
      }
    } else {
      runtime.bossEmptySince = 0;
    }

    const targetCard = state.targetBossId
      ? cards.find((candidate) => String(candidate.dataset.monsterId || '') === state.targetBossId)
      : null;
    const targetBossFailed = Boolean(
      state.targetBossId && state.failedBossIds.includes(state.targetBossId),
    );
    let card =
      targetCard && isFightableBossCard(targetCard, activeAutoSummonBossIds) && !targetBossFailed
        ? targetCard
        : null;

    if (state.targetBossId && !card) {
      if (!targetCard && now - state.phaseUpdatedAt < BOSS_CONFIG.actionTimeoutMs) {
        report(`Waiting for boss ${state.targetBossId} to appear in the wave list.`);
        return;
      }
      state = patchBossCycleState(state, {
        phase: BOSS_PHASES.checking,
        targetBossId: '',
        processedBossIds: normalizeBossIdList([...state.processedBossIds, state.targetBossId]),
        failedBossIds: targetBossFailed
          ? state.failedBossIds
          : state.failedBossIds.filter((candidate) => candidate !== state.targetBossId),
        actionKind: '',
        actionAt: 0,
        actionAttempts: 0,
        startIssued: false,
      });
    }

    if (!card) {
      card = cards.find((candidate) => {
        const bossId = String(candidate.dataset.monsterId || '');
        return (
          isFightableBossCard(candidate, activeAutoSummonBossIds) &&
          !state.processedBossIds.includes(bossId) &&
          !state.failedBossIds.includes(bossId)
        );
      });
    }

    if (!card) {
      finishBossCycle(state);
      return;
    }

    const bossId = String(card.dataset.monsterId || '');
    if (state.targetBossId !== bossId) {
      state = patchBossCycleState(state, {
        phase: BOSS_PHASES.checking,
        targetBossId: bossId,
        actionKind: '',
        actionAt: 0,
        actionAttempts: 0,
        startIssued: false,
        lastError: '',
      });
    }

    const joined = String(card.dataset.joined || '') === '1';
    const joinControl = findJoinBossControl(card);
    const enterControl = findEnterBattleControl(card, joined);
    const joinConfirmedByUi =
      (!joinControl || isDisabledControl(joinControl)) && Boolean(enterControl);

    if (joined || joinConfirmedByUi) {
      if (!enterControl) {
        if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Enter Battle was not found.');
        } else {
          report(`Boss ${bossId} is joined; waiting for Enter Battle.`);
        }
        return;
      }
      if (isDisabledControl(enterControl)) {
        if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Enter Battle stayed disabled.');
        } else {
          report(`Boss ${bossId} is joined; waiting for Enter Battle to become available.`);
        }
        return;
      }
      if (!actionCanRun(state, 'enter', now)) return;
      if (state.actionKind === 'enter' && state.actionAttempts >= BOSS_CONFIG.maxActionAttempts) {
        abandonCurrentBoss(state, 'Enter Battle did not open the fight.');
        return;
      }
      report(`Entering boss battle ${bossId}.`);
      clickBossControl(state, enterControl, {
        phase: BOSS_PHASES.entering,
        kind: 'enter',
        maxAttempts: BOSS_CONFIG.maxActionAttempts,
        allowedPhases: [BOSS_PHASES.joining, BOSS_PHASES.entering, BOSS_PHASES.checking],
      });
      return;
    }

    if (!joinControl) {
      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'Join Battle was not found.');
      } else {
        report(`Waiting for Join Battle on boss ${bossId}.`);
      }
      return;
    }

    if (isDisabledControl(joinControl)) {
      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'Join Battle stayed disabled.');
      } else {
        report(`Waiting for Join Battle on boss ${bossId} to become available.`);
      }
      return;
    }

    if (state.actionKind === 'join') {
      if (now - state.actionAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'Join Battle did not complete.');
      }
      return;
    }

    report(`Joining boss ${bossId}.`);
    clickBossControl(state, joinControl, {
      phase: BOSS_PHASES.joining,
      kind: 'join',
      once: true,
      allowedPhases: [BOSS_PHASES.checking, BOSS_PHASES.joining],
    });
  }

  function dispatchBubblingEvent(element, type) {
    const EventConstructor = window.Event || globalThis.Event;
    if (!element?.dispatchEvent || typeof EventConstructor !== 'function') return;
    element.dispatchEvent(new EventConstructor(type, { bubbles: true }));
  }

  function ensureBossDamageTarget(input) {
    if (!input) return false;
    if (normalizeComparableText(input.value).replace(/\s/g, '') === BOSS_CONFIG.targetDamage) {
      return true;
    }
    input.value = BOSS_CONFIG.targetDamage;
    dispatchBubblingEvent(input, 'input');
    dispatchBubblingEvent(input, 'change');
    return normalizeComparableText(input.value).replace(/\s/g, '') === BOSS_CONFIG.targetDamage;
  }

  function parseFraction(value) {
    const match = String(value ?? '').match(/(\d[\d.,\s]*)\s*\/\s*(\d[\d.,\s]*)/);
    if (!match) return null;
    const current = parseInteger(match[1]);
    const maximum = parseInteger(match[2]);
    return current === null || maximum === null ? null : { current, maximum };
  }

  function handleMonsterBossBattlePage() {
    const now = Date.now();
    let state = loadBossCycleState(now);

    // Never touch an ordinary monster fight. A private active run and a
    // concrete target are both required before this script may act here.
    if (!state?.active || !state.targetBossId) {
      publishWorkerStatus('idle', true, 'No Wave 3 boss run owns this battle.', '');
      return;
    }

    if (isPageHidden()) {
      if (runtime.bossSuspendedAt === 0) runtime.bossSuspendedAt = now;
      return;
    }

    state = renewBossCycleLease(state, now);
    if (!state) {
      report('Another tab owns the active boss fight; this tab is waiting.');
      return;
    }

    runtime.activeVisitId = state.visitId || runtime.activeVisitId;
    publishWorkerStatus('busy', false, 'Wave 3 boss fight is running.', runtime.activeVisitId);

    if (isBossCycleStale(state, now)) {
      patchBossCycleState(
        state,
        {
          phase: BOSS_PHASES.returningHub,
          cycleStartedAt: now,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          startIssued: false,
          lastError: 'The boss fight exceeded its safety window and will be retried.',
        },
        now,
      );
      report('The boss fight safety window elapsed; returning to Wave 3.', 'error');
      navigateTo(BOSS_CONFIG.wavePath);
      return;
    }

    const pageBossId = getBattleMonsterId();
    if (pageBossId && pageBossId !== state.targetBossId) {
      abandonCurrentBoss(state, `Opened monster ${pageBossId} instead of ${state.targetBossId}.`);
      return;
    }

    if (!pageBossId) {
      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'The battle monster ID could not be verified.');
      } else {
        report('The battle page is ready, but the boss ID is not verifiable yet.');
      }
      return;
    }

    const statusText = document.querySelector(SELECTORS.monsterAutoStatus)?.textContent || '';
    const damageElement = document.querySelector(SELECTORS.monsterDamage);
    const damageText = damageElement?.textContent || '';
    const hpText = document.querySelector(SELECTORS.monsterHp)?.textContent || '';
    const completionReason = monsterAutoBattleCompletionReason({ statusText, damageText, hpText });
    if (completionReason) {
      completeCurrentBoss(state, completionReason);
      return;
    }

    const pageJoinControl =
      document.querySelector(SELECTORS.monsterJoin) ||
      findTextControl(document, ['join the battle', 'join battle']);
    if (pageJoinControl) {
      if (isDisabledControl(pageJoinControl)) {
        const waitStartedAt = state.actionKind === 'join-page' ? state.actionAt : state.phaseUpdatedAt;
        if (now - waitStartedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Join the Battle stayed disabled.');
        } else {
          report(`Waiting for boss ${state.targetBossId} to enable Join the Battle.`);
        }
        return;
      }

      if (state.actionKind === 'join-page') {
        if (now - state.actionAt < BOSS_CONFIG.actionTimeoutMs) {
          report(`Waiting for boss ${state.targetBossId} to accept the battle-page join.`);
          return;
        }
        if (state.actionAttempts >= BOSS_CONFIG.maxActionAttempts) {
          abandonCurrentBoss(state, 'Join the Battle did not make this boss fightable.');
          return;
        }
      }

      report(`Joining boss ${state.targetBossId} on the battle page.`);
      clickBossControl(state, pageJoinControl, {
        phase: BOSS_PHASES.joining,
        kind: 'join-page',
        maxAttempts: BOSS_CONFIG.maxActionAttempts,
        allowedPhases: [BOSS_PHASES.checking, BOSS_PHASES.joining, BOSS_PHASES.entering],
      });
      return;
    }

    const panel = document.querySelector(SELECTORS.monsterAutoPanel);
    const targetInput = document.querySelector(SELECTORS.monsterAutoTarget);
    const startButton = document.querySelector(SELECTORS.monsterAutoStart);
    const stopButton = document.querySelector(SELECTORS.monsterAutoStop);
    const autoBattleRunning = Boolean(
      panel && startButton && (startButton.disabled || (stopButton && !stopButton.disabled)),
    );
    const playerHealth = parseFraction(document.querySelector(SELECTORS.playerHp)?.textContent)?.current;

    if (damageElement && playerHealth === 0) {
      if (autoBattleRunning) {
        report('Player HP is 0; Monster Auto Battle is handling its configured potion.');
        return;
      }

      const healControl =
        document.querySelector(SELECTORS.healPotion) ||
        document.querySelector('.potion-use-btn[data-item="108"]');
      if (!healControl) {
        if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Player HP is 0 and no heal-potion control is available.');
        } else {
          report('Player HP is 0, but no heal-potion control is available yet.', 'error');
        }
        return;
      }

      if (state.actionKind === 'heal') {
        if (now - state.actionAt < BOSS_CONFIG.actionTimeoutMs) {
          report('Waiting for the heal potion to restore HP and reload the battle.');
          return;
        }
        if (state.actionAttempts >= BOSS_CONFIG.maxActionAttempts) {
          abandonCurrentBoss(state, 'The heal potion did not restore HP after several attempts.');
          return;
        }
      }

      if (healControl.disabled) {
        report('The heal-potion control is still processing.');
        return;
      }

      report(`Using a heal potion before fighting boss ${state.targetBossId}.`);
      clickBossControl(state, healControl, {
        phase: BOSS_PHASES.entering,
        kind: 'heal',
        maxAttempts: BOSS_CONFIG.maxActionAttempts,
        allowedPhases: [BOSS_PHASES.joining, BOSS_PHASES.entering, BOSS_PHASES.attacking],
      });
      return;
    }

    if (!panel) {
      if (state.phase !== BOSS_PHASES.entering) {
        state = patchBossCycleState(state, {
          phase: BOSS_PHASES.entering,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
        });
      }

      const enterControl = findEnterBattleControl(document, false);
      if (enterControl && isDisabledControl(enterControl)) {
        if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Enter Battle stayed disabled on the battle page.');
        } else {
          report(`Waiting for boss ${state.targetBossId} to enable Enter Battle.`);
        }
        return;
      }

      if (enterControl && actionCanRun(state, 'enter', now)) {
        if (state.actionKind === 'enter' && state.actionAttempts >= BOSS_CONFIG.maxActionAttempts) {
          abandonCurrentBoss(state, 'Enter Battle did not reveal the monster fight.');
          return;
        }
        report(`Clicking Enter Battle for boss ${state.targetBossId}.`);
        clickBossControl(state, enterControl, {
          phase: BOSS_PHASES.entering,
          kind: 'enter',
          maxAttempts: BOSS_CONFIG.maxActionAttempts,
          allowedPhases: [BOSS_PHASES.entering, BOSS_PHASES.joining],
        });
        return;
      }

      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'Monster Auto Battle did not appear after joining and healing.');
      } else {
        report('Waiting for the joined battle and Monster Auto Battle controls.');
      }
      return;
    }

    if (state.phase !== BOSS_PHASES.attacking) {
      state = patchBossCycleState(state, {
        phase: BOSS_PHASES.attacking,
        actionKind: '',
        actionAt: 0,
        actionAttempts: 0,
        startIssued: false,
      });
    }

    if (!targetInput || !startButton) {
      if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
        abandonCurrentBoss(state, 'Monster Auto Battle did not expose its damage field and Start button.');
      } else {
        report('Waiting for the Monster Auto Battle controls.');
      }
      return;
    }

    if (!ensureBossDamageTarget(targetInput)) {
      abandonCurrentBoss(state, 'The Monster Auto Battle damage field could not be set to 3b.');
      return;
    }

    if (autoBattleRunning) {
      if (!state.startIssued) {
        patchBossCycleState(state, {
          startIssued: true,
          actionKind: 'start',
          actionAt: now,
          actionAttempts: Math.max(1, state.actionAttempts),
        });
      }
      report(`Monster Auto Battle is dealing up to ${BOSS_CONFIG.targetDamage} damage.`);
      return;
    }

    if (!actionCanRun(state, 'start', now)) {
      report('Waiting briefly before checking or restarting Monster Auto Battle.');
      return;
    }

    const currentDamage = parseGameNumber(damageText);
    const damageLabel = Number.isFinite(currentDamage)
      ? new Intl.NumberFormat('en-US').format(currentDamage)
      : 'an unreadable damage value';
    report(
      state.startIssued
        ? `Monster Auto Battle stopped at ${damageLabel}; restarting because 3b was not reached.`
        : `Starting Monster Auto Battle with a ${BOSS_CONFIG.targetDamage} damage target.`,
      isMonsterAutoBattleFailure(statusText) ? 'error' : 'info',
    );
    clickBossControl(state, startButton, {
      phase: BOSS_PHASES.attacking,
      kind: 'start',
      startIssued: true,
      allowedPhases: [BOSS_PHASES.attacking],
      beforeClick: () => ensureBossDamageTarget(targetInput),
    });
  }

  async function scanPage() {
    if (runtime.scanRunning || runtime.stopped) return;
    runtime.scanRunning = true;
    try {
      if (isBossHubPage()) {
        handleBossHubPage();
        return;
      }
      if (isMonsterBattlePage()) {
        handleMonsterBossBattlePage();
        return;
      }
      publishWorkerStatus('idle', true, 'Wave 3 worker is idle.', '');
    } catch (error) {
      console.error('[Wave 3 Boss Manager] Scan failed:', error);
      const state = loadBossCycleState();
      const message = `Wave 3 scan failed: ${error?.message || error}`;
      if (state?.active) failBossCycle(state, message);
      else publishWorkerStatus('error', true, message, runtime.activeVisitId);
    } finally {
      runtime.scanRunning = false;
    }
  }

  function scheduleScan() {
    if (runtime.scanTimer !== null || runtime.stopped) return;
    runtime.scanTimer = window.setTimeout(() => {
      runtime.scanTimer = null;
      void scanPage();
    }, BOSS_CONFIG.scanDebounceMs);
  }

  runtime.observer = new MutationObserver(scheduleScan);
  runtime.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'data-alive', 'data-dead', 'data-joined', 'data-userdmg'],
  });

  runtime.interval = window.setInterval(scheduleScan, BOSS_CONFIG.scanIntervalMs);
  document.addEventListener?.('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', (event) => {
    if (event?.persisted) {
      window.clearTimeout(runtime.scanTimer);
      runtime.scanTimer = null;
      runtime.bossActionPending = false;
      runtime.bossNavigationPending = false;
      refreshBossCycleAfterMobileResume();
      runtime.bossSuspendedAt = 0;
    }
    scheduleScan();
  });

  window.addEventListener('pagehide', (event) => {
    if (event?.persisted) {
      runtime.bossSuspendedAt = Date.now();
      return;
    }
    runtime.stopped = true;
    document.removeEventListener?.('visibilitychange', handleVisibilityChange);
    runtime.observer?.disconnect();
    window.clearInterval(runtime.interval);
    window.clearTimeout(runtime.scanTimer);
  });

  scheduleScan();
})();
