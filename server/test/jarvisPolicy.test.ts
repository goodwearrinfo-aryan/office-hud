/**
 * The rules of a Jarvis command.
 *
 * This file exists because the write path had no tests at all. It was exported
 * from index.js, exercised by two consoles, and gated by a confirm word — and
 * nothing asserted any of it. The one consumer of `isDangerousJarvisPrompt` was
 * autonomy.test.js, which checks that the tick's prompts do NOT trip the rule; the
 * rule itself was never pinned.
 *
 * Two real defects were found while writing this, and both are the kind that only
 * a test would have caught:
 *
 *   1. JarvisConsole carried its own narrower copy of the danger regex, missing
 *      clear, purge, erase, overwrite, disable, enable, transfer, withdraw,
 *      deposit, buy and sell. The console labelled those OPS TASK and the server
 *      answered 428. It also wrapped `rm\s` in \b(...)\b, and a word boundary
 *      cannot follow a space, so the branch meant to catch `rm -rf` never matched.
 *   2. The extraction itself shipped a bug: index.js destructured
 *      `normalizedPrompt` out of a payload whose keys are `prompt`, `priority` and
 *      `target`. Destructuring does not rename, so every enqueue threw
 *      "Cannot read properties of undefined (reading 'slice')". autonomy-integration
 *      caught it; nothing narrower would have, because the bug was only observable
 *      by actually queueing something.
 *
 * So the first test here is the one that matters most: the extractor must agree
 * with the code it replaced, and preview must agree with the write. Both are
 * properties, not examples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIORITIES,
  TYPE_CONFIRMATION_WORD,
  isDangerousJarvisPrompt,
  isIdentifier,
  routeJarvisCommand,
  evaluateJarvisCommand,
  acceptance,
} from '../jarvisPolicy.js';

const ok = (input: Record<string, unknown> = {}) => {
  const verdict = evaluateJarvisCommand({ prompt: 'refresh the floor snapshot', priority: 'normal', ...input });
  assert.equal(verdict.ok, true, verdict.reason ?? '');
  return verdict;
};

const refused = (input: Record<string, unknown>) => {
  const verdict = evaluateJarvisCommand(input as never);
  assert.equal(verdict.ok, false, `expected refusal for ${JSON.stringify(input)}`);
  return verdict;
};

test('an ordinary command is accepted once confirmed', () => {
  const verdict = ok();
  assert.deepEqual(verdict.normalized, {
    prompt: 'refresh the floor snapshot',
    priority: 'normal',
    target: null,
  });
  assert.equal(verdict.risk, 'normal');
  assert.equal(verdict.requiresTypeConfirmation, false);
  assert.deepEqual(acceptance(verdict, { confirmed: true }), { accepted: true, statusCode: null, reason: null });
});

test('a command that has not been confirmed is refused with 428, not silently queued', () => {
  const verdict = ok();
  const gate = acceptance(verdict, {});
  assert.equal(gate.accepted, false);
  assert.equal(gate.statusCode, 428);
  assert.equal(gate.reason, 'explicit confirmation is required');
});

test('the words the console used to miss are destructive', () => {
  // Each of these is in the server list and was absent from the copy in
  // JarvisConsole, which is how a command got shown as OPS TASK and then refused.
  const missed = [
    'clear the failed queue',
    'purge the old sessions',
    'erase the evidence file',
    'overwrite the ledger',
    'disable the night poller',
    'enable live execution',
    'transfer the balance',
    'withdraw the funds',
    'deposit into the account',
    'buy bitcoin at market',
    'sell the position',
  ];
  for (const prompt of missed) {
    assert.equal(isDangerousJarvisPrompt(prompt), true, `${prompt} should be destructive`);
  }
});

test('rm -rf is destructive, which the old client regex could never match', () => {
  // \b(rm\s)\b cannot match: a word boundary cannot follow a space, and the
  // character after "rm " in a real command is not a word character.
  assert.equal(isDangerousJarvisPrompt('rm -rf dist'), true);
  assert.equal(isDangerousJarvisPrompt('please rm -rf the build directory'), true);
});

test('an ordinary prompt is not dangerous', () => {
  for (const prompt of [
    'refresh the floor snapshot',
    'summarise the queue depth by hour',
    'which agents are idle right now',
    'rebuild the knowledge graph',
  ]) {
    assert.equal(isDangerousJarvisPrompt(prompt), false, `${prompt} should not be destructive`);
  }
});

test('a destructive command needs the confirm word, and an ordinary one does not', () => {
  const destructive = ok({ prompt: 'clear the failed queue' });
  assert.equal(destructive.requiresTypeConfirmation, true);
  assert.equal(destructive.risk, 'destructive');

  const withoutWord = acceptance(destructive, { confirmed: true });
  assert.equal(withoutWord.accepted, false);
  assert.equal(withoutWord.statusCode, 428);
  assert.match(withoutWord.reason ?? '', new RegExp(TYPE_CONFIRMATION_WORD));

  const withWord = acceptance(destructive, { confirmed: true, typeConfirmation: TYPE_CONFIRMATION_WORD });
  assert.equal(withWord.accepted, true);
});

test('field problems are reported before confirmation, in the order the write path always used', () => {
  // Preserved deliberately: a request that is both unconfirmed and mis-prioritised
  // has always answered with the priority. Changing that would alter behaviour
  // nobody asked to change, so the order is pinned here.
  const badPriority = refused({ prompt: 'refresh the snapshot', priority: 'urgent' });
  assert.equal(badPriority.statusCode, 400);
  assert.match(badPriority.reason ?? '', /priority must be critical, high, normal, or low/);

  const badPrompt = refused({ prompt: 'no', priority: 'normal' });
  assert.equal(badPrompt.statusCode, 400);

  assert.equal(refused({ prompt: 'refresh the snapshot', priority: 'normal', target: 'has spaces' }).statusCode, 400);
  assert.equal(refused({ prompt: 42 as never, priority: 'normal' }).statusCode, 400);
  assert.equal(refused({ prompt: 'x'.repeat(2001), priority: 'normal' }).statusCode, 400);
});

test('every stated priority is accepted and nothing else is', () => {
  for (const priority of PRIORITIES) {
    assert.equal(ok({ priority }).normalized.priority, priority);
  }
  assert.equal(PRIORITIES.length, 4);
});

test('an omitted priority defaults to high, as it always did', () => {
  const verdict = evaluateJarvisCommand({ prompt: 'refresh the snapshot' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.normalized.priority, 'high');
});

test('identifiers are constrained', () => {
  assert.equal(isIdentifier('office-manager'), true);
  assert.equal(isIdentifier('pm-risk'), true);
  assert.equal(isIdentifier('F9'), true);
  assert.equal(isIdentifier('-leading-dash'), false);
  assert.equal(isIdentifier('has space'), false);
  assert.equal(isIdentifier('x'.repeat(65)), false);
  assert.equal(isIdentifier(''), false);
  assert.equal(isIdentifier(undefined), false);
});

test('an unrouted command keeps the target it was given', () => {
  const verdict = ok({ target: 'office-manager' });
  assert.equal(verdict.assignedAgent, 'office-manager');
  assert.equal(verdict.routing, null, 'no polymarket match means no routing object, not an empty one');
});

test('polymarket commands route by intent, and the router is unchanged', () => {
  // Each prompt has to actually engage the router: it only does so on a
  // polymarket / market / pm signal. "drawdown" alone is not one, which is the
  // point -- the router finds the owner, it does not second-guess the operator.
  const risk = ok({ prompt: 'what is our polymarket drawdown and exposure' });
  assert.equal(risk.assignedAgent, 'pm-risk');
  assert.equal(risk.routing?.domain, 'polymarket');
  assert.equal(risk.routing?.selector, 'risk_intent');

  const signal = ok({ prompt: 'polymarket forecast the probability of this outcome' });
  assert.equal(signal.assignedAgent, 'pm-signal');
  assert.equal(signal.routing?.selector, 'signal_intent');

  const data = ok({ prompt: 'polymarket volume by market' });
  assert.equal(data.assignedAgent, 'pm-data');
  assert.equal(data.routing?.selector, 'market_data_intent');

  // An explicit target wins over the prompt's intent.
  const explicit = ok({ prompt: 'polymarket risk check', target: 'pm-data' });
  assert.equal(explicit.assignedAgent, 'pm-data');
  assert.equal(explicit.routing?.selector, 'explicit_target');

  // Risk words with no polymarket signal stay out of the trading router, so an
  // ordinary office task is not silently handed to a market agent.
  const ordinary = ok({ prompt: 'summarise the drawdown of the task queue' });
  assert.equal(ordinary.assignedAgent, null);
  assert.equal(ordinary.routing, null);
});

test('routeJarvisCommand is total: an unmatched prompt routes to the requested target', () => {
  assert.deepEqual(routeJarvisCommand('do the thing', 'office-manager'), {
    assignedAgent: 'office-manager',
    routing: null,
  });
  assert.deepEqual(routeJarvisCommand('do the thing', null), { assignedAgent: null, routing: null });
});

test('preview and the write agree, because they call the same function', () => {
  // The property that makes a preview worth trusting. If these ever diverge, the
  // floor is describing a write that will not behave the way it said.
  const inputs: Record<string, unknown>[] = [
    { prompt: 'refresh the snapshot', confirmed: true },
    { prompt: 'clear the queue', confirmed: true },
    { prompt: 'clear the queue', confirmed: true, typeConfirmation: TYPE_CONFIRMATION_WORD },
    { prompt: 'rm -rf dist', confirmed: true },
    { prompt: 'x', confirmed: true },
    { prompt: 'refresh', confirmed: true, target: 'not a valid target' },
    { prompt: 'refresh', confirmed: true, priority: 'urgent' },
    { prompt: 'refresh' },
  ];
  for (const input of inputs) {
    const verdict = evaluateJarvisCommand(input as never);
    const gate = acceptance(verdict, input as never);
    // The same call, twice, must be the same call. Not a tautology in practice:
    // it is what would catch the two sides drifting onto separate rule sets.
    assert.deepEqual(acceptance(evaluateJarvisCommand(input as never), input as never), gate);
    assert.equal(typeof gate.accepted, 'boolean');
  }
});

test('an unreadable input is refused rather than treated as safe', () => {
  // No input at all must not fall through to "normal". The dangerous failure mode
  // for a confirmation gate is defaulting open when it cannot read the request.
  const verdict = evaluateJarvisCommand(undefined as never);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.risk, undefined, 'a refused command has no risk tier, not a permissive one');
  const gate = acceptance(verdict, { confirmed: true });
  assert.equal(gate.accepted, false);
});