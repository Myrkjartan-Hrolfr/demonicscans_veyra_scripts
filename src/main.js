'use strict';

const { createUserIdResolver } = require('./core/game');
const { createSettingsStore } = require('./core/settings');
const { createJsonStore, getStorage } = require('./core/storage');
const { FEATURES } = require('./features');
const { runFeatures, settingGroups } = require('./features/runner');
const { startScheduler } = require('./scheduler');

function main(win) {
  const doc = win.document;
  const store = createJsonStore(getStorage('localStorage', win), '[Veyra]');
  const sessionStore = createJsonStore(getStorage('sessionStorage', win), '[Veyra]');
  const featureSettings = createSettingsStore(store);

  startScheduler({
    win,
    store,
    sessionStore,
    featureGroups: settingGroups(FEATURES),
    featureSettings,
  });

  runFeatures({
    win,
    doc,
    features: FEATURES,
    settings: featureSettings,
    store,
    getUserId: createUserIdResolver({ doc, win, fetchImpl: win.fetch?.bind(win) }),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  main(window);
}
