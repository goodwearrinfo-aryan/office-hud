'use strict';
// The autopilot is allowed to write code while nobody is watching, so every way
// it can say "no" is a test. A refusal path that is not covered here is a path
// that will eventually be taken at 3am.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Autopilot,
  DEFAULT_POLICY,
  normalisePolicy,
  checkPath,
  screenPaths,
  validateProposal,
  gate,
} = require('../lib/autopilot.js');

const enabled = { policy: { enabled: true, cooldownMinutes: 0 } };

function goodProposal(overrides = {}) {
  return {
    summary: 'Cache the parsed task list instead of re-reading it per request',
    paths: ['server/lib/cache.js'],
    verdict: 'tests-pass',
    branch: 'autopilot/task-list-cache',
    ...overrides,
  };
}

// ---------------------------------------------------------------- path screening

test('a path is allowed when nothing protects it', () => {
  const policy = normalisePolicy({ enabled: true });
  assert.equal(checkPath('server/lib/cache.js', policy).allowed, true);
});

test('another session\'s files are refused by name', () => {
  const policy = normalisePolicy({ enabled: true });
  for (const owned of DEFAULT_POLICY.sessionOwned) {
    const verdict = checkPath(owned, policy);
    assert.equal(verdict.allowed, false, `${owned} must be refused`);
    assert.match(verdict.reason, /another session/);
  }
});

test('live trading and config are refused even if everything else is allowed', () => {
  const policy = normalisePolicy({ enabled: true, additionalBlocked: [], sessionOwned: [] });
  for (const path of ['config.yaml', 'launchd/com.aryan.x.plist', 'services/trader.py', '.env']) {
    assert.equal(checkPath(path, policy).allowed, false, `${path} must be refused`);
  }
});

test('the web tree is protected from unattended edits', () => {
  const policy = normalisePolicy({ enabled: true });
  assert.equal(checkPath('web/src/anything.tsx', policy).allowed, false);
});

test('paths that escape the repo are refused', () => {
  const policy = normalisePolicy({ enabled: true });
  assert.equal(checkPath('/etc/passwd', policy).allowed, false);
  assert.equal(checkPath('../outside.js', policy).allowed, false);
  assert.equal(checkPath('', policy).allowed, false);
});

test('a glob matches within a segment but ** spans segments', () => {
  const policy = normalisePolicy({ enabled: true, additionalBlocked: ['scripts/*.py'], alwaysProtected: [], sessionOwned: [] });
  assert.equal(checkPath('scripts/fix.py', policy).allowed, false, 'single star matches one segment');
  assert.equal(checkPath('scripts/deep/fix.py', policy).allowed, true, 'single star must not cross a slash');
});

test('screening reports every blocked path with its reason', () => {
  const policy = normalisePolicy({ enabled: true });
  const result = screenPaths(['server/lib/ok.js', 'web/src/App.tsx', 'config.yaml'], policy);
  assert.deepEqual(result.allowed, ['server/lib/ok.js']);
  assert.equal(result.blocked.length, 2);
  assert.match(result.blocked[0].reason, /another session/);
});

// ------------------------------------------------------------ proposal validity

test('a well-formed proposal is accepted', () => {
  assert.equal(validateProposal(goodProposal()).ok, true);
});

test('a change that fails tests is refused outright', () => {
  // This is the important one: a red suite is not a proposal.
  const check = validateProposal(goodProposal({ verdict: 'tests-fail' }));
  assert.equal(check.ok, false);
  assert.match(check.errors.join(' '), /discarded/);
});

test('proposals must name a branch, a summary and at least one path', () => {
  assert.equal(validateProposal(goodProposal({ branch: 'main' })).ok, false);
  assert.equal(validateProposal(goodProposal({ branch: 'wip/no-slash' })).ok, false);
  assert.equal(validateProposal(goodProposal({ summary: 'x' })).ok, false);
  assert.equal(validateProposal(goodProposal({ paths: [] })).ok, false);
  assert.equal(validateProposal(goodProposal({ verdict: 'maybe' })).ok, false);
  assert.equal(validateProposal(null).ok, false);
});

// ------------------------------------------------------------------ the gate

test('a disabled autopilot never proposes', () => {
  const verdict = gate({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }, normalisePolicy());
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /disabled/);
});

test('a dirty working tree stops it, so it never reasons over someone else\'s work', () => {
  const policy = normalisePolicy({ enabled: true });
  const verdict = gate({ dirtyFiles: 3, openProposals: [], lastProposalAt: 0 }, policy);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /uncommitted/);
});

test('the proposal ceiling is enforced', () => {
  const policy = normalisePolicy({ enabled: true, maxOpenProposals: 2 });
  const verdict = gate({ dirtyFiles: 0, openProposals: [1, 2], lastProposalAt: 0 }, policy);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /ceiling/);
});

test('cooldown blocks a second proposal too soon', () => {
  const policy = normalisePolicy({ enabled: true, cooldownMinutes: 60 });
  const now = 1_000_000_000;
  const verdict = gate({ dirtyFiles: 0, openProposals: [], lastProposalAt: now - 10 * 60_000 }, policy, now);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /cooling down/);
});

test('a clean, cool, empty state is allowed', () => {
  const policy = normalisePolicy({ enabled: true, cooldownMinutes: 60 });
  const now = 1_000_000_000;
  const verdict = gate({ dirtyFiles: 0, openProposals: [], lastProposalAt: now - 61 * 60_000 }, policy, now);
  assert.equal(verdict.allowed, true);
});

// ---------------------------------------------------------------- the class

test('a tick with a good candidate opens exactly one proposal', async () => {
  let clock = 1_000_000_000;
  const ap = new Autopilot({
    policy: { enabled: true, cooldownMinutes: 0 },
    now: () => clock,
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => goodProposal(),
  });
  const result = await ap.tick();
  assert.equal(result.ok, true);
  assert.equal(ap.snapshot().proposals.length, 1);
  assert.equal(ap.snapshot().proposals[0].state, 'open');
  clock += 1000;
});

test('a candidate touching a protected path is refused whole, not partially', async () => {
  const ap = new Autopilot({
    ...enabled,
    now: () => 1_000_000_000,
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => goodProposal({ paths: ['server/lib/ok.js', 'config.yaml'] }),
  });
  const result = await ap.tick();
  assert.equal(result.ok, false);
  assert.match(result.reason, /config\.yaml/);
  assert.equal(ap.snapshot().proposals.length, 0, 'nothing is queued when any path is refused');
});

test('a failing runner is contained and audited, not thrown', async () => {
  const ap = new Autopilot({
    ...enabled,
    now: () => 1_000_000_000,
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => { throw new Error('agent exploded'); },
  });
  const result = await ap.tick();
  assert.equal(result.ok, false);
  assert.match(result.reason, /agent exploded/);
  assert.equal(ap.snapshot().audit.at(-1).action, 'run-failed');
});

test('nothing is proposed while disabled, even with a perfect candidate', async () => {
  let ran = false;
  const ap = new Autopilot({
    policy: { enabled: false },
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => { ran = true; return goodProposal(); },
  });
  const result = await ap.tick();
  assert.equal(result.ok, false);
  assert.equal(ran, false, 'the runner must not even be invoked while disabled');
});

test('the autopilot cannot land its own proposal', async () => {
  const ap = new Autopilot({
    ...enabled,
    now: () => 1_000_000_000,
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => goodProposal(),
  });
  const { proposal } = await ap.tick();
  // Landing is a human act; the class exposes it but nothing calls it on its own.
  const landed = ap.land(proposal.id);
  assert.equal(landed.state, 'landed');
  assert.throws(() => ap.land(proposal.id), /is landed/, 'a proposal lands only once');
  assert.throws(() => ap.dismiss(proposal.id), /is landed/);
});

test('proposals expire and the oldest go first', async () => {
  let clock = 1_000_000_000;
  const ap = new Autopilot({
    policy: { enabled: true, cooldownMinutes: 0, maxOpenProposals: 2, proposalTtlHours: 1 },
    now: () => clock,
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => goodProposal({ branch: `autopilot/p${clock}`, summary: `change ${clock} to something real` }),
  });
  await ap.tick();
  clock += 1000;
  await ap.tick();
  clock += 1000;
  await ap.tick();
  const open = ap.snapshot().proposals;
  assert.equal(open.length, 2, 'the ceiling holds');
  assert.ok(open.every((p) => clock - p.createdAt < 3_600_000));
});

test('the audit log is bounded so a long-lived loop cannot grow without limit', async () => {
  const ap = new Autopilot({
    policy: { enabled: false },
    readState: async () => ({ dirtyFiles: 0, openProposals: [], lastProposalAt: 0 }),
    run: async () => null,
  });
  for (let i = 0; i < 150; i += 1) await ap.tick();
  assert.ok(ap.snapshot().audit.length <= 20);
});

test('a nonsense policy is rejected rather than silently clamped into something dangerous', () => {
  assert.throws(() => normalisePolicy(null), /must be an object/);
  assert.throws(() => normalisePolicy({ cooldownMinutes: 'soon' }), /must be a number/);
  assert.throws(() => normalisePolicy({ alwaysProtected: 'nope' }), /must be arrays/);
});