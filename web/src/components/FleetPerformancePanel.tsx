import { useLive } from '../api';

/**
 * Types are local to this panel so it adds nothing to ../api, which other
 * sessions edit.
 *
 * NOTE ON THE NUMBERS: quarantined tasks get their own column and are never
 * folded into the completion rate. On the current hive roughly a third of all
 * tasks are quarantined, and averaging that into "completion" would report a
 * comfortable ~56% for a fleet that is in fact failing a third of what it
 * touches. If you find yourself wanting to merge those two numbers, that is the
 * reason this is shaped this way.
 */

interface FleetAgentRow {
  agentId: string;
  assigned: number;
  complete: number;
  quarantined: number;
  inProgress: number;
  completionRate: number | null;
  quarantineRate: number | null;
  lastActivityAt: string | null;
  sessions: { healthy: number; stale: number };
}

interface FleetPerformance {
  generatedAt: string;
  tasks: {
    total: number;
    complete: number;
    quarantined: number;
    inProgress: number;
    preserved: number;
    queued: number;
    completionRate: number | null;
    quarantineRate: number | null;
  };
  sessions: { total: number; healthy: number; stale: number; staleRate: number | null };
  cost: { records: number; pricedRecords: number; unpricedRecords: number; totalUsd: number };
  agents: FleetAgentRow[];
}

const numberFmt = new Intl.NumberFormat();

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Proportional bar. `invert` tints by how BAD the number is, not how good. */
function RateBar({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  const width = value === null || value === undefined ? 0 : Math.round(value * 100);
  const tone = invert
    ? (value !== null && value > 0.25 ? 'bg-hud-red' : 'bg-hud-green')
    : (value !== null && value < 0.5 ? 'bg-hud-amber' : 'bg-hud-green');
  return (
    <span className="block h-1.5 bg-hud-surface rounded-full overflow-hidden">
      <span className={`block h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} />
    </span>
  );
}

export default function FleetPerformancePanel() {
  const { data, loading, error, refresh } = useLive<FleetPerformance>('/api/fleet/performance');

  if (loading && !data) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLEET PERFORMANCE</h3>
        <p className="text-hud-dim text-sm">Reading…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLEET PERFORMANCE</h3>
        <p className="text-hud-red text-sm">Unavailable: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { tasks, sessions, cost, agents } = data;
  const worst = agents.filter((a) => (a.quarantineRate ?? 0) > 0.25).slice(0, 8);

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-hud-amber text-sm">FLEET PERFORMANCE</h3>
        <button type="button" className="badge badge-neutral cursor-pointer" onClick={() => { void refresh(); }}>
          REFRESH
        </button>
      </div>

      <p className="text-hud-dim text-xs mb-3">
        Rolled up from the hive {ago(data.generatedAt)}. Read-only — nothing here changes fleet state.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 mb-3">
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">tasks</div>
          <div className="text-lg">{numberFmt.format(tasks.total)}</div>
        </div>
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">complete</div>
          <div className="text-lg">
            {numberFmt.format(tasks.complete)}{' '}
            <span className="text-xs text-hud-dim">{pct(tasks.completionRate)}</span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">quarantined</div>
          <div className="text-lg text-hud-red">
            {numberFmt.format(tasks.quarantined)}{' '}
            <span className="text-xs">{pct(tasks.quarantineRate)}</span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">in progress</div>
          <div className="text-lg">{numberFmt.format(tasks.inProgress)}</div>
        </div>
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">sessions stale</div>
          <div className="text-lg">
            {numberFmt.format(sessions.stale)}{' '}
            <span className="text-xs text-hud-dim">{pct(sessions.staleRate)}</span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-hud-dim text-xs">spend</div>
          <div className="text-lg">
            ${cost.totalUsd.toFixed(2)}
            {cost.unpricedRecords > 0 && (
              <span className="text-xs text-hud-dim block">{cost.unpricedRecords} unpriced</span>
            )}
          </div>
        </div>
      </div>

      {tasks.quarantineRate !== null && tasks.quarantineRate > 0.2 && (
        <p className="panel p-3 mb-3 text-sm border-l-2 border-hud-red">
          <span className="text-hud-red">{pct(tasks.quarantineRate)}</span> of all tasks are
          quarantined. That is counted separately from completion on purpose — it is not part of the{' '}
          {pct(tasks.completionRate)} completion rate above.
        </p>
      )}

      <div className="text-hud-dim text-xs mb-2">AGENTS ({agents.length})</div>
      <div className="space-y-1 mb-3">
        {agents.slice(0, 15).map((agent) => (
          <div key={agent.agentId} className="panel p-2">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-mono">{agent.agentId}</span>
              <span className="text-hud-dim">
                {numberFmt.format(agent.assigned)} tasks · {numberFmt.format(agent.complete)} done
                {agent.quarantined > 0 && (
                  <span className="text-hud-red"> · {numberFmt.format(agent.quarantined)} quar</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <RateBar value={agent.quarantineRate} invert />
              <span className="text-hud-dim text-xs whitespace-nowrap">
                {pct(agent.quarantineRate)} quar · {agent.sessions.healthy}ok/{agent.sessions.stale}stale
              </span>
            </div>
          </div>
        ))}
      </div>
      {agents.length > 15 && (
        <p className="text-hud-dim text-xs mb-3">
          Showing the 15 busiest of {agents.length} agents with recorded tasks.
        </p>
      )}

      {worst.length > 0 && (
        <>
          <div className="text-hud-dim text-xs mb-2">HIGHEST QUARANTINE RATES</div>
          <div className="space-y-1 mb-2">
            {worst.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between text-xs">
                <span className="font-mono">{agent.agentId}</span>
                <span className="text-hud-red">
                  {agent.quarantined}/{agent.assigned} ({pct(agent.quarantineRate)})
                </span>
              </div>
            ))}
          </div>
          <p className="text-hud-dim text-xs">
            Worth a look, not a verdict: a high rate can mean a noisy agent or a broken task source
            feeding it.
          </p>
        </>
      )}
    </div>
  );
}