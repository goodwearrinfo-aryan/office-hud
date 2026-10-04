// Tests for the /api/trading/evidence payload.
//
// The properties that matter are safety ones: the payload must never imply an
// order path exists, and it must not serve a stale verdict when the underlying
// report is missing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEvidencePayload } = require('./evidenceRoutes');

function withPaperBenchmarkDir(setup, run) {
  const original = process.env.PAPER_BENCHMARK_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  try {
    if (setup) setup(dir);
    process.env.PAPER_BENCHMARK_PATH = dir;
    // evidenceRoutes resolves PAPER_BENCHMARK at require time, so re-require a
    // fresh copy to pick up the override.
    delete require.cache[require.resolve('./evidenceRoutes')];
    run(require('./evidenceRoutes'));
  } finally {
    if (original === undefined) delete process.env.PAPER_BENCHMARK_PATH;
    else process.env.PAPER_BENCHMARK_PATH = original;
    delete require.cache[require.resolve('./evidenceRoutes')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('missing report yields an empty payload rather than a crash', () => {
  withPaperBenchmarkDir(null, (mod) => {
    const p = mod.buildEvidencePayload();
    assert.deepStrictEqual(p.cost_sensitivity, {});
    assert.strictEqual(p.candidate_verdict, null);
    assert.strictEqual(p.generated_at, null);
  });
});

test('payload never claims an order path exists', () => {
  withPaperBenchmarkDir(null, (mod) => {
    const p = mod.buildEvidencePayload();
    // Hardcoded rather than read from the report: a tampered or stale report
    // must not be able to flip these.
    assert.strictEqual(p.paper_only, true);
    assert.strictEqual(p.orders_submitted, false);
    assert.strictEqual(p.live_orders_allowed, false);
  });
});

test('a report claiming live orders is still served as paper-only', () => {
  withPaperBenchmarkDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'regime-trend-outcomes.json'),
      JSON.stringify({ live_orders_allowed: true, orders_submitted: true, by_horizon: { '1h': {} } }),
    );
  }, (mod) => {
    const p = mod.buildEvidencePayload();
    assert.strictEqual(p.live_orders_allowed, false, 'endpoint must not relay a live claim');
    assert.strictEqual(p.orders_submitted, false);
  });
});

test('cost and stability fields are surfaced when present', () => {
  withPaperBenchmarkDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'regime-trend-outcomes.json'),
      JSON.stringify({
        generated_at: '2026-01-01T00:00:00+00:00',
        by_horizon: { '6h': { samples: 35, verdict: 'ci_includes_zero' } },
        cost_sensitivity: { '6h': { readable: true, gross_bps: 15.2, edge_established: false } },
        verdict_stability: { settled: false, fragile_horizons: ['6h'] },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'evidence-readiness.json'),
      JSON.stringify({ candidate_verdict: 'collecting', primary_horizon: '24h' }),
    );
  }, (mod) => {
    const p = mod.buildEvidencePayload();
    assert.strictEqual(p.cost_sensitivity['6h'].edge_established, false);
    assert.deepStrictEqual(p.verdict_stability.fragile_horizons, ['6h']);
    assert.strictEqual(p.candidate_verdict, 'collecting');
  });
});

test('endpoint does not expose the raw outcomes record list', () => {
  withPaperBenchmarkDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'regime-trend-outcomes.json'),
      JSON.stringify({ records: [{ secret: 'x' }], by_horizon: {} }),
    );
  }, (mod) => {
    const p = mod.buildEvidencePayload();
    assert.strictEqual(p.records, undefined, 'raw per-signal records must not be served');
  });
});
