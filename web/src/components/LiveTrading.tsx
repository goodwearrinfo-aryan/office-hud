import { useLive } from '../api';

export default function LiveTrading() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F8 · LIVE TRADING</h2>
        <div className="flex gap-2">
          <span className="badge badge-danger">PAPER ONLY</span>
          <button className="btn btn-danger btn-sm">KILL SWITCH</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">POSITIONS</h3>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                <tr className="text-hud-dim text-center"><td colSpan={6} className="py-8">No open positions</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">ORDERS</h3>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="text-hud-dim text-center"><td colSpan={6} className="py-8">No open orders</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RISK METRICS</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-hud-dim">Portfolio Value</span><span className="font-mono">$0.00</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Daily PnL</span><span className="font-mono text-hud-green">$0.00</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Max DD</span><span className="font-mono text-hud-red">0.00%</span></div>
            <div className="flex justify-between"><span className="text-hud-dim">Leverage</span><span className="font-mono">1.0x</span></div>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">POLYMARKET PAPER TRADING</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div className="panel p-3"><div className="text-xs text-hud-dim">Paper Engine</div><div className="font-mono text-hud-red">STOPPED</div></div>
          <div className="panel p-3"><div className="text-xs text-hud-dim">Positions</div><div className="font-mono">0</div></div>
          <div className="panel p-3"><div className="text-xs text-hud-dim">PnL</div><div className="font-mono">$0.00</div></div>
          <div className="panel p-3"><div className="text-xs text-hud-dim">Model</div><div className="font-mono text-xs">nemotron-3-ultra</div></div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled>Start Paper Engine</button>
          <button className="btn btn-danger">Kill Switch</button>
          <button className="btn btn-ghost">View Logs</button>
        </div>
      </div>
    </div>
  );
}