'use strict';
// Regression guard for the /api/health event-loop stall, and for the deadline that
// replaces it.
//
// The handler used execFileSync, so the process parked for as long as health_probe.py
// took. That probe shells out to pgrep/ps and reads cross-host state, and its children
// carry 5s/10s/20s budgets, so the same code was measured at 0.04s and at 5.2s on the
// deployed HUD. The route that reports outages became one.
//
// What has to stay true, and where each property came from:
//   1. the probe budget fits inside the shortest caller (3.0s), and a misconfigured
//      budget cannot exceed it -- the competing PR's 45s default could not keep that
//      promise,
//   2. a hung probe degrades inside its own budget and names why,
//   3. a slow probe delays /api/health only, never /api/agents or /api/services/health,
//   4. a failed probe keeps the response keys a success has, because truth_guard.py
//      reads an absent `checks` as the hardcoded-ok regression,
//   5. the child is actually gone, including its own children.
//
// healthProbeBlockingControl.test.js is the positive control for 2 and 3: it takes the
// same measurements against the old blocking handler and requires them to fail there,
// so this suite cannot pass by asserting nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const {
  runHealthProbe, createSingleFlight, resolveArgv, clampDeadlineMs, failedProbePayload,
  PROBE_CHECK_NAME, DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, MIN_DEADLINE_MS,
  MIN_CALLER_BUDGET_MS, CALLER_RESERVE_MS,
} = require('../lib/healthProbe');

const PROBE_ENV = ['HEALTH_PROBE_ARGV', 'HEALTH_PROBE_SCRIPT', 'HEALTH_PROBE_PATH',
  'HEALTH_PROBE_BIN', 'HEALTH_PROBE_PYTHON', 'HEALTH_PROBE_TIMEOUT_MS'];

const HEALTHY_PAYLOAD = {
  ok: true, checks: [], failing: [], warnings: [], not_verified: [],
};

function clearProbeEnv() {
  for (const key of PROBE_ENV) delete process.env[key];
}

/** shell body that prints the healthy payload as the child's whole stdout */
const PRINT_HEALTHY = `printf %s '${JSON.stringify(HEALTHY_PAYLOAD).replace(/'/g, "'\\''")}'`;

/** argv for a shell one-liner that prints `payload` as its whole stdout. */
function sh(body) {
  return ['/bin/sh', '-c', body];
}

function prints(payload) {
  return sh(`printf %s '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`);
}

/** A probe that would answer, but only after `seconds` -- longer than any budget. */
function slowThenHealthy(seconds) {
  return sh(`sleep ${seconds}; ${PRINT_HEALTHY}`);
}

async function boot() {
  clearProbeEnv();
  if (process.env.NODE_ENV === 'production') {
    // The probe seam is deliberately closed in production (see resolveArgv), so these
    // tests cannot stage a hung or failing probe. Say so instead of asserting against
    // the real fleet and calling the result a pass.
    assert.fail('these tests need NODE_ENV unset or != production to stage a probe');
  }
  const fixture = makeFixtureHive();
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  return { fixture, http, server };
}

async function shutdown(target) {
  clearProbeEnv();
  await target.http.close();
  target.fixture.cleanup();
}

function uniqueMarker(name) {
  return `hud-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}${name}`;
}

/** How many live processes carry this needle. pgrep exits 1 when the answer is none. */
function aliveCount(needle) {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', needle], { encoding: 'utf8' }).trim();
    return out ? out.split('\n').length : 0;
  } catch (error) {
    if (error.status === 1) return 0;
    throw error;
  }
}

const settleGrace = () => new Promise((resolve) => setTimeout(resolve, 120));

// ---------- 1. the deadline is derived from the callers, not chosen ----------

test('the probe budget fits inside the shortest caller by construction', () => {
  assert.equal(MIN_CALLER_BUDGET_MS, 3000, 'control-center/upstream.py:48 probe(timeout=3.0)');
  assert.equal(MAX_DEADLINE_MS + CALLER_RESERVE_MS, MIN_CALLER_BUDGET_MS,
    'the reserve must account for the whole caller budget');
  assert.ok(DEFAULT_DEADLINE_MS <= MAX_DEADLINE_MS, 'the default must fit the clamp');
  assert.ok(MIN_DEADLINE_MS < DEFAULT_DEADLINE_MS);
});

test('a budget wider than the caller is clamped, and says it was clamped', () => {
  // The competing implementation shipped 45000 as its default: 15x the tightest caller
  // and 11x the route-honesty checker. It could not keep the promise the PR makes.
  const wide = clampDeadlineMs(45000);
  assert.equal(wide.deadlineMs, MAX_DEADLINE_MS);
  assert.equal(wide.requestedMs, 45000);
  assert.equal(wide.clamped, true);

  for (const raw of ['not-a-number', 0, -1, '', null, undefined, NaN, Infinity, '12abc']) {
    const result = clampDeadlineMs(raw);
    assert.equal(result.deadlineMs, DEFAULT_DEADLINE_MS, `${JSON.stringify(raw)} must not disable the bound`);
    assert.ok(Number.isFinite(result.deadlineMs) && result.deadlineMs > 0);
  }
  assert.equal(clampDeadlineMs('800').deadlineMs, 800, 'a numeric override still applies');
  assert.equal(clampDeadlineMs(1234.9).deadlineMs, 1234, 'budgets are whole milliseconds');
  assert.equal(clampDeadlineMs(1).deadlineMs, MIN_DEADLINE_MS, 'a 1ms budget never lands and is refused');
});

test('HEALTH_PROBE_TIMEOUT_MS=45000 through the route still answers inside the caller', async () => {
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(slowThenHealthy(30));
    process.env.HEALTH_PROBE_TIMEOUT_MS = '45000';
    const startedAt = Date.now();
    const res = await target.http.get('/api/health');
    const ms = Date.now() - startedAt;
    assert.equal(res.json.ok, false);
    assert.equal(res.json.probe_error.reason, 'timeout');
    assert.equal(res.json.probe_deadline_ms, MAX_DEADLINE_MS);
    assert.equal(res.json.probe_deadline_requested_ms, 45000);
    assert.equal(res.json.probe_deadline_clamped, true);
    assert.ok(ms < MIN_CALLER_BUDGET_MS, `route took ${ms}ms for a requested 45s budget`);
  } finally {
    await shutdown(target);
  }
});

// ---------- 2. the probe command is configurable without being fragile ----------

test('resolveArgv honours overrides and refuses malformed ones', () => {
  assert.deepEqual(resolveArgv({ HEALTH_PROBE_ARGV: '["/bin/sh","-c","x"]' }), ['/bin/sh', '-c', 'x']);
  assert.deepEqual(resolveArgv({ HEALTH_PROBE_ARGV: 'not json' })[0], '/usr/bin/python3');
  assert.deepEqual(resolveArgv({ HEALTH_PROBE_ARGV: '[]' })[0], '/usr/bin/python3');
  assert.deepEqual(resolveArgv({ HEALTH_PROBE_ARGV: '[1,2]' })[0], '/usr/bin/python3');
  assert.deepEqual(resolveArgv({}), ['/usr/bin/python3', path.join(__dirname, '..', 'health_probe.py')]);
  assert.deepEqual(resolveArgv({ HEALTH_PROBE_SCRIPT: '/tmp/s.py' })[1], '/tmp/s.py');
});

test('a production environment cannot redirect the probe at another program', () => {
  // An env var must not be able to point a HUD route at a different executable. The
  // override is a test and local-debug seam, and it switches itself off under
  // NODE_ENV=production -- which the installed com.aryan.office-hud-server.plist sets.
  const production = {
    NODE_ENV: 'production',
    HEALTH_PROBE_ARGV: '["/tmp/attacker","-x"]',
    HEALTH_PROBE_SCRIPT: '/tmp/attacker.py',
    HEALTH_PROBE_BIN: '/tmp/attacker',
  };
  assert.deepEqual(resolveArgv(production), ['/usr/bin/python3', path.join(__dirname, '..', 'health_probe.py')]);
  // And the route goes through resolveArgv, so it inherits the same rule.
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /require\('\.\/lib\/healthProbe'\)/, 'the route must use the guarded runner');
  assert.doesNotMatch(source, /process\.env\.HEALTH_PROBE_(ARGV|SCRIPT|BIN)/,
    'index.js must not read probe path variables itself');
});

// ---------- 3. termination is bounded and real ----------

test('a hung probe is killed at its deadline and classified as a timeout', async () => {
  const started = Date.now();
  const result = await runHealthProbe({ argv: sh('sleep 30'), timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'timeout');
  assert.equal(result.error.detail, 'killed at 300ms');
  assert.ok(result.durationMs >= 280, `settled early at ${result.durationMs}ms`);
  assert.ok(Date.now() - started < 1500, `kill took ${Date.now() - started}ms`);
});

test('a child that ignores SIGTERM still dies, because the reap is SIGKILL', async () => {
  const marker = uniqueMarker('-term');
  const result = await runHealthProbe({ argv: sh(`printf %s ${marker}; trap "" TERM; sleep 30`), timeoutMs: 300 });
  assert.equal(result.error.reason, 'timeout');
  await settleGrace();
  assert.equal(aliveCount(marker), 0, 'a SIGTERM-ignoring probe survived its deadline');
});

test('a grandchild holding the stdout pipe cannot hold the response open', async () => {
  // execFile waits for the streams to close, so its timeout option alone cannot bound
  // this case: the probe is dead, its sleep is not. This is the half-alive SSH forward
  // shape that produced the 5.2s poll.
  const marker = uniqueMarker('-pipe');
  const started = Date.now();
  const result = await runHealthProbe({
    argv: sh(`( printf %s ${marker}; sleep 20 ) & sleep 0.2; printf %s x`),
    timeoutMs: 300,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'timeout');
  assert.ok(Date.now() - started < 1500, `response waited ${Date.now() - started}ms on a pipe`);
  await settleGrace();
  assert.equal(aliveCount(marker), 0, 'the probe grandchild outlived its parent');
});

test('a probe that answered but left a pipe open is a success, not an outage', async () => {
  // Truthfulness runs both ways: calling a completed probe a timeout is the same class
  // of lie as the hardcoded ok:true this route used to ship.
  const result = await runHealthProbe({
    argv: sh(`( sleep 20 ) & ${PRINT_HEALTHY}`),
    timeoutMs: 250,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data.checks, []);
});

// ---------- 4. every failure mode has its own name ----------

test('failure modes are classified, never folded into healthy or into each other', async () => {
  const cases = [
    { argv: sh('exit 3'), reason: 'exit-nonzero', exitCode: 3 },
    { argv: sh('printf %s nope'), reason: 'unparseable-output' },
    { argv: prints([1, 2]), reason: 'not-an-object' },
    { argv: sh('printf %s null'), reason: 'not-an-object' },
    { argv: sh('printf %s 5'), reason: 'not-an-object' },
    // Valid JSON, an object, and still no verdict. Each of these used to spread into a
    // payload with no `ok` key, which the monitors read as their own failure.
    { argv: sh("printf %s '{}'"), reason: 'incomplete-payload' },
    { argv: sh("printf %s '{\"ok\":true}'"), reason: 'incomplete-payload' },
    { argv: sh("printf %s '{\"checks\":[]}'"), reason: 'incomplete-payload' },
    { argv: prints(HEALTHY_PAYLOAD), reason: null, ok: true },
    { argv: ['/usr/bin/definitely-not-here', 'x'], reason: 'spawn-failed' },
  ];
  for (const expected of cases) {
    const result = await runHealthProbe({ argv: expected.argv, timeoutMs: 1000 });
    assert.equal(result.ok, expected.ok === undefined ? false : expected.ok,
      `${JSON.stringify(expected.argv)} -> ${JSON.stringify(result.error || result.data)}`);
    if (expected.reason) assert.equal(result.error.reason, expected.reason);
    if (expected.exitCode !== undefined) assert.equal(result.exitCode, expected.exitCode);
    if (expected.ok) assert.equal(result.data.ok, true);
  }
});

test('oversized probe output is refused, and the child is reaped', async () => {
  const marker = uniqueMarker('-big');
  const result = await runHealthProbe({
    argv: sh(`printf %s ${marker}; printf %s $(printf '0%.0s' $(seq 1 20000)); printf %s '{"ok": true}'`),
    timeoutMs: 2000,
    maxBuffer: 4096,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'output-too-large');
  await settleGrace();
  assert.equal(aliveCount(marker), 0, 'the oversized probe was left running');
});

test('runHealthProbe resolves for every input and never rejects', async () => {
  const results = await Promise.all([
    runHealthProbe({ argv: sh('sleep 5'), timeoutMs: 200 }),
    runHealthProbe({ argv: sh('exit 9'), timeoutMs: 200 }),
    runHealthProbe({ argv: ['/no/such/binary', 'x'], timeoutMs: 200 }),
    runHealthProbe({ argv: sh('printf %s no-json'), timeoutMs: 200 }),
  ]);
  for (const result of results) {
    assert.equal(typeof result.durationMs, 'number');
    assert.equal(typeof result.deadlineMs, 'number');
    assert.equal(result.ok, false);
    assert.ok(result.error && typeof result.error.reason === 'string');
  }
});

// ---------- 5. parallel callers share one probe, per configuration ----------

test('concurrent probes with the same configuration share one child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-probe-dedupe-'));
  const markerFile = path.join(dir, 'spawned.txt');
  const flight = createSingleFlight(() => runHealthProbe({
    argv: sh(`printf x >> ${JSON.stringify(markerFile)}; sleep 0.4; ${PRINT_HEALTHY}`),
    timeoutMs: 2000,
  }));
  try {
    const results = await Promise.all([flight('k'), flight('k'), flight('k'), flight('k')]);
    for (const result of results) assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(markerFile, 'utf8').length, 1, 'one config, several children');
    const other = await flight('different');
    assert.equal(other.ok, true);
    assert.equal(fs.readFileSync(markerFile, 'utf8').length, 2, 'a new config must not reuse a stale result');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 6. the route, over HTTP ----------

test('a hung probe degrades inside the shortest caller, over the wire', async () => {
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(slowThenHealthy(30));
    const startedAt = Date.now();
    const res = await target.http.get('/api/health');
    const ms = Date.now() - startedAt;
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false, 'a killed probe must not claim health');
    assert.equal(res.json.probe_error.reason, 'timeout');
    assert.equal(res.json.probe_deadline_ms, DEFAULT_DEADLINE_MS);
    assert.ok(ms >= DEFAULT_DEADLINE_MS - 50, `gave up early at ${ms}ms`);
    assert.ok(ms < MIN_CALLER_BUDGET_MS,
      `/api/health took ${ms}ms; control-center waits ${MIN_CALLER_BUDGET_MS}ms`);
    // The pre-existing contract survives the failure.
    assert.equal(res.json.hive, target.fixture.hive);
    assert.equal(res.json.present, true);
    assert.equal(typeof res.json.ts, 'number');
  } finally {
    await shutdown(target);
  }
});

test('a degraded answer is never echoed to the next poll', async () => {
  // In-flight sharing is a dedupe, not a cache. A stored failure would keep reporting an
  // outage the fleet has already recovered from, and a stored success would hide a new
  // one -- both are fabricated health wearing a performance hat.
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_TIMEOUT_MS = '300';
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(slowThenHealthy(30));
    const first = await target.http.get('/api/health');
    assert.equal(first.json.ok, false);
    assert.equal(first.json.probe_error.reason, 'timeout');

    process.env.HEALTH_PROBE_ARGV = JSON.stringify(prints(HEALTHY_PAYLOAD));
    const second = await target.http.get('/api/health');
    assert.equal(second.json.ok, true, 'a recovered probe must not inherit the earlier failure');

    process.env.HEALTH_PROBE_ARGV = JSON.stringify(sh('exit 8'));
    const third = await target.http.get('/api/health');
    assert.equal(third.json.probe_error.reason, 'exit-nonzero', 'an earlier success was reused');
  } finally {
    await shutdown(target);
  }
});

test('a failed probe keeps the keys a successful probe has', async () => {
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(sh('exit 7'));
    const failed = (await target.http.get('/api/health')).json;
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(prints({ ...HEALTHY_PAYLOAD, checked_at: 12345 }));
    const ok = (await target.http.get('/api/health')).json;

    // Not cosmetic: truth_guard.py fails the run when `checks` is absent, so a failure
    // payload that drops it reads as the hardcoded-ok regression it replaced.
    for (const key of ['ok', 'checked_at', 'checks', 'failing', 'warnings', 'not_verified',
      'hive', 'label', 'present', 'ts', 'probe_error', 'probe_duration_ms',
      'probe_deadline_ms', 'probe_deadline_requested_ms', 'probe_deadline_clamped']) {
      assert.ok(key in ok, `success payload lost ${key}`);
      assert.ok(key in failed, `failure payload lost ${key}`);
    }
    assert.equal(ok.checked_at, 12345, "the probe's own evidence timestamp must not be overwritten");
    assert.equal(ok.probe_error, null);
    assert.equal(failed.probe_error.reason, 'exit-nonzero');
    assert.deepEqual(failed.checks, []);
    assert.deepEqual(failed.failing, [PROBE_CHECK_NAME]);
    assert.deepEqual(failed.not_verified, [PROBE_CHECK_NAME]);
    assert.equal(ok.ok, true);
    assert.equal(failed.ok, false);
  } finally {
    await shutdown(target);
  }
});

test('the config is read per request, not at require time', async () => {
  // Both earlier branches captured HEALTH_PROBE_* when index.js was imported, which
  // silently applied one test's deadline to the next test's probe.
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(slowThenHealthy(3));
    process.env.HEALTH_PROBE_TIMEOUT_MS = '300';
    const slow = await target.http.get('/api/health');
    assert.equal(slow.json.probe_error.reason, 'timeout');
    assert.equal(slow.json.probe_deadline_ms, 300);

    process.env.HEALTH_PROBE_ARGV = JSON.stringify(sh('exit 4'));
    delete process.env.HEALTH_PROBE_TIMEOUT_MS;
    const after = await target.http.get('/api/health');
    assert.equal(after.json.probe_error.reason, 'exit-nonzero');
    assert.equal(after.json.probe_deadline_ms, DEFAULT_DEADLINE_MS);
  } finally {
    await shutdown(target);
  }
});

test('a slow probe delays only its own route; peers and the loop keep moving', async () => {
  const target = await boot();
  const ticks = [];
  let ticker = null;
  try {
    // Baseline first, because /api/services/health fans out over the live port table:
    // measured 0-170ms with no loopback forward listening, and seconds more while a dead
    // SSH forward still accepts the connection and never answers. That cost belongs to
    // this host and not to the health probe, so an absolute bound on it fails on a busy
    // laptop while measuring nothing about the fix. Comparing the peer with its own
    // baseline makes the assertion mean "the probe did not park the loop". Both numbers
    // are taken warm, so the comparison is apples to apples; no probe is configured yet.
    await fetch(`${target.http.base}/api/services/health`);
    const baselineStartedAt = Date.now();
    await fetch(`${target.http.base}/api/services/health`);
    const baselineServicesMs = Date.now() - baselineStartedAt;

    process.env.HEALTH_PROBE_ARGV = JSON.stringify(slowThenHealthy(1.2));
    const armedAt = Date.now();
    ticker = setInterval(() => ticks.push(Date.now()), 25);
    const healthInFlight = target.http.get('/api/health');

    // A blocked loop delays this timer, so its lateness is itself the measurement --
    // and the peer's clock starts before its request, not after the wait (the positive
    // control shows why: a stall pushes the wait, and the peer then looks fast).
    const waitedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const waitLateness = Date.now() - waitedAt - 120;

    const agentsStartedAt = Date.now();
    const agentsPromise = fetch(`${target.http.base}/api/agents`);
    const servicesStartedAt = Date.now();
    const servicesPromise = fetch(`${target.http.base}/api/services/health`);
    // Each peer's own wait is what is being timed. Awaiting health first would make the
    // number measure the probe instead of the peer, and the peer would look slow even
    // with a completely free event loop.
    const agents = await agentsPromise;
    const agentsMs = Date.now() - agentsStartedAt;
    const services = await servicesPromise;
    const servicesMs = Date.now() - servicesStartedAt;
    const health = await healthInFlight;

    assert.equal(health.json.ok, true, 'a probe that finishes inside its budget still lands');
    assert.ok(agentsMs < 700, `/api/agents took ${agentsMs}ms behind a 1.2s probe`);
    // The 1500ms floor stays, so an unambiguously parked loop still fails here even when
    // the host is idle; the ratio is what stops a slow port table from reading as a stall.
    const servicesBoundMs = Math.max(1500, baselineServicesMs * 2 + 500);
    assert.ok(servicesMs < servicesBoundMs,
      `/api/services/health took ${servicesMs}ms behind a 1.2s probe `
      + `(own baseline ${baselineServicesMs}ms, bound ${servicesBoundMs}ms)`);
    assert.ok(waitLateness < 200, `the event loop lagged a plain timer by ${waitLateness}ms`);
    assert.ok(ticks.length > 20, `event loop only ticked ${ticks.length} times`);
    const firstTickLateness = ticks[0] - armedAt - 25;
    assert.ok(firstTickLateness < 200, `first ticker fired ${firstTickLateness}ms late`);
    const worstGap = Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]));
    assert.ok(worstGap < 250, `event loop stalled for ${worstGap}ms`);
    assert.equal(agents.status, 200);
    assert.equal(services.status, 200);
  } finally {
    if (ticker) clearInterval(ticker);
    await shutdown(target);
  }
});

test('four concurrent health requests buy one probe child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-probe-route-spawns-'));
  const markerFile = path.join(dir, 'spawned.txt');
  const target = await boot();
  try {
    process.env.HEALTH_PROBE_ARGV = JSON.stringify(sh(
      `printf x >> ${JSON.stringify(markerFile)}; sleep 0.4; ${PRINT_HEALTHY}`,
    ));
    const results = await Promise.all([1, 2, 3, 4].map(() => target.http.get('/api/health')));
    for (const res of results) assert.equal(res.json.ok, true);
    assert.equal(fs.readFileSync(markerFile, 'utf8').length, 1, 'four requests, more than one probe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await shutdown(target);
  }
});

test('the health route holds no synchronous child call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = source.indexOf("app.get('/api/health'");
  assert.notEqual(start, -1, 'the /api/health wiring must exist -- routeIntent.test.js finds routes by this literal');
  const handler = source.slice(start, source.indexOf('\n});', start));
  assert.match(handler, /async \(_req, res\) =>/, 'handler must be async');
  assert.doesNotMatch(handler, /execFileSync|spawnSync|execSync/, 'handler must not block the loop');
});

test('failedProbePayload keeps hiveStatus() authoritative', () => {
  const payload = failedProbePayload({
    error: { reason: 'timeout', detail: 'killed at 2000ms' },
    durationMs: 2001, deadlineMs: 2000, requestedDeadlineMs: 2000, deadlineClamped: false,
  }, { hive: '/tmp/hive', label: 'Fleet hive', present: false });
  assert.equal(payload.hive, '/tmp/hive');
  assert.equal(payload.present, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.probe_deadline_clamped, false);
  // A probe field must never override hive presence: the probe answers about the fleet,
  // hiveStatus() answers about the hive, and only the second is this route's name.
  const hostile = failedProbePayload(
    { error: { reason: 'timeout', detail: 'x' }, durationMs: 1, deadlineMs: 2000 },
    { hive: 'real', present: true },
  );
  assert.equal(hostile.hive, 'real');
});
