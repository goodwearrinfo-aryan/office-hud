'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixtureHive, loadServer, startTestServer } = require('./helpers/harness');

/**
 * F14 reads the pre-registered forward evidence and the promotion decision.
 * It is read-only, and the shape it returns is what the floor renders, so the
 * fields the floor depends on are pinned here rather than left to the UI.
 *
 * The harness caches require(index.js), so the paper-benchmark directory is
 * chosen once and the files are rewritten between tests instead.
 */
const PB = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
process.env.PAPER_BENCHMARK_PATH = PB;

const EVIDENCE = {
  generated_at: '2026-09-27T00:00:00+00:00',
  window: { bars: 410, first_forward_bar_utc: '2026-09-09T19:00:00+00:00', last_forward_bar_utc: '2026-09-26T20:00:00+00:00' },
  preregistration: { sha256: 'abc123def456abc123def456abc12345', registered_at: '2026-09-27' },
  gates: { inference_floor_trades: 30, min_trades: 200, min_profit_factor: 1.2 },
  arms: [
    { id: 'A_atr', label: 'validated spec', registration: 'reg-1', timeframe: '1h', trades: 3, return_pct: -0.3, profit_factor: 0.958, max_dd_pct: 4.15, positive_oos_fraction: 0.33, bootstrap: { ci95_low_pct: -0.87, ci95_high_pct: 0.4 }, gates: { inference_floor_reached: false } },
    { id: 'B_live', label: 'deployed', registration: 'reg-1', timeframe: '1h', trades: 40, return_pct: 12, profit_factor: 1.4, max_dd_pct: 9, positive_oos_fraction: 0.7, bootstrap: { ci95_low_pct: 0.2, ci95_high_pct: 3 }, gates: { inference_floor_reached: true } },
    { id: 'C_paper', label: 'paper runner', registration: 'reg-2', timeframe: '5m', trades: 5, return_pct: -10.13, profit_factor: 0, max_dd_pct: 10.13, positive_oos_fraction: 0, bootstrap: { ci95_low_pct: -2, ci95_high_pct: 0 }, gates: { inference_floor_reached: false } },
  ],
  registrations: [
    { registration_id: 'reg-1', interval: '1h', arms: ['A_atr', 'B_live'], registered_at: '2026-09-27', sha256: 'a'.repeat(32) },
    { registration_id: 'reg-2', interval: '5m', arms: ['C_paper'], registered_at: '2026-09-27', sha256: 'b'.repeat(32) },
  ],
  registration_count: 2,
};

const PROMOTION = {
  state: 'hold',
  entry_allowed: false,
  scope: 'paper_only',
  live_orders_allowed: false,
  reasons: ['A_atr: 3 closed trades, below the 30-trade inference floor'],
  evidence: { forward_age_seconds: 210, stale_after_seconds: 7200 },
};

const PREREG = { registered_at: '2026-09-27', arms: [{ id: 'A_atr' }, { id: 'B_live' }] };

function writeFiles({ evidence, promotion, prereg }) {
  if (evidence !== undefined) fs.writeFileSync(path.join(PB, 'forward-validation.json'), JSON.stringify(evidence ?? null));
  if (promotion !== undefined) fs.writeFileSync(path.join(PB, 'promotion.json'), JSON.stringify(promotion ?? null));
  if (prereg !== undefined) fs.writeFileSync(path.join(PB, 'forward-validation-prereg.json'), JSON.stringify(prereg ?? null));
}

function clearFiles() {
  for (const name of ['forward-validation.json', 'promotion.json', 'forward-validation-prereg.json']) {
    fs.rmSync(path.join(PB, name), { force: true });
  }
}

writeFiles({ evidence: EVIDENCE, promotion: PROMOTION, prereg: PREREG });

const fixture = makeFixtureHive();
const server = loadServer(fixture.hive);
let http;

test.before(async () => { http = await startTestServer(server.app); });
test.after(async () => {
  await http?.close();
  fixture.cleanup();
  fs.rmSync(PB, { recursive: true, force: true });
});

test('validation evidence reports the inference floor and per-arm progress', async () => {
  writeFiles({ evidence: EVIDENCE });
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.status, 200);
  assert.equal(res.json.inference_floor, 30);
  assert.equal(res.json.arms.length, 3);

  const below = res.json.arms.find(a => a.id === 'A_atr');
  assert.equal(below.floor_met, false);
  assert.equal(below.trades_to_floor, 27);
  assert.equal(below.progress_pct, 10);

  const met = res.json.arms.find(a => a.id === 'B_live');
  assert.equal(met.floor_met, true);
  assert.equal(met.trades_to_floor, 0);
  assert.equal(res.json.arms_below_floor, 2);
  assert.equal(res.json.window.bars, 410);
  assert.equal(res.json.preregistration.registered_at, '2026-09-27');
});

test('validation evidence never reports live orders as allowed', async () => {
  writeFiles({ evidence: EVIDENCE, promotion: { ...PROMOTION, state: 'promote', entry_allowed: true } });
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.json.promotion.live_orders_allowed, false);
  assert.equal(res.json.promotion.scope, 'paper_only');
});

test('an arm above the floor does not by itself open paper entries', async () => {
  writeFiles({ evidence: EVIDENCE, promotion: PROMOTION });
  const res = await http.get('/api/validationEvidence');
  // B_live is above the floor here, but entry_allowed belongs to the promotion
  // controller. The floor displays it and must not derive it.
  assert.equal(res.json.arms.find(a => a.id === 'B_live').floor_met, true);
  assert.equal(res.json.promotion.entry_allowed, false);
});

test('a lying floor flag in the artifact cannot mark an arm as met', async () => {
  const evidence = JSON.parse(JSON.stringify(EVIDENCE));
  evidence.arms[0].trades = 2;
  evidence.arms[0].gates.inference_floor_reached = true;
  writeFiles({ evidence });
  const res = await http.get('/api/validationEvidence');
  const arm = res.json.arms.find(a => a.id === 'A_atr');
  assert.equal(arm.floor_met, false, 'floor must be recomputed from the trade count');
});

test('a forged promote flag cannot mark an arm as met', async () => {
  const evidence = JSON.parse(JSON.stringify(EVIDENCE));
  evidence.arms[1].trades = 2;
  evidence.arms[1].gates.inference_floor_reached = true;
  evidence.arms[1].gates.promote = true;
  writeFiles({ evidence });
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.json.arms.find(a => a.id === 'B_live').floor_met, false);
});

test('missing artifacts degrade to a renderable payload, not a 500', async () => {
  clearFiles();
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.status, 200);
  assert.equal(res.json.inference_floor, 30);
  assert.deepEqual(res.json.arms, []);
  assert.equal(res.json.promotion.state, 'unknown');
  assert.equal(res.json.promotion.entry_allowed, false);
});

test('a corrupt artifact degrades instead of throwing', async () => {
  fs.writeFileSync(path.join(PB, 'forward-validation.json'), '{not json');
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.arms, []);
});

test('stale evidence age is surfaced for the floor to flag', async () => {
  writeFiles({
    evidence: EVIDENCE,
    promotion: { ...PROMOTION, evidence: { forward_age_seconds: 99999, stale_after_seconds: 7200 } },
  });
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.json.promotion.evidence_age_seconds, 99999);
  assert.equal(res.json.promotion.stale_after_seconds, 7200);
  assert.ok(res.json.promotion.evidence_age_seconds > res.json.promotion.stale_after_seconds);
});

test('the resource is registered for live push', async () => {
  const res = await http.get('/api/live/resources');
  assert.ok(res.json.paths.validationEvidence, 'floor must receive pushes, not only poll');
});

test('floor task counts include the newest floors', async () => {
  const res = await http.get('/api/tasks?counts=1');
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.counts, 'object');
});

test('arms report their registration and timeframe', async () => {
  writeFiles({ evidence: EVIDENCE });
  const res = await http.get('/api/validationEvidence');
  const c = res.json.arms.find(a => a.id === 'C_paper');
  assert.equal(c.timeframe, '5m', 'the paper runner trades 5m, not 1h');
  assert.equal(c.registration, 'reg-2');
  const a = res.json.arms.find(x => x.id === 'A_atr');
  assert.equal(a.timeframe, '1h');
  assert.equal(a.registration, 'reg-1');
});

test('registrations are listed so arm provenance is visible', async () => {
  writeFiles({ evidence: EVIDENCE });
  const res = await http.get('/api/validationEvidence');
  assert.equal(res.json.registration_count, 2);
  assert.equal(res.json.registrations.length, 2);
  assert.deepEqual(res.json.registrations.map(r => r.arms).flat().sort(), ['A_atr', 'B_live', 'C_paper']);
  assert.deepEqual(res.json.registrations.map(r => r.interval).sort(), ['1h', '5m']);
});
