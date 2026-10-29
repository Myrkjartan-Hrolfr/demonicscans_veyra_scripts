'use strict';

// Monster Auto Battle: pure text parsing helpers (no DOM access).
//
// These are kept separate from core/numbers.js on purpose: the game shows
// values inside decorated text ("💚 1,234 / 5,000 HP", "Power Slash (10)"),
// and MAB has always extracted the first number from such text. The core
// parser only accepts a bare number, so reusing it here would change
// behaviour.

const SUFFIX_FACTORS = Object.freeze({ k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 });
const MAX_RETRY_AFTER_MS = 120_000;

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
    : '—';
}

// First integer in a text; thousands separators (",", "." or spaces) are
// removed. "Stamina: 1,234" -> 1234, "-5" -> -5.
function parseInteger(value) {
  const match = String(value ?? '').match(/-?\d{1,3}(?:[.,\s]\d{3})+|-?\d+/);
  if (!match) return null;
  const number = Number(match[0].replace(/\D/g, ''));
  if (!Number.isFinite(number)) return null;
  return match[0].trim().startsWith('-') ? -number : number;
}

// Like parseInteger, but also understands abbreviations ("1.5m") and plain
// numbers coming from JSON.
function parseLooseGameNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const match = String(value ?? '').match(/(-?[\d.,]+)\s*([kKmMbBtTqQ])?/);
  if (!match) return null;
  const suffix = String(match[2] || '').toLowerCase();
  if (!suffix) return parseInteger(match[1]);
  const number = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  return Math.round(number * SUFFIX_FACTORS[suffix]);
}

function firstGameNumber(...values) {
  for (const value of values) {
    const number = parseLooseGameNumber(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

// "💚 1,234 / 5,000 HP" -> { current: 1234, maximum: 5000 }
function parseFraction(value) {
  const match = String(value ?? '').match(
    /(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)/,
  );
  if (!match) return null;
  const current = parseInteger(match[1]);
  const maximum = parseInteger(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(maximum)) return null;
  return { current, maximum };
}

// Target damage as typed by the user: "", "0", "5m", "2,5b", "5.000.000".
// Returns 0 for an empty value (unlimited) and NaN for invalid input.
function parseTarget(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!raw) return 0;
  const match = raw.match(/^([\d.,]+)([kmbtq])?$/);
  if (!match) return NaN;

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
  const result = Number(numberText) * (suffix ? SUFFIX_FACTORS[suffix] : 1);
  return Number.isFinite(result) ? result : NaN;
}

// Display form of the target input: abbreviations stay as typed, plain
// numbers get "." thousands separators (string based, no precision loss).
function formatTargetDisplay(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!raw) return '';
  if (/[kmbtq]$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Cursor position after reformatting: behind the same number of digits.
function cursorAfterFormat(original, cursor, formatted) {
  const digitsBeforeCursor = String(original).slice(0, cursor).replace(/\D/g, '').length;
  let position = 0;
  let digitsSeen = 0;
  while (position < formatted.length && digitsSeen < digitsBeforeCursor) {
    if (/\d/.test(formatted[position])) digitsSeen += 1;
    position += 1;
  }
  return position;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "⚔️ [END] Name used Skill ..." -> "Name"
function getLogEntryPlayerName(line) {
  return (
    normalizeText(line)
      .match(/^⚔️\s*(?:\[END\]\s*)?(.+?)\s+used\s+/i)?.[1]
      ?.trim() || ''
  );
}

function logEntryShowsActivePoison(line) {
  const text = normalizeText(line);
  if (
    /\b(?:poison (?:has )?(?:worn off|ended|expired)|no longer poisoned|resisted (?:the )?poison|failed to poison)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /\bpoisoned\s+the\s+enemy\b/i.test(text) ||
    /\bpoison\s+damage\b/i.test(text) ||
    /\benemy\s+(?:is|remains|was)\s+poisoned\b/i.test(text)
  );
}

// Classifies a (lower-case) server or toast message.
function classifyFeedback(text) {
  if (!text) return null;
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
  if (/cooldown|too fast|please wait|wait before|rate limit/.test(text)) return 'cooldown';
  return null;
}

function calculateExperienceGain(before, after) {
  if (!before || !after) return null;
  if (after.maximum === before.maximum && after.current >= before.current) {
    return after.current - before.current;
  }
  if (after.maximum !== before.maximum || after.current < before.current) {
    return Math.max(0, before.maximum - before.current + after.current);
  }
  return null;
}

// Retry-After in whole seconds, capped at two minutes (original MAB rule).
function retryAfterToMs(value) {
  if (!value) return null;
  const seconds = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function isRateLimited(result) {
  return (
    result.status === 429 ||
    result.feedbackType === 'cooldown' ||
    /rate limit|too fast|cooling down/.test(String(result.message || '').toLowerCase())
  );
}

// Reads a /damage.php response.
// response: { ok, status, retryAfterMs }   raw: response body text
function parseFastAttackResponse(response, raw) {
  const text = String(raw ?? '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML or plain-text responses.
  }
  if (data !== null && typeof data !== 'object') data = null;

  const message = String(data?.message ?? text ?? '');
  const lowerMessage = message.toLowerCase();
  const strongDamage = text.match(/<strong>\s*([\d,.\s]+)\s*<\/strong>/i)?.[1];
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
  const ok = !explicitFailure && (Boolean(response?.ok) || data?.status === 'success' || data?.success === true);
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
    status: response?.status ?? 0,
    retryAfterMs: response?.retryAfterMs ?? null,
    damage,
    totalDamage,
    experienceGain,
    userHpAfter,
    staminaAfter,
    manaAfter,
    monsterDead,
    poisonActive: logEntryShowsActivePoison(
      [message, data?.log, data?.attack_log, data?.attackLog, data?.result, text].filter(Boolean).join(' '),
    ),
    feedbackType: classifyFeedback(lowerMessage),
  };
}

module.exports = {
  calculateExperienceGain,
  classifyFeedback,
  cursorAfterFormat,
  firstGameNumber,
  formatNumber,
  formatTargetDisplay,
  getLogEntryPlayerName,
  isRateLimited,
  logEntryShowsActivePoison,
  normalizeText,
  parseFastAttackResponse,
  parseFraction,
  parseInteger,
  parseLooseGameNumber,
  parseTarget,
  retryAfterToMs,
};
