import { useLive, type BacktestData, type FleetLaunchdState, type LiveMetrics, type QueueSummary, type Summary } from '../api';

type TradingOps = {
  launchdState?: FleetLaunchdState;
};

type BacktestRow = {
  avg_test_sharpe?: number | null;
  avg_test_return?: number | null;
  avg_win_rate?: number | null;
  avg_profit_factor?: number | null;
  avg_trades?: number | null;
};

function num(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function pct(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

function tone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function Tile({ label, value, sub, toneClass }: { label: string; value: string; sub?: string; toneClass?: string }) {
  return (
    <div className="panel-surface px-3 py-2 min-w-0">
      <div className="text-[10px] font-mono text-hud-dim truncate">{label}</div>
      <div className={`mt-1 font-mono text-sm ${toneClass || 'text-hud-text'}`}>{value}</div>
      {sub && <div className="text-[10px] text-hud-dim mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export default function Overview({ onNavigate }: { onNavigate: (floor: 'f6' | 'f9') => void }) {
  const { data: summary, error: summaryError } = useLive<Summary>('/api/summary');
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  const { data: ops } = useLive<TradingOps>('/api/trading/ops');
  const { data: backtestData } = useLive<BacktestData>('/api/trading/backtests');
  const { data: live } = useLive<LiveMetrics>('/api/trading/live');

  const launchd = ops?.launchdState;
  // `failed` is a KeepAlive job that is down -- always a real problem.
  // `stopped` exited non-zero but is not being restarted; that is usually a
  // job reporting a condition on purpose, so it is shown separately and must
  // not be summed into the failure count.
  const failed = (launchd?.services ?? []).filter(s => s.status === 'failed');
  const stopped = (launchd?.services ?? []).filter(s => s.status === 'stopped');

  const backtests = Object.entries(backtestData?.backtest ?? {})
    .sort(([, a], [, b]) => (b.avg_test_sharpe ?? 0) - (a.avg_test_sharpe ?? 0))
    .slice(0, 5) as [string, BacktestRow][];

  const agents = summary?.agents ?? [];
  const active = agents.filter(a => a.display === 'busy' || a.display === 'idle').length;
  const cost = agents.reduce((sum, a) => sum + (a.usd ?? 0), 0);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F16 · OVERVIEW</h2>
        <span className="badge badge-warning">READ ONLY · PAPER / TESTNET</span>
      </div>

      {/* 24/7 health first: a dead service outranks any metric. */}
      <div className="panel p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-mono text-hud-amber text-sm">FLEET HEALTH · 24/7</h3>
          <button type="button" className="btn btn-ghost text-xs" onClick={() => onNavigate('f9')}>24x7 Ops →</button>
        </div>

        {!launchd && (
          <div className="text-hud-dim text-xs py-2">
            {ops ? 'launchd state unavailable on this host' : 'Loading launchd state…'}
          </div>
        )}

        {launchd && !launchd.available && (
          <div className="text-hud-red text-xs py-2">Could not read launchd: {launchd.error}</div>
        )}

        {launchd?.available && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Tile label="RUNNING" value={String(launchd.counts.running)} toneClass="text-hud-green" />
              <Tile label="IDLE (ON DEMAND)" value={String(launchd.counts.idle)} sub="finished cleanly, awaiting next run" />
              <Tile label="STOPPED (EXITED)" value={String(launchd.counts.stopped)} toneClass={launchd.counts.stopped > 0 ? 'text-hud-amber' : 'text-hud-dim'} sub="reported a condition, not restarting" />
              <Tile label="FAILED" value={String(launchd.counts.failed)} toneClass={launchd.counts.failed > 0 ? 'text-hud-red' : 'text-hud-green'} sub="keepalive job is down" />
            </div>

            {stopped.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] font-mono text-hud-dim mb-1">STOPPED · EXITED NON-ZERO (NOT AUTOMATICALLY BROKEN)</div>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Job</th><th>Intent</th><th>Last exit</th></tr></thead>
                    <tbody>
                      {stopped.map(s => (
                        <tr key={s.label}>
                          <td className="font-mono text-xs">{s.label}</td>
                          <td className="text-hud-dim font-mono">{s.intent}</td>
                          <td className="text-hud-amber font-mono">{s.lastExit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {failed.length > 0 ? (
              <div>
                <div className="text-[10px] font-mono text-hud-red mb-1">FAILED · KEEPALIVE JOB IS DOWN</div>
                <div className="table-container">
                  <table className="table">
                    <thead><tr><th>Job</th><th>Last exit</th><th>Status</th></tr></thead>
                    <tbody>
                      {failed.map(s => (
                        <tr key={s.label}>
                          <td className="font-mono text-xs">{s.label}</td>
                          <td className="text-hud-red font-mono">{s.lastExit}</td>
                          <td className="text-hud-red font-mono">{s.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="text-hud-green text-xs">No keepalive job is down.</div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Tile label="HIVE" value={summaryError ? 'FEED ERROR' : summary?.present ? 'LIVE' : 'OFFLINE'} toneClass={summaryError ? 'text-hud-red' : summary?.present ? 'text-hud-green' : 'text-hud-red'} sub={summary?.hive?.replace(/^\/Users\/[^/]+\//, '~/')} />
        <Tile label="AGENTS" value={`${active} / ${agents.length}`} sub="active / total" />
        <Tile label="QUEUE" value={queue ? `${queue.inProgress} in prog · ${queue.queued} queued` : '--'} />
        <Tile label="SESSION COST" value={summary ? `$${cost.toFixed(2)}` : '--'} />
        <Tile label="TRADING LOG" value={live?.logExists ? `${(live.logSize / 1024 / 1024).toFixed(1)} MB` : live ? 'MISSING' : '--'} toneClass={live?.logExists ? 'text-hud-text' : 'text-hud-red'} />
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-mono text-hud-amber text-sm">TOP STRATEGIES · BACKTEST</h3>
          <button type="button" className="btn btn-ghost text-xs" onClick={() => onNavigate('f6')}>Trading Lab →</button>
        </div>
        <div className="table-container">
          <table className="table">
            <thead><tr><th>Strategy</th><th>Sharpe</th><th>Return</th><th>Win rate</th><th>PF</th><th>Trades</th></tr></thead>
            <tbody>
              {backtests.map(([name, r]) => (
                <tr key={name}>
                  <td className="max-w-[240px] truncate" title={name}>{name}</td>
                  <td className={tone(r.avg_test_sharpe)}>{num(r.avg_test_sharpe)}</td>
                  <td className={tone(r.avg_test_return)}>{pct(r.avg_test_return)}</td>
                  <td>{pct(r.avg_win_rate)}</td>
                  <td className={tone((r.avg_profit_factor ?? 0) - 1)}>{num(r.avg_profit_factor)}</td>
                  <td>{num(r.avg_trades, 0)}</td>
                </tr>
              ))}
              {!backtestData && <tr><td colSpan={6} className="py-6 text-center text-hud-dim">Loading backtests…</td></tr>}
              {backtestData && backtests.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-hud-dim">No backtest data</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
