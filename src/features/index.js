'use strict';

// All page features. The group order here is the order of the settings
// groups in the menu.

const FEATURES = Object.freeze([
  ...require('./general'),
  ...require('./wave'),
  ...require('./loot'),
  ...require('./dungeon'),
  ...require('./pvp'),
  ...require('./battle'),
  ...require('./automation'),
]);

module.exports = { FEATURES };
