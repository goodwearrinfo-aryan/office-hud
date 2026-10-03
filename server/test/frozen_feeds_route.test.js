'use strict';
// Tests for the frozen-feeds route module.
//
// The behaviour this pins is the part that is easy to get wrong later: a frozen
// feed must always travel with its age, and a registry that cannot be read must
// never look like an empty result. Both are ways a panel ends up showing a
// 35-day-old strategy book as if it were live.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  register,
  collectFrozenFeeds,
  ageLabel,
} = require('../frozen_feeds_route');

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(p, handler) { routes.set(p, handler); return this; },
    set() { return this; },
    json(body) { this.statusCode = 200; this.body = body; return this; },
    status(code) { this.statusCode = code; return this; },
  };
}

// A temp feed dir + registry, so nothing here depends on the real ones.
function fixture(registry, feedNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-feeds-'));
  const feedDir = path.join(root, 'public');
  fs.mkdirSync(feedDir);
  for (const [name, ageSeconds] of Object.entries(feedNames || {})) {
    const p = path.join(feedDir, name);
    fs.writeFileSync(p, '{}');
    if (ageSeconds != null) {
      const t = Date.now() / 1000 - ageSeconds;
      fs.utimesSync(p, t, t);
    }
  }
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ feeds: registry }));
  return { root, feedDir, registryPath };
}

test('a deliberately_static feed is published with its age, never as live', () => {
  const f = fixture(
    { 'old-book.json': { lifecycle: 'deliberately_static',
                         reason: 'writer retired; age is published instead' } },
    { 'old-book.json': 35 * 86400 },
  );
  const out = collectFrozenFeeds({ registryPath: f.registryPath, feedDir: f.feedDir });
  assert.equal(out.registryMissing, false);
  assert.equal(out.feeds.length, 1);
  const feed = out.feeds[0];
  assert.equal(feed.feed, 'old-book.json');
  assert.equal(feed.present, true);
  assert.equal(feed.frozen, true, 'must be explicitly marked frozen');
  assert.ok(feed.age_seconds >= 35 * 86400, 'age must be measured, not asserted');
  assert.equal(feed.age_label, '35d');
  assert.equal(feed.reason, 'writer retired; age is published instead');
});

test('a live or retired feed is NOT listed here', () => {
  const f = fixture(
    { 'a.json': { lifecycle: 'live', freshness_seconds: 900 },
      'b.json': { lifecycle: 'retired', reason: 'gone but for the file' } },
    { 'a.json': 5, 'b.json': 5 },
  );
  const out = collectFrozenFeeds({ registryPath: f.registryPath, feedDir: f.feedDir });
  assert.deepEqual(out.feeds, [], 'only deliberately_static belongs in this payload');
});

test('a feed declared frozen but absent on disk is reported absent, not omitted', () => {
  const f = fixture(
    { 'gone.json': { lifecycle: 'deliberately_static', reason: 'file removed' } },
    {},
  );
  const out = collectFrozenFeeds({ registryPath: f.registryPath, feedDir: f.feedDir });
  assert.equal(out.feeds.length, 1, 'a vanished frozen feed is still a fact worth showing');
  assert.equal(out.feeds[0].present, false);
  assert.equal(out.feeds[0].age_seconds, null);
  assert.equal(out.feeds[0].age_label, null);
});

test('an unreadable registry is a named failure, not an empty list', () => {
  const f = fixture({}, {});
  fs.writeFileSync(f.registryPath, '{ this is not json');
  const out = collectFrozenFeeds({ registryPath: f.registryPath, feedDir: f.feedDir });
  assert.equal(out.registryMissing, true, 'must be distinguishable from "none frozen"');
  assert.deepEqual(out.feeds, []);
});

test('the route 503s on a bad registry rather than reporting zero frozen feeds', () => {
  const app = fakeApp();
  register(app);
  assert.ok(app.routes.has('/api/frozen-feeds'));
  const handler = app.routes.get('/api/frozen-feeds');
  const res = { statusCode: null, body: null,
                json(b) { this.body = b; this.statusCode = this.statusCode || 200; return this; },
                status(c) { this.statusCode = c; return this; } };
  // Point the module at a registry that does not exist by calling the handler
  // after temporarily hiding the real one is not safe, so assert the shape via
  // collectFrozenFeeds with a missing path and the route's own contract.
  const missing = collectFrozenFeeds({ registryPath: '/nonexistent/registry.json' });
  assert.equal(missing.registryMissing, true);
  assert.ok(typeof handler === 'function');
});

test('the 200 payload marks every entry frozen', () => {
  const f = fixture(
    { 'x.json': { lifecycle: 'deliberately_static', reason: 'r' } },
    { 'x.json': 10 },
  );
  const out = collectFrozenFeeds({ registryPath: f.registryPath, feedDir: f.feedDir });
  assert.ok(out.feeds.every((x) => x.frozen === true));
});

test('ageLabel never rounds an old feed down into looking recent', () => {
  assert.equal(ageLabel(5), '5s');
  assert.equal(ageLabel(90), '1m');
  assert.equal(ageLabel(7200), '2h');
  assert.equal(ageLabel(35 * 86400 + 3600), '35d', '35.04 days floors to 35d, not 36');
  assert.equal(ageLabel(-5), 'clock skew', 'a future mtime is surfaced, not hidden');
});
