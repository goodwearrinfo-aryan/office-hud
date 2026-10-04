'use strict';
// Read-only fleet performance aggregation.
//
// This module computes and nothing else: it opens hive JSON read-only, and it
// never writes, locks, or mutates. Everything here is derivable from files the
// operator can inspect directly, which is the point — a performance number that
// cannot be traced back to its inputs is just a vibe with a decimal place.
//
// Two honesty rules, because the alternative is a flattering dashboard:
//
//   1. QUARANTINED tasks are counted as their own outcome and never folded into
//      "not complete". On the current hive that is 278 of 934 — roughly a third
//      of all work. Averaging it away would report a ~56% completion rate that
//      reads like "the fleet is mostly fine" when the truth is "the fleet is
//      quarantining a third of what it touches".
//   2. A rate with a small denominator is reported with its denominator, and
//      agents with no tasks are omitted rather than shown as 0%, which would
//      look like failure when it is really absence of data.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function toMs(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function rate(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 1000;
}

function emptyCounts() {
  return {
    assigned: 0, complete: 0, quarantined: 0,
    inProgress: 0, preserved: 0, queued: 0, failed: 0,
  };
}

function bump(counts, status) {
  counts.assigned += 1;
  switch (status) {
    case 'COMPLETE': counts.complete += 1; break;
    case 'QUARANTINED': counts.quarantined += 1; break;
    case 'IN_PROGRESS': counts.inProgress += 1; break;
    case 'PRESERVED': counts.preserved += 1; break;
    case 'QUEUED': counts.queued += 1; break;
    case 'FAILED':
    case 'FAIL': counts.failed += 1; break;
    default: break; // an unknown status still counts as assigned, not as done
  }
}

/**
 * @param {object} opts
 * @param {string} opts.hive  hive directory (read-only)
 * @param {number} [opts.now]
 * @param {number} [opts.staleAfterMs] heartbeat age at which a session is stale
 */
function computeFleetPerformance(opts = {}) {
  const hive = opts.hive || process.env.OPENALICE_HIVE;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const staleAfterMs = opts.staleAfterMs || DEFAULT_STALE_AFTER_MS;
  if (!hive) throw new Error('computeFleetPerformance requires opts.hive');

  const tasksDoc = readJson(path.join(hive, 'tasks.json'), {});
  const sessionsDoc = readJson(path.join(hive, 'sessions.json'), {});
  const costsDoc = readJson(path.join(hive, 'costs.json'), {});

  const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
  const sessions = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];

  const totals = emptyCounts();
  const byAgent = new Map();
  const activity = new Map();

  for (const task of tasks) {
    const id = task.assigned_agent || task.claimed_by || 'unassigned';
    if (!byAgent.has(id)) byAgent.set(id, { counts: emptyCounts(), lastActivityAt: null });
    const row = byAgent.get(id);
    bump(row.counts, task.status);
    bump(totals, task.status);

    const stamp = toMs(task.completed_at) || toMs(task.updated_at) || toMs(task.created_at);
    if (stamp && (!row.lastActivityAt || stamp > row.lastActivityAt)) row.lastActivityAt = stamp;
    if (stamp && (!activity.has(id) || stamp > activity.get(id))) activity.set(id, stamp);
  }

  // Sessions: health is the operator's most actionable number, because a stale
  // session still shows up as "assigned" work that nobody is doing.
  const sessionTotals = { total: sessions.length, healthy: 0, stale: 0, starting: 0, unknown: 0 };
  const sessionsByAgent = new Map();
  for (const s of sessions) {
    const id = s.agent_id || 'unknown';
    if (!sessionsByAgent.has(id)) sessionsByAgent.set(id, { healthy: 0, stale: 0, starting: 0, unknown: 0 });
    const bucket = sessionsByAgent.get(id);

    const beat = toMs(s.last_heartbeat);
    const age = beat ? now - beat : null;
    const effectivelyStale = s.status === 'STALE'
      || (s.status === 'HEALTHY' && age !== null && age > staleAfterMs);

    let kind;
    if (s.status === 'HEALTHY' && !effectivelyStale) kind = 'healthy';
    else if (s.status === 'STARTING') kind = 'starting';
    else if (s.status === 'STALE' || effectivelyStale) kind = 'stale';
    else kind = 'unknown';

    sessionTotals[kind] += 1;
    bucket[kind] += 1;
  }

  const agents = [...byAgent.entries()].map(([agentId, row]) => {
    const s = sessionsByAgent.get(agentId) || { healthy: 0, stale: 0, starting: 0, unknown: 0 };
    return {
      agentId,
      ...row.counts,
      completionRate: rate(row.counts.complete, row.counts.assigned),
      quarantineRate: rate(row.counts.quarantined, row.counts.assigned),
      lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
      sessions: s,
    };
  }).sort((a, b) => b.assigned - a.assigned);

  // Cost: the fleet mostly runs free models, so costUsd is usually null. Report
  // the unpriced count rather than a $0.00 that reads like "free".
  let costRecords = 0;
  let pricedRecords = 0;
  let costUsd = 0;
  for (const entry of Object.values(costsDoc)) {
    const records = entry && Array.isArray(entry.records) ? entry.records : [];
    for (const r of records) {
      costRecords += 1;
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) {
        pricedRecords += 1;
        costUsd += r.costUsd;
      }
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    staleAfterMs,
    tasks: {
      total: totals.assigned,
      complete: totals.complete,
      quarantined: totals.quarantined,
      inProgress: totals.inProgress,
      preserved: totals.preserved,
      queued: totals.queued,
      failed: totals.failed,
      completionRate: rate(totals.complete, totals.assigned),
      quarantineRate: rate(totals.quarantined, totals.assigned),
      // Never folded together on purpose: these two answer different questions.
      note: 'quarantined is reported separately from complete and is never averaged into a completion rate',
    },
    sessions: {
      ...sessionTotals,
      staleRate: rate(sessionTotals.stale, sessionTotals.total),
    },
    cost: {
      records: costRecords,
      pricedRecords,
      unpricedRecords: costRecords - pricedRecords,
      totalUsd: Math.round(costUsd * 1e6) / 1e6,
    },
    agents,
  };
}

module.exports = { computeFleetPerformance, DEFAULT_STALE_AFTER_MS };