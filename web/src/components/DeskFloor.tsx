import { useLive, type JarvisAuditResponse, type JarvisTasksResponse, type QueueSummary, type TaskRecord, type VerifyState } from '../api';
import type { AutonomyState } from '../live/store';
import CommandCompose from './CommandCompose';
import { claimLabel, dispatchSummary, headroomLine, historyLabel, mayDrawCapacity, verifyTally } from '../deskTruth';
import type { PreviewLike, RateLimitLike } from '../deskTruth';
import { previewJarvisCommand } from '../jarvisPreview';
import { useEffect, useState } from 'react';
import TerminalRenderer from './TerminalRenderer';
import { useTerminal } from '../hooks/useTerminal';
import { TerminalErrorBoundary } from './TerminalErrorBoundary';

/**
 * F17 -- The Desk: what this office has been told, what it is doing, what became of
 * it, and whether this machine is even allowed to say.
 */
export default function DeskFloor() {
  const { data: jarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks');
  const { data: audit } = useLive<JarvisAuditResponse>('/api/jarvis/audit?limit=25');
  const { data: autonomy } = useLive<AutonomyState>('/api/autonomy');
  const { data: board } = useLive<{ rows?: TaskRecord[] }>('/api/task-board');
  const { data: verify } = useLive<VerifyState>('/api/verify');
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  const { data: headroom } = useLive<RateLimitLike>('/api/llm/rate-limits');

  const [capability, setCapability] = useState<PreviewLike | null>(null);
  useEffect(() => {
    let alive = true;
    void previewJarvisCommand({ prompt: 'desk capability probe', priority: 'low' }).then((answer) => {
      if (alive) setCapability(answer);
    });
    return () => { alive = false; };
  }, []);

  const { data: spawned } = useLive<{ terminals?: { id: string; status?: string; type?: string; command?: string; pane_title?: string; session_name?: string; uptime_sec?: number }[] }>('/api/terminals/spawned');
  const terminals = spawned?.terminals ?? [];

  const [attached, setAttached] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);

  const attachedTerminal = terminals.find(t => t.id === attached);
  const writable = Boolean(
    attachedTerminal
    && attachedTerminal.type === 'tmux'
    && (attachedTerminal.status === 'running' || attachedTerminal.status === 'starting'),
  );

  const {
    connected,
    connecting,
    sendInput,
    resize,
  } = useTerminal({
    terminalId: attached,
    onData: undefined,
    onConnectionChange: undefined,
  });

  const dispatch = dispatchSummary(capability);
  const tally = verifyTally(verify);
  const tasks = jarvisTasks?.tasks ?? [];
  const proposals = autonomy?.proposals ?? [];
  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const rows = board?.rows ?? [];
  const inFlight = rows.filter(r => r.claimed_by || r.status === 'IN_PROGRESS' || r.status === 'CLAIMED');

  return (
    <div className="floor desk-floor">
      <div className="floor-header">
        <h2>The Desk</h2>
        <span className="floor-sub">what this office was told, what it is doing, and whether that record can be believed</span>
      </div>

      {/* ---------- dispatch capability: stated before anything else ---------- */}
      <section className={`panel desk-capability ${dispatch.available ? 'is-available' : 'is-blocked'}`}>
        <div className="panel-head">
          <h3>{dispatch.label}</h3>
          {dispatch.host && <span className="badge badge-neutral">{dispatch.host}</span>}
        </div>
        {dispatch.available ? (
          <p className="panel-note">
            This machine may queue work for the office. The gate accepts a loopback socket, so a
            browser here and an SSH port-forward here are treated identically -- which means anyone
            who can reach this port can dispatch.
          </p>
        ) : (
          <p className="panel-note text-alert">{dispatch.reason}</p>
        )}
        <CommandCompose
          priority="normal"
          placeholder="Give the office an instruction…"
          submitLabel="Route it"
          className="desk-compose"
          onQueued={() => undefined}
          onError={() => undefined}
          onPreview={setCapability}
        />
      </section>

      {/* ---------- pending ---------- */}
      <section className="panel">
        <div className="panel-head">
          <h3>Pending</h3>
          <span className="badge badge-neutral">{tasks.length + pendingProposals.length}</span>
        </div>
        {tasks.length === 0 && pendingProposals.length === 0 ? (
          <p className="panel-note">
            Nothing queued. That is an absence of work, not a sign the office is healthy -- the
            record of past commands is below, and it has its own caveat.
          </p>
        ) : (
          <table className="desk-table">
            <tbody>
              {pendingProposals.map(p => (
                <tr key={p.id}>
                  <td className="desk-kind">proposal</td>
                  <td>{p.prompt || p.id}</td>
                  <td className="desk-meta">{p.requestedAgents ?? 1} agent(s)</td>
                  <td className="desk-meta">pending</td>
                </tr>
              ))}
              {tasks.map(t => (
                <tr key={t.task_id}>
                  <td className="desk-kind">{t.risk === 'destructive' ? 'destructive' : 'ops task'}</td>
                  <td>{t.objective || t.title}</td>
                  <td className="desk-meta">{t.assigned_agent || 'JEV auto-route'}</td>
                  <td className="desk-meta">{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------- in flight ---------- */}
      <section className="panel">
        <div className="panel-head">
          <h3>In flight</h3>
          <span className="badge badge-neutral">{inFlight.length}</span>
        </div>
        {inFlight.length === 0 ? (
          <div className="desk-follow">
            {terminals.length === 0 ? (
              <p className="panel-note">No task reports a claim, and this HUD has started no terminals -- so there is no output to attach to.</p>
            ) : (
              <>
                <div className="flex gap-2 items-center mb-2">
                  <select
                    className="input"
                    value={attached ?? ''}
                    onChange={e => setAttached(e.target.value || null)}
                  >
                    <option value="">Choose a terminal to read…</option>
                    {terminals.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                        {t.session_name && ` (${t.session_name})`}
                        {t.pane_title && ` — ${t.pane_title}`}
                        {t.status ? ` — ${t.status}` : ''}
                        {t.uptime_sec && ` — ${Math.floor(t.uptime_sec / 60)}m`}
                      </option>
                    ))}
                  </select>
                  {attached && (
                    <span className={`badge ${connected ? 'badge-success' : 'badge-warning'}`}>
                      {connecting ? 'connecting…' : connected ? 'connected' : 'disconnected'}
                    </span>
                  )}
                </div>

                {attached && writable && (
                  <form
                    className="flex gap-2 items-center mb-2"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const text = draft.trim();
                      if (!text || !attached) return;
                      setSending(true);
                      setSendNote(null);
                      try {
                        const ok = await sendInput(text);
                        if (ok) setDraft('');
                        else setSendNote('Failed to send input');
                      } catch (error: any) {
                        setSendNote(String(error?.message || error));
                      } finally {
                        setSending(false);
                      }
                    }}
                  >
                    <input
                      className="input flex-1"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      placeholder="Type a command and press Enter…"
                      aria-label="Send input to the attached terminal"
                      disabled={sending || !connected}
                    />
                    <button className="btn" type="submit" disabled={sending || !draft.trim() || !connected}>
                      {sending ? 'Sending…' : 'Send'}
                    </button>
                  </form>
                )}

                {attached && !writable && (
                  <p className="panel-note mb-2">
                    This terminal is read-only: only a running tmux terminal accepts typed input. Spawn one to drive it.
                  </p>
                )}

                {sendNote && <p className="panel-note text-alert mb-2">{sendNote}</p>}

                <div className="flex items-center gap-2 mb-2">
                  {connected && (
                    <span className="badge badge-success text-xs">● LIVE</span>
                  )}
                  {!connected && connecting && (
                    <span className="badge badge-warning text-xs">⟳ RECONNECTING…</span>
                  )}
                  {!connected && !connecting && attached && (
                    <span className="badge badge-error text-xs">✕ DISCONNECTED</span>
                  )}
                </div>

                <TerminalErrorBoundary
                  fallback={
                    <div className="panel p-4 text-center text-hud-red">
                      Terminal renderer crashed. Check console for details.
                    </div>
                  }
                >
                  <TerminalRenderer
                    onData={undefined}
                    onResize={(cols, rows) => resize(cols, rows)}
                  />
                </TerminalErrorBoundary>
              </>
            )}
          </div>
        ) : (
          <table className="desk-table">
            <tbody>
              {inFlight.map(row => {
                const claim = claimLabel(row);
                return (
                  <tr key={row.task_id}>
                    <td className="desk-kind">{row.assigned_agent || 'unassigned'}</td>
                    <td>{row.title || row.task_id}</td>
                    <td className={`desk-meta desk-claim-${claim.tone}`}>{claim.text}</td>
                    <td className="desk-meta">{row.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {queue && (
          <p className="panel-note">
            Queue window: {queue.queued ?? '?'} queued, {queue.inProgress ?? '?'} in progress.
          </p>
        )}
      </section>

      {/* ---------- headroom ---------- */}
      <section className="panel">
        <div className="panel-head">
          <h3>Headroom</h3>
          {mayDrawCapacity(headroom)
            ? <span className="badge badge-success">{headroom?.headroom} available</span>
            : <span className="badge badge-neutral">not measured</span>}
        </div>
        <p className="panel-note">{headroomLine(headroom)}</p>
      </section>

      {/* ---------- outcomes ---------- */}
      <section className="panel">
        <div className="panel-head">
          <h3>Outcomes</h3>
          <span className="badge badge-neutral">{tally.total}</span>
        </div>
        <p className="panel-note">{tally.label}</p>
        <div className="panel-head desk-history-head">
          <h4>Command history</h4>
          {audit?.checkedAt && <span className="badge badge-neutral">checked {audit.checkedAt}</span>}
        </div>
        <p className="panel-note">{historyLabel(audit)}</p>
        {(audit?.events?.length ?? 0) > 0 && (
          <table className="desk-table">
            <tbody>
              {audit!.events.slice(0, 10).map((e, i) => (
                <tr key={`${e.task_id ?? 'evt'}-${e.timestamp ?? i}`}>
                  <td className="desk-kind">{e.risk}</td>
                  <td>{e.task_id ?? 'no task id'}</td>
                  <td className="desk-meta">{e.target || 'auto-route'}</td>
                  <td className="desk-meta">{e.timestamp ?? 'no timestamp'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
