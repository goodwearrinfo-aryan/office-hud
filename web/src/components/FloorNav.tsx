import { useLive, type QueueSummary, type Summary } from '../api';

const FLOORS = [
  { id: 'f1', label: 'F1', name: 'Sessions', badge: (s: Summary) => s?.agents?.filter(a => a.display === 'busy' || a.display === 'idle').length ?? 0 },
  { id: 'f2', label: 'F2', name: 'Ledger', badge: (_s: Summary, q: QueueSummary | null) => q?.completionsLastHour ?? 0 },
  { id: 'f3', label: 'F3', name: 'Agents', badge: (s: Summary) => s?.agents?.length ?? 0 },
  { id: 'f4', label: 'F4', name: 'Projects', badge: (s: Summary) => s?.agents?.length ?? 0 },
  { id: 'f5', label: 'F5', name: 'HQ', badge: (_s: Summary, q: QueueSummary | null) => (q?.queued ?? 0) + (q?.inProgress ?? 0) },
  { id: 'f6', label: 'F6', name: 'Trading Lab', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f7', label: 'F7', name: 'Strategy Lab', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f8', label: 'F8', name: 'Live Trading', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f9', label: 'F9', name: '24x7 Ops', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f10', label: 'F10', name: 'Knowledge', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f11', label: 'F11', name: 'Risk Metrics', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f12', label: 'F12', name: 'Knowledge Graph', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f13', label: 'F13', name: 'Time Machine', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f14', label: 'F14', name: 'Validation', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f15', label: 'F15', name: 'Combined Portfolio', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
  { id: 'f16', label: 'F16', name: 'Overview', badge: (_s: Summary, _q: QueueSummary | null) => 0 },
] as const;

type FloorId = typeof FLOORS[number]['id'];

interface Props {
  current: FloorId;
  onChange: (id: FloorId) => void;
  summary: Summary | null;
}

export default function FloorNav({ current, onChange, summary }: Props) {
  const { data: queue } = useLive<QueueSummary>('/api/queue');
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
              {f.badge(summary, queue) > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">
                  {f.badge(summary, queue)}
                </span>
              )}
            </div>
            <div className="text-[10px] text-hud-dim mt-0.5">{f.name}</div>
          </button>
        ))}
      </div>
      <div className="p-3 border-t border-hud-edge text-[10px] font-mono text-hud-dim">
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded mr-1">1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">0</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">-</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">=</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">Bksp</kbd> switch floors · <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">[</kbd>+<kbd className="bg-hud-edge px-1.5 py-0.5 rounded">3</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded">6</kbd> for F13–F16
      </div>
    </nav>
  );
}