'use strict';

// The terminal registry: spawn, kill, signal, list, persist, reconcile, reap.
//
// State lives in its own hive file, `spawned_terminals.json`, NOT in
// `terminals.json`. That separation is deliberate and load-bearing:
//
//   `terminals.json` is rewritten wholesale every 60 seconds by
//   bin/push-terminals.sh -> collect-terminals.py, which describes the shells a
//   human is sitting in. Writing spawned terminals into that file would mean
//   watching them disappear on the next collector tick.
//
// So the two are different things with different lifecycles and are kept apart
// on disk. `collectedTerminals()` merges them for the view, labelling each
// record with where it came from, and the HUD's existing multi-host merge is
// untouched.
//
// Persistence is best-effort by design. A terminal that is running matters more
// than a terminal that is recorded: if the hive lock is held, the registry keeps
// the authoritative in-memory copy, retries on the next change, and reconcile()
// rebuilds from live process state after a restart.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const allowlist = require('./allowlist');
const logstore = require('./logstore');
const tmuxSpawner = require('./spawners/tmux');
const backgroundSpawner = require('./spawners/background');
const orchestrateSpawner = require('./spawners/orchestrate');
const remoteSpawner = require('./spawners/remote');

const STATE_FILE = 'spawned_terminals.json';
const TYPES = ['tmux', 'background', 'orchestrate', 'remote'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'];
const DEFAULTS = {
  maxConcurrent: 50,
  reapAfterHours: 24,
  reconcileMs: 60000,
  // Deliberately generous: this is a ceiling that exists so a hung command cannot
  // hold a concurrency slot forever, not a budget for ordinary work. A full test
  // suite legitimately runs for many minutes. 0 disables it.
  commandTimeoutMs: 30 * 60 * 1000,
};

// The hive lock is resolved per-manager rather than once at module load. Reading
// it from process.env at require time only worked because index.js happens to
// export OPENALICE_HIVE before requiring this file; anywhere else -- a test
// with a fixture hive, a second instance pointed elsewhere -- it would silently
// lock the wrong path or find no lock at all.
function resolveFileLock(hive) {
  try {
    return require(path.join(hive, 'lib', 'file_lock.js')).withFileLock;
  } catch {
    return null;
  }
}

const nowIso = () => new Date().toISOString();

function newId() {
  return `term_${crypto.randomBytes(6).toString('hex')}`;
}

class TerminalManager {
  constructor(options = {}) {
    this.hive = options.hive || process.env.OPENALICE_HIVE
      || path.join(os.homedir(), 'openalice-fleet', 'hive');
    this.host = options.host || os.hostname().split('.')[0];
    this.statePath = options.statePath || path.join(this.hive, STATE_FILE);
    this.fileLock = options.fileLock !== undefined ? options.fileLock : resolveFileLock(this.hive);
    this.logOptions = { dir: options.logDir || logstore.DEFAULTS.dir };
    this.maxConcurrent = Number(options.maxConcurrent) || DEFAULTS.maxConcurrent;
    this.reapAfterHours = Number(options.reapAfterHours) || DEFAULTS.reapAfterHours;
    this.reconcileMs = Number(options.reconcileMs) || DEFAULTS.reconcileMs;
    this.commandTimeoutMs = options.commandTimeoutMs === undefined
      ? DEFAULTS.commandTimeoutMs
      : Number(options.commandTimeoutMs);
    this.reconcileTimer = null;
    // id -> terminal record
    this.registry = new Map();
    this.persistScheduled = false;
    this.lastPersistError = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Load persisted records and reconcile them against live process state.
   *
   * Reconciliation matters because the HUD restarts (launchd KeepAlive) while
   * terminals keep running: a record whose tmux session is gone is `exited`,
   * not `running`. Reporting it as running would be exactly the kind of frozen
   * feed this codebase already has fixes for.
   */
  async load() {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { doc = null; }
    const records = Array.isArray(doc?.terminals) ? doc.terminals : [];
    this.registry.clear();
    for (const record of records) {
      if (!record || typeof record.id !== 'string') continue;
      if (!TYPES.includes(record.type)) continue;
      this.registry.set(record.id, { ...record, host: record.host || this.host });
    }
    await this.reconcile();
    this.startReconcileLoop();
    return this.registry.size;
  }

  /**
   * Keep tmux-backed statuses honest.
   *
   * A background terminal reports its own exit through the child's exit event,
   * but a tmux session has no such callback: when its command finishes, tmux
   * tears the session down and nothing tells us. Without this loop a terminal
   * that finished a minute ago would still read as `running` until the next
   * HUD restart, which is exactly the kind of stale-but-green state that makes a
   * dashboard untrustworthy.
   */
  startReconcileLoop() {
    if (this.reconcileTimer || !this.reconcileMs) return;
    const timer = setInterval(() => {
      this.reconcile().catch(() => { /* a transient tmux error must not kill the loop */ });
    }, this.reconcileMs);
    timer.unref?.();
    this.reconcileTimer = timer;
  }

  stopReconcileLoop() {
    if (!this.reconcileTimer) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /** Check every non-terminal record against the OS and fix its status. */
  async reconcile() {
    const fixed = [];
    for (const record of this.registry.values()) {
      if (record.status === 'exited' || record.status === 'failed' || record.status === 'killed') continue;
      const alive = await this.backendAlive(record);
      if (!alive && record.status === 'running') {
        record.status = 'exited';
        record.exitedAt = record.exitedAt || nowIso();
        record.reconciledAt = nowIso();
        fixed.push(record.id);
      }
    }
    if (fixed.length) this.schedulePersist();
    return fixed;
  }

  // ------------------------------------------------------------------ queries

  list(filter = {}) {
    let records = [...this.registry.values()];
    if (filter.type) records = records.filter((r) => r.type === filter.type);
    if (filter.status) records = records.filter((r) => r.status === filter.status);
    if (filter.active) records = records.filter((r) => r.status === 'running' || r.status === 'starting');
    return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  get(id) {
    return this.registry.get(id) || null;
  }

  activeCount() {
    return [...this.registry.values()].filter((r) => r.status === 'running' || r.status === 'starting').length;
  }

  /**
   * The view the HUD serves: what this host collected (shells a human is
   * sitting in) plus what this host spawned, kept distinguishable by `origin`.
   */
  collectedTerminals(collectedDoc = null) {
    const doc = collectedDoc && typeof collectedDoc === 'object' ? collectedDoc : {};
    const collected = Array.isArray(doc.shell_terminals) ? doc.shell_terminals : [];
    return {
      collected_at: doc.collected_at || null,
      collected,
      spawned: this.list(),
    };
  }

  health() {
    const usage = logstore.usage(this.logOptions);
    const records = this.list();
    return {
      hosts: 1,
      active: records.filter((r) => r.status === 'running' || r.status === 'starting').length,
      total: records.length,
      by_status: records.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
      by_type: records.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
      log_files: usage.files,
      log_bytes: usage.bytes,
      timed_out: records.filter((r) => r.timedOut).length,
      command_timeout_ms: this.commandTimeoutMs,
      max_concurrent: this.maxConcurrent,
      persist_error: this.lastPersistError,
    };
  }

  // ------------------------------------------------------------------ spawns

  /**
   * Spawn one terminal. Throws with a statusCode on rejection so the route can
   * pass it straight through.
   */
  /** Per-spawn timeout override, or the configured default. 0 disables. */
  timeoutFor(spec = {}) {
    const raw = spec.timeoutMs === undefined ? this.commandTimeoutMs : Number(spec.timeoutMs);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULTS.commandTimeoutMs;
  }

  async spawnOne(spec = {}) {
    const type = String(spec.type || 'tmux');
    if (!TYPES.includes(type)) {
      throw Object.assign(new Error(`type must be one of ${TYPES.join(', ')}`), { statusCode: 400 });
    }
    if (type === 'orchestrate') {
      throw Object.assign(new Error('use the orchestrate bulk mode for agent spawning'), { statusCode: 400 });
    }
    if (type === 'remote') return this.spawnRemote(spec);
    if (this.activeCount() >= this.maxConcurrent) {
      throw Object.assign(new Error(`refusing to exceed ${this.maxConcurrent} concurrent terminals`), { statusCode: 429 });
    }

    const command = String(spec.cmd || spec.command || '').trim();
    const cwd = spec.cwd ? path.resolve(String(spec.cwd)) : null;
    const verdict = allowlist.validate(command, cwd, { hive: this.hive });
    if (!verdict.allowed) {
      throw Object.assign(new Error(verdict.reason), { statusCode: 403 });
    }
    const argv = verdict.argv;
    const env = allowlist.buildEnv(spec.env, { hive: this.hive });

    const id = newId();
    const logFile = logstore.logPath(id, this.logOptions);

    if (type === 'tmux') {
      if (!await tmuxSpawner.available()) {
        throw Object.assign(new Error('tmux is not available on this host'), { statusCode: 501 });
      }
      const session = `hud_${id}`;
      const record = {
        id,
        type,
        cmd: command,
        argv,
        cwd: verdict.cwd,
        host: this.host,
        name: spec.name ? String(spec.name).slice(0, 80) : null,
        tmuxSession: session,
        tmuxPane: null,
        pid: null,
        status: 'starting',
        startedAt: nowIso(),
        exitedAt: null,
        exitCode: null,
        signal: null,
        outputFile: logFile,
        envKeys: Object.keys(env).sort(),
        logBytes: 0,
        logFiles: 0,
      timedOut: false,
      };
      try {
        const started = await tmuxSpawner.spawn({
          session,
          argv,
          cwd: verdict.cwd,
          logFile,
          cols: Number(spec.cols) || 200,
          rows: Number(spec.rows) || 50,
          env,
        });
        record.tmuxPane = started.tmuxPane;
        record.status = 'running';
      } catch (error) {
        record.status = 'failed';
        record.exitedAt = nowIso();
        logstore.append(id, `[hud] tmux spawn failed: ${error.message}\n`, this.logOptions);
        this.registry.set(id, record);
        this.schedulePersist();
        throw Object.assign(new Error(`tmux spawn failed: ${error.message}`), { statusCode: 502 });
      }
      this.registry.set(id, record);
      this.schedulePersist();
      return record;
    }

    // background
    const record = {
      id,
      type,
      cmd: command,
      argv,
      cwd: verdict.cwd,
      host: this.host,
      name: spec.name ? String(spec.name).slice(0, 80) : null,
      pid: null,
      tmuxSession: null,
      tmuxPane: null,
      status: 'starting',
      startedAt: nowIso(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      outputFile: logFile,
      envKeys: Object.keys(env).sort(),
      logBytes: 0,
      logFiles: 0,
      timedOut: false,
    };
    this.registry.set(id, record);
    try {
      const child = backgroundSpawner.spawn({
        argv,
        cwd: verdict.cwd,
        logFile,
        env,
        timeoutMs: this.timeoutFor(spec),
        onExit: ({ code, signal: sig, timedOut }) => {
          const live = this.registry.get(id);
          if (!live) return;
          // An exit callback can land after a kill() already finalised the
          // record; do not walk a killed terminal back to exited.
          if (live.status === 'killed') return;
          live.timedOut = Boolean(timedOut);
          live.status = code === 0 ? 'exited' : 'failed';
          live.exitCode = code ?? null;
          live.signal = sig ?? null;
          live.exitedAt = nowIso();
          this.schedulePersist();
        },
      });
      record.pid = child.pid;
      record.status = 'running';
      child.unref();
    } catch (error) {
      record.status = 'failed';
      record.exitedAt = nowIso();
      logstore.append(id, `[hud] spawn failed: ${error.message}\n`, this.logOptions);
      this.schedulePersist();
      throw Object.assign(new Error(`spawn failed: ${error.message}`), { statusCode: 500 });
    }
    this.schedulePersist();
    return record;
  }

  /**
   * Spawn several terminals. Failures are reported per item rather than
   * failing the batch: one disallowed command must not cancel the other nine.
   */
  async spawnBulk(specs = [], options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || this.maxConcurrent, this.maxConcurrent));
    const list = Array.isArray(specs) ? specs.slice(0, limit) : [];
    const results = [];
    for (const spec of list) {
      try {
        const terminal = await this.spawnOne(spec);
        results.push({ ok: true, terminal });
      } catch (error) {
        results.push({ ok: false, cmd: spec?.cmd ?? null, error: error.message });
      }
    }
    return results;
  }

  /**
   * Spawn orchestrate agents. Requires `confirmed`, because this reaches
   * `claude --permission-mode bypassPermissions` on a fresh worktree.
   */
  async spawnOrchestrate(spec = {}) {
    if (spec.confirmed !== true) {
      throw Object.assign(new Error('orchestrate spawn requires confirmed: true'), { statusCode: 400 });
    }
    if (!orchestrateSpawner.available()) {
      throw Object.assign(new Error('orchestrate scripts are not installed on this host'), { statusCode: 501 });
    }
    const repoRoot = path.resolve(String(spec.repoRoot || ''));
    const verdict = allowlist.validate('git status', repoRoot, { hive: this.hive });
    if (!verdict.allowed) {
      throw Object.assign(new Error(`repoRoot rejected: ${verdict.reason}`), { statusCode: 403 });
    }
    const count = Math.max(1, Math.min(Number(spec.count) || 1, this.maxConcurrent));
    const outcome = await orchestrateSpawner.spawn({
      repoRoot,
      objective: String(spec.objective || '').slice(0, 2000),
      steps: Array.isArray(spec.steps) ? spec.steps.map(String).slice(0, 10) : [],
      count,
      branchPrefix: spec.branchPrefix || 'feat/hud',
      session: orchestrateSpawner.currentSession(),
    });
    const records = [];
    for (const agent of outcome.created) {
      const id = newId();
      const record = {
        id,
        type: 'orchestrate',
        cmd: `orchestrate: ${agent.objective}`,
        argv: ['orchestrate', ...agent.steps],
        cwd: agent.worktreePath,
        host: this.host,
        name: agent.branch,
        orchestrateWindow: agent.orchestrateWindow,
        tmuxSession: agent.tmuxSession,
        worktreePath: agent.worktreePath,
        spareBranch: agent.spareBranch,
        branch: agent.branch,
        pid: null,
        status: 'running',
        startedAt: nowIso(),
        exitedAt: null,
        exitCode: null,
        signal: null,
        outputFile: null,
        envKeys: [],
        logBytes: 0,
        logFiles: 0,
      timedOut: false,
      };
      this.registry.set(id, record);
      records.push(record);
    }
    if (records.length) this.schedulePersist();
    return { records, failures: outcome.failures };
  }

  /**
   * Spawn on a peer host over SSH.
   *
   * Split from spawnOne because the validation is different in kind: the cwd
   * lives on the other machine, so it is checked against the PEER's allowed
   * trees with the existence check skipped, rather than against this host's.
   * Skipping existence is safe only because prefix containment still applies.
   */
  async spawnRemote(spec = {}) {
    const peer = remoteSpawner.getPeer(this.hive, spec.peer, {});
    if (this.activeCount() >= this.maxConcurrent) {
      throw Object.assign(new Error(`refusing to exceed ${this.maxConcurrent} concurrent terminals`), { statusCode: 429 });
    }
    const command = String(spec.cmd || spec.command || '').trim();
    const cwd = spec.cwd ? path.resolve(String(spec.cwd)) : null;
    if (!cwd) throw Object.assign(new Error('remote spawn requires a cwd'), { statusCode: 400 });
    const verdict = remoteSpawner.validateForPeer(command, cwd, peer, { hive: this.hive });
    if (!verdict.allowed) throw Object.assign(new Error(verdict.reason), { statusCode: 403 });

    const id = newId();
    const logFile = logstore.logPath(id, this.logOptions);
    const record = {
      id,
      type: 'remote',
      // The host is the PEER, not this machine: the panel must not claim this
      // ran locally.
      host: peer.name,
      peer: peer.name,
      cmd: command,
      argv: verdict.argv,
      cwd: verdict.cwd,
      name: spec.name ? String(spec.name).slice(0, 80) : null,
      pid: null,
      tmuxSession: null,
      tmuxPane: null,
      status: 'starting',
      startedAt: nowIso(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      outputFile: logFile,
      // The peer environment is not this process's, so nothing from it is kept.
      envKeys: [],
      logBytes: 0,
      logFiles: 0,
      timedOut: false,
    };
    this.registry.set(id, record);
    try {
      // Ask the peer for a PATH that can find its own tools. A non-interactive
      // ssh session gets the login shell's default PATH, which on this fleet has
      // no Homebrew and no Python framework, so `pytest` and `ruff` would exit
      // 127 despite being installed. Probed per peer and cached briefly, because
      // the two Macs install different Python versions and a locally-built PATH
      // would name directories the peer does not have.
      const resolvedPath = await remoteSpawner.probePeerPath(peer);
      const child = remoteSpawner.spawn({
        peer,
        argv: verdict.argv,
        cwd: verdict.cwd,
        logFile,
        env: {},
        resolvedPath,
        timeoutMs: this.timeoutFor(spec),
        onExit: ({ code, signal: sig, timedOut }) => {
          const live = this.registry.get(id);
          if (!live || live.status === 'killed') return;
          live.timedOut = Boolean(timedOut);
          live.status = code === 0 ? 'exited' : 'failed';
          live.exitCode = code ?? null;
          live.signal = sig ?? null;
          live.exitedAt = nowIso();
          this.schedulePersist();
        },
      });
      record.pid = child.pid;
      record.status = 'running';
      child.unref();
    } catch (error) {
      record.status = 'failed';
      record.exitedAt = nowIso();
      logstore.append(id, `[hud] remote spawn failed: ${error.message}\n`, this.logOptions);
      this.schedulePersist();
      throw Object.assign(new Error(`remote spawn failed: ${error.message}`), { statusCode: 502 });
    }
    this.schedulePersist();
    return record;
  }

  /** Peers this host may dispatch to, with reachability. */
  async peers() {
    const configured = remoteSpawner.listPeers(this.hive, {});
    return Promise.all(configured.map(async (peer) => {
      if (!peer.reachable) return { ...peer, probe: { ok: false, code: null } };
      const target = remoteSpawner.getPeer(this.hive, peer.name, {});
      const probe = await remoteSpawner.probe(target, { timeoutSec: 6 });
      return { ...peer, probe };
    }));
  }

  // ------------------------------------------------------------ kill / signal

  async backendAlive(record) {
    try {
      if (record.type === 'tmux') return await tmuxSpawner.isAlive(record.tmuxSession);
      if (record.type === 'background') return backgroundSpawner.isAlive(record.pid);
      if (record.type === 'orchestrate') return await orchestrateSpawner.isAlive(record);
      if (record.type === 'remote') return remoteSpawner.isAlive(record.pid);
    } catch {
      return false;
    }
    return false;
  }

  async kill(id, { signal = 'SIGTERM' } = {}) {
    const record = this.registry.get(id);
    if (!record) throw Object.assign(new Error(`unknown terminal ${id}`), { statusCode: 404 });
    if (!SIGNALS.includes(signal)) {
      throw Object.assign(new Error(`signal must be one of ${SIGNALS.join(', ')}`), { statusCode: 400 });
    }
    const alreadyFinal = record.status === 'killed' || record.status === 'exited' || record.status === 'failed';
    if (!alreadyFinal) {
      try {
        if (record.type === 'tmux') await tmuxSpawner.kill(record.tmuxSession);
        else if (record.type === 'background') backgroundSpawner.kill(record.pid, signal);
        else if (record.type === 'orchestrate') {
          await orchestrateSpawner.kill({
            orchestrateWindow: record.orchestrateWindow,
            worktreePath: record.worktreePath,
            spareBranch: record.spareBranch,
          });
        } else if (record.type === 'remote') {
          // Closing the ssh channel is what actually stops it: the remote process
          // is exec'd, so it takes a SIGHUP when the channel goes away.
          remoteSpawner.kill(record.pid, signal);
        }
      } catch (error) {
        // A backend that cannot be reached is not proof the process is gone, so
        // the record is left alone and the failure reported. Reconcile() will
        // settle it on the next pass.
        throw Object.assign(new Error(`kill failed: ${error.message}`), { statusCode: 502 });
      }
      record.status = 'killed';
      record.signal = signal;
      record.exitedAt = nowIso();
      this.schedulePersist();
    }
    return record;
  }

  /** Signal without finalising the record -- for interrupting a running task. */
  async signal(id, signalName) {
    const record = this.registry.get(id);
    if (!record) throw Object.assign(new Error(`unknown terminal ${id}`), { statusCode: 404 });
    if (!SIGNALS.includes(signalName)) {
      throw Object.assign(new Error(`signal must be one of ${SIGNALS.join(', ')}`), { statusCode: 400 });
    }
    if (record.type === 'tmux') await tmuxSpawner.sendKeys(record.tmuxSession, signalName === 'SIGINT' ? 'C-c' : signalName);
    else if (record.type === 'background') backgroundSpawner.kill(record.pid, signalName);
    else throw Object.assign(new Error(`signal is not supported for ${record.type}`), { statusCode: 400 });
    return record;
  }

  // ------------------------------------------------------------------- output

  logs(id, options = {}) {
    const record = this.registry.get(id);
    if (!record) throw Object.assign(new Error(`unknown terminal ${id}`), { statusCode: 404 });
    if (!record.outputFile) return { lines: [], truncated: false, bytes: 0, missing: true, terminal: record };
    const result = logstore.tail(id, { ...this.logOptions, lines: options.lines });
    return { ...result, terminal: record };
  }

  /** Read output appended since `from`, for SSE follow. */
  logsSince(id, from) {
    const record = this.registry.get(id);
    if (!record) throw Object.assign(new Error(`unknown terminal ${id}`), { statusCode: 404 });
    if (!record.outputFile) return { chunk: '', at: from || 0 };
    return logstore.readSince(id, from, this.logOptions);
  }

  // --------------------------------------------------------------- persistence

  /**
   * Write the registry out. Uses the hive file lock when one is available so a
   * concurrent fleet writer cannot interleave; a held lock is reported rather
   * than queued behind, because this lock spins on a blocking wait and would
   * otherwise stall the HUD's event loop.
   */
  persist() {
    const doc = {
      host: this.host,
      updated_at: nowIso(),
      terminals: this.list(),
    };
    const write = () => {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, this.statePath);
      this.lastPersistError = null;
      return true;
    };
    try {
      if (typeof this.fileLock === 'function') {
        const lockPath = path.join(this.hive, '.spawned_terminals_lock');
        const stat = (() => { try { return fs.statSync(lockPath); } catch { return null; } })();
        if (stat && Date.now() - stat.mtimeMs < 30000) {
          this.lastPersistError = 'hive lock held; will retry';
          return false;
        }
        this.fileLock(lockPath, write);
      } else {
        write();
      }
      return true;
    } catch (error) {
      this.lastPersistError = error.message;
      return false;
    }
  }

  /** Coalesce writes: a burst of spawns is one file write, not one per spawn. */
  schedulePersist() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    setTimeout(() => {
      this.persistScheduled = false;
      this.persist();
    }, 250).unref?.();
  }

  // --------------------------------------------------------------------- reap

  /** Drop finished records older than the cutoff and free their logs. */
  reap({ maxAgeHours = this.reapAfterHours, statuses = ['exited', 'failed', 'killed'] } = {}) {
    const cutoff = Date.now() - (Number(maxAgeHours) * 60 * 60 * 1000);
    const wanted = new Set(statuses);
    const removed = [];
    let freed = 0;
    for (const [id, record] of this.registry) {
      if (!wanted.has(record.status)) continue;
      const at = Date.parse(record.exitedAt || record.startedAt || '') || 0;
      if (at > cutoff) continue;
      if (record.outputFile) {
        try { freed += fs.statSync(record.outputFile).size; } catch { /* already gone */ }
        logstore.remove(id, this.logOptions);
      }
      this.registry.delete(id);
      removed.push(id);
    }
    if (removed.length) this.schedulePersist();
    return { removed: removed.length, ids: removed, freed_bytes: freed };
  }
}

module.exports = { TerminalManager, TYPES, SIGNALS, STATE_FILE, DEFAULTS };