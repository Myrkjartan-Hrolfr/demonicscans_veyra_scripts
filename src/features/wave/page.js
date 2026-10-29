'use strict';

// From veyra-hud ui-improvements ("Wave Page"): low HP warning, "In battle"
// counter, Heal button, auto farm buttons in the header and Join links on
// alive auto-summon bosses.

const { parseFraction } = require('../../core/numbers');
const { addStyle, debounce, isWavePage, make, monsterCards } = require('./common');

const GROUP = 'Wave page';
const STYLE_ID = 'veyra-automation-wave-page';
const LOW_HP_PERCENT = 10;
const DEFAULT_HEAL_ENDPOINT = 'user_heal_potion.php';

const FLASH_HP_BAR = Object.freeze({
  key: 'ui-improvements:flashHpBarWhenLow',
  label: 'Flash the HP bar when HP is low',
  type: 'checkbox',
  default: true,
  hint: `Below ${LOW_HP_PERCENT}% HP.`,
});

const IN_BATTLE_COUNT = Object.freeze({
  key: 'ui-improvements:enableInBattleCount',
  label: 'Show "In battle" count',
  type: 'checkbox',
  default: true,
  hint: 'Number of alive monsters you have joined.',
});

const CSS = `
  .veyra-wave-flash { position:relative; border:2px solid red; animation:veyraWaveFlash 1s infinite; }
  @keyframes veyraWaveFlash { 0%,100% { border-color:red; } 50% { border-color:transparent; } }
  .veyra-wave-hp-label { display:flex !important; align-items:center; flex-wrap:wrap; gap:6px; min-width:150px; }
  .veyra-wave-heal-btn { cursor:pointer; font-size:14px; line-height:1; min-height:28px; padding:4px 10px; }
  .veyra-wave-heal-btn[disabled] { opacity:.6; cursor:wait; }
  .veyra-wave-af-btn { background:#333; border-radius:8px; padding:8px 12px; font-size:13px; color:#fff;
    cursor:pointer; border:1px solid #2b2d44; box-shadow:0 6px 18px rgba(0,0,0,.6); min-height:34px; }
  .veyra-wave-join-btn { display:inline-block; margin-left:10px; padding:3px 15px; background:#1a9d73;
    color:#fff; border-radius:6px; text-decoration:none; font-weight:700; }
`;

// --------------------------------------------------------------- helpers

function hpPercentFromWidth(fill) {
  const percent = Number.parseFloat(fill?.style?.width);
  return Number.isFinite(percent) ? percent : null;
}

function isLowHp(percent, threshold = LOW_HP_PERCENT) {
  return percent !== null && percent !== undefined && Number.isFinite(percent) && percent < threshold;
}

function countJoinedAlive(cards) {
  return cards.filter((card) => card?.dataset?.joined === '1' && card?.dataset?.dead !== '1').length;
}

function findHpRow(doc) {
  const rows = Array.from(doc.querySelectorAll('.res-row'));
  return (
    rows.find((row) => /\bhp\b/i.test(row.querySelector('.res-label')?.textContent || '')) || null
  );
}

function healSucceeded(response) {
  const data = response?.json;
  if (data && typeof data === 'object') return String(data.status ?? '').trim() === 'success';
  return /^\s*success\s*$/i.test(String(response?.text || ''));
}

function healMessage(response, ok) {
  const data = response?.json;
  if (data && typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (ok) return 'Healed!';
  const text = String(response?.text || '').trim();
  return text ? text.slice(0, 200) : `Heal failed (HTTP ${response?.status ?? '?'}).`;
}

function updateFlash(fill) {
  const bar = fill?.parentElement;
  if (!bar) return;
  bar.classList.toggle('veyra-wave-flash', isLowHp(hpPercentFromWidth(fill)));
}

// ---------------------------------------------------------------- features

const flashHpFeature = Object.freeze({
  id: 'wave-flash-hp',
  group: GROUP,
  settings: [FLASH_HP_BAR],
  enabledBy: FLASH_HP_BAR.key,
  matches: isWavePage,

  run({ doc, win }) {
    const fill = findHpRow(doc)?.querySelector('.res-fill') || doc.querySelector('.res-fill.stamina');
    if (!fill) return;
    addStyle(doc, STYLE_ID, CSS);
    updateFlash(fill);
    const Observer = win?.MutationObserver;
    if (typeof Observer === 'function') {
      const refresh = debounce(() => updateFlash(fill), 150);
      new Observer(refresh).observe(fill, { attributes: true, attributeFilter: ['style'] });
    }
  },
});

const inBattleCountFeature = Object.freeze({
  id: 'wave-in-battle-count',
  group: GROUP,
  settings: [IN_BATTLE_COUNT],
  enabledBy: IN_BATTLE_COUNT.key,
  matches: isWavePage,

  run({ doc, win }) {
    const left = doc.querySelector('.bl-left');
    if (!left || doc.getElementById('veyra-in-battle-count')) return;
    const pill = make(doc, 'div', { className: 'unclaimed-pill', text: '💪 In battle: ' });
    const count = make(doc, 'span', { className: 'count' });
    count.id = 'veyra-in-battle-count';
    const update = () => {
      count.textContent = String(countJoinedAlive(monsterCards(doc)));
    };
    update();
    pill.appendChild(count);
    left.appendChild(pill);

    const container = doc.querySelector('.monster-container');
    const Observer = win?.MutationObserver;
    if (container && typeof Observer === 'function') {
      new Observer(debounce(update, 250)).observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-joined', 'data-dead'],
      });
    }
  },
});

const healButtonFeature = Object.freeze({
  id: 'wave-heal-button',
  group: GROUP,
  settings: [],
  matches: isWavePage,

  run(ctx) {
    const { doc } = ctx;
    const row = findHpRow(doc);
    const label = row?.querySelector('.res-label');
    if (!label || label.querySelector('.veyra-wave-heal-btn, .heal-btn')) return;
    addStyle(doc, STYLE_ID, CSS);

    const fill = row.querySelector('.res-fill');
    const meta = row.querySelector('.res-meta');
    const button = make(doc, 'button', {
      className: 'btn veyra-wave-heal-btn',
      text: '💚 Heal',
      attrs: { type: 'button', title: 'Use a Full HP Potion' },
    });
    label.classList.add('veyra-wave-hp-label');
    label.appendChild(button);

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const userId = await ctx.getUserId();
        if (!userId) {
          ctx.notify('User id not found.', 'error');
          return;
        }
        const endpoints = ctx.pageGlobal('ENDPOINTS');
        const url = (endpoints && endpoints.HEAL_POTION) || DEFAULT_HEAL_ENDPOINT;
        const response = await ctx.postForm(url, { user_id: userId });
        const ok = response.ok && healSucceeded(response);
        ctx.notify(healMessage(response, ok), ok ? 'success' : 'error');
        if (!ok) return;
        if (fill) {
          fill.style.width = '100%';
          updateFlash(fill);
        }
        const fraction = parseFraction(meta?.textContent);
        if (meta && fraction) {
          const max = meta.textContent.split('/')[1].trim();
          meta.textContent = `${max} / ${max}`;
        }
      } catch (error) {
        ctx.warn('Heal failed.', error);
        ctx.notify('Network error.', 'error');
      } finally {
        button.disabled = false;
      }
    });
  },
});

const autoFarmButtonsFeature = Object.freeze({
  id: 'wave-auto-farm-buttons',
  group: GROUP,
  settings: [],
  matches: isWavePage,

  run({ doc }) {
    const toggle = doc.getElementById('afToggleBtn');
    const header = toggle?.parentElement;
    if (!header) return;
    addStyle(doc, STYLE_ID, CSS);
    for (const id of ['afStartBtn', 'afPauseBtn', 'afResetBtn']) {
      const button = doc.getElementById(id);
      if (!button || button.parentElement === header) continue;
      button.className = 'veyra-wave-af-btn';
      header.insertBefore(button, toggle);
    }
  },
});

const bossJoinLinksFeature = Object.freeze({
  id: 'wave-boss-join-links',
  group: GROUP,
  settings: [],
  matches: isWavePage,

  run({ doc }) {
    const summons = Array.from(doc.querySelectorAll('.auto-summon-card[data-alive="1"]'));
    if (!summons.length) return;
    addStyle(doc, STYLE_ID, CSS);
    const cards = monsterCards(doc).filter((card) => card.dataset.dead !== '1');
    for (const summon of summons) {
      const name = summon.querySelector('.auto-summon-name')?.textContent?.trim().toLowerCase();
      const status = summon.querySelector('.auto-summon-status.alive');
      if (!name || !status || status.querySelector('.auto-join-btn, .veyra-wave-join-btn')) continue;
      const card = cards.find((candidate) => String(candidate.dataset.name || '').trim() === name);
      const monsterId = Number(card?.dataset?.monsterId);
      if (!Number.isInteger(monsterId) || monsterId <= 0) continue;
      const link = make(doc, 'a', { className: 'veyra-wave-join-btn', text: 'Join' });
      link.href = `battle.php?id=${monsterId}`;
      status.appendChild(link);
    }
  },
});

module.exports = {
  FLASH_HP_BAR,
  IN_BATTLE_COUNT,
  autoFarmButtonsFeature,
  bossJoinLinksFeature,
  countJoinedAlive,
  features: [
    flashHpFeature,
    inBattleCountFeature,
    healButtonFeature,
    autoFarmButtonsFeature,
    bossJoinLinksFeature,
  ],
  findHpRow,
  flashHpFeature,
  healButtonFeature,
  healSucceeded,
  hpPercentFromWidth,
  inBattleCountFeature,
  isLowHp,
  updateFlash,
};
