import { useLive, type Summary, type QueueSummary, type TaskRecord, type AutonomyState, type JarvisTasksResponse, type ProjectRecord } from '../api';

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16' | 'f17' | 'f18' | 'f19' | 'f20' | 'f21' | 'f22';

interface BadgeData {
  summary: Summary | null;
  queue: QueueSummary | null;
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  tasksLoaded: boolean;
  projectsLoaded: boolean;
  jarvisQueue: number;
  validationArms: number;
  autonomyProposals: number;
  autopilotProposals: number;
  tradingMonitors: number;
  replay: any;
  fleet: any;
  alphainsider: any;
}

interface FloorDefinition {
  id: FloorId;
  label: string;
  name: string;
  badge: (data: BadgeData) => number;
  taskCount?: boolean;
}

const FLOORS: FloorDefinition[] = [
  { id: 'f1', label: 'F1', name: 'Sessions', badge: data => data.summary?.agents?.filter(agent => agent.display === 'busy' || agent.display === 'idle').length ?? 0 },
  { id: 'f2', label: 'F2', name: 'Ledger', badge: data => data.queue?.completionsLastHour ?? 0 },
  { id: 'f3', label: 'F3', name: 'Agents', badge: data => data.summary?.agents?.length ?? 0 },
  { id: 'f4', label: 'F4', name: 'Projects', badge: data => data.projects.length, taskCount: true },
  { id: 'f5', label: 'F5', name: 'HQ', badge: data => (data.queue?.queued ?? 0) + (data.queue?.inProgress ?? 0) },
  { id: 'f6', label: 'F6', name: 'Trading Lab', badge: data => taskCountsForFloor(data.tasks, 'f6'), taskCount: true },
  { id: 'f7', label: 'F7', name: 'Strategy Lab', badge: data => taskCountsForFloor(data.tasks, 'f7'), taskCount: true },
  { id: 'f8', label: 'F8', name: 'Candle Strategies', badge: data => taskCountsForFloor(data.tasks, 'f8'), taskCount: true },
  { id: 'f9', label: 'F9', name: '24x7 Ops', badge: data => taskCountsForFloor(data.tasks, 'f9'), taskCount: true },
  { id: 'f10', label: 'F10', name: 'Knowledge', badge: data => taskCountsForFloor(data.tasks, 'f10'), taskCount: true },
  { id: 'f11', label: 'F11', name: 'Risk Metrics', badge: data => taskCountsForFloor(data.tasks, 'f11'), taskCount: true },
  { id: 'f12', label: 'F12', name: 'Knowledge Graph', badge: data => taskCountsForFloor(data.tasks, 'f12'), taskCount: true },
  { id: 'f13', label: 'F13', name: 'Time Machine', badge: data => data.replay?.eventsAvailable ?? 0 },
  { id: 'f14', label: 'F14', name: 'Fleet', badge: data => data.fleet?.hosts?.length ?? 0 },
  { id: 'f15', label: 'F15', name: 'Alpha Insider', badge: data => data.alphainsider?.length ?? 0 },
  { id: 'f16', label: 'F16', name: 'Overview', badge: data => (data.queue?.inProgress ?? 0) + (data.queue?.queued ?? 0) },
  { id: 'f17', label: 'F17', name: 'Desk', badge: data => data.jarvisQueue + (data.queue?.inProgress ?? 0) },
  { id: 'f18', label: 'F18', name: 'Validation', badge: data => data.validationArms },
  { id: 'f19', label: 'F19', name: 'Autonomy', badge: data => data.autonomyProposals },
  { id: 'f20', label: 'F20', name: 'Autopilot', badge: data => data.autopilotProposals },
  { id: 'f21', label: 'F21', name: 'God', badge: () => 1 },
  { id: 'f22', label: 'F22', name: 'Trading Monitor', badge: data => data.tradingMonitors },
];

function floorForValue(value: string | null | undefined): FloorId | null {
  const match = value?.trim().toLowerCase().match(/^f([1-9]|1[0-9]|2[0-2])$/);
  return match ? `f${match[1]}` as FloorId : null;
}

function taskCountsForFloor(tasks: TaskRecord[], floor: FloorId) {
  return tasks.filter(task => floorForValue(task.assigned_agent) === floor || floorForValue(task.claimed_by) === floor).length;
}

interface Props {
  current: FloorId;
  onChange: (id: FloorId) => void;
  summary: Summary | null;
}

export default function FloorNav({ current, onChange, summary }: Props) {
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  const { data: tasksData } = useLive<{ tasks: TaskRecord[] }>('/api/tasks');
  const { data: projectsData } = useLive<{ projects: ProjectRecord[] }>('/api/projects');
  const { data: jarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks?limit=1');
  const { data: validationEvidence } = useLive<any>('/api/validationEvidence');
  const { data: autonomy } = useLive<AutonomyState>('/api/autonomy');
  const { data: autopilot } = useLive<any>('/api/autopilot/snapshot');
  const { data: alphainsider } = useLive<any>('/api/trading/alphainsider');
  const { data: fleet } = useLive<any>('/api/terminals');
  const { data: replay } = useLive<any>('/api/replay/window');
  const data: BadgeData = {
    summary,
    queue,
    tasks: tasksData?.tasks ?? [],
    projects: projectsData?.projects ?? [],
    tasksLoaded: tasksData !== null,
    projectsLoaded: projectsData !== null,
    jarvisQueue: (jarvisTasks?.tasks ?? []).length,
    validationArms: validationEvidence?.arms?.length ?? 0,
    autonomyProposals: (autonomy?.proposals ?? []).filter(p => p.status === 'pending').length,
    autopilotProposals: (autopilot?.proposals ?? []).filter(p => p.state === 'open').length,
    tradingMonitors: alphainsider ? 1 : 0,
    fleet,
    replay,
    alphainsider,
  };

  return (
    <nav className="w-48 flex-shrink-0 border-r border-hud-edge bg-hud-bg flex flex-col" aria-label="Office floors">
      <div className="p-4 border-b border-hud-edge">
        <div className="flex items-center gap-2">
          <span className="text-xl font-mono text-hud-amber">OF</span>
          <span className="text-[10px] font-mono tracking-widest text-hud-dim">HUD</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto py-2">
        {FLOORS.map(floor => {
          const count = floor.badge(data);
          const taskCount = taskCountsForFloor(data.tasks, floor.id);
          const showProjectBadge = floor.id === 'f4' && data.projectsLoaded;
          const showTaskBadge = floor.taskCount && data.tasksLoaded;
          return (
            <button
              key={floor.id}
              type="button"
              onClick={() => onChange(floor.id)}
              aria-current={current === floor.id ? 'page' : undefined}
              className={`w-full px-3 py-2.5 text-left rounded-lg mx-2 transition-colors ${
                current === floor.id
                  ? 'bg-hud-edge text-hud-text'
                  : 'text-hud-dim hover:text-hud-text hover:bg-white/[0.03]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{floor.label}</span>
                <span className="flex items-center gap-1">
                  {showProjectBadge && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-blue/15 text-hud-blue" title={`${count} projects`}>{count}</span>}
                  {showTaskBadge && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber" title={`${taskCount} tasks`}>{taskCount}</span>}
                  {!showProjectBadge && !showTaskBadge && count > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">{count}</span>}
                </span>
              </div>
              <div className="text-[10px] text-hud-dim mt-0.5">
                {floor.name}
                {floor.taskCount && data.tasksLoaded ? ` · ${taskCount} tasks` : floor.id === 'f4' && !data.projectsLoaded ? ' · loading projects' : ''}
              </div>
            </button>
          );
        })}
      </div>
      <div className="p-3 border-t border-hud-edge text-[10px] font-mono text-hud-dim">
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded mr-1">1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">0</kbd>
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">-</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">=</kbd>
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">Bksp</kbd>
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">F1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">F4</kbd>
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">Shift+1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">6</kbd>
        switch floors
      </div>
    </nav>
  );
}
