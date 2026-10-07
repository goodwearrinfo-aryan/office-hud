/**
 * GET /api/floors -- probe-grade floor state, as opposed to the rollup that
 * /api/summary already carries.
 *
 * Why this is a separate route
 * ----------------------------
 * summary.floors groups the agent roster by `floor`. That answers "which agents
 * are on f3 and what are they doing", and it is the right answer for a grid
 * badge. It cannot answer "is f3's manager actually alive", because it never
 * looks at the manager process, the status file's age, or stalled work. A floor
 * whose only member is a process id reads as running there.
 *
 * floor_health.js answers the second question by running the hive's own
 * lib/floor_health.py, which measures manager liveness, status-file freshness,
 * worker health and stalled tasks. The two are not substitutes and the HUD
 * needs both: the rollup for per-agent composition, this for per-floor truth.
 *
 * Truth contract
 * --------------
 * Every floor always appears. A floor the probe cannot account for is reported
 * UNKNOWN with a reason, never omitted and never optimistically healthy --
 * a missing floor in a table reads as "no such floor", which is a different
 * claim from "cannot confirm". When the probe is absent entirely the whole
 * payload carries not_verified: true, and the caller should say so rather than
 * render twelve grey rows as if they were measurements.
 *
 * Why it is memoised
 * ------------------
 * Each uncached read spawns a python process against the hive and can block up
 * to 25s. Unmemoised, an unauthenticated caller could pin a python per request.
 * The 5s window also stops two components mounting this from disagreeing, which
 * is the same drift the resource probe cache was added for.
 */
const path = require('path');
const { produceFloorsDots } = require('./lib/dots/bridge');

const FLOOR_CACHE_MS = 5000;
const ROUTE_PATH = '/api/floors';

const cache = new Map();

function unreadableFloors(reason) {
  return [
    'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'
  ].map((id) => ({
    floor: id,
    manager: id.toUpperCase(),
    state: 'UNKNOWN',
    reason,
    manager_alive: false,
    task_counts: {},
  }));
}

function readFloors(hive) {
  // Use DOTS producer
  const { produceFloorsDots } = require('./lib/dots/bridge');
  return produceFloorsDots();
}

/**
 * Synchronous on purpose. The probe underneath is execFileSync, so there is no
 * async work to overlap and an in-flight map would only be a way to serve two
 * callers two different answers. The memo is the whole concurrency story: one
 * read per hive per window, whoever asks.
 */
function getFloorRoutePayload(options = {}) {
  const hive = options.hive ?? process.env.OFFICE_HUD_HIVE ?? null;
  const now = Date.now();
  const hit = cache.get(hive);
  if (hit && now - hit.at < FLOOR_CACHE_MS) return hit.value;

  let value;
  try {
    value = readFloors(hive ?? undefined);
  } catch (error) {
    value = {
      floors: unreadableFloors(`floor route failed: ${error.message || error}`),
      counts: {},
      summary: {},
      source: 'error',
      not_verified: true,
      at: Date.now(),
    };
  }
  cache.set(hive, { at: now, value });
  return value;
}

function register(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('register(app) needs an express app');
  }
  // Idempotent, matching the other route modules: a real express app keeps every
  // handler it is handed, so a double mount would answer each request twice.
  if (!app._floorRoutes) {
    const stack = app._router && app._router.stack;
    if (Array.isArray(stack)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (layer && layer.route && layer.route.path === ROUTE_PATH) stack.splice(i, 1);
      }
    }
  }
  app._floorRoutes = true;
  app.get(ROUTE_PATH, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getFloorRoutePayload(options));
  });
  return app;
}

/** Test seam: drop memoised reads so a fixture change is observed immediately. */
function resetFloorCache() {
  cache.clear();
}

module.exports = {
  register,
  getFloorRoutePayload,
  readFloors: () => {
    const { produceFloorsDots } = require('./lib/dots/bridge');
    return produceFloorsDots();
  },
  resetFloorCache,
  ROUTE_PATH,
  FLOOR_CACHE_MS,
};