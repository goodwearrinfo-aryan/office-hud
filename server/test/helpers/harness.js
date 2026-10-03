'use strict';
// Fixture hive + helpers for the office-hud test suite.
//
// Tests must never touch the real hive: the server reads HIVE from the
// environment at require time, so fixtures are built first and the env is set
// before index.js is required.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MINUTE = 60000;

/** Build a synthetic hive with a known task set and event stream. */
function makeFixtureHive(options = {}) {
  const now = options.now ?? Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hud-fixture-'));
  const hive = path.join(root, 'hive');
  fs.mkdirSync(path.join(hive, 'agents', 'worker-a'), { recursive: true });
  fs.mkdirSync(path.join(hive, 'lib', 'llm'), { recursive: true });

  const tasks = [
    // completed an hour ago
    {
      task_id: 't-done', title: 'done task', status: 'COMPLETE',
      created_at: new Date(now - 3 * 3600000).toISOString(),
      started_at: new Date(now - 2 * 3600000).toISOString(),
      completed_at: new Date(now - 3600000).toISOString(),
      claimed_by: 'worker-a',
    },
    // started 30m ago, still running
    {
      task_id: 't-running', title: 'running task', status: 'IN_PROGRESS',
      created_at: new Date(now - 90 * MINUTE).toISOString(),
      started_at: new Date(now - 30 * MINUTE).toISOString(),
      claimed_by: 'worker-a',
    },
    // queued, never started
    {
      task_id: 't-queued', title: 'queued task', status: 'QUEUED',
      created_at: new Date(now - 10 * MINUTE).toISOString(),
      assigned_agent: 'f6',
    },
    // quarantined
    {
      task_id: 't-bad', title: 'junk task', status: 'QUARANTINED',
      created_at: new Date(now - 4 * 3600000).toISOString(),
      assigned_agent: 'f6',
    },
    // created in the future relative to a replay point
    {
      task_id: 't-future', title: 'later task', status: 'QUEUED',
      created_at: new Date(now + 3600000).toISOString(),
    },
  ];

  fs.writeFileSync(path.join(hive, 'tasks.json'), JSON.stringify({ tasks }, null, 2));
  fs.writeFileSync(path.join(hive, 'projects.json'), JSON.stringify({
    projects: [{ project_id: 'demo', name: 'Demo', tasks: 2 }],
  }, null, 2));
  fs.writeFileSync(path.join(hive, 'processes.json'), JSON.stringify({
    processes: [{ pid: 4242, name: 'worker' }],
  }, null, 2));
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({
    godId: 'god', agents: ['god', 'worker-a'],
  }, null, 2));
  fs.writeFileSync(path.join(hive, 'fleet.json'), JSON.stringify({
    agents: [
      {
        id: 'worker-a',
        name: 'Worker A',
        role: 'worker',
        floor: 'f3',
        provider: 'freeHarness',
        model: 'test',
        cwd: path.join(hive, 'agents', 'worker-a'),
        status: 'healthy',
        breaker: 'healthy',
        archived: false,
        lastSeen: new Date(now - 20 * MINUTE).toISOString(),
        tokens: 10, usd: 0.01,
      },
    ],
  }, null, 2));
  // The real hive provides the lock the write path uses; without it every
  // mutating route correctly refuses with "Hive file lock is unavailable".
  fs.writeFileSync(path.join(hive, 'lib', 'file_lock.js'), [
    "'use strict';",
    'const fs = require(\'fs\');',
    'const path = require(\'path\');',
    'module.exports = {',
    '  withFileLock(lockPath, callback) {',
    '    fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
    '    let fd = fs.openSync(lockPath, \'wx\');',
    '    try { return callback(); } finally {',
    '      try { fs.closeSync(fd); } catch {}',
    '      try { fs.unlinkSync(lockPath); } catch {}',
    '    }',
    '  },',
    '};',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(hive, 'agents', 'worker-a', 'identity.md'), '# Worker A\nFixture agent.\n');
  fs.writeFileSync(path.join(hive, 'agents', 'worker-a', 'memory.md'), 'remembers things\n');
  fs.writeFileSync(path.join(hive, 'log.jsonl'), '');

  // events.log: heartbeats plus task transitions
  const events = [];
  for (let i = 0; i < 20; i += 1) {
    events.push({
      type: 'heartbeat',
      agent_id: 'worker-a',
      session_id: 'sess-1',
      timestamp: new Date(now - (20 - i) * MINUTE).toISOString(),
    });
  }
  events.push({
    type: 'task_started', agent_id: 'worker-a', task_id: 't-running',
    timestamp: new Date(now - 30 * MINUTE).toISOString(),
  });
  events.push({
    type: 'task_completed', agent_id: 'worker-a', task_id: 't-done', result: 'ok',
    timestamp: new Date(now - 3600000).toISOString(),
  });
  fs.writeFileSync(path.join(hive, 'events.log'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  return { root, hive, now, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Load the server against a fixture hive. Call before requiring index.js. */
function loadServer(hive) {
  process.env.OFFICE_HUD_HIVE = hive;
  process.env.PORT = '0';
  // eslint-disable-next-line global-require
  return require(path.join(__dirname, '..', '..', 'index.js'));
}

/** Boot the app on an ephemeral port and return a fetch helper. */
async function startTestServer(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    server,
    async get(pathname, init) {
      const res = await fetch(`${base}${pathname}`, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json };
    },
    post(pathname, body) {
      return this.get(pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { makeFixtureHive, loadServer, startTestServer, MINUTE };
