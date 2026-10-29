'use strict';

const { sleep } = require('./time');

const RATE_LIMIT_STATUSES = new Set([429, 503]);
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;
const BACKOFF_BASE_MS = 800;
const BACKOFF_MAX_MS = 20_000;

// Retry-After is either a number of seconds or an HTTP date.
function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function computeBackoffMs(attempt, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toFormBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    body.append(key, String(value));
  }
  return body.toString();
}

// POSTs url-encoded form data like the game's own AJAX calls and waits out
// rate limits (429/503) using Retry-After or exponential backoff.
async function postForm(url, params, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    maxRetries = DEFAULT_MAX_RETRIES,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    headers = {},
    onRateLimit = null,
  } = options;

  const body = toFormBody(params);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        ...headers,
      },
      body,
    });
    const text = await response.text();

    if (RATE_LIMIT_STATUSES.has(response.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(response.headers?.get?.('Retry-After'));
      const waitMs = Math.min(maxRetryAfterMs, retryAfter ?? computeBackoffMs(attempt));
      onRateLimit?.({ attempt, waitMs, status: response.status });
      await sleepImpl(waitMs);
      continue;
    }

    return {
      ok: response.ok,
      status: response.status,
      text,
      json: tryParseJson(text),
    };
  }
}

async function fetchDocument(url, options = {}) {
  const { fetchImpl = globalThis.fetch, DOMParserImpl = globalThis.DOMParser } = options;
  const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store' });
  const text = await response.text();
  return new DOMParserImpl().parseFromString(text, 'text/html');
}

module.exports = {
  RATE_LIMIT_STATUSES,
  computeBackoffMs,
  fetchDocument,
  parseRetryAfter,
  postForm,
  toFormBody,
  tryParseJson,
};
