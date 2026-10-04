'use strict';
// The interface parser is subtle enough that its own tests failed silently for
// a whole deployment, so it gets tested directly rather than only through the
// contract tests that depend on it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { interfaceBody, declaredMembers, hasInterface } = require('./helpers/interfaceMembers');

// Indented closing braces, which is how api.ts actually writes every interface
// and the whole reason the old regex was wrong. A fixture that closes at column
// zero would pass with the buggy parser and prove nothing.
const SRC = `
export interface Alpha {
  a: number;
  b?: string;
  /** doc comment with a } brace in it */
  c: { nested: number };
  }

export interface Beta extends Alpha {
  d: boolean;
  }

type NotAnInterface = { e: number };

export interface Gamma {
  /** a template with a brace: \${x} */
  f: string;
  g: \`literal \${x} brace\`;
  h: number;
  }

// api.ts has column-0 closing braces further down (functions, object literals),
// and that is what the old regex latched onto: it ran past Gamma, past Alpha,
// and stopped at whichever one came next. Reproduced here so the regression
// test exercises the same termination behaviour.
export function helper(): void {
  const x = {
    y: 1,
  };
}
`;

test('an interface body stops at its own closing brace', () => {
  const body = interfaceBody(SRC, 'Alpha');
  assert.ok(body.includes('nested'), 'the nested literal is part of Alpha');
  assert.ok(!body.includes('d: boolean'), "Beta's members must not leak into Alpha");
});

test('members are the two-space keys only', () => {
  assert.deepEqual([...declaredMembers(SRC, 'Alpha')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...declaredMembers(SRC, 'Beta')].sort(), ['d']);
});

test('a nested object literal does not contribute its keys', () => {
  assert.ok(!declaredMembers(SRC, 'Alpha').has('nested'));
});

test('a doc comment containing a brace does not end the interface early', () => {
  // The comment holds a `}` in column zero inside the text. A regex that ends
  // at `\n}` would truncate here; brace matching with comment awareness must not.
  const m = declaredMembers(SRC, 'Alpha');
  assert.ok(m.has('c'), 'Alpha still has c after the brace in its comment');
});

test('a template literal with interpolation does not end the interface early', () => {
  const m = declaredMembers(SRC, 'Gamma');
  assert.ok(m.has('h'), 'Gamma still has h after the template literal');
});

test('a name that is only a prefix of a real interface does not match', () => {
  assert.equal(hasInterface(SRC, 'Beta'), true);
  assert.equal(hasInterface(SRC, 'Bet'), false);
});

test('an absent interface reports absence rather than empty', () => {
  assert.equal(interfaceBody(SRC, 'Nope'), null);
  assert.equal(hasInterface(SRC, 'Nope'), false);
  assert.throws(() => declaredMembers(SRC, 'Nope'), /not found in api\.ts/);
});

test('a type alias is not an interface', () => {
  assert.equal(hasInterface(SRC, 'NotAnInterface'), false);
});

// The exact bug: with the old `\n\}` regex, Beta's fields were attributed to
// Alpha, and AgentDetail's were attributed to VerifyState.
test('regression: the old parser leaked the next interface into the previous one', () => {
  const leaky = new RegExp('export interface Alpha\\s*\\{([\\s\\S]*?)\\n\\}', 'm').exec(SRC);
  assert.ok(leaky, 'the old pattern still matches something, which is why it looked plausible');
  const oldNames = new Set([...leaky[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
  assert.ok(oldNames.has('d'), 'sanity: the old parser really did absorb Beta');
  assert.ok(!declaredMembers(SRC, 'Alpha').has('d'), 'the new parser must not');
});