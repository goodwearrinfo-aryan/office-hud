// Regression tests for floor-health producer resolution.
//
// The mini reported all twelve floors UNKNOWN with "hive/lib/floor_health.py
// is missing" for one reason: hive/ is git-ignored, so the producer module was
// a laptop-only file that git could never deliver. A deployment gap was being
// rendered as a fleet-wide health failure, and every consumer downstream
// (manager_alive, the Office page, hud-guard) inherited it.
//
// These tests pin the shipped resolver, and assert the tracked copy exists --
// that is the invariant whose absence caused the whole incident.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getFloorHealth, resolveScript, FLOOR_IDS } = require('./floor_health');

const TRACKED = path.join(__dirname, 'floor_health.py');

test('the tracked producer is committed beside the module that runs it', () => {
  assert.ok(fs.existsSync(TRACKED),
    'office-hud/server/floor_health.py must exist in the repo: hive/ is '
    + 'git-ignored, so this copy is the only way a fresh host gets floor health');
  assert.ok(fs.readFileSync(TRACKED, 'utf8').includes('def main'),
    'tracked producer looks truncated');
});

test('the hive copy still wins when present', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fh-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const inHive = path.join(dir, 'lib', 'floor_health.py');
  fs.writeFileSync(inHive, '#!/usr/bin/env python3\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(resolveScript(dir), inHive);
});

test('falls back to the tracked sibling when the hive has no copy', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveScript(dir), TRACKED);
});

test('a missing producer names both places searched, never one', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = resolveScript;
  // Force the "found nothing" branch by pointing at a directory with no sibling.
  const isolated = path.join(dir, 'nothing.js');
  fs.copyFileSync(path.join(__dirname, 'floor_health.js'), isolated);
  const mod = require(isolated);
  const res = mod.getFloorHealth(dir);
  assert.equal(res.source, 'unavailable');
  assert.equal(res.not_verified, true);
  const reason = res.floors[0].reason;
  assert.ok(reason.includes(path.join(dir, 'lib', 'floor_health.py')),
    'reason must name the hive location');
  assert.ok(reason.includes('floor_health.py'),
    'reason must name the tracked location too');
  assert.ok(!reason.startsWith('hive/lib/floor_health.py is missing'),
    'the old single-path message hid half the search');
  assert.equal(res.floors.length, FLOOR_IDS.length,
    'an unavailable producer must still yield one row per floor');
});

test('unavailable floors are never reported healthy', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fh-'));
  fs.writeFileSync(path.join(dir, 'floor_health.py'), '#!/bin/sh\nexit 1\n');
  fs.mkdirSync(path.join(dir, 'lib'));
  const res = getFloorHealth(dir);
  for (const f of res.floors) {
    assert.notEqual(f.state, 'OK');
    assert.notEqual(f.state, 'WORKING');
    assert.equal(f.manager_alive, false,
      'a floor whose producer failed cannot be claimed alive');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
