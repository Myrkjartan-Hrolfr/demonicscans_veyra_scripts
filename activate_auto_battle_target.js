// ==UserScript==
// @name         Veyra - Smart Solo PvP Manager
// @namespace    local.veyra.smart-solo-pvp-battle
// @version      3.0.0
// @description  Manages Solo PvP matchmaking, battle speed, and deliberate skill selection.
// @match        https://demonicscans.org/pvp*
// @match        https://www.demonicscans.org/pvp*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const COMMAND_KEY = 'veyra:orchestrator:command:v1';
  const STATUS_KEY = 'veyra:worker:pvp:status:v1';
  const PROTOCOL_VERSION = 1;
  const WORKER_ID = 'pvp';

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
    statusHeartbeatMs: 5_000,
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

  function normalizeComparableText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function normalizeOrchestratorCommand(value) {
    if (!value || typeof value !== 'object' || Number(value.version) !== PROTOCOL_VERSION) {
      return null;
    }

    const visitId = String(value.visitId || '').trim();
    const taskId = String(value.taskId || '').trim();
    const phase = String(value.phase || '').trim();
    const returnPath = String(value.returnPath || '').trim();
    const issuedAt = finiteNumber(value.issuedAt);
    const deadlineAt = finiteNumber(value.deadlineAt);

    if (
      !visitId ||
      !taskId ||
      !['draining', 'running'].includes(phase) ||
      !returnPath.startsWith('/') ||
      issuedAt === null ||
      deadlineAt === null ||
      issuedAt < 0 ||
      deadlineAt < issuedAt
    ) {
      return null;
    }

    return {
      version: PROTOCOL_VERSION,
      visitId,
      taskId,
      phase,
      returnPath,
      issuedAt,
      deadlineAt,
    };
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
    if (!skill?.available) return false;

    const cost = finiteNumber(skill.cost);
    const resourceCost = finiteNumber(skill.resourceCost);

    // Skill metadata comes from the native, freshly rendered modal. If that
    // contract changes, do not guess that a paid skill is free.
    if (cost === null || resourceCost === null || cost < 0 || resourceCost < 0) {
      return false;
    }

    if (snapshot.tokens < cost || snapshot.resource < resourceCost) return false;

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

  function isFinishedBattleState({ statusText, rewardsVisible, allyAlive, enemyAlive }) {
    const status = normalizeComparableText(statusText);

    if (/victory|defeat|draw|battle ended|match ended|finished/.test(status) || rewardsVisible) {
      return true;
    }

    // Formation HTML is replaced while the desktop battle UI renders. During
    // that short window no living slot exists in the DOM, which is unknown
    // state rather than proof that a side was defeated. An explicit running
    // status is authoritative until the native UI publishes an end signal.
    if (/battle in progress|match in progress/.test(status)) return false;

    return allyAlive === false || enemyAlive === false;
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
    const rounds = roundsUntilFinalWish({ tokens, resource, finalCost, resourceMaximum });

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
    COMMAND_KEY,
    CONFIG,
    PROTOCOL_VERSION,
    SKILL_KEYS,
    STATUS_KEY,
    WORKER_ID,
    canSpendWithoutDelayingFinal,
    canUseSkill,
    chooseAttackPlan,
    isConfirmedSkillUse,
    isFinishedBattleState,
    normalizeOrchestratorCommand,
    parseInteger,
    roundsUntilFinalWish,
  });

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = testExports;
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
    reportKey: '',
    returnToLobbyTimer: null,
    matchmakeTimer: null,
    lastMatchmakeClickAt: 0,
    lobbyPollTimer: null,
    lobbyPollRunning: false,
    lobbyAbortController: null,
    storage: null,
    workerStatus: null,
    workerStatusSignature: '',
    workerStatusWrittenAt: 0,
    suspended: false,
    stopped: false,
  };

  // A separately installed legacy loop can stand down completely. This file
  // owns only Solo PvP matchmaking, combat, and the internal lobby return.
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
    if (runtime.reportKey === key) return;

    runtime.reportKey = key;
    console[level === 'error' ? 'warn' : 'info'](`[Smart Solo PvP] ${message}`);
  }

  function getLocalStorage() {
    try {
      return window.localStorage || null;
    } catch (error) {
      console.warn('[Smart Solo PvP] localStorage is unavailable:', error);
      return null;
    }
  }

  runtime.storage = getLocalStorage();

  function loadOrchestratorCommand() {
    if (!runtime.storage) return null;

    try {
      const raw = runtime.storage.getItem(COMMAND_KEY);
      return raw ? normalizeOrchestratorCommand(JSON.parse(raw)) : null;
    } catch (error) {
      console.warn('[Smart Solo PvP] Could not read the orchestrator command:', error);
      return null;
    }
  }

  function matchingRunningVisit(command = loadOrchestratorCommand()) {
    return command?.taskId === WORKER_ID && command.phase === 'running' ? command : null;
  }

  function matchingPvpCommand(command = loadOrchestratorCommand()) {
    return command?.taskId === WORKER_ID ? command : null;
  }

  function isDrainingCommand(command = loadOrchestratorCommand()) {
    return command?.phase === 'draining';
  }

  function shouldYieldToOtherTask(command = loadOrchestratorCommand()) {
    return Boolean(
      command &&
        command.taskId !== WORKER_ID &&
        (command.phase === 'draining' || command.phase === 'running'),
    );
  }

  function publishWorkerStatus(state, safeToLeave, message = '', visitId = '') {
    if (!runtime.storage) return null;

    const now = Date.now();
    const status = {
      version: PROTOCOL_VERSION,
      workerId: WORKER_ID,
      visitId: String(visitId || ''),
      state,
      safeToLeave: safeToLeave === true,
      updatedAt: now,
      message: String(message || ''),
    };
    const signature = JSON.stringify({ ...status, updatedAt: 0 });
    const semanticChange = signature !== runtime.workerStatusSignature;

    if (!semanticChange && now - runtime.workerStatusWrittenAt < CONFIG.statusHeartbeatMs) {
      return runtime.workerStatus;
    }

    try {
      runtime.storage.setItem(STATUS_KEY, JSON.stringify(status));
      runtime.workerStatus = status;
      runtime.workerStatusSignature = signature;
      runtime.workerStatusWrittenAt = now;
      return status;
    } catch (error) {
      console.warn('[Smart Solo PvP] Could not publish worker status:', error);
      runtime.storage = null;
      return null;
    }
  }

  function statusVisitId(command = loadOrchestratorCommand()) {
    return matchingPvpCommand(command)?.visitId || '';
  }

  function publishDrainedStatus(command) {
    const ownVisit = matchingPvpCommand(command);
    if (ownVisit) {
      return publishWorkerStatus(
        'done',
        true,
        'PvP is safely drained in the lobby.',
        ownVisit.visitId,
      );
    }

    return publishWorkerStatus('idle', true, 'PvP is ready for the scheduled hand-off.');
  }

  function isBattlePage() {
    return Boolean(
      document.querySelector(SELECTORS.fastEnemyButton) &&
        document.querySelector('#battleControlCard') &&
        document.querySelector('#enemyFormation'),
    );
  }

  function isPvpBattlePath() {
    return /\/pvp_battle\.php\/?$/i.test(window.location.pathname);
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
    if (runtime.lobbyPollTimer === null) return;
    window.clearTimeout(runtime.lobbyPollTimer);
    runtime.lobbyPollTimer = null;
  }

  function clearMatchmakeTimer() {
    if (runtime.matchmakeTimer === null) return;
    window.clearTimeout(runtime.matchmakeTimer);
    runtime.matchmakeTimer = null;
  }

  function pauseLobbyActivity() {
    clearLobbyPollTimer();
    clearMatchmakeTimer();
    runtime.lobbyAbortController?.abort();
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

    const initialCommand = loadOrchestratorCommand();
    if (
      matchingRunningVisit(initialCommand) ||
      isDrainingCommand(initialCommand) ||
      shouldYieldToOtherTask(initialCommand)
    ) {
      return;
    }

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

      const command = loadOrchestratorCommand();
      const visit = matchingRunningVisit(command);
      if (isDrainingCommand(command)) {
        publishDrainedStatus(command);
        return;
      }

      if (shouldYieldToOtherTask(command)) {
        publishDrainedStatus(command);
        return;
      }

      if (snapshot.canStart) {
        publishWorkerStatus('busy', false, 'A Solo token is available; refreshing PvP.', visit?.visitId);
        report('Solo token available; refreshing the lobby.');
        window.location.reload();
        return;
      }

      if (visit && snapshot.tokens === 0) {
        publishWorkerStatus('done', true, 'No Solo tokens remain.', visit.visitId);
        report('The scheduled PvP visit is complete; no Solo tokens remain.');
        return;
      }

      publishWorkerStatus('idle', true, `${snapshot.tokens ?? 0} Solo token(s); waiting.`);
      report(`${snapshot.tokens ?? 0} Solo token(s); checking again in 30 seconds.`);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[Smart Solo PvP] Lobby token check failed:', error);
        publishWorkerStatus('error', false, 'The PvP token check failed.', statusVisitId());
        report('Lobby token check failed; retrying in 30 seconds.', 'error');
      }
    } finally {
      window.clearTimeout(timeout);
      if (runtime.lobbyAbortController === controller) runtime.lobbyAbortController = null;
      runtime.lobbyPollRunning = false;

      const command = loadOrchestratorCommand();
      if (
        !matchingRunningVisit(command) &&
        !isDrainingCommand(command) &&
        !shouldYieldToOtherTask(command)
      ) {
        scheduleLobbyPoll();
      }
    }
  }

  function handleLobbyPage() {
    const command = loadOrchestratorCommand();
    const ownCommand = matchingPvpCommand(command);
    const visit = matchingRunningVisit(command);
    const snapshot = getLobbySnapshot();

    if (!snapshot.section) {
      publishWorkerStatus('error', true, 'The Solo ladder was not found.', ownCommand?.visitId);
      report('Solo ladder was not found; waiting for the lobby.', 'error');
      if (!ownCommand && !isDrainingCommand(command) && !shouldYieldToOtherTask(command)) {
        scheduleLobbyPoll();
      }
      return;
    }

    if (snapshot.button?.disabled) {
      clearLobbyPollTimer();
      publishWorkerStatus(
        'busy',
        false,
        'Solo matchmaking is in progress.',
        ownCommand?.visitId,
      );
      report('Solo matchmaking is already running.');
      return;
    }

    if (isDrainingCommand(command)) {
      pauseLobbyActivity();
      publishDrainedStatus(command);
      report('PvP is idle; waiting for the orchestrator hand-off.');
      return;
    }

    if (runtime.matchmakeTimer !== null) {
      clearLobbyPollTimer();
      publishWorkerStatus(
        'busy',
        false,
        'Solo matchmaking is in progress.',
        visit?.visitId,
      );
      report('Solo matchmaking is already running.');
      return;
    }

    if (shouldYieldToOtherTask(command)) {
      pauseLobbyActivity();
      publishDrainedStatus(command);
      report('PvP is idle; waiting for the orchestrator hand-off.');
      return;
    }

    if (!snapshot.canStart) {
      if (snapshot.tokens === 0) {
        if (visit) {
          clearLobbyPollTimer();
          publishWorkerStatus('done', true, 'No Solo tokens remain.', visit.visitId);
          report('The scheduled PvP visit is complete; no Solo tokens remain.');
        } else {
          publishWorkerStatus('idle', true, 'No Solo token is currently available.');
          report('0 Solo token(s); waiting for the next token.');
          scheduleLobbyPoll();
        }
        return;
      }

      publishWorkerStatus(
        'error',
        false,
        'The Solo token count or matchmaking control is unavailable.',
        visit?.visitId,
      );
      report('Solo matchmaking controls are incomplete; waiting for the lobby.', 'error');
      if (!visit) scheduleLobbyPoll();
      return;
    }

    clearLobbyPollTimer();
    const now = Date.now();
    publishWorkerStatus('busy', false, 'Starting Solo matchmaking.', visit?.visitId);
    if (now - runtime.lastMatchmakeClickAt < CONFIG.matchmakeRetryMs) return;

    runtime.lastMatchmakeClickAt = now;
    report(`${snapshot.tokens} Solo token(s); starting a new match.`);

    clearMatchmakeTimer();
    runtime.matchmakeTimer = window.setTimeout(() => {
      runtime.matchmakeTimer = null;
      const currentCommand = loadOrchestratorCommand();
      if (isDrainingCommand(currentCommand) || shouldYieldToOtherTask(currentCommand)) {
        publishDrainedStatus(currentCommand);
        return;
      }

      const current = getLobbySnapshot();
      if (current.canStart && current.button && !current.button.disabled) current.button.click();
    }, 250);
  }

  function cancelReturnToLobby() {
    if (runtime.returnToLobbyTimer === null) return;
    window.clearTimeout(runtime.returnToLobbyTimer);
    runtime.returnToLobbyTimer = null;
  }

  function scheduleReturnToLobby(command = loadOrchestratorCommand()) {
    publishWorkerStatus(
      'busy',
      false,
      'The PvP battle ended; returning to the PvP lobby.',
      statusVisitId(command),
    );
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
    return String(slot?.dataset?.username || document.querySelector('#allyBadge')?.textContent || '').trim();
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
      if (pending.prepareBridge) runtime.bridge = { targetKey: pending.targetKey };
      if (pending.consumeBridge || pending.resetCycle) runtime.bridge = null;
      runtime.pendingAction = null;
      return;
    }

    const latestTurn = getLatestTurnStart();
    const newerOwnTurn =
      latestTurn?.key &&
      latestTurn.key !== pending.turnKey &&
      normalizeText(latestTurn.actor) === allyName;

    if (newerOwnTurn) {
      if (pending.consumeBridge || pending.resetCycle) runtime.bridge = null;
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

  function isPageHidden() {
    return document.hidden === true || document.visibilityState === 'hidden';
  }

  async function scanPage() {
    if (runtime.scanRunning || runtime.stopped || runtime.suspended || isPageHidden()) return;
    runtime.scanRunning = true;

    try {
      if (!isBattlePage()) {
        delete document.documentElement.dataset.veyraSmartPvp;
        if (isPvpBattlePath()) {
          clearLobbyPollTimer();
          runtime.lobbyAbortController?.abort();
          publishWorkerStatus(
            'busy',
            false,
            'The Solo PvP battle page is still rendering.',
            statusVisitId(),
          );
        } else if (isLobbyPage()) {
          handleLobbyPage();
        } else {
          publishWorkerStatus('error', true, 'This PvP page is not recognized.', statusVisitId());
        }
        return;
      }

      // This marker only describes ownership of an actual PvP battle page.
      document.documentElement.dataset.veyraSmartPvp = '1';
      clearLobbyPollTimer();
      runtime.lobbyAbortController?.abort();

      const command = loadOrchestratorCommand();
      const visitId = statusVisitId(command);
      settlePendingAction();

      if (isBattleEnded()) {
        runtime.bridge = null;
        runtime.pendingAction = null;
        scheduleReturnToLobby(command);
        return;
      }

      cancelReturnToLobby();
      publishWorkerStatus('busy', false, 'A Solo PvP battle is in progress.', visitId);

      if (!ensureBattleMode()) return;

      const turn = getLatestTurnStart();
      if (!isOwnActionableTurn(turn) || runtime.handledTurnKey === turn.key) return;

      await actOnTurn(turn);
    } catch (error) {
      console.error('[Smart Solo PvP] Scan failed:', error);
      publishWorkerStatus('error', false, 'The PvP manager encountered an error.', statusVisitId());
    } finally {
      runtime.scanRunning = false;
    }
  }

  function scheduleScan() {
    if (runtime.stopped || runtime.suspended || runtime.scanTimer !== null) return;

    runtime.scanTimer = window.setTimeout(() => {
      runtime.scanTimer = null;
      void scanPage();
    }, CONFIG.scanDebounceMs);
  }

  function handleVisibilityChange() {
    if (isPageHidden()) {
      runtime.suspended = true;
      window.clearTimeout(runtime.scanTimer);
      runtime.scanTimer = null;
      return;
    }

    runtime.suspended = false;
    runtime.scanRunning = false;
    scheduleScan();
  }

  runtime.observer = new MutationObserver(scheduleScan);
  runtime.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'data-alive'],
  });

  runtime.interval = window.setInterval(scheduleScan, CONFIG.scanIntervalMs);
  document.addEventListener?.('visibilitychange', handleVisibilityChange);
  window.addEventListener?.('pageshow', () => {
    runtime.suspended = false;
    runtime.scanRunning = false;
    window.clearTimeout(runtime.scanTimer);
    runtime.scanTimer = null;
    scheduleScan();
  });
  window.addEventListener?.('pagehide', (event) => {
    if (event?.persisted) {
      runtime.suspended = true;
      window.clearTimeout(runtime.scanTimer);
      runtime.scanTimer = null;
      return;
    }

    runtime.stopped = true;
    document.removeEventListener?.('visibilitychange', handleVisibilityChange);
    runtime.observer?.disconnect();
    window.clearInterval(runtime.interval);
    window.clearTimeout(runtime.scanTimer);
    window.clearTimeout(runtime.returnToLobbyTimer);
    clearMatchmakeTimer();
    clearLobbyPollTimer();
    runtime.lobbyAbortController?.abort();
  });

  scheduleScan();
})();
