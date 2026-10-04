/**
 * The follow viewer's rules.
 *
 * Every case is a way the pane could show nothing and be read as a quiet terminal.
 * A blank box is the failure this file exists to prevent: it is what a dropped
 * connection, an unreadable id, a corrupt frame and a genuinely idle terminal all
 * look like, and only one of them means the terminal has nothing to say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_MODEL,
  MAX_LINES,
  appendLines,
  emptyStateText,
  parseFrame,
  reduce,
} from '../../web/src/terminalFollow.ts';

const frame = (lines: string[], at = 1) => `data: ${JSON.stringify({ at, lines })}\n\n`;

test('hello is the frame that makes the stream live', () => {
  const parsed = parseFrame('event: hello\ndata: {"id":"term-1","status":"running"}\n\n');
  assert.equal(parsed.kind, 'hello');
  const model = reduce(EMPTY_MODEL, parsed);
  assert.equal(model.state, 'live');
  assert.equal(model.note, 'terminal running');
});

test('a data frame appends lines and marks the stream live', () => {
  const model = reduce(EMPTY_MODEL, parseFrame(frame(['first', 'second'], 7)));
  assert.equal(model.state, 'live');
  assert.deepEqual(model.lines.map(l => l.text), ['first', 'second']);
  assert.equal(model.dropped, 0);
});

test('a frame we cannot parse is reported, never silently dropped', () => {
  // Dropping it would render an empty pane that reads as an idle terminal.
  const model = reduce(EMPTY_MODEL, parseFrame('data: {not json\n\n'));
  assert.deepEqual(model.lines, []);
  assert.match(model.note ?? '', /could not be read/);
});

test('an end frame closes the stream and says so', () => {
  const model = reduce(reduce(EMPTY_MODEL, parseFrame(frame(['x']))), parseFrame('event: end\ndata: {}\n\n'));
  assert.equal(model.state, 'closed');
  assert.match(model.note ?? '', /ended/);
  assert.deepEqual(model.lines.map(l => l.text), ['x'], 'output already read is kept after the end');
});

test('the buffer is bounded and says how much it forgot', () => {
  const many = Array.from({ length: MAX_LINES + 25 }, (_, i) => `line ${i}`);
  const model = appendLines(EMPTY_MODEL, many.map(text => ({ text })));
  assert.equal(model.lines.length, MAX_LINES);
  assert.equal(model.dropped, 25);
  assert.equal(model.lines[0].text, 'line 25', 'keeps the newest');
  assert.equal(model.lines.at(-1)?.text, `line ${many.length - 1}`);
});

test('dropped counts accumulate across frames rather than resetting', () => {
  const first = appendLines(EMPTY_MODEL, Array.from({ length: MAX_LINES + 5 }, (_, i) => ({ text: `a${i}` })));
  assert.equal(first.dropped, 5);
  // 5, then another 2007 are pushed out: the buffer holds MAX_LINES plus the 2007
  // new ones, and the tail is kept. The earlier 5 are gone from the array but stay
  // counted, because the pane reports lines it is not showing and the count has to
  // be cumulative to be honest.
  const second = appendLines(first, Array.from({ length: MAX_LINES + 7 }, (_, i) => ({ text: `b${i}` })));
  assert.equal(second.dropped, 5 + (MAX_LINES + 7));
  assert.equal(second.lines.length, MAX_LINES);
  assert.equal(second.lines[0].text, 'b7');
});

test('an empty pane always names a cause', () => {
  // The branch that matters: no terminal exists, which is not the same claim as a
  // terminal that exists and is quiet.
  assert.match(emptyStateText(EMPTY_MODEL, 0) ?? '', /started no terminals/);
  assert.match(emptyStateText({ ...EMPTY_MODEL, state: 'live' }, 1) ?? '', /produced no output yet/);
  assert.match(emptyStateText({ ...EMPTY_MODEL, state: 'connecting' }, 1) ?? '', /Connecting/);
  assert.match(emptyStateText({ ...EMPTY_MODEL, state: 'reconnecting' }, 1) ?? '', /not recovered/);
  assert.match(emptyStateText({ ...EMPTY_MODEL, state: 'closed' }, 1) ?? '', /ended/);
  assert.match(emptyStateText({ ...EMPTY_MODEL, state: 'unavailable', note: '404 unknown_terminal' }, 1) ?? '',
    /unknown_terminal/);
});

test('once there is output the pane stops apologising', () => {
  const model = reduce(EMPTY_MODEL, parseFrame(frame(['something happened'])));
  assert.equal(emptyStateText(model, 1), null);
});

test('a dropped stream keeps saying so even after output has been shown', () => {
  // The stream resumes from a cursor, so lines during the gap are gone. The pane
  // therefore does NOT go quiet once it has output: an operator reading a frozen
  // screen with no notice would take a dropped stream for a finished one.
  const model = { ...EMPTY_MODEL, state: 'reconnecting' as const, lines: [{ text: 'before' }] };
  assert.match(emptyStateText(model, 1) ?? '', /not recovered/);
  // And with the stream healthy again the note clears, because the caveat expired.
  const healed = reduce(model, parseFrame('event: hello\ndata: {"id":"t","status":"running"}\n\n'));
  assert.equal(emptyStateText(healed, 1), null);
});

test('an empty frame is unparsed rather than an empty success', () => {
  assert.equal(parseFrame('').kind, 'unparsed');
  assert.equal(parseFrame('   ').kind, 'unparsed');
});

test('a frame with no data line carries nothing and says so', () => {
  const parsed = parseFrame('event: something\n\n');
  assert.equal(parsed.kind, 'unparsed');
});