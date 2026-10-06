import { useLive } from '../api';

/**
 * F19 -- Workspaces. The human side of the terminal data, read off
 * /api/activity: every shell reported by collect-terminals.py grouped by the
 * directory the user is sitting in, across every host in the hive.
 *
 * Truth rules, same family as the Fleet floor:
 *  - A shell is a count of collected ttys. It is NOT a claim the machine is
 *    useful right now -- collection age is surfaced, not smoothed.
 *  - A host that has gone quiet is flagged, not dropped.
 *  - A stale workspace keeps its last known numbers and is labelled as such.
 */

interface ActivityProject {
  cwd: string;
  label: string;
  shells: number;
  hosts: string[];
  host_stale: boolean;
  last_seen_age_sec: number;
  running_a_command: boolean;
  running_command_count: number;
}

interface ActivityPayload {
  projects: ActivityProject[];
  totals: { shells: number; projects: number; hosts: number; stale_hosts: number };
  stale_hosts: string[];
}

function ageLabel(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'age unknown';
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

export default function ActivityBoard() {
  const { data, error } = useLive<ActivityPayload>('/api/activity');

  if (error) {
    return (
      <div className="p-6 panel">
        <h2 className="font-mono text-lg text-hud-red mb-2">Activity unavailable</h2>
        <p className="text-hud-dim text-sm">/api/activity did not answer: {String(error)}</p>
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-hud-dim">Loading workspace activity…</div>;
  }

  const { projects, totals, stale_hosts } = data;

  return (
    <div className="p-6 space-y-5">
      <header className="flex items-baseline justify-between">
        <h1 className="font-mono text-xl text-hud-text">Workspace activity</h1>
        <p className="text-[10px] text-hud-dim">
          Live shells a human is sitting in, grouped by cwd, measured off the fleet&apos;s last collection per host.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat title="Live shells" value={totals.shells} />
        <Stat title="Workspaces" value={totals.projects} />
        <Stat title="Hosts reporting" value={totals.hosts} />
        <Stat title="Stale hosts" value={totals.stale_hosts} alert={totals.stale_hosts > 0} />
      </div>

      {stale_hosts.length > 0 && (
        <div className="panel p-3 text-hud-amber text-sm font-mono">
          {stale_hosts.length} host{stale_hosts.length > 1 ? 's' : ''} not collected recently: {stale_hosts.join(', ')}.
          Figures for those hosts are from their last collection, not a live read.
        </div>
      )}

      {projects.length === 0 ? (
        <div className="panel p-6 text-hud-dim">
          No terminals reported yet. Collectors publish into the hive on a timer; a machine that
          has never collected says so rather than presenting silence as emptiness.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((p) => (
            <div key={p.cwd} className="panel p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-mono text-sm text-hud-text">{p.label}</h3>
                  <p className="text-[10px] text-hud-dim font-mono" title={p.cwd}>
                    {p.cwd}
                  </p>
                </div>
                {p.host_stale && <span className="text-hud-amber text-xs font-mono">STALE HOST</span>}
              </div>
              <div className="flex items-center gap-4 text-xs text-hud-text mb-2">
                <span>
                  <span className="text-hud-amber font-mono">{p.shells}</span> shell{p.shells === 1 ? '' : 's'}
                </span>
                {p.running_a_command && (
                  <span>
                    <span className="text-hud-green font-mono">{p.running_command_count}</span> running a command
                  </span>
                )}
                <span className="text-hud-dim">last seen {ageLabel(p.last_seen_age_sec)}</span>
              </div>
              <div className="text-[10px] text-hud-dim font-mono">hosts: {p.hosts.join(', ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ title, value, alert = false }: { title: string; value: number; alert?: boolean }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] uppercase tracking-wide text-hud-dim">{title}</div>
      <div className={`font-mono text-2xl ${alert ? 'text-hud-amber' : 'text-hud-text'}`}>{value}</div>
    </div>
  );
}
