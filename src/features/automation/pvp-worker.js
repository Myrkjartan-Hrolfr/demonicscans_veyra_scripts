'use strict';

// Scheduler-owned Solo PvP worker. It consumes every available Solo token,
// returns to the lobby after each match, and reports a safe terminal status
// only from the lobby. Combat can use the game's Auto Play or the deliberate
// skill planner ported from activate_auto_battle_target.js.

const {
  COMMAND_KEY,
  normalizeVisit,
  publishWorkerStatus,
} = require('../../core/protocol');
const { createJsonStore, getStorage } = require('../../core/storage');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../../scheduler/engine');
const logic = require('./pvp-logic');

const ROUTE_ID = 'pvp';
const LOBBY_PATH = '/pvp.php';

const MODES = Object.freeze({
  autoplay: 'autoplay',
  skillPlanner: 'skill-planner',
});

const TIMING = Object.freeze({
  tickMs: 200,
  heartbeatMs: 5_000,
  modeRetryMs: 1_000,
  matchmakeRetryMs: 15_000,
  returnToLobbyMs: 3_000,
  renderGraceMs: 10_000,
  initialAutoPlayDelayMs: 1_500,
  skillWaitMs: 1_000,
  targetWaitMs: 1_000,
});

const SELECTORS = Object.freeze({
  soloMatchButton: '.js-matchmake[data-ladder="solo"]',
  section: 'section',
  sectionTitle: '.section-title',
  infoPill: '.info-pill',
  autoPlayButton: '#autoPlayBtn',
  fastEnemyButton: '#fastEnemyBtn',
  viewerMode: '#viewerModeBadge',
  matchStatus: '#matchStatusBadge',
  rewardsModal: '#rewardsModal',
  battleControl: '#battleControlCard',
  attackButton: '#attackBtn',
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
  tokenValue: '#myTokens',
  resourceValue: '#advancedResourceValue',
  nativeSkillModal: '#skillsModal',
  nativeSkillGrid: '#skillsGrid',
  logLines: '#logBox .logLine[data-log-id]',
});

function queryAll(root, selector) {
  return Array.from(root?.querySelectorAll?.(selector) || []);
}

function findSoloSection(root) {
  const button = root?.querySelector?.(SELECTORS.soloMatchButton);
  if (button?.closest) {
    const section = button.closest(SELECTORS.section);
    if (section) return section;
  }
  return (
    queryAll(root, SELECTORS.section).find((section) => {
      const title = logic.normalizeText(section.querySelector?.(SELECTORS.sectionTitle)?.textContent);
      return title.includes('solo') && title.includes('ladder');
    }) || null
  );
}

function readSoloTokenCount(root) {
  const section = findSoloSection(root);
  if (!section) return null;
  const pill =
    queryAll(section, SELECTORS.infoPill).find((candidate) =>
      logic.normalizeText(candidate.querySelector?.('strong')?.textContent).startsWith('tokens'),
    ) || null;
  return pill ? logic.parseInteger(pill.querySelector?.('span')?.textContent) : null;
}

function getLobbySnapshot(root) {
  const section = findSoloSection(root);
  const button = root?.querySelector?.(SELECTORS.soloMatchButton) || null;
  const tokens = readSoloTokenCount(root);
  return {
    section,
    button,
    tokens,
    canStart: Boolean(button) && Number.isFinite(tokens) && tokens > 0,
  };
}

function classContains(element, name) {
  return element?.classList?.contains?.(name) === true;
}

function isAutoPlayActive(root) {
  const button = root?.querySelector?.(SELECTORS.autoPlayButton);
  const viewerMode = logic.normalizeText(root?.querySelector?.(SELECTORS.viewerMode)?.textContent);
  const buttonText = logic.normalizeText(button?.textContent);
  return Boolean(
    classContains(button, 'active') ||
      button?.getAttribute?.('aria-pressed') === 'true' ||
      buttonText.includes('auto play on') ||
      viewerMode.includes('auto play enabled')
  );
}

function isFastEnemyActive(root) {
  const button = root?.querySelector?.(SELECTORS.fastEnemyButton);
  const viewerMode = logic.normalizeText(root?.querySelector?.(SELECTORS.viewerMode)?.textContent);
  const buttonText = logic.normalizeText(button?.textContent);
  return Boolean(
    classContains(button, 'active') ||
      button?.getAttribute?.('aria-pressed') === 'true' ||
      buttonText.includes('enemy turns 1s on') ||
      viewerMode.includes('enemy turns set to 1s')
  );
}

function aliveState(root, formationSelector, livingSelector, defeatedSelector) {
  if (!root?.querySelector?.(formationSelector)) return null;
  if (root.querySelector(livingSelector)) return true;
  return root.querySelector(defeatedSelector) ? false : null;
}

function isBattleEnded(root) {
  return logic.isFinishedBattleState({
    statusText: root?.querySelector?.(SELECTORS.matchStatus)?.textContent,
    rewardsVisible: classContains(root?.querySelector?.(SELECTORS.rewardsModal), 'show'),
    allyAlive: aliveState(
      root,
      SELECTORS.allyFormation,
      SELECTORS.allySlot,
      SELECTORS.defeatedAllySlot,
    ),
    enemyAlive: aliveState(
      root,
      SELECTORS.enemyFormation,
      SELECTORS.enemySlot,
      SELECTORS.defeatedEnemySlot,
    ),
  });
}

function isBattleUiReady(root) {
  return Boolean(
    root?.querySelector?.(SELECTORS.battleControl) &&
      root.querySelector(SELECTORS.enemyFormation) &&
      root.querySelector(SELECTORS.autoPlayButton) &&
      root.querySelector(SELECTORS.fastEnemyButton)
  );
}

function normalizedMode(value) {
  return value === MODES.skillPlanner ? MODES.skillPlanner : MODES.autoplay;
}

function createPvpWorker({
  win,
  doc,
  store,
  sessionStore = null,
  now = () => Date.now(),
  logger = console,
}) {
  const runtime = {
    interval: null,
    ticking: false,
    stopped: false,
    navigating: false,
    startedAt: now(),
    incompleteLobbyAt: 0,
    lastMatchmakeAt: 0,
    lastModeClickAt: 0,
    battleSeenAt: 0,
    returnTimer: null,
    publishSignature: '',
    publishAt: 0,
    logSignature: '',
    handledTurnKey: '',
    bridge: null,
    pendingAction: null,
  };

  function log(message, level = 'info') {
    const signature = `${level}:${message}`;
    if (runtime.logSignature === signature) return;
    runtime.logSignature = signature;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    logger?.[method]?.(`[Veyra:pvp-worker] ${message}`);
  }

  function currentUrl() {
    try {
      return new URL(win.location.href, win.location.origin);
    } catch {
      return null;
    }
  }

  function isLobbyUrl(url = currentUrl()) {
    return Boolean(url && /\/pvp\.php\/?$/i.test(url.pathname));
  }

  function isBattleUrl(url = currentUrl()) {
    return Boolean(url && /\/pvp_battle\.php\/?$/i.test(url.pathname));
  }

  function readCommand() {
    return normalizeVisit(store.read(COMMAND_KEY), () => true);
  }

  function ownCommand(command = readCommand()) {
    return command?.taskId === ROUTE_ID ? command : null;
  }

  // The scheduler already elects one tab through a localStorage lease. Reuse
  // that ownership here so a second open PvP tab cannot spend the same token
  // or submit a second skill. If sessionStorage is unavailable, retain the
  // scheduler's existing best-effort behaviour instead of disabling PvP.
  function ownsSchedulerLease(t = now()) {
    if (!sessionStore || sessionStore.available === false) return true;
    const tabId = sessionStore.readRaw?.(TAB_KEY);
    const lease = store.read(LEASE_KEY);
    return Boolean(
      tabId &&
        lease?.ownerId === tabId &&
        Number.isFinite(Number(lease?.leaseUntil)) &&
        Number(lease.leaseUntil) > t
    );
  }

  function visitIsDraining(command, t = now()) {
    return Boolean(command && (command.phase === 'draining' || t >= command.deadlineAt));
  }

  function readMode() {
    const saved = normalizeConfig(store.read(CONFIG_KEY)).routes[ROUTE_ID]?.settings?.mode;
    return normalizedMode(saved);
  }

  function publish(state, safeToLeave, message, visitId = '') {
    const t = now();
    const signature = `${visitId}|${state}|${safeToLeave}|${message}`;
    if (signature === runtime.publishSignature && t - runtime.publishAt < TIMING.heartbeatMs) return null;
    runtime.publishSignature = signature;
    runtime.publishAt = t;
    return publishWorkerStatus(
      store,
      ROUTE_ID,
      { visitId, workerId: ROUTE_ID, state, safeToLeave, message },
      t,
    );
  }

  function setLifecycleMarker(active, smart = false) {
    const dataset = doc?.documentElement?.dataset;
    if (!dataset) return;
    if (active) dataset.veyraSmartPvpLifecycle = '1';
    else delete dataset.veyraSmartPvpLifecycle;
    if (active && smart) dataset.veyraSmartPvp = '1';
    else delete dataset.veyraSmartPvp;
  }

  function navigateToLobby() {
    if (runtime.navigating) return false;
    runtime.navigating = true;
    win.location.replace(new URL(LOBBY_PATH, win.location.origin).href);
    return true;
  }

  function clearReturnTimer() {
    if (runtime.returnTimer === null) return;
    win.clearTimeout?.(runtime.returnTimer);
    runtime.returnTimer = null;
  }

  function scheduleLobbyReturn(command) {
    publish('busy', false, 'The Solo PvP battle ended; returning to the lobby.', command.visitId);
    if (runtime.returnTimer !== null) return;
    runtime.returnTimer = win.setTimeout?.(() => {
      runtime.returnTimer = null;
      if (!isBattleEnded(doc)) return;
      navigateToLobby();
    }, TIMING.returnToLobbyMs);
  }

  function handleLobby(command, t) {
    clearReturnTimer();
    runtime.battleSeenAt = 0;
    runtime.handledTurnKey = '';
    runtime.bridge = null;
    runtime.pendingAction = null;

    if (!command) {
      setLifecycleMarker(false);
      publish('idle', true, 'PvP is idle in the lobby.');
      return;
    }

    setLifecycleMarker(true, readMode() === MODES.skillPlanner);
    if (visitIsDraining(command, t)) {
      publish('done', true, 'PvP stopped safely in the lobby.', command.visitId);
      return;
    }

    const snapshot = getLobbySnapshot(doc);
    if (!snapshot.section) {
      if (t - runtime.startedAt < TIMING.renderGraceMs) {
        publish('busy', false, 'Waiting for the Solo PvP lobby to render.', command.visitId);
      } else {
        publish('error', true, 'The Solo ladder was not found.', command.visitId);
      }
      return;
    }

    if (snapshot.tokens === 0) {
      runtime.incompleteLobbyAt = 0;
      publish('done', true, 'No Solo tokens remain.', command.visitId);
      return;
    }

    if (!snapshot.button || snapshot.tokens === null) {
      if (!runtime.incompleteLobbyAt) runtime.incompleteLobbyAt = t;
      if (t - runtime.incompleteLobbyAt < TIMING.renderGraceMs) {
        publish('busy', false, 'Waiting for Solo token and matchmaking controls.', command.visitId);
      } else {
        publish('error', true, 'Solo matchmaking controls are incomplete.', command.visitId);
      }
      return;
    }
    runtime.incompleteLobbyAt = 0;

    if (snapshot.button.disabled) {
      publish('busy', false, 'Solo matchmaking is in progress.', command.visitId);
      return;
    }

    publish('busy', false, `Starting Solo matchmaking with ${snapshot.tokens} token(s).`, command.visitId);
    if (!snapshot.canStart || t - runtime.lastMatchmakeAt < TIMING.matchmakeRetryMs) return;
    runtime.lastMatchmakeAt = t;
    snapshot.button.click?.();
  }

  function modeControlReady(mode, t) {
    const autoButton = doc.querySelector?.(SELECTORS.autoPlayButton);
    if (mode === MODES.autoplay) {
      if (isAutoPlayActive(doc)) return true;
      if (runtime.battleSeenAt === 0) runtime.battleSeenAt = t;
      if (
        t - runtime.battleSeenAt < TIMING.initialAutoPlayDelayMs ||
        !autoButton ||
        autoButton.disabled
      ) {
        return false;
      }
      if (t - runtime.lastModeClickAt >= TIMING.modeRetryMs) {
        runtime.lastModeClickAt = t;
        log('Enabling the game Auto Play mode.');
        autoButton.click?.();
      }
      return false;
    }

    if (isAutoPlayActive(doc)) {
      if (autoButton && !autoButton.disabled && t - runtime.lastModeClickAt >= TIMING.modeRetryMs) {
        runtime.lastModeClickAt = t;
        log('Disabling Auto Play for the skill planner.');
        autoButton.click?.();
      }
      return false;
    }

    if (!isFastEnemyActive(doc)) {
      const fastButton = doc.querySelector?.(SELECTORS.fastEnemyButton);
      if (fastButton && !fastButton.disabled && t - runtime.lastModeClickAt >= TIMING.modeRetryMs) {
        runtime.lastModeClickAt = t;
        log('Enabling one-second enemy turns.');
        fastButton.click?.();
      }
      return false;
    }
    return true;
  }

  function getAllyName() {
    const slot = doc.querySelector?.(SELECTORS.allySlot);
    return String(slot?.dataset?.username || doc.querySelector?.('#allyBadge')?.textContent || '').trim();
  }

  function getLatestTurnStart() {
    const lines = queryAll(doc, SELECTORS.logLines);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      const text = String(line.querySelector?.('.logText')?.textContent || '').trim();
      const match = text.match(/^(.+?)\s+takes the turn\.?$/i);
      if (match) {
        return {
          key: String(line.dataset?.logId || ''),
          numericId: logic.parseInteger(line.dataset?.logId),
          actor: match[1].trim(),
        };
      }
    }
    return null;
  }

  function isOwnActionableTurn(turn) {
    const allyName = getAllyName();
    const attackButton = doc.querySelector?.(SELECTORS.attackButton);
    return Boolean(
      turn?.key &&
        allyName &&
        logic.normalizeText(turn.actor) === logic.normalizeText(allyName) &&
        attackButton &&
        !attackButton.disabled
    );
  }

  function skillKeyFromButton(button) {
    const id = String(button?.dataset?.skillId || '');
    const byId = Object.entries(logic.SKILL_IDS).find(([, skillId]) => skillId === id);
    if (byId) return byId[0];
    const name = logic.normalizeText(button?.querySelector?.('.skillName')?.textContent || button?.textContent);
    return (
      Object.keys(logic.SKILL_NAMES).find(
        (key) => logic.normalizeText(logic.SKILL_NAMES[key]) === name,
      ) || null
    );
  }

  function readSkills() {
    const skills = {};
    const grid = doc.querySelector?.(SELECTORS.nativeSkillGrid);
    for (const button of queryAll(grid, 'button.skillCard[data-skill-id]')) {
      const key = skillKeyFromButton(button);
      if (!key) continue;
      const cost = logic.parseInteger(button.dataset?.cost);
      const resourceCost = logic.parseInteger(button.dataset?.resourceCost);
      const metadataValid = cost !== null && resourceCost !== null && cost >= 0 && resourceCost >= 0;
      skills[key] = {
        key,
        name: String(button.querySelector?.('.skillName')?.textContent || logic.SKILL_NAMES[key]).trim(),
        cost,
        resourceCost,
        requiresFullResource: button.dataset?.requiresFullResource === '1',
        available: !button.disabled && metadataValid,
        button,
      };
    }
    return skills;
  }

  function readBattleSnapshot(target) {
    const resource = logic.parseFraction(doc.querySelector?.(SELECTORS.resourceValue)?.textContent);
    return {
      tokens: logic.parseInteger(doc.querySelector?.(SELECTORS.tokenValue)?.textContent),
      resource: resource?.current ?? null,
      resourceMaximum: resource?.maximum ?? logic.COMBAT_DEFAULTS.resourceMaximum,
      enemyPoisoned: classContains(target, 'hasPoison'),
      bridgePending: Boolean(runtime.bridge && runtime.bridge.targetKey === target?.dataset?.key),
      skills: readSkills(),
    };
  }

  function getLogTextsAfter(logId) {
    const numericId = logic.finiteNumber(logId);
    if (numericId === null) return [];
    return queryAll(doc, SELECTORS.logLines)
      .filter((line) => {
        const currentId = logic.parseInteger(line.dataset?.logId);
        return currentId !== null && currentId > numericId;
      })
      .map((line) => String(line.querySelector?.('.logText')?.textContent || '').trim());
  }

  function settlePendingAction() {
    const pending = runtime.pendingAction;
    if (!pending) return;
    const confirmed = getLogTextsAfter(pending.turnNumericId).some((text) =>
      logic.isConfirmedSkillUse(text, pending.allyName, pending.skillName),
    );
    if (confirmed) {
      if (pending.prepareBridge) runtime.bridge = { targetKey: pending.targetKey };
      if (pending.consumeBridge || pending.resetCycle) runtime.bridge = null;
      runtime.pendingAction = null;
      return;
    }

    const latestTurn = getLatestTurnStart();
    if (
      latestTurn?.key &&
      latestTurn.key !== pending.turnKey &&
      logic.normalizeText(latestTurn.actor) === logic.normalizeText(pending.allyName)
    ) {
      if (pending.consumeBridge || pending.resetCycle) runtime.bridge = null;
      runtime.pendingAction = null;
    }
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = now();
      const check = () => {
        const result = predicate();
        if (result || now() - startedAt >= timeoutMs || runtime.stopped || runtime.navigating) {
          resolve(result || null);
          return;
        }
        win.setTimeout?.(check, 40);
      };
      check();
    });
  }

  async function actOnTurn(turn) {
    let target = doc.querySelector?.(SELECTORS.enemySlot);
    if (!target) return;
    const modal = doc.querySelector?.(SELECTORS.nativeSkillModal);
    if (!classContains(target, 'targeted')) target.click?.();
    else if (modal && !classContains(modal, 'show')) doc.querySelector?.(SELECTORS.attackButton)?.click?.();

    const grid = await waitFor(() => {
      const nextModal = doc.querySelector?.(SELECTORS.nativeSkillModal);
      const nextGrid = doc.querySelector?.(SELECTORS.nativeSkillGrid);
      return classContains(nextModal, 'show') && nextGrid?.querySelector?.('button.skillCard[data-skill-id]')
        ? nextGrid
        : null;
    }, TIMING.skillWaitMs);
    if (!grid) return;

    const currentTurn = getLatestTurnStart();
    target = doc.querySelector?.(SELECTORS.enemySlot);
    if (!currentTurn || currentTurn.key !== turn.key || !target || isAutoPlayActive(doc)) return;
    if (!classContains(target, 'targeted')) {
      target.click?.();
      await waitFor(
        () => classContains(doc.querySelector?.(SELECTORS.enemySlot), 'targeted'),
        TIMING.targetWaitMs,
      );
    }

    const stableTurn = getLatestTurnStart();
    const stableTarget = doc.querySelector?.(SELECTORS.enemySlot);
    if (
      !stableTurn ||
      stableTurn.key !== turn.key ||
      !isOwnActionableTurn(stableTurn) ||
      !classContains(stableTarget, 'targeted') ||
      !classContains(doc.querySelector?.(SELECTORS.nativeSkillModal), 'show') ||
      isAutoPlayActive(doc) ||
      !isFastEnemyActive(doc)
    ) {
      return;
    }

    const snapshot = readBattleSnapshot(stableTarget);
    const decision = logic.chooseAttackPlan(snapshot);
    const selected = decision.skillKey ? snapshot.skills[decision.skillKey] : null;
    if (!selected || !logic.canUseSkill(selected, snapshot) || selected.button?.isConnected === false) {
      log(decision.reason, 'warn');
      return;
    }

    runtime.handledTurnKey = turn.key;
    runtime.pendingAction = {
      turnKey: turn.key,
      turnNumericId: turn.numericId,
      allyName: getAllyName(),
      skillName: selected.name,
      targetKey: stableTarget.dataset?.key || '',
      prepareBridge: decision.prepareBridge,
      consumeBridge: decision.consumeBridge,
      resetCycle: decision.resetCycle,
    };
    log(
      `${selected.name} | Tokens ${snapshot.tokens}, Energy ${snapshot.resource}/${snapshot.resourceMaximum} | ${decision.reason}`,
    );
    selected.button.click?.();
  }

  async function handleBattle(command, t) {
    const ended = isBattleEnded(doc);
    const ready = isBattleUiReady(doc);
    if (!command) {
      setLifecycleMarker(false);
      if (!ended && !ready && t - runtime.startedAt >= TIMING.renderGraceMs) {
        publish('error', true, 'The manual PvP battle page did not render.');
        return;
      }
      publish(
        ended ? 'idle' : 'busy',
        ended,
        ended ? 'The manual PvP battle has ended.' : 'A manual PvP battle is in progress.',
      );
      return;
    }

    const mode = readMode();
    setLifecycleMarker(true, mode === MODES.skillPlanner);
    if (ended) {
      runtime.bridge = null;
      runtime.pendingAction = null;
      scheduleLobbyReturn(command);
      return;
    }

    if (!ready) {
      if (t - runtime.startedAt < TIMING.renderGraceMs) {
        publish('busy', false, 'Waiting for the Solo PvP battle to render.', command.visitId);
      } else {
        publish('error', true, 'The Solo PvP battle page did not render.', command.visitId);
      }
      return;
    }

    clearReturnTimer();
    publish(
      'busy',
      false,
      visitIsDraining(command, t)
        ? 'Finishing the current Solo PvP battle before stopping.'
        : `Solo PvP battle is running (${mode === MODES.autoplay ? 'Game Auto Play' : 'skill planner'}).`,
      command.visitId,
    );

    if (!modeControlReady(mode, t) || mode !== MODES.skillPlanner) return;
    settlePendingAction();
    const turn = getLatestTurnStart();
    if (!isOwnActionableTurn(turn) || runtime.handledTurnKey === turn.key) return;
    await actOnTurn(turn);
  }

  async function tick() {
    if (runtime.stopped || runtime.ticking || runtime.navigating) return;
    runtime.ticking = true;
    try {
      const url = currentUrl();
      const command = ownCommand();
      const t = now();
      if (command && !ownsSchedulerLease(t)) {
        setLifecycleMarker(false);
        return;
      }
      if (isLobbyUrl(url)) handleLobby(command, t);
      else if (isBattleUrl(url)) await handleBattle(command, t);
    } catch (error) {
      const command = ownCommand();
      log(`PvP worker error: ${error?.message || error}`, 'error');
      publish('error', isLobbyUrl(), `PvP worker failed: ${error?.message || error}`, command?.visitId);
    } finally {
      runtime.ticking = false;
    }
  }

  function onVisibilityChange() {
    if (doc.hidden !== true && doc.visibilityState !== 'hidden') void tick();
  }

  function onPageShow() {
    runtime.navigating = false;
    runtime.ticking = false;
    void tick();
  }

  function onPageHide(event) {
    if (!event?.persisted) stop();
  }

  function start() {
    runtime.interval = win.setInterval?.(() => void tick(), TIMING.tickMs) ?? null;
    doc.addEventListener?.('visibilitychange', onVisibilityChange);
    win.addEventListener?.('pageshow', onPageShow);
    win.addEventListener?.('pagehide', onPageHide);
    void tick();
  }

  function stop() {
    runtime.stopped = true;
    if (runtime.interval !== null) win.clearInterval?.(runtime.interval);
    runtime.interval = null;
    clearReturnTimer();
    doc.removeEventListener?.('visibilitychange', onVisibilityChange);
    win.removeEventListener?.('pageshow', onPageShow);
    win.removeEventListener?.('pagehide', onPageHide);
  }

  return {
    runtime,
    start,
    stop,
    tick,
    onPageShow,
    onPageHide,
    onVisibilityChange,
  };
}

const pvpWorkerFeature = Object.freeze({
  id: 'pvp-worker',
  group: 'Automation',
  settings: [],
  matches(url) {
    return /\/(?:pvp|pvp_battle)\.php\/?$/i.test(url.pathname);
  },
  run(ctx) {
    const worker = createPvpWorker({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      sessionStore: createJsonStore(getStorage('sessionStorage', ctx.win), '[Veyra]'),
    });
    worker.start();
    return worker;
  },
});

module.exports = {
  LOBBY_PATH,
  MODES,
  ROUTE_ID,
  SELECTORS,
  TIMING,
  createPvpWorker,
  findSoloSection,
  getLobbySnapshot,
  isAutoPlayActive,
  isBattleEnded,
  isBattleUiReady,
  isFastEnemyActive,
  normalizedMode,
  pvpWorkerFeature,
  readSoloTokenCount,
};
