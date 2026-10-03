'use strict';
// The redactor's real job is restraint. A redactor that eats `--port 4096` or
// `/Users/a/app.js` makes the terminal view useless, and a view nobody trusts is
// a view people route around — so "did we mask enough" is only half the
// contract. The other half is "did we mask without eating the command".
//
// server/test/redact.test.js covers the served-payload behaviour end to end.
// These cover the helper directly, including the shapes that only show up in
// real command lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  redactCommand, redactEntry, redactAll, redactArgv, isSecretName, MASK,
} = require('../lib/redact.js');

// Token-shaped fixtures are assembled at runtime rather than written as literals.
// They are synthetic, but a literal `ghp_`/`nvapi-` string in a committed file
// looks exactly like a leaked credential to a repo scanner or to GitHub push
// protection, and either can block an unrelated push.
const SECRET = ['sk', 'abc123'].join('-');
const GH_TOKEN = ['ghp', 'abcdefghijklmnop1234'].join('_');
const NV_KEY = ['nvapi', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

// --------------------------------------------------------------- must mask

test('assignment form masks the value and keeps the name', () => {
  assert.equal(redactCommand(`zsh --api-key=${SECRET}`), 'zsh --api-key=***');
  assert.equal(redactCommand('sh MY_SECRET=hunter2'), 'sh MY_SECRET=***');
});

test('space-separated flag form is masked and normalised to =', () => {
  assert.equal(redactCommand('zsh --token xyz789'), 'zsh --token=***');
});

test('the original secret is absent from the output, not merely shortened', () => {
  for (const cmd of [
    `zsh --api-key=${SECRET}`,
    'zsh --token xyz789',
    'sh MY_SECRET=hunter2',
    `export GITHUB_TOKEN=${GH_TOKEN}`,
  ]) {
    const out = redactCommand(cmd);
    assert.doesNotMatch(out, /abc123/, `"${cmd}" leaked`);
    assert.doesNotMatch(out, /xyz789/, `"${cmd}" leaked`);
    assert.doesNotMatch(out, /hunter2/, `"${cmd}" leaked`);
    assert.doesNotMatch(out, new RegExp(GH_TOKEN), `"${cmd}" leaked`);
  }
});

// REGRESSION. A single combined `(\w+)(\s+)(\S+)` pattern matches the whole of
// `zsh --api-key=sk-abc123` as name=`zsh`, sep=space, value=`--api-key=...`,
// sees a non-secret name and returns the line untouched — leaking the key while
// appearing to work. This asserts the greedy trap stays closed.
test('a credential behind another word is still masked, not swallowed whole', () => {
  const out = redactCommand(`zsh --api-key=${SECRET}`);
  assert.notEqual(out, `zsh --api-key=${SECRET}`, 'the greedy-match trap must not return');
  assert.match(out, /api-key=\*\*\*/);
});

test('a key-shaped value is masked even under an innocent name', () => {
  assert.equal(redactCommand(`export GITHUB_TOKEN=${GH_TOKEN}`), 'export GITHUB_TOKEN=***');
  assert.equal(redactCommand(`run ${NV_KEY}`), 'run ***');
  assert.equal(redactCommand(`use ${AWS_KEY}`), 'use ***');
});

test('a quoted secret keeps its quotes so the command still reads correctly', () => {
  const out = redactCommand('curl --token "abc def 123"');
  assert.match(out, /token="\*\*\*"/);
  assert.doesNotMatch(out, /abc def/);
});

// ------------------------------------------------------- must NOT over-mask

test('ordinary flags and paths survive untouched', () => {
  const safe = [
    'sh --port 4096 --verbose /Users/a/app.js',
    'npm run build',
    'python3 -m pytest --version',
    'ssh a@macmini',
    'node --test server/test/*.test.js',
    'ruff check server/lib/redact.js',
    'git commit -m "fix the parser"',
    'ls -la /Users/aryanagarwal/openalice-fleet',
  ];
  for (const cmd of safe) {
    assert.equal(redactCommand(cmd), cmd, `"${cmd}" should not be touched`);
  }
});

test('a positional that follows a non-secret flag is not treated as its value', () => {
  // `--verbose /Users/a/app.js` must keep both parts.
  assert.equal(redactCommand('sh --verbose /Users/a/app.js'), 'sh --verbose /Users/a/app.js');
});

test('isSecretName separates credential words from ordinary ones', () => {
  for (const name of ['api-key', 'api_key', 'APIKEY', 'token', 'MY_SECRET', 'password', 'auth_token']) {
    assert.equal(isSecretName(name), true, `${name} should be treated as a credential`);
  }
  for (const name of ['port', 'verbose', 'host', 'user', 'config', 'name', 'path']) {
    assert.equal(isSecretName(name), false, `${name} should not be treated as a credential`);
  }
});

// -------------------------------------------------------------- edge shapes

test('non-strings and empty input pass through unchanged', () => {
  assert.equal(redactCommand(''), '');
  assert.equal(redactCommand(undefined), undefined);
  assert.equal(redactCommand(null), null);
  assert.equal(redactCommand(42), 42);
});

test('redactEntry masks command, cmd, and argv but leaves everything else alone', () => {
  const entry = redactEntry({
    pid: 7, name: 'zsh', kind: 'shell',
    command: `zsh --api-key=${SECRET}`,
    cmd: 'sh --token xyz789',
    args: ['--port', '4096', '--api-key', SECRET],
    untouched: { nested: true },
  });
  assert.equal(entry.pid, 7);
  assert.equal(entry.name, 'zsh');
  assert.equal(entry.command, 'zsh --api-key=***');
  assert.equal(entry.cmd, 'sh --token=***');
  assert.deepEqual(entry.args, ['--port', '4096', '--api-key', '***'], 'argv keeps its positions and the value element is masked');
  assert.deepEqual(entry.untouched, { nested: true });
});

test('redactEntry tolerates a missing or non-object entry', () => {
  assert.equal(redactEntry(null), null);
  assert.equal(redactEntry(undefined), undefined);
  assert.equal(redactEntry('a string'), 'a string');
  assert.deepEqual(redactEntry({ pid: 1 }), { pid: 1 });
});

test('redactAll preserves order and length', () => {
  const out = redactAll([{ pid: 1, command: 'sh --port 1' }, { pid: 2 }, 'raw', null]);
  assert.equal(out.length, 4);
  assert.equal(out[0].command, 'sh --port 1');
  assert.deepEqual(out[1], { pid: 2 });
  assert.equal(out[2], 'raw');
  assert.equal(out[3], null);
});

test('redactAll returns non-arrays untouched rather than throwing', () => {
  assert.equal(redactAll(null), null);
  assert.equal(redactAll(undefined), undefined);
});

test('MASK is the single mask token used everywhere', () => {
  assert.equal(MASK, '***');
  assert.ok(redactCommand('sh --token x').includes(MASK));
});

// REGRESSION. `['--api-key', 'sk-abc123']` is how most tools actually take a
// secret. Mapping each element on its own leaves the value completely exposed:
// the flag has no value attached and the bare value has no name to judge it by.
test('a credential flag and its value are masked across two argv elements', () => {
  const argv = redactArgv(['--port', '4096', '--api-key', 'sk-abc123']);
  assert.deepEqual(argv, ['--port', '4096', '--api-key', '***']);
  assert.ok(!argv.includes('sk-abc123'), 'the value element must not survive');
});

test('a trailing credential flag with no value does not consume anything', () => {
  assert.deepEqual(redactArgv(['--verbose', '--api-key']), ['--verbose', '--api-key']);
});

test('a non-credential flag does not swallow the next element', () => {
  assert.deepEqual(redactArgv(['--port', '4096']), ['--port', '4096']);
  assert.deepEqual(redactArgv(['-c', 'opencode']), ['-c', 'opencode']);
});

test('redactCommand is idempotent, so a re-served payload does not accumulate masks', () => {
  const once = redactCommand(`zsh --api-key=${SECRET}`);
  assert.equal(redactCommand(once), once);
});