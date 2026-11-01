'use strict';

// Wave page looting (/active_wave.php). Merges:
// - our Advanced Dead Monster Looter (dead-page merge, selection, filter,
//   damage sort, loot selected, 0-damage loot, extract & loot, loot to level
//   up, active-card damage sort),
// - our monster_loot_damage.js ("🩸 You: N" chip on dead cards),
// - veyra-hud ui-improvements "Faster Loot X", the patched vanilla
//   #btnLootX and the boss blacklist (MIT, koenrad).
//
// Behaviour changes against the originals:
// - Every bulk loot skips monsters reserved for the Adventurer's Guild quest
//   automation (core/loot-guard). The vanilla Loot X button is therefore
//   always patched, also when "Faster Loot X" is off.
// - Fast Loot X runs at most 4 requests in parallel (veyra-hud: 200).
// - Buttons never stay on "Working…" (veyra-hud returned early without
//   resetting them); #lootStatus / #lootCount / the unclaimed pill may be
//   missing without errors.
// - Item quantities are summed (veyra-hud counted each drop as 1).
// - Loot to level up uses the EXP requirement of the top bar and only
//   reloads the page to read the level when that requirement is unknown.

const { getCurrentLevel, getRequiredExperienceToLevel, isCloudflareError } = require('../../core/game');
const { readProtectedNames } = require('../../core/loot-guard');
const { parseGameNumber } = require('../../core/numbers');
const { sleep } = require('../../core/time');
const {
  addLootResult,
  createLevelUpTracker,
  createLootTotals,
  extractShadow,
  isBlacklistedBoss,
  lootMonster,
  normalizeMonsterName,
  runLimited,
  validId,
} = require('./loot-api');
const { el, ensureLootStyle, formatNumber, observeDebounced, showLootResults } = require('./loot-ui');

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

const DEAD_LOOTER = Object.freeze({
  key: 'veyra-loot:deadMonsterLooter',
  label: 'Dead Monster Looter panel',
  type: 'checkbox',
  default: true,
  hint: 'Selection, filters, damage sort, loot selected, 0-damage loot, extract & loot, loot to level up.',
});

const MERGE_PAGES = Object.freeze({
  key: 'veyra-loot:mergeDeadPages',
  label: 'Dead loot pages to merge',
  type: 'number',
  default: 5,
  min: 1,
  max: 20,
  step: 1,
  hint: '200 dead monsters per page; 1 turns merging off.',
  visibleIf: (get) => get(DEAD_LOOTER.key) === true,
});

const DAMAGE_CHIP = Object.freeze({
  key: 'veyra-loot:showDamageChip',
  label: 'Show your damage on dead cards',
  type: 'checkbox',
  default: true,
});

const LOOT_X_FASTER = Object.freeze({
  key: 'ui-improvements:enableLootXFaster',
  label: 'Faster Loot X',
  type: 'checkbox',
  default: true,
  hint: 'Adds "⚡ Loot X (fast)" next to the game\'s Loot X button (4 requests in parallel).',
});

const IGNORE_BOSSES = Object.freeze({
  key: 'ui-improvements:ignoreBossMobsWhenLooting',
  label: 'Ignore boss mobs when bulk looting',
  type: 'checkbox',
  default: true,
  hint: 'Loot X, 0-damage loot and loot to level up skip the big wave bosses.',
});

const SETTINGS = [DEAD_LOOTER, MERGE_PAGES, DAMAGE_CHIP, LOOT_X_FASTER, IGNORE_BOSSES];

// ----------------------------------------------------------------------------
// Constants and pure helpers (unit tested)
// ----------------------------------------------------------------------------

const STYLE_ID = 'veyra-automation-wave-loot-style';
const PANEL_ID = 'veyra-dead-looter';
const FAST_BUTTON_ID = 'veyra-loot-x-fast';
const ACTIVE_SORT_ID = 'dmSortActiveDamage';
const DONE_CLASS = 'veyra-looted';
const PAGE_SIZE = 200;
const EXTRACT_CAP = 5;
const PAGE_FETCH_DELAY_MS = 250;

function parseDamage(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (!digits) return 0;
  const number = Number(digits);
  return Number.isFinite(number) ? number : 0;
}

// Plain description of a monster card (dataset-like input for tests).
function cardInfo(card) {
  const data = card?.dataset || {};
  return {
    card,
    id: validId(data.monsterId),
    name: normalizeMonsterName(data.name),
    damage: parseDamage(data.userdmg),
    hasDamage: data.userdmg !== undefined && data.userdmg !== '',
    dead: data.dead === '1',
    eligible: data.eligible === '1',
    done: Boolean(card?.classList?.contains?.(DONE_CLASS)),
    hidden: Boolean(card?.hidden || card?.style?.display === 'none'),
  };
}

// Filters card infos down to what a bulk loot may take.
function selectLootTargets(infos, options = {}) {
  const {
    protectedNames = new Set(),
    ignoreBosses = false,
    zeroDamageOnly = false,
    visibleOnly = false,
    limit = Infinity,
  } = options;
  const seen = new Set();
  const targets = [];
  for (const info of infos || []) {
    if (targets.length >= limit) break;
    if (!info?.id || seen.has(info.id) || !info.eligible || info.done) continue;
    if (protectedNames.has(info.name)) continue;
    if (ignoreBosses && isBlacklistedBoss(info.name)) continue;
    if (zeroDamageOnly && !(info.hasDamage && info.damage === 0)) continue;
    if (visibleOnly && info.hidden) continue;
    seen.add(info.id);
    targets.push(info);
  }
  return targets;
}

// "Dead loot page 1 / 4" text and/or the unclaimed kills count → page count.
function parseDeadPageCount({ text = '', unclaimed = null } = {}) {
  const match = String(text || '').match(/Dead\s+loot\s+page\s+(\d+)\s*\/\s*(\d+)/i);
  if (match) return { current: Number(match[1]) || 1, total: Math.max(1, Number(match[2]) || 1) };
  const count = Number(unclaimed);
  return { current: 1, total: Number.isFinite(count) && count > 0 ? Math.ceil(count / PAGE_SIZE) : 1 };
}

// Stable ascending sort by damage.
function sortByDamage(items, getDamage) {
  return items
    .map((item, index) => ({ item, index, damage: getDamage(item) }))
    .sort((a, b) => a.damage - b.damage || a.index - b.index)
    .map((entry) => entry.item);
}

// ----------------------------------------------------------------------------
// DOM helpers
// ----------------------------------------------------------------------------

const CSS = `
#${PANEL_ID}{grid-column:1/-1;width:100%;box-sizing:border-box;background:#1a1b25;border:1px solid #ce9e00;border-radius:12px;padding:12px;margin:0 0 14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 20px rgba(0,0,0,.5);font-family:system-ui,sans-serif;color:#e6e9ff}
#${PANEL_ID} .vdl-title{color:#ffd369;font-weight:800;font-size:15px}
#${PANEL_ID} .vdl-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#${PANEL_ID} button,#${PANEL_ID} select,#${PANEL_ID} input{font:600 13px system-ui,sans-serif;min-height:36px;border-radius:8px;box-sizing:border-box}
#${PANEL_ID} button{background:#2a2c3d;color:#fff;border:1px solid #3a3d58;padding:7px 12px;cursor:pointer}
#${PANEL_ID} button:disabled{opacity:.5;cursor:not-allowed}
#${PANEL_ID} select{background:#1e1e2e;color:#fff;border:1px solid #3a3d58;padding:6px 8px;max-width:100%}
#${PANEL_ID} input[type=number]{background:#000;color:#0f0;border:1px solid #444;width:70px;text-align:center;padding:4px}
#${PANEL_ID} .vdl-loot{background:#007e33;border-color:#00c851}
#${PANEL_ID} .vdl-zero{background:#20354a;border-color:#3d78a8;color:#d8efff}
#${PANEL_ID} .vdl-sort{background:#3b1f2b;border-color:#8f3f5b;color:#ffd7e2}
#${PANEL_ID} .vdl-sort.is-active{background:#6b263e}
#${PANEL_ID} .vdl-extract{background:linear-gradient(135deg,#2b114a,#5b21b6 45%,#7c3aed);border-color:#a855f7;color:#f6eeff}
#${PANEL_ID} .vdl-level{background:linear-gradient(135deg,#8a5a00,#d39a00 50%,#ffca28);border-color:#ffe082;color:#171000}
#${PANEL_ID} .vdl-level.is-running{background:linear-gradient(135deg,#5c1010,#a51d1d 55%,#e53935);color:#fff}
#${PANEL_ID} .vdl-max{display:flex;gap:6px;align-items:center;font-size:12px;color:#cfd4ff}
#${PANEL_ID} .vdl-status{font-size:12px;color:#ffd369;min-height:16px}
#${PANEL_ID} .vdl-status.is-ok{color:#00c851}
#${PANEL_ID} .vdl-status.is-warn{color:#ffbb33}
.veyra-loot-card{position:relative}
.veyra-loot-pick{position:absolute;top:10px;left:10px;z-index:5;background:rgba(10,11,18,.85);padding:6px;border-radius:8px;border:1px solid #ce9e00;display:flex;align-items:center;gap:4px;font-size:11px;color:#ffd369}
.veyra-loot-pick input{width:20px;height:20px;margin:0;cursor:pointer}
.veyra-loot-pick.is-off{border-color:#444}
.veyra-loot-pick.is-off input{cursor:not-allowed}
.veyra-loot-ineligible{opacity:.5}
.monster-card.${DONE_CLASS}{opacity:.25;pointer-events:none}
#${FAST_BUTTON_ID}{margin-left:6px}
#btnLootX.is-running,#${FAST_BUTTON_ID}.is-running{opacity:.7;cursor:progress}
@media (max-width:640px){
  #${PANEL_ID} .vdl-row > button,#${PANEL_ID} .vdl-row > select{flex:1 1 44%}
  #${PANEL_ID} .vdl-max{flex:1 1 100%;flex-wrap:wrap}
  #${PANEL_ID} .vdl-max button{flex:1 1 44%}
}
`;

function ensureWaveStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function deadCards(root) {
  return [...(root?.querySelectorAll?.('.monster-card[data-dead="1"]') || [])];
}

function findCard(doc, id) {
  return validId(id) ? doc.querySelector(`.monster-card[data-monster-id="${id}"]`) : null;
}

function markLooted(doc, id) {
  const card = findCard(doc, id);
  if (!card) return;
  card.dataset.eligible = '0';
  card.classList.add(DONE_CLASS);
  const box = card.querySelector('.veyra-loot-pick input');
  if (box) {
    box.checked = false;
    box.disabled = true;
  }
}

function readUnclaimedKills(doc) {
  const pill = [...doc.querySelectorAll('.unclaimed-pill')].find((element) =>
    /unclaimed\s+kills/i.test(element.textContent || ''),
  );
  return parseGameNumber(pill?.querySelector('.count')?.textContent ?? null);
}

// Finds the "Dead loot page x / y" text node outside of scripts.
function findDeadPageText(doc) {
  if (!doc?.body || typeof doc.createTreeWalker !== 'function') return null;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|TEXTAREA)$/.test(parent.tagName)) continue;
    if (/Dead\s+loot\s+page\s+\d+\s*\/\s*\d+/i.test(node.textContent || '')) return node;
  }
  return null;
}

function hideDeadPagination(doc, textNode) {
  let element = textNode?.parentElement || null;
  for (let depth = 0; element && depth < 4; depth += 1) {
    if (element.querySelector('a[href*="dead_page"], [onclick*="DeadPage"]')) {
      element.style.display = 'none';
      return;
    }
    if (element.parentElement?.classList?.contains('monster-container')) break;
    element = element.parentElement;
  }
  if (textNode?.parentElement) textNode.parentElement.style.display = 'none';
}

function protectedNames(ctx) {
  try {
    return readProtectedNames(ctx.store);
  } catch {
    return new Set();
  }
}

async function readFreshLevel(ctx) {
  try {
    await sleep(300);
    const url = new URL(ctx.url.href);
    url.searchParams.set('_veyra_level', String(Date.now()));
    return getCurrentLevel(await ctx.fetchDocument(url.toString()));
  } catch (error) {
    ctx.warn('Level check failed', error);
    return null;
  }
}

async function resolveUserId(ctx) {
  return validId(ctx.pageGlobal('USER_ID')) || validId(await ctx.getUserId?.().catch?.(() => null));
}

// ----------------------------------------------------------------------------
// Damage chip (monster_loot_damage.js)
// ----------------------------------------------------------------------------

function addDamageChips(doc) {
  for (const card of doc.querySelectorAll('.monster-card[data-dead="1"][data-userdmg]')) {
    if (card.querySelector('.veyra-dmg-chip, .tm-user-damage, .mini-chip[title="Your damage dealt"]')) continue;
    const damage = parseDamage(card.dataset.userdmg);
    if (damage <= 0) continue;
    const heading = card.querySelector('h3');
    if (!heading) continue;
    const row = el(doc, 'div', { className: 'monster-select-row veyra-dmg-chip' });
    row.style.cssText = 'display:flex;justify-content:center;gap:8px;align-items:center;margin:6px 0 2px;';
    row.appendChild(
      el(doc, 'span', { className: 'mini-chip party-chip', text: `🩸 You: ${formatNumber(damage)}`, attrs: { title: 'Your damage dealt' } }),
    );
    heading.insertAdjacentElement('afterend', row);
  }
}

// ----------------------------------------------------------------------------
// Active monster damage sort (Advanced Dead Monster Looter)
// ----------------------------------------------------------------------------

function activeCardDamage(card) {
  if (card.dataset.userdmg !== undefined && card.dataset.userdmg !== '') return parseDamage(card.dataset.userdmg);
  const chip = [...card.querySelectorAll('.mini-chip')].find((element) => /You\s*:/i.test(element.textContent || ''));
  const match = (chip?.textContent || '').match(/You\s*:\s*([\d.,]+)/i);
  return match ? parseDamage(match[1]) : 0;
}

function installActiveSortButton(doc) {
  const actions = doc.querySelector('.select-wrap .qol-select-actions') || doc.querySelector('.qol-select-actions');
  if (!actions || actions.querySelector(`#${ACTIVE_SORT_ID}`)) return;
  const button = el(doc, 'button', { className: 'btn', text: '🩸 Damage ↑', attrs: { type: 'button', id: ACTIVE_SORT_ID } });
  button.title = 'Sort active monster cards by your damage, ascending';
  let original = null;
  button.addEventListener('click', () => {
    if (!original) {
      const groups = new Map();
      for (const card of doc.querySelectorAll('.monster-card:not([data-dead="1"])')) {
        if (!card.parentElement) continue;
        if (!groups.has(card.parentElement)) groups.set(card.parentElement, []);
        groups.get(card.parentElement).push(card);
      }
      if (!groups.size) {
        button.title = 'No active monster cards found';
        return;
      }
      original = groups;
      for (const [parent, cards] of groups) {
        for (const card of sortByDamage(cards, activeCardDamage)) parent.appendChild(card);
      }
      button.textContent = '↩ Original order';
      button.title = 'Restore the original active monster card order';
    } else {
      for (const [parent, cards] of original) {
        if (!parent.isConnected) continue;
        for (const card of cards) if (card.parentElement === parent) parent.appendChild(card);
      }
      original = null;
      button.textContent = '🩸 Damage ↑';
      button.title = 'Sort active monster cards by your damage, ascending';
    }
  });
  const settings = actions.querySelector('.btnAttackSettings');
  if (settings) actions.insertBefore(button, settings);
  else actions.appendChild(button);
}

// ----------------------------------------------------------------------------
// Loot runs
// ----------------------------------------------------------------------------

function createSession(ctx) {
  return {
    busy: false,
    stopRequested: false,
    expGained: 0,
    lastLoadedPage: 1,
    totalPages: 1,
    controls: new Set(),
    setBusy(busy, keepEnabled = null) {
      this.busy = busy;
      for (const control of this.controls) {
        if (!control.isConnected) continue;
        if (busy) {
          control.dataset.vlWasDisabled = control.disabled ? '1' : '0';
          if (control !== keepEnabled) control.disabled = true;
        } else {
          control.disabled = control.dataset.vlWasDisabled === '1';
          delete control.dataset.vlWasDisabled;
        }
      }
    },
    ctx,
  };
}

async function lootTargets(ctx, session, targets, { concurrency, delayMs, tracker = null, onProgress = () => {} }) {
  const totals = createLootTotals(targets.length);
  const userId = await resolveUserId(ctx);
  await runLimited(targets, (target) => lootMonster(ctx.postForm, { monsterId: target.id, userId }), {
    concurrency,
    delayMs,
    shouldStop: () => session.stopRequested || Boolean(tracker?.reached),
    onResult: (result, target) => {
      addLootResult(totals, result);
      if (result.ok) {
        markLooted(ctx.doc, target.id);
        session.expGained += result.exp || 0;
      }
      tracker?.add(result);
      onProgress(totals);
    },
  });
  return totals;
}

// Loot X targets: eligible cards of this page first, further dead pages are
// fetched only when more are needed.
async function gatherLootXTargets(ctx, session, wanted, setStatus) {
  const options = { protectedNames: protectedNames(ctx), ignoreBosses: ctx.setting(IGNORE_BOSSES.key) === true };
  const cards = [...ctx.doc.querySelectorAll('.monster-card[data-eligible="1"]')].map(cardInfo);
  const targets = selectLootTargets(cards, options);
  const ids = new Set(targets.map((target) => target.id));

  for (let page = session.lastLoadedPage + 1; targets.length < wanted && page <= session.totalPages; page += 1) {
    setStatus(`Gathering page ${page}/${session.totalPages}, collected ${targets.length}/${wanted}…`);
    try {
      const url = new URL(ctx.url.href);
      url.searchParams.set('dead_page', String(page));
      const pageDoc = await ctx.fetchDocument(url.toString());
      if (isCloudflareError(pageDoc)) {
        setStatus(`Page ${page} is temporarily unavailable, continuing…`);
        await sleep(3_000);
        continue;
      }
      const more = selectLootTargets(
        [...pageDoc.querySelectorAll('.monster-card[data-eligible="1"]')].map(cardInfo),
        options,
      ).filter((target) => !ids.has(target.id));
      for (const target of more) {
        ids.add(target.id);
        targets.push(target);
      }
    } catch (error) {
      ctx.warn('Could not load dead page', page, error);
    }
    await sleep(PAGE_FETCH_DELAY_MS);
  }
  return targets.slice(0, wanted);
}

async function runLootX(ctx, session, { fast, buttons }) {
  const doc = ctx.doc;
  const statusEl = doc.getElementById('lootStatus');
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };
  if (session.busy) {
    setStatus('Another loot run is still active.');
    return;
  }
  const wanted = Math.max(1, Number.parseInt(doc.getElementById('lootCount')?.value || '1', 10) || 1);

  session.busy = true;
  session.stopRequested = false;
  session.setBusy(true);
  for (const button of buttons) {
    if (!button) continue;
    button.classList.add('is-running');
    button.dataset.vlLabel = button.dataset.vlLabel || button.textContent;
    button.textContent = 'Working…';
    button.disabled = true;
  }
  try {
    setStatus(`Gathering ${wanted.toLocaleString('en-US')} monsters to loot…`);
    const targets = await gatherLootXTargets(ctx, session, wanted, setStatus);
    if (!targets.length) {
      setStatus('No eligible dead monsters you joined.');
      return;
    }
    const totals = await lootTargets(ctx, session, targets, {
      concurrency: fast ? 4 : 1,
      delayMs: fast ? 100 : 200,
      onProgress: (current) =>
        setStatus(`Looting ${current.processed}/${targets.length}… (success: ${current.success}, fail: ${current.fail})`),
    });
    setStatus(`Done. Looted ${totals.success}, failed ${totals.fail}.`);
    showLootResults(doc, { title: '🎁 Loot Gained', totals });
  } catch (error) {
    ctx.warn('Loot X failed', error);
    setStatus('Looting failed – see the console.');
  } finally {
    for (const button of buttons) {
      if (!button) continue;
      button.classList.remove('is-running');
      button.textContent = button.dataset.vlLabel || button.textContent;
      button.disabled = false;
    }
    session.setBusy(false);
    session.busy = false;
  }
}

function setupLootX(ctx, session) {
  const doc = ctx.doc;
  const vanilla = doc.getElementById('btnLootX');
  if (!vanilla || vanilla.dataset.veyraPatched === '1') return;

  // Replace the vanilla button with a clone (drops the page's handler) so
  // the guard, blacklist and multi-page gathering apply.
  const patched = vanilla.cloneNode(true);
  patched.dataset.veyraPatched = '1';
  patched.dataset.vlLabel = (vanilla.textContent || '').trim() || '💰 Loot X monsters';
  vanilla.replaceWith(patched);

  let fast = null;
  if (ctx.setting(LOOT_X_FASTER.key) === true && !doc.getElementById(FAST_BUTTON_ID)) {
    fast = el(doc, 'button', { text: '⚡ Loot X (fast)', attrs: { type: 'button', id: FAST_BUTTON_ID } });
    fast.className = patched.className;
    fast.dataset.vlLabel = '⚡ Loot X (fast)';
    fast.title = 'Loot X monsters with up to 4 parallel requests';
    patched.insertAdjacentElement('afterend', fast);
  }
  const buttons = [patched, fast].filter(Boolean);
  for (const button of buttons) session.controls.add(button);
  patched.addEventListener('click', (event) => {
    event.preventDefault();
    runLootX(ctx, session, { fast: false, buttons });
  });
  fast?.addEventListener('click', () => runLootX(ctx, session, { fast: true, buttons }));

  const status = doc.getElementById('lootStatus');
  if (status) {
    status.style.flexBasis = '100%';
    if (status.parentElement) status.parentElement.style.flexWrap = 'wrap';
  }
}

// ----------------------------------------------------------------------------
// Dead Monster Looter panel
// ----------------------------------------------------------------------------

function buildPanel(doc) {
  const panel = el(doc, 'div', { attrs: { id: PANEL_ID } });
  const button = (text, className, title = '') => {
    const element = el(doc, 'button', { className, text, attrs: { type: 'button' } });
    if (title) element.title = title;
    return element;
  };
  const parts = {
    filter: el(doc, 'select', { attrs: { 'aria-label': 'Filter dead monsters by name' } }),
    selectAll: button('Select all visible', 'vdl-all'),
    selectNone: button('Select none', 'vdl-none'),
    sort: button('🩸 Damage ↑', 'vdl-sort', 'Sort dead monster cards by your damage, ascending'),
    zero: button('🩸 Loot 0-damage', 'vdl-zero', 'Loot every eligible dead monster where your damage is 0'),
    limit: el(doc, 'input', { attrs: { type: 'number', min: '1', placeholder: 'All', 'aria-label': 'Max to loot' } }),
    loot: button('💰 Loot selected', 'vdl-loot'),
    extract: button('☠️ Extract & loot', 'vdl-extract', `Extract shadows from the selected monsters (max ${EXTRACT_CAP}), then loot them`),
    level: button('⬆️ Loot to level up', 'vdl-level', 'Loot the visible cards one by one until you level up'),
    status: el(doc, 'div', { className: 'vdl-status', text: 'Initializing…', attrs: { role: 'status' } }),
  };
  const max = el(doc, 'label', { className: 'vdl-max' });
  max.append(el(doc, 'span', { text: 'Max:' }), parts.limit, parts.loot, parts.extract, parts.level);
  const row1 = el(doc, 'div', { className: 'vdl-row' });
  row1.append(parts.filter, parts.selectAll, parts.selectNone, parts.sort, parts.zero);
  const row2 = el(doc, 'div', { className: 'vdl-row' });
  row2.append(max);
  panel.append(el(doc, 'div', { className: 'vdl-title', text: '🧟 Dead Monster Looter' }), row1, row2, parts.status);
  return { panel, parts };
}

function decorateCards(doc, cards, guarded) {
  for (const card of cards) {
    if (card.querySelector('.veyra-loot-pick')) continue;
    const info = cardInfo(card);
    const isProtected = guarded.has(info.name);
    const usable = info.eligible && !isProtected && Boolean(info.id);
    card.classList.add('veyra-loot-card');
    const wrap = el(doc, 'label', { className: `veyra-loot-pick${usable ? '' : ' is-off'}` });
    const box = el(doc, 'input', { attrs: { type: 'checkbox' } });
    box.dataset.id = info.id || '';
    box.disabled = !usable;
    wrap.title = isProtected
      ? "Reserved for the Adventurer's Guild quest automation"
      : usable
        ? 'Select for looting'
        : 'Not eligible to loot';
    wrap.appendChild(box);
    if (isProtected) wrap.appendChild(el(doc, 'span', { text: '🔒 Quest' }));
    card.appendChild(wrap);
    if (!info.eligible) card.classList.add('veyra-loot-ineligible');
  }
}

async function mergeDeadPages(ctx, session, { container, cards, setStatus }) {
  const doc = ctx.doc;
  const pageText = findDeadPageText(doc);
  const info = parseDeadPageCount({ text: pageText?.textContent, unclaimed: readUnclaimedKills(doc) });
  const current = Number.parseInt(ctx.url.searchParams.get('dead_page') || String(info.current), 10) || 1;
  session.totalPages = Math.max(info.total, current);
  session.lastLoadedPage = current;

  const maxPages = Math.min(session.totalPages, Math.max(1, Number(ctx.setting(MERGE_PAGES.key)) || 1));
  if (current !== 1 || maxPages <= 1) return 0;

  const known = new Set(cards.map((card) => card.dataset.monsterId));
  let added = 0;
  for (let page = 2; page <= maxPages; page += 1) {
    setStatus(`Merging dead loot page ${page}/${maxPages}…`);
    try {
      const url = new URL(ctx.url.href);
      url.searchParams.set('dead_page', String(page));
      const pageDoc = await ctx.fetchDocument(url.toString());
      if (isCloudflareError(pageDoc)) break;
      for (const card of deadCards(pageDoc)) {
        if (!card.dataset.monsterId || known.has(card.dataset.monsterId)) continue;
        known.add(card.dataset.monsterId);
        container.appendChild(doc.adoptNode ? doc.adoptNode(card) : card);
        cards.push(card);
        added += 1;
      }
      session.lastLoadedPage = page;
    } catch (error) {
      ctx.warn('Could not merge dead page', page, error);
      break;
    }
    await sleep(PAGE_FETCH_DELAY_MS);
  }
  if (session.lastLoadedPage > 1) hideDeadPagination(doc, pageText);
  return added;
}

async function setupDeadLooter(ctx, session) {
  const doc = ctx.doc;
  if (doc.getElementById(PANEL_ID)) return;
  const cards = deadCards(doc);
  if (!cards.length) return;
  const container = cards[0].parentElement;
  if (!container) return;

  const deadTitle = [...doc.querySelectorAll('.monster-section-title')].find((element) =>
    /\bDead\s+(?:Monsters|Bosses)\b/i.test(element.textContent || ''),
  );
  const { panel, parts } = buildPanel(doc);
  if (deadTitle) deadTitle.insertAdjacentElement('afterend', panel);
  else container.insertAdjacentElement('beforebegin', panel);

  const setStatus = (text, tone = '') => {
    parts.status.textContent = text;
    parts.status.className = `vdl-status${tone ? ` is-${tone}` : ''}`;
  };
  const controls = [parts.filter, parts.selectAll, parts.selectNone, parts.sort, parts.zero, parts.limit, parts.loot, parts.extract, parts.level];
  for (const control of controls) {
    control.disabled = true;
    session.controls.add(control);
  }

  const added = await mergeDeadPages(ctx, session, { container, cards, setStatus });
  decorateCards(doc, cards, protectedNames(ctx));
  if (ctx.setting(DAMAGE_CHIP.key) === true) addDamageChips(doc);

  // Filter options
  const names = [...new Set(cards.map((card) => normalizeMonsterName(card.dataset.name)).filter(Boolean))].sort();
  parts.filter.replaceChildren(
    el(doc, 'option', { text: 'All monsters', attrs: { value: '' } }),
    ...names.map((name) =>
      el(doc, 'option', { text: name.replace(/\b\w/g, (letter) => letter.toUpperCase()), attrs: { value: name } }),
    ),
  );

  for (const control of controls) control.disabled = false;
  setStatus(
    added
      ? `Ready. ${cards.length} dead monsters merged from ${session.lastLoadedPage} pages.`
      : `Ready. ${cards.length} dead monsters.`,
    'ok',
  );

  const checkedBoxes = () =>
    [...container.querySelectorAll('.veyra-loot-pick input:checked')].filter((box) => !box.disabled);
  const visibleUsableBoxes = () =>
    cards
      .filter((card) => card.style.display !== 'none' && !card.classList.contains(DONE_CLASS))
      .map((card) => card.querySelector('.veyra-loot-pick input'))
      .filter((box) => box && !box.disabled);

  parts.filter.addEventListener('change', () => {
    const wanted = parts.filter.value;
    for (const card of cards) {
      const show = !wanted || normalizeMonsterName(card.dataset.name) === wanted;
      card.style.display = show ? '' : 'none';
      if (!show) {
        const box = card.querySelector('.veyra-loot-pick input');
        if (box) box.checked = false;
      }
    }
  });
  parts.selectAll.addEventListener('click', () => {
    for (const box of visibleUsableBoxes()) box.checked = true;
  });
  parts.selectNone.addEventListener('click', () => {
    for (const box of container.querySelectorAll('.veyra-loot-pick input')) box.checked = false;
  });

  // Damage sort toggle (restores the merged order on the second click).
  const originalOrder = [...cards];
  parts.sort.addEventListener('click', () => {
    const active = !parts.sort.classList.contains('is-active');
    const order = active ? sortByDamage(cards, (card) => parseDamage(card.dataset.userdmg)) : originalOrder;
    for (const card of order) if (card.parentElement === container) container.appendChild(card);
    parts.sort.classList.toggle('is-active', active);
    parts.sort.textContent = active ? '↩ Original order' : '🩸 Damage ↑';
    setStatus(active ? 'Sorted by your damage: lowest → highest.' : 'Original order restored.', 'ok');
  });

  const run = async (button, label, work) => {
    if (session.busy) {
      setStatus('Another loot run is still active.', 'warn');
      return;
    }
    session.stopRequested = false;
    session.setBusy(true, button);
    const original = button.textContent;
    if (label) button.textContent = label;
    try {
      await work();
    } catch (error) {
      ctx.warn('Loot run failed', error);
      setStatus('Looting failed – see the console.', 'warn');
    } finally {
      button.textContent = original;
      button.classList.remove('is-running');
      session.setBusy(false);
      session.stopRequested = false;
    }
  };

  // Loot selected
  parts.loot.addEventListener('click', () => {
    const guarded = protectedNames(ctx);
    const boxes = checkedBoxes();
    if (!boxes.length) {
      setStatus('No monsters selected.', 'warn');
      return;
    }
    const limit = Number.parseInt(parts.limit.value, 10);
    const infos = boxes.map((box) => cardInfo(box.closest('.monster-card')));
    const targets = selectLootTargets(infos, { protectedNames: guarded, limit: limit > 0 ? limit : Infinity });
    if (!targets.length) {
      setStatus('Nothing to loot: the selected monsters are not eligible or reserved for quests.', 'warn');
      return;
    }
    run(parts.loot, 'Looting…', async () => {
      const totals = await lootTargets(ctx, session, targets, {
        concurrency: 4,
        delayMs: 100,
        onProgress: (current) => setStatus(`Looting ${current.processed}/${targets.length}…`),
      });
      setStatus(`Finished: ${totals.success} looted, ${totals.fail} failed.`, totals.fail ? 'warn' : 'ok');
      showLootResults(doc, { title: '🎁 Loot Gained', totals });
    });
  });

  // Fast loot of every eligible 0-damage monster (no rewards, no modal)
  parts.zero.addEventListener('click', () => {
    const targets = selectLootTargets(cards.map(cardInfo), {
      protectedNames: protectedNames(ctx),
      ignoreBosses: ctx.setting(IGNORE_BOSSES.key) === true,
      zeroDamageOnly: true,
    });
    if (!targets.length) {
      setStatus('No eligible 0-damage monsters found.', 'warn');
      return;
    }
    run(parts.zero, `Looting 0 dmg… (0/${targets.length})`, async () => {
      const totals = await lootTargets(ctx, session, targets, {
        concurrency: 4,
        delayMs: 100,
        onProgress: (current) => {
          parts.zero.textContent = `Looting 0 dmg… (${current.processed}/${targets.length})`;
        },
      });
      setStatus(
        totals.fail
          ? `0-damage looting finished: ${totals.success} looted, ${totals.fail} failed.`
          : `0-damage looting finished: ${totals.success} monsters looted.`,
        totals.fail ? 'warn' : 'ok',
      );
    });
  });

  // Extract shadow + loot, sequential, hard cap 5
  parts.extract.addEventListener('click', () => {
    const boxes = checkedBoxes();
    if (!boxes.length) {
      setStatus('No monsters selected for extraction.', 'warn');
      return;
    }
    for (const box of boxes.slice(EXTRACT_CAP)) box.checked = false;
    const targets = selectLootTargets(
      boxes.slice(0, EXTRACT_CAP).map((box) => cardInfo(box.closest('.monster-card'))),
      { protectedNames: protectedNames(ctx) },
    );
    if (!targets.length) {
      setStatus('The selected monsters are not eligible or reserved for quests.', 'warn');
      return;
    }
    run(parts.extract, 'Extracting…', async () => {
      const totals = createLootTotals(targets.length);
      const userId = await resolveUserId(ctx);
      for (const [index, target] of targets.entries()) {
        if (session.stopRequested) break;
        setStatus(`Extracting & looting ${index + 1} of ${targets.length}…`);
        const extracted = await extractShadow(ctx.postForm, target.id);
        await sleep(300);
        const looted = await lootMonster(ctx.postForm, { monsterId: target.id, userId });
        const combined = {
          ...looted,
          ok: extracted.ok || looted.ok,
          items: [...(looted.ok ? looted.items : []), ...(extracted.shadow ? [extracted.shadow] : [])],
          note: looted.ok ? looted.note : extracted.ok ? '' : looted.note || extracted.message,
        };
        addLootResult(totals, combined);
        if (looted.ok) {
          session.expGained += looted.exp || 0;
          markLooted(doc, target.id);
        }
        await sleep(400);
      }
      setStatus('Extraction & looting complete.', 'ok');
      showLootResults(doc, { title: '☠️ Extracted & 🎁 Looted', totals });
    });
  });

  // Loot to level up (sequential, stop button)
  parts.level.addEventListener('click', () => {
    if (session.busy) {
      if (parts.level.classList.contains('is-running')) {
        session.stopRequested = true;
        parts.level.textContent = 'Stopping…';
        setStatus('Stopping after the current request…', 'warn');
      }
      return;
    }
    const targets = selectLootTargets(cards.map(cardInfo), {
      protectedNames: protectedNames(ctx),
      ignoreBosses: ctx.setting(IGNORE_BOSSES.key) === true,
      visibleOnly: true,
    });
    if (!targets.length) {
      setStatus('No visible and eligible monsters are available.', 'warn');
      return;
    }
    const pageExp = getRequiredExperienceToLevel(doc);
    const remaining = pageExp === null ? null : pageExp - session.expGained;
    const startLevel = getCurrentLevel(doc);
    const tracker = createLevelUpTracker({ expToLevel: remaining !== null && remaining > 0 ? remaining : null, startLevel });
    if (!tracker.knowsRequirement && startLevel === null) {
      setStatus('Your level and EXP could not be read, so a level up cannot be detected.', 'warn');
      return;
    }

    run(parts.level, '⏹ Stop level loot', async () => {
      parts.level.classList.add('is-running');
      const totals = createLootTotals(targets.length);
      const userId = await resolveUserId(ctx);
      const worker = async (target) => {
        const result = await lootMonster(ctx.postForm, { monsterId: target.id, userId });
        // Without a known EXP requirement, read the level from a fresh page
        // after every successful loot (the only other signal is the server).
        if (result.ok && !tracker.knowsRequirement && !result.levelUp) {
          result.freshLevel = await readFreshLevel(ctx);
        }
        return result;
      };
      await runLimited(targets, worker, {
        concurrency: 1,
        delayMs: 300,
        shouldStop: () => session.stopRequested || tracker.reached,
        onResult: (result, target) => {
          addLootResult(totals, result);
          if (result.ok) {
            markLooted(doc, target.id);
            session.expGained += result.exp || 0;
          }
          tracker.add(result);
          if (result.freshLevel) tracker.observeLevel(result.freshLevel);
          setStatus(`Looting #${totals.processed}${startLevel ? ` (level ${startLevel})` : ''}… click again to stop.`);
        },
      });
      if (!tracker.reached) {
        setStatus(
          session.stopRequested ? 'Loot to level up stopped.' : 'No more visible eligible monsters.',
          'warn',
        );
      } else {
        setStatus(`⬆️ Level up reached – looting stopped.`, 'ok');
      }
      const title = tracker.reached ? '⬆️ Level Up Reached' : session.stopRequested ? '⏹ Level Loot Stopped' : '🎁 Level Loot Finished';
      showLootResults(doc, { title, totals, extraChips: tracker.reached ? ['Leveled up!'] : [] });
    });
  });

  // Keep the extra decorations on cards the page adds later.
  observeDebounced(ctx.win, container, () => {
    const fresh = deadCards(container).filter((card) => !card.querySelector('.veyra-loot-pick'));
    if (!fresh.length) return;
    for (const card of fresh) if (!cards.includes(card)) cards.push(card);
    decorateCards(doc, fresh, protectedNames(ctx));
  }, 400);
}

module.exports = Object.freeze({
  id: 'wave-loot',
  group: 'Loot',
  settings: SETTINGS,

  matches(url) {
    return /\/active_wave\.php$/i.test(url.pathname);
  },

  async run(ctx) {
    const doc = ctx.doc;
    if (!doc?.body) return;
    ensureLootStyle(doc);
    ensureWaveStyle(doc);
    const session = createSession(ctx);
    const pageInfo = parseDeadPageCount({ text: findDeadPageText(doc)?.textContent, unclaimed: readUnclaimedKills(doc) });
    session.totalPages = pageInfo.total;
    session.lastLoadedPage = Number.parseInt(ctx.url.searchParams.get('dead_page') || String(pageInfo.current), 10) || 1;

    const showChips = ctx.setting(DAMAGE_CHIP.key) === true;
    const looter = ctx.setting(DEAD_LOOTER.key) === true;
    if (showChips) addDamageChips(doc);
    setupLootX(ctx, session);
    if (looter) installActiveSortButton(doc);

    observeDebounced(ctx.win, doc.body, () => {
      if (showChips) addDamageChips(doc);
      if (looter) installActiveSortButton(doc);
      setupLootX(ctx, session);
    }, 400);

    if (looter) await setupDeadLooter(ctx, session);
  },

  helpers: Object.freeze({
    cardInfo,
    parseDamage,
    parseDeadPageCount,
    selectLootTargets,
    sortByDamage,
  }),
});
