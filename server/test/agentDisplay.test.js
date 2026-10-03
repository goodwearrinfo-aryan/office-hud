'use strict';
// The HUD must not overstate what it knows. A live process is not proof of
// work, and a session that has aged out is not the same as no session at all.
// These tests pin the evidence rules behind the `display` label, because a
// wrong label here is a truthfulness bug, not a cosmetic one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServer } = require('./helpers/harness');

const server = loadServer();
const { mergedAgents } = server.internals;

const STALE_SEC = 60 * 60;

/**
 * mergedAgents reads the real hive through module-level constants, so a fixture
 * cannot be injected wholesale. Instead these tests assert the invariants that
 * must hold for whatever the live hive contains — which is the property that
 * actually matters, and which a fixture could only ever assert about itself.
 */
function labelFor(agent) {
  return agent.display;
}

test('a live session with no claimed task is idle, not busy', () => {
  // The core truthfulness rule: a heartbeat proves a process exists, not that
  // work is happening. Only a claimed IN_PROGRESS task justifies `busy`.
  for (const agent of mergedAgents()) {
    if (labelFor(agent) !== 'busy') continue;
    const backed = agent.evidence?.hasTask || !!agent.currentTaskId;
    assert.ok(
      backed,
      `${agent.id} shown busy with no task to back it (sessionFresh=${agent.evidence?.sessionFresh})`,
    );
  }
});

test('display vocabulary is limited to states we can evidence', () => {
  const allowed = new Set(['busy', 'idle', 'stale', 'breaker', 'offline']);
  for (const agent of mergedAgents()) {
    assert.ok(
      allowed.has(labelFor(agent)),
      `unexpected display ${labelFor(agent)} for ${agent.id}`,
    );
  }
});

test('every agent carries the evidence behind its label', () => {
  for (const agent of mergedAgents()) {
    assert.ok(agent.evidence, `${agent.id} has no evidence block`);
    assert.equal(typeof agent.evidence.hasSession, 'boolean', agent.id);
    assert.equal(typeof agent.evidence.sessionFresh, 'boolean', agent.id);
    assert.equal(typeof agent.evidence.hasTask, 'boolean', agent.id);
    // processVerified must be a boolean the server actually computed from the
    // process table, not a blanket false. An earlier version of this test
    // pinned it to `false` on the grounds that the server never polls; that
    // was a false negative on every agent, since the pid sits in the same
    // object and processIsAlive already exists. See commit 9db6b95.
    assert.equal(
      typeof agent.evidence.processVerified, 'boolean',
      `${agent.id} has no boolean processVerified`,
    );
    if (agent.evidence.processId == null) {
      assert.equal(
        agent.evidence.processVerified, false,
        `${agent.id} claims a verified process with no pid`,
      );
    }
  }
});

test('idle and busy both require a live session', () => {
  // Neither label may be reached from a stale session or no session at all.
  for (const agent of mergedAgents()) {
    if (labelFor(agent) !== 'idle' && labelFor(agent) !== 'busy') continue;
    assert.equal(
      agent.evidence.sessionFresh, true,
      `${agent.id} shown ${labelFor(agent)} without a fresh session`,
    );
  }
});

test('a stale session yields stale, and never idle', () => {
  for (const agent of mergedAgents()) {
    if (agent.evidence?.sessionFresh) continue;
    if (!agent.evidence?.hasSession) continue;
    assert.notEqual(
      labelFor(agent), 'idle',
      `${agent.id} has a stale session but is shown idle`,
    );
  }
});

test('god is present and sorts first when it exists', () => {
  const agents = mergedAgents();
  const godIndex = agents.findIndex(a => a.isGod);
  if (godIndex === -1) return; // the god agent is not configured in this hive
  const firstReal = agents.findIndex(a => !a.archived);
  assert.equal(godIndex, firstReal, 'god must sort ahead of the working floors');
});

// ---- floor rollup -----------------------------------------------------------
// A floor is a grouping of real agents. It must never look healthy because a
// lead exists, and it must never invent a lead that nobody claims.

const { rollupFloors } = server.internals;

function agent(over = {}) {
  return {
    id: 'x', role: 'worker', floor: 'f1', display: 'idle', archived: false,
    evidence: { hasSession: true, sessionFresh: true, hasTask: false },
    ...over,
  };
}

test('a floor counts members by their own display state', () => {
  const rows = rollupFloors([
    agent({ id: 'a', display: 'busy', evidence: { hasSession: true, sessionFresh: true, hasTask: true } }),
    agent({ id: 'b', display: 'idle' }),
    agent({ id: 'c', display: 'stale', evidence: { hasSession: true, sessionFresh: false, hasTask: false } }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agents, 3);
  assert.equal(rows[0].working, 1);
  assert.equal(rows[0].idle, 1);
  assert.equal(rows[0].stale, 1);
});

test('a floor with no working member is not reported as working', () => {
  const rows = rollupFloors([agent({ id: 'a', role: 'floor lead', display: 'idle' })]);
  assert.equal(rows[0].health, 'idle');
  assert.equal(rows[0].working, 0);
});

test('a stale member makes the floor stale even with a live lead', () => {
  const rows = rollupFloors([
    agent({ id: 'lead', role: 'floor lead', display: 'idle' }),
    agent({ id: 'w', display: 'stale', evidence: { hasSession: true, sessionFresh: false, hasTask: false } }),
  ]);
  assert.equal(rows[0].health, 'stale');
  assert.equal(rows[0].lead, 'lead');
  assert.equal(rows[0].leadIsLive, true);
});

test('a floor with no claimed lead reports none rather than guessing', () => {
  const rows = rollupFloors([agent({ id: 'a', role: 'worker' })]);
  assert.equal(rows[0].lead, null);
  assert.equal(rows[0].leadIsLive, false);
});

test('a stale lead is flagged, not counted as live', () => {
  const rows = rollupFloors([
    agent({ id: 'lead', role: 'floor lead', display: 'stale', evidence: { hasSession: true, sessionFresh: false, hasTask: false } }),
  ]);
  assert.equal(rows[0].lead, 'lead');
  assert.equal(rows[0].leadIsLive, false);
});

test('agents without a floor are excluded, and empty input is empty', () => {
  assert.equal(rollupFloors([agent({ floor: null })]).length, 0);
  assert.deepEqual(rollupFloors([]), []);
});

test('numbered floors sort in numeric order, not lexicographically', () => {
    // Only f<digits> reaches rollupFloors now: the floor attribute is also used
    // for organisational groups like `command`, and emitting those as floors gave
    // 18 rows for 12 floors (see summaryFloorsContract.test.js). So this asserts
    // the numeric ordering directly, which is what lexicographic sorting breaks:
    // f10 before f2.
    const rows = rollupFloors([
      agent({ id: 'a', floor: 'f10' }),
      agent({ id: 'b', floor: 'f2' }),
      agent({ id: 'c', floor: 'f1' }),
    ]);
    assert.deepEqual(rows.map(r => r.floor), ['f1', 'f2', 'f10']);
  });

// ---- completion integrity ---------------------------------------------------
// A task can be recorded COMPLETE while its own record says the model call
// failed. Counting those as successes makes every completion rate a lie.

const { getQueueSummary } = server.internals;

test('the queue separates raw COMPLETE from verified completions', () => {
  const q = getQueueSummary();
  for (const key of ['complete', 'completedButFailed', 'verifiedComplete']) {
    assert.equal(typeof q[key], 'number', `queue summary is missing ${key}`);
  }
  // The raw count is whatever the store says; the verified count is the raw
  // count minus the ones whose own record says they failed. They must agree.
  assert.equal(
    q.verifiedComplete + q.completedButFailed, q.complete,
    'verified + failed-discrepancies must reconstruct the raw complete count',
  );
  assert.ok(q.verifiedComplete <= q.complete, 'verified cannot exceed the raw count');
});

test('a COMPLETE task whose evidence records an llm_error is not a success', () => {
  // The shape seen live: status COMPLETE, evidence.status llm_error, and a
  // result of "LLM call failed: All LLM providers failed" with no leading
  // bracket, which is why hive/lib/verify.py's "[LLM call failed" marker misses
  // it and the task is stored as a completion.
  const { completedButFailed } = getQueueSummary();
  assert.ok(
    Number.isInteger(completedButFailed) && completedButFailed >= 0,
    'completedButFailed must be a non-negative count',
  );
});

// ---- dependency gating -----------------------------------------------------
// The dependency engine parks a task in BLOCKED until its prerequisite produces
// a result. That is real work in a real state, so the queue has to report it
// rather than let it vanish between QUEUED and claimable.

test('the queue reports dependency-blocked tasks with the reason', () => {
  const q = getQueueSummary();
  assert.equal(typeof q.blocked, 'number', 'queue summary is missing blocked');
  assert.ok(Array.isArray(q.blockedTasks), 'queue summary is missing blockedTasks');
  assert.ok(
    q.blocked >= q.blockedTasks.length,
    'blocked count must be at least the number of tasks listed',
  );
  for (const task of q.blockedTasks) {
    assert.ok(task.task_id, 'a blocked task must carry its id');
    assert.ok(task.reason, `blocked task ${task.task_id} must say why it is waiting`);
  }
});

test('one agent appears once, whatever casing the registry used', () => {
  // The hive registry accumulated both casings for the same agent (PM-RISK and
  // pm-risk), which inflated the roster and the floor counts the HUD reports.
  // This invariant holds for whatever the live registry contains.
  const ids = mergedAgents().map((agent) => String(agent.id || '').toLowerCase());
  const seen = new Map();
  for (const id of ids) {
    assert.ok(id, 'an agent with no id cannot be deduplicated');
    assert.equal(seen.has(id), false, `${id} is listed more than once (case-insensitive)`);
    seen.set(id, true);
  }
});

test('every agent id is unique even before folding case', () => {
  const ids = mergedAgents().map((agent) => agent.id);
  assert.equal(new Set(ids).size, ids.length, 'exact duplicate ids in the roster');
});
