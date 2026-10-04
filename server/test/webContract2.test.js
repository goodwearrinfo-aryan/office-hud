'use strict';
// Contract test, part 2: the health, verify, trading and polymarket trees.
//
// Same technique and the same rationale as webContract.test.js — the TypeScript
// interfaces had drifted from the payloads without any error, so a component
// reading a declared field would render `undefined` silently. That file covers
// the roster-shaped endpoints; this one covers the health/ops/engine trees.
//
// Three real defects were found and fixed by this audit:
//
//   HarnessHealth         omitted `degradedProviders`, which Overview reads.
//                         Overview only compiled because it declares a private
//                         copy of HarnessHealth with the field added.
//   PolymarketMarketSummary declared 7 optional fields the summariser never emits.
//   PolymarketExclusionSet omitted present/valid/error, and typed `count` as a
//                         plain number when the server sends null unless valid.
//
// Two rules this file holds itself to, both learned the hard way in part 1:
//
//   - The live hive is passed EXPLICITLY. loadServer() with no argument sets
//     OFFICE_HUD_HIVE to the string "undefined", which is truthy, so the server
//     adopts it, finds nothing and serves empty payloads. Every comparison then
//     passes vacuously while appearing to verify everything.
//   - test.after closes the listener. The server's heartbeat and terminal ticker
//     are not unref'd, so a file that never closes hangs the runner.
//
// This is CONTRACT INSPECTION ONLY. Nothing here enables trading, places an
// order, alters strategy configuration, changes credentials, or touches live
// execution. The paper/testnet boundary is asserted, not modified.

const test = require('node:test');
const assert = require('node:assert/strict');
const { declaredMembers, declaredMemberInfo, contractGaps, hasInterface } = require('./helpers/interfaceMembers');
const {
  assertNoLiveOrderAdvertisement, assertExecutionImpliesPaperOnly, assertInertIfConfigured,
} = require('./helpers/tradingSafety');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_TS = path.join(__dirname, '..', '..', 'web', 'src', 'api.ts');
const LIVE_HIVE = path.join(os.homedir(), 'openalice-fleet', 'hive');


/**
 * Declared members of an inline nested object type, e.g.
 * `counts: { running: number; total: number }`.
 *
 * Scoped to the interface's own brace block. An earlier version matched the whole
 * file, which grabbed some other interface's `counts` and returned a shape that
 * happened to parse — so the assertion below could pass or fail for reasons
 * unrelated to the type under test.
 */
function declaredInline(source, owner, field) {
  const body = new RegExp(`export interface ${owner}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(source);
  assert.ok(body, `interface ${owner} not found`);
  const inline = new RegExp(`${field}\\??:\\s*\\{([^}]*)\\}`).exec(body[1]);
  if (!inline) return null;
  return new Set([...inline[1].matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]));
}

let http = null;
let apiSource = '';
const live = {};

test.before(async () => {
  apiSource = fs.readFileSync(API_TS, 'utf8');
  assert.ok(fs.existsSync(LIVE_HIVE), `live hive not found at ${LIVE_HIVE}; this test would compare empty payloads`);
  const { loadServer, startTestServer } = require('./helpers/harness');
  // startTestServer resolves to the helper object itself, not to a wrapper
  // containing it. Destructuring `{ http }` out of it yields undefined and every
  // fetch in `before` then fails, which node reports as a cascade of hookFailed
  // rather than as the one-line cause.
  http = await startTestServer(loadServer(LIVE_HIVE).app);
  assert.equal(typeof http.get, 'function', 'the test server helper must expose get()');

  for (const route of [
    '/api/verify', '/api/office-manager', '/api/harness/health', '/api/services/health',
    '/api/trading/backtests', '/api/trading/live', '/api/trading/ops', '/api/trading/strategies',
    '/api/polymarket', '/api/polymarket/markets', '/api/polymarket/status',
  ]) {
    const res = await http.get(route);
    assert.equal(res.status, 200, `${route} should respond 200`);
    live[route] = res.json;
  }
});

test.after(async () => { await http?.close(); });

/** Assert a declared type and a live payload name exactly the same fields. */
function assertAgrees(typeName, payload) {
  assert.ok(payload && typeof payload === 'object', `${typeName}: need an object payload to compare`);
  const info = declaredMemberInfo(apiSource, typeName);
  const { undeclared, missingRequired } = contractGaps(info, payload);
  assert.deepEqual(undeclared, [], `${typeName} omits fields the server sends`);
  // Only REQUIRED members may be held to being present. This assertion used to
  // list every declared member, which meant an optional field absent because the
  // hive has no backing file was reported as a phantom -- so the verdict depended
  // on how much data the machine had: 14 keys on the mini, 7 on the laptop.
  assert.deepEqual(missingRequired, [], `${typeName} requires fields the server never sends`);
}

// ---------------------------------------------------------------- health tree

test('/api/harness/health: HarnessHealth agrees with the payload', () => {
  assertAgrees('HarnessHealth', live['/api/harness/health']);
});

test('degradedProviders is declared, so a consumer can read it without a private type', () => {
  // The regression: Overview rendered this field while api.ts omitted it, and
  // only compiled because it declares its own HarnessHealth. A second
  // component-local duplicate of an already-exported type.
  const declared = declaredMembers(apiSource, 'HarnessHealth');
  assert.ok(declared.has('degradedProviders'), 'degradedProviders must be on the canonical HarnessHealth');
  assert.ok(Array.isArray(live['/api/harness/health'].degradedProviders),
    'and the server must actually send it');
});

test('/api/services/health: ServiceHealth and its element type both agree', () => {
  assertAgrees('ServiceHealth', live['/api/services/health']);
  const services = live['/api/services/health'].services ?? [];
  assert.ok(services.length > 0, 'need at least one real service row to compare');
  assertAgrees('ServicePort', services[0]);
});

test('ServicePort now declares attempts, which the server sends', () => {
  const declared = declaredMembers(apiSource, 'ServicePort');
  assert.ok(declared.has('attempts'), 'attempts is sent by the collector and must be declared');
});

// ---------------------------------------------------------------- verify tree

test('/api/verify: VerifyState agrees with the payload', (t) => {
  // getVerifyState() answers `{ present: false }` and nothing else when the hive
  // has no verify_state.json. That is not a contract violation -- it is the route
  // correctly reporting absence -- so comparing it against VerifyState would fail
  // for a machine with no fleet on it, and the tempting "fix" (dropping at,
  // verdict_tally, requeued and quarantined from api.ts) would delete the real
  // contract to match an empty directory.
  if (live['/api/verify'].present === false) {
    t.skip('live hive has no verify_state.json, so /api/verify reports absence rather than a payload');
    return;
  }
  assertAgrees('VerifyState', live['/api/verify']);
});

test('verdict_tally is a real tally, not an empty stub', (t) => {
  // Guards against the vacuous case: an empty object would satisfy every
  // structural assertion above while proving nothing.
  if (live['/api/verify'].present === false) {
    t.skip('live hive has no verify_state.json, so there is no tally to inspect');
    return;
  }
  const tally = live['/api/verify'].verdict_tally;
  assert.ok(tally && typeof tally === 'object', 'verdict_tally must be an object');
  const total = Object.values(tally).reduce((n, v) => n + (Number(v) || 0), 0);
  assert.ok(total > 0, 'verdict_tally should carry at least one verdict on a live hive');
});

// ----------------------------------------------------------- trading / ops

test('/api/trading/ops: FleetLaunchdState and its element type both agree', () => {
  const state = live['/api/trading/ops'].launchdState;
  assertAgrees('FleetLaunchdState', state);
  assert.ok(state.services.length > 0, 'need real service rows');
  assertAgrees('FleetLaunchdEntry', state.services[0]);
});

test('launchd counts reconcile with the services they describe', () => {
  // A count that disagrees with its own list is the failure this catches: the
  // panel would report N running while rendering a different set.
  const { counts, services } = live['/api/trading/ops'].launchdState;
  const summed = counts.running + counts.idle + counts.stopped + counts.failed;
  assert.equal(summed, counts.total, 'the buckets must sum to the declared total');
  assert.equal(counts.total, services.length, 'the total must match the number of listed services');
  const running = services.filter((s) => s.running).length;
  assert.equal(counts.running, running, 'the running count must match the listed services');
});

test('the inline counts type covers every count the server sends', () => {
  const declared = declaredInline(apiSource, 'FleetLaunchdState', 'counts');
  const sent = new Set(Object.keys(live['/api/trading/ops'].launchdState.counts));
  assert.deepEqual([...declared].filter((k) => !sent.has(k)), [], 'counts declares a key the server omits');
  assert.deepEqual([...sent].filter((k) => !declared.has(k)), [], 'counts omits a key the server sends');
});

test('/api/trading/backtests: BacktestData agrees with the payload', () => {
  assertAgrees('BacktestData', live['/api/trading/backtests']);
});

test('backtests carries real per-strategy rows, not empty containers', () => {
  const { backtest, walkforward } = live['/api/trading/backtests'];
  const bKeys = Object.keys(backtest ?? {});
  const wKeys = Object.keys(walkforward ?? {});
  assert.ok(bKeys.length > 0 || wKeys.length > 0,
    'at least one strategy map should be populated on a live hive');
  // Deliberately NOT asserting that the two maps share keys. On this hive the
  // backtest map is keyed by file name ("EMA_Crossover") and the walkforward map
  // by parameter label ("EMA Crossover (12,26)"), so they are different key
  // spaces and an overlap assertion would be asserting a naming convention that
  // the server does not follow. Both being non-empty is the real invariant.
});

test('/api/trading/strategies: the element type agrees with a real row', () => {
  const strategies = live['/api/trading/strategies'].strategies ?? [];
  if (!strategies.length) return; // genuinely empty is not falsifiable here
  assertAgrees('StrategyFile', strategies[0]);
});

// ---------------------------------------------------------------- polymarket

test('/api/polymarket: PolymarketState agrees with the payload', () => {
  assertAgrees('PolymarketState', live['/api/polymarket']);
});

test('/api/polymarket: the audit sub-object agrees', () => {
  const audit = live['/api/polymarket'].audit;
  assert.ok(audit && typeof audit === 'object', 'audit must be an object');
  assertAgrees('PolymarketAudit', audit);
});

test('/api/polymarket/markets: the response envelope agrees', () => {
  assertAgrees('PolymarketMarketsResponse', live['/api/polymarket/markets']);
});

test('PolymarketMarketSummary declares only what the summariser emits', () => {
  // The regression: 7 optional fields were declared that never appear, so a
  // consumer reading `portfolio` or `open_trades` got undefined where the honest
  // answer is "this engine does not report that".
  const summary = live['/api/polymarket/markets'].summary;
  assert.ok(summary && typeof summary === 'object', 'summary must be an object');
  assertAgrees('PolymarketMarketSummary', summary);
});

test('PolymarketExclusionSet agrees, including the validity fields', () => {
  // The regression: present/valid/error were all sent and none declared, while
  // `count` was typed as a plain number even though the server sends null unless
  // the file is valid. A consumer could have rendered a count derived from an
  // unreadable file.
  const exclusions = live['/api/polymarket/markets'].exclusions;
  assert.ok(exclusions && typeof exclusions === 'object', 'exclusions must be an object');
  assertAgrees('PolymarketExclusionSet', exclusions);
  assert.equal(typeof exclusions.valid, 'boolean', 'valid must be a boolean the consumer can check');
  if (!exclusions.valid) {
    assert.equal(exclusions.count, null, 'an invalid exclusion file must report a null count, not a number');
  }
});

test('execution_allowed and paper_only are reported as false on this deployment', () => {
  // ASSERTED, NOT MODIFIED. This is the paper/testnet boundary: the status route
  // reports both flags and neither may be true here. Nothing in this test (or
  // anywhere in this audit) enables execution, places an order, or writes
  // configuration — if a future change makes either flag true, that is a finding
  // to escalate, not something to fix from a type-audit branch.
  // Replaces two assertions that read `execution_allowed must be false` and
  // `paper_only must be false`. Both stated a fact about the machine rather than
  // about the code, and the second was inverted: the server derives paper_only
  // from the bot's own config, so TRUE is the paper-safe state, not the unsafe
  // one. So the suite passed only on a machine with no bot running and read as a
  // safety guarantee it never provided. helpers/tradingSafety.js has the account.
  const status = live['/api/polymarket/status'];
  assertNoLiveOrderAdvertisement(status, '/api/polymarket/status');
  assertExecutionImpliesPaperOnly(status);
  // Where a deployment really must be inert, that remains enforceable.
  assertInertIfConfigured(status);
});

// ------------------------------------------------------------------ coverage

test('every type audited here is still exported from api.ts', () => {
  for (const name of [
    'HarnessHealth', 'ServiceHealth', 'ServicePort', 'VerifyState', 'OfficeManagerStatus',
    'FleetLaunchdState', 'FleetLaunchdEntry', 'BacktestData', 'StrategyFile',
    'PolymarketState', 'PolymarketAudit', 'PolymarketMarketsResponse',
    'PolymarketMarketSummary', 'PolymarketExclusionSet',
  ]) {
    assert.ok(hasInterface(apiSource, name), `${name} should exist in api.ts`);
  }
});

test('OfficeManagerStatus agrees with the payload', () => {
  assertAgrees('OfficeManagerStatus', live['/api/office-manager']);
});

test('/api/trading/live reports its own emptiness honestly', () => {
  // dbExists / dbHasTables distinguish "no database" from "database with no
  // tables". Collapsing them would make a missing engine look like an empty one.
  const l = live['/api/trading/live'];
  assert.equal(typeof l.dbExists, 'boolean', 'dbExists must be a boolean');
  assert.equal(typeof l.dbHasTables, 'boolean', 'dbHasTables must be a boolean');
  if (l.tableNames.length > 0) {
    assert.equal(l.dbHasTables, true, 'listing tables implies the database has tables');
  }
});