'use strict';

const { adventurersWorkerFeature } = require('./adventurers-worker');
const { bossWorkerFeature } = require('./boss-worker');
const { crucibleWorkerFeature } = require('./crucible-worker');
const { cruciblePvpWatcherFeature } = require('./crucible-pvp-watch');
const { pvpWorkerFeature } = require('./pvp-worker');
const { princeWorkerFeature } = require('./prince-worker');
const { shadowbridgeWorkerFeature } = require('./shadowbridge-worker');

module.exports = [
  bossWorkerFeature,
  pvpWorkerFeature,
  adventurersWorkerFeature,
  shadowbridgeWorkerFeature,
  princeWorkerFeature,
  crucibleWorkerFeature,
  cruciblePvpWatcherFeature,
];
