'use strict';

// Every state-changing route must be accounted for.
//
// The local-only gate was reverted seven times in one session, each time by an
// in-flight edit that replaced the whole check with a loopback-only test while
// every call site kept calling it. Nothing failed: the code still ran, the
// routes still answered, and a tailnet caller could start the recovery engine.
// A test that only probes the endpoint would have caught the symptom late, so
// this asserts the source-level contract instead:
//
//   1. index.js must not define isLocalRequest inline. The gate lives in
//      lib/local_only.js precisely so an edit to this file cannot revert it.
//   2. Every mutating route must be either gated, or listed below with a reason.
//      A new mutating route fails this test until someone decides which it is,
//      so "we forgot to protect it" cannot merge silently.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Mutating routes deliberately reachable without the local-only gate, each with
// why. These are NOT protected today; recording them is the honest state and
// keeps the failure from being silently discovered later. Narrowing any of
// these is a behaviour change and needs its own decision.
const ALLOWLIST = {
  'POST /api/llm/costs/reset/daily': 'resets a local cost counter; no external effect',
  'POST /api/llm/costs/reset/monthly': 'resets a local cost counter; no external effect',
  'POST /api/llm/circuit-breakers/reset': 're-arms breakers; fleet calls it by design',
  'POST /api/polymarket/markets/exclude': 'edits a local market filter',
  'POST /api/polymarket/markets/include': 'edits a local market filter',
  'POST /api/polymarket/trades/clear': 'clears local trade records; returns 428 without a precondition',
  'POST /api/polymarket/start': 'control plane the fleet drives remotely by design',
  'POST /api/polymarket/stop': 'control plane the fleet drives remotely by design',
  'POST /api/sessions/:id/reattach': 're-attaches an existing local session',
};

function mutatingRoutes(src) {
  const out = [];
  const re = /app\.(post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const next = src.indexOf('app.', start + m[0].length);
    const body = src.slice(start, next === -1 ? src.length : next);
    out.push({
      method: m[1].toUpperCase(),
      path: m[2],
      gated: body.includes('isLocalRequest'),
    });
  }
  return out;
}

test('index.js does not define the gate inline', () => {
  assert.ok(
    !/function isLocalRequest\s*\(/.test(SRC),
    'index.js must not define isLocalRequest; that is how the gate got reverted 7 times. '
      + 'Import it from lib/local_only.js instead.',
  );
  assert.ok(
    SRC.includes("require('./lib/local_only')"),
    'index.js must import the gate from lib/local_only.js',
  );
});

test('every mutating route is gated or explicitly accounted for', () => {
  const routes = mutatingRoutes(SRC);
  assert.ok(routes.length > 0, 'expected to find mutating routes');

  const unaccounted = routes.filter(
    (r) => !r.gated && !ALLOWLIST[`${r.method} ${r.path}`],
  );
  assert.deepStrictEqual(
    unaccounted.map((r) => `${r.method} ${r.path}`),
    [],
    'new mutating route(s) added without the local-only gate and without an entry '
      + 'in ALLOWLIST: protect it or document why not',
  );
});

test('the routes that protect the control plane are still gated', () => {
  const routes = mutatingRoutes(SRC);
  const mustBeGated = [
    'POST /api/recovery/start',
    'POST /api/recovery/stop',
    'POST /api/autonomy/policy',
    'POST /api/jarvis/command',
  ];
  for (const key of mustBeGated) {
    const r = routes.find((x) => `${x.method} ${x.path}` === key);
    assert.ok(r, `${key} is missing entirely`);
    assert.ok(r.gated, `${key} must be gated by isLocalRequest`);
  }
});

test('the allowlist is not stale: every entry still exists as a route', () => {
  const routes = mutatingRoutes(SRC);
  const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const stale = Object.keys(ALLOWLIST).filter((k) => !known.has(k));
  assert.deepStrictEqual(
    stale, [],
    'ALLOWLIST names routes that no longer exist; remove them or the exemption is dead weight',
  );
});
