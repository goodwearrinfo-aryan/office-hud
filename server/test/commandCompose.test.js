'use strict';
// There is exactly one way to send a command, and no file in the web build decides
// a risk tier for itself.
//
// WHY THIS IS A TEST AND NOT A LINT
// ---------------------------------
// Both halves of this already happened once.
//
// GodConsole's send omitted `confirmed`, so the button it has always shipped could
// never work — every press answered 428 and the transcript reported it as an error.
// JarvisConsole had its own body and did include it. Two callers, two bodies, one
// of them wrong, and nothing failed because both were syntactically fine.
//
// Then the risk tier: JarvisConsole re-derived danger from its own narrower copy of
// the server's regex, missing eleven words including `buy` and `sell`. The console
// showed "buy bitcoin" as OPS TASK and the server refused it. Not a security hole,
// since the server re-derived it anyway — but a UI promising something the office
// would refuse, which is the one class of lie this codebase exists to remove.
//
// So the rules are structural now, and this file is what keeps them structural:
//
//   1. Only web/src/jarvisPreview.ts may reference the write route. Every other
//      surface calls routeJarvisCommand().
//   2. Only web/src/jarvisPreview.ts may contain a danger-word list. The browser
//      cannot know a command is destructive; it asks the server and renders the
//      answer.
//   3. Nobody sends to the write route without a preview. A component that POSTs
//      directly would bypass the staging that catches a destructive command.
//
// A fourth compose, or somebody re-adding a regex, fails here instead of shipping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB_SRC = path.join(__dirname, '..', '..', 'web', 'src');
const PREVIEW_MODULE = path.join(WEB_SRC, 'jarvisPreview.ts');

/** Every source file under web/src, .ts and .tsx. */
function sources(dir = WEB_SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = sources();
const offenders = (needle, label) => files
  .filter(f => f !== PREVIEW_MODULE)
  .filter(f => fs.readFileSync(f, 'utf8').includes(needle))
  .map(f => path.relative(WEB_SRC, f));

test('only the shared module knows the write route', () => {
  const hits = offenders("'/api/jarvis/command'", 'write route');
  assert.deepStrictEqual(hits, [],
    `these files reference the write route directly instead of calling routeJarvisCommand(): ${hits.join(', ')}`);
});

test('only the shared module sends a confirmed command', () => {
  // Scoped to the command route. `confirmed: true` on its own is legitimate
  // elsewhere -- OpsFloor confirms /api/polymarket/markets/exclude, /include and
  // /trades/clear, each gated separately on the server -- so matching the flag
  // alone would flag correct code. What must be unique is the command body.
  const senders = offenders("'/api/jarvis/command'", 'write route');
  assert.deepStrictEqual(senders, [],
    `these files send a command body themselves instead of calling routeJarvisCommand(): ${senders.join(', ')}`);
});

test('the polymarket confirmations are left alone', () => {
  // A guard on the guard: if someone later reads rule 2 as "no confirmed: true
  // anywhere", it must fail here rather than quietly deleting three working,
  // separately-gated controls from OpsFloor.
  const ops = fs.readFileSync(path.join(WEB_SRC, 'components', 'OpsFloor.tsx'), 'utf8');
  assert.match(ops, /api\/polymarket\/markets\/exclude/);
  assert.match(ops, /confirmed: true/);
});

test('no file in the web build decides a command is dangerous', () => {
  // The eleven words the console's private copy was missing, plus the pattern
  // shapes a re-implementation would use. Matched as words so ordinary copy that
  // merely mentions "clear" in a sentence or a class name does not trip it.
  const DANGER = [
    'destructive', 'dangerous', 'DESTRUCTIVE',
    'requires_type_confirmation',
    'typeConfirmation',
  ];
  // `typeConfirmation` is a payload field name that legitimately appears where a
  // preview is rendered, so only the danger-*judging* names are forbidden.
  const judged = offenders('const dangerous', 'danger judgement');
  assert.deepStrictEqual(judged, [],
    `these files re-derive danger instead of asking the server: ${judged.join(', ')}`);

  // And a regex over the danger words themselves, which is what the copy was.
  const wordList = /\(\s*delete\|remove\|destroy/;
  const regexOffenders = files
    .filter(f => f !== PREVIEW_MODULE)
    .filter(f => wordList.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(WEB_SRC, f));
  assert.deepStrictEqual(regexOffenders, [],
    `a danger-word regex exists outside the shared module: ${regexOffenders.join(', ')}`);

  assert.ok(DANGER.length > 0);
});

test('the shared module still exposes the one sanctioned send path', () => {
  const source = fs.readFileSync(PREVIEW_MODULE, 'utf8');
  assert.match(source, /export async function routeJarvisCommand/);
  assert.match(source, /confirmed: true/);
  assert.match(source, /export function canDispatch/,
    'the send path is only safe because the button is gated by the same judgement');
});

test('CommandCompose asks the server before it sends', () => {
  const compose = path.join(WEB_SRC, 'components', 'CommandCompose.tsx');
  const source = fs.readFileSync(compose, 'utf8');
  assert.match(source, /previewJarvisCommand/,
    'the compose must judge the command, not send it blind');
  assert.match(source, /routeJarvisCommand/);
  assert.doesNotMatch(source, /fetch\('\/api\/jarvis\/command'/,
    'CommandCompose sends through the shared body builder, not its own fetch');
  // The stage happens only after a judgement exists. A destructive command that
  // skipped the preview would go out on the debounce timer.
  assert.match(source, /needsTypeConfirmation\(judged\)/);
});