'use strict';

// From veyra-hud ui-improvements: aligns the quest accept buttons on the
// Adventurer's Guild by pushing the reward column to the bottom of each card.

const { injectStyle } = require('./dom');

const STYLE_ID ='veyra-automation-adventurers-guild-layout';

module.exports = Object.freeze({
  id: 'adventurers-guild-layout',
  group: 'General',
  settings: [],

  matches(url) {
    return /\/adventurers_guild\.php$/i.test(url.pathname);
  },

  run({ doc }) {
    injectStyle(doc, STYLE_ID, '.quest-side { margin-top: auto !important; }');
  },
});
