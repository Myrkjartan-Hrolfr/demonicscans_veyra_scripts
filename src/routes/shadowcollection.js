'use strict';

const TARGETS = Object.freeze([
  ['vanguard', 'Lizardman Vanguard'],
  ['warmage', 'Lizardman Warmage'],
  ['dreadblade', 'Lizardman Dreadblade'],
  ['juggernaut', 'Lizardman Juggernaut'],
  ['bloodpriest', 'Lizardman Bloodpriest'],
  ['guardian', 'Lizardman Guardian'],
  ['skarn', 'General Skarn the Radiant Bastion'],
  ['vessir', 'General Vessir the Sunfang Duelist'],
  ['hrazz', 'General Hrazz the Dawnflame Oathkeeper'],
  ['drakzareth', 'Drakzareth The Tyrant Lizard King'],
].map(([id, name]) => Object.freeze({ id, name })));
const TARGET_BY_ID = new Map(TARGETS.map((target) => [target.id, target]));
const MAX_TARGETS = 5;
const LOG_KEY = 'veyra:shadowcollection:log:v1';

function normalizeSettings(value) {
  const rows = [];
  let remaining = MAX_TARGETS;
  for (let index = 0; index < MAX_TARGETS; index += 1) {
    const saved = value?.rows?.[index];
    const targetId = TARGET_BY_ID.has(saved?.targetId) ? saved.targetId : '';
    const requested = Math.max(0, Math.min(MAX_TARGETS, Math.trunc(Number(saved?.quantity)) || 0));
    const quantity = targetId ? Math.min(remaining, requested) : 0;
    remaining -= quantity;
    rows.push({ targetId, quantity });
  }
  return { rows };
}

function renderSettings(ctx) {
  ctx.addSectionTitle('Daily Shadow Collection');
  ctx.container.appendChild(ctx.make('div', {
    className: ctx.cls('hint'),
    text: 'Choose up to five Gate 3 monsters in total. Once per day the route hits each selected live monster with exactly one Slash. Dead tagged monsters are checked and their shadows extracted.',
  }));
  const controls = [];
  const totalLabel = ctx.make('div', { className: ctx.cls('hint') });
  const syncControls = () => {
    controls.forEach(({ select, quantity }, index) => {
      const row = ctx.settings.rows[index];
      select.value = row.targetId;
      quantity.value = String(row.quantity);
    });
    const total = ctx.settings.rows.reduce((sum, row) => sum + row.quantity, 0);
    totalLabel.textContent = `Configured total: ${total} / ${MAX_TARGETS}`;
  };
  ctx.settings.rows.forEach((row, index) => {
    const host = ctx.make('div', { className: ctx.cls('setting') });
    const select = ctx.make('select', { id: `${ctx.idPrefix}-target-${index}`, className: ctx.cls('select') });
    const empty = ctx.make('option', { text: '— No monster —' });
    empty.value = '';
    select.appendChild(empty);
    for (const target of TARGETS) {
      const option = ctx.make('option', { text: target.name });
      option.value = target.id;
      select.appendChild(option);
    }
    select.value = row.targetId;
    select.addEventListener('change', () => {
      ctx.settings = ctx.updateSettings((settings) => { settings.rows[index].targetId = select.value; });
      syncControls();
    });
    host.appendChild(ctx.make('label', { text: `Monster ${index + 1}` }));
    host.appendChild(select);
    const quantity = ctx.make('input', {
      id: `${ctx.idPrefix}-quantity-${index}`,
      className: ctx.cls('input'),
      type: 'number',
    });
    quantity.min = '0';
    quantity.max = '5';
    quantity.step = '1';
    quantity.value = String(row.quantity);
    quantity.addEventListener('change', () => {
      ctx.settings = ctx.updateSettings((settings) => { settings.rows[index].quantity = quantity.value; });
      syncControls();
    });
    host.appendChild(ctx.make('label', { text: 'Daily amount (total max. 5)' }));
    host.appendChild(quantity);
    ctx.container.appendChild(host);
    controls.push({ select, quantity });
  });
  ctx.container.appendChild(totalLabel);
  syncControls();

  ctx.addSectionTitle('Diagnostics');
  const diagnostics = ctx.make('div', { className: ctx.cls('setting') });
  const output = ctx.make('textarea', { className: ctx.cls('input') });
  output.readOnly = true;
  output.rows = 14;
  output.style.minHeight = '240px';
  output.style.resize = 'vertical';
  output.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  output.style.fontSize = '10px';
  const entries = Array.isArray(ctx.store?.read?.(LOG_KEY)) ? ctx.store.read(LOG_KEY) : [];
  output.value = entries.length
    ? entries.map((entry) => `[${new Date(entry.at).toLocaleString()}] ${entry.message}${entry.detail ? `\n${entry.detail}` : ''}`).join('\n').trim()
    : 'No Shadow Collection run has been logged yet.';
  diagnostics.appendChild(output);
  const clear = ctx.make('button', { text: 'Clear log', type: 'button' });
  clear.addEventListener('click', () => {
    ctx.store?.remove?.(LOG_KEY);
    output.value = 'Log cleared.';
  });
  diagnostics.appendChild(clear);
  ctx.container.appendChild(diagnostics);
}

module.exports = Object.freeze({
  id: 'shadowcollection',
  label: 'Shadow Collection',
  path: '/game_dash.php?veyra_route=shadowcollection',
  defaultEnabled: false,
  defaultLoopMinutes: 24 * 60,
  maxVisitMs: 5 * 60_000,
  initialDelayMs: 60_000,
  TARGETS,
  MAX_TARGETS,
  LOG_KEY,
  createDefaultSettings() { return normalizeSettings(null); },
  normalizeSettings,
  renderSettings,
  matchesUrl(url) {
    return /\/game_dash\.php\/?$/i.test(url.pathname)
      && url.searchParams.get('veyra_route') === 'shadowcollection';
  },
});
