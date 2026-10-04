import { useEffect, useRef, useState } from 'react';
import { useLive, type Agent, type AgentDetail } from '../api';
import Markdown from './Markdown';

type Tab = 'profile' | 'live' | 'memory' | 'inbox' | 'outbox';

function statusColor(display?: string) {
  return display === 'busy' ? '#34d399' : display === 'idle' ? '#f5a623' : display === 'breaker' ? '#f87171' : '#475569';
}

function ageLabel(seconds: number | null) {
  if (seconds == null) return 'no heartbeat';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function MessageRow({ message }: { message: AgentDetail['inbox'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <button onClick={() => setOpen(!open)} className="w-full text-left panel p-3 hover:border-hud-amber/50 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-hud-text truncate">{message.subject || message.act || 'message'}</span>
        <span className="text-[10px] font-mono text-hud-dim shrink-0">{message.from} → {message.to}</span>
      </div>
      {open && message.body && <div className="mt-2 pt-2 border-t border-hud-edge text-xs text-hud-dim whitespace-pre-wrap leading-relaxed max-h-72 overflow-auto">{message.body}</div>}
    </button>
  );
}

export default function AgentDrawer({ agentId, summary, onClose }: { agentId: string; summary: Agent | undefined; onClose: () => void }) {
  const { data } = useLive<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}`);
  const [tab, setTab] = useState<Tab>('profile');
  const agent = summary ?? data?.agent;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // Move focus into the dialog and hand it back on close, so the drawer is
  // usable from the keyboard instead of being a pointer-only surface.
  useEffect(() => {
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => restoreFocusTo.current?.focus?.();
  }, []);

  // Tabbing past the last control should not escape into the page behind.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', trap);
    return () => panel.removeEventListener('keydown', trap);
  }, [agentId]);
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'live', label: 'Live', count: (data?.sessions.length ?? 0) + (data?.currentTasks.length ?? 0) },
    { id: 'memory', label: 'Memory' },
    { id: 'inbox', label: 'Inbox', count: data?.inbox.length ?? 0 },
    { id: 'outbox', label: 'Outbox', count: data?.outbox.length ?? 0 },
  ];

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Agent ${agent?.name ?? agentId}`}
        className="drawer absolute right-0 top-0 bottom-0 w-[440px] bg-hud-panel border-l border-hud-edge flex flex-col outline-none"
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
      >
        <div className="p-4 border-b border-hud-edge flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full live-dot" style={{ background: statusColor(agent?.display) }} />
              <h2 className="text-lg font-semibold">{agent?.name ?? agentId}</h2>
              {agent?.isGod && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">GOD</span>}
            </div>
            <div className="text-xs text-hud-dim mt-0.5">{agent?.role}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-hud-dim hover:text-hud-text text-lg px-2"
            aria-label="Close agent drawer"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-4 gap-px bg-hud-edge text-center text-xs">
          {[
            ['status', agent?.display ?? '—'],
            ['backlog', String(agent?.inboxBacklog ?? 0)],
            ['cost', `$${(agent?.usd ?? 0).toFixed(2)}`],
            ['heartbeat', ageLabel(agent?.heartbeatAgeSec ?? null)],
          ].map(([key, value]) => (
            <div key={key} className="bg-hud-panel py-2 px-1">
              <div className="font-mono text-hud-text truncate">{value}</div>
              <div className="text-[10px] text-hud-dim">{key}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-1 px-3 pt-3 overflow-x-auto" role="tablist" aria-label="Agent detail sections">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`drawer-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="drawer-tabpanel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={event => {
                // Arrow keys move between tabs, as a tablist is expected to.
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                const index = tabs.findIndex(entry => entry.id === tab);
                const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                setTab(next.id);
                panelRef.current?.querySelector<HTMLElement>(`#drawer-tab-${next.id}`)?.focus();
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${tab === item.id ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'}`}
            >
              {item.label}{item.count ? ` · ${item.count}` : ''}
            </button>
          ))}
        </div>

        <div
          id="drawer-tabpanel"
          role="tabpanel"
          aria-labelledby={`drawer-tab-${tab}`}
          tabIndex={0}
          className="flex-1 overflow-auto p-4"
        >
          {!data ? (
            <div className="text-hud-dim text-sm">Loading…</div>
          ) : tab === 'profile' ? (
            <div className="space-y-4">
              {data.identity ? <Markdown source={data.identity} /> : <div className="text-hud-dim text-sm">No identity.md</div>}
              <div className="panel p-3 font-mono text-[11px] text-hud-dim break-all">
                cwd: {agent?.cwd ?? '—'}
                {!agent?.cwdValid && <span className="text-hud-red"> (missing on disk)</span>}
              </div>
            </div>
          ) : tab === 'live' ? (
            <div className="space-y-4">
              <div>
                <h3 className="font-mono text-xs text-hud-amber mb-2">SESSIONS</h3>
                <div className="space-y-2">
                  {data.sessions.map(session => (
                    <div key={session.session_id} className="panel-surface p-3 text-xs font-mono">
                      <div className="flex justify-between gap-2"><span>{session.session_id}</span><span className={session.fresh ? 'text-hud-green' : 'text-hud-red'}>{session.status}</span></div>
                      <div className="text-hud-dim mt-1">PID {session.process_id} · heartbeat {ageLabel(session.heartbeat_age_sec)}</div>
                    </div>
                  ))}
                  {data.sessions.length === 0 && <div className="text-hud-dim text-sm">No sessions</div>}
                </div>
              </div>
              <div>
                <h3 className="font-mono text-xs text-hud-amber mb-2">CURRENT TASKS</h3>
                <div className="space-y-2">
                  {data.currentTasks.map(task => <div key={task.task_id} className="panel-surface p-3"><div className="text-xs text-hud-text">{task.title}</div><div className="text-[10px] font-mono text-hud-dim mt-1">{task.task_id}</div></div>)}
                  {data.currentTasks.length === 0 && <div className="text-hud-dim text-sm">No claimed tasks</div>}
                </div>
              </div>
              <div>
                <h3 className="font-mono text-xs text-hud-amber mb-2">RECENT EVENTS</h3>
                <div className="space-y-2">
                  {data.recentEvents.map((event, index) => (
                    <div key={`${event.timestamp}-${event.task_id}-${index}`} className="panel-surface p-3">
                      <div className="flex justify-between gap-2 text-[10px] font-mono"><span className="text-hud-blue">{event.type}</span><span className="text-hud-dim">{event.timestamp ? new Date(event.timestamp).toLocaleString() : '—'}</span></div>
                      {event.task_id && <div className="text-[10px] font-mono text-hud-amber mt-1">{event.task_id}</div>}
                      {event.result && <div className="text-xs text-hud-dim mt-1 break-words">{event.result.length > 280 ? `${event.result.slice(0, 280)}…` : event.result}</div>}
                    </div>
                  ))}
                  {data.recentEvents.length === 0 && <div className="text-hud-dim text-sm">No recent events</div>}
                </div>
              </div>
            </div>
          ) : tab === 'memory' ? (
            data.memory ? <Markdown source={data.memory} /> : <div className="text-hud-dim text-sm">No memory yet</div>
          ) : (
            <div className="space-y-2">
              {(tab === 'inbox' ? data.inbox : data.outbox).length === 0 && <div className="text-hud-dim text-sm">Empty</div>}
              {(tab === 'inbox' ? data.inbox : data.outbox).map((message, index) => <MessageRow key={message._file ?? index} message={message} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
