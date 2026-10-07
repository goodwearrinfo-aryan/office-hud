'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The aggregator resolves its feed root at require time, so point the env var
// at a scratch tree before pulling the module in.
function loadWith(root) {
  process.env.OPENALICE_PUBLIC_ROOT = root;
  const modulePath = require.resolve('../lib/openalice');
  delete require.cache[modulePath];
  return require('../lib/openalice');
}

function writeFeed(root, name, body) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(body));
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openalice-route-'));
}

test('openaliceSnapshot reports a missing feed as missing, not as empty data', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  const snap = openaliceSnapshot();
  assert.equal(snap.feeds.legs.exists, false);
  assert.equal(snap.feeds.legs.state, 'missing');
  assert.equal(snap.legs, null, 'a missing feed must not be normalized into a fake summary');
});

test('openaliceSnapshot marks a fresh feed live and ages it from content, not mtime', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  writeFeed(root, 'legs.json', { generated_at: new Date().toISOString(), legs: [{ symbol: 'BTC/USDT', pos: 'LONG' }], mode: 'paper', execution_enabled: false });
  const snap = openaliceSnapshot();
  assert.equal(snap.feeds.legs.state, 'live');
  assert.equal(snap.legs.total, 1);
  assert.equal(snap.legs.active, 1);
  // The file was written just now, so an mtime-based freshness check would also
  // pass here; the assertion below is the one that matters for the next test.
  assert.ok(snap.feeds.legs.age_sec <= 5);
});

test('a feed whose writer has stopped reads stale/stalled even though the file parses', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  // Fresh content in a file written now, but carrying an old content timestamp:
  // this is exactly the case the :3002 dashboards call out, where a readable file
  // hides a dead writer.
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  writeFeed(root, 'tournament.json', { ts: old, leader: 'trend_btc_1h', cycles: 10, strategies: [] });
  const snap = openaliceSnapshot();
  assert.equal(snap.feeds.tournament.state, 'stalled');
  assert.ok(snap.feeds.tournament.age_sec > 3600);
});

test('an unparseable timestamp is unknown_age rather than silently fresh', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  writeFeed(root, 'heartbeat.json', { ts: 'not-a-timestamp', status: 'ok' });
  const snap = openaliceSnapshot();
  assert.equal(snap.feeds.heartbeat.state, 'unknown_age');
  assert.equal(snap.feeds.heartbeat.age_sec, null);
});

test('corrupt JSON degrades to missing instead of throwing', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  fs.writeFileSync(path.join(root, 'pipeline.json'), '{ this is not json');
  const snap = openaliceSnapshot();
  assert.equal(snap.feeds.pipeline.readable, true, 'the file is readable; it is the parse that fails');
  assert.equal(snap.pipeline, null);
});

test('combined_portfolio is surfaced for the F15 comparison, with audit fields intact', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  writeFeed(root, 'combined_portfolio.json', {
    ts: new Date().toISOString(),
    ok: true,
    combined: { equity: 101.5, net: 1.5, return_pct: 1.5 },
    components: { carry_btc: { weight: 0.5, net: 0.8 } },
    audit_reference: { sharpe: null, max_dd_pct: -4.2 },
    feed_degraded: false,
  });
  const snap = openaliceSnapshot();
  assert.equal(snap.combined_portfolio.combined.net, 1.5);
  assert.equal(snap.combined_portfolio.audit_reference.sharpe, null);
  assert.equal(snap.combined_portfolio.feed_degraded, false);
});

test('live_orders_allowed is carried through so the HUD cannot imply live trading', () => {
  const root = tmpRoot();
  const { openaliceSnapshot } = loadWith(root);
  writeFeed(root, 'paper-benchmark.json', { generated_at: new Date().toISOString(), mode: 'paper', live_orders_allowed: false, families: [] });
  const snap = openaliceSnapshot();
  assert.equal(snap.paper_benchmark.live_orders_allowed, false);
});

test('registerOpenAliceRoute answers with the snapshot', async () => {
  const root = tmpRoot();
  const { registerOpenAliceRoute } = loadWith(root);
  const routes = {};
  registerOpenAliceRoute({ get: (p, handler) => { routes[p] = handler; } });
  assert.ok(routes['/api/openalice'], 'the route must be registered');
  const payload = await new Promise(resolve => {
    routes['/api/openalice']({}, { json: resolve, set: () => {}, status: () => ({ json: resolve }) });
  });
  assert.equal(typeof payload.ts, 'string');
  assert.ok(payload.feeds, 'feeds block must exist even with nothing on disk');
  assert.equal(payload.feed_root, root);
});