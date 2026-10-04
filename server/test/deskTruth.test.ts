/**
 * F18 The Desk's truth rules.
 *
 * Every case below is a claim the desk could have made from the real payloads and
 * should not. The measurements quoted in web/src/deskTruth.ts are from the live
 * mini, not invented: the audit answered count 0 with a window reading 524288 of
 * 15755023 bytes, which is the trap this file exists to keep the floor out of.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canClaimAbsence,
  headroomLine,
  mayDrawCapacity,
  claimLabel,
  dispatchSummary,
  historyLabel,
  historyStatus,
  verifyTally,
  type AuditLike,
} from '../../web/src/deskTruth.ts';

/** The live shape, measured. count 0, window truncated, ok true. */
const truncated: AuditLike = {
  ok: true,
  status: 'ok',
  error: null,
  count: 0,
  limit: 50,
  scanned: 375,
  source: 'events.log',
  reachable_window: true,
  window: {
    source_bytes: 15755023,
    read_bytes: 524288,
    limit_bytes: 524288,
    truncated: true,
    unparsed_lines: 0,
  },
  checkedAt: '2026-10-04T13:01:19.295Z',
};

test('a partly-read log cannot support "no commands ever"', () => {
  // The exact measured case: ok true, count 0. Reading that as "nothing was ever
  // asked" is the claim this floor is most likely to be believed on.
  assert.equal(historyStatus(truncated), 'window_truncated');
  assert.equal(canClaimAbsence(truncated), false);
  const label = historyLabel(truncated);
  assert.match(label, /0\.5 MB tail/, 'says how much was actually read');
  assert.match(label, /15 MB/, 'says how big the file is');
  assert.match(label, /may exist outside the window/, 'refuses to extrapolate');
  assert.doesNotMatch(label, /^No commands\./, 'must not open as a bare absence');
});

test('a whole-file empty window is the only absence that can be claimed', () => {
  const wholeFile: AuditLike = {
    ok: true, status: 'ok', count: 0, scanned: 12, source: 'events.log', reachable_window: true,
    window: { source_bytes: 4096, read_bytes: 4096, limit_bytes: 524288, truncated: false, unparsed_lines: 0 },
  };
  assert.equal(historyStatus(wholeFile), 'empty_in_window');
  assert.equal(canClaimAbsence(wholeFile), true);
  assert.match(historyLabel(wholeFile), /the part of events\.log that was read/);
});

test('events present outranks any window concern', () => {
  const withEvents: AuditLike = { ...truncated, count: 3 };
  assert.equal(historyStatus(withEvents), 'has_events');
  assert.match(historyLabel(withEvents), /^3 commands in the audit trail\./);
  assert.equal(historyLabel({ ...truncated, count: 1 }), '1 command in the audit trail.');
});

test('an unreadable log is never an absence', () => {
  const unreadable: AuditLike = { ok: false, status: 'unreadable', error: 'EACCES', count: 0, scanned: 0 };
  assert.equal(historyStatus(unreadable), 'unreadable');
  assert.equal(canClaimAbsence(unreadable), false);
  assert.match(historyLabel(unreadable), /could not be read: EACCES/);
  assert.match(historyLabel(unreadable), /not an absence of commands/);
});

test('bytes that are not events are not an absence', () => {
  // The corruption case their commit documented: reporting [] here would claim the
  // assistant was never asked anything on the strength of a corrupt file.
  const unparsed: AuditLike = {
    ok: false, status: 'unparsed', count: 0, scanned: 0,
    window: { source_bytes: 900, read_bytes: 900, truncated: false, unparsed_lines: 14 },
  };
  assert.equal(historyStatus(unparsed), 'unparsed');
  assert.equal(canClaimAbsence(unparsed), false);
  assert.match(historyLabel(unparsed), /14 unparsed lines/);
  assert.match(historyLabel(unparsed), /cannot be claimed/);
});

test('no audit at all is its own state, not an empty one', () => {
  for (const missing of [null, undefined, {} as AuditLike]) {
    assert.equal(historyStatus(missing), 'no_answer');
    assert.equal(canClaimAbsence(missing), false);
    assert.match(historyLabel(missing), /has not reported/);
  }
});

test('an owner is only claimed when claimant and age are both real', () => {
  const claimed = claimLabel({ claimed_by: 'office-manager', claimed_at: new Date().toISOString(), status: 'CLAIMED' });
  assert.equal(claimed.tone, 'claimed');
  assert.match(claimed.text, /^office-manager · \d+s ago$/);

  // claimed_at without claimed_by: inventing an owner is worse than admitting none.
  const orphan = claimLabel({ claimed_by: null, claimed_at: new Date().toISOString(), status: 'IN_PROGRESS' });
  assert.equal(orphan.tone, 'unverified');
  assert.doesNotMatch(orphan.text, /office-manager/);

  // An unparseable timestamp must not become "0s ago".
  const bad = claimLabel({ claimed_by: 'office-manager', claimed_at: 'not a date' });
  assert.equal(bad.tone, 'claimed');
  assert.match(bad.text, /age unknown/);
  assert.doesNotMatch(bad.text, /0s/);
});

test('assigned-but-unclaimed is a distinct state from queued', () => {
  const assigned = claimLabel({ assigned_agent: 'office-manager', claimed_by: null });
  assert.equal(assigned.tone, 'assigned');
  assert.match(assigned.text, /office-manager · not claimed/);

  const bare = claimLabel({});
  assert.equal(bare.tone, 'queued');
  assert.equal(claimLabel(null).text, 'NOT REPORTED');
});

test('a verdict tally always shows its denominator', () => {
  // Measured on the mini: 631 OK and nothing else.
  const tally = verifyTally({ verdict_tally: { OK: 631 } });
  assert.equal(tally.total, 631);
  assert.match(tally.label, /^631 OK of 631 verdicts\.$/);

  const mixed = verifyTally({ verdict_tally: { OK: 60, FAILED: 3, QUARANTINED: 2 } });
  assert.equal(mixed.total, 65);
  assert.match(mixed.label, /65 verdicts/);
  assert.equal(mixed.rows[0].verdict, 'OK', 'ordered by count');

  const empty = verifyTally({ verdict_tally: {} });
  assert.equal(empty.total, 0);
  assert.match(empty.label, /no verdict has been recorded/);

  assert.match(verifyTally(null).label, /No verdict tally reported/);
  assert.match(verifyTally({}).label, /No verdict tally reported/);
});

test('dispatch keeps the reason, because the reasons have different fixes', () => {
  const local = dispatchSummary({ ok: true, queue_available: true, dispatch: { available: true, host: 'As-Mac-mini' } });
  assert.equal(local.available, true);
  assert.equal(local.label, 'DISPATCH AVAILABLE');
  assert.equal(local.reason, null);

  const remote = dispatchSummary({
    ok: true, queue_available: true, blocked_by: 'not_local',
    blocked_reason: 'This HUD is served from As-Mac-mini, and dispatch requires a request that reaches that host loopback.',
    dispatch: { available: false, host: 'As-Mac-mini' },
  });
  assert.equal(remote.label, 'DISPATCH READ-ONLY');
  assert.match(remote.reason ?? '', /loopback/);

  // A missing queue is not a topology problem and must not read as one.
  const noQueue = dispatchSummary({ ok: true, queue_available: false, blocked_by: 'queue_unavailable', dispatch: { available: true, host: 'x' } });
  assert.equal(noQueue.label, 'QUEUE UNAVAILABLE');
  assert.match(noQueue.reason ?? '', /queue/i);

  const malformed = dispatchSummary({ ok: false, reason: 'prompt must be between 3 and 2000 characters', dispatch: { available: true, host: 'x' } });
  assert.equal(malformed.label, 'DISPATCH BLOCKED');
  assert.match(malformed.reason ?? '', /between 3 and 2000/);

  // Not assessed is not the same as blocked, and not the same as available.
  const unassessed = dispatchSummary(null);
  assert.equal(unassessed.available, false);
  assert.equal(unassessed.label, 'DISPATCH NOT ASSESSED');
  assert.match(unassessed.reason ?? '', /has not judged/);
});

test('the host name is carried through so the banner can name whose office this is', () => {
  assert.equal(dispatchSummary({ ok: true, queue_available: true, dispatch: { available: true, host: 'As-Mac-mini' } }).host, 'As-Mac-mini');
  assert.equal(dispatchSummary(null).host, null);
});
test('headroom never draws a bar from an unobserved scope', () => {
  // The limiter returns {available: rpm} for any key it has never seen, so a bar
  // would be drawn from the default that was just filled in. The desk says NO BAR.
  const unobserved = { ok: false, status: 'unobserved', headroom: null, reset_in_ms: null, reason: 'The rate limiter keeps its buckets in memory and does not list its keys, so this scope has no record.' };
  assert.equal(mayDrawCapacity(unobserved), false);
  assert.match(headroomLine(unobserved), /does not list its keys/);
  assert.doesNotMatch(headroomLine(unobserved), /available/);
});

test('a proven reading is allowed to draw, and carries the limit it was asked about', () => {
  const observed = { ok: true, status: 'observed', headroom: 3, reset_in_ms: 4200, requested: { key: 'pm-risk', rpm: 60 } };
  assert.equal(mayDrawCapacity(observed), true);
  assert.match(headroomLine(observed), /^3 of 60 requests available, resets in 5s\.$/);
});

test('no record is not the same claim as no capacity', () => {
  const unavailable = { ok: false, status: 'unavailable', headroom: null, reason: 'The rate limiter could not be loaded: Cannot find module. No headroom is claimed.' };
  assert.equal(mayDrawCapacity(unavailable), false);
  assert.match(headroomLine(unavailable), /could not be loaded/);
  assert.notEqual(headroomLine(unobservedHeadroom()), headroomLine(unavailable));
});

function unobservedHeadroom() {
  return { ok: false, status: 'unobserved', headroom: null, reason: 'No rate-limit record exists for this scope.' };
}

test('an unrecognised state claims nothing rather than defaulting to a number', () => {
  const weird = { status: 'something-new', headroom: 99 };
  assert.equal(mayDrawCapacity(weird), false);
  assert.match(headroomLine(weird), /does not recognise/);
  assert.equal(headroomLine(null), 'Rate-limit headroom has not been reported.');
});
