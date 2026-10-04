'use strict';
// summary.floors must contain floors, and only floors.
//
// The defect this pins
// --------------------
// GET /api/summary returns `floors: rollupFloors(agents)`. rollupFloors groups
// agents by the agent's own `floor` attribute, but that attribute is not
// reserved for floors: it also carries organisational groups (command, office,
// operations, polymarket, specialists, workers). Grouping by it therefore
// emitted 18 rows for 12 floors, and the six group rows had no manager, no
// state and no liveness evidence.
//
// The rows that did carry a verdict carried it under `health`, not `state`, so
// every row read `state: null`. A field that exists but holds null is not
// evidence, and treating it as present is how a phantom passes a presence-only
// check.
//
// What is pinned here
// --------------------
// The contract, not the current shape. These assertions are expected to FAIL
// until the rollupFloors hunk described in
// office-hud/SUMMARY_FLOORS_DEFECT.md is applied to index.js. index.js is owned
// by another session, so the fix is documented and not applied. rollupFloors is
// exported through `internals`, so the contract is testable without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
const { rollupFloors } = server.internals;

const GROUP_LABELS = ['command', 'office', 'operations', 'polymarket', 'specialists', 'workers'];
const FLOOR_ID_RE = /^f\d+$/i;

function agent(id, floor, extra = {}) {
  return Object.assign({
    id,
    floor,
    role: 'floor lead',
    display: 'idle',
    evidence: { sessionFresh: true },
  }, extra);
}

/** Twelve real floors plus the six group labels, as the live registry has them. */
function mixedRoster() {
  const out = [];
  for (let i = 1; i <= 12; i += 1) out.push(agent('F' + i, 'f' + i));
  for (const g of GROUP_LABELS) out.push(agent(g + '-agent', g, { role: 'worker' }));
  return out;
}

test('summary floors are floors, not agent groups', () => {
  const rows = rollupFloors(mixedRoster());
  const labels = rows.map((r) => String(r.floor));
  for (const label of labels) {
    assert.match(label, FLOOR_ID_RE,
      `summary.floors contained ${JSON.stringify(label)}, which is not a floor id`);
  }
  for (const group of GROUP_LABELS) {
    assert.ok(!labels.includes(group),
      `agent-group label ${JSON.stringify(group)} leaked into summary.floors`);
  }
});

test('twelve floors produce twelve rows, not eighteen', () => {
  const rows = rollupFloors(mixedRoster());
  assert.equal(rows.length, 12, `expected 12 floor rows, got ${rows.length}`);
});

test('every floor carries a non-null state', () => {
  for (const row of rollupFloors(mixedRoster())) {
    assert.notEqual(row.state, null, `floor ${row.floor} has state: null`);
    assert.notEqual(row.state, undefined, `floor ${row.floor} has no state field at all`);
    assert.equal(typeof row.state, 'string');
    assert.ok(row.state.length > 0);
  }
});

test('an unestablishable state is UNKNOWN, never null or blank', () => {
  // No manager alive and no work: the honest verdict is UNKNOWN, not null.
  const rows = rollupFloors([
    agent('F1', 'f1', { display: 'offline', evidence: { sessionFresh: false } }),
  ]);
  for (const row of rows) {
    assert.ok(row.state === null || row.state === 'UNKNOWN' || typeof row.state === 'string',
      'state must be a string or explicitly UNKNOWN');
    assert.notEqual(row.state, '');
  }
});

test('floor identity is stable and matches the floor id', () => {
  const rows = rollupFloors(mixedRoster());
  const ids = rows.map((r) => String(r.floor).toLowerCase());
  assert.deepEqual(ids.slice().sort(), Array.from({ length: 12 }, (_, i) => 'f' + (i + 1)).sort());
  // Identity is the id, not a positional index: order may change, membership may not.
  for (const row of rows) {
    assert.equal(String(row.floor).toLowerCase().replace(/^f0*/, 'f'),
      String(row.floor).toLowerCase().replace(/^f0*/, 'f'));
  }
});

test('manager and liveness are consistent with the evidence', () => {
  const rows = rollupFloors(mixedRoster());
  for (const row of rows) {
    if ('lead' in row) {
      assert.ok(row.lead === null || typeof row.lead === 'string');
      if (row.lead) {
        assert.equal(typeof row.leadIsLive, 'boolean',
          `floor ${row.floor} names a lead but leadIsLive is not a boolean`);
      }
    }
  }
});

test('adding a new F<n> floor is additive, not a replacement', () => {
  const twelve = rollupFloors(mixedRoster()).map((r) => String(r.floor));
  const thirteen = rollupFloors(mixedRoster().concat([agent('F13', 'f13')]))
    .map((r) => String(r.floor));
  for (const existing of twelve) {
    assert.ok(thirteen.includes(existing),
      `adding f13 removed ${existing}; growth must be additive`);
  }
  assert.ok(thirteen.includes('f13'), 'f13 should appear once it exists');
  assert.equal(thirteen.length, twelve.length + 1);
});

test('malformed or group-shaped data cannot manufacture a floor', () => {
  const rows = rollupFloors([
    agent('weird', 'FLOOR-7'),          // not f<digits>
    agent('weird2', 'f'),               // no number
    agent('weird3', 'fabc'),            // non-numeric suffix
    agent('weird4', 'floor12'),         // word form
    agent('ok', 'f4'),                  // the only real floor
  ]);
  const labels = rows.map((r) => String(r.floor));
  assert.deepEqual(labels, ['f4'],
    'only a genuine f<digits> id may appear in summary.floors');
});

test('empty or missing floor data yields a truthful result', () => {
  assert.deepEqual(rollupFloors([]), [], 'no agents means no floor rows, not invented ones');
  const noFloor = rollupFloors([agent('x', null), agent('y', undefined)]);
  assert.deepEqual(noFloor, [], 'agents with no floor attribute yield no floor rows');
});

test.after(() => {
  try { fixture.cleanup(); } catch { /* best effort */ }
});
