import { useLive } from '../api';

export default function RiskMetrics() {
  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F11 · RISK METRICS</h2>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">PORTFOLIO VAR (95%)</div>
          <div className="text-3xl font-mono font-bold text-hud-red">$0.00</div>
          <div className="text-xs text-hud-dim">1-day horizon</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">EXPECTED SHORTFALL</div>
          <div className="text-3xl font-mono font-bold text-hud-red">$0.00</div>
          <div className="text-xs text-hud-dim">CVaR 95%</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">MAX DRAWDOWN</div>
          <div className="text-3xl font-mono font-bold text-hud-red">0.00%</div>
          <div className="text-xs text-hud-dim">Since inception</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">CORRELATION RISK</div>
          <div className="text-3xl font-mono font-bold text-hud-amber">0.00</div>
          <div className="text-xs text-hud-dim">Max pairwise</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">STRESS TESTS</h3>
          <div className="space-y-2 text-sm">
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">Market Crash (-20%)</span>
              <span className="text-hud-red">-$0.00</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">Flash Crash (-10% in 1hr)</span>
              <span className="text-hud-red">-$0.00</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">Liquidity Crisis</span>
              <span className="text-hud-amber">-$0.00</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">Correlation Breakdown</span>
              <span className="text-hud-amber">-$0.00</span>
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">POSITION CONCENTRATION</h3>
          <div className="text-hud-dim text-xs text-center py-8">No positions to analyze</div>
        </div>
      </div>
    </div>
  );
}