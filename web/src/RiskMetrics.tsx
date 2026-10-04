import { useLive, type LiveMetrics } from './api';

type Breaker = { state?: string; failures?: number; available?: boolean };
type BreakerResponse = { breakers: Record<string, Breaker> };
type CostResponse = { total: { daily: number; monthly: number }; agents: Record<string, unknown> };

function Metric({ label, value, tone = 'text-hud-dim' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-surface px-3 py-2">
      <div className="text-[10px] font-mono text-hud-dim">{label}</div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );
}

const RISK_ROWS = [
  ['Portfolio VaR (95%, 1-day)', 'NOT EXPOSED'],
  ['Expected shortfall (CVaR 95%)', 'NOT EXPOSED'],
  ['Max drawdown', 'NOT EXPOSED'],
  ['Max pairwise correlation', 'NOT EXPOSED'],
] as const;

const STRESS_ROWS = [
  'Market crash (-20%)',
  'Flash crash (-10% in 1hr)',
  'Liquidity crisis',
  'Correlation breakdown',
] as const;

export default function RiskMetrics() {
  const { data: live, error: liveError } = useLive<LiveMetrics>('/api/trading/live');
  const { data: breakers, error: breakerError } = useLive<BreakerResponse>('/api/llm/circuit-breakers');
  const { data: costs, error: costError } = useLive<CostResponse>('/api/llm/costs');

  const breakerEntries = Object.entries(breakers?.breakers ?? {});
  const openBreakers = breakerEntries.filter(([, breaker]) => breaker.state !== 'closed');
  const monthly = costs?.total?.monthly ?? 0;
  const daily = costs?.total?.daily ?? 0;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F11 · RISK METRICS</h2>
        <span className="badge badge-warning">NO RISK DATA SOURCE</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <Metric label="PORTFOLIO VAR (95%)" value="—" />
        <Metric label="EXPECTED SHORTFALL" value="—" />
        <Metric label="MAX DRAWDOWN" value="—" />
        <Metric label="CORRELATION RISK" value="—" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RISK MEASURES</h3>
          <div className="space-y-2">
            {RISK_ROWS.map(([label, status]) => (
              <div key={label} className="panel-surface px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-xs text-hud-dim">{label}</span>
                <span className="font-mono text-[10px] text-hud-amber">{status}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[10px] text-hud-dim leading-5">
            No portfolio, position, or return-history endpoint is exposed to the HUD. These measures are not estimated or filled in.
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">STRESS TESTS</h3>
          <div className="space-y-2">
            {STRESS_ROWS.map(label => (
              <div key={label} className="panel-surface px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-xs text-hud-dim">{label}</span>
                <span className="font-mono text-[10px] text-hud-amber">NOT RUN</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[10px] text-hud-dim leading-5">
            Stress scenarios are not executed on this read-only floor.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-4 min-w-0">
          <h3 className="font-mono text-hud-amber text-sm mb-3">AVAILABLE SAFETY SIGNALS</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Trading DB</span><span className={`font-mono ${liveError ? 'text-hud-red' : live?.dbExists ? 'text-hud-green' : 'text-hud-dim'}`}>{liveError ? 'ERROR' : live?.dbExists ? 'PRESENT' : 'ABSENT'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Decision log</span><span className={`font-mono ${liveError ? 'text-hud-red' : live?.logExists ? 'text-hud-green' : 'text-hud-dim'}`}>{liveError ? 'ERROR' : live?.logExists ? `PRESENT (${live.logSize} B)` : 'ABSENT'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">Circuit breakers</span><span className={`font-mono ${breakerError ? 'text-hud-red' : openBreakers.length ? 'text-hud-amber' : 'text-hud-green'}`}>{breakerError ? 'ERROR' : `${breakerEntries.length - openBreakers.length}/${breakerEntries.length} CLOSED`}</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">LLM spend today</span><span className="font-mono">{costError ? 'ERROR' : `$${daily.toFixed(4)}`}</span></div>
            <div className="flex justify-between gap-3"><span className="text-hud-dim">LLM spend this month</span><span className="font-mono">{costError ? 'ERROR' : `$${monthly.toFixed(4)}`}</span></div>
          </div>
          <div className="mt-3 space-y-1.5">
            {breakerEntries.map(([name, breaker]) => (
              <div key={name} className="flex items-center justify-between gap-3 text-[10px]">
                <span className="font-mono text-hud-dim truncate">{name}</span>
                <span className={`font-mono ${breaker.state === 'closed' ? 'text-hud-green' : 'text-hud-amber'}`}>
                  {breaker.state ?? 'unknown'}{breaker.failures ? ` · ${breaker.failures} fail` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">RISK BOUNDARY</h3>
          <div className="panel-surface p-4 text-xs text-hud-dim leading-5">
            Trading is paper/testnet only and this floor exposes no execution, sizing, or position controls. VaR, CVaR, drawdown, correlation, and stress results remain blank until a real risk data source is wired in; fabricating zeros would misrepresent risk.
          </div>
        </div>
      </div>
    </div>
  );
}
