import { useMemo } from 'react';
import { useLive, type Agent, type Summary } from '../api';

// F4 — Projects. Agents grouped by where they live on disk.
export default function ProjectsBoard({ onSelect }: { onSelect: (id: string) => void }) {
  const { data } = useLive<Summary>('/api/summary');
  const agents = data?.agents ?? [];

  const projects = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const key = a.cwd ?? '(no cwd)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [agents]);

  return (
    <div className="flex-1 overflow-auto space-y-4">
      <div className="font-mono text-xs tracking-widest text-hud-dim px-1">F4 · PROJECTS — {projects.length}</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {projects.map(([cwd, list]) => (
          <div key={cwd} className="panel p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-mono text-xs text-hud-amber truncate" title={cwd}>{cwd.replace(/^\/Users\/[^/]+\//, '~/')}</div>
              <span className="text-[10px] font-mono text-hud-dim">{list.length} agent{list.length === 1 ? '' : 's'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {list.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onSelect(a.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-hud-bg border border-hud-edge hover:border-hud-amber/60 transition-colors text-xs"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: a.display === 'busy' ? '#34d399' : a.display === 'idle' ? '#f5a623' : a.display === 'breaker' ? '#f87171' : '#475569' }}
                  />
                  {a.name}
                  {!a.cwdValid && <span className="text-[9px] text-hud-red font-mono">gone</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        {projects.length === 0 && <div className="panel p-6 text-hud-dim text-sm">no projects — no agents found</div>}
      </div>
    </div>
  );
}
