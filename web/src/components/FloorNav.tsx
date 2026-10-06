import { useLive, useViewers, type FleetLaunchdState, type JarvisTasksResponse, type ProjectRecord, type QueueSummary, type Summary, type TerminalsPayload } from '../api';

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16' | 'f17'
  | 'f18'
  | 'f19';

interface BadgeData {
  summary: Summary | null;
  queue: QueueSummary | null;
  taskCounts: Record<string, number>;
  viewers: number;
  projects: ProjectRecord[];
  tasksLoaded: boolean;
  projectsLoaded: boolean;
  failedLaunchd: number;
  staleHosts: number;
  fleetHosts: number;
  terminalsTotal: number;
  /**
   * Work the office has been told and has not started. Counted from the queue
   * rather than from the command history, because a command that was queued and
   * then claimed is not pending any more.
   */
  pendingCommands: number;
  replay: { eventsAvailable: number } | null;
  fleet: TerminalsPayload | null;
  alphainsider: { length: number } | null;
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
  { id: 'f6', label: 'F6', name: 'Trading Lab', badge: data => (data.taskCounts['f6'] ?? 0), taskCount: true },
  { id: 'f7', label: 'F7', name: 'Strategy Lab', badge: data => (data.taskCounts['f7'] ?? 0), taskCount: true },
  { id: 'f8', label: 'F8', name: 'Live Trading', badge: data => (data.taskCounts['f8'] ?? 0), taskCount: true },
  { id: 'f9', label: 'F9', name: '24x7 Ops', badge: data => (data.taskCounts['f9'] ?? 0), taskCount: true },
  { id: 'f10', label: 'F10', name: 'Knowledge', badge: data => (data.taskCounts['f10'] ?? 0), taskCount: true },
  { id: 'f11', label: 'F11', name: 'Risk Metrics', badge: data => (data.taskCounts['f11'] ?? 0), taskCount: true },
  { id: 'f12', label: 'F12', name: 'Knowledge Graph', badge: data => (data.taskCounts['f12'] ?? 0), taskCount: true },
  { id: 'f13', label: 'F13', name: 'Time Machine', badge: data => data.replay?.eventsAvailable ?? 0 },
  { id: 'f14', label: 'F14', name: 'Fleet', badge: data => data.fleet?.hosts?.length ?? 0 },
  { id: 'f15', label: 'F15', name: 'Alpha Insider', badge: data => data.alphainsider?.length ?? 0 },
  { id: 'f16', label: 'F16', name: 'Overview', badge: data => (data.queue?.inProgress ?? 0) + (data.queue?.queued ?? 0) },
  // The one figure on this nav that should be readable without opening the
  // floor: how many machines have stopped reporting.
  { id: 'f17', label: 'F17', name: 'Fleet', badge: data => data.staleHosts },
  // The one desk figure readable without opening the floor: work that has been
  // given to the office and has not started.
  { id: 'f18', label: 'F18', name: 'The Desk', badge: data => data.pendingCommands },
  { id: 'f19', label: 'F19', name: 'Workspaces', badge: data => data.terminalsTotal },
];

interface Props {
  current: FloorId;
  onChange: (id: FloorId) => void;
  summary: Summary | null;
}

export default function FloorNav({ current, onChange, summary }: Props) {
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  // counts=1 returns a handful of bytes; the full /api/tasks payload is megabytes.
  const { data: tasksData } = useLive<{ counts: Record<string, number> }>('/api/tasks?counts=1');
  const { data: projectsData } = useLive<{ projects: ProjectRecord[] }>('/api/projects');
  // The failed-job count is the one badge that must be true on a glance, so it
  // rides the same ops snapshot the F16 overview renders.
  const { data: ops } = useLive<{ launchdState?: FleetLaunchdState }>('/api/trading/ops');
  // The fleet badge counts machines that have gone quiet. /api/terminals is already
  // being served for F17, so this costs a subscription rather than another route.
  const { data: fleet } = useLive<TerminalsPayload>('/api/terminals');
  const { data: replay } = useLive<{ eventsAvailable: number }>('/api/replay/window');
  const { data: alphainsider } = useLive<{ length: number }>('/api/alphainsider/strategies');
  // Pulled here rather than counted in App so the badge costs one shared socket
  // subscription instead of a second one. A command that was queued and has since
  // been claimed is not pending, which is why this reads the queue and not history.
  const { data: jarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks');
  const queuedJarvis = (jarvisTasks?.tasks ?? [])
    .filter(t => String(t.status || '').toUpperCase() === 'QUEUED').length;
  const viewers = useViewers();
  const data: BadgeData = {
    summary,
    queue,
    viewers: viewers.length,
    taskCounts: tasksData?.counts ?? {},
    projects: projectsData?.projects ?? [],
    tasksLoaded: tasksData !== null,
    projectsLoaded: projectsData !== null,
    failedLaunchd: ops?.launchdState?.counts.failed ?? 0,
    staleHosts: fleet?.stale_hosts?.length ?? 0,
    pendingCommands: queuedJarvis,
    fleetHosts: fleet?.hosts?.length ?? 0,
    terminalsTotal: fleet?.terminals?.length ?? 0,
    replay,
    fleet,
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
          const taskCount = data.taskCounts[floor.id] ?? 0;
          const showProjectBadge = floor.id === 'f4' && data.projectsLoaded;
          const showTaskBadge = floor.taskCount && data.tasksLoaded;
          // A failed job is the one nav signal that must never look routine.
          const showFailedBadge = floor.id === 'f16' && data.failedLaunchd > 0;
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
                  {showFailedBadge && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-red/20 text-hud-red" title={`${count} launchd job(s) failed`}>{count}</span>}
                  {showTaskBadge && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber" title={`${taskCount} tasks`}>{taskCount}</span>}
                  {!showProjectBadge && !showTaskBadge && !showFailedBadge && count > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">{count}</span>}
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
        <kbd className="bg-hud-edge px-1.5 py-0.5 rounded mr-1">1</kbd>–<kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">0</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">-</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">=</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">Bksp</kbd> <kbd className="bg-hud-edge px-1.5 py-0.5 rounded ml-1">.</kbd> F1–F4: F13–F16
      </div>
    </nav>
  );
}
