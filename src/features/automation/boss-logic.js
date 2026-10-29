'use strict';

// Pure logic of the Wave 3 / Olympus boss worker: boss matching, domain
// planning, command evaluation and the private run state. No DOM access, so
// everything here is unit-testable.

const { parseGameNumber } = require('../../core/numbers');
const protocol = require('../../core/protocol');
const wave3 = require('../../routes/wave3');
const olympus = require('../../routes/olympus');

const BOSS_ROUTE_IDS = Object.freeze(['wave3', 'olympus']);
const RUN_KEY = 'veyra:bossworker:run:v1';
const OWNER_KEY = 'veyra:bossworker:owner:v1';
const RUN_VERSION = 1;
const VISIT_PARAM = 'veyra_visit';

const TIMING = Object.freeze({
  tickMs: 1_000,
  heartbeatMs: 3_000,
  leaseMs: 2 * 60_000,
  leaseRenewMs: 5_000,
  actionRetryMs: 5_000,
  navigationRetryMs: 15_000,
  hubSettleMs: 1_000,
  hubEmptyWaitMs: 30_000,
  controllerWaitMs: 15_000,
  stopWaitMs: 10_000,
  suspendGapMs: 20_000,
});

const LIMITS = Object.freeze({
  maxActionAttempts: 3,
  maxFightsPerBoss: 3,
});

const RUN_PHASES = Object.freeze(['hub', 'opening', 'battle', 'returning', 'finished']);

// ------------------------------------------------------------------ routes

const WAVE3_DOMAIN = Object.freeze({
  id: 'wave3',
  label: 'Wave 3',
  path: wave3.path,
  bosses: Object.freeze(Object.values(wave3.WAVE3_BOSSES)),
});

const ROUTE_DOMAINS = Object.freeze({
  wave3: Object.freeze([WAVE3_DOMAIN]),
  olympus: Object.freeze(
    olympus.OLYMPUS_DOMAINS.map((domain) =>
      Object.freeze({
        id: domain.id,
        label: domain.label,
        path: olympus.domainPath(domain),
        bosses: domain.bosses,
      }),
    ),
  ),
});

function routeLabel(routeId) {
  return routeId === 'wave3' ? wave3.label : routeId === 'olympus' ? olympus.label : String(routeId);
}

function allDomains(routeId) {
  return ROUTE_DOMAINS[routeId] || [];
}

function findDomain(routeId, domainId) {
  return allDomains(routeId).find((domain) => domain.id === domainId) || null;
}

// Which boss route a hub URL belongs to (or null).
function hubRouteForUrl(url) {
  if (!url) return null;
  if (wave3.matchesUrl(url)) return 'wave3';
  if (olympus.matchesUrl(url)) return 'olympus';
  return null;
}

function domainIdForUrl(routeId, url) {
  if (!url) return null;
  if (routeId === 'wave3') return wave3.matchesUrl(url) ? WAVE3_DOMAIN.id : null;
  if (routeId === 'olympus') return olympus.domainForUrl(url)?.id || null;
  return null;
}

function isBattleUrl(url) {
  return Boolean(url && /\/battle\.php\/?$/i.test(url.pathname));
}

function withVisit(path, visitId, origin = 'https://demonicscans.org') {
  const url = new URL(path, origin);
  if (visitId) url.searchParams.set(VISIT_PARAM, visitId);
  return url;
}

function battlePath(monsterId) {
  return `/battle.php?id=${encodeURIComponent(String(monsterId))}`;
}

// Enabled bosses per domain, in visit order. Domains without an enabled boss
// are left out, so they are never visited.
function buildPlan(routeId, routeConfig) {
  const configured = routeConfig?.settings?.bosses || {};
  const plan = [];
  for (const domain of allDomains(routeId)) {
    const bosses = domain.bosses.map((boss) => {
      const saved = configured[boss.id];
      const damageText = String(saved?.damage || boss.defaultDamage || '3b');
      const damageValue = parseGameNumber(damageText) || parseGameNumber(boss.defaultDamage) || 3e9;
      return {
        id: boss.id,
        name: boss.name,
        enabled: saved?.enabled === true,
        damage: damageText,
        damageValue,
      };
    });
    if (bosses.some((boss) => boss.enabled)) {
      plan.push({ id: domain.id, label: domain.label, path: domain.path, bosses });
    }
  }
  return plan;
}

// The next planned domain after currentId (in the route's visit order), or
// the first planned one when there is no current domain.
function nextDomainId(routeId, plan, currentId) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  if (!currentId) return plan[0].id;
  const order = allDomains(routeId).map((domain) => domain.id);
  const currentIndex = order.indexOf(currentId);
  return plan.find((domain) => order.indexOf(domain.id) > currentIndex)?.id || null;
}

// --------------------------------------------------------------- matching

function normalizeBossName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Zeus, Sovereign of the Storm Throne" → "zeus".
function bossNamePrefix(value) {
  return normalizeBossName(String(value ?? '').split(',')[0]);
}

// bosses:  [{ id, name, enabled, damageValue }] of one domain (all of them,
//          so the prefix fallback never steals another boss's card)
// summons: [{ name, alive, monsterId }]       from .auto-summon-card
// cards:   [{ monsterId, name, dead, joined, userDamage, expire }]
// Returns the alive instances of the enabled bosses:
//   [{ monsterId, bossId, name, damage, damageValue, joined, userDamage, source }]
function matchHubBosses({ bosses = [], summons = [], cards = [] }) {
  const aliveCards = cards.filter((card) => card && !card.dead && card.monsterId);
  const fullNames = new Map(bosses.map((boss) => [boss.id, normalizeBossName(boss.name)]));
  const exactNames = new Set(fullNames.values());
  const prefixCounts = new Map();
  for (const boss of bosses) {
    const prefix = bossNamePrefix(boss.name);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }

  const results = [];
  const seen = new Set();
  const push = (entry) => {
    if (seen.has(entry.monsterId)) return;
    seen.add(entry.monsterId);
    results.push(entry);
  };

  for (const boss of bosses) {
    if (!boss.enabled) continue;
    const fullName = fullNames.get(boss.id);
    const prefix = bossNamePrefix(boss.name);
    const summon = summons.find((candidate) => normalizeBossName(candidate.name) === fullName) || null;

    let matched = aliveCards.filter((card) => normalizeBossName(card.name) === fullName);
    // An alive Sovereign god can carry a different monster-card name
    // ("zeus, duelist of the storm throne"). Fall back to the part before the
    // first comma, but only while the auto-summon card says the boss is alive
    // and the prefix identifies exactly one boss of this domain.
    if (matched.length === 0 && summon?.alive && prefix && prefixCounts.get(prefix) === 1) {
      matched = aliveCards.filter(
        (card) =>
          bossNamePrefix(card.name) === prefix && !exactNames.has(normalizeBossName(card.name)),
      );
    }

    const base = {
      bossId: boss.id,
      name: boss.name,
      damage: boss.damage,
      damageValue: boss.damageValue,
    };
    const sorted = [...matched].sort(
      (left, right) =>
        (Number.isFinite(left.expire) ? left.expire : Infinity) -
        (Number.isFinite(right.expire) ? right.expire : Infinity),
    );
    for (const card of sorted) {
      push({
        ...base,
        monsterId: String(card.monsterId),
        joined: card.joined,
        userDamage: card.userDamage,
        source: 'card',
      });
    }
    // No card at all (e.g. the list is paginated): the auto-summon link still
    // names the live instance.
    if (sorted.length === 0 && summon?.alive && summon.monsterId) {
      push({
        ...base,
        monsterId: String(summon.monsterId),
        joined: null,
        userDamage: null,
        source: 'summon',
      });
    }
  }
  return results;
}

function reachedTarget(userDamage, damageValue) {
  return Number.isFinite(userDamage) && Number.isFinite(damageValue) && userDamage >= damageValue;
}

function needsWork(match) {
  if (!match) return false;
  if (match.joined === false) return true;
  return !reachedTarget(match.userDamage, match.damageValue);
}

function fightCount(run, monsterId) {
  return Number(run?.fights?.[monsterId]) || 0;
}

function chooseNextBoss(matches, run) {
  return (
    (matches || []).find(
      (match) =>
        needsWork(match) &&
        !run.processed.includes(match.monsterId) &&
        !run.failed.includes(match.monsterId) &&
        fightCount(run, match.monsterId) < LIMITS.maxFightsPerBoss,
    ) || null
  );
}

// ---------------------------------------------------------------- command

// kind: 'none' | 'running' | 'draining' | 'expired' (running past deadline)
function evaluateCommand(raw, now = Date.now()) {
  const visit = protocol.normalizeVisit(raw, (taskId) => BOSS_ROUTE_IDS.includes(taskId));
  if (!visit) return { kind: 'none', routeId: null, visitId: '', deadlineAt: 0 };
  let kind = visit.phase;
  if (kind === 'running' && visit.deadlineAt > 0 && now > visit.deadlineAt) kind = 'expired';
  return { kind, routeId: visit.taskId, visitId: visit.visitId, deadlineAt: visit.deadlineAt };
}

// ------------------------------------------------------------ cookie filter

function parseCookies(text) {
  const cookies = {};
  for (const part of String(text || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

// The hub must show alive monsters only (like wave_3_boss_manager.js).
function isAliveFilterActive(cookieText, url) {
  const cookies = parseCookies(cookieText);
  return (
    cookies.hide_dead_monsters === '1' &&
    cookies.show_dead_bosses_only === '0' &&
    !url?.searchParams?.has('dead_page')
  );
}

// -------------------------------------------------------------- run state

function emptyAction() {
  return { kind: '', at: 0, attempts: 0 };
}

function createRunState({ visitId, routeId, ownerId = '', now = Date.now() }) {
  return {
    version: RUN_VERSION,
    visitId: String(visitId || ''),
    routeId: BOSS_ROUTE_IDS.includes(routeId) ? routeId : '',
    ownerId: String(ownerId || ''),
    leaseUntil: ownerId ? now + TIMING.leaseMs : 0,
    startedAt: now,
    phase: 'hub',
    phaseAt: now,
    domainId: '',
    target: null,
    processed: [],
    failed: [],
    fights: {},
    action: emptyAction(),
    finished: null,
    lastError: '',
  };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function timestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const monsterId = String(value.monsterId || '').trim();
  const damageValue = Number(value.damageValue);
  if (!monsterId || !Number.isFinite(damageValue) || damageValue <= 0) return null;
  return {
    monsterId,
    bossId: String(value.bossId || ''),
    name: String(value.name || ''),
    domainId: String(value.domainId || ''),
    damage: String(value.damage || ''),
    damageValue,
  };
}

function normalizeRunState(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || value.version !== RUN_VERSION) return null;
  const visitId = String(value.visitId || '');
  if (!visitId || !BOSS_ROUTE_IDS.includes(value.routeId)) return null;

  const fights = {};
  for (const [id, count] of Object.entries(value.fights || {})) {
    const number = Math.floor(Number(count));
    if (id && Number.isFinite(number) && number > 0) fights[id] = number;
  }
  const finished =
    value.finished && typeof value.finished === 'object' && ['done', 'error'].includes(value.finished.state)
      ? {
          state: value.finished.state,
          message: String(value.finished.message || ''),
          at: timestamp(value.finished.at, now),
        }
      : null;

  return {
    version: RUN_VERSION,
    visitId,
    routeId: value.routeId,
    ownerId: String(value.ownerId || ''),
    leaseUntil: timestamp(value.leaseUntil),
    startedAt: timestamp(value.startedAt, now),
    phase: finished ? 'finished' : RUN_PHASES.includes(value.phase) ? value.phase : 'hub',
    phaseAt: timestamp(value.phaseAt, now),
    domainId: String(value.domainId || ''),
    target: finished ? null : normalizeTarget(value.target),
    processed: idList(value.processed),
    failed: idList(value.failed),
    fights,
    action: {
      kind: String(value.action?.kind || ''),
      at: timestamp(value.action?.at),
      attempts: Math.max(0, Math.floor(timestamp(value.action?.attempts))),
    },
    finished,
    lastError: String(value.lastError || ''),
  };
}

function setPhase(run, phase, now = Date.now()) {
  if (run.phase === phase) return run;
  return { ...run, phase, phaseAt: now };
}

function recordAction(run, kind, now = Date.now()) {
  const attempts = run.action.kind === kind ? run.action.attempts + 1 : 1;
  return { ...run, action: { kind, at: now, attempts } };
}

function clearAction(run) {
  return run.action.kind ? { ...run, action: emptyAction() } : run;
}

function actionReady(run, kind, now = Date.now(), retryMs = TIMING.actionRetryMs) {
  return run.action.kind !== kind || now - run.action.at >= retryMs;
}

function actionExhausted(run, kind, max = LIMITS.maxActionAttempts) {
  return run.action.kind === kind && run.action.attempts >= max;
}

function enterDomain(run, domainId, now = Date.now()) {
  return {
    ...run,
    domainId: String(domainId || ''),
    phase: 'hub',
    phaseAt: now,
    target: null,
    action: emptyAction(),
  };
}

function selectTarget(run, match, domainId, now = Date.now()) {
  return {
    ...run,
    phase: 'hub',
    phaseAt: now,
    target: normalizeTarget({ ...match, domainId }),
    action: emptyAction(),
  };
}

// Counts the fight before the battle page is opened, so a fight that never
// reports back still uses up one of its attempts.
function beginFight(run, now = Date.now()) {
  if (!run.target) return run;
  const id = run.target.monsterId;
  return {
    ...run,
    phase: 'opening',
    phaseAt: now,
    fights: { ...run.fights, [id]: fightCount(run, id) + 1 },
    action: emptyAction(),
  };
}

function completeTarget(run, now = Date.now()) {
  if (!run.target) return run;
  const id = run.target.monsterId;
  return {
    ...run,
    phase: 'returning',
    phaseAt: now,
    target: null,
    processed: idList([...run.processed, id]),
    failed: run.failed.filter((candidate) => candidate !== id),
    action: emptyAction(),
    lastError: '',
  };
}

// A fight ended without reaching the target. The boss is retried from the
// hub until it used up its fights; abandon=true gives it up right away.
function failTarget(run, message, now = Date.now(), { abandon = false } = {}) {
  if (!run.target) return { ...run, lastError: String(message || '') };
  const id = run.target.monsterId;
  const giveUp = abandon || fightCount(run, id) >= LIMITS.maxFightsPerBoss;
  return {
    ...run,
    phase: 'returning',
    phaseAt: now,
    target: null,
    failed: giveUp ? idList([...run.failed, id]) : run.failed,
    action: emptyAction(),
    lastError: String(message || ''),
  };
}

// Back on the hub without a result (e.g. browser back): drop the target; the
// fight attempt was already counted.
function settleOnHub(run, now = Date.now()) {
  if (run.phase === 'hub') return run;
  return { ...run, phase: 'hub', phaseAt: now, target: null, action: emptyAction() };
}

function finishRun(run, state, message, now = Date.now()) {
  return {
    ...run,
    phase: 'finished',
    phaseAt: now,
    target: null,
    action: emptyAction(),
    finished: { state: state === 'error' ? 'error' : 'done', message: String(message || ''), at: now },
  };
}

function summaryMessage(run) {
  const label = routeLabel(run.routeId);
  const done = run.processed.length;
  const failed = run.failed.length;
  if (done === 0 && failed === 0) return `${label}: no enabled boss needed a fight.`;
  return failed > 0
    ? `${label} finished: ${done} boss fight(s) completed, ${failed} incomplete.`
    : `${label} finished: ${done} boss fight(s) completed.`;
}

// Timers do not run while a mobile tab is frozen. Re-base the timeouts so
// the suspension itself does not count as a failed action.
function refreshAfterResume(run, ownerId, now = Date.now()) {
  if (!run || run.finished || run.ownerId !== ownerId) return run;
  return {
    ...run,
    phaseAt: now,
    action: run.action.at > 0 ? { ...run.action, at: now } : run.action,
    leaseUntil: now + TIMING.leaseMs,
  };
}

function isLeaseHeldByOther(run, ownerId, now = Date.now()) {
  return Boolean(run?.ownerId && run.ownerId !== ownerId && run.leaseUntil > now);
}

function withLease(run, ownerId, now = Date.now()) {
  return { ...run, ownerId, leaseUntil: now + TIMING.leaseMs };
}

function leaseNeedsRenewal(run, now = Date.now()) {
  return run.leaseUntil - now < TIMING.leaseMs - TIMING.leaseRenewMs;
}

// What to do after Monster Auto Battle finished a fight.
function decideAfterFight(reason) {
  if (reason === 'target' || reason === 'defeated') return 'complete';
  if (reason === 'no-stamina') return 'stop-visit';
  return 'retry';
}

function isJoinSuccess(text) {
  return /you have successfully|already (?:joined|in (?:this|the) battle)/i.test(String(text || ''));
}

function isJoinFatal(text) {
  return /invalid monster|monster is dead|not found|no longer/i.test(String(text || ''));
}

module.exports = {
  BOSS_ROUTE_IDS,
  LIMITS,
  OWNER_KEY,
  ROUTE_DOMAINS,
  RUN_KEY,
  RUN_VERSION,
  TIMING,
  VISIT_PARAM,
  actionExhausted,
  actionReady,
  allDomains,
  battlePath,
  beginFight,
  bossNamePrefix,
  buildPlan,
  chooseNextBoss,
  clearAction,
  completeTarget,
  createRunState,
  decideAfterFight,
  domainIdForUrl,
  enterDomain,
  evaluateCommand,
  failTarget,
  fightCount,
  findDomain,
  finishRun,
  hubRouteForUrl,
  isAliveFilterActive,
  isBattleUrl,
  isJoinFatal,
  isJoinSuccess,
  isLeaseHeldByOther,
  leaseNeedsRenewal,
  matchHubBosses,
  needsWork,
  nextDomainId,
  normalizeBossName,
  normalizeRunState,
  parseCookies,
  reachedTarget,
  recordAction,
  refreshAfterResume,
  routeLabel,
  selectTarget,
  setPhase,
  settleOnHub,
  summaryMessage,
  withLease,
  withVisit,
};
