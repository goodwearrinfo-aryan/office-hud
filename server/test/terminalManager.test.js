'use strict';
// The manager owns the registry that survives a HUD restart, so the cases that
// matter are the ones where the file and the live process disagree: a terminal
// whose tmux session died must not read as running, and one that is still going
// must not be forgotten just because the process restarted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalManager } = require('../lib/terminal/manager');

let root;
let hive;
let logDir;
const CWD = os.homedir();

const make = (over = {}) => new TerminalManager({
  hive,
  logDir,
  maxConcurrent: over.maxConcurrent ?? 50,
  ...over,
});

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-mgr-'));
  hive = path.join(root, 'hive');
  logDir = path.join(root, 'logs');
  fs.mkdirSync(hive, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
});
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// A record that claims to be running but whose tmux session cannot exist. The
// manager must settle it rather than trusting the file.
const runningTmuxRecord = (id, session) => ({
  id,
  type: 'tmux',
  cmd: 'sleep 1',
  argv: ['sleep', '1'],
  cwd: CWD,
  host: 'test-host',
  tmuxSession: session,
  tmuxPane: null,
  pid: null,
  status: 'running',
  startedAt: new Date().toISOString(),
  exitedAt: null,
  exitCode: null,
  signal: null,
  outputFile: null,
  envKeys: [],
  logBytes: 0,
  logFiles: 0,
});

const writeState = (terminals) => {
  fs.writeFileSync(path.join(hive, 'spawned_terminals.json'),
    JSON.stringify({ host: 'test-host', updated_at: new Date().toISOString(), terminals }));
};

test('a running record whose session is gone is reconciled to exited', async () => {
  // A tmux session name that cannot exist, so has-session fails.
  writeState([runningTmuxRecord('term_gone', 'hud_term_definitely_not_here_9f3a')]);
  const manager = make();
  const count = await manager.load();
  assert.equal(count, 1);
  const record = manager.get('term_gone');
  assert.equal(record.status, 'exited', 'a dead session must not read as running');
  assert.ok(record.exitedAt, 'and it gets an exit time');
  assert.ok(record.reconciledAt, 'reconciliation is recorded, not silent');
});

test('an already-finished record is not disturbed by reconcile', async () => {
  const done = { ...runningTmuxRecord('term_done', 'hud_x'), status: 'exited', exitCode: 0 };
  writeState([done]);
  const manager = make();
  await manager.load();
  const record = manager.get('term_done');
  assert.equal(record.status, 'exited');
  assert.equal(record.exitCode, 0);
  assert.equal(record.reconciledAt, undefined, 'a final record needs no reconciliation');
});

test('a corrupt state file yields an empty registry, not a crash', async () => {
  fs.writeFileSync(path.join(hive, 'spawned_terminals.json'), '{not json at all');
  const manager = make();
  const count = await manager.load();
  assert.equal(count, 0);
  assert.deepEqual(manager.list(), []);
});

test('a record with an unknown type is dropped on load', async () => {
  writeState([
    { id: 'term_ok', type: 'tmux', status: 'exited' },
    { id: 'term_weird', type: 'rm-rf-slash', status: 'running' },
  ]);
  const manager = make();
  await manager.load();
  assert.ok(manager.get('term_ok'), 'known type kept');
  assert.equal(manager.get('term_weird'), null, 'unknown type dropped');
});

test('persist writes valid JSON and load reads it back', async () => {
  const manager = make();
  await manager.load();
  manager.registry.set('term_1', runningTmuxRecord('term_1', 'hud_term_1'));
  assert.equal(manager.persist(), true);
  const raw = fs.readFileSync(path.join(hive, 'spawned_terminals.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.terminals.length, 1);
  assert.equal(parsed.terminals[0].id, 'term_1');
  assert.ok(parsed.updated_at, 'the write is timestamped');

  const reloaded = make();
  await reloaded.load();
  assert.ok(reloaded.get('term_1'));
});

test('a held hive lock is reported, not queued behind', async () => {
  // hive/lib/file_lock.js spins on a blocking Atomics.wait, so waiting for a
  // stale lock would freeze the event loop rather than just delaying a write.
  const lockDir = path.join(hive, 'lib');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'file_lock.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'module.exports = { withFileLock(lockPath, cb) {',
    '  fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
    "  const fd = fs.openSync(lockPath, 'wx');",
    '  try { return cb(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} }',
    '} };',
  ].join('\n'));
  const manager = make();
  await manager.load();
  // A freshly-touched lock file reads as held.
  fs.writeFileSync(path.join(hive, '.spawned_terminals_lock'), '');
  const fresh = Date.now();
  fs.utimesSync(path.join(hive, '.spawned_terminals_lock'), fresh / 1000, fresh / 1000);
  manager.registry.set('term_lock', runningTmuxRecord('term_lock', 'hud_lock'));
  const okWrite = manager.persist();
  assert.equal(okWrite, false, 'a held lock is a clean false, never a throw');
  assert.match(manager.lastPersistError, /lock/i);
  // The in-memory registry is unaffected: a running terminal matters more than
  // a recorded one.
  assert.ok(manager.get('term_lock'));
});

test('reap removes old finished records and frees their logs', async () => {
  const manager = make();
  await manager.load();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(logstoreFor(manager, 'term_old'), 'some output');
  manager.registry.set('term_old', { ...runningTmuxRecord('term_old', 'hud_old'), status: 'exited', exitedAt: old, outputFile: logstoreFor(manager, 'term_old') });
  manager.registry.set('term_new', { ...runningTmuxRecord('term_new', 'hud_new'), status: 'exited', exitedAt: new Date().toISOString() });
  manager.registry.set('term_live', { ...runningTmuxRecord('term_live', 'hud_live'), status: 'running' });

  const result = manager.reap({ maxAgeHours: 24 });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.ids, ['term_old']);
  assert.equal(manager.get('term_old'), null, 'old finished record gone');
  assert.ok(manager.get('term_new'), 'a recent finished record is kept for inspection');
  assert.ok(manager.get('term_live'), 'a running record is never reaped');
  assert.equal(fs.existsSync(logstoreFor(manager, 'term_old')), false, 'its log is freed');
});

function logstoreFor(manager, id) {
  return path.join(manager.logOptions.dir, `${id}.log`);
}

test('activeCount and health reflect only live work', async () => {
  const manager = make();
  await manager.load();
  manager.registry.set('a', { ...runningTmuxRecord('a', 'hud_a'), status: 'running' });
  manager.registry.set('b', { ...runningTmuxRecord('b', 'hud_b'), status: 'starting' });
  manager.registry.set('c', { ...runningTmuxRecord('c', 'hud_c'), status: 'exited' });
  assert.equal(manager.activeCount(), 2, 'starting counts as active');
  const health = manager.health();
  assert.equal(health.active, 2);
  assert.equal(health.total, 3);
  assert.equal(health.by_status.exited, 1);
  assert.equal(health.by_type.tmux, 3);
});

test('the concurrent cap is enforced before spawning anything', async () => {
  const manager = make({ maxConcurrent: 2 });
  await manager.load();
  manager.registry.set('a', { ...runningTmuxRecord('a', 'hud_a'), status: 'running' });
  manager.registry.set('b', { ...runningTmuxRecord('b', 'hud_b'), status: 'running' });
  await assert.rejects(
    () => manager.spawnOne({ cmd: 'git status', cwd: CWD, type: 'background' }),
    (error) => error.statusCode === 429,
  );
});

test('spawnOne refuses a command the policy rejects, and spawns nothing', async () => {
  const manager = make();
  await manager.load();
  await assert.rejects(
    () => manager.spawnOne({ cmd: 'rm -rf /', cwd: CWD, type: 'background' }),
    (error) => error.statusCode === 403,
  );
  assert.equal(manager.list().length, 0, 'a rejected spawn leaves no record');
});

test('spawnOne rejects an unknown type and orchestrate on the single path', async () => {
  const manager = make();
  await manager.load();
  await assert.rejects(
    () => manager.spawnOne({ cmd: 'git status', cwd: CWD, type: 'telepathy' }),
    (error) => error.statusCode === 400,
  );
  // Orchestrate reaches bypassPermissions and has its own confirming path.
  await assert.rejects(
    () => manager.spawnOne({ cmd: 'git status', cwd: CWD, type: 'orchestrate' }),
    (error) => error.statusCode === 400,
  );
});

test('orchestrate mode demands explicit confirmation', async () => {
  const manager = make();
  await manager.load();
  await assert.rejects(
    () => manager.spawnOrchestrate({ repoRoot: CWD, objective: 'do a thing' }),
    (error) => error.statusCode === 400 && /confirmed/.test(error.message),
  );
});

test('spawnBulk reports per-item outcomes so one rejection is not a batch failure', async () => {
  const manager = make();
  await manager.load();
  const results = await manager.spawnBulk([
    { cmd: 'rm -rf /', cwd: CWD, type: 'background' },
    { cmd: 'git status', cwd: '/etc', type: 'background' },
  ]);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.ok(result.error, 'each failure explains itself');
  }
  assert.equal(manager.list().length, 0);
});

test('spawnBulk caps the batch at the concurrent limit', async () => {
  const manager = make({ maxConcurrent: 3 });
  await manager.load();
  // Rejected commands: spawnBulk slices to the limit BEFORE spawning, so this
  // proves the cap without leaving real processes behind when the test's
  // temp dir is torn down.
  const results = await manager.spawnBulk(
    Array.from({ length: 10 }, () => ({ cmd: 'rm -rf /', cwd: CWD, type: 'background' })),
  );
  assert.equal(results.length, 3, 'the batch is truncated, not silently expanded');
  assert.equal(manager.list().length, 0, 'and nothing was spawned');
});

test('a background terminal that exits is recorded with its exit code', async () => {
  // A real short-lived process, awaited to completion so nothing outlives the
  // test. This is the case that proves the onExit callback wiring.
  const repo = path.join(os.homedir(), '.hud-mgr-fixture-repo');
  fs.mkdirSync(repo, { recursive: true });
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: repo });
  const manager = make();
  await manager.load();
  const record = await manager.spawnOne({ cmd: 'ls -la', cwd: repo, type: 'background' });
  assert.equal(record.status, 'running');
  assert.ok(record.pid > 0, 'the pid is tracked so it can be signalled');
  const settled = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const live = manager.get(record.id);
      if (live && live.status !== 'running' && live.status !== 'starting') { clearInterval(timer); resolve(live); }
    }, 25);
    setTimeout(() => { clearInterval(timer); resolve(manager.get(record.id)); }, 10000);
  });
  assert.equal(settled.status, 'exited');
  assert.equal(settled.exitCode, 0, 'a successful command is not marked failed');
  const logs = manager.logs(record.id, { lines: 10 });
  assert.equal(logs.lines.length > 0, true, 'output was captured');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a tmux terminal whose command finished is settled by the reconcile loop', async () => {
  // A tmux session cannot report its own exit -- tmux tears the session down when
  // the command ends and nothing calls back. Without the periodic loop this
  // record would read `running` forever, so the loop is started by load() and it
  // is what settles the status.
  const manager = make({ reconcileMs: 40 });
  fs.writeFileSync(path.join(hive, 'spawned_terminals.json'), JSON.stringify({
    host: 'test-host',
    updated_at: new Date().toISOString(),
    terminals: [runningTmuxRecord('term_tmux', 'hud_term_not_a_real_session_zz')],
  }));
  await manager.load();
  assert.ok(manager.reconcileTimer, 'load starts the reconcile loop');
  // load() reconciles once, so a session that was already dead is settled
  // immediately.
  assert.equal(manager.get('term_tmux').status, 'exited', 'the initial reconcile settles it');

  // Now the case that actually needs the loop: a terminal that was genuinely
  // alive at startup and whose session dies later, with nothing to call back.
  const live = { ...runningTmuxRecord('term_later', 'hud_term_also_not_real_yy') };
  live.status = 'running';
  delete live.exitedAt;
  delete live.reconciledAt;
  manager.registry.set('term_later', live);
  // A spawner that reports it as alive, so only the loop can settle it.
  manager.backendAlive = async () => true;
  assert.equal(manager.get('term_later').status, 'running');
  await manager.reconcile();
  assert.equal(manager.get('term_later').status, 'running', 'still reported alive, so it stays running');

  // Once the session is gone, the next loop pass settles it.
  manager.backendAlive = async () => false;
  const settled = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (manager.get('term_later').status !== 'running') { clearInterval(timer); resolve(manager.get('term_later')); }
    }, 20);
    setTimeout(() => { clearInterval(timer); resolve(manager.get('term_later')); }, 5000);
  });
  assert.equal(settled.status, 'exited', 'the loop notices the dead session');
  manager.stopReconcileLoop();
  assert.equal(manager.reconcileTimer, null, 'and it can be stopped');
});

test('the reconcile loop is not started twice', async () => {
  const manager = make({ reconcileMs: 10000 });
  await manager.load();
  const first = manager.reconcileTimer;
  await manager.load();
  assert.equal(manager.reconcileTimer, first, 'a second load does not stack timers');
  manager.stopReconcileLoop();
});

test('collectedTerminals keeps collected and spawned apart', async () => {
  const manager = make();
  await manager.load();
  manager.registry.set('term_s', { ...runningTmuxRecord('term_s', 'hud_s'), status: 'running' });
  const view = manager.collectedTerminals({
    collected_at: '2026-01-01T00:00:00Z',
    shell_terminals: [{ pid: 42, tty: 'ttys000' }],
  });
  assert.equal(view.collected.length, 1, 'the human shell is still reported');
  assert.equal(view.spawned.length, 1, 'alongside the spawned terminal');
  assert.equal(view.collected_at, '2026-01-01T00:00:00Z');
  // A missing collected doc is a valid empty state, not a throw.
  const empty = manager.collectedTerminals(null);
  assert.deepEqual(empty.collected, []);
  assert.equal(empty.spawned.length, 1);
});

test('kill on an unknown id is a 404, and kill is idempotent', async () => {
  const manager = make();
  await manager.load();
  await assert.rejects(() => manager.kill('term_nope'), (error) => error.statusCode === 404);
  manager.registry.set('term_done', { ...runningTmuxRecord('term_done', 'hud_d'), status: 'killed' });
  const again = await manager.kill('term_done');
  assert.equal(again.status, 'killed', 'killing an already-final record is a no-op');
});

test('kill rejects a signal outside the allowed set', async () => {
  const manager = make();
  await manager.load();
  manager.registry.set('t', { ...runningTmuxRecord('t', 'hud_t'), status: 'running' });
  await assert.rejects(() => manager.kill('t', { signal: 'SIGKILL_ALL' }), (error) => error.statusCode === 400);
});

test('schedulePersist coalesces a burst into one write', async () => {
  const manager = make();
  await manager.load();
  // Scoped to this manager's own temp file. Counting every writeFileSync in the
  // process would also catch the debounce timers of earlier tests, whose
  // temp dirs are already gone, and report phantom writes.
  const mine = manager.statePath;
  let writes = 0;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (String(target).startsWith(`${mine}.tmp`)) writes += 1;
    return realWrite(target, ...rest);
  };
  try {
    for (let i = 0; i < 20; i++) manager.schedulePersist();
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(writes, 1, 'twenty spawns produce one file write');
});
// ---- remote backend -------------------------------------------------------
//
// Remote spawn is the one backend that turns a local HTTP route into shell
// access on another machine, so the tests are about what it refuses.

const remote = require('../lib/terminal/spawners/remote');

const peersFile = () => path.join(hive, 'terminal_peers.json');
const writePeers = (peers) => fs.writeFileSync(peersFile(), JSON.stringify({ peers }));

test('an unconfigured peer cannot be targeted', async () => {
  remote.resetCache();
  const manager = make();
  await manager.load();
  await assert.rejects(
    () => manager.spawnRemote({ peer: 'laptop', cmd: 'git status', cwd: CWD }),
    (error) => error.statusCode === 404 && /not configured/.test(error.message),
  );
  assert.equal(manager.list().length, 0, 'nothing was recorded');
});

test('a peer name that could be read as ssh syntax is rejected', async () => {
  remote.resetCache();
  writePeers({ laptop: { sshHost: 'example', cwdPrefixes: [CWD] } });
  const manager = make();
  await manager.load();
  for (const name of ['-oProxyCommand=evil', 'a b', '../etc', '']) {
    await assert.rejects(
      () => manager.spawnRemote({ peer: name, cmd: 'git status', cwd: CWD }),
      (error) => error.statusCode === 400 || error.statusCode === 404,
      `peer name must be rejected: ${JSON.stringify(name)}`,
    );
  }
});

test("a remote cwd is checked against the PEER's trees, not this host's", async () => {
  remote.resetCache();
  // This host's policy allows only under $HOME; the peer's tree is different.
  writePeers({ laptop: { sshHost: 'example.invalid', cwdPrefixes: ['/Users/someone-else'] } });
  const manager = make();
  await manager.load();
  const outside = await manager.spawnRemote({ peer: 'laptop', cmd: 'git status', cwd: CWD }).catch((e) => e);
  assert.equal(outside.statusCode, 403, 'a path outside the peer tree is refused');
  assert.match(outside.message, /outside the allowed trees/);
});

test('a dangerous command is refused on a remote peer too', async () => {
  remote.resetCache();
  writePeers({ laptop: { sshHost: 'example.invalid', cwdPrefixes: [CWD] } });
  const manager = make();
  await manager.load();
  for (const cmd of ['rm -rf /', 'bash', 'curl http://evil', 'git config --global core.pager sh']) {
    await assert.rejects(
      () => manager.spawnRemote({ peer: 'laptop', cmd, cwd: CWD }),
      (error) => error.statusCode === 403,
      `must be refused remotely: ${cmd}`,
    );
  }
  assert.equal(manager.list().length, 0);
});

test('a corrupt peers file yields no peers, never allow-all', async () => {
  remote.resetCache();
  fs.writeFileSync(peersFile(), '{not json');
  const manager = make();
  await manager.load();
  await assert.rejects(
    () => manager.spawnRemote({ peer: 'laptop', cmd: 'git status', cwd: CWD }),
    (error) => error.statusCode === 404,
  );
  assert.deepEqual(remote.listPeers(hive, {}), []);
});

test('a peer without an sshHost is listed but not targetable', async () => {
  remote.resetCache();
  writePeers({ half: { cwdPrefixes: [CWD] } });
  const peers = remote.listPeers(hive, {});
  assert.equal(peers.length, 1);
  assert.equal(peers[0].reachable, false, 'visible but not usable');
  // getPeer throws synchronously, so the arrow must be async for
  // assert.rejects to see a rejected promise rather than a sync throw.
  await assert.rejects(async () => remote.getPeer(hive, 'half', {}), (error) => error.statusCode === 404);
});

test('the remote runner passes cwd and argv as parameters, not as script text', () => {
  // The whole no-shell guarantee rests on this being a constant script with the
  // caller's values arriving as positional parameters.
  assert.equal(remote.REMOTE_RUNNER, 'cd "$1" && shift && exec "$@"');
  assert.ok(!remote.REMOTE_RUNNER.includes('$2'), 'the script must not reference argv inline');
});

test('the remote ssh client is not given this process environment', () => {
  // Passing the environment on would hand the peer's login shell every provider
  // key this process holds.
  assert.equal(remote.DEFAULT_SSH.StrictHostKeyChecking, 'yes',
    'an unauthenticated peer must not be silently accepted');
  assert.equal(remote.DEFAULT_SSH.BatchMode, 'yes',
    'a missing key must fail rather than hang on a prompt');
});

test('remote arguments are quoted for the string ssh actually sends', () => {
  // ssh concatenates everything after the destination host into ONE string that
  // the remote login shell parses, so an unquoted script arrives with no
  // positional parameters and `shift` aborts. Quoting is what makes the
  // no-shell guarantee survive the ssh boundary.
  assert.equal(remote.shellQuote('git'), 'git');
  assert.equal(remote.shellQuote('/Users/x/trading-bot'), '/Users/x/trading-bot');
  assert.equal(remote.shellQuote('a b'), "'a b'");
  assert.equal(remote.shellQuote(''), "''");
  // An embedded single quote uses the close-escape-reopen idiom.
  assert.equal(remote.shellQuote("it's"), "'it'\\''s'");
  // Shell metacharacters stay inside one argument rather than becoming syntax.
  assert.equal(remote.shellQuote('rm -rf /'), "'rm -rf /'");
  assert.equal(remote.shellQuote('a;rm -rf /'), "'a;rm -rf /'");
  assert.equal(remote.shellQuote('$(whoami)'), "'$(whoami)'");
  assert.equal(remote.shellQuote('`id`'), "'`id`'");
});

test('the remote command names its interpreter and keeps argv separate', () => {
  // ssh hands everything after the host to the remote login shell as one command
  // line. Without an explicit `sh -c` the remote executes the script TEXT as a
  // program name, and without quoting there are no positional parameters at all
  // ("shift count must be <= $#"). Both failures were observed live before this
  // shape was settled.
  const built = ['sh', '-c', remote.shellQuote(remote.REMOTE_RUNNER), 'hud-remote',
    remote.shellQuote('/tmp/repo'), 'git', 'status'].join(' ');
  assert.equal(built, `sh -c 'cd "$1" && shift && exec "$@"' hud-remote /tmp/repo git status`);
  assert.ok(built.startsWith('sh -c '), 'the interpreter is explicit');
  assert.equal(remote.shellQuote(remote.REMOTE_RUNNER).startsWith("'"), true,
    'the script is one quoted word');
});
