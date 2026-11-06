'use strict';

const { injectStyle, textOf } = require('./dom');

const ROOT_ID = 'veyra-shadow-army-manager';
const STYLE_ID = `${ROOT_ID}-style`;

const CSS = `
  #${ROOT_ID} { background: linear-gradient(180deg, rgba(19,25,43,.98), rgba(10,14,24,.98)); border: 1px solid rgba(139,92,246,.28); border-radius: 24px; box-shadow: 0 18px 48px rgba(0,0,0,.38); color: #eef4ff; margin-bottom: 22px; padding: 20px; }
  #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; }
  #${ROOT_ID} h2, #${ROOT_ID} h3, #${ROOT_ID} p { margin: 0; }
  #${ROOT_ID} .sam-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 14px; }
  #${ROOT_ID} .sam-head h2 { font-size: 24px; }
  #${ROOT_ID} .sam-help { color: #9eabc8; font-size: 12px; line-height: 1.5; margin-top: 5px; }
  #${ROOT_ID} .sam-summary { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
  #${ROOT_ID} .sam-chip { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); border-radius: 999px; color: #dce5fb; font-size: 11px; padding: 5px 9px; }
  #${ROOT_ID} .sam-status { background: rgba(110,168,255,.09); border: 1px solid rgba(110,168,255,.22); border-radius: 10px; color: #d8e4ff; margin-bottom: 16px; min-height: 38px; padding: 9px 11px; }
  #${ROOT_ID} .sam-section + .sam-section { margin-top: 20px; }
  #${ROOT_ID} .sam-section-head { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; margin-bottom: 9px; }
  #${ROOT_ID} .sam-section-head h3 { font-size: 17px; }
  #${ROOT_ID} .sam-count { color: #92a1c2; font-size: 11px; }
  #${ROOT_ID} .sam-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(285px, 1fr)); }
  #${ROOT_ID} .sam-card { background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.1); border-radius: 15px; display: grid; gap: 10px; grid-template-columns: 62px minmax(0,1fr); padding: 10px; }
  #${ROOT_ID} .sam-card.sam-elite { border-color: rgba(183,148,255,.28); }
  #${ROOT_ID} .sam-art { background: #090e19; border: 1px solid rgba(255,255,255,.09); border-radius: 12px; height: 62px; object-fit: cover; width: 62px; }
  #${ROOT_ID} .sam-body { min-width: 0; }
  #${ROOT_ID} .sam-title { font-size: 13px; font-weight: 800; overflow-wrap: anywhere; }
  #${ROOT_ID} .sam-meta { color: #93a2c3; font-size: 10px; margin-top: 2px; }
  #${ROOT_ID} .sam-action { align-items: center; background: rgba(0,0,0,.18); border-radius: 9px; display: grid; gap: 6px; grid-template-columns: minmax(0,1fr) auto auto; margin-top: 7px; padding: 6px; }
  #${ROOT_ID} .sam-value { font-size: 12px; font-weight: 800; }
  #${ROOT_ID} .sam-resource { color: #bdc9e7; font-size: 10px; text-align: right; white-space: nowrap; }
  #${ROOT_ID} .sam-plus { align-items: center; background: #4d3a90; border: 1px solid #8569db; border-radius: 8px; color: #fff; cursor: pointer; display: inline-flex; font-size: 18px; font-weight: 900; height: 30px; justify-content: center; padding: 0; width: 32px; }
  #${ROOT_ID} .sam-plus.sam-star { background: #806020; border-color: #c99b3d; }
  #${ROOT_ID} .sam-plus:disabled { cursor: not-allowed; opacity: .38; }
  #${ROOT_ID}[aria-busy="true"] button { pointer-events: none; opacity: .45; }
  #${ROOT_ID} .sam-empty { color: #93a2c3; font-size: 12px; padding: 10px 2px; }
  @media (max-width: 520px) {
    #${ROOT_ID} { border-radius: 16px; padding: 13px; }
    #${ROOT_ID} .sam-grid { grid-template-columns: 1fr; }
    #${ROOT_ID} .sam-card { grid-template-columns: 50px minmax(0,1fr); padding: 8px; }
    #${ROOT_ID} .sam-art { height: 50px; width: 50px; }
    #${ROOT_ID} .sam-action { grid-template-columns: minmax(0,1fr) auto; }
    #${ROOT_ID} .sam-resource { grid-column: 1 / -1; grid-row: 2; text-align: left; }
    #${ROOT_ID} .sam-plus { grid-column: 2; grid-row: 1 / span 2; }
  }
`;

function integer(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
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
  let quote = '';
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) depth -= 1;
    if (depth !== 0) continue;
    try {
      return JSON.parse(text.slice(start, index + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function parseResourceAssignment(source, variableName) {
  const text = String(source ?? '');
  const marker = new RegExp(`\\b(?:const|let|var)\\s+${variableName}\\s*=\\s*\\{`).exec(text);
  if (!marker) return null;
  const body = text.slice(marker.index + marker[0].length, text.indexOf('};', marker.index));
  if (!body) return null;
  const count = body.match(/\bcount\s*:\s*(\d+)/);
  const exp = body.match(/\bexp\s*:\s*(\d+)/);
  const name = body.match(/\bname\s*:\s*(["'])(.*?)\1/);
  return {
    count: integer(count?.[1]),
    exp: integer(exp?.[1]),
    name: String(name?.[2] || variableName),
  };
}

function inlineValue(doc, variableName, parser, fallback) {
  for (const script of doc?.querySelectorAll?.('script') || []) {
    const parsed = parser(script.textContent, variableName);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function normalizeUnit(raw, type) {
  const id = integer(raw?.inv_id);
  return {
    id,
    type,
    title: String(raw?.title || `Shadow ${id}`),
    image: String(raw?.image || ''),
    rank: String(raw?.rank || (type === 'special' ? 'Elite Shadow' : 'Normal Shadow')),
    level: Math.max(1, integer(raw?.level, 1)),
    maxLevel: Math.max(1, integer(raw?.max_level, 1)),
    stars: Math.max(0, integer(raw?.stars)),
    starsText: String(raw?.stars_text || '★'.repeat(Math.max(0, integer(raw?.stars)))),
    copiesNeeded: Math.max(0, integer(raw?.copies_needed)),
    extraCopies: Math.max(0, integer(raw?.extra_copies)),
    canStarUp: raw?.can_star_up === true,
    sacrificeCandidates: (Array.isArray(raw?.sacrifice_candidates) ? raw.sacrifice_candidates : [])
      .map((candidate) => ({ id: integer(candidate?.inv_id), level: integer(candidate?.level) }))
      .filter((candidate) => candidate.id > 0 && candidate.id !== id),
  };
}

function normalStarPlan(unit) {
  const needed = Math.max(0, integer(unit?.copiesNeeded));
  const availableIds = (unit?.sacrificeCandidates || [])
    .filter((candidate) => integer(candidate.level) === 1 && integer(candidate.id) > 0)
    .map((candidate) => integer(candidate.id))
    .sort((left, right) => left - right);
  return {
    needed,
    available: availableIds.length,
    sacrificeIds: availableIds.slice(0, needed),
    canSubmit: unit?.canStarUp === true && needed > 0 && availableIds.length >= needed,
  };
}

function parsePageState(doc) {
  const specialData = inlineValue(doc, 'specialUnits', parseJsonAssignment, {});
  const normalData = inlineValue(doc, 'normalUnits', parseJsonAssignment, {});
  const specialScroll = inlineValue(doc, 'captainShadowScroll', parseResourceAssignment, { count: 0, exp: 0, name: 'Shadow EXP Scroll' });
  const normalScroll = inlineValue(doc, 'normalShadowScroll', parseResourceAssignment, { count: 0, exp: 0, name: 'Small Shadow EXP Scroll' });
  const allNormal = Object.values(normalData || {}).map((unit) => normalizeUnit(unit, 'normal')).filter((unit) => unit.id > 0);
  const elite = Object.values(specialData || {})
    .map((unit) => normalizeUnit(unit, 'special'))
    .filter((unit) => unit.id > 0)
    .sort((left, right) => left.title.localeCompare(right.title));
  const normal = allNormal
    .filter((unit) => unit.level > 1)
    .sort((left, right) => right.level - left.level || left.title.localeCompare(right.title) || left.id - right.id);
  return {
    elite,
    normal,
    levelOneVictims: allNormal.filter((unit) => unit.level === 1).length,
    specialScroll,
    normalScroll,
  };
}

function actionPayload(unit, kind) {
  const payload = {
    action: kind === 'level' ? 'use_shadow_exp_scroll' : 'star_up_unit',
    unit_type: unit.type,
    unit_id: String(unit.id),
    selected_sacrifice_ids: '',
    item_inv_id: '',
    scroll_qty: kind === 'level' ? '1' : '',
  };
  if (kind === 'star' && unit.type === 'normal') {
    payload.selected_sacrifice_ids = normalStarPlan(unit).sacrificeIds.join(',');
  }
  return payload;
}

function panelByTitle(doc, title) {
  const wanted = String(title).toLowerCase();
  return [...(doc?.querySelectorAll?.('section.panel') || [])].find((panel) =>
    textOf(panel.querySelector?.('.panel-head h2, h2')).toLowerCase() === wanted,
  ) || null;
}

function element(doc, tag, className = '', text = '') {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function fillAndSubmit(form, payload) {
  for (const [name, value] of Object.entries(payload)) {
    const input = form?.querySelector?.(`[name="${name}"]`);
    if (!input) return false;
    input.value = String(value ?? '');
  }
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else if (typeof form.submit === 'function') form.submit();
  else return false;
  return true;
}

module.exports = Object.freeze({
  id: 'shadow-army-manager',
  group: 'General',
  settings: [
    {
      key: 'veyra:shadowArmy:managerEnabled',
      label: 'Shadow Army manager',
      type: 'checkbox',
      default: true,
      hint: 'Replaces the long Shadow lists with compact Level/Star controls. Level-1 normal Shadows are used only as sacrifices.',
    },
  ],
  enabledBy: 'veyra:shadowArmy:managerEnabled',
  actionPayload,
  fillAndSubmit,
  normalStarPlan,
  parseJsonAssignment,
  parsePageState,
  parseResourceAssignment,

  matches(url) {
    return /\/shadow_army\.php$/i.test(url.pathname);
  },

  run({ doc, win }) {
    const pageWrap = doc?.querySelector?.('.page-wrap');
    const form = doc?.querySelector?.('#unitActionForm');
    if (!pageWrap || !form || doc.getElementById?.(ROOT_ID)) return;
    const state = parsePageState(doc);
    if (state.elite.length === 0 && state.normal.length === 0) return;

    injectStyle(doc, STYLE_ID, CSS);
    const root = element(doc, 'section');
    root.id = ROOT_ID;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `
      <div class="sam-head"><div><h2>☠ Shadow Manager</h2><p class="sam-help">Elite Shadows and normal Shadows above level 1. Level-1 normal Shadows stay hidden and are reserved as safe Star-Up sacrifices.</p></div></div>
      <div class="sam-summary"></div>
      <div class="sam-status" role="status">Ready. Each Level + uses one matching EXP scroll.</div>
      <div class="sam-sections"></div>`;

    const summary = root.querySelector('.sam-summary');
    const status = root.querySelector('.sam-status');
    const sections = root.querySelector('.sam-sections');
    const chips = [
      `Elite: ${state.elite.length}`,
      `Normal above Lv. 1: ${state.normal.length}`,
      `Level-1 sacrifices: ${state.levelOneVictims}`,
      `Elite scrolls: ${state.specialScroll.count}`,
      `Normal scrolls: ${state.normalScroll.count}`,
    ];
    for (const label of chips) summary.appendChild(element(doc, 'span', 'sam-chip', label));

    const submit = (unit, kind) => {
      const scroll = unit.type === 'special' ? state.specialScroll : state.normalScroll;
      const plan = normalStarPlan(unit);
      let prompt = '';
      if (kind === 'level') {
        prompt = `Use 1 ${scroll.name} on ${unit.title}? (${scroll.count} available)`;
      } else if (unit.type === 'special') {
        prompt = `Star up ${unit.title} using ${unit.copiesNeeded} extra copies?`;
      } else {
        prompt = `Star up ${unit.title} by sacrificing ${plan.needed} level-1 normal Shadows?`;
      }
      if (!win.confirm?.(prompt)) return;
      root.setAttribute('aria-busy', 'true');
      status.textContent = `${kind === 'level' ? 'Applying EXP scroll to' : 'Starring up'} ${unit.title} …`;
      if (!fillAndSubmit(form, actionPayload(unit, kind))) {
        root.setAttribute('aria-busy', 'false');
        status.textContent = 'The game action form is incomplete. Nothing was submitted.';
      }
    };

    const actionRow = (unit, kind) => {
      const row = element(doc, 'div', 'sam-action');
      const isLevel = kind === 'level';
      const scroll = unit.type === 'special' ? state.specialScroll : state.normalScroll;
      const plan = normalStarPlan(unit);
      const value = isLevel
        ? `Level ${unit.level} / ${unit.maxLevel}`
        : `Stars ${unit.starsText || unit.stars}`;
      let resource;
      let enabled;
      if (isLevel) {
        resource = `Scrolls: ${scroll.count}`;
        enabled = scroll.count > 0 && unit.level < unit.maxLevel;
      } else if (unit.type === 'special') {
        resource = `Copies: ${unit.extraCopies} / ${unit.copiesNeeded}`;
        enabled = unit.canStarUp && unit.copiesNeeded > 0 && unit.extraCopies >= unit.copiesNeeded;
      } else {
        resource = `Lv. 1 sacrifices: ${plan.available} / ${plan.needed}`;
        enabled = plan.canSubmit;
      }
      const button = element(doc, 'button', `sam-plus${isLevel ? '' : ' sam-star'}`, '+');
      button.type = 'button';
      button.disabled = !enabled;
      button.title = isLevel ? `Use one ${scroll.name}` : 'Raise this Shadow by one star';
      button.setAttribute('aria-label', `${isLevel ? 'Level' : 'Star'} up ${unit.title}`);
      button.addEventListener('click', () => submit(unit, kind));
      row.append(element(doc, 'span', 'sam-value', value), element(doc, 'span', 'sam-resource', resource), button);
      return row;
    };

    const card = (unit) => {
      const node = element(doc, 'article', `sam-card${unit.type === 'special' ? ' sam-elite' : ''}`);
      const image = element(doc, 'img', 'sam-art');
      image.src = unit.image;
      image.alt = '';
      image.loading = 'lazy';
      const body = element(doc, 'div', 'sam-body');
      body.append(
        element(doc, 'div', 'sam-title', unit.title),
        element(doc, 'div', 'sam-meta', `${unit.type === 'special' ? unit.rank : 'Normal Shadow'} · Inventory #${unit.id}`),
        actionRow(unit, 'level'),
        actionRow(unit, 'star'),
      );
      node.append(image, body);
      return node;
    };

    const section = (title, units) => {
      const node = element(doc, 'section', 'sam-section');
      const head = element(doc, 'div', 'sam-section-head');
      head.append(element(doc, 'h3', '', title), element(doc, 'span', 'sam-count', `${units.length} shown`));
      node.appendChild(head);
      if (!units.length) {
        node.appendChild(element(doc, 'div', 'sam-empty', 'No matching Shadows.'));
      } else {
        const grid = element(doc, 'div', 'sam-grid');
        for (const unit of units) grid.appendChild(card(unit));
        node.appendChild(grid);
      }
      sections.appendChild(node);
    };

    section('Elite Shadows', state.elite);
    section('Normal Shadows above level 1', state.normal);
    pageWrap.insertBefore(root, pageWrap.querySelector?.('section.panel') || pageWrap.firstChild);

    for (const title of ['Special Shadows', 'Normal Shadows']) {
      const original = panelByTitle(doc, title);
      if (original) original.style.display = 'none';
    }
  },
});
