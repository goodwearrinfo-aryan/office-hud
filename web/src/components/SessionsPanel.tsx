import { useLive, type SessionRecord } from '../api';

function ageLabel(seconds: number | null) {
  if (seconds == null) return 'no heartbeat';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function freshnessTone(session: SessionRecord) {
  if (session.fresh) return 'text-hud-green';
  if ((session.heartbeat_age_sec ?? Infinity) < 3600) return 'text-hud-amber';
  return 'text-hud-red';
}

export default function SessionsPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, error } = useLive<{ sessions: SessionRecord[] }>('/api/sessions');
  const sessions = data?.sessions ?? [];
  const healthy = sessions.filter(session => session.fresh).length;
  const stale = sessions.length - healthy;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F1 · SESSIONS</h2>
        <div className="flex gap-3 text-xs font-mono text-hud-dim">
          <span className="text-hud-green">{healthy} live</span>
          <span className="text-hud-red">{stale} stale</span>
          <span>{sessions.length} total</span>
        </div>
      </div>
      <div className="table-container panel">
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>PID</th>
              <th>Status</th>
              <th>Current task</th>
              <th>Heartbeat</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(session => (
              <tr key={`${session.agent_id}-${session.session_id}`} className="cursor-pointer" onClick={() => onSelect(session.agent_id)}>
                <td className="text-hud-text">{session.agent_id}</td>
                <td>{session.process_id ?? '—'}</td>
                <td>
                  <span className={session.fresh ? 'text-hud-green' : freshnessTone(session)}>{session.status}</span>
                </td>
                <td className="max-w-[260px] truncate">{session.current_task_id || '—'}</td>
                <td>
                  <div className={freshnessTone(session)}>{ageLabel(session.heartbeat_age_sec)}</div>
                  <div className="text-[10px] text-hud-dim">{session.last_heartbeat || 'never'}</div>
                </td>
                <td className="text-[10px] text-hud-dim">{session.session_id}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-hud-dim">{error ? `Failed to load sessions: ${error}` : 'Loading sessions…'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
