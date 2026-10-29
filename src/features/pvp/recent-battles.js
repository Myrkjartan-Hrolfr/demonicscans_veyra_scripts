'use strict';

// From veyra-hud ui-improvements (PvP main page): moves the "Recent ...
// Battles" sections into the main column and makes their cards open the
// battle. Only cards inside a "Recent" section with a "Match:" pill are
// linked (veyra-hud linked every .leader-card on the page).

const { KEYS, SETTINGS } = require('./settings');
const { battleUrlForMatch, isPvpLobbyUrl, isRecentSectionTitle, parseMatchId } = require('./pvp-helpers');

function findRecentSections(doc) {
  return [...doc.querySelectorAll('.section')].filter((section) =>
    isRecentSectionTitle(section.querySelector('.section-title')?.textContent),
  );
}

function matchIdOfCard(card) {
  for (const pill of card.querySelectorAll('.info-pill')) {
    const label = (pill.querySelector('strong')?.textContent || '').trim().toLowerCase();
    if (label && !label.startsWith('match')) continue;
    const id = parseMatchId(pill.querySelector('span')?.textContent);
    if (id) return id;
  }
  return null;
}

function moveRecentSections(doc) {
  const mainColumn = doc.querySelector('.grid-col--main');
  if (!mainColumn) return;
  for (const section of findRecentSections(doc)) {
    section.style.order = '6';
    if (section.parentElement !== mainColumn) mainColumn.appendChild(section);
  }
}

function linkRecentCards(doc, win) {
  for (const section of findRecentSections(doc)) {
    for (const card of section.querySelectorAll('.leader-card')) {
      if (card.dataset.veyraLinked === '1') continue;
      const matchId = matchIdOfCard(card);
      if (!matchId) continue;
      const url = battleUrlForMatch(matchId);
      card.dataset.veyraLinked = '1';
      card.style.cursor = 'pointer';
      card.setAttribute('role', 'link');
      card.setAttribute('tabindex', '0');
      card.title = `Open match #${matchId}`;

      const open = (newTab) => {
        if (newTab) win.open(url, '_blank', 'noopener');
        else win.location.href = url;
      };
      card.addEventListener('click', (event) => {
        if (event.target?.closest?.('a, button')) return;
        if (String(win.getSelection?.() || '')) return;
        open(event.ctrlKey || event.metaKey || event.shiftKey);
      });
      card.addEventListener('auxclick', (event) => {
        if (event.button === 1) open(true);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open(event.ctrlKey || event.metaKey);
      });
    }
  }
}

module.exports = Object.freeze({
  id: 'pvp-recent-battles',
  group: 'PvP',
  settings: [SETTINGS.moveRecentBattles, SETTINGS.linkRecentBattles],
  enabledBy: KEYS.soloImprovements,

  matches(url) {
    return isPvpLobbyUrl(url);
  },

  run(ctx) {
    if (ctx.setting(KEYS.linkRecentBattles)) linkRecentCards(ctx.doc, ctx.win);
    if (ctx.setting(KEYS.moveRecentBattles)) moveRecentSections(ctx.doc);
  },

  _test: { matchIdOfCard },
});
