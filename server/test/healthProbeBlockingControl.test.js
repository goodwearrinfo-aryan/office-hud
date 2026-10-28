'use strict';
// Positive control for the stall guard.
//
// healthProbeDeadline.test.js asserts that a slow probe leaves /api/agents and the
// event loop alone. That assertion is only worth what it can detect, so this file runs
// the same measurements against the handler it replaced -- reproduced here as it stood
// in server/index.js at 91c7270, execFileSync and all -- and requires them to FAIL.
//
// Without this, a suite that quietly stopped exercising the route, or a peer route that
// is itself blocked, would look like proof of a fix. If these assertions ever flip, the
// guard has been neutered rather than satisfied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { execFileSync } = require('child_process');

const { startTestServer } = require('./helpers/harness');

const HIVE_STATUS = { hive: '/tmp/positive-control-hive', label: 'Fleet hive', present: true };

/** server/index.js at 91c7270, verbatim apart from the injected probe path. */
function blockingHealthHandler(probeScript) {
  return (_req, res) => {
    try {
      const output = execFileSync('/usr/bin/python3', [probeScript]);
      const probeResult = JSON.parse(output.toString());
      res.json({ ...probeResult, ...HIVE_STATUS, ts: Date.now() });
    } catch (_) {
      res.json({ ok: false, ...HIVE_STATUS, ts: Date.now() });
    }
  };
}

function writeProbe(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-blocking-control-'));
  const file = path.join(dir, 'slow_probe.py');
  fs.writeFileSync(file, [
    'import json, time',
    `time.sleep(${seconds})`,
    'print(json.dumps({"ok": True, "checks": [], "failing": [], "warnings": [], "not_verified": []}))',
  ].join('\n'));
  return { dir, file };
}

function appWith(probeScript) {
  const app = express();
  app.get('/api/health', blockingHealthHandler(probeScript));
  // A cheap peer, so the only thing that can make it slow is the shared event loop.
  app.get('/api/agents', (_req, res) => res.json({ agents: [{ id: 'worker-a' }] }));
  return app;
}

test('the old blocking handler does stall a peer route -- so the guard can fire', async () => {
  const { dir, file } = writeProbe(1.5);
  const http = await startTestServer(appWith(file));
  try {
    // The peer's clock starts before the health request is issued, and stops when the
    // peer itself resolves. Measuring up to the health response would not work: a slow
    // health route is slow by definition, so the span would read as a stall even for a
    // handler that never blocked the loop.
    const startedAt = Date.now();
    const healthPromise = http.get('/api/health');
    const peerPromise = http.get('/api/agents');
    const peer = await peerPromise;
    const peerMs = Date.now() - startedAt;
    const health = await healthPromise;

    assert.equal(health.json.ok, true, 'the control probe should have answered');
    assert.equal(peer.json.agents.length, 1);
    assert.ok(peerMs >= 1000,
      `the blocking handler let /api/agents answer in ${peerMs}ms -- there is no stall to guard`);
  } finally {
    await new Promise((resolve) => http.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the old blocking handler does starve the event loop -- so the tick guard can fire', async () => {
  const { dir, file } = writeProbe(1.5);
  const http = await startTestServer(appWith(file));
  const ticks = [];
  const startedAt = Date.now();
  const ticker = setInterval(() => ticks.push(Date.now()), 25);
  try {
    await http.get('/api/health');
    // Lateness of the first tick, not the widest gap between ticks: while the loop is
    // blocked every queued callback fires in one burst, so the gaps inside that burst
    // read 0ms and the starvation is only visible against when the tick was due.
    const firstTickLateness = ticks.length ? ticks[0] - startedAt - 25 : 0;
    assert.ok(firstTickLateness >= 1000,
      `the 25ms ticker fired ${firstTickLateness}ms late -- a loop this free is not a stall`);
  } finally {
    clearInterval(ticker);
    await new Promise((resolve) => http.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the old handler answers later than the shortest caller budget', async () => {
  const { dir, file } = writeProbe(3.2);
  const http = await startTestServer(appWith(file));
  const { MIN_CALLER_BUDGET_MS } = require('../lib/healthProbe');
  try {
    const startedAt = Date.now();
    await http.get('/api/health');
    const ms = Date.now() - startedAt;
    // 45s was the competing PR's default; anything above the caller budget is a
    // guaranteed timeout for control-center, which is the outage this route reports.
    assert.ok(ms > MIN_CALLER_BUDGET_MS,
      `a ${ms}ms probe answered inside the caller budget, so the deadline is not the fix`);
  } finally {
    await new Promise((resolve) => http.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
