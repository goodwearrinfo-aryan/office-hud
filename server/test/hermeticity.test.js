'use strict';
// A guard against the class of defect this branch just spent its time on.
//
// Ten tests passed on the laptop and failed on the mini from one commit. Every
// one was coupled to its host rather than to the code, and each had been green
// on the machine where it was written. That is the worst failure mode a test
// suite has: it reports success exactly where it is least exercised.
//
// Static checks cannot prove a test is hermetic. What they can do is refuse the
// specific shapes that caused these ten, so the next person who writes one gets
// a failing test instead of a machine-dependent verdict nobody notices for
// months. Each rule below names the failure it exists to prevent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const SELF = path.basename(__filename);
const files = fs.readdirSync(TEST_DIR)
  .filter((f) => (f.endsWith('.test.js') || f.endsWith('.test.ts')) && f !== SELF)
  .map((f) => path.join(TEST_DIR, f));

const rel = (f) => path.basename(f);

/**
 * Test sources with comments and string literals blanked out.
 *
 * Without this the rules below flag their own explanations: the queueThroughput
 * fix documents the `Math.floor(Date.now() / 3600000)` it removed, and a rule that
 * reads that as a violation is a rule nobody keeps. Blanking comments also makes
 * the rules immune to being silenced by a well-worded comment, which is the other
 * way a guard like this dies.
 */
function code(f) {
  return read(f)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function read(f) {
  return fs.readFileSync(f, 'utf8');
}

/** The text between the opening paren at `from` and its matching close. */
function balancedArgs(src, from) {
  // Depth starts at 1: `from` points just past the opening paren, so we are
  // already inside it. Starting at 0 would return immediately at the `)` of a
  // nested call, which is the false positive this function exists to remove.
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(from, i);
    }
  }
  return null;
}

test('there are test files to check', () => {
  assert.ok(files.length > 20, `expected a real suite, found ${files.length} files`);
});

/**
 * An interface body parsed by regex up to a `}` in column zero silently absorbs
 * the NEXT interface, because api.ts closes every interface with an indented
 * brace. This was duplicated in three files and made a correct interface look
 * like it declared eight fields that did not belong to it.
 */
test('no test parses an interface body with a regex', () => {
  const bad = [];
  for (const f of files) {
    const src = code(f);
    if (/new RegExp\(\s*`export interface/.test(src)) bad.push(rel(f));
  }
  assert.deepEqual(bad, [], `use helpers/interfaceMembers.js, not a regex: ${bad.join(', ')}`);
});

/**
 * The paper gate. `paper_only` is TRUE when the bot is in paper mode, so
 * asserting it is false -- under a comment claiming paper/testnet only -- asserts
 * the opposite of what it says. It passed on any machine with no trading bot.
 */
test('no test asserts paper_only or execution_allowed is false', () => {
  const bad = [];
  for (const f of files) {
    const src = read(f);
    if (/assert\.\w+\(\s*[\w.]*\.(paper_only|execution_allowed)\s*,\s*false/.test(src)) {
      bad.push(rel(f));
    }
  }
  assert.deepEqual(
    bad, [],
    `use helpers/tradingSafety.js: ${bad.join(', ')} — paper_only TRUE is the paper-safe state`,
  );
});

/**
 * Calling validate() with no policyPath makes the terminal allowlist tests read
 * whatever terminal_allowlist.json happens to sit in the host's default hive. On
 * the mini that file names a laptop path, so every cwd was refused -- and the
 * attack list passed for the wrong reason, having rejected every command before
 * reading it.
 */
test('allowlist.validate is always given an explicit policy', () => {
  const offenders = [];
  for (const f of files) {
    const src = read(f);
    if (!/allowlist\.validate/.test(src)) continue;
    for (const m of src.matchAll(/allowlist\.validate\(/g)) {
      const args = balancedArgs(src, m.index + 'allowlist.validate('.length);
      if (args === null) continue;
      if (!/policypath|hive|\bPOLICY\b/i.test(args)) {
        offenders.push(`${rel(f)}: validate(${args.trim().slice(0, 40)})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `every validate() call needs a policy: ${offenders.join(' | ')}`);
});

/**
 * Recomputing the current hour after an await races the clock: events stamped a
 * minute before the request land in a different bucket than the one asserted,
 * which failed about once per hour of wall-clock time.
 */
test('no test locates a time bucket from a freshly computed clock', () => {
  const bad = [];
  for (const f of files) {
    // Only a bucket located AFTER an await can race: one computed before the
    // events are written is a deliberate fixed reference.
    const src = code(f);
    if (/await[\s\S]{0,400}?Math\.floor\(Date\.now\(\)\s*\/\s*3600000\)/.test(src)) bad.push(rel(f));
  }
  assert.deepEqual(bad, [], `derive buckets from the data, not the clock: ${bad.join(', ')}`);
});

/**
 * A test that asserts a machine has data ("at least one strategy map should be
 * populated on a live hive") fails wherever that machine has none, and passes
 * where it has none -- the inverse of what is useful. Availability claims belong
 * behind an explicit env flag.
 */
test('availability claims are opt-in, not default', () => {
  const bad = [];
  for (const f of files) {
    const live = code(f);
    // Scoped to the exact wording of the defect this replaces. A broader rule
    // flagged legitimate assertions about fixtures a test builds itself, and a
    // guard that cries wolf is a guard that gets switched off.
    for (const m of live.matchAll(/assert\.ok\(([^;]*?on a live hive[^;]*?);/g)) {
      if (!/process\.env/.test(m[1])) bad.push(`${rel(f)}: ${m[1].trim().slice(0, 50)}`);
    }
  }
  assert.deepEqual(bad, [], `gate availability behind an env flag: ${bad.join(' | ')}`);
});