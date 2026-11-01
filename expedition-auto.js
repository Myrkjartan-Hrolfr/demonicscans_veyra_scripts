// ==UserScript==
// @name         Veyra - Dragon Realm Expedition Auto
// @namespace    local.veyra.expeditions
// @version      1.1.0
// @description  Independently starts and completes Dragon Realm expeditions, including party setup, votes, combat, loot and powers.
// @match        https://demonicscans.org/event_page.php*
// @match        https://www.demonicscans.org/event_page.php*
// @match        https://demonicscans.org/event_hunt.php*
// @match        https://www.demonicscans.org/event_hunt.php*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function bootstrap(factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module?.exports) module.exports = api;
  if (typeof window !== 'undefined' && window.document) api.start(window);
})(function expeditionAutoFactory() {
  'use strict';

  const STORAGE_KEY = 'veyra:expedition-auto:settings:v1';
  const PANEL_ID = 'veyra-expedition-auto';
  const TICK_MS = 750;
  const ACTION_THROTTLE_MS = 2_500;
  const CLASSES = Object.freeze(['tank', 'warrior', 'mage', 'archer', 'assassin', 'healer']);
  const DEFAULTS = Object.freeze({
    enabled: false,
    autoStart: false,
    fillWithNpcs: true,
    preferredClass: 'mage',
    routeChoice: 'left',
    claimRareLoot: true,
    autoRescue: true,
    collapsed: false,
  });

  function normalizeSettings(value) {
    const preferredClass = String(value?.preferredClass || DEFAULTS.preferredClass).toLowerCase();
    return {
      enabled: value?.enabled === true,
      autoStart: value?.autoStart === true,
      fillWithNpcs: value?.fillWithNpcs !== false,
      preferredClass: CLASSES.includes(preferredClass) ? preferredClass : DEFAULTS.preferredClass,
      routeChoice: value?.routeChoice === 'right' ? 'right' : 'left',
      claimRareLoot: value?.claimRareLoot !== false,
      autoRescue: value?.autoRescue !== false,
      collapsed: value?.collapsed === true,
    };
  }

  function footprint(unit) {
    return unit?.class ? 1 : Math.max(1, Math.min(3, Number(unit?.footprint) || 1));
  }

  function occupies(unit, position) {
    const size = footprint(unit);
    return (
      position.row >= Number(unit?.row) &&
      position.row < Number(unit?.row) + size &&
      position.col >= Number(unit?.col) &&
      position.col < Number(unit?.col) + size
    );
  }

  function distance(left, right) {
    return (
      Math.max(
        0,
        Number(left?.row) - Number(right?.row) - footprint(right) + 1,
        Number(right?.row) - Number(left?.row) - footprint(left) + 1,
      ) +
      Math.max(
        0,
        Number(left?.col) - Number(right?.col) - footprint(right) + 1,
        Number(right?.col) - Number(left?.col) - footprint(left) + 1,
      )
    );
  }

  function effectActive(run, unit, key) {
    return Boolean(unit?.[key]) || Number(unit?.[`${key}_until`] ?? -1) >= Number(run?.round || 0);
  }

  function actedThisRound(run, actor) {
    return actor?.acted_on === `${run?.battleSerial}:${run?.round}`;
  }

  function movedThisRound(run, actor) {
    return actor?.moved_on === `${run?.battleSerial}:${run?.round}`;
  }

  function actorFor(run, userId) {
    return (run?.actors || []).find((actor) => Number(actor?.uid) === Number(userId) && !actor?.bot) || null;
  }

  function skillRange(actor, skill) {
    if (skill?.target === 'self') return 0;
    if (Number.isFinite(Number(skill?.range))) return Number(skill.range);
    return ['mage', 'archer', 'healer'].includes(actor?.class || actor?.combat_class) ? 3 : 1;
  }

  function skillReady(run, actor, skillKey, catalog) {
    const skill = catalog?.skills?.[skillKey];
    if (!skill || run?.phase !== 'battle' || !actor || Number(actor.hp) <= 0 || actedThisRound(run, actor)) return false;
    if (skillKey !== 'guard' && effectActive(run, actor, 'interrupted')) return false;
    const known = (actor.skills || []).includes(skillKey) || ['guard', 'rescue'].includes(skillKey);
    return known && Number(actor.energy || 0) >= Number(skill.cost || 0) && Number(actor.cooldowns?.[skillKey] || 0) <= 0;
  }

  function targetable(run, actor, unit, skillKey, catalog) {
    const skill = catalog?.skills?.[skillKey];
    if (!skill || !unit || unit.id === 'o_cart') return false;
    if (skill.target === 'self') return unit.id === actor.id;
    if (distance(actor, unit) > skillRange(actor, skill)) return false;
    if (skill.target === 'enemy') {
      if (unit.class || Number(unit.hp) <= 0) return false;
      const taunters = (run.enemies || []).filter(
        (enemy) => Number(enemy.hp) > 0 && effectActive(run, enemy, 'taunting') && distance(actor, enemy) <= 1,
      );
      return !taunters.length || taunters.some((enemy) => enemy.id === unit.id);
    }
    if (skill.target === 'ally') return Boolean(unit.class) && Number(unit.hp) > 0;
    if (skill.target === 'fallen') return Boolean(unit.class) && Number(unit.hp) <= 0;
    return false;
  }

  function pointKey(point) {
    return `${Number(point?.row)}:${Number(point?.col)}`;
  }

  function dangerTiles(run) {
    const keys = new Set((run?.ground_warning || []).map(pointKey));
    for (const enemy of run?.enemies || []) {
      for (const tile of enemy?.intent?.tiles || []) keys.add(pointKey(tile));
      if (Number(enemy?.hazard?.resolve_round || -1) >= Number(run?.round || 0)) {
        for (const tile of enemy?.hazard?.tiles || []) keys.add(pointKey(tile));
      }
    }
    return keys;
  }

  function validMoves(run, actor) {
    if (!run || !actor || run.phase !== 'battle' || Number(actor.hp) <= 0 || movedThisRound(run, actor)) return [];
    const board = run.board || { rows: 8, cols: 8 };
    const blocked = new Set((run.blocked || []).map(pointKey));
    const occupied = [
      ...(run.actors || []).filter((unit) => unit.id !== actor.id && Number(unit.hp) > 0),
      ...(run.enemies || []).filter((unit) => Number(unit.hp) > 0),
      ...(run.objects || []).filter((unit) => Number(unit.hp) > 0),
    ];
    return [
      { lane: 0, row: Number(actor.row) - 1, col: Number(actor.col) },
      { lane: 0, row: Number(actor.row) + 1, col: Number(actor.col) },
      { lane: 0, row: Number(actor.row), col: Number(actor.col) - 1 },
      { lane: 0, row: Number(actor.row), col: Number(actor.col) + 1 },
    ].filter(
      (position) =>
        position.row >= 0 &&
        position.row < Number(board.rows || 8) &&
        position.col >= 0 &&
        position.col < Number(board.cols || 8) &&
        !blocked.has(pointKey(position)) &&
        !occupied.some((unit) => occupies(unit, position)),
    );
  }

  function chooseMove(run, actor, escapeOnly = false) {
    const moves = validMoves(run, actor);
    if (!moves.length) return null;
    const danger = dangerTiles(run);
    const enemies = (run.enemies || []).filter((enemy) => Number(enemy.hp) > 0);
    const safe = moves.filter((position) => !danger.has(pointKey(position)));
    const candidates = safe.length ? safe : escapeOnly ? [] : moves;
    const nearest = (position) => enemies.length ? Math.min(...enemies.map((enemy) => distance(position, enemy))) : 0;
    return candidates.sort(
      (left, right) =>
        Number(danger.has(pointKey(left))) - Number(danger.has(pointKey(right))) ||
        nearest(left) - nearest(right) ||
        left.row - right.row ||
        left.col - right.col,
    )[0] || null;
  }

  function rescueAvailable(run, unit) {
    const guild = unit && !unit.bot && unit.guild_dragon
      ? Math.max(0, Number(run?.guild_dragon_rescues?.[unit.guild] || 0))
      : 0;
    return Number(run?.supplies || 0) + guild > 0 && Number(unit?.rescueCount || 0) < 2;
  }

  function orderDecision(run, skill, target, message) {
    return {
      action: 'order',
      key: `order:${run.battleSerial}:${run.round}:${skill}:${target}`,
      message,
      data: { round: run.round, battle: run.battleSerial, order: { skill, target, move: null } },
    };
  }

  function healthRatio(unit) {
    return Number(unit?.maxHp) > 0 ? Number(unit.hp || 0) / Number(unit.maxHp) : 1;
  }

  function chooseCombatAction(run, catalog, userId, settings) {
    const actor = actorFor(run, userId);
    if (!actor) return { action: '', message: 'Waiting for your hunter.' };
    if (Number(actor.hp) <= 0) return { action: '', message: 'Your hunter is down; waiting for Rescue.' };

    const danger = dangerTiles(run);
    if (!movedThisRound(run, actor) && danger.has(pointKey(actor))) {
      const escape = chooseMove(run, actor, true);
      if (escape) {
        return {
          action: 'move',
          key: `move:${run.battleSerial}:${run.round}:${pointKey(escape)}`,
          message: 'Leaving a marked danger tile.',
          data: { round: run.round, battle: run.battleSerial, position: escape },
        };
      }
    }
    if (actedThisRound(run, actor)) return { action: '', message: `Round ${run.round}: action completed.` };

    if (settings.autoRescue && skillReady(run, actor, 'rescue', catalog)) {
      const fallen = (run.actors || []).filter(
        (unit) =>
          unit.id !== actor.id &&
          targetable(run, actor, unit, 'rescue', catalog) &&
          rescueAvailable(run, unit),
      ).sort((left, right) => Number(left.bot) - Number(right.bot));
      if (fallen[0]) return orderDecision(run, 'rescue', fallen[0].id, `Rescuing ${fallen[0].name || 'party member'}.`);
    }

    const skills = (actor.skills || []).filter((key) => skillReady(run, actor, key, catalog)).sort(
      (left, right) => Number(catalog.skills[right]?.cost || 0) - Number(catalog.skills[left]?.cost || 0),
    );
    for (const key of skills) {
      const skill = catalog.skills[key];
      if (skill.target !== 'enemy') continue;
      const targets = (run.enemies || []).filter((enemy) => targetable(run, actor, enemy, key, catalog)).sort(
        (left, right) =>
          Number(right.boss) - Number(left.boss) || Number(left.hp || 0) - Number(right.hp || 0),
      );
      if (targets[0]) return orderDecision(run, key, targets[0].id, `${skill.name || key} on ${targets[0].name || 'enemy'}.`);
    }
    for (const key of skills) {
      const skill = catalog.skills[key];
      if (!['ally', 'self'].includes(skill.target)) continue;
      const text = `${skill.name || ''} ${skill.text || ''}`.toLowerCase();
      if (!/heal|restore|recover|shield|protect|guard|cleanse/.test(text)) continue;
      const targets = (run.actors || []).filter((unit) => targetable(run, actor, unit, key, catalog)).sort(
        (left, right) => healthRatio(left) - healthRatio(right),
      );
      if (targets[0] && healthRatio(targets[0]) < 0.8) {
        return orderDecision(run, key, targets[0].id, `${skill.name || key} on ${targets[0].name || 'ally'}.`);
      }
    }
    const move = chooseMove(run, actor);
    if (move) {
      return {
        action: 'move',
        key: `move:${run.battleSerial}:${run.round}:${pointKey(move)}`,
        message: 'Moving toward the nearest enemy.',
        data: { round: run.round, battle: run.battleSerial, position: move },
      };
    }
    if (skillReady(run, actor, 'guard', catalog) && targetable(run, actor, actor, 'guard', catalog)) {
      return orderDecision(run, 'guard', actor.id, 'No target in reach; Guarding.');
    }
    return { action: '', message: `Round ${run.round}: no valid action.` };
  }

  function choosePower(powers, actorClass) {
    const wanted = {
      tank: ['defense', 'armour', 'armor', 'health', 'hp', 'shield'],
      warrior: ['attack', 'damage', 'critical', 'strength'],
      mage: ['magic', 'energy', 'spell', 'damage'],
      archer: ['attack', 'critical', 'range', 'damage'],
      assassin: ['critical', 'attack', 'damage', 'evade'],
      healer: ['heal', 'magic', 'energy', 'health'],
    }[actorClass] || ['damage', 'health', 'energy'];
    return Object.entries(powers || {}).map(([key, power], index) => {
      const text = `${power?.name || ''} ${power?.text || ''}`.toLowerCase();
      const score = wanted.reduce((sum, word, priority) => sum + (text.includes(word) ? wanted.length - priority : 0), 0);
      return { key, score, index };
    }).sort((left, right) => right.score - left.score || left.index - right.index)[0]?.key || '';
  }

  // A normal window.setInterval is heavily throttled in background tabs.
  // A dedicated worker is usually allowed to keep a steadier cadence. The
  // window timer stays as a fallback for browsers or CSPs that block workers.
  function createBackgroundTicker(win, callback, intervalMs = TICK_MS) {
    const doc = win.document;
    let worker = null;
    let workerUrl = '';
    const fallbackId = win.setInterval(callback, intervalMs);
    try {
      if (typeof win.Worker === 'function' && typeof win.Blob === 'function' && win.URL?.createObjectURL) {
        const source = `
          let timer = 0;
          self.onmessage = (event) => {
            if (event.data?.type === 'stop') {
              clearInterval(timer);
              timer = 0;
              return;
            }
            if (event.data?.type === 'start') {
              clearInterval(timer);
              const delay = Math.max(250, Number(event.data.interval) || 1000);
              timer = setInterval(() => self.postMessage(Date.now()), delay);
              self.postMessage(Date.now());
            }
          };
        `;
        workerUrl = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
        worker = new win.Worker(workerUrl);
        worker.onmessage = callback;
        worker.onerror = () => {
          worker?.terminate?.();
          worker = null;
        };
        worker.postMessage({ type: 'start', interval: intervalMs });
        win.setTimeout?.(() => {
          if (workerUrl) win.URL.revokeObjectURL?.(workerUrl);
          workerUrl = '';
        }, 0);
      }
    } catch {
      worker?.terminate?.();
      worker = null;
      if (workerUrl) win.URL?.revokeObjectURL?.(workerUrl);
      workerUrl = '';
    }

    const catchUp = () => callback();
    doc.addEventListener?.('visibilitychange', catchUp);
    win.addEventListener?.('pageshow', catchUp);
    win.addEventListener?.('focus', catchUp);
    return () => {
      win.clearInterval?.(fallbackId);
      worker?.postMessage?.({ type: 'stop' });
      worker?.terminate?.();
      if (workerUrl) win.URL?.revokeObjectURL?.(workerUrl);
      doc.removeEventListener?.('visibilitychange', catchUp);
      win.removeEventListener?.('pageshow', catchUp);
      win.removeEventListener?.('focus', catchUp);
    };
  }

  function start(win) {
    const doc = win.document;
    const page = new URL(win.location.href);
    const lodgePage = /\/event_page\.php$/i.test(page.pathname) && page.searchParams.get('event') === '13' && page.searchParams.get('map') === '24';
    const huntPage = /\/event_hunt\.php$/i.test(page.pathname) && page.searchParams.get('event') === '13' && (page.searchParams.get('lodge_map') === '24' || doc.getElementById('huntBootstrap')?.dataset?.lodge?.includes('map=24'));
    if ((!lodgePage && !huntPage) || win.__veyraExpeditionAutoLoaded) return;
    win.__veyraExpeditionAutoLoaded = true;

    let settings;
    try { settings = normalizeSettings(JSON.parse(win.localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { settings = normalizeSettings(null); }
    const runtime = {
      busy: false,
      boot: doc.getElementById('huntBootstrap') || null,
      catalog: null,
      partyId: 0,
      lastActionKey: '',
      lastActionAt: 0,
      submittedSelections: new Set(),
      nextTickAt: 0,
      failures: 0,
      returning: false,
      message: 'Ready.',
    };

    function save() {
      try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
      renderControls();
    }

    const style = doc.createElement('style');
    style.textContent = `
      #${PANEL_ID}{position:fixed;z-index:2147483645;left:12px;bottom:12px;width:min(390px,calc(100vw - 24px));max-height:min(82vh,680px);display:flex;flex-direction:column;background:#171a27;color:#f4f5ff;border:1px solid #58628f;border-radius:14px;box-shadow:0 14px 48px #000b;font:13px/1.4 system-ui,Arial,sans-serif;overflow:hidden}
      #${PANEL_ID} *{box-sizing:border-box}#${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:#282d45}#${PANEL_ID} header strong{font-size:14px}
      #${PANEL_ID} .ea-body{padding:12px;overflow:auto}#${PANEL_ID}[data-collapsed="true"] .ea-body{display:none}#${PANEL_ID} .ea-actions{display:flex;gap:8px;margin-bottom:9px}
      #${PANEL_ID} button,#${PANEL_ID} select{min-height:36px;border:1px solid #626b98;border-radius:8px;background:#343b61;color:#fff;padding:7px 9px;font:inherit;font-weight:700;cursor:pointer}
      #${PANEL_ID} .ea-start{flex:1}#${PANEL_ID} .ea-start[data-running="true"]{background:#783c48;border-color:#aa5a67}#${PANEL_ID} .ea-fold{min-width:36px;padding:0}
      #${PANEL_ID} .ea-status{padding:9px;border-radius:8px;background:#22263a;color:#cbd3ff;white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:10px}
      #${PANEL_ID} .ea-grid{display:grid;gap:8px}#${PANEL_ID} label{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border:1px solid #34394f;border-radius:8px;background:#202332}
      #${PANEL_ID} label span{min-width:0}#${PANEL_ID} input[type="checkbox"]{width:18px;height:18px;flex:0 0 auto}#${PANEL_ID} select{width:145px;max-width:48%}#${PANEL_ID} .ea-note{margin:9px 1px 0;color:#a8aec7;font-size:11px}
    `;
    doc.head.appendChild(style);
    const root = doc.createElement('section');
    root.id = PANEL_ID;
    root.innerHTML = `<header><strong>🧭 Expedition Auto</strong><button class="ea-fold" type="button">−</button></header><div class="ea-body"><div class="ea-actions"><button class="ea-start" type="button">Start</button></div><div class="ea-status"></div><div class="ea-grid"><label><span>Start private expeditions automatically</span><input data-key="autoStart" type="checkbox"></label><label><span>Fill empty slots with NPCs</span><input data-key="fillWithNpcs" type="checkbox"></label><label><span>Preferred class</span><select data-key="preferredClass">${CLASSES.map((name) => `<option value="${name}">${name[0].toUpperCase() + name.slice(1)}</option>`).join('')}</select></label><label><span>Preferred route</span><select data-key="routeChoice"><option value="left">Left</option><option value="right">Right</option></select></label><label><span>Claim contested rare drops</span><input data-key="claimRareLoot" type="checkbox"></label><label><span>Rescue fallen party members</span><input data-key="autoRescue" type="checkbox"></label></div><p class="ea-note">Automatic start can spend daily expedition entries. Combat uses the most expensive ready attack first and avoids marked danger tiles. A background worker keeps polling while this tab is inactive; completely suspended or discarded tabs cannot run userscripts.</p></div>`;
    doc.body.appendChild(root);
    const status = root.querySelector('.ea-status');
    const startButton = root.querySelector('.ea-start');
    const foldButton = root.querySelector('.ea-fold');

    function setStatus(message, delay = 0) {
      runtime.message = String(message || '');
      status.textContent = runtime.message;
      if (delay > 0) runtime.nextTickAt = Date.now() + delay;
    }

    function renderControls() {
      root.dataset.collapsed = String(settings.collapsed);
      foldButton.textContent = settings.collapsed ? '+' : '−';
      startButton.textContent = settings.enabled ? '■ Stop' : '▶ Start';
      startButton.dataset.running = String(settings.enabled);
      for (const input of root.querySelectorAll('[data-key]')) {
        const key = input.dataset.key;
        if (input.type === 'checkbox') input.checked = settings[key] === true;
        else input.value = settings[key];
      }
      status.textContent = settings.enabled ? runtime.message : 'Paused.';
    }

    startButton.addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      runtime.nextTickAt = 0;
      runtime.failures = 0;
      setStatus(settings.enabled ? 'Starting expedition automation…' : 'Paused.');
      save();
      if (settings.enabled) void tick();
    });
    foldButton.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      save();
    });
    for (const input of root.querySelectorAll('[data-key]')) {
      input.addEventListener('change', () => {
        settings[input.dataset.key] = input.type === 'checkbox' ? input.checked : input.value;
        settings = normalizeSettings(settings);
        runtime.nextTickAt = 0;
        save();
      });
    }
    renderControls();

    function endpoint() {
      const url = new URL('/event_hunt.php', win.location.origin);
      url.searchParams.set('event', '13');
      url.searchParams.set('lodge_map', '24');
      url.searchParams.set('tab', 'expeditions');
      return url;
    }

    function attribute(tag, name) {
      return String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';
    }

    async function ensureBootstrap() {
      if (runtime.boot?.dataset?.csrf && runtime.boot?.dataset?.user) return;
      const response = await win.fetch(endpoint().href, { credentials: 'same-origin', cache: 'no-store' });
      const html = await response.text();
      const tag = html.match(/<[^>]+id=["']huntBootstrap["'][^>]*>/i)?.[0] || '';
      const csrf = attribute(tag, 'data-csrf');
      const user = attribute(tag, 'data-user');
      if (!response.ok || !csrf || !user) throw Error('Could not load expedition access data.');
      runtime.boot = { dataset: { csrf, user, practice: attribute(tag, 'data-practice') || '0' } };
    }

    const userId = () => Number(runtime.boot?.dataset?.user || 0);
    function requestId() {
      try { return Array.from(win.crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, '0')).join(''); }
      catch { return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(64, '0').slice(0, 64); }
    }

    async function loadState(partyId = runtime.partyId) {
      const url = endpoint();
      url.searchParams.set('state', '1');
      url.searchParams.set('_veyra_auto', String(Date.now()));
      if (partyId) url.searchParams.set('party', String(partyId));
      if (!runtime.catalog) url.searchParams.set('catalog', '1');
      const response = await win.fetch(url.href, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw Error(data?.message || `State request failed (${response.status}).`);
      if (data.catalog) runtime.catalog = data.catalog;
      if (data.party?.id) runtime.partyId = Number(data.party.id);
      else if (!runtime.partyId && Number(data.activeParty) > 0) runtime.partyId = Number(data.activeParty);
      return data;
    }

    async function api(action, data = {}) {
      const response = await win.fetch(endpoint().href, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...data, csrf: runtime.boot.dataset.csrf, request: requestId() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        const error = Error(result?.message || `Action ${action} failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      if (Number(result.party) > 0) runtime.partyId = Number(result.party);
      return result;
    }

    async function perform(action, data, key, message) {
      if (runtime.lastActionKey === key && Date.now() - runtime.lastActionAt < ACTION_THROTTLE_MS) {
        setStatus(message);
        return;
      }
      runtime.lastActionKey = key;
      runtime.lastActionAt = Date.now();
      setStatus(message);
      await api(action, data);
    }

    async function waitingParty(state) {
      const party = state.party;
      const members = party.members || [];
      const minimum = Number(runtime.catalog?.minParty || 5);
      const maximum = Number(runtime.catalog?.maxParty || 10);
      const creator = Number(party.creator) === userId();
      if (party.status === 'lobby') {
        if (creator && settings.fillWithNpcs && members.length < maximum) {
          return perform('npc_fill', { party: party.id }, `fill:${party.id}:${members.length}`, 'Filling party with NPC companions…');
        }
        if (creator && members.length >= minimum) {
          return perform('call_ready', { party: party.id }, `depart:${party.id}`, 'Opening departure confirmation…');
        }
        return setStatus(`Waiting for party members (${members.length}/${minimum}).`, 5_000);
      }
      if (party.status === 'ready') {
        const own = members.find((member) => Number(member.USER_ID) === userId());
        if (own && !Number(own.READY)) return perform('ready', { party: party.id }, `ready:${party.id}`, 'Confirming departure…');
        return setStatus('Departure confirmed; waiting for the expedition to begin.');
      }
      setStatus(`Waiting for party state: ${party.status || 'unknown'}.`, 3_000);
    }

    function returnToLodge(message) {
      setStatus(message, 10_000);
      if (runtime.returning || !huntPage) return;
      runtime.returning = true;
      win.setTimeout(() => {
        const url = new URL('/event_page.php', win.location.origin);
        url.search = new URLSearchParams({ event: '13', map: '24', hunt: '1', tab: 'expeditions' });
        win.location.replace(url.href);
      }, 1_500);
    }

    async function activeRun(state) {
      const party = state.party;
      const run = party.run;
      if (!run) return setStatus('Expedition is starting…');
      const actor = actorFor(run, userId());
      const section = `Section ${Number(run.section || 0) + 1}/${run.sections?.length || '?'}`;
      if (run.phase === 'battle') {
        const decision = chooseCombatAction(run, runtime.catalog, userId(), settings);
        if (!decision.action) return setStatus(`${section} · ${decision.message}`);
        return perform(decision.action, { party: party.id, ...decision.data }, decision.key, `${section} · ${decision.message}`);
      }
      if (run.phase === 'vote') {
        if (actor && run.votes?.[actor.id] === settings.routeChoice) return setStatus(`${section} · Route vote submitted.`);
        return perform('vote', { party: party.id, selection: party.selection, choice: settings.routeChoice }, `vote:${party.selection}:${settings.routeChoice}`, `${section} · Voting ${settings.routeChoice}…`);
      }
      if (run.phase === 'loot') {
        const lots = (run.loot || []).filter((lot) => !lot.personal && (!actor || !Object.prototype.hasOwnProperty.call(lot.claims || {}, actor.id)));
        if (!lots.length) return setStatus(`${section} · Loot choice submitted.`);
        return perform('claim', { party: party.id, selection: party.selection, lots: lots.map((lot) => lot.id), selected: settings.claimRareLoot }, `loot:${party.selection}:${settings.claimRareLoot}`, `${section} · ${settings.claimRareLoot ? 'Claiming' : 'Passing'} rare drops…`);
      }
      if (run.phase === 'powers') {
        const selectionKey = `power:${party.id}:${party.selection}`;
        if (runtime.submittedSelections.has(selectionKey)) return setStatus(`${section} · Power selected.`);
        const power = choosePower(runtime.catalog.powers, actor?.class);
        if (!power) throw Error('No temporary power is available.');
        await perform('power', { party: party.id, selection: party.selection, power }, `${selectionKey}:${power}`, `${section} · Selecting a temporary power…`);
        runtime.submittedSelections.add(selectionKey);
        return;
      }
      if (run.phase === 'travel') return setStatus(`${section} · Party is travelling.`);
      if (run.phase === 'cleared') return returnToLodge('Expedition completed. Returning to the Lodge…');
      if (run.phase === 'failed') return returnToLodge(`Expedition ended: ${run.result || 'party defeated.'}`);
      setStatus(`${section} · Waiting for phase ${run.phase || 'unknown'}.`);
    }

    async function process() {
      await ensureBootstrap();
      let state = await loadState();
      if (runtime.partyId && state.party?.id !== runtime.partyId) state = await loadState(runtime.partyId);
      if (!runtime.catalog) throw Error('The expedition catalog was not returned.');
      if (!state.party && Number(state.activeParty) > 0) {
        runtime.partyId = Number(state.activeParty);
        state = await loadState(runtime.partyId);
      }
      if (!state.party) {
        runtime.partyId = 0;
        if (!settings.autoStart) return setStatus('No active expedition. Automatic start is disabled.', 5_000);
        const remaining = Math.max(0, Number(state.profile?.limit || 0) - Number(state.profile?.entries || 0));
        if (runtime.boot.dataset.practice === '1') return setStatus('Practice mode is not automated.', 30_000);
        if (state.otherModeParty) return setStatus('A party exists in another expedition mode.', 10_000);
        if (remaining <= 0) return setStatus('No expedition entries remain today.', 60_000);
        if (!state.profile?.class) return perform('class', { class: settings.preferredClass }, `class:${settings.preferredClass}`, `Selecting ${settings.preferredClass}…`);
        return perform('create_private', {}, 'create-private', 'Creating a private expedition party…');
      }
      if (state.party.status === 'active' || ['cleared', 'failed'].includes(state.party.status)) return activeRun(state);
      return waitingParty(state);
    }

    async function tick() {
      if (!settings.enabled || runtime.busy || Date.now() < runtime.nextTickAt) return;
      runtime.busy = true;
      try {
        await process();
        runtime.failures = 0;
      } catch (error) {
        runtime.failures += 1;
        setStatus(`⛔ ${error?.message || error}`, error?.status === 409 ? 1_000 : 5_000);
        if (runtime.failures >= 5) {
          settings.enabled = false;
          setStatus(`Stopped after repeated errors: ${error?.message || error}`);
          save();
        }
      } finally {
        runtime.busy = false;
      }
    }

    createBackgroundTicker(win, () => void tick(), TICK_MS);
    if (settings.enabled) void tick();
  }

  return Object.freeze({
    start,
    helpers: Object.freeze({
      actedThisRound,
      actorFor,
      chooseCombatAction,
      chooseMove,
      choosePower,
      dangerTiles,
      distance,
      createBackgroundTicker,
      normalizeSettings,
      skillReady,
      targetable,
      validMoves,
    }),
  });
});
