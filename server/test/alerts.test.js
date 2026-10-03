'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, summarize, median, breakerEntries, minutesSince, DEFAULTS } = require('../lib/analyzers');
const { AlertEngine } = require('../lib/alerts');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

function snapshot(overrides = {}) {
  return {
    summary: { agents: [] },
    queue: null,
    breakers: { breakers: {} },
    costs: null,
    services: { services: [] },
    ...overrides,
  };
}

const agent = (over = {}) => ({
  id: 'a1', name: 'A1', display: 'idle', archived: false, breaker: 'healthy', lastSeen: minutesAgo(1), ...over,
});

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test('breakerEntries accepts a map and a list', () => {
  assert.deepEqual(breakerEntries({ groq: { state: 'closed' } }), [['groq', { state: 'closed' }]]);
  assert.deepEqual(breakerEntries([{ key: 'nvidia', state: 'open' }]), [['nvidia', { key: 'nvidia', state: 'open' }]]);
  assert.deepEqual(breakerEntries(null), []);
});

test('a busy agent past the stall threshold is a critical finding', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40) })] },
  }), { now: NOW });
  const stall = findings.find((f) => f.fingerprint === 'stall:a1');
  assert.ok(stall);
  assert.equal(stall.severity, 'critical');
  assert.equal(stall.metric, 'idleMinutes');
  assert.equal(stall.value, 40);
});

test('a busy agent inside the threshold is not flagged', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(2) })] },
  }), { now: NOW });
  assert.equal(findings.filter((f) => f.analyzer === 'stall').length, 0);
});

test('an archived agent is never flagged as stalled', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ display: 'busy', archived: true, lastSeen: minutesAgo(600) })] },
  }), { now: NOW });
  assert.equal(findings.length, 0);
});

test('a non-healthy agent breaker is critical, "healthy" is not', () => {
  const tripped = analyze(snapshot({
    summary: { agents: [agent({ breaker: 'open' })] },
  }), { now: NOW });
  assert.ok(tripped.find((f) => f.fingerprint === 'breaker:a1'));
  const fine = analyze(snapshot({
    summary: { agents: [agent({ breaker: 'healthy' })] },
  }), { now: NOW });
  assert.equal(fine.filter((f) => f.fingerprint === 'breaker:a1').length, 0);
});

test('an open LLM breaker is critical, three failures is a warning', () => {
  const open = analyze(snapshot({
    breakers: { breakers: { groq: { state: 'open', failures: 9 } } },
  }), { now: NOW });
  assert.equal(open.find((f) => f.fingerprint === 'llm-breaker:groq').severity, 'critical');

  const shaky = analyze(snapshot({
    breakers: { breakers: { groq: { state: 'closed', failures: 3, available: true } } },
  }), { now: NOW });
  assert.equal(shaky.find((f) => f.fingerprint === 'llm-breaker:groq').severity, 'warn');
});

test('quarantine crosses warn then critical at the configured thresholds', () => {
  const warn = analyze(snapshot({
    queue: { total: 50, quarantined: DEFAULTS.quarantineWarn, failed: 0, queued: 0, inProgress: 0, staleInProgress: 0, completionsByHour: [{ count: 5 }] },
  }), { now: NOW });
  assert.equal(warn.find((f) => f.fingerprint === 'queue:quarantine').severity, 'warn');

  const critical = analyze(snapshot({
    queue: { total: 200, quarantined: DEFAULTS.quarantineCritical, failed: 0, queued: 0, inProgress: 0, staleInProgress: 0, completionsByHour: [{ count: 5 }] },
  }), { now: NOW });
  assert.equal(critical.find((f) => f.fingerprint === 'queue:quarantine').severity, 'critical');
});

test('a full queue with no completions in the hour is flagged', () => {
  const findings = analyze(snapshot({
    queue: { total: 30, quarantined: 0, failed: 0, queued: 20, inProgress: 2, staleInProgress: 0, completionsByHour: [{ count: 0 }] },
  }), { now: NOW });
  assert.ok(findings.find((f) => f.fingerprint === 'queue:throughput'));
});

test('a dead service is flagged, except the HUD itself', () => {
  const findings = analyze(snapshot({
    services: { services: [
      { name: 'Free harness', port: 8080, role: 'OpenAI API', up: false },
      { name: 'Office HUD', port: 4747, role: 'operations console', up: false },
      { name: 'Ollama', port: 11434, role: 'local model runtime', up: true },
    ] },
  }), { now: NOW });
  assert.ok(findings.find((f) => f.fingerprint === 'service:8080'));
  assert.equal(findings.find((f) => f.fingerprint === 'service:4747'), undefined);
});

test('a cost spike needs both a baseline and a floor', () => {
  const spiking = analyze(snapshot({
    costs: { total: { daily: 30 }, agents: { a: { daily: 1 }, b: { daily: 1 }, c: { daily: 1 } } },
  }), { now: NOW });
  assert.ok(spiking.find((f) => f.fingerprint === 'cost:spike'));

  const tiny = analyze(snapshot({
    costs: { total: { daily: 0.5 }, agents: { a: { daily: 1 } } },
  }), { now: NOW });
  assert.equal(tiny.find((f) => f.fingerprint === 'cost:spike'), undefined);
});

test('an analyzer that throws becomes a visible finding, not a crash', () => {
  const hostile = { get summary() { throw new Error('hive exploded'); } };
  const findings = analyze(hostile, { now: NOW });
  assert.ok(findings.some((f) => f.fingerprint.startsWith('analyzer:')));
});

test('analyze is pure: the same input yields the same output', () => {
  const input = snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40) })] },
    queue: { total: 10, quarantined: 30, failed: 0, queued: 0, inProgress: 0, staleInProgress: 0, completionsByHour: [{ count: 1 }] },
  });
  const first = analyze(input, { now: NOW });
  const second = analyze(input, { now: NOW });
  assert.deepEqual(first, second);
  // Findings must be stamped with the caller's `now`, not the wall clock, or
  // two calls a millisecond apart differ and the purity is a lie.
  assert.ok(first.every((finding) => finding.at === NOW), 'findings use the supplied now');
});

test('findings are deduplicated by fingerprint and sorted by severity', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40), breaker: 'open' })] },
  }), { now: NOW });
  const fingerprints = findings.map((f) => f.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.equal(findings[0].severity, 'critical');
  assert.deepEqual(summarize(findings), summarize(analyze(snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40), breaker: 'open' })] },
  }), { now: NOW })));
});

test('the engine reports a persistent condition once and keeps firstSeen', () => {
  const state = snapshot({
    summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40) })] },
  });
  const engine = new AlertEngine({ read: () => state });
  const first = engine.evaluate(NOW);
  const stall = first.find((f) => f.fingerprint === 'stall:a1');
  assert.equal(stall.firstSeen, NOW);

  const later = engine.evaluate(NOW + 60000);
  const again = later.find((f) => f.fingerprint === 'stall:a1');
  assert.equal(again.firstSeen, NOW, 'firstSeen must not move');
  assert.equal(again.lastSeen, NOW + 60000);
  assert.equal(later.filter((f) => f.fingerprint === 'stall:a1').length, 1, 'no duplicate alert');
});

test('a cleared condition is retired into history and can alert again later', () => {
  const agents = [agent({ display: 'busy', lastSeen: minutesAgo(40) })];
  const engine = new AlertEngine({ read: () => snapshot({ summary: { agents } }) });
  assert.equal(engine.evaluate(NOW).length, 1);

  agents.length = 0;                       // condition clears
  const cleared = engine.evaluate(NOW + 1000);
  assert.equal(cleared.length, 0);
  assert.equal(engine.snapshot().history.length, 1);
  assert.equal(engine.snapshot().history[0].durationMs, 1000);

  agents.push(agent({ display: 'busy', lastSeen: minutesAgo(40) }));  // and returns
  const again = engine.evaluate(NOW + 2000);
  assert.equal(again.length, 1);
  assert.equal(again[0].firstSeen, NOW + 2000, 'a recurrence is a new alert');
});

test('acknowledgement survives re-evaluation and clears when the alert resolves', () => {
  const agents = [agent({ display: 'busy', lastSeen: minutesAgo(40) })];
  const engine = new AlertEngine({ read: () => snapshot({ summary: { agents } }) });
  engine.evaluate(NOW);

  assert.equal(engine.ack('stall:a1'), true);
  assert.equal(engine.ack('nope'), false);
  assert.equal(engine.snapshot().unacknowledged, 0);

  const after = engine.evaluate(NOW + 1000);
  assert.equal(after[0].acknowledged, true, 'ack must survive the next evaluation');

  assert.equal(engine.ackAll(), 1);
  agents.length = 0;
  engine.evaluate(NOW + 2000);
  agents.push(agent({ display: 'busy', lastSeen: minutesAgo(40) }));
  const recurred = engine.evaluate(NOW + 3000);
  assert.equal(recurred[0].acknowledged, false, 'resolving an alert clears its ack');
});

test('unack reverses an acknowledgement', () => {
  const engine = new AlertEngine({
    read: () => snapshot({ summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40) })] } }),
  });
  engine.evaluate(NOW);
  engine.ack('stall:a1');
  assert.equal(engine.unack('stall:a1'), true);
  assert.equal(engine.snapshot().unacknowledged, 1);
  assert.equal(engine.unack('missing'), false);
});

test('a reader that throws produces an engine-level alert instead of crashing', () => {
  const engine = new AlertEngine({ read: () => { throw new Error('hive gone'); } });
  const alerts = engine.evaluate(NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].fingerprint, 'engine:failure');
  assert.match(alerts[0].detail, /hive gone/);
});

test('onChange is called with the alert list on every evaluation', () => {
  const seen = [];
  const engine = new AlertEngine({
    read: () => snapshot({ summary: { agents: [agent({ display: 'busy', lastSeen: minutesAgo(40) })] } }),
    onChange: (alerts) => seen.push(alerts.length),
  });
  engine.evaluate(NOW);
  engine.evaluate(NOW + 1000);
  assert.deepEqual(seen, [1, 1]);
});

test('the engine never exceeds the history bound', () => {
  const engine = new AlertEngine({ read: () => snapshot() });
  for (let i = 0; i < 260; i += 1) {
    engine.active.set(`x${i}`, {
      analyzer: 't', severity: 'warn', fingerprint: `x${i}`, title: 't',
      detail: '', at: NOW, firstSeen: NOW, lastSeen: NOW, acknowledged: false, acknowledgedAt: null,
    });
  }
  engine.evaluate(NOW);
  engine.history.length = 300;              // simulate an over-long run
  engine.evaluate(NOW);
  assert.ok(engine.history.length <= 200);
});

// ---- freshness units: the hive carries epoch ms, not ISO strings ----

test('minutesSince accepts every shape the hive uses', () => {
  const now = 1790420682641;
  const tenMinutesAgo = now - 600000;
  assert.ok(Math.abs(minutesSince(now, tenMinutesAgo) - 10) < 0.01, 'epoch milliseconds');
  // A floored seconds value is up to a second old, so allow for that.
  assert.ok(Math.abs(minutesSince(now, Math.floor(tenMinutesAgo / 1000)) - 10) < 0.02, 'epoch seconds');
  assert.ok(Math.abs(minutesSince(now, String(tenMinutesAgo)) - 10) < 0.01, 'numeric string');
  assert.ok(Math.abs(minutesSince(now, new Date(tenMinutesAgo).toISOString()) - 10) < 0.01, 'ISO string');
});

test('minutesSince returns null, never Infinity, for unusable input', () => {
  const now = 1790420682641;
  for (const value of [null, undefined, '', 'not-a-date', NaN, Infinity, {}]) {
    const result = minutesSince(now, value);
    assert.equal(result, null, `${JSON.stringify(value)} should be null, got ${result}`);
  }
});

test('a healthy agent heartbeating every 10s is not a stall', () => {
  // This is the exact shape the live hive sends, and the exact case that used to
  // report every agent as a critical stall.
  const agents = Array.from({ length: 20 }, (_unused, index) => ({
    id: `worker-${index}`,
    name: `Worker ${index}`,
    display: 'busy',
    archived: false,
    breaker: 'healthy',
    lastSeen: NOW - (index * 10000),      // epoch ms
    heartbeatAgeSec: index * 5,
  }));
  const findings = analyze(snapshot({ summary: { agents } }), { now: NOW });
  assert.equal(findings.filter((f) => f.analyzer === 'stall').length, 0, 'no stalls expected');
});

test('an agent with no freshness signal is info, not critical', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ id: 'ghost', display: 'busy', lastSeen: undefined, heartbeatAgeSec: null })] },
  }), { now: NOW });
  const unknown = findings.find((f) => f.fingerprint === 'unknown:ghost');
  assert.ok(unknown, 'should report unknown freshness');
  assert.equal(unknown.severity, 'info');
  assert.ok(!findings.some((f) => f.severity === 'critical'), 'must not escalate an unknown to critical');
});

test('a genuinely stale busy agent is still caught', () => {
  const findings = analyze(snapshot({
    summary: { agents: [agent({ id: 'wedged', display: 'busy', lastSeen: new Date(NOW - 3600000).toISOString(), heartbeatAgeSec: 3600 })] },
  }), { now: NOW });
  const stall = findings.find((f) => f.fingerprint === 'stall:wedged');
  assert.ok(stall, 'a busy agent silent for an hour is a stall');
  assert.equal(stall.severity, 'critical');
  assert.equal(stall.value, 60);
});
