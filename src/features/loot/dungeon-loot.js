'use strict';

// Dungeon bulk looting, from veyra-hud ui-improvements "Dungeon Loot" (MIT,
// koenrad):
//   guild_dungeon_instance.php  "💰 Loot Monsters" (locations from the map pins)
//   guild_dungeon_cube.php      "💰 Loot All"      (locations from STATE.nodes)
//
// Changes against veyra-hud:
// - Uses the game's bulk endpoint dungeon_loot.php action=loot_all per
//   location (one request instead of one per monster). Falls back to
//   per-monster looting when the endpoint does not answer with JSON.
// - "Stop looting on level up" never stops just because the EXP requirement
//   is unknown (veyra-hud stopped after the first monster). When the
//   requirement is known it loots monster by monster to stop right at the
//   level up; otherwise it uses the bulk endpoint and stops only on an
//   explicit level-up signal from the server.
// - Requests are throttled; buttons always recover; null-safe placement.

const { getCurrentLevel, getRequiredExperienceToLevel, isCloudflareError } = require('../../core/game');
const { sleep } = require('../../core/time');
const {
  addLootResult,
  createLevelUpTracker,
  createLootTotals,
  lootDungeonLocation,
  lootMonster,
  runLimited,
  validId,
} = require('./loot-api');
const { ensureLootStyle, formatNumber, observeDebounced, showLootResults } = require('./loot-ui');

const USE_DUNGEON_LOOT = Object.freeze({
  key: 'ui-improvements:useDungeonLoot',
  label: 'Dungeon bulk loot buttons',
  type: 'checkbox',
  default: true,
  hint: '"Loot Monsters" on dungeon instances and "Loot All" in the Crucible.',
});

const STOP_ON_LEVEL_UP = Object.freeze({
  key: 'ui-improvements:stopLootingOnLevelUp',
  label: 'Stop dungeon looting on level up',
  type: 'checkbox',
  default: true,
  hint: 'Only stops when a level up is actually detected; an unknown EXP requirement never stops looting.',
  visibleIf: (get) => get(USE_DUNGEON_LOOT.key) === true,
});

const BUTTON_ID = 'veyra-dungeon-loot-btn';
const LOCATION_DELAY_MS = 300;

function pageKind(url) {
  if (/\/guild_dungeon_instance\.php$/i.test(url.pathname)) return 'instance';
  if (/\/guild_dungeon_cube\.php$/i.test(url.pathname)) return 'cube';
  return null;
}

// Map pins of an instance page → [{instanceId, locationId}], locked pins
// skipped. Accepts anything with getAttribute('href').
function locationsFromPins(pins, fallbackInstanceId = null) {
  const seen = new Set();
  const locations = [];
  for (const pin of pins || []) {
    if (pin?.classList?.contains?.('locked')) continue;
    const href = String(pin?.getAttribute?.('href') || pin?.href || '').replace(/&amp;/g, '&');
    const locationId = validId(href.match(/[?&]location_id=(\d+)/)?.[1]);
    const instanceId = validId(href.match(/[?&]instance_id=(\d+)/)?.[1]) || validId(fallbackInstanceId);
    if (!locationId || !instanceId || seen.has(locationId)) continue;
    seen.add(locationId);
    locations.push({ instanceId, locationId });
  }
  return locations;
}

// Crucible STATE.nodes → location ids of revealed monster rooms that have
// at least one dead monster (when the counts are known).
function locationsFromState(state) {
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const seen = new Set();
  const ids = [];
  for (const node of nodes) {
    const locationId = validId(node?.linked_location_id);
    if (!locationId || !Number(node?.is_revealed) || seen.has(locationId)) continue;
    const total = Number(node?.monsters_total);
    const left = Number(node?.monsters_left);
    if (Number.isFinite(total) && Number.isFinite(left) && total - left <= 0) continue;
    seen.add(locationId);
    ids.push(locationId);
  }
  return ids;
}

function instanceIdFromState(state) {
  const leaders = Array.isArray(state?.run_leaders) ? state.run_leaders : [];
  return validId(state?.instance_id ?? state?.INSTANCE_ID ?? leaders[0]?.INSTANCE_ID);
}

// Unlooted dead monsters on a guild_dungeon_location.php document.
function findUnlootedMonsters(doc) {
  const monsters = [];
  const seen = new Set();
  for (const mon of doc?.querySelectorAll?.('.mon') || []) {
    const pills = [...mon.querySelectorAll('.pill')].map((pill) => pill.textContent.trim().toLowerCase());
    if (!pills.some((text) => /^not\s+looted$/.test(text))) continue;
    const link = mon.querySelector('a[href*="dgmid="]');
    const id = validId(String(link?.getAttribute('href') || '').match(/dgmid=(\d+)/)?.[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    monsters.push({ id });
  }
  return monsters;
}

async function lootLocationPerMonster(ctx, { instanceId, locationId, userId, precise, tracker, stopOnLevelUp, totals, onProgress }) {
  let doc;
  try {
    doc = await ctx.fetchDocument(`/guild_dungeon_location.php?instance_id=${instanceId}&location_id=${locationId}`);
  } catch (error) {
    totals.notes.push(`Location ${locationId} could not be loaded.`);
    ctx.warn('Location fetch failed', locationId, error);
    return;
  }
  if (isCloudflareError(doc)) {
    totals.notes.push(`Location ${locationId} is temporarily unavailable (Cloudflare).`);
    await sleep(3_000);
    return;
  }
  const monsters = findUnlootedMonsters(doc);
  totals.planned += monsters.length;
  await runLimited(monsters, (monster) => lootMonster(ctx.postForm, { monsterId: monster.id, userId, instanceId }), {
    concurrency: precise ? 1 : 4,
    delayMs: precise ? 150 : 100,
    shouldStop: () => stopOnLevelUp && tracker.reached,
    onResult: (result) => {
      addLootResult(totals, result);
      tracker.add(result);
      onProgress();
    },
  });
}

async function lootDungeon(ctx, { instanceId, locationIds, stopOnLevelUp, onProgress = () => {} }) {
  const totals = createLootTotals(0);
  const tracker = createLevelUpTracker({
    expToLevel: getRequiredExperienceToLevel(ctx.doc),
    startLevel: getCurrentLevel(ctx.doc),
  });
  // Precise (monster by monster) only when we can actually see the level up
  // coming; otherwise one bulk request per location.
  const precise = Boolean(stopOnLevelUp && tracker.knowsRequirement);
  const userId = validId(ctx.pageGlobal('USER_ID')) || validId(await ctx.getUserId?.());

  for (const [index, locationId] of locationIds.entries()) {
    if (stopOnLevelUp && tracker.reached) break;
    if (index > 0) await sleep(LOCATION_DELAY_MS);
    onProgress(totals, `location ${index + 1}/${locationIds.length}`);

    if (!precise) {
      const bulk = await lootDungeonLocation(ctx.postForm, { instanceId, locationId });
      if (bulk.ok) {
        addLootResult(totals, bulk);
        tracker.add(bulk);
        continue;
      }
      if (bulk.understood) {
        // A JSON refusal such as "nothing to loot here" is not a failure.
        if (bulk.message && bulk.message !== 'Failed') totals.notes.push(bulk.message);
        continue;
      }
      ctx.warn('Bulk loot not available, looting monster by monster.', locationId, bulk.message);
    }

    await lootLocationPerMonster(ctx, {
      instanceId,
      locationId,
      userId,
      precise,
      tracker,
      stopOnLevelUp,
      totals,
      onProgress: () => onProgress(totals, `location ${index + 1}/${locationIds.length}`),
    });
  }

  totals.levelUp = totals.levelUp || tracker.reached;
  return { totals, leveledUp: tracker.reached, precise };
}

function findInstanceButtonRow(doc) {
  const back = doc.querySelector('.wrap a.btn[href*="guild_dungeon.php"]');
  return back?.parentElement || doc.querySelector('.wrap .row .row') || null;
}

function makeButton(doc, label) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.id = BUTTON_ID;
  button.className = 'btn';
  button.textContent = label;
  button.dataset.label = label;
  return button;
}

function placeButton(doc, kind, button) {
  const host = kind === 'cube' ? doc.querySelector('.stageTools') : findInstanceButtonRow(doc);
  if (host) {
    host.appendChild(button);
    return;
  }
  // No known toolbar: small floating button (bottom left, clear of the menu).
  button.classList.add('veyra-loot-floating');
  doc.body.appendChild(button);
}

const FLOATING_CSS_ID = 'veyra-automation-dungeon-loot-style';

function ensureFloatingStyle(doc) {
  if (doc.getElementById(FLOATING_CSS_ID)) return;
  const style = doc.createElement('style');
  style.id = FLOATING_CSS_ID;
  style.textContent =
    `#${BUTTON_ID}[disabled]{opacity:.65;cursor:progress}` +
    `#${BUTTON_ID}.veyra-loot-floating{position:fixed;left:12px;bottom:12px;z-index:2147482000;` +
    'padding:10px 14px;border-radius:10px;background:#1e1f2e;color:#ffd369;border:1px solid #ce9e00;font-weight:700}';
  (doc.head || doc.documentElement).appendChild(style);
}

module.exports = Object.freeze({
  id: 'dungeon-loot',
  group: 'Loot',
  settings: [USE_DUNGEON_LOOT, STOP_ON_LEVEL_UP],
  enabledBy: USE_DUNGEON_LOOT.key,

  matches(url) {
    return pageKind(url) !== null;
  },

  run(ctx) {
    const { doc, url } = ctx;
    if (!doc?.body) return;
    const kind = pageKind(url);
    const label = kind === 'cube' ? '💰 Loot All' : '💰 Loot Monsters';
    ensureLootStyle(doc);
    ensureFloatingStyle(doc);

    let busy = false;

    const resolveTargets = () => {
      if (kind === 'cube') {
        const state = ctx.pageGlobal('STATE');
        const instanceId = validId(url.searchParams.get('instance_id')) || instanceIdFromState(state);
        return { instanceId, locationIds: locationsFromState(state) };
      }
      const fallback = validId(url.searchParams.get('id'));
      const locations = locationsFromPins(doc.querySelectorAll('.mapwrap .pin'), fallback);
      return {
        instanceId: locations[0]?.instanceId || fallback,
        locationIds: locations.map((location) => location.locationId),
      };
    };

    const onClick = async (button) => {
      if (busy) return;
      const { instanceId, locationIds } = resolveTargets();
      if (!instanceId) {
        ctx.notify('Dungeon instance id not found.', 'error');
        return;
      }
      if (!locationIds.length) {
        ctx.notify('No unlocked locations with dead monsters found.', 'error');
        return;
      }

      busy = true;
      button.disabled = true;
      button.textContent = '💰 Looting…';
      try {
        const { totals, leveledUp } = await lootDungeon(ctx, {
          instanceId,
          locationIds,
          stopOnLevelUp: ctx.setting(STOP_ON_LEVEL_UP.key) === true,
          onProgress: (current, where) => {
            button.textContent = `💰 Looting… ${formatNumber(current.success)} (${where})`;
          },
        });
        ctx.notify(
          leveledUp ? `Level up! Looted ${totals.success} monsters.` : `Looted ${totals.success} monsters.`,
          totals.fail && !totals.success ? 'error' : 'success',
        );
        showLootResults(doc, {
          title: leveledUp ? '⬆️ Level Up – Loot Gained' : '🎁 Dungeon Loot',
          totals,
          extraChips: leveledUp ? ['Leveled up!'] : [],
          reloadOnClose: totals.success > 0 || totals.items.length > 0,
        });
      } catch (error) {
        ctx.warn('Dungeon looting failed', error);
        ctx.notify('Dungeon looting failed.', 'error');
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = button.dataset.label || label;
      }
    };

    const ensureButton = () => {
      if (doc.getElementById(BUTTON_ID)) return;
      const button = makeButton(doc, label);
      button.addEventListener('click', () => onClick(button));
      placeButton(doc, kind, button);
    };

    ensureButton();
    // The cube page re-renders its toolbar; put the button back if needed.
    if (kind === 'cube') observeDebounced(ctx.win, doc.body, ensureButton, 400);
  },

  helpers: Object.freeze({
    findUnlootedMonsters,
    instanceIdFromState,
    locationsFromPins,
    locationsFromState,
    lootDungeon,
  }),
});
