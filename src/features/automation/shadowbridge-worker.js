'use strict';

// Scheduler-owned Shadowbridge worker.  The visible tab stays on the marked
// guild-dungeon hub while instance, location and battle pages are read one at
// a time.  Mutating requests are made only for the current scheduler visit and
// only by the tab that owns the scheduler lease.

const { parseFraction, parseGameNumber } = require('../../core/numbers');
const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { pickPotion, readPotionInventory, usePotion } = require('../../core/potions');
const { createJsonStore, getStorage } = require('../../core/storage');
const { sleep } = require('../../core/time');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../../scheduler/engine');
const { staminaCost, staminaMultiplier } = require('../shared/asterion');
const logic = require('./shadowbridge-logic');
const { createShadowbridgeStatusView } = require('./shadowbridge-status');

const ROUTE_ID = 'shadowbridge';
const JOIN_URL = '/dungeon_join_battle.php';
const DAMAGE_URL = '/damage.php';
const DASHBOARD_URL = '/game_dash.php';

const TIMING = Object.freeze({
  tickMs: 1_000,
  heartbeatMs: 5_000,
  refreshBattleEvery: 20,
  maxAttacksPerMonster: 10_000,
  maxScanPasses: 8,
  lowHpFraction: 0.1,
});

class VisitStop extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'VisitStop';
    this.kind = kind;
  }
}

function readStamina(root) {
  const raw = String(root?.querySelector?.('#stamina_span')?.textContent || '').trim();
  const fraction = parseFraction(raw);
  if (fraction) return fraction.current;
  const match = raw.match(/[\d,.]+\s*[kmbtq]?/i);
  return match ? parseGameNumber(match[0].replace(/\s+/g, '')) : null;
}

function attackPlan(scans, settings, processed = new Set()) {
  const regular = [];
  const bosses = [];
  let sequence = 0;
  for (const scan of scans || []) {
    for (const monster of scan.monsters || []) {
      const key = `${monster.instanceId || scan.location.instanceId}:${monster.monsterId}`;
      const candidate = { ...monster, key, location: scan.location, sequence: sequence++ };
      if (monster.dead || processed.has(key)) continue;
      if (scan.location.isBoss) {
        if (settings.bossRoom.enabled) bosses.push({ ...candidate, target: settings.bossRoom, isBoss: true });
        continue;
      }
      const target = settings.monsters[monster.monsterTypeId];
      if (target?.enabled) regular.push({ ...candidate, target, isBoss: false });
    }
  }

  const order = new Map(settings.order.map((id, index) => [id, index]));
  regular.sort((left, right) => {
    const leftOrder = order.get(left.monsterTypeId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.monsterTypeId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.sequence - right.sequence;
  });
  bosses.sort((left, right) => left.sequence - right.sequence);
  return [...regular, ...bosses];
}

function createShadowbridgeWorker({
  win,
  doc,
  store,
  sessionStore = null,
  fetchDocument,
  postForm,
  getUserId,
  asterionMultiplier = 1,
  sleepImpl = sleep,
  now = () => Date.now(),
  logger = console,
  statusView = createShadowbridgeStatusView(doc),
  profile = {},
}) {
  const routeId = String(profile.routeId || ROUTE_ID);
  const dungeonName = String(profile.dungeonName || 'Shadowbridge Warrens');
  const workerName = String(profile.workerName || dungeonName);
  const parseHubEntry = profile.parseHubEntry || logic.parseHubEntry;
  const buildPlan = profile.attackPlan || attackPlan;
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
    processed: new Set(),
    attacks: 0,
    targets: 0,
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
        /\/guild_dungeon\.php\/?$/i.test(url.pathname) &&
        url.searchParams.get('veyra_route') === routeId,
    );
  }

  function readCommand() {
    const command = normalizeVisit(store.read(COMMAND_KEY), () => true);
    return command?.taskId === routeId ? command : null;
  }

  function ownsSchedulerLease(t = now()) {
    if (!sessionStore || sessionStore.available === false) return true;
    const tabId = sessionStore.readRaw?.(TAB_KEY);
    const lease = store.read(LEASE_KEY);
    return Boolean(
      tabId &&
        lease?.ownerId === tabId &&
        Number.isFinite(Number(lease?.leaseUntil)) &&
        Number(lease.leaseUntil) > t,
    );
  }

  function publish(state, safeToLeave, message, visitId = '', force = false) {
    const t = now();
    const signature = `${visitId}|${state}|${safeToLeave}|${message}`;
    if (!force && signature === runtime.publishSignature && t - runtime.publishAt < TIMING.heartbeatMs) {
      return null;
    }
    runtime.publishSignature = signature;
    runtime.publishAt = t;
    runtime.message = message;
    return publishWorkerStatus(
      store,
      routeId,
      { visitId, workerId: routeId, state, safeToLeave, message },
      t,
    );
  }

  function log(message, level = 'info') {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    logger?.[method]?.(`[Veyra:${routeId}-worker] ${message}`);
  }

  function setWorkingMessage(visitId, message) {
    runtime.message = message;
    publish('working', false, message, visitId);
    statusView.setSummary(message, 'working');
    log(message);
  }

  function setTerminal(visitId, state, message) {
    runtime.terminal = { visitId, state, message };
    runtime.runningVisitId = '';
    publish(state, true, message, visitId, true);
    statusView.finish(message, state);
    log(message, state === 'error' ? 'warn' : 'info');
  }

  function assertCanMutate(visitId) {
    if (runtime.stopped) throw new VisitStop('cancelled', `${workerName} worker stopped.`);
    const command = readCommand();
    if (!command || command.visitId !== visitId) {
      throw new VisitStop('cancelled', `The ${workerName} scheduler visit changed.`);
    }
    if (!ownsSchedulerLease()) {
      throw new VisitStop('ownership', `Another tab owns the ${workerName} scheduler visit.`);
    }
    if (command.phase === 'draining' || now() >= command.deadlineAt) {
      throw new VisitStop('drain', `${workerName} stopped safely at the scheduler deadline.`);
    }
    return command;
  }

  function guardedPostForm(visitId, url, params, options = {}) {
    const previousBeforeAttempt = options.beforeAttempt;
    return postForm(url, params, {
      ...options,
      async beforeAttempt(details) {
        assertCanMutate(visitId);
        await previousBeforeAttempt?.(details);
      },
    });
  }

  function routeConfig() {
    return normalizeConfig(store.read(CONFIG_KEY)).routes[routeId];
  }

  async function readDashboard(visitId) {
    assertCanMutate(visitId);
    return fetchDocument(DASHBOARD_URL);
  }

  function createResourceManager(visitId, route, initialDoc) {
    let sourceDoc = initialDoc;
    let currentStamina = readStamina(initialDoc);
    let inventory = readPotionInventory(initialDoc);

    async function refresh() {
      sourceDoc = await readDashboard(visitId);
      currentStamina = readStamina(sourceDoc);
      inventory = readPotionInventory(sourceDoc);
      return sourceDoc;
    }

    async function ensureInventory() {
      if (inventory.length === 0) await refresh();
      return inventory;
    }

    async function consumePotion(entry, label) {
      assertCanMutate(visitId);
      setWorkingMessage(visitId, `Using ${entry.name || label}.`);
      const result = await usePotion(entry, {
        post: (url, params, options) => guardedPostForm(visitId, url, params, options),
      });
      if (!result.ok) throw new VisitStop('resource', `${label} could not be used: ${result.message || 'unknown response'}`);
      const saved = inventory.find((candidate) => candidate.invId === entry.invId);
      if (saved) saved.quantity = Math.max(0, saved.quantity - 1);
      return result;
    }

    async function ensureStamina(required, forceRefresh = false) {
      if (forceRefresh || currentStamina === null) await refresh();
      // If the dashboard layout does not expose stamina, let damage.php make
      // the authoritative decision.  An insufficient-stamina response comes
      // back through the force-refresh path below.
      if (currentStamina === null || currentStamina >= required) return true;
      await ensureInventory();
      if (currentStamina === null || currentStamina >= required) return true;
      const potion = pickPotion(inventory, route.potions.stamina);
      if (!potion) {
        throw new VisitStop('resource', `Only ${currentStamina} stamina remains and no selected stamina potion is available.`);
      }
      await consumePotion(potion, 'The selected stamina potion');
      await refresh();
      if (currentStamina !== null && currentStamina < required) {
        throw new VisitStop('resource', `Stamina is still below the required ${required} after using a potion.`);
      }
      return true;
    }

    async function ensureHealth(snapshot) {
      if (!Number.isFinite(snapshot.playerHp) || !Number.isFinite(snapshot.playerMaxHp) || snapshot.playerMaxHp <= 0) {
        return true;
      }
      if (snapshot.playerHp <= 0) throw new VisitStop('resource', `Player HP reached zero; ${workerName} stopped.`);
      if (snapshot.playerHp / snapshot.playerMaxHp > TIMING.lowHpFraction) return true;
      await ensureInventory();
      const potion = pickPotion(inventory, route.potions.heal);
      if (!potion) {
        throw new VisitStop(
          'resource',
          `Player HP is at or below ${Math.round(TIMING.lowHpFraction * 100)}% and no selected healing potion is available.`,
        );
      }
      await consumePotion(potion, 'The selected healing potion');
      snapshot.playerHp = snapshot.playerMaxHp;
      return true;
    }

    function spendStamina(amount) {
      if (currentStamina !== null) currentStamina = Math.max(0, currentStamina - amount);
    }

    return { ensureHealth, ensureStamina, refresh, spendStamina };
  }

  async function fetchBattle(target, userId) {
    const battleDoc = await fetchDocument(target.url);
    return {
      doc: battleDoc,
      snapshot: logic.parseBattleSnapshot(battleDoc, {
        userId,
        monsterId: target.monsterId,
        instanceId: target.instanceId,
        url: target.url,
      }),
    };
  }

  function resolveTarget(target, snapshot) {
    return logic.resolveDamageTarget({
      mode: target.target.mode,
      damage: target.target.damage,
      isBoss: target.isBoss,
      snapshot,
    });
  }

  async function joinIfNeeded(visitId, target, userId, battle) {
    if (battle.snapshot.joined === true) return battle;
    if (battle.snapshot.joined !== false) {
      throw new Error(`Could not determine whether ${target.name || 'the monster'} is joined.`);
    }
    const payload = logic.buildJoinPayload({
      instanceId: target.instanceId,
      monsterId: target.monsterId,
      userId,
    });
    if (!payload) throw new Error(`Could not build a safe ${workerName} join request.`);
    assertCanMutate(visitId);
    setWorkingMessage(visitId, `Joining ${target.name || 'Shadowbridge monster'}.`);
    const response = await guardedPostForm(visitId, JOIN_URL, payload);
    const joined = logic.parseJoinResponse(response);
    if (!joined.ok) throw new Error(`Joining ${target.name || 'the monster'} failed: ${joined.message || 'unknown response'}`);
    const refreshed = await fetchBattle(target, userId);
    if (refreshed.snapshot.joined !== true) {
      throw new Error(`The battle page did not confirm that ${target.name || 'the monster'} was joined.`);
    }
    return refreshed;
  }

  function retryDelayFromMessage(message, fallback) {
    const milliseconds = String(message || '').match(/(?:wait|cooldown)[^\d]{0,20}(\d+)\s*ms/i);
    if (milliseconds) return Math.min(30_000, Math.max(fallback, Number(milliseconds[1])));
    const seconds = String(message || '').match(/(?:wait|cooldown)[^\d]{0,20}(\d+(?:\.\d+)?)\s*s/i);
    if (seconds) return Math.min(30_000, Math.max(fallback, Math.ceil(Number(seconds[1]) * 1_000)));
    return null;
  }

  async function attackMonster(visitId, route, target, userId) {
    assertCanMutate(visitId);
    statusView.updateTarget(target.key, { status: 'active', attacks: 0, error: '', result: '' });
    let battle = await fetchBattle(target, userId);
    statusView.updateTarget(target.key, {
      currentDamage: battle.snapshot.ownDamage,
      currentHp: battle.snapshot.currentHp,
      maxHp: battle.snapshot.maxHp,
    });
    if (battle.snapshot.dead) {
      statusView.updateTarget(target.key, { status: 'completed', result: 'Already defeated' });
      return { reason: 'dead', attacks: 0 };
    }
    battle = await joinIfNeeded(visitId, target, userId, battle);

    let decision = resolveTarget(target, battle.snapshot);
    if (!decision.ok) throw new Error(`${target.name || `${workerName} target`}: ${decision.error}`);
    statusView.updateTarget(target.key, {
      currentDamage: battle.snapshot.ownDamage,
      currentHp: battle.snapshot.currentHp,
      maxHp: battle.snapshot.maxHp,
      targetDamage: decision.targetDamage,
      untilDead: decision.untilDead,
    });
    if (decision.done) {
      statusView.updateTarget(target.key, { status: 'completed', result: 'Damage target already reached' });
      return { reason: 'target', attacks: 0 };
    }

    const skill = logic.skillForId(route.settings.skill);
    const payload = logic.buildDamagePayload({
      instanceId: target.instanceId,
      monsterId: target.monsterId,
      skillId: route.settings.skill,
    });
    if (!skill || !payload) throw new Error(`The selected ${workerName} skill is invalid.`);
    const effectiveStaminaCost = staminaCost(skill.cost, asterionMultiplier);
    const resources = createResourceManager(visitId, route, battle.doc);
    let ownDamage = battle.snapshot.ownDamage;
    let attempts = 0;
    let cooldownRetries = 0;

    while (attempts < TIMING.maxAttacksPerMonster) {
      assertCanMutate(visitId);
      if (!decision.untilDead && Number.isFinite(ownDamage) && ownDamage >= decision.targetDamage) {
        statusView.updateTarget(target.key, { status: 'completed', result: 'Damage target reached' });
        return { reason: 'target', attacks: attempts };
      }
      await resources.ensureHealth(battle.snapshot);
      await resources.ensureStamina(effectiveStaminaCost);
      assertCanMutate(visitId);

      setWorkingMessage(
        visitId,
        `Attacking ${target.name || `${workerName} monster`} (${attempts + 1}${
          decision.untilDead ? ', until defeated' : `, ${Math.max(0, decision.targetDamage - ownDamage)} damage remaining`
        }).`,
      );
      const response = await guardedPostForm(visitId, DAMAGE_URL, payload, {
        onRateLimit({ waitMs }) {
          setWorkingMessage(visitId, `${workerName} rate limit: waiting ${Math.ceil(waitMs / 1_000)} seconds.`);
        },
      });
      const result = logic.parseAttackResponse(response);
      if (!result.ok) {
        if (/not enough stamina|insufficient stamina/i.test(result.message)) {
          await resources.ensureStamina(effectiveStaminaCost, true);
          continue;
        }
        const retryMs = retryDelayFromMessage(result.message, route.settings.attackCooldownMs);
        if (retryMs !== null && cooldownRetries < 5) {
          cooldownRetries += 1;
          await sleepImpl(retryMs);
          continue;
        }
        throw new Error(`Attack on ${target.name || 'the monster'} failed: ${result.message || `HTTP ${response?.status || '?'}`}`);
      }
      if (!result.dead && result.damage <= 0) {
        throw new Error(`Attack on ${target.name || 'the monster'} returned no verifiable damage.`);
      }
      cooldownRetries = 0;
      attempts += 1;
      runtime.attacks += 1;
      resources.spendStamina(effectiveStaminaCost);
      if (Number.isFinite(ownDamage)) ownDamage += result.damage;
      if (Number.isFinite(result.playerHp)) battle.snapshot.playerHp = result.playerHp;
      if (Number.isFinite(result.currentHp)) battle.snapshot.currentHp = result.currentHp;
      if (Number.isFinite(result.maxHp)) battle.snapshot.maxHp = result.maxHp;
      statusView.updateTarget(target.key, {
        status: result.dead ? 'completed' : 'active',
        attacks: attempts,
        currentDamage: ownDamage,
        currentHp: result.dead ? 0 : battle.snapshot.currentHp,
        maxHp: battle.snapshot.maxHp,
        targetDamage: decision.targetDamage,
        result: result.dead ? 'Defeated' : '',
      });
      if (result.dead) return { reason: 'dead', attacks: attempts };
      if (!decision.untilDead && Number.isFinite(ownDamage) && ownDamage >= decision.targetDamage) {
        statusView.updateTarget(target.key, { status: 'completed', result: 'Damage target reached' });
        return { reason: 'target', attacks: attempts };
      }

      if (attempts % TIMING.refreshBattleEvery === 0 || result.currentHp === null) {
        battle = await fetchBattle(target, userId);
        if (battle.snapshot.dead) {
          statusView.updateTarget(target.key, { status: 'completed', currentHp: 0, result: 'Defeated' });
          return { reason: 'dead', attacks: attempts };
        }
        decision = resolveTarget(target, battle.snapshot);
        if (!decision.ok) throw new Error(`${target.name || `${workerName} target`}: ${decision.error}`);
        ownDamage = battle.snapshot.ownDamage;
        statusView.updateTarget(target.key, {
          currentDamage: ownDamage,
          currentHp: battle.snapshot.currentHp,
          maxHp: battle.snapshot.maxHp,
          targetDamage: decision.targetDamage,
        });
        if (decision.done) {
          statusView.updateTarget(target.key, { status: 'completed', result: 'Damage target reached' });
          return { reason: 'target', attacks: attempts };
        }
      }
      await sleepImpl(route.settings.attackCooldownMs);
    }
    throw new Error(`${target.name || `${workerName} target`} exceeded the per-monster attack safety limit.`);
  }

  async function scanLocations(visitId, instance) {
    const scans = [];
    for (const location of instance.locations) {
      assertCanMutate(visitId);
      setWorkingMessage(visitId, `Scanning ${location.label || `${workerName} location ${location.id}`}.`);
      const locationDoc = await fetchDocument(location.url);
      scans.push({
        location,
        monsters: logic.parseLocationPage(locationDoc, location.url),
      });
    }
    return scans;
  }

  async function loadInstance(visitId, url) {
    assertCanMutate(visitId);
    const instanceDoc = await fetchDocument(url);
    const instance = logic.parseInstancePage(instanceDoc, url);
    if (!instance.instanceId) throw new Error(`The ${workerName} instance id could not be read.`);
    if (instance.locations.length === 0) {
      throw new Error(`No unlocked ${workerName} locations were found on the instance page.`);
    }
    return instance;
  }

  async function executeVisit(command) {
    const visitId = command.visitId;
    const route = routeConfig();
    const hasEnabledTargets = profile.hasEnabledTargets
      ? profile.hasEnabledTargets(route.settings)
      : Object.values(route.settings.monsters).some((target) => target.enabled) || route.settings.bossRoom.enabled;
    if (!hasEnabledTargets) {
      setTerminal(visitId, 'done', `${workerName} has no enabled targets.`);
      return;
    }

    statusView.begin(`Looking for the active ${dungeonName} instance.`);
    setWorkingMessage(visitId, `Looking for the active ${dungeonName} instance.`);
    const entry = parseHubEntry(doc, currentUrl()?.href);
    if (!entry) throw new Error(`The ${dungeonName} entry was not found on the guild-dungeon page.`);
    const userId = await getUserId();
    if (!userId) throw new Error(`The player id could not be determined for ${workerName}.`);

    let instanceUrl = entry.url;
    for (let pass = 0; pass < TIMING.maxScanPasses; pass += 1) {
      assertCanMutate(visitId);
      const instance = await loadInstance(visitId, instanceUrl);
      instanceUrl = new URL(`/guild_dungeon_instance.php?id=${encodeURIComponent(instance.instanceId)}`, win.location.origin).href;
      const scans = await scanLocations(visitId, instance);
      profile.onScans?.({ scans, route, store });
      const plan = buildPlan(scans, route.settings, runtime.processed);
      statusView.setPlan(plan);
      if (plan.length === 0) {
        const bossEnabled = profile.isBossEnabled
          ? profile.isBossEnabled(route.settings)
          : route.settings.bossRoom?.enabled === true;
        const bossNote = bossEnabled && instance.bossLocked ? ' The Boss Room is still locked.' : '';
        setTerminal(
          visitId,
          'done',
          `${workerName} finished ${runtime.targets} target(s) with ${runtime.attacks} attack(s).${bossNote}`,
        );
        return;
      }

      for (const target of plan) {
        assertCanMutate(visitId);
        let result = null;
        try {
          result = await attackMonster(visitId, route, target, String(userId));
        } catch (error) {
          statusView.updateTarget(target.key, {
            status: 'error',
            error: String(error?.message || error || 'Attack failed'),
          });
          throw error;
        }
        runtime.processed.add(target.key);
        runtime.targets += 1;
        setWorkingMessage(
          visitId,
          `${target.name || `${workerName} monster`} ${
            result.reason === 'dead' ? 'is defeated' : 'reached its configured damage target'
          }; checking the next target.`,
        );
      }

      // Re-read the instance after each complete plan: killing the last normal
      // monster can unlock a dynamically linked Boss Room.
    }
    throw new Error(`${workerName} did not settle after repeated instance rescans.`);
  }

  async function tick() {
    if (runtime.stopped || runtime.ticking || !isMarkedHub()) return;
    const command = readCommand();
    if (!command) {
      if (!runtime.runningVisitId) publish('idle', true, `${workerName} is idle on the dungeon page.`);
      return;
    }
    if (!ownsSchedulerLease()) return;
    if (runtime.terminal?.visitId === command.visitId) {
      publish(runtime.terminal.state, true, runtime.terminal.message, command.visitId);
      return;
    }
    if (command.phase === 'draining' || now() >= command.deadlineAt) {
      setTerminal(command.visitId, 'done', `${workerName} stopped safely before starting another action.`);
      return;
    }

    runtime.ticking = true;
    runtime.runningVisitId = command.visitId;
    runtime.terminal = null;
    runtime.processed = new Set();
    runtime.attacks = 0;
    runtime.targets = 0;
    try {
      await executeVisit(command);
    } catch (error) {
      if (error instanceof VisitStop) {
        if (error.kind === 'ownership' || error.kind === 'cancelled') return;
        setTerminal(command.visitId, 'done', error.message);
      } else {
        setTerminal(command.visitId, 'error', `${workerName} failed safely: ${error?.message || error}`);
      }
    } finally {
      runtime.ticking = false;
      if (!runtime.terminal) runtime.runningVisitId = '';
    }
  }

  function heartbeat() {
    if (!runtime.runningVisitId || runtime.terminal || !ownsSchedulerLease()) return;
    publish(
      'working',
      false,
      runtime.message || `${workerName} is working.`,
      runtime.runningVisitId,
      true,
    );
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
    statusView.destroy();
  }

  return { heartbeat, onPageHide, onPageShow, onVisibilityChange, runtime, start, statusView, stop, tick };
}

const shadowbridgeWorkerFeature = Object.freeze({
  id: 'shadowbridge-worker',
  group: 'Automation',
  settings: [],
  matches(url) {
    return /\/guild_dungeon\.php\/?$/i.test(url.pathname);
  },
  run(ctx) {
    let multiplier = 1;
    try {
      multiplier = staminaMultiplier(ctx);
    } catch {
      // The optional shared setting is unavailable only in isolated tests.
    }
    const worker = createShadowbridgeWorker({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      sessionStore: createJsonStore(getStorage('sessionStorage', ctx.win), '[Veyra]'),
      fetchDocument: ctx.fetchDocument,
      postForm: ctx.postForm,
      getUserId: ctx.getUserId,
      asterionMultiplier: multiplier,
    });
    worker.start();
    return worker;
  },
});

module.exports = {
  DAMAGE_URL,
  DASHBOARD_URL,
  JOIN_URL,
  ROUTE_ID,
  TIMING,
  VisitStop,
  attackPlan,
  createShadowbridgeWorker,
  readStamina,
  shadowbridgeWorkerFeature,
};
