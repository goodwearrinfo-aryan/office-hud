import { useLive } from '../api';
import type { BacktestData } from '../api';
import { SharpeComparison, WinRateProfitFactor, DrawdownChart } from './Charts';

/**
 * Fold the per-window backtest rows into the two record shapes the chart
 * primitives expect. Charts.tsx is written against `{ avg_sharpe, avg_return }`
 * and `{ win_rate, profit_factor }`; api.ts names them `avg_test_*` and
 * `avg_*`. Mapping here rather than loosening the primitives keeps one agreed
 * shape per consumer.
 */
function toStrategyRecords(backtest: BacktestData['backtest']) {
  const sharpe: Record<string, { avg_sharpe: number; avg_return: number }> = {};
  const rates: Record<string, { win_rate: number; profit_factor: number }> = {};
  for (const [name, row] of Object.entries(backtest ?? {})) {
    if (!row) continue;
    sharpe[name] = { avg_sharpe: row.avg_test_sharpe, avg_return: row.avg_test_return };
    rates[name] = { win_rate: row.avg_win_rate, profit_factor: row.avg_profit_factor };
  }
  return { sharpe, rates };
}

export default function StrategyLab() {
  const { data, error } = useLive<BacktestData>('/api/trading/backtests');
  const backtest = data?.backtest ?? {};
  const { sharpe, rates } = toStrategyRecords(backtest);
  const names = Object.keys(sharpe);

  // Drawdown is per test window, so this is a series of window maxima rather than
  // one continuous curve. Labelled as such rather than smoothed into a shape that
  // implies a path the data does not contain.
  const drawdowns = (backtest[names[0]]?.windows ?? []).map((w) => w.test_max_dd);

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F7 · STRATEGY LAB</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RESEARCH NOTEBOOK</h3>
          <textarea className="input w-full h-64 font-mono text-xs resize-none" placeholder="Enter research notes, hypotheses, signal ideas..."></textarea>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">SIGNAL BUILDER</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-hud-dim">Universe</span>
              <select className="input w-48 text-xs"><option>Crypto Top 50</option><option>US Equities</option><option>FX Majors</option></select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-hud-dim">Lookback</span>
              <input type="number" className="input w-24 text-xs" defaultValue="20" />
            </div>
            <button className="btn btn-primary w-full mt-2">Build Signal</button>
          </div>
        </div>
      </div>
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">WALK-FORWARD ANALYSIS</h3>
        {error && <p className="text-hud-red text-xs mb-3">Backtests unavailable: {error}</p>}
        {names.length === 0 ? (
          <div className="text-hud-dim text-xs text-center py-8">Walk-forward results will appear here</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <h4 className="font-mono text-hud-dim text-xs mb-2">SHARPE vs RETURN</h4>
              <SharpeComparison strategies={sharpe} />
            </div>
            <div>
              <h4 className="font-mono text-hud-dim text-xs mb-2">WIN RATE vs PROFIT FACTOR</h4>
              <WinRateProfitFactor strategies={rates} />
            </div>
            {drawdowns.length > 0 && (
              <div className="xl:col-span-2">
                <h4 className="font-mono text-hud-dim text-xs mb-2">
                  MAX DRAWDOWN PER TEST WINDOW · {names[0]}
                </h4>
                <DrawdownChart drawdowns={drawdowns} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}