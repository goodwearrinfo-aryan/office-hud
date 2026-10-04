// The HUD's completionsLastHour must be one measurement, not two added together.
//
// This exists because 72a8103 set completionsLastHour from throughput.js and
// left the pre-existing `completionsLastHour++` in the tail loop. Every test
// still passed, and the live payload read 266 where the unbiased source said
// 218: the same hour counted twice, once from a 16MB window and again from the
// 512KB tail inside it.
//
// A green suite did not catch it because no test compared the reported figure
// against the source it claims to come from. This one does, and it fails against
// the previous behaviour.
//
// One test, not two: getRecentEvents memoises into a module-level eventCache
// that is not invalidated between loadServer() calls, so a second server in the
// same process serves the first one's events. Splitting this into two tests
// would have that second test assert against stale data and fail for a reason
// that has nothing to do with the double count. The chart is asserted here,
// in the same request, where the cache is known to be warm and correct.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');
const { completionsLastHour } = require('../throughput.js');

test('completionsLastHour is one measurement, and the hourly chart still counts', async () => {
  const fixture = makeFixtureHive();

  // 40 completions inside the hour, plus 200 older ones that must not be
  // counted. The gap is what a truncated read would under-report.
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push(JSON.stringify({
      type: 'task_completed',
      task_id: `recent${i}`,
      result: 'ok',
      timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
  }
  for (let i = 0; i < 200; i += 1) {
    events.push(JSON.stringify({
      type: 'task_completed',
      task_id: `old${i}`,
      result: 'ok',
      timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(path.join(fixture.hive, 'events.log'), events.join('\n') + '\n');

  const server = loadServer(fixture.hive);
  const http = await startTestServer(server.app);
  try {
    const res = await http.get('/api/queue');
    assert.equal(res.status, 200);

    // The contract: the reported figure is the throughput module's figure, not
    // that figure plus a second pass over the same events.
    const expected = completionsLastHour(fixture.hive).completionsLastHour;
    assert.equal(typeof expected, 'number', 'the throughput module must return a number here');
    assert.equal(
      res.json.completionsLastHour,
      expected,
      `completionsLastHour must be the throughput module's value (${expected}); got `
        + `${res.json.completionsLastHour}, which means the tail loop is adding to it again`,
    );
    assert.equal(res.json.completionsLastHour, 40, 'the 200 older events must not be counted');

    // The chart is a separate output of the same loop and must be unaffected.
    assert.ok(Array.isArray(res.json.completionsByHour), 'the hourly chart must still be present');
    // Boundary-proof, deliberately. This used to recompute
    // `Math.floor(Date.now() / 3600000) * 3600000` AFTER the HTTP round trip,
    // while the events were stamped a minute BEFORE it. Run the suite across an
    // hour boundary and "now" named a different bucket than the one the events
    // had landed in: `0 !== 40`. It failed about once per hour of wall-clock time
    // and passed on every other run, which is the worst kind of test to own.
    //
    // So assert the property that matters and cannot straddle a boundary: every
    // completion appears in exactly one bucket, and the 40 recent ones share a
    // single bucket -- which is exactly what a doubled tail loop breaks, by
    // putting 80 in one bucket.
    const counts = res.json.completionsByHour.map((b) => b.count);
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      240,
      `all 240 completions appear in exactly one bucket each; got ${counts.join(',')}`,
    );
    assert.equal(
      counts.filter((c) => c === 40).length,
      1,
      `the 40 recent completions must occupy exactly one bucket, not be split or doubled; got ${counts.join(',')}`,
    );
  } finally {
    await http.close();
    fixture.cleanup();
  }
});
