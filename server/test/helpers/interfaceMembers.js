'use strict';
// One correct implementation of "read a TypeScript interface's members out of
// source text", shared by the contract tests.
//
// WHY THIS FILE EXISTS
// -------------------
// Three contract tests each had their own copy of this:
//
//   const body = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(source);
//
// which looks right and is not. The body is matched lazily up to a `}` in
// COLUMN ZERO, but api.ts closes every interface with an indented `  }`. So the
// match never stopped at the intended brace: it ran on through the following
// interface and stopped at the first top-level one, attributing that
// interface's fields to the one asked for.
//
// Concretely, `declaredMembers(source, 'VerifyState')` returned ten fields:
// `at`, `present`, and eight belonging to AgentDetail -- agent, identity,
// memory, inbox, outbox, sessions, currentTasks, recentEvents. The contract test
// dutifully reported that VerifyState "declares fields the server never sends",
// and a perfectly correct interface was about to be edited to satisfy a lie.
//
// This never showed up on the laptop because the contract tests need a live
// hive, and the laptop's hive was empty, so the comparison was skipped. It
// surfaced the moment the same commit ran on the mini, where the hive is real.
// A test that only ever runs where its data exists is a test that only gets
// checked half the time.
//
// The fix is brace matching that is aware of quotes and comments, so a brace
// inside a doc comment or a string cannot move the end of the interface.

const assert = require('node:assert/strict');

/**
 * Return the source text between an interface's braces, or null if there is no
 * such interface. Quote- and comment-aware, so braces inside string literals,
 * template literals or comments do not shift the boundary.
 */
function interfaceBody(source, name) {
  const decl = `export interface ${name}`;
  const start = source.indexOf(decl);
  if (start === -1) return null;
  // Reject a prefix match: `QueueSummary` must not match `QueueSummaryExtra`.
  const after = source[start + decl.length];
  if (after && /[A-Za-z0-9_$]/.test(after)) return null;
  const open = source.indexOf('{', start + decl.length);
  if (open === -1) return null;

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      // A backtick template's ${ ... } is brace-balanced, so letting it count
      // is safe; only the quote itself has to be tracked.
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The set of member names an interface declares: two-space-indented keys, which
 * is how api.ts writes its top-level members. Nested object literals are
 * indented further and so are excluded, which is what these tests want -- they
 * compare top-level payload keys against top-level declared fields.
 */
function declaredMembers(source, name) {
  const body = interfaceBody(source, name);
  assert.ok(body !== null, `interface ${name} not found in api.ts`);
  return new Set([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
}

/**
 * Like declaredMembers, but keeps whether each member is optional, which the
 * contract tests need: an optional field is allowed to be absent from a payload,
 * a required one is not.
 */
function declaredMemberInfo(source, name) {
  const body = interfaceBody(source, name);
  assert.ok(body !== null, `interface ${name} not found in api.ts`);
  const info = new Map();
  for (const m of body.matchAll(/^\s{2}(\w+)(\??):/gm)) {
    info.set(m[1], { optional: m[2] === '?' });
  }
  return info;
}

/**
 * Compare a served payload against its declared interface.
 *
 * The two directions are NOT symmetric, and treating them as such is what made
 * this suite give different answers on two machines:
 *
 *   sent - declared  is ALWAYS an error. If the server sends a key, a consumer
 *                     needs a declared type for it or it is silently untyped.
 *
 *   declared - sent  is an error ONLY for REQUIRED members. An optional member
 *                     is by definition allowed to be missing, and on a hive
 *                     whose backing file is absent the server omits every
 *                     optional field. Asserting they must all be present makes
 *                     the verdict depend on how much data the machine happens to
 *                     have: the same commit passed on the mini (real Polymarket
 *                     state, all 14 keys) and failed on the laptop (no state, 7
 *                     keys), and then passed again once the fields were removed.
 *
 * So: omissions are always caught, and a required field that never arrives is
 * still caught, but an absent optional field is not an error.
 */
function contractGaps(info, payload) {
  const sent = new Set(Object.keys(payload || {}));
  const undeclared = [...sent].filter((k) => !info.has(k));
  const missingRequired = [...info.entries()]
    .filter(([, v]) => !v.optional)
    .map(([k]) => k)
    .filter((k) => !sent.has(k));
  return { undeclared, missingRequired };
}

function hasInterface(source, name) {
  return interfaceBody(source, name) !== null;
}

module.exports = { interfaceBody, declaredMembers, declaredMemberInfo, contractGaps, hasInterface };