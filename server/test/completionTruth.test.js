// The task board's done column must carry its evidence, and the summary must
// agree with the rows.
//
// WHY THIS EXISTS
// ---------------
// f34cc1e added completion_truth, evidence_score and evidence_reason to done
// rows, plus a `completion` summary, because the board showed 602 COMPLETE
// tasks while only 301 had supporting evidence. That was the single largest
// honesty gap in the HUD: half the completed column asserted work was finished
// with nothing to show for it.
//
// Nothing tested any of it. The only reference to these fields in the entire
// suite was routes.test.js listing them as ALLOWED on a row -- a payload
// whitelist that permits the field, not a test of its value. So the labelling
// could be deleted outright and the suite stayed green.
//
// Reproduced: removing the labelling block from getTaskBoard entirely still
// gave 328/328. A truth surface can lose the exact disclosure it exists to
// provide without a single test turning red. This file is that missing test.
//
// WHAT IS ASSERTED
// ----------------
// 1. every done row carries a verdict from the canonical vocabulary
// 2. a row whose own evidence says OFF_TOPIC is labelled OFF_TOPIC, not
//    EVIDENCED -- the label is derived, not decorative
// 3. evidence_score is a number when the verdict is scored, and null otherwise
// 4. rows in the other columns carry NO completion label, because labelling
//    QUEUED or IN_PROGRESS would imply a completion claim that does not exist
// 5. the summary's counts are the tally of the rows' own verdicts, so the
//    headline number cannot drift from the evidence beside it
// 6. counts.done stays the raw pipeline count: the board reports what the
//    pipeline asserts and `completion` reports what evidence supports, and
//    conflating them would hide the gap rather than show it
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const { TRUTH, classifyTaskTruth } = require('../taskTruth.js');

const VALID = new Set(Object.values(TRUTH));

/** Write a COMPLETE task with a specific engagement verdict and score. */
function writeTask(hive, taskId, { verdict, score, status = 'COMPLETE' }) {
  const file = `${hive}/tasks.json`;
  let doc = { tasks: [] };
  try { doc = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { /* fresh */ }
  if (!Array.isArray(doc.tasks)) doc.tasks = [];
  doc.tasks.push({
    task_id: taskId,
    title: `task ${taskId}`,
    status,
    created_at: new Date(Date.now() - 7200000).toISOString(),
    updated_at: new Date(Date.now() - 600000).toISOString(),
    // classifyTaskTruth reads the score from verified.score and the verdict
    // from verified.engagement.verdict. Putting the score inside engagement makes
    // every task read UNVERIFIED, which is itself the honest answer for a
    // record that carries no score.
    verified: verdict ? { engagement: { verdict }, score } : undefined,
  });
  require('fs').writeFileSync(file, JSON.stringify(doc, null, 2));
}

test('done rows carry a verdict derived from their own evidence', async () => {
  const fixture = makeFixtureHive();
  writeTask(fixture.hive, 'evidenced-one', { verdict: 'OK', score: 0.97 });
  writeTask(fixture.hive, 'off-topic-one', { verdict: 'OFF_TOPIC', score: 0.1 });
  writeTask(fixture.hive, 'weak-one', { verdict: 'OK', score: 0.5 });
  writeTask(fixture.hive, 'no-evidence-one', { verdict: null });

  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/task-board');
    assert.equal(res.status, 200);

    const done = res.json.groups.done;
    assert.ok(done.length >= 4, 'fixture tasks should reach the done column');

    for (const row of done) {
      assert.ok(row.completion_truth, `done row ${row.task_id} has no completion_truth`);
      assert.ok(VALID.has(row.completion_truth),
        `${row.task_id} has an unknown verdict ${row.completion_truth}`);
      assert.ok('evidence_reason' in row, `${row.task_id} must state a reason`);
    }

    // The label is derived, not decorative: a row whose own evidence says
    // OFF_TOPIC must not be presented as evidenced work.
    const offTopic = done.find((r) => r.task_id === 'off-topic-one');
    assert.equal(offTopic.completion_truth, TRUTH.OFF_TOPIC,
      'a task whose engagement verdict is OFF_TOPIC must be labelled OFF_TOPIC');

    const evidenced = done.find((r) => r.task_id === 'evidenced-one');
    assert.equal(evidenced.completion_truth, TRUTH.EVIDENCED,
      'score 0.97 is above the 0.9 floor and must read as evidenced');

    const weak = done.find((r) => r.task_id === 'weak-one');
    assert.equal(weak.completion_truth, TRUTH.WEAK, 'score 0.5 is below the floor');
    assert.equal(typeof weak.evidence_score, 'number');

    const none = done.find((r) => r.task_id === 'no-evidence-one');
    assert.equal(none.completion_truth, TRUTH.UNVERIFIED,
      'no verification record must read as UNVERIFIED, not evidenced');
  } finally {
    await http.close();
    fixture.cleanup();
  }
});

test('rows outside the done column carry no completion label', async () => {
  const fixture = makeFixtureHive();
  writeTask(fixture.hive, 'still-open', { verdict: null, status: 'QUEUED' });
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/task-board');
    for (const column of ['todo', 'in_progress', 'review']) {
      for (const row of res.json.groups[column] || []) {
        assert.equal(row.completion_truth, undefined,
          `${column}/${row.task_id} must not carry a completion label; only a work item `
            + 'that claims completion can be judged on its evidence');
      }
    }
  } finally {
    await http.close();
    fixture.cleanup();
  }
});

test('the summary tally equals the rows own verdicts', async () => {
  const fixture = makeFixtureHive();
  writeTask(fixture.hive, 'sum-ok', { verdict: 'OK', score: 0.95 });
  writeTask(fixture.hive, 'sum-bad', { verdict: 'OFF_TOPIC', score: 0 });
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/task-board');
    const summary = res.json.completion;
    assert.ok(summary, 'the payload must carry a completion summary beside counts.done');
    assert.equal(summary.evidenced + summary.weak + summary.off_topic + summary.unverified,
      summary.total, 'the four verdict buckets must account for every claimed completion');

    // The headline numbers must be mutually consistent: the gap between the
    // pipeline's count and the evidenced count is exactly the unsupported count.
    assert.equal(summary.total, res.json.counts.done,
      'the summary covers exactly what counts.done claims');
    assert.equal(summary.unsupported_completions, summary.total - summary.evidenced,
      'unsupported is the difference between the claim and the evidence');
  } finally {
    await http.close();
    fixture.cleanup();
  }
});

test('counts.done stays the raw pipeline count, unadjusted', async () => {
  // The point of the disclosure is that both numbers are visible. Collapsing
  // them would make the board look correct by hiding the discrepancy.
  const fixture = makeFixtureHive();
  writeTask(fixture.hive, 'raw-1', { verdict: 'OFF_TOPIC', score: 0 });
  writeTask(fixture.hive, 'raw-2', { verdict: 'OFF_TOPIC', score: 0 });
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/task-board');
    const claimed = res.json.counts.done;
    const evidenced = res.json.completion.evidenced;
    assert.ok(claimed > evidenced,
      `fixture should produce a gap, got done=${claimed} evidenced=${evidenced}`);
    assert.equal(res.json.completion.unsupported_share > 0, true,
      'the unsupported share must be reported, not suppressed');
  } finally {
    await http.close();
    fixture.cleanup();
  }
});

test('the label matches classifyTaskTruth for every done row', async () => {
  // Independent restatement: recompute from the raw task file and compare. This
  // cannot be satisfied by any labelling that is not actually derived.
  const fixture = makeFixtureHive();
  const ids = ['chk-1', 'chk-2', 'chk-3'];
  writeTask(fixture.hive, ids[0], { verdict: 'OK', score: 0.99 });
  writeTask(fixture.hive, ids[1], { verdict: 'OK', score: 0.2 });
  writeTask(fixture.hive, ids[2], { verdict: null });

  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/task-board');
    const raw = JSON.parse(require('fs').readFileSync(`${fixture.hive}/tasks.json`, 'utf8'));
    for (const id of ids) {
      const task = raw.tasks.find((t) => t.task_id === id);
      const row = res.json.groups.done.find((r) => r.task_id === id);
      assert.ok(row, `${id} should appear in the done column`);
      assert.equal(row.completion_truth, classifyTaskTruth(task).truth,
        `${id}: the board label must equal classifyTaskTruth computed independently`);
    }
  } finally {
    await http.close();
    fixture.cleanup();
  }
});
