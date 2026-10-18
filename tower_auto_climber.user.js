// ==UserScript==
// @name         Demonic Tower Autopilot
// @namespace    local.demonicscans.tower
// @version      1.7.0
// @description  Automates Demonic Tower combat, events, quests, companions, boss preparations, start floors, potions, paths, and powers.
// @author       Myrkjartan Hrolfr
// @match        https://demonicscans.org/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_ID = 'tm-demonic-tower-autopilot';
  const SETTINGS_VERSION = 1;
  const RETRY_TIMEOUT_MS = 30000;
  const MISSING_RUN_GRACE_MS = 10000;
  const MAX_DESIRED_POWER_STACKS = 99;

  const DEFAULTS = Object.freeze({
    attack: 'slash',
    guardHeavy: true,
    potionEnabled: false,
    potionThreshold: 30,
    statusPotionEnabled: false,
    statusPotionStatuses: Object.freeze({
      burned: true,
      frozen: true,
      poisoned: true,
    }),
    respectNoPotion: true,
    questEnabled: true,
    companionFloor: 'none',
    companionFloor19Choice: 'defend',
    floorBossChoice: 'manual',
    startFloors: Object.freeze([]),
    sanctuaryHealThreshold: 50,
    merchantChoice: 1,
    path: 'left',
    powerMode: 'wishlist',
    powerFallback: 'pause',
    preferredPowers: [],
    unknownDecision: 'pause',
    actionDelayMs: 1050,
    collapsed: false,
  });

  const RARITY_RANK = Object.freeze({
    common: 1,
    uncommon: 2,
    rare: 2,
    epic: 3,
    legendary: 4,
    mythic: 5,
  });

  const VALID_SETTINGS = Object.freeze({
    attack: new Set(['slash', 'magic']),
    path: new Set(['left', 'right', 'random']),
    powerMode: new Set(['wishlist', 'rarity', 'skip', 'pause']),
    powerFallback: new Set(['pause', 'skip', 'rarity']),
    companionFloor: new Set(['none', '3', '6', '9']),
    companionFloor19Choice: new Set(['defend', 'surrender']),
    floorBossChoice: new Set(['manual', 'healing', 'armor', 'intact']),
    unknownDecision: new Set(['pause', 'first']),
  });

  const STATUS_PATTERNS = Object.freeze({
    burned: /\b(?:burn|burned|burning)\b/i,
    frozen: /\b(?:freeze|freezing|frozen)\b/i,
    poisoned: /\b(?:poison|poisoned|poisoning)\b/i,
  });

  const STATUS_LABELS = Object.freeze({
    burned: 'Burned',
    frozen: 'Frozen',
    poisoned: 'Poisoned',
  });

  const SANCTUARY_CHOICES = Object.freeze(['heal', 'cleanse', 'blessing']);
  const MERCHANT_CHOICES = Object.freeze(['potion', 'common', 'epic', 'legendary']);
  const COMPANION_RECRUITMENT_CHOICES = Object.freeze(['rescue', 'leave']);
  const COMPANION_FLOOR_19_CHOICES = Object.freeze(['defend', 'surrender']);
  const COMPANION_FLOORS_BY_TITLE = Object.freeze({
    'Razek, the Disgraced Blade': 3,
    'Veyshi, the Rune-Eater': 6,
    'Ulgro, the Gentle Devourer': 9,
  });
  const FLOOR_BOSS_CHOICES = Object.freeze(['healing', 'armor', 'intact']);
  const QUEST_TYPES = Object.freeze(['unchanging', 'dry_blood', 'blade_only', 'ability_lock']);
  const FLOOR_BOSS_LABELS = Object.freeze({
    healing: 'Destroy the apparatus; fight the additional elite to remove boss regeneration.',
    armor: 'Spend 60 Abyssal Coins to remove the boss’s +20% DEF enhancement.',
    intact: 'Keep both boss enhancements and challenge it for 2 extra mutation energy.',
  });
  const START_FLOORS = Object.freeze([10, 20, 30]);

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasExactChoiceSignature(actualChoices, expectedChoices) {
    if (
      !Array.isArray(actualChoices) ||
      !Array.isArray(expectedChoices) ||
      actualChoices.length !== expectedChoices.length
    ) {
      return false;
    }

    const actual = actualChoices.map((choice) => normalizeText(choice).toLowerCase());
    const expected = expectedChoices.map((choice) => normalizeText(choice).toLowerCase());

    if (
      actual.some((choice) => !choice) ||
      expected.some((choice) => !choice) ||
      new Set(actual).size !== actual.length ||
      new Set(expected).size !== expected.length
    ) {
      return false;
    }

    return expected.every((choice) => actual.includes(choice));
  }

  function getUniqueAvailableChoice(targetChoice, availableChoices, allowedChoices) {
    if (!Array.isArray(availableChoices)) {
      return null;
    }

    const target = normalizeText(targetChoice).toLowerCase();
    const available = availableChoices.map((choice) => normalizeText(choice).toLowerCase());

    if (
      !target ||
      available.some((choice) => !choice || !allowedChoices.includes(choice)) ||
      new Set(available).size !== available.length
    ) {
      return null;
    }

    return available.filter((choice) => choice === target).length === 1 ? target : null;
  }

  function getCompanionRecruitmentFloor({ title, roomChoices = [] } = {}) {
    const normalizedTitle = normalizeText(title);

    if (!Object.prototype.hasOwnProperty.call(COMPANION_FLOORS_BY_TITLE, normalizedTitle)) {
      return null;
    }

    const floor = COMPANION_FLOORS_BY_TITLE[normalizedTitle];

    return hasExactChoiceSignature(roomChoices, COMPANION_RECRUITMENT_CHOICES)
      ? floor
      : null;
  }

  function chooseCompanionRecruitmentChoice({
    configuredFloor,
    title,
    roomChoices = [],
    availableChoices = [],
  } = {}) {
    const offeredFloor = getCompanionRecruitmentFloor({ title, roomChoices });
    const selectedFloor = normalizeText(configuredFloor).toLowerCase();

    if (!offeredFloor || !VALID_SETTINGS.companionFloor.has(selectedFloor)) {
      return null;
    }

    const choice = selectedFloor === String(offeredFloor) ? 'rescue' : 'leave';

    return getUniqueAvailableChoice(choice, availableChoices, COMPANION_RECRUITMENT_CHOICES);
  }

  function isCompanionFloor19Context({ title, roomChoices = [] } = {}) {
    return (
      Object.prototype.hasOwnProperty.call(COMPANION_FLOORS_BY_TITLE, normalizeText(title)) &&
      hasExactChoiceSignature(roomChoices, COMPANION_FLOOR_19_CHOICES)
    );
  }

  function chooseCompanionFloor19Choice({
    configuredChoice,
    title,
    roomChoices = [],
    availableChoices = [],
  } = {}) {
    const choice = normalizeText(configuredChoice).toLowerCase();

    if (
      !isCompanionFloor19Context({ title, roomChoices }) ||
      !VALID_SETTINGS.companionFloor19Choice.has(choice)
    ) {
      return null;
    }

    return getUniqueAvailableChoice(choice, availableChoices, COMPANION_FLOOR_19_CHOICES);
  }

  function normalizeCompanionFlowLatch(latch) {
    if (!latch || typeof latch !== 'object') {
      return null;
    }

    const stage = normalizeText(latch.stage).toLowerCase();
    const choice = normalizeText(latch.choice).toLowerCase();
    const title = normalizeText(latch.title);
    const requestId = normalizeText(latch.requestId);
    const revision = normalizeText(latch.revision);
    const validChoice =
      (stage === 'recruitment' && COMPANION_RECRUITMENT_CHOICES.includes(choice)) ||
      (['floor19', 'continue'].includes(stage) && COMPANION_FLOOR_19_CHOICES.includes(choice));

    if (
      !validChoice ||
      !Object.prototype.hasOwnProperty.call(COMPANION_FLOORS_BY_TITLE, title) ||
      !requestId ||
      !revision
    ) {
      return null;
    }

    return {
      stage,
      choice,
      title,
      requestId,
      revision,
      usedAt: Number.isFinite(Number(latch.usedAt)) ? Number(latch.usedAt) : 0,
    };
  }

  function companionLatchMatchesVisit(latch, { requestIds = [], revisions = [] } = {}) {
    const normalizedLatch = normalizeCompanionFlowLatch(latch);

    if (!normalizedLatch) {
      return false;
    }

    const currentRequestIds = Array.isArray(requestIds)
      ? requestIds.map((value) => normalizeText(value)).filter(Boolean)
      : [];
    const currentRevisions = Array.isArray(revisions)
      ? revisions.map((value) => normalizeText(value)).filter(Boolean)
      : [];

    if (
      currentRequestIds.includes(normalizedLatch.requestId) ||
      currentRevisions.includes(normalizedLatch.revision)
    ) {
      return true;
    }

    // Missing server tokens fail closed so a paid or destructive choice is
    // never repeated merely because the page markup changed.
    return !currentRequestIds.length || !currentRevisions.length;
  }

  function shouldClearCompanionFlowLatch({ latch, reportedFloor, preserveContinue = false } = {}) {
    const normalizedLatch = normalizeCompanionFlowLatch(latch);

    if (!normalizedLatch) {
      return false;
    }

    if (normalizedLatch.stage === 'recruitment') {
      return true;
    }

    if (normalizedLatch.stage === 'continue') {
      return !preserveContinue;
    }

    const floorText = normalizeText(reportedFloor);
    const floor = /^\d+$/.test(floorText) ? Number(floorText) : null;

    return Number.isInteger(floor) && floor >= 1 && floor < 19;
  }

  function isCompanionContinueContext({
    latch,
    panelTitle,
    panelText,
    roomChoices = [],
  } = {}) {
    const normalizedLatch = normalizeCompanionFlowLatch(latch);

    if (
      !normalizedLatch ||
      !['floor19', 'continue'].includes(normalizedLatch.stage) ||
      !hasExactChoiceSignature(roomChoices, ['continue'])
    ) {
      return false;
    }

    if (
      normalizedLatch.choice === 'defend' &&
      normalizeText(panelTitle).toLowerCase() !== 'a promise kept'
    ) {
      return false;
    }

    const companionName = normalizedLatch.title.split(',')[0].toLowerCase();
    const escapedName = companionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return new RegExp(`\\b${escapedName}\\b`, 'i').test(normalizeText(panelText));
  }

  function chooseCompanionContinueChoice({
    latch,
    panelTitle,
    panelText,
    roomChoices = [],
    availableChoices = [],
  } = {}) {
    if (!isCompanionContinueContext({ latch, panelTitle, panelText, roomChoices })) {
      return null;
    }

    return getUniqueAvailableChoice('continue', availableChoices, ['continue']);
  }

  function normalizeStartFloors(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const selected = new Set(value.map(Number));

    return START_FLOORS.filter((floor) => selected.has(floor));
  }

  function parseStartFloor(value) {
    const text = normalizeText(value)
      .replace(/[_-]+/g, ' ')
      .toLowerCase();
    const floors = new Set();
    const patterns = [
      /\b(?:start(?:ing)?\s*floors?|floors?\s*starts?|checkpoint)\D{0,24}(10|20|30)\b/g,
      /\bfloor\s*(10|20|30)\b/g,
      /\b(10|20|30)(?:st|nd|rd|th)?\s+floor\b/g,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        floors.add(Number(match[1]));
      }
    }

    return floors.size === 1 ? [...floors][0] : null;
  }

  function planStartFloorAction({
    selectedFloors = [],
    offeredFloors = [],
    buyableFloors = [],
    attemptedFloors = [],
    declineAvailable = false,
  } = {}) {
    const selected = normalizeStartFloors(selectedFloors);
    const offered = normalizeStartFloors(offeredFloors);
    const buyable = normalizeStartFloors(buyableFloors);
    const attempted = normalizeStartFloors(attemptedFloors);

    if (selected.length && !offered.length) {
      return null;
    }

    const floor = START_FLOORS.find((candidate) => {
      return selected.includes(candidate) && offered.includes(candidate) && !attempted.includes(candidate);
    });

    if (floor) {
      return buyable.includes(floor) ? { kind: 'buy', floor } : null;
    }

    return declineAvailable ? { kind: 'decline', floor: null } : null;
  }

  function isStartFloorDecisionContext({ panelText, hasKnownFloor = false, roomChoices = [] } = {}) {
    const text = normalizeText(panelText).replace(/[_-]+/g, ' ');
    const hasStartFloorContext = /\b(?:start(?:ing)?\s*floors?|floors?\s*starts?|checkpoint)\b/i.test(text);

    if (!hasStartFloorContext) {
      return false;
    }

    if (hasKnownFloor) {
      return true;
    }

    const choices = Array.isArray(roomChoices)
      ? roomChoices.map((choice) => normalizeText(choice).toLowerCase()).filter(Boolean)
      : [];

    return (
      /\bcheckpoint\b/i.test(text) &&
      choices.length === 2 &&
      choices.includes('buy') &&
      choices.includes('skip')
    );
  }

  function isFloorBossDecisionContext({ roomChoices = [] } = {}) {
    if (!Array.isArray(roomChoices)) {
      return false;
    }

    const choices = roomChoices.map((choice) => normalizeText(choice).toLowerCase()).filter(Boolean);

    return (
      choices.length === FLOOR_BOSS_CHOICES.length &&
      new Set(choices).size === FLOOR_BOSS_CHOICES.length &&
      FLOOR_BOSS_CHOICES.every((choice) => choices.includes(choice))
    );
  }

  function parseQuestReward(rewardText, fallbackCoins = 0) {
    const text = normalizeText(rewardText);
    const coins = Number(text.match(/\b(\d+)\s+coins?\b/i)?.[1]);
    const energy = Number(text.match(/\b(\d+)\s+(?:mutation\s+)?energy\b/i)?.[1]);

    return {
      coins: Number.isFinite(coins) ? coins : fallbackCoins,
      energy: Number.isFinite(energy) ? energy : 0,
    };
  }

  function classifyQuestOffer({ title, description, rewardText, choice } = {}) {
    const normalizedTitle = normalizeText(title).toLowerCase();
    const normalizedDescription = normalizeText(description).toLowerCase();
    const normalizedChoice = normalizeText(choice).toLowerCase();
    let type = '';
    let fallbackCoins = 0;

    if (
      normalizedTitle === 'unbroken resolve' &&
      /without replacing any power/.test(normalizedDescription)
    ) {
      type = 'unchanging';
      fallbackCoins = 120;
    } else if (
      normalizedTitle === 'the unquenched' &&
      /without drinking an hp potion/.test(normalizedDescription)
    ) {
      type = 'dry_blood';
      fallbackCoins = 120;
    } else if (
      normalizedTitle === 'trial of the cleaver' &&
      /using slash, not magic/.test(normalizedDescription)
    ) {
      type = 'blade_only';
      fallbackCoins = 100;
    } else if (
      /\b(?:lock|locks|locked)\b/.test(normalizedDescription) &&
      /\b(?:2|two)\b.*\b(?:ability|power)\s+slots?\b/.test(normalizedDescription) &&
      /\b(?:3|three)\b\s+floors?\b/.test(normalizedDescription)
    ) {
      type = 'ability_lock';
      fallbackCoins = 180;
    }

    if (!type || !normalizedChoice) {
      return null;
    }

    return {
      type,
      title: normalizeText(title),
      description: normalizeText(description),
      choice: normalizedChoice,
      ...parseQuestReward(rewardText, fallbackCoins),
    };
  }

  function scoreQuestOffer(quest, context = {}) {
    if (!quest || !QUEST_TYPES.includes(quest.type)) {
      return null;
    }

    const base = quest.coins + quest.energy * 30;

    switch (quest.type) {
      case 'ability_lock':
        return Number(context.currentFloor) === 1 ? base + 10000 : null;
      case 'unchanging':
        return context.wishlistEpicReady === true ? base + 5 : null;
      case 'dry_blood':
        if (context.hpPotionUsedRecently !== false) {
          return null;
        }
        return base;
      case 'blade_only':
        return base;
      default:
        return null;
    }
  }

  function chooseQuestOffer({ offers = [], context = {} } = {}) {
    if (!Array.isArray(offers) || offers.length !== 2) {
      return null;
    }

    const candidates = offers
      .map((offer, index) => {
        const score = scoreQuestOffer(offer, context);
        return score === null ? null : { offer, score, index };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.index - right.index);

    return candidates[0]?.offer.choice || offers.find((offer) => offer?.type === 'blade_only')?.choice || offers[0]?.choice || null;
  }

  function hasHpPotionBeenUsedRecently(usedFloors, currentFloor) {
    const floor = Number(currentFloor);

    if (!Number.isInteger(floor) || floor < 1 || !Array.isArray(usedFloors)) {
      return null;
    }

    return usedFloors.some((usedFloor) => {
      const value = Number(usedFloor);
      return Number.isInteger(value) && value >= floor - 3 && value <= floor;
    });
  }

  function chooseFloorBossChoice({ configuredChoice, roomChoices = [], availableChoices = [] } = {}) {
    if (!isFloorBossDecisionContext({ roomChoices })) {
      return null;
    }

    const choice = normalizeText(configuredChoice).toLowerCase();

    if (!FLOOR_BOSS_CHOICES.includes(choice) || !Array.isArray(availableChoices)) {
      return null;
    }

    const usableChoices = availableChoices
      .map((availableChoice) => normalizeText(availableChoice).toLowerCase())
      .filter(Boolean);

    return usableChoices.filter((availableChoice) => availableChoice === choice).length === 1
      ? choice
      : null;
  }

  function normalizePowerKey(value) {
    return normalizeText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function uniquePowerNames(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
    const names = new Map();

    for (const rawName of values) {
      const name = normalizeText(rawName);
      const key = normalizePowerKey(name);

      if (key && !names.has(key)) {
        names.set(key, name);
      }
    }

    return [...names.values()];
  }

  function normalizePowerWishlist(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
    const entries = new Map();

    for (const rawEntry of values) {
      let rawName = rawEntry;
      let rawDesiredStacks = null;

      if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
        rawName = rawEntry.name;
        rawDesiredStacks = rawEntry.desiredStacks ?? rawEntry.quantity ?? rawEntry.amount ?? null;
      } else {
        const line = String(rawEntry ?? '');
        const separatorIndex = line.lastIndexOf('|');

        if (separatorIndex >= 0) {
          rawName = line.slice(0, separatorIndex);
          rawDesiredStacks = line.slice(separatorIndex + 1);
        }
      }

      const name = normalizeText(rawName);
      const key = normalizePowerKey(name);

      if (!key || entries.has(key)) {
        continue;
      }

      const desiredNumber = Number(rawDesiredStacks);
      const hasDesiredStacks = rawDesiredStacks !== null && String(rawDesiredStacks).trim() !== '';
      const desiredStacks = hasDesiredStacks
        ? clampNumber(desiredNumber, 1, MAX_DESIRED_POWER_STACKS, 1)
        : null;

      entries.set(key, {
        name,
        desiredStacks,
      });
    }

    return [...entries.values()];
  }

  function formatPowerWishlist(value) {
    return normalizePowerWishlist(value)
      .map((entry) =>
        Number.isFinite(entry.desiredStacks) ? `${entry.name} | ${entry.desiredStacks}` : entry.name,
      )
      .join('\n');
  }

  function matchStatusEffect(value, enabledStatuses = DEFAULTS.statusPotionStatuses) {
    const text = normalizeText(value);

    for (const [status, pattern] of Object.entries(STATUS_PATTERNS)) {
      if (enabledStatuses?.[status] !== false && pattern.test(text)) {
        return status;
      }
    }

    return '';
  }

  function isStatusPotionName(value) {
    return /^status potion(?:\s+(?:[x×]\s*\d+|\(\s*[x×]\s*\d+\s*\)))?$/i.test(normalizeText(value));
  }

  function chooseSanctuaryChoice({ hpPercent, healThreshold, hasStatus } = {}) {
    if (hpPercent === '' || hpPercent === null || hpPercent === undefined) {
      return null;
    }

    const hp = Number(hpPercent);
    if (!Number.isFinite(hp) || hp < 0) {
      return null;
    }

    const threshold = clampNumber(healThreshold, 1, 99, DEFAULTS.sanctuaryHealThreshold);

    if (hp >= 100) {
      return hasStatus ? 'cleanse' : 'blessing';
    }

    if (hp <= threshold) {
      return 'heal';
    }

    return hasStatus ? 'cleanse' : 'heal';
  }

  function getMerchantChoice(position) {
    const normalizedPosition = Number(position);

    if (!Number.isInteger(normalizedPosition)) {
      return null;
    }

    return MERCHANT_CHOICES[normalizedPosition - 1] || null;
  }

  function chooseMerchantAction({ position, purchaseAttempted = false, availableChoices = [] } = {}) {
    const choices = new Set(Array.isArray(availableChoices) ? availableChoices : []);

    if (purchaseAttempted) {
      return choices.has('leave') ? 'leave' : null;
    }

    const targetChoice = getMerchantChoice(position);

    return targetChoice && choices.has(targetChoice) ? targetChoice : null;
  }

  function merchantLatchMatchesVisit(latch, { revision, requestIds = [] } = {}) {
    if (!latch || typeof latch !== 'object') {
      return false;
    }

    const previousRequestId = String(latch.requestId || '');
    if (previousRequestId && requestIds.some((requestId) => String(requestId) === previousRequestId)) {
      return true;
    }

    const previousRevisionText = String(latch.revision ?? '');
    const currentRevisionText = String(revision ?? '');
    const previousRevision = Number(previousRevisionText);
    const currentRevision = Number(currentRevisionText);

    if (
      previousRevisionText &&
      currentRevisionText &&
      Number.isSafeInteger(previousRevision) &&
      Number.isSafeInteger(currentRevision)
    ) {
      const revisionSteps = currentRevision - previousRevision;

      return revisionSteps >= 0 && revisionSteps <= 1;
    }

    // Without either server token, keeping the latch is safer than risking a
    // duplicate purchase after a markup change.
    return true;
  }

  function rarityRank(value) {
    return RARITY_RANK[String(value ?? '').toLowerCase()] || 0;
  }

  function parseRatio(value) {
    const match = String(value ?? '').match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);

    if (!match) {
      return null;
    }

    const current = Number(match[1]);
    const maximum = Number(match[2]);

    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) {
      return null;
    }

    return {
      current,
      maximum,
    };
  }

  function sanitizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const sourceStatuses =
      source.statusPotionStatuses && typeof source.statusPotionStatuses === 'object'
        ? source.statusPotionStatuses
        : {};
    const wishlistSource = source.preferredPowers ?? source.powerWishlist ?? DEFAULTS.preferredPowers;

    return {
      attack: VALID_SETTINGS.attack.has(source.attack) ? source.attack : DEFAULTS.attack,
      guardHeavy: source.guardHeavy !== false,
      potionEnabled: source.potionEnabled === true,
      potionThreshold: clampNumber(source.potionThreshold, 1, 99, DEFAULTS.potionThreshold),
      statusPotionEnabled: source.statusPotionEnabled === true,
      statusPotionStatuses: {
        burned: sourceStatuses.burned !== false,
        frozen: sourceStatuses.frozen !== false,
        poisoned: sourceStatuses.poisoned !== false,
      },
      respectNoPotion: source.respectNoPotion !== false,
      questEnabled: source.questEnabled !== false,
      companionFloor: VALID_SETTINGS.companionFloor.has(String(source.companionFloor))
        ? String(source.companionFloor)
        : DEFAULTS.companionFloor,
      companionFloor19Choice: VALID_SETTINGS.companionFloor19Choice.has(source.companionFloor19Choice)
        ? source.companionFloor19Choice
        : DEFAULTS.companionFloor19Choice,
      floorBossChoice: VALID_SETTINGS.floorBossChoice.has(source.floorBossChoice)
        ? source.floorBossChoice
        : DEFAULTS.floorBossChoice,
      startFloors: normalizeStartFloors(source.startFloors),
      sanctuaryHealThreshold: clampNumber(
        source.sanctuaryHealThreshold,
        1,
        99,
        DEFAULTS.sanctuaryHealThreshold,
      ),
      merchantChoice: clampNumber(source.merchantChoice, 1, 4, DEFAULTS.merchantChoice),
      path: VALID_SETTINGS.path.has(source.path) ? source.path : DEFAULTS.path,
      powerMode: VALID_SETTINGS.powerMode.has(source.powerMode) ? source.powerMode : DEFAULTS.powerMode,
      powerFallback: VALID_SETTINGS.powerFallback.has(source.powerFallback)
        ? source.powerFallback
        : DEFAULTS.powerFallback,
      preferredPowers: normalizePowerWishlist(wishlistSource),
      unknownDecision: VALID_SETTINGS.unknownDecision.has(source.unknownDecision)
        ? source.unknownDecision
        : DEFAULTS.unknownDecision,
      actionDelayMs: clampNumber(source.actionDelayMs, 750, 5000, DEFAULTS.actionDelayMs),
      collapsed: source.collapsed === true,
    };
  }

  function makePreferenceMap(preferredPowers) {
    return new Map(
      normalizePowerWishlist(preferredPowers).map((entry, index) => [
        normalizePowerKey(entry.name),
        { ...entry, index },
      ]),
    );
  }

  function orderWishlistOffers(offers, preferredPowers) {
    const preferenceMap = makePreferenceMap(preferredPowers);

    return [...offers]
      .filter((offer) => preferenceMap.has(offer.key))
      .sort((left, right) => {
        const priorityDifference = preferenceMap.get(left.key).index - preferenceMap.get(right.key).index;

        if (priorityDifference !== 0) {
          return priorityDifference;
        }

        const rarityDifference = rarityRank(right.rarity) - rarityRank(left.rarity);

        if (rarityDifference !== 0) {
          return rarityDifference;
        }

        return left.index - right.index;
      });
  }

  function orderRarityOffers(offers) {
    return [...offers].sort((left, right) => {
      const rarityDifference = rarityRank(right.rarity) - rarityRank(left.rarity);

      if (rarityDifference !== 0) {
        return rarityDifference;
      }

      return left.index - right.index;
    });
  }

  function choosePowerPlacement(candidate, options, preferredPowers, context = {}) {
    const preferenceMap = makePreferenceMap(preferredPowers);
    const candidatePreference = preferenceMap.get(candidate.key);
    const desiredStacks = candidatePreference?.desiredStacks;
    const hasDesiredStacks = Number.isFinite(desiredStacks);
    const effectiveTarget = hasDesiredStacks
      ? Number.isFinite(candidate.maxStacks)
        ? Math.min(desiredStacks, candidate.maxStacks)
        : desiredStacks
      : null;
    const targetIsUnknown = hasDesiredStacks && !Number.isFinite(candidate.ownedStacks);
    const targetIsMet =
      Number.isFinite(effectiveTarget) &&
      Number.isFinite(candidate.ownedStacks) &&
      candidate.ownedStacks >= effectiveTarget;
    const stackIsFull =
      Number.isFinite(candidate.ownedStacks) &&
      Number.isFinite(candidate.maxStacks) &&
      candidate.ownedStacks >= candidate.maxStacks;

    if (context.strategy === 'wishlist' && !candidatePreference) {
      return null;
    }

    if (!context.hasSelect) {
      if (targetIsUnknown || targetIsMet || stackIsFull) {
        return null;
      }

      return {
        kind: 'direct',
        value: null,
        reason: 'no slot selection required',
      };
    }

    const usableOptions = options.filter((option) => !option.disabled);
    const freeOption = usableOptions.find((option) => option.isFree);
    const replacements = usableOptions.filter((option) => !option.isFree && option.value);
    const candidateRarity = rarityRank(candidate.rarity);
    const samePowerUpgrade = replacements
      .filter((option) => option.key === candidate.key && rarityRank(option.rarity) < candidateRarity)
      .sort((left, right) => rarityRank(left.rarity) - rarityRank(right.rarity))[0];
    const upgradePlacement = samePowerUpgrade
      ? {
          kind: 'upgrade',
          value: samePowerUpgrade.value,
          reason: `upgrades ${samePowerUpgrade.name || candidate.name} from ${
            samePowerUpgrade.rarity || 'a lower rarity'
          }`,
        }
      : null;

    // Once either the requested amount or the native stack cap is reached, the
    // only safe improvement is replacing a lower-rarity stack of the same power.
    // The same restriction applies when an explicit target exists but the
    // current amount cannot be read reliably.
    if (targetIsUnknown || targetIsMet || stackIsFull) {
      return upgradePlacement;
    }

    if (freeOption && context.hasFreeCapacity !== false) {
      return {
        kind: 'free',
        value: freeOption.value,
        reason: 'uses a free Power slot',
      };
    }

    if (context.hasFreeCapacity === true && !freeOption) {
      return null;
    }

    if (context.strategy === 'wishlist') {
      const candidatePriority = candidatePreference.index;

      const unlistedReplacement = replacements
        .filter((option) => option.key && !preferenceMap.has(option.key))
        .sort((left, right) => {
          const rarityDifference = rarityRank(left.rarity) - rarityRank(right.rarity);

          if (rarityDifference !== 0) {
            return rarityDifference;
          }

          return String(left.name).localeCompare(String(right.name));
        })[0];

      if (unlistedReplacement) {
        return {
          kind: 'replace-unlisted',
          value: unlistedReplacement.value,
          reason: `replaces the unlisted Power ${unlistedReplacement.name}`,
        };
      }

      const lowerPriorityReplacement = replacements
        .map((option) => ({
          ...option,
          priority: preferenceMap.get(option.key)?.index,
        }))
        .filter((option) => Number.isFinite(option.priority) && option.priority > candidatePriority)
        .sort((left, right) => {
          const priorityDifference = right.priority - left.priority;

          if (priorityDifference !== 0) {
            return priorityDifference;
          }

          return rarityRank(left.rarity) - rarityRank(right.rarity);
        })[0];

      if (lowerPriorityReplacement) {
        return {
          kind: 'replace-lower-priority',
          value: lowerPriorityReplacement.value,
          reason: `replaces the lower-priority Power ${lowerPriorityReplacement.name}`,
        };
      }

      return upgradePlacement;
    }

    if (context.strategy === 'rarity') {
      if (upgradePlacement) {
        return upgradePlacement;
      }

      const lowerRarityReplacement = replacements
        .filter((option) => {
          const isProtected = preferenceMap.has(option.key) && option.key !== candidate.key;

          return !isProtected && rarityRank(option.rarity) < candidateRarity;
        })
        .sort((left, right) => rarityRank(left.rarity) - rarityRank(right.rarity))[0];

      if (lowerRarityReplacement) {
        return {
          kind: 'replace-lower-rarity',
          value: lowerRarityReplacement.value,
          reason: `replaces the lower-rarity Power ${lowerRarityReplacement.name}`,
        };
      }
    }

    return null;
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = Object.freeze({
        chooseCompanionContinueChoice,
        chooseCompanionFloor19Choice,
  chooseCompanionRecruitmentChoice,
  chooseQuestOffer,
  classifyQuestOffer,
        chooseQuestOffer,
        classifyQuestOffer,
        chooseMerchantAction,
        chooseFloorBossChoice,
        chooseSanctuaryChoice,
        choosePowerPlacement,
        companionLatchMatchesVisit,
        formatPowerWishlist,
        getMerchantChoice,
        getCompanionRecruitmentFloor,
        hasExactChoiceSignature,
        isCompanionContinueContext,
        isCompanionFloor19Context,
        isFloorBossDecisionContext,
        isStartFloorDecisionContext,
        isStatusPotionName,
        matchStatusEffect,
        merchantLatchMatchesVisit,
        normalizeCompanionFlowLatch,
        normalizePowerKey,
        normalizePowerWishlist,
        normalizeStartFloors,
        orderRarityOffers,
        orderWishlistOffers,
        parseRatio,
        parseStartFloor,
        planStartFloorAction,
        rarityRank,
  sanitizeSettings,
  scoreQuestOffer,
        scoreQuestOffer,
        shouldClearCompanionFlowLatch,
        uniquePowerNames,
      });
    }

    return;
  }

  if (!document.body?.matches('[data-tower-user][data-tower-occ]')) {
    return;
  }

  const towerUser = document.body.dataset.towerUser;
  const towerOccurrence = document.body.dataset.towerOcc;
  const SETTINGS_KEY = `${SCRIPT_ID}:settings:v${SETTINGS_VERSION}:${towerUser}`;
  const ENABLED_KEY = `${SCRIPT_ID}:enabled:v1:${towerUser}:${towerOccurrence}`;
  const LOCK_NAME = `${SCRIPT_ID}:owner:${towerUser}:${towerOccurrence}`;
  const NATIVE_KEY = `tower:${towerUser}:${towerOccurrence}`;
  const STATUS_POTION_LATCH_KEY = `${SCRIPT_ID}:status-potion-latch:v1:${towerUser}:${towerOccurrence}`;
  const MERCHANT_PURCHASE_LATCH_KEY = `${SCRIPT_ID}:merchant-purchase-latch:v1:${towerUser}:${towerOccurrence}`;
  const COMPANION_FLOW_LATCH_KEY = `${SCRIPT_ID}:companion-flow-latch:v1:${towerUser}:${towerOccurrence}`;
  const HP_POTION_FLOORS_KEY = `${SCRIPT_ID}:hp-potion-floors:v1:${towerUser}:${towerOccurrence}`;
  const START_FLOOR_ATTEMPTS_KEY = `${SCRIPT_ID}:start-floor-attempts:v1:${towerUser}:${towerOccurrence}`;

  const runtime = {
    root: null,
    observer: null,
    timer: 0,
    enabled: readPersistentEnabled(),
    running: false,
    starting: false,
    lockHeld: false,
    lockGeneration: 0,
    releaseLock: null,
    lastActionAt: 0,
    lastFingerprint: '',
    lastRetryFingerprint: '',
    retryStartedAt: 0,
    missingRunSince: 0,
    reacquireWhenRunAppears: false,
    status: '',
    tone: 'neutral',
    stoppingNative: false,
    statusPotionLatch: null,
    floorBossChoiceAttempted: '',
    merchantPurchaseLatch: null,
    companionFlowLatch: null,
    hpPotionFloors: null,
    startFloorAttempts: null,
  };

  let settings = loadSettings();

  function readJson(storage, key, fallback) {
    try {
      const value = storage.getItem(key);

      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }

  function loadSettings() {
    return sanitizeSettings(readJson(localStorage, SETTINGS_KEY, {}));
  }

  function saveSettings() {
    writeJson(localStorage, SETTINGS_KEY, settings);
  }

  function readStatusPotionLatch() {
    if (runtime.statusPotionLatch) {
      return runtime.statusPotionLatch;
    }

    const latch = readJson(localStorage, STATUS_POTION_LATCH_KEY, null);

    runtime.statusPotionLatch =
      latch && typeof latch === 'object' && typeof latch.status === 'string' ? latch : null;

    return runtime.statusPotionLatch;
  }

  function writeStatusPotionLatch(status) {
    runtime.statusPotionLatch = {
      status,
      usedAt: Date.now(),
    };
    writeJson(localStorage, STATUS_POTION_LATCH_KEY, runtime.statusPotionLatch);
  }

  function clearStatusPotionLatch() {
    runtime.statusPotionLatch = null;

    try {
      localStorage.removeItem(STATUS_POTION_LATCH_KEY);
    } catch {
      // The in-page automation can continue even when storage is unavailable.
    }
  }

  function readHpPotionFloors() {
    if (runtime.hpPotionFloors) {
      return runtime.hpPotionFloors;
    }

    const saved = readJson(localStorage, HP_POTION_FLOORS_KEY, []);
    runtime.hpPotionFloors = Array.isArray(saved)
      ? [...new Set(saved.map(Number).filter((floor) => Number.isInteger(floor) && floor >= 1))].slice(-12)
      : [];
    return runtime.hpPotionFloors;
  }

  function recordHpPotionUse(state) {
    const floor = Number(state?.dataset.floor);

    if (!Number.isInteger(floor) || floor < 1) {
      return;
    }

    runtime.hpPotionFloors = [...readHpPotionFloors().filter((value) => value !== floor), floor].slice(-12);
    writeJson(localStorage, HP_POTION_FLOORS_KEY, runtime.hpPotionFloors);
  }

  function forgetHpPotionUse(state) {
    const floor = Number(state?.dataset.floor);

    if (!Number.isInteger(floor)) {
      return;
    }

    runtime.hpPotionFloors = readHpPotionFloors().filter((value) => value !== floor);
    writeJson(localStorage, HP_POTION_FLOORS_KEY, runtime.hpPotionFloors);
  }

  function clearHpPotionFloors() {
    runtime.hpPotionFloors = [];
    try {
      localStorage.removeItem(HP_POTION_FLOORS_KEY);
    } catch {
      // Storage is optional for in-page automation.
    }
  }

  function readMerchantPurchaseLatch() {
    if (runtime.merchantPurchaseLatch) {
      return runtime.merchantPurchaseLatch;
    }

    const latch = readJson(localStorage, MERCHANT_PURCHASE_LATCH_KEY, null);

    runtime.merchantPurchaseLatch =
      latch && typeof latch === 'object' && MERCHANT_CHOICES.includes(latch.choice) ? latch : null;

    return runtime.merchantPurchaseLatch;
  }

  function writeMerchantPurchaseLatch(choice, form) {
    runtime.merchantPurchaseLatch = {
      choice,
      requestId: String(form?.querySelector('input[name="request_id"]')?.value || ''),
      revision: String(form?.querySelector('input[name="revision"]')?.value || ''),
    };
    writeJson(localStorage, MERCHANT_PURCHASE_LATCH_KEY, runtime.merchantPurchaseLatch);
  }

  function clearMerchantPurchaseLatch() {
    runtime.merchantPurchaseLatch = null;

    try {
      localStorage.removeItem(MERCHANT_PURCHASE_LATCH_KEY);
    } catch {
      // The in-page automation can continue even when storage is unavailable.
    }
  }

  function readCompanionFlowLatch() {
    if (runtime.companionFlowLatch) {
      return runtime.companionFlowLatch;
    }

    runtime.companionFlowLatch = normalizeCompanionFlowLatch(
      readJson(localStorage, COMPANION_FLOW_LATCH_KEY, null),
    );

    if (!runtime.companionFlowLatch) {
      try {
        if (localStorage.getItem(COMPANION_FLOW_LATCH_KEY) !== null) {
          localStorage.removeItem(COMPANION_FLOW_LATCH_KEY);
        }
      } catch {
        // Invalid persisted state is ignored when storage is unavailable.
      }
    }

    return runtime.companionFlowLatch;
  }

  function persistCompanionFlowLatch(latch) {
    runtime.companionFlowLatch = normalizeCompanionFlowLatch(latch);

    if (runtime.companionFlowLatch) {
      writeJson(localStorage, COMPANION_FLOW_LATCH_KEY, runtime.companionFlowLatch);
      return;
    }

    try {
      localStorage.removeItem(COMPANION_FLOW_LATCH_KEY);
    } catch {
      // The in-page automation can continue even when storage is unavailable.
    }
  }

  function writeCompanionFlowLatch(stage, choice, title, form) {
    persistCompanionFlowLatch({
      stage,
      choice,
      title,
      requestId: form?.querySelector('input[name="request_id"]')?.value,
      revision: form?.querySelector('input[name="revision"]')?.value,
      usedAt: Date.now(),
    });
  }

  function clearCompanionFlowLatch(stage = '') {
    const latch = readCompanionFlowLatch();

    if (stage && latch && latch.stage !== stage) {
      return;
    }

    runtime.companionFlowLatch = null;

    try {
      localStorage.removeItem(COMPANION_FLOW_LATCH_KEY);
    } catch {
      // The in-page automation can continue even when storage is unavailable.
    }
  }

  function companionLatchMatchesPanel(latch, forms) {
    return companionLatchMatchesVisit(latch, {
      requestIds: forms.map((form) => form.querySelector('input[name="request_id"]')?.value),
      revisions: forms.map((form) => form.querySelector('input[name="revision"]')?.value),
    });
  }

  function readStartFloorAttempts() {
    if (runtime.startFloorAttempts) {
      return runtime.startFloorAttempts;
    }

    runtime.startFloorAttempts = normalizeStartFloors(
      readJson(localStorage, START_FLOOR_ATTEMPTS_KEY, []),
    );

    return runtime.startFloorAttempts;
  }

  function addStartFloorAttempt(floor) {
    runtime.startFloorAttempts = normalizeStartFloors([...readStartFloorAttempts(), floor]);
    writeJson(localStorage, START_FLOOR_ATTEMPTS_KEY, runtime.startFloorAttempts);
  }

  function removeStartFloorAttempt(floor) {
    runtime.startFloorAttempts = readStartFloorAttempts().filter((candidate) => candidate !== floor);
    writeJson(localStorage, START_FLOOR_ATTEMPTS_KEY, runtime.startFloorAttempts);
  }

  function readPersistentEnabled(fallback = false) {
    try {
      return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
      return fallback;
    }
  }

  function persistEnabled(enabled) {
    runtime.enabled = !!enabled;

    try {
      if (runtime.enabled) {
        localStorage.setItem(ENABLED_KEY, '1');
      } else {
        localStorage.removeItem(ENABLED_KEY);
      }
    } catch {
      // The current tab can still run, but cannot resume after a reload.
    }

    updateRuntimeUi();
  }

  function injectStyles() {
    if (document.getElementById(`${SCRIPT_ID}-style`)) {
      return;
    }

    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      #${SCRIPT_ID} {
        position: fixed;
        z-index: 1000;
        top: 14px;
        right: 14px;
        width: min(390px, calc(100vw - 28px));
        color: var(--ink, #eeeaf3);
        background: color-mix(in srgb, var(--panel, #12131e) 96%, transparent);
        border: 1px solid var(--edge, #353747);
        border-radius: 14px;
        box-shadow: 0 14px 45px #000a;
        font: 14px/1.45 Barlow, Trebuchet MS, sans-serif;
        overflow: hidden;
        backdrop-filter: blur(10px);
      }
      #${SCRIPT_ID} * { box-sizing: border-box; }
      #${SCRIPT_ID} .tm-tower-head {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 48px;
        padding: 10px 13px;
        color: inherit;
        background: linear-gradient(120deg, #31253b, #191722);
        border: 0;
        cursor: pointer;
        text-align: left;
      }
      #${SCRIPT_ID} .tm-tower-title { display: flex; align-items: center; gap: 9px; font-weight: 750; }
      #${SCRIPT_ID} .tm-tower-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #8d8996;
        box-shadow: 0 0 0 3px #8d899622;
      }
      #${SCRIPT_ID}[data-running='1'] .tm-tower-dot { background: #9ed294; box-shadow: 0 0 0 3px #9ed29425; }
      #${SCRIPT_ID}[data-tone='warning'] .tm-tower-dot { background: #e9b66f; }
      #${SCRIPT_ID}[data-tone='error'] .tm-tower-dot { background: #e28074; }
      #${SCRIPT_ID} .tm-tower-chevron { transition: transform 0.15s ease; }
      #${SCRIPT_ID}.tm-collapsed .tm-tower-chevron { transform: rotate(-90deg); }
      #${SCRIPT_ID}.tm-collapsed .tm-tower-body { display: none; }
      #${SCRIPT_ID} .tm-tower-body {
        max-height: calc(100dvh - 80px);
        padding: 14px;
        overflow: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
      }
      #${SCRIPT_ID} .tm-tower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #${SCRIPT_ID} .tm-tower-wide { grid-column: 1 / -1; }
      #${SCRIPT_ID} label { display: block; margin: 0; color: var(--muted, #aaa8bc); font-size: 12px; }
      #${SCRIPT_ID} select,
      #${SCRIPT_ID} input[type='number'],
      #${SCRIPT_ID} textarea {
        width: 100%;
        margin-top: 5px;
        padding: 8px 9px;
        color: var(--ink, #eeeaf3);
        background: #0c0d15;
        border: 1px solid var(--edge, #353747);
        border-radius: 6px;
        font: inherit;
      }
      #${SCRIPT_ID} textarea { min-height: 112px; resize: vertical; }
      #${SCRIPT_ID} input[type='range'] { width: 100%; margin-top: 8px; accent-color: var(--ember, #c9b6ed); }
      #${SCRIPT_ID} .tm-tower-check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 5px 0;
      }
      #${SCRIPT_ID} .tm-tower-check input { flex: 0 0 auto; margin-top: 2px; accent-color: var(--ember, #c9b6ed); }
      #${SCRIPT_ID} .tm-tower-check-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 4px 9px;
        margin: 2px 0 5px 23px;
      }
      #${SCRIPT_ID} .tm-tower-check-grid[aria-disabled='true'] { opacity: 0.55; }
      #${SCRIPT_ID} .tm-tower-section {
        margin-top: 13px;
        padding-top: 13px;
        border-top: 1px solid color-mix(in srgb, var(--edge, #353747) 65%, transparent);
      }
      #${SCRIPT_ID} .tm-tower-section h3 {
        margin: 0 0 9px;
        color: var(--ink, #eeeaf3);
        font: 700 13px/1.3 Barlow, Trebuchet MS, sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #${SCRIPT_ID} .tm-tower-help { margin: 6px 0 0; color: var(--muted, #aaa8bc); font-size: 11px; line-height: 1.45; }
      #${SCRIPT_ID} .tm-tower-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
      #${SCRIPT_ID} .tm-tower-button {
        min-height: 38px;
        padding: 8px 11px;
        color: var(--ink, #eeeaf3);
        background: #29263a;
        border: 1px solid #656078;
        border-radius: 7px;
        font: 650 12px/1.2 Barlow, Trebuchet MS, sans-serif;
        cursor: pointer;
      }
      #${SCRIPT_ID} .tm-tower-button:hover { background: #3b3550; }
      #${SCRIPT_ID} .tm-tower-button:disabled { opacity: 0.5; cursor: default; }
      #${SCRIPT_ID} .tm-tower-primary { color: #181323; background: #c9b6ed; border-color: #ddd0f5; }
      #${SCRIPT_ID} .tm-tower-primary:hover { background: #e3d5ff; }
      #${SCRIPT_ID} .tm-tower-status {
        margin: 12px 0 0;
        padding: 9px 10px;
        color: #d7d1df;
        background: #0c0d1588;
        border-left: 3px solid #827b91;
        border-radius: 5px;
        font-size: 11px;
        overflow-wrap: anywhere;
      }
      #${SCRIPT_ID}[data-tone='warning'] .tm-tower-status { border-left-color: #e9b66f; }
      #${SCRIPT_ID}[data-tone='error'] .tm-tower-status { border-left-color: #e28074; }
      #${SCRIPT_ID}[data-tone='success'] .tm-tower-status { border-left-color: #9ed294; }
      #${SCRIPT_ID} [hidden] { display: none !important; }
      @media (max-width: 620px) {
        #${SCRIPT_ID} { top: 8px; right: 8px; width: calc(100vw - 16px); }
        #${SCRIPT_ID} .tm-tower-body { max-height: calc(100dvh - 68px); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${SCRIPT_ID} .tm-tower-chevron { transition: none; }
      }
    `;
    document.head.append(style);
  }

  function mountUi() {
    injectStyles();

    const root = document.createElement('aside');
    root.id = SCRIPT_ID;
    root.innerHTML = `
      <button class="tm-tower-head" type="button" aria-expanded="true">
        <span class="tm-tower-title"><span class="tm-tower-dot"></span>Demonic Tower Autopilot</span>
        <span class="tm-tower-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="tm-tower-body">
        <div class="tm-tower-grid">
          <label>Attack
            <select data-setting="attack">
              <option value="slash">Slash</option>
              <option value="magic">Magic</option>
            </select>
          </label>
          <label>Path
            <select data-setting="path">
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="random">Random</option>
            </select>
          </label>
          <label class="tm-tower-check tm-tower-wide">
            <input type="checkbox" data-setting="guardHeavy"> Block telegraphed heavy attacks
          </label>
        </div>

        <section class="tm-tower-section">
          <h3>Potions</h3>
          <label class="tm-tower-check">
            <input type="checkbox" data-setting="potionEnabled"> Automatically use HP potions
          </label>
          <label>At or below <output data-output="potionThreshold">30</output>% HP
            <input type="range" min="1" max="99" data-setting="potionThreshold">
          </label>
          <label class="tm-tower-check">
            <input type="checkbox" data-setting="statusPotionEnabled"> Automatically use Status Potions
          </label>
          <div class="tm-tower-check-grid" data-status-potion-options>
            <label class="tm-tower-check">
              <input type="checkbox" data-setting="statusPotionBurned"> Burned
            </label>
            <label class="tm-tower-check">
              <input type="checkbox" data-setting="statusPotionFrozen"> Frozen
            </label>
            <label class="tm-tower-check">
              <input type="checkbox" data-setting="statusPotionPoisoned"> Poisoned
            </label>
          </div>
          <label class="tm-tower-check">
            <input type="checkbox" data-setting="respectNoPotion"> Respect “No Potions” contracts
          </label>
          <p class="tm-tower-help">
            Low HP is healed first. At most one Status Potion is used while the status remains unchanged.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Abilities / Powers</h3>
          <label>Handle offers
            <select data-setting="powerMode">
              <option value="wishlist">Use wishlist</option>
              <option value="rarity">Choose highest rarity</option>
              <option value="skip">Skip all</option>
              <option value="pause">Wait for me</option>
            </select>
          </label>
          <label data-fallback-row>When no matching Power is offered
            <select data-setting="powerFallback">
              <option value="pause">Wait for me</option>
              <option value="skip">Skip offer</option>
              <option value="rarity">Choose the best safe Power, otherwise skip</option>
            </select>
          </label>
          <label>Wishlist – Power | desired quantity
            <textarea
              data-setting="preferredPowers"
              spellcheck="false"
              placeholder="Skullbreaker | 1\nRavaging Momentum | 2\nVampiric Edge | 3"
            ></textarea>
          </label>
          <p class="tm-tower-help">
            One Power per line; the number after “|” is its target quantity. Without a number, the game's maximum
            applies as before. Top = highest, strict priority. When all slots are full, unlisted Powers are replaced
            first, followed only by lower-priority Powers. Wishlist Powers are also protected in rarity mode.
          </p>
          <div class="tm-tower-actions">
            <button class="tm-tower-button" type="button" data-add="offers">Current offers +</button>
            <button class="tm-tower-button" type="button" data-add="owned">Owned Powers +</button>
          </div>
        </section>

        <section class="tm-tower-section">
          <h3>Quest Contracts</h3>
          <label class="tm-tower-check">
            <input type="checkbox" data-setting="questEnabled"> Automatically choose the safest, best-paying quest
          </label>
          <p class="tm-tower-help">
            The 180-coin slot-lock quest is always accepted on Floor 1 and never on later floors. No-HP-potion quests
            require HP-potion automation to be off; no-replacement quests require Power offers to be skipped.
            Slash-only quests require Slash as your configured attack. Unknown contracts are never accepted.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Companions</h3>
          <label>Recruit companion
            <select data-setting="companionFloor">
              <option value="none">None — leave every prisoner</option>
              <option value="3">Floor 3 — Razek</option>
              <option value="6">Floor 6 — Veyshi</option>
              <option value="9">Floor 9 — Ulgro</option>
            </select>
          </label>
          <label>Floor 19 decision
            <select data-setting="companionFloor19Choice">
              <option value="defend">Defend — fight to keep the companion</option>
              <option value="surrender">Surrender — receive 250 coins and lose the companion</option>
            </select>
          </label>
          <p class="tm-tower-help">
            A rescue costs one HP potion. All companions on unselected floors are left behind. After the Floor 19
            decision and any resulting fight, the following Continue action is submitted automatically. Selecting
            Surrender also authorizes its native confirmation prompt automatically.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Floor Boss Preparation</h3>
          <label>Before each tenth-floor boss
            <select data-setting="floorBossChoice">
              <option value="manual">Wait for me (manual)</option>
              <option value="healing">Destroy apparatus — extra elite, remove regeneration</option>
              <option value="armor">Sabotage armor — 60 coins, remove +20% DEF</option>
              <option value="intact">Face it intact — keep both buffs, +2 mutation energy</option>
            </select>
          </label>
          <p class="tm-tower-help">
            The selected option is used only when the exact apparatus, armor, and intact choices are offered.
            Manual mode always waits for your decision.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Start Floor Unlocks</h3>
          <div class="tm-tower-check-grid">
            <label class="tm-tower-check">
              <input type="checkbox" data-start-floor="10"> Floor 10
            </label>
            <label class="tm-tower-check">
              <input type="checkbox" data-start-floor="20"> Floor 20
            </label>
            <label class="tm-tower-check">
              <input type="checkbox" data-start-floor="30"> Floor 30
            </label>
          </div>
          <p class="tm-tower-help">
            Checked start floors are purchased when offered. With no boxes checked, the Autopilot buys no start
            floor and declines the offer.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Forgotten Sanctuary</h3>
          <label>Always heal at or below <output data-output="sanctuaryHealThreshold">50</output>% HP
            <input type="range" min="1" max="99" data-setting="sanctuaryHealThreshold">
          </label>
          <p class="tm-tower-help">
            Above the threshold, a negative status is cleansed; otherwise, missing HP is healed.
            At full HP, a status is cleansed or — without a status — the next hit is boosted.
            Burned, Frozen, and Poisoned are detected independently of potion automation.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>Travelling Abyss Merchant</h3>
          <label>Automatically buy offer
            <select data-setting="merchantChoice">
              <option value="1">1 – Potion offer</option>
              <option value="2">2 – Common offer</option>
              <option value="3">3 – Epic offer</option>
              <option value="4">4 – Legendary offer</option>
            </select>
          </label>
          <p class="tm-tower-help">
            The selected offer is purchased exactly once per merchant visit. The Autopilot then leaves the merchant.
            If the offer is unavailable, it safely waits for the current state.
          </p>
        </section>

        <section class="tm-tower-section">
          <h3>General behavior</h3>
          <div class="tm-tower-grid">
            <label class="tm-tower-wide">Unknown room decision
              <select data-setting="unknownDecision">
                <option value="pause">Wait for me (safe)</option>
                <option value="first">Choose first available option</option>
              </select>
            </label>
            <label class="tm-tower-wide">Delay between actions (ms)
              <input type="number" min="750" max="5000" step="50" data-setting="actionDelayMs">
            </label>
          </div>
          <p class="tm-tower-help">“First option” may also select a costly or disadvantageous room choice. By default, the Autopilot waits at unknown decisions.</p>
        </section>

        <div class="tm-tower-actions">
          <button class="tm-tower-button tm-tower-primary" type="button" data-action="start">Start Autopilot</button>
          <button class="tm-tower-button" type="button" data-action="stop">Stop Autopilot</button>
        </div>
        <p class="tm-tower-help">Once enabled, the Autopilot continues across enemy changes and page reloads until you stop it.</p>
        <p class="tm-tower-status" role="status" aria-live="polite"></p>
      </div>
    `;

    document.body.append(root);
    runtime.root = root;
    bindUi();
    renderSettings();
    updateRuntimeUi();
  }

  function getSettingElement(name) {
    return runtime.root?.querySelector(`[data-setting="${name}"]`) || null;
  }

  function renderSettings() {
    if (!runtime.root) {
      return;
    }

    for (const name of [
      'attack',
      'path',
      'powerMode',
      'powerFallback',
      'companionFloor',
      'companionFloor19Choice',
      'floorBossChoice',
      'merchantChoice',
      'unknownDecision',
      'actionDelayMs',
    ]) {
      const element = getSettingElement(name);

      if (element) {
        element.value = String(settings[name]);
      }
    }

    for (const name of ['guardHeavy', 'potionEnabled', 'statusPotionEnabled', 'respectNoPotion', 'questEnabled']) {
      const element = getSettingElement(name);

      if (element) {
        element.checked = settings[name];
      }
    }

    const threshold = getSettingElement('potionThreshold');
    const thresholdOutput = runtime.root.querySelector('[data-output="potionThreshold"]');
    const sanctuaryThreshold = getSettingElement('sanctuaryHealThreshold');
    const sanctuaryThresholdOutput = runtime.root.querySelector('[data-output="sanctuaryHealThreshold"]');
    const wishlist = getSettingElement('preferredPowers');

    if (threshold) {
      threshold.value = String(settings.potionThreshold);
    }

    if (thresholdOutput) {
      thresholdOutput.textContent = String(settings.potionThreshold);
    }

    if (sanctuaryThreshold) {
      sanctuaryThreshold.value = String(settings.sanctuaryHealThreshold);
    }

    if (sanctuaryThresholdOutput) {
      sanctuaryThresholdOutput.textContent = String(settings.sanctuaryHealThreshold);
    }

    if (wishlist) {
      wishlist.value = formatPowerWishlist(settings.preferredPowers);
    }

    for (const status of Object.keys(STATUS_PATTERNS)) {
      const settingName = `statusPotion${status[0].toUpperCase()}${status.slice(1)}`;
      const element = getSettingElement(settingName);

      if (element) {
        element.checked = settings.statusPotionStatuses[status];
      }
    }

    for (const floor of START_FLOORS) {
      const element = runtime.root.querySelector(`[data-start-floor="${floor}"]`);

      if (element) {
        element.checked = settings.startFloors.includes(floor);
      }
    }

    runtime.root.classList.toggle('tm-collapsed', settings.collapsed);
    runtime.root.querySelector('.tm-tower-head')?.setAttribute('aria-expanded', String(!settings.collapsed));
    updatePowerModeUi();
    updatePotionUi();
  }

  function updatePowerModeUi() {
    const fallbackRow = runtime.root?.querySelector('[data-fallback-row]');

    if (fallbackRow) {
      fallbackRow.hidden = settings.powerMode !== 'wishlist';
    }
  }

  function updatePotionUi() {
    const options = runtime.root?.querySelector('[data-status-potion-options]');

    if (!options) {
      return;
    }

    options.setAttribute('aria-disabled', String(!settings.statusPotionEnabled));
    options.querySelectorAll('input').forEach((input) => {
      input.disabled = !settings.statusPotionEnabled;
    });
  }

  function readSettingsFromUi() {
    const previousFloorBossChoice = settings.floorBossChoice;
    const next = {
      ...settings,
      attack: getSettingElement('attack')?.value,
      guardHeavy: !!getSettingElement('guardHeavy')?.checked,
      potionEnabled: !!getSettingElement('potionEnabled')?.checked,
      potionThreshold: getSettingElement('potionThreshold')?.value,
      statusPotionEnabled: !!getSettingElement('statusPotionEnabled')?.checked,
      statusPotionStatuses: {
        burned: !!getSettingElement('statusPotionBurned')?.checked,
        frozen: !!getSettingElement('statusPotionFrozen')?.checked,
        poisoned: !!getSettingElement('statusPotionPoisoned')?.checked,
      },
      respectNoPotion: !!getSettingElement('respectNoPotion')?.checked,
      questEnabled: !!getSettingElement('questEnabled')?.checked,
      companionFloor: getSettingElement('companionFloor')?.value,
      companionFloor19Choice: getSettingElement('companionFloor19Choice')?.value,
      floorBossChoice: getSettingElement('floorBossChoice')?.value,
      startFloors: START_FLOORS.filter((floor) => {
        return !!runtime.root?.querySelector(`[data-start-floor="${floor}"]`)?.checked;
      }),
      sanctuaryHealThreshold: getSettingElement('sanctuaryHealThreshold')?.value,
      merchantChoice: getSettingElement('merchantChoice')?.value,
      path: getSettingElement('path')?.value,
      powerMode: getSettingElement('powerMode')?.value,
      powerFallback: getSettingElement('powerFallback')?.value,
      preferredPowers: getSettingElement('preferredPowers')?.value,
      unknownDecision: getSettingElement('unknownDecision')?.value,
      actionDelayMs: getSettingElement('actionDelayMs')?.value,
    };

    settings = sanitizeSettings(next);
    saveSettings();

    if (settings.floorBossChoice !== previousFloorBossChoice) {
      runtime.floorBossChoiceAttempted = '';
    }

    if (!settings.statusPotionEnabled) {
      clearStatusPotionLatch();
    }

    const thresholdOutput = runtime.root?.querySelector('[data-output="potionThreshold"]');
    const sanctuaryThresholdOutput = runtime.root?.querySelector('[data-output="sanctuaryHealThreshold"]');

    if (thresholdOutput) {
      thresholdOutput.textContent = String(settings.potionThreshold);
    }

    if (sanctuaryThresholdOutput) {
      sanctuaryThresholdOutput.textContent = String(settings.sanctuaryHealThreshold);
    }

    updatePowerModeUi();
    updatePotionUi();
    scheduleStep(50);
  }

  function bindUi() {
    runtime.root.querySelector('.tm-tower-head')?.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      saveSettings();
      renderSettings();
    });

    const body = runtime.root.querySelector('.tm-tower-body');

    body?.addEventListener('input', (event) => {
      if (event.target.matches('[data-setting], [data-start-floor]')) {
        readSettingsFromUi();
      }
    });

    body?.addEventListener('change', (event) => {
      if (event.target.matches('[data-setting], [data-start-floor]')) {
        readSettingsFromUi();
        renderSettings();
      }
    });

    runtime.root.querySelector('[data-action="start"]')?.addEventListener('click', enableAutomation);
    runtime.root.querySelector('[data-action="stop"]')?.addEventListener('click', () => {
      stopAutomation('Autopilot stopped.');
    });

    runtime.root.querySelectorAll('[data-add]').forEach((button) => {
      button.addEventListener('click', () => addCurrentPowerNames(button.dataset.add));
    });
  }

  function addCurrentPowerNames(source) {
    const selector = source === 'owned' ? '.te-power-owned h4' : '.te-power-choice:not([data-locked="1"]) h3';
    const currentNames = uniquePowerNames(
      [...document.querySelectorAll(selector)].map((element) => element.textContent),
    );
    const mergedEntries = normalizePowerWishlist(settings.preferredPowers);
    const existingKeys = new Set(mergedEntries.map((entry) => normalizePowerKey(entry.name)));

    for (const name of currentNames) {
      const key = normalizePowerKey(name);

      if (!existingKeys.has(key)) {
        mergedEntries.push({ name, desiredStacks: 1 });
        existingKeys.add(key);
      }
    }

    if (mergedEntries.length === settings.preferredPowers.length) {
      setStatus(source === 'owned' ? 'No new owned Powers found.' : 'No new offers found.', 'warning');
      return;
    }

    settings.preferredPowers = mergedEntries;
    saveSettings();
    renderSettings();
    setStatus('Wishlist updated. New entries have a target quantity of 1.', 'success');
    scheduleStep(50);
  }

  function setStatus(message, tone = 'neutral') {
    runtime.status = message;
    runtime.tone = tone;
    updateRuntimeUi();
  }

  function updateRuntimeUi() {
    if (!runtime.root) {
      return;
    }

    runtime.root.dataset.running = runtime.running ? '1' : '0';
    runtime.root.dataset.enabled = runtime.enabled ? '1' : '0';
    runtime.root.dataset.tone = runtime.tone;

    const status = runtime.root.querySelector('.tm-tower-status');
    const startButton = runtime.root.querySelector('[data-action="start"]');
    const stopButton = runtime.root.querySelector('[data-action="stop"]');

    if (status) {
      status.textContent =
        runtime.status ||
        (runtime.running
          ? 'Autopilot is running.'
          : runtime.enabled
            ? 'Autopilot is enabled and waiting.'
            : 'Ready.');
    }

    if (startButton) {
      startButton.disabled = runtime.enabled;
    }

    if (stopButton) {
      stopButton.disabled = !runtime.enabled;
    }
  }

  function stopNativeAuto() {
    runtime.stoppingNative = true;

    try {
      document.getElementById('te-auto-stop')?.click();
    } finally {
      runtime.stoppingNative = false;
    }
  }

  function beginAutomation() {
    if (!runtime.enabled || !runtime.lockHeld) {
      return;
    }

    runtime.running = true;
    runtime.starting = false;
    runtime.lastFingerprint = '';
    runtime.missingRunSince = 0;
    runtime.reacquireWhenRunAppears = false;
    stopNativeAuto();
    setStatus('Autopilot is running. Checking the current Tower state.', 'success');
    // Give storage listeners in other open tabs enough time to stop their
    // native auto-runner before this owner sends its first action.
    scheduleStep(settings.actionDelayMs);
  }

  function tryStartAutomation() {
    if (!runtime.enabled || runtime.running || runtime.starting) {
      return;
    }

    // Every tab that participates in this persistent run must stop its local
    // native runner, even when another tab ultimately owns the custom lock.
    stopNativeAuto();

    if (!navigator.locks?.request) {
      persistEnabled(false);
      setStatus(
        'This browser does not support a secure tab lock. Autopilot was not started.',
        'error',
      );
      return;
    }

    runtime.starting = true;
    const generation = ++runtime.lockGeneration;
    setStatus('Autopilot enabled. Checking the exclusive Tower tab …', 'neutral');

    navigator.locks
      .request(
        LOCK_NAME,
        {
          mode: 'exclusive',
          ifAvailable: true,
        },
        async (lock) => {
          if (generation !== runtime.lockGeneration || !runtime.enabled) {
            return;
          }

          runtime.starting = false;

          if (!lock) {
            setStatus(
              'Autopilot is enabled, but is already running in another Tower tab. Reload this tab if it should take over.',
              'warning',
            );
            return;
          }

          if (!readPersistentEnabled(runtime.enabled)) {
            runtime.enabled = false;
            updateRuntimeUi();
            return;
          }

          await new Promise((resolve) => {
            runtime.releaseLock = resolve;
            runtime.lockHeld = true;
            beginAutomation();
          });

          if (generation === runtime.lockGeneration) {
            runtime.releaseLock = null;
            runtime.lockHeld = false;
            runtime.running = false;
            updateRuntimeUi();
          }
        },
      )
      .catch((error) => {
        if (generation !== runtime.lockGeneration) {
          return;
        }

        console.error('[Demonic Tower Autopilot] Could not acquire the tab lock.', error);
        runtime.starting = false;
        persistEnabled(false);
        setStatus('The exclusive Tower tab could not be reserved. Autopilot was stopped.', 'error');
      });
  }

  function enableAutomation() {
    persistEnabled(true);
    tryStartAutomation();
  }

  function stopAutomation(message, tone = 'neutral', options = {}) {
    const disable = options.disable !== false;

    if (disable) {
      persistEnabled(false);
    }

    runtime.lockGeneration += 1;
    runtime.running = false;
    runtime.starting = false;
    runtime.lockHeld = false;
    window.clearTimeout(runtime.timer);
    runtime.timer = 0;

    const releaseLock = runtime.releaseLock;
    runtime.releaseLock = null;
    releaseLock?.();

    setStatus(message, tone);
  }

  function scheduleStep(delay = 250) {
    if (!runtime.running || !runtime.lockHeld || !runtime.enabled) {
      return;
    }

    window.clearTimeout(runtime.timer);
    runtime.timer = window.setTimeout(runStep, Math.max(0, delay));
  }

  function getNativePendingRequest() {
    return readJson(localStorage, `${NATIVE_KEY}:pending`, null);
  }

  function nativeRequestIsPending() {
    return getNativePendingRequest() !== null;
  }

  function nativeTransportIsBusy() {
    return document.getElementById('te-message')?.getAttribute('aria-busy') === 'true';
  }

  function nativeRequestIsBusy() {
    return nativeTransportIsBusy() || nativeRequestIsPending();
  }

  function retryNeedsAttention() {
    const retry = document.getElementById('te-retry');

    return !!retry && !retry.hidden;
  }

  function retryPendingAction() {
    const retry = document.getElementById('te-retry');
    const pending = getNativePendingRequest();

    if (!retry || retry.hidden || !pending) {
      stopAutomation('The Tower reports an indeterminate request without safe retry data. Please check manually.', 'error');
      return;
    }

    const fingerprint = JSON.stringify(pending);

    if (fingerprint !== runtime.lastRetryFingerprint) {
      runtime.lastRetryFingerprint = fingerprint;
      runtime.retryStartedAt = Date.now();
      setStatus('The connection result was unclear. Safely retrying the stored action once …', 'warning');
      retry.click();
      scheduleStep(500);
      return;
    }

    if (nativeTransportIsBusy() || Date.now() - runtime.retryStartedAt < RETRY_TIMEOUT_MS) {
      setStatus('Waiting for the safely retried action to finish …', 'warning');
      scheduleStep(500);
      return;
    }

    stopAutomation('The safe retry was also inconclusive. Autopilot was stopped for safety.', 'error');
  }

  function getSubmitter(form) {
    return form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  }

  function formIsUsable(form) {
    if (!(form instanceof HTMLFormElement) || !form.isConnected || form.closest('[hidden], [aria-hidden="true"]')) {
      return false;
    }

    const submitter = getSubmitter(form);

    return !!submitter && !submitter.disabled;
  }

  function formFingerprint(form) {
    const entries = [...new FormData(form).entries()].map(([name, value]) => [name, String(value)]);

    return JSON.stringify(entries);
  }

  function submitDecision(decision) {
    const { form, label } = decision;

    if (!runtime.enabled || !runtime.running || !runtime.lockHeld) {
      return;
    }

    // A storage event can arrive after this turn has already been queued. Read
    // the shared flag again immediately before every irreversible action.
    if (!readPersistentEnabled(runtime.enabled)) {
      runtime.enabled = false;
      stopAutomation('Autopilot was stopped in another tab.', 'warning', { disable: false });
      return;
    }

    if (nativeRequestIsBusy()) {
      setStatus('The Tower is already processing an action …', 'neutral');
      scheduleStep(300);
      return;
    }

    if (!formIsUsable(form)) {
      setStatus('The planned action is no longer available. Waiting for the current Tower state.', 'warning');
      scheduleStep(500);
      return;
    }

    if (!form.reportValidity()) {
      stopAutomation('The planned action still contains an invalid selection. Please check manually.', 'error');
      return;
    }

    const fingerprint = formFingerprint(form);

    if (fingerprint === runtime.lastFingerprint) {
      const errorText = normalizeText(form.querySelector('.te-form-error:not([hidden])')?.textContent);
      stopAutomation(
        errorText
          ? `The Tower rejected the action: ${errorText}`
          : 'The last action was not confirmed by a new Tower state. Please check manually.',
        'error',
      );
      return;
    }

    runtime.lastFingerprint = fingerprint;
    runtime.lastActionAt = Date.now();
    setStatus(label, 'success');

    const submitter = getSubmitter(form);
    const confirmationText = decision.confirmationAuthorized
      ? form.getAttribute('data-confirm')
      : null;

    if (confirmationText !== null) {
      form.removeAttribute('data-confirm');
    }

    const restoreConfirmation = () => {
      if (confirmationText !== null && form.isConnected && !form.hasAttribute('data-confirm')) {
        form.setAttribute('data-confirm', confirmationText);
      }
    };

    try {
      decision.onSubmitting?.();

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit(submitter);
      } else {
        submitter.click();
      }
    } catch (error) {
      restoreConfirmation();
      decision.onSubmitRejected?.();
      console.error('[Demonic Tower Autopilot] Could not submit action.', error);
      stopAutomation('The action could not be submitted. Details are available in the console.', 'error');
      return;
    }

    window.queueMicrotask(restoreConfirmation);
    window.queueMicrotask(() => {
      if (runtime.running && form.isConnected && !nativeRequestIsBusy()) {
        decision.onSubmitRejected?.();
        stopAutomation('The native Tower handler did not accept the action. Please reload the page.', 'error');
      }
    });

    scheduleStep(settings.actionDelayMs);
  }

  function readPowerOffers() {
    return [...document.querySelectorAll('.te-power-choice:not([data-locked="1"])')]
      .map((article, index) => {
        const form = article.querySelector('form[data-action="power"]');
        const name = normalizeText(article.querySelector('h3')?.textContent);
        const limitElement = article.querySelector('.te-power-limit');
        const stackLimit = parseRatio(`${limitElement?.getAttribute('aria-label') || ''} ${limitElement?.textContent || ''}`);

        return {
          article,
          form,
          index,
          name,
          key: normalizePowerKey(name),
          rarity: String(article.dataset.rarity || '').toLowerCase(),
          ownedStacks: stackLimit?.current,
          maxStacks: stackLimit?.maximum,
        };
      })
      .filter((offer) => offer.name && formIsUsable(offer.form));
  }

  function parseReplacementOption(option) {
    const text = normalizeText(option.textContent);
    const isFree = option.value === '0';
    const rarityMatch = text.match(/\b(common|uncommon|rare|epic|legendary|mythic)\b/i);
    const nameMatch = text.match(/^(.+?)\s*\/\s*(?:common|uncommon|rare|epic|legendary|mythic)\b/i);
    const fallbackName = text.replace(/\s*\([^)]*remove[^)]*\).*$/i, '');
    const name = isFree ? '' : normalizeText(nameMatch?.[1] || fallbackName);

    return {
      element: option,
      value: option.value,
      disabled: option.disabled,
      isFree,
      name,
      key: normalizePowerKey(name),
      rarity: String(rarityMatch?.[1] || '').toLowerCase(),
    };
  }

  function readPowerCapacity() {
    return parseRatio(document.querySelector('.te-power-capacity')?.textContent);
  }

  function isWishlistEpicReady() {
    const wishes = normalizePowerWishlist(settings.preferredPowers);

    if (!wishes.length) {
      return false;
    }

    const owned = [...document.querySelectorAll('.te-power-owned')].map((element) => {
      const text = normalizeText(element.textContent);
      const rarity = String(element.dataset.rarity || text.match(/\b(common|uncommon|rare|epic|legendary|mythic)\b/i)?.[1] || '').toLowerCase();
      return {
        key: normalizePowerKey(element.querySelector('h4')?.textContent),
        rarity,
      };
    }).filter((power) => power.key && rarityRank(power.rarity) >= rarityRank('epic'));

    return owned.length === wishes.length && wishes.every((wish) => owned.some((power) => power.key === normalizePowerKey(wish.name)));
  }

  function planPowerChoice(offers, strategy) {
    const orderedOffers =
      strategy === 'wishlist'
        ? orderWishlistOffers(offers, settings.preferredPowers)
        : orderRarityOffers(offers);
    const capacity = readPowerCapacity();
    const hasFreeCapacity = capacity ? capacity.current < capacity.maximum : undefined;

    for (const offer of orderedOffers) {
      const select = offer.form.querySelector('select[name="replace"]');
      const options = select ? [...select.options].map(parseReplacementOption) : [];
      const placement = choosePowerPlacement(offer, options, settings.preferredPowers, {
        hasSelect: !!select,
        hasFreeCapacity,
        strategy,
      });

      if (!placement) {
        continue;
      }

      if (select && placement.value !== null) {
        select.value = placement.value;

        if (select.value !== placement.value) {
          continue;
        }

        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const rarity = offer.rarity ? ` (${offer.rarity})` : '';

      return {
        form: offer.form,
        label: `Choose ${offer.name}${rarity}: ${placement.reason}.`,
      };
    }

    return null;
  }

  function getSkipPowerDecision(reason) {
    const form = document.querySelector('form[data-action="power"][data-power="0"]');

    if (!formIsUsable(form)) {
      return {
        kind: 'wait',
        message: 'The Power offer currently cannot be selected or skipped.',
      };
    }

    return {
      kind: 'submit',
      form,
      label: reason || 'Skip the current Power offer.',
    };
  }

  function decidePower() {
    const offers = readPowerOffers();
    const offeredNames = offers.map((offer) => offer.name).join(', ') || 'no selectable Power';

    if (settings.powerMode === 'pause') {
      return {
        kind: 'wait',
        message: `Waiting for your Power selection. Offered: ${offeredNames}.`,
      };
    }

    if (settings.powerMode === 'skip') {
      return getSkipPowerDecision('Skip the Power offer as configured.');
    }

    if (settings.powerMode === 'rarity') {
      const rarityChoice = planPowerChoice(offers, 'rarity');

      return rarityChoice
        ? { kind: 'submit', ...rarityChoice }
        : getSkipPowerDecision('No Power can be safely upgraded or added; skipping the offer.');
    }

    const wishlistChoice = planPowerChoice(offers, 'wishlist');

    if (wishlistChoice) {
      return {
        kind: 'submit',
        ...wishlistChoice,
      };
    }

    if (settings.powerFallback === 'skip') {
      return getSkipPowerDecision(`No matching wishlist Power offered (${offeredNames}); skipping.`);
    }

    if (settings.powerFallback === 'rarity') {
      const rarityChoice = planPowerChoice(offers, 'rarity');

      return rarityChoice
        ? { kind: 'submit', ...rarityChoice }
        : getSkipPowerDecision('No safe replacement selection is possible; skipping the Power offer.');
    }

    return {
      kind: 'wait',
      message: `No usable wishlist Power offered. Waiting for you. Offered: ${offeredNames}.`,
    };
  }

  function decidePath() {
    const available = [...document.querySelectorAll('form[data-action="room"][data-choice]')].filter((form) => {
      return ['left', 'right'].includes(form.dataset.choice) && formIsUsable(form);
    });

    if (!available.length) {
      return {
        kind: 'wait',
        message: 'Waiting for available path options.',
      };
    }

    let selectedPath = settings.path;

    if (selectedPath === 'random') {
      selectedPath = available[Math.floor(Math.random() * available.length)].dataset.choice;
    }

    const form = available.find((candidate) => candidate.dataset.choice === selectedPath) || available[0];

    return {
      kind: 'submit',
      form,
      label: `Choose the “${form.dataset.choice || selectedPath}” path.`,
    };
  }

  function getCurrentChoicePanels() {
    const content = document.getElementById('te-content') || document;

    return [...content.querySelectorAll('section.te-panel.te-choice')].filter((panel) => {
      return !panel.closest('[hidden], [aria-hidden="true"]');
    });
  }

  function readQuestOffers(panel) {
    return [...panel.querySelectorAll('.te-cards > article')]
      .map((card) => {
        const forms = [...card.querySelectorAll('form[data-action="room"][data-choice]')];

        if (forms.length !== 1) {
          return null;
        }

        const paragraphs = [...card.querySelectorAll('p')].map((paragraph) => paragraph.textContent);
        const form = forms[0];

        return {
          ...classifyQuestOffer({
            title: card.querySelector('h3')?.textContent,
            description: paragraphs[0],
            rewardText: paragraphs.slice(1).join(' '),
            choice: form.dataset.choice,
          }),
          form,
        };
      })
      .filter(Boolean);
  }

  function findQuestPanel() {
    return getCurrentChoicePanels().find((panel) => {
      if (normalizeText(panel.querySelector('h2')?.textContent).toLowerCase() !== 'a binding offer') {
        return false;
      }

      const offers = readQuestOffers(panel);
      return (
        offers.length === 2 &&
        new Set(offers.map((offer) => offer.choice)).size === 2
      );
    });
  }

  function decideQuest(panel, state) {
    if (!settings.questEnabled) {
      return {
        kind: 'wait',
        message: 'Waiting for your Quest Contract decision.',
      };
    }

    const offers = readQuestOffers(panel);
    const capacity = readPowerCapacity();
    const choice = chooseQuestOffer({
      offers,
      context: {
        wishlistEpicReady: isWishlistEpicReady(),
        hpPotionUsedRecently: hasHpPotionBeenUsedRecently(readHpPotionFloors(), state?.dataset.floor),
        currentFloor: state?.dataset.floor,
        freePowerSlots: capacity ? capacity.maximum - capacity.current : null,
      },
    });

    if (!choice) {
      return {
        kind: 'wait',
        message: 'The Quest Contract offers are ambiguous; waiting for your decision.',
      };
    }

    const matchingOffers = offers.filter((offer) => offer.choice === choice && formIsUsable(offer.form));

    if (matchingOffers.length !== 1) {
      return {
        kind: 'wait',
        message: 'The selected Quest Contract is no longer available.',
      };
    }

    return {
      kind: 'submit',
      form: matchingOffers[0].form,
      label: `Accept Quest Contract: ${matchingOffers[0].title}.`,
    };
  }

  function normalizeSemanticText(value) {
    return normalizeText(value)
      .replace(/[_-]+/g, ' ')
      .toLowerCase();
  }

  function getFormControlText(form) {
    const datasetValues = Object.entries(form.dataset).flatMap(([name, value]) => [name, value]);
    const hiddenValues = [...form.querySelectorAll('input[name]')].flatMap((input) => {
      const name = String(input.name || '');

      return /^(?:action|choice|start[_-]?floor|starting[_-]?floor|floor|checkpoint)$/i.test(name)
        ? [name, input.value]
        : [];
    });
    const submitter = getSubmitter(form);

    return normalizeSemanticText([
      ...datasetValues,
      ...hiddenValues,
      submitter?.textContent,
      submitter?.value,
      submitter?.getAttribute('aria-label'),
      submitter?.getAttribute('title'),
    ].filter(Boolean).join(' '));
  }

  function getStartFloorFormIntent(form) {
    if (form.dataset.action === 'room') {
      if (form.dataset.choice === 'skip') {
        return 'decline';
      }

      if (form.dataset.choice === 'buy') {
        return 'buy';
      }
    }

    const controlText = getFormControlText(form);
    const declinePattern = /\b(?:skip|decline|leave|continue|later|cancel|no)\b|\bdo\s+not\b|\bdon't\b/i;
    const buyPattern = /\b(?:buy|purchase|unlock|acquire|confirm|yes)\b/i;

    if (declinePattern.test(controlText)) {
      return 'decline';
    }

    if (buyPattern.test(controlText)) {
      return 'buy';
    }

    const cardText = normalizeSemanticText(
      form.closest('article, li, .te-card, .te-choice-card')?.textContent,
    );

    return buyPattern.test(cardText) ? 'buy' : '';
  }

  function getKnownStartFloor(value) {
    const floor = Number(value);

    return START_FLOORS.includes(floor) ? floor : null;
  }

  function readCurrentStartFloor() {
    const state = document.getElementById('te-run-state');
    const directValues = [
      state?.dataset.floor,
      state?.dataset.currentFloor,
      state?.dataset.level,
      document.body.dataset.floor,
      document.body.dataset.currentFloor,
    ];

    for (const value of directValues) {
      const floor = getKnownStartFloor(value);

      if (floor) {
        return floor;
      }
    }

    const floorElement = document.querySelector('.te-floor, [data-current-floor], [data-start-floor-offer]');

    return (
      getKnownStartFloor(floorElement?.dataset.currentFloor) ||
      getKnownStartFloor(floorElement?.dataset.startFloorOffer) ||
      parseStartFloor(floorElement?.textContent)
    );
  }

  function readStartFloorFromForm(form, panelFloor) {
    const container = form.closest('[data-start-floor], [data-floor], [data-checkpoint]');
    const directValues = [
      form.dataset.startFloor,
      form.dataset.floor,
      form.dataset.checkpoint,
      container?.dataset.startFloor,
      container?.dataset.floor,
      container?.dataset.checkpoint,
    ];

    for (const value of directValues) {
      const floor = getKnownStartFloor(value);

      if (floor) {
        return floor;
      }
    }

    for (const input of form.querySelectorAll('input[name]')) {
      if (!/(?:start.*floor|floor.*start|^floor$|checkpoint)/i.test(input.name)) {
        continue;
      }

      const floor = getKnownStartFloor(input.value) || parseStartFloor(`${input.name} ${input.value}`);

      if (floor) {
        return floor;
      }
    }

    const cardText = form.closest('article, li, .te-card, .te-choice-card')?.textContent;

    return parseStartFloor(getFormControlText(form)) || parseStartFloor(cardText) || panelFloor;
  }

  function findStartFloorPanel() {
    const content = document.getElementById('te-content') || document;
    const panels = [...content.querySelectorAll('section.te-panel')].filter((panel) => {
      return !panel.closest('[hidden], [aria-hidden="true"]');
    });

    return panels.find((panel) => {
      const forms = [...panel.querySelectorAll('form')];
      const panelText = normalizeSemanticText([
        panel.querySelector('h2')?.textContent,
        panel.querySelector('.te-eyebrow')?.textContent,
        panel.textContent,
        ...Object.entries(panel.dataset).flatMap(([name, value]) => [name, value]),
      ].filter(Boolean).join(' '));
      const panelFloor = parseStartFloor(panelText) || readCurrentStartFloor();
      const hasKnownFloor =
        !!panelFloor || forms.some((form) => readStartFloorFromForm(form, null) !== null);
      const roomChoices = forms
        .filter((form) => form.dataset.action === 'room')
        .map((form) => form.dataset.choice);

      return isStartFloorDecisionContext({ panelText, hasKnownFloor, roomChoices });
    });
  }

  function decideStartFloor(panel) {
    const forms = [...panel.querySelectorAll('form')];
    const panelFloor =
      parseStartFloor(
        [panel.querySelector('h2')?.textContent, panel.querySelector('p')?.textContent]
          .filter(Boolean)
          .join(' '),
      ) || readCurrentStartFloor();
    const buyOffers = [];
    const declineForms = [];

    for (const form of forms) {
      const intent = getStartFloorFormIntent(form);

      if (intent === 'decline') {
        if (formIsUsable(form)) {
          declineForms.push(form);
        }
        continue;
      }

      if (intent !== 'buy') {
        continue;
      }

      const floor = readStartFloorFromForm(form, panelFloor);

      if (floor) {
        buyOffers.push({ floor, form, usable: formIsUsable(form) });
      }
    }

    const offeredFloors = normalizeStartFloors([
      ...buyOffers.map((offer) => offer.floor),
      ...(panelFloor ? [panelFloor] : []),
    ]);

    if (settings.startFloors.length && !offeredFloors.length) {
      return {
        kind: 'wait',
        message: 'A Start Floor offer was detected, but its floor could not be identified safely.',
      };
    }

    const plan = planStartFloorAction({
      selectedFloors: settings.startFloors,
      offeredFloors,
      buyableFloors: buyOffers.filter((offer) => offer.usable).map((offer) => offer.floor),
      attemptedFloors: readStartFloorAttempts(),
      declineAvailable: declineForms.length === 1,
    });

    if (!plan) {
      return {
        kind: 'wait',
        message: 'The configured Start Floor action is currently unavailable or ambiguous.',
      };
    }

    if (plan.kind === 'decline') {
      return {
        kind: 'submit',
        form: declineForms[0],
        label: 'Decline the Start Floor purchase.',
      };
    }

    const matchingOffers = buyOffers.filter((offer) => offer.floor === plan.floor && offer.usable);

    if (matchingOffers.length !== 1) {
      return {
        kind: 'wait',
        message: `The Floor ${plan.floor} purchase form is unavailable or ambiguous.`,
      };
    }

    return {
      kind: 'submit',
      form: matchingOffers[0].form,
      label: `Buy the Floor ${plan.floor} start-floor unlock.`,
      onSubmitting: () => addStartFloorAttempt(plan.floor),
      onSubmitRejected: () => removeStartFloorAttempt(plan.floor),
    };
  }

  function getCompanionChoiceForms(panel) {
    return [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')];
  }

  function getCompanionPanelTitle(panel) {
    return normalizeText(panel.querySelector('h2')?.textContent);
  }

  function findCompanionRecruitmentPanel() {
    const matchingPanels = getCurrentChoicePanels().filter((panel) => {
      const forms = getCompanionChoiceForms(panel);

      return !!getCompanionRecruitmentFloor({
        title: getCompanionPanelTitle(panel),
        roomChoices: forms.map((form) => form.dataset.choice),
      });
    });

    return matchingPanels.length === 1 ? matchingPanels[0] : null;
  }

  function decideCompanionRecruitment(panel) {
    const title = getCompanionPanelTitle(panel);
    const forms = getCompanionChoiceForms(panel);
    const roomChoices = forms.map((form) => form.dataset.choice);
    const floor = getCompanionRecruitmentFloor({ title, roomChoices });
    let latch = readCompanionFlowLatch();

    if (latch?.stage === 'floor19') {
      // Encountering a recruitment panel proves that any retained Floor 19
      // flow belongs to an older run.
      clearCompanionFlowLatch();
      latch = null;
    }

    if (latch?.stage === 'recruitment') {
      if (companionLatchMatchesPanel(latch, forms)) {
        return {
          kind: 'wait',
          message: `The Floor ${floor} companion choice was already submitted; waiting for the next state.`,
        };
      }

      clearCompanionFlowLatch();
    }

    const usableForms = forms.filter(formIsUsable);
    const choice = chooseCompanionRecruitmentChoice({
      configuredFloor: settings.companionFloor,
      title,
      roomChoices,
      availableChoices: usableForms.map((form) => form.dataset.choice),
    });
    const matchingForms = usableForms.filter((form) => form.dataset.choice === choice);

    if (!choice || matchingForms.length !== 1) {
      return {
        kind: 'wait',
        message: `The configured Floor ${floor} companion action is unavailable or ambiguous.`,
      };
    }

    const form = matchingForms[0];

    return {
      kind: 'submit',
      form,
      label:
        choice === 'rescue'
          ? `Rescue ${title} on Floor ${floor} for one HP potion.`
          : `Leave ${title} on Floor ${floor}.`,
      onSubmitting: () => writeCompanionFlowLatch('recruitment', choice, title, form),
      onSubmitRejected: () => clearCompanionFlowLatch('recruitment'),
    };
  }

  function findCompanionFloor19Panel() {
    const matchingPanels = getCurrentChoicePanels().filter((panel) => {
      const forms = getCompanionChoiceForms(panel);

      return isCompanionFloor19Context({
        title: getCompanionPanelTitle(panel),
        roomChoices: forms.map((form) => form.dataset.choice),
      });
    });

    return matchingPanels.length === 1 ? matchingPanels[0] : null;
  }

  function decideCompanionFloor19(panel) {
    const title = getCompanionPanelTitle(panel);
    const forms = getCompanionChoiceForms(panel);
    const roomChoices = forms.map((form) => form.dataset.choice);
    let latch = readCompanionFlowLatch();

    if (latch?.stage === 'recruitment') {
      clearCompanionFlowLatch();
      latch = null;
    }

    if (latch?.stage === 'floor19') {
      if (companionLatchMatchesPanel(latch, forms)) {
        return {
          kind: 'wait',
          message: 'The Floor 19 companion choice was already submitted; waiting for the next state.',
        };
      }

      clearCompanionFlowLatch();
    }

    const usableForms = forms.filter(formIsUsable);
    const choice = chooseCompanionFloor19Choice({
      configuredChoice: settings.companionFloor19Choice,
      title,
      roomChoices,
      availableChoices: usableForms.map((form) => form.dataset.choice),
    });
    const matchingForms = usableForms.filter((form) => form.dataset.choice === choice);

    if (!choice || matchingForms.length !== 1) {
      return {
        kind: 'wait',
        message: 'The configured Floor 19 companion action is unavailable or ambiguous.',
      };
    }

    const form = matchingForms[0];

    return {
      kind: 'submit',
      form,
      label:
        choice === 'defend'
          ? `Defend ${title} to keep the companion.`
          : `Hand over ${title} for 250 coins; the companion leaves this run.`,
      onSubmitting: () => writeCompanionFlowLatch('floor19', choice, title, form),
      onSubmitRejected: () => clearCompanionFlowLatch('floor19'),
      confirmationAuthorized: choice === 'surrender',
    };
  }

  function findCompanionContinuePanel() {
    const latch = readCompanionFlowLatch();

    if (!['floor19', 'continue'].includes(latch?.stage)) {
      return null;
    }

    const matchingPanels = getCurrentChoicePanels().filter((panel) => {
      const roomChoices = getCompanionChoiceForms(panel).map((form) => form.dataset.choice);

      return isCompanionContinueContext({
        latch,
        panelTitle: getCompanionPanelTitle(panel),
        panelText: panel.textContent,
        roomChoices,
      });
    });

    return matchingPanels.length === 1 ? matchingPanels[0] : null;
  }

  function decideCompanionContinue(panel) {
    const latch = readCompanionFlowLatch();
    const forms = getCompanionChoiceForms(panel);

    if (latch?.stage === 'continue') {
      if (!companionLatchMatchesPanel(latch, forms)) {
        clearCompanionFlowLatch();
        return {
          kind: 'wait',
          message: 'The previous companion Continue is no longer identifiable; waiting for manual review.',
        };
      }

      return {
        kind: 'wait',
        message: 'The companion Continue was already submitted; waiting for the next state.',
      };
    }

    if (latch?.stage !== 'floor19') {
      return null;
    }

    const roomChoices = forms.map((form) => form.dataset.choice);
    const usableForms = forms.filter(formIsUsable);
    const choice = chooseCompanionContinueChoice({
      latch,
      panelTitle: getCompanionPanelTitle(panel),
      panelText: panel.textContent,
      roomChoices,
      availableChoices: usableForms.map((form) => form.dataset.choice),
    });
    const matchingForms = usableForms.filter((form) => form.dataset.choice === choice);

    if (!choice || matchingForms.length !== 1) {
      return {
        kind: 'wait',
        message: 'The Continue action after the Floor 19 companion decision is unavailable or ambiguous.',
      };
    }

    return {
      kind: 'submit',
      form: matchingForms[0],
      label: 'Continue after the Floor 19 companion decision.',
      onSubmitting: () => {
        writeCompanionFlowLatch('continue', latch.choice, latch.title, matchingForms[0]);
      },
      onSubmitRejected: () => persistCompanionFlowLatch(latch),
    };
  }

  function clearStaleCompanionFlow(state, preserveContinue = false) {
    const latch = readCompanionFlowLatch();

    // Any floor below 19 proves that a new run has begun. Higher floor numbers do not
    // prove completion because the optional defense fight may be rendered as
    // the next floor before its result panel appears.
    if (
      shouldClearCompanionFlowLatch({
        latch,
        reportedFloor: state?.dataset.floor,
        preserveContinue,
      })
    ) {
      clearCompanionFlowLatch();
    }
  }

  function getFloorBossChoiceForms(panel) {
    return [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')];
  }

  function findFloorBossPanel() {
    const matchingPanels = getCurrentChoicePanels().filter((panel) => {
      const roomChoices = getFloorBossChoiceForms(panel).map((form) => form.dataset.choice);

      return isFloorBossDecisionContext({ roomChoices });
    });

    return matchingPanels.length === 1 ? matchingPanels[0] : null;
  }

  function decideFloorBoss(panel) {
    const forms = getFloorBossChoiceForms(panel);
    const roomChoices = forms.map((form) => form.dataset.choice);

    if (settings.floorBossChoice === 'manual') {
      return {
        kind: 'wait',
        message: 'Waiting for your Floor Boss preparation choice.',
      };
    }

    if (runtime.floorBossChoiceAttempted) {
      return {
        kind: 'wait',
        message: 'The configured Floor Boss preparation was already submitted; waiting for the next state.',
      };
    }

    const usableForms = forms.filter(formIsUsable);
    const choice = chooseFloorBossChoice({
      configuredChoice: settings.floorBossChoice,
      roomChoices,
      availableChoices: usableForms.map((form) => form.dataset.choice),
    });
    const matchingForms = usableForms.filter((form) => form.dataset.choice === choice);

    if (!choice || matchingForms.length !== 1) {
      return {
        kind: 'wait',
        message: 'The configured Floor Boss preparation option is unavailable or ambiguous.',
      };
    }

    return {
      kind: 'submit',
      form: matchingForms[0],
      label: FLOOR_BOSS_LABELS[choice],
      onSubmitting: () => {
        runtime.floorBossChoiceAttempted = choice;
      },
      onSubmitRejected: () => {
        runtime.floorBossChoiceAttempted = '';
      },
    };
  }

  function findSanctuaryPanel() {
    return getCurrentChoicePanels().find((panel) => {
      const title = normalizeText(panel.querySelector('h2')?.textContent).toLowerCase();

      const choices = new Set(
        [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')].map(
          (form) => form.dataset.choice,
        ),
      );

      return title === 'the forgotten sanctuary' || SANCTUARY_CHOICES.every((choice) => choices.has(choice));
    });
  }

  function decideSanctuary(state) {
    const panel = findSanctuaryPanel();
    if (!panel) {
      return null;
    }

    const hpPercent = state?.dataset.hp;
    const matchedStatus = matchStatusEffect(readPlayerStatusText(state));
    const choice = chooseSanctuaryChoice({
      hpPercent,
      healThreshold: settings.sanctuaryHealThreshold,
      hasStatus: !!matchedStatus,
    });

    if (!choice) {
      return {
        kind: 'wait',
        message: 'HP could not be read for the Forgotten Sanctuary decision.',
      };
    }

    const form = [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')].find((candidate) => {
      return candidate.dataset.choice === choice && formIsUsable(candidate);
    });

    if (!form) {
      return {
        kind: 'wait',
        message: `The required Sanctuary option “${choice}” is currently unavailable.`,
      };
    }

    const roundedHp = Math.round(Number(hpPercent));
    const labels = {
      heal: `Heal HP in the Forgotten Sanctuary at ${roundedHp}% HP.`,
      cleanse: `Cleanse ${STATUS_LABELS[matchedStatus] || matchedStatus} in the Forgotten Sanctuary.`,
      blessing: 'Choose +35% damage for the next hit in the Forgotten Sanctuary.',
    };

    return {
      kind: 'submit',
      form,
      label: labels[choice],
    };
  }

  function findMerchantPanel() {
    return getCurrentChoicePanels().find((panel) => {
      const title = normalizeText(panel.querySelector('h2')?.textContent).toLowerCase();
      const choices = new Set(
        [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')].map(
          (form) => form.dataset.choice,
        ),
      );

      return (
        title === 'the travelling abyss merchant' ||
        (choices.has('leave') && MERCHANT_CHOICES.every((choice) => choices.has(choice)))
      );
    });
  }

  function decideMerchant(panel) {
    const position = settings.merchantChoice;
    const forms = [...panel.querySelectorAll('form.te-form[data-action="room"][data-choice]')];
    const usableForms = forms.filter(formIsUsable);
    const availableChoices = usableForms.map((form) => form.dataset.choice);
    const revision = usableForms
      .map((form) => form.querySelector('input[name="revision"]')?.value)
      .find((value) => value !== undefined);
    const requestIds = usableForms
      .map((form) => form.querySelector('input[name="request_id"]')?.value)
      .filter((value) => value !== undefined);
    let purchaseLatch = readMerchantPurchaseLatch();

    if (purchaseLatch && !merchantLatchMatchesVisit(purchaseLatch, { revision, requestIds })) {
      clearMerchantPurchaseLatch();
      purchaseLatch = null;
    }

    const action = chooseMerchantAction({
      position,
      purchaseAttempted: !!purchaseLatch,
      availableChoices,
    });

    if (purchaseLatch && action !== 'leave') {
      return {
        kind: 'wait',
        message: 'The merchant purchase has already been triggered. Waiting for the option to leave.',
      };
    }

    const targetChoice = getMerchantChoice(position);
    const form = usableForms.find((candidate) => candidate.dataset.choice === action);

    if (!form) {
      return {
        kind: 'wait',
        message: `Merchant offer ${position} (${targetChoice || 'unknown'}) is currently unavailable.`,
      };
    }

    if (action === 'leave') {
      return {
        kind: 'submit',
        form,
        label: 'The merchant purchase has already been triggered; leave the merchant.',
      };
    }

    const card = form.closest('.te-cards article');
    const itemName = normalizeText(card?.querySelector('h3')?.textContent) || `Offer ${position}`;
    const price = normalizeText(card?.querySelector('p')?.textContent);

    return {
      kind: 'submit',
      form,
      label: `Buy merchant offer ${position}: ${itemName}${price ? ` (${price})` : ''}.`,
      onSubmitting: () => writeMerchantPurchaseLatch(action, form),
      onSubmitRejected: clearMerchantPurchaseLatch,
    };
  }

  function decideUnknown(pendingType) {
    if (settings.unknownDecision !== 'first') {
      return {
        kind: 'wait',
        message: `Waiting for your decision for “${pendingType}”.`,
      };
    }

    const excludedActions = new Set(['attack', 'power', 'room', 'use_item']);
    const forms = [...document.querySelectorAll('.te-choice form.te-form')].filter((form) => {
      return formIsUsable(form) && !excludedActions.has(form.dataset.action);
    });
    const form = forms[0];

    if (!form) {
      return {
        kind: 'wait',
        message: `No safe form option found for “${pendingType}”; waiting for you.`,
      };
    }

    const buttonText = normalizeText(getSubmitter(form)?.textContent || getSubmitter(form)?.value);

    return {
      kind: 'submit',
      form,
      label: `Choose the first option for “${pendingType}”${buttonText ? `: ${buttonText}` : ''}.`,
    };
  }

  function findAttackForm(attack) {
    return [...document.querySelectorAll('form[data-action="attack"]')].find((form) => {
      return form.querySelector('input[name="attack"]')?.value === attack && formIsUsable(form);
    });
  }

  function readPlayerStatusText(state) {
    const stateCandidates = [
      state?.dataset.status,
      state?.dataset.playerStatus,
    ].filter(Boolean);
    const statusElement = document.getElementById('playerStatusText');
    const towerStatusElement = document.querySelector('.te-player-status, [data-player-status-text]');
    const playerStatusSummaries = [
      ...document.querySelectorAll('.te-player-stats .te-status-list .te-status > summary'),
    ];
    const fallbackCandidates = [
      statusElement?.textContent,
      towerStatusElement?.dataset.playerStatusText,
      towerStatusElement?.textContent,
      ...playerStatusSummaries.map((summary) => summary.textContent),
    ];

    return normalizeText([...stateCandidates, ...fallbackCandidates].filter(Boolean).join(' '));
  }

  function findStatusPotionForm() {
    return [...document.querySelectorAll('form[data-action="use_item"]')].find((form) => {
      if (!formIsUsable(form)) {
        return false;
      }

      const itemContainer = form.closest('.item, .te-item, .te-consumable, article, li');
      const namedElement = form.querySelector('[data-item-name]') || itemContainer?.querySelector('[data-item-name]');
      const titleElement =
        form.querySelector('.item-title, .te-item-title, h3, h4') ||
        itemContainer?.querySelector('.item-title, .te-item-title, h3, h4');
      const candidates = [
        form.dataset.itemName,
        form.dataset.item,
        form.querySelector('input[name="item_name"]')?.value,
        namedElement?.dataset.itemName,
        titleElement?.textContent,
      ];

      if (candidates.some(isStatusPotionName)) {
        return true;
      }

      const submitLabel = normalizeText(getSubmitter(form)?.textContent);

      return (
        isStatusPotionName(submitLabel) ||
        /^(?:use|drink)(?:\s+(?:a|one))?\s+status potion$/i.test(submitLabel)
      );
    });
  }

  function decideBattle(state) {
    const hpPercent = Number(state.dataset.hp);
    const potionWanted =
      settings.potionEnabled && Number.isFinite(hpPercent) && hpPercent <= settings.potionThreshold;
    const contractBlocksPotion = settings.respectNoPotion && state.dataset.noPotion === '1';
    const matchedStatus = settings.statusPotionEnabled
      ? matchStatusEffect(readPlayerStatusText(state), settings.statusPotionStatuses)
      : '';
    const previousStatusPotionLatch = readStatusPotionLatch();

    if (!matchedStatus || (previousStatusPotionLatch && previousStatusPotionLatch.status !== matchedStatus)) {
      clearStatusPotionLatch();
    }

    if (potionWanted && !contractBlocksPotion) {
      const potionForm = [...document.querySelectorAll('form[data-action="use_item"][data-heal="1"]')].find(formIsUsable);

      if (potionForm) {
        return {
          kind: 'submit',
          form: potionForm,
          label: `Use an HP potion at ${hpPercent}% HP.`,
          onSubmitting: () => recordHpPotionUse(state),
          onSubmitRejected: () => forgetHpPotionUse(state),
        };
      }
    }

    let statusPotionMissing = false;

    if (matchedStatus && !contractBlocksPotion) {
      const statusPotionLatch = readStatusPotionLatch();

      if (statusPotionLatch?.status === matchedStatus) {
        return {
          kind: 'wait',
          message:
            `A Status Potion has already been used for ${STATUS_LABELS[matchedStatus]}. ` +
            'Waiting for the status to change so no additional potions are consumed.',
        };
      }

      const statusPotionForm = findStatusPotionForm();

      if (statusPotionForm) {
        return {
          kind: 'submit',
          form: statusPotionForm,
          label: `Use a Status Potion against ${STATUS_LABELS[matchedStatus]}.`,
          onSubmitting: () => writeStatusPotionLatch(matchedStatus),
          onSubmitRejected: clearStatusPotionLatch,
        };
      }

      statusPotionMissing = true;
    }

    const shouldGuard = settings.guardHeavy && state.dataset.heavy === '1' && state.dataset.guardReady === '1';
    const attack = shouldGuard ? 'guard' : settings.attack;
    const form = findAttackForm(attack);

    if (!form) {
      return {
        kind: 'wait',
        message: `The “${attack}” action is currently unavailable.`,
      };
    }

    const potionNote =
      (potionWanted || matchedStatus) && contractBlocksPotion
        ? ' The active “No Potions” contract is being respected.'
        : statusPotionMissing
          ? ` No usable Status Potion against ${STATUS_LABELS[matchedStatus]} was found.`
          : '';

    return {
      kind: 'submit',
      form,
      label: `${shouldGuard ? 'Block the telegraphed heavy attack' : `Attack with ${settings.attack}`}.${potionNote}`,
    };
  }

  function decideNextAction(state) {
    const startFloorPanel = findStartFloorPanel();
    if (startFloorPanel) {
      clearCompanionFlowLatch();
      clearHpPotionFloors();
      return decideStartFloor(startFloorPanel);
    }

    const merchantPanel = findMerchantPanel();
    if (merchantPanel) {
      return decideMerchant(merchantPanel);
    }

    clearMerchantPurchaseLatch();

    const companionRecruitmentPanel = findCompanionRecruitmentPanel();
    if (companionRecruitmentPanel) {
      return decideCompanionRecruitment(companionRecruitmentPanel);
    }

    const companionFloor19Panel = findCompanionFloor19Panel();
    if (companionFloor19Panel) {
      return decideCompanionFloor19(companionFloor19Panel);
    }

    clearStaleCompanionFlow(state, true);

    const companionContinuePanel = findCompanionContinuePanel();
    if (companionContinuePanel) {
      return decideCompanionContinue(companionContinuePanel);
    }

    clearStaleCompanionFlow(state);

    const questPanel = findQuestPanel();
    if (questPanel) {
      return decideQuest(questPanel, state);
    }

    const floorBossPanel = findFloorBossPanel();
    if (!floorBossPanel) {
      runtime.floorBossChoiceAttempted = '';
    }

    const sanctuaryDecision = decideSanctuary(state);
    if (sanctuaryDecision) {
      return sanctuaryDecision;
    }

    if (floorBossPanel) {
      return decideFloorBoss(floorBossPanel);
    }

    const pendingType = String(state.dataset.pending || '');

    if (pendingType === 'power') {
      return decidePower();
    }

    if (pendingType === 'paths') {
      return decidePath();
    }

    if (pendingType) {
      return decideUnknown(pendingType);
    }

    return decideBattle(state);
  }

  function runStep() {
    runtime.timer = 0;

    if (!runtime.enabled || !runtime.running || !runtime.lockHeld) {
      return;
    }

    if (retryNeedsAttention()) {
      retryPendingAction();
      return;
    }

    if (nativeRequestIsBusy()) {
      setStatus('The Tower is processing the last action …', 'neutral');
      scheduleStep(300);
      return;
    }

    const state = document.getElementById('te-run-state');

    if (!state) {
      const startFloorPanel = findStartFloorPanel();
      const companionRecruitmentPanel = startFloorPanel ? null : findCompanionRecruitmentPanel();
      const companionFloor19Panel =
        startFloorPanel || companionRecruitmentPanel ? null : findCompanionFloor19Panel();

      if (startFloorPanel) {
        clearCompanionFlowLatch();
        clearHpPotionFloors();
      } else if (!companionRecruitmentPanel && !companionFloor19Panel) {
        clearStaleCompanionFlow(null, true);
      }

      const companionContinuePanel =
        startFloorPanel || companionRecruitmentPanel || companionFloor19Panel
          ? null
          : findCompanionContinuePanel();
      const questPanel =
        startFloorPanel || companionRecruitmentPanel || companionFloor19Panel || companionContinuePanel
          ? null
          : findQuestPanel();
      const floorBossPanel =
        startFloorPanel || companionRecruitmentPanel || companionFloor19Panel || companionContinuePanel || questPanel
          ? null
          : findFloorBossPanel();

      if (!floorBossPanel) {
        runtime.floorBossChoiceAttempted = '';
      }

      let standaloneDecision = null;

      if (startFloorPanel) {
        standaloneDecision = decideStartFloor(startFloorPanel);
      } else if (companionRecruitmentPanel) {
        standaloneDecision = decideCompanionRecruitment(companionRecruitmentPanel);
      } else if (companionFloor19Panel) {
        standaloneDecision = decideCompanionFloor19(companionFloor19Panel);
      } else if (companionContinuePanel) {
        standaloneDecision = decideCompanionContinue(companionContinuePanel);
      } else if (questPanel) {
        standaloneDecision = decideQuest(questPanel, null);
      } else if (floorBossPanel) {
        standaloneDecision = decideFloorBoss(floorBossPanel);
      }

      if (standaloneDecision) {
        runtime.missingRunSince = 0;
        const remainingDelay = settings.actionDelayMs - (Date.now() - runtime.lastActionAt);

        if (remainingDelay > 0) {
          scheduleStep(remainingDelay);
          return;
        }

        if (standaloneDecision.kind === 'submit') {
          submitDecision(standaloneDecision);
          return;
        }

        setStatus(standaloneDecision.message || 'Waiting for the current Tower decision.', 'warning');
        scheduleStep(850);
        return;
      }

      clearStaleCompanionFlow(null);

      runtime.missingRunSince ||= Date.now();

      if (Date.now() - runtime.missingRunSince >= MISSING_RUN_GRACE_MS) {
        runtime.reacquireWhenRunAppears = true;
        stopAutomation('No active Tower run found. Autopilot is waiting for a new run.', 'warning', {
          disable: false,
        });
        return;
      }

      setStatus('Autopilot enabled. Waiting for an active Tower run …', 'warning');
      scheduleStep(1000);
      return;
    }

    runtime.missingRunSince = 0;

    if (!nativeRequestIsPending()) {
      runtime.lastRetryFingerprint = '';
      runtime.retryStartedAt = 0;
    }

    const remainingDelay = settings.actionDelayMs - (Date.now() - runtime.lastActionAt);

    if (remainingDelay > 0) {
      scheduleStep(remainingDelay);
      return;
    }

    const decision = decideNextAction(state);

    if (decision.kind === 'submit') {
      submitDecision(decision);
      return;
    }

    setStatus(decision.message || 'Waiting for the next Tower state.', 'warning');
    scheduleStep(850);
  }

  function observeTowerContent() {
    const content = document.getElementById('te-content');

    if (!content) {
      return;
    }

    runtime.observer = new MutationObserver(() => {
      if (
        runtime.enabled &&
        !runtime.running &&
        !runtime.starting &&
        runtime.reacquireWhenRunAppears &&
        (document.getElementById('te-run-state') ||
          findStartFloorPanel() ||
          findCompanionRecruitmentPanel() ||
          findCompanionFloor19Panel() ||
          findCompanionContinuePanel() ||
          findFloorBossPanel())
      ) {
        tryStartAutomation();
        return;
      }

      scheduleStep(80);
    });
    runtime.observer.observe(content, {
      childList: true,
      subtree: true,
    });
  }

  mountUi();
  observeTowerContent();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && runtime.running) {
      scheduleStep(50);
    }
  });

  // The page's built-in runner and this runner must never own the next action
  // at the same time. Clicking the native Start button explicitly hands control
  // back to the native runner; starting this Autopilot already stops it above.
  document.addEventListener(
    'click',
    (event) => {
      const nativeStart = event.target.closest?.('#te-auto-start');
      const nativeStop = event.target.closest?.('#te-auto-stop');

      if (runtime.enabled && nativeStart) {
        stopAutomation('Native Auto-Battle started; the Autopilot was stopped.', 'warning');
      } else if (runtime.enabled && nativeStop && !runtime.stoppingNative) {
        stopAutomation('Autopilot stopped via the native Stop button.', 'warning');
      }
    },
    true,
  );

  window.addEventListener('pagehide', (event) => {
    stopAutomation('Tower page left; tab lock released.', 'neutral', { disable: false });

    if (!event.persisted) {
      runtime.observer?.disconnect();
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) {
      return;
    }

    runtime.enabled = readPersistentEnabled(runtime.enabled);
    updateRuntimeUi();

    if (runtime.enabled) {
      setStatus('Refreshing the Tower state after returning …', 'neutral');
      window.location.reload();
    } else {
      setStatus('Ready. Enable once; the Autopilot will then continue on its own.');
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === START_FLOOR_ATTEMPTS_KEY) {
      try {
        const attempts = event.newValue === null ? [] : JSON.parse(event.newValue);
        runtime.startFloorAttempts = normalizeStartFloors(attempts);
      } catch {
        runtime.startFloorAttempts = [];
      }

      return;
    }

    if (event.key === STATUS_POTION_LATCH_KEY) {
      try {
        const latch = event.newValue === null ? null : JSON.parse(event.newValue);
        runtime.statusPotionLatch =
          latch && typeof latch === 'object' && typeof latch.status === 'string' ? latch : null;
      } catch {
        runtime.statusPotionLatch = null;
      }

      return;
    }

    if (event.key === MERCHANT_PURCHASE_LATCH_KEY) {
      try {
        const latch = event.newValue === null ? null : JSON.parse(event.newValue);
        runtime.merchantPurchaseLatch =
          latch && typeof latch === 'object' && MERCHANT_CHOICES.includes(latch.choice) ? latch : null;
      } catch {
        runtime.merchantPurchaseLatch = null;
      }

      return;
    }

    if (event.key === COMPANION_FLOW_LATCH_KEY) {
      try {
        const latch = event.newValue === null ? null : JSON.parse(event.newValue);
        runtime.companionFlowLatch = normalizeCompanionFlowLatch(latch);
      } catch {
        runtime.companionFlowLatch = null;
      }

      return;
    }

    if (event.key !== ENABLED_KEY) {
      return;
    }

    const enabled = event.newValue === '1';

    if (!enabled) {
      runtime.enabled = false;
      stopAutomation('Autopilot was stopped in another tab.', 'warning', { disable: false });
      return;
    }

    runtime.enabled = true;
    updateRuntimeUi();
    stopNativeAuto();
    setStatus('Autopilot was enabled in another tab. This tab will remain on standby.', 'neutral');
  });

  if (runtime.enabled) {
    setStatus('Automatically resuming the saved Autopilot state …', 'success');
    tryStartAutomation();
  } else {
    setStatus('Ready. Enable once; the Autopilot will then continue on its own.');
  }
})();
