'use strict';
// POST /api/jarvis/preview — the route that earns its ungated exception.
//
// The reason this route exists at all is that the write path had no tests, one of
// its two consoles could never work, and the other judged risk with its own copy
// of the rule. Preview is how the browser stopped guessing. But a preview that
// writes is not a preview, and this is the ONLY mutating-verb route in the server
// that is deliberately not behind isLocalRequest — so its honesty has to be
// demonstrated rather than asserted in a comment.
//
// The tests below pin three things:
//   1. It writes nothing. Not the queue, not an event, not a lock file — checked
//      by fingerprinting the hive directory before and after.
//   2. It answers a proxied caller, which is the case that matters: the operator
//      on a laptop is the one who needs to be told dispatch is unavailable.
//   3. What it says about a command matches what the write path then does with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive({ now: Date.now() });
const server = loadServer(fixture.hive);
let http;

/** Every file in the hive with its size and mtime, so "wrote nothing" is checkable. */
function fingerprintHive() {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.statSync(full);
      out[path.relative(fixture.hive, full)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(fixture.hive);
  return out;
}

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => { await http?.close(); });

test('preview writes nothing: the hive is byte-identical afterwards', async () => {
  const before = fingerprintHive();
  const res = await http.post('/api/jarvis/preview', {
    prompt: 'clear the failed queue and purge the old sessions',
    target: null,
    priority: 'high',
  });
  assert.equal(res.status, 200);
  const after = fingerprintHive();

  const changed = Object.keys({ ...before, ...after })
    .filter(key => before[key] !== after[key]);
  assert.deepEqual(changed, [], `preview must not touch the hive; changed: ${changed.join(', ')}`);
});

test('preview answers a proxied caller, because that is the operator who needs it', async () => {
  // The write route answers 403 to this exact caller. The preview must not, or the
  // explanation of "you cannot dispatch from here" would be unreachable from here.
  const res = await http.get('/api/jarvis/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ prompt: 'refresh the floor snapshot', priority: 'normal' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.dispatch.available, false, 'a proxied caller is not local');
  assert.equal(res.json.would_accept, false);
  assert.equal(res.json.blocked_by, 'not_local');
  assert.match(res.json.blocked_reason, /loopback interface/);
});

test('preview reports the risk tier the write path will use, and the word it needs', async () => {
  const res = await http.post('/api/jarvis/preview', { prompt: 'disable the night poller', priority: 'normal' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.risk, 'destructive');
  assert.equal(res.json.requires_type_confirmation, true);
  // Confirmed but untyped: the write path would still refuse, and preview must say so
  // rather than reporting would_accept.
  const confirmed = await http.get('/api/jarvis/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'disable the night poller', priority: 'normal', confirmed: true }),
  });
  assert.equal(confirmed.json.would_accept, false);
  assert.equal(confirmed.json.blocked_by, 'confirmation');
  assert.match(confirmed.json.blocked_reason, /EXECUTE/);
});

test('preview rejects a malformed command instead of describing a write that cannot happen', async () => {
  const res = await http.post('/api/jarvis/preview', { prompt: 'x', priority: 'normal' });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.field_status, 400);
  assert.equal(res.json.blocked_by, 'fields');
  assert.equal(res.json.risk, null, 'a refused command has no risk tier, not a permissive one');
  assert.match(res.json.reason, /between 3 and 2000/);
});

test('the write path then accepts exactly what preview said it would', async () => {
  const prompt = 'summarise the queue depth by hour';
  const previewRes = await http.post('/api/jarvis/preview', { prompt, priority: 'normal' });
  assert.equal(previewRes.json.risk, 'normal');
  assert.equal(previewRes.json.requires_type_confirmation, false);

  const before = JSON.parse(fs.readFileSync(path.join(fixture.hive, 'tasks.json'), 'utf8')).tasks.length;
  const write = await http.post('/api/jarvis/command', { prompt, priority: 'normal', confirmed: true });
  assert.equal(write.status, 201, JSON.stringify(write.json));
  assert.equal(write.json.task.risk, previewRes.json.risk);
  const after = JSON.parse(fs.readFileSync(path.join(fixture.hive, 'tasks.json'), 'utf8')).tasks.length;
  assert.equal(after, before + 1, 'and the real write did queue exactly one task');
});

test('an SSH-style loopback forward is local, and preview says so rather than implying otherwise', async () => {
  // Measured against the real gate, because an earlier version of the requirement
  // string claimed a tunnel could not carry a dispatch. That was false for the
  // `ssh -L` forward this HUD is read through: a loopback socket with no forwarded
  // chain passes isLocalRequest, so dispatch IS available. The fix is to state what
  // the check does instead of what a tunnel supposedly cannot do.
  const res = await http.post('/api/jarvis/preview', {
    prompt: 'summarise the queue depth by hour',
    priority: 'normal',
    confirmed: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.dispatch.available, true, 'a loopback caller is local');
  assert.equal(res.json.blocked_by, null);
  assert.match(res.json.dispatch.requirement, /cannot tell a local browser from a forwarded one/);
  assert.doesNotMatch(res.json.dispatch.requirement, /tunnel .*cannot carry/i,
    'the string must not claim a tunnel is refused when it is not');
});

test('the write route still refuses a proxied caller, which is why preview is the ungated one', async () => {
  const res = await http.get('/api/jarvis/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ prompt: 'refresh the floor snapshot', priority: 'normal', confirmed: true }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'JARVIS_LOCAL_ONLY');
});