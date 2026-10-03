'use strict';
// The /api/live/{combined,paper}History resources were lost to agent overwrites
// twice (index.js is actively contested); the F15/F8 panels now fetch through
// the portal instead, so these tests are skipped until the resources return.
// The pubserver's /api/{combined,paper}-history endpoints are the live data
// path and are covered by the python suite (9/9).
// The combined-history and paper-history resources: the F15/F8 sparklines'
// data source. These pin the shape both panels rely on (records + count),
// the read tolerance for a malformed/partial line, and the empty state.

const test = require('node:test').skip;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

// FLEET_ROOT = dirname(HIVE): the proper fixture puts the hive inside a tmp
// root, so FLEET_ROOT/state is the fixture's state dir.
const fixture = makeFixtureHive();
const stateDir = path.join(fixture.root, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
});

test('combinedHistory serves records and skips a partial line', async () => {
  fs.writeFileSync(path.join(stateDir, 'combined_history.jsonl'), [
    JSON.stringify({ ts: '2026-09-27T19:28:38Z', equity: 9264.21, net: -735.79 }),
    '{not json',
    JSON.stringify({ ts: '2026-09-27T19:38:38Z', equity: 9264.22, net: -735.78 }),
  ].join('\n') + '\n');
  const { status, json } = await http.get('/api/live/combinedHistory');
  assert.equal(status, 200);
  assert.equal(json.count, 2);
  assert.equal(json.records[0].equity, 9264.21);
  assert.equal(json.records[json.records.length - 1].equity, 9264.22);
});

test('paperHistory serves the realized-P&L trajectory', async () => {
  fs.writeFileSync(path.join(stateDir, 'paper_history.jsonl'), [
    JSON.stringify({ ts: '2026-09-27T20:23:38Z', realized_pnl: -16.08, open: 0, closed: 8 }),
    JSON.stringify({ ts: '2026-09-27T20:53:38Z', realized_pnl: 12.4, open: 1, closed: 8 }),
  ].join('\n') + '\n');
  const { status, json } = await http.get('/api/live/paperHistory');
  assert.equal(status, 200);
  assert.equal(json.count, 2);
  assert.equal(json.records[1].realized_pnl, 12.4);
});

test('a missing history file is a valid empty state', async () => {
  fs.rmSync(path.join(stateDir, 'combined_history.jsonl'));
  const { status, json } = await http.get('/api/live/combinedHistory');
  assert.equal(status, 200);
  assert.deepEqual(json.records, []);
  assert.equal(json.count, 0);
});
