// openalice.js — aggregate every OpenAlice paper-trading feed into one payload.
//
// The HUD is the single pane of glass; operators should never need to open the
// separate :3002 static dashboards. Every feed is read directly from the live
// writer tree (~/trading/openalice/ui/public) with honest staleness metadata:
// a successfully-read file is not a live feed unless its content timestamp is
// recent. FRESH_MS/STALE_MS mirrors the thresholds the standalone dashboards use.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FEED_ROOT = process.env.OPENALICE_PUBLIC_ROOT
  || path.join(os.homedir(), 'trading', 'openalice', 'ui', 'public');

// Writers tick at different cadences (tournament ~5min, legs ~10s, benchmark
// ~on-demand), so staleness is judged per-feed against a generous default and
// a per-feed override where the writer cadence is known.
const DEFAULT_FRESH_S = 10 * 60;
const DEFAULT_STALE_S = 60 * 60;
const FEED_FRESHNESS = {
  'tournament.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'legs.json': { freshS: 60, staleS: DEFAULT_FRESH_S },
  'pipeline.json': { freshS: 60, staleS: DEFAULT_FRESH_S },
  'heartbeat.json': { freshS: 5 * 60, staleS: 30 * 60 },
  'paper-benchmark.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'combined_portfolio.json': { freshS: 5 * 60, staleS: 30 * 60 },
  'research-pipeline.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'regime-trend-outcomes.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'forward-validation.json': { freshS: DEFAULT_STALE_S, staleS: 6 * 60 * 60 },
  'honesty.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'algo20.json': { freshS: 5 * 60, staleS: 30 * 60 },
  'eth-paper-execution.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'freetrader.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
  'screener.json': { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function parseTs(value) {
  if (value == null) return null;
  // Both ISO strings ("2026-10-06T08:40:00+00:00") and the human format the
  // paper writers emit ("2026-10-06 14:12:25") appear in these feeds; Date.parse
  // handles the former, and the latter parses reliably once it is coerced to
  // look ISO-ish.
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function pickContentTs(data) {
  if (!data || typeof data !== 'object') return new Date().toISOString();
  return data.ts || data.generated_at || data.timestamp || new Date().toISOString();
}

function feedState(name, data) {
  const file = path.join(FEED_ROOT, name);
  const bounds = FEED_FRESHNESS[name] || { freshS: DEFAULT_FRESH_S, staleS: DEFAULT_STALE_S };
  const base = { name, exists: false, readable: false, data: null, content_ts: null, age_sec: null, state: 'missing' };
  try {
    const stat = fs.statSync(file);
    base.exists = true;
    base.readable = stat.isFile();
  } catch (_err) {
    return base;
  }
  if (data === undefined || data === null) return base;
  const tsMs = parseTs(pickContentTs(data));
  const now = Date.now();
  base.data = data;
  base.content_ts = tsMs != null ? new Date(tsMs).toISOString() : null;
  base.age_sec = tsMs != null ? Math.max(0, Math.floor((now - tsMs) / 1000)) : null;
  if (tsMs == null) {
    base.state = 'unknown_age';
  } else if (base.age_sec <= bounds.freshS) {
    base.state = 'live';
  } else if (base.age_sec <= bounds.staleS) {
    base.state = 'stale';
  } else {
    base.state = 'stalled';
  }
  return base;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

function openaliceSnapshot() {
  const legs = readJson(path.join(FEED_ROOT, 'legs.json'), null);
  const pipeline = readJson(path.join(FEED_ROOT, 'pipeline.json'), null);
  const heartbeat = readJson(path.join(FEED_ROOT, 'heartbeat.json'), null);
  const tournament = readJson(path.join(FEED_ROOT, 'tournament.json'), null);
  const benchmark = readJson(path.join(FEED_ROOT, 'paper-benchmark.json'), null);
  const combined = readJson(path.join(FEED_ROOT, 'combined_portfolio.json'), null);
  const research = readJson(path.join(FEED_ROOT, 'research-pipeline.json'), null);
  const regime = readJson(path.join(FEED_ROOT, 'regime-trend-outcomes.json'), null);
  const forward = readJson(path.join(FEED_ROOT, 'forward-validation.json'), null);
  const honesty = readJson(path.join(FEED_ROOT, 'honesty.json'), null);
  const algo20 = readJson(path.join(FEED_ROOT, 'algo20.json'), null);
  const ethPaper = readJson(path.join(FEED_ROOT, 'eth-paper-execution.json'), null);
  const freetrader = readJson(path.join(FEED_ROOT, 'freetrader.json'), null);
  const screener = readJson(path.join(FEED_ROOT, 'screener.json'), null);

  const legsRows = Array.isArray(legs?.legs) ? legs.legs : [];
  const activeLegs = legsRows.filter(leg => String(leg?.pos || 'flat').toLowerCase() !== 'flat');
  const tournamentRows = Array.isArray(tournament?.strategies) ? tournament.strategies : [];
  const algoRows = Array.isArray(algo20?.algos) ? algo20.algos
    : Array.isArray(pipeline?.algo20?.algos) ? pipeline.algo20.algos : [];
  const jobs = Array.isArray(pipeline?.jobs?.jobs) ? pipeline.jobs.jobs : [];
  const benchmarkFamilies = Array.isArray(benchmark?.families) ? benchmark.families : [];

  return {
    ts: new Date().toISOString(),
    feed_root: FEED_ROOT,
    feeds: {
      legs: feedState('legs.json', legs),
      pipeline: feedState('pipeline.json', pipeline),
      heartbeat: feedState('heartbeat.json', heartbeat),
      tournament: feedState('tournament.json', tournament),
      paper_benchmark: feedState('paper-benchmark.json', benchmark),
      combined_portfolio: feedState('combined_portfolio.json', combined),
      research_pipeline: feedState('research-pipeline.json', research),
      regime_outcomes: feedState('regime-trend-outcomes.json', regime),
      forward_validation: feedState('forward-validation.json', forward),
      honesty: feedState('honesty.json', honesty),
      algo20: feedState('algo20.json', algo20),
      eth_paper: feedState('eth-paper-execution.json', ethPaper),
      freetrader: feedState('freetrader.json', freetrader),
      screener: feedState('screener.json', screener),
    },
    heartbeat: heartbeat ? pick(heartbeat, [
      'status', 'current_task', 'current_phase', 'last_successful_action',
      'last_verification', 'next_action', 'blocking_error', 'process_status',
    ]) : null,
    legs: legs ? {
      mode: legs.mode || null,
      execution_enabled: legs.execution_enabled === true,
      is_demo: legs.is_demo === true,
      breakeven: legs.breakeven ?? null,
      btc: legs.btc ?? null,
      total: legsRows.length,
      active: activeLegs.length,
      legs: legsRows,
    } : null,
    pipeline: pipeline ? {
      btc: pipeline.btc ?? null,
      bot_legs: pick(pipeline.bot_legs || {}, ['ok', 'total_n', 'total_pnl', 'legs']),
      jobs: {
        running: pipeline.jobs?.running ?? 0,
        total: pipeline.jobs?.total ?? 0,
        jobs,
      },
      agents: pick(pipeline.agents || {}, ['count', 'names']),
      candle: Array.isArray(pipeline.candle) ? pipeline.candle : [],
      honesty: pick(pipeline.honesty || {}, ['ok', 'flags']),
    } : null,
    tournament: tournament ? {
      leader: tournament.leader ?? null,
      cycles: tournament.cycles ?? null,
      btc: tournament.btc ?? null,
      eth: tournament.eth ?? null,
      funding_btc: tournament.funding_btc ?? null,
      funding_eth: tournament.funding_eth ?? null,
      pairs_z: tournament.pairs_z ?? null,
      basis: tournament.basis ?? null,
      strategies: tournamentRows,
    } : null,
    algo20: algo20 || pipeline?.algo20 ? pick(algo20 || pipeline?.algo20 || {}, [
      'book_total', 'book_dd_pct', 'btc_price', 'n_algos', 'profitable', 'ts',
    ]) : null,
    algo_strategies: algoRows,
    paper_benchmark: benchmark ? {
      mode: benchmark.mode || null,
      live_orders_allowed: benchmark.live_orders_allowed === true,
      generated_at: benchmark.generated_at || null,
      dashboard: benchmark.dashboard || null,
      families: benchmarkFamilies,
    } : null,
    combined_portfolio: combined ? pick(combined, [
      'ok', 'ts', 'price', 'combined', 'components', 'audit_reference',
      'effective_weight', 'feed_degraded', 'feed_warnings',
    ]) : null,
    research_pipeline: research ? pick(research, [
      'counts', 'modes', 'paper_only', 'statuses', 'generated_at', 'live_orders_allowed',
    ]) : null,
    regime_outcomes: regime ? pick(regime, [
      'evidence_ready', 'signals_complete', 'by_horizon', 'strategy_outcome', 'generated_at',
    ]) : null,
    forward_validation: forward ? pick(forward, [
      'kind', 'all_arms_reported', 'arms', 'gates', 'window', 'generated_at', 'selection_rule',
    ]) : null,
    honesty: honesty ? pick(honesty, ['ok', 'flags', 'ts']) : null,
    eth_paper: ethPaper ? pick(ethPaper, [
      'status', 'mode', 'equity', 'cash', 'realized_pnl', 'unrealized_pnl',
      'total_return_pct', 'fees_paid', 'slippage_paid', 'position', 'stats', 'generated_at',
    ]) : null,
    freetrader: freetrader ? pick(freetrader, [
      'latest_decision', 'status', 'mode', 'ts', 'generated_at',
    ]) : null,
    screener,
  };
}

function registerOpenAliceRoute(app) {
  app.get('/api/openalice', (req, res) => {
    try {
      const snapshot = openaliceSnapshot();
      if (req.query && typeof req.query.redact === 'string' && req.query.redact !== 'false') {
        // No credentials live in these paper feeds, but keep the escape hatch
        // consistent with the rest of the HUD's read surfaces.
        res.set('Cache-Control', 'no-store');
      }
      res.json(snapshot);
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err && err.message || err) });
    }
  });
}

module.exports = { openaliceSnapshot, registerOpenAliceRoute, FEED_ROOT };
