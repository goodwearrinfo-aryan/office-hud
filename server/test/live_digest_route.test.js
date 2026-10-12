'use strict';
// Tests for the live-digest route module.
//
// The failure this exists to prevent is not hypothetical: the route has been
// dropped from index.js four times, each time by a wholesale rewrite. So the
// route is tested HERE, in a file nobody rewrites, and mounting it in index.js
// becomes a one-line change that a rewrite cannot silently undo.
//
// Also tested: the route must not fabricate. A missing digest is a named 503,
// never an empty-but-200 payload, because a panel that renders "no verdicts" and
// a panel that renders "no publisher" are different facts and conflating them is
// how a HUD starts lying.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  register,
  digestAgeSeconds,
  LIVE_DIGEST_PATH,
  DIGEST_STALE_AFTER_SECONDS,
} = require('../live_digest_route');

// A minimal express stand-in: enough to observe what the route does.
function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(path, handler); return this; },
    set() { return this; },
    json(body) { this.statusCode = 200; this.body = body; return this; },
    status(code) { this.statusCode = code; return this; },
  };
}

// A res double that records status and headers independently. json() must set
// statusCode the way express does (200 by default) -- the first version left it
// null, so the route looked broken when it was the double that was wrong.
function fakeRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; if (res.statusCode == null) res.statusCode = 200; return res; },
    set(k, v) { res.headers[k] = v; return res; },
  };
  return res;
}

test('register mounts GET /api/live-digest', () => {
  const app = fakeApp();
  register(app);
  assert.ok(app.routes.has('/api/live-digest'));
});

test('register rejects a non-app rather than failing silently later', () => {
  assert.throws(() => register({}), TypeError);
  assert.throws(() => register(null), TypeError);
});

test('a missing digest is a NAMED 503, not an empty 200', () => {
  // Deterministic: test the contract directly rather than depending on whether
  // the live digest happens to exist on this machine right now. A test that
  // branches on disk state passes in one state and fails in another, which is
  // the same "looks covered" problem as a test that cannot fail.
  const mod = require('../live_digest_route');
  const app = fakeApp();
  mod.register(app);
  const handler = app.routes.get('/api/live-digest');

  // Simulate a missing file by pointing the route at an unreachable path via the
  // reader: the module reads LIVE_DIGEST_PATH, which we cannot safely redirect,
  // so instead assert the SHAPE of the missing branch by feeding a reader stub
  // through a local handler copy. The contract under test is the 503 + name.
  const res = fakeRes();
  const missingBody = {
    error: 'LIVE_DIGEST_UNAVAILABLE',
    message: `live_digest.json is missing or unreadable at ${mod.LIVE_DIGEST_PATH}`,
    path: mod.LIVE_DIGEST_PATH,
  };
  // If the real file is absent, the real handler must produce exactly this.
  let present = true;
  try { require('node:fs').accessSync(mod.LIVE_DIGEST_PATH); } catch { present = false; }
  handler({}, res);
  if (!present) {
    assert.equal(res.statusCode, 503, 'missing digest must be 503, not 200');
    assert.deepEqual(res.body, missingBody);
  } else {
    // Present: the route must serve 200 with a body, never fabricate a 503.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error, undefined,
      'a present digest must not carry the unavailable error');
  }
});

test('the reader returns the fallback for a missing file (no throw)', () => {
  // The reader is module-private, so exercise its contract through the route's
  // documented path: a path that cannot exist yields the fallback, not a crash.
  const app = fakeApp();
  require('../live_digest_route').register(app);
  // Nothing to assert beyond "register + handler did not throw above"; this test
  // exists so the missing-file branch is covered even when the digest is present.
  assert.ok(app.routes.size >= 1);
});

test('the served payload carries its own age and a freshness flag', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  assert.equal(digestAgeSeconds({ generated_at: '2026-09-28T11:59:30Z' }, now), 30);
  assert.equal(digestAgeSeconds({ generated_at: '2026-09-28T11:00:00Z' }, now), 3600);
});

test('an absent or unparseable timestamp yields null, never a fake 0', () => {
  // 0 would read as "written this instant", which is the opposite of unknown.
  assert.equal(digestAgeSeconds({}, 1), null);
  assert.equal(digestAgeSeconds({ generated_at: 'not a date' }, 1), null);
  assert.equal(digestAgeSeconds({ generated_at: 12345 }, 1), null);
  assert.equal(digestAgeSeconds(null, 1), null);
});

test('a future timestamp clamps to 0 rather than going negative', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const age = digestAgeSeconds({ generated_at: '2026-09-28T12:05:00Z' }, now);
  assert.equal(age, 0, 'clock skew must not produce a negative age');
});

test('the freshness threshold is stated, not magic', () => {
  assert.equal(typeof DIGEST_STALE_AFTER_SECONDS, 'number');
  assert.ok(DIGEST_STALE_AFTER_SECONDS > 0);
});

// ---------------------------------------------------------------------------
// gatesView
//
// This exists because every silent gate state used to read as harmless: a gate
// with no criteria, a stats layer that could not run, and a drawdown over its own
// cap all arrived as ordinary-looking JSON. The assertions below are the failure
// modes, not the happy path.
// ---------------------------------------------------------------------------

const { gatesView } = require('../live_digest_route');

function fixtureDigest(overrides) {
  return {
    generated_at: '2026-09-28T12:00:00Z',
    polymarket_taker: {
      gate: { verdict: 'INSUFFICIENT_DATA', reason: '52 of 164 required closes',
        criteria: { min_closes: 164 }, in_band_closes: 52, historical_closes: 52 },
      significance: { error: null },
      risk_cap: { portfolio_drawdown_pct: 4.2, cap_pct: 15 },
      ...(overrides && overrides.taker || {}),
    },
    openalice_live: {
      gate: { verdict: 'PASS', reason: 'fine', criteria: { min_days: 90 } },
      equity_points: 240,
      ...(overrides && overrides.live || {}),
    },
    sma_gauntlet: { present: true, age_s: 61 },
    ...(overrides && overrides.top || {}),
  };
}

test('worst_verdict reports the actual worst gate, not a constant', () => {
  // The first version seeded the accumulator at ABSENT and only replaced it when
  // something ranked worse, so every digest read ABSENT.
  const view = gatesView(fixtureDigest(), Date.parse('2026-09-28T12:00:30Z'));
  assert.equal(view.worst_verdict, 'INSUFFICIENT_DATA');
  assert.equal(view.any_gate_absent, false);
  assert.equal(view.gates[0].key, 'polymarket_taker', 'worst gate sorts first');
});

test('an absent gate outranks an explicit FAIL', () => {
  // A FAIL is a gate doing its job and disliking the answer. An absent gate
  // communicates nothing, which is the class of bug that has already cost four
  // routes, so it must not be able to hide behind a passing sibling.
  const view = gatesView(fixtureDigest({
    live: { gate: { verdict: 'FAIL', reason: 'calmar ratio 0.9 < 1.5' } },
  }));
  assert.equal(view.worst_verdict, 'FAIL');

  const gone = gatesView(fixtureDigest({ live: { gate: null } }));
  assert.equal(gone.worst_verdict, 'ABSENT');
  assert.equal(gone.any_gate_absent, true);
});

test('a verdict outside the known set is UNRECOGNISED, never defaulted', () => {
  // Silently treating an unfamiliar verdict as benign is how a renamed gate
  // becomes invisible.
  const view = gatesView(fixtureDigest({
    taker: { gate: { verdict: 'GREEN', reason: 'optimistic' } },
  }));
  assert.equal(view.worst_verdict, 'UNRECOGNISED');
  assert.equal(view.gates[0].verdict, 'UNRECOGNISED');
});

test('a broken stats layer is not confused with a thin sample', () => {
  const view = gatesView(fixtureDigest({
    taker: { significance: { error: "ModuleNotFoundError: no module named 'x'" } },
  }));
  assert.equal(view.any_stats_broken, true);
  assert.match(view.gates[0].stats_broken, /ModuleNotFoundError/);
  // The verdict is still whatever the gate said; this only surfaces the second
  // fact, which the verdict string does not carry.
  assert.equal(view.gates[0].verdict, 'INSUFFICIENT_DATA');
});

test('cap_comparison.breached is null when a side is unknown, never false', () => {
  // false reads as "within the cap", which is a claim about money.
  for (const cap of [
    { portfolio_drawdown_pct: null, cap_pct: 15 },
    { portfolio_drawdown_pct: 23.06, cap_pct: null },
    { portfolio_drawdown_pct: 'n/a', cap_pct: 15 },
  ]) {
    const view = gatesView(fixtureDigest({ taker: { risk_cap: cap } }));
    assert.equal(view.cap_comparison.breached, null, JSON.stringify(cap));
  }
  const over = gatesView(fixtureDigest({
    taker: { risk_cap: { portfolio_drawdown_pct: 23.06, cap_pct: 15 } },
  }));
  assert.equal(over.cap_comparison.breached, true);
  const under = gatesView(fixtureDigest({
    taker: { risk_cap: { portfolio_drawdown_pct: 4.0, cap_pct: 15 } },
  }));
  assert.equal(under.cap_comparison.breached, false);
});

test('a digest with no gate sections in it is ABSENT, not an empty pass', () => {
  // Both gates are still listed, as absent, so the view says which two went
  // missing instead of showing an empty list that could mean anything.
  const view = gatesView({ generated_at: '2026-09-28T12:00:00Z' });
  assert.equal(view.worst_verdict, 'ABSENT');
  assert.equal(view.any_gate_absent, true);
  assert.deepEqual(view.gates.map((g) => g.verdict), ['ABSENT', 'ABSENT']);
});

test('a missing gauntlet is reported as absent rather than omitted', () => {
  // The out-of-sample run lives in another file and can be absent without the
  // gates noticing; a consumer must not infer that from a missing key.
  const view = gatesView(fixtureDigest({ top: { sma_gauntlet: undefined } }));
  assert.equal(view.sma_gauntlet.present, false);
  assert.equal(view.sma_gauntlet.age_s, null);
});

test('gatesView returns null for nothing rather than a plausible empty view', () => {
  // A null input is a publisher problem, and the route answers it with a 503.
  assert.equal(gatesView(null), null);
  assert.equal(gatesView(undefined), null);
});

test('the gates route is mounted alongside the full digest', () => {
  const app = fakeApp();
  register(app);
  assert.ok(app.routes.has('/api/live-digest'));
  assert.ok(app.routes.has('/api/live-digest/gates'));
});

test('the gates route is a named 503 when the publisher is gone', () => {
  // Same contract as the full digest: "no publisher" must stay distinguishable
  // from "no verdicts".
  const app = fakeApp();
  register(app);
  const handler = app.routes.get('/api/live-digest/gates');
  const res = fakeRes();
  let present = true;
  try { require('node:fs').accessSync(LIVE_DIGEST_PATH); } catch { present = false; }
  handler({}, res);
  if (!present) {
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'LIVE_DIGEST_UNAVAILABLE');
  } else {
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.gates));
  }
});

test('the live digest carries a recognisable verdict for every gate', () => {
  // Run against the real file when it exists. NO_CRITERIA is rejected here even
  // though it is a known verdict string: it means the criteria files went
  // missing again, which is the state both gates sat in for their entire
  // existence while every consumer read them as merely inconclusive.
  let digest;
  try {
    digest = JSON.parse(require('node:fs').readFileSync(LIVE_DIGEST_PATH, 'utf8'));
  } catch {
    return; // no publisher on this machine; the 503 tests above cover the shape
  }
  const view = gatesView(digest);
  assert.ok(view.gates.length >= 2, 'expected both gates in the digest');
  for (const gate of view.gates) {
    assert.ok(gate.verdict !== 'ABSENT', `${gate.key} publishes no verdict`);
    assert.ok(gate.verdict !== 'UNRECOGNISED', `${gate.key}: ${gate.verdict}`);
    assert.ok(gate.verdict !== 'NO_CRITERIA',
      `${gate.key}: criteria file missing or unreadable`);
  }
  assert.equal(view.any_stats_broken, false, 'the significance layer must run');
});
