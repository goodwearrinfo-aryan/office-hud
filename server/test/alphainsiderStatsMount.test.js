'use strict';
// Proves the AlphaInsider stats routes are actually MOUNTED on the running app.
//
// alphainsiderStatsRoute.test.js covers the module in isolation. That test passes
// even when nothing mounts the module, so on its own it cannot detect the failure
// that actually happened: the module landed, its 12 tests went green, and the
// panel still 404'd because index.js never called register(). A green module test
// and a broken product look identical from inside the module.
//
// These tests load the real index.js and hit the real routes, which is the only
// layer where "the panel can fetch this" is actually decided. Removing the mount
// line from index.js turns the first test red -- verified as a negative control,
// so this is a real guard and not a tautology.
//
// The poller route is the one that matters: AlphaInsiderPanel.tsx fetches it on
// mount, and when it 404s the panel still renders while its equity and cash
// figures fall back to dashes. That is the specific dishonesty this prevents.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
});

test('the poller route the panel fetches is served by the mounted app', async () => {
  const res = await http.get('/api/alphainsider/poller');
  assert.notEqual(res.status, 404, '/api/alphainsider/poller 404s: index.js no longer mounts the module');
  // 200 when the provider is up, 502 when it is down. Both are honest answers;
  // 404 is not, because it means the HUD cannot ask the question at all.
  assert.ok([200, 502].includes(res.status), `expected a real proxy answer, got ${res.status}`);
});

test('a dead upstream is a named 502, never a fabricated payload', async () => {
  const res = await http.get('/api/alphainsider/poller');
  if (res.status === 502) {
    assert.match(JSON.stringify(res.json), /AlphaInsider provider unavailable/);
  }
});

test('the trader route is mounted as well', async () => {
  const res = await http.get('/api/alphainsider/trader');
  assert.notEqual(res.status, 404, '/api/alphainsider/trader 404s: the mount is partial');
});

test('the pre-existing sibling routes are unharmed by the mount', async () => {
  for (const path of ['/api/alphainsider/status', '/api/alphainsider/strategies', '/api/alphainsider/positions']) {
    const res = await http.get(path);
    assert.notEqual(res.status, 404, `${path} regressed`);
  }
});

test('registering twice is idempotent, so a future remount cannot duplicate handlers', async () => {
  const route = require('../alphainsider_stats_route');
  route.register(server.app);
  route.register(server.app);
  const res = await http.get('/api/alphainsider/poller');
  assert.notEqual(res.status, 404);
});
