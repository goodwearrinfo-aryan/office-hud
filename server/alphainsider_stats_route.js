'use strict';
/**
 * The AlphaInsider stats routes, isolated so they cannot be lost to a rewrite.
 *
 * /api/alphainsider/poller and /api/alphainsider/trader 404 against the running
 * server right now, while office-hud/web/src/components/AlphaInsiderPanel.tsx
 * still fetches /api/alphainsider/poller. Both were served at c419bb4 and were
 * lost in 1b7f30d -- a whole-file rewrite of index.js whose actual subject was a
 * different bug (process data 5.7h stale). They are collateral damage from an
 * unrelated fix, and the panel's equity/cash figures fall back to dashes.
 *
 * This is the same failure class as /api/live-digest, which has been dropped four
 * times, and the same remedy live_digest_route.js already uses: the route lives in
 * its own file, so a rewrite of the 3200-line index.js cannot silently remove it.
 * index.js mounts it with one line when someone next touches that file:
 *
 *     const alphaInsiderStats = require('./alphainsider_stats_route');
 *     alphaInsiderStats.register(app);
 *
 * Truth over appearance. A dead upstream produces a NAMED 502 carrying the cause,
 * never a plausible empty payload. The panel must be able to distinguish "no data
 * yet" from "provider unreachable" -- an equity of 0 rendered as a real number is
 * the specific dishonesty this avoids.
 *
 * The proxy deliberately duplicates index.js's proxyFreeHarnessJson rather than
 * importing it. That helper is defined inline in the contested file, so importing
 * it would re-couple this module to the file it exists to survive.
 */

const UPSTREAM_BASE =
  process.env.FREE_HARNESS_URL || 'http://127.0.0.1:8080';

// Matches index.js's proxyFreeHarnessJson, so the two proxy paths behave the same.
const UPSTREAM_TIMEOUT_MS = 5000;

// Upstream path for each local path. Kept as a table rather than derived, so the
// mapping is auditable: a reader can see exactly which local path reaches which
// upstream path, and a typo cannot hide inside a string template.
const STATS_ROUTES = {
  '/api/alphainsider/poller': '/alphainsider/poller',
  '/api/alphainsider/trader': '/alphainsider/trader',
};

/** Bounded query pass-through, matching the existing helper's limits. */
function appendQuery(url, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    const str = String(value);
    if (str.length === 0 || str.length > 128) continue;
    url.searchParams.set(key, str);
  }
}

async function proxyUpstream(upstreamPath, res, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const query = options.query || {};
  try {
    const url = new URL(UPSTREAM_BASE + upstreamPath);
    appendQuery(url, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const data = await response.json();
      // Pass the upstream status through. A 503 from a starting provider must not
      // be flattened into a 200 with an empty body, which is how a panel ends up
      // rendering a number it invented.
      res.status(response.status).json(data);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    res.status(502).json({
      error: 'AlphaInsider provider unavailable',
      detail: (error && error.message) || String(error),
      upstream: upstreamPath,
    });
  }
}

function register(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('register(app) needs an express app');
  }
  // Idempotent by construction. A real express app keeps every handler it is
  // given, so a double mount would run this twice per request; a Map-backed
  // stand-in would not show that. Replacing the layer is what makes re-mounting
  // safe when someone adds the require line to index.js.
  if (!app._alphainsiderStatsRoutes) {
    const stack = app._router && app._router.stack;
    if (Array.isArray(stack)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (layer && layer.route && STATS_ROUTES[layer.route.path]) {
          stack.splice(i, 1);
        }
      }
    }
  }
  app._alphainsiderStatsRoutes = true;
  for (const [localPath, upstreamPath] of Object.entries(STATS_ROUTES)) {
    app.get(localPath, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      await proxyUpstream(upstreamPath, res, {
        fetchImpl: options.fetchImpl,
        query: (req && req.query) || {},
      });
    });
  }
  return app;
}

module.exports = {
  register,
  STATS_ROUTES,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_BASE,
  appendQuery,
};
