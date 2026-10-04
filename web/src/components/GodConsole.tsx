import { useEffect, useState } from 'react';
import { previewJarvisCommand, ownerLabel, routingLabel } from '../jarvisPreview';
import type { JarvisPreview } from '../api';

interface Props {
  onClose: () => void;
}

export default function GodConsole({ onClose }: Props) {
  const [selectedFloor, setSelectedFloor] = useState<string>('all');
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'assistant' | 'system'; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  // A destructive command needs EXECUTE before it can be queued, and only the
  // server knows which tier a prompt is. So the console asks, and if the answer
  // is destructive it holds the command until the word is typed, rather than
  // sending it and reading the 428 back as a failure.
  const [pending, setPending] = useState<{ prompt: string; preview: JarvisPreview } | null>(null);
  const [typeWord, setTypeWord] = useState('');
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /** The write itself. Kept separate so the staged EXECUTE path sends identically. */
  const sendCommand = async (userPrompt: string, preview: JarvisPreview | null, word: string | null) => {
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
          // This button could never work. The endpoint has required an explicit
          // confirmation since it was added and this call did not send one, so every
          // press answered 428 and the transcript reported it as an error. Sending
          // confirmed blindly is not the fix: a destructive prompt still needs
          // EXECUTE, and only the server knows the tier, so the word sent is
          // whatever the preview said was required -- nothing here decides it.
          confirmed: true,
          typeConfirmation: preview?.requires_type_confirmation ? word : null,
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
      setPending(null);
      setTypeWord('');
    } catch (e) {
      setHistory(h => [...h, { role: 'assistant', content: 'Error: ' + (e as Error).message }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;
    const userPrompt = prompt;
    setHistory(h => [...h, { role: 'user', content: userPrompt }]);
    setPrompt('');
    // Ask what would happen before asking for it to happen. This also reports
    // whether this host may dispatch at all, which is the state an operator
    // reading the mini over a tunnel is actually in.
    const preview = await previewJarvisCommand({ prompt: userPrompt, target: selectedFloor === 'all' ? null : selectedFloor.toUpperCase(), priority: 'normal' });
    if (preview && preview.ok && preview.requires_type_confirmation) {
      setDispatchNote(null);
      setPending({ prompt: userPrompt, preview });
      setTypeWord('');
      return;
    }
    if (preview && preview.ok) {
      setDispatchNote(preview.dispatch.available
        ? `Would route to ${ownerLabel(preview)}${routingLabel(preview) ? ` — ${routingLabel(preview)}` : ''}`
        : preview.blocked_reason || preview.dispatch.requirement);
    }
    await sendCommand(userPrompt, preview, null);
  };

  const confirmPending = () => {
    if (!pending || loading) return;
    if (typeWord.trim().toUpperCase() !== 'EXECUTE') return;
    void sendCommand(pending.prompt, pending.preview, typeWord.trim().toUpperCase());
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
          {/* Staged destructive command. Rendered from the server's own verdict,
              which is why the tier label here is the office's and not the
              browser's guess. */}
          {pending && (
            <div className="jarvis-confirm-card" style={{ margin: '0 1rem 1rem' }}>
              <span>DESTRUCTIVE — needs authorization</span>
              <p>{pending.prompt}</p>
              <div>
                <span>{pending.preview.assigned_agent || 'JEV auto-route'}</span>
                <span>{routingLabel(pending.preview) || 'unrouted'}</span>
                {pending.preview.dispatch.available
                  ? <span className="text-green">dispatch available on {pending.preview.dispatch.host}</span>
                  : <span className="text-alert">cannot dispatch from here</span>}
              </div>
              {!pending.preview.dispatch.available && (
                <p className="text-alert">{pending.preview.blocked_reason || pending.preview.dispatch.requirement}</p>
              )}
              <label className="jarvis-type-confirm">
                Type <strong>EXECUTE</strong> to authorize
                <input value={typeWord} onChange={e => setTypeWord(e.target.value.toUpperCase())} autoComplete="off" />
              </label>
              <div className="jarvis-confirm-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setPending(null); setTypeWord(''); }} disabled={loading}>Cancel</button>
                <button type="button" className="jarvis-confirm-submit" onClick={confirmPending} disabled={loading || typeWord.trim().toUpperCase() !== 'EXECUTE'}>
                  {loading ? 'Routing…' : 'Confirm and route'}
                </button>
              </div>
            </div>
          )}
          {dispatchNote && !pending && (
            <p className="panel-note" style={{ margin: '0 1rem 1rem' }}>{dispatchNote}</p>
          )}
        </div>
      </div>
    </div>
  );
}