'use strict';

// Background watcher for Crucible PvP. It runs on every game page owned by
// the scheduler tab, checks the saved lobby/match directly and only wakes the
// Crucible route when work is actionable. Merely checking a cooldown never
// navigates away from the user's current page.

const { finiteTimestamp } = require('../../core/numbers');
const { appendCrucibleDebugLog, summarizeResponse } = require('../../core/crucible-debug');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../../scheduler/engine');
const { RUNTIME_KEY, normalizeRuntime } = require('../../scheduler/runtime');
const logic = require('./crucible-logic');

const CRUCIBLE_PVP_WATCH_KEY = 'veyra:crucible:pvp-watch:v1';
const WATCH_VERSION = 1;
const WATCH_TICK_MS = 5_000;
const PVP_MATCH_CHECK_MS = 15_000;
const PVP_LOBBY_CHECK_MS = 30_000;
const PVP_ERROR_RETRY_MS = 60_000;
const PVP_WAKE_HOLD_MS = 5 * 60_000;
const PVP_REWARD_FRAME_TIMEOUT_MS = 15_000;
const PVP_BACKGROUND_FALLBACK_MS = 30 * 60_000;
const PVP_BACKGROUND_NAVIGATION_GRACE_MS = 30_000;

function cleanInteger(value) {
  const result = String(value ?? '').trim();
  return /^\d+$/.test(result) && Number(result) > 0 ? result : '';
}

function normalizePvpWatch(value) {
  if (!value || typeof value !== 'object' || Number(value.version) !== WATCH_VERSION) return null;
  const mode = value.mode === 'match' ? 'match' : value.mode === 'lobby' ? 'lobby' : '';
  const instanceId = cleanInteger(value.instanceId);
  const nodeId = cleanInteger(value.nodeId);
  const matchNo = cleanInteger(value.matchNo);
  const nextCheckAt = finiteTimestamp(value.nextCheckAt, -1);
  if (!mode || !instanceId || !nodeId || nextCheckAt < 0 || (mode === 'match' && !matchNo)) return null;
  return {
    version: WATCH_VERSION,
    mode,
    instanceId,
    nodeId,
    nodeKey: String(value.nodeKey || '').slice(0, 80),
    nodeName: String(value.nodeName || 'Crucible PvP').slice(0, 120),
    matchNo: mode === 'match' ? matchNo : '',
    nextCheckAt,
    updatedAt: finiteTimestamp(value.updatedAt, 0),
  };
}

function writePvpWatch(store, fields, now = Date.now()) {
  const watch = normalizePvpWatch({
    version: WATCH_VERSION,
    updatedAt: now,
    ...fields,
  });
  if (!watch) return null;
  store.write(CRUCIBLE_PVP_WATCH_KEY, watch);
  appendCrucibleDebugLog(store, 'pvp-watcher', 'watch scheduled', watch, now);
  return watch;
}

function watchPvpLobby(store, fields, now = Date.now()) {
  return writePvpWatch(store, { ...fields, mode: 'lobby', matchNo: '' }, now);
}

function watchPvpMatch(store, fields, now = Date.now()) {
  return writePvpWatch(store, { ...fields, mode: 'match' }, now);
}

function pvpLobbyUrl(origin, watch) {
  const url = new URL('/pvp_style_node.php', origin);
  url.searchParams.set('source', 'cube');
  url.searchParams.set('instance_id', watch.instanceId);
  url.searchParams.set('node_id', watch.nodeId);
  return url.href;
}

function pvpStateUrl(origin, watch) {
  const url = new URL('/pvp_style_state.php', origin);
  url.searchParams.set('source', 'cube');
  url.searchParams.set('since_log_id', '0');
  url.searchParams.set('instance_id', watch.instanceId);
  url.searchParams.set('node_id', watch.nodeId);
  url.searchParams.set('match_no', watch.matchNo);
  return url.href;
}

function wakeCrucible(store, watch, note, now = Date.now()) {
  const runtime = normalizeRuntime(store.read(RUNTIME_KEY), now);
  runtime.nextRunAt.crucible = Math.min(runtime.nextRunAt.crucible, now);
  runtime.notes.crucible = String(note || 'Crucible PvP ready').slice(0, 60);
  store.write(RUNTIME_KEY, runtime);
  appendCrucibleDebugLog(store, 'pvp-watcher', 'Crucible wake requested', {
    note,
    watch,
    nextRunAt: runtime.nextRunAt.crucible,
  }, now);
  writePvpWatch(store, { ...watch, nextCheckAt: now + PVP_WAKE_HOLD_MS }, now);
}

async function defaultFetchJson(win, url) {
  const response = await win.fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // parsePvpState rejects non-JSON responses.
  }
  return { ok: response.ok, status: response.status, text, json };
}

function visitPvpRewardPage(win, doc, url, expected, options = {}) {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || PVP_REWARD_FRAME_TIMEOUT_MS);
  const host = doc?.body || doc?.documentElement;
  const schedule = win?.setTimeout?.bind(win) || globalThis.setTimeout;
  const cancel = win?.clearTimeout?.bind(win) || globalThis.clearTimeout;
  let target = null;
  try {
    target = new URL(url, win.location.origin);
  } catch {
    return Promise.reject(new Error('invalid PvP reward page URL'));
  }
  if (
    !host?.appendChild ||
    !doc?.createElement ||
    target.origin !== win.location.origin ||
    !/\/pvp_style_battle\.php\/?$/i.test(target.pathname)
  ) {
    return Promise.reject(new Error('PvP reward page cannot be opened safely'));
  }

  return new Promise((resolve, reject) => {
    const frame = doc.createElement('iframe');
    let timeout = null;
    let settled = false;
    let verifiedRewardPage = null;

    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      if (timeout !== null) cancel(timeout);
      try {
        frame.remove?.();
      } catch {
        // Removing the already detached frame is harmless.
      }
      if (error) reject(error);
      else resolve(result);
    }

    frame.hidden = true;
    frame.setAttribute?.('aria-hidden', 'true');
    frame.setAttribute?.('tabindex', '-1');
    frame.style?.setProperty?.('display', 'none', 'important');
    frame.addEventListener?.('error', () => finish(new Error('PvP reward page failed to load')), { once: true });
    frame.addEventListener?.('load', () => {
      let rewardPage = null;
      try {
        rewardPage = logic.parsePvpBattlePage(frame.contentDocument, expected);
      } catch {
        // Cross-origin or blocked frame access is not a verified reward visit.
      }
      if (!rewardPage?.ok) {
        finish(new Error('cleared PvP reward page could not be verified'));
        return;
      }
      verifiedRewardPage = rewardPage;

      const checkModal = () => {
        if (settled) return;
        let shown = false;
        try {
          const modal = frame.contentDocument?.getElementById?.('rewardsModal');
          shown = Boolean(modal?.classList?.contains?.('show') && modal?.getAttribute?.('aria-hidden') !== 'true');
        } catch {
          // Keep waiting until the overall timeout reports a useful failure.
        }
        if (shown) {
          finish(null, { ...rewardPage, rewardModalShown: true });
          return;
        }
        schedule(checkModal, 250);
      };
      checkModal();
    }, { once: true });

    timeout = schedule(() => {
      // The page stores a per-room "reward seen" flag in localStorage. On a
      // repeated or previously manual visit the exact cleared victory page is
      // loaded and its scripts run, but the modal is intentionally not shown
      // again. Waiting through the confirmation window is sufficient: the
      // iframe is a real same-origin document (unlike fetch), the ended joined
      // match was confirmed before opening it, and its ids/status/reward data
      // were verified above.
      if (verifiedRewardPage) {
        finish(null, {
          ...verifiedRewardPage,
          rewardModalShown: false,
          rewardPageVerified: true,
        });
        return;
      }
      finish(new Error('PvP reward page did not finish loading in time'));
    }, timeoutMs);
    frame.src = target.href;
    host.appendChild(frame);
  });
}

function createCruciblePvpWatcher({
  win,
  doc = win.document,
  store,
  fetchDocument,
  fetchJson = (url) => defaultFetchJson(win, url),
  visitRewardPage = (url, expected) => visitPvpRewardPage(win, doc, url, expected),
  now = () => Date.now(),
  ownsSchedulerLease = null,
  logger = console,
}) {
  const runtime = { checking: false, stopped: false, interval: null };

  function debug(event, details = null) {
    appendCrucibleDebugLog(store, 'pvp-watcher', event, details, now());
  }

  function ownsLease() {
    if (ownsSchedulerLease) return ownsSchedulerLease();
    let ownerId = '';
    try {
      ownerId = String(win.sessionStorage?.getItem?.(TAB_KEY) || '');
    } catch {
      return false;
    }
    const lease = store.read(LEASE_KEY);
    return Boolean(ownerId && lease?.ownerId === ownerId && finiteTimestamp(lease.leaseUntil, 0) > now());
  }

  function enabled() {
    const config = normalizeConfig(store.read(CONFIG_KEY));
    return Boolean(
      config.enabled &&
      config.routes.crucible?.enabled !== false &&
      config.routes.crucible?.settings?.pvp?.enabled === true,
    );
  }

  function reschedule(watch, delayMs) {
    return writePvpWatch(store, { ...watch, nextCheckAt: now() + Math.max(1_000, delayMs) }, now());
  }

  function isCurrent(watch) {
    const current = normalizePvpWatch(store.read(CRUCIBLE_PVP_WATCH_KEY));
    return Boolean(
      current &&
      current.mode === watch.mode &&
      current.instanceId === watch.instanceId &&
      current.nodeId === watch.nodeId &&
      current.matchNo === watch.matchNo &&
      current.nextCheckAt === watch.nextCheckAt,
    );
  }

  async function checkMatch(watch) {
    const stateUrl = pvpStateUrl(win.location.origin, watch);
    debug('match state request', { url: stateUrl, watch });
    const response = await fetchJson(stateUrl);
    debug('match state response', { watch, response: summarizeResponse(response) });
    if (!isCurrent(watch)) return;
    const state = logic.parsePvpState(response);
    debug('match state parsed', { watch, state });
    if (!state.ok) throw new Error(state.error || 'invalid PvP state response');
    if (state.ended) {
      if (state.won) {
        if (!state.roomJoined) throw new Error('won PvP state did not confirm reward eligibility');
        const battleUrl = logic.buildPvpBattleUrl(win.location.origin, watch);
        if (!battleUrl) throw new Error('invalid won PvP match URL');
        debug('reward page visit started', { battleUrl, watch });
        const rewardPage = await visitRewardPage(battleUrl, watch);
        debug('reward page visit completed', { watch, rewardPage });
        if (!isCurrent(watch)) return;
        if (!rewardPage.ok) throw new Error('won PvP reward page could not be verified');
      }
      const lobbyWatch = watchPvpLobby(store, {
        ...watch,
        nextCheckAt: now() + PVP_LOBBY_CHECK_MS,
      }, now());
      wakeCrucible(
        store,
        lobbyWatch || watch,
        state.won ? `${watch.nodeName} reward collected` : `${watch.nodeName} match ended`,
        now(),
      );
      return;
    }
    reschedule(watch, PVP_MATCH_CHECK_MS);
  }

  async function checkLobby(watch) {
    const url = pvpLobbyUrl(win.location.origin, watch);
    debug('lobby document request', { url, watch });
    const lobby = logic.parsePvpLobby(await fetchDocument(url), url);
    if (!isCurrent(watch)) return;
    const action = logic.choosePvpAction(lobby);
    debug('lobby decision', { watch, lobby, action });
    if (action.kind === 'wait') {
      reschedule(watch, action.waitMs);
      return;
    }
    if (action.kind === 'existing') {
      watchPvpMatch(store, {
        ...watch,
        matchNo: action.match.matchNo,
        nextCheckAt: now() + 1_000,
      }, now());
      return;
    }
    if (action.kind === 'claim') {
      wakeCrucible(store, watch, `${watch.nodeName} PvP slot ready`, now());
      return;
    }
    reschedule(watch, PVP_LOBBY_CHECK_MS);
  }

  async function tick() {
    if (runtime.stopped || runtime.checking || !enabled() || !ownsLease()) return;
    const watch = normalizePvpWatch(store.read(CRUCIBLE_PVP_WATCH_KEY));
    if (!watch || watch.nextCheckAt > now()) return;
    runtime.checking = true;
    debug('watch tick started', { watch });
    try {
      if (watch.mode === 'match') await checkMatch(watch);
      else await checkLobby(watch);
    } catch (error) {
      logger?.warn?.('[Veyra] Crucible PvP background check failed.', error);
      debug('watch tick failed', { watch, error: String(error?.message || error), stack: String(error?.stack || '') });
      if (isCurrent(watch)) reschedule(watch, PVP_ERROR_RETRY_MS);
    } finally {
      debug('watch tick finished', { watch });
      runtime.checking = false;
    }
  }

  function start() {
    if (runtime.interval !== null || runtime.stopped) return;
    runtime.interval = win.setInterval?.(() => void tick(), WATCH_TICK_MS) ?? null;
    void tick();
  }

  function stop() {
    runtime.stopped = true;
    if (runtime.interval !== null) win.clearInterval?.(runtime.interval);
    runtime.interval = null;
  }

  return { runtime, start, stop, tick };
}

const cruciblePvpWatcherFeature = Object.freeze({
  id: 'crucible-pvp-watcher',
  group: 'Automation',
  settings: [],
  matches() {
    return true;
  },
  run(ctx) {
    const watcher = createCruciblePvpWatcher({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      fetchDocument: ctx.fetchDocument,
      logger: console,
    });
    watcher.start();
    ctx.win.addEventListener?.('pagehide', () => watcher.stop(), { once: true });
    return watcher;
  },
});

module.exports = {
  CRUCIBLE_PVP_WATCH_KEY,
  PVP_BACKGROUND_FALLBACK_MS,
  PVP_BACKGROUND_NAVIGATION_GRACE_MS,
  PVP_LOBBY_CHECK_MS,
  PVP_MATCH_CHECK_MS,
  PVP_REWARD_FRAME_TIMEOUT_MS,
  WATCH_TICK_MS,
  createCruciblePvpWatcher,
  cruciblePvpWatcherFeature,
  normalizePvpWatch,
  pvpLobbyUrl,
  pvpStateUrl,
  visitPvpRewardPage,
  wakeCrucible,
  watchPvpLobby,
  watchPvpMatch,
  writePvpWatch,
};
