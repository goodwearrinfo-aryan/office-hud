import { useLive } from '../api';

export default function TradingLab() {
  const { data: tradingData } = useLive<any>('/api/trading/backtests');

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F6 · TRADING LAB</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">BACKTEST RESULTS</h3>
          <div className="text-hud-dim text-xs text-center py-8">Loading backtest data...</div>
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
              <tr className="text-hud-dim text-center">
                <td colSpan={7} className="py-8">No strategies loaded</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}