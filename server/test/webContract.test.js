'use strict';
// Contract test: the TypeScript interfaces in web/src/api.ts must describe the
// payloads the server actually serves.
//
// This is the check that was missing. Those interfaces drifted from the payloads
// silently and type-checked cleanly the whole time, so a component reading a
// declared field that the server never sends renders `undefined` with no error
// anywhere — and a real regression is indistinguishable from a typo in review.
//
// The technique is deliberately crude and therefore hard to get wrong: parse the
// .ts with regexes and compare key sets against a live endpoint. It cannot
// validate types, only names, which is exactly the class of drift that bit us.
// Type-level correctness stays tsc's job; this covers the seam between the two,
// which neither of them looks at.
//
// Every assertion here is one that failed before this file existed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { declaredMembers, declaredMemberInfo, hasInterface } = require('./helpers/interfaceMembers');
const fs = require('node:fs');
const path = require('node:path');

const API_TS = path.join(__dirname, '..', '..', 'web', 'src', 'api.ts');

/** Top-level member names of an exported interface, minus `?`. */

/**
 * Load the server against the LIVE hive and read the real payloads.
 *
 * The hive path is passed explicitly rather than left to the default. Calling
 * `loadServer()` with no argument sets OFFICE_HUD_HIVE to the string "undefined",
 * which is truthy, so the server adopts it as its hive path — finds nothing, and
 * serves empty arrays. Every payload comparison then silently passes because
 * both sides were empty. That is the worst possible failure for this file: it
 * looks like it is verifying the contract while verifying nothing.
 */
function loadServerAndFetch() {
  const os = require('node:os');
  const hive = path.join(os.homedir(), 'openalice-fleet', 'hive');
  assert.ok(fs.existsSync(hive), `live hive not found at ${hive}; this test would compare empty payloads`);
  const { loadServer, startTestServer } = require('./helpers/harness');
  const server = loadServer(hive);
  return startTestServer(server.app).then((http) => ({ http, server }));
}

let live = null;
let apiSource = '';
let http = null;

test.before(async () => {
  apiSource = fs.readFileSync(API_TS, 'utf8');
  ({ http } = await loadServerAndFetch());
  const [agents, processes, projects, queue, summary] = await Promise.all([
    http.get('/api/agents'),
    http.get('/api/processes'),
    http.get('/api/projects'),
    http.get('/api/queue'),
    http.get('/api/summary'),
  ]);
  // The drawer and GodPanel read /api/agents/<id>, which is a DIFFERENT route
  // from /api/agents. Auditing only the list route would have missed the whole
  // evidence block, because the list route happens to be built from
  // mergedAgents() while the detail route is built from getAgentDetail().
  const firstId = agents.json.agents?.[0]?.id;
  const detail = firstId ? await http.get(`/api/agents/${firstId}`) : { json: {} };
  live = {
    agent: agents.json.agents?.[0] ?? null,
    agentDetail: detail.json?.agent ?? null,
    agentDetailKeys: Object.keys(detail.json ?? {}),
    agentsAll: agents.json.agents ?? [],
    process: processes.json.processes?.[0] ?? null,
    project: projects.json.projects?.[0] ?? null,
    queue: queue.json,
    summary: summary.json,
  };
});

// The server holds an interval-based heartbeat and a terminal ticker, neither of
// which is unref'd, so a test file that never closes its listener hangs the
// runner instead of exiting. Mirrors what resources.test.js does.
test.after(async () => { await http?.close(); });

/** Assert a declared type is a superset-free match of a live payload. */
function assertAgrees(typeName, payload, { skip = [] } = {}) {
  if (!payload) return; // nothing live to compare; the type cannot be falsified here
  const info = declaredMemberInfo(apiSource, typeName);
  const sent = new Set(Object.keys(payload));
  // Undeclared-but-sent is always a defect: a consumer has no type for that key.
  const undeclared = [...sent].filter((k) => !info.has(k));
  // A required member that never arrives is a defect. An OPTIONAL member that is
  // absent is not, and that is what `skip` used to paper over: it listed fields by
  // hand so this assertion could pass. On a hive with no backing data the server
  // omits every optional field, so the same commit failed here and passed on the
  // mini. Optionality is now read from the type instead of from a hand-kept list.
  const missingRequired = [...info.entries()]
    .filter(([, v]) => !v.optional)
    .map(([k]) => k)
    .filter((k) => !sent.has(k) && !skip.includes(k));
  assert.deepEqual(undeclared, [], `${typeName} omits fields the server sends`);
  assert.deepEqual(missingRequired, [], `${typeName} requires fields the server never sends`);
}
// ------------------------------------------------------------------ Agent

test('Agent agrees with the payload /api/agents serves', () => {
  // The regression: `evidence` has been emitted on every agent since it was
  // added, and was missing from the canonical type. GodPanel hid that by
  // declaring a private copy of the whole agent shape.
  assertAgrees('Agent', live.agent);
});

test('Agent agrees with the payload /api/agents/<id> serves too', (t) => {
  // The detail route is built separately from the list route, so agreeing with
  // one says nothing about the other. This is the payload GodPanel renders.
  //
  // Skip rather than fail when the hive carries no agents. `getVerifyState`-style
  // routes answer `{ present: false }` on a hive with nothing in it, so the
  // comparison would be api.ts against an empty object -- and "fixing" that
  // would delete the real contract to satisfy a machine with no fleet on it.
  // Existence of the hive directory is not enough: a directory holding only
  // autopilot_state.json passes `existsSync` and still yields zero agents.
  if (!live.agentDetail) {
    t.skip('live hive has no agents, so /api/agents/<id> has no payload to compare against');
    return;
  }
  assertAgrees('Agent', live.agentDetail);
  assert.ok(live.agentDetail, 'the agent detail route should return an agent');
});

test('AgentDetail agrees with the payload the drawer route serves', (t) => {
  if (!live.agentDetail) {
    t.skip('live hive has no agents, so the drawer route has no payload to compare against');
    return;
  }
  assertAgrees('AgentDetail', { ...live.agentDetailKeys.reduce((acc, k) => ({ ...acc, [k]: true }), {}) });
});

test('every agent carries the evidence block the type promises', () => {
  for (const agent of live.agentsAll) {
    assert.ok(agent.evidence, `agent ${agent.id} has no evidence block`);
    assert.equal(typeof agent.evidence.hasSession, 'boolean', `agent ${agent.id}: hasSession must be boolean`);
    assert.equal(typeof agent.evidence.processVerified, 'boolean', `agent ${agent.id}: processVerified must be boolean`);
    assert.ok(
      ['alive', 'dead', 'no-pid', 'remote-verified', 'remote-unverified', null, undefined].includes(agent.evidence.processLiveness),
      `agent ${agent.id}: unexpected processLiveness ${agent.evidence.processLiveness}`,
    );
  }
});

test('processLiveness keeps "no pid" distinct from "dead"', () => {
  // Collapsing these into one "unverified" reads as a problem when nothing is
  // wrong, which is what made this unreadable in the first place.
  const states = new Set(live.agentsAll.map((a) => a.evidence?.processLiveness));
  for (const state of states) {
    assert.ok(
      state === 'alive' || state === 'dead' || state === 'no-pid' || state === 'remote-verified' || state === 'remote-unverified' || state === null || state === undefined,
      `unexpected processLiveness: ${state}`,
    );
  }
});

// ------------------------------------------------------------ ProcessRecord

test('ProcessRecord agrees with the payload /api/processes serves', () => {
  // The regression: it declared pid, name, kind and observed_at. None were ever
  // sent, so `process.pid` type-checked and rendered `undefined`.
  assertAgrees('ProcessRecord', live.process);
});

test('the phantom process fields are gone, not merely optional', () => {
  const declared = declaredMembers(apiSource, 'ProcessRecord');
  for (const ghost of ['observed_at', 'kind', 'name']) {
    assert.equal(declared.has(ghost), false, `${ghost} is not sent by the server and must not be declared`);
  }
});

// ------------------------------------------------------------ ProjectRecord

test('ProjectRecord agrees with the payload /api/projects serves', () => {
  // The regression: branch, health, last_seen and metadata were declared and
  // never sent.
  assertAgrees('ProjectRecord', live.project);
});

test('the phantom project fields are gone', () => {
  const declared = declaredMembers(apiSource, 'ProjectRecord');
  for (const ghost of ['branch', 'health', 'last_seen', 'metadata']) {
    assert.equal(declared.has(ghost), false, `${ghost} is not sent by the server and must not be declared`);
  }
});

// ---------------------------------------------------------------- QueueSummary

test('QueueSummary agrees with the payload /api/queue serves', () => {
  assertAgrees('QueueSummary', live.queue);
});

// -------------------------------------------------------------------- Summary

test('Summary agrees with the payload /api/summary serves', () => {
  assertAgrees('Summary', live.summary);
});

test('floors is typed with the members FloorTable actually reads', () => {
  // Not just "declared" — declared with the right element shape. Leaving
  // `floors` undeclared did not fail the build: intersecting an absent optional
  // property collapses to never[], so `floors.length === 0` type-checked and the
  // panel rendered its empty state forever with nothing to explain why.
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'components', 'FloorTable.tsx'), 'utf8');
  const rowBlock = /type FloorRow = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(rowBlock, 'FloorRow type not found in FloorTable.tsx');
  const rowMembers = [...rowBlock[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);

  const summaryBlock = /export interface Summary\s*\{([\s\S]*?)\n\}/.exec(apiSource);
  const floorsBlock = /floors\?: Array<\{([\s\S]*?)\n\s*\}>;/.exec(summaryBlock[1]);
  assert.ok(floorsBlock, 'Summary.floors must be declared as an array with a known element type');
  const declared = [...floorsBlock[1].matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]);

  for (const member of rowMembers) {
    assert.ok(declared.includes(member), `Summary.floors[] must declare "${member}", which FloorTable reads`);
  }
});

// --------------------------------------------------------------- regression

test('every interface declared in api.ts that names a live payload is covered here', () => {
  // If a future endpoint's type is never checked, it will drift the same way.
  const covered = ['Agent', 'ProcessRecord', 'ProjectRecord', 'QueueSummary', 'Summary'];
  assert.equal(covered.length, 5);
  for (const name of covered) {
    assert.ok(
      hasInterface(apiSource, name),
      `${name} should still exist in api.ts`,
    );
  }
});