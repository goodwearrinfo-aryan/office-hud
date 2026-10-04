/**
 * Why the HUD can or cannot start a terminal here.
 *
 * The case that prompted this module: the mini's hive carries a
 * terminal_allowlist.json whose cwdPrefixes name /Users/aryanagarwal, a laptop
 * path on a host whose home is /Users/a. Every spawn is refused, which is
 * fail-closed and correct, and it looked exactly like "terminals are disabled".
 * These pin the difference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnPolicyAudit, TERMINAL_POLICY_FILE } from '../spawnPolicy.js';

function hiveWith(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-policy-'));
  if (policy !== undefined) {
    fs.writeFileSync(
      path.join(dir, TERMINAL_POLICY_FILE),
      typeof policy === 'string' ? policy : JSON.stringify(policy),
    );
  }
  return dir;
}

test('no policy file means the built-in default applies, and says so', () => {
  const audit = spawnPolicyAudit(hiveWith(undefined));
  assert.equal(audit.effect, 'no_policy_file');
  assert.equal(audit.policy_file_present, false);
  assert.match(audit.summary, /built-in default/);
});

test('a policy naming only absent trees is fail-closed and explains why', () => {
  // This is the shape of the mini's problem, in a form that is portable.
  //
  // The mini's real policy names /Users/aryanagarwal, which cannot be
  // reproduced here because that path is this machine's own home -- so writing
  // the literal path into this test would assert 'permitted' and pass for the
  // wrong reason, which is the exact mistake this file exists to prevent. What
  // travels between machines is the SHAPE: a permitted tree that does not exist
  // where the policy is read. That is asserted here; the mini's literal case is
  // checked against the live endpoint on the mini itself.
  const audit = spawnPolicyAudit(hiveWith({
    version: 1,
    cwdPrefixes: ['/Users/a-machine-that-is-not-this-one'],
  }));
  assert.equal(audit.effect, 'none_permitted');
  assert.deepEqual(audit.missing_trees, ['/Users/a-machine-that-is-not-this-one']);
  assert.match(audit.summary, /NONE of them exist on this machine/);
  // It must name the machine, or the reader cannot tell which machine is broken.
  assert.equal(audit.this_machine, os.hostname());
  assert.match(audit.summary, new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a partly-present policy is partial, and names exactly what is missing', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-policy-real-'));
  const audit = spawnPolicyAudit(hiveWith({
    version: 1,
    cwdPrefixes: [real, '/Users/definitely-not-here'],
  }));
  assert.equal(audit.effect, 'partial');
  assert.deepEqual(audit.missing_trees, ['/Users/definitely-not-here']);
  assert.match(audit.summary, /1 do not exist/);
  fs.rmSync(real, { recursive: true, force: true });
});

test('a policy naming an existing tree permits, and says where', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-policy-ok-'));
  const audit = spawnPolicyAudit(hiveWith({ version: 1, cwdPrefixes: [real] }));
  assert.equal(audit.effect, 'permitted');
  assert.deepEqual(audit.missing_trees, []);
  assert.match(audit.summary, /may be started under/);
  fs.rmSync(real, { recursive: true, force: true });
});

test('an unparseable policy is refused, not treated as permissive', () => {
  // The dangerous failure mode for a security file is a parse error silently
  // falling back to a default. It does not: unreadable means nothing is validated.
  const audit = spawnPolicyAudit(hiveWith('{ this is not json'));
  assert.equal(audit.effect, 'unreadable_policy');
  assert.equal(audit.readable, false);
  assert.ok(audit.error);
  assert.match(audit.summary, /every spawn is refused/);
});

test('an empty cwdPrefixes list is permitted, and is distinguished from a missing file', () => {
  const audit = spawnPolicyAudit(hiveWith({ version: 1, cwdPrefixes: [] }));
  assert.equal(audit.effect, 'permitted');
  assert.notEqual(audit.effect, 'no_policy_file');
  assert.deepEqual(audit.permitted_trees, []);
});

test('a tree that exists but sits outside this home is legal and named separately', () => {
  // Legal and probably intentional. The one that matters is a MISSING tree, which
  // is nearly always a copy artefact, so the two must not share a field.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-policy-outside-'));
  const audit = spawnPolicyAudit(hiveWith({ version: 1, cwdPrefixes: [outside] }));
  assert.equal(audit.effect, 'permitted');
  assert.deepEqual(audit.missing_trees, []);
  assert.deepEqual(audit.foreign_trees, [outside]);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('the audit never mutates the policy file it reads', () => {
  const dir = hiveWith({ version: 1, cwdPrefixes: ['/Users/aryanagarwal'] });
  const policyPath = path.join(dir, TERMINAL_POLICY_FILE);
  const before = fs.readFileSync(policyPath, 'utf8');
  spawnPolicyAudit(dir);
  assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
});