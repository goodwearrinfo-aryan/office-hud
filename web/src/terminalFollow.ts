/**
 * Reading a spawned terminal's output without pretending to be a terminal.
 *
 * WHY THIS IS NOT A TTY
 * ---------------------
 * /api/terminals/:id/follow is a server-sent-event stream of a terminal's log, and
 * the temptation is to render it as a shell. It is not a shell: nothing can be
 * typed into it, and an xterm.js canvas would suggest otherwise. So the viewer is a
 * reader, and it says what it is.
 *
 * Why the rules live here: every one of them is a case where a silent failure reads
 * as a quiet terminal. A dropped connection, an unreadable id, an empty buffer —
 * all of them produce a blank box, and a blank box is indistinguishable from a
 * terminal doing nothing. See server/test/terminalFollow.test.ts.
 */

export type FollowState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unavailable';

export interface FollowLine {
  text: string;
  /** True when the server flagged this line as it arrived, not something we know. */
  flagged?: boolean;
}

export interface FollowModel {
  state: FollowState;
  lines: FollowLine[];
  /** Lines dropped from the front because the buffer is bounded. */
  dropped: number;
  /** The server's own message, verbatim, when it is refusing or failing. */
  note: string | null;
}

/** Bounded so a long-running terminal cannot grow the tab without limit. */
export const MAX_LINES = 2000;

export const EMPTY_MODEL: FollowModel = { state: 'idle', lines: [], dropped: 0, note: null };

/**
 * Append lines, keeping the buffer bounded.
 *
 * `dropped` is kept rather than hidden. A ring buffer that silently forgets its
 * oldest lines is showing a partial conversation with no indication, which is the
 * same lie as an empty buffer in a different costume.
 */
export function appendLines(model: FollowModel, incoming: FollowLine[]): FollowModel {
  if (incoming.length === 0) return model;
  const lines = [...model.lines, ...incoming];
  let dropped = model.dropped;
  if (lines.length > MAX_LINES) {
    dropped += lines.length - MAX_LINES;
    return { ...model, lines: lines.slice(lines.length - MAX_LINES), dropped };
  }
  return { ...model, lines };
}

/**
 * Parse one SSE frame.
 *
 * The stream sends `event: hello` then data frames carrying `{ at, lines }`. A
 * frame we cannot parse is reported rather than dropped, because an unparsed frame
 * is output we are refusing to show and the viewer must not pretend it is empty.
 */
export function parseFrame(raw: string): {
  kind: 'hello' | 'lines' | 'end' | 'unparsed';
  payload?: { id?: string; status?: string; at?: number; lines?: string[] };
} {
  const text = raw.trim();
  if (!text) return { kind: 'unparsed' };
  if (text.includes('event: end')) return { kind: 'end' };
  if (text.includes('event: hello')) {
    const data = dataOf(text);
    if (!data) return { kind: 'hello' };
    try {
      return { kind: 'hello', payload: JSON.parse(data) as { id?: string; status?: string } };
    } catch {
      return { kind: 'unparsed' };
    }
  }
  const data = dataOf(text);
  if (!data) return { kind: 'unparsed' };
  try {
    return { kind: 'lines', payload: JSON.parse(data) as { at?: number; lines?: string[] } };
  } catch {
    return { kind: 'unparsed' };
  }
}

function dataOf(frame: string): string | null {
  const match = frame.split('\n').find(line => line.startsWith('data:'));
  if (!match) return null;
  return match.slice(5).trim();
}

/** Reduce a parsed frame onto the model. The only place the model changes shape. */
export function reduce(model: FollowModel, frame: ReturnType<typeof parseFrame>): FollowModel {
  switch (frame.kind) {
    case 'hello':
      return { ...model, state: 'live', note: frame.payload?.status ? `terminal ${frame.payload.status}` : null };
    case 'lines':
      return appendLines({ ...model, state: 'live' }, (frame.payload?.lines ?? []).map(text => ({ text })));
    case 'end':
      return { ...model, state: 'closed', note: model.note ?? 'The terminal ended.' };
    case 'unparsed':
    default:
      return { ...model, note: 'A frame from the stream could not be read, so it is not shown.' };
  }
}

/**
 * What the pane says when there is nothing to show.
 *
 * Every branch names a cause. There is deliberately no branch that renders an empty
 * box, because an empty box reads as "the terminal is quiet" and would be a claim
 * about a machine nobody is watching.
 */
export function emptyStateText(model: FollowModel, terminalCount: number): string | null {
  if (model.state === 'unavailable') return model.note ?? 'No terminal is available to read.';
  if (model.state === 'connecting') return 'Connecting to the terminal stream…';
  if (model.state === 'reconnecting') return 'The stream dropped. Reconnecting — output during the gap is not recovered.';
  if (model.state === 'closed') return model.note ?? 'The terminal has ended.';
  if (model.lines.length > 0) return null;
  if (terminalCount === 0) return 'This HUD has started no terminals, so there is no output to read.';
  if (model.state === 'live') return 'Connected. The terminal has produced no output yet.';
  return 'Not attached to a terminal.';
}