'use strict';
// Throughput must be measured over a window that spans the period, not
// over whatever log happens to fit in a fixed tail.
//
// The defect this guards: completionsLastHour counted task_completed
// events from only the last 512KB of a 31MB events.log. On the live hive
// that reported 115 completions in the hour when the true figure was ~420 --
// a 3.6x undercount of the very number that says whether the fleet is
// draining. A capacity input that is a floor, not a measurement.
//
// Every case below builds its own events.log, so the assertions do not
// depend on whatever the live hive happens to contain.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { completionsLastHour, countEventsSince, WINDOW_BYTES, ONE_HOUR_MS } =
  require('../throughput.js');

/** Build a hive whose events.log holds `n` task_completed events aged `ageMs`. */
function hiveWith(n, ageMs = 60 * 1000, fillerBytes = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-'));
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      type: 'task_completed',
      task_id: `t${i}`,
      timestamp: new Date(now - ageMs).toISOString(),
    }));
  }
  // Pad with unrelated events so the file is larger than a small window,
  // reproducing the tail-truncation that caused the original undercount.
  for (let i = 0; i < fillerBytes / 120; i += 1) {
    lines.push(JSON.stringify({
      type: 'heartbeat',
      agent_id: `a${i}`,
      timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(path.join(dir, 'events.log'), lines.join('\n') + '\n');
  return dir;
}

test('counts every completion in the window, not only the tail', () => {
  // 400 completions preceded by enough unrelated events that a 512KB tail
  // would have missed most of them.
  const dir = hiveWith(400, 60 * 1000, 2 * 1024 * 1024);
  try {
    const r = completionsLastHour(dir);
    assert.equal(r.completionsLastHour, 400,
      'a 16MB window must see all 400; the old 512KB tail saw 115');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports lower_bound when the log exceeds the window', () => {
  // Force truncation: more log than the window can hold.
  const dir = hiveWith(50, 60 * 1000, WINDOW_BYTES * 2);
  try {
    const r = completionsLastHour(dir);
    assert.equal(r.lower_bound, true,
      'a truncated window must be reported as a lower bound, not as the rate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log smaller than the window is not a lower bound', () => {
  const dir = hiveWith(5, 60 * 1000, 0);
  try {
    const r = completionsLastHour(dir);
    assert.equal(r.lower_bound, false);
    assert.equal(r.completionsLastHour, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('completions older than the window are excluded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-age-'));
  try {
    const now = Date.now();
    const lines = [
      // 10 recent
      ...Array.from({ length: 10 }, (_, i) => JSON.stringify({
        type: 'task_completed', task_id: `r${i}`,
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
      })),
      // 90 older than an hour
      ...Array.from({ length: 90 }, (_, i) => JSON.stringify({
        type: 'task_completed', task_id: `o${i}`,
        timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      })),
    ];
    fs.writeFileSync(path.join(dir, 'events.log'), lines.join('\n') + '\n');
    const r = completionsLastHour(dir);
    assert.equal(r.completionsLastHour, 10,
      'only completions inside the hour may be counted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('other event types are never counted as completions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-mix-'));
  try {
    const now = Date.now();
    const lines = [
      ...Array.from({ length: 7 }, (_, i) => JSON.stringify({
        type: 'heartbeat', timestamp: new Date(now).toISOString(),
      })),
      ...Array.from({ length: 3 }, (_, i) => JSON.stringify({
        type: 'task_failed', timestamp: new Date(now).toISOString(),
      })),
      ...Array.from({ length: 2 }, (_, i) => JSON.stringify({
        type: 'task_completed', timestamp: new Date(now).toISOString(),
      })),
    ];
    fs.writeFileSync(path.join(dir, 'events.log'), lines.join('\n') + '\n');
    const r = completionsLastHour(dir);
    assert.equal(r.completionsLastHour, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or unreadable events.log reports an error, never a zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-missing-'));
  try {
    const r = completionsLastHour(dir);
    assert.equal(r.completionsLastHour, null,
      'an unreadable log is not zero completions');
    assert.ok(r.error, 'and it must say why');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed lines are skipped without losing the good ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-bad-'));
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'events.log'), [
      JSON.stringify({ type: 'task_completed', timestamp: now }),
      '{ this is not json',
      '',
      JSON.stringify({ type: 'task_completed', timestamp: now }),
      JSON.stringify({ type: 'task_completed', timestamp: 'not-a-date' }),
    ].join('\n'));
    const r = completionsLastHour(dir);
    assert.equal(r.completionsLastHour, 2,
      'unparseable and undated lines are skipped, valid ones still counted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countEventsSince honours an explicit window', () => {
  const dir = hiveWith(30, 60 * 1000, 0);
  try {
    const small = countEventsSince(dir, 'task_completed', ONE_HOUR_MS, 512 * 1024);
    const large = countEventsSince(dir, 'task_completed', ONE_HOUR_MS, WINDOW_BYTES);
    assert.ok(small.count <= large.count);
    assert.equal(large.count, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

  // The failure this prevents is not hypothetical. countEventsSince takes
  // (hive, type, sinceMs). Called with the last two swapped -- an easy mistake
  // when the arguments are all strings and numbers -- `type` becomes a
  // timestamp, `sinceMs` becomes an event name, and every line fails the
  // `event.type !== type` check. The result is a confident count of 0 with
  // truncated:true and error:undefined: the call looks successful and reports
  // that no work happened.
  //
  // For a throughput number that is the worst possible failure, because zero
  // completions is exactly the value an idle fleet produces. A reader has no
  // way to tell "the fleet did nothing" from "the caller passed the arguments
  // in the wrong order", and the fleet is then scaled on that number.
  test('a swapped (hive, type, sinceMs) reports an error, never a silent zero', () => {
    const dir = hiveWith(30, 60 * 1000, 0);
    try {
      const since = Date.now() - ONE_HOUR_MS;
      const swapped = countEventsSince(dir, since, 'task_completed');
      // The log genuinely holds 30 completions, so any answer of 0 here is a
      // contract violation rather than a fact about the hive.
      assert.notEqual(
        swapped.count,
        0,
        'swapped arguments must not report zero completions for a log that contains them',
      );
      assert.ok(
        swapped.error,
        'swapped arguments must surface an error, not a confident result',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an event type that is not a string is rejected as a bad argument', () => {
    const dir = hiveWith(5, 60 * 1000, 0);
    try {
      const bad = countEventsSince(dir, 12345, 60 * 1000);
      assert.ok(bad.error, 'a non-string type must be reported, not silently counted as zero');
      assert.equal(bad.count, null, 'a rejected call must return null, which is distinguishable from a real zero');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
