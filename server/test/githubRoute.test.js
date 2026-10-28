'use strict';
// The route contract: /api/github is GET-only and never polls on read.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

test('GET /api/github answers a snapshot without spawning gh', async (t) => {
  const hive = makeFixtureHive();
  process.env.OFFICE_HUD_GITHUB_REPOS = '/nonexistent/repos.json';
  const { app } = loadServer(hive);
  const server = await startTestServer(app);
  t.after(() => server.close());

  const res = await server.get('/api/github');
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, false);
  assert.deepEqual(res.json.repos, []);
  assert.equal(res.json.ageSec, null);
  assert.equal(res.json.totals.repos, 0);
});

test('POST /api/github is refused by the read-only gate', async (t) => {
  const hive = makeFixtureHive();
  process.env.OFFICE_HUD_GITHUB_REPOS = '/nonexistent/repos.json';
  const { app } = loadServer(hive);
  const server = await startTestServer(app);
  t.after(() => server.close());

  const res = await server.post('/api/github', { anything: true });
  assert.equal(res.status, 405);
  assert.match(res.text, /read-only/);
});
