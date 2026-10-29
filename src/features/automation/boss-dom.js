'use strict';

// Reads the boss hub (active_wave.php) and battle page (battle.php) into the
// plain objects boss-logic.js works with. Null safe throughout.

const { parseGameNumber } = require('../../core/numbers');

const SELECTORS = Object.freeze({
  summonCard: '.auto-summon-card',
  summonName: '.auto-summon-name',
  summonLink: 'a[href*="battle.php"]',
  monsterCard: '.monster-card[data-monster-id]',
  monsterContainer: '.monster-container',
  battleJoin: '#join-battle',
  battleCard: '.battle-card.monster-card[data-monster-id]',
});

function attr(element, name) {
  const value = element?.getAttribute?.(name);
  return value === null || value === undefined ? '' : String(value);
}

function monsterIdFromHref(href, base = 'https://demonicscans.org') {
  if (!href) return '';
  try {
    const url = new URL(href, base);
    return String(url.searchParams.get('id') || url.searchParams.get('monster_id') || '').trim();
  } catch {
    return '';
  }
}

function readSummons(doc) {
  const summons = [];
  for (const card of doc?.querySelectorAll?.(SELECTORS.summonCard) || []) {
    const name = String(card.querySelector?.(SELECTORS.summonName)?.textContent || '').trim();
    if (!name) continue;
    const link = card.querySelector?.(SELECTORS.summonLink);
    summons.push({
      name,
      alive: attr(card, 'data-alive') === '1',
      monsterId: monsterIdFromHref(attr(link, 'href')),
    });
  }
  return summons;
}

function joinedFlag(value) {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

function readMonsterCards(doc) {
  const cards = [];
  for (const card of doc?.querySelectorAll?.(SELECTORS.monsterCard) || []) {
    const monsterId = attr(card, 'data-monster-id').trim();
    if (!monsterId) continue;
    const expire = Number(attr(card, 'data-expire'));
    cards.push({
      monsterId,
      name: attr(card, 'data-name') || String(card.querySelector?.('h3')?.textContent || '').trim(),
      dead: attr(card, 'data-dead') === '1',
      joined: joinedFlag(attr(card, 'data-joined')),
      userDamage: parseGameNumber(attr(card, 'data-userdmg')),
      expire: attr(card, 'data-expire') && Number.isFinite(expire) ? expire : null,
    });
  }
  return cards;
}

function hasBossList(doc) {
  return Boolean(
    doc?.querySelector?.(SELECTORS.monsterContainer) ||
      (doc?.querySelectorAll?.(SELECTORS.summonCard) || []).length > 0,
  );
}

// The monster id of the open battle; '' when the sources disagree.
function battleMonsterId(url, doc) {
  const ids = [
    url?.searchParams?.get('id') || url?.searchParams?.get('monster_id') || '',
    attr(doc?.querySelector?.(SELECTORS.battleCard), 'data-monster-id'),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (ids.length === 0) return '';
  return new Set(ids).size === 1 ? ids[0] : '';
}

function findBattleJoinControl(doc) {
  return doc?.querySelector?.(SELECTORS.battleJoin) || null;
}

function setCookie(doc, name, value, days = 30) {
  try {
    doc.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${days * 86_400}; Path=/; SameSite=Lax`;
    return true;
  } catch {
    return false;
  }
}

function readCookieText(doc) {
  try {
    return String(doc?.cookie || '');
  } catch {
    return '';
  }
}

module.exports = {
  SELECTORS,
  battleMonsterId,
  findBattleJoinControl,
  hasBossList,
  monsterIdFromHref,
  readCookieText,
  readMonsterCards,
  readSummons,
  setCookie,
};
