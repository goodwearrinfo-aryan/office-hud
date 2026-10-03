'use strict';
// Log capture has to be bounded: fifty spawned terminals that each write an
// unbounded log would fill the disk, and a tail that reads the whole file would
// put a 10MB log in memory per request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logstore = require('../lib/terminal/logstore');

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-logs-')); });
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const opts = () => ({ dir });

test('append then tail returns what was written', () => {
  logstore.append('t1', 'hello\nworld\n', opts());
  const result = logstore.tail('t1', opts());
  assert.deepEqual(result.lines, ['hello', 'world']);
  assert.equal(result.missing, false);
});

test('a missing log is an empty result, not a throw', () => {
  const result = logstore.tail('never-written', opts());
  assert.deepEqual(result.lines, []);
  assert.equal(result.missing, true);
});

test('tail keeps only the last N lines', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  logstore.append('t1', `${many}\n`, opts());
  const result = logstore.tail('t1', { ...opts(), lines: 10 });
  assert.equal(result.lines.length, 10);
  assert.equal(result.lines[9], 'line 499');
  assert.equal(result.truncated, true);
});

test('rotation bounds the file at maxBytes and keeps maxFiles generations', () => {
  const options = { ...opts(), maxBytes: 1024, maxFiles: 2 };
  for (let i = 0; i < 40; i++) logstore.append('t1', `${'x'.repeat(200)}\n`, options);
  const base = logstore.logPath('t1', options);
  // The live file stays under the cap...
  assert.ok(fs.statSync(base).size <= options.maxBytes + 200, 'live file respects maxBytes');
  // ...and at most maxFiles rotated generations exist.
  for (let i = 1; i <= 2; i++) {
    assert.ok(fs.existsSync(`${base}.${i}`), `.${i} exists`);
  }
  assert.equal(fs.existsSync(`${base}.3`), false, 'older generations are dropped, not accumulated');
});

test('tail reads from the end by offset, not the whole file', () => {
  logstore.append('t1', 'a\n'.repeat(100000), opts());
  const result = logstore.tail('t1', { ...opts(), lines: 5, maxTailBytes: 1024 });
  assert.equal(result.lines.length, 5);
  assert.equal(result.truncated, true);
  assert.ok(result.bytes > 1024, 'the file really is bigger than the read window');
});

test('readSince only returns what is new', () => {
  logstore.append('t1', 'first\n', opts());
  const at = logstore.cursor('t1', opts());
  assert.ok(at > 0);
  const nothing = logstore.readSince('t1', at, opts());
  assert.equal(nothing.chunk, '');
  logstore.append('t1', 'second\n', opts());
  const more = logstore.readSince('t1', at, opts());
  assert.equal(more.chunk, 'second\n');
  assert.ok(more.at > at);
});

test('readSince tolerates a cursor beyond the current size', () => {
  logstore.append('t1', 'short\n', opts());
  // A restart can reset the client cursor to a stale larger offset; that must
  // read nothing rather than throw or spin.
  const result = logstore.readSince('t1', 999999, opts());
  assert.equal(result.chunk, '');
});

test('an unsafe id cannot escape the log directory', () => {
  assert.throws(() => logstore.logPath('../../etc/passwd', opts()), /unsafe terminal id/);
  assert.throws(() => logstore.logPath('a/b', opts()), /unsafe terminal id/);
  // A plain id resolves inside the configured directory.
  const resolved = logstore.logPath('term_abc123', opts());
  assert.equal(path.dirname(resolved), dir);
});

test('remove clears the live file and every rotation', () => {
  const options = { ...opts(), maxBytes: 512, maxFiles: 2 };
  for (let i = 0; i < 20; i++) logstore.append('t1', 'y'.repeat(200), options);
  logstore.remove('t1', options);
  const base = logstore.logPath('t1', options);
  assert.equal(fs.existsSync(base), false);
  assert.equal(fs.existsSync(`${base}.1`), false);
  assert.equal(fs.existsSync(`${base}.2`), false);
  // Removing something already gone is not an error: reap races with cleanup.
  logstore.remove('t1', options);
});

test('usage reports the directory total for the health route', () => {
  logstore.append('t1', 'abc', opts());
  logstore.append('t2', 'de', opts());
  const usage = logstore.usage(opts());
  assert.equal(usage.files, 2);
  assert.equal(usage.bytes, 5);
  assert.deepEqual(logstore.usage({ dir: path.join(dir, 'nope') }), { files: 0, bytes: 0 });
});

test('a partial trailing line is still returned', () => {
  // Output that has not ended in a newline is normal while a process runs.
  logstore.append('t1', 'no trailing newline', opts());
  const result = logstore.tail('t1', opts());
  assert.deepEqual(result.lines, ['no trailing newline']);
});