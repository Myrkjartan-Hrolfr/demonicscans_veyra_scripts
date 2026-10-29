'use strict';

// Wave page (/active_wave.php) features ported from veyra-hud. Order here is
// the order of the settings in the "Wave filtering" and "Wave page" groups.

module.exports = [
  ...require('./filtering').features,
  ...require('./page').features,
  require('./strategic-attack').strategicAttackFeature,
];
