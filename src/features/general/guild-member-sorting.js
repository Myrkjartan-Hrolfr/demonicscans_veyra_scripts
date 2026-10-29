'use strict';

// From veyra-hud ui-improvements (Guild Member's List): click a column
// header to sort, default sort by role (Leader, Vice, Member). Changes: the
// role column is found by its header, numbers/dates/text compare
// consistently, the header markup is kept (the caret is its own span) and a
// missing table only skips this feature.

const { injectStyle, textOf } = require('./dom');

const STYLE_ID = 'veyra-automation-guild-member-sorting';
const ROLE_ORDER = Object.freeze({ leader: 1, vice: 2, 'vice leader': 2, officer: 3, member: 4 });
const DATE_PATTERN = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/i;

// Returns a sortable key: [rank, value]. Rank keeps types apart so a column
// with mixed content still sorts consistently (numbers, dates, text).
function guildSortKey(value, isRoleColumn = false) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (isRoleColumn) return [0, ROLE_ORDER[text.toLowerCase()] ?? 99];

  const numeric = text.replace(/,/g, '');
  if (numeric !== '' && Number.isFinite(Number(numeric))) return [0, Number(numeric)];

  if (DATE_PATTERN.test(text)) {
    const date = Date.parse(text);
    if (Number.isFinite(date)) return [1, date];
  }
  return [2, text.toLowerCase()];
}

function compareGuildKeys(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

// rows: arrays of cell texts. Returns the row indexes in sorted order; ties
// keep their original order.
function sortGuildRows(rows, columnIndex, ascending = true, isRoleColumn = false) {
  return (rows || [])
    .map((cells, index) => ({ index, key: guildSortKey(cells?.[columnIndex], isRoleColumn) }))
    .sort((a, b) => {
      const result = compareGuildKeys(a.key, b.key);
      return (ascending ? result : -result) || a.index - b.index;
    })
    .map((entry) => entry.index);
}

function findRoleColumn(headerTexts) {
  const index = (headerTexts || []).findIndex((text) => /^(role|rank|position)\b/i.test(String(text).trim()));
  return index >= 0 ? index : 1;
}

function findMemberTable(doc) {
  const tables = [...(doc.querySelectorAll?.('table') || [])];
  return tables.find((table) => table.querySelector('tbody tr') && table.querySelector('th')) || null;
}

function enableSorting(doc, table) {
  const tbody = table.querySelector('tbody');
  const headers = [...table.querySelectorAll('th')];
  if (!tbody || headers.length === 0) return;

  const roleColumn = findRoleColumn(headers.map(textOf));
  const carets = headers.map((header) => {
    const caret = doc.createElement('span');
    caret.className = 'veyra-sort-caret';
    header.appendChild(caret);
    return caret;
  });

  const sortBy = (columnIndex, ascending) => {
    const rows = [...tbody.querySelectorAll(':scope > tr')];
    const cells = rows.map((row) => [...row.children].map(textOf));
    const order = sortGuildRows(cells, columnIndex, ascending, columnIndex === roleColumn);
    for (const index of order) tbody.appendChild(rows[index]);
    carets.forEach((caret, index) => {
      caret.textContent = index === columnIndex ? (ascending ? ' ▲' : ' ▼') : '';
    });
  };

  headers.forEach((header, index) => {
    let ascending = true;
    header.classList.add('veyra-sortable');
    header.title = 'Click to sort';
    header.addEventListener('click', () => {
      sortBy(index, ascending);
      ascending = !ascending;
    });
  });

  if (roleColumn < headers.length) sortBy(roleColumn, true);
}

module.exports = Object.freeze({
  id: 'guild-member-sorting',
  group: 'Guild',
  settings: [
    {
      key: 'ui-improvements:enableGuildMemberListSorting',
      label: 'Guild member list sorting',
      type: 'checkbox',
      default: true,
      hint: 'Click a column header on the members page to sort by it.',
    },
  ],
  enabledBy: 'ui-improvements:enableGuildMemberListSorting',
  findRoleColumn,
  guildSortKey,
  sortGuildRows,

  matches(url) {
    return /\/guild_members\.php$/i.test(url.pathname);
  },

  run({ doc }) {
    const table = findMemberTable(doc);
    if (!table || table.dataset.veyraSortable === '1') return;
    table.dataset.veyraSortable = '1';
    injectStyle(
      doc,
      STYLE_ID,
      '.veyra-sortable { cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; }',
    );
    enableSorting(doc, table);
  },
});
