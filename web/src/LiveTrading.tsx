import { useLive } from './api';

type LiveMetrics = {
  dbExists?: boolean;
  dbHasTables?: boolean;
  tableNames?: string[];
  logExists?: boolean;
  logSize?: number;
};

type PolymarketStatus = {
  paper_only?: boolean;
  running?: boolean;
  engine_path?: string;
};

const formatBytes = (value?: number) => {
  if (!value || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export default function LiveTrading() {
  const { data: live, error: liveError } = useLive<LiveMetrics>('/api/trading/live');
  const { data: polymarket, error: polymarketError } = useLive<PolymarketStatus>('/api/polymarket/status');
  const liveLabel = liveError ? 'Telemetry error' : live?.dbExists ? 'Database connected' : 'No database configured';
  const polymarketLabel = polymarketError ? 'Status unavailable' : polymarket?.running ? 'Engine running' : 'Engine status not reported';

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-mono text-hud-amber text-lg">F8 · LIVE TRADING</h2>
          <p className="text-xs text-hud-dim mt-1">Read-only telemetry surface. Execution controls remain disabled.</p>
        </div>
        <div className="flex gap-2 items-center">
          <span className={`badge ${liveError ? 'badge-danger' : 'badge-warning'}`}>{liveLabel}</span>
          <span className="badge badge-neutral">PAPER ONLY</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">POSITIONS</h3>
            <span className="badge badge-neutral">NOT EXPOSED</span>
          </div>
          <div className="rounded-lg border border-hud-edge bg-hud-surface px-4 py-8 text-center">
            <div className="font-mono text-sm text-hud-text">Position telemetry unavailable</div>
            <div className="text-xs text-hud-dim mt-1">The current read-only API does not expose live positions.</div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">ORDERS</h3>
            <span className="badge badge-neutral">NOT EXPOSED</span>
          </div>
          <div className="rounded-lg border border-hud-edge bg-hud-surface px-4 py-8 text-center">
            <div className="font-mono text-sm text-hud-text">Order telemetry unavailable</div>
            <div className="text-xs text-hud-dim mt-1">No order endpoint is connected to this read-only surface.</div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-hud-amber text-sm">RISK METRICS</h3>
            <span className="badge badge-neutral">NOT EXPOSED</span>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Portfolio value</span><span className="font-mono">Not reported</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Daily P&amp;L</span><span className="font-mono">Not reported</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Max drawdown</span><span className="font-mono">Not reported</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Leverage</span><span className="font-mono">Not reported</span></div>
          </div>
        </div>
      </div>

      <div className="panel p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-mono text-hud-amber text-sm">TRADING BOT TELEMETRY</h3>
            <p className="text-xs text-hud-dim mt-1">Local database and log availability, without fabricating account values.</p>
          </div>
          <span className={`badge ${liveError ? 'badge-danger' : live?.dbExists ? 'badge-success' : 'badge-neutral'}`}>{liveLabel}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Database</div><div className="font-mono mt-1">{live?.dbExists ? 'Present' : 'Not found'}</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Tables</div><div className="font-mono mt-1">{live?.tableNames?.length ? live.tableNames.length : '—'}</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Log</div><div className="font-mono mt-1">{live?.logExists ? formatBytes(live.logSize) : 'Not found'}</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Mode</div><div className="font-mono mt-1">Read only</div></div>
        </div>
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-mono text-hud-amber text-sm">POLYMARKET PAPER TRADING</h3>
            <p className="text-xs text-hud-dim mt-1">Status is read from the local configuration endpoint.</p>
          </div>
          <span className={`badge ${polymarketError ? 'badge-danger' : polymarket?.running ? 'badge-success' : 'badge-warning'}`}>{polymarketLabel}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Paper mode</div><div className="font-mono mt-1">{polymarket?.paper_only === false ? 'Disabled' : 'Required'}</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Engine</div><div className="font-mono mt-1">{polymarket?.running ? 'Running' : 'Not reported'}</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">Positions</div><div className="font-mono mt-1">Not exposed</div></div>
          <div className="panel-surface p-3"><div className="text-xs text-hud-dim">PnL</div><div className="font-mono mt-1">Not exposed</div></div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-primary" disabled>Start paper engine</button>
          <button className="btn btn-danger" disabled>Stop engine</button>
          <button className="btn btn-ghost" disabled>View logs</button>
          <span className="self-center text-xs text-hud-dim">Controls are disabled until a managed execution endpoint is connected.</span>
        </div>
      </div>
    </div>
  );
}
