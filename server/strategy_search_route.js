'use strict';
/**
 * The strategy-search honest verdict route, isolated so it cannot be lost to a
 * rewrite of index.js.
 *
 * The search behind this now measures edge honestly: a combination qualifies
 * only if it clears the sample floor, a net-of-fee held-out return, and a 95%
 * CI on the mean per-trade net P&L that excludes zero. That verdict lives in
 * research/strategy-search/reports/latest.json, which the HUD has never
 * surfaced. A dashboard that shows nothing while the search qualifies nothing
 * is honest; a dashboard that shows nothing while the search runs is a blind
 * spot - and a blind spot is where a stale or lying number would go unnoticed.
 *
 * The result deliberately distinguishes three states the old reports collapsed
 * into one, because conflating them is exactly how a HUD starts lying:
 *   - significantly_negative   the CI excludes zero on the DOWNSIDE: confident
 *                              evidence of no edge, not noise
 *   - luck_indistinguishable   the CI straddles zero: indistinguishable from
 *                              luck, which is also not an edge
 *   - positive_excluding_zero  the CI clears zero entirely: the only state
 *                              that is an edge
 *
 * Every number is published with its population (numerator AND denominator).
 * A missing report becomes a NAMED 502 carrying the cause, never a plausible
 * empty payload: the reader must be able to tell "no report yet" from "the
 * loop is down" from "unreadable".
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(REPO_ROOT, 'research', 'strategy-search', 'reports', 'latest.json');

// The loop writes a report every ~30 minutes. Older than this and the loop is
// down or wedged: the verdict is stale and must say so rather than pose as
// fresh truth. Chosen at 3x the write interval - a single missed cycle is not
// staleness, three is a pattern.
const STALE_MINUTES = 90;

function readReport(reportPath) {
  const target = reportPath || REPORT_PATH;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function reportAgeMinutes(reportPath, nowMs) {
  // The file mtime, not generated_at: generated_at is the cycle START, and a
  // long cycle would make the age read fresher than it is. mtime is when the
  // report was actually written - the honest freshness signal.
  const target = reportPath || REPORT_PATH;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return null;
  }
  const ref = nowMs || Date.now();
  return Math.max(0, Math.round((ref - stat.mtimeMs) / 60000));
}

function classifySearch(search) {
  const closest = (search && search.closest) || [];
  let measurable = 0;
  let positiveExcludingZero = 0;
  let significantlyNegative = 0;
  let luck = 0;
  let best = null;
  for (const candidate of closest) {
    const low = candidate.ci_low_edge_pnl;
    const high = candidate.ci_high_edge_pnl;
    if (typeof low === 'number' && typeof high === 'number') {
      measurable += 1;
      if (low > 0) positiveExcludingZero += 1;
      else if (high < 0) significantlyNegative += 1;
      else luck += 1;
    }
    if (!best || (candidate.test_return_pct || 0) > (best.test_return_pct || 0)) best = candidate;
  }
  return {
    symbol: (search && search.symbol) || 'BTCUSDT',
    timeframe: (search && search.timeframe) || 'unknown',
    // Denominator of the honest gate for this timeframe.
    combinations: (search && search.combinations) || 0,
    evaluated: (search && search.evaluated) || 0,
    // Numerator of the honest gate for this timeframe.
    qualified_strict: ((search && search.qualified_strict) || []).length,
    measurable,
    positive_excluding_zero: positiveExcludingZero,
    significantly_negative: significantlyNegative,
    luck_indistinguishable: luck,
    best: best ? {
      strategies: best.strategies || [],
      test_return_pct: best.test_return_pct,
      // The like-with-like comparison the gate requires: buy-and-hold over the
      // same test segment, net of the same fee, and the difference - alpha.
      benchmark_test_return_pct: best.benchmark_test_return_pct,
      alpha_pct: best.alpha_pct,
      trades: best.trades,
      edge_ci: (typeof best.ci_low_edge_pnl === 'number' && typeof best.ci_high_edge_pnl === 'number')
        ? { low: best.ci_low_edge_pnl, high: best.ci_high_edge_pnl }
        : 'not_measured',
    } : null,
  };
}

function verdict(report, ageMinutes) {
  if (!report) {
    return {
      error: 'no report has been stored yet',
      report_path: REPORT_PATH,
      hint: 'the research loop writes one every ~30 minutes',
    };
  }
  const results = report.results || {};
  const classified = (results.searches || []).map(classifySearch);
  const totalCombinations = classified.reduce((sum, item) => sum + item.combinations, 0);
  const totalQualified = classified.reduce((sum, item) => sum + item.qualified_strict, 0);
  return {
    generated_at: report.generated_at || null,
    report_age_minutes: ageMinutes === undefined ? null : ageMinutes,
    stale: typeof ageMinutes === 'number' ? ageMinutes > STALE_MINUTES : null,
    stale_definition: 'older than ' + STALE_MINUTES + ' minutes means the research loop is down or wedged',
    fee: {
      per_side_pct: (results.settings && results.settings.fee != null)
        ? results.settings.fee * 100
        : null,
      venue: (results.settings && results.settings.venue) || null,
    },
    // Numerator AND denominator, always. A rate without its population is the
    // specific dishonesty this route exists to prevent - the same failure as
    // the old realWorkRatePct that read 100% from an evidence-free file.
    honest_gate: {
      qualified_strict: totalQualified,
      combinations: totalCombinations,
      rate_pct: totalCombinations > 0
        ? Math.round((totalQualified / totalCombinations) * 100000) / 1000
        : null,
      basis: 'a combination qualifies only if: sample floor met, net-of-fee held-out return > 0, and a 95% CI on the mean per-trade net P&L excludes zero',
    },
    searches: classified,
  };
}

async function handler(req, res, deps) {
  const injected = deps || {};
  const readFile = injected.readFileSync || fs.readFileSync;
  const statFile = injected.statSync || fs.statSync;
  const now = injected.now ? injected.now() : Date.now();
  const target = injected.reportPath || REPORT_PATH;
  let report;
  let age;
  try {
    report = JSON.parse(readFile(target, 'utf8'));
    age = reportAgeMinutes(target, now);
    if (age === null && typeof statFile === 'function' && injected.statSync) {
      // reportAgeMinutes could not stat (injected fs lacks statSync); the age
      // is then unknown, and stale must be null, not a guess.
      age = undefined;
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.status(502).json({
        error: 'strategy-search report missing',
        detail: 'no report has been stored yet; the research loop writes one every ~30 minutes',
        report_path: REPORT_PATH,
      });
    } else {
      res.status(502).json({
        error: 'strategy-search report unreadable',
        detail: (error && error.message) || String(error),
        report_path: REPORT_PATH,
      });
    }
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.status(200).json(verdict(report, age));
}

function register(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('register(app) needs an express app');
  }
  // Idempotent by construction, the same remedy alphainsider_stats_route uses:
  // re-mounting replaces the existing layer instead of stacking a duplicate.
  if (!app._strategySearchRoute) {
    const stack = app._router && app._router.stack;
    if (Array.isArray(stack)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (layer && layer.route && layer.route.path === '/api/research/search') {
          stack.splice(i, 1);
        }
      }
    }
  }
  app._strategySearchRoute = true;
  app.get('/api/research/search', (req, res) => handler(req, res, options.deps || {}));
  return app;
}

module.exports = {
  register,
  verdict,
  classifySearch,
  handler,
  readReport,
  reportAgeMinutes,
  REPORT_PATH,
  STALE_MINUTES,
};
