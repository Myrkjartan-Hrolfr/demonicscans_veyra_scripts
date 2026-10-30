'use strict';

const { createSchedulerEngine } = require('./engine');
const { createSchedulerUi } = require('./ui');

function startScheduler({ win, store, sessionStore, featureGroups = [], featureSettings = null }) {
  const doc = win.document;
  const ui = createSchedulerUi({ doc, win, store, featureGroups, featureSettings });
  const engine = createSchedulerEngine({ win, store, sessionStore, ui });

  ui.mount(engine);
  engine.start();

  doc.addEventListener?.('visibilitychange', () => {
    if (doc.hidden !== true) engine.resume();
  });
  win.addEventListener?.('pageshow', (event) => {
    if (event?.persisted) engine.resume();
  });
  win.addEventListener?.('pagehide', (event) => {
    engine.stopPolling();
    if (!event?.persisted) {
      engine.shutdown();
      ui.cleanup();
    }
  });

  return engine;
}

module.exports = { startScheduler };
