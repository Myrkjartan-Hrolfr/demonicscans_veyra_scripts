'use strict';

const { injectStyle, textOf } = require('./dom');

const ROOT_ID = 'veyra-pet-food-leveler';
const STYLE_ID = `${ROOT_ID}-style`;
const MAX_LEVEL = 120;
const ASCENSIONS = Object.freeze({ 80: 1, 90: 2, 100: 4, 110: 8 });

const CSS = `
  #${ROOT_ID} { background:#111522; border:1px solid #3b4264; border-radius:10px; margin-bottom:12px; padding:12px; }
  #${ROOT_ID}, #${ROOT_ID} * { box-sizing:border-box; }
  #${ROOT_ID} .pfl-title { font-size:14px; font-weight:800; margin-bottom:5px; }
  #${ROOT_ID} .pfl-help, #${ROOT_ID} .pfl-status { color:#cfd3ef; font-size:12px; line-height:1.45; }
  #${ROOT_ID} .pfl-controls { align-items:center; display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  #${ROOT_ID} label { font-size:12px; font-weight:700; }
  #${ROOT_ID} input { background:#090c15; border:1px solid #4a5279; border-radius:7px; color:#fff; font:inherit; padding:7px; text-align:center; width:76px; }
  #${ROOT_ID} button { background:#5b43a5; border:1px solid #9277e8; border-radius:8px; color:#fff; cursor:pointer; font:inherit; font-weight:800; padding:7px 12px; }
  #${ROOT_ID} button:disabled { cursor:not-allowed; opacity:.45; }
  #${ROOT_ID} .pfl-status { background:#0b0e18; border-radius:7px; margin-top:9px; min-height:32px; padding:7px 9px; }
`;

function integer(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function expForLevel(level) {
  return Math.round(100 + Math.pow(2.5 * (Math.max(1, integer(level, 1)) + 1), 2));
}

function expToTarget(currentLevel, currentExp, targetLevel) {
  const current = Math.max(1, integer(currentLevel, 1));
  const target = Math.min(MAX_LEVEL, Math.max(current, integer(targetLevel, current)));
  if (target <= current) return 0;
  let needed = -Math.max(0, integer(currentExp));
  for (let level = current; level < target; level += 1) needed += expForLevel(level);
  return Math.max(0, needed);
}

function ascensionsToTarget(currentLevel, targetLevel) {
  const current = Math.max(1, integer(currentLevel, 1));
  const target = Math.min(MAX_LEVEL, Math.max(current, integer(targetLevel, current)));
  return Object.entries(ASCENSIONS)
    .map(([level, fruits]) => ({ level: integer(level), fruits }))
    .filter((step) => current <= step.level && target > step.level);
}

function gcd(left, right) {
  let a = Math.abs(integer(left));
  let b = Math.abs(integer(right));
  while (b) [a, b] = [b, a % b];
  return a;
}

function optimalFoodPlan(foods, neededExp) {
  const available = (foods || []).map((food) => ({
    id: integer(food?.id),
    exp: Math.max(0, integer(food?.exp)),
    count: Math.max(0, integer(food?.count)),
    name: String(food?.name || `Food ${food?.id || ''}`),
  })).filter((food) => food.id > 0 && food.exp > 0 && food.count > 0);
  const needed = Math.max(0, integer(neededExp));
  if (!available.length || needed === 0) return { items: [], totalExp: 0, waste: 0, reached: needed === 0 };

  const totalAvailable = available.reduce((sum, food) => sum + food.exp * food.count, 0);
  if (totalAvailable < needed) {
    return {
      items: available.map((food) => ({ ...food, quantity: food.count })),
      totalExp: totalAvailable,
      waste: 0,
      reached: false,
    };
  }

  const divisor = available.reduce((value, food) => gcd(value, food.exp), 0) || 1;
  const target = Math.ceil(needed / divisor);
  const scaled = available.map((food) => ({ ...food, unit: food.exp / divisor }));
  const cap = target + Math.max(...scaled.map((food) => food.unit)) - 1;
  const groups = [];
  scaled.forEach((food, foodIndex) => {
    let remaining = food.count;
    let size = 1;
    while (remaining > 0) {
      const quantity = Math.min(size, remaining);
      groups.push({ foodIndex, quantity, value: food.unit * quantity });
      remaining -= quantity;
      size *= 2;
    }
  });

  let states = new Map([[0, null]]);
  for (const group of groups) {
    const next = new Map(states);
    for (const [sum, node] of states) {
      const newSum = sum + group.value;
      if (newSum <= cap && !next.has(newSum)) next.set(newSum, { previous: node, group });
    }
    states = next;
  }

  let best = null;
  for (const sum of states.keys()) {
    if (sum >= target && (best === null || sum < best)) best = sum;
  }
  if (best === null) best = Math.max(...states.keys());
  const quantities = Array(available.length).fill(0);
  let node = states.get(best);
  while (node) {
    quantities[node.group.foodIndex] += node.group.quantity;
    node = node.previous;
  }
  const items = available.map((food, index) => ({ ...food, quantity: quantities[index] })).filter((food) => food.quantity > 0);
  const totalExp = items.reduce((sum, food) => sum + food.exp * food.quantity, 0);
  return { items, totalExp, waste: Math.max(0, totalExp - needed), reached: totalExp >= needed };
}

function parseFoods(doc) {
  return [...(doc?.querySelectorAll?.('#petFoodList .card[data-item-id]') || [])].map((card) => {
    const expMatch = textOf(card).match(/\+\s*([\d,.]+)\s*EXP/i);
    return {
      id: integer(card.dataset?.itemId),
      name: textOf(card.querySelector?.('[style*="font-weight:600"]')) || `Pet Food ${card.dataset?.itemId || ''}`,
      exp: integer(String(expMatch?.[1] || '').replace(/[,.]/g, '')),
      count: integer(card.querySelector?.('.food-qty')?.textContent),
    };
  }).filter((food) => food.id > 0 && food.exp > 0 && food.count > 0);
}

function petState(doc, id) {
  const card = doc?.querySelector?.(`.slot-box[data-pet-inv-id="${integer(id)}"]`);
  if (!card) return null;
  return {
    level: integer(card.querySelector?.('.pet-level')?.textContent, 1),
    exp: integer(card.querySelector?.('[data-exp-current]')?.textContent),
    name: card.querySelector?.('img')?.alt || `Pet #${id}`,
  };
}

module.exports = Object.freeze({
  id: 'pet-food-leveler',
  group: 'General',
  settings: [{
    key: 'veyra:pets:smartFoodLeveler',
    label: 'Smart pet food leveler',
    type: 'checkbox',
    default: true,
    hint: 'Adds target-level feeding and chooses pet food with the least possible EXP waste.',
  }],
  enabledBy: 'veyra:pets:smartFoodLeveler',
  expForLevel,
  expToTarget,
  ascensionsToTarget,
  optimalFoodPlan,
  parseFoods,

  matches(url) {
    return /\/pets\.php$/i.test(url.pathname);
  },

  run({ doc, win, notify }) {
    const modal = doc?.getElementById?.('petFoodModal');
    const list = doc?.getElementById?.('petFoodList');
    const targetField = doc?.getElementById?.('petFoodTarget');
    if (!modal || !list || !targetField || doc.getElementById?.(ROOT_ID)) return;
    injectStyle(doc, STYLE_ID, CSS);

    const root = doc.createElement('section');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="pfl-title">Smart Level Up</div>
      <div class="pfl-help">Choose a target level. Pet food is combined to waste as little EXP as possible.</div>
      <div class="pfl-controls"><label>Target level <input class="pfl-target" type="number" min="2" max="${MAX_LEVEL}" step="1" value="${MAX_LEVEL}"></label><button type="button" class="pfl-start">Start</button></div>
      <div class="pfl-status" role="status">Ready.</div>`;
    list.parentNode.insertBefore(root, list);
    const input = root.querySelector('.pfl-target');
    const button = root.querySelector('.pfl-start');
    const status = root.querySelector('.pfl-status');

    for (const ascendButton of doc.querySelectorAll?.('.ascend-btn') || []) {
      const card = ascendButton.closest?.('.slot-box[data-pet-inv-id]');
      if (!card || card.querySelector?.('.pfl-open')) continue;
      const open = doc.createElement('button');
      open.type = 'button';
      open.className = 'btn levelup-btn pfl-open';
      open.textContent = 'Smart Level Up';
      open.addEventListener('click', () => {
        targetField.value = card.dataset.petInvId || '';
        const pet = petState(doc, targetField.value);
        if (pet) input.min = String(Math.min(MAX_LEVEL, pet.level + 1));
        modal.style.display = 'flex';
      });
      ascendButton.parentNode?.appendChild(open);
    }

    button.addEventListener('click', async () => {
      const petId = integer(targetField.value);
      const pet = petState(doc, petId);
      const foods = parseFoods(doc);
      if (!pet || !foods.length) {
        status.textContent = !pet ? 'Pet data could not be read.' : 'No pet food is available.';
        return;
      }
      const target = Math.min(MAX_LEVEL, Math.max(pet.level + 1, integer(input.value, MAX_LEVEL)));
      input.value = String(target);
      const steps = ascensionsToTarget(pet.level, target);
      const fruitTotal = steps.reduce((sum, step) => sum + step.fruits, 0);
      const stepText = steps.length ? `\nAscensions: ${steps.map((step) => `Lv. ${step.level} (${step.fruits} Forbidden Fruit)`).join(', ')}\nTotal Forbidden Fruits: ${fruitTotal}` : '';
      if (!win.confirm?.(`Automatically level ${pet.name} from level ${pet.level} toward level ${target}?${stepText}\nPet food is recalculated at every ascension cap to minimize wasted EXP.`)) return;

      button.disabled = true;
      input.disabled = true;
      try {
        let level = pet.level;
        let exp = pet.exp;
        let stoppedForFood = false;
        while (level < target) {
          const fruitCost = ASCENSIONS[level];
          if (fruitCost && target > level) {
            status.textContent = `Checking ascension at level ${level} …`;
            const infoResponse = await win.fetch(`pet_cap_info_ajax.php?pet_inv_id=${encodeURIComponent(petId)}`, { cache: 'no-store' });
            const info = await infoResponse.json().catch(() => ({}));
            if (!infoResponse.ok || info.status !== 'success') throw new Error(info.message || 'Ascension information could not be loaded.');
            const neededFruits = integer(info.required?.need_qty, fruitCost);
            const ownedFruits = integer(info.required?.user_qty);
            if (!info.can_ascend || ownedFruits < neededFruits) {
              throw new Error(`Ascension at level ${level} needs ${neededFruits} Forbidden Fruits, but only ${ownedFruits} are available.`);
            }
            status.textContent = `Ascending at level ${level} with ${neededFruits} Forbidden Fruits …`;
            const ascendResponse = await win.fetch('pet_cap_break.php', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ pet_inv_id: String(petId) }).toString(),
            });
            const ascend = await ascendResponse.json().catch(() => ({}));
            if (!ascendResponse.ok || ascend.status !== 'success') throw new Error(ascend.message || `Ascension at level ${level} failed.`);
          }

          const nextCap = Object.keys(ASCENSIONS).map(integer).find((cap) => cap > level) || MAX_LEVEL;
          const segmentTarget = Math.min(target, nextCap);
          const needed = expToTarget(level, exp, segmentTarget);
          const plan = optimalFoodPlan(foods, needed);
          if (!plan.items.length) {
            stoppedForFood = true;
            break;
          }
          for (let index = 0; index < plan.items.length; index += 1) {
            const item = plan.items[index];
            status.textContent = `Feeding ${item.quantity}× ${item.name} toward level ${segmentTarget} (${index + 1}/${plan.items.length}) …`;
            const response = await win.fetch('pet_feed.php', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ pet_inv_id: String(petId), item_id: String(item.id), qty: String(item.quantity) }).toString(),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${response.status}`);
            const used = Math.min(item.count, Math.max(0, integer(data.qty_used, item.quantity)));
            const food = foods.find((candidate) => candidate.id === item.id);
            if (food) food.count = Math.max(0, food.count - used);
            if (Number.isFinite(Number(data.level))) level = integer(data.level, level);
            if (Number.isFinite(Number(data.exp_current))) exp = integer(data.exp_current);
          }
          if (!plan.reached || level < segmentTarget) {
            stoppedForFood = true;
            break;
          }
        }
        status.textContent = level >= target
          ? `Done. ${pet.name} reached level ${target}. Reloading …`
          : `${stoppedForFood ? 'Pet food ran out' : 'Leveling stopped'} at level ${level}. Reloading …`;
        win.setTimeout(() => win.location.reload(), 350);
      } catch (error) {
        status.textContent = `Stopped: ${error.message || 'Feeding failed.'}`;
        notify?.(status.textContent, 'error');
        button.disabled = false;
        input.disabled = false;
      }
    });
  },
});
