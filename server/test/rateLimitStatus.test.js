'use strict';
// The rate-limit route used to answer `{}` after requiring the limiter without
// calling it. The obvious fix — call it — would have been worse than the stub, and
// this file is why.
//
// hive/lib/llm/rateLimit.js keeps token buckets in a module-private Map:
//
//     const bucket = buckets.get(key) || { tokens: rpm, lastRefill: now };
//     return { available: Math.floor(tokens), resetInMs: ... };
//
// Two consequences, and the route has to survive both:
//
//   1. For any key this process has never rate-limited, it reports a FULL bucket:
//      `available: rpm`. That number comes from the default it just substituted, so
//      drawing it as a green "N available" would be inventing capacity on a machine
//      that has never been asked for a token.
//   2. `buckets` is not exported, so nothing can enumerate the keys and prove which
//      scopes actually have a record.
//
// So the route reports `unobserved`, and the payload carries the reason rather than
// a number. Each test below is one of those two facts.

const test = require('node:test');
const assert = require('node:assert/strict');

const { rateLimitReport, OBSERVED, UNOBSERVED, UNAVAILABLE } = require('../rateLimitStatus.js');

const NOW = Date.parse('2026-10-04T13:30:00.000Z');

test('an unobserved scope reports no headroom at all, not a full bucket', () => {
  const report = rateLimitReport({ limiter: () => ({ available: 60, resetInMs: 0 }), key: 'pm-signal', rpm: 60, now: NOW });
  assert.equal(report.ok, false);
  assert.equal(report.status, UNOBSERVED);
  assert.equal(report.observed, false);
  assert.equal(report.headroom, null, 'a default-filled bucket must not surface as capacity');
  assert.equal(report.reset_in_ms, null);
  assert.match(report.reason, /does not list its keys/);
  assert.match(report.reason, /not a full bucket/);
});

test('the stub response shape no longer comes back empty', () => {
  // The old answer was res.json({}), which a floor could not distinguish from a
  // working route that had nothing to report.
  const report = rateLimitReport({ limiter: null, key: null, rpm: null, now: NOW });
  assert.ok(report.status, 'a status is always present');
  assert.ok(report.reason, 'and a reason');
  assert.equal(report.checked_at, new Date(NOW).toISOString());
  assert.deepEqual(report.requested, { key: null, rpm: null });
});

test('a limiter that cannot be loaded claims nothing', () => {
  const report = rateLimitReport({ limiter: null, error: 'Cannot find module', key: 'x', rpm: 10, now: NOW });
  assert.equal(report.status, UNAVAILABLE);
  assert.equal(report.ok, false);
  assert.equal(report.headroom, null);
  assert.match(report.reason, /Cannot find module/);
  assert.match(report.reason, /No headroom is claimed/);
});

test('a proven record does report numbers, so the shape need not change later', () => {
  const report = rateLimitReport({
    limiter: () => ({ available: 3, resetInMs: 4200 }),
    key: 'pm-risk', rpm: 60, hasRecord: true, now: NOW,
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, OBSERVED);
  assert.equal(report.headroom, 3);
  assert.equal(report.reset_in_ms, 4200);
  assert.equal(report.reason, null);
});

test('a record that proves nothing is still unobserved', () => {
  for (const reading of [null, undefined, {}, { available: 'lots' }, { available: NaN }]) {
    const report = rateLimitReport({ limiter: () => reading, key: 'k', rpm: 5, hasRecord: true, now: NOW });
    assert.equal(report.status, UNOBSERVED, `reading ${JSON.stringify(reading)} must not become headroom`);
    assert.equal(report.headroom, null);
  }
});

test('a missing reset time is null rather than zero', () => {
  // resetInMs: 0 would read as "resets immediately", which is a claim.
  const report = rateLimitReport({ limiter: () => ({ available: 1 }), key: 'k', rpm: 5, hasRecord: true, now: NOW });
  assert.equal(report.reset_in_ms, null);
});

test('a nonsense rpm is passed through as null rather than coerced', () => {
  assert.equal(rateLimitReport({ key: 'k', rpm: 'fast', now: NOW }).requested.rpm, null);
  assert.equal(rateLimitReport({ key: 'k', rpm: 30, now: NOW }).requested.rpm, 30);
});

test('the route is a GET and writes nothing', () => {
  // Structural: the answer must be readable from a tunnel and must not be a write.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = src.indexOf("app.get('/api/llm/rate-limits'");
  assert.ok(start > 0, 'route present');
  // Comments are stripped first, because this route's comment quotes the old
  // `res.json({})` in order to explain what was wrong with it. A test that cannot
  // tell a comment from code would forbid documenting the fix.
  const body = src.slice(start, src.indexOf('});', start)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(body, /rateLimitReport\(/, 'must go through the honest reporter');
  assert.doesNotMatch(body, /res\.json\(\{\}\)/, 'must not answer with the old empty object');
  assert.doesNotMatch(body, /isLocalRequest/, 'reading headroom is not a write; leaving it ungated on purpose');
});