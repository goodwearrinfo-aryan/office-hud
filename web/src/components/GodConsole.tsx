import { useEffect, useState } from 'react';
import CommandCompose from './CommandCompose';
import type { JarvisTask } from '../api';

interface Props {
  onClose: () => void;
}

export default function GodConsole({ onClose }: Props) {
  const [selectedFloor, setSelectedFloor] = useState<string>('all');
  const [thinking, setThinking] = useState(false);
  const [history, setHistory] = useState<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleQueued = (task: JarvisTask | null, sent: string) => {
    setHistory(h => [...h, {
      role: 'assistant',
      content: task?.task_id
        ? `Queued ${task.task_id} · ${task.risk === 'destructive' ? 'destructive' : 'ops task'} · ${task.assigned_agent || 'JEV auto-route'}`
        : `Queued · ${sent.slice(0, 80)}`,
    }]);
  };

  const floors = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[90vw] max-w-6xl h-[85vh] panel flex flex-col overflow-hidden animate-slide-in" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-hud-edge">
          <div className="flex items-center gap-3">
            <span className="text-lg font-mono text-hud-amber">GOD</span>
            <span className="font-semibold">Michael -- God Console</span>
            <span className="badge badge-info">NVIDIA nemotron-3-ultra</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedFloor}
              onChange={e => setSelectedFloor(e.target.value)}
              className="input w-40"
            >
              <option value="all">All Floors</option>
              {['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'].map(f => (
                <option key={f} value={f}>{f.toUpperCase()}</option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        {/* Floor Status Grid */}
        <div className="p-4 border-b border-hud-edge h-32 overflow-x-auto">
          <div className="flex gap-4 min-w-max">
            {['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'].map(f => (
              <div key={f} className="w-32 flex-shrink-0 panel p-3">
                <div className="font-mono text-hud-amber text-xs mb-1">{f.toUpperCase()}</div>
                <div className="text-xs text-hud-dim">Agents: 3</div>
                <div className="text-xs text-hud-dim">Tasks: 0/0</div>
                <div className="text-xs text-hud-dim">Cost: $0.00</div>
              </div>
            ))}
          </div>
        </div>

        {/* Chat History */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {history.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[70%] p-3 rounded-xl ${msg.role === 'user' ? 'bg-hud-amber text-hud-bg' : 'panel'}`}>
                <div className="font-mono text-xs text-hud-dim mb-1">
                  {msg.role === 'user' ? 'GOD' : 'MICHAEL'}
                </div>
                <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="panel p-3 animate-pulse-slow">Michael is thinking...</div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-hud-edge">
          {/* Quick Floor Actions */}
          <div className="flex gap-2 mb-2 flex-wrap">
            {floors.map(f => (
              <button
                key={f}
                className={`btn btn-ghost text-xs ${selectedFloor === f ? 'btn-primary' : ''}`}
                onClick={() => setSelectedFloor(f)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <CommandCompose
            target={selectedFloor === 'all' ? null : selectedFloor.toUpperCase()}
            priority="normal"
            placeholder={selectedFloor === 'all' ? 'Broadcast to all floors...' : `Message to ${selectedFloor.toUpperCase()}...`}
            submitLabel="Send"
            className="desk-compose"
            onQueued={handleQueued}
            onBusy={setThinking}
            onError={message => setHistory(h => (message ? [...h, { role: 'assistant', content: 'Error: ' + message }] : h))}
          />
        </div>
      </div>
    </div>
  );
}