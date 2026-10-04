'use strict';
// The portal proxy is the one place where a request path could escape its
// intended upstream, so its guards are asserted directly rather than only
// through the HTTP surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer, makeFixtureHive } = require('./helpers/harness');

// loadServer() with no argument used to set OFFICE_HUD_HIVE to the truthy
// string "undefined", pointing the server at ./undefined/ -- so these
// assertions silently ran against an empty hive. The harness now
// refuses that; pass a real fixture even though these suites only
// exercise pure functions.
const server = loadServer(makeFixtureHive().hive);
const { portalTarget, rewriteUpstreamLocation, portalSlugForPort, PORTAL_SERVICES } =
  server.internals;

test('every allowlisted service resolves to a loopback target', () => {
  assert.ok(PORTAL_SERVICES.size > 0);
  for (const [slug, entry] of PORTAL_SERVICES) {
    const target = portalTarget(slug, 'some/path.json');
    assert.ok(target, slug);
    assert.equal(target.entry.port, entry.port);
    assert.equal(target.targetPath, '/some/path.json');
  }
});

test('an unknown slug is refused', () => {
  assert.equal(portalTarget('nope', '/'), null);
  assert.equal(portalTarget('../../etc', '/'), null);
  assert.equal(portalTarget('', '/'), null);
});

test('traversal segments are refused', () => {
  assert.equal(portalTarget('dash', '../../etc/passwd'), null);
  assert.equal(portalTarget('dash', 'a/../../b'), null);
  assert.equal(portalTarget('dash', './x'), null);
  assert.equal(portalTarget('dash', 'a/./b'), null);
});

test('header injection via the path is refused', () => {
  assert.equal(portalTarget('dash', 'x\r\nHost: evil'), null);
  assert.equal(portalTarget('dash', 'x\ny'), null);
});

test('the path cannot re-point the request at another host', () => {
  const target = portalTarget('dash', 'http://evil.example/x');
  // stays a path on the allowlisted port; the host is never taken from input
  assert.equal(target.targetPath, '/http://evil.example/x');
});

test('a leading slash is normalised, not doubled', () => {
  assert.equal(portalTarget('dash', '/index.html').targetPath, '/index.html');
  assert.equal(portalTarget('dash', '///index.html').targetPath, '/index.html');
  assert.equal(portalTarget('dash', '').targetPath, '/');
});

test('redirects onto a portal port are rewritten into this origin', () => {
  assert.equal(rewriteUpstreamLocation('http://127.0.0.1:3002/x'), '/port/dash/x');
  assert.equal(rewriteUpstreamLocation('http://localhost:3002/'), '/port/dash/');
  assert.equal(rewriteUpstreamLocation('http://127.0.0.1:8765/api/state'), '/port/bot/api/state');
  assert.equal(rewriteUpstreamLocation('http://127.0.0.1:8765/api/state?x=1'), '/port/bot/api/state?x=1');
});

test('redirects off the allowlist are left untouched', () => {
  assert.equal(rewriteUpstreamLocation('https://example.com/x'), 'https://example.com/x');
  assert.equal(rewriteUpstreamLocation('http://127.0.0.1:9999/x'), 'http://127.0.0.1:9999/x');
  assert.equal(rewriteUpstreamLocation('/relative'), '/relative');
  assert.equal(rewriteUpstreamLocation(''), '');
});

test('port lookup maps both ways', () => {
  assert.equal(portalSlugForPort(3002), 'dash');
  assert.equal(portalSlugForPort(8765), 'bot');
  assert.equal(portalSlugForPort(1), null);
});
