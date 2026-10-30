'use strict';

// Scheduler-owned Polyhedral Crucible worker. The marked guild-dungeon hub
// remains visible while the worker reads and acts on PvE, PvP and Army pages
// sequentially. Every mutation is guarded by the current visit id and lease.

const { parseFraction, parseGameNumber } = require('../../core/numbers');
const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { pickPotion, readPotionInventory, usePotion } = require('../../core/potions');
const { createJsonStore, getStorage } = require('../../core/storage');
const { sleep } = require('../../core/time');
const crucibleRoute = require('../../routes/crucible');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { LEASE_KEY, TAB_KEY } = require('../../scheduler/engine');
const { staminaCost, staminaMultiplier } = require('../shared/asterion');
const logic = require('./crucible-logic');
const {
  PVP_BACKGROUND_FALLBACK_MS,
  PVP_BACKGROUND_NAVIGATION_GRACE_MS,
  PVP_LOBBY_CHECK_MS,
  PVP_MATCH_CHECK_MS,
  visitPvpRewardPage,
  watchPvpLobby,
  watchPvpMatch,
} = require('./crucible-pvp-watch');
const dungeonLogic = require('./shadowbridge-logic');

const ROUTE_ID = 'crucible';
const JOIN_URL = '/dungeon_join_battle.php';
const DAMAGE_URL = '/damage.php';
const DASHBOARD_URL = '/game_dash.php';
const CUBE_ACTION_URL = '/guild_dungeon_cube_action.php';
const PVP_ACTION_URL = '/pvp_style_action.php';
const PVP_STATE_URL = '/pvp_style_state.php';
const ARMY_ACTION_URL = '/guild_dungeon_cube_army_action.php';
const ARMY_LIVE_URL = '/shadow_army_live_battle.php';
const SHADOW_ARMY_URL = '/shadow_army.php';
const SHADOW_ARMY_FORMATION_URL = '/shadow_army_formation.php';
const MINIMAL_ARMY_CONTRIBUTIONS_KEY = 'veyra:crucible:minimal-army-contributions:v1';

const TIMING = Object.freeze({
  tickMs: 1_000,
  heartbeatMs: 5_000,
  armyPollMs: 1_500,
  regularRecheckMs: 5 * 60_000,
  refreshBattleEvery: 20,
  maxAttacksPerMonster: 10_000,
  maxVisitPasses: 16,
  maxArmyPolls: 2_400,
  minimalHitPolls: 30,
  lowHpFraction: 0.1,
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

function readStamina(root) {
  const raw = String(root?.querySelector?.('#stamina_span')?.textContent || '').trim();
  const fraction = parseFraction(raw);
  if (fraction) return fraction.current;
  const match = raw.match(/[\d,.]+\s*[kmbtq]?/i);
  return match ? parseGameNumber(match[0].replace(/\s+/g, '')) : null;
}

function responseText(response) {
  return String(response?.json?.message || response?.json?.error || response?.text || '').trim();
}

function retryDelayFromMessage(message, fallback) {
  const milliseconds = String(message || '').match(/(?:wait|cooldown)[^\d]{0,20}(\d+)\s*ms/i);
  if (milliseconds) return Math.min(30_000, Math.max(fallback, Number(milliseconds[1])));
  const seconds = String(message || '').match(/(?:wait|cooldown)[^\d]{0,20}(\d+(?:\.\d+)?)\s*s/i);
  if (seconds) return Math.min(30_000, Math.max(fallback, Math.ceil(Number(seconds[1]) * 1_000)));
  return null;
}

function createCrucibleWorker({
  win,
  doc,
  store,
  sessionStore = null,
  fetchDocument,
  fetchJson = null,
  postForm,
  getUserId,
  asterionMultiplier = 1,
  sleepImpl = sleep,
  now = () => Date.now(),
  logger = console,
  visitRewardPage = (url, expected) => visitPvpRewardPage(win, doc, url, expected),
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
    processedPve: new Set(),
    processedPvp: new Set(),
    attacks: 0,
    targets: 0,
    armyActions: 0,
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
    return Boolean(
      tabId &&
        lease?.ownerId === tabId &&
        Number.isFinite(Number(lease?.leaseUntil)) &&
        Number(lease.leaseUntil) > t,
    );
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
    logger?.[method]?.(`[Veyra:crucible-worker] ${message}`);
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

  function assertCanMutate(visitId) {
    if (runtime.stopped) throw new VisitStop('cancelled', 'Crucible worker stopped.');
    const command = readCommand();
    if (!command || command.visitId !== visitId) {
      throw new VisitStop('cancelled', 'The Crucible scheduler visit changed.');
    }
    if (!ownsSchedulerLease()) {
      throw new VisitStop('ownership', 'Another tab owns the Crucible scheduler visit.');
    }
    if (command.phase === 'draining' || now() >= command.deadlineAt) {
      throw new VisitStop('drain', 'Crucible stopped safely at the scheduler deadline.');
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
    return normalizeConfig(store.read(CONFIG_KEY)).routes[ROUTE_ID];
  }

  function minimalArmyContribution(battleId) {
    const wanted = String(battleId || '');
    const records = store.read(MINIMAL_ARMY_CONTRIBUTIONS_KEY)?.records;
    if (!Array.isArray(records)) return null;
    return records.find((record) => String(record?.battleId || '') === wanted) || null;
  }

  function rememberMinimalArmyContribution(visitId, battleId, captainId) {
    assertCanMutate(visitId);
    const current = store.read(MINIMAL_ARMY_CONTRIBUTIONS_KEY);
    const records = Array.isArray(current?.records) ? current.records : [];
    const next = records
      .filter((record) => String(record?.battleId || '') !== String(battleId))
      .slice(-99);
    next.push({
      battleId: String(battleId),
      captainId: String(captainId),
      verifiedAt: now(),
    });
    store.write(MINIMAL_ARMY_CONTRIBUTIONS_KEY, { records: next });
  }

  async function requestJson(url) {
    if (fetchJson) return fetchJson(url);
    const response = await win.fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const raw = await response.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // The semantic parser will reject HTML/login/error pages.
    }
    return { ok: response.ok, status: response.status, text: raw, json };
  }

  async function readDashboard(visitId) {
    assertCanMutate(visitId);
    return fetchDocument(DASHBOARD_URL);
  }

  function createResourceManager(visitId, route, initialDoc) {
    let currentStamina = readStamina(initialDoc);
    let inventory = readPotionInventory(initialDoc);

    async function refresh() {
      const sourceDoc = await readDashboard(visitId);
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
      if (!result.ok) {
        throw new VisitStop('resource', `${label} could not be used: ${result.message || 'unknown response'}`);
      }
      const saved = inventory.find((candidate) => candidate.invId === entry.invId);
      if (saved) saved.quantity = Math.max(0, saved.quantity - 1);
      return result;
    }

    async function ensureStamina(required, forceRefresh = false) {
      if (forceRefresh || currentStamina === null) await refresh();
      if (currentStamina === null || currentStamina >= required) return true;
      await ensureInventory();
      if (currentStamina === null || currentStamina >= required) return true;
      const potion = pickPotion(inventory, route.potions.stamina);
      if (!potion) {
        throw new VisitStop(
          'resource',
          `Only ${currentStamina} stamina remains and no selected stamina potion is available.`,
        );
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
      if (snapshot.playerHp <= 0) throw new VisitStop('resource', 'Player HP reached zero; Crucible PvE stopped.');
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

    return { ensureHealth, ensureStamina, spendStamina };
  }

  async function fetchBattle(target, userId) {
    const battleDoc = await fetchDocument(target.url);
    return {
      doc: battleDoc,
      snapshot: dungeonLogic.parseBattleSnapshot(battleDoc, {
        userId,
        monsterId: target.monsterId,
        instanceId: target.instanceId,
        url: target.url,
      }),
    };
  }

  async function joinPveIfNeeded(visitId, target, userId, battle) {
    if (battle.snapshot.joined === true) return battle;
    if (battle.snapshot.joined !== false) {
      throw new Error(`Could not determine whether ${target.name || 'the PvE monster'} is joined.`);
    }
    const payload = dungeonLogic.buildJoinPayload({
      instanceId: target.instanceId,
      monsterId: target.monsterId,
      userId,
    });
    if (!payload) throw new Error('Could not build a safe Crucible PvE join request.');
    assertCanMutate(visitId);
    setWorkingMessage(visitId, `Joining ${target.name || 'Crucible PvE monster'}.`);
    const response = await guardedPostForm(visitId, JOIN_URL, payload);
    const joined = dungeonLogic.parseJoinResponse(response);
    if (!joined.ok) throw new Error(`Joining ${target.name || 'the monster'} failed: ${joined.message || 'unknown response'}`);
    const refreshed = await fetchBattle(target, userId);
    if (refreshed.snapshot.joined !== true) {
      throw new Error(`The battle page did not confirm that ${target.name || 'the monster'} was joined.`);
    }
    return refreshed;
  }

  function resolvePveTarget(target, snapshot) {
    return dungeonLogic.resolveDamageTarget({
      mode: target.target.mode,
      damage: target.target.damage,
      allowMaxExp: true,
      snapshot,
    });
  }

  async function attackPveMonster(visitId, route, target, userId) {
    assertCanMutate(visitId);
    let battle = await fetchBattle(target, userId);
    if (battle.snapshot.dead) return { reason: 'dead', attacks: 0 };
    battle = await joinPveIfNeeded(visitId, target, userId, battle);
    let decision = resolvePveTarget(target, battle.snapshot);
    if (!decision.ok) throw new Error(`${target.name || 'Crucible PvE target'}: ${decision.error}`);
    if (decision.done) return { reason: 'target', attacks: 0 };

    const skill = dungeonLogic.skillForId(route.settings.skill);
    const payload = dungeonLogic.buildDamagePayload({
      instanceId: target.instanceId,
      monsterId: target.monsterId,
      skillId: route.settings.skill,
    });
    if (!skill || !payload) throw new Error('The selected Crucible PvE skill is invalid.');
    const effectiveStaminaCost = staminaCost(skill.cost, asterionMultiplier);
    const resources = createResourceManager(visitId, route, battle.doc);
    let ownDamage = battle.snapshot.ownDamage;
    let attempts = 0;
    let cooldownRetries = 0;

    while (attempts < TIMING.maxAttacksPerMonster) {
      assertCanMutate(visitId);
      if (!decision.untilDead && Number.isFinite(ownDamage) && ownDamage >= decision.targetDamage) {
        return { reason: 'target', attacks: attempts };
      }
      await resources.ensureHealth(battle.snapshot);
      await resources.ensureStamina(effectiveStaminaCost);
      assertCanMutate(visitId);

      setWorkingMessage(
        visitId,
        `Attacking ${target.name || 'Crucible monster'} (${attempts + 1}${
          decision.untilDead ? ', until defeated' : `, ${Math.max(0, decision.targetDamage - ownDamage)} damage remaining`
        }).`,
      );
      const response = await guardedPostForm(visitId, DAMAGE_URL, payload, {
        onRateLimit({ waitMs }) {
          setWorkingMessage(visitId, `Crucible PvE rate limit: waiting ${Math.ceil(waitMs / 1_000)} seconds.`);
        },
      });
      const result = dungeonLogic.parseAttackResponse(response);
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
      if (result.dead) return { reason: 'dead', attacks: attempts };
      if (!decision.untilDead && Number.isFinite(ownDamage) && ownDamage >= decision.targetDamage) {
        return { reason: 'target', attacks: attempts };
      }

      if (attempts % TIMING.refreshBattleEvery === 0 || result.currentHp === null) {
        battle = await fetchBattle(target, userId);
        if (battle.snapshot.dead) return { reason: 'dead', attacks: attempts };
        decision = resolvePveTarget(target, battle.snapshot);
        if (!decision.ok) throw new Error(`${target.name || 'Crucible PvE target'}: ${decision.error}`);
        ownDamage = battle.snapshot.ownDamage;
        if (decision.done) return { reason: 'target', attacks: attempts };
      }
      await sleepImpl(route.settings.attackCooldownMs);
    }
    throw new Error(`${target.name || 'Crucible PvE target'} exceeded the per-monster attack safety limit.`);
  }

  function saveDiscoveries(discoveries) {
    const config = normalizeConfig(store.read(CONFIG_KEY));
    const merged = crucibleRoute.mergeDiscoveredMonsters(config.routes[ROUTE_ID].settings, discoveries);
    if (!merged.changed) return config.routes[ROUTE_ID].settings;
    config.routes[ROUTE_ID].settings = merged.settings;
    store.write(CONFIG_KEY, normalizeConfig(config));
    return merged.settings;
  }

  function saveShadowDiscoveries(discoveries) {
    const config = normalizeConfig(store.read(CONFIG_KEY));
    const merged = crucibleRoute.mergeDiscoveredShadows(config.routes[ROUTE_ID].settings, discoveries);
    if (!merged.changed) return config.routes[ROUTE_ID].settings;
    config.routes[ROUTE_ID].settings = merged.settings;
    store.write(CONFIG_KEY, normalizeConfig(config));
    return merged.settings;
  }

  async function processPveNode(visitId, route, cube, node, userId) {
    const definition = logic.nodeForLocationId(node.linkedLocationId);
    if (!definition) throw new Error(`${node.name || node.key} has an unknown Crucible PvE location.`);
    const enterPayload = logic.buildCubeNodeEnterPayload({
      instanceId: cube.instanceId,
      nodeId: node.id,
      faceKey: node.faceKey,
    });
    if (!enterPayload) throw new Error(`Could not build a safe ${node.name || node.key} node-entry request.`);
    setWorkingMessage(visitId, `Scanning ${definition.faceName} · ${node.name}.`);
    const enterResponse = await guardedPostForm(visitId, CUBE_ACTION_URL, enterPayload);
    const entered = logic.parseCubeNodeEnterResponse(
      enterResponse,
      { instanceId: cube.instanceId, locationId: node.linkedLocationId },
      win.location.origin,
    );
    if (!entered.ok) throw new Error(`Entering ${node.name || node.key} failed: ${entered.message || 'invalid redirect'}`);
    const locationDoc = await fetchDocument(entered.redirect);
    const monsters = dungeonLogic.parseLocationPage(locationDoc, entered.redirect);
    const discoveries = logic.discoverPveMonsters(definition, monsters);
    assertCanMutate(visitId);
    route.settings = saveDiscoveries(discoveries);
    let processed = 0;

    for (const monster of monsters) {
      assertCanMutate(visitId);
      const key = `${monster.instanceId || cube.instanceId}:${monster.monsterId}`;
      if (monster.dead || runtime.processedPve.has(key)) continue;
      const selected = crucibleRoute.settingsForMonster(route.settings, definition.id, monster.name);
      if (!selected.target?.enabled) continue;
      const target = {
        ...monster,
        instanceId: monster.instanceId || cube.instanceId,
        key,
        target: selected.target,
      };
      const result = await attackPveMonster(visitId, route, target, userId);
      runtime.processedPve.add(key);
      runtime.targets += 1;
      processed += 1;
      setWorkingMessage(
        visitId,
        `${monster.name || 'Crucible monster'} ${
          result.reason === 'dead' ? 'is defeated' : 'reached its configured damage target'
        }; checking the next target.`,
      );
    }
    return processed;
  }

  function pvpLobbyUrl(instanceId, nodeId) {
    const url = new URL('/pvp_style_node.php', win.location.origin);
    url.searchParams.set('source', 'cube');
    url.searchParams.set('instance_id', instanceId);
    url.searchParams.set('node_id', nodeId);
    return url.href;
  }

  function pvpStateUrl(instanceId, nodeId, matchNo) {
    const url = new URL(PVP_STATE_URL, win.location.origin);
    url.searchParams.set('source', 'cube');
    url.searchParams.set('since_log_id', '0');
    url.searchParams.set('instance_id', instanceId);
    url.searchParams.set('node_id', nodeId);
    url.searchParams.set('match_no', String(matchNo));
    return url.href;
  }

  function cappedRecheck(waitMs = TIMING.regularRecheckMs) {
    const delay = Number.isFinite(Number(waitMs)) && Number(waitMs) > 0
      ? Math.min(Number(waitMs), TIMING.regularRecheckMs)
      : TIMING.regularRecheckMs;
    return now() + Math.max(1_000, delay);
  }

  async function monitorPvpMatch(visitId, cube, node, matchNo) {
    // A live Crucible PvP match resolves automatically. Poll it once per
    // scheduler visit instead of occupying this worker until the match ends;
    // otherwise the independent Army and PvE sections never get a turn.
    assertCanMutate(visitId);
    const response = await requestJson(pvpStateUrl(cube.instanceId, node.id, matchNo));
    const state = logic.parsePvpState(response);
    if (!state.ok) throw new Error(`PvP match #${matchNo} state failed: ${state.error}`);
    if (state.ended) {
      let rewardCount = 0;
      if (state.won) {
        if (!state.roomJoined) {
          throw new Error(`Won PvP match #${matchNo} did not confirm this player as a participant.`);
        }
        const battleUrl = logic.buildPvpBattleUrl(win.location.origin, {
          instanceId: cube.instanceId,
          nodeId: node.id,
          matchNo,
        });
        if (!battleUrl) throw new Error(`Could not build a safe PvP reward URL for match #${matchNo}.`);
        assertCanMutate(visitId);
        setWorkingMessage(visitId, `Collecting the reward for won PvP match #${matchNo}.`);
        const rewardPage = await visitRewardPage(battleUrl, {
          instanceId: cube.instanceId,
          nodeId: node.id,
          matchNo,
        });
        assertCanMutate(visitId);
        if (!rewardPage.ok) {
          throw new Error(`The reward page for won PvP match #${matchNo} could not be verified.`);
        }
        rewardCount = rewardPage.rewardItems.length;
      }
      watchPvpLobby(store, {
        instanceId: cube.instanceId,
        nodeId: node.id,
        nodeKey: node.key,
        nodeName: node.name,
        nextCheckAt: now() + PVP_LOBBY_CHECK_MS,
      }, now());
      runtime.processedPvp.add(node.key);
      return {
        progressed: true,
        message: state.won
          ? `PvP match #${matchNo} was won and its reward page was opened automatically${rewardCount ? ` (${rewardCount} reward type(s))` : ''}.`
          : `PvP match #${matchNo} ended.`,
      };
    }
    watchPvpMatch(store, {
      instanceId: cube.instanceId,
      nodeId: node.id,
      nodeKey: node.key,
      nodeName: node.name,
      matchNo,
      nextCheckAt: now() + PVP_MATCH_CHECK_MS,
    }, now());
    const live = state.roomStatus === 'live';
    return {
      waitUntil: now() + PVP_BACKGROUND_FALLBACK_MS,
      note: live ? `${node.name} match in progress` : `${node.name} waiting for players`,
      message: live
        ? `PvP match #${matchNo} is running automatically; checking the Crucible again soon.`
        : `PvP match #${matchNo} is still open; checking the Crucible again soon.`,
    };
  }

  async function processPvpNode(visitId, cube, node) {
    const lobbyUrl = pvpLobbyUrl(cube.instanceId, node.id);
    setWorkingMessage(visitId, `Checking ${node.name} PvP slots.`);
    let lobbyDoc = await fetchDocument(lobbyUrl);
    let lobby = logic.parsePvpLobby(lobbyDoc, lobbyUrl);
    let action = logic.choosePvpAction(lobby);

    if (action.kind === 'existing') {
      return monitorPvpMatch(visitId, cube, node, action.match.matchNo);
    }
    if (action.kind === 'wait') {
      watchPvpLobby(store, {
        instanceId: cube.instanceId,
        nodeId: node.id,
        nodeKey: node.key,
        nodeName: node.name,
        nextCheckAt: now() + action.waitMs,
      }, now());
      return {
        waitUntil: now() + action.waitMs + PVP_BACKGROUND_NAVIGATION_GRACE_MS,
        note: `${node.name} binding active`,
        message: `${node.name} is bound for ${Math.ceil(action.waitMs / 1_000)} more seconds; checking node progress regularly.`,
      };
    }
    if (action.kind === 'unavailable') {
      watchPvpLobby(store, {
        instanceId: cube.instanceId,
        nodeId: node.id,
        nodeKey: node.key,
        nodeName: node.name,
        nextCheckAt: now() + PVP_LOBBY_CHECK_MS,
      }, now());
      return {
        waitUntil: now() + PVP_BACKGROUND_FALLBACK_MS,
        note: `${node.name} has no free slot`,
        message: `${node.name} has no open slot; checking again soon.`,
      };
    }

    const payload = logic.buildPvpClaimPayload({
      instanceId: cube.instanceId,
      nodeId: node.id,
      matchNo: action.match.matchNo,
      slotIndex: action.slotIndex,
    });
    if (!payload) throw new Error(`Could not build a safe ${node.name} slot request.`);
    assertCanMutate(visitId);
    setWorkingMessage(visitId, `Claiming slot ${action.slotIndex} in ${node.name} match #${action.match.matchNo}.`);
    const response = await guardedPostForm(visitId, PVP_ACTION_URL, payload);
    const claimed = logic.parsePvpClaimResponse(response);
    if (!claimed.ok) throw new Error(`Claiming the PvP slot failed: ${claimed.message || 'unknown response'}`);

    // Require the lobby to confirm our slot before waiting on the match.
    lobbyDoc = await fetchDocument(lobbyUrl);
    lobby = logic.parsePvpLobby(lobbyDoc, lobbyUrl);
    action = logic.choosePvpAction(lobby);
    if (action.kind !== 'existing' || action.match.matchNo !== Number(payload.match_no)) {
      throw new Error('The PvP lobby did not confirm the claimed slot.');
    }
    return monitorPvpMatch(visitId, cube, node, action.match.matchNo);
  }

  async function healArmyIfAvailable(visitId, route) {
    assertCanMutate(visitId);
    const armyDoc = await fetchDocument(SHADOW_ARMY_URL);
    const shadows = logic.parseOwnedArmyShadows(armyDoc);
    if (shadows.length > 0) {
      assertCanMutate(visitId);
      route.settings = saveShadowDiscoveries(shadows);
    }
    const availability = logic.parseArmyHealAvailability(armyDoc);
    // The game omits the heal form completely when no owned unit is ready to
    // heal. A parsed special-unit list proves that this is the real Army page.
    if (!availability.found) {
      if (shadows.length > 0) return false;
      throw new Error('The Shadow Army heal-all control and owned Shadows could not be found.');
    }
    if (!availability.available) return false;
    setWorkingMessage(visitId, 'Healing all ready Shadow Army units before joining.');
    assertCanMutate(visitId);
    const response = await guardedPostForm(visitId, SHADOW_ARMY_URL, { action: 'heal_all_units' });
    if (!response?.ok) {
      throw new Error(`Healing the Shadow Army failed: ${responseText(response) || `HTTP ${response?.status || '?'}`}`);
    }
    const verifiedDoc = await fetchDocument(SHADOW_ARMY_URL);
    const verified = logic.parseArmyHealAvailability(verifiedDoc);
    const verifiedShadows = logic.parseOwnedArmyShadows(verifiedDoc);
    if (verified.available || (!verified.found && verifiedShadows.length === 0)) {
      throw new Error('The Shadow Army page did not confirm that ready units were healed.');
    }
    return true;
  }

  async function ensureArmyFormation(visitId, route) {
    const selectedIds = (route.settings.army.selectedShadowIds || []).map(String);
    const selected = new Set(selectedIds);
    const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
    if (selected.size === 0) throw new Error('Select at least one Shadow for the Crucible Army formation.');

    assertCanMutate(visitId);
    let formation = logic.parseArmyFormationPage(await fetchDocument(SHADOW_ARMY_FORMATION_URL));
    if (!formation.found) throw new Error('The saved Shadow Army formation could not be read safely.');

    const discoveries = formation.captains.map((captain) => ({ id: captain.shadowId, name: captain.name }));
    if (discoveries.length > 0) {
      assertCanMutate(visitId);
      route.settings = saveShadowDiscoveries(discoveries);
    }

    const selectedReady = () => formation.captains.some(
      (captain) => captain.inFormation && !captain.dead && selected.has(captain.shadowId),
    );
    if (selectedReady()) return formation;
    if (formation.locked) {
      throw new Error(formation.lockedMessage || 'The Shadow Army formation is locked by an active battle roster.');
    }

    const activeCount = formation.captains.filter((captain) => captain.inFormation).length;
    const freeSlots = Math.max(0, formation.captainLimit - activeCount);
    const candidates = formation.captains
      .filter((captain) => selected.has(captain.shadowId) && !captain.inFormation && !captain.dead)
      .sort((left, right) => selectedOrder.get(left.shadowId) - selectedOrder.get(right.shadowId));
    if (freeSlots === 0) {
      throw new Error('None of the selected Shadows is in the saved formation, and all captain slots are occupied.');
    }
    if (candidates.length === 0) {
      throw new Error('No selected, living Shadow is available for the saved Army formation.');
    }

    for (const captain of candidates.slice(0, freeSlots)) {
      const payload = logic.buildArmyFormationPayload('set_captain', { inventoryId: captain.inventoryId });
      if (!payload) throw new Error(`Could not build a safe formation request for ${captain.name}.`);
      assertCanMutate(visitId);
      setWorkingMessage(visitId, `Adding ${captain.name} to the saved Shadow Army formation.`);
      const response = await guardedPostForm(visitId, SHADOW_ARMY_FORMATION_URL, payload);
      const result = logic.parseArmyFormationActionResponse(response);
      if (!result.ok) {
        throw new Error(`Adding ${captain.name} to the Army formation failed: ${result.message || 'unknown response'}`);
      }
    }

    assertCanMutate(visitId);
    formation = logic.parseArmyFormationPage(await fetchDocument(SHADOW_ARMY_FORMATION_URL));
    if (!formation.found || !selectedReady()) {
      throw new Error('The Shadow Army formation page did not confirm an available selected captain.');
    }
    return formation;
  }

  async function armyStateAction(visitId, action, fields) {
    const payload = logic.buildArmyLivePayload(action, fields);
    if (!payload) throw new Error(`Could not build a safe Army ${action} request.`);
    assertCanMutate(visitId);
    const response = await guardedPostForm(visitId, ARMY_LIVE_URL, payload);
    const result = logic.parseArmyActionResponse(response);
    if (!result.ok) {
      throw new Error(`Army ${action} failed: ${result.message || `HTTP ${response?.status || '?'}`}`);
    }
    runtime.armyActions += action === 'get_state' ? 0 : 1;
    return result.state;
  }

  async function joinArmyIfNeeded(visitId, battleId, state) {
    let summary = logic.armySummary(state);
    if (summary.own.length > 0) return state;
    if (summary.viewer.can_join !== true && summary.viewer.has_roster === false) {
      // The initial live-page state can have been rendered before a freshly
      // saved formation became visible to the battle. Refresh once before
      // treating the server's roster flag as final.
      state = await armyStateAction(visitId, 'get_state', { battleId });
      summary = logic.armySummary(state);
      if (summary.own.length > 0) return state;
    }
    if (summary.viewer.can_join !== true) {
      // A captain that already retreated may no longer be present in the
      // captain array while the player remains committed to this fight. That
      // is a waiting state, not evidence that a second join is safe.
      return null;
    }
    // The live page itself exposes the Join button from can_join alone. Some
    // real battle states report has_roster=false and can_join=true together;
    // in that state the server still expects a join_battle request.
    setWorkingMessage(visitId, 'Joining the live fight with the saved Shadow Army formation.');
    state = await armyStateAction(visitId, 'join_battle', { battleId });
    summary = logic.armySummary(state);
    if (summary.own.length === 0) throw new Error('The Army battle did not confirm our formation after joining.');
    return state;
  }

  async function applySelectedArmyFormation(visitId, battleId, state, selectedShadowIds) {
    const selected = new Set((selectedShadowIds || []).map(String));
    if (selected.size === 0) throw new Error('Select at least one Shadow for the Crucible Army formation.');
    let summary = logic.armySummary(state);
    const selectedOwn = summary.own.filter((captain) => selected.has(String(captain.source_shadow_id ?? '')));
    if (summary.own.length > 0 && selectedOwn.length === 0) {
      throw new Error('None of the selected Shadows is present in the saved game formation.');
    }
    for (const captain of summary.livingOwn) {
      if (selected.has(String(captain.source_shadow_id ?? ''))) continue;
      setWorkingMessage(visitId, `Retreating unselected Shadow ${captain.display_name || captain.id}.`);
      state = await armyStateAction(visitId, 'retreat_captain', {
        battleId,
        captainId: captain.id,
      });
      summary = logic.armySummary(state);
      if (!summary.active) break;
    }
    return state;
  }

  async function runMinimalArmy(visitId, node, battleId, initialState, selectedShadowIds) {
    let state = initialState;
    const previous = minimalArmyContribution(battleId);
    if (previous) {
      const summary = logic.armySummary(state);
      const captain = summary.own.find((candidate) => Number(candidate?.id) === Number(previous.captainId));
      if (summary.active && captain && !captain.is_dead && captain.retreat_requested !== true) {
        setWorkingMessage(visitId, `Finishing the verified minimal-contribution retreat in ${node.name}.`);
        state = await armyStateAction(visitId, 'retreat_captain', {
          battleId,
          captainId: previous.captainId,
        });
      }
      return {
        waitUntil: cappedRecheck(),
        note: `${node.name} contribution complete`,
        message: `${node.name} already has a verified personal contribution; checking for the next fight soon.`,
      };
    }
    const plan = logic.planArmyActions(state, 'minimal', selectedShadowIds);
    if (plan.error) throw new Error(plan.error);
    if (plan.done) return { progressed: plan.reason === 'ended', message: `${node.name} Army fight ${plan.reason}.` };
    const command = plan.commands.find((candidate) => candidate.action === 'assign');
    if (!command) {
      return {
        waitUntil: cappedRecheck(),
        note: `${node.name} Army fight active`,
        message: `${node.name} has no free personal captain to assign yet.`,
      };
    }

    const before = state;
    setWorkingMessage(visitId, `Assigning one captain in ${node.name} for the minimal contribution.`);
    state = await armyStateAction(visitId, 'assign_target', {
      battleId,
      attackerId: command.attackerId,
      defenderId: command.defenderId,
    });
    let verified = logic.hasVerifiedArmyHit(before, state, command.attackerId, command.defenderId);
    for (let poll = 0; !verified && poll < TIMING.minimalHitPolls; poll += 1) {
      assertCanMutate(visitId);
      if (!logic.armySummary(state).active) break;
      await sleepImpl(TIMING.armyPollMs);
      state = await armyStateAction(visitId, 'get_state', { battleId });
      verified = logic.hasVerifiedArmyHit(before, state, command.attackerId, command.defenderId);
    }

    const stillActive = logic.armySummary(state).active;
    if (!verified) {
      if (!stillActive) {
        return {
          progressed: true,
          message: `${node.name} ended before a personal hit could be verified.`,
        };
      }
      throw new Error(`${node.name} did not show a verifiable personal hit; the captain remains assigned.`);
    }
    rememberMinimalArmyContribution(visitId, battleId, command.attackerId);
    if (stillActive) {
      setWorkingMessage(visitId, `Retreating the minimal-contribution captain from ${node.name}.`);
      state = await armyStateAction(visitId, 'retreat_captain', {
        battleId,
        captainId: command.attackerId,
      });
    }
    return {
      waitUntil: cappedRecheck(),
      note: `${node.name} contribution complete`,
      message: `${node.name} received the minimal contribution; checking for the next fight soon.`,
    };
  }

  async function runKillArmy(visitId, node, battleId, initialState, selectedShadowIds) {
    let state = initialState;
    for (let poll = 0; poll < TIMING.maxArmyPolls; poll += 1) {
      assertCanMutate(visitId);
      const plan = logic.planArmyActions(state, 'kill', selectedShadowIds);
      if (plan.error) throw new Error(plan.error);
      if (plan.done) {
        if (plan.reason === 'ended') {
          return { progressed: true, message: `${node.name} Army fight ended.` };
        }
        return {
          waitUntil: cappedRecheck(),
          note: `${node.name} formation defeated`,
          message: `All personal captains in ${node.name} are down; checking healing and fight state soon.`,
        };
      }

      const assignments = plan.commands.filter((command) => command.action === 'assign');
      if (assignments.length > 0) {
        for (const command of assignments) {
          assertCanMutate(visitId);
          if (!logic.armySummary(state).active) break;
          setWorkingMessage(
            visitId,
            `Assigning captain ${command.attackerId} to enemy ${command.defenderId} in ${node.name}.`,
          );
          state = await armyStateAction(visitId, 'assign_target', {
            battleId,
            attackerId: command.attackerId,
            defenderId: command.defenderId,
          });
        }
      } else {
        setWorkingMessage(visitId, `Waiting for the active ${node.name} Army engagements.`);
      }
      await sleepImpl(TIMING.armyPollMs);
      state = await armyStateAction(visitId, 'get_state', { battleId });
    }
    throw new Error(`${node.name} exceeded the Army battle polling safety limit.`);
  }

  async function processArmyNode(visitId, route, cube, node) {
    const pageUrl = new URL('/guild_dungeon_cube_army_enter.php', win.location.origin);
    pageUrl.searchParams.set('instance_id', cube.instanceId);
    pageUrl.searchParams.set('node_id', node.id);
    setWorkingMessage(visitId, `Checking Army fights in ${node.name}.`);
    const pageDoc = await fetchDocument(pageUrl.href);
    const page = logic.parseArmyNodePage(pageDoc);
    const fight = logic.chooseArmyFight(page);
    if (!fight) return { progressed: false, message: `${node.name} has no actionable Army fight.` };

    await healArmyIfAvailable(visitId, route);
    await ensureArmyFormation(visitId, route);
    const payload = logic.buildArmyEnterPayload({
      instanceId: cube.instanceId,
      nodeId: node.id,
      matchNo: fight.matchNo,
    });
    if (!payload) throw new Error(`Could not build a safe ${node.name} Army entry request.`);
    assertCanMutate(visitId);
    setWorkingMessage(visitId, `Entering ${node.name} Army fight #${fight.matchNo}.`);
    const response = await guardedPostForm(visitId, ARMY_ACTION_URL, payload);
    const entered = logic.parseArmyEnterResponse(response, win.location.origin);
    if (!entered.ok) throw new Error(`Entering the Army fight failed: ${entered.message || 'invalid redirect'}`);
    const liveDoc = await fetchDocument(entered.redirect);
    const live = logic.parseArmyLivePage(liveDoc);
    if (!live.battleId || !live.state) throw new Error('The live Army battle state could not be read safely.');
    if (!logic.armySummary(live.state).active) {
      return { progressed: true, message: `${node.name} Army fight already ended.` };
    }
    if (route.settings.army.mode === 'minimal' && minimalArmyContribution(live.battleId)) {
      return runMinimalArmy(
        visitId,
        node,
        live.battleId,
        live.state,
        route.settings.army.selectedShadowIds,
      );
    }
    let state = await joinArmyIfNeeded(visitId, live.battleId, live.state);
    if (!state) {
      return {
        waitUntil: cappedRecheck(),
        note: `${node.name} Army commitment active`,
        message: `${node.name} is active but the formation cannot safely join again; checking its state soon.`,
      };
    }
    state = await applySelectedArmyFormation(
      visitId,
      live.battleId,
      state,
      route.settings.army.selectedShadowIds,
    );
    if (route.settings.army.mode === 'minimal') {
      return runMinimalArmy(visitId, node, live.battleId, state, route.settings.army.selectedShadowIds);
    }
    return runKillArmy(visitId, node, live.battleId, state, route.settings.army.selectedShadowIds);
  }

  async function loadCube(visitId, url) {
    assertCanMutate(visitId);
    const cubeDoc = await fetchDocument(url);
    const cube = logic.parseCubePage(cubeDoc, url);
    if (!/^\d+$/.test(cube.instanceId)) throw new Error('The Crucible instance id could not be read.');
    if (cube.nodes.length === 0) throw new Error('The Crucible STATE nodes could not be read.');
    return cube;
  }

  function waitResult(results) {
    const waits = results.filter((result) => Number(result?.waitUntil) > now());
    if (waits.length === 0) return null;
    waits.sort((left, right) => left.waitUntil - right.waitUntil);
    return waits[0];
  }

  async function executeVisit(command) {
    const visitId = command.visitId;
    let route = routeConfig();
    if (!route.settings.pveEnabled && !route.settings.pvp.enabled && !route.settings.army.enabled) {
      setTerminal(visitId, 'done', 'Crucible has no enabled automation section.');
      return;
    }

    setWorkingMessage(visitId, 'Looking for the active Polyhedral Crucible instance.');
    const entry = logic.parseHubEntry(doc, currentUrl()?.href);
    if (!entry) throw new Error('The Polyhedral Crucible entry was not found on the guild-dungeon page.');
    let cubeUrl = entry.url;
    let userId = '';
    const failedSections = new Set();
    const sectionErrors = [];

    async function runSection(section, operation) {
      if (failedSections.has(section)) return null;
      try {
        return await operation();
      } catch (error) {
        // Lease loss, cancellation, scheduler drain and resource stops apply
        // to the whole visit and must retain their existing semantics.
        if (error instanceof VisitStop) throw error;
        failedSections.add(section);
        const message = String(error?.message || error || 'unknown error');
        sectionErrors.push(`${section}: ${message}`);
        log(`${section} section failed independently: ${message}`, 'warn');
        return null;
      }
    }

    for (let pass = 0; pass < TIMING.maxVisitPasses; pass += 1) {
      assertCanMutate(visitId);
      const cube = await loadCube(visitId, cubeUrl);
      cubeUrl = new URL(`/guild_dungeon_cube.php?instance_id=${encodeURIComponent(cube.instanceId)}`, win.location.origin).href;
      route = routeConfig();
      let progressed = false;
      const waiting = [];

      // Reserve or confirm the time-sensitive PvP slot before starting Army or
      // potentially long PvE work. Each section fails independently so a
      // changed page in one mode cannot suppress participation in the others.
      if (route.settings.pvp.enabled) {
        await runSection('PvP', async () => {
          for (const node of logic.actionableNodes(cube, 'pvp')) {
            if (runtime.processedPvp.has(node.key)) continue;
            const result = await processPvpNode(visitId, cube, node);
            if (result.progressed) {
              progressed = true;
              break;
            }
            if (result.waitUntil) waiting.push(result);
          }
        });
      }

      if (route.settings.army.enabled) {
        await runSection('Army', async () => {
          for (const node of logic.actionableNodes(cube, 'army')) {
            const result = await processArmyNode(visitId, route, cube, node);
            if (result.progressed) {
              progressed = true;
              break;
            }
            if (result.waitUntil) waiting.push(result);
          }
        });
      }

      if (route.settings.pveEnabled) {
        await runSection('PvE', async () => {
          const pveNodes = [
            ...logic.actionableNodes(cube, 'pve'),
            ...logic.actionableNodes(cube, 'boss'),
          ];
          if (pveNodes.length > 0 && !userId) {
            userId = String(await getUserId() || '');
            if (!userId) throw new Error('The player id could not be determined for Crucible PvE.');
          }
          for (const node of pveNodes) {
            const count = await processPveNode(visitId, route, cube, node, userId);
            progressed = count > 0 || progressed;
          }
        });
      }

      if (progressed) continue;

      if (sectionErrors.length > 0) {
        throw new Error(sectionErrors.join(' | '));
      }

      const next = waitResult(waiting);
      if (next) {
        setTerminal(
          visitId,
          'done',
          `${next.message} Completed ${runtime.targets} PvE target(s), ${runtime.attacks} PvE attack(s) and ${runtime.armyActions} Army action(s).`,
          { retryAt: next.waitUntil, note: next.note },
        );
        return;
      }

      setTerminal(
        visitId,
        'done',
        `Crucible pass finished ${runtime.targets} PvE target(s), ${runtime.attacks} PvE attack(s) and ${runtime.armyActions} Army action(s).`,
      );
      return;
    }
    if (sectionErrors.length > 0) throw new Error(sectionErrors.join(' | '));
    throw new Error('Crucible did not settle after repeated node-state rescans.');
  }

  async function tick() {
    if (runtime.stopped || runtime.ticking || !isMarkedHub()) return;
    const command = readCommand();
    if (!command) {
      if (!runtime.runningVisitId) publish('idle', true, 'Crucible is idle on the dungeon page.');
      return;
    }
    if (!ownsSchedulerLease()) return;
    if (runtime.terminal?.visitId === command.visitId) {
      publish(runtime.terminal.state, true, runtime.terminal.message, command.visitId, runtime.terminal);
      return;
    }
    if (command.phase === 'draining' || now() >= command.deadlineAt) {
      setTerminal(command.visitId, 'done', 'Crucible stopped safely before starting another action.');
      return;
    }

    runtime.ticking = true;
    runtime.runningVisitId = command.visitId;
    runtime.terminal = null;
    runtime.processedPve = new Set();
    runtime.processedPvp = new Set();
    runtime.attacks = 0;
    runtime.targets = 0;
    runtime.armyActions = 0;
    try {
      await executeVisit(command);
    } catch (error) {
      if (error instanceof VisitStop) {
        if (error.kind === 'ownership' || error.kind === 'cancelled') return;
        setTerminal(command.visitId, 'done', error.message, { retryAt: error.retryAt, note: error.note });
      } else {
        const detail = String(error?.message || error || 'unknown error');
        setTerminal(command.visitId, 'error', `Crucible failed safely: ${detail}`, {
          retryAt: cappedRecheck(),
          note: `Error: ${detail}`.slice(0, 60),
        });
      }
    } finally {
      runtime.ticking = false;
      if (!runtime.terminal) runtime.runningVisitId = '';
    }
  }

  function heartbeat() {
    if (!runtime.runningVisitId || runtime.terminal || !ownsSchedulerLease()) return;
    publish('working', false, runtime.message || 'Crucible is working.', runtime.runningVisitId, { force: true });
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

const crucibleWorkerFeature = Object.freeze({
  id: 'crucible-worker',
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
    const worker = createCrucibleWorker({
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
  ARMY_ACTION_URL,
  ARMY_LIVE_URL,
  CUBE_ACTION_URL,
  DAMAGE_URL,
  DASHBOARD_URL,
  JOIN_URL,
  MINIMAL_ARMY_CONTRIBUTIONS_KEY,
  PVP_ACTION_URL,
  PVP_STATE_URL,
  ROUTE_ID,
  SHADOW_ARMY_URL,
  SHADOW_ARMY_FORMATION_URL,
  TIMING,
  VisitStop,
  createCrucibleWorker,
  crucibleWorkerFeature,
  readStamina,
};
