'use strict';

// From veyra-hud ui-improvements: shows each enemy's class/role (from the
// page's stateData) under the name in the enemy formation of solo and party
// PvP battles. Uses one debounced observer instead of two raw observers plus
// a polling wait for stateData.

const { KEYS, SETTINGS } = require('./settings');
const { extractEnemyRoles, isPvpBattleUrl, observeDebounced } = require('./pvp-helpers');

const ROLE_CLASS = 'veyra-pvp-role-tag';

function applyRoles(doc, roles) {
  for (const slot of doc.querySelectorAll('#enemyFormation .pSlot[data-key]')) {
    const role = roles[slot.dataset.key];
    if (!role) continue;
    let tag = slot.querySelector(`.${ROLE_CLASS}`);
    if (tag && tag.textContent === role) continue;
    if (!tag) {
      const name = slot.querySelector('.uname');
      if (!name) continue;
      tag = doc.createElement('div');
      tag.className = `${ROLE_CLASS} roleTag`;
      tag.style.cssText = 'font-size:11px;opacity:.8;';
      name.insertAdjacentElement('afterend', tag);
    }
    tag.textContent = role;
  }
}

module.exports = Object.freeze({
  id: 'pvp-enemy-class',
  group: 'PvP',
  settings: [SETTINGS.enemyClass],
  enabledBy: KEYS.enemyClass,

  matches(url) {
    return isPvpBattleUrl(url);
  },

  run(ctx) {
    const { doc, win } = ctx;
    // Roles never change during a match; keep every role we have seen so
    // slots re-rendered after stateData changes keep their tag.
    const cache = {};
    const update = () => {
      Object.assign(cache, extractEnemyRoles(ctx.pageGlobal('stateData')));
      if (Object.keys(cache).length > 0) applyRoles(doc, cache);
    };
    update();
    observeDebounced(win, doc.body, update, { delayMs: 120 });
  },
});
