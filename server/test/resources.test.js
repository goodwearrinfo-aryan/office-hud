'use strict';
// The resource table and the legacy REST routes must never disagree: the socket
// pushes a resource while panels may still poll its twin, and a divergence means
// the UI renders one shape after a push and another after a reload. This suite
// fetches both and compares.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => { await http?.close(); fixture.cleanup(); });

/** Paths that have a resource twin, and the query each needs. */
const TOWNS = [
  ['/api/summary', 'summary'],
  ['/api/agents', 'agents'],
  ['/api/queue', 'queue'],
  ['/api/projects', 'projects'],
  ['/api/sessions', 'sessions'],
  ['/api/processes', 'processes'],
  ['/api/verify', 'verify'],
  ['/api/office-manager', 'officeManager'],
  ['/api/services/health', 'services'],
  ['/api/harness/health', 'harness'],
  ['/api/llm/providers', 'providers'],
  ['/api/llm/costs', 'costs'],
  ['/api/llm/circuit-breakers', 'breakers'],
  ['/api/polymarket', 'polymarket'],
  ['/api/polymarket/markets', 'polymarketMarkets'],
  ['/api/polymarket/status', 'polymarketStatus'],
  ['/api/knowledge/graphify/communities', 'knowledge'],
  ['/api/knowledge/graphify', 'knowledgeStats'],
  ['/api/trading/backtests', 'tradingBacktests'],
  ['/api/trading/strategies', 'tradingStrategies'],
  ['/api/trading/ops', 'tradingOps'],
  ['/api/jarvis/tasks', 'jarvisTasks'],
  ['/api/events', 'events'],
];

/**
 * Fields that legitimately differ between two calls: timestamps and the
 * measurements taken while probing. Everything else must match exactly, because
 * a push and a poll of the same resource have to be the same payload.
 */
const VOLATILE = new Set([
  'checkedAt', 'checked_at', 'generatedAt', 'now', 'ts', 'at', 'updatedAt',
  'heartbeat_age_sec', 'latencyMs', 'ageMs', 'startedAt', 'endedAt',
]);

function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE.has(key)) continue;
      out[key] = normalise(value[key]);
    }
    return out;
  }
  return value;
}

for (const [path, resource] of TOWNS) {
  test(`${path} and /api/live/${resource} agree`, async () => {
    const legacy = await http.get(path);
    const pushed = await http.get(`/api/live/${resource}`);
    assert.equal(legacy.status, 200, `${path} should respond 200`);
    assert.equal(pushed.status, 200, `/api/live/${resource} should respond 200`);
    // The keys are the contract; values may move between two calls.
    assert.deepEqual(
      Object.keys(legacy.json ?? {}).sort(),
      Object.keys(pushed.json ?? {}).sort(),
      `${path} and /api/live/${resource} must expose the same top-level fields`
    );
    assert.deepEqual(normalise(legacy.json), normalise(pushed.json), `${path} payload drift`);
  });
}

test('a resource and its twin both degrade identically', async () => {
  // The fixture has no polymarket engine state, so both should report the same
  // degraded shape rather than one 500ing and the other explaining.
  const legacy = await http.get('/api/polymarket');
  const pushed = await http.get('/api/live/polymarket');
  assert.equal(legacy.status, 200);
  assert.equal(pushed.status, 200);
  assert.deepEqual(Object.keys(legacy.json).sort(), Object.keys(pushed.json).sort());
});

test('the resource table is the only place a producer is defined', () => {
  // A guard against the shape drifting back: every twin must exist as a resource
  // and every resource must be reachable through the mirror.
  const names = server.internals.resourceNames();
  for (const [, resource] of TOWNS) {
    assert.ok(names.includes(resource), `resource ${resource} should be registered`);
  }
  for (const name of names) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(server.internals.RESOURCES, name),
      `${name} must be in RESOURCES`
    );
  }
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });

test('stream telemetry is a resource and is never cached', async () => {
  const res = await http.get('/api/live/streamStatus');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.json.socketPath, 'telemetry reports its socket path');
  assert.ok(Number.isInteger(res.json.sequence));

  const status = await http.get('/api/live/status');
  assert.equal(status.status, 200);
  assert.deepEqual(
    Object.keys(status.json).sort(),
    Object.keys(res.json).sort(),
    'the telemetry route and its resource must agree'
  );
});

// ---- parameterized resources ----

test('an agent detail is reachable as a parameterized resource', async () => {
  const legacy = await http.get('/api/agents/worker-a');
  const pushed = await http.get('/api/live/agents/worker-a');
  assert.equal(legacy.status, 200);
  assert.equal(pushed.status, 200);
  assert.deepEqual(Object.keys(pushed.json).sort(), Object.keys(legacy.json).sort());
  assert.equal(pushed.json.agent.id, 'worker-a');
  assert.equal(pushed.json.identity, legacy.json.identity, 'the pushed payload is the route payload');
});

test('a ledger source is reachable as a parameterized resource', async () => {
  for (const source of ['events', 'log']) {
    const legacy = await http.get(`/api/ledger?source=${source}`);
    const pushed = await http.get(`/api/live/ledger/${source}`);
    assert.equal(pushed.status, 200, `ledger/${source} should resolve`);
    assert.equal(pushed.json.source, source);
    assert.equal(pushed.json.events.length, legacy.json.events.length);
  }
});

test('a parameterized key cannot escape the hive', async () => {
  // `agents` on its own is a legitimate resource (the list); only a malformed
  // *parameter* must fail.
  for (const key of [
    'agents/..%2F..%2Fetc%2Fpasswd', 'agents/', 'agents/.', 'ledger/../tasks',
    'ledger/events/extra', 'nope/anything',
  ]) {
    const res = await http.get(`/api/live/${key}`);
    assert.equal(res.status, 404, `${key} must not resolve`);
  }
});

test('the list and the detail are different resources under one family', async () => {
  const list = await http.get('/api/live/agents');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.agents), 'agents is the list');
  const detail = await http.get('/api/live/agents/worker-a');
  assert.equal(detail.status, 200);
  assert.ok(detail.json.agent, 'agents/<id> is one agent');
  assert.equal(detail.json.agents, undefined, 'the detail is not the list');
});

test('an unknown agent is a 404 from both paths', async () => {
  const legacy = await http.get('/api/agents/nobody');
  const pushed = await http.get('/api/live/agents/nobody');
  assert.equal(legacy.status, 404);
  assert.equal(pushed.status, 404);
});

test('parameterized resources are not advertised as fixed resources', async () => {
  const list = await http.get('/api/live/resources');
  const names = list.json.resources;
  assert.ok(!names.includes('agents/worker-a'), 'a concrete instance is not a registered resource');
  assert.ok(!names.some((name) => name.includes('/')), 'the advertised list has no parameterized entries');
  // but the base resources are still there
  assert.ok(names.includes('summary') && names.includes('queue'));
});

test('a repeated agent detail read is served from the short-lived cache', async () => {
  const { getAgentDetail } = server.internals;
  const first = getAgentDetail('worker-a');
  const second = getAgentDetail('worker-a');
  assert.equal(first, second, 'the same object is returned inside the TTL');
  assert.equal(first.agent.id, 'worker-a');
});
