'use strict';
// These tests exist mostly to pin down what the dashboard is NOT allowed to do:
// fold quarantined work into a flattering average, or report an absence of data
// as a failure. Both would be technically true numbers and operationally
// misleading, which is the failure mode worth defending against.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeFleetPerformance } = require('../lib/fleet_performance.js');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const HOUR = 3600 * 1000;

function hiveWith(docs) {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-hive-'));
  for (const [name, body] of Object.entries(docs)) {
    fs.writeFileSync(path.join(hive, `${name}.json`), JSON.stringify(body));
  }
  return hive;
}

function session(agent, status, heartbeatHoursAgo, extra = {}) {
  return {
    session_id: `sess-${agent}-${Math.random().toString(16).slice(2, 8)}`,
    agent_id: agent,
    status,
    last_heartbeat: new Date(NOW - heartbeatHoursAgo * HOUR).toISOString(),
    started_at: new Date(NOW - 48 * HOUR).toISOString(),
    ...extra,
  };
}

function task(agent, status, extra = {}) {
  return {
    task_id: `todo-${Math.random().toString(16).slice(2, 10)}`,
    assigned_agent: agent,
    status,
    created_at: new Date(NOW - 10 * HOUR).toISOString(),
    ...extra,
  };
}

// --------------------------------------------------------------------- totals

test('task outcomes are counted separately, never merged', () => {
  const hive = hiveWith({
    tasks: { tasks: [
      task('a', 'COMPLETE'), task('a', 'COMPLETE'),
      task('a', 'QUARANTINED'),
      task('b', 'IN_PROGRESS'),
      task('b', 'PRESERVED'),
      task('b', 'QUEUED'),
    ] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 6);
  assert.equal(r.tasks.complete, 2);
  assert.equal(r.tasks.quarantined, 1);
  assert.equal(r.tasks.inProgress, 1);
  assert.equal(r.tasks.preserved, 1);
  assert.equal(r.tasks.queued, 1);
});

test('quarantined work is excluded from completionRate rather than diluted into it', () => {
  const hive = hiveWith({
    tasks: { tasks: [
      task('a', 'COMPLETE'), task('a', 'QUARANTINED'), task('a', 'QUARANTINED'),
    ] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  // Rates are rounded to 3dp on purpose, so these are 0.333 and 0.667.
  assert.equal(r.tasks.completionRate, 0.333, 'one of three completed — not 50%');
  assert.equal(r.tasks.quarantineRate, 0.667, 'and the quarantine rate says the rest of the story');
});

test('an unknown status counts as assigned but never as done', () => {
  const hive = hiveWith({
    tasks: { tasks: [task('a', 'SOMETHING_NEW')] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 1);
  assert.equal(r.tasks.complete, 0);
  assert.equal(r.tasks.completionRate, 0);
});

test('an empty hive reports null rates instead of a confident 0%', () => {
  const hive = hiveWith({ tasks: { tasks: [] }, sessions: { sessions: [] } });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 0);
  assert.equal(r.tasks.completionRate, null, 'no denominator means no rate, not zero');
  assert.equal(r.sessions.staleRate, null);
});

// ------------------------------------------------------------------ per-agent

test('agents are ranked by assigned work and carry their own rates', () => {
  const hive = hiveWith({
    tasks: { tasks: [
      task('busy', 'COMPLETE'), task('busy', 'COMPLETE'), task('busy', 'COMPLETE'),
      task('quiet', 'COMPLETE'), task('quiet', 'QUARANTINED'),
    ] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.agents[0].agentId, 'busy');
  assert.equal(r.agents[0].assigned, 3);
  assert.equal(r.agents[0].completionRate, 1);
  assert.equal(r.agents[1].agentId, 'quiet');
  assert.equal(r.agents[1].quarantineRate, 0.5);
});

test('an agent with no tasks is omitted rather than shown as a failing 0%', () => {
  const hive = hiveWith({
    tasks: { tasks: [task('a', 'COMPLETE')] },
    sessions: { sessions: [session('ghost', 'HEALTHY', 0.1)] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.agents.length, 1);
  assert.ok(!r.agents.some((x) => x.agentId === 'ghost'), 'absence of tasks is not a performance result');
  // But its session health is still counted in the fleet total.
  assert.equal(r.sessions.total, 1);
});

test('lastActivityAt reflects the most recent real timestamp', () => {
  const hive = hiveWith({
    tasks: { tasks: [
      task('a', 'COMPLETE', { created_at: new Date(NOW - 9 * HOUR).toISOString(), completed_at: new Date(NOW - 2 * HOUR).toISOString() }),
    ] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.agents[0].lastActivityAt, new Date(NOW - 2 * HOUR).toISOString());
});

test('a task with no assignee is not silently dropped', () => {
  const hive = hiveWith({
    tasks: { tasks: [task(null, 'COMPLETE')] },
    sessions: { sessions: [] },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 1);
  assert.equal(r.agents[0].agentId, 'unassigned');
});

// ------------------------------------------------------------------- staleness

test('a HEALTHY session with an old heartbeat still counts as stale', () => {
  const hive = hiveWith({
    tasks: { tasks: [] },
    sessions: { sessions: [
      session('a', 'HEALTHY', 0.5),   // 30 min: genuinely alive
      session('a', 'HEALTHY', 72),    // 3 days: labelled healthy, clearly not
    ] },
  });
  const r = computeFleetPerformance({ hive, now: NOW, staleAfterMs: 24 * HOUR });
  assert.equal(r.sessions.healthy, 1);
  assert.equal(r.sessions.stale, 1, 'the label is not taken at face value');
});

test('the staleness threshold is honoured', () => {
  const hive = hiveWith({
    tasks: { tasks: [] },
    sessions: { sessions: [session('a', 'HEALTHY', 5)] },
  });
  assert.equal(computeFleetPerformance({ hive, now: NOW, staleAfterMs: 24 * HOUR }).sessions.stale, 0);
  assert.equal(computeFleetPerformance({ hive, now: NOW, staleAfterMs: HOUR }).sessions.stale, 1);
});

test('an explicit STALE status is stale regardless of heartbeat age', () => {
  const hive = hiveWith({
    tasks: { tasks: [] },
    sessions: { sessions: [session('a', 'STALE', 0.01)] },
  });
  assert.equal(computeFleetPerformance({ hive, now: NOW }).sessions.stale, 1);
});

// ----------------------------------------------------------------------- cost

test('unpriced records are counted, not presented as free', () => {
  const hive = hiveWith({
    tasks: { tasks: [] },
    sessions: { sessions: [] },
    costs: {
      worker: { records: [
        { costUsd: null }, { costUsd: null }, { costUsd: 0.25 },
      ] },
    },
  });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.cost.records, 3);
  assert.equal(r.cost.pricedRecords, 1);
  assert.equal(r.cost.unpricedRecords, 2);
  assert.equal(r.cost.totalUsd, 0.25);
});

// ------------------------------------------------------------------ robustness

test('missing hive files produce zeros, not a crash', () => {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-empty-'));
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 0);
  assert.equal(r.sessions.total, 0);
  assert.equal(r.cost.records, 0);
});

test('corrupt hive files are treated as empty', () => {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-bad-'));
  fs.writeFileSync(path.join(hive, 'tasks.json'), '{oh no');
  fs.writeFileSync(path.join(hive, 'sessions.json'), 'not json at all');
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.tasks.total, 0);
  assert.equal(r.sessions.total, 0);
});

test('a hive path is required rather than silently defaulting to the real one', () => {
  assert.throws(() => computeFleetPerformance({}), /requires opts\.hive/);
});

test('the report is stamped so a stale dashboard is detectable', () => {
  const hive = hiveWith({ tasks: { tasks: [] }, sessions: { sessions: [] } });
  const r = computeFleetPerformance({ hive, now: NOW });
  assert.equal(r.generatedAt, new Date(NOW).toISOString());
  assert.equal(r.staleAfterMs, 24 * HOUR);
});