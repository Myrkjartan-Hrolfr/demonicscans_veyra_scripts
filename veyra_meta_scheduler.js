// ==UserScript==
// @name         Veyra - Meta Scheduler
// @namespace    local.veyra.meta-scheduler
// @version      1.0.0
// @description  Coordinates periodic Veyra page workers and returns to a configurable home page.
// @match        https://demonicscans.org/*
// @match        https://www.demonicscans.org/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG_KEY = 'veyra:orchestrator:config:v1';
  const RUNTIME_KEY = 'veyra:orchestrator:runtime:v1';
  const COMMAND_KEY = 'veyra:orchestrator:command:v1';
  const LEASE_KEY = 'veyra:orchestrator:lease:v1';
  const TAB_KEY = 'veyra:orchestrator:tab:v1';
  const STATUS_KEY_PREFIX = 'veyra:worker:';
  const STATUS_KEY_SUFFIX = ':status:v1';

  const PROTOCOL_VERSION = 1;
  const POLL_INTERVAL_MS = 1_000;
  const STATUS_FRESH_MS = 15_000;
  const LEASE_MS = 15_000;
  const LEASE_RENEW_MS = 5_000;
  const UI_ID = 'veyra-meta-scheduler';

  const ROUTES = Object.freeze({
    pvp: Object.freeze({
      id: 'pvp',
      label: 'PvP',
      path: '/pvp.php',
      ownedPathnames: Object.freeze(['/pvp.php', '/pvp_battle.php']),
      intervalMs: 5 * 60_000,
      maxVisitMs: 30 * 60_000,
      initialDelayMs: 0,
    }),
    wave3: Object.freeze({
      id: 'wave3',
      label: 'Wave 3',
      path: '/active_wave.php?gate=3&wave=8',
      ownedPathnames: Object.freeze(['/active_wave.php']),
      visitPathnames: Object.freeze(['/battle.php']),
      intervalMs: 30 * 60_000,
      maxVisitMs: 15 * 60_000,
      initialDelayMs: 30 * 60_000,
    }),
  });

  const ROUTE_IDS = Object.freeze(Object.keys(ROUTES));

  function finiteTimestamp(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function createDefaultConfig() {
    return {
      version: PROTOCOL_VERSION,
      enabled: true,
      homeRouteId: 'pvp',
    };
  }

  function normalizeConfig(value) {
    const defaults = createDefaultConfig();
    if (!value || typeof value !== 'object' || value.version !== PROTOCOL_VERSION) {
      return defaults;
    }

    return {
      version: PROTOCOL_VERSION,
      enabled: value.enabled !== false,
      homeRouteId: ROUTES[value.homeRouteId] ? value.homeRouteId : defaults.homeRouteId,
    };
  }

  function createDefaultRuntime(now = Date.now()) {
    const nextRunAt = {};
    for (const route of Object.values(ROUTES)) {
      nextRunAt[route.id] = now + route.initialDelayMs;
    }

    return {
      version: PROTOCOL_VERSION,
      nextRunAt,
      activeVisit: null,
      lastResult: null,
    };
  }

  function normalizeVisit(value) {
    if (!value || typeof value !== 'object') return null;

    const visitId = String(value.visitId || '').trim();
    const taskId = String(value.taskId || '').trim();
    const phase = value.phase === 'running' ? 'running' : value.phase === 'draining' ? 'draining' : '';
    const returnPath = String(value.returnPath || '').trim();
    const issuedAt = finiteTimestamp(value.issuedAt, -1);
    const deadlineAt = finiteTimestamp(value.deadlineAt, -1);

    if (
      !visitId ||
      !ROUTES[taskId] ||
      !phase ||
      !returnPath.startsWith('/') ||
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

  function normalizeRuntime(value, now = Date.now()) {
    const defaults = createDefaultRuntime(now);
    if (!value || typeof value !== 'object' || value.version !== PROTOCOL_VERSION) {
      return defaults;
    }

    const nextRunAt = {};
    for (const route of Object.values(ROUTES)) {
      nextRunAt[route.id] = finiteTimestamp(value.nextRunAt?.[route.id], defaults.nextRunAt[route.id]);
    }

    const lastResult =
      value.lastResult && typeof value.lastResult === 'object'
        ? {
            taskId: ROUTES[value.lastResult.taskId] ? value.lastResult.taskId : '',
            state: String(value.lastResult.state || ''),
            finishedAt: finiteTimestamp(value.lastResult.finishedAt, 0),
          }
        : null;

    return {
      version: PROTOCOL_VERSION,
      nextRunAt,
      activeVisit: normalizeVisit(value.activeVisit),
      lastResult,
    };
  }

  function routeIdForUrl(value, base = 'https://demonicscans.org') {
    let url;
    try {
      url = value instanceof URL ? value : new URL(String(value || '/'), base);
    } catch {
      return null;
    }

    if (/\/(?:pvp|pvp_battle)\.php\/?$/i.test(url.pathname)) return 'pvp';
    if (
      /\/active_wave\.php\/?$/i.test(url.pathname) &&
      url.searchParams.get('gate') === '3' &&
      url.searchParams.get('wave') === '8'
    ) {
      return 'wave3';
    }

    return null;
  }

  function isUrlWithinVisit(taskId, value, visitId, base = 'https://demonicscans.org') {
    const route = ROUTES[taskId];
    if (!route) return false;

    let url;
    try {
      url = value instanceof URL ? value : new URL(String(value || '/'), base);
    } catch {
      return false;
    }

    if (routeIdForUrl(url) === taskId) return true;
    return Boolean(
      visitId &&
        route.visitPathnames?.includes(url.pathname) &&
        url.searchParams.get('veyra_visit') === visitId,
    );
  }

  function chooseDueRoute(runtime, now = Date.now()) {
    if (!runtime || runtime.activeVisit) return null;

    return (
      Object.values(ROUTES)
        .filter((route) => finiteTimestamp(runtime.nextRunAt?.[route.id], Number.POSITIVE_INFINITY) <= now)
        .sort((left, right) => {
          const dueDifference = runtime.nextRunAt[left.id] - runtime.nextRunAt[right.id];
          return dueDifference || ROUTE_IDS.indexOf(left.id) - ROUTE_IDS.indexOf(right.id);
        })[0] || null
    );
  }

  function normalizeWorkerStatus(value) {
    if (!value || typeof value !== 'object') return null;

    const visitId = String(value.visitId || '').trim();
    const state = String(value.state || '').trim().toLowerCase();
    const updatedAt = finiteTimestamp(value.updatedAt, -1);
    if (updatedAt < 0 || !['idle', 'ready', 'busy', 'working', 'done', 'error'].includes(state)) {
      return null;
    }

    return {
      version: PROTOCOL_VERSION,
      visitId,
      workerId: String(value.workerId || '').trim(),
      state,
      safeToLeave: value.safeToLeave === true,
      updatedAt,
      message: String(value.message || ''),
    };
  }

  function isFreshWorkerStatus(status, now = Date.now(), freshnessMs = STATUS_FRESH_MS) {
    const normalized = normalizeWorkerStatus(status);
    if (!normalized) return false;

    return normalized.updatedAt <= now + 5_000 && now - normalized.updatedAt <= freshnessMs;
  }

  function isFreshMatchingStatus(status, visit, now = Date.now(), freshnessMs = STATUS_FRESH_MS) {
    const normalized = normalizeWorkerStatus(status);
    if (
      !normalized ||
      !visit ||
      normalized.visitId !== visit.visitId ||
      !isFreshWorkerStatus(normalized, now, freshnessMs)
    ) {
      return false;
    }

    return true;
  }

  function workerStatusKey(routeId) {
    return `${STATUS_KEY_PREFIX}${routeId}${STATUS_KEY_SUFFIX}`;
  }

  function completeRuntimeVisit(runtime, outcome, now = Date.now()) {
    const visit = normalizeVisit(runtime?.activeVisit);
    if (!visit) return normalizeRuntime(runtime, now);

    const next = normalizeRuntime(runtime, now);
    next.nextRunAt[visit.taskId] = now + ROUTES[visit.taskId].intervalMs;
    next.activeVisit = null;
    next.lastResult = {
      taskId: visit.taskId,
      state: outcome === 'done' ? 'done' : 'error',
      finishedAt: now,
    };
    return next;
  }

  const testExports = Object.freeze({
    COMMAND_KEY,
    CONFIG_KEY,
    LEASE_KEY,
    POLL_INTERVAL_MS,
    PROTOCOL_VERSION,
    ROUTES,
    RUNTIME_KEY,
    STATUS_FRESH_MS,
    chooseDueRoute,
    completeRuntimeVisit,
    createDefaultConfig,
    createDefaultRuntime,
    isFreshMatchingStatus,
    isFreshWorkerStatus,
    isUrlWithinVisit,
    normalizeConfig,
    normalizeRuntime,
    normalizeVisit,
    normalizeWorkerStatus,
    routeIdForUrl,
    workerStatusKey,
  });

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = testExports;
    return;
  }

  const state = {
    storage: null,
    sessionStorage: null,
    ownerId: '',
    interval: null,
    navigationPending: false,
    tickRunning: false,
    stopped: false,
    statusText: '',
  };

  function getStorage(name) {
    try {
      return window[name] || null;
    } catch (error) {
      console.warn(`[Veyra Meta] ${name} is unavailable.`, error);
      return null;
    }
  }

  function readJson(key) {
    if (!state.storage) return null;
    try {
      const raw = state.storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn(`[Veyra Meta] Could not read ${key}.`, error);
      return null;
    }
  }

  function writeJson(key, value) {
    if (!state.storage) return false;
    try {
      state.storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`[Veyra Meta] Could not save ${key}.`, error);
      return false;
    }
  }

  function removeStorageKey(key) {
    if (!state.storage) return;
    try {
      state.storage.removeItem(key);
    } catch (error) {
      console.warn(`[Veyra Meta] Could not remove ${key}.`, error);
    }
  }

  function loadConfig() {
    const config = normalizeConfig(readJson(CONFIG_KEY));
    writeJson(CONFIG_KEY, config);
    return config;
  }

  function saveConfig(config) {
    const normalized = normalizeConfig(config);
    writeJson(CONFIG_KEY, normalized);
    updateUi(normalized, loadRuntime());
    return normalized;
  }

  function loadRuntime(now = Date.now()) {
    const runtime = normalizeRuntime(readJson(RUNTIME_KEY), now);
    writeJson(RUNTIME_KEY, runtime);
    return runtime;
  }

  function saveRuntime(runtime, now = Date.now()) {
    const normalized = normalizeRuntime(runtime, now);
    writeJson(RUNTIME_KEY, normalized);
    return normalized;
  }

  function saveActiveVisit(runtime, visit, now = Date.now()) {
    const normalizedVisit = normalizeVisit(visit);
    if (!normalizedVisit) return runtime;

    const next = saveRuntime({ ...runtime, activeVisit: normalizedVisit }, now);
    writeJson(COMMAND_KEY, normalizedVisit);
    return next;
  }

  function clearActiveVisit(runtime, outcome, now = Date.now()) {
    const next = saveRuntime(completeRuntimeVisit(runtime, outcome, now), now);
    removeStorageKey(COMMAND_KEY);
    return next;
  }

  function createOwnerId() {
    try {
      const saved = state.sessionStorage?.getItem(TAB_KEY);
      if (saved) return saved;
    } catch {
      // Fall through to a page-local ID.
    }

    const randomPart =
      typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerId = `tab-${randomPart}`;

    try {
      state.sessionStorage?.setItem(TAB_KEY, ownerId);
    } catch {
      // A page-local owner still prevents duplicate work in this document.
    }
    return ownerId;
  }

  function claimLease(now = Date.now()) {
    if (!state.storage) return false;

    const current = readJson(LEASE_KEY);
    const currentOwner = String(current?.ownerId || '');
    const leaseUntil = finiteTimestamp(current?.leaseUntil, 0);
    if (currentOwner && currentOwner !== state.ownerId && leaseUntil > now) return false;

    if (currentOwner === state.ownerId && leaseUntil - now > LEASE_RENEW_MS) return true;

    writeJson(LEASE_KEY, {
      version: PROTOCOL_VERSION,
      ownerId: state.ownerId,
      leaseUntil: now + LEASE_MS,
    });

    const verified = readJson(LEASE_KEY);
    return verified?.ownerId === state.ownerId && finiteTimestamp(verified.leaseUntil, 0) > now;
  }

  function currentUrl() {
    try {
      return new URL(window.location.href, window.location.origin);
    } catch {
      return new URL(window.location.origin);
    }
  }

  function isAtRoute(routeId) {
    return routeIdForUrl(currentUrl()) === routeId;
  }

  function navigateTo(path) {
    if (state.navigationPending || !path) return false;
    state.navigationPending = true;
    window.location.replace(new URL(path, window.location.origin).href);
    return true;
  }

  function makeVisitId(now = Date.now()) {
    return `${now}-${Math.random().toString(36).slice(2)}`;
  }

  function startVisit(runtime, route, config, now = Date.now()) {
    const visit = {
      version: PROTOCOL_VERSION,
      visitId: makeVisitId(now),
      taskId: route.id,
      phase: 'draining',
      returnPath: ROUTES[config.homeRouteId].path,
      issuedAt: now,
      deadlineAt: now + route.maxVisitMs,
    };

    setStatus(`Bereite ${route.label} vor …`);
    return saveActiveVisit(runtime, visit, now);
  }

  function readWorkerStatus(routeId) {
    return normalizeWorkerStatus(readJson(workerStatusKey(routeId)));
  }

  function currentWorkerRouteId(now = Date.now()) {
    const url = currentUrl();
    const directRouteId = routeIdForUrl(url);
    if (directRouteId) return directRouteId;

    // Wave 3 can also run manually without a scheduler visit marker. On its
    // shared battle.php route, a fresh busy/unsafe heartbeat is the only safe
    // evidence that the boss worker owns the page. Do not interrupt it merely
    // because no veyra_visit query parameter exists.
    for (const route of Object.values(ROUTES)) {
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
      {
        ...visit,
        phase: 'running',
        deadlineAt: now + ROUTES[visit.taskId].maxVisitMs,
      },
      now,
    );
  }

  function requestVisitDrain(visit) {
    const normalizedVisit = normalizeVisit(visit);
    if (!normalizedVisit) return false;

    const storedCommand = normalizeVisit(readJson(COMMAND_KEY));
    if (storedCommand?.visitId === normalizedVisit.visitId && storedCommand.phase === 'draining') {
      return true;
    }

    return writeJson(COMMAND_KEY, { ...normalizedVisit, phase: 'draining' });
  }

  function ensureVisitRunningCommand(visit) {
    const normalizedVisit = normalizeVisit(visit);
    if (!normalizedVisit) return false;

    const storedCommand = normalizeVisit(readJson(COMMAND_KEY));
    if (storedCommand?.visitId === normalizedVisit.visitId && storedCommand.phase === 'running') {
      return true;
    }

    return writeJson(COMMAND_KEY, { ...normalizedVisit, phase: 'running' });
  }

  function isSettledSafeStatus(status) {
    return Boolean(
      status?.safeToLeave === true && ['idle', 'ready', 'done', 'error'].includes(status.state),
    );
  }

  function outcomeForSettledStatus(status, fallback = 'error') {
    if (status?.state === 'done') return 'done';
    if (status?.state === 'error') return 'error';
    return fallback;
  }

  function handleDraining(runtime, config, now) {
    const visit = runtime.activeVisit;
    const currentRouteId = currentWorkerRouteId(now);

    if (now >= visit.deadlineAt) {
      const currentStatus = currentRouteId ? readWorkerStatus(currentRouteId) : null;
      if (
        currentRouteId &&
        isFreshWorkerStatus(currentStatus, now) &&
        currentStatus.safeToLeave !== true
      ) {
        requestVisitDrain(visit);
        setStatus(
          `Zeitlimit erreicht; warte, bis ${ROUTES[currentRouteId].label} sicher verlassen werden kann …`,
        );
        return;
      }

      finishVisit(runtime, config, 'error', now);
      return;
    }

    if (currentRouteId === visit.taskId) {
      setStatus(`${ROUTES[visit.taskId].label} wird gestartet …`);
      transitionVisitToRunning(runtime, now);
      return;
    }

    if (currentRouteId) {
      const currentStatus = readWorkerStatus(currentRouteId);
      if (
        !isFreshWorkerStatus(currentStatus, now) ||
        currentStatus.safeToLeave !== true
      ) {
        setStatus(`Warte, bis ${ROUTES[currentRouteId].label} sicher verlassen werden kann …`);
        return;
      }
    }

    const runningRuntime = transitionVisitToRunning(runtime, now);
    const target = ROUTES[runningRuntime.activeVisit.taskId];
    setStatus(`Öffne ${target.label} …`);
    navigateTo(target.path);
  }

  function finishVisit(runtime, config, outcome, now) {
    const visit = runtime.activeVisit;
    const route = ROUTES[visit.taskId];
    clearActiveVisit(runtime, outcome, now);

    setStatus(
      outcome === 'done'
        ? `${route.label} ist abgeschlossen.`
        : `${route.label} wurde mit einem Fehler beendet.`,
    );

    if (!isAtRoute(config.homeRouteId)) {
      navigateTo(ROUTES[config.homeRouteId].path);
    }
  }

  function finishVisitWithoutNavigation(runtime, outcome, now) {
    const visit = runtime.activeVisit;
    const route = ROUTES[visit.taskId];
    clearActiveVisit(runtime, outcome, now);
    setStatus(
      outcome === 'done'
        ? `${route.label} ist abgeschlossen. Scheduler pausiert.`
        : `${route.label} wurde angehalten. Scheduler pausiert.`,
    );
  }

  function handlePaused(runtime, now) {
    const visit = normalizeVisit(runtime.activeVisit);
    if (!visit) {
      removeStorageKey(COMMAND_KEY);
      setStatus('Pausiert');
      return;
    }

    if (visit.phase === 'draining') {
      finishVisitWithoutNavigation(runtime, 'error', now);
      return;
    }

    requestVisitDrain(visit);
    const workerStatus = readWorkerStatus(visit.taskId);
    if (
      isFreshMatchingStatus(workerStatus, visit, now) &&
      isSettledSafeStatus(workerStatus)
    ) {
      finishVisitWithoutNavigation(runtime, outcomeForSettledStatus(workerStatus), now);
      return;
    }

    setStatus(`Pausiert; warte auf sichere Übergabe von ${ROUTES[visit.taskId].label} …`);
  }

  function handleOffRouteRecovery(visit, now) {
    const currentRouteId = currentWorkerRouteId(now);
    if (currentRouteId) {
      const currentStatus = readWorkerStatus(currentRouteId);
      requestVisitDrain(visit);
      if (
        !isFreshWorkerStatus(currentStatus, now) ||
        currentStatus.safeToLeave !== true
      ) {
        setStatus(`Warte, bis ${ROUTES[currentRouteId].label} sicher verlassen werden kann …`);
        return;
      }
    }

    ensureVisitRunningCommand(visit);
    setStatus(`Öffne ${ROUTES[visit.taskId].label} erneut …`);
    navigateTo(ROUTES[visit.taskId].path);
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
      finishVisit(runtime, config, workerStatus.state, now);
      return;
    }

    if (now >= visit.deadlineAt) {
      requestVisitDrain(visit);
      if (statusMatches && isSettledSafeStatus(workerStatus)) {
        finishVisit(runtime, config, outcomeForSettledStatus(workerStatus), now);
        return;
      }

      setStatus(`Zeitlimit für ${ROUTES[visit.taskId].label}; warte auf sichere Übergabe …`);
      return;
    }

    if (!isUrlWithinVisit(visit.taskId, currentUrl(), visit.visitId) && !statusMatches) {
      handleOffRouteRecovery(visit, now);
      return;
    }

    ensureVisitRunningCommand(visit);

    setStatus(`${ROUTES[visit.taskId].label} arbeitet …`);
  }

  function tick() {
    if (state.stopped || state.tickRunning || state.navigationPending || document.hidden === true) return;
    state.tickRunning = true;

    try {
      const now = Date.now();
      const config = loadConfig();
      let runtime = loadRuntime(now);

      if (!claimLease(now)) {
        setStatus('Ein anderer Tab steuert den Scheduler.');
        updateUi(config, runtime);
        return;
      }

      // Another tab may have updated the runtime while this document was
      // competing for the lease. Never act on the snapshot from before the
      // successful claim.
      runtime = loadRuntime(now);

      if (!config.enabled) {
        handlePaused(runtime, now);
        updateUi(config, runtime);
        return;
      }

      if (runtime.activeVisit) {
        const storedCommand = normalizeVisit(readJson(COMMAND_KEY));
        if (!storedCommand || storedCommand.visitId !== runtime.activeVisit.visitId) {
          writeJson(COMMAND_KEY, runtime.activeVisit);
        }

        if (runtime.activeVisit.phase === 'draining') {
          handleDraining(runtime, config, now);
        } else {
          handleRunning(runtime, config, now);
        }
        updateUi(config, loadRuntime(now));
        return;
      }

      removeStorageKey(COMMAND_KEY);
      const dueRoute = chooseDueRoute(runtime, now);
      if (dueRoute) {
        startVisit(runtime, dueRoute, config, now);
        updateUi(config, loadRuntime(now));
        return;
      }

      if (!isAtRoute(config.homeRouteId)) {
        startVisit(runtime, ROUTES[config.homeRouteId], config, now);
        updateUi(config, loadRuntime(now));
        return;
      }

      setStatus(`Warte auf ${ROUTES[config.homeRouteId].label}.`);
      updateUi(config, runtime);
    } catch (error) {
      console.error('[Veyra Meta] Scheduler tick failed.', error);
      setStatus('Scheduler-Fehler');
    } finally {
      state.tickRunning = false;
    }
  }

  function setStatus(text) {
    state.statusText = String(text || '');
    const status = document.getElementById?.(`${UI_ID}-status`);
    if (status) status.textContent = state.statusText;
  }

  function updateUi(config, runtime) {
    const panel = ensureUi();
    if (!panel) return;

    const select = document.getElementById?.(`${UI_ID}-home`);
    const toggle = document.getElementById?.(`${UI_ID}-toggle`);
    const status = document.getElementById?.(`${UI_ID}-status`);
    if (select && select.value !== config.homeRouteId) select.value = config.homeRouteId;
    if (toggle) toggle.textContent = config.enabled ? 'Pause' : 'Start';

    if (status && !state.statusText) {
      const visit = runtime?.activeVisit;
      status.textContent = visit
        ? `${ROUTES[visit.taskId].label}: ${visit.phase}`
        : `Hauptseite: ${ROUTES[config.homeRouteId].label}`;
    }
  }

  function ensureUi() {
    const existing = document.getElementById?.(UI_ID);
    if (existing) return existing;
    if (!document.body || typeof document.createElement !== 'function') return null;

    const panel = document.createElement('div');
    panel.id = UI_ID;
    panel.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:2147483646;display:flex;align-items:center;gap:6px;' +
      'max-width:calc(100vw - 16px);padding:6px 8px;border:1px solid rgba(148,163,184,.5);' +
      'border-radius:8px;background:rgba(15,23,42,.94);color:#e2e8f0;font:11px/1.25 system-ui,sans-serif;';

    const label = document.createElement('label');
    label.textContent = 'Home ';

    const select = document.createElement('select');
    select.id = `${UI_ID}-home`;
    for (const route of Object.values(ROUTES)) {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.label;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const config = loadConfig();
      saveConfig({ ...config, homeRouteId: select.value });
      tick();
    });
    label.appendChild(select);

    const toggle = document.createElement('button');
    toggle.id = `${UI_ID}-toggle`;
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      const config = loadConfig();
      saveConfig({ ...config, enabled: !config.enabled });
      tick();
    });

    const status = document.createElement('span');
    status.id = `${UI_ID}-status`;
    status.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    panel.appendChild(label);
    panel.appendChild(toggle);
    panel.appendChild(status);
    document.body.appendChild(panel);
    return panel;
  }

  function startPolling() {
    if (state.interval !== null || state.stopped) return;
    state.interval = window.setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.interval === null) return;
    window.clearInterval(state.interval);
    state.interval = null;
  }

  function resume() {
    if (state.stopped) return;
    state.navigationPending = false;
    startPolling();
    tick();
  }

  state.storage = getStorage('localStorage');
  state.sessionStorage = getStorage('sessionStorage');
  state.ownerId = createOwnerId();

  ensureUi();
  startPolling();
  tick();

  document.addEventListener?.('visibilitychange', () => {
    if (document.hidden !== true) resume();
  });
  window.addEventListener?.('pageshow', (event) => {
    if (event?.persisted) resume();
  });
  window.addEventListener?.('pagehide', (event) => {
    stopPolling();
    if (!event?.persisted) state.stopped = true;
  });
})();
