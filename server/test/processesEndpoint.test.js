'use strict';
// The canary for the WIRING, complementing processTruth.test.js.
//
// processTruth.test.js proves the truth rules are correct; it cannot prove the
// HUD is using them, because a refactor of server/index.js that drops the
// require() leaves that suite green while the endpoint goes back to presenting a
// frozen file as live. This one asserts on the served payload, so losing the
// wiring fails here and here only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
});

test('/api/processes declares where its data came from', async () => {
  const res = await http.get('/api/processes');
  assert.equal(res.status, 200, res.text);
  const body = res.json;
  assert.ok(body, `expected JSON, got: ${res.text.slice(0, 200)}`);
  assert.ok('observation_source' in body,
    'the payload must name its source; an unnamed source is a cache pretending to be live');
  assert.equal(typeof body.live, 'boolean');
  assert.equal(typeof body.stale, 'boolean');
});

test('a process record reports its age and keeps the status it stored', async () => {
  const res = await http.get('/api/processes');
  const body = res.json;
  const records = body.processes || [];
  for (const p of records) {
    assert.ok('observation_age_seconds' in p,
      'each record must state the age of the observation behind it');
    assert.ok('stored_status' in p,
      'each record must keep what was stored, so a view can show what it claimed');
    if (body.stale) {
      assert.equal(p.status, 'STALE',
        'a stale observation may not be presented under any other status');
    }
  }
});

test('a command line is never served with a credential-shaped value', async () => {
  const res = await http.get('/api/processes');
  // Secret VALUES, not flag shapes. `--api-key=\S+` also matches the redacted
  // `--api-key=***`, so this assertion could only be satisfied by redaction NOT
  // happening -- it failed the moment the endpoint was fixed correctly, and it
  // contradicted redact.test.js, which requires exactly that masking.
  const secrets = /sk-[A-Za-z0-9]{8,}|sk-or-v1-\S+|ghp_\S+|[A-Z][A-Z0-9_]*_(?:API_KEY|SECRET|TOKEN)=\S+/;
  for (const p of (res.json.processes || [])) {
    assert.doesNotMatch(String(p.command || ''), secrets,
      `credential served in a command line: ${p.command}`);
  }
  // And the fixture really does contain one, so this is not another test that
  // passes because there was nothing to find.
  const served = (res.json.processes || []).map(p => String(p.command || '')).join('\n');
  assert.doesNotMatch(served, /CANARY0123456789/,
    'the fixture canary reached the client unredacted');
  assert.match(served, /--port 8080|port 8080/,
    'ordinary flags must survive redaction, or the view is useless');
});

test('the truth fields are additive to the existing payload', async () => {
  // Redaction and staleness must not change what a view already reads. This
  // deliberately does not assert an envelope shape: whether /api/processes
  // carries generated_at/hive is a contract this change did not establish and
  // is not its to decide, so the test pins only what it is responsible for.
  const res = await http.get('/api/processes');
  const body = res.json;
  assert.ok(Array.isArray(body.processes), 'processes must stay an array');
  for (const field of ['observation_source', 'observation_age_seconds', 'live', 'stale', 'stale_after_seconds']) {
    assert.ok(field in body, `added field ${field} disappeared`);
  }
});
