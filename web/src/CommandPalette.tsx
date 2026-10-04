import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Agent } from './api';

interface Props {
  onClose: () => void;
  agents: Agent[];
}

type FloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14';
type ResultKind = 'navigation' | 'safe' | 'unavailable' | 'agent';
type ActionStatus = { kind: 'idle' | 'loading' | 'success' | 'error'; message: string };

interface CommandResult {
  id: string;
  label: string;
  kind: ResultKind;
  detail: string;
  floor?: FloorId;
  endpoint?: string;
  successMessage?: string;
}

const FLOORS: Array<{ id: FloorId; label: string; name: string; key: string }> = [
  { id: 'f1', label: 'F1', name: 'Sessions', key: '1' },
  { id: 'f2', label: 'F2', name: 'Ledger', key: '2' },
  { id: 'f3', label: 'F3', name: 'Agents', key: '3' },
  { id: 'f4', label: 'F4', name: 'Projects', key: '4' },
  { id: 'f5', label: 'F5', name: 'HQ', key: '5' },
  { id: 'f6', label: 'F6', name: 'Trading Lab', key: '6' },
  { id: 'f7', label: 'F7', name: 'Strategy Lab', key: '7' },
  { id: 'f8', label: 'F8', name: 'Live Trading', key: '8' },
  { id: 'f9', label: 'F9', name: '24x7 Ops', key: '9' },
  { id: 'f10', label: 'F10', name: 'Knowledge', key: '0' },
  { id: 'f11', label: 'F11', name: 'Risk Metrics', key: '-' },
  { id: 'f12', label: 'F12', name: 'Knowledge Graph', key: 'Backspace' },
  { id: 'f13', label: 'F13', name: 'Time Machine', key: '=' },
  { id: 'f14', label: 'F14', name: 'Validation', key: '.' },
];

const SAFE_COMMANDS: CommandResult[] = [
  { id: 'reset-daily-costs', label: 'Reset daily LLM costs', kind: 'safe', detail: 'Safe server action', endpoint: '/api/llm/costs/reset/daily', successMessage: 'Daily LLM costs reset.' },
  { id: 'reset-monthly-costs', label: 'Reset monthly LLM costs', kind: 'safe', detail: 'Safe server action', endpoint: '/api/llm/costs/reset/monthly', successMessage: 'Monthly LLM costs reset.' },
  { id: 'reset-breakers', label: 'Reset LLM circuit breakers', kind: 'safe', detail: 'Safe server action', endpoint: '/api/llm/circuit-breakers/reset', successMessage: 'LLM circuit breakers reset.' },
  { id: 'start-paper', label: 'Start managed paper trading', kind: 'safe', detail: 'Safe server action', endpoint: '/api/polymarket/start', successMessage: 'Managed paper trading start accepted.' },
  { id: 'stop-paper', label: 'Stop managed paper trading', kind: 'safe', detail: 'Safe server action', endpoint: '/api/polymarket/stop', successMessage: 'Managed paper trading stop accepted.' },
  { id: 'start-recovery', label: 'Start recovery engine', kind: 'safe', detail: 'Safe server action', endpoint: '/api/recovery/start', successMessage: 'Recovery engine start accepted.' },
  { id: 'stop-recovery', label: 'Stop recovery engine', kind: 'safe', detail: 'Safe server action', endpoint: '/api/recovery/stop', successMessage: 'Recovery engine stop accepted.' },
];

const UNAVAILABLE_COMMANDS: CommandResult[] = [
  { id: 'restart-agent', label: 'Restart Agent', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'kill-process', label: 'Kill Process', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'new-task', label: 'New Task', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'view-logs', label: 'View Logs', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'switch-model', label: 'Switch Model', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'view-memory', label: 'View Memory', kind: 'unavailable', detail: 'Unavailable: no server action' },
  { id: 'open-terminal', label: 'Open Terminal', kind: 'unavailable', detail: 'Unavailable: no server action' },
];

function responseError(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return 'The server rejected the action.';
}

function navigateToFloor(floor: FloorId) {
  const mapping = FLOORS.find(item => item.id === floor);
  if (!mapping) return;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: mapping.key }));
}

export default function CommandPalette({ onClose, agents }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [status, setStatus] = useState<ActionStatus>({ kind: 'idle', message: '' });

  const results = useMemo(() => {
    const navigation = FLOORS.map(floor => ({
      id: `floor-${floor.id}`,
      label: `Go to ${floor.label} · ${floor.name}`,
      kind: 'navigation' as const,
      detail: 'Navigation',
      floor: floor.id,
    }));
    const agentResults = agents.slice(0, 8).map(agent => ({
      id: `agent-${agent.id}`,
      label: `Open agent · ${agent.name} (${agent.id})`,
      kind: 'agent' as const,
      detail: 'Unavailable: agent drawer navigation is not exposed',
    }));
    const all = [...navigation, ...SAFE_COMMANDS, ...UNAVAILABLE_COMMANDS, ...agentResults];
    const normalized = query.trim().toLowerCase();
    return normalized ? all.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(normalized)).slice(0, 10) : all.slice(0, 10);
  }, [agents, query]);

  useEffect(() => {
    setSelectedIndex(index => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const handleSelect = useCallback(async (item: CommandResult) => {
    if (item.kind === 'navigation' && item.floor) {
      navigateToFloor(item.floor);
      onClose();
      return;
    }
    if (item.kind === 'unavailable' || item.kind === 'agent') {
      setStatus({ kind: 'error', message: item.detail });
      return;
    }
    if (!item.endpoint) return;
    setStatus({ kind: 'loading', message: `Running ${item.label}...` });
    try {
      const response = await fetch(item.endpoint, { method: 'POST' });
      const data = await response.json().catch(() => null) as { ok?: boolean; error?: unknown } | null;
      if (!response.ok || data?.ok === false) throw new Error(responseError(data?.error) || `Server returned ${response.status}.`);
      setStatus({ kind: 'success', message: item.successMessage ?? `${item.label} completed.` });
    } catch (error) {
      setStatus({ kind: 'error', message: `${item.label} failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex(index => Math.min(index + 1, Math.max(results.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(index => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setSelectedIndex(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setSelectedIndex(Math.max(results.length - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = results[selectedIndex];
        if (item) void handleSelect(item);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSelect, onClose, results, selectedIndex]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[600px] max-w-full mx-4 panel overflow-hidden animate-slide-in" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <div className="p-4 border-b border-hud-edge flex items-center gap-3">
          <span id="command-palette-title" className="text-lg font-mono text-hud-amber">⌘K</span>
          <input
            type="text"
            value={query}
            onChange={event => { setQuery(event.target.value); setSelectedIndex(0); }}
            placeholder="Type a command or search agents..."
            className="input flex-1 text-lg font-mono"
            aria-label="Search commands and agents"
            aria-controls="command-results"
            aria-activedescendant={results[selectedIndex] ? `command-${results[selectedIndex].id}` : undefined}
            autoFocus
          />
          <kbd className="bg-hud-edge px-2 py-1 rounded text-xs text-hud-dim">Esc</kbd>
        </div>
        <div id="command-results" role="listbox" className="max-h-[60vh] overflow-y-auto">
          {results.map((item, index) => (
            <button
              key={item.id}
              id={`command-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              aria-disabled={item.kind === 'unavailable' || item.kind === 'agent'}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => void handleSelect(item)}
              className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${index === selectedIndex ? 'bg-hud-surface' : 'hover:bg-hud-surface'} ${item.kind === 'unavailable' || item.kind === 'agent' ? 'opacity-70' : ''}`}
            >
              <span className="font-mono text-xs text-hud-amber w-6">{item.kind === 'navigation' ? item.floor?.toUpperCase() : item.kind === 'safe' ? 'OK' : item.kind === 'agent' ? 'A' : '!'}</span>
              <span className="flex-1">
                <span className="font-mono text-sm block">{item.label}</span>
                <span className="text-[10px] text-hud-dim block mt-0.5">{item.detail}</span>
              </span>
              {item.kind === 'unavailable' || item.kind === 'agent' ? <span className="badge badge-neutral">UNAVAILABLE</span> : item.kind === 'safe' ? <span className="badge badge-info">SAFE</span> : null}
            </button>
          ))}
          {results.length === 0 && <div className="p-6 text-center text-sm text-hud-dim">No commands match this search.</div>}
        </div>
        {status.message && <div className={`px-4 py-2 border-t border-hud-edge text-xs ${status.kind === 'error' ? 'text-hud-red' : status.kind === 'success' ? 'text-hud-green' : 'text-hud-dim'}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</div>}
        <div className="px-4 py-2 border-t border-hud-edge text-xs text-hud-dim flex justify-between">
          <span>↑/↓ Navigate • Enter Select • Esc Close</span>
          <span className="font-mono text-hud-amber">⌘K</span>
        </div>
      </div>
    </div>
  );
}
