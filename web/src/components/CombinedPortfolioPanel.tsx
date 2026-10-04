import { useLive } from '../api';

interface CombinedComponent {
  weight?: number;
  equity?: number | null;
  net?: number | null;
  collected?: number | null;
  fees?: number | null;
  flips?: number | null;
  side?: number | string | null;
  trips?: number | null;
  status?: string;
  persistence?: string;
  included?: boolean;
}

interface CombinedData {
  ok?: boolean;
  ts?: string;
  price?: number;
  error?: string;
  weights?: Record<string, number>;
  combined?: { equity?: number; net?: number | null; return_pct?: number | null };
  components?: Record<string, CombinedComponent>;
  audit_reference?: {
    sharpe?: number | null;
    sortino?: number | null;
    max_dd_pct?: number | null;
    best_solo_sharpe?: number | null;
    return_pct?: number | null;
    basis?: string;
    note?: string;
    sharpe_suppressed_reason?: string;
    excluded_components?: string[];
    source?: string;
  };
}

const NAMES: Record<string, string> = {
  carry_btc: 'Carry BTC',
  carry_eth: 'Carry ETH',
  smart_trend_btc: 'Smart Trend BTC',
  trend_btc_1h: 'Trend BTC 1h',
};

function fmt(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function tone(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'text-hud-dim';
  return value > 0 ? 'text-hud-green' : 'text-hud-red';
}

function sideLabel(side: number | string | null | undefined) {
  if (typeof side === 'string') return side.toUpperCase();
  if (side === 1) return 'LONG';
  if (side === -1) return 'SHORT';
  return 'flat';
}

export default function CombinedPortfolioPanel() {
  const { data, error } = useLive<CombinedData>('/api/live/combined');

  if (error) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="panel-surface px-3 py-2 text-hud-red">combined feed unavailable: {error}</div>
      </div>
    );
  }
  if (!data?.ok) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="panel-surface px-3 py-2 text-hud-dim">
          {data?.error ? `combined feed: ${data.error}` : 'waiting for the combined feed…'}
        </div>
      </div>
    );
  }

  const combined = data.combined ?? {};
  const components = Object.entries(data.components ?? {});
  const audit = data.audit_reference ?? {};

  return (
    <div className="h-full overflow-auto p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">COMBINED EQUITY</div>
          <div className={`mt-1 font-mono text-lg font-semibold ${tone(combined.net)}`}>{fmt(combined.equity)}</div>
          <div className="font-mono text-[11px] text-hud-dim">
            net <span className={tone(combined.net)}>{fmt(combined.net)}</span>
            {combined.return_pct != null ? ` · ${combined.return_pct}%` : ''}
          </div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">BTC PRICE</div>
          <div className="mt-1 font-mono text-lg font-semibold text-hud-text">{fmt(data.price, 0)}</div>
          <div className="font-mono text-[11px] text-hud-dim">proxy for trend legs</div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">AUDIT SHARPE</div>
          <div className="mt-1 font-mono text-lg font-semibold text-hud-text">
            {audit.sharpe != null ? fmt(audit.sharpe) : 'suppressed'}
          </div>
          <div className="font-mono text-[11px] text-hud-dim">
            {audit.sharpe != null
              ? `vs ${fmt(audit.best_solo_sharpe)} best solo`
              : 'funding accrual: vol is a model artifact'}
          </div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">AUDIT MAX DD</div>
          <div className="mt-1 font-mono text-lg font-semibold text-hud-text">{fmt(audit.max_dd_pct)}%</div>
          <div className="font-mono text-[11px] text-hud-dim">
            {audit.return_pct != null ? `${audit.return_pct}% research-eligible` : 'inverse-vol weights'}
          </div>
        </div>
      </div>

      <div className="panel-surface">
        <table className="w-full">
          <thead>
            <tr className="border-b border-hud-edge">
              <th className="px-3 py-2 text-left text-[10px] font-mono text-hud-dim">COMPONENT</th>
              <th className="px-3 py-2 text-left text-[10px] font-mono text-hud-dim">WEIGHT</th>
              <th className="px-3 py-2 text-left text-[10px] font-mono text-hud-dim">EQUITY</th>
              <th className="px-3 py-2 text-left text-[10px] font-mono text-hud-dim">NET</th>
              <th className="px-3 py-2 text-left text-[10px] font-mono text-hud-dim">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {components.map(([name, comp]) => {
              const w = comp.weight ?? 0;
              const excluded = comp.included === false;
              return (
                <tr key={name} className={`border-b border-hud-edge last:border-0${excluded ? ' opacity-50' : ''}`}>
                  <td className="px-3 py-2 font-mono text-sm">
                    {NAMES[name] || name}
                    <div className={`mt-1 h-1 rounded ${excluded ? 'bg-hud-dim' : 'bg-hud-accent'}`}
                         style={{ width: excluded ? 2 : Math.max(2, Math.round(w * 120)) }} />
                  </td>
                  <td className="px-3 py-2 font-mono text-sm text-hud-dim">{(w * 100).toFixed(1)}%</td>
                  <td className={`px-3 py-2 font-mono text-sm ${tone(comp.net)}`}>{fmt(comp.equity)}</td>
                  <td className={`px-3 py-2 font-mono text-sm ${tone(comp.net)}`}>{fmt(comp.net)}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-hud-dim">
                    {excluded ? <span className="text-hud-red">excluded from blend</span> : (comp.status || '')}
                    {comp.side != null ? ` · ${sideLabel(comp.side)}` : ''}
                    {comp.flips != null ? ` · ${comp.flips} flips` : ''}
                    {comp.trips != null ? ` · ${comp.trips} trips` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.ts ? <div className="font-mono text-[11px] text-hud-dim">updated {data.ts}</div> : null}
    </div>
  );
}
