'use strict';
// The blocked-tasks contract, pinned.
//
// This file exists because a dependency-blocked task previously had nowhere to
// appear: getQueueSummary() had no `blocked` count and no `blockedTasks` list, so
// a task parked by the dependency engine simply disappeared between QUEUED and
// claimable. Worse, once the fields were added, the web type declared
// `waiting_on` and `blocked_at` while the server emitted `blocked_since` — so
// the mismatch type-checked cleanly and resolved to undefined at runtime.
//
// The reason assertions are the load-bearing ones. A count of 0 proves nothing
// on a hive that happens to have no blocked tasks; what matters is that when a
// reason is absent from the record, this reports that honestly instead of
// inventing a cause. A fabricated reason reads like knowledge the system does not
// have, and an operator acting on it would be acting on a fiction.
//
// ONE fixture hive for the whole file, on purpose. loadServer() sets HIVE and
// then require()s the server, so the module is cached and the first hive wins —
// a second loadServer() call silently returns the first hive's data. Every case
// therefore lives in the single hive below rather than in its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadServer } = require('./helpers/harness');

function task(extra = {}) {
  return {
    task_id: `todo-${Math.random().toString(16).slice(2, 10)}`,
    title: 'a task',
    status: 'BLOCKED',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 600000).toISOString(),
    assigned_agent: 'worker-a',
    ...extra,
  };
}

const blockedTasks = [
  // The reason is recorded outright.
  task({ task_id: 'b-explicit', title: 'explicit reason', blocked_reason: 'waiting on the schema freeze' }),
  // A dependency list is enough to say what is blocking it.
  task({ task_id: 'b-deps', title: 'has deps', depends_on: ['todo-aaa', 'todo-bbb'] }),
  // A long list, to prove the tail is summarised instead of spelled out.
  task({
    task_id: 'b-many-deps',
    title: 'many deps',
    depends_on: Array.from({ length: 9 }, (_, i) => `todo-${i}`),
  }),
  // Neither. The record is genuinely silent, and the report must be too.
  task({ task_id: 'b-silent', title: 'no reason at all' }),
];

// 80 more, to prove the list is capped while the count stays truthful.
const flood = Array.from({ length: 80 }, (_, i) => task({ task_id: `b-flood-${i}`, blocked_reason: 'stuck' }));

const other = [
  // Not blocked, and must not appear in the list or inflate queue depth.
  task({ task_id: 'q-normal', title: 'queued', status: 'QUEUED' }),
  task({ task_id: 'i-wip', title: 'in progress', status: 'IN_PROGRESS' }),
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-blocked-'));
const hive = path.join(root, 'hive');
fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
fs.mkdirSync(path.join(hive, 'lib', 'llm'), { recursive: true });
fs.writeFileSync(path.join(hive, 'tasks.json'), JSON.stringify({
  tasks: [...blockedTasks, ...flood, ...other],
}, null, 2));
fs.writeFileSync(path.join(hive, 'work_events.jsonl'), '');

const { getQueueSummary } = loadServer(hive).internals;
const q = getQueueSummary();
const listed = new Map(q.blockedTasks.map((t) => [t.task_id, t]));
const find = (id) => q.blockedTasks.find((t) => t.task_id === id);

// ------------------------------------------------------------------- counting

test('the queue counts dependency-blocked tasks', () => {
  assert.equal(typeof q.blocked, 'number', 'queue summary is missing blocked');
  assert.ok(Array.isArray(q.blockedTasks), 'queue summary is missing blockedTasks');
  assert.equal(q.blocked, 84, '4 explicit cases + 80 flooding');
});

test('the count is never lower than the number of tasks listed', () => {
  assert.ok(
    q.blocked >= q.blockedTasks.length,
    'a count below the list length would mean some blocked tasks are invisible',
  );
});

test('only BLOCKED tasks are listed', () => {
  assert.equal(find('q-normal'), undefined, 'a QUEUED task must not appear as blocked');
  assert.equal(find('i-wip'), undefined, 'an IN_PROGRESS task must not appear as blocked');
  assert.equal(q.queued, 1, 'the one QUEUED task still counts as queued');
});

test('the blocked list is capped, and the count stays truthful when it is', () => {
  assert.equal(q.blockedTasks.length, 50, 'the list is capped so a stuck dependency cannot flood the payload');
  assert.equal(q.blocked, 84, 'the count still reports the true total, not the capped length');
});

// -------------------------------------------------------------------- reasons

test('a recorded reason is reported verbatim', () => {
  assert.equal(find('b-explicit')?.reason, 'waiting on the schema freeze');
});

test('a dependency list is reported as unmet dependencies', () => {
  const reason = find('b-deps')?.reason;
  assert.match(reason, /2 unmet dependency/);
  assert.match(reason, /todo-aaa/);
  assert.match(reason, /todo-bbb/);
});

test('a long dependency list is truncated rather than dumped whole', () => {
  const reason = find('b-many-deps')?.reason;
  assert.match(reason, /9 unmet dependency/);
  assert.match(reason, /\+6 more/, 'the tail should be summarised, not spelled out');
  assert.ok(reason.length < 200, `reason stayed readable (got ${reason.length} chars)`);
});

test('an absent reason is reported as absent, never invented', () => {
  // The whole point of this file. A fabricated cause is worse than a blank: it
  // reads like knowledge the system does not have.
  assert.equal(find('b-silent')?.reason, 'blocked with no reason recorded');
});

test('every listed task carries a non-empty reason', () => {
  for (const t of q.blockedTasks) {
    assert.ok(t.task_id, 'a blocked task must carry its id');
    assert.ok(t.title, 'a blocked task must carry a title');
    assert.ok(t.reason, `blocked task ${t.task_id} must say why it is waiting`);
  }
});

// ---------------------------------------------------------------------- shape

test('the shape matches what the web type declares, with no phantom fields', () => {
  // web/src/api.ts declares exactly: task_id, title, assigned_agent, reason,
  // blocked_since. It previously declared waiting_on and blocked_at, which the
  // server never sent, so both resolved to undefined at runtime while
  // type-checking cleanly.
  for (const t of q.blockedTasks) {
    assert.ok('blocked_since' in t, 'blocked_since is declared, so it must be sent');
    assert.equal(t.waiting_on, undefined, 'waiting_on is a phantom field and must not reappear');
    assert.equal(t.blocked_at, undefined, 'blocked_at is a phantom field and must not reappear');
  }
  const sent = Object.keys(q.blockedTasks[0]).sort();
  assert.deepEqual(
    sent,
    ['assigned_agent', 'blocked_since', 'reason', 'task_id', 'title'],
    'the server sends exactly the declared members and nothing more',
  );
});

test('blocked_since falls back through updated_at, so it is never blank', () => {
  for (const t of q.blockedTasks) {
    assert.ok(t.blocked_since, `${t.task_id} should report when it became blocked`);
  }
});