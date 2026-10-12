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

const LIVE_DIGEST_PATH = '/Users/a/trading/live_digest.json';

// Exported rather than inlined so a panel and this route cannot disagree about
// when a digest stopped being current.
const DIGEST_STALE_AFTER_SECONDS = 300;

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

// The verdicts a gate is allowed to publish, worst first. A value outside this
// set is reported as UNRECOGNISED rather than defaulted to something benign:
// the whole reason this view exists is that a gate which stopped judging used to
// read as ordinary, because every silent state was treated as harmless.
// ABSENT outranks FAIL on purpose. A FAIL is a gate doing its job and disliking
// the answer; an absent gate tells you nothing, which is the failure class this
// file's header says has already bitten four times.
const VERDICT_SEVERITY = ['ABSENT', 'UNRECOGNISED', 'FAIL', 'NO_CRITERIA',
  'INSUFFICIENT_DATA', 'PASS'];

function verdictSeverity(verdict) {
  if (verdict === null || verdict === undefined || verdict === '') return 'ABSENT';
  if (typeof verdict !== 'string') return 'UNRECOGNISED';
  if (!VERDICT_SEVERITY.includes(verdict)) return 'UNRECOGNISED';
  return verdict;
}

function rank(verdict) {
  return VERDICT_SEVERITY.indexOf(verdict);
}

/**
 * The gates view: verdicts pulled out of the digest and lined up worst-first.
 *
 * This does not compute a verdict. It reads the ones live_digest.py already
 * published and re-exposes them in the shape a panel needs to answer one
 * question without parsing prose: is anything actually being judged right now,
 * and what is the worst thing it said?
 *
 * It also carries the two facts that were easiest to lose. `stats_broken` is the
 * significance layer reporting it could not run, which is NOT the same as a
 * thin sample and used to look identical to one. `cap_comparison` is arithmetic
 * on two numbers the gates already published -- drawdown and the cap they are
 * measured against -- and `breached` stays null when either side is unknown
 * rather than quietly becoming false.
 */
function gatesView(digest, now) {
  if (!digest || typeof digest !== 'object') return null;
  const gates = [];
  const note = (key, gate, extra) => {
    const verdict = verdictSeverity(gate && gate.verdict);
    gates.push({
      key,
      verdict,
      // The digest's own sentence, kept so this view cannot become a
      // paraphrase that drifts from what the gate actually said.
      reason: (gate && gate.reason) || null,
      criteria: (gate && gate.criteria) || null,
      ...extra,
    });
  };

  const taker = digest.polymarket_taker || {};
  note('polymarket_taker', taker.gate, {
    sample: {
      in_band_closes: taker.gate ? taker.gate.in_band_closes : null,
      historical_closes: taker.gate ? taker.gate.historical_closes : null,
    },
    stats_broken: (taker.significance && taker.significance.error)
      ? String(taker.significance.error) : null,
  });

  const live = digest.openalice_live || {};
  note('openalice_live', live.gate, {
    sample: { equity_points: live.equity_points === undefined ? null : live.equity_points },
    stats_broken: null,
  });

  const cap = taker.risk_cap || {};
  const dd = cap.portfolio_drawdown_pct;
  const capPct = cap.cap_pct;
  const known = typeof dd === 'number' && typeof capPct === 'number'
    && Number.isFinite(dd) && Number.isFinite(capPct);

  // Worst first, so the head of the list is the thing an operator should look
  // at. Deriving worst_verdict from the sorted list rather than tracking it
  // while building keeps the two impossible to disagree with each other.
  const ordered = gates.sort((a, b) => rank(a.verdict) - rank(b.verdict));

  const gauntlet = digest.sma_gauntlet || {};
  const age = digestAgeSeconds(digest, now);
  return {
    generated_at: digest.generated_at || null,
    digest_age_seconds: age,
    digest_fresh: age === null ? null : age <= DIGEST_STALE_AFTER_SECONDS,
    worst_verdict: ordered[0].verdict,
    // A gate publishing nothing at all. Both gates are always listed, so a
    // missing section surfaces here rather than as a short list.
    any_gate_absent: ordered.some((g) => g.verdict === 'ABSENT'),
    any_stats_broken: ordered.some((g) => g.stats_broken !== null),
    // The out-of-sample run is a separate publisher, not a gate. Absent means
    // no OOS evidence exists, which is a fact a panel should not have to infer
    // from a missing key.
    sma_gauntlet: { present: gauntlet.present === true, age_s: gauntlet.age_s ?? null },
    cap_comparison: {
      portfolio_drawdown_pct: known ? dd : null,
      cap_pct: known ? capPct : null,
      breached: known ? dd > capPct : null,
    },
    gates: ordered,
  };
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
      digest_fresh: age === null ? null : age <= DIGEST_STALE_AFTER_SECONDS,
    });
  });
  app.get('/api/live-digest/gates', (_req, res) => {
    const digest = readJsonCached(LIVE_DIGEST_PATH, null);
    if (!digest) {
      // Same named failure as the full digest. A panel must be able to tell
      // "no publisher" apart from "no verdicts".
      return res.status(503).json({
        error: 'LIVE_DIGEST_UNAVAILABLE',
        message: `live_digest.json is missing or unreadable at ${LIVE_DIGEST_PATH}`,
        path: LIVE_DIGEST_PATH,
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json(gatesView(digest));
  });
  return app;
}

module.exports = {
  LIVE_DIGEST_PATH,
  DIGEST_STALE_AFTER_SECONDS,
  VERDICT_SEVERITY,
  register,
  digestAgeSeconds,
  gatesView,
};
