'use strict';
// The runner is where the autopilot meets reality, so these tests cover the two
// places it could quietly lie to the operator:
//
//   1. The failure baseline. If a new failure can be absorbed into the baseline,
//      the autopilot will happily report a green run on a red suite. Every
//      regression path here is a test.
//   2. readState's dirtyFiles semantics. It counts *our* leftovers, not the
//      operator's dirty checkout — that is a deliberate reading of the gate, so
//      it is asserted explicitly rather than left as folklore.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunner, parseSuite, decideBaseline } = require('../lib/autopilot_runner.js');

function tmpHive() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-runner-hive-'));
}

function runner(overrides = {}) {
  const hive = overrides.hive || tmpHive();
  return createRunner({
    repo: overrides.repo || os.homedir(),
    hive,
    park: overrides.park || fs.mkdtempSync(path.join(os.tmpdir(), 'ap-runner-park-')),
    ref: 'origin/main',
    now: overrides.now || (() => 1_700_000_000_000),
    ...overrides,
  });
}

// ---------------------------------------------------------------- suite parsing

test('parseSuite reads the counts and the failing test names', () => {
  const out = [
    'not ok 16 - the queue reports dependency-blocked tasks',
    'not ok 149 - truthfulness: verified completions',
    '# tests 362', '# pass 355', '# fail 7',
  ].join('\n');
  const parsed = parseSuite(out);
  assert.equal(parsed.tests, 362);
  assert.equal(parsed.pass, 355);
  assert.equal(parsed.fail, 7);
  assert.deepEqual(parsed.failures, [
    'the queue reports dependency-blocked tasks',
    'truthfulness: verified completions',
  ]);
});

test('parseSuite returns null on output it does not understand, rather than guessing', () => {
  assert.equal(parseSuite('Error: cannot find module express'), null);
  assert.equal(parseSuite('# tests 10'), null, 'a partial summary is not parsed as a whole');
});

test('a suite with zero failures parses to an empty failure list', () => {
  const parsed = parseSuite('# tests 10\n# pass 10\n# fail 0\n');
  assert.deepEqual(parsed.failures, []);
  assert.equal(parsed.fail, 0);
});

// ------------------------------------------------------------- baseline policy

test('a fresh state has no baseline, so the first run will seed one', () => {
  const r = runner();
  const state = r.loadState();
  assert.equal(state.baselineFailures, undefined, 'absent, not an empty list pretending to be known');
  assert.equal(decideBaseline(state.baselineFailures, ['alpha']).action, 'seed');
});

test('decideBaseline seeds on the first run and adopts what it saw', () => {
  const d = decideBaseline(null, ['beta', 'alpha']);
  assert.equal(d.action, 'seed');
  assert.deepEqual(d.baseline, ['alpha', 'beta'], 'stored sorted so the file is stable');
  assert.deepEqual(d.newFailures, [], 'seeding is not a regression');
});

test('decideBaseline accepts a run whose failures are a subset of the baseline', () => {
  const d = decideBaseline(['alpha', 'beta'], ['alpha']);
  assert.equal(d.action, 'accept');
  assert.deepEqual(d.newFailures, []);
  assert.deepEqual(d.baseline, ['alpha', 'beta'], 'a clean run does not shrink the baseline');
});

test('decideBaseline rejects a NEW failure and never absorbs it', () => {
  const d = decideBaseline(['alpha'], ['alpha', 'gamma']);
  assert.equal(d.action, 'reject');
  assert.deepEqual(d.newFailures, ['gamma']);
  assert.deepEqual(d.baseline, ['alpha'], 'the baseline is returned unchanged, not widened');
});

test('an empty observed set against an empty baseline is an accept, not a seed', () => {
  const d = decideBaseline([], []);
  assert.equal(d.action, 'accept');
});

test('a fully green suite against a non-empty baseline still accepts', () => {
  const d = decideBaseline(['alpha', 'beta'], []);
  assert.equal(d.action, 'accept', 'failures disappearing is good news, not a reason to reseed');
  assert.deepEqual(d.baseline, ['alpha', 'beta'], 'and the baseline is left for the record');
});

test('patchState preserves keys it does not know about', () => {
  const r = runner();
  r.patchState({ customThing: 'keep me' });
  r.patchState({ anotherThing: 1 });
  const state = r.loadState();
  assert.equal(state.customThing, 'keep me');
  assert.equal(state.anotherThing, 1);
  assert.equal(state.version, 1);
});

test('a corrupt state file reads as empty rather than crashing the server', () => {
  const hive = tmpHive();
  fs.writeFileSync(path.join(hive, 'autopilot_state.json'), '{not json');
  const r = runner({ hive });
  assert.deepEqual(r.loadState(), {});
  // And a restore onto an autopilot must not throw.
  const ap = r.createAutopilot();
  assert.deepEqual(ap.proposals, []);
});

// ------------------------------------------------------------------- readState

test('readState counts leftover worktrees as dirty, not the operator checkout', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rs-repo-'));
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: repo, stdio: 'ignore' });
  // Make the operator's tree genuinely dirty.
  fs.writeFileSync(path.join(repo, 'f'), 'operator is mid-edit\n');

  const park = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rs-park-'));
  const r = runner({ repo, park, hive: tmpHive() });
  const state = await r.readState();

  assert.ok(state.sharedTreeDirty > 0, "the operator's dirtiness is still visible");
  assert.equal(state.dirtyFiles, 0, 'but it does not close the gate — we reason in our own tree');
});

test('readState reports a leftover worktree as dirty, which does close the gate', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rs2-repo-'));
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  const park = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rs2-park-'));
  fs.mkdirSync(path.join(park, 'crashed-last-run'), { recursive: true });

  const r = runner({ repo, park, hive: tmpHive() });
  const state = await r.readState();
  assert.equal(state.dirtyFiles, 1, 'a crashed run leaves evidence and we refuse to build on it');
});

test('cooldown is measured from the newest proposal of any state', async () => {
  const r = runner();
  const ap = r.createAutopilot();
  ap.proposals = [
    { id: 'ap-1', state: 'landed', createdAt: 500 },
    { id: 'ap-2', state: 'dismissed', createdAt: 900 },
  ];
  const state = await r.readState(ap);
  assert.equal(state.lastProposalAt, 900, 'landing a proposal does not hand back a free tick');
  assert.equal(state.openProposals.length, 0);
});

// -------------------------------------------------------------- restore/persist

test('restore brings proposals back after a server bounce', () => {
  const r = runner();
  const first = r.createAutopilot();
  first.proposals = [{ id: 'ap-1', state: 'open', createdAt: 1, branch: 'autopilot/x' }];
  first.sequence = 1;
  r.persist(first);

  const second = r.createAutopilot();
  assert.equal(second.proposals.length, 1);
  assert.equal(second.proposals[0].id, 'ap-1');
  assert.equal(second.sequence, 1, 'ids keep counting up rather than colliding');
});

test('persist records the policy so a restart does not silently reset it', () => {
  const r = runner();
  const ap = r.createAutopilot();
  ap.updatePolicy({ enabled: true, maxOpenProposals: 1 });
  r.persist(ap);
  const state = r.loadState();
  assert.equal(state.policy.enabled, true);
  assert.equal(state.policy.maxOpenProposals, 1);
});

// ----------------------------------------------------------------------- audit

test('audit appends to a bounded tail', () => {
  const r = runner();
  for (let i = 0; i < 150; i += 1) r.audit('tick-refused', { reason: `n${i}` });
  const state = r.loadState();
  assert.ok(state.audit.length <= 100, 'the log is bounded on disk too');
  assert.equal(state.audit[state.audit.length - 1].reason, 'n149', 'the newest entry survives');
});

// -------------------------------------------------------------- created autopilot

test('a created autopilot is off by default, so nothing runs on a timer by surprise', () => {
  const r = runner();
  const ap = r.createAutopilot();
  assert.equal(ap.snapshot().enabled, false);
});

test('the runner defaults to verifying origin/main', () => {
  const r = runner();
  assert.equal(r.ref, 'origin/main');
});

test('the state file lives in the hive under a stable name', () => {
  const hive = tmpHive();
  const r = runner({ hive });
  assert.equal(r.stateFile, path.join(hive, 'autopilot_state.json'));
});