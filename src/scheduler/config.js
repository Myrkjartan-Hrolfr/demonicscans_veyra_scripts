'use strict';

const { createDefaultPotionSettings, normalizePotionSettings } = require('../core/potions');
const { PROTOCOL_VERSION } = require('../core/protocol');
const { ROUTE_IDS, ROUTE_LIST, getRoute } = require('../routes');

const CONFIG_KEY = 'veyra:orchestrator:config:v1';
const MIN_LOOP_MINUTES = 1;
const MAX_LOOP_MINUTES = 24 * 60;

function normalizeLoopMinutes(value, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_LOOP_MINUTES, Math.max(MIN_LOOP_MINUTES, number));
}

function normalizeRouteConfig(route, savedRoute) {
  const routeConfig = {
    enabled:
      typeof savedRoute?.enabled === 'boolean'
        ? savedRoute.enabled
        : route.defaultEnabled !== false,
    loopMinutes: normalizeLoopMinutes(savedRoute?.loopMinutes, route.defaultLoopMinutes),
    potions: normalizePotionSettings(savedRoute?.potions, createDefaultPotionSettings()),
    settings: route.normalizeSettings ? route.normalizeSettings(savedRoute?.settings) : {},
  };
  route.finalizeRouteConfig?.(routeConfig, savedRoute);
  return routeConfig;
}

function createDefaultConfig() {
  const routes = {};
  for (const route of ROUTE_LIST) routes[route.id] = normalizeRouteConfig(route, null);

  return {
    version: PROTOCOL_VERSION,
    enabled: true,
    homeRouteId: ROUTE_IDS[0],
    routes,
  };
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== PROTOCOL_VERSION) {
    return createDefaultConfig();
  }

  const routes = {};
  for (const route of ROUTE_LIST) routes[route.id] = normalizeRouteConfig(route, value.routes?.[route.id]);

  return {
    version: PROTOCOL_VERSION,
    enabled: value.enabled !== false,
    homeRouteId: getRoute(value.homeRouteId) ? value.homeRouteId : ROUTE_IDS[0],
    routes,
  };
}

function isRouteEnabled(config, routeId) {
  return normalizeConfig(config).routes[routeId]?.enabled !== false;
}

function loopIntervalMs(config, routeId) {
  const route = getRoute(routeId);
  const minutes = config?.routes?.[routeId]?.loopMinutes ?? route?.defaultLoopMinutes ?? 30;
  return normalizeLoopMinutes(minutes, 30) * 60_000;
}

module.exports = {
  CONFIG_KEY,
  MAX_LOOP_MINUTES,
  MIN_LOOP_MINUTES,
  createDefaultConfig,
  isRouteEnabled,
  loopIntervalMs,
  normalizeConfig,
  normalizeLoopMinutes,
};
