'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isLocalRequest, TAILSCALE_PROXY_HEADERS } = require('./local_only');

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('a plain loopback caller is local', () => {
  assert.equal(isLocalRequest(req('127.0.0.1')), true);
  assert.equal(isLocalRequest(req('::1')), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1')), true);
});

test('a non-loopback caller is not local', () => {
  assert.equal(isLocalRequest(req('192.168.29.202')), false);
  assert.equal(isLocalRequest(req('100.101.102.103')), false);
});

test('a Tailscale-proxied request is not local even though it arrives on loopback', () => {
  // This is the whole point. Tailscale Serve terminates the tailnet connection
  // here and opens a new loopback connection, so the socket says 127.0.0.1 for
  // a remote caller. Without the header check every gated route is open.
  for (const name of TAILSCALE_PROXY_HEADERS) {
    assert.equal(
      isLocalRequest(req('127.0.0.1', { [name]: 'someone@example.com' })),
      false,
      `${name} must mark a proxied request as not-local`,
    );
  }
});

test('a non-loopback forwarded hop is not local', () => {
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' })), false);
});

test('a fully-loopback forwarded chain is still local', () => {
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), true);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '::1, 127.0.0.1' })), true);
});

test('a missing socket or headers object does not throw', () => {
  assert.equal(isLocalRequest({}), false);
  assert.equal(isLocalRequest(undefined), false);
});
