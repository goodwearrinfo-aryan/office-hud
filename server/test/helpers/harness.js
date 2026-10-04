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
    // Carries a credential-shaped value on purpose. Kept under 20 characters
    // because scripts/scan_secrets.py only reports an `sk-` value once it is
    // that long -- a longer canary fails the secret-scan stage of the quality
    // gate. The redactor masks by flag name, not by value, so the length does
    // not weaken what is being tested.
    // Carries a credential-shaped value on purpose. The redaction assertions
    // read this entry; with no `command` field they asserted against the empty
    // string and passed without ever seeing a secret, which is how a test
    // guarding redaction came to guard nothing.
    processes: [{ pid: 4242, name: 'worker',
      command: 'node agent.js --api-key=sk-CANARY0123456789 --port 8080' }],
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
  // REFUSE an unset or invalid hive.
  //
  // This guard exists because of a silent, total failure. `process.env.X = undefined`
  // coerces to the STRING "undefined", which is truthy and a perfectly valid path
  // segment. A caller that omitted the argument therefore got a server pointed at
  // ./undefined/, every read came back empty, and assertions over that empty result
  // passed -- 0 + 0 === 0. The suite stayed green over a hive that was never opened.
  //
  // Validating here rather than at each call site is deliberate: loadServer is the
  // single choke point every fixture-loading test passes through, so the whole class
  // of bug is closed once instead of being re-introduced by the next bare call.
  if (typeof hive !== 'string' || hive.trim().length === 0) {
    throw new Error(
      'loadServer(hive) requires an existing hive directory path. Received ' +
      `${hive === undefined ? 'undefined' : JSON.stringify(hive)}. ` +
      'Assigning undefined to process.env yields the truthy string "undefined", so ' +
      'omitting the hive points the server at ./undefined/ and every assertion silently ' +
      'runs against an empty hive. Build one with makeFixtureHive() and pass fixture.hive.',
    );
  }
  const hivePath = path.resolve(hive);
  if (!fs.existsSync(hivePath) || !fs.statSync(hivePath).isDirectory()) {
    throw new Error(
      `loadServer(hive) requires an existing hive directory. Got ${hive}, which is not a directory. ` +
      'Build one with makeFixtureHive() and pass fixture.hive.',
    );
  }
  process.env.OFFICE_HUD_HIVE = hivePath;
  process.env.PORT = '0';
  // Load a FRESH copy of the server module.
  //
  // require() memoises by resolved path, so a second loadServer() used to return
  // the first instance: HIVE was captured once at module scope and the
  // module-level eventCache/workEventCache were shared forever. A test that
  // built a second fixture hive was then silently served the first hive's data.
  // Measured: hive A with 11 events and hive B with 77 both reported 11.
  //
  // Nothing in the suite was failing loudly because no test compared a payload
  // against the hive it wrote. terminals.test.js hit this and worked around it
  // by deleting its remote tree instead of loading a second server, with a
  // comment saying so; this removes the need for that kind of dodge.
  //
  // Safe because index.js only listens when it is require.main, so re-requiring
  // it constructs routes without binding a port or starting the watcher.
  const serverPath = path.join(__dirname, '..', '..', 'index.js');
  delete require.cache[require.resolve(serverPath)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(serverPath);
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
