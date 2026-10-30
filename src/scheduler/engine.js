'use strict';

// Scheduler state machine, ported from veyra_meta_scheduler.js.
// It only navigates; page workers are coordinated through the command and
// status keys in core/protocol.js.

const { finiteTimestamp } = require('../core/numbers');
const {
  COMMAND_KEY,
  PROTOCOL_VERSION,
  isFreshMatchingStatus,
  isFreshWorkerStatus,
  isSettledSafeStatus,
  normalizeWorkerStatus,
  workerStatusKey,
} = require('../core/protocol');
const { ROUTE_LIST, getRoute } = require('../routes');
const { CONFIG_KEY, isRouteEnabled, loopIntervalMs, normalizeConfig } = require('./config');
const {
  RUNTIME_KEY,
  applyLoopChange,
  chooseDueRoute,
  completeRuntimeVisit,
  isUrlWithinVisit,
  normalizeRuntime,
  normalizeVisit,
  routeIdForUrl,
} = require('./runtime');

const LEASE_KEY = 'veyra:orchestrator:lease:v1';
const TAB_KEY = 'veyra:orchestrator:tab:v1';
const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 15_000;
const LEASE_RENEW_MS = 5_000;

function outcomeForSettledStatus(status, fallback = 'error') {
  if (status?.state === 'done') return 'done';
  if (status?.state === 'error') return 'error';
  return fallback;
}

function createSchedulerEngine({ win, store, sessionStore, ui }) {
  const state = {
    ownerId: '',
    interval: null,
    navigationPending: false,
    tickRunning: false,
    stopped: false,
  };

  const label = (routeId) => getRoute(routeId)?.label || routeId;
  const setStatus = (text) => ui.setStatus(text);

  function loadConfig() {
    const config = normalizeConfig(store.read(CONFIG_KEY));
    store.write(CONFIG_KEY, config);
    return config;
  }

  function loadRuntime(now = Date.now()) {
    const runtime = normalizeRuntime(store.read(RUNTIME_KEY), now);
    store.write(RUNTIME_KEY, runtime);
    return runtime;
  }

  function saveRuntime(runtime, now = Date.now()) {
    const normalized = normalizeRuntime(runtime, now);
    store.write(RUNTIME_KEY, normalized);
    return normalized;
  }

  function saveConfig(config) {
    const normalized = normalizeConfig(config);
    store.write(CONFIG_KEY, normalized);
    ui.update(normalized, loadRuntime());
    return normalized;
  }

  function updateRouteConfig(routeId, mutator, now = Date.now()) {
    const config = loadConfig();
    const routeConfig = config.routes[routeId];
    if (!routeConfig) return null;

    const previousLoopMinutes = routeConfig.loopMinutes;
    mutator(routeConfig);
    const saved = saveConfig(config);

    if (saved.routes[routeId].loopMinutes !== previousLoopMinutes) {
      saveRuntime(applyLoopChange(loadRuntime(now), routeId, loopIntervalMs(saved, routeId), now), now);
      ui.update(saved, loadRuntime(now));
    }
    return saved.routes[routeId];
  }

  function saveActiveVisit(runtime, visit, now = Date.now()) {
    const normalizedVisit = normalizeVisit(visit);
    if (!normalizedVisit) return runtime;

    const next = saveRuntime({ ...runtime, activeVisit: normalizedVisit }, now);
    store.write(COMMAND_KEY, normalizedVisit);
    return next;
  }

  function clearActiveVisit(runtime, outcome, config, now = Date.now(), hint = null) {
    const next = saveRuntime(completeRuntimeVisit(runtime, outcome, now, config, hint), now);
    store.remove(COMMAND_KEY);
    return next;
  }

  function createOwnerId() {
    const saved = sessionStore.readRaw(TAB_KEY);
    if (saved) return saved;

    const randomPart =
      typeof win.crypto?.randomUUID === 'function'
        ? win.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerId = `tab-${randomPart}`;
    // A page-local owner still prevents duplicate work in this document.
    sessionStore.writeRaw(TAB_KEY, ownerId);
    return ownerId;
  }

  function claimLease(now = Date.now()) {
    if (!store.available) return false;

    const current = store.read(LEASE_KEY);
    const currentOwner = String(current?.ownerId || '');
    const leaseUntil = finiteTimestamp(current?.leaseUntil, 0);
    if (currentOwner && currentOwner !== state.ownerId && leaseUntil > now) return false;
    if (currentOwner === state.ownerId && leaseUntil - now > LEASE_RENEW_MS) return true;

    store.write(LEASE_KEY, {
      version: PROTOCOL_VERSION,
      ownerId: state.ownerId,
      leaseUntil: now + LEASE_MS,
    });

    const verified = store.read(LEASE_KEY);
    return verified?.ownerId === state.ownerId && finiteTimestamp(verified.leaseUntil, 0) > now;
  }

  function currentUrl() {
    try {
      return new URL(win.location.href, win.location.origin);
    } catch {
      return new URL(win.location.origin);
    }
  }

  function isAtRoute(routeId) {
    return routeIdForUrl(currentUrl()) === routeId;
  }

  function navigateTo(path) {
    if (state.navigationPending || !path) return false;
    state.navigationPending = true;
    win.location.replace(new URL(path, win.location.origin).href);
    return true;
  }

  function navigateHome(config) {
    if (!isAtRoute(config.homeRouteId)) navigateTo(getRoute(config.homeRouteId).path);
  }

  function makeVisitId(now = Date.now()) {
    return `${now}-${Math.random().toString(36).slice(2)}`;
  }

  function startVisit(runtime, route, config, now = Date.now()) {
    setStatus(`Preparing ${route.label} …`);
    return saveActiveVisit(
      runtime,
      {
        version: PROTOCOL_VERSION,
        visitId: makeVisitId(now),
        taskId: route.id,
        phase: 'draining',
        returnPath: getRoute(config.homeRouteId).path,
        issuedAt: now,
        deadlineAt: now + route.maxVisitMs,
      },
      now,
    );
  }

  function readWorkerStatus(routeId) {
    return normalizeWorkerStatus(store.read(workerStatusKey(routeId)));
  }

  function currentWorkerRouteId(now = Date.now()) {
    const url = currentUrl();
    const directRouteId = routeIdForUrl(url);
    if (directRouteId) return directRouteId;

    // A worker can also run manually on a shared page such as battle.php.
    // A fresh busy/unsafe heartbeat is the only safe evidence that it owns
    // the page, so do not interrupt it just because no visit marker exists.
    for (const route of ROUTE_LIST) {
      if (!route.visitPathnames?.includes(url.pathname)) continue;
      const status = readWorkerStatus(route.id);
      if (
        isFreshWorkerStatus(status, now) &&
        (status.safeToLeave !== true || status.state === 'busy' || status.state === 'working')
      ) {
        return route.id;
      }
    }
    return null;
  }

  function transitionVisitToRunning(runtime, now = Date.now()) {
    const visit = normalizeVisit(runtime.activeVisit);
    if (!visit) return runtime;
    return saveActiveVisit(
      runtime,
      { ...visit, phase: 'running', deadlineAt: now + getRoute(visit.taskId).maxVisitMs },
      now,
    );
  }

  function writeCommandPhase(visit, phase) {
    const normalizedVisit = normalizeVisit(visit);
    if (!normalizedVisit) return false;

    const storedCommand = normalizeVisit(store.read(COMMAND_KEY));
    if (storedCommand?.visitId === normalizedVisit.visitId && storedCommand.phase === phase) return true;
    return store.write(COMMAND_KEY, { ...normalizedVisit, phase });
  }

  const requestVisitDrain = (visit) => writeCommandPhase(visit, 'draining');
  const ensureVisitRunningCommand = (visit) => writeCommandPhase(visit, 'running');

  function finishVisit(runtime, config, outcome, now, hint = null) {
    const routeLabel = label(runtime.activeVisit.taskId);
    clearActiveVisit(runtime, outcome, config, now, hint);
    if (hint?.note && finiteTimestamp(hint.retryAt, 0) > now) setStatus(`${routeLabel}: ${hint.note}.`);
    else setStatus(outcome === 'done' ? `${routeLabel} finished.` : `${routeLabel} stopped with an error.`);
    navigateHome(config);
  }

  function finishVisitWithoutNavigation(runtime, config, outcome, now) {
    const routeLabel = label(runtime.activeVisit.taskId);
    clearActiveVisit(runtime, outcome, config, now);
    setStatus(
      outcome === 'done'
        ? `${routeLabel} finished. Scheduler paused.`
        : `${routeLabel} was stopped. Scheduler paused.`,
    );
  }

  function handleDraining(runtime, config, now) {
    const visit = runtime.activeVisit;
    const currentRouteId = currentWorkerRouteId(now);

    if (now >= visit.deadlineAt) {
      const currentStatus = currentRouteId ? readWorkerStatus(currentRouteId) : null;
      if (currentRouteId && isFreshWorkerStatus(currentStatus, now) && currentStatus.safeToLeave !== true) {
        requestVisitDrain(visit);
        setStatus(`Time limit reached; waiting until ${label(currentRouteId)} can be left safely …`);
        return;
      }
      finishVisit(runtime, config, 'error', now);
      return;
    }

    if (currentRouteId === visit.taskId) {
      setStatus(`Starting ${label(visit.taskId)} …`);
      transitionVisitToRunning(runtime, now);
      return;
    }

    if (currentRouteId) {
      const currentStatus = readWorkerStatus(currentRouteId);
      if (!isFreshWorkerStatus(currentStatus, now) || currentStatus.safeToLeave !== true) {
        setStatus(`Waiting until ${label(currentRouteId)} can be left safely …`);
        return;
      }
    }

    const runningRuntime = transitionVisitToRunning(runtime, now);
    const target = getRoute(runningRuntime.activeVisit.taskId);
    setStatus(`Opening ${target.label} …`);
    navigateTo(target.path);
  }

  function handlePaused(runtime, config, now) {
    const visit = normalizeVisit(runtime.activeVisit);
    if (!visit) {
      store.remove(COMMAND_KEY);
      setStatus('Paused');
      return;
    }

    if (visit.phase === 'draining') {
      finishVisitWithoutNavigation(runtime, config, 'error', now);
      return;
    }

    requestVisitDrain(visit);
    const workerStatus = readWorkerStatus(visit.taskId);
    if (isFreshMatchingStatus(workerStatus, visit, now) && isSettledSafeStatus(workerStatus)) {
      finishVisitWithoutNavigation(runtime, config, outcomeForSettledStatus(workerStatus), now);
      return;
    }
    setStatus(`Paused; waiting for ${label(visit.taskId)} to hand over safely …`);
  }

  function handleDisabledRouteVisit(runtime, config, now) {
    const visit = normalizeVisit(runtime.activeVisit);
    if (!visit) return;

    requestVisitDrain(visit);

    // A missing or crashed worker cannot acknowledge the drain request. The
    // visit deadline makes sure disabling a page never strands the scheduler.
    if (now >= visit.deadlineAt) {
      clearActiveVisit(runtime, 'error', config, now);
      setStatus(`${label(visit.taskId)} was disabled after the time limit.`);
      navigateHome(config);
      return;
    }

    const currentRouteId = currentWorkerRouteId(now);
    const currentStatus = currentRouteId ? readWorkerStatus(currentRouteId) : null;
    if (currentRouteId && (!isFreshWorkerStatus(currentStatus, now) || currentStatus.safeToLeave !== true)) {
      setStatus(`${label(visit.taskId)} is disabled; waiting for a safe handover …`);
      return;
    }

    const visitStatus = readWorkerStatus(visit.taskId);
    if (
      visit.phase === 'running' &&
      (!isFreshMatchingStatus(visitStatus, visit, now) || !isSettledSafeStatus(visitStatus))
    ) {
      setStatus(`Stopping ${label(visit.taskId)} …`);
      return;
    }

    clearActiveVisit(runtime, 'error', config, now);
    setStatus(`${label(visit.taskId)} was disabled.`);
    navigateHome(config);
  }

  function handleOffRouteRecovery(visit, now) {
    const currentRouteId = currentWorkerRouteId(now);
    if (currentRouteId) {
      const currentStatus = readWorkerStatus(currentRouteId);
      requestVisitDrain(visit);
      if (!isFreshWorkerStatus(currentStatus, now) || currentStatus.safeToLeave !== true) {
        setStatus(`Waiting until ${label(currentRouteId)} can be left safely …`);
        return;
      }
    }

    ensureVisitRunningCommand(visit);
    setStatus(`Reopening ${label(visit.taskId)} …`);
    navigateTo(getRoute(visit.taskId).path);
  }

  function handleRunning(runtime, config, now) {
    const visit = runtime.activeVisit;
    const workerStatus = readWorkerStatus(visit.taskId);
    const statusMatches = isFreshMatchingStatus(workerStatus, visit, now);

    if (
      statusMatches &&
      workerStatus.safeToLeave === true &&
      (workerStatus.state === 'done' || workerStatus.state === 'error')
    ) {
      finishVisit(runtime, config, workerStatus.state, now, {
        retryAt: workerStatus.retryAt,
        note: workerStatus.note,
      });
      return;
    }

    if (now >= visit.deadlineAt) {
      requestVisitDrain(visit);
      if (statusMatches && isSettledSafeStatus(workerStatus)) {
        finishVisit(runtime, config, outcomeForSettledStatus(workerStatus), now);
        return;
      }

      // Only a live unsafe/busy worker can justify waiting past the visit
      // deadline. A missing or stale heartbeat cannot acknowledge the drain
      // request and would otherwise strand the scheduler indefinitely.
      const hasFreshUnsafeWorker =
        isFreshWorkerStatus(workerStatus, now) &&
        (workerStatus.safeToLeave !== true ||
          workerStatus.state === 'busy' ||
          workerStatus.state === 'working');
      if (!hasFreshUnsafeWorker) {
        finishVisit(runtime, config, 'error', now);
        return;
      }

      setStatus(`Time limit for ${label(visit.taskId)}; waiting for a safe handover …`);
      return;
    }

    if (!isUrlWithinVisit(visit.taskId, currentUrl(), visit.visitId) && !statusMatches) {
      handleOffRouteRecovery(visit, now);
      return;
    }

    ensureVisitRunningCommand(visit);
    setStatus(`${label(visit.taskId)} is working …`);
  }

  // Unlike the old scheduler this also runs while the tab is hidden, so the
  // loop keeps going on mobile as far as the browser's timer throttling allows.
  function tick() {
    if (state.stopped || state.tickRunning || state.navigationPending) return;
    state.tickRunning = true;

    try {
      const now = Date.now();
      const config = loadConfig();
      let runtime = loadRuntime(now);

      if (!claimLease(now)) {
        setStatus('Another tab is controlling the scheduler.');
        ui.update(config, runtime);
        return;
      }

      // Another tab may have changed the runtime while this one was
      // competing for the lease. Never act on the snapshot from before.
      runtime = loadRuntime(now);

      if (!config.enabled) {
        handlePaused(runtime, config, now);
      } else if (runtime.activeVisit) {
        if (!isRouteEnabled(config, runtime.activeVisit.taskId)) {
          handleDisabledRouteVisit(runtime, config, now);
        } else {
          const storedCommand = normalizeVisit(store.read(COMMAND_KEY));
          if (!storedCommand || storedCommand.visitId !== runtime.activeVisit.visitId) {
            store.write(COMMAND_KEY, runtime.activeVisit);
          }
          if (runtime.activeVisit.phase === 'draining') handleDraining(runtime, config, now);
          else handleRunning(runtime, config, now);
        }
      } else {
        store.remove(COMMAND_KEY);
        const dueRoute = chooseDueRoute(runtime, now, config);
        if (dueRoute) {
          startVisit(runtime, dueRoute, config, now);
        } else if (!isAtRoute(config.homeRouteId)) {
          startVisit(runtime, getRoute(config.homeRouteId), config, now);
        } else {
          setStatus(`Waiting on ${label(config.homeRouteId)}.`);
        }
      }

      ui.update(config, loadRuntime(now));
    } catch (error) {
      console.error('[Veyra] Scheduler tick failed.', error);
      setStatus('Scheduler error');
    } finally {
      state.tickRunning = false;
    }
  }

  function startPolling() {
    if (state.interval !== null || state.stopped) return;
    state.interval = win.setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.interval === null) return;
    win.clearInterval(state.interval);
    state.interval = null;
  }

  function resume() {
    if (state.stopped) return;
    state.navigationPending = false;
    startPolling();
    tick();
  }

  function start() {
    state.ownerId = createOwnerId();
    startPolling();
    tick();
  }

  function shutdown() {
    stopPolling();
    state.stopped = true;
  }

  return {
    loadConfig,
    loadRuntime,
    resume,
    saveConfig,
    shutdown,
    start,
    stopPolling,
    tick,
    updateRouteConfig,
  };
}

module.exports = {
  LEASE_KEY,
  POLL_INTERVAL_MS,
  TAB_KEY,
  createSchedulerEngine,
};
