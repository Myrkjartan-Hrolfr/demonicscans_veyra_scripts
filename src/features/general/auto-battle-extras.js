'use strict';

// build.js replaces this small development shim with the complete, preserved
// Auto Battle Extras implementation from the repository. Keeping the legacy
// implementation as its own source file avoids maintaining two divergent
// 3,600-line copies while still exposing it as an isolated page feature in the
// generated userscript.

module.exports = Object.freeze({
  id: 'auto-battle-extras',
  group: 'Castle event',
  settings: [],

  matches(url) {
    return /\/occurrence_castle\.php\/?$/i.test(url.pathname);
  },

  run() {
    // The generated module contains the real implementation. Node unit tests
    // intentionally use this side-effect-free shim.
  },
});
