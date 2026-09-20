import { useLive, relTime, type Summary } from '../api';

// F1 — Sessions. The hive has no PTY inventory of its own; this floor is the
// runtime map: which provider hosts each agent, where it lives on disk, and
// whether that location is still real (cwdValid).
export default function SessionsPanel() {
  const { data } = useLive<Summary>('/api/summary');
  const agents = data?.agents ?? [];

  return (
    <div className="panel flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-hud-edge flex items-center justify-between">
        <span className="font-mono text-xs tracking-widest text-hud-dim">F1 · SESSIONS / RUNTIME MAP</span>
        <span className="text-[11px] font-mono text-hud-dim">read-only — terminal embedding is not in this build</span>
      </div>
      <div className="flex-1 overflow-auto">
        {agents.map((a) => (
          <div key={a.id} className="flex items-center gap-4 px-4 py-3 border-b border-hud-edge/50 hover:bg-white/[0.02]">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: a.display === 'busy' ? '#34d399' : a.display === 'idle' ? '#f5a623' : a.display === 'breaker' ? '#f87171' : '#475569' }}
            />
            <div className="w-28 shrink-0">
              <div className="text-sm font-medium">{a.name}</div>
              <div className="text-[10px] font-mono text-hud-dim">{a.provider ?? '—'}</div>
            </div>
            <div className="flex-1 font-mono text-[11px] text-hud-dim truncate" title={a.cwd ?? undefined}>
              {a.cwd ?? '—'}
            </div>
            {!a.cwdValid && <span className="text-[10px] font-mono text-hud-red bg-hud-red/10 px-1.5 py-0.5 rounded">cwd gone</span>}
            {a.archived && <span className="text-[10px] font-mono text-hud-dim bg-white/5 px-1.5 py-0.5 rounded">archived</span>}
            <span className="text-[11px] font-mono text-hud-dim w-16 text-right shrink-0">{relTime(a.lastSeen)}</span>
          </div>
        ))}
        {agents.length === 0 && <div className="p-6 text-hud-dim text-sm">no agents in hive</div>}
      </div>
    </div>
  );
}
