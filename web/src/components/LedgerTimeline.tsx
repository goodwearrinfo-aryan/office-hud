import { useState } from 'react';
import { useLive, type FleetEvent } from '../api';

const EVENT_TYPES = [
  ['', 'All Events'],
  ['heartbeat', 'Heartbeat'],
  ['task_started', 'Task Started'],
  ['task_completed', 'Task Completed'],
  ['task_failed', 'Task Failed'],
  ['agent_stale', 'Agent Stale'],
  ['session_started', 'Session Started'],
  ['message_sent', 'Message Sent'],
];

function eventTone(type: string) {
  if (type === 'task_completed') return 'text-hud-green';
  if (type === 'task_failed' || type === 'agent_stale') return 'text-hud-red';
  if (type === 'heartbeat') return 'text-hud-dim';
  if (type === 'task_started' || type === 'session_started') return 'text-hud-blue';
  return 'text-hud-amber';
}

function eventTime(timestamp?: string) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

export default function LedgerTimeline() {
  const [source, setSource] = useState<'log' | 'events'>('events');
  const [kind, setKind] = useState('');
  const query = new URLSearchParams({ source, limit: '200' });
  if (kind) query.set('kind', kind);
  const { data, error } = useLive<{ source: string; events: FleetEvent[] }>(`/api/ledger?${query.toString()}`);
  const events = data?.events ?? [];

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h2 className="font-mono text-hud-amber text-lg">F2 · LEDGER TIMELINE</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-hud-edge overflow-hidden">
            {(['events', 'log'] as const).map(value => (
              <button
                key={value}
                onClick={() => setSource(value)}
                className={`px-3 py-1.5 text-xs font-mono ${source === value ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'}`}
              >
                {value === 'events' ? 'events.log' : 'log.jsonl'}
              </button>
            ))}
          </div>
          <select className="input w-44 text-xs" value={kind} onChange={event => setKind(event.target.value)}>
            {EVENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="space-y-2">
        {events.map((event, index) => (
          <div key={`${event.timestamp ?? 'event'}-${event.task_id ?? ''}-${event.agent_id ?? ''}-${index}`} className="panel p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-mono text-xs ${eventTone(event.type)}`}>{event.type || 'event'}</span>
                <span className="text-xs text-hud-text truncate">{event.agent_id || event.session_id || 'system'}</span>
                {event.task_id && <span className="text-[10px] font-mono text-hud-blue truncate">{event.task_id}</span>}
              </div>
              <span className="text-[10px] font-mono text-hud-dim shrink-0">{eventTime(event.timestamp)}</span>
            </div>
            {event.result && <div className="mt-2 text-xs text-hud-dim truncate">{event.result}</div>}
          </div>
        ))}
        {events.length === 0 && (
          <div className="panel py-8 text-center text-hud-dim text-sm">{error ? `Failed to load events: ${error}` : 'No events found'}</div>
        )}
      </div>
    </div>
  );
}
