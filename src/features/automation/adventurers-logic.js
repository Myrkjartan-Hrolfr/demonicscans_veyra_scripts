'use strict';

const { parseGameNumber } = require('../../core/numbers');

const WAVE_PATH = '/active_wave.php?gate=5&wave=9';
const DEAD_PAGE_SIZE = 200;

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function validId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : '';
}

function parseQuestRequirement(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const countMatch = source.match(/\b(?:kill|loot)\s+(\d+)\s+monster(?:\(s\)|s)?\b/i);
  const targetMatch = source.match(/\bMonster\s*:\s*(.+?)\s*[·|]\s*min\s*([\d.,]+\s*[kmbtq]?)\s*(?:dmg|damage)\b/i);
  if (!countMatch || !targetMatch) return null;
  const count = Number.parseInt(countMatch[1], 10);
  const minDamage = parseGameNumber(targetMatch[2].replace(/\s+/g, ''));
  const name = String(targetMatch[1] || '').trim();
  if (!name || !Number.isFinite(count) || count <= 0 || minDamage === null || minDamage < 0) return null;
  return { name, normalizedName: normalizeName(name), count, minDamage };
}

function actionId(row, action) {
  const pattern = new RegExp(`${action}\\s*\\(\\s*['\"]?(\\d+)`, 'i');
  for (const element of row?.querySelectorAll?.('[onclick]') || []) {
    const match = String(element.getAttribute?.('onclick') || '').match(pattern);
    if (match) return { id: validId(match[1]), element };
  }
  return { id: '', element: null };
}

function progressFromText(text, fallbackTotal = 0) {
  const match = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return { current: 0, total: fallbackTotal };
  return {
    current: Math.max(0, Number.parseInt(match[1], 10) || 0),
    total: Math.max(0, Number.parseInt(match[2], 10) || fallbackTotal),
  };
}

function parseQuests(root, nowMs = Date.now()) {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const quests = [];
  for (const row of root?.querySelectorAll?.('.quest-row') || []) {
    const requirement = parseQuestRequirement(row.querySelector?.('.quest-req-text')?.textContent);
    if (!requirement) continue;
    const accept = actionId(row, 'acceptQuest');
    const finish = actionId(row, 'finishQuest');
    const giveUp = actionId(row, 'giveUpQuest');
    const cooldownNode = row.querySelector?.('.quest-cooldown-timer[data-cooldown-ts]');
    const cooldownAt = Math.max(0, Number(cooldownNode?.getAttribute?.('data-cooldown-ts') || 0) * 1_000);
    const progress = progressFromText(row.querySelector?.('.quest-progress')?.textContent, requirement.count);
    const activeId = finish.id || giveUp.id;
    let state = 'unavailable';
    if (activeId) state = 'active';
    else if (cooldownAt > nowSeconds * 1_000) state = 'cooldown';
    else if (accept.id) state = 'available';
    quests.push({
      id: activeId || accept.id,
      title: String(row.querySelector?.('.quest-main-title')?.textContent || requirement.name).trim(),
      requirement,
      state,
      cooldownAt,
      progress,
      finishReady: Boolean(finish.id && finish.element?.disabled !== true),
    });
  }
  return quests;
}

function actionableQuests(quests) {
  return (quests || []).filter((quest) => quest.state === 'active' || quest.state === 'available');
}

function aggregateRequirements(requirements) {
  const merged = new Map();
  for (const requirement of requirements || []) {
    if (!requirement?.normalizedName) continue;
    const current = merged.get(requirement.normalizedName);
    if (!current) {
      merged.set(requirement.normalizedName, { ...requirement });
      continue;
    }
    current.count += requirement.count;
    current.minDamage = Math.max(current.minDamage, requirement.minDamage);
  }
  return [...merged.values()];
}

function earliestCooldown(quests, nowMs = Date.now()) {
  const values = (quests || [])
    .map((quest) => Number(quest?.cooldownAt) || 0)
    .filter((value) => value > nowMs);
  return values.length ? Math.min(...values) : 0;
}

function deadMonsterFromCard(card, nowMs = Date.now()) {
  const data = card?.dataset || {};
  const id = validId(data.monsterId);
  const name = normalizeName(data.name);
  const damage = Number(String(data.userdmg ?? '').replace(/[^\d]/g, '')) || 0;
  const expiresAt = Math.max(0, Number(data.expire || 0) * 1_000);
  if (!id || !name || data.dead !== '1' || data.eligible !== '1') return null;
  if (expiresAt > 0 && expiresAt <= nowMs) return null;
  return { id, name, damage, expiresAt };
}

function readDeadMonsters(root, nowMs = Date.now()) {
  const monsters = [];
  for (const card of root?.querySelectorAll?.('.monster-card[data-dead="1"]') || []) {
    const monster = deadMonsterFromCard(card, nowMs);
    if (monster) monsters.push(monster);
  }
  return monsters;
}

function eligibleForRequirement(monsters, requirement) {
  if (!requirement) return [];
  return (monsters || []).filter(
    (monster) => monster.name === requirement.normalizedName && monster.damage >= requirement.minDamage,
  );
}

function requirementCounts(requirements, monsters) {
  return (requirements || []).map((requirement) => ({
    requirement,
    count: eligibleForRequirement(monsters, requirement).length,
  }));
}

function requirementsSatisfied(requirements, monsters) {
  return requirementCounts(requirements, monsters).every(({ requirement, count }) => count >= requirement.count);
}

function selectedOption(select) {
  if (!select) return null;
  const options = [...(select.querySelectorAll?.('option') || [])];
  return options.find((option) => String(option.value) === String(select.value)) || options.find((option) => option.selected) || null;
}

function readAutoFarmTargets(root) {
  const targets = [];
  for (const row of root?.querySelectorAll?.('.af-row[data-target-id]') || []) {
    const select = row.querySelector?.('.afTMonster');
    const option = selectedOption(select);
    const targetId = validId(row.getAttribute?.('data-target-id') || row.dataset?.targetId);
    const monsterId = validId(select?.value || option?.value);
    const name = String(option?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!targetId || !monsterId || !name) continue;
    targets.push({
      targetId,
      monsterId,
      name,
      normalizedName: normalizeName(name),
      enabled: String(row.querySelector?.('.afTEnabled')?.value ?? '0') === '1',
      mode: String(row.querySelector?.('.afTMode')?.value ?? '0'),
      minDamage: Math.max(0, Number(row.querySelector?.('.afTMin')?.value) || 0),
      maxStack: Math.min(250, Math.max(1, Number(row.querySelector?.('.afTStack')?.value) || 1)),
    });
  }
  return targets;
}

function readMonsterOptions(root) {
  const options = new Map();
  for (const option of root?.querySelectorAll?.('.afTMonster option, #afAddMonster option') || []) {
    const id = validId(option.value);
    const name = String(option.textContent || '').replace(/\s+/g, ' ').trim();
    const key = normalizeName(name);
    if (id && key && !options.has(key)) options.set(key, { id, name });
  }
  return options;
}

function readInputValue(root, selector, fallback = '0') {
  const value = root?.querySelector?.(selector)?.value;
  return value === undefined || value === null ? String(fallback) : String(value);
}

function readAutoFarmSettings(root) {
  return {
    TOTAL_MONSTERS_TO_KILL: readInputValue(root, '#afTotalToKill'),
    HP_POTIONS_MAX_TO_USE: readInputValue(root, '#afHpMax'),
    STAM_POT_SMALL_ITEM_MAX_TO_USE: readInputValue(root, '#afSt20Max'),
    STAM_POT_HALF_ITEM_ID_MAX_TO_USE: readInputValue(root, '#afStHalfMax'),
    STAM_POT_FULL_ITEM_ID_MAX_TO_USE: readInputValue(root, '#afStFullMax'),
    STAM_POT_ADV_ITEM_MAX_TO_USE: readInputValue(root, '#afStAdvMax'),
    STAM_POT_PRIORITY_ITEM_ID: readInputValue(root, '#afStPriority'),
    AUTO_LOOT_TO_LEVEL: readInputValue(root, '#afAutoLootToLevel'),
    PRC_EXP_LEFT: readInputValue(root, '#afPrcExpLeft', '100'),
  };
}

function autoFarmIsActive(root) {
  const badge = root?.querySelector?.('#afStateBadge');
  const text = String(badge?.textContent || '').trim();
  return /\b(?:active|running|on)\b/i.test(text) || badge?.classList?.contains?.('on') === true;
}

function deadPageCount(root) {
  const text = String(root?.body?.textContent || '');
  const pageMatch = text.match(/Dead\s+loot\s+page\s+\d+\s*\/\s*(\d+)/i);
  if (pageMatch) return Math.max(1, Number(pageMatch[1]) || 1);
  const pills = [...(root?.querySelectorAll?.('.unclaimed-pill') || [])];
  const pill = pills.find((node) => /unclaimed\s+kills/i.test(node.textContent || ''));
  const count = parseGameNumber(pill?.querySelector?.('.count')?.textContent);
  return count && count > 0 ? Math.max(1, Math.ceil(count / DEAD_PAGE_SIZE)) : 1;
}

function responseSucceeded(response) {
  const data = response?.json;
  const status = String(data?.status || '').toLowerCase();
  return Boolean(response?.ok && data && (data.ok === true || data.success === true || status === 'ok' || status === 'success'));
}

module.exports = {
  DEAD_PAGE_SIZE,
  WAVE_PATH,
  actionableQuests,
  aggregateRequirements,
  autoFarmIsActive,
  deadMonsterFromCard,
  deadPageCount,
  earliestCooldown,
  eligibleForRequirement,
  normalizeName,
  parseQuestRequirement,
  parseQuests,
  readAutoFarmSettings,
  readAutoFarmTargets,
  readDeadMonsters,
  readMonsterOptions,
  requirementCounts,
  requirementsSatisfied,
  responseSucceeded,
  validId,
};
