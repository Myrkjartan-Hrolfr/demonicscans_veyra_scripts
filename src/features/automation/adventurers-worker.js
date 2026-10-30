'use strict';

// Scheduler-owned Adventurer's Guild worker. It keeps the marked guild page
// visible and performs the two requested phases through same-origin requests:
// pre-farm every quest monster first, then accept/loot/finish quests one by
// one. Auto Farm is snapshotted and restored after the last quest.

const { setProtectedNames } = require('../../core/loot-guard');
const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { createJsonStore, getStorage } = require('../../core/storage');
const { sleep } = require('../../core/time');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../../scheduler/engine');
const logic = require('./adventurers-logic');

const ROUTE_ID = 'adventurers';
const GUILD_PATH = '/adventurers_guild.php';
const AUTO_FARM_PATH = '/auto_farm_actions.php';
const ACCEPT_PATH = '/adventurers_accept_quest.php';
const FINISH_PATH = '/adventurers_finish_quest.php';
const LOOT_PATH = '/loot.php';
const AUTOFARM_SNAPSHOT_KEY = 'veyra:adventurers:auto-farm-snapshot:v1';
const MAX_DEAD_PAGES = 20;
const MAX_QUEST_STEPS = 100;
const FARM_POLL_MS = 10_000;
const ACTION_DELAY_MS = 150;
const POTION_LIMIT = 1_000;

const TIMING = Object.freeze({
  tickMs: 1_000,
  heartbeatMs: 5_000,
  drainCheckMs: 1_000,
});

class VisitStop extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = 'VisitStop';
    this.kind = kind;
    this.retryAt = Number(options.retryAt) || 0;
    this.note = String(options.note || '');
  }
}

function createAdventurersWorker({
  win,
  doc,
  store,
  sessionStore = null,
  fetchDocument,
  postForm,
  getUserId,
  sleepImpl = sleep,
  now = () => Date.now(),
  logger = console,
}) {
  const runtime = {
    stopped: false,
    ticking: false,
    runningVisitId: '',
    terminal: null,
    interval: null,
    heartbeat: null,
    message: '',
    publishSignature: '',
    publishAt: 0,
  };

  function currentUrl() {
    try {
      return new URL(win.location.href, win.location.origin);
    } catch {
      return null;
    }
  }

  function isMarkedHub(url = currentUrl()) {
    return Boolean(
      url &&
        /\/adventurers_guild\.php\/?$/i.test(url.pathname) &&
        url.searchParams.get('veyra_route') === ROUTE_ID,
    );
  }

  function readCommand() {
    const command = normalizeVisit(store.read(COMMAND_KEY), () => true);
    return command?.taskId === ROUTE_ID ? command : null;
  }

  function ownsSchedulerLease(t = now()) {
    if (!sessionStore || sessionStore.available === false) return true;
    const tabId = sessionStore.readRaw?.(TAB_KEY);
    const lease = store.read(LEASE_KEY);
    return Boolean(tabId && lease?.ownerId === tabId && Number(lease?.leaseUntil) > t);
  }

  function publish(state, safeToLeave, message, visitId = '', options = {}) {
    const t = now();
    const retryAt = Number(options.retryAt) || 0;
    const note = String(options.note || '');
    const signature = `${visitId}|${state}|${safeToLeave}|${message}|${retryAt}|${note}`;
    if (!options.force && signature === runtime.publishSignature && t - runtime.publishAt < TIMING.heartbeatMs) {
      return null;
    }
    runtime.publishSignature = signature;
    runtime.publishAt = t;
    runtime.message = message;
    return publishWorkerStatus(
      store,
      ROUTE_ID,
      { visitId, workerId: ROUTE_ID, state, safeToLeave, message, retryAt, note },
      t,
    );
  }

  function log(message, level = 'info') {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    logger?.[method]?.(`[Veyra:adventurers-worker] ${message}`);
  }

  function setWorkingMessage(visitId, message) {
    runtime.message = message;
    publish('working', false, message, visitId);
    log(message);
  }

  function setTerminal(visitId, state, message, options = {}) {
    runtime.terminal = {
      visitId,
      state,
      message,
      retryAt: Number(options.retryAt) || 0,
      note: String(options.note || ''),
    };
    runtime.runningVisitId = '';
    publish(state, true, message, visitId, { ...runtime.terminal, force: true });
    log(message, state === 'error' ? 'warn' : 'info');
  }

  function assertCanContinue(visitId) {
    if (runtime.stopped) throw new VisitStop('cancelled', "Adventurer's Guild worker stopped.");
    const command = readCommand();
    if (!command || command.visitId !== visitId) {
      throw new VisitStop('cancelled', "The Adventurer's Guild scheduler visit changed.");
    }
    if (!ownsSchedulerLease()) {
      throw new VisitStop('ownership', "Another tab owns the Adventurer's Guild scheduler visit.");
    }
    if (command.phase === 'draining' || now() >= command.deadlineAt) {
      throw new VisitStop('drain', "Adventurer's Guild stopped safely at the scheduler deadline.", {
        retryAt: now() + 60_000,
        note: 'Quest work will resume',
      });
    }
    return command;
  }

  function guardedPost(visitId, url, params, options = {}) {
    const previousBeforeAttempt = options.beforeAttempt;
    return postForm(url, params, {
      ...options,
      async beforeAttempt(details) {
        assertCanContinue(visitId);
        await previousBeforeAttempt?.(details);
      },
    });
  }

  async function waitWithGuard(visitId, durationMs) {
    let remaining = Math.max(0, durationMs);
    while (remaining > 0) {
      assertCanContinue(visitId);
      const chunk = Math.min(TIMING.drainCheckMs, remaining);
      await sleepImpl(chunk);
      remaining -= chunk;
    }
    assertCanContinue(visitId);
  }

  async function fetchFresh(visitId, path) {
    assertCanContinue(visitId);
    const separator = path.includes('?') ? '&' : '?';
    return fetchDocument(`${path}${separator}_veyra_quest=${now()}`);
  }

  function responseMessage(response) {
    return String(response?.json?.message || response?.json?.msg || response?.json?.error || response?.text || '').trim();
  }

  function requireSuccess(response, label) {
    if (logic.responseSucceeded(response)) return response;
    throw new Error(`${label} failed${responseMessage(response) ? `: ${responseMessage(response)}` : '.'}`);
  }

  function routeConfig() {
    return normalizeConfig(store.read(CONFIG_KEY)).routes[ROUTE_ID];
  }

  function requirementSignature(requirements) {
    return (requirements || [])
      .map((requirement) => `${requirement.normalizedName}:${requirement.count}:${requirement.minDamage}`)
      .sort()
      .join('|');
  }

  function makeTargetPayload(target, patch = {}) {
    return {
      TARGET_ID: target.targetId,
      MONSTER_ID: target.monsterId,
      IS_ENABLED: patch.enabled ?? (target.enabled ? 1 : 0),
      DAMAGE_OR_CAP: patch.mode ?? target.mode,
      MIN_DAMAGE: patch.minDamage ?? target.minDamage,
      MAX_STACK_PER_HIT: patch.maxStack ?? target.maxStack,
    };
  }

  function potionSettings(base) {
    const selected = routeConfig()?.potions || { stamina: [], heal: [] };
    const stamina = new Set((selected.stamina || []).map(Number));
    const heal = new Set((selected.heal || []).map(Number));
    const priority = [30, 251, 35, 359].find((itemId) => stamina.has(itemId)) || 0;
    return {
      ...base,
      TOTAL_MONSTERS_TO_KILL: '0',
      HP_POTIONS_MAX_TO_USE: heal.has(108) ? String(POTION_LIMIT) : '0',
      STAM_POT_SMALL_ITEM_MAX_TO_USE: stamina.has(30) ? String(POTION_LIMIT) : '0',
      STAM_POT_HALF_ITEM_ID_MAX_TO_USE: stamina.has(251) ? String(POTION_LIMIT) : '0',
      STAM_POT_FULL_ITEM_ID_MAX_TO_USE: stamina.has(35) ? String(POTION_LIMIT) : '0',
      STAM_POT_ADV_ITEM_MAX_TO_USE: stamina.has(359) ? String(POTION_LIMIT) : '0',
      STAM_POT_PRIORITY_ITEM_ID: String(priority),
      AUTO_LOOT_TO_LEVEL: '0',
    };
  }

  function snapshotFromDocument(waveDoc, requirements) {
    return {
      version: 1,
      capturedAt: now(),
      active: logic.autoFarmIsActive(waveDoc),
      settings: logic.readAutoFarmSettings(waveDoc),
      targets: logic.readAutoFarmTargets(waveDoc),
      questNames: requirements.map((requirement) => requirement.normalizedName),
      configuredFor: '',
    };
  }

  async function configureAutoFarm(visitId, requirements, waveDoc) {
    let snapshot = store.read(AUTOFARM_SNAPSHOT_KEY);
    if (!snapshot?.version || !Array.isArray(snapshot.targets)) {
      snapshot = snapshotFromDocument(waveDoc, requirements);
      store.write(AUTOFARM_SNAPSHOT_KEY, snapshot);
    }

    requireSuccess(await guardedPost(visitId, AUTO_FARM_PATH, { action: 'toggle', enabled: 0 }), 'Pausing Auto Farm');
    await waitWithGuard(visitId, ACTION_DELAY_MS);

    const requiredByName = new Map(requirements.map((requirement) => [requirement.normalizedName, requirement]));
    const targets = logic.readAutoFarmTargets(waveDoc);
    const options = logic.readMonsterOptions(waveDoc);
    const found = new Set();

    for (const target of targets) {
      const requirement = requiredByName.get(target.normalizedName);
      if (requirement) found.add(target.normalizedName);
      const desired = requirement
        ? { enabled: 1, mode: '1', minDamage: requirement.minDamage, maxStack: 50 }
        : target.enabled
          ? { enabled: 0 }
          : null;
      if (!desired) continue;
      requireSuccess(
        await guardedPost(visitId, AUTO_FARM_PATH, { action: 'update_target', ...makeTargetPayload(target, desired) }),
        `Updating Auto Farm target ${target.name}`,
      );
      await waitWithGuard(visitId, ACTION_DELAY_MS);
    }

    for (const requirement of requirements) {
      if (found.has(requirement.normalizedName)) continue;
      const option = options.get(requirement.normalizedName);
      if (!option) throw new Error(`Auto Farm does not offer the quest monster "${requirement.name}".`);
      requireSuccess(
        await guardedPost(visitId, AUTO_FARM_PATH, {
          action: 'add_target',
          MONSTER_ID: option.id,
          DAMAGE_OR_CAP: 1,
          MIN_DAMAGE: requirement.minDamage,
          IS_ENABLED: 1,
          MAX_STACK_PER_HIT: 50,
        }),
        `Adding Auto Farm target ${requirement.name}`,
      );
      await waitWithGuard(visitId, ACTION_DELAY_MS);
    }

    requireSuccess(
      await guardedPost(visitId, AUTO_FARM_PATH, {
        action: 'save_settings',
        ...potionSettings(logic.readAutoFarmSettings(waveDoc)),
      }),
      'Saving Auto Farm quest settings',
    );
    requireSuccess(await guardedPost(visitId, AUTO_FARM_PATH, { action: 'toggle', enabled: 1 }), 'Starting Auto Farm');

    snapshot.configuredFor = requirementSignature(requirements);
    snapshot.questNames = [...new Set([...(snapshot.questNames || []), ...requirements.map((item) => item.normalizedName)])];
    store.write(AUTOFARM_SNAPSHOT_KEY, snapshot);
  }

  async function pauseOwnedAutoFarm(visitId) {
    if (!store.read(AUTOFARM_SNAPSHOT_KEY)) return;
    requireSuccess(await guardedPost(visitId, AUTO_FARM_PATH, { action: 'toggle', enabled: 0 }), 'Pausing quest Auto Farm');
  }

  // A draining command forbids ordinary mutations, but leaving the game's
  // server-side Auto Farm running would not be a safe withdrawal. This one
  // cleanup mutation is allowed only for the same visit while this tab still
  // owns the scheduler lease. The snapshot stays in place for a later resume.
  async function pauseAutoFarmForDrain(command) {
    if (!store.read(AUTOFARM_SNAPSHOT_KEY)) return;
    try {
      const response = await postForm(AUTO_FARM_PATH, { action: 'toggle', enabled: 0 }, {
        maxRetries: 1,
        beforeAttempt() {
          const current = readCommand();
          if (!current || current.visitId !== command.visitId || !ownsSchedulerLease()) {
            throw new VisitStop('ownership', 'The quest Auto Farm cleanup no longer owns this visit.');
          }
        },
      });
      if (!logic.responseSucceeded(response)) {
        log(`Could not pause Auto Farm during withdrawal: ${responseMessage(response) || 'unknown response'}`, 'warn');
      }
    } catch (error) {
      log(`Could not pause Auto Farm during withdrawal: ${error?.message || error}`, 'warn');
    }
  }

  async function restoreAutoFarm(visitId) {
    const snapshot = store.read(AUTOFARM_SNAPSHOT_KEY);
    if (!snapshot?.version || !Array.isArray(snapshot.targets)) return;
    setWorkingMessage(visitId, 'Restoring the previous Auto Farm configuration.');
    requireSuccess(await guardedPost(visitId, AUTO_FARM_PATH, { action: 'toggle', enabled: 0 }), 'Pausing Auto Farm');
    const currentDoc = await fetchFresh(visitId, logic.WAVE_PATH);
    const originalIds = new Set(snapshot.targets.map((target) => String(target.targetId)));
    const questNames = new Set(snapshot.questNames || []);

    for (const target of logic.readAutoFarmTargets(currentDoc)) {
      const original = snapshot.targets.find((saved) => String(saved.targetId) === String(target.targetId));
      if (original) {
        requireSuccess(
          await guardedPost(visitId, AUTO_FARM_PATH, {
            action: 'update_target',
            ...makeTargetPayload(original),
          }),
          `Restoring Auto Farm target ${original.name}`,
        );
      } else if (!originalIds.has(String(target.targetId)) && questNames.has(target.normalizedName)) {
        requireSuccess(
          await guardedPost(visitId, AUTO_FARM_PATH, {
            action: 'update_target',
            ...makeTargetPayload(target, { enabled: 0 }),
          }),
          `Disabling temporary Auto Farm target ${target.name}`,
        );
      } else {
        continue;
      }
      await waitWithGuard(visitId, ACTION_DELAY_MS);
    }

    requireSuccess(
      await guardedPost(visitId, AUTO_FARM_PATH, { action: 'save_settings', ...snapshot.settings }),
      'Restoring Auto Farm settings',
    );
    requireSuccess(
      await guardedPost(visitId, AUTO_FARM_PATH, { action: 'toggle', enabled: snapshot.active ? 1 : 0 }),
      'Restoring Auto Farm state',
    );
    store.remove(AUTOFARM_SNAPSHOT_KEY);
  }

  async function readDeadPool(visitId, requirements) {
    const first = await fetchFresh(visitId, logic.WAVE_PATH);
    const documents = [first];
    let totalPages = Math.min(MAX_DEAD_PAGES, logic.deadPageCount(first));
    let lastCount = (first.querySelectorAll?.('.monster-card[data-dead="1"]') || []).length;
    if (totalPages === 1 && lastCount >= logic.DEAD_PAGE_SIZE) totalPages = MAX_DEAD_PAGES;

    const seenIds = new Set();
    const monsters = [];
    function collect(source) {
      let added = 0;
      for (const monster of logic.readDeadMonsters(source, now())) {
        if (seenIds.has(monster.id)) continue;
        seenIds.add(monster.id);
        monsters.push(monster);
        added += 1;
      }
      return added;
    }
    collect(first);

    for (let page = 2; page <= totalPages; page += 1) {
      if (logic.requirementsSatisfied(requirements, monsters)) break;
      await waitWithGuard(visitId, ACTION_DELAY_MS);
      const pageDoc = await fetchFresh(visitId, `${logic.WAVE_PATH}&dead_page=${page}`);
      documents.push(pageDoc);
      const cards = (pageDoc.querySelectorAll?.('.monster-card[data-dead="1"]') || []).length;
      const added = collect(pageDoc);
      if (added === 0 || (totalPages === MAX_DEAD_PAGES && cards < logic.DEAD_PAGE_SIZE)) break;
      lastCount = cards;
    }
    void lastCount;
    return { monsters, waveDoc: first, documents };
  }

  function countsMessage(requirements, monsters) {
    return logic
      .requirementCounts(requirements, monsters)
      .map(({ requirement, count }) => `${requirement.name} ${Math.min(count, requirement.count)}/${requirement.count}`)
      .join(', ');
  }

  async function ensurePrefarmed(visitId, requirements) {
    let pool = await readDeadPool(visitId, requirements);
    if (logic.requirementsSatisfied(requirements, pool.monsters)) {
      await pauseOwnedAutoFarm(visitId);
      return pool;
    }

    setWorkingMessage(visitId, `Preparing Auto Farm: ${countsMessage(requirements, pool.monsters)}.`);
    await configureAutoFarm(visitId, requirements, pool.waveDoc);

    while (true) {
      await waitWithGuard(visitId, FARM_POLL_MS);
      pool = await readDeadPool(visitId, requirements);
      if (logic.requirementsSatisfied(requirements, pool.monsters)) {
        await pauseOwnedAutoFarm(visitId);
        setWorkingMessage(visitId, 'Every quest monster has been pre-farmed; starting quest turn-ins.');
        return pool;
      }
      setWorkingMessage(visitId, `Pre-farming quest monsters: ${countsMessage(requirements, pool.monsters)}.`);
    }
  }

  async function acceptQuest(visitId, quest) {
    setWorkingMessage(visitId, `Accepting quest: ${quest.title}.`);
    requireSuccess(
      await guardedPost(visitId, ACCEPT_PATH, { quest_id: quest.id }),
      `Accepting quest ${quest.title}`,
    );
    await waitWithGuard(visitId, 500);
  }

  async function finishQuest(visitId, quest) {
    setWorkingMessage(visitId, `Turning in quest: ${quest.title}.`);
    requireSuccess(
      await guardedPost(visitId, FINISH_PATH, { quest_id: quest.id }),
      `Turning in quest ${quest.title}`,
    );
    await waitWithGuard(visitId, 500);
  }

  async function lootForQuest(visitId, quest, userId) {
    let current = quest;
    let needed = Math.max(0, current.requirement.count - current.progress.current);
    const pool = await readDeadPool(visitId, [current.requirement]);
    const candidates = logic.eligibleForRequirement(pool.monsters, current.requirement);
    let successes = 0;

    for (const monster of candidates) {
      if (needed <= 0 || current.finishReady) break;
      setWorkingMessage(
        visitId,
        `Looting ${current.requirement.name} for ${current.title} (${current.progress.current}/${current.requirement.count}).`,
      );
      const response = await guardedPost(visitId, LOOT_PATH, { monster_id: monster.id, user_id: userId });
      if (logic.responseSucceeded(response)) successes += 1;
      await waitWithGuard(visitId, ACTION_DELAY_MS);

      const guildDoc = await fetchFresh(visitId, GUILD_PATH);
      const quests = logic.parseQuests(guildDoc, now());
      const fresh = quests.find((candidate) => candidate.state === 'active' && candidate.id === current.id);
      if (!fresh) {
        const completed = quests.find((candidate) => candidate.id === current.id && candidate.state === 'cooldown');
        if (completed) return;
        continue;
      }
      current = fresh;
      needed = Math.max(0, current.requirement.count - current.progress.current);
      if (!current.progress.current && successes > 0) needed = Math.max(0, current.requirement.count - successes);
    }

    const guildDoc = await fetchFresh(visitId, GUILD_PATH);
    const fresh = logic.parseQuests(guildDoc, now()).find((candidate) => candidate.state === 'active' && candidate.id === quest.id);
    if (fresh?.finishReady || (fresh && fresh.progress.current >= fresh.requirement.count)) return;
    throw new VisitStop('retry', `More eligible ${quest.requirement.name} monsters are needed for ${quest.title}.`, {
      retryAt: now() + 60_000,
      note: 'Pre-farming more quest monsters',
    });
  }

  async function processQuests(visitId) {
    const rawUserId = await getUserId?.();
    const userId = logic.validId(rawUserId);
    if (!userId) throw new Error('The current user ID could not be determined for quest looting.');

    for (let step = 0; step < MAX_QUEST_STEPS; step += 1) {
      const guildDoc = await fetchFresh(visitId, GUILD_PATH);
      const quests = logic.parseQuests(guildDoc, now());
      const actionable = logic.actionableQuests(quests);
      setProtectedNames(store, actionable.map((quest) => quest.requirement.name));
      const active = actionable.find((quest) => quest.state === 'active');

      if (active) {
        if (active.finishReady || active.progress.current >= active.requirement.count) {
          await finishQuest(visitId, active);
        } else {
          await lootForQuest(visitId, active, userId);
        }
        continue;
      }

      const available = actionable.find((quest) => quest.state === 'available' && quest.id);
      if (available) {
        await acceptQuest(visitId, available);
        continue;
      }

      return { quests, earliestCooldown: logic.earliestCooldown(quests, now()) };
    }
    throw new Error('Quest processing exceeded its safe step limit.');
  }

  async function runVisit(visitId) {
    const guildDoc = await fetchFresh(visitId, GUILD_PATH);
    const quests = logic.parseQuests(guildDoc, now());
    const actionable = logic.actionableQuests(quests);

    if (!actionable.length) {
      await restoreAutoFarm(visitId);
      setProtectedNames(store, []);
      return { quests, earliestCooldown: logic.earliestCooldown(quests, now()) };
    }

    const requirements = logic.aggregateRequirements(actionable.map((quest) => quest.requirement));
    setProtectedNames(store, requirements.map((requirement) => requirement.name));
    setWorkingMessage(visitId, `Checking ${requirements.length} quest monster target(s) before accepting a quest.`);
    await ensurePrefarmed(visitId, requirements);
    const result = await processQuests(visitId);
    await restoreAutoFarm(visitId);
    setProtectedNames(store, []);
    return result;
  }

  async function tick() {
    if (runtime.stopped || runtime.ticking || !isMarkedHub()) return;
    const command = readCommand();
    if (!command) {
      publish('idle', true, "Adventurer's Guild worker is idle.");
      return;
    }
    if (runtime.terminal?.visitId === command.visitId) {
      publish(runtime.terminal.state, true, runtime.terminal.message, command.visitId, runtime.terminal);
      return;
    }
    if (command.phase === 'draining') {
      await pauseAutoFarmForDrain(command);
      setTerminal(command.visitId, 'done', "Adventurer's Guild stopped safely before starting.", {
        retryAt: now() + 60_000,
        note: 'Quest work will resume',
      });
      return;
    }
    if (!ownsSchedulerLease()) return;

    runtime.ticking = true;
    runtime.runningVisitId = command.visitId;
    runtime.terminal = null;
    setWorkingMessage(command.visitId, "Adventurer's Guild visit started.");
    try {
      const result = await runVisit(command.visitId);
      const retryAt = Number(result.earliestCooldown) || 0;
      setTerminal(
        command.visitId,
        'done',
        retryAt
          ? "All available Adventurer's Guild quests are complete."
          : "No available Adventurer's Guild quests remain.",
        { retryAt, note: retryAt ? 'Next quest cooldown' : '' },
      );
    } catch (error) {
      if (error instanceof VisitStop) {
        if (error.kind === 'ownership' || error.kind === 'cancelled') return;
        if (error.kind === 'drain') await pauseAutoFarmForDrain(command);
        setTerminal(command.visitId, 'done', error.message, error);
      } else {
        setTerminal(command.visitId, 'error', `Adventurer's Guild failed safely: ${error?.message || error}`);
      }
    } finally {
      runtime.ticking = false;
      if (!runtime.terminal) runtime.runningVisitId = '';
    }
  }

  function heartbeat() {
    if (!runtime.runningVisitId || runtime.terminal || !ownsSchedulerLease()) return;
    publish('working', false, runtime.message || "Adventurer's Guild is working.", runtime.runningVisitId, {
      force: true,
    });
  }

  function onVisibilityChange() {
    if (doc.hidden !== true && doc.visibilityState !== 'hidden') void tick();
  }

  function onPageShow() {
    void tick();
  }

  function onPageHide(event) {
    if (!event?.persisted) stop();
  }

  function start() {
    runtime.interval = win.setInterval?.(() => void tick(), TIMING.tickMs) ?? null;
    runtime.heartbeat = win.setInterval?.(heartbeat, TIMING.heartbeatMs) ?? null;
    doc.addEventListener?.('visibilitychange', onVisibilityChange);
    win.addEventListener?.('pageshow', onPageShow);
    win.addEventListener?.('pagehide', onPageHide);
    void tick();
  }

  function stop() {
    runtime.stopped = true;
    if (runtime.interval !== null) win.clearInterval?.(runtime.interval);
    if (runtime.heartbeat !== null) win.clearInterval?.(runtime.heartbeat);
    runtime.interval = null;
    runtime.heartbeat = null;
    doc.removeEventListener?.('visibilitychange', onVisibilityChange);
    win.removeEventListener?.('pageshow', onPageShow);
    win.removeEventListener?.('pagehide', onPageHide);
  }

  return { heartbeat, onPageHide, onPageShow, onVisibilityChange, runtime, start, stop, tick };
}

const adventurersWorkerFeature = Object.freeze({
  id: 'adventurers-worker',
  group: 'Automation',
  settings: [],
  matches(url) {
    return /\/adventurers_guild\.php\/?$/i.test(url.pathname);
  },
  run(ctx) {
    const worker = createAdventurersWorker({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      sessionStore: createJsonStore(getStorage('sessionStorage', ctx.win), '[Veyra]'),
      fetchDocument: ctx.fetchDocument,
      postForm: ctx.postForm,
      getUserId: ctx.getUserId,
    });
    worker.start();
    return worker;
  },
});

module.exports = {
  ACCEPT_PATH,
  AUTOFARM_SNAPSHOT_KEY,
  AUTO_FARM_PATH,
  FINISH_PATH,
  GUILD_PATH,
  LOOT_PATH,
  ROUTE_ID,
  TIMING,
  VisitStop,
  adventurersWorkerFeature,
  createAdventurersWorker,
};
