import type { CapFleetVerdict, CostVerdict } from '../costTruthTypes';
import { useLive, type HarnessHealth, type OfficeManagerStatus, type QueueSummary, type SessionRecord, type Summary } from '../api';

function timeAgo(value: string | null) {
  if (!value) return 'never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ExecutiveHQ() {
  const { data: summary } = useLive<Summary>('/api/summary');
  const { data: queue } = useLive<QueueSummary>('/api/queue');
  const { data: sessionsData } = useLive<{ sessions: SessionRecord[] }>('/api/sessions');
  const { data: officeManager } = useLive<OfficeManagerStatus>('/api/office-manager');
  const { data: harness } = useLive<HarnessHealth>('/api/harness/health');
  // Cost truth comes from the server, which computes it from the records. Measured on
  // the live mini: 58 agents all reporting usd 0, and all 27 cost records carrying null
  // token counts -- which the hive's cost lib multiplies into a zero. So the total is a
  // silence, and `may_show_zero` is the difference between $0.00 as a measurement and
  // $0.00 as a lie.
  const { data: costs } = useLive<{ verdict?: CostVerdict | null; cost_label?: string | null; may_show_zero?: boolean; cap?: CapFleetVerdict | null }>('/api/llm/costs');
  const showCostFigure = costs?.may_show_zero === true;
  const agents = summary?.agents ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const liveAgents = agents.filter(agent => agent.display === 'busy' || agent.display === 'idle');
  const healthySessions = sessions.filter(session => session.fresh).length;
  const totalCost = agents.reduce((sum, agent) => sum + (agent.usd ?? 0), 0);
  // Ranked by MEASURED spend from the records, not by `usd`, which is 0 for every
  // agent on this hive. Sorting that would produce an arbitrary order and drawing bars
  // for it would look like a cost ranking that was measured.
  const topAgents = showCostFigure
    ? [...agents].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).slice(0, 8)
    : [];
  const maxCost = Math.max(...topAgents.map(agent => agent.usd ?? 0), 0.01);
  const completionMax = Math.max(...(queue?.completionsByHour.map(item => item.count) ?? [0]), 1);
  const alerts = [
    queue?.staleInProgress ? `${queue.staleInProgress} stale task claims` : null,
    queue?.failedLastHour ? `${queue.failedLastHour} failed LLM completions this hour` : null,
    // Unverified completions are the number an operator needs in order to
    // distrust a completion rate. A COMPLETE status is a claim, not proof, and
    // `complete` above counts claims.
    queue && queue.unverifiedComplete
      ? `${queue.unverifiedComplete} completion(s) recorded with no durable evidence`
      : null,
    queue?.blocked ? `${queue.blocked} task(s) blocked on an unmet dependency` : null,
    harness && !harness.ok ? `Free harness offline: ${harness.error ?? 'health check failed'}` : null,
    officeManager && !officeManager.running ? 'Office Manager has no live session' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F5 · EXECUTIVE HQ</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">LIVE AGENTS</div>
          <div className="text-3xl font-mono font-bold text-hud-text">{liveAgents.length}</div>
          <div className="text-xs text-hud-dim">{agents.filter(agent => agent.display === 'busy').length} busy · {queue?.inProgress ?? 0} tasks in progress</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">TASK QUEUE</div>
          <div className="text-3xl font-mono font-bold text-hud-blue">{queue?.queued ?? 0}</div>
          {/*
            `complete` is the raw count of tasks whose status says COMPLETE, which
            is a claim by the executor rather than proof of work. `verified` is
            the subset with durable recorded output, so it is the only one of the
            two that means "done". Both are shown because hiding either is how a
            56% headline turns out to be a third of the work quarantined.
          */}
          <div className="text-xs text-hud-dim">
            {queue?.inProgress ?? 0} in progress · {queue?.complete ?? 0} claimed complete
          </div>
          <div className="text-xs text-hud-dim">
            <span className="text-hud-green">{queue?.verifiedComplete ?? 0} verified</span>
            {queue?.unverifiedComplete
              ? ` · ${queue.unverifiedComplete} unverified`
              : ''}
          </div>
          {queue?.quarantined ? (
            <div className="text-xs text-hud-red">{queue.quarantined} quarantined</div>
          ) : null}
          {queue?.blocked ? (
            <div className="text-xs text-hud-amber">{queue.blocked} blocked</div>
          ) : null}
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">SESSIONS</div>
          <div className={`text-3xl font-mono font-bold ${healthySessions ? 'text-hud-green' : 'text-hud-red'}`}>{healthySessions}</div>
          <div className="text-xs text-hud-dim">{sessions.length - healthySessions} stale · 5m threshold</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">OFFICE MANAGER</div>
          <div className={`text-2xl font-mono font-bold ${officeManager?.running ? 'text-hud-green' : 'text-hud-red'}`}>{officeManager?.running ? 'RUNNING' : 'OFFLINE'}</div>
          <div className="text-xs text-hud-dim">last activity {timeAgo(officeManager?.lastActivity ?? null)}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">FREE HARNESS</div>
          <div className={`text-2xl font-mono font-bold ${harness?.ok ? 'text-hud-green' : 'text-hud-red'}`}>{harness?.status ?? 'CHECKING'}</div>
          <div className="text-xs text-hud-dim truncate">{harness?.provider ?? '—'} · {harness?.model ?? '—'}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">SPENDING CAP</div>
          {/* Rendered next to the total because a spend without a ceiling is not a
              budget. NO CAP is its own state and is deliberately not green: the cap
              check runs on every LLM request upstream and, with no agent setting a
              limit, cannot fire for any of them. */}
          {costs?.cap?.verdict === 'exceeded' ? (
            <div className="text-2xl font-mono font-bold text-hud-red">EXCEEDED</div>
          ) : costs?.cap?.verdict === 'within' ? (
            <div className="text-2xl font-mono font-bold text-hud-green">WITHIN CAP</div>
          ) : costs?.cap?.verdict === 'unknown' ? (
            <div className="text-2xl font-mono font-bold text-hud-amber">CAP UNKNOWN</div>
          ) : (
            <div className="text-2xl font-mono font-bold text-hud-amber">NO CAP SET</div>
          )}
          <div className="text-xs text-hud-dim">
            {costs?.cap
              ? `${costs.cap.with_cap} of ${costs.cap.agents} agents capped`
              : 'Cap state not reported.'}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs text-hud-dim">TOTAL COST</div>
          {showCostFigure ? (
            <div className="text-3xl font-mono font-bold text-hud-amber">${totalCost.toFixed(2)}</div>
          ) : (
            <div className="text-2xl font-mono font-bold text-hud-amber">NOT MEASURED</div>
          )}
          <div className="text-xs text-hud-dim">
            {showCostFigure
              ? `${queue?.completionsLastHour ?? 0} completions this hour`
              : (costs?.cost_label ?? 'Cost has not been reported.')}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-mono text-hud-amber text-sm">COMPLETIONS · LAST 12 HOURS</h3>
            <span className="text-[10px] font-mono text-hud-dim">{queue?.failedLastHour ?? 0} failed this hour</span>
          </div>
          <div className="h-40 flex items-end gap-2">
            {(queue?.completionsByHour ?? []).map(item => (
              <div key={item.hour} className="flex-1 min-w-0 flex flex-col items-center gap-1">
                <span className="text-[9px] font-mono text-hud-dim">{item.count}</span>
                <div className="w-full bg-hud-blue/70 rounded-t" style={{ height: `${Math.max(4, item.count / completionMax * 110)}px` }} />
                <span className="text-[8px] font-mono text-hud-dim truncate w-full text-center">{new Date(item.hour).toLocaleTimeString([], { hour: 'numeric' })}</span>
              </div>
            ))}
            {!queue && <div className="w-full text-center text-hud-dim text-sm">Loading queue history…</div>}
          </div>
        </div>

        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">SYSTEM ALERTS</h3>
          <div className="space-y-2">
            {alerts.length > 0 ? alerts.map(alert => (
              <div key={alert} className="panel-surface p-3 text-sm text-hud-amber flex items-start gap-2">
                <span className="text-hud-red mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" />
                <span>{alert}</span>
              </div>
            )) : (
              <div className="panel-surface p-3 text-sm text-hud-green">No active alerts</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel p-4 mt-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">TOP AGENTS BY COST</h3>
        <div className="space-y-2">
          {topAgents.map(agent => (
            <div key={agent.id} className="grid grid-cols-[150px_1fr_80px] items-center gap-3">
              <span className="font-mono text-xs truncate">{agent.name}</span>
              <div className="h-2 rounded bg-hud-edge overflow-hidden"><div className="h-full bg-hud-amber" style={{ width: `${(agent.usd ?? 0) / maxCost * 100}%` }} /></div>
              <span className="text-right font-mono text-xs text-hud-amber">${(agent.usd ?? 0).toFixed(2)}</span>
            </div>
          ))}
          {topAgents.length === 0 && (
            <div className="text-hud-dim text-xs text-center py-4">
              {showCostFigure ? 'No agents registered' : 'No per-agent ranking: no call has reported a usable cost.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
