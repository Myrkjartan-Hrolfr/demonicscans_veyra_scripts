'use strict';

// Wave 3 / Olympus boss worker. Generalizes wave_3_boss_manager.js:
//   - acts only during a scheduler visit for 'wave3' or 'olympus'
//   - walks the planned domains (Wave 3 has one), fights every enabled alive
//     boss until its damage target is reached, then reports done
//   - the fight itself is delegated to Monster Auto Battle through
//     features/battle/mab-bridge.js
// Progress lives in a private run state (localStorage, tied to the visit id)
// so reloads, navigation and mobile tab freezes resume where they left off.

const { formatGameNumber } = require('../../core/numbers');
const { COMMAND_KEY, publishWorkerStatus } = require('../../core/protocol');
const { createJsonStore, getStorage } = require('../../core/storage');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const mabBridge = require('../battle/mab-bridge');
const dom = require('./boss-dom');
const logic = require('./boss-logic');

const { TIMING, VISIT_PARAM } = logic;
const LOG_PREFIX = '[Veyra:boss-worker]';
const JOIN_URL = 'user_join_battle.php';
const PHASE_DUEL_STATE_URL = '/pvp_style_state.php';
const PHASE_DUEL_ACTION_URL = '/pvp_style_action.php';

function createBossWorker({
  win,
  doc,
  store,
  sessionStore = null,
  postForm,
  fetchJson = null,
  getUserId,
  bridge = mabBridge,
  now = () => Date.now(),
  logger = console,
}) {
  const rt = {
    ownerId: '',
    ownerRestored: false,
    navigating: false,
    ticking: false,
    stopped: false,
    interval: null,
    startedAt: now(),
    lastTickAt: 0,
    publishKey: '',
    publishMessage: '',
    publishAt: 0,
    lastLog: '',
    lastLogKey: '',
    actionPending: false,
    fight: null,
    fightStarting: false,
    stopRequestedAt: 0,
  };

  // ------------------------------------------------------------- helpers

  function log(message, level = 'info') {
    rt.lastLog = message;
    const key = `${level}:${message}`;
    if (rt.lastLogKey === key) return;
    rt.lastLogKey = key;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    logger?.[method]?.(`${LOG_PREFIX} ${message}`);
  }

  function initOwner() {
    const saved = sessionStore?.readRaw?.(logic.OWNER_KEY);
    if (saved) {
      rt.ownerId = saved;
      rt.ownerRestored = true;
      return;
    }
    rt.ownerId = `tab-${now()}-${Math.random().toString(36).slice(2)}`;
    sessionStore?.writeRaw?.(logic.OWNER_KEY, rt.ownerId);
  }

  function currentUrl() {
    try {
      return new URL(win.location.href);
    } catch {
      return null;
    }
  }

  function navigate(path, visitId) {
    if (rt.navigating) return false;
    rt.navigating = true;
    const origin = win.location.origin || 'https://demonicscans.org';
    win.location.replace(logic.withVisit(path, visitId, origin).href);
    return true;
  }

  function reloadPage() {
    if (rt.navigating) return;
    rt.navigating = true;
    win.location.replace(win.location.href);
  }

  // Heartbeat: unchanged states are re-published every heartbeatMs so the
  // scheduler (freshness 15 s) never sees a stale status.
  function publish(routeId, visitId, state, safeToLeave, message = '') {
    if (!routeId) return;
    const t = now();
    const key = `${routeId}|${visitId}|${state}|${safeToLeave}`;
    const minGap = key === rt.publishKey && message !== rt.publishMessage ? 1_000 : TIMING.heartbeatMs;
    if (key === rt.publishKey && t - rt.publishAt < minGap) return;
    publishWorkerStatus(
      store,
      routeId,
      { visitId, workerId: routeId, state, safeToLeave, message },
      t,
    );
    rt.publishKey = key;
    rt.publishMessage = message;
    rt.publishAt = t;
  }

  function forcePublishNext() {
    rt.publishKey = '';
  }

  function loadRun(t = now()) {
    return logic.normalizeRunState(store.read(logic.RUN_KEY), t);
  }

  function saveRun(run) {
    store.write(logic.RUN_KEY, run);
    return run;
  }

  function loadRouteConfig(routeId) {
    return normalizeConfig(store.read(CONFIG_KEY)).routes[routeId] || null;
  }

  function readCommand(t = now()) {
    return logic.evaluateCommand(store.read(COMMAND_KEY), t);
  }

  // Single-owner lease, like the original: another tab only waits.
  function acquire(run, t, url) {
    if (!run) return null;
    if (run.ownerId === rt.ownerId) {
      return logic.leaseNeedsRenewal(run, t) ? saveRun(logic.withLease(run, rt.ownerId, t)) : run;
    }
    if (logic.isLeaseHeldByOther(run, rt.ownerId, t)) {
      // Mobile browsers can drop sessionStorage while keeping the tab. A page
      // that was navigated to inside this visit adopts the run's owner.
      const visitParam = url?.searchParams?.get(VISIT_PARAM) || '';
      if (!rt.ownerRestored && visitParam && visitParam === run.visitId) {
        rt.ownerId = run.ownerId;
        rt.ownerRestored = true;
        sessionStore?.writeRaw?.(logic.OWNER_KEY, run.ownerId);
        return saveRun(logic.withLease(run, rt.ownerId, t));
      }
      return null;
    }
    saveRun(logic.withLease(run, rt.ownerId, t));
    const verified = loadRun(t);
    return verified?.ownerId === rt.ownerId ? verified : null;
  }

  function finish(run, state, message, t = now()) {
    const finished = saveRun(logic.finishRun(run, state, message, t));
    forcePublishNext();
    publish(finished.routeId, finished.visitId, finished.finished.state, true, message);
    log(message, state === 'error' ? 'warn' : 'info');
    return finished;
  }

  function hubPathFor(run) {
    const domainId = run.target?.domainId || run.domainId;
    return (
      logic.findDomain(run.routeId, domainId)?.path ||
      logic.allDomains(run.routeId)[0]?.path ||
      '/active_wave.php'
    );
  }

  function returnToHub(run) {
    navigate(hubPathFor(run), run.visitId);
  }

  // ----------------------------------------------------------------- hub

  function hubTick(url, t) {
    const pageRoute = logic.hubRouteForUrl(url);
    const label = logic.routeLabel(pageRoute);
    const cmd = readCommand(t);
    let run = loadRun(t);

    if (cmd.kind === 'none' || cmd.routeId !== pageRoute) {
      publish(pageRoute, '', 'idle', true, `${label} boss worker is idle.`);
      return;
    }

    if (run && run.visitId === cmd.visitId && run.finished) {
      publish(pageRoute, run.visitId, run.finished.state, true, run.finished.message);
      return;
    }

    if (cmd.kind !== 'running') {
      const ours = run && run.visitId === cmd.visitId ? acquire(run, t, url) : null;
      if (ours) {
        finish(
          ours,
          'done',
          cmd.kind === 'expired'
            ? `${label} reached its time limit; stopped safely at the boss hub.`
            : `${label} stopped safely at the boss hub.`,
          t,
        );
      } else if (!run || run.visitId !== cmd.visitId) {
        publish(pageRoute, cmd.visitId, 'idle', true, `${label} boss worker is waiting for the scheduler.`);
      }
      return;
    }

    if (!run || run.visitId !== cmd.visitId) {
      // A new scheduler visit is authoritative and never inherits an old run.
      run = saveRun(
        logic.createRunState({ visitId: cmd.visitId, routeId: cmd.routeId, ownerId: rt.ownerId, now: t }),
      );
      rt.ownerRestored = true;
      log(`${label} boss visit started.`);
    }

    run = acquire(run, t, url);
    if (!run) {
      log('Another tab owns the active boss run; this tab is waiting.');
      return;
    }

    if (!rt.actionPending) hubStep(run, url, t);

    const latest = loadRun(t);
    if (latest && latest.visitId === run.visitId && !latest.finished) {
      publish(run.routeId, run.visitId, 'busy', false, rt.lastLog || `${label} boss run is working.`);
    }
  }

  function advanceDomain(run, plan, t) {
    const current = logic.findDomain(run.routeId, run.domainId);
    const nextId = logic.nextDomainId(run.routeId, plan, run.domainId);
    if (!nextId) {
      finish(run, 'done', logic.summaryMessage(run), t);
      return;
    }
    const nextDomain = plan.find((domain) => domain.id === nextId);
    const next = saveRun(logic.recordAction(logic.enterDomain(run, nextId, t), 'goto-domain', t));
    log(`${current?.label || 'Domain'} is done; opening ${nextDomain.label}.`);
    navigate(nextDomain.path, next.visitId);
  }

  function ensureAliveFilter(run, url, t) {
    if (logic.isAliveFilterActive(dom.readCookieText(doc), url)) {
      return run.action.kind === 'wave-filter' ? saveRun(logic.clearAction(run)) : run;
    }
    if (run.action.kind === 'wave-filter' && !logic.actionReady(run, 'wave-filter', t)) {
      log('Waiting for the alive-monsters filter to be applied.');
      return null;
    }
    if (logic.actionExhausted(run, 'wave-filter')) {
      finish(run, 'error', 'The alive-monsters filter could not be saved.', t);
      return null;
    }
    saveRun(logic.recordAction(run, 'wave-filter', t));
    dom.setCookie(doc, 'hide_dead_monsters', '1');
    dom.setCookie(doc, 'show_dead_bosses_only', '0');
    const next = new URL(url.href);
    next.searchParams.delete('dead_page');
    if (!logic.isAliveFilterActive(dom.readCookieText(doc), next)) {
      log('The alive-monsters filter has not been accepted yet.', 'warn');
      return null;
    }
    log('Switching to the alive-monsters view before checking bosses.');
    navigate(`${next.pathname}${next.search}`, run.visitId);
    return null;
  }

  function hubStep(initialRun, url, t) {
    let run = initialRun;
    const routeId = run.routeId;
    const label = logic.routeLabel(routeId);
    const plan = logic.buildPlan(routeId, loadRouteConfig(routeId));

    if (plan.length === 0) {
      finish(run, 'done', `${label}: no bosses are enabled.`, t);
      return;
    }

    if (!run.domainId || !plan.some((domain) => domain.id === run.domainId)) {
      const nextId = logic.nextDomainId(routeId, plan, run.domainId);
      if (!nextId) {
        finish(run, 'done', logic.summaryMessage(run), t);
        return;
      }
      run = saveRun(logic.enterDomain(run, nextId, t));
    }
    const domain = plan.find((candidate) => candidate.id === run.domainId);

    if (logic.domainIdForUrl(routeId, url) !== domain.id) {
      if (
        run.action.kind === 'goto-domain' &&
        !logic.actionReady(run, 'goto-domain', t, TIMING.navigationRetryMs)
      ) {
        log(`Waiting to reach ${domain.label}.`);
        return;
      }
      if (logic.actionExhausted(run, 'goto-domain')) {
        log(`${domain.label} could not be opened; skipping it.`, 'warn');
        advanceDomain({ ...run, lastError: `${domain.label} could not be opened.` }, plan, t);
        return;
      }
      run = saveRun(logic.recordAction(run, 'goto-domain', t));
      log(`Opening ${domain.label}.`);
      navigate(domain.path, run.visitId);
      return;
    }
    if (run.action.kind === 'goto-domain') run = saveRun(logic.clearAction(run));
    if (run.phase !== 'hub') run = saveRun(logic.settleOnHub(run, t));

    run = ensureAliveFilter(run, url, t);
    if (!run) return;

    if (t - rt.startedAt < TIMING.hubSettleMs) {
      log('Waiting briefly for the boss cards to render.');
      return;
    }

    if (!dom.hasBossList(doc)) {
      if (t - rt.startedAt < TIMING.hubEmptyWaitMs) {
        log('Waiting for the boss list to render.');
        return;
      }
      if (logic.actionExhausted(run, 'reload-hub')) {
        log(`The ${domain.label} boss list did not render; skipping it.`, 'warn');
        advanceDomain({ ...run, lastError: `${domain.label} boss list did not render.` }, plan, t);
        return;
      }
      run = saveRun(logic.recordAction(run, 'reload-hub', t));
      log('The boss list did not render; reloading the hub.', 'warn');
      navigate(domain.path, run.visitId);
      return;
    }
    if (run.action.kind === 'reload-hub') run = saveRun(logic.clearAction(run));

    const matches = logic.matchHubBosses({
      bosses: domain.bosses,
      summons: dom.readSummons(doc),
      cards: dom.readMonsterCards(doc),
    });
    const next = logic.chooseNextBoss(matches, run);
    if (!next) {
      advanceDomain(run, plan, t);
      return;
    }

    if (run.target?.monsterId !== next.monsterId) run = saveRun(logic.selectTarget(run, next, domain.id, t));

    if (next.joined === false) {
      if (!logic.actionReady(run, 'join', t)) {
        log(`Waiting for ${next.name} to accept the join.`);
        return;
      }
      if (logic.actionExhausted(run, 'join')) {
        saveRun(logic.failTarget(run, 'Join Battle did not complete after several attempts.', t, { abandon: true }));
        log(`Joining ${next.name} failed repeatedly; skipping it.`, 'warn');
        return;
      }
      run = saveRun(logic.recordAction(run, 'join', t));
      log(`Joining ${next.name}.`);
      startHubJoin(run, next);
      return;
    }

    openBattle(run, t);
  }

  function openBattle(run, t) {
    const next = saveRun(logic.beginFight(run, t));
    log(`Opening the battle against ${next.target.name} (target ${next.target.damage}).`);
    navigate(logic.battlePath(next.target.monsterId), next.visitId);
  }

  function startHubJoin(run, match) {
    rt.actionPending = true;
    void (async () => {
      try {
        const userId = await getUserId?.();
        let text = '';
        let ok = true;
        if (userId) {
          const response = await postForm(JOIN_URL, { monster_id: match.monsterId, user_id: userId });
          text = String(response?.text || '').trim();
          ok = logic.isJoinSuccess(text);
        }
        const t = now();
        const latest = loadRun(t);
        const cmd = readCommand(t);
        if (
          !latest ||
          latest.finished ||
          latest.ownerId !== rt.ownerId ||
          latest.visitId !== run.visitId ||
          cmd.kind !== 'running' ||
          cmd.visitId !== run.visitId ||
          latest.target?.monsterId !== match.monsterId
        ) {
          return;
        }
        if (!ok && logic.isJoinFatal(text)) {
          saveRun(logic.failTarget(latest, `${match.name} cannot be joined: ${text}`, t, { abandon: true }));
          log(`${match.name} cannot be joined (${text}); skipping it.`, 'warn');
          return;
        }
        if (!ok) {
          log(`Joining ${match.name} failed (${text || 'no answer'}); retrying.`, 'warn');
          return;
        }
        if (!userId) log('The user id is unknown; joining on the battle page instead.');
        openBattle(latest, t);
      } catch (error) {
        log(`The join request failed: ${error?.message || error}`, 'warn');
      } finally {
        rt.actionPending = false;
      }
    })();
  }

  // -------------------------------------------------------------- battle

  function controllerState(controller) {
    try {
      return controller?.getState?.() || null;
    } catch {
      return null;
    }
  }

  function currentController() {
    return rt.fight?.controller || bridge?.getController?.() || null;
  }

  function detachFight() {
    const fight = rt.fight;
    rt.fight = null;
    try {
      fight?.unsubscribe?.();
    } catch {
      // ignore
    }
  }

  function attachFight(controller, monsterId, damageTarget) {
    detachFight();
    const fight = { controller, monsterId, damageTarget, handled: false, unsubscribe: null };
    rt.fight = fight;
    try {
      fight.unsubscribe = controller.onChange?.(() => checkFight()) || null;
    } catch {
      fight.unsubscribe = null;
    }
  }

  // The run as it must still be for a pending battle action to continue.
  function validateBattleRun(visitId, monsterId, t) {
    const run = loadRun(t);
    const cmd = readCommand(t);
    return run &&
      !run.finished &&
      run.ownerId === rt.ownerId &&
      run.visitId === visitId &&
      cmd.kind === 'running' &&
      cmd.visitId === visitId &&
      run.target?.monsterId === monsterId
      ? run
      : null;
  }

  function stopAndFinish(run, cmd, t) {
    const label = logic.routeLabel(run.routeId);
    const message =
      cmd.kind === 'none' || cmd.visitId !== run.visitId
        ? 'The scheduler visit ended; the boss fight was stopped.'
        : cmd.kind === 'expired'
          ? `${label} reached its time limit; the boss fight was stopped safely.`
          : `${label} stopped safely during a boss fight.`;

    const controller = currentController();
    if (!rt.stopRequestedAt) {
      rt.stopRequestedAt = t;
      try {
        controller?.stop?.();
      } catch (error) {
        log(`Monster Auto Battle could not be stopped: ${error?.message || error}`, 'warn');
      }
    }
    if (controllerState(controller)?.running && t - rt.stopRequestedAt < TIMING.stopWaitMs) {
      publish(run.routeId, run.visitId, 'busy', false, 'Stopping Monster Auto Battle …');
      return;
    }
    detachFight();
    finish(run, 'done', message, t);
  }

  function battleTick(url, t) {
    const visitParam = url.searchParams.get(VISIT_PARAM) || '';
    let run = loadRun(t);
    // Never touch a battle that was not opened by this visit.
    if (!run || !visitParam || run.visitId !== visitParam) return;

    const cmd = readCommand(t);
    if (run.finished) {
      if (cmd.visitId === run.visitId) {
        publish(run.routeId, run.visitId, run.finished.state, true, run.finished.message);
      }
      return;
    }

    run = acquire(run, t, url);
    if (!run) {
      log('Another tab owns the active boss run; this tab is waiting.');
      return;
    }

    if (cmd.kind !== 'running' || cmd.visitId !== run.visitId) {
      stopAndFinish(run, cmd, t);
      return;
    }

    if (!run.target) {
      log('No boss fight is open; returning to the hub.');
      returnToHub(run);
      return;
    }

    const pageId = dom.battleMonsterId(url, doc);
    if (pageId !== run.target.monsterId) {
      saveRun(
        logic.failTarget(
          run,
          `Opened monster ${pageId || 'unknown'} instead of ${run.target.monsterId}.`,
          t,
          { abandon: true },
        ),
      );
      log(`Opened monster ${pageId || 'unknown'} instead of ${run.target.monsterId}; returning.`, 'warn');
      returnToHub(run);
      return;
    }

    const phaseDuel = dom.findPhaseDuelControl(doc, win.location.origin);
    if (phaseDuel && run.routeId === 'olympus' && run.target.phased) {
      if (phaseDuel.activeId !== run.target.monsterId) {
        saveRun(
          logic.failTarget(
            run,
            `Phase duel ${phaseDuel.activeId} did not match boss ${run.target.monsterId}.`,
            t,
            { abandon: true },
          ),
        );
        log('The phase-duel link points to a different boss; returning to the domain.', 'warn');
        returnToHub(run);
        return;
      }
      try {
        currentController()?.stop?.();
      } catch {
        // The phase page normally has no running MAB controller.
      }
      detachFight();
      run = saveRun(logic.setPhase(run, 'duel', t));
      log(`Entering ${run.target.name}'s Phase 2 duel.`);
      navigate(phaseDuel.href, run.visitId);
      return;
    }

    if (run.phase !== 'battle') run = saveRun(logic.setPhase(run, 'battle', t));

    const damageTarget = logic.battleDamageTarget(run.target, dom.isAscendedBattle(doc));

    if (rt.fight) {
      checkFight();
      return;
    }
    publish(run.routeId, run.visitId, 'busy', false, rt.lastLog || `Preparing the fight against ${run.target.name}.`);
    if (!rt.fightStarting) startFight(run, damageTarget);
  }

  function startFight(run, damageTarget) {
    rt.fightStarting = true;
    const { visitId } = run;
    const { monsterId } = run.target;
    void (async () => {
      try {
        const joinControl = dom.findBattleJoinControl(doc);
        if (joinControl) {
          await joinOnBattlePage(run, joinControl);
          return;
        }

        let latest = validateBattleRun(visitId, monsterId, now());
        if (!latest) return;
        if (logic.actionExhausted(latest, 'controller')) {
          saveRun(logic.failTarget(latest, 'Monster Auto Battle did not become ready.', now(), { abandon: true }));
          log('Monster Auto Battle did not become ready; skipping this boss.', 'warn');
          returnToHub(latest);
          return;
        }
        latest = saveRun(logic.recordAction(latest, 'controller', now()));
        log('Waiting for Monster Auto Battle.');
        const controller = await bridge.whenController(TIMING.controllerWaitMs);

        const t = now();
        const current = validateBattleRun(visitId, monsterId, t);
        if (!current) return;
        if (!controller) {
          log('Monster Auto Battle did not register; reloading the battle page.', 'warn');
          reloadPage();
          return;
        }
        configureAndStart(controller, current, damageTarget, t);
      } catch (error) {
        log(`Starting the boss fight failed: ${error?.message || error}`, 'warn');
      } finally {
        rt.fightStarting = false;
      }
    })();
  }

  async function joinOnBattlePage(run, control) {
    let t = now();
    let latest = validateBattleRun(run.visitId, run.target.monsterId, t);
    if (!latest) return;
    if (latest.action.kind === 'join-page' && !logic.actionReady(latest, 'join-page', t)) {
      log(`Waiting for ${latest.target.name} to accept the join.`);
      return;
    }
    if (logic.actionExhausted(latest, 'join-page')) {
      saveRun(logic.failTarget(latest, 'Join the Battle did not make this boss fightable.', t, { abandon: true }));
      log('Join the Battle did not work; skipping this boss.', 'warn');
      returnToHub(latest);
      return;
    }
    latest = saveRun(logic.recordAction(latest, 'join-page', t));
    log(`Joining ${latest.target.name} on the battle page.`);

    const userId = await getUserId?.();
    if (!userId) {
      // The game's own button joins and reloads the page on success.
      control.click?.();
      return;
    }
    const response = await postForm(JOIN_URL, { monster_id: latest.target.monsterId, user_id: userId });
    const text = String(response?.text || '').trim();
    t = now();
    const current = validateBattleRun(run.visitId, run.target.monsterId, t);
    if (!current) return;
    if (logic.isJoinSuccess(text)) {
      log('Joined the battle; reloading the battle page.');
      reloadPage();
      return;
    }
    if (logic.isJoinFatal(text)) {
      saveRun(logic.failTarget(current, `${current.target.name} cannot be joined: ${text}`, t, { abandon: true }));
      log(`${current.target.name} cannot be joined (${text}); returning.`, 'warn');
      returnToHub(current);
      return;
    }
    log(`Joining failed (${text || 'no answer'}); retrying.`, 'warn');
  }

  function configureAndStart(controller, run, damageTarget, t) {
    const routeConfig = loadRouteConfig(run.routeId);
    const skills = routeConfig?.settings?.skills?.length ? [...routeConfig.settings.skills] : ['0'];
    const potions = {
      stamina: [...(routeConfig?.potions?.stamina || [])],
      heal: [...(routeConfig?.potions?.heal || [])],
    };

    attachFight(controller, run.target.monsterId, damageTarget);
    controller.setTargetDamage(damageTarget.damageValue);
    const state = controllerState(controller);
    const alreadyDone =
      state?.finished &&
      logic.decideAfterFight(state.reason) === 'complete' &&
      (state.reason === 'defeated' || Number(state.yourDamage) >= damageTarget.damageValue);

    if (state?.running) {
      log(`Monster Auto Battle is already running against ${run.target.name}; watching it.`);
    } else if (!alreadyDone) {
      if (controller.setAttacks(skills) === false) {
        detachFight();
        finish(run, 'error', 'None of the configured attacks is available in Monster Auto Battle.', t);
        return;
      }
      controller.setPotions(potions);
      controller.start();
      log(
        `Monster Auto Battle started against ${run.target.name} with a ${damageTarget.damage} Phase ${damageTarget.phase} target.`,
      );
    }
    saveRun(logic.clearAction(run));
    checkFight();
  }

  function checkFight() {
    const fight = rt.fight;
    if (!fight || fight.handled || rt.stopRequestedAt) return;
    const state = controllerState(fight.controller);
    if (!state) return;
    const t = now();
    const run = loadRun(t);
    if (!run || run.finished || run.ownerId !== rt.ownerId || run.target?.monsterId !== fight.monsterId) return;

    if (!state.finished) {
      const damage = Number.isFinite(Number(state.yourDamage)) ? formatGameNumber(state.yourDamage) : '?';
      publish(
        run.routeId,
        run.visitId,
        'busy',
        false,
        `Fighting ${run.target.name} (Phase ${fight.damageTarget.phase}): ${damage} / ${fight.damageTarget.damage}.`,
      );
      return;
    }

    fight.handled = true;
    detachFight();
    const label = logic.routeLabel(run.routeId);
    const decision = logic.decideAfterFight(state.reason);
    if (decision === 'complete') {
      saveRun(logic.completeTarget(run, t));
      log(
        state.reason === 'defeated'
          ? `${run.target.name} was defeated; returning to the hub.`
          : `${run.target.name} reached the ${fight.damageTarget.damage} Phase ${fight.damageTarget.phase} target; returning to the hub.`,
      );
      returnToHub(run);
    } else if (decision === 'stop-visit') {
      finish(run, 'done', `${label}: out of stamina, the visit ends here.`, t);
    } else {
      const reasonText = `Monster Auto Battle stopped (${state.reason || 'unknown'})${state.message ? `: ${state.message}` : ''}.`;
      saveRun(logic.failTarget(run, reasonText, t));
      log(`${reasonText} Returning to the hub.`, 'warn');
      returnToHub(run);
    }
  }

  // -------------------------------------------------------- Olympus duel

  async function requestPhaseDuelState(monsterId) {
    const url = new URL(PHASE_DUEL_STATE_URL, win.location.origin || 'https://demonicscans.org');
    url.searchParams.set('source', 'monster_phase');
    url.searchParams.set('since_log_id', '0');
    url.searchParams.set('active_id', String(monsterId));

    if (fetchJson) {
      const result = await fetchJson(url.href);
      const json = result?.json || result;
      if (result?.ok === false || !json || json.ok === false) {
        throw new Error(String(json?.error || json?.message || `Phase state failed (${result?.status || '?'})`));
      }
      return json;
    }

    if (typeof win.fetch !== 'function') throw new Error('Phase state cannot be requested on this page.');
    const response = await win.fetch(url.href, { credentials: 'same-origin', cache: 'no-store' });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // The error below deliberately rejects login and HTML error pages.
    }
    if (!response.ok || !json || json.ok === false) {
      throw new Error(String(json?.error || json?.message || `Phase state failed (${response.status})`));
    }
    return json;
  }

  function requireSuccessfulPhaseAction(response) {
    const json = response?.json;
    if (response?.ok === false || json?.ok === false) {
      throw new Error(String(json?.error || json?.message || response?.text || 'Phase action failed.'));
    }
    return json || response;
  }

  function phaseDuelTick(url, t) {
    const visitParam = url.searchParams.get(VISIT_PARAM) || '';
    const activeId = String(url.searchParams.get('active_id') || '');
    let run = loadRun(t);
    if (!run || !visitParam || run.visitId !== visitParam) return;

    const cmd = readCommand(t);
    if (run.finished) {
      if (cmd.visitId === run.visitId) {
        publish(run.routeId, run.visitId, run.finished.state, true, run.finished.message);
      }
      return;
    }

    run = acquire(run, t, url);
    if (!run) {
      log('Another tab owns the active Olympus phase duel; this tab is waiting.');
      return;
    }
    if (cmd.kind !== 'running' || cmd.visitId !== run.visitId) {
      stopAndFinish(run, cmd, t);
      return;
    }
    if (!run.target || run.routeId !== 'olympus' || !run.target.phased) {
      log('No phased Olympus boss owns this duel; returning to the domain.', 'warn');
      returnToHub(run);
      return;
    }
    if (!activeId || activeId !== run.target.monsterId) {
      saveRun(
        logic.failTarget(
          run,
          `Opened phase duel ${activeId || 'unknown'} instead of ${run.target.monsterId}.`,
          t,
          { abandon: true },
        ),
      );
      log('The open phase duel belongs to a different boss; returning to the domain.', 'warn');
      returnToHub(run);
      return;
    }

    if (run.phase !== 'duel') run = saveRun(logic.setPhase(run, 'duel', t));
    publish(run.routeId, run.visitId, 'busy', false, rt.lastLog || `Fighting ${run.target.name}'s Phase 2 duel.`);
    if (!rt.actionPending) runPhaseDuelStep(run);
  }

  function runPhaseDuelStep(run) {
    rt.actionPending = true;
    const { visitId } = run;
    const monsterId = run.target.monsterId;
    void (async () => {
      try {
        const state = await requestPhaseDuelState(monsterId);
        let current = validateBattleRun(visitId, monsterId, now());
        if (!current) return;
        const userId = await getUserId?.();
        current = validateBattleRun(visitId, monsterId, now());
        if (!current) return;
        const decision = logic.decidePhaseDuelAction(state, userId);

        if (decision.kind === 'won') {
          saveRun(logic.setPhase(logic.clearAction(current), 'battle', now()));
          log(`${current.target.name}'s Phase 2 duel was won; returning for Phase 3.`);
          navigate(logic.battlePath(monsterId), visitId);
          return;
        }

        if (decision.kind === 'retry') {
          const response = await postForm(PHASE_DUEL_ACTION_URL, {
            source: 'monster_phase',
            active_id: monsterId,
            action: 'retry',
          });
          requireSuccessfulPhaseAction(response);
          log(`${current.target.name}'s Phase 2 duel was restarted after a defeat.`);
          return;
        }

        if (decision.kind === 'attack') {
          const response = await postForm(PHASE_DUEL_ACTION_URL, {
            source: 'monster_phase',
            active_id: monsterId,
            action: 'use_skill',
            skill_id: decision.skillId,
            target_key: decision.targetKey,
          });
          requireSuccessfulPhaseAction(response);
          log(`Phase 2: used ${decision.skillName} against ${current.target.name}.`);
          return;
        }

        const messages = {
          'enemy-turn': 'Phase 2: waiting for the enemy turn to finish.',
          'other-turn': 'Phase 2: waiting for the player turn.',
          'not-ready': 'Phase 2: waiting for the duel state to become actionable.',
          'no-target': 'Phase 2: waiting for the living duel target.',
          'no-affordable-attack': 'Phase 2: waiting for Slash to become available.',
        };
        log(messages[decision.reason] || 'Phase 2: waiting for the next turn.');
      } catch (error) {
        log(`Phase 2 duel action failed: ${error?.message || error}`, 'warn');
      } finally {
        rt.actionPending = false;
      }
    })();
  }

  // ---------------------------------------------------------- lifecycle

  function resumeAfterSuspend(t) {
    const run = loadRun(t);
    const refreshed = logic.refreshAfterResume(run, rt.ownerId, t);
    if (refreshed && refreshed !== run) saveRun(refreshed);
    forcePublishNext();
  }

  function failOnError(error) {
    log(`Boss worker error: ${error?.message || error}`, 'error');
    try {
      const t = now();
      const run = loadRun(t);
      if (run && !run.finished && run.ownerId === rt.ownerId) {
        finish(run, 'error', `Boss worker failed: ${error?.message || error}`, t);
      }
    } catch {
      // nothing more to do
    }
  }

  function tick() {
    if (rt.stopped || rt.ticking || rt.navigating) return;
    rt.ticking = true;
    try {
      const t = now();
      if (rt.lastTickAt && t - rt.lastTickAt > TIMING.suspendGapMs) resumeAfterSuspend(t);
      rt.lastTickAt = t;
      const url = currentUrl();
      if (!url) return;
      if (logic.hubRouteForUrl(url)) hubTick(url, t);
      else if (logic.isBattleUrl(url)) battleTick(url, t);
      else if (logic.isPhaseDuelUrl(url)) phaseDuelTick(url, t);
    } catch (error) {
      failOnError(error);
    } finally {
      rt.ticking = false;
    }
  }

  function isHidden() {
    return doc?.hidden === true || doc?.visibilityState === 'hidden';
  }

  // The scheduler keeps running in hidden tabs, so the worker does too; a
  // return to the tab only triggers an immediate tick (the tick detects a
  // frozen-timer gap and re-bases the timeouts).
  function onVisibilityChange() {
    if (!isHidden()) tick();
  }

  function onPageShow(event) {
    if (event?.persisted) {
      // Restored from the back/forward cache: a navigation started before
      // the freeze never happened from this page's point of view.
      rt.navigating = false;
      rt.actionPending = false;
      resumeAfterSuspend(now());
    }
    tick();
  }

  function onPageHide(event) {
    if (event?.persisted) return;
    stop();
  }

  function start() {
    initOwner();
    rt.interval = win.setInterval?.(tick, TIMING.tickMs) ?? null;
    doc?.addEventListener?.('visibilitychange', onVisibilityChange);
    win.addEventListener?.('pageshow', onPageShow);
    win.addEventListener?.('pagehide', onPageHide);
    tick();
  }

  function stop() {
    rt.stopped = true;
    if (rt.interval !== null) win.clearInterval?.(rt.interval);
    rt.interval = null;
    doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    win.removeEventListener?.('pageshow', onPageShow);
    win.removeEventListener?.('pagehide', onPageHide);
    detachFight();
  }

  return {
    start,
    stop,
    tick,
    checkFight,
    onPageShow,
    onPageHide,
    onVisibilityChange,
    runtime: rt,
    initOwner,
  };
}

const bossWorkerFeature = Object.freeze({
  id: 'boss-worker',
  group: 'Automation',
  settings: [],
  matches(url) {
    return (
      /\/(?:active_wave|battle)\.php\/?$/i.test(url.pathname) ||
      logic.isPhaseDuelUrl(url)
    );
  },
  run(ctx) {
    const worker = createBossWorker({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      sessionStore: createJsonStore(getStorage('sessionStorage', ctx.win), '[Veyra]'),
      postForm: ctx.postForm,
      getUserId: ctx.getUserId,
    });
    worker.start();
    return worker;
  },
});

module.exports = {
  JOIN_URL,
  PHASE_DUEL_ACTION_URL,
  PHASE_DUEL_STATE_URL,
  bossWorkerFeature,
  createBossWorker,
};
