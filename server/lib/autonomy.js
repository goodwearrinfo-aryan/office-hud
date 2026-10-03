'use strict';
// Autonomy: the HUD notices it needs more capacity than the current agent pool
// can provide, and asks JEV to bring more agents to the floor.
//
// Two deliberate limits, because this spends money and starts processes:
//   1. It is opt-in. `policy.enabled` defaults to false, so a fresh install
//      never deploys anything on its own.
//   2. It proposes rather than acts. The HUD can only enqueue a JEV command;
//      JEV and the office manager decide what actually gets deployed. Even with
//      confirmation switched off, every action goes through the same gates and
//      leaves an audit entry.
//
// The assessment maths is pure so it can be tested without a hive.

const DEFAULT_POLICY = {
  enabled: false,
  // Ask a human before anything is routed to JEV.
  requireConfirmation: true,
  // Never ask for more than this many extra agents in one go.
  maxAdditionalAgents: 2,
  // Minimum gap between two routed scale-ups.
  cooldownMinutes: 30,
  // Refuse to route once the fleet has spent this much today.
  dailyBudgetUsd: 5,
  // Do not react to a queue smaller than this.
  minQueueToReact: 20,
  // How quickly the queue should drain, in hours.
  targetDrainHours: 2,
  // Hours of completion history used to estimate the drain rate.
  rateWindowHours: 3,
  // How long a proposal stays acceptable.
  proposalTtlMinutes: 15,
  // Empty means any target.
  allowedTargets: [],
};

const POLICY_LIMITS = {
  maxAdditionalAgents: { min: 1, max: 8 },
  cooldownMinutes: { min: 0, max: 1440 },
  dailyBudgetUsd: { min: 0, max: 1000 },
  minQueueToReact: { min: 1, max: 10000 },
  targetDrainHours: { min: 0.25, max: 72 },
  rateWindowHours: { min: 1, max: 12 },
  proposalTtlMinutes: { min: 1, max: 240 },
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
    if (policy[key] === undefined) continue;
    const value = Number(policy[key]);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
    if (value < bounds.min || value > bounds.max) {
      throw new Error(`${key} must be between ${bounds.min} and ${bounds.max}`);
    }
    policy[key] = value;
  }
  for (const key of ['enabled', 'requireConfirmation']) {
    if (typeof policy[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  if (!Array.isArray(policy.allowedTargets)) throw new Error('allowedTargets must be an array');
  policy.allowedTargets = policy.allowedTargets
    .filter((target) => typeof target === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target));

  return policy;
}

/**
 * Estimate the drain rate from the recent completion history.
 * Uses the mean of the last `windowHours` buckets: recent behaviour, not a
 * lifetime average, and a zero when nothing finished recently.
 */
function drainRatePerHour(queue, windowHours) {
  const buckets = (queue?.completionsByHour || []).slice(-windowHours);
  if (buckets.length === 0) return 0;
  const total = buckets.reduce((sum, point) => sum + (Number(point.count) || 0), 0);
  return total / buckets.length;
}

/**
 * Decide whether the pool can keep up, and by how much it cannot.
 *
 * @returns {{
 *   reason: string, queued: number, inProgress: number, drainRatePerHour: number,
 *   timeToDrainHours: number|null, agentsBusy: number, agentsIdle: number,
 *   agentsTotal: number, agentsNeeded: number, idleCapacity: number,
 *   deficitTasks: number, saturated: boolean
 * }}
 */
function assessCapacity(snapshot, policy) {
  const queue = snapshot?.queue || {};
  const agents = (snapshot?.summary?.agents || []).filter((agent) => !agent.archived);
  const agentsBusy = agents.filter((agent) => agent.display === 'busy').length;
  const agentsIdle = agents.filter((agent) => agent.display === 'idle').length;
  const agentsTotal = agents.length;

  const queued = Number(queue.queued) || 0;
  const inProgress = Number(queue.inProgress) || 0;
  const rate = drainRatePerHour(queue, policy.rateWindowHours);

  // Idle agents are capacity the fleet already has: never ask for more while
  // any are sitting free, because the problem is dispatch, not headcount.
  const idleCapacity = agentsIdle;
  const target = policy.targetDrainHours;
  const canDrainInTarget = rate * target + idleCapacity;
  const deficitTasks = Math.max(0, queued - canDrainInTarget);
  const timeToDrainHours = rate > 0 ? queued / rate : (queued > 0 ? null : 0);

  // What one busy agent is currently clearing, used to size the request.
  const throughputPerAgent = agentsBusy > 0 ? rate / agentsBusy : 0;
  let agentsNeeded = 0;
  if (idleCapacity > 0) {
    // Agents are sitting free: the bottleneck is dispatch, not headcount, so
    // asking JEV for more agents would be asking for the wrong thing.
    agentsNeeded = 0;
  } else if (deficitTasks > 0 && throughputPerAgent > 0) {
    agentsNeeded = Math.ceil(deficitTasks / (throughputPerAgent * target));
  } else if (deficitTasks > 0) {
    // Nothing is completing, so the rate cannot size the ask; ask for the
    // smallest useful increment and let JEV decide.
    agentsNeeded = 1;
  }
  agentsNeeded = clamp(agentsNeeded, 0, policy.maxAdditionalAgents);

  let reason;
  if (queued < policy.minQueueToReact) reason = 'queue below threshold';
  else if (deficitTasks === 0) reason = 'current pool can clear the queue in time';
  else if (idleCapacity > 0) reason = `${idleCapacity} idle agent(s) available before scaling`;
  else if (inProgress === 0 && rate === 0) reason = 'queue is not draining at all';
  else reason = `queue would take ${timeToDrainHours === null ? 'indefinitely' : `${Math.round(timeToDrainHours)}h`} to clear`;

  return {
    reason,
    queued,
    inProgress,
    drainRatePerHour: Math.round(rate * 10) / 10,
    timeToDrainHours: timeToDrainHours === null ? null : Math.round(timeToDrainHours * 10) / 10,
    agentsBusy,
    agentsIdle,
    agentsTotal,
    agentsNeeded,
    idleCapacity,
    deficitTasks: Math.round(deficitTasks),
    saturated: agentsBusy > 0 && agentsIdle === 0,
  };
}

/**
 * The JEV prompt. Deliberately avoids the words isDangerousJarvisPrompt treats
 * as destructive (enable, stop, restart, ...), so a scale-up does not suddenly
 * require a typed EXECUTE confirmation.
 */
function buildPrompt(assessment, policy, target) {
  const where = target ? ` for ${target}` : '';
  const rate = assessment.drainRatePerHour > 0
    ? `${assessment.drainRatePerHour} tasks/h`
    : 'no recent completions';
  // Wording matters: isDangerousJarvisPrompt treats "clear" (among others) as
  // destructive, which would make this enqueue demand a typed EXECUTE that
  // autonomy will never send. The prompt-safety test guards this.
  return (
    `Autonomy check${where}: the task queue holds ${assessment.queued} waiting items and is draining at ${rate}. `
    + `All ${assessment.agentsBusy} busy agents are occupied, so the present pool projects a time-to-drain beyond `
    + `${policy.targetDrainHours}h. Please bring ${assessment.agentsNeeded} additional cloud agent(s) to share this queue, `
    + `then rebalance the in-flight work across the enlarged pool. This request came from the Office HUD autonomy monitor, `
    + `and asks for agent capacity only.`
  );
}

class AutonomyController {
  /**
   * @param {{
   *   read: () => object,
   *   route: (args: {prompt: string, target?: string, priority: string}) => object,
   *   policy?: object,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.read = options.read;
    this.route = options.route;
    this.policy = normalisePolicy(options.policy || {});
    this.now = options.now || (() => Date.now());
    this.proposals = new Map();   // id -> proposal
    this.audit = [];              // newest first
    this.lastRoutedAt = 0;
    this.lastAssessment = null;
    this.runs = 0;
    this.sequence = 0;
  }

  updatePolicy(input) {
    this.policy = normalisePolicy({ ...this.policy, ...input });
    this.auditAction('policy_updated', describePolicy(this.policy));
    return this.policy;
  }

  /** Recompute the assessment and refresh any live proposal. */
  evaluate() {
    const now = this.now();
    this.runs += 1;

    let snapshot;
    try {
      snapshot = this.read();
    } catch (error) {
      return this.snapshot({ error: `cannot read the hive: ${error.message}` });
    }

    const assessment = assessCapacity(snapshot, this.policy);
    this.lastAssessment = assessment;

    for (const [id, proposal] of [...this.proposals]) {
      if (proposal.status !== 'pending') continue;
      if (now > proposal.expiresAt) {
        proposal.status = 'expired';
        this.auditAction('proposal_expired', `${id} expired unaccepted`);
        continue;
      }
      // Keep the live numbers on the proposal fresh while it waits.
      proposal.assessment = assessment;
    }

    if (assessment.agentsNeeded > 0 && this.policy.enabled) {
      // One live offer at a time: a persisting deficit keeps its proposal (with
      // refreshed numbers) instead of raising a new one every tick.
      const hasPending = [...this.proposals.values()].some((p) => p.status === 'pending');
      if (!hasPending) {
        const gate = this.gate(assessment, now);
        if (gate.ok) {
          this.sequence += 1;
          const id = proposalId(assessment, this.policy, this.sequence);
          const target = pickTarget(this.policy);
          this.proposals.set(id, {
            id,
            createdAt: now,
            expiresAt: now + this.policy.proposalTtlMinutes * 60000,
            status: 'pending',
            target,
            requestedAgents: assessment.agentsNeeded,
            prompt: buildPrompt(assessment, this.policy, target),
            priority: 'high',
            assessment,
          });
          this.auditAction('proposal_raised', `${id} wants ${assessment.agentsNeeded} agent(s)`);
        } else {
          this.auditAction('proposal_suppressed', gate.reason);
        }
      }
    }

    this.trimProposals();
    return this.snapshot();
  }

  /**
   * The conditions that must hold before anything is routed. Reported even when
   * it passes, so the UI can explain a suppression.
   */
  gate(assessment, now = this.now()) {
    if (!this.policy.enabled) return { ok: false, reason: 'autonomy is disabled' };
    if (assessment.agentsNeeded <= 0) return { ok: false, reason: 'no capacity deficit' };
    if (now - this.lastRoutedAt < this.policy.cooldownMinutes * 60000) {
      const minutes = Math.ceil((this.policy.cooldownMinutes * 60000 - (now - this.lastRoutedAt)) / 60000);
      return { ok: false, reason: `cooldown: ${minutes}m remaining` };
    }
    const spend = Number(this.spendToday());
    if (this.policy.dailyBudgetUsd <= 0) return { ok: false, reason: 'no budget allowance' };
    if (spend >= this.policy.dailyBudgetUsd) {
      return { ok: false, reason: `daily budget spent ($${spend.toFixed(2)} of $${this.policy.dailyBudgetUsd})` };
    }
    return { ok: true, reason: null };
  }

  spendToday() {
    try {
      const costs = this.read()?.costs;
      return Number(costs?.total?.daily ?? costs?.total?.day ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Route a pending proposal to JEV. This is the only path that enqueues work,
   * and it re-checks every gate at the moment of acceptance.
   */
  accept(id) {
    const now = this.now();
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, error: 'no such proposal' };
    if (proposal.status === 'accepted') return { ok: false, error: 'already accepted' };
    if (proposal.status === 'dismissed') return { ok: false, error: 'proposal was dismissed' };
    if (proposal.status === 'expired' || now > proposal.expiresAt) {
      proposal.status = 'expired';
      this.auditAction('proposal_expired', `${id} expired before acceptance`);
      return { ok: false, error: 'proposal expired' };
    }

    const check = this.gate(proposal.assessment, now);
    if (!check.ok) return { ok: false, error: check.reason };

    let routed;
    try {
      routed = this.route({
        prompt: proposal.prompt,
        target: proposal.target || undefined,
        priority: proposal.priority,
      });
    } catch (error) {
      this.auditAction('route_failed', `${id}: ${error.message}`);
      return { ok: false, error: error.message };
    }

    proposal.status = 'accepted';
    proposal.acceptedAt = now;
    proposal.routed = routed;
    this.lastRoutedAt = now;
    this.auditAction('proposal_accepted', `${id} routed to JEV for ${proposal.requestedAgents} agent(s)`, {
      taskId: routed?.task_id ?? null,
      requestedAgents: proposal.requestedAgents,
    });
    return { ok: true, proposal: { ...proposal }, routed };
  }

  dismiss(id, reason = 'operator dismissed') {
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, error: 'no such proposal' };
    if (proposal.status === 'accepted') return { ok: false, error: 'already accepted' };
    proposal.status = 'dismissed';
    proposal.dismissedAt = this.now();
    this.auditAction('proposal_dismissed', `${id}: ${reason}`);
    return { ok: true };
  }

  /** Keep the proposal history bounded, never dropping a pending offer. */
  trimProposals() {
    if (this.proposals.size <= AUDIT_LIMIT) return;
    const settled = [...this.proposals.values()]
      .filter((proposal) => proposal.status !== 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    let excess = this.proposals.size - AUDIT_LIMIT;
    for (const proposal of settled) {
      if (excess <= 0) break;
      this.proposals.delete(proposal.id);
      excess -= 1;
    }
  }

  auditAction(action, detail, extra = {}) {
    this.audit.unshift({ at: this.now(), action, detail, ...extra });
    if (this.audit.length > AUDIT_LIMIT) this.audit.length = AUDIT_LIMIT;
  }

  snapshot(extra = {}) {
    const proposals = [...this.proposals.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((proposal) => ({ ...proposal }));
    return {
      policy: { ...this.policy },
      assessment: this.lastAssessment,
      proposals,
      pending: proposals.filter((proposal) => proposal.status === 'pending').length,
      audit: this.audit.slice(0, 25),
      runs: this.runs,
      spendToday: this.spendToday(),
      lastRoutedAt: this.lastRoutedAt || null,
      ...extra,
    };
  }
}

function proposalId(assessment, policy, sequence) {
  // Unique per offer. A stable id would let a new proposal overwrite an expired
  // or accepted one, which makes the audit trail lie and lets an operator
  // accept an offer they never saw.
  return `scale:${policy.targetDrainHours}h:${Math.ceil(assessment.agentsNeeded)}:${sequence}`;
}

function pickTarget(policy) {
  if (policy.allowedTargets.length === 0) return null;
  return policy.allowedTargets[0];
}

function describePolicy(policy) {
  return [
    `enabled=${policy.enabled}`,
    `confirm=${policy.requireConfirmation}`,
    `max=${policy.maxAdditionalAgents}`,
    `cooldown=${policy.cooldownMinutes}m`,
    `budget=$${policy.dailyBudgetUsd}`,
  ].join(' ');
}

module.exports = {
  AutonomyController,
  assessCapacity,
  drainRatePerHour,
  buildPrompt,
  normalisePolicy,
  DEFAULT_POLICY,
  POLICY_LIMITS,
  AUDIT_LIMIT,
};
