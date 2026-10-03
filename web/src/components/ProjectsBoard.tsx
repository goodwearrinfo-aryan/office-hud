import { useLive, type TaskRecord } from '../api';

type Column = {
  id: string;
  title: string;
  color: string;
  badge: string;
  statuses: Set<string>;
};

const columns: Column[] = [
  {
    id: 'todo',
    title: 'TODO',
    color: 'text-hud-dim',
    badge: 'badge-neutral',
    statuses: new Set(['QUEUED', 'PRESERVED', 'TODO', 'PENDING']),
  },
  {
    id: 'in_progress',
    title: 'IN PROGRESS',
    color: 'text-hud-amber',
    badge: 'badge-warning',
    statuses: new Set(['IN_PROGRESS']),
  },
  {
    id: 'review',
    title: 'REVIEW',
    color: 'text-hud-blue',
    badge: 'badge-info',
    statuses: new Set(['QUARANTINED', 'REVIEW', 'VERIFY', 'BLOCKED', 'FAILED']),
  },
  {
    id: 'done',
    title: 'DONE',
    color: 'text-hud-green',
    badge: 'badge-success',
    statuses: new Set(['COMPLETE', 'DONE']),
  },
];

function taskTime(task: TaskRecord) {
  const raw = task.updated_at || task.heartbeat || task.started_at || task.created_at;
  const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timeAgo(task: TaskRecord) {
  const updated = taskTime(task);
  if (!updated) return 'no time';
  const seconds = Math.max(0, Math.floor((Date.now() - updated) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface TaskBoard {
  groups: Record<string, TaskRecord[]>;
  counts: Record<string, number>;
  total: number;
  perColumn: number;
}

export default function ProjectsBoard({ onSelect }: { onSelect: (id: string) => void }) {
  // The board payload is pre-grouped and capped server-side: 28KB instead of
  // the 3.8MB tasks.json this used to pull to draw the same cards.
  const { data: board } = useLive<TaskBoard>('/api/task-board');

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">
        F4 · PROJECTS BOARD
        {board && <span className="ml-3 text-[10px] font-mono text-hud-dim">{board.total} tasks</span>}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 h-[calc(100vh-150px)]">
        {columns.map(col => {
          const visibleTasks = board?.groups[col.id] ?? [];
          const columnTotal = board?.counts[col.id] ?? 0;
          return (
            <div key={col.id} className="panel flex flex-col min-w-0">
              <div className="px-4 py-2 border-b border-hud-edge flex items-center justify-between">
                <h3 className={`font-mono text-xs tracking-widest ${col.color}`}>{col.title}</h3>
                <span className={`badge ${col.badge}`}>{columnTotal}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
                {visibleTasks.map(task => {
                  const assigned = typeof task.assigned_agent === 'string' ? task.assigned_agent : null;
                  const claimed = typeof task.claimed_by === 'string' ? task.claimed_by.toLowerCase() : null;
                  const agentId = assigned || claimed;
                  const status = String(task.status).replace(/_/g, ' ');
                  return (
                    <button
                      key={task.task_id}
                      type="button"
                      className="panel-surface w-full p-3 text-left hover:border-hud-edge-strong"
                      onClick={() => { if (agentId) onSelect(agentId); }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs leading-5">{task.title || task.task_id}</span>
                        <span className={`badge ${col.badge} shrink-0`}>{status}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-hud-dim">
                        <span className="truncate">{agentId || String(task.project_id || 'default')}</span>
                        <span className="shrink-0">{timeAgo(task)}</span>
                      </div>
                    </button>
                  );
                })}
                {!board && <div className="text-hud-dim text-center text-xs py-8">Loading tasks…</div>}
                {board && visibleTasks.length === 0 && <div className="text-hud-dim text-center text-xs py-8">No tasks</div>}
                {columnTotal > visibleTasks.length && (
                  <div className="text-hud-dim text-center text-[10px] py-2">
                    Showing the {visibleTasks.length} most recent of {columnTotal}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
