// ==UserScript==
// @name         Veyra - Smart Solo PvP Battle
// @namespace    local.veyra.smart-solo-pvp-battle
// @version      2.4.0
// @description  Runs continuous Solo PvP and periodically deals 3b damage to fightable Grakthar bosses.
// @match        https://demonicscans.org/pvp*
// @match        https://demonicscans.org/active_wave.php*
// @match        https://demonicscans.org/battle.php*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = Object.freeze({
    scanIntervalMs: 200,
    scanDebounceMs: 40,
    modeRetryMs: 250,
    targetWaitMs: 1000,
    skillWaitMs: 1000,
    matchmakeRetryMs: 15_000,
    lobbyPollIntervalMs: 30_000,
    lobbyRequestTimeoutMs: 15_000,
    returnToLobbyDelayMs: 3_000,
    slashTokenGain: 3,
    resourceGainPerAction: 25,
    finalWishCost: 15,
    resourceMaximum: 100,
  });

  const BOSS_CONFIG = Object.freeze({
    storageKey: 'veyra-smart-solo-pvp:boss-cycle:v1',
    ownerStorageKey: 'veyra-smart-solo-pvp:boss-owner:v1',
    stateVersion: 1,
    checkIntervalMs: 30 * 60 * 1000,
    leaseMs: 5 * 60_000,
    leaseRenewWindowMs: 60_000,
    actionRetryMs: 5_000,
    actionTimeoutMs: 30_000,
    hubSettleMs: 1_000,
    cycleTimeoutMs: 2 * 60 * 60 * 1000,
    maxActionAttempts: 3,
    wavePath: '/active_wave.php?gate=3&wave=8',
    pvpPath: '/pvp.php',
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

  const BOSS_COUNTDOWN_ID = 'tm-boss-check-countdown';

  const SKILL_KEYS = Object.freeze({
    slash: 'slash',
    powerSlash: 'powerSlash',
    venomRend: 'venomRend',
    deathMark: 'deathMark',
    finalWish: 'finalWish',
  });

  const SKILL_IDS = Object.freeze({
    [SKILL_KEYS.slash]: '0',
    [SKILL_KEYS.powerSlash]: '-1',
    [SKILL_KEYS.venomRend]: 'adv:18',
    [SKILL_KEYS.deathMark]: 'adv:19',
    [SKILL_KEYS.finalWish]: 'adv:20',
  });

  const SKILL_NAMES = Object.freeze({
    [SKILL_KEYS.slash]: 'Slash',
    [SKILL_KEYS.powerSlash]: 'Power Slash',
    [SKILL_KEYS.venomRend]: 'Venom Rend',
    [SKILL_KEYS.deathMark]: 'Death Mark',
    [SKILL_KEYS.finalWish]: 'Final Wish',
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return null;
    }

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
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

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

  function createDefaultBossCycleState(now = Date.now()) {
    return {
      version: BOSS_CONFIG.stateVersion,
      active: false,
      phase: BOSS_PHASES.idle,
      nextCheckAt: now + BOSS_CONFIG.checkIntervalMs,
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
      phase: active ? phase : BOSS_PHASES.idle,
      nextCheckAt: numberOr(value.nextCheckAt, defaults.nextCheckAt),
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

    // The status belongs to another userscript and can be stale. Only the
    // game's own per-player damage value proves that the 3b goal was reached.
    if (Number.isFinite(damage) && damage >= BOSS_CONFIG.targetDamageValue) {
      return 'target';
    }

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

  /**
   * Calculates how many preparation actions are needed when every remaining
   * preparation action is Slash. Slash is the only skill that adds tokens.
   */
  function roundsUntilFinalWish({
    tokens,
    resource,
    finalCost = CONFIG.finalWishCost,
    resourceMaximum = CONFIG.resourceMaximum,
    slashTokenGain = CONFIG.slashTokenGain,
    resourceGainPerAction = CONFIG.resourceGainPerAction,
  }) {
    const tokenValue = finiteNumber(tokens);
    const resourceValue = finiteNumber(resource);
    const cost = finiteNumber(finalCost);
    const maximum = finiteNumber(resourceMaximum);

    if (
      tokenValue === null ||
      resourceValue === null ||
      cost === null ||
      maximum === null ||
      slashTokenGain <= 0 ||
      resourceGainPerAction <= 0
    ) {
      return Number.POSITIVE_INFINITY;
    }

    const tokenRounds = Math.ceil(Math.max(0, cost - tokenValue) / slashTokenGain);
    const resourceRounds = Math.ceil(Math.max(0, maximum - resourceValue) / resourceGainPerAction);

    return Math.max(tokenRounds, resourceRounds);
  }

  /**
   * A paid setup skill may occupy the current preparation action, but it may
   * not move the already calculated Final-Wish turn. All later preparation
   * actions are conservatively treated as Slash.
   */
  function canSpendWithoutDelayingFinal({
    tokens,
    skillCost,
    rounds,
    finalCost = CONFIG.finalWishCost,
    slashTokenGain = CONFIG.slashTokenGain,
  }) {
    const tokenValue = finiteNumber(tokens);
    const cost = finiteNumber(skillCost);

    if (tokenValue === null || cost === null || !Number.isFinite(rounds) || rounds < 1) {
      return false;
    }

    const remainingSlashActions = Math.max(0, Math.floor(rounds) - 1);
    const tokensOnFinalTurn = tokenValue - cost + remainingSlashActions * slashTokenGain;

    return tokensOnFinalTurn >= finalCost;
  }

  function canUseSkill(skill, snapshot) {
    if (!skill?.available) {
      return false;
    }

    const cost = finiteNumber(skill.cost);
    const resourceCost = finiteNumber(skill.resourceCost);

    // Skill metadata comes from the native, freshly rendered modal. If that
    // contract changes, do not guess that a paid skill is free.
    if (cost === null || resourceCost === null || cost < 0 || resourceCost < 0) {
      return false;
    }

    if (snapshot.tokens < cost) {
      return false;
    }

    if (snapshot.resource < resourceCost) {
      return false;
    }

    return !skill.requiresFullResource || snapshot.resource >= snapshot.resourceMaximum;
  }

  function makeDecision(skillKey, reason, rounds, options = {}) {
    return {
      skillKey,
      reason,
      roundsUntilFinalWish: rounds,
      prepareBridge: options.prepareBridge === true,
      consumeBridge: options.consumeBridge === true,
      resetCycle: options.resetCycle === true,
    };
  }

  function isConfirmedSkillUse(logText, actorName, skillName) {
    const text = normalizeComparableText(logText);
    const actor = normalizeComparableText(actorName);
    const skill = normalizeComparableText(skillName);

    if (!text || !actor || !skill) return false;

    const prefix = `${actor} used ${skill}`;
    if (!text.startsWith(prefix)) return false;

    const boundary = text.charAt(prefix.length);
    return boundary === '' || /[\s.,!?:;()-]/.test(boundary);
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isFinishedBattleState({ statusText, rewardsVisible, allyAlive, enemyAlive }) {
    const status = normalizeComparableText(statusText);

    if (/victory|defeat|draw|battle ended|match ended|finished/.test(status) || rewardsVisible) {
      return true;
    }

    // Formation HTML is replaced while the desktop battle UI renders. During
    // that short window no living slot exists in the DOM, which is unknown
    // state rather than proof that a side was defeated. An explicit running
    // status is authoritative until the native UI publishes an end signal.
    if (/battle in progress|match in progress/.test(status)) {
      return false;
    }

    return allyAlive === false || enemyAlive === false;
  }

  function formatBossCheckCountdown(state, now = Date.now()) {
    if (state?.active) return 'Bossprüfung läuft';

    const nextCheckAt = finiteNumber(state?.nextCheckAt);
    if (nextCheckAt === null) return 'Bossprüfung --:--';

    const totalSeconds = Math.max(0, Math.ceil((nextCheckAt - now) / 1000));
    if (totalSeconds === 0) return 'Bossprüfung jetzt';

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const padded = (value) => String(value).padStart(2, '0');
    const time =
      hours > 0
        ? `${hours}:${padded(minutes)}:${padded(seconds)}`
        : `${padded(minutes)}:${padded(seconds)}`;

    return `Bossprüfung in ${time}`;
  }

  /**
   * Pure attack planner. The bridge flag means Death Mark was confirmed two
   * preparation actions before Final Wish and this is its single follow-up.
   */
  function chooseAttackPlan(input) {
    const tokens = finiteNumber(input?.tokens);
    const resource = finiteNumber(input?.resource);
    const resourceMaximum = finiteNumber(input?.resourceMaximum) ?? CONFIG.resourceMaximum;
    const skills = input?.skills || {};
    const bridgePending = input?.bridgePending === true;
    const enemyPoisoned = input?.enemyPoisoned === true;
    const slash = skills[SKILL_KEYS.slash];
    const finalWish = skills[SKILL_KEYS.finalWish];
    const finalCost = finiteNumber(finalWish?.cost) ?? CONFIG.finalWishCost;

    if (tokens === null || resource === null) {
      return makeDecision(null, 'Battle values are unavailable.', Number.POSITIVE_INFINITY, {
        consumeBridge: bridgePending,
      });
    }

    const snapshot = { tokens, resource, resourceMaximum };
    const rounds = roundsUntilFinalWish({
      tokens,
      resource,
      finalCost,
      resourceMaximum,
    });

    if (rounds === 0 && canUseSkill(finalWish, snapshot)) {
      return makeDecision(SKILL_KEYS.finalWish, 'Final Wish is ready now.', rounds, {
        consumeBridge: bridgePending,
        resetCycle: true,
      });
    }

    if (!slash?.available) {
      return makeDecision(null, 'Slash is unavailable.', rounds, {
        consumeBridge: bridgePending,
      });
    }

    // Explicit user rule: below the Final-Wish cost, only Slash may build up.
    if (tokens < finalCost) {
      return makeDecision(SKILL_KEYS.slash, `Only ${tokens} token(s): build with Slash.`, rounds, {
        consumeBridge: bridgePending,
      });
    }

    if (bridgePending) {
      const followUpKey = enemyPoisoned ? SKILL_KEYS.venomRend : SKILL_KEYS.powerSlash;
      const followUp = skills[followUpKey];
      const followUpName = SKILL_NAMES[followUpKey];

      if (
        rounds === 1 &&
        canUseSkill(followUp, snapshot) &&
        canSpendWithoutDelayingFinal({
          tokens,
          skillCost: followUp.cost,
          rounds,
          finalCost,
        })
      ) {
        return makeDecision(
          followUpKey,
          enemyPoisoned
            ? `${followUpName}: Death Mark is prepared and the enemy is poisoned.`
            : `${followUpName}: Death Mark is prepared and the enemy is not poisoned.`,
          rounds,
          { consumeBridge: true },
        );
      }

      return makeDecision(
        SKILL_KEYS.slash,
        `${followUpName} would delay Final Wish or is unavailable; use Slash.`,
        rounds,
        { consumeBridge: true },
      );
    }

    const deathMark = skills[SKILL_KEYS.deathMark];
    if (
      (rounds === 1 || rounds === 2) &&
      canUseSkill(deathMark, snapshot) &&
      canSpendWithoutDelayingFinal({
        tokens,
        skillCost: deathMark.cost,
        rounds,
        finalCost,
      })
    ) {
      return makeDecision(
        SKILL_KEYS.deathMark,
        `Death Mark prepares Final Wish ${rounds === 1 ? 'next turn' : 'in two turns'}.`,
        rounds,
        { prepareBridge: rounds === 2 },
      );
    }

    return makeDecision(
      SKILL_KEYS.slash,
      Number.isFinite(rounds)
        ? `Build for Final Wish (${rounds} preparation turn(s) remaining).`
        : 'Could not calculate Final Wish safely; use Slash.',
      rounds,
    );
  }

  const testExports = Object.freeze({
    BOSS_CONFIG,
    BOSS_PHASES,
    CONFIG,
    SKILL_KEYS,
    canSpendWithoutDelayingFinal,
    canUseSkill,
    chooseAttackPlan,
    createDefaultBossCycleState,
    formatBossCheckCountdown,
    isAliveBossData,
    isConfirmedSkillUse,
    isFinishedBattleState,
    isFightableBossData,
    isMonsterAutoBattleFailure,
    isMonsterAutoBattleSuccess,
    isUntouchedActiveBossData,
    monsterAutoBattleCompletionReason,
    normalizeBossCycleState,
    parseGameNumber,
    parseInteger,
    roundsUntilFinalWish,
  });

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) {
      module.exports = testExports;
    }
    return;
  }

  const SELECTORS = Object.freeze({
    attackButton: '#attackBtn',
    autoPlayButton: '#autoPlayBtn',
    fastEnemyButton: '#fastEnemyBtn',
    viewerMode: '#viewerModeBadge',
    matchStatus: '#matchStatusBadge',
    rewardsModal: '#rewardsModal',
    allyFormation: '#allyFormation',
    enemyFormation: '#enemyFormation',
    allySlot: '#allyFormation .pSlot[data-side="ally"][data-alive="1"]',
    enemySlot: '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)',
    defeatedAllySlot:
      '#allyFormation .pSlot[data-side="ally"][data-key]:not([data-key=""])[data-alive="0"], ' +
      '#allyFormation .pSlot[data-side="ally"][data-key]:not([data-key=""]).dead',
    defeatedEnemySlot:
      '#enemyFormation .pSlot[data-side="enemy"][data-key]:not([data-key=""])[data-alive="0"], ' +
      '#enemyFormation .pSlot[data-side="enemy"][data-key]:not([data-key=""]).dead',
    targetName: '#targetName',
    tokenValue: '#myTokens',
    resourceValue: '#advancedResourceValue',
    nativeSkillModal: '#skillsModal',
    nativeSkillGrid: '#skillsGrid',
    logLines: '#logBox .logLine[data-log-id]',
    soloMatchButton: '.js-matchmake[data-ladder="solo"]',
    section: 'section',
    sectionTitle: '.section-title',
    infoPill: '.info-pill',
    bossContainer: '.monster-container',
    bossCard: '.monster-card[data-boss][data-dead][data-monster-id]',
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
    lastModeClickAt: 0,
    handledTurnKey: '',
    bridge: null,
    pendingAction: null,
    statusKey: '',
    returnToLobbyTimer: null,
    matchmakeTimer: null,
    lastMatchmakeClickAt: 0,
    lobbyPollTimer: null,
    lobbyPollRunning: false,
    lobbyAbortController: null,
    bossStorage: null,
    bossOwnerId: '',
    bossNavigationPending: false,
    bossActionPending: false,
    bossCountdownTick: -1,
    stopped: false,
  };

  // A separately installed legacy loop can stand down completely. This file
  // owns lobby polling, matchmaking, combat, and the return to the lobby.
  document.documentElement.dataset.veyraSmartPvpLifecycle = '1';

  function normalizeText(value) {
    return normalizeComparableText(value);
  }

  function parseFraction(value) {
    const match = String(value ?? '').match(/(\d[\d.,\s]*)\s*\/\s*(\d[\d.,\s]*)/);
    if (!match) return null;

    const current = parseInteger(match[1]);
    const maximum = parseInteger(match[2]);

    return current === null || maximum === null ? null : { current, maximum };
  }

  function report(message, level = 'info') {
    const key = `${level}:${message}`;
    if (runtime.statusKey === key) return;

    runtime.statusKey = key;
    const method = level === 'error' ? 'warn' : 'info';
    console[method](`[Smart Solo PvP] ${message}`);
  }

  function getBrowserStorage(name) {
    try {
      return window[name] || null;
    } catch (error) {
      console.warn(`[Smart Solo PvP] ${name} is unavailable:`, error);
      return null;
    }
  }

  function getBossOwnerId() {
    const storage = getBrowserStorage('sessionStorage');
    if (!storage) return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      const saved = storage.getItem(BOSS_CONFIG.ownerStorageKey);
      if (saved) return saved;

      const ownerId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      storage.setItem(BOSS_CONFIG.ownerStorageKey, ownerId);
      return ownerId;
    } catch (error) {
      console.warn('[Smart Solo PvP] Could not initialize the boss-cycle owner.', error);
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
      console.warn('[Smart Solo PvP] Could not save the boss cycle.', error);
      runtime.bossStorage = null;
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
      console.warn('[Smart Solo PvP] Resetting an invalid boss-cycle state.', error);
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
      {
        ...state,
        ownerId: runtime.bossOwnerId,
        leaseUntil: now + BOSS_CONFIG.leaseMs,
      },
      now,
    );
    if (!claimed) return null;

    const verified = loadBossCycleState(now);
    return verified?.ownerId === runtime.bossOwnerId ? verified : null;
  }

  function renewBossCycleLease(state, now = Date.now()) {
    if (!state || state.ownerId !== runtime.bossOwnerId) return claimBossCycleLease(state, now);
    if (state.leaseUntil - now > BOSS_CONFIG.leaseRenewWindowMs) return state;

    return patchBossCycleState(state, { leaseUntil: now + BOSS_CONFIG.leaseMs }, now);
  }

  function isBossCycleStale(state, now = Date.now()) {
    return Boolean(
      state?.active && state.cycleStartedAt > 0 && now - state.cycleStartedAt > BOSS_CONFIG.cycleTimeoutMs,
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

  function navigateTo(path) {
    if (runtime.bossNavigationPending) return;
    runtime.bossNavigationPending = true;
    window.location.replace(new URL(path, window.location.origin).href);
  }

  function stopLobbyActivity() {
    clearLobbyPollTimer();
    window.clearTimeout(runtime.matchmakeTimer);
    runtime.matchmakeTimer = null;
    runtime.lobbyAbortController?.abort();
  }

  function finishBossCycle(state, message = '') {
    const now = Date.now();
    const failures = state?.failedBossIds?.length || 0;
    const next = createDefaultBossCycleState(now);
    next.lastError = failures > 0 ? `${failures} boss fight(s) could not be completed.` : '';
    saveBossCycleState(next, now);

    report(
      message ||
        (failures > 0
          ? `Boss check finished with ${failures} incomplete fight(s); returning to PvP.`
          : 'Boss check finished; returning to PvP.'),
      failures > 0 ? 'error' : 'info',
    );
    navigateTo(BOSS_CONFIG.pvpPath);
  }

  function startBossCycleFromLobby() {
    const now = Date.now();
    let state = loadBossCycleState(now);
    if (!state) return false;

    if (isBossCycleStale(state, now)) {
      state = saveBossCycleState(
        {
          ...state,
          active: true,
          phase: BOSS_PHASES.checking,
          cycleStartedAt: now,
          phaseUpdatedAt: now,
          targetBossId: '',
          ownerId: runtime.bossOwnerId,
          leaseUntil: now + BOSS_CONFIG.leaseMs,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          startIssued: false,
          lastError: 'The previous boss cycle was stale and has been resumed.',
        },
        now,
      );
    }

    if (!state.active && now < state.nextCheckAt) return false;

    if (!state.active) {
      state = saveBossCycleState(
        {
          ...state,
          active: true,
          phase: BOSS_PHASES.checking,
          cycleStartedAt: now,
          phaseUpdatedAt: now,
          targetBossId: '',
          processedBossIds: [],
          failedBossIds: [],
          ownerId: runtime.bossOwnerId,
          leaseUntil: now + BOSS_CONFIG.leaseMs,
          actionKind: '',
          actionAt: 0,
          actionAttempts: 0,
          startIssued: false,
          lastError: '',
        },
        now,
      );
    }

    // Once a cycle is due, cancel callbacks that may already have been queued
    // by the lobby loop even when another tab currently owns the boss lease.
    stopLobbyActivity();

    const owned = claimBossCycleLease(state, now);
    if (!owned) {
      report('Another tab is handling the scheduled boss check; PvP matchmaking is paused.');
      return true;
    }

    report('Boss check is due; opening Grakthar Wave 3.');
    navigateTo(BOSS_CONFIG.wavePath);
    return true;
  }

  function controlText(control) {
    return normalizeText(control?.value || control?.textContent || control?.getAttribute?.('aria-label'));
  }

  function findTextControl(root, acceptedTexts) {
    const accepted = new Set(acceptedTexts.map(normalizeText));
    return (
      Array.from(root?.querySelectorAll?.('button, a, input[type="button"], input[type="submit"]') || []).find(
        (control) => {
          const text = controlText(control);
          return accepted.has(text) || [...accepted].some((candidate) => text.endsWith(` ${candidate}`));
        },
      ) || null
    );
  }

  function findJoinBossControl(card) {
    const control = findTextControl(card, ['join', 'join battle', 'join the battle']);
    return control && !controlText(control).includes('quick join') ? control : null;
  }

  function findEnterBattleControl(root, allowBattleLink = false) {
    const exact = findTextControl(root, ['enter battle', 'continue battle']);
    if (exact) return exact;

    const continueButton = root?.querySelector?.('.continue-btn');
    if (continueButton) return continueButton;

    return allowBattleLink ? root?.querySelector?.('a[href*="battle.php?id="]') || null : null;
  }

  function sortedBossCards() {
    return Array.from(document.querySelectorAll(SELECTORS.bossCard)).sort((left, right) => {
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

  function clickBossControl(state, control, options) {
    if (!control || runtime.bossActionPending) return;

    const perform = () => {
      const now = Date.now();
      const latest = loadBossCycleState(now);
      if (
        !latest?.active ||
        latest.ownerId !== runtime.bossOwnerId ||
        latest.leaseUntil <= now ||
        latest.targetBossId !== state.targetBossId ||
        control.isConnected === false ||
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
    void locks
      .request('veyra-smart-solo-pvp:boss-action', { mode: 'exclusive' }, perform)
      .catch((error) => {
        console.warn('[Smart Solo PvP] Boss action lock failed:', error);
      })
      .finally(() => {
        runtime.bossActionPending = false;
        scheduleScan();
      });
  }

  function abandonCurrentBoss(state, reason) {
    const bossId = state.targetBossId;
    const processedBossIds = normalizeBossIdList([...state.processedBossIds, bossId]);
    const failedBossIds = normalizeBossIdList([...state.failedBossIds, bossId]);
    const next = patchBossCycleState(state, {
      phase: BOSS_PHASES.returningHub,
      targetBossId: '',
      processedBossIds,
      failedBossIds,
      actionKind: '',
      actionAt: 0,
      actionAttempts: 0,
      startIssued: false,
      lastError: reason,
    });

    report(
      `Boss ${bossId || 'unknown'} is not currently fightable and will be skipped in this scan: ${reason}`,
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
    let state = loadBossCycleState(now);
    if (!state?.active) return;

    state = renewBossCycleLease(state, now);
    if (!state) {
      report('Another tab owns the active boss cycle; this tab is waiting.');
      return;
    }

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
          lastError: 'The boss cycle exceeded its safety window and was resumed.',
        },
        now,
      );
      report('The boss cycle safety window elapsed; continuing the Wave 3 scan.', 'error');
    }

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
        report('The boss list did not render; reloading Wave 3 instead of returning to PvP.', 'error');
        navigateTo(BOSS_CONFIG.wavePath);
      } else {
        report('Waiting for the boss list to render.');
      }
      return;
    }

    const cards = sortedBossCards();
    if (now - state.phaseUpdatedAt < BOSS_CONFIG.hubSettleMs) {
      report('Waiting briefly for all boss cards to render.');
      return;
    }

    const targetCard = state.targetBossId
      ? cards.find((candidate) => String(candidate.dataset.monsterId || '') === state.targetBossId)
      : null;
    const targetBossFailed = Boolean(
      state.targetBossId && state.failedBossIds.includes(state.targetBossId),
    );
    let card =
      targetCard &&
      isFightableBossData(targetCard.dataset) &&
      !targetBossFailed
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
        return isFightableBossData(candidate.dataset) && !state.failedBossIds.includes(bossId);
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
    const joinConfirmedByUi = !joinControl && Boolean(enterControl);

    if (joined || joinConfirmedByUi) {
      if (!enterControl) {
        if (now - state.phaseUpdatedAt >= BOSS_CONFIG.actionTimeoutMs) {
          abandonCurrentBoss(state, 'Enter Battle was not found. The missing HTML can be added later.');
        } else {
          report(`Boss ${bossId} is joined; waiting for Enter Battle.`);
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

    // Joining sends a POST request. Never repeat it merely because a slow
    // response has not navigated yet; wait for joined/UI confirmation.
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
    if (normalizeText(input.value).replace(/\s/g, '') === BOSS_CONFIG.targetDamage) return true;

    input.value = BOSS_CONFIG.targetDamage;
    dispatchBubblingEvent(input, 'input');
    dispatchBubblingEvent(input, 'change');
    return normalizeText(input.value).replace(/\s/g, '') === BOSS_CONFIG.targetDamage;
  }

  function handleMonsterBossBattlePage() {
    const now = Date.now();
    let state = loadBossCycleState(now);
    if (!state?.active) return;

    state = renewBossCycleLease(state, now);
    if (!state) {
      report('Another tab owns the active boss fight; this tab is waiting.');
      return;
    }

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
      report('The boss fight safety window elapsed; returning to Wave 3 to retry it.', 'error');
      navigateTo(BOSS_CONFIG.wavePath);
      return;
    }

    if (!state.targetBossId) {
      report('Boss target was lost; returning to the wave.', 'error');
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

    // Clicking Join on the Wave overview opens battle.php, but the native
    // battle still requires its own, separate Join the Battle action.
    const pageJoinControl =
      document.querySelector(SELECTORS.monsterJoin) ||
      findTextControl(document, ['join the battle', 'join battle']);
    if (pageJoinControl) {
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

    // A joined player with 0 HP has no attack buttons, so Monster Auto Battle
    // cannot mount yet. Bootstrap that one heal through the native battle
    // control; subsequent combat healing remains an Auto Battle setting.
    if (damageElement && playerHealth === 0) {
      if (autoBattleRunning) {
        report('Player HP is 0; Monster Auto Battle is handling the configured health potion.');
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

  function handleBossRoute() {
    if (isBossHubPage()) {
      handleBossHubPage();
      return true;
    }

    if (isMonsterBattlePage()) {
      handleMonsterBossBattlePage();
      return true;
    }

    return false;
  }

  function isBattlePage() {
    return Boolean(
      document.querySelector(SELECTORS.fastEnemyButton) &&
        document.querySelector('#battleControlCard') &&
        document.querySelector('#enemyFormation'),
    );
  }

  function isBattleEnded() {
    const rewardsModal = document.querySelector(SELECTORS.rewardsModal);

    const readAliveState = (formationSelector, livingSelector, defeatedSelector) => {
      if (!document.querySelector(formationSelector)) return null;
      if (document.querySelector(livingSelector)) return true;

      // Only an actually rendered combatant can prove that the whole side is
      // down. An empty formation is a transient/unknown render state.
      return document.querySelector(defeatedSelector) ? false : null;
    };

    return isFinishedBattleState({
      statusText: document.querySelector(SELECTORS.matchStatus)?.textContent,
      rewardsVisible: rewardsModal?.classList.contains('show'),
      allyAlive: readAliveState(
        SELECTORS.allyFormation,
        SELECTORS.allySlot,
        SELECTORS.defeatedAllySlot,
      ),
      enemyAlive: readAliveState(
        SELECTORS.enemyFormation,
        SELECTORS.enemySlot,
        SELECTORS.defeatedEnemySlot,
      ),
    });
  }

  function findSoloSection(root = document) {
    const matchButton = root.querySelector(SELECTORS.soloMatchButton);
    if (matchButton) return matchButton.closest(SELECTORS.section);

    return (
      Array.from(root.querySelectorAll(SELECTORS.section)).find((section) => {
        const title = normalizeText(section.querySelector(SELECTORS.sectionTitle)?.textContent);
        return title.includes('solo') && title.includes('ladder');
      }) || null
    );
  }

  function findSoloTokenPill(root = document) {
    const section = findSoloSection(root);
    if (!section) return null;

    return (
      Array.from(section.querySelectorAll?.(SELECTORS.infoPill) || []).find((pill) =>
        normalizeText(pill.querySelector?.('strong')?.textContent).startsWith('tokens'),
      ) || null
    );
  }

  function readSoloTokenCount(root = document) {
    const tokenPill = findSoloTokenPill(root);

    return tokenPill ? parseInteger(tokenPill.querySelector('span')?.textContent) : null;
  }

  function ensureBossCountdownElement() {
    const battleTokenValue = document.querySelector(SELECTORS.tokenValue);
    const battlePanel = battleTokenValue?.closest?.('.combatTokenPanel') || null;
    const lobbyTokenPill = battlePanel ? null : findSoloTokenPill();
    const host = battlePanel || lobbyTokenPill;
    if (!host) return null;

    let countdown = document.getElementById?.(BOSS_COUNTDOWN_ID) || null;
    if (!countdown) {
      countdown = document.createElement?.('small') || null;
      if (!countdown) return null;

      countdown.id = BOSS_COUNTDOWN_ID;
      countdown.setAttribute?.('aria-label', 'Countdown bis zur nächsten Bossprüfung');
    }

    const placement = battlePanel ? 'battle' : 'lobby';
    if (countdown.dataset?.placement !== placement) {
      if (countdown.dataset) countdown.dataset.placement = placement;
      if (countdown.style) {
        countdown.style.cssText = battlePanel
          ? 'display:block;width:100%;margin-top:4px;font-size:11px;font-weight:700;opacity:.78;white-space:nowrap;'
          : 'margin-left:2px;padding-left:8px;border-left:1px solid rgba(148,163,184,.38);font-size:10px;font-weight:700;opacity:.82;white-space:nowrap;';
      }
    }

    if (countdown.parentElement !== host) {
      const targetHint = battlePanel?.querySelector?.('#targetHint') || null;
      if (targetHint && typeof host.insertBefore === 'function') {
        host.insertBefore(countdown, targetHint);
      } else {
        host.appendChild?.(countdown);
      }
    }

    return countdown;
  }

  function updateBossCheckCountdown(now = Date.now()) {
    const countdown = ensureBossCountdownElement();
    if (!countdown) return;

    const tick = Math.floor(now / 1000);
    if (runtime.bossCountdownTick === tick && countdown.textContent) return;
    runtime.bossCountdownTick = tick;

    const text = formatBossCheckCountdown(loadBossCycleState(now), now);
    if (countdown.textContent !== text) countdown.textContent = text;
  }

  function getLobbySnapshot(root = document) {
    const section = findSoloSection(root);
    const button = root.querySelector(SELECTORS.soloMatchButton);
    const tokens = readSoloTokenCount(root);

    return {
      section,
      button,
      tokens,
      canStart: Boolean(button) && Number.isFinite(tokens) && tokens > 0,
    };
  }

  function isLobbyPage() {
    return /\/pvp\.php\/?$/i.test(window.location.pathname) || Boolean(findSoloSection());
  }

  function clearLobbyPollTimer() {
    if (runtime.lobbyPollTimer !== null) {
      window.clearTimeout(runtime.lobbyPollTimer);
      runtime.lobbyPollTimer = null;
    }
  }

  function scheduleLobbyPoll(delay = CONFIG.lobbyPollIntervalMs) {
    if (runtime.stopped || runtime.lobbyPollTimer !== null || runtime.lobbyPollRunning) return;

    runtime.lobbyPollTimer = window.setTimeout(() => {
      runtime.lobbyPollTimer = null;
      void pollLobbyForTokens();
    }, delay);
  }

  async function pollLobbyForTokens() {
    if (runtime.stopped || runtime.lobbyPollRunning || !isLobbyPage()) return;

    runtime.lobbyPollRunning = true;
    const controller = new AbortController();
    runtime.lobbyAbortController = controller;
    const timeout = window.setTimeout(() => controller.abort(), CONFIG.lobbyRequestTimeoutMs);

    try {
      const response = await window.fetch(window.location.href, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const nextDocument = new DOMParser().parseFromString(html, 'text/html');
      const snapshot = getLobbySnapshot(nextDocument);

      if (!snapshot.section) throw new Error('Solo ladder missing from lobby response.');

      if (snapshot.canStart) {
        report('Solo token available; refreshing the lobby.');
        window.location.reload();
        return;
      }

      report(`${snapshot.tokens ?? 0} Solo token(s); checking again in 30 seconds.`);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[Smart Solo PvP] Lobby token check failed:', error);
      }
      report('Lobby token check failed; retrying in 30 seconds.', 'error');
    } finally {
      window.clearTimeout(timeout);
      if (runtime.lobbyAbortController === controller) runtime.lobbyAbortController = null;
      runtime.lobbyPollRunning = false;
      scheduleLobbyPoll();
    }
  }

  function handleLobbyPage() {
    const snapshot = getLobbySnapshot();

    if (!snapshot.section) {
      report('Solo ladder was not found; waiting for the lobby.', 'error');
      scheduleLobbyPoll();
      return;
    }

    if (!snapshot.canStart) {
      report(`${snapshot.tokens ?? 0} Solo token(s); waiting for the next token.`);
      scheduleLobbyPoll();
      return;
    }

    clearLobbyPollTimer();
    if (snapshot.button.disabled) {
      report('Solo matchmaking is already running.');
      return;
    }

    const now = Date.now();
    if (now - runtime.lastMatchmakeClickAt < CONFIG.matchmakeRetryMs) return;

    runtime.lastMatchmakeClickAt = now;
    report(`${snapshot.tokens} Solo token(s); starting a new match.`);

    window.clearTimeout(runtime.matchmakeTimer);
    runtime.matchmakeTimer = window.setTimeout(() => {
      runtime.matchmakeTimer = null;
      const current = getLobbySnapshot();
      if (current.canStart && current.button && !current.button.disabled) current.button.click();
    }, 250);
  }

  function cancelReturnToLobby() {
    if (runtime.returnToLobbyTimer === null) return;

    window.clearTimeout(runtime.returnToLobbyTimer);
    runtime.returnToLobbyTimer = null;
  }

  function scheduleReturnToLobby() {
    if (runtime.returnToLobbyTimer !== null) return;

    report('Battle ended; returning to the PvP lobby.');
    runtime.returnToLobbyTimer = window.setTimeout(() => {
      runtime.returnToLobbyTimer = null;
      if (!isBattleEnded()) {
        report('Battle is still running; cancelled the lobby return.');
        return;
      }

      window.location.replace(new URL('/pvp.php', window.location.origin).href);
    }, CONFIG.returnToLobbyDelayMs);
  }

  function isAutoPlayActive() {
    const button = document.querySelector(SELECTORS.autoPlayButton);
    const viewerMode = normalizeText(document.querySelector(SELECTORS.viewerMode)?.textContent);

    return Boolean(
      button?.classList.contains('active') ||
        button?.getAttribute('aria-pressed') === 'true' ||
        normalizeText(button?.textContent).includes('auto play on') ||
        viewerMode.includes('auto play enabled'),
    );
  }

  function isFastEnemyActive() {
    const button = document.querySelector(SELECTORS.fastEnemyButton);
    const viewerMode = normalizeText(document.querySelector(SELECTORS.viewerMode)?.textContent);
    const buttonText = normalizeText(button?.textContent);

    return Boolean(
      button?.classList.contains('active') ||
        button?.getAttribute('aria-pressed') === 'true' ||
        buttonText.includes('enemy turns 1s on') ||
        viewerMode.includes('enemy turns set to 1s'),
    );
  }

  function ensureBattleMode() {
    const now = Date.now();

    if (isAutoPlayActive()) {
      const button = document.querySelector(SELECTORS.autoPlayButton);
      if (button && !button.disabled && now - runtime.lastModeClickAt >= CONFIG.modeRetryMs) {
        runtime.lastModeClickAt = now;
        report('Disabling Auto Play.');
        button.click();
      }
      return false;
    }

    if (!isFastEnemyActive()) {
      const button = document.querySelector(SELECTORS.fastEnemyButton);
      if (button && !button.disabled && now - runtime.lastModeClickAt >= CONFIG.modeRetryMs) {
        runtime.lastModeClickAt = now;
        report('Enabling Enemy Turns 1s.');
        button.click();
      }
      return false;
    }

    return true;
  }

  function getAllyName() {
    const slot = document.querySelector(SELECTORS.allySlot);
    return String(slot?.dataset.username || document.querySelector('#allyBadge')?.textContent || '').trim();
  }

  function getLatestTurnStart() {
    const lines = Array.from(document.querySelectorAll(SELECTORS.logLines));

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      const text = String(line.querySelector('.logText')?.textContent || '').trim();
      const match = text.match(/^(.+?)\s+takes the turn\.?$/i);

      if (match) {
        return {
          key: String(line.dataset.logId || ''),
          numericId: parseInteger(line.dataset.logId),
          actor: match[1].trim(),
        };
      }
    }

    return null;
  }

  function isOwnActionableTurn(turn) {
    const allyName = getAllyName();
    const attackButton = document.querySelector(SELECTORS.attackButton);

    return Boolean(
      turn?.key &&
        allyName &&
        normalizeText(turn.actor) === normalizeText(allyName) &&
        attackButton &&
        !attackButton.disabled,
    );
  }

  function findLiveTarget() {
    return document.querySelector(SELECTORS.enemySlot);
  }

  function isTargetPoisoned(target) {
    // The native renderer adds this class only for effect.key === 'poison'.
    // Text such as "Poison Resistance" must not count as an active poison.
    return Boolean(target?.classList.contains('hasPoison'));
  }

  function skillKeyFromButton(button) {
    const id = String(button?.dataset.skillId || '');
    const byId = Object.entries(SKILL_IDS).find(([, skillId]) => skillId === id);
    if (byId) return byId[0];

    const name = normalizeText(button?.querySelector('.skillName')?.textContent || button?.textContent);
    return Object.keys(SKILL_NAMES).find((key) => normalizeText(SKILL_NAMES[key]) === name) || null;
  }

  function getSkillGrid() {
    return document.querySelector(SELECTORS.nativeSkillGrid);
  }

  function readSkills() {
    const skills = {};
    const grid = getSkillGrid();

    for (const button of grid?.querySelectorAll('button.skillCard[data-skill-id]') || []) {
      const key = skillKeyFromButton(button);
      if (!key) continue;

      const cost = parseInteger(button.dataset.cost);
      const resourceCost = parseInteger(button.dataset.resourceCost);
      const metadataValid = cost !== null && resourceCost !== null && cost >= 0 && resourceCost >= 0;

      skills[key] = {
        key,
        id: String(button.dataset.skillId || ''),
        name: String(button.querySelector('.skillName')?.textContent || SKILL_NAMES[key]).trim(),
        cost,
        resourceCost,
        requiresFullResource: button.dataset.requiresFullResource === '1',
        available: !button.disabled && metadataValid,
        button,
      };
    }

    return skills;
  }

  function readBattleSnapshot(target) {
    const resource = parseFraction(document.querySelector(SELECTORS.resourceValue)?.textContent);

    return {
      tokens: parseInteger(document.querySelector(SELECTORS.tokenValue)?.textContent),
      resource: resource?.current ?? null,
      resourceMaximum: resource?.maximum ?? CONFIG.resourceMaximum,
      enemyPoisoned: isTargetPoisoned(target),
      bridgePending: Boolean(runtime.bridge && runtime.bridge.targetKey === target?.dataset.key),
      skills: readSkills(),
    };
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();

      const check = () => {
        const result = predicate();
        if (result || Date.now() - startedAt >= timeoutMs) {
          resolve(result || null);
          return;
        }

        window.setTimeout(check, 40);
      };

      check();
    });
  }

  function openSkillsForTarget(target) {
    const nativeModal = document.querySelector(SELECTORS.nativeSkillModal);

    if (!target.classList.contains('targeted')) {
      target.click();
      return;
    }

    if (nativeModal && !nativeModal.classList.contains('show')) {
      document.querySelector(SELECTORS.attackButton)?.click();
    }
  }

  function getLogTextsAfter(logId) {
    const numericLogId = finiteNumber(logId);
    if (numericLogId === null) return [];

    return Array.from(document.querySelectorAll(SELECTORS.logLines))
      .filter((line) => {
        const currentId = parseInteger(line.dataset.logId);
        return currentId !== null && currentId > numericLogId;
      })
      .map((line) => String(line.querySelector('.logText')?.textContent || '').trim());
  }

  function settlePendingAction() {
    const pending = runtime.pendingAction;
    if (!pending) return;

    const allyName = normalizeText(pending.allyName);
    const confirmed = getLogTextsAfter(pending.turnNumericId).some((text) =>
      isConfirmedSkillUse(text, pending.allyName, pending.skillName),
    );

    if (confirmed) {
      if (pending.prepareBridge) {
        runtime.bridge = { targetKey: pending.targetKey };
      }
      if (pending.consumeBridge || pending.resetCycle) {
        runtime.bridge = null;
      }
      runtime.pendingAction = null;
      return;
    }

    const latestTurn = getLatestTurnStart();
    const newerOwnTurn =
      latestTurn?.key &&
      latestTurn.key !== pending.turnKey &&
      normalizeText(latestTurn.actor) === allyName;

    if (newerOwnTurn) {
      // The click was intentionally not retried. If its log cannot be found,
      // do not arm a Death-Mark follow-up based on an unconfirmed action.
      if (pending.consumeBridge || pending.resetCycle) {
        runtime.bridge = null;
      }
      runtime.pendingAction = null;
    }
  }

  async function actOnTurn(turn) {
    const initialTarget = findLiveTarget();
    if (!initialTarget) return;

    openSkillsForTarget(initialTarget);

    const modalReady = await waitFor(() => {
      const modal = document.querySelector(SELECTORS.nativeSkillModal);
      const grid = getSkillGrid();
      return modal?.classList.contains('show') && grid?.querySelector('button.skillCard[data-skill-id]')
        ? grid
        : null;
    }, CONFIG.skillWaitMs);

    if (!modalReady) return;

    const currentTurn = getLatestTurnStart();
    const attackButton = document.querySelector(SELECTORS.attackButton);
    const target = findLiveTarget();

    if (
      !currentTurn ||
      currentTurn.key !== turn.key ||
      !target ||
      !attackButton ||
      attackButton.disabled ||
      isAutoPlayActive()
    ) {
      return;
    }

    if (!target.classList.contains('targeted')) {
      target.click();
      await waitFor(() => findLiveTarget()?.classList.contains('targeted'), CONFIG.targetWaitMs);
    }

    const stableTurn = getLatestTurnStart();
    const stableTarget = findLiveTarget();
    const stableModal = document.querySelector(SELECTORS.nativeSkillModal);
    if (
      !stableTurn ||
      stableTurn.key !== turn.key ||
      !isOwnActionableTurn(stableTurn) ||
      !stableTarget?.classList.contains('targeted') ||
      !stableModal?.classList.contains('show') ||
      isAutoPlayActive() ||
      !isFastEnemyActive()
    ) {
      return;
    }

    const snapshot = readBattleSnapshot(stableTarget);
    const decision = chooseAttackPlan(snapshot);
    const selectedSkill = decision.skillKey ? snapshot.skills[decision.skillKey] : null;

    if (
      !selectedSkill ||
      !canUseSkill(selectedSkill, snapshot) ||
      !selectedSkill.button.isConnected ||
      !selectedSkill.button.closest(SELECTORS.nativeSkillGrid)
    ) {
      report(decision.reason, 'error');
      return;
    }

    // A skill click spends the turn. Mark it before dispatch and never retry
    // this turn, even if the subsequent network result is ambiguous.
    runtime.handledTurnKey = turn.key;
    runtime.pendingAction = {
      turnKey: turn.key,
      turnNumericId: turn.numericId,
      allyName: getAllyName(),
      skillKey: decision.skillKey,
      skillName: selectedSkill.name,
      targetKey: stableTarget.dataset.key || '',
      prepareBridge: decision.prepareBridge,
      consumeBridge: decision.consumeBridge,
      resetCycle: decision.resetCycle,
    };

    report(
      `${selectedSkill.name} | Tokens ${snapshot.tokens}, Energy ${snapshot.resource}/${snapshot.resourceMaximum} | ${decision.reason}`,
    );
    selectedSkill.button.click();
  }

  async function scanPage() {
    if (runtime.scanRunning) return;
    runtime.scanRunning = true;

    try {
      if (handleBossRoute()) {
        delete document.documentElement.dataset.veyraSmartPvp;
        return;
      }

      if (!isBattlePage()) {
        delete document.documentElement.dataset.veyraSmartPvp;
        if (isLobbyPage()) {
          updateBossCheckCountdown();
          if (startBossCycleFromLobby()) return;
          handleLobbyPage();
        }
        return;
      }

      // This marker only describes ownership of an actual battle page.
      document.documentElement.dataset.veyraSmartPvp = '1';
      clearLobbyPollTimer();
      updateBossCheckCountdown();

      settlePendingAction();

      if (isBattleEnded()) {
        runtime.bridge = null;
        runtime.pendingAction = null;
        scheduleReturnToLobby();
        return;
      }

      cancelReturnToLobby();

      if (!ensureBattleMode()) return;

      const turn = getLatestTurnStart();
      if (!isOwnActionableTurn(turn) || runtime.handledTurnKey === turn.key) return;

      await actOnTurn(turn);
    } catch (error) {
      console.error('[Smart Solo PvP] Scan failed:', error);
    } finally {
      runtime.scanRunning = false;
    }
  }

  function scheduleScan() {
    if (runtime.scanTimer !== null) return;

    runtime.scanTimer = window.setTimeout(() => {
      runtime.scanTimer = null;
      void scanPage();
    }, CONFIG.scanDebounceMs);
  }

  runtime.observer = new MutationObserver(scheduleScan);
  runtime.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'data-alive', 'data-dead', 'data-joined', 'data-userdmg'],
  });

  runtime.interval = window.setInterval(scheduleScan, CONFIG.scanIntervalMs);
  window.addEventListener('pagehide', () => {
    runtime.stopped = true;
    runtime.observer?.disconnect();
    window.clearInterval(runtime.interval);
    window.clearTimeout(runtime.scanTimer);
    window.clearTimeout(runtime.returnToLobbyTimer);
    window.clearTimeout(runtime.matchmakeTimer);
    clearLobbyPollTimer();
    runtime.lobbyAbortController?.abort();
  });

  scheduleScan();
})();
