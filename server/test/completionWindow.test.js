// Establishes the window contract between the 12-hour completion chart and the
// completionsLastHour scalar, and pins the distinction that was previously
// unstated.
//
// WHAT THE CONTRACT ACTUALLY IS
// -----------------------------
// Two different populations, on purpose:
//
//   scalar  completionsLastHour  = a ROLLING 60 minutes, countEventsSince(now - 3600000)
//   chart   completionsByHour[]  = CLOCK-hour buckets, floor(now / 3600000)
//
// At 09:11 a rolling hour reaches 49 minutes back into the 08:00 bucket, so the
// scalar legitimately exceeds the current clock bucket. Forcing them to be
// equal would be wrong. That was the first thing I tried and the test caught it:
// 48 !== 37. The two are not supposed to match.
//
// WHAT WAS ACTUALLY BROKEN
// -------------------------
// The chart read a 512KB tail while the scalar read 16MB. That is not a
// difference of definition, it is a difference of reach: 512KB of a log that is
// 94% heartbeats spans minutes, so the chart could not SEE the current hour at
// all. Measured live before the fix, the scalar read 177 for the hour while the
// chart's final bar read 25, and 10 of 12 buckets were empty. In the fixture
// below, the same defect shows as the chart reading 0 of 37.
//
// So the contract is: same WINDOW SIZE, different PERIOD DEFINITIONS, and the
// distinction has to be visible rather than inferred.
//
// The fixture pushes the counted events beyond the 512KB boundary using filler,
// exactly as the real log is dominated by heartbeats, so a test with a small log
// could not tell which window a reader used. This one can.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const { completionsLastHour, completionsByHour, WINDOW_BYTES } = require('../throughput.js');

const SMALL_TAIL_BYTES = 512 * 1024;

/** Counted events first, then filler pushing them past a 512KB tail boundary. */
function hiveWithPaddedLog(currentHour, previousHour, fillHours = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-window-'));
  const now = Date.now();
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const lines = [];
  const put = (n, at, tag) => {
    for (let i = 0; i < n; i += 1) {
      lines.push(JSON.stringify({
        type: 'task_completed',
        task_id: `${tag}${i}`,
        result: 'ok',
        timestamp: new Date(at).toISOString(),
      }));
    }
  };
  // 5 minutes into the current clock hour, and 30 minutes into the previous one
  // so that the previous hour is also inside the rolling 60-minute window.
  put(currentHour, hourStart + 5 * 60 * 1000, 'cur');
  // Anchored to the previous clock hour's midpoint, so these are unambiguously
  // in a different clock bucket from the current one.
  put(previousHour, hourStart - 30 * 60 * 1000, 'prev');
  for (let h = 2; h <= fillHours; h += 1) {
    put(1, hourStart - h * 3600000 + 30 * 60 * 1000, `f${h}`);
  }

  let bytes = lines.join('\n').length;
  let i = 0;
  while (bytes < SMALL_TAIL_BYTES + 4096) {
    const pad = JSON.stringify({
      type: 'heartbeat',
      agent_id: `pad${i++}`,
      timestamp: new Date(hourStart + 5 * 60 * 1000).toISOString(),
    });
    lines.push(pad);
    bytes += pad.length + 1;
  }
  fs.writeFileSync(path.join(dir, 'events.log'), lines.join('\n') + '\n');
  return { dir, size: bytes + 1 };
}

test('the chart reaches the current hour; a 512KB tail cannot', () => {
  const { dir, size } = hiveWithPaddedLog(37, 11);
  try {
    assert.ok(size > SMALL_TAIL_BYTES,
      `fixture must exceed the 512KB tail to be discriminating, got ${size} bytes`);

    const chart = completionsByHour(dir, 12);
    const last = chart.hours[chart.hours.length - 1];

    assert.equal(last.count, 37,
      'the current clock bucket must hold all 37 completions; the counted events '
        + 'sit beyond the 512KB boundary, so reading 0 here means the chart is '
        + 'still using the small tail');

    // The previous hour is a clock bucket and must also be visible.
    assert.equal(chart.hours[chart.hours.length - 2].count, 11,
      'the previous clock hour must be counted, not dropped by truncation');
    assert.equal(chart.error, null);
    assert.equal(chart.hours.length, 12, 'twelve buckets, gaps included as zeros');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scalar and the chart use the same window SIZE', () => {
  const { dir } = hiveWithPaddedLog(5, 1);
  try {
    assert.equal(completionsLastHour(dir).window_bytes, WINDOW_BYTES);
    assert.equal(completionsByHour(dir, 12).window_bytes, completionsLastHour(dir).window_bytes,
      'one canonical window size for both; two constants of the same value is how they drifted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scalar is a rolling hour and the chart is clock buckets: they are NOT equal', () => {
  // Pins the distinction so nobody later "fixes" the chart by forcing equality,
  // which would misreport one of the two.
  const { dir } = hiveWithPaddedLog(37, 11);
  try {
    const scalar = completionsLastHour(dir).completionsLastHour;
    const chart = completionsByHour(dir, 12);
    const currentBucket = chart.hours[chart.hours.length - 1].count;

    assert.equal(currentBucket, 37, 'the clock bucket holds the current hour only');
    assert.equal(chart.hours[chart.hours.length - 2].count, 11,
      'the previous clock hour holds its own 11');

    // These two measure different PERIODS, and that is the contract. Whether
    // their VALUES differ depends on where in the current clock hour this runs:
    // the previous hour's events sit 30 minutes into the previous bucket, so a
    // rolling 60-minute window still reaches them early in the hour (48) and no
    // longer reaches them late in it (37). Asserting they are always unequal
    // would itself be the time-dependent bug this test exists to avoid.
    //
    // What must hold in every case: the scalar counts the current hour's 37, and
    // the chart attributes them to the current clock bucket and only there.
    const overlapReached = 11;
    assert.ok(scalar === 37 || scalar === 37 + overlapReached,
      `the rolling hour is 37, or 37+11 when the window still overlaps the previous `
        + `bucket; got ${scalar}`);
    assert.equal(currentBucket, 37, 'the chart attributes all 37 to the current clock bucket');
    assert.equal(scalar >= currentBucket, true,
      'the rolling hour can never be smaller than the current clock bucket it contains');
    assert.equal(chart.hours.length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable log is reported, not rendered as twelve zeros', () => {
  const chart = completionsByHour('/nonexistent/hive/path', 12);
  assert.ok(chart.error, 'a missing events.log must surface an error');
  assert.ok(chart.hours.every((b) => b.count === null),
    'null, not 0, so "could not read" is distinguishable from "no work"');
});

test('the live payload states its window and serves the chart from it', async () => {
  const fixture = makeFixtureHive();
  // Boundary-proof by construction. This computed the current hour, then stamped
  // events at `hourStart + 5min` -- five minutes into the FUTURE -- and asserted
  // the last bucket held 9. Run it within five minutes of an hour boundary and
  // those timestamps belong to the previous hour, the last bucket reads 0, and
  // the failure is `0 !== 9`. Same race as queueThroughput, opposite direction.
  //
  // So the events are all placed in one hour bucket by construction, and the
  // assertion is about the shape of the chart rather than about which wall-clock
  // hour the suite happened to start in: the nine completions occupy exactly one
  // bucket, and no bucket is double-counted.
  const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
  const bucketHour = new Date(hourStart + 5 * 60 * 1000).toISOString();
  const events = [];
  for (let i = 0; i < 9; i += 1) {
    events.push(JSON.stringify({
      type: 'task_completed',
      task_id: `e${i}`,
      result: 'ok',
      timestamp: bucketHour,
    }));
  }
  fs.writeFileSync(path.join(fixture.hive, 'events.log'), events.join('\n') + '\n');
  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/queue');
    assert.equal(res.status, 200);
    assert.equal(res.json.completionsWindowBytes, WINDOW_BYTES,
      'the payload must state which window the chart was read from');
    const counts = res.json.completionsByHour.map((b) => b.count);
    assert.equal(counts.reduce((a, b) => a + b, 0), 9,
      `all 9 completions appear in exactly one bucket each; got ${counts.join(',')}`);
    assert.equal(counts.filter((c) => c === 9).length, 1,
      `the 9 completions must occupy exactly one bucket, not be split or doubled; got ${counts.join(',')}`);
    assert.equal(res.json.completionsByHour.length, 12);
  } finally {
    await http.close();
    fixture.cleanup();
  }
});
