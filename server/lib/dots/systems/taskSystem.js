'use strict';

/**
 * @fileoverview Task Systems - Pure functions for task data processing
 */

const fs = require('fs');
const path = require('path');

/**
 * Read hive tasks.json
 * @param {string} hivePath
 * @returns {Object}
 */
function readTasks(hivePath) {
  const tasksPath = path.join(hivePath, 'tasks.json');
  try {
    const data = fs.readFileSync(tasksPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { tasks: [] };
  }
}

/**
 * Read hive projects.json
 * @param {string} hivePath
 * @returns {Object}
 */
function readProjects(hivePath) {
  const projectsPath = path.join(hivePath, 'projects.json');
  try {
    const data = fs.readFileSync(projectsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { projects: [] };
  }
}

/**
 * Get current timestamp in ms
 */
function nowMs() {
  return Date.now();
}

/**
 * Parse timestamp to ms
 * @param {string|number|null} ts
 * @returns {number|null}
 */
function timestampMs(ts) {
  if (ts == null) return null;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * Task Routing System
 * Reads hive tasks + projects, computes task state, writes to World
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function taskRoutingSystem(world, context) {
  const { hivePath } = context;
  
  // Read hive data
  const tasksData = readTasks(hivePath);
  const projectsData = readProjects(hivePath);
  
  // Process tasks
  for (const task of tasksData.tasks || []) {
    if (!task.task_id) continue;
    
    const entityId = `task:${task.task_id}`;
    
    // Determine floor from assigned_agent or claimed_by
    let floorId = 'floor:f1';
    if (task.assigned_agent) {
      const floorMatch = String(task.assigned_agent).match(/^f(\d+)$/);
      if (floorMatch) floorId = `floor:f${floorMatch[1]}`;
    } else if (task.claimed_by) {
      const floorMatch = String(task.claimed_by).match(/^f(\d+)$/);
      if (floorMatch) floorId = `floor:f${floorMatch[1]}`;
    }
    
    const taskObj = {
      id: entityId,
      title: task.title || task.task_id,
      objective: task.objective || '',
      status: String(task.status || 'QUEUED').toUpperCase(),
      risk: task.risk === 'destructive' ? 'destructive' : 'low',
      assignedAgent: task.assigned_agent ? `agent:${task.assigned_agent}` : null,
      claimedBy: task.claimed_by ? `agent:${task.claimed_by}` : null,
      claimedAt: timestampMs(task.claimed_at),
      floorId: floorId,
      result: task.result || null
    };
    
    world.setTask(taskObj);
  }
  
  // Process projects
  for (const project of projectsData.projects || []) {
    if (!project.project_id) continue;
    
    const entityId = `project:${project.project_id}`;
    // Projects are stored as tasks with special marker for now
    // Could add separate project component later
  }
  
  return world;
}

/**
 * Task Verdict System
 * Computes verified/unverified completion counts
 * 
 * @param {World} world
 * @returns {World}
 */
function taskVerdictSystem(world) {
  // This would compute verdicts from task evidence
  // For now, the data comes from hive verify pipeline
  return world;
}

/**
 * Build queue summary from World tasks (for /api/queue)
 * 
 * @param {World} world
 * @returns {Object}
 */
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
    completionsLastHour: 0, // Would need events.log
    failedLastHour: 0,
    completionsByHour: [],
    recentCompletions: []
  };
}

/**
 * Build task board from World (for /api/task-board)
 * 
 * @param {World} world
 * @param {number} limit
 * @returns {Object}
 */
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
    groups[col.id] = columnTasks.slice(0, limit).map(t => ({
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
      completion_truth: t.status === 'COMPLETE' ? 'verified' : null,
      evidence_score: t.status === 'COMPLETE' ? 1.0 : null,
      evidence_reason: t.status === 'COMPLETE' ? 'completed' : null
    }));
  }
  
  return {
    groups,
    counts,
    total: tasks.length,
    perColumn: limit
  };
}

/**
 * Build floor task counts (for /api/tasks?counts=1)
 * 
 * @param {World} world
 * @returns {Object}
 */
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