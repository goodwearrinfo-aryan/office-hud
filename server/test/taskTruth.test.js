'use strict';
// Tests for the task truth labels.
//
// These are unit tests over synthetic records, not assertions about what the
// server currently serves. A test that passes only because the live payload
// happens to look a certain way is a snapshot, and it rots the moment the task
// queue moves -- which, on this box, is every few minutes. The live numbers go
// in a check script; the RULES go here.
//
// The rule under test, from the brief: never mark work completed without
// evidence, and where the data does not exist, say NOT VERIFIED.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVIDENCE_SCORE_FLOOR,
  TRUTH,
  classifyTaskTruth,
  summarizeTasks,
} = require('../taskTruth');

const complete = (verified) => ({ status: 'COMPLETE', verified });
const offTopic = (score = 0.95) => complete({
  verdict: 'OK',
  score,
  at: '2026-09-27T21:00:00Z',
  engagement: {
    verdict: 'OFF_TOPIC',
    reasons: ['no task-relevant vocabulary and no structural evidence'],
  },
});
const engaged = (score = 0.95) => complete({
  verdict: 'OK',
  score,
  at: '2026-09-27T21:00:00Z',
  engagement: { verdict: 'ENGAGED', reasons: ['task vocabulary: [refactor]'] },
});

test('a well-evidenced completion is labelled COMPLETE', () => {
  const r = classifyTaskTruth(engaged(0.95));
  assert.equal(r.truth, TRUTH.EVIDENCED);
  assert.equal(r.label, 'COMPLETE');
});

test('OFF_TOPIC is NOT VERIFIED even when the overall verdict says OK', () => {
  // This is the live finding: 86 completed tasks carry verdict OK with
  // engagement OFF_TOPIC. The engagement rejection has to win.
  const r = classifyTaskTruth(offTopic(0.95));
  assert.equal(r.truth, TRUTH.OFF_TOPIC);
  assert.equal(r.label, 'COMPLETE / NOT VERIFIED');
  assert.match(r.reason, /no task-relevant vocabulary/);
});

test('a low score is weak, not silently accepted', () => {
  const r = classifyTaskTruth(engaged(0.5));
  assert.equal(r.truth, TRUTH.WEAK);
  assert.equal(r.label, 'COMPLETE / WEAK EVIDENCE');
});

test('a missing verification record is NOT VERIFIED, never assumed good', () => {
  const r = classifyTaskTruth({ status: 'COMPLETE' });
  assert.equal(r.truth, TRUTH.UNVERIFIED);
  assert.equal(r.label, 'COMPLETE / NOT VERIFIED');
});

test('a verification record with no score cannot be weighed', () => {
  const r = classifyTaskTruth(complete({ verdict: 'OK', engagement: { verdict: 'ENGAGED' } }));
  assert.equal(r.truth, TRUTH.UNVERIFIED);
  assert.match(r.reason, /no score/);
});

test('the score floor is inclusive at the boundary', () => {
  assert.equal(classifyTaskTruth(engaged(EVIDENCE_SCORE_FLOOR)).truth, TRUTH.EVIDENCED);
  assert.equal(classifyTaskTruth(engaged(EVIDENCE_SCORE_FLOOR - 0.01)).truth, TRUTH.WEAK);
});

test('a non-completed task makes no completion claim', () => {
  for (const st of ['QUEUED', 'IN_PROGRESS', 'QUARANTINED', 'FAILED']) {
    const r = classifyTaskTruth({ status: st });
    assert.equal(r.truth, null, `${st} must not be scored as a completion`);
    assert.equal(r.label, st);
  }
});

test('a task with no status is UNKNOWN, not COMPLETE', () => {
  const r = classifyTaskTruth({ verified: { verdict: 'OK', score: 1 } });
  assert.equal(r.label, 'UNKNOWN');
});

test('a non-object record does not throw', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = classifyTaskTruth(bad);
    assert.equal(r.truth, TRUTH.UNVERIFIED);
    assert.equal(r.label, 'NOT VERIFIED');
  }
});

test('the raw status is always preserved for traceability', () => {
  assert.equal(classifyTaskTruth(offTopic()).raw, 'COMPLETE');
  assert.equal(classifyTaskTruth({ status: 'queued' }).raw, 'queued');
});

test('summary counts the unsupported completions rather than hiding them', () => {
  const s = summarizeTasks([
    engaged(0.95), engaged(0.95), engaged(0.95),
    offTopic(0.95), offTopic(0.7),
    engaged(0.5),
    { status: 'COMPLETE' },
    { status: 'QUEUED' },
  ]);
  assert.equal(s.total, 8);
  assert.equal(s.complete_claimed, 7);
  assert.equal(s.evidenced, 3);
  assert.equal(s.off_topic, 2);
  assert.equal(s.weak, 1);
  assert.equal(s.unverified, 1);
  assert.equal(s.not_complete, 1);
  assert.equal(s.unsupported_completions, 4);
  assert.equal(s.unsupported_share, 0.5714);
});

test('summary ranks the agents producing unsupported completions', () => {
  const withAgent = (agent, v) => Object.assign({ assigned_agent: agent }, v);
  const s = summarizeTasks([
    withAgent('a', offTopic()),
    withAgent('a', offTopic()),
    withAgent('b', offTopic()),
    withAgent('c', engaged()),
  ]);
  assert.deepEqual(s.worst_offenders[0], { agent: 'a', unsupported: 2 });
  assert.equal(s.worst_offenders[1].agent, 'b');
});

test('summary survives junk input instead of throwing', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const s = summarizeTasks(bad);
    assert.equal(s.total, 0);
    assert.equal(s.complete_claimed, 0);
    assert.equal(s.unsupported_share, 0);
    assert.match(s.statement, /0 of 0/);
  }
});

test('an all-evidenced queue reports zero unsupported, not a rounded lie', () => {
  const s = summarizeTasks([engaged(0.95), engaged(1)]);
  assert.equal(s.unsupported_completions, 0);
  assert.equal(s.unsupported_share, 0);
});
