// This patch adds remote polymarket status fetching for when HUD runs on laptop
// but polymarket engine runs on mini.
//
// Execution is asynchronous and bounded. It used to be execFileSync, so a panel poll
// parked the whole Node event loop -- and the fan-out is several ssh calls deep, so with
// the mini off-tailnet one GET /api/polymarket/status could freeze every other HUD route
// for the sum of their timeouts. A request path never waits on ssh now: it reads the last
// completed observation and says how old it is. Where an answer is *required* to be
// current -- the start/stop gates -- the caller asks for a fresh observation explicitly
// and is refused when it cannot be established inside the gate budget.

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MINI_HOST = 'macmini'; // SSH config alias
const MINI_POLYMARKET_ROOT = '/Users/a/polymarket';
const MINI_POLYMARKET_RESEARCH = '/Users/a/polymarket/research';
const MINI_POLYMARKET_STATE_PATH = '/Users/a/polymarket/research/engine_state.json';
const MINI_POLYMARKET_GATE_PATH = '/Users/a/polymarket/research/profitability_gate.json';
const MINI_POLYMARKET_AUDIT_PATH = '/Users/a/polymarket/research/signal_audit.jsonl';
const MINI_POLYMARKET_EXCLUSIONS_PATH = '/Users/a/polymarket/research/market_exclusions.json';
const MINI_POLYMARKET_CONFIG_PATH = '/Users/a/trading/openalice-fleet/hive/polymarket_config.json';
const MINI_POLYMARKET_LAUNCHD_LABEL = 'com.aryan.pm-engine';
const MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST = '/Users/a/Library/LaunchAgents/com.aryan.pm-engine.plist';
const MINI_POLYMARKET_LAUNCHD_TARGET = 'gui/501/com.aryan.pm-engine'; // uid 501 on mini
const MINI_POLYMARKET_ENGINE_PATTERN = 'profitability_engine_fixed.py';

// Unchanged from the synchronous version on purpose: how long ssh itself may take to
// reach the host is an operator-visible property of the link, not something this rewrite
// gets to tighten as a side effect.
const SSH_CONNECT_TIMEOUT_S = 10;
const DEFAULT_SSH_DEADLINE_MS = 12000;
const MAX_SSH_DEADLINE_MS = 15000;
const MIN_SSH_DEADLINE_MS = 100;
const MAX_SSH_OUTPUT_BYTES = 10 * 1024 * 1024;
// One refresh issues up to four independent remote commands, so the cap has to be at least
// that wide or a single honest refresh could never complete. Six still bounds the worst
// case -- three panels refreshing at once used to launch nine ssh processes against a host
// that was not answering, and would have launched more with more surfaces.
const MAX_CONCURRENT_SSH = 6;
// Chosen from the panels' own cadence (RESOURCES minIntervalMs: polymarket 15s,
// polymarketStatus 30s, polymarketMarkets 30s) so a poll never waits on a refresh that
// only just ran, and a refresh never runs more than once per interval.
const REFRESH_INTERVAL_MS = { runtime: 30000, state: 15000, markets: 30000 };
// The start/stop gates decide whether launchctl may be called, so they may not act on a
// possibly-stale observation: they demand a fresh one and are refused if it is late.
const ACTION_GATE_DEADLINE_MS = 8000;
// ssh's own status for "could not reach/run the remote command", distinct from the status
// the remote command returned.
const SSH_TRANSPORT_EXIT = 255;
// pgrep exits 1 when nothing matched. That is an answer, not a failure, and treating it
// as one would report a stopped engine as an unreachable mini.
const PGREP_NO_MATCH_EXIT = 1;

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

function sshDeadlineMs(raw) {
  const requested = positiveInt(raw, DEFAULT_SSH_DEADLINE_MS);
  if (requested > MAX_SSH_DEADLINE_MS) return MAX_SSH_DEADLINE_MS;
  if (requested < MIN_SSH_DEADLINE_MS) return MIN_SSH_DEADLINE_MS;
  return requested;
}

/**
 * The ssh command line. Production runs exactly one, compiled in: no environment
 * variable may point a HUD code path at another executable. The override is a test and
 * local-debug seam, switched off under NODE_ENV=production the same way the health
 * probe's is.
 */
function sshArgv(env, cmd, args) {
  const bin = env.NODE_ENV === 'production' ? 'ssh' : (env.POLYMARKET_SSH_BIN || 'ssh');
  return [bin, ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`, MINI_HOST, cmd, ...args]];
}

let laptopAnswer;
function isLaptop() {
  // Memoised: this is a property of the machine, and it used to run a synchronous
  // `scutil` child on every panel poll.
  if (laptopAnswer !== undefined) return laptopAnswer;
  const override = process.env.NODE_ENV === 'production' ? undefined : process.env.OFFICE_HUD_LOCAL_HOST;
  const localHost = String(override || os.hostname()).toLowerCase();
  laptopAnswer = localHost.includes('macbook') || localHost.includes('aryans-macbook');
  return laptopAnswer;
}

const slots = { active: 0, peak: 0, refused: 0 };

/** Exposed so a test can prove the cap holds instead of trusting the constant. */
const sshPoolState = () => ({ active: slots.active, refused: slots.refused, peak: slots.peak });

/**
 * Take a slot, or refuse immediately. There is deliberately no queue: a queued call only
 * starts its deadline timer once it is granted, so one call whose child never settles would
 * park every caller behind it indefinitely -- unbounded pipes, a process that never exits.
 * Saturation is transient and self-healing here, because each getter refreshes at most once
 * per interval and a refused read is retried on the next poll.
 */
function acquireSlot() {
  if (slots.active >= MAX_CONCURRENT_SSH) {
    slots.refused += 1;
    return null;
  }
  slots.active += 1;
  slots.peak = Math.max(slots.peak, slots.active);
  return releaseSlot;
}

function releaseSlot() {
  slots.active -= 1;
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
}

/**
 * One bounded remote command. Resolves, never rejects, and always answers inside its
 * deadline plus the cost of killing ssh -- including the case where ssh is dead but a
 * grandchild still holds the pipe, which is why this uses spawn and its own timer rather
 * than execFile's `timeout` option.
 *
 * @returns {Promise<{ok: boolean, stdout: string, reason: string|null, detail: string|null,
 *   exitCode: number|null, deadlineMs: number, durationMs: number}>}
 */
function runOnMini(cmd, args, options = {}) {
  const env = options.env || process.env;
  const deadlineMs = sshDeadlineMs(options.timeoutMs ?? env.POLYMARKET_SSH_TIMEOUT_MS);
  const maxBuffer = positiveInt(options.maxBuffer, MAX_SSH_OUTPUT_BYTES);
  const [bin, argv] = sshArgv(env, cmd, args);
  const startedAt = Date.now();

  const stamp = (result) => ({
    stdout: '', reason: null, detail: null, exitCode: null, ...result,
    deadlineMs, durationMs: Date.now() - startedAt,
  });
  const release = acquireSlot();
  if (!release) {
    return Promise.resolve(stamp({
      ok: false,
      reason: 'saturated',
      detail: `${MAX_CONCURRENT_SSH} remote commands are already running`,
    }));
  }

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let exited = null;
    let closed = false;
    let stderrText = '';
    let truncated = false;
    const chunks = [];
    let bytes = 0;

    const reap = () => {
      if (!child || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch (_) { /* child already gone */ }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reap();
      // Deliberately no stream.destroy() here. An earlier draft destroyed the two stdio
      // pipes on the way out, and that is what *created* permanently registered PipeWrap
      // resources; the process-group kill above plus letting the pipes close themselves is
      // what the fd test measures.
      release();
      resolve(stamp(result));
    };

    const decide = () => {
      if (settled) return;
      if (spawnError) {
        const reason = spawnError.code === 'ENOENT' ? 'ssh-missing' : 'ssh-error';
        return finish({ ok: false, stdout: '', reason, detail: String(spawnError.message || spawnError), exitCode: null });
      }
      if (truncated) {
        return finish({ ok: false, stdout: '', reason: 'output-too-large', detail: `remote output exceeded ${maxBuffer} bytes`, exitCode: null });
      }
      if (timedOut) {
        return finish({ ok: false, stdout: '', reason: 'timeout', detail: `no answer within ${deadlineMs}ms`, exitCode: null });
      }
      if (!(exited && closed)) return;
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (exited.code === 0) return finish({ ok: true, stdout, reason: null, detail: null, exitCode: 0 });
      // A non-zero status from the remote command is ssh reporting an answer, so it is
      // not an outage. pgrep's "nothing matched" is the common case.
      if (exited.code === SSH_TRANSPORT_EXIT) {
        return finish({ ok: false, stdout, reason: 'ssh-unreachable', detail: firstLine(stderrText) || `ssh exited ${SSH_TRANSPORT_EXIT}`, exitCode: exited.code });
      }
      if (exited.code === null) {
        return finish({ ok: false, stdout, reason: 'ssh-error', detail: `ssh killed by ${exited.signal}`, exitCode: null });
      }
      return finish({ ok: false, stdout, reason: 'remote-exit', detail: `${cmd} exited ${exited.code}`, exitCode: exited.code });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      reap();
      decide();
    }, deadlineMs);

    child = spawn(bin, argv, { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (options.onChild) options.onChild(child);

    child.stdout.on('error', () => { /* a destroyed pipe is not a failed observation */ });
    child.stderr.on('error', () => { /* likewise */ });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { truncated = true; reap(); decide(); return; }
      chunks.push(chunk);
      decide();
    });
    child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
    child.on('error', (error) => { spawnError = error; decide(); });
    child.on('exit', (code, signal) => { exited = { code, signal }; decide(); });
    child.on('close', () => { closed = true; decide(); });
  });
}

/** True when pgrep found no process -- an observation, not a failure. */
function isNoMatch(result, cmd) {
  return cmd === 'pgrep' && !result.ok && result.reason === 'remote-exit'
    && result.exitCode === PGREP_NO_MATCH_EXIT && !String(result.stdout).trim();
}

const UNAVAILABLE = 'unavailable';

function unavailableRuntime(reason, detail) {
  // Same fail-closed shape the synchronous version produced when every ssh call threw:
  // nothing is claimed healthy, and the start/stop gates refuse to act.
  return {
    checked_at: new Date().toISOString(),
    engine_path: path.join(MINI_POLYMARKET_RESEARCH, 'profitability_engine_fixed.py'),
    expected_engine_path: path.join(MINI_POLYMARKET_RESEARCH, 'profitability_engine_fixed.py'),
    expected_plist_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    paper_only: false,
    managed: false,
    running: false,
    pid: null,
    process: { pids: [], commands: [] },
    launchd: {
      loaded: false, state: UNAVAILABLE, pid: null, path: null, error: detail || reason,
      expected_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST, expected_loaded: false,
    },
    config: { present: false, path: MINI_POLYMARKET_CONFIG_PATH, error: detail || reason },
    plist: { valid: false, error: detail || reason, path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST },
    execution_allowed: false,
  };
}

/**
 * The three reads that live beside engine_state.json in their own files. Each returns null
 * when the host never saw that file, which is a different claim from "it is empty" -- so the
 * fail-closed payloads keep them optional rather than inventing zeros.
 */
function summariseGate(gateRead) {
  if (!gateRead || !gateRead.ok) return null;
  let gate = null;
  try { gate = JSON.parse(gateRead.stdout); } catch (_) { return null; }
  if (!gate) return null;
  return { status: gate.gate_status, priced_exits: gate.priced_exits, requirements_met: gate.requirements_met };
}

const EMPTY_AUDIT = { total: 0, allowed: 0, rejected: 0, reject_reasons: {} };

function summariseAudit(auditRead) {
  if (!auditRead || !auditRead.ok) return null;
  const audit = [];
  for (const line of String(auditRead.stdout).trim().split('\n')) {
    if (!line.trim()) continue;
    try { audit.push(JSON.parse(line)); } catch (_) { /* one malformed line is not an outage */ }
  }
  const allowed = audit.filter((item) => item.decision === 'allow').length;
  const rejectReasons = {};
  for (const item of audit) {
    if (item.decision !== 'reject') continue;
    const reason = String(item.reason || 'unknown').split('(')[0];
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
  }
  return { total: audit.length, allowed, rejected: audit.length - allowed, reject_reasons: rejectReasons };
}

function summariseExclusions(exclusionsRead) {
  if (!exclusionsRead) return { present: false, valid: false, exclusions: [], error: 'not read' };
  if (exclusionsRead.ok) {
    let data = null;
    try { data = JSON.parse(exclusionsRead.stdout); } catch (error) {
      return { present: false, valid: false, exclusions: [], error: error.message };
    }
    if (data && Array.isArray(data.exclusions)) {
      return { present: true, valid: true, exclusions: data.exclusions, error: null };
    }
    return { present: false, valid: false, exclusions: [], error: 'no exclusions array' };
  }
  // A missing exclusions file is the documented empty case, not a failure. Only a transport
  // problem is reported as one.
  if (exclusionsRead.reason === 'remote-exit') return { present: false, valid: true, exclusions: [], error: null };
  return { present: false, valid: false, exclusions: [], error: exclusionsRead.detail || exclusionsRead.reason };
}

function unavailableState(reason, detail, seen) {
  const obs = seen || {};
  return {
    present: false, mode: UNAVAILABLE, trades: 0, net_pnl: null, realized_edge: null,
    updated_at: null,
    // gate and audit are separate files with separate reads. When they answered and only the
    // state file did not, zeroing them would report an outage that did not happen.
    gate: obs.gate === undefined ? null : obs.gate,
    audit: obs.audit || EMPTY_AUDIT,
  };
}

function unavailableMarkets(reason, detail, seen) {
  const obs = seen || {};
  const exclusions = obs.exclusions || { present: false, valid: false, exclusions: [], error: null };
  return {
    present: false, state_path: MINI_POLYMARKET_STATE_PATH, updated_at: null,
    summary: { trades: 0, signals: 0, orders: 0, fills: 0, open_positions: 0, closed_positions: 0, markets: 0 },
    markets: [],
    exclusions: {
      path: MINI_POLYMARKET_EXCLUSIONS_PATH,
      present: exclusions.present,
      valid: exclusions.valid,
      count: exclusions.valid ? (exclusions.exclusions || []).length : null,
      items: exclusions.exclusions || [],
      error: exclusions.present ? null : (exclusions.error || detail || reason),
    },
  };
}

/** The plist/config/paper-only evidence, identical logic to the synchronous version. */
function evaluateRuntimeEvidence({ launchdText, plistText, configText, pids, commands, failures }) {
  const launchdState = parseLaunchd(launchdText);
  let plist = null;
  let plistError = null;
  if (plistText === null) plistError = failures.plist || UNAVAILABLE;
  else {
    try { plist = JSON.parse(plistText); } catch (error) { plistError = error.message; }
  }
  const enginePath = path.join(MINI_POLYMARKET_RESEARCH, 'profitability_engine_fixed.py');
  const argumentsList = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [];
  const hasPaperArgument = argumentsList.includes('--paper');
  const hasUnsafeArgument = argumentsList.some((arg) => /--(live|real|mainnet|testnet)(?:=|$)/i.test(String(arg)));
  const plistValid = !!plist
    && plist.Label === MINI_POLYMARKET_LAUNCHD_LABEL
    && argumentsList.length >= 2
    && argumentsList.every((arg) => typeof arg === 'string')
    && argumentsList[1] === enginePath
    && argumentsList.includes('--paper')
    && plist.WorkingDirectory === MINI_POLYMARKET_ROOT;

  let configPaperOnly = true;
  let configError = null;
  if (configText === null) configError = failures.config || UNAVAILABLE;
  else {
    try {
      const config = JSON.parse(configText);
      configPaperOnly = !Object.prototype.hasOwnProperty.call(config, 'paper_only') || config.paper_only === true;
    } catch (error) { configError = error.message; }
  }

  const paperOnly = plistValid && !configError && configPaperOnly && hasPaperArgument && !hasUnsafeArgument;
  const expectedPlistLoaded = launchdState.loaded && launchdState.path === MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST;
  const processes = pids.map((pid, index) => ({ pid, command: commands[index] || '' })).filter((p) => p.command);

  return {
    checked_at: new Date().toISOString(),
    engine_path: enginePath,
    expected_engine_path: enginePath,
    expected_plist_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    paper_only: paperOnly,
    managed: plistValid && !configError,
    running: processes.length > 0,
    pid: processes[0]?.pid || null,
    process: { pids: processes.map((p) => p.pid), commands: processes.map((p) => p.command) },
    launchd: { ...launchdState, expected_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST, expected_loaded: expectedPlistLoaded },
    config: { present: !configError, path: MINI_POLYMARKET_CONFIG_PATH, error: configError },
    plist: { valid: plistValid, error: plistError, path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST },
    execution_allowed: plistValid && !configError && paperOnly && expectedPlistLoaded,
  };
}

function parseLaunchd(text) {
  if (text === null) return { loaded: false, state: UNAVAILABLE, pid: null, path: null, error: UNAVAILABLE };
  const state = text.match(/\n\s*state = ([^\s]+)/)?.[1] || 'unknown';
  const pid = text.match(/\n\s*pid = (\d+)/)?.[1] || null;
  const installedPath = text.match(/\n\s*path = ([^\n]+)/)?.[1]?.trim() || null;
  return { loaded: true, state, pid: pid ? Number(pid) : null, path: installedPath, error: null };
}

/**
 * One refresh of the runtime evidence. The four independent reads run together instead of
 * one after another, so the cost of a dead host is one deadline rather than the sum of
 * five -- which is the difference between a slow panel and a frozen dashboard.
 */
async function buildRuntimeRemote() {
  const [launchd, plistRead, configRead, pgrep] = await Promise.all([
    runOnMini('launchctl', ['print', MINI_POLYMARKET_LAUNCHD_TARGET]),
    runOnMini('plutil', ['-convert', 'json', '-o', '-', MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST]),
    runOnMini('cat', [MINI_POLYMARKET_CONFIG_PATH]),
    runOnMini('pgrep', ['-f', MINI_POLYMARKET_ENGINE_PATTERN]),
  ]);

  const failures = {
    plist: plistRead.ok ? null : (plistRead.detail || plistRead.reason),
    config: configRead.ok ? null : (configRead.detail || configRead.reason),
  };

  if (launchd.ok === false && launchd.reason !== 'remote-exit') {
    // A transport failure tells us nothing about the engine, so nothing may be claimed
    // about it: return the fail-closed payload and name why.
    return { ok: false, reason: launchd.reason, detail: launchd.detail, payload: unavailableRuntime(launchd.reason, launchd.detail) };
  }

  const matched = String(pgrep.stdout || '').trim();
  const pids = (pgrep.ok || isNoMatch(pgrep, 'pgrep')) && matched
    ? matched.split('\n').map((p) => parseInt(p.trim(), 10)).filter((p) => !Number.isNaN(p)).slice(0, 8)
    : [];
  const psResults = await Promise.all(pids.map((pid) => runOnMini('ps', ['-p', String(pid), '-o', 'command='])));
  const commands = psResults.map((result) => (result.ok ? result.stdout.trim() : ''));

  return {
    ok: true,
    reason: null,
    detail: null,
    payload: evaluateRuntimeEvidence({
      launchdText: launchd.ok ? launchd.stdout : null,
      plistText: plistRead.ok ? plistRead.stdout : null,
      configText: configRead.ok ? configRead.stdout : null,
      pids,
      commands,
      failures,
    }),
  };
}

async function buildStateRemote() {
  const oversize = await oversizeStateRead();
  if (oversize) {
    // Only the state file is unavailable here. The gate and the audit log are different files
    // and they answer, so two more bounded reads keep the panel from claiming it saw nothing
    // when it actually saw three of the four things it looks at.
    const [gateRead, auditRead] = await Promise.all([
      runOnMini('cat', [MINI_POLYMARKET_GATE_PATH]),
      runOnMini('tail', ['-2000', MINI_POLYMARKET_AUDIT_PATH]),
    ]);
    return {
      ...oversize,
      payload: unavailableState(oversize.reason, oversize.detail, {
        gate: summariseGate(gateRead), audit: summariseAudit(auditRead),
      }),
    };
  }
  const [stateRead, gateRead, auditRead] = await Promise.all([
    runOnMini('cat', [MINI_POLYMARKET_STATE_PATH]),
    runOnMini('cat', [MINI_POLYMARKET_GATE_PATH]),
    runOnMini('tail', ['-2000', MINI_POLYMARKET_AUDIT_PATH]),
  ]);
  const observed = { gate: summariseGate(gateRead), audit: summariseAudit(auditRead) };
  if (!stateRead.ok && isTransportFailure(stateRead)) {
    return { ok: false, reason: stateRead.reason, detail: stateRead.detail, payload: unavailableState(stateRead.reason, stateRead.detail, observed) };
  }
  let state = null;
  if (stateRead.ok) {
    try { state = JSON.parse(stateRead.stdout); } catch (_) { state = null; }
  }
  if (!state) {
    const reason = stateRead.reason || 'no-state';
    return { ok: true, reason: null, detail: null, payload: unavailableState(reason, stateRead.detail, observed) };
  }

  const gate = observed.gate;
  const audit = observed.audit || EMPTY_AUDIT;
  const metrics = state?.performance_metrics || {};

  return {
    ok: true,
    reason: null,
    detail: null,
    payload: {
      present: true,
      mode: state.dry_run ? 'dry-run' : 'paper',
      trades: Array.isArray(state.trade_history) ? state.trade_history.length : 0,
      net_pnl: metrics.net_pnl ?? null,
      realized_edge: metrics.realized_edge ?? null,
      updated_at: state.timestamp ?? null,
      gate,
      audit,
    },
  };
}

async function buildMarketsRemote() {
  const oversize = await oversizeStateRead();
  if (oversize) {
    const exclusionsRead = await runOnMini('cat', [MINI_POLYMARKET_EXCLUSIONS_PATH]);
    return {
      ...oversize,
      payload: unavailableMarkets(oversize.reason, oversize.detail, { exclusions: summariseExclusions(exclusionsRead) }),
    };
  }
  const [stateRead, exclusionsRead] = await Promise.all([
    runOnMini('cat', [MINI_POLYMARKET_STATE_PATH]),
    runOnMini('cat', [MINI_POLYMARKET_EXCLUSIONS_PATH]),
  ]);
  if (!stateRead.ok && isTransportFailure(stateRead)) {
    return {
      ok: false, reason: stateRead.reason, detail: stateRead.detail,
      payload: unavailableMarkets(stateRead.reason, stateRead.detail, { exclusions: summariseExclusions(exclusionsRead) }),
    };
  }
  let state = null;
  if (stateRead.ok) { try { state = JSON.parse(stateRead.stdout); } catch (_) { state = null; } }
  let exclusionsData = { present: false, valid: true, exclusions: [], error: null };
  if (exclusionsRead.ok) {
    try {
      const data = JSON.parse(exclusionsRead.stdout);
      if (data && Array.isArray(data.exclusions)) {
        exclusionsData = { present: true, valid: true, exclusions: data.exclusions, error: null };
      }
    } catch (error) { exclusionsData = { present: false, valid: false, exclusions: [], error: error.message }; }
  } else if (exclusionsRead.reason !== 'remote-exit') {
    // A missing exclusions file is the documented empty case, not a failure. Only a
    // transport problem is reported as one.
    exclusionsData = { present: false, valid: false, exclusions: [], error: exclusionsRead.detail || exclusionsRead.reason };
  }

  const rows = new Map();
  const exclusionsById = new Map((exclusionsData.exclusions || []).map((item) => [item.market_id, item]));
  if (state?.execution_engine?.order_books) {
    for (const [marketId, book] of Object.entries(state.execution_engine.order_books)) {
      const excluded = exclusionsById.has(marketId);
      const bids = Array.isArray(book.bids) ? book.bids : [];
      const asks = Array.isArray(book.asks) ? book.asks : [];
      const bestBid = bids.length ? bids[0][0] : null;
      const bestAsk = asks.length ? asks[0][0] : null;
      rows.set(marketId, {
        market_id: marketId,
        excluded,
        best_bid: bestBid,
        best_ask: bestAsk,
        mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
        spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
        bid_depth: bids.reduce((sum, [, size]) => sum + (size || 0), 0),
        ask_depth: asks.reduce((sum, [, size]) => sum + (size || 0), 0),
        last_updated: book.updated_at || null,
      });
    }
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    payload: {
      present: !!state,
      state_path: MINI_POLYMARKET_STATE_PATH,
      updated_at: state ? state.timestamp ?? null : null,
      summary: {
        trades: Array.isArray(state?.trade_history) ? state.trade_history.length : 0,
        signals: 0, // Not directly available
        orders: Object.keys(state?.execution_engine?.orders || {}).length,
        fills: state?.execution_engine?.fills?.length || 0,
        open_positions: Object.keys(state?.execution_engine?.positions || {}).length,
        closed_positions: state?.execution_engine?.closed_positions?.length || 0,
        markets: rows.size,
      },
      markets: Array.from(rows.values()),
      exclusions: {
        path: MINI_POLYMARKET_EXCLUSIONS_PATH,
        present: exclusionsData.present,
        valid: exclusionsData.valid,
        count: exclusionsData.valid ? (exclusionsData.exclusions?.length || 0) : null,
        items: exclusionsData.exclusions || [],
        error: exclusionsData.error,
      },
    },
  };
}

function isTransportFailure(result) {
  return ['timeout', 'ssh-unreachable', 'ssh-missing', 'ssh-error', 'output-too-large'].includes(result.reason);
}

/**
 * Ask how big the file is before pulling it across the tailnet.
 *
 * engine_state.json grows with every recorded fill, and on 2026-10-13 it measured
 * 11,858,709 bytes on the mini -- larger than the read budget. The deployed synchronous code
 * turned the resulting ENOBUFS into a bare `null`, so the panel showed nothing and named
 * nothing; reading it anyway and failing afterwards transfers 10 MB to arrive at the same
 * empty result. One `wc -c` round-trip states what is actually true: the store exists, the
 * mini is reachable, and this HUD declines to slurp it whole.
 *
 * A failed size query is not a failed read. It returns null and the caller proceeds, because
 * `cat` reports its own reason, and inventing an outage from a missing number is the same
 * error as the blank panel this exists to replace.
 */
async function remoteFileSize(pathname) {
  const size = await runOnMini('wc', ['-c', pathname]);
  if (!size.ok) return null;
  const bytes = Number.parseInt(String(size.stdout).trim().split(/\s+/)[0], 10);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/** The shared refusal for both getters that read the engine state file. */
async function oversizeStateRead() {
  const bytes = await remoteFileSize(MINI_POLYMARKET_STATE_PATH);
  if (bytes === null || bytes <= MAX_SSH_OUTPUT_BYTES) return null;
  return {
    ok: false,
    reason: 'output-too-large',
    detail: `${MINI_POLYMARKET_STATE_PATH} is ${bytes} bytes, over the ${MAX_SSH_OUTPUT_BYTES}-byte read budget`,
  };
}

const BUILDERS = { runtime: buildRuntimeRemote, state: buildStateRemote, markets: buildMarketsRemote };
const UNAVAILABLE_BUILDERS = { runtime: unavailableRuntime, state: unavailableState, markets: unavailableMarkets };
const observations = new Map();

function observation(name) {
  if (!observations.has(name)) {
    observations.set(name, { state: 'never', payload: null, reason: null, detail: null, observedAt: 0, attemptedAt: 0, inFlight: null, serial: 0, waiters: [] });
  }
  return observations.get(name);
}

/**
 * Wake the callers parked on an observation newer than the one they have already seen. A
 * waiter whose seenSerial is still current stays registered for the next completion, so a
 * caller that joined before a refresh started is never answered by an observation it had
 * already counted.
 */
function settleWaiters(entry) {
  if (entry.waiters.length === 0) return;
  const pending = [];
  for (const waiter of entry.waiters) {
    if (entry.serial > waiter.seenSerial) waiter.resolve('done');
    else pending.push(waiter);
  }
  entry.waiters = pending;
}

function startRefresh(name) {
  const entry = observation(name);
  entry.attemptedAt = Date.now();
  const run = BUILDERS[name]()
    .then((result) => {
      entry.state = result.ok ? 'ok' : result.reason;
      entry.reason = result.reason;
      entry.detail = result.detail;
      entry.payload = result.payload;
      entry.observedAt = Date.now();
      entry.serial += 1;
      settleWaiters(entry);
    })
    .catch((error) => {
      // A builder must not reject, but a bug in one must not leave the panel claiming an
      // observation it never got either.
      entry.state = 'builder-error';
      entry.reason = 'builder-error';
      entry.detail = String((error && error.message) || error);
      entry.payload = UNAVAILABLE_BUILDERS[name]('builder-error', entry.detail);
      entry.observedAt = Date.now();
      entry.serial += 1;
      settleWaiters(entry);
    })
    .finally(() => { if (entry.inFlight === run) entry.inFlight = null; });
  entry.inFlight = run;
  return run;
}

const evidenceReported = new Map();

/**
 * How many callers are parked waiting for an observation newer than the one they have
 * seen. Test-visible plumbing rather than API: the polling version it replaced could only
 * be audited by counting unrelated timers, and a guard that cannot tell its own resource
 * from everybody else's is not a guard.
 */
function pendingWaiters(name) {
  const entry = observations.get(name);
  return entry ? entry.waiters.length : 0;
}

function buildStatus(name, entry) {
  const interval = REFRESH_INTERVAL_MS[name];
  const ageMs = entry.observedAt ? Date.now() - entry.observedAt : null;
  return {
    // 'never' = this process has not completed an observation yet. Deliberately not
    // spelled 'offline': absence of evidence is not evidence of absence.
    state: entry.state,
    observed: entry.state === 'ok' && ageMs !== null && ageMs <= interval,
    age_ms: ageMs,
    refresh_interval_ms: interval,
    refreshing: !!entry.inFlight,
    reason: entry.state === 'ok' ? null : entry.reason,
    detail: entry.state === 'ok' ? null : entry.detail,
  };
}

/**
 * How the last observation went, kept *out of the payload*.
 *
 * polymarketStatusContract.test.js pins the served body at exactly thirteen fields and
 * checks it against the web interface key for key, so freshness is not mine to add there.
 * The routes publish it as response headers instead, and anything in-process reads it
 * from here. The socket resource path carries no headers, which is the pre-existing
 * shape of that gap rather than a new one.
 */
function polymarketRemoteStatus(name) {
  const entry = observations.get(name);
  if (!entry) return { state: 'never', observed: false, age_ms: null, refresh_interval_ms: REFRESH_INTERVAL_MS[name], refreshing: false, reason: 'never', detail: null };
  const status = buildStatus(name, entry);
  evidenceReported.set(name, status);
  return status;
}

function observationPayload(name) {
  const entry = observation(name);
  return entry.payload || UNAVAILABLE_BUILDERS[name](entry.state, entry.detail);
}

/**
 * The last completed observation, and a background refresh if one is due. Synchronous by
 * contract: the socket/REST resource table calls producers without awaiting them, so this
 * must never return a promise, and it must never park the loop on ssh.
 */
function remoteObservation(name) {
  const entry = observation(name);
  if (!entry.inFlight && Date.now() - entry.attemptedAt >= REFRESH_INTERVAL_MS[name]) startRefresh(name);
  return observationPayload(name);
}

/**
 * A genuinely fresh observation, for the two callers that decide whether launchctl may be
 * run. Resolves to the fail-closed payload when the evidence cannot be established inside
 * `budgetMs`, so the gate refuses instead of acting on a guess -- read that outcome with
 * polymarketRemoteStatus('runtime'), whose state becomes 'gate-timeout'. `force: true`
 * waits for an observation started *after* this call, which is what a post-action re-read
 * needs: a refresh that began before `launchctl kickstart` cannot say whether the engine
 * came up.
 */
async function refreshObservation(name, budgetMs = ACTION_GATE_DEADLINE_MS, options = {}) {
  const entry = observation(name);
  const seenSerial = entry.serial;
  if (options.force || !entry.inFlight) startRefresh(name);
  const waiter = { seenSerial, resolve: null };
  // Pushed synchronously inside the executor, before the race below, so a completion that
  // lands on the next tick cannot miss this caller.
  const completed = new Promise((resolve) => { waiter.resolve = resolve; entry.waiters.push(waiter); });
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), budgetMs); });
  const outcome = await Promise.race([completed, late]);
  clearTimeout(timer);
  const index = entry.waiters.indexOf(waiter);
  if (index !== -1) entry.waiters.splice(index, 1);
  if (outcome !== 'done') {
    // The refresh may still land in the background; that does not entitle this caller to
    // its answer, because the gate has already spent its stated budget.
    entry.state = 'gate-timeout';
    entry.reason = 'gate-timeout';
    entry.detail = `no fresh evidence within ${budgetMs}ms`;
    entry.payload = UNAVAILABLE_BUILDERS[name]('gate-timeout', entry.detail);
  }
  return observationPayload(name);
}

const getPolymarketRuntimeRemote = () => (isLaptop() ? remoteObservation('runtime') : null);
const getPolymarketStateRemote = () => (isLaptop() ? remoteObservation('state') : null);
const getPolymarketMarketsRemote = () => (isLaptop() ? remoteObservation('markets') : null);
const getPolymarketRuntimeForAction = (budgetMs, options) => (isLaptop() ? refreshObservation('runtime', budgetMs, options) : Promise.resolve(null));

// Kept for callers that already handle a json envelope; same bounded execution.
async function runOnMiniJson(cmd, args) {
  const result = await runOnMini(cmd, args);
  if (!result.ok) return { ok: false, error: result.detail || result.reason, reason: result.reason };
  try { return { ok: true, data: JSON.parse(result.stdout) }; } catch (error) {
    return { ok: false, error: `JSON parse failed: ${error.message}`, reason: 'unparseable-output' };
  }
}

module.exports = {
  isLaptop,
  runOnMini,
  runOnMiniJson,
  getPolymarketRuntimeRemote,
  getPolymarketStateRemote,
  getPolymarketMarketsRemote,
  getPolymarketRuntimeForAction,
  refreshObservation,
  remoteObservation,
  polymarketRemoteStatus,
  evaluateRuntimeEvidence,
  isNoMatch,
  sshPoolState,
  pendingWaiters,
  MAX_CONCURRENT_SSH,
  MAX_SSH_DEADLINE_MS,
  MAX_SSH_OUTPUT_BYTES,
  DEFAULT_SSH_DEADLINE_MS,
  ACTION_GATE_DEADLINE_MS,
  REFRESH_INTERVAL_MS,
  MINI_HOST,
};
