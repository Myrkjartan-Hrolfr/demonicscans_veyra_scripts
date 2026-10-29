'use strict';

// From veyra-hud ui-improvements (Battle Side Bar): makes the battle drawer
// scrollable and keeps its last entry clear of the chat button.

const { injectStyle } = require('./dom');

const STYLE_ID = 'veyra-automation-battle-drawer-scroll';
const CSS = `
  #battleDrawer {
    overflow: auto !important;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 150px !important;
  }
  #battleDrawer > :last-child { margin-bottom: 100px !important; }
`;

module.exports = Object.freeze({
  id: 'battle-drawer-scroll',
  group: 'General',
  settings: [],

  matches() {
    return true;
  },

  run({ doc }) {
    const drawer = doc.getElementById?.('battleDrawer');
    if (!drawer) return;
    injectStyle(doc, STYLE_ID, CSS);
    // Inline as well: the page's own styles have beaten the stylesheet before.
    drawer.style.overflow = 'auto';
    drawer.style.setProperty('padding-bottom', '150px', 'important');
    drawer.lastElementChild?.style?.setProperty('margin-bottom', '100px', 'important');
  },
});
