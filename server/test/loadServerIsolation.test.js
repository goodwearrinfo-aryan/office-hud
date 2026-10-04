// Guards the test harness itself.
//
// loadServer() used to require the server module without busting the require
// cache, so a second call returned the FIRST instance: HIVE was captured once
// at module scope and eventCache/workEventCache were shared across every server
// built in the process. A test that created a second fixture hive was silently
// served the first hive's data.
//
// Measured before this guard existed: hive A holding 11 events and hive B
// holding 77 both reported 11 completions.
//
// Nothing failed loudly, because no test compared a payload against the hive it
// had just written. terminals.test.js worked around it by deleting its remote
// tree instead of loading a second server, with a comment explaining why. This
// makes the second-server case correct so that workaround is no longer needed.
//
// This is a guard on the harness, not on the server: index.js is correct for the
// single-server production case, and re-requiring it is safe because it only
// listens when it is require.main.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

function writeEvents(hive, n, tag) {
  const events = [];
  for (let i = 0; i < n; i += 1) {
    events.push(JSON.stringify({
      type: 'task_completed',
      task_id: `${tag}${i}`,
      result: 'ok',
      timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(path.join(hive, 'events.log'), events.join('\n') + '\n');
}

test('a second server serves its own hive, not the first one loaded', async () => {
  const a = makeFixtureHive();
  const b = makeFixtureHive();
  writeEvents(a.hive, 11, 'A');
  writeEvents(b.hive, 77, 'B');
  assert.notEqual(a.hive, b.hive, 'the two fixtures must be genuinely different directories');

  const httpA = await startTestServer(loadServer(a.hive).app);
  let httpB;
  try {
    const first = await httpA.get('/api/queue');
    assert.equal(first.status, 200);
    assert.equal(first.json.completionsLastHour, 11, 'the first server reads its own hive');

    httpB = await startTestServer(loadServer(b.hive).app);
    const second = await httpB.get('/api/queue');
    assert.equal(second.status, 200);
    assert.equal(
      second.json.completionsLastHour,
      77,
      'the second server must read the second hive; reading 11 means the module '
        + 'and its caches were reused across loadServer() calls',
    );
  } finally {
    await httpA.close();
    await httpB?.close();
    a.cleanup();
    b.cleanup();
  }
});
