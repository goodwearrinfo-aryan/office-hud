'use strict';
// Autopilot: proposes improvements to this repo, one reviewable branch at a
// time. It is deliberately modelled on lib/autonomy.js, which already encodes
// the house rule for unattended action — opt-in, propose rather than act,
// budget-capped, cooled-down, audited — and extends it with the gates that
// specifically make unattended *code* edits survivable.
//
// The non-negotiable limits, because this writes to a working tree that other
// sessions share:
//
//   1. It never edits the shared working tree. Every attempt is applied in a
//      dedicated git worktree on its own branch, so an in-flight edit by anyone
//      else is structurally unreachable rather than merely unlikely.
//   2. It never merges to main and never force-pushes. A proposal is a branch
//      plus evidence; landing it is a human's decision.
//   3. Nothing is proposed unless the full suite passes afterwards. A change
//      that breaks tests is discarded, not queued.
//   4. Paths that belong to another session, or to live trading, are refused
//      outright. The protected list is checked before any file is touched.
//   5. It is opt-in and rate-limited, so a misconfigured loop cannot produce a
//      hundred branches overnight.
//
// Nothing here executes a proposal. It proposes; a human lands it.

const DEFAULT_POLICY = {
  // Off by default: a fresh install never writes code on its own.
  enabled: false,
  // Hard ceiling on open proposals. Oldest are trimmed first.
  maxOpenProposals: 3,
  // Minimum gap between two proposals.
  cooldownMinutes: 60,
  // Longest a proposal stays acceptable before it is trimmed.
  proposalTtlHours: 72,
  // Refuse to propose when the working tree is not clean enough to reason about.
  requireCleanWorktree: true,
  // Paths the autopilot may never touch, beyond the always-protected set.
  // Repo-relative globs; `*` matches within one segment.
  additionalBlocked: [],
  // Never propose changes to these regardless of any other setting.
  // Live execution and anything that can move money stays off limits.
  alwaysProtected: [
    'web/src/**',
    'server/lib/terminal/**',
    'services/**',
    'launchd/**',
    'config.yaml',
    '*.plist',
    '.env*',
  ],
  // Files owned by other sessions right now. The operator refreshes these; the
  // autopilot refuses them even if something else would allow them.
  sessionOwned: [
    'web/src/App.tsx',
    'web/src/index.css',
    'web/src/components/Charts.tsx',
    'web/src/components/ExecutiveHQ.tsx',
    'web/src/components/ExportButton.tsx',
    'web/src/components/GlobalSearch.tsx',
    'web/src/components/GodConsole.tsx',
    'web/src/utils/export.ts',
  ],
};

const POLICY_LIMITS = {
  maxOpenProposals: { min: 0, max: 10 },
  cooldownMinutes: { min: 1, max: 10080 },
  proposalTtlHours: { min: 1, max: 720 },
};

const AUDIT_LIMIT = 100;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Validate and fill a partial policy. Throws on a nonsensical value. */
function normalisePolicy(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('policy must be an object');
  }
  const policy = { ...DEFAULT_POLICY, ...input };

  for (const [key, bounds] of Object.entries(POLICY_LIMITS)) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`policy.${key} must be a number`);
    }
    policy[key] = clamp(Math.round(value), bounds.min, bounds.max);
  }

  if (!Array.isArray(policy.alwaysProtected) || !Array.isArray(policy.additionalBlocked)
    || !Array.isArray(policy.sessionOwned)) {
    throw new Error('protected path lists must be arrays');
  }
  return policy;
}

/** Translate one glob to an anchored regular expression. */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * True when `path` may be edited under `policy`.
 *
 * Both an allow and a deny answer are returned because the caller should be able
 * to say *why* a proposal was refused rather than just that it was.
 */
function checkPath(path, policy) {
  if (typeof path !== 'string' || path.length === 0) {
    return { allowed: false, reason: 'no path given' };
  }
  if (path.startsWith('/') || path.includes('..')) {
    return { allowed: false, reason: 'path must be repo-relative' };
  }
  for (const owned of policy.sessionOwned) {
    if (path === owned || path.startsWith(`${owned}/`)) {
      return { allowed: false, reason: `owned by another session: ${owned}` };
    }
  }
  for (const glob of [...policy.alwaysProtected, ...policy.additionalBlocked]) {
    if (globToRegExp(glob).test(path)) {
      return { allowed: false, reason: `protected path matches ${glob}` };
    }
  }
  return { allowed: true, reason: 'ok' };
}

/** Every protected/refused path in a proposed file list, with reasons. */
function screenPaths(paths, policy) {
  const blocked = [];
  const allowed = [];
  for (const path of paths) {
    const verdict = checkPath(path, policy);
    if (verdict.allowed) allowed.push(path);
    else blocked.push({ path, reason: verdict.reason });
  }
  return { allowed, blocked };
}

/** Everything a proposal must carry to be considered. */
function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') {
    return { ok: false, errors: ['proposal must be an object'] };
  }
  if (typeof proposal.summary !== 'string' || proposal.summary.trim().length < 8) {
    errors.push('summary must describe the change in at least 8 characters');
  }
  if (!Array.isArray(proposal.paths) || proposal.paths.length === 0) {
    errors.push('paths must list at least one file');
  }
  if (!['tests-pass', 'tests-fail'].includes(proposal.verdict)) {
    errors.push("verdict must be 'tests-pass' or 'tests-fail'");
  }
  if (proposal.verdict === 'tests-fail') {
    // A change that breaks the suite is not a proposal; it is discarded.
    errors.push('a change that fails tests is discarded, not proposed');
  }
  if (typeof proposal.branch !== 'string' || !/^autopilot\/[a-z0-9._-]+$/i.test(proposal.branch)) {
    errors.push("branch must look like 'autopilot/<slug>'");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The gate. Returns `{ allowed, reason }` and is pure, so every refusal path is
 * testable without touching a repository.
 */
function gate(state, policy, now = Date.now()) {
  if (!policy.enabled) return { allowed: false, reason: 'autopilot is disabled' };
  if (policy.requireCleanWorktree && state.dirtyFiles > 0) {
    return {
      allowed: false,
      reason: `working tree has ${state.dirtyFiles} uncommitted change(s); refusing to reason about it`,
    };
  }
  if (state.openProposals.length >= policy.maxOpenProposals) {
    return {
      allowed: false,
      reason: `already at the ceiling of ${policy.maxOpenProposals} open proposal(s)`,
    };
  }
  const last = state.lastProposalAt;
  if (typeof last === 'number' && last > 0) {
    const waitMs = policy.cooldownMinutes * 60_000;
    const elapsed = now - last;
    if (elapsed < waitMs) {
      const mins = Math.ceil((waitMs - elapsed) / 60_000);
      return { allowed: false, reason: `cooling down, ${mins} minute(s) until the next proposal` };
    }
  }
  return { allowed: true, reason: 'ok' };
}

/** Drop proposals past their TTL, oldest first. */
function trimProposals(proposals, policy, now = Date.now()) {
  const ttlMs = policy.proposalTtlHours * 3_600_000;
  const live = proposals.filter((p) => now - p.createdAt < ttlMs);
  const liveSorted = [...live].sort((a, b) => a.createdAt - b.createdAt);
  return liveSorted.slice(-policy.maxOpenProposals);
}

class Autopilot {
  /**
   * @param {object} options
   * @param {() => number} [options.now] injectable clock, so gates are testable
   * @param {() => Promise<object>} [options.readState] supplies worktree/proposal state
   * @param {(proposal: object) => Promise<object>} [options.run] produces one proposal
   * @param {(action: string, detail: object) => void} [options.audit]
   */
  constructor(options = {}) {
    this.policy = normalisePolicy(options.policy);
    this.now = options.now ?? (() => Date.now());
    this.readState = options.readState ?? (async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }));
    this.run = options.run ?? (async () => null);
    this.proposals = [];
    this.auditLog = [];
    this.sequence = 0;
    if (typeof options.audit === 'function') this.audit = options.audit;
  }

  updatePolicy(input) {
    this.policy = normalisePolicy({ ...this.policy, ...input });
    return this.describePolicy();
  }

  auditAction(action, detail, extra = {}) {
    this.auditLog.push({ at: this.now(), action, ...detail, ...extra });
    if (this.auditLog.length > AUDIT_LIMIT) this.auditLog.shift();
  }

  /**
   * Consider one improvement. Returns a verdict describing what happened; it
   * never throws for an ordinary refusal, because a refusal is the expected
   * outcome most of the time.
   */
  async tick() {
    const state = await this.readState();
    const verdict = gate(state, this.policy, this.now());
    if (!verdict.allowed) {
      this.auditAction('tick-refused', { reason: verdict.reason });
      return { ok: false, ...verdict };
    }

    let candidate;
    try {
      candidate = await this.run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.auditAction('run-failed', { reason });
      return { ok: false, reason: `proposal run failed: ${reason}` };
    }
    if (!candidate) {
      this.auditAction('no-proposal', { reason: 'runner returned nothing' });
      return { ok: false, reason: 'no improvement proposed' };
    }

    const check = validateProposal(candidate);
    if (!check.ok) {
      this.auditAction('proposal-rejected', { reason: check.errors.join('; ') });
      return { ok: false, reason: check.errors.join('; ') };
    }

    const screened = screenPaths(candidate.paths, this.policy);
    if (screened.blocked.length > 0) {
      // Any protected path refuses the whole proposal. Partial application is
      // how an unattended edit ends up half-landed.
      const reason = screened.blocked
        .map((b) => `${b.path} (${b.reason})`)
        .join('; ');
      this.auditAction('paths-blocked', { reason, paths: screened.paths ?? candidate.paths });
      return { ok: false, reason: `refused: ${reason}` };
    }

    this.sequence += 1;
    const proposal = {
      ...candidate,
      id: `ap-${this.sequence}`,
      createdAt: this.now(),
      state: 'open',
    };
    this.proposals = trimProposals([...this.proposals, proposal], this.policy, this.now());
    this.auditAction('proposal-opened', { id: proposal.id, branch: proposal.branch, paths: screened.allowed });
    return { ok: true, proposal, reason: 'proposal opened' };
  }

  /** Mark a proposal landed by a human. The autopilot never does this itself. */
  land(id, note = 'landed by operator') {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.state !== 'open') throw new Error(`proposal ${id} is ${proposal.state}`);
    proposal.state = 'landed';
    proposal.landedAt = this.now();
    proposal.note = note;
    this.auditAction('proposal-landed', { id, note });
    return proposal;
  }

  /** Reject a proposal without landing it. */
  dismiss(id, reason = 'dismissed by operator') {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error(`unknown proposal ${id}`);
    if (proposal.state !== 'open') throw new Error(`proposal ${id} is ${proposal.state}`);
    proposal.state = 'dismissed';
    proposal.dismissedAt = this.now();
    proposal.note = reason;
    this.auditAction('proposal-dismissed', { id, reason });
    return proposal;
  }

  describePolicy() {
    return { ...this.policy };
  }

  snapshot(extra = {}) {
    return {
      enabled: this.policy.enabled,
      policy: this.describePolicy(),
      proposals: this.proposals.map((p) => ({ ...p })),
      audit: this.auditLog.slice(-20),
      ...extra,
    };
  }
}

function proposalId(sequence, branch) {
  return `ap-${sequence}:${branch}`;
}

module.exports = {
  Autopilot,
  DEFAULT_POLICY,
  normalisePolicy,
  checkPath,
  screenPaths,
  validateProposal,
  gate,
  trimProposals,
  proposalId,
  globToRegExp,
};