import { useLive, type Summary } from '../api';

type AgentDetail = {
  agent?: AgentFields;
  identity?: string;
  memory?: string;
  inbox?: unknown[];
  outbox?: unknown[];
  sessions?: Array<{ session_id?: string; fresh?: boolean; heartbeat_age_sec?: number | null }>;
};

type AgentFields = {
  id?: string;
  name?: string;
  role?: string;
  floor?: string | null;
  provider?: string | null;
  model?: string | null;
  cwd?: string | null;
  status?: string | null;
  display?: string;
  breaker?: string;
  evidence?: {
    hasSession?: boolean;
    sessionFresh?: boolean;
    hasTask?: boolean;
    taskStatus?: string | null;
    heartbeatAgeSec?: number | null;
    processId?: number | null;
    processVerified?: boolean;
    processLiveness?: 'alive' | 'dead' | null;
  };
  sessionId?: string | null;
  sessionStatus?: string | null;
  processId?: number | null;
  heartbeatAgeSec?: number | null;
  sessionFresh?: boolean;
  currentTaskId?: string | null;
  currentTaskTitle?: string | null;
  lastTool?: string | null;
  lastActiveSecAgo?: number | null;
  inboxBacklog?: number | null;
  usd?: number;
  tokens?: number;
  cwdValid?: boolean;
};

/**

/**
 * God is the executive control layer, so it gets a dedicated panel rather than
 * a row in a list. Every field here is rendered from real runtime data, and a
 * field with no evidence is printed as NOT AVAILABLE -- never as a plausible
 * default. Process state is rendered from the server's own liveness check, so
 * "alive", "dead" and "no pid" stay distinct instead of collapsing into one
 * "not verified" that reads as a problem when nothing is wrong.
 */
function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-hud-edge/40 last:border-0">
      <span className="text-[10px] font-mono text-hud-dim shrink-0">{label}</span>
      <span className={`text-[11px] font-mono truncate ${tone || 'text-hud-text'}`} title={value}>{value}</span>
    </div>
  );
}

const NA = 'NOT AVAILABLE';

function orNa(value: string | null | undefined): string {
  return value == null || value === '' ? NA : value;
}

export default function GodPanel() {
  const { data: summary } = useLive<Summary>('/api/summary');
  const godId = summary?.agents?.find(a => a.isGod)?.id ?? 'god';
  const { data: detail, error } = useLive<AgentDetail>(`/api/agents/${godId}`);

  const g = detail?.agent;
  // Real counts only. An absent list is reported as such rather than as 0,
  // because 0 and "we have no data" are different claims.
  const inboxCount = detail?.inbox == null ? null : detail.inbox.length;
  const outboxCount = detail?.outbox == null ? null : detail.outbox.length;
  const sessionCount = detail?.sessions == null ? null : detail.sessions.length;
  const freshSessions = (detail?.sessions ?? []).filter(s => s.fresh).length;

  if (error) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-2">GOD</h3>
        <div className="text-hud-red text-xs">God detail unavailable: {String(error)}</div>
      </div>
    );
  }
  if (!g) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-2">GOD</h3>
        <div className="text-hud-dim text-xs">{NA} -- no God agent is registered in this hive</div>
      </div>
    );
  }

  const ev = g.evidence ?? {};
  const heartbeat = g.heartbeatAgeSec;
  const heartbeatText = heartbeat == null
    ? NA
    : heartbeat < 60 ? `${heartbeat}s ago` : heartbeat < 3600 ? `${Math.round(heartbeat / 60)}m ago` : `${Math.round(heartbeat / 3600)}h ago`;

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-mono text-hud-amber text-sm">
          GOD · {g.name ?? g.id}
        </h3>
        <span className="badge badge-warning">{g.display ?? NA}</span>
      </div>

      <div className="text-[10px] font-mono text-hud-dim mb-2">{g.role ?? NA}</div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
        <div>
          <Row label="STATUS" value={orNa(g.status)} tone={g.display === 'busy' ? 'text-hud-green' : undefined} />
          <Row label="BREAKER" value={orNa(g.breaker)} tone={g.breaker === 'healthy' ? 'text-hud-green' : 'text-hud-red'} />
          <Row label="SESSION" value={orNa(g.sessionId)} />
          <Row label="SESSION STATUS" value={orNa(g.sessionStatus)} />
          <Row label="HEARTBEAT" value={heartbeatText} tone={ev.sessionFresh ? 'text-hud-green' : 'text-hud-red'} />
        </div>
        <div>
          <Row label="PID" value={orNa(g.processId?.toString())} />
          <Row
            label="PROCESS"
            value={g.processId == null
              ? NA
              : ev.processVerified
                ? `alive (pid ${g.processId})`
                : ev.processLiveness === 'dead'
                  ? `DEAD (pid ${g.processId})`
                  : `reported (pid ${g.processId}), not verified`}
            tone={ev.processVerified ? 'text-hud-green' : ev.processLiveness === 'dead' ? 'text-hud-red' : 'text-hud-dim'}
          />
          <Row label="PROVIDER" value={orNa(g.provider)} />
          <Row label="MODEL" value={orNa(g.model)} />
          <Row label="CURRENT TASK" value={g.currentTaskId ? `${g.currentTaskId}${g.currentTaskTitle ? ` -- ${g.currentTaskTitle}` : ''}` : 'none claimed'} />
        </div>
      </div>

      <div className="mt-3 pt-2 border-t border-hud-edge/60">
        <div className="text-[10px] font-mono text-hud-dim mb-1">EVIDENCE FOR THE LABEL ABOVE</div>
        <div className="flex flex-wrap gap-2 text-[10px] font-mono">
          <span className={ev.hasSession ? 'text-hud-green' : 'text-hud-dim'}>
            session={ev.hasSession ? 'present' : NA}
          </span>
          <span className={ev.sessionFresh ? 'text-hud-green' : 'text-hud-dim'}>
            fresh={ev.sessionFresh ? 'yes' : 'no'}
          </span>
          <span className={ev.hasTask ? 'text-hud-green' : 'text-hud-dim'}>
            task={ev.hasTask ? orNa(ev.taskStatus) : 'none'}
          </span>
          <span className="text-hud-dim">
            work inferred from heartbeat only when a task is claimed
          </span>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">INBOX / OUTBOX</div>
          <div className="font-mono text-sm">
            {inboxCount == null ? NA : inboxCount} / {outboxCount == null ? NA : outboxCount}
          </div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">SESSIONS</div>
          <div className="font-mono text-sm">
            {sessionCount == null ? NA : `${sessionCount} (${freshSessions} fresh)`}
          </div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">LAST TOOL</div>
          <div className="font-mono text-sm">{orNa(g.lastTool)}</div>
        </div>
        <div className="panel-surface px-3 py-2">
          <div className="text-[10px] font-mono text-hud-dim">COST</div>
          <div className="font-mono text-sm">{g.usd == null ? NA : `$${(g.usd).toFixed(2)}`}</div>
        </div>
      </div>

      <div className="mt-2 text-[10px] font-mono text-hud-dim truncate" title={g.cwd ?? ''}>
        CWD {g.cwd ? `${g.cwd}${g.cwdValid === false ? ' (INVALID)' : ''}` : NA}
      </div>
    </div>
  );
}
