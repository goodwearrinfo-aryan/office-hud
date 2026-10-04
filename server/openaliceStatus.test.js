/**
 * Tests for the unified OpenAlice status projection.
 *
 * The failure guarded most carefully is a FALSE OFFLINE. A first version read
 * processView().live, which is `!!(entry && entry.live)` -- a pass-through of a
 * field the writer sets. hive/processes.json carries collected_at and processes
 * but no `live` key, so that was always false, and the endpoint reported
 * OFFLINE while 57 agents ran and the observation was seconds old. A false red
 * on a healthy fleet is worse than no verdict at all.
 *
 * Every test injects a CONTROLLED registry. The live hive/registry.json holds 58
 * agents and is days stale, so a test that reads it can never assert agreement.
 *
 * Run: node --test office-hud/server/openaliceStatus.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('./openaliceStatus.js');
const { classify, scrub, countAgentRecords, isSecretName, REDACTED } = mod;

const AGENT_CMD = '/Users/a/trading/openalice-fleet/hive/agents/mainbot/bin/agent_manager.js';
const NOW = Date.parse('2026-09-30T10:00:00Z');
const STALE_AFTER = 300;

const TEMP_DIRS = [];
test.after(() => {
  for (const d of TEMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

/** A controlled registry file, so no test depends on live hive state. */
function registry(agentCount, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-reg-'));
  TEMP_DIRS.push(dir);
  const file = path.join(dir, 'registry.json');
  if (opts && typeof opts.body === 'string') {
    fs.writeFileSync(file, opts.body);
  } else {
    const agents = {};
    for (let i = 0; i < agentCount; i += 1) {
      // Build the key directly. An earlier version did
      // 'agent-%02d'.replace('XX', ...), whose template never contained XX, so
      // every iteration wrote the SAME key and a 12-agent registry held 1.
      agents['agent-' + String(i).padStart(2, '0')] = { id: 'a' + i, floor: 'F' + ((i % 12) + 1) };
    }
    fs.writeFileSync(file, JSON.stringify({ agents }));
  }
  if (opts && opts.ageSeconds) {
    const when = new Date(NOW - opts.ageSeconds * 1000);
    fs.utimesSync(file, when, when);
  }
  return file;
}

/** A process observation with `agents` agent processes, `ageSeconds` old. */
function procEntry(agents, ageSeconds) {
  return {
    processes: Array.from({ length: agents }, (_, i) => ({
      pid: 100 + i, command: AGENT_CMD, status: 'RUNNING',
    })),
    collected_at: new Date(NOW - (ageSeconds === undefined ? 5 : ageSeconds) * 1000).toISOString(),
  };
}

function build(o) {
  return mod.buildStatus({
    now: NOW,
    staleAfterSeconds: STALE_AFTER,
    processes: o.processes === undefined ? procEntry(3) : o.processes,
    health: o.health === undefined ? { ok: true, present: true } : o.health,
    agentsAlive: o.agentsAlive,
    registryPath: o.registryPath === undefined ? registry(3) : o.registryPath,
  });
}

/* ------------------------------------------------------------- the states */

test('LIVE when evidence is fresh, health ok, counts agree, registry fresh', () => {
  const s = build({ agentsAlive: 3, registryPath: registry(3) });
  assert.strictEqual(s.status, 'LIVE', s.reason);
  assert.deepStrictEqual(s.issues, []);
  assert.strictEqual(s.freshness.stale, false);
  assert.ok(s.freshness.observed_at);
  assert.strictEqual(s.runtime.agents_expected, 3);
});

test('STALE when the observation passes the canonical threshold', () => {
  const s = build({ processes: procEntry(3, 4000), agentsAlive: 3, registryPath: registry(3) });
  assert.strictEqual(s.status, 'STALE');
  assert.match(s.reason, /4000s old/);
  assert.strictEqual(s.freshness.stale, true);
});

test('DEGRADED when alive but fewer agents run than are registered', () => {
  const s = build({ agentsAlive: 1, registryPath: registry(3) });
  assert.strictEqual(s.status, 'DEGRADED');
  assert.ok(s.issues.some((i) => /agents alive/.test(i)));
});

test('an aged registry is a visible label, not a gate on the verdict', () => {
  // Updated from the original assertion (DEGRADED). commit aa7e27e made roster
  // age a label that does not gate, and its premise was verified correct:
  // registry.json is a roster written when the agent set changes, so a stable
  // fleet accrues unbounded age while staying accurate. With the refresh job
  // running the file is fresh anyway; the aged-roster case this pins is
  // "refresh job died, roster still accurate" -- which must read LIVE with the
  // label visible, not DEGRADED.
  const s = build({ agentsAlive: 3, registryPath: registry(3, { ageSeconds: 5 * 86400 }) });
  assert.notStrictEqual(s.status, 'OFFLINE');
  assert.strictEqual(s.identity.registry_stale, true,
    'the label must still be visible to any reader');
});

test('OFFLINE when the hive is genuinely absent', () => {
  const s = build({ health: { ok: false, present: false }, agentsAlive: 0 });
  assert.strictEqual(s.status, 'OFFLINE');
  assert.match(s.reason, /hive not present/);
});

test('OFFLINE when a fresh observation contains no agent processes', () => {
  const s = build({
    processes: { processes: [{ pid: 1, command: '/bin/sleep 1' }],
                 collected_at: new Date(NOW - 1000).toISOString() },
    agentsAlive: 0,
  });
  assert.strictEqual(s.status, 'OFFLINE');
  assert.match(s.reason, /no agent processes/);
});

/* ------------------------------------------- the false-OFFLINE regression */

test('NEVER OFFLINE while agents are observed, with no live flag present', () => {
  // The exact real-world shape: collected_at + processes, no `live` key, so
  // processView().live is false even though the fleet is healthy.
  const entry = procEntry(57);
  assert.strictEqual(entry.live, undefined, 'precondition: no live flag');
  const s = build({ processes: entry, agentsAlive: 57, registryPath: registry(57) });
  assert.notStrictEqual(s.status, 'OFFLINE',
    'a fresh observation with 57 agents must never read OFFLINE');
  assert.strictEqual(s.runtime.agents_alive, 57);
});

test('a STALE observation reads STALE, not OFFLINE', () => {
  const s = build({ processes: procEntry(57, 99999), agentsAlive: 57, registryPath: registry(57) });
  assert.strictEqual(s.status, 'STALE');
});

/* ------------------------------------------------- optional and broken in */

test('a missing processes file yields null counts, never a fabricated zero', () => {
  const s = build({ processes: null, agentsAlive: null });
  assert.strictEqual(s.runtime.agents_alive, null);
  assert.ok(!Number.isNaN(s.status.length));
});

test('partial JSON is reported as an error, never parsed or thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-bad-'));
  TEMP_DIRS.push(dir);
  const bad = path.join(dir, 'registry.json');
  fs.writeFileSync(bad, '{ "agents": { "a": ');
  const r = mod.readJson(bad);
  assert.strictEqual(r.value, null);
  assert.ok(r.error);
});

test('a missing registry is not OFFLINE', () => {
  const v = classify({
    processStale: false, ageSeconds: 5, staleAfterSeconds: STALE_AFTER,
    hivePresent: true, agentsAlive: 10, agentsExpected: null,
    healthOk: true, registryError: 'missing', registryStale: null,
    processRecords: Array.from({ length: 10 }, () => ({ command: AGENT_CMD })),
  });
  assert.notStrictEqual(v.status, 'OFFLINE');
});

test('an unreadable registry degrades rather than going OFFLINE', () => {
  const v = classify({
    processStale: false, ageSeconds: 5, staleAfterSeconds: STALE_AFTER,
    hivePresent: true, agentsAlive: 10, agentsExpected: 10,
    healthOk: true, registryError: 'SyntaxError', registryStale: null,
    processRecords: Array.from({ length: 10 }, () => ({ command: AGENT_CMD })),
  });
  assert.strictEqual(v.status, 'DEGRADED');
  assert.ok(v.issues.some((i) => /registry unreadable/.test(i)));
});

/* ------------------------------------------------------------ no invention */

test('no project or product identity is invented', () => {
  const id = mod.readIdentity(NOW, registry(1));
  assert.strictEqual(id.identity.registered_agents, 1);
  for (const k of ['project', 'aliceproject', 'AliceProject', 'name', 'product']) {
    assert.ok(!(k in id.identity), 'invented identity key: ' + k);
  }
});

test('a dict-keyed registry is counted, not read as a list', () => {
  // Regression: only Array.isArray(value.agents) was handled, so a dict-keyed
  // registry silently reported registered_agents: null.
  const id = mod.readIdentity(NOW, registry(12));
  assert.strictEqual(id.identity.registered_agents, 12);
  assert.strictEqual(id.identity.floors, 12);
});

test('a malformed registry yields identity null and an error, never a throw', () => {
  const id = mod.readIdentity(NOW, registry(0, { body: '{ "agents": { "a": ' }));
  assert.strictEqual(id.identity, null);
  assert.ok(id.error);
});

test('agents_expected is null, not guessed, when the registry is absent', () => {
  const s = build({ registryPath: registry(0, { body: '' }) });
  assert.ok(s.runtime.agents_expected === null || s.runtime.agents_expected === 0);
});

/* ----------------------------------------------------------------- secrecy */

test('credential-shaped keys are redacted, and the redaction is visible', () => {
  const out = scrub({
    OPENALICE_PUBSERVER_PASSWORD: 'hunter2-not-real',
    nested: { apiKey: 'sk-not-real', sealing_key: 'x', safe: 'keep-me' },
    list: [{ token: 't' }],
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter2-not-real'));
  assert.ok(!text.includes('sk-not-real'));
  // `safe` is nested one level down; asserting out.safe tested a key that was
  // never at the top level, and failed for a reason unrelated to redaction.
  assert.strictEqual(out.nested.safe, 'keep-me');
  assert.ok(text.includes(REDACTED));
});

test('scrub leaves measurement fields alone', () => {
  const out = scrub({ pid: 42, status: 'RUNNING', token_count: 5, api_keys_present: 3 });
  assert.strictEqual(out.pid, 42);
  assert.strictEqual(out.status, 'RUNNING');
  assert.strictEqual(out.token_count, 5, 'token_count is a metric');
  assert.strictEqual(out.api_keys_present, 3);
});

test('credential names are detected and measurement names are not', () => {
  for (const n of ['OPENALICE_PUBSERVER_PASSWORD', 'sealing.key', 'GROQ_API_KEY',
                   'token', 'AUTHORIZATION', 'api_key', 'private_key']) {
    assert.ok(isSecretName(n), n + ' must be a secret');
  }
  for (const n of ['OPENALICE_HIVE', 'agents_alive', 'token_count',
                   'api_keys_present', 'secret_count', 'status', 'pid']) {
    assert.ok(!isSecretName(n), n + ' is a measurement');
  }
});

test('a real buildStatus payload carries no credential value', () => {
  const s = scrub(build({ agentsAlive: 3, registryPath: registry(3) }));
  const text = JSON.stringify(s);
  assert.ok(!/oc_sk_[A-Za-z0-9_-]{10,}/.test(text));
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text));
  assert.ok(!/PASSWORD\s*[:=]\s*["'][^"']+/.test(text));
});

/* --------------------------------------------------------------- counting */

test('countAgentRecords counts only agent entrypoints', () => {
  const n = countAgentRecords([
    { command: AGENT_CMD },
    { command: '/Users/a/trading/openalice-fleet/hive/agents/office-manager/bin/office_manager.js' },
    { command: '/bin/sleep 100' },
    { command: '/Users/a/trading/openalice-fleet/office-hud/server/index.js' },
  ]);
  assert.strictEqual(n, 2);
});

test('countAgentRecords returns null for a non-array, never 0', () => {
  assert.strictEqual(countAgentRecords(null), null);
  assert.strictEqual(countAgentRecords(undefined), null);
});

test('classify honours the stale flag even when the age is unmeasurable', () => {
  // The age clause and the stale flag are two independent paths to STALE. The
  // age clause alone caught every mutation that removed the flag check, because
  // buildStatus always supplies a measurable age. Feeding ageSeconds: null
  // isolates the flag, so neither guard can be deleted unnoticed.
  const v = classify({
    processStale: true, ageSeconds: null, staleAfterSeconds: STALE_AFTER,
    hivePresent: true, agentsAlive: 5, agentsExpected: 5,
    healthOk: true, registryError: null, registryStale: null,
    processRecords: Array.from({ length: 5 }, () => ({ command: AGENT_CMD })),
  });
  assert.strictEqual(v.status, 'STALE');
  assert.match(v.reason, /stale|threshold|observation/);
});

test('classify honours the age even when the flag is absent', () => {
  const v = classify({
    processStale: false, ageSeconds: 9999, staleAfterSeconds: STALE_AFTER,
    hivePresent: true, agentsAlive: 5, agentsExpected: 5,
    healthOk: true, registryError: null, registryStale: null,
    processRecords: Array.from({ length: 5 }, () => ({ command: AGENT_CMD })),
  });
  assert.strictEqual(v.status, 'STALE');
});

test('an unmeasurable age is never presented as fresh', () => {
  const v = classify({
    processStale: false, ageSeconds: null, staleAfterSeconds: STALE_AFTER,
    hivePresent: true, agentsAlive: 5, agentsExpected: 5,
    healthOk: true, registryError: null, registryStale: null,
    processRecords: Array.from({ length: 5 }, () => ({ command: AGENT_CMD })),
  });
  // No age and no flag: there is no evidence of freshness, so this must not be
  // reported as LIVE.
  assert.notStrictEqual(v.status, 'LIVE');
});
