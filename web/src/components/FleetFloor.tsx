import FleetLoadPanel from './FleetLoadPanel';
import { useLive, type TerminalsPayload, type TradingOpsPayload, type FleetLaunchdEntry } from '../api';
import { ageLabel, hostStatus, hostSummary, isIdentified, isVerified, undeclaredJobs } from '../fleetTruth';

/**
 * F17 — the fleet floor: what every machine in the hive is doing, not just this one.
 *
 * Why this exists
 * ---------------
 * The HUD was maintained against one machine's data while running in two places.
 * Nothing on screen admitted that. `summary.floors` and `AgentDrawer` describe
 * agents; `OpsFloor` describes services; neither says which computer they are on.
 * So a laptop that stopped reporting was invisible until something else broke.
 *
 * It is not visible now. Measured off this payload while building it: the mini
 * had been collected 34 seconds ago, the laptop 56244 — fifteen and a half hours.
 * Every one of the laptop's 33 process rows carried `process_id`, `project_id` and
 * `health` all null, because the collector that supplies them has not reported.
 *
 * Truth rules this floor holds to
 * ------------------------------
 * A host is never dropped for being quiet. It is listed, aged, and marked stale,
 * because "this machine does not exist" and "this machine has not spoken since
 * yesterday" are different claims and only one of them is true.
 *
 * A null identity is NOT REPORTED, not a nameless healthy process. A null health
 * is NOT VERIFIED, not healthy. A stale host's numbers are dated by its
 * `age_sec` rather than presented as current.
 */


/**
 * A launchd job the HUD has no declaration for. Rendered rather than omitted: the
 * four jobs this machine runs that no plist in the repo accounts for
 * (info-swarm-awake, openalice-cloudflared, openalice-pubserver, scalp-caffeinate)
 * are either alive, retired, or forgotten, and nobody currently knows which.
 * Leaving them off the floor would answer "no" by silence.
 */


function JobRow({ job }: { job: FleetLaunchdEntry }) {
  const loaded = job.loaded ?? job.running;
  return (
    <tr>
      <td className="font-mono text-xs">{job.label}</td>
      <td className={loaded ? 'text-hud-green' : 'text-hud-dim'}>{loaded ? 'loaded' : 'not loaded'}</td>
      <td>{job.pid ?? '—'}</td>
      <td>{job.lastExit ?? '—'}</td>
      <td className="text-hud-dim">{job.intent ?? '—'}</td>
    </tr>
  );
}

function HostCard({ host }: { host: TerminalsPayload['hosts'][number] }) {
      <FleetLoadPanel />
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <h3 className="font-mono text-sm text-hud-text">{host.host}</h3>
          {host.local && (
            <span className="text-[9px] font-mono text-hud-dim border border-hud-edge px-1 py-0.5">
              THIS MACHINE
            </span>
          )}
        </div>
        <span className={`text-[10px] font-mono ${host.stale ? 'text-hud-amber' : 'text-hud-green'}`}>
          {hostStatus(host)}
        </span>
      </div>

      <div className="text-[10px] text-hud-dim mb-3">{hostSummary(host)}</div>

      {host.stale && (
        <div className="text-hud-amber text-xs mb-3">
          This machine has not been collected for {ageLabel(host.age_sec ?? null)}. Everything below is a
          record of that time, not a measurement of now.
        </div>
      )}

      {host.processes.length === 0 ? (
        <div className="text-hud-dim text-xs">
          No processes reported{host.stale ? ' at its last collection' : ''}.
        </div>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Process</th><th>Project</th><th>Status</th><th>Health</th><th>PID</th>
              </tr>
            </thead>
            <tbody>
              {host.processes.map((p, i) => (
                <tr key={p.process_id ?? `${host.host}-${i}`}>
                  <td className="font-mono text-xs">
                    {p.process_id ?? <span className="text-hud-amber">NOT REPORTED</span>}
                  </td>
                  <td className="text-xs">{p.project_id ?? <span className="text-hud-amber">—</span>}</td>
                  <td className="text-xs">{p.status ?? '—'}</td>
                  <td className="text-xs">
                    {isVerified(p)
                      ? <span className={p.health === 'HEALTHY' ? 'text-hud-green' : 'text-hud-red'}>{p.health}</span>
                      : <span className="text-hud-dim">NOT VERIFIED</span>}
                  </td>
                  <td className="text-xs">{p.pid ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Whether this machine can start a terminal at all, and why not when it cannot.
 *
 * Four outcomes, all of which look identical from the outside -- a spawn that
 * does not happen -- so they are named rather than collapsed into "disabled":
 *
 *   permitted       the policy's trees all exist here
 *   partial         some exist, some do not: usually a policy that travelled
 *   none_permitted  the policy is present and NONE of its trees exist here
 *   no_policy_file  no file, so the built-in default applies
 *
 * `none_permitted` is the one worth catching early. It is what the mini has been
 * running the whole time: a policy naming a laptop path, which refuses every cwd.
 * Fail-closed and correct, and previously indistinguishable from spawning being
 * switched off.
 */
function SpawnPolicyPanel({ audit }: { audit: NonNullable<TerminalsPayload['spawn_policy']> }) {
  const tone =
    audit.effect === 'permitted' ? 'text-hud-green'
      : audit.effect === 'no_policy_file' ? 'text-hud-dim'
        : 'text-hud-amber';
  const heading =
    audit.effect === 'permitted' ? 'PERMITTED'
      : audit.effect === 'no_policy_file' ? 'DEFAULT POLICY'
        : audit.effect === 'unreadable_policy' ? 'POLICY UNREADABLE'
          : audit.effect === 'partial' ? 'PARTIALLY PERMITTED' : 'NO VALID TREE';

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono text-sm text-hud-amber">CAN THIS MACHINE SPAWN A TERMINAL?</h3>
        <span className={`text-[10px] font-mono ${tone}`}>{heading}</span>
      </div>
      <div className="text-[10px] text-hud-dim mb-2">
        reported by reading {audit.source} · machine {audit.this_machine} · home {audit.home}
      </div>
      <div className={`text-xs ${tone} mb-3`}>{audit.summary}</div>
      {audit.permitted_trees.length > 0 && (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Permitted tree</th><th>Exists here</th><th>Under this home</th></tr>
            </thead>
            <tbody>
              {audit.permitted_trees.map((t) => {
                const missing = audit.missing_trees.includes(t);
                return (
                  <tr key={t}>
                    <td className="font-mono text-xs">{t}</td>
                    <td className="text-xs">
                      {missing
                        ? <span className="text-hud-amber">no</span>
                        : <span className="text-hud-green">yes</span>}
                    </td>
                    <td className="text-xs">{t.startsWith(audit.home) ? 'yes' : 'no'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function FleetFloor() {
  const { data: fleet, error: fleetError } = useLive<TerminalsPayload>('/api/terminals');
  const { data: ops } = useLive<TradingOpsPayload>('/api/trading/ops');

  const launchd = ops?.launchdState;
  const declared = launchd?.services ?? [];
  const undeclared = undeclaredJobs(declared.map((j) => j.label));

  const hosts = fleet?.hosts ?? [];
  const staleHosts = fleet?.stale_hosts ?? [];
  const identified = hosts.reduce(
    (n, h) => n + h.processes.filter(isIdentified).length, 0,
  );
  const totalProcesses = hosts.reduce((n, h) => n + h.processes.length, 0);

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-xs tracking-widest text-hud-dim">F17 · THE FLEET</h3>
          <span className="text-[10px] font-mono text-hud-dim">
            {hosts.length} machine{hosts.length === 1 ? '' : 's'} · {staleHosts.length} stale ·{' '}
            {identified}/{totalProcesses} identified
          </span>
        </div>
        <div className="text-[10px] text-hud-dim mt-1">
          A machine that has gone quiet is listed and dated, never dropped. A row whose identity or
          health the collector did not report says so instead of borrowing another row's meaning.
        </div>
        {fleetError && (
          <div className="text-hud-red text-xs mt-3">
            NOT VERIFIED — /api/terminals did not answer, so no machine can be described.
          </div>
        )}
      </div>

      {hosts.length === 0 && !fleetError && (
        <div className="panel p-4">
          <div className="text-hud-dim text-xs">
            No machines reported. The HUD is running, so at least this one exists — which means the
            collector has not written, not that the fleet is empty.
          </div>
        </div>
      )}

      {fleet?.spawn_policy && <SpawnPolicyPanel audit={fleet.spawn_policy} />}

      {hosts.map((h) => <HostCard key={h.host} host={h} />)}
      <FleetLoadPanel />

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-mono text-sm text-hud-amber">LAUNCHD ON THIS MACHINE</h3>
          {launchd && !launchd.available && (
            <span className="text-[10px] font-mono text-hud-red">
              NOT VERIFIED{launchd.error ? `: ${launchd.error}` : ''}
            </span>
          )}
        </div>

        {!launchd ? (
          <div className="text-hud-dim text-xs">Reading launchd state…</div>
        ) : !launchd.available ? (
          <div className="text-hud-red text-xs">
            The job list could not be read. That is a gap in what can be seen here, and it is not
            the same as this machine running no jobs.
          </div>
        ) : declared.length === 0 ? (
          <div className="text-hud-dim text-xs">
            The listing is available and reports no services. Combined with the four jobs below that
            nothing declares, this machine's supervision state is not fully described by the repo.
          </div>
        ) : (
          <div className="table-container mb-4">
            <table className="table">
              <thead>
                <tr><th>Job</th><th>State</th><th>PID</th><th>Last exit</th><th>Intent</th></tr>
              </thead>
              <tbody>
                {declared.map((j) => <JobRow key={j.label} job={j} />)}
              </tbody>
            </table>
          </div>
        )}

        {undeclared.length > 0 && (
          <>
            <div className="text-[10px] font-mono text-hud-dim mb-2">
              RUNNING HERE, UNDECLARED ({undeclared.length})
            </div>
            <div className="text-[10px] text-hud-dim mb-2">
              These run on this machine and no plist in the repo accounts for them. Whether each is
              alive, retired or forgotten is not recorded anywhere the HUD can read, so it is not
              guessed here.
            </div>
            <div className="flex flex-wrap gap-2">
              {undeclared.map((j) => (
                <span
                  key={j}
                  className="text-[10px] font-mono text-hud-amber border border-hud-edge px-2 py-1"
                >
                  {j} · UNKNOWN — retire or resurrect
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
