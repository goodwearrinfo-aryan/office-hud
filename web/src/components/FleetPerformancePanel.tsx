import { useLive } from '../api';

/**
 * Types are local to this panel so it adds nothing to ../api, which other
 * sessions edit.
 *
 * Note on the numbers below: quarantined tasks are shown as their own column
 * and are never folded into the completion rate. On the current hive roughly a
 * third of all tasks are quarantined, and averaging that into "completion" would
 * report a comfortable ~56% for a fleet that is in fact failing a third of what
 * it touches. If you find yourself wanting to merge those two numbers, that is
 * the reason this component is shaped this way.
 */

interface FleetAgentRow {
  agentId: string;
  assigned: number;
  complete: number;
  quarantined: number;
  inProgress: number;
  preserved: number;
  queued: number;
  completionRate: number | null;
  quarantineRate: number | null;
  lastActivityAt: string | null;
  sessions: { healthy: number; stale: number; starting: number; unknown: number };
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
    note: string;
  };
  sessions: { total: number; healthy: number; stale: number; starting: number; staleRate: number | null };
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

/** Bar whose width is the rate, tinted by how bad the number is. */
function RateBar({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  const width = value === null || value === undefined ? 0 : Math.round(value * 100);
  const tone = invert
    ? (value !== null && value > 0.25 ? 'is-bad' : 'is-ok')
    : (value !== null && value < 0.5 ? 'is-warn' : 'is-ok');
  return (
    <span className="fleetperf__bar" role="presentation">
      <span className={`fleetperf__bar-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} />
    </span>
  );
}

export default function FleetPerformancePanel() {
  const { data, loading, error, refresh } = useLive<FleetPerformance>('/api/fleet/performance');

  if (loading && !data) {
    return (
      <section className="fleetperf" aria-label="Fleet performance">
        <h2 className="fleetperf__title">FLEET PERFORMANCE</h2>
        <p className="fleetperf__hint">Reading…</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="fleetperf" aria-label="Fleet performance">
        <h2 className="fleetperf__title">FLEET PERFORMANCE</h2>
        <p className="fleetperf__hint">Unavailable: {error}</p>
      </section>
    );
  }

  if (!data) return null;

  const { tasks, sessions, cost, agents } = data;
  const worst = agents.filter((a) => (a.quarantineRate ?? 0) > 0.25).slice(0, 8);

  return (
    <section className="fleetperf" aria-label="Fleet performance">
      <div className="fleetperf__head">
        <h2 className="fleetperf__title">FLEET PERFORMANCE</h2>
        <button type="button" onClick={() => { void refresh(); }}>Refresh</button>
      </div>

      <p className="fleetperf__blurb">
        Rolled up from the hive at {ago(data.generatedAt)}. Read-only — nothing here changes fleet state.
      </p>

      <dl className="fleetperf__stats">
        <div>
          <dt>tasks</dt>
          <dd>{numberFmt.format(tasks.total)}</dd>
        </div>
        <div>
          <dt>complete</dt>
          <dd>{numberFmt.format(tasks.complete)} <small>{pct(tasks.completionRate)}</small></dd>
        </div>
        <div className="is-alert">
          <dt>quarantined</dt>
          <dd>{numberFmt.format(tasks.quarantined)} <small>{pct(tasks.quarantineRate)}</small></dd>
        </div>
        <div>
          <dt>in progress</dt>
          <dd>{numberFmt.format(tasks.inProgress)}</dd>
        </div>
        <div>
          <dt>sessions stale</dt>
          <dd>{numberFmt.format(sessions.stale)} <small>{pct(sessions.staleRate)}</small></dd>
        </div>
        <div>
          <dt>spend</dt>
          <dd>
            ${cost.totalUsd.toFixed(2)}
            <small>{cost.unpricedRecords > 0 ? `${cost.unpricedRecords} unpriced` : ''}</small>
          </dd>
        </div>
      </dl>

      {tasks.quarantineRate !== null && tasks.quarantineRate > 0.2 && (
        <p className="fleetperf__warn">
          {pct(tasks.quarantineRate)} of all tasks are quarantined. That is counted separately from completion
          on purpose — it is not part of the {pct(tasks.completionRate)} completion rate above.
        </p>
      )}

      <h3 className="fleetperf__subtitle">Agents ({agents.length})</h3>
      <table className="fleetperf__table">
        <thead>
          <tr>
            <th scope="col">agent</th>
            <th scope="col">tasks</th>
            <th scope="col">done</th>
            <th scope="col">quar</th>
            <th scope="col">quarantine rate</th>
            <th scope="col">sessions</th>
            <th scope="col">last activity</th>
          </tr>
        </thead>
        <tbody>
          {agents.slice(0, 20).map((agent) => (
            <tr key={agent.agentId}>
              <th scope="row">{agent.agentId}</th>
              <td>{numberFmt.format(agent.assigned)}</td>
              <td>{numberFmt.format(agent.complete)}</td>
              <td className={agent.quarantined > 0 ? 'is-alert' : undefined}>
                {numberFmt.format(agent.quarantined)}
              </td>
              <td className="fleetperf__rate">
                <RateBar value={agent.quarantineRate} invert />
                <span>{pct(agent.quarantineRate)}</span>
              </td>
              <td>
                <span className="fleetperf__sessions">
                  {agent.sessions.healthy} ok / {agent.sessions.stale} stale
                </span>
              </td>
              <td>{ago(agent.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {agents.length > 20 && (
        <p className="fleetperf__hint">Showing the 20 busiest of {agents.length} agents with recorded tasks.</p>
      )}

      {worst.length > 0 && (
        <>
          <h3 className="fleetperf__subtitle">Highest quarantine rates</h3>
          <ul className="fleetperf__worst">
            {worst.map((agent) => (
              <li key={agent.agentId}>
                <strong>{agent.agentId}</strong> — {agent.quarantined} of {agent.assigned} quarantined
                {' '}({pct(agent.quarantineRate)})
              </li>
            ))}
          </ul>
          <p className="fleetperf__hint">
            Worth a look, not a verdict: a high rate can mean a noisy agent or a broken task source feeding it.
          </p>
        </>
      )}
    </section>
  );
}