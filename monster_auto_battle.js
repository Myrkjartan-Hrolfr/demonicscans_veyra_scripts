// ==UserScript==
// @name         Monster Auto Battle - 3 Attack Fallback
// @namespace    http://tampermonkey.net/
// @version      1.4.2
// @description  Auto-battle for the current monster with three attacks, potion priorities, target damage, and level-up protection.
// @match        https://demonicscans.org/battle.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const ID = 'tm-monster-auto-battle';
  const STORE_KEY = `${ID}:settings:v6:${location.host}:${location.pathname}`;

  const RESUME_KEY = `${ID}:resume:v3:${location.host}:${location.pathname}`;
  const MAX_RATE_RETRIES = 8;
  const SEL = {
    monsterCard: '.battle-card.monster-card',
    attack: 'button.attack-btn',
    damage: '#yourDamageValue',
    monsterHp: '#hpText',
    stamina: '#stamina_span',
    playerHp: '#pHpText',
    playerMana: '#pManaText',
    exp: '.game-topbar .gtb-exp ' + '.gtb-exp-top span:last-child',
    potion: '.potion-use-btn',
    potionCard: '.potion-card',
  };

  const DEFAULTS = {
    attackKeys: ['', '', ''],
    autoStamina: false,
    autoMana: false,
    autoHealth: false,

    stopBeforeLevelUp: false,
    levelMultiplier: 2,

    targetDamage: '0',
    delayMs: 100,
    collapsed: false,

    potionEnabled: {},
    potionUseAmount: {},

    potionOrder: {
      stamina: [],
      mana: [],
      health: [],
    },
  };

  const state = {
    card: null,
    panel: null,

    running: false,
    monsterKey: '',

    attacks: [],
    attackSignature: '',

    potions: [],
    settings: loadSettings(),

    sessionDamage: 0,
    lastDamage: 0,
    lastExperienceGain: null,

    noDamageCount: 0,
    forcedAttackIndex: 0,

    timers: {},
  };

  const sleep = (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });

  const queryAll = (selector, root = document) => [...root.querySelectorAll(selector)];

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');

      return {
        ...DEFAULTS,
        ...saved,

        attackKeys: Array.isArray(saved.attackKeys) ? saved.attackKeys.slice(0, 3) : ['', '', ''],

        potionEnabled: {
          ...(saved.potionEnabled || {}),
        },

        potionUseAmount: {
          ...(saved.potionUseAmount || {}),
        },

        potionOrder: {
          stamina: saved.potionOrder?.stamina || [],

          mana: saved.potionOrder?.mana || [],

          health: saved.potionOrder?.health || [],
        },
      };
    } catch (error) {
      console.warn('[Monster Auto Battle] Could not load settings.', error);

      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
    } catch (error) {
      console.warn('[Monster Auto Battle] Could not save settings.', error);
    }
  }

  function formatNumber(value) {
    return Number.isFinite(value)
      ? new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 0,
        }).format(value)
      : '—';
  }

  function parseInteger(value) {
    const match = String(value ?? '').match(/-?\d{1,3}(?:[.,\s]\d{3})+|-?\d+/);

    if (!match) {
      return null;
    }

    const number = Number(match[0].replace(/\D/g, ''));

    if (!Number.isFinite(number)) {
      return null;
    }

    return match[0].trim().startsWith('-') ? -number : number;
  }

  function parseGameNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value) : null;
    }

    const match = String(value ?? '').match(/(-?[\d.,]+)\s*([kKmMbBtTqQ])?/);

    if (!match) {
      return null;
    }

    const suffix = String(match[2] || '').toLowerCase();

    /*
     * Without an abbreviation, use the existing
     * integer parser because game numbers normally
     * contain comma or dot thousands separators.
     */
    if (!suffix) {
      return parseInteger(match[1]);
    }

    const normalized = match[1].replace(/,/g, '');

    const number = Number.parseFloat(normalized);

    if (!Number.isFinite(number)) {
      return null;
    }

    const multipliers = {
      k: 1e3,
      m: 1e6,
      b: 1e9,
      t: 1e12,
      q: 1e15,
    };

    return Math.round(number * multipliers[suffix]);
  }

  function firstGameNumber(...values) {
    for (const value of values) {
      const number = parseGameNumber(value);

      if (Number.isFinite(number)) {
        return number;
      }
    }

    return null;
  }

  function parseFraction(value) {
    const match = String(value ?? '').match(/(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)/);

    if (!match) {
      return null;
    }

    const current = parseInteger(match[1]);

    const maximum = parseInteger(match[2]);

    if (!Number.isFinite(current) || !Number.isFinite(maximum)) {
      return null;
    }

    return {
      current,
      maximum,
    };
  }

  function parseTarget(value) {
    const raw = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');

    if (!raw) {
      return 0;
    }

    const match = raw.match(/^([\d.,]+)([kmbtq])?$/);

    if (!match) {
      return NaN;
    }

    const factors = {
      '': 1,
      k: 1e3,
      m: 1e6,
      b: 1e9,
      t: 1e12,
      q: 1e15,
    };

    const suffix = match[2] || '';

    let numberText = match[1];

    if (!suffix) {
      numberText = numberText.replace(/\D/g, '');
    } else if (numberText.includes('.') && numberText.includes(',')) {
      const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';

      const thousands = decimal === ',' ? '.' : ',';

      numberText = numberText.split(thousands).join('').replace(decimal, '.');
    } else {
      numberText = numberText.replace(',', '.');
    }

    const result = Number(numberText) * factors[suffix];

    return Number.isFinite(result) ? result : NaN;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function findMonsterCard() {
    return (
      queryAll(SEL.monsterCard).find((card) => {
        return card.querySelector(SEL.attack);
      }) || null
    );
  }

  function getMonsterKey(card = state.card) {
    const title = card?.querySelector('.card-title')?.textContent?.trim() || 'monster';

    const image = card?.querySelector('#monsterImage, .monster_image')?.getAttribute('src') || '';

    const instance = window.AUTO_DIE_CFG?.nextDieMs ?? '';

    return [location.pathname, title, image, instance].join('|');
  }

  function getCurrentDamage() {
    return parseInteger(state.card?.querySelector(SEL.damage)?.textContent);
  }

  function getCurrentStamina() {
    return parseInteger(document.querySelector(SEL.stamina)?.textContent);
  }

  function getCurrentMana() {
    return parseFraction(document.querySelector(SEL.playerMana)?.textContent)?.current ?? null;
  }

  function getCurrentHealth() {
    return parseFraction(document.querySelector(SEL.playerHp)?.textContent)?.current ?? null;
  }

  function getExperienceProgress() {
    const experience = parseFraction(document.querySelector(SEL.exp)?.textContent);

    if (!experience) {
      return null;
    }

    return {
      ...experience,

      remaining: Math.max(0, experience.maximum - experience.current),
    };
  }

  function getRemainingExperience() {
    return getExperienceProgress()?.remaining ?? null;
  }

  function calculateExperienceGain(before, after) {
    if (!before || !after) {
      return null;
    }

    if (after.maximum === before.maximum && after.current >= before.current) {
      return after.current - before.current;
    }

    if (after.maximum !== before.maximum || after.current < before.current) {
      return Math.max(0, before.maximum - before.current + after.current);
    }

    return null;
  }

  async function waitForExperienceUpdate(before, timeoutMs = 3000) {
    if (!before) {
      return null;
    }

    const startedAt = Date.now();

    while (state.running && Date.now() - startedAt < timeoutMs) {
      const current = getExperienceProgress();

      if (current && (current.current !== before.current || current.maximum !== before.maximum)) {
        return current;
      }

      await sleep(100);
    }

    return getExperienceProgress();
  }

  function isMonsterDead() {
    const health = parseFraction(state.card?.querySelector(SEL.monsterHp)?.textContent)?.current;

    return health === 0 || Boolean(state.card?.classList.contains('dead'));
  }

  function getAttackCosts(button) {
    const text = [
      button.dataset.skillName || '',

      button.textContent || '',

      button.querySelector('.skill-cost')?.textContent || '',
    ].join(' ');

    const staminaMatch = text.match(/(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*(?:stam|stamina)\b/i);

    const manaMatch = text.match(/(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*(?:mp|mana)\b/i);

    let stamina = staminaMatch ? parseInteger(staminaMatch[1]) : null;

    const mana = manaMatch ? parseInteger(manaMatch[1]) : 0;

    /*
     * Standard attack buttons often contain
     * the real stamina cost only in their text.
     *
     * Example:
     * Power Slash (10)
     */
    if (!Number.isFinite(stamina) || stamina <= 1) {
      const ending = button.textContent?.match(/\((\d{1,3}(?:[.,\s]\d{3})+|\d+)\)\s*$/);

      const visibleCost = ending ? parseInteger(ending[1]) : null;

      const dataCost = parseInteger(button.dataset.stamCost);

      stamina = Number.isFinite(visibleCost) ? visibleCost : (dataCost ?? 0);
    }

    return {
      stamina: stamina || 0,

      mana: mana || 0,
    };
  }

  function attackFromButton(button) {
    const name =
      button.dataset.skillName?.trim() ||
      button.querySelector('.skill-name')?.textContent?.trim() ||
      button.textContent?.trim() ||
      'Unnamed Attack';

    const skillId = String(button.dataset.skillId ?? '');

    const costs = getAttackCosts(button);

    return {
      key: `${skillId}|${name}`,

      skillId,
      name,

      group: button.closest('.class-skill-bar') ? 'Class Attacks' : 'Standard Attacks',

      costs,
    };
  }

  function discoverAttacks() {
    const attacks = state.card ? queryAll(SEL.attack, state.card).map(attackFromButton) : [];

    const signature = attacks
      .map((attack) => {
        return `${attack.key}:` + `${attack.costs.stamina}:` + `${attack.costs.mana}`;
      })
      .join('||');

    const changed = signature !== state.attackSignature;

    state.attackSignature = signature;

    state.attacks = attacks;

    const keys = Array.isArray(state.settings.attackKeys) ? state.settings.attackKeys.slice(0, 3) : ['', '', ''];

    for (let index = 0; index < 3; index += 1) {
      if (
        attacks.some((attack) => {
          return attack.key === keys[index];
        })
      ) {
        continue;
      }

      keys[index] =
        attacks.find((attack) => {
          return !keys.includes(attack.key);
        })?.key ||
        attacks[index]?.key ||
        attacks[0]?.key ||
        '';
    }

    state.settings.attackKeys = keys;

    saveSettings();

    return changed;
  }

  function getSelectedAttack(index) {
    return (
      state.attacks.find((attack) => {
        return attack.key === state.settings.attackKeys[index];
      }) || null
    );
  }

  function findLiveAttackButton(key) {
    if (!state.card) {
      return null;
    }

    return (
      queryAll(SEL.attack, state.card).find((button) => {
        return attackFromButton(button).key === key;
      }) || null
    );
  }

  function getFastAttackContext(button) {
    const urlParams = new URLSearchParams(location.search);

    const getHiddenValue = (name) => {
      return document.querySelector(`input[name="${name}"]`)?.value || '';
    };

    const dgmid = urlParams.get('dgmid') || button?.dataset?.dgmid || getHiddenValue('dgmid');

    const instanceId = urlParams.get('instance_id') || button?.dataset?.instanceId || getHiddenValue('instance_id');

    if (!dgmid || !instanceId) {
      return null;
    }

    return {
      dgmid: String(dgmid),

      instanceId: String(instanceId),
    };
  }

  function getRetryAfterMilliseconds(response) {
    const value = response.headers.get('Retry-After');

    if (!value) {
      return null;
    }

    const seconds = Number.parseInt(String(value).trim(), 10);

    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }

    return Math.min(seconds * 1000, 120000);
  }

  function parseFastAttackResponse(response, raw) {
    let data = null;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      /*
       * Some server responses are HTML or plain text.
       */
    }

    const message = String(data?.message ?? raw ?? '');

    const lowerMessage = message.toLowerCase();

    const strongDamage = String(raw).match(/<strong>\s*([\d,.\s]+)\s*<\/strong>/i)?.[1];

    const messageDamage = message.match(/(?:dealt|hit(?:\s+for)?)\s*([\d,.\s]+)\s*(?:damage|dmg)/i)?.[1];

    const messageExperience = message.match(
      /(?:gained|granted|received|earned)\s*([\d,.\s]+)\s*(?:exp|experience)\b/i,
    )?.[1];

    const damage = firstGameNumber(
      data?.damage,
      data?.damage_dealt,
      data?.damageDealt,
      data?.hit_damage,
      data?.hitDamage,
      strongDamage,
      messageDamage,
    );

    const totalDamage = firstGameNumber(
      data?.totaldmgdealt,
      data?.total_damage_dealt,
      data?.totalDamageDealt,
      data?.total_damage,
      data?.totalDamage,
    );

    const experienceGain = firstGameNumber(
      data?.exp_gain,
      data?.expGained,
      data?.experience_gain,
      data?.experienceGained,
      data?.experience_gained,
      messageExperience,
    );

    const userHpAfter = firstGameNumber(
      data?.retaliation?.user_hp_after,

      data?.user_hp_after,
      data?.userHpAfter,
    );

    const staminaAfter = firstGameNumber(data?.stamina_after, data?.staminaAfter, data?.current_stamina);

    const manaAfter = firstGameNumber(data?.mana_after, data?.manaAfter, data?.current_mana);

    const explicitFailure = data?.status === 'error' || data?.success === false;

    const ok = !explicitFailure && (response.ok || data?.status === 'success' || data?.success === true);

    const monsterDead =
      data?.monster_dead === true ||
      data?.monsterDead === true ||
      lowerMessage.includes('is dead') ||
      lowerMessage.includes('defeated') ||
      lowerMessage.includes('monster died') ||
      lowerMessage.includes('already dead') ||
      lowerMessage.includes('you killed') ||
      lowerMessage.includes('has been slain') ||
      lowerMessage.includes('0 hp');

    return {
      ok,
      data,
      message,

      status: response.status,

      retryAfterMs: getRetryAfterMilliseconds(response),

      damage,
      totalDamage,
      experienceGain,

      userHpAfter,
      staminaAfter,
      manaAfter,

      monsterDead,

      feedbackType: classifyFeedback(lowerMessage),
    };
  }

  function setLiveText(selector, text) {
    const element = document.querySelector(selector);

    if (element && text != null) {
      element.textContent = String(text);
    }
  }

  function applyFastAttackResult(result, beforeDamage) {
    let totalDamage = result.totalDamage;

    if (!Number.isFinite(totalDamage) && Number.isFinite(beforeDamage) && Number.isFinite(result.damage)) {
      totalDamage = beforeDamage + result.damage;
    }

    if (Number.isFinite(totalDamage)) {
      const damageElement = state.card?.querySelector(SEL.damage);

      if (damageElement) {
        damageElement.textContent = formatNumber(totalDamage);
      }
    }

    if (Number.isFinite(result.staminaAfter)) {
      setLiveText(SEL.stamina, formatNumber(result.staminaAfter));
    }

    if (Number.isFinite(result.userHpAfter)) {
      const healthElement = document.querySelector(SEL.playerHp);

      const health = parseFraction(healthElement?.textContent);

      if (healthElement && health) {
        healthElement.textContent = `💚 ${formatNumber(result.userHpAfter)} / ${formatNumber(health.maximum)} HP`;
      }
    }

    if (Number.isFinite(result.manaAfter)) {
      const manaElement = document.querySelector(SEL.playerMana);

      const mana = parseFraction(manaElement?.textContent);

      if (manaElement && mana) {
        manaElement.textContent = `💠 ${formatNumber(result.manaAfter)} / ${formatNumber(mana.maximum)} MP`;
      }
    }
  }

  async function fetchDashboardSnapshot() {
    try {
      const response = await fetch('/game_dash.php', {
        credentials: 'same-origin',

        cache: 'no-store',

        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();

      const snapshotDocument = new DOMParser().parseFromString(html, 'text/html');

      /*
       * Copy the updated resource values into
       * the currently visible battle page.
       */
      for (const selector of [SEL.stamina, SEL.playerHp, SEL.playerMana, SEL.exp]) {
        const source = snapshotDocument.querySelector(selector);

        const target = document.querySelector(selector);

        if (source && target) {
          target.textContent = source.textContent;
        }
      }

      const experience = parseFraction(snapshotDocument.querySelector(SEL.exp)?.textContent);

      return {
        experience: experience
          ? {
              current: experience.current,

              maximum: experience.maximum,

              remaining: Math.max(0, experience.maximum - experience.current),
            }
          : null,
      };
    } catch (error) {
      console.warn('[Monster Auto Battle] Could not refresh dashboard values.', error);

      return null;
    }
  }

  function applyKnownExperienceGain(beforeExperience, experienceGain) {
    if (!beforeExperience || !Number.isFinite(experienceGain) || experienceGain <= 0) {
      return null;
    }

    const newCurrent = beforeExperience.current + experienceGain;

    /*
     * A level rollover needs the new maximum and
     * therefore cannot safely be synthesized.
     */
    if (newCurrent >= beforeExperience.maximum) {
      return null;
    }

    const experienceElement = document.querySelector(SEL.exp);

    if (experienceElement) {
      experienceElement.textContent = `${formatNumber(newCurrent)} / ${formatNumber(beforeExperience.maximum)}`;
    }

    return {
      current: newCurrent,

      maximum: beforeExperience.maximum,

      remaining: beforeExperience.maximum - newCurrent,
    };
  }

  async function refreshAfterFastAttack(beforeExperience, experienceGain) {
    let snapshot = await fetchDashboardSnapshot();

    let afterExperience = snapshot?.experience || null;

    /*
     * The server may update the dashboard a fraction
     * later. Retry once when level-up protection is active.
     */
    if (
      state.settings.stopBeforeLevelUp &&
      beforeExperience &&
      afterExperience &&
      afterExperience.current === beforeExperience.current &&
      afterExperience.maximum === beforeExperience.maximum
    ) {
      await sleep(150);

      snapshot = await fetchDashboardSnapshot();

      afterExperience = snapshot?.experience || afterExperience;
    }

    if (
      !afterExperience ||
      (beforeExperience &&
        afterExperience.current === beforeExperience.current &&
        afterExperience.maximum === beforeExperience.maximum)
    ) {
      afterExperience = applyKnownExperienceGain(beforeExperience, experienceGain) || afterExperience;
    }

    return afterExperience;
  }

  async function performFastAttack(attack, button, beforeDamage, beforeExperience) {
    const context = getFastAttackContext(button);

    /*
     * Normal non-dungeon battle pages may not expose
     * dgmid and instance_id. The caller will use the
     * original button-click method in that case.
     */
    if (!context || attack.skillId === '') {
      return {
        unsupported: true,
      };
    }

    const body = new URLSearchParams();

    body.set('instance_id', context.instanceId);

    body.set('dgmid', context.dgmid);

    body.set('skill_id', attack.skillId);

    body.set('stamina_cost', String(attack.costs.stamina));

    for (let attempt = 0; attempt < MAX_RATE_RETRIES; attempt += 1) {
      if (!state.running) {
        return {
          type: 'timeout',
          mode: 'api',
        };
      }

      let response;

      try {
        response = await fetch('/damage.php', {
          method: 'POST',

          credentials: 'same-origin',

          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',

            'X-Requested-With': 'XMLHttpRequest',
          },

          body: body.toString(),
        });
      } catch (error) {
        console.error('[Monster Auto Battle] Fast attack request failed.', error);

        /*
         * Do not click the button after a network error.
         * The server may have received the request even
         * though the response was interrupted.
         */
        return {
          type: 'timeout',
          mode: 'api',
          message: String(error),
        };
      }

      const raw = await response.text();

      const result = parseFastAttackResponse(response, raw);

      const rateLimited =
        response.status === 429 ||
        result.feedbackType === 'cooldown' ||
        /rate limit|too fast|cooling down/.test(result.message.toLowerCase());

      if (rateLimited) {
        const wait = result.retryAfterMs || Math.min(20000, 800 * Math.pow(2, attempt));

        setStatus(`Rate limited. Retrying in ${Math.ceil(wait / 1000)} seconds...`, 'running');

        await sleep(wait);

        continue;
      }

      applyFastAttackResult(result, beforeDamage);

      const afterExperience = await refreshAfterFastAttack(beforeExperience, result.experienceGain);

      let damage = result.damage;

      if (!Number.isFinite(damage) && Number.isFinite(result.totalDamage) && Number.isFinite(beforeDamage)) {
        damage = Math.max(0, result.totalDamage - beforeDamage);
      }

      if (result.ok && Number.isFinite(damage) && damage > 0) {
        return {
          type: 'damage',
          mode: 'api',

          damage,
          totalDamage: result.totalDamage,

          experienceGain: result.experienceGain,

          afterExperience,

          monsterDead: result.monsterDead,

          message: result.message,
        };
      }

      if (result.monsterDead) {
        return {
          type: 'monster-dead',

          mode: 'api',

          afterExperience,

          message: result.message,
        };
      }

      if (result.feedbackType) {
        return {
          type: result.feedbackType,

          mode: 'api',

          message: result.message,

          retryAfterMs: result.retryAfterMs,
        };
      }

      return {
        type: 'timeout',

        mode: 'api',

        message: result.message,
      };
    }

    return {
      type: 'cooldown',

      mode: 'api',

      retryAfterMs: 20000,
    };
  }

  async function performAttack(attack, button, beforeDamage, beforeExperience, beforeFeedback) {
    const fastResult = await performFastAttack(attack, button, beforeDamage, beforeExperience);

    if (!fastResult.unsupported) {
      return fastResult;
    }

    /*
     * Fallback for battle modes that do not support
     * the direct /damage.php request parameters.
     */
    button.click();

    return waitForAttackOutcome(beforeDamage, beforeFeedback);
  }

  function getPotionType(name, description) {
    const text = `${name} ${description}`.toLowerCase();

    if (text.includes('stamina')) {
      return 'stamina';
    }

    if (text.includes('mana')) {
      return 'mana';
    }

    if (/\bhp\b|health|heal/.test(text)) {
      return 'health';
    }

    return 'other';
  }

  function potionFromButton(button) {
    const card = button.closest(SEL.potionCard);

    const name =
      button.dataset.name?.trim() ||
      card?.querySelector('.potion-name span')?.textContent?.trim() ||
      button.textContent?.trim() ||
      'Unknown Potion';

    const description = card?.querySelector('.potion-desc')?.textContent?.trim() || '';

    const itemId = String(button.dataset.item || card?.dataset.itemId || name);

    const quantity =
      [
        card?.querySelector('.potion-qty-left')?.textContent,

        button.querySelector('.ds-potion-count')?.textContent,

        button.dataset.max,
      ]
        .map(parseInteger)
        .find(Number.isFinite) ?? 0;

    return {
      key: itemId,
      itemId,
      name,
      description,

      type: getPotionType(name, description),

      quantity,
    };
  }

  function supportsMultiplePotionUse(potion) {
    return potion?.itemId === '30' || potion?.itemId === '162';
  }

  function getConfiguredPotionAmount(potion) {
    const value = Number(state.settings.potionUseAmount?.[potion.key] ?? 1);

    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  }

  function getActualPotionAmount(potion) {
    const configured = getConfiguredPotionAmount(potion);

    if (Number.isFinite(potion.quantity) && potion.quantity > 0) {
      return Math.min(configured, potion.quantity);
    }

    return configured;
  }

  function discoverPotions() {
    const unique = new Map();

    const buttons = queryAll(SEL.potion);

    for (const button of buttons) {
      const potion = potionFromButton(button);

      if (potion.type === 'other') {
        continue;
      }

      const existing = unique.get(potion.key);

      if (!existing || potion.quantity > existing.quantity) {
        unique.set(potion.key, potion);
      }
    }

    state.potions = [...unique.values()];

    for (const type of ['stamina', 'mana', 'health']) {
      const available = state.potions
        .filter((potion) => {
          return potion.type === type;
        })
        .map((potion) => {
          return potion.key;
        });

      const oldOrder = state.settings.potionOrder[type] || [];

      state.settings.potionOrder[type] = [
        ...oldOrder.filter((key) => {
          return available.includes(key);
        }),

        ...available.filter((key) => {
          return !oldOrder.includes(key);
        }),
      ];

      for (const key of available) {
        if (!(key in state.settings.potionEnabled)) {
          state.settings.potionEnabled[key] = true;
        }

        if (!(key in state.settings.potionUseAmount)) {
          state.settings.potionUseAmount[key] = 1;
        }
      }
    }

    saveSettings();
  }

  function getPotionAmountInput(button) {
    return button.closest('.potion-actions')?.querySelector('input[type="number"]') || null;
  }

  function findLivePotionButton(potion, amount = 1) {
    const matches = queryAll(SEL.potion).filter((button) => {
      return potionFromButton(button).itemId === potion.itemId && !button.disabled;
    });

    if (amount > 1) {
      return (
        matches.find((button) => {
          const input = getPotionAmountInput(button);

          return input && !input.readOnly && !input.disabled;
        }) || null
      );
    }

    return (
      matches.find((button) => {
        return button.offsetParent !== null;
      }) ||
      matches[0] ||
      null
    );
  }

  function isElementVisible(element) {
    if (!element?.isConnected) {
      return false;
    }

    const style = getComputedStyle(element);

    const rectangle = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  }

  function findPotionConfirmationButton() {
    const directSelectors = [
      '.swal2-container .swal2-confirm',
      '.swal-modal .swal-button--confirm',
      '.modal.show .btn-confirm',
      '.modal.show [data-confirm="true"]',
      '.modal.show button.btn-primary',
      '[role="dialog"][aria-modal="true"] .confirm',
      '[role="dialog"][aria-modal="true"] [data-confirm]',
      '[role="dialog"][aria-modal="true"] button[type="submit"]',
      '.dialog.open .confirm',
      '.popup.open .confirm',
    ];

    for (const selector of directSelectors) {
      const button = queryAll(selector).find((element) => {
        return isElementVisible(element) && !element.disabled;
      });

      if (button) {
        return button;
      }
    }

    const dialogSelectors = [
      '.swal2-container',
      '.swal-overlay',
      '.modal.show',
      '[role="dialog"][aria-modal="true"]',
      '.dialog.open',
      '.popup.open',
      '.modal.active',
    ];

    const acceptedText = /^(confirm|yes|ok|okay|use|continue|accept|confirm use|use potion|confirm potion)$/i;

    for (const selector of dialogSelectors) {
      for (const dialog of queryAll(selector)) {
        if (!isElementVisible(dialog)) {
          continue;
        }

        const button = queryAll('button, input[type="button"], input[type="submit"]', dialog).find((element) => {
          const text = String(element.textContent || element.value || element.getAttribute('aria-label') || '').trim();

          return !element.disabled && isElementVisible(element) && acceptedText.test(text);
        });

        if (button) {
          return button;
        }
      }
    }

    return null;
  }

  async function watchPotionConfirmation(timeoutMs = 6000) {
    const startedAt = Date.now();

    while (state.running && Date.now() - startedAt < timeoutMs) {
      const button = findPotionConfirmationButton();

      if (button) {
        log('Potion confirmation accepted automatically.');

        button.click();

        return true;
      }

      await sleep(75);
    }

    return false;
  }

  function clickPotionWithConfirmation(button) {
    const originalConfirm = window.confirm;

    let replaced = false;

    try {
      window.confirm = (message) => {
        log(`Potion confirmation accepted: ${String(message || 'Confirm')}`);

        return true;
      };

      replaced = true;
    } catch (error) {
      console.warn('[Monster Auto Battle] Could not override confirm().', error);
    }

    void watchPotionConfirmation();

    try {
      button.click();
    } finally {
      setTimeout(() => {
        if (!replaced) {
          return;
        }

        try {
          window.confirm = originalConfirm;
        } catch (error) {
          console.warn('[Monster Auto Battle] Could not restore confirm().', error);
        }
      }, 1200);
    }
  }

  function saveResumeState() {
    if (!state.running) {
      return;
    }

    try {
      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({
          savedAt: Date.now(),

          monsterKey: state.monsterKey || getMonsterKey(),

          sessionDamage: state.sessionDamage,

          lastDamage: state.lastDamage,

          lastExperienceGain: state.lastExperienceGain,
        }),
      );
    } catch (error) {
      console.warn('[Monster Auto Battle] Could not save resume state.', error);
    }
  }

  function loadResumeState() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);

      if (!raw) {
        return null;
      }

      const data = JSON.parse(raw);

      if (!data?.savedAt || Date.now() - data.savedAt > 60000) {
        clearResumeState();

        return null;
      }

      return data;
    } catch (error) {
      clearResumeState();

      return null;
    }
  }

  function clearResumeState() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      /*
       * Ignore storage errors.
       */
    }
  }

  async function usePotion(type) {
    discoverPotions();

    const potion = (state.settings.potionOrder[type] || [])
      .map((key) => {
        return state.potions.find((item) => {
          return item.key === key;
        });
      })
      .find((item) => {
        return item && item.quantity > 0 && state.settings.potionEnabled[item.key] !== false;
      });

    if (!potion) {
      setStatus(`No enabled ${type} potion is available.`, 'error');

      log(`No ${type} potion is available.`);

      return false;
    }

    const amount = supportsMultiplePotionUse(potion) ? getActualPotionAmount(potion) : 1;

    const button = findLivePotionButton(potion, amount);

    if (!button) {
      setStatus(
        amount > 1 ? `${potion.name} has no editable amount field.` : `${potion.name} could not be found.`,
        'error',
      );

      return false;
    }

    const beforeQuantity = potion.quantity;

    const beforeResource =
      type === 'stamina' ? getCurrentStamina() : type === 'mana' ? getCurrentMana() : getCurrentHealth();

    const input = getPotionAmountInput(button);

    if (amount > 1 && (!input || input.readOnly || input.disabled)) {
      setStatus(`Could not set the amount for ${potion.name}.`, 'error');

      return false;
    }

    if (input && !input.readOnly && !input.disabled) {
      input.value = String(amount);

      input.dispatchEvent(
        new Event('input', {
          bubbles: true,
        }),
      );

      input.dispatchEvent(
        new Event('change', {
          bubbles: true,
        }),
      );

      await sleep(80);
    }

    log(
      amount > 1
        ? `Using ${formatNumber(amount)} × ${potion.name}. Stock before use: ${formatNumber(beforeQuantity)}.`
        : `Using ${potion.name}. Stock before use: ${formatNumber(beforeQuantity)}.`,
    );

    saveResumeState();

    clickPotionWithConfirmation(button);

    const startedAt = Date.now();

    while (state.running && Date.now() - startedAt < 8000) {
      await sleep(120);

      discoverPotions();

      const refreshed = state.potions.find((item) => {
        return item.key === potion.key;
      });

      const afterResource =
        type === 'stamina' ? getCurrentStamina() : type === 'mana' ? getCurrentMana() : getCurrentHealth();

      const quantityChanged = refreshed && refreshed.quantity < beforeQuantity;

      const resourceChanged =
        Number.isFinite(beforeResource) && Number.isFinite(afterResource) && afterResource > beforeResource;

      if (quantityChanged || resourceChanged) {
        log(`${potion.name} was used successfully. Auto-battle will continue.`);

        renderPotionLists();
        updateMetrics();

        return true;
      }
    }

    clearResumeState();

    renderPotionLists();

    log(`${potion.name} was clicked, but no resource or quantity change was detected.`);

    return false;
  }

  function getFeedbackText() {
    const selectors = [
      '.toast',
      '.toast-message',
      '.notification',
      '.alert',
      '.message',
      '.swal2-popup',
      '.swal2-html-container',
      '[role="alert"]',
    ];

    return selectors
      .flatMap((selector) => {
        return queryAll(selector);
      })
      .filter((element) => {
        return !element.closest(`#${ID}`);
      })
      .slice(-12)
      .map((element) => {
        return element.textContent?.trim();
      })
      .filter(Boolean)
      .join(' | ')
      .toLowerCase();
  }

  function classifyFeedback(text) {
    if (!text) {
      return null;
    }

    if (/you are dead|you died|you have died|knocked out|cannot attack.*dead|dead.*cannot attack/.test(text)) {
      return 'dead';
    }

    if (
      /not enough\s+stamina|insufficient\s+stamina|out of\s+stamina|stamina\s+(?:is\s+)?(?:empty|too low|depleted)/.test(
        text,
      )
    ) {
      return 'stamina';
    }

    if (/not enough\s+mana|insufficient\s+mana|out of\s+mana|mana\s+(?:is\s+)?(?:empty|too low|depleted)/.test(text)) {
      return 'mana';
    }

    if (/cooldown|too fast|please wait|wait before|rate limit/.test(text)) {
      return 'cooldown';
    }

    return null;
  }

  async function waitForAttackOutcome(beforeDamage, beforeFeedback) {
    const startedAt = Date.now();

    while (state.running && Date.now() - startedAt < 6500) {
      await sleep(110);

      const damage = getCurrentDamage();

      if (Number.isFinite(beforeDamage) && Number.isFinite(damage) && damage > beforeDamage) {
        return {
          type: 'damage',

          damage: damage - beforeDamage,
        };
      }

      if (isMonsterDead()) {
        return {
          type: 'monster-dead',
        };
      }

      const feedback = getFeedbackText();

      if (feedback && feedback !== beforeFeedback) {
        const type = classifyFeedback(feedback);

        if (type) {
          return { type };
        }
      }
    }

    const finalFeedback = getFeedbackText();

    return {
      type: finalFeedback !== beforeFeedback ? classifyFeedback(finalFeedback) || 'timeout' : 'timeout',
    };
  }

  async function ensurePlayerIsAlive() {
    if (getCurrentHealth() !== 0) {
      return true;
    }

    if (!state.settings.autoHealth) {
      stop('Your health is 0 and automatic health potions are disabled.');

      return false;
    }

    const used = await usePotion('health');

    if (!used) {
      stop('You are defeated and no enabled health potion is available.', 'error');

      return false;
    }

    await sleep(650);

    return true;
  }

  async function prepareNextAttack() {
    if (discoverAttacks()) {
      renderAttackOptions();
    }

    const attacks = [getSelectedAttack(0), getSelectedAttack(1), getSelectedAttack(2)];

    const primary = attacks[0];

    if (!primary) {
      stop('Attack 1 is not available on the current monster card.', 'error');

      return null;
    }

    const stamina = getCurrentStamina();

    const mana = getCurrentMana();

    /*
     * Continue a stamina fallback chain that
     * was started after a server error.
     */
    if (state.forcedAttackIndex > 0) {
      let manaBlocked = false;

      for (let index = state.forcedAttackIndex; index < 3; index += 1) {
        const attack = attacks[index];

        if (!attack) {
          continue;
        }

        if (Number.isFinite(stamina) && stamina < attack.costs.stamina) {
          continue;
        }

        if (Number.isFinite(mana) && mana < attack.costs.mana) {
          manaBlocked = true;

          if (!state.settings.autoMana) {
            continue;
          }

          const used = await usePotion('mana');

          if (!used) {
            stop(`Attack ${index + 1} requires mana, but no mana potion is available.`, 'error');

            return null;
          }

          state.forcedAttackIndex = index;

          return {
            retry: true,
          };
        }

        return {
          attack,
          index,
        };
      }

      if (manaBlocked) {
        stop('A fallback attack requires more mana. Enable mana potions or select another attack.');

        return null;
      }

      if (!state.settings.autoStamina) {
        stop('Attack 2 and Attack 3 also require more stamina. Automatic stamina potions are disabled.');

        return null;
      }

      const used = await usePotion('stamina');

      if (!used) {
        stop('No enabled stamina potion is available.', 'error');

        return null;
      }

      state.forcedAttackIndex = 0;

      return {
        retry: true,
      };
    }

    /*
     * Attack 1 has absolute priority.
     * Restore mana before switching away from it.
     */
    if (Number.isFinite(mana) && mana < primary.costs.mana) {
      if (!state.settings.autoMana) {
        stop(
          `Attack 1 requires ${formatNumber(primary.costs.mana)} mana, but only ${formatNumber(mana)} is available.`,
        );

        return null;
      }

      const used = await usePotion('mana');

      if (!used) {
        stop('Attack 1 requires mana, but no enabled mana potion is available.', 'error');

        return null;
      }

      return {
        retry: true,
      };
    }

    if (!Number.isFinite(stamina) || stamina >= primary.costs.stamina) {
      return {
        attack: primary,

        index: 0,
      };
    }

    let manaBlocked = false;

    /*
     * If Attack 1 lacks stamina and current
     * stamina is not zero, test Attack 2 and 3.
     */
    if (stamina > 0) {
      for (let index = 1; index < 3; index += 1) {
        const attack = attacks[index];

        if (!attack || stamina < attack.costs.stamina) {
          continue;
        }

        if (Number.isFinite(mana) && mana < attack.costs.mana) {
          manaBlocked = true;

          if (!state.settings.autoMana) {
            continue;
          }

          const used = await usePotion('mana');

          if (!used) {
            stop(`Attack ${index + 1} requires mana, but no mana potion is available.`, 'error');

            return null;
          }

          state.forcedAttackIndex = index;

          return {
            retry: true,
          };
        }

        log(`Attack 1 is too expensive. Using Attack ${index + 1}: ${attack.name}.`);

        return {
          attack,
          index,
        };
      }
    }

    if (manaBlocked) {
      stop('A fallback attack has enough stamina but requires more mana.');

      return null;
    }

    /*
     * Only use a stamina potion after all
     * three selected attacks were rejected.
     */
    if (!state.settings.autoStamina) {
      stop(`Current stamina (${formatNumber(stamina)}) is not enough for any selected attack.`);

      return null;
    }

    const used = await usePotion('stamina');

    if (!used) {
      stop('Stamina is too low and no enabled stamina potion is available.', 'error');

      return null;
    }

    state.forcedAttackIndex = 0;

    return {
      retry: true,
    };
  }

  async function handleFailedAttack(outcome, attackIndex) {
    if (outcome.type === 'monster-dead') {
      stop('Monster defeated.', 'success');

      return;
    }

    if (outcome.type === 'dead') {
      if (!state.settings.autoHealth) {
        stop('You are defeated and automatic health potions are disabled.');

        return;
      }

      const used = await usePotion('health');

      if (!used) {
        stop('No enabled health potion is available.', 'error');
      }

      return;
    }

    if (outcome.type === 'mana') {
      if (!state.settings.autoMana) {
        stop('Not enough mana and automatic mana potions are disabled.');

        return;
      }

      const used = await usePotion('mana');

      if (used) {
        state.forcedAttackIndex = attackIndex;

        await sleep(650);
      } else {
        stop('No enabled mana potion is available.', 'error');
      }

      return;
    }

    if (outcome.type === 'stamina') {
      const nextAttack = attackIndex < 2 ? getSelectedAttack(attackIndex + 1) : null;

      if (getCurrentStamina() !== 0 && nextAttack) {
        state.forcedAttackIndex = attackIndex + 1;

        log(`Attack ${attackIndex + 1} failed because of stamina. Trying Attack ${attackIndex + 2}.`);

        return;
      }

      if (!state.settings.autoStamina) {
        stop('Not enough stamina and automatic stamina potions are disabled.');

        return;
      }

      const used = await usePotion('stamina');

      if (used) {
        state.forcedAttackIndex = 0;

        await sleep(650);
      } else {
        stop('No enabled stamina potion is available.', 'error');
      }

      return;
    }

    if (outcome.type === 'cooldown') {
      const wait = Math.max(
        outcome.retryAfterMs || 1600,

        state.settings.delayMs,
      );

      log(`The server reported a cooldown. Waiting ${Math.ceil(wait / 1000)} seconds.`);

      await sleep(wait);

      return;
    }

    state.noDamageCount += 1;

    if (state.noDamageCount >= 2) {
      stop('No damage was detected twice. Safety stop activated.', 'error');
    } else {
      log('No damage was detected. One retry will be attempted.');

      await sleep(Math.max(1200, state.settings.delayMs));
    }
  }

  function readForm() {
    if (!state.panel) {
      return;
    }

    state.settings.attackKeys = [1, 2, 3].map((number, index) => {
      return state.panel.querySelector(`#mabAttack${number}`)?.value || state.settings.attackKeys[index] || '';
    });

    state.settings.targetDamage = state.panel.querySelector('#mabTarget')?.value.trim() || '0';

    state.settings.delayMs = Math.max(
      0,

      Number(state.panel.querySelector('#mabDelay')?.value) || 0,
    );

    state.settings.autoStamina = state.panel.querySelector('#mabAutoStamina').checked;

    state.settings.autoMana = state.panel.querySelector('#mabAutoMana').checked;

    state.settings.autoHealth = state.panel.querySelector('#mabAutoHealth').checked;

    state.settings.stopBeforeLevelUp = state.panel.querySelector('#mabLevelGuard').checked;

    state.settings.levelMultiplier = Number(state.panel.querySelector('#mabMultiplier').value) || 2;

    saveSettings();
  }

  function validateSettings() {
    const target = parseTarget(state.settings.targetDamage);

    if (!Number.isFinite(target) || target < 0) {
      setStatus('Invalid target damage. Examples: 5m, 5b, or 5,000,000.', 'error');

      return false;
    }

    if (!(state.settings.levelMultiplier > 0)) {
      setStatus('The level-up multiplier must be greater than 0.', 'error');

      return false;
    }

    for (let index = 0; index < 3; index += 1) {
      const attack = getSelectedAttack(index);

      if (!attack || !findLiveAttackButton(attack.key)) {
        setStatus(`Please select a valid Attack ${index + 1}.`, 'error');

        return false;
      }
    }

    return true;
  }

  async function runAutoBattle(resumeData = null) {
    if (resumeData instanceof Event) {
      resumeData = null;
    }

    if (state.running) {
      return;
    }

    readForm();
    discoverAttacks();
    discoverPotions();

    renderAttackOptions();
    renderPotionLists();

    if (!validateSettings()) {
      return;
    }

    const currentMonsterKey = getMonsterKey();

    if (resumeData?.monsterKey && resumeData.monsterKey !== currentMonsterKey) {
      clearResumeState();

      setStatus('Auto-battle could not resume because the monster changed.', 'error');

      return;
    }

    state.monsterKey = currentMonsterKey;

    if (resumeData) {
      state.sessionDamage = Number(resumeData.sessionDamage) || 0;

      state.lastDamage = Number(resumeData.lastDamage) || 0;

      state.lastExperienceGain = resumeData.lastExperienceGain == null ? null : Number(resumeData.lastExperienceGain);
    } else {
      clearResumeState();

      state.sessionDamage = 0;

      state.lastDamage = 0;

      state.lastExperienceGain = null;
    }

    state.noDamageCount = 0;
    state.forcedAttackIndex = 0;
    state.running = true;

    updateButtons();
    updateMetrics();

    setStatus(resumeData ? 'Auto-battle resumed after potion use.' : 'Auto-battle is running.', 'running');

    log(`Started with ${formatNumber(getCurrentDamage() || 0)} damage already dealt.`);

    try {
      while (state.running) {
        if (!state.card?.isConnected || getMonsterKey() !== state.monsterKey) {
          stop('The monster card changed. Auto-battle was stopped.');

          break;
        }

        if (isMonsterDead()) {
          stop('Monster defeated.', 'success');

          break;
        }

        const target = parseTarget(state.settings.targetDamage);

        /*
         * Target damage refers to the total damage
         * already dealt to the current monster.
         */
        const totalMonsterDamage = getCurrentDamage();

        if (target > 0 && Number.isFinite(totalMonsterDamage) && totalMonsterDamage >= target) {
          stop(`Total monster damage target of ${formatNumber(target)} was reached.`, 'success');

          break;
        }

        /*
         * Level-up protection:
         *
         * remaining EXP <
         * last EXP gain × multiplier
         */
        if (
          state.settings.stopBeforeLevelUp &&
          Number.isFinite(state.lastExperienceGain) &&
          state.lastExperienceGain > 0
        ) {
          const remaining = getRemainingExperience();

          if (!Number.isFinite(remaining)) {
            stop('Remaining EXP could not be read. Level-up protection stopped the script.', 'error');

            break;
          }

          const threshold = state.lastExperienceGain * state.settings.levelMultiplier;

          if (remaining < threshold) {
            stop(
              `Level-up protection: ${formatNumber(remaining)} EXP remains. ` +
                `The last attack granted ${formatNumber(state.lastExperienceGain)} EXP, ` +
                `so the stop threshold is ${formatNumber(threshold)} EXP.`,
              'success',
            );

            break;
          }
        }

        const alive = await ensurePlayerIsAlive();

        if (!alive) {
          break;
        }

        const prepared = await prepareNextAttack();

        if (!state.running || !prepared) {
          break;
        }

        if (prepared.retry) {
          await sleep(500);

          continue;
        }

        const button = findLiveAttackButton(prepared.attack.key);

        if (!button) {
          stop(`Attack ${prepared.index + 1} is no longer available.`, 'error');

          break;
        }

        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          state.noDamageCount += 1;

          if (state.noDamageCount >= 3) {
            stop('The selected attack button remained disabled.', 'error');

            break;
          }

          await sleep(Math.max(1200, state.settings.delayMs));

          continue;
        }

        const beforeDamage = getCurrentDamage();

        const beforeExperience = getExperienceProgress();

        const beforeFeedback = getFeedbackText();

        log(`Attack ${prepared.index + 1}: ${prepared.attack.name}.`);

        const outcome = await performAttack(prepared.attack, button, beforeDamage, beforeExperience, beforeFeedback);

        if (!state.running) {
          break;
        }

        if (outcome.type === 'damage') {
          clearResumeState();

          state.noDamageCount = 0;

          state.forcedAttackIndex = 0;

          state.lastDamage = Math.max(0, outcome.damage || 0);

          state.sessionDamage += state.lastDamage;

          const afterExperience =
            outcome.mode === 'api' ? outcome.afterExperience : await waitForExperienceUpdate(beforeExperience);

          const calculatedExperienceGain = calculateExperienceGain(beforeExperience, afterExperience);

          state.lastExperienceGain =
            Number.isFinite(outcome.experienceGain) && outcome.experienceGain > 0
              ? outcome.experienceGain
              : Number.isFinite(calculatedExperienceGain) && calculatedExperienceGain > 0
                ? calculatedExperienceGain
                : null;

          if (Number.isFinite(state.lastExperienceGain)) {
            log(
              `Hit dealt ${formatNumber(state.lastDamage)} damage and granted ` +
                `${formatNumber(state.lastExperienceGain)} EXP.`,
            );
          } else if (state.settings.stopBeforeLevelUp) {
            stop(
              'The EXP gain from the last attack could not be determined. ' + 'Level-up protection stopped the script.',
              'error',
            );

            break;
          }

          updateMetrics();
          if (outcome.monsterDead) {
            stop('Monster defeated.', 'success');

            break;
          }
        } else {
          await handleFailedAttack(outcome, prepared.index);
        }

        if (state.running) {
          await sleep(Math.max(0, state.settings.delayMs));
        }
      }
    } catch (error) {
      console.error('[Monster Auto Battle]', error);

      stop(`Error: ${error?.message || error}`, 'error');
    } finally {
      state.running = false;

      updateButtons();
      updateMetrics();
    }
  }

  function stop(message = 'Stopped manually.', tone = 'idle') {
    state.running = false;

    clearResumeState();

    setStatus(message, tone);

    log(message);

    updateButtons();
  }

  function injectStyles() {
    if (document.getElementById(`${ID}-style`)) {
      return;
    }

    const style = document.createElement('style');

    style.id = `${ID}-style`;

    style.textContent = `
      #${ID} {
        margin-top: 14px;
        color: #dfe6ff;
        font-family: inherit;
      }

      #${ID} * {
        box-sizing: border-box;
      }

      #${ID} details.mab-main {
        overflow: hidden;
        border: 1px solid #384063;
        border-radius: 14px;
        background: #111322;
        box-shadow: 0 10px 28px rgba(0,0,0,.4);
      }

      #${ID} .mab-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px;
        cursor: pointer;
        list-style: none;
        background: #1d2138;
        font-weight: 800;
        user-select: none;
      }

      #${ID} .mab-header::-webkit-details-marker {
        display: none;
      }

      #${ID} .mab-note {
        color: #9aa7d7;
        font-size: 10px;
        text-transform: uppercase;
      }

      #${ID} .mab-body {
        padding: 13px;
      }

      #${ID} .mab-grid,
      #${ID} .mab-priority-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      #${ID} .mab-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        color: #cfd6f7;
        font-size: 12px;
        font-weight: 700;
      }

      #${ID} small {
        color: #8f99c2;
      }

      #${ID} select,
      #${ID} input[type="text"],
      #${ID} input[type="number"] {
        width: 100%;
        min-height: 36px;
        padding: 7px 9px;
        border: 1px solid #3a4163;
        border-radius: 9px;
        outline: none;
        background: #0e1020;
        color: #eef1ff;
      }

      #${ID} select:focus,
      #${ID} input:focus {
        border-color: #7488ff;
        box-shadow: 0 0 0 2px rgba(116,136,255,.16);
      }

      #${ID} .mab-options,
      #${ID} .mab-level-guard {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 15px;
        margin: 12px 0;
        padding: 10px;
        border: 1px solid #2e3452;
        border-radius: 10px;
        background: #14172a;
        font-size: 12px;
      }

      #${ID} .mab-level-guard {
        border-color: #594c2f;
        background: #211d16;
      }

      #${ID} .mab-level-guard input[type="number"] {
        width: 80px;
        min-height: 30px;
      }

      #${ID} input[type="checkbox"] {
        accent-color: #7185ff;
      }

      #${ID} fieldset,
      #${ID} .mab-health-box {
        min-width: 0;
        margin: 0;
        padding: 9px;
        border: 1px solid #2f3554;
        border-radius: 10px;
        background: #121526;
      }

      #${ID} .mab-health-box {
        margin-top: 10px;
      }

      #${ID} legend,
      #${ID} .mab-health-box > strong {
        color: #bfc8f5;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
      }

      #${ID} .mab-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 7px;
      }

      #${ID} .mab-potion-row {
        display: grid;
        grid-template-columns:
          auto
          minmax(0,1fr)
          auto
          auto;
        align-items: center;
        gap: 6px;
        padding: 5px 6px;
        border: 1px solid #2a304c;
        border-radius: 8px;
        background: #191c30;
      }

      #${ID} .mab-potion-main {
        min-width: 0;
      }

      #${ID} .mab-potion-name {
        overflow: hidden;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${ID} .mab-potion-amount {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
        color: #98a4d2;
        font-size: 10px;
        font-weight: 600;
      }

      #${ID} .mab-potion-amount input[type="number"] {
        width: 68px;
        min-height: 26px;
        padding: 3px 6px;
        font-size: 11px;
      }

      #${ID} .mab-quantity {
        color: #98a4d2;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }

      #${ID} .mab-moves {
        display: flex;
        gap: 4px;
      }

      #${ID} .mab-move {
        width: 25px;
        height: 25px;
        padding: 0;
        border: 1px solid #3a4267;
        border-radius: 6px;
        background: #242943;
        color: #e3e8ff;
        cursor: pointer;
      }

      #${ID} .mab-move:disabled {
        opacity: .35;
        cursor: default;
      }

      #${ID} .mab-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      #${ID} .mab-button {
        padding: 8px 12px;
        border: 1px solid transparent;
        border-radius: 9px;
        color: #fff;
        font-weight: 800;
        cursor: pointer;
      }

      #${ID} .mab-button:disabled {
        opacity: .45;
        cursor: default;
      }

      #${ID} .mab-start {
        border-color: #35845e;
        background: #245d42;
      }

      #${ID} .mab-stop {
        border-color: #9a3b45;
        background: #6e2930;
      }

      #${ID} .mab-secondary {
        border-color: #3b4267;
        background: #252a43;
      }

      #${ID} .mab-status {
        margin-top: 10px;
        padding: 9px 10px;
        border: 1px solid #343a59;
        border-radius: 9px;
        background: #171a2b;
        font-size: 12px;
        font-weight: 700;
      }

      #${ID} .mab-status-running {
        border-color: #3d765d;
        background: #17271f;
        color: #b8f0cf;
      }

      #${ID} .mab-status-success {
        border-color: #476d85;
        background: #16242d;
        color: #c8ebff;
      }

      #${ID} .mab-status-error {
        border-color: #7e3b45;
        background: #2a171b;
        color: #ffc5cb;
      }

      #${ID} .mab-metrics {
        display: grid;
        grid-template-columns:
          repeat(4,minmax(0,1fr));
        gap: 7px;
        margin-top: 10px;
      }

      #${ID} .mab-metrics > div {
        padding: 8px;
        border: 1px solid #2d3350;
        border-radius: 9px;
        background: #111423;
      }

      #${ID} .mab-metrics span {
        display: block;
        color: #8792bd;
        font-size: 9px;
        text-transform: uppercase;
      }

      #${ID} .mab-metrics strong {
        display: block;
        margin-top: 3px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      #${ID} .mab-log {
        max-height: 145px;
        overflow: auto;
        margin-top: 6px;
        padding: 7px;
        border: 1px solid #292f4b;
        border-radius: 8px;
        background: #0d0f1b;
        color: #aeb8df;
        font:
          11px
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
      }

      #${ID} .mab-log > div + div {
        margin-top: 4px;
      }

      #${ID} .mab-empty,
      #${ID} .mab-hint {
        color: #7883aa;
        font-size: 10px;
        line-height: 1.45;
      }

      #${ID} .mab-hint {
        margin-top: 9px;
      }

      @media (max-width: 760px) {
        #${ID} .mab-grid,
        #${ID} .mab-priority-grid,
        #${ID} .mab-metrics {
          grid-template-columns: 1fr;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function createPanel() {
    const panel = document.createElement('section');

    panel.id = ID;

    panel.innerHTML = `
      <details
        class="mab-main"
        ${state.settings.collapsed ? '' : 'open'}
      >
        <summary class="mab-header">
          <span>🤖 Auto Battle</span>
          <span class="mab-note">
            Current monster only
          </span>
        </summary>

        <div class="mab-body">
          <div class="mab-grid">
            <label class="mab-field">
              <span>
                Attack 1
                <small>Primary attack</small>
              </span>

              <select id="mabAttack1"></select>
            </label>

            <label class="mab-field">
              <span>
                Attack 2
                <small>
                  First stamina fallback
                </small>
              </span>

              <select id="mabAttack2"></select>
            </label>

            <label class="mab-field">
              <span>
                Attack 3
                <small>
                  Second stamina fallback
                </small>
              </span>

              <select id="mabAttack3"></select>
            </label>

            <label class="mab-field">
              <span>
                Total monster damage target
                <small>
                  Includes damage dealt before Start. 0 means unlimited.
                </small>
              </span>

              <input
                id="mabTarget"
                type="text"
                value="${escapeHtml(state.settings.targetDamage)}"
                placeholder="5b or 5,000,000,000"
              >
            </label>

            <label class="mab-field">
              <span>
                Delay between attacks in ms
              </span>

              <input
                id="mabDelay"
                type="number"
                min="0"
                step="50"
                value="${state.settings.delayMs}"
              >
            </label>
          </div>

          <div class="mab-options">
            <label>
              <input
                id="mabAutoStamina"
                type="checkbox"
                ${state.settings.autoStamina ? 'checked' : ''}
              >

              Use stamina potions automatically
            </label>

            <label>
              <input
                id="mabAutoMana"
                type="checkbox"
                ${state.settings.autoMana ? 'checked' : ''}
              >

              Use mana potions automatically
            </label>

            <label>
              <input
                id="mabAutoHealth"
                type="checkbox"
                ${state.settings.autoHealth ? 'checked' : ''}
              >

              Use a full health potion when defeated
            </label>
          </div>

          <div class="mab-level-guard">
            <label>
              <input
                id="mabLevelGuard"
                type="checkbox"
                ${state.settings.stopBeforeLevelUp ? 'checked' : ''}
              >

              Stop before level-up
            </label>

            <span>
              when remaining EXP is lower than
            </span>

            <input
              id="mabMultiplier"
              type="number"
              min="0.1"
              step="0.1"
              value="${state.settings.levelMultiplier}"
            >

            <span>
              × the last EXP gain
            </span>
          </div>

          <div class="mab-priority-grid">
            <fieldset>
              <legend>
                Stamina potion priority
              </legend>

              <div
                id="mabStaminaList"
                class="mab-list"
              ></div>
            </fieldset>

            <fieldset>
              <legend>
                Mana potion priority
              </legend>

              <div
                id="mabManaList"
                class="mab-list"
              ></div>
            </fieldset>
          </div>

          <div class="mab-health-box">
            <strong>
              Health potions
            </strong>

            <div
              id="mabHealthList"
              class="mab-list"
            ></div>
          </div>

          <div class="mab-controls">
            <button
              id="mabStart"
              class="mab-button mab-start"
              type="button"
            >
              ▶ Start
            </button>

            <button
              id="mabStop"
              class="mab-button mab-stop"
              type="button"
              disabled
            >
              ■ Stop
            </button>

            <button
              id="mabRefresh"
              class="mab-button mab-secondary"
              type="button"
            >
              ↻ Refresh attacks and potions
            </button>
          </div>

          <div
            id="mabStatus"
            class="mab-status"
          >
            Ready.
          </div>

          <div class="mab-metrics">
            <div>
              <span>
                Total monster damage
              </span>

              <strong id="mabSession">
                0
              </strong>
            </div>

            <div>
              <span>
                Last EXP gain
              </span>

              <strong id="mabLast">
                —
              </strong>
            </div>

            <div>
              <span>
                Remaining EXP
              </span>

              <strong id="mabExp">
                —
              </strong>
            </div>

            <div>
              <span>
                Stamina / Mana / HP
              </span>

              <strong id="mabResources">
                — / — / —
              </strong>
            </div>
          </div>

          <details>
            <summary>Log</summary>

            <div
              id="mabLog"
              class="mab-log"
            ></div>
          </details>

          <div class="mab-hint">
            Attack choices are re-read from the current
            monster card before every attack. Attack 2
            and Attack 3 are stamina fallbacks.
          </div>
        </div>
      </details>
    `;

    return panel;
  }

  function renderAttackOptions() {
    if (!state.panel) {
      return;
    }

    for (let index = 0; index < 3; index += 1) {
      const select = state.panel.querySelector(`#mabAttack${index + 1}`);

      if (!select) {
        continue;
      }

      select.replaceChildren();

      for (const groupName of ['Standard Attacks', 'Class Attacks']) {
        const attacks = state.attacks.filter((attack) => {
          return attack.group === groupName;
        });

        if (!attacks.length) {
          continue;
        }

        const group = document.createElement('optgroup');

        group.label = groupName;

        for (const attack of attacks) {
          const option = document.createElement('option');

          const costs = [];

          if (attack.costs.stamina) {
            costs.push(`${formatNumber(attack.costs.stamina)} STA`);
          }

          if (attack.costs.mana) {
            costs.push(`${formatNumber(attack.costs.mana)} MP`);
          }

          option.value = attack.key;

          option.textContent = costs.length ? `${attack.name} · ${costs.join(' / ')}` : attack.name;

          option.selected = attack.key === state.settings.attackKeys[index];

          group.appendChild(option);
        }

        select.appendChild(group);
      }
    }
  }

  function renderPotionLists() {
    if (!state.panel) {
      return;
    }

    discoverPotions();

    renderPotionList('stamina', '#mabStaminaList');

    renderPotionList('mana', '#mabManaList');

    renderPotionList('health', '#mabHealthList');
  }

  function renderPotionList(type, selector) {
    const container = state.panel?.querySelector(selector);

    if (!container) {
      return;
    }

    container.replaceChildren();

    const potions = (state.settings.potionOrder[type] || [])
      .map((key) => {
        return state.potions.find((potion) => {
          return potion.key === key;
        });
      })
      .filter(Boolean);

    if (!potions.length) {
      const empty = document.createElement('div');

      empty.className = 'mab-empty';

      empty.textContent = 'No matching potion was found.';

      container.appendChild(empty);

      return;
    }

    potions.forEach((potion, index) => {
      const row = document.createElement('div');

      row.className = 'mab-potion-row';

      const enabled = document.createElement('input');

      enabled.type = 'checkbox';

      enabled.checked = state.settings.potionEnabled[potion.key] !== false;

      enabled.title = 'Allow this potion';

      enabled.addEventListener('change', () => {
        state.settings.potionEnabled[potion.key] = enabled.checked;

        saveSettings();
      });

      const main = document.createElement('div');

      main.className = 'mab-potion-main';

      const name = document.createElement('div');

      name.className = 'mab-potion-name';

      name.textContent = potion.name;

      name.title = potion.description;

      main.appendChild(name);

      if (supportsMultiplePotionUse(potion)) {
        const amountRow = document.createElement('label');

        amountRow.className = 'mab-potion-amount';

        const amountLabel = document.createElement('span');

        amountLabel.textContent = 'Use at once:';

        const amountInput = document.createElement('input');

        amountInput.type = 'number';

        amountInput.min = '1';

        amountInput.step = '1';

        amountInput.value = String(getConfiguredPotionAmount(potion));

        amountInput.title = 'Number of potions to use at once';

        amountInput.addEventListener('change', () => {
          const amount = Math.max(
            1,

            Math.floor(Number(amountInput.value) || 1),
          );

          amountInput.value = String(amount);

          state.settings.potionUseAmount[potion.key] = amount;

          saveSettings();
        });

        amountInput.addEventListener('click', (event) => {
          event.stopPropagation();
        });

        amountRow.append(amountLabel, amountInput);

        main.appendChild(amountRow);
      }

      const quantity = document.createElement('div');

      quantity.className = 'mab-quantity';

      quantity.textContent = `×${formatNumber(potion.quantity)}`;

      const moves = document.createElement('div');

      moves.className = 'mab-moves';

      const up = document.createElement('button');

      const down = document.createElement('button');

      for (const button of [up, down]) {
        button.type = 'button';

        button.className = 'mab-move';
      }

      up.textContent = '↑';
      up.title = 'Increase priority';

      up.disabled = index === 0;

      down.textContent = '↓';

      down.title = 'Decrease priority';

      down.disabled = index === potions.length - 1;

      up.addEventListener('click', () => {
        movePotion(type, index, -1);
      });

      down.addEventListener('click', () => {
        movePotion(type, index, 1);
      });

      moves.append(up, down);

      row.append(enabled, main, quantity, moves);

      container.appendChild(row);
    });
  }

  function movePotion(type, index, direction) {
    const order = state.settings.potionOrder[type];

    const target = index + direction;

    if (!order || target < 0 || target >= order.length) {
      return;
    }

    [order[index], order[target]] = [order[target], order[index]];

    saveSettings();
    renderPotionLists();
  }

  function setStatus(message, tone = 'idle') {
    const element = state.panel?.querySelector('#mabStatus');

    if (!element) {
      return;
    }

    element.textContent = message;

    element.className = `mab-status mab-status-${tone}`;
  }

  function log(message) {
    const container = state.panel?.querySelector('#mabLog');

    if (!container) {
      return;
    }

    const line = document.createElement('div');

    line.textContent = `[${new Date().toLocaleTimeString('en-GB')}] ${message}`;

    container.prepend(line);

    while (container.children.length > 60) {
      container.lastElementChild?.remove();
    }
  }

  function updateButtons() {
    if (!state.panel) {
      return;
    }

    state.panel.querySelector('#mabStart').disabled = state.running;

    state.panel.querySelector('#mabStop').disabled = !state.running;
  }

  function updateMetrics() {
    if (!state.panel) {
      return;
    }

    const totalMonsterDamage = getCurrentDamage();

    state.panel.querySelector('#mabSession').textContent = Number.isFinite(totalMonsterDamage)
      ? formatNumber(totalMonsterDamage)
      : '—';

    state.panel.querySelector('#mabLast').textContent = Number.isFinite(state.lastExperienceGain)
      ? formatNumber(state.lastExperienceGain)
      : '—';

    const remaining = getRemainingExperience();

    state.panel.querySelector('#mabExp').textContent = Number.isFinite(remaining) ? formatNumber(remaining) : '—';

    state.panel.querySelector('#mabResources').textContent = [getCurrentStamina(), getCurrentMana(), getCurrentHealth()]
      .map((value) => {
        return Number.isFinite(value) ? formatNumber(value) : '—';
      })
      .join(' / ');
  }

  function bindEvents() {
    const details = state.panel.querySelector('.mab-main');

    details.addEventListener('toggle', () => {
      state.settings.collapsed = !details.open;

      saveSettings();
    });

    state.panel.querySelector('#mabStart').addEventListener('click', () => {
      void runAutoBattle();
    });

    state.panel.querySelector('#mabStop').addEventListener('click', () => {
      stop();
    });

    state.panel.querySelector('#mabRefresh').addEventListener('click', () => {
      discoverAttacks();
      discoverPotions();

      renderAttackOptions();
      renderPotionLists();
      updateMetrics();

      setStatus('Attacks and potions were refreshed.', 'success');
    });

    const selectors = [
      '#mabAttack1',
      '#mabAttack2',
      '#mabAttack3',
      '#mabTarget',
      '#mabDelay',
      '#mabAutoStamina',
      '#mabAutoMana',
      '#mabAutoHealth',
      '#mabLevelGuard',
      '#mabMultiplier',
    ];

    for (const selector of selectors) {
      const element = state.panel.querySelector(selector);

      element.addEventListener('change', readForm);

      if (element.matches('input[type="text"], input[type="number"]')) {
        element.addEventListener('input', readForm);
      }
    }
  }

  async function resumeAfterReload() {
    if (state.running || !state.card) {
      return;
    }

    const resumeData = loadResumeState();

    if (!resumeData) {
      return;
    }

    if (resumeData.monsterKey !== getMonsterKey()) {
      clearResumeState();

      setStatus('Auto-battle was not resumed because the monster changed.');

      return;
    }

    setStatus('Potion use completed. Resuming auto-battle...', 'running');

    await sleep(500);

    if (!state.running) {
      void runAutoBattle(resumeData);
    }
  }

  function mount() {
    const card = findMonsterCard();

    if (!card) {
      return;
    }

    if (state.panel?.isConnected && state.card === card) {
      return;
    }

    const incomingKey = getMonsterKey(card);

    const sameRunningMonster = state.running && state.monsterKey && incomingKey === state.monsterKey;

    if (state.running && !sameRunningMonster) {
      stop('The monster changed. Auto-battle was stopped.');
    }

    document.getElementById(ID)?.remove();

    state.card = card;
    state.attackSignature = '';

    discoverAttacks();
    discoverPotions();
    injectStyles();

    state.panel = createPanel();

    card.appendChild(state.panel);

    bindEvents();
    renderAttackOptions();
    renderPotionLists();
    updateButtons();
    updateMetrics();

    setStatus(
      sameRunningMonster
        ? 'Battle card refreshed after potion use. Auto-battle is continuing.'
        : 'Ready. This configuration applies only to the currently visible monster.',

      sameRunningMonster ? 'running' : 'idle',
    );

    if (!state.running) {
      clearTimeout(state.timers.resume);

      state.timers.resume = setTimeout(() => {
        void resumeAfterReload();
      }, 400);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!document.getElementById(ID)) {
      clearTimeout(state.timers.mount);

      state.timers.mount = setTimeout(mount, 150);
    }

    const attackChanged = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;

      if (target?.closest?.(`#${ID}`)) {
        return false;
      }

      if (target?.closest?.(`${SEL.monsterCard} ${SEL.attack}`)) {
        return true;
      }

      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
        return node instanceof Element && (node.matches?.(SEL.attack) || node.querySelector?.(SEL.attack));
      });
    });

    if (attackChanged && state.panel) {
      clearTimeout(state.timers.attacks);

      state.timers.attacks = setTimeout(() => {
        if (discoverAttacks()) {
          renderAttackOptions();
        }
      }, 180);
    }

    const potionChanged = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;

      return target?.closest?.(
        '#battleDrawer, ' +
          '#ds-combat-potion-quick-use, ' +
          '.potion-card, ' +
          '.potion-qty-left, ' +
          '.ds-potion-count',
      );
    });

    if (potionChanged && state.panel) {
      clearTimeout(state.timers.potions);

      state.timers.potions = setTimeout(() => {
        renderPotionLists();
        updateMetrics();
      }, 250);
    }

    const resourceChanged = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;

      return target?.closest?.(`${SEL.stamina}, ` + `${SEL.playerHp}, ` + `${SEL.playerMana}, ` + '.gtb-exp');
    });

    if (resourceChanged && state.panel) {
      clearTimeout(state.timers.metrics);

      state.timers.metrics = setTimeout(updateMetrics, 100);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  mount();
})();
