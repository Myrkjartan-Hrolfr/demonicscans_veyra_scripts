'use strict';

const { injectStyle, textOf } = require('./dom');

const STYLE_ID = 'veyra-power-crystal-quickset-style';
const ROOT_ID = 'veyra-power-crystal-quickset';
const RESULT_KEY = 'veyra:power-crystals:quickset-result';
const PAGE_PATH = '/power_crystals.php';
const MAX_POST_RETRIES = 4;

const CSS = `
  #${ROOT_ID} { --pcq-border: rgba(255,255,255,.11); --pcq-bg: rgba(16,24,42,.96); }
  #${ROOT_ID} * { box-sizing: border-box; }
  #${ROOT_ID}.pcq-panel { background: linear-gradient(180deg, rgba(21,31,53,.98), rgba(12,19,34,.98)); border: 1px solid var(--pcq-border); border-radius: 24px; box-shadow: 0 18px 45px rgba(0,0,0,.35); color: #eef3ff; margin: 0 0 22px; padding: 20px; }
  #${ROOT_ID} .pcq-head, #${ROOT_ID} .pcq-toolbar, #${ROOT_ID} .pcq-item-head, #${ROOT_ID} .pcq-resource-line, #${ROOT_ID} .pcq-upgrade-row { display: flex; align-items: center; gap: 10px; }
  #${ROOT_ID} .pcq-head { justify-content: space-between; flex-wrap: wrap; margin-bottom: 14px; }
  #${ROOT_ID} h2, #${ROOT_ID} h3, #${ROOT_ID} p { margin: 0; }
  #${ROOT_ID} h2 { font-size: 24px; }
  #${ROOT_ID} h3 { font-size: 17px; }
  #${ROOT_ID} .pcq-help, #${ROOT_ID} .pcq-muted { color: #9caad0; font-size: 12px; }
  #${ROOT_ID} .pcq-toolbar { align-items: end; flex-wrap: wrap; background: rgba(255,255,255,.035); border: 1px solid var(--pcq-border); border-radius: 15px; padding: 11px; margin-bottom: 14px; }
  #${ROOT_ID} label { color: #cdd7f5; display: grid; font-size: 12px; gap: 4px; }
  #${ROOT_ID} select, #${ROOT_ID} input { background: #111a2d; border: 1px solid #3a4c72; border-radius: 8px; color: #fff; min-height: 36px; padding: 6px 9px; }
  #${ROOT_ID} .pcq-search { flex: 1 1 190px; }
  #${ROOT_ID} .pcq-search input { width: 100%; }
  #${ROOT_ID} button { background: #304a86; border: 1px solid #5e79b4; border-radius: 8px; color: #fff; cursor: pointer; font-weight: 700; min-height: 34px; padding: 6px 10px; }
  #${ROOT_ID} button:hover { filter: brightness(1.1); }
  #${ROOT_ID} button:disabled { cursor: not-allowed; filter: none; opacity: .42; }
  #${ROOT_ID} .pcq-layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); }
  #${ROOT_ID} .pcq-column { min-width: 0; }
  #${ROOT_ID} .pcq-column-title { display: flex; justify-content: space-between; gap: 8px; margin: 0 0 9px; }
  #${ROOT_ID} .pcq-equipment-list, #${ROOT_ID} .pcq-crystal-list { display: grid; gap: 10px; }
  #${ROOT_ID} .pcq-equipment { background: rgba(255,255,255,.035); border: 1px solid var(--pcq-border); border-radius: 15px; display: grid; gap: 12px; grid-template-columns: 64px minmax(0,1fr); padding: 11px; }
  #${ROOT_ID} .pcq-equipment > img { background: #0b1222; border: 1px solid var(--pcq-border); border-radius: 12px; height: 64px; object-fit: contain; width: 64px; }
  #${ROOT_ID} .pcq-item-head { align-items: flex-start; justify-content: space-between; }
  #${ROOT_ID} .pcq-item-name { font-size: 14px; font-weight: 800; overflow-wrap: anywhere; }
  #${ROOT_ID} .pcq-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
  #${ROOT_ID} .pcq-tag { background: rgba(110,168,255,.11); border: 1px solid rgba(110,168,255,.25); border-radius: 999px; color: #cfe0ff; font-size: 10px; padding: 3px 7px; }
  #${ROOT_ID} .pcq-slots { display: grid; gap: 7px; grid-template-columns: repeat(3, minmax(0,1fr)); margin-top: 9px; }
  #${ROOT_ID} .pcq-slot { align-items: center; background: #0c1426; border: 1px dashed #53678f; border-radius: 10px; cursor: pointer; display: flex; justify-content: center; min-height: 70px; padding: 5px; position: relative; text-align: center; }
  #${ROOT_ID} .pcq-slot.pcq-dragover { background: rgba(60,207,145,.14); border-color: #3ccf91; }
  #${ROOT_ID} .pcq-slot.pcq-selected-target { border-color: #ffce6a; }
  #${ROOT_ID} .pcq-empty { color: #7787ad; font-size: 11px; }
  #${ROOT_ID} .pcq-crystal { align-items: center; background: rgba(110,168,255,.07); border: 1px solid rgba(110,168,255,.2); border-radius: 10px; cursor: grab; display: grid; gap: 7px; grid-template-columns: 42px minmax(0,1fr); min-width: 0; padding: 6px; text-align: left; width: 100%; }
  #${ROOT_ID} .pcq-crystal:active { cursor: grabbing; }
  #${ROOT_ID} .pcq-crystal.pcq-selected { border-color: #ffce6a; box-shadow: 0 0 0 1px rgba(255,206,106,.35); }
  #${ROOT_ID} .pcq-crystal img { background: #09101e; border-radius: 8px; height: 42px; object-fit: contain; width: 42px; }
  #${ROOT_ID} .pcq-crystal-name { font-size: 11px; font-weight: 800; overflow-wrap: anywhere; }
  #${ROOT_ID} .pcq-crystal-meta { color: #bfcaf0; font-size: 11px; margin-top: 2px; }
  #${ROOT_ID} .pcq-side-box { background: rgba(255,255,255,.035); border: 1px solid var(--pcq-border); border-radius: 15px; margin-bottom: 11px; padding: 11px; }
  #${ROOT_ID} .pcq-side-box h3 { margin-bottom: 8px; }
  #${ROOT_ID} .pcq-available { max-height: 390px; overflow: auto; padding-right: 3px; }
  #${ROOT_ID} .pcq-available.pcq-dragover { background: rgba(60,207,145,.1); border: 1px dashed #3ccf91; border-radius: 10px; min-height: 70px; }
  #${ROOT_ID} .pcq-inactive { display: grid; gap: 6px; max-height: 180px; overflow: auto; }
  #${ROOT_ID} .pcq-stock { align-items: center; display: grid; font-size: 12px; gap: 7px; grid-template-columns: 30px minmax(0,1fr) auto; }
  #${ROOT_ID} .pcq-stock img { height: 30px; object-fit: contain; width: 30px; }
  #${ROOT_ID} .pcq-details { min-height: 120px; }
  #${ROOT_ID} .pcq-details-title { font-size: 14px; font-weight: 800; margin-bottom: 5px; overflow-wrap: anywhere; }
  #${ROOT_ID} .pcq-upgrade-row { align-items: end; flex-wrap: wrap; margin-top: 9px; }
  #${ROOT_ID} .pcq-upgrade-row label { width: 86px; }
  #${ROOT_ID} .pcq-upgrade-row input { width: 86px; }
  #${ROOT_ID} .pcq-upgrade-row button { flex: 1 1 120px; }
  #${ROOT_ID} .pcq-cost { color: #b8c5e8; font-size: 11px; margin-top: 4px; }
  #${ROOT_ID} .pcq-status { background: rgba(110,168,255,.08); border: 1px solid rgba(110,168,255,.22); border-radius: 10px; color: #d8e4ff; margin-bottom: 13px; min-height: 40px; overflow-wrap: anywhere; padding: 10px 12px; }
  #${ROOT_ID} .pcq-status[data-kind="error"] { background: rgba(255,107,122,.1); border-color: rgba(255,107,122,.32); color: #ffd4d9; }
  #${ROOT_ID} .pcq-status[data-kind="ok"] { background: rgba(60,207,145,.1); border-color: rgba(60,207,145,.3); color: #caffea; }
  #${ROOT_ID}[aria-busy="true"] button, #${ROOT_ID}[aria-busy="true"] select, #${ROOT_ID}[aria-busy="true"] input { pointer-events: none; opacity: .58; }
  #${ROOT_ID} .pcq-empty-state { color: #9caad0; font-size: 12px; padding: 12px 4px; text-align: center; }
  @media (max-width: 900px) { #${ROOT_ID} .pcq-layout { grid-template-columns: 1fr; } }
  @media (max-width: 520px) {
    #${ROOT_ID}.pcq-panel { border-radius: 16px; padding: 13px; }
    #${ROOT_ID} .pcq-equipment { grid-template-columns: 50px minmax(0,1fr); padding: 8px; }
    #${ROOT_ID} .pcq-equipment > img { height: 50px; width: 50px; }
    #${ROOT_ID} .pcq-slots { grid-column: 1 / -1; }
    #${ROOT_ID} .pcq-slot { min-height: 66px; }
    #${ROOT_ID} .pcq-crystal { gap: 4px; grid-template-columns: 34px minmax(0,1fr); padding: 4px; }
    #${ROOT_ID} .pcq-crystal img { height: 34px; width: 34px; }
  }
`;

function numberFromText(value, fallback = 0) {
  const digits = String(value ?? '').replace(/[^\d-]/g, '');
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function callNumber(value, functionName) {
  const match = String(value ?? '').match(new RegExp(`${functionName}\\(\\s*(\\d+)\\s*\\)`));
  return match ? Number(match[1]) : null;
}

function upgradeCallNumber(value, kind = 'level') {
  const match = String(value ?? '').match(
    new RegExp(`openUpgradeModal\\(\\s*['"]${kind}['"]\\s*,\\s*(\\d+)\\s*\\)`),
  );
  return match ? Number(match[1]) : null;
}

function callTitle(value) {
  const match = String(value ?? '').match(/openInfoFromData\(\s*this\s*,\s*(['"])(.*?)\1\s*\)/);
  if (!match) return '';
  return match[2].replace(/\\(['"\\])/g, '$1').trim();
}

function parseJsonAssignment(source, variableName) {
  const text = String(source ?? '');
  const marker = new RegExp(`\\b(?:const|let|var)\\s+${variableName}\\s*=`).exec(text);
  if (!marker) return null;
  let start = marker.index + marker[0].length;
  while (/\s/.test(text[start] || '')) start += 1;
  const opener = text[start];
  if (opener !== '{' && opener !== '[') return null;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseInlineJson(doc, variableName, fallback) {
  for (const script of doc?.querySelectorAll?.('script') || []) {
    const result = parseJsonAssignment(script.textContent, variableName);
    if (result !== null) return result;
  }
  return fallback;
}

function cleanImageName(src) {
  let path = String(src ?? '').split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  const basename = path.split('/').pop() || 'Equipment';
  return basename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d+_/, '')
    .replace(/^compressed_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Equipment';
}

function isOpaqueEquipmentName(name) {
  return /^[a-f\d]{10,}(?:\s+\d+)?$/i.test(String(name ?? '').trim());
}

function inferEquipmentMeta(name, src = '') {
  const value = `${name} ${src}`.toLowerCase();
  const plainName = String(name ?? '').trim().toLowerCase();
  let type = 'Other';
  if (/\b(ring|amulet|necklace|pendant|talisman|earring)\b/.test(value)) type = 'Accessory';
  else if (/\b(boot|boots|greave|greaves|stride|trackers|sabatons|foot|feet)\b/.test(value)) type = 'Feet';
  else if (/\b(glove|gloves|gauntlet|gauntlets|grasp|grips|hands|talons|bracer|bracers)\b/.test(value)) type = 'Hands';
  else if (/\b(crown|visor|helm|helmet|hood|mask|circlet|head|halo|fangbreaker)\b/.test(value)) type = 'Head';
  else if (/\b(robe|plate|carapace|armor|armour|chest|chestplate|mail|cuirass|vest|fangchest)\b/.test(value)) type = 'Chest';
  else if (/\b(dagger|daggers|lance|sword|swordstaff|staff|blade|axe|bow|spear|hammer|scythe|claw|weapon|testament)\b/.test(value)) type = 'Weapon';
  else if (/^(viridictum|crownpiercer void|scalcourge fire|scalescourge fire)$/.test(plainName)) type = 'Weapon';

  let set = 'Unknown';
  const knownSets = [
    ['last_dawn', 'Last Dawn'],
    ['last dawn', 'Last Dawn'],
    ['vaelith', 'Vaelith'],
    ['crownpiercer', 'Crownpiercer'],
    ['viridictum', 'Viridictum'],
    ['scalescourge', 'Scalescourge'],
    ['scalcourge', 'Scalescourge'],
    ['mercurion', 'Mercurion'],
    ['eternal harvest', 'Eternal Harvest'],
    ['aegis', 'Aegis'],
  ];
  const known = knownSets.find(([needle]) => value.includes(needle));
  if (known) set = known[1];
  else {
    const first = String(name ?? '').trim().split(/\s+/)[0];
    if (first && !isOpaqueEquipmentName(first) && !/^(ring|robe|boots?|gloves?|helmet|armor|equipment)$/i.test(first)) set = first;
  }
  return { type, set };
}

function panelByTitle(doc, title) {
  const wanted = String(title).toLowerCase();
  return [...(doc?.querySelectorAll?.('section.panel') || [])].find((panel) =>
    textOf(panel.querySelector?.('.panel-head h2, h2')).toLowerCase().includes(wanted),
  ) || null;
}

function equipmentImageKey(src) {
  const value = String(src ?? '').split(/[?#]/, 1)[0];
  return value.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?/, '/').toLowerCase();
}

function parseEquipment(doc, metadata = new Map()) {
  const panel = panelByTitle(doc, 'Equipment');
  const occurrences = new Map();
  return [...(panel?.querySelectorAll?.('.equipment-card') || [])].map((card, index) => {
    const image = card.querySelector?.('.art-button img, .art-frame img');
    const src = image?.getAttribute?.('src') || image?.src || '';
    const imageKey = equipmentImageKey(src) || `equipment-${index}`;
    const occurrence = occurrences.get(imageKey) || 0;
    occurrences.set(imageKey, occurrence + 1);
    const key = `${imageKey}#${occurrence}`;
    const slots = [...(card.querySelectorAll?.('.slot-row .slot-btn') || [])].map((slot) => {
      const onclick = slot.getAttribute?.('onclick') || '';
      return {
        crystalId: callNumber(onclick, 'openConfirmUnequip'),
        equipmentId: callNumber(onclick, 'openPickerModal'),
      };
    });
    const equipmentId = slots.find((slot) => slot.equipmentId)?.equipmentId || null;
    const stored = equipmentId ? metadata.get(String(equipmentId)) : null;
    const fallbackName = cleanImageName(src);
    const rawName = stored?.name
      || image?.getAttribute?.('alt')
      || image?.getAttribute?.('title')
      || (isOpaqueEquipmentName(fallbackName) ? `Equipment ${index + 1}` : fallbackName);
    const inferred = inferEquipmentMeta(rawName, src);
    return {
      key,
      index,
      id: equipmentId,
      name: rawName,
      type: stored?.type || inferred.type,
      set: stored?.set || inferred.set,
      image: src,
      stats: [...(card.querySelectorAll?.('.stat-pills .pill') || [])].map(textOf),
      slots,
    };
  });
}

function parseActivatedCrystals(doc) {
  const panel = panelByTitle(doc, 'Activated Crystals');
  const crystals = [];
  for (const card of panel?.querySelectorAll?.('.crystal-card') || []) {
    const buttons = [...(card.querySelectorAll?.('button[onclick]') || [])];
    const id = buttons.map((button) => upgradeCallNumber(button.getAttribute('onclick'), 'level')).find(Number.isFinite);
    if (!Number.isFinite(id)) continue;
    const imageButton = card.querySelector?.('.crystal-image');
    const info = imageButton?.getAttribute?.('data-info') || '';
    const levelText = textOf(card.querySelector?.('.level-line span'));
    const levelMatch = info.match(/Lv\.\s*(\d+)\s*\/\s*(\d+)/i);
    const starMatch = info.match(/([★]+)\s*\/\s*(\d+)/);
    const starsText = textOf(card.querySelector?.('.star-badge'));
    const status = textOf(card.querySelector?.('.level-line .muted'));
    crystals.push({
      id,
      name: callTitle(imageButton?.getAttribute?.('onclick')) || `Crystal ${id}`,
      image: imageButton?.querySelector?.('img')?.getAttribute?.('src') || '',
      level: levelMatch ? Number(levelMatch[1]) : numberFromText(levelText, 1),
      maxLevel: levelMatch ? Number(levelMatch[2]) : 40,
      stars: starMatch ? starMatch[1].length : Math.max(1, (starsText.match(/★/g) || []).length),
      maxStars: starMatch ? Number(starMatch[2]) : 8,
      linked: /linked/i.test(status),
      info,
      equipmentKey: null,
    });
  }
  return crystals;
}

function parseInactiveCrystals(doc, starData = {}) {
  const panel = panelByTitle(doc, 'Inactive Crystals');
  const stocks = [];
  const materialNames = new Map(
    Object.values(starData || {})
      .filter((entry) => entry?.item_image && entry?.item_name)
      .map((entry) => [equipmentImageKey(entry.item_image), String(entry.item_name)]),
  );
  for (const card of panel?.querySelectorAll?.('.crystal-card') || []) {
    const form = card.querySelector?.('form');
    if (form?.querySelector?.('input[name="action"]')?.value !== 'activate_crystal') continue;
    const imageButton = card.querySelector?.('.crystal-image');
    const image = imageButton?.querySelector?.('img')?.getAttribute?.('src') || '';
    stocks.push({
      inventoryId: numberFromText(form.querySelector?.('input[name="inv_id"]')?.value, 0),
      name: callTitle(imageButton?.getAttribute?.('onclick'))
        || textOf(card.querySelector?.('.crystal-name'))
        || materialNames.get(equipmentImageKey(image))
        || cleanImageName(image),
      image,
      quantity: numberFromText(textOf(card.querySelector?.('.qty-chip')), 0),
    });
  }
  return stocks;
}

function parseGold(doc) {
  for (const chip of doc?.querySelectorAll?.('.hero-chip') || []) {
    if (/\bgold\b/i.test(textOf(chip.querySelector?.('.l')))) {
      return numberFromText(textOf(chip.querySelector?.('.n')), 0);
    }
  }
  return 0;
}

function parsePageState(doc, metadata = new Map()) {
  const levelData = parseInlineJson(doc, 'levelUpgradeData', {});
  const starData = parseInlineJson(doc, 'starUpgradeData', {});
  const equipment = parseEquipment(doc, metadata);
  const crystals = parseActivatedCrystals(doc);
  const crystalById = new Map(crystals.map((crystal) => [crystal.id, crystal]));
  for (const item of equipment) {
    for (const slot of item.slots) {
      if (!slot.crystalId) continue;
      const crystal = crystalById.get(slot.crystalId);
      if (crystal) crystal.equipmentKey = item.key;
    }
  }
  return {
    doc,
    token: doc?.querySelector?.('input[name="crystal_intent"]')?.value || '',
    gold: parseGold(doc),
    equipment,
    crystals,
    crystalById,
    inactive: parseInactiveCrystals(doc, starData),
    levelData,
    starData,
    error: textOf(doc?.querySelector?.('.flash.err')),
  };
}

function parseInventoryMetadata(doc) {
  const result = new Map();
  for (const slot of doc?.querySelectorAll?.('.slot-box') || []) {
    const info = slot.querySelector?.('.info-btn');
    const name = String(info?.dataset?.name || '').trim();
    if (!name) continue;
    const input = slot.querySelector?.('input[name="inv_id"], input[name="inventory_id"], input[name="equipment_inv_id"]');
    const candidates = [
      slot.dataset?.inv,
      slot.dataset?.invId,
      slot.dataset?.inventoryId,
      info?.dataset?.inv,
      info?.dataset?.invId,
      input?.value,
    ];
    const id = candidates.map((value) => numberFromText(value, 0)).find((value) => value > 0);
    if (!id) continue;
    const inferred = inferEquipmentMeta(name, info?.dataset?.image || '');
    result.set(String(id), {
      name,
      type: slot.dataset?.type || info?.dataset?.type || inferred.type,
      set: slot.dataset?.set || info?.dataset?.set || inferred.set,
    });
  }
  return result;
}

function upgradeAffordable(data, gold) {
  if (!data || !Number.isFinite(Number(data.expected_current))) return false;
  return Number(gold) >= Number(data.gold_needed || 0) && Number(data.has_qty || 0) >= Number(data.need_qty || 0);
}

function planCrystalMove({ crystalId, sourceEquipmentKey = null, targetEquipmentKey, targetCrystalId = null }) {
  const sourceId = Number(crystalId);
  const targetId = Number(targetCrystalId) || null;
  if (!sourceId) return [];
  if (!targetEquipmentKey) {
    return sourceEquipmentKey ? [{ action: 'unequip', crystalId: sourceId }] : [];
  }
  if (sourceId === targetId) return [];
  if (sourceEquipmentKey && sourceEquipmentKey === targetEquipmentKey) return [];
  const actions = [];
  if (sourceEquipmentKey) actions.push({ action: 'unequip', crystalId: sourceId });
  if (targetId) actions.push({ action: 'unequip', crystalId: targetId });
  actions.push({ action: 'equip', crystalId: sourceId, equipmentKey: targetEquipmentKey });
  if (targetId && sourceEquipmentKey) {
    actions.push({ action: 'equip', crystalId: targetId, equipmentKey: sourceEquipmentKey });
  }
  return actions;
}

function createElement(doc, tag, className = '', text = '') {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = Object.freeze({
  id: 'power-crystal-quickset',
  group: 'General',
  settings: [
    {
      key: 'veyra:powerCrystals:quicksetEnabled',
      label: 'Power Crystal Quickset',
      type: 'checkbox',
      default: true,
      hint: 'Adds a filterable equipment/crystal overview with drag-and-drop and multi-step upgrades.',
    },
  ],
  enabledBy: 'veyra:powerCrystals:quicksetEnabled',
  callNumber,
  cleanImageName,
  inferEquipmentMeta,
  parseInlineJson,
  parseJsonAssignment,
  parsePageState,
  planCrystalMove,
  upgradeAffordable,

  matches(url) {
    return /\/power_crystals\.php$/i.test(url.pathname);
  },

  async run(ctx) {
    const { doc, win } = ctx;
    const pageWrap = doc?.querySelector?.('.page-wrap');
    if (!pageWrap || !doc.querySelector?.('.equipment-grid') || doc.getElementById?.(ROOT_ID)) return;

    injectStyle(doc, STYLE_ID, CSS);
    const metadata = new Map();
    let liveState = parsePageState(doc, metadata);
    let selectedCrystalId = null;
    let busy = false;
    let typeFilter = 'all';
    let setFilter = 'all';
    let searchFilter = '';

    const root = createElement(doc, 'section', 'pcq-panel');
    root.id = ROOT_ID;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `
      <div class="pcq-head">
        <div><h2>💎 Power Crystal Quickset</h2><p class="pcq-help">Crystal ziehen oder antippen, dann Zielslot wählen. Belegte Slots werden ausgetauscht.</p></div>
        <button type="button" data-action="reload">↻ Neu laden</button>
      </div>
      <div class="pcq-status" role="status">Bereit.</div>
      <div class="pcq-toolbar">
        <label>Equipment-Typ<select data-filter="type"></select></label>
        <label>Set<select data-filter="set"></select></label>
        <label class="pcq-search">Suchen<input type="search" data-filter="search" placeholder="Equipmentname …"></label>
        <span class="pcq-muted" data-role="filter-count"></span>
      </div>
      <div class="pcq-layout">
        <div class="pcq-column"><div class="pcq-column-title"><h3>Equipment</h3><span class="pcq-muted">3 Slots je Item</span></div><div class="pcq-equipment-list"></div></div>
        <aside class="pcq-column">
          <div class="pcq-side-box"><h3>Ausgewählter Crystal</h3><div class="pcq-details"></div></div>
          <div class="pcq-side-box"><h3>Aktiviert & verfügbar</h3><div class="pcq-crystal-list pcq-available"></div></div>
          <div class="pcq-side-box"><h3>Vorhanden, nicht aktiviert</h3><div class="pcq-inactive"></div><p class="pcq-help" style="margin-top:8px">Nur Übersicht – Aktivieren bleibt wegen des unwiderruflichen Verbrauchsschutzes in der Originalansicht.</p></div>
        </aside>
      </div>`;

    const equipmentPanel = panelByTitle(doc, 'Equipment');
    pageWrap.insertBefore(root, equipmentPanel || pageWrap.firstChild);

    const status = root.querySelector('.pcq-status');
    const equipmentList = root.querySelector('.pcq-equipment-list');
    const availableList = root.querySelector('.pcq-crystal-list');
    const inactiveList = root.querySelector('.pcq-inactive');
    const details = root.querySelector('.pcq-details');
    const typeSelect = root.querySelector('[data-filter="type"]');
    const setSelect = root.querySelector('[data-filter="set"]');
    const searchInput = root.querySelector('[data-filter="search"]');
    const countLabel = root.querySelector('[data-role="filter-count"]');

    const setStatus = (message, kind = '') => {
      status.textContent = message;
      status.dataset.kind = kind;
    };
    const setBusy = (value) => {
      busy = value;
      root.setAttribute('aria-busy', value ? 'true' : 'false');
    };
    const rememberAndReload = (message, kind = 'ok') => {
      try {
        win.sessionStorage?.setItem(RESULT_KEY, JSON.stringify({ message, kind }));
      } catch {}
      setStatus(`${message} Ansicht wird aktualisiert …`, kind);
      win.setTimeout?.(() => win.location?.reload?.(), 450);
    };

    try {
      const remembered = JSON.parse(win.sessionStorage?.getItem(RESULT_KEY) || 'null');
      if (remembered?.message) setStatus(remembered.message, remembered.kind || 'ok');
      win.sessionStorage?.removeItem(RESULT_KEY);
    } catch {}

    const currentEquipmentForCrystal = (crystalId) =>
      liveState.equipment.find((item) => item.slots.some((slot) => slot.crystalId === Number(crystalId))) || null;

    function addSelectOptions(select, values, allLabel, current) {
      select.replaceChildren();
      const all = createElement(doc, 'option', '', allLabel);
      all.value = 'all';
      select.appendChild(all);
      for (const value of values) {
        const option = createElement(doc, 'option', '', value);
        option.value = value;
        select.appendChild(option);
      }
      select.value = values.includes(current) ? current : 'all';
    }

    function renderFilters() {
      const types = [...new Set(liveState.equipment.map((item) => item.type))].sort((a, b) => a.localeCompare(b));
      const sets = [...new Set(liveState.equipment.map((item) => item.set))].sort((a, b) => a.localeCompare(b));
      addSelectOptions(typeSelect, types, 'Alle Typen', typeFilter);
      addSelectOptions(setSelect, sets, 'Alle Sets', setFilter);
      typeFilter = typeSelect.value;
      setFilter = setSelect.value;
    }

    function selectCrystal(crystalId) {
      if (busy || !liveState.crystalById.has(Number(crystalId))) return;
      selectedCrystalId = Number(crystalId);
      render();
      setStatus('Crystal ausgewählt. Jetzt einen Zielslot anklicken oder den Crystal dorthin ziehen.');
    }

    function crystalNode(crystal, activate = null) {
      const node = createElement(doc, 'div', `pcq-crystal${selectedCrystalId === crystal.id ? ' pcq-selected' : ''}`);
      node.draggable = true;
      node.dataset.crystalId = String(crystal.id);
      node.tabIndex = 0;
      node.title = 'Ziehen oder anklicken';
      const image = createElement(doc, 'img');
      image.src = crystal.image;
      image.alt = '';
      const meta = createElement(doc, 'div');
      meta.append(
        createElement(doc, 'div', 'pcq-crystal-name', crystal.name),
        createElement(doc, 'div', 'pcq-crystal-meta', `Lv. ${crystal.level}/${crystal.maxLevel} · ${'★'.repeat(crystal.stars)}/${crystal.maxStars}`),
      );
      node.append(image, meta);
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        (activate || selectCrystal)(crystal.id);
      });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          (activate || selectCrystal)(crystal.id);
        }
      });
      node.addEventListener('dragstart', (event) => {
        selectedCrystalId = crystal.id;
        event.dataTransfer?.setData('text/plain', String(crystal.id));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      return node;
    }

    function costText(data) {
      if (!data) return 'Maximalwert erreicht oder keine Upgrade-Daten vorhanden.';
      const material = Number(data.need_qty || 0) > 0
        ? ` · ${formatNumber(data.need_qty)} ${data.item_name} (vorhanden: ${formatNumber(data.has_qty)})`
        : '';
      return `Nächster Schritt: ${formatNumber(data.gold_needed)} Gold${material}`;
    }

    function renderDetails() {
      details.replaceChildren();
      const crystal = liveState.crystalById.get(Number(selectedCrystalId));
      if (!crystal) {
        details.appendChild(createElement(doc, 'div', 'pcq-empty-state', 'Crystal anklicken, um ihn zu verschieben oder aufzuwerten.'));
        return;
      }
      details.append(
        createElement(doc, 'div', 'pcq-details-title', crystal.name),
        createElement(doc, 'div', 'pcq-crystal-meta', `Lv. ${crystal.level}/${crystal.maxLevel} · ${'★'.repeat(crystal.stars)}/${crystal.maxStars} · ${crystal.equipmentKey ? 'ausgerüstet' : 'verfügbar'}`),
      );
      for (const kind of ['level', 'star']) {
        const isLevel = kind === 'level';
        const map = isLevel ? liveState.levelData : liveState.starData;
        const data = map[String(crystal.id)];
        const current = isLevel ? crystal.level : crystal.stars;
        const maximum = isLevel ? crystal.maxLevel : crystal.maxStars;
        const row = createElement(doc, 'div', 'pcq-upgrade-row');
        const label = createElement(doc, 'label', '', isLevel ? 'Level +' : 'Sterne +');
        const input = createElement(doc, 'input');
        input.type = 'number';
        input.min = '1';
        input.max = String(Math.max(1, maximum - current));
        input.step = '1';
        input.value = '1';
        label.appendChild(input);
        const button = createElement(doc, 'button', '', isLevel ? 'Level erhöhen' : 'Sterne erhöhen');
        button.type = 'button';
        button.disabled = current >= maximum || !upgradeAffordable(data, liveState.gold);
        button.addEventListener('click', () => runUpgrade(kind, crystal.id, numberFromText(input.value, 1)));
        row.append(label, button);
        details.append(row, createElement(doc, 'div', 'pcq-cost', costText(data)));
      }
      if (crystal.equipmentKey) {
        const remove = createElement(doc, 'button', '', 'Vom Equipment entfernen');
        remove.type = 'button';
        remove.style.marginTop = '10px';
        remove.addEventListener('click', () => releaseCrystal(crystal.id));
        details.appendChild(remove);
      }
    }

    function filteredEquipment() {
      const search = searchFilter.trim().toLowerCase();
      return liveState.equipment.filter((item) =>
        (typeFilter === 'all' || item.type === typeFilter)
        && (setFilter === 'all' || item.set === setFilter)
        && (!search || `${item.name} ${item.type} ${item.set}`.toLowerCase().includes(search)),
      );
    }

    function renderEquipment() {
      equipmentList.replaceChildren();
      const items = filteredEquipment();
      countLabel.textContent = `${items.length}/${liveState.equipment.length} Items`;
      if (!items.length) {
        equipmentList.appendChild(createElement(doc, 'div', 'pcq-empty-state', 'Kein Equipment passt zu den Filtern.'));
        return;
      }
      for (const item of items) {
        const card = createElement(doc, 'article', 'pcq-equipment');
        const image = createElement(doc, 'img');
        image.src = item.image;
        image.alt = '';
        const body = createElement(doc, 'div');
        const head = createElement(doc, 'div', 'pcq-item-head');
        const title = createElement(doc, 'div');
        title.appendChild(createElement(doc, 'div', 'pcq-item-name', item.name));
        const tags = createElement(doc, 'div', 'pcq-tags');
        for (const value of [item.type, item.set, ...item.stats]) tags.appendChild(createElement(doc, 'span', 'pcq-tag', value));
        title.appendChild(tags);
        head.appendChild(title);
        const slots = createElement(doc, 'div', 'pcq-slots');
        item.slots.forEach((slot, slotIndex) => {
          const target = createElement(doc, 'div', `pcq-slot${selectedCrystalId ? ' pcq-selected-target' : ''}`);
          target.tabIndex = 0;
          target.dataset.equipmentKey = item.key;
          target.dataset.slotIndex = String(slotIndex);
          const crystal = slot.crystalId ? liveState.crystalById.get(slot.crystalId) : null;
          const accept = (crystalId) => moveCrystal(Number(crystalId), item.key, slot.crystalId || null);
          if (crystal) {
            target.appendChild(crystalNode(crystal, () => {
              if (selectedCrystalId && selectedCrystalId !== crystal.id) accept(selectedCrystalId);
              else selectCrystal(crystal.id);
            }));
          } else {
            target.appendChild(createElement(doc, 'span', 'pcq-empty', selectedCrystalId ? 'Hier einsetzen' : 'Leer'));
          }
          target.addEventListener('dragover', (event) => {
            event.preventDefault();
            target.classList.add('pcq-dragover');
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          });
          target.addEventListener('dragleave', () => target.classList.remove('pcq-dragover'));
          target.addEventListener('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();
            target.classList.remove('pcq-dragover');
            const crystalId = numberFromText(event.dataTransfer?.getData('text/plain'), selectedCrystalId || 0);
            if (crystalId) accept(crystalId);
          });
          target.addEventListener('click', () => {
            if (selectedCrystalId && selectedCrystalId !== slot.crystalId) accept(selectedCrystalId);
            else if (slot.crystalId) selectCrystal(slot.crystalId);
          });
          target.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && selectedCrystalId) {
              event.preventDefault();
              accept(selectedCrystalId);
            }
          });
          slots.appendChild(target);
        });
        body.append(head, slots);
        card.append(image, body);
        equipmentList.appendChild(card);
      }
    }

    function renderAvailable() {
      availableList.replaceChildren();
      const available = liveState.crystals
        .filter((crystal) => !crystal.equipmentKey)
        .sort((a, b) => a.name.localeCompare(b.name) || b.stars - a.stars || b.level - a.level);
      if (!available.length) {
        availableList.appendChild(createElement(doc, 'div', 'pcq-empty-state', 'Keine aktivierten, freien Crystals. Ausgerüstete Crystals können direkt zwischen Slots getauscht werden.'));
        return;
      }
      for (const crystal of available) availableList.appendChild(crystalNode(crystal));
    }

    function renderInactive() {
      inactiveList.replaceChildren();
      if (!liveState.inactive.length) {
        inactiveList.appendChild(createElement(doc, 'div', 'pcq-empty-state', 'Keine inaktiven Crystals vorhanden.'));
        return;
      }
      for (const stock of liveState.inactive.sort((a, b) => a.name.localeCompare(b.name))) {
        const row = createElement(doc, 'div', 'pcq-stock');
        const image = createElement(doc, 'img');
        image.src = stock.image;
        image.alt = '';
        row.append(image, createElement(doc, 'span', '', stock.name), createElement(doc, 'strong', '', `× ${formatNumber(stock.quantity)}`));
        inactiveList.appendChild(row);
      }
    }

    function render() {
      if (selectedCrystalId && !liveState.crystalById.has(selectedCrystalId)) selectedCrystalId = null;
      renderFilters();
      renderEquipment();
      renderAvailable();
      renderInactive();
      renderDetails();
    }

    async function postMutation(params) {
      if (!liveState.token) throw new Error('Crystal-Sicherheitstoken fehlt. Bitte die Seite neu laden.');
      const body = new URLSearchParams({ crystal_intent: liveState.token, ...params }).toString();
      let lastError = null;
      for (let attempt = 0; attempt <= MAX_POST_RETRIES; attempt += 1) {
        let response;
        try {
          response = await win.fetch(ctx.url.href, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body,
          });
        } catch (error) {
          lastError = error;
          if (attempt >= MAX_POST_RETRIES) throw error;
          await sleep(Math.min(10_000, 800 * 2 ** attempt));
          continue;
        }
        const text = await response.text();
        if ((response.status === 429 || response.status === 503) && attempt < MAX_POST_RETRIES) {
          const retry = Number(response.headers?.get?.('Retry-After'));
          const waitMs = Number.isFinite(retry) && retry >= 0 ? Math.min(120_000, retry * 1000) : Math.min(20_000, 800 * 2 ** attempt);
          setStatus(`Server bremst die Anfragen. Weiter in ${Math.ceil(waitMs / 1000)} s …`);
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) throw new Error(`Serverfehler HTTP ${response.status}.`);
        const nextDoc = new win.DOMParser().parseFromString(text, 'text/html');
        if (!/power crystals/i.test(nextDoc.title || '') || !nextDoc.querySelector?.('input[name="crystal_intent"]')) {
          throw new Error('Die Serverantwort war keine gültige Power-Crystals-Seite. Bitte Anmeldung/Cloudflare prüfen.');
        }
        const nextState = parsePageState(nextDoc, metadata);
        if (nextState.error) throw new Error(nextState.error);
        liveState = nextState;
        return nextState;
      }
      throw lastError || new Error('Anfrage fehlgeschlagen.');
    }

    async function moveCrystal(crystalId, targetEquipmentKey, targetCrystalId) {
      if (busy) return;
      const crystal = liveState.crystalById.get(Number(crystalId));
      if (!crystal) return setStatus('Der gewählte Crystal wurde nicht gefunden.', 'error');
      const source = currentEquipmentForCrystal(crystal.id);
      const plan = planCrystalMove({
        crystalId: crystal.id,
        sourceEquipmentKey: source?.key || null,
        targetEquipmentKey,
        targetCrystalId,
      });
      if (!plan.length) return setStatus('Crystal ist bereits auf diesem Equipment; die drei Slots sind gleichwertig.');
      if (targetCrystalId) {
        const targetCrystal = liveState.crystalById.get(Number(targetCrystalId));
        const wording = source ? 'zwischen den Equipmentteilen tauschen' : 'ersetzen und freigeben';
        if (!win.confirm?.(`${crystal.name} mit ${targetCrystal?.name || 'dem belegten Crystal'} ${wording}?`)) return;
      }
      setBusy(true);
      let reloadScheduled = false;
      try {
        for (let index = 0; index < plan.length; index += 1) {
          const step = plan[index];
          setStatus(`Crystal-Zuordnung ${index + 1}/${plan.length} …`);
          if (step.action === 'unequip') {
            await postMutation({ action: 'unequip_crystal', crystal_id: step.crystalId });
            if (currentEquipmentForCrystal(step.crystalId)) {
              throw new Error('Server hat das Entfernen des Crystals nicht bestätigt.');
            }
          } else {
            const target = liveState.equipment.find((item) => item.key === step.equipmentKey);
            if (!target?.id) throw new Error('Equipment-ID konnte nach dem Freigeben des Slots nicht gelesen werden.');
            await postMutation({ action: 'equip_crystal', crystal_id: step.crystalId, equipment_inv_id: target.id });
            const assigned = currentEquipmentForCrystal(step.crystalId);
            if (assigned?.key !== step.equipmentKey) {
              throw new Error('Server hat das Einsetzen des Crystals nicht bestätigt.');
            }
          }
          if (index + 1 < plan.length) await sleep(250);
        }
        reloadScheduled = true;
        rememberAndReload(plan.length > 2 ? 'Crystals wurden erfolgreich getauscht.' : 'Crystal wurde erfolgreich eingesetzt.');
      } catch (error) {
        reloadScheduled = true;
        setStatus(`Zuordnung gestoppt: ${error?.message || error}. Seite wird zur sicheren Synchronisierung neu geladen.`, 'error');
        try { win.sessionStorage?.setItem(RESULT_KEY, JSON.stringify({ message: `Zuordnung gestoppt: ${error?.message || error}`, kind: 'error' })); } catch {}
        win.setTimeout?.(() => win.location?.reload?.(), 1200);
      } finally {
        if (!reloadScheduled) setBusy(false);
      }
    }

    async function releaseCrystal(crystalId) {
      if (busy) return;
      const crystal = liveState.crystalById.get(Number(crystalId));
      const source = crystal ? currentEquipmentForCrystal(crystal.id) : null;
      if (!crystal || !source) return setStatus('Der Crystal ist bereits verfügbar.');
      if (!win.confirm?.(`${crystal.name} von ${source.name} entfernen und verfügbar machen?`)) return;
      setBusy(true);
      let reloadScheduled = false;
      try {
        setStatus('Crystal wird vom Equipment entfernt …');
        await postMutation({ action: 'unequip_crystal', crystal_id: crystal.id });
        if (currentEquipmentForCrystal(crystal.id)) {
          throw new Error('Server hat das Entfernen des Crystals nicht bestätigt.');
        }
        reloadScheduled = true;
        rememberAndReload('Crystal wurde entfernt und ist jetzt verfügbar.');
      } catch (error) {
        reloadScheduled = true;
        const message = `Entfernen gestoppt: ${error?.message || error}`;
        try { win.sessionStorage?.setItem(RESULT_KEY, JSON.stringify({ message, kind: 'error' })); } catch {}
        setStatus(`${message}. Seite wird aktualisiert …`, 'error');
        win.setTimeout?.(() => win.location?.reload?.(), 1200);
      } finally {
        if (!reloadScheduled) setBusy(false);
      }
    }

    async function runUpgrade(kind, crystalId, requestedSteps) {
      if (busy) return;
      const crystal = liveState.crystalById.get(Number(crystalId));
      if (!crystal) return;
      const current = kind === 'level' ? crystal.level : crystal.stars;
      const maximum = kind === 'level' ? crystal.maxLevel : crystal.maxStars;
      const steps = Math.min(Math.max(1, Number(requestedSteps) || 1), Math.max(0, maximum - current));
      if (steps <= 0) return setStatus('Der Crystal hat bereits den Maximalwert.');
      const map = kind === 'level' ? liveState.levelData : liveState.starData;
      const first = map[String(crystal.id)];
      if (!upgradeAffordable(first, liveState.gold)) return setStatus('Für den nächsten Upgrade-Schritt fehlen Gold oder Materialien.', 'error');
      const unit = kind === 'level' ? 'Level' : 'Stern(e)';
      const prompt = `${crystal.name} um bis zu ${steps} ${unit} erhöhen?\n\nJeder Schritt wird einzeln geprüft. Das Skript stoppt automatisch bei fehlenden Ressourcen oder am Maximalwert.`;
      if (!win.confirm?.(prompt)) return;
      setBusy(true);
      let completed = 0;
      let stopReason = '';
      let reloadScheduled = false;
      try {
        while (completed < steps) {
          const dataMap = kind === 'level' ? liveState.levelData : liveState.starData;
          const data = dataMap[String(crystal.id)];
          if (!data) {
            stopReason = 'Maximalwert erreicht';
            break;
          }
          if (!upgradeAffordable(data, liveState.gold)) {
            stopReason = 'nicht genug Gold oder Materialien';
            break;
          }
          const before = Number(data.expected_current);
          setStatus(`${kind === 'level' ? 'Level' : 'Sterne'} erhöhen: Schritt ${completed + 1}/${steps} …`);
          await postMutation({
            action: data.action,
            expected_current: data.expected_current,
            crystal_id: crystal.id,
          });
          const updated = liveState.crystalById.get(crystal.id);
          const after = kind === 'level' ? updated?.level : updated?.stars;
          if (!Number.isFinite(after) || after <= before) throw new Error('Server hat den Upgrade-Schritt nicht bestätigt.');
          completed += 1;
          if (completed < steps) await sleep(300);
        }
        const suffix = stopReason ? `; Stopp: ${stopReason}.` : '.';
        reloadScheduled = true;
        rememberAndReload(`${completed} von ${steps} Upgrade-Schritten abgeschlossen${suffix}`);
      } catch (error) {
        reloadScheduled = true;
        const message = `${completed} Schritt(e) bestätigt; danach gestoppt: ${error?.message || error}`;
        try { win.sessionStorage?.setItem(RESULT_KEY, JSON.stringify({ message, kind: 'error' })); } catch {}
        setStatus(`${message}. Seite wird aktualisiert …`, 'error');
        win.setTimeout?.(() => win.location?.reload?.(), 1200);
      } finally {
        if (!reloadScheduled) setBusy(false);
      }
    }

    typeSelect.addEventListener('change', () => { typeFilter = typeSelect.value; renderEquipment(); });
    setSelect.addEventListener('change', () => { setFilter = setSelect.value; renderEquipment(); });
    searchInput.addEventListener('input', () => { searchFilter = searchInput.value; renderEquipment(); });
    root.querySelector('[data-action="reload"]').addEventListener('click', () => win.location?.reload?.());
    availableList.addEventListener('dragover', (event) => {
      event.preventDefault();
      availableList.classList.add('pcq-dragover');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    availableList.addEventListener('dragleave', () => availableList.classList.remove('pcq-dragover'));
    availableList.addEventListener('drop', (event) => {
      event.preventDefault();
      availableList.classList.remove('pcq-dragover');
      const crystalId = numberFromText(event.dataTransfer?.getData('text/plain'), selectedCrystalId || 0);
      if (crystalId) releaseCrystal(crystalId);
    });

    render();

    // The Power Crystals DOM exposes inventory IDs but no item names/types.
    // Enrich from inventory.php when that page exposes a matching inventory ID;
    // filename-based type/set inference remains the safe fallback.
    try {
      const inventoryDoc = await ctx.fetchDocument(new URL('/inventory.php', ctx.url).href, {
        fetchImpl: win.fetch?.bind(win),
        DOMParserImpl: win.DOMParser,
      });
      const exact = parseInventoryMetadata(inventoryDoc);
      if (exact.size) {
        for (const [key, value] of exact) metadata.set(key, value);
        liveState = parsePageState(liveState.doc, metadata);
        render();
      }
    } catch (error) {
      ctx.warn?.('Equipment metadata enrichment failed; using image names.', error);
    }
  },
});
