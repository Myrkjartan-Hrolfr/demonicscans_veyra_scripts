'use strict';

const { adventurersWorkerFeature } = require('./adventurers-worker');
const { bossWorkerFeature } = require('./boss-worker');
const { crucibleWorkerFeature } = require('./crucible-worker');
const { pvpWorkerFeature } = require('./pvp-worker');
const { shadowbridgeWorkerFeature } = require('./shadowbridge-worker');

module.exports = [
  bossWorkerFeature,
  pvpWorkerFeature,
  adventurersWorkerFeature,
  shadowbridgeWorkerFeature,
  crucibleWorkerFeature,
];
