'use strict';

// From veyra-hud ui-improvements ("Better Header"): the top bar scrolls with
// the page instead of covering content, and its left part wraps on small
// screens.

const { injectStyle } = require('./dom');

const STYLE_ID = 'veyra-automation-better-header';
const CSS = `
  body { margin-bottom: 35px; }
  .game-topbar { position: relative !important; }
  body {
    padding-block: 0px !important;
    padding-inline: 0px !important;
    padding-top: 0px !important;
  }
  .gtb-left { flex-wrap: wrap !important; }
  @media (max-width: 600px) {
    body { padding-top: 0px !important; }
  }
`;

module.exports = Object.freeze({
  id: 'better-header',
  group: 'General',
  settings: [
    {
      key: 'ui-improvements:betterGameTopBar',
      label: 'Better Header',
      type: 'checkbox',
      default: true,
      hint: 'The top bar scrolls with the page and wraps on small screens.',
    },
  ],
  enabledBy: 'ui-improvements:betterGameTopBar',

  matches() {
    return true;
  },

  run({ doc }) {
    injectStyle(doc, STYLE_ID, CSS);
    doc.querySelector?.('.gtb-left')?.style?.setProperty('flex-wrap', 'wrap', 'important');
  },
});
