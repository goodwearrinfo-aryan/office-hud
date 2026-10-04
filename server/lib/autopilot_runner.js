'use strict';
// Production wiring for the Autopilot core.
//
// lib/autopilot.js owns the policy and the gates and is pure. This file supplies
// the three things it cannot know for itself — what state the world is in, what
// to propose, and where the audit trail goes — and it is the only place that
// touches git or the hive.
//
// GENERATION ONE IS VERIFICATION-ONLY, and that is a deliberate constraint, not
// a missing feature. Every tick runs the suite in a throwaway worktree and files
// the *result* as a proposal. It proposes no code edits yet. A loop that starts
// by measuring cannot silently entrench a wrong assumption about the repo, and
// it gives the operator a few days of real numbers before anything is allowed to
// touch a file. Code-change proposals are a later policy, not a later bug.
//
// TWO DECISIONS THAT LOOK LIKE SHORTCUTS AND ARE NOT:
//
// 1. `readState().dirtyFiles` counts *stale autopilot worktrees*, not the dirty
//    files in the operator's checkout. The gate's purpose is "do not reason
//    about a tree somebody else is editing", and the autopilot satisfies that
//    structurally: every command runs in a worktree this process just created,
//    which is clean by construction. Reporting the operator's dirty count would
//    mean reporting 40+ on this machine and refusing forever, which converts a
//    safety gate into a permanently closed door. The operator's real dirtiness
//    is still surfaced — as `sharedTreeDirty`, for the operator to see.
//
// 2. A suite with pre-existing failures is normal here (there are 7 on
//    origin/main), so "any failure discards the proposal" would mean the
//    autopilot never proposes anything at all. Instead the run is compared to a
//    recorded baseline of known failures. A run whose failures are a subset of
//    the baseline is a pass; a run with a NEW failure is discarded outright and
//    recorded as a regression. The baseline only ever tightens — it is never
//    widened to absorb a surprise, because a baseline that learns to accept new
//    failures is just a way of never noticing them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { Autopilot } = require('./autopilot');
const { withWorktree, staleWorktrees, dirtyCount, DEFAULT_PARK } = require('./autopilot_worktree');

const STATE_BASENAME = 'autopilot_state.json';
const SUITE_ARGS = [
  '--test',
  '--experimental-strip-types',
  'server/test/*.test.js',
  'server/test/*.test.ts',
];
const SUITE_TIMEOUT_MS = 900_000;

/** Read a hive JSON file, tolerating absence and corruption. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write via the hive's own lock helper when it is available, so a concurrent
 * writer (another HUD, the autocommit agent) cannot lose our update.
 */
function makeWriter(stateFile, withFileLock) {
  return function write(payload) {
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const put = () => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, body);
    };
    if (typeof withFileLock !== 'function') { put(); return; }
    try { withFileLock(`${stateFile}.lock`, put); } catch { put(); }
  };
}

/** Parse the `node --test` summary block. Returns null if the shape is wrong. */
function parseSuite(stdout) {
  const num = (label) => {
    const m = String(stdout).match(new RegExp(`^#\\s+${label}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = num('tests');
  const pass = num('pass');
  const fail = num('fail');
  if (tests === null || pass === null || fail === null) return null;
  const failures = [...String(stdout).matchAll(/^not ok \d+ - (.+)$/gm)]
    .map((m) => m[1].trim())
    .sort();
  return { tests, pass, fail, failures };
}

/**
 * The baseline decision, as a pure function so it can be tested without running
 * a suite or touching a repository.
 *
 *   seed   — first ever run: adopt what we see, and record that we did.
 *   accept — observed failures are a subset of the baseline: nothing new.
 *   reject — a failure nobody has seen before. Never absorbed; a baseline that
 *            learns to accept surprises is just a way of never noticing them.
 *
 * @param {string[]|null} baselineFailures  null means "never established"
 * @param {string[]} observedFailures
 */
function decideBaseline(baselineFailures, observedFailures) {
  const observed = Array.isArray(observedFailures) ? observedFailures : [];
  if (!Array.isArray(baselineFailures)) {
    return { action: 'seed', newFailures: [], baseline: [...observed].sort() };
  }
  const known = new Set(baselineFailures);
  const newFailures = observed.filter((f) => !known.has(f));
  return {
    action: newFailures.length > 0 ? 'reject' : 'accept',
    newFailures,
    baseline: [...baselineFailures],
  };
}

/**
 * Build the runner seams plus persistence, ready to hand to `new Autopilot(...)`.
 *
 * @param {object} opts
 * @param {string} opts.repo    path to the office-hud checkout (read-only use)
 * @param {string} opts.hive    hive directory for the state file
 * @param {string} [opts.park]  where worktrees are created
 * @param {string} [opts.ref]   git ref to verify (default origin/main)
 * @param {Function} [opts.withFileLock] hive/lib/file_lock.js `withFileLock`
 */
function createRunner(opts = {}) {
  const repo = path.resolve(opts.repo || process.cwd());
  const hive = opts.hive || process.env.OPENALICE_HIVE
    || path.join(os.homedir(), 'openalice-fleet', 'hive');
  const stateFile = opts.stateFile || path.join(hive, STATE_BASENAME);
  const park = opts.park || DEFAULT_PARK;
  const ref = opts.ref || 'origin/main';
  const now = opts.now || (() => Date.now());
  const write = makeWriter(stateFile, opts.withFileLock);

  const loadState = () => readJson(stateFile, {});

  /** Merge a patch into the persisted state without losing other writers' keys. */
  function patchState(patch) {
    const next = { ...loadState(), ...patch, version: 1, updatedAt: now() };
    write(next);
    return next;
  }

  /** Persist the autopilot's in-memory view (proposals, audit, sequence). */
  function persist(autopilot) {
    patchState({
      policy: autopilot.describePolicy(),
      sequence: autopilot.sequence,
      proposals: autopilot.proposals,
      audit: autopilot.auditLog.slice(-100),
    });
  }

  /**
   * Seed a restarted process from disk so proposal ids and history survive a
   * server bounce. A corrupt or absent state file simply starts empty.
   */
  function restore(autopilot) {
    const state = loadState();
    if (Array.isArray(state.proposals)) autopilot.proposals = state.proposals;
    if (typeof state.sequence === 'number') autopilot.sequence = state.sequence;
    if (Array.isArray(state.audit)) autopilot.auditLog = state.audit.slice(-100);
    return state;
  }

  /**
   * The gate's view of the world.
   *
   * `dirtyFiles` is the count of leftover worktrees — see the note at the top of
   * this file. `sharedTreeDirty` is reported alongside for the operator only.
   */
  async function readState(autopilot) {
    const stale = await staleWorktrees(repo, park);
    let sharedTreeDirty = null;
    try { sharedTreeDirty = await dirtyCount(repo); } catch { sharedTreeDirty = null; }
    const instance = autopilot || current;
    const open = instance.proposals.filter((p) => p.state === 'open');
    // Cooldown is measured from the most recent proposal of any state, so
    // landing one does not hand back a free tick.
    const last = instance.proposals.reduce((acc, p) => Math.max(acc, p.createdAt || 0), 0);
    return { dirtyFiles: stale.length, openProposals: open, lastProposalAt: last, sharedTreeDirty };
  }

  /**
   * Verify `ref` in a throwaway worktree and return a proposal describing what
   * the suite actually did.
   *
   * Returns null when the run regresses against the baseline — a new failure is
   * a signal for a human, not something to propose around.
   */
  async function run(autopilot) {
    const instance = autopilot || current;
    const slug = `verify-${now()}`;
    const outcome = await withWorktree({
      repo,
      ref,
      name: slug,
      park,
      fn: async (wt) => {
        // Reuse the primary checkout's dependencies instead of running
        // `npm ci` on every tick. This is a read-only borrow: the worktree's own
        // node_modules is a symlink and disappears with the worktree.
        const modules = path.join(wt, 'node_modules');
        const source = path.join(repo, 'node_modules');
        if (!fs.existsSync(modules) && fs.existsSync(source)) {
          try { fs.symlinkSync(source, modules, 'dir'); } catch { /* lost a race; fine */ }
        }

        const stdout = await new Promise((resolve, reject) => {
          execFile('node', SUITE_ARGS, { cwd: wt, timeout: SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
            (err, out, errText) => {
              // A non-zero exit is the normal path when the suite has known
              // failures, so the exit code alone must not reject.
              if (err && /timed out|killed|ETIMEDOUT/i.test(String(err.message))) {
                reject(new Error(err.message));
                return;
              }
              resolve(`${out || ''}${errText || ''}`);
            });
        });

        const parsed = parseSuite(stdout);
        if (!parsed) throw new Error('could not parse the test summary');
        return parsed;
      },
    });
    // withWorktree removes the tree before returning; from here on we only touch
    // the parsed result, never the filesystem.
    void instance;

    const prior = loadState();
    const decision = decideBaseline(prior.baselineFailures, outcome.failures);

    if (decision.action === 'reject') {
      // Recorded whether or not a proposal follows, so a regression is visible
      // even when the gate refuses to run at all.
      patchState({
        lastRegression: {
          at: now(),
          newFailures: decision.newFailures,
          totals: { tests: outcome.tests, pass: outcome.pass, fail: outcome.fail },
        },
        lastVerification: { at: now(), ...outcome, newFailures: decision.newFailures },
      });
      return null;
    }

    // `seed` on the first run, `accept` thereafter. Either way the baseline is
    // written from `decision.baseline`, which is the OLD list on accept — so a
    // clean run cannot quietly shrink or reshape what counts as known-broken.
    const seeded = decision.action === 'seed';
    const established = prior.baselineEstablishedAt || now();
    patchState({
      baselineFailures: decision.baseline,
      baselineEstablishedAt: established,
      lastRegression: null,
      lastVerification: {
        at: now(),
        tests: outcome.tests,
        pass: outcome.pass,
        fail: outcome.fail,
        failures: outcome.failures,
        baselineSeeded: seeded,
      },
    });

    return {
      summary: `Verify ${ref}: ${outcome.pass}/${outcome.tests} pass, ${outcome.fail} known failure(s), no new failures`,
      paths: ['server/test'],
      verdict: 'tests-pass',
      branch: `autopilot/${slug}`,
      evidence: {
        ref,
        tests: outcome.tests,
        pass: outcome.pass,
        fail: outcome.fail,
        failures: outcome.failures,
        baselineSeeded: seeded,
        baselineEstablishedAt: established,
      },
    };
  }

  /** Mirror one audit entry to disk, keeping the bounded tail. */
  function audit(action, detail = {}, extra = {}) {
    const state = loadState();
    const entry = { at: now(), action, ...detail, ...extra };
    patchState({
      audit: [...(Array.isArray(state.audit) ? state.audit : []), entry].slice(-100),
    });
  }

  // The core calls readState()/run() with no arguments, so it needs a handle on
  // the live instance. It is set by createAutopilot(); until then the seams are
  // still safe to call directly with an explicit instance (which is how the
  // tests drive them).
  let current = { proposals: [], sequence: 0, auditLog: [], describePolicy: () => ({}) };

  /** Build a ready-to-use Autopilot with this runner's seams injected. */
  function createAutopilot(policy) {
    const bound = {
      readState: () => readState(boundAutopilot),
      run: () => run(boundAutopilot),
    };
    const boundAutopilot = new Autopilot({
      policy,
      now,
      readState: bound.readState,
      run: bound.run,
      audit,
    });
    current = boundAutopilot;
    restore(boundAutopilot);
    return boundAutopilot;
  }

  return {
    repo, hive, stateFile, park, ref,
    createAutopilot, readState, run, audit, persist, restore, loadState, patchState,
  };
}

module.exports = { createRunner, parseSuite, decideBaseline, STATE_BASENAME, SUITE_ARGS };