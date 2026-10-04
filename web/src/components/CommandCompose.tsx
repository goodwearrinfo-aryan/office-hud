import { useCallback, useEffect, useRef, useState } from 'react';
import type { JarvisPreview, JarvisTask } from '../api';
import { canDispatch, needsTypeConfirmation, ownerLabel, previewJarvisCommand, riskLabel, routingLabel, routeJarvisCommand, writeErrorReason } from '../jarvisPreview';

/**
 * The one way a command gets sent from this codebase.
 *
 * WHY A COMPONENT FOR IT
 * ----------------------
 * There were three compose flows — GodConsole's staged card, JarvisConsole's modal,
 * and (planned) the desk — and the first two had already drifted apart once. The
 * risk tier was re-derived in the browser from a private copy of the danger rule,
 * which is how a command got labelled OPS TASK and then refused with a 428. The
 * copy is gone now, but the *shape* of the bug was three UIs each deciding when
 * to ask the server and what to do with the answer.
 *
 * So this component owns the whole sequence and owns nothing else: ask the server
 * what would happen, stage the destructive ones until EXECUTE is typed, send the
 * same request either way, and report what came back. Every surface renders its own
 * chrome around it.
 *
 * The invariant it protects: there is exactly one place that turns typed text into
 * a queued task, and it never decides a risk tier locally. server/test/
 * commandCompose.test.ts pins that structurally, so a fourth compose cannot appear
 * without failing the suite.
 */

export interface CommandComposeProps {
  /** Fixed target, e.g. a floor id. Omit for JEV auto-routing. */
  target?: string | null;
  priority?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Compact renders the input row only, with the confirm card inline. */
  compact?: boolean;
  className?: string;
  disabled?: boolean;
  onQueued: (task: JarvisTask | null, prompt: string) => void;
  onError: (message: string | null) => void;
  /** Fired with the preview for every change, so a host surface can show state. */
  onPreview?: (preview: JarvisPreview | null) => void;
  /** Fired around the write itself, so a host can show that it is in flight. */
  onBusy?: (busy: boolean) => void;
}

const PREVIEW_DEBOUNCE_MS = 250;

export default function CommandCompose({
  target = null,
  priority = 'high',
  placeholder = 'Give the office an instruction…',
  submitLabel = 'Route it',
  compact = false,
  className = '',
  disabled = false,
  onQueued,
  onError,
  onPreview,
  onBusy,
}: CommandComposeProps) {
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<JarvisPreview | null>(null);
  const [staged, setStaged] = useState(false);
  const [typeWord, setTypeWord] = useState('');
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  // Ask the server as the operator types, debounced, and ignore the answer to a
  // prompt that has since changed. Without the sequence check a slow response for
  // "rm -rf" can land after "refresh the snapshot" and stage the wrong tier — the
  // original drift, arriving by a different road.
  const ask = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      onPreview?.(null);
      return;
    }
    const seq = ++requestSeq.current;
    void previewJarvisCommand({ prompt: trimmed, target, priority }).then((answer) => {
      if (seq !== requestSeq.current) return;
      setPreview(answer);
      onPreview?.(answer);
    });
  }, [target, priority, onPreview]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onPromptChange = (value: string) => {
    setPrompt(value);
    setStaged(false);
    setTypeWord('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ask(value), PREVIEW_DEBOUNCE_MS);
  };

  const send = async (text: string, judged: JarvisPreview | null, word: string | null) => {
    setSending(true);
    onBusy?.(true);
    onError(null);
    try {
      const result = await routeJarvisCommand({ prompt: text, target, priority }, judged, word);
      if (!result.ok) {
        onError(writeErrorReason(result) ?? 'The office refused the command.');
        return;
      }
      setPrompt('');
      setStaged(false);
      setTypeWord('');
      setPreview(null);
      onPreview?.(null);
      onQueued((result.data?.task ?? null) as JarvisTask | null, text);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to route the command');
    } finally {
      setSending(false);
      onBusy?.(false);
    }
  };

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || sending || disabled) return;
    // Judge it if the debounce has not landed yet, so a fast submit cannot skip
    // the question and send a destructive command untyped.
    let judged = preview;
    if (!judged || judged.prompt !== trimmed) {
      judged = await previewJarvisCommand({ prompt: trimmed, target, priority });
      setPreview(judged);
      onPreview?.(judged);
    }
    if (!judged) {
      onError('The office could not be asked whether this command is safe, so it was not sent.');
      return;
    }
    if (needsTypeConfirmation(judged)) {
      setStaged(true);
      setTypeWord('');
      return;
    }
    await send(trimmed, judged, null);
  };

  const gate = canDispatch(preview, typeWord);
  const destructive = needsTypeConfirmation(preview);
  const canSubmit = !sending && !disabled && prompt.trim().length > 0;

  const confirmCard = staged && (
    <div className="jarvis-confirm-card" style={compact ? { margin: '0.5rem 0 0' } : undefined}>
      <span>DESTRUCTIVE — needs authorization</span>
      <p>{prompt.trim()}</p>
      <div>
        <span>{ownerLabel(preview)}</span>
        <span>{priority}</span>
        <span className={riskLabel(preview) === 'DESTRUCTIVE' ? 'text-alert' : 'text-hud-amber'}>{riskLabel(preview)}</span>
      </div>
      {routingLabel(preview) && <div className="jarvis-confirm-routing">{routingLabel(preview)}</div>}
      {preview && !preview.dispatch.available && (
        <p className="jarvis-dispatch-blocked">{preview.blocked_reason || preview.dispatch.requirement}</p>
      )}
      <label className="jarvis-type-confirm">
        Type <strong>EXECUTE</strong> to authorize
        <input value={typeWord} onChange={event => setTypeWord(event.target.value.toUpperCase())} autoComplete="off" />
      </label>
      <div className="jarvis-confirm-actions">
        <button type="button" className="btn btn-ghost" onClick={() => { setStaged(false); setTypeWord(''); }} disabled={sending}>Cancel</button>
        <button
          type="button"
          className="jarvis-confirm-submit"
          onClick={() => { if (gate.allowed) void send(prompt.trim(), preview, typeWord.trim().toUpperCase()); }}
          disabled={!gate.allowed || sending}
        >
          {sending ? 'Routing…' : 'Confirm and route'}
        </button>
      </div>
    </div>
  );

  return (
    <div className={className}>
      <div className="flex gap-2">
        <input
          type="text"
          value={prompt}
          onChange={event => onPromptChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }}
          placeholder={placeholder}
          className="input flex-1"
          disabled={disabled || sending}
        />
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
          {sending ? 'Sending…' : submitLabel}
        </button>
      </div>
      {!staged && preview && preview.ok && (
        <p className="panel-note" style={{ margin: '0.25rem 0 0' }}>
          {`Would route to ${ownerLabel(preview)}`}
          {routingLabel(preview) ? ` — ${routingLabel(preview)}` : ''}
          {` · ${riskLabel(preview)}`}
        </p>
      )}
      {!staged && preview && !preview.dispatch.available && (
        <p className="panel-note text-alert" style={{ margin: '0.25rem 0 0' }}>
          {preview.blocked_reason || preview.dispatch.requirement}
        </p>
      )}
      {destructive && !staged && preview?.ok && (
        <p className="panel-note" style={{ margin: '0.25rem 0 0' }}>
          This one needs <strong>EXECUTE</strong> before it can be queued.
        </p>
      )}
      {confirmCard}
    </div>
  );
}