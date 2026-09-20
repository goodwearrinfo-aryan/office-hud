import { useLive, type Summary } from '../api';

const FLOORS = [
  { id: 'f1', label: 'F1', name: 'Sessions', badge: (s: Summary) => s?.agents?.filter((a) => !a.archived).length ?? 0 },
  { id: 'f2', label: 'F2', name: 'Ledger', badge: (s: Summary) => s?.agents?.reduce((n, a) => n + (a.inboxBacklog ?? 0), 0) ?? 0 },
  { id: 'f3', label: 'F3', name: 'Agents', badge: (s: Summary) => s?.agents?.length ?? 0 },
  { id: 'f4', label: 'F4', name: 'Projects', badge: (s: Summary) => s?.agents?.length ?? 0 },
  { id: 'f5', label: 'F5', name: 'HQ', badge: (s: Summary) => 0 },
] as const;

type FloorId = typeof FLOORS[number]['id'];

interface Props {
  current: FloorId;
  onChange: (id: FloorId) => void;
  summary: Summary | null;
}

export default function FloorNav({ current, onChange, summary }: Props) {
  return (
    <nav className="w-48 flex-shrink-0 border-r border-hud-edge bg-hud-bg flex flex-col">
      <div className="p-4 border-b border-hud-edge">
        <div className="flex items-center gap-2">
          <span className="text-xl font-mono text-hud-amber">OF</span>
          <span className="text-[10px] font-mono tracking-widest text-hud-dim">HUD</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto py-2">
        {FLOORS.map((f) => (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            className={`w-full px-3 py-2.5 text-left rounded-lg mx-2 transition-colors ${
              current === f.id
                ? 'bg-hud-edge text-hud-text'
                : 'text-hud-dim hover:text-hud-text hover:bg-white/[0.03]'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">{f.label}</span>
              {f.badge(summary) > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">
                  {f.badge(summary)}
                </span>
              )}
            </div>
            <div className="text-[10px] text-hud-dim mt-0.5">{f.name}</div>
          </button>
        ))}
      </div>
      <div className="p-3 border-t border-hud-edge text-[10px] font-mono text-hud-dim">
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded mr-1">1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">5</kbd> switch floors
      </div>
    </nav>
  );
}