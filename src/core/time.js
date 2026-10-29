'use strict';

const { finiteTimestamp } = require('./numbers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function formatCountdown(targetAt, now = Date.now()) {
  const remainingMs = Math.max(0, finiteTimestamp(targetAt, now) - now);
  if (remainingMs <= 0) return 'Due now';
  return `In ${formatDuration(remainingMs)}`;
}

// Parses "01:59:55" or "04:20" into milliseconds.
function parseClockDuration(text) {
  const match = String(text ?? '').match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
}

module.exports = {
  formatCountdown,
  formatDuration,
  parseClockDuration,
  sleep,
};
