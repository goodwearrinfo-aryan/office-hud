'use strict';
// Command lines are exposed by both /api/terminals and /api/processes, so they
// are redacted before serving. These cases pin both halves of that: real
// credential forms must be masked, and ordinary flags/paths must survive, since
// a redactor that eats --port and file paths makes the view useless.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => { await http?.close(); fixture.cleanup(); });

const commandIn = (command) => ({
  method: 'GET', path: '/api/terminals',
});

test('credential-shaped flags are masked', async () => {
  const res = await http.get('/api/terminals');
  assert.equal(res.status, 200);
  // The fixture hive has no terminals.json, so fall back to the hive's own
  // processes to prove the redactor is wired into the served payload.
  const host = res.json.hosts.find(h => h.local);
  assert.ok(host, 'local host present');
  // Secret values, not flag shapes: `api[-_]?key=\S+` also matches the masked
  // `--api-key=***`, so it demanded that the redactor do nothing. The fixture
  // now carries a canary, so this has something real to check.
  for (const p of host.processes) {
    assert.doesNotMatch(String(p.command || ''), /sk-[A-Za-z0-9]{8,}/);
  }
});

test('redactor masks every credential form we care about', () => {
  // Exercised directly against the module's own helper via the served server
  // is awkward; assert the behaviour through a temporary hive file instead.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(fixture.hive, 'remote', 'redaction-probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'terminals.json'), JSON.stringify({
    host: 'redaction-probe',
    collected_at: new Date().toISOString(),
    agent_sessions: [], processes: [],
    shell_terminals: [
      { pid: 1, kind: 'shell', name: 'zsh', tty: 'ttys000', command: 'zsh --api-key=sk-abc123' },
      { pid: 2, kind: 'shell', name: 'zsh', tty: 'ttys001', command: 'zsh --token xyz789' },
      { pid: 3, kind: 'shell', name: 'zsh', tty: 'ttys002', command: 'sh MY_SECRET=hunter2' },
      { pid: 4, kind: 'shell', name: 'zsh', tty: 'ttys003', command: 'sh --port 4096 --verbose /Users/a/app.js' },
    ],
  }));
  return http.get('/api/terminals').then(res => {
    const byPid = Object.fromEntries(res.json.terminals.map(t => [t.pid, t.command]));
    assert.match(byPid[1], /api-key=\*\*\*/, 'api-key masked');
    assert.doesNotMatch(byPid[1], /sk-abc123/, 'secret value gone');
    // The redactor normalises `--token value` to `--token=***`, which is a
    // deliberate choice: the value is gone either way, and a single shape is
    // easier to reason about than preserving the original separator.
    assert.match(byPid[2], /token=\*{3}/i, 'token masked');
    assert.match(byPid[3], /MY_SECRET=\*\*\*/, 'env-style secret masked');
    assert.equal(byPid[4], 'sh --port 4096 --verbose /Users/a/app.js',
      'ordinary flags and paths are left alone');
  });
});

test('a redacted payload leaks no credential substring', async () => {
  const res = await http.get('/api/terminals');
  const blob = JSON.stringify(res.json);
  assert.doesNotMatch(blob, /sk-abc123|xyz789|hunter2/);
});
