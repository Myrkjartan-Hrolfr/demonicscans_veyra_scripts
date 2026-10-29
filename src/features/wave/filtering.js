'use strict';

// From veyra-hud ui-improvements ("Wave Filtering"): unlocks the 10 monster
// limit of "Select visible", sorts / filters the monster cards by HP, groups
// them by name and hides the gate info box.

const { parseFraction, parseGameNumber } = require('../../core/numbers');
const { addStyle, isWavePage, make, monsterCards, reloadPage, setStatus } = require('./common');

const GROUP = 'Wave filtering';
const STYLE_ID = 'veyra-automation-wave-filtering';

const UNLOCK_SELECT_LIMIT = Object.freeze({
  key: 'ui-improvements:unlockSelectLimit',
  label: 'Unlock the "Select visible" limit',
  type: 'checkbox',
  default: true,
  hint: '"Select visible" selects every visible alive monster instead of at most 10.',
});

const SORT_BY_HP = Object.freeze({
  key: 'ui-improvements:sortByHp',
  label: 'Sort monsters by HP (lowest first)',
  type: 'checkbox',
  default: false,
});

const FILTER_BY_HP = Object.freeze({
  key: 'ui-improvements:filterByHp',
  label: 'Filter monsters by HP',
  type: 'checkbox',
  default: false,
});

const MIN_HP = Object.freeze({
  key: 'ui-improvements:minHpValue',
  label: 'Minimum HP',
  type: 'number',
  default: 0,
  min: 0,
  visibleIf: (get) => get(FILTER_BY_HP.key) === true,
});

const MAX_HP = Object.freeze({
  key: 'ui-improvements:maxHpValue',
  label: 'Maximum HP',
  type: 'number',
  default: null,
  min: 0,
  hint: 'Leave empty for no upper limit.',
  visibleIf: (get) => get(FILTER_BY_HP.key) === true,
});

const USE_GROUPS = Object.freeze({
  key: 'ui-improvements:useGroupedMobs',
  label: 'Group monsters by name',
  type: 'checkbox',
  default: false,
  hint: 'Shows one row per monster type while "All monsters" is selected.',
});
// veyra-hud stored this setting under a misspelled key.
const LEGACY_USE_GROUPS_KEY = 'ui-imrovements:useGroupedMobs';

const DISABLE_GATE_INFO = Object.freeze({
  key: 'ui-improvements:disableGateInfoToggle',
  label: 'Hide gate info',
  type: 'checkbox',
  default: true,
  hint: 'Collapses the long gate description; a button shows it again.',
});

const FILTER_CONTROL_IDS = Object.freeze(['fNameSel', 'fJoined', 'fUnjoined', 'fCapNotReached']);

// ---------------------------------------------------------------- helpers

// Accepts numbers and game-number text ("1,000,000", "1.5m"). Anything else,
// including '' and null, is null (= no limit).
function parseHpLimit(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string') return parseGameNumber(value);
  return null;
}

// Max HP: null or non-positive means "no limit".
function normalizeHpRange(min, max) {
  const lower = parseHpLimit(min) ?? 0;
  const upper = parseHpLimit(max);
  return { min: lower, max: upper !== null && upper > 0 ? upper : Infinity };
}

function hpInRange(hp, range) {
  if (!hp || !Number.isFinite(hp.current)) return true;
  return hp.current >= range.min && hp.current <= range.max;
}

function readCardHp(card) {
  const text = card?.querySelector?.('.stat-icon.hp + .stat-main .stat-value')?.textContent;
  return parseFraction(text);
}

function isDead(card) {
  return card?.dataset?.dead === '1';
}

// Stable sort: alive cards by current HP ascending, cards without HP after
// them, dead cards last.
function sortCardsByHp(cards, readHp = readCardHp) {
  const rank = (entry) => (entry.dead ? 2 : entry.hp ? 0 : 1);
  return cards
    .map((card, index) => ({ card, index, hp: readHp(card), dead: isDead(card) }))
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank) return byRank;
      if (rank(a) === 0 && a.hp.current !== b.hp.current) return a.hp.current - b.hp.current;
      return a.index - b.index;
    })
    .map((entry) => entry.card);
}

// Groups cards by data-name in order of first appearance. Without HP sort
// each group is ordered by monster id.
function groupCardsByName(cards, { sortById = true } = {}) {
  const groups = new Map();
  for (const card of cards) {
    const name = String(card?.dataset?.name || '').trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(card);
  }
  if (sortById) {
    for (const list of groups.values()) {
      list.sort((a, b) => Number(a.dataset.monsterId) - Number(b.dataset.monsterId));
    }
  }
  return groups;
}

function isVisible(card) {
  return card?.style?.display !== 'none';
}

// Cards "Select visible" should pick: alive and not hidden.
function selectableCards(cards) {
  return cards.filter((card) => !isDead(card) && isVisible(card));
}

// Reads a stored HP limit and rewrites veyra-hud's text values as numbers.
function readHpSetting(ctx, definition) {
  const raw = ctx.store?.read?.(definition.key);
  if (raw === null || raw === undefined) return definition.default;
  const parsed = parseHpLimit(raw);
  if (typeof raw !== 'number') {
    try {
      ctx.setSetting(definition.key, parsed);
    } catch {
      // ignore
    }
  }
  return parsed;
}

function migrateGroupSetting(ctx) {
  const store = ctx.store;
  if (!store?.read) return;
  if (store.read(USE_GROUPS.key) !== null) return;
  const legacy = store.read(LEGACY_USE_GROUPS_KEY);
  if (legacy === true || legacy === false || legacy === 'true' || legacy === 'false') {
    ctx.setSetting(USE_GROUPS.key, legacy);
  }
}

// -------------------------------------------------------------- DOM parts

const CSS = `
  .veyra-wave-inline-toggle { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; min-height:28px; }
  .veyra-wave-inline-toggle input { width:16px; height:16px; margin:0; cursor:pointer; }
  .monster-container.veyra-wave-grouped { display:flex !important; flex-direction:column; gap:24px; }
  .veyra-wave-row { display:flex; justify-content:center; flex-wrap:wrap; gap:16px; width:100%; position:relative; padding-bottom:30px; }
  .veyra-wave-row::after { content:""; position:absolute; bottom:0; left:10%; right:10%; height:2px;
    background:linear-gradient(to right, transparent, rgba(255,255,255,.7), transparent); }
  .veyra-wave-gate-hidden { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; color:#9aa0be; }
  .veyra-wave-gate-hidden button { min-height:32px; }
`;

function insertInlineToggle(ctx, anchor, { id, label, definition }) {
  const { doc } = ctx;
  if (!anchor || doc.getElementById(id)) return null;
  const wrapper = make(doc, 'label', { className: 'veyra-wave-inline-toggle' });
  wrapper.setAttribute('for', id);
  const input = make(doc, 'input', { attrs: { type: 'checkbox' } });
  input.id = id;
  input.checked = ctx.setting(definition.key) === true;
  input.addEventListener('change', () => {
    ctx.setSetting(definition.key, input.checked);
    reloadPage(ctx.win);
  });
  wrapper.appendChild(input);
  wrapper.appendChild(make(doc, 'span', { text: label }));
  anchor.insertAdjacentElement('afterend', wrapper);
  return wrapper;
}

function applyHpFilter(cards, range) {
  for (const card of cards) {
    if (isDead(card)) continue;
    if (!hpInRange(readCardHp(card), range)) {
      card.style.display = 'none';
      card.dataset.veyraHpHidden = '1';
    } else if (card.dataset.veyraHpHidden === '1') {
      delete card.dataset.veyraHpHidden;
    }
  }
}

function updateRowVisibility(container) {
  for (const row of container?.querySelectorAll?.('.veyra-wave-row') || []) {
    const anyVisible = monsterCards(row).some(isVisible);
    row.style.display = anyVisible ? '' : 'none';
  }
}

function groupContainer(ctx, container, cards, sortByHp) {
  const groups = groupCardsByName(cards, { sortById: !sortByHp });
  container.classList.add('veyra-wave-grouped');
  for (const [name, list] of groups) {
    const row = make(ctx.doc, 'div', { className: 'veyra-wave-row' });
    row.dataset.name = name;
    for (const card of list) row.appendChild(card);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------- features

const selectVisibleFeature = Object.freeze({
  id: 'wave-select-visible',
  group: GROUP,
  settings: [UNLOCK_SELECT_LIMIT],
  enabledBy: UNLOCK_SELECT_LIMIT.key,
  matches: isWavePage,

  run({ doc }) {
    const button = doc.getElementById('btnSelectVisible');
    if (!button || button.dataset.veyraUnlocked === '1') return;
    button.dataset.veyraUnlocked = '1';
    // Runs after the game's own handler, which stops at 10.
    button.addEventListener('click', () => {
      const cards = monsterCards(doc);
      let picked = 0;
      for (const card of selectableCards(cards)) {
        const checkbox = card.querySelector('.pickMonster');
        if (!checkbox) continue;
        checkbox.checked = true;
        picked += 1;
      }
      const status = setStatus(doc, '');
      if (!status) return;
      status.appendChild(doc.createTextNode('Selected: '));
      status.appendChild(make(doc, 'b', { text: `${picked}/${cards.length}` }));
    });
  },
});

const filterSortGroupFeature = Object.freeze({
  id: 'wave-filter-sort-group',
  group: GROUP,
  settings: [SORT_BY_HP, FILTER_BY_HP, MIN_HP, MAX_HP, USE_GROUPS],
  matches: isWavePage,

  run(ctx) {
    const { doc } = ctx;
    migrateGroupSetting(ctx);

    const capLabel = doc.getElementById('fCapNotReached')?.closest?.('label');
    const container = doc.querySelector('.monster-container');
    if (!capLabel && !container) return;
    addStyle(doc, STYLE_ID, CSS);

    const sortByHp = ctx.setting(SORT_BY_HP.key) === true;
    const filterByHp = ctx.setting(FILTER_BY_HP.key) === true;
    const useGroups = ctx.setting(USE_GROUPS.key) === true;

    // Inline toggles next to "CAP not reached" (unique ids, unlike veyra-hud).
    if (capLabel) {
      insertInlineToggle(ctx, capLabel, {
        id: 'veyra-wave-toggle-sort-by-hp',
        label: 'Sort by HP',
        definition: SORT_BY_HP,
      });
      insertInlineToggle(ctx, capLabel, {
        id: 'veyra-wave-toggle-use-groups',
        label: 'Use groups',
        definition: USE_GROUPS,
      });
    }

    if (!container) return;
    const cards = monsterCards(container);

    const range = filterByHp
      ? normalizeHpRange(readHpSetting(ctx, MIN_HP), readHpSetting(ctx, MAX_HP))
      : null;
    if (range) applyHpFilter(cards, range);

    let ordered = cards;
    if (sortByHp) {
      ordered = sortCardsByHp(cards);
      if (!useGroups) for (const card of ordered) container.appendChild(card);
    }

    const nameSelect = doc.getElementById('fNameSel');
    if (useGroups && (nameSelect?.value || '') === '' && !container.classList.contains('veyra-wave-grouped')) {
      groupContainer(ctx, container, ordered, sortByHp);
    }

    if (useGroups && nameSelect) {
      // Switching between "All monsters" and a single name rebuilds the page.
      let previous = nameSelect.value || '';
      nameSelect.addEventListener('change', () => {
        const current = nameSelect.value || '';
        const changedMode = (previous === '') !== (current === '');
        previous = current;
        if (changedMode) setTimeout(() => reloadPage(ctx.win), 300);
      });
    }

    // The game's filters reset card visibility; re-apply ours afterwards.
    const reapply = () => {
      if (range) applyHpFilter(monsterCards(container), range);
      updateRowVisibility(container);
    };
    for (const id of FILTER_CONTROL_IDS) {
      const control = doc.getElementById(id);
      control?.addEventListener('change', reapply);
      control?.addEventListener('input', reapply);
    }
    updateRowVisibility(container);
  },
});

const gateInfoFeature = Object.freeze({
  id: 'wave-gate-info',
  group: GROUP,
  settings: [DISABLE_GATE_INFO],
  enabledBy: DISABLE_GATE_INFO.key,
  matches: isWavePage,

  run({ doc }) {
    const scroll = doc.querySelector('.gate-info-scroll');
    if (!scroll || scroll.querySelector('.veyra-wave-gate-hidden')) return;
    addStyle(doc, STYLE_ID, CSS);

    const original = Array.from(scroll.childNodes);
    for (const node of original) node.remove();
    const notice = make(doc, 'div', { className: 'gate-desc veyra-wave-gate-hidden' });
    notice.appendChild(make(doc, 'span', { text: 'Gate info hidden.' }));
    const show = make(doc, 'button', { className: 'btn', text: 'Show gate info', attrs: { type: 'button' } });
    show.addEventListener('click', () => {
      notice.remove();
      for (const node of original) scroll.appendChild(node);
    });
    notice.appendChild(show);
    scroll.appendChild(notice);
  },
});

module.exports = {
  DISABLE_GATE_INFO,
  FILTER_BY_HP,
  LEGACY_USE_GROUPS_KEY,
  MAX_HP,
  MIN_HP,
  SORT_BY_HP,
  UNLOCK_SELECT_LIMIT,
  USE_GROUPS,
  features: [selectVisibleFeature, filterSortGroupFeature, gateInfoFeature],
  filterSortGroupFeature,
  gateInfoFeature,
  groupCardsByName,
  hpInRange,
  migrateGroupSetting,
  normalizeHpRange,
  parseHpLimit,
  readCardHp,
  readHpSetting,
  selectVisibleFeature,
  selectableCards,
  sortCardsByHp,
};
