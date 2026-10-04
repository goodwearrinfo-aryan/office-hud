import { useState, useEffect } from 'react';
import { useLive, type LedgerEvent, type Summary } from '../api';

interface Props {
  onSelectAgent?: (id: string) => void;
}

export default function GlobalSearch({ onSelectAgent }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'agents' | 'ledger' | 'all'>('all');

  const { data: summary } = useLive<Summary>('/api/summary');
  const { data: ledger } = useLive<{ events: LedgerEvent[] }>('/api/ledger?limit=500');
  const agents = summary?.agents ?? [];
  const events = ledger?.events ?? [];

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const q = query.toLowerCase();
    const agentMatches = agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      a.role.toLowerCase().includes(q) ||
      a.display.toLowerCase().includes(q)
    ).map(a => ({ type: 'agent', ...a, score: a.name.toLowerCase().includes(q) ? 10 : 5 }));

    const eventMatches = events.filter(e =>
      JSON.stringify(e).toLowerCase().includes(q)
    ).slice(0, 20).map(e => ({ type: 'event', ...e, score: 3 }));

    const all = [...agentMatches, ...eventMatches].sort((a, b) => b.score - a.score);
    setResults(all);
  }, [query, agents, events]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Search agents, events... (⌘K)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="bg-hud-bg border border-hud-edge rounded-lg px-3 py-1.5 text-sm text-hud-text placeholder-hud-dim w-64 md:w-80 focus:outline-none focus:border-hud-amber transition-colors"
          onKeyDown={e => { if (e.key === 'Escape') { (e.target as HTMLInputElement).blur(); setQuery(''); } }}
        />
        <div className="flex gap-1 bg-hud-bg border border-hud-edge rounded-lg p-0.5">
          {['all', 'agents', 'ledger'].map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t as any)}
              className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
                activeTab === t ? 'bg-hud-edge text-hud-text' : 'text-hud-dim hover:text-hud-text'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {(query.trim() || activeTab !== 'all') && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-hud-panel border border-hud-edge rounded-lg shadow-lg max-h-96 overflow-auto z-50">
          {results.length === 0 && (
            <div className="p-4 text-center text-hud-dim text-sm">no matches</div>
          )}
          {results.filter(r => activeTab === 'all' || r.type === activeTab).map((r, i) => (
            <button
              key={i}
              onClick={() => {
                if (r.type === 'agent' && onSelectAgent) {
                  onSelectAgent(r.id);
                }
              }}
              className="w-full px-4 py-2 text-left hover:bg-hud-edge transition-colors border-b border-hud-edge/50 last:border-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm text-hud-text">{r.name || r.id || 'event'}</span>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  r.type === 'agent' ? 'bg-hud-green/15 text-hud-green' : 'bg-hud-blue/15 text-hud-blue'
                }`}>
                  {r.type}
                </span>
              </div>
              {r.type === 'agent' && (
                <div className="text-[10px] text-hud-dim mt-0.5 flex gap-3">
                  <span>{r.display}</span>
                  <span>{r.role}</span>
                  {r.cwd && <span className="truncate max-w-[200px]">{r.cwd.replace(/^\/Users\/[^/]+\//, '~/')}</span>}
                </div>
              )}
              {r.type === 'event' && (
                <div className="text-[10px] text-hud-dim mt-0.5 font-mono truncate">
                  {JSON.stringify(r).slice(0, 120)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}