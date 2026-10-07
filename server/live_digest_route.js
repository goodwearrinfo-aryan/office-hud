/**
 * The live-digest route, isolated so it cannot be lost to a file rewrite.
 *
 * /api/live-digest has now been lost FOUR times (2361b9f, 1b7f30d, and twice
 * more) — always to a wholesale rewrite of office-hud/server/index.js, never to
 * a targeted edit. index.js is a 3200-line file that multiple live sessions edit;
 * adding a route there means betting that no one rewrites it before the next
 * deploy, which has now failed four times.
 *
 * The fix for "my route keeps disappearing" is to stop putting the route in the
 * contested file. Express it here instead — small, testable, additive — and let
 * index.js mount it when someone next touches it. This is the same reasoning
 * processTruth.js already uses in this directory, and the same shape as the
 * fleet_lib/ + hive/lib/ shim split used for the dependency engine.
 *
 * Truth over appearance: the route serves the file the gates wrote and returns a
 * NAMED 503 when it is missing, so a broken publisher stays distinguishable from
 * a wrong URL. It never fabricates a payload, never recomputes a verdict, and
 * never reports a stale digest as current without saying when it was produced.
 */

'use strict';

const fs = require('node:fs');
const path = require('path');
const os = require('os');

// Its own mtime-keyed cache rather than importing index.js's readJsonCached.
// That helper is defined inline in a file multiple live sessions rewrite, so
// requiring it would re-couple this module to the exact file it exists to
// survive. Twenty lines of cache is a cheap price for that independence.
// Keyed on mtime AND size, so an edit is always observed, never served stale.
const _cache = new Map();

function readJsonCached(file, fallback) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    _cache.delete(file);
    return fallback;
  }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    hit.at = Date.now();
    return hit.value;
  }
  let value = fallback;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    value = fallback;
  }
  _cache.set(file, { at: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

const LIVE_DIGEST_PATH = process.env.LIVE_DIGEST_PATH || path.join(os.homedir(), 'trading', 'live_digest.json');

// The digest embeds its own generated_at, so staleness is a property of the data
// rather than something the route has to guess. Expose it rather than letting a
// panel present a 10-minute-old verdict as live.
function digestAgeSeconds(digest, now) {
  const stamp = digest && (digest.generated_at || digest.generatedAt);
  if (typeof stamp !== 'string') return null;
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round(((typeof now === 'number' ? now : Date.now()) - t) / 1000));
}

function register(app) {
  if (typeof app.get !== 'function') {
    throw new TypeError('register(app) needs an express app');
  }
  app.get('/api/live-digest', (_req, res) => {
    const digest = readJsonCached(LIVE_DIGEST_PATH, null);
    if (!digest) {
      return res.status(503).json({
        error: 'LIVE_DIGEST_UNAVAILABLE',
        message: `live_digest.json is missing or unreadable at ${LIVE_DIGEST_PATH}`,
        path: LIVE_DIGEST_PATH,
      });
    }
    const age = digestAgeSeconds(digest);
    res.set('Cache-Control', 'no-store');
    res.json({
      ...digest,
      digest_age_seconds: age,
      // Explicit, so a consumer never has to infer freshness from a timestamp.
      digest_fresh: age === null ? null : age <= 300,
    });
  });
  return app;
}

module.exports = {
  LIVE_DIGEST_PATH,
  DIGEST_STALE_AFTER_SECONDS: 300,
  register,
  digestAgeSeconds,
};
