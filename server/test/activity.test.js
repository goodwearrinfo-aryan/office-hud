'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activitySnapshot, mountActivityRoute } = require('../lib/activity');

// Unit-read of the aggregate, independent of express.
test('activitySnapshot groups shells by cwd and counts by host', () => {
  const out = activitySnapshot({
    hosts: [{ host: 'mini', stale: false }],
    terminals: [
      { cwd: '/Users/a', command: '-zsh', kind: 'shell', host: 'mini', host_stale: false, age_sec: 10 },
      { cwd: '/Users/a', command: '-zsh', kind: 'shell', host: 'mini', host_stale: false, age_sec: 20 },
      { cwd: '/Users/a/trading/openalice-fleet', command: '-zsh', kind: 'shell', host: 'mini', host_stale: false, age_sec: 30 },
      { cwd: '/proc/stale-laptop', command: '-zsh', kind: 'shell', host: 'laptop-123', host_stale: 'True', age_sec: 9000 },
    ],
    stale_hosts: ['laptop-123'],
  });
  assert.equal(out.totals.shells, 4);
  assert.equal(out.totals.projects, 3);
  assert.equal(out.totals.stale_hosts, 1);
  // sorted by shell count desc
  assert.equal(out.projects[0].cwd, '/Users/a');
  assert.equal(out.projects[0].shells, 2);
  assert.equal(out.projects[0].last_seen_age_sec, 20);
  // stale host propagates to the workspace badge
  const laptopProject = out.projects.find((p) => p.host === 'laptop-123' || p.hosts.includes('laptop-123'));
  assert.ok(laptopProject, 'laptop project exists');
  assert.equal(laptopProject.host_stale, true);
  // plain zshs do not count as 'running a command'
  assert.equal(out.projects[0].running_a_command, false);
});

test('activitySnapshot tolerates malformed/missing payload fields', () => {
  const a = activitySnapshot(null);
  assert.deepEqual(a.totals.shells, 0);
  assert.equal(a.projects.length, 0);
  const b = activitySnapshot({ terminals: 'not-an-array', hosts: null, stale_hosts: null });
  assert.equal(b.totals.shells, 0);
  const c = activitySnapshot({ terminals: [{ command: 'claude --continue', kind: 'shell' }] });
  assert.equal(c.projects.length, 1);
  assert.equal(c.projects[0].running_a_command, true);
});

test('mountActivityRoute registers exactly /api/activity and renders JSON', () => {
  const routes = new Map();
  const fakeApp = { get: (p, h) => routes.set(p, h) };
  const handler = mountActivityRoute(fakeApp, { snapshotFn: () => ({ terminals: [{ cwd: '/x', command: '-zsh', host: 'mini' }] }) });
  assert.ok(routes.has('/api/activity'), 'route registered at /api/activity');
  let payload = null;
  routes.get('/api/activity')({}, { set: () => {}, json: (j) => { payload = j; }, status: () => ({ json: (j) => { payload = j; } }) });
  assert.ok(payload, 'response JSON captured');
  assert.equal(payload.totals.shells, 1);
  assert.equal(payload.projects[0].cwd, '/x');
});

test('mountActivityRoute produces a 503, not a crash, when the snapshot fails', () => {
  const routes = new Map();
  const fakeApp = { get: (p, h) => routes.set(p, h) };
  mountActivityRoute(fakeApp, { snapshotFn: () => { throw new Error('hive corrupt'); } });
  let status = 0; let payload = null;
  routes.get('/api/activity')({}, { set: () => {}, status: (s) => ({ json: (j) => { status = s; payload = j; } }) });
  assert.equal(status, 503);
  assert.equal(payload.error, 'activity_unavailable');
});
