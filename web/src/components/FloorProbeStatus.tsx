import { useLive, type FloorsPayload } from '../api';

/**
 * Probe-grade floor truth, as distinct from the roster rollup in FloorTable.
 *
 * The rollup groups the agent list by floor and can only say which agents claim
 * a floor. It never looks at a manager process or a status file, so a floor
 * whose only evidence is a process id reads as populated. This panel reads
 * GET /api/floors, which runs the hive's own probe and reports manager liveness,
 * status-file freshness and stalled work.
 *
 * The banner is the important part. When the probe cannot be consulted every
 * floor comes back UNKNOWN, and twelve grey rows look exactly like twelve floors
 * with nothing wrong. So not_verified is stated in words rather than left for
 * the reader to infer from the shading.
 */
export default function FloorProbeStatus() {
  const { data, error } = useLive<FloorsPayload>('/api/floors');

  if (error) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLOOR PROBE</h3>
        <div className="text-hud-red text-xs">NOT VERIFIED — /api/floors did not answer.</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLOOR PROBE</h3>
        <div className="text-hud-dim text-xs">Reading floor probe…</div>
      </div>
    );
  }

  const alive = data.floors.filter((f) => f.manager_alive).length;
  const stalled = Object.values(data.counts).reduce((n, c) => n + (c.stalled || 0), 0);

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-hud-amber text-sm">FLOOR PROBE</h3>
        <span className="text-[10px] font-mono text-hud-dim">
          {alive}/{data.floors.length} managers alive
        </span>
      </div>

      {data.not_verified ? (
        <div className="text-hud-amber text-xs mb-3">
          NOT VERIFIED — the hive probe could not be consulted
          {data.source === 'unavailable' ? ' (lib/floor_health.py is not present on this hive)' : ''}.
          Every floor below reads UNKNOWN because nothing measured them, not because anything is wrong.
        </div>
      ) : (
        <div className="text-hud-dim text-xs mb-3">
          Source {data.source}
          {stalled > 0 ? ` · ${stalled} stalled task${stalled === 1 ? '' : 's'}` : ''}
        </div>
      )}

      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Floor</th><th>Manager</th><th>Probe state</th><th>Stalled</th><th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.floors.map((f) => (
              <tr key={f.floor}>
                <td className="font-mono">{f.floor.toUpperCase()}</td>
                <td className={f.manager_alive ? 'text-hud-green' : 'text-hud-red'}>
                  {f.manager_alive ? 'alive' : 'not running'}
                </td>
                <td className={data.counts[f.floor]?.degraded ? 'text-hud-amber' : 'text-hud-green'}>
                  {f.state}
                </td>
                <td>{data.counts[f.floor]?.stalled ?? 0}</td>
                <td className="text-hud-dim">{f.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}