// Tests for the wedged-process feed reader.
//
// The properties that matter are defensive ones: a missing, mid-write or
// malformed feed must serve an empty payload rather than throw, because the
// office-hud reads several machines' hive directories and a collector that has
// not run yet is normal. A feed without a collected_at must never be reported
// as live, because a live flag that cannot be trusted is worse than no flag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildWedgedPayload } = require('../lib/wedgedProcesses');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wedged-'));
}

test('a missing feed serves an empty payload and does not throw', () => {
  const p = buildWedgedPayload(tmpdir());
  assert.deepStrictEqual(p.wedged, []);
  assert.strictEqual(p.live, false);
  assert.strictEqual(p.totals, null);
});

test('a malformed feed serves an empty payload, not a crash', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'wedged.json'), '{not json');
  const p = buildWedgedPayload(dir);
  assert.deepStrictEqual(p.wedged, []);
  assert.strictEqual(p.live, false);
});

test('a real feed is passed through and reported live', () => {
  const dir = tmpdir();
  const doc = {
    host: 'mac-mini-hive',
    collected_at: '2026-09-30T06:30:00+00:00',
    wedged: [{
      pid: 12828,
      ppid: 12817,
      etime: '04:37:05',
      command: 'python scripts/run_quality_gate.py',
      tree: [{ pid: 27250, wedged: true }],
    }],
    totals: { processes_seen: 710, wedged_roots: 1 },
  };
  fs.writeFileSync(path.join(dir, 'wedged.json'), JSON.stringify(doc));
  const p = buildWedgedPayload(dir);
  assert.strictEqual(p.live, true);
  assert.strictEqual(p.collected_at, doc.collected_at);
  assert.strictEqual(p.wedged.length, 1);
  assert.strictEqual(p.wedged[0].pid, 12828);
  assert.strictEqual(p.totals.wedged_roots, 1);
});

test('a feed missing collected_at is served but never reported live', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'wedged.json'), JSON.stringify({ wedged: [{ pid: 4242 }] }));
  const p = buildWedgedPayload(dir);
  assert.strictEqual(p.live, false);
  assert.strictEqual(p.wedged.length, 1);
});

test('a non-array wedged field is dropped, not passed through', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'wedged.json'), JSON.stringify({ wedged: 'oops', collected_at: 'x' }));
  const p = buildWedgedPayload(dir);
  assert.deepStrictEqual(p.wedged, []);
});

test('an empty wedged array with a real collected_at is live but empty', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'wedged.json'), JSON.stringify({
    host: 'h', collected_at: '2026-09-30T06:30:00+00:00', wedged: [],
  }));
  const p = buildWedgedPayload(dir);
  assert.strictEqual(p.live, true);
  assert.deepStrictEqual(p.wedged, []);
});

test('a command carrying a credential is redacted before serving', () => {
  const dir = tmpdir();
  const doc = {
    host: 'h',
    collected_at: '2026-09-30T06:30:00+00:00',
    wedged: [{
      pid: 4242,
      command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrst" https://x',
      tree: [{ pid: 4243, command: 'node script.js --api-key=supersecretvalue123' }],
    }],
  };
  fs.writeFileSync(path.join(dir, 'wedged.json'), JSON.stringify(doc));
  const p = buildWedgedPayload(dir);
  const f = p.wedged[0];
  assert.ok(!/sk-abcdefghijklmnopqrst/.test(f.command), 'bearer token leaked at top level');
  assert.ok(!/supersecretvalue123/.test(f.tree[0].command), 'api key leaked in tree member');
});
