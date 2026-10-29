'use strict';

// From veyra-hud ui-improvements (Solo PvP): on solo ladder battles shows an
// inline attack card with your skills (glowing on your turn) and the last
// hit dealt to the enemy / taken by your side.
//
// Differences to veyra-hud:
// - A missing "Ladder" pill no longer throws; the page is treated as non-solo.
// - A debounced MutationObserver replaces the permanent 333 ms interval.
// - The attack card uses its own token id (veyra-hud duplicated #modalTokens,
//   which hijacked the native skills modal counter).
// - While the PvP automation drives the battle
//   (html[data-veyra-smart-pvp-lifecycle="1"]) selectedTargetKey is never
//   touched.

const { KEYS, ALL_SETTINGS } = require('./settings');
const {
  findLastHit,
  formatInteger,
  isPlayersTurn,
  isPvpBattleUrl,
  isSoloLadder,
  observeDebounced,
  readPillValue,
} = require('./pvp-helpers');

const STYLE_ID = 'veyra-pvp-solo-hud-style';
const CARD_ID = 'veyraPvpAttackCard';
const GRID_ID = 'veyraPvpAttackGrid';
const TOKENS_ID = 'veyraPvpAttackTokens';

const CSS = `
  #${CARD_ID} { width: 100%; box-sizing: border-box; margin-bottom: 12px; }
  #${CARD_ID} .veyra-pvp-attack-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  #${CARD_ID} .veyra-pvp-attack-empty { opacity: .7; font-size: 12px; }
  #${CARD_ID}.veyra-pvp-my-turn { border: 1px solid #2ecc71; animation: veyraPvpGlow 1.5s infinite ease-in-out; }
  @keyframes veyraPvpGlow {
    0% { box-shadow: 0 0 6px 2px rgba(46, 204, 113, .5); }
    50% { box-shadow: 0 0 20px 6px rgba(46, 204, 113, 1); }
    100% { box-shadow: 0 0 6px 2px rgba(46, 204, 113, .5); }
  }
  .veyra-pvp-last-hit { margin-top: 10px; padding: 8px; border-radius: 8px; font-weight: 700; display: grid; justify-items: center; text-align: center; gap: 2px; }
  .veyra-pvp-last-hit--enemy { background: rgba(0, 150, 255, .08); }
  .veyra-pvp-last-hit--ally { background: rgba(255, 0, 0, .08); margin: 0 0 10px; }
  .veyra-pvp-last-hit__label { opacity: .8; font-size: 12px; }
  .veyra-pvp-last-hit__skill { font-size: 16px; }
  .veyra-pvp-last-hit--enemy .veyra-pvp-last-hit__dmg { color: #4db3ff; }
  .veyra-pvp-last-hit--ally .veyra-pvp-last-hit__dmg { color: #ff6b6b; }
  .veyra-pvp-last-hit__hp { font-size: 12px; opacity: .7; }
  .veyra-pvp-last-hit.veyra-pvp-pop { animation: veyraPvpPop 400ms ease; }
  @keyframes veyraPvpPop {
    0% { transform: scale(.9); opacity: 0; }
    50% { transform: scale(1.05); opacity: 1; }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    #${CARD_ID}.veyra-pvp-my-turn, .veyra-pvp-last-hit.veyra-pvp-pop { animation: none; }
  }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function findTurnCard(doc) {
  return [...doc.querySelectorAll('.card')].find((card) =>
    /turn control/i.test(card.querySelector('.card-title')?.textContent || ''),
  );
}

function getPlayerName(doc) {
  return readPillValue(doc, 'Player') || doc.querySelector('.topbar .pill .val.dim')?.textContent || '';
}

function createAttackCard(doc) {
  const card = doc.createElement('div');
  card.id = CARD_ID;
  card.className = 'card modalBox';

  const head = doc.createElement('div');
  head.className = 'modalHead veyra-pvp-attack-head';
  const title = doc.createElement('div');
  title.className = 'mhTitle';
  title.textContent = 'Active Skills';
  const badge = doc.createElement('span');
  badge.className = 'badge chip';
  badge.append('Tokens: ');
  const tokens = doc.createElement('span');
  tokens.id = TOKENS_ID;
  tokens.textContent = '0';
  badge.appendChild(tokens);
  head.append(title, badge);

  const body = doc.createElement('div');
  body.className = 'modalBody';
  const grid = doc.createElement('div');
  grid.className = 'skillsGrid';
  grid.id = GRID_ID;
  const empty = doc.createElement('div');
  empty.className = 'veyra-pvp-attack-empty';
  empty.textContent = 'Waiting for your skills…';
  body.append(grid, empty);

  card.append(head, body);
  return card;
}

// Runs inside the page: builds the skill buttons with the game's own
// createSkillButton/useSkill. Only touches selectedTargetKey on a user click
// and never while the PvP automation owns the battle.
function populateSkillsInPage(gridId) {
  try {
    var grid = document.getElementById(gridId);
    if (!grid || grid.dataset.veyraPopulated === '1') return;
    if (typeof mySkills === 'undefined' || !Array.isArray(mySkills) || mySkills.length === 0) return;
    if (typeof createSkillButton !== 'function' || typeof useSkill !== 'function') return;

    var aliveEnemySelector = '#enemyFormation .pSlot[data-side="enemy"][data-alive="1"]:not(.dead)';
    var automationActive = function () {
      return document.documentElement.dataset.veyraSmartPvpLifecycle === '1';
    };
    var ensureTarget = function () {
      if (automationActive() || typeof selectedTargetKey === 'undefined') return;
      var current = selectedTargetKey
        ? document.querySelector('.pSlot[data-side="enemy"][data-key="' + CSS.escape(selectedTargetKey) + '"]')
        : null;
      if (current && current.dataset.alive === '1' && !current.classList.contains('dead')) return;
      var enemy = document.querySelector(aliveEnemySelector);
      if (enemy && enemy.dataset.key) selectedTargetKey = enemy.dataset.key;
    };

    grid.textContent = '';
    mySkills
      .filter(function (skill) {
        var target = String((skill && skill.target) || 'enemy');
        return target === 'enemy' || target === 'self';
      })
      .forEach(function (skill) {
        var target = String(skill.target || 'enemy');
        var button = createSkillButton(skill, function () {
          if (target === 'enemy') ensureTarget();
          useSkill(String(skill.id || '0'), target);
        });
        grid.appendChild(button);
      });
    grid.dataset.veyraPopulated = '1';
  } catch (error) {
    console.warn('[Veyra:pvp-solo-battle-hud] Could not build the attack card.', error);
  }
}

function renderLastHit(doc, container, side, hit, prepend) {
  if (!container || !hit) return;
  const className = `veyra-pvp-last-hit veyra-pvp-last-hit--${side}`;
  let box = container.querySelector(`:scope > .veyra-pvp-last-hit--${side}`);
  if (!box) {
    box = doc.createElement('div');
    box.className = className;
    if (prepend) container.prepend(box);
    else container.appendChild(box);
  }
  if (box.dataset.lastKey === hit.key) return;
  box.dataset.lastKey = hit.key;

  const line = (cls, text) => {
    const element = doc.createElement('div');
    element.className = cls;
    element.textContent = text;
    return element;
  };
  box.replaceChildren(
    line('veyra-pvp-last-hit__label', side === 'enemy' ? 'Last Hit' : 'Last Hit Taken'),
    line('veyra-pvp-last-hit__skill', hit.skillName),
    line('veyra-pvp-last-hit__dmg', `${formatInteger(hit.damage)} dmg`),
    line('veyra-pvp-last-hit__hp', `HP Loss: ${formatInteger(hit.hpDamage)}`),
  );
  box.classList.remove('veyra-pvp-pop');
  void box.offsetWidth; // restart the animation
  box.classList.add('veyra-pvp-pop');
}

module.exports = Object.freeze({
  id: 'pvp-solo-battle-hud',
  group: 'PvP',
  settings: ALL_SETTINGS,
  enabledBy: KEYS.soloImprovements,

  matches(url) {
    return isPvpBattleUrl(url);
  },

  run(ctx) {
    const { doc, win } = ctx;
    if (!isSoloLadder(doc)) return;

    const showAttackCard = ctx.setting(KEYS.attackCard) === true;
    const showEnemyLastHit = ctx.setting(KEYS.enemyLastHit) === true;
    const showAllyLastHit = ctx.setting(KEYS.allyLastHit) === true;
    if (!showAttackCard && !showEnemyLastHit && !showAllyLastHit) return;

    ensureStyle(doc);
    const playerName = getPlayerName(doc);

    let card = null;
    let populateAttempts = 0;
    if (showAttackCard && !doc.getElementById(CARD_ID)) {
      const turnCard = findTurnCard(doc);
      if (turnCard) {
        card = createAttackCard(doc);
        turnCard.insertAdjacentElement('beforebegin', card);
      }
    }

    const updateAttackCard = () => {
      if (!card) return;
      const grid = card.querySelector(`#${GRID_ID}`);
      // Spectators never get skills; stop injecting after a while.
      if (grid && grid.dataset.veyraPopulated !== '1' && populateAttempts < 400) {
        populateAttempts += 1;
        ctx.injectPageScript(populateSkillsInPage, GRID_ID);
      }
      const populated = grid?.dataset.veyraPopulated === '1';
      const empty = card.querySelector('.veyra-pvp-attack-empty');
      if (empty) empty.hidden = populated;

      const tokenText = (doc.getElementById('myTokens')?.textContent || '').trim();
      const tokens = Number(tokenText.replace(/[^\d]/g, '')) || 0;
      const tokenEl = card.querySelector(`#${TOKENS_ID}`);
      if (tokenEl && tokenEl.textContent !== String(tokens)) tokenEl.textContent = String(tokens);

      const pageTurn = ctx.pageGlobal('isMyTurn');
      const myTurn =
        typeof pageTurn === 'boolean'
          ? pageTurn
          : isPlayersTurn(playerName, doc.getElementById('turnWho')?.textContent);
      card.classList.toggle('veyra-pvp-my-turn', myTurn);

      for (const button of grid?.querySelectorAll('button.skillCard') || []) {
        const cost = Number(button.dataset.cost) || 0;
        const disabled = !myTurn || tokens < cost;
        if (button.disabled !== disabled) button.disabled = disabled;
      }
    };

    const updateLastHits = () => {
      if (!showEnemyLastHit && !showAllyLastHit) return;
      const logDetailsMap = ctx.pageGlobal('logDetailsMap');
      if (!logDetailsMap) return;
      if (showEnemyLastHit) {
        renderLastHit(doc, doc.querySelector('#topTeamCard .card-b'), 'enemy', findLastHit(logDetailsMap, 'enemy'), false);
      }
      if (showAllyLastHit) {
        renderLastHit(doc, doc.querySelector('#bottomTeamCard .card-b'), 'ally', findLastHit(logDetailsMap, 'ally'), true);
      }
    };

    const update = () => {
      updateLastHits();
      updateAttackCard();
    };

    update();
    observeDebounced(win, doc.body, update, { delayMs: 150 });
  },

  _test: { populateSkillsInPage },
});
