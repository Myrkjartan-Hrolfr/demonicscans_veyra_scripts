'use strict';

// From veyra-hud ui-improvements (Merchant "Buy {Max}" buttons): gold items
// with a purchase limit get a "Buy N" button that buys as many as the limit
// and the gold balance allow (after a confirmation).
// Changes: uses the shared postForm (rate-limit backoff), falls back to our
// own toast when the page's purchase modal is missing, and the button label
// is refreshed after a purchase.

const { injectStyle, textOf } = require('./dom');

const STYLE_ID = 'veyra-automation-merchant-buy-max';
const CSS = `
  .veyra-buy-max-btn { min-height: 36px; margin-left: 6px; touch-action: manipulation; }
  .veyra-buy-max-btn[disabled] { opacity: .5; cursor: not-allowed; }
`;

const toInt = (value) => {
  const number = Number.parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(number) ? number : 0;
};

// Returns null when the card should get no button (no limit, or at most one
// left – the normal Buy button covers that), otherwise { quantity } where
// quantity can be 0 when the player cannot afford a single one.
function planBuyMax({ price, maxQuantity, bought, gold }) {
  const unitPrice = toInt(price);
  const limit = toInt(maxQuantity);
  const remaining = limit - toInt(bought);
  if (unitPrice <= 0 || limit <= 0 || remaining <= 1) return null;
  const affordable = Math.floor(Math.max(0, toInt(gold)) / unitPrice);
  return { quantity: Math.max(0, Math.min(remaining, affordable)), remaining };
}

function readGold(doc) {
  return toInt(doc.getElementById?.('goldBalance')?.textContent);
}

function readCard(card) {
  return {
    price: card.dataset.price,
    maxQuantity: card.dataset.maxq,
    bought: card.dataset.bought,
    merchId: toInt(card.dataset.merchId),
  };
}

function showResult(ctx, message, type) {
  const modal = ctx.pageGlobal('showPurchaseModal');
  if (typeof modal === 'function') {
    try {
      modal(message, type);
      return;
    } catch {
      // fall through to our toast
    }
  }
  ctx.notify(message, type === 'success' ? 'success' : 'error');
}

function refreshButton(ctx, card, button) {
  const plan = planBuyMax({ ...readCard(card), gold: readGold(ctx.doc) });
  if (!plan) {
    button.remove();
    return null;
  }
  button.textContent = `Buy ${plan.quantity}`;
  button.disabled = plan.quantity <= 0;
  return plan;
}

async function buy(ctx, card, button) {
  const plan = refreshButton(ctx, card, button);
  if (!plan || plan.quantity <= 0) return;
  const { price, maxQuantity, bought, merchId } = readCard(card);
  const quantity = plan.quantity;
  const itemName = textOf(card.querySelector('.name')) || 'this item';
  const total = toInt(price) * quantity;
  const confirmed = ctx.win.confirm(
    `Confirm purchase\n\nBuy ${quantity} × ${itemName}\nCost: ${total.toLocaleString('en-US')} Gold`,
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const response = await ctx.postForm('merchant_buy.php', { merch_id: merchId, qty: quantity });
    const data = response.json || {};
    if (String(data.status || '').trim() !== 'success') {
      const message = String(data.message || `Purchase failed (HTTP ${response.status}).`).trim();
      showResult(ctx, message, /not enough (gold|gems)/i.test(message) ? 'warn' : 'error');
      return;
    }

    // The page's own helper updates the balance; without it we do it.
    const adjust = ctx.pageGlobal('adjustTopbarCurrency');
    let adjusted = false;
    if (typeof adjust === 'function') {
      try {
        adjust('gold', -total);
        adjusted = true;
      } catch {
        // cosmetic only
      }
    }
    const goldElement = ctx.doc.getElementById('goldBalance');
    if (!adjusted && goldElement) {
      goldElement.textContent = Math.max(0, readGold(ctx.doc) - total).toLocaleString('en-US');
    }

    const limit = toInt(maxQuantity);
    const newBought =
      typeof data.remaining === 'number' ? limit - data.remaining : Math.min(limit, toInt(bought) + quantity);
    card.dataset.bought = String(newBought);
    const infoRow = card.querySelector('.muted');
    if (infoRow) infoRow.textContent = `Bought: ${newBought} / ${limit}`;

    showResult(ctx, String(data.message || 'Purchased!').trim(), 'success');
  } catch (error) {
    ctx.warn('Purchase failed.', error);
    showResult(ctx, 'Server error. Please try again.', 'error');
  } finally {
    if (button.isConnected !== false) refreshButton(ctx, card, button);
  }
}

module.exports = Object.freeze({
  id: 'merchant-buy-max',
  group: 'Shops',
  settings: [
    {
      key: 'ui-improvements:enableBuyAllButtons',
      label: 'Merchant "Buy N" buttons',
      type: 'checkbox',
      default: true,
      hint: 'Buys as many as the limit and your gold allow, after a confirmation.',
    },
  ],
  enabledBy: 'ui-improvements:enableBuyAllButtons',
  planBuyMax,

  matches(url) {
    return /\/merchant\.php$/i.test(url.pathname);
  },

  run(ctx) {
    const { doc } = ctx;
    const gold = readGold(doc);
    let added = 0;
    for (const card of doc.querySelectorAll?.('.card') || []) {
      if (String(card.dataset?.currency || '').toLowerCase() !== 'gold') continue;
      const actions = card.querySelector('.actions');
      if (!actions?.querySelector('.buy-btn') || actions.querySelector('.veyra-buy-max-btn')) continue;
      const plan = planBuyMax({ ...readCard(card), gold });
      if (!plan) continue;

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn buy-x-btn veyra-buy-max-btn';
      button.textContent = `Buy ${plan.quantity}`;
      button.disabled = plan.quantity <= 0;
      button.addEventListener('click', () => {
        if (!button.disabled) buy(ctx, card, button);
      });
      actions.appendChild(button);
      added += 1;
    }
    if (added > 0) injectStyle(doc, STYLE_ID, CSS);
  },
});
