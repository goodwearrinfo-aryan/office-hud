import { useLive } from '../api';

export default function StrategyLab() {
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
        <div className="text-hud-dim text-xs text-center py-8">Walk-forward results will appear here</div>
      </div>
    </div>
  );
}