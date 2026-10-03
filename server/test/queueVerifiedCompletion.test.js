'use strict';
// Regression tests for the /api/queue `verifiedComplete` field.
//
// These live in their own file on purpose: the queue contract is currently
// asserted in test/agentDisplay.test.js, which is a separate owner's dirty file,
// and this suite needs a fixture hive rather than live-hive invariants.
//
// The defect being pinned here: getQueueSummary() publishes
//   verifiedComplete = completedTasks.length - completedButFailed.length
// where completedButFailed is a *substring regex* over the task's own
// result/evidence text. Nothing in that arithmetic consults durable evidence, so
// the field carries the word "verified" while measuring only "not
// keyword-flagged as failed".
//
// The two properties are pinned separately, because conflating them is what let
// the original test go vacuous:
//
//   1. Liveness     - the failure detector actually fires. A COMPLETE task whose
//                     own record says the model call failed must be subtracted.
//   2. Truthfulness - a "verified" completion must be backed by durable work.
//                     Status COMPLETE on its own is a claim, not proof.
//
// One fixture hive is loaded once and shared by every test, mirroring
// agentDisplay.test.js. The server reads HIVE at require time, so loadServer()
// must not be called per-test: require() caches the module and the second call
// would silently reuse the first fixture's HIVE constant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadServer } = require('./helpers/harness');

function completeTask(id, extra = {}) {
  return {
    task_id: id,
    title: `task ${id}`,
    status: 'COMPLETE',
    created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
    completed_at: new Date(Date.now() - 3600000).toISOString(),
    claimed_by: 'worker-a',
    ...extra,
  };
}

// t-llm-error  : stored COMPLETE, but its own record says the call failed, and
//                it produced nothing. Must be subtracted (liveness).
// t-empty      : stored COMPLETE, no failure marker, and no durable work at all.
//                This is the shape that makes up 538/538 of the live hive.
// t-backed     : stored COMPLETE and backed by a real artifact. The only task
//                that may legitimately be published as verified.
const FIXTURE_TASKS = [
  completeTask('t-llm-error', {
    result: '[executor ended: llm_error] all providers unavailable',
    evidence: { status: 'llm_error' },
  }),
  completeTask('t-empty', { result: 'done', evidence: {} }),
  completeTask('t-backed', {
    result: 'done',
    evidence: { artifacts: ['src/a.ts'], requested_target_file: 'src/a.ts' },
  }),
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-verified-'));
const hive = path.join(root, 'hive');
fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
fs.mkdirSync(path.join(hive, 'lib', 'llm'), { recursive: true });
fs.writeFileSync(path.join(hive, 'tasks.json'), JSON.stringify({ tasks: FIXTURE_TASKS }, null, 2));
fs.writeFileSync(path.join(hive, 'work_events.jsonl'), '');

const { getQueueSummary } = loadServer(hive).internals;
const q = getQueueSummary();

test('liveness: a COMPLETE task whose record says the LLM failed is subtracted', () => {
  assert.equal(q.complete, 3, 'all three tasks are stored COMPLETE');
  assert.equal(
    q.completedButFailed,
    1,
    'the llm_error task must be detected as a false completion',
  );
  assert.equal(
    q.verifiedComplete + q.completedButFailed,
    q.complete,
    'verified + failed-discrepancies must reconstruct the raw complete count',
  );
});

test('truthfulness: only artifact-backed completions may be published as verified', () => {
  // t-backed is the only task with an artifacts[] list. t-empty has none, and
  // t-llm-error produced nothing at all. Publishing verifiedComplete === 2 means
  // the endpoint is crediting t-empty as evidence-backed verification, which is
  // the same 100%-with-zero-artifacts overclaim seen live.
  assert.equal(
    q.verifiedComplete,
    1,
    `verifiedComplete credited ${q.verifiedComplete} tasks but only 1 has durable ` +
      'evidence; the subtraction only ever removes keyword-matched failures, it ' +
      'never checks that work actually happened',
  );
});