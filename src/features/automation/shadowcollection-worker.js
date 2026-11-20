'use strict';

const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { extractShadow } = require('../loot/loot-api');
const { attackMonster, getSkill, joinMonster } = require('../wave/attack');
const route = require('../../routes/shadowcollection');

const TRACKED_KEY = 'veyra:shadowcollection:tracked:v1';
const VISIT_PARAM = 'veyra_visit';
const WORKER_BUILD = '0.10.12';
const MISSING_TARGET_RETRY_MS = 15 * 60_000;
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
  if (countdown) return validFutureMs(countdown[1]);
  const config = source.match(/nextDieMs\s*[:=]\s*(\d{10,16})/i);
  return config ? validFutureMs(config[1]) : 0;
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
  const tracked = Array.isArray(store.read(TRACKED_KEY)) ? store.read(TRACKED_KEY) : [];
  writeLog(store, 'Run started.', {
    build: WORKER_BUILD,
    parser: 'dom+raw-v2',
    visitId: visit.visitId,
    targets,
    tracked: tracked.length,
  });
  const remaining = [];
  let extracted = 0;

  for (const entry of tracked) {
    const id = validId(entry?.monsterId);
    if (!id) continue;
    const savedHarvestAt = validFutureMs(entry?.harvestAt);
    // v0.10.11 accidentally stored the wave card's data-expire value, which
    // belongs to dead-card retention rather than the live auto-die timer.
    // Do not trust such far-future legacy values; refresh the battle instead.
    if (savedHarvestAt > Date.now() && savedHarvestAt <= Date.now() + MAX_TRUSTED_HARVEST_DELAY_MS) {
      remaining.push({
        monsterId: id,
        targetId: String(entry.targetId || ''),
        name: String(entry.name || ''),
        harvestAt: savedHarvestAt,
      });
      writeLog(store, 'Tracked monster is still alive; extraction is scheduled.', {
        monsterId: id,
        harvestAt: savedHarvestAt,
      });
      continue;
    }
    writeLog(store, 'Checking tracked battle.', { monsterId: id, name: entry.name });
    const battle = await fetchDocument(win, `/battle.php?id=${id}`);
    if (battle.getElementById?.('extract-shadow-btn')) {
      writeLog(store, 'Dead monster is eligible for extraction.', { monsterId: id });
      const result = await extractShadow(postForm, id);
      writeLog(store, result.ok ? 'Shadow extraction succeeded.' : 'Shadow extraction failed.', {
        monsterId: id,
        message: result.message,
        shadow: result.shadow?.NAME || '',
      });
      if (result.ok) { extracted += 1; continue; }
    }
    const refreshedAutoDieAt = battleAutoDieAt(battle.__veyraHtml);
    remaining.push({
      monsterId: id,
      targetId: String(entry.targetId || ''),
      name: String(entry.name || ''),
      harvestAt: refreshedAutoDieAt > Date.now()
        ? refreshedAutoDieAt + EXTRACTION_GRACE_MS
        : Date.now() + EXTRACTION_RETRY_MS,
    });
    if (refreshedAutoDieAt) {
      writeLog(store, 'Tracked monster auto-die timer refreshed from its battle page.', {
        monsterId: id,
        autoDieAt: refreshedAutoDieAt,
        harvestAt: refreshedAutoDieAt + EXTRACTION_GRACE_MS,
      });
    }
  }

  const available = [];
  const originalHideDead = cookieValue(win.document, 'hide_dead_monsters');
  const originalDeadBossesOnly = cookieValue(win.document, 'show_dead_bosses_only');
  let aliveViewEnabled = false;
  // Gate 3's three actual pages use the global wave IDs 3, 5 and 8.
  try {
    for (const wave of [3, 5, 8]) {
      const path = () => `/active_wave.php?gate=3&wave=${wave}&veyra_scan=${Date.now()}-${wave}`;
      let page = await fetchDocument(win, path());
      let rawHtml = String(page.__veyraHtml || '');
      let cards = rawMonsterCardStats(rawHtml);

      if (!aliveViewEnabled && cards.dead > 0) {
        setViewCookie(win.document, 'hide_dead_monsters', '1');
        setViewCookie(win.document, 'show_dead_bosses_only', '0');
        aliveViewEnabled = true;
        writeLog(store, 'Dead monster view detected; switching to Show Alive Monsters.', { wave, cards });
        page = await fetchDocument(win, path());
        rawHtml = String(page.__veyraHtml || '');
        cards = rawMonsterCardStats(rawHtml);
      }

      const found = parseWaveMonsters(page);
      available.push(...found);
      writeLog(store, `Gate 3 wave ${wave} scanned.`, {
        found: found.length,
        page: page.__veyraFetchMeta,
        aliveView: aliveViewEnabled,
        rawMonsterCards: (rawHtml.match(/monster-card/gi) || []).length,
        rawMonsterIds: (rawHtml.match(/data-monster-id/gi) || []).length,
        cards,
        rawSamples: found.length === 0 ? rawMonsterIdSamples(rawHtml) : [],
        monsters: found.map((monster) => ({ id: monster.id, name: monster.name })),
      });
    }
  } finally {
    if (aliveViewEnabled) {
      restoreViewCookie(win.document, 'hide_dead_monsters', originalHideDead);
      restoreViewCookie(win.document, 'show_dead_bosses_only', originalDeadBossesOnly);
      writeLog(store, 'Previous monster view restored.');
    }
  }
  const already = new Set(remaining.map((entry) => entry.monsterId));
  const userId = validId(await getUserId?.());
  if (targets.length > 0 && !userId) throw new Error('Could not determine the user ID required to join battles.');
  let attacked = 0;
  for (const target of targets) {
    const trackedForTarget = remaining.filter((entry) => entry.targetId === target.id).length;
    const needed = Math.max(0, target.quantity - trackedForTarget);
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
      remaining.push({ monsterId: monster.id, targetId: target.id, name: target.name, harvestAt });
      writeLog(store, 'Shadow extraction scheduled from the monster auto-die timer.', {
        monsterId: monster.id,
        autoDieAt,
        harvestAt,
      });
    }
  }
  store.write(TRACKED_KEY, remaining);
  const outstanding = targets.reduce((sum, target) => {
    const trackedForTarget = remaining.filter((entry) => entry.targetId === target.id).length;
    return sum + Math.max(0, target.quantity - trackedForTarget);
  }, 0);
  const nextHarvestAt = remaining
    .map((entry) => validFutureMs(entry.harvestAt))
    .filter((timestamp) => timestamp > Date.now())
    .sort((left, right) => left - right)[0] || 0;
  const missingRetryAt = outstanding > 0 ? Date.now() + MISSING_TARGET_RETRY_MS : 0;
  const retryAt = [nextHarvestAt, missingRetryAt].filter(Boolean).sort((left, right) => left - right)[0] || 0;
  writeLog(store, 'Run finished.', { attacked, extracted, tracked: remaining.length, outstanding, retryAt });
  publishWorkerStatus(store, route.id, {
    visitId: visit.visitId,
    workerId: route.id,
    state: 'done',
    safeToLeave: true,
    message: outstanding > 0
      ? `${attacked} hit, ${outstanding} selected monsters unavailable; retrying in 15 minutes.`
      : `${attacked} hit, ${extracted} shadows extracted, ${remaining.length} tracked.`,
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
  rawMonsterIdSamples,
  rawMonsterCardStats,
  battleAutoDieAt,
  cookieValue,
  parseWaveMonsters,
  feature: Object.freeze({
    id: 'shadowcollection-worker',
    group: 'Automation',
    settings: [],
    matches(url) { return route.matchesUrl(url); },
    async run(ctx) {
      const visit = normalizeVisit(ctx.store.read(COMMAND_KEY), (taskId) => taskId === route.id);
      if (!visit || visit.phase !== 'running') return;
      publishWorkerStatus(ctx.store, route.id, {
        visitId: visit.visitId,
        workerId: route.id,
        state: 'busy',
        safeToLeave: false,
        message: 'Checking tagged Gate 3 monsters and starting today’s Slashes.',
      });
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
      }
    },
  }),
  runCollection,
});
