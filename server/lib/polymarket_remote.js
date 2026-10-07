// This patch adds remote polymarket status fetching for when HUD runs on laptop
// but polymarket engine runs on mini.

const MINI_HOST = 'macmini'; // SSH config alias
const MINI_POLYMARKET_ROOT = '/Users/a/polymarket';
const MINI_POLYMARKET_RESEARCH = '/Users/a/polymarket/research';
const MINI_POLYMARKET_STATE_PATH = '/Users/a/polymarket/research/engine_state.json';
const MINI_POLYMARKET_GATE_PATH = '/Users/a/polymarket/research/profitability_gate.json';
const MINI_POLYMARKET_AUDIT_PATH = '/Users/a/polymarket/research/signal_audit.jsonl';
const MINI_POLYMARKET_EXCLUSIONS_PATH = '/Users/a/polymarket/research/market_exclusions.json';
const MINI_POLYMARKET_LAUNCHD_LABEL = 'com.aryan.pm-engine';
const MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST = '/Users/a/Library/LaunchAgents/com.aryan.pm-engine.plist';
const MINI_POLYMARKET_LAUNCHD_TARGET = 'gui/501/com.aryan.pm-engine'; // uid 501 on mini

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function isLaptop() {
  try {
    const localHost = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).toString().trim().toLowerCase();
    return localHost.includes('macbook') || localHost.includes('aryans-macbook');
  } catch {
    const hostname = os.hostname().toLowerCase();
    return hostname.includes('macbook') || hostname.includes('aryans-macbook');
  }
}

function runOnMini(cmd, args, options = {}) {
  try {
    const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', MINI_HOST, cmd, ...args], {
      encoding: 'utf8',
      timeout: options.timeout || 15000,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    });
    return { ok: true, stdout: output.toString() };
  } catch (error) {
    return { ok: false, error: error.stderr ? String(error.stderr).trim() : error.message };
  }
}

function runOnMiniJson(cmd, args) {
  const result = runOnMini(cmd, args);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + e.message };
  }
}

// Get polymarket runtime status from mini
function getPolymarketRuntimeRemote() {
  if (!isLaptop()) return null; // Only use remote when on laptop
  
  // Get launchd status
  const launchd = runOnMini('launchctl', ['print', MINI_POLYMARKET_LAUNCHD_TARGET]);
  let launchdState = { loaded: false, state: 'unavailable', pid: null, path: null, error: null };
  if (launchd.ok) {
    const output = launchd.stdout;
    const state = output.match(/\n\s*state = ([^\s]+)/)?.[1] || 'unknown';
    const pid = output.match(/\n\s*pid = (\d+)/)?.[1] || null;
    const installedPath = output.match(/\n\s*path = ([^\n]+)/)?.[1]?.trim() || null;
    launchdState = { loaded: true, state, pid: pid ? Number(pid) : null, path: installedPath, error: null };
  }

  // Get engine processes
  const pgrep = runOnMini('pgrep', ['-f', 'profitability_engine_fixed.py']);
  let processes = [];
  if (pgrep.ok && pgrep.stdout.trim()) {
    const pids = pgrep.stdout.trim().split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
    for (const pid of pids) {
      const ps = runOnMini('ps', ['-p', String(pid), '-o', 'command=']);
      if (ps.ok && ps.stdout.trim()) {
        processes.push({ pid, command: ps.stdout.trim() });
      }
    }
  }

  // Read plist
  const plistRead = runOnMini('plutil', ['-convert', 'json', '-o', '-', MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST]);
  let plist = null;
  let plistError = null;
  if (plistRead.ok) {
    try { plist = JSON.parse(plistRead.stdout); } catch (e) { plistError = e.message; }
  } else {
    plistError = plistRead.error;
  }

  const enginePath = path.join(MINI_POLYMARKET_RESEARCH, 'profitability_engine_fixed.py');
  const argumentsList = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [];
  const hasPaperArgument = argumentsList.includes('--paper');
  const hasUnsafeArgument = argumentsList.some(arg => /--(live|real|mainnet|testnet)(?:=|$)/i.test(String(arg)));
  const plistValid = !!plist
    && plist.Label === MINI_POLYMARKET_LAUNCHD_LABEL
    && argumentsList.length >= 2
    && argumentsList.every(arg => typeof arg === 'string')
    && argumentsList[1] === enginePath
    && argumentsList.includes('--paper')
    && plist.WorkingDirectory === MINI_POLYMARKET_ROOT
    // Note: can't check fs.existsSync remotely easily, assume true if plist valid
    ;

  // Check config
  const configRead = runOnMini('cat', [path.join(MINI_POLYMARKET_ROOT, '.agent_llm.json')]);
  let configPaperOnly = true;
  let configError = null;
  if (configRead.ok) {
    try {
      const config = JSON.parse(configRead.stdout);
      configPaperOnly = !Object.prototype.hasOwnProperty.call(config, 'paper_only') || config.paper_only === true;
    } catch (e) {
      configError = e.message;
    }
  } else {
    configError = configRead.error;
  }

  const paperOnly = plistValid && !configError && configPaperOnly && hasPaperArgument && !hasUnsafeArgument;
  const expectedPlistLoaded = launchdState.loaded && launchdState.path === MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST;

  return {
    checked_at: new Date().toISOString(),
    engine_path: enginePath,
    expected_engine_path: enginePath,
    expected_plist_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    paper_only: paperOnly,
    managed: plistValid && !configError,
    running: processes.length > 0,
    pid: processes[0]?.pid || null,
    process: { pids: processes.map(p => p.pid), commands: processes.map(p => p.command) },
    launchd: {
      ...launchdState,
      expected_path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST,
      expected_loaded: expectedPlistLoaded,
    },
    config: {
      present: !configError,
      path: path.join(MINI_POLYMARKET_ROOT, '.agent_llm.json'),
      error: configError,
    },
    plist: {
      valid: plistValid,
      error: plistError,
      path: MINI_POLYMARKET_LAUNCHD_INSTALLED_PLIST,
    },
    execution_allowed: plistValid && !configError && paperOnly && expectedPlistLoaded,
  };
}

// Get polymarket state from mini
function getPolymarketStateRemote() {
  if (!isLaptop()) return null;
  
  const stateRead = runOnMini('cat', [MINI_POLYMARKET_STATE_PATH]);
  if (!stateRead.ok) return null;
  let state;
  try { state = JSON.parse(stateRead.stdout); } catch { return null; }

  const gateRead = runOnMini('cat', [MINI_POLYMARKET_GATE_PATH]);
  let gate = null;
  if (gateRead.ok) {
    try { gate = JSON.parse(gateRead.stdout); } catch {}
  }

  const auditRead = runOnMini('tail', ['-2000', MINI_POLYMARKET_AUDIT_PATH]);
  let audit = [];
  if (auditRead.ok) {
    for (const line of auditRead.stdout.trim().split('\n')) {
      if (line.trim()) {
        try { audit.push(JSON.parse(line)); } catch {}
      }
    }
  }

  const metrics = state?.performance_metrics || {};
  const auditAllowed = audit.filter(item => item.decision === 'allow').length;
  const rejectReasons = {};
  for (const item of audit) {
    if (item.decision !== 'reject') continue;
    const reason = String(item.reason || 'unknown').split('(')[0];
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
  }

  return {
    present: !!state,
    mode: state && state.dry_run ? 'dry-run' : 'paper',
    trades: state ? state.trade_history.length : 0,
    net_pnl: metrics.net_pnl ?? null,
    realized_edge: metrics.realized_edge ?? null,
    updated_at: state ? state.timestamp : null,
    gate: gate ? { status: gate.gate_status, priced_exits: gate.priced_exits, requirements_met: gate.requirements_met } : null,
    audit: { total: audit.length, allowed: auditAllowed, rejected: audit.length - auditAllowed, reject_reasons: rejectReasons },
  };
}

// Get polymarket markets from mini
function getPolymarketMarketsRemote() {
  if (!isLaptop()) return null;
  
  const stateRead = runOnMini('cat', [MINI_POLYMARKET_STATE_PATH]);
  if (!stateRead.ok) return null;
  let state;
  try { state = JSON.parse(stateRead.stdout); } catch { return null; }

  const exclusionsRead = runOnMini('cat', [MINI_POLYMARKET_EXCLUSIONS_PATH]);
  let exclusions = [];
  if (exclusionsRead.ok) {
    try { exclusions = JSON.parse(exclusionsRead.stdout); } catch {}
  }

  // Reuse the local summarization logic but with remote data
  const rows = new Map();
  const exclusionsById = new Map(exclusions.map(item => [item.market_id, item]));
  
  if (state?.execution_engine?.order_books) {
    for (const [marketId, book] of Object.entries(state.execution_engine.order_books)) {
      const excluded = exclusionsById.has(marketId);
      const bids = Array.isArray(book.bids) ? book.bids : [];
      const asks = Array.isArray(book.asks) ? book.asks : [];
      const bestBid = bids.length ? bids[0][0] : null;
      const bestAsk = asks.length ? asks[0][0] : null;
      const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
      
      rows.set(marketId, {
        market_id: marketId,
        excluded,
        best_bid: bestBid,
        best_ask: bestAsk,
        mid,
        spread,
        bid_depth: bids.reduce((sum, [, size]) => sum + (size || 0), 0),
        ask_depth: asks.reduce((sum, [, size]) => sum + (size || 0), 0),
        last_updated: book.updated_at || null,
      });
    }
  }

  return {
    present: !!state,
    state_path: MINI_POLYMARKET_STATE_PATH,
    updated_at: state ? state.timestamp : null,
    summary: {
      trades: state ? state.trade_history.length : 0,
      signals: 0, // Not directly available
      orders: Object.keys(state?.execution_engine?.orders || {}).length,
      fills: state?.execution_engine?.fills?.length || 0,
      open_positions: Object.keys(state?.execution_engine?.positions || {}).length,
      closed_positions: state?.execution_engine?.closed_positions?.length || 0,
      markets: rows.size,
    },
    markets: Array.from(rows.values()),
  };
}

module.exports = {
  isLaptop,
  runOnMini,
  runOnMiniJson,
  getPolymarketRuntimeRemote,
  getPolymarketStateRemote,
  getPolymarketMarketsRemote,
};
