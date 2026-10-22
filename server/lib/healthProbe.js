'use strict';
// Bounded, asynchronous runner for health_probe.py.
//
// Why this exists: /api/health used execFileSync, so the whole Node process parked
// until the child finished. The probe fans out over pgrep/ps and cross-host state
// files, and its own children carry 5s/10s/20s budgets, so identical code was
// measured at 0.04s and at 5.2s on the deployed HUD (2026-10-11, five polls:
// 0.13/0.13/0.15/0.18/5.21s route TTFB). A route that exists to notice an outage was
// causing one, and every other HUD route paid for it.
//
// Contract: the caller always gets an answer inside the budget, and a probe that cannot
// answer degrades to a payload carrying the success branch's key set. `checks` is never
// absent -- truth_guard.py reads its absence as the hardcoded-ok regression, so an
// honest failure has to stay distinguishable from a route that vanished.

const path = require('path');
const { spawn } = require('child_process');

// The budget comes from the callers, not from taste. Shortest one that reads this
// route: control-center/upstream.py:48 `probe(timeout=3.0)`. Behind it:
// scripts/check_hud_route_honesty.py --timeout 4.0, office-hud/hud_guard.py:290 (8s),
// services/oa_watchdog.py:170 (8s), office-hud/server/truth_guard.py:38 (40s).
const MIN_CALLER_BUDGET_MS = 3000;

// What the caller spends besides the probe itself. Measured route overhead is ~110ms
// (production p50 TTFB 149ms minus probe p50 40ms); the rest covers SIGKILL plus reap,
// one SSH-forward round trip for the cross-host monitors, and the python caller's own
// read and parse. Rounded up to a full second.
const CALLER_RESERVE_MS = 1000;
const MAX_DEADLINE_MS = MIN_CALLER_BUDGET_MS - CALLER_RESERVE_MS;
const MIN_DEADLINE_MS = 100;
// The largest budget that provably fits inside the shortest caller, and the default.
// HEALTH_PROBE_TIMEOUT_MS may therefore only ever *lower* it: a host whose probe
// legitimately needs more than this needs the callers widened in the same change, not
// a server-side budget that silently outruns them.
const DEFAULT_DEADLINE_MS = MAX_DEADLINE_MS;

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PROBE_CHECK_NAME = 'health_probe';
const PROBE_PYTHON = '/usr/bin/python3';
const PROBE_SCRIPT = path.join(__dirname, '..', 'health_probe.py');

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Turn a requested budget into one that cannot break the caller contract. A
 * misconfigured HEALTH_PROBE_TIMEOUT_MS must not silently restore the stall, and the
 * clamp must not be invisible either, so the applied value travels with the result.
 */
function clampDeadlineMs(raw) {
  const requested = positiveInt(raw, DEFAULT_DEADLINE_MS);
  if (requested > MAX_DEADLINE_MS) return { deadlineMs: MAX_DEADLINE_MS, requestedMs: requested, clamped: true };
  if (requested < MIN_DEADLINE_MS) return { deadlineMs: MIN_DEADLINE_MS, requestedMs: requested, clamped: true };
  return { deadlineMs: requested, requestedMs: requested, clamped: false };
}

/**
 * The probe command. Production runs exactly one, compiled in: an environment variable
 * must not be able to point a HUD route at another program. The override exists for
 * tests and local debugging, and it switches itself off under NODE_ENV=production --
 * which the installed com.aryan.office-hud-server.plist sets, so the deployed server
 * has no seam at all. A malformed override falls back to the real probe rather than
 * taking health down with it.
 */
function resolveArgv(env) {
  if (env.NODE_ENV === 'production') return [PROBE_PYTHON, PROBE_SCRIPT];
  const raw = env.HEALTH_PROBE_ARGV;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const usable = Array.isArray(parsed) && parsed.length > 0
        && parsed.every((part) => typeof part === 'string' && part.length > 0);
      if (usable) return parsed;
    } catch (_) {
      /* fall through: a bad override must not break health */
    }
  }
  const script = env.HEALTH_PROBE_SCRIPT || PROBE_SCRIPT;
  return [env.HEALTH_PROBE_BIN || PROBE_PYTHON, script];
}

/**
 * How the probe came back, decided before its content. Every failure mode gets its own
 * reason, because "the fleet is unhealthy" and "we could not find out" are different
 * alarms; unknown is folded into neither.
 */
function classify(error, deadlineMs, argv) {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { reason: 'output-too-large', detail: `probe output exceeded ${MAX_BUFFER_BYTES} bytes` };
  }
  if (error.code === 'ENOENT') {
    return { reason: 'spawn-failed', detail: `${argv[0]} is not executable` };
  }
  if (error.killed || error.signal) {
    return { reason: 'timeout', detail: `killed at ${deadlineMs}ms` };
  }
  if (Number.isInteger(error.code)) {
    return { reason: 'exit-nonzero', detail: `exit code ${error.code}` };
  }
  return { reason: 'probe-error', detail: String(error.message || error) };
}

function parseBuffer(buffer) {
  const text = buffer.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: { reason: 'unparseable-output', detail: String(error.message || error) } };
  }
  // An array or a scalar parses fine and then spreads into a payload with no `ok` and
  // no `checks` at all -- which is the shape truth_guard.py calls the hardcoded-ok
  // regression. Only an object may stand in for the probe.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: { reason: 'not-an-object', detail: 'probe output was valid JSON but not an object' } };
  }
  // The array/scalar case above is not the only way to lose the verdict. An object that
  // simply omits `ok` and `checks` -- `{}`, or a partial write from a probe that died mid
  // report -- spreads into a payload with no verdict key at all, and truth_guard.py:65
  // fails any body without `checks`, so the caller would read a hole as an outage of its
  // own making. A probe answer has to be a probe answer.
  if (typeof parsed.ok !== 'boolean' || !Array.isArray(parsed.checks)) {
    return {
      error: {
        reason: 'incomplete-payload',
        detail: 'probe output was a JSON object without a boolean ok or an checks array',
      },
    };
  }
  return { data: parsed };
}

/**
 * Run one probe. Resolves; never rejects, and never answers later than its deadline
 * plus the cost of killing the child.
 *
 * spawn, not execFile: execFile's callback waits for the stdio streams to close, so a
 * grandchild that inherits the pipe -- an `ssh` outliving the python that forked it --
 * holds the response open past any timeout it is given. Accumulating the buffer here
 * makes the deadline the only thing the answer depends on.
 *
 * @returns {Promise<{ok: boolean, data?: object, error?: object, exitCode?: number|null,
 *   durationMs: number, deadlineMs: number, requestedDeadlineMs: number, deadlineClamped: boolean}>}
 */
function runHealthProbe(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || resolveArgv(env);
  const budget = clampDeadlineMs(opts.timeoutMs ?? opts.deadlineMs ?? env.HEALTH_PROBE_TIMEOUT_MS);
  const maxBuffer = positiveInt(opts.maxBuffer, MAX_BUFFER_BYTES);
  const startedAt = Date.now();
  const stampOf = (result) => ({
    ...result,
    durationMs: Date.now() - startedAt,
    deadlineMs: budget.deadlineMs,
    requestedDeadlineMs: budget.requestedMs,
    deadlineClamped: budget.clamped,
  });

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let deadlineReached = false;
    let spawnError = null;
    let exited = null;
    let closed = false;
    let truncated = false;
    const chunks = [];
    let bufferedBytes = 0;

    // The probe is its own process group. Killing only the leader leaves its children
    // holding the pipe, which is how "bounded" turns back into "however long the
    // slowest ssh takes". Best effort on purpose: a group whose leader has already been
    // reaped cannot be signalled, and the answer is guaranteed by the deadline anyway.
    const reap = () => {
      if (!child || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch (_) { /* child already gone */ }
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reap();
      resolve(stampOf(result));
    };

    const evaluate = () => {
      if (settled) return;
      if (spawnError) return settle({ ok: false, error: classify(spawnError, budget.deadlineMs, argv) });
      if (truncated) {
        return settle({
          ok: false,
          error: { reason: 'output-too-large', detail: `probe output exceeded ${maxBuffer} bytes` },
        });
      }
      if (deadlineReached) {
        // A child that answered before it was reaped has answered. Calling that a
        // timeout would invent an outage the probe did not have, so the buffer gets one
        // honest parse even while a grandchild still holds the pipe.
        if (exited && exited.code === 0) {
          const answer = parseBuffer(Buffer.concat(chunks));
          if (answer.data) return settle({ ok: true, data: answer.data });
        }
        // A probe that died for its own reasons before the deadline is not a timeout;
        // reporting it as one would send the alarm to the wrong place.
        if (exited && exited.code !== null && exited.code !== 0) {
          return settle({
            ok: false,
            error: { reason: 'exit-nonzero', detail: `exit code ${exited.code}` },
            exitCode: exited.code,
          });
        }
        return settle({
          ok: false,
          error: { reason: 'timeout', detail: `killed at ${budget.deadlineMs}ms` },
          exitCode: exited ? exited.code : null,
        });
      }
      if (!(exited && closed)) return;
      if (exited.code !== 0) {
        const signaled = exited.code === null;
        return settle({
          ok: false,
          error: signaled
            ? { reason: 'probe-error', detail: `killed by signal ${exited.signal}` }
            : { reason: 'exit-nonzero', detail: `exit code ${exited.code}` },
          exitCode: signaled ? null : exited.code,
        });
      }
      const answer = parseBuffer(Buffer.concat(chunks));
      return answer.data ? settle({ ok: true, data: answer.data }) : settle({ ok: false, error: answer.error });
    };

    const timer = setTimeout(() => {
      deadlineReached = true;
      reap();
      evaluate();
    }, budget.deadlineMs);

    child = spawn(argv[0], argv.slice(1), {
      detached: true,
      env: opts.childEnv || env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (opts.onChild) opts.onChild(child);

    child.stdout.on('data', (chunk) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > maxBuffer) {
        truncated = true;
        reap();
        evaluate();
        return;
      }
      chunks.push(chunk);
      evaluate();
    });
    child.stderr.resume();
    child.on('error', (error) => { spawnError = error; evaluate(); });
    child.on('exit', (code, signal) => { exited = { code, signal }; evaluate(); });
    child.on('close', () => { closed = true; evaluate(); });
    evaluate();
  });
}

/**
 * Collapse parallel callers onto one child, keyed by the resolved command and budget:
 * the HUD polls while UIs fan out, and one half-alive host should not buy N probes.
 * In-flight only, never a stored answer -- the next poll starts a fresh probe, so a
 * degraded answer cannot be echoed to a caller that arrives after the fleet recovered.
 * The key is what stops a caller being handed someone else's configuration.
 */
function createSingleFlight(run) {
  const inflight = new Map();
  return function once(key) {
    const flightKey = key || '';
    const existing = inflight.get(flightKey);
    if (existing) return existing;
    const started = Promise.resolve().then(run);
    const clear = () => {
      if (inflight.get(flightKey) === started) inflight.delete(flightKey);
    };
    started.then(clear, clear);
    inflight.set(flightKey, started);
    return started;
  };
}

/**
 * The payload a caller sees when the probe could not answer. Shaped deliberately like a
 * completed probe -- `checks`, `failing`, `warnings`, `not_verified`, `ts` all present
 * -- because a failure that deletes keys is indistinguishable from a route that stopped
 * existing, which is how this class of bug gets mistaken for an outage. An unfinished
 * probe carries no per-check evidence, so `checks` stays empty and the probe itself is
 * named in both `failing` (it did not complete) and `not_verified` (nothing was seen).
 */
function failedProbePayload(probe, status) {
  const now = Date.now();
  return {
    ok: false,
    checked_at: now,
    checks: [],
    failing: [PROBE_CHECK_NAME],
    warnings: [],
    not_verified: [PROBE_CHECK_NAME],
    ...status,
    ts: now,
    probe_error: probe.error || { reason: 'probe-error', detail: 'probe failed without a reason' },
    probe_duration_ms: probe.durationMs,
    probe_deadline_ms: probe.deadlineMs,
    probe_deadline_requested_ms: probe.requestedDeadlineMs,
    probe_deadline_clamped: probe.deadlineClamped === true,
  };
}

/** The same key set on a success, so probe_error says "answered" instead of vanishing. */
function probePayload(probe, data, status) {
  return {
    // First, so the probe's own evidence timestamp wins and a probe that omits it still
    // cannot make the two branches differ in shape.
    checked_at: Date.now(),
    ...data,
    ...status,
    ts: Date.now(),
    probe_error: null,
    probe_duration_ms: probe.durationMs,
    probe_deadline_ms: probe.deadlineMs,
    probe_deadline_requested_ms: probe.requestedDeadlineMs,
    probe_deadline_clamped: probe.deadlineClamped === true,
  };
}

module.exports = {
  runHealthProbe,
  createSingleFlight,
  resolveArgv,
  clampDeadlineMs,
  failedProbePayload,
  probePayload,
  classify,
  PROBE_CHECK_NAME,
  PROBE_PYTHON,
  PROBE_SCRIPT,
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  MAX_BUFFER_BYTES,
  MIN_CALLER_BUDGET_MS,
  CALLER_RESERVE_MS,
};
