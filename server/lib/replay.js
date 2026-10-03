'use strict';
// Time machine. The hive keeps current-state files, but every task carries
// created_at / started_at / completed_at, and events.log keeps heartbeats and
// task transitions. That is enough to reconstruct what the office looked like at
// any past moment without inventing history.

const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW_HOURS = 6;
const MAX_WINDOW_HOURS = 72;
const HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;
const TAIL_BYTES = 4 * 1024 * 1024;

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Parse the tail of a JSONL file without loading the whole thing. */
function readJsonlTail(file, maxBytes = TAIL_BYTES) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').filter((line) => line.trim().startsWith('{'));
  } catch {
    return [];
  } finally {
    try { handle?.closeSync(); } catch { /* already closed */ }
  }
}

function parseEvents(lines) {
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const at = Date.parse(event.timestamp || '');
      if (Number.isFinite(at)) events.push({ ...event, at });
    } catch { /* skip malformed line */ }
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

/**
 * The status a task held at `at`, derived from its own timestamps.
 * @returns {string|null} null when the task did not exist yet
 */
function taskStateAt(task, at) {
  const created = Date.parse(task.created_at || '');
  if (Number.isFinite(created) && at < created) return null;
  const started = Date.parse(task.started_at || '');
  const completed = Date.parse(task.completed_at || '');
  const status = String(task.status || '').toUpperCase();

  if (Number.isFinite(completed) && at >= completed) {
    // A task quarantined after completing counts as quarantined.
    return status === 'QUARANTINED' ? 'quarantined' : 'complete';
  }
  if (Number.isFinite(started) && at >= started) return 'inProgress';
  return 'queued';
}

/**
 * Reconstruct the queue and agent liveness at `when`.
 * @param {{hive: string, when: Date, windowHours?: number, agents?: any[], now?: number}} input
 */
function reconstruct({ hive, when, windowHours = DEFAULT_WINDOW_HOURS, agents = [], now = Date.now() }) {
  const at = when.getTime();
  const tasksDoc = readJsonSafe(path.join(hive, 'tasks.json'), { tasks: [] });
  const allTasks = Array.isArray(tasksDoc) ? tasksDoc : (tasksDoc.tasks || []);

  const byStatus = { queued: 0, inProgress: 0, complete: 0, quarantined: 0, failed: 0 };
  const perAgent = new Map();
  let visible = 0;

  for (const task of allTasks) {
    const state = taskStateAt(task, at);
    if (!state) continue;
    byStatus[state] = (byStatus[state] || 0) + 1;
    visible += 1;
    const owner = task.claimed_by || task.assigned_agent;
    if (owner) {
      const entry = perAgent.get(owner) || { agent: owner, queued: 0, inProgress: 0, complete: 0, quarantined: 0 };
      entry[state] = (entry[state] || 0) + 1;
      perAgent.set(owner, entry);
    }
  }

  const events = parseEvents(readJsonlTail(path.join(hive, 'events.log')));
  const inRange = events.filter((event) => event.at <= at);

  const lastHeartbeat = new Map();
  for (const event of inRange) {
    if (event.type === 'heartbeat' && event.agent_id) lastHeartbeat.set(event.agent_id, event.at);
  }

  // Completions per hour for the throughput strip.
  const hourMs = 3600000;
  const startHour = Math.floor((at - windowHours * hourMs) / hourMs) * hourMs;
  const completionsByHour = [];
  for (let i = windowHours; i >= 0; i -= 1) completionsByHour.push({ hour: startHour + i * hourMs, count: 0 });
  const indexByHour = new Map(completionsByHour.map((point, index) => [point.hour, index]));
  for (const event of inRange) {
    if (event.type !== 'task_completed') continue;
    const index = indexByHour.get(Math.floor(event.at / hourMs) * hourMs);
    if (index !== undefined) completionsByHour[index].count += 1;
  }

  const alive = [];
  for (const [agentId, lastAt] of lastHeartbeat) {
    const ageMs = at - lastAt;
    if (ageMs <= HEARTBEAT_WINDOW_MS) alive.push({ agent: agentId, lastSeen: lastAt, ageMs });
  }
  alive.sort((a, b) => a.ageMs - b.ageMs);

  const transitions = inRange
    .filter((event) => event.type !== 'heartbeat')
    .slice(-80)
    .reverse()
    .map((event) => ({
      at: event.at,
      type: event.type,
      agent: event.agent_id || null,
      taskId: event.task_id || null,
      reason: event.reason || null,
    }));

  return {
    at,
    generatedAt: now,
    isLive: Math.abs(now - at) < 2000,
    window: {
      from: startHour,
      to: at,
      hours: windowHours,
      earliestEventAt: events.length ? events[0].at : null,
      eventsConsidered: inRange.length,
    },
    queue: {
      total: visible,
      byStatus,
      perAgent: [...perAgent.values()]
        .sort((a, b) => (b.inProgress || 0) - (a.inProgress || 0) || a.agent.localeCompare(b.agent))
        .slice(0, 24),
    },
    throughput: completionsByHour,
    agents: {
      tracked: (agents || []).length,
      aliveCount: alive.length,
      alive: alive.slice(0, 24),
    },
    transitions,
  };
}

/** The scrubber's bounds: how far back we can go, and a sensible default window. */
function windowBounds(hive, now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS) {
  const events = parseEvents(readJsonlTail(path.join(hive, 'events.log')));
  const earliest = events.length ? events[0].at : now - windowHours * 3600000;
  const latest = events.length ? events[events.length - 1].at : now;
  return {
    earliest: Math.min(earliest, now),
    latest: Math.max(latest, now),
    now,
    eventsAvailable: events.length,
    defaultHours: windowHours,
    maxHours: MAX_WINDOW_HOURS,
    stepMs: events.length > 20000 ? 60000 : 5000,
  };
}

module.exports = {
  reconstruct,
  window: windowBounds,
  windowBounds,
  taskStateAt,
  parseEvents,
  readJsonlTail,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  HEARTBEAT_WINDOW_MS,
};
