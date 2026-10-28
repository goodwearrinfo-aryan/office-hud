'use strict';
// Regression test: the dots path must see the local hive's own heartbeat file.
//
// The defect this pins
// -------------------
// /api/agents is served by the ECS in lib/dots, and agentLivenessSystem built
// its session map only from `heartbeat` events in events.log. Measured on this
// machine: none of the last 2000 event lines carried a heartbeat, while seven
// local agents were writing a two-second-old heartbeat into hive/sessions.json.
// So every live local agent rendered `stale` with a PID nobody had checked, and
// hud_guard's corroboration scan found 0 assessable state claims -- the HUD was
// blind to its own running fleet while looking like a fleet that had died.
//
// The second half of the same bug: the session lookup fell back to a truthy
// stand-in object, so all 24 agents reported hasSession=true, and the label for
// a process that measures gone was `stale` ("contact lost") rather than
// `offline` ("gone"). A recorded PID is a claim; os.kill(pid, 0) is a
// measurement, and the measurement has to win.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentLivenessSystem, agentProcessVerificationSystem } = require('../lib/dots/systems/agentSystem');
const { buildAgentsPayload } = require('../lib/dots/index');
const { World } = require('../lib/dots/world');

// Alive and dead by construction, so the test cannot go green by accident:
// the test process is running while it executes, and macOS never allocates a
// pid above kern.maxpid (99999), so 999999 has been dead for as long as it has
// existed.
const LIVE_PID = process.pid;
const DEAD_PID = 999999;

const FLEET = {
  agents: [
    { id: 'F4', name: 'Alpha Researcher', role: 'manager', floor: 'f4' },
    // F6 carries the pid its spawn record remembered, and no session row: the
    // shape a restarted agent leaves behind in days-old telemetry.
    { id: 'F6', name: 'Data Curator', role: 'manager', floor: 'f6', processId: DEAD_PID },
  ],
};

function hiveWith(sessionRows) {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'local-session-truth-'));
  fs.writeFileSync(path.join(hive, 'fleet.json'), JSON.stringify(FLEET));
  fs.writeFileSync(path.join(hive, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
  // No events.log on purpose: this is exactly the shape the fleet writes, a
  // heartbeat in sessions.json and no heartbeat event anywhere.
  return hive;
}

function agentsFrom(hive) {
  const world = new World();
  agentLivenessSystem(world, { hivePath: hive });
  agentProcessVerificationSystem(world);
  const payload = buildAgentsPayload(world);
  fs.rmSync(hive, { recursive: true, force: true });
  return payload.agents;
}

function agentFor(rows, id = 'F4') {
  return agentsFrom(hiveWith(rows)).find(a => a.id === id);
}

function row(over = {}) {
  return {
    session_id: 'sess-local-F4',
    agent_id: 'F4',
    status: 'HEALTHY',
    process_id: LIVE_PID,
    last_heartbeat: new Date().toISOString(),
    ...over,
  };
}

test('a fresh local heartbeat file makes a live agent idle, not stale', () => {
  const agent = agentFor([row()]);

  assert.ok(agent, 'F4 must be in the agents payload');
  assert.equal(agent.evidence.hasSession, true);
  assert.equal(agent.evidence.sessionFresh, true,
    'a sessions.json row two seconds old is fresh, whatever events.log says');
  assert.ok(agent.heartbeatAgeSec != null && agent.heartbeatAgeSec <= 5,
    `heartbeatAgeSec must come from the file, got ${agent.heartbeatAgeSec}`);
  assert.equal(agent.evidence.processLiveness, 'alive');
  assert.equal(agent.evidence.processVerified, true,
    'a PID the server can check is evidence, and withholding it is a lie');
  assert.equal(agent.display, 'idle', 'a live process with no claimed task is idle');
});

test('a fresh row that claims a task renders busy and working', () => {
  const agent = agentFor([row({ current_task_id: 'feed-1-0-abc' })]);

  assert.equal(agent.currentTaskId, 'feed-1-0-abc');
  assert.equal(agent.evidence.hasTask, true);
  assert.equal(agent.display, 'busy');
  assert.equal(agent.status, 'working');
});

test('a measured-dead PID voids the claims on its own row', () => {
  // The window that heartbeat freshness cannot see: the row is still inside the
  // stale window because the writer died minutes ago, so the record says
  // healthy-and-tasked while the process is verifiably gone.
  const agent = agentFor([row({ process_id: DEAD_PID, current_task_id: 'gen-stale-1' })]);

  assert.equal(agent.evidence.processLiveness, 'dead');
  assert.equal(agent.evidence.processVerified, false);
  assert.equal(agent.evidence.hasTask, false,
    'a dead process is not doing the work its last row claims');
  assert.equal(agent.display, 'offline', 'gone is not the same as contact lost');
  assert.equal(agent.status, 'offline',
    'the status field must not claim an active session next to an offline agent');
});

test('an agent with no session record is offline, and says so', () => {
  // F6 has no row at all. The old truthy fallback object made it report
  // hasSession=true and display `stale`, which told the reader contact had been
  // lost with something that had never been in contact.
  const agent = agentFor([row()], 'F6');

  assert.equal(agent.evidence.hasSession, false);
  assert.equal(agent.sessionStatus, null);
  assert.equal(agent.display, 'offline');
});

test('a terminal row does not vouch for work even while it looks recent', () => {
  // STOPPED/DEAD/ERROR/STALE are written by the recovery path for a session that
  // ended. Its current_task_id records what it claimed at the time, not what is
  // running now.
  const agent = agentFor([row({ status: 'STOPPED', current_task_id: 'gen-stale-2' })]);

  assert.equal(agent.evidence.sessionFresh, false, 'a terminal status is never fresh');
  assert.equal(agent.evidence.hasTask, false);
  assert.notEqual(agent.display, 'busy');
});

test('a pid only stale telemetry remembers is not evidence of absence', () => {
  // F6 has no session row. The sole pid is the one fleet.json recorded at spawn
  // time, which on this machine is days old: the agent may have restarted under a
  // new pid, so the old one being gone says nothing about now. Reading it as
  // proof of death turned a working agent into an offline one -- a lie in the
  // pessimistic direction, and the reason a dead pid may only void claims that
  // are older than it, never fresher ones.
  const hive = hiveWith([]);
  const old = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(path.join(hive, 'events.log'), JSON.stringify({
    type: 'task_completed', agent_id: 'F6', task_id: 'gen-old-1', timestamp: old,
  }) + '\n');
  const agent = agentsFrom(hive).find(a => a.id === 'F6');

  assert.equal(agent.processId, DEAD_PID, 'the telemetry pid is still reported');
  assert.equal(agent.evidence.processVerified, false, 'but it verifies nothing');
  assert.equal(agent.heartbeatAgeSec, null, 'no record speaks about now');
  assert.equal(agent.display, 'stale', 'contact lost, not proven gone');
  assert.notEqual(agent.display, 'offline');
});
