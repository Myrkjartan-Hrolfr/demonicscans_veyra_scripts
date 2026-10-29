'use strict';

// Every page the scheduler can visit. The order is the display order and the
// tie-breaker when several pages are due at the same time.
//
// A route provides: id, label, path, matchesUrl(url), defaultLoopMinutes,
// maxVisitMs, initialDelayMs and optionally visitPathnames,
// createDefaultSettings(), normalizeSettings(saved),
// finalizeRouteConfig(routeConfig, savedRoute) and renderSettings(ctx).

const olympus = require('./olympus');
const pvp = require('./pvp');
const wave3 = require('./wave3');

const ROUTE_LIST = Object.freeze([pvp, wave3, olympus]);
const ROUTES = Object.freeze(Object.fromEntries(ROUTE_LIST.map((route) => [route.id, route])));
const ROUTE_IDS = Object.freeze(ROUTE_LIST.map((route) => route.id));

function getRoute(routeId) {
  return Object.prototype.hasOwnProperty.call(ROUTES, routeId) ? ROUTES[routeId] : null;
}

module.exports = {
  ROUTES,
  ROUTE_IDS,
  ROUTE_LIST,
  getRoute,
};
