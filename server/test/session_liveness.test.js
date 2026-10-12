'use strict';
// A session row outlives the process it describes. Before this was handled, the
// HUD read `current_task_id` from a three-day-old STALE row, labelled the agent
// `busy`, and the stall analyzer raised a critical for a process that was not
// running. agentDisplay.test.js already declares the invariant "idle and busy
// both require a live session", but its fixture hive has no sessions.json, so
// every agent renders offline and the loop asserted nothing. These cases put
// real session rows in front of the rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixtureHive, loadServer } = require('./helpers/harness');
const { analyze } = require('../lib/analyzers');

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** A PID guaranteed not to exist, so `dead` is a fact and not a race. */
function deadPid() {
  for (let pid = 99999; pid > 2; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid found');
}

const fixture = makeFixtureHive();
const DEAD = deadPid();
const ALIVE = process.pid;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function session(agentId, over) {
  return {
    agent_id: agentId,
    session_id: `sess-${agentId}`,
    status: 'RUNNING',
    last_heartbeat: iso(now - 60000),
    ...over,
  };
}

// fresh + task claim  -> busy
// aged + dead pid     -> offline (the process is gone, not unreachable)
// aged + live pid     -> stale  (contact lost, but it is still there)
// fresh + no claim    -> idle
fs.writeFileSync(path.join(fixture.hive, 'registry.json'), JSON.stringify({
  godId: null,
  agents: ['busy-a', 'gone-b', 'aging-c', 'live-d', 'remote-e'].reduce((acc, id) => {
    acc[id] = { id, role: 'worker', floor: 'f1', archived: false };
    return acc;
  }, {}),
}, null, 2));

fs.writeFileSync(path.join(fixture.hive, 'sessions.json'), JSON.stringify({
  sessions: [
    session('busy-a', { current_task_id: 'task-a' }),
    session('gone-b', {
      status: 'STALE',
      current_task_id: 'task-b',
      process_id: DEAD,
      last_heartbeat: iso(now - 3 * DAY),
    }),
    session('aging-c', { status: 'STALE', process_id: ALIVE, last_heartbeat: iso(now - 2 * HOUR) }),
    session('live-d', {}),
    // processIsAlive on another machine's PID always fails, so the remote
    // collector's own verdict has to be authoritative. Without it a live agent
    // on a sleeping laptop reads as dead.
    session('remote-e', {
      status: 'STALE',
      host: 'some-other-mini',
      process_id: DEAD,
      process_alive: true,
      pid_verified_by: 'some-other-mini',
      last_heartbeat: iso(now - 2 * HOUR),
    }),
  ],
}, null, 2));

const server = loadServer(fixture.hive);
const { mergedAgents } = server.internals;
const byId = Object.fromEntries(mergedAgents().map((a) => [a.id, a]));

test('a fresh session may vouch for a task claim', () => {
  assert.equal(byId['busy-a'].display, 'busy');
  assert.equal(byId['busy-a'].evidence.sessionFresh, true);
});

test('a stale session cannot mark a dead agent busy', () => {
  assert.notEqual(byId['gone-b'].display, 'busy', 'stale current_task_id was honoured');
  assert.equal(byId['gone-b'].display, 'offline');
  assert.equal(byId['gone-b'].evidence.processLiveness, 'dead');
  assert.equal(byId['gone-b'].currentTaskId, null);
});

test('a lost-but-running agent is stale, not offline', () => {
  assert.equal(byId['aging-c'].display, 'stale');
  assert.equal(byId['aging-c'].evidence.processLiveness, 'alive');
});

test('a live session with no claimed task is idle', () => {
  assert.equal(byId['live-d'].display, 'idle');
});

test('a dead agent raises no stall alert', () => {
  // The regression in full: this snapshot used to produce
  // `critical: gone-b is busy but silent` for a process stopped three days ago.
  const findings = analyze(
    { summary: { agents: mergedAgents() }, queue: null, breakers: {}, costs: null, services: { services: [] } },
    { now: Date.now() },
  ).filter((f) => f.analyzer === 'stall' && f.agentId === 'gone-b');
  assert.deepEqual(findings.map((f) => f.severity), []);
});

test('a remote-verified session is not judged by a local pid check', () => {
  assert.equal(byId['remote-e'].evidence.processLiveness, 'remote-verified');
  assert.equal(byId['remote-e'].evidence.processVerified, true);
  assert.equal(byId['remote-e'].display, 'stale');
});

test('fixture hive is on disk and not the real one', () => {
  assert.equal(server.internals.HIVE, fixture.hive);
  assert.ok(server.internals.HIVE.startsWith(os.tmpdir()));
});
