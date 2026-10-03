import { useLive } from '../api';
import type { BacktestData, StrategyBacktest } from '../api';

/**
 * Fold a strategy's backtest windows into the one number each column promises.
 *
 * Max DD is the worst single window, not a mean of drawdowns: averaging
 * drawdowns understates the worst one, which is the only figure an operator
 * sizing risk cares about. Trades fall back to summing the windows when the
 * aggregate is absent, since a strategy can be backtested per window without
 * ever being given an `avg_trades`.
 */
function rowFor(name: string, row: StrategyBacktest) {
  const windows = row?.windows ?? [];
  const maxDd = windows.length
    ? Math.max(...windows.map((w) => Math.abs(w.test_max_dd ?? 0)))
    : null;
  const trades = row?.avg_trades ?? (windows.length
    ? windows.reduce((n, w) => n + (w.test_trades ?? 0), 0)
    : null);
  const params = windows[0]?.best_params ?? {};
  const model = typeof params.model === 'string' ? params.model : '—';
  return {
    name,
    model,
    sharpe: row?.avg_test_sharpe ?? null,
    ret: row?.avg_test_return ?? null,
    maxDd,
    trades,
    windows: windows.length,
  };
}

function pct(value: number | null, digits = 1): string {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function num(value: number | null, digits = 2): string {
  return value == null ? '—' : value.toFixed(digits);
}

export default function TradingLab() {
  const { data, error } = useLive<BacktestData>('/api/trading/backtests');
  const backtest = data?.backtest ?? {};
  const rows = Object.entries(backtest)
    .filter(([, row]) => Boolean(row))
    .map(([name, row]) => rowFor(name, row as StrategyBacktest));
  const loading = !data && !error;

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F6 · TRADING LAB</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESULTS</h3>
          {loading && <div className="text-hud-dim text-xs text-center py-8">Loading backtest data...</div>}
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">STRATEGY PARAMETERS</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-hud-dim">Model</span>
              <select className="input w-48 text-xs">
                <option>nemotron-3-ultra</option>
                <option>qwen2.5-32b</option>
                <option>llama-3.1-70b</option>
              </select>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-hud-dim">Lookback Window</span>
              <input type="number" className="input w-24 text-xs" defaultValue="252" />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-hud-dim">Risk Budget</span>
              <input type="number" step="0.01" className="input w-24 text-xs" defaultValue="0.02" />
            </div>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">STRATEGY LIST</h3>
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Model</th>
                <th>Sharpe</th>
                <th>Return</th>
                <th>Max DD</th>
                <th>Trades</th>
                <th>Actions</th>
              </tr>
            </thead>
<tbody>
                {rows.length === 0 ? (
                  <tr className="text-hud-dim text-center">
                    <td colSpan={7} className="py-8">
                      {error ? `Backtests unavailable: ${error}` : 'No strategies loaded'}
                    </td>
                  </tr>
                ) : rows.map((row) => (
                  <tr key={row.name}>
                    <td className="font-mono text-xs">{row.name}</td>
                    <td className="font-mono text-xs text-hud-dim">{row.model}</td>
                    <td className="font-mono text-xs tabular-nums">{num(row.sharpe)}</td>
                    <td className={`font-mono text-xs tabular-nums ${(row.ret ?? 0) >= 0 ? 'text-hud-green' : 'text-hud-red'}`}>
                      {pct(row.ret)}
                    </td>
                    <td className="font-mono text-xs tabular-nums text-hud-red">{pct(row.maxDd)}</td>
                    <td className="font-mono text-xs tabular-nums">{row.trades ?? '—'}</td>
                    <td className="font-mono text-[10px] text-hud-dim">{row.windows} window{row.windows === 1 ? '' : 's'}</td>
                  </tr>
                ))}
              </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}