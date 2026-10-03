'use strict';
// The 24/7 view is only useful if it tells the truth about a job that died at
// 3am, so the launchctl parsing is asserted directly rather than only through
// the HTTP surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/harness');

const server = loadServer();
const { parseLaunchctlList } = server.internals;

const HEADER = 'PID\tStatus\tLabel';
const ALL_ONESHOT = () => 'oneshot';

test('a dash pid with a zero exit is idle, not failed', () => {
  // Most fleet jobs are on-demand: loaded, not running, last run succeeded.
  // Reporting these as failures would cry wolf on every poll.
  const out = parseLaunchctlList([HEADER, '-\t0\tcom.aryan.pm-alert'].join('\n'), ALL_ONESHOT);
  assert.equal(out.services.length, 1);
  assert.equal(out.services[0].status, 'idle');
  assert.equal(out.services[0].running, false);
  assert.equal(out.services[0].pid, null);
  assert.equal(out.services[0].lastExit, 0);
  assert.equal(out.counts.failed, 0);
});

test('a dash pid with a non-zero exit is stopped, not failed', () => {
  // arb-detector exits 2 on a deliberate monthly-quota guard and pm-watch exits
  // 1 when its own health check finds a real problem. Both are the job working
  // as designed; nothing is restarting them because they are not KeepAlive.
  // Counting these as 'failed' would turn a correct report into a false alarm.
  const out = parseLaunchctlList([HEADER, '-\t2\tcom.aryan.arb-detector'].join('\n'), ALL_ONESHOT);
  assert.equal(out.services[0].status, 'stopped');
  assert.equal(out.counts.stopped, 1);
  assert.equal(out.counts.failed, 0);
  assert.equal(out.counts.idle, 0);
});

test('a keepalive job that is not running is failed whatever its exit code', () => {
  // launchd restarts a KeepAlive job forever, so being down is never normal —
  // including when the last exit was clean.
  const clean = parseLaunchctlList([HEADER, '-\t0\tcom.aryan.openalice-manager'].join('\n'), () => 'keepalive');
  assert.equal(clean.services[0].status, 'failed');
  assert.equal(clean.counts.failed, 1);

  const dirty = parseLaunchctlList([HEADER, '-\t1\tcom.aryan.trading-bot'].join('\n'), () => 'keepalive');
  assert.equal(dirty.services[0].status, 'failed');
  assert.equal(dirty.counts.failed, 1);
});

test('a live pid is running even if the previous run exited non-zero', () => {
  // A restarted job is healthy now; the stale exit code is history.
  const out = parseLaunchctlList([HEADER, '77047\t1\tcom.aryan.ollama-proxy'].join('\n'), ALL_ONESHOT);
  assert.equal(out.services[0].status, 'running');
  assert.equal(out.services[0].pid, 77047);
  assert.equal(out.counts.running, 1);
  assert.equal(out.counts.failed, 0);
});

test('only the com.aryan fleet is counted', () => {
  const out = parseLaunchctlList([
    HEADER,
    '1\t0\tcom.aryan.opencode-serve',
    '2\t0\tcom.apple.windowserver',
    '3\t0\tcom.apple.WindowManager',
  ].join('\n'), ALL_ONESHOT);
  assert.equal(out.services.length, 1);
  assert.equal(out.services[0].label, 'com.aryan.opencode-serve');
  assert.equal(out.counts.total, 1);
});

test('counts and malformed input are handled without throwing', () => {
  const out = parseLaunchctlList([
    HEADER,
    '',
    'garbage line without columns',
    '100\t0\tcom.aryan.a',
    '-\t0\tcom.aryan.b',
    '-\t1\tcom.aryan.c',
  ].join('\n'), ALL_ONESHOT);
  assert.equal(out.available, true);
  assert.equal(out.counts.total, 3);
  assert.equal(out.counts.running, 1);
  assert.equal(out.counts.idle, 1);
  assert.equal(out.counts.stopped, 1);
  assert.equal(out.counts.failed, 0);
  assert.equal(out.counts.running + out.counts.idle + out.counts.stopped + out.counts.failed, out.counts.total);
});

test('an unknown job defaults to the forgiving oneshot reading', () => {
  // A missing/unreadable plist must not invent a failure.
  const out = parseLaunchctlList([HEADER, '-\t3\tcom.aryan.unknown-job'].join('\n'), ALL_ONESHOT);
  assert.equal(out.services[0].intent, 'oneshot');
  assert.equal(out.services[0].status, 'stopped');
  assert.equal(out.counts.failed, 0);
});
