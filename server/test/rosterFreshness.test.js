'use strict';
// A frozen roster must not read as a live health verdict.
//
// fleet.json is where the agent roster, breaker state, token and dollar
// counters, lastTool and inboxBacklog come from. Nothing in the tree writes it
// any more, and on the live box it had been frozen for close to six hours while
// the HUD presented breaker: "healthy" as a present-tense fact. That is the
// specific failure this HUD exists to avoid: a stored value that looks like a
// current observation.
//
// The distinction pinned here is between the two kinds of field on an agent:
// status and display are derived from a fresh session or a heartbeat inside the
// stale window and stay present-tense; breaker and the counters are inherited
// from the roster and must carry the age of that observation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

const FLEET = path.join(fixture.hive, 'fleet.json');
const HOUR = 3600 * 1000;

const agentRow = (id, over = {}) => ({
  id, name: id, role: 'data', floor: 'pm',
  status: 'healthy', breaker: 'healthy', tokens: 1234, usd: 0.5,
  lastTool: 'grep', inboxBacklog: 3, ...over,
});

function writeFleet(ts, agents) {
  fs.writeFileSync(FLEET, JSON.stringify({ ts, updated_at: ts, agents }));
}

async function summaryFor(id, ts, over) {
  writeFleet(ts, [agentRow(id, over)]);
  const res = await http.get('/api/summary');
  assert.equal(res.status, 200, res.text);
  const agent = (res.json.agents || []).find((a) => a.id === id);
  return { fleet: res.json.fleet, agent };
}

test.before(async () => {
  http = await startTestServer(server.app);
});

test.after(async () => {
  if (http) await http.close();
  fixture.cleanup();
});

test('a fresh roster is reported as live', async () => {
  const { fleet } = await summaryFor('fresh-a', Date.now());
  assert.equal(fleet.stale, false, 'a roster written now is not stale');
  assert.equal(fleet.live, true);
  assert.ok(fleet.age_seconds < 900, `age was ${fleet.age_seconds}`);
  assert.equal(typeof fleet.observed_at, 'number');
});

test('a roster frozen for six hours is labelled stale, with its age', async () => {
  const { fleet } = await summaryFor('stale-a', Date.now() - 6 * HOUR);
  assert.equal(fleet.stale, true, 'a 6h-old roster must not read as live');
  assert.equal(fleet.live, false);
  assert.ok(fleet.age_seconds > 20000, `age was ${fleet.age_seconds}`);
});

test('an unknown observation age is stale, not assumed fresh', async () => {
  writeFleet(null, [agentRow('unknown-a')]);
  const res = await http.get('/api/summary');
  const fleet = res.json.fleet;
  assert.equal(fleet.stale, true, 'an unmeasurable observation is not a fresh one');
  assert.equal(fleet.live, false);
  assert.equal(fleet.age_seconds, null);
});

test('agents carry the age behind breaker and the counters', async () => {
  const { agent } = await summaryFor('stale-b', Date.now() - 6 * HOUR);
  assert.ok(agent, 'the roster agent is still listed');
  assert.equal(agent.rosterStale, true);
  assert.ok(agent.rosterAgeSeconds > 20000, `age was ${agent.rosterAgeSeconds}`);
  assert.equal(typeof agent.rosterObservedAt, 'number');
});

test('a fresh roster marks agents not stale', async () => {
  const { agent } = await summaryFor('fresh-b', Date.now());
  assert.equal(agent.rosterStale, false);
  assert.ok(agent.rosterAgeSeconds < 900);
});

test('roster staleness does not downgrade status, which is live-derived', async () => {
  // The point of labelling is precision, not blanket invalidation. status and
  // display are computed from a fresh session or a recent heartbeat, so a stale
  // roster must not make them read as unknown - it must only mark the inherited
  // fields.
  const { agent } = await summaryFor('stale-c', Date.now() - 6 * HOUR);
  assert.equal(agent.rosterStale, true, 'the roster is still stale');
  assert.ok(
    ['idle', 'busy', 'offline', 'working', 'healthy'].includes(agent.display),
    `unexpected display ${agent.display}`,
  );
  assert.equal(typeof agent.status, 'string');
});
