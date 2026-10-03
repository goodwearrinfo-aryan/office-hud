// Heartbeat for the unattended daily public-export job.
//
// The job writes state/public_sync_status.json on every run. Nothing about a
// stopped job is visible from public/main, because a failed run deliberately
// leaves the public branch untouched - so "is it still running?" has to be
// answered from the status file, with the freshness verdict computed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../index.js');

function tmpStatus(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubsync-status-'));
  const file = path.join(dir, 'public_sync_status.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

const NOW = Date.parse('2026-09-28T12:00:00Z');

test('a fresh run is present, not stale, and reports its age', () => {
  const file = tmpStatus(JSON.stringify({
    last_run_at: '2026-09-28T11:30:00Z', result: 'no_change', consecutive_failures: 0,
  }));
  const status = server.internals.readPublicSyncStatus(NOW, file);
  assert.equal(status.present, true);
  assert.equal(status.result, 'no_change');
  assert.equal(status.age_seconds, 30 * 60);
  assert.equal(status.stale, false);
});

test('a published run is fresh and says so', () => {
  const file = tmpStatus(JSON.stringify({
    last_run_at: '2026-09-28T03:30:00Z', result: 'published', published_commit: 'abc123',
  }));
  const status = server.internals.readPublicSyncStatus(NOW, file);
  assert.equal(status.stale, false);
  assert.equal(status.result, 'published');
  assert.equal(status.published_commit, 'abc123');
});

test('a run older than one daily window is stale', () => {
  const file = tmpStatus(JSON.stringify({
    last_run_at: '2026-09-26T03:30:00Z', result: 'no_change',
  }));
  const status = server.internals.readPublicSyncStatus(NOW, file);
  assert.equal(status.stale, true);
  assert.ok(status.age_seconds > server.internals.PUBLIC_SYNC_STALE_SECONDS);
});

test('a run that only just crossed the window is still fresh (26h budget)', () => {
  const justInside = new Date(NOW - (server.internals.PUBLIC_SYNC_STALE_SECONDS - 60) * 1000).toISOString();
  const justOutside = new Date(NOW - (server.internals.PUBLIC_SYNC_STALE_SECONDS + 60) * 1000).toISOString();
  const inside = server.internals.readPublicSyncStatus(NOW, tmpStatus(JSON.stringify({ last_run_at: justInside })));
  const outside = server.internals.readPublicSyncStatus(NOW, tmpStatus(JSON.stringify({ last_run_at: justOutside })));
  assert.equal(inside.stale, false);
  assert.equal(outside.stale, true);
});

test('a missing status file is stale, never healthy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubsync-empty-'));
  const status = server.internals.readPublicSyncStatus(NOW, path.join(dir, 'absent.json'));
  assert.equal(status.present, false);
  assert.equal(status.status, 'no_status_file');
  // Silence must never read as health.
  assert.equal(status.stale, true);
  assert.equal(status.age_seconds, null);
});

test('an unreadable or non-object status file degrades without throwing', () => {
  const broken = server.internals.readPublicSyncStatus(NOW, tmpStatus('{not json'));
  assert.equal(broken.present, false);
  assert.equal(broken.status, 'unreadable');
  assert.equal(broken.stale, true);

  const notObject = server.internals.readPublicSyncStatus(NOW, tmpStatus('[1,2,3]'));
  assert.equal(notObject.present, false);
  assert.equal(notObject.stale, true);
});

test('a missing or unparseable timestamp is stale, not assumed fresh', () => {
  const noStamp = server.internals.readPublicSyncStatus(NOW, tmpStatus(JSON.stringify({ result: 'ok' })));
  assert.equal(noStamp.present, true);
  assert.equal(noStamp.age_seconds, null);
  assert.equal(noStamp.stale, true);

  const badStamp = server.internals.readPublicSyncStatus(NOW, tmpStatus(JSON.stringify({ last_run_at: 'whenever' })));
  assert.equal(badStamp.stale, true);
});

test('the last failure is carried through so the UI can show why', () => {
  const file = tmpStatus(JSON.stringify({
    last_run_at: '2026-09-28T11:30:00Z', result: 'error',
    error: 'public push rejected', consecutive_failures: 3,
  }));
  const status = server.internals.readPublicSyncStatus(NOW, file);
  assert.equal(status.stale, false, 'a recent failure is fresh, it just failed');
  assert.equal(status.result, 'error');
  assert.equal(status.error, 'public push rejected');
  assert.equal(status.consecutive_failures, 3);
});
