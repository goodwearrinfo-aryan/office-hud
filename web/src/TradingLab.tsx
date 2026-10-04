import { useLive, type BacktestData, type LiveMetrics, type StrategyFile } from './api';

type StrategiesResponse = {
  strategies: StrategyFile[];
};

function formatNumber(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatPercent(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function valueTone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone || 'text-hud-text'}`}>{value}</div>
    </div>
  );
}

export default function TradingLab() {
  const { data: backtestData, error: backtestError } = useLive<BacktestData>('/api/trading/backtests');
  const { data: strategyData } = useLive<StrategiesResponse>('/api/trading/strategies');
  const { data: live } = useLive<LiveMetrics>('/api/trading/live');

  const backtests = Object.entries(backtestData?.backtest ?? {})
    .sort(([, a], [, b]) => (b.avg_test_sharpe ?? 0) - (a.avg_test_sharpe ?? 0));
  const walkforwards = Object.entries(backtestData?.walkforward ?? {})
    .sort(([, a], [, b]) => (b.avg_oos_return ?? 0) - (a.avg_oos_return ?? 0));

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F6 · TRADING LAB</h2>
        <span className="badge badge-warning">READ ONLY · PAPER / TESTNET</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Metric label="DATABASE" value={live?.dbExists ? 'PRESENT' : live ? 'MISSING' : 'CHECKING'} tone={live?.dbExists ? 'text-hud-green' : 'text-hud-dim'} />
        <Metric label="TRADING LOG" value={live?.logExists ? `${(live.logSize / 1024 / 1024).toFixed(1)} MB` : live ? 'MISSING' : 'CHECKING'} tone={live?.logExists ? 'text-hud-green' : 'text-hud-dim'} />
        <Metric label="STRATEGY FILES" value={strategyData ? String(strategyData.strategies.length) : 'CHECKING'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESULTS</h3>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Strategy</th><th>Sharpe</th><th>Return</th><th>Consistency</th><th>Win rate</th><th>PF</th><th>Trades</th></tr>
              </thead>
              <tbody>
                {backtests.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[190px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_test_sharpe)}>{formatNumber(result.avg_test_sharpe)}</td>
                    <td className={valueTone(result.avg_test_return)}>{formatPercent(result.avg_test_return)}</td>
                    <td>{formatPercent(result.consistency)}</td>
                    <td>{formatPercent(result.avg_win_rate)}</td>
                    <td className={valueTone(result.avg_profit_factor - 1)}>{formatNumber(result.avg_profit_factor)}</td>
                    <td>{formatNumber(result.avg_trades, 0)}</td>
                  </tr>
                ))}
                {backtestError && <tr><td colSpan={7} className="py-8 text-center text-hud-red">Backtest data unavailable: {backtestError}</td></tr>}
                {!backtestError && !backtestData && <tr><td colSpan={7} className="py-8 text-center text-hud-dim">Loading backtest data…</td></tr>}
                {backtestData && backtests.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-hud-dim">No backtest data</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">WALK-FORWARD RESULTS</h3>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Strategy</th><th>IS return</th><th>OOS return</th><th>Consistency</th><th>Positive</th><th>Trades</th></tr>
              </thead>
              <tbody>
                {walkforwards.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[190px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_is_return)}>{formatPercent(result.avg_is_return)}</td>
                    <td className={valueTone(result.avg_oos_return)}>{formatPercent(result.avg_oos_return)}</td>
                    <td>{formatPercent(result.consistency)}</td>
                    <td>{result.positive_oos_periods}/{result.total_periods}</td>
                    <td>{formatNumber(result.avg_oos_trades, 0)}</td>
                  </tr>
                ))}
                {!backtestData && <tr><td colSpan={6} className="py-8 text-center text-hud-dim">Loading walk-forward data…</td></tr>}
                {backtestData && walkforwards.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-hud-dim">No walk-forward data</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">STRATEGY FILES</h3>
        <div className="table-container">
          <table className="table">
            <thead><tr><th>File</th><th>Path</th></tr></thead>
            <tbody>
              {(strategyData?.strategies ?? []).map(strategy => (
                <tr key={strategy.path}>
                  <td className="font-mono text-xs">{strategy.file}</td>
                  <td className="max-w-[600px] truncate text-hud-dim text-xs" title={strategy.path}>{strategy.path}</td>
                </tr>
              ))}
              {!strategyData && <tr><td colSpan={2} className="py-8 text-center text-hud-dim">Loading strategy files…</td></tr>}
              {strategyData?.strategies.length === 0 && <tr><td colSpan={2} className="py-8 text-center text-hud-dim">No strategy files found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
