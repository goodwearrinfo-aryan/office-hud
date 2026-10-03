// /api/trading/evidence -- forward evidence + cost break-even for the 1h
// regime candidate.
//
// This lives in its own file rather than inline in server/index.js on purpose.
// index.js is being actively edited by another agent, and a concurrent write
// there silently removed the inline version of this route once already. Keeping
// the handler here means a clobber costs one require() line instead of the whole
// block, and the logic is reviewable on its own.
//
// Read-only, and deliberately narrow: it serves only evidence fields, not the
// whole outcomes report, so the HUD cannot become a way to read raw research
// state. `cost_sensitivity` and `verdict_stability` are the two things that stop
// a gross return being read as profit, or a verdict one bucket from flipping
// being read as a result.
const os = require('os');
const path = require('path');
const fs = require('fs');

const PAPER_BENCHMARK =
  process.env.PAPER_BENCHMARK_PATH || path.join(os.homedir(), 'trading', 'paper-benchmark');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function buildEvidencePayload() {
  const outcomes = readJson(path.join(PAPER_BENCHMARK, 'regime-trend-outcomes.json'), {});
  const readiness = readJson(path.join(PAPER_BENCHMARK, 'evidence-readiness.json'), {});
  return {
    generated_at: outcomes.generated_at || null,
    // Re-asserted here rather than trusted from the file: this endpoint must
    // never be able to imply an order path exists.
    paper_only: true,
    orders_submitted: false,
    live_orders_allowed: false,
    horizons: outcomes.by_horizon || {},
    cost_sensitivity: outcomes.cost_sensitivity || {},
    verdict_stability: outcomes.verdict_stability || {},
    strategy_outcome: outcomes.strategy_outcome || {},
    evidence_ready: outcomes.evidence_ready === true,
    // A verdict computed from a frozen shadow feed is not a verdict. Passed
    // through rather than recomputed so the HUD shows the same staleness the gate
    // concluded, not a second opinion that could disagree with it.
    shadow_feed: readiness.shadow_feed || null,
    // Both inputs the readiness gate classifies from. A frozen outcomes report
    // leaves the verdict confidently recomputed from stale data, so it is passed
    // through rather than left for a consumer to infer from a timestamp.
    upstream_freshness: readiness.upstream_freshness || null,
    candidate_verdict: readiness.candidate_verdict || null,
    demotion_active: readiness.demotion_active === true,
    abandoned: readiness.abandoned === true,
    retire_entries: readiness.retire_entries === true,
    primary_horizon: readiness.primary_horizon || null,
    full_horizon: readiness.full_horizon || null,
    inference_floor: outcomes.inference_floor || null,
    signals_tracked: outcomes.signals_tracked || 0,
    signals_complete: outcomes.signals_complete || 0,
  };
}

function registerEvidenceRoutes(app, { readJson: injectedReadJson } = {}) {
  app.get('/api/trading/evidence', (_req, res) => {
    res.json(injectedReadJson ? injectedReadJson(buildEvidencePayload) : buildEvidencePayload());
  });
}

module.exports = { registerEvidenceRoutes, buildEvidencePayload };
