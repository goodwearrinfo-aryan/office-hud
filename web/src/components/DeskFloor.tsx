import { useLive, type JarvisAuditResponse, type JarvisTasksResponse, type QueueSummary, type TaskRecord, type VerifyState } from '../api';
import type { AutonomyState } from '../live/store';
import CommandCompose from './CommandCompose';
import { claimLabel, dispatchSummary, historyLabel, verifyTally } from '../deskTruth';
import type { PreviewLike } from '../deskTruth';
import { previewJarvisCommand } from '../jarvisPreview';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_MODEL, emptyStateText, parseFrame, reduce, type FollowModel } from '../terminalFollow';

/**
 * F18 — The Desk: what this office has been told, what it is doing, what became of
 * it, and whether this machine is even allowed to say.
 *
 * WHY THIS FLOOR IS A FLOOR AND NOT A PANEL
 * -----------------------------------------
 * Everything here already had a home. /api/jarvis/tasks is drawn in the Jarvis
 * console, /api/verify in the God panel, /api/task-board on F16. What did not exist
 * anywhere is the office's own account of ITSELF: what it was told, and whether
 * that record can be believed.
 *
 * The self-account is the part that lies. Measured off the live audit while
 * building this: `status: "ok"`, `count: 0`, `scanned: 375`, and a window that had
 * read 524288 bytes of a 15755023-byte log with `truncated: true`. So "no commands"
 * was true inside the window and said nothing about the file — and `ok: true` is
 * exactly the kind of green an operator stops reading. This floor therefore states
 * the window every time it reports an absence, and never reports one without a
 * completed read behind it. See web/src/deskTruth.ts.
 *
 * Truth rules
 * -----------
 * - An empty queue is "nothing queued", not "healthy" and not "nothing happened".
 * - The history line is the server's own read outcome, quoted, not summarised.
 * - Verdict counts always carry their denominator. 631 of 631 is a different claim
 *   from 631 OK, and only one of them is true.
 * - Dispatch state is reported with its reason. A bare "READ ONLY" does not tell an
 *   operator whether the block is topology, a missing queue, or their own typing.
 * - The dispatch banner names the path it went through, because an SSH port-forward
 *   is loopback and therefore local. Measured, not assumed: the gate cannot tell a
 *   local browser from a forwarded request.
 *
 * What it does not do: claim a terminal is running, invent an owner, or write
 * anything except through the one shared compose.
 */
export default function DeskFloor() {
  const { data: jarvisTasks } = useLive<JarvisTasksResponse>('/api/jarvis/tasks');
  const { data: audit } = useLive<JarvisAuditResponse>('/api/jarvis/audit?limit=25');
  const { data: autonomy } = useLive<AutonomyState>('/api/autonomy');
  // Typed as TaskRecord, the shape /api/task-board's rows actually have. The
  // board is pre-grouped server-side to keep this payload at 28KB instead of the
  // 3.8MB tasks.json it replaced, so the rows carry TaskRecord and not a wider type.
  const { data: board } = useLive<{ rows?: TaskRecord[] }>('/api/task-board');
  const { data: verify } = useLive<VerifyState>('/api/verify');
  const { data: queue } = useLive<QueueSummary>('/api/queue');

  // One judgement, reused for the banner. It asks about a throwaway prompt because
  // the endpoint judges fields and dispatch together; the prompt is never sent, and
  // the preview route is proven by test to write nothing.
  const [capability, setCapability] = useState<PreviewLike | null>(null);
  useEffect(() => {
    let alive = true;
    void previewJarvisCommand({ prompt: 'desk capability probe', priority: 'low' }).then((answer) => {
      if (alive) setCapability(answer);
    });
    return () => { alive = false; };
  }, []);

  // The follow pane. Read-only by construction: it opens the SSE stream, never
  // POSTs a key, and calls itself a reader rather than a terminal.
  const { data: spawned } = useLive<{ terminals?: { id: string; status?: string }[] }>('/api/terminals/spawned');
  const terminals = spawned?.terminals ?? [];
  const [attached, setAttached] = useState<string | null>(null);
  const [model, setModel] = useState<FollowModel>(EMPTY_MODEL);
  const stream = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!attached) { setModel(EMPTY_MODEL); return undefined; }
    setModel({ ...EMPTY_MODEL, state: 'connecting' });
    const source = new EventSource(`/api/terminals/${encodeURIComponent(attached)}/follow`);
    stream.current = source;
    const onMessage = (event: MessageEvent) => {
      setModel(previous => reduce(previous, parseFrame(String(event.data ? `data: ${event.data}` : ''))));
    };
    source.addEventListener('hello', onMessage);
    source.addEventListener('log', onMessage);
    source.addEventListener('output', onMessage);
    source.onmessage = onMessage;
    source.onerror = () => setModel(previous => ({ ...previous, state: 'reconnecting' }));
    return () => { source.close(); stream.current = null; };
  }, [attached]);

  const empty = useMemo(() => emptyStateText(model, terminals.length), [model, terminals.length]);

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
            browser here and an SSH port-forward here are treated identically — which means anyone
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
            Nothing queued. That is an absence of work, not a sign the office is healthy — the
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
              <p className="panel-note">No task reports a claim, and this HUD has started no terminals — so there is no output to attach to.</p>
            ) : (
              <>
                <div className="flex gap-2 items-center">
                  <select className="input" value={attached ?? ''} onChange={e => setAttached(e.target.value || null)}>
                    <option value="">Choose a terminal to read…</option>
                    {terminals.map(t => <option key={t.id} value={t.id}>{t.id}{t.status ? ` — ${t.status}` : ''}</option>)}
                  </select>
                  {attached && <span className="badge badge-neutral">read-only</span>}
                </div>
                {model.dropped > 0 && <p className="panel-note">{model.dropped} earlier lines dropped to keep the buffer bounded.</p>}
                {model.note && <p className="panel-note text-alert">{model.note}</p>}
                {empty && <p className="panel-note">{empty}</p>}
                {model.lines.length > 0 && (
                  <pre className="desk-follow-log">{model.lines.map(line => `${line.text}\n`)}</pre>
                )}
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