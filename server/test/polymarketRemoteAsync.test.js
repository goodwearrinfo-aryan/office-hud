'use strict';
// Regression guard for the second event-loop-blocking path in the HUD: the mini-side
// polymarket evidence used to be fetched with execFileSync('ssh', ...), several calls in a
// row, each with its own 15 s timeout. With the mini off-tailnet that parked the whole Node
// process -- every other HUD route, including /api/health and /api/agents -- for the sum of
// the timeouts. Measured live: /api/health 37.5s and /api/agents 10.2s behind one panel
// poll while the mini was unreachable, with health_probe.py itself answering in 0.10s.
//
// Properties that must hold:
//   1. a panel request never waits on ssh: it reads the last completed observation and says
//      how old it is, and an observation that has not happened is reported as absent, never
//      as healthy;
//   2. the remote commands run concurrently under a hard cap, so a burst of polls cannot
//      launch an unbounded number of ssh processes;
//   3. timeout, unreachable host, and remote-command failure stay distinct, and a valid
//      empty answer (pgrep matching nothing) is not an outage;
//   4. ssh and its process group are gone by the deadline;
//   5. the start/stop gates demand their own fresh evidence and refuse without it, so the
//      paper-only guard is not weakened by making the path asynchronous;
//   6. recovery: once the host answers, the panel reports it without a restart.
//
// polymarketRemoteBlockingControl.test.js is the positive control for 1: it re-runs the same
// measurements against a synchronous implementation and requires them to detect the stall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const remote = require('../lib/polymarket_remote');
const { assertNoLiveOrderAdvertisement, assertExecutionImpliesPaperOnly } = require('./helpers/tradingSafety');

/** Evidence is reported beside the payload, never inside it (13-field contract). */
const ev = (name) => remote.polymarketRemoteStatus(name);

// The remote branch is only taken on the laptop; pin the identity so this suite tests it
// wherever it runs.
process.env.OFFICE_HUD_LOCAL_HOST = 'aryans-macbook-test';

const FAKE_SSH = [
  '#!/bin/sh',
  '# Fake ssh: eats ssh\'s own options and the host, then behaves like the remote command.',
  'shift 5',
  'cmd="$1"',
  'last="$1"',
  'for arg in "$@"; do last="$arg"; done',
  'key="${cmd}_$(basename "$last" 2>/dev/null)"',
  'key=$(printf %s "$key" | tr -c "A-Za-z0-9._-" "_")',
  'dir="$FAKE_SSH_DIR"',
  'printf \'%s %s %s\\n\' "$$" "$cmd" "$key" >> "$dir/calls.log"',
  // A backgrounded grandchild inherits the stdout pipe, which is the case worth testing.
  // It is bounded at 3s rather than 30s: the assertion is that the group kill removes it
  // long before that, and an unbounded leftover can pin the test process via its pipe
  // even after the deadline has settled the call, which is a test artifact, not a finding.
  'if [ -f "$dir/grandchild" ]; then ( sleep 3 ) & fi',
  'if [ -f "$dir/sleep" ]; then sleep "$(cat "$dir/sleep")"; fi',
  'if [ -f "$dir/mode" ] && [ "$(cat "$dir/mode")" = "unreachable" ]; then',
  '  echo "ssh: connect to host 100.125.24.105 port 22: Operation timed out" >&2',
  '  exit 255',
  'fi',
  'if [ -f "$dir/$key.out" ]; then cat "$dir/$key.out"; fi',
  'if [ -f "$dir/$key.exit" ]; then exit "$(cat "$dir/$key.exit")"; fi',
  'exit 0',
  '',
].join('\n');

let dir;

/** The fake's response key: the command plus the basename of its last argument. */
function keyFor(cmd, lastArg) {
  return `${cmd}_${path.basename(String(lastArg || 'none'))}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

const KEYS = {
  launchctl: keyFor('launchctl', 'gui/501/com.aryan.pm-engine'),
  plutil: keyFor('plutil', 'com.aryan.pm-engine.plist'),
  pgrep: keyFor('pgrep', 'profitability_engine_fixed.py'),
  config: keyFor('cat', 'polymarket_config.json'),
  state: keyFor('cat', 'engine_state.json'),
  gate: keyFor('cat', 'profitability_gate.json'),
  exclusions: keyFor('cat', 'market_exclusions.json'),
  audit: keyFor('tail', 'signal_audit.jsonl'),
  ps: keyFor('ps', 'command='),
};

function put(name, content) { fs.writeFileSync(path.join(dir, name), content); }
function drop(name) { try { fs.rmSync(path.join(dir, name)); } catch (_) { /* absent is the default */ } }
function resetLog() { fs.writeFileSync(path.join(dir, 'calls.log'), ''); }

function callCount() {
  const log = path.join(dir, 'calls.log');
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

/** Pids the fake recorded that are still alive. */
function alivePids() {
  const log = path.join(dir, 'calls.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => Number(line.split(' ')[0]))
    .filter((pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } });
}

function unreachableMini() { put('mode', 'unreachable'); }
function stalledMini(seconds) { put('sleep', String(seconds)); }
function clearStall() { drop('sleep'); drop('grandchild'); }

/** A mini that answers everything, engine running and paper-only. */
function healthyMini() {
  drop('mode'); clearStall();
  Object.values(KEYS).forEach((key) => { drop(`${key}.out`); drop(`${key}.exit`); });
  put(`${KEYS.launchctl}.out`, ' gui/501/com.aryan.pm-engine = {\n\tstate = running\n\tpid = 4242\n\tpath = /Users/a/Library/LaunchAgents/com.aryan.pm-engine.plist\n}\n');
  put(`${KEYS.plutil}.out`, JSON.stringify({
    Label: 'com.aryan.pm-engine',
    ProgramArguments: ['/usr/bin/python3', '/Users/a/polymarket/research/profitability_engine_fixed.py', '--paper'],
    WorkingDirectory: '/Users/a/polymarket',
  }));
  put(`${KEYS.config}.out`, JSON.stringify({ paper_only: true }));
  put(`${KEYS.state}.out`, JSON.stringify({
    timestamp: '2026-10-12T07:00:00Z', dry_run: false, trade_history: [{ id: 1 }],
    performance_metrics: { net_pnl: 3.5, realized_edge: 0.02 },
    execution_engine: { order_books: { m1: { bids: [[0.4, 10]], asks: [[0.5, 5]], updated_at: 'x' } }, orders: { o1: 1 }, fills: [], positions: {}, closed_positions: [] },
  }));
  put(`${KEYS.gate}.out`, JSON.stringify({ gate_status: 'open', priced_exits: 2, requirements_met: true }));
  put(`${KEYS.exclusions}.out`, JSON.stringify({ exclusions: [] }));
  put(`${KEYS.audit}.out`, '{"decision":"allow"}\n{"decision":"reject","reason":"spread (too wide)"}\n');
  put(`${KEYS.pgrep}.out`, '4242\n');
  put(`${KEYS.ps}.out`, '/usr/bin/python3 /Users/a/polymarket/research/profitability_engine_fixed.py --paper\n');
}

async function bootServer() {
  const fixture = makeFixtureHive();
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  return { fixture, http, server };
}

/**
 * Requests for the booted-server tests, with keep-alive explicitly off. The harness helper
 * uses fetch, whose pooled sockets stay registered after server.close(), and that alone
 * keeps the test process alive until the runner times the file out -- a suite that hangs is
 * a suite nobody runs.
 */
function rawRequest(port, pathname, method) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: method || 'GET',
      agent: false, headers: { connection: 'close' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function shutdown(target) {
  // server.close() stops new connections but leaves established keep-alive sockets open,
  // and the client here is the same process -- so nothing ever closes them and the test
  // process refuses to exit. Without this the file hangs until the runner times it out.
  if (target.http.server.closeAllConnections) target.http.server.closeAllConnections();
  await target.http.close();
  target.fixture.cleanup();
}

/** Let the ssh pool drain, so a contract check never races its own concurrency cap. */
async function poolIdle() {
  const until = Date.now() + 6000;
  while (remote.sshPoolState().active > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const timed = async (fn) => { const at = Date.now(); const out = await fn(); return { out, ms: Date.now() - at }; };

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fake-ssh-'));
  fs.writeFileSync(path.join(dir, 'ssh'), FAKE_SSH, { mode: 0o755 });
  process.env.POLYMARKET_SSH_BIN = path.join(dir, 'ssh');
  process.env.FAKE_SSH_DIR = dir;
  // File-wide ceiling: a stalled stub is bounded by the deadline the code under test
  // actually applies, so no test can leave a 12s child running past its own assertions.
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
});

test.after(async () => {
  // Requests deliberately do not wait for the refresh, so a panel read can leave children
  // running after the last assertion. The booted server holds its own instance of this
  // module with its own pool, so the drain watches process-wide child handles rather than
  // this file's slot counter, which would report 0 while the server's children are alive.
  const children = () => (process._getActiveHandles() || [])
    .filter((handle) => handle && handle.constructor && handle.constructor.name === 'ChildProcess');
  const deadline = Date.now() + 8000;
  while (children().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (children().length) {
    console.error(`stub children still open at teardown: ${children().map((c) => (c.spawnargs || []).slice(-2).join(' ')).join(' | ')}`);
  }
  assert.equal(children().length, 0, 'remote children outlived the suite');
  assert.equal(remote.sshPoolState().active, 0, 'a remote slot was never released');
  for (const key of ['POLYMARKET_SSH_BIN', 'FAKE_SSH_DIR']) delete process.env[key];
  delete process.env.POLYMARKET_SSH_TIMEOUT_MS;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// ---------- 0. the fixture channel itself ----------

test('the fake ssh really serves its canned responses', async () => {
  // Every assertion below depends on the stub being reached. Without this guard a broken
  // key or path makes the stub answer "empty and successful", and the suite would pass by
  // measuring nothing -- which is how the first draft of this file fooled itself.
  //
  // The deadline is raised for this test alone: it asserts the fixture channel, and nothing
  // about timing. Under a full-suite run (~40 test processes at once) a trivial /bin/sh child
  // measured here can be descheduled past the 1200ms default, and that showed up as this
  // guard failing on time rather than on evidence -- the one failure mode that would make
  // every other test in the file untrustworthy.
  healthyMini();
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '8000';
  try {
    const state = await remote.runOnMini('cat', ['/Users/a/polymarket/research/engine_state.json']);
    assert.equal(state.ok, true, JSON.stringify(state));
    assert.match(state.stdout, /engine_state|"timestamp"/, 'the canned engine_state file was not read');
    assert.equal(JSON.parse(state.stdout).performance_metrics.net_pnl, 3.5);

    const launchctl = await remote.runOnMini('launchctl', ['print', 'gui/501/com.aryan.pm-engine']);
    assert.equal(launchctl.ok, true);
    assert.match(launchctl.stdout, /pid = 4242/, 'the canned launchctl output was not read');

    const unstubbed = await remote.runOnMini('cat', ['/Users/a/polymarket/research/no_such_file.json']);
    assert.equal(unstubbed.ok, true, 'the stub defaults to "ran, printed nothing"');
    assert.equal(unstubbed.stdout, '', 'so any non-empty expectation below really did come from a stub file');
  } finally {
    process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
  }
});

// ---------- 1. the panel path never blocks ----------

test('a stalled mini cannot delay a polymarket panel request', async () => {
  healthyMini();
  stalledMini(1.5);
  // Bound the background refresh so the suite does not leave 5s children running; the
  // assertion is about the panel answering in milliseconds either way.
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '900';
  const target = await bootServer();
  const ticks = [];
  let ticker = null;
  try {
    const armedAt = Date.now();
    ticker = setInterval(() => ticks.push(Date.now()), 25);
    const polymarket = await timed(() => rawRequest(target.http.port, '/api/polymarket'));
    const agents = await timed(() => rawRequest(target.http.port, '/api/agents'));
    const status = await timed(() => rawRequest(target.http.port, '/api/polymarket/status'));
    // Keep the loop observed while the refresh is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(polymarket.out.status, 200, 'the route must answer, not hang');
    assert.ok(polymarket.ms < 500, `/api/polymarket took ${polymarket.ms}ms with ssh stalled at 1.5s`);
    assert.ok(agents.ms < 500, `/api/agents took ${agents.ms}ms behind a stalled ssh fan-out`);
    assert.ok(status.ms < 500, `/api/polymarket/status took ${status.ms}ms`);
    assert.ok(ticks.length >= 6, `the ticker fired only ${ticks.length} times in ~350ms`);
    assert.ok(ticks[0] - armedAt < 200, `first tick fired ${ticks[0] - armedAt}ms late`);
    const worstGap = Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]));
    assert.ok(worstGap < 200, `event loop gap ${worstGap}ms while ssh was stalled`);

    // Same response, second job: an observation that has not completed yet must read as
    // absent, not healthy, and must not smuggle freshness into the pinned payload.
    const body = status.out.json;
    assert.equal(body.managed, false);
    assertNoLiveOrderAdvertisement(body, 'unevidenced polymarket status');
    assertExecutionImpliesPaperOnly(body);
    assert.ok(!('remote_status' in body), 'freshness must not leak into the pinned payload');
    assert.equal(status.out.headers['x-hud-evidence-state'], 'never');
    assert.equal(status.out.headers['x-hud-evidence-observed'], 'false');
    assert.equal(status.out.headers['x-hud-evidence-age-ms'], 'unknown');
    assert.equal(status.out.headers['x-hud-evidence-refreshing'], 'true', 'the refresh runs in the background');
  } finally {
    // An interval left running is enough to keep this process alive forever: every
    // assertion can pass while the runner waits on a file that never exits.
    if (ticker) clearInterval(ticker);
    process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
    clearStall();
    await shutdown(target);
  }
});

test('the mini recovering is visible without a restart', async () => {
  healthyMini();
  unreachableMini();
  const down = await remote.refreshObservation('state', 6000, { force: true });
  assert.equal(ev('state').state, 'ssh-unreachable');
  assert.equal(down.present, false);

  drop('mode');
  const up = await remote.refreshObservation('state', 8000, { force: true });
  assert.equal(ev('state').state, 'ok');
  assert.equal(ev('state').observed, true);
  assert.equal(up.present, true);
  assert.equal(up.trades, 1);
  assert.equal(up.net_pnl, 3.5);
});

// ---------- 2. fan-out is concurrent and capped ----------

test('one refresh fans out concurrently instead of end to end', async () => {
  healthyMini();
  stalledMini(0.4);
  const at = Date.now();
  const result = await remote.refreshObservation('runtime', 8000, { force: true });
  const ms = Date.now() - at;
  // Six sequential 0.4s calls would be ~2.4s; the cap of 3 plus the dependent ps call
  // bounds it at roughly two rounds.
  assert.ok(ms < 1800, `fan-out took ${ms}ms -- the calls are still effectively sequential`);
  assert.equal(ev('runtime').state, 'ok');
  clearStall();
});

test('a burst of concurrent remote work is capped, and the excess is refused honestly', async () => {
  healthyMini();
  stalledMini(0.2);
  resetLog();
  const results = await Promise.all(
    Array.from({ length: 12 }, (unused, i) => remote.runOnMini('launchctl', ['print', `gui/501/job${i}`])),
  );
  clearStall();
  const ran = results.filter((r) => r.ok);
  const refused = results.filter((r) => r.reason === 'saturated');
  assert.ok(ran.length <= remote.MAX_CONCURRENT_SSH,
    `${ran.length} remote commands ran against a cap of ${remote.MAX_CONCURRENT_SSH}`);
  assert.equal(refused.length, 12 - ran.length, 'every excess call was refused, not queued behind a stall');
  for (const result of results) {
    assert.ok(result.ok || result.reason === 'saturated', `unexpected outcome ${JSON.stringify(result)}`);
    assert.ok(!result.ok || result.stdout !== undefined, 'a refusal is a settled answer, not a hang');
  }
  assert.equal(remote.sshPoolState().active, 0, 'a slot was never released');
  assert.ok(remote.sshPoolState().peak <= remote.MAX_CONCURRENT_SSH, `peak ${remote.sshPoolState().peak}`);
  // No queue means no caller can be starved: every call in the burst settled.
  assert.equal(results.length, 12);
});

test('saturation is reported as saturation, never as an unreachable mini', async () => {
  healthyMini();
  stalledMini(0.5);
  const held = Array.from({ length: remote.MAX_CONCURRENT_SSH }, (unused, i) => remote.runOnMini('launchctl', ['print', `gui/501/hold${i}`]));
  const extra = await remote.runOnMini('launchctl', ['print', 'gui/501/extra']);
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, 'saturated');
  assert.match(extra.detail, /already running/);
  await held;
  clearStall();
});

test('a deadline-killed poll leaks no stdio resources', async () => {
  // The leak this guards is invisible in one request and fatal in a server: a killed ssh
  // whose stdio stays registered keeps its pipes open forever, so a mini that remains
  // unreachable walks a long-running HUD up to its fd limit.
  //
  // Measured on active *resources*, not _getActiveHandles(): an earlier draft of this test
  // counted ChildProcess handles, came back clean, and missed two PipeWrap entries that
  // never went away -- the handles were unref'd, the descriptors were still open.
  const resources = () => (process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [])
    .filter((kind) => /Pipe|TTY|FSEvent|FSReq|StatWatcher/.test(kind));
  healthyMini();
  stalledMini(4);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '200';
  const before = resources().length;
  const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => remote.runOnMini('launchctl', ['print', 'gui/501/x'])));
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
  clearStall();
  for (const result of results) assert.ok(result.ok || result.reason === 'saturated' || result.reason === 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = resources().length;
  assert.ok(after <= before, `stdio resources grew from ${before} to ${after} after eight killed polls: ${resources().join(',')}`);
});

// ---------- 3. failure modes stay distinct ----------

test('timeout, unreachable host and remote command failure are three different answers', async () => {
  healthyMini();
  stalledMini(1.5);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '250';
  const timeout = await remote.runOnMini('launchctl', ['print', 'gui/501/com.aryan.pm-engine']);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
  clearStall();

  unreachableMini();
  const unreachable = await remote.runOnMini('launchctl', ['print', 'gui/501/com.aryan.pm-engine']);

  drop('mode');
  put(`${KEYS.config}.exit`, '2');
  const remoteFailure = await remote.runOnMini('cat', ['/Users/a/trading/openalice-fleet/hive/polymarket_config.json']);

  assert.equal(timeout.reason, 'timeout', JSON.stringify(timeout));
  assert.equal(timeout.ok, false);
  assert.equal(unreachable.reason, 'ssh-unreachable', JSON.stringify(unreachable));
  assert.match(unreachable.detail, /Operation timed out/, 'the host message is what an operator needs');
  assert.equal(unreachable.exitCode, 255);
  assert.equal(remoteFailure.reason, 'remote-exit', JSON.stringify(remoteFailure));
  assert.equal(remoteFailure.exitCode, 2);
});

test('pgrep matching nothing is an answer, not an outage', async () => {
  healthyMini();
  put(`${KEYS.pgrep}.exit`, '1');
  drop(`${KEYS.pgrep}.out`);
  const result = await remote.runOnMini('pgrep', ['-f', 'profitability_engine_fixed.py']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote-exit');
  assert.equal(remote.isNoMatch(result, 'pgrep'), true, 'no-match must be recognised as an answer');

  const runtime = await remote.refreshObservation('runtime', 8000, { force: true });
  assert.equal(ev('runtime').state, 'ok', 'an idle engine is not an unreachable mini');
  assert.equal(runtime.running, false);
  assert.deepEqual(runtime.process.pids, []);
  assert.equal(runtime.paper_only, true, 'the engine being stopped says nothing about the config');
});

test('an unreachable mini fails the runtime evidence closed and says why', async () => {
  healthyMini();
  unreachableMini();
  const runtime = await remote.refreshObservation('runtime', 8000, { force: true });
  drop('mode');
  assert.equal(ev('runtime').state, 'ssh-unreachable');
  assert.equal(runtime.managed, false, 'unreachable mini must not look managed');
  assert.equal(runtime.running, false, 'unreachable mini must not claim a running engine');
  assertNoLiveOrderAdvertisement(runtime, 'unreachable mini');
  assertExecutionImpliesPaperOnly(runtime);
  assert.equal(runtime.launchd.loaded, false);
  assert.equal(runtime.launchd.state, 'unavailable');
  assert.equal(runtime.config.present, false);
  assert.equal(runtime.plist.valid, false);
});

test('an engine state file bigger than the read budget is named, not swallowed', async () => {
  // Measured on the real mini on 2026-10-13: engine_state.json is 11,858,709 bytes against a
  // 10 MiB budget. The deployed synchronous code turned the resulting ENOBUFS into a bare
  // `null`, so the panel showed nothing and said nothing; reading it anyway and failing
  // afterwards moves 10 MB across the tailnet to arrive at the same empty result. So the size
  // is asked first, and the refusal quotes the number.
  const wcKey = keyFor('wc', 'engine_state.json');
  healthyMini();
  put(`${wcKey}.out`, '11858709 /Users/a/polymarket/research/engine_state.json\n');
  try {
    await poolIdle();
    // Drain first, then clear the log: the calls recorded by earlier tests in this file are
    // not evidence about this one, and an assertion over the accumulated log passes or fails
    // depending on test order rather than on the code.
    resetLog();
    const state = await remote.refreshObservation('state', 8000, { force: true });
    const calls = fs.existsSync(path.join(dir, 'calls.log'))
      ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
    assert.equal(ev('state').state, 'output-too-large', JSON.stringify(ev('state')));
    assert.match(ev('state').detail, /11858709 bytes/, 'the size must be quoted, not guessed');
    assert.match(ev('state').detail, /10485760-byte read budget/);
    // The stub logs pid, command and resolved key, so "which file" is answerable. What must
    // not happen is transferring the 11.9 MB state file; what must happen is reading the two
    // small files beside it, because they answer and dropping them would report an outage
    // that did not occur.
    assert.ok(!calls.includes(KEYS.state), `the oversized state file must never be fetched: ${calls}`);
    assert.ok(calls.includes(`wc ${wcKey}`), 'and the size must really have been asked for');
    assert.ok(calls.includes(`cat ${KEYS.gate}`), 'the gate file is a separate read and must still happen');
    assert.ok(calls.includes(`tail ${KEYS.audit}`), 'the audit log is a separate read and must still happen');
    assert.equal(Object.keys(state).length, 8, 'the fail-closed body keeps its pinned width');
    assert.equal(state.present, false);
    assert.equal(state.mode, 'unavailable');
    assert.equal(state.trades, 0, 'a state the host never read must not be counted');
    assert.equal(state.net_pnl, null);
    // ...and the evidence it did read survives the failure of the file next to it.
    assert.deepEqual(state.gate, { status: 'open', priced_exits: 2, requirements_met: true });
    assert.equal(state.audit.total, 2);
    assert.equal(state.audit.allowed, 1);
    // The trailing space is real, and pre-existing: both the deployed synchronous code and
    // this rewrite derive the key with split('(')[0] and never trim it, so a reject reason of
    // "spread (too wide)" is filed under "spread ". Changing that key would alter what the
    // panel renders, which is a different change from getting the loop back, so it is pinned
    // as it is rather than fixed quietly inside this lane.
    assert.deepEqual(state.audit.reject_reasons, { 'spread ': 1 });

    await poolIdle();
    const markets = await remote.refreshObservation('markets', 8000, { force: true });
    assert.equal(ev('markets').state, 'output-too-large');
    assert.equal(Object.keys(markets).length, 6);
    assert.deepEqual(markets.markets, [], 'order books come from the state file, so they are genuinely absent');
    assert.equal(markets.exclusions.present, true, 'the exclusions file is separate and readable');
    assert.equal(markets.exclusions.count, 0);
    assert.equal(markets.exclusions.error, null, 'a readable exclusions file must not carry the state file error');

    // A host that cannot state a size is not a host that is down: the read still happens and
    // still succeeds. Without this the pre-flight would be a new way to invent an outage.
    drop(`${wcKey}.out`);
    await poolIdle();
    const recovered = await remote.refreshObservation('state', 8000, { force: true });
    assert.equal(ev('state').state, 'ok', JSON.stringify(ev('state')));
    assert.equal(recovered.net_pnl, 3.5);
  } finally {
    drop(`${wcKey}.out`);
  }
});

// ---------- 4. termination is real ----------

test('a stalled ssh and its process group are gone by the deadline', async () => {
  healthyMini();
  resetLog();
  put('grandchild', 'x');
  stalledMini(30);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '300';
  const result = await remote.runOnMini('launchctl', ['print', 'gui/501/com.aryan.pm-engine']);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
  clearStall();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(result.reason, 'timeout');
  assert.ok(result.durationMs < 2500, `kill took ${result.durationMs}ms`);
  assert.deepEqual(alivePids(), [], `children survived their deadline: ${alivePids().join(',')}`);
});

// ---------- 5. the action gates are not weakened ----------

test('the start gate refuses when no fresh evidence can be produced', async () => {
  healthyMini();
  unreachableMini();
  resetLog();
  process.env.POLYMARKET_SSH_TIMEOUT_MS = '400';
  const target = await bootServer();
  try {
    const { out, ms } = await timed(() => rawRequest(target.http.port, '/api/polymarket/start', 'POST'));
    assert.ok([501, 409].includes(out.status), `start returned ${out.status}, expected a refusal`);
    assert.ok(ms < 8000, `the gate waited ${ms}ms -- it must be bounded`);
    assert.notEqual(out.json && out.json.started, true, 'no engine may be claimed started');
    assert.ok(callCount() > 0, 'the gate should have tried to get fresh evidence');
  } finally {
    process.env.POLYMARKET_SSH_TIMEOUT_MS = '1200';
    drop('mode');
    await shutdown(target);
  }
});

test('a healthy paper-only engine is still allowed, and the gate forces its own read', async () => {
  healthyMini();
  const runtime = await remote.refreshObservation('runtime', 8000, { force: true });
  assert.equal(ev('runtime').state, 'ok');
  assert.equal(ev('runtime').observed, true);
  assert.equal(runtime.managed, true);
  assert.equal(runtime.paper_only, true);
  assert.equal(runtime.running, true);
  assert.equal(runtime.pid, 4242);
  assert.equal(runtime.launchd.expected_loaded, true);
  assert.equal(runtime.execution_allowed, true, 'the guard must not become a blanket refusal');
});

test('the gate is refused when the evidence arrives too late, not guessed from a snapshot', async () => {
  healthyMini();
  stalledMini(3);
  const at = Date.now();
  const gated = await remote.refreshObservation('runtime', 400, { force: true });
  const ms = Date.now() - at;
  clearStall();
  assert.ok(ms < 1500, `the gate waited ${ms}ms past its 400ms budget`);
  assert.equal(ev('runtime').state, 'gate-timeout');
  assert.equal(ev('runtime').observed, false);
  assertExecutionImpliesPaperOnly(gated);
  assertNoLiveOrderAdvertisement(gated, 'gate-timeout observation');
  assert.equal(gated.managed, false, 'no evidence may authorise launchctl');
  // Recovery: a timed-out observation must not stick. Force a fresh attempt once the
  // stub is responsive again, or the panel would keep serving the earlier failure.
  const later = await remote.refreshObservation('runtime', 8000, { force: true });
  assert.equal(ev('runtime').state, 'ok', JSON.stringify(ev('runtime')));
});

test('a caller that gives up stops waiting instead of leaving a timer chain', async () => {
  // The gate used to poll on a 25ms chain until the observation landed or 400 polls had
  // passed, so a caller that had already returned kept rescheduling timers for seconds
  // afterwards. That is the same class of resource that turned "every assertion passed"
  // into a test file that could not exit, so the channel is now an explicit waiter list
  // and this test can count its own registrations instead of unrelated timers.
  healthyMini();
  stalledMini(3);
  const waiting = remote.refreshObservation('runtime', 200, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remote.pendingWaiters('runtime'), 1, 'a caller must be registered while it waits');
  const gated = await waiting;
  assert.equal(remote.pendingWaiters('runtime'), 0, 'a given-up caller must not stay registered');
  assert.equal(ev('runtime').state, 'gate-timeout');
  assertExecutionImpliesPaperOnly(gated);
  clearStall();
  await poolIdle();
  // The wake path itself: a completion must answer the waiter, and leave nobody behind.
  const done = await remote.refreshObservation('runtime', 8000, { force: true });
  assert.equal(remote.pendingWaiters('runtime'), 0);
  assert.equal(ev('runtime').state, 'ok', JSON.stringify(ev('runtime')));
  assert.equal(done.paper_only, true);
});

// ---------- 6. the contract the UI reads is unchanged ----------

test('the remote payloads keep every field the panels already read', async () => {
  healthyMini();
  // Sequential, with the pool drained between getters: nine children at once would
  // legitimately saturate the cap and a refused read is a partial payload, which is the
  // wrong thing to blame a field contract on.
  await poolIdle();
  const runtime = await remote.refreshObservation('runtime', 8000, { force: true });
  await poolIdle();
  for (const key of ['checked_at', 'engine_path', 'expected_engine_path', 'expected_plist_path',
    'paper_only', 'managed', 'running', 'pid', 'process', 'launchd', 'config', 'plist', 'execution_allowed']) {
    assert.ok(key in runtime, `runtime payload lost ${key}`);
  }
  for (const key of ['loaded', 'state', 'pid', 'path', 'error', 'expected_path', 'expected_loaded']) {
    assert.ok(key in runtime.launchd, `launchd block lost ${key}`);
  }

  const state = await remote.refreshObservation('state', 8000, { force: true });
  await poolIdle();
  for (const key of ['present', 'mode', 'trades', 'net_pnl', 'realized_edge', 'updated_at', 'gate', 'audit']) {
    assert.ok(key in state, `state payload lost ${key}`);
  }
  assert.equal(state.mode, 'paper');
  assert.deepEqual(Object.keys(state.audit).sort(), ['allowed', 'reject_reasons', 'rejected', 'total']);
  assert.equal(state.audit.allowed, 1);
  assert.deepEqual(Object.keys(state.audit.reject_reasons), ['spread ']);

  const markets = await remote.refreshObservation('markets', 8000, { force: true });
  for (const key of ['present', 'state_path', 'updated_at', 'summary', 'markets', 'exclusions']) {
    assert.ok(key in markets, `markets payload lost ${key}`);
  }
  assert.equal(markets.markets.length, 1);
  assert.equal(markets.markets[0].mid, 0.45);
  assert.equal(markets.summary.orders, 1);
  assert.equal(markets.exclusions.count, 0);

  // The payload stays exactly as wide as the contract pins it; this fails if a freshness
  // field ever creeps back in. Evidence is a separate report with its own keys.
  assert.equal(Object.keys(runtime).length, 13, `runtime payload is ${Object.keys(runtime).join(',')}`);
  assert.equal(Object.keys(state).length, 8, `state payload is ${Object.keys(state).join(',')}`);
  assert.equal(Object.keys(markets).length, 6, `markets payload is ${Object.keys(markets).join(',')}`);
  for (const name of ['runtime', 'state', 'markets']) {
    const report = ev(name);
    for (const key of ['state', 'observed', 'age_ms', 'refresh_interval_ms', 'refreshing', 'reason', 'detail']) {
      assert.ok(key in report, `evidence report for ${name} lost ${key}`);
    }
  }
});

test('the paper gate is still computed from paperOnly in the server source', async () => {
  // The helper's second argument is the server's own text: the guarantee that
  // execution_allowed is derived from paperOnly lives in index.js, and a refactor that
  // disconnects them must fail here rather than in a live order.
  healthyMini();
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const runtime = await remote.refreshObservation('runtime', 8000, { force: true });
  assertExecutionImpliesPaperOnly(runtime, source);
  assert.match(source, /execution_allowed:[^;]*paperOnly/, 'the gate wiring moved');
});

test('the ssh seam is development-only and the routes keep using the bounded runner', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'polymarket_remote.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(lib, /NODE_ENV === 'production' \? 'ssh'/, 'production must hard-code ssh');
  assert.match(lib, /const \{ spawn \} = require\('child_process'\)/, 'the runner must spawn, not execute synchronously');
  assert.doesNotMatch(lib, /execFileSync\(/, 'the panel path must not call a synchronous child executor');
  assert.match(source, /require\('\.\/lib\/polymarket_remote'\)/, 'index.js must use the runner');
  assert.doesNotMatch(source, /process\.env\.POLYMARKET_SSH_BIN/, 'index.js must not read the ssh override');
  assert.doesNotMatch(source, /execFileSync\('ssh'/, 'index.js must not shell out to ssh itself');
});

test('isLaptop does not shell out per call', async () => {
  healthyMini();
  resetLog();
  for (let i = 0; i < 20; i += 1) remote.isLaptop();
  assert.equal(callCount(), 0, 'isLaptop spawned a child on every call');
  assert.equal(remote.isLaptop(), true);
});

test('runOnMini resolves for every input, never rejects, and clamps its deadline', async () => {
  healthyMini();
  const unset = process.env.POLYMARKET_SSH_TIMEOUT_MS;
  delete process.env.POLYMARKET_SSH_TIMEOUT_MS;
  const results = await Promise.all([
    remote.runOnMini('/no/such/command', ['x']),
    remote.runOnMini('launchctl', ['print', 'x'], { timeoutMs: 1000000 }),
    remote.runOnMini('launchctl', ['print', 'y']),
    remote.runOnMini('launchctl', ['print', 'z'], { timeoutMs: 'not-a-number' }),
  ]);
  process.env.POLYMARKET_SSH_TIMEOUT_MS = unset;
  for (const result of results) {
    assert.equal(typeof result.durationMs, 'number');
    assert.ok('ok' in result);
  }
  // Asserted on the applied budget rather than on elapsed time: a 1e6 ms deadline that was
  // honoured would restore the original unbounded-wait defect, and measuring it by waiting
  // would leave a real child running past the end of the suite.
  assert.equal(results[1].deadlineMs, remote.MAX_SSH_DEADLINE_MS, 'a 1e6ms budget must be clamped, not honoured');
  assert.equal(results[0].deadlineMs, remote.DEFAULT_SSH_DEADLINE_MS);
  assert.equal(results[3].deadlineMs, remote.DEFAULT_SSH_DEADLINE_MS, 'a garbage budget falls back, never to "no timeout"');
});
