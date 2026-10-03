'use strict';
// Anomaly detection. Every analyzer is a pure function over a snapshot plus a
// config, returning zero or more findings — so they are unit-testable without a
// hive, and the engine only owns dedupe/ack/history state.

const DEFAULTS = {
  stallMinutes: 15,
  staleHeartbeatMinutes: 6,
  quarantineWarn: 25,
  quarantineCritical: 100,
  failedWarn: 1,
  failedCritical: 10,
  costSpikeMultiple: 3,
  costSpikeFloorUsd: 1,
  queueBacklogWarn: 25,
  queueBacklogCritical: 100,
};

/** Severity ordering, used for sorting and for badge counts. */
const RANK = { info: 0, warn: 1, critical: 2 };
const SEVERITY = RANK;

function finding(analyzer, severity, fingerprint, title, detail, extra = {}) {
  return { analyzer, severity, fingerprint, title, detail, at: Date.now(), ...extra };
}

/**
 * Freshness in minutes at `now`, accepting every shape the hive uses: epoch
 * milliseconds (what agents actually carry), epoch seconds, and ISO strings.
 * Each candidate is tried in order. Returns null when freshness is genuinely
 * unknown — never Infinity, which would sail past every threshold and report a
 * healthy agent as stalled.
 *
 * @param {number} now reference time in epoch milliseconds
 * @param {...(number|string|null|undefined)} values candidate timestamps
 */
function minutesSince(now, ...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    let ms;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Values below ~1e11 are seconds, above are milliseconds.
      ms = value < 1e11 ? value * 1000 : value;
    } else if (typeof value === 'string' && /^\d{9,14}$/.test(value.trim())) {
      const numeric = Number(value.trim());
      ms = numeric < 1e11 ? numeric * 1000 : numeric;
    } else {
      ms = Date.parse(value);
    }
    if (Number.isFinite(ms)) return Math.max(0, (now - ms) / 60000);
  }
  return null;
}

/**
 * Age in minutes for one agent, preferring the server's own computed
 * heartbeat age and falling back to the raw last-seen stamp.
 */
function agentIdleMinutes(agent, now) {
  const ageSeconds = agent.heartbeatAgeSec ?? agent.heartbeat_age_sec;
  if (Number.isFinite(ageSeconds)) return Math.max(0, ageSeconds) / 60;
  return minutesSince(now, agent.lastSeen, agent.last_seen, agent.lastActive);
}

/**
 * A busy agent that has neither moved a heartbeat nor produced a tool call.
 * An agent with no freshness signal at all is reported once as info, because
 * "we cannot tell" is not the same as "it is stuck".
 */
function analyzeStalls(snapshot, config, now) {
  const out = [];
  for (const agent of snapshot.summary?.agents || []) {
    if (agent.archived) continue;
    const idle = agentIdleMinutes(agent, now);
    if (idle === null) {
      if (agent.display !== 'offline') {
        out.push(finding(
          'stall',
          'info',
          `unknown:${agent.id}`,
          `${agent.name || agent.id} reports no heartbeat`,
          'This agent carries no freshness signal, so its liveness cannot be judged.',
          { agentId: agent.id }
        ));
      }
      continue;
    }
    if (agent.display === 'busy' && idle > config.stallMinutes) {
      out.push(finding(
        'stall',
        idle > config.stallMinutes * 2 ? 'critical' : 'warn',
        `stall:${agent.id}`,
        `${agent.name || agent.id} is busy but silent`,
        `No heartbeat for ${Math.round(idle)}m (threshold ${config.stallMinutes}m). Last tool: ${agent.lastTool || 'unknown'}.`,
        { agentId: agent.id, metric: 'idleMinutes', value: Math.round(idle) }
      ));
    } else if (agent.display && agent.display !== 'offline' && idle > config.staleHeartbeatMinutes * 6) {
      out.push(finding(
        'stall',
        'warn',
        `stale:${agent.id}`,
        `${agent.name || agent.id} heartbeat is stale`,
        `Last seen ${Math.round(idle)}m ago while marked ${agent.display}.`,
        { agentId: agent.id, metric: 'idleMinutes', value: Math.round(idle) }
      ));
    }
  }
  return out;
}

/** Normalize a breaker collection into [name, breaker] pairs. */
function breakerEntries(breakers) {
  if (!breakers || typeof breakers !== 'object') return [];
  if (Array.isArray(breakers)) {
    return breakers.map((breaker, index) => [
      (breaker && (breaker.key || breaker.name || breaker.provider)) || `breaker-${index}`,
      breaker,
    ]);
  }
  return Object.entries(breakers);
}

/**
 * Circuit breakers that are open. The hive reports breakers either as a map
 * keyed by provider or as a list, and an agent-level breaker reads 'healthy'
 * when closed, so all three shapes are handled.
 */
function analyzeBreakers(snapshot, config) {
  const out = [];
  for (const agent of snapshot.summary?.agents || []) {
    if (agent.breaker && agent.breaker !== 'healthy') {
      out.push(finding(
        'breaker',
        'critical',
        `breaker:${agent.id}`,
        `${agent.name || agent.id} breaker: ${agent.breaker}`,
        'The agent is held by an open circuit breaker and will not take work.',
        { agentId: agent.id, metric: 'breaker', value: agent.breaker }
      ));
    }
  }

  for (const [name, breaker] of breakerEntries(snapshot.breakers?.breakers)) {
    if (!breaker || typeof breaker !== 'object') continue;
    const state = String(breaker.state || '').toLowerCase();
    const failures = Number(breaker.failures ?? breaker.trips ?? 0);
    const available = breaker.available !== false;
    if (state === 'open' || (!available && state !== 'closed')) {
      out.push(finding(
        'breaker',
        'critical',
        `llm-breaker:${name}`,
        `LLM breaker ${name} is ${state || 'unavailable'}`,
        `${failures} consecutive failures.`,
        { metric: 'failures', value: failures }
      ));
    } else if (failures >= 3) {
      out.push(finding(
        'breaker',
        'warn',
        `llm-breaker:${name}`,
        `LLM breaker ${name} has ${failures} failures`,
        'Still serving, but close to tripping.',
        { metric: 'failures', value: failures }
      ));
    }
  }
  return out;
}

function analyzeQueue(snapshot, config) {
  const out = [];
  const queue = snapshot.queue;
  if (!queue) return out;

  if (queue.quarantined >= config.quarantineCritical) {
    out.push(finding('queue', 'critical', 'queue:quarantine',
      'Quarantined tasks above critical',
      `${queue.quarantined} quarantined of ${queue.total} total.`,
      { metric: 'quarantined', value: queue.quarantined }));
  } else if (queue.quarantined >= config.quarantineWarn) {
    out.push(finding('queue', 'warn', 'queue:quarantine',
      'Quarantined tasks accumulating',
      `${queue.quarantined} quarantined of ${queue.total} total.`,
      { metric: 'quarantined', value: queue.quarantined }));
  }

  if (queue.failed >= config.failedCritical) {
    out.push(finding('queue', 'critical', 'queue:failed',
      'Failed tasks above critical', `${queue.failed} failed tasks.`,
      { metric: 'failed', value: queue.failed }));
  } else if (queue.failed >= config.failedWarn) {
    out.push(finding('queue', 'warn', 'queue:failed',
      'Failed tasks present', `${queue.failed} failed tasks.`,
      { metric: 'failed', value: queue.failed }));
  }

  const backlog = queue.queued || 0;
  if (backlog >= config.queueBacklogCritical) {
    out.push(finding('queue', 'critical', 'queue:backlog',
      'Queue backlog critical', `${backlog} tasks waiting, ${queue.inProgress || 0} in progress.`,
      { metric: 'queued', value: backlog }));
  } else if (backlog >= config.queueBacklogWarn) {
    out.push(finding('queue', 'warn', 'queue:backlog',
      'Queue backlog building', `${backlog} tasks waiting.`,
      { metric: 'queued', value: backlog }));
  }

  if (queue.staleInProgress > 0) {
    out.push(finding('queue', 'warn', 'queue:stale-in-progress',
      'In-progress tasks with stale heartbeats',
      `${queue.staleInProgress} task(s) claim work but stopped heartbeating.`,
      { metric: 'staleInProgress', value: queue.staleInProgress }));
  }

  const byHour = queue.completionsByHour || [];
  const lastHour = byHour[byHour.length - 1]?.count ?? 0;
  if (backlog > 0 && queue.inProgress > 0 && lastHour === 0) {
    out.push(finding('queue', 'warn', 'queue:throughput',
      'No completions in the last hour',
      `${backlog} queued and ${queue.inProgress} in progress, but nothing finished.`,
      { metric: 'completionsLastHour', value: queue.completionsLastHour || 0 }));
  }
  return out;
}

function analyzeCosts(snapshot, config) {
  const out = [];
  const costs = snapshot.costs;
  if (!costs || !costs.total) return out;
  const hour = Number(costs.total.daily ?? costs.total.day ?? 0);
  const perAgent = Object.values(costs.agents || {})
    .map((entry) => Number(entry?.daily ?? entry?.day ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const baseline = median(perAgent);
  if (baseline > 0 && hour > config.costSpikeFloorUsd && hour > baseline * config.costSpikeMultiple) {
    out.push(finding('cost', 'warn', 'cost:spike',
      'Daily spend above normal',
      `$${hour.toFixed(2)} today vs a $${baseline.toFixed(2)} median across agents.`,
      { metric: 'dailyUsd', value: Number(hour.toFixed(2)) }));
  }
  return out;
}

function analyzeServices(snapshot, config) {
  const out = [];
  const services = snapshot.services;
  if (services && Array.isArray(services.services)) {
    for (const service of services.services) {
      if (service.up) continue;
      // The HUD reports itself as up because it answered this request.
      if (service.name === 'Office HUD') continue;
      const critical = service.role === 'OpenAI API';
      out.push(finding(
        'service',
        critical ? 'critical' : 'warn',
        `service:${service.port}`,
        `${service.name} is not listening`,
        `Port ${service.port} (${service.role}) did not answer.`,
        { metric: 'port', value: service.port }
      ));
    }
  }
  if (snapshot.harness && snapshot.harness.ok === false) {
    out.push(finding('service', 'critical', 'service:harness',
      'Free harness is unhealthy',
      snapshot.harness.error || 'No health response from the free harness.'));
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ANALYZERS = [analyzeStalls, analyzeBreakers, analyzeQueue, analyzeCosts, analyzeServices];

/** Run every analyzer. Pure: the same input always produces the same findings. */
function analyze(snapshot, options = {}) {
  const config = { ...DEFAULTS, ...(options.config || {}) };
  const now = options.now ?? Date.now();
  const findings = [];
  for (const analyzer of ANALYZERS) {
    try {
      // Stamp every finding with the caller's `now`, not the wall clock, so the
      // same input always yields the same output.
      for (const found of analyzer(snapshot || {}, config, now)) {
        findings.push({ ...found, at: now });
      }
    } catch (error) {
      findings.push(finding('analyzer', 'warn', `analyzer:${analyzer.name}`,
        `Analyzer ${analyzer.name} failed`, error.message));
    }
  }
  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Map();
  for (const item of findings) {
    if (!seen.has(item.fingerprint)) seen.set(item.fingerprint, item);
  }
  return [...seen.values()].sort(
    (a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title)
  );
}

function summarize(findings) {
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] || 0) + 1;
  return counts;
}

module.exports = {
  analyze, summarize, dedupe, breakerEntries, median, minutesSince, agentIdleMinutes,
  DEFAULTS, RANK, SEVERITY, ANALYZERS,
};
