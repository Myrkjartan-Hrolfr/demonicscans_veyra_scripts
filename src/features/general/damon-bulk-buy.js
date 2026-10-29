'use strict';

// From our buy_in_bulk.js: Damon's shop on olympus.php only sells up to 99
// per purchase. Offers without a weekly limit get a "Bulk Buy" button that
// buys up to 10,000 in batches of 99 (400 ms apart). Above 99 it asks first;
// clicking the running button stops after the current batch.

const { injectStyle, debounce, textOf } = require('./dom');
const { sleep } = require('../../core/time');

const STYLE_ID = 'veyra-automation-damon-bulk-buy';
const MAX_TOTAL = 10_000;
const BATCH_SIZE = 99;
const DELAY_MS = 400;
const BUTTON_LABEL = 'Bulk Buy';

const CSS = `
  .veyra-damon-bulk-btn { min-height: 36px; margin-left: 8px; touch-action: manipulation; }
`;

const formatCount = (value) => Number(value || 0).toLocaleString('en-US');

// Whole number between 1 and max, or null for empty/invalid input.
function clampBulkQuantity(value, max = MAX_TOTAL) {
  const number = Number.parseInt(String(value ?? '').replace(/[,\s]/g, ''), 10);
  if (!Number.isFinite(number)) return null;
  return Math.max(1, Math.min(max, number));
}

// 250 -> [99, 99, 52]
function planBatches(total, batchSize = BATCH_SIZE) {
  const batches = [];
  let remaining = Math.max(0, Math.floor(Number(total) || 0));
  const size = Math.max(1, Math.floor(batchSize));
  while (remaining > 0) {
    const batch = Math.min(size, remaining);
    batches.push(batch);
    remaining -= batch;
  }
  return batches;
}

function needsConfirmation(quantity) {
  return quantity > BATCH_SIZE;
}

function isUnlimitedOffer(metaText) {
  return /no weekly limit/i.test(String(metaText ?? ''));
}

function setStatus(ctx, message) {
  const status = ctx.doc.getElementById('damonShopStatus');
  if (status) status.textContent = message;
  ctx.log(message);
}

async function purchase(ctx, offer, quantity) {
  const response = await ctx.postForm(
    '/olympus_damon_buy.php',
    { offer, qty: quantity },
    { headers: { Accept: 'application/json' } },
  );
  const data = response.json;
  if (!response.ok && !data) throw new Error(`HTTP ${response.status}`);
  if (data?.status !== 'success') throw new Error(data?.message || `Server answered "${data?.status}"`);
  return data;
}

async function bulkBuy(ctx, card, input, button) {
  if (button.dataset.running === '1') {
    button.dataset.stop = '1';
    button.textContent = 'Stopping…';
    return;
  }

  const offer = card.dataset.offer;
  const requested = clampBulkQuantity(input.value);
  if (!offer || requested === null) return;
  input.value = String(requested);
  const itemName = textOf(card.querySelector('.damon-item-name')) || offer;
  const batches = planBatches(requested);

  if (
    needsConfirmation(requested) &&
    !ctx.win.confirm(
      `Buy ${formatCount(requested)} × ${itemName}?\n\n` +
        `The purchase is split into ${batches.length} batches of up to ${BATCH_SIZE}.`,
    )
  ) {
    return;
  }

  button.dataset.running = '1';
  button.dataset.stop = '0';
  input.disabled = true;
  let purchased = 0;
  let stopped = false;

  try {
    for (const [index, batch] of batches.entries()) {
      if (index > 0) await sleep(DELAY_MS);
      if (button.dataset.stop === '1') {
        stopped = true;
        setStatus(ctx, `Stopped: bought ${formatCount(purchased)} of ${formatCount(requested)}.`);
        break;
      }
      button.textContent = `${formatCount(purchased)} / ${formatCount(requested)}`;
      setStatus(ctx, `${itemName}: batch ${index + 1}/${batches.length} (${batch}) …`);

      const data = await purchase(ctx, offer, batch);
      purchased += batch;
      if (typeof data.gold === 'number') {
        const gold = ctx.doc.getElementById('damonShopGold');
        if (gold) gold.textContent = formatCount(data.gold);
      }
      setStatus(ctx, `${itemName}: bought ${formatCount(purchased)} / ${formatCount(requested)}.`);
    }

    if (!stopped) {
      button.textContent = '✓ Done';
      setStatus(ctx, `✓ Bought ${formatCount(requested)} × ${itemName}.`);
      setTimeout(() => (button.textContent = BUTTON_LABEL), 2_000);
    } else {
      button.textContent = BUTTON_LABEL;
    }
  } catch (error) {
    ctx.warn('Bulk buy failed.', error);
    button.textContent = 'Error';
    setStatus(ctx, `Purchase stopped after ${formatCount(purchased)}: ${error.message}`);
    setTimeout(() => (button.textContent = BUTTON_LABEL), 2_500);
  } finally {
    button.dataset.running = '0';
    button.dataset.stop = '0';
    input.disabled = false;
  }
}

function enhanceCard(ctx, card) {
  if (card.dataset.veyraBulkBuy === '1') return;
  if (!isUnlimitedOffer(card.querySelector('.damon-item-meta')?.textContent)) return;
  const input = card.querySelector('.damon-qty');
  const buyRow = card.querySelector('.damon-buy-row');
  if (!input || !buyRow) return;
  card.dataset.veyraBulkBuy = '1';
  input.max = String(MAX_TOTAL);

  const button = ctx.doc.createElement('button');
  button.type = 'button';
  button.className = 'btn primary veyra-damon-bulk-btn';
  button.textContent = BUTTON_LABEL;
  button.addEventListener('click', () => bulkBuy(ctx, card, input, button));
  buyRow.appendChild(button);
}

module.exports = Object.freeze({
  id: 'damon-bulk-buy',
  group: 'Shops',
  settings: [
    {
      key: 'veyra:shops:damonBulkBuy',
      label: "Damon's shop bulk buy",
      type: 'checkbox',
      default: true,
      hint: 'Buy up to 10,000 of an unlimited offer in batches of 99.',
    },
  ],
  enabledBy: 'veyra:shops:damonBulkBuy',
  clampBulkQuantity,
  isUnlimitedOffer,
  needsConfirmation,
  planBatches,

  matches(url) {
    return /\/olympus\.php$/i.test(url.pathname);
  },

  run(ctx) {
    const { doc } = ctx;
    if (!doc.body) return;
    injectStyle(doc, STYLE_ID, CSS);

    // Damon's cards live in #damonShopGrid; Melanippe's stable reuses the
    // card class, so only that grid is patched.
    const patch = () => {
      const grid = doc.getElementById('damonShopGrid');
      for (const card of grid?.querySelectorAll('.damon-item-card') || []) enhanceCard(ctx, card);
    };
    patch();

    // The grid is re-rendered whenever the shop opens or after a purchase.
    const grid = doc.getElementById('damonShopGrid');
    const Observer = ctx.win.MutationObserver || globalThis.MutationObserver;
    if (!Observer) return;
    new Observer(debounce(patch, 100)).observe(grid || doc.body, { childList: true, subtree: !grid });
  },
});
