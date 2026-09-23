import { useLive } from '../api';
import { Agent } from '../api';

export default function ProjectsBoard({ onSelect }: { onSelect: (id: string) => void }) {
  const { data: tasksData } = useLive<{ tasks: any[] }>('/api/tasks');

  const columns = [
    { id: 'todo', title: 'TODO', color: 'hud-dim' },
    { id: 'in_progress', title: 'IN PROGRESS', color: 'hud-amber' },
    { id: 'review', title: 'REVIEW', color: 'hud-blue' },
    { id: 'done', title: 'DONE', color: 'hud-green' },
  ];

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F4 · PROJECTS BOARD</h2>
      <div className="grid grid-cols-4 gap-4 h-[calc(100vh-150px)]">
        {columns.map(col => (
          <div key={col.id} className="panel flex flex-col">
            <div className="px-4 py-2 border-b border-hud-edge flex items-center justify-between">
              <h3 className="font-mono text-xs tracking-widest text-hud-dim">{col.title}</h3>
              <span className={`badge badge-neutral`}>0</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
              <div className="text-hud-dim text-center text-xs py-8">No tasks</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}