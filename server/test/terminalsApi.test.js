'use strict';
// Route-level tests for terminal control.
//
// The security case here is the one that has already bitten this codebase once:
// the HUD is reachable over Tailscale Serve, which terminates the tailnet
// connection on this host and then opens a NEW loopback connection to the app.
// A remote device therefore arrives as 127.0.0.1, so a socket-only check would
// let anyone on the tailnet spawn processes. These tests pin the hardened gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

// The command policy only permits a cwd under $HOME, and the fixture hive lives
// in tmp, so a real spawn needs a real directory inside the home tree.
const SPAWN_CWD = path.join(os.homedir(), '.hud-terminal-api-fixture');

test.before(async () => {
  fs.mkdirSync(SPAWN_CWD, { recursive: true });
  http = await startTestServer(server.app);
});
test.after(async () => {
  await http?.close();
  fs.rmSync(SPAWN_CWD, { recursive: true, force: true });
  fixture.cleanup();
});

/** A POST with attacker-controlled headers, which the harness helper cannot send. */
const postWithHeaders = (pathname, body, headers) => http.get(pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('the spawned view reports collected and spawned separately', async () => {
  const res = await http.get('/api/terminals/spawned');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.spawned), 'spawned is a list');
  assert.ok(Array.isArray(res.json.collected), 'collected is a list');
});

test('a tailnet-proxied request cannot spawn anything', async () => {
  // Tailscale Serve sets this header on proxied traffic. The socket is loopback,
  // so without the header check this route is open to every device on the tailnet.
  const res = await postWithHeaders(
    '/api/terminals/spawn',
    { cmd: 'git status', cwd: SPAWN_CWD, type: 'background' },
    { 'tailscale-user-login': 'attacker@example.com' },
  );
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'local_only');
  assert.match(res.json.error.message, /this machine/);
});

test('a forwarded remote hop cannot spawn anything', async () => {
  const res = await postWithHeaders(
    '/api/terminals/spawn',
    { cmd: 'git status', cwd: SPAWN_CWD, type: 'background' },
    { 'x-forwarded-for': '100.64.0.7, 127.0.0.1' },
  );
  assert.equal(res.status, 403);
});

test('every mutating terminal route refuses a proxied caller', async () => {
  const routes = [
    ['/api/terminals/spawn', { cmd: 'git status', cwd: SPAWN_CWD, type: 'background' }],
    ['/api/terminals/bulk', { terminals: [] }],
    ['/api/terminals/term_x/kill', {}],
    ['/api/terminals/term_x/signal', { signal: 'SIGINT' }],
    ['/api/terminals/reap', {}],
  ];
  for (const [route, body] of routes) {
    const res = await postWithHeaders(route, body, { 'tailscale-user-login': 'attacker@example.com' });
    assert.equal(res.status, 403, `${route} must be local-only`);
  }
});

test('the log and follow routes are also local-only', async () => {
  for (const route of ['/api/terminals/term_x', '/api/terminals/term_x/logs']) {
    const res = await http.get(route, { headers: { 'tailscale-user-login': 'attacker@example.com' } });
    assert.equal(res.status, 403, `${route} must be local-only`);
  }
});

test('a rejected command is refused and nothing is recorded', async () => {
  const before = (await http.get('/api/terminals/spawned')).json.spawned.length;
  const res = await http.post('/api/terminals/spawn', { cmd: 'rm -rf /', cwd: SPAWN_CWD, type: 'background' });
  assert.equal(res.status, 403);
  const after = (await http.get('/api/terminals/spawned')).json.spawned.length;
  assert.equal(after, before, 'nothing was spawned');
});

test('a cwd outside the allowed trees is refused', async () => {
  const res = await http.post('/api/terminals/spawn', { cmd: 'git status', cwd: '/etc', type: 'background' });
  assert.equal(res.status, 403);
});

test('an unknown type is a 400', async () => {
  const res = await http.post('/api/terminals/spawn', { cmd: 'git status', cwd: SPAWN_CWD, type: 'wat' });
  assert.equal(res.status, 400);
});

test('a real background terminal spawns, is visible, and can be read and killed', async () => {
  const spawn = await http.post('/api/terminals/spawn', {
    cmd: 'ls -la', cwd: SPAWN_CWD, type: 'background', name: 'api-fixture',
  });
  assert.equal(spawn.status, 200);
  const terminal = spawn.json.terminal;
  assert.ok(terminal.id, 'has an id');
  assert.equal(terminal.type, 'background');
  assert.equal(terminal.status, 'running');
  assert.equal(terminal.name, 'api-fixture');

  // It shows up in the spawned view, tagged with this host.
  const listed = await http.get('/api/terminals/spawned');
  const found = listed.json.spawned.find((t) => t.id === terminal.id);
  assert.ok(found, 'listed in the spawned view');
  assert.ok(found.host, 'carries a host so the panel can group it');

  // Detail and logs both resolve.
  const detail = await http.get(`/api/terminals/${terminal.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.terminal.id, terminal.id);
  const logs = await http.get(`/api/terminals/${terminal.id}/logs`);
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.lines));

  // Killing is idempotent and leaves a final record.
  const kill = await http.post(`/api/terminals/${terminal.id}/kill`, {});
  assert.equal(kill.status, 200);
  assert.ok(['killed', 'exited', 'failed'].includes(kill.json.terminal.status));
  const again = await http.post(`/api/terminals/${terminal.id}/kill`, {});
  assert.equal(again.status, 200, 'killing twice is not an error');
});

test('an unknown terminal id is a 404 on every id route', async () => {
  assert.equal((await http.get('/api/terminals/term_missing')).status, 404);
  assert.equal((await http.get('/api/terminals/term_missing/logs')).status, 404);
  assert.equal((await http.post('/api/terminals/term_missing/kill', {})).status, 404);
  assert.equal((await http.post('/api/terminals/term_missing/signal', { signal: 'SIGINT' })).status, 404);
});

test('bulk reports per-item outcomes', async () => {
  const res = await http.post('/api/terminals/bulk', {
    terminals: [
      { cmd: 'rm -rf /', cwd: SPAWN_CWD, type: 'background' },
      { cmd: 'bash', cwd: SPAWN_CWD, type: 'background' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.requested, 2);
  assert.equal(res.json.spawned, 0);
  assert.equal(res.json.ok, false, 'a batch of rejections is not reported as ok');
  for (const item of res.json.results) {
    assert.equal(item.ok, false);
    assert.ok(item.error);
  }
});

test('bulk refuses to orchestrate without confirmation', async () => {
  const res = await http.post('/api/terminals/bulk', {
    mode: 'orchestrate', repoRoot: SPAWN_CWD, objective: 'do a thing', count: 1,
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /confirmed/);
});

test('reap answers with what it removed', async () => {
  const res = await http.post('/api/terminals/reap', { maxAgeHours: 0 });
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.removed, 'number');
  assert.ok(Array.isArray(res.json.ids));
});

test('health reports the registry shape the panel needs', async () => {
  const res = await http.get('/api/terminals/health');
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.active, 'number');
  assert.equal(typeof res.json.total, 'number');
  assert.ok(res.json.by_status, 'status breakdown');
  assert.equal(typeof res.json.log_bytes, 'number');
});

test('the spawned terminals resource is registered for the live socket', async () => {
  const res = await http.get('/api/live/resources');
  assert.equal(res.status, 200);
  assert.ok(
    res.json.resources.includes('terminalsSpawned'),
    'so a subscriber is pushed changes instead of polling',
  );
  // And it actually produces a payload.
  const snapshot = await http.get('/api/live/terminalsSpawned');
  assert.equal(snapshot.status, 200);
  assert.ok(Array.isArray(snapshot.json.spawned));
});
test('the peers route lists configured peers without acting', async () => {
  const res = await http.get('/api/terminals/peers');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.peers), 'returns a list');
  // Nothing configured in the fixture hive, so it must be empty rather than
  // erroring -- an absent peers file is a valid state.
  assert.deepEqual(res.json.peers, []);
});

test('an unconfigured peer is a 404, not a silent no-op', async () => {
  const res = await http.post('/api/terminals/spawn', {
    type: 'remote', peer: 'somewhere-else', cmd: 'git status', cwd: os.homedir(),
  });
  assert.equal(res.status, 404);
  assert.match(res.json.error.message, /not configured/);
});

test('a remote spawn is still local-only gated', async () => {
  const res = await postWithHeaders(
    '/api/terminals/spawn',
    { type: 'remote', peer: 'laptop', cmd: 'git status', cwd: os.homedir() },
    { 'tailscale-user-login': 'attacker@evil' },
  );
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'local_only');
});
