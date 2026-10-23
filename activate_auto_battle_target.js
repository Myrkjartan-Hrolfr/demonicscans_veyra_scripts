// ==UserScript==
// @name         Veyra - Smart Solo PvP Battle
// @namespace    local.veyra.smart-solo-pvp-battle
// @version      2.1.0
// @description  Runs continuous Solo PvP and chooses attacks around Final Wish.
// @match        https://demonicscans.org/pvp*
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

    return Boolean(
      /victory|defeat|draw|battle ended|match ended|finished/.test(status) ||
        rewardsVisible ||
        !allyAlive ||
        !enemyAlive,
    );
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
    CONFIG,
    SKILL_KEYS,
    canSpendWithoutDelayingFinal,
    canUseSkill,
    chooseAttackPlan,
    isConfirmedSkillUse,
    isFinishedBattleState,
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
    allySlot: '#allyFormation .pSlot[data-side="ally"][data-alive="1"]',
    enemySlot: '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)',
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

  function isBattlePage() {
    return Boolean(
      document.querySelector(SELECTORS.fastEnemyButton) &&
        document.querySelector('#battleControlCard') &&
        document.querySelector('#enemyFormation'),
    );
  }

  function isBattleEnded() {
    const rewardsModal = document.querySelector(SELECTORS.rewardsModal);

    return isFinishedBattleState({
      statusText: document.querySelector(SELECTORS.matchStatus)?.textContent,
      rewardsVisible: rewardsModal?.classList.contains('show'),
      allyAlive: Boolean(document.querySelector(SELECTORS.allySlot)),
      enemyAlive: Boolean(document.querySelector(SELECTORS.enemySlot)),
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

  function readSoloTokenCount(root = document) {
    const section = findSoloSection(root);
    if (!section) return null;

    const tokenPill = Array.from(section.querySelectorAll(SELECTORS.infoPill)).find((pill) =>
      normalizeText(pill.querySelector('strong')?.textContent).startsWith('tokens'),
    );

    return tokenPill ? parseInteger(tokenPill.querySelector('span')?.textContent) : null;
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

  function scheduleReturnToLobby() {
    if (runtime.returnToLobbyTimer !== null) return;

    report('Battle ended; returning to the PvP lobby.');
    runtime.returnToLobbyTimer = window.setTimeout(() => {
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
      if (!isBattlePage()) {
        delete document.documentElement.dataset.veyraSmartPvp;
        if (isLobbyPage()) handleLobbyPage();
        return;
      }

      // This marker only describes ownership of an actual battle page.
      document.documentElement.dataset.veyraSmartPvp = '1';
      clearLobbyPollTimer();

      settlePendingAction();

      if (isBattleEnded()) {
        runtime.bridge = null;
        runtime.pendingAction = null;
        scheduleReturnToLobby();
        return;
      }

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
    attributeFilter: ['class', 'disabled', 'data-alive'],
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
