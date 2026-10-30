'use strict';

// Pure helpers of the dungeon participation report: page parsing,
// aggregation, sorting, CSV and a small concurrency pool. Everything is null
// safe and runs in Node tests with tiny document fakes.

const { parseGameNumber } = require('../../core/numbers');

const REPORTS_KEY = 'dungeon-participation-check:reports';
const REPORT_VERSION = 2;
const MAX_STORED_REPORTS = 20;

function text(element) {
  return String(element?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function all(root, selector) {
  try {
    return [...(root?.querySelectorAll?.(selector) || [])];
  } catch {
    return [];
  }
}

function attr(element, name) {
  return element?.getAttribute?.(name) ?? null;
}

function resolveUrl(href, base) {
  if (!href || /^\s*javascript:/i.test(href)) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function searchParam(url, name) {
  try {
    return new URL(url, 'https://x.invalid/').searchParams.get(name);
  } catch {
    return null;
  }
}

// Numbers like "6,400,000,000", "1.5b" or "0.013000".
function parseAmount(value) {
  const match = String(value ?? '').match(/(\d[\d,]*(?:\.\d+)?)\s*([kmbtq])?\b/i);
  if (!match) return null;
  return parseGameNumber(`${match[1]}${match[2] || ''}`);
}

function parseDecimal(value) {
  const match = String(value ?? '').match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const number = Number(match[0].replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

// "Deal ~6,400,000,000 dmg to hit cap." → 6400000000
function parseExpCapDamage(value) {
  const match = String(value ?? '').match(/deal\s*~?\s*([\d,.]+\s*[kmbtq]?)\s*dmg/i);
  return match ? parseAmount(match[1]) : null;
}

// "DMG req: 500,000,000" → 500000000
function parseLootRequirement(value) {
  const match = String(value ?? '').match(/dmg\s*req\s*:?\s*([\d,.]+\s*[kmbtq]?)/i);
  return match ? parseAmount(match[1]) : null;
}

// ----------------------------- page parsing ----------------------------- //

// Locations come from the map pins of guild_dungeon_instance.php; locked
// pins (href="javascript:void(0)") are skipped.
function parseLocationIds(doc, instanceId = null) {
  const ids = [];
  for (const link of all(doc, 'a[href*="guild_dungeon_location.php"]')) {
    if (link.classList?.contains?.('locked')) continue;
    const href = attr(link, 'href') || '';
    const locationId = searchParam(href, 'location_id');
    const linkInstance = searchParam(href, 'instance_id');
    if (!locationId || !/^\d+$/.test(locationId)) continue;
    if (instanceId && linkInstance && linkInstance !== String(instanceId)) continue;
    if (!ids.includes(locationId)) ids.push(locationId);
  }
  return ids;
}

function readStatPill(card, label) {
  const wanted = label.toLowerCase();
  for (const pill of all(card, '.statpill')) {
    if (text(pill.querySelector?.('.k')).toLowerCase() === wanted) return text(pill.querySelector?.('.v'));
  }
  return null;
}

// Monster cards of guild_dungeon_location.php → [{ monsterId, url, expPerDamage }].
function parseLocationMonsters(doc, baseUrl) {
  const monsters = [];
  for (const card of all(doc, '.mon')) {
    const link = all(card, 'a[href*="battle.php"]')[0] || card.querySelector?.('.btn[href]');
    const url = resolveUrl(attr(link, 'href'), baseUrl);
    if (!url) continue;
    const monsterId = searchParam(url, 'dgmid');
    if (!monsterId) continue;
    monsters.push({ monsterId, url, expPerDamage: parseDecimal(readStatPill(card, 'EXP/dmg')) });
  }
  return monsters;
}

function readStatBlock(doc, label) {
  const wanted = label.toLowerCase().replace(/\s+/g, '');
  return (
    all(doc, '.stat-block').find(
      (block) => text(block.querySelector?.('.label')).toLowerCase().replace(/\s+/g, '') === wanted,
    ) || null
  );
}

function parseLeaderboard(doc) {
  const rows = [];
  for (const row of all(doc, '.lb-list .lb-row')) {
    const link = row.querySelector?.('.lb-name a');
    const pid = searchParam(attr(link, 'href') || '', 'pid');
    if (!pid) continue;
    rows.push({
      pid,
      name: text(link) || `#${pid}`,
      avatar: attr(row.querySelector?.('.lb-avatar'), 'src') || '',
      damage: parseAmount(text(row.querySelector?.('.lb-dmg'))) ?? 0,
    });
  }
  return rows;
}

// Reads what the battle page tells about caps:
//   expCapDamage   "Deal ~N dmg to hit cap" under "EXP Cap"
//   expPerDamage   "EXP / DMG"
//   lootRequirement highest "DMG req" chip under Possible Loot
function parseBattleInfo(doc) {
  const capBlock = readStatBlock(doc, 'EXP Cap');
  const expBlock = readStatBlock(doc, 'EXP / DMG');
  const hpBlock = readStatBlock(doc, 'Monster HP');
  let lootRequirement = null;
  for (const chip of all(doc, '.loot-card .chip, .loot-stats .chip')) {
    const requirement = parseLootRequirement(text(chip));
    if (requirement !== null && (lootRequirement === null || requirement > lootRequirement)) {
      lootRequirement = requirement;
    }
  }
  return {
    expCapDamage: parseExpCapDamage(text(capBlock)),
    expPerDamage: parseDecimal(text(expBlock?.querySelector?.('strong'))),
    maxHp: parseAmount(text(hpBlock?.querySelector?.('strong'))),
    lootRequirement,
    leaderboard: parseLeaderboard(doc),
  };
}

// ------------------------------ aggregation ----------------------------- //

// monsters: [{ monsterId, monsterName, url, expCapDamage, expPerDamage,
//              lootRequirement, leaderboard: [{ pid, name, avatar, damage }] }]
function aggregateParticipation(monsters) {
  const players = new Map();
  const available = { exp: false, expCap: false, loot: false };

  for (const monster of monsters || []) {
    if (!monster) continue;
    const expCap = positive(monster.expCapDamage);
    const expRate = positive(monster.expPerDamage);
    const loot = positive(monster.lootRequirement);
    if (expRate !== null) available.exp = true;
    if (expCap !== null) available.expCap = true;
    if (loot !== null) available.loot = true;

    for (const entry of monster.leaderboard || []) {
      if (!entry?.pid) continue;
      const damage = Math.max(0, Number(entry.damage) || 0);
      let player = players.get(entry.pid);
      if (!player) {
        player = {
          pid: String(entry.pid),
          name: String(entry.name || `#${entry.pid}`),
          avatar: String(entry.avatar || ''),
          totalDamage: 0,
          totalExp: 0,
          monstersDamaged: 0,
          damageOverExpCap: 0,
          damageOverLootReq: 0,
          wastedDamage: 0,
          overLootMonsters: [],
        };
        players.set(entry.pid, player);
      }
      player.totalDamage += damage;
      player.monstersDamaged += 1;
      if (expRate !== null) player.totalExp += Math.min(damage, expCap ?? damage) * expRate;
      if (expCap !== null) player.damageOverExpCap += Math.max(0, damage - expCap);
      if (loot !== null) {
        const overLoot = Math.max(0, damage - loot);
        player.damageOverLootReq += overLoot;
        if (overLoot > 0) {
          player.overLootMonsters.push({
            monsterId: monster.monsterId ?? null,
            monsterName: monster.monsterName || 'Unknown monster',
            url: monster.url || '',
            damage,
            lootRequirement: loot,
          });
        }
      }
      // Damage that earns neither EXP nor loot.
      if (expCap !== null || loot !== null) {
        const useful = Math.max(expCap ?? 0, loot ?? 0);
        player.wastedDamage += Math.max(0, damage - useful);
      }
    }
  }

  const list = [...players.values()].map((player) => ({ ...player, totalExp: Math.round(player.totalExp) }));
  return { players: sortPlayers(list, 'totalDamage', 'desc'), available };
}

function positive(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number > 0 ? number : null;
}

// ------------------------------- columns -------------------------------- //

const COLUMNS = Object.freeze([
  { key: 'name', label: 'Player', csv: 'name', type: 'string' },
  { key: 'monstersDamaged', label: 'Mobs hit', csv: 'monstersDamaged', type: 'number' },
  { key: 'totalDamage', label: 'Total damage', csv: 'totalDamage', type: 'number' },
  { key: 'totalExp', label: 'Total EXP', csv: 'totalExp', type: 'number', requires: 'exp' },
  { key: 'damageOverExpCap', label: 'Over EXP cap', csv: 'damageOverExpCap', type: 'number', requires: 'expCap' },
  { key: 'damageOverLootReq', label: 'Over loot req', csv: 'damageOverLootReq', type: 'number', requires: 'loot' },
  { key: 'overLootCount', label: 'Mobs over loot req', csv: 'monstersOverLootReq', type: 'number', requires: 'loot' },
  { key: 'wastedDamage', label: 'Wasted damage', csv: 'wastedDamage', type: 'number', requires: 'any' },
]);

function visibleColumns(available = {}) {
  return COLUMNS.filter((column) => {
    if (!column.requires) return true;
    if (column.requires === 'any') return Boolean(available.expCap || available.loot);
    return Boolean(available[column.requires]);
  });
}

function columnValue(player, key) {
  if (key === 'overLootCount') return player?.overLootMonsters?.length || 0;
  return player?.[key];
}

function sortPlayers(players, key = 'totalDamage', direction = 'desc') {
  const factor = direction === 'asc' ? 1 : -1;
  return [...(players || [])].sort((a, b) => {
    const left = columnValue(a, key);
    const right = columnValue(b, key);
    let result;
    if (typeof left === 'number' || typeof right === 'number') {
      result = (Number(left) || 0) - (Number(right) || 0);
    } else {
      result = String(left ?? '').localeCompare(String(right ?? ''), 'en', { sensitivity: 'base' });
    }
    if (result !== 0) return result * factor;
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'en', { sensitivity: 'base' });
  });
}

// --------------------------------- CSV ---------------------------------- //

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Keep spreadsheet apps from evaluating player names as formulas.
  if (/^[=+\-@\t\r]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildCsv(report) {
  const columns = visibleColumns(report?.available);
  const header = ['pid', ...columns.map((column) => column.csv)];
  const rows = [header];
  for (const player of report?.players || []) {
    rows.push([player.pid, ...columns.map((column) => columnValue(player, column.key))]);
  }
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n');
}

// ------------------------------ persistence ----------------------------- //

// Accepts the current format and veyra-hud's (a bare player array).
function normalizeReport(raw) {
  if (Array.isArray(raw)) {
    const players = raw.filter(Boolean).map((player) => ({
      pid: String(player.pid ?? ''),
      name: String(player.name ?? ''),
      avatar: String(player.avatar ?? ''),
      totalDamage: Number(player.totalDamage) || 0,
      totalExp: Math.round(Number(player.totalExp) || 0),
      monstersDamaged: Number(player.monstersDamaged) || 0,
      damageOverExpCap: Number(player.damageOverExpCap) || 0,
      damageOverLootReq: 0,
      // Without loot data the wasted damage is the damage over the EXP cap.
      wastedDamage: Number(player.damageOverExpCap) || 0,
      overLootMonsters: [],
    }));
    return {
      version: 1,
      generatedAt: null,
      monsterCount: null,
      failedCount: 0,
      available: { exp: true, expCap: true, loot: false },
      players,
    };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return null;
  return {
    version: Number(raw.version) || REPORT_VERSION,
    generatedAt: Number(raw.generatedAt) || null,
    monsterCount: Number.isFinite(Number(raw.monsterCount)) ? Number(raw.monsterCount) : null,
    failedCount: Number(raw.failedCount) || 0,
    available: { exp: false, expCap: false, loot: false, ...(raw.available || {}) },
    players: raw.players.filter(Boolean).map((player) => ({
      ...player,
      overLootMonsters: Array.isArray(player.overLootMonsters) ? player.overLootMonsters : [],
    })),
  };
}

// Stores one report and drops the oldest ones beyond MAX_STORED_REPORTS.
function upsertReport(reports, instanceId, report, max = MAX_STORED_REPORTS) {
  const next = { ...(reports && typeof reports === 'object' && !Array.isArray(reports) ? reports : {}) };
  next[String(instanceId)] = report;
  const ids = Object.keys(next);
  if (ids.length > max) {
    const age = (id) => Number(next[id]?.generatedAt) || 0;
    ids
      .filter((id) => id !== String(instanceId))
      .sort((a, b) => age(a) - age(b))
      .slice(0, ids.length - max)
      .forEach((id) => delete next[id]);
  }
  return next;
}

// ------------------------------ concurrency ----------------------------- //

// Like Promise.allSettled(items.map(worker)) but with at most `limit` workers
// running at once.
async function mapWithConcurrency(items, limit, worker, onSettled = null) {
  const list = [...(items || [])];
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      done += 1;
      onSettled?.(done, list.length);
    }
  };
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length));
  await Promise.all(Array.from({ length: list.length ? size : 0 }, run));
  return results;
}

module.exports = {
  COLUMNS,
  MAX_STORED_REPORTS,
  REPORTS_KEY,
  REPORT_VERSION,
  aggregateParticipation,
  buildCsv,
  columnValue,
  escapeCsv,
  mapWithConcurrency,
  normalizeReport,
  parseBattleInfo,
  parseExpCapDamage,
  parseLeaderboard,
  parseLocationIds,
  parseLocationMonsters,
  parseLootRequirement,
  sortPlayers,
  upsertReport,
  visibleColumns,
};
