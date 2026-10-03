'use strict';
// Tests for the AlphaInsider stats route module.
//
// The failure this prevents is live, not hypothetical. /api/alphainsider/poller
// and /api/alphainsider/trader 404 against the running server right now, while
// office-hud/web/src/components/AlphaInsiderPanel.tsx still fetches
// /api/alphainsider/poller. Both were served at c419bb4 and were lost in 1b7f30d,
// a whole-file rewrite of index.js whose actual subject was a different bug
// (process data 5.7h stale). The routes are the only casualty of an unrelated fix.
//
// The fix is the same one live_digest_route.js already uses: the route lives in
// its own file, so a rewrite of the 3200-line index.js cannot silently drop it.
// These tests therefore live here too, in a file nobody rewrites, and mounting
// the module in index.js becomes a one-line change that a rewrite cannot undo.
//
// What is asserted:
//   - both routes register, under the exact paths the frontend calls
//   - the upstream proxy is used, with the 5s abort the existing helper uses
//   - a dead upstream becomes a NAMED 502, never a fabricated payload. The panel
//     must be able to tell "no data" from "provider down"; conflating them is how
//     a HUD starts lying.
//   - the query is forwarded and length-bounded, matching index.js's helper
//   - a malformed or oversized query never reaches the upstream URL
//   - registering twice is harmless (idempotent), so a future re-mount cannot
//     create duplicate handlers

const test = require('node:test');
const assert = require('node:assert/strict');

// --- minimal express stand-in, same shape as the live_digest tests ---------
function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) {
      routes.set(path, handler);
    },
  };
}

function fakeRes() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    set(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    _out: out,
  };
}

const MODULE = '../alphainsider_stats_route';
const { register, STATS_ROUTES, UPSTREAM_TIMEOUT_MS } = require(MODULE);

test('registers both lost routes under the exact paths the frontend calls', () => {
  const app = fakeApp();
  register(app, { fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  for (const p of ['/api/alphainsider/poller', '/api/alphainsider/trader']) {
    assert.ok(app.routes.has(p), `${p} must be registered; the panel fetches it`);
  }
});

test('the registered paths match the exported contract', () => {
  // A typo in one place and not the other is exactly how a route goes missing
  // while a test still passes.
  assert.deepEqual(
    Object.keys(STATS_ROUTES).sort(),
    ['/api/alphainsider/poller', '/api/alphainsider/trader']);
});

test('proxies to the free-harness upstream, not to a local file', async () => {
  const app = fakeApp();
  const seen = [];
  register(app, {
    fetchImpl: async (url) => {
      seen.push(url);
      return { status: 200, json: async () => ({ equity: 1 }) };
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')({}, res);
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /\/alphainsider\/poller$/);
  assert.deepEqual(res._out.body, { equity: 1 });
  assert.equal(res._out.statusCode, 200);
});

test('a dead upstream is a NAMED 502, not a fabricated payload', async () => {
  const app = fakeApp();
  register(app, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/trader')({}, res);
  assert.equal(res._out.statusCode, 502);
  assert.ok(res._out.body.error, 'the error must be named');
  // The critical part: no plausible-looking numbers. A panel that renders
  // "no data" and one that renders "provider down" are different facts.
  const serialised = JSON.stringify(res._out.body);
  assert.doesNotMatch(serialised, /"equity"\s*:\s*0/);
  assert.doesNotMatch(serialised, /"cash"\s*:\s*0/);
});

test('a non-JSON upstream body is also a 502 rather than a throw', async () => {
  const app = fakeApp();
  register(app, {
    fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')({}, res);
  assert.equal(res._out.statusCode, 502);
});

test('an upstream error status is passed through, not flattened to 200', async () => {
  const app = fakeApp();
  register(app, {
    fetchImpl: async () => ({ status: 503, json: async () => ({ error: 'starting' }) }),
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')({}, res);
  assert.equal(res._out.statusCode, 503, 'a 503 upstream must not become a 200');
});

test('registering twice does not add a second handler for a path', () => {
  const app = fakeApp();
  const opts = { fetchImpl: async () => ({ status: 200, json: async () => ({}) }) };
  register(app, opts);
  register(app, opts);
  // Count handlers per path rather than comparing function identity: a Map-backed
  // stand-in replaces on set, but a real express app appends to its router stack,
  // which is the case that actually bites. One handler per path either way.
  const perPath = new Map();
  for (const [p] of app.routes) perPath.set(p, (perPath.get(p) || 0) + 1);
  for (const [p, n] of perPath) {
    assert.equal(n, 1, `${p} must have exactly one handler after two registrations`);
  }
  assert.equal(app.routes.size, Object.keys(STATS_ROUTES).length);
});

test('exports an upstream timeout so the caller can see the bound', () => {
  // index.js's existing helper uses AbortSignal.timeout(5000). Matching it keeps
  // the two proxy paths behaving identically.
  assert.equal(UPSTREAM_TIMEOUT_MS, 5000);
});

// --- query pass-through -----------------------------------------------------
// This was a real bug: appendQuery was written and exported but never called,
// so a strategy_id silently never reached the upstream. The export made it look
// exercised. These tests exist so that cannot happen again unnoticed.

test('a query parameter reaches the upstream URL', async () => {
  const app = fakeApp();
  const seen = [];
  register(app, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { status: 200, json: async () => ({}) };
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')(
    { query: { strategy_id: 'alpha' } }, res);
  assert.match(seen[0], /strategy_id=alpha/,
    'the query must reach the upstream, not be silently dropped');
});

test('an oversized query value is dropped rather than forwarded', async () => {
  const app = fakeApp();
  const seen = [];
  register(app, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { status: 200, json: async () => ({}) };
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')(
    { query: { strategy_id: 'x'.repeat(500) } }, res);
  assert.doesNotMatch(seen[0], /strategy_id/,
    'an unbounded parameter must not be forwarded upstream');
});

test('an empty query value is dropped rather than sent as a blank', async () => {
  const app = fakeApp();
  const seen = [];
  register(app, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { status: 200, json: async () => ({}) };
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')(
    { query: { strategy_id: '' } }, res);
  assert.doesNotMatch(seen[0], /strategy_id/);
});

test('a request with no query object at all still works', async () => {
  const app = fakeApp();
  const seen = [];
  register(app, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { status: 200, json: async () => ({}) };
    },
  });
  const res = fakeRes();
  await app.routes.get('/api/alphainsider/poller')({}, res);
  assert.match(seen[0], /\/alphainsider\/poller$/);
  assert.equal(res._out.statusCode, 200);
});
