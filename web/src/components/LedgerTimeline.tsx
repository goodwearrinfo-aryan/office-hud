import { useMemo, useState } from 'react';
import { useLive, shortTime, type LedgerEvent } from '../api';

const KIND_STYLE: Record<string, { color: string; label?: string }> = {
  spawn: { color: '#34d399' },
  message: { color: '#60a5fa' },
  archive: { color: '#8b93a7' },
  'app-start': { color: '#c084fc' },
  cwd_invalid: { color: '#f87171' },
  drop: { color: '#f5a623' },
  role: { color: '#2dd4bf' },
};

function detail(e: LedgerEvent): string {
  const { ts, kind, ...rest } = e;
  const s = JSON.stringify(rest);
  return s.length > 180 ? s.slice(0, 180) + '…' : s;
}

export default function LedgerTimeline() {
  const { data } = useLive<{ events: LedgerEvent[] }>('/api/ledger');
  const [filter, setFilter] = useState<string>('all');

  const kinds = useMemo(() => {
    const set = new Map<string, number>();
    (data?.events ?? []).forEach((e) => set.set(e.kind ?? '?', (set.get(e.kind ?? '?') ?? 0) + 1));
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const events = (data?.events ?? []).filter((e) => filter === 'all' || e.kind === filter);

  return (
    <div className="panel flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-hud-edge flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs tracking-widest text-hud-dim mr-2">F2 · LEDGER</span>
        <button
          onClick={() => setFilter('all')}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-mono ${filter === 'all' ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'}`}
        >
          all · {data?.events.length ?? 0}
        </button>
        {kinds.map(([k, n]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-mono ${filter === k ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'}`}
            style={{ borderLeft: `2px solid ${KIND_STYLE[k]?.color ?? '#444'}` }}
          >
            {k} · {n}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {events.length === 0 && <div className="p-6 text-hud-dim text-sm">no events</div>}
        {events.map((e, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-2 border-b border-hud-edge/50 hover:bg-white/[0.02]">
            <span className="text-[11px] font-mono text-hud-dim w-14 shrink-0 pt-0.5">{shortTime(e.ts as number)}</span>
            <span
              className="text-[10px] font-mono px-1.5 rounded shrink-0 mt-0.5"
              style={{ color: KIND_STYLE[e.kind ?? '']?.color ?? '#8b93a7', background: 'rgba(255,255,255,0.04)' }}
            >
              {e.kind ?? '?'}
            </span>
            <span className="text-[11px] font-mono text-hud-dim break-all leading-relaxed">{detail(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
