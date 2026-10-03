import { useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
}

export default function GodConsole({ onClose }: Props) {
  const [selectedFloor, setSelectedFloor] = useState<string>('all');
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;
    const userPrompt = prompt;
    setHistory(h => [...h, { role: 'user', content: userPrompt }]);
    setPrompt('');
    setLoading(true);
    try {
        // Was POSTing to /api/llm/test, which is the provider smoke test: it ran a
        // reasoning call and returned the model's answer, so the transcript showed a
        // reply as though the selected floor had answered. Nothing was delivered, and
        // selectedFloor never left the browser. /api/jarvis/command is the endpoint
        // that actually enqueues work for a target, and it is rate limited, which is
        // the right shape for a button an operator can press repeatedly.
        const res = await fetch('/api/jarvis/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: userPrompt,
            target: selectedFloor === 'all' ? null : selectedFloor.toUpperCase(),
            priority: 'normal',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const why = data?.error?.message || data?.error || `HTTP ${res.status}`;
          setHistory(h => [...h, { role: 'assistant', content: 'Error: ' + why }]);
        } else if (data.task) {
          setHistory(h => [...h, { role: 'assistant', content: `Queued ${data.task.type || 'command'}${data.task.id ? ` · ${data.task.id}` : ''}` }]);
        } else {
          setHistory(h => [...h, { role: 'assistant', content: 'Command accepted.' }]);
        }
    } catch (e) {
      setHistory(h => [...h, { role: 'assistant', content: 'Error: ' + (e as Error).message }]);
    } finally {
      setLoading(false);
    }
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
            <span className="font-semibold">Michael — God Console</span>
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
          {loading && (
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
                onClick={() => { setSelectedFloor(f); setPrompt(`[GOD → ${f.toUpperCase()}] `); }}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={selectedFloor === 'all' ? 'Broadcast to all floors...' : `Message to ${selectedFloor.toUpperCase()}...`}
              className="input flex-1"
              disabled={loading}
            />
            <button type="submit" className="btn btn-primary" disabled={loading || !prompt.trim()}>
              {loading ? 'Sending...' : 'Send'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          </form>
        </div>
      </div>
    </div>
  );
}