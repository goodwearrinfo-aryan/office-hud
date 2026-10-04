/**
 * The fleet floor's truth rules.
 *
 * These matter because the fleet floor is the first surface that describes a
 * machine OTHER than the one serving the HUD, and the raw payload makes three
 * comfortable lies available. Each case below is one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNDECLARED_JOBS,
  ageLabel,
  hostStatus,
  hostSummary,
  isIdentified,
  isVerified,
  undeclaredJobs,
} from '../../web/src/fleetTruth.ts';

const row = (over: Record<string, unknown> = {}) => ({
  process_id: 'proc-x',
  project_id: 'proj-x',
  health: 'HEALTHY',
  ...over,
});

test('a stale host keeps its rows and says how stale it is', () => {
  const host = {
    host: 'laptop',
    collected_at: '2026-10-03T17:59:53+00:00',
    age_sec: 56244,
    stale: true,
    processes: [row()],
  };
  // Not dropped, not softened: STALE, and dated.
  assert.match(hostStatus(host), /^STALE/);
  assert.match(hostStatus(host), /15h ago/);
  assert.equal((host.processes ?? []).length, 1, 'its rows survive');
});

test('a fresh host is labelled reporting and still dated', () => {
  const host = { host: 'mini', age_sec: 34, stale: false, processes: [row()] };
  assert.equal(hostStatus(host), 'reporting · 34s ago');
});

test('age reads in units a person can use, and admits when it is unknown', () => {
  assert.equal(ageLabel(0), '0s ago');
  assert.equal(ageLabel(59), '59s ago');
  assert.equal(ageLabel(60), '1m ago');
  assert.equal(ageLabel(3599), '59m ago');
  assert.equal(ageLabel(3600), '1h ago');
  assert.equal(ageLabel(86400), '1d ago');
  assert.equal(ageLabel(null), 'age unknown');
  assert.equal(ageLabel(undefined), 'age unknown');
  assert.equal(ageLabel(Number.NaN), 'age unknown');
});

test('a null identity is NOT REPORTED, not an unnamed healthy process', () => {
  const anonymous = row({ process_id: null, project_id: null });
  assert.equal(isIdentified(anonymous), false);
  assert.equal(isVerified(anonymous), true, 'health was still reported, and that is kept separate');
  const summary = hostSummary({ host: 'h', collected_at: 'then', age_sec: 1, processes: [row(), anonymous] });
  assert.match(summary, /2 processes/);
  assert.match(summary, /1 NOT REPORTED/);
});

test('either identifier is enough to attribute a row', () => {
  assert.equal(isIdentified(row({ process_id: null })), true, 'project_id still names it');
  assert.equal(isIdentified(row({ project_id: null })), true, 'process_id still names it');
});

test('null health is NOT VERIFIED, and never inherits a neighbour green', () => {
  const unchecked = row({ health: null });
  assert.equal(isVerified(unchecked), false);
  const summary = hostSummary({ host: 'h', collected_at: 'then', age_sec: 1, processes: [row(), unchecked] });
  assert.match(summary, /1 health NOT VERIFIED/);
  // And a row that IS healthy must not drag the count up.
  assert.doesNotMatch(summary, /0 health NOT VERIFIED/);
});

test('the summary accounts for every row exactly once', () => {
  // The measured case: 2 identified on one machine, 33 anonymous on another.
  const mini = hostSummary({
    host: 'mini', collected_at: 'a', age_sec: 30, processes: [row(), row()],
  });
  const laptop = hostSummary({
    host: 'laptop', collected_at: 'b', age_sec: 56244,
    processes: Array.from({ length: 33 }, () => row({ process_id: null, project_id: null, health: null })),
  });
  assert.match(mini, /2 processes · 0 health NOT VERIFIED|2 processes/);
  assert.match(laptop, /33 processes · 33 NOT REPORTED · 33 health NOT VERIFIED/);
});

test('a host with no processes says so rather than implying zero is good', () => {
  const summary = hostSummary({ host: 'h', collected_at: 'never', age_sec: 10, processes: [] });
  assert.match(summary, /0 processes/);
  assert.doesNotMatch(summary, /NOT REPORTED/, 'nothing was reported because nothing ran');
});

test('the four undeclared jobs are listed, and a declared one is not double-counted', () => {
  assert.equal(UNDECLARED_JOBS.length, 4);
  assert.deepEqual(undeclaredJobs([]), [...UNDECLARED_JOBS]);
  // If the machine ever declares one, it stops being undeclared.
  const declared = [...UNDECLARED_JOBS.slice(0, 1)];
  assert.deepEqual(undeclaredJobs(declared), UNDECLARED_JOBS.slice(1));
});

test('a stale host with an unknown age says so instead of implying freshness', () => {
  const host = { host: 'h', age_sec: null, stale: true, processes: [] };
  assert.equal(hostStatus(host), 'STALE · age unknown');
});