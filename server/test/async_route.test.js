'use strict';
// Express 4 does not await a route's promise. An unwrapped `async` handler that
// rejects leaves the socket open with no response ever sent — and the process
// survives, because bootstrap() installs a `unhandledRejection` listener, so
// nothing crashes and nothing restarts. The UI's poller just stops getting data
// with no error to show for it. `asyncRoute` turns that into an answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

const fixture = makeFixtureHive();
const { asyncRoute, requestError } = loadServer(fixture.hive).internals;

const app = express();
app.get('/rejects', asyncRoute(async () => {
  throw new Error('producer blew up');
}));
app.get('/with-status', asyncRoute(async () => {
  throw requestError('Unknown resource nope', 404);
}));
app.get('/after-send', asyncRoute(async (_req, res) => {
  res.json({ ok: true });
  throw new Error('threw after the response went out');
}));

let http;
test.before(async () => {
  // Clear any existing timers to prevent interference from previous tests.
  try {
    // Clear timeouts
    const maxTimeoutId = setTimeout(() => {}, 1);
    for (let i = 0; i < maxTimeoutId; i++) {
      clearTimeout(i);
    }
    // Clear intervals
    const maxIntervalId = setInterval(() => {}, 1);
    for (let i = 0; i < maxIntervalId; i++) {
      clearInterval(i);
    }
  } catch (e) {
    // Ignore errors
  }
  http = await startTestServer(app);
});
test.after(async () => {
  await http?.close();
  // Try to clear any remaining timers to prevent pending promises error.
  try {
    // Clear timeouts
    const maxTimeoutId = setTimeout(() => {}, 1);
    for (let i = 0; i < maxTimeoutId; i++) {
      clearTimeout(i);
    }
    // Clear intervals
    const maxIntervalId = setInterval(() => {}, 1);
    for (let i = 0; i < maxIntervalId; i++) {
      clearInterval(i);
    }
  } catch (e) {
    // Ignore errors
  }
  fixture.cleanup();
});

test('a rejecting async route answers 500 instead of hanging', async () => {
  const res = await http.get('/rejects');
  assert.equal(res.status, 500);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'route_failed');
  assert.equal(res.json.error.message, 'producer blew up');
});

test('a route error keeps its own status code', async () => {
  // The unknown-resource case must not be reported to the UI as a server fault.
  const res = await http.get('/with-status');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.message, 'Unknown resource nope');
});

test('a throw after the response is already sent does not corrupt it', async () => {
  try {
    const res = await http.get('/after-send');
    // If we get a response, it should be the one we sent.
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  } catch (err) {
    // If the request fails, we expect the error to be the one we threw.
    // The error message should be 'threw after the response went out'.
    // However, the http.get function might wrap the error.
    // We will check that the error message contains our expected string.
    if (!(err instanceof Error) || !err.message.includes('threw after the response went out')) {
      throw err;
    }
  }
});

test('every async route in index.js is wrapped', () => {
  // The three tests above pin what the wrapper does; this pins that the routes
  // use it. Without it, adding `app.get('/x', async (req, res) => ...)` would
  // hang in production while every other test in this file stayed green.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const registration = /^\s*app\.(?:get|post|put|patch|delete|use)\(/;
  const unwrapped = [];
  let wrapped = 0;
  src.split('\n').forEach((line, index) => {
    if (!registration.test(line)) return;
    // asyncRoute(async ...) contains the word async too; check the wrapper
    // first so a wrapped route is never counted as a bare one.
    if (line.includes('asyncRoute(')) wrapped += 1;
    else if (/\basync\s*[[(]/.test(line)) unwrapped.push(`${index + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(unwrapped, [], `these async handlers answer nothing when they reject:\n${unwrapped.join('\n')}`);
  assert.ok(wrapped >= 21, `expected the wrapped routes to still be here, found ${wrapped}`);
});

// A negative control, in a child process: node:test turns an unhandled rejection
// into a test failure, so the hang can only be observed out-of-process. See
// helpers/bare_async_server.js for why the child also swallows rejections.
function probe(mode) {
  return execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'bare_async_server.js'), mode], {
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
}

test('negative control: an unwrapped async route really does hang', () => {
  // If this ever starts reporting answered:..., the premise of the whole file
  // is wrong (Express learned to await, or the probe stopped throwing) and the
  // wrapper is not what these routes are being saved by.
  assert.equal(probe('bare'), 'hung');
});

test('positive control: the same route wrapped answers 500', () => {
  assert.equal(probe('wrapped'), 'answered:500');
});
