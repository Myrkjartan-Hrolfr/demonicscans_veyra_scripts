'use strict';

const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { extractShadow } = require('../loot/loot-api');
const route = require('../../routes/shadowcollection');

const TRACKED_KEY = 'veyra:shadowcollection:tracked:v1';
const VISIT_PARAM = 'veyra_visit';
const WORKER_BUILD = '0.10.7';

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
    found.push({ id, name, href: `/battle.php?id=${id}` });
  }
  for (const match of source.matchAll(/<div\b[^>]*class=["'][^"']*auto-summon-card[^"']*["'][^>]*>[\s\S]{0,8000}?class=["'][^"']*auto-summon-name[^"']*["'][^>]*>([^<]+)<[\s\S]{0,8000}?href=["'][^"']*battle\.php\?id=(\d+)[^"']*["']/gi)) {
    const id = validId(match[2]);
    const name = String(match[1] || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    found.push({ id, name, href: `/battle.php?id=${id}` });
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
    found.push({ id, name, href: link?.getAttribute?.('href') || `/battle.php?id=${id}` });
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
    found.push({ id, name: text, href: url.pathname + url.search });
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
  const { win, store, postForm } = ctx;
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
    remaining.push({ monsterId: id, targetId: String(entry.targetId || ''), name: String(entry.name || '') });
  }

  const available = [];
  for (let wave = 1; wave <= 8; wave += 1) {
    // These pages are highly dynamic. A unique query parameter also protects
    // against intermediary caches that disregard fetch's no-store option.
    const page = await fetchDocument(win, `/active_wave.php?gate=3&wave=${wave}&veyra_scan=${Date.now()}-${wave}`);
    const found = parseWaveMonsters(page);
    const rawHtml = String(page.__veyraHtml || '');
    available.push(...found);
    writeLog(store, `Gate 3 wave ${wave} scanned.`, {
      found: found.length,
      page: page.__veyraFetchMeta,
      rawMonsterCards: (rawHtml.match(/monster-card/gi) || []).length,
      rawMonsterIds: (rawHtml.match(/data-monster-id/gi) || []).length,
      rawSamples: found.length === 0 ? rawMonsterIdSamples(rawHtml) : [],
      monsters: found.map((monster) => ({ id: monster.id, name: monster.name })),
    });
  }
  const already = new Set(remaining.map((entry) => entry.monsterId));
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
      const joined = await postForm('user_join_battle.php', { monster_id: monster.id });
      writeLog(store, 'Join request finished.', { monsterId: monster.id, ok: joined.ok, status: joined.status, response: joined.json });
      if (!joined.ok) continue;
      const hit = await postForm('damage.php', { monster_id: monster.id, skill_id: '0', stamina_cost: '1' });
      const success = hit.ok && String(hit.json?.status || '').trim().toLowerCase() === 'success';
      writeLog(store, 'Slash request finished.', { monsterId: monster.id, ok: hit.ok, status: hit.status, gameStatus: hit.json?.status, message: hit.json?.message });
      if (!success) continue;
      attacked += 1;
      already.add(monster.id);
      remaining.push({ monsterId: monster.id, targetId: target.id, name: target.name });
    }
  }
  store.write(TRACKED_KEY, remaining);
  writeLog(store, 'Run finished.', { attacked, extracted, tracked: remaining.length });
  publishWorkerStatus(store, route.id, {
    visitId: visit.visitId,
    workerId: route.id,
    state: 'done',
    safeToLeave: true,
    message: `${attacked} hit, ${extracted} shadows extracted, ${remaining.length} tracked.`,
  });
}

module.exports = Object.freeze({
  TRACKED_KEY,
  configuredTargets,
  parseRawWaveMonsters,
  rawMonsterIdSamples,
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
