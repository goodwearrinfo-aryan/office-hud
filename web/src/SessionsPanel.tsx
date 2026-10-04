import { useLive, type SessionRecord } from './api';
import { useMemo, useState } from 'react';

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
  const [hostFilter, setHostFilter] = useState<string>('all');
  const sessions = data?.sessions ?? [];

  // Rows arrive tagged with the machine that reported them. Grouping by host
  // and filtering on it is what makes a multi-machine view navigable -- 1200
  // undifferentiated rows is not something anyone can read.
  const hosts = useMemo(() => {
    const seen = new Map<string, { total: number; fresh: number; staleHost: boolean }>();
    for (const s of sessions) {
      const key = s.host || 'unknown';
      const entry = seen.get(key) ?? { total: 0, fresh: 0, staleHost: false };
      entry.total += 1;
      if (s.fresh) entry.fresh += 1;
      if (s.host_stale) entry.staleHost = true;
      seen.set(key, entry);
    }
    return [...seen.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [sessions]);

  const visible = hostFilter === 'all' ? sessions : sessions.filter(s => (s.host || 'unknown') === hostFilter);
  const healthy = visible.filter(session => session.fresh).length;
  const stale = visible.length - healthy;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-mono text-hud-amber text-lg">F1 · SESSIONS</h2>
        <div className="flex gap-3 text-xs font-mono text-hud-dim">
          <span className="text-hud-green">{healthy} live</span>
          <span className="text-hud-red">{stale} stale</span>
          <span>{visible.length} total</span>
        </div>
      </div>

      {hosts.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs font-mono">
          <button
            type="button"
            onClick={() => setHostFilter('all')}
            className={`px-2 py-1 rounded border ${hostFilter === 'all' ? 'border-hud-amber text-hud-amber' : 'border-hud-dim text-hud-dim'}`}
            aria-pressed={hostFilter === 'all'}
          >
            all machines ({sessions.length})
          </button>
          {hosts.map(([host, info]) => {
            const active = hostFilter === host;
            return (
              <button
                key={host}
                type="button"
                onClick={() => setHostFilter(host)}
                className={`px-2 py-1 rounded border ${active ? 'border-hud-amber text-hud-amber' : 'border-hud-dim text-hud-dim'}`}
                aria-pressed={active}
                title={info.staleHost ? 'This machine has stopped reporting; rows shown are its last known state' : undefined}
              >
                {host} ({info.total}){info.staleHost ? ' · offline' : ''}
              </button>
            );
          })}
        </div>
      )}

      <div className="table-container panel">
        <table className="table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Agent</th>
              <th>PID</th>
              <th>Status</th>
              <th>Current task</th>
              <th>Heartbeat</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(session => (
              <tr
                key={`${session.host}-${session.agent_id}-${session.session_id}`}
                className="cursor-pointer"
                onClick={() => onSelect(session.agent_id)}
                /* A clickable row must be reachable by keyboard, not by pointer alone. */
                tabIndex={0}
                role="button"
                aria-label={`Open ${session.agent_id} on ${session.host} (${session.status})`}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(session.agent_id);
                  }
                }}
              >
                <td className="text-[10px] font-mono text-hud-dim">
                  {session.host || '—'}
                  {session.host_stale && <span className="ml-1 text-hud-amber" title="host stopped reporting">⚠</span>}
                </td>
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
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-hud-dim">{error ? `Failed to load sessions: ${error}` : 'Loading sessions…'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
