'use strict';

// Monster Auto Battle (port of the standalone userscript v1.6.5) on
// battle.php: auto-attacks the current monster with three prioritised
// attacks, an own-poison attack, potion priorities, a total damage target
// and level-up protection. Its panel holds its own settings (same storage
// keys and element ids as before). Once the panel is ready it registers a
// controller with mab-bridge.js for the automation workers.
//
// Modules: mab-parse (text parsing), mab-settings (storage), mab-attacks,
// mab-potions, mab-engine (combat loop), mab-panel (UI), mab-controller
// (bridge).

const { registerController, unregisterController } = require('./mab-bridge');
const { createController } = require('./mab-controller');
const { createEngine } = require('./mab-engine');
const { createPanel, injectStyles } = require('./mab-panel');
const { ID, createResumeStore, createSettingsStore, resumeKey, settingsKey } = require('./mab-settings');

function isBattlePage(url) {
  return /\/battle\.php$/i.test(url?.pathname || '');
}

const isElement = (node) => node?.nodeType === 1;
const elementOf = (node) => (isElement(node) ? node : node?.parentElement || null);

function storageOf(win, name) {
  try {
    return win?.[name] || null;
  } catch {
    return null;
  }
}

function run(ctx) {
  const { doc, win } = ctx;
  const host = ctx.url?.host || win?.location?.host || '';
  const pathname = ctx.url?.pathname || win?.location?.pathname || '';
  const warn = (...args) => ctx.warn?.(...args);

  const engine = createEngine({
    doc,
    win,
    postForm: ctx.postForm,
    settingsStore: createSettingsStore(storageOf(win, 'localStorage'), settingsKey(host, pathname), warn),
    resumeStore: createResumeStore(storageOf(win, 'sessionStorage'), resumeKey(host, pathname)),
    warn,
  });
  const { state } = engine;
  const timers = {};
  let panel = null;
  let controller = null;

  function registerBridge() {
    if (!controller) controller = createController(engine, () => panel?.syncForm());
    registerController(controller);
  }

  function mount() {
    const card = engine.findMonsterCard();
    if (!card) return;
    if (panel?.element?.isConnected && state.card === card) return;

    const incomingKey = engine.getMonsterKey(card);
    const sameRunningMonster = state.running && state.monsterKey && incomingKey === state.monsterKey;
    if (state.running && !sameRunningMonster) {
      engine.stop('The monster changed. Auto-battle was stopped.', 'idle', 'error');
    }

    doc.getElementById(ID)?.remove();
    engine.setCard(card);
    engine.discoverAttacks();
    engine.discoverPotions();
    injectStyles(doc);

    panel = createPanel(engine, doc);
    Object.assign(engine.ui, panel.ui);
    const actions = card.querySelector('.battle-actions-card');
    if (actions) actions.insertAdjacentElement('afterend', panel.element);
    else card.appendChild(panel.element);

    panel.ui.renderAttackOptions();
    panel.ui.renderPotionLists();
    panel.ui.updateButtons();
    engine.refreshMetrics();
    engine.setStatus(
      sameRunningMonster
        ? 'Battle card refreshed after potion use. Auto-battle is continuing.'
        : 'Ready. This configuration applies only to the currently visible monster.',
      sameRunningMonster ? 'running' : 'idle',
    );

    registerBridge();

    if (!state.running) {
      clearTimeout(timers.resume);
      timers.resume = setTimeout(() => void engine.resumeAfterReload(), 400);
    }
  }

  function debounce(name, delay, fn) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(fn, delay);
  }

  function onMutations(mutations) {
    if (!doc.getElementById(ID)) debounce('mount', 150, mount);
    if (!panel) return;

    const { SEL } = engine;
    const attackChanged = mutations.some((mutation) => {
      const target = elementOf(mutation.target);
      if (target?.closest?.(`#${ID}`)) return false;
      if (target?.closest?.(`${SEL.monsterCard} ${SEL.attack}`)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) => isElement(node) && (node.matches?.(SEL.attack) || node.querySelector?.(SEL.attack)),
      );
    });
    if (attackChanged) {
      debounce('attacks', 180, () => {
        if (engine.discoverAttacks()) panel?.ui.renderAttackOptions();
      });
    }

    const potionChanged = mutations.some((mutation) =>
      elementOf(mutation.target)?.closest?.(
        '#battleDrawer, #ds-combat-potion-quick-use, .potion-card, .potion-qty-left, .ds-potion-count',
      ),
    );
    if (potionChanged) {
      debounce('potions', 250, () => {
        panel?.ui.renderPotionLists();
        engine.refreshMetrics();
      });
    }

    const resourceChanged = mutations.some((mutation) =>
      elementOf(mutation.target)?.closest?.(`${SEL.stamina}, ${SEL.playerHp}, ${SEL.playerMana}, .gtb-exp`),
    );
    if (resourceChanged) debounce('metrics', 100, () => engine.refreshMetrics());
  }

  const Observer = win?.MutationObserver || globalThis.MutationObserver;
  const observer = Observer ? new Observer(onMutations) : null;
  const observe = () =>
    observer?.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });

  win?.addEventListener?.('pagehide', () => {
    if (controller) unregisterController(controller);
    observer?.disconnect();
    for (const timer of Object.values(timers)) clearTimeout(timer);
  });
  // Back/forward cache: the page comes back without running scripts again.
  win?.addEventListener?.('pageshow', (event) => {
    if (!event?.persisted) return;
    observe();
    if (panel?.element?.isConnected) registerBridge();
    else mount();
  });

  observe();
  mount();
}

module.exports = Object.freeze({
  id: 'monster-auto-battle',
  group: 'Battle',
  settings: [],
  matches: isBattlePage,
  run,
});
