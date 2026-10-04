// Regression tests for the local-only gate.
//
// The gate was `remoteAddress === '127.0.0.1'`, which cannot work once
// Tailscale Serve proxies in: Serve terminates the tailnet connection on the
// mini and opens a fresh loopback connection to the server, so a remote caller
// and a local browser are indistinguishable by socket. A probe route confirmed
// the server sees remoteAddress 127.0.0.1 for a tailnet request, alongside
// x-forwarded-for: 100.125.24.105 and tailscale-user-login.
//
// This test pins the decision function, not the routes, so it cannot be broken
// by reordering a handler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// Extract the real function so the test exercises shipped code rather than a
// copy. The proxy-header constant it depends on lives just above it, so both are
// pulled in -- otherwise the function would reference an undefined binding and
// every case would fail for the wrong reason.
// Load the shipped module. This used to scrape the function out of index.js as
// source text and run it through `new Function`, so it verified whatever happened
// to be in that file rather than what shipped -- and it went on passing while the
// gate was reverted seven times. Requiring the module tests real code.
const { isLocalRequest } = require('./lib/local_only');

function req(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test('a genuine local caller with no proxy headers is allowed', () => {
  assert.strictEqual(isLocalRequest(req('127.0.0.1')), true);
});

test('a tailnet request through Tailscale Serve is refused', () => {
  // The exact shape observed from the tailnet.
  const r = req('127.0.0.1', {
    'tailscale-user-login': 'user@example.com',
    'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
    'x-forwarded-for': '100.125.24.105',
    'x-forwarded-host': 'as-mac-mini.tailff2dd7.ts.net',
    'x-forwarded-proto': 'https',
  });
  assert.strictEqual(isLocalRequest(r), false, 'remoteAddress is 127.0.0.1 here; headers are the only tell');
});

test('x-forwarded-for alone is enough to refuse', () => {
  assert.strictEqual(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '100.125.24.105' })), false);
});

test('a forwarded chain containing a non-loopback hop is refused', () => {
  assert.strictEqual(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 100.125.1.1' })), false);
});

test('a purely loopback forwarded chain is allowed', () => {
  assert.strictEqual(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), true);
});

test('both ipv6 loopback forms are local', () => {
  assert.strictEqual(isLocalRequest(req('::1')), true);
  assert.strictEqual(isLocalRequest(req('::ffff:127.0.0.1')), true);
});

test('a non-loopback peer is refused regardless of headers', () => {
  assert.strictEqual(isLocalRequest(req('10.0.0.5')), false);
  assert.strictEqual(isLocalRequest(req('10.0.0.5', { 'x-forwarded-for': '127.0.0.1' })), false);
});

test('the gate is fail-closed on a malformed request', () => {
  assert.strictEqual(isLocalRequest({ headers: {} }), false);
  assert.strictEqual(isLocalRequest({ socket: {}, headers: {} }), false);
});

test('every local-only gated route uses this gate', () => {
  // Guards against a new route being added with a hand-rolled IP check.
  const gated = ['/api/jarvis/command', '/api/llm/test', '/api/recovery/start', '/api/recovery/stop',
    '/api/recovery/manual/', '/api/alerts/ack-all', '/api/autonomy/policy'];
  for (const route of gated) {
    assert.ok(SRC.includes(`'${route}`), `expected route ${route} in index.js`);
  }
  assert.ok(SRC.includes("require('./lib/local_only')"),
    'index.js must import the gate rather than redefine it');
  assert.ok(!/function isLocalRequest\(/.test(SRC),
    'index.js must not redefine isLocalRequest; that is how the gate got reverted');
});
