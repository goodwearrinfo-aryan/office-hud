import { useLive, type BacktestData, type StrategyFile } from '../api';

type StrategyResponse = {
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

export default function StrategyLab() {
  const { data: backtestData, error: backtestError } = useLive<BacktestData>('/api/trading/backtests');
  const { data: strategyData } = useLive<StrategyResponse>('/api/trading/strategies');

  const backtests = Object.entries(backtestData?.backtest ?? {})
    .sort(([, a], [, b]) => (b.avg_test_sharpe ?? 0) - (a.avg_test_sharpe ?? 0));
  const walkforwards = Object.entries(backtestData?.walkforward ?? {})
    .sort(([, a], [, b]) => (b.avg_oos_return ?? 0) - (a.avg_oos_return ?? 0));
  const bestBacktest = backtests[0]?.[1];
  const bestWalkforward = walkforwards[0]?.[1];

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F7 · STRATEGY LAB</h2>
        <span className="badge badge-info">READ ONLY RESEARCH</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="EVALUATED" value={String(backtests.length)} />
        <Metric label="BEST SHARPE" value={formatNumber(bestBacktest?.avg_test_sharpe)} tone={valueTone(bestBacktest?.avg_test_sharpe)} />
        <Metric label="BEST OOS RETURN" value={formatPercent(bestWalkforward?.avg_oos_return)} tone={valueTone(bestWalkforward?.avg_oos_return)} />
        <Metric label="STRATEGY FILES" value={strategyData ? String(strategyData.strategies.length) : 'CHECKING'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RESEARCH NOTEBOOK</h3>
          <div className="panel-surface p-4 text-xs text-hud-dim leading-5">
            This is a read-only research surface. Note persistence and signal execution are intentionally not wired here; use the measured results and strategy files below as the source of truth.
          </div>
        </div>
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">STRATEGY CATALOG</h3>
          <div className="space-y-2">
            {(strategyData?.strategies ?? []).map(strategy => (
              <div key={strategy.path} className="panel-surface px-3 py-2">
                <div className="font-mono text-xs">{strategy.file}</div>
                <div className="mt-1 text-[10px] text-hud-dim truncate" title={strategy.path}>{strategy.path}</div>
              </div>
            ))}
            {!strategyData && <div className="text-hud-dim text-xs py-4">Loading strategy files…</div>}
            {strategyData?.strategies.length === 0 && <div className="text-hud-dim text-xs py-4">No strategy files found</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESEARCH</h3>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Strategy</th><th>Sharpe</th><th>Return</th><th>Consistency</th></tr></thead>
              <tbody>
                {backtests.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[220px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_test_sharpe)}>{formatNumber(result.avg_test_sharpe)}</td>
                    <td className={valueTone(result.avg_test_return)}>{formatPercent(result.avg_test_return)}</td>
                    <td>{formatPercent(result.consistency)}</td>
                  </tr>
                ))}
                {backtestError && <tr><td colSpan={4} className="py-8 text-center text-hud-red">Backtest data unavailable: {backtestError}</td></tr>}
                {!backtestError && !backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading backtest data…</td></tr>}
                {backtestData && backtests.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No backtest data</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">WALK-FORWARD ANALYSIS</h3>
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Strategy</th><th>OOS return</th><th>Positive</th><th>Windows</th></tr></thead>
              <tbody>
                {walkforwards.map(([name, result]) => (
                  <tr key={name}>
                    <td className="max-w-[220px] truncate" title={name}>{name}</td>
                    <td className={valueTone(result.avg_oos_return)}>{formatPercent(result.avg_oos_return)}</td>
                    <td>{result.positive_oos_periods}/{result.total_periods}</td>
                    <td>{result.num_windows}</td>
                  </tr>
                ))}
                {!backtestData && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">Loading walk-forward data…</td></tr>}
                {backtestData && walkforwards.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">No walk-forward data</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
