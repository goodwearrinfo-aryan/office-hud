'use strict';
// Regression test: a remote PID string must never become healthy evidence.
//
// The defect this pins
// -------------------
// /api/agents and /api/floors read session state from the local hive only, so
// nine agent_manager.js processes living on the mini read as offline. The fix
// merges hive/remote/<host>/terminals.json, whose collector stamps
// process_alive after checking the PID on its own machine.
//
// That fix creates a new way to lie: a remote doc that carries a PID and a
// fresh heartbeat but no host verification could promote a process that does
// not exist. The HUD truth standard says a PID alone is a claim, never
// evidence. So these cases pin the boundary from both sides -- a bare PID must
// NOT be promoted, and a host-verified one must be, each labelled distinctly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentLivenessSystem, agentProcessVerificationSystem } = require('../lib/dots/systems/agentSystem');
const { World } = require('../lib/dots/world');

function fixtureHive(remoteSessions) {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-session-truth-'));
  fs.mkdirSync(path.join(hive, 'remote', 'As-Mac-mini'), { recursive: true });
  fs.writeFileSync(
    path.join(hive, 'fleet.json'),
    JSON.stringify({ agents: [{ id: 'F4', name: 'Alpha Researcher', role: 'manager', floor: 'f4' }] }),
  );
  fs.writeFileSync(path.join(hive, 'sessions.json'), JSON.stringify({ sessions: [] }));
  fs.writeFileSync(
    path.join(hive, 'remote', 'As-Mac-mini', 'terminals.json'),
    JSON.stringify({ host: 'Mac', collected_at: new Date().toISOString(), agent_sessions: remoteSessions }),
  );
  return hive;
}

function runAgent(hive) {
  const world = new World();
  agentLivenessSystem(world, { hivePath: hive });
  agentProcessVerificationSystem(world);
  const rows = [];
  world.forEachAgent((idx, agent) => rows.push(agent));
  fs.rmSync(hive, { recursive: true, force: true });
  return rows.find(a => a.id === 'agent:F4');
}

test('a remote PID with no host verification is NOT promoted to healthy', () => {
  const agent = runAgent(fixtureHive([{
    agent_id: 'F4',
    process_id: 999999, // does not exist anywhere
    status: 'HEALTHY',
    last_heartbeat: new Date().toISOString(),
    // process_alive deliberately absent: a bare PID is a claim, not evidence
  }]));

  assert.ok(agent, 'F4 must be present in the agents payload');
  assert.notEqual(agent.evidence.processLiveness, 'remote-verified',
    'a PID string with no host process_alive must never read remote-verified');
  assert.equal(agent.evidence.processVerified, false,
    'an unverified remote PID must not be marked verified');
  assert.equal(agent.evidence.processLiveness, 'remote-unverified',
    'it must be labelled remote-unverified so the HUD can say so honestly');
});

test('a host-verified remote PID is merged and labelled remote-verified', () => {
  const agent = runAgent(fixtureHive([{
    agent_id: 'F4',
    process_id: 13365,
    status: 'HEALTHY',
    last_heartbeat: new Date().toISOString(),
    process_alive: true,      // stamped by the owning host after os.kill(pid, 0)
    pid_verified_by: 'Mac',   // ...and it says which host checked
  }]));

  assert.equal(agent.evidence.processLiveness, 'remote-verified');
  assert.equal(agent.evidence.processVerified, true);
  assert.equal(agent.evidence.remoteHost, 'As-Mac-mini');
  assert.equal(agent.processId, 13365);
});

test('a remote session past the stale window is ignored entirely', () => {
  const agent = runAgent(fixtureHive([{
    agent_id: 'F4',
    process_id: 13365,
    status: 'HEALTHY',
    last_heartbeat: new Date(Date.now() - 3600_000).toISOString(), // an hour old
    process_alive: true,
    pid_verified_by: 'Mac',
  }]));

  assert.equal(agent.evidence.remoteHost, null,
    'a remote session older than the stale window is not evidence about now');
  assert.equal(agent.evidence.processLiveness, 'no-pid');
});

test('a frozen remote host document is ignored even when its sessions look fresh', () => {
  const hive = fixtureHive([{
    agent_id: 'F4',
    process_id: 13365,
    status: 'HEALTHY',
    last_heartbeat: new Date().toISOString(),
    process_alive: true,
    pid_verified_by: 'Mac',
  }]);
  // Age the host document itself: the sessions inside still look fresh, but the
  // document says when this host last reported. A frozen doc is a host that went
  // quiet, not a host with a live session.
  const docPath = path.join(hive, 'remote', 'As-Mac-mini', 'terminals.json');
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  doc.collected_at = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(docPath, JSON.stringify(doc));

  const agent = runAgent(hive);
  assert.equal(agent.evidence.remoteHost, null, 'a stale host doc must not be consulted');
  assert.equal(agent.evidence.processLiveness, 'no-pid');
});

test('fresher local evidence wins over remote evidence', () => {
  const hive = fixtureHive([{
    agent_id: 'F4',
    process_id: 13365,
    status: 'HEALTHY',
    last_heartbeat: new Date().toISOString(),
    process_alive: true,
    pid_verified_by: 'Mac',
  }]);
  // A local heartbeat one second NEWER than the remote one. The remote session
  // must not overwrite it: two hosts disagreeing is not evidence of liveness.
  fs.writeFileSync(
    path.join(hive, 'sessions.json'),
    JSON.stringify({
      sessions: [{
        session_id: 'sess-local-F4',
        agent_id: 'F4',
        status: 'HEALTHY',
        process_id: 4242,
        last_heartbeat: new Date(Date.now() + 1000).toISOString(),
      }],
    }),
  );

  const agent = runAgent(hive);
  assert.equal(agent.evidence.remoteHost, null, 'local evidence must win, so the remote merge is skipped');
  // The reported PID comes from registry.json/fleet.json, which are the local
  // authorities for process identity. The local sessions.json record above is
  // what the freshness comparison reads; it is deliberately not a PID source,
  // so what matters here is that the REMOTE pid was not adopted.
  assert.notEqual(agent.processId, 13365, 'the remote PID must not be adopted over local evidence');
});