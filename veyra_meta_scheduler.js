// ==UserScript==
// @name         Veyra - Meta Scheduler
// @namespace    local.veyra.meta-scheduler
// @version      1.1.0
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
  const SITE_SETTINGS_TRIGGER_ID = 'openSettingsDrawerBtn';
  const SITE_FLOATING_CONTROL_IDS = Object.freeze([
    'openConsoleBtn',
    'openQuickSetDrawerBtn',
    'nav_fab',
  ]);

  const WAVE3_BOSSES = Object.freeze({
    skarn: Object.freeze({
      id: 'skarn',
      name: 'General Skarn the Radiant Bastion',
      defaultDamage: '3b',
    }),
    vessir: Object.freeze({
      id: 'vessir',
      name: 'General Vessir the Sunfang Duelist',
      defaultDamage: '3b',
    }),
    hrazz: Object.freeze({
      id: 'hrazz',
      name: 'General Hrazz the Dawnflame Oathkeeper',
      defaultDamage: '3b',
    }),
    drakzareth: Object.freeze({
      id: 'drakzareth',
      name: 'Drakzareth The Tyrant Lizard King',
      defaultDamage: '3b',
    }),
  });

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

  function normalizeDamageTarget(value, fallback = '3b') {
    const normalize = (candidate) =>
      String(candidate ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .slice(0, 32);
    const isValid = (candidate) => {
      if (!/^[\d.,]+[kmbtq]?$/.test(candidate)) return false;
      const match = candidate.match(/^([\d.,]+)([kmbtq])?$/);
      if (!match) return false;
      let numberText = match[1];
      if (match[2]) {
        if (numberText.includes('.') && numberText.includes(',')) {
          const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';
          const thousands = decimal === ',' ? '.' : ',';
          numberText = numberText.split(thousands).join('').replace(decimal, '.');
        } else {
          numberText = numberText.replace(',', '.');
        }
      } else {
        numberText = numberText.replace(/\D/g, '');
      }
      const parsed = match[2] ? Number.parseFloat(numberText) : Number(numberText);
      return Number.isFinite(parsed) && parsed > 0;
    };

    const normalized = normalize(value);
    if (isValid(normalized)) return normalized;
    const normalizedFallback = normalize(fallback);
    return isValid(normalizedFallback) ? normalizedFallback : '3b';
  }

  function createDefaultWave3Settings() {
    const bosses = {};
    for (const boss of Object.values(WAVE3_BOSSES)) {
      bosses[boss.id] = {
        name: boss.name,
        damage: boss.defaultDamage,
      };
    }

    return {
      useStaminaPotions: false,
      bosses,
    };
  }

  function createDefaultRouteConfig(routeId) {
    return {
      enabled: true,
      settings: routeId === 'wave3' ? createDefaultWave3Settings() : {},
    };
  }

  function createDefaultConfig() {
    const routes = {};
    for (const routeId of ROUTE_IDS) routes[routeId] = createDefaultRouteConfig(routeId);

    return {
      version: PROTOCOL_VERSION,
      enabled: true,
      homeRouteId: 'pvp',
      routes,
    };
  }

  function normalizeWave3Settings(value) {
    const bosses = {};
    for (const boss of Object.values(WAVE3_BOSSES)) {
      const savedBoss = value?.bosses?.[boss.id];
      bosses[boss.id] = {
        // Names are protocol identifiers for the Wave worker and must not be
        // editable through persisted data.
        name: boss.name,
        damage: normalizeDamageTarget(savedBoss?.damage, boss.defaultDamage),
      };
    }

    return {
      useStaminaPotions: value?.useStaminaPotions === true,
      bosses,
    };
  }

  function normalizeConfig(value) {
    const defaults = createDefaultConfig();
    if (!value || typeof value !== 'object' || value.version !== PROTOCOL_VERSION) {
      return defaults;
    }

    const routes = {};
    for (const routeId of ROUTE_IDS) {
      const savedRoute = value.routes?.[routeId];
      routes[routeId] = {
        enabled: savedRoute?.enabled !== false,
        settings:
          routeId === 'wave3'
            ? normalizeWave3Settings(savedRoute?.settings)
            : {},
      };
    }

    return {
      version: PROTOCOL_VERSION,
      enabled: value.enabled !== false,
      homeRouteId: ROUTES[value.homeRouteId] ? value.homeRouteId : defaults.homeRouteId,
      routes,
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

  function isRouteEnabled(config, routeId) {
    return normalizeConfig(config).routes[routeId]?.enabled !== false;
  }

  function chooseDueRoute(runtime, now = Date.now(), config = createDefaultConfig()) {
    if (!runtime || runtime.activeVisit) return null;

    const normalizedConfig = normalizeConfig(config);

    return (
      Object.values(ROUTES)
        .filter(
          (route) =>
            normalizedConfig.routes[route.id]?.enabled !== false &&
            finiteTimestamp(runtime.nextRunAt?.[route.id], Number.POSITIVE_INFINITY) <= now,
        )
        .sort((left, right) => {
          const dueDifference = runtime.nextRunAt[left.id] - runtime.nextRunAt[right.id];
          return dueDifference || ROUTE_IDS.indexOf(left.id) - ROUTE_IDS.indexOf(right.id);
        })[0] || null
    );
  }

  function formatCountdown(targetAt, now = Date.now()) {
    const remainingMs = Math.max(0, finiteTimestamp(targetAt, now) - now);
    if (remainingMs <= 0) return 'Jetzt fällig';

    const totalSeconds = Math.ceil(remainingMs / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
    return `Noch ${parts.map((part) => String(part).padStart(2, '0')).join(':')}`;
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
    WAVE3_BOSSES,
    chooseDueRoute,
    completeRuntimeVisit,
    createDefaultConfig,
    createDefaultWave3Settings,
    createDefaultRuntime,
    formatCountdown,
    isFreshMatchingStatus,
    isFreshWorkerStatus,
    isRouteEnabled,
    isUrlWithinVisit,
    normalizeConfig,
    normalizeDamageTarget,
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
    uiObserver: null,
    uiReference: null,
    uiSubRouteId: '',
    resizeListener: null,
    keydownListener: null,
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

  function handleDisabledRouteVisit(runtime, config, now) {
    const visit = normalizeVisit(runtime.activeVisit);
    if (!visit) return;

    requestVisitDrain(visit);

    // A missing or crashed worker cannot acknowledge the drain request. Use
    // the same visit deadline as the normal scheduler paths so disabling a
    // route can never strand the scheduler on that page forever.
    if (now >= visit.deadlineAt) {
      clearActiveVisit(runtime, 'error', now);
      setStatus(`${ROUTES[visit.taskId].label} wurde nach dem Zeitlimit deaktiviert.`);
      if (!isAtRoute(config.homeRouteId)) navigateTo(ROUTES[config.homeRouteId].path);
      return;
    }

    const currentRouteId = currentWorkerRouteId(now);
    const currentStatus = currentRouteId ? readWorkerStatus(currentRouteId) : null;

    if (
      currentRouteId &&
      (!isFreshWorkerStatus(currentStatus, now) || currentStatus.safeToLeave !== true)
    ) {
      setStatus(`${ROUTES[visit.taskId].label} ist inaktiv; warte auf sichere Übergabe …`);
      return;
    }

    const visitStatus = readWorkerStatus(visit.taskId);
    if (
      visit.phase === 'running' &&
      (!isFreshMatchingStatus(visitStatus, visit, now) || !isSettledSafeStatus(visitStatus))
    ) {
      setStatus(`${ROUTES[visit.taskId].label} wird beendet …`);
      return;
    }

    clearActiveVisit(runtime, 'error', now);
    setStatus(`${ROUTES[visit.taskId].label} wurde deaktiviert.`);
    if (!isAtRoute(config.homeRouteId)) navigateTo(ROUTES[config.homeRouteId].path);
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
        if (!isRouteEnabled(config, runtime.activeVisit.taskId)) {
          handleDisabledRouteVisit(runtime, config, now);
          updateUi(config, loadRuntime(now));
          return;
        }

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
      const dueRoute = chooseDueRoute(runtime, now, config);
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

  function makeUiElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.id) element.id = options.id;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type) element.type = options.type;
    if (options.title) element.title = options.title;
    return element;
  }

  function replaceChildren(element, ...children) {
    if (!element) return;
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren(...children);
      return;
    }

    while (element.firstChild) element.removeChild(element.firstChild);
    for (const child of children) element.appendChild(child);
  }

  function injectUiStyles() {
    if (document.getElementById?.(`${UI_ID}-style`) || typeof document.createElement !== 'function') {
      return;
    }

    const style = document.createElement('style');
    style.id = `${UI_ID}-style`;
    style.textContent = `
      #${UI_ID} { display: contents; }
      #${UI_ID}, #${UI_ID} * { box-sizing: border-box; }
      #${UI_ID}-trigger {
        position: fixed; right: 16px; bottom: 72px; z-index: 10001;
        width: 42px; min-width: 42px; height: 40px; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
        border: 1px solid #2f324d; border-radius: 12px; background: #24263a;
        box-shadow: 0 10px 24px rgba(0,0,0,.6); color: #fff;
        font: 700 18px/1 system-ui,sans-serif; cursor: pointer;
      }
      #${UI_ID}-trigger:active { transform: scale(.97); }
      #${UI_ID}-trigger[data-running="true"]::after {
        content: ''; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;
        border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 2px #24263a;
      }
      #${UI_ID}-backdrop {
        position: fixed; inset: 0; z-index: 2147483646; border: 0;
        background: rgba(0,0,0,.62); opacity: 0; pointer-events: none;
        transition: opacity .2s ease;
      }
      #${UI_ID}-drawer {
        position: fixed; top: 0; right: 0; z-index: 2147483647;
        width: min(380px, 92vw); height: 100vh; height: 100dvh;
        display: flex; flex-direction: column; overflow: hidden;
        border-left: 1px solid #2f324d; background: #1a1b25;
        box-shadow: 0 0 30px rgba(0,0,0,.8); color: #f4f5ff;
        font: 13px/1.4 Arial,system-ui,sans-serif;
        transform: translateX(105%); transition: transform .24s ease;
      }
      #${UI_ID}-drawer[data-open="true"] { transform: translateX(0); }
      #${UI_ID}-backdrop[data-open="true"] { opacity: 1; pointer-events: auto; }
      .${UI_ID}__header {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        padding: max(16px, env(safe-area-inset-top)) 16px 13px;
        border-bottom: 1px solid rgba(255,255,255,.1);
      }
      .${UI_ID}__title { color: #fff; font-size: 17px; font-weight: 800; }
      .${UI_ID}__subtitle { margin-top: 2px; color: #9aa0be; font-size: 11px; }
      .${UI_ID}__icon-button {
        flex: 0 0 auto; min-width: 34px; height: 34px; padding: 0 9px;
        border: 1px solid #343752; border-radius: 9px; background: #24263a;
        color: #fff; font-weight: 800; cursor: pointer;
      }
      .${UI_ID}__body {
        flex: 1 1 auto; min-height: 0; overflow-y: auto;
        padding: 14px 16px calc(24px + env(safe-area-inset-bottom));
      }
      .${UI_ID}__top-row {
        display: grid; grid-template-columns: minmax(92px,auto) minmax(0,1fr);
        gap: 8px; align-items: stretch; margin-bottom: 10px;
      }
      .${UI_ID}__primary, .${UI_ID}__select, .${UI_ID}__input {
        min-height: 40px; border: 1px solid #343752; border-radius: 9px;
        background: #24263a; color: #f4f5ff; font: inherit;
      }
      .${UI_ID}__primary { padding: 8px 12px; font-weight: 800; cursor: pointer; }
      .${UI_ID}__primary[data-enabled="true"] { border-color: #ef6464; color: #ffd1d1; }
      .${UI_ID}__primary[data-enabled="false"] { border-color: #3ecf78; color: #a9f5c7; }
      .${UI_ID}__select { width: 100%; padding: 7px 9px; }
      .${UI_ID}__status {
        min-height: 32px; margin-bottom: 14px; padding: 8px 10px;
        border-radius: 8px; background: rgba(142,162,255,.09); color: #b8c3ff;
        font-size: 11px; overflow-wrap: anywhere;
      }
      .${UI_ID}__section-title {
        margin: 0 0 8px; color: #9aa0be; font-size: 11px;
        font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
      }
      .${UI_ID}__routes { display: grid; gap: 8px; }
      .${UI_ID}__route {
        display: grid; grid-template-columns: minmax(0,1fr) auto;
        gap: 9px 12px; align-items: center; padding: 11px;
        border: 1px solid #2f324d; border-radius: 11px; background: #202231;
      }
      .${UI_ID}__route-name { min-width: 0; font-size: 14px; font-weight: 800; }
      .${UI_ID}__countdown { margin-top: 2px; color: #9aa0be; font-size: 11px; }
      .${UI_ID}__route-actions { display: flex; align-items: center; gap: 8px; }
      .${UI_ID}__switch { position: relative; width: 38px; height: 22px; display: inline-block; }
      .${UI_ID}__switch input { position: absolute; opacity: 0; pointer-events: none; }
      .${UI_ID}__switch span {
        position: absolute; inset: 0; border-radius: 999px; background: #4a4e62;
        cursor: pointer; transition: background .16s ease;
      }
      .${UI_ID}__switch span::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
        border-radius: 50%; background: #fff; transition: transform .16s ease;
      }
      .${UI_ID}__switch input:checked + span { background: #35b96b; }
      .${UI_ID}__switch input:checked + span::after { transform: translateX(16px); }
      .${UI_ID}__subdrawer {
        position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
        background: #1a1b25; transform: translateX(105%); transition: transform .22s ease;
      }
      #${UI_ID}-drawer[data-view="settings"] .${UI_ID}__subdrawer { transform: translateX(0); }
      .${UI_ID}__setting-list { display: grid; gap: 10px; }
      .${UI_ID}__setting {
        display: grid; gap: 5px; padding: 10px;
        border: 1px solid #2f324d; border-radius: 10px; background: #202231;
      }
      .${UI_ID}__setting label { color: #e6e9ff; font-size: 12px; font-weight: 700; }
      .${UI_ID}__input { width: 100%; padding: 7px 9px; }
      .${UI_ID}__check-row {
        display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 11px;
        border: 1px solid #2f324d; border-radius: 10px; background: #202231; cursor: pointer;
      }
      .${UI_ID}__empty { color: #9aa0be; padding: 12px 0; }
      @media (max-width: 480px) {
        #${UI_ID}-trigger { right: 12px; bottom: 68px; }
        .${UI_ID}__route { padding: 10px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${UI_ID}-drawer, #${UI_ID}-backdrop, .${UI_ID}__subdrawer { transition: none; }
      }
    `;
    (document.head || document.documentElement || document.body)?.appendChild(style);
  }

  function syncTriggerPlacement() {
    const trigger = document.getElementById?.(`${UI_ID}-trigger`);
    const reference = document.getElementById?.(SITE_SETTINGS_TRIGGER_ID);
    if (!trigger) return;

    if (!reference || typeof reference.getBoundingClientRect !== 'function') {
      trigger.style.removeProperty?.('left');
      trigger.style.removeProperty?.('top');
      trigger.style.removeProperty?.('right');
      trigger.style.removeProperty?.('bottom');
      trigger.dataset.anchored = 'false';
      return;
    }

    const referenceRect = reference.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect?.() || { width: 42, height: 40 };
    if (!referenceRect || referenceRect.width <= 0 || referenceRect.height <= 0) {
      trigger.style.removeProperty?.('left');
      trigger.style.removeProperty?.('top');
      trigger.style.removeProperty?.('right');
      trigger.style.removeProperty?.('bottom');
      trigger.dataset.anchored = 'false';
      return;
    }

    const triggerWidth = triggerRect.width > 0 ? triggerRect.width : 42;
    const triggerHeight = triggerRect.height > 0 ? triggerRect.height : 40;
    const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || 1_024;
    const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || 768;
    const gap = 8;
    const centeredLeft = referenceRect.left + (referenceRect.width - triggerWidth) / 2;
    const centeredTop = referenceRect.top + (referenceRect.height - triggerHeight) / 2;
    const candidates = [
      { left: referenceRect.left - triggerWidth - gap, top: centeredTop },
      { left: referenceRect.right + gap, top: centeredTop },
      { left: centeredLeft, top: referenceRect.top - triggerHeight - gap },
      { left: centeredLeft, top: referenceRect.bottom + gap },
    ];
    const occupiedRects = SITE_FLOATING_CONTROL_IDS.map((id) =>
      document.getElementById?.(id)?.getBoundingClientRect?.(),
    ).filter((rect) => rect && rect.width > 0 && rect.height > 0);
    const isInsideViewport = (candidate) =>
      candidate.left >= 8 &&
      candidate.top >= 8 &&
      candidate.left + triggerWidth <= viewportWidth - 8 &&
      candidate.top + triggerHeight <= viewportHeight - 8;
    const overlapsOccupiedControl = (candidate) => {
      const candidateRect = {
        left: candidate.left,
        right: candidate.left + triggerWidth,
        top: candidate.top,
        bottom: candidate.top + triggerHeight,
      };
      return occupiedRects.some(
        (rect) =>
          candidateRect.left < rect.right + 2 &&
          candidateRect.right > rect.left - 2 &&
          candidateRect.top < rect.bottom + 2 &&
          candidateRect.bottom > rect.top - 2,
      );
    };
    const placement =
      candidates.find(
        (candidate) => isInsideViewport(candidate) && !overlapsOccupiedControl(candidate),
      ) || candidates.find(isInsideViewport);

    if (!placement) {
      trigger.style.removeProperty?.('left');
      trigger.style.removeProperty?.('top');
      trigger.style.removeProperty?.('right');
      trigger.style.removeProperty?.('bottom');
      trigger.dataset.anchored = 'false';
      return;
    }

    trigger.style.left = `${Math.round(placement.left)}px`;
    trigger.style.top = `${Math.round(placement.top)}px`;
    trigger.style.right = 'auto';
    trigger.style.bottom = 'auto';
    trigger.dataset.anchored = 'true';
  }

  function setDrawerOpen(open) {
    const drawer = document.getElementById?.(`${UI_ID}-drawer`);
    const backdrop = document.getElementById?.(`${UI_ID}-backdrop`);
    const trigger = document.getElementById?.(`${UI_ID}-trigger`);
    if (!drawer || !backdrop) return;

    const value = open ? 'true' : 'false';
    drawer.dataset.open = value;
    backdrop.dataset.open = value;
    backdrop.hidden = !open;
    trigger?.setAttribute?.('aria-expanded', value);
    if (!open) {
      state.uiSubRouteId = '';
      drawer.dataset.view = 'main';
    }
  }

  function buildWave3Settings(container, config) {
    const settings = config.routes.wave3.settings;
    const list = makeUiElement('div', { className: `${UI_ID}__setting-list` });

    for (const boss of Object.values(WAVE3_BOSSES)) {
      const row = makeUiElement('div', { className: `${UI_ID}__setting` });
      const label = makeUiElement('label', {
        text: boss.name,
      });
      label.setAttribute?.('for', `${UI_ID}-wave3-damage-${boss.id}`);
      const input = makeUiElement('input', {
        id: `${UI_ID}-wave3-damage-${boss.id}`,
        className: `${UI_ID}__input`,
        type: 'text',
      });
      input.value = settings.bosses[boss.id].damage;
      input.placeholder = boss.defaultDamage;
      input.autocomplete = 'off';
      input.inputMode = 'decimal';
      input.addEventListener('change', () => {
        const next = loadConfig();
        next.routes.wave3.settings.bosses[boss.id].damage = normalizeDamageTarget(
          input.value,
          boss.defaultDamage,
        );
        input.value = next.routes.wave3.settings.bosses[boss.id].damage;
        saveConfig(next);
      });
      row.appendChild(label);
      row.appendChild(input);
      list.appendChild(row);
    }

    const potionLabel = makeUiElement('label', { className: `${UI_ID}__check-row` });
    const potionToggle = makeUiElement('input', {
      id: `${UI_ID}-wave3-stamina-potions`,
      type: 'checkbox',
    });
    potionToggle.checked = settings.useStaminaPotions;
    const potionText = makeUiElement('span', { text: 'Staminatränke verwenden' });
    potionToggle.addEventListener('change', () => {
      const next = loadConfig();
      next.routes.wave3.settings.useStaminaPotions = potionToggle.checked;
      saveConfig(next);
    });
    potionLabel.appendChild(potionToggle);
    potionLabel.appendChild(potionText);

    container.appendChild(list);
    container.appendChild(potionLabel);
  }

  function openRouteSettings(routeId) {
    const route = ROUTES[routeId];
    const drawer = document.getElementById?.(`${UI_ID}-drawer`);
    const title = document.getElementById?.(`${UI_ID}-sub-title`);
    const content = document.getElementById?.(`${UI_ID}-sub-content`);
    if (!route || !drawer || !title || !content) return;

    state.uiSubRouteId = routeId;
    title.textContent = `${route.label} · Einstellungen`;
    replaceChildren(content);

    const config = loadConfig();
    if (routeId === 'wave3') {
      buildWave3Settings(content, config);
    } else {
      content.appendChild(
        makeUiElement('div', {
          className: `${UI_ID}__empty`,
          text: 'Für diese Seite gibt es derzeit keine zusätzlichen Einstellungen.',
        }),
      );
    }
    drawer.dataset.view = 'settings';
  }

  function updateUi(config, runtime) {
    const root = ensureUi();
    if (!root) return;

    const select = document.getElementById?.(`${UI_ID}-home`);
    const toggle = document.getElementById?.(`${UI_ID}-toggle`);
    const status = document.getElementById?.(`${UI_ID}-status`);
    if (select && select.value !== config.homeRouteId) select.value = config.homeRouteId;
    if (toggle) {
      toggle.textContent = config.enabled ? 'Stop' : 'Start';
      toggle.dataset.enabled = String(config.enabled);
      toggle.setAttribute?.('aria-pressed', String(config.enabled));
    }

    const trigger = document.getElementById?.(`${UI_ID}-trigger`);
    if (trigger) trigger.dataset.running = String(config.enabled);

    if (status && !state.statusText) {
      const visit = runtime?.activeVisit;
      status.textContent = visit
        ? `${ROUTES[visit.taskId].label}: ${visit.phase}`
        : `Hauptseite: ${ROUTES[config.homeRouteId].label}`;
    } else if (status) {
      status.textContent = state.statusText;
    }

    const now = Date.now();
    for (const route of Object.values(ROUTES)) {
      const routeToggle = document.getElementById?.(`${UI_ID}-route-${route.id}-enabled`);
      const countdown = document.getElementById?.(`${UI_ID}-route-${route.id}-countdown`);
      const enabled = config.routes[route.id]?.enabled !== false;
      if (routeToggle) routeToggle.checked = enabled;
      if (!countdown) continue;

      if (!enabled) {
        countdown.textContent = 'Inaktiv';
      } else if (runtime?.activeVisit?.taskId === route.id) {
        countdown.textContent = runtime.activeVisit.phase === 'running' ? 'Läuft gerade' : 'Wird vorbereitet';
      } else {
        countdown.textContent = formatCountdown(runtime?.nextRunAt?.[route.id], now);
      }
    }

    if (state.uiSubRouteId === 'wave3') {
      const waveSettings = config.routes.wave3.settings;
      for (const boss of Object.values(WAVE3_BOSSES)) {
        const input = document.getElementById?.(`${UI_ID}-wave3-damage-${boss.id}`);
        if (input && document.activeElement !== input) {
          input.value = waveSettings.bosses[boss.id].damage;
        }
      }
      const potions = document.getElementById?.(`${UI_ID}-wave3-stamina-potions`);
      if (potions) potions.checked = waveSettings.useStaminaPotions;
    }

    syncTriggerPlacement();
  }

  function ensureUi() {
    const existing = document.getElementById?.(UI_ID);
    if (existing) {
      syncTriggerPlacement();
      return existing;
    }
    if (!document.body || typeof document.createElement !== 'function') return null;

    injectUiStyles();
    const root = makeUiElement('div', { id: UI_ID });

    const trigger = makeUiElement('button', {
      id: `${UI_ID}-trigger`,
      type: 'button',
      title: 'Meta-Scheduler',
      text: '🔄',
    });
    trigger.setAttribute?.('aria-label', 'Meta-Scheduler öffnen');
    trigger.setAttribute?.('aria-controls', `${UI_ID}-drawer`);
    trigger.setAttribute?.('aria-expanded', 'false');
    trigger.addEventListener('click', () => setDrawerOpen(true));

    const backdrop = makeUiElement('button', {
      id: `${UI_ID}-backdrop`,
      type: 'button',
      title: 'Menü schließen',
    });
    backdrop.hidden = true;
    backdrop.dataset.open = 'false';
    backdrop.setAttribute?.('aria-label', 'Meta-Scheduler schließen');
    backdrop.addEventListener('click', () => setDrawerOpen(false));

    const drawer = makeUiElement('aside', { id: `${UI_ID}-drawer` });
    drawer.dataset.open = 'false';
    drawer.dataset.view = 'main';
    drawer.setAttribute?.('aria-label', 'Meta-Scheduler');

    const header = makeUiElement('div', { className: `${UI_ID}__header` });
    const heading = makeUiElement('div');
    heading.appendChild(
      makeUiElement('div', { className: `${UI_ID}__title`, text: 'Meta-Scheduler' }),
    );
    heading.appendChild(
      makeUiElement('div', {
        className: `${UI_ID}__subtitle`,
        text: 'Seitenwechsel und automatische Prüfungen',
      }),
    );
    const close = makeUiElement('button', {
      id: `${UI_ID}-close`,
      className: `${UI_ID}__icon-button`,
      type: 'button',
      title: 'Schließen',
      text: '✕',
    });
    close.setAttribute?.('aria-label', 'Schließen');
    close.addEventListener('click', () => setDrawerOpen(false));
    header.appendChild(heading);
    header.appendChild(close);

    const body = makeUiElement('div', { className: `${UI_ID}__body` });
    const topRow = makeUiElement('div', { className: `${UI_ID}__top-row` });

    const toggle = makeUiElement('button', {
      id: `${UI_ID}-toggle`,
      className: `${UI_ID}__primary`,
      type: 'button',
    });
    toggle.addEventListener('click', () => {
      const config = loadConfig();
      saveConfig({ ...config, enabled: !config.enabled });
      tick();
    });

    const select = document.createElement('select');
    select.id = `${UI_ID}-home`;
    select.className = `${UI_ID}__select`;
    select.title = 'Hauptseite';
    select.setAttribute?.('aria-label', 'Hauptseite');
    for (const route of Object.values(ROUTES)) {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = `Hauptseite · ${route.label}`;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const config = loadConfig();
      saveConfig({ ...config, homeRouteId: select.value });
      tick();
    });
    topRow.appendChild(toggle);
    topRow.appendChild(select);

    const status = makeUiElement('div', {
      id: `${UI_ID}-status`,
      className: `${UI_ID}__status`,
    });
    status.setAttribute?.('aria-live', 'polite');

    const sectionTitle = makeUiElement('div', {
      className: `${UI_ID}__section-title`,
      text: 'Ansteuerbare Seiten',
    });
    const routeList = makeUiElement('div', { className: `${UI_ID}__routes` });
    for (const route of Object.values(ROUTES)) {
      const routeRow = makeUiElement('div', { className: `${UI_ID}__route` });
      routeRow.dataset.routeId = route.id;
      const routeInfo = makeUiElement('div');
      routeInfo.appendChild(
        makeUiElement('div', { className: `${UI_ID}__route-name`, text: route.label }),
      );
      routeInfo.appendChild(
        makeUiElement('div', {
          id: `${UI_ID}-route-${route.id}-countdown`,
          className: `${UI_ID}__countdown`,
        }),
      );

      const actions = makeUiElement('div', { className: `${UI_ID}__route-actions` });
      const switchLabel = makeUiElement('label', {
        className: `${UI_ID}__switch`,
        title: `${route.label} aktiv/inaktiv`,
      });
      const routeToggle = makeUiElement('input', {
        id: `${UI_ID}-route-${route.id}-enabled`,
        type: 'checkbox',
      });
      routeToggle.setAttribute?.('aria-label', `${route.label} aktiv`);
      routeToggle.addEventListener('change', () => {
        const config = loadConfig();
        config.routes[route.id].enabled = routeToggle.checked;
        saveConfig(config);
        tick();
      });
      switchLabel.appendChild(routeToggle);
      switchLabel.appendChild(makeUiElement('span'));

      const settingsButton = makeUiElement('button', {
        id: `${UI_ID}-route-${route.id}-settings`,
        className: `${UI_ID}__icon-button`,
        type: 'button',
        title: `${route.label} einstellen`,
        text: '⚙',
      });
      settingsButton.setAttribute?.('aria-label', `${route.label} einstellen`);
      settingsButton.addEventListener('click', () => openRouteSettings(route.id));
      actions.appendChild(switchLabel);
      actions.appendChild(settingsButton);
      routeRow.appendChild(routeInfo);
      routeRow.appendChild(actions);
      routeList.appendChild(routeRow);
    }

    body.appendChild(topRow);
    body.appendChild(status);
    body.appendChild(sectionTitle);
    body.appendChild(routeList);

    const subdrawer = makeUiElement('section', { className: `${UI_ID}__subdrawer` });
    const subHeader = makeUiElement('div', { className: `${UI_ID}__header` });
    const back = makeUiElement('button', {
      id: `${UI_ID}-sub-back`,
      className: `${UI_ID}__icon-button`,
      type: 'button',
      title: 'Zurück',
      text: '←',
    });
    back.setAttribute?.('aria-label', 'Zurück');
    back.addEventListener('click', () => {
      state.uiSubRouteId = '';
      drawer.dataset.view = 'main';
    });
    const subHeading = makeUiElement('div', {
      id: `${UI_ID}-sub-title`,
      className: `${UI_ID}__title`,
      text: 'Einstellungen',
    });
    const subClose = makeUiElement('button', {
      className: `${UI_ID}__icon-button`,
      type: 'button',
      title: 'Schließen',
      text: '✕',
    });
    subClose.setAttribute?.('aria-label', 'Schließen');
    subClose.addEventListener('click', () => setDrawerOpen(false));
    subHeader.appendChild(back);
    subHeader.appendChild(subHeading);
    subHeader.appendChild(subClose);
    const subContent = makeUiElement('div', {
      id: `${UI_ID}-sub-content`,
      className: `${UI_ID}__body`,
    });
    subdrawer.appendChild(subHeader);
    subdrawer.appendChild(subContent);

    drawer.appendChild(header);
    drawer.appendChild(body);
    drawer.appendChild(subdrawer);
    root.appendChild(trigger);
    root.appendChild(backdrop);
    root.appendChild(drawer);
    document.body.appendChild(root);

    syncTriggerPlacement();
    return root;
  }

  function startUiTracking() {
    if (!state.resizeListener) {
      state.resizeListener = () => syncTriggerPlacement();
      window.addEventListener?.('resize', state.resizeListener);
    }

    if (!state.keydownListener) {
      state.keydownListener = (event) => {
        if (event?.key !== 'Escape') return;
        const drawer = document.getElementById?.(`${UI_ID}-drawer`);
        if (drawer?.dataset?.view === 'settings') {
          state.uiSubRouteId = '';
          drawer.dataset.view = 'main';
        } else {
          setDrawerOpen(false);
        }
      };
      window.addEventListener?.('keydown', state.keydownListener);
    }

    state.uiReference = document.getElementById?.(SITE_SETTINGS_TRIGGER_ID) || null;
    if (state.uiObserver || typeof MutationObserver !== 'function') return;
    state.uiObserver = new MutationObserver(() => {
      const reference = document.getElementById?.(SITE_SETTINGS_TRIGGER_ID) || null;
      const root = document.getElementById?.(UI_ID);
      if (reference === state.uiReference && root) return;
      state.uiReference = reference;
      ensureUi();
      syncTriggerPlacement();
    });
    state.uiObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function cleanupUi() {
    state.uiObserver?.disconnect?.();
    state.uiObserver = null;
    state.uiReference = null;
    if (state.resizeListener) window.removeEventListener?.('resize', state.resizeListener);
    if (state.keydownListener) window.removeEventListener?.('keydown', state.keydownListener);
    state.resizeListener = null;
    state.keydownListener = null;
    document.getElementById?.(UI_ID)?.remove?.();
    document.getElementById?.(`${UI_ID}-style`)?.remove?.();
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
  startUiTracking();
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
    if (!event?.persisted) {
      state.stopped = true;
      cleanupUi();
    }
  });
})();
