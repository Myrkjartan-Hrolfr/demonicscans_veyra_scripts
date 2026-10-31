'use strict';

// Pure parsing and decision helpers for Shadowbridge Warrens.  The worker is
// intentionally kept separate: this module never navigates, stores state or
// submits a request, which makes every safety decision testable in Node.

const { parseFraction, parseGameNumber } = require('../../core/numbers');
const participation = require('../dungeon/participation-helpers');
const shadowbridgeRoute = require('../../routes/shadowbridge');

const SHADOWBRIDGE_NAME = 'Shadowbridge Warrens';
const SHADOWBRIDGE_MONSTERS = shadowbridgeRoute.SHADOWBRIDGE_MONSTERS;
const SHADOWBRIDGE_SKILLS = shadowbridgeRoute.SHADOWBRIDGE_SKILLS;

const MONSTER_ID_BY_NAME = new Map(
  SHADOWBRIDGE_MONSTERS.map((monster) => [normalizeMonsterName(monster.name), monster.id]),
);
const SKILL_BY_ID = new Map(SHADOWBRIDGE_SKILLS.map((skill) => [String(skill.id), skill]));

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

function attr(element, name) {
  try {
    return element?.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function hasClass(element, name) {
  return element?.classList?.contains?.(name) === true;
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

function queryParam(href, name, baseUrl) {
  return resolveUrl(href, baseUrl)?.searchParams.get(name) || '';
}

function normalizeMonsterName(value) {
  return String(value ?? '')
    .normalize?.('NFKD')
    ?.replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase() || '';
}

function monsterIdForName(value) {
  return MONSTER_ID_BY_NAME.get(normalizeMonsterName(value)) || '';
}

function parseLooseAmount(value) {
  const match = String(value ?? '').match(/(\d[\d,.]*(?:\s*[kmbtq])?)/i);
  return match ? parseGameNumber(match[1].replace(/\s+/g, '')) : null;
}

function parsePageFraction(value) {
  const match = String(value ?? '').match(/([\d,.]+\s*[kmbtq]?)\s*\/\s*([\d,.]+\s*[kmbtq]?)/i);
  if (!match) return null;
  return parseFraction(`${match[1]} / ${match[2]}`);
}

function namedDungeonCard(link, wantedName) {
  let candidate = link?.parentElement || null;
  for (let depth = 0; candidate && depth < 10; depth += 1) {
    const enterLinks = all(candidate, 'a[href*="guild_dungeon_enter.php"]');
    // The live Open Dungeons cards have no class. Their shared `.panel`
    // contains every dungeon and must never be used to associate a link with
    // a name, otherwise the first card wins for every worker.
    if (normalizeMonsterName(text(candidate)).includes(wantedName) && enterLinks.length <= 1) {
      return candidate;
    }
    candidate = candidate.parentElement || null;
  }
  return null;
}

// Finds a dynamic dungeon instance entry by its visible name. A hub can
// contain several dungeons, so an enter link is accepted only when its
// surrounding card names the requested dungeon.
function parseNamedHubEntry(doc, dungeonName, baseUrl = 'https://demonicscans.org/guild_dungeon.php') {
  const wanted = normalizeMonsterName(dungeonName);
  if (!wanted) return null;
  for (const link of all(doc, 'a[href*="guild_dungeon_enter.php"]')) {
    const card = namedDungeonCard(link, wanted);
    if (!card) continue;
    const url = resolveUrl(attr(link, 'href'), baseUrl);
    const instanceId = url?.searchParams.get('id') || url?.searchParams.get('instance_id') || '';
    if (!url || !/^\d+$/.test(instanceId)) continue;
    return { instanceId, url: url.href };
  }

  // Some layouts put the dungeon name and the button in a common card but
  // render the link outside the generic anchor list returned by test doubles.
  for (const card of all(doc, '.dungeon-card, .guild-dungeon-card, .card')) {
    if (!normalizeMonsterName(text(card)).includes(wanted)) continue;
    const link = card.querySelector?.('a[href*="guild_dungeon_enter.php"]');
    const url = resolveUrl(attr(link, 'href'), baseUrl);
    const instanceId = url?.searchParams.get('id') || url?.searchParams.get('instance_id') || '';
    if (url && /^\d+$/.test(instanceId)) return { instanceId, url: url.href };
  }
  return null;
}

function parseHubEntry(doc, baseUrl = 'https://demonicscans.org/guild_dungeon.php') {
  return parseNamedHubEntry(doc, SHADOWBRIDGE_NAME, baseUrl);
}

function instanceIdFromPage(doc, pageUrl = '') {
  const url = resolveUrl(pageUrl);
  const fromQuery = url?.searchParams.get('id') || url?.searchParams.get('instance_id') || '';
  if (/^\d+$/.test(fromQuery)) return fromQuery;
  const titleMatch = `${text(doc?.querySelector?.('title'))} ${text(doc?.querySelector?.('h1'))} ${text(doc?.body)}`
    .match(/instance\s*#\s*(\d+)/i);
  if (titleMatch) return titleMatch[1];
  for (const link of all(doc, 'a[href*="guild_dungeon_location.php"]')) {
    const candidate = queryParam(attr(link, 'href'), 'instance_id', pageUrl);
    if (/^\d+$/.test(candidate)) return candidate;
  }
  return '';
}

function locationLabel(link) {
  return (
    text(link?.querySelector?.('.label')) ||
    String(attr(link, 'title') || '').trim() ||
    String(attr(link, 'aria-label') || '').trim() ||
    text(link)
  );
}

function isBossLabel(value) {
  return /\bboss\b/i.test(String(value || ''));
}

function parseInstancePage(doc, pageUrl = '') {
  const instanceId = instanceIdFromPage(doc, pageUrl);
  const locations = [];
  const seen = new Set();
  let bossLocked = false;

  const links = [
    ...all(doc, 'a[href*="guild_dungeon_location.php"]'),
    ...all(doc, 'a.pin.locked'),
  ];
  for (const link of links) {
    const label = locationLabel(link);
    const href = attr(link, 'href') || '';
    const locked = hasClass(link, 'locked') || /^\s*javascript:/i.test(href) || !href;
    if (locked) {
      if (isBossLabel(label) || normalizeMonsterName(text(link)).includes('boss')) bossLocked = true;
      continue;
    }
    const url = resolveUrl(href, pageUrl);
    const locationId = url?.searchParams.get('location_id') || '';
    const linkInstanceId = url?.searchParams.get('instance_id') || instanceId;
    if (!url || !/^\d+$/.test(locationId)) continue;
    if (instanceId && linkInstanceId && linkInstanceId !== instanceId) continue;
    const key = `${linkInstanceId}:${locationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({
      id: locationId,
      instanceId: linkInstanceId,
      url: url.href,
      label,
      isBoss: isBossLabel(label),
    });
  }
  return { instanceId, locations, bossLocked };
}

function directText(element) {
  try {
    return Array.from(element?.childNodes || [])
      .filter((node) => node?.nodeType === 3)
      .map((node) => String(node.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function monsterNameFromCard(card) {
  const named =
    card?.querySelector?.('.monster-name, .name') ||
    card?.querySelector?.('.monster-name') ||
    card?.querySelector?.('.name') ||
    null;
  if (named) return text(named);

  const heading =
    card?.querySelector?.('[style*="font-weight:700"]') ||
    card?.querySelector?.('[style*="font-weight: 700"]') ||
    null;
  // On live dungeon pages the join-status pill is a child of this heading.
  // Read only its direct text node so "not joined" never becomes part of the
  // persisted monster identity.
  const directName = directText(heading);
  if (directName) return directName;
  const headingText = text(heading).replace(/^(?:(?:not\s+)?joined|dead|defeated)\s+/i, '');
  return headingText || String(attr(card?.querySelector?.('img[alt]'), 'alt') || '').trim();
}

function parseLocationPage(doc, pageUrl = '') {
  const page = resolveUrl(pageUrl);
  const pageInstanceId = page?.searchParams.get('instance_id') || '';
  const locationId = page?.searchParams.get('location_id') || '';
  const monsters = [];
  for (const card of all(doc, '.mon')) {
    const link =
      card.querySelector?.('a[href*="battle.php"]') ||
      card.querySelector?.('a[href*="dgmid"]') ||
      null;
    const url = resolveUrl(attr(link, 'href'), pageUrl);
    const monsterId = url?.searchParams.get('dgmid') || '';
    if (!url || !monsterId) continue;
    const name = monsterNameFromCard(card);
    const pillText = normalizeMonsterName(all(card, '.pill').map(text).join(' '));
    const dead =
      hasClass(card, 'dead') ||
      attr(card, 'data-dead') === '1' ||
      /\bdead\b|\bdefeated\b/.test(pillText);
    const joinedAttr = attr(card, 'data-joined');
    const joined =
      joinedAttr === '1' ||
      joinedAttr === 'true' ||
      (/\bjoined\b/.test(pillText) && !/\bnot joined\b/.test(pillText));
    monsters.push({
      monsterId: String(monsterId),
      name,
      monsterTypeId: monsterIdForName(name),
      instanceId: url.searchParams.get('instance_id') || pageInstanceId,
      locationId,
      url: url.href,
      dead,
      joined,
    });
  }
  return monsters;
}

function statBlock(doc, wantedLabel) {
  const wanted = normalizeMonsterName(wantedLabel).replace(/\s+/g, '');
  return (
    all(doc, '.stat-block').find((block) => {
      const label = normalizeMonsterName(text(block.querySelector?.('.label'))).replace(/\s+/g, '');
      return label === wanted;
    }) || null
  );
}

function parseHpFraction(doc, selector) {
  return parsePageFraction(text(doc?.querySelector?.(selector)));
}

function parseExpCapFraction(doc) {
  const block = statBlock(doc, 'EXP Cap');
  const match = text(block).match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!match) return null;
  const percent = Number(match[1].replace(',', '.'));
  return Number.isFinite(percent) && percent > 0 ? percent / 100 : null;
}

function parseBattleSnapshot(doc, options = {}) {
  const info = participation.parseBattleInfo(doc);
  const hp =
    parseHpFraction(doc, '#hpText') ||
    parseHpFraction(doc, '.monster-hp .stat-value') ||
    null;
  const playerHp = parseHpFraction(doc, '#pHpText');
  const maxHp = hp?.max ?? info.maxHp ?? null;
  const expCapFraction = parseExpCapFraction(doc);
  const expCapDamage =
    info.expCapDamage ??
    (expCapFraction !== null && Number.isFinite(maxHp) ? Math.ceil(expCapFraction * maxHp) : null);
  const userId = String(options.userId ?? '').trim();
  const ownRow = userId ? info.leaderboard.find((entry) => String(entry.pid) === userId) : null;
  const joinButton = doc?.querySelector?.('#join-battle') || null;
  const actionsCard = doc?.querySelector?.('.battle-actions-card') || null;
  const actionsText = normalizeMonsterName(text(actionsCard));
  const joined = ownRow
    ? true
    : joinButton
      ? false
      : /\balready joined\b|\byou joined\b|\bjoined battle\b/.test(actionsText) || actionsCard
        ? true
        : null;
  const bodyState = normalizeMonsterName(
    `${text(doc?.querySelector?.('.battle-actions-card'))} ${text(doc?.querySelector?.('#hpText'))}`,
  );
  const dead = hp?.current === 0 || /\bmonster (?:is )?dead\b|\bdefeated\b|\bbattle ended\b/.test(bodyState);
  const page = resolveUrl(options.url || '');

  return {
    monsterId: String(options.monsterId || page?.searchParams.get('dgmid') || ''),
    instanceId: String(options.instanceId || page?.searchParams.get('instance_id') || ''),
    joined,
    dead,
    currentHp: hp?.current ?? null,
    maxHp,
    playerHp: playerHp?.current ?? null,
    playerMaxHp: playerHp?.max ?? null,
    ownDamage: ownRow ? ownRow.damage : null,
    ownDamageKnown: Boolean(ownRow),
    lootRequirement: info.lootRequirement,
    expCapDamage,
    expCapFraction,
    leaderboard: info.leaderboard,
  };
}

function positiveAmount(value) {
  const parsed = typeof value === 'number' ? value : parseGameNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

// Resolves a personal damage goal.  Kill mode deliberately has no numeric
// goal: concurrent players may reduce HP, so the worker must continue until a
// fresh battle page or attack response says the monster is dead.
function resolveDamageTarget({ mode, damage, isBoss = false, allowMaxExp = isBoss, snapshot } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: 'Battle data is unavailable.' };
  }
  if (snapshot.dead) return { ok: true, done: true, untilDead: mode === 'kill', targetDamage: null, remaining: 0 };

  if (mode === 'kill') {
    return { ok: true, done: false, untilDead: true, targetDamage: null, remaining: null };
  }

  let targetDamage = null;
  if (mode === 'max-damage') targetDamage = positiveAmount(snapshot.maxHp);
  else if (mode === 'max-loot') targetDamage = positiveAmount(snapshot.lootRequirement);
  else if (mode === 'max-exp' && allowMaxExp) targetDamage = positiveAmount(snapshot.expCapDamage);
  else if (mode === 'custom') targetDamage = positiveAmount(damage);
  else return { ok: false, error: `Unsupported Shadowbridge damage mode: ${String(mode || '')}.` };

  if (targetDamage === null) {
    const label =
      mode === 'max-damage'
        ? 'maximum monster HP'
        : mode === 'max-loot'
          ? 'loot requirement'
          : mode === 'max-exp'
            ? 'EXP cap'
            : 'custom damage';
    return { ok: false, error: `The ${label} could not be read safely.` };
  }
  if (!snapshot.ownDamageKnown || !Number.isFinite(snapshot.ownDamage)) {
    return { ok: false, error: 'Your current damage is missing from the battle leaderboard.' };
  }
  const remaining = Math.max(0, targetDamage - snapshot.ownDamage);
  return {
    ok: true,
    done: remaining === 0,
    untilDead: false,
    targetDamage,
    remaining,
  };
}

function cleanIdentifier(value) {
  const result = String(value ?? '').trim();
  return result && /^[\w:-]+$/.test(result) ? result : '';
}

function buildJoinPayload({ instanceId, monsterId, userId } = {}) {
  const instance = cleanIdentifier(instanceId);
  const monster = cleanIdentifier(monsterId);
  const user = cleanIdentifier(userId);
  if (!instance || !monster || !user) return null;
  return { instance_id: instance, dgmid: monster, user_id: user };
}

function skillForId(skillId) {
  return SKILL_BY_ID.get(String(skillId)) || null;
}

// Max Loot can become impossible when other players reduce the monster's HP
// faster than this player reaches the personal loot requirement. In that
// last-chance situation an explicitly configured alternative skill is used.
function selectAttackSkill({
  mode,
  primarySkillId,
  alternativeSkillId,
  currentHp,
  targetDamage,
  ownDamage,
} = {}) {
  const primary = skillForId(primarySkillId);
  if (!primary) return null;

  const remainingDamage =
    Number.isFinite(targetDamage) && Number.isFinite(ownDamage)
      ? Math.max(0, targetDamage - ownDamage)
      : null;
  const alternative = skillForId(alternativeSkillId);
  const usedAlternative = Boolean(
    mode === 'max-loot' &&
      alternative &&
      alternative.id !== primary.id &&
      Number.isFinite(currentHp) &&
      currentHp > 0 &&
      Number.isFinite(remainingDamage) &&
      remainingDamage > 0 &&
      currentHp <= remainingDamage,
  );

  return {
    skill: usedAlternative ? alternative : primary,
    usedAlternative,
    remainingDamage,
  };
}

function buildDamagePayload({ instanceId, monsterId, skillId } = {}) {
  const instance = cleanIdentifier(instanceId);
  const monster = cleanIdentifier(monsterId);
  const skill = skillForId(skillId);
  if (!instance || !monster || !skill) return null;
  return {
    instance_id: instance,
    dgmid: monster,
    skill_id: String(skill.id),
    // F21: always send the base cost.  Asterion affects the game's display
    // and stamina checks, never this damage.php parameter.
    stamina_cost: skill.cost,
  };
}

function responseMessage(response) {
  const json = response?.json;
  return String(json?.message ?? json?.msg ?? response?.text ?? '').trim();
}

function parseJoinResponse(response) {
  const message = responseMessage(response);
  const normalized = normalizeMonsterName(message);
  const json = response?.json;
  const declaredFailure = json?.success === false || /^(?:error|failed|failure)$/i.test(String(json?.status || ''));
  const alreadyJoined = /already (?:joined|in (?:this )?battle)/i.test(message);
  const declaredSuccess =
    json?.success === true ||
    /^(?:ok|success)$/i.test(String(json?.status || '')) ||
    /successfully joined|joined (?:the )?battle/.test(normalized) ||
    alreadyJoined;
  return {
    ok: Boolean(response?.ok && !declaredFailure && declaredSuccess),
    alreadyJoined,
    message,
  };
}

function parseAttackResponse(response) {
  const json = response?.json;
  const message = responseMessage(response);
  const normalized = normalizeMonsterName(message);
  const directDamage =
    positiveAmount(json?.damage) ??
    positiveAmount(json?.damage_dealt) ??
    positiveAmount(json?.dealt) ??
    null;
  const strongMatch = message.match(/<strong[^>]*>\s*([\d,.]+\s*[kmbtq]?)\s*<\/strong>/i);
  const textMatch = message.match(/(?:deal(?:t)?|damage(?:d)?)\D{0,24}([\d,.]+\s*[kmbtq]?)/i);
  const damage = directDamage ?? positiveAmount(strongMatch?.[1]) ?? positiveAmount(textMatch?.[1]) ?? 0;
  const dead = Boolean(
    json?.monster_dead === true ||
      json?.dead === true ||
      Number(json?.hp?.value) === 0 ||
      /\bmonster (?:is )?dead\b|\bdefeated\b|\bslain\b|\bkilled\b|no longer alive/.test(normalized),
  );
  const declaredFailure = json?.success === false || /^(?:error|failed|failure)$/i.test(String(json?.status || ''));
  const declaredSuccess =
    json?.success === true ||
    /^(?:ok|success)$/i.test(String(json?.status || '')) ||
    damage > 0 ||
    dead;
  const currentHp = Number.isFinite(Number(json?.hp?.value)) ? Number(json.hp.value) : null;
  const maxHp = Number.isFinite(Number(json?.hp?.max)) ? Number(json.hp.max) : null;
  const playerHp = Number.isFinite(Number(json?.retaliation?.user_hp_after))
    ? Number(json.retaliation.user_hp_after)
    : null;
  return {
    ok: Boolean(response?.ok && !declaredFailure && declaredSuccess),
    damage,
    dead,
    currentHp,
    maxHp,
    playerHp,
    message,
  };
}

module.exports = {
  SHADOWBRIDGE_MONSTERS,
  SHADOWBRIDGE_NAME,
  SHADOWBRIDGE_SKILLS,
  buildDamagePayload,
  buildJoinPayload,
  instanceIdFromPage,
  monsterIdForName,
  normalizeMonsterName,
  parseAttackResponse,
  parseBattleSnapshot,
  parseHubEntry,
  parseNamedHubEntry,
  parseInstancePage,
  parseJoinResponse,
  parseLocationPage,
  resolveDamageTarget,
  selectAttackSkill,
  skillForId,
};
