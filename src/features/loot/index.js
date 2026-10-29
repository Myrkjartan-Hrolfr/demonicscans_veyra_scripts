'use strict';

// Loot features: wave page looting (Dead Monster Looter + Loot X) and the
// dungeon / Crucible bulk loot buttons. Shared logic lives in loot-api.js
// and loot-ui.js (no feature modules).

module.exports = [require('./wave-loot'), require('./dungeon-loot')];
