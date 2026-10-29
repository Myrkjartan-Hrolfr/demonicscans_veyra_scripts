'use strict';

// Runs page features (veyra-hud style improvements) independently of the
// scheduler. Every feature runs isolated: one failing feature never stops
// the others.
//
// A feature module exports:
//   id          unique id
//   group       settings group title shown in the menu
//   settings    array of setting definitions
//               { key, label, type: checkbox|number|text|select, default,
//                 options?, min?, max?, step?, hint?, visibleIf?(get) }
//   enabledBy   key of a checkbox setting that turns the feature on (optional;
//               without it the feature always runs on matching pages)
//   matches(url)  whether the feature runs on this page (url is a URL)
//   run(ctx)      does the work; may be async

const { fetchDocument, postForm } = require('../core/http');
const game = require('../core/game');

function findSetting(features, key) {
  for (const feature of features) {
    const definition = (feature.settings || []).find((setting) => setting.key === key);
    if (definition) return definition;
  }
  return null;
}

function isFeatureEnabled(feature, features, settings) {
  if (!feature.enabledBy) return true;
  const definition = findSetting(features, feature.enabledBy);
  return definition ? settings.get(definition) === true : false;
}

function createFeatureContext({ feature, features, win, doc, url, settings, store, getUserId }) {
  const prefix = `[Veyra:${feature.id}]`;
  return {
    win,
    doc,
    url,
    store,
    getUserId,
    postForm,
    fetchDocument,
    setting(key) {
      const definition = findSetting(features, key);
      if (!definition) throw new Error(`Unknown setting ${key}`);
      return settings.get(definition);
    },
    setSetting(key, value) {
      const definition = findSetting(features, key);
      if (!definition) throw new Error(`Unknown setting ${key}`);
      return settings.set(definition, value);
    },
    pageGlobal: (name) => game.pageGlobal(win, name),
    injectPageScript: (fn, ...args) => game.injectPageScript(doc, fn, ...args),
    notify: (message, type) => game.notify(doc, message, type),
    log: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
  };
}

function runFeatures({ win, doc, features, settings, store, getUserId }) {
  let url;
  try {
    url = new URL(win.location.href);
  } catch {
    return [];
  }

  const started = [];
  for (const feature of features) {
    try {
      if (!feature.matches(url) || !isFeatureEnabled(feature, features, settings)) continue;
      const ctx = createFeatureContext({ feature, features, win, doc, url, settings, store, getUserId });
      started.push(
        Promise.resolve()
          .then(() => feature.run(ctx))
          .catch((error) => console.error(`[Veyra] Feature ${feature.id} failed.`, error)),
      );
    } catch (error) {
      console.error(`[Veyra] Feature ${feature.id} failed.`, error);
    }
  }
  return started;
}

// Groups the setting definitions for the menu, in feature order and without
// duplicate keys (several features can share one setting).
function settingGroups(features) {
  const groups = [];
  const seenKeys = new Set();
  for (const feature of features) {
    let group = groups.find((candidate) => candidate.title === feature.group);
    if (!group) {
      group = { title: feature.group, settings: [] };
      groups.push(group);
    }
    for (const definition of feature.settings || []) {
      if (seenKeys.has(definition.key)) continue;
      seenKeys.add(definition.key);
      group.settings.push(definition);
    }
  }
  return groups.filter((group) => group.settings.length > 0);
}

module.exports = {
  createFeatureContext,
  findSetting,
  isFeatureEnabled,
  runFeatures,
  settingGroups,
};
