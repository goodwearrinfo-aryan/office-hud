'use strict';
// These test the module directly, not the HTTP endpoint, on purpose.
//
// server/index.js is being refactored repeatedly and a guard written there can
// be deleted by a rewrite that never sees it. The logic and its tests live in
// processTruth.js, so a rewrite of the server cannot quietly take the guarantee
// with it. There is a separate endpoint test that fails if the wiring is lost.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROCESS_STALE_AFTER_S,
  observationAgeSeconds,
  processView,
  redactCommand,
  redactRecord,
} = require('../processTruth');

const NOW = Date.parse('2026-09-28T00:00:00.000Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

test('credential flags are masked in every form we care about', () => {
  const cases = [
    ['zsh --api-key=sk-abc123', /api-key=\*\*\*/],
    ['zsh --token xyz789', /token=\*\*\*/],
    ['sh MY_SECRET=hunter2', /MY_SECRET=\*\*\*/],
    ['node --private-key=deadbeef', /private-key=\*\*\*/],
    ['curl -H "Authorization: Bearer tok123"', /Bearer \*\*\*/],
  ];
  for (const [input, expected] of cases) {
    assert.match(redactCommand(input), expected, `not masked: ${input}`);
  }
});

test('the secret value is gone, not just the flag', () => {
  for (const secret of ['sk-abc123', 'xyz789', 'hunter2', 'deadbeef', 'tok123']) {
    assert.doesNotMatch(redactCommand(`--api-key=${secret}`), new RegExp(secret));
  }
});

test('benign arguments and paths survive, so the view stays useful', () => {
  const cmd = 'sh --port 4096 --verbose /Users/a/app.js';
  assert.equal(redactCommand(cmd), cmd);
  const pidCmd = '/usr/bin/python /Users/a/trading/openalice-fleet/hive/scripts/x.py';
  assert.equal(redactCommand(pidCmd), pidCmd);
});

test('redaction does not invent a command that is not there', () => {
  assert.equal(redactCommand(undefined), undefined);
  assert.equal(redactCommand(null), null);
  assert.equal(redactCommand(''), '');
  assert.equal(redactCommand(42), 42);
  const rec = redactRecord({ pid: 7 });
  assert.equal('command' in rec, false, 'a record with no command must not gain one');
});

test('a fresh live source supports a RUNNING claim', () => {
  const view = processView({
    processes: [{ pid: 1, command: 'sh --api-key=sk-abc', status: 'RUNNING' }],
    collected_at: ago(30),
    source: 'terminals.json',
    live: true,
  }, { now: NOW });

  assert.equal(view.stale, false);
  assert.equal(view.live, true);
  assert.equal(view.observation_age_seconds, 30);
  assert.equal(view.processes[0].status, 'RUNNING');
  assert.doesNotMatch(view.processes[0].command, /sk-abc/);
});

test('an old observation is STALE, and keeps what it actually said', () => {
  const view = processView({
    processes: [{ pid: 1, status: 'RUNNING' }],
    collected_at: ago(4000),
    source: 'terminals.json',
    live: true,
  }, { now: NOW });

  assert.equal(view.stale, true, 'a 4000s-old observation is not live');
  assert.equal(view.processes[0].status, 'STALE');
  assert.equal(view.processes[0].stored_status, 'RUNNING',
    'the stored claim must survive so a view can show what it was');
});

test('a frozen cache is reported as not live even when it looks full', () => {
  const view = processView({
    processes: Array.from({ length: 82 }, (_, i) => ({ pid: i, status: 'RUNNING' })),
    collected_at: null,
    source: 'processes.json (STALE CACHE, no live source)',
    live: false,
  }, { now: NOW });

  assert.equal(view.live, false);
  assert.equal(view.stale, true, 'no measurable age is not a fresh observation');
  assert.equal(view.processes.length, 82);
  assert.ok(view.processes.every((p) => p.status === 'STALE'));
});

test('an unmeasurable age is never treated as fresh', () => {
  for (const collected of [null, undefined, 'not-a-date', '']) {
    const view = processView({ processes: [{ pid: 1, status: 'RUNNING' }], collected_at: collected },
      { now: NOW });
    assert.equal(view.stale, true, `collected_at=${String(collected)} should be stale`);
    assert.equal(view.observation_age_seconds, null);
  }
});

test('the threshold is the one the collector cadence supports', () => {
  assert.ok(PROCESS_STALE_AFTER_S >= 120, 'must exceed the 60s collector cadence');
  const justFresh = processView({ processes: [], collected_at: ago(PROCESS_STALE_AFTER_S - 5) },
    { now: NOW });
  const justStale = processView({ processes: [], collected_at: ago(PROCESS_STALE_AFTER_S + 5) },
    { now: NOW });
  assert.equal(justFresh.stale, false);
  assert.equal(justStale.stale, true);
});

test('age is never negative', () => {
  assert.equal(observationAgeSeconds(ago(-500), NOW), 0);
  assert.equal(observationAgeSeconds(ago(60), NOW), 60);
});
