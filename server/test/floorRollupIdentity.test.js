'use strict';

// Regression cover for the empty summary floor rollup.
//
// Observed on this host: /api/summary answered floors: 0 while every floor lead
// was present in the roster and /api/floors (the probe-grade route) still
// reported all twelve. Nothing errored, nothing warned -- the rollup simply went
// empty, which is the failure mode a dashboard cannot detect on its own.
//
// Cause: registry.json stopped carrying a `floor` attribute on any of its 66
// agents, and the per-agent status files that do mention a floor emit the
// literal placeholder "unknown". The one per-agent fact still available is that a
// floor lead's agent id IS the floor (F1..F12). These tests pin that resolution
// so the rollup cannot silently re-empty, and pin the guardrails that stop the
// id fallback from promoting organisational groups into floors.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../index.js');
const { rollupFloors, resolveFloorId } = server.internals;

function agent(over = {}) {
  return {
    id: 'worker', role: 'worker', display: 'idle', archived: false,
    evidence: { hasSession: true, sessionFresh: true, hasTask: false },
    ...over,
  };
}

test('a lead is found by agent id when the roster carries no floor attribute', () => {
  // This is the live shape: no `floor` key at all, which is what registry.json
  // looks like now.
  const rows = rollupFloors([
    agent({ id: 'F3', role: 'floor lead', display: 'idle' }),
  ]);
  assert.equal(rows.length, 1, 'a present, accountable lead must produce a floor row');
  assert.equal(rows[0].floor, 'f3');
  assert.equal(rows[0].lead, 'F3');
});

test('the twelve floor leads roll up even with no floor attribute anywhere', () => {
  const leads = Array.from({ length: 12 }, (_, i) =>
    agent({ id: `F${i + 1}`, role: 'floor lead', display: 'idle' }));
  const rows = rollupFloors(leads);
  assert.equal(rows.length, 12);
  // The rollup sorts floors numerically, not lexicographically, so f10 lands
  // after f9 rather than after f1.
  assert.deepEqual(rows.map(r => r.floor), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => `f${n}`));
});

test('an id-derived floor and an attribute-derived one do not split into two rows', () => {
  const rows = rollupFloors([
    agent({ id: 'F3', role: 'floor lead', floor: undefined }),
    agent({ id: 'x1', role: 'worker', floor: 'F3' }),
  ]);
  assert.equal(rows.length, 1, 'case must not create f3 and F3 as separate floors');
  assert.equal(rows[0].agents, 2);
});

test('the "unknown" placeholder falls through to the id instead of becoming a floor', () => {
  assert.equal(resolveFloorId(agent({ id: 'F10', floor: 'unknown' })), 'f10');
});

test('organisational groups are still not promoted into floors', () => {
  // The id fallback must not become a back door around the rule that a floor id
  // is f<digits>. PM-* are agent groups, not floors.
  for (const id of ['PM-AUDIT', 'PM-RISK', 'office-manager', 'specialist-22', 'mainbot', 'god']) {
    assert.equal(resolveFloorId(agent({ id })), null, `${id} must not resolve to a floor`);
  }
});

test('an explicit group-valued floor attribute stays excluded', () => {
  assert.equal(resolveFloorId(agent({ id: 'x', floor: 'operations' })), null);
  assert.equal(resolveFloorId(agent({ id: 'x', floor: 'command' })), null);
});

test('the id fallback does not invent membership for unattributed agents', () => {
  // Specialists carry no floor reference anywhere in the current hive state, so
  // they must remain uncounted rather than being attached to a floor by guess.
  const rows = rollupFloors([
    agent({ id: 'F3', role: 'floor lead', display: 'idle' }),
    agent({ id: 'backend-specialist', role: 'worker', display: 'busy' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agents, 1, 'only the lead is attributable; the specialist is not');
  assert.equal(rows[0].working, 0);
});

test('a stale lead recovered by id is flagged, not counted as live', () => {
  const rows = rollupFloors([
    agent({ id: 'F7', role: 'floor lead', display: 'stale', evidence: { hasSession: true, sessionFresh: false, hasTask: false } }),
  ]);
  assert.equal(rows[0].lead, 'F7');
  assert.equal(rows[0].leadIsLive, false);
});

test('a lead whose role is absent is still counted as a member, but claims no lead', () => {
  const rows = rollupFloors([agent({ id: 'F9', role: 'worker', display: 'idle' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agents, 1);
  assert.equal(rows[0].lead, null);
});

test('an empty roster still yields no floors', () => {
  assert.deepEqual(rollupFloors([]), []);
});