'use strict';

/**
 * @fileoverview Task Systems - Pure functions for task data processing
 */

const fs = require('fs');
const path = require('path');

const STALE_MS = 5 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function computeCompletionTruth(verified) {
  if (!verified || !verified.engagement) {
    return { truth: 'UNVERIFIED', score: null, reason: 'no verification record' };
  }
  const verdict = verified.engagement?.verdict;
  const score = verified.score ?? 0;
  
  if (verdict === 'OK' && score >= 0.9) {
    return { truth: 'EVIDENCED', score, reason: 'score >= 0.9 and verdict OK' };
  }
  if (verdict === 'OK' && score >= 0.5) {
    return { truth: 'WEAK', score, reason: 'score >= 0.5 and verdict OK' };
  }
  if (verdict === 'OFF_TOPIC') {
    return { truth: 'OFF_TOPIC', score, reason: 'verdict OFF_TOPIC' };
  }
  return { truth: 'UNVERIFIED', score, reason: 'insufficient evidence' };
}

function computeDisplay(agent, session) {
  const archived = !!agent.archived;
  const breaker = agent.breaker || (archived ? 'offline' : 'healthy');
  const hasWork = session?.hasTask === true;
  const sessionFresh = session?.fresh === true;
  
  const status = agent.status || agent.display;
  if (status === 'busy') return 'busy';
  
  if (archived) return 'offline';
  if (breaker !== 'healthy') return 'breaker';
  if (hasWork) return 'busy';
  if (sessionFresh) return 'idle';
  if (session) return 'stale';
  return 'offline';
}

function computeEvidence(agent, session, processId, heartbeatAgeSec, currentTaskId, currentTaskTitle) {
  const hasSession = !!session;
  const sessionFresh = session?.fresh === true;
  const hasTask = !!currentTaskId;
  const taskStatus = session?.taskStatus || null;
  const processLiveness = processId ? (isPidAlive(processId) ? 'alive' : 'dead') : 'no-pid';
  const processVerified = processId ? isPidAlive(processId) : false;

  return {
    hasSession,
    sessionFresh,
    hasTask,
    taskStatus,
    heartbeatAgeSec,
    processId,
    processLiveness,
    processVerified
  };
}

/**
 * Compute agent runtime state for floor rollup
 * @param {Object} agent
 * @param {Object} session
 * @returns {string}
 */
function computeRuntimeState(agent, session) {
  if (agent.breaker === 'open') return 'breaker';
  if (!session) return 'offline';
  if (!session.fresh) return 'stale';
  if (session.hasTask) return 'working';
  return 'idle';
}

/**
 * Task Routing System
 * Routes tasks to agents based on floor, role, and capacity
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function taskRoutingSystem(world, context) {
  const { hivePath } = context;
  
  const fleetData = readFleet(hivePath);
  const tasks = readTasks(hivePath);
  const events = readRecentEvents(hivePath, 2000);
  
  const floorMap = new Map();
  for (let i = 1; i <= 12; i++) {
    const floorId = 'floor:f' + i;
    floorMap.set(floorId, {
      id: floorId,
      label: 'F' + i,
      manager: null,
      managerAlive: false,
      runtimeState: 'UNKNOWN',
      counters: { running: 0, working: 0, idle: 0, stale: 0, failed: 0, offline: 0, breaker: 0 },
      responsibilities: [],
      currentTask: null,
      lastActivity: null,
    });
  }
  
  const agents = world.getAllAgents();
  
  for (const agent of agents) {
    const floorNum = agent.floor?.match(/^f(\d+)$/);
    if (!floorNum) continue;
    
    const floorId = 'floor:f' + floorNum[1];
    const floor = floorMap.get(floorId);
    if (!floor) continue;
    
    floor.counters[agent.display] = (floor.counters[agent.display] || 0) + 1;
    if (agent.display === 'busy') floor.counters.working++;
    
    if (!floor.manager && /floor\s*(lead|manager)/i.test(agent.role)) {
      floor.manager = agent.name;
      floor.managerAlive = agent.evidence?.processVerified === true;
    }
    
    const stateOrder = { breaker: 5, offline: 4, stale: 3, working: 2, busy: 2, idle: 1, UNKNOWN: 0 };
    const currentSeverity = stateOrder[floor.runtimeState] || 0;
    const agentSeverity = stateOrder[agent.display] || 0;
    if (agentSeverity > currentSeverity) {
      floor.runtimeState = agent.display;
    }
  }
  
  for (const [floorId, floor] of floorMap) {
    if (floor.manager) {
      for (const agent of fleetData.agents || []) {
        if (agent.name === floor.manager) {
          floor.responsibilities = readAgentResponsibilities(hivePath, agent.id);
          break;
        }
      }
    }
  }
  
  for (const floor of floorMap.values()) {
    world.setFloor(floor);
  }
  
  return world;
}

function taskVerdictSystem(world) {
  const tasks = world.getAllTasks();
  
  for (const task of tasks) {
    if (task.status !== 'COMPLETE' && task.status !== 'DONE') continue;
    
    const verified = task.verified;
    let completionTruth = 'UNVERIFIED';
    
    if (task.verified && task.verified.engagement) {
      const verdict = task.verified.engagement.verdict;
      const score = task.verified.score ?? 0;
      
      if (verdict === 'OK' && task.verified.score >= 0.9) {
        completionTruth = 'EVIDENCED';
      } else if (verdict === 'OK' && task.verified.score >= 0.5) {
        completionTruth = 'WEAK';
      } else if (verdict === 'OFF_TOPIC') {
        completionTruth = 'OFF_TOPIC';
      } else {
        completionTruth = 'UNVERIFIED';
      }
    }
  }
  
  return world;
}

function buildQueueSummary(world) {
  const tasks = world.getAllTasks();
  const now = nowMs();
  const STALE_MS = 5 * 60 * 1000;
  
  const byStatus = {};
  let queued = 0, inProgress = 0, complete = 0, failed = 0, quarantined = 0;
  let staleInProgress = 0;
  const inProgressTasks = [];
  
  for (const task of tasks) {
    const status = task.status;
    byStatus[status] = (byStatus[status] || 0) + 1;
    
    switch (status) {
      case 'QUEUED': queued++; break;
      case 'IN_PROGRESS': 
        inProgress++;
        inProgressTasks.push({
          task_id: task.id.replace('task:', ''),
          title: task.title,
          assigned_agent: task.assignedAgent?.replace('agent:', ''),
          claimed_by: task.claimedBy?.replace('agent:', ''),
          heartbeat_age_sec: task.claimedAt ? Math.floor((now - task.claimedAt) / 1000) : null
        });
        if (task.claimedAt && now - task.claimedAt > STALE_MS) {
          staleInProgress++;
        }
        break;
      case 'COMPLETE': complete++; break;
      case 'FAILED': failed++; break;
      case 'QUARANTINED': quarantined++; break;
    }
  }
  
  return {
    total: tasks.length,
    queued,
    inProgress,
    complete,
    failed,
    quarantined,
    staleInProgress,
    byStatus,
    inProgressTasks,
    completionsLastHour: 0,
    failedLastHour: 0,
    completionsByHour: [],
    recentCompletions: []
  };
}

function computeCompletionTruth(verified) {
  if (!verified || !verified.engagement) {
    return { truth: 'UNVERIFIED', score: null, reason: 'no verification record' };
  }
  const verdict = verified.engagement?.verdict;
  const score = verified.score ?? 0;
  
  if (verdict === 'OK' && score >= 0.9) {
    return { truth: 'EVIDENCED', score, reason: 'score >= 0.9 and verdict OK' };
  }
  if (verdict === 'OK' && score >= 0.5) {
    return { truth: 'WEAK', score, reason: 'score >= 0.5 and verdict OK' };
  }
  if (verdict === 'OFF_TOPIC') {
    return { truth: 'OFF_TOPIC', score, reason: 'verdict OFF_TOPIC' };
  }
  return { truth: 'UNVERIFIED', score, reason: 'insufficient evidence' };
}

function buildTaskBoard(world, limit = 25) {
  const tasks = world.getAllTasks();
  const BOARD_COLUMNS = [
    { id: 'todo', statuses: ['QUEUED', 'PRESERVED', 'TODO', 'PENDING'] },
    { id: 'in_progress', statuses: ['IN_PROGRESS'] },
    { id: 'review', statuses: ['QUARANTINED', 'REVIEW', 'VERIFY', 'BLOCKED', 'FAILED'] },
    { id: 'done', statuses: ['COMPLETE', 'DONE'] },
  ];
  
  const groups = {};
  const counts = {};
  
  for (const col of BOARD_COLUMNS) {
    const columnTasks = tasks.filter(t => col.statuses.includes(t.status));
    counts[col.id] = columnTasks.length;
    groups[col.id] = columnTasks.slice(0, limit).map(t => {
      const ct = computeCompletionTruth(t.verified);
      return {
        task_id: t.id.replace('task:', ''),
        title: t.title,
        status: t.status,
        project_id: null,
        assigned_agent: t.assignedAgent?.replace('agent:', ''),
        claimed_by: t.claimedBy?.replace('agent:', ''),
        created_at: null,
        started_at: null,
        completed_at: null,
        updated_at: null,
        heartbeat: null,
        priority: t.risk === 'destructive' ? 'high' : 'normal',
        completion_truth: t.status === 'COMPLETE' ? ct.truth : null,
        evidence_score: t.status === 'COMPLETE' ? ct.score : null,
        evidence_reason: t.status === 'COMPLETE' ? ct.reason : null
      });
    });
  }
  
  return {
    groups,
    counts,
    total: tasks.length,
    perColumn: limit
  };
}

function buildFloorTaskCounts(world) {
  const tasks = world.getAllTasks();
  const counts = {};
  
  for (const task of tasks) {
    const floor = task.floorId.replace('floor:', '');
    if (!counts[floor]) {
      counts[floor] = { QUEUED: 0, IN_PROGRESS: 0, COMPLETE: 0, FAILED: 0, QUARANTINED: 0 };
    }
    counts[floor][task.status] = (counts[floor][task.status] || 0) + 1;
  }
  
  return { counts };
}

module.exports = {
  taskRoutingSystem,
  taskVerdictSystem,
  buildQueueSummary,
  buildTaskBoard,
  buildFloorTaskCounts,
  readTasks,
  readProjects,
  timestampMs,
  nowMs
};
