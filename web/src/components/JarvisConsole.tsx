import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useLive, useConnectionStatus, type FleetEvent, type HarnessHealth, type JarvisTask, type JarvisTasksResponse, type OfficeManagerStatus, type ProcessRecord, type ProjectRecord, type QueueSummary, type ServiceHealth, type SessionRecord, type Summary, type VerifyState } from '../api';
import AlphaInsiderPanel from './AlphaInsiderPanel';

function formatClock() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Floor = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12';
type FloorDefinition = { id: Floor; label: string; name: string };
type PolymarketTarget = { id: string; name: string; route: string; hint: string };
type JarvisQuickAction = { id: string; label: string; description: string; prompt: string; target?: string; priority: string };

type JarvisProps = {
  onSelectAgent: (id: string) => void;
  onNavigate: (floor: Floor) => void;
};

type PendingCommand = {
  prompt: string;
  target: string;
  priority: string;
  dangerous: boolean;
};

type CommandResponse = {
  ok?: boolean;
  message?: string;
  error?: { message?: string } | string;
  task?: JarvisTask;
};

const FLOORS: FloorDefinition[] = [
  { id: 'f1', label: 'F1', name: 'Sessions' },
  { id: 'f2', label: 'F2', name: 'Ledger' },
  { id: 'f3', label: 'F3', name: 'Agents' },
  { id: 'f4', label: 'F4', name: 'Projects' },
  { id: 'f5', label: 'F5', name: 'HQ' },
  { id: 'f6', label: 'F6', name: 'Trading Lab' },
  { id: 'f7', label: 'F7', name: 'Strategy Lab' },
  { id: 'f8', label: 'F8', name: 'Live Trading' },
  { id: 'f9', label: 'F9', name: '24x7 Ops' },
  { id: 'f10', label: 'F10', name: 'Knowledge' },
  { id: 'f11', label: 'F11', name: 'Risk' },
  { id: 'f12', label: 'F12', name: 'Graph' },
];

const POLYMARKET_TARGETS: PolymarketTarget[] = [
  { id: 'pm-data', name: 'Market data', route: 'market data intent', hint: 'market, odds, and pricing prompts without signal or risk intent' },
  { id: 'pm-signal', name: 'Signal', route: 'signal intent', hint: 'probability, forecast, and entry or exit prompts' },
  { id: 'pm-risk', name: 'Risk', route: 'risk intent', hint: 'exposure, drawdown, position, and kill prompts' },
];

const QUICK_ACTIONS: JarvisQuickAction[] = [
  { id: 'retry-failed', label: 'Retry failures', description: 'Requeue safe failed tasks', prompt: 'Inspect failed tasks, identify safe retries, and requeue only tasks whose failure is recoverable.', priority: 'high' },
  { id: 'release-stale', label: 'Release stale claims', description: 'Recover expired task leases', prompt: 'Review stale in-progress task claims and release only claims whose heartbeat is expired.', priority: 'high' },
  { id: 'reset-breakers', label: 'Reset breakers', description: 'Route breaker recovery', prompt: 'Inspect unhealthy LLM circuit breakers and reset only breakers that have recovered.', priority: 'high' },
  { id: 'research-run', label: 'Run research', description: 'Start a research cycle', prompt: 'Run the next paper-only strategy research cycle, record metrics, and report the result.', target: 'F7', priority: 'normal' },
  { id: 'fleet-review', label: 'Fleet review', description: 'Ask JEV for a status pass', prompt: 'Review the current fleet status, queue health, stale sessions, and highest-priority follow-up work.', priority: 'normal' },
];

function timeAgo(value: string | number | null | undefined) {
  if (!value) return 'never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function agentForFloor(agents: Summary['agents'], floor: Floor) {
  return agents.find(agent => agent.id.toLowerCase() === floor) ?? null;
}

function statusTone(status: string) {
  if (status === 'busy' || status === 'working') return 'is-busy';
  if (status === 'breaker' || status === 'offline' || status === 'archived') return 'is-alert';
  return 'is-idle';
}

function serviceTone(status: string) {
  return status === 'online' ? 'is-online' : 'is-alert';
}

function isDangerousPrompt(prompt: string) {
  return /\b(delete|remove|destroy|drop|kill|shutdown|stop|restart|rm\s|git\s+reset|force|password|secret|credential|private\s*key|live\s*trade)\b/i.test(prompt);
}

function taskTone(status: string) {
  if (status === 'COMPLETE' || status === 'COMPLETED') return 'is-complete';
  if (status === 'FAILED' || status === 'QUARANTINED') return 'is-failed';
  if (status === 'IN_PROGRESS') return 'is-progress';
  return 'is-queued';
}

export default function JarvisConsole({ onSelectAgent, onNavigate }: JarvisProps) {
  const [filter, setFilter] = useState('');
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState('');
  const [priority, setPriority] = useState('high');
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const [typeConfirmation, setTypeConfirmation] = useState('');
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The event stream is shared app-wide; reuse its state instead of a second connection.
  const streamOnline = useConnectionStatus().state === 'live';
  const [clock, setClock] = useState(() => formatClock());
  useEffect(() => {
    const timer = setInterval(() => setClock(formatClock()), 1000);
    return () => clearInterval(timer);
  }, []);
  const streamState = streamOnline ? 'live' : 'offline';
  const commandInputRef = useRef<HTMLInputElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const { data: summary } = useLive<Summary>('/api/summary');
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  const { data: sessionsData } = useLive<{ sessions: SessionRecord[] }>('/api/sessions');
  const { data: officeManager } = useLive<OfficeManagerStatus>('/api/office-manager');
  const { data: harness } = useLive<HarnessHealth>('/api/harness/health');
  const { data: serviceHealth } = useLive<ServiceHealth>('/api/services/health');
  const { data: verify } = useLive<VerifyState>('/api/verify');
  const { data: processData } = useLive<{ processes: ProcessRecord[] }>('/api/processes');
  const { data: projectData } = useLive<{ projects: ProjectRecord[] }>('/api/projects');
  // Heartbeats outnumber work events ~30:1 in this hive. Requesting the tail
  // unfiltered filled this panel with nothing but heartbeats, so "Recent
  // activity" showed no activity. Heartbeats are still available through
  // /api/events without the exclusion — this asks for what actually happened.
  const { data: eventData } = useLive<{ events: FleetEvent[] }>('/api/events?limit=200&exclude=heartbeat');
  const { data: jarvisData, refresh: refreshJarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks');

  const agents = summary?.agents ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const processes = processData?.processes ?? [];
  const projects = projectData?.projects ?? [];
  const events = eventData?.events ?? [];
  const jarvisTasks = jarvisData?.tasks ?? [];
  const polymarketTaskCount = jarvisTasks.filter(task => task.routing?.domain === 'polymarket' || (task.assigned_agent ?? '').toLowerCase().startsWith('pm-')).length;
  const services = serviceHealth?.services ?? [];
  const busy = agents.filter(agent => agent.display === 'busy').length;
  const idle = agents.filter(agent => agent.display === 'idle').length;
  const offline = agents.filter(agent => agent.display === 'offline').length;
  const freshSessions = sessions.filter(session => session.fresh).length;
  const onlineServices = services.filter(service => service.status === 'online').length;
  const totalCost = agents.reduce((sum, agent) => sum + (agent.usd ?? 0), 0);
  const activeAlerts = [
    queue?.staleInProgress ? `${queue.staleInProgress} stale claims` : null,
    // Gated on a prerequisite. Worth surfacing: it is real work that cannot
    // start, and the reason it is waiting is what a coordinator acts on.
    queue?.blocked ? `${queue.blocked} blocked on dependencies` : null,
    queue?.failedLastHour ? `${queue.failedLastHour} LLM failures this hour` : null,
    harness && !harness.ok ? 'Free harness unavailable' : null,
    officeManager && !officeManager.running ? 'Office Manager session missing' : null,
    verify?.realWorkRatePct != null && verify.realWorkRatePct < 95 ? `Real-work rate ${verify.realWorkRatePct}%` : null,
  ].filter(Boolean) as string[];
  const completionMax = Math.max(...(queue?.completionsByHour.map(item => item.count) ?? [0]), 1);
  const filteredAgents = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter(agent => `${agent.id} ${agent.name} ${agent.role} ${agent.floor ?? ''}`.toLowerCase().includes(query));
  }, [agents, filter]);

  useEffect(() => {
    if (pendingCommand) confirmationInputRef.current?.focus();
  }, [pendingCommand]);

  useEffect(() => {
    if (!pendingCommand) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPendingCommand(null);
        setTypeConfirmation('');
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pendingCommand]);

  const openCommandConfirmation = (event: FormEvent) => {
    event.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      setCommandError('Enter an instruction for JEV before routing it.');
      commandInputRef.current?.focus();
      return;
    }
    setCommandError(null);
    setCommandMessage(null);
    setPendingCommand({ prompt: normalizedPrompt, target, priority, dangerous: isDangerousPrompt(normalizedPrompt) });
    setTypeConfirmation('');
  };

  const submitCommand = async () => {
    if (!pendingCommand || (pendingCommand.dangerous && typeConfirmation !== 'EXECUTE')) return;
    setIsSubmitting(true);
    setCommandError(null);
    try {
      const response = await fetch('/api/jarvis/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: pendingCommand.prompt,
          target: pendingCommand.target || null,
          priority: pendingCommand.priority,
          confirmed: true,
          typeConfirmation: pendingCommand.dangerous ? typeConfirmation : null,
        }),
      });
      const result = await response.json() as CommandResponse;
      if (!response.ok || !result.ok) {
        const message = typeof result.error === 'string' ? result.error : result.error?.message;
        throw new Error(message || 'JEV rejected the command');
      }
      setCommandMessage(result.message || 'Command routed to JEV');
      setPendingCommand(null);
      setPrompt('');
      setTarget('');
      setTypeConfirmation('');
      refreshJarvisTasks();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : 'Unable to route command to JEV');
    } finally {
      setIsSubmitting(false);
    }
  };

  const queueFloorTask = (floor: FloorDefinition, event: MouseEvent) => {
    event.stopPropagation();
    setPrompt(`Review and advance the highest-priority work for ${floor.name}.`);
    setTarget(floor.id.toUpperCase());
    setPriority('high');
    setCommandError(null);
    setCommandMessage(null);
    commandInputRef.current?.focus();
  };

  const openQuickAction = (action: JarvisQuickAction) => {
    setCommandError(null);
    setCommandMessage(null);
    setTypeConfirmation('');
    setPendingCommand({ prompt: action.prompt, target: action.target ?? '', priority: action.priority, dangerous: isDangerousPrompt(action.prompt) });
  };

  return (
    <section className="jarvis-console" aria-label="Jarvis console">
      <header className="jarvis-header">
        <div>
          <div className="jarvis-eyebrow"><span className="jarvis-pulse" /> OPENALICE / OPERATIONS CORE</div>
          <h1>JARVIS <span>CONSOLE</span></h1>
          <p>Interactive command surface routed through the JEV task engine.</p>
        </div>
        <div className="jarvis-header-actions">
          <div className="jarvis-readonly"><span>JEV CONTROL</span><small>CONFIRM BEFORE QUEUE</small></div>
          <div className={`jarvis-runtime ${streamState}`}><span>RUNTIME {streamState === 'live' ? 'LIVE' : streamState.toUpperCase()}</span><small>EVENT STREAM</small></div>
          <div className="jarvis-clock">{clock}</div>
        </div>
      </header>

      <form className="jarvis-commandbar" onSubmit={openCommandConfirmation} aria-label="Route a command to JEV">
        <span className="jarvis-command-prefix" aria-hidden="true">⌁</span>
        <input ref={commandInputRef} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Tell JEV what to do…" aria-label="JEV command" />
        <select value={target} onChange={event => setTarget(event.target.value)} aria-label="Target floor or agent">
          <option value="">JEV auto-route</option>
          {FLOORS.map(floor => <option key={floor.id} value={floor.id.toUpperCase()}>{floor.label} · {floor.name}</option>)}
          <optgroup label="Polymarket">
            {POLYMARKET_TARGETS.map(entry => <option key={entry.id} value={entry.id}>{entry.id} · {entry.name}</option>)}
          </optgroup>
        </select>
        <select value={priority} onChange={event => setPriority(event.target.value)} aria-label="Task priority">
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <button type="submit" className="jarvis-command-submit">Route to JEV <span>↵</span></button>
      </form>
      <div className="jarvis-command-status" aria-live="polite">
        {commandError && <span className="text-alert">{commandError}</span>}
        {commandMessage && <span className="text-green">{commandMessage}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3 mb-1">
        <span className="font-mono text-[10px] text-hud-dim">POLYMARKET ROUTE HINTS</span>
        {POLYMARKET_TARGETS.map(entry => (
          <span
            key={entry.id}
            className={`badge ${target === entry.id ? 'badge-warning' : 'badge-neutral'}`}
            title={entry.hint}
          >
            {entry.id} · {entry.route}
          </span>
        ))}
        <span className="font-mono text-[10px] text-hud-dim">A Polymarket word or a pm- target sends the command to the Polymarket domain; otherwise JEV auto-routes it.</span>
      </div>

      <section className="jarvis-quick-actions" aria-label="JEV quick actions">
        <div className="jarvis-quick-heading"><div><span className="jarvis-kicker">JEV QUICK ACTIONS</span><strong>One click, still confirmed</strong></div><span>Every action enters the same task queue</span></div>
        <div className="jarvis-quick-grid">
          {QUICK_ACTIONS.map(action => <button type="button" className="jarvis-quick-action" key={action.id} onClick={() => openQuickAction(action)}><strong>{action.label}</strong><small>{action.description}</small><span>ROUTE →</span></button>)}
        </div>
      </section>

      <section className="jarvis-metrics" aria-label="Fleet metrics">
        <div className="jarvis-metric"><span>FLEET ONLINE</span><strong>{agents.length || '—'}</strong><small>{busy} working · {idle} standing by</small></div>
        <div className="jarvis-metric"><span>QUEUE PRESSURE</span><strong>{queue?.queued ?? '—'}</strong><small>{queue?.inProgress ?? 0} active claims</small></div>
        <div className="jarvis-metric"><span>SESSION HEALTH</span><strong className={freshSessions ? 'text-green' : 'text-alert'}>{freshSessions || '—'}</strong><small>{offline} offline agents</small></div>
        <div className="jarvis-metric"><span>PORT MESH</span><strong>{onlineServices}/{services.length || '—'}</strong><small>{harness?.ok ? 'harness online' : 'harness checking'}</small></div>
        <div className="jarvis-metric"><span>RUN COST</span><strong>${totalCost.toFixed(2)}</strong><small>{queue?.completionsLastHour ?? 0} completions / hour</small></div>
      </section>

      <div className="jarvis-grid jarvis-grid-main">
        <section className="jarvis-panel jarvis-floor-panel">
           <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">FLOOR CONTROL</span><h2>Agent constellation</h2></div><div className="jarvis-panel-tools"><input className="jarvis-agent-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter floors…" aria-label="Filter floors" /><span className="jarvis-panel-meta">{filteredAgents.length} visible</span></div></div>
          <div className="jarvis-floor-grid">
            {FLOORS.map(floor => {
              const agent = agentForFloor(filteredAgents, floor.id);
              const state = agent?.display ?? 'offline';
              return (
                /* A container that is itself clickable must not also be a
                   button: the inner controls are real buttons, and nesting
                   interactive roles is invalid. The floor name is the
                   activatable element and the actions sit beside it. */
                <div key={floor.id} className={`jarvis-floor ${statusTone(state)} ${filter && !agent ? 'is-dimmed' : ''}`}>
                  <div className="jarvis-floor-top"><span>{floor.label}</span><i /></div>
                  <button
                    type="button"
                    className="jarvis-floor-open-target"
                    onClick={() => onNavigate(floor.id)}
                    aria-label={`Go to ${floor.label} ${floor.name}`}
                  >
                    <strong>{floor.name}</strong>
                    <small>{agent ? agent.status : 'unassigned'}</small>
                  </button>
                  {agent && <button type="button" className="jarvis-floor-open" onClick={() => onSelectAgent(agent.id)} aria-label={`Inspect ${agent.name}`}>↗</button>}
                  <button type="button" className="jarvis-floor-task" onClick={event => queueFloorTask(floor, event)} aria-label={`Queue a JEV task for ${floor.name}`}>QUEUE</button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="jarvis-panel jarvis-attention-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">ATTENTION QUEUE</span><h2>Signals requiring review</h2></div><span className={`jarvis-alert-count ${activeAlerts.length ? 'has-alerts' : ''}`}>{activeAlerts.length}</span></div>
          <div className="jarvis-alert-list">
            {activeAlerts.length ? activeAlerts.map(alert => <div className="jarvis-alert" key={alert}><span>!</span><p>{alert}</p><time>NOW</time></div>) : <div className="jarvis-clear-state"><span>✓</span><p>All systems nominal</p><small>No active operational alerts</small></div>}
          </div>
          <div className="jarvis-panel-footer"><span>VERDICT TALLY</span><strong>{verify?.realWorkRatePct != null ? `${verify.realWorkRatePct}% real work` : 'verification pending'}</strong></div>
        </section>
      </div>

      <section className="jarvis-panel jarvis-jev-panel">
        <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">JEV TASK DISPATCH</span><h2>Command history</h2></div><span className="jarvis-panel-meta">{jarvisTasks.length} routed · {polymarketTaskCount} polymarket</span></div>
        <div className="jarvis-task-list">
          {jarvisTasks.slice(0, 8).map(task => <article className={`jarvis-task ${taskTone(task.status)}`} key={task.task_id}>
            <div className="jarvis-task-top"><span className="jarvis-task-status">{task.status}</span><span>{task.priority}</span><time>{timeAgo(task.updated_at || task.created_at)}</time></div>
            <strong>{task.title}</strong>
            <small>{task.assigned_agent ? `Target ${task.assigned_agent}` : 'Auto-routing'}{task.routing?.resolved_target && task.routing.resolved_target !== task.assigned_agent ? ` · resolved ${task.routing.resolved_target}` : ''}{task.claimed_by ? ` · claimed by ${task.claimed_by}` : ''}</small>
            {task.result && <p>{task.result}</p>}
          </article>)}
          {!jarvisTasks.length && <div className="jarvis-loading">No JEV commands from this console yet.</div>}
        </div>
      </section>

      <AlphaInsiderPanel />

      <div className="jarvis-grid jarvis-grid-secondary">
        <section className="jarvis-panel jarvis-throughput-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">THROUGHPUT</span><h2>Task completion pulse</h2></div><span className="jarvis-panel-meta">last 12 hours</span></div>
          <div className="jarvis-bars">
            {(queue?.completionsByHour ?? []).map(item => <div className="jarvis-bar-column" key={item.hour}><span>{item.count}</span><div className="jarvis-bar-track"><i style={{ height: `${Math.max(5, item.count / completionMax * 100)}%` }} /></div><time>{new Date(item.hour).toLocaleTimeString([], { hour: 'numeric' })}</time></div>)}
            {!queue && <div className="jarvis-loading">Loading task telemetry…</div>}
          </div>
        </section>

        <section className="jarvis-panel jarvis-activity-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">LIVE FEED</span><h2>Recent activity</h2></div><span className="jarvis-panel-meta">{events.length} events</span></div>
          <div className="jarvis-activity-list">
            {events.slice(0, 8).map((event, index) => <div className="jarvis-activity" key={`${event.timestamp ?? 'event'}-${index}`}><span className="jarvis-activity-dot" /><div><strong>{event.type?.replace(/_/g, ' ') ?? 'event'}</strong><small>{event.agent_id ?? event.task_id ?? 'system'} · {timeAgo(event.timestamp)}</small></div></div>)}
            {!events.length && <div className="jarvis-loading">Waiting for events…</div>}
          </div>
        </section>
      </div>

      <div className="jarvis-grid jarvis-grid-tertiary">
        <section className="jarvis-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">SERVICE MESH</span><h2>Process ports</h2></div><span className="jarvis-panel-meta">{processes.length} processes</span></div>
          <div className="jarvis-process-list">
            {services.slice(0, 6).map(service => <div className="jarvis-process" key={service.port}><span className={`jarvis-status-dot ${serviceTone(service.status)}`} /><div><strong>{service.name}</strong><small>:{service.port} · {service.role}</small></div><em className={service.status === 'online' ? 'text-green' : 'text-alert'}>{service.status}</em></div>)}
            {!services.length && <div className="jarvis-loading">Loading service mesh…</div>}
          </div>
        </section>
        <section className="jarvis-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">PROJECT LAYER</span><h2>Active projects</h2></div><span className="jarvis-panel-meta">{projects.length} tracked</span></div>
          <div className="jarvis-project-list">
            {projects.slice(0, 6).map(project => <div className="jarvis-project" key={project.project_id}><div className="jarvis-project-mark">{project.name?.slice(0, 1).toUpperCase() ?? 'P'}</div><div><strong>{project.name ?? project.project_id}</strong><small>{project.status ?? 'UNKNOWN'} · {project.project_id}</small></div><span>→</span></div>)}
            {!projects.length && <div className="jarvis-loading">No project projection available</div>}
          </div>
        </section>
        <section className="jarvis-panel">
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">MODEL RUNTIME</span><h2>Provider health</h2></div><span className="jarvis-panel-meta">fallback ready</span></div>
          <div className="jarvis-provider"><div className="jarvis-provider-orb"><span>◎</span></div><div><strong>{harness?.status ?? 'CHECKING'}</strong><small>{harness?.provider ?? 'free-harness'} · {harness?.model ?? 'auto'}</small></div><span className={harness?.ok ? 'text-green' : 'text-alert'}>{harness?.ok ? 'ONLINE' : 'RETRY'}</span></div>
          <div className="jarvis-provider-list"><span><i className="text-green">●</i> NVIDIA <em>primary</em></span><span><i className="text-blue">●</i> Free Harness <em>fallback</em></span><span><i className="text-alert">●</i> OpenRouter <em>standby</em></span></div>
        </section>
      </div>

      {pendingCommand && <div className="jarvis-modal-backdrop" onClick={() => { if (!isSubmitting) setPendingCommand(null); }}>
        <section className="jarvis-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="jarvis-confirm-title" onClick={event => event.stopPropagation()}>
          <div className="jarvis-panel-heading"><div><span className="jarvis-kicker">JEV CONFIRMATION</span><h2 id="jarvis-confirm-title">Route command to queue?</h2></div><button type="button" className="jarvis-modal-close" onClick={() => setPendingCommand(null)} disabled={isSubmitting} aria-label="Close confirmation">×</button></div>
          <div className="jarvis-confirm-card"><span>OBJECTIVE</span><p>{pendingCommand.prompt}</p><div><span>{pendingCommand.target || 'JEV auto-route'}</span><span>{pendingCommand.priority}</span><span className={pendingCommand.dangerous ? 'text-alert' : 'text-green'}>{pendingCommand.dangerous ? 'DESTRUCTIVE' : 'OPS TASK'}</span></div></div>
          {pendingCommand.dangerous && <label className="jarvis-type-confirm">Type <strong>EXECUTE</strong> to authorize<input ref={confirmationInputRef} value={typeConfirmation} onChange={event => setTypeConfirmation(event.target.value.toUpperCase())} autoComplete="off" /></label>}
          <div className="jarvis-confirm-actions"><button type="button" className="btn btn-ghost" onClick={() => setPendingCommand(null)} disabled={isSubmitting}>Cancel</button><button type="button" className="jarvis-confirm-submit" onClick={submitCommand} disabled={isSubmitting || (pendingCommand.dangerous && typeConfirmation !== 'EXECUTE')}>{isSubmitting ? 'Routing…' : 'Confirm and route'}</button></div>
        </section>
      </div>}

      <footer className="jarvis-footer"><span>JARVIS CONSOLE / PERSONAL OPERATIONS INTERFACE</span><span>{officeManager?.running ? 'OFFICE MANAGER LINKED' : 'OFFICE MANAGER LINK PENDING'} · {timeAgo(officeManager?.lastActivity)}</span></footer>
    </section>
  );
}
