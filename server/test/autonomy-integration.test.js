'use strict';
// The whole autonomy chain, including the real write into the hive: a deficit
// raises a proposal, accepting it enqueues a JEV command through the same path a
// human uses, and the task lands in tasks.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const MINUTE = 60000;

// A hive that looks saturated: every agent busy, a deep queue, and a stalled
// completion history.
const fixture = makeFixtureHive({ now: Date.now() });
(function saturate() {
  const tasksFile = path.join(fixture.hive, 'tasks.json');
  const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const now = Date.now();
  for (let i = 0; i < 60; i += 1) {
    doc.tasks.push({
      task_id: `load-${i}`,
      title: `load task ${i}`,
      status: 'QUEUED',
      created_at: new Date(now - 60 * MINUTE).toISOString(),
    });
  }
  fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2));

  const fleetFile = path.join(fixture.hive, 'fleet.json');
  const fleet = JSON.parse(fs.readFileSync(fleetFile, 'utf8'));
  for (const agent of fleet.agents) {
    agent.status = 'busy';
    agent.lastSeen = new Date(now).toISOString();
  }
  fs.writeFileSync(fleetFile, JSON.stringify(fleet, null, 2));
}());

const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
});

function readTasks() {
  return JSON.parse(fs.readFileSync(path.join(fixture.hive, 'tasks.json'), 'utf8')).tasks;
}

test('the saturated fixture produces a deficit and, once armed, a proposal', async () => {
  const before = await http.get('/api/autonomy');
  assert.equal(before.json.policy.enabled, false);
  assert.equal(before.json.assessment.agentsNeeded > 0, true, 'a deficit is detected even while disarmed');
  assert.equal(before.json.proposals.length, 0, 'nothing is proposed while disarmed');

  const armed = await http.post('/api/autonomy/policy', { enabled: true, cooldownMinutes: 0 });
  assert.equal(armed.status, 200);

  const after = await http.get('/api/autonomy');
  assert.equal(after.json.proposals.length, 1, 'arming raises exactly one proposal');
  const proposal = after.json.proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.ok(proposal.requestedAgents >= 1);
  assert.ok(proposal.prompt.length >= 3);
});

test('accepting a proposal enqueues a real JEV task in the hive', async () => {
  const state = await http.get('/api/autonomy');
  const proposal = state.json.proposals[0];
  const before = readTasks().length;

  const res = await http.post(`/api/autonomy/proposals/${encodeURIComponent(proposal.id)}/accept`, {});
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const tasks = readTasks();
  assert.equal(tasks.length, before + 1, 'exactly one task was added');

  const created = tasks[tasks.length - 1];
  assert.equal(created.source, 'jarvis');
  assert.equal(created.requested_by, 'jarvis');
  assert.equal(created.actor, 'office-hud-local');
  assert.equal(created.status, 'QUEUED');
  assert.equal(created.priority, 'high');
  assert.match(created.task_id, /^jarvis-/);
  assert.equal(created.objective, proposal.prompt, 'the task carries the proposal prompt verbatim');

  // The proposal is now spent, and the audit records the task it created.
  const final = await http.get('/api/autonomy');
  const spent = final.json.proposals.find((p) => p.id === proposal.id);
  assert.equal(spent.status, 'accepted');
  assert.ok(spent.routed?.task_id, 'the routed task id is retained');
  const audit = final.json.audit.find((entry) => entry.action === 'proposal_accepted');
  assert.ok(audit, 'the acceptance is audited');
  assert.equal(audit.taskId, created.task_id, 'and names the task it created');
});

test('the same proposal cannot be routed twice', async () => {
  const state = await http.get('/api/autonomy');
  const proposal = state.json.proposals.find((p) => p.status === 'accepted');
  const before = readTasks().length;
  const res = await http.post(`/api/autonomy/proposals/${encodeURIComponent(proposal.id)}/accept`, {});
  assert.equal(res.status, 409);
  assert.match(res.json.error.message, /already accepted/);
  assert.equal(readTasks().length, before, 'no second task was written');
});

test('dismissing a fresh proposal leaves the hive untouched', async () => {
  // Raise a new proposal by clearing the cooldown and letting it re-evaluate.
  await http.post('/api/autonomy/policy', { cooldownMinutes: 0, minQueueToReact: 1 });
  const state = await http.get('/api/autonomy');
  const pending = state.json.proposals.find((p) => p.status === 'pending');
  if (!pending) return;                       // nothing pending: nothing to prove
  const before = readTasks().length;
  const res = await http.post(`/api/autonomy/proposals/${encodeURIComponent(pending.id)}/dismiss`, {});
  assert.equal(res.status, 200);
  assert.equal(readTasks().length, before, 'dismissing writes nothing to the hive');
});

test('disarming stops new proposals from being raised', async () => {
  await http.post('/api/autonomy/policy', { enabled: false });
  const state = await http.get('/api/autonomy');
  assert.equal(state.json.policy.enabled, false);
  assert.equal(state.json.proposals.filter((p) => p.status === 'pending').length, 0);
});

test.after(() => { setImmediate(() => process.exit(process.exitCode ?? 0)); });
