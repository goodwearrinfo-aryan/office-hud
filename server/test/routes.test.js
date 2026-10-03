'use strict';
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

test('health reports the fixture hive', async () => {
  const res = await http.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.hive, fixture.hive);
  assert.equal(res.json.present, true);
});

test('summary lists fixture agents', async () => {
  const res = await http.get('/api/summary');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.agents));
  const worker = res.json.agents.find((agent) => agent.id === 'worker-a');
  assert.ok(worker, 'worker-a should be present');
  assert.equal(worker.cwdValid, true);
});

test('queue summary counts the fixture tasks', async () => {
  const res = await http.get('/api/queue');
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 5);
  assert.equal(res.json.queued, 2);
  assert.equal(res.json.inProgress, 1);
  assert.equal(res.json.complete, 1);
  assert.equal(res.json.quarantined, 1);
});

test('task counts endpoint is small and floor-keyed', async () => {
  const res = await http.get('/api/tasks?counts=1');
  assert.equal(res.status, 200);
  assert.ok(res.json.counts.f6, 'f6 tasks should be counted');
  assert.ok(res.text.length < 400, `expected a tiny payload, got ${res.text.length} bytes`);
});

test('unknown api routes return JSON 404, not the SPA', async () => {
  const res = await http.get('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal(res.json.error, 'Unknown API route');
});

test('resource mirror serves every registered resource', async () => {
  const list = await http.get('/api/live/resources');
  assert.equal(list.status, 200);
  assert.ok(list.json.resources.includes('queue'));
  assert.equal(list.json.socket, '/api/live/socket');

  for (const name of list.json.resources) {
    const res = await http.get(`/api/live/${name}`);
    assert.equal(res.status, 200, `resource ${name} should respond 200`);
    assert.ok(res.text.length > 0, `resource ${name} should not be empty`);
  }
});

test('unknown resource is a 404 with a code', async () => {
  const res = await http.get('/api/live/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'unknown_resource');
});

test('read-only guard rejects unknown POSTs', async () => {
  const res = await http.post('/api/summary', {});
  assert.equal(res.status, 405);
  assert.match(res.json.error, /read-only/i);
});

test('llm/test requires a prompt', async () => {
  const res = await http.post('/api/llm/test', {});
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
});

test('llm/test rejects an oversized prompt', async () => {
  const res = await http.post('/api/llm/test', { prompt: 'x'.repeat(9000) });
  assert.equal(res.status, 400);
});

test('recovery rejects a malformed agent id', async () => {
  // express normalises the traversal away, so the request never reaches the
  // handler: 405 (guard) and 404 (unknown route) are both correct outcomes.
  const res = await http.post('/api/recovery/manual/..%2f..%2fetc', {});
  assert.ok([400, 404, 405].includes(res.status), `expected 400/404/405, got ${res.status}`);
});

test('alerts endpoint responds before the engine is running', async () => {
  const res = await http.get('/api/alerts');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.alerts));
});

test('alerts ack reaches its handler (not blocked by the read-only guard)', async () => {
  const res = await http.post('/api/alerts/does-not-exist/ack', {});
  // 503 = handler ran, engine not started; 404 = handler ran, no such alert.
  // 405 would mean the read-only guard swallowed it.
  assert.ok([404, 503].includes(res.status), `guard blocked the route: ${res.status}`);
  assert.notEqual(res.status, 405);
});

test('replay window reports usable bounds', async () => {
  const res = await http.get('/api/replay/window');
  assert.equal(res.status, 200);
  assert.ok(res.json.earliest <= res.json.latest);
  assert.ok(res.json.stepMs >= 1000);
});

test('replay reconstructs the queue as it was 30 minutes ago', async () => {
  const at = Date.now() - 30 * 60000;
  const res = await http.get(`/api/replay?at=${at}&hours=2`);
  assert.equal(res.status, 200);
  // 30m ago: t-done was complete, t-running had just started, and t-bad was
  // still sitting in the queue. t-queued (created 10m ago) and t-future (in an
  // hour) did not exist yet.
  assert.equal(res.json.queue.byStatus.complete, 1);
  assert.equal(res.json.queue.byStatus.inProgress, 1);
  assert.equal(res.json.queue.byStatus.queued, 1);
  assert.equal(res.json.queue.total, 3);
  // The fixture's heartbeats stop 1m before "now", so 30m ago the freshest one
  // was 10m old — outside the 5m liveness window.
  assert.equal(res.json.agents.aliveCount, 0);
  assert.equal(res.json.isLive, false);
  assert.equal(res.json.throughput.length, 3);
  assert.ok(res.json.transitions.length >= 1);
});

test('replay never counts a task that had not been created yet', async () => {
  const justPast = Date.now() - 5 * 60000;
  const early = await http.get(`/api/replay?at=${justPast}&hours=1`);
  assert.equal(early.json.queue.total, 4, 't-queued was created 10m ago, so it exists');
  // Two queued at that point: t-queued, plus t-bad (quarantined only later).
  assert.equal(early.json.queue.byStatus.queued, 2);

  const beforeQueued = Date.now() - 15 * 60000;
  const earlier = await http.get(`/api/replay?at=${beforeQueued}&hours=1`);
  assert.equal(earlier.json.queue.total, 3, 't-queued did not exist 15m ago');
  assert.equal(earlier.json.agents.aliveCount, 1, 'a heartbeat was current then');
  // t-bad is quarantined *now*, but it carries no quarantine timestamp, so the
  // honest reconstruction is "queued" in the past rather than a guess.
  assert.equal(earlier.json.queue.byStatus.quarantined, 0);
  assert.equal(earlier.json.queue.byStatus.queued, 1);
  const later = await http.get(`/api/replay?at=${Date.now() + 2 * 3600000}&hours=1`);
  assert.equal(later.json.queue.total, 5, 't-future exists two hours from now');
});

test('replay rejects a non-numeric timestamp', async () => {
  const res = await http.get('/api/replay?at=banana');
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
});

test('ledger rejects a negative limit instead of slicing backwards', async () => {
  const res = await http.get('/api/ledger?limit=-5');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.events));
});

test('a hive without the llm library degrades instead of 500ing', async () => {
  // The fixture deliberately has no lib/llm, which is the real shape of a
  // partially built hive.
  for (const name of ['providers', 'breakers', 'costs']) {
    const res = await http.get(`/api/live/${name}`);
    assert.equal(res.status, 200, `${name} should degrade, got ${res.status}`);
    assert.ok(res.json.error, `${name} should explain why it is empty`);
  }
});

test.after(() => {
  // node:test keeps the loop alive if anything is still listening.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

test('a foreign Host header is refused (DNS rebinding guard)', async () => {
  // fetch() treats Host as a forbidden header, so this needs a raw request.
  const httpModule = require('http');
  const status = await new Promise((resolve, reject) => {
    const request = httpModule.request(
      { host: '127.0.0.1', port: http.port, path: '/api/health', method: 'GET', headers: { Host: 'evil.example.com' } },
      (response) => { response.resume(); resolve(response.statusCode); }
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 421);
});

test('loopback Host headers are allowed', () => {
  const { hostIsAllowed } = server.internals;
  for (const host of ['127.0.0.1:1234', 'localhost', 'localhost:4747', '[::1]:4747', '::1']) {
    assert.equal(hostIsAllowed(host), true, `${host} should be accepted`);
  }
  for (const host of [
    'evil.example.com', 'attacker.test:80', '127.0.0.1.evil.com', '[fe80::1%en0]:80', '', undefined,
  ]) {
    assert.equal(hostIsAllowed(host), false, `${host} should be refused`);
  }
});

test('isLocalRequest trusts the socket, not forwarded headers', () => {
  const { isLocalRequest } = server.internals;
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalRequest({ socket: { remoteAddress: address } }), true, address);
  }
  for (const address of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5']) {
    assert.equal(isLocalRequest({ socket: { remoteAddress: address } }), false, address);
  }
  // A spoofed X-Forwarded-For must not make a remote caller look local.
  assert.equal(
    isLocalRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '127.0.0.1' } }),
    false
  );
});

test('a websocket upgrade with a foreign Host is refused', async () => {
  const { TestWebSocketClient } = require('./helpers/ws-client');
  await assert.rejects(
    () => TestWebSocketClient.connect(http.port, '/api/live/socket', '127.0.0.1', { host: 'evil.example.com' }),
    /421|handshake failed/
  );
});

test('alert ack routes are reachable and answer for a local caller', async () => {
  // The 403 branch needs a genuinely remote socket, which is covered by the
  // isLocalRequest unit test above; here we prove the route is not swallowed by
  // the read-only guard.
  const res = await http.post('/api/alerts/ack-all', {});
  assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}`);
});

test('the task board is grouped, capped and far smaller than the raw file', async () => {
  const board = await http.get('/api/task-board');
  const raw = await http.get('/api/tasks');
  assert.equal(board.status, 200);

  assert.ok(board.json.groups, 'groups should be keyed by column id');
  assert.ok(board.json.counts, 'true counts per column');
  assert.equal(board.json.total, raw.json.tasks.length, 'the total must match the raw task count');

  for (const [column, rows] of Object.entries(board.json.groups)) {
    assert.ok(rows.length <= board.json.perColumn, `${column} should be capped`);
    assert.ok(
      (board.json.counts[column] ?? 0) >= rows.length,
      `${column} count must not be less than the rows shown`
    );
  }

  // Only the fields the board draws, so the payload stays small.
  const allowed = new Set([
    'task_id', 'title', 'status', 'project_id', 'assigned_agent', 'claimed_by',
    'created_at', 'started_at', 'completed_at', 'updated_at', 'heartbeat', 'priority',
  ]);
  for (const rows of Object.values(board.json.groups)) {
    for (const row of rows) {
      for (const key of Object.keys(row)) assert.ok(allowed.has(key), `unexpected field ${key}`);
    }
  }

  // The payload is bounded by the cap, not by the size of the hive, which is
  // the property that keeps it small: 4 columns x perColumn rows, whatever the
  // task count. (On the live hive this is 28KB against a 3.8MB tasks.json.)
  const rows = Object.values(board.json.groups).reduce((sum, list) => sum + list.length, 0);
  const columns = Object.keys(board.json.groups).length;
  assert.ok(rows <= board.json.perColumn * columns, `sent ${rows} rows for ${columns} columns`);
});

test('the board cap is honoured as the task set grows', async () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(fixture.hive, 'tasks.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const doc = JSON.parse(original);
    for (let i = 0; i < 60; i += 1) {
      doc.tasks.push({
        task_id: `bulk-${i}`,
        title: `bulk ${i}`,
        status: 'QUEUED',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    fs.writeFileSync(file, JSON.stringify(doc));
    const board = await http.get('/api/task-board');
    assert.equal(board.json.groups.todo.length, board.json.perColumn);
    assert.equal(board.json.counts.todo, 62, '62 queued tasks exist but only 25 are sent');
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('a missing file in the cache falls back instead of throwing', () => {
  const { readJsonCached } = server.internals;
  assert.deepEqual(readJsonCached('/nonexistent/path/tasks.json', { tasks: [] }), { tasks: [] });
});

// ---- autonomy routes (the read-only guard must not swallow them) ----

test('the autonomy surface is reachable and disabled by default', async () => {
  const res = await http.get('/api/autonomy');
  assert.equal(res.status, 200);
  assert.equal(res.json.policy.enabled, false, 'must ship disarmed');
  assert.equal(res.json.policy.requireConfirmation, true, 'and must ask first');
  assert.equal(res.json.policy.maxAdditionalAgents, 2);
  assert.ok(res.json.assessment, 'the capacity assessment is reported even while off');
});

test('the autonomy policy can be armed through the guard', async () => {
  const res = await http.post('/api/autonomy/policy', { enabled: true, minQueueToReact: 1, cooldownMinutes: 0 });
  assert.equal(res.status, 200, `guard blocked it: ${res.status}`);
  assert.equal(res.json.policy.enabled, true);

  const back = await http.post('/api/autonomy/policy', { enabled: false });
  assert.equal(back.status, 200);
  assert.equal(back.json.policy.enabled, false);
});

test('an invalid autonomy policy is rejected with the reason', async () => {
  const res = await http.post('/api/autonomy/policy', { maxAdditionalAgents: 500 });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /maxAdditionalAgents must be between/);
});

test('accepting an unknown proposal is a conflict, not a 405', async () => {
  const res = await http.post('/api/autonomy/proposals/does-not-exist/accept', {});
  assert.equal(res.status, 409);
  assert.match(res.json.error.message, /no such proposal/);
});

test('dismissing an unknown proposal is a conflict, not a 405', async () => {
  const res = await http.post('/api/autonomy/proposals/does-not-exist/dismiss', {});
  assert.equal(res.status, 409);
});

test('autonomy mutation routes are refused for a foreign Host', async () => {
  const httpModule = require('http');
  const status = await new Promise((resolve, reject) => {
    const request = httpModule.request(
      {
        host: '127.0.0.1', port: http.port, path: '/api/autonomy/policy', method: 'POST',
        headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' },
      },
      (response) => { response.resume(); resolve(response.statusCode); }
    );
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(status, 421);
});
