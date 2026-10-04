'use strict';
// Tests for the strategy-search honest verdict route.
//
// The search now measures edge honestly; this route surfaces that verdict to
// the HUD. The failure modes these tests prevent are the ones that made the
// old HUD lie: a rate shown without its population, a stale number posing as
// fresh truth, a missing source rendered as a plausible empty payload, and the
// three honest states (significantly negative / luck / positive) collapsed
// into one unexplained number.
//
// What is asserted:
//   - the route registers under the exact path the UI will call
//   - a missing report becomes a NAMED 502 carrying the cause, never a
//     fabricated payload
//   - an unreadable (malformed) report becomes a different NAMED 502
//   - the honest gate always publishes numerator AND denominator, plus the
//     basis a reader needs to reproduce the number
//   - the three states are classified separately: ci_high < 0 is
//     significantly_negative, a straddling CI is luck, low > 0 is positive
//   - an unmeasured CI (no numbers) counts in none of the three buckets
//   - a stale report (older than 90 minutes) is flagged, not shown as fresh
//   - zero combinations means rate_pct is null, not 0 or a division error
//   - registering twice is harmless (idempotent)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROUTE = require('../strategy_search_route');

// --- minimal express stand-in, same shape as the existing route tests ------
function fakeApp() {
  const routes = new Map();
  return {
    routes,
    _router: { stack: [] },
    get(p, handler) {
      routes.set(p, handler);
    },
  };
}

function fakeRes() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    set(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    out,
  };
}

function reportFixture(overrides) {
  const base = {
    generated_at: '2026-09-30T09:43:30+00:00',
    results: {
      mode: 'paper-research',
      leverage: 1.0,
      settings: { fee: 0.001, initial: 10000.0, split_ratio: 0.7, venue: 'binance_spot' },
      searches: [],
      qualifying_count: 0,
      qualified_strict_count: 0,
    },
  };
  return Object.assign(base, overrides || {});
}

function searchFixture(overrides) {
  const base = {
    timeframe: '5m',
    strategies: ['a@5m', 'b@5m'],
    evaluated: 36,
    combinations: 7175,
    qualifying: [],
    qualified_strict: [],
    closest: [],
    errors: [],
  };
  return Object.assign(base, overrides || {});
}

function candidateFixture(overrides) {
  const base = {
    strategies: ['a@5m'],
    return_pct: -10.0,
    win_rate_pct: 40.0,
    trades: 100,
    wins: 40,
    train_return_pct: -5.0,
    test_return_pct: -12.0,
    test_trades: 100,
    test_wins: 40,
    edge_ci_measurable: true,
    edge_pnl_sample: 100,
    ci_low_edge_pnl: -17.91,
    ci_high_edge_pnl: -10.09,
    ci_includes_zero: false,
    ci_low_win_rate_pct: 31.0,
    ci_high_win_rate_pct: 49.5,
    worst_component_drawdown_pct: -30.0,
  };
  return Object.assign(base, overrides || {});
}

test('registers under the exact path the UI will call', () => {
  const app = fakeApp();
  ROUTE.register(app);
  assert.ok(app.routes.has('/api/research/search'));
});

test('registering twice is harmless - no duplicate handler', () => {
  const app = fakeApp();
  ROUTE.register(app);
  ROUTE.register(app);
  assert.equal(app.routes.size, 1);
});

test('register(app) rejects a non-express stand-in', () => {
  assert.throws(() => ROUTE.register({}), TypeError);
});

test('missing report becomes a NAMED 502, never a fabricated payload', async () => {
  const app = fakeApp();
  ROUTE.register(app, {
    deps: {
      reportPath: '/definitely/not/here/latest.json',
      readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/research/search')({}, res);
  assert.equal(res.out.statusCode, 502);
  assert.equal(res.out.body.error, 'strategy-search report missing');
  assert.ok(res.out.body.detail.includes('no report'));
  assert.equal(res.out.body.report_path, ROUTE.REPORT_PATH);
});

test('malformed report becomes a different NAMED 502', async () => {
  const app = fakeApp();
  ROUTE.register(app, {
    deps: {
      reportPath: '/tmp/malformed.json',
      readFileSync: () => '{not json',
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/research/search')({}, res);
  assert.equal(res.out.statusCode, 502);
  assert.equal(res.out.body.error, 'strategy-search report unreadable');
});

test('the honest gate publishes numerator AND denominator plus its basis', () => {
  const searches = [searchFixture({
    closest: [candidateFixture()],
    qualified_strict: [],
  })];
  const results = Object.assign(reportFixture().results, { searches });
  const v = ROUTE.verdict(reportFixture({ results }), 12);
  assert.equal(v.honest_gate.qualified_strict, 0);
  assert.equal(v.honest_gate.combinations, 7175);
  assert.equal(v.honest_gate.rate_pct, 0);
  assert.ok(v.honest_gate.basis.includes('CI'));
  assert.ok(v.honest_gate.basis.includes('net-of-fee'));
});

test('significantly negative, luck, and positive are three separate states', () => {
  const searches = [searchFixture({
    combinations: 3,
    closest: [
      candidateFixture({ ci_low_edge_pnl: -17.91, ci_high_edge_pnl: -10.09 }),
      candidateFixture({ strategies: ['b@5m'], ci_low_edge_pnl: -5.0, ci_high_edge_pnl: 5.0 }),
      candidateFixture({ strategies: ['c@5m'], ci_low_edge_pnl: 2.0, ci_high_edge_pnl: 9.0 }),
    ],
  })];
  const v = ROUTE.verdict(reportFixture({ results: Object.assign(reportFixture().results, { searches }) }), 5);
  const s = v.searches[0];
  assert.equal(s.significantly_negative, 1);
  assert.equal(s.luck_indistinguishable, 1);
  assert.equal(s.positive_excluding_zero, 1);
  assert.equal(s.measurable, 3);
});

test('an unmeasured CI counts in none of the three buckets', () => {
  const searches = [searchFixture({
    combinations: 1,
    closest: [candidateFixture({ ci_low_edge_pnl: null, ci_high_edge_pnl: null })],
  })];
  const v = ROUTE.verdict(reportFixture({ results: Object.assign(reportFixture().results, { searches }) }), 5);
  const s = v.searches[0];
  assert.equal(s.measurable, 0);
  assert.equal(s.significantly_negative, 0);
  assert.equal(s.luck_indistinguishable, 0);
  assert.equal(s.positive_excluding_zero, 0);
  assert.equal(s.best.edge_ci, 'not_measured');
});

test('a stale report is flagged, not shown as fresh truth', () => {
  const v = ROUTE.verdict(reportFixture(), 91);
  assert.equal(v.stale, true);
  assert.equal(v.report_age_minutes, 91);
  const fresh = ROUTE.verdict(reportFixture(), 30);
  assert.equal(fresh.stale, false);
});

test('stale is null when the age is unknown - not a guess', () => {
  const v = ROUTE.verdict(reportFixture());
  assert.equal(v.stale, null);
  assert.equal(v.report_age_minutes, null);
});

test('fee comes from settings, converted to percent, with its venue', () => {
  const v = ROUTE.verdict(reportFixture(), 10);
  assert.equal(v.fee.per_side_pct, 0.1);
  assert.equal(v.fee.venue, 'binance_spot');
});

test('zero combinations means rate_pct is null - not 0, not a crash', () => {
  const v = ROUTE.verdict(reportFixture(), 10);
  assert.equal(v.honest_gate.combinations, 0);
  assert.equal(v.honest_gate.rate_pct, null);
});

test('verdict on a missing report explains itself', () => {
  const v = ROUTE.verdict(null);
  assert.ok(v.error.includes('no report'));
  assert.ok(v.hint.includes('research loop'));
});

test('searches carry their symbol; stored reports without one default to BTCUSDT', () => {
  const withSymbol = searchFixture({ symbol: 'SPY', timeframe: '1d', combinations: 5 });
  const v1 = ROUTE.verdict(reportFixture({ results: Object.assign(reportFixture().results, { searches: [withSymbol] }) }), 5);
  assert.equal(v1.searches[0].symbol, 'SPY');
  assert.equal(v1.searches[0].timeframe, '1d');
  const withoutSymbol = searchFixture({ timeframe: '5m', combinations: 7 });
  const v2 = ROUTE.verdict(reportFixture({ results: Object.assign(reportFixture().results, { searches: [withoutSymbol] }) }), 5);
  assert.equal(v2.searches[0].symbol, 'BTCUSDT');
});

test('the live report, if present, classifies honestly', () => {
  const report = ROUTE.readReport();
  if (!report) return; // no report on this host - the 502 test covers it
  const v = ROUTE.verdict(report, 1);
  assert.equal(typeof v.honest_gate.combinations, 'number');
  assert.equal(typeof v.honest_gate.qualified_strict, 'number');
  for (const s of v.searches) {
    assert.equal(s.measurable,
      s.significantly_negative + s.luck_indistinguishable + s.positive_excluding_zero);
  }
});
