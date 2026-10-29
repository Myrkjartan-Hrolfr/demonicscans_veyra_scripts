'use strict';

// From veyra-hud filter-inventory: hides chosen items in the inventory. The
// "Filter Inventory" switch and the per-item choices are stored under the
// original keys (filterInventory, inventoryFilters). Changes: item names
// with quotes or HTML no longer break the list, the panel fits on phones,
// and "Show all" / "Hide all" buttons were added.

const { injectStyle } = require('./dom');

const STYLE_ID = 'veyra-automation-inventory-filter';
const FILTER_ON_KEY = 'filterInventory';
const FILTERS_KEY = 'inventoryFilters';

const CSS = `
  .veyra-inv-filter-toggle { display: flex !important; align-items: center; gap: 8px; cursor: pointer; min-height: 36px; }
  .veyra-inv-filter-toggle input { width: 18px; height: 18px; margin: 0; }
  .veyra-inv-filter-wrap { position: relative; }
  .veyra-inv-filter-wrap > .tab { height: 100%; min-height: 36px; }
  .veyra-inv-filter-panel {
    display: none; position: absolute; right: 0; top: calc(100% + 4px); z-index: 99999999;
    width: min(320px, calc(100vw - 32px)); max-height: min(600px, 70vh); overflow-y: auto;
    background: #222; color: #eee; padding: 10px; border: 1px solid #444; border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.6); text-align: left;
  }
  .veyra-inv-filter-panel.open { display: block; }
  .veyra-inv-filter-actions { display: flex; gap: 8px; margin: 8px 0; }
  .veyra-inv-filter-actions button { flex: 1; min-height: 34px; border-radius: 6px; border: 1px solid #555; background: #333; color: #eee; cursor: pointer; }
  .veyra-inv-filter-item { display: flex; align-items: center; gap: 8px; padding: 6px 2px; min-height: 32px; cursor: pointer; }
  .veyra-inv-filter-item input { width: 18px; height: 18px; flex: none; margin: 0; }
`;

function uniqueItemNames(names) {
  const seen = new Set();
  for (const name of names || []) {
    const trimmed = String(name ?? '').trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

// Items are shown unless filtering is on and the item was unticked.
function isItemShown(name, filterOn, filters) {
  if (!filterOn) return true;
  return (filters || {})[String(name ?? '').trim()] !== false;
}

function slotName(slot) {
  return String(slot.querySelector?.('.info-btn')?.dataset?.name ?? '').trim();
}

module.exports = Object.freeze({
  id: 'inventory-filter',
  group: 'Inventory',
  settings: [
    {
      key: 'inventory-filter:enableInventoryFilter',
      label: 'Inventory filter',
      type: 'checkbox',
      default: true,
      hint: 'Adds a "Filter Inventory" switch to hide chosen items.',
    },
  ],
  enabledBy: 'inventory-filter:enableInventoryFilter',
  isItemShown,
  uniqueItemNames,

  matches(url) {
    return /\/inventory\.php$/i.test(url.pathname);
  },

  run({ doc, store }) {
    const host = doc.querySelector?.('.set-tabs');
    if (!host || doc.getElementById('veyra-inv-filter-toggle')) return;
    injectStyle(doc, STYLE_ID, CSS);

    const readFilterOn = () => {
      const value = store?.read(FILTER_ON_KEY);
      return typeof value === 'boolean' ? value : true;
    };
    const readFilters = () => {
      const value = store?.read(FILTERS_KEY);
      return value && typeof value === 'object' ? value : {};
    };
    let filterOn = readFilterOn();

    const applyFilter = () => {
      const filters = readFilters();
      for (const slot of doc.querySelectorAll('.slot-box')) {
        const name = slotName(slot);
        if (!name) continue;
        slot.style.display = isItemShown(name, filterOn, filters) ? '' : 'none';
      }
    };

    // Switch
    const toggle = doc.createElement('label');
    toggle.className = 'tab switch-label veyra-inv-filter-toggle';
    const toggleText = doc.createElement('span');
    toggleText.textContent = 'Filter Inventory';
    const toggleInput = doc.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.id = 'veyra-inv-filter-toggle';
    toggleInput.checked = filterOn;
    const slider = doc.createElement('span');
    slider.className = 'slider';
    toggle.append(toggleText, toggleInput, slider);

    // Filter panel
    const wrapper = doc.createElement('div');
    wrapper.className = 'veyra-inv-filter-wrap';
    wrapper.style.display = filterOn ? '' : 'none';
    const panelButton = doc.createElement('button');
    panelButton.type = 'button';
    panelButton.className = 'tab';
    panelButton.textContent = '⚙ Filters';
    const panel = doc.createElement('div');
    panel.className = 'veyra-inv-filter-panel';
    const heading = doc.createElement('strong');
    heading.textContent = 'Show these items:';
    const actions = doc.createElement('div');
    actions.className = 'veyra-inv-filter-actions';
    const list = doc.createElement('div');
    panel.append(heading, actions, list);
    wrapper.append(panelButton, panel);

    const saveFromCheckboxes = () => {
      const filters = readFilters();
      for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
        filters[checkbox.dataset.name] = checkbox.checked;
      }
      store?.write(FILTERS_KEY, filters);
      applyFilter();
    };

    for (const [label, checked] of [
      ['Show all', true],
      ['Hide all', false],
    ]) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) checkbox.checked = checked;
        saveFromCheckboxes();
      });
      actions.appendChild(button);
    }

    const names = uniqueItemNames(
      [...doc.querySelectorAll('.slot-box .info-btn')].map((button) => button.dataset?.name),
    ).sort((a, b) => a.localeCompare(b));
    const savedFilters = readFilters();
    for (const name of names) {
      const row = doc.createElement('label');
      row.className = 'veyra-inv-filter-item';
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.name = name;
      checkbox.checked = savedFilters[name] !== false;
      checkbox.addEventListener('change', saveFromCheckboxes);
      const text = doc.createElement('span');
      text.textContent = name;
      row.append(checkbox, text);
      list.appendChild(row);
    }
    if (names.length === 0) {
      const empty = doc.createElement('div');
      empty.textContent = 'No items found.';
      list.appendChild(empty);
    }

    host.append(toggle, wrapper);

    toggleInput.addEventListener('change', () => {
      filterOn = toggleInput.checked;
      wrapper.style.display = filterOn ? '' : 'none';
      if (!filterOn) panel.classList.remove('open');
      store?.write(FILTER_ON_KEY, filterOn);
      applyFilter();
    });
    panelButton.addEventListener('click', (event) => {
      event.preventDefault();
      panel.classList.toggle('open');
    });
    doc.addEventListener('click', (event) => {
      if (!panel.classList.contains('open')) return;
      if (!wrapper.contains(event.target)) panel.classList.remove('open');
    });

    if (filterOn) applyFilter();
  },
});
