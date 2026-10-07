import { useLive, type Summary } from '../api';

type FloorRow = {
  floor: string;
  lead: string | null;
  leadIsLive: boolean;
  agents: number;
  running: number;
  working: number;
  idle: number;
  stale: number;
  failed: number;
  offline: number;
  breaker: number;
  health: string;
};

type SummaryWithFloors = Summary & { floors?: FloorRow[] };

const HEALTH_TONE: Record<string, string> = {
  working: 'text-hud-green',
  idle: 'text-hud-dim',
  stale: 'text-hud-amber',
  breaker: 'text-hud-red',
  offline: 'text-hud-red',
  unknown: 'text-hud-dim',
};

/**
 * Every row is a floor that actually exists in the runtime data, rolled up from
 * the same agent evidence the agent list uses. A floor with no members is not
 * shown, and a floor whose members are all stale reads `stale` — it never
 * looks healthy just because a lead process exists. The lead column says
 * NOT REPORTED when no agent claims the floor, rather than borrowing the HUD's
 * own floor list to fill the gap.
 */
export default function FloorTable() {
  const { data: summary } = useLive<SummaryWithFloors>('/api/summary');
  const floors = summary?.floors ?? null;

  if (!floors) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLOORS</h3>
        <div className="text-hud-dim text-xs">Loading floor rollup…</div>
      </div>
    );
  }

  if (floors.length === 0) {
    return (
      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">FLOORS</h3>
        <div className="text-hud-dim text-xs">NOT AVAILABLE — no agent in this hive declares a floor.</div>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-hud-amber text-sm">FLOORS</h3>
        <span className="text-[10px] font-mono text-hud-dim">{floors.length} from runtime data</span>
      </div>
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Floor</th><th>Lead</th><th>Agents</th>
              <th>Working</th><th>Idle</th><th>Stale</th><th>Off</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {floors.map(f => (
              <tr key={f.floor}>
                <td className="font-mono">{f.floor}</td>
                <td className="font-mono text-xs">
                  {f.lead == null
                    ? <span className="text-hud-dim">NOT REPORTED</span>
                    : (
                      <>
                        {f.lead}
                        {!f.leadIsLive && <span className="text-hud-amber"> (stale)</span>}
                      </>
                    )}
                </td>
                <td>{f.agents}</td>
                <td className={f.working ? 'text-hud-green' : 'text-hud-dim'}>{f.working}</td>
                <td>{f.idle}</td>
                <td className={f.stale ? 'text-hud-amber' : 'text-hud-dim'}>{f.stale}</td>
                <td className={f.offline ? 'text-hud-red' : 'text-hud-dim'}>{f.offline}</td>
                <td className={`font-mono ${HEALTH_TONE[f.health] ?? 'text-hud-dim'}`}>{f.health}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[10px] font-mono text-hud-dim">
        working requires a claimed task · running requires a fresh session · a pid alone is not proof
      </div>
    </div>
  );
}
