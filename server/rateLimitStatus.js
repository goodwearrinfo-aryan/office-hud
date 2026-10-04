'use strict';
/**
 * What the HUD may say about rate-limit headroom.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * /api/llm/rate-limits was a stub:
 *
 *     const { getRateLimitStatus } = require('.../lib/llm/rateLimit');
 *     res.json({});
 *
 * It required the limiter and never called it, answering every caller with an empty
 * object — a route that looks implemented, computes nothing, and cannot fail. Any
 * floor that drew it would have had nothing to draw, which is at least honest. The
 * danger was in fixing it naively.
 *
 * hive/lib/llm/rateLimit.js is an in-memory token bucket:
 *
 *     function getRateLimitStatus(key, rpm) {
 *       const bucket = buckets.get(key) || { tokens: rpm, lastRefill: now };
 *       ...
 *       return { available: Math.floor(tokens), resetInMs: ... };
 *     }
 *
 * `buckets` is a module-private Map and is NOT exported. So for any key this process
 * has never rate-limited, the function reports a FULL bucket -- `available: rpm` --
 * invented from the default it just substituted. Wiring the route to call it would
 * have turned "no record" into a green bar reading "N available", on a machine that
 * has never been asked for a token.
 *
 * That is the failure this codebase keeps removing: the absence of a measurement
 * drawn as a measurement. So the honest route reports that there is no record, and
 * says why the question cannot be answered better than that.
 *
 * The pattern copied, from pixel-agents (MIT): a lane's indicator appears only when
 * there is a real signal, never as a default that reads as healthy. Its own roadmap
 * lists rate-limit health bars as unbuilt, so nothing was borrowed but the restraint.
 */

const UNOBSERVED = 'unobserved';
const UNAVAILABLE = 'unavailable';
const OBSERVED = 'observed';

/**
 * Build the report for one scope.
 *
 * `limiter` is injected rather than required so the shaping can be tested against a
 * fake, and so this function stays pure. `hasRecord` is the honest question — the
 * real limiter cannot answer it, which is the whole point, so the caller passes
 * false and the report says so.
 */
function rateLimitReport({ limiter, key, rpm, hasRecord = false, now = Date.now(), error = null }) {
  const requested = { key: key ?? null, rpm: Number(rpm) || null };

  if (error) {
    return {
      ok: false,
      status: UNAVAILABLE,
      requested,
      observed: false,
      headroom: null,
      reset_in_ms: null,
      checked_at: new Date(now).toISOString(),
      reason: `The rate limiter could not be loaded: ${error}. No headroom is claimed.`,
    };
  }

  if (!hasRecord) {
    return {
      ok: false,
      status: UNOBSERVED,
      requested,
      observed: false,
      headroom: null,
      reset_in_ms: null,
      checked_at: new Date(now).toISOString(),
      reason: 'The rate limiter keeps its buckets in memory and does not list its keys, so this '
        + 'scope has no record. An unobserved scope is not a full bucket and not an exhausted one.',
    };
  }

  // Reached only when a caller can prove a record exists. Kept because the shape
  // should not have to change again when one can: the truthfulness lives in the
  // status field, not in the absence of this branch.
  const reading = typeof limiter === 'function' ? limiter(key, rpm) : null;
  if (!reading || typeof reading.available !== 'number' || !Number.isFinite(reading.available)) {
    return {
      ok: false,
      status: UNOBSERVED,
      requested,
      observed: false,
      headroom: null,
      reset_in_ms: null,
      checked_at: new Date(now).toISOString(),
      reason: 'The limiter reported no usable reading for this scope.',
    };
  }
  return {
    ok: true,
    status: OBSERVED,
    requested,
    observed: true,
    headroom: reading.available,
    reset_in_ms: Number.isFinite(reading.resetInMs) ? reading.resetInMs : null,
    checked_at: new Date(now).toISOString(),
    reason: null,
  };
}

module.exports = { rateLimitReport, OBSERVED, UNOBSERVED, UNAVAILABLE };