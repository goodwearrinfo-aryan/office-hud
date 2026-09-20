import { useState } from 'react';
import { useLive, type Agent, type AgentDetail } from '../api';
import Markdown from './Markdown';

type Tab = 'profile' | 'memory' | 'inbox' | 'outbox';

function statusColor(d?: string) {
  return d === 'busy' ? '#34d399' : d === 'idle' ? '#f5a623' : d === 'breaker' ? '#f87171' : '#475569';
}

function MessageRow({ m }: { m: AgentDetail['inbox'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <button onClick={() => setOpen(!open)} className="w-full text-left panel p-3 hover:border-hud-amber/50 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-hud-text truncate">{m.subject || m.act || 'message'}</span>
        <span className="text-[10px] font-mono text-hud-dim shrink-0">{m.from} → {m.to}</span>
      </div>
      {open && m.body && (
        <div className="mt-2 pt-2 border-t border-hud-edge text-xs text-hud-dim whitespace-pre-wrap leading-relaxed max-h-72 overflow-auto">
          {m.body}
        </div>
      )}
    </button>
  );
}

export default function AgentDrawer({ agentId, summary, onClose }: { agentId: string; summary: Agent | undefined; onClose: () => void }) {
  const { data } = useLive<AgentDetail>(`/api/agents/${agentId}`);
  const [tab, setTab] = useState<Tab>('profile');

  const a = summary ?? (data?.agent as Agent | undefined);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'memory', label: 'Memory' },
    { id: 'inbox', label: 'Inbox', count: data?.inbox.length ?? 0 },
    { id: 'outbox', label: 'Outbox', count: data?.outbox.length ?? 0 },
  ];

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="drawer absolute right-0 top-0 bottom-0 w-[440px] bg-hud-panel border-l border-hud-edge flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="p-4 border-b border-hud-edge flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full live-dot" style={{ background: statusColor(a?.display) }} />
              <h2 className="text-lg font-semibold">{a?.name ?? agentId}</h2>
              {a?.isGod && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-hud-amber/15 text-hud-amber">GOD</span>}
            </div>
            <div className="text-xs text-hud-dim mt-0.5">{a?.role}</div>
          </div>
          <button onClick={onClose} className="text-hud-dim hover:text-hud-text text-lg px-2">×</button>
        </div>

        {/* stat strip */}
        <div className="grid grid-cols-4 gap-px bg-hud-edge text-center text-xs">
          {[
            ['status', a?.display ?? '—'],
            ['backlog', String(a?.inboxBacklog ?? 0)],
            ['cost', `$${(a?.usd ?? 0).toFixed(2)}`],
            ['tokens', String(a?.tokens ?? 0)],
          ].map(([k, v]) => (
            <div key={k} className="bg-hud-panel py-2">
              <div className="font-mono text-hud-text">{v}</div>
              <div className="text-[10px] text-hud-dim">{k}</div>
            </div>
          ))}
        </div>

        {/* tabs */}
        <div className="flex gap-1 px-3 pt-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'
              }`}
            >
              {t.label}{t.count ? ` · ${t.count}` : ''}
            </button>
          ))}
        </div>

        {/* content */}
        <div className="flex-1 overflow-auto p-4">
          {!data ? (
            <div className="text-hud-dim text-sm">loading…</div>
          ) : tab === 'profile' ? (
            <div className="space-y-4">
              {data.identity ? <Markdown source={data.identity} /> : <div className="text-hud-dim text-sm">no identity.md</div>}
              <div className="panel p-3 font-mono text-[11px] text-hud-dim break-all">
                cwd: {a?.cwd ?? '—'}
                {!a?.cwdValid && <span className="text-hud-red"> (missing on disk)</span>}
              </div>
            </div>
          ) : tab === 'memory' ? (
            data.memory ? <Markdown source={data.memory} /> : <div className="text-hud-dim text-sm">no memory yet</div>
          ) : (
            <div className="space-y-2">
              {(tab === 'inbox' ? data.inbox : data.outbox).length === 0 && (
                <div className="text-hud-dim text-sm">empty</div>
              )}
              {(tab === 'inbox' ? data.inbox : data.outbox).map((m, i) => <MessageRow key={m._file ?? i} m={m} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
