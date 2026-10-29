'use strict';

// From veyra-hud ui-improvements (Battle Pass): scrolls the reward tracks to
// the highest reached level and keeps the free/premium tracks scrolled
// together. Changes: only runs on battle_pass.php (the original ran on every
// page), syncing works even when no level is reached yet, and a track
// without the target card no longer stops the others.

const { textOf } = require('./dom');
const { sleep } = require('../../core/time');

const SCROLL_DELAY_MS = 1_300;

// badgeGroups: for every element that has a "Reached" badge, the texts of all
// badges in it, e.g. [['L12', 'Reached'], ['L13', 'Reached']] -> 13.
function highestReachedLevel(badgeGroups) {
  let highest = null;
  for (const texts of badgeGroups || []) {
    const normalized = (texts || []).map((text) => String(text ?? '').trim());
    if (!normalized.some((text) => /^reached$/i.test(text))) continue;
    for (const text of normalized) {
      const match = text.match(/^L(\d+)$/i);
      if (match) highest = Math.max(highest ?? 0, Number(match[1]));
    }
  }
  return highest;
}

// Horizontal offset that centres a card in its scroll container.
function centeredScrollLeft(cardOffsetLeft, cardWidth, containerWidth) {
  return Math.max(0, Math.round(cardOffsetLeft - containerWidth / 2 + cardWidth / 2));
}

function readBadgeGroups(doc) {
  const parents = new Set();
  for (const badge of doc.querySelectorAll?.('.lvl-badge') || []) {
    if (/^reached$/i.test(textOf(badge)) && badge.parentElement) parents.add(badge.parentElement);
  }
  return [...parents].map((parent) => [...parent.querySelectorAll('.lvl-badge')].map(textOf));
}

function scrollToLevel(doc, level) {
  for (const container of doc.querySelectorAll?.('.bp-scroll') || []) {
    const card = [...container.querySelectorAll('.level-card')].find(
      (candidate) => textOf(candidate.querySelector('.lvl-top .lvl-badge')) === `L${level}`,
    );
    if (!card) continue;
    const left = centeredScrollLeft(card.offsetLeft, card.clientWidth, container.clientWidth);
    if (typeof container.scrollTo === 'function') container.scrollTo({ left, behavior: 'smooth' });
    else container.scrollLeft = left;
  }
}

function syncScrollbars(doc) {
  const containers = [...(doc.querySelectorAll?.('.bp-scroll') || [])];
  if (containers.length < 2) return;
  for (const container of containers) {
    container.addEventListener(
      'scroll',
      () => {
        const left = container.scrollLeft;
        for (const other of containers) {
          // Skipping equal values stops the scroll events ping-ponging.
          if (other !== container && Math.abs(other.scrollLeft - left) > 1) other.scrollLeft = left;
        }
      },
      { passive: true },
    );
  }
}

module.exports = Object.freeze({
  id: 'battle-pass',
  group: 'Battle Pass',
  settings: [
    {
      key: 'ui-improvements:scrollToCurrentLevel',
      label: 'Auto scroll to current level',
      type: 'checkbox',
      default: true,
    },
    {
      key: 'ui-improvements:syncBattlePassScrollbars',
      label: 'Sync scrollbars',
      type: 'checkbox',
      default: true,
      hint: 'Scrolling one reward track scrolls the other one too.',
    },
  ],
  centeredScrollLeft,
  highestReachedLevel,

  matches(url) {
    return /\/battle_pass\.php$/i.test(url.pathname);
  },

  async run(ctx) {
    if (ctx.setting('ui-improvements:syncBattlePassScrollbars')) syncScrollbars(ctx.doc);
    if (!ctx.setting('ui-improvements:scrollToCurrentLevel')) return;
    // The tracks are laid out after load; scrolling earlier lands off target.
    await sleep(SCROLL_DELAY_MS);
    const level = highestReachedLevel(readBadgeGroups(ctx.doc));
    if (level) scrollToLevel(ctx.doc, level);
  },
});
