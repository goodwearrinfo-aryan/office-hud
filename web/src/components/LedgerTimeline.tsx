import { useState } from 'react';
import { useLive, type FleetEvent } from '../api';
import { VirtualTable } from './VirtualTable';

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

function eventSummary(value: unknown) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= 240 ? text : `${text.slice(0, 240)}…`;
}

export default function LedgerTimeline() {
  const [source, setSource] = useState<'log' | 'events'>('events');
  const [kind, setKind] = useState('');
  const query = new URLSearchParams({ source, limit: '500' });
  if (kind) query.set('kind', kind);
  const { data, error } = useLive<{ source: string; events: FleetEvent[] }>(`/api/ledger?${query.toString()}`);
  const events = data?.events ?? [];
  const filteredEvents = kind ? events.filter(event => event.type === kind) : events;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex flex-wrap items-center justify-between mb-4 gap-4">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-hud-amber text-lg">F2 · LEDGER TIMELINE</h2>
          <span className="text-xs font-mono text-hud-dim">{filteredEvents.length} shown</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-hud-edge overflow-hidden">
            {(['events', 'log'] as const).map(value => (
              <button
                key={value}
                type="button"
                onClick={() => setSource(value)}
                className={`px-3 py-1.5 text-xs font-mono ${source === value ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'}`}
              >
                {value === 'events' ? 'events.log' : 'log.jsonl'}
              </button>
            ))}
          </div>
          <select className="input w-44 text-xs" value={kind} onChange={event => setKind(event.target.value)} aria-label="Filter by event kind">
            {EVENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <p className="text-[10px] font-mono text-hud-dim mb-2">
        {filteredEvents.length} event{filteredEvents.length === 1 ? '' : 's'}
        {filteredEvents.length >= 500 ? ' (newest 500 of the retained window)' : ''}
      </p>
      <VirtualTable
        rows={filteredEvents}
        rowHeight={54}
        height="calc(100vh - 260px)"
        className="space-y-2"
        rowKey={(event, index) => `${event.timestamp ?? 'event'}-${event.task_id ?? ''}-${event.agent_id ?? ''}-${index}`}
        emptyLabel={error ? `Failed to load events: ${error}` : 'No events found'}
        renderRow={(event) => (
          <div className="panel p-3 w-full">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-mono text-xs ${eventTone(event.type)}`}>{event.type || 'event'}</span>
                <span className="text-xs text-hud-text truncate">{event.agent_id || event.session_id || 'system'}</span>
                {event.task_id && <span className="text-[10px] font-mono text-hud-blue truncate">{event.task_id}</span>}
              </div>
              <span className="text-[10px] font-mono text-hud-dim shrink-0">{eventTime(event.timestamp)}</span>
            </div>
            {event.result && <div className="mt-2 text-xs text-hud-dim truncate">{eventSummary(event.result)}</div>}
          </div>
        )}
      />
    </div>
  );
}
