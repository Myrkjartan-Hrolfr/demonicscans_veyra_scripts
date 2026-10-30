'use strict';

// Pure parsing and planning helpers for the Polyhedral Crucible. Keeping all
// page-specific assumptions here lets the scheduler worker fail closed when a
// game layout or API response changes.

const { parseClockDuration } = require('../../core/time');
const crucibleRoute = require('../../routes/crucible');
const dungeonLogic = require('./shadowbridge-logic');

const CRUCIBLE_NAME = 'The Polyhedral Crucible';
const ACTIONABLE_STATUSES = new Set(['available', 'in_progress']);
const NODE_TYPE_ORDER = Object.freeze({ pve: 0, army: 1, pvp: 2 });

function text(element) {
  return String(element?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function all(root, selector) {
  try {
    return Array.from(root?.querySelectorAll?.(selector) || []);
  } catch {
    return [];
  }
}

function firstAll(root, selectors) {
  for (const selector of selectors) {
    const result = all(root, selector);
    if (result.length > 0) return result;
  }
  return [];
}

function attr(element, name) {
  try {
    return element?.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function resolveUrl(href, baseUrl = 'https://demonicscans.org/') {
  const value = String(href || '').trim();
  if (!value || /^javascript:/i.test(value)) return null;
  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}

function normalized(value) {
  return dungeonLogic.normalizeMonsterName(value);
}

function namedDungeonCard(link, wantedName) {
  let candidate = link?.parentElement || null;
  for (let depth = 0; candidate && depth < 10; depth += 1) {
    const enterLinks = all(candidate, 'a[href*="guild_dungeon_enter.php"]');
    // The live page uses unclassed, inline-styled cards. The surrounding
    // `.panel` contains every open dungeon, so accept only the smallest named
    // ancestor that contains at most this one Enter link.
    if (normalized(text(candidate)).includes(wantedName) && enterLinks.length <= 1) return candidate;
    candidate = candidate.parentElement || null;
  }
  return null;
}

function parseHubEntry(doc, baseUrl = 'https://demonicscans.org/guild_dungeon.php') {
  const wanted = normalized(CRUCIBLE_NAME);
  for (const link of all(doc, 'a[href*="guild_dungeon_enter.php"]')) {
    const card = namedDungeonCard(link, wanted);
    if (!card) continue;
    const url = resolveUrl(attr(link, 'href'), baseUrl);
    const instanceId = url?.searchParams.get('id') || url?.searchParams.get('instance_id') || '';
    if (url && /^\d+$/.test(instanceId)) return { instanceId, url: url.href };
  }
  return null;
}

function scriptTexts(doc) {
  return all(doc, 'script').map((script) => String(script?.textContent ?? script?.innerHTML ?? ''));
}

function assignmentStart(source, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(name || ''))) return -1;
  const pattern = new RegExp(
    `(?:\\b(?:const|let|var)\\s+|\\bwindow\\s*\\.\\s*)${name}\\s*=\\s*`,
    'g',
  );
  const match = pattern.exec(source);
  return match ? pattern.lastIndex : -1;
}

function balancedJsonSlice(source, start) {
  let index = start;
  while (/\s/.test(source[index] || '')) index += 1;
  const opening = source[index];
  if (opening !== '{' && opening !== '[') return '';
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(index, cursor + 1);
    }
  }
  return '';
}

function quoteBareObjectKeys(source) {
  let result = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (quote) {
      result += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (/[\w$]/.test(source[end] || '')) end += 1;
      let next = end;
      while (/\s/.test(source[next] || '')) next += 1;
      let previous = index - 1;
      while (/\s/.test(source[previous] || '')) previous -= 1;
      const identifier = source.slice(index, end);
      if (source[next] === ':' && (source[previous] === '{' || source[previous] === ',')) {
        result += `"${identifier}"`;
      } else {
        result += identifier;
      }
      index = end;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function parseObjectLiteral(slice) {
  try {
    return JSON.parse(slice);
  } catch {
    // PHP-rendered page data uses a JSON-compatible JavaScript object literal
    // with bare property names. Quote only keys found outside string values;
    // never execute the page source.
    return JSON.parse(quoteBareObjectKeys(slice));
  }
}

function extractAssignedJson(doc, name) {
  for (const source of scriptTexts(doc)) {
    const start = assignmentStart(source, name);
    if (start < 0) continue;
    const slice = balancedJsonSlice(source, start);
    if (!slice) continue;
    try {
      const value = parseObjectLiteral(slice);
      if (value && typeof value === 'object') return value;
    } catch {
      // A malformed or non-JSON assignment is not safe to execute or coerce.
    }
  }
  return null;
}

function extractAssignedNumber(doc, name) {
  for (const source of scriptTexts(doc)) {
    const start = assignmentStart(source, name);
    if (start < 0) continue;
    const match = source.slice(start).match(/^\s*(\d+)/);
    if (match) return match[1];
  }
  return '';
}

function extractAssignedTokenString(doc, name) {
  for (const source of scriptTexts(doc)) {
    const start = assignmentStart(source, name);
    if (start < 0) continue;
    const match = source.slice(start).match(/^\s*(["'])([A-Za-z0-9_-]+)\1/);
    if (match) return match[2];
  }
  return '';
}

function normalizeNode(raw) {
  const id = String(raw?.id ?? '').trim();
  const key = String(raw?.key || '').trim();
  const type = String(raw?.type || '').trim().toLowerCase();
  const status = String(raw?.status || '').trim().toLowerCase();
  if (!/^\d+$/.test(id) || !key || !type || !status) return null;
  return {
    id,
    key,
    name: String(raw?.name || key).trim(),
    faceKey: String(raw?.face_key || '').trim().toLowerCase(),
    type,
    status,
    linkedLocationId: String(raw?.linked_location_id || '').trim(),
    stateMeta: raw?.state_meta && typeof raw.state_meta === 'object' ? raw.state_meta : {},
  };
}

function parseCubePage(doc, pageUrl = '') {
  const page = resolveUrl(pageUrl);
  const state = extractAssignedJson(doc, 'STATE');
  const instanceId =
    extractAssignedNumber(doc, 'INSTANCE_ID') ||
    page?.searchParams.get('instance_id') ||
    page?.searchParams.get('id') ||
    '';
  const nodes = Array.isArray(state?.nodes) ? state.nodes.map(normalizeNode).filter(Boolean) : [];
  return { instanceId, nodes, state };
}

function actionableNodes(cube, type = '') {
  const wantedType = String(type || '').toLowerCase();
  return (cube?.nodes || [])
    .filter((node) => ACTIONABLE_STATUSES.has(node.status) && (!wantedType || node.type === wantedType))
    .sort((left, right) => {
      const leftType = NODE_TYPE_ORDER[left.type] ?? 99;
      const rightType = NODE_TYPE_ORDER[right.type] ?? 99;
      return leftType - rightType || Number(left.id) - Number(right.id);
    });
}

function nodeForLocationId(locationId) {
  const value = String(locationId || '');
  return crucibleRoute.CRUCIBLE_PVE_NODES.find((node) => node.locationId === value) || null;
}

function discoverPveMonsters(node, monsters) {
  if (!node || !Array.isArray(monsters)) return [];
  const discoveries = [];
  const seen = new Set();
  for (const monster of monsters) {
    const name = String(monster?.name || '').replace(/\s+/g, ' ').trim();
    const id = crucibleRoute.targetIdForMonster(node.id, name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    discoveries.push({ id, nodeId: node.id, name });
  }
  return discoveries;
}

function parsePvpLobby(doc, pageUrl = '') {
  const warning = text(doc?.querySelector?.('.warn'));
  const waitMs = parseClockDuration(warning);
  const matches = [];
  for (const card of firstAll(doc, ['.grid > .match', '.match'])) {
    const meta = text(card.querySelector?.('.meta'));
    const match = meta.match(/Match\s*#\s*(\d+)\s*\/\s*Slots\s*(\d+)\s*\/\s*(\d+)/i);
    if (!match) continue;
    const slots = firstAll(card, ['.slots .slot', '.slot']).map((slot, index) => {
      const name = text(slot.querySelector?.('.name'));
      const own = /your slot/i.test(text(slot.querySelector?.('.selfMark')));
      return { index: index + 1, occupied: Boolean(name), own, name };
    });
    const badges = all(card, '.badge').map((badge) => normalized(text(badge)).replace(/\s+/g, '-'));
    const status = badges.find((badge) => ['open', 'live', 'cleared', 'lost'].includes(badge)) || '';
    const link = card.querySelector?.('a[href*="pvp_style_battle.php"]');
    const url = resolveUrl(attr(link, 'href'), pageUrl);
    matches.push({
      matchNo: Number(match[1]),
      occupied: Number(match[2]),
      capacity: Number(match[3]),
      status,
      slots,
      ownSlot: slots.find((slot) => slot.own) || null,
      url: url?.href || '',
    });
  }
  return { warning, waitMs, matches };
}

function choosePvpAction(lobby) {
  const matches = Array.isArray(lobby?.matches) ? lobby.matches : [];
  const existing = matches.find((match) => match.ownSlot && ['open', 'live', 'cleared'].includes(match.status));
  if (existing) return { kind: 'existing', match: existing };
  if (Number.isFinite(lobby?.waitMs) && lobby.waitMs > 0) {
    return { kind: 'wait', waitMs: lobby.waitMs, warning: lobby.warning || '' };
  }
  const open = matches
    .filter((match) => match.status === 'open' && match.occupied < match.capacity && match.slots.some((slot) => !slot.occupied))
    .sort((left, right) => right.occupied - left.occupied || left.matchNo - right.matchNo)[0];
  if (!open) return { kind: 'unavailable' };
  return {
    kind: 'claim',
    match: open,
    slotIndex: open.slots.find((slot) => !slot.occupied)?.index || 0,
  };
}

function cleanInteger(value) {
  const result = String(value ?? '').trim();
  return /^\d+$/.test(result) && Number(result) > 0 ? result : '';
}

function buildPvpClaimPayload({ instanceId, nodeId, matchNo, slotIndex } = {}) {
  const instance = cleanInteger(instanceId);
  const node = cleanInteger(nodeId);
  const match = cleanInteger(matchNo);
  const slot = cleanInteger(slotIndex);
  if (!instance || !node || !match || !slot || Number(slot) > 5) return null;
  return {
    source: 'cube',
    action: 'pick_slot',
    instance_id: instance,
    node_id: node,
    match_no: match,
    slot_index: slot,
  };
}

function buildPvpBattleUrl(baseUrl, { instanceId, nodeId, matchNo } = {}) {
  const instance = cleanInteger(instanceId);
  const node = cleanInteger(nodeId);
  const match = cleanInteger(matchNo);
  const base = resolveUrl(baseUrl);
  if (!base || !instance || !node || !match) return '';
  const url = new URL('/pvp_style_battle.php', base);
  url.searchParams.set('source', 'cube');
  url.searchParams.set('instance_id', instance);
  url.searchParams.set('node_id', node);
  url.searchParams.set('match_no', match);
  return url.href;
}

function buildCubeNodeEnterPayload({ instanceId, nodeId, faceKey } = {}) {
  const instance = cleanInteger(instanceId);
  const node = cleanInteger(nodeId);
  const face = String(faceKey || '').trim().toLowerCase();
  if (!instance || !node || !/^[a-z_]+$/.test(face)) return null;
  return { action: 'enter_node', instance_id: instance, node_id: node, face_key: face };
}

function wrappedJson(response) {
  if (response && Object.prototype.hasOwnProperty.call(response, 'json')) {
    return response.json && typeof response.json === 'object' ? response.json : null;
  }
  if (response && typeof response === 'object') return response;
  return null;
}

function responseMessage(response) {
  const json = wrappedJson(response);
  return String(json?.message || json?.error || response?.text || '').trim();
}

function parsePvpClaimResponse(response) {
  const json = wrappedJson(response);
  const declared = json?.ok === true || json?.success === true || /success|claimed|joined/i.test(responseMessage(response));
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  return { ok: Boolean(transportOk && declared), message: responseMessage(response) };
}

function parseCubeNodeEnterResponse(response, expected = {}, baseUrl = 'https://demonicscans.org/') {
  const json = wrappedJson(response);
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  const base = resolveUrl(baseUrl);
  const redirect = resolveUrl(json?.redirect, baseUrl);
  const instanceId = redirect?.searchParams.get('instance_id') || '';
  const locationId = redirect?.searchParams.get('location_id') || '';
  const ok = Boolean(
    transportOk &&
      json?.ok === true &&
      base &&
      redirect &&
      redirect.origin === base.origin &&
      /\/guild_dungeon_location\.php\/?$/i.test(redirect.pathname) &&
      instanceId === String(expected.instanceId || '') &&
      locationId === String(expected.locationId || ''),
  );
  return { ok, redirect: ok ? redirect.href : '', message: responseMessage(response) };
}

function parsePvpState(response) {
  const json = wrappedJson(response);
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  if (!transportOk || !json || json.ok !== true) {
    return { ok: false, error: responseMessage(response) || 'PvP state response was invalid.' };
  }
  const roomStatus = String(json.room_status || '').toLowerCase();
  const ended = json.match?.ended === true || ['cleared', 'lost'].includes(roomStatus);
  const winnerSide = String(json.match?.winner_side || '').toLowerCase();
  return {
    ok: true,
    ended,
    won: ended && (winnerSide === 'ally' || roomStatus === 'cleared'),
    roomStatus,
    winnerSide,
    roomJoined: json.room_joined === true,
    raw: json,
  };
}

function parsePvpBattlePage(doc, expected = {}) {
  const params = extractAssignedJson(doc, 'SOURCE_PARAMS');
  const rewardItems = extractAssignedJson(doc, 'PVP_REWARD_ITEMS');
  const roomStatus = extractAssignedTokenString(doc, 'ROOM_STATUS').toLowerCase();
  const instanceId = cleanInteger(params?.instance_id);
  const nodeId = cleanInteger(params?.node_id);
  const matchNo = cleanInteger(params?.match_no);
  const expectedInstance = cleanInteger(expected.instanceId);
  const expectedNode = cleanInteger(expected.nodeId);
  const expectedMatch = cleanInteger(expected.matchNo);
  const ok = Boolean(
    expectedInstance &&
      expectedNode &&
      expectedMatch &&
      instanceId === expectedInstance &&
      nodeId === expectedNode &&
      matchNo === expectedMatch &&
      roomStatus === 'cleared' &&
      Array.isArray(rewardItems),
  );
  return {
    ok,
    instanceId,
    nodeId,
    matchNo,
    roomStatus,
    rewardItems: Array.isArray(rewardItems) ? rewardItems : [],
  };
}

function normalizeFight(raw) {
  const matchNo = Number(raw?.match_no);
  if (!Number.isInteger(matchNo) || matchNo <= 0) return null;
  return {
    matchNo,
    battleId: Number(raw?.battle_id) || 0,
    status: String(raw?.status || 'open').toLowerCase(),
    winnerSide: String(raw?.winner_side || '').toUpperCase(),
  };
}

function parseArmyNodePage(doc) {
  let fights = extractAssignedJson(doc, 'fightCards');
  if (!Array.isArray(fights)) {
    fights = firstAll(doc, ['.fight[data-match-no]', '.fight']).map((card) => ({
      match_no: attr(card, 'data-match-no'),
      status: text(card.querySelector?.('.badge')),
      battle_id: 0,
    }));
  }
  const activeMatchNo = Number(extractAssignedNumber(doc, 'activeMatchNo')) || 0;
  return {
    activeMatchNo,
    fights: fights.map(normalizeFight).filter(Boolean).sort((left, right) => left.matchNo - right.matchNo),
  };
}

function chooseArmyFight(page) {
  const fights = Array.isArray(page?.fights) ? page.fights : [];
  if (Number(page?.activeMatchNo) > 0) {
    const current = fights.find((fight) => fight.matchNo === Number(page.activeMatchNo) && fight.status !== 'cleared');
    if (current) return current;
  }
  return (
    fights.find((fight) => fight.status === 'active') ||
    fights.find((fight) => fight.status === 'failed') ||
    fights.find((fight) => fight.status === 'open') ||
    null
  );
}

function buildArmyEnterPayload({ instanceId, nodeId, matchNo } = {}) {
  const instance = cleanInteger(instanceId);
  const node = cleanInteger(nodeId);
  const match = cleanInteger(matchNo);
  if (!instance || !node || !match) return null;
  return { action: 'enter_fight', instance_id: instance, node_id: node, match_no: match };
}

function parseArmyEnterResponse(response, baseUrl = 'https://demonicscans.org/') {
  const json = wrappedJson(response);
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  const base = resolveUrl(baseUrl);
  const redirect = resolveUrl(json?.redirect, baseUrl);
  const ok = Boolean(
    transportOk &&
      json?.ok === true &&
      base &&
      redirect &&
      redirect.origin === base.origin &&
      /\/shadow_army_live_battle\.php\/?$/i.test(redirect.pathname),
  );
  return { ok, redirect: ok ? redirect.href : '', message: responseMessage(response) };
}

function parseArmyLivePage(doc) {
  const state = extractAssignedJson(doc, 'initialState');
  const battleId = extractAssignedNumber(doc, 'battleId') || cleanInteger(state?.battle?.id);
  return { battleId, state: state && typeof state === 'object' ? state : null };
}

function parseArmyActionResponse(response) {
  const json = wrappedJson(response);
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  const state = json?.state;
  return {
    ok: Boolean(transportOk && json?.ok === true && state && typeof state === 'object'),
    state: state && typeof state === 'object' ? state : null,
    message: responseMessage(response),
  };
}

function parseOwnedArmyShadows(doc) {
  const units = extractAssignedJson(doc, 'specialUnits');
  if (!units || Array.isArray(units) || typeof units !== 'object') return [];
  const shadows = [];
  const seen = new Set();
  for (const unit of Object.values(units)) {
    const id = String(unit?.shadow_id ?? '').trim();
    const name = String(unit?.title || '').replace(/\s+/g, ' ').trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0 || !name || seen.has(id)) continue;
    seen.add(id);
    shadows.push({ id, name });
  }
  return shadows.sort((left, right) => left.name.localeCompare(right.name));
}

function parseArmyFormationPage(doc) {
  const data = extractAssignedJson(doc, 'FormationData');
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    return {
      found: false,
      locked: false,
      lockedMessage: '',
      captainLimit: 0,
      captains: [],
    };
  }
  const captainLimit = Number(data.captainLimit);
  const captains = data.captains && !Array.isArray(data.captains) && typeof data.captains === 'object'
    ? Object.values(data.captains).map((captain) => ({
      inventoryId: cleanInteger(captain?.inv_id),
      shadowId: cleanInteger(captain?.shadow_id),
      name: String(captain?.title || '').replace(/\s+/g, ' ').trim(),
      inFormation: captain?.in_formation === true,
      dead: captain?.dead === true,
    })).filter((captain) => captain.inventoryId && captain.shadowId && captain.name)
    : [];
  return {
    found: true,
    locked: data.formationLocked === true,
    lockedMessage: String(data.formationLockedMessage || '').replace(/\s+/g, ' ').trim(),
    captainLimit: Number.isInteger(captainLimit) && captainLimit > 0 ? captainLimit : 1,
    captains,
  };
}

function buildArmyFormationPayload(action, fields = {}) {
  if (action !== 'set_captain') return null;
  const inventoryId = cleanInteger(fields.inventoryId);
  if (!inventoryId) return null;
  return { action, unit_inv_id: inventoryId };
}

function parseArmyFormationActionResponse(response) {
  const json = wrappedJson(response);
  const transportOk = response?.ok === undefined ? true : response.ok === true;
  return {
    ok: Boolean(transportOk && json?.ok === true),
    message: responseMessage(response),
  };
}

function buildArmyLivePayload(action, fields = {}) {
  const battleId = cleanInteger(fields.battleId);
  if (!battleId || !['get_state', 'join_battle', 'assign_target', 'retreat_captain'].includes(action)) return null;
  // The live Army page includes this field on every request, even though the
  // current page token is the empty string. Preserve the exact wire contract;
  // some deployments distinguish a present empty field from a missing one.
  const payload = { action, csrf: '', battle_id: battleId };
  if (action === 'assign_target') {
    const attacker = cleanInteger(fields.attackerId);
    const defender = cleanInteger(fields.defenderId);
    if (!attacker || !defender) return null;
    payload.attacker_captain_unit_id = attacker;
    payload.defender_captain_unit_id = defender;
  }
  if (action === 'retreat_captain') {
    const captain = cleanInteger(fields.captainId);
    if (!captain) return null;
    payload.captain_unit_id = captain;
  }
  return payload;
}

function livingCaptain(captain) {
  return Boolean(
    captain &&
      !captain.is_dead &&
      Number(captain.squad_current_health) > 0 &&
      cleanInteger(captain.id),
  );
}

function armySummary(state) {
  const captains = Array.isArray(state?.captains) ? state.captains : [];
  const engagements = Array.isArray(state?.engagements) ? state.engagements : [];
  return {
    active: String(state?.battle?.status || '').toUpperCase() === 'ACTIVE',
    winnerSide: String(state?.battle?.winner_side || '').toUpperCase(),
    viewer: state?.viewer && typeof state.viewer === 'object' ? state.viewer : {},
    own: captains.filter((captain) => captain.side === 'ALLY' && captain.is_mine === true),
    livingOwn: captains.filter(
      (captain) => captain.side === 'ALLY' && captain.is_mine === true && livingCaptain(captain) && !captain.retreat_requested,
    ),
    enemies: captains.filter((captain) => captain.side === 'ENEMY'),
    livingEnemies: captains.filter((captain) => captain.side === 'ENEMY' && livingCaptain(captain)),
    engagements,
  };
}

function planArmyActions(state, mode, selectedShadowIds = null) {
  const summary = armySummary(state);
  if (!summary.active) return { done: true, reason: 'ended', commands: [], summary };
  if (summary.viewer.has_roster === false) {
    return { done: false, error: 'No saved Shadow Army formation is available.', commands: [], summary };
  }
  if (summary.own.length === 0) {
    if (summary.viewer.can_join === true) return { done: false, commands: [{ action: 'join' }], summary };
    return { done: false, wait: true, commands: [], summary };
  }
  const selected = Array.isArray(selectedShadowIds)
    ? new Set(selectedShadowIds.map((id) => String(id)))
    : null;
  if (selected && selected.size === 0) {
    return { done: false, error: 'No Shadow is selected for the Crucible Army formation.', commands: [], summary };
  }
  const selectedOwn = selected
    ? summary.own.filter((captain) => selected.has(String(captain.source_shadow_id ?? '')))
    : summary.own;
  const selectedLivingOwn = selected
    ? summary.livingOwn.filter((captain) => selected.has(String(captain.source_shadow_id ?? '')))
    : summary.livingOwn;
  if (selected && selectedOwn.length === 0) {
    return {
      done: false,
      error: 'None of the selected Shadows is present in the saved game formation.',
      commands: [],
      summary,
    };
  }
  if (summary.livingEnemies.length === 0) return { done: false, wait: true, commands: [], summary };
  if (selectedLivingOwn.length === 0) {
    return { done: true, reason: 'all-own-dead', commands: [], summary };
  }

  const engagedAttackers = new Set(
    summary.engagements.map((engagement) => Number(engagement?.attacker_captain_unit_id)).filter(Number.isFinite),
  );
  const available = selectedLivingOwn.filter((captain) => !engagedAttackers.has(Number(captain.id)));
  if (available.length === 0) return { done: false, wait: true, commands: [], summary };
  if (mode === 'minimal') {
    return {
      done: false,
      commands: [
        {
          action: 'assign',
          attackerId: Number(available[0].id),
          defenderId: Number(summary.livingEnemies[0].id),
        },
      ],
      summary,
    };
  }
  if (mode !== 'kill') return { done: false, error: `Unsupported Army mode: ${String(mode || '')}.`, commands: [], summary };
  return {
    done: false,
    commands: available.map((captain, index) => ({
      action: 'assign',
      attackerId: Number(captain.id),
      defenderId: Number(summary.livingEnemies[index % summary.livingEnemies.length].id),
    })),
    summary,
  };
}

function captainHealth(state, captainId) {
  const captain = (state?.captains || []).find((candidate) => Number(candidate?.id) === Number(captainId));
  return captain ? Number(captain.squad_current_health) : null;
}

function captainTurns(state, captainId) {
  const captain = (state?.captains || []).find((candidate) => Number(candidate?.id) === Number(captainId));
  return captain ? Number(captain.turns_acted) : null;
}

function hasVerifiedArmyHit(beforeState, afterState, attackerId, defenderId) {
  const turnsBefore = captainTurns(beforeState, attackerId);
  const turnsAfter = captainTurns(afterState, attackerId);
  if (!Number.isFinite(turnsBefore) || !Number.isFinite(turnsAfter) || turnsAfter <= turnsBefore) return false;

  const healthBefore = captainHealth(beforeState, defenderId);
  const healthAfter = captainHealth(afterState, defenderId);
  if (!Number.isFinite(healthBefore)) return false;
  if (healthAfter === null) return true;
  return Number.isFinite(healthAfter) && healthAfter < healthBefore;
}

function parseArmyHealAvailability(doc) {
  for (const form of all(doc, 'form')) {
    const input = form.querySelector?.('input[name="action"][value="heal_all_units"]');
    if (!input) continue;
    const button = form.querySelector?.('button[type="submit"], button');
    const disabled = Boolean(button?.disabled || attr(button, 'disabled') !== null);
    return { found: true, available: Boolean(button && !disabled) };
  }
  return { found: false, available: false };
}

module.exports = {
  ACTIONABLE_STATUSES,
  CRUCIBLE_NAME,
  actionableNodes,
  armySummary,
  buildArmyEnterPayload,
  buildArmyFormationPayload,
  buildArmyLivePayload,
  buildCubeNodeEnterPayload,
  buildPvpBattleUrl,
  buildPvpClaimPayload,
  chooseArmyFight,
  choosePvpAction,
  discoverPveMonsters,
  extractAssignedJson,
  extractAssignedNumber,
  hasVerifiedArmyHit,
  nodeForLocationId,
  parseArmyActionResponse,
  parseArmyEnterResponse,
  parseArmyFormationActionResponse,
  parseArmyFormationPage,
  parseArmyHealAvailability,
  parseArmyLivePage,
  parseArmyNodePage,
  parseOwnedArmyShadows,
  parseCubeNodeEnterResponse,
  parseCubePage,
  parseHubEntry,
  parsePvpClaimResponse,
  parsePvpBattlePage,
  parsePvpLobby,
  parsePvpState,
  planArmyActions,
  resolveUrl,
};
