'use strict';

const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { extractShadow } = require('../loot/loot-api');
const route = require('../../routes/shadowcollection');

const TRACKED_KEY = 'veyra:shadowcollection:tracked:v1';
const VISIT_PARAM = 'veyra_visit';

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

function parseWaveMonsters(doc) {
  const found = [];
  const seen = new Set();
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
  return new win.DOMParser().parseFromString(text, 'text/html');
}

async function runCollection(ctx, visit) {
  const { win, store, postForm } = ctx;
  const settings = normalizeConfig(store.read(CONFIG_KEY)).routes.shadowcollection.settings;
  const targets = configuredTargets(settings);
  const tracked = Array.isArray(store.read(TRACKED_KEY)) ? store.read(TRACKED_KEY) : [];
  writeLog(store, 'Run started.', { visitId: visit.visitId, targets, tracked: tracked.length });
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
    const page = await fetchDocument(win, `/active_wave.php?gate=3&wave=${wave}`);
    const found = parseWaveMonsters(page);
    available.push(...found);
    writeLog(store, `Gate 3 wave ${wave} scanned.`, {
      found: found.length,
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
