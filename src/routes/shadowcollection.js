'use strict';

const TARGETS = Object.freeze([
  ['vanguard', 'Lizardman Vanguard'],
  ['warmage', 'Lizardman Warmage'],
  ['dreadblade', 'Lizardman Dreadblade'],
  ['guardian', 'Lizardman Guardian'],
  ['skarn', 'General Skarn the Radiant Bastion'],
  ['vessir', 'General Vessir the Sunfang Duelist'],
  ['hrazz', 'General Hrazz the Dawnflame Oathkeeper'],
  ['drakzareth', 'Drakzareth The Tyrant Lizard King'],
].map(([id, name]) => Object.freeze({ id, name })));
const TARGET_BY_ID = new Map(TARGETS.map((target) => [target.id, target]));
const MAX_TARGETS = 5;

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
  const rerender = () => ctx.rerender?.();
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
      rerender();
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
      rerender();
    });
    host.appendChild(ctx.make('label', { text: 'Daily amount (total max. 5)' }));
    host.appendChild(quantity);
    ctx.container.appendChild(host);
  });
  const total = ctx.settings.rows.reduce((sum, row) => sum + row.quantity, 0);
  ctx.container.appendChild(ctx.make('div', { className: ctx.cls('hint'), text: `Configured total: ${total} / ${MAX_TARGETS}` }));
}

module.exports = Object.freeze({
  id: 'shadowcollection',
  label: 'Shadow Collection',
  path: '/active_wave.php?gate=3&wave=8&veyra_route=shadowcollection',
  defaultEnabled: false,
  defaultLoopMinutes: 24 * 60,
  maxVisitMs: 5 * 60_000,
  initialDelayMs: 60_000,
  TARGETS,
  MAX_TARGETS,
  createDefaultSettings() { return normalizeSettings(null); },
  normalizeSettings,
  renderSettings,
  matchesUrl(url) {
    return /\/active_wave\.php\/?$/i.test(url.pathname)
      && url.searchParams.get('gate') === '3'
      && url.searchParams.get('veyra_route') === 'shadowcollection';
  },
});
