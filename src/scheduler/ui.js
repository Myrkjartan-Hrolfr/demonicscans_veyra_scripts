'use strict';

// Drawer menu of the scheduler: start/stop, home page, one row per page with
// countdown, enable switch and a settings view. Every settings view starts
// with the standard fields (loop length, stamina and healing potions) and
// then shows whatever the route itself renders.

const { POTION_TYPES, potionsOfType } = require('../core/potions');
const { formatCountdown } = require('../core/time');
const { ROUTE_LIST, getRoute } = require('../routes');
const { MAX_LOOP_MINUTES, MIN_LOOP_MINUTES } = require('./config');

const UI_ID = 'veyra-automation';
const SITE_SETTINGS_TRIGGER_ID = 'openSettingsDrawerBtn';
const SITE_FLOATING_CONTROL_IDS = Object.freeze(['openConsoleBtn', 'openQuickSetDrawerBtn', 'nav_fab']);

const STYLES = `
  #${UI_ID} { display: contents; }
  #${UI_ID}, #${UI_ID} * { box-sizing: border-box; }
  #${UI_ID}-trigger {
    position: fixed; right: 16px; bottom: 72px; z-index: 10001;
    width: 42px; min-width: 42px; height: 40px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #2f324d; border-radius: 12px; background: #24263a;
    box-shadow: 0 10px 24px rgba(0,0,0,.6); color: #fff;
    font: 700 18px/1 system-ui,sans-serif; cursor: pointer;
  }
  #${UI_ID}-trigger:active { transform: scale(.97); }
  #${UI_ID}-trigger[data-running="true"]::after {
    content: ''; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;
    border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 2px #24263a;
  }
  #${UI_ID}-backdrop {
    position: fixed; inset: 0; z-index: 2147483646; border: 0;
    background: rgba(0,0,0,.62); opacity: 0; pointer-events: none;
    transition: opacity .2s ease;
  }
  #${UI_ID}-drawer {
    position: fixed; top: 0; right: 0; z-index: 2147483647;
    width: min(380px, 92vw); height: 100vh; height: 100dvh;
    display: flex; flex-direction: column; overflow: hidden;
    border-left: 1px solid #2f324d; background: #1a1b25;
    box-shadow: 0 0 30px rgba(0,0,0,.8); color: #f4f5ff;
    font: 13px/1.4 Arial,system-ui,sans-serif;
    transform: translateX(105%); transition: transform .24s ease;
  }
  #${UI_ID}-drawer[data-open="true"] { transform: translateX(0); }
  #${UI_ID}-backdrop[data-open="true"] { opacity: 1; pointer-events: auto; }
  .${UI_ID}__header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: max(16px, env(safe-area-inset-top)) 16px 13px;
    border-bottom: 1px solid rgba(255,255,255,.1);
  }
  .${UI_ID}__title { color: #fff; font-size: 17px; font-weight: 800; }
  .${UI_ID}__subtitle { margin-top: 2px; color: #9aa0be; font-size: 11px; }
  .${UI_ID}__icon-button {
    flex: 0 0 auto; min-width: 34px; height: 34px; padding: 0 9px;
    border: 1px solid #343752; border-radius: 9px; background: #24263a;
    color: #fff; font-weight: 800; cursor: pointer;
  }
  .${UI_ID}__body {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 14px 16px calc(24px + env(safe-area-inset-bottom));
  }
  .${UI_ID}__top-row {
    display: grid; grid-template-columns: minmax(92px,auto) minmax(0,1fr);
    gap: 8px; align-items: stretch; margin-bottom: 10px;
  }
  .${UI_ID}__primary, .${UI_ID}__select, .${UI_ID}__input {
    min-height: 40px; border: 1px solid #343752; border-radius: 9px;
    background: #24263a; color: #f4f5ff; font: inherit;
  }
  .${UI_ID}__primary { padding: 8px 12px; font-weight: 800; cursor: pointer; }
  .${UI_ID}__primary[data-enabled="true"] { border-color: #ef6464; color: #ffd1d1; }
  .${UI_ID}__primary[data-enabled="false"] { border-color: #3ecf78; color: #a9f5c7; }
  .${UI_ID}__select { width: 100%; padding: 7px 9px; }
  .${UI_ID}__status {
    min-height: 32px; margin-bottom: 14px; padding: 8px 10px;
    border-radius: 8px; background: rgba(142,162,255,.09); color: #b8c3ff;
    font-size: 11px; overflow-wrap: anywhere;
  }
  .${UI_ID}__section-title {
    margin: 16px 0 8px; color: #9aa0be; font-size: 11px;
    font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
  }
  .${UI_ID}__section-title:first-child { margin-top: 0; }
  .${UI_ID}__routes { display: grid; gap: 8px; }
  .${UI_ID}__route {
    display: grid; grid-template-columns: minmax(0,1fr) auto;
    gap: 9px 12px; align-items: center; padding: 11px;
    border: 1px solid #2f324d; border-radius: 11px; background: #202231;
  }
  .${UI_ID}__route-name { min-width: 0; font-size: 14px; font-weight: 800; }
  .${UI_ID}__countdown { margin-top: 2px; color: #9aa0be; font-size: 11px; }
  .${UI_ID}__route-actions { display: flex; align-items: center; gap: 8px; }
  .${UI_ID}__switch { position: relative; width: 38px; height: 22px; display: inline-block; }
  .${UI_ID}__switch input { position: absolute; opacity: 0; pointer-events: none; }
  .${UI_ID}__switch span {
    position: absolute; inset: 0; border-radius: 999px; background: #4a4e62;
    cursor: pointer; transition: background .16s ease;
  }
  .${UI_ID}__switch span::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    border-radius: 50%; background: #fff; transition: transform .16s ease;
  }
  .${UI_ID}__switch input:checked + span { background: #35b96b; }
  .${UI_ID}__switch input:checked + span::after { transform: translateX(16px); }
  .${UI_ID}__subdrawer {
    position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
    background: #1a1b25; transform: translateX(105%); transition: transform .22s ease;
  }
  #${UI_ID}-drawer[data-view="settings"] .${UI_ID}__subdrawer { transform: translateX(0); }
  .${UI_ID}__setting-list { display: grid; gap: 10px; }
  .${UI_ID}__setting {
    display: grid; gap: 5px; padding: 10px;
    border: 1px solid #2f324d; border-radius: 10px; background: #202231;
  }
  .${UI_ID}__setting label, .${UI_ID}__setting-label { color: #e6e9ff; font-size: 12px; font-weight: 700; }
  .${UI_ID}__input { width: 100%; padding: 7px 9px; }
  .${UI_ID}__check {
    display: flex; align-items: center; gap: 9px; min-height: 32px;
    color: #e6e9ff; font-size: 12px; cursor: pointer;
  }
  .${UI_ID}__check input { width: 18px; height: 18px; margin: 0; }
  .${UI_ID}__hint { color: #9aa0be; font-size: 11px; }
  @media (max-width: 480px) {
    #${UI_ID}-trigger { right: 12px; bottom: 68px; }
    .${UI_ID}__route { padding: 10px; }
  }
  @media (prefers-reduced-motion: reduce) {
    #${UI_ID}-drawer, #${UI_ID}-backdrop, .${UI_ID}__subdrawer { transition: none; }
  }
`;

function countdownText(routeId, config, runtime, now) {
  if (config.routes[routeId]?.enabled === false) return 'Inactive';
  if (runtime?.activeVisit?.taskId === routeId) {
    return runtime.activeVisit.phase === 'running' ? 'Running now' : 'Preparing';
  }
  const countdown = formatCountdown(runtime?.nextRunAt?.[routeId], now);
  const note = runtime?.notes?.[routeId];
  return note ? `${note} · ${countdown}` : countdown;
}

// featureGroups: [{ title, settings: [definition] }] from features/runner.js
// featureSettings: core/settings.js store used to read and save them
function createSchedulerUi({ doc, win, featureGroups = [], featureSettings = null }) {
  const state = {
    actions: null,
    statusText: '',
    subRouteId: '',
    observer: null,
    reference: null,
    resizeListener: null,
    keydownListener: null,
  };

  const byId = (id) => doc.getElementById?.(id) || null;
  const cls = (name) => `${UI_ID}__${name}`;

  function make(tagName, options = {}) {
    const element = doc.createElement(tagName);
    if (options.id) element.id = options.id;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type) element.type = options.type;
    if (options.title) element.title = options.title;
    return element;
  }

  function replaceChildren(element, ...children) {
    if (!element) return;
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren(...children);
      return;
    }
    while (element.firstChild) element.removeChild(element.firstChild);
    for (const child of children) element.appendChild(child);
  }

  function injectStyles() {
    if (byId(`${UI_ID}-style`)) return;
    const style = doc.createElement('style');
    style.id = `${UI_ID}-style`;
    style.textContent = STYLES;
    (doc.head || doc.documentElement || doc.body)?.appendChild(style);
  }

  function resetTriggerPlacement(trigger) {
    for (const property of ['left', 'top', 'right', 'bottom']) trigger.style.removeProperty?.(property);
    trigger.dataset.anchored = 'false';
  }

  // Places the trigger next to the site's own settings button without
  // covering the site's other floating controls.
  function syncTriggerPlacement() {
    const trigger = byId(`${UI_ID}-trigger`);
    if (!trigger) return;
    const reference = byId(SITE_SETTINGS_TRIGGER_ID);
    const referenceRect = reference?.getBoundingClientRect?.();
    if (!referenceRect || referenceRect.width <= 0 || referenceRect.height <= 0) {
      resetTriggerPlacement(trigger);
      return;
    }

    const triggerRect = trigger.getBoundingClientRect?.() || { width: 42, height: 40 };
    const width = triggerRect.width > 0 ? triggerRect.width : 42;
    const height = triggerRect.height > 0 ? triggerRect.height : 40;
    const viewportWidth = Number(win.innerWidth) || doc.documentElement?.clientWidth || 1_024;
    const viewportHeight = Number(win.innerHeight) || doc.documentElement?.clientHeight || 768;
    const gap = 8;
    const centeredLeft = referenceRect.left + (referenceRect.width - width) / 2;
    const centeredTop = referenceRect.top + (referenceRect.height - height) / 2;
    const candidates = [
      { left: referenceRect.left - width - gap, top: centeredTop },
      { left: referenceRect.right + gap, top: centeredTop },
      { left: centeredLeft, top: referenceRect.top - height - gap },
      { left: centeredLeft, top: referenceRect.bottom + gap },
    ];
    const occupied = SITE_FLOATING_CONTROL_IDS.map((id) => byId(id)?.getBoundingClientRect?.()).filter(
      (rect) => rect && rect.width > 0 && rect.height > 0,
    );
    const insideViewport = (c) =>
      c.left >= 8 && c.top >= 8 && c.left + width <= viewportWidth - 8 && c.top + height <= viewportHeight - 8;
    const overlaps = (c) =>
      occupied.some(
        (rect) =>
          c.left < rect.right + 2 &&
          c.left + width > rect.left - 2 &&
          c.top < rect.bottom + 2 &&
          c.top + height > rect.top - 2,
      );
    const placement =
      candidates.find((c) => insideViewport(c) && !overlaps(c)) || candidates.find(insideViewport);
    if (!placement) {
      resetTriggerPlacement(trigger);
      return;
    }

    trigger.style.left = `${Math.round(placement.left)}px`;
    trigger.style.top = `${Math.round(placement.top)}px`;
    trigger.style.right = 'auto';
    trigger.style.bottom = 'auto';
    trigger.dataset.anchored = 'true';
  }

  function showMainView() {
    state.subRouteId = '';
    const drawer = byId(`${UI_ID}-drawer`);
    if (drawer) drawer.dataset.view = 'main';
  }

  function setDrawerOpen(open) {
    const drawer = byId(`${UI_ID}-drawer`);
    const backdrop = byId(`${UI_ID}-backdrop`);
    if (!drawer || !backdrop) return;

    const value = open ? 'true' : 'false';
    drawer.dataset.open = value;
    backdrop.dataset.open = value;
    backdrop.hidden = !open;
    byId(`${UI_ID}-trigger`)?.setAttribute?.('aria-expanded', value);
    if (!open) showMainView();
  }

  function createSettingsContext(routeId, container, routeConfig) {
    const idPrefix = `${UI_ID}-${routeId}`;
    return {
      routeId,
      settings: routeConfig.settings,
      make,
      cls,
      idPrefix,
      container,

      updateSettings(mutator) {
        return state.actions.updateRouteConfig(routeId, (next) => mutator(next.settings)).settings;
      },

      addSectionTitle(text) {
        container.appendChild(make('div', { className: cls('section-title'), text }));
      },

      addTextInput({ id, label, value, placeholder = '', inputMode = 'text', type = 'text', onChange }) {
        const row = make('div', { className: cls('setting') });
        const inputId = `${idPrefix}-${id}`;
        const labelElement = make('label', { text: label });
        labelElement.setAttribute?.('for', inputId);
        const input = make('input', { id: inputId, className: cls('input'), type });
        input.value = String(value ?? '');
        input.placeholder = placeholder;
        input.autocomplete = 'off';
        input.inputMode = inputMode;
        input.addEventListener('change', () => {
          const shown = onChange(input.value);
          if (shown !== undefined) input.value = String(shown);
        });
        row.appendChild(labelElement);
        row.appendChild(input);
        container.appendChild(row);
        return input;
      },

      addCheckbox({ id, label, checked, onChange, parent = container }) {
        const labelElement = make('label', { className: cls('check') });
        const input = make('input', { id: `${idPrefix}-${id}`, type: 'checkbox' });
        input.checked = Boolean(checked);
        input.addEventListener('change', () => onChange(input.checked));
        labelElement.appendChild(input);
        labelElement.appendChild(make('span', { text: label }));
        parent.appendChild(labelElement);
        return input;
      },
    };
  }

  function renderStandardSettings(ctx, routeConfig) {
    ctx.addSectionTitle('General');
    ctx.addTextInput({
      id: 'loop-minutes',
      label: 'Loop length (minutes)',
      value: routeConfig.loopMinutes,
      type: 'number',
      inputMode: 'numeric',
      onChange(value) {
        return state.actions.updateRouteConfig(ctx.routeId, (next) => {
          next.loopMinutes = value;
        }).loopMinutes;
      },
    });

    for (const type of Object.values(POTION_TYPES)) {
      const group = make('div', { className: cls('setting') });
      group.appendChild(make('div', { className: cls('setting-label'), text: type.label }));
      for (const potion of potionsOfType(type.id)) {
        ctx.addCheckbox({
          id: `potion-${potion.itemId}`,
          label: potion.name,
          checked: routeConfig.potions[type.id].includes(potion.itemId),
          parent: group,
          onChange(checked) {
            state.actions.updateRouteConfig(ctx.routeId, (next) => {
              const selected = new Set(next.potions[type.id]);
              if (checked) selected.add(potion.itemId);
              else selected.delete(potion.itemId);
              next.potions[type.id] = [...selected];
            });
          },
        });
      }
      group.appendChild(
        make('div', { className: cls('hint'), text: 'Used in this order when the page needs one.' }),
      );
      ctx.container.appendChild(group);
    }
  }

  function openView(titleText, render) {
    const drawer = byId(`${UI_ID}-drawer`);
    const title = byId(`${UI_ID}-sub-title`);
    const content = byId(`${UI_ID}-sub-content`);
    if (!drawer || !title || !content) return;

    title.textContent = titleText;
    replaceChildren(content);
    render(content);
    drawer.dataset.view = 'settings';
  }

  function openRouteSettings(routeId) {
    const route = getRoute(routeId);
    if (!route || !state.actions) return;

    state.subRouteId = routeId;
    openView(`${route.label} · Settings`, (content) => {
      const routeConfig = state.actions.loadConfig().routes[routeId];
      const ctx = createSettingsContext(routeId, content, routeConfig);
      renderStandardSettings(ctx, routeConfig);
      route.renderSettings?.(ctx);
    });
  }

  function renderFeatureSetting(container, definition, rerender) {
    const inputId = `${UI_ID}-setting-${definition.key.replace(/[^\w-]/g, '_')}`;
    const value = featureSettings.get(definition);
    const save = (next) => {
      featureSettings.set(definition, next);
      rerender();
    };

    if (definition.type === 'checkbox') {
      const row = make('label', { className: cls('check') });
      const input = make('input', { id: inputId, type: 'checkbox' });
      input.checked = value === true;
      input.addEventListener('change', () => save(input.checked));
      row.appendChild(input);
      row.appendChild(make('span', { text: definition.label }));
      container.appendChild(row);
    } else {
      const row = make('div', { className: cls('setting') });
      const label = make('label', { text: definition.label });
      label.setAttribute?.('for', inputId);
      let input;
      if (definition.type === 'select') {
        input = doc.createElement('select');
        input.className = cls('select');
        for (const option of definition.options || []) {
          const element = doc.createElement('option');
          element.value = String(option.value);
          element.textContent = option.label;
          input.appendChild(element);
        }
      } else {
        input = make('input', {
          className: cls('input'),
          type: definition.type === 'number' ? 'number' : 'text',
        });
        input.autocomplete = 'off';
        if (definition.type === 'number') {
          input.inputMode = 'decimal';
          if (definition.min !== undefined) input.min = String(definition.min);
          if (definition.max !== undefined) input.max = String(definition.max);
          if (definition.step !== undefined) input.step = String(definition.step);
        }
      }
      input.id = inputId;
      input.value = String(value ?? '');
      input.addEventListener('change', () => save(input.value));
      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }

    if (definition.hint) {
      container.appendChild(make('div', { className: cls('hint'), text: definition.hint }));
    }
  }

  function openFeatureSettings(group) {
    const render = (content) => {
      const scrollTop = content.scrollTop;
      replaceChildren(content);
      content.appendChild(
        make('div', { className: cls('hint'), text: 'Changes take effect after reloading the page.' }),
      );
      const get = (key) => {
        const definition = group.settings.find((candidate) => candidate.key === key);
        return definition ? featureSettings.get(definition) : undefined;
      };
      const list = make('div', { className: cls('setting-list') });
      for (const definition of group.settings) {
        if (definition.visibleIf && !definition.visibleIf(get)) continue;
        renderFeatureSetting(list, definition, () => render(content));
      }
      content.appendChild(list);
      content.scrollTop = scrollTop;
    };
    openView(`${group.title} · Settings`, render);
  }

  function buildFeatureRow(group) {
    const row = make('div', { className: cls('route') });
    const info = make('div');
    info.appendChild(make('div', { className: cls('route-name'), text: group.title }));
    info.appendChild(
      make('div', { className: cls('countdown'), text: `${group.settings.length} settings` }),
    );
    const button = make('button', {
      className: cls('icon-button'),
      type: 'button',
      title: `${group.title} settings`,
      text: '⚙',
    });
    button.setAttribute?.('aria-label', `${group.title} settings`);
    button.addEventListener('click', () => openFeatureSettings(group));
    row.appendChild(info);
    row.appendChild(button);
    return row;
  }

  function buildRouteRow(route) {
    const row = make('div', { className: cls('route') });
    row.dataset.routeId = route.id;
    const info = make('div');
    info.appendChild(make('div', { className: cls('route-name'), text: route.label }));
    info.appendChild(make('div', { id: `${UI_ID}-route-${route.id}-countdown`, className: cls('countdown') }));

    const actions = make('div', { className: cls('route-actions') });
    const switchLabel = make('label', { className: cls('switch'), title: `${route.label} on/off` });
    const toggle = make('input', { id: `${UI_ID}-route-${route.id}-enabled`, type: 'checkbox' });
    toggle.setAttribute?.('aria-label', `${route.label} enabled`);
    toggle.addEventListener('change', () => {
      state.actions.updateRouteConfig(route.id, (next) => {
        next.enabled = toggle.checked;
      });
      state.actions.tick();
    });
    switchLabel.appendChild(toggle);
    switchLabel.appendChild(make('span'));

    const settingsButton = make('button', {
      id: `${UI_ID}-route-${route.id}-settings`,
      className: cls('icon-button'),
      type: 'button',
      title: `${route.label} settings`,
      text: '⚙',
    });
    settingsButton.setAttribute?.('aria-label', `${route.label} settings`);
    settingsButton.addEventListener('click', () => openRouteSettings(route.id));

    actions.appendChild(switchLabel);
    actions.appendChild(settingsButton);
    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function buildHeader(titleElement, leading = null) {
    const header = make('div', { className: cls('header') });
    const close = make('button', { className: cls('icon-button'), type: 'button', title: 'Close', text: '✕' });
    close.setAttribute?.('aria-label', 'Close');
    close.addEventListener('click', () => setDrawerOpen(false));
    if (leading) header.appendChild(leading);
    header.appendChild(titleElement);
    header.appendChild(close);
    return header;
  }

  function ensureUi() {
    const existing = byId(UI_ID);
    if (existing) {
      syncTriggerPlacement();
      return existing;
    }
    if (!doc.body || typeof doc.createElement !== 'function' || !state.actions) return null;

    injectStyles();
    const root = make('div', { id: UI_ID });

    const trigger = make('button', { id: `${UI_ID}-trigger`, type: 'button', title: 'Veyra Automation', text: '🔄' });
    trigger.setAttribute?.('aria-label', 'Open Veyra Automation');
    trigger.setAttribute?.('aria-controls', `${UI_ID}-drawer`);
    trigger.setAttribute?.('aria-expanded', 'false');
    trigger.addEventListener('click', () => setDrawerOpen(true));

    const backdrop = make('button', { id: `${UI_ID}-backdrop`, type: 'button', title: 'Close menu' });
    backdrop.hidden = true;
    backdrop.dataset.open = 'false';
    backdrop.setAttribute?.('aria-label', 'Close Veyra Automation');
    backdrop.addEventListener('click', () => setDrawerOpen(false));

    const drawer = make('aside', { id: `${UI_ID}-drawer` });
    drawer.dataset.open = 'false';
    drawer.dataset.view = 'main';
    drawer.setAttribute?.('aria-label', 'Veyra Automation');

    const heading = make('div');
    heading.appendChild(make('div', { className: cls('title'), text: 'Veyra Automation' }));
    heading.appendChild(make('div', { className: cls('subtitle'), text: 'Scheduled page visits and automation' }));

    const body = make('div', { className: cls('body') });
    const topRow = make('div', { className: cls('top-row') });
    const toggle = make('button', { id: `${UI_ID}-toggle`, className: cls('primary'), type: 'button' });
    toggle.addEventListener('click', () => {
      const config = state.actions.loadConfig();
      state.actions.saveConfig({ ...config, enabled: !config.enabled });
      state.actions.tick();
    });

    const select = doc.createElement('select');
    select.id = `${UI_ID}-home`;
    select.className = cls('select');
    select.title = 'Home page';
    select.setAttribute?.('aria-label', 'Home page');
    for (const route of ROUTE_LIST) {
      const option = doc.createElement('option');
      option.value = route.id;
      option.textContent = `Home page · ${route.label}`;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const config = state.actions.loadConfig();
      state.actions.saveConfig({ ...config, homeRouteId: select.value });
      state.actions.tick();
    });
    topRow.appendChild(toggle);
    topRow.appendChild(select);

    const status = make('div', { id: `${UI_ID}-status`, className: cls('status') });
    status.setAttribute?.('aria-live', 'polite');

    const routeList = make('div', { className: cls('routes') });
    for (const route of ROUTE_LIST) routeList.appendChild(buildRouteRow(route));

    body.appendChild(topRow);
    body.appendChild(status);
    body.appendChild(make('div', { className: cls('section-title'), text: 'Pages' }));
    body.appendChild(routeList);

    if (featureSettings && featureGroups.length > 0) {
      const featureList = make('div', { className: cls('routes') });
      for (const group of featureGroups) featureList.appendChild(buildFeatureRow(group));
      body.appendChild(make('div', { className: cls('section-title'), text: 'Features' }));
      body.appendChild(featureList);
    }

    const subdrawer = make('section', { className: cls('subdrawer') });
    const back = make('button', { id: `${UI_ID}-sub-back`, className: cls('icon-button'), type: 'button', title: 'Back', text: '←' });
    back.setAttribute?.('aria-label', 'Back');
    back.addEventListener('click', showMainView);
    const subTitle = make('div', { id: `${UI_ID}-sub-title`, className: cls('title'), text: 'Settings' });
    const subContent = make('div', { id: `${UI_ID}-sub-content`, className: cls('body') });
    subdrawer.appendChild(buildHeader(subTitle, back));
    subdrawer.appendChild(subContent);

    drawer.appendChild(buildHeader(heading));
    drawer.appendChild(body);
    drawer.appendChild(subdrawer);
    root.appendChild(trigger);
    root.appendChild(backdrop);
    root.appendChild(drawer);
    doc.body.appendChild(root);

    syncTriggerPlacement();
    return root;
  }

  function setStatus(text) {
    state.statusText = String(text || '');
    const status = byId(`${UI_ID}-status`);
    if (status) status.textContent = state.statusText;
  }

  function update(config, runtime) {
    if (!ensureUi()) return;

    const select = byId(`${UI_ID}-home`);
    if (select && select.value !== config.homeRouteId) select.value = config.homeRouteId;

    const toggle = byId(`${UI_ID}-toggle`);
    if (toggle) {
      toggle.textContent = config.enabled ? 'Stop' : 'Start';
      toggle.dataset.enabled = String(config.enabled);
      toggle.setAttribute?.('aria-pressed', String(config.enabled));
    }
    const trigger = byId(`${UI_ID}-trigger`);
    if (trigger) trigger.dataset.running = String(config.enabled);

    const status = byId(`${UI_ID}-status`);
    if (status) {
      const visit = runtime?.activeVisit;
      status.textContent =
        state.statusText ||
        (visit
          ? `${getRoute(visit.taskId).label}: ${visit.phase}`
          : `Home page: ${getRoute(config.homeRouteId).label}`);
    }

    const now = Date.now();
    for (const route of ROUTE_LIST) {
      const routeToggle = byId(`${UI_ID}-route-${route.id}-enabled`);
      if (routeToggle) routeToggle.checked = config.routes[route.id]?.enabled !== false;
      const countdown = byId(`${UI_ID}-route-${route.id}-countdown`);
      if (countdown) countdown.textContent = countdownText(route.id, config, runtime, now);
    }
    syncTriggerPlacement();
  }

  function mount(actions) {
    state.actions = actions;
    ensureUi();

    state.resizeListener = () => syncTriggerPlacement();
    win.addEventListener?.('resize', state.resizeListener);
    state.keydownListener = (event) => {
      if (event?.key !== 'Escape') return;
      if (byId(`${UI_ID}-drawer`)?.dataset?.view === 'settings') showMainView();
      else setDrawerOpen(false);
    };
    win.addEventListener?.('keydown', state.keydownListener);

    // The site re-renders its floating controls; keep the trigger anchored.
    state.reference = byId(SITE_SETTINGS_TRIGGER_ID);
    if (typeof win.MutationObserver !== 'function') return;
    state.observer = new win.MutationObserver(() => {
      const reference = byId(SITE_SETTINGS_TRIGGER_ID);
      if (reference === state.reference && byId(UI_ID)) return;
      state.reference = reference;
      ensureUi();
      syncTriggerPlacement();
    });
    state.observer.observe(doc.documentElement || doc.body, { childList: true, subtree: true });
  }

  function cleanup() {
    state.observer?.disconnect?.();
    state.observer = null;
    if (state.resizeListener) win.removeEventListener?.('resize', state.resizeListener);
    if (state.keydownListener) win.removeEventListener?.('keydown', state.keydownListener);
    state.resizeListener = null;
    state.keydownListener = null;
    byId(UI_ID)?.remove?.();
    byId(`${UI_ID}-style`)?.remove?.();
  }

  return {
    cleanup,
    mount,
    openFeatureSettings,
    openRouteSettings,
    setDrawerOpen,
    setStatus,
    update,
  };
}

module.exports = {
  UI_ID,
  countdownText,
  createSchedulerUi,
};
