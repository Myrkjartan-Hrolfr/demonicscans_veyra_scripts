'use strict';

// In-bundle bridge between Monster Auto Battle (battle.php) and the
// automation workers. Monster Auto Battle registers a controller once its
// panel is ready; workers drive it through this interface instead of
// clicking its UI.
//
// Controller interface:
//   setTargetDamage(amount: number)          stop once your damage reaches it
//   setAttacks(skillIds: string[]) → boolean  use these standard skill ids
//                                             (e.g. ['0', '-1']) in that order;
//                                             false if none is available
//   setPotions({ stamina: itemIds[], heal: itemIds[] })
//                                             use exactly these potions, in this
//                                             order; empty list = that type off
//   start(), stop()
//   getState() → { running, finished, reason, yourDamage, targetDamage,
//                  monsterHp, message }
//     reason when finished: 'target' | 'defeated' | 'stopped' | 'no-stamina'
//                           | 'error'
//   onChange(callback) → unsubscribe function

let controller = null;
let waiters = [];

function registerController(next) {
  controller = next;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(next);
}

function unregisterController(current) {
  if (controller === current) controller = null;
}

function getController() {
  return controller;
}

function whenController(timeoutMs = 15_000) {
  if (controller) return Promise.resolve(controller);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((waiter) => waiter !== done);
      resolve(null);
    }, timeoutMs);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    waiters.push(done);
  });
}

module.exports = {
  getController,
  registerController,
  unregisterController,
  whenController,
};
