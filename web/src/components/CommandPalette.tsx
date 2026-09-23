import { useEffect, useState, useMemo } from 'react';
import { Agent } from '../api';

interface Props {
  onClose: () => void;
  agents: Agent[];
}

export default function CommandPalette({ onClose, agents }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, filteredResults.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter') { onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const results = useMemo(() => {
    if (!query) return [
      { label: 'Restart Agent', action: 'restart_agent', icon: '🔄' },
      { label: 'Kill Process', action: 'kill_process', icon: '💀' },
      { label: 'New Task', action: 'new_task', icon: '📝' },
      { label: 'View Logs', action: 'view_logs', icon: '📋' },
      { label: 'Switch Model', action: 'switch_model', icon: '🤖' },
      { label: 'View Memory', action: 'view_memory', icon: '🧠' },
      { label: 'Open Terminal', action: 'open_terminal', icon: '🖥️' },
    ];
    return agents
      .filter(a => a.id.toLowerCase().includes(query.toLowerCase()) || a.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8)
      .map(a => ({ label: `${a.name} (${a.id})`, action: `agent_${a.id}`, icon: a.isGod ? '👑' : a.id.startsWith('f') ? '🏢' : a.id.startsWith('pm') ? '📊' : '👤' }));
  }, [query, agents]);

  const filteredResults = useMemo(() => results.slice(0, 10), [results]);

  const handleSelect = (item: any) => {
    if (item.action.startsWith('agent_')) {
      // Open agent drawer
    } else if (item.action === 'restart_agent') {
      // Restart agent
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[600px] max-w-full mx-4 panel overflow-hidden animate-slide-in" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-hud-edge flex items-center gap-3">
          <span className="text-lg font-mono text-hud-amber">⌘K</span>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command or search agents..."
            className="input flex-1 text-lg font-mono"
            autoFocus
          />
          <kbd className="bg-hud-edge px-2 py-1 rounded text-xs text-hud-dim">Esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {filteredResults.map((item, i) => (
            <button
              key={item.label}
              onClick={() => { /* handleSelect(item) */ }}
              className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${i === 0 ? 'bg-hud-surface' : 'hover:bg-hud-surface'}`}
            >
              <span className="text-xl">{item.icon}</span>
              <span className="font-mono text-sm">{item.label}</span>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-hud-edge text-xs text-hud-dim flex justify-between">
          <span>↑/↓ Navigate • Enter Select • Esc Close</span>
          <span className="font-mono text-hud-amber">⌘K</span>
        </div>
      </div>
    </div>
  );
}