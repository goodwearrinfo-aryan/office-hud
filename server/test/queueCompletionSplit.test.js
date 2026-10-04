// `complete`, `verifiedComplete` and `completedButFailed` are one number split
// three ways, and nothing in the suite held them together.
//
// MEASURED, NOT ASSUMED
// ----------------------
// index.js builds them as:
//     const completedTasks = tasks.filter(t => String(t.status||'').toUpperCase() === 'COMPLETE');
//     const completedButFailed = completedTasks.filter(looksFailed);
//     completedButFailed: completedButFailed.length,
//     verifiedComplete:    completedTasks.length - completedButFailed.length,
//
// so the invariant is exact and total, not approximate:
//
//     verifiedComplete + completedButFailed === complete
//
// Nothing asserted it. Two mutations of the real implementation, each deployed
// and run against the full suite, both stayed GREEN at 333/333:
//
//   1. verifiedComplete := -1
//   2. the two values swapped, which reported 601 failed / 1 verified when the
//      truth is 0 failed / 601 verified -- a total inversion of the field the
//      comment at index.js:1763 says exists precisely because "a completion
//      rate that hides failures is a false number".
//
// Those are the mutations this file catches. It also pins the detection rules
// looksFailed actually implements, because a change to that predicate silently
// changes what "verified" means.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

/** A COMPLETE task with a given result and/or evidence.status. */
function completeTask(taskId, { result, evidenceStatus } = {}) {
  const task = {
    task_id: taskId,
    title: `task ${taskId}`,
    status: 'COMPLETE',
    created_at: new Date(Date.now() - 7200000).toISOString(),
    completed_at: new Date(Date.now() - 3600000).toISOString(),
  };
  if (result !== undefined) task.result = result;
  if (evidenceStatus !== undefined) task.evidence = { status: evidenceStatus };
  return task;
}

/** Write tasks.json into a fresh fixture hive. */
function hiveWith(tasks) {
  const fixture = makeFixtureHive();
  fs.writeFileSync(
    path.join(fixture.hive, 'tasks.json'),
    JSON.stringify({ tasks }, null, 2),
  );
  return fixture;
}

async function queueFor(tasks) {
  const fixture = hiveWith(tasks);
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/queue');
    assert.equal(res.status, 200);
    return res.json;
  } finally {
    await http.close();
    fixture.cleanup();
  }
}

test('the three completion counts are declared as a split of one number', async () => {
  const q = await queueFor([
    completeTask('c1', { result: 'ok' }),
    completeTask('c2', { result: 'ok' }),
    completeTask('c3', { result: 'ok' }),
  ]);

  assert.equal(q.complete, 3, 'three tasks are recorded COMPLETE');
  assert.equal(q.completedButFailed, 0, 'none of them carries a failure marker');
  assert.equal(q.verifiedComplete, 3, 'all three are verified completions');

  // THE INVARIANT. Catches both recorded mutations: a bogus verifiedComplete
  // breaks the sum, and swapping the two values breaks it too.
  assert.equal(
    q.verifiedComplete + q.completedButFailed,
    q.complete,
    'verifiedComplete + completedButFailed must equal complete exactly; the three '
      + `fields are one count split, and the sum is what makes them consistent `
      + `(got ${q.verifiedComplete} + ${q.completedButFailed} vs ${q.complete})`,
  );
});

test('both counts are non-negative integers', async () => {
  // The -1 mutation is caught here as well as by the sum, with a message that
  // names the field rather than leaving the reader to work out which broke.
  const q = await queueFor([completeTask('c1', { result: 'ok' })]);
  for (const field of ['complete', 'verifiedComplete', 'completedButFailed']) {
    assert.equal(typeof q[field], 'number', `${field} must be a number`);
    assert.ok(Number.isInteger(q[field]), `${field} must be an integer, got ${q[field]}`);
    assert.ok(q[field] >= 0, `${field} must not be negative, got ${q[field]}`);
  }
  assert.ok(
    q.completedButFailed <= q.complete,
    'you cannot have more failed completions than completions',
  );
});

test('a completion whose record says the model call failed is not verified', async () => {
  // The reason these fields exist. The raw `complete` count includes these; only
  // the split keeps a completion rate from hiding failures.
  const q = await queueFor([
    completeTask('ok-1', { result: 'ok' }),
    completeTask('ok-2', { result: 'ok' }),
    completeTask('ok-3', { result: 'ok' }),
    completeTask('boom', { result: '[LLM call failed] all llm providers failed' }),
  ]);

  assert.equal(q.complete, 4, 'the raw count includes the failed one');
  assert.equal(q.completedButFailed, 1, 'the failure is surfaced, not hidden');
  assert.equal(q.verifiedComplete, 3, 'and the verified count excludes it');
  assert.equal(q.verifiedComplete + q.completedButFailed, q.complete);
});

test('looksFailed detection matches the predicates index.js implements', async () => {
  // Each case is a literal from the regex and the status checks in
  // getQueueSummary().looksFailed. If that predicate is edited, the meaning of
  // "verified" changes, and this is what notices.
  const markers = [
    { label: 'llm call failed in result', task: { result: 'llm call failed' } },
    { label: 'llm_error in result', task: { result: 'llm_error' } },
    { label: 'all providers failed', task: { result: 'all llm providers failed' } },
    { label: 'executor ended: llm_error', task: { result: 'executor ended: llm_error' } },
    { label: 'executor ended: error', task: { result: 'executor ended: error' } },
    { label: 'evidence.status llm_error', task: { evidenceStatus: 'llm_error' } },
    { label: 'evidence.status error', task: { evidenceStatus: 'error' } },
  ];

  for (const { label, task } of markers) {
    const q = await queueFor([completeTask('subject', task)]);
    assert.equal(q.completedButFailed, 1,
      `"${label}" must count as a failed completion, not a verified one`);
    assert.equal(q.verifiedComplete, 0,
      `"${label}" must not be counted as verified`);
  }

  // And the negative: a success that merely mentions the word must not be
  // miscounted, or `verified` becomes meaningless in the other direction.
  for (const clean of ['ok', 'done: 3 files changed', 'no errors found', 'success']) {
    const q = await queueFor([completeTask('clean', { result: clean })]);
    assert.equal(q.completedButFailed, 0,
      `"${clean}" is a success and must not be counted as failed`);
    assert.equal(q.verifiedComplete, 1);
  }
});

test('non-COMPLETE statuses never enter the split', async () => {
  const q = await queueFor([
    completeTask('c1', { result: 'ok' }),
    { task_id: 'running', title: 'r', status: 'IN_PROGRESS' },
    { task_id: 'queued', title: 'q', status: 'QUEUED' },
    // A FAILED task whose result mentions an LLM failure is still not a
    // "completed but failed" completion: it was never claimed complete.
    { task_id: 'failed', title: 'f', status: 'FAILED', result: 'llm call failed' },
  ]);

  assert.equal(q.complete, 1);
  assert.equal(q.completedButFailed, 0, 'only COMPLETE tasks are in the split');
  assert.equal(q.verifiedComplete, 1);
  assert.equal(q.verifiedComplete + q.completedButFailed, q.complete);
});

test('the split stays consistent with an empty queue', async () => {
  // Degenerate case: zero completions must not produce -1 or NaN, which is
  // exactly what a careless rewrite of the subtraction would do.
  const q = await queueFor([]);
  assert.equal(q.complete, 0);
  assert.equal(q.completedButFailed, 0);
  assert.equal(q.verifiedComplete, 0);
  assert.equal(q.verifiedComplete + q.completedButFailed, q.complete);
});
