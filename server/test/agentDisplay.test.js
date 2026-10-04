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
const { makeFixtureHive, loadServer } = require('./helpers/harness');

const STALE_SEC = 60 * 60;

/**
 * These tests used to be written as invariants over "whatever the live hive
 * contains", on the stated grounds that a fixture could not be injected. That
 * premise was false in the worst way: loadServer() was called with no argument,
 * `process.env.OFFICE_HUD_HIVE = undefined` coerced to the truthy string
 * "undefined", and the server was pointed at ./undefined/. The "live hive" was
 * never opened. Every loop below iterated an empty roster and every count came
 * back 0, so the whole file passed without reading anything -- including the
 * completion-split identity, which held as 0 + 0 === 0.
 *
 * The invariants are still the right thing to assert, and they are now asserted
 * over a real hive: makeFixtureHive() builds one on disk, and loadServer() now
 * refuses a missing or non-directory path instead of quietly producing "undefined".
 */

// The completion-split assertions are only meaningful over a hive that actually
// holds COMPLETE tasks, so the cases under test are declared here rather than
// inherited from whatever makeFixtureHive happened to write. They are appended to
// its task list so its own statuses stay in place.
const fixture = makeFixtureHive();

function completionTask(id, extra) {
  return {
    task_id: id,
    title: `completion case ${id}`,
    status: 'COMPLETE',
    created_at: new Date(fixture.now - 3 * 3600000).toISOString(),
    started_at: new Date(fixture.now - 2 * 3600000).toISOString(),
    completed_at: new Date(fixture.now - 3600000).toISOString(),
    claimed_by: 'worker-a',
    ...extra,
  };
}

const COMPLETION_CASES = [
  // No result and no evidence block at all. Stored COMPLETE, not flagged as
  // failed, backed by nothing -- the shape that must be reported as unverified
  // rather than quietly absorbed into "verified".
  completionTask('c-no-evidence'),
  // Whitespace-only output. The result branch trims before judging, so this is
  // also unverified; it pins the trim rather than only the missing key.
  completionTask('c-blank-result', { result: '   \n\t  ' }),
  // Liveness: stored COMPLETE while its own record says the model call failed.
  // Must land in completedButFailed and must never be counted as verified.
  completionTask('c-llm-error', {
    result: '[executor ended: llm_error] all providers unavailable',
    evidence: { status: 'llm_error' },
  }),
  // The one genuinely verified completion: real recorded output plus artifacts.
  completionTask('c-backed', {
    result: 'wrote the quarterly report',
    evidence: { artifacts: ['reports/q3.md'], outcome: 'done' },
  }),
];

const tasksPath = path.join(fixture.hive, 'tasks.json');
const store = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
store.tasks = store.tasks.concat(COMPLETION_CASES);
fs.writeFileSync(tasksPath, JSON.stringify(store, null, 2));

const server = loadServer(fixture.hive);
const { mergedAgents } = server.internals;
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

  test('organisational groups are not reported as floors', () => {
    // `floor` doubles as an organisational group attribute (command, office,
    // operations, ...). Reporting those as floors produced 18 rows for 12
    // floors, six with no manager, no state and no liveness. A floor id is
    // f<digits>; anything else belongs in the agent view, not the floor rollup.
    const rows = rollupFloors([
      agent({ id: 'a', floor: 'f2' }),
      agent({ id: 'b', floor: 'command' }),
      agent({ id: 'c', floor: 'office' }),
    ]);
    assert.deepEqual(rows.map(r => r.floor), ['f2']);
  });

// ---- completion integrity ---------------------------------------------------
// A task can be recorded COMPLETE while its own record says the model call
// failed. Counting those as successes makes every completion rate a lie.

const { getQueueSummary } = server.internals;

test('the queue partitions COMPLETE into verified, failed and unverified', () => {
  const q = getQueueSummary();
  for (const key of ['complete', 'completedButFailed', 'verifiedComplete', 'unverifiedComplete']) {
    assert.equal(typeof q[key], 'number', `queue summary is missing ${key}`);
  }
  // Precondition, and the reason this assertion used to be unfalsifiable: over an
  // empty hive every term is 0 and the identity below holds as 0 + 0 + 0 === 0.
  // If the fixture ever stops loading, this fails here instead of passing quietly.
  assert.ok(q.complete > 0, `fixture hive exposed no COMPLETE tasks (complete=${q.complete})`);
  assert.ok(
    q.verifiedComplete >= 1,
    `the artifact-backed completion was not counted as verified (verifiedComplete=${q.verifiedComplete})`,
  );
  // The raw count is whatever the store says. Every COMPLETE task lands in exactly
  // one of the three buckets, so the three reconstruct the raw count. This used to
  // be a TWO-term identity (verified + failed === complete), which cannot coexist
  // with verified meaning "backed by durable evidence": a completion that is
  // neither failed nor evidenced has nowhere to go and gets absorbed into
  // "verified". The third term is what makes the arithmetic honest.
  assert.equal(
    q.verifiedComplete + q.completedButFailed + q.unverifiedComplete, q.complete,
    'verified + failed-discrepancies + unverified must reconstruct the raw complete count',
  );
  assert.ok(q.verifiedComplete <= q.complete, 'verified cannot exceed the raw count');
});

test('a COMPLETE task with no durable evidence is reported, not counted as verified', () => {
  const q = getQueueSummary();
  assert.ok(q.complete > 0, `precondition: fixture hive has COMPLETE tasks (complete=${q.complete})`);
  // c-no-evidence has no result and no evidence block; c-blank-result has only
  // whitespace. Neither may be published as verified, and both must appear.
  assert.ok(
    q.unverifiedComplete >= 2,
    `the two evidence-free completions must be reported; unverifiedComplete=${q.unverifiedComplete}`,
  );
  assert.equal(
    q.verifiedComplete + q.completedButFailed + q.unverifiedComplete, q.complete,
    'the partition must still reconstruct the raw complete count',
  );
});

test('a COMPLETE task whose evidence records an llm_error is not a success', () => {
  // The shape seen live: status COMPLETE, evidence.status llm_error, and a
  // result of "LLM call failed: All LLM providers failed" with no leading
  // bracket, which is why hive/lib/verify.py's "[LLM call failed" marker misses
  // it and the task is stored as a completion.
  const q = getQueueSummary();
  assert.ok(q.complete > 0, `precondition: fixture hive has COMPLETE tasks (complete=${q.complete})`);
  // Was `Number.isInteger(x) && x >= 0`, which is true of every value the server
  // could ever return -- including every value produced by an unreadable hive, so
  // the test passed whether or not the detector fired at all. There is exactly one
  // failure-shaped record in the fixture, so the count is pinned.
  assert.equal(
    q.completedButFailed, 1,
    'the llm_error record must be detected as a false completion and subtracted',
  );
  assert.ok(
    q.completedButFailed <= q.complete,
    'a discrepancy count cannot exceed the raw COMPLETE count',
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
