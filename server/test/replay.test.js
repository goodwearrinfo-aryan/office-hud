'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const replay = require('../lib/replay');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

function hiveWith(tasks, events = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hud-replay-'));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }));
  fs.writeFileSync(path.join(root, 'events.log'), events.map((e) => JSON.stringify(e)).join('\n'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const task = (over) => ({
  task_id: 't', title: 't', status: 'QUEUED',
  created_at: at(60), ...over,
});

test('a task that had not been created is absent', () => {
  assert.equal(replay.taskStateAt(task({ created_at: at(10) }), NOW - 30 * 60000), null);
});

test('a task with no stamps reads as queued', () => {
  assert.equal(replay.taskStateAt(task({ created_at: undefined }), NOW), 'queued');
});

test('status is derived from created/started/completed stamps, not the current field', () => {
  // created 60m ago, started 30m ago, completed 10m ago
  const later = task({ created_at: at(60), started_at: at(30), completed_at: at(10), status: 'COMPLETE' });
  assert.equal(replay.taskStateAt(later, NOW - 50 * 60000), 'queued', 'not started yet');
  assert.equal(replay.taskStateAt(later, NOW - 29 * 60000), 'inProgress', 'just after the start stamp');
  assert.equal(replay.taskStateAt(later, NOW - 15 * 60000), 'inProgress', 'still running');
  assert.equal(replay.taskStateAt(later, NOW - 9 * 60000), 'complete', 'past the completion stamp');
  assert.equal(replay.taskStateAt(later, NOW - 70 * 60000), null, 'before it existed');
});

test('a task quarantined after completing reads as quarantined', () => {
  const quarantined = task({ completed_at: at(10), status: 'QUARANTINED' });
  assert.equal(replay.taskStateAt(quarantined, NOW), 'quarantined');
});

test('a malformed timestamp is ignored rather than producing NaN state', () => {
  assert.equal(replay.taskStateAt(task({ started_at: 'not-a-date' }), NOW), 'queued');
});

test('reconstruct totals the queue as it stood', () => {
  const hive = hiveWith([
    task({ task_id: 'a', created_at: at(120), started_at: at(60), completed_at: at(30), status: 'COMPLETE' }),
    task({ task_id: 'b', created_at: at(90), started_at: at(20) }),
    task({ task_id: 'c', created_at: at(10) }),
    task({ task_id: 'd', created_at: at(200) }),
  ]);
  try {
    const result = replay.reconstruct({ hive: hive.root, when: new Date(NOW - 30 * 60000), now: NOW });
    assert.equal(result.queue.total, 3, 'task c is created 10m ago, so it did not exist 30m ago');
    assert.equal(result.queue.byStatus.complete, 1, 'task a completed 30m ago');
    assert.equal(result.queue.byStatus.queued, 2, 'task b only starts 20m ago; task d never started');
    assert.equal(result.queue.byStatus.inProgress, 0);

    // 15m ago: task c (created 10m ago) still did not exist.
    const mid = replay.reconstruct({ hive: hive.root, when: new Date(NOW - 15 * 60000), now: NOW });
    assert.equal(mid.queue.total, 3);
    assert.equal(mid.queue.byStatus.inProgress, 1, 'task b started 20m ago');

    const after = replay.reconstruct({ hive: hive.root, when: new Date(NOW - 5 * 60000), now: NOW });
    assert.equal(after.queue.total, 4, 'task c was created 10m ago');
    assert.equal(after.queue.byStatus.queued, 2, 'tasks c and d');
  } finally { hive.cleanup(); }
});

test('reconstruct attributes tasks to the agent that owned them', () => {
  const hive = hiveWith([
    task({ task_id: 'a', created_at: at(120), started_at: at(60), claimed_by: 'worker-a' }),
    task({ task_id: 'b', created_at: at(120), started_at: at(50), claimed_by: 'worker-a' }),
    task({ task_id: 'c', created_at: at(120), assigned_agent: 'worker-b' }),
  ]);
  try {
    const result = replay.reconstruct({ hive: hive.root, when: new Date(NOW), now: NOW });
    const workerA = result.queue.perAgent.find((entry) => entry.agent === 'worker-a');
    const workerB = result.queue.perAgent.find((entry) => entry.agent === 'worker-b');
    assert.equal(workerA.inProgress, 2);
    assert.equal(workerB.queued, 1);
  } finally { hive.cleanup(); }
});

test('agent liveness uses the heartbeat window', () => {
  const hive = hiveWith([task({})], [
    { type: 'heartbeat', agent_id: 'fresh', timestamp: at(1) },
    { type: 'heartbeat', agent_id: 'stale', timestamp: at(30) },
    { type: 'heartbeat', agent_id: 'future', timestamp: at(-10) },
  ]);
  try {
    const result = replay.reconstruct({ hive: hive.root, when: new Date(NOW), now: NOW });
    assert.equal(result.agents.aliveCount, 1, 'only the 1m-old heartbeat is inside the 5m window');
    assert.equal(result.agents.alive[0].agent, 'fresh');
  } finally { hive.cleanup(); }
});

test('throughput counts completions per hour inside the window only', () => {
  const hive = hiveWith([task({})], [
    { type: 'task_completed', task_id: 'x', timestamp: at(30) },
    { type: 'task_completed', task_id: 'y', timestamp: at(90) },
    { type: 'task_completed', task_id: 'z', timestamp: at(10 * 60) },
  ]);
  try {
    const result = replay.reconstruct({ hive: hive.root, when: new Date(NOW), windowHours: 3, now: NOW });
    assert.equal(result.throughput.length, 4, 'windowHours + 1 points');
    const total = result.throughput.reduce((sum, point) => sum + point.count, 0);
    assert.equal(total, 2, 'the 10-hour-old completion is outside a 3h window');
  } finally { hive.cleanup(); }
});

test('transitions exclude heartbeats and come newest first', () => {
  const hive = hiveWith([task({})], [
    { type: 'heartbeat', agent_id: 'a', timestamp: at(20) },
    { type: 'task_started', agent_id: 'a', task_id: 't1', timestamp: at(30) },
    { type: 'task_requeued', agent_id: 'a', task_id: 't2', reason: 'stale', timestamp: at(10) },
  ]);
  try {
    const result = replay.reconstruct({ hive: hive.root, when: new Date(NOW), now: NOW });
    assert.equal(result.transitions.length, 2);
    assert.equal(result.transitions[0].type, 'task_requeued');
    assert.equal(result.transitions[0].reason, 'stale');
  } finally { hive.cleanup(); }
});

test('an empty or missing hive yields an empty reconstruction, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hud-empty-'));
  try {
    const result = replay.reconstruct({ hive: root, when: new Date(NOW), now: NOW });
    assert.equal(result.queue.total, 0);
    assert.equal(result.agents.aliveCount, 0);
    assert.equal(result.isLive, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tasks.json that is an array is accepted as well as {tasks: []}', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hud-array-'));
  try {
    fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([task({ created_at: at(30) })]));
    const result = replay.reconstruct({ hive: root, when: new Date(NOW), now: NOW });
    assert.equal(result.queue.total, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('window bounds never invert and default to now', () => {
  const hive = hiveWith([task({})], [{ type: 'heartbeat', agent_id: 'a', timestamp: at(120) }]);
  try {
    const bounds = replay.window(hive.root, NOW);
    assert.ok(bounds.earliest <= bounds.latest);
    assert.equal(bounds.now, NOW);
    assert.equal(bounds.eventsAvailable, 1);
    assert.ok(bounds.stepMs >= 1000);
  } finally { hive.cleanup(); }
});

test('isLive is only true within two seconds of now', () => {
  const hive = hiveWith([task({})]);
  try {
    assert.equal(replay.reconstruct({ hive: hive.root, when: new Date(NOW), now: NOW }).isLive, true);
    assert.equal(replay.reconstruct({ hive: hive.root, when: new Date(NOW - 60000), now: NOW }).isLive, false);
  } finally { hive.cleanup(); }
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
