'use strict';

const PANEL_ID = 'veyra-shadowbridge-progress';
const STYLE_ID = `${PANEL_ID}-style`;

const STYLES = `
  #${PANEL_ID} {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483645;
    width: min(440px, calc(100vw - 32px)); max-height: min(620px, calc(100dvh - 32px));
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid rgba(129,140,248,.38); border-radius: 14px;
    background: rgba(20,21,33,.97); box-shadow: 0 18px 48px rgba(0,0,0,.62);
    color: #f4f5ff; font: 13px/1.35 Arial,system-ui,sans-serif;
  }
  #${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; }
  #${PANEL_ID}[data-state="error"] { border-color: rgba(248,113,113,.62); }
  #${PANEL_ID}[data-state="done"] { border-color: rgba(74,222,128,.48); }
  #${PANEL_ID} .sbp-head {
    display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: start;
    padding: 12px 12px 10px; border-bottom: 1px solid rgba(255,255,255,.09);
  }
  #${PANEL_ID} .sbp-title { font-size: 14px; font-weight: 900; }
  #${PANEL_ID} .sbp-summary { margin-top: 3px; color: #aeb5d5; font-size: 11px; overflow-wrap: anywhere; }
  #${PANEL_ID} .sbp-toggle {
    width: 34px; height: 32px; padding: 0; border: 1px solid #3b3e59; border-radius: 9px;
    background: #292b40; color: #fff; font: 900 17px/1 Arial,sans-serif; cursor: pointer;
  }
  #${PANEL_ID} .sbp-list { min-height: 0; overflow-y: auto; padding: 10px; display: grid; gap: 8px; }
  #${PANEL_ID}[data-collapsed="true"] .sbp-list { display: none; }
  #${PANEL_ID}[data-collapsed="true"] .sbp-head { border-bottom: 0; }
  #${PANEL_ID} .sbp-row {
    display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 6px 10px;
    padding: 9px 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(255,255,255,.035);
  }
  #${PANEL_ID} .sbp-row[data-status="active"] { border-color: rgba(129,140,248,.65); background: rgba(99,102,241,.12); }
  #${PANEL_ID} .sbp-row[data-status="completed"] { border-color: rgba(74,222,128,.30); }
  #${PANEL_ID} .sbp-row[data-status="error"] { border-color: rgba(248,113,113,.55); }
  #${PANEL_ID} .sbp-name { min-width: 0; font-size: 12px; font-weight: 850; overflow-wrap: anywhere; }
  #${PANEL_ID} .sbp-meta, #${PANEL_ID} .sbp-progress-text { color: #9da5c8; font-size: 10px; }
  #${PANEL_ID} .sbp-badge {
    align-self: start; padding: 3px 7px; border-radius: 999px; background: #343750;
    color: #cdd2eb; font-size: 9px; font-weight: 900; letter-spacing: .05em; text-transform: uppercase;
  }
  #${PANEL_ID} .sbp-row[data-status="active"] .sbp-badge { background: #4f46e5; color: #fff; }
  #${PANEL_ID} .sbp-row[data-status="completed"] .sbp-badge { background: #176b3a; color: #c8fbd9; }
  #${PANEL_ID} .sbp-row[data-status="error"] .sbp-badge { background: #7f1d1d; color: #fee2e2; }
  #${PANEL_ID} .sbp-bar { grid-column: 1 / -1; height: 7px; overflow: hidden; border-radius: 999px; background: #303349; }
  #${PANEL_ID} .sbp-fill { height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg,#6366f1,#22d3ee); transition: width .15s ease; }
  #${PANEL_ID} .sbp-row[data-status="completed"] .sbp-fill { background: #36c978; }
  #${PANEL_ID} .sbp-row[data-status="error"] .sbp-fill { background: #ef6464; }
  #${PANEL_ID} .sbp-progress-text { grid-column: 1 / -1; }
  @media (max-width: 520px) {
    #${PANEL_ID} { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 52dvh; }
  }
  @media (prefers-reduced-motion: reduce) {
    #${PANEL_ID} .sbp-fill { transition: none; }
  }
`;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatNumber(value) {
  const number = finiteNonNegative(value);
  return number === null ? '—' : Math.round(number).toLocaleString('en-US');
}

function modeLabel(mode) {
  return ({
    'max-loot': 'Max loot',
    'max-exp': 'Max EXP',
    custom: 'Custom damage',
    kill: 'Kill',
  })[String(mode || '')] || 'Target';
}

function progressDetails(entry = {}) {
  const status = String(entry.status || 'queued');
  if (status === 'completed') {
    return { percent: 100, text: entry.result || 'Completed' };
  }
  if (status === 'error') {
    return { percent: 100, text: entry.error || 'Attack failed' };
  }

  const currentDamage = finiteNonNegative(entry.currentDamage);
  const targetDamage = finiteNonNegative(entry.targetDamage);
  if (targetDamage !== null && targetDamage > 0) {
    const current = currentDamage ?? 0;
    return {
      percent: Math.min(100, Math.max(0, current / targetDamage * 100)),
      text: `${formatNumber(current)} / ${formatNumber(targetDamage)} own damage · ${Math.max(0, Number(entry.attacks) || 0)} attack(s)`,
    };
  }

  const currentHp = finiteNonNegative(entry.currentHp);
  const maxHp = finiteNonNegative(entry.maxHp);
  if (maxHp !== null && maxHp > 0 && currentHp !== null) {
    return {
      percent: Math.min(100, Math.max(0, (maxHp - currentHp) / maxHp * 100)),
      text: `${formatNumber(currentHp)} / ${formatNumber(maxHp)} monster HP · ${Math.max(0, Number(entry.attacks) || 0)} attack(s)`,
    };
  }

  return {
    percent: status === 'active' ? 5 : 0,
    text: status === 'active' ? `Preparing attack · ${Math.max(0, Number(entry.attacks) || 0)} attack(s)` : 'Waiting',
  };
}

function createShadowbridgeStatusView(doc) {
  const state = {
    active: false,
    collapsed: false,
    phase: 'working',
    summary: '',
    order: [],
    entries: new Map(),
  };

  const canRender = Boolean(doc?.createElement && (doc.body || doc.documentElement));
  let panel = null;
  let list = null;
  let summary = null;
  let toggle = null;

  function make(tagName, className = '', text = '') {
    const element = doc.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function replaceChildren(element, ...children) {
    if (typeof element?.replaceChildren === 'function') {
      element.replaceChildren(...children);
      return;
    }
    while (element?.firstChild) element.removeChild(element.firstChild);
    for (const child of children) element?.appendChild?.(child);
  }

  function ensurePanel() {
    if (!canRender || panel) return panel;
    if (!doc.getElementById?.(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLES;
      (doc.head || doc.documentElement || doc.body)?.appendChild?.(style);
    }
    panel = make('section');
    panel.id = PANEL_ID;
    panel.setAttribute?.('role', 'status');
    panel.setAttribute?.('aria-live', 'polite');
    panel.dataset.state = state.phase;
    panel.dataset.collapsed = 'false';

    const head = make('div', 'sbp-head');
    const copy = make('div');
    copy.appendChild(make('div', 'sbp-title', 'Shadowbridge attack progress'));
    summary = make('div', 'sbp-summary', state.summary || 'Scanning dungeon…');
    copy.appendChild(summary);
    toggle = make('button', 'sbp-toggle', '−');
    toggle.type = 'button';
    toggle.title = 'Collapse progress';
    toggle.setAttribute?.('aria-label', 'Collapse Shadowbridge progress');
    toggle.addEventListener?.('click', () => {
      state.collapsed = !state.collapsed;
      panel.dataset.collapsed = String(state.collapsed);
      toggle.textContent = state.collapsed ? '+' : '−';
      toggle.title = state.collapsed ? 'Expand progress' : 'Collapse progress';
      toggle.setAttribute?.('aria-label', toggle.title);
    });
    head.appendChild(copy);
    head.appendChild(toggle);
    list = make('div', 'sbp-list');
    panel.appendChild(head);
    panel.appendChild(list);
    (doc.body || doc.documentElement).appendChild(panel);
    return panel;
  }

  function render() {
    if (!state.active || !ensurePanel()) return;
    panel.dataset.state = state.phase;
    panel.dataset.collapsed = String(state.collapsed);
    summary.textContent = state.summary || 'Shadowbridge is working…';
    const rows = [];
    for (const key of state.order) {
      const entry = state.entries.get(key);
      if (!entry) continue;
      const details = progressDetails(entry);
      const row = make('article', 'sbp-row');
      row.dataset.key = key;
      row.dataset.status = entry.status || 'queued';
      const nameWrap = make('div');
      nameWrap.appendChild(make('div', 'sbp-name', entry.name || 'Shadowbridge monster'));
      const meta = [entry.locationLabel, modeLabel(entry.mode)].filter(Boolean).join(' · ');
      nameWrap.appendChild(make('div', 'sbp-meta', meta));
      row.appendChild(nameWrap);
      const badgeText = ({ queued: 'Queued', active: 'Attacking', completed: 'Done', error: 'Error' })[entry.status] || 'Queued';
      row.appendChild(make('div', 'sbp-badge', badgeText));
      const bar = make('div', 'sbp-bar');
      const fill = make('div', 'sbp-fill');
      fill.style.width = `${details.percent.toFixed(1)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(make('div', 'sbp-progress-text', details.text));
      rows.push(row);
    }
    replaceChildren(list, ...rows);
  }

  function begin(message = 'Scanning Shadowbridge…') {
    state.active = true;
    state.phase = 'working';
    state.summary = String(message || '');
    render();
  }

  function setPlan(plan = []) {
    state.active = true;
    for (const target of plan) {
      const key = String(target?.key || '');
      if (!key) continue;
      if (!state.entries.has(key)) state.order.push(key);
      const existing = state.entries.get(key) || {};
      state.entries.set(key, {
        status: 'queued',
        attacks: 0,
        ...existing,
        key,
        name: String(target.name || existing.name || 'Shadowbridge monster'),
        locationLabel: String(target.location?.label || existing.locationLabel || ''),
        mode: String(target.target?.mode || existing.mode || ''),
      });
    }
    render();
  }

  function updateTarget(key, patch = {}) {
    const wanted = String(key || '');
    if (!wanted) return;
    if (!state.entries.has(wanted)) state.order.push(wanted);
    state.entries.set(wanted, { key: wanted, status: 'queued', attacks: 0, ...(state.entries.get(wanted) || {}), ...patch });
    render();
  }

  function setSummary(message, phase = state.phase) {
    if (!state.active) return;
    state.summary = String(message || '');
    state.phase = String(phase || 'working');
    render();
  }

  function finish(message, phase = 'done') {
    if (!state.active) return;
    state.summary = String(message || '');
    state.phase = String(phase || 'done');
    render();
  }

  function snapshot() {
    return {
      active: state.active,
      phase: state.phase,
      summary: state.summary,
      entries: state.order.map((key) => ({ ...state.entries.get(key), progress: progressDetails(state.entries.get(key)) })),
    };
  }

  function destroy() {
    panel?.remove?.();
    panel = null;
    list = null;
    summary = null;
    toggle = null;
    state.active = false;
  }

  return { begin, destroy, finish, setPlan, setSummary, snapshot, updateTarget };
}

module.exports = {
  PANEL_ID,
  STYLE_ID,
  createShadowbridgeStatusView,
  progressDetails,
};
