import { useMemo } from 'react';
import { useLive, relTime, type Agent, type LedgerEvent, type Summary } from '../api';

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-2xl font-semibold" style={accent ? { color: accent } : undefined}>{value}</div>
      <div className="text-[11px] text-hud-dim mt-1 font-mono">{label}</div>
    </div>
  );
}

function Sparkline({ events }: { events: LedgerEvent[] }) {
  // events/hour over last 24h
  const points = useMemo(() => {
    const buckets = new Array(24).fill(0);
    const now = Date.now();
    for (const e of events) {
      const ts = (e.ts ?? 0) as number;
      const ms = ts > 1e12 ? ts : ts * 1000;
      const hoursAgo = Math.floor((now - ms) / 3_600_000);
      if (hoursAgo >= 0 && hoursAgo < 24) buckets[23 - hoursAgo]++;
    }
    return buckets;
  }, [events]);

  const max = Math.max(...points, 1);
  const w = 100 / (points.length - 1);
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * w).toFixed(2)},${(40 - (v / max) * 36).toFixed(2)}`).join(' ');

  return (
    <svg viewBox="0 0 100 40" className="w-full h-24" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="#f5a623" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <path d={`${path} L100,40 L0,40 Z`} fill="rgba(245,166,35,0.08)" stroke="none" />
    </svg>
  );
}

export default function ExecutiveHQ() {
  const { data: summary } = useLive<Summary>('/api/summary');
  const { data: ledger } = useLive<{ events: LedgerEvent[] }>('/api/ledger?limit=2000');

  const agents: Agent[] = summary?.agents ?? [];
  const events = ledger?.events ?? [];

  const active = agents.filter((a) => !a.archived).length;
  const archived = agents.filter((a) => a.archived).length;
  const backlog = agents.reduce((n, a) => n + (a.inboxBacklog ?? 0), 0);
  const cost = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
  const breakers = agents.filter((a) => a.breaker && a.breaker !== 'healthy' && !a.archived).length;

  const dayAgo = Date.now() - 86_400_000;
  const eventsToday = events.filter((e) => ((e.ts as number) > 1e12 ? (e.ts as number) : (e.ts as number) * 1000) > dayAgo).length;

  return (
    <div className="space-y-4 overflow-auto">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="AGENTS ACTIVE" value={String(active)} accent="#34d399" />
        <Kpi label="ARCHIVED" value={String(archived)} />
        <Kpi label="INBOX BACKLOG" value={String(backlog)} accent={backlog ? '#f5a623' : undefined} />
        <Kpi label="EVENTS · 24H" value={String(eventsToday)} />
        <Kpi label="TOTAL COST" value={`$${cost.toFixed(2)}`} />
        <Kpi label="BREAKERS" value={breakers ? String(breakers) : '0'} accent={breakers ? '#f87171' : '#34d399'} />
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="font-mono text-xs tracking-widest text-hud-dim">FLEET ACTIVITY · EVENTS/HOUR · LAST 24H</span>
          <span className="text-[11px] font-mono text-hud-dim">{events.length} total events</span>
        </div>
        <Sparkline events={events} />
      </div>

      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b border-hud-edge font-mono text-xs tracking-widest text-hud-dim">ROSTER</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-hud-dim border-b border-hud-edge">
              <th className="px-4 py-2 font-mono font-normal">agent</th>
              <th className="px-4 py-2 font-mono font-normal">status</th>
              <th className="px-4 py-2 font-mono font-normal">breaker</th>
              <th className="px-4 py-2 font-mono font-normal">backlog</th>
              <th className="px-4 py-2 font-mono font-normal">tokens</th>
              <th className="px-4 py-2 font-mono font-normal">cost</th>
              <th className="px-4 py-2 font-mono font-normal">last seen</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-b border-hud-edge/50 hover:bg-white/[0.02]">
                <td className="px-4 py-2 font-medium">
                  {a.name}{a.isGod ? <span className="ml-2 text-[9px] text-hud-amber font-mono">GOD</span> : null}
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <i
                      className="w-1.5 h-1.5 rounded-full inline-block"
                      style={{ background: a.display === 'busy' ? '#34d399' : a.display === 'idle' ? '#f5a623' : a.display === 'breaker' ? '#f87171' : '#475569' }}
                    />
                    {a.display}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-hud-dim">{a.archived ? '—' : a.breaker}</td>
                <td className="px-4 py-2 font-mono">{a.inboxBacklog || ''}</td>
                <td className="px-4 py-2 font-mono">{a.tokens || ''}</td>
                <td className="px-4 py-2 font-mono">{a.usd ? `$${a.usd.toFixed(2)}` : ''}</td>
                <td className="px-4 py-2 font-mono text-hud-dim">{relTime(a.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
