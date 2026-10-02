'use strict';

// Decides whether a request came from this machine, for the local-only routes
// (terminal spawn/kill, recovery engine, autonomy policy, jarvis command, and
// the other mutating endpoints).
//
// This lives in its own module, not inline in server/index.js, because
// index.js is ~130KB and is concurrently rewritten by another agent. Five times
// now an in-flight edit has reverted the check here, and because launchd
// restarts office-hud within a second of each write, a naive version reached
// production and left the mutating routes open to the whole tailnet. A module
// that no one rewrites cannot be reverted by accident.
//
// Why remoteAddress is not sufficient: Tailscale Serve terminates the tailnet
// connection on this host and then opens a NEW loopback connection to the app.
// A remote caller and a local browser both arrive as 127.0.0.1, so the socket
// address cannot tell them apart -- an earlier version checked only that, and
// every gated route was reachable from any device on the tailnet with no auth.
//
// Tailscale sets these headers on proxied requests and overwrites them on the
// way through, so a remote caller cannot strip them to slip past this check.
const TAILSCALE_PROXY_HEADERS = ['tailscale-user-login', 'tailscale-headers-info'];

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalRequest(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || '';
  if (!isLoopback(address)) return false;

  const headers = (req && req.headers) || {};
  if (TAILSCALE_PROXY_HEADERS.some((name) => headers[name])) return false;

  // A forwarded chain is only trusted when every hop is loopback. A remote hop
  // means the request was proxied, whatever the socket says.
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const hops = String(forwarded).split(',').map((value) => value.trim());
    if (!hops.every((hop) => isLoopback(hop) || /^127\./.test(hop))) return false;
  }

  return true;
}

module.exports = { isLocalRequest, isLoopback, TAILSCALE_PROXY_HEADERS };