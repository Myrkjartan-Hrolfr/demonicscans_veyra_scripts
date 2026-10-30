'use strict';

const SUFFIX_MULTIPLIERS = Object.freeze({
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
  q: 1e15,
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function compactNumberText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 32);
}

// Parses game numbers such as "3,247,818,809", "3m", "1.5b" or "2,5k".
// Returns null for anything that is not a non-negative number.
function parseGameNumber(value) {
  const text = compactNumberText(value);
  const match = text.match(/^([\d.,]+)([kmbtq])?$/);
  if (!match) return null;

  let numberText = match[1];
  const suffix = match[2];
  if (suffix) {
    if (numberText.includes('.') && numberText.includes(',')) {
      const decimal = numberText.lastIndexOf(',') > numberText.lastIndexOf('.') ? ',' : '.';
      const thousands = decimal === ',' ? '.' : ',';
      numberText = numberText.split(thousands).join('').replace(decimal, '.');
    } else {
      numberText = numberText.replace(',', '.');
    }
  } else {
    // Without a suffix the game only uses separators for thousands.
    numberText = numberText.replace(/\D/g, '');
  }
  if (!numberText) return null;

  const parsed = Number.parseFloat(numberText) * (suffix ? SUFFIX_MULTIPLIERS[suffix] : 1);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

// Damage targets are stored as the user typed them ("3b", "500m"), but only
// when they describe a positive amount.
function normalizeDamageTarget(value, fallback = '3b') {
  const isValid = (candidate) => {
    const parsed = parseGameNumber(candidate);
    return parsed !== null && parsed > 0;
  };

  const normalized = compactNumberText(value);
  if (isValid(normalized)) return normalized;
  const normalizedFallback = compactNumberText(fallback);
  return isValid(normalizedFallback) ? normalizedFallback : '3b';
}

// Additional phase damage may intentionally be zero. Keep the same compact
// input format as normal damage targets while accepting that one extra value.
function normalizeAdditionalDamageTarget(value, fallback = '0') {
  const isValid = (candidate) => {
    const parsed = parseGameNumber(candidate);
    return parsed !== null && parsed >= 0;
  };

  const normalized = compactNumberText(value);
  if (isValid(normalized)) return normalized;
  const normalizedFallback = compactNumberText(fallback);
  return isValid(normalizedFallback) ? normalizedFallback : '0';
}

function formatGameNumber(value) {
  const number = finiteNumber(value, 0);
  const suffixes = Object.entries(SUFFIX_MULTIPLIERS).reverse();
  for (const [suffix, multiplier] of suffixes) {
    if (Math.abs(number) >= multiplier) {
      const scaled = Math.round((number / multiplier) * 100) / 100;
      return `${scaled}${suffix}`;
    }
  }
  return String(Math.round(number));
}

// Reads "3,775 / 12,000" style values.
function parseFraction(value) {
  const parts = String(value ?? '').split('/');
  if (parts.length !== 2) return null;
  const current = parseGameNumber(parts[0].replace(/[^\d.,kmbtq]/gi, ''));
  const max = parseGameNumber(parts[1].replace(/[^\d.,kmbtq]/gi, ''));
  if (current === null || max === null) return null;
  return { current, max };
}

module.exports = {
  SUFFIX_MULTIPLIERS,
  finiteNumber,
  finiteTimestamp,
  formatGameNumber,
  normalizeAdditionalDamageTarget,
  normalizeDamageTarget,
  parseFraction,
  parseGameNumber,
};
