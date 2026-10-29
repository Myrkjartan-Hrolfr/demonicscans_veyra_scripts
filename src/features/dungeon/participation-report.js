'use strict';

// From veyra-hud dungeon-participation-check: builds a per-player report of
// a guild dungeon instance from every monster's attackers leaderboard.
//
// Differences to veyra-hud:
// - Locations are read from the instance map pins (not hard-coded 1–4).
// - Battle pages are fetched with at most FETCH_CONCURRENCY requests at once.
// - EXP cap, EXP/DMG and the loot "DMG req" come from each battle page
//   instead of an outdated, event-specific MONSTER_CONFIG; columns whose data
//   is unavailable are hidden.
// - Own sortable, mobile-friendly table (no Tabulator / CDN) and no page
//   reload after generating. CSV export kept.

const { getMonsterNameFromBattlePage, isCloudflareError } = require('../../core/game');
const { formatGameNumber } = require('../../core/numbers');
const helpers = require('./participation-helpers');

const SETTING_KEY = 'veyra:dungeon:participationReport';
const STYLE_ID = 'veyra-dungeon-participation-style';
const PANEL_ID = 'veyra-dungeon-participation-panel';
const FETCH_CONCURRENCY = 4;

const CSS = `
  #${PANEL_ID} { margin-bottom: 55px; }
  #${PANEL_ID} .vdp-meta { font-size: 12px; opacity: .75; margin: 4px 0 10px; }
  #${PANEL_ID} .vdp-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  #${PANEL_ID} .vdp-filter { flex: 1 1 180px; min-width: 0; max-width: 320px; padding: 6px 10px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,.15); background: rgba(0,0,0,.25); color: inherit; font: inherit; }
  #${PANEL_ID} .vdp-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.08); }
  #${PANEL_ID} table { width: 100%; border-collapse: collapse; font-size: 13px; }
  #${PANEL_ID} th, #${PANEL_ID} td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.07); white-space: nowrap; }
  #${PANEL_ID} th { position: sticky; top: 0; background: #1a1d2e; text-align: right; }
  #${PANEL_ID} th:first-child, #${PANEL_ID} td:first-child { text-align: left; position: sticky; left: 0; background: #151827; z-index: 1; }
  #${PANEL_ID} th:first-child { z-index: 2; background: #1a1d2e; }
  #${PANEL_ID} td { text-align: right; font-variant-numeric: tabular-nums; }
  #${PANEL_ID} th button { all: unset; cursor: pointer; font-weight: 700; }
  #${PANEL_ID} th button:focus-visible { outline: 2px solid #4db3ff; }
  #${PANEL_ID} th[aria-sort="ascending"] button::after { content: " ▲"; }
  #${PANEL_ID} th[aria-sort="descending"] button::after { content: " ▼"; }
  #${PANEL_ID} .vdp-player { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; max-width: 220px; }
  #${PANEL_ID} .vdp-player span { overflow: hidden; text-overflow: ellipsis; }
  #${PANEL_ID} .vdp-player img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex: none; }
  #${PANEL_ID} .vdp-toggle { all: unset; cursor: pointer; text-decoration: underline dotted; }
  #${PANEL_ID} .vdp-detail td { text-align: left; white-space: normal; background: rgba(0,0,0,.2); }
  #${PANEL_ID} .vdp-detail a { display: block; color: #4db3ff; text-decoration: none; margin: 2px 0; }
  #${PANEL_ID} .vdp-warn { color: #f5b041; }
  .vdp-btn[disabled] { opacity: .55; pointer-events: none; }
  @media (max-width: 600px) {
    #${PANEL_ID} table { font-size: 12px; }
    #${PANEL_ID} th, #${PANEL_ID} td { padding: 5px 6px; }
    #${PANEL_ID} .vdp-player { max-width: 130px; }
    #${PANEL_ID} .vdp-player img { width: 22px; height: 22px; }
  }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function el(doc, tag, props = {}, children = []) {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') element.textContent = value;
    else if (key === 'className') element.className = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

function readReports(store) {
  const raw = store?.read?.(helpers.REPORTS_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function getInstanceId(url, doc) {
  const fromUrl = url.searchParams.get('id') || url.searchParams.get('instance_id');
  if (fromUrl && /^\d+$/.test(fromUrl)) return fromUrl;
  const pin = doc.querySelector('a[href*="guild_dungeon_location.php"][href*="instance_id="]');
  const match = (pin?.getAttribute('href') || '').match(/instance_id=(\d+)/);
  return match ? match[1] : null;
}

function formatCell(column, player) {
  const value = helpers.columnValue(player, column.key);
  if (column.type !== 'number') return String(value ?? '');
  const number = Number(value) || 0;
  return number >= 1e6 ? formatGameNumber(number) : Math.round(number).toLocaleString('en-US');
}

function downloadCsv(doc, win, csv, filename) {
  const BlobImpl = win.Blob || Blob;
  const URLImpl = win.URL || URL;
  const blob = new BlobImpl([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const href = URLImpl.createObjectURL(blob);
  const link = el(doc, 'a', { href, download: filename });
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  win.setTimeout(() => URLImpl.revokeObjectURL(href), 1_000);
}

function renderReport(ctx, report) {
  const { doc } = ctx;
  ensureStyle(doc);
  doc.getElementById(PANEL_ID)?.remove();
  if (!report) return;

  const columns = helpers.visibleColumns(report.available);
  const state = { key: 'totalDamage', direction: 'desc', filter: '', expanded: new Set() };

  const metaParts = [];
  if (report.generatedAt) metaParts.push(`Generated ${new Date(report.generatedAt).toLocaleString()}`);
  if (report.monsterCount !== null) metaParts.push(`${report.monsterCount} monsters scanned`);
  metaParts.push(`${report.players.length} players`);
  if (report.version === 1) metaParts.push('legacy veyra-hud report – generate again for loot data');

  const meta = el(doc, 'div', { className: 'vdp-meta', text: metaParts.join(' · ') });
  if (report.failedCount > 0) {
    meta.append(' · ', el(doc, 'span', { className: 'vdp-warn', text: `${report.failedCount} pages failed to load` }));
  }

  const filter = el(doc, 'input', { type: 'search', className: 'vdp-filter', placeholder: 'Filter players…', 'aria-label': 'Filter players' });
  const tbody = el(doc, 'tbody');
  const headRow = el(doc, 'tr');
  const headers = columns.map((column) => {
    const button = el(doc, 'button', { type: 'button', text: column.label });
    const th = el(doc, 'th', { scope: 'col' }, [button]);
    button.addEventListener('click', () => {
      if (state.key === column.key) state.direction = state.direction === 'asc' ? 'desc' : 'asc';
      else {
        state.key = column.key;
        state.direction = column.type === 'string' ? 'asc' : 'desc';
      }
      renderBody();
    });
    headRow.appendChild(th);
    return { column, th };
  });

  function renderBody() {
    for (const { column, th } of headers) {
      if (column.key === state.key) th.setAttribute('aria-sort', state.direction === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }
    const needle = state.filter.trim().toLowerCase();
    const players = helpers
      .sortPlayers(report.players, state.key, state.direction)
      .filter((player) => !needle || String(player.name).toLowerCase().includes(needle));

    const rows = [];
    for (const player of players) {
      const tr = el(doc, 'tr');
      for (const column of columns) {
        const td = el(doc, 'td');
        if (column.key === 'name') {
          const avatar = player.avatar ? new URL(player.avatar, ctx.url.origin).href : null;
          const link = el(doc, 'a', {
            className: 'vdp-player',
            href: `/player.php?pid=${encodeURIComponent(player.pid)}`,
            target: '_blank',
            rel: 'noopener',
            title: player.name,
          });
          if (avatar) link.appendChild(el(doc, 'img', { src: avatar, alt: '', loading: 'lazy' }));
          link.appendChild(el(doc, 'span', { text: player.name }));
          td.appendChild(link);
        } else if (column.key === 'overLootCount' && player.overLootMonsters.length > 0) {
          const toggle = el(doc, 'button', {
            type: 'button',
            className: 'vdp-toggle',
            text: String(player.overLootMonsters.length),
            'aria-expanded': String(state.expanded.has(player.pid)),
            title: 'Show monsters',
          });
          toggle.addEventListener('click', () => {
            if (state.expanded.has(player.pid)) state.expanded.delete(player.pid);
            else state.expanded.add(player.pid);
            renderBody();
          });
          td.appendChild(toggle);
        } else {
          td.textContent = formatCell(column, player);
          if (column.type === 'number') td.title = Math.round(Number(helpers.columnValue(player, column.key)) || 0).toLocaleString('en-US');
        }
        tr.appendChild(td);
      }
      rows.push(tr);

      if (state.expanded.has(player.pid) && player.overLootMonsters.length > 0) {
        const cell = el(doc, 'td', { colspan: String(columns.length) });
        for (const monster of player.overLootMonsters) {
          cell.appendChild(
            el(doc, 'a', {
              href: monster.url || '#',
              target: '_blank',
              rel: 'noopener',
              text: `${monster.monsterName}: ${Math.round(monster.damage).toLocaleString('en-US')} dmg (loot req ${Math.round(monster.lootRequirement).toLocaleString('en-US')})`,
            }),
          );
        }
        rows.push(el(doc, 'tr', { className: 'vdp-detail' }, [cell]));
      }
    }
    if (rows.length === 0) {
      rows.push(el(doc, 'tr', {}, [el(doc, 'td', { colspan: String(columns.length), text: 'No players.' })]));
    }
    tbody.replaceChildren(...rows);
  }

  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderBody();
  });

  const table = el(doc, 'table', {}, [el(doc, 'thead', {}, [headRow]), tbody]);
  const panel = el(doc, 'div', { id: PANEL_ID, className: 'panel' }, [
    el(doc, 'div', { className: 'h', text: '📝 Dungeon participation report' }),
    meta,
    el(doc, 'div', { className: 'vdp-tools' }, [filter]),
    el(doc, 'div', { className: 'vdp-scroll' }, [table]),
  ]);
  renderBody();

  const wrap = doc.querySelector('.wrap') || doc.body;
  wrap.appendChild(panel);
}

async function generateReport(ctx, instanceId, onProgress) {
  const base = ctx.url.href;
  const locationIds = helpers.parseLocationIds(ctx.doc, instanceId);
  if (locationIds.length === 0) throw new Error('No unlocked dungeon locations found on this page.');

  let failedCount = 0;
  const monstersById = new Map();
  onProgress(`Reading ${locationIds.length} locations…`);
  const locationResults = await helpers.mapWithConcurrency(locationIds, FETCH_CONCURRENCY, async (locationId) => {
    const url = new URL(
      `/guild_dungeon_location.php?instance_id=${encodeURIComponent(instanceId)}&location_id=${encodeURIComponent(locationId)}`,
      base,
    ).href;
    const doc = await ctx.fetchDocument(url);
    if (isCloudflareError(doc)) throw new Error('Rate limited');
    return helpers.parseLocationMonsters(doc, url);
  });
  for (const result of locationResults) {
    if (result.status !== 'fulfilled') {
      failedCount += 1;
      continue;
    }
    for (const monster of result.value) {
      if (!monstersById.has(monster.monsterId)) monstersById.set(monster.monsterId, monster);
    }
  }

  const monsters = [...monstersById.values()];
  onProgress(`Reading monsters 0/${monsters.length}…`);
  const battleResults = await helpers.mapWithConcurrency(
    monsters,
    FETCH_CONCURRENCY,
    async (monster) => {
      const doc = await ctx.fetchDocument(monster.url);
      if (isCloudflareError(doc)) throw new Error('Rate limited');
      const info = helpers.parseBattleInfo(doc);
      return {
        monsterId: monster.monsterId,
        monsterName: getMonsterNameFromBattlePage(doc) || `Monster #${monster.monsterId}`,
        url: monster.url,
        expCapDamage: info.expCapDamage,
        expPerDamage: info.expPerDamage ?? monster.expPerDamage,
        lootRequirement: info.lootRequirement,
        leaderboard: info.leaderboard,
      };
    },
    (done, total) => onProgress(`Reading monsters ${done}/${total}…`),
  );

  const scanned = [];
  for (const result of battleResults) {
    if (result.status === 'fulfilled') scanned.push(result.value);
    else failedCount += 1;
  }

  const { players, available } = helpers.aggregateParticipation(scanned);
  return {
    version: helpers.REPORT_VERSION,
    generatedAt: Date.now(),
    monsterCount: scanned.length,
    failedCount,
    available,
    players,
  };
}

function injectButtons(ctx, instanceId) {
  const { doc, win } = ctx;
  if (doc.getElementById('veyra-dungeon-report-btn')) return;
  ensureStyle(doc);

  const generate = el(doc, 'button', { type: 'button', id: 'veyra-dungeon-report-btn', className: 'btn vdp-btn', text: '✨ Generate report' });
  const exportBtn = el(doc, 'button', { type: 'button', id: 'veyra-dungeon-export-btn', className: 'btn vdp-btn', text: '⬇ Export CSV' });

  const currentReport = () => helpers.normalizeReport(readReports(ctx.store)[instanceId]);
  const syncExport = () => {
    if (currentReport()) exportBtn.removeAttribute('disabled');
    else exportBtn.setAttribute('disabled', 'true');
  };
  syncExport();

  let running = false;
  generate.addEventListener('click', async () => {
    if (running) return;
    running = true;
    generate.setAttribute('disabled', 'true');
    exportBtn.setAttribute('disabled', 'true');
    try {
      const report = await generateReport(ctx, instanceId, (message) => {
        generate.textContent = `⏳ ${message}`;
      });
      const saved = ctx.store?.write?.(helpers.REPORTS_KEY, helpers.upsertReport(readReports(ctx.store), instanceId, report));
      if (saved === false) ctx.notify('Report generated but could not be saved (storage full?).', 'error');
      renderReport(ctx, report);
      ctx.notify(
        report.failedCount > 0
          ? `Report ready – ${report.failedCount} pages failed to load.`
          : `Report ready – ${report.players.length} players.`,
        report.failedCount > 0 ? 'error' : 'success',
      );
      doc.getElementById(PANEL_ID)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      ctx.warn('Report failed.', error);
      ctx.notify(`Report failed: ${error?.message || error}`, 'error');
    } finally {
      running = false;
      generate.textContent = '✨ Generate report';
      generate.removeAttribute('disabled');
      syncExport();
    }
  });

  exportBtn.addEventListener('click', () => {
    const report = currentReport();
    if (!report) return;
    downloadCsv(doc, win, helpers.buildCsv(report), `dungeon_${instanceId}_participation.csv`);
  });

  // Header button row: <div class="wrap"><div class="row"> … <div class="row">Back, Info…
  const row = doc.querySelector('.wrap > .row > .row') || doc.querySelector('.row > .row');
  if (row) {
    const back = row.querySelector('a[href*="guild_dungeon.php"]');
    if (back) back.after(generate, exportBtn);
    else row.prepend(generate, exportBtn);
  } else {
    const wrap = doc.querySelector('.wrap') || doc.body;
    wrap.prepend(el(doc, 'div', { className: 'row' }, [generate, exportBtn]));
  }
}

module.exports = Object.freeze({
  id: 'dungeon-participation-report',
  group: 'Dungeon',
  settings: [
    {
      key: SETTING_KEY,
      label: 'Dungeon participation report',
      type: 'checkbox',
      default: true,
      hint: 'Adds "Generate report" and "Export CSV" to guild dungeon instances (damage, EXP and loot caps per player).',
    },
  ],
  enabledBy: SETTING_KEY,

  matches(url) {
    return /\/guild_dungeon_instance\.php$/i.test(url.pathname);
  },

  run(ctx) {
    const instanceId = getInstanceId(ctx.url, ctx.doc);
    if (!instanceId) return;
    injectButtons(ctx, instanceId);
    const report = helpers.normalizeReport(readReports(ctx.store)[instanceId]);
    if (report) renderReport(ctx, report);
  },
});
