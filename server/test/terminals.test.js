'use strict';
// Multi-host terminals: the HUD runs on one box but must show every machine
// that publishes into hive/remote/<host>/. The cases that matter are the ones
// where a host goes quiet -- a laptop that sleeps must look different from a
// laptop that has no terminals, and a half-written file must never be read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

const remoteDir = (...parts) => path.join(fixture.hive, 'remote', ...parts);
const writeHost = (host, doc) => {
  const dir = remoteDir(host);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'terminals.json'), JSON.stringify(doc));
};
const terminal = (over = {}) => ({
  pid: 100, ppid: 1, tty: 'ttys000', etime: '1:00', name: '-zsh',
  command: '-zsh', kind: 'shell', parent_name: 'Terminal', cwd: '/Users/x', ...over,
});
const doc = (host, over = {}) => ({
  host, collected_at: new Date().toISOString(),
  agent_sessions: [], processes: [], shell_terminals: [terminal()], ...over,
});

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
});

test('merges terminals from every publishing host', async () => {
  writeHost('laptop', doc('laptop', { shell_terminals: [terminal({ pid: 1 }), terminal({ pid: 2 })] }));
  writeHost('studio', doc('studio', { shell_terminals: [terminal({ pid: 3 })] }));
  const res = await http.get('/api/terminals');
  assert.equal(res.status, 200);
  const hosts = res.json.hosts.map(h => h.host).sort();
  assert.ok(hosts.includes('laptop'), 'laptop present');
  assert.ok(hosts.includes('studio'), 'studio present');
  const fromLaptop = res.json.terminals.filter(t => t.host === 'laptop');
  assert.equal(fromLaptop.length, 2);
  assert.equal(res.json.terminals.filter(t => t.host === 'studio').length, 1);
});

test('every terminal carries its host so the UI can group them', async () => {
  writeHost('laptop', doc('laptop'));
  const res = await http.get('/api/terminals');
  for (const t of res.json.terminals) {
    assert.equal(typeof t.host, 'string');
    assert.ok(t.host.length > 0, 'host is non-empty');
  }
});

test('a silent host is reported stale, not silently dropped', async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeHost('sleepy', doc('sleepy', { collected_at: old }));
  const res = await http.get('/api/terminals');
  const sleepy = res.json.hosts.find(h => h.host === 'sleepy');
  assert.ok(sleepy, 'the host is still listed');
  assert.equal(sleepy.stale, true, 'and flagged stale');
  assert.ok(res.json.stale_hosts.includes('sleepy'), 'named in stale_hosts');
  // Its last known terminals remain visible rather than vanishing.
  assert.ok(res.json.terminals.some(t => t.host === 'sleepy' && t.host_stale === true));
});

test('a fresh host is not stale', async () => {
  writeHost('awake', doc('awake'));
  const res = await http.get('/api/terminals');
  const awake = res.json.hosts.find(h => h.host === 'awake');
  assert.equal(awake.stale, false);
  assert.ok(!res.json.stale_hosts.includes('awake'));
});

test('age_sec is reported so the UI can show how old a reading is', async () => {
  writeHost('laptop', doc('laptop'));
  const res = await http.get('/api/terminals');
  for (const h of res.json.hosts) {
    if (h.collected_at) assert.equal(typeof h.age_sec, 'number');
  }
});

test('a malformed or empty host file does not break the endpoint', async () => {
  const dir = remoteDir('garbage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'terminals.json'), '{not json');
  writeHost('healthy', doc('healthy'));
  const res = await http.get('/api/terminals');
  assert.equal(res.status, 200, 'still 200 with a corrupt neighbour');
  assert.ok(res.json.terminals.some(t => t.host === 'healthy'));
});

test('a host directory with no terminals.json is ignored', async () => {
  fs.mkdirSync(remoteDir('empty-dir'), { recursive: true });
  const res = await http.get('/api/terminals');
  assert.equal(res.status, 200);
  assert.ok(!res.json.hosts.some(h => h.host === 'empty-dir'));
});

test('sessions from remote hosts are merged and tagged', async () => {
  writeHost('laptop', doc('laptop', {
    agent_sessions: [{ session_id: 's-lap', agent_id: 'w1', status: 'HEALTHY' }],
    shell_terminals: [],
  }));
  const res = await http.get('/api/sessions');
  assert.equal(res.status, 200);
  const row = res.json.sessions.find(s => s.session_id === 's-lap');
  assert.ok(row, 'remote session present in the sessions view');
  assert.equal(row.host, 'laptop');
});

test('local sessions keep working and gain a host tag', async () => {
  const res = await http.get('/api/sessions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.sessions));
  for (const s of res.json.sessions) assert.equal(typeof s.host, 'string');
});

test('no remote directory at all is a valid empty state', async () => {
  // Remove the remote tree rather than loading a second server: loadServer()
  // uses require(), so a second instance is served from the first hive and
  // would silently read this one's hosts. Deleting the directory tests the
  // genuinely-empty case without depending on test order.
  fs.rmSync(path.join(fixture.hive, 'remote'), { recursive: true, force: true });
  const res = await http.get('/api/terminals');
  assert.equal(res.status, 200, 'a missing remote dir is not an error');
  assert.deepEqual(res.json.terminals, [], 'no terminals from anywhere');
  assert.deepEqual(res.json.stale_hosts, []);
  // The local host is still represented, so the panel has something to render.
  assert.ok(res.json.hosts.some(h => h.local), 'local host still listed');
});
