'use strict';

const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { extractShadow } = require('../loot/loot-api');
const { attackMonster, getSkill, joinMonster } = require('../wave/attack');
const route = require('../../routes/shadowcollection');

const TRACKED_KEY = 'veyra:shadowcollection:tracked:v1';
const VISIT_PARAM = 'veyra_visit';
const WORKER_BUILD = '0.11.6';
const COLLECTION_STATE_VERSION = 3;
const MISSING_TARGET_RETRY_MS = 60_000;
const BUSY_HEARTBEAT_MS = 5_000;
const EXTRACTION_GRACE_MS = 60_000;
const EXTRACTION_RETRY_MS = 5 * 60_000;
const MAX_TRUSTED_HARVEST_DELAY_MS = 24 * 60 * 60_000;

function writeLog(store, message, detail = null) {
  const entries = Array.isArray(store?.read?.(route.LOG_KEY)) ? store.read(route.LOG_KEY) : [];
  let rendered = '';
  if (detail !== null && detail !== undefined) {
    try { rendered = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch { rendered = String(detail); }
  }
  entries.push({ at: Date.now(), message: String(message || ''), detail: rendered.slice(0, 2000) });
  store?.write?.(route.LOG_KEY, entries.slice(-100));
  console.info(`[Veyra:shadowcollection] ${message}`, detail ?? '');
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function validId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : '';
}

function validFutureMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function tagAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function parseRawWaveMonsters(html) {
  const found = [];
  const seen = new Set();
  const source = String(html || '');
  for (const match of source.matchAll(/<div\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/(?:^|\s)monster-card(?:\s|$)/i.test(tagAttribute(tag, 'class'))) continue;
    const id = validId(tagAttribute(tag, 'data-monster-id'));
    const name = tagAttribute(tag, 'data-name').replace(/\s+/g, ' ').trim();
    if (!id || !name || tagAttribute(tag, 'data-dead') === '1' || seen.has(id)) continue;
    seen.add(id);
    const expiresAtMs = validFutureMs(tagAttribute(tag, 'data-expire')) * 1000;
    found.push({ id, name, href: `/battle.php?id=${id}`, expiresAtMs });
  }
  for (const match of source.matchAll(/<div\b[^>]*class=["'][^"']*auto-summon-card[^"']*["'][^>]*>[\s\S]{0,8000}?class=["'][^"']*auto-summon-name[^"']*["'][^>]*>([^<]+)<[\s\S]{0,8000}?href=["'][^"']*battle\.php\?id=(\d+)[^"']*["']/gi)) {
    const id = validId(match[2]);
    const name = String(match[1] || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    found.push({ id, name, href: `/battle.php?id=${id}`, expiresAtMs: 0 });
  }
  return found;
}

function parseRawDeadWaveMonsters(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<div\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/(?:^|\s)monster-card(?:\s|$)/i.test(tagAttribute(tag, 'class'))) continue;
    const id = validId(tagAttribute(tag, 'data-monster-id'));
    const name = tagAttribute(tag, 'data-name').replace(/\s+/g, ' ').trim();
    const userDamage = Number(tagAttribute(tag, 'data-userdmg')) || 0;
    if (!id || !name || tagAttribute(tag, 'data-dead') !== '1' || userDamage <= 0 || seen.has(id)) continue;
    seen.add(id);
    found.push({ id, name, href: `/battle.php?id=${id}` });
  }
  return found;
}

function parseRawDeadMonsterIds(html) {
  const ids = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<div\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/(?:^|\s)monster-card(?:\s|$)/i.test(tagAttribute(tag, 'class'))) continue;
    const id = validId(tagAttribute(tag, 'data-monster-id'));
    if (!id || tagAttribute(tag, 'data-dead') !== '1' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function rawMonsterIdSamples(html, limit = 5) {
  const samples = [];
  const source = String(html || '');
  const pattern = /.{0,100}data-monster-id.{0,180}/gi;
  for (const match of source.matchAll(pattern)) {
    samples.push(match[0].replace(/\s+/g, ' ').trim().slice(0, 280));
    if (samples.length >= limit) break;
  }
  return samples;
}

function rawMonsterCardStats(html) {
  const stats = { total: 0, alive: 0, dead: 0 };
  for (const match of String(html || '').matchAll(/<div\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/(?:^|\s)monster-card(?:\s|$)/i.test(tagAttribute(tag, 'class'))) continue;
    if (!validId(tagAttribute(tag, 'data-monster-id'))) continue;
    stats.total += 1;
    if (tagAttribute(tag, 'data-dead') === '1') stats.dead += 1;
    else stats.alive += 1;
  }
  return stats;
}

function battleAutoDieAt(html) {
  const source = String(html || '');
  const countdown = source.match(/startNoDamageCountdown\(\s*["'][^"']+["']\s*,\s*(\d{10,16})\s*\)/i);
  return countdown ? validFutureMs(countdown[1]) : 0;
}

function dailyExtractionLimitReached(html) {
  return /already\s+used\s+all\s+(?:of\s+)?(?:your\s+)?extraction\s+attempts\s+for\s+today/i
    .test(String(html || ''));
}

function cookieValue(doc, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(doc?.cookie || '').match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setViewCookie(doc, name, value) {
  if (!doc) return;
  doc.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=2592000; Path=/; SameSite=Lax`;
}

function restoreViewCookie(doc, name, value) {
  if (!doc) return;
  doc.cookie = value === null
    ? `${name}=; Max-Age=0; Path=/; SameSite=Lax`
    : `${name}=${encodeURIComponent(value)}; Max-Age=2592000; Path=/; SameSite=Lax`;
}

function parseWaveMonsters(doc) {
  const found = [];
  const seen = new Set();
  for (const card of doc?.querySelectorAll?.('.monster-card[data-monster-id]') || []) {
    const id = validId(card.getAttribute?.('data-monster-id'));
    const dead = card.getAttribute?.('data-dead') === '1';
    const name = String(card.getAttribute?.('data-name') || card.querySelector?.('h3, .card-title')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!id || !name || dead || seen.has(id)) continue;
    const link = card.querySelector?.('a[href*="battle.php"]');
    seen.add(id);
    const expiresAtMs = validFutureMs(card.getAttribute?.('data-expire')) * 1000;
    found.push({ id, name, href: link?.getAttribute?.('href') || `/battle.php?id=${id}`, expiresAtMs });
  }
  for (const link of doc?.querySelectorAll?.('a[href*="battle.php?id="]') || []) {
    let url;
    try { url = new URL(link.href || link.getAttribute?.('href'), 'https://demonicscans.org'); } catch { continue; }
    const id = validId(url.searchParams.get('id'));
    if (!id || seen.has(id)) continue;
    const card = link.closest?.('.monster-card, .auto-summon-card, .summon-card, .boss-card, .card') || link.parentElement;
    const explicitName = card?.getAttribute?.('data-name')
      || card?.querySelector?.('.auto-summon-name, h3, .card-title')?.textContent;
    const text = String(explicitName || card?.textContent || link.textContent || '').replace(/\s+/g, ' ').trim();
    const dead = card?.getAttribute?.('data-dead') === '1'
      || card?.getAttribute?.('data-alive') === '0'
      || /\bdead\b/i.test(String(card?.textContent || ''));
    if (!text || dead) continue;
    seen.add(id);
    const expiresAtMs = validFutureMs(card?.getAttribute?.('data-expire')) * 1000;
    found.push({ id, name: text, href: url.pathname + url.search, expiresAtMs });
  }
  // Always merge the raw response as well. This deliberately does not rely on
  // expando properties surviving on the browser-created Document nodes.
  for (const monster of parseRawWaveMonsters(doc?.__veyraHtml)) {
    if (seen.has(monster.id)) continue;
    seen.add(monster.id);
    found.push(monster);
  }
  return found;
}

function configuredTargets(settings) {
  const byId = new Map(route.TARGETS.map((target) => [target.id, target]));
  return settings.rows.filter((row) => row.quantity > 0 && byId.has(row.targetId)).map((row) => ({
    ...byId.get(row.targetId),
    quantity: row.quantity,
  }));
}

function normalizeCollectionState(value) {
  const source = Array.isArray(value) ? { tracked: value } : value && typeof value === 'object' ? value : {};
  const trustedTimers = Number(source.version) === COLLECTION_STATE_VERSION;
  const tracked = (Array.isArray(source.tracked) ? source.tracked : []).map((entry) => ({
    monsterId: validId(entry?.monsterId),
    targetId: String(entry?.targetId || ''),
    name: String(entry?.name || ''),
    harvestAt: trustedTimers ? validFutureMs(entry?.harvestAt) : 0,
  })).filter((entry) => entry.monsterId && entry.targetId);
  const extractedByTarget = {};
  for (const [targetId, count] of Object.entries(source.extractedByTarget || {})) {
    const normalized = Math.max(0, Math.min(route.MAX_TARGETS, Math.trunc(Number(count)) || 0));
    if (normalized) extractedByTarget[targetId] = normalized;
  }
  const consumedIds = [...new Set((Array.isArray(source.consumedIds) ? source.consumedIds : []).map(validId).filter(Boolean))]
    .slice(-50);
  return { version: COLLECTION_STATE_VERSION, tracked, extractedByTarget, consumedIds };
}

function targetForMonster(targets, monster) {
  return targets.find((target) => normalizeName(monster?.name).includes(normalizeName(target.name))) || null;
}

function noShadowFailure(message) {
  return !/network|http\s*\d+|server error|csrf|temporar|try again|rate.?limit/i.test(String(message || ''));
}

async function fetchDocument(win, path) {
  const response = await win.fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  const doc = new win.DOMParser().parseFromString(text, 'text/html');
  doc.__veyraHtml = text;
  doc.__veyraFetchMeta = { requested: path, responseUrl: response.url || '', title: doc.title || '', bytes: text.length };
  return doc;
}

async function runCollection(ctx, visit) {
  const { win, store, postForm, getUserId } = ctx;
  const settings = normalizeConfig(store.read(CONFIG_KEY)).routes.shadowcollection.settings;
  const targets = configuredTargets(settings);
  const state = normalizeCollectionState(store.read(TRACKED_KEY));
  let tracked = state.tracked;
  const extractedByTarget = { ...state.extractedByTarget };
  const consumedIds = new Set(state.consumedIds);
  writeLog(store, 'Run started.', {
    build: WORKER_BUILD,
    parser: 'daily-shadow-cycle-v1',
    visitId: visit.visitId,
    targets,
    tracked: tracked.length,
    extractedByTarget,
    consumed: consumedIds.size,
  });
  let extracted = 0;
  const available = [];
  const defeated = [];
  const originalHideDead = cookieValue(win.document, 'hide_dead_monsters');
  const originalDeadBossesOnly = cookieValue(win.document, 'show_dead_bosses_only');
  try {
    // The unfiltered view contains both alive monsters and defeated monsters
    // with user damage. It lets the daily cycle extract before spawning any
    // replacements.
    setViewCookie(win.document, 'hide_dead_monsters', '0');
    setViewCookie(win.document, 'show_dead_bosses_only', '0');
    for (const wave of [3, 5, 8]) {
      const path = () => `/active_wave.php?gate=3&wave=${wave}&veyra_scan=${Date.now()}-${wave}`;
      const page = await fetchDocument(win, path());
      const rawHtml = String(page.__veyraHtml || '');
      const cards = rawMonsterCardStats(rawHtml);
      const found = parseWaveMonsters(page);
      const dead = parseRawDeadWaveMonsters(rawHtml);
      available.push(...found);
      defeated.push(...dead);
      writeLog(store, `Gate 3 wave ${wave} scanned.`, {
        found: found.length,
        defeated: dead.length,
        page: page.__veyraFetchMeta,
        rawMonsterCards: (rawHtml.match(/monster-card/gi) || []).length,
        rawMonsterIds: (rawHtml.match(/data-monster-id/gi) || []).length,
        cards,
        monsters: found.map((monster) => ({ id: monster.id, name: monster.name })),
        defeatedMonsters: dead.map((monster) => ({ id: monster.id, name: monster.name })),
      });
    }
  } finally {
    restoreViewCookie(win.document, 'hide_dead_monsters', originalHideDead);
    restoreViewCookie(win.document, 'show_dead_bosses_only', originalDeadBossesOnly);
  }

  const candidates = [];
  const candidateIds = new Set();
  for (const entry of tracked) {
    if (entry.harvestAt > Date.now() && entry.harvestAt <= Date.now() + MAX_TRUSTED_HARVEST_DELAY_MS) continue;
    candidates.push(entry);
    candidateIds.add(entry.monsterId);
  }
  for (const monster of defeated) {
    if (candidateIds.has(monster.id) || consumedIds.has(monster.id)) continue;
    const target = targetForMonster(targets, monster);
    if (!target) continue;
    const neededDeadForTarget = Math.max(0, target.quantity - Number(extractedByTarget[target.id] || 0));
    const knownDeadForTarget = tracked.filter((entry) => entry.targetId === target.id).length;
    if (knownDeadForTarget >= neededDeadForTarget) continue;
    const candidate = { monsterId: monster.id, targetId: target.id, name: target.name, harvestAt: 0 };
    candidates.push(candidate);
    tracked.push(candidate);
    candidateIds.add(monster.id);
  }

  let endDay = false;
  for (const candidate of candidates) {
    if (endDay) break;
    const target = targets.find((entry) => entry.id === candidate.targetId);
    if (!target || Number(extractedByTarget[target.id] || 0) >= target.quantity) continue;
    const battle = await fetchDocument(win, `/battle.php?id=${candidate.monsterId}&veyra_scan=${Date.now()}`);
    if (dailyExtractionLimitReached(battle.__veyraHtml)) {
      endDay = true;
      writeLog(store, 'Server reports that the daily extraction limit has been reached.', {
        monsterId: candidate.monsterId,
        target: target.name,
      });
      break;
    }
    const activeAutoDieAt = battleAutoDieAt(battle.__veyraHtml);
    if (!battle.getElementById?.('extract-shadow-btn') && activeAutoDieAt > Date.now()) {
      tracked = tracked.map((entry) => entry.monsterId === candidate.monsterId
        ? { ...entry, harvestAt: activeAutoDieAt + EXTRACTION_GRACE_MS }
        : entry);
      writeLog(store, 'Legacy tracked monster timer repaired from its battle page.', {
        monsterId: candidate.monsterId,
        autoDieAt: activeAutoDieAt,
        harvestAt: activeAutoDieAt + EXTRACTION_GRACE_MS,
      });
      continue;
    }
    let result = { ok: false, message: 'No extractable shadow is available.', shadow: null };
    if (battle.getElementById?.('extract-shadow-btn')) result = await extractShadow(postForm, candidate.monsterId);
    writeLog(store, result.ok ? 'Shadow extraction succeeded.' : 'Shadow extraction failed.', {
      monsterId: candidate.monsterId,
      target: target.name,
      message: result.message,
      shadow: result.shadow?.NAME || '',
    });
    // A normal GET battle page does not reliably reveal the exhausted daily
    // limit. Only trust the response from an actual extraction attempt, and
    // only make that attempt for one of the configured target monsters.
    if (dailyExtractionLimitReached(result.message)) {
      endDay = true;
      writeLog(store, 'Server reports that the daily extraction limit has been reached.', {
        monsterId: candidate.monsterId,
        target: target.name,
      });
      break;
    }
    tracked = tracked.filter((entry) => entry.monsterId !== candidate.monsterId);
    if (result.ok) {
      extracted += 1;
      extractedByTarget[target.id] = Number(extractedByTarget[target.id] || 0) + 1;
      continue;
    }
    if (!noShadowFailure(result.message)) {
      tracked.push({ ...candidate, harvestAt: Date.now() + EXTRACTION_RETRY_MS });
      continue;
    }
    consumedIds.add(candidate.monsterId);
    writeLog(store, 'Defeated monster had no shadow and will be replaced.', {
      target: target.name,
      monsterId: candidate.monsterId,
    });
    break;
  }

  const dailyGoal = targets.reduce((sum, target) => sum + target.quantity, 0);
  const extractedToday = Object.values(extractedByTarget).reduce((sum, count) => sum + Number(count || 0), 0);
  if (endDay || extractedToday >= dailyGoal) {
    store.write(TRACKED_KEY, {
      version: COLLECTION_STATE_VERSION,
      tracked: [],
      extractedByTarget: {},
      consumedIds: [],
    });
    writeLog(store, 'Daily Shadow Collection cycle finished and reset.', {
      extractedToday,
      dailyGoal,
      serverLimitReached: endDay,
    });
    publishWorkerStatus(store, route.id, {
      visitId: visit.visitId,
      workerId: route.id,
      state: 'done',
      safeToLeave: true,
      message: `${extractedToday} shadows extracted; daily cycle finished.`,
    });
    return;
  }

  const already = new Set(tracked.map((entry) => entry.monsterId));
  const userId = validId(await getUserId?.());
  if (targets.length > 0 && !userId) throw new Error('Could not determine the user ID required to join battles.');
  let attacked = 0;
  for (const target of targets) {
    const trackedForTarget = tracked.filter((entry) => entry.targetId === target.id).length;
    const successfulForTarget = Number(extractedByTarget[target.id] || 0);
    const needed = Math.max(0, target.quantity - successfulForTarget - trackedForTarget);
    if (needed === 0) {
      writeLog(store, 'Target already has the configured number of tracked monsters.', { target: target.name, tracked: trackedForTarget });
      continue;
    }
    const matches = available.filter((monster) => !already.has(monster.id) && normalizeName(monster.name).includes(normalizeName(target.name)));
    writeLog(store, 'Target candidates selected.', { target: target.name, needed, matches: matches.map((monster) => monster.id) });
    for (const monster of matches.slice(0, needed)) {
      const joined = await joinMonster({ postForm, monsterId: monster.id, userId });
      writeLog(store, 'Join request finished.', {
        monsterId: monster.id,
        userId,
        ok: joined.ok,
        status: joined.status,
        message: joined.msg,
      });
      if (!joined.ok) continue;
      const hit = await attackMonster({ postForm, monsterId: monster.id, skill: getSkill('slash') });
      writeLog(store, 'Slash request finished.', {
        monsterId: monster.id,
        ok: hit.ok,
        status: hit.status,
        gameStatus: hit.data?.status,
        message: hit.msg,
      });
      if (!hit.ok) continue;
      attacked += 1;
      already.add(monster.id);
      // data-expire on wave cards is the retention timer for dead cards, not
      // the live monster's auto-die timer. The battle page exposes the real
      // absolute deadline through startNoDamageCountdown(...).
      const battle = await fetchDocument(win, `/battle.php?id=${monster.id}&veyra_scan=${Date.now()}`);
      const autoDieAt = battleAutoDieAt(battle.__veyraHtml);
      const harvestAt = autoDieAt > Date.now()
        ? autoDieAt + EXTRACTION_GRACE_MS
        : Date.now() + EXTRACTION_RETRY_MS;
      tracked.push({ monsterId: monster.id, targetId: target.id, name: target.name, harvestAt });
      writeLog(store, 'Shadow extraction scheduled from the monster auto-die timer.', {
        monsterId: monster.id,
        autoDieAt,
        harvestAt,
      });
    }
  }
  store.write(TRACKED_KEY, {
    version: COLLECTION_STATE_VERSION,
    tracked,
    extractedByTarget,
    consumedIds: [...consumedIds],
  });
  const outstanding = targets.reduce((sum, target) => {
    const trackedForTarget = tracked.filter((entry) => entry.targetId === target.id).length;
    return sum + Math.max(0, target.quantity - Number(extractedByTarget[target.id] || 0) - trackedForTarget);
  }, 0);
  const nextHarvestAt = tracked
    .map((entry) => validFutureMs(entry.harvestAt))
    .filter((timestamp) => timestamp > Date.now())
    .sort((left, right) => left - right)[0] || 0;
  const missingRetryAt = outstanding > 0 ? Date.now() + MISSING_TARGET_RETRY_MS : 0;
  const retryAt = [nextHarvestAt, missingRetryAt].filter(Boolean).sort((left, right) => left - right)[0] || 0;
  writeLog(store, 'Run finished.', { attacked, extracted, extractedToday, tracked: tracked.length, outstanding, retryAt });
  publishWorkerStatus(store, route.id, {
    visitId: visit.visitId,
    workerId: route.id,
    state: 'done',
    safeToLeave: true,
    message: outstanding > 0
      ? `${attacked} hit, ${outstanding} selected monsters unavailable; retrying in 1 minute.`
      : `${attacked} hit, ${extracted} shadows extracted, ${tracked.length} tracked.`,
    retryAt,
    note: outstanding > 0
      ? `Waiting for ${outstanding} selected monster${outstanding === 1 ? '' : 's'}`
      : nextHarvestAt ? 'Waiting for monster auto-die timer' : '',
  });
}

module.exports = Object.freeze({
  TRACKED_KEY,
  configuredTargets,
  parseRawWaveMonsters,
  parseRawDeadWaveMonsters,
  parseRawDeadMonsterIds,
  rawMonsterIdSamples,
  rawMonsterCardStats,
  battleAutoDieAt,
  dailyExtractionLimitReached,
  cookieValue,
  normalizeCollectionState,
  noShadowFailure,
  parseWaveMonsters,
  feature: Object.freeze({
    id: 'shadowcollection-worker',
    group: 'Automation',
    settings: [],
    matches(url) { return route.matchesUrl(url); },
    async run(ctx) {
      const visit = normalizeVisit(ctx.store.read(COMMAND_KEY), (taskId) => taskId === route.id);
      if (!visit || visit.phase !== 'running') return;
      const publishBusy = () => publishWorkerStatus(ctx.store, route.id, {
          visitId: visit.visitId,
          workerId: route.id,
          state: 'busy',
          safeToLeave: false,
          message: 'Shadow Collection is actively scanning, extracting or attacking.',
        });
      publishBusy();
      const heartbeat = ctx.win.setInterval?.(publishBusy, BUSY_HEARTBEAT_MS);
      try {
        await runCollection(ctx, visit);
      } catch (error) {
        writeLog(ctx.store, 'Run stopped with an error.', { message: error.message || String(error), stack: error.stack || '' });
        publishWorkerStatus(ctx.store, route.id, {
          visitId: visit.visitId,
          workerId: route.id,
          state: 'error',
          safeToLeave: true,
          message: `Shadow Collection stopped: ${error.message || error}`,
        });
      } finally {
        if (heartbeat !== undefined && heartbeat !== null) ctx.win.clearInterval?.(heartbeat);
      }
    },
  }),
  runCollection,
});
