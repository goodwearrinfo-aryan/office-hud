'use strict';
// Contract test for /api/polymarket/status.
//
// This payload had no TypeScript type at all — it was the last unaudited
// server→web surface, fetched as an untyped blob. The interface now exists, and
// this file is what stops it drifting the way ProcessRecord and
// PolymarketExclusionSet had.
//
// Two properties are asserted that a structural check would miss:
//
//   1. `paper_only` and `execution_allowed` are REQUIRED BOOLEANS and are false
//      on this deployment. They are the paper/testnet boundary: the server
//      refuses to start anything unless paper_only holds
//      (paper_only_required, 409), and execution_allowed is true only when the
//      plist, the config and the loaded state all agree. Asserted here, never
//      modified — if a future change makes either true, that is a finding to
//      escalate, not something to fix from a contract-test branch.
//
//   2. Nullability is not optionality. The error/identity fields that the server
//      can genuinely send as null are typed `| null`; the four boundary booleans
//      are not nullable, because the server derives them with `&&` over booleans
//      and can never produce null.
//
// CONTRACT INSPECTION ONLY: nothing here starts the engine, places an order, or
// touches configuration.

const test = require('node:test');
const assert = require('node:assert/strict');
const { declaredMembers, hasInterface } = require('./helpers/interfaceMembers');
const {
  assertNoLiveOrderAdvertisement, assertExecutionImpliesPaperOnly,
  assertPaperGateOnMutations, assertInertIfConfigured,
} = require('./helpers/tradingSafety');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.js'), 'utf8');

const API_TS = path.join(__dirname, '..', '..', 'web', 'src', 'api.ts');
const LIVE_HIVE = path.join(os.homedir(), 'openalice-fleet', 'hive');

/** The exact 13 top-level fields the server's object literal produces. */
const EXPECTED_FIELDS = [
  'checked_at', 'engine_path', 'expected_engine_path', 'expected_plist_path',
  'paper_only', 'managed', 'running', 'pid', 'process', 'launchd', 'config', 'plist',
  'execution_allowed',
];

/** Fields the server can send as null, per its own expressions. */
const NULLABLE_TOP_LEVEL = ['pid'];

/** Boundary flags that must be booleans and must never be null. */
const BOUNDARY_FLAGS = ['paper_only', 'managed', 'running', 'execution_allowed'];


let http = null;
let apiSource = '';
let status = null;

test.before(async () => {
  apiSource = fs.readFileSync(API_TS, 'utf8');
  assert.ok(fs.existsSync(LIVE_HIVE), `live hive not found at ${LIVE_HIVE}; this test would compare empty payloads`);
  const { loadServer, startTestServer } = require('./helpers/harness');
  http = await startTestServer(loadServer(LIVE_HIVE).app);
  assert.equal(typeof http.get, 'function', 'the test server helper must expose get()');

  const res = await http.get('/api/polymarket/status');
  assert.equal(res.status, 200, '/api/polymarket/status should respond 200');
  status = res.json;
});

// The server's heartbeat and terminal ticker are not unref'd, so a file that
// never closes its listener hangs the runner instead of exiting.
test.after(async () => { await http?.close(); });

// ------------------------------------------------------- non-vacuous baseline

test('the response is a real object with all 13 fields', () => {
  assert.ok(status && typeof status === 'object', 'must be an object');
  assert.equal(Object.keys(status).length, 13,
    `expected exactly 13 top-level fields, got ${Object.keys(status).length}`);
  // Guards every assertion below against passing on an empty or default payload.
  assert.ok(status.checked_at, 'checked_at must be present and non-empty');
  assert.ok(status.engine_path, 'engine_path must be present and non-empty');
  assert.ok(Array.isArray(status.process.pids), 'process.pids must be an array');
  assert.ok(Array.isArray(status.process.commands), 'process.commands must be an array');
});

// ---------------------------------------------------------------- field names

test('all 13 field names are present', () => {
  for (const field of EXPECTED_FIELDS) {
    assert.ok(field in status, `missing field: ${field}`);
  }
});

test('no field beyond the 13 appears', () => {
  assert.deepEqual(Object.keys(status).sort(), [...EXPECTED_FIELDS].sort(),
    'the payload grew a field the declared type does not describe');
});

// ------------------------------------------------------- type vs declaration

test('PolymarketStatus declares exactly the fields the server sends', () => {
  const declared = declaredMembers(apiSource, 'PolymarketStatus');
  assert.deepEqual(
    [...declared].filter((k) => !EXPECTED_FIELDS.includes(k)),
    [],
    'PolymarketStatus declares fields the server never sends',
  );
  assert.deepEqual(
    EXPECTED_FIELDS.filter((k) => !declared.has(k)),
    [],
    'PolymarketStatus omits fields the server sends',
  );
});

test('the declared type is required, not optional, for every field', () => {
  const body = new RegExp('export interface PolymarketStatus\\s*\\{([\\s\\S]*?)\\n\\}', 'm')
    .exec(apiSource)[1];
  const optional = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].filter((m) => m[1].endsWith('?'));
  assert.deepEqual(optional, [],
    'every field is present on every response, so none may be declared optional');
});

test('the interface agrees with the live payload key-for-key', () => {
  const declared = declaredMembers(apiSource, 'PolymarketStatus');
  assert.deepEqual([...declared].sort(), Object.keys(status).sort(),
    'the declared members and the served members have drifted apart');
});

// ----------------------------------------------------- paper / testnet flags

test('the boundary flags are booleans, never null or undefined', () => {
  for (const flag of BOUNDARY_FLAGS) {
    assert.equal(typeof status[flag], 'boolean', `${flag} must be a boolean, got ${typeof status[flag]}`);
  }
});

test('paper_only is declared as a required boolean', () => {
  const body = new RegExp('export interface PolymarketStatus\\s*\\{([\\s\\S]*?)\\n\\}', 'm')
    .exec(apiSource)[1];
  assert.match(body, /^\s{2}paper_only: boolean;$/m,
    'paper_only must be declared `paper_only: boolean` with no ? and no | null');
  assert.match(body, /^\s{2}execution_allowed: boolean;$/m,
    'execution_allowed must be declared `execution_allowed: boolean` with no ? and no | null');
});

test('no live order path is advertised, on any machine', () => {
  // Replaces an assertion that read `paper_only must be false -- live orders are
  // not permitted`, which is inverted: the server derives paper_only from the
  // bot's own config, so TRUE is the state meaning live orders are not
  // permitted. See helpers/tradingSafety.js for the whole account; in short, it
  // asserted a fact about the machine (does a bot run here?) and passed only
  // where no bot ran, which is the least informative machine to ask.
  assertNoLiveOrderAdvertisement(status, '/api/polymarket/status');
  assertPaperGateOnMutations(REPO_ROOT);
});

test('the paper gate holds: execution_allowed implies paper_only', () => {
  assertExecutionImpliesPaperOnly(status, SERVER_SOURCE);
});

test('an inert deployment stays inert where that is required', () => {
  // Opt-in, because "inert" is a property of some deployments and not others.
  assertInertIfConfigured(status);
});



test('running and pid agree with each other', () => {
  if (status.running) {
    assert.notEqual(status.pid, null, 'a running engine must report a pid');
    assert.ok(status.process.pids.length > 0, 'a running engine must list its pids');
  } else {
    assert.equal(status.pid, null, 'a stopped engine must not report a pid');
    assert.equal(status.process.pids.length, 0, 'and must list no pids');
  }
});

// ---------------------------------------------------------- nested structures

test('launchd carries its seven keys with the right runtime types', () => {
  const l = status.launchd;
  assert.ok(l && typeof l === 'object', 'launchd must be an object');
  assert.deepEqual(
    Object.keys(l).sort(),
    ['error', 'expected_loaded', 'expected_path', 'loaded', 'path', 'pid', 'state'],
    'launchd shape drifted',
  );
  assert.equal(typeof l.loaded, 'boolean', 'launchd.loaded must be a boolean');
  assert.equal(typeof l.state, 'string', 'launchd.state must be a string');
  assert.equal(typeof l.expected_loaded, 'boolean', 'launchd.expected_loaded must be a boolean');
  assert.equal(typeof l.expected_path, 'string', 'launchd.expected_path must be a string');
  if (l.loaded) {
    assert.notEqual(l.pid === null || typeof l.pid === 'number', false);
  }
});

test('pid is a number when present and null when absent', () => {
  for (const [label, value] of [['launchd.pid', status.launchd.pid], ['pid', status.pid]]) {
    assert.ok(value === null || typeof value === 'number',
      `${label} must be number|null, got ${typeof value}`);
  }
});

test('config and plist carry their three keys each', () => {
  assert.deepEqual(Object.keys(status.config).sort(), ['error', 'path', 'present'],
    'config shape drifted');
  assert.deepEqual(Object.keys(status.plist).sort(), ['error', 'path', 'valid'],
    'plist shape drifted');
  assert.equal(typeof status.config.present, 'boolean', 'config.present must be a boolean');
  assert.equal(typeof status.plist.valid, 'boolean', 'plist.valid must be a boolean');
  assert.equal(typeof status.config.path, 'string', 'config.path must be a string');
  assert.equal(typeof status.plist.path, 'string', 'plist.path must be a string');
});

test('error fields are string|null, never omitted', () => {
  for (const [label, value] of [
    ['launchd.error', status.launchd.error],
    ['config.error', status.config.error],
    ['plist.error', status.plist.error],
  ]) {
    assert.ok(value === null || typeof value === 'string',
      `${label} must be string|null, got ${typeof value}`);
  }
});

test('engine_path and expected_engine_path are both reported', () => {
  assert.equal(typeof status.engine_path, 'string');
  assert.equal(typeof status.expected_engine_path, 'string');
  // They are reported separately precisely so a divergence is visible; the
  // server sets both from one constant today, but the UI is expected to compare
  // them rather than assume.
  assert.equal(typeof status.expected_plist_path, 'string');
});

test('the nullable top-level fields are exactly the ones the server can null', () => {
  for (const field of NULLABLE_TOP_LEVEL) {
    assert.ok(field in status, `${field} must be present even when null`);
  }
});

// -------------------------------------------------------------------- proof

test('a missing or retyped field fails this suite', () => {
  // Direct proof the assertions bite, rather than trusting that they would.
  const declared = declaredMembers(apiSource, 'PolymarketStatus');
  const phantom = new Set([...declared].filter((k) => !EXPECTED_FIELDS.includes(k)));
  assert.equal(phantom.size, 0, 'no phantom field may be declared');
  const rebuilt = Object.fromEntries([...declared].map((k) => [k, status[k]]));
  assert.deepEqual(Object.keys(rebuilt).sort(), Object.keys(status).sort(),
    'rebuilding from the declared type must reproduce the served key set');
});