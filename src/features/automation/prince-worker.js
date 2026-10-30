'use strict';

const { createJsonStore, getStorage } = require('../../core/storage');
const { CONFIG_KEY, normalizeConfig } = require('../../scheduler/config');
const princeRoute = require('../../routes/prince');
const { staminaMultiplier } = require('../shared/asterion');
const dungeonLogic = require('./shadowbridge-logic');
const { createShadowbridgeStatusView } = require('./shadowbridge-status');
const { createShadowbridgeWorker } = require('./shadowbridge-worker');

const ROUTE_ID = 'prince';

function attackPlan(scans, settings, processed = new Set()) {
  const candidates = [];
  let sequence = 0;
  for (const scan of scans || []) {
    const selected = princeRoute.settingsForLocation(settings, scan.location);
    if (!selected?.target.enabled) continue;
    for (const monster of scan.monsters || []) {
      const key = `${monster.instanceId || scan.location.instanceId}:${monster.monsterId}`;
      if (monster.dead || processed.has(key)) continue;
      candidates.push({
        ...monster,
        key,
        name: monster.name || selected.displayName,
        location: scan.location,
        target: selected.target,
        targetId: selected.definition.id,
        isBoss: selected.definition.isBoss,
        sequence: sequence++,
      });
    }
  }
  const order = new Map(princeRoute.PRINCE_TARGETS.map((target, index) => [target.id, index]));
  return candidates.sort(
    (left, right) =>
      (order.get(left.targetId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.targetId) ?? Number.MAX_SAFE_INTEGER) ||
      left.sequence - right.sequence,
  );
}

function saveDiscoveries({ scans, route, store }) {
  const merged = princeRoute.mergeDiscoveredMonsters(route.settings, scans);
  if (!merged.changed) return;
  route.settings = merged.settings;
  const config = normalizeConfig(store.read(CONFIG_KEY));
  config.routes[ROUTE_ID].settings = merged.settings;
  store.write(CONFIG_KEY, config);
}

function createPrinceWorker(options) {
  const statusView =
    options.statusView ||
    createShadowbridgeStatusView(options.doc, {
      title: 'Castle attack progress',
      idleText: 'Scanning Castle of the Fallen Prince…',
      workingText: 'Castle attack is working…',
      fallbackTargetName: 'Castle monster',
    });
  return createShadowbridgeWorker({
    ...options,
    statusView,
    profile: {
      routeId: ROUTE_ID,
      dungeonName: princeRoute.DUNGEON_NAME,
      workerName: 'Castle of the Fallen Prince',
      parseHubEntry(doc, baseUrl) {
        return dungeonLogic.parseNamedHubEntry(doc, princeRoute.DUNGEON_NAME, baseUrl);
      },
      attackPlan,
      hasEnabledTargets(settings) {
        return Object.values(settings.targets || {}).some((target) => target.enabled);
      },
      isBossEnabled(settings) {
        return settings.targets?.['true-heir-throne']?.enabled === true;
      },
      onScans: saveDiscoveries,
    },
  });
}

const princeWorkerFeature = Object.freeze({
  id: 'prince-worker',
  group: 'Automation',
  settings: [],
  matches(url) {
    return /\/guild_dungeon\.php\/?$/i.test(url.pathname);
  },
  run(ctx) {
    let multiplier = 1;
    try {
      multiplier = staminaMultiplier(ctx);
    } catch {
      // The optional shared setting is unavailable only in isolated tests.
    }
    const worker = createPrinceWorker({
      win: ctx.win,
      doc: ctx.doc,
      store: ctx.store,
      sessionStore: createJsonStore(getStorage('sessionStorage', ctx.win), '[Veyra]'),
      fetchDocument: ctx.fetchDocument,
      postForm: ctx.postForm,
      getUserId: ctx.getUserId,
      asterionMultiplier: multiplier,
    });
    worker.start();
    return worker;
  },
});

module.exports = {
  ROUTE_ID,
  attackPlan,
  createPrinceWorker,
  princeWorkerFeature,
  saveDiscoveries,
};
