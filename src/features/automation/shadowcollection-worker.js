'use strict';

const { COMMAND_KEY, normalizeVisit, publishWorkerStatus } = require('../../core/protocol');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const { extractShadow } = require('../loot/loot-api');
const route = require('../../routes/shadowcollection');

const TRACKED_KEY = 'veyra:shadowcollection:tracked:v1';
const VISIT_PARAM = 'veyra_visit';

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
  const remaining = [];
  let extracted = 0;

  for (const entry of tracked) {
    const id = validId(entry?.monsterId);
    if (!id) continue;
    const battle = await fetchDocument(win, `/battle.php?id=${id}`);
    if (battle.getElementById?.('extract-shadow-btn')) {
      const result = await extractShadow(postForm, id);
      if (result.ok) { extracted += 1; continue; }
    }
    remaining.push({ monsterId: id, targetId: String(entry.targetId || ''), name: String(entry.name || '') });
  }

  const available = [];
  for (let wave = 1; wave <= 8; wave += 1) {
    const page = await fetchDocument(win, `/active_wave.php?gate=3&wave=${wave}`);
    available.push(...parseWaveMonsters(page));
  }
  const already = new Set(remaining.map((entry) => entry.monsterId));
  let attacked = 0;
  for (const target of targets) {
    const trackedForTarget = remaining.filter((entry) => entry.targetId === target.id).length;
    const needed = Math.max(0, target.quantity - trackedForTarget);
    if (needed === 0) continue;
    const matches = available.filter((monster) => !already.has(monster.id) && normalizeName(monster.name).includes(normalizeName(target.name)));
    for (const monster of matches.slice(0, needed)) {
      const joined = await postForm('user_join_battle.php', { monster_id: monster.id });
      if (!joined.ok) continue;
      const hit = await postForm('damage.php', { monster_id: monster.id, skill_id: '0', stamina_cost: '1' });
      const success = hit.ok && String(hit.json?.status || '').trim().toLowerCase() === 'success';
      if (!success) continue;
      attacked += 1;
      already.add(monster.id);
      remaining.push({ monsterId: monster.id, targetId: target.id, name: target.name });
    }
  }
  store.write(TRACKED_KEY, remaining);
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
