'use strict';
// Autonomy: the capacity maths, the policy gates, and the fact that nothing
// reaches JEV without passing every gate.
//
// The route function is a spy, not a mock of the module under test: these tests
// assert on what the controller *asks* for, which is the part that matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutonomyController,
  assessCapacity,
  drainRatePerHour,
  buildPrompt,
  normalisePolicy,
  DEFAULT_POLICY,
  AUDIT_LIMIT,
} = require('../lib/autonomy');
const { isDangerousJarvisPrompt } = require('../index.js');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const hoursAgo = (n) => new Date(NOW - n * 3600000).toISOString();

function snapshot(overrides = {}) {
  const queue = {
    queued: 0,
    inProgress: 0,
    total: 0,
    completionsByHour: [{ hour: NOW - 3 * 3600000, count: 0 }, { hour: NOW - 2 * 3600000, count: 0 }, { hour: NOW - 3600000, count: 0 }],
    ...overrides.queue,
  };
  return {
    queue,
    summary: { agents: overrides.agents || [] },
    costs: { total: { daily: overrides.dailyUsd ?? 0 } },
  };
}

const agent = (over = {}) => ({ id: 'a', display: 'idle', archived: false, ...over });

function makeController(policy = {}, options = {}) {
  const calls = [];
  let clock = NOW;
  const controller = new AutonomyController({
    read: options.read || (() => snapshot(options.snapshot || {})),
    route: (args) => {
      calls.push(args);
      if (options.routeThrows) throw new Error(options.routeThrows);
      return { task_id: `jarvis-${calls.length}`, routed: true };
    },
    policy,
    now: () => clock,
  });
  return {
    controller,
    calls,
    advance: (ms) => { clock += ms; },
  };
}

// ------------------------------------------------------------------ maths

test('the drain rate is the mean of the recent completion buckets', () => {
  // A window of 3 ignores everything older than the last three buckets, so the
  // lifetime total never dilutes a recent stall.
  assert.equal(drainRatePerHour({ completionsByHour: [{ count: 500 }, { count: 3 }, { count: 6 }, { count: 9 }] }, 3), 6);
  assert.equal(drainRatePerHour({ completionsByHour: [{ count: 1 }, { count: 2 }] }, 3), 1.5);
  assert.equal(drainRatePerHour({ completionsByHour: [] }, 3), 0);
  assert.equal(drainRatePerHour({}, 3), 0);
});

test('a small queue with a healthy pool needs nothing', () => {
  const result = assessCapacity(snapshot({
    queue: { queued: 3, inProgress: 2, completionsByHour: [{ count: 10 }, { count: 10 }, { count: 10 }] },
    agents: [agent({ display: 'busy' })],
  }), DEFAULT_POLICY);
  assert.equal(result.agentsNeeded, 0);
  assert.match(result.reason, /below threshold|current pool/);
});

test('idle agents are used before asking for more', () => {
  const result = assessCapacity(snapshot({
    queue: { queued: 40, inProgress: 1, completionsByHour: [{ count: 2 }, { count: 2 }, { count: 2 }] },
    agents: [agent({ display: 'busy' }), agent({ id: 'b', display: 'idle' }), agent({ id: 'c', display: 'idle' })],
  }), DEFAULT_POLICY);
  assert.equal(result.agentsIdle, 2);
  assert.equal(result.idleCapacity, 2);
  assert.equal(result.agentsNeeded, 0, 'must not scale while agents sit idle');
  assert.match(result.reason, /idle agent/);
  assert.equal(result.deficitTasks, 34, 'the backlog is real, it is just not a headcount problem');
});

test('a saturated pool behind target asks for a bounded number of agents', () => {
  const result = assessCapacity(snapshot({
    // 60 queued, draining at 3/h, so 2h of work is 6 tasks: a 54-task deficit.
    queue: { queued: 60, inProgress: 3, completionsByHour: [{ count: 3 }, { count: 3 }, { count: 3 }] },
    agents: [agent({ display: 'busy' }), agent({ id: 'b', display: 'busy' }), agent({ id: 'c', display: 'busy' })],
  }), DEFAULT_POLICY);
  assert.equal(result.saturated, true);
  assert.equal(result.drainRatePerHour, 3);
  assert.equal(result.deficitTasks, 54);
  // Per agent: 3/h over 3 busy agents = 1/h each, so 54 tasks in 2h needs 27
  // agents — clamped to the policy ceiling.
  assert.equal(result.agentsNeeded, DEFAULT_POLICY.maxAdditionalAgents);
});

test('a queue that is not draining at all still asks for the minimum', () => {
  const result = assessCapacity(snapshot({
    queue: { queued: 50, inProgress: 2, completionsByHour: [{ count: 0 }, { count: 0 }, { count: 0 }] },
    agents: [agent({ display: 'busy' })],
  }), DEFAULT_POLICY);
  assert.equal(result.drainRatePerHour, 0);
  assert.equal(result.timeToDrainHours, null, 'indefinite is null, not Infinity');
  assert.equal(result.agentsNeeded, 1);
  assert.match(result.reason, /not draining|indefinitely/);
});

test('archived agents do not count as capacity', () => {
  const result = assessCapacity(snapshot({
    queue: { queued: 40, inProgress: 1, completionsByHour: [{ count: 1 }, { count: 1 }, { count: 1 }] },
    agents: [agent({ display: 'busy' }), agent({ id: 'gone', display: 'idle', archived: true })],
  }), DEFAULT_POLICY);
  assert.equal(result.agentsTotal, 1);
  assert.equal(result.agentsIdle, 0);
});

test('the policy ceiling bounds the ask', () => {
  const result = assessCapacity(snapshot({
    queue: { queued: 500, inProgress: 5, completionsByHour: [{ count: 1 }, { count: 1 }, { count: 1 }] },
    agents: [agent({ display: 'busy' })],
  }), normalisePolicy({ maxAdditionalAgents: 3 }));
  assert.equal(result.agentsNeeded, 3);
});

// ------------------------------------------------------------------ policy

test('a fresh policy is off and asks for confirmation', () => {
  assert.equal(DEFAULT_POLICY.enabled, false);
  assert.equal(DEFAULT_POLICY.requireConfirmation, true);
});

test('policy validation rejects nonsense and clamps nothing silently', () => {
  assert.throws(() => normalisePolicy({ maxAdditionalAgents: 99 }), /maxAdditionalAgents must be between/);
  assert.throws(() => normalisePolicy({ cooldownMinutes: -1 }), /cooldownMinutes/);
  assert.throws(() => normalisePolicy({ enabled: 'yes' }), /enabled must be a boolean/);
  assert.throws(() => normalisePolicy({ allowedTargets: 'f5' }), /allowedTargets must be an array/);
  assert.throws(() => normalisePolicy(null), /policy must be an object/);
  assert.deepEqual(normalisePolicy({ allowedTargets: ['f5', 'bad id!', 'f6'] }).allowedTargets, ['f5', 'f6']);
});

test('a disabled controller never proposes and never routes', () => {
  const { controller, calls } = makeController({ enabled: false }, {
    snapshot: {
      queue: { queued: 90, inProgress: 3, completionsByHour: [{ count: 1 }, { count: 1 }, { count: 1 }] },
      agents: [agent({ display: 'busy' })],
    },
  });
  const state = controller.evaluate();
  assert.equal(state.pending, 0);
  assert.equal(state.assessment.agentsNeeded > 0, true, 'the deficit is still reported');
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ proposals

function saturatedSnapshot() {
  return {
    queue: { queued: 80, inProgress: 4, completionsByHour: [{ count: 2 }, { count: 2 }, { count: 2 }] },
    agents: [agent({ display: 'busy' }), agent({ id: 'b', display: 'busy' })],
  };
}

test('an enabled controller raises one proposal for a persisting deficit', () => {
  const { controller, calls } = makeController({ enabled: true }, { snapshot: saturatedSnapshot() });
  const first = controller.evaluate();
  assert.equal(first.pending, 1);
  const proposal = first.proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.ok(proposal.requestedAgents >= 1);

  controller.evaluate();
  controller.evaluate();
  assert.equal(controller.snapshot().pending, 1, 'a persisting deficit must not spam proposals');
  assert.equal(calls.length, 0, 'raising a proposal routes nothing');
});

test('a proposal is accepted and routed to JEV exactly once', () => {
  const { controller, calls } = makeController({ enabled: true }, { snapshot: saturatedSnapshot() });
  const id = controller.evaluate().proposals[0].id;

  const first = controller.accept(id);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt.length > 3, true);
  assert.equal(calls[0].priority, 'high');

  const second = controller.accept(id);
  assert.equal(second.ok, false, 'a proposal cannot be routed twice');
  assert.match(second.error, /already accepted/);
  assert.equal(calls.length, 1);
});

test('dismissing a proposal prevents it being routed', () => {
  const { controller, calls } = makeController({ enabled: true }, { snapshot: saturatedSnapshot() });
  const id = controller.evaluate().proposals[0].id;
  assert.equal(controller.dismiss(id).ok, true);
  assert.equal(controller.accept(id).ok, false);
  assert.match(controller.accept(id).error, /dismissed/);
  assert.equal(calls.length, 0);
});

test('a proposal expires rather than lingering as an acceptable offer', () => {
  const { controller, calls, advance } = makeController(
    { enabled: true, proposalTtlMinutes: 5 },
    { snapshot: saturatedSnapshot() }
  );
  const id = controller.evaluate().proposals[0].id;
  advance(6 * 60000);
  controller.evaluate();
  const result = controller.accept(id);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
  assert.equal(calls.length, 0);
});

test('the cooldown suppresses a second scale-up', () => {
  const snapshotA = saturatedSnapshot();
  const { controller, calls, advance } = makeController(
    { enabled: true, cooldownMinutes: 30 },
    { read: () => snapshotA }
  );
  const id = controller.evaluate().proposals[0].id;
  assert.equal(controller.accept(id).ok, true);
  assert.equal(calls.length, 1);

  // A new, different deficit immediately after: still inside the cooldown.
  snapshotA.queue.queued = 400;
  advance(60000);
  const after = controller.evaluate();
  assert.equal(after.pending, 0, 'no proposal during the cooldown');
  assert.ok(after.audit.some((entry) => entry.detail.includes('cooldown')), 'the suppression is explained');
  assert.equal(controller.accept('no-such-proposal').ok, false);
  assert.equal(calls.length, 1, 'nothing was routed during the cooldown');
});

test('after the cooldown a new deficit can be routed again', () => {
  const snap = saturatedSnapshot();
  const { controller, calls, advance } = makeController({ enabled: true, cooldownMinutes: 30 }, { read: () => snap });
  const id = controller.evaluate().proposals[0].id;
  controller.accept(id);
  snap.queue.queued = 400;
  advance(31 * 60000);
  const state = controller.evaluate();
  assert.equal(state.pending, 1);
  assert.equal(controller.accept(state.proposals[0].id).ok, true);
  assert.equal(calls.length, 2);
});

test('the daily budget blocks routing once it is spent', () => {
  const { controller, calls } = makeController(
    { enabled: true, dailyBudgetUsd: 5 },
    { read: () => snapshot({ ...saturatedSnapshot(), dailyUsd: 5.5 }) }
  );
  const state = controller.evaluate();
  assert.equal(state.pending, 0, 'no proposal while over budget');
  assert.ok(state.audit.some((entry) => entry.detail.includes('daily budget')));
  assert.equal(calls.length, 0);
});

test('a routing failure is reported and audited, not swallowed', () => {
  const { controller, calls } = makeController(
    { enabled: true },
    { read: () => snapshot(saturatedSnapshot()), routeThrows: 'hive lock held' }
  );
  const id = controller.evaluate().proposals[0].id;
  const result = controller.accept(id);
  assert.equal(result.ok, false);
  assert.match(result.error, /hive lock held/);
  assert.ok(controller.snapshot().audit.some((entry) => entry.action === 'route_failed'));
});

test('a reader that throws does not crash the controller', () => {
  const { controller } = makeController({ enabled: true }, { read: () => { throw new Error('hive gone'); } });
  const state = controller.evaluate();
  assert.match(state.error, /hive gone/);
  assert.equal(state.pending, 0);
});

test('every action leaves an audit entry, and the log stays bounded', () => {
  const { controller, advance } = makeController({ enabled: true }, { snapshot: saturatedSnapshot() });
  const id = controller.evaluate().proposals[0].id;
  controller.accept(id);
  advance(31000000);
  controller.updatePolicy({ maxAdditionalAgents: 3 });

  const audit = controller.snapshot().audit;
  const actions = audit.map((entry) => entry.action);
  assert.ok(actions.includes('proposal_raised'));
  assert.ok(actions.includes('proposal_accepted'));
  assert.ok(actions.includes('policy_updated'));
  const accepted = audit.find((entry) => entry.action === 'proposal_accepted');
  assert.ok(accepted.taskId, 'an accepted action records the task it created');
  assert.ok(audit.length <= 25, 'the exposed audit tail is bounded');

  for (let i = 0; i < AUDIT_LIMIT + 50; i += 1) controller.auditAction('noise', `entry ${i}`);
  assert.equal(controller.audit.length, AUDIT_LIMIT);
});

test('the proposal prompt is safe to route without a typed confirmation', () => {
  // isDangerousJarvisPrompt is the server's own rule: if a prompt trips it, the
  // enqueue demands typeConfirmation:'EXECUTE', which autonomy will never send.
  for (const assessment of [
    assessCapacity(snapshot({ queue: { queued: 80, inProgress: 4, completionsByHour: [{ count: 2 }, { count: 2 }, { count: 2 }] }, agents: [agent({ display: 'busy' })] }), DEFAULT_POLICY),
    assessCapacity(snapshot({ queue: { queued: 50, inProgress: 2, completionsByHour: [{ count: 0 }, { count: 0 }, { count: 0 }] }, agents: [agent({ display: 'busy' })] }), DEFAULT_POLICY),
  ]) {
    for (const target of [null, 'f9']) {
      const prompt = buildPrompt(assessment, DEFAULT_POLICY, target);
      assert.equal(isDangerousJarvisPrompt(prompt), false, `prompt tripped the danger rule: ${prompt}`);
      assert.ok(prompt.length >= 3 && prompt.length <= 2000, 'prompt must fit the enqueue contract');
    }
  }
});

test('an allowed target is carried into the prompt and the route', () => {
  const { controller, calls } = makeController(
    { enabled: true, allowedTargets: ['f9'] },
    { snapshot: saturatedSnapshot() }
  );
  const id = controller.evaluate().proposals[0].id;
  assert.match(controller.snapshot().proposals[0].prompt, /for f9/);
  controller.accept(id);
  assert.equal(calls[0].target, 'f9');
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
